// Relevo REAL da Cratera Gale (gerado por tools/build_gale_dem.py a partir dos DEMs oficiais do USGS):
//  - hirise_2m: DEM HiRISE (MSL Gale Merged DEM 1m), média 2 x 2 m, 3 x 3 km em volta do ponto;
//  - hirise_8m: o mesmo DEM, média 8 x 8 m, 12 x 12 km;
//  - crater_200m: DEM HRSC + MOLA (Blended Global 200m), a cratera inteira.
// heightAt(lat, lon) devolve a altitude (m) da fonte mais detalhada que cobre o ponto, ou null.
// Nas bordas de cada grade fina, há uma faixa de transição para a grade de baixo (sem degrau).

const BASE = `${import.meta.env.BASE_URL}gale/`;

function bilinear(get, w, h, fx, fy) {
  if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) return null;
  const x0 = Math.min(w - 2, Math.floor(fx));
  const y0 = Math.min(h - 2, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const a = get(x0, y0);
  const b = get(x0 + 1, y0);
  const c = get(x0, y0 + 1);
  const d = get(x0 + 1, y0 + 1);
  if (a === null || b === null || c === null || d === null) return null;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

export class GaleDem {
  static async load() {
    const meta = await (await fetch(`${BASE}meta.json`)).json();
    const bin = async (f) => (await fetch(`${BASE}${f}`)).arrayBuffer();
    const crater = { ...meta.crater, data: new Int16Array(await bin(meta.crater.file)) };
    const levels = [];
    for (const m of meta.levels) levels.push({ ...m, data: new Uint16Array(await bin(m.file)) });
    levels.sort((a, b) => a.cell - b.cell); // mais fino primeiro
    return new GaleDem(meta, crater, levels);
  }

  constructor(meta, crater, levels) {
    this.meta = meta;
    this.crater = crater;
    this.levels = levels;
    this.bounds = {
      latMax: crater.latMax,
      latMin: crater.latMax - crater.h * crater.step,
      lonMin: crater.lonMin,
      lonMax: crater.lonMin + crater.w * crater.step,
    };
  }

  _crater(lat, lon) {
    const c = this.crater;
    const get = (x, y) => {
      const v = c.data[y * c.w + x];
      return v === c.nodata ? null : v;
    };
    return bilinear(get, c.w, c.h, (lon - c.lonMin) / c.step - 0.5, (c.latMax - lat) / c.step - 0.5);
  }

  /** Valor numa grade HiRISE e o peso de borda (1 no miolo, 0 na borda). */
  _level(L, lat, lon) {
    const x = L.R * ((lon * Math.PI) / 180);
    const y = L.R * ((lat * Math.PI) / 180);
    const fx = (x - L.x0) / L.cell - 0.5;
    const fy = (L.y0 - y) / L.cell - 0.5;
    const get = (i, j) => {
      const v = L.data[j * L.w + i];
      return v === 0 ? null : L.base + v / 10;
    };
    const v = bilinear(get, L.w, L.h, fx, fy);
    if (v === null) return null;
    const band = Math.max(4, L.w * 0.06); // faixa de transição: 6% da grade
    const edge = Math.min(fx, fy, L.w - 1 - fx, L.h - 1 - fy);
    return { v, w: Math.max(0, Math.min(1, edge / band)) };
  }

  inside(lat, lon) {
    const b = this.bounds;
    return lat <= b.latMax && lat >= b.latMin && lon >= b.lonMin && lon <= b.lonMax;
  }

  /** 1 longe da borda da janela do DEM da cratera; cai para 0 numa faixa de 0,2° (~12 km). */
  edgeWeight(lat, lon) {
    const b = this.bounds;
    const d = Math.min(lat - b.latMin, b.latMax - lat, lon - b.lonMin, b.lonMax - lon);
    return Math.max(0, Math.min(1, d / 0.2));
  }

  /** Altitude real (m) ou null fora da cratera. */
  heightAt(lat, lon) {
    let h = this._crater(lat, lon);
    if (h === null) return null;
    // da grade mais grossa para a mais fina, cada uma misturada pelo peso de borda
    for (let i = this.levels.length - 1; i >= 0; i--) {
      const r = this._level(this.levels[i], lat, lon);
      if (r) h = h + (r.v - h) * r.w;
    }
    return h;
  }

  /** Resolução (m) do dado mais fino neste ponto. */
  resolutionAt(lat, lon) {
    for (const L of this.levels) {
      const r = this._level(L, lat, lon);
      if (r && r.w > 0.5) return L.cell;
    }
    return this._crater(lat, lon) === null ? null : 200;
  }
}
