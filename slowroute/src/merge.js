// 分段合并：路段插删用稳定的 vertex id 表达，不依赖数组下标。
// 与“比较整条路线版本号”的整路线乐观锁不同，这里允许 A 改前段、B 改后段，
// 但两个人同时改同一条边（危险路口）时后到者必须 rebase，不能静默覆盖。

// 纯函数：按序应用顶点操作，返回新的 {coordinates, vertexIds}
export function applyVertexOps(geometry, ops) {
  let coords = geometry.coordinates.map((c) => c.slice());
  let ids = geometry.vertexIds.slice();

  const idxOf = (id) => ids.indexOf(id);
  const assertNumCoord = (c) => {
    if (!Array.isArray(c) || c.length < 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number')
      throw Object.assign(new Error('bad op coordinate'), { code: 'bad_op' });
  };

  for (const op of ops) {
    switch (op.type) {
      case 'insert': {
        // after 缺省表示追加到折线末尾
        assertNumCoord(op.coord);
        let at = coords.length;
        if (op.after) {
          const i = idxOf(op.after);
          if (i < 0) throw missing(op.after);
          at = i + 1;
        }
        const id = op.vertexId;
        if (!id || ids.includes(id)) throw Object.assign(new Error('dup/missing vertexId'), { code: 'bad_vertex_id' });
        coords.splice(at, 0, [op.coord[0], op.coord[1]]);
        ids.splice(at, 0, id);
        break;
      }
      case 'move': {
        const i = idxOf(op.vertexId);
        if (i < 0) throw missing(op.vertexId);
        assertNumCoord(op.coord);
        coords[i] = [op.coord[0], op.coord[1]];
        break;
      }
      case 'remove': {
        const i = idxOf(op.vertexId);
        if (i < 0) throw missing(op.vertexId);
        if (coords.length <= 2)
          throw Object.assign(new Error('would collapse polyline'), { code: 'would_collapse' });
        coords.splice(i, 1);
        ids.splice(i, 1);
        break;
      }
      default:
        throw Object.assign(new Error('unknown op ' + op.type), { code: 'unknown_op' });
    }
  }
  return { coordinates: coords, vertexIds: ids };
}

function missing(id) {
  return Object.assign(new Error('vertex not found: ' + id), { code: 'stale_vertex', vertexId: id });
}

// 计算一次操作触及的边集合（before 状态的边 key）
export function touchedEdges(geometry, ops) {
  const touched = new Set();
  const ids = geometry.vertexIds;
  const addAround = (id) => {
    const i = ids.indexOf(id);
    if (i < 0) return;
    if (i > 0) touched.add(ids[i - 1] + '>' + ids[i]);
    if (i < ids.length - 1) touched.add(ids[i] + '>' + ids[i + 1]);
  };
  for (const op of ops) {
    if (op.after) addAround(op.after);
    if (op.vertexId) addAround(op.vertexId);
  }
  return touched;
}

// 同路段冲突：作者基于 baseTags 编辑；服务端当前 tags 已变，则交集即冲突。
export function detectEdgeConflicts(baseTags, currentTags, touched) {
  const conflicts = [];
  for (const key of touched) {
    if (baseTags[key] !== undefined && currentTags[key] !== undefined && baseTags[key] !== currentTags[key])
      conflicts.push({ edge: key, reason: 'edge_changed' });
    // 整条边被他人删掉
    if (baseTags[key] !== undefined && currentTags[key] === undefined)
      conflicts.push({ edge: key, reason: 'edge_removed' });
  }
  return conflicts;
}

// 歇脚点重定位：路段插删后按 from/to 顶点重新挂到“同一条边”。
// 返回每个点的状态：
//   attached  边仍在且指纹未变
//   repositioned 边仍在但几何变了，已按 t 与垂直偏移自动重定位（需提示作者确认）
//   detached  所属边被删除/重排，点悬空，要求作者重新落点
export function relinkRestPoints(points, oldTags, newTags, newGeometry, coordFromAnchor) {
  const results = [];
  for (const p of points) {
    if (!p.anchor) {
      results.push({ point: p, state: 'detached', coord: p.coord });
      continue;
    }
    const key = p.anchor.edgeKey;
    if (!(key in newTags)) {
      results.push({ point: p, state: 'detached', coord: null });
      continue;
    }
    const coord = coordFromAnchor(p.anchor, newGeometry);
    const changed = oldTags[key] !== undefined && oldTags[key] !== newTags[key];
    results.push({
      point: { ...p, coord: coord || p.coord },
      state: !coord ? 'detached' : changed ? 'repositioned' : 'attached',
      coord
    });
  }
  return results;
}

// 幂等键：离线重送时同一 clientOpId 只生效一次
export function opBatchKey(routeId, clientOpId) {
  return routeId + '#' + clientOpId;
}
