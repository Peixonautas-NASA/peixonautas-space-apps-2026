# MOLA numerical terrain

Source: NASA/MGS MOLA MEGDR, product MEGT90N000EB.IMG, version 2.0.
Archive: https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/
Product description: https://pds-geosciences.wustl.edu/missions/mgs/megdr.html

`mola-16ppd.js` packages the original IMG losslessly as gzip + base64.
It assigns a temporary payload that is released after decoding.
The original PDS label is retained as `megt90n000eb.lbl`.
Grid: 5760 x 2880, 16 pixels/degree (~3.7 km/pixel at the equator).
Samples: signed big-endian 16-bit integers, meters above the MOLA areoid.
Rows run north to south; columns run from 0 to 360 degrees east. Coordinates
refer to cell centers. The viewer interpolates bilinearly and converts meters
to kilometers in Float32, preserving the existing vertical range and scale.

MEGDR is a gridded altimetry product. The label states that cells without
observations contain interpolated values. Interpolation and display smoothing
do not increase the source resolution. Viking/HiRISE imagery is used for
appearance, not as numerical elevation. This bundled grid is coarser than the
463 m color hillshade previously used; zooming does not add elevation detail.

The viewer supports opening `index.html` directly (`file://`) and HTTP hosting.
Keep the `data` directory next to the HTML. A classic script loads the bundled
DEM (~35 MB as base64), then the browser DecompressionStream API restores the
original signed 16-bit values. No local binary fetch or server configuration is
required. The external Three.js modules and Viking/HiRISE tiles still need an
internet connection. Loading errors are shown instead of an empty gray plane.

Implemented with AI assistance on 2026-11-14: replaced RGB hillshade inversion
with the numerical DEM; added signed-value, grid-coordinate and Ascraeus
regression checks. Run: `node apps/map-3d/tests/altitude.cjs`.
Follow-up: packaged the DEM for direct file:// opening; verified in Edge at Ascraeus (+18.13 km), including vertical-scale changes and reset, with no runtime exceptions.
