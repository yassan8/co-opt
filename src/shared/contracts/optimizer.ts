export type OptimizerMethod = "cd" | "lm" | "kkt" | "kkt-sqp" | "global-al" | "global-lm";

export interface OptimizeStepRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  activeConfigId?: string | number;
  systemConfigSnapshot?: unknown;
  systemRequirementsRows?: unknown[];
  sessionId?: string;
  resetSession?: boolean;
  maxIterations?: number;
  method?: OptimizerMethod;
  emitProgress?: boolean;
  profile?: boolean;
  penaltyParameter?: number;
  penaltyIncreaseFactor?: number;
  lineSearchC?: number;
  lineSearchRho?: number;
  lineSearchMaxBacktrack?: number;
  dryRun?: boolean;
}

export interface OptimizeOperandProfileEntry {
  key: string;
  operand: string;
  count: number;
  cacheHits: number;
  cacheMisses: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
}

export interface OptimizeProfileReport {
  evaluateStateCalls: number;
  requirementPasses: number;
  operandEntries: OptimizeOperandProfileEntry[];
}

export interface OptimizeProgressEvent {
  phase: string;
  iter: number;
  current: number;
  best: number;
  accepted: boolean;
  rows?: unknown[];
  message?: string;
  variableId?: string;
  method?: OptimizerMethod | string;
  violationScore?: number;
  equalViolation?: number;
  inequalViolation?: number;
  dampingFactor?: number;
  softPenalty?: number;
  requirementCount?: number;
  residualCount?: number;
  rho?: number;
  alpha?: number;
  feasible?: boolean;
}

export interface OptimizeStepResponse {
  iterations: number;
  variableCount: number;
  meritBefore: number;
  meritAfter: number;
  converged: boolean;
  modeUsed: string;
  requirementScoreBefore: number;
  requirementScoreAfter: number;
  optimizedRows: unknown[];
  progressEvents: OptimizeProgressEvent[];
  message: string;
  profile?: OptimizeProfileReport | null;
}

export interface OptimizerDropSessionRequest {
  sessionId: string;
}

export interface OptimizerCandidateCellUpdate {
  configId: string;
  rowIndex: number;
  fieldKey: string;
  remove?: boolean;
  value: unknown;
}

export interface OptimizerCandidateVariableBinding {
  variableIndex: number;
  configId: string;
  rowIndex: number;
  fieldKey: string;
  inputBaseline: number;
  outputBaseline: number;
  slope: number;
}

export interface EvaluateOptimizerCandidatesRequest {
  candidates?: Array<Record<string, unknown[]>>;
  candidateDeltas?: OptimizerCandidateCellUpdate[][];
  candidateVectors?: number[][];
  variableBindings?: OptimizerCandidateVariableBinding[];
  sessionId?: string;
  resetSession?: boolean;
  baseRowsByConfig?: Record<string, unknown[]>;
  sourceRows?: unknown[];
  objectRows?: unknown[];
  systemRequirementsRows?: unknown[];
  activeConfigId?: string | number;
}

export interface EvaluateOptimizerCandidatesResponse {
  currentsPerCandidate: Array<Array<number | null>>;
  candidateCount: number;
  requirementCount: number;
  sessionReused: boolean;
  appliedUpdateCount: number;
  elapsedMs: number;
}
