import {
  normalizeCoherentAssemblyDesign,
  resolveComponentTransform,
  type CoherentAssemblyDesign,
  type CoherentDetectorSpec,
  type CoherentPhysicalComponent,
  type CoherentSourceSpec,
  type Vec3Mm,
} from './coherent-assembly.ts';
import { isTauriRuntime } from '../src/desktop/runtime.ts';
import { preloadRustRayTracingWasm } from '../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';

export interface NonSequentialTraceRequest {
  surfaces: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  detectors: Array<Record<string, unknown>>;
  settings: Record<string, unknown>;
}

export interface NonSequentialRaySegment {
  rayId: number;
  parentRayId?: number | null;
  startMm: Vec3Mm;
  endMm: Vec3Mm;
  wavelengthNm: number;
  powerW: number;
  surfaceId: string;
  history: string;
}

export interface NonSequentialDetectorResult {
  detectorId: string;
  kind: 'area' | 'time' | string;
  width: number;
  height: number;
  intensityWPerPixel: number[];
  integratedPowerW: number;
  maximumWPerPixel: number;
  hitCount: number;
  spectralFields: Array<{
    pixelX: number;
    pixelY: number;
    coherenceGroupId: string;
    frequencyHz: number;
    wavelengthNm: number;
    fieldRe: number;
    fieldIm: number;
  }>;
  timeSeconds: number[];
  timeSignalW: number[];
  rfBeats: Array<{ lineIndex: number; frequencyHz: number; powerW: number }>;
}

export interface NonSequentialTraceResult {
  segments: NonSequentialRaySegment[];
  detectors: NonSequentialDetectorResult[];
  spectrumLines: Array<{ sourceId: string; lineIndex: number; frequencyHz: number; wavelengthNm: number; powerW: number }>;
  ghostPaths: Array<{ signature: string; detectedPowerW: number; hitCount: number }>;
  energy: {
    emittedPowerW: number;
    detectedRayPowerW: number;
    escapedPowerW: number;
    absorbedPowerW: number;
    truncatedPowerW: number;
  };
  generatedRayCount: number;
  terminatedRayCount: number;
  warnings: string[];
  revision?: number;
  quality?: 'preview' | 'full';
}

type TraceQuality = 'preview' | 'full';

const finite = (value: unknown, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clampInt = (value: unknown, minimum: number, maximum: number): number => (
  Math.max(minimum, Math.min(maximum, Math.round(finite(value, minimum))))
);

function componentById(design: CoherentAssemblyDesign, id: string | undefined): CoherentPhysicalComponent | undefined {
  return id ? design.components.find((entry) => entry.id === id) : undefined;
}

function componentTransform(design: CoherentAssemblyDesign, id: string | undefined): Record<string, unknown> {
  const component = componentById(design, id);
  const transform = component ? resolveComponentTransform(component) : {
    positionMm: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 },
  };
  return { positionMm: transform.positionMm, rotationDeg: transform.rotationDeg };
}

function sourceRequest(design: CoherentAssemblyDesign, source: CoherentSourceSpec, quality: TraceQuality, index: number): Record<string, unknown> {
  const settings = design.traceSettings;
  const repetitionRateHz = finite(source.repetitionRateHz, finite(source.repetitionRateGHz) * 1e9);
  const ceoFrequencyHz = finite(source.ceoFrequencyHz, finite(source.offsetFrequencyMHz) * 1e6);
  const isComb = source.kind === 'frequency-comb';
  const requestedSpectral = isComb ? finite(source.lineCount, source.spectralSamples) : source.spectralSamples;
  const spectralCount = quality === 'preview'
    ? Math.min(clampInt(requestedSpectral, 1, 100001), settings?.previewSpectralSamples ?? 9)
    : clampInt(requestedSpectral, 1, 100001);
  const spatialCount = quality === 'preview'
    ? Math.min(clampInt(source.spatialSamples, 1, 4096), settings?.previewSpatialSamples ?? 9)
    : clampInt(source.spatialSamples, 1, 4096);
  return {
    id: source.id ?? `source-${index + 1}`,
    coherenceGroupId: source.coherenceGroupId ?? source.id ?? `source-${index + 1}`,
    transform: componentTransform(design, source.componentId ?? source.id),
    totalPowerW: finite(source.totalPowerW, 0),
    beamDiameterMm: Math.max(0, finite(source.beamDiameterMm, 1)),
    divergenceDeg: finite(source.divergenceDeg, 0),
    spatialProfile: source.spatialProfile ?? 'gaussian',
    spatialSamples: spatialCount,
    spectrum: {
      kind: isComb ? 'frequency-comb' : 'supercontinuum',
      centerWavelengthNm: finite(source.centerWavelengthNm, 600),
      minWavelengthNm: finite(source.minWavelengthNm, source.centerWavelengthNm - source.bandwidthFwhmNm),
      maxWavelengthNm: finite(source.maxWavelengthNm, source.centerWavelengthNm + source.bandwidthFwhmNm),
      bandwidthFwhmNm: Math.max(1e-12, finite(source.bandwidthFwhmNm, 1)),
      spectralSamples: spectralCount,
      shape: source.spectralShape ?? 'gaussian',
      repetitionRateHz,
      ceoFrequencyHz,
      lineCount: spectralCount,
      lineWidthHz: Math.max(0, finite(source.lineWidthHz, 0)),
      initialPhaseRad: finite(source.initialPhaseRad, 0) + finite(source.relativePhaseRad, 0),
      groupDelayDispersionFs2: finite(source.groupDelayDispersionFs2, 0),
      relativeDelayFs: finite(source.relativeDelayFs, 0),
    },
  };
}

function detectorRequest(detector: CoherentDetectorSpec, index: number): Record<string, unknown> {
  return {
    id: detector.id ?? `detector-${index + 1}`,
    kind: detector.kind ?? 'area',
    pixelCountX: clampInt(detector.pixelCountX, 1, 8192),
    pixelCountY: clampInt(detector.pixelCountY, 1, 8192),
    pixelPitchUm: Math.max(1e-6, finite(detector.pixelPitchUm, 10)),
    fillFactor: Math.max(0, Math.min(1, finite(detector.fillFactor, 1))),
    responsivity: Math.max(0, finite(detector.responsivity, 1)),
    frontOnly: detector.frontOnly === true,
    samplingRateHz: Math.max(1, finite(detector.samplingRateHz, 100e6)),
    sampleCount: clampInt(detector.sampleCount, 2, 1000000),
    integrationTimeS: Math.max(0, finite(detector.integrationTimeS, 0)),
  };
}

function apertureFor(component: CoherentPhysicalComponent): Record<string, unknown> {
  const radius = finite(component.dimensions.apertureDiameterMm, 0) * 0.5;
  if (radius > 0) return { kind: 'circle', radiusMm: radius, widthMm: radius * 2, heightMm: radius * 2 };
  return {
    kind: 'rectangle',
    widthMm: Math.max(1e-6, finite(component.dimensions.widthMm, 1)),
    heightMm: Math.max(1e-6, finite(component.dimensions.heightMm, 1)),
    radiusMm: 0,
  };
}

function interactionFor(design: CoherentAssemblyDesign, item: CoherentPhysicalComponent): Record<string, unknown> {
  const metadata = item.metadata ?? {};
  switch (item.kind) {
    case 'mirror':
      return { kind: 'mirror', reflectivity: finite(item.powerEfficiency, 0.98), phaseDeg: 180 };
    case 'attenuator':
      return { kind: 'attenuator', transmission: finite(design.attenuatorTransmission, finite(item.powerEfficiency, 0.5)) };
    case 'beam-splitter':
      return {
        kind: 'beam-splitter',
        reflectance: finite(design.beamSplitter.reflectance, 0.5),
        transmittance: finite(design.beamSplitter.transmittance, 0.5),
        reflectedPhaseDeg: finite(design.beamSplitter.reflectedPhaseDeg, 90),
        transmittedPhaseDeg: finite(design.beamSplitter.transmittedPhaseDeg, 0),
        beamSplitterModel: design.beamSplitter.model ?? 'ideal',
        substrateIndexNd: finite(design.beamSplitter.substrateIndexNd, 1.5168),
        substrateAbbeNumber: finite(design.beamSplitter.substrateAbbeNumber, 64.17),
        substrateThicknessMm: finite(design.beamSplitter.substrateThicknessMm, 0),
        wedgeDeg: finite(design.beamSplitter.wedgeDeg, 0),
        backSurfaceReflectance: finite(design.beamSplitter.backSurfaceReflectance, 0),
      };
    case 'cylindrical-lens':
      return {
        kind: 'thin-lens', transmission: finite(item.powerEfficiency, 0.99),
        focalLengthXMm: finite(metadata.focalLengthXmm, 1e9),
        focalLengthYMm: finite(metadata.focalLengthYmm, finite(metadata.focalLengthMm, 1000)),
      };
    case 'lens':
      return {
        kind: 'thin-lens', transmission: finite(item.powerEfficiency, 0.99),
        focalLengthXMm: finite(metadata.focalLengthXmm, finite(metadata.focalLengthMm, 100)),
        focalLengthYMm: finite(metadata.focalLengthYmm, finite(metadata.focalLengthMm, 100)),
      };
    case 'target':
      return { kind: 'target', reflectivity: finite(design.targetReflectance, finite(item.powerEfficiency, 0.7)), phaseDeg: 180, scatterModel: design.target.interaction ?? 'specular', scatterSamples: clampInt(design.target.scatterSamples, 1, 128), scatterA: Math.max(0, finite(design.target.scatterA, 1)), scatterB: Math.max(1e-12, finite(design.target.scatterB, 0.01)), scatterG: Math.max(1e-6, finite(design.target.scatterG, 2)), scatterSigmaDeg: Math.max(1e-6, finite(design.target.scatterSigmaDeg, 5)), bsdfSamples: design.target.bsdfSamples ?? [] };
    case 'reflection-grating':
      return {
        kind: 'grating',
        grooveDensityLinesPerMm: finite(design.grating.grooveDensityLinesPerMm, 600),
        grooveDirection: design.grating.grooveDirection ?? { x: 0, y: 1, z: 0 },
        allowedOrders: design.grating.allowedOrders?.length ? design.grating.allowedOrders : [design.grating.order],
        efficiency: finite(design.grating.efficiency, finite(item.powerEfficiency, 0.75)),
        complexEfficiency: design.grating.complexEfficiency ?? [],
        substrateReflectivity: finite(design.grating.substrateReflectivity, 1),
        nondiffractedReflectivity: finite(design.grating.nondiffractedReflectivity, 0),
        blazeAngleDeg: finite(design.grating.blazeAngleDeg, 0),
        blazeWavelengthNm: finite(design.grating.blazeWavelengthNm, 0),
        incidentSide: design.grating.incidentSide ?? 'front',
      };
    case 'detector':
    case 'time-detector': {
      const detector = (design.detectors ?? [design.detector]).find((entry) => (entry.componentId ?? entry.id) === item.id) ?? design.detector;
      return { kind: 'detector', detectorId: detector.id ?? item.id };
    }
    case 'stop': return { kind: 'absorber' };
    default: return { kind: 'transmit', transmission: finite(item.powerEfficiency, 1) };
  }
}

function surfaceFor(design: CoherentAssemblyDesign, item: CoherentPhysicalComponent): Record<string, unknown>[] {
  if (item.kind === 'source') return [];
  // Exact Design Intent lenses are traced by the sequential kernel. Never
  // substitute them with a plane/thin-lens in the physical-port tracer.
  if (item.kind === 'sequential-group') return [];
  if ((item.kind === 'lens' || item.kind === 'cylindrical-lens') && (
    item.metadata?.source === 'design-intent' || item.metadata?.source === 'blocks-reference'
  )) return [];
  if (item.kind === 'stl-object') {
    const triangles = Array.isArray(item.metadata?.triangles) ? item.metadata?.triangles as Array<Record<string, unknown>> : [];
    return triangles.map((triangle, index) => ({
      id: `${item.id}:triangle:${index}`,
      componentId: item.id,
      transform: componentTransform(design, item.id),
      geometry: { kind: 'triangle', vertexA: triangle.a, vertexB: triangle.b, vertexC: triangle.c },
      aperture: apertureFor(item),
      interaction: interactionFor(design, item),
    }));
  }
  const geometry = item.kind === 'target'
    ? {
      kind: 'profile',
      targetProfile: {
        kind: design.target.kind,
        offsetUm: finite(design.target.offsetUm, 0),
        amplitudeUm: finite(design.target.amplitudeUm, 0),
        periodMm: finite(design.target.periodMm, 1),
        stepPositionMm: finite(design.target.stepPositionMm, 0),
        csvPoints: (design.target.csvPoints ?? []).map((point) => [point.xMm, point.zUm]),
      },
    }
    : { kind: 'plane' };
  return [{
    id: `${item.id}:optical-surface`,
    componentId: item.id,
    transform: componentTransform(design, item.id),
    geometry,
    aperture: apertureFor(item),
    interaction: interactionFor(design, item),
  }];
}

export function buildNonSequentialTraceRequest(input: CoherentAssemblyDesign, quality: TraceQuality = 'full'): NonSequentialTraceRequest {
  const design = normalizeCoherentAssemblyDesign(input);
  const sources = design.sources?.length ? design.sources : [design.source];
  const detectors = design.detectors?.length ? design.detectors : [design.detector];
  const trace = design.traceSettings!;
  return {
    surfaces: design.components.flatMap((item) => surfaceFor(design, item)),
    sources: sources.map((source, index) => sourceRequest(design, source, quality, index)),
    detectors: detectors.map(detectorRequest),
    settings: {
      maxInteractions: clampInt(trace.maxInteractions, 1, 256),
      minRelativePower: Math.max(0, finite(trace.minRelativePower, 1e-9)),
      maxGeneratedRays: clampInt(trace.maxGeneratedRays, 1, 10000000),
      rayEpsilonMm: Math.max(1e-12, finite(trace.rayEpsilonMm, 1e-5)),
      renderSegmentLimit: clampInt(trace.renderSegmentLimit, 0, 1000000),
    },
  };
}

async function invokeTauri(request: NonSequentialTraceRequest): Promise<NonSequentialTraceResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<NonSequentialTraceResult>('run_nonsequential_trace', { request });
}

export async function runNonSequentialTrace(
  input: CoherentAssemblyDesign,
  quality: TraceQuality = 'full',
): Promise<NonSequentialTraceResult> {
  const design = normalizeCoherentAssemblyDesign(input);
  const request = buildNonSequentialTraceRequest(design, quality);
  const result = isTauriRuntime()
    ? await invokeTauri(request)
    : await (async () => {
      const wasm = await preloadRustRayTracingWasm();
      const run = wasm?.run_nonsequential_trace_wasm_json;
      if (typeof run !== 'function') {
        throw new Error('The non-sequential Rust/WASM module is not built. Run npm run wasm:rebuild.');
      }
      return run(JSON.stringify(request)) as NonSequentialTraceResult;
    })();
  return { ...result, revision: design.revision ?? 0, quality };
}

export const NONSEQUENTIAL_TRACE_CHANNEL = 'coopt-nonsequential-trace-v1';

export function publishNonSequentialTrace(result: NonSequentialTraceResult, design: CoherentAssemblyDesign): void {
  const detail = { result, design, revision: design.revision ?? 0 };
  window.dispatchEvent(new CustomEvent('coopt:nonsequential-trace-updated', { detail }));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(NONSEQUENTIAL_TRACE_CHANNEL);
    channel.postMessage(detail);
    channel.close();
  }
}
