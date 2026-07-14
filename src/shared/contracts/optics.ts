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
  rayIndex?: number;
  isChiefRay?: boolean;
  pupilU?: number;
  pupilV?: number;
}

export interface NativeSpotSeries {
  label: string;
  color: string;
  objectIndex?: number;
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
  referenceOpticalSystemRows?: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  surfaceIndex?: number;
  rayCount?: number;
  ringCount?: number;
  pattern?: string;
  wavelengthMode?: string;
  forceRustWasm?: boolean;
  strictChiefOnly?: boolean;
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
  seriesCount?: number;
  objectCount?: number;
  raysPerSeries?: number;
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

export interface NativeChiefRayAngleRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
}

export interface NativeChiefRayAngleResponse {
  backend: string;
  chiefRayAngleDeg: number;
  message: string;
}

export interface NativeParaxialMetrics {
  FL: number;
  EFL: number;
  BFL: number;
  IMD: number;
  OBJD: number;
  TSL: number;
  BEXP: number;
  EXPD: number;
  EXPP: number;
  ENPD: number;
  ENPP: number;
  ENPM: number;
  PMAG: number;
  FNO_OBJ: number;
  FNO_IMG: number;
  FNO_WRK: number;
  NA_OBJ: number;
  NA_IMG: number;
}

export interface NativeParaxialMetricsRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
}

export interface NativeParaxialMetricsResponse {
  backend: string;
  metrics: NativeParaxialMetrics;
  message: string;
}

export interface NativeSeidelSurfaceCoefficient {
  surfaceIndex: number;
  objectLabel: string;
  I: number;
  II: number;
  III: number;
  P: number;
  IV: number;
  V: number;
  LCA: number;
  TCA: number;
}

export interface NativeSeidelTotals {
  I: number;
  II: number;
  III: number;
  P: number;
  IV: number;
  V: number;
  LCA: number;
  TCA: number;
}

export interface NativeSeidelRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  afocal?: boolean;
  referenceWavelengthUm?: number;
}

export interface NativeSeidelResponse {
  backend: string;
  totals: NativeSeidelTotals;
  surfaceCoefficients: NativeSeidelSurfaceCoefficient[];
  stopSurfaceIndex: number;
  wavelengthUm: number;
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
  pointCount?: number;
  rayCount?: number;
  ringCount?: number;
  pattern?: "annular" | "grid" | "cross";
  chiefRayMode?: string;
  wavelengthMode?: "all" | "primary";
  requireRustWasm?: boolean;
  forceWasmInTauri?: boolean;
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
  jobId?: string;
  surfaceIndex?: number;
  rayCount?: number;
  ringCount?: number;
  pattern?: "annular" | "grid" | "cross";
  wavelengthMode?: "all" | "primary";
  wavelength?: number;
  profileTransverse?: boolean;
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

export interface NativeTransverseRmsRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  surfaceIndex?: number;
  rayCount?: number;
  ringCount?: number;
  pattern?: "annular" | "grid" | "cross";
  wavelengthMode?: "all" | "primary";
  wavelength?: number;
  component?: "total" | "meridional" | "sagittal";
}

export interface NativeTransverseRmsResponse {
  backend: string;
  wavelength: number;
  targetSurface: number;
  stopSurface: number;
  rayCount: number;
  component: "total" | "meridional" | "sagittal";
  meridionalCount: number;
  sagittalCount: number;
  rmsUm: number;
  message: string;
}

export type OpdReferenceMode =
  | "reference-sphere"
  | "exit-pupil"
  | "image-plane"
  | "absolute"
  | "absolute2"
  | "afocal-image-space";

export type OpdChiefRayMode =
  | "stop-center"
  | "entrance-pupil-center"
  | "transmitted-pupil-center";

export type OpdPupilNormalizationMode =
  | "fixed-entrance-pupil"
  | "effective-transmitted-pupil";

export type OpdExitPupilReferencePointMode =
  | "chief-ray-intersection"
  | "exit-pupil-center";

export interface OpdReferenceSphereOptions {
  referenceSphereWavelengthMode?: "primary-wavelength" | "per-wavelength";
  opdDisplayMode?: "raw" | "pistonRemoved" | "pistonTiltRemoved" | "pistonDefocusRemoved" | "pistonTiltDefocusRemoved";
  exitPupilPositionSign?: "as-is" | "negated";
  exitPupilPlaneDefinition?: "surface-local-axis" | "global-z";
  chiefImagePoint?:
    | "chief-ray-image-point"
    | "paraxial-image-point"
    | "sagittal-best-focus-point"
    | "tangential-best-focus-point"
    | "tan-sag-mid-focus-point"
    | "rms-wavefront-best-focus-point"
    | "circle-of-least-confusion-point"
    | "defocus-zero-reference-point"
    | "weighted-tan-sag-focus-point"
    | "per-wavelength-best-focus-point"
    | "target-surface-center";
  sphereIntersection?: "exit-pupil-side" | "opposite-side";
  opticalPathSign?: "positive" | "negative";
  exitPupilDirection?: "image-to-exit-pupil" | "exit-pupil-to-image";
}

export interface NativeOpdMapRequest {
  jobId?: string;
  opticalSystemRows: unknown[];
  referenceOpticalSystemRows?: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  objectIndex?: number;
  surfaceIndex?: number;
  gridSize?: number;
  wavelengthUm?: number;
  opdReferenceWavelengthUm?: number;
  opdWaveNormalization?: "reference" | "trace";
  pupilRadiusMm?: number;
  entrancePupilPositionFromFirstSurfaceMm?: number;
  exitPupilPositionFromLastSurfaceMm?: number;
  pupilSamplingMode?: "stop" | "entrance";
  chiefRayMode?: OpdChiefRayMode;
  referenceRayPupilCoordinate?: { x: number; y: number };
  sampleRayLaunchOrigin?: { x: number; y: number; z: number };
  preserveImageHeightChiefRay?: boolean;
  resolveImageHeightChiefRayInRuntime?: boolean;
  pupilNormalizationMode?: OpdPupilNormalizationMode;
  exitPupilReferencePointMode?: OpdExitPupilReferencePointMode;
  referenceSphereOptions?: OpdReferenceSphereOptions;
  referenceMode?: OpdReferenceMode;
  referenceSphereGeometry?: {
    center: { x: number; y: number; z: number };
    radiusMm: number;
    direction: { x: number; y: number; z: number };
  };
  opdDisplayMode?: "raw" | "pistonRemoved" | "pistonTiltRemoved" | "pistonDefocusRemoved" | "pistonTiltDefocusRemoved";
}

export interface NativeOpdMapResponse {
  backend: string;
  chiefReferenceMode?: string;
  chiefRayLaunchOrigin?: { x: number; y: number; z: number };
  imageHeightChiefRayApplied?: boolean;
  imageHeightChiefRayPreserved?: boolean;
  imageHeightChiefRayRuntimeResolved?: boolean;
  imageHeightChiefDirection?: { x: number; y: number; z: number };
  imageHeightRuntimeSolvedAngle?: { x: number; y: number; z: number };
  imageHeightSolverHit?: { x: number; y: number; z: number };
  imageHeightSolverSurfaceIndex?: number;
  chiefStopPoint?: { x: number; y: number; z: number };
  chiefStopDirection?: { x: number; y: number; z: number };
  chiefSurfaceTrace?: Array<{ surfaceIndex: number; point: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } }>;
  sampleRayLaunchOriginApplied?: boolean;
  transmittedPupilCenterUv?: { u: number; v: number };
  targetSurface: number;
  stopSurface: number;
  requestedObjectIndex?: number;
  usedObjectIndex: number;
  usedObjectPosition: string;
  usedObjectX: number;
  usedObjectY: number;
  imageHeightTargetX?: number;
  imageHeightTargetY?: number;
  chiefImageLocalPoint?: { x: number; y: number; z: number };
  wavelengthUm: number;
  referenceSphereWavelengthUsed?: number;
  primaryReferenceGeometryApplied?: boolean;
  currentReferenceSphereRadiusMm?: number;
  primaryReferenceSphereRadiusMm?: number;
  opdReferenceWavelengthUm?: number;
  gridSize: number;
  effectivePupilRadiusMm?: number;
  pupilMaskGrid?: Array<Array<boolean | null>>;
  referenceSphereOpdGrid?: Array<Array<number | null>>;
  chiefOplUm?: number;
  chiefReferenceSphereOpdUm?: number;
  opdTermSamples?: Array<{
    label: string;
    pupilU: number;
    pupilV: number;
    chiefOplUm: number;
    marginalOplUm: number;
    chiefPreTargetOplUm?: number;
    marginalPreTargetOplUm?: number;
    beforeTargetOpdUm?: number;
    targetSegmentOpdUm?: number;
    chiefSphereOplUm?: number;
    marginalSphereOplUm?: number;
    referenceOpdUm?: number;
    spherePathDeltaUm?: number;
  }>;
  entrancePupilCoordinateXGrid?: Array<Array<number | null>>;
  entrancePupilCoordinateYGrid?: Array<Array<number | null>>;
  sampleCount: number;
  hitCount: number;
  referenceCorrectedSampleCount?: number;
  referenceOpdRmsUm?: number;
  trackedOpdRmsUm?: number;
  beforeTargetTrackedOpdRmsUm?: number;
  targetSegmentOpdRmsUm?: number;
  spherePathDeltaRmsUm?: number;
  spherePathOptimalScale?: number;
  spherePathOptimalRmsUm?: number;
  currentReferenceOpdRmsUm?: number;
  alternateSphereIntersection?: "exit-pupil-side" | "opposite-side";
  alternateReferenceOpdRmsUm?: number;
  targetOriginReferenceOpdRmsUm?: number;
  imageSpaceN?: number;
  airReferenceOpdRmsUm?: number;
  alternateOpticalPathSign?: "positive" | "negative";
  alternateSignReferenceOpdRmsUm?: number;
  axisReferenceSphereRmsUm?: number;
  sphereRadiusOptimalScale?: number;
  sphereRadiusOptimalRmsUm?: number;
  pupilSamplingMode: "stop" | "entrance";
  chiefRayMode?: OpdChiefRayMode;
  referenceRayPupilCoordinate?: { x: number; y: number };
  pupilNormalizationMode?: OpdPupilNormalizationMode;
  exitPupilReferencePointMode?: OpdExitPupilReferencePointMode;
  referenceMode?: OpdReferenceMode;
  referenceSphereCenter?: { x: number; y: number; z: number };
  referenceSphereRadiusMm?: number;
  referenceSphereDirection?: { x: number; y: number; z: number };
  chiefImagePoint?: { x: number; y: number; z: number };
  paraxialImagePoint?: { x: number; y: number; z: number };
  sagittalBestFocusPoint?: { x: number; y: number; z: number };
  tangentialBestFocusPoint?: { x: number; y: number; z: number };
  rmsBestFocusPoint?: { x: number; y: number; z: number };
  rmsBestFocusDiagnostics?: {
    baseZ: number;
    searchMinZ: number;
    searchMaxZ: number;
    searchRangeMode: "derived" | "derived-ray-bundle" | "fallback";
    rayCount: number;
    paraxialRmsMm: number;
    bestFocusRmsMm: number;
    improvementMm: number;
    bestFocusDeltaZ: number;
  };
  selectedImagePoint?: { x: number; y: number; z: number };
  selectedImagePointMode?: string;
  exitPupilCenter?: { x: number; y: number; z: number };
  exitPupilRadiusMm?: number;
  displayFit?: {
    sampleCount: number;
    basis: string;
    piston: number;
    tiltX: number;
    tiltY: number;
    defocus: number;
    defocusScale: number;
    defocusMeanRadiusSquared?: number;
    coordinateSource?: "entrance-pupil" | "grid-index-fallback";
    physicalCoordinateSampleCount?: number;
  };
  wavefrontFit?: {
    sampleCount: number;
    basis: string;
    piston: number;
    tiltX: number;
    tiltY: number;
    defocus: number;
    defocusScale: number;
    defocusMeanRadiusSquared?: number;
    coordinateSource?: "entrance-pupil" | "grid-index-fallback";
    physicalCoordinateSampleCount?: number;
  };
  rawOpdGrid: Array<Array<number | null>>;
  unreferencedOpdGrid?: Array<Array<number | null>>;
  displayOpdGrid: Array<Array<number | null>>;
  referenceSphereOpdGrid?: Array<Array<number | null>>;
  message: string;
}

export interface NativeOpdRmsWavesRequest {
  jobId?: string;
  opticalSystemRows: unknown[];
  referenceOpticalSystemRows?: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  objectIndex?: number;
  surfaceIndex?: number;
  gridSize?: number;
  wavelengthUm?: number;
  pupilRadiusMm?: number;
  pupilSamplingMode?: "stop" | "entrance";
  chiefRayMode?: OpdChiefRayMode;
  sampleRayLaunchOrigin?: { x: number; y: number; z: number };
  pupilNormalizationMode?: OpdPupilNormalizationMode;
  exitPupilReferencePointMode?: OpdExitPupilReferencePointMode;
  referenceSphereOptions?: OpdReferenceSphereOptions;
  referenceMode?: OpdReferenceMode;
  referenceSphereGeometry?: {
    center: { x: number; y: number; z: number };
    radiusMm: number;
    direction: { x: number; y: number; z: number };
  };
  opdDisplayMode?: "raw" | "pistonRemoved" | "pistonTiltRemoved" | "pistonDefocusRemoved" | "pistonTiltDefocusRemoved";
}

export interface NativeOpdRmsWavesResponse {
  backend: string;
  chiefReferenceMode?: string;
  chiefRayLaunchOrigin?: { x: number; y: number; z: number };
  sampleRayLaunchOriginApplied?: boolean;
  transmittedPupilCenterUv?: { u: number; v: number };
  targetSurface: number;
  stopSurface: number;
  requestedObjectIndex?: number;
  usedObjectIndex: number;
  usedObjectPosition: string;
  usedObjectX: number;
  usedObjectY: number;
  imageHeightTargetX?: number;
  imageHeightTargetY?: number;
  wavelengthUm: number;
  gridSize: number;
  sampleCount: number;
  hitCount: number;
  pupilMaskGrid?: Array<Array<boolean | null>>;
  unreferencedOpdGrid?: Array<Array<number | null>>;
  opdTermSamples?: NativeOpdMapResponse['opdTermSamples'];
  referenceSphereWavelengthUsed?: number;
  primaryReferenceGeometryApplied?: boolean;
  currentReferenceSphereRadiusMm?: number;
  primaryReferenceSphereRadiusMm?: number;
  referenceCorrectedSampleCount?: number;
  referenceOpdRmsUm?: number;
  trackedOpdRmsUm?: number;
  beforeTargetTrackedOpdRmsUm?: number;
  targetSegmentOpdRmsUm?: number;
  spherePathDeltaRmsUm?: number;
  spherePathOptimalScale?: number;
  spherePathOptimalRmsUm?: number;
  currentReferenceOpdRmsUm?: number;
  alternateSphereIntersection?: "exit-pupil-side" | "opposite-side";
  alternateReferenceOpdRmsUm?: number;
  targetOriginReferenceOpdRmsUm?: number;
  imageSpaceN?: number;
  airReferenceOpdRmsUm?: number;
  alternateOpticalPathSign?: "positive" | "negative";
  alternateSignReferenceOpdRmsUm?: number;
  axisReferenceSphereRmsUm?: number;
  sphereRadiusOptimalScale?: number;
  sphereRadiusOptimalRmsUm?: number;
  pupilSamplingMode: "stop" | "entrance";
  referenceSphereCenter?: { x: number; y: number; z: number };
  referenceSphereRadiusMm?: number;
  referenceSphereDirection?: { x: number; y: number; z: number };
  chiefImagePoint?: { x: number; y: number; z: number };
  paraxialImagePoint?: { x: number; y: number; z: number };
  sagittalBestFocusPoint?: { x: number; y: number; z: number };
  tangentialBestFocusPoint?: { x: number; y: number; z: number };
  rmsBestFocusPoint?: { x: number; y: number; z: number };
  rmsBestFocusDiagnostics?: {
    baseZ: number;
    searchMinZ: number;
    searchMaxZ: number;
    searchRangeMode: "derived" | "derived-ray-bundle" | "fallback";
    rayCount: number;
    paraxialRmsMm: number;
    bestFocusRmsMm: number;
    improvementMm: number;
    bestFocusDeltaZ: number;
  };
  selectedImagePoint?: { x: number; y: number; z: number };
  selectedImagePointMode?: string;
  exitPupilCenter?: { x: number; y: number; z: number };
  referenceMode?: OpdReferenceMode;
  /** RMS of the current display mode, used for individual-cell reporting. */
  displayRmsWaves?: number;
  /** RMS of the unprocessed reference-sphere OPD, used for total reporting. */
  referenceRmsWaves?: number;
  displayFit?: {
    sampleCount: number;
    basis: string;
    piston: number;
    tiltX: number;
    tiltY: number;
    defocus: number;
    defocusScale: number;
    defocusMeanRadiusSquared?: number;
    coordinateSource?: "entrance-pupil" | "grid-index-fallback";
    physicalCoordinateSampleCount?: number;
  };
  referenceSphereCenter?: { x: number; y: number; z: number };
  referenceSphereRadiusMm?: number;
  rmsWaves: number;
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
  pixelSizeUm?: number;
  message: string;
}

export interface NativeMtfMapRequest {
  jobId?: string;
  psfData: number[][];
  pixelSizeUm: number;
  maxFrequencyLpmm?: number;
  points?: number;
  sampleFrequenciesLpmm?: number[];
  directEvalOnly?: boolean;
  method?: "legacy-otf-axis" | "hopkins-tcc" | "malacara-wasm-required";
  rawOpdGrid?: Array<Array<number | null>>;
  displayOpdGrid?: Array<Array<number | null>>;
  amplitudeGrid?: number[][];
  pupilRange?: number;
  wavelengthUm?: number;
  fNumber?: number;
  tangentialDir?: { x: number; y: number };
  sagittalDir?: { x: number; y: number };
}

export interface NativeMtfMapResponse {
  backend: string;
  frequencyAxis: number[];
  mtfTangential: number[];
  mtfSagittal: number[];
  sampledFrequenciesLpmm?: number[];
  sampledMtfTangential?: number[];
  sampledMtfSagittal?: number[];
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
  method?: "legacy-otf-axis" | "hopkins-tcc" | "malacara-wasm-required";
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
  meridionalThird?: number[];
  sagittalThird?: number[];
  fieldDiagnostics?: NativeFieldMtfPointDiagnostic[];
}

export interface NativeFieldMtfPointDiagnostic {
  fieldValue: number;
  effectivePupilSamplingMode: string;
  effectivePupilRadiusMm?: number;
  usedObjectPosition?: string;
  targetSurfaceIndex: number;
  usedObjectIndex: number;
  opdSampleCount: number;
  opdHitCount: number;
  opdHitRate: number;
  opdMessage?: string;
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
  sampleFromObjectRows?: boolean;
  objectIndex?: number;
  pupilSamplingMode?: "stop" | "entrance";
  wavelengths?: number[];
  firstFrequencyLpmm?: number;
  secondFrequencyLpmm?: number;
  thirdFrequencyLpmm?: number;
  fieldMin?: number;
  fieldMax?: number;
  steps?: number;
  samplingSize?: number;
  zeroPadTo?: number;
  pixelSizeUm?: number;
  opdDisplayMode?: string;
  fieldAxisMode?: "angle" | "height";
  method?: "legacy-otf-axis" | "hopkins-tcc" | "malacara-wasm-required";
  adaptiveSampling?: boolean;
  adaptiveThreshold?: number;
  adaptiveInitialSteps?: number;
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
  distortionMetric?: 'chief-ray' | 'spot-gravity';
  wavelength?: number;
  onProgress?: (evt: { percent?: number; message?: string }) => void;
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
  jobId?: string;
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  surfaceIndex?: number;
  gridSize?: number;
  wavelength?: number;
  detailProgress?: boolean;
  onProgress?: (evt: { percent?: number; message?: string }) => void;
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
  imageHeightMode?: boolean;
  rayCount?: number;
  ringCount?: number;
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
  imageHeightMode?: boolean;
  referenceWavelength: number;
  imageSurfaceIndex: number;
  dataByWavelength: NativeMagnificationChromaticAberrationSeries[];
  meta: Record<string, unknown>;
  message: string;
}
