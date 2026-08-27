import type { Configuration } from '../data/table-configuration.ts';
import { buildHybridAssemblyFromConfiguration } from './hybrid-design.ts';
import { assemblyRoutingMode, compileAutomaticAssemblyRouting } from './automatic-assembly-routing.ts';
import { normalizePortRouteConfiguration } from './port-routes.ts';
import { traceSequentialGroupBatch, type SequentialGroupRayState } from './exact-sequential-group.ts';
import {
  resolveComponentTransform,
  sampleTargetHeightUm,
  type CoherentPhysicalComponent,
  type TargetProfileSpec,
  type Vec3Mm,
} from './coherent-assembly.ts';
import { worldPortDirection, worldPortPosition } from './coherent-port-layout.ts';
import type { CoherentDetectorFieldSample } from './detector-signal.ts';

const TWO_PI = Math.PI * 2;
const COOPERATIVE_RAY_CHUNK = 8192;
const cooperativeYieldQueue: Array<() => void> = [];
let cooperativeYieldChannel: MessageChannel | null = null;

function yieldToHost(): Promise<void> {
  const immediate = (globalThis as any).setImmediate;
  if (typeof immediate === 'function') return new Promise((resolve) => immediate(resolve));
  if (typeof MessageChannel !== 'undefined') {
    cooperativeYieldChannel ??= (() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => cooperativeYieldQueue.shift()?.();
      return channel;
    })();
    return new Promise((resolve) => {
      cooperativeYieldQueue.push(resolve);
      cooperativeYieldChannel!.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface PortRoutedTraceOptions {
  routeSetId?: string;
  routeIds?: string[];
  /** Selects the per-Source ray count when spatialSamples is not overridden. */
  samplePurpose?: 'render' | 'detector' | 'analysis';
  spatialSamples?: number;
  spectralSamples?: number;
  /** Selected Object/Field row. Angle rows steer the physical source beam. */
  fieldObjectRow?: Record<string, unknown>;
  /** Zero-based source wavelength/comb-line index. Omit to trace all requested samples. */
  spectralLineIndex?: number;
  renderRayLimit?: number;
  mtfFrequencyLpMm?: number;
  mtfOrientation?: 'tangential' | 'sagittal' | 'average';
  /** Keep hit-wise complex samples but omit dense Detector image buffers. */
  spectralFieldsOnly?: boolean;
  /** Omit dense real/imaginary images when only intensity and hit fields are consumed. */
  denseComplexFields?: boolean;
  onProgress?: (progress: PortRoutedTraceProgress) => void;
}

export interface PortRoutedTraceProgress {
  percent: number;
  message: string;
  routeId?: string;
  routeLabel?: string;
}

export interface PortRoutedSegment {
  routeId: string;
  rayId: number;
  sequence: number;
  fromMm: Vec3Mm;
  toMm: Vec3Mm;
  kind: 'free-space' | 'exact-sequential' | 'component';
  direction: 'forward' | 'reverse';
  wavelengthNm: number;
  powerW: number;
}

export interface PortRouteMetrics {
  routeId: string;
  routeLabel: string;
  detectorId: string;
  valid: boolean;
  reachedRays: number;
  launchedRays: number;
  oplMm: number;
  centroidXmm: number;
  centroidYmm: number;
  spotRmsMm: number;
  /** Piston and source-pupil tilt removed, power-weighted RMS wavefront error. */
  wavefrontRmsUm: number;
  /** Maréchal estimate, averaged incoherently across sampled wavelengths. */
  strehl: number;
  /** Ray-distribution MTF at options.mtfFrequencyLpMm. */
  mtf: number;
  receivedPowerW: number;
  failureReason?: string;
}

export interface PortRoutedDetectorResult {
  detectorId: string;
  width: number;
  height: number;
  pixelPitchUm: number;
  intensityW: Float64Array;
  coherentReal: Float64Array;
  coherentImag: Float64Array;
  /** Complex Detector-plane samples before the exact-lens coherent PSF. */
  spectralFields: Array<CoherentDetectorFieldSample & { routeId: string }>;
  spectralModeCount: number;
  coherentModeCount: number;
  totalPowerW: number;
  hitCount: number;
  routeIds: string[];
  timeSeconds?: Float64Array;
  timeSignalW?: Float64Array;
  rfBeats?: Array<{ lineIndex: number; frequencyHz: number; powerW: number }>;
}

export interface PortRoutedTraceResult {
  revision: number;
  routeMetrics: PortRouteMetrics[];
  detectors: PortRoutedDetectorResult[];
  segments: PortRoutedSegment[];
  warnings: string[];
  energy: { launchedPowerW: number; detectedPowerW: number; lostPowerW: number };
}

interface RoutedRay extends SequentialGroupRayState {
  id: number;
  powerW: number;
  phaseRad: number;
  pupilXmm: number;
  pupilYmm: number;
  frequencyHz: number;
  sourceId: string;
  lineIndex: number;
  targetXmm?: number;
  /** Equivalent grating/relay OPL gradient evaluated on Detector local Y. */
  detectorDelaySlopeMmPerMm?: number;
}

interface SpectrumSample { wavelengthNm: number; powerFraction: number; frequencyHz: number; lineIndex: number }
interface SparseComplexPixel { real: number; imag: number }
interface CoherentDetectorMode {
  /** Only pixels reached by this spectral mode are stored. */
  pixels: Map<number, SparseComplexPixel>;
  frequencyHz: number;
  coherenceGroupId: string;
  routeIds: Set<string>;
}

const finite = (value: unknown, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

function add(a: Vec3Mm, b: Vec3Mm): Vec3Mm { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function subtract(a: Vec3Mm, b: Vec3Mm): Vec3Mm { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function scale(a: Vec3Mm, factor: number): Vec3Mm { return { x: a.x * factor, y: a.y * factor, z: a.z * factor }; }
function dot(a: Vec3Mm, b: Vec3Mm): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function normalize(a: Vec3Mm): Vec3Mm { const length = Math.hypot(a.x, a.y, a.z) || 1; return scale(a, 1 / length); }
function cross(a: Vec3Mm, b: Vec3Mm): Vec3Mm { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
function distance(a: Vec3Mm, b: Vec3Mm): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

function componentAxes(component: CoherentPhysicalComponent): { x: Vec3Mm; y: Vec3Mm; z: Vec3Mm } {
  const rotation = resolveComponentTransform(component).rotationDeg;
  const rx = rotation.x * Math.PI / 180; const ry = rotation.y * Math.PI / 180; const rz = rotation.z * Math.PI / 180;
  const cx = Math.cos(rx); const sx = Math.sin(rx); const cy = Math.cos(ry); const sy = Math.sin(ry); const cz = Math.cos(rz); const sz = Math.sin(rz);
  const matrix = [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
  return {
    x: { x: matrix[0][0], y: matrix[1][0], z: matrix[2][0] },
    y: { x: matrix[0][1], y: matrix[1][1], z: matrix[2][1] },
    z: { x: matrix[0][2], y: matrix[1][2], z: matrix[2][2] },
  };
}

function spectrumForSource(source: any, requestedSamples?: number): SpectrumSample[] {
  const configuredSamples = source.kind === 'frequency-comb'
    ? source.lineCount ?? source.spectralSamples
    : source.spectralSamples ?? source.lineCount;
  const count = Math.max(1, Math.min(129, Math.round(finite(requestedSamples, configuredSamples ?? 1))));
  if (source.kind === 'frequency-comb') {
    const c = 299_792_458;
    const centerFrequency = c / (Math.max(1, finite(source.centerWavelengthNm, 1550)) * 1e-9);
    const repetition = Math.max(1, finite(source.repetitionRateHz, 100e6));
    const ceo = finite(source.ceoFrequencyHz, 0);
    const centerMode = Math.round((centerFrequency - ceo) / repetition);
    const half = Math.floor(count / 2);
    const lines: SpectrumSample[] = [];
    for (let index = -half; index <= half && lines.length < count; index += 1) {
      const frequencyHz = ceo + (centerMode + index) * repetition;
      lines.push({ wavelengthNm: c / frequencyHz * 1e9, frequencyHz, powerFraction: 1 / count, lineIndex: lines.length });
    }
    return lines;
  }
  const min = finite(source.minWavelengthNm, finite(source.centerWavelengthNm, 587.5618));
  const max = finite(source.maxWavelengthNm, finite(source.centerWavelengthNm, 587.5618));
  const center = finite(source.centerWavelengthNm, (min + max) / 2);
  const fwhm = Math.max(1e-9, finite(source.bandwidthFwhmNm, max - min || 1));
  const raw = Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 0.5 : index / (count - 1);
    const wavelengthNm = min + (max - min) * t;
    const weight = Math.exp(-4 * Math.log(2) * Math.pow((wavelengthNm - center) / fwhm, 2));
    return { wavelengthNm, frequencyHz: 299_792_458 / (wavelengthNm * 1e-9), powerFraction: weight, lineIndex: index };
  });
  const sum = raw.reduce((total, sample) => total + sample.powerFraction, 0) || 1;
  return raw.map((sample) => ({ ...sample, powerFraction: sample.powerFraction / sum }));
}

function launchRays(component: CoherentPhysicalComponent, source: any, options: PortRoutedTraceOptions): RoutedRay[] {
  const requestedLine = Number(options.spectralLineIndex);
  const hasRequestedLine = Number.isInteger(requestedLine) && requestedLine >= 0;
  const spectrum = spectrumForSource(source, hasRequestedLine
    ? Math.max(1, finite(source.lineCount ?? source.spectralSamples, 1))
    : options.spectralSamples);
  const samples = hasRequestedLine && requestedLine < spectrum.length ? [spectrum[requestedLine]] : spectrum;
  const purposeSamples = options.samplePurpose === 'render'
    ? source.renderSpatialSamples
    : options.samplePurpose === 'detector'
      ? source.detectorSpatialSamples
      : undefined;
  const spatialCount = Math.max(1, Math.min(4096, Math.round(finite(
    options.spatialSamples,
    purposeSamples ?? source.spatialSamples ?? 25,
  ))));
  const side = Math.max(1, Math.ceil(Math.sqrt(spatialCount)));
  const launchCenter = worldPortPosition(component, 'emit', 'from');
  const nominalDirection = worldPortDirection(component, 'emit', 'from');
  const componentBasis = componentAxes(component);
  const fallback = Math.abs(nominalDirection.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const xAxis = normalize(Math.abs(dot(componentBasis.x, nominalDirection)) < 0.999
    ? subtract(componentBasis.x, scale(nominalDirection, dot(componentBasis.x, nominalDirection)))
    : cross(fallback, nominalDirection));
  const yAxis = normalize(cross(nominalDirection, xAxis));
  const field = options.fieldObjectRow ?? {};
  const fieldMode = String((field as any).position ?? (field as any).object ?? (field as any).type ?? '').trim().toLowerCase();
  const angleMode = fieldMode.includes('angle') || fieldMode.includes('infinite') || fieldMode === 'inf';
  const fieldX = finite((field as any).xFieldAngle ?? (field as any).xAngle ?? (field as any).xHeightAngle ?? (field as any).x, 0);
  const fieldY = finite((field as any).yFieldAngle ?? (field as any).yAngle ?? (field as any).fieldAngle ?? (field as any).yHeightAngle ?? (field as any).y, 0);
  const center = angleMode
    ? launchCenter
    : add(launchCenter, add(scale(xAxis, fieldX), scale(yAxis, fieldY)));
  const direction = angleMode
    ? normalize(add(nominalDirection, add(scale(xAxis, Math.tan(fieldX * Math.PI / 180)), scale(yAxis, Math.tan(fieldY * Math.PI / 180)))))
    : nominalDirection;
  const radius = Math.max(0, finite(source.beamDiameterMm, 1)) * 0.5;
  const totalPower = Math.max(0, finite(source.totalPowerW, 0.001));
  const spatialSamples: Array<{ gx: number; gy: number; weight: number }> = [];
  const useExactSourceCount = options.spatialSamples === undefined
    && (options.samplePurpose === 'render' || options.samplePurpose === 'detector');
  if (useExactSourceCount) {
    spatialSamples.push({ gx: 0, gy: 0, weight: 1 });
    const offAxisCount = spatialCount - 1;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let spatial = 0; spatial < offAxisCount; spatial += 1) {
      const radius = Math.sqrt((spatial + 0.5) / Math.max(1, offAxisCount));
      const angle = spatial * goldenAngle;
      const gx = radius * Math.cos(angle);
      const gy = radius * Math.sin(angle);
      const radiusSquared = gx * gx + gy * gy;
      const weight = source.spatialProfile === 'top-hat' ? 1 : Math.exp(-2 * radiusSquared);
      spatialSamples.push({ gx, gy, weight });
    }
  } else {
    for (let spatial = 0; spatial < spatialCount; spatial += 1) {
      const gx = side === 1 ? 0 : ((spatial % side) / (side - 1) * 2 - 1);
      const gy = side === 1 ? 0 : (Math.floor(spatial / side) / (side - 1) * 2 - 1);
      const radiusSquared = gx * gx + gy * gy;
      if (radiusSquared > 1.000001) continue;
      const weight = source.spatialProfile === 'top-hat' ? 1 : Math.exp(-2 * radiusSquared);
      spatialSamples.push({ gx, gy, weight });
    }
  }
  const spatialWeight = spatialSamples.reduce((sum, sample) => sum + sample.weight, 0) || 1;
  const divergenceTan = Math.tan(Math.max(0, finite(source.divergenceDeg, 0)) * Math.PI / 180);
  const rays: RoutedRay[] = [];
  for (const spectral of samples) {
    for (const sample of spatialSamples) {
      const offset = add(scale(xAxis, sample.gx * radius), scale(yAxis, sample.gy * radius));
      const rayDirection = normalize(add(direction, add(scale(xAxis, sample.gx * divergenceTan), scale(yAxis, sample.gy * divergenceTan))));
      const powerW = totalPower * spectral.powerFraction * sample.weight / spatialWeight;
      rays.push({
        id: rays.length,
        positionMm: add(center, offset),
        direction: rayDirection,
        wavelengthNm: spectral.wavelengthNm,
        refractiveIndex: 1,
        opticalPathLengthMm: 0,
        amplitudeRe: Math.sqrt(powerW), amplitudeIm: 0,
        coherenceGroupId: String(source.coherenceGroupId ?? component.id), history: [component.id],
        powerW, phaseRad: finite(source.initialPhaseRad, 0),
        pupilXmm: sample.gx * radius,
        pupilYmm: sample.gy * radius,
        frequencyHz: spectral.frequencyHz,
        sourceId: String(source.id ?? source.componentId ?? component.id),
        lineIndex: spectral.lineIndex,
      });
    }
  }
  return rays;
}

function intersectRayPlane(
  ray: Pick<RoutedRay, 'positionMm' | 'direction'>,
  planePoint: Vec3Mm,
  planeNormal: Vec3Mm,
): { point: Vec3Mm; distanceMm: number } | null {
  const normal = normalize(planeNormal);
  const denominator = dot(ray.direction, normal);
  if (Math.abs(denominator) < 1e-12) return null;
  const distanceMm = dot(subtract(planePoint, ray.positionMm), normal) / denominator;
  if (!Number.isFinite(distanceMm) || distanceMm < -1e-6) return null;
  return { point: add(ray.positionMm, scale(ray.direction, Math.max(0, distanceMm))), distanceMm: Math.max(0, distanceMm) };
}

function intersectPortPlane(ray: RoutedRay, component: CoherentPhysicalComponent, portId: string, side: 'from' | 'to'): { point: Vec3Mm; distanceMm: number } | null {
  return intersectRayPlane(
    ray,
    worldPortPosition(component, portId, side),
    worldPortDirection(component, portId, side),
  );
}

function targetProfileSpec(parameters: any, fallback: any): TargetProfileSpec {
  const kind = String(parameters?.profile ?? fallback?.kind ?? 'flat').toLowerCase();
  return {
    kind: ['step', 'tilt', 'sine', 'csv'].includes(kind) ? kind as TargetProfileSpec['kind'] : 'flat',
    spanMm: Math.max(1e-9, finite(parameters?.widthMm, finite(fallback?.spanMm, 10))),
    offsetUm: finite(parameters?.offsetUm, finite(fallback?.offsetUm)),
    amplitudeUm: finite(parameters?.amplitudeUm, finite(fallback?.amplitudeUm)),
    periodMm: Math.max(1e-9, finite(parameters?.periodMm, finite(fallback?.periodMm, 1))),
    stepPositionMm: finite(parameters?.stepPositionMm, finite(fallback?.stepPositionMm)),
    csvPoints: Array.isArray(parameters?.csvPoints) ? parameters.csvPoints : fallback?.csvPoints,
  };
}

function targetSurfaceAtLocalX(
  component: CoherentPhysicalComponent,
  parameters: any,
  fallback: any,
  localXmm: number,
): { heightMm: number; normal: Vec3Mm } {
  const spec = targetProfileSpec(parameters, fallback);
  const axes = componentAxes(component);
  const profileTangent = String(parameters.profileAxis ?? 'x').toLowerCase() === 'y' ? axes.y : axes.x;
  const heightMm = sampleTargetHeightUm(spec, localXmm) * 1e-3;
  let slope = 0;
  const phaseOnly = String(parameters.surfaceResponse ?? fallback?.surfaceResponse ?? 'specular-normal').toLowerCase() === 'telecentric-phase';
  if (!phaseOnly && spec.kind === 'tilt') {
    slope = spec.amplitudeUm * 1e-3 / Math.max(1e-12, spec.spanMm / 2);
  } else if (!phaseOnly && spec.kind === 'sine') {
    slope = spec.amplitudeUm * 1e-3 * TWO_PI / spec.periodMm * Math.cos(TWO_PI * localXmm / spec.periodMm);
  } else if (!phaseOnly && spec.kind === 'csv') {
    const delta = Math.max(1e-6, Math.min(1e-3, spec.spanMm * 1e-5));
    slope = (sampleTargetHeightUm(spec, localXmm + delta) - sampleTargetHeightUm(spec, localXmm - delta)) * 1e-3 / (2 * delta);
  }
  return { heightMm, normal: normalize(add(axes.z, scale(profileTangent, -slope))) };
}

function intersectTargetSurface(
  ray: RoutedRay,
  component: CoherentPhysicalComponent,
  portId: string,
  parameters: any,
  fallback: any,
): { point: Vec3Mm; distanceMm: number } | null {
  const basePoint = worldPortPosition(component, portId, 'to');
  const axes = componentAxes(component);
  const profileTangent = String(parameters.profileAxis ?? 'x').toLowerCase() === 'y' ? axes.y : axes.x;
  let hit = intersectPortPlane(ray, component, portId, 'to');
  if (!hit) return null;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const localXmm = dot(subtract(hit.point, basePoint), profileTangent);
    const surface = targetSurfaceAtLocalX(component, parameters, fallback, localXmm);
    // The tangent plane must pass through the evaluated profile point
    // (localX, height(localX)). Anchoring it at the component origin instead
    // produces the tangent-line intercept h - x h', which badly corrupts
    // steep sine and tilt targets even though the displayed surface is right.
    const surfacePoint = add(
      basePoint,
      add(scale(profileTangent, localXmm), scale(axes.z, surface.heightMm)),
    );
    const next = intersectRayPlane(ray, surfacePoint, surface.normal);
    if (!next) return null;
    const converged = distance(hit.point, next.point) < 1e-10;
    hit = next;
    if (converged) break;
  }
  return hit;
}

function detectorPixel(ray: RoutedRay, component: CoherentPhysicalComponent, detector: any, point: Vec3Mm): { index: number; pixelX: number; pixelY: number; xMm: number; yMm: number } | null {
  const center = worldPortPosition(component, 'detect', 'to');
  const axes = componentAxes(component);
  const frontNormal = worldPortDirection(component, 'detect', 'to');
  if (detector.frontOnly !== false && dot(ray.direction, frontNormal) >= -1e-10) return null;
  const relative = subtract(point, center);
  const xMm = dot(relative, axes.x);
  const yMm = dot(relative, axes.y);
  const pitchMm = Math.max(1e-9, finite(detector.pixelPitchUm, 5) * 1e-3);
  const width = Math.max(1, Math.round(finite(detector.pixelCountX, 1)));
  const height = Math.max(1, Math.round(finite(detector.pixelCountY, 1)));
  const x = Math.floor(xMm / pitchMm + width / 2);
  const y = Math.floor(yMm / pitchMm + height / 2);
  if (x < 0 || x >= width || y < 0 || y >= height) return null;
  const fillFactor = Math.min(1, Math.max(0, finite(detector.fillFactor, 1)));
  if (fillFactor < 1) {
    const activeSide = Math.sqrt(fillFactor);
    const localX = xMm / pitchMm + width / 2 - x - 0.5;
    const localY = yMm / pitchMm + height / 2 - y - 0.5;
    if (Math.abs(localX) > activeSide * 0.5 || Math.abs(localY) > activeSide * 0.5) return null;
  }
  return {
    index: y * width + x,
    pixelX: xMm / pitchMm + width / 2 - 0.5,
    pixelY: yMm / pitchMm + height / 2 - 0.5,
    xMm,
    yMm,
  };
}

function transformLocalDirection(component: CoherentPhysicalComponent, local: Vec3Mm): Vec3Mm {
  const axes = componentAxes(component);
  return normalize(add(add(scale(axes.x, local.x), scale(axes.y, local.y)), scale(axes.z, local.z)));
}

function reflectedDirection(direction: Vec3Mm, normal: Vec3Mm): Vec3Mm {
  const unitNormal = normalize(normal);
  return normalize(subtract(direction, scale(unitNormal, 2 * dot(direction, unitNormal))));
}

function beamSplitterPlaneNormal(component: CoherentPhysicalComponent, parameters: any, fallback: any): Vec3Mm {
  const axes = componentAxes(component);
  const reflectionPort = String(parameters.reflectionPort ?? fallback?.reflectionPort ?? 'reflect').toLowerCase();
  return reflectionPort === 'recombine'
    ? normalize(add(axes.z, axes.x))
    : normalize(subtract(axes.z, axes.x));
}

interface BeamSplitterPropagation {
  positionMm: Vec3Mm;
  direction: Vec3Mm;
  opticalPathMm: number;
  /** Physical points after the already-intersected entry point. */
  pathMm: Vec3Mm[];
}

function refractedDirection(
  incidentDirection: Vec3Mm,
  normalTowardIncidentMedium: Vec3Mm,
  incidentIndex: number,
  transmittedIndex: number,
): Vec3Mm | null {
  const direction = normalize(incidentDirection);
  let normal = normalize(normalTowardIncidentMedium);
  if (dot(direction, normal) > 0) normal = scale(normal, -1);
  const cosineIncident = Math.max(0, Math.min(1, -dot(direction, normal)));
  const ratio = Math.max(1e-12, incidentIndex) / Math.max(1e-12, transmittedIndex);
  const discriminant = 1 - ratio * ratio * (1 - cosineIncident * cosineIncident);
  if (discriminant < -1e-12) return null;
  return normalize(add(
    scale(direction, ratio),
    scale(normal, ratio * cosineIncident - Math.sqrt(Math.max(0, discriminant))),
  ));
}

function componentCenter(component: CoherentPhysicalComponent): Vec3Mm {
  const transform = resolveComponentTransform(component);
  return { ...transform.positionMm };
}

function beamSplitterEntryIntersection(
  ray: RoutedRay,
  component: CoherentPhysicalComponent,
  entryPortId: string,
  parameters: any,
  fallback: any,
): { point: Vec3Mm; distanceMm: number } | null {
  const model = String(parameters.beamSplitterModel ?? fallback?.model ?? 'ideal').toLowerCase();
  if (model === 'cube') return intersectPortPlane(ray, component, entryPortId, 'to');

  const coatingPoint = componentCenter(component);
  const coatingNormal = beamSplitterPlaneNormal(component, parameters, fallback);
  if (model !== 'plate') return intersectRayPlane(ray, coatingPoint, coatingNormal);

  // The coating is the front surface. Rays approaching from the opposite side
  // must first meet the parallel rear surface rather than jumping to the coat.
  const thicknessMm = Math.max(0, finite(
    parameters.substrateThicknessMm,
    finite(fallback?.substrateThicknessMm, component.dimensions.depthMm),
  ));
  const approachingCoatingSide = dot(ray.direction, coatingNormal) >= 0;
  const entryPlanePoint = approachingCoatingSide
    ? coatingPoint
    : add(coatingPoint, scale(coatingNormal, thicknessMm));
  return intersectRayPlane(ray, entryPlanePoint, coatingNormal);
}

function beamSplitterPropagation(
  ray: RoutedRay,
  component: CoherentPhysicalComponent,
  reflected: boolean,
  entryPortId: string,
  exitPortId: string,
  parameters: any,
  fallback: any,
): BeamSplitterPropagation | null {
  const model = String(parameters.beamSplitterModel ?? fallback?.model ?? 'ideal').toLowerCase();
  const coatingPoint = componentCenter(component);
  const coatingNormal = beamSplitterPlaneNormal(component, parameters, fallback);
  if (model === 'ideal' || model === 'pellicle') {
    return {
      positionMm: { ...ray.positionMm },
      direction: reflected ? reflectedDirection(ray.direction, coatingNormal) : normalize(ray.direction),
      opticalPathMm: 0,
      pathMm: [],
    };
  }

  const substrateIndex = Math.max(1e-9, finite(parameters.substrateIndexNd, finite(fallback?.substrateIndexNd, 1.5168)));
  if (model === 'cube') {
    const incidentIndex = Math.max(1e-9, finite(ray.refractiveIndex, 1));
    const entryOutwardNormal = worldPortDirection(component, entryPortId, 'to');
    const insideIncident = refractedDirection(ray.direction, entryOutwardNormal, incidentIndex, substrateIndex);
    if (!insideIncident) return null;
    const coatingHit = intersectRayPlane(
      { positionMm: ray.positionMm, direction: insideIncident },
      coatingPoint,
      coatingNormal,
    );
    if (!coatingHit) return null;
    const insideOutgoing = reflected
      ? reflectedDirection(insideIncident, coatingNormal)
      : insideIncident;
    const exitPlanePoint = worldPortPosition(component, exitPortId, 'from');
    const exitOutwardNormal = worldPortDirection(component, exitPortId, 'from');
    const exitHit = intersectRayPlane(
      { positionMm: coatingHit.point, direction: insideOutgoing },
      exitPlanePoint,
      exitOutwardNormal,
    );
    if (!exitHit) return null;
    const outsideDirection = refractedDirection(
      insideOutgoing,
      scale(exitOutwardNormal, -1),
      substrateIndex,
      incidentIndex,
    );
    if (!outsideDirection) return null;
    const glassDistanceMm = coatingHit.distanceMm + exitHit.distanceMm;
    return {
      positionMm: exitHit.point,
      direction: outsideDirection,
      opticalPathMm: substrateIndex * glassDistanceMm,
      pathMm: [coatingHit.point, exitHit.point],
    };
  }

  if (model !== 'plate') return null;
  const thicknessMm = Math.max(0, finite(parameters.substrateThicknessMm, finite(fallback?.substrateThicknessMm, component.dimensions.depthMm)));
  if (!(thicknessMm > 0)) {
    return {
      positionMm: { ...ray.positionMm },
      direction: reflected ? reflectedDirection(ray.direction, coatingNormal) : normalize(ray.direction),
      opticalPathMm: 0,
      pathMm: [],
    };
  }
  const incidentIndex = Math.max(1e-9, finite(ray.refractiveIndex, 1));
  const approachingCoatingSide = dot(ray.direction, coatingNormal) >= 0;
  const rearPlanePoint = add(coatingPoint, scale(coatingNormal, thicknessMm));

  if (approachingCoatingSide) {
    if (reflected) {
      return {
        positionMm: { ...ray.positionMm },
        direction: reflectedDirection(ray.direction, coatingNormal),
        opticalPathMm: 0,
        pathMm: [],
      };
    }
    const frontOutwardNormal = scale(coatingNormal, -1);
    const insideDirection = refractedDirection(ray.direction, frontOutwardNormal, incidentIndex, substrateIndex);
    if (!insideDirection) return null;
    const rearHit = intersectRayPlane(
      { positionMm: ray.positionMm, direction: insideDirection },
      rearPlanePoint,
      coatingNormal,
    );
    if (!rearHit) return null;
    const outsideDirection = refractedDirection(insideDirection, scale(coatingNormal, -1), substrateIndex, incidentIndex);
    if (!outsideDirection) return null;
    return {
      positionMm: rearHit.point,
      direction: outsideDirection,
      opticalPathMm: substrateIndex * rearHit.distanceMm,
      pathMm: [rearHit.point],
    };
  }

  // Back-side incidence first refracts at the uncoated rear face, then reaches
  // the coating. A reflected ray returns through the substrate; a transmitted
  // ray exits directly through the coated front surface.
  const rearOutwardNormal = coatingNormal;
  const insideIncident = refractedDirection(ray.direction, rearOutwardNormal, incidentIndex, substrateIndex);
  if (!insideIncident) return null;
  const coatingHit = intersectRayPlane(
    { positionMm: ray.positionMm, direction: insideIncident },
    coatingPoint,
    coatingNormal,
  );
  if (!coatingHit) return null;
  const insideOutgoing = reflected
    ? reflectedDirection(insideIncident, coatingNormal)
    : insideIncident;
  if (!reflected) {
    const outsideDirection = refractedDirection(insideOutgoing, coatingNormal, substrateIndex, incidentIndex);
    if (!outsideDirection) return null;
    return {
      positionMm: coatingHit.point,
      direction: outsideDirection,
      opticalPathMm: substrateIndex * coatingHit.distanceMm,
      pathMm: [coatingHit.point],
    };
  }
  const rearHit = intersectRayPlane(
    { positionMm: coatingHit.point, direction: insideOutgoing },
    rearPlanePoint,
    coatingNormal,
  );
  if (!rearHit) return null;
  const outsideDirection = refractedDirection(insideOutgoing, scale(rearOutwardNormal, -1), substrateIndex, incidentIndex);
  if (!outsideDirection) return null;
  return {
    positionMm: rearHit.point,
    direction: outsideDirection,
    opticalPathMm: substrateIndex * (coatingHit.distanceMm + rearHit.distanceMm),
    pathMm: [coatingHit.point, rearHit.point],
  };
}

function gratingOrderFromPort(portId: string, fallback: number): number {
  const match = String(portId).match(/order\s*([+-]?\d+)/i);
  return match ? Math.round(finite(match[1], fallback)) : Math.round(fallback);
}

function diffractedDirection(ray: RoutedRay, component: CoherentPhysicalComponent, exitPortId: string, parameters: any): Vec3Mm | null {
  const order = gratingOrderFromPort(exitPortId, finite(parameters.order, 1));
  const normal = componentAxes(component).z;
  const grooveLocal = normalize({
    x: finite(parameters.grooveDirectionX, 0),
    y: finite(parameters.grooveDirectionY, 1),
    z: finite(parameters.grooveDirectionZ, 0),
  });
  const groove = transformLocalDirection(component, grooveLocal);
  const dispersion = normalize(cross(groove, normal));
  const incidentNormal = dot(ray.direction, normal);
  const incidentTangent = subtract(ray.direction, scale(normal, incidentNormal));
  const wavelengthMm = ray.wavelengthNm * 1e-6;
  const gratingShift = order * wavelengthMm * Math.max(0, finite(parameters.grooveDensityLinesPerMm, 600));
  const outgoingTangent = add(incidentTangent, scale(dispersion, gratingShift));
  const tangentSquared = dot(outgoingTangent, outgoingTangent);
  if (!Number.isFinite(tangentSquared) || tangentSquared > 1 + 1e-12) return null;
  const normalMagnitude = Math.sqrt(Math.max(0, 1 - tangentSquared));
  const outgoingNormal = incidentNormal >= 0 ? -normalMagnitude : normalMagnitude;
  return normalize(add(outgoingTangent, scale(normal, outgoingNormal)));
}

interface ComponentInteractionResult {
  ray: RoutedRay;
  pathMm: Vec3Mm[];
}

function parallelSlabPropagation(
  ray: RoutedRay,
  component: CoherentPhysicalComponent,
  entryPortId: string,
  exitPortId: string,
  substrateIndex: number,
): BeamSplitterPropagation | null {
  const incidentIndex = Math.max(1e-9, finite(ray.refractiveIndex, 1));
  const entryOutwardNormal = worldPortDirection(component, entryPortId, 'to');
  const insideDirection = refractedDirection(ray.direction, entryOutwardNormal, incidentIndex, substrateIndex);
  if (!insideDirection) return null;
  const exitPlanePoint = worldPortPosition(component, exitPortId, 'from');
  const exitOutwardNormal = worldPortDirection(component, exitPortId, 'from');
  const exitHit = intersectRayPlane(
    { positionMm: ray.positionMm, direction: insideDirection },
    exitPlanePoint,
    exitOutwardNormal,
  );
  if (!exitHit) return null;
  const outsideDirection = refractedDirection(
    insideDirection,
    scale(exitOutwardNormal, -1),
    substrateIndex,
    incidentIndex,
  );
  if (!outsideDirection) return null;
  return {
    positionMm: exitHit.point,
    direction: outsideDirection,
    opticalPathMm: substrateIndex * exitHit.distanceMm,
    pathMm: [exitHit.point],
  };
}

function applyComponentInteraction(
  ray: RoutedRay,
  component: CoherentPhysicalComponent,
  entryPortId: string,
  exitPortId: string,
  design: any,
  parameters: any,
): ComponentInteractionResult | null {
  let powerFactor = Math.max(0, finite(component.powerEfficiency, 1));
  let phase = 0;
  let direction = ray.direction;
  let positionMm = { ...ray.positionMm };
  let componentOplMm = 0;
  let pathMm: Vec3Mm[] = [];
  let targetXmm = ray.targetXmm;
  let detectorDelaySlopeMmPerMm = ray.detectorDelaySlopeMmPerMm;
  if (component.kind === 'beam-splitter') {
    const entry = String(entryPortId).toLowerCase();
    const exit = String(exitPortId).toLowerCase();
    const transmittedPair = (
      (entry === 'common' && exit === 'transmit')
      || (entry === 'transmit' && exit === 'common')
      || (entry === 'reflect' && exit === 'recombine')
      || (entry === 'recombine' && exit === 'reflect')
    );
    const reflected = !transmittedPair;
    powerFactor = reflected ? finite(parameters.reflectance, finite(design.beamSplitter.reflectance, 0.5)) : finite(parameters.transmittance, finite(design.beamSplitter.transmittance, 0.5));
    phase = (reflected ? finite(parameters.reflectedPhaseDeg, finite(design.beamSplitter.reflectedPhaseDeg, 90)) : finite(parameters.transmittedPhaseDeg, finite(design.beamSplitter.transmittedPhaseDeg, 0))) * Math.PI / 180;
    const propagation = beamSplitterPropagation(ray, component, reflected, entryPortId, exitPortId, parameters, design.beamSplitter);
    if (!propagation) return null;
    positionMm = propagation.positionMm;
    direction = propagation.direction;
    componentOplMm = propagation.opticalPathMm;
    pathMm = propagation.pathMm;
  } else if (component.kind === 'reflection-grating') {
    const computed = diffractedDirection(ray, component, exitPortId, parameters);
    if (!computed) return null;
    direction = computed;
    powerFactor = finite(parameters.efficiency, finite(design.grating.efficiency, powerFactor));
    // The vector grating equation changes the outgoing direction, but a
    // coherent trace also needs the boundary phase associated with the groove
    // position.  Without exp(i m K·r), rays leaving different grooves have the
    // wrong relative phase: Render still looks diffracted while the Detector
    // carrier collapses or turns into a sampling lattice.
    const order = gratingOrderFromPort(exitPortId, finite(parameters.order, 1));
    const normal = componentAxes(component).z;
    const grooveLocal = normalize({
      x: finite(parameters.grooveDirectionX, 0),
      y: finite(parameters.grooveDirectionY, 1),
      z: finite(parameters.grooveDirectionZ, 0),
    });
    const groove = transformLocalDirection(component, grooveLocal);
    const dispersion = normalize(cross(groove, normal));
    const grooveOrigin = worldPortPosition(component, entryPortId, 'to');
    const grooveCoordinateMm = dot(subtract(ray.positionMm, grooveOrigin), dispersion);
    phase = TWO_PI
      * order
      * Math.max(0, finite(parameters.grooveDensityLinesPerMm, 600))
      * grooveCoordinateMm;
    const inferredDelayModel = finite(parameters.detectorMagnification, finite(design.grating?.detectorMagnification, 1)) > 1 + 1e-12
      ? 'detector-linear-opd'
      : 'diffractive-phase';
    const delayModel = String(parameters.delayModel ?? inferredDelayModel).toLowerCase();
    if (delayModel === 'detector-linear-opd' || delayModel === 'blazed-echelon-opd') {
      // The grating and its relay encode reference-arm delay on Detector Y.
      // Keep this as an OPL slope instead of adding a wavelength-independent
      // groove phase: the latter steers the diffracted ray but cannot move the
      // broadband white-light envelope when the Target height changes.
      const centerWavelengthMm = Math.max(1e-12, finite(design.source?.centerWavelengthNm, ray.wavelengthNm) * 1e-6);
      const incidenceRad = finite(parameters.incidenceAngleDeg, finite(design.grating?.incidenceAngleDeg)) * Math.PI / 180;
      const diffractionSine = order
        * centerWavelengthMm
        * Math.max(0, finite(parameters.grooveDensityLinesPerMm, 600))
        - Math.sin(incidenceRad);
      if (Math.abs(diffractionSine) <= 1) {
        detectorDelaySlopeMmPerMm = diffractionSine
          / Math.max(1e-12, Math.abs(finite(parameters.detectorMagnification, finite(design.grating?.detectorMagnification, 1))));
      }
      if (delayModel === 'blazed-echelon-opd') {
        // Backward-compatible migration for Config revisions created before
        // Detector-linear OPD was introduced. Those revisions calibrated out
        // this legacy scalar echelon path term, so retain it until the Config
        // is next saved with the new delay model.
        const blazeRad = finite(parameters.blazeAngleDeg, finite(design.grating.blazeAngleDeg)) * Math.PI / 180;
        componentOplMm += order * 2 * Math.tan(blazeRad) * grooveCoordinateMm;
      }
    }
  } else if (component.kind === 'target') {
    if (String(parameters.interaction ?? design.target.interaction ?? 'specular') !== 'specular') return null;
    const targetOrigin = worldPortPosition(component, entryPortId, 'to');
    const targetAxes = componentAxes(component);
    const profileTangent = String(parameters.profileAxis ?? 'x').toLowerCase() === 'y' ? targetAxes.y : targetAxes.x;
    const localXmm = dot(subtract(ray.positionMm, targetOrigin), profileTangent);
    targetXmm = localXmm;
    const surface = targetSurfaceAtLocalX(component, parameters, design.target, localXmm);
    direction = reflectedDirection(ray.direction, surface.normal);
    powerFactor = finite(parameters.reflectance, finite(design.targetReflectance, powerFactor));
  } else if (component.kind === 'mirror') {
    direction = reflectedDirection(ray.direction, componentAxes(component).z);
    powerFactor = finite(parameters.reflectance, powerFactor);
  } else if (component.kind === 'attenuator') {
    powerFactor = finite(parameters.transmission, finite(design.attenuatorTransmission, powerFactor));
    const substrateIndex = Math.max(1e-9, finite(parameters.substrateIndexNd, 1.5168));
    const propagation = parallelSlabPropagation(ray, component, entryPortId, exitPortId, substrateIndex);
    if (!propagation) return null;
    positionMm = propagation.positionMm;
    direction = propagation.direction;
    componentOplMm = propagation.opticalPathMm;
    pathMm = propagation.pathMm;
  } else {
    direction = normalize(ray.direction);
  }
  const amplitudeFactor = Math.sqrt(Math.max(0, powerFactor));
  return {
    ray: {
      ...ray,
      positionMm,
      direction,
      powerW: ray.powerW * powerFactor,
      amplitudeRe: amplitudeFactor * (finite(ray.amplitudeRe) * Math.cos(phase) - finite(ray.amplitudeIm) * Math.sin(phase)),
      amplitudeIm: amplitudeFactor * (finite(ray.amplitudeRe) * Math.sin(phase) + finite(ray.amplitudeIm) * Math.cos(phase)),
      opticalPathLengthMm: finite(ray.opticalPathLengthMm) + componentOplMm,
      phaseRad: ray.phaseRad + phase + TWO_PI * componentOplMm * 1e6 / ray.wavelengthNm,
      targetXmm,
      detectorDelaySlopeMmPerMm,
      history: [...(ray.history ?? []), `${component.id}:${exitPortId}`],
    },
    pathMm,
  };
}

function solveWeightedPlane(samples: Array<{ x: number; y: number; z: number; weight: number }>): [number, number, number] {
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const sample of samples) {
    const row = [1, sample.x, sample.y];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) matrix[i][j] += sample.weight * row[i] * row[j];
      matrix[i][3] += sample.weight * row[i] * sample.z;
    }
  }
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    if (Math.abs(matrix[pivot][column]) < 1e-18) return [0, 0, 0];
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let j = column; j < 4; j += 1) matrix[column][j] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let j = column; j < 4; j += 1) matrix[row][j] -= factor * matrix[column][j];
    }
  }
  return [matrix[0][3], matrix[1][3], matrix[2][3]];
}

interface DetectorHit {
  x: number;
  y: number;
  power: number;
  opl: number;
  wavelengthNm: number;
  pupilXmm: number;
  pupilYmm: number;
}

function routeWavefrontMetrics(hits: DetectorHit[]): { wavefrontRmsUm: number; strehl: number } {
  const byWavelength = new Map<string, DetectorHit[]>();
  for (const hit of hits) {
    const key = hit.wavelengthNm.toPrecision(12);
    const samples = byWavelength.get(key) ?? [];
    samples.push(hit);
    byWavelength.set(key, samples);
  }
  let totalPower = 0;
  let varianceWeighted = 0;
  let strehlWeighted = 0;
  for (const samples of byWavelength.values()) {
    const power = samples.reduce((sum, sample) => sum + sample.power, 0);
    if (!(power > 0)) continue;
    const [piston, tiltX, tiltY] = solveWeightedPlane(samples.map((sample) => ({ x: sample.pupilXmm, y: sample.pupilYmm, z: sample.opl, weight: sample.power })));
    const varianceMm2 = samples.reduce((sum, sample) => {
      const residual = sample.opl - piston - tiltX * sample.pupilXmm - tiltY * sample.pupilYmm;
      return sum + sample.power * residual * residual;
    }, 0) / power;
    const rmsMm = Math.sqrt(Math.max(0, varianceMm2));
    const wavelengthMm = samples[0].wavelengthNm * 1e-6;
    const strehl = Math.exp(-Math.pow(TWO_PI * rmsMm / Math.max(1e-15, wavelengthMm), 2));
    totalPower += power;
    varianceWeighted += power * varianceMm2;
    strehlWeighted += power * strehl;
  }
  return {
    wavefrontRmsUm: totalPower > 0 ? Math.sqrt(Math.max(0, varianceWeighted / totalPower)) * 1000 : 0,
    strehl: totalPower > 0 ? strehlWeighted / totalPower : 0,
  };
}

function routeMtf(hits: DetectorHit[], frequencyLpMm: number, orientation: PortRoutedTraceOptions['mtfOrientation']): number {
  if (!(frequencyLpMm > 0) || hits.length === 0) return hits.length > 0 ? 1 : 0;
  const evaluate = (axis: 'x' | 'y') => {
    const byWavelength = new Map<string, DetectorHit[]>();
    for (const hit of hits) {
      const key = hit.wavelengthNm.toPrecision(12);
      const samples = byWavelength.get(key) ?? [];
      samples.push(hit);
      byWavelength.set(key, samples);
    }
    let totalPower = 0; let weightedMtf = 0;
    for (const samples of byWavelength.values()) {
      const power = samples.reduce((sum, sample) => sum + sample.power, 0);
      if (!(power > 0)) continue;
      let real = 0; let imag = 0;
      for (const sample of samples) {
        const phase = TWO_PI * frequencyLpMm * sample[axis];
        real += sample.power * Math.cos(phase);
        imag -= sample.power * Math.sin(phase);
      }
      weightedMtf += power * Math.hypot(real, imag) / power;
      totalPower += power;
    }
    return totalPower > 0 ? weightedMtf / totalPower : 0;
  };
  if (orientation === 'tangential') return evaluate('x');
  if (orientation === 'sagittal') return evaluate('y');
  return 0.5 * (evaluate('x') + evaluate('y'));
}

export async function runPortRoutedTrace(config: Configuration, options: PortRoutedTraceOptions = {}): Promise<PortRoutedTraceResult> {
  const automatic = assemblyRoutingMode(config) === 'automatic-scene'
    ? compileAutomaticAssemblyRouting(config)
    : null;
  const traceConfig = automatic?.configuration ?? config;
  const design = buildHybridAssemblyFromConfiguration(traceConfig);
  const normalized = normalizePortRouteConfiguration(traceConfig);
  const routeSet = options.routeSetId ? normalized.routeSets.find((entry) => entry.id === options.routeSetId) : undefined;
  const routeSetIds = routeSet
    ? Array.from(new Set([
        ...(routeSet.routeIds ?? []),
        routeSet.measurementRouteId,
        routeSet.referenceRouteId,
      ].map(String).filter(Boolean)))
    : undefined;
  const selectedIds = new Set(options.routeIds ?? routeSetIds ?? normalized.routes.filter((route) => route.enabled !== false).map((route) => route.id));
  const resolvedRoutes = normalized.resolvedRoutes.filter((entry) => selectedIds.has(entry.route.id));
  const referenceCalibrationByRoute = new Map<string, number>();
  for (const set of normalized.routeSets) {
    const referenceRouteId = String(set.referenceRouteId ?? '');
    const calibrationMm = finite(set.opdCalibrationMm);
    if (referenceRouteId && calibrationMm !== 0) referenceCalibrationByRoute.set(referenceRouteId, calibrationMm);
  }
  const components = new Map(design.components.map((component) => [component.id, component]));
  const sequences = new Map(design.blockSequences.map((sequence) => [sequence.id.replace(/^sequential:/, 'sequential-group:'), sequence]));
  const sourceSpecs = (design.sources?.length ? design.sources : [design.source]).filter(Boolean);
  const detectorSpecs = (design.detectors?.length ? design.detectors : [design.detector]).filter(Boolean);
  const sources = new Map<string, (typeof sourceSpecs)[number]>();
  const detectors = new Map<string, (typeof detectorSpecs)[number]>();
  for (const source of sourceSpecs) {
    for (const alias of [source.componentId, source.id].map((value) => String(value ?? '').trim()).filter(Boolean)) sources.set(alias, source);
  }
  for (const detector of detectorSpecs) {
    for (const alias of [detector.componentId, detector.id].map((value) => String(value ?? '').trim()).filter(Boolean)) detectors.set(alias, detector);
  }
  // Legacy coherent data sometimes omitted componentId even though the
  // physical Source/Detector component was present. A unique matching
  // component is unambiguous and keeps those files usable after migration.
  const sourceComponents = design.components.filter((component) => component.kind === 'source');
  const detectorComponents = design.components.filter((component) => component.kind === 'detector' || component.kind === 'time-detector');
  if (sourceComponents.length === 1 && sourceSpecs.length === 1) sources.set(sourceComponents[0].id, sourceSpecs[0]);
  if (detectorComponents.length === 1 && detectorSpecs.length === 1) detectors.set(detectorComponents[0].id, detectorSpecs[0]);
  const parametersByComponent = new Map((traceConfig.blocks ?? []).map((block) => [String(block.blockId ?? ''), block.parameters ?? {}]));
  const detectorResults = new Map<string, PortRoutedDetectorResult>();
  const complexByDetectorMode = new Map<string, Map<string, CoherentDetectorMode>>();
  const segments: PortRoutedSegment[] = [];
  const routeMetrics: PortRouteMetrics[] = [];
  const warnings = [
    ...(automatic?.warnings ?? []),
    ...normalized.issues.map((issue) => `${issue.routeId}: ${issue.message}`),
  ];
  for (const block of traceConfig.blocks ?? []) {
    if (block?.blockType !== 'Target') continue;
    const profile = String(block.parameters?.profile ?? 'flat').toLowerCase();
    if (profile !== 'flat' && Math.abs(finite(block.parameters?.amplitudeUm)) < 1e-15) {
      warnings.push(`${String(block.blockId ?? 'Target')}: ${profile} profile has 0 µm amplitude, so it is optically identical to Flat.`);
    }
  }
  let launchedPowerW = 0;
  const countedSources = new Set<string>();
  const totalRouteSteps = Math.max(1, resolvedRoutes.reduce((sum, route) => sum + Math.max(1, route.steps.length), 0));
  let completedRouteSteps = 0;
  const reportProgress = (percent: number, message: string, route?: (typeof resolvedRoutes)[number]) => {
    try {
      options.onProgress?.({
        percent: Math.max(0, Math.min(100, percent)),
        message,
        routeId: route?.route.id,
        routeLabel: route?.route.label,
      });
    } catch (_) {
      // Progress observers must not change the physical trace result.
    }
  };
  reportProgress(0, 'Preparing optical routes');

  const invalidMetric = (routeId: string, routeLabel: string, detectorId: string, failureReason: string): PortRouteMetrics => ({
    routeId, routeLabel, detectorId, valid: false, reachedRays: 0, launchedRays: 0,
    oplMm: 0, centroidXmm: 0, centroidYmm: 0, spotRmsMm: 0,
    wavefrontRmsUm: 0, strehl: 0, mtf: 0, receivedPowerW: 0, failureReason,
  });

  for (const resolved of resolvedRoutes) {
    reportProgress(completedRouteSteps / totalRouteSteps * 92, `Launching ${resolved.route.label}`, resolved);
    const first = resolved.steps[0];
    const last = resolved.steps[resolved.steps.length - 1];
    const sourceId = String(resolved.route.sourceBlockId ?? first?.departure.blockId ?? '');
    const detectorId = String(resolved.route.detectorBlockId ?? last?.arrival.blockId ?? '');
    const sourceComponent = components.get(sourceId);
    const source = sources.get(sourceId);
    const detectorComponent = components.get(detectorId);
    const detector = detectors.get(detectorId);
    if (!resolved.valid || !sourceComponent || !source || !detectorComponent || !detector) {
      const missing = [
        !sourceComponent ? 'Source component' : '',
        !source ? 'Source settings' : '',
        !detectorComponent ? 'Detector component' : '',
        !detector ? 'Detector settings' : '',
      ].filter(Boolean);
      routeMetrics.push(invalidMetric(
        resolved.route.id,
        resolved.route.label,
        detectorId,
        resolved.issues[0]?.message ?? `${missing.join(' and ') || 'Route endpoint'} is missing. Open Design Intent → Optical Assembly.`,
      ));
      completedRouteSteps += Math.max(1, resolved.steps.length);
      reportProgress(completedRouteSteps / totalRouteSteps * 92, `${resolved.route.label} is unavailable`, resolved);
      continue;
    }
    const isTimeDetector = detector.kind === 'time';
    const width = isTimeDetector ? 1 : Math.max(1, Math.round(finite(detector.pixelCountX, 1)));
    const height = isTimeDetector ? 1 : Math.max(1, Math.round(finite(detector.pixelCountY, 1)));
    const densePixelCount = options.spectralFieldsOnly ? 0 : width * height;
    const denseComplexPixelCount = options.denseComplexFields === false ? 0 : densePixelCount;
    if (!detectorResults.has(detectorId)) detectorResults.set(detectorId, {
      detectorId,
      width,
      height,
      pixelPitchUm: finite(detector.pixelPitchUm, 5),
      intensityW: new Float64Array(densePixelCount),
      coherentReal: new Float64Array(denseComplexPixelCount),
      coherentImag: new Float64Array(denseComplexPixelCount),
      spectralFields: [],
      spectralModeCount: 0,
      coherentModeCount: 0,
      totalPowerW: 0,
      hitCount: 0,
      routeIds: [],
    });
    const detectorResult = detectorResults.get(detectorId)!;
    if (!detectorResult.routeIds.includes(resolved.route.id)) detectorResult.routeIds.push(resolved.route.id);
    const modes = complexByDetectorMode.get(detectorId) ?? new Map<string, CoherentDetectorMode>();
    complexByDetectorMode.set(detectorId, modes);
    const rays = launchRays(sourceComponent, source, options);
    if (!countedSources.has(sourceId)) {
      launchedPowerW += rays.reduce((sum, ray) => sum + ray.powerW, 0);
      countedSources.add(sourceId);
    }
    const hits: DetectorHit[] = [];
    let failureReason = '';
    let activeRays = rays.map((ray) => ({ ...ray }));
    for (let stepIndex = 0; stepIndex < resolved.steps.length && activeRays.length > 0; stepIndex += 1) {
      const step = resolved.steps[stepIndex];
      reportProgress(
        (completedRouteSteps + stepIndex) / totalRouteSteps * 92,
        `${resolved.route.label} · ${stepIndex + 1}/${resolved.steps.length}`,
        resolved,
      );
      await yieldToHost();
      const arrivalComponent = components.get(step.arrival.blockId);
      if (!arrivalComponent) { failureReason = `Missing component ${step.arrival.blockId}.`; activeRays = []; break; }
      const arrivalParameters = parametersByComponent.get(arrivalComponent.id) ?? {};
      const arrived: RoutedRay[] = [];
      for (let rayIndex = 0; rayIndex < activeRays.length; rayIndex += 1) {
        if (rayIndex > 0 && rayIndex % COOPERATIVE_RAY_CHUNK === 0) await yieldToHost();
        const ray = activeRays[rayIndex];
        const hit = arrivalComponent.kind === 'beam-splitter'
          ? beamSplitterEntryIntersection(ray, arrivalComponent, step.arrival.portId, arrivalParameters, design.beamSplitter)
          : arrivalComponent.kind === 'target'
            ? intersectTargetSurface(ray, arrivalComponent, step.arrival.portId, arrivalParameters, design.target)
            : intersectPortPlane(ray, arrivalComponent, step.arrival.portId, 'to');
        if (!hit) { failureReason = `Ray did not reach ${step.arrival.blockId}:${step.arrival.portId}.`; continue; }
        const from = { ...ray.positionMm };
        ray.positionMm = hit.point;
        ray.opticalPathLengthMm = finite(ray.opticalPathLengthMm) + hit.distanceMm * finite(ray.refractiveIndex, 1);
        ray.phaseRad += TWO_PI * hit.distanceMm * 1e6 / ray.wavelengthNm;
        if (segments.length < finite(options.renderRayLimit, 25000)) segments.push({ routeId: resolved.route.id, rayId: ray.id, sequence: stepIndex, fromMm: from, toMm: hit.point, kind: 'free-space', direction: step.direction, wavelengthNm: ray.wavelengthNm, powerW: ray.powerW });
        arrived.push(ray);
      }

      if (stepIndex === resolved.steps.length - 1) {
        if (arrivalComponent.id !== detectorId) { failureReason = 'Route ended before its detector.'; activeRays = []; break; }
        for (let rayIndex = 0; rayIndex < arrived.length; rayIndex += 1) {
          if (rayIndex > 0 && rayIndex % COOPERATIVE_RAY_CHUNK === 0) await yieldToHost();
          const ray = arrived[rayIndex];
          const timeFrontAccepted = detector.frontOnly === false || dot(ray.direction, worldPortDirection(arrivalComponent, 'detect', 'to')) < -1e-10;
          const pixel = isTimeDetector
            ? (timeFrontAccepted ? { index: 0, pixelX: 0, pixelY: 0, xMm: 0, yMm: 0 } : null)
            : detectorPixel(ray, arrivalComponent, detector, ray.positionMm);
          if (!pixel) { failureReason = 'Detector was reached outside its active pixels or from the disabled side.'; continue; }
          const modeKey = `${ray.coherenceGroupId ?? ''}:${ray.wavelengthNm.toPrecision(12)}`;
          const field = modes.get(modeKey) ?? {
            pixels: new Map<number, SparseComplexPixel>(),
            frequencyHz: ray.frequencyHz, coherenceGroupId: String(ray.coherenceGroupId ?? ''),
            routeIds: new Set<string>(),
          };
          modes.set(modeKey, field);
          field.routeIds.add(resolved.route.id);
          const amplitude = Math.sqrt(Math.max(0, ray.powerW));
          const calibratedPhaseRad = ray.phaseRad
            - TWO_PI * finite(referenceCalibrationByRoute.get(resolved.route.id)) * 1e6 / ray.wavelengthNm;
          const fieldRe = amplitude * Math.cos(calibratedPhaseRad);
          const fieldIm = amplitude * Math.sin(calibratedPhaseRad);
          const pixelField = field.pixels.get(pixel.index) ?? { real: 0, imag: 0 };
          pixelField.real += fieldRe;
          pixelField.imag += fieldIm;
          field.pixels.set(pixel.index, pixelField);
          detectorResult.spectralFields.push({
            routeId: resolved.route.id,
            sourceId: ray.sourceId,
            lineIndex: ray.lineIndex,
            targetXmm: ray.targetXmm,
            pupilXmm: ray.pupilXmm,
            pupilYmm: ray.pupilYmm,
            opticalPathLengthMm: ray.opticalPathLengthMm,
            detectorDelaySlopeMmPerMm: ray.detectorDelaySlopeMmPerMm,
            pixelX: pixel.pixelX,
            pixelY: pixel.pixelY,
            coherenceGroupId: String(ray.coherenceGroupId ?? ''),
            frequencyHz: ray.frequencyHz,
            wavelengthNm: ray.wavelengthNm,
            fieldRe,
            fieldIm,
          });
          hits.push({
            x: pixel.xMm, y: pixel.yMm, power: ray.powerW, opl: finite(ray.opticalPathLengthMm), wavelengthNm: ray.wavelengthNm,
            pupilXmm: ray.pupilXmm, pupilYmm: ray.pupilYmm,
          });
          detectorResult.hitCount += 1;
        }
        activeRays = [];
        break;
      }

      const next = resolved.steps[stepIndex + 1];
      if (next.departure.blockId !== arrivalComponent.id) { failureReason = 'Route steps are discontinuous.'; activeRays = []; break; }
      if (arrivalComponent.kind === 'sequential-group') {
        const sequence = sequences.get(arrivalComponent.id);
        if (!sequence) { failureReason = 'Exact Sequential Group data is missing.'; activeRays = []; break; }
        const entryPort = step.arrival.portId === 'back' ? 'Back' : 'Front';
        const exactResults = await traceSequentialGroupBatch(sequence, entryPort, arrived, {
          includeSegments: finite(options.renderRayLimit, 25000) > segments.length,
        });
        const traced: RoutedRay[] = [];
        for (let index = 0; index < exactResults.length; index += 1) {
          if (index > 0 && index % COOPERATIVE_RAY_CHUNK === 0) await yieldToHost();
          const exact = exactResults[index];
          const input = arrived[index];
          if (!exact.ok) { failureReason = exact.failureReason ?? 'Exact traversal failed.'; continue; }
          const ray = {
            ...input,
            ...exact.rayState,
            id: input.id,
            powerW: input.powerW,
            pupilXmm: input.pupilXmm,
            pupilYmm: input.pupilYmm,
            phaseRad: input.phaseRad + TWO_PI * exact.oplMm * 1e6 / input.wavelengthNm,
          } as RoutedRay;
          traced.push(ray);
          for (const exactSegment of exact.segments) {
            if (segments.length >= finite(options.renderRayLimit, 25000)) break;
            segments.push({ routeId: resolved.route.id, rayId: ray.id, sequence: stepIndex, fromMm: exactSegment.fromMm, toMm: exactSegment.toMm, kind: 'exact-sequential', direction: entryPort === 'Front' ? 'forward' : 'reverse', wavelengthNm: ray.wavelengthNm, powerW: ray.powerW });
          }
        }
        activeRays = traced;
      } else {
        const interactedRays: RoutedRay[] = [];
        for (let rayIndex = 0; rayIndex < arrived.length; rayIndex += 1) {
          if (rayIndex > 0 && rayIndex % COOPERATIVE_RAY_CHUNK === 0) await yieldToHost();
          const ray = arrived[rayIndex];
          const interactionStart = { ...ray.positionMm };
          const interaction = applyComponentInteraction(ray, arrivalComponent, step.arrival.portId, next.departure.portId, design, arrivalParameters);
          const interacted = interaction?.ray;
          if (!interacted) { failureReason = `${arrivalComponent.label} interaction/order is unavailable for this ray.`; continue; }
          let previousPoint = interactionStart;
          for (const pathPoint of interaction?.pathMm ?? []) {
            if (segments.length >= finite(options.renderRayLimit, 25000)) break;
            if (distance(previousPoint, pathPoint) > 1e-10) {
              segments.push({
                routeId: resolved.route.id,
                rayId: ray.id,
                sequence: stepIndex,
                fromMm: previousPoint,
                toMm: pathPoint,
                kind: 'component',
                direction: step.direction,
                wavelengthNm: ray.wavelengthNm,
                powerW: interacted.powerW,
              });
            }
            previousPoint = pathPoint;
          }
          interactedRays.push(interacted);
        }
        activeRays = interactedRays;
      }
    }

    const receivedPowerW = hits.reduce((sum, hit) => sum + hit.power, 0);
    const weight = receivedPowerW || 1;
    const centroidXmm = hits.reduce((sum, hit) => sum + hit.x * hit.power, 0) / weight;
    const centroidYmm = hits.reduce((sum, hit) => sum + hit.y * hit.power, 0) / weight;
    const spotRmsMm = Math.sqrt(hits.reduce((sum, hit) => sum + ((hit.x - centroidXmm) ** 2 + (hit.y - centroidYmm) ** 2) * hit.power, 0) / weight);
    const wavefront = routeWavefrontMetrics(hits);
    const mtf = routeMtf(hits, Math.max(0, finite(options.mtfFrequencyLpMm, 0)), options.mtfOrientation ?? 'average');
    routeMetrics.push({
      routeId: resolved.route.id, routeLabel: resolved.route.label, detectorId,
      valid: hits.length > 0, reachedRays: hits.length, launchedRays: rays.length,
      oplMm: hits.reduce((sum, hit) => sum + hit.opl * hit.power, 0) / weight,
      centroidXmm, centroidYmm, spotRmsMm,
      wavefrontRmsUm: wavefront.wavefrontRmsUm, strehl: wavefront.strehl, mtf,
      receivedPowerW, failureReason: hits.length > 0 ? undefined : failureReason || 'No Detector hits.',
    });
    completedRouteSteps += Math.max(1, resolved.steps.length);
    reportProgress(completedRouteSteps / totalRouteSteps * 92, `${resolved.route.label} traced`, resolved);
  }

  reportProgress(94, 'Accumulating Detector fields');
  for (const [detectorId, detectorResult] of detectorResults) {
    const detector = detectors.get(detectorId);
    const modeFields = Array.from(complexByDetectorMode.get(detectorId)?.values() ?? []);
    detectorResult.spectralModeCount = modeFields.length;
    detectorResult.coherentModeCount = modeFields.reduce((count, field) => count + Number(field.routeIds.size > 1), 0);
    let totalPowerW = 0;
    for (const field of modeFields) {
      for (const [index, pixelField] of field.pixels) {
        const powerW = pixelField.real ** 2 + pixelField.imag ** 2;
        totalPowerW += powerW;
        if (index < detectorResult.intensityW.length) {
          detectorResult.intensityW[index] += powerW;
        }
        if (index < detectorResult.coherentReal.length) {
          detectorResult.coherentReal[index] += pixelField.real;
          detectorResult.coherentImag[index] += pixelField.imag;
        }
      }
    }
    detectorResult.totalPowerW = totalPowerW;
    if (detector?.kind === 'time') {
      const sampleCount = Math.max(1, Math.min(131072, Math.round(finite(detector.sampleCount, 4096))));
      const samplingRateHz = Math.max(1, finite(detector.samplingRateHz, 1e9));
      const bandwidthHz = Math.max(0, finite(detector.detectionBandwidthHz, samplingRateHz * 0.5));
      const beats: Array<{ lineIndex: number; frequencyHz: number; powerW: number; phaseRad: number }> = [];
      let beatIndex = 0;
      for (let left = 0; left < modeFields.length; left += 1) {
        const a = modeFields[left];
        const aPixel = a.pixels.get(0);
        const aReal = aPixel?.real ?? 0; const aImag = aPixel?.imag ?? 0;
        const aAmplitude = Math.hypot(aReal, aImag);
        for (let right = left + 1; right < modeFields.length; right += 1) {
          const b = modeFields[right];
          if (a.coherenceGroupId !== b.coherenceGroupId) continue;
          const frequencyHz = Math.abs(a.frequencyHz - b.frequencyHz);
          if (!(frequencyHz > 0) || frequencyHz > bandwidthHz) continue;
          const bPixel = b.pixels.get(0);
          const bReal = bPixel?.real ?? 0; const bImag = bPixel?.imag ?? 0;
          const bAmplitude = Math.hypot(bReal, bImag);
          const powerW = 2 * aAmplitude * bAmplitude;
          if (!(powerW > 0)) continue;
          beats.push({ lineIndex: beatIndex++, frequencyHz, powerW, phaseRad: Math.atan2(aImag, aReal) - Math.atan2(bImag, bReal) });
        }
      }
      beats.sort((a, b) => b.powerW - a.powerW);
      const retained = beats.slice(0, 4096);
      const timeSeconds = new Float64Array(sampleCount);
      const timeSignalW = new Float64Array(sampleCount);
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const time = sample / samplingRateHz;
        let value = detectorResult.totalPowerW;
        for (const beat of retained) value += beat.powerW * Math.cos(TWO_PI * beat.frequencyHz * time + beat.phaseRad);
        timeSeconds[sample] = time;
        timeSignalW[sample] = Math.max(0, value);
      }
      detectorResult.timeSeconds = timeSeconds;
      detectorResult.timeSignalW = timeSignalW;
      detectorResult.rfBeats = retained.map(({ phaseRad: _phaseRad, ...beat }) => beat);
    }
  }
  const detectedPowerW = Array.from(detectorResults.values()).reduce((sum, detector) => sum + detector.totalPowerW, 0);
  reportProgress(100, 'Detector route trace complete');
  return { revision: finite(design.revision), routeMetrics, detectors: Array.from(detectorResults.values()), segments, warnings, energy: { launchedPowerW, detectedPowerW, lostPowerW: Math.max(0, launchedPowerW - detectedPowerW) } };
}
