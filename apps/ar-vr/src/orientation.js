// Controle de câmera em primeira pessoa:
//  - sensores do celular (DeviceOrientationEvent), com suavização por slerp;
//  - fallback de arrastar (dedo ou mouse);
//  - "recentralizar": gira o mundo para que a direção atual do celular aponte para um alvo.
//
// Convenção do Three.js: câmera olha para -Z, Y para cima. A conversão alpha/beta/gamma ->
// quaternion é a mesma do antigo DeviceOrientationControls do Three.js.
import * as THREE from 'three';

const ZEE = new THREE.Vector3(0, 0, 1);
const Q_MINUS_90_X = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // olhar p/ frente, não p/ baixo
const DEG = Math.PI / 180;

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

export const yawOfDirection = (x, z) => Math.atan2(-x, -z); // 0 = olhando para -Z (norte)

export class LookControls {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;

    this.sensorsActive = false;
    this.smoothing = 10; // maior = responde mais rápido; menor = mais suave
    this.deviceQ = new THREE.Quaternion(); // orientação crua vinda do sensor
    this.targetQ = new THREE.Quaternion();
    this.yawOffset = 0; // rotação do mundo em torno de Y (recentralizar / arrastar com sensores)
    this.dragYaw = 0; // usado sem sensores
    this.dragPitch = 0;
    this.pendingRecenter = null;
    this.lastEventAt = 0;
    this.dragEnabled = true; // desligado no modo estéreo (lá o toque serve para andar)

    this._euler = new THREE.Euler();
    this._q0 = new THREE.Quaternion();
    this._qYaw = new THREE.Quaternion();
    this._onOrientation = this._onOrientation.bind(this);
    this._bindDrag();
  }

  /** Precisa ser chamado dentro de um gesto do usuário (clique) por causa do iOS. */
  async enableSensors() {
    if (!('DeviceOrientationEvent' in window)) throw new Error('This browser does not expose DeviceOrientationEvent.');
    if (!window.isSecureContext) throw new Error('Sensors require HTTPS. See the README.');
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const res = await DeviceOrientationEvent.requestPermission(); // iOS 13+
      if (res !== 'granted') throw new Error('Motion sensor permission denied.');
    }
    window.addEventListener('deviceorientation', this._onOrientation);
    // Confirma que chegam eventos com dados reais (desktop costuma mandar null).
    const ok = await new Promise((resolve) => {
      const t0 = performance.now();
      const check = () => {
        if (this.sensorsActive) return resolve(true);
        if (performance.now() - t0 > 1500) return resolve(false);
        requestAnimationFrame(check);
      };
      check();
    });
    if (!ok) {
      window.removeEventListener('deviceorientation', this._onOrientation);
      throw new Error('No orientation data received. Drag to look around.');
    }
    return true;
  }

  disableSensors() {
    window.removeEventListener('deviceorientation', this._onOrientation);
    this.sensorsActive = false;
    this.lastEventAt = 0;
    // continua do ponto em que estava, agora com arrastar
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.dragYaw = e.y;
    this.dragPitch = e.x;
  }

  _onOrientation(ev) {
    if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
    this._euler.set(ev.beta * DEG, ev.alpha * DEG, -ev.gamma * DEG, 'YXZ');
    this.deviceQ.setFromEuler(this._euler);
    this.deviceQ.multiply(Q_MINUS_90_X);
    this.deviceQ.multiply(this._q0.setFromAxisAngle(ZEE, -screenAngle() * DEG));
    if (!this.sensorsActive) {
      // primeiro dado real: mantém o rumo para onde a pessoa já estava olhando (ou o recentralizar pedido)
      this.sensorsActive = true;
      if (this.pendingRecenter === null) {
        this.pendingRecenter = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ').y;
      }
    }
    this.lastEventAt = performance.now();
    if (this.pendingRecenter !== null) this._applyRecenter();
  }

  /** Faz a direção atual do olhar apontar para `yaw` (radianos; 0 = norte/-Z). */
  recenter(yaw) {
    this.pendingRecenter = yaw;
    if (this.sensorsActive) this._applyRecenter();
    else {
      this.dragYaw = yaw;
      this.dragPitch = 0;
    }
  }

  _applyRecenter() {
    if (this.pendingRecenter === null) return;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.deviceQ);
    const deviceYaw = yawOfDirection(fwd.x, fwd.z);
    this.yawOffset = this.pendingRecenter - deviceYaw;
    this.pendingRecenter = null;
    // evita "girar" suavemente da orientação antiga até a nova
    this._composeTarget();
    this.camera.quaternion.copy(this.targetQ);
  }

  _composeTarget() {
    if (this.sensorsActive) {
      this._qYaw.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this.yawOffset);
      this.targetQ.copy(this._qYaw).multiply(this.deviceQ);
    } else {
      this.targetQ.setFromEuler(this._euler.set(this.dragPitch, this.dragYaw, 0, 'YXZ'));
    }
  }

  _bindDrag() {
    let last = null;
    const el = this.dom;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      if (!this.dragEnabled) return;
      last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!last) return;
      const k = (this.camera.fov * DEG) / el.clientHeight; // 1 px = 1 px de cena, sensação de "agarrar"
      const dx = (e.clientX - last.x) * k;
      const dy = (e.clientY - last.y) * k;
      last = { x: e.clientX, y: e.clientY };
      if (this.sensorsActive) {
        this.yawOffset += dx; // com sensores, o arrastar só ajusta o rumo
      } else {
        this.dragYaw += dx;
        this.dragPitch = Math.max(-85 * DEG, Math.min(85 * DEG, this.dragPitch + dy));
      }
    });
    const end = () => (last = null);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  update(dt) {
    this._composeTarget();
    // Suavização exponencial independente de FPS (filtro passa-baixa no quaternion)
    const t = 1 - Math.exp(-this.smoothing * dt);
    this.camera.quaternion.slerp(this.targetQ, t);
  }
}
