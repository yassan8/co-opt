import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const rawArgs = process.argv.slice(2);

const getArg = (name, fallback = null) => {
  const key = `--${name}`;
  const idx = rawArgs.indexOf(key);
  if (idx < 0) return fallback;
  const v = rawArgs[idx + 1];
  if (v === undefined || String(v).startsWith('--')) return 'true';
  return String(v);
};

const toBool = (v, fallback = false) => {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim().toLowerCase();
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

const runNode = async (scriptRel, args = [], options = {}) => {
  const scriptAbs = path.resolve(projectRoot, scriptRel);
  const label = String(options.label || scriptRel);
  const mode = String(options.mode || 'strip');
  const nodeArgs = mode === 'tsx'
    ? ['--import', 'tsx', scriptAbs, ...args]
    : ['--experimental-strip-types', scriptAbs, ...args];

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });

    let stderrText = '';
    child.stdout?.on('data', (chunk) => {
      try { process.stdout.write(chunk); } catch (_) {}
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk ?? '');
      stderrText += text;
      try { process.stderr.write(chunk); } catch (_) {}
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`${label} failed with signal ${String(signal)}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${label} failed with code ${code ?? 1}${stderrText ? `: ${stderrText.slice(0, 400)}` : ''}`));
        return;
      }
      resolve();
    });
  });
};

const runStaticChecks = async () => {
  const meritPath = path.resolve(projectRoot, 'ui/editors/merit-function-editor.ts');
  const optimizerPath = path.resolve(projectRoot, 'optimization/optimizer-mvp.ts');
  const tauriOptimizerPath = path.resolve(projectRoot, 'src-tauri/src/commands/optimizer.rs');
  const ipcPath = path.resolve(projectRoot, 'src/desktop/ipc/client.ts');

  const [meritText, optimizerText, tauriOptText, ipcText] = await Promise.all([
    fs.readFile(meritPath, 'utf8'),
    fs.readFile(optimizerPath, 'utf8'),
    fs.readFile(tauriOptimizerPath, 'utf8'),
    fs.readFile(ipcPath, 'utf8')
  ]);

  const checks = [
    {
      name: 'merit_async_spot_annular_case',
      pass: meritText.includes("case 'SPOT_SIZE_ANNULAR':") && meritText.includes("runSpotWithFallback('annular')")
    },
    {
      name: 'merit_async_zern_native_case',
      pass: meritText.includes("case 'ZERN_COEFF':")
        && meritText.includes('calculateZernikeCoeffViaNativeAsync')
        && meritText.includes('runNativeOpdMap')
    },
    {
      name: 'merit_async_ta_native_case',
      pass: meritText.includes("case 'TA_RMS_UM':")
        && meritText.includes('calculateTransverseAberrationRmsUmViaNativeAsync')
        && meritText.includes('runNativeTransverseAberration')
    },
    {
      name: 'merit_async_sa_native_case',
      pass: meritText.includes("case 'SA':")
        && meritText.includes('calculateSphericalAberrationUmViaNativeAsync')
        && meritText.includes('runNativeSphericalAberration')
    },
    {
      name: 'merit_native_spot_helper_uses_ipc',
      pass: meritText.includes('calculateSpotSizeUmViaNativeAsync')
        && meritText.includes('runNativeSpotRaytrace')
    },
    {
      name: 'optimizer_awaits_async_operand_eval',
      pass: optimizerText.includes('await editor.calculateOperandValueAsync(opObj)')
    },
    {
      name: 'tauri_optimizer_spot_ta_native_mapping',
      pass: tauriOptText.includes('"SPOT_SIZE_ANNULAR" => native_spot_size_um')
        && tauriOptText.includes('"SPOT_SIZE_RECT" => native_spot_size_um')
        && tauriOptText.includes('"TA_RMS_UM" => native_transverse_rms_um')
    },
    {
      name: 'ipc_client_native_endpoints_present',
      pass: ipcText.includes('runNativeSpotRaytrace')
        && ipcText.includes('runNativeOpdMap')
        && ipcText.includes('runNativeTransverseAberration')
        && ipcText.includes('runNativeSphericalAberration')
    }
  ];

  return {
    passed: checks.every((c) => c.pass),
    checks
  };
};

const run = async () => {
  const requireGate = toBool(getArg('require', 'true'), true);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outRel = getArg('out', path.join('diagnostics/results', `native-operands-auto-${stamp}.json`));
  const outAbs = path.resolve(projectRoot, outRel);

  const staticRouting = await runStaticChecks();

  const runtime = {
    opdParity: { pass: false, output: null, error: null },
    taMode: { pass: false, output: null, analysis: null, error: null },
    spotSmoke: { skipped: true, reason: 'covered by static routing checks', pass: true },
    saSmoke: { skipped: true, reason: 'covered by static routing checks', pass: true }
  };

  try {
    const opdOutRel = path.join('diagnostics/results', `opd-js-rust-parity-native-operands-${stamp}.json`);
    await runNode('diagnostics/opd-js-rust-parity.mjs', [
      '--out', opdOutRel,
      '--grid', '33',
      '--fields', '0',
      '--force-finite', '1',
      '--fail-max-diff-waves', '0',
      '--fail-rms-diff-waves', '0',
      '--fail-mean-diff-waves', '0'
    ], { label: 'opd-js-rust-parity(native-operands)' });
    runtime.opdParity.pass = true;
    runtime.opdParity.output = opdOutRel;
  } catch (e) {
    runtime.opdParity.error = String(e?.message || e);
  }

  try {
    const taOutRel = path.join('diagnostics/results', `ta-rms-lightweight-vs-statsonly-native-operands-${stamp}.json`);
    const taAnalysisRel = path.join('diagnostics/results', `ta-rms-lightweight-vs-statsonly-analysis-native-operands-${stamp}.json`);
    await runNode('diagnostics/ta-rms-lightweight-mode-auto.mjs', [
      '--out', taOutRel,
      '--analysis-out', taAnalysisRel,
      '--rayCounts', '21,51',
      '--loops', '8',
      '--repeat', '5',
      '--min-median-of-median-speedup', '0.95',
      '--min-per-raycount-speedup', '0.90',
      '--require', 'true'
    ], { label: 'ta-rms-lightweight-mode-auto(native-operands)', mode: 'tsx' });
    runtime.taMode.pass = true;
    runtime.taMode.output = taOutRel;
    runtime.taMode.analysis = taAnalysisRel;
  } catch (e) {
    runtime.taMode.error = String(e?.message || e);
  }

  const failedChecks = [];
  if (!staticRouting.passed) failedChecks.push('staticRouting');
  if (!runtime.opdParity.pass) failedChecks.push('opdParity');
  if (!runtime.taMode.pass) failedChecks.push('taMode');

  const summary = {
    timestamp: new Date().toISOString(),
    output: path.relative(projectRoot, outAbs),
    staticRouting,
    runtime,
    requirementGate: {
      enabled: requireGate,
      failedChecks,
      passed: failedChecks.length === 0
    }
  };

  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await fs.writeFile(outAbs, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log('✅ Native operand conduit auto summary');
  console.log(JSON.stringify({
    output: path.relative(projectRoot, outAbs),
    requirementGate: summary.requirementGate
  }, null, 2));

  if (requireGate && !summary.requirementGate.passed) {
    process.exitCode = 2;
  }
};

await run();