// Reconstrução de elevação a partir do MOLA ClrShade por CROMATICIDADE: porta fiel do
// apps/map-3d/index.html (commit 24d10b3). A matemática é a mesma; só os laços foram
// reescritos sem alocar arrays por pixel, para rodar mais rápido no celular.
//
// TODO(packages/shared): este arquivo é cópia do map-3d. Proposta: mover para packages/shared.

export const MOLA_MIN_ELEV_M = -8200; // Hellas Planitia
export const MOLA_MAX_ELEV_M = 21200; // cume do Olympus Mons
export const MOLA_SPAN_M = MOLA_MAX_ELEV_M - MOLA_MIN_ELEV_M; // 29 400 m

// Polilinha em cromaticidade L1 normalizada (cr, cg, cb): sem wrap de 360° e invariante a sombras
const CHROMA_STOPS = [
  { t: 0.0, c: [0.26, 0.0, 0.74] }, // -8,2 km  índigo/violeta
  { t: 0.14, c: [0.0, 0.22, 0.78] }, // -4,1 km azul profundo
  { t: 0.28, c: [0.0, 0.49, 0.51] }, //  0,0 km ciano (datum)
  { t: 0.42, c: [0.0, 0.92, 0.08] }, // +4,1 km verde
  { t: 0.56, c: [0.51, 0.49, 0.0] }, // +8,2 km amarelo
  { t: 0.7, c: [0.7, 0.3, 0.0] }, // +12,3 km laranja
  { t: 0.85, c: [1.0, 0.0, 0.0] }, // +16,7 km vermelho
  { t: 0.95, c: [0.68, 0.0, 0.32] }, // +19,7 km magenta (encostas Tharsis/Olympus)
];

/** Devolve t (0..1 de -8,2 a +21,2 km), confiança e se o pixel é branco brilhante. */
export function decodeClrShadeChromaticity(r, g, b) {
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const chroma = maxC - minC;
  const isBrightWhite = maxC > 195 && minC > 175;
  if (chroma < 14) return { t: 0.28, conf: 0, isBrightWhite };

  const dr = r - minC;
  const dg = g - minC;
  const db = b - minC;
  const sum = dr + dg + db || 1;
  const cr = dr / sum;
  const cg = dg / sum;
  const cb = db / sum;

  let bestT = 0.28;
  let bestDistSq = Infinity;
  for (let i = 0; i < CHROMA_STOPS.length - 1; i++) {
    const a = CHROMA_STOPS[i].c;
    const p = CHROMA_STOPS[i + 1].c;
    const vx = p[0] - a[0];
    const vy = p[1] - a[1];
    const vz = p[2] - a[2];
    const vLenSq = vx * vx + vy * vy + vz * vz || 1;
    let u = ((cr - a[0]) * vx + (cg - a[1]) * vy + (cb - a[2]) * vz) / vLenSq;
    u = Math.max(0, Math.min(1, u));
    const dSq = (cr - (a[0] + u * vx)) ** 2 + (cg - (a[1] + u * vy)) ** 2 + (cb - (a[2] + u * vz)) ** 2;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestT = CHROMA_STOPS[i].t + u * (CHROMA_STOPS[i + 1].t - CHROMA_STOPS[i].t);
    }
  }
  return { t: bestT, conf: Math.min(1.0, (chroma - 13) / 42), isBrightWhite };
}

/** Difusão iterativa: preenche sombras do hillshade com a altitude das encostas vizinhas. */
export function inpaintShadows(heights, confs, brightFlags, w, h, iterations = 8) {
  let curH = new Float32Array(heights);
  let curC = new Float32Array(confs);
  let nextH = new Float32Array(w * h);
  let nextC = new Float32Array(w * h);
  const nb = new Int32Array(8);

  for (let iter = 0; iter < iterations; iter++) {
    for (let y = 0; y < h; y++) {
      const rowM = Math.max(0, y - 1) * w;
      const row = y * w;
      const rowP = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++) {
        const idx = row + x;
        if (curC[idx] > 0.35) {
          nextH[idx] = curH[idx];
          nextC[idx] = curC[idx];
          continue;
        }
        const xm = Math.max(0, x - 1);
        const xp = Math.min(w - 1, x + 1);
        let sumHW = curH[idx] * curC[idx] * 2.0;
        let sumW = curC[idx] * 2.0;
        // 8 vizinhos (mesma ordem/peso do map-3d)
        nb[0] = rowM + xm; nb[1] = rowM + x; nb[2] = rowM + xp; nb[3] = row + xm;
        nb[4] = row + xp; nb[5] = rowP + xm; nb[6] = rowP + x; nb[7] = rowP + xp;
        for (let k = 0; k < 8; k++) {
          const n = nb[k];
          const wgt = curC[n];
          if (wgt > 0.01) {
            sumHW += curH[n] * wgt;
            sumW += wgt;
          }
        }
        if (sumW > 0.001) {
          nextH[idx] = sumHW / sumW;
          nextC[idx] = Math.min(0.8, (sumW / 9.0) * 0.9);
        } else {
          nextH[idx] = curH[idx];
          nextC[idx] = curC[idx];
        }
      }
    }
    [curH, nextH] = [nextH, curH];
    [curC, nextC] = [nextC, curC];
  }

  // Eleva cumes brancos só quando a vizinhança já está alta (Tharsis / Olympus Mons)
  for (let i = 0; i < w * h; i++) {
    if (brightFlags[i] && curH[i] > 0.76) {
      const blend = Math.min(1, (curH[i] - 0.76) / 0.16);
      curH[i] = curH[i] * (1 - blend) + blend;
    }
  }
  return curH;
}

function boxBlurPass(src, dst, w, h, radius) {
  const temp = new Float32Array(w * h);
  const diam = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[row + Math.max(0, Math.min(w - 1, k))];
    for (let x = 0; x < w; x++) {
      temp[row + x] = sum / diam;
      sum += src[row + Math.min(w - 1, x + radius + 1)] - src[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += temp[Math.max(0, Math.min(h - 1, k)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / diam;
      sum += temp[Math.min(h - 1, y + radius + 1) * w + x] - temp[Math.max(0, y - radius) * w + x];
    }
  }
}

/** 3 passadas de box blur ≈ gaussiana (igual ao map-3d). */
export function gaussianSmooth3Pass(heights, w, h, radius) {
  if (radius <= 0) return heights;
  const r = Math.max(1, Math.round(radius * 0.65));
  const a = new Float32Array(heights);
  const b = new Float32Array(w * h);
  boxBlurPass(a, b, w, h, r);
  boxBlurPass(b, a, w, h, r);
  boxBlurPass(a, b, w, h, r);
  return b;
}

/** Pipeline completo do map-3d: RGBA do ClrShade -> alturas normalizadas suavizadas (0..1). */
export function molaHeightsFromRGBA(data, w, h, smoothRadius = 5) {
  const raw = new Float32Array(w * h);
  const conf = new Float32Array(w * h);
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = decodeClrShadeChromaticity(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    raw[i] = d.t;
    conf[i] = d.conf;
    bright[i] = d.isBrightWhite ? 1 : 0;
  }
  const filled = inpaintShadows(raw, conf, bright, w, h, 8);
  return gaussianSmooth3Pass(filled, w, h, smoothRadius);
}

export const normToMeters = (t, exag = 1) => (MOLA_MIN_ELEV_M + t * MOLA_SPAN_M) * exag;
