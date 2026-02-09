#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

async function isFile(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function collectDocsFiles(docsDir) {
  /** @type {string[]} */
  const relFiles = [];

  /** @param {string} dir */
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;

      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip dot-directories inside docs (defensive).
        if (entry.name.startsWith('.')) continue;
        await walk(abs);
        continue;
      }
      if (entry.isFile()) {
        // Skip dotfiles in docs like .nojekyll (no root counterpart, keep as-is).
        if (entry.name.startsWith('.')) continue;
        relFiles.push(path.relative(docsDir, abs).split(path.sep).join('/'));
      }
    }
  }

  await walk(docsDir);
  return relFiles.sort();
}

async function main() {
  const repoRoot = process.cwd();
  const docsDir = path.join(repoRoot, 'docs');

  await fs.access(docsDir);

  const relDocsFiles = await collectDocsFiles(docsDir);

  /** @type {string[]} */
  const updated = [];
  /** @type {string[]} */
  const missingInRoot = [];

  for (const rel of relDocsFiles) {
    const docsPath = path.join(docsDir, rel);
    const rootPath = path.join(repoRoot, rel);

    if (!(await isFile(rootPath))) {
      missingInRoot.push(rel);
      continue;
    }

    const [rootBuf, docsBuf] = await Promise.all([fs.readFile(rootPath), fs.readFile(docsPath)]);
    if (!rootBuf.equals(docsBuf)) {
      await fs.writeFile(docsPath, rootBuf);
      updated.push(rel);
    }
  }

  console.log(`Scanned ${relDocsFiles.length} docs files.`);
  console.log(`Updated ${updated.length} file(s) from repo root.`);

  if (updated.length) {
    console.log('\nUpdated:');
    for (const p of updated) console.log(`- ${p}`);
  }

  // Not an error; docs may contain build-only artifacts.
  if (missingInRoot.length) {
    console.log(`\nNote: ${missingInRoot.length} docs file(s) have no root counterpart (left unchanged).`);
  }
}

main().catch((err) => {
  console.error('ERROR:', err?.stack ?? err?.message ?? String(err));
  process.exitCode = 1;
});
