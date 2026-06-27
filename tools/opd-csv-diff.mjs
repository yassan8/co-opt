import { readFile, writeFile } from 'node:fs/promises';

const parseArgs = (argv) => {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
};

const args = parseArgs(process.argv);
const basePath = args.base;
const currentPath = args.current;
const outPath = args.out || 'opd_profile_report_delta.csv';

if (!basePath || !currentPath) {
  console.error('Usage: node tools/opd-csv-diff.mjs --base <csv> --current <csv> --out <csv>');
  process.exit(1);
}

const parseCsv = (text) => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const values = line.split(',');
    const row = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = values[i] ?? '';
    }
    return row;
  });
  return { headers, rows };
};

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

const numericKeys = new Set([
  'totalMs',
  'traceMs',
  'intersectMs',
  'surfaceNormalMs',
  'casesCompleted',
  'casesPlanned',
  'errorCount'
]);

const [baseText, currentText] = await Promise.all([
  readFile(basePath, 'utf8'),
  readFile(currentPath, 'utf8')
]);

const baseCsv = parseCsv(baseText);
const currentCsv = parseCsv(currentText);

const baseByMode = new Map();
for (const row of baseCsv.rows) {
  baseByMode.set(String(row.mode || '').trim(), row);
}

const lines = [];
lines.push([
  'mode',
  'totalMs',
  'totalMsDelta',
  'totalMsDeltaPct',
  'traceMs',
  'traceMsDelta',
  'traceMsDeltaPct',
  'intersectMs',
  'intersectMsDelta',
  'intersectMsDeltaPct',
  'surfaceNormalMs',
  'surfaceNormalMsDelta',
  'surfaceNormalMsDeltaPct',
  'casesCompleted',
  'casesCompletedDelta',
  'casesPlanned',
  'casesPlannedDelta',
  'errorCount',
  'errorCountDelta',
  'rustWasmReady',
  'firstError'
].join(','));

for (const row of currentCsv.rows) {
  const mode = String(row.mode || '').trim();
  const base = baseByMode.get(mode) || {};
  const outRow = { mode };

  for (const key of numericKeys) {
    const currentVal = toNumber(row[key]);
    const baseVal = toNumber(base[key]);
    const delta = currentVal - baseVal;
    const pct = Number.isFinite(baseVal) && baseVal !== 0 ? (delta / baseVal) * 100 : NaN;
    outRow[key] = Number.isFinite(currentVal) ? currentVal.toFixed(3) : '';
    outRow[`${key}Delta`] = Number.isFinite(delta) ? delta.toFixed(3) : '';
    outRow[`${key}DeltaPct`] = Number.isFinite(pct) ? pct.toFixed(2) : '';
  }

  outRow.rustWasmReady = row.rustWasmReady || '';
  outRow.firstError = row.firstError || '';

  lines.push([
    outRow.mode,
    outRow.totalMs,
    outRow.totalMsDelta,
    outRow.totalMsDeltaPct,
    outRow.traceMs,
    outRow.traceMsDelta,
    outRow.traceMsDeltaPct,
    outRow.intersectMs,
    outRow.intersectMsDelta,
    outRow.intersectMsDeltaPct,
    outRow.surfaceNormalMs,
    outRow.surfaceNormalMsDelta,
    outRow.surfaceNormalMsDeltaPct,
    outRow.casesCompleted,
    outRow.casesCompletedDelta,
    outRow.casesPlanned,
    outRow.casesPlannedDelta,
    outRow.errorCount,
    outRow.errorCountDelta,
    outRow.rustWasmReady,
    outRow.firstError
  ].join(','));
}

await writeFile(outPath, lines.join('\n'), 'utf8');
console.log(`Delta CSV saved: ${outPath}`);
