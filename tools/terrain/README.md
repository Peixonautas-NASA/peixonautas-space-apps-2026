# Automatic numerical terrain service

**IMPLEMENTADO:** local HTTP service that selects numerical elevation for A/B,
prepares an area, caches remote byte ranges and serves the 2D map. Requires
Node 22+ and curl (`curl.exe` on Windows); no Python, GDAL or account is needed.

From the repository root:

```powershell
npm.cmd ci --prefix tools/terrain
node tools/terrain/server.mjs
```

Open **http://127.0.0.1:7878/**. The app detects the service and selects automatic
mode. `TERRAIN_PORT` can change the port. The service binds to loopback and
serves only map-2d, its shared planner and bundled Gale data. This is a local
prototype, not a production multi-user API.

Directly opening `apps/map-2d/index.html` still runs bundled Gale mode. Automatic
retrieval needs HTTP; it does not attempt to fetch binary data from file URLs.

## Curated catalog

`catalog.mjs` defines known numerical products; it does not discover all public
HiRISE/CTX DTMs or query every planetary archive.

| Priority | Product | Native spacing | Coverage |
| --- | --- | --- | --- |
| 1 | HRSC Gale, Persaud/Putri/Muller (2021) | 30 m | Whole source mosaic, beyond the bundled crop |
| 2 | MGS MOLA MEGDR v2, 128 px/degree | About 463 m north-south | Regional fallback, multiple native tiles |
| 3 | MGS MOLA MEGDR v2, 16 px/degree | About 3.7 km north-south | Larger regional routes |

Each request uses the finest **single source** covering the entire AOI within
250,000 cells. A source failure permits a disclosed coarser fallback. Sources
are not stitched together, avoiding false cliffs from reference/registration
offsets. Adjacent MOLA tiles from the same product can be read together.
No product is upsampled. The previously suggested 200-m blend is not configured;
verified numerical PDS MOLA products provide the regional fallback instead.

The AOI is A/B's bounding rectangle plus at least 2 km or 15% of their
great-circle separation. A `no-path` result triggers attempts 0, 1 and 2,
doubling the margin up to 200 km. Search stops on success, invalid endpoint or
the last attempt. This does not prove global optimality or rule out paths
beyond the final AOI.

Processing limits: endpoint latitude -75 to +75 degrees, longitude -180 to
+180, separation at most 1,500 km, no antimeridian crossing, 250,000 cells and
at most 64 MiB of raster bands per source attempt. Polar/dateline planning
needs another grid strategy. Longer itineraries should be split into stages.

## Retrieval and cache

Only catalog-controlled HTTPS URLs are accessed, without a shell. HTTP ranges
must return 206, the exact `Content-Range` and an exact payload length. HRSC
headers are checked against projection, dimensions and Float32 encoding.
MOLA uses signed big-endian 16-bit meters and the fixed MEGDR v2 layout:
128-ppd tiles 11520 × 5632; 16-ppd globe 5760 × 2880. Original labels describe
the format, e.g. https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg128/megt00n090hb.lbl

Bands persist in `.terrain-cache/` (ignored by Git), keyed by source URL and
byte interval. Identical in-flight reads are shared. Downloads are serialized,
written atomically and oldest files evicted to keep the disk cache within
512 MiB. Eight prepared grids are retained in memory. After a restart, cached
bands can rebuild previously fetched areas without a download if not evicted.
The first request may take minutes; cache reuse is much faster. Cancelling in
the UI discards the result; the server may finish a shared download for cache.

NoData stays null and impassable. Failed downloads never become zero elevation.
Physical east-west spacing varies by row with latitude. The shared A* uses
these metrics and a conservative heuristic lower bound. Source, native spacing,
vertical reference and selection policy accompany each grid/export. Coarse
MOLA slopes do not resolve local hazards; grid spacing is not vertical accuracy.

## API and interface

- `GET /api/health`: service identity and limits.
- `GET /api/catalog`: source metadata and footprints.
- `POST /api/terrain`: JSON `{ start: {lat,lon}, goal: {lat,lon}, expansion: 0 }`.
  Returns projection, dimensions, origin, row spacing, source, bounds, valid
  count and elevations (null = NoData). Large responses use gzip.

The UI runs A* in a worker, supports cancellation and exports Mars-coordinate
GeoJSON-shaped data with the actual source. Automatic mode accepts points
outside Gale through map clicks, marker drags or coordinate inputs. Bundled
Gale remains selectable without the service.

## Validation

```powershell
node --test tools/terrain/tests/service.test.mjs
node --test packages/shared/navigation/tests/planner.cjs
```

With the service and an isolated Chromium CDP session on port 9222:

```powershell
node apps/map-2d/tests/pathfinding.cjs
node apps/map-2d/tests/automatic-terrain.cjs
```

The automatic test uses real cached HRSC/Gale and MOLA/Olympus terrain. Explicit
NoData-barrier fixtures verify all three expansion attempts. Other tests cover
fallback, cache persistence/eviction, signed sampling across four native tiles,
HTTP validation and row-metric A* against Dijkstra.

Sources:

- HRSC: https://doi.org/10.5281/zenodo.5808354
- MOLA: https://pds-geosciences.wustl.edu/missions/mgs/megdr.html
- PDS: https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/

AI assistance record, 2026-11-14: Codex assisted with source adapters, retrieval,
cache, row metrics, server, UI integration and tests. Elevations remain numeric
source data, never values inferred from optical imagery or hillshade.
