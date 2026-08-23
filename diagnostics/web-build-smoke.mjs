import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(projectRoot, '.tmp', 'analysis-verification', 'pages-dist');
const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const port = 4197;
const baseUrl = `http://127.0.0.1:${port}/co-opt/`;

await rm(outputDirectory, { recursive: true, force: true });

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code ?? signal}: ${stderr || stdout}`));
    });
  });
}

const buildStartedAt = performance.now();
await run(process.execPath, [viteCli, 'build', '--outDir', outputDirectory, '--emptyOutDir']);
const buildElapsedMs = performance.now() - buildStartedAt;
const indexPath = path.join(outputDirectory, 'index.html');
const html = await readFile(indexPath, 'utf8');
assert.doesNotMatch(html, /src="\/main\.ts"/, 'production HTML retained the development entry');
const assetUrls = [...html.matchAll(/(?:src|href)="(\/co-opt\/assets\/[^"]+)"/g)]
  .map((match) => match[1]);
assert.ok(assetUrls.some((url) => /\/main-[^/]+\.js$/.test(url)), 'stable main entry is missing');
assert.ok(assetUrls.some((url) => /\/app-[^/]+\.js$/.test(url)), 'React app entry is missing');
const assetFiles = await readdir(path.join(outputDirectory, 'assets'));
assert.ok(assetFiles.some((name) => /\.wasm$/.test(name)), 'Rust/WASM artifact is missing from Pages build');

const preview = spawn(process.execPath, [
  viteCli,
  'preview',
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort',
  '--outDir', outputDirectory,
], {
  cwd: projectRoot,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let previewOutput = '';
preview.stdout?.on('data', (chunk) => { previewOutput += String(chunk); });
preview.stderr?.on('data', (chunk) => { previewOutput += String(chunk); });

const waitForResponse = async () => {
  const deadline = Date.now() + 15_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (preview.exitCode !== null) throw new Error(`Vite preview exited early: ${previewOutput}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return response;
      lastError = new Error(`preview returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('Vite preview did not become ready');
};

const stopPreview = () => new Promise((resolve) => {
  if (preview.exitCode !== null) {
    resolve();
    return;
  }
  const timer = setTimeout(resolve, 3000);
  preview.once('close', () => {
    clearTimeout(timer);
    resolve();
  });
  preview.kill('SIGTERM');
});

try {
  const response = await waitForResponse();
  const servedHtml = await response.text();
  assert.match(servedHtml, /<div id="react-root"><\/div>/, 'served React app root is missing');
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
  const servedAssets = [];
  for (const assetUrl of assetUrls) {
    const assetResponse = await fetch(new URL(assetUrl, baseUrl));
    assert.equal(assetResponse.status, 200, `asset failed to load: ${assetUrl}`);
    const bytes = Number(assetResponse.headers.get('content-length')) || (await assetResponse.arrayBuffer()).byteLength;
    assert.ok(bytes > 0, `asset is empty: ${assetUrl}`);
    servedAssets.push({ url: assetUrl, bytes });
  }
  console.log(JSON.stringify({
    ok: true,
    buildElapsedMs,
    baseUrl,
    coop: response.headers.get('cross-origin-opener-policy'),
    coep: response.headers.get('cross-origin-embedder-policy'),
    htmlBytes: Buffer.byteLength(servedHtml),
    assetCount: assetFiles.length,
    wasmAssets: assetFiles.filter((name) => /\.wasm$/.test(name)),
    servedAssets,
  }, null, 2));
} finally {
  await stopPreview();
}
