#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

async function collectFileMap(rootDir) {
  /** @type {Map<string, { absPath: string, size: number }> } */
  const files = new Map();

  /** @param {string} currentDir */
  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (entry.isFile()) {
        const relPath = path.relative(rootDir, absPath).split(path.sep).join('/');
        const stat = await fs.stat(absPath);
        files.set(relPath, { absPath, size: stat.size });
      }
    }
  }

  await walk(rootDir);
  return files;
}

async function main() {
  const repoRoot = process.cwd();
  const leftDir = path.join(repoRoot, 'defaults');
  const rightDir = path.join(repoRoot, 'docs', 'defaults');

  // Quick existence checks for clearer CI errors.
  await fs.access(leftDir);
  await fs.access(rightDir);

  const leftFiles = await collectFileMap(leftDir);
  const rightFiles = await collectFileMap(rightDir);

  const leftOnly = [];
  const rightOnly = [];
  const different = [];

  const allKeys = new Set([...leftFiles.keys(), ...rightFiles.keys()]);
  for (const relPath of [...allKeys].sort()) {
    const left = leftFiles.get(relPath);
    const right = rightFiles.get(relPath);

    if (!left) {
      rightOnly.push(relPath);
      continue;
    }
    if (!right) {
      leftOnly.push(relPath);
      continue;
    }

    if (left.size !== right.size) {
      different.push(relPath);
      continue;
    }

    const [leftBuf, rightBuf] = await Promise.all([
      fs.readFile(left.absPath),
      fs.readFile(right.absPath),
    ]);

    if (!leftBuf.equals(rightBuf)) {
      different.push(relPath);
    }
  }

  const ok = leftOnly.length === 0 && rightOnly.length === 0 && different.length === 0;
  if (ok) {
    console.log('OK: defaults/ and docs/defaults/ are in sync.');
    return;
  }

  console.error('ERROR: defaults/ and docs/defaults/ are NOT in sync.');
  if (leftOnly.length) {
    console.error('\nMissing in docs/defaults (present in defaults):');
    for (const p of leftOnly) console.error(`- ${p}`);
  }
  if (rightOnly.length) {
    console.error('\nExtra in docs/defaults (not present in defaults):');
    for (const p of rightOnly) console.error(`- ${p}`);
  }
  if (different.length) {
    console.error('\nDifferent file contents:');
    for (const p of different) console.error(`- ${p}`);
  }

  process.exitCode = 1;
}

main().catch((err) => {
  console.error('ERROR:', err?.message ?? String(err));
  process.exitCode = 2;
});
