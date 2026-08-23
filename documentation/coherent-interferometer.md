# Coherent interferometer analysis

This feature is the first coherent-analysis layer for optical systems that split and recombine light. It is deliberately separate from the existing sequential surface list: a beam splitter creates two simultaneous paths, while the current surface list represents one ordered path.

## Patent mapping

The three presets follow the disclosed topologies in JP 2026-126953 A.

- **Patent Fig. 2 · Broadband + grating** — Gaussian broadband spectrum, two-arm split/recombine, selectable reflection-grating order, groove density, incidence angle and scalar diffraction efficiency.
- **Patent Fig. 12 · Dual resonator** — two Fabry–Perot cavity lengths are converted to free spectral ranges, then evaluated as two coherent pulse/comb trains.
- **Patent Fig. 14 · Dual comb** — two combs with independent repetition and offset frequencies are paired tooth by tooth and heterodyned into an RF interferogram.

The reflection grating uses the signed convention

`d (sin(alpha) + sin(beta)) = m lambda`

where alpha and beta are measured from the grating normal. A non-propagating order is reported rather than clamped. The dual-comb detector uses complex phase from optical path difference and reports an alias warning when the largest RF beat exceeds detector Nyquist frequency.

## Current scope

- Scalar coherent field; phase and power are distinct.
- Lossless or lossy scalar beam-splitter R/T with energy validation.
- Manual optical path difference and relative arm phase.
- Gaussian source/comb envelope and a selected grating order.
- Instant TypeScript calculation; no Web Worker is required at this scale.

## Deliberate next steps

1. Add a persisted **Coherent Path Graph** with typed ports (`T`, `R`, diffraction order and detector input). A graph is required because a linear sequential surface list cannot represent simultaneous branches without duplicating or hiding a path.
2. Add a `SequentialPath` graph node that reuses the existing Rust/WASM tracer for a lens train and returns chief-ray OPL, throughput and pupil samples. This connects normal co-opt lens designs to either interferometer arm.
3. Replace scalar R/T and grating efficiency with wavelength- and polarization-resolved complex Jones tables. Coating phase must be included, not only transmission percentage.
4. Add detector arrays and reconstruction presets for the patent's switched charge-inflow detector: per-pixel interferograms, peak timing/phase slope and surface-height reconstruction.
5. Add full diffraction propagation only where required. A grating equation is sufficient for ray direction; blaze efficiency needs RCWA or measured tables, and beam propagation needs Fresnel/angular-spectrum propagation.

Using separate configurations for transmitted and reflected rays remains useful for geometric debugging, but it cannot produce a coherent detector signal by itself because the two branches are not evaluated simultaneously.
