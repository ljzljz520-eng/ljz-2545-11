import { LIMITS as L } from './config.js';
import { badRequest } from './errors.js';

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

// 等距圆柱近似距离，慢行路线尺度下足够，且可重复、无第三方依赖。
export function meters(a, b) {
  const x = toRad(b[0] - a[0]) * Math.cos(toRad((a[1] + b[1]) / 2));
  const y = toRad(b[1] - a[1]);
  return Math.hypot(x, y) * R;
}

export function pathLengthKm(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += meters(coords[i - 1], coords[i]);
  return total / 1000;
}

const finiteNum = (n) => typeof n === 'number' && Number.isFinite(n);

export function assertBoundedCoord(c) {
  if (!Array.isArray(c) || c.length < 2)
    throw badRequest('bad_coordinate', '坐标必须是 [lng,lat]');
  const [lng, lat] = c;
  if (!finiteNum(lng) || !finiteNum(lat))
    throw badRequest('bad_coordinate', '经纬度必须是有限数字', { coord: c });
  if (lng < L.LNG_MIN || lng > L.LNG_MAX || lat < L.LAT_MIN || lat > L.LAT_MAX)
    throw badRequest('coord_out_of_bounds', '坐标超出允许范围', {
      coord: [lng, lat],
      bounds: { lng: [L.LNG_MIN, L.LNG_MAX], lat: [L.LAT_MIN, L.LAT_MAX] }
    });
}

// 正确的 GeoJSON LineString：{"type":"LineString","coordinates":[[lng,lat],...]}
// vertexIds 为扩展字段（稳定顶点 id），缺失时由服务端补齐 —— 不接受客户端伪造规则。
export function parseLineString(input) {
  if (!input || typeof input !== 'object' || input.type !== 'LineString')
    throw badRequest('not_linestring', 'geometry 必须是 GeoJSON LineString');
  const coords = input.coordinates;
  if (!Array.isArray(coords)) throw badRequest('not_linestring', 'coordinates 必须是数组');
  if (coords.length < L.MIN_VERTICES)
    throw badRequest('too_few_vertices', `折线至少需要 ${L.MIN_VERTICES} 个顶点`);
  if (coords.length > L.MAX_VERTICES)
    throw badRequest('too_complex', `折线最多 ${L.MAX_VERTICES} 个顶点`, { vertices: coords.length });

  const clean = coords.map((c) => {
    assertBoundedCoord(c);
    const lng = Number(c[0].toFixed(L.COORD_DECIMALS));
    const lat = Number(c[1].toFixed(L.COORD_DECIMALS));
    return [lng, lat];
  });

  // 相邻重复点 / 退化边
  for (let i = 1; i < clean.length; i++) {
    if (meters(clean[i - 1], clean[i]) < L.MIN_SEGMENT_METERS)
      throw badRequest('degenerate_segment', '存在重合或过短的相邻顶点', { index: i });
  }
  const km = pathLengthKm(clean);
  if (km > L.MAX_TOTAL_KM)
    throw badRequest('route_too_long', `路线总长不得超过 ${L.MAX_TOTAL_KM}km`, { lengthKm: km });

  // 自交检测：折线不能“打结”。仅检查非相邻边的真相交（共端点不报错，
  // 同一顶点折返已在退化边处拦截）。
  const hit = findSelfIntersection(clean);
  if (hit)
    throw badRequest('self_intersection', '折线存在自相交，请调整危险路口附近的走线', hit);

  let vertexIds = Array.isArray(input.vertexIds) ? input.vertexIds.slice(0, clean.length) : [];
  const seen = new Set();
  vertexIds = vertexIds.map((id, i) => {
    if (typeof id !== 'string' || !/^v[a-z0-9_-]{0,64}$/i.test(id) || seen.has(id))
      throw badRequest('bad_vertex_id', '顶点 id 非法或重复', { index: i });
    seen.add(id);
    return id;
  });
  while (vertexIds.length < clean.length) {
    let id;
    do {
      id = 'v' + Math.random().toString(36).slice(2, 10);
    } while (seen.has(id));
    seen.add(id);
    vertexIds.push(id);
  }

  return { type: 'LineString', coordinates: clean, vertexIds };
}

// 线段相交。返回交点；allowEndTouch 控制端点触碰是否算相交：
// 两条仅“共享折线中的相邻顶点”的边由调用方排除，其余非相邻边即使只是
// 端点落在另一边上（蝴蝶结回到中间路口）也判为自交。
function segIntersects(p1, p2, p3, p4, allowEndTouch = false) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  const eps = 1e-9;
  const tInside = t > eps && t < 1 - eps;
  const uInside = u > eps && u < 1 - eps;
  const proper = tInside && uInside;
  const touch = !allowEndTouch && tInside && (u <= eps || u >= 1 - eps);
  if (proper || touch) {
    return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
  }
  return null;
}

export function findSelfIntersection(coords) {
  const n = coords.length;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      // 仅当两条边在折线序列里真的相邻（共享端点）时才豁免
      const adjacent = j === i + 1 || (i === 0 && j === n - 2);
      const at = segIntersects(coords[i], coords[i + 1], coords[j], coords[j + 1], adjacent);
      if (at) return { at: [Number(at[0].toFixed(6)), Number(at[1].toFixed(6))], edges: [i, j] };
    }
  }
  return null;
}

// 点到折线各边的投影，返回最近锚点：edge 为边序号，t 为沿线比例，
// dxM/dyM 为歇脚点相对锚点的垂直偏移（米），几何微调后可据此自动重定位。
export function projectToPath(coord, coords) {
  let best = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const lenM = meters(a, b);
    if (lenM <= 0) continue;
    const latMid = toRad((a[1] + b[1]) / 2);
    const mx = (dxLng) => toRad(dxLng) * Math.cos(latMid) * R;
    const ax = mx(coord[0] - a[0]);
    const ay = toRad(coord[1] - a[1]) * R;
    const bx = mx(b[0] - a[0]);
    const by = toRad(b[1] - a[1]) * R;
    let t = (ax * bx + ay * by) / (lenM * lenM);
    t = Math.max(0, Math.min(1, t));
    const px = t * bx;
    const py = t * by;
    const dist = Math.hypot(ax - px, ay - py);
    if (!best || dist < best.dist) {
      best = {
        edge: i,
        fromVertex: null, // 由调用方补 vertex id
        toVertex: null,
        t: Number(t.toFixed(5)),
        dxM: Number((ax - px).toFixed(2)),
        dyM: Number((ay - py).toFixed(2)),
        dist
      };
    }
  }
  return best;
}

// 为歇脚点计算锚定信息（绑定 vertexIds，便于路段插删后定位“同一条边”）
export function anchorPoint(coord, geometry) {
  assertBoundedCoord(coord);
  const proj = projectToPath(coord, geometry.coordinates);
  if (!proj) throw badRequest('bad_anchor', '无法锚定到路线');
  if (proj.dist > L.OFFSET_TOL_METERS)
    throw badRequest('point_too_far', '歇脚点离折线过远', { distanceM: Math.round(proj.dist) });
  const ids = geometry.vertexIds;
  return {
    edgeKey: ids[proj.edge] + '>' + ids[proj.edge + 1],
    fromVertex: ids[proj.edge],
    toVertex: ids[proj.edge + 1],
    t: proj.t,
    dxM: proj.dxM,
    dyM: proj.dyM
  };
}

// 依据锚点还原坐标（dxM 沿垂直于边方向，dyM 沿边法向的第二分量；用局部米/度换算）
export function coordFromAnchor(anchor, geometry) {
  const i = geometry.vertexIds.indexOf(anchor.fromVertex);
  const j = geometry.vertexIds.indexOf(anchor.toVertex);
  if (i < 0 || j < 0 || j !== i + 1) return null; // 这条边已不存在或顺序变化
  const a = geometry.coordinates[i];
  const b = geometry.coordinates[j];
  const latMid = toRad((a[1] + b[1]) / 2);
  const mPerDegLng = Math.cos(latMid) * R * Math.PI / 180;
  const mPerDegLat = R * Math.PI / 180;
  const t = anchor.t;
  const px = a[0] + t * (b[0] - a[0]);
  const py = a[1] + t * (b[1] - a[1]);
  // dxM 投影到东西方向，dyM 投影到南北方向（局部近似）
  const lng = Number((px + anchor.dxM / mPerDegLng).toFixed(L.COORD_DECIMALS));
  const lat = Number((py + anchor.dyM / mPerDegLat).toFixed(L.COORD_DECIMALS));
  return [lng, lat];
}

// 边指纹：路段插删时用于判断“同一条边”是否被改动（比较整路线乐观锁之外的分段合并）
export function edgeTags(geometry) {
  const tags = {};
  for (let i = 0; i < geometry.vertexIds.length - 1; i++) {
    const key = geometry.vertexIds[i] + '>' + geometry.vertexIds[i + 1];
    tags[key] = edgeHash(geometry.coordinates[i], geometry.coordinates[i + 1]);
  }
  return tags;
}

function edgeHash(a, b) {
  const h = (s) => {
    let v = 5381;
    for (let i = 0; i < s.length; i++) v = ((v << 5) + v + s.charCodeAt(i)) >>> 0;
    return v.toString(36);
  };
  return h(a.join(',') + '|' + b.join(','));
}
