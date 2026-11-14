const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nav = require('../planner.js');
const flat = (w = 9, h = 9) => ({ width: w, height: h, stepXM: 30, stepYM: 30, elevations: new Float32Array(w * h) });
const distanceOnly = { distance: 1, slope: 0, ascent: 0, maxSlopeDeg: 60 };

test('flat grid has the exact eight-neighbor shortest distance and conserved cost', () => {
  const r = nav.planRoute(flat(), { x: 0, y: 0 }, { x: 8, y: 5 }, distanceOnly);
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.distanceM - (5 * Math.SQRT2 + 3) * 30) < 1e-8);
  assert.equal(r.ascentM, 0);
  assert.equal(r.descentM, 0);
  assert.ok(Math.abs(r.cost - Object.values(r.costParts).reduce((a, b) => a + b, 0)) < 1e-8);
});

test('high slope/ascent weights choose a longer, flatter route around a hill', () => {
  const grid = flat();
  grid.elevations[4 * 9 + 4] = 10;
  const a = { x: 0, y: 4 }, b = { x: 8, y: 4 };
  const short = nav.planRoute(grid, a, b, distanceOnly);
  const gentle = nav.planRoute(grid, a, b, { distance: 1, slope: 20, ascent: 20 });
  assert.equal(gentle.status, 'ok');
  assert.ok(gentle.distanceM > short.distanceM);
  assert.ok(gentle.ascentM < short.ascentM);
  assert.ok(gentle.maxSlopeDeg < short.maxSlopeDeg);
});

test('ascent is directional and slope uses meters rather than display scale', () => {
  const grid = flat();
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) grid.elevations[y * 9 + x] = x * 3;
  const a = { x: 0, y: 4 }, b = { x: 8, y: 4 };
  const up = nav.planRoute(grid, a, b), down = nav.planRoute(grid, b, a);
  assert.equal(up.ascentM, 24);
  assert.equal(down.descentM, 24);
  assert.ok(Math.abs(up.maxSlopeDeg - Math.atan(0.1) * 180 / Math.PI) < 1e-5);
  assert.ok(Math.abs(up.cost - down.cost - 24 * 5) < 1e-5);
  assert.equal(nav.planRoute(grid, a, b, { maxSlopeDeg: 5 }).status, 'invalid-endpoint');
});

test('NoData barrier is impassable; invalid/outside endpoints are distinct', () => {
  const grid = flat();
  for (let y = 0; y < 9; y++) grid.elevations[y * 9 + 4] = NaN;
  assert.equal(nav.planRoute(grid, { x: 1, y: 4 }, { x: 7, y: 4 }).status, 'no-path');
  assert.equal(nav.planRoute(grid, { x: 4, y: 4 }, { x: 7, y: 4 }).status, 'invalid-endpoint');
  assert.equal(nav.planRoute(grid, { x: -1, y: 4 }, { x: 7, y: 4 }).status, 'outside-area');
});

test('diagonal path never cuts the corner of a blocked cell', () => {
  const grid = flat();
  grid.blocked = new Uint8Array(81);
  grid.blocked[4 * 9 + 5] = 1;
  const r = nav.planRoute(grid, { x: 4, y: 4 }, { x: 5, y: 5 }, distanceOnly);
  assert.equal(r.status, 'ok');
  assert.ok(r.distanceM > Math.SQRT2 * 30);
  for (let k = 1; k < r.cells.length; k++) {
    const a = r.cells[k - 1], b = r.cells[k];
    if (a.x !== b.x && a.y !== b.y) {
      assert.equal(grid.blocked[a.y * 9 + b.x], 0);
      assert.equal(grid.blocked[b.y * 9 + a.x], 0);
    }
  }
});

test('invalid weights fail explicitly; same-cell request has zero cost', () => {
  for (const weights of [{ distance: 0 }, { distance: Infinity }, { slope: -1 }, { ascent: NaN }, { maxSlopeDeg: 90 }]) {
    assert.throws(() => nav.planRoute(flat(), { x: 0, y: 0 }, { x: 1, y: 1 }, weights));
  }
  const r = nav.planRoute(flat(), { x: 4, y: 4 }, { x: 4, y: 4 });
  assert.equal(r.cost, 0);
  assert.equal(r.cells.length, 1);
});

// Slow reference search: scan all candidates, with no heuristic or heap.
function dijkstraReference(grid, start, goal, p) {
  const { width: w, height: h, elevations: z, slopes } = nav.prepareGrid(grid);
  const dist = Array(w * h).fill(Infinity), done = new Set();
  dist[start.y * w + start.x] = 0;
  const valid = (x, y) => x >= 0 && x < w && y >= 0 && y < h
    && Number.isFinite(z[y * w + x]) && slopes[y * w + x] <= p.maxSlopeDeg && !grid.blocked?.[y * w + x];
  while (true) {
    let i = -1;
    for (let k = 0; k < dist.length; k++) if (!done.has(k) && Number.isFinite(dist[k]) && (i < 0 || dist[k] < dist[i])) i = k;
    if (i < 0) return Infinity;
    if (i === goal.y * w + goal.x) return dist[i];
    done.add(i);
    const x = i % w, y = Math.floor(i / w);
    for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) {
      if ((xx === x && yy === y) || !valid(xx, yy)) continue;
      if (xx !== x && yy !== y && (!valid(xx, y) || !valid(x, yy))) continue;
      const j = yy * w + xx;
      const stepX = grid.stepXMByRow ? (grid.stepXMByRow[y] + grid.stepXMByRow[yy]) / 2 : grid.stepXM;
      const distance = Math.hypot((xx - x) * stepX, (yy - y) * grid.stepYM);
      const slope = Math.max(slopes[i], slopes[j], Math.atan(Math.abs(z[j] - z[i]) / distance) * 180 / Math.PI);
      if (slope > p.maxSlopeDeg) continue;
      const cost = distance * (p.distance + p.slope * (slope / 15) ** 2) + p.ascent * Math.max(0, z[j] - z[i])
        + distance * (p.terrain ?? 1) * Math.max(grid.terrainCostPerM?.[i] ?? 0, grid.terrainCostPerM?.[j] ?? 0);
      dist[j] = Math.min(dist[j], dist[i] + cost);
    }
  }
}

test('A* agrees with Dijkstra on varied terrain and positive cost weights', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const grid = flat(7, 7);
    if (seed % 2 === 0) grid.stepXMByRow = Array.from({ length: 7 }, (_, y) => 15 + y * 3);
    if (seed % 3 === 0) grid.terrainCostPerM = Float32Array.from({ length: 49 }, (_, i) => (i * seed) % 5);
    for (let i = 0; i < 49; i++) grid.elevations[i] = Math.sin(i * seed) * 6;
    const p = { distance: seed / 10, slope: seed / 3, ascent: seed, maxSlopeDeg: 50 };
    const a = { x: 0, y: 0 }, b = { x: 6, y: 6 };
    const r = nav.planRoute(grid, a, b, p);
    assert.equal(r.status, 'ok');
    assert.ok(Math.abs(r.cost - dijkstraReference(grid, a, b, p)) < 1e-7);
  }
});

test('real Gale crop has valid native data, reversible coordinates and a traversable example', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../../../data/gale/terrain.js'), 'utf8'), context);
  const data = context.GALE_TERRAIN_DATA;
  const grid = { ...data, elevations: Float32Array.from(data.elevations, v => v === null ? NaN : v) };
  assert.equal(grid.pixelSizeM, 30);
  assert.equal(grid.elevations.length, grid.width * grid.height);
  assert.equal(grid.validCount, grid.elevations.length);
  const a = nav.latLonToCell(grid, -4.59, 137.44), b = nav.latLonToCell(grid, -4.68, 137.42);
  const p = nav.cellToLatLon(grid, a);
  assert.deepEqual(nav.latLonToCell(grid, p.lat, p.lon), a);
  const r = nav.planRoute(grid, a, b);
  assert.equal(r.status, 'ok');
  assert.ok(r.distanceM > 5000 && r.distanceM < 8000);
  assert.ok(r.maxSlopeDeg <= 25);
  assert.ok(Math.abs(r.cost - Object.values(r.costParts).reduce((x, y) => x + y, 0)) < 1e-6);
  assert.ok(r.cells.every(c => c.elevationM < -3000 && c.elevationM > -5000));
});
