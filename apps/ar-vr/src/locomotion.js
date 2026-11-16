// Caminhada em primeira pessoa sobre o terreno.
//  - Caminhada livre: segurar o botão "Andar" (ou a tela, no estéreo) anda para onde você olha.
//    Teclado (PC): W/S ou setas = frente/trás, A/D = lados, Shift = 5x mais rápido.
//    Andar livre PAUSA o piloto automático (senão ele puxaria você de volta para a rota).
//  - Piloto automático: segue a rota sozinho; o botão de play retoma (voltando para a rota).
// A câmera fica sempre a EYE_HEIGHT do chão, com suavização vertical para não "pular" degraus.
import * as THREE from 'three';

export const EYE_HEIGHT = 1.7;

export const SPEEDS = [
  { label: 'Walking', v: 1.4 },
  { label: 'Rover', v: 15 },
  { label: 'Fast', v: 300 },
];

export class Walker {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.speedIndex = 0;
    this.keys = new Set();
    this.holding = false;
    this.walked = 0; // metros percorridos
    this.auto = true; // piloto automático ligado
    this.path = null; // pontos da rota com distância acumulada .d
    this.progress = 0; // metros já percorridos ao longo da rota
    this.finished = false;
    this.onArrive = null;
    this._e = new THREE.Euler();
    const typing = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    window.addEventListener('keydown', (e) => !typing(e) && this.keys.add(e.key.toLowerCase()));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.holding = false;
    });
  }

  get speed() {
    return SPEEDS[this.speedIndex];
  }
  cycleSpeed() {
    this.speedIndex = (this.speedIndex + 1) % SPEEDS.length;
    return this.speed;
  }
  get total() {
    return this.path ? this.path[this.path.length - 1].d : 0;
  }

  setPath(path) {
    this.path = path;
    this.progress = 0;
    this.finished = false;
  }
  /** Liga um elemento como "segure para andar". */
  bindHold(el) {
    const down = (e) => {
      e.stopPropagation();
      if (e.pointerId !== undefined) el.setPointerCapture?.(e.pointerId);
      this.holding = true;
      el.classList.add('active');
    };
    const up = () => {
      this.holding = false;
      el.classList.remove('active');
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  /** Volta para o início da rota e retoma a caminhada. */
  restart() {
    if (!this.path) return;
    const p = this.camera.position;
    p.x = this.path[0].x;
    p.z = this.path[0].z;
    this.progress = 0;
    this.finished = false;
    this.auto = true;
    this.snapToGround();
  }

  /** Ponto da rota a `d` metros do início (interpolado). */
  pointAt(d) {
    const path = this.path;
    if (d <= 0) return path[0];
    if (d >= this.total) return path[path.length - 1];
    let lo = 0;
    let hi = path.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (path[mid].d <= d) lo = mid;
      else hi = mid;
    }
    const a = path[lo];
    const b = path[hi];
    const t = (d - a.d) / (b.d - a.d || 1);
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, d };
  }

  /** Distância ao longo da rota do ponto mais próximo de (x, z), sem voltar muito para trás. */
  _project(x, z) {
    const path = this.path;
    let best = this.progress;
    let bestDist = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      if (b.d < this.progress - 40) continue;
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const l2 = vx * vx + vz * vz || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / l2));
      const px = a.x + vx * t;
      const pz = a.z + vz * t;
      const dist = (x - px) ** 2 + (z - pz) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = a.d + (b.d - a.d) * t;
      }
    }
    return best;
  }

  snapToGround() {
    const p = this.camera.position;
    p.y = this.world.heightAt(p.x, p.z) + EYE_HEIGHT;
  }

  update(dt) {
    const k = this.keys;
    const fwd = (this.holding || k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const side = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    const p = this.camera.position;
    const ox = p.x;
    const oz = p.z;
    const boost = k.has('shift') ? 5 : 1;
    const manual = fwd !== 0 || side !== 0;

    if (manual) {
      this.auto = false; // caminhada livre: o piloto automático fica pausado até apertar play
      // rumo pela rotação em Y (funciona mesmo olhando para os pés)
      const yaw = this._e.setFromQuaternion(this.camera.quaternion, 'YXZ').y;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const mx = fx * fwd - fz * side;
      const mz = fz * fwd + fx * side;
      const len = Math.hypot(mx, mz) || 1;
      const step = this.speed.v * boost * dt;
      p.x += (mx / len) * step;
      p.z += (mz / len) * step;
    } else if (this.auto && this.path && !this.finished) {
      // "Cenoura" à frente na rota: corta pouco as curvas e reencontra a rota se a pessoa saiu dela
      const v = this.speed.v * boost;
      const target = this.pointAt(Math.min(this.total, this.progress + Math.max(2, v * 0.6)));
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-6) {
        const step = Math.min(v * dt, dist);
        p.x += (dx / dist) * step;
        p.z += (dz / dist) * step;
      }
    }

    const moved = Math.hypot(p.x - ox, p.z - oz);
    if (moved > 0) {
      this.world.clampToBounds(p);
      this.walked += moved;
      if (this.path) {
        this.progress = this._project(p.x, p.z);
        const end = this.path[this.path.length - 1];
        if (!this.finished && this.total - this.progress < 0.3 && Math.hypot(end.x - p.x, end.z - p.z) < 1) {
          this.finished = true;
          this.onArrive?.();
        }
      }
    }

    const ground = this.world.heightAt(p.x, p.z);
    const targetY = ground + EYE_HEIGHT;
    p.y += (targetY - p.y) * (1 - Math.exp(-12 * dt));
    if (p.y < ground + 0.5) p.y = ground + 0.5; // nunca atravessa o chão
    return ground;
  }
}
