// Curated catalog: numerical elevation only, never optical or hillshade images.
const R = 3396190, RAD = Math.PI / 180;
export const HRSC = {
  id: 'gale-hrsc-30m-v1', title: 'HRSC Gale — Persaud, Putri & Muller (2021)',
  doi: '10.5281/zenodo.5808354', nativeResolutionM: 30,
  url: 'https://zenodo.org/records/5808354/files/hrsc_km09_h1938_h1927_h1916-dtm-mosaic.tif?download=1',
  width: 7584, height: 10275, originX: 8054872.398099138, originY: -176868.30708358268,
  projection: { radiusM: R, centralLonDeg: 0, originLatDeg: 0, standardParallelDeg: 0 },
  bounds: { lonMin: 8054872.398099138 / R / RAD, lonMax: 8282392.398099138 / R / RAD,
    latMin: -485118.3070835827 / R / RAD, latMax: -176868.30708358268 / R / RAD },
  terrainReference: '200-m MOLA/HRSC blended global DTM (Fergason et al. 2018)'
};
export const MOLA_BASE = 'https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived';
export const CATALOG = [HRSC, ...[128, 16].map(ppd => ({
  id: `mola-${ppd}ppd-v2`, title: `MGS MOLA MEGDR ${ppd} px/°`, ppd,
  url: `${MOLA_BASE}/meg${String(ppd).padStart(3, '0')}/`,
  nativeResolutionM: 3396000 * RAD / ppd,
  bounds: { latMin: -75, latMax: 75, lonMin: -180, lonMax: 180 },
  projection: { radiusM: 3396000, centralLonDeg: 0, originLatDeg: 0, standardParallelDeg: 0 },
  terrainReference: 'MOLA topography relative to GMM3 areoid, degree/order 50',
  note: 'Gridded altimetry includes interpolated bins; not a local obstacle map.'
}))];
