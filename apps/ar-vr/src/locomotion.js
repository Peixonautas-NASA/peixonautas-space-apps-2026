// Caminhada em primeira pessoa sobre o terreno.
//  - Segurar o botão "Andar" (ou a tela, no modo estéreo): anda para onde você está olhando.
//  - Teclado (PC): W/S ou setas = frente/trás, A/D = lados, Shift = 5x mais rápido.
// A câmera fica sempre a EYE_HEIGHT do chão, com suavização vertical para não "pular" degraus.
import * as THREE from 'three';

export const EYE_HEIGHT = 1.7;

export const SPEEDS = [
  { icon: '🚶', label: 'Caminhar', v: 1.4 },
  { icon: '🚙', label: 'Rover', v: 15 },
  { icon: '🚀', label: 'Rápido', v: 300 },
];

export class Walker {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.speedIndex = 0;
    this.holding = false;
    this.keys = new Set();
    this.walked = 0; // metros percorridos
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

  /** Liga um elemento como "segure para andar". */
  bindHold(el, { stopPropagation = true } = {}) {
    const down = (e) => {
      if (stopPropagation) e.stopPropagation();
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

  snapToGround() {
    const p = this.camera.position;
    p.y = this.world.heightAt(p.x, p.z) + EYE_HEIGHT;
  }

  update(dt) {
    const k = this.keys;
    const fwd = (this.holding || k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const side = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    const p = this.camera.position;
    this.moving = fwd !== 0 || side !== 0;

    if (this.moving) {
      // rumo pela rotação em Y (funciona mesmo olhando para os pés)
      const yaw = this._e.setFromQuaternion(this.camera.quaternion, 'YXZ').y;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      let mx = fx * fwd - fz * side;
      let mz = fz * fwd + fx * side;
      const len = Math.hypot(mx, mz) || 1;
      const step = this.speed.v * (k.has('shift') ? 5 : 1) * dt;
      mx = (mx / len) * step;
      mz = (mz / len) * step;
      const ox = p.x;
      const oz = p.z;
      p.x += mx;
      p.z += mz;
      this.world.clampToBounds(p);
      this.walked += Math.hypot(p.x - ox, p.z - oz);
    }

    const ground = this.world.heightAt(p.x, p.z);
    const target = ground + EYE_HEIGHT;
    p.y += (target - p.y) * (1 - Math.exp(-12 * dt));
    if (p.y < ground + 0.5) p.y = ground + 0.5; // nunca atravessa o chão
    return ground;
  }
}
