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

export type AnalysisKind = "opd" | "psf" | "mtf";

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
}

export interface RunAnalysisComputeResponse {
  kind: AnalysisKind;
  gridSize: number;
  opdGrid?: number[][];
  psfGrid?: number[][];
  frequencyAxis?: number[];
  mtfTangential?: number[];
  mtfSagittal?: number[];
  message: string;
  summary: Record<string, number | string | boolean>;
}
