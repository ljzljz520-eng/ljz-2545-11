import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLineString, edgeTags, coordFromAnchor } from '../src/geometry.js';
import { applyVertexOps, touchedEdges, detectEdgeConflicts, relinkRestPoints } from '../src/merge.js';

const base = () => parseLineString({
  type: 'LineString',
  coordinates: [[121.0, 31.0], [121.01, 31.0], [121.02, 31.0], [121.03, 31.0]],
  vertexIds: ['v1', 'v2', 'v3', 'v4']
});

test('顶点插入/移动/删除按稳定 id 生效', () => {
  const g = base();
  const out = applyVertexOps(g, [
    { type: 'insert', after: 'v2', vertexId: 'v9', coord: [121.015, 31.002] },
    { type: 'move', vertexId: 'v3', coord: [121.021, 31.0] }
  ]);
  assert.deepEqual(out.vertexIds, ['v1', 'v2', 'v9', 'v3', 'v4']);
  assert.deepEqual(out.coordinates[3], [121.021, 31.0]);
  const removed = applyVertexOps(g, [{ type: 'remove', vertexId: 'v2' }]);
  assert.deepEqual(removed.vertexIds, ['v1', 'v3', 'v4']);
});

test('删除到少于 2 个顶点会被拒；引用已删顶点报 stale', () => {
  const g2 = parseLineString({ type: 'LineString', coordinates: [[121, 31], [121.01, 31]], vertexIds: ['va', 'vb'] });
  assert.throws(() => applyVertexOps(g2, [{ type: 'remove', vertexId: 'va' }]), /collapse/);
  const g = base();
  const once = applyVertexOps(g, [{ type: 'remove', vertexId: 'v2' }]);
  assert.throws(() => applyVertexOps(once, [{ type: 'move', vertexId: 'v2', coord: [121, 31] }]), /v2/);
});

test('同一路段并发编辑：边指纹不一致即冲突，不同路段可合并', () => {
  const g = base();
  const baseTags = edgeTags(g);
  // A 把 v2 挪了 -> va>vb / vb>vc 变
  const movedA = parseLineString({
    type: 'LineString',
    coordinates: [[121.0, 31.0], [121.011, 31.0], [121.02, 31.0], [121.03, 31.0]],
    vertexIds: ['v1', 'v2', 'v3', 'v4']
  });
  const tagsA = edgeTags(movedA);
  const touchFront = touchedEdges(g, [{ type: 'move', vertexId: 'v2' }]);
  assert.equal(detectEdgeConflicts(baseTags, tagsA, touchFront).length, 2);
  // B 只动后段 v4，与 A 的前段编辑不冲突
  const touchBack = touchedEdges(g, [{ type: 'move', vertexId: 'v4' }]);
  assert.deepEqual(detectEdgeConflicts(baseTags, tagsA, touchBack), []);
  // 整条边被删也算冲突
  const deleted = applyVertexOps(g, [{ type: 'remove', vertexId: 'v3' }]);
  const tagsDel = edgeTags(parseLineString({ type: 'LineString', coordinates: deleted.coordinates, vertexIds: deleted.vertexIds }));
  const conflicts = detectEdgeConflicts(baseTags, tagsDel, new Set(['v2>v3']));
  assert.ok(conflicts.some((c) => c.reason === 'edge_removed'));
});

test('歇脚点：边仍在但改动 -> repositioned；边被删 -> detached', () => {
  const g = base();
  const tagsOld = edgeTags(g);
  // 点挂在 v1-v2 上
  const point = {
    id: 'p1', name: '长椅', coord: [121.005, 31.0001],
    anchor: { edgeKey: 'v1>v2', fromVertex: 'v1', toVertex: 'v2', t: 0.5, dxM: 0, dyM: 11 }
  };
  const moved = parseLineString({
    type: 'LineString',
    coordinates: [[121.0, 31.0], [121.012, 31.0], [121.02, 31.0], [121.03, 31.0]],
    vertexIds: ['v1', 'v2', 'v3', 'v4']
  });
  let r = relinkRestPoints([point], tagsOld, edgeTags(moved), moved, coordFromAnchor);
  assert.equal(r[0].state, 'repositioned');
  assert.ok(r[0].coord);

  const cut = applyVertexOps(g, [{ type: 'remove', vertexId: 'v2' }]);
  const cutG = parseLineString({ type: 'LineString', coordinates: cut.coordinates, vertexIds: cut.vertexIds });
  r = relinkRestPoints([point], tagsOld, edgeTags(cutG), cutG, coordFromAnchor);
  assert.equal(r[0].state, 'detached');
  assert.equal(r[0].coord, null);

  // 未触及的边 -> attached
  const movedEnd = parseLineString({
    type: 'LineString',
    coordinates: [[121.0, 31.0], [121.01, 31.0], [121.02, 31.0], [121.031, 31.0]],
    vertexIds: ['v1', 'v2', 'v3', 'v4']
  });
  r = relinkRestPoints([point], tagsOld, edgeTags(movedEnd), movedEnd, coordFromAnchor);
  assert.equal(r[0].state, 'attached');
});
