import { createHash } from 'node:crypto';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

// 确定性版本指纹：审核针对“确定的路线几何 + 文字版”。
// 指纹相同才视为审核同意仍然有效；改一个危险路口都会让指纹变化。
export function versionFingerprint(geometry, story, title, restPoints) {
  const payload = {
    type: geometry.type,
    coordinates: geometry.coordinates,
    vertexIds: geometry.vertexIds,
    title,
    story,
    restPoints: (restPoints || []).map((p) => ({
      name: p.name,
      note: p.note,
      anchor: p.anchor // 锚定的边与 t 值，几何一改自动失配
    }))
  };
  return 'sha256:' + createHash('sha256').update(canonical(payload)).digest('hex');
}

export function hashString(str) {
  return createHash('sha256').update(str).digest('hex');
}
