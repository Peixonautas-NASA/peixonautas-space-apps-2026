// Rota desenhada no chão: faixa contínua + setas animadas + farol no destino.
// Recebe pontos em coordenadas do mundo (metros); quem chama converte de lat/lon.
import * as THREE from 'three';

const LIFT = 0.12; // m acima do solo, contra z-fighting
const RIBBON_W = 0.6;
const ARROW_EVERY = 5; // m
const START_GAP = 1.5; // não desenha nada embaixo dos pés

function densify(points, step) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  out.push(points[points.length - 1]);
  // distância acumulada
  let d = 0;
  out.forEach((p, i) => {
    if (i > 0) d += Math.hypot(p.x - out[i - 1].x, p.z - out[i - 1].z);
    p.d = d;
  });
  return out;
}

function makeLabel(text) {
  const font = 'bold 48px system-ui, sans-serif';
  const c = document.createElement('canvas');
  const measure = c.getContext('2d');
  measure.font = font;
  c.width = Math.ceil(measure.measureText(text).width) + 64; // canvas do tamanho do texto
  c.height = 112;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(8, 14, 22, 0.78)';
  ctx.strokeStyle = '#ffb020';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(4, 4, c.width - 8, c.height - 8, 24);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fff6e0';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false })
  );
  sprite.renderOrder = 10;
  sprite.userData.aspect = c.width / c.height;
  return sprite;
}

export function buildRoute(terrain, pts2d, destName = 'Destino') {
  const group = new THREE.Group();
  const path = densify(pts2d, 1.0);
  const total = path[path.length - 1].d;
  const yAt = (x, z) => terrain.heightAt(x, z) + LIFT;

  // --- Faixa (ribbon) no chão ---
  const ribbonMat = new THREE.MeshBasicMaterial({
    color: 0x3ee6ff,
    toneMapped: false,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const ribbonGeo = new THREE.BufferGeometry();
  function rebuildRibbon() {
    const pos = [];
    const idx = [];
    const visible = path.filter((p) => p.d >= START_GAP);
    visible.forEach((p, i) => {
      const q = visible[Math.min(i + 1, visible.length - 1)];
      const o = visible[Math.max(i - 1, 0)];
      let tx = q.x - o.x;
      let tz = q.z - o.z;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      const nx = -tz * (RIBBON_W / 2);
      const nz = tx * (RIBBON_W / 2);
      pos.push(p.x + nx, yAt(p.x + nx, p.z + nz), p.z + nz, p.x - nx, yAt(p.x - nx, p.z - nz), p.z - nz);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    });
    ribbonGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ribbonGeo.setIndex(idx);
    ribbonGeo.computeBoundingSphere();
  }
  const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
  ribbon.renderOrder = 1;
  group.add(ribbon);

  // --- Setas (chevrons) deitadas no chão, animadas no sentido da rota ---
  const chevron = new THREE.Shape();
  chevron.moveTo(0, 0.55);
  chevron.lineTo(0.7, -0.15);
  chevron.lineTo(0.45, -0.4);
  chevron.lineTo(0, 0.05);
  chevron.lineTo(-0.45, -0.4);
  chevron.lineTo(-0.7, -0.15);
  chevron.closePath();
  const chevGeo = new THREE.ShapeGeometry(chevron);
  chevGeo.rotateX(-Math.PI / 2); // deita no chão, ponta para -Z
  const arrows = [];
  for (let d = START_GAP + 2; d < total - 2; d += ARROW_EVERY) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    });
    const m = new THREE.Mesh(chevGeo, mat);
    m.renderOrder = 2;
    m.userData.d = d;
    arrows.push(m);
    group.add(m);
  }
  function placeArrows() {
    for (const m of arrows) {
      const i = path.findIndex((p) => p.d >= m.userData.d);
      const p = path[Math.max(1, i)];
      const o = path[Math.max(0, i - 1)];
      m.position.set(p.x, yAt(p.x, p.z) + 0.02, p.z);
      m.rotation.set(0, Math.atan2(-(p.x - o.x), -(p.z - o.z)), 0);
    }
  }

  // --- Destino: anel no chão + feixe vertical + rótulo ---
  const dest = pts2d[pts2d.length - 1];
  const destGroup = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.2, 3.0, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffb020, toneMapped: false, transparent: true, opacity: 0.9, depthWrite: false })
  );
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.6, 120, 16, 1, true).translate(0, 60, 0),
    new THREE.MeshBasicMaterial({
      color: 0xffb020,
      toneMapped: false,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    })
  );
  const label = makeLabel(`${destName} · ${Math.round(total)} m`);
  label.material.fog = false;
  destGroup.add(ring, beam, label);
  group.add(destGroup);

  function placeDest() {
    const y = terrain.heightAt(dest.x, dest.z);
    destGroup.position.set(dest.x, y, dest.z);
    ring.position.y = LIFT;
  }

  function relayout() {
    rebuildRibbon();
    placeArrows();
    placeDest();
  }
  relayout();

  return {
    group,
    total,
    dest,
    aim: path.find((p) => p.d >= 25) ?? dest, // ponto ~25 m à frente na rota
    relayout, // chamar após mudar a escala vertical ou trocar o bloco de terreno
    update(time, camera) {
      // onda de brilho que corre ao longo da rota
      for (const m of arrows) {
        const phase = (m.userData.d / 25 - time * 0.6) % 1;
        m.material.opacity = 0.35 + 0.6 * Math.pow(1 - ((phase + 1) % 1), 3);
      }
      ring.material.opacity = 0.6 + 0.3 * Math.sin(time * 3);
      // rótulo com tamanho angular ~constante, acima do farol
      const dist = camera.position.distanceTo(destGroup.position);
      const s = Math.max(1, dist * 0.06);
      label.scale.set(s * label.userData.aspect, s, 1);
      label.position.y = 6 + s * 1.2;
    },
  };
}
