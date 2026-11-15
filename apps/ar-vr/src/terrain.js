// Mundo caminhável em ESCALA REAL (1 unidade = 1 metro) com o mesmo relevo do apps/map-3d:
// MOLA ClrShade decodificado por cromaticidade (-8,2 a +21,2 km), sombras preenchidas e
// suavização gaussiana (ver mola.js). Cor: Viking. Em Jezero e Gale: detalhe HiRISE perto do usuário.
//
// Organização:
//  - "Bloco" (chunk): 3x3 tiles em z7 (~250 km). É o maior zoom NATIVO do MOLA/Viking no
//    NASA Trek, então mais zoom não traz informação nova de relevo. Quando a pessoa atravessa
//    para outro tile, um novo bloco centrado nela é carregado e substitui o anterior.
//  - "Remendos" HiRISE (Jezero e Gale): texturas de alta resolução misturadas no shader do terreno
//    por posição no mundo. Não são malhas extras, então não há z-fighting nem costura.
//  - Textura procedural de detalhe perto dos pés (não é dado real, só referência visual de
//    movimento). Pode ser desligada nos ajustes.
//
// TODO(packages/shared): geometria de tiles e carregamento WMTS duplicados do map-3d.
import * as THREE from 'three';
import { molaHeightsFromRGBA, normToMeters, MOLA_SPAN_M } from './mola.js';

const TREK = 'https://trek.nasa.gov/tiles/Mars/EQ';
const LAYERS = {
  color: { id: 'Mars_Viking_MDIM21_ClrMosaic_global_232m', ext: 'jpg', maxZ: 7 },
  relief: { id: 'Mars_MGS_MOLA_ClrShade_merge_global_463m', ext: 'jpg', maxZ: 7 },
};
// Mosaicos de alta resolução do NASA Trek (cobertura local). A área de cada um vem do
// WMTSCapabilities.xml do próprio Trek.
export const HIRISE_MOSAICS = [
  {
    // Jezero: HiRISE + CTX + HRSC, tiles até z17 (~0,3 m/px)
    id: 'NES_JEZ_MID_Visible_Mosaic_HiRISE_CTX_HRSC_GCS_MARS_07-10-2018',
    ext: 'png',
    maxZ: 17,
    label: 'HiRISE/CTX Jezero',
    bounds: { lonMin: 76.79, lonMax: 77.74, latMin: 17.57, latMax: 18.88 },
  },
  {
    // Gale: mosaico HiRISE da área do Curiosity (camada do bookmark "Curiosity Landing Site"), até z16
    id: 'curiosity_hirise_mosaic',
    ext: 'png',
    maxZ: 16,
    label: 'HiRISE Curiosity (Gale)',
    bounds: { lonMin: 137.1224669, lonMax: 137.7298129, latMin: -4.9254743, latMax: -4.2489588 },
  },
  {
    // Gale inteira: mosaico CTX (MRO), ~6 m/px, até z12
    id: 'Gale_CTX_BlockAdj_dd',
    ext: 'png',
    maxZ: 12,
    label: 'CTX Gale',
    bounds: { lonMin: 135.1842593, lonMax: 139.2413012, latMin: -6.5732988, latMax: -2.8077809 },
  },
];

export const MARS_RADIUS_M = 3389500;
export const M_PER_DEG_LAT = (2 * Math.PI * MARS_RADIUS_M) / 360; // ~59 158 m
const TILE = 256;
const CHUNK_ZOOM = 7;
const CHUNK_SEGMENTS = 383; // ~650 m entre vértices; o MOLA tem ~330 m/px em z7
const SMOOTH_RADIUS = 5; // padrão do map-3d em z7

// ---------- Tiles (equirretangular 2^(z+1) x 2^z, como no map-3d) ----------
function latLonToTile(lat, lon, z) {
  const cols = 2 ** (z + 1);
  const rows = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * cols);
  const y = Math.floor(((90 - lat) / 180) * rows);
  return { x: Math.max(0, Math.min(cols - 1, x)), y: Math.max(0, Math.min(rows - 1, y)), cols, rows };
}
function tileBounds(tx, ty, z) {
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
/** Mosaico de alta resolução que cobre o ponto (o mais detalhado), ou null. */
export const hiriseMosaicAt = (lat, lon) =>
  HIRISE_MOSAICS.filter((m) => overlaps({ lonMin: lon, lonMax: lon, latMin: lat, latMax: lat }, m.bounds)).sort(
    (a, b) => b.maxZ - a.maxZ
  )[0] ?? null;

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
async function drawLayerTile(ctx, layer, z, tx, ty, dx, dy) {
  const nz = Math.min(z, layer.maxZ);
  const f = 2 ** (z - nz);
  const img = await fetchImage(
    `${TREK}/${layer.id}/1.0.0/default/default028mm/${nz}/${Math.floor(ty / f)}/${Math.floor(tx / f)}.${layer.ext}`
  );
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

/**
 * Imagem REAL do NASA Trek para um quadrado do mundo [cx +- half] x [cz +- half], sem filtros:
 * mosaico Viking MDIM 2.1 e, onde houver cobertura (Jezero, Gale), o mosaico HiRISE por cima.
 * Cada camada é baixada no zoom NATIVO que corresponde à resolução pedida (Viking até z7, HiRISE
 * até z17) e desenhada pela posição real dos tiles, sem "zoom esticado" de tile único.
 *  - hi-res orbital mosaics are overlaid where available (Jezero HiRISE or Curiosity HiRISE/CTX);
 *  - hirise: 'map2d' = image overlay (opacidade 0,9);
 *            'map3d' = mistura de luminosidade (0,88).
 */
export async function composeRegionImage(
  world,
  cx,
  cz,
  half,
  { size = 1024, hirise = 'map2d', maxTiles = 64, halfZ = half } = {}
) {
  const nw = world.toLatLon(cx - half, cz - halfZ);
  const se = world.toLatLon(cx + half, cz + halfZ);
  const box = { lonMin: nw.lon, lonMax: se.lon, latMax: nw.lat, latMin: se.lat };
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2b1d16';
  ctx.fillRect(0, 0, size, size);
  const mpp = (2 * half) / size;
  const zFor = (maxZ) => Math.max(0, Math.min(maxZ, Math.ceil(Math.log2(((180 / TILE) * M_PER_DEG_LAT) / mpp))));
  const toPx = (lat, lon) => [
    ((lon - box.lonMin) / (box.lonMax - box.lonMin)) * size,
    ((box.latMax - lat) / (box.latMax - box.latMin)) * size,
  ];

  async function drawLayer(target, layer, zWanted) {
    let z = zWanted;
    let a;
    let b;
    for (;;) {
      a = latLonToTile(box.latMax, box.lonMin, z);
      b = latLonToTile(box.latMin, box.lonMax, z);
      if ((b.x - a.x + 1) * (b.y - a.y + 1) <= maxTiles || z === 0) break;
      z--;
    }
    const jobs = [];
    for (let ty = a.y; ty <= b.y; ty++) {
      for (let tx = a.x; tx <= b.x; tx++) {
        const url = `${TREK}/${layer.id}/1.0.0/default/default028mm/${z}/${ty}/${tx}.${layer.ext}`;
        jobs.push(
          fetchImage(url).then((img) => {
            if (!img) return 0;
            const t = tileBounds(tx, ty, z);
            const [x0, y0] = toPx(t.latMax, t.lonMin);
            const [x1, y1] = toPx(t.latMin, t.lonMax);
            target.drawImage(img, x0, y0, x1 - x0, y1 - y0);
            return 1;
          })
        );
      }
    }
    const loaded = (await Promise.all(jobs)).reduce((s, v) => s + v, 0);
    return { z, loaded };
  }

  ctx.imageSmoothingQuality = 'high';
  const viking = await drawLayer(ctx, LAYERS.color, zFor(LAYERS.color.maxZ));
  const sources = [`Viking MDIM 2.1 z${viking.z}`];
  let mPerPx = ((180 / 2 ** viking.z) * M_PER_DEG_LAT) / TILE;
  for (const mosaic of [...HIRISE_MOSAICS].sort((a, b) => a.maxZ - b.maxZ)) {
    if (!overlaps(box, mosaic.bounds)) continue;
    const hiCanvas = makeCanvas(size);
    const hiCtx = hiCanvas.getContext('2d');
    hiCtx.imageSmoothingQuality = 'high';
    const hi = await drawLayer(hiCtx, mosaic, zFor(mosaic.maxZ));
    if (hi.loaded) {
      ctx.save();
      if (hirise === 'map3d') {
        ctx.globalCompositeOperation = 'luminosity';
        ctx.globalAlpha = 0.88;
      } else ctx.globalAlpha = 0.9;
      ctx.drawImage(hiCanvas, 0, 0);
      ctx.restore();
      sources.push(`${mosaic.label} z${hi.z}`);
      mPerPx = ((180 / 2 ** hi.z) * M_PER_DEG_LAT) / TILE;
    }
  }
  return { canvas, sources, mPerPx };
}

// ---------- Shader do terreno: remendos HiRISE + detalhe procedural ----------
/** Retângulo (xMin, zMin, xMax, zMax) onde a malha não desenha: ali há uma malha mais detalhada. */
export const makeHoleUniform = () => ({ value: new THREE.Vector4(1, 1, -1, -1) });

function makeTerrainUniforms() {
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  blank.needsUpdate = true;
  return {
    uP1: { value: blank }, uR1: { value: new THREE.Vector4() }, uH1: { value: 0 },
    uP2: { value: blank }, uR2: { value: new THREE.Vector4() }, uH2: { value: 0 },
    uDetail: { value: 1 },
  };
}
export function enhanceTerrainMaterial(material, uniforms, hole = makeHoleUniform()) {
  material.userData.hole = hole;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uHole: hole });
    shader.vertexShader =
      'varying vec3 vWPos;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    shader.fragmentShader =
      /* glsl */ `
varying vec3 vWPos;
uniform vec4 uHole;
uniform sampler2D uP1; uniform vec4 uR1; uniform float uH1;
uniform sampler2D uP2; uniform vec4 uR2; uniform float uH2;
uniform float uDetail;
float pxHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float pxNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(pxHash(i), pxHash(i + vec2(1.0, 0.0)), u.x), mix(pxHash(i + vec2(0.0, 1.0)), pxHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec4 pxPatch(sampler2D t, vec4 r, vec2 p) {
  vec2 uv = (p - r.xy) / (r.zw - r.xy);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
  return texture2D(t, vec2(uv.x, 1.0 - uv.y));
}
` +
      shader.fragmentShader.replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
  {
    vec2 p = vWPos.xz;
    if (p.x > uHole.x && p.x < uHole.z && p.y > uHole.y && p.y < uHole.w) discard;
    if (uH1 > 0.5) { vec4 c = pxPatch(uP1, uR1, p); diffuseColor.rgb = mix(diffuseColor.rgb, c.rgb, c.a); }
    if (uH2 > 0.5) { vec4 c = pxPatch(uP2, uR2, p); diffuseColor.rgb = mix(diffuseColor.rgb, c.rgb, c.a); }
    float fade = (1.0 - smoothstep(15.0, 350.0, distance(vWPos, cameraPosition))) * uDetail;
    if (fade > 0.001) {
      // Cada oitava some (vira a média 0,5) quando fica menor que ~1 pixel: evita serrilhado de raspão
      float fw = length(fwidth(p));
      float w1 = 1.0 - smoothstep(0.25, 0.7, fw * 1.3);
      float w2 = 1.0 - smoothstep(0.25, 0.7, fw * 0.37);
      float w3 = 1.0 - smoothstep(0.25, 0.7, fw * 0.05);
      float n = mix(0.5, pxNoise(p * 1.3), w1) * 0.25
              + mix(0.5, pxNoise(p * 0.37), w2) * 0.35
              + mix(0.5, pxNoise(p * 0.05), w3) * 0.4;
      diffuseColor.rgb *= mix(1.0, 0.72 + 0.56 * n, fade);
    }
  }`
      );
  };
}

// ---------- Bloco de terreno ----------
async function buildChunk(world, tileX, tileY, exag, onProgress) {
  const z = CHUNK_ZOOM;
  const { cols, rows } = latLonToTile(0, 0, z);
  const size = TILE * 3;
  const colorCanvas = makeCanvas(size);
  const cCtx = colorCanvas.getContext('2d');
  cCtx.fillStyle = '#2b1d16';
  cCtx.fillRect(0, 0, size, size);
  const reliefCanvas = makeCanvas(size);
  const rCtx = reliefCanvas.getContext('2d', { willReadFrequently: true });

  const tasks = [];
  for (let gy = -1; gy <= 1; gy++) {
    for (let gx = -1; gx <= 1; gx++) {
      const tx = (tileX + gx + cols) % cols;
      const ty = Math.max(0, Math.min(rows - 1, tileY + gy));
      tasks.push(drawLayerTile(cCtx, LAYERS.color, z, tx, ty, (gx + 1) * TILE, (gy + 1) * TILE));
      tasks.push(drawLayerTile(rCtx, LAYERS.relief, z, tx, ty, (gx + 1) * TILE, (gy + 1) * TILE));
    }
  }
  let done = 0;
  tasks.forEach((t) => t.then(() => onProgress?.(++done, tasks.length)));
  await Promise.all(tasks);
  await new Promise((r) => setTimeout(r, 0)); // deixa a tela atualizar antes do cálculo pesado

  const norm = molaHeightsFromRGBA(rCtx.getImageData(0, 0, size, size).data, size, size, SMOOTH_RADIUS);

  const tl = tileBounds(tileX - 1, Math.max(0, tileY - 1), z);
  const br = tileBounds(tileX + 1, Math.min(rows - 1, tileY + 1), z);
  const nw = world.toWorld(tl.latMax, tl.lonMin);
  const se = world.toWorld(br.latMin, br.lonMax);
  const width = se.x - nw.x;
  const depth = se.z - nw.z;

  const seg = CHUNK_SEGMENTS;
  const n = seg + 1;
  const vNorm = new Float32Array(n * n);
  for (let iy = 0; iy < n; iy++) {
    const fy = (iy / seg) * (size - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(size - 1, y0 + 1);
    const ty = fy - y0;
    for (let ix = 0; ix < n; ix++) {
      const fx = (ix / seg) * (size - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(size - 1, x0 + 1);
      const tx = fx - x0;
      const h0 = norm[y0 * size + x0] + (norm[y0 * size + x1] - norm[y0 * size + x0]) * tx;
      const h1 = norm[y1 * size + x0] + (norm[y1 * size + x1] - norm[y1 * size + x0]) * tx;
      vNorm[iy * n + ix] = h0 + (h1 - h0) * ty;
    }
  }

  const geometry = new THREE.PlaneGeometry(width, depth, seg, seg);
  geometry.rotateX(-Math.PI / 2); // linha iy=0 -> -Z (norte), igual à linha 0 do canvas
  geometry.translate(nw.x + width / 2, 0, nw.z + depth / 2);
  // Relevo REAL (DEM oficial) onde houver: substitui a reconstrução por cromaticidade, com
  // transição suave na borda da janela do DEM. NaN = sem DEM (fica a reconstrução).
  const real = new Float32Array(n * n).fill(NaN);
  const realW = new Float32Array(n * n);
  if (world.dem) {
    const gpos = geometry.attributes.position;
    for (let i = 0; i < n * n; i++) {
      const ll = world.toLatLon(gpos.getX(i), gpos.getZ(i));
      const h = world.dem.heightAt(ll.lat, ll.lon);
      if (h !== null) {
        real[i] = h;
        realW[i] = world.dem.edgeWeight(ll.lat, ll.lon);
      }
    }
  }
  const heights = new Float32Array(n * n);
  const cellW = width / seg;
  const cellD = depth / seg;

  // Altura exata sobre os triângulos do PlaneGeometry (diagonal b-d em cada célula)
  function heightAt(x, zz) {
    const fxAll = Math.max(0, Math.min(seg - 1e-6, (x - nw.x) / cellW));
    const fyAll = Math.max(0, Math.min(seg - 1e-6, (zz - nw.z) / cellD));
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

  // Normal map (Sobel) a partir da elevação suavizada, com declive físico como no map-3d.
  // Sinal de Y: +V da textura aponta para o norte (flipY), então subir para o sul => normal para o norte.
  function buildNormalMap(ex) {
    const c = makeCanvas(size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const scaleX = (ex * MOLA_SPAN_M * size) / (8 * width);
    const scaleZ = (ex * MOLA_SPAN_M * size) / (8 * depth);
    for (let y = 0; y < size; y++) {
      const ym = Math.max(0, y - 1) * size;
      const y0 = y * size;
      const yp = Math.min(size - 1, y + 1) * size;
      for (let x = 0; x < size; x++) {
        const xm = Math.max(0, x - 1);
        const xp = Math.min(size - 1, x + 1);
        const dx = norm[ym + xp] + 2 * norm[y0 + xp] + norm[yp + xp] - (norm[ym + xm] + 2 * norm[y0 + xm] + norm[yp + xm]);
        const dy = norm[yp + xm] + 2 * norm[yp + x] + norm[yp + xp] - (norm[ym + xm] + 2 * norm[ym + x] + norm[ym + xp]);
        const nx = Math.max(-2.5, Math.min(2.5, -dx * scaleX));
        const ny = Math.max(-2.5, Math.min(2.5, dy * scaleZ));
        const len = Math.hypot(nx, ny, 1);
        const i = (y0 + x) * 4;
        img.data[i] = (nx / len) * 127.5 + 127.5;
        img.data[i + 1] = (ny / len) * 127.5 + 127.5;
        img.data[i + 2] = (1 / len) * 127.5 + 127.5;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  }

  const colorTex = new THREE.CanvasTexture(colorCanvas);
  colorTex.colorSpace = THREE.SRGBColorSpace;
  colorTex.anisotropy = 8;
  const material = new THREE.MeshStandardMaterial({ map: colorTex, roughness: 0.92, metalness: 0.02 });
  enhanceTerrainMaterial(material, world.uniforms, world.chunkHole);
  const mesh = new THREE.Mesh(geometry, material);
  if (world.dem) {
    // Na cratera: textura mais fina (CTX ~6 m/px + HiRISE) para o bloco inteiro, baixada em segundo plano
    composeRegionImage(world, nw.x + width / 2, nw.z + depth / 2, width / 2, {
      halfZ: depth / 2,
      size: 4096,
      hirise: 'map3d',
      maxTiles: 160,
    }).then((img) => {
      if (!img.sources.some((src) => src.startsWith('CTX'))) return;
      const tex = new THREE.CanvasTexture(img.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      material.map = tex;
      material.needsUpdate = true;
      colorTex.dispose();
    });
  }

  function setExag(ex) {
    const pos = geometry.attributes.position;
    for (let i = 0; i < n * n; i++) {
      const mola = normToMeters(vNorm[i], ex);
      heights[i] = Number.isNaN(real[i]) ? mola : mola + (real[i] * ex - mola) * realW[i];
      pos.setY(i, heights[i]);
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    // Tangentes explícitas: sem elas o three.js deriva o referencial do normal map de dFdx(uv),
    // que perde precisão perto da câmera num bloco de ~250 km (vira "chuvisco" escuro).
    geometry.computeTangents();
    geometry.computeBoundingSphere();
    material.normalMap?.dispose();
    // Com DEM real, as normais da própria malha valem; o normal map da cromaticidade estaria errado
    material.normalMap = world.dem ? null : buildNormalMap(ex);
    material.needsUpdate = true;
  }
  setExag(exag);

  return {
    mesh,
    tileX,
    tileY,
    heightAt,
    setExag,
    colorCanvas, // mosaico Viking do bloco (usado pelos mapas em miniatura)
    bounds: { minX: nw.x, maxX: se.x, minZ: nw.z, maxZ: se.z },
    dispose() {
      geometry.dispose();
      colorTex.dispose();
      material.normalMap?.dispose();
      material.dispose();
    },
  };
}

// ---------- Remendo HiRISE (textura misturada no shader) ----------
async function buildHirisePatch(world, lat, lon, zoom, grid, mosaic) {
  const half = Math.floor(grid / 2);
  const center = latLonToTile(lat, lon, zoom);
  const size = TILE * grid;
  const viking = makeCanvas(size);
  const vCtx = viking.getContext('2d');
  const hi = makeCanvas(size);
  const hCtx = hi.getContext('2d');
  const tasks = [];
  for (let gy = -half; gy <= half; gy++) {
    for (let gx = -half; gx <= half; gx++) {
      const tx = center.x + gx;
      const ty = center.y + gy;
      if (!overlaps(tileBounds(tx, ty, zoom), mosaic.bounds)) continue;
      const dx = (gx + half) * TILE;
      const dy = (gy + half) * TILE;
      tasks.push(drawLayerTile(vCtx, LAYERS.color, zoom, tx, ty, dx, dy));
      tasks.push(drawLayerTile(hCtx, mosaic, zoom, tx, ty, dx, dy).then((ok) => (ok ? 1 : 0)));
    }
  }
  const results = await Promise.all(tasks);
  if (!results.some((r) => r === 1)) return null;

  // Mesma fusão do map-3d: luminosidade HiRISE sobre a cor Viking
  const out = makeCanvas(size);
  const o = out.getContext('2d');
  o.drawImage(viking, 0, 0);
  o.globalCompositeOperation = 'luminosity';
  o.globalAlpha = 0.88;
  o.drawImage(hi, 0, 0);
  o.globalAlpha = 1;
  // Transparente onde não há HiRISE e nas bordas (degradê radial), para fundir sem costura
  o.globalCompositeOperation = 'destination-in';
  o.drawImage(hi, 0, 0);
  const grad = o.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size * 0.5);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  o.fillStyle = grad;
  o.fillRect(0, 0, size, size);

  const tl = tileBounds(center.x - half, center.y - half, zoom);
  const br = tileBounds(center.x + half, center.y + half, zoom);
  const nw = world.toWorld(tl.latMax, tl.lonMin);
  const se = world.toWorld(br.latMin, br.lonMax);
  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, rect: new THREE.Vector4(nw.x, nw.z, se.x, se.z), cx: (nw.x + se.x) / 2, cz: (nw.z + se.z) / 2 };
}

// ---------- Mundo ----------
export class TerrainWorld {
  constructor(scene, anchor) {
    this.scene = scene;
    this.anchor = anchor; // { lat, lon } = origem do mundo
    this.mPerDegLon = M_PER_DEG_LAT * Math.cos((anchor.lat * Math.PI) / 180);
    this.uniforms = makeTerrainUniforms();
    this.exag = 1;
    this.chunk = null;
    this.loadingChunk = false;
    this.onChunkChange = () => {};
    this.dem = null; // relevo real (GaleDem), quando o local tem
    this.chunkHole = makeHoleUniform();
    this.patches = [
      { zoom: 12, grid: 5, recenterDist: 3000, slot: 1, cur: null, loading: false }, // ~13 km, ~10 m/px
      { zoom: 16, grid: 7, recenterDist: 300, slot: 2, cur: null, loading: false }, // ~1,1 km, ~0,65 m/px
    ];
  }

  toWorld(lat, lon) {
    return { x: (lon - this.anchor.lon) * this.mPerDegLon, z: -(lat - this.anchor.lat) * M_PER_DEG_LAT };
  }
  toLatLon(x, z) {
    return { lat: this.anchor.lat - z / M_PER_DEG_LAT, lon: this.anchor.lon + x / this.mPerDegLon };
  }
  heightAt(x, z) {
    if (this.dem) {
      const ll = this.toLatLon(x, z);
      // fora da faixa de transição da borda, o DEM puro (igual às malhas detalhadas)
      if (this.dem.edgeWeight(ll.lat, ll.lon) >= 1) {
        const h = this.dem.heightAt(ll.lat, ll.lon);
        if (h !== null) return h * this.exag;
      }
    }
    return this.chunk ? this.chunk.heightAt(x, z) : 0;
  }
  /** Limite para não sair da malha enquanto o próximo bloco carrega. */
  clampToBounds(p) {
    if (!this.chunk) return;
    const b = this.chunk.bounds;
    const m = 500;
    p.x = Math.max(b.minX + m, Math.min(b.maxX - m, p.x));
    p.z = Math.max(b.minZ + m, Math.min(b.maxZ - m, p.z));
    if (this.dem) {
      // Exploração limitada à área com relevo real (a cratera)
      const d = this.dem.bounds;
      const nw = this.toWorld(d.latMax, d.lonMin);
      const se = this.toWorld(d.latMin, d.lonMax);
      const mm = 2000;
      p.x = Math.max(nw.x + mm, Math.min(se.x - mm, p.x));
      p.z = Math.max(nw.z + mm, Math.min(se.z - mm, p.z));
    }
  }

  async init(onProgress) {
    const t = latLonToTile(this.anchor.lat, this.anchor.lon, CHUNK_ZOOM);
    this.chunk = await buildChunk(this, t.x, t.y, this.exag, onProgress);
    this.scene.add(this.chunk.mesh);
  }

  setExag(ex) {
    this.exag = ex;
    this.chunk?.setExag(ex);
  }
  setDetail(on) {
    this.uniforms.uDetail.value = on ? 1 : 0;
  }
  get hiriseActive() {
    return this.patches.some((p) => p.cur);
  }

  /** Chamado a cada quadro com a posição da câmera: troca de bloco e recentra remendos. */
  update(pos) {
    if (!this.chunk) return;
    const { lat, lon } = this.toLatLon(pos.x, pos.z);
    const t = latLonToTile(lat, lon, CHUNK_ZOOM);
    if (!this.loadingChunk && (t.x !== this.chunk.tileX || t.y !== this.chunk.tileY)) {
      this.loadingChunk = true;
      buildChunk(this, t.x, t.y, this.exag)
        .then((c) => {
          const old = this.chunk;
          this.chunk = c;
          this.scene.add(c.mesh);
          this.scene.remove(old.mesh);
          old.dispose();
          this.onChunkChange();
        })
        .catch((e) => console.warn('Falha ao carregar bloco de terreno', e))
        .finally(() => (this.loadingChunk = false));
    }

    const mosaic = hiriseMosaicAt(lat, lon);
    if (!mosaic) return;
    for (const p of this.patches) {
      if (p.loading) continue;
      if (p.cur && Math.hypot(pos.x - p.cur.cx, pos.z - p.cur.cz) < p.recenterDist) continue;
      if (p.failedAt && Math.hypot(pos.x - p.failedAt.x, pos.z - p.failedAt.z) < p.recenterDist) continue;
      p.loading = true;
      buildHirisePatch(this, lat, lon, p.zoom, p.grid, mosaic)
        .then((r) => {
          if (!r) {
            p.failedAt = { x: pos.x, z: pos.z };
            return;
          }
          p.cur?.tex.dispose();
          p.cur = r;
          this.uniforms[`uP${p.slot}`].value = r.tex;
          this.uniforms[`uR${p.slot}`].value.copy(r.rect);
          this.uniforms[`uH${p.slot}`].value = 1;
        })
        .catch((e) => console.warn('Falha no remendo HiRISE', e))
        .finally(() => (p.loading = false));
    }
  }

  /** Ponto mais plano até `radius` metros de (x, z), levemente preferindo os mais próximos. */
  findFlatSpot(x, z, radius = 15000, step = 400) {
    let best = { x, z };
    let bestScore = Infinity;
    const probe = 120;
    for (let dz = -radius; dz <= radius; dz += step) {
      for (let dx = -radius; dx <= radius; dx += step) {
        const d = Math.hypot(dx, dz);
        if (d > radius) continue;
        const px = x + dx;
        const pz = z + dz;
        const sx = this.heightAt(px + probe, pz) - this.heightAt(px - probe, pz);
        const sz = this.heightAt(px, pz + probe) - this.heightAt(px, pz - probe);
        const slope = Math.hypot(sx, sz) / (2 * probe);
        const score = slope + (d / radius) * 0.02; // desempate pela distância
        if (score < bestScore) {
          bestScore = score;
          best = { x: px, z: pz, slope };
        }
      }
    }
    return best;
  }

  /** Direção (yaw) mais plana para caminhar `len` metros a partir de (x, z): menor desnível entre passos. */
  yawFlattest(x, z, len = 800, step = 40) {
    let best = Infinity;
    let bestYaw = 0;
    for (let a = 0; a < 72; a++) {
      const yaw = (a / 72) * Math.PI * 2;
      const sx = -Math.sin(yaw);
      const sz = -Math.cos(yaw);
      let prev = this.heightAt(x, z);
      let worst = 0;
      for (let d = step; d <= len; d += step) {
        const h = this.heightAt(x + sx * d, z + sz * d);
        worst = Math.max(worst, Math.abs(h - prev));
        prev = h;
      }
      if (worst < best) {
        best = worst;
        bestYaw = yaw;
      }
    }
    return bestYaw;
  }

  /** Direção (yaw) do ponto mais alto num anel em volta de (x, z). */
  yawToHighest(x, z, rMin = 3000, rMax = 25000) {
    let best = -Infinity;
    let bestYaw = 0;
    for (let a = 0; a < 72; a++) {
      const yaw = (a / 72) * Math.PI * 2;
      for (let r = rMin; r <= rMax; r += (rMax - rMin) / 8) {
        const h = this.heightAt(x - Math.sin(yaw) * r, z - Math.cos(yaw) * r);
        if (h > best) {
          best = h;
          bestYaw = yaw;
        }
      }
    }
    return bestYaw;
  }
}
