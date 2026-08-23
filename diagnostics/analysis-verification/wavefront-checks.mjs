import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseLastJson(text) {
  const source = String(text || '').trim();
  const starts = source.startsWith('{') ? [0] : [];
  for (let index = source.indexOf('\n{'); index >= 0; index = source.indexOf('\n{', index + 2)) {
    starts.push(index + 1);
  }
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
    definition.validate(data);
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

export async function runWavefrontChecks({ projectRoot, outputDirectory, profile = 'quick' }) {
  const gridSize = profile === 'full' ? 65 : 33;
  const parityOutput = path.join(outputDirectory, 'opd-js-rust-parity.json');
  return [
    execute(projectRoot, {
      args: [
        '--experimental-strip-types',
        path.join(projectRoot, 'diagnostics/opd-js-rust-parity.mjs'),
        '--grid', String(gridSize),
        '--fields', '0,5,10,15',
        '--out', parityOutput,
        '--fail-max-diff-waves', '0.001',
        '--fail-rms-diff-waves', '0.0005',
        '--fail-mean-diff-waves', '0.0005',
      ],
      meta: {
        id: 'opd-js-rust-parity',
        title: 'OPD wavefront maps agree between JavaScript and Rust/WASM',
        domain: 'OPD',
        reference: 'backend parity with strict wave thresholds',
      },
      validate: (data) => {
        if (data?.requirementGate?.passed !== true) throw new Error('OPD parity thresholds failed');
        if (!(Number(data?.aggregate?.opdWaves?.count) > 0)) throw new Error('OPD parity compared no finite samples');
      },
      select: (data) => ({
        gridSize,
        fieldsDeg: [0, 5, 10, 15],
        comparedSamples: data.aggregate.opdWaves.count,
        maxDifferenceWaves: data.aggregate.opdWaves.max,
        rmsDifferenceWaves: data.aggregate.opdWaves.rms,
        meanDifferenceWaves: data.aggregate.opdWaves.mean,
        thresholds: data.requirementGate.thresholds,
      }),
    }),
    execute(projectRoot, {
      args: [
        '--import', 'tsx',
        path.join(projectRoot, 'diagnostics/opd-fan-retrofocus-diagnose.mjs'),
      ],
      meta: {
        id: 'opd-fan-retrofocus',
        title: 'OPD Fan remains on the physical branch at the 46-degree field',
        domain: 'OPD Fan',
        reference: 'known high-field backwards-ray regression',
      },
      validate: (data) => {
        if (data?.result !== 'pass') throw new Error('OPD Fan high-field regression failed');
        if (!Array.isArray(data.reports) || data.reports.length !== 3) throw new Error('OPD Fan omitted a wavelength');
        if (data.reports.some((row) => !(Number(row.hitCount) > 0))) throw new Error('OPD Fan has an empty wavelength');
      },
      select: (data) => ({
        fieldAngleYDeg: data.fieldAngleYDeg,
        wavelengthsUm: data.reports.map((row) => row.wavelength),
        hitCounts: data.reports.map((row) => row.hitCount),
        sampleCounts: data.reports.map((row) => row.sampleCount),
        finiteOuterPointCounts: data.reports.map((row) => row.finiteOuterPointCount),
        maxAbsOuterOpdWaves: data.reports.map((row) => row.maxAbsOuterOpdWaves),
      }),
    }),
  ];
}
