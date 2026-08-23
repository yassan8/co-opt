# Analysis Verification Suite

The verification suite makes optical-analysis correctness reproducible instead of relying on visual inspection alone. It is intentionally ordered from shared ray-tracing physics to integrated image simulation; a downstream analysis is not considered verified while its dependencies are uncertain.

## Run

```powershell
npm run verify:analysis
```

This runs all six stages. A shorter dependency-ordered run can stop at any stage:

```powershell
npm run verify:analysis:foundation
npm run verify:analysis:geometric
npm run verify:analysis:wavefront
npm run verify:analysis:diffraction
npm run verify:analysis:integrated
npm run verify:analysis:environment
```

The command writes machine-readable JSON and a human-readable HTML report to `.tmp/analysis-verification/`. A nonzero exit code means that at least one check failed. The environment stage builds Pages into an isolated temporary directory, so it does not overwrite the tracked `dist` tree.

## Verification order

1. Ray-tracing foundation: intersections, refraction, coordinate transforms, stop/pupil, field signs, wavelength, paraxial power
2. Geometrical analyses: Distortion, Spot, Transverse Aberration, Ray Fan, LCA, spherical aberration, astigmatism
3. Wavefront analyses: OPD, OPD Fan, reference sphere, JS/Rust parity
4. Diffraction analyses: PSF, MTF, sampling and orientation, Multi-Field PSF
5. Integrated image simulation: Grid Distortion, wavelength-resolved PSFs, convolution
6. Runtime parity and stability: local Web, GitHub Pages, WASM, Tauri, workers, repeated runs

## Reference policy

Every check records its reference type and numerical evidence:

- `analytic`: a closed-form geometry or optics result independent of the implementation under test
- `physical invariant`: a condition such as forward-only sequential intersections
- `catalog invariant`: a known catalog value plus a physical ordering such as normal dispersion
- backend parity: identical inputs compared between JS, Rust/WASM, Tauri, or browser execution
- external reference: values exported from a named OpTaliX/Zemax/CODE V case, including version and settings

Numerical checks use `max(absTolerance, relTolerance × scale)`. Tolerances belong to each quantity and reference source; the suite does not use one universal tolerance for every analysis.

## Foundation coverage

The first implemented stage includes independent checks for:

- line-plane, sphere, and paraboloid intersections
- rejection of backwards sequential intersections
- Snell refraction at a plane interface
- Tilt/Decenter coordinate round-trip and origin convention
- Stop identity as entrance and exit pupil when no surrounding optics exist
- positive/negative field-angle projection
- N-BK7 d-line refractive index and normal dispersion
- reciprocal thin-lens power and paraxial focal length

The JS/Rust golden ray-trace diagnostic is included in the same report and compares status, success, surface hit points, and optical path length.

## Analysis coverage

The geometrical stage exercises angle-field and image-height Distortion, Grid Distortion ordering and symmetry, Spot and Transverse Aberration for every configured object, Astigmatism, longitudinal spherical aberration, and LCA. The wavefront stage compares JavaScript and Rust/WASM OPD grids and verifies the physical OPD Fan branch at the 46-degree field of the retrofocus example.

The diffraction stage checks an unaberrated circular pupil against analytic MTF and discrete pupil autocorrelation, verifies Multi-Field PSF orientation and centering, runs the real Web Rust/WASM OPD-to-PSF pipeline for all configured fields, and compares full and shared Rust/WASM MTF batches.

The integrated stage covers identity and energy invariants, finite/infinite conjugate scaling, and a real reconstruction using the US3834556 retrofocus example. That reconstruction calculates three wavelength-specific Grid Distortion maps and 27 OPD/PSF jobs over a 3x3 field, then performs distortion, spatially varying convolution, spectral RGB synthesis, and square-output checks.

## Runtime coverage

The runtime stage verifies:

- six warmed repetitions of Grid Distortion, OPD, PSF, and MTF with zero output drift
- the Web Rust/WASM unit tests
- the Tauri Rust CZT/DFT and flat-pupil MTF unit tests
- an isolated production Pages build, local HTTP asset loading, the bundled WASM, and the COOP/COEP headers required by threaded browser execution

On Windows, set `COOPT_TAURI_TEST_MANIFEST=1` only while running the Tauri library tests. The build script then supplies Common Controls v6 to the Rust test harness; normal Tauri builds continue to use Tauri's own application manifest.

The automated HTTP smoke test verifies the built application shell and every local entry asset. Final release review should still include a visual interaction pass in a real browser for window sizing, scrolling, focus, and pointer behavior.
