import { LIMITS as L } from './config.js';
import { parseLineString, anchorPoint } from './geometry.js';
import { badRequest, payloadTooLarge } from './errors.js';

export function assertText(title, story) {
  if (typeof title !== 'string' || !title.trim())
    throw badRequest('title_required', '路线标题必填');
  if (title.length > L.MAX_TITLE_CHARS)
    throw payloadTooLarge('title_too_long', `标题不超过 ${L.MAX_TITLE_CHARS} 字`);
  if (typeof story !== 'string' || !story.trim())
    throw badRequest('story_required', '路线故事必填');
  if (story.length > L.MAX_STORY_CHARS)
    throw payloadTooLarge('story_too_long', `故事不超过 ${L.MAX_STORY_CHARS} 字`);
}

// rawPoints: [{name,note,coord:[lng,lat],photoIds:[]}]
// 服务端把用户坐标重新锚定到折线 —— 锚点不是客户端自报的，无法伪造。
export function normalizeRestPoints(rawPoints, geometry) {
  if (rawPoints == null) return [];
  if (!Array.isArray(rawPoints)) throw badRequest('bad_rest_points', '歇脚点必须是数组');
  if (rawPoints.length > L.MAX_REST_POINTS)
    throw payloadTooLarge('too_many_points', `歇脚点不超过 ${L.MAX_REST_POINTS} 个`);
  return rawPoints.map((p, i) => {
    if (!p || typeof p !== 'object') throw badRequest('bad_point', '歇脚点格式错误', { index: i });
    const name = String(p.name ?? '').trim();
    if (!name) throw badRequest('point_name_required', '歇脚点名称必填', { index: i });
    if (name.length > 80) throw payloadTooLarge('point_name_too_long', '歇脚点名称过长', { index: i });
    const note = String(p.note ?? '');
    if (note.length > L.MAX_NOTE_CHARS) throw payloadTooLarge('note_too_long', '点位备注过长', { index: i });
    const anchor = anchorPoint(p.coord, geometry);
    return {
      id: typeof p.id === 'string' && /^p[a-z0-9_-]{0,64}$/i.test(p.id) ? p.id : 'p' + Math.random().toString(36).slice(2, 10),
      name,
      note,
      coord: p.coord,
      anchor,
      photoIds: Array.isArray(p.photoIds) ? p.photoIds.filter((x) => typeof x === 'string').slice(0, 10) : []
    };
  });
}

// 提交整包校验：坐标有界、复杂度受限、自交检测全部在 parseLineString 内完成。
export function validateSubmission(body) {
  if (!body || typeof body !== 'object') throw badRequest('bad_body', '请求体格式错误');
  assertText(body.title, body.story);
  const geometry = parseLineString(body.geometry);
  const restPoints = normalizeRestPoints(body.restPoints, geometry);
  const photoIds = Array.isArray(body.photoIds) ? body.photoIds.filter((x) => typeof x === 'string') : [];
  return { geometry, restPoints, photoIds };
}

export function assertReason(reason) {
  if (typeof reason !== 'string' || !reason.trim())
    throw badRequest('reason_required', '必须填写审核/撤回理由');
  if (reason.length > L.MAX_REASON_CHARS)
    throw payloadTooLarge('reason_too_long', `理由不超过 ${L.MAX_REASON_CHARS} 字`);
  return reason.trim();
}
