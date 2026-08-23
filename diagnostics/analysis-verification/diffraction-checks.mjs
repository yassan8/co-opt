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

export async function runDiffractionChecks({ projectRoot }) {
  return [
    execute(projectRoot, {
      args: ['--import', 'tsx', path.join(projectRoot, 'diagnostics/psf-mtf-reference-verification.mjs')],
      timeoutMs: 240_000,
      meta: {
        id: 'psf-mtf-circular-aperture',
        title: 'Unaberrated circular-pupil PSF and MTF agree with diffraction theory',
        domain: 'PSF / MTF',
        reference: 'Strehl, symmetry, Wiener-Khinchin, and analytic circular MTF',
      },
      select: (data) => ({
        pupilSize: data.pupilSize,
        fftSize: data.fftSize,
        fNumber: data.fNumber,
        pixelSizeUm: data.pixelSizeUm,
        peak: data.peak,
        strehlRatio: data.strehlRatio,
        maxSymmetryError: data.maxSymmetryError,
        maxDiscreteMtfDelta: Math.max(...data.mtfSamples.map((row) => row.discreteDelta)),
        maxAnalyticMtfDelta: Math.max(...data.mtfSamples.map((row) => row.analyticDelta)),
      }),
    }),
    execute(projectRoot, {
      args: ['--experimental-strip-types', path.join(projectRoot, 'diagnostics/multi-field-psf-model-repro.mjs')],
      meta: {
        id: 'multi-field-psf-model',
        title: 'Multi-Field PSF keeps Cartesian orientation, field rotation, and tile centering',
        domain: 'Multi-Field PSF',
        reference: 'coordinate and raster invariants',
      },
      select: (data) => data,
    }),
    execute(projectRoot, {
      args: ['--import', 'tsx', path.join(projectRoot, 'diagnostics/multi-field-psf-optical-verification.mjs')],
      meta: {
        id: 'multi-field-psf-optical',
        title: 'The Web Rust/WASM OPD-to-PSF pipeline returns every configured field',
        domain: 'Multi-Field PSF',
        reference: 'real retrofocus optical pipeline',
      },
      select: (data) => ({
        samplingSize: data.samplingSize,
        fftSize: data.fftSize,
        wavelengthUm: data.wavelengthUm,
        workingFNumber: data.workingFNumber,
        pixelSizeUm: data.pixelSizeUm,
        fields: data.fields.map((field) => ({
          objectId: field.objectId,
          fieldYDeg: field.fieldYDeg,
          validPupilSamples: field.validPupilSamples,
          peak: field.peak,
          strehlRatio: field.strehlRatio,
        })),
      }),
    }),
    execute(projectRoot, {
      args: ['--import', 'tsx', path.join(projectRoot, 'diagnostics/optimizer-mtf-shared-batch-repro.mjs')],
      meta: {
        id: 'mtf-rust-wasm-batch',
        title: 'Rust/WASM OPD-PSF-MTF batches preserve all wavelength and field jobs',
        domain: 'MTF',
        reference: 'full-versus-shared request parity and candidate sensitivity',
      },
      select: (data) => ({
        jobs: data.jobs,
        sharedBatches: data.sharedBatches,
        requestReductionPct: data.requestReductionPct,
        maxMtfDifference: data.maxMtfDifference,
        candidateEdgeMtf: data.candidateEdgeMtf,
      }),
    }),
  ];
}
