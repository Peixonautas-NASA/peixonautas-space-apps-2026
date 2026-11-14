import { isBlocked, slopeDeg } from './terrain.js';

const NEIGHBORS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

/**
 * Planejamento de rota A* sobre a grade de terreno.
 * Evita células com perigo e inclinações acima de maxSlopeDeg.
 * Retorna a lista de células {x, y} do início ao destino, ou [] se não houver caminho.
 */
export function planRoute(terrain, start, goal, { maxSlopeDeg = 25, slopeWeight = 0.05 } = {}) {
  const key = (p) => p.y * terrain.width + p.x;
  const h = (p) => Math.hypot(goal.x - p.x, goal.y - p.y) * terrain.cellSize;
  const open = new Map([[key(start), { ...start, g: 0, f: h(start) }]]);
  const came = new Map();
  const gScore = new Map([[key(start), 0]]);

  while (open.size) {
    let cur = null;
    for (const n of open.values()) if (!cur || n.f < cur.f) cur = n;
    if (cur.x === goal.x && cur.y === goal.y) {
      const path = [{ x: cur.x, y: cur.y }];
      let k = key(cur);
      while (came.has(k)) { const p = came.get(k); path.unshift(p); k = key(p); }
      return path;
    }
    open.delete(key(cur));
    for (const [dx, dy] of NEIGHBORS) {
      const nb = { x: cur.x + dx, y: cur.y + dy };
      if (isBlocked(terrain, nb.x, nb.y)) continue;
      const slope = slopeDeg(terrain, cur, nb);
      if (slope > maxSlopeDeg) continue;
      const step = Math.hypot(dx, dy) * terrain.cellSize * (1 + slope * slopeWeight);
      const g = cur.g + step;
      if (g < (gScore.get(key(nb)) ?? Infinity)) {
        gScore.set(key(nb), g);
        came.set(key(nb), { x: cur.x, y: cur.y });
        open.set(key(nb), { ...nb, g, f: g + h(nb) });
      }
    }
  }
  return [];
}

/** Distância total da rota em metros. */
export function routeLength(terrain, path) {
  let d = 0;
  for (let i = 1; i < path.length; i++)
    d += Math.hypot(path[i].x - path[i-1].x, path[i].y - path[i-1].y) * terrain.cellSize;
  return d;
}
