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
