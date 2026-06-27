const EPS = 1e-12;
const MAX_ABS_CURVATURE = 1e6;
export const DOUBLET_BENDING_BASE_KEY = '__cooptDoubletBendingBaseCurvatures';

function computeCurvatureScale(curvatures: { c1: number; c2: number; c3: number }): number {
  const magnitudes = [
    Math.abs(curvatures.c1),
    Math.abs(curvatures.c2),
    Math.abs(curvatures.c3),
  ].filter((value) => Number.isFinite(value) && value > EPS);
  if (magnitudes.length === 0) return 1;
  const average = magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length;
  return average > EPS ? average : 1;
}

function isPlainObject(value: any): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneCurvatures(curvatures: any): { c1: number; c2: number; c3: number } {
  return {
    c1: Number(curvatures?.c1),
    c2: Number(curvatures?.c2),
    c3: Number(curvatures?.c3),
  };
}

function normalizeFiniteNumber(value: any): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseRadiusCurvature(value: any): number | null {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (/^inf(inity)?$/i.test(text)) return 0;
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || Math.abs(numeric) < EPS) return null;
    return 1 / numeric;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) < EPS) return null;
    return 1 / value;
  }
  return null;
}

function curvatureToRadius(curvature: number): number | 'INF' | null {
  if (!Number.isFinite(curvature) || Math.abs(curvature) > MAX_ABS_CURVATURE) return null;
  if (Math.abs(curvature) < EPS) return 'INF';
  const radius = 1 / curvature;
  if (!Number.isFinite(radius)) return null;
  return radius;
}

function readParams(block: any): Record<string, any> | null {
  return isPlainObject(block?.parameters) ? block.parameters : null;
}

function ensureMetadata(block: any): Record<string, any> | null {
  if (!isPlainObject(block)) return null;
  if (!isPlainObject(block.metadata)) block.metadata = {};
  return block.metadata;
}

function readStoredBendingValue(block: any): number | null {
  const params = readParams(block);
  if (params && Object.prototype.hasOwnProperty.call(params, 'bending')) {
    const numeric = normalizeFiniteNumber(params.bending);
    if (numeric !== null) return numeric;
  }
  const vars = isPlainObject(block?.variables) ? block.variables : null;
  if (vars && isPlainObject(vars.bending) && Object.prototype.hasOwnProperty.call(vars.bending, 'value')) {
    return normalizeFiniteNumber(vars.bending.value);
  }
  return null;
}

function readCurrentCurvatures(block: any): { c1: number; c2: number; c3: number } | null {
  const params = readParams(block);
  if (!params) return null;
  const c1 = parseRadiusCurvature(params.radius1);
  const c2 = parseRadiusCurvature(params.radius2);
  const c3 = parseRadiusCurvature(params.radius3);
  if (c1 === null || c2 === null || c3 === null) return null;
  return { c1, c2, c3 };
}

function readStoredBaseCurvatures(block: any): { c1: number; c2: number; c3: number } | null {
  const metadata = isPlainObject(block?.metadata) ? block.metadata : null;
  const raw = metadata ? metadata[DOUBLET_BENDING_BASE_KEY] : null;
  if (!isPlainObject(raw)) return null;
  const c1 = normalizeFiniteNumber(raw.c1);
  const c2 = normalizeFiniteNumber(raw.c2);
  const c3 = normalizeFiniteNumber(raw.c3);
  if (c1 === null || c2 === null || c3 === null) return null;
  return { c1, c2, c3 };
}

function computeBaseCurvatures(block: any, currentCurvatures: { c1: number; c2: number; c3: number }): { c1: number; c2: number; c3: number } {
  const storedBase = readStoredBaseCurvatures(block);
  if (storedBase) return storedBase;
  return cloneCurvatures(currentCurvatures);
}

function computeState(block: any): {
  currentCurvatures: { c1: number; c2: number; c3: number };
  baseCurvatures: { c1: number; c2: number; c3: number };
  rawK: number;
  bending: number;
  scale: number;
  consistent: boolean;
} | null {
  const currentCurvatures = readCurrentCurvatures(block);
  if (!currentCurvatures) return null;

  const baseCurvatures = computeBaseCurvatures(block, currentCurvatures);
  const deltas = [
    currentCurvatures.c1 - baseCurvatures.c1,
    currentCurvatures.c2 - baseCurvatures.c2,
    currentCurvatures.c3 - baseCurvatures.c3,
  ];
  const finiteDeltas = deltas.filter((delta) => Number.isFinite(delta));
  if (finiteDeltas.length !== 3) return null;

  const minDelta = Math.min(...finiteDeltas);
  const maxDelta = Math.max(...finiteDeltas);
  const consistent = Math.abs(maxDelta - minDelta) <= 1e-9;
  const rawK = consistent
    ? (finiteDeltas[0] + finiteDeltas[1] + finiteDeltas[2]) / 3
    : 0;
  const scale = computeCurvatureScale(baseCurvatures);
  const fallbackDisplay = readStoredBendingValue(block) ?? 0;
  const bending = consistent
    ? rawK / scale
    : fallbackDisplay;

  return {
    currentCurvatures,
    baseCurvatures,
    rawK,
    bending,
    scale,
    consistent,
  };
}

export function isDoubletBendingBlock(blockOrType: any): boolean {
  const blockType = typeof blockOrType === 'string'
    ? String(blockOrType).trim()
    : String(blockOrType?.blockType ?? '').trim();
  return blockType === 'Doublet';
}

export function getDoubletBendingCurrentValue(block: any): number | '' {
  if (!isDoubletBendingBlock(block)) return '';
  const state = computeState(block);
  if (!state) return '';
  return Number.isFinite(state.bending) ? state.bending : '';
}

export function getDoubletBendingCurrentK(block: any): number | '' {
  if (!isDoubletBendingBlock(block)) return '';
  const state = computeState(block);
  if (!state) return '';
  return Number.isFinite(state.rawK) ? state.rawK : '';
}

export function storeDoubletBendingBaseCurvatures(block: any, baseCurvatures: { c1: number; c2: number; c3: number } | null): void {
  const metadata = ensureMetadata(block);
  if (!metadata) return;
  if (!baseCurvatures) {
    delete metadata[DOUBLET_BENDING_BASE_KEY];
    return;
  }
  metadata[DOUBLET_BENDING_BASE_KEY] = cloneCurvatures(baseCurvatures);
}

export function syncDoubletBendingState(block: any): number | '' {
  if (!isDoubletBendingBlock(block)) return '';
  const params = readParams(block);
  if (!params) return '';

  const state = computeState(block);
  if (!state) return '';

  if (!state.consistent) {
    storeDoubletBendingBaseCurvatures(block, state.currentCurvatures);
    params.bending = 0;
    return 0;
  }

  storeDoubletBendingBaseCurvatures(block, state.baseCurvatures);
  params.bending = state.bending;
  return state.bending;
}

export function resolveDoubletBendingUpdate(block: any, bendingValue: any): {
  oldRadius1: any;
  oldRadius2: any;
  oldRadius3: any;
  newRadius1: number | 'INF';
  newRadius2: number | 'INF';
  newRadius3: number | 'INF';
  bending: number;
  baseCurvatures: { c1: number; c2: number; c3: number };
} | null {
  if (!isDoubletBendingBlock(block)) return null;
  const params = readParams(block);
  if (!params) return null;

  const nextBending = normalizeFiniteNumber(bendingValue);
  if (nextBending === null) return null;

  const state = computeState(block);
  if (!state) return null;

  const baseCurvatures = state.consistent ? state.baseCurvatures : state.currentCurvatures;
  const scale = computeCurvatureScale(baseCurvatures);
  const nextRawK = nextBending * scale;
  const currentRawK = state.consistent ? state.rawK : 0;
  const delta = nextRawK - currentRawK;

  const nextC1 = state.currentCurvatures.c1 + delta;
  const nextC2 = state.currentCurvatures.c2 + delta;
  const nextC3 = state.currentCurvatures.c3 + delta;
  if (!Number.isFinite(nextC1) || !Number.isFinite(nextC2) || !Number.isFinite(nextC3)) return null;
  if (Math.abs(nextC1) > MAX_ABS_CURVATURE || Math.abs(nextC2) > MAX_ABS_CURVATURE || Math.abs(nextC3) > MAX_ABS_CURVATURE) return null;

  const newRadius1 = curvatureToRadius(nextC1);
  const newRadius2 = curvatureToRadius(nextC2);
  const newRadius3 = curvatureToRadius(nextC3);
  if (newRadius1 === null || newRadius2 === null || newRadius3 === null) return null;

  return {
    oldRadius1: params.radius1,
    oldRadius2: params.radius2,
    oldRadius3: params.radius3,
    newRadius1,
    newRadius2,
    newRadius3,
    bending: nextBending,
    baseCurvatures: cloneCurvatures(baseCurvatures),
  };
}
