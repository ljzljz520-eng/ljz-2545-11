'use strict';
/* ===== 工具：DOM/标签 ===== */
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const STATUS_CN = { draft: '草稿', in_review: '审核中', changes_requested: '需修改', published: '已发布', withdrawn: '已撤回' };
function pill(st) { return `<span class="pill ${st}">${STATUS_CN[st] || st}</span>`; }

/* ===== Tab 切换 ===== */
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.tabpane').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $('tab-' + b.dataset.tab).classList.add('active');
  if (b.dataset.tab === 'author') loadMyRoutes();
  if (b.dataset.tab === 'review') loadReviewQueue();
  if (b.dataset.tab === 'admin') loadAdmin();
  if (b.dataset.tab === 'public') loadPublicFeatured();
}));

$('roleSelect').value = State.token;
$('roleSelect').addEventListener('change', (e) => { State.token = e.target.value; Store.token = State.token; location.reload(); });
setNet(navigator.onLine);

/* ================= 作者：路线列表 ================= */
async function loadMyRoutes() {
  try {
    const rows = await api('GET', '/api/my/routes');
    $('routeTable').querySelector('tbody').innerHTML = rows.map((r) => `
      <tr><td>${esc(r.title) || '（未命名）'}</td><td>${pill(r.status)}</td>
      <td>v${r.draft_version} / #${r.route_version}</td>
      <td><small>${new Date(r.updated_at).toLocaleString('zh-CN')}</small></td>
      <td><button onclick="openEditor('${r.id}')">编辑</button>
          <button onclick="openPublicByRoute('${r.id}')">公开页</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="hint">还没有路线</td></tr>';
  } catch (e) { /* ignore for non-authors */ }
}
window.openEditor = async (id) => {
  document.querySelector('.tab[data-tab="editor"]').click();
  await loadRouteIntoEditor(id);
};
window.openPublicByRoute = async (rid) => {
  // 需要找到当前发布快照 id（作者端用 GET route）
  try {
    const r = await api('GET', '/api/routes/' + rid);
    if (!r.published_revision_id) return toast('该路线还没有发布版本');
    openPublication(r.published_revision_id);
    document.querySelector('.tab[data-tab="public"]').click();
  } catch (e) { toast(e.message, 'err'); }
};

$('newRouteBtn').onclick = async () => {
  try {
    const r = await api('POST', '/api/routes', { title: '未命名慢行线', story: '' });
    await openEditor(r.id);
  } catch (e) { toast(e.message, 'err'); }
};

/* ================= 编辑器 ================= */
let dragging = null;
function refreshCanvas(extra = {}) {
  const stops = State.route ? State.route.stops : [];
  MapView.draw($('map'), State.vertices, stops, extra);
  const segBar = $('segBar');
  if (State.route) {
    const vmap = State.route.segments.map((s) => `${s.uid.slice(-4)}#${s.version}`).join(' · ');
    segBar.textContent = '路段（uid 末4位#版本）：' + (vmap || '（暂无几何）');
  }
}

async function loadRouteIntoEditor(id) {
  State.routeId = id;
  const r = await api('GET', '/api/routes/' + id);
  applyRoute(r);
}
function applyRoute(r) {
  State.route = r;
  State.vertices = (r.working_geom && r.working_geom.coordinates || []).map((c) => c.slice());
  $('routeId').value = r.id;
  $('editorTitle').textContent = r.title || '未命名路线';
  $('fTitle').value = r.title || '';
  $('fStory').value = r.story || '';
  $('routeVersion').textContent = r.route_version;
  renderStops();
  renderPhotos();
  renderReviewHistory();
  refreshCanvas();
  const conflict = r.conflict;
  const need = (r.stops || []).filter((s) => s.status === 'needs_relocation');
  const box = $('relocateBox');
  if (need.length || conflict) {
    box.classList.remove('hidden');
    box.innerHTML = '⚠️ 路段插删后有 <b>' + need.length + '</b> 个歇脚点需要重新定位：'
      + need.map((s) => esc(s.name)).join('、') + '。提交审核前必须逐个确认新位置。';
  } else box.classList.add('hidden');
  $('lockConflict').classList.add('hidden');
  $('submitBtn').disabled = r.status === 'in_review';
  $('withdrawBtn').disabled = !['in_review', 'published'].includes(r.status);
  Store.routeCache = r;
}

function renderStops() {
  const ul = $('stopList');
  const stops = State.route.stops || [];
  $('stopHint').textContent = stops.length ? `（${stops.length} 个）` : '';
  ul.innerHTML = stops.map((s) => `
    <li class="${s.status === 'needs_relocation' ? 'need' : ''}">
      <b>${esc(s.name)}</b>${s.status === 'needs_relocation' ? '<span class="badge-need">需重新定位</span>' : ''}
      <div><small>${esc(s.note)}</small></div>
      <div class="mini">
        <input value="${esc(s.note)}" placeholder="点位备注（依赖几何）" id="note-${s.id}" style="flex:1">
        <button onclick="saveNote('${s.id}')">存备注</button>
        ${s.status === 'needs_relocation' ? `<button class="primary" onclick="pickRelocate('${s.id}')">在图上重新定位</button>` : ''}
        <button class="danger" onclick="delStop('${s.id}')">删</button>
      </div>
    </li>`).join('') || '<li class="hint">选择"歇脚点"工具，在路线附近点击添加</li>';
}

async function renderPhotos() {
  const ul = $('photoList');
  const photos = State.route.photos || [];
  ul.innerHTML = photos.map((p) => `<li>🖼 ${esc(p.filename)} <small>${p.bytes}B · ${p.status}</small></li>`).join('')
    || '<li class="hint">还没有照片。先上传完成，再提交审核。</li>';
}

async function renderReviewHistory() {
  try {
    const rows = await api('GET', `/api/routes/${State.routeId}/reviews`);
    $('reviewHistory').innerHTML = rows.map((r) => {
      const stale = r.superseded_at ? '<span class="superseded">（已失效：' + esc(r.superseded_reason || '作者改动') + '）</span>' : '';
      return `<li><b class="decision-${r.decision}">${({ pending: '待审', approved: '通过', rejected: '驳回', changes_requested: '要求修改' })[r.decision]}</b>
        v${r.version} ${stale}<small>${esc(r.comment || '')}${r.decided_at ? ' · ' + new Date(r.decided_at).toLocaleString('zh-CN') : ''}</small></li>`;
    }).join('') || '<li class="hint">暂无审核记录</li>';
  } catch { $('reviewHistory').innerHTML = ''; }
}

/* ===== 工具切换 ===== */
document.querySelectorAll('.map-toolbar .tool').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.map-toolbar .tool').forEach((x) => x.classList.remove('active'));
  b.classList.add('active'); State.tool = b.id.replace('tool', '').toLowerCase().replace('stop', 'stop');
}));

/* ===== 画布交互 ===== */
function eventLL(ev, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
  const y = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
  return canvas._proj.ll(x, y);
}
$('map').addEventListener('click', async (ev) => {
  if (!State.route) return;
  const canvas = $('map');
  const [lng, lat] = eventLL(ev, canvas);
  if (State.tool === 'add') {
    State.undoStack.push({ verts: State.vertices.map((c) => c.slice()) });
    State.vertices.push([lng, lat]);
    await fullSave(true);             // 顶点改动走整线保存（拿最新 route_version）
  } else if (State.tool === 'stop') {
    await addStopAt([lng, lat]);
  }
});

(function wireMove() {
  const canvas = $('map');
  const hitVertex = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX) - rect.left, y = ev.clientY - rect.top;
    let best = -1, bd = 9;
    State.vertices.forEach((c, i) => {
      const [px, py] = canvas._proj.xy(c);
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  canvas.addEventListener('mousedown', (ev) => {
    if (State.tool !== 'move' && State.tool !== 'delete') return;
    const i = hitVertex(ev);
    if (i < 0) return;
    if (State.tool === 'delete') { deleteVertexAt(i); return; }
    dragging = i;
    ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => {
    if (dragging === null || !canvas._proj) return;
    const rect = canvas.getBoundingClientRect();
    const ll = canvas._proj.ll(ev.clientX - rect.left, ev.clientY - rect.top);
    const draft = State.vertices.map((c) => c.slice());
    draft[dragging] = ll;
    MapView.draw(canvas, draft, State.route.stops, { activeVertex: dragging });
  });
  window.addEventListener('mouseup', async (ev) => {
    if (dragging === null) return;
    const i = dragging; dragging = null;
    const rect = canvas.getBoundingClientRect();
    const ll = canvas._proj.ll(ev.clientX - rect.left, ev.clientY - rect.top);
    await moveVertexAt(i, ll);
  });
})();

$('undoBtn').onclick = async () => {
  const last = State.undoStack.pop();
  if (!last) return;
  State.vertices = last.verts;
  await fullSave(true);
};

/* ===== 网络操作 ===== */
function segVersionExpect() {
  return (State.route.segments || []).map((s) => ({ uid: s.uid, version: s.version }));
}
async function fullSave(silent) {
  const body = {
    title: $('fTitle').value.trim() || '未命名慢行线',
    story: $('fStory').value,
    geometry: { type: 'LineString', coordinates: State.vertices },
    expected_version: State.route.route_version
  };
  try {
    const r = await api('PUT', '/api/routes/' + State.routeId, body);
    applyRoute(r);
    if (r.conflict) toast('⚠️ ' + r.conflict.message, 'err');
    else if (!silent) toast('已保存（整路线乐观锁）', 'ok');
  } catch (e) {
    if (e.status === 409 && e.details && e.details.current_version) {
      $('lockConflict').classList.remove('hidden');
      $('lockConflict').innerHTML = '⛔ 版本冲突：你的版本 #' + e.details.your_version
        + ' 已过期，服务端当前 #' + e.details.current_version
        + '。<button class="primary" onclick="mergeRemote()">拉取最新并合并</button>'
        + '<small>（不同路段的改动也可以用"移动顶点"做分段合并）</small>';
    } else toast(e.message, 'err');
  }
}
window.mergeRemote = async () => {
  const r = await api('GET', '/api/routes/' + State.routeId);
  applyRoute(r); toast('已拉取最新版本，请在此基础上继续', 'ok');
};
$('saveFullBtn').onclick = () => fullSave(false);
$('saveTextBtn').onclick = async () => {
  try {
    const r = await api('PATCH', `/api/routes/${State.routeId}/text`,
      { title: $('fTitle').value.trim(), story: $('fStory').value });
    applyRoute(r); toast('文字已保存（若在审核中，旧审核会失效）', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

async function moveVertexAt(i, to) {
  try {
    const r = await api('POST', `/api/routes/${State.routeId}/segments/move`,
      { vertex_seq: i, to, expected_seg_versions: segVersionExpect() });
    applyRoute(r);
    if (r.conflict) toast('⚠️ ' + r.conflict.message, 'err');
  } catch (e) {
    if (e.status === 409) toast('同一路段被并发改动：' + JSON.stringify(e.details.conflicts || []), 'err');
    else toast(e.message, 'err');
    await loadRouteIntoEditor(State.routeId);
  }
}
async function deleteVertexAt(i) {
  if (!confirm('删除顶点 ' + i + '？相邻两段会合并，锚定的歇脚点可能需要重新定位。')) return;
  try {
    const r = await api('POST', `/api/routes/${State.routeId}/segments/delete`,
      { vertex_seq: i, expected_seg_versions: segVersionExpect() });
    applyRoute(r);
    if (r.conflict) toast('⚠️ ' + r.conflict.message, 'err');
  } catch (e) { toast(e.message, 'err'); await loadRouteIntoEditor(State.routeId); }
}
window.delStop = async (id) => {
  const r = await api('DELETE', `/api/routes/${State.routeId}/stops/${id}`); applyRoute(r);
};
window.saveNote = async (id) => {
  const note = $('note-' + id).value;
  const r = await api('PATCH', `/api/routes/${State.routeId}/stops/${id}`, { note }); applyRoute(r);
  toast('备注已保存', 'ok');
};
async function addStopAt(coordinates) {
  const name = prompt('歇脚点名字？', '歇脚点');
  if (!name) return;
  try {
    const r = await api('POST', `/api/routes/${State.routeId}/stops`, { name, note: '', coordinates });
    applyRoute(r); toast('歇脚点已自动吸附到最近路段', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

let relocateTarget = null;
window.pickRelocate = (id) => {
  relocateTarget = id;
  document.querySelectorAll('.map-toolbar .tool').forEach((x) => x.classList.remove('active'));
  toast('请在地图上新位置点击（自动吸附路线）', '');
  const canvas = $('map');
  const once = async (ev) => {
    const rect = canvas.getBoundingClientRect();
    const ll = canvas._proj.ll(ev.clientX - rect.left, ev.clientY - rect.top);
    try {
      const r = await api('POST', `/api/routes/${State.routeId}/stops/${relocateTarget}/relocate`, { coordinates: ll });
      applyRoute(r); toast('已重新定位', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    canvas.removeEventListener('click', once);
    relocateTarget = null;
  };
  canvas.addEventListener('click', once);
};

/* 照片上传：先上传二进制，成功后提交时才引用（避免照片未传完就送审） */
$('photoInput').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) return toast('照片不能超过 5MB（服务端限制）', 'err');
  try {
    const buf = await f.arrayBuffer();
    const ph = await api('POST', '/api/photos', buf, { raw: true, contentType: f.type });
    toast('照片已上传完成：' + ph.id, 'ok');
    await loadRouteIntoEditor(State.routeId);
  } catch (e) { toast('上传失败：' + e.message, 'err'); }
});

/* 提交/撤回：走离线队列（幂等键） */
$('submitBtn').onclick = async () => {
  const photoIds = (State.route.photos || []).map((p) => p.id);
  const body = { reason: $('reason').value || '提交审核', photo_ids: photoIds };
  if (!navigator.onLine) {
    queueRequest('POST', `/api/routes/${State.routeId}/submit`, body, '提交审核（离线）');
    return toast('当前离线，已加入待发队列');
  }
  try {
    const r = await api('POST', `/api/routes/${State.routeId}/submit`, body, { idemKey: uuid() });
    toast('已提交，审核单 ' + r.review_id, 'ok');
    await loadRouteIntoEditor(State.routeId);
  } catch (e) {
    if (e.status === 409 && e.details && e.details.stop_ids) {
      toast('还有歇脚点未重新定位，不能提交', 'err');
    } else toast(e.message, 'err');
  }
};
$('withdrawBtn').onclick = async () => {
  const note = prompt('撤回理由（会显示在旧链接上，不暴露你的新草稿）', '作者撤回');
  if (note === null) return;
  try {
    const out = await api('POST', `/api/routes/${State.routeId}/withdraw`, { note }, { idemKey: uuid() });
    applyRoute(await api('GET', '/api/routes/' + State.routeId));
    toast(out.status === 'withdrawn' ? '已撤回，旧链接保留状态说明' : '已撤回审核，回到草稿', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

/* ================= 审核台 ================= */
async function loadReviewQueue() {
  if (!State.token.startsWith('token-reviewer') && State.token !== 'token-admin') {
    $('reviewQueue').innerHTML = '<tr><td colspan="5" class="hint">请切换到审核员/管理员身份</td></tr>';
    $('reviewDetail').classList.add('hidden'); return;
  }
  const rows = await api('GET', '/api/reviews');
  $('reviewQueue').innerHTML = rows.map((r) => `
    <tr><td>${esc(r.title)}</td><td>v${r.version}</td><td>${esc(r.author_name)}</td>
    <td><small>${new Date(r.created_at).toLocaleString('zh-CN')}</small></td>
    <td><button class="primary" onclick="openReview('${r.review_id}')">审核</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="hint">没有待审路线</td></tr>';
}
window.openReview = async (id) => {
  State.currentReviewId = id;
  const r = await api('GET', '/api/reviews/' + id);
  $('reviewDetail').classList.remove('hidden');
  $('rvTitle').textContent = r.revision.title + '（v' + r.revision.version + ' 送审快照）';
  $('rvMeta').textContent = '路线 ' + r.route_id + '；审核单 ' + id;
  $('rvStory').textContent = r.revision.story;
  $('rvReason').textContent = r.revision.reason || '（无）';
  $('rvStops').innerHTML = (r.revision.stops || []).map((s) => `<li>📍 ${esc(s.name)} <small>${esc(s.note)}</small></li>`).join('') || '<li class="hint">无歇脚点</li>';
  MapView.draw($('rvMap'), r.revision.geometry.coordinates, (r.revision.stops || []).map((s) => ({ ...s, coordinates: s.coordinates })));
  if (!r.still_active) {
    $('rvStale').classList.remove('hidden');
    $('rvStale').innerHTML = '⛔ 这张审核单已失效：' + esc(r.superseded_reason || '作者改动了几何或文字') +
      '。你看到的仍是送审时冻结的旧快照；同意旧单会被服务端拒绝，作者需要用新版本重新投稿。';
  } else $('rvStale').classList.add('hidden');
};
async function decide(decision) {
  const comment = $('rvComment').value;
  try {
    await api('POST', `/api/reviews/${State.currentReviewId}/decision`, { decision, comment });
    toast('已提交决议：' + decision, 'ok');
    $('reviewDetail').classList.add('hidden');
    loadReviewQueue();
  } catch (e) { toast(e.message + (e.details ? '：' + JSON.stringify(e.details) : ''), 'err'); }
}
$('approveBtn').onclick = () => decide('approved');
$('changesBtn').onclick = () => decide('changes_requested');
$('rejectBtn').onclick = () => { if (!$('rvComment').value.trim()) return toast('驳回必须填写理由', 'err'); decide('rejected'); };

/* ================= 精选管理 ================= */
async function loadAdmin() {
  if (State.token !== 'token-admin') { $('adminPubs').innerHTML = '<tr><td colspan="4" class="hint">仅管理员</td></tr>'; $('adminFeatured').innerHTML = ''; return; }
  const q = $('searchAdmin').value.trim();
  const rows = await api('GET', '/api/public/search' + (q ? '?q=' + encodeURIComponent(q) : ''));
  $('adminPubs').innerHTML = rows.map((r) => `
    <tr><td>${esc(r.title)}</td><td><small>${r.publication_id}</small></td><td>已发布</td>
    <td><input id="blurb-${r.publication_id}" placeholder="推荐语" style="width:200px">
        <button class="primary" onclick="feature('${r.publication_id}')">精选</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="hint">没有已发布版本</td></tr>';
  const cards = await api('GET', '/api/public/featured');
  $('adminFeatured').innerHTML = cards.map((c) => `
    <tr><td><small>${c.card_id}</small></td><td>${esc(c.blurb)}</td>
    <td><small>${c.snapshot.title} v${c.snapshot.revision_version}${c.withdrawn ? '（已撤回）' : ''}</small></td>
    <td><button class="danger" onclick="unfeature('${c.card_id}')">撤销精选</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="hint">暂无精选</td></tr>';
}
window.feature = async (pid) => {
  try {
    await api('POST', '/api/featured', { publication_id: pid, blurb: $('blurb-' + pid).value.trim() || '值得一走' });
    toast('已精选', 'ok'); loadAdmin();
  } catch (e) { toast(e.message, 'err'); }
};
window.unfeature = async (cid) => { await api('DELETE', '/api/featured/' + cid); loadAdmin(); };
$('searchAdminBtn').onclick = loadAdmin;

/* ================= 公开浏览 ================= */
async function loadPublicFeatured() {
  const cards = await api('GET', '/api/public/featured');
  $('publicFeatured').innerHTML = cards.map((c) => `
    <div class="fcard ${c.withdrawn ? 'is-withdrawn' : ''}">
      <canvas data-pub="${c.snapshot.publication_id}" width="320" height="150"></canvas>
      <div class="body">
        <h4>${esc(c.snapshot.title)} <small>v${c.snapshot.revision_version}</small></h4>
        <div class="hint">${esc(c.blurb)}</div>
        ${c.withdrawn ? `<div class="withdrawn-tag">已撤回：${esc(c.withdrawn_note || '')}</div>` : ''}
        <button onclick="openPublication('${c.snapshot.publication_id}')">查看发布快照</button>
      </div>
    </div>`).join('') || '<p class="hint">暂无精选</p>';
  // 画缩略图
  for (const c of cards) {
    const cv = document.querySelector(`canvas[data-pub="${c.snapshot.publication_id}"]`);
    if (cv) MapView.draw(cv, c.snapshot.geometry.coordinates, (c.snapshot.stops || []).map((s) => ({ ...s })));
  }
}
window.openPublication = async (pid) => {
  const r = await api('GET', '/api/public/publications/' + pid);
  State.currentPubId = pid;
  $('publicDetail').classList.remove('hidden');
  $('pubTitle').textContent = r.title + '（发布版 v' + r.revision_version + '）';
  $('pubStory').textContent = r.story;
  $('pubStops').innerHTML = (r.stops || []).map((s) => `<li>📍 ${esc(s.name)} <small>${esc(s.note)}</small></li>`).join('');
  MapView.draw($('pubMap'), r.geometry.coordinates, (r.stops || []).map((s) => ({ ...s })));
  const sn = $('pubStatus');
  if (r.withdrawn) { sn.classList.remove('hidden'); sn.className = 'status-note withdrawn'; sn.textContent = r.status_note; }
  else sn.classList.add('hidden');
  $('pubBasis').textContent = '审核依据：' + r.audit_basis.reviewer + ' 于 '
    + new Date(r.audit_basis.decided_at).toLocaleString('zh-CN') + ' 通过'
    + (r.audit_basis.comment ? '（' + r.audit_basis.comment + '）' : '') + '；审核单 ' + r.audit_basis.review_id;
};
$('pubBack').onclick = () => $('publicDetail').classList.add('hidden');
$('searchPublicBtn').onclick = async () => {
  const rows = await api('GET', '/api/public/search?q=' + encodeURIComponent($('searchPublic').value.trim()));
  $('publicResults').innerHTML = rows.map((r) =>
    `<li>${esc(r.title)} <button onclick="openPublication('${r.publication_id}')">查看</button></li>`).join('')
    || '<li class="hint">无结果（已撤回不会出现）</li>';
};

/* ===== 初始 ===== */
loadMyRoutes();
renderQueue();
