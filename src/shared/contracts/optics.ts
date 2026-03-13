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
  missRays?: number;
  statusCounts?: Record<string, number>;
  apertureBlockRays?: number;
  noIntersectionRays?: number;
  tirRays?: number;
  unknownFailRays?: number;
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
  pupilU?: number;
  pupilV?: number;
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

export interface NativeTransverseAberrationRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  surfaceIndex?: number;
  rayCount?: number;
  ringCount?: number;
  pattern?: "annular" | "grid" | "cross";
  wavelengthMode?: "all" | "primary";
  wavelength?: number;
}

export interface NativeTransverseAberrationPoint {
  pupilCoordinate: number;
  transverseAberration: number;
  isFullSuccess?: boolean;
  isPartial?: boolean;
}

export interface NativeTransverseAberrationSeries {
  fieldSetting: { displayName: string; y: number; position: string };
  points: NativeTransverseAberrationPoint[];
  hasOffset?: boolean;
  offsetMethod?: string | null;
  zeroAberrationPosition?: number | null;
}

export interface NativeTransverseAberrationResponse {
  backend: string;
  wavelength: number;
  targetSurface: number;
  stopSurface: number;
  stopRadius: number;
  pupilRadius: number;
  isFiniteSystem: boolean;
  fieldSettings: Array<{ displayName: string; y: number; position: string }>;
  meridionalData: NativeTransverseAberrationSeries[];
  sagittalData: NativeTransverseAberrationSeries[];
  metadata: Record<string, number | string | boolean>;
  message: string;
}

export interface NativeOpdMapRequest {
  jobId?: string;
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  objectIndex?: number;
  surfaceIndex?: number;
  gridSize?: number;
  wavelengthUm?: number;
  pupilRadiusMm?: number;
  pupilSamplingMode?: "stop" | "entrance";
  opdDisplayMode?: "raw" | "pistonTiltRemoved" | "pistonTiltDefocusRemoved";
}

export interface NativeOpdMapResponse {
  backend: string;
  chiefReferenceMode?: string;
  targetSurface: number;
  stopSurface: number;
  requestedObjectIndex?: number;
  usedObjectIndex: number;
  usedObjectPosition: string;
  usedObjectX: number;
  usedObjectY: number;
  wavelengthUm: number;
  gridSize: number;
  sampleCount: number;
  hitCount: number;
  pupilSamplingMode: "stop" | "entrance";
  rawOpdGrid: Array<Array<number | null>>;
  displayOpdGrid: Array<Array<number | null>>;
  message: string;
}

export interface NativePsfMapRequest {
  jobId?: string;
  gridOpd: number[][];
  pupilMask: boolean[][];
  gridAmplitude?: number[][];
  wavelengthUm: number;
  pixelSizeUm?: number;
  removeTilt?: boolean;
  zeroPadTo?: number;
  recenterIfWrapped?: boolean;
}

export interface NativePsfFwhm {
  x: number;
  y: number;
  average: number;
}

export interface NativePsfEncircledEnergyPoint {
  radius: number;
  energy: number;
}

export interface NativePsfMetrics {
  totalEnergy: number;
  peakIntensity: number;
  strehlRatio: number;
  fwhm: NativePsfFwhm;
  encircledEnergy: NativePsfEncircledEnergyPoint[];
  centerPosition: { x: number; y: number };
}

export interface NativePsfMapResponse {
  backend: string;
  gridSize: number;
  fftSize: number;
  psfData: number[][];
  metrics: NativePsfMetrics;
  message: string;
}

export interface NativeMtfMapRequest {
  jobId?: string;
  psfData: number[][];
  pixelSizeUm: number;
  maxFrequencyLpmm?: number;
  points?: number;
}

export interface NativeMtfMapResponse {
  backend: string;
  frequencyAxis: number[];
  mtfTangential: number[];
  mtfSagittal: number[];
  nyquistLpmm: number;
  message: string;
}

export interface NativeThroughFocusMtfSeries {
  wavelengthUm: number;
  label: string;
  mtfTangential: number[];
  mtfSagittal: number[];
}

export interface NativeThroughFocusMtfMapRequest {
  jobId?: string;
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  objectIndex?: number;
  pupilSamplingMode?: "stop" | "entrance";
  wavelengths?: number[];
  targetFrequencyLpmm?: number;
  defocusMinMm?: number;
  defocusMaxMm?: number;
  steps?: number;
  samplingSize?: number;
  zeroPadTo?: number;
  pixelSizeUm?: number;
  opdDisplayMode?: string;
}

export interface NativeThroughFocusMtfMapResponse {
  backend: string;
  xAxis: number[];
  series: NativeThroughFocusMtfSeries[];
  message: string;
}

export interface NativeFieldMtfSeries {
  wavelengthUm: number;
  label: string;
  meridionalFirst: number[];
  sagittalFirst: number[];
  meridionalSecond: number[];
  sagittalSecond: number[];
  fieldDiagnostics?: NativeFieldMtfPointDiagnostic[];
}

export interface NativeFieldMtfPointDiagnostic {
  fieldValue: number;
  effectivePupilSamplingMode: string;
  usedObjectPosition?: string;
  targetSurfaceIndex: number;
  usedObjectIndex: number;
  opdSampleCount: number;
  opdHitCount: number;
  opdHitRate: number;
  firstFrequencyLpmm: number;
  firstBracketLowLpmm?: number;
  firstBracketHighLpmm?: number;
  firstValueMeridional: number;
  firstValueSagittal: number;
  secondFrequencyLpmm: number;
  secondBracketLowLpmm?: number;
  secondBracketHighLpmm?: number;
  secondValueMeridional: number;
  secondValueSagittal: number;
}

export interface NativeFieldMtfMapRequest {
  jobId?: string;
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  objectIndex?: number;
  pupilSamplingMode?: "stop" | "entrance";
  wavelengths?: number[];
  firstFrequencyLpmm?: number;
  secondFrequencyLpmm?: number;
  fieldMin?: number;
  fieldMax?: number;
  steps?: number;
  samplingSize?: number;
  zeroPadTo?: number;
  pixelSizeUm?: number;
  opdDisplayMode?: string;
  fieldAxisMode?: "angle" | "height";
}

export interface NativeFieldMtfMapResponse {
  backend: string;
  xAxis: number[];
  axisMode: "angle" | "height" | string;
  series: NativeFieldMtfSeries[];
  message: string;
}

export interface NativeDistortionRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  surfaceIndex?: number;
  fieldSamples: number[];
  heightMode?: boolean;
  wavelength?: number;
}

export interface NativeDistortionResponse {
  backend: string;
  fieldValues: number[];
  idealHeights: number[];
  realHeights: Array<number | null>;
  distortion: Array<number | null>;
  distortionPercent: Array<number | null>;
  meta: Record<string, number | string | boolean>;
  message: string;
}

export interface NativeGridDistortionRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  surfaceIndex?: number;
  gridSize?: number;
  wavelength?: number;
}

export interface NativeGridDistortionResponse {
  backend: string;
  idealX: number[];
  idealY: number[];
  realX: Array<number | null>;
  realY: Array<number | null>;
  gridSize: number;
  maxFieldAngle: number;
  meta: Record<string, number | string | boolean>;
  message: string;
}

export interface NativeMagnificationChromaticAberrationRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  surfaceIndex?: number;
  fieldSamples: number[];
  wavelengths?: number[];
  referenceWavelength?: number;
  heightMode?: boolean;
  chiefRayDefinition?: string;
}

export interface NativeMagnificationChromaticAberrationSeries {
  wavelength: number;
  displacements: Array<number | null>;
  imageHeights: Array<number | null>;
}

export interface NativeMagnificationChromaticAberrationResponse {
  backend: string;
  fieldValues: number[];
  heightMode: boolean;
  referenceWavelength: number;
  imageSurfaceIndex: number;
  dataByWavelength: NativeMagnificationChromaticAberrationSeries[];
  meta: Record<string, number | string | boolean>;
  message: string;
}
