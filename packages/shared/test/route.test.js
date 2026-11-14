import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRoute, sampleMission, isBlocked } from '../src/index.js';

test('a rota de exemplo chega ao destino sem passar por perigos', () => {
  const { terrain, start, goal } = sampleMission;
  const path = planRoute(terrain, start, goal);
  assert.ok(path.length > 0);
  assert.deepEqual(path.at(-1), goal);
  for (const p of path) assert.equal(isBlocked(terrain, p.x, p.y), false);
});
