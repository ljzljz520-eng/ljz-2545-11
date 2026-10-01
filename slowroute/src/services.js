import { LIMITS as L, VERSION_STATUS as S, ROLES, TASK } from './config.js';
import { parseLineString, edgeTags, coordFromAnchor, anchorPoint } from './geometry.js';
import { applyVertexOps, touchedEdges, detectEdgeConflicts, relinkRestPoints } from './merge.js';
import { validateSubmission, assertText, assertReason } from './validation.js';
import { versionFingerprint } from './hash.js';
import { conflict, forbidden, notFound, gone, badRequest } from './errors.js';

export function createServices(store) {
  const repo = store.repo;

  const mustGetVersion = async (id) => {
    const v = await repo.versionGet(id);
    if (!v) throw notFound('version_not_found', '版本不存在');
    return v;
  };
  const mustGetRoute = async (id) => {
    const r = await repo.routeGet(id);
    if (!r) throw notFound('route_not_found', '路线不存在');
    return r;
  };
  const isReviewer = (user) => user.role === ROLES.REVIEWER;

  const compute = (geometry, title, story, restPoints) => ({
    fingerprint: versionFingerprint(geometry, story, title, restPoints),
    edgeTags: edgeTags(geometry)
  });

  function createUser(name, role = ROLES.AUTHOR) {
    if (![ROLES.AUTHOR, ROLES.REVIEWER].includes(role)) throw badRequest('bad_role', '角色非法');
    const u = { id: repo.newId('user'), name, role, createdAt: new Date().toISOString() };
    return repo.userInsert(u);
  }

  // ---------- 照片：两段式上传，提交时必须全部 ready ----------
  function initPhoto(user, { filename, bytes } = {}) {
    if (typeof filename !== 'string' || !filename) throw badRequest('filename_required', '缺少文件名');
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 8 * 1024 * 1024)
      throw badRequest('bad_bytes', '照片大小非法（上限 8MB）');
    return repo.photoInsert({
      id: repo.newId('photo'), authorId: user.id, filename, bytes,
      status: 'uploading', createdAt: new Date().toISOString()
    });
  }
  function completePhoto(user, photoId) {
    const p = repo.photoGet(photoId);
    if (!p) throw notFound('photo_not_found', '照片不存在');
    if (p.authorId !== user.id) throw forbidden();
    if (p.status === 'uploading') { p.status = 'ready'; p.readyAt = new Date().toISOString(); repo.photoUpdate(p); }
    return p;
  }
  const assertPhotosReady = (user, ids) => {
    const missing = [];
    for (const id of ids || []) {
      const p = repo.photoGet(id);
      if (!p || p.authorId !== user.id || p.status !== 'ready') missing.push(id);
    }
    if (missing.length)
      throw badRequest('photos_not_ready', '存在未上传完成或不可用的照片，不能提交', { missing });
  };

  // ---------- 草稿 / 整路线替换（整路线乐观锁） ----------
  function createDraft(user, body) {
    const { geometry, restPoints, photoIds } = validateSubmission(body);
    const title = body.title.trim();
    const meta = compute(geometry, title, body.story, restPoints);
    const now = new Date().toISOString();
    const routeId = repo.newId('route');
    const version = {
      id: repo.newId('ver'), routeId, authorId: user.id,
      status: S.DRAFT, parentVersionId: null,
      title, story: body.story, geometry, restPoints, photoIds,
      geometryRev: 1, storyRev: 1, noteRev: 1,
      fingerprint: meta.fingerprint, edgeTags: meta.edgeTags, createdAt: now, updatedAt: now
    };
    repo.versionInsert(version);
    const route = { id: routeId, authorId: user.id, draftVersionId: version.id, currentPublishedId: null, createdAt: now };
    repo.routeInsert(route);
    return { route, version: sanitize(version) };
  }

  async function replaceWhole(user, routeId, body, expectedGeometryRev) {
    const route = await mustGetRoute(routeId);
    if (route.authorId !== user.id) throw forbidden();
    const v = await mustGetVersion(route.draftVersionId);
    if (v.status === S.IN_REVIEW) return reviseSubmission(user, route, v, body, expectedGeometryRev);
    if (![S.DRAFT, S.REJECTED, S.WITHDRAWN].includes(v.status))
      throw conflict('version_not_editable', '当前版本状态不允许编辑', { status: v.status });
    if (Number(expectedGeometryRev) !== v.geometryRev)
      throw conflict('geometry_rev_stale', '折线已被改动，请基于最新版本整体覆盖', {
        expected: Number(expectedGeometryRev), current: v.geometryRev
      });
    const { geometry, restPoints, photoIds } = validateSubmission(body);
    assertText(body.title, body.story);
    const meta = compute(geometry, body.title.trim(), body.story, restPoints);
    Object.assign(v, {
      title: body.title.trim(), story: body.story, geometry, restPoints, photoIds,
      fingerprint: meta.fingerprint, edgeTags: meta.edgeTags, updatedAt: new Date().toISOString()
    });
    v.geometryRev += 1; v.storyRev += 1;
    repo.versionUpdate(v);
    return { route, version: sanitize(v), relocated: [] };
  }

  // ---------- 分段合并：路段插删 + 歇脚点依赖 ----------
  async function segmentBatch(user, routeId, batch) {
    const route = await mustGetRoute(routeId);
    if (route.authorId !== user.id) throw forbidden();
    let v = await mustGetVersion(route.draftVersionId);
    if (![S.DRAFT, S.REJECTED, S.WITHDRAWN].includes(v.status))
      throw conflict('version_not_editable', '仅草稿可做分段编辑', { status: v.status });
    if (!batch.clientOpId || typeof batch.clientOpId !== 'string')
      throw badRequest('client_op_id_required', '分段编辑必须带 clientOpId（离线重送幂等）');

    const key = routeId + '#' + batch.clientOpId;
    const done = repo.processedGet(key);
    if (done) return done.response; // 离线重送：同一操作只生效一次

    return repo.withLock('segment:' + routeId, async () => {
      // 进入临界区后重新读行：排队期间他人可能已提交（不能用锁前快照裁决冲突）
      v = await repo.versionGet(v.id);
      const baseRev = Number(batch.baseGeometryRev);
      if (!Number.isFinite(baseRev) || baseRev > v.geometryRev)
        throw conflict('rev_unknown', '未知的基线版本', { current: v.geometryRev });

      let trial;
      try {
        trial = applyVertexOps(v.geometry, batch.ops || []);
      } catch (e) {
        if (e.code === 'stale_vertex')
          throw conflict('stale_vertex', '引用的顶点已被他人删除，请 rebase', { vertexId: e.vertexId });
        throw badRequest(e.code || 'bad_op', e.message);
      }

      // 冲突检测按“客户端基线”判断操作触及哪些边：
      // 从 baseTags 的边集合里找出与操作引用顶点相邻的边，
      // 再与当前落库指纹逐一比对（不能在他人提交后的新几何上反推，否则漏掉被重写的旧边）。
      const referenced = new Set();
      for (const op of batch.ops || []) {
        if (op.vertexId) referenced.add(op.vertexId);
        if (op.after) referenced.add(op.after);
      }
      const myTouched = new Set();
      for (const key of Object.keys(batch.baseTags || {})) {
        const [from, to] = key.split('>');
        if (referenced.has(from) || referenced.has(to)) myTouched.add(key);
      }
      if (batch.baseTags) {
        const conflicts = detectEdgeConflicts(batch.baseTags, v.edgeTags, myTouched);
        if (conflicts.length)
          throw conflict('same_segment_conflict', '与他人的同一路段编辑冲突，请 rebase 后重试', {
            conflicts, currentGeometryRev: v.geometryRev
          });
      }

      let newGeometry;
      try {
        newGeometry = parseLineString({ type: 'LineString', coordinates: trial.coordinates, vertexIds: trial.vertexIds });
      } catch (e) {
        throw Object.assign(e, { details: { ...(e.details || {}), afterOps: true } });
      }

      const newTags = edgeTags(newGeometry);
      const relinked = relinkRestPoints(v.restPoints, v.edgeTags, newTags, newGeometry, coordFromAnchor);
      const detached = relinked.filter((r) => r.state === 'detached').map((r) => r.point.id);
      const repositioned = relinked.filter((r) => r.state === 'repositioned').map((r) => ({
        pointId: r.point.id, coord: r.coord
      }));

      const unresolved = detached.filter((id) => {
        const res = (batch.resolutions || {})[id];
        return !res || (!res.drop && !res.coord);
      });
      if (unresolved.length)
        throw conflict('point_needs_relocate', '路段插删后有歇脚点失去依附，请重新定位或删除', {
          detached, repositioned, clientOpId: batch.clientOpId, currentGeometryRev: v.geometryRev
        });

      const points = relinked.map((r) => {
        const res = (batch.resolutions || {})[r.point.id];
        if (r.state === 'detached' && res) {
          if (res.drop) return null;
          return { ...r.point, coord: res.coord, anchor: anchorPoint(res.coord, newGeometry) };
        }
        return { ...r.point, coord: r.coord, anchor: r.point.anchor };
      }).filter(Boolean);

      if (batch.noteUpdates) applyNoteUpdates(v, batch.noteUpdates);
      if (batch.story !== undefined) applyStory(v, batch.story, batch.expectedStoryRev);

      Object.assign(v, {
        geometry: newGeometry, edgeTags: newTags, restPoints: points,
        geometryRev: v.geometryRev + 1, updatedAt: new Date().toISOString()
      });
      v.fingerprint = versionFingerprint(v.geometry, v.story, v.title, v.restPoints);
      repo.versionUpdate(v);

      const response = {
        version: sanitize(v),
        repositioned,
        dropped: detached.filter((id) => (batch.resolutions || {})[id]?.drop),
        geometryRev: v.geometryRev
      };
      repo.processedPut(key, { response, at: new Date().toISOString() });
      return response;
    });
  }

  function applyNoteUpdates(v, updates) {
    const next = new Map();
    for (const u of updates || []) {
      if (!u || typeof u.pointId !== 'string') throw badRequest('bad_note_update', '备注更新格式错误');
      if (typeof u.note !== 'string' || u.note.length > L.MAX_NOTE_CHARS)
        throw badRequest('note_too_long', '点位备注过长');
      next.set(u.pointId, u.note);
    }
    for (const p of v.restPoints) if (next.has(p.id)) p.note = next.get(p.id);
    v.noteRev += 1;
  }
  async function updateNote(user, routeId, pointId, note, expectedNoteRev) {
    const route = await mustGetRoute(routeId);
    if (route.authorId !== user.id) throw forbidden();
    const v = await mustGetVersion(route.draftVersionId);
    if (![S.DRAFT, S.REJECTED].includes(v.status)) throw conflict('version_not_editable', '当前不能改备注');
    if (Number(expectedNoteRev) !== v.noteRev)
      throw conflict('note_rev_stale', '点位备注已被改动，请刷新后重试', { current: v.noteRev });
    const p = v.restPoints.find((x) => x.id === pointId);
    if (!p) throw notFound('point_not_found', '歇脚点不存在');
    if (typeof note !== 'string' || note.length > L.MAX_NOTE_CHARS) throw badRequest('note_too_long', '点位备注过长');
    p.note = note; v.noteRev += 1;
    v.fingerprint = versionFingerprint(v.geometry, v.story, v.title, v.restPoints);
    repo.versionUpdate(v);
    return sanitize(v);
  }
  function applyStory(v, story, expectedStoryRev) {
    if (typeof story !== 'string' || story.length > L.MAX_STORY_CHARS) throw badRequest('story_too_long', '故事过长');
    if (expectedStoryRev !== undefined && Number(expectedStoryRev) !== v.storyRev)
      throw conflict('story_rev_stale', '故事文字已被改动，请刷新', { current: v.storyRev });
    v.story = story; v.storyRev += 1;
  }
  async function updateStory(user, routeId, { title, story, expectedStoryRev }) {
    const route = await mustGetRoute(routeId);
    if (route.authorId !== user.id) throw forbidden();
    const v = await mustGetVersion(route.draftVersionId);
    if (![S.DRAFT, S.REJECTED, S.WITHDRAWN].includes(v.status)) throw conflict('version_not_editable', '当前不能改故事');
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim() || title.length > L.MAX_TITLE_CHARS) throw badRequest('bad_title', '标题非法');
      v.title = title.trim();
    }
    applyStory(v, story ?? v.story, expectedStoryRev);
    v.fingerprint = versionFingerprint(v.geometry, v.story, v.title, v.restPoints);
    repo.versionUpdate(v);
    return sanitize(v);
  }

  // ---------- 提交审核 ----------
  async function submitForReview(user, routeId) {
    const route = await mustGetRoute(routeId);
    if (route.authorId !== user.id) throw forbidden();
    const v = await mustGetVersion(route.draftVersionId);
    if (v.status === S.IN_REVIEW) throw conflict('already_in_review', '该版本已在审核中');
    if (![S.DRAFT, S.REJECTED, S.WITHDRAWN].includes(v.status))
      throw conflict('not_submittable', '当前状态不可提交', { status: v.status });
    assertPhotosReady(user, v.photoIds);
    for (const p of v.restPoints) assertPhotosReady(user, p.photoIds);
    v.status = S.IN_REVIEW;
    v.submittedAt = new Date().toISOString();
    v.fingerprint = versionFingerprint(v.geometry, v.story, v.title, v.restPoints);
    repo.versionUpdate(v);
    return sanitize(v);
  }

  // 审核中作者改危险路口：旧审核绝不沿用——旧版整体撤回留痕，修改进入新草稿分支。
  function reviseSubmission(user, route, oldV, body) {
    const { geometry, restPoints, photoIds } = validateSubmission(body);
    assertText(body.title, body.story);
    if (versionFingerprint(oldV.geometry, oldV.story, oldV.title, oldV.restPoints) ===
        versionFingerprint(geometry, body.story, body.title.trim(), restPoints))
      return { route, version: sanitize(oldV), relocated: [], unchanged: true };

    const now = new Date().toISOString();
    const freshId = repo.newId('ver');
    const meta = compute(geometry, body.title.trim(), body.story, restPoints);
    const fresh = {
      id: freshId, routeId: route.id, authorId: user.id,
      status: S.DRAFT, parentVersionId: oldV.id,
      title: body.title.trim(), story: body.story, geometry, restPoints, photoIds,
      geometryRev: 1, storyRev: 1, noteRev: 1,
      fingerprint: meta.fingerprint, edgeTags: meta.edgeTags, createdAt: now, updatedAt: now
    };
    oldV.status = S.WITHDRAWN;
    oldV.withdrawnAt = now;
    oldV.withdrawReason = '作者在审核期间修改了路线，旧审核申请自动关闭，需重新提交';
    oldV.supersededById = freshId;
    repo.versionUpdate(oldV);
    repo.versionInsert(fresh);
    route.draftVersionId = freshId;
    repo.routeUpdate(route);
    return { route, version: sanitize(fresh), relocated: [], superseded: oldV.id };
  }

  // ---------- 撤回 / 审核竞争 ----------
  async function withdraw(user, routeId, reason) {
    const route = await mustGetRoute(routeId);
    if (route.authorId !== user.id && !isReviewer(user)) throw forbidden();
    const r = assertReason(reason);
    const v = await mustGetVersion(route.draftVersionId);
    return repo.withVersionTx(v.id, async (tx) => {
      const cur = tx.state;
      if (cur.status === S.PUBLISHED) {
        await doUnpublish(tx, route, cur, user, r);
        return { version: sanitize(cur) };
      }
      if (cur.status !== S.IN_REVIEW)
        throw conflict('not_withdrawable', '仅审核中或已发布版本可撤回', { status: cur.status });
      cur.status = S.WITHDRAWN;
      cur.withdrawnAt = new Date().toISOString();
      cur.withdrawReason = r;
      tx.save(cur);
      return { version: sanitize(cur) };
    });
  }

  // ---------- 审核：针对确定几何 + 文字的指纹 ----------
  async function review(user, versionId, action, reason, expectedFingerprint) {
    if (!isReviewer(user)) throw forbidden('reviewer_only', '仅审核员可操作');
    const r = assertReason(reason);
    if (!['approve', 'reject'].includes(action)) throw badRequest('bad_action', '审核动作非法');
    await mustGetVersion(versionId);
    return repo.withVersionTx(versionId, async (tx) => {
      const cur = tx.state;
      if (cur.status !== S.IN_REVIEW)
        throw conflict('not_in_review', '该版本不在审核中（可能已被作者撤回）', { status: cur.status });
      if (cur.fingerprint !== expectedFingerprint)
        throw conflict('fingerprint_mismatch', '送审内容与当前版本不一致，请重新打开版本', { current: cur.fingerprint });
      const reviewId = repo.newId('rev');
      const record = {
        id: reviewId, versionId: cur.id, routeId: cur.routeId,
        reviewerId: user.id, action, reason: r, fingerprint: cur.fingerprint,
        snapshot: { geometry: cur.geometry, title: cur.title, story: cur.story, restPoints: cur.restPoints, fingerprint: cur.fingerprint },
        createdAt: new Date().toISOString()
      };
      repo.reviewInsert(record);
      cur.status = action === 'approve' ? S.APPROVED : S.REJECTED;
      cur.decidedAt = record.createdAt;
      cur.reviewId = reviewId;
      if (action === 'reject') cur.rejectReason = r;
      tx.save(cur);
      return { version: sanitize(cur), review: record };
    });
  }

  // ---------- 发布：后台可重试 ----------
  async function publish(user, routeId) {
    const route = await mustGetRoute(routeId);
    if (route.authorId !== user.id && !isReviewer(user)) throw forbidden();
    const v = await mustGetVersion(route.draftVersionId);
    return repo.withVersionTx(v.id, async (tx) => {
      const cur = tx.state;
      if (cur.status !== S.APPROVED)
        throw conflict('not_approved', '只有审核通过的版本可发布', { status: cur.status });
      cur.status = S.PUBLISHED;
      cur.publishedAt = new Date().toISOString();
      route.currentPublishedId = cur.id;
      repo.routeUpdate(route);
      tx.save(cur);
      tx.enqueue(TASK.PUBLISH_INDEX, { routeId: route.id, versionId: cur.id }, { dedupeKey: 'publish:' + cur.id });
      tx.enqueue(TASK.SEARCH_INDEX, { routeId: route.id, versionId: cur.id, action: 'index' },
        { dedupeKey: 'search:index:' + cur.id });
      return { version: sanitize(cur) };
    });
  }

  async function doUnpublish(tx, route, v, user, reason) {
    v.status = S.WITHDRAWN;
    v.withdrawnAt = new Date().toISOString();
    v.withdrawReason = reason;
    tx.save(v);
    if (route.currentPublishedId === v.id) { route.currentPublishedId = null; repo.routeUpdate(route); }
    for (const f of repo.featuredList()) {
      if (f.routeId === route.id && f.active) {
        f.active = false;
        f.deactivatedReason = '引用的发布版本被撤回：' + reason;
        f.deactivatedAt = new Date().toISOString();
        repo.featuredUpdate(f);
      }
    }
    repo.searchDelete(route.id);
    tx.enqueue(TASK.UNPUBLISH_INDEX, { routeId: route.id, versionId: v.id }, { dedupeKey: 'unpublish:' + v.id });
  }

  // ---------- 精选：发布快照 + 完整审核依据 ----------
  async function feature(user, routeId, reason) {
    if (!isReviewer(user)) throw forbidden('reviewer_only', '仅审核员可操作');
    const r = assertReason(reason);
    const route = await mustGetRoute(routeId);
    const v = await repo.versionGet(route.currentPublishedId);
    if (!v || v.status !== S.PUBLISHED)
      throw conflict('not_published', '只能精选已发布版本', { status: v?.status });
    const review = await repo.reviewGet(v.reviewId);
    if (!review || review.fingerprint !== v.fingerprint || review.action !== 'approve')
      throw conflict('missing_review_basis', '该发布版本缺少完整审核依据，不能精选');
    const card = {
      id: repo.newId('feat'), routeId: route.id, versionId: v.id, active: true, reason: r,
      snapshot: { title: v.title, story: v.story, geometry: v.geometry, restPoints: v.restPoints, publishedAt: v.publishedAt },
      reviewBasis: { reviewId: review.id, reviewerId: review.reviewerId, reason: review.reason, fingerprint: review.fingerprint, decidedAt: review.createdAt },
      createdAt: new Date().toISOString()
    };
    return repo.featuredInsert(card);
  }
  const listFeatured = () => repo.featuredList();

  // ---------- 读取：视角隔离 ----------
  async function viewVersion(user, versionId) {
    const v = await repo.versionGet(versionId);
    if (!v) throw notFound('version_not_found', '版本不存在');
    const owner = user && v.authorId === user.id;
    const reviewer = user && isReviewer(user);
    if (v.status === S.PUBLISHED) return sanitize(v);
    if (v.status === S.WITHDRAWN) {
      // 旧链接保留状态说明，但未公开几何/故事不返回
      throw gone('version_withdrawn', v.withdrawReason || '该版本已被作者撤回', {
        id: v.id, routeId: v.routeId, status: v.status, withdrawnAt: v.withdrawnAt,
        stateNote: v.withdrawReason || '该版本已被作者撤回',
        ...(owner || reviewer ? { supersededById: v.supersededById } : {})
      });
    }
    if (!user || (!owner && !reviewer)) throw notFound('version_not_found', '版本不存在');
    return sanitize(v);
  }

  async function viewRoute(user, routeId) {
    const route = await repo.routeGet(routeId);
    if (!route) throw notFound('route_not_found', '路线不存在');
    const owner = user && route.authorId === user.id;
    const reviewer = user && isReviewer(user);
    const pub = await repo.versionGet(route.currentPublishedId);
    const out = { id: route.id, status: pub ? S.PUBLISHED : 'unpublished' };
    if (pub) out.published = sanitize(pub);
    if (owner || reviewer) {
      out.draft = sanitize(await repo.versionGet(route.draftVersionId));
      const all = repo.kind === 'memory'
        ? [...store.tables.versions.values()].filter((x) => x.routeId === routeId)
        : await repo.versionsByRoute(routeId);
      out.versions = all.map(sanitize);
      return out;
    }
    if (!pub) throw notFound('route_not_found', '路线不存在'); // 不泄漏未公开路线
    return out;
  }

  function sanitize(v) {
    if (!v) return v;
    // edgeTags 是边内容的哈希指纹，作为分段合并乐观锁的公开凭据返回；
    // 它不包含坐标本身，不会比已授权的草稿几何泄漏更多信息。
    const { edgeTags, ...rest } = v;
    return { ...rest, edgeEtags: edgeTags };
  }

  async function listInReview(user) {
    if (!isReviewer(user)) throw forbidden('reviewer_only', '仅审核员可操作');
    const rows = repo.kind === 'memory'
      ? [...store.tables.versions.values()].filter((x) => x.status === S.IN_REVIEW)
      : await repo.versionsByStatus(S.IN_REVIEW);
    return rows.map(sanitize);
  }
  async function searchPublished(q) {
    const rows = repo.searchList();
    const term = (q || '').trim().toLowerCase();
    return term ? rows.filter((r) => (r.title + ' ' + (r.snippet || '') + ' ' + (r.points || '')).toLowerCase().includes(term)) : rows;
  }
  async function listMyRoutes(user) {
    const rows = repo.kind === 'memory'
      ? [...store.tables.routes.values()].filter((r) => r.authorId === user.id)
      : await repo.routesByAuthor(user.id);
    return Promise.all(rows.map((r) => viewRoute(user, r.id)));
  }

  return {
    repo, createUser, initPhoto, completePhoto,
    createDraft, replaceWhole, segmentBatch, updateNote, updateStory,
    submitForReview, withdraw, review, publish, feature, listFeatured,
    viewVersion, viewRoute, listInReview, searchPublished, listMyRoutes,
    _compute: compute
  };
}
