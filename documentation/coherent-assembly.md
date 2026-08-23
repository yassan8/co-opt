# Coherent 3D optical assembly

## Model boundary

`Configuration.coherentDesign` stores one complete branched instrument. A configuration is a design alternative, not one interferometer arm. Existing `blocks[]` and sequential analyses remain unchanged when `coherentDesign` is absent.

The Patent Fig. 2 preset contains every physical reference used by the first implementation: broadband source 11, mirror 21, attenuator 22, both beam-expander lenses 23a/23b, beam splitter 24, cylindrical lens 25, focusing lenses 26/27/28, target 100, reflection grating 70 and 2D detector 80.

## Physical placement

- Every component has a world XYZ pose, a manual XYZ/RXYZ offset, optical ports, an optical envelope and a mechanical envelope.
- Port connections store input/output port IDs, port-to-port distance, world azimuth and elevation. Changing a connection or an upstream manual offset reflows all downstream components in that arm.
- Common, object, reference and detector paths coexist in the same model and can be shown independently.
- The interactive 3D view displays all branches, optical/mechanical envelopes, the assembly bounding box and collision highlighting. The top view retains exact X/Z placement and dimension lines.

## Design Intent bridge

Each named arm can capture the active configuration's Design Intent blocks. The bridge reuses `expandBlocksToOpticalSystemRows()` and `calculateSurfaceOrigins()`:

1. Design Intent blocks expand into sequential surfaces.
2. Local surface origins and rotations are calculated with Coordinate Transform support.
3. The named sequence root pose converts those local coordinates into world XYZ.
4. Lens, Doublet and Triplet intervals become individual closed lens solids. Stops and mirrors become explicit physical components; gaps and coordinate transforms remain placement operations.
5. Generated solids participate in assembly bounds, volume, collision and missing-dimension checks.

An aperture-derived outside diameter is marked `Estimated`; a missing aperture is `Missing`. Catalogue/measured component dimensions can be entered and marked `Exact`.

## Packaging metrics

The evaluator reports:

- assembly `L × H × W` and bounding volume;
- closed optical-solid volume sum;
- estimated mechanical-envelope volume sum and occupancy;
- common/object/reference/detector path lengths and placement-derived OPD;
- maximum component width and height;
- mechanical-envelope overlaps;
- beam segments intersecting non-endpoint mechanical envelopes;
- components with `Estimated` or `Missing` dimensions.

Lens volume is numerically integrated from front/back spherical sag and clear aperture. Box and cylindrical elements use analytic volume. Rotation cannot change component volume; only the assembly bounding box changes with placement.

## Fig. 2 detector signal

The signal model supports Gaussian broadband and frequency-comb sources, complex scalar beam-splitter R/T phase, a signed reflection-grating equation, grating efficiency, attenuator transmission, target reflectance and path throughput. It produces physical W/pixel intensity, normalized intensity, coherence envelope, reconstructed height, target/reconstruction comparison, RMS depth error and maximum depth error.

Targets include flat, step, tilt, sinusoidal and `x(mm), z(µm)` CSV profiles. Normal operation derives OPD from component placement; the only manual OPD term is the explicit calibration offset.

## Verification

```text
npm run diag:coherent-assembly
npm run diag:coherent-design-intent
npm run diag:coherent-port-layout
npm run diag:coherent-interferometer
npm run build
```

The diagnostics cover analytic cylinder/plano-lens volume, rotation invariance, bounding-volume changes, collision and path-clearance detection, round-trip OPD after an arm-length change, Design Intent two-lens expansion, broadband step/flat depth recovery and frequency-comb detector power.

## Deliberately deferred physics

This release is the scalar coherent and packaging foundation. The later stages remain separate extensions: wavelength-resolved glass/coating phase tables, Jones polarization, switched detector charge transport, ghost/non-sequential tracing and STL interaction. Those features should consume the same persisted assembly and port graph rather than create another geometry model.
