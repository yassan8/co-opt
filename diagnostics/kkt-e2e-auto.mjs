import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);

const getArgValue = (name, fallback = null) => {
  const key = `--${name}`;
  const idx = args.indexOf(key);
  if (idx < 0) return fallback;
  const v = args[idx + 1];
  if (v === undefined || String(v).startsWith('--')) return 'true';
  return String(v);
};

const forwardIfPresent = (target, source = target) => {
  const v = getArgValue(source, null);
  return v === null ? [] : [`--${target}`, v];
};

const runCommand = (cmd, cmdArgs) => new Promise((resolve, reject) => {
  const child = spawn(cmd, cmdArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`${cmd} ${cmdArgs.join(' ')} failed with code ${code}`));
  });
});

const benchmarkArgs = [
  ...forwardIfPresent('rounds'),
  ...forwardIfPresent('n'),
  ...forwardIfPresent('meq'),
  ...forwardIfPresent('mineq'),
  ...forwardIfPresent('maxIter'),
  ...forwardIfPresent('seed')
];

const analyzeArgs = [
  '--require', 'true',
  ...forwardIfPresent('min-total-speedup'),
  ...forwardIfPresent('min-solver-speedup'),
  ...forwardIfPresent('min-wasm-ok-rate'),
  ...forwardIfPresent('min-wasm-feasible-rate'),
  ...forwardIfPresent('require-phase-c'),
  ...forwardIfPresent('max-matrixfree-fallback-rate'),
  ...forwardIfPresent('max-matrixfree-unknown-fallback-rate')
];

await runCommand(process.execPath, ['--import', 'tsx', 'diagnostics/kkt-e2e-benchmark.mjs', ...benchmarkArgs]);
await runCommand(process.execPath, ['--import', 'tsx', 'diagnostics/kkt-e2e-analyze.mjs', ...analyzeArgs]);

console.log('✅ KKT E2E auto pipeline complete');
