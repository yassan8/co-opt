export type WavefrontPurpose = "realtime-preview" | "interactive" | "high-quality" | "export";

export interface GridRecommendation {
  gridSize: number;
  estimatedTimeMs: number;
  quality: "preview" | "interactive" | "high" | "final";
  pointCount: number;
}

export interface RecommendWavefrontGridRequest {
  purpose: WavefrontPurpose;
  fieldAngleDeg?: number;
}

export interface RecommendWavefrontGridForTimeRequest {
  targetTimeMs: number;
  fieldAngleDeg?: number;
}

export type AnalysisKind = "opd" | "psf" | "mtf" | "through-focus-mtf" | "field-mtf";

export interface RunAnalysisPreviewRequest {
  kind: AnalysisKind;
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
}

export interface RunAnalysisPreviewResponse {
  kind: AnalysisKind;
  sampleCount: number;
  score: number;
  message: string;
  summary: Record<string, number | string | boolean>;
}

export interface RunAnalysisComputeRequest {
  kind: AnalysisKind;
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  gridSize?: number;
  maxFrequencyLpmm?: number;
  targetFrequencyLpmm?: number;
  defocusMinMm?: number;
  defocusMaxMm?: number;
  fieldMin?: number;
  fieldMax?: number;
  steps?: number;
  firstFrequencyLpmm?: number;
  secondFrequencyLpmm?: number;
  fieldAxisMode?: "angle" | "height";
}

export interface RunAnalysisComputeResponse {
  kind: AnalysisKind;
  gridSize: number;
  opdGrid?: number[][];
  psfGrid?: number[][];
  frequencyAxis?: number[];
  xAxis?: number[];
  mtfTangential?: number[];
  mtfSagittal?: number[];
  mtfFirstTangential?: number[];
  mtfFirstSagittal?: number[];
  mtfSecondTangential?: number[];
  mtfSecondSagittal?: number[];
  message: string;
  summary: Record<string, number | string | boolean>;
}
