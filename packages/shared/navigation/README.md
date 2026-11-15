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

No local soil, rock, thermal, weather, radiation or life-support data has been
added to the cost. Future layers should distinguish impassable constraints
from soft nonnegative costs, with source, resolution, validity and date. A
resource target should not override a hard movement constraint.

## Validation

```powershell
node --test packages/shared/navigation/tests/planner.cjs
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
```

An optional URL argument to `pathfinding.cjs` checks the HTTP-hosted version;
the default checks opening the HTML directly. The browser tests exercise real
workers, invalid input, weight changes, cancellation, A/B selection, export,
tile failures and recovery. NASA imagery still needs network access, while
the bundled terrain and route calculation do not.
