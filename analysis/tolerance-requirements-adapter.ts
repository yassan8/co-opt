import { buildCandidateEvaluation, type CandidateEvaluation } from './tolerance-study.ts';
import { isTauriRuntime } from '../src/desktop/runtime.ts';
import { calculateImageSpaceDiffractionParams } from '../raytracing/core/ray-paraxial.ts';

const NATIVE_TOLERANCE_OPERANDS = new Set([
  'OBJD', 'TSL', 'CTCT', 'SDIST', 'IMD',
  'BEXP', 'EXPD', 'EXPP', 'ENPD', 'ENPP', 'ENPM',
  'PMAG', 'FNO_OBJ', 'FNO_IMG', 'FNO_WRK', 'NA_OBJ', 'NA_IMG', 'EDGE',
  'SPOT_SIZE_ANNULAR', 'SPOT_SIZE_RECT', 'SPOT_SIZE_CURRENT', 'TA_RMS_UM',
  'TOT3_SPH', 'TOT3_COMA', 'TOT3_ASTI', 'TOT3_FCUR', 'TOT3_DIST', 'TOT_LCA', 'TOT_TCA',
  'REAY', 'RSCE', 'TRAC',
]);

let evaluationQueue: Promise<void> = Promise.resolve();
const nativeParity = new Map<string, boolean>();

const clone = <T>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

function normalizeConfigId(row: any, candidate: any): string {
  const hint = String(row?.configId ?? '').trim();
  const configurations = Array.isArray(candidate?.configurations) ? candidate.configurations : [];
  if (hint) {
    const byId = configurations.find((entry: any) => String(entry?.id) === hint);
    if (byId) return String(byId.id);
    const byName = configurations.find((entry: any) => String(entry?.name ?? '').trim() === hint);
    if (byName) return String(byName.id);
  }
  return String(candidate?.activeConfigId ?? configurations[0]?.id ?? '');
}

function buildOverrides(candidate: any): { blocks: Record<string, any[]>; assembly: Record<string, any> } {
  const blocks: Record<string, any[]> = {};
  const assembly: Record<string, any> = {};
  for (const config of (Array.isArray(candidate?.configurations) ? candidate.configurations : [])) {
    const configId = String(config?.id ?? '');
    if (!configId) continue;
    blocks[configId] = clone(Array.isArray(config?.blocks) ? config.blocks : []);
    assembly[configId] = clone({
      designConnections: config?.designConnections ?? [],
      sequentialGroups: config?.sequentialGroups ?? [],
      portRoutes: config?.portRoutes ?? [],
      routeSets: config?.routeSets ?? [],
    });
  }
  return { blocks, assembly };
}

function enqueueEvaluation<T>(task: () => Promise<T>): Promise<T> {
  const run = evaluationQueue.then(task, task);
  evaluationQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function withCandidateOverrides<T>(host: any, candidateSystemConfig: any, task: () => Promise<T>): Promise<T> {
  const meritEditor = host?.meritFunctionEditor;
  const overrides = buildOverrides(candidateSystemConfig);
  const previous = {
    blocks: host.__cooptBlocksOverride,
    assembly: host.__cooptAssemblyOverride,
    systemConfig: host.__cooptSystemConfig,
    preferRuntime: host.__cooptPreferRuntimeSystemConfig,
    fastMode: host.__cooptMeritFastMode,
    evaluating: host.__COOPT_EVALUATING_REQUIREMENTS,
    runtimeCache: meritEditor?._runtimeCache,
  };
  const owned = {
    blocks: Object.prototype.hasOwnProperty.call(host, '__cooptBlocksOverride'),
    assembly: Object.prototype.hasOwnProperty.call(host, '__cooptAssemblyOverride'),
    systemConfig: Object.prototype.hasOwnProperty.call(host, '__cooptSystemConfig'),
    preferRuntime: Object.prototype.hasOwnProperty.call(host, '__cooptPreferRuntimeSystemConfig'),
    fastMode: Object.prototype.hasOwnProperty.call(host, '__cooptMeritFastMode'),
    evaluating: Object.prototype.hasOwnProperty.call(host, '__COOPT_EVALUATING_REQUIREMENTS'),
  };
  try {
    host.__cooptBlocksOverride = overrides.blocks;
    host.__cooptAssemblyOverride = overrides.assembly;
    host.__cooptSystemConfig = clone(candidateSystemConfig);
    host.__cooptPreferRuntimeSystemConfig = true;
    host.__cooptMeritFastMode = previous.fastMode && typeof previous.fastMode === 'object'
      ? { ...previous.fastMode, enabled: false }
      : { enabled: false };
    host.__COOPT_EVALUATING_REQUIREMENTS = true;
    if (meritEditor) meritEditor._runtimeCache = new Map();
    return await task();
  } finally {
    if (meritEditor) meritEditor._runtimeCache = previous.runtimeCache;
    const restore = (key: string, had: boolean, value: any) => {
      if (had) host[key] = value;
      else {
        try { delete host[key]; } catch (_) { host[key] = undefined; }
      }
    };
    restore('__cooptBlocksOverride', owned.blocks, previous.blocks);
    restore('__cooptAssemblyOverride', owned.assembly, previous.assembly);
    restore('__cooptSystemConfig', owned.systemConfig, previous.systemConfig);
    restore('__cooptPreferRuntimeSystemConfig', owned.preferRuntime, previous.preferRuntime);
    restore('__cooptMeritFastMode', owned.fastMode, previous.fastMode);
    restore('__COOPT_EVALUATING_REQUIREMENTS', owned.evaluating, previous.evaluating);
  }
}

function makeOperand(row: any, index: number, candidateSystemConfig: any, currentById: Map<string, number>): any {
  return {
    operand: String(row.operand),
    configId: normalizeConfigId(row, candidateSystemConfig),
    __reqRowId: row.id,
    __reqRowIndex: index,
    __reqEvaluationState: { currentById },
    __reqOp: row.op,
    __reqTarget: row.target,
    __reqTol: row.tol,
    __reqWeight: row.weight,
    __reqEnabled: row.enabled !== false,
    param1: row.param1,
    param2: row.param2,
    param3: row.param3,
    param4: row.param4,
    param5: row.param5,
    target: row.target,
    weight: row.weight,
  };
}

async function evaluateCandidateInternal(
  host: any,
  candidateSystemConfig: any,
  requirementRows: any[],
  signal?: AbortSignal,
): Promise<CandidateEvaluation> {
  const meritEditor = host?.meritFunctionEditor;
  if (!meritEditor || (typeof meritEditor.calculateOperandValueAsync !== 'function' && typeof meritEditor.calculateOperandValue !== 'function')) {
    return { valid: false, passed: false, score: Number.POSITIVE_INFINITY, requirements: [], reason: 'Requirements evaluator is not ready.' };
  }
  const requirementEditor = host?.systemRequirementsEditor;
  return withCandidateOverrides(host, candidateSystemConfig, async () => {
    const values = new Map<string, any>();
    const errors = new Map<string, string>();
    const currentById = new Map<string, number>();
    for (let index = 0; index < requirementRows.length; index += 1) {
      if (signal?.aborted) throw new DOMException(String(signal.reason || 'Cancelled'), 'AbortError');
      const row = requirementRows[index];
      if (!row || row.rowType === 'memo' || row.enabled === false || !row.operand) continue;
      const id = String(row.id ?? index + 1);
      const operand = makeOperand(row, index, candidateSystemConfig, currentById);
      try {
        const scoped = typeof requirementEditor?._buildScopedOperandObjects === 'function'
          ? requirementEditor._buildScopedOperandObjects(row, operand)
          : [operand];
        const scopedOperands = Array.isArray(scoped) && scoped.length > 0 ? scoped : [operand];
        const rawValues = typeof meritEditor.calculateOperandValuesBatchAsync === 'function'
          ? await meritEditor.calculateOperandValuesBatchAsync(scopedOperands)
          : await Promise.all(scopedOperands.map(async (scopedOperand: any) => (
            typeof meritEditor.calculateOperandValueAsync === 'function'
              ? meritEditor.calculateOperandValueAsync(scopedOperand)
              : meritEditor.calculateOperandValue(scopedOperand)
          )));
        let selected: number | null = null;
        let selectedViolation = Number.NEGATIVE_INFINITY;
        for (const raw of rawValues) {
          const numeric = Number(raw);
          if (!Number.isFinite(numeric)) continue;
          const violation = typeof requirementEditor?.computeViolationAmount === 'function'
            ? requirementEditor.computeViolationAmount(row.op, numeric, row.target, row.tol)
            : 0;
          if (selected === null || violation > selectedViolation) {
            selected = numeric;
            selectedViolation = violation;
          }
        }
        if (selected === null) errors.set(id, 'Operand returned no finite value.');
        else {
          values.set(id, selected);
          currentById.set(id, selected);
        }
      } catch (error) {
        errors.set(id, error instanceof Error ? error.message : String(error));
      }
    }
    return { ...buildCandidateEvaluation(requirementRows, values, errors), evaluationBackend: 'serial' };
  });
}

function paritySignature(requirementRows: any[]): string {
  return requirementRows
    .filter((row) => row && row.rowType !== 'memo' && row.enabled !== false && row.operand)
    .map((row) => [row.operand, row.configId, row.param1, row.param2, row.param3, row.param4, row.param5].join(':'))
    .join('|');
}

function evaluationsMatch(reference: CandidateEvaluation, candidate: CandidateEvaluation): boolean {
  if (reference.requirements.length !== candidate.requirements.length) return false;
  for (const expected of reference.requirements) {
    const actual = candidate.requirements.find((entry) => entry.id === expected.id);
    if (!actual || expected.current === null || actual.current === null) return false;
    const scale = Math.max(1, Math.abs(expected.current));
    if (Math.abs(actual.current - expected.current) > Math.max(1e-8, 5e-3 * scale)) return false;
  }
  return true;
}

async function tryNativeCandidateBatch(
  host: any,
  candidates: any[],
  requirementRows: any[],
  signal?: AbortSignal,
): Promise<CandidateEvaluation[] | null> {
  if (!isTauriRuntime() || candidates.length < 2) return null;
  const meritEditor = host?.meritFunctionEditor;
  const requirementEditor = host?.systemRequirementsEditor;
  if (!meritEditor || typeof meritEditor.getOpticalSystemDataByConfigId !== 'function') return null;
  const currentById = new Map<string, number>();
  const expanded: Array<{ row: any; rowIndex: number; id: string; operand: any }> = [];
  for (let rowIndex = 0; rowIndex < requirementRows.length; rowIndex += 1) {
    const row = requirementRows[rowIndex];
    if (!row || row.rowType === 'memo' || row.enabled === false || !row.operand) continue;
    const base = makeOperand(row, rowIndex, candidates[0], currentById);
    const scoped = typeof requirementEditor?._buildScopedOperandObjects === 'function'
      ? requirementEditor._buildScopedOperandObjects(row, base)
      : [base];
    for (const operand of (Array.isArray(scoped) && scoped.length > 0 ? scoped : [base])) {
      const type = String(operand?.operand ?? '').trim().toUpperCase();
      if (!NATIVE_TOLERANCE_OPERANDS.has(type)) return null;
      expanded.push({ row, rowIndex, id: String(row.id ?? rowIndex + 1), operand });
    }
  }
  if (expanded.length === 0) return null;
  const groups = new Map<string, typeof expanded>();
  for (const entry of expanded) {
    const configId = String(entry.operand.configId ?? '');
    const group = groups.get(configId) ?? [];
    group.push(entry);
    groups.set(configId, group);
  }
  const configIds = Array.from(groups.keys());
  const compiledCandidates: Array<Record<string, any[]>> = [];
  for (const candidate of candidates) {
    if (signal?.aborted) throw new DOMException(String(signal.reason || 'Cancelled'), 'AbortError');
    const compiled = await withCandidateOverrides(host, candidate, async () => {
      const rowsByConfig: Record<string, any[]> = {};
      for (const configId of configIds) {
        const rows = meritEditor.getOpticalSystemDataByConfigId(configId);
        if (!Array.isArray(rows) || rows.length === 0) throw new Error(`No optical rows for ${configId}.`);
        rowsByConfig[configId] = clone(rows);
      }
      return rowsByConfig;
    });
    compiledCandidates.push(compiled);
  }
  const scenarioBatches = await withCandidateOverrides(host, candidates[0], async () => configIds.map((configId) => {
    const tables = typeof meritEditor.getConfigTablesByConfigId === 'function'
      ? meritEditor.getConfigTablesByConfigId(configId, { preferConfigTables: true })
      : { source: [], object: [] };
    return {
      sourceRows: clone(Array.isArray(tables?.source) ? tables.source : []),
      objectRows: clone(Array.isArray(tables?.object) ? tables.object : []),
      systemRequirementsRows: (groups.get(configId) ?? []).map(({ row, operand }) => ({
        id: row.id,
        configId,
        enabled: true,
        operand: operand.operand,
        op: row.op,
        target: row.target,
        tol: row.tol,
        weight: row.weight,
        param1: operand.param1,
        param2: operand.param2,
        param3: operand.param3,
        param4: operand.param4,
        param5: operand.param5,
      })),
      activeConfigId: configId,
    };
  }));
  const ipc = await import('../src/desktop/ipc/client.ts');
  const response = await ipc.evaluateOptimizerCandidatesMultiScenario({ candidates: compiledCandidates, scenarioBatches });
  const currents = Array.isArray(response?.currentsPerCandidate) ? response.currentsPerCandidate : [];
  if (currents.length !== candidates.length) return null;
  const orderedEntries = configIds.flatMap((configId) => groups.get(configId) ?? []);
  const results = currents.map((candidateValues) => {
    const values = new Map<string, any>();
    const errors = new Map<string, string>();
    const selectedViolation = new Map<string, number>();
    orderedEntries.forEach((entry, index) => {
      const numeric = Number(candidateValues?.[index]);
      if (!Number.isFinite(numeric)) return;
      const violation = typeof requirementEditor?.computeViolationAmount === 'function'
        ? requirementEditor.computeViolationAmount(entry.row.op, numeric, entry.row.target, entry.row.tol)
        : 0;
      if (!values.has(entry.id) || violation > (selectedViolation.get(entry.id) ?? Number.NEGATIVE_INFINITY)) {
        values.set(entry.id, numeric);
        selectedViolation.set(entry.id, violation);
      }
    });
    for (const entry of expanded) if (!values.has(entry.id)) errors.set(entry.id, 'Native batch returned no finite value.');
    return { ...buildCandidateEvaluation(requirementRows, values, errors), evaluationBackend: 'rust-rayon' } as CandidateEvaluation;
  });
  const signature = paritySignature(requirementRows);
  const cachedParity = nativeParity.get(signature);
  if (cachedParity === false) return null;
  if (cachedParity !== true) {
    const reference = await evaluateCandidateInternal(host, candidates[0], requirementRows, signal);
    const passed = evaluationsMatch(reference, results[0]);
    nativeParity.set(signature, passed);
    if (!passed) return null;
    results[0] = reference;
  }
  return results;
}

async function tryWasmMtfCandidateBatch(
  host: any,
  candidates: any[],
  requirementRows: any[],
  signal?: AbortSignal,
): Promise<CandidateEvaluation[] | null> {
  if (candidates.length < 2) return null;
  const meritEditor = host?.meritFunctionEditor;
  const requirementEditor = host?.systemRequirementsEditor;
  if (!meritEditor || typeof meritEditor.getOpticalSystemDataByConfigId !== 'function') return null;
  const expanded: Array<{ row: any; id: string; operand: any }> = [];
  const currentById = new Map<string, number>();
  for (let rowIndex = 0; rowIndex < requirementRows.length; rowIndex += 1) {
    const row = requirementRows[rowIndex];
    if (!row || row.rowType === 'memo' || row.enabled === false || !row.operand) continue;
    const base = makeOperand(row, rowIndex, candidates[0], currentById);
    const scoped = typeof requirementEditor?._buildScopedOperandObjects === 'function'
      ? requirementEditor._buildScopedOperandObjects(row, base)
      : [base];
    for (const operand of (Array.isArray(scoped) && scoped.length > 0 ? scoped : [base])) {
      const type = String(operand?.operand ?? '').trim().toUpperCase();
      if (!['MTF', 'MTFT', 'MTFS', 'MTFA'].includes(type)) return null;
      if (String(operand?.param1 ?? '').trim().toUpperCase() === 'ALL_WEIGHTED') return null;
      expanded.push({ row, id: String(row.id ?? rowIndex + 1), operand });
    }
  }
  if (expanded.length === 0) return null;
  const configIds = Array.from(new Set(expanded.map((entry) => String(entry.operand.configId ?? ''))));
  const compiledCandidates: Array<Record<string, any[]>> = [];
  for (const candidate of candidates) {
    if (signal?.aborted) throw new DOMException(String(signal.reason || 'Cancelled'), 'AbortError');
    compiledCandidates.push(await withCandidateOverrides(host, candidate, async () => {
      const rowsByConfig: Record<string, any[]> = {};
      for (const configId of configIds) {
        const rows = meritEditor.getOpticalSystemDataByConfigId(configId);
        if (!Array.isArray(rows) || rows.length === 0) throw new Error(`No optical rows for ${configId}.`);
        rowsByConfig[configId] = clone(rows);
      }
      return rowsByConfig;
    }));
  }
  const tablesByConfig = await withCandidateOverrides(host, candidates[0], async () => {
    const tables: Record<string, { source: any[]; object: any[] }> = {};
    for (const configId of configIds) {
      const value = meritEditor.getConfigTablesByConfigId(configId, { preferConfigTables: true });
      tables[configId] = {
        source: clone(Array.isArray(value?.source) ? value.source : []),
        object: clone(Array.isArray(value?.object) ? value.object : []),
      };
    }
    return tables;
  });
  const jobs: any[] = [];
  for (let candidateIndex = 0; candidateIndex < compiledCandidates.length; candidateIndex += 1) {
    for (let expandedIndex = 0; expandedIndex < expanded.length; expandedIndex += 1) {
      const entry = expanded[expandedIndex];
      const operand = entry.operand;
      const configId = String(operand.configId ?? '');
      const opticalRows = compiledCandidates[candidateIndex][configId];
      const sourceRows = tablesByConfig[configId]?.source ?? [];
      const objectRows = tablesByConfig[configId]?.object ?? [];
      const wavelengthIndex = Math.max(0, Math.floor(Number(operand?.param1) || 1) - 1);
      const wavelength = Number(sourceRows[wavelengthIndex]?.wavelength ?? sourceRows[wavelengthIndex]?.Wavelength);
      const objectIndex = Math.max(0, Math.floor(Number(operand?.param2) || 1) - 1);
      const objectRow = objectRows[objectIndex];
      if (!(Number.isFinite(wavelength) && wavelength > 0) || !objectRow) return null;
      const requestedSampling = Math.floor(Number(operand?.param5) || 32);
      const validSampling = new Set([16, 32, 64, 128, 256, 512, 1024, 2048, 4096]);
      const sampling = validSampling.has(requestedSampling) ? requestedSampling : 32;
      const frequency = Math.max(0, Number(operand?.param4) || 10);
      const position = String(objectRow?.position ?? objectRow?.object ?? '').toLowerCase();
      const isAngle = /\bangle\b/.test(position);
      const fieldX = Number(isAngle ? (objectRow?.xHeightAngle ?? objectRow?.x ?? 0) : (objectRow?.x ?? objectRow?.xHeight ?? 0)) || 0;
      const fieldY = Number(isAngle ? (objectRow?.yHeightAngle ?? objectRow?.y ?? 0) : (objectRow?.y ?? objectRow?.yHeight ?? 0)) || 0;
      const fieldNorm = Math.hypot(fieldX, fieldY);
      const tangentialDir = fieldNorm > 1e-12 ? { x: fieldX / fieldNorm, y: fieldY / fieldNorm } : { x: 1, y: 0 };
      const fNumber = Number(calculateImageSpaceDiffractionParams(opticalRows, wavelength)?.fNumberWorking);
      if (!(Number.isFinite(fNumber) && fNumber > 0)) return null;
      jobs.push({
        opdRequest: {
          opticalSystemRows: opticalRows,
          sourceRows,
          objectRows,
          objectIndex,
          gridSize: sampling,
          wavelengthUm: wavelength,
          pupilSamplingMode: isAngle && fieldNorm > 1e-12 ? 'entrance' : undefined,
          opdDisplayMode: 'pistonTiltRemoved',
        },
        wavelengthUm: wavelength,
        fNumber,
        pupilRange: 1,
        maxFrequencyLpmm: frequency,
        points: 2,
        sampleFrequenciesLpmm: [frequency],
        directEvalOnly: true,
        slimResults: true,
        method: 'malacara-wasm-required',
        tangentialDir,
        sagittalDir: { x: -tangentialDir.y, y: tangentialDir.x },
        meta: { candidateIndex, expandedIndex, onAxis: fieldNorm <= 1e-12 },
      });
    }
  }
  if (jobs.length === 0) return null;
  const ipc = await import('../src/desktop/ipc/client.ts');
  const response = await ipc.runMtfBatchViaWasmWorkerPool({ jobs });
  const jobResults = Array.isArray(response?.results) ? response.results : [];
  if (jobResults.length !== jobs.length) return null;
  const rawByCandidate = candidates.map(() => new Array<number | null>(expanded.length).fill(null));
  for (const result of jobResults) {
    const candidateIndex = Number(result?.meta?.candidateIndex);
    const expandedIndex = Number(result?.meta?.expandedIndex);
    if (!Number.isInteger(candidateIndex) || !Number.isInteger(expandedIndex) || !rawByCandidate[candidateIndex]) continue;
    const mtf = result?.mtf ?? result;
    let tangential = Number(mtf?.sampledMtfTangential?.[0]);
    let sagittal = Number(mtf?.sampledMtfSagittal?.[0]);
    if (result?.meta?.onAxis === true && Number.isFinite(tangential) && Number.isFinite(sagittal)) {
      tangential = sagittal = Math.max(0, Math.min(1, 0.5 * (tangential + sagittal)));
    }
    const type = String(expanded[expandedIndex]?.operand?.operand ?? '').trim().toUpperCase();
    const value = type === 'MTFT' ? tangential : type === 'MTFS' ? sagittal
      : Number.isFinite(tangential) && Number.isFinite(sagittal) ? 0.5 * (tangential + sagittal)
        : Number.isFinite(tangential) ? tangential : sagittal;
    rawByCandidate[candidateIndex][expandedIndex] = Number.isFinite(value) ? value : null;
  }
  const results = rawByCandidate.map((rawValues) => {
    const values = new Map<string, any>();
    const errors = new Map<string, string>();
    const violations = new Map<string, number>();
    expanded.forEach((entry, index) => {
      const value = rawValues[index];
      if (value === null) return;
      const violation = typeof requirementEditor?.computeViolationAmount === 'function'
        ? requirementEditor.computeViolationAmount(entry.row.op, value, entry.row.target, entry.row.tol)
        : 0;
      if (!values.has(entry.id) || violation > (violations.get(entry.id) ?? Number.NEGATIVE_INFINITY)) {
        values.set(entry.id, value);
        violations.set(entry.id, violation);
      }
    });
    for (const entry of expanded) if (!values.has(entry.id)) errors.set(entry.id, 'WASM MTF batch returned no finite value.');
    return { ...buildCandidateEvaluation(requirementRows, values, errors), evaluationBackend: 'wasm-worker-pool' } as CandidateEvaluation;
  });
  const signature = `mtf:${paritySignature(requirementRows)}`;
  const cachedParity = nativeParity.get(signature);
  if (cachedParity === false) return null;
  if (cachedParity !== true) {
    const reference = await evaluateCandidateInternal(host, candidates[0], requirementRows, signal);
    const passed = evaluationsMatch(reference, results[0]);
    nativeParity.set(signature, passed);
    if (!passed) return null;
    results[0] = reference;
  }
  return results;
}

/**
 * Evaluates Requirements against an isolated SystemConfiguration snapshot.
 * The host's transient override hooks are restored before this promise resolves.
 */
export async function evaluateRequirementsForToleranceCandidate(
  host: any,
  candidateSystemConfig: any,
  requirementRows: any[],
  signal?: AbortSignal,
): Promise<CandidateEvaluation> {
  return enqueueEvaluation(() => evaluateCandidateInternal(host, candidateSystemConfig, requirementRows, signal));
}

/**
 * Candidate-level batch entry used by Sensitivity and Monte Carlo tolerance.
 * Desktop evaluates compatible sequential Requirements in one Rayon-backed
 * Rust request. Web and hybrid operands retain exact semantics while sharing
 * the per-candidate route/spot/WASM batches above.
 */
export async function evaluateRequirementsForToleranceCandidates(
  host: any,
  candidateSystemConfigs: any[],
  requirementRows: any[],
  signal?: AbortSignal,
): Promise<CandidateEvaluation[]> {
  const candidates = Array.isArray(candidateSystemConfigs) ? candidateSystemConfigs : [];
  if (candidates.length === 0) return [];
  return enqueueEvaluation(async () => {
    const native = await tryNativeCandidateBatch(host, candidates, requirementRows, signal).catch(() => null);
    if (native) return native;
    const mtf = await tryWasmMtfCandidateBatch(host, candidates, requirementRows, signal).catch(() => null);
    if (mtf) return mtf;
    const results: CandidateEvaluation[] = [];
    for (const candidate of candidates) {
      if (signal?.aborted) throw new DOMException(String(signal.reason || 'Cancelled'), 'AbortError');
      const evaluated = await evaluateCandidateInternal(host, candidate, requirementRows, signal);
      results.push({ ...evaluated, evaluationBackend: 'scoped-batch-fallback' });
    }
    return results;
  });
}
