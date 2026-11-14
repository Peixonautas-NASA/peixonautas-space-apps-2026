/**
 * Grade de terreno compartilhada pelas três visões.
 * heights: elevação em metros, linha a linha (width * height valores).
 * hazards: opcional, 0 = livre, 1 = proibido.
 */
export function createTerrain({ width, height, cellSize = 1, heights, hazards }) {
  if (heights.length !== width * height) throw new Error('heights tem tamanho errado');
  return { width, height, cellSize, heights, hazards: hazards ?? new Uint8Array(width * height) };
}

export function elevationAt(t, x, y) {
  return t.heights[y * t.width + x];
}

export function isBlocked(t, x, y) {
  return x < 0 || y < 0 || x >= t.width || y >= t.height || t.hazards[y * t.width + x] === 1;
}

/** Inclinação em graus entre duas células vizinhas. */
export function slopeDeg(t, a, b) {
  const dz = elevationAt(t, b.x, b.y) - elevationAt(t, a.x, a.y);
  const dxy = Math.hypot(b.x - a.x, b.y - a.y) * t.cellSize;
  return (Math.atan2(Math.abs(dz), dxy) * 180) / Math.PI;
}
