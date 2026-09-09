import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checks, pendingChecks } from './software-validation/manifest.mjs';
import { classifyResult, summarize } from './software-validation/result-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex < 0 ? null : new Set(String(args[onlyIndex + 1] ?? '').split(','));
if (only && [...only].some(id => !checks.some(check => check.id === id))) throw new Error('Unknown --only check ID; see software-validation/manifest.mjs.');
const outputRoot = path.join(root, '.tmp', 'software-validation');
await mkdir(outputRoot, { recursive: true });
const runDirectory = await mkdtemp(path.join(outputRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
const relative = value => path.relative(root, value).replaceAll('\\', '/');
const runPath = file => path.join(runDirectory, file);
const git = (...gitArgs) => spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? 'unavailable';
const revision = git('rev-parse', 'HEAD');
const dirtyTrackedFiles = git('diff', '--name-only');
const startedAt = new Date().toISOString();
const results = [];
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

async function inventory(directory) {
  const rows = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (['results', 'fixtures', 'playwright-results'].includes(entry.name)) continue;
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) rows.push(...await inventory(file));
    else if (/\.(mjs|mts|ts)$/.test(entry.name)) {
      const source = await readFile(path.join(root, file), 'utf8');
      rows.push({ file, sha256: createHash('sha256').update(source).digest('hex'),
        // These lexical hints are not a test-coverage measurement.
        hints: [
          /assert\.|throw new Error/.test(source) ? 'has assertions' : 'review assertions',
          /readOptionalExampleFixture/.test(source) ? 'optional fixture: skip possible' : null,
          /readFileSync.*(?:\.tsx?|\.css)|doesNotMatch|assert\.match/.test(source) ? 'may include source-contract checks' : null,
          /playwright|page\.goto/.test(source) ? 'browser-related; execution not implied' : null,
        ].filter(Boolean),
      });
    }
  }
  return rows;
}

function run(command, commandArgs, definition) {
  return new Promise(resolve => {
    const started = performance.now();
    const logFile = runPath(`${definition.id}.log`);
    const log = createWriteStream(logFile);
    let output = '', timedOut = false, launchError;
    const env = { ...process.env };
    delete env.MICHELSON_CONFIG;
    delete env.MICHELSON_IMAGE_DATA;
    if (definition.native && process.platform === 'win32') env.COOPT_TAURI_TEST_MANIFEST = '1';
    const child = spawn(command, commandArgs, { cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = chunk => {
      log.write(chunk);
      output = (output + chunk.toString()).slice(-8 * 1024 * 1024);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      // The analysis runner launches further diagnostics. Stop only this
      // process tree, so a timeout cannot leave its calculations behind.
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill();
    }, definition.timeoutMs);
    child.on('error', error => { launchError = error; });
    child.on('close', code => {
      clearTimeout(timer);
      log.end(() => resolve({ code, error: launchError, timedOut, output,
        elapsedMs: performance.now() - started, log: relative(logFile) }));
    });
  });
}

const testInventory = [...await inventory('diagnostics'), ...await inventory('testing'), ...await inventory('tests')];
await writeFile(runPath('inventory.json'), JSON.stringify(testInventory, null, 2));
const tracked = git('ls-files', '-z').split('\0').filter(file => (
  /^(analysis|optimization|raytracing|core|data|ui|src|rust-wasm\/src|rust-shared|src-tauri\/src)\//.test(file)
  && /\.(ts|tsx|js|rs|css)$/.test(file)
));
const inputFiles = new Set([...tracked, ...testInventory.map(item => item.file), 'package.json', 'package-lock.json',
  'Examples/default-load.json', 'Examples/Michelson_Interferometer.json', 'Examples/Fizeau_Interferometer.json',
  'rust-wasm/pkg/surface_origins_bg.wasm', 'public/rust-wasm/pkg/surface_origins_bg.wasm']);
const fingerprints = [];
for (const file of inputFiles) {
  try {
    fingerprints.push({ file, sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fingerprints.push({ file, missing: true });
  }
}
await writeFile(runPath('fingerprints.json'), JSON.stringify(fingerprints, null, 2));

for (const [index, definition] of checks.entries()) {
  const base = { id: definition.id, title: definition.title, evidence: definition.evidence };
  if ((only && !only.has(definition.id)) || (definition.native && !args.includes('--native') && !only?.has(definition.id))) {
    results.push({ ...base, status: 'pending', reason: 'Not selected in this run.' });
    continue;
  }
  console.log(`[${index + 1}/${checks.length}] RUN ${definition.id}`);
  let command = definition.command ?? process.execPath;
  let commandArgs = definition.args ?? ['--max-old-space-size=1536', '--import', 'tsx', definition.file];
  if (definition.contract === 'analysis') commandArgs = [...commandArgs, '--stage', 'integrated', '--out-dir', relative(runPath('analysis'))];
  if (definition.contract === 'build') commandArgs = [definition.file, 'build', '--outDir', relative(runPath('build')), '--emptyOutDir'];
  const processResult = await run(command, commandArgs, definition);
  let outcome;
  if (definition.contract === 'analysis' && processResult.code === 0 && !processResult.error && !processResult.timedOut) {
    try {
      const report = JSON.parse(await readFile(runPath('analysis/analysis-verification-latest.json'), 'utf8'));
      const checksRun = report.stages.flatMap(stage => stage.results);
      const allPassed = checksRun.length >= 28 && checksRun.every(check => check.status === 'pass');
      outcome = { status: allPassed ? 'pass' : 'fail', data: report.summary,
        reason: allPassed ? undefined : 'Missing or failed optical-analysis checks.' };
    } catch (error) { outcome = { status: 'fail', reason: error.message }; }
  } else outcome = classifyResult({ ...processResult, contract: definition.contract, marker: definition.marker });
  results.push({ ...base, ...outcome, elapsedMs: processResult.elapsedMs, log: processResult.log,
    command: [command, ...commandArgs].join(' '), maxNodeOldSpaceMiB: commandArgs.includes('--max-old-space-size=1536') ? 1536 : null });
  console.log(`  ${outcome.status.toUpperCase()} ${(processResult.elapsedMs / 1000).toFixed(1)} s${outcome.reason ? ` — ${outcome.reason}` : ''}`);
  // Checkpoint after every diagnostic: a later interruption must not erase evidence.
  await writeFile(runPath('checkpoint.json'), JSON.stringify({ startedAt, revision, results }, null, 2));
}
results.push(...pendingChecks.map(check => ({ ...check, status: 'pending', evidence: 'Separate evidence required' })));
const summary = summarize(results);
const report = { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), revision,
  workingTree: 'Results apply to the current working tree, not HEAD alone.', dirtyTrackedFiles,
  node: process.version, platform: process.platform, architecture: process.arch,
  inventoryEntries: testInventory.length, inventory: relative(runPath('inventory.json')),
  fingerprints: relative(runPath('fingerprints.json')),
  summary, results };
const labels = { pass: '合格', fail: '失敗', blocked: '実行不可', pending: '未検証' };
const note = 'この表は検証範囲を限定した実行記録です。画面コードの検査、スタブ、単体テストの合格を、実画面・装置全体の保証へ読み替えないでください。';
const markdown = `# ソフトウェア検証結果\n\n${note}\n\n実行: ${startedAt}\n\n基点コミット: ${revision}（作業中の変更を含む）\n\n合格 ${summary.pass} / 失敗 ${summary.fail} / 実行不可 ${summary.blocked} / 未検証 ${summary.pending}\n\n| 項目 | 結果 | 確認方法・限界 |\n|---|---|---|\n` + results.map(row => `| ${row.title} | ${labels[row.status]} | ${row.evidence}${row.reason ? ` — ${row.reason}` : ''} |`).join('\n') + '\n';
await writeFile(runPath('report.json'), JSON.stringify(report, null, 2));
await writeFile(runPath('report.md'), markdown);
await writeFile(runPath('report.html'), `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>co-opt 検証結果</title><style>body{font:15px/1.65 system-ui,sans-serif;max-width:1200px;margin:32px auto;padding:0 20px;color:#20304a}table{border-collapse:collapse;width:100%}td,th{padding:12px;border:1px solid #ccd3df;text-align:left;vertical-align:top}.pass{color:#146236}.fail{color:#ac2323}.blocked,.pending{color:#755817}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto}small{color:#536278}</style><h1>ソフトウェア検証結果</h1><p>${escape(note)}</p><p>${escape(startedAt)} · ${escape(revision.slice(0, 10))}＋作業中の変更</p><p>合格 ${summary.pass} ／ 失敗 ${summary.fail} ／ 実行不可 ${summary.blocked} ／ 未検証 ${summary.pending}</p><table><thead><tr><th>検証項目</th><th>結果</th><th>根拠・未確認範囲</th></tr></thead><tbody>${results.map(row => `<tr><td>${escape(row.title)}</td><td class="${row.status}">${labels[row.status]}<br><small>${row.elapsedMs == null ? '' : `${(row.elapsedMs / 1000).toFixed(1)} s`}</small></td><td>${escape(row.evidence)}${row.reason ? `<p>${escape(row.reason)}</p>` : ''}${row.data ? `<details><summary>数値結果</summary><pre>${escape(JSON.stringify(row.data, null, 2))}</pre></details>` : ''}</td></tr>`).join('')}</tbody></table><p>詳細ログと入力診断のハッシュ: 同じフォルダの report.json / inventory.json</p></html>`);
console.log(`Report: ${relative(runPath('report.html'))}`);
console.log(JSON.stringify(summary));
process.exitCode = summary.fail ? 1 : summary.blocked ? 2 : 0;
