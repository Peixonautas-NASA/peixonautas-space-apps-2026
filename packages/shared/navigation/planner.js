/* Shared, dependency-free planner. Meters internally; no rendering dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PeixonautasNavigation = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function navigationFactory() {
  'use strict';
  const RAD = Math.PI / 180;

  class MinHeap {
    constructor() { this.items = []; }
    push(entry) {
      const a = this.items;
      let i = a.length;
      a.push(entry);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (a[parent].f <= entry.f) break;
        a[i] = a[parent];
        i = parent;
      }
      a[i] = entry;
    }
    pop() {
      const a = this.items, first = a[0], last = a.pop();
      if (a.length) {
        let i = 0;
        while (i * 2 + 1 < a.length) {
          let child = i * 2 + 1;
          if (child + 1 < a.length && a[child + 1].f < a[child].f) child++;
          if (last.f <= a[child].f) break;
          a[i] = a[child];
          i = child;
        }
        a[i] = last;
      }
      return first;
    }
  }

  function validateGrid(grid) {
    if (!grid || !Number.isInteger(grid.width) || !Number.isInteger(grid.height)
        || grid.width < 2 || grid.height < 2 || !(grid.stepXM > 0) || !(grid.stepYM > 0)
        || !Number.isFinite(grid.stepXM) || !Number.isFinite(grid.stepYM)
        || !grid.elevations || grid.elevations.length !== grid.width * grid.height
        || (grid.blocked && grid.blocked.length !== grid.width * grid.height)
        || (grid.stepXMByRow && (grid.stepXMByRow.length !== grid.height
          || !Array.from(grid.stepXMByRow).every(v => Number.isFinite(v) && v > 0)))) {
      throw new Error('Grade de terreno inválida.');
    }
  }

  function prepareGrid(grid) {
    validateGrid(grid);
    const { width: w, height: h, elevations: e, stepXM, stepYM } = grid;
    const slopes = new Float32Array(w * h);
    const valid = i => Number.isFinite(e[i]) && (!grid.blocked || !grid.blocked[i]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!valid(i)) { slopes[i] = Infinity; continue; }
        const left = x > 0 && valid(i - 1) ? i - 1 : i;
        const right = x + 1 < w && valid(i + 1) ? i + 1 : i;
        const up = y > 0 && valid(i - w) ? i - w : i;
        const down = y + 1 < h && valid(i + w) ? i + w : i;
        // Missing support on either axis is unknown, never flat terrain.
        if (left === right || up === down) { slopes[i] = Infinity; continue; }
        const dx = (e[right] - e[left]) / ((right - left) * (grid.stepXMByRow?.[y] ?? stepXM));
        const dy = (e[down] - e[up]) / (((down - up) / w) * stepYM);
        slopes[i] = Math.atan(Math.hypot(dx, dy)) / RAD;
      }
    }
    return { ...grid, slopes };
  }

  function validateOptions(options = {}) {
    const p = { distance: 1, slope: 3, ascent: 5, maxSlopeDeg: 25, ...options };
    if (!Number.isFinite(p.distance) || p.distance <= 0
        || !Number.isFinite(p.slope) || p.slope < 0
        || !Number.isFinite(p.ascent) || p.ascent < 0
        || !Number.isFinite(p.maxSlopeDeg) || p.maxSlopeDeg <= 0 || p.maxSlopeDeg >= 90) {
      throw new Error('Pesos inválidos: distância > 0, demais pesos ≥ 0, limite entre 0° e 90°.');
    }
    return p;
  }

  function planRoute(inputGrid, start, goal, options = {}) {
    const p = validateOptions(options);
    const grid = prepareGrid(inputGrid);
    const { width: w, height: h, elevations: e, slopes, stepXM, stepYM } = grid;
    const n = w * h;
    const rowStep = y => grid.stepXMByRow?.[y] ?? stepXM;
    let minStepX = stepXM;
    if (grid.stepXMByRow) for (const step of grid.stepXMByRow) minStepX = Math.min(minStepX, step);
    const indexOf = cell => cell && Number.isInteger(cell.x) && Number.isInteger(cell.y)
      && cell.x >= 0 && cell.y >= 0 && cell.x < w && cell.y < h ? cell.y * w + cell.x : -1;
    const source = indexOf(start), target = indexOf(goal);
    if (source < 0 || target < 0) return { status: 'outside-area' };
    const passable = i => Number.isFinite(e[i]) && Number.isFinite(slopes[i])
      && slopes[i] <= p.maxSlopeDeg && (!grid.blocked || !grid.blocked[i]);
    if (!passable(source) || !passable(target)) return { status: 'invalid-endpoint' };
    const costs = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    const heuristic = (x, y) => Math.hypot((goal.x - x) * minStepX, (goal.y - y) * stepYM) * p.distance;
    costs[source] = 0;
    heap.push({ i: source, g: 0, f: heuristic(start.x, start.y) });
    let expanded = 0;
    while (heap.items.length) {
      const current = heap.pop();
      const i = current.i;
      if (closed[i] || current.g !== costs[i]) continue;
      closed[i] = 1;
      expanded++;
      if (i === target) {
        const indices = [];
        for (let k = target; k !== -1; k = parent[k]) indices.push(k);
        indices.reverse();
        let distanceM = 0, ascentM = 0, descentM = 0, maxSlopeDeg = 0;
        const cells = indices.map(k => ({ x: k % w, y: Math.floor(k / w), elevationM: e[k] }));
        const parts = { distance: 0, slope: 0, ascent: 0 };
        for (let k = 0; k < indices.length; k++) {
          maxSlopeDeg = Math.max(maxSlopeDeg, slopes[indices[k]]);
          if (!k) continue;
          const a = cells[k - 1], b = cells[k];
          const d = Math.hypot((b.x - a.x) * (rowStep(a.y) + rowStep(b.y)) / 2, (b.y - a.y) * stepYM);
          const dz = b.elevationM - a.elevationM;
          const slope = Math.max(slopes[indices[k - 1]], slopes[indices[k]], Math.atan2(Math.abs(dz), d) / RAD);
          distanceM += d;
          ascentM += Math.max(0, dz);
          descentM += Math.max(0, -dz);
          maxSlopeDeg = Math.max(maxSlopeDeg, slope);
          parts.distance += d * p.distance;
          parts.slope += d * p.slope * (slope / 15) ** 2;
          parts.ascent += Math.max(0, dz) * p.ascent;
        }
        return { status: 'ok', cells, distanceM, ascentM, descentM, maxSlopeDeg,
          cost: costs[target], costParts: parts, expanded, weights: p };
      }
      const x = i % w, y = Math.floor(i / w);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (closed[j] || !passable(j)) continue;
          // Do not squeeze diagonally between blocked or unknown cells.
          if (dx && dy && (!passable(y * w + nx) || !passable(ny * w + x))) continue;
          const d = Math.hypot(dx * (rowStep(y) + rowStep(ny)) / 2, dy * stepYM);
          const dz = e[j] - e[i];
          const slope = Math.max(slopes[i], slopes[j], Math.atan2(Math.abs(dz), d) / RAD);
          if (slope > p.maxSlopeDeg) continue;
          const next = costs[i] + d * (p.distance + p.slope * (slope / 15) ** 2)
            + Math.max(0, dz) * p.ascent;
          if (next >= costs[j]) continue;
          costs[j] = next;
          parent[j] = i;
          heap.push({ i: j, g: next, f: next + heuristic(nx, ny) });
        }
      }
    }
    return { status: 'no-path', expanded };
  }

  function latLonToCell(grid, lat, lon) {
    const p = grid.projection;
    const xm = p.radiusM * (lon - p.centralLonDeg) * RAD * Math.cos(p.standardParallelDeg * RAD);
    const ym = p.radiusM * (lat - p.originLatDeg) * RAD;
    return { x: Math.floor((xm - grid.originX) / grid.pixelSizeM),
      y: Math.floor((grid.originY - ym) / grid.pixelSizeM) };
  }

  function cellToLatLon(grid, cell) {
    const p = grid.projection;
    return {
      lat: p.originLatDeg + (grid.originY - (cell.y + 0.5) * grid.pixelSizeM) / p.radiusM / RAD,
      lon: p.centralLonDeg + (grid.originX + (cell.x + 0.5) * grid.pixelSizeM)
        / (p.radiusM * Math.cos(p.standardParallelDeg * RAD)) / RAD
    };
  }

  function createWorkerSource() {
    // Self-contained Blob worker also works when index.html is opened via file://.
    return '(' + navigationFactory.toString() + ')();';
  }
  const api = { prepareGrid, planRoute, latLonToCell, cellToLatLon, createWorkerSource };
  if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
    globalThis.onmessage = event => {
      const { requestId, grid, start, goal, weights } = event.data;
      try { globalThis.postMessage({ requestId, result: planRoute(grid, start, goal, weights) }); }
      catch (error) { globalThis.postMessage({ requestId, error: error.message }); }
    };
  }
  return api;
});
