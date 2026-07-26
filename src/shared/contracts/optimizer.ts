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
