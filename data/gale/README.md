# Gale: numerical HRSC terrain for regional route planning

**IMPLEMENTADO:** an original-resolution crop of the 30-m HRSC DTM mosaic by
Persaud, Putri & Muller (2021), DOI [10.5281/zenodo.5808354](https://zenodo.org/records/5808354).
The source file is `hrsc_km09_h1938_h1927_h1916-dtm-mosaic.tif`.

The AOI covers the Curiosity region and part of the northwestern foot of Mount
Sharp. Its pixel-aligned limits are approximately **4.53968–4.74011° S,
137.31985–137.54001° E**, around **13 × 12 km**. This is a project-selected
study area, not an officially designated exploration corridor.

`terrain.js` contains 435 × 396 Float32 source elevation values, expressed as
JavaScript numbers without quantization, interpolation or display smoothing.
Source NoData (-32768) is encoded as null; all 172,260 cells in this crop are
valid. This does not mean all small obstacles are resolved. Horizontal grid
spacing is 30 m; this is not a claim of 30-m elevation accuracy.

The source uses an equidistant cylindrical projection on a Mars sphere of
radius 3,396,190 m, standard parallel 0°, central longitude 0°, origin latitude
0°, no false offsets. `originX` / `originY` describe the upper-left pixel edge;
the planner uses pixel centers. Physical east-west spacing is corrected by
cos(latitude) at the AOI center. This local constant-spacing approximation is
appropriate to this small AOI; do not reuse it for planet-wide routes.

The vertical reference follows the source: the 200-m MOLA/HRSC blended global
DTM by Fergason et al. (2018). Exact source window, bounds, value range and
downloaded-row SHA-256 are recorded in `metadata.json`. The original full-file
MD5 is recorded for identification, but was **not verified** because only the
necessary HTTP byte ranges were downloaded.

To reproduce on Windows with Node and curl.exe:

```powershell
npm.cmd ci --prefix tools/terrain
node tools/terrain/prepare-gale.mjs
```

Only preparation needs geotiff.js and access to Zenodo. The viewer loads the
bundled classic script on both `file://` and HTTP; it does not download the
312-MB original at runtime. Keep the repository folder structure intact.

Source and citation:

- Persaud, D. M., Putri, A. D. R., & Muller, J.-P. (2021). *30-m HRSC DTM
  Mosaic of Gale Crater, Mars* (Version 1.0.0). Zenodo.
  https://doi.org/10.5281/zenodo.5808354
- Source readme: https://zenodo.org/records/5808354/files/Persaud_2021_HRSC_DTM-README.txt

AI assistance record, 2026-11-14: Codex assisted with AOI selection, source
metadata validation, reproducible numeric crop, shared A*, map controls,
worker integration and regression tests. No optical or color hillshade
brightness was converted to elevation.
