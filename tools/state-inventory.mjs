#!/usr/bin/env node
/*
 * State inventory crawler for Step 1 (State Ownership Contract).
 *
 * Scans repo source files (excluding generated outputs) and summarizes:
 * - localStorage key usage (getItem/setItem/removeItem/clear)
 * - window.* export assignments (window.<prop> assignment patterns)
 *
 * Output:
 * - documentation/STATE_INVENTORY_REPORT.md
 * - documentation/STATE_INVENTORY_REPORT.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(process.cwd());

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.vscode',
  '.venv',
  'dist',
  'docs',
]);

const DEFAULT_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.html']);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function relFromRoot(absPath) {
  return toPosix(path.relative(projectRoot, absPath));
}

function isIgnoredDir(dirName) {
  return DEFAULT_IGNORED_DIRS.has(dirName);
}

async function* walkFiles(dirAbs) {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredDir(entry.name)) continue;
      // Skip hidden dirs by default (except .github which we want to scan).
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      yield* walkFiles(full);
      continue;
    }
    if (!entry.isFile()) continue;

    // Skip common temporary/backup files created by editors or merge tools.
    // Examples seen in this repo: ".!62634!optimizer-mvp.ts".
    if (entry.name.startsWith('.!') || entry.name.startsWith('.#')) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!DEFAULT_EXTS.has(ext)) continue;

    // Skip lock files and minified bundles (best-effort).
    if (entry.name.endsWith('.min.js')) continue;

    yield full;
  }
}

function addMapCount(map, key, inc = 1) {
  map.set(key, (map.get(key) ?? 0) + inc);
}

function addSetMap(map, key, value) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function scanText(fileRel, text, out) {
  if (fileRel === 'tools/state-inventory.mjs') {
    return;
  }

  // localStorage.getItem('key') / setItem / removeItem
  const lsKeyRe = /\blocalStorage\.(getItem|setItem|removeItem)\s*\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)\s*(?:,|\))/g;
  // localStorage.clear()
  const lsClearRe = /\blocalStorage\.clear\s*\(/g;

  // window.<prop> assignment patterns (exports / mutations)
  // NOTE: Avoid false positives for comparisons like `window.<prop> === ...`.
  // We treat it as an assignment only when the `=` is not followed by another `=` (after optional whitespace).
  const winAssignRe = /\bwindow\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?![=])/g;

  for (const m of text.matchAll(lsKeyRe)) {
    const op = m[1];
    const key = m[2] ?? m[3] ?? m[4];
    if (!key) continue;

    addMapCount(out.localStorage.ops, op);
    addMapCount(out.localStorage.keys, key);
    addSetMap(out.localStorage.keyFiles, key, fileRel);
    addSetMap(out.localStorage.opFiles, op, fileRel);
  }

  if (lsClearRe.test(text)) {
    // Count number of clear() hits
    const matches = [...text.matchAll(lsClearRe)].length;
    addMapCount(out.localStorage.ops, 'clear', matches);
    addSetMap(out.localStorage.opFiles, 'clear', fileRel);
  }

  for (const m of text.matchAll(winAssignRe)) {
    const prop = m[1];
    if (!prop) continue;
    addMapCount(out.window.assignments, prop);
    addSetMap(out.window.assignmentFiles, prop, fileRel);
  }
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function setMapToObject(map) {
  const obj = {};
  for (const [k, set] of map.entries()) {
    obj[k] = [...set].sort();
  }
  return obj;
}

function topEntries(map, n) {
  return [...map.entries()].sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
}

function renderMarkdown(report) {
  const now = new Date().toISOString();

  const topKeys = topEntries(report.localStorage.keys, 30);
  const topAssignments = topEntries(report.window.assignments, 40);

  const lines = [];
  lines.push(`# State Inventory Report (auto-generated)`);
  lines.push('');
  lines.push(`Generated: ${now}`);
  lines.push(`Root: ${report.meta.projectRootRel}`);
  lines.push(`Files scanned: ${report.meta.filesScanned}`);
  lines.push(`Ignored dirs: ${report.meta.ignoredDirs.join(', ')}`);
  lines.push('');

  lines.push('## localStorage usage (summary)');
  lines.push('');
  lines.push('| op | count | files |');
  lines.push('|---|---:|---:|');
  for (const [op, count] of topEntries(report.localStorage.ops, 20)) {
    const fileCount = report.localStorage.opFiles.get(op)?.size ?? 0;
    lines.push(`| ${op} | ${count} | ${fileCount} |`);
  }
  lines.push('');

  lines.push('## localStorage keys (top)');
  lines.push('');
  lines.push('| key | hits | files | sample files |');
  lines.push('|---|---:|---:|---|');
  for (const [key, hits] of topKeys) {
    const files = [...(report.localStorage.keyFiles.get(key) ?? new Set())].sort();
    const sample = files.slice(0, 5).map((f) => `\`${f}\``).join('<br>');
    lines.push(`| ${key} | ${hits} | ${files.length} | ${sample} |`);
  }
  lines.push('');

  lines.push('## window.* assignments (top)');
  lines.push('');
  lines.push('| property | hits | files | sample files |');
  lines.push('|---|---:|---:|---|');
  for (const [prop, hits] of topAssignments) {
    const files = [...(report.window.assignmentFiles.get(prop) ?? new Set())].sort();
    const sample = files.slice(0, 5).map((f) => `\`${f}\``).join('<br>');
    lines.push(`| ${prop} | ${hits} | ${files.length} | ${sample} |`);
  }
  lines.push('');

  lines.push('## Notes');
  lines.push('');
  lines.push('- This report intentionally excludes generated artifacts (`dist/`, `docs/`).');
  lines.push('- The regex-based scan is approximate; treat as a starting point for ownership assignment.');
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const out = {
    meta: {
      projectRootRel: '.',
      filesScanned: 0,
      ignoredDirs: [...DEFAULT_IGNORED_DIRS].sort(),
    },
    localStorage: {
      ops: new Map(),
      opFiles: new Map(),
      keys: new Map(),
      keyFiles: new Map(),
    },
    window: {
      assignments: new Map(),
      assignmentFiles: new Map(),
    },
  };

  for await (const abs of walkFiles(projectRoot)) {
    const rel = relFromRoot(abs);
    let text;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    out.meta.filesScanned += 1;
    scanText(rel, text, out);
  }

  const reportJson = {
    meta: out.meta,
    localStorage: {
      ops: mapToObject(out.localStorage.ops),
      opFiles: setMapToObject(out.localStorage.opFiles),
      keys: mapToObject(out.localStorage.keys),
      keyFiles: setMapToObject(out.localStorage.keyFiles),
    },
    window: {
      assignments: mapToObject(out.window.assignments),
      assignmentFiles: setMapToObject(out.window.assignmentFiles),
    },
  };

  const reportMd = renderMarkdown(out);

  const mdPath = path.join(projectRoot, 'documentation', 'STATE_INVENTORY_REPORT.md');
  const jsonPath = path.join(projectRoot, 'documentation', 'STATE_INVENTORY_REPORT.json');

  await fs.mkdir(path.dirname(mdPath), { recursive: true });
  await fs.writeFile(mdPath, reportMd, 'utf8');
  await fs.writeFile(jsonPath, JSON.stringify(reportJson, null, 2) + '\n', 'utf8');

  console.log(`[state-inventory] scanned ${out.meta.filesScanned} files`);
  console.log(`[state-inventory] wrote ${relFromRoot(mdPath)}`);
  console.log(`[state-inventory] wrote ${relFromRoot(jsonPath)}`);
}

await main();
