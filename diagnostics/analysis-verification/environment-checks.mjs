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

function executeJson(projectRoot, definition) {
  const startedAt = performance.now();
  const child = spawnSync(process.execPath, definition.args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: definition.timeoutMs ?? 300_000,
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

function executeCommand(projectRoot, definition) {
  const startedAt = performance.now();
  const child = spawnSync(definition.command, definition.args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: definition.timeoutMs ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, ...(definition.env || {}) },
  });
  const durationMs = performance.now() - startedAt;
  if (child.error || child.status !== 0) {
    const detail = String(child.error?.message || child.stderr || child.stdout || '').trim();
    return {
      ...definition.meta,
      status: 'fail',
      durationMs,
      error: detail.length > 1600 ? detail.slice(-1600) : detail || `${definition.command} exited ${child.status}`,
    };
  }
  const output = `${child.stdout || ''}\n${child.stderr || ''}`;
  const passed = [...output.matchAll(/test result: ok\. (\d+) passed/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  return {
    ...definition.meta,
    status: 'pass',
    durationMs,
    metrics: { passedTests: passed, command: [definition.command, ...definition.args].join(' ') },
  };
}

export async function runEnvironmentChecks({ projectRoot }) {
  const checks = [
    executeJson(projectRoot, {
      args: ['--import', 'tsx', path.join(projectRoot, 'diagnostics/analysis-repeat-stability.mjs')],
      meta: {
        id: 'repeated-run-stability',
        title: 'Repeated Grid Distortion, OPD, PSF, and MTF runs remain deterministic and stall-free',
        domain: 'Web runtime',
        reference: 'six-run warmed Rust/WASM pipeline',
      },
      select: (data) => ({
        repetitions: data.repetitions,
        pipeline: data.pipeline,
        warmupMs: data.warmupMs,
        steadyMedianMs: data.steadyMedianMs,
        steadyMaxMs: data.steadyMaxMs,
        maxOutputDelta: data.maxOutputDelta,
        backend: data.backend,
      }),
    }),
    executeCommand(projectRoot, {
      command: 'cargo',
      args: ['test', '--manifest-path', 'rust-wasm/Cargo.toml'],
      timeoutMs: 600_000,
      meta: {
        id: 'web-rust-kernel-tests',
        title: 'Web Rust/WASM numerical kernel tests pass',
        domain: 'Web Rust/WASM',
        reference: 'host-compiled Rust unit tests',
      },
    }),
    executeCommand(projectRoot, {
      command: 'cargo',
      args: ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'commands::optics'],
      env: process.platform === 'win32' ? { COOPT_TAURI_TEST_MANIFEST: '1' } : {},
      timeoutMs: 600_000,
      meta: {
        id: 'tauri-rust-kernel-tests',
        title: 'Tauri Rust PSF/MTF numerical kernel tests pass',
        domain: 'Tauri Rust',
        reference: 'CZT/DFT and flat-pupil MTF unit tests',
      },
    }),
    executeJson(projectRoot, {
      args: [path.join(projectRoot, 'diagnostics/web-build-smoke.mjs')],
      timeoutMs: 300_000,
      meta: {
        id: 'pages-build-runtime-smoke',
        title: 'The isolated Pages build serves every local entry asset with Rust/WASM isolation headers',
        domain: 'Local Web / GitHub Pages',
        reference: 'production build plus local HTTP preview',
      },
      select: (data) => ({
        buildElapsedMs: data.buildElapsedMs,
        baseUrl: data.baseUrl,
        coop: data.coop,
        coep: data.coep,
        assetCount: data.assetCount,
        wasmAssets: data.wasmAssets,
        servedAssets: data.servedAssets,
      }),
    }),
  ];
  return checks;
}
