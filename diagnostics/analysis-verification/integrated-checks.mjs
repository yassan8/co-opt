import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseLastJson(text) {
  const source = String(text || '').trim();
  const starts = source.startsWith('{') ? [0] : [];
  for (let index = source.indexOf('\n{'); index >= 0; index = source.indexOf('\n{', index + 2)) starts.push(index + 1);
  for (const start of starts.reverse()) {
    try { return JSON.parse(source.slice(start)); } catch (_) {}
  }
  throw new Error('diagnostic did not emit a parseable JSON result');
}

function execute(projectRoot, definition) {
  const startedAt = performance.now();
  const child = spawnSync(process.execPath, definition.args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: definition.timeoutMs ?? 180_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const durationMs = performance.now() - startedAt;
  if (child.error || child.status !== 0) {
    const detail = String(child.error?.message || child.stderr || child.stdout || '').trim();
    return {
      ...definition.meta,
      status: 'fail',
      durationMs,
      error: detail.length > 1600 ? detail.slice(-1600) : detail || `diagnostic exited ${child.status}`,
    };
  }
  try {
    const data = parseLastJson(child.stdout);
    if (data?.ok !== true) throw new Error('diagnostic result did not report ok=true');
    return { ...definition.meta, status: 'pass', durationMs, metrics: definition.select(data) };
  } catch (error) {
    return {
      ...definition.meta,
      status: 'fail',
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runIntegratedChecks({ projectRoot }) {
  return [
    execute(projectRoot, {
      args: ['--import', 'tsx', path.join(projectRoot, 'diagnostics/image-simulation-model-repro.mjs')],
      meta: {
        id: 'image-simulation-model',
        title: 'Image warping, PSF rebinning, convolution, and spectral synthesis preserve their invariants',
        domain: 'Image Simulation',
        reference: 'identity, energy, orientation, wavelength, and vector-target invariants',
      },
      select: (data) => ({
        identityWarp: data.identityWarp,
        identityConvolutionMaxError: data.identityConvolutionMaxError,
        kernelEnergy: data.kernelEnergy,
        barrelDifferencePercent: data.barrelDifferencePercent,
        linearLightConvolution: data.linearLightConvolution,
        directionalPsfOrientation: data.directionalPsfOrientation,
        wavelengthSpecificDistortion: data.wavelengthSpecificDistortion,
        maxSpectralIdentityError: data.maxSpectralIdentityError,
        vectorTargets: data.vectorTargets,
      }),
    }),
    execute(projectRoot, {
      args: ['--import', 'tsx', path.join(projectRoot, 'diagnostics/image-simulation-conjugate-repro.mjs')],
      meta: {
        id: 'image-simulation-conjugates',
        title: 'Finite and infinite conjugates produce physically scaled PSF sampling',
        domain: 'Image Simulation',
        reference: 'working F-number and diffraction image-pitch model',
      },
      select: (data) => ({ infinite: data.infinite, finite: data.finite }),
    }),
    execute(projectRoot, {
      args: ['--import', 'tsx', path.join(projectRoot, 'diagnostics/image-simulation-optical-verification.mjs')],
      timeoutMs: 300_000,
      meta: {
        id: 'image-simulation-optical-reconstruction',
        title: 'Real Grid Distortion and wavelength-resolved field PSFs reconstruct a square image',
        domain: 'Image Simulation',
        reference: 'US3834556 retrofocus full optical pipeline',
      },
      select: (data) => ({
        backend: data.backend,
        wavelengthsUm: data.wavelengthsUm,
        distortionMaps: data.distortionMaps,
        distortionPointsPerMap: data.distortionPointsPerMap,
        fieldGrid: data.fieldGrid,
        opdJobs: data.opdJobs,
        psfJobs: data.psfJobs,
        output: data.output,
        transparentPixels: data.transparentPixels,
        differencePercent: data.differencePercent,
      }),
    }),
    execute(projectRoot, {
      args: ['--import', 'tsx', path.join(projectRoot, 'diagnostics/image-simulation-ui-repro.mjs')],
      meta: {
        id: 'image-simulation-ui-contract',
        title: 'Image Simulation UI exposes comparison, scale guidance, vector source, and native-resolution saving',
        domain: 'Image Simulation',
        reference: 'page integration and interaction contract',
      },
      select: (data) => ({
        modes: data.modes,
        comparisons: data.comparisons,
        realGridDistortion: data.realGridDistortion,
        realMultiFieldPsf: data.realMultiFieldPsf,
        wavelengthSpecificDistortion: data.wavelengthSpecificDistortion,
        conjugates: data.conjugates,
        maxRasterOutput: data.maxRasterOutput,
        simulatedPngResolution: data.simulatedPngResolution,
        completionStatus: data.completionStatus,
      }),
    }),
  ];
}
