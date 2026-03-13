export type OptimizerMethod = "cd" | "lm" | "kkt";

export interface OptimizeStepRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  activeConfigId?: string | number;
  systemRequirementsRows?: unknown[];
  sessionId?: string;
  resetSession?: boolean;
  maxIterations?: number;
  method?: OptimizerMethod;
  emitProgress?: boolean;
  penaltyParameter?: number;
  penaltyIncreaseFactor?: number;
  lineSearchC?: number;
  lineSearchRho?: number;
  lineSearchMaxBacktrack?: number;
  dryRun?: boolean;
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
  softPenalty?: number;
  requirementCount?: number;
  residualCount?: number;
  rho?: number;
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
}

export interface OptimizerDropSessionRequest {
  sessionId: string;
}
