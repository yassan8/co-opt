import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dbgPort = 9223;
const userDir = `/tmp/coopt-cdp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const root = process.cwd();
const outWrapper = `${root}/diagnostics/results/phase-c-benchmark-browser-sample-postpatch-wrapper.json`;
const outNorm = `${root}/diagnostics/results/phase-c-benchmark-browser-sample-postpatch-normalized.json`;

const chrome = spawn(chromeBin, [
  '--headless=new',
  '--disable-gpu',
  `--remote-debugging-port=${dbgPort}`,
  `--user-data-dir=${userDir}`,
  'about:blank'
], { stdio: 'ignore' });

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForDebugger(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${dbgPort}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(200);
  }
  throw new Error('DevTools endpoint timeout');
}

try {
  await waitForDebugger();
  const targets = await fetch(`http://127.0.0.1:${dbgPort}/json/list`).then((r) => r.json());
  const pageTarget = Array.isArray(targets) ? targets.find((t) => t?.type === 'page' && t?.webSocketDebuggerUrl) : null;
  const wsUrl = pageTarget?.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('No page webSocketDebuggerUrl');

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (e) => reject(e.error || e), { once: true });
  });

  let id = 0;
  const pending = new Map();
  let loadFiredResolve;
  const loadFired = new Promise((resolve) => { loadFiredResolve = resolve; });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Page.loadEventFired') {
      loadFiredResolve?.();
    }
  });

  function cdp(method, params = {}) {
    const reqId = ++id;
    ws.send(JSON.stringify({ id: reqId, method, params }));
    return new Promise((resolve, reject) => pending.set(reqId, { resolve, reject }));
  }

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: 'http://127.0.0.1:1421/co-opt/' });
  await Promise.race([
    loadFired,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Page load timeout')), 120000))
  ]);

  const expression = [
    '(async () => {',
    '  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
    '  const waitFor = async (fn, timeoutMs = 180000) => {',
    '    const t0 = performance.now();',
    '    while (performance.now() - t0 < timeoutMs) {',
    '      try { const v = fn(); if (v) return v; } catch (_) {}',
    '      await sleep(100);',
    '    }',
    "    throw new Error('waitFor timeout');",
    '  };',
    '  await waitFor(() => window.__loadAllDataObjectIntoApp && window.OptimizationMVP?.exportMatrixFreeJson, 180000);',
    "  const sampleResp = await fetch('/co-opt/sample/sample-block-positive-lens-airgap.json', { cache: 'no-store' });",
    "  if (!sampleResp.ok) throw new Error('sample fetch failed: ' + sampleResp.status);",
    '  const sampleData = await sampleResp.json();',
    '  await window.__loadAllDataObjectIntoApp(sampleData);',
    '  await sleep(250);',
    '  const out = await window.OptimizationMVP.exportMatrixFreeJson({ repeat: 6, warmupDiscard: 1, download: false, method: "kkt" });',
    '  return out;',
    '})()'
  ].join('\n');

  const evalResult = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  if (evalResult?.exceptionDetails) throw new Error('Runtime.evaluate exception');
  const wrapper = evalResult?.result?.value;
  if (!wrapper || typeof wrapper !== 'object') throw new Error('No wrapper value returned');

  let normalized = wrapper;
  if (typeof wrapper.json === 'string') {
    try { normalized = JSON.parse(wrapper.json); } catch {}
  }

  await fs.writeFile(outWrapper, JSON.stringify(wrapper, null, 2) + '\n', 'utf8');
  await fs.writeFile(outNorm, JSON.stringify(normalized, null, 2) + '\n', 'utf8');

  const mode = normalized?.phaseC?.selectedMode;
  const selected = mode === 'matrixFreePriority' ? normalized?.matrixFreePriority : normalized?.matrixFree;
  const metrics = {
    mode,
    matrixFreeCalls: selected?.phaseC?.matrixFreeCalls,
    matrixFreeFallbacks: selected?.phaseC?.matrixFreeFallbacks,
    matrixFreeFallbackRate: selected?.phaseC?.matrixFreeFallbackRate,
    matrixFreeFallbackReasons: selected?.phaseC?.matrixFreeFallbackReasons,
    speedup: mode === 'matrixFreePriority' ? normalized?.speedups?.matrixFreePriorityElapsed : normalized?.speedups?.matrixFreeElapsed
  };

  console.log(JSON.stringify({ outWrapper, outNorm, metrics }, null, 2));
  try { ws.close(); } catch {}
} finally {
  try { chrome.kill('SIGTERM'); } catch {}
  try { await fs.rm(userDir, { recursive: true, force: true }); } catch {}
}
