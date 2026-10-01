/* 慢行站前端：
 * - 折线/歇脚点在本地编辑，保存时服务端做权威校验（有界、复杂度、自交、照片闸门）
 * - 两种并发策略：整路线 geometryRev 乐观锁；分段提交用 edgeEtags 合并 + clientOpId 幂等
 * - 路段插删后展示 repositioned / detached 冲突，要求作者确认或重落点
 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  me: null,
  users: [],
  route: null,          // 当前编辑路线（viewRoute 结构）
  geo: null,            // {coordinates, vertexIds}
  restPoints: [],
  photos: [],
  geometryRev: 1,
  storyRev: 1,
  noteRev: 1,
  edgeEtags: {},
  baseEdgeEtags: null,  // 本次分段编辑基线
  pendingOps: [],       // 本地未提交分段操作（离线队列）
  clientSeq: 0,
  drag: null,
  mode: 'vertex',
  dirty: false
};

// ---- API ----
async function api(method, path, body, headers = {}) {
  const opt = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  if (state.me) opt.headers['x-user-id'] = state.me.id;
  const res = await fetch(path, opt);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || ('HTTP ' + res.status));
    err.status = res.status; err.code = json.error; err.details = json.details;
    throw err;
  }
  return json;
}
const setStatus = (msg, isErr = false) => {
  const el = $('#statusLine');
  el.textContent = msg || '';
  el.className = 'status-line' + (isErr ? ' error' : '');
};

// ---- 视图切换 ----
$$('.topbar nav button').forEach((b) => b.addEventListener('click', () => {
  $$('.topbar nav button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + b.dataset.view).classList.remove('hidden');
  if (b.dataset.view === 'mine') loadMine();
  if (b.dataset.view === 'review') loadReview();
  if (b.dataset.view === 'featured') loadFeatured();
}));
$$('input[name=mode]').forEach((r) => r.addEventListener('change', () => { state.mode = r.value; }));

// ---- 初始化会话 ----
async function initSession() {
  const s = await api('GET', '/api/session');
  state.users = s.users;
  $('#asUser').innerHTML = s.users.map((u) =>
    `<option value="${u.id}">${u.name}（${u.role === 'reviewer' ? '审核员' : '作者'}）</option>`).join('');
  $('#asUser').addEventListener('change', () => { state.me = s.users.find((u) => u.id === $('#asUser').value); });
  state.me = s.users.find((u) => u.role === 'author');
  $('#asUser').value = state.me.id;
  newRoute();
}

// ---- 本地几何（画布坐标用固定演示范围映射经纬度）----
const BOUNDS = { lng: [121.46, 121.51], lat: [31.224, 31.238] };
const W = 600, H = 420, PAD = 30;
const xy = ([lng, lat]) => [
  PAD + ((lng - BOUNDS.lng[0]) / (BOUNDS.lng[1] - BOUNDS.lng[0])) * (W - 2 * PAD),
  H - PAD - ((lat - BOUNDS.lat[0]) / (BOUNDS.lat[1] - BOUNDS.lat[0])) * (H - 2 * PAD)
];
const ll = ([x, y]) => [
  Number((BOUNDS.lng[0] + ((x - PAD) / (W - 2 * PAD)) * (BOUNDS.lng[1] - BOUNDS.lng[0])).toFixed(6)),
  Number((BOUNDS.lat[0] + ((H - PAD - y) / (H - 2 * PAD)) * (BOUNDS.lat[1] - BOUNDS.lat[0])).toFixed(6))
];

function newRoute() {
  // 初始示例折线
  state.route = null;
  state.geo = {
    type: 'LineString',
    coordinates: [[121.47, 31.23], [121.48, 31.232], [121.49, 31.23], [121.5, 31.232]],
    vertexIds: ['v' + rand(), 'v' + rand(), 'v' + rand(), 'v' + rand()]
  };
  state.restPoints = [];
  state.photos = [];
  state.pendingOps = [];
  state.baseEdgeEtags = null;
  state.geometryRev = 1; state.storyRev = 1; state.noteRev = 1;
  state.dirty = false;
  $('#title').value = '';
  $('#story').value = '';
  setStatus('新草稿：在画布上编辑后，先存草稿再提交审核');
  render();
}
const rand = () => Math.random().toString(36).slice(2, 8);
const svgNS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => Object.assign(document.createElementNS(svgNS, name), attrs);

function render(relocated = { repositioned: [], detached: [] }) {
  const svg = $('#map');
  svg.innerHTML = '';
  const pts = state.geo.coordinates.map(xy);
  const d = 'M' + pts.map((p) => p.join(',')).join(' L');
  // 透明的宽边命中区（点边插点）
  const hit = el('path', { d, classList: 'hit-area' });
  hit.addEventListener('click', (e) => {
    if (state.mode !== 'insert') return;
    insertVertexAt(e);
  });
  svg.appendChild(hit);
  svg.appendChild(el('path', { d, classList: 'polyline' + (state.pendingOps.length ? ' pending' : '') }));

  state.geo.coordinates.forEach((c, i) => {
    const [x, y] = xy(c);
    const g = el('g', {});
    const circle = el('circle', { cx: x, cy: y, r: 7, classList: 'vertex' });
    g.appendChild(circle);
    if (state.mode === 'remove' && i > 0 && i < state.geo.coordinates.length - 1) {
      circle.style.cursor = 'crosshair';
      g.addEventListener('click', () => removeVertex(i));
    } else {
      g.addEventListener('pointerdown', (e) => startDrag(e, i, circle));
    }
    svg.appendChild(g);
  });

  state.restPoints.forEach((p) => {
    const [x, y] = xy(p.coord);
    const c = el('circle', { cx: x, cy: y, r: 6, classList: 'restpoint ' + (p._state || 'attached') });
    c.appendChild(el('title', { textContent: p.name + (p._state ? '（' + p._state + '）' : '') }));
    c.addEventListener('click', () => pointClicked(p));
    svg.appendChild(c);
  });

  if (state.mode === 'rest') {
    svg.addEventListener('click', dropRestOnce, { once: true });
  }
  renderPoints(relocated);
  renderPhotos();
  $('#geoRev').textContent = state.route ? `geometryRev=${state.geometryRev}` : '(未保存)';
}

// ---- 顶点拖拽（生成本地 move 操作，分段提交时用）----
function startDrag(e, i, circle) {
  if (state.mode === 'insert' || state.mode === 'remove') return;
  e.preventDefault();
  state.drag = { i, id: state.geo.vertexIds[i], start: vertexCoord(i), moved: false };
  circle.classList.add('selected');
  window.addEventListener('pointermove', onDrag);
  window.addEventListener('pointerup', endDrag, { once: true });
}
const vertexCoord = (i) => state.geo.coordinates[i].slice();
function onDrag(e) {
  if (!state.drag) return;
  const rect = $('#map').getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * W;
  const y = ((e.clientY - rect.top) / rect.height) * H;
  state.geo.coordinates[state.drag.i] = ll([Math.max(PAD, Math.min(W - PAD, x)), Math.max(PAD, Math.min(H - PAD, y))]);
  state.drag.moved = true;
  state.dirty = true;
  render();
}
function endDrag() {
  if (state.drag && state.drag.moved) {
    queueOp({ type: 'move', vertexId: state.drag.id, coord: state.geo.coordinates[state.drag.i] });
  }
  state.drag = null;
  window.removeEventListener('pointermove', onDrag);
  render();
}

// ---- 点边插点 ----
function insertVertexAt(e) {
  const rect = $('#map').getBoundingClientRect();
  const [px, py] = [((e.clientX - rect.left) / rect.width) * W, ((e.clientY - rect.top) / rect.height) * H];
  // 找最近的边
  let best = null;
  state.geo.coordinates.slice(0, -1).forEach((a, i) => {
    const [ax, ay] = xy(a), [bx, by] = xy(state.geo.coordinates[i + 1]);
    const dist = pointSegDist(px, py, ax, ay, bx, by);
    if (!best || dist < best.dist) best = { i, dist };
  });
  const newId = 'v' + rand();
  const coord = ll([px, py]);
  state.geo.coordinates.splice(best.i + 1, 0, coord);
  state.geo.vertexIds.splice(best.i + 1, 0, newId);
  queueOp({ type: 'insert', after: state.geo.vertexIds[best.i], vertexId: newId, coord });
  state.dirty = true;
  setStatus('已在路段上插入顶点，保存时将检查歇脚点依附。');
  render();
}
function removeVertex(i) {
  const id = state.geo.vertexIds[i];
  state.geo.coordinates.splice(i, 1);
  state.geo.vertexIds.splice(i, 1);
  queueOp({ type: 'remove', vertexId: id });
  state.dirty = true;
  render();
}
function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---- 歇脚点 ----
function dropRestOnce(e) {
  if (e.target.classList.contains('vertex') || e.target.classList.contains('restpoint')) return;
  const rect = $('#map').getBoundingClientRect();
  const coord = ll([((e.clientX - rect.left) / rect.width) * W, ((e.clientY - rect.top) / rect.height) * H]);
  const name = prompt('歇脚点名称', '歇脚点 ' + (state.restPoints.length + 1));
  if (!name) return render();
  const p = { id: 'p' + rand(), name, note: '', coord, _state: 'attached' };
  state.restPoints.push(p);
  state.dirty = true;
  render();
}
function pointClicked(p) {
  const note = prompt(`编辑「${p.name}」备注：`, p.note);
  if (note !== null) { p.note = note; render(); }
}
function renderPoints(relocated) {
  const rep = new Map((relocated.repositioned || []).map((r) => [r.pointId, r.coord]));
  const det = new Set(relocated.detached || []);
  state.restPoints.forEach((p) => {
    if (det.has(p.id)) p._state = 'detached';
    else if (rep.has(p.id)) { p.coord = rep.get(p.id); p._state = 'repositioned'; }
  });
  $('#pointList').innerHTML = state.restPoints.map((p) => `
    <li>
      <b>${escapeHtml(p.name)}</b>
      <span class="tag ${p._state || 'attached'}">${({ attached: '已锚定', repositioned: '已自动重定位，请确认', detached: '失去依附，需重落' })[p._state || 'attached']}</span>
      <div><small>${p.coord[0].toFixed(4)}, ${p.coord[1].toFixed(4)} · ${escapeHtml(p.note || '无备注')}</small></div>
    </li>`).join('') || '<li><small>在左侧选择“落歇脚点”后点击地图。</small></li>';
}

// ---- 操作队列 / 离线重送 ----
function queueOp(op) {
  if (!state.baseEdgeEtags) state.baseEdgeEtags = JSON.parse(JSON.stringify(state.edgeEtags || {}));
  state.pendingOps.push(op);
}

// ---- 照片（两段上传）----
$('#addPhotoBtn').addEventListener('click', async () => {
  const filename = 'photo-' + Date.now() + '.jpg';
  const photo = await api('POST', '/api/photos', { filename, bytes: 200000 + Math.floor(Math.random() * 500000) });
  state.photos.push(photo);
  renderPhotos();
  setStatus('照片已登记（uploading），模拟 1.2s 上传完成……');
  setTimeout(async () => {
    const done = await api('POST', `/api/photos/${photo.id}/complete`, {});
    const p = state.photos.find((x) => x.id === done.id);
    Object.assign(p, done);
    renderPhotos();
    setStatus('照片上传完成（ready）。');
  }, 1200);
});
function renderPhotos() {
  $('#photoList').innerHTML = state.photos.map((p) => `
    <li>${escapeHtml(p.filename)} <span class="badge ${p.status}">${p.status === 'ready' ? 'ready' : 'uploading…'}</span></li>
  `).join('');
}

// ---- 整包存草稿（整路线乐观锁）----
async function wholeBody() {
  return {
    title: $('#title').value.trim(),
    story: $('#story').value,
    geometry: state.geo,
    restPoints: state.restPoints.map(({ id, name, note, coord }) => ({ id, name, note, coord, photoIds: [] })),
    photoIds: state.photos.filter((p) => p.status === 'ready').map((p) => p.id)
  };
}
$('#saveWholeBtn').addEventListener('click', async () => {
  try {
    const body = await wholeBody();
    let out;
    if (!state.route) {
      out = await api('POST', '/api/routes', body, { 'Idempotency-Key': 'web-' + Date.now() });
      state.route = { id: out.route.id };
    } else {
      out = await api('PUT', `/api/routes/${state.route.id}`, body,
        { 'x-expected-geometry-rev': String(state.geometryRev) });
    }
    loadVersionIntoEditor(out.version);
    state.pendingOps = []; state.baseEdgeEtags = null; state.dirty = false;
    setStatus('草稿已保存（整路线乐观锁通过）。');
  } catch (e) {
    handleSaveError(e);
  }
});

// 服务端校验（演示：不保存，仅让服务端报错，证明不靠客户端）
$('#validateBtn').addEventListener('click', async () => {
  try {
    await api('POST', '/api/routes', await wholeBody(), { 'Idempotency-Key': 'probe-' + Date.now() });
    setStatus('服务端校验通过（这是一次探测请求，未作为你的草稿）。');
  } catch (e) {
    setStatus(`服务端校验失败：${e.code} — ${e.message}`, true);
  }
});

// ---- 分段提交（边指纹合并；clientOpId 幂等，天然支持离线重送）----
$('#saveSegmentBtn').addEventListener('click', () => saveSegmentBatch({}));

async function saveSegmentBatch(resolutions, isRetry = false) {
  if (!state.route) return setStatus('请先“整包存草稿”建立路线，再做分段提交。', true);
  if (!state.pendingOps.length) return setStatus('没有待提交的分段操作（可先拖动/插删顶点）。', true);
  const clientOpId = state._clientOpId || ('op-' + Date.now() + '-' + (++state.clientSeq));
  state._clientOpId = clientOpId;
  try {
    const out = await api('PATCH', `/api/routes/${state.route.id}/segment-batch`, {
      clientOpId,
      baseGeometryRev: state.geometryRevAtBase ?? state.geometryRev,
      baseTags: state.baseEdgeEtags || state.edgeEtags,
      ops: state.pendingOps,
      resolutions: resolutions || undefined,
      noteUpdates: collectNoteUpdates(),
      story: $('#story').value !== state._savedStory ? $('#story').value : undefined,
      expectedStoryRev: state.storyRev
    });
    // 成功：应用响应里的重定位信息
    state.geometryRevAtBase = undefined;
    state._clientOpId = null;
    state.pendingOps = []; state.baseEdgeEtags = null;
    loadVersionIntoEditor(out.version);
    const warns = [];
    if (out.repositioned?.length) warns.push(`${out.repositioned.length} 个歇脚点随路段改动自动重定位，请在列表中确认`);
    if (out.dropped?.length) warns.push(`${out.dropped.length} 个歇脚点已按你的选择删除`);
    state.dirty = false;
    setStatus('分段已合并。' + (warns.length ? '注意：' + warns.join('；') : ''));
  } catch (e) {
    if (e.code === 'point_needs_relocate') {
      await resolveRelocation(e.details, () => saveSegmentBatch(undefined, true));
    } else {
      handleSaveError(e);
    }
  }
}

let _noteSnapshot = new Map();
function collectNoteUpdates() {
  const upd = [];
  for (const p of state.restPoints) if (_noteSnapshot.has(p.id) && _noteSnapshot.get(p.id) !== p.note) upd.push({ pointId: p.id, note: p.note });
  return upd;
}

// 点位冲突：要求作者为每个 detached 点选择新坐标或删除
async function resolveRelocation(details, retry) {
  const box = $('#conflictBox');
  const resolutions = {};
  box.classList.remove('hidden');
  box.innerHTML = `
    <b>路段插删导致歇脚点依赖变化：</b>
    <div>自动重定位：${(details.repositioned || []).map((r) => r.pointId).join('、') || '无'}</div>
    <div>失去依附：${(details.detached || []).join('、')}</div>
    <p>请选择处理方式（这是几何修改与点位备注的依赖冲突，必须作者决定）：</p>
    <div id="resolutionUi"></div>
    <button id="resolveConfirm" class="primary">带处理方式重发同一操作</button>`;
  const ui = $('#resolutionUi');
  (details.detached || []).forEach((pid) => {
    const p = state.restPoints.find((x) => x.id === pid);
    const row = document.createElement('div');
    row.innerHTML = `
      <label>${escapeHtml(p?.name || pid)}：
        <select id="rs-${pid}"><option value="relocate">在地图上新落点</option><option value="drop">删除该歇脚点</option></select>
      </label>`;
    ui.appendChild(row);
  });
  $('#resolveConfirm').onclick = async () => {
    for (const pid of details.detached || []) {
      if ($('#rs-' + pid).value === 'drop') resolutions[pid] = { drop: true };
      else {
        const p = state.restPoints.find((x) => x.id === pid);
        const input = prompt(`请输入「${p.name}」新坐标（lng,lat），可参考重定位提示`, p ? p.coord.join(',') : '');
        if (!input) return;
        const [lng, lat] = input.split(',').map(Number);
        resolutions[pid] = { coord: [lng, lat] };
      }
    }
    box.classList.add('hidden');
    await saveSegmentBatch(resolutions, true);
  };
}

function handleSaveError(e) {
  if (e.code === 'same_segment_conflict') {
    setStatus(`同路段冲突：${(e.details.conflicts || []).map((c) => c.edge + '(' + c.reason + ')').join('、')}。请 rebase 后重试。`, true);
    return offerRebase(e.details);
  }
  if (e.code === 'geometry_rev_stale') {
    setStatus(`整路线版本过期（期望 ${e.details.expected}，当前 ${e.details.current}），请 rebase。`, true);
    return offerRebase(e.details);
  }
  if (e.code === 'stale_vertex') {
    setStatus(`顶点 ${e.details.vertexId} 已被他人删除，请 rebase。`, true);
    return offerRebase(e.details);
  }
  if (e.code === 'self_intersection') {
    return setStatus(`服务端拒绝：折线在 ${e.details.at.join(',')} 自相交（边 ${e.details.edges.join(' 与 ')}），请改线。`, true);
  }
  if (e.code === 'photos_not_ready') {
    return setStatus(`照片还没传完：${e.details.missing.join('、')}，不能保存/提交。`, true);
  }
  setStatus(`${e.code || 'error'}：${e.message}`, true);
}

function offerRebase(details) {
  const box = $('#conflictBox');
  box.classList.remove('hidden');
  box.innerHTML = `<b>检测到并发编辑冲突。</b>
    <p>你的本地修改尚未覆盖他人版本。点击 rebase 拉取最新几何，
       系统会尽量保留你在不冲突路段的本地操作；冲突路段需要你手动重做。</p>
    <button class="primary" id="rebaseBtn">拉取最新版并 rebase</button>`;
  $('#rebaseBtn').onclick = async () => {
    if (!state.route) return;
    const fresh = await api('GET', `/api/routes/${state.route.id}`);
    loadVersionIntoEditor(fresh.draft);
    state.pendingOps = []; state.baseEdgeEtags = null; state._clientOpId = null;
    box.classList.add('hidden');
    setStatus('已 rebase 到最新版本，请在新几何上重做冲突路段的修改。');
  };
}

// ---- 备注乐观锁单独保存 ----
$('#saveNotesBtn').addEventListener('click', async () => {
  if (!state.route) return setStatus('先存草稿。', true);
  try {
    for (const p of state.restPoints) {
      await api('PUT', `/api/versions/${state.currentVersionId}/points/${p.id}/note`,
        { note: p.note }, { 'x-expected-note-rev': String(state.noteRev) });
      state.noteRev++;
    }
    setStatus('点位备注已保存。');
  } catch (e) {
    setStatus(`备注保存失败：${e.code} — ${e.message}（请刷新后重试）`, true);
  }
});

// ---- 提交审核 ----
$('#submitBtn').addEventListener('click', async () => {
  if (!state.route) return setStatus('请先整包存草稿。', true);
  if (state.photos.some((p) => p.status !== 'ready'))
    return setStatus('还有照片未上传完成，服务端会拒绝提交。', true);
  try {
    const v = await api('POST', `/api/routes/${state.route.id}/submit`, {});
    loadVersionIntoEditor(v);
    setStatus('已提交审核。审核期间若修改危险路口，旧审核申请会自动关闭、需重新审核。');
  } catch (e) { setStatus(`${e.code}：${e.message}`, true); }
});

function loadVersionIntoEditor(v) {
  state.currentVersionId = v.id;
  state.geo = v.geometry;
  state.restPoints = (v.restPoints || []).map((p) => ({ ...p, _state: 'attached' }));
  state.photos = []; // 照片清单按需另查；这里只保留 id
  state.geometryRev = v.geometryRev; state.storyRev = v.storyRev; state.noteRev = v.noteRev;
  state.edgeEtags = v.edgeEtags || {};
  if (v.title && !$('#title').value) $('#title').value = v.title;
  if (v.story) $('#story').value = v.story;
  state._savedStory = v.story;
  _noteSnapshot = new Map(state.restPoints.map((p) => [p.id, p.note]));
  render();
}

// ---- 我的路线 ----
async function loadMine() {
  const data = await api('GET', '/api/routes');
  $('#mineList').innerHTML = (data.mine || []).map((r) => {
    const d = r.draft;
    return `<div class="route-row">
      <h4>${escapeHtml(d.title || '未命名路线')}</h4>
      <div class="meta">
        <span class="pill ${d.status}">${d.status}</span>
        几何rev ${d.geometryRev} · 指纹 <small>${d.fingerprint.slice(0, 18)}…</small>
      </div>
      <div class="ver-list">
        ${(r.versions || []).map((x) => `<div>
          <span class="pill ${x.status}">${x.status}</span> ${x.id}
          ${x.withdrawReason ? '— ' + escapeHtml(x.withdrawReason) : ''}
          ${x.rejectReason ? '— 驳回：' + escapeHtml(x.rejectReason) : ''}
          <button class="ghost small" onclick="openVersion('${x.id}')">查看链接</button>
        </div>`).join('')}
      </div>
      <div style="margin-top:8px">
        <button class="ghost small" onclick="editRoute('${r.id}')">载入草稿编辑</button>
      </div>
    </div>`;
  }).join('') || '<p><small>还没有路线。</small></p>';
}
window.editRoute = async (routeId) => {
  const r = await api('GET', '/api/routes/' + routeId);
  state.route = { id: routeId };
  $('#title').value = '';
  loadVersionIntoEditor(r.draft);
  $$('.topbar nav button')[0].click();
  setStatus(`已载入路线 ${routeId} 的草稿分支。`);
};
window.openVersion = async (id) => {
  try {
    const v = await api('GET', '/api/versions/' + id);
    showModal('版本 ' + id, JSON.stringify({ status: v.status, title: v.title, fingerprint: v.fingerprint }, null, 2));
  } catch (e) {
    // 410：旧链接保留状态说明；details 不含几何/故事，不泄漏草稿
    showModal('链接状态 ' + e.status, JSON.stringify({ error: e.code, message: e.message, details: e.details }, null, 2));
  }
};

// ---- 审核台 ----
async function loadReview() {
  let data;
  try { data = await api('GET', '/api/routes'); }
  catch { $('#reviewList').innerHTML = '<p>请切换到审核员账号。</p>'; return; }
  const list = data.inReview || [];
  $('#reviewList').innerHTML = list.map((v) => `
    <div class="route-row">
      <h4>${escapeHtml(v.title)}</h4>
      <div class="meta">${v.id} · 指纹 <small>${v.fingerprint}</small></div>
      <p>${escapeHtml(v.story)}</p>
      <div class="actions">
        <button class="primary" onclick="decide('${v.id}','approve',\`${v.fingerprint}\`)">通过</button>
        <button class="danger" onclick="decide('${v.id}','reject',\`${v.fingerprint}\`)">驳回</button>
        <button class="ghost" onclick="publishRoute('${v.routeId}')" title="通过后作者发布">查看/发布</button>
      </div>
    </div>`).join('') || '<p><small>当前没有待审核版本。</p>';
}
window.decide = async (id, action, fingerprint) => {
  const reason = prompt(action === 'approve' ? '通过理由（将作为审核依据留存）' : '驳回理由',
    action === 'approve' ? '几何清晰、文字完整、路口安全' : '危险路口走线不清晰');
  if (!reason) return;
  try {
    await api('POST', `/api/versions/${id}/review`, { action, reason, expectedFingerprint: fingerprint });
    alert('已记录裁决与版本快照。');
    loadReview();
  } catch (e) {
    alert(`裁决失败：${e.code} — ${e.message}\n该版本可能已被作者撤回或改动，旧同意不会沿用。`);
  }
};
window.publishRoute = async (routeId) => {
  const r = await api('GET', '/api/routes/' + routeId);
  if (r.draft.status === 'approved') {
    await api('POST', `/api/routes/${routeId}/publish`, {});
    alert('已发布，后台正在更新搜索索引（失败会自动重试）。');
  } else if (r.draft.status === 'published') {
    if (confirm('该版本已发布。要撤回吗？撤回后精选卡失活、搜索移除，但旧链接保留状态说明。')) {
      const reason = prompt('撤回理由');
      if (reason) await api('POST', `/api/routes/${routeId}/withdraw`, { reason });
      alert('已撤回。');
    }
  } else {
    alert('当前状态：' + r.draft.status);
  }
};

// ---- 精选与搜索 ----
async function loadFeatured() {
  const { cards } = await api('GET', '/api/featured');
  $('#featuredList').innerHTML = cards.map((c) => `
    <div class="feat-card">
      <h4>${escapeHtml(c.snapshot.title)}</h4>
      <p><small>${escapeHtml((c.snapshot.story || '').slice(0, 90))}…</small></p>
      <div class="basis">
        精选理由：${escapeHtml(c.reason)}<br />
        审核依据：${escapeHtml(c.reviewBasis.reason)}<br />
        指纹：<small>${c.reviewBasis.fingerprint.slice(0, 22)}…</small><br />
        发布于 ${new Date(c.snapshot.publishedAt).toLocaleString()}
      </div>
    </div>`).join('') || '<p><small>还没有精选卡片。</small></p>';
  doSearch();
}
let searchTimer;
$('#searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 250); });
async function doSearch() {
  const q = $('#searchInput').value;
  const { results } = await api('GET', '/api/search?q=' + encodeURIComponent(q || ''));
  $('#searchResults').innerHTML = results.map((r) =>
    `<div class="route-row"><b>${escapeHtml(r.title)}</b><div class="meta">${escapeHtml(r.snippet || '')}</div></div>`
  ).join('') || '<p><small>无匹配（索引更新是后台可重试任务）。</small></p>';
}

// ---- 通用 ----
function showModal(title, text) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = text;
  $('#modal').classList.remove('hidden');
}
$('#modalCancel').onclick = () => $('#modal').classList.add('hidden');
$('#modalOk').onclick = () => $('#modal').classList.add('hidden');
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

initSession().catch((e) => setStatus('初始化失败：' + e.message, true));
