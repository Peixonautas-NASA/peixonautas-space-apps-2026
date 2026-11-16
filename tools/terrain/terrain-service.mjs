import { fromArrayBuffer } from 'geotiff';
import { createHash } from 'node:crypto';
import { CATALOG, HRSC, MOLA_BASE } from './catalog.mjs';

const RAD = Math.PI / 180;
export const LIMITS = { maxCells: 250000, maxDistanceKm: 1500, maxLatitude: 75, maxDownloadBytes: 64 * 1024 * 1024 };
export class TerrainError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function requestArea(input) {
  const { start, goal } = input || {};
  for (const point of [start, goal]) {
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)
        || Math.abs(point.lat) > LIMITS.maxLatitude || Math.abs(point.lon) > 180) {
      throw new TerrainError('Use latitudes between -75° and 75° and longitudes between -180° and 180°.');
    }
  }
  if (Math.abs(start.lon - goal.lon) > 180) throw new TerrainError('Routes crossing the antimeridian are not yet supported.');
  const dlat = (goal.lat - start.lat) * RAD, dlon = (goal.lon - start.lon) * RAD;
  const hav = Math.sin(dlat / 2) ** 2 + Math.cos(start.lat * RAD) * Math.cos(goal.lat * RAD) * Math.sin(dlon / 2) ** 2;
  const distanceKm = 2 * 3396.19 * Math.asin(Math.min(1, Math.sqrt(hav)));
  if (distanceKm > LIMITS.maxDistanceKm) throw new TerrainError('Split the itinerary into stages of up to 1,500 km.');
  const expansion = input.expansion ?? 0;
  if (!Number.isInteger(expansion) || expansion < 0 || expansion > 2) throw new TerrainError('Invalid expansion attempt.');
  const marginKm = Math.min(200, Math.max(2, distanceKm * 0.15) * 2 ** expansion);
  const latitudePadding = marginKm / (3396.19 * RAD);
  const longitudePadding = latitudePadding / Math.cos(Math.max(Math.abs(start.lat), Math.abs(goal.lat)) * RAD);
  return {
    latMin: Math.max(-75, Math.min(start.lat, goal.lat) - latitudePadding),
    latMax: Math.min(75, Math.max(start.lat, goal.lat) + latitudePadding),
    lonMin: Math.max(-180, Math.min(start.lon, goal.lon) - longitudePadding),
    lonMax: Math.min(180, Math.max(start.lon, goal.lon) + longitudePadding),
    marginKm, distanceKm, expansion
  };
}

export function gridLayout(source, bounds) {
  const p = source.projection, pixel = source.nativeResolutionM;
  const projectX = lon => p.radiusM * (lon - p.centralLonDeg) * RAD * Math.cos(p.standardParallelDeg * RAD);
  const projectY = lat => p.radiusM * (lat - p.originLatDeg) * RAD;
  const ox = source.originX ?? 0, oy = source.originY ?? 0;
  const x0 = Math.floor((projectX(bounds.lonMin) - ox) / pixel);
  const x1 = Math.ceil((projectX(bounds.lonMax) - ox) / pixel);
  const y0 = Math.floor((oy - projectY(bounds.latMax)) / pixel);
  const y1 = Math.ceil((oy - projectY(bounds.latMin)) / pixel);
  return { x0, x1, y0, y1, width: x1 - x0, height: y1 - y0,
    originX: ox + x0 * pixel, originY: oy - y0 * pixel };
}
const contains = (a, b) => a.latMin <= b.latMin && a.latMax >= b.latMax && a.lonMin <= b.lonMin && a.lonMax >= b.lonMax;
export function selectSource(bounds, excluded = []) {
  for (const source of CATALOG) {
    if (excluded.includes(source.id) || !contains(source.bounds, bounds)) continue;
    const layout = gridLayout(source, bounds);
    if (layout.width * layout.height <= LIMITS.maxCells) return { source, layout };
  }
  throw new TerrainError('Area too large for the available grid. Reduce the route length or margin.');
}

export class TerrainService {
  constructor(cache) { this.cache = cache; this.prepared = new Map(); this.pending = new Map(); }
  async getTerrain(input) {
    const bounds = requestArea(input);
    const key = createHash('sha256').update(JSON.stringify(bounds)).digest('hex');
    if (this.prepared.has(key)) return { ...this.prepared.get(key), cacheHit: true };
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= 2) throw new TerrainError('Preparing other areas. Wait and try again.', 429);
    const task = this.prepare(bounds, key).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  async prepare(bounds, key) {
    const failures = [], excluded = [];
    for (let attempt = 0; attempt < CATALOG.length; attempt++) {
      let source, layout;
      try { ({ source, layout } = selectSource(bounds, excluded)); }
      catch (error) {
        if (failures.length) throw new TerrainError('Could not retrieve elevation from the available sources. Try again; local Gale is still available.', 502);
        throw error;
      }
      excluded.push(source.id);
      try {
        const elevations = source.id === HRSC.id ? await this.readHrsc(layout) : await this.readMola(source, layout);
        const p = source.projection, pixel = source.nativeResolutionM;
        const lat = y => p.originLatDeg + (layout.originY - y * pixel) / p.radiusM / RAD;
        const lon = x => p.centralLonDeg + (layout.originX + x * pixel) / (p.radiusM * Math.cos(p.standardParallelDeg * RAD)) / RAD;
        const stepXMByRow = Array.from({ length: layout.height }, (_, y) => pixel * Math.cos(lat(y + 0.5) * RAD) / Math.cos(p.standardParallelDeg * RAD));
        const validCount = elevations.reduce((sum, value) => sum + Number(value !== null), 0);
        if (!validCount) throw new Error('No valid cells in this product.');
        const result = {
          id: `${source.id}:${key.slice(0, 16)}`, name: source.title,
          width: layout.width, height: layout.height, pixelSizeM: pixel,
          originX: layout.originX, originY: layout.originY, projection: p,
          stepXM: stepXMByRow[Math.floor(layout.height / 2)], stepYM: pixel, stepXMByRow,
          bounds: { latMin: lat(layout.height), latMax: lat(0), lonMin: lon(0), lonMax: lon(layout.width) },
          source: { id: source.id, title: source.title, doi: source.doi || null, url: source.url,
            nativeResolutionM: pixel, terrainReference: source.terrainReference, note: source.note || null },
          selection: { distanceKm: bounds.distanceKm, marginKm: bounds.marginKm, expansion: bounds.expansion,
            policy: 'Finest single catalog source covering the whole area within 250000 cells; no cross-source stitching.',
            fallbackReasons: failures, localDetailAvailable: source.id === HRSC.id },
          validCount, elevations, cacheHit: false
        };
        if (this.prepared.size >= 8) this.prepared.delete(this.prepared.keys().next().value);
        this.prepared.set(key, result);
        return result;
      } catch (error) {
        failures.push({ source: source.id, reason: error.message.includes('limit') ? error.message : 'Source unavailable or format not confirmed.' });
      }
    }
    throw new TerrainError('Failed to load elevation data.', 502);
  }

  async readHrsc(layout) {
    const header = await this.cache.get(HRSC.url, 0, 131071);
    const image = await (await fromArrayBuffer(header.buffer.slice(header.byteOffset, header.byteOffset + header.byteLength))).getImage();
    const d = image.fileDirectory, k = image.getGeoKeys();
    const [ox, oy] = image.getOrigin(), [sx, sy] = image.getResolution();
    if (header.toString('ascii', 0, 2) !== 'II'
        || image.getWidth() !== HRSC.width || image.getHeight() !== HRSC.height
        || ox !== HRSC.originX || oy !== HRSC.originY || sx !== 30 || sy !== -30
        || k.GeogSemiMajorAxisGeoKey !== HRSC.projection.radiusM || k.ProjCoordTransGeoKey !== 17
        || k.ProjLinearUnitsGeoKey !== 9001 || k.ProjCenterLongGeoKey !== 0 || k.ProjCenterLatGeoKey !== 0
        || k.ProjStdParallel1GeoKey !== 0 || k.ProjFalseEastingGeoKey !== 0 || k.ProjFalseNorthingGeoKey !== 0
        || d.Compression !== 1 || d.RowsPerStrip !== 1 || d.SampleFormat[0] !== 3 || d.BitsPerSample[0] !== 32) {
      throw new Error('HRSC format not confirmed.');
    }
    const values = new Array(layout.width * layout.height).fill(null);
    const noData = image.getGDALNoData();
    let downloaded = 0;
    for (let band = Math.floor(layout.y0 / 32) * 32; band < layout.y1; band += 32) {
      const last = Math.min(HRSC.height, band + 32) - 1;
      const start = d.StripOffsets[band], end = d.StripOffsets[last] + d.StripByteCounts[last] - 1;
      downloaded += end - start + 1;
      if (downloaded > LIMITS.maxDownloadBytes) throw new Error('Crop exceeds the download limit.');
      const bytes = await this.cache.get(HRSC.url, start, end);
      for (let y = Math.max(band, layout.y0); y < Math.min(band + 32, layout.y1); y++) {
        for (let x = layout.x0; x < layout.x1; x++) {
          const value = bytes.readFloatLE(d.StripOffsets[y] - start + x * 4);
          if (Number.isFinite(value) && value !== noData) values[(y - layout.y0) * layout.width + x - layout.x0] = value;
        }
      }
    }
    return values;
  }

  async readMola(source, layout) {
    const ppd = source.ppd, pixel = source.nativeResolutionM, p = source.projection;
    const groups = new Map();
    for (let y = 0; y < layout.height; y++) {
      const lat = (layout.originY - (y + 0.5) * pixel) / p.radiusM / RAD;
      for (let x = 0; x < layout.width; x++) {
        const lon = (layout.originX + (x + 0.5) * pixel) / p.radiusM / RAD;
        const east = ((lon % 360) + 360) % 360;
        const top = ppd === 16 ? 90 : lat >= 44 ? 88 : lat >= 0 ? 44 : lat >= -44 ? 0 : -44;
        const west = ppd === 16 ? 0 : Math.floor(east / 90) * 90;
        const width = ppd === 16 ? 5760 : 11520, height = ppd === 16 ? 2880 : 5632;
        const row = Math.floor((top - lat) * ppd), col = Math.floor((east - west) * ppd);
        if (row < 0 || row >= height || col < 0 || col >= width) throw new Error('MOLA sample outside the product.');
        const file = ppd === 16 ? 'megt90n000eb' : `megt${String(Math.abs(top)).padStart(2, '0')}${top < 0 ? 's' : 'n'}${String(west).padStart(3, '0')}hb`;
        const band = Math.floor(row / 64) * 64;
        const key = `${file}:${band}`;
        if (!groups.has(key)) groups.set(key, { file, band, width, height, locations: [] });
        groups.get(key).locations.push({ index: y * layout.width + x, offset: ((row - band) * width + col) * 2 });
      }
    }
    const expectedBytes = [...groups.values()].reduce((sum, g) => sum + (Math.min(g.height, g.band + 64) - g.band) * g.width * 2, 0);
    if (expectedBytes > LIMITS.maxDownloadBytes) throw new Error('Crop exceeds the download limit.');
    const values = new Array(layout.width * layout.height).fill(null);
    for (const group of groups.values()) {
      const base = `${MOLA_BASE}/meg${String(ppd).padStart(3, '0')}/${group.file}`;
      const start = group.band * group.width * 2;
      const end = Math.min(group.height, group.band + 64) * group.width * 2 - 1;
      const bytes = await this.cache.get(base + '.img', start, end);
      for (const location of group.locations) {
        const value = bytes.readInt16BE(location.offset);
        if (value !== -32768) values[location.index] = value;
      }
    }
    return values;
  }
}
