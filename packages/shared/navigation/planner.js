/* Shared, dependency-free planner. Meters internally; no rendering dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PeixonautasNavigation = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function navigationFactory() {
  'use strict';
  const RAD = Math.PI / 180;

  function normalizeTraversability(policy = {}) {
    const p = { enabled: false, difficultCost: 3, unknownCost: 1, unknownPolicy: 'penalize', marginM: 60, ...policy };
    if (typeof p.enabled !== 'boolean' || !['allow', 'penalize', 'block'].includes(p.unknownPolicy)
        || ![p.difficultCost, p.unknownCost, p.marginM].every(v => Number.isFinite(v) && v >= 0)
        || p.difficultCost > 100 || p.unknownCost > 100 || p.marginM > 10000) {
      throw new Error('Revise os custos e a política de transitabilidade.');
    }
    return p;
  }

  function cross(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
  function onSegment(a, b, p) {
    return Math.abs(cross(a, b, p)) < 1e-10 && p[0] >= Math.min(a[0], b[0]) - 1e-10
      && p[0] <= Math.max(a[0], b[0]) + 1e-10 && p[1] >= Math.min(a[1], b[1]) - 1e-10 && p[1] <= Math.max(a[1], b[1]) + 1e-10;
  }
  function intersects(a, b, c, d) {
    const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
    return (abC * abD < 0 && cdA * cdB < 0) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
  }
  function inside(point, ring) {
    let yes = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if (onSegment(a, b, point)) return true;
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
    }
    return yes;
  }

  function validateAnnotations(areas = []) {
    if (!Array.isArray(areas) || areas.length > 50) throw new Error('Use no máximo 50 áreas manuais.');
    let vertices = 0;
    const ids = new Set();
    return areas.map((area, index) => {
      if (!area || !['blocked', 'difficult', 'normal', 'unknown'].includes(area.type)
          || !Array.isArray(area.ring)) throw new Error('Classificação ou polígono inválido.');
      const ring = area.ring.map(p => {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 75) {
          throw new Error('Coordenadas inválidas na área manual (longitude, latitude de Marte).');
        }
        return [p[0], p[1]];
      });
      if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
      vertices += ring.length;
      if (ring.length < 3 || ring.length > 128 || vertices > 2048) throw new Error('Use 3 a 128 vértices por área e até 2.048 no total.');
      if (Math.max(...ring.map(p => p[0])) - Math.min(...ring.map(p => p[0])) > 180) throw new Error('Áreas no antimeridiano não são suportadas.');
      let surface = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if (a[0] === b[0] && a[1] === b[1]) throw new Error('Remova vértices repetidos.');
        surface += a[0] * b[1] - b[0] * a[1];
        for (let j = i + 1; j < ring.length; j++) {
          if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue;
          if (intersects(a, b, ring[j], ring[(j + 1) % ring.length])) throw new Error('O polígono não pode cruzar a si mesmo.');
        }
      }
      if (Math.abs(surface) < 1e-14) throw new Error('Desenhe uma área com superfície maior que zero.');
      const id = typeof area.id === 'string' && area.id.trim() ? area.id.trim().slice(0, 80) : 'area-' + index;
      if (ids.has(id)) throw new Error('Cada área deve ter um identificador único.');
      ids.add(id);
      return { id,
        label: typeof area.label === 'string' ? area.label.slice(0, 80) : 'Área ' + (index + 1),
        type: area.type, ring, provenance: 'manual-interpretation',
        createdAt: typeof area.createdAt === 'string' ? area.createdAt.slice(0, 40) : null };
    });
  }

  function rasterizeAnnotations(grid, annotations = [], options = {}) {
    validateGrid(grid);
    const policy = normalizeTraversability(options), areas = validateAnnotations(annotations);
    const n = grid.width * grid.height;
    const blocked = grid.blocked ? new Uint8Array(grid.blocked) : new Uint8Array(n);
    const terrainCostPerM = new Float32Array(n), terrainClasses = new Uint8Array(n);
    if (!policy.enabled) return { blocked, terrainCostPerM, terrainClasses, traversabilityInfo: { enabled: false } };
    if (!grid.projection || ![grid.originX, grid.originY, grid.pixelSizeM, grid.projection.radiusM,
      grid.projection.centralLonDeg, grid.projection.originLatDeg, grid.projection.standardParallelDeg].every(Number.isFinite)
      || grid.pixelSizeM <= 0 || grid.projection.radiusM <= 0 || Math.abs(grid.projection.standardParallelDeg) >= 90) {
      throw new Error('A camada manual precisa de uma grade com georreferenciamento válido.');
    }
    const masks = new Uint8Array(n);
    const bits = { normal: 1, unknown: 2, difficult: 4, blocked: 8 };
    let smallestX = grid.stepXM;
    if (grid.stepXMByRow) for (const value of grid.stepXMByRow) smallestX = Math.min(smallestX, value);
    for (const area of areas) {
      const p = grid.projection;
      const ring = area.ring.map(([lon, lat]) => [
        (p.radiusM * (lon - p.centralLonDeg) * RAD * Math.cos(p.standardParallelDeg * RAD) - grid.originX) / grid.pixelSizeM,
        (grid.originY - p.radiusM * (lat - p.originLatDeg) * RAD) / grid.pixelSizeM
      ]);
      const margin = area.type === 'blocked' ? policy.marginM : 0;
      const x0 = Math.max(0, Math.ceil(Math.min(...ring.map(p => p[0])) - margin / smallestX) - 1);
      const x1 = Math.min(grid.width - 1, Math.floor(Math.max(...ring.map(p => p[0])) + margin / smallestX));
      const y0 = Math.max(0, Math.ceil(Math.min(...ring.map(p => p[1])) - margin / grid.stepYM) - 1);
      const y1 = Math.min(grid.height - 1, Math.floor(Math.max(...ring.map(p => p[1])) + margin / grid.stepYM));
      for (let y = y0; y <= y1; y++) {
        const mx = margin / (grid.stepXMByRow?.[y] ?? grid.stepXM), my = margin / grid.stepYM;
        for (let x = x0; x <= x1; x++) {
          const rect = [[x - mx, y - my], [x + 1 + mx, y - my], [x + 1 + mx, y + 1 + my], [x - mx, y + 1 + my]];
          let hit = ring.some(v => v[0] >= rect[0][0] && v[0] <= rect[2][0] && v[1] >= rect[0][1] && v[1] <= rect[2][1])
            || rect.some(v => inside(v, ring));
          if (!hit) for (let i = 0; i < ring.length && !hit; i++) {
            for (let j = 0; j < 4; j++) if (intersects(ring[i], ring[(i + 1) % ring.length], rect[j], rect[(j + 1) % 4])) { hit = true; break; }
          }
          if (hit) masks[y * grid.width + x] |= bits[area.type];
        }
      }
    }
    const counts = { normal: 0, difficult: 0, unknown: 0, blocked: 0 };
    for (let i = 0; i < n; i++) {
      const mask = masks[i] || bits.unknown;
      if (mask & bits.blocked) { blocked[i] = 1; terrainClasses[i] = 4; counts.blocked++; continue; }
      const unknown = Boolean(mask & bits.unknown);
      const unknownCost = unknown && policy.unknownPolicy === 'penalize' ? policy.unknownCost : 0;
      const difficultCost = mask & bits.difficult ? policy.difficultCost : 0;
      terrainCostPerM[i] = Math.max(unknownCost, difficultCost);
      if (unknown && policy.unknownPolicy === 'block') blocked[i] = 1;
      if ((mask & bits.difficult) && difficultCost >= unknownCost) { terrainClasses[i] = 3; counts.difficult++; }
      else if (unknown) { terrainClasses[i] = 2; counts.unknown++; }
      else { terrainClasses[i] = 1; counts.normal++; }
    }
    return { blocked, terrainCostPerM, terrainClasses,
      traversabilityInfo: { enabled: true, policy, areaCount: areas.length, counts, provenance: 'manual-interpretation' } };
  }

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
        || (grid.terrainCostPerM && (grid.terrainCostPerM.length !== grid.width * grid.height
          || !Array.from(grid.terrainCostPerM).every(v => Number.isFinite(v) && v >= 0)))
        || (grid.stepXMByRow && (grid.stepXMByRow.length !== grid.height
          || !Array.from(grid.stepXMByRow).every(v => Number.isFinite(v) && v > 0)))) {
      throw new Error('Grade de terreno inválida.');
    }
  }

  function prepareGrid(grid) {
    validateGrid(grid);
    const { width: w, height: h, elevations: e, stepXM, stepYM } = grid;
    const slopes = new Float32Array(w * h);
    // An annotation blocks travel, not the numerical terrain used for gradients.
    const valid = i => Number.isFinite(e[i]);
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
    const p = { distance: 1, slope: 3, ascent: 5, terrain: 1, maxSlopeDeg: 25, ...options };
    if (!Number.isFinite(p.distance) || p.distance <= 0
        || !Number.isFinite(p.slope) || p.slope < 0
        || !Number.isFinite(p.ascent) || p.ascent < 0
        || !Number.isFinite(p.terrain) || p.terrain < 0
        || !Number.isFinite(p.maxSlopeDeg) || p.maxSlopeDeg <= 0 || p.maxSlopeDeg >= 90) {
      throw new Error('Pesos inválidos: distância > 0, demais pesos ≥ 0, limite entre 0° e 90°.');
    }
    return p;
  }

  function planRoute(inputGrid, start, goal, options = {}) {
    const p = validateOptions(options);
    const constraints = inputGrid.traversability?.enabled
      ? rasterizeAnnotations(inputGrid, inputGrid.annotations, inputGrid.traversability) : null;
    const grid = prepareGrid(constraints ? { ...inputGrid, ...constraints } : inputGrid);
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
        const parts = { distance: 0, slope: 0, ascent: 0, terrain: 0 };
        const classDistanceM = { normal: 0, unknown: 0, difficult: 0 };
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
          parts.terrain += d * p.terrain * Math.max(grid.terrainCostPerM?.[indices[k - 1]] ?? 0, grid.terrainCostPerM?.[indices[k]] ?? 0);
          const category = Math.max(grid.terrainClasses?.[indices[k - 1]] ?? 0, grid.terrainClasses?.[indices[k]] ?? 0);
          if (category) classDistanceM[['', 'normal', 'unknown', 'difficult'][category]] += d;
        }
        return { status: 'ok', cells, distanceM, ascentM, descentM, maxSlopeDeg,
          cost: costs[target], costParts: parts, expanded, weights: p,
          traversability: { ...(grid.traversabilityInfo || { enabled: false }), classDistanceM } };
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
            + Math.max(0, dz) * p.ascent
            + d * p.terrain * Math.max(grid.terrainCostPerM?.[i] ?? 0, grid.terrainCostPerM?.[j] ?? 0);
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
  const api = { prepareGrid, planRoute, latLonToCell, cellToLatLon, createWorkerSource,
    validateAnnotations, normalizeTraversability, rasterizeAnnotations };
  if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
    globalThis.onmessage = event => {
      const { requestId, grid, start, goal, weights } = event.data;
      try { globalThis.postMessage({ requestId, result: planRoute(grid, start, goal, weights) }); }
      catch (error) { globalThis.postMessage({ requestId, error: error.message }); }
    };
  }
  return api;
});
