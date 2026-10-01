import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLineString, findSelfIntersection, anchorPoint, coordFromAnchor,
  edgeTags, meters, projectToPath
} from '../src/geometry.js';

const line = (coords, vertexIds) =>
  parseLineString({ type: 'LineString', coordinates: coords, vertexIds });

test('坐标必须有界：境外/NaN/越界一律拒绝', () => {
  assert.throws(() => parseLineString({ type: 'LineString', coordinates: [[121.47, 31.23], [121.48, NaN]] }),
    /有限数字/);
  assert.throws(() => line([[121.47, 31.23], [200, 31.5]]), /超出允许范围/);
  assert.throws(() => line([[121.47, 31.23], [0, 0]]), /超出允许范围/);
  assert.throws(() => line([[121.47, 31.23]]), /至少需要/);
});

test('复杂度受限：顶点数上限与退化边', () => {
  const coords = Array.from({ length: 501 }, (_, i) => [121 + i * 0.001, 31 + (i % 2) * 0.01]);
  assert.throws(() => line(coords), /最多 500/);
  assert.throws(() => line([[121.47, 31.23], [121.47, 31.23]]), /重合或过短/);
});

test('非 GeoJSON LineString 被拒', () => {
  assert.throws(() => parseLineString({ type: 'Point', coordinates: [121, 31] }), /LineString/);
  assert.throws(() => parseLineString({ type: 'LineString', coordinates: 'nope' }), /coordinates/);
});

test('自交检测：蝴蝶结折线必须报错并给出交点边', () => {
  // 两条非相邻边在中部交叉
  const coords = [[121.00, 31.00], [121.02, 31.02], [121.02, 31.00], [121.00, 31.02]];
  const hit = findSelfIntersection(coords);
  assert.ok(hit, '应检测到自交');
  assert.deepEqual(hit.edges, [0, 2]);
  assert.throws(() => line(coords), /自相交/);
});

test('正常折线通过且补全稳定 vertexIds', () => {
  const g = line([[121.470, 31.230], [121.480, 31.235], [121.490, 31.230]]);
  assert.equal(g.vertexIds.length, 3);
  assert.match(g.vertexIds[0], /^v/);
  const g2 = line([[121.470, 31.230], [121.480, 31.235]], ['va', 'vb']);
  assert.deepEqual(g2.vertexIds, ['va', 'vb']);
  assert.throws(() => line([[121.470, 31.230], [121.480, 31.235]], ['va', 'va']), /顶点 id/);
});

test('歇脚点锚定到最近边，并可往返还原', () => {
  const g = line([[121.000, 31.000], [121.010, 31.000], [121.020, 31.000]]);
  const coord = [121.005, 31.0002]; // 第 0 条边北侧约 22m（在容忍距离内）
  const anchor = anchorPoint(coord, g);
  assert.equal(anchor.fromVertex, g.vertexIds[0]);
  assert.equal(anchor.toVertex, g.vertexIds[1]);
  assert.ok(anchor.t > 0.4 && anchor.t < 0.6);
  const back = coordFromAnchor(anchor, g);
  assert.ok(meters(coord, back) < 3, `往返误差应很小: ${meters(coord, back)}m`);
});

test('歇脚点离折线过远被拒', () => {
  const g = line([[121.000, 31.000], [121.010, 31.000]]);
  assert.throws(() => anchorPoint([121.005, 31.02], g), /离折线过远/);
});

test('边指纹在坐标变化后改变', () => {
  const g = line([[121.0, 31.0], [121.01, 31.0], [121.02, 31.0]], ['va', 'vb', 'vc']);
  const before = edgeTags(g);
  const moved = line([[121.0, 31.0], [121.012, 31.0], [121.02, 31.0]], ['va', 'vb', 'vc']);
  const after = edgeTags(moved);
  assert.notEqual(before['va>vb'], after['va>vb']);
  // 移动中间顶点会同时影响与之相接的两条边
  assert.notEqual(before['vb>vc'], after['vb>vc']);
  // 只移动末端顶点时，远端的边保持不变
  const movedEnd = line([[121.0, 31.0], [121.01, 31.0], [121.02, 31.001]], ['va', 'vb', 'vc']);
  const afterEnd = edgeTags(movedEnd);
  assert.equal(before['va>vb'], afterEnd['va>vb']);
  assert.notEqual(before['vb>vc'], afterEnd['vb>vc']);
});
