export interface OptimizeConsoleRow {
  iter: number;
  elapsedMs: number;
  min: number;
  damping: number;
  rho: number;
  alpha: number;
  improv: number;
}

const OPTIMIZE_CONSOLE_COLUMNS = [
  { label: 'Iter', width: 4 },
  { label: 'Elapsed', width: 11 },
  { label: 'Min.', width: 14 },
  { label: 'DFseed', width: 14 },
  { label: 'rho', width: 10 },
  { label: 'alpha', width: 10 },
  { label: 'Improv.', width: 12 },
] as const;

export function formatOptimizeConsoleCell(value: number, width: number, fractionDigits = 6): string {
  if (!Number.isFinite(value)) return ''.padStart(width, ' ');
  const abs = Math.abs(value);
  const text = (abs >= 1e6 || (abs > 0 && abs < 1e-4))
    ? value.toExponential(3)
    : value.toFixed(fractionDigits);
  return text.length >= width ? text : text.padStart(width, ' ');
}

function formatCompactConsoleCell(value: number, width: number, fractionDigits = 3): string {
  if (!Number.isFinite(value)) return ''.padStart(width, ' ');
  const abs = Math.abs(value);
  const text = (abs >= 1e6 || (abs > 0 && abs < 1e-4))
    ? value.toExponential(3)
    : value.toFixed(fractionDigits).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  const normalized = text.includes('.') || text.includes('e') ? text : `${text}.0`;
  return normalized.length >= width ? normalized : normalized.padStart(width, ' ');
}

export function formatOptimizeConsoleHeader(): string {
  return OPTIMIZE_CONSOLE_COLUMNS
    .map((column) => column.label.padStart(column.width, ' '))
    .join('');
}

export function shouldAppendOptimizeConsoleRow(
  phaseInput: unknown,
  accepted: unknown,
  previousMinInput: unknown,
  currentMinInput: unknown,
): boolean {
  const phase = String(phaseInput ?? '').trim().toLowerCase();
  const currentMin = Number(currentMinInput);
  if (!Number.isFinite(currentMin)) return false;
  if (phase === 'start') return true;
  if (accepted !== true) return false;
  const previousMin = Number(previousMinInput);
  if (!Number.isFinite(previousMin)) return true;
  const tolerance = Math.max(1e-12, Math.abs(previousMin) * 1e-12);
  return currentMin < previousMin - tolerance;
}

export function calculateOptimizeConsoleImprovement(
  previousMinInput: unknown,
  currentMinInput: unknown,
): number {
  const previousMin = Number(previousMinInput);
  const currentMin = Number(currentMinInput);
  if (!Number.isFinite(previousMin) || !Number.isFinite(currentMin)) return Number.NaN;
  return previousMin - currentMin;
}

export function formatOptimizeConsoleRow(row: OptimizeConsoleRow): string {
  return [
    String(Math.max(0, Math.floor(Number(row.iter) || 0))).padStart(OPTIMIZE_CONSOLE_COLUMNS[0].width, ' '),
    formatOptimizeElapsed(row.elapsedMs).padStart(OPTIMIZE_CONSOLE_COLUMNS[1].width, ' '),
    formatOptimizeConsoleCell(row.min, OPTIMIZE_CONSOLE_COLUMNS[2].width, 4),
    formatOptimizeConsoleCell(row.damping, OPTIMIZE_CONSOLE_COLUMNS[3].width, 6),
    formatCompactConsoleCell(row.rho, OPTIMIZE_CONSOLE_COLUMNS[4].width, 3),
    formatCompactConsoleCell(row.alpha, OPTIMIZE_CONSOLE_COLUMNS[5].width, 3),
    formatOptimizeConsoleCell(row.improv, OPTIMIZE_CONSOLE_COLUMNS[6].width, 5),
  ].join('');
}

export function formatOptimizeElapsed(elapsedMs: number): string {
  const totalTenths = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 100));
  const hours = Math.floor(totalTenths / 36000);
  const minutes = Math.floor((totalTenths % 36000) / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}
