#!/usr/bin/env node
/**
 * Build GitHub Pages (docs/) output by crawling local dependencies.
 *
 * - Entry points are discovered from index.html: local <script src>, inline module imports,
 *   and local <link href> assets.
 * - JS files are scanned for static imports and dynamic import('...') with string literals.
 * - JS/HTML are heuristically scanned for fetch('...'), new Worker('...') and .wasm references.
 *
 * Usage:
 *   node tools/build-pages-docs.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(process.cwd());
const outDir = path.join(projectRoot, 'docs');

const IGNORE_FILE_RE = /(?:^|\/)(?:node_modules|\.git|\.vscode|\.venv)\//;

function stripQuery(p) {
  return String(p).split('?')[0].split('#')[0];
}

function isLocalRelative(p) {
  if (!p) return false;
  const s = String(p).trim();
  if (!s) return false;
  if (s.startsWith('http://') || s.startsWith('https://')) return false;
  if (s.startsWith('//')) return false;
  if (s.startsWith('data:')) return false;
  if (s.startsWith('blob:')) return false;
  // For GH Pages we want relative paths, not absolute-from-origin.
  if (s.startsWith('/')) return false;

  // JS bare specifiers like "three" / "OrbitControls" are not local files.
  // Treat as local only if it is a relative path, a subpath, or has a file extension.
  const hasDotPrefix = s.startsWith('./') || s.startsWith('../');
  const hasSlash = s.includes('/');
  const hasExtension = /\.[a-z0-9]+$/i.test(stripQuery(s));
  return hasDotPrefix || hasSlash || hasExtension;
}

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath) {
  return await fs.readFile(filePath, 'utf8');
}

function findLocalRefsInHtml(html) {
  /** @type {string[]} */
  const refs = [];

  // <script src="...">
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')/gi)) {
    const raw = m[1] ?? m[2];
    if (isLocalRelative(raw)) refs.push(stripQuery(raw));
  }

  // <link href="...">
  for (const m of html.matchAll(/<link\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)')/gi)) {
    const raw = m[1] ?? m[2];
    if (isLocalRelative(raw)) refs.push(stripQuery(raw));
  }

  // Heuristic: inline module imports: import('...') / import ... from '...'
  // (We keep this simple; main dependency crawl happens in JS files.)
  for (const m of html.matchAll(/\bimport\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/g)) {
    const raw = m[1] ?? m[2];
    if (isLocalRelative(raw)) refs.push(stripQuery(raw));
  }

  return refs;
}

function findLocalRefsInJs(code) {
  /** @type {string[]} */
  const refs = [];

  // Very lightweight comment stripping so we don't crawl commented-out imports.
  // This is not a full JS parser, but it's good enough for dependency discovery.
  const stripped = String(code)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // import x from './foo.js'
  for (const m of stripped.matchAll(/\bimport\s+(?:[^'";]+\s+from\s+)?(?:"([^"]+)"|'([^']+)')\s*;?/g)) {
    const raw = m[1] ?? m[2];
    if (isLocalRelative(raw)) refs.push(stripQuery(raw));
  }

  // dynamic import('./foo.js')
  for (const m of stripped.matchAll(/\bimport\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/g)) {
    const raw = m[1] ?? m[2];
    if (isLocalRelative(raw)) refs.push(stripQuery(raw));
  }

  // fetch('./foo.wasm') / new Worker('./w.js')
  for (const m of stripped.matchAll(/\b(?:fetch|new\s+Worker)\s*\(\s*(?:"([^"]+)"|'([^']+)')/g)) {
    const raw = m[1] ?? m[2];
    if (isLocalRelative(raw)) refs.push(stripQuery(raw));
  }

  // WebAssembly.instantiateStreaming(fetch('x.wasm')) — covered by fetch, but keep extra wasm literal scan
  for (const m of stripped.matchAll(/(?:"([^"]+\.wasm)"|'([^']+\.wasm)')/g)) {
    const raw = m[1] ?? m[2];
    if (isLocalRelative(raw)) refs.push(stripQuery(raw));
  }

  return refs;
}

function resolveFrom(fromFileAbs, ref) {
  const r = String(ref);
  // For fetch()/Worker()/asset URLs, relative paths are resolved against the document base URL
  // (project root when deployed). Treat non-dot paths like "defaults/x.json" as root-relative.
  if (r.startsWith('./') || r.startsWith('../')) {
    const baseDir = path.dirname(fromFileAbs);
    return path.resolve(baseDir, r);
  }
  return path.resolve(projectRoot, r);
}

function toProjectRel(absPath) {
  const rel = path.relative(projectRoot, absPath);
  return rel.split(path.sep).join('/');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyFilePreserveDirs(srcAbs) {
  const rel = toProjectRel(srcAbs);
  const dstAbs = path.join(outDir, rel);
  await ensureDir(path.dirname(dstAbs));
  await fs.copyFile(srcAbs, dstAbs);
}

async function main() {
  const indexAbs = path.join(projectRoot, 'index.html');
  if (!(await exists(indexAbs))) {
    console.error('index.html not found at repo root:', indexAbs);
    process.exit(1);
  }

  // Clean output.
  await fs.rm(outDir, { recursive: true, force: true });
  await ensureDir(outDir);

  // GH Pages: disable Jekyll processing.
  await fs.writeFile(path.join(outDir, '.nojekyll'), '');

  /** @type {Set<string>} */
  const visited = new Set(); // project-relative paths
  /** @type {string[]} */
  const queue = [];

  const indexHtml = await readText(indexAbs);
  queue.push('index.html');
  for (const ref of findLocalRefsInHtml(indexHtml)) queue.push(ref);

  while (queue.length) {
    const rel = queue.shift();
    if (!rel) continue;
    if (rel.startsWith('./')) {
      // normalize
    }

    // Normalize path separators.
    const relNorm = rel.split('\\').join('/');
    if (visited.has(relNorm)) continue;

    const abs = path.resolve(projectRoot, relNorm);
    if (IGNORE_FILE_RE.test(abs + '/')) continue;

    if (!(await exists(abs))) {
      // Not fatal, but print so you can add to the allow-list or fix refs.
      console.warn('[build-pages-docs] missing:', relNorm);
      visited.add(relNorm);
      continue;
    }

    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      visited.add(relNorm);
      continue;
    }

    visited.add(relNorm);

    // Copy the file.
    await copyFilePreserveDirs(abs);

    // Crawl dependencies.
    const ext = path.extname(relNorm).toLowerCase();
    if (ext === '.js' || ext === '.mjs') {
      const code = await readText(abs);
      for (const ref of findLocalRefsInJs(code)) {
        const resolvedAbs = resolveFrom(abs, ref);
        const resolvedRel = toProjectRel(resolvedAbs);
        queue.push(resolvedRel);
      }
    } else if (ext === '.html') {
      const html = await readText(abs);
      for (const ref of findLocalRefsInHtml(html)) {
        const resolvedAbs = resolveFrom(abs, ref);
        const resolvedRel = toProjectRel(resolvedAbs);
        queue.push(resolvedRel);
      }
    }
  }

  // Summary
  const files = Array.from(visited).filter((p) => p && !p.endsWith('/'));
  files.sort();
  console.log(`[build-pages-docs] wrote ${files.length} files to docs/`);

  // Lightweight sanity: ensure main entry exists in docs
  const docsIndex = path.join(outDir, 'index.html');
  if (!(await exists(docsIndex))) {
    console.error('docs/index.html missing (unexpected)');
    process.exit(1);
  }
}

await main();
