import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseLastJson(text) {
  const source = String(text || '').trim();
  const candidates = [];
  if (source.startsWith('{')) candidates.push(0);
  for (let index = source.indexOf('\n{'); index >= 0; index = source.indexOf('\n{', index + 2)) {
    candidates.push(index + 1);
  }
  for (const start of candidates.reverse()) {
    try {
      return JSON.parse(source.slice(start));
    } catch (_) {
      // Keep looking for the final complete JSON object.
    }
  }
  throw new Error('diagnostic did not emit a parseable JSON result');
}

function tail(value, limit = 1600) {
  const text = String(value || '').trim();
  return text.length > limit ? text.slice(-limit) : text;
}

function runDiagnostic(projectRoot, definition) {
  const startedAt = performance.now();
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(projectRoot, definition.file)],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: definition.timeoutMs ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const durationMs = performance.now() - startedAt;
  if (child.error) {
    return { ...definition.meta, status: 'fail', durationMs, error: child.error.message };
  }
  if (child.status !== 0) {
    const diagnostic = tail(child.stderr || child.stdout);
    return {
      ...definition.meta,
      status: 'fail',
      durationMs,
      error: `diagnostic exited ${child.status}${diagnostic ? `: ${diagnostic}` : ''}`,
    };
  }
  try {
    const data = parseLastJson(child.stdout);
    if (data?.ok !== true) throw new Error('diagnostic result did not report ok=true');
    return {
      ...definition.meta,
      status: 'pass',
      durationMs,
      metrics: definition.select(data),
    };
  } catch (error) {
    return {
      ...definition.meta,
      status: 'fail',
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const definitions = [
  {
    file: 'diagnostics/distortion-retrofocus-repro.mjs',
    meta: {
      id: 'distortion-angle-retrofocus',
      title: 'Angle-field distortion is finite and monotonic through 46 degrees',
      domain: 'distortion',
      reference: 'chief-ray and continuity invariants',
    },
    select: (data) => ({
      case: data.case,
      wavelengths: data.summaries.map((row) => row.wavelengthUm),
      pointCounts: data.summaries.map((row) => row.points),
      maxFieldDeg: Math.max(...data.summaries.map((row) => row.maxFieldDeg)),
      lastDistortionPercent: data.summaries.map((row) => row.lastDistortionPercent),
      backends: [...new Set(data.summaries.map((row) => row.backend))],
    }),
  },
  {
    file: 'diagnostics/distortion-imageheight-repro.mjs',
    meta: {
      id: 'distortion-image-height',
      title: 'Image-height distortion preserves the prescribed field scale',
      domain: 'distortion',
      reference: 'chief-ray and continuity invariants',
    },
    select: (data) => ({
      case: data.case,
      wavelengths: data.summaries.map((row) => row.wavelengthUm),
      pointCounts: data.summaries.map((row) => row.points),
      maxImageHeightMm: Math.max(...data.summaries.map((row) => row.maxImageHeightMm)),
      lastDistortionPercent: data.summaries.map((row) => row.lastDistortionPercent),
      backends: [...new Set(data.summaries.map((row) => row.backend))],
    }),
  },
  {
    file: 'diagnostics/grid-distortion-field-modes-repro.mjs',
    meta: {
      id: 'grid-distortion-symmetry',
      title: 'Grid Distortion preserves field mode, ordering, and rotational symmetry',
      domain: 'grid distortion',
      reference: 'geometric symmetry invariants',
    },
    select: (data) => ({ cases: data.summaries }),
  },
  {
    file: 'diagnostics/spot-transverse-verification.mjs',
    meta: {
      id: 'spot-transverse-retrofocus',
      title: 'Spot and Transverse Aberration include every configured field',
      domain: 'spot / ray fan',
      reference: 'sampling, chief-ray, and finite-value invariants',
    },
    select: (data) => ({
      primaryWavelengthUm: data.primaryWavelength,
      spot: data.spot.map((row) => ({
        objectId: row.objectId,
        fieldDeg: row.fieldDegrees,
        rays: `${row.successfulRays}/${row.totalRays}`,
        rmsRadiusUm: row.rmsRadiusMm * 1000,
      })),
      meridionalPointCounts: data.transverse.meridional.map((row) => row.pointCount),
      sagittalPointCounts: data.transverse.sagittal.map((row) => row.pointCount),
      object3MeridionalPupil: {
        min: data.transverse.meridional.at(-1).pupilMin,
        max: data.transverse.meridional.at(-1).pupilMax,
      },
    }),
  },
  {
    file: 'diagnostics/astigmatism-retrofocus-verification.mjs',
    meta: {
      id: 'astigmatism-retrofocus',
      title: 'Astigmatism spans the full field with finite tangential and sagittal focus',
      domain: 'astigmatism',
      reference: 'sampling, finite-value, and continuity evidence',
    },
    select: (data) => data,
  },
  {
    file: 'diagnostics/spherical-aberration-continuity-repro.mjs',
    meta: {
      id: 'spherical-aberration-continuity',
      title: 'Longitudinal spherical aberration retains complete continuous pupil scans',
      domain: 'spherical aberration',
      reference: 'sampling and continuity invariants',
    },
    select: (data) => ({
      seriesCount: data.summaries.length,
      configurations: [...new Set(data.summaries.map((row) => row.configuration))],
      pointCounts: [...new Set(data.summaries.map((row) => row.pointCount))],
      maxAdjacentJumpMm: Math.max(...data.summaries.map((row) => Math.abs(row.largestJump.dx))),
    }),
  },
  {
    file: 'diagnostics/lateral-chromatic-retrofocus-repro.mjs',
    meta: {
      id: 'lateral-chromatic-retrofocus',
      title: 'Lateral chromatic aberration is finite and continuous through 46 degrees',
      domain: 'lateral chromatic aberration',
      reference: 'primary-wavelength zero and continuity invariants',
    },
    select: (data) => ({
      maxFieldDeg: data.maxFieldDegrees,
      wavelengths: data.summaries.map((row) => row.wavelength),
      pointCounts: data.summaries.map((row) => row.pointCount),
      finalImageHeightMm: data.summaries.map((row) => row.finalImageHeightMm),
      maxAdjacentJumpMm: Math.max(...data.summaries.map((row) => row.maxAdjacentJumpMm)),
    }),
  },
];

export async function runGeometricChecks({ projectRoot }) {
  return definitions.map((definition) => runDiagnostic(projectRoot, definition));
}
