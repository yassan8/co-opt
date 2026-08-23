export const verificationStages = [
  {
    id: 'foundation',
    order: 1,
    title: 'Ray-tracing foundation',
    description: 'Surface intersections, refraction, coordinate transforms, stop/pupil, field angle, wavelength, and paraxial power.',
    status: 'implemented',
    checks: ['analytic-foundation', 'js-rust-raytrace-parity'],
  },
  {
    id: 'geometric',
    order: 2,
    title: 'Geometrical analyses',
    description: 'Distortion, Spot, Transverse Aberration, Ray Fan, LCA, spherical aberration, and astigmatism.',
    status: 'implemented',
    checks: [
      'distortion-angle-retrofocus',
      'distortion-image-height',
      'grid-distortion-symmetry',
      'spot-transverse-retrofocus',
      'astigmatism-retrofocus',
      'spherical-aberration-continuity',
      'lateral-chromatic-retrofocus',
    ],
  },
  {
    id: 'wavefront',
    order: 3,
    title: 'Wavefront analyses',
    description: 'OPD, OPD Fan, reference-sphere convention, and JS/Rust agreement.',
    status: 'implemented',
    checks: ['opd-js-rust-parity', 'opd-fan-retrofocus'],
  },
  {
    id: 'diffraction',
    order: 4,
    title: 'Diffraction analyses',
    description: 'PSF/MTF normalization, orientation, sampling invariance, and multi-field agreement.',
    status: 'implemented',
    checks: [
      'psf-mtf-circular-aperture',
      'multi-field-psf-model',
      'multi-field-psf-optical',
      'mtf-rust-wasm-batch',
    ],
  },
  {
    id: 'integrated',
    order: 5,
    title: 'Integrated image simulation',
    description: 'Grid distortion, wavelength-resolved field PSFs, convolution, and saved-image agreement.',
    status: 'implemented',
    checks: [
      'image-simulation-model',
      'image-simulation-conjugates',
      'image-simulation-optical-reconstruction',
      'image-simulation-ui-contract',
    ],
  },
  {
    id: 'environment',
    order: 6,
    title: 'Runtime parity and stability',
    description: 'Local Web and Pages assets, Web Rust/WASM, Tauri numerical kernels, repeated runs, and performance budgets.',
    status: 'implemented',
    checks: [
      'repeated-run-stability',
      'web-rust-kernel-tests',
      'tauri-rust-kernel-tests',
      'pages-build-runtime-smoke',
    ],
  },
];

export function getVerificationStage(stageId) {
  return verificationStages.find((stage) => stage.id === stageId) ?? null;
}
