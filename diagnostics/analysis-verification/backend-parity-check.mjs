import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function runNode(projectRoot, scriptPath, args) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    throw new Error(`${path.basename(scriptPath)} exited with ${result.status}: ${output.slice(-4000)}`);
  }
}
export async function runRaytraceBackendParity(options) {
  const startedAt = performance.now();
  const projectRoot = options.projectRoot;
  const outputDirectory = options.outputDirectory;
  const rayCount = Number(options.rayCount ?? 25);
  const input = String(options.input ?? 'Examples/default-load.json');
  const capturePath = path.join(outputDirectory, 'raytrace-js-rust-capture.json');
  const analysisPath = path.join(outputDirectory, 'raytrace-js-rust-analysis.json');
  await fs.mkdir(outputDirectory, { recursive: true });

  try {
    runNode(projectRoot, path.join(projectRoot, 'diagnostics/raytrace-golden-capture.mjs'), [
      '--input', input,
      '--engine', 'both',
      '--rays', String(rayCount),
      '--auto-aperture-report', 'false',
      '--out', capturePath,
    ]);

    const capture = JSON.parse(await fs.readFile(capturePath, 'utf8'));
    const jsCount = Array.isArray(capture?.outputs?.js) ? capture.outputs.js.length : 0;
    const rustCount = Array.isArray(capture?.outputs?.rust) ? capture.outputs.rust.length : 0;
    if (jsCount !== rayCount || rustCount !== rayCount) {
      throw new Error(`both engines are required: JS=${jsCount}, Rust=${rustCount}, expected=${rayCount}; notes=${JSON.stringify(capture?.notes ?? [])}`);
    }

    runNode(projectRoot, path.join(projectRoot, 'diagnostics/raytrace-golden-analyze.mjs'), [
      '--input', capturePath,
      '--out', analysisPath,
      '--require', 'true',
      '--max-mismatch-rate', '0',
      '--max-success-mismatch-rate', '0',
      '--max-mean-opl-um', '0',
      '--max-opl-um', '0',
    ]);

    const analysis = JSON.parse(await fs.readFile(analysisPath, 'utf8'));
    const comparison = capture.comparison;
    if (!comparison) throw new Error('capture did not produce a JS/Rust comparison');
    if (analysis?.requirementGate?.passed !== true) {
      throw new Error(`parity gate failed: ${JSON.stringify(analysis?.requirementGate?.failedChecks ?? [])}`);
    }

    const maxHitDeltaMm = Number(comparison.maxHitDeltaMm);
    const hitToleranceMm = 1e-7;
    if (!Number.isFinite(maxHitDeltaMm) || maxHitDeltaMm > hitToleranceMm) {
      throw new Error(`max hit delta ${maxHitDeltaMm} mm exceeds ${hitToleranceMm} mm`);
    }

    return {
      id: 'js-rust-raytrace-parity',
      title: 'JS and Rust/WASM ray tracing agree on status, hit point, and OPL',
      domain: 'backend parity',
      reference: 'JS/Rust lockstep',
      status: 'pass',
      durationMs: performance.now() - startedAt,
      metrics: {
        input,
        rays: rayCount,
        jsSuccess: capture.summaries.js.success,
        rustSuccess: capture.summaries.rust.success,
        statusMismatch: comparison.statusMismatch,
        successMismatch: comparison.successMismatch,
        maxHitDeltaMm: {
          actual: maxHitDeltaMm,
          expected: 0,
          delta: maxHitDeltaMm,
          tolerance: hitToleranceMm,
        },
        maxOplDeltaUm: comparison.maxOplDeltaUm,
        meanOplDeltaUm: comparison.meanOplDeltaUm,
      },
      artifacts: {
        capture: path.relative(projectRoot, capturePath),
        analysis: path.relative(projectRoot, analysisPath),
      },
    };
  } catch (error) {
    return {
      id: 'js-rust-raytrace-parity',
      title: 'JS and Rust/WASM ray tracing agree on status, hit point, and OPL',
      domain: 'backend parity',
      reference: 'JS/Rust lockstep',
      status: 'fail',
      durationMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      artifacts: {
        capture: path.relative(projectRoot, capturePath),
        analysis: path.relative(projectRoot, analysisPath),
      },
    };
  }
}
