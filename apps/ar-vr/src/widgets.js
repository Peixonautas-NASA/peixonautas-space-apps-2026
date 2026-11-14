// Widgets espaciais (estilo visor de realidade aumentada): painéis de vidro que existem no mundo 3D.
//
// "Segue a posição, mas não a rotação da cabeça":
//   cada widget guarda só (azimute, elevação) num referencial FIXO no mundo (norte = -Z) e uma
//   distância RADIUS. A cada frame:  posição = olho + RADIUS * direção(azimute, elevação).
//   A conta usa camera.position e ignora camera.quaternion. Andar leva o widget junto (mesma
//   distância e mesmo ângulo em relação ao astronauta); virar a cabeça não muda nada no mundo, então
//   o widget fica onde estava e sai do campo de visão. Por fim, lookAt(olho) deixa o painel sempre
//   de frente para o astronauta, de pé (eixo Y do mundo).
//
// Interação: os toques são ouvidos no `window` na fase de CAPTURA, antes do canvas. Se o raio do
// dedo acerta um painel, o evento é interrompido (stopPropagation) e o controle de olhar (que escuta
// no canvas) nunca o recebe, então arrastar um widget não gira a câmera.
//   - barra de título (ou qualquer parte do mapa 2D): move o painel pela esfera ao redor do astronauta;
//   - corpo do mapa 3D: gira a maquete;
//   - X: fecha. O seletor no HUD reabre o painel à frente do olhar.
import * as THREE from 'three';
import { yawOfDirection } from './orientation.js';
import { composeRegionImage } from './terrain.js';

const DEG = Math.PI / 180;
const STORE_KEY = 'peixonautas.vr.widgets.v1';
export const RADIUS = 1.45; // m do olho até o painel
const PANEL_W = 0.7; // m
const PANEL_H = 0.5;
const EL_MIN = -55 * DEG;
const EL_MAX = 45 * DEG;

// Canvas do painel: retângulo arredondado de PW x PH px com margem M para o brilho
const PW = 640;
const PH = Math.round((PW * PANEL_H) / PANEL_W);
const M = 26;
const CW = PW + 2 * M;
const CH = PH + 2 * M;
const RADIUS_PX = 34;
const TITLE_H = 58;
const CLOSE = { x: M + PW - 34, y: M + 30, r: 17 };
const CONTENT = { x: M + 14, y: M + TITLE_H + 2, w: PW - 28, h: PH - TITLE_H - 16 };
const MESH_W = (PANEL_W * CW) / PW;
const MESH_H = (PANEL_H * CH) / PH;

const CYAN = '#3ee6ff';
const AMBER = '#ffb020';
const TRAVELED = '#c7d0da';

function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',')} km` : `${Math.round(m)} m`);
const dirFrom = (az, el, out = new THREE.Vector3()) =>
  out.set(-Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------- Amostragem do terreno ao redor da rota ----------
function routeBox(path, extra = null) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of extra ? [...path, extra] : path) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  return { cx, cz, ext: Math.max(maxX - minX, maxZ - minZ) / 2, diag: Math.hypot(maxX - minX, maxZ - minZ) / 2 };
}

/** Grade N x N de alturas (m) cobrindo o quadrado [cx +- half] x [cz +- half]. Linha 0 = norte. */
function sampleHeights(world, cx, cz, half, N, smoothM = 0) {
  // Gaussiano separável com raio em metros: tira as "dobras" dos triângulos do bloco (vértices a
  // ~650 m), como a suavização gaussiana do map-3d. Amostra com margem para não distorcer a borda.
  const cell = (2 * half) / (N - 1);
  const sigma = smoothM / cell;
  const pad = sigma > 0.3 ? Math.min(96, Math.ceil(3 * sigma)) : 0;
  const P = N + 2 * pad;
  let a = new Float32Array(P * P);
  for (let iy = 0; iy < P; iy++) {
    const z = cz - half + (iy - pad) * cell;
    for (let ix = 0; ix < P; ix++) a[iy * P + ix] = world.heightAt(cx - half + (ix - pad) * cell, z);
  }
  if (pad) {
    const kern = [];
    let ks = 0;
    for (let i = -pad; i <= pad; i++) {
      const w = Math.exp(-(i * i) / (2 * sigma * sigma));
      kern.push(w);
      ks += w;
    }
    const pass = (src, horizontal) => {
      const out = new Float32Array(P * P);
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
          let s = 0;
          for (let i = -pad; i <= pad; i++) {
            const xx = horizontal ? Math.max(0, Math.min(P - 1, x + i)) : x;
            const yy = horizontal ? y : Math.max(0, Math.min(P - 1, y + i));
            s += src[yy * P + xx] * kern[i + pad];
          }
          out[y * P + x] = s / ks;
        }
      }
      return out;
    };
    a = pass(pass(a, true), false);
  }
  const h = new Float32Array(N * N);
  for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) h[iy * N + ix] = a[(iy + pad) * P + ix + pad];
  let min = Infinity;
  let max = -Infinity;
  for (const v of h) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { h, min, max, N, cx, cz, half };
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// ---------- Painel base ----------
class SpatialWidget {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.az = 0; // azimute no mundo (rad; 0 = norte/-Z, positivo = para a esquerda/oeste)
    this.el = -14 * DEG; // elevação (rad; negativa = abaixo da linha dos olhos)
    this.open = true;
    this.highlight = null; // 'close' | 'title' | 'content' | null
    this.dragging = false;
    this.contentDrag = 'move'; // o que arrastar no corpo faz: 'move' ou 'orbit'

    this.canvas = document.createElement('canvas');
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.group = new THREE.Group();
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(MESH_W, MESH_H),
      new THREE.MeshBasicMaterial({
        map: this.tex,
        transparent: true,
        depthTest: false, // sempre visível por cima do terreno, como um holograma do visor
        depthWrite: false,
        toneMapped: false,
        fog: false,
      })
    );
    this.mesh.renderOrder = 50;
    this.mesh.userData.widget = this;
    this.group.add(this.mesh);
    this._dir = new THREE.Vector3();
  }

  /** Posição = olho + RADIUS * direção fixa no mundo. A rotação da cabeça não entra aqui. */
  place(eye) {
    this.group.position.copy(eye).addScaledVector(dirFrom(this.az, this.el, this._dir), RADIUS);
    this.group.lookAt(eye); // +Z do painel aponta para o olho, com "para cima" = Y do mundo
  }

  /** Região do painel em (u, v) da textura. */
  regionAt(uv) {
    const px = uv.x * CW;
    const py = (1 - uv.y) * CH;
    if (px < M || px > M + PW || py < M || py > M + PH) return null; // margem do brilho: deixa passar
    if (Math.hypot(px - CLOSE.x, py - CLOSE.y) < CLOSE.r + 12) return 'close';
    if (py < M + TITLE_H) return 'title';
    return 'content';
  }

  drawChrome() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CW, CH);
    const active = this.dragging || this.highlight === 'title' || this.highlight === 'content';
    // brilho + vidro
    ctx.save();
    ctx.shadowColor = active ? 'rgba(120, 225, 255, 0.85)' : 'rgba(120, 225, 255, 0.45)';
    ctx.shadowBlur = active ? 26 : 16;
    roundRectPath(ctx, M, M, PW, PH, RADIUS_PX);
    ctx.fillStyle = 'rgba(14, 24, 34, 0.52)';
    ctx.fill();
    ctx.restore();
    const sheen = ctx.createLinearGradient(0, M, 0, M + PH);
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
    sheen.addColorStop(0.35, 'rgba(255, 255, 255, 0.05)');
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0.02)');
    roundRectPath(ctx, M, M, PW, PH, RADIUS_PX);
    ctx.fillStyle = sheen;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = active ? 'rgba(190, 245, 255, 0.95)' : 'rgba(210, 240, 255, 0.5)';
    ctx.stroke();
    // reflexo fino na borda de cima
    roundRectPath(ctx, M + 2, M + 2, PW - 4, PH - 4, RADIUS_PX - 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // alça (pontos) + título
    ctx.fillStyle = 'rgba(220, 240, 255, 0.55)';
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        ctx.beginPath();
        ctx.arc(M + 26 + j * 8, M + 21 + i * 8, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = '#eaf6ff';
    ctx.font = '600 28px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(this.title, M + 50, M + 30);
    if (this.subtitle) {
      const tw = ctx.measureText(this.title).width;
      ctx.font = '400 19px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(200, 225, 240, 0.65)';
      ctx.fillText(this.subtitle, M + 64 + tw, M + 31);
    }

    // botão fechar
    const hot = this.highlight === 'close';
    ctx.beginPath();
    ctx.arc(CLOSE.x, CLOSE.y, CLOSE.r, 0, Math.PI * 2);
    ctx.fillStyle = hot ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.13)';
    ctx.fill();
    ctx.strokeStyle = '#eaf6ff';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    const a = 6.5;
    ctx.beginPath();
    ctx.moveTo(CLOSE.x - a, CLOSE.y - a);
    ctx.lineTo(CLOSE.x + a, CLOSE.y + a);
    ctx.moveTo(CLOSE.x + a, CLOSE.y - a);
    ctx.lineTo(CLOSE.x - a, CLOSE.y + a);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  redraw() {
    this.drawChrome();
    this.drawContent?.(this.ctx, CONTENT);
    this.tex.needsUpdate = true;
  }

  setHighlight(region) {
    if (region === this.highlight) return;
    this.highlight = region;
    this.redraw();
  }

  setVisible(v) {
    this.group.visible = v;
  }
}

// ---------- Mapa 2D: minimapa visto de cima, centrado no astronauta ----------
export class Map2DWidget extends SpatialWidget {
  constructor() {
    super('map2d', 'Mapa 2D');
    this.subtitle = 'norte para cima';
    this.bg = null; // detalhe em volta da rota (HiRISE em Jezero)
    this.wide = null; // em volta do astronauta, quando ele sai da área da rota
    this._wideAt = 0;
    this.viewR = 0;
    this.nav = null;
    this._timer = 1;
  }

  rebuild(world, path) {
    this.world = world;
    const box = routeBox(path);
    // cobre a vista centrada no astronauta em qualquer ponto da rota
    const half = Math.max(600, box.diag * 3.6 + 200); // painel largo: sobra dos lados
    const token = (this._token = (this._token || 0) + 1);
    this.viewR = 0;
    // Mesmas camadas do apps/map-2d: Viking MDIM 2.1 + HiRISE de Jezero (opacidade 0,9), sem filtros
    composeRegionImage(world, box.cx, box.cz, half, { size: 1024, hirise: 'map2d', maxTiles: 120 }).then((img) => {
      if (token !== this._token) return;
      const source = `NASA Trek · ${img.sources.join(' + ')}`;
      this.bg = { canvas: img.canvas, minX: box.cx - half, minZ: box.cz - half, size: 2 * half, source };
      this.redraw();
    });
  }

  tick(dt, nav) {
    this.nav = nav;
    if ((this._timer += dt) < 0.1) return; // ~10 quadros por segundo bastam para o minimapa
    this._timer = 0;
    this._followAstronaut(nav.pos);
    this.redraw();
  }

  /** Longe da rota (ex.: subindo uma montanha), baixa os mesmos tiles reais em volta do astronauta. */
  _followAstronaut(p) {
    if (!this.world || !this.viewR || this._wideBusy) return;
    const need = this.viewR * 1.7; // meia-largura da vista (o painel é mais largo que alto)
    const covers = (b) =>
      b && p.x - need >= b.minX && p.x + need <= b.minX + b.size && p.z - need >= b.minZ && p.z + need <= b.minZ + b.size;
    if (covers(this.bg)) return;
    if (covers(this.wide) && this.wide.size < need * 8) return; // ainda serve (e não está grosseira demais)
    const now = performance.now();
    if (now - this._wideAt < 1000) return;
    this._wideAt = now;
    this._wideBusy = true;
    const half = need * 2;
    const cx = p.x;
    const cz = p.z;
    composeRegionImage(this.world, cx, cz, half, { size: 1024, hirise: 'map2d', maxTiles: 120 })
      .then((img) => {
        const source = `NASA Trek · ${img.sources.join(' + ')}`;
        this.wide = { canvas: img.canvas, minX: cx - half, minZ: cz - half, size: 2 * half, source };
      })
      .finally(() => (this._wideBusy = false));
  }

  drawContent(ctx, r) {
    const nav = this.nav;
    ctx.save();
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 20);
    ctx.clip();
    ctx.fillStyle = 'rgba(6, 12, 18, 0.7)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    if (!nav?.path) {
      ctx.restore();
      return;
    }
    const { pos, path, progress, total, yaw, hFov } = nav;

    // zoom: a rota inteira sempre cabe, com o astronauta no centro
    let far = 40;
    for (let i = 0; i < path.length; i += 4) far = Math.max(far, Math.hypot(path[i].x - pos.x, path[i].z - pos.z));
    far = Math.max(far, Math.hypot(path[path.length - 1].x - pos.x, path[path.length - 1].z - pos.z));
    const target = far * 1.12;
    this.viewR = this.viewR ? this.viewR + (target - this.viewR) * 0.2 : target;
    const s = (Math.min(r.w, r.h) / 2 - 8) / this.viewR;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const S = (x, z) => [cx + (x - pos.x) * s, cy + (z - pos.z) * s]; // leste à direita, norte acima

    ctx.imageSmoothingQuality = 'high';
    for (const layer of [this.wide, this.bg]) {
      if (!layer) continue; // a camada larga embaixo; o detalhe da rota por cima
      const [x0, y0] = S(layer.minX, layer.minZ);
      ctx.drawImage(layer.canvas, x0, y0, layer.size * s, layer.size * s);
    }
    const viewHalf = this.viewR * 1.7;
    const inBg =
      this.bg && Math.abs(pos.x - (this.bg.minX + this.bg.size / 2)) + viewHalf <= this.bg.size / 2 &&
      Math.abs(pos.z - (this.bg.minZ + this.bg.size / 2)) + viewHalf <= this.bg.size / 2;
    this.source = (inBg ? this.bg : this.wide ?? this.bg)?.source;
    if (!this.bg && !this.wide) {
      ctx.font = '500 18px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(220, 240, 255, 0.7)';
      ctx.textAlign = 'center';
      ctx.fillText('baixando tiles do NASA Trek…', cx, r.y + 30);
    }
    // anéis de distância
    const ring = niceStep(this.viewR / 2.2);
    ctx.strokeStyle = 'rgba(200, 240, 255, 0.22)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 6]);
    for (let k = 1; k * ring < this.viewR * 1.6; k++) {
      ctx.beginPath();
      ctx.arc(cx, cy, k * ring * s, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = '500 17px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(220, 245, 255, 0.8)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(fmtDist(ring), cx + ring * s * 0.72 + 4, cy - ring * s * 0.72 - 2);

    // rota: percorrido (claro, fino) e restante (ciano com brilho)
    let k = path.findIndex((p) => p.d > progress);
    if (k < 0) k = path.length;
    const here = { x: pos.x, z: pos.z };
    const line = (pts, color, width, glow) => {
      if (pts.length < 2) return;
      ctx.save();
      if (glow) {
        ctx.shadowColor = color;
        ctx.shadowBlur = glow;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => {
        const [x, y] = S(p.x, p.z);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    };
    line([...path.slice(0, k), here], TRAVELED, 3.5, 0);
    line([here, ...path.slice(k)], CYAN, 5, 10);

    // início e destino
    const [sx, sy] = S(path[0].x, path[0].z);
    ctx.fillStyle = TRAVELED;
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fill();
    const end = path[path.length - 1];
    const [ex, ey] = S(end.x, end.z);
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(ex, ey, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // astronauta: campo de visão + seta na direção do olhar
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    const ang = Math.atan2(dz, dx);
    const half = Math.min(hFov / 2, 1.2);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 70);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, 70, ang - half, ang + half);
    ctx.closePath();
    ctx.fill();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang + Math.PI / 2);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(10, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(-10, 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // norte
    ctx.fillStyle = 'rgba(8, 14, 22, 0.7)';
    ctx.beginPath();
    ctx.arc(r.x + r.w - 26, r.y + 26, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#eaf6ff';
    ctx.font = '700 17px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', r.x + r.w - 26, r.y + 27);

    // rodapé
    const txt = `percorrido ${fmtDist(Math.min(progress, total))}  ·  faltam ${fmtDist(Math.max(0, total - progress))}`;
    ctx.font = '500 19px system-ui, sans-serif';
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(8, 14, 22, 0.72)';
    roundRectPath(ctx, r.x + 10, r.y + r.h - 40, tw + 22, 30, 15);
    ctx.fill();
    ctx.fillStyle = '#dff6ff';
    ctx.textAlign = 'left';
    ctx.fillText(txt, r.x + 21, r.y + r.h - 24);
    if (this.source) {
      ctx.font = '500 14px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillText(this.source, r.x + r.w - 11, r.y + r.h - 13);
      ctx.fillStyle = 'rgba(235, 245, 255, 0.85)';
      ctx.fillText(this.source, r.x + r.w - 12, r.y + r.h - 14);
    }
    ctx.restore();

    // borda do conteúdo
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 20);
    ctx.strokeStyle = 'rgba(200, 240, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// ---------- Mapa 3D: maquete holográfica que gira ao arrastar ----------
export class Map3DWidget extends SpatialWidget {
  constructor(renderer) {
    super('map3d', 'Mapa 3D');
    this.subtitle = 'arraste para girar';
    this.contentDrag = 'orbit';
    this.renderer = renderer;
    this.orbitYaw = 0;
    this.orbitPitch = 0.62;
    this.nav = null;
    this._timer = 1;
    this._lastProgressFrac = -1;

    // Conteúdo: cena própria renderizada numa textura com fundo transparente, num plano à frente do vidro
    const rtW = 768;
    const rtH = Math.round((rtW * CONTENT.h) / CONTENT.w);
    this.rt = new THREE.WebGLRenderTarget(rtW, rtH, { samples: 4 });
    const cw = (CONTENT.w / CW) * MESH_W;
    const ch = (CONTENT.h / CH) * MESH_H;
    this.content = new THREE.Mesh(
      new THREE.PlaneGeometry(cw, ch),
      new THREE.MeshBasicMaterial({
        map: this.rt.texture,
        transparent: true,
        // a textura já sai pré-multiplicada (fundo transparente + mistura normal)
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      })
    );
    this.content.position.set(
      ((CONTENT.x + CONTENT.w / 2) / CW - 0.5) * MESH_W,
      (0.5 - (CONTENT.y + CONTENT.h / 2) / CH) * MESH_H,
      0.002
    );
    this.content.renderOrder = 51;
    this.group.add(this.content);

    this.scene3 = new THREE.Scene();
    this.cam3 = new THREE.PerspectiveCamera(30, rtW / rtH, 0.02, 20);
    // Luz como no apps/map-3d: sol quente com azimute 45° e elevação 28°, ambiente fraco
    this.scene3.add(new THREE.AmbientLight(0xffd6ba, 0.55));
    const sun = new THREE.DirectionalLight(0xfff1e0, 2.2);
    const el = 28 * DEG;
    const az = 45 * DEG;
    sun.position.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    this.scene3.add(sun);
    this.model = new THREE.Group();
    this.scene3.add(this.model);

    // base holográfica
    const base = new THREE.Group();
    base.add(
      new THREE.Mesh(
        new THREE.CircleGeometry(0.8, 96).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x3ee6ff, transparent: true, opacity: 0.07, depthWrite: false })
      ),
      new THREE.Mesh(
        new THREE.RingGeometry(0.78, 0.8, 96).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x8ff3ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
      ),
      new THREE.Mesh(
        new THREE.RingGeometry(0.62, 0.625, 96).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x8ff3ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
      )
    );
    base.position.y = -0.045;
    this.scene3.add(base);

    // astronauta: ponto + haste + seta do olhar + anel pulsante
    this.astro = new THREE.Group();
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.07, 6).translate(0, 0.035, 0), white);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 12).translate(0, 0.075, 0), white);
    this.heading = new THREE.Mesh(
      new THREE.ConeGeometry(0.012, 0.04, 12).rotateX(-Math.PI / 2).translate(0, 0.075, -0.035),
      new THREE.MeshBasicMaterial({ color: 0x3ee6ff })
    );
    this.pulse = new THREE.Mesh(
      new THREE.RingGeometry(0.016, 0.022, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, side: THREE.DoubleSide, depthWrite: false })
    );
    this.astro.add(stem, head, this.heading, this.pulse);
    this.scene3.add(this.astro);
  }

  /**
   * Monta a maquete em volta da rota (e do astronauta, se `extra` for a posição dele fora da área).
   * Baixa a textura primeiro e só então troca o modelo, para a maquete antiga não sumir no meio.
   */
  async rebuild(world, path, extra = null) {
    this.world = world;
    this.path = path;
    const box = routeBox(path, extra);
    const half = Math.max(350, box.diag * 1.3);
    const token = (this._token = (this._token || 0) + 1);
    this._building = true;
    this._builtAt = performance.now();
    if (!this.grid) this.source = 'baixando tiles do NASA Trek…';
    let img;
    try {
      // Textura: mesma receita do apps/map-3d (Viking + HiRISE por luminosidade em Jezero), tiles reais
      img = await composeRegionImage(world, box.cx, box.cz, half, { size: 1024, hirise: 'map3d' });
    } finally {
      if (token === this._token) this._building = false;
    }
    if (token !== this._token) return;
    this.region = { cx: box.cx, cz: box.cz, half, withAstronaut: Boolean(extra) };

    // troca o modelo anterior
    for (const c of [...this.model.children]) {
      this.model.remove(c);
      c.geometry?.dispose();
      c.material?.map?.dispose();
      c.material?.dispose();
    }
    const G = 129;
    // Relevo: MOLA ClrShade decodificado por cromaticidade (o mesmo do map-3d e da caminhada)
    const g = sampleHeights(world, box.cx, box.cz, half, G, world.dem ? 0 : 400); // DEM real: sem suavizar
    const k = 1 / (2 * half); // m -> unidades da maquete (1 x 1)
    const relief = Math.max(0.5, g.max - g.min);
    this.vex = Math.max(1, Math.min(12, (0.16 * 2 * half) / relief)); // exagero vertical automático
    this.subtitle = `arraste para girar · relevo ${this.vex < 1.05 ? 'real 1:1' : `${this.vex.toFixed(1).replace('.', ',')}x`}`;
    const ky = k * this.vex;
    this.grid = { ...g, k, ky };

    const geo = new THREE.PlaneGeometry(1, 1, G - 1, G - 1).rotateX(-Math.PI / 2); // linha 0 = norte (-Z)
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, (g.h[i] - g.min) * ky);
    geo.computeVertexNormals();
    const tex = new THREE.CanvasTexture(img.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0.02 });
    this.model.add(new THREE.Mesh(geo, mat));
    this.source = `NASA Trek · MOLA + ${img.sources.join(' + ')}`;

    // laterais da maquete (espessura)
    const skirtPos = [];
    const bottom = -0.04;
    const edge = (ix, iy) => {
      const i = iy * G + ix;
      return [pos.getX(i), pos.getY(i), pos.getZ(i)];
    };
    const ring = [];
    for (let i = 0; i < G; i++) ring.push(edge(i, 0));
    for (let i = 1; i < G; i++) ring.push(edge(G - 1, i));
    for (let i = G - 2; i >= 0; i--) ring.push(edge(i, G - 1));
    for (let i = G - 2; i >= 0; i--) ring.push(edge(0, i));
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay, az] = ring[i];
      const [bx, by, bz] = ring[i + 1];
      skirtPos.push(ax, ay, az, bx, by, bz, ax, bottom, az, bx, by, bz, bx, bottom, bz, ax, bottom, az);
    }
    const skirtGeo = new THREE.BufferGeometry();
    skirtGeo.setAttribute('position', new THREE.Float32BufferAttribute(skirtPos, 3));
    this.model.add(
      new THREE.Mesh(
        skirtGeo,
        new THREE.MeshBasicMaterial({ color: 0x3a2a20, side: THREE.DoubleSide }) // corte do solo
      )
    );

    // rota como tubo; cores por vértice marcam o trecho percorrido
    const step = Math.max(1, Math.floor(path.length / 300));
    const pts = [];
    for (let i = 0; i < path.length; i += step) pts.push(this._toModel(path[i].x, path[i].z, 0.007));
    const last = path[path.length - 1];
    pts.push(this._toModel(last.x, last.z, 0.007));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    this.tubeSegs = Math.min(600, pts.length * 2);
    const tube = new THREE.TubeGeometry(curve, this.tubeSegs, 0.0055, 6, false);
    tube.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tube.attributes.position.count * 3), 3));
    this.tube = new THREE.Mesh(tube, new THREE.MeshBasicMaterial({ vertexColors: true }));
    this.model.add(this.tube);
    this._lastProgressFrac = -1;

    // destino: feixe âmbar + anel; início: ponto claro
    const d = this._toModel(last.x, last.z, 0);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.004, 0.14, 8).translate(0, 0.07, 0),
      new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.85 })
    );
    beam.position.copy(d);
    const destRing = new THREE.Mesh(
      new THREE.RingGeometry(0.014, 0.022, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffb020, side: THREE.DoubleSide })
    );
    destRing.position.copy(d).y += 0.004;
    const s0 = this._toModel(path[0].x, path[0].z, 0.006);
    const start = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: 0xc7d0da }));
    start.position.copy(s0);
    this.model.add(beam, destRing, start);

    this.orbitTarget = new THREE.Vector3(0, ((g.max - g.min) * ky) / 2, 0);
    this.redraw();
  }

  drawContent(ctx, r) {
    if (!this.source) return;
    ctx.font = '500 14px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(235, 245, 255, 0.8)';
    ctx.fillText(this.source, r.x + r.w - 12, r.y + r.h - 12);
  }

  _yAtModel(mx, mz) {
    // bilinear na grade suavizada (a mesma da malha), em unidades da maquete
    const g = this.grid;
    const N = g.N;
    const fx = Math.max(0, Math.min(N - 1.001, (mx + 0.5) * (N - 1)));
    const fy = Math.max(0, Math.min(N - 1.001, (mz + 0.5) * (N - 1)));
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const h = g.h;
    const a = h[iy * N + ix] + (h[iy * N + ix + 1] - h[iy * N + ix]) * tx;
    const b = h[(iy + 1) * N + ix] + (h[(iy + 1) * N + ix + 1] - h[(iy + 1) * N + ix]) * tx;
    return (a + (b - a) * ty - g.min) * g.ky;
  }

  _toModel(x, z, lift = 0) {
    const g = this.grid;
    const mx = (x - g.cx) * g.k;
    const mz = (z - g.cz) * g.k;
    return new THREE.Vector3(mx, this._yAtModel(mx, mz) + lift, mz);
  }

  /** Começa olhando a maquete "por trás" do astronauta, no mesmo sentido que ele olha. */
  faceYaw(yaw) {
    this.orbitYaw = yaw;
  }

  orbit(dxPx, dyPx) {
    this.orbitYaw -= dxPx * 0.009;
    this.orbitPitch = Math.max(0.12, Math.min(1.4, this.orbitPitch + dyPx * 0.006));
  }

  /** Se o astronauta sai da maquete (ou volta para a rota), refaz a área para mostrar os dois. */
  _followAstronaut(p) {
    const R = this.region;
    if (!R || this._building || performance.now() - this._builtAt < 1500) return;
    const d = Math.max(Math.abs(p.x - R.cx), Math.abs(p.z - R.cz));
    if (d > R.half * 0.8) {
      this.rebuild(this.world, this.path, { x: p.x, z: p.z });
      return;
    }
    if (R.withAstronaut) {
      // voltou para perto da rota: a maquete original (mais detalhada) já o mostra
      const rb = routeBox(this.path);
      const rh = Math.max(350, rb.diag * 1.3);
      if (Math.max(Math.abs(p.x - rb.cx), Math.abs(p.z - rb.cz)) < rh * 0.7) this.rebuild(this.world, this.path);
    }
  }

  tick(dt, nav, t) {
    this.nav = nav;
    if (!nav?.path) return;
    this._followAstronaut(nav.pos);
    if (!this.grid) return;
    if ((this._timer += dt) < 1 / 30) return;
    this._timer = 0;

    // trecho percorrido no tubo
    const frac = Math.min(1, nav.progress / (nav.total || 1));
    if (Math.abs(frac - this._lastProgressFrac) > 0.002) {
      this._lastProgressFrac = frac;
      const colAttr = this.tube.geometry.attributes.color;
      const ring = colAttr.count / (this.tubeSegs + 1);
      const done = new THREE.Color(0xc7d0da);
      const todo = new THREE.Color(0x3ee6ff);
      for (let i = 0; i < colAttr.count; i++) {
        const u = Math.floor(i / ring) / this.tubeSegs;
        const cc = u <= frac ? done : todo;
        colAttr.setXYZ(i, cc.r, cc.g, cc.b);
      }
      colAttr.needsUpdate = true;
    }

    // astronauta
    this.astro.position.copy(this._toModel(nav.pos.x, nav.pos.z, 0));
    this.heading.rotation.y = nav.yaw;
    const ph = (t * 0.8) % 1;
    this.pulse.scale.setScalar(1 + ph * 2.2);
    this.pulse.material.opacity = 0.9 * (1 - ph);

    // câmera em órbita
    const dist = 1.75;
    const cp = Math.cos(this.orbitPitch);
    this.cam3.position
      .set(Math.sin(this.orbitYaw) * cp, Math.sin(this.orbitPitch), Math.cos(this.orbitYaw) * cp)
      .multiplyScalar(dist)
      .add(this.orbitTarget);
    this.cam3.lookAt(this.orbitTarget);

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.scene3, this.cam3);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevColor, prevAlpha);
  }
}

// ---------- Gerenciador: posicionamento, toque, abrir/fechar, memória ----------
export class WidgetManager {
  constructor({ scene, camera, dom }) {
    this.scene = scene;
    this.camera = camera;
    this.dom = dom;
    this.widgets = [];
    this.enabled = true; // desligado no modo estéreo
    this.homeYaw = 0; // rumo inicial do astronauta: os ângulos salvos são relativos a ele
    this.onChange = null;
    this.raycaster = new THREE.Raycaster();
    this.active = null; // interação em andamento
    this._ndc = new THREE.Vector2();
    this._fwd = new THREE.Vector3();
    this._bindPointer();
  }

  add(widget, defaults) {
    widget.defaults = defaults; // { daz, el } relativos ao rumo inicial
    this.widgets.push(widget);
    this.scene.add(widget.group);
    return widget;
  }

  get(id) {
    return this.widgets.find((w) => w.id === id);
  }

  /** Aplica o layout salvo (ou o padrão) a partir do rumo inicial do astronauta. */
  layout(homeYaw) {
    this.homeYaw = homeYaw;
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch {
      /* sem memória: usa o padrão */
    }
    for (const w of this.widgets) {
      const s = saved[w.id] ?? w.defaults;
      w.az = homeYaw + (s.daz ?? w.defaults.daz);
      w.el = s.el ?? w.defaults.el;
      w.open = s.open ?? true;
      w.setVisible(w.open);
      w.place(this.camera.position);
    }
    this.onChange?.();
  }

  save() {
    const out = {};
    for (const w of this.widgets) out[w.id] = { daz: wrapAngle(w.az - this.homeYaw), el: w.el, open: w.open };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch {
      /* navegação privada etc. */
    }
  }

  /** Abre ou fecha. Ao abrir, o widget aparece à frente do olhar (desviando de outro já aberto ali). */
  setOpen(id, open) {
    const w = this.get(id);
    if (!w || w.open === open) return;
    w.open = open;
    if (open) {
      this.camera.getWorldDirection(this._fwd);
      let az = yawOfDirection(this._fwd.x, this._fwd.z);
      const span = 2 * Math.atan(PANEL_W / 2 / RADIUS) + 4 * DEG;
      for (const o of this.widgets) {
        if (o !== w && o.open && Math.abs(wrapAngle(o.az - az)) < span && Math.abs(o.el - -8 * DEG) < 20 * DEG) {
          az = o.az + (wrapAngle(az - o.az) >= 0 ? span : -span);
        }
      }
      w.az = az;
      w.el = -8 * DEG;
      w.place(this.camera.position);
      w.redraw();
    }
    w.setVisible(open);
    if (this.active?.w === w) this._endActive();
    this.save();
    this.onChange?.();
  }

  toggle(id) {
    const w = this.get(id);
    if (w) this.setOpen(id, !w.open);
  }

  rebuild(world, path) {
    for (const w of this.widgets) w.rebuild?.(world, path);
  }

  update(dt, t, nav) {
    const eye = this.camera.position;
    for (const w of this.widgets) {
      if (!w.open) continue;
      w.place(eye); // segue a posição do astronauta, nunca a rotação da cabeça
      w.tick?.(dt, nav, t);
    }
  }

  // --- toque / mouse ---
  _pick(e) {
    const rect = this.dom.getBoundingClientRect();
    this._ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const meshes = this.widgets.filter((w) => w.open).map((w) => w.mesh);
    // sem teste de profundidade os painéis ficam sempre por cima; aqui vale o mais próximo
    for (const hit of this.raycaster.intersectObjects(meshes, false)) {
      const w = hit.object.userData.widget;
      const region = w.regionAt(hit.uv);
      if (region) return { w, region };
    }
    return null;
  }

  _rayAngles() {
    const d = this.raycaster.ray.direction;
    return { az: yawOfDirection(d.x, d.z), el: Math.asin(Math.max(-1, Math.min(1, d.y))) };
  }

  _endActive() {
    const a = this.active;
    if (!a) return;
    a.w.dragging = false;
    a.w.setHighlight(null);
    a.w.redraw();
    this.active = null;
  }

  _bindPointer() {
    const opts = { capture: true, passive: false };
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.enabled || e.target !== this.dom) return;
        const hit = this._pick(e);
        if (!hit) return; // fora dos painéis: segue para o controle de olhar
        // Nosso: o canvas (e o controle de olhar) não recebe este toque
        e.stopPropagation();
        e.preventDefault();
        if (this.active) return; // um dedo por vez em widgets
        const { w, region } = hit;
        const mode = region === 'close' ? 'close' : region === 'content' && w.contentDrag === 'orbit' ? 'orbit' : 'move';
        const ang = this._rayAngles();
        this.active = {
          id: e.pointerId,
          w,
          mode,
          x0: e.clientX,
          y0: e.clientY,
          x: e.clientX,
          y: e.clientY,
          moved: false,
          daz: wrapAngle(w.az - ang.az),
          del: w.el - ang.el,
        };
        w.dragging = mode !== 'close';
        w.setHighlight(region);
        w.redraw();
      },
      opts
    );
    window.addEventListener(
      'pointermove',
      (e) => {
        const a = this.active;
        if (!a || e.pointerId !== a.id) {
          if (!a && this.enabled && e.pointerType === 'mouse' && e.target === this.dom && e.buttons === 0) this._hover(e);
          return;
        }
        e.stopPropagation();
        e.preventDefault();
        if (Math.hypot(e.clientX - a.x0, e.clientY - a.y0) > 6) a.moved = true;
        if (a.mode === 'move') {
          // o painel segue o raio do dedo, sempre à mesma distância (superfície da esfera)
          this._pick(e);
          const ang = this._rayAngles();
          a.w.az = ang.az + a.daz;
          a.w.el = Math.max(EL_MIN, Math.min(EL_MAX, ang.el + a.del));
          a.w.place(this.camera.position);
        } else if (a.mode === 'orbit') {
          a.w.orbit(e.clientX - a.x, e.clientY - a.y);
        }
        a.x = e.clientX;
        a.y = e.clientY;
      },
      opts
    );
    const end = (e) => {
      const a = this.active;
      if (!a || e.pointerId !== a.id) return;
      e.stopPropagation();
      const w = a.w;
      if (a.mode === 'close' && !a.moved && e.type === 'pointerup') {
        this._endActive();
        this.setOpen(w.id, false);
        return;
      }
      if (a.mode === 'move' && a.moved) this.save();
      this._endActive();
    };
    window.addEventListener('pointerup', end, opts);
    window.addEventListener('pointercancel', end, opts);
  }

  _hover(e) {
    const hit = this._pick(e);
    for (const w of this.widgets) if (w.open) w.setHighlight(hit?.w === w ? hit.region : null);
    this.dom.style.cursor = !hit
      ? ''
      : hit.region === 'close'
        ? 'pointer'
        : hit.region === 'content' && hit.w.contentDrag === 'orbit'
          ? 'ew-resize'
          : 'grab';
  }
}
