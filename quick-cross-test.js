#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function hashLike(text) {
  // Lightweight stable hash (FNV-1a 32bit) for quick equality checks
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function comparePair(leftRel, rightRel) {
  const root = process.cwd();
  const left = path.join(root, leftRel);
  const right = path.join(root, rightRel);

  if (!exists(left)) {
    return { ok: false, reason: `missing: ${leftRel}` };
  }
  if (!exists(right)) {
    return { ok: false, reason: `missing: ${rightRel}` };
  }

  const a = readText(left);
  const b = readText(right);

  if (a === b) {
    return { ok: true, detail: `${leftRel} == ${rightRel}` };
  }

  return {
    ok: false,
    reason: `mismatch: ${leftRel} (${hashLike(a)}) != ${rightRel} (${hashLike(b)})`
  };
}

function main() {
  const pairs = [
    ['eva-wavefront.js', 'docs/eva-wavefront.js'],
    ['eva-wavefront-plot.js', 'docs/eva-wavefront-plot.js'],
    ['ui/event-handlers.js', 'docs/ui/event-handlers.js'],
    ['ui/event-handlers.js', 'docs/event-handlers.js']
  ];

  const results = pairs.map(([a, b]) => comparePair(a, b));
  const failures = results.filter(r => !r.ok);

  if (failures.length === 0) {
    console.log(`✅ quick-cross-test: OK (${pairs.length} mirror checks)`);
    process.exit(0);
  }

  console.error(`❌ quick-cross-test: FAILED (${failures.length}/${pairs.length})`);
  for (const f of failures) console.error(` - ${f.reason}`);
  console.error('Hint: docs/ のミラーが古い可能性があります。該当ファイルをコピーして再実行してください。');
  process.exit(1);
}

main();
