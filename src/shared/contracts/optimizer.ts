export interface OptimizeStepRequest {
  opticalSystemRows: unknown[];
  maxIterations?: number;
}

export interface OptimizeStepResponse {
  iterations: number;
  variableCount: number;
  meritBefore: number;
  meritAfter: number;
  converged: boolean;
  message: string;
}
