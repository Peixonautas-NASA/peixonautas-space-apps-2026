import { createTerrain } from './terrain.js';

// Terreno sintético 20x20 (células de 10 m) com uma cratera ao centro, só para a demo.
const W = 20, H = 20;
const heights = new Float32Array(W * H);
const hazards = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const r = Math.hypot(x - 10, y - 10);
  heights[y * W + x] = r < 4 ? -8 + r : 0;
  if (r < 2) hazards[y * W + x] = 1;
}

export const sampleMission = {
  name: 'Demo: contornar cratera',
  terrain: createTerrain({ width: W, height: H, cellSize: 10, heights, hazards }),
  start: { x: 1, y: 10 },
  goal: { x: 18, y: 10 },
};
