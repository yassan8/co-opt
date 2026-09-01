import { buildCandidateEvaluation, type CandidateEvaluation } from './tolerance-study.ts';

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
  const meritEditor = host?.meritFunctionEditor;
  if (!meritEditor || (typeof meritEditor.calculateOperandValueAsync !== 'function' && typeof meritEditor.calculateOperandValue !== 'function')) {
    return { valid: false, passed: false, score: Number.POSITIVE_INFINITY, requirements: [], reason: 'Requirements evaluator is not ready.' };
  }
  const requirementEditor = host?.systemRequirementsEditor;
  const overrides = buildOverrides(candidateSystemConfig);
  const values = new Map<string, any>();
  const errors = new Map<string, string>();
  const currentById = new Map<string, number>();

  const previous = {
    blocks: host.__cooptBlocksOverride,
    assembly: host.__cooptAssemblyOverride,
    systemConfig: host.__cooptSystemConfig,
    preferRuntime: host.__cooptPreferRuntimeSystemConfig,
    fastMode: host.__cooptMeritFastMode,
    evaluating: host.__COOPT_EVALUATING_REQUIREMENTS,
    runtimeCache: meritEditor._runtimeCache,
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
    meritEditor._runtimeCache = new Map();

    for (let index = 0; index < requirementRows.length; index += 1) {
      if (signal?.aborted) throw new DOMException(String(signal.reason || 'Cancelled'), 'AbortError');
      const row = requirementRows[index];
      if (!row || row.rowType === 'memo' || row.enabled === false || !row.operand) continue;
      const id = String(row.id ?? index + 1);
      const configId = normalizeConfigId(row, candidateSystemConfig);
      const operand = {
        operand: String(row.operand),
        configId,
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
      try {
        const scoped = typeof requirementEditor?._buildScopedOperandObjects === 'function'
          ? requirementEditor._buildScopedOperandObjects(row, operand)
          : [operand];
        let selected: number | null = null;
        let selectedViolation = Number.NEGATIVE_INFINITY;
        for (const scopedOperand of (Array.isArray(scoped) && scoped.length > 0 ? scoped : [operand])) {
          const raw = typeof meritEditor.calculateOperandValueAsync === 'function'
            ? await meritEditor.calculateOperandValueAsync(scopedOperand)
            : meritEditor.calculateOperandValue(scopedOperand);
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
        if (selected === null) {
          errors.set(id, 'Operand returned no finite value.');
        } else {
          values.set(id, selected);
          currentById.set(id, selected);
        }
      } catch (error) {
        errors.set(id, error instanceof Error ? error.message : String(error));
      }
      if (index % 2 === 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return buildCandidateEvaluation(requirementRows, values, errors);
  } finally {
    meritEditor._runtimeCache = previous.runtimeCache;
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
