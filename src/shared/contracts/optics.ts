export interface OpticsEchoRequest {
  jobId: string;
  payload: number[];
}

export interface OpticsEchoResponse {
  jobId: string;
  count: number;
  payloadSum: number;
}

export interface RaytracePreviewRequest {
  lensId: string;
  fieldIndex: number;
  rayCount: number;
}

export interface RaytracePreviewResponse {
  lensId: string;
  fieldIndex: number;
  tracedRays: number;
  rmsSpotUm: number;
}

export interface NativeSpotPoint {
  xUm: number;
  yUm: number;
}

export interface NativeSpotSeries {
  label: string;
  color: string;
  wavelengthUm?: number;
  points: NativeSpotPoint[];
  chiefPointUm?: NativeSpotPoint;
  hasFieldAngle?: boolean;
}

export interface NativeSpotSeriesStats {
  label: string;
  attemptedRays: number;
  hitRays: number;
  hitRatePercent: number;
}

export interface NativeSpotRaytraceRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  surfaceIndex?: number;
  rayCount?: number;
  ringCount?: number;
  pattern?: string;
  wavelengthMode?: string;
  raySeries?: NativeSpotInputSeries[];
}

export interface NativeSpotInputRay {
  startP: { x: number; y: number; z: number };
  dir: { x: number; y: number; z: number };
  wavelengthUm?: number;
  isChief?: boolean;
}

export interface NativeSpotInputSeries {
  label: string;
  color?: string;
  hasFieldAngle?: boolean;
  rays: NativeSpotInputRay[];
}

export interface NativeSpotRaytraceResponse {
  backend: string;
  surfaceIndex: number;
  tracedRays: number;
  requestedRays: number;
  generatedRays: number;
  wavelengthCount: number;
  totalAttemptedRays: number;
  totalHitRays: number;
  maxHitRays: number;
  meanHitRatePercent: number;
  rayGenerationMs?: number;
  traceMs?: number;
  seriesStats: NativeSpotSeriesStats[];
  series: NativeSpotSeries[];
  message: string;
}

export interface NativeSphericalAberrationRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  surfaceIndex?: number;
  rayCount?: number;
  referenceFocusMode?: "primary-paraxial" | "current-paraxial" | "chief-ray";
  wavelengthMode?: "all" | "primary";
}

export interface NativeSphericalAberrationPoint {
  pupilCoordinate: number;
  longitudinalAberration: number;
  focusPosition: number;
  stopHeight: number;
  transverseAberration: number;
  sineConditionViolation: null;
}

export interface NativeSphericalAberrationSeries {
  wavelength: number;
  rayType: "meridional" | "sagittal";
  points: NativeSphericalAberrationPoint[];
  paraxialAberration: number | null;
}

export interface NativeSphericalAberrationResponse {
  backend: string;
  meridionalData: NativeSphericalAberrationSeries[];
  sagittalData: NativeSphericalAberrationSeries[];
  message: string;
  summary: Record<string, number | string | boolean>;
}

export interface NativeAstigmatismDebugRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  targetSurfaceIndex?: number;
  rayCount?: number;
  ringCount?: number;
  pattern?: "annular" | "grid" | "cross";
  chiefRayMode?: string;
  requireRust?: boolean;
}

export interface NativeAstigmatismDebugResponse {
  ok: boolean;
  message: string;
  opticalCount: number;
  sourceCount: number;
  objectCount: number;
}

export interface NativeAstigmatismRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  surfaceIndex?: number;
  rayCount?: number;
  ringCount?: number;
  pattern?: "annular" | "grid" | "cross";
  chiefRayMode?: string;
  wavelengthMode?: "all" | "primary";
}

export interface NativeAstigmatismFieldData {
  wavelength: number;
  fieldAngle: number;
  fieldName: string;
  paraxialImageZ: number | null;
  meridionalDeviation: number | null;
  sagittalDeviation: number | null;
  astigmaticDifference: number | null;
}

export interface NativeAstigmatismResponse {
  backend: string;
  targetSurface: number;
  stopSurface: number;
  primaryWavelength: number;
  primaryReferenceZ: number | null;
  fieldMode: "angle" | "height";
  isAngleField: boolean;
  fieldSettings: Array<{ displayName: string; y: number; position: string }>;
  wavelengths: number[];
  data: NativeAstigmatismFieldData[];
  message: string;
}
