# Regional Gale route planner

`planner.js` is dependency-free and shared by the apps. It can be loaded as a
classic browser script (`PeixonautasNavigation`), required in Node, or packaged
as a self-contained Blob worker. The Leaflet integration is
`apps/map-2d/route-planner.js`. The other visualizers are not yet connected.

## Cost and constraints

The A* graph uses eight neighboring cells, a binary min-heap and a Euclidean
heuristic multiplied by the distance weight. Automatically acquired grids can
provide `stepXMByRow` to account for changing longitude scale with latitude;
the heuristic uses the smallest horizontal row spacing as a lower bound.
Every edge costs at least that weighted lower-bound distance, preserving an
admissible and consistent heuristic.
All distances and elevations inside the planner are in **meters**.

For each edge:

```text
d = horizontal segment distance in meters
dz = destination elevation - source elevation
s = max(source terrain slope, destination terrain slope, segment slope)

cost = d × distanceWeight
     + d × slopeWeight × (s / 15°)²
     + max(0, dz) × ascentWeight
     + d × terrainWeight × max(terrainPenaltyAtSource, terrainPenaltyAtDestination)
```

The 15° divisor is a fixed normalization reference, not a safe-travel threshold.
Default weights are distance=1, slope=3, ascent=5; the default hard slope limit
is 25°. These are **PROPOSTA / prototype assumptions**, not validated astronaut
or rover capability limits. Distance weight must be positive; penalties must
be nonnegative. Terrain slope is computed using central or one-sided finite
differences on the numeric DEM, including cross-slope gradient. Missing
support on either axis is treated as unknown, not zero slope.

NoData, blocked cells and excessive slopes are impassable. Diagonals cannot
cross corners of blocked cells. The result is optimal within this discrete
graph and this cost model, not necessarily in continuous terrain. The UI
renders every path cell without route smoothing that could cross hazards.
No data from normal maps, vertical exaggeration or optical brightness enters
the cost.

## Manual traversability

**IMPLEMENTADO:** optional manual polygons for `blocked`, `difficult`, `normal`
and `unknown` terrain. The layer is off by default, preserving the existing
route until explicitly enabled. On activation, unclassified cells are unknown;
they are not silently considered normal. The unknown policy is `allow`,
`penalize` (default, extra cost 1/m) or `block`. Difficult cells default to an
additional cost 3/m. The terrain weight defaults to 1 and may be zero, but a
zero weight never disables hard blocks or the unknown/block policy.

Pass `annotations: [{id, label, type, ring: [[lon,lat], ...]}]` and
`traversability: {enabled, difficultCost, unknownCost, unknownPolicy, marginM}`
on a georeferenced grid (projection, originX/Y and pixelSizeM are required).
The worker rasterizes vectors anew for each grid, so source/resolution changes
do not reuse masks aligned to an old AOI. `rasterizeAnnotations` is also exported
for inspection/tests. `terrainCostPerM` is an optional cell-aligned nonnegative
cost array for direct API consumers.

Every cell touched by a polygon is classified, including thin polygons with
no cell center inside. Explicit blocked polygons dominate overlaps. Otherwise
overlapping classifications use the highest applicable extra cost; explicit
unknown/block is always a hard constraint. Normal polygons override the default
unclassified/unknown state, but cannot erase an explicit blocked polygon.
To remove a block, change or delete that polygon.

The default 60-m margin applies only to explicitly blocked polygons. Cells
intersecting the polygon or its conservative axis-aligned metric expansion are
blocked. This approximates a minimum setback; square expansion and whole cells
can block more than a Euclidean circular buffer, particularly on coarse DTMs.
Unknown/block and DEM NoData remain hard constraints without this additional
polygon margin. Annotations never change the numeric elevation or its gradients.

The extra edge cost is `distance × terrainWeight × max(endpoint penalties)`.
It is nonnegative, preserving the heuristic lower bound. The result includes
`costParts.terrain`, the applied policy, manual provenance, grid classification
counts and approximate route distances by class. Edges straddling classes are
assigned conservatively to the higher-ranked class. These are not measurements
of soil bearing strength, energy consumption or time.

The UI supports polygon drawing, vertex undo, cancellation, reclassification,
deletion, browser-local persistence and import/export of Mars-tagged planetary
GeoJSON-shaped collections. Layer enablement, policy and terrain weight are
saved per browser origin. File mode and the HTTP service have separate storage;
use export/import to transfer interpretations. Invalid imports leave existing
areas intact. Imports explicitly replace areas and policy; they never establish
sensor provenance. Route exports include the areas/policy and complete weights.

Only simple polygons without holes are supported: 50 areas, 128 vertices per
area, 2,048 vertices total, latitude ±75°, longitude ±180°, no antimeridian crossing.
Self-intersections, duplicate IDs, invalid coordinates and negative costs fail
explicitly. Limits bound worker processing and imported-file size (1 MB).

## Interface and behavior

```js
const result = PeixonautasNavigation.planRoute(
  { width, height, elevations: new Float32Array(values), stepXM, stepYM },
  { x: startColumn, y: startRow },
  { x: goalColumn, y: goalRow },
  { distance: 1, slope: 3, ascent: 5, maxSlopeDeg: 25 }
);
```

Optional `blocked` is a cell-aligned byte mask (nonzero = blocked). Results
distinguish `ok`, `outside-area`, `invalid-endpoint` and `no-path`. Invalid
parameters throw an error. A no-path result applies to this AOI only; it does
not exclude paths outside its boundary.

The map starts with an example from about -4.59°, 137.44° to -4.68°, 137.42°.
Select A/B with the buttons, or drag their markers. Inputs snap to cell centers
(up to roughly half the cell diagonal). Parameter or endpoint changes cancel
pending computation and remove stale results. The search runs in a worker,
including when the HTML is opened directly from disk.

The export is GeoJSON-shaped planetary data: `[east longitude, planetocentric
latitude, elevation in meters]` on **Mars**, not terrestrial WGS84. Consumers
must honor its planetary metadata instead of assuming Earth coordinates.
Properties carry source, resolution, weights, costs and limitations. Cost is
a comparative score, not time, energy or physical risk. Distance is horizontal;
ascent/descent accumulate differences between consecutive DEM samples.

Manual interpretations can supply assumed terrain costs and hard exclusions,
but no sensor-derived local soil, rock, thermal, weather, radiation or life-support
data has been added. Future layers should distinguish impassable constraints
from soft nonnegative costs, with source, resolution, validity and date. A
resource target should not override a hard movement constraint.

## Validation

```powershell
node --test packages/shared/navigation/tests/*.cjs
```

Tests cover exact flat-grid distance, weight-induced detours, directional
ascent, slope units and limits, NoData barriers, blocked corners, invalid
parameters, same-cell requests, comparison against a separate Dijkstra
implementation and a route through the bundled real Gale crop.

Browser checks require an isolated Chromium/Edge session with
`--headless --remote-debugging-port=9222 --user-data-dir=<temporary-profile>`:

```powershell
node apps/map-2d/tests/pathfinding.cjs
node apps/map-2d/tests/rendering.cjs
node apps/map-2d/tests/traversability.cjs
```

An optional URL argument to `pathfinding.cjs` checks the HTTP-hosted version;
the default checks opening the HTML directly. The browser tests exercise real
workers, invalid input, weight changes, cancellation, A/B selection, export,
tile failures and recovery. NASA imagery still needs network access, while
the bundled terrain and route calculation do not.

The traversability browser test also accepts an HTTP URL argument and covers
drawing, hard/soft detours, weight zero, unknown blocking, reload persistence,
atomic import/rejection, deletion, provenance and interaction with A/B selection.
AI assistance record (2026-11-14): Codex assisted with the manual interpretation
layer, conservative rasterization, cost integration, persistence and tests.

Environmental criteria: optional `radiation`, `temperature`, and `magnetism` weights
default to zero. `grid.environment` holds static imported geographic rasters or
explicit uniform scenarios. Positive weights require a source; missing coverage
blocks travel. See [schema, formulas and assumptions](../../../docs/environmental-weights.md).
The route export includes inputs, declared provenance, per-criterion costs and
constant-speed exposure estimates. No magnetic shielding or automatic sensor-map
retrieval is assumed. Browser test: `node apps/map-2d/tests/environment.cjs` with
an isolated CDP browser on port 9222; accepts an optional HTTP URL.
