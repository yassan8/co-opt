import {
  getAssemblyDesignVariableValue,
  getDesignVariableValue,
  listToleranceVariablesFromConfig,
  setAssemblyDesignVariableValue,
  setDesignVariableValue,
  type ToleranceVariableDescriptor,
} from '../optimization/design-variables.ts';

export type ToleranceDistribution = 'normal' | 'uniform';
export type ToleranceSigmaMode = 'three-sigma' | 'one-sigma' | 'full-width';
export type ToleranceRunMethod = 'sensitivity' | 'monte-carlo';

export interface ToleranceParameterSpec {
  id: string;
  enabled: boolean;
  configId: string;
  variableRef: string;
  label?: string;
  unit?: string;
  minusTolerance: number;
  plusTolerance: number;
  distribution: ToleranceDistribution;
  sigmaMode: ToleranceSigmaMode;
}

export interface ToleranceCompensatorSpec {
  id: string;
  enabled: boolean;
  configId: string;
  variableRef: string;
  label?: string;
  minimum: number;
  maximum: number;
  samples?: number;
}

export interface ToleranceRunSettings {
  trials: number;
  seed: number;
  sensitivityStepFraction: number;
  compensate: boolean;
}

export interface ToleranceStudy {
  schemaVersion: '1.0';
  id: string;
  name: string;
  requirementIds: string[];
  configScope: 'requirements' | 'active' | 'all';
  parameters: ToleranceParameterSpec[];
  compensators: ToleranceCompensatorSpec[];
  runSettings: ToleranceRunSettings;
  lastResultSummary?: ToleranceResultSummary | null;
}

export interface RequirementEvaluation {
  id: string;
  operand: string;
  configId: string;
  current: number | null;
  target: number;
  tolerance: number;
  operator: '=' | '<=' | '>=';
  weight: number;
  violation: number;
  contribution: number;
  margin: number;
  passed: boolean;
  valid: boolean;
  reason?: string;
}

export interface CandidateEvaluation {
  valid: boolean;
  passed: boolean;
  score: number;
  requirements: RequirementEvaluation[];
  reason?: string;
  evaluationBackend?: 'rust-rayon' | 'wasm-worker-pool' | 'scoped-batch-fallback' | 'serial';
}

export interface SensitivityRequirementImpact {
  requirementId: string;
  nominal: number | null;
  minus: number | null;
  plus: number | null;
  derivativePerUnit: number | null;
  normalizedImpact: number;
}

export interface SensitivityParameterResult {
  parameterId: string;
  variableRef: string;
  label: string;
  minusDelta: number;
  plusDelta: number;
  impact: number;
  nonlinearAsymmetry: number;
  requirements: SensitivityRequirementImpact[];
  minusValid: boolean;
  plusValid: boolean;
}

export interface SensitivityAnalysisResult {
  method: 'sensitivity';
  nominal: CandidateEvaluation;
  parameters: SensitivityParameterResult[];
  startedAt: string;
  elapsedMs: number;
  execution?: ToleranceExecutionSummary;
}

export interface MonteCarloRequirementSummary {
  requirementId: string;
  samples: number;
  validSamples: number;
  passedSamples: number;
  yield: number;
  mean: number | null;
  standardDeviation: number | null;
  p05: number | null;
  p50: number | null;
  p95: number | null;
}

export interface MonteCarloTrialResult {
  index: number;
  valid: boolean;
  passed: boolean;
  score: number;
  requirementValues: Record<string, number | null>;
  appliedDeltas: Record<string, number>;
}

export interface MonteCarloToleranceResult {
  method: 'monte-carlo';
  nominal: CandidateEvaluation;
  seed: number;
  trialsRequested: number;
  trialsCompleted: number;
  validTrials: number;
  passedTrials: number;
  yield: number;
  yieldConfidence95: { low: number; high: number };
  requirements: MonteCarloRequirementSummary[];
  worstTrial: MonteCarloTrialResult | null;
  trials: MonteCarloTrialResult[];
  startedAt: string;
  elapsedMs: number;
  execution?: ToleranceExecutionSummary;
}

export interface ToleranceExecutionSummary {
  candidateEvaluations: number;
  candidateBatches: number;
  maximumBatchSize: number;
  backend: 'candidate-batch' | 'serial-fallback';
  engines: string[];
}

export interface ToleranceResultSummary {
  method: ToleranceRunMethod;
  completedAt: string;
  elapsedMs: number;
  yield?: number;
  trialCount?: number;
  parameterCount: number;
  requirementCount: number;
}

export interface ToleranceProgress {
  phase: 'nominal' | 'sensitivity' | 'compensation' | 'monte-carlo' | 'done';
  completed: number;
  total: number;
  percent: number;
  message: string;
}

export interface ToleranceRunContext {
  systemConfig: any;
  study: ToleranceStudy;
  requirementRows: any[];
  evaluateCandidate: (candidateSystemConfig: any, requirementRows: any[]) => Promise<CandidateEvaluation>;
  evaluateCandidates?: (candidateSystemConfigs: any[], requirementRows: any[]) => Promise<CandidateEvaluation[]>;
  candidateBatchSize?: number;
  onProgress?: (progress: ToleranceProgress) => void;
  signal?: AbortSignal;
}

interface ToleranceExecutionState {
  candidateEvaluations: number;
  candidateBatches: number;
  maximumBatchSize: number;
  usedBatchEvaluator: boolean;
  engines: Set<string>;
}

const clone = <T>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const finite = (value: any, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

const makeId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function createDefaultToleranceStudy(name = 'Engineering Study 1'): ToleranceStudy {
  return {
    schemaVersion: '1.0',
    id: makeId('tol'),
    name,
    requirementIds: [],
    configScope: 'requirements',
    parameters: [],
    compensators: [],
    runSettings: {
      trials: 500,
      seed: 24681357,
      sensitivityStepFraction: 0.25,
      compensate: true,
    },
    lastResultSummary: null,
  };
}

export function normalizeToleranceStudy(raw: any): ToleranceStudy {
  const storedName = String(raw?.name || '').trim();
  const normalizedName = !storedName || storedName === 'Sensitivity & Tolerance' ? 'Engineering Study 1' : storedName;
  const base = createDefaultToleranceStudy(normalizedName);
  const parameters = Array.isArray(raw?.parameters) ? raw.parameters : [];
  const compensators = Array.isArray(raw?.compensators) ? raw.compensators : [];
  return {
    ...base,
    ...raw,
    schemaVersion: '1.0',
    id: String(raw?.id || base.id),
    name: normalizedName,
    requirementIds: Array.isArray(raw?.requirementIds) ? raw.requirementIds.map((id: any) => String(id)) : [],
    configScope: ['requirements', 'active', 'all'].includes(String(raw?.configScope)) ? raw.configScope : 'requirements',
    parameters: parameters.map((entry: any, index: number) => ({
      id: String(entry?.id || `tol-param-${index + 1}`),
      enabled: entry?.enabled !== false,
      configId: String(entry?.configId ?? ''),
      variableRef: String(entry?.variableRef ?? ''),
      label: String(entry?.label ?? ''),
      unit: String(entry?.unit ?? ''),
      minusTolerance: Math.max(0, finite(entry?.minusTolerance, 0)),
      plusTolerance: Math.max(0, finite(entry?.plusTolerance, 0)),
      distribution: entry?.distribution === 'uniform' ? 'uniform' : 'normal',
      sigmaMode: ['three-sigma', 'one-sigma', 'full-width'].includes(String(entry?.sigmaMode)) ? entry.sigmaMode : 'three-sigma',
    })),
    compensators: compensators.map((entry: any, index: number) => ({
      id: String(entry?.id || `tol-comp-${index + 1}`),
      enabled: entry?.enabled !== false,
      configId: String(entry?.configId ?? ''),
      variableRef: String(entry?.variableRef ?? ''),
      label: String(entry?.label ?? ''),
      minimum: finite(entry?.minimum, -1),
      maximum: finite(entry?.maximum, 1),
      samples: clamp(Math.round(finite(entry?.samples, 9)), 3, 41),
    })),
    runSettings: {
      trials: clamp(Math.round(finite(raw?.runSettings?.trials, 500)), 1, 100000),
      seed: Math.trunc(finite(raw?.runSettings?.seed, 24681357)),
      sensitivityStepFraction: clamp(finite(raw?.runSettings?.sensitivityStepFraction, 0.25), 0.001, 1),
      compensate: raw?.runSettings?.compensate !== false,
    },
    lastResultSummary: raw?.lastResultSummary && typeof raw.lastResultSummary === 'object' ? raw.lastResultSummary : null,
  };
}

export function listToleranceCandidates(systemConfig: any, configIds?: string[]): ToleranceVariableDescriptor[] {
  const requested = new Set((configIds || []).map(String));
  const configurations = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
  const out: ToleranceVariableDescriptor[] = [];
  for (const config of configurations) {
    const configId = String(config?.id ?? '');
    if (requested.size > 0 && !requested.has(configId)) continue;
    for (const variable of listToleranceVariablesFromConfig(config)) {
      out.push({ ...variable, configId });
    }
  }
  return out;
}

export function getToleranceVariableValue(systemConfig: any, configId: string, variableRef: string): number | null {
  const config = (systemConfig?.configurations || []).find((entry: any) => String(entry?.id) === String(configId));
  if (!config) return null;
  const raw = variableRef.startsWith('connection:') || variableRef.startsWith('group:')
    ? getAssemblyDesignVariableValue(config, variableRef)
    : getDesignVariableValue(config, variableRef);
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

export function setToleranceVariableValue(systemConfig: any, configId: string, variableRef: string, value: number): boolean {
  const config = (systemConfig?.configurations || []).find((entry: any) => String(entry?.id) === String(configId));
  if (!config || !Number.isFinite(value)) return false;
  return variableRef.startsWith('connection:') || variableRef.startsWith('group:')
    ? setAssemblyDesignVariableValue(config, variableRef, value)
    : setDesignVariableValue(config, variableRef, value);
}

export function computeRequirementViolation(operator: any, current: any, target: any, tolerance: any): number {
  const value = Number(current);
  const spec = Number(target);
  const allowance = Math.max(0, finite(tolerance, 0));
  if (!Number.isFinite(value) || !Number.isFinite(spec)) return Number.POSITIVE_INFINITY;
  if (operator === '<=') return Math.max(0, value - (spec + allowance));
  if (operator === '>=') return Math.max(0, (spec - allowance) - value);
  return Math.max(0, Math.abs(value - spec) - allowance);
}

export function computeRequirementMargin(operator: any, current: any, target: any, tolerance: any): number {
  const value = Number(current);
  const spec = Number(target);
  const allowance = Math.max(0, finite(tolerance, 0));
  if (!Number.isFinite(value) || !Number.isFinite(spec)) return Number.NEGATIVE_INFINITY;
  if (operator === '<=') return spec + allowance - value;
  if (operator === '>=') return value - (spec - allowance);
  return allowance - Math.abs(value - spec);
}

export function buildCandidateEvaluation(requirementRows: any[], values: Map<string, any>, errors: Map<string, string> = new Map()): CandidateEvaluation {
  const requirements: RequirementEvaluation[] = [];
  let score = 0;
  let valid = true;
  let passed = true;
  for (const row of requirementRows) {
    if (!row || row.rowType === 'memo' || row.enabled === false || finite(row.weight, 1) <= 0) continue;
    const id = String(row.id ?? '');
    const raw = values.get(id);
    const current = Number(raw);
    const rowValid = Number.isFinite(current) && !errors.has(id);
    const operator = (row.op === '<=' || row.op === '>=') ? row.op : '=';
    const violation = rowValid ? computeRequirementViolation(operator, current, row.target, row.tol) : Number.POSITIVE_INFINITY;
    const weight = Math.max(0, finite(row.weight, 1));
    const contribution = Number.isFinite(violation) ? weight * violation : Number.POSITIVE_INFINITY;
    const rowPassed = rowValid && violation <= 0;
    requirements.push({
      id,
      operand: String(row.operand ?? ''),
      configId: String(row.configId ?? ''),
      current: rowValid ? current : null,
      target: finite(row.target, 0),
      tolerance: Math.max(0, finite(row.tol, 0)),
      operator,
      weight,
      violation,
      contribution,
      margin: rowValid ? computeRequirementMargin(operator, current, row.target, row.tol) : Number.NEGATIVE_INFINITY,
      passed: rowPassed,
      valid: rowValid,
      reason: errors.get(id),
    });
    if (!rowValid) valid = false;
    if (!rowPassed) passed = false;
    score = Number.isFinite(score + contribution) ? score + contribution : Number.POSITIVE_INFINITY;
  }
  return { valid, passed: valid && passed, score, requirements };
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException(String(signal.reason || 'Cancelled'), 'AbortError');
}

function publishProgress(context: ToleranceRunContext, phase: ToleranceProgress['phase'], completed: number, total: number, message: string): void {
  const safeTotal = Math.max(1, total);
  context.onProgress?.({ phase, completed, total, percent: clamp(100 * completed / safeTotal, 0, 100), message });
}

function createExecutionState(): ToleranceExecutionState {
  return { candidateEvaluations: 0, candidateBatches: 0, maximumBatchSize: 0, usedBatchEvaluator: false, engines: new Set() };
}

function summarizeExecution(state: ToleranceExecutionState): ToleranceExecutionSummary {
  return {
    candidateEvaluations: state.candidateEvaluations,
    candidateBatches: state.candidateBatches,
    maximumBatchSize: state.maximumBatchSize,
    backend: state.usedBatchEvaluator ? 'candidate-batch' : 'serial-fallback',
    engines: Array.from(state.engines),
  };
}

async function evaluateCandidateBatch(
  context: ToleranceRunContext,
  candidates: any[],
  rows: any[],
  execution: ToleranceExecutionState,
): Promise<CandidateEvaluation[]> {
  if (candidates.length === 0) return [];
  abortIfRequested(context.signal);
  const configuredBatchSize = Number(context.candidateBatchSize);
  const batchSize = Number.isFinite(configuredBatchSize) && configuredBatchSize > 0
    ? clamp(Math.round(configuredBatchSize), 1, 128)
    : candidates.length;
  const allResults: CandidateEvaluation[] = [];
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    execution.candidateEvaluations += batch.length;
    execution.candidateBatches += 1;
    execution.maximumBatchSize = Math.max(execution.maximumBatchSize, batch.length);
    if (typeof context.evaluateCandidates === 'function') {
      execution.usedBatchEvaluator = true;
      const results = await context.evaluateCandidates(batch, rows);
      if (!Array.isArray(results) || results.length !== batch.length) {
        throw new Error(`Candidate batch returned ${Array.isArray(results) ? results.length : 0} results for ${batch.length} candidates.`);
      }
      for (const result of results) if (result?.evaluationBackend) execution.engines.add(result.evaluationBackend);
      allResults.push(...results);
    } else {
      for (const candidate of batch) {
        abortIfRequested(context.signal);
        allResults.push(await context.evaluateCandidate(candidate, rows));
        execution.engines.add('serial');
      }
    }
    abortIfRequested(context.signal);
  }
  return allResults;
}

function selectedRequirements(context: ToleranceRunContext): any[] {
  const selected = new Set(context.study.requirementIds.map(String));
  return context.requirementRows.filter((row: any) => {
    if (!row || row.rowType === 'memo' || row.enabled === false || !row.operand) return false;
    return selected.size === 0 || selected.has(String(row.id));
  });
}

async function evaluateCandidatesWithCompensation(
  context: ToleranceRunContext,
  candidates: any[],
  rows: any[],
  execution: ToleranceExecutionState,
): Promise<Array<{ candidate: any; evaluation: CandidateEvaluation }>> {
  let bestCandidates = candidates;
  let bestEvaluations = await evaluateCandidateBatch(context, candidates, rows, execution);
  if (!context.study.runSettings.compensate) {
    return bestCandidates.map((candidate, index) => ({ candidate, evaluation: bestEvaluations[index] }));
  }
  const compensators = context.study.compensators.filter((entry) => entry.enabled && entry.variableRef);
  for (const compensator of compensators) {
    abortIfRequested(context.signal);
    const minimum = Math.min(compensator.minimum, compensator.maximum);
    const maximum = Math.max(compensator.minimum, compensator.maximum);
    const samples = clamp(Math.round(finite(compensator.samples, 9)), 3, 41);
    if (!(maximum > minimum)) continue;
    const nextCandidates = [...bestCandidates];
    const nextEvaluations = [...bestEvaluations];
    const configuredBatchSize = Number(context.candidateBatchSize);
    const memoryBatchSize = Number.isFinite(configuredBatchSize) && configuredBatchSize > 0
      ? clamp(Math.round(configuredBatchSize), 1, 128)
      : 64;
    const ownerBatchSize = Math.max(1, Math.floor(memoryBatchSize / samples));
    for (let ownerStart = 0; ownerStart < bestCandidates.length; ownerStart += ownerBatchSize) {
      const trialCandidates: any[] = [];
      const owners: number[] = [];
      const ownerEnd = Math.min(bestCandidates.length, ownerStart + ownerBatchSize);
      for (let owner = ownerStart; owner < ownerEnd; owner += 1) {
        for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
          const value = minimum + (maximum - minimum) * sampleIndex / Math.max(1, samples - 1);
          const trial = clone(bestCandidates[owner]);
          if (!setToleranceVariableValue(trial, compensator.configId, compensator.variableRef, value)) continue;
          trialCandidates.push(trial);
          owners.push(owner);
        }
      }
      const evaluatedTrials = await evaluateCandidateBatch(context, trialCandidates, rows, execution);
      for (let index = 0; index < evaluatedTrials.length; index += 1) {
        const owner = owners[index];
        const evaluated = evaluatedTrials[index];
        const current = nextEvaluations[owner];
        if ((evaluated.valid && !current.valid) || evaluated.score < current.score) {
          nextCandidates[owner] = trialCandidates[index];
          nextEvaluations[owner] = evaluated;
        }
      }
    }
    bestCandidates = nextCandidates;
    bestEvaluations = nextEvaluations;
  }
  return bestCandidates.map((candidate, index) => ({ candidate, evaluation: bestEvaluations[index] }));
}

export async function runSensitivityAnalysis(context: ToleranceRunContext): Promise<SensitivityAnalysisResult> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const execution = createExecutionState();
  const rows = selectedRequirements(context);
  abortIfRequested(context.signal);
  publishProgress(context, 'nominal', 0, 1, 'Evaluating nominal design');
  const parameters = context.study.parameters.filter((entry) => entry.enabled && entry.variableRef && (entry.minusTolerance > 0 || entry.plusTolerance > 0));
  const parameterEntries: Array<{
    parameter: ToleranceParameterSpec;
    nominalValue: number;
    minusDelta: number;
    plusDelta: number;
  }> = [];
  for (const parameter of parameters) {
    const nominalValue = getToleranceVariableValue(context.systemConfig, parameter.configId, parameter.variableRef);
    if (nominalValue === null) continue;
    const fraction = clamp(context.study.runSettings.sensitivityStepFraction, 0.001, 1);
    const fallbackTolerance = Math.max(parameter.minusTolerance, parameter.plusTolerance);
    const minusDelta = Math.max(Number.EPSILON, (parameter.minusTolerance || fallbackTolerance) * fraction);
    const plusDelta = Math.max(Number.EPSILON, (parameter.plusTolerance || fallbackTolerance) * fraction);
    parameterEntries.push({ parameter, nominalValue, minusDelta, plusDelta });
  }
  const nominal = (await evaluateCandidatesWithCompensation(context, [clone(context.systemConfig)], rows, execution))[0].evaluation;
  const evaluatedByParameter = new Map<string, { minus: CandidateEvaluation; plus: CandidateEvaluation }>();
  const results: SensitivityParameterResult[] = [];
  const invalidEvaluation = { valid: false, requirements: [], score: Infinity, passed: false } as CandidateEvaluation;
  const configuredBatchSize = Number(context.candidateBatchSize);
  const pairBatchSize = Number.isFinite(configuredBatchSize) && configuredBatchSize > 0
    ? Math.max(1, Math.floor(clamp(Math.round(configuredBatchSize), 2, 128) / 2))
    : Math.max(1, parameterEntries.length);
  for (let start = 0; start < parameterEntries.length; start += pairBatchSize) {
    const candidates: any[] = [];
    const references: Array<{ parameterId: string; side: 'minus' | 'plus' }> = [];
    for (const entry of parameterEntries.slice(start, start + pairBatchSize)) {
      const minusCandidate = clone(context.systemConfig);
      const plusCandidate = clone(context.systemConfig);
      if (setToleranceVariableValue(minusCandidate, entry.parameter.configId, entry.parameter.variableRef, entry.nominalValue - entry.minusDelta)) {
        candidates.push(minusCandidate);
        references.push({ parameterId: entry.parameter.id, side: 'minus' });
      }
      if (setToleranceVariableValue(plusCandidate, entry.parameter.configId, entry.parameter.variableRef, entry.nominalValue + entry.plusDelta)) {
        candidates.push(plusCandidate);
        references.push({ parameterId: entry.parameter.id, side: 'plus' });
      }
    }
    const evaluated = await evaluateCandidatesWithCompensation(context, candidates, rows, execution);
    evaluated.forEach((entry, index) => {
      const reference = references[index];
      const current = evaluatedByParameter.get(reference.parameterId) ?? { minus: invalidEvaluation, plus: invalidEvaluation };
      current[reference.side] = entry.evaluation;
      evaluatedByParameter.set(reference.parameterId, current);
    });
  }
  for (let index = 0; index < parameterEntries.length; index += 1) {
    abortIfRequested(context.signal);
    const { parameter, minusDelta, plusDelta } = parameterEntries[index];
    const evaluated = evaluatedByParameter.get(parameter.id);
    const minus = evaluated?.minus ?? invalidEvaluation;
    const plus = evaluated?.plus ?? invalidEvaluation;
    const impacts: SensitivityRequirementImpact[] = nominal.requirements.map((nominalRequirement) => {
      const minusRequirement = minus.requirements.find((entry) => entry.id === nominalRequirement.id);
      const plusRequirement = plus.requirements.find((entry) => entry.id === nominalRequirement.id);
      const n = nominalRequirement.current;
      const m = minusRequirement?.current ?? null;
      const p = plusRequirement?.current ?? null;
      const derivative = n !== null && m !== null && p !== null ? (p - m) / (plusDelta + minusDelta) : null;
      const change = n !== null ? Math.max(m === null ? Infinity : Math.abs(m - n), p === null ? Infinity : Math.abs(p - n)) : Infinity;
      const scale = Math.max(Math.abs(nominalRequirement.margin), Math.abs(nominalRequirement.target) * 1e-6, 1e-12);
      return {
        requirementId: nominalRequirement.id,
        nominal: n,
        minus: m,
        plus: p,
        derivativePerUnit: derivative,
        normalizedImpact: Number.isFinite(change) ? change / scale : Number.POSITIVE_INFINITY,
      };
    });
    const minusChange = Math.abs(minus.score - nominal.score);
    const plusChange = Math.abs(plus.score - nominal.score);
    const asymmetryScale = Math.max(minusChange, plusChange, 1e-12);
    results.push({
      parameterId: parameter.id,
      variableRef: parameter.variableRef,
      label: parameter.label || parameter.variableRef,
      minusDelta,
      plusDelta,
      impact: impacts.reduce((maximum, entry) => Math.max(maximum, entry.normalizedImpact), 0),
      nonlinearAsymmetry: Math.abs(plusChange - minusChange) / asymmetryScale,
      requirements: impacts,
      minusValid: minus.valid,
      plusValid: plus.valid,
    });
    publishProgress(context, 'sensitivity', index + 1, parameterEntries.length, `Sensitivity ${index + 1}/${parameterEntries.length}`);
  }
  results.sort((a, b) => b.impact - a.impact);
  publishProgress(context, 'done', 1, 1, 'Sensitivity complete');
  return { method: 'sensitivity', nominal, parameters: results, startedAt, elapsedMs: performance.now() - started, execution: summarizeExecution(execution) };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(random: () => number): number {
  const u1 = Math.max(Number.EPSILON, random());
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function sampleToleranceDelta(parameter: ToleranceParameterSpec, random: () => number): number {
  const minus = Math.max(0, finite(parameter.minusTolerance, 0));
  const plus = Math.max(0, finite(parameter.plusTolerance, 0));
  if (parameter.distribution === 'uniform') return -minus + (minus + plus) * random();
  const z = standardNormal(random);
  const limit = z < 0 ? minus : plus;
  const sigma = parameter.sigmaMode === 'one-sigma' ? limit : parameter.sigmaMode === 'full-width' ? limit / Math.sqrt(3) : limit / 3;
  return z * sigma;
}

function percentile(sorted: number[], probability: number): number | null {
  if (sorted.length === 0) return null;
  const position = clamp(probability, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(values: number[]): Pick<MonteCarloRequirementSummary, 'mean' | 'standardDeviation' | 'p05' | 'p50' | 'p95'> {
  if (values.length === 0) return { mean: null, standardDeviation: null, p05: null, p50: null, p95: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
  const sorted = [...values].sort((a, b) => a - b);
  return { mean, standardDeviation: Math.sqrt(Math.max(0, variance)), p05: percentile(sorted, 0.05), p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

export function wilsonConfidence95(successes: number, samples: number): { low: number; high: number } {
  if (samples <= 0) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const p = successes / samples;
  const denominator = 1 + z * z / samples;
  const center = (p + z * z / (2 * samples)) / denominator;
  const half = z * Math.sqrt((p * (1 - p) + z * z / (4 * samples)) / samples) / denominator;
  return { low: clamp(center - half, 0, 1), high: clamp(center + half, 0, 1) };
}

export async function runMonteCarloTolerance(context: ToleranceRunContext): Promise<MonteCarloToleranceResult> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const execution = createExecutionState();
  const rows = selectedRequirements(context);
  const parameters = context.study.parameters.filter((entry) => entry.enabled && entry.variableRef && (entry.minusTolerance > 0 || entry.plusTolerance > 0));
  const trialsRequested = clamp(Math.round(context.study.runSettings.trials), 1, 100000);
  const random = mulberry32(context.study.runSettings.seed);
  publishProgress(context, 'nominal', 0, 1, 'Evaluating nominal design');
  const nominal = (await evaluateCandidatesWithCompensation(context, [clone(context.systemConfig)], rows, execution))[0].evaluation;
  const trials: MonteCarloTrialResult[] = [];
  let worstTrial: MonteCarloTrialResult | null = null;
  const batchSize = clamp(Math.round(finite(context.candidateBatchSize, 24)), 1, 128);
  for (let chunkStart = 0; chunkStart < trialsRequested; chunkStart += batchSize) {
    abortIfRequested(context.signal);
    const chunkEnd = Math.min(trialsRequested, chunkStart + batchSize);
    const pending: Array<{ index: number; candidate: any | null; appliedDeltas: Record<string, number> }> = [];
    const validCandidates: any[] = [];
    const validPendingIndexes: number[] = [];
    for (let index = chunkStart; index < chunkEnd; index += 1) {
      const candidate = clone(context.systemConfig);
      const appliedDeltas: Record<string, number> = {};
      let applicationValid = true;
      for (const parameter of parameters) {
        const nominalValue = getToleranceVariableValue(context.systemConfig, parameter.configId, parameter.variableRef);
        if (nominalValue === null) {
          applicationValid = false;
          break;
        }
        const delta = sampleToleranceDelta(parameter, random);
        appliedDeltas[parameter.id] = delta;
        if (!setToleranceVariableValue(candidate, parameter.configId, parameter.variableRef, nominalValue + delta)) {
          applicationValid = false;
          break;
        }
      }
      pending.push({ index, candidate: applicationValid ? candidate : null, appliedDeltas });
      if (applicationValid) {
        validPendingIndexes.push(pending.length - 1);
        validCandidates.push(candidate);
      }
    }
    const evaluated = await evaluateCandidatesWithCompensation(context, validCandidates, rows, execution);
    const evaluationByPending = new Map<number, CandidateEvaluation>();
    validPendingIndexes.forEach((pendingIndex, localIndex) => evaluationByPending.set(pendingIndex, evaluated[localIndex].evaluation));
    for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex += 1) {
      const entry = pending[pendingIndex];
      const evaluation = evaluationByPending.get(pendingIndex) ?? {
        valid: false,
        passed: false,
        score: Number.POSITIVE_INFINITY,
        requirements: [],
        reason: 'A tolerance variable could not be applied.',
      } as CandidateEvaluation;
      const trial: MonteCarloTrialResult = {
        index: entry.index + 1,
        valid: evaluation.valid,
        passed: evaluation.passed,
        score: evaluation.score,
        requirementValues: Object.fromEntries(evaluation.requirements.map((requirement) => [requirement.id, requirement.current])),
        appliedDeltas: entry.appliedDeltas,
      };
      trials.push(trial);
      if (!worstTrial || (!trial.valid && worstTrial.valid) || trial.score > worstTrial.score) worstTrial = trial;
    }
    publishProgress(context, 'monte-carlo', chunkEnd, trialsRequested, `Trials ${chunkEnd}/${trialsRequested}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const validTrials = trials.filter((trial) => trial.valid).length;
  const passedTrials = trials.filter((trial) => trial.valid && trial.passed).length;
  const summaries: MonteCarloRequirementSummary[] = nominal.requirements.map((requirement) => {
    const values = trials.map((trial) => trial.requirementValues[requirement.id]).filter((value): value is number => Number.isFinite(value));
    const passed = values.filter((value) => computeRequirementViolation(requirement.operator, value, requirement.target, requirement.tolerance) <= 0).length;
    return {
      requirementId: requirement.id,
      samples: trials.length,
      validSamples: values.length,
      passedSamples: passed,
      yield: values.length > 0 ? passed / values.length : 0,
      ...summarize(values),
    };
  });
  publishProgress(context, 'done', 1, 1, 'Tolerance analysis complete');
  return {
    method: 'monte-carlo',
    nominal,
    seed: context.study.runSettings.seed,
    trialsRequested,
    trialsCompleted: trials.length,
    validTrials,
    passedTrials,
    yield: validTrials > 0 ? passedTrials / validTrials : 0,
    yieldConfidence95: wilsonConfidence95(passedTrials, validTrials),
    requirements: summaries,
    worstTrial,
    trials,
    startedAt,
    elapsedMs: performance.now() - started,
    execution: summarizeExecution(execution),
  };
}

export function resultSummary(result: SensitivityAnalysisResult | MonteCarloToleranceResult): ToleranceResultSummary {
  return {
    method: result.method,
    completedAt: new Date().toISOString(),
    elapsedMs: result.elapsedMs,
    yield: result.method === 'monte-carlo' ? result.yield : undefined,
    trialCount: result.method === 'monte-carlo' ? result.trialsCompleted : undefined,
    parameterCount: result.method === 'sensitivity' ? result.parameters.length : Object.keys(result.worstTrial?.appliedDeltas || {}).length,
    requirementCount: result.nominal.requirements.length,
  };
}
