const test = require('node:test');
const assert = require('node:assert/strict');
const nav = require('../planner.js');
const weights = { distance: 1, slope: 0, ascent: 0 };
function grid() {
  return { width: 9, height: 9, stepXM: 30, stepYM: 30, pixelSizeM: 30,
    originX: 0, originY: 270, projection: { radiusM: 3396190, centralLonDeg: 0, originLatDeg: 0, standardParallelDeg: 0 },
    elevations: new Float32Array(81) };
}
function raster(field, values) {
  const deg = 270 / 3396190 * 180 / Math.PI;
  return { schemaVersion: 1, planet: 'Mars', width: 9, height: 9,
    quantity: { radiation: 'radiationDoseEquivalentRate', temperature: 'surfaceTemperature', magnetism: 'magneticFieldMagnitude' }[field],
    unit: { radiation: 'uSv/h', temperature: 'degC', magnetism: 'nT' }[field],
    bounds: { latMin: 0, latMax: deg, lonMin: 0, lonMax: deg }, values,
    source: { kind: 'scenario', title: 'Synthetic test', url: '', temporalContext: 'Static test', reference: 'surface', resolutionM: 30 } };
}
const a = { x: 0, y: 4 }, b = { x: 8, y: 4 };
const uniform = (field, value, extra = {}) => ({ ...extra, layers: { [field]: { mode: 'uniform', value } } });
test('zero environmental weights preserve the baseline even with missing environmental data', () => {
  const g = grid(), base = nav.planRoute(g, a, b, weights);
  g.environment = { layers: { radiation: { mode: 'raster', raster: raster('radiation', Array(81).fill(null)) } } };
  assert.deepEqual(nav.planRoute(g, a, b, weights), base);
});
test('dose, duration and cost integrate rate over constant travel time', () => {
  const g = grid(); g.stepXM = 450;
  g.environment = uniform('radiation', 10);
  const r = nav.planRoute(g, a, b, { ...weights, radiation: 2 });
  assert.equal(r.environment.durationHours, 1);
  assert.equal(r.environment.doseUSv, 10);
  assert.ok(Math.abs(r.costParts.radiation - 200) < 1e-8);
  g.environment.speedMps = 2;
  const faster = nav.planRoute(g, a, b, { ...weights, radiation: 2 });
  assert.equal(faster.environment.doseUSv, 5);
  assert.equal(faster.environment.durationHours, 0.5);
});
test('thermal band penalizes cold and heat symmetrically; magnetic threshold never changes dose', () => {
  const g = grid();
  const cost = value => { g.environment = uniform('temperature', value); return nav.planRoute(g, a, b, { ...weights, temperature: 1 }).costParts.temperature; };
  assert.equal(cost(-60), 0);
  assert.ok(cost(-100) > 0); assert.equal(cost(-100), cost(0));
  g.environment = { layers: { radiation: { mode: 'uniform', value: 10 }, magnetism: { mode: 'uniform', value: 200 } } };
  const low = nav.planRoute(g, a, b, { ...weights, radiation: 1, magnetism: 1 });
  g.environment.layers.magnetism.value = 5000;
  const high = nav.planRoute(g, a, b, { ...weights, radiation: 1, magnetism: 1 });
  assert.equal(low.costParts.magnetism, 0); assert.ok(high.costParts.magnetism > 0);
  assert.equal(low.environment.doseUSv, high.environment.doseUSv);
});
for (const [field, normal, hot] of [['radiation', 0, 1000], ['temperature', -60, -200], ['magnetism', 0, 100000]]) {
  test(field + ' raster hotspot causes a spatial detour with conserved cost', () => {
    const g = grid();
    g.environment = { layers: { [field]: { mode: 'raster', raster: raster(field, Array.from({ length: 81 }, (_, i) =>
      i % 9 >= 3 && i % 9 <= 5 && Math.floor(i / 9) >= 3 && Math.floor(i / 9) <= 5 ? hot : normal)) } } };
    const r = nav.planRoute(g, a, b, { ...weights, [field]: 100 });
    assert.equal(r.status, 'ok'); assert.ok(r.distanceM > 240);
    assert.ok(!r.cells.some(c => c.x >= 3 && c.x <= 5 && c.y >= 3 && c.y <= 5));
    assert.ok(Math.abs(r.cost - Object.values(r.costParts).reduce((x, y) => x + y, 0)) < 1e-7);
  });
}
test('NoData blocks endpoints and corridors instead of providing free travel', () => {
  const g = grid(), data = raster('radiation', Array(81).fill(0));
  g.environment = { layers: { radiation: { mode: 'raster', raster: data } } };
  data.values[36] = null;
  assert.equal(nav.planRoute(g, a, b, { ...weights, radiation: 1 }).status, 'environment-data-missing');
  data.values[36] = 0;
  for (let y = 0; y < 9; y++) data.values[y * 9 + 4] = null;
  assert.equal(nav.planRoute(g, a, b, { ...weights, radiation: 1 }).status, 'no-path');
  data.bounds.lonMin += 0.001;
  assert.equal(nav.planRoute(g, a, b, { ...weights, radiation: 1 }).status, 'environment-data-missing');
});
test('units, provenance, surface reference and physical values are validated', () => {
  const valid = raster('radiation', Array(81).fill(10));
  for (const invalid of [{ ...valid, planet: 'Earth' }, { ...valid, unit: 'Gy' },
    { ...valid, source: { ...valid.source, reference: '130km' } }, { ...valid, source: {} },
    { ...valid, values: Array(81).fill(-1) }]) assert.throws(() => nav.validateEnvironmentRaster(invalid, 'radiation'));
  for (const setting of [{ speedMps: 0 }, { doseReferenceUSv: 0 }, { temperatureMinC: -300 }]) assert.throws(() => nav.normalizeEnvironment(setting));
  const g = grid(); g.environment = uniform('radiation', 10);
  assert.throws(() => nav.planRoute(g, a, b, { ...weights, radiation: -1 }));
});
test('uniform mode reports scenario provenance even when an unused raster is retained', () => {
  const g = grid(); g.environment = uniform('radiation', 10);
  g.environment.layers.radiation.raster = raster('radiation', Array(81).fill(20));
  const r = nav.planRoute(g, a, b, { ...weights, radiation: 1 });
  assert.equal(r.environment.layers.radiation.provenance, 'scenario-not-observation');
  assert.equal(r.environment.layers.radiation.effectiveResolutionM, null);
});
test('coarse environmental rasters retain their spatial support instead of claiming DTM detail', () => {
  const g = grid(), data = raster('radiation', [10]);
  data.width = 1; data.height = 1; data.source.resolutionM = 1;
  g.environment = { layers: { radiation: { mode: 'raster', raster: data } } };
  const r = nav.planRoute(g, a, b, { ...weights, radiation: 1 });
  assert.ok(r.environment.layers.radiation.effectiveResolutionM >= 269.99);
  assert.equal(r.environment.layers.radiation.provenance, 'imported-source-declared-by-user');
});
