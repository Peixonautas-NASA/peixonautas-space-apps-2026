// Reproducible crop of the public HRSC DTM. Requires npm ci in this directory.
import { fromArrayBuffer } from 'geotiff';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const sourceUrl = 'https://zenodo.org/records/5808354/files/hrsc_km09_h1938_h1927_h1916-dtm-mosaic.tif?download=1';
const requestedBounds = { latMin: -4.74, latMax: -4.54, lonMin: 137.32, lonMax: 137.54 };
const toArrayBuffer = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
async function readRange(start, end) {
  const length = end - start + 1;
  const { stdout } = await execute('curl.exe', [
    '--silent', '--show-error', '--location', '--fail', '--retry', '2',
    '--range', `${start}-${end}`, '--max-filesize', String(length), sourceUrl
  ], { encoding: 'buffer', maxBuffer: length + 1024, timeout: 180000 });
  if (stdout.length !== length) throw new Error('Unexpected range response length');
  return stdout;
}

const header = await readRange(0, 131071);
const tiff = await fromArrayBuffer(toArrayBuffer(header));
const image = await tiff.getImage();
const directory = image.fileDirectory;
const keys = image.getGeoKeys();
const [ox, oy] = image.getOrigin();
const [sx, sy] = image.getResolution();
const radiusM = keys.GeogSemiMajorAxisGeoKey;
// Explicitly validate the source's planetary CRS, units and encoding.
if (keys.ProjCoordTransGeoKey !== 17 || keys.ProjLinearUnitsGeoKey !== 9001
    || radiusM !== 3396190 || keys.GeogSemiMinorAxisGeoKey !== radiusM
    || keys.ProjFalseEastingGeoKey !== 0 || keys.ProjFalseNorthingGeoKey !== 0
    || sx !== 30 || sy !== -30 || directory.Compression !== 1
    || directory.RowsPerStrip !== 1 || directory.SampleFormat[0] !== 3
    || directory.BitsPerSample[0] !== 32) throw new Error('Unexpected source format or CRS');
const projection = { radiusM, centralLonDeg: keys.ProjCenterLongGeoKey,
  originLatDeg: keys.ProjCenterLatGeoKey, standardParallelDeg: keys.ProjStdParallel1GeoKey };
const rad = Math.PI / 180;
const project = (lat, lon) => [radiusM * (lon - projection.centralLonDeg) * rad
  * Math.cos(projection.standardParallelDeg * rad), radiusM * (lat - projection.originLatDeg) * rad];
const [xmin, ymax] = project(requestedBounds.latMax, requestedBounds.lonMin);
const [xmax, ymin] = project(requestedBounds.latMin, requestedBounds.lonMax);
const x0 = Math.floor((xmin - ox) / sx), x1 = Math.ceil((xmax - ox) / sx);
const y0 = Math.floor((oy - ymax) / sx), y1 = Math.ceil((oy - ymin) / sx);
if (x0 < 0 || y0 < 0 || x1 > image.getWidth() || y1 > image.getHeight()) throw new Error('AOI outside source');
const start = directory.StripOffsets[y0];
const end = directory.StripOffsets[y1 - 1] + directory.StripByteCounts[y1 - 1] - 1;
console.log(`Reading ${((end - start + 1) / 1e6).toFixed(1)} MB for Gale AOI...`);
const rows = await readRange(start, end);
const width = x1 - x0, height = y1 - y0;
const nodata = image.getGDALNoData();
const littleEndian = header.toString('ascii', 0, 2) === 'II';
const elevations = [];
let validCount = 0, minElevationM = Infinity, maxElevationM = -Infinity;
for (let y = y0; y < y1; y++) {
  for (let x = x0; x < x1; x++) {
    const offset = directory.StripOffsets[y] - start + x * 4;
    const value = littleEndian ? rows.readFloatLE(offset) : rows.readFloatBE(offset);
    const valid = Number.isFinite(value) && value !== nodata;
    // Keep Float32 numeric elevations unchanged. Null is an explicit NoData mask.
    elevations.push(valid ? value : null);
    if (valid) { validCount++; minElevationM = Math.min(minElevationM, value); maxElevationM = Math.max(maxElevationM, value); }
  }
}
if (validCount < width * height * 0.95) throw new Error('Insufficient valid coverage in chosen AOI');
const originX = ox + x0 * sx, originY = oy - y0 * sx;
const unproject = (x, y) => ({ lat: projection.originLatDeg + y / radiusM / rad,
  lon: projection.centralLonDeg + x / (radiusM * Math.cos(projection.standardParallelDeg * rad)) / rad });
const nw = unproject(originX, originY), se = unproject(originX + width * sx, originY - height * sx);
const centerLat = (nw.lat + se.lat) / 2;
const data = {
  id: 'gale-hrsc-curiosity-30m-v1', name: 'Gale — Curiosity region and Mount Sharp foothills',
  width, height, pixelSizeM: sx, originX, originY, projection,
  stepXM: sx * Math.cos(centerLat * rad) / Math.cos(projection.standardParallelDeg * rad), stepYM: sx,
  bounds: { latMin: se.lat, latMax: nw.lat, lonMin: nw.lon, lonMax: se.lon },
  source: { title: '30-m HRSC DTM Mosaic of Gale Crater, Mars',
    authors: 'Persaud, Putri & Muller (2021)', doi: '10.5281/zenodo.5808354', url: sourceUrl,
    expectedFullSourceMd5: '1d714f2142a56e962d50d985b7088b13',
    note: 'Source read through HTTP ranges; full-file MD5 was not verified.',
    sourceWindow: [x0, y0, x1, y1], sourceNoData: nodata,
    downloadedRowsSha256: createHash('sha256').update(rows).digest('hex'),
    terrainReference: '200-m MOLA / HRSC blended global DTM (Fergason et al. 2018)',
    createdOn: new Date().toISOString().slice(0, 10) },
  validCount, minElevationM, maxElevationM, elevations
};
const destination = new URL('../../data/gale/', import.meta.url);
await mkdir(destination, { recursive: true });
await writeFile(new URL('terrain.js', destination), '// Numeric HRSC DTM crop; see README.md.\nglobalThis.GALE_TERRAIN_DATA = ' + JSON.stringify(data) + ';\n');
await writeFile(new URL('metadata.json', destination), JSON.stringify({ ...data, elevations: undefined }, null, 2) + '\n');
console.log(JSON.stringify({ destination: fileURLToPath(destination), width, height, validCount,
  bounds: data.bounds, minElevationM, maxElevationM }, null, 2));
