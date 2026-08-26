# Coherent 3D optical assembly

## Model boundary

The active Configuration is the sole source of the coherent assembly. Design Intent blocks provide components and exact sequential groups, Design Connections provide physical placement, Optical Routes define propagation order, and Route Sets associate coherent branches with a detector. The public application does not include an instrument-specific starter layout.

## Physical placement

- Every physical component has a world pose, an authored offset, optical ports, dimensions and dimension confidence.
- Port connections store port IDs, distance and direction. Auto-placement can propagate an upstream edit through the connected assembly.
- Multiple branches can coexist in one model and can be inspected independently.
- The 3D Render shows the configured components, routed rays, optical/mechanical envelopes and collision information.

## Design Intent bridge

Exact Sequential Groups reuse the existing surface expansion and surface-origin calculation:

1. Design Intent blocks expand into sequential optical surfaces.
2. Local origins and rotations include Coordinate Transform operations.
3. A sequence root pose places the group in the assembly.
4. Lens solids, stops and mirrors participate in bounds, volume and clearance checks.
5. Estimated and missing dimensions remain explicitly marked.

## Coherent detector signal

Sources, splitters, gratings, targets and detectors are read from the active Configuration. The analysis can generate physical W/pixel intensity, normalized display data, detector electronics output, time signals and flat-referenced relative-height reconstruction. The configured target profile is used only as a comparison curve and error reference after reconstruction; it is not fed into the recovered profile.

The reconstruction is withheld when route coverage, detector sampling, flat-reference data or ridge confidence are insufficient. Calibration ranges and optical-path offsets must come from the modeled or measured system.

## Verification

The generic checks are:

```text
npm run diag:coherent-interferometer
npm run diag:coherent-assembly
npm run build
```

Project-specific fixtures and validation configurations belong under the ignored `private/` tree and are not part of the published application.
