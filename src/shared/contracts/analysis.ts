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

export type AnalysisKind = "opd" | "psf" | "mtf" | "through-focus-mtf" | "field-mtf" | "through-focus-spot" | "spot-diagram" | "spherical-aberration";

export interface SpotPoint {
  xUm: number;
  yUm: number;
}

export interface SpotSeries {
  defocusMm: number;
  wavelengthLabel: string;
  color: string;
  points: SpotPoint[];
}

export interface SpotDiagramSeries {
  label: string;
  color: string;
  points: SpotPoint[];
}

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
  jobId?: string;
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
  surfaceIndex?: number;
  rayCount?: number;
  ringCount?: number;
  scaleUm?: number;
  wavelengthMode?: "all" | "primary";
  pattern?: "annular" | "grid";
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
  spotSeries?: SpotSeries[];
  spotDiagramSeries?: SpotDiagramSeries[];
  message: string;
  summary: Record<string, number | string | boolean>;
}

export type SystemDataReportKind = "paraxial" | "seidel" | "seidel-afocal";

export interface RunSystemDataReportRequest {
  kind: SystemDataReportKind;
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  referenceFocalLength?: number;
}

export interface RunSystemDataReportResponse {
  kind: SystemDataReportKind;
  text: string;
  summary: Record<string, number | string | boolean>;
}
