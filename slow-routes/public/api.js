'use strict';
/* API client：身份切换、离线排队、Idempotency-Key 重送去重 */
const Store = {
  get token() { return localStorage.getItem('sr_token') || 'token-author'; },
  set token(v) { localStorage.setItem('sr_token', v); },
  get queue() { try { return JSON.parse(localStorage.getItem('sr_queue') || '[]'); } catch { return []; } },
  set queue(v) { localStorage.setItem('sr_queue', JSON.stringify(v)); },
  get routeCache() { try { return JSON.parse(localStorage.getItem('sr_route_' + State.routeId) || 'null'); } catch { return null; } },
  set routeCache(v) { if (State.routeId) localStorage.setItem('sr_route_' + State.routeId, JSON.stringify(v)); }
};

const State = {
  token: Store.token,
  routeId: null,
  route: null,           // 最新路线（含 segments/stops/route_version）
  tool: 'add',
  vertices: [],
  undoStack: [],
  currentReviewId: null,
  currentPubId: null
};

function uuid() {
  return 'k-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

async function api(method, url, body, { idemKey, raw, contentType } = {}) {
  const opts = { method, headers: { Authorization: 'Bearer ' + State.token } };
  if (body !== undefined) {
    if (raw) { opts.headers['X-Photo-Content-Type'] = contentType || 'image/png'; opts.body = body; }
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  if (idemKey) opts.headers['Idempotency-Key'] = idemKey;
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const e = new Error(data.error || ('HTTP ' + res.status));
    e.status = res.status; e.details = data.details; e.replayed = res.headers.get('Idempotent-Replay');
    throw e;
  }
  return data;
}

/* 会改变状态的请求：离线时排队；每个排队请求携带一次性幂等键，重连后串行重放 */
function queueRequest(method, url, body, label) {
  const q = Store.queue;
  q.push({ method, url, body, label, key: uuid(), at: new Date().toISOString(), tries: 0 });
  Store.queue = q;
  renderQueue();
  return drainQueue();
}

async function drainQueue() {
  if (!navigator.onLine) return;
  let q = Store.queue;
  while (q.length) {
    const item = q[0];
    try {
      await api(item.method, item.url, item.body, { idemKey: item.key });
      q.shift(); Store.queue = q; renderQueue();
      toast('已重送：' + item.label, 'ok');
    } catch (e) {
      item.tries += 1; Store.queue = q;
      if (e.status >= 400 && e.status < 500 && e.status !== 409) {
        // 4xx 非冲突：重放也不会成功，从队列移除并提示
        q.shift(); Store.queue = q; renderQueue();
        toast('重送失败（' + item.label + '）：' + e.message, 'err');
      } else {
        renderQueue();
        throw e; // 5xx/409/网络：等下次在线
      }
    }
  }
  if (State.routeId && document.getElementById('tab-editor').classList.contains('active')) {
    await loadRouteIntoEditor(State.routeId);
  }
}

window.addEventListener('online', () => { setNet(true); drainQueue().catch(() => {}); });
window.addEventListener('offline', () => setNet(false));
function setNet(online) {
  const el = document.getElementById('netState');
  el.textContent = online ? '● 在线' : '○ 离线（请求排队）';
  el.className = 'net ' + (online ? 'online' : 'offline');
}

function renderQueue() {
  const box = document.getElementById('queueBox');
  if (!box) return;
  const q = Store.queue;
  box.innerHTML = q.length
    ? q.map((i) => `<div class="qitem">⏳ ${i.label} <small>${i.method} ${i.url}${i.tries ? ' · 重试 ' + i.tries : ''}</small></div>`).join('')
    : '<div class="hint">（空）</div>';
}

function toast(msg, kind = '') {
  const el = document.getElementById('editorMsg') || document.createElement('div');
  el.className = 'msg ' + kind;
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 3200);
}

/* ===== 轻量 canvas 地图：lng/lat <-> 像素，画折线/点/歇脚点 ===== */
const MapView = {
  bounds(coords) {
    if (!coords.length) return { minLng: 121.4, maxLng: 121.52, minLat: 31.18, maxLat: 31.28 };
    let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
    for (const [lng, lat] of coords) {
      minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
    const padLng = Math.max((maxLng - minLng) * 0.12, 0.004);
    const padLat = Math.max((maxLat - minLat) * 0.12, 0.003);
    return { minLng: minLng - padLng, maxLng: maxLng + padLng, minLat: minLat - padLat, maxLat: maxLat + padLat };
  },
  make(canvas, coords) {
    const b = this.bounds(coords);
    const W = canvas.clientWidth || canvas.width, H = canvas.clientHeight || canvas.height;
    canvas.width = W; canvas.height = H;
    const PAD = 18;
    const sx = (W - 2 * PAD) / (b.maxLng - b.minLng);
    const sy = (H - 2 * PAD) / (b.maxLat - b.minLat);
    const s = Math.min(sx, sy);
    const ox = PAD + ((W - 2 * PAD) - (b.maxLng - b.minLng) * s) / 2;
    const oy = PAD + ((H - 2 * PAD) - (b.maxLat - b.minLat) * s) / 2;
    return {
      b, W, H, s, ox, oy,
      xy([lng, lat]) { return [ox + (lng - b.minLng) * s, H - oy - (lat - b.minLat) * s]; },
      ll(px, py) {
        const lng = b.minLng + (px - ox) / s;
        const lat = b.minLat + (H - py - oy) / s;
        return [Number(lng.toFixed(7)), Number(lat.toFixed(7))];
      }
    };
  },
  draw(canvas, coords, stops, opts = {}) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const proj = this.make(canvas, coords);
    canvas._proj = proj;
    if (coords.length < 2) {
      ctx.fillStyle = '#8aa'; ctx.font = '14px sans-serif';
      ctx.fillText('点击地图开始画路线（至少两个点）', 20, 40);
      return;
    }
    // line
    ctx.strokeStyle = opts.color || '#2e7d5b'; ctx.lineWidth = 4; ctx.lineJoin = 'round';
    ctx.beginPath();
    coords.forEach((c, i) => { const [x, y] = proj.xy(c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    // vertices
    coords.forEach((c, i) => {
      const [x, y] = proj.xy(c);
      ctx.beginPath(); ctx.arc(x, y, i === opts.activeVertex ? 7 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === opts.activeVertex ? '#b3621a' : '#1f5c43'; ctx.fill();
      if (coords.length <= 30) { ctx.fillStyle = '#555'; ctx.font = '10px sans-serif'; ctx.fillText(String(i), x + 7, y - 6); }
    });
    // stops
    (stops || []).forEach((s) => {
      const cc = s.coordinates;
      if (!cc) return;
      const [x, y] = proj.xy(cc);
      ctx.fillStyle = s.status === 'needs_relocation' ? '#b3621a' : '#c23a5e';
      ctx.beginPath();
      ctx.moveTo(x, y - 9); ctx.arc(x, y - 3, 6, Math.PI, 0); ctx.lineTo(x, y + 8); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#333'; ctx.font = '11px sans-serif'; ctx.fillText(s.name, x + 8, y + 4);
    });
  }
};
