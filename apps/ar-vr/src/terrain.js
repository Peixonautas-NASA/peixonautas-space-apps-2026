// Terreno local em escala métrica (1 unidade = 1 metro) a partir dos MESMOS tiles NASA Trek
// e da MESMA fórmula de pseudo-elevação usados em apps/map-3d/index.html.
//
// Diferença em relação ao mapa 3D: lá o relevo é aplicado na GPU (displacementMap), então a
// CPU não conhece a altura do chão. Aqui as alturas vão direto nos vértices, o que permite
// posicionar a câmera a 1,7 m do solo e "colar" a rota no terreno.
//
// TODO(packages/shared): as funções de tiles (latLonToTile, tileBounds, drawLayerTile,
// pseudo-elevação) estão duplicadas do map-3d. Proposta: mover para packages/shared.
import * as THREE from 'three';

const TREK = 'https://trek.nasa.gov/tiles/Mars/EQ';
export const LAYERS = {
  color: { id: 'Mars_Viking_MDIM21_ClrMosaic_global_232m', ext: 'jpg', maxZ: 7 },
  relief: { id: 'Mars_MGS_MOLA_ClrShade_merge_global_463m', ext: 'jpg', maxZ: 7 },
  // O mosaico de Jezero tem tiles até z17 (~0,3 m/px); o map-3d para em z12.
  hirise: { id: 'NES_JEZ_MID_Visible_Mosaic_HiRISE_CTX_HRSC_GCS_MARS_07-10-2018', ext: 'png', maxZ: 17 },
};
const JEZERO_BOUNDS = { lonMin: 76.79, lonMax: 77.74, latMin: 17.57, latMax: 18.88 };

export const MARS_RADIUS_M = 3389500;
export const M_PER_DEG_LAT = (2 * Math.PI * MARS_RADIUS_M) / 360; // ~59 158 m

const TILE = 256;

// ---------- Geometria de tiles (equirretangular, 2^(z+1) x 2^z, igual ao map-3d) ----------
export function latLonToTile(lat, lon, z) {
  const cols = 2 ** (z + 1);
  const rows = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * cols);
  const y = Math.floor(((90 - lat) / 180) * rows);
  return { x: Math.max(0, Math.min(cols - 1, x)), y: Math.max(0, Math.min(rows - 1, y)), cols, rows };
}

export function tileBounds(tx, ty, z) {
  const cols = 2 ** (z + 1);
  const rows = 2 ** z;
  return {
    lonMin: (tx / cols) * 360 - 180,
    lonMax: ((tx + 1) / cols) * 360 - 180,
    latMax: 90 - (ty / rows) * 180,
    latMin: 90 - ((ty + 1) / rows) * 180,
  };
}

const overlaps = (a, b) => !(a.lonMax < b.lonMin || a.lonMin > b.lonMax || a.latMax < b.latMin || a.latMin > b.latMax);

const imageCache = new Map();
function fetchImage(url) {
  if (!imageCache.has(url)) {
    imageCache.set(
      url,
      new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      })
    );
  }
  return imageCache.get(url);
}

// Desenha um tile; acima do zoom nativo recorta e amplia o sub-quadrante do tile pai (como no map-3d).
async function drawLayerTile(ctx, layer, z, tx, ty, dx, dy) {
  const nz = Math.min(z, layer.maxZ);
  const f = 2 ** (z - nz);
  const px = Math.floor(tx / f);
  const py = Math.floor(ty / f);
  const img = await fetchImage(`${TREK}/${layer.id}/1.0.0/default/default028mm/${nz}/${py}/${px}.${layer.ext}`);
  if (!img) return false;
  const sub = TILE / f;
  ctx.drawImage(img, (tx % f) * sub, (ty % f) * sub, sub, sub, dx, dy, TILE, TILE);
  return true;
}

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const k = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[y * w + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / k;
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += tmp[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / k;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * Carrega uma grade N x N de tiles em volta de (lat0, lon0) e devolve um terreno métrico.
 * Origem do mundo: (lat0, lon0) com altura 0; +X = leste, -Z = norte, +Y = cima.
 */
export async function loadTerrain({
  lat0,
  lon0,
  zoom = 13,
  grid = 5,
  segments = 255,
  metersPerUnit = 1500, // escala da pseudo-elevação (0..1) para metros (ajustável)
  onProgress = () => {},
}) {
  const half = Math.floor(grid / 2);
  const center = latLonToTile(lat0, lon0, zoom);
  const size = TILE * grid;

  const colorCanvas = makeCanvas(size);
  const cCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
  cCtx.fillStyle = '#2b1d16';
  cCtx.fillRect(0, 0, size, size);
  const reliefCanvas = makeCanvas(size);
  const rCtx = reliefCanvas.getContext('2d', { willReadFrequently: true });
  const hiCanvas = makeCanvas(size);
  const hCtx = hiCanvas.getContext('2d', { willReadFrequently: true });

  const tasks = [];
  let hiriseCount = 0;
  for (let gy = -half; gy <= half; gy++) {
    for (let gx = -half; gx <= half; gx++) {
      const tx = (center.x + gx + center.cols) % center.cols;
      const ty = Math.max(0, Math.min(center.rows - 1, center.y + gy));
      const dx = (gx + half) * TILE;
      const dy = (gy + half) * TILE;
      tasks.push(drawLayerTile(cCtx, LAYERS.color, zoom, tx, ty, dx, dy));
      tasks.push(drawLayerTile(rCtx, LAYERS.relief, zoom, tx, ty, dx, dy));
      if (overlaps(tileBounds(tx, ty, zoom), JEZERO_BOUNDS)) {
        tasks.push(drawLayerTile(hCtx, LAYERS.hirise, zoom, tx, ty, dx, dy).then((ok) => ok && hiriseCount++));
      }
    }
  }
  let done = 0;
  tasks.forEach((t) => t.then(() => onProgress(++done, tasks.length)));
  await Promise.all(tasks);

  // HiRISE por luminosidade sobre a cor Viking (mesma técnica do map-3d)
  if (hiriseCount > 0) {
    cCtx.save();
    cCtx.globalCompositeOperation = 'luminosity';
    cCtx.globalAlpha = 0.88;
    cCtx.drawImage(hiCanvas, 0, 0);
    cCtx.restore();
  }

  // --- Pseudo-elevação (mesma fórmula do map-3d) + detalhe HiRISE para o normal map ---
  const mData = rCtx.getImageData(0, 0, size, size).data;
  const hData = hiriseCount > 0 ? hCtx.getImageData(0, 0, size, size).data : null;
  const macro = new Float32Array(size * size);
  const detail = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const r = mData[i * 4] / 255;
    const g = mData[i * 4 + 1] / 255;
    const b = mData[i * 4 + 2] / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const hypso = (r - b + 1) * 0.5;
    const elev = Math.max(0, Math.min(1, 0.55 * hypso + 0.45 * lum));
    macro[i] = elev;
    if (hData && hData[i * 4 + 3] > 20) {
      const hl = (0.299 * hData[i * 4] + 0.587 * hData[i * 4 + 1] + 0.114 * hData[i * 4 + 2]) / 255;
      detail[i] = 0.65 * elev + 0.35 * hl;
    } else {
      detail[i] = elev;
    }
  }
  // Suaviza artefatos de JPEG/ampliação: em primeira pessoa eles viram "degraus" gigantes.
  const smooth = boxBlur(boxBlur(macro, size, size, 6), size, size, 6);

  // --- Extensão geográfica e métrica da grade ---
  const tl = tileBounds((center.x - half + center.cols) % center.cols, Math.max(0, center.y - half), zoom);
  const br = tileBounds((center.x + half) % center.cols, Math.min(center.rows - 1, center.y + half), zoom);
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const toWorld = (lat, lon) => ({ x: (lon - lon0) * mPerDegLon, z: -(lat - lat0) * M_PER_DEG_LAT });
  const nw = toWorld(tl.latMax, tl.lonMin);
  const se = toWorld(br.latMin, br.lonMax);
  const width = se.x - nw.x;
  const depth = se.z - nw.z;

  // --- Malha com alturas na CPU ---
  const n = segments + 1;
  const raw = new Float32Array(n * n);
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const sx = Math.min(size - 1, Math.round((ix / segments) * (size - 1)));
      const sy = Math.min(size - 1, Math.round((iy / segments) * (size - 1)));
      raw[iy * n + ix] = smooth[sy * size + sx];
    }
  }

  const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);
  geometry.rotateX(-Math.PI / 2); // linha iy=0 vai para -Z (norte), igual à linha 0 do canvas
  geometry.translate(nw.x + width / 2, 0, nw.z + depth / 2);

  const heights = new Float32Array(n * n);
  const cellW = width / segments;
  const cellD = depth / segments;

  // Altura exata sobre os triângulos do PlaneGeometry (diagonal b-d em cada célula)
  function heightAt(x, z) {
    const fxAll = Math.max(0, Math.min(segments - 1e-6, (x - nw.x) / cellW));
    const fyAll = Math.max(0, Math.min(segments - 1e-6, (z - nw.z) / cellD));
    const ix = Math.floor(fxAll);
    const iy = Math.floor(fyAll);
    const fx = fxAll - ix;
    const fy = fyAll - iy;
    const a = heights[iy * n + ix];
    const d = heights[iy * n + ix + 1];
    const b = heights[(iy + 1) * n + ix];
    const c = heights[(iy + 1) * n + ix + 1];
    if (fx + fy <= 1) return a + (d - a) * fx + (b - a) * fy;
    return c + (b - c) * (1 - fx) + (d - c) * (1 - fy);
  }

  // Reaplica a escala vertical (para o controle de exagero do relevo). Mantém o ponto de
  // partida em y = 0 para boa precisão perto da câmera.
  function setVerticalScale(mpu) {
    const pos = geometry.attributes.position;
    for (let i = 0; i < n * n; i++) heights[i] = raw[i] * mpu;
    const h0 = heightAt(0, 0);
    for (let i = 0; i < n * n; i++) {
      heights[i] -= h0;
      pos.setY(i, heights[i]);
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  }
  setVerticalScale(metersPerUnit);

  // Normal map (Sobel) com o detalhe HiRISE
  const normalCanvas = makeCanvas(size);
  const nCtx = normalCanvas.getContext('2d');
  const nImg = nCtx.createImageData(size, size);
  const strength = 6.5;
  for (let y = 0; y < size; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(size - 1, y + 1);
    for (let x = 0; x < size; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(size - 1, x + 1);
      const h = (xx, yy) => detail[yy * size + xx];
      const ddx = h(xp, ym) + 2 * h(xp, y) + h(xp, yp) - (h(xm, ym) + 2 * h(xm, y) + h(xm, yp));
      const ddy = h(xm, yp) + 2 * h(x, yp) + h(xp, yp) - (h(xm, ym) + 2 * h(x, ym) + h(xp, ym));
      // +X do normal map = leste, +Y = norte (textura com flipY): sobe para o sul => normal inclina p/ norte
      let nx = -ddx * strength;
      let ny = ddy * strength;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      nImg.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      nImg.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      nImg.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      nImg.data[i + 3] = 255;
    }
  }
  nCtx.putImageData(nImg, 0, 0);

  const colorTex = new THREE.CanvasTexture(colorCanvas);
  colorTex.colorSpace = THREE.SRGBColorSpace;
  const normalTex = new THREE.CanvasTexture(normalCanvas);

  const material = new THREE.MeshStandardMaterial({
    map: colorTex,
    normalMap: normalTex,
    normalScale: new THREE.Vector2(1.2, 1.2),
    roughness: 0.95,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geometry, material);

  return {
    mesh,
    material,
    colorCanvas,
    geo: { latMax: tl.latMax, lonMin: tl.lonMin, latMin: br.latMin, lonMax: br.lonMax },
    heightAt,
    setVerticalScale,
    toWorld,
    bounds: { minX: nw.x, maxX: se.x, minZ: nw.z, maxZ: se.z },
    hiriseCount,
    zoom,
  };
}

/**
 * "Remendo" de alta resolução HiRISE perto do usuário, sobre o terreno base.
 * Mesma camada do mapa 3D, num zoom maior. A cor de fundo é recortada do terreno base e o
 * detalhe HiRISE entra por luminosidade com borda em degradê radial, para não haver costura.
 * A geometria segue exatamente base.heightAt, então rota e câmera continuam coerentes.
 */
export async function loadDetailPatch(base, { lat0, lon0, zoom = 16, grid = 5, segments = 200 }) {
  const half = Math.floor(grid / 2);
  const center = latLonToTile(lat0, lon0, zoom);
  const size = TILE * grid;
  const hi = makeCanvas(size);
  const hCtx = hi.getContext('2d');

  const tasks = [];
  for (let gy = -half; gy <= half; gy++) {
    for (let gx = -half; gx <= half; gx++) {
      const tx = center.x + gx;
      const ty = center.y + gy;
      if (!overlaps(tileBounds(tx, ty, zoom), JEZERO_BOUNDS)) continue;
      tasks.push(drawLayerTile(hCtx, LAYERS.hirise, zoom, tx, ty, (gx + half) * TILE, (gy + half) * TILE));
    }
  }
  const ok = (await Promise.all(tasks)).filter(Boolean).length;
  if (ok === 0) return null;

  const tl = tileBounds(center.x - half, center.y - half, zoom);
  const br = tileBounds(center.x + half, center.y + half, zoom);

  // Fundo: recorte da textura de cor do terreno base (mesma área geográfica)
  const g = base.geo;
  const bs = base.colorCanvas.width;
  const sx = ((tl.lonMin - g.lonMin) / (g.lonMax - g.lonMin)) * bs;
  const sy = ((g.latMax - tl.latMax) / (g.latMax - g.latMin)) * bs;
  const sw = ((br.lonMax - tl.lonMin) / (g.lonMax - g.lonMin)) * bs;
  const sh = ((tl.latMax - br.latMin) / (g.latMax - g.latMin)) * bs;
  const out = makeCanvas(size);
  const oCtx = out.getContext('2d');
  oCtx.drawImage(base.colorCanvas, sx, sy, sw, sh, 0, 0, size, size);

  // Detalhe: mesma fusão por luminosidade do map-3d, recortada por máscara radial
  const det = makeCanvas(size);
  const dCtx = det.getContext('2d');
  dCtx.drawImage(out, 0, 0);
  dCtx.globalCompositeOperation = 'luminosity';
  dCtx.globalAlpha = 0.88;
  dCtx.drawImage(hi, 0, 0);
  dCtx.globalAlpha = 1;
  dCtx.globalCompositeOperation = 'destination-in';
  const grad = dCtx.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size * 0.5);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  dCtx.fillStyle = grad;
  dCtx.fillRect(0, 0, size, size);
  oCtx.drawImage(det, 0, 0);

  const nw = base.toWorld(tl.latMax, tl.lonMin);
  const se = base.toWorld(br.latMin, br.lonMax);
  const width = se.x - nw.x;
  const depth = se.z - nw.z;
  const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(nw.x + width / 2, 0, nw.z + depth / 2);

  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const material = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.95,
    metalness: 0,
    polygonOffset: true, // fica "por cima" do terreno base, que ocupa a mesma superfície
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geometry, material);

  function relayout() {
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, base.heightAt(pos.getX(i), pos.getZ(i)));
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  }
  relayout();
  return { mesh, relayout, tiles: ok, zoom };
}
