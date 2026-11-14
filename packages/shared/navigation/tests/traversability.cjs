const test = require('node:test');
const assert = require('node:assert/strict');
const nav = require('../planner.js');
function grid() {
  return { width: 15, height: 11, stepXM: 30, stepYM: 30, elevations: new Float32Array(165),
    pixelSizeM: 30, originX: 0, originY: 330,
    projection: { radiusM: 3396190, centralLonDeg: 0, originLatDeg: 0, standardParallelDeg: 0 } };
}
function area(g, type, x0, y0, x1, y1, id = type) {
  return { id, type, label: 'Manual', ring: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => {
    const p = nav.cellToLatLon(g, { x: x - 0.5, y: y - 0.5 });
    return [p.lon, p.lat];
  }) };
}
const distanceOnly = { distance: 1, slope: 0, ascent: 0, terrain: 1 };
const policy = { enabled: true, unknownPolicy: 'allow', marginM: 0 };

test('disabled layer preserves the old route even with a wall annotation', () => {
  const g = grid(); g.annotations = [area(g, 'blocked', 7.4, -1, 7.6, 12)];
  const a = { x: 2, y: 5 }, b = { x: 12, y: 5 };
  const baseline = nav.planRoute(g, a, b, distanceOnly);
  g.traversability = { ...policy, enabled: false };
  assert.equal(nav.planRoute(g, a, b, distanceOnly).cost, baseline.cost);
});

test('thin polygons touching cells block travel even when no cell center is inside', () => {
  const g = grid(); g.annotations = [area(g, 'blocked', 7.1, -1, 7.2, 12)]; g.traversability = policy;
  const raster = nav.rasterizeAnnotations(g, g.annotations, policy);
  assert.equal(raster.blocked[5 * g.width + 7], 1);
  assert.equal(nav.planRoute(g, { x: 2, y: 5 }, { x: 12, y: 5 }, { ...distanceOnly, terrain: 0 }).status, 'no-path');
});

test('blocked polygons take precedence over normal polygons, independent of order and weight', () => {
  const g = grid();
  const blocked = area(g, 'blocked', 7.2, 4.2, 7.8, 6.8), normal = area(g, 'normal', -1, -1, 16, 12);
  const first = nav.rasterizeAnnotations(g, [blocked, normal], policy);
  const second = nav.rasterizeAnnotations(g, [normal, blocked], policy);
  assert.deepEqual(first.blocked, second.blocked);
  g.annotations = [normal, blocked]; g.traversability = policy;
  const r = nav.planRoute(g, { x: 2, y: 5 }, { x: 12, y: 5 }, { ...distanceOnly, terrain: 0 });
  assert.equal(r.status, 'ok');
  assert.ok(r.distanceM > 300);
  assert.ok(r.cells.every(c => !first.blocked[c.y * g.width + c.x]));
});

test('meter-based margins grow conservatively without changing terrain gradients', () => {
  const g = grid(); const polygons = [area(g, 'blocked', 7.2, 5.2, 7.8, 5.8)];
  const small = nav.rasterizeAnnotations(g, polygons, policy);
  const large = nav.rasterizeAnnotations(g, polygons, { ...policy, marginM: 60 });
  assert.ok(large.blocked.reduce((a, b) => a + b, 0) > small.blocked.reduce((a, b) => a + b, 0));
  assert.equal(large.blocked[5 * g.width + 5], 1);
  assert.equal(small.blocked[5 * g.width + 5], 0);
  assert.deepEqual(nav.prepareGrid({ ...g, ...large }).slopes, nav.prepareGrid(g).slopes);
});

test('difficult terrain produces a longer route when weighted; terrain weight zero restores shortest path', () => {
  const g = grid(); g.annotations = [area(g, 'difficult', 6.1, 3.1, 8.9, 7.9)];
  g.traversability = { ...policy, difficultCost: 10 };
  const a = { x: 2, y: 5 }, b = { x: 12, y: 5 };
  const short = nav.planRoute(g, a, b, { ...distanceOnly, terrain: 0 });
  const gentle = nav.planRoute(g, a, b, distanceOnly);
  assert.equal(gentle.status, 'ok'); assert.ok(gentle.distanceM > short.distanceM);
  assert.equal(short.costParts.terrain, 0); assert.equal(gentle.costParts.terrain, 0);
});

test('terrain penalty is integrated per meter and reported in the cost breakdown', () => {
  const g = grid(); g.annotations = [area(g, 'difficult', -1, -1, 16, 12)];
  g.traversability = { ...policy, difficultCost: 3 };
  const r = nav.planRoute(g, { x: 2, y: 5 }, { x: 12, y: 5 }, { ...distanceOnly, terrain: 2 });
  assert.equal(r.distanceM, 300); assert.equal(r.costParts.terrain, 1800); assert.equal(r.cost, 2100);
  assert.equal(r.traversability.classDistanceM.difficult, 300);
  assert.equal(r.cost, Object.values(r.costParts).reduce((a, b) => a + b, 0));
});

test('unclassified terrain is unknown and allow/penalize/block are distinct policies', () => {
  const g = grid(); const a = { x: 2, y: 5 }, b = { x: 12, y: 5 };
  g.traversability = { ...policy, unknownPolicy: 'allow' };
  const allowed = nav.planRoute(g, a, b, distanceOnly);
  g.traversability = { ...policy, unknownPolicy: 'penalize', unknownCost: 2 };
  const penalized = nav.planRoute(g, a, b, distanceOnly);
  assert.equal(penalized.cost, allowed.cost + 600);
  assert.equal(penalized.traversability.classDistanceM.unknown, 300);
  g.traversability = { ...policy, unknownPolicy: 'block' };
  assert.equal(nav.planRoute(g, a, b, { ...distanceOnly, terrain: 0 }).status, 'invalid-endpoint');
  g.annotations = [area(g, 'normal', 1.1, 4.1, 13.9, 5.9)];
  assert.equal(nav.planRoute(g, a, b, distanceOnly).status, 'ok');
});

test('unknown explicit polygons override a normal classification; overlapping soft costs use the maximum', () => {
  const g = grid(); const normal = area(g, 'normal', -1, -1, 16, 12);
  const unknown = area(g, 'unknown', 5.1, 4.1, 9.9, 6.9);
  const difficult = area(g, 'difficult', 6.1, 4.1, 8.9, 6.9);
  const r = nav.rasterizeAnnotations(g, [normal, difficult, unknown], { ...policy, unknownPolicy: 'penalize', unknownCost: 9 });
  assert.equal(r.terrainCostPerM[5 * g.width + 7], 9);
  assert.equal(r.terrainCostPerM[2 * g.width + 2], 0);
});

test('normal polygons never convert NoData into traversable elevation', () => {
  const g = grid(); g.elevations[5 * g.width + 7] = NaN;
  g.annotations = [area(g, 'normal', -1, -1, 16, 12)]; g.traversability = policy;
  assert.equal(nav.planRoute(g, { x: 7, y: 5 }, { x: 12, y: 5 }).status, 'invalid-endpoint');
});

test('out-of-AOI areas are ignored while classification is rerasterized on another grid', () => {
  const g = grid(); const polygons = [area(g, 'blocked', 20, 20, 21, 21)];
  assert.equal(nav.rasterizeAnnotations(g, polygons, policy).blocked.some(Boolean), false);
  const fine = grid(), coarse = { ...fine, width: 5, height: 4, pixelSizeM: 90, stepXM: 90, stepYM: 90, elevations: new Float32Array(20) };
  const obstacle = [area(fine, 'blocked', 7.1, 5.1, 7.2, 5.2)];
  assert.ok(nav.rasterizeAnnotations(fine, obstacle, policy).blocked.some(Boolean));
  assert.ok(nav.rasterizeAnnotations(coarse, obstacle, policy).blocked.some(Boolean));
});

test('invalid geometry, duplicate IDs, non-finite and negative costs fail explicitly', () => {
  const g = grid(); const a = area(g, 'normal', 1, 1, 2, 2);
  assert.throws(() => nav.validateAnnotations([a, a]));
  assert.throws(() => nav.validateAnnotations([{ ...a, ring: [[0, 0], [1, 1], [0, 1], [1, 0]] }]));
  assert.throws(() => nav.validateAnnotations([{ ...a, ring: [[NaN, 0], [1, 1], [2, 0]] }]));
  assert.throws(() => nav.normalizeTraversability({ unknownCost: -1 }));
  assert.throws(() => nav.normalizeTraversability({ marginM: Infinity }));
  assert.throws(() => nav.planRoute(g, { x: 1, y: 1 }, { x: 2, y: 2 }, { terrain: -1 }));
});
