import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RangeCache } from '../range-cache.mjs';
import { CATALOG } from '../catalog.mjs';
import { requestArea, gridLayout, selectSource, TerrainService, LIMITS } from '../terrain-service.mjs';
import { createTerrainServer } from '../server.mjs';

const gale = { start: { lat: -4.59, lon: 137.44 }, goal: { lat: -4.68, lon: 137.42 } };

test('source selection: Gale 30m, another region 463m, long route at coarser native resolution', () => {
  assert.equal(selectSource(requestArea(gale)).source.id, 'gale-hrsc-30m-v1');
  assert.equal(selectSource(requestArea({ start: { lat: 18.65, lon: -133.8 }, goal: { lat: 18.7, lon: -133.7 } })).source.id, 'mola-128ppd-v2');
  const selected = selectSource(requestArea({ start: { lat: 0, lon: 20 }, goal: { lat: 12, lon: 32 } }));
  assert.equal(selected.source.id, 'mola-16ppd-v2');
  assert.ok(selected.layout.width * selected.layout.height <= LIMITS.maxCells);
});

test('expansion grows the AOI; invalid/polar/dateline/excessive requests fail before download', () => {
  const a = requestArea(gale), b = requestArea({ ...gale, expansion: 2 });
  assert.ok(b.latMin < a.latMin && b.latMax > a.latMax && b.lonMin < a.lonMin && b.lonMax > a.lonMax);
  for (const input of [{}, { ...gale, expansion: 3 },
    { start: { lat: 80, lon: 0 }, goal: { lat: 70, lon: 0 } },
    { start: { lat: 0, lon: 179 }, goal: { lat: 0, lon: -179 } },
    { start: { lat: 0, lon: 0 }, goal: { lat: 0, lon: 90 } },
    { start: { lat: NaN, lon: 0 }, goal: { lat: 0, lon: 0 } }]) assert.throws(() => requestArea(input));
});

test('byte cache deduplicates, persists offline and rejects incomplete reads', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'peixonautas-range-'));
  try {
    let calls = 0;
    const cache = new RangeCache(directory, { transport: async () => { calls++; return Buffer.from([1, 2, 3, 4]); } });
    const [a, b] = await Promise.all([cache.get('fixed-source', 0, 3), cache.get('fixed-source', 0, 3)]);
    assert.deepEqual(a, b); assert.equal(calls, 1);
    const restarted = new RangeCache(directory, { transport: () => { throw new Error('offline'); } });
    assert.deepEqual(await restarted.get('fixed-source', 0, 3), a);
    assert.equal(restarted.hits, 1);
    await assert.rejects(() => new RangeCache(directory, { transport: async () => Buffer.alloc(1) }).get('bad', 0, 3));
    assert.equal((await readdir(directory)).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cache eviction respects the disk budget', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'peixonautas-budget-'));
  try {
    const cache = new RangeCache(directory, { maxBytes: 6, transport: async () => Buffer.alloc(4) });
    await cache.get('one', 0, 3); await cache.get('two', 0, 3);
    assert.equal((await readdir(directory)).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fallback discloses source failure and prepared requests reuse the same area', async () => {
  const service = new TerrainService({});
  let calls = 0;
  service.readHrsc = async () => { throw new Error('offline'); };
  service.readMola = async (source, layout) => { calls++; return Array(layout.width * layout.height).fill(-4000); };
  const result = await service.getTerrain(gale);
  assert.equal(result.source.id, 'mola-128ppd-v2');
  assert.equal(result.selection.fallbackReasons[0].source, 'gale-hrsc-30m-v1');
  assert.ok(result.pixelSizeM > 460 && result.stepXMByRow.every(step => step > 0));
  assert.equal((await service.getTerrain(gale)).cacheHit, true);
  assert.equal(calls, 1);
});

test('MOLA extraction handles four adjacent native tiles with signed meters', async () => {
  const source = CATALOG.find(item => item.ppd === 128);
  const layout = gridLayout(source, { latMin: 43.99, latMax: 44.01, lonMin: 89.99, lonMax: 90.01 });
  const files = new Set();
  const cache = { get: async (url, start, end) => {
    files.add(url);
    const match = url.match(/megt(\d{2})(n|s)(\d{3})hb/);
    assert.ok(match);
    const top = Number(match[1]) * (match[2] === 's' ? -1 : 1), west = Number(match[3]);
    const bytes = Buffer.alloc(end - start + 1);
    for (let offset = 0; offset < bytes.length; offset += 2) {
      const sample = (start + offset) / 2;
      const lat = top - (Math.floor(sample / 11520) + 0.5) / 128;
      const lon = west + (sample % 11520 + 0.5) / 128;
      bytes.writeInt16BE(Math.round(-5000 + lat * 10 + lon), offset);
    }
    return bytes;
  } };
  const result = await new TerrainService(cache).readMola(source, layout);
  assert.equal(files.size, 4);
  for (let y = 0; y < layout.height; y++) for (let x = 0; x < layout.width; x++) {
    const lat = (layout.originY - (y + 0.5) * source.nativeResolutionM) / source.projection.radiusM * 180 / Math.PI;
    const lon = (layout.originX + (x + 0.5) * source.nativeResolutionM) / source.projection.radiusM * 180 / Math.PI;
    assert.equal(result[y * layout.width + x], Math.round(-5000 + lat * 10 + lon));
  }
});

test('all-NoData sources never become flat terrain or a cached successful result', async () => {
  const service = new TerrainService({});
  let calls = 0;
  service.readHrsc = async layout => { calls++; return Array(layout.width * layout.height).fill(null); };
  service.readMola = async (source, layout) => { calls++; return Array(layout.width * layout.height).fill(null); };
  await assert.rejects(() => service.getTerrain(gale), error => error.status === 502);
  assert.equal(service.prepared.size, 0);
  await assert.rejects(() => service.getTerrain(gale));
  assert.equal(calls, 6);
});

test('HTTP API validates JSON and origin, hides workspace files and exposes catalog/terrain', async () => {
  const service = { cache: {}, getTerrain: async input => ({ requested: requestArea(input), source: 'test-only' }) };
  const server = createTerrainServer({ service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await (await fetch(base + '/api/health')).json()).service, 'peixonautas-terrain');
    assert.equal((await fetch(base + '/.git/config')).status, 403);
    assert.equal((await fetch(base + '/tools/terrain/server.mjs')).status, 403);
    assert.equal((await fetch(base + '/api/terrain', { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await fetch(base + '/api/terrain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
    const response = await fetch(base + '/api/terrain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gale) });
    assert.equal(response.status, 200); assert.equal((await response.json()).source, 'test-only');
    assert.equal((await fetch(base + '/api/health', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
