import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildDetectorDisplayRaster,
  calculateImagingDetectorSignal,
  calculateDetectorSignalFromPowerMap,
  convolveDetectorFieldsWithCoherentPsf,
  convolveDetectorPowerWithPsf,
  reconstructSampledDetectorIrradiance,
  type ImagingDetectorSignal,
} from '../../analysis/detector-signal.ts';
import {
  reconstructPatentFig2FromDetectorSignal,
  type CoherentDetectorSpec,
  type Fig2SimulationResult,
  type TargetProfileSpec,
} from '../../analysis/coherent-assembly.ts';
import {
  reconstructDualCombSurfaceFromCamera,
  type DualCombCameraReconstructionResult,
} from '../../analysis/dual-comb-camera-reconstruction.ts';
import {
  getHybridDetectorPlaneOffset,
  getHybridDetectorSequentialGroups,
} from '../../analysis/hybrid-detector-plane.ts';
import { expandBlocksToOpticalSystemRows } from '../../data/block-schema.ts';
import {
  runNonSequentialTrace,
  type NonSequentialDetectorResult,
  type NonSequentialTraceResult,
} from '../../analysis/nonsequential-trace.ts';
import {
  readActiveConfiguration,
  readActiveCoherentDesign,
  subscribeActiveCoherentDesign,
  type ActiveCoherentDesignSnapshot,
} from '../../data/coherent-config-store.ts';
import { runPortRoutedTrace, type PortRouteMetrics, type PortRoutedTraceResult } from '../../analysis/port-routed-trace.ts';
import { computeFieldPsf, type FieldPsfComputeResult } from './MultiFieldPsfPage.tsx';
import { createCancelToken, getBestHost, getRows, type CancelToken } from './PsfAnalysisPage.tsx';
import './CoherentSignalPage.css';

const finite = (value: unknown, fallback = 0): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const format = (value: unknown, digits = 3): string => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';

type DisplayQuantity = 'adu' | 'electrons' | 'power';
type AreaResult = {
  signal: ImagingDetectorSignal;
  propagation: 'port-routed-exact' | 'coherent-field' | 'intensity-fallback';
  spectralModeCount: number;
  interferingModeCount: number;
  complexKernelCount: number;
  warning: string;
};

type SurfaceReconstruction = {
  result: Fig2SimulationResult;
  baseOpdMm: number;
  calibrationMinUm: number;
  calibrationMaxUm: number;
};

type DualCombSurfaceReconstruction = {
  result: DualCombCameraReconstructionResult;
  measurementRouteLabel: string;
  referenceRouteLabel: string;
  localOscillatorRouteLabel: string;
};

function broadbandCoherenceLengthMm(source: any): number | null {
  if (source?.kind !== 'supercontinuum') return null;
  const centerNm = finite(source.centerWavelengthNm);
  const bandwidthNm = finite(source.bandwidthFwhmNm, finite(source.maxWavelengthNm) - finite(source.minWavelengthNm));
  if (!(centerNm > 0 && bandwidthNm > 0)) return null;
  return 0.44 * centerNm * centerNm / bandwidthNm * 1e-6;
}

function targetProfileSummary(design: ActiveCoherentDesignSnapshot['design']): string {
  const component = design.components.find((entry) => entry.kind === 'target');
  const parameters = (component as any)?.parameters ?? {};
  const label = component?.label || 'Target';
  const kind = String(parameters.profile ?? design.target.kind ?? 'flat').toLowerCase();
  const widthMm = Math.max(1e-9, finite(parameters.widthMm, design.target.spanMm));
  const offsetUm = finite(parameters.offsetUm, design.target.offsetUm);
  const amplitudeUm = finite(parameters.amplitudeUm, design.target.amplitudeUm);
  const periodMm = Math.max(1e-9, finite(parameters.periodMm, design.target.periodMm));
  const stepPositionMm = finite(parameters.stepPositionMm, design.target.stepPositionMm);
  if (kind === 'tilt') {
    return `${label} · Tilt ${format(offsetUm - amplitudeUm, 3)} → ${format(offsetUm + amplitudeUm, 3)} µm across local X ${format(widthMm, 3)} mm`;
  }
  if (kind === 'sine') {
    return `${label} · Sine ${format(offsetUm, 3)} ± ${format(Math.abs(amplitudeUm), 3)} µm · period ${format(periodMm, 3)} mm along local X`;
  }
  if (kind === 'step') {
    return `${label} · Step ${format(offsetUm, 3)} → ${format(offsetUm + amplitudeUm, 3)} µm at local X ${format(stepPositionMm, 3)} mm`;
  }
  if (kind === 'csv') return `${label} · CSV height profile along local X`;
  return `${label} · Flat ${format(offsetUm, 3)} µm`;
}

function detectorCalibrationRange(
  detector: CoherentDetectorSpec,
): { minimumUm: number; maximumUm: number } {
  const detectorMinimumUm = Number(detector.calibrationMinUm);
  const detectorMaximumUm = Number(detector.calibrationMaxUm);
  return {
    minimumUm: Number.isFinite(detectorMinimumUm) ? detectorMinimumUm : -80,
    maximumUm: Number.isFinite(detectorMaximumUm) ? detectorMaximumUm : 80,
  };
}

function profilePeakToValley(values: ArrayLike<number>): number {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return Number.isFinite(minimum) && Number.isFinite(maximum) ? maximum - minimum : 0;
}

function recoveredStepHeightUm(result: Fig2SimulationResult, target: TargetProfileSpec): number | null {
  if (target.kind !== 'step') return null;
  const left: number[] = [];
  const right: number[] = [];
  const guardMm = Math.max(0, finite(target.spanMm) * 0.01);
  result.xMm.forEach((xMm, index) => {
    if (xMm < finite(target.stepPositionMm) - guardMm) left.push(result.recoveredHeightUm[index]);
    if (xMm > finite(target.stepPositionMm) + guardMm) right.push(result.recoveredHeightUm[index]);
  });
  if (!left.length || !right.length) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  return rightMean - leftMean;
}

function adaptPortRoutedResult(result: PortRoutedTraceResult, design: ActiveCoherentDesignSnapshot['design'], quality: 'preview' | 'full'): NonSequentialTraceResult {
  const detectorById = new Map((design.detectors ?? [design.detector]).map((detector, index) => [detectorId(detector, index), detector]));
  return {
    segments: result.segments.map((segment) => ({
      rayId: segment.rayId,
      parentRayId: null,
      startMm: segment.fromMm,
      endMm: segment.toMm,
      wavelengthNm: segment.wavelengthNm,
      powerW: segment.powerW,
      surfaceId: `${segment.routeId}:${segment.kind}`,
      history: `${segment.routeId}:${segment.direction}:${segment.sequence + 1}`,
    })),
    detectors: result.detectors.map((detector) => {
      const spec = detectorById.get(detector.detectorId);
      return {
        detectorId: detector.detectorId,
        kind: spec?.kind ?? 'area',
        width: detector.width,
        height: detector.height,
        intensityWPerPixel: detector.intensityW,
        integratedPowerW: detector.totalPowerW,
        maximumWPerPixel: detector.intensityW.reduce((maximum, value) => Math.max(maximum, value), 0),
        hitCount: detector.hitCount,
        spectralFields: detector.spectralFields,
        timeSeconds: Array.from(detector.timeSeconds ?? []),
        timeSignalW: Array.from(detector.timeSignalW ?? []),
        rfBeats: detector.rfBeats ?? [],
      };
    }),
    spectrumLines: [], ghostPaths: [],
    energy: {
      emittedPowerW: result.energy.launchedPowerW,
      detectedRayPowerW: result.energy.detectedPowerW,
      escapedPowerW: result.energy.lostPowerW,
      absorbedPowerW: 0,
      truncatedPowerW: 0,
    },
    generatedRayCount: result.routeMetrics.reduce((sum, route) => sum + route.launchedRays, 0),
    terminatedRayCount: result.routeMetrics.reduce((sum, route) => sum + route.reachedRays, 0),
    warnings: result.warnings,
    revision: result.revision,
    quality,
  };
}

function detectorId(detector: CoherentDetectorSpec, index: number): string {
  return String(detector.id ?? detector.componentId ?? `detector-${index + 1}`);
}

function ImagingSignalCanvas({ signal, quantity, logScale }: { signal: ImagingDetectorSignal; quantity: DisplayQuantity; logScale: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const values = quantity === 'adu' ? signal.aduPerPixel : quantity === 'electrons' ? signal.electronsPerPixel : signal.powerWPerPixel;
    const display = buildDetectorDisplayRaster(values, signal.width, signal.height);
    canvas.width = display.width;
    canvas.height = display.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const image = context.createImageData(display.width, display.height);
    const maximum = Math.max(display.maximum, 1e-30);
    for (let index = 0; index < display.values.length; index += 1) {
      const linear = display.values[index] / maximum;
      const value = logScale ? Math.log10(1 + linear * 999) / 3 : linear;
      const offset = index * 4;
      image.data[offset] = Math.round(255 * Math.min(1, value * 2.3));
      image.data[offset + 1] = Math.round(255 * Math.max(0, Math.min(1, (value - 0.12) * 1.55)));
      image.data[offset + 2] = Math.round(255 * Math.max(0, Math.min(1, (value - 0.56) * 2.5)));
      image.data[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [logScale, quantity, signal]);
  return <div className="coherent-signal-detector-stage" aria-label="Area Detector pixel boundary">
    <canvas ref={ref} className="coherent-signal-heatmap" aria-label={`${quantity} detector signal`} />
  </div>;
}

function CoherenceEnvelopeCanvas({ result }: { result: Fig2SimulationResult }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = result.width;
    canvas.height = result.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const image = context.createImageData(result.width, result.height);
    let maximum = 0;
    result.coherenceEnvelope.forEach((value) => { maximum = Math.max(maximum, finite(value)); });
    const scale = Math.max(1e-30, maximum);
    for (let index = 0; index < result.coherenceEnvelope.length; index += 1) {
      const normalized = Math.max(0, Math.min(1, finite(result.coherenceEnvelope[index]) / scale));
      // Suppress spectral side lobes in the diagnostic view so the calibrated
      // coherence ridge remains visually dominant without changing the peak
      // values used by reconstruction.
      const display = Math.pow(normalized, 1.8);
      const offset = index * 4;
      image.data[offset] = Math.round(255 * display);
      image.data[offset + 1] = Math.round(196 * Math.pow(display, 1.35));
      image.data[offset + 2] = Math.round(58 * Math.pow(display, 2));
      image.data[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    context.strokeStyle = '#5ee7ff';
    context.lineWidth = Math.max(2, result.height / 180);
    context.beginPath();
    for (let x = 0; x < result.width; x += 1) {
      const peakY = finite(result.detectedRidgeY?.[x]);
      if (x === 0 || result.ridgeBreakBefore?.[x]) context.moveTo(x, peakY);
      else context.lineTo(x, peakY);
    }
    context.stroke();
  }, [result]);
  return <div className="coherent-signal-reconstruction-image-stage">
    <canvas ref={ref} className="coherent-signal-reconstruction-image" aria-label="Coherence envelope and detected depth ridge" />
  </div>;
}

function HeightProfileCanvas({ result }: { result: Pick<Fig2SimulationResult, 'xMm' | 'targetHeightUm' | 'recoveredHeightUm'> }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const width = 900;
    const height = 320;
    const inset = { left: 54, right: 18, top: 20, bottom: 38 };
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    const xMinimum = Math.min(...result.xMm);
    const xMaximum = Math.max(...result.xMm);
    const allHeights = [...result.targetHeightUm, ...result.recoveredHeightUm].filter(Number.isFinite);
    let zMinimum = allHeights.length ? Math.min(...allHeights) : -1;
    let zMaximum = allHeights.length ? Math.max(...allHeights) : 1;
    const zMargin = Math.max(1, (zMaximum - zMinimum) * 0.12);
    zMinimum -= zMargin;
    zMaximum += zMargin;
    const plotWidth = width - inset.left - inset.right;
    const plotHeight = height - inset.top - inset.bottom;
    const px = (value: number) => inset.left + (value - xMinimum) / Math.max(1e-12, xMaximum - xMinimum) * plotWidth;
    const py = (value: number) => inset.top + (zMaximum - value) / Math.max(1e-12, zMaximum - zMinimum) * plotHeight;
    context.strokeStyle = '#e1e7ef';
    context.lineWidth = 1;
    context.fillStyle = '#66758a';
    context.font = '12px system-ui, sans-serif';
    for (let tick = 0; tick <= 4; tick += 1) {
      const y = inset.top + tick * plotHeight / 4;
      const value = zMaximum - tick * (zMaximum - zMinimum) / 4;
      context.beginPath(); context.moveTo(inset.left, y); context.lineTo(width - inset.right, y); context.stroke();
      context.fillText(value.toFixed(1), 5, y + 4);
    }
    context.strokeStyle = '#7a8799';
    context.strokeRect(inset.left, inset.top, plotWidth, plotHeight);
    const draw = (values: number[], color: string, lineWidth: number) => {
      context.strokeStyle = color;
      context.lineWidth = lineWidth;
      context.beginPath();
      values.forEach((value, index) => {
        const x = px(result.xMm[index]);
        const y = py(value);
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.stroke();
    };
    draw(result.targetHeightUm, '#66758a', 3);
    draw(result.recoveredHeightUm, '#e07a16', 2);
    context.fillStyle = '#66758a';
    context.fillText('X on Target (mm)', width / 2 - 45, height - 10);
    context.save();
    context.translate(15, height / 2 + 34);
    context.rotate(-Math.PI / 2);
    context.fillText('Height (µm)', 0, 0);
    context.restore();
  }, [result]);
  return <canvas ref={ref} className="coherent-signal-profile-plot" aria-label="Input and reconstructed Target height profile" />;
}

function TimeSignalCanvas({ result }: { result: NonSequentialDetectorResult }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const width = 900;
    const height = 280;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#07101e';
    context.fillRect(0, 0, width, height);
    const values = result.timeSignalW ?? [];
    if (values.length < 2) return;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const value of values) {
      minimum = Math.min(minimum, finite(value));
      maximum = Math.max(maximum, finite(value));
    }
    const span = Math.max(1e-30, maximum - minimum);
    context.strokeStyle = 'rgba(142, 164, 194, 0.22)';
    context.lineWidth = 1;
    for (let grid = 1; grid < 4; grid += 1) {
      const y = grid * height / 4;
      context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
    }
    context.strokeStyle = '#65a8ff';
    context.lineWidth = 1.5;
    context.beginPath();
    values.forEach((raw, index) => {
      const x = index / Math.max(1, values.length - 1) * (width - 1);
      const y = height - 1 - (finite(raw) - minimum) / span * (height - 1);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.stroke();
  }, [result]);
  return <canvas ref={ref} className="coherent-signal-timeplot" aria-label="Time detector signal" />;
}

export function CoherentSignalPage() {
  const [snapshot, setSnapshot] = useState<ActiveCoherentDesignSnapshot>(() => readActiveCoherentDesign());
  const [objectIndex, setObjectIndex] = useState(0);
  const [samplingSize, setSamplingSize] = useState(64);
  const [quantity, setQuantity] = useState<DisplayQuantity>('adu');
  const [logScale, setLogScale] = useState(false);
  const [selectedDetectorId, setSelectedDetectorId] = useState('');
  const [psfByDetector, setPsfByDetector] = useState<Record<string, FieldPsfComputeResult>>({});
  const [referenceSignals, setReferenceSignals] = useState<Record<string, ImagingDetectorSignal>>({});
  const [branchResult, setBranchResult] = useState<NonSequentialTraceResult | null>(null);
  const [routeMetrics, setRouteMetrics] = useState<PortRouteMetrics[]>([]);
  const [areaResults, setAreaResults] = useState<Record<string, AreaResult>>({});
  const [surfaceReconstructions, setSurfaceReconstructions] = useState<Record<string, SurfaceReconstruction>>({});
  const [dualCombReconstructions, setDualCombReconstructions] = useState<Record<string, DualCombSurfaceReconstruction>>({});
  const [status, setStatus] = useState('Ready · press Run');
  const [progress, setProgress] = useState({ percent: 0, message: '', running: false, visible: false });
  const [error, setError] = useState('');
  const runToken = useRef(0);
  const cancelRef = useRef<CancelToken | null>(null);
  const design = snapshot.design;
  const detectors = useMemo(
    () => design.detectors?.length ? design.detectors : [design.detector],
    [design.detector, design.detectors],
  );
  const detectorEntries = useMemo(() => detectors.map((detector, index) => {
    const id = detectorId(detector, index);
    const component = design.components.find((entry) => entry.id === (detector.componentId ?? id));
    return { id, detector, label: component?.label || (detector.kind === 'time' ? `Time Detector ${index + 1}` : `Area Detector ${index + 1}`) };
  }), [design.components, detectors]);

  useEffect(() => {
    if (!detectorEntries.length) {
      setSelectedDetectorId('');
      return;
    }
    if (!detectorEntries.some((entry) => entry.id === selectedDetectorId)) setSelectedDetectorId(detectorEntries[0].id);
  }, [detectorEntries, selectedDetectorId]);

  const connectedComponentIds = useMemo(() => new Set(
    design.connections.flatMap((connection) => [connection.fromComponentId, connection.toComponentId]),
  ), [design.connections]);
  const hasPhysicalSignalPath = design.connections.length > 0;
  const hasConnectedSplitter = design.components.some((component) => (
    component.kind === 'beam-splitter' && connectedComponentIds.has(component.id)
  ));
  const physicalDetectorCount = design.components.filter((component) => (
    component.kind === 'detector' || component.kind === 'time-detector'
  )).length;
  const selectedTargetSummary = useMemo(() => targetProfileSummary(design), [design]);
  const collapseSequentialPupilSamples = design.components.some((component) => component.kind === 'sequential-group')
    && !design.components.some((component) => ![
      'source', 'detector', 'time-detector', 'sequential-group',
    ].includes(component.kind));
  const calculationInputKey = useMemo(() => {
    const { revision: _revision, ...designContent } = design;
    const host = getBestHost();
    return JSON.stringify({
      design: designContent,
      opticalRows: getRows(host, 'optical'),
      objectRows: getRows(host, 'object'),
      sourceRows: getRows(host, 'source'),
      objectIndex,
      samplingSize,
    });
  }, [design, objectIndex, samplingSize]);

  useEffect(() => subscribeActiveCoherentDesign((next) => {
    runToken.current += 1;
    cancelRef.current?.abort('Config changed');
    setSnapshot(next);
    setError('');
    setStatus('Stale · press Run');
    setProgress({ percent: 0, message: '', running: false, visible: false });
  }), []);

  const run = useCallback(async (quality: 'preview' | 'full') => {
    const tokenId = ++runToken.current;
    cancelRef.current?.abort('Superseded');
    const cancel = createCancelToken();
    cancelRef.current = cancel;
    setError('');
    setStatus(quality === 'preview' ? 'Previewing exact lens…' : 'Tracing assembly and exact lens…');
    setProgress({ percent: 1, message: 'Preparing Detector calculation', running: true, visible: true });
    try {
      const host = getBestHost();
      const fallbackOpticalRows = getRows(host, 'optical');
      const objectRows = getRows(host, 'object');
      const sourceRows = getRows(host, 'source');
      const sequenceRows = new Map(design.blockSequences.map((sequence) => {
        const expanded = expandBlocksToOpticalSystemRows(sequence.blocks as any[]);
        return [sequence.id, expanded.rows] as const;
      }));
      if (!fallbackOpticalRows.length && !Array.from(sequenceRows.values()).some((rows) => rows.length > 0)) {
        throw new Error('No exact sequential optical surfaces are available.');
      }
      if (!objectRows.length) throw new Error('No field/object definition is available.');
      const activeObjectIndex = Math.max(0, Math.min(objectRows.length - 1, objectIndex));

      let nextBranch: NonSequentialTraceResult | null = null;
      let routedResult: PortRoutedTraceResult | null = null;
      let traceConfiguration: any = null;
      if (hasPhysicalSignalPath) {
        const activeConfiguration = readActiveConfiguration();
        traceConfiguration = activeConfiguration;
        const savedRoutes = design.portRoutes ?? [];
        if (activeConfiguration && savedRoutes.some((route) => route.enabled !== false)) {
          routedResult = await runPortRoutedTrace(activeConfiguration, {
            samplePurpose: quality === 'preview' ? 'render' : 'detector',
            spectralSamples: quality === 'preview' ? 3 : undefined,
            fieldObjectRow: { ...objectRows[activeObjectIndex] },
            renderRayLimit: design.traceSettings?.renderSegmentLimit ?? 25000,
            denseComplexFields: false,
            onProgress: (traceProgress) => {
              if (tokenId !== runToken.current || cancel.aborted) return;
              const percent = Math.min(34, 2 + traceProgress.percent * 0.32);
              setProgress({ percent, message: traceProgress.message, running: true, visible: true });
              setStatus(`Tracing Detector rays · ${traceProgress.message} · ${Math.round(percent)}%`);
            },
          });
          nextBranch = adaptPortRoutedResult(routedResult, design, quality);
          setRouteMetrics(routedResult.routeMetrics);
        } else {
          setProgress({ percent: 5, message: 'Tracing Detector rays', running: true, visible: true });
          nextBranch = await runNonSequentialTrace(design, quality);
          setRouteMetrics([]);
        }
        if (tokenId !== runToken.current || cancel.aborted) return;
        setBranchResult(nextBranch);
        setProgress({ percent: 35, message: 'Detector rays traced', running: true, visible: true });
      } else {
        setBranchResult(null);
        setRouteMetrics([]);
      }

      const areaEntries = detectorEntries.filter((entry) => entry.detector.kind !== 'time');
      const detectorPlaneOffsets = new Map(areaEntries.map((entry) => [
        entry.id,
        getHybridDetectorPlaneOffset(design, entry.detector.componentId ?? entry.id),
      ]));
      const jobs = new Map<string, { defocusMm: number; detectorIds: string[]; sequenceId: string; opticalRows: any[]; sequenceLabel: string }>();
      for (const entry of areaEntries) {
        const plane = detectorPlaneOffsets.get(entry.id);
        const defocusMm = plane?.supported ? plane.defocusMm : 0;
        const sequenceId = String(plane?.sequenceId ?? design.blockSequences[0]?.id ?? '');
        const sequence = design.blockSequences.find((candidate) => candidate.id === sequenceId);
        const opticalRows = sequenceRows.get(sequenceId) ?? fallbackOpticalRows;
        const key = `${sequenceId || 'active'}|${defocusMm.toFixed(9)}`;
        const existing = jobs.get(key);
        if (existing) existing.detectorIds.push(entry.id);
        else jobs.set(key, {
          defocusMm,
          detectorIds: [entry.id],
          sequenceId,
          opticalRows,
          sequenceLabel: sequence?.label ?? 'Active exact optics',
        });
      }
      if (!jobs.size) jobs.set('active|0.000000000', {
        defocusMm: 0,
        detectorIds: [],
        sequenceId: design.blockSequences[0]?.id ?? '',
        opticalRows: sequenceRows.get(design.blockSequences[0]?.id ?? '') ?? fallbackOpticalRows,
        sequenceLabel: design.blockSequences[0]?.label ?? 'Active exact optics',
      });

      const nextPsfByDetector: Record<string, FieldPsfComputeResult> = {};
      let firstPsf: FieldPsfComputeResult | null = null;
      const exactPsfWarnings: string[] = [];
      const psfJobs = Array.from(jobs.values());
      for (let jobIndex = 0; jobIndex < psfJobs.length; jobIndex += 1) {
        const job = psfJobs[jobIndex];
        if (!job.opticalRows.length) throw new Error(`${job.sequenceLabel} has no exact sequential optical surfaces.`);
        let computed: FieldPsfComputeResult;
        try {
          computed = await computeFieldPsf({
            host,
            opticalRows: job.opticalRows,
            sourceRows,
            fieldObjectRow: { ...objectRows[activeObjectIndex] },
            wavelengthValue: 'all',
            samplingSize: quality === 'preview' ? Math.min(32, samplingSize) : samplingSize,
            zeroPad: quality === 'preview' ? 'none' : 'auto',
            colorMode: 'true',
            opdMode: 'raw',
            logScale: false,
            includeComplexField: true,
            defocusMm: job.defocusMm,
            token: cancel,
            onProgress: (percent, message) => {
              if (tokenId !== runToken.current) return;
              const totalPercent = (jobIndex + Math.max(0, Math.min(100, percent)) / 100) / psfJobs.length * 100;
              const overallPercent = Math.min(89, 35 + totalPercent * 0.54);
              setProgress({ percent: overallPercent, message: `${message} · ${job.sequenceLabel}`, running: true, visible: true });
              setStatus(`${message} · ${job.sequenceLabel} · detector ΔZ ${format(job.defocusMm, 3)} mm · ${Math.round(overallPercent)}%`);
            },
          });
        } catch (psfError) {
          if (!routedResult) throw psfError;
          const reason = psfError instanceof Error ? psfError.message : String(psfError);
          exactPsfWarnings.push(`${job.sequenceLabel}: ${reason}`);
          continue;
        }
        if (tokenId !== runToken.current || cancel.aborted) return;
        firstPsf ??= computed;
        for (const id of job.detectorIds) nextPsfByDetector[id] = computed;
      }
      if (tokenId !== runToken.current || cancel.aborted) return;
      if (!firstPsf && !routedResult) throw new Error('Exact sequential PSF returned no detector-plane result.');

      const totalSourcePowerW = (design.sources?.length ? design.sources : [design.source])
        .reduce((sum, source) => sum + Math.max(0, finite(source.totalPowerW)), 0);
      const nextReferenceSignals: Record<string, ImagingDetectorSignal> = {};
      for (const entry of detectorEntries) {
        if (entry.detector.kind === 'time') continue;
        const detectorPsf = nextPsfByDetector[entry.id] ?? firstPsf;
        if (!detectorPsf) continue;
        nextReferenceSignals[entry.id] = calculateImagingDetectorSignal({
          spectralPsf: detectorPsf.spectralComponents,
          detector: entry.detector,
          totalPowerW: totalSourcePowerW,
          opticalThroughput: 1,
        });
      }

      const nextAreaResults: Record<string, AreaResult> = {};
      const branchDetectors = nextBranch?.detectors ?? [];
      for (let detectorIndex = 0; detectorIndex < branchDetectors.length; detectorIndex += 1) {
        const detectorResult = branchDetectors[detectorIndex];
        setProgress({
          percent: Math.min(99, 90 + detectorIndex / Math.max(1, branchDetectors.length) * 9),
          message: `Converting Detector ${detectorIndex + 1}/${branchDetectors.length}`,
          running: true,
          visible: true,
        });
        if (detectorResult.kind === 'time') continue;
        const detectorEntry = detectorEntries.find((entry) => entry.id === detectorResult.detectorId);
        const spec = detectorEntry?.detector;
        if (!spec || !detectorEntry) continue;
        const detectorPsf = nextPsfByDetector[detectorEntry.id] ?? firstPsf;
        const routedDetector = routedResult?.detectors.find((entry) => entry.detectorId === detectorResult.detectorId);
        if (routedDetector) {
          const detectorRoutes = routedResult.routeMetrics.filter((route) => route.valid && route.detectorId === detectorResult.detectorId);
          const routeOplValues = detectorRoutes.map((route) => route.oplMm).filter(Number.isFinite);
          const physicalOpdMm = routeOplValues.length > 1 ? Math.max(...routeOplValues) - Math.min(...routeOplValues) : 0;
          const detectorRouteSet = design.routeSets?.find((set) => set.detectorBlockId === detectorResult.detectorId);
          const measurementRoute = detectorRoutes.find((route) => route.routeId === detectorRouteSet?.measurementRouteId);
          const referenceRoute = detectorRoutes.find((route) => route.routeId === detectorRouteSet?.referenceRouteId);
          const opdCalibrationMm = finite(detectorRouteSet?.opdCalibrationMm);
          const calibratedOpdMm = measurementRoute && referenceRoute
            ? measurementRoute.oplMm - referenceRoute.oplMm + opdCalibrationMm
            : physicalOpdMm;
          const coherenceLengthMm = broadbandCoherenceLengthMm(design.source);
          const pathWarning = coherenceLengthMm && Math.abs(calibratedOpdMm) > coherenceLengthMm
            ? `Calibrated OPD ${calibratedOpdMm.toFixed(6)} mm exceeds the estimated broadband coherence length ${coherenceLengthMm.toExponential(3)} mm. Match the physical arm lengths or update the explicit Route Set calibration.`
            : '';
          const calibrationNote = opdCalibrationMm !== 0
            ? `OPD calibration ${opdCalibrationMm.toFixed(6)} mm is applied as an equivalent delay; Physical OPD remains ${physicalOpdMm.toFixed(6)} mm.`
            : '';
          const coherent = detectorPsf ? convolveDetectorFieldsWithCoherentPsf({
            spectralFields: routedDetector.spectralFields,
            width: routedDetector.width,
            height: routedDetector.height,
            detector: spec,
            spectralPsf: detectorPsf.spectralComponents,
          }) : null;
          if (coherent) {
            nextAreaResults[detectorResult.detectorId] = {
              signal: coherent.signal,
              propagation: 'coherent-field',
              spectralModeCount: coherent.spectralModeCount,
              interferingModeCount: coherent.interferingModeCount,
              complexKernelCount: coherent.complexKernelCount,
              warning: [coherent.warning, calibrationNote, pathWarning].filter(Boolean).join(' '),
            };
          } else {
            const sampledIrradiance = reconstructSampledDetectorIrradiance({
              powerWPerPixel: routedDetector.intensityW,
              width: routedDetector.width,
              height: routedDetector.height,
              sampleCount: routedDetector.hitCount,
            });
            nextAreaResults[detectorResult.detectorId] = {
              signal: calculateDetectorSignalFromPowerMap({
                powerWPerPixel: sampledIrradiance,
                width: routedDetector.width,
                height: routedDetector.height,
                detector: spec,
                wavelengthNm: design.source.centerWavelengthNm,
              }),
              propagation: 'port-routed-exact',
              spectralModeCount: routedDetector.spectralModeCount,
              interferingModeCount: routedDetector.coherentModeCount,
              complexKernelCount: 0,
              warning: [
                exactPsfWarnings.length
                  ? `Standalone diffraction PSF is not applicable to these routed Lens designs (${exactPsfWarnings.join('; ')}). Showing a power-conserving irradiance estimate from the physical Camera ray samples.`
                  : 'Exact-lens complex fields were unavailable; showing a power-conserving irradiance estimate from the physical Camera ray samples.',
                calibrationNote,
                pathWarning,
              ].filter(Boolean).join(' '),
            };
          }
          continue;
        }
        if (!detectorPsf) throw new Error('Exact sequential PSF returned no detector-plane result.');
        if (collapseSequentialPupilSamples) {
          // In a source -> exact sequential group -> detector path, the
          // non-sequential hits are pupil samples. The exact-lens spectral PSF
          // already contains their diffraction/aberration. Rebin that PSF by
          // detector-pixel area and scale it by the physical received power;
          // sparse ray-grid pixels must never become separate image points.
          nextAreaResults[detectorResult.detectorId] = {
            signal: calculateImagingDetectorSignal({
              spectralPsf: detectorPsf.spectralComponents,
              detector: spec,
              totalPowerW: detectorResult.integratedPowerW,
              opticalThroughput: 1,
            }),
            propagation: 'intensity-fallback',
            spectralModeCount: 0,
            interferingModeCount: 0,
            complexKernelCount: 0,
            warning: '',
          };
          continue;
        }
        const coherent = convolveDetectorFieldsWithCoherentPsf({
          spectralFields: detectorResult.spectralFields ?? [],
          width: detectorResult.width,
          height: detectorResult.height,
          detector: spec,
          spectralPsf: detectorPsf.spectralComponents,
        });
        if (coherent) {
          nextAreaResults[detectorResult.detectorId] = {
            signal: coherent.signal,
            propagation: 'coherent-field',
            spectralModeCount: coherent.spectralModeCount,
            interferingModeCount: coherent.interferingModeCount,
            complexKernelCount: coherent.complexKernelCount,
            warning: coherent.warning,
          };
          continue;
        }
        const wavelengthNm = detectorResult.spectralFields?.[0]?.wavelengthNm ?? design.source.centerWavelengthNm;
        nextAreaResults[detectorResult.detectorId] = {
          signal: convolveDetectorPowerWithPsf({
            powerWPerPixel: detectorResult.intensityWPerPixel,
            width: detectorResult.width,
            height: detectorResult.height,
            detector: spec,
            psfData: detectorPsf.psfData,
            psfPixelSizeUm: detectorPsf.pixelSizeUm,
            wavelengthNm,
          }),
          propagation: 'intensity-fallback',
          spectralModeCount: 0,
          interferingModeCount: 0,
          complexKernelCount: 0,
          warning: 'This field uses an intensity PSF fallback because the exact-lens complex field was unavailable.',
        };
      }

      const nextSurfaceReconstructions: Record<string, SurfaceReconstruction> = {};
      const supportsFig2Reconstruction = Boolean(routedResult)
        && design.source.kind !== 'frequency-comb'
        && design.target.interaction !== 'lambertian'
        && design.target.interaction !== 'abg'
        && design.target.interaction !== 'harvey-shack'
        && design.target.interaction !== 'bsdf-csv'
        && design.components.some((component) => component.kind === 'reflection-grating');
      if (supportsFig2Reconstruction && routedResult) {
        setProgress({ percent: 99, message: 'Extracting coherence ridge and surface height', running: true, visible: true });
        const persistedRouteSets = design.routeSets?.length
          ? design.routeSets
          : (readActiveConfiguration()?.routeSets ?? []);
        for (const detectorEntry of areaEntries) {
          const detectorComponentId = detectorEntry.detector.componentId ?? detectorEntry.id;
          const routeSet = persistedRouteSets.find((set: any) => (
            set.detectorBlockId === detectorEntry.id || set.detectorBlockId === detectorComponentId
          ));
          if (!routeSet?.measurementRouteId || !routeSet.referenceRouteId) continue;
          const measurement = routedResult.routeMetrics.find((route) => (
            route.valid && route.detectorId === detectorEntry.id && route.routeId === routeSet.measurementRouteId
          ));
          const reference = routedResult.routeMetrics.find((route) => (
            route.valid && route.detectorId === detectorEntry.id && route.routeId === routeSet.referenceRouteId
          ));
          if (!measurement || !reference) continue;
          const cameraSignal = nextAreaResults[detectorEntry.id];
          if (!cameraSignal) continue;
          const cameraDetectorTrace = routedResult.detectors.find((entry) => entry.detectorId === detectorEntry.id);
          const calibration = detectorCalibrationRange(detectorEntry.detector);
          const calibratedCurrentOpdMm = measurement.oplMm - reference.oplMm + finite(routeSet.opdCalibrationMm);
          // The physical Route OPD is retained as instrument metadata. Surface
          // extraction itself uses only Camera-column translation; it never
          // subtracts the configured Target mean or amplitude.
          const baseOpdMm = calibratedCurrentOpdMm;
          const simulationDesign = {
            ...design,
            detector: { ...detectorEntry.detector },
            detectors: [{ ...detectorEntry.detector }],
          };
          nextSurfaceReconstructions[detectorEntry.id] = {
            result: reconstructPatentFig2FromDetectorSignal({
              powerWPerPixel: cameraSignal.signal.powerWPerPixel,
              width: cameraSignal.signal.width,
              height: cameraSignal.signal.height,
              detector: simulationDesign.detector,
              grating: simulationDesign.grating,
              sourceCenterWavelengthNm: simulationDesign.source.centerWavelengthNm,
              baseOpdMm,
              targetSpanMm: simulationDesign.target.spanMm,
              maximumDetectorPixelsX: 1024,
              maximumDetectorPixelsY: 2048,
              calibrationMinUm: calibration.minimumUm,
              calibrationMaxUm: calibration.maximumUm,
              spectralSampleCount: cameraSignal.spectralModeCount,
              measurementSampleCount: cameraDetectorTrace?.hitCount,
              referenceHeightUm: 0,
              comparisonTarget: simulationDesign.target,
            }),
            baseOpdMm,
            calibrationMinUm: calibration.minimumUm,
            calibrationMaxUm: calibration.maximumUm,
          };
        }
      }

      const nextDualCombReconstructions: Record<string, DualCombSurfaceReconstruction> = {};
      const frequencyCombSources = (design.sources?.length ? design.sources : [design.source])
        .filter((source) => source.kind === 'frequency-comb');
      if (routedResult && frequencyCombSources.length >= 2) {
        let flatReferenceRoutedResult: PortRoutedTraceResult | null = null;
        const slopeCalibrationRoutedResults: Array<{ gradient: number; offsetUm: number; result: PortRoutedTraceResult }> = [];
        const heightCalibrationRoutedResults: Array<{ offsetUm: number; result: PortRoutedTraceResult }> = [];
        const slopeCalibrationGradients = quality === 'preview'
          ? [-0.08, 0.08]
          : [-0.08, -0.06, -0.04, -0.02, -0.01, 0.01, 0.02, 0.04, 0.06, 0.08];
        const heightCalibrationAmplitudeUm = Math.max(
          20,
          Math.min(500, Math.abs(finite(design.target.amplitudeUm)) * 1.25),
        );
        const heightCalibrationOffsetsUm = [-heightCalibrationAmplitudeUm, heightCalibrationAmplitudeUm];
        const slopeCalibrationCases = slopeCalibrationGradients.flatMap((gradient) => (
          heightCalibrationOffsetsUm.map((offsetUm) => ({ gradient, offsetUm }))
        ));
        if (traceConfiguration) {
          const flatReferenceConfiguration = structuredClone(traceConfiguration);
          const targetBlock = (flatReferenceConfiguration.blocks ?? []).find((block: any) => block.blockType === 'Target');
          if (targetBlock?.parameters) {
            targetBlock.parameters.profile = 'flat';
            targetBlock.parameters.offsetUm = 0;
            targetBlock.parameters.amplitudeUm = 0;
            const calibrationMeasurementRouteId = (flatReferenceConfiguration.routeSets ?? [])
              .find((set: any) => set?.measurementRouteId)?.measurementRouteId;
            setProgress({ percent: 96, message: 'Acquiring flat Camera reference', running: true, visible: true });
            const referenceTraceOptions: Parameters<typeof runPortRoutedTrace>[1] = {
              samplePurpose: quality === 'preview' ? 'render' : 'detector',
              spectralSamples: quality === 'preview' ? 3 : undefined,
              fieldObjectRow: { ...objectRows[activeObjectIndex] },
              renderRayLimit: 0,
              spectralFieldsOnly: true,
              routeIds: calibrationMeasurementRouteId ? [String(calibrationMeasurementRouteId)] : undefined,
            };
            flatReferenceRoutedResult = await runPortRoutedTrace(flatReferenceConfiguration, referenceTraceOptions);
            for (let calibrationIndex = 0; calibrationIndex < heightCalibrationOffsetsUm.length; calibrationIndex += 1) {
              const offsetUm = heightCalibrationOffsetsUm[calibrationIndex];
              const heightReferenceConfiguration = structuredClone(flatReferenceConfiguration);
              const heightTargetBlock = (heightReferenceConfiguration.blocks ?? []).find((block: any) => block.blockType === 'Target');
              if (!heightTargetBlock?.parameters) continue;
              heightTargetBlock.parameters.profile = 'flat';
              heightTargetBlock.parameters.offsetUm = offsetUm;
              heightTargetBlock.parameters.amplitudeUm = 0;
              setProgress({
                percent: 96 + (calibrationIndex + 1) / heightCalibrationOffsetsUm.length,
                message: `Acquiring height calibration ${calibrationIndex + 1}/${heightCalibrationOffsetsUm.length}`,
                running: true,
                visible: true,
              });
              const result = await runPortRoutedTrace(heightReferenceConfiguration, referenceTraceOptions);
              heightCalibrationRoutedResults.push({ offsetUm, result });
              if (tokenId !== runToken.current || cancel.aborted) return;
            }
            for (let calibrationIndex = 0; calibrationIndex < slopeCalibrationCases.length; calibrationIndex += 1) {
              const { gradient, offsetUm } = slopeCalibrationCases[calibrationIndex];
              const slopeReferenceConfiguration = structuredClone(flatReferenceConfiguration);
              const slopeTargetBlock = (slopeReferenceConfiguration.blocks ?? []).find((block: any) => block.blockType === 'Target');
              if (!slopeTargetBlock?.parameters) continue;
              slopeTargetBlock.parameters.profile = 'tilt';
              slopeTargetBlock.parameters.offsetUm = offsetUm;
              slopeTargetBlock.parameters.amplitudeUm = gradient
                * Math.max(1e-9, finite(slopeTargetBlock.parameters.widthMm, design.target.spanMm)) * 0.5 * 1000;
              setProgress({
                percent: 97 + (calibrationIndex + 1) / slopeCalibrationCases.length * 2,
                message: `Acquiring surface calibration ${calibrationIndex + 1}/${slopeCalibrationCases.length}`,
                running: true,
                visible: true,
              });
              const result = await runPortRoutedTrace(slopeReferenceConfiguration, referenceTraceOptions);
              slopeCalibrationRoutedResults.push({ gradient, offsetUm, result });
              if (tokenId !== runToken.current || cancel.aborted) return;
            }
            if (tokenId !== runToken.current || cancel.aborted) return;
          }
        }
        setProgress({ percent: 99, message: 'Demodulating dual-comb Camera phase', running: true, visible: true });
        const activeConfiguration = readActiveConfiguration();
        const persistedRoutes = design.portRoutes?.length
          ? design.portRoutes
          : (activeConfiguration?.portRoutes ?? []);
        const persistedRouteSets = design.routeSets?.length
          ? design.routeSets
          : (activeConfiguration?.routeSets ?? []);
        for (const detectorEntry of areaEntries) {
          const detectorComponentId = detectorEntry.detector.componentId ?? detectorEntry.id;
          const routeSet = persistedRouteSets.find((set: any) => (
            set.detectorBlockId === detectorEntry.id || set.detectorBlockId === detectorComponentId
          ));
          if (!routeSet?.measurementRouteId || !routeSet.referenceRouteId) continue;
          const cameraDetectorTrace = routedResult.detectors.find((entry) => entry.detectorId === detectorEntry.id);
          if (!cameraDetectorTrace?.spectralFields?.length) continue;

          const routeIds = Array.isArray(routeSet.routeIds) ? routeSet.routeIds.map(String) : [];
          const measurementRoute = persistedRoutes.find((route: any) => route.id === routeSet.measurementRouteId);
          const referenceRoute = persistedRoutes.find((route: any) => route.id === routeSet.referenceRouteId);
          const measurementSourceIds = new Set(cameraDetectorTrace.spectralFields
            .filter((sample) => sample.routeId === routeSet.measurementRouteId && sample.sourceId)
            .map((sample) => String(sample.sourceId)));
          const localOscillatorRoute = persistedRoutes.find((route: any) => (
            routeIds.includes(String(route.id))
            && route.id !== routeSet.measurementRouteId
            && route.id !== routeSet.referenceRouteId
            && (
              /(^|[^a-z])(lo|local[\s-]*oscillator)([^a-z]|$)/i.test(`${route.id} ${route.label ?? ''}`)
              || (route.sourceBlockId && measurementRoute?.sourceBlockId && route.sourceBlockId !== measurementRoute.sourceBlockId)
              || cameraDetectorTrace.spectralFields.some((sample) => (
                sample.routeId === route.id
                && sample.sourceId
                && !measurementSourceIds.has(String(sample.sourceId))
              ))
            )
          )) ?? persistedRoutes.find((route: any) => (
            routeIds.includes(String(route.id))
            && route.id !== routeSet.measurementRouteId
            && route.id !== routeSet.referenceRouteId
          ));
          if (!localOscillatorRoute) continue;

          const result = reconstructDualCombSurfaceFromCamera({
            spectralFields: cameraDetectorTrace.spectralFields,
            flatReferenceSpectralFields: flatReferenceRoutedResult?.detectors
              .find((entry) => entry.detectorId === detectorEntry.id)?.spectralFields,
            slopeCalibrationReferences: slopeCalibrationRoutedResults.map((calibration) => ({
              gradient: calibration.gradient,
              offsetUm: calibration.offsetUm,
              spectralFields: calibration.result.detectors
                .find((entry) => entry.detectorId === detectorEntry.id)?.spectralFields ?? [],
            })),
            heightCalibrationReferences: heightCalibrationRoutedResults.map((calibration) => ({
              offsetUm: calibration.offsetUm,
              spectralFields: calibration.result.detectors
                .find((entry) => entry.detectorId === detectorEntry.id)?.spectralFields ?? [],
            })),
            detectorWidth: cameraDetectorTrace.width,
            detectorHeight: cameraDetectorTrace.height,
            targetSpanMm: design.target.spanMm,
            measurementRouteId: routeSet.measurementRouteId,
            referenceRouteId: routeSet.referenceRouteId,
            localOscillatorRouteId: localOscillatorRoute.id,
            maximumProfilePoints: 512,
            exposureTimeS: detectorEntry.detector.exposureTimeS,
            comparisonTarget: design.target,
          });
          nextDualCombReconstructions[detectorEntry.id] = {
            result,
            measurementRouteLabel: measurementRoute?.label ?? routeSet.measurementRouteId,
            referenceRouteLabel: referenceRoute?.label ?? routeSet.referenceRouteId,
            localOscillatorRouteLabel: localOscillatorRoute.label ?? localOscillatorRoute.id,
          };
        }
      }

      setPsfByDetector(nextPsfByDetector);
      setReferenceSignals(nextReferenceSignals);
      setAreaResults(nextAreaResults);
      setSurfaceReconstructions(nextSurfaceReconstructions);
      setDualCombReconstructions(nextDualCombReconstructions);
      const detectorHits = (nextBranch?.detectors ?? []).reduce((sum, entry) => sum + entry.hitCount, 0);
      const launchedRays = routedResult?.routeMetrics.reduce((sum, route) => sum + route.launchedRays, 0) ?? 0;
      const lensSummary = firstPsf
        ? `${firstPsf.wavelengthCount} exact-lens wavelength${firstPsf.wavelengthCount === 1 ? '' : 's'}`
        : 'physical routed Camera fields';
      setStatus(`${quality === 'preview' ? 'Preview' : 'Done'} · ${routedResult ? `${routedResult.routeMetrics.filter((route) => route.valid).length} routed path${routedResult.routeMetrics.filter((route) => route.valid).length === 1 ? '' : 's'} · ${launchedRays.toLocaleString()} launched · ` : ''}${detectorEntries.length} detector${detectorEntries.length === 1 ? '' : 's'} · ${detectorHits.toLocaleString()} hits · ${lensSummary}`);
      setProgress({ percent: 100, message: 'Detector signal ready', running: false, visible: true });
    } catch (caught: any) {
      if (cancel.aborted || caught?.code === 'CANCELLED') return;
      if (tokenId !== runToken.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus('Calculation failed');
      setProgress({ percent: 0, message: 'Calculation failed', running: false, visible: true });
    }
  }, [calculationInputKey]);

  useEffect(() => () => cancelRef.current?.abort('Window closed'), []);

  const host = getBestHost();
  const objectRows = getRows(host, 'object');
  const selectedEntry = detectorEntries.find((entry) => entry.id === selectedDetectorId) ?? detectorEntries[0];
  const selectedRawResult = branchResult?.detectors.find((entry) => entry.detectorId === selectedEntry?.id);
  const selectedAreaResult = selectedEntry ? areaResults[selectedEntry.id] : undefined;
  const selectedSurfaceReconstruction = selectedEntry ? surfaceReconstructions[selectedEntry.id] : undefined;
  const selectedDualCombReconstruction = selectedEntry ? dualCombReconstructions[selectedEntry.id] : undefined;
  const selectedReference = selectedEntry ? referenceSignals[selectedEntry.id] : undefined;
  const selectedPsf = selectedEntry ? psfByDetector[selectedEntry.id] : undefined;
  const selectedPlaneOffset = selectedEntry
    ? getHybridDetectorPlaneOffset(design, selectedEntry.detector.componentId ?? selectedEntry.id)
    : null;
  const selectedSequentialGroups = selectedEntry
    ? getHybridDetectorSequentialGroups(design, selectedEntry.detector.componentId ?? selectedEntry.id)
    : [];
  const selectedSequenceId = String(
    selectedPlaneOffset?.sequenceId
    ?? selectedSequentialGroups[0]?.metadata?.sequenceId
    ?? '',
  );
  const selectedSequenceLabel = design.blockSequences.find((sequence) => sequence.id === selectedSequenceId)?.label
    ?? selectedSequentialGroups[0]?.label
    ?? 'Active exact optics';
  const physicalDetectorConnected = selectedEntry
    ? connectedComponentIds.has(selectedEntry.detector.componentId ?? selectedEntry.id)
    : false;
  const selectedDetectorRouteMetrics = selectedEntry
    ? routeMetrics.filter((route) => route.detectorId === selectedEntry.id)
    : [];
  const selectedRouteMetrics = selectedDetectorRouteMetrics
    .filter((route) => route.valid);
  const selectedLaunchedRays = selectedDetectorRouteMetrics.reduce((sum, route) => sum + route.launchedRays, 0);
  const selectedReachedRays = selectedDetectorRouteMetrics.reduce((sum, route) => sum + route.reachedRays, 0);
  const selectedRouteOpl = selectedRouteMetrics.map((route) => route.oplMm).filter(Number.isFinite);
  const selectedPhysicalOpdMm = selectedRouteOpl.length > 1
    ? Math.max(...selectedRouteOpl) - Math.min(...selectedRouteOpl)
    : 0;
  const persistedRouteSets = design.routeSets?.length
    ? design.routeSets
    : (readActiveConfiguration()?.routeSets ?? []);
  const selectedRouteSet = selectedEntry
    ? persistedRouteSets.find((set: any) => (
      set.detectorBlockId === selectedEntry.id
      || set.detectorBlockId === (selectedEntry.detector.componentId ?? selectedEntry.id)
    ))
    : undefined;
  const selectedMeasurementRoute = selectedRouteMetrics.find((route) => route.routeId === selectedRouteSet?.measurementRouteId);
  const selectedReferenceRoute = selectedRouteMetrics.find((route) => route.routeId === selectedRouteSet?.referenceRouteId);
  const selectedCalibratedOpdMm = selectedMeasurementRoute && selectedReferenceRoute
    ? selectedMeasurementRoute.oplMm - selectedReferenceRoute.oplMm + finite(selectedRouteSet?.opdCalibrationMm)
    : selectedPhysicalOpdMm;
  const selectedBeamOffsetMm = selectedRouteMetrics.length > 1
    ? Math.hypot(
      selectedRouteMetrics[1].centroidXmm - selectedRouteMetrics[0].centroidXmm,
      selectedRouteMetrics[1].centroidYmm - selectedRouteMetrics[0].centroidYmm,
    )
    : 0;
  const accountedEnergy = branchResult
    ? (branchResult.energy.detectedRayPowerW + branchResult.energy.escapedPowerW + branchResult.energy.absorbedPowerW + branchResult.energy.truncatedPowerW)
      / Math.max(branchResult.energy.emittedPowerW, 1e-30) * 100
    : 0;
  const selectedRecoveredStepUm = selectedSurfaceReconstruction
    ? recoveredStepHeightUm(selectedSurfaceReconstruction.result, design.target)
    : null;
  const isDualCombDesign = (design.sources?.length ? design.sources : [design.source])
    .filter((source) => source.kind === 'frequency-comb').length >= 2;

  return <div className="analysis-window-page coherent-signal-page">
    <header className="analysis-window-commandbar coherent-signal-commandbar">
      <div className="coherent-signal-identity">
        <div className="coherent-signal-title"><strong>Coherent Signal</strong><span>{snapshot.configName}</span></div>
      </div>
      <div className="coherent-signal-controls" role="group" aria-label="Signal display controls">
        <label className="window-inline-field coherent-signal-control coherent-signal-control--field">
          <span>Field</span>
          <select value={objectIndex} onChange={(event) => {
            setObjectIndex(Number(event.target.value));
            setStatus('Settings changed · press Run');
          }}>
            {objectRows.map((row, index) => <option key={index} value={index}>{index + 1}: X {row.xHeightAngle ?? row.x ?? 0}, Y {row.yHeightAngle ?? row.y ?? 0}</option>)}
          </select>
        </label>
        <label className="window-inline-field coherent-signal-control coherent-signal-control--detector">
          <span>Detector</span>
          <select value={selectedEntry?.id ?? ''} onChange={(event) => setSelectedDetectorId(event.target.value)}>
            {detectorEntries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </label>
        <label className="window-inline-field coherent-signal-control">
          <span>PSF pupil sampling</span>
          <select value={samplingSize} onChange={(event) => {
            setSamplingSize(Number(event.target.value));
            setStatus('Settings changed · press Run');
          }}>
            <option value={32}>32 × 32</option><option value={64}>64 × 64</option><option value={128}>128 × 128</option><option value={256}>256 × 256</option>
          </select>
        </label>
        {selectedEntry?.detector.kind !== 'time' ? <>
          <label className="window-inline-field coherent-signal-control">
            <span>Display</span>
            <select value={quantity} onChange={(event) => setQuantity(event.target.value as DisplayQuantity)}>
              <option value="adu">ADU</option><option value="electrons">Electrons</option><option value="power">W/pixel</option>
            </select>
          </label>
          <label className="window-inline-field coherent-signal-control">
            <span>Scale</span>
            <select value={logScale ? 'log' : 'linear'} onChange={(event) => setLogScale(event.target.value === 'log')}>
              <option value="linear">Linear</option><option value="log">Log</option>
            </select>
          </label>
        </> : null}
        <button className="analysis-window-primary-action" type="button" onClick={() => void run('full')}>Run</button>
      </div>
    </header>

    <section className="coherent-signal-overview" aria-label="Current signal model">
      <div><span>Selected detector</span><strong>{selectedEntry?.label ?? 'None'}</strong></div>
      <div><span>Detector type</span><strong>{selectedEntry?.detector.kind === 'time' ? 'Time signal' : `${selectedEntry?.detector.pixelCountX ?? 0} × ${selectedEntry?.detector.pixelCountY ?? 0} · ${format(selectedEntry?.detector.pixelPitchUm, 3)} µm`}</strong></div>
      <div><span>Receivers</span><strong>{detectorEntries.length} configured · {physicalDetectorCount} physical</strong></div>
      <div><span>Assembly</span><strong>{design.connections.length > 0 ? `${design.connections.length} connections${hasConnectedSplitter ? ' · split paths' : ''}` : 'Not connected'}</strong></div>
      <div><span>Exact optics</span><strong>{selectedSequentialGroups.length > 0 ? selectedSequenceLabel : 'Not connected'}</strong></div>
      <div className="coherent-signal-status" aria-live="polite"><span>Status</span><strong>{status}</strong></div>
      <div className="coherent-signal-target-summary"><span>Target</span><strong>{selectedTargetSummary}</strong></div>
    </section>

    {progress.visible ? <section className={`coherent-signal-progress${progress.running ? ' is-running' : ''}`} aria-label="Detector signal calculation progress">
      <div className="coherent-signal-progress__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.percent)}>
        <div className="coherent-signal-progress__value" style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
      </div>
      <span>{Math.round(progress.percent)}% · {progress.message}</span>
    </section> : null}

    {error ? <div className="analysis-window-error coherent-signal-error">{error}</div> : null}
    {physicalDetectorCount === 0 ? <div className="coherent-signal-warning coherent-signal-page-warning">Add an Area Detector or Time Detector in Design Intents, then connect it to the assembly.</div> : null}
    {selectedEntry && !physicalDetectorConnected ? <div className="coherent-signal-warning coherent-signal-page-warning">{selectedEntry.label} is not connected, so it cannot receive assembly rays.</div> : null}
    {selectedSequentialGroups.length > 1 && routeMetrics.length === 0 ? <div className="coherent-signal-warning coherent-signal-page-warning">{selectedEntry?.label} has {selectedSequentialGroups.length} Exact Sequential Groups upstream. Save an Optical Route to trace them in explicit Port order.</div> : null}
    {detectorEntries.length > 1 ? <div className="coherent-signal-note">All detectors are calculated in one run. Choose a detector above to inspect it. A detector absorbs the first ray that reaches its active surface; a detector directly behind it will not receive that ray.</div> : null}

    <main className="coherent-signal-results-grid">
      {selectedEntry?.detector.kind !== 'time' ? <>
        <section className="coherent-signal-result-card coherent-signal-result-card--primary">
          <header><div><h2>{selectedEntry?.label ?? 'Detector'} · Physical signal</h2><p>{selectedAreaResult?.propagation === 'coherent-field' ? 'Port-routed complex fields pass through the exact-lens coherent PSF and interfere by wavelength and coherence group.' : selectedAreaResult?.propagation === 'port-routed-exact' ? 'Saved Optical Routes traverse every Exact Sequential Group and physical component in order.' : 'Assembly amplitude and phase pass through the exact sequential-lens complex PSF before detector conversion.'}</p></div></header>
          {selectedAreaResult && selectedRawResult ? <>
            <figure className="coherent-signal-figure">
              <ImagingSignalCanvas signal={selectedAreaResult.signal} quantity={quantity} logScale={logScale} />
              <figcaption>{quantity === 'adu' ? 'ADU' : quantity === 'electrons' ? 'Electrons / pixel' : 'W / pixel'} · {logScale ? 'Log' : 'Linear'} · {selectedAreaResult.signal.width} × {selectedAreaResult.signal.height} pixels</figcaption>
            </figure>
            <div className="coherent-signal-metrics">
              <span>Propagation<strong>{selectedAreaResult.propagation === 'port-routed-exact' ? 'Port-routed exact' : selectedAreaResult.propagation === 'coherent-field' ? 'Complex field + exact lens' : 'Intensity fallback'}</strong></span>
              <span>Detected<strong>{selectedAreaResult.signal.integratedPowerW.toExponential(4)} W</strong></span>
              <span>Maximum<strong>{selectedAreaResult.signal.maximumPowerWPerPixel.toExponential(4)} W/pixel</strong></span>
              <span>Peak charge<strong>{selectedAreaResult.signal.maximumElectronsPerPixel.toExponential(4)} e⁻</strong></span>
              <span>Saturated<strong>{selectedAreaResult.signal.saturatedPixelCount.toLocaleString()} px</strong></span>
              <span>Detector hits<strong>{selectedRawResult.hitCount.toLocaleString()}</strong></span>
              <span>Rays launched<strong>{selectedLaunchedRays.toLocaleString()}</strong></span>
              <span>Ray hit rate<strong>{selectedLaunchedRays > 0 ? `${format(selectedReachedRays / selectedLaunchedRays * 100, 2)}%` : '—'}</strong></span>
              <span>Interfering modes<strong>{selectedAreaResult.interferingModeCount.toLocaleString()}</strong></span>
              <span>Spectral modes<strong>{selectedAreaResult.spectralModeCount.toLocaleString()}</strong></span>
              <span>Lens wavelengths<strong>{selectedAreaResult.complexKernelCount.toLocaleString()}</strong></span>
              <span>Physical OPD<strong>{selectedRouteMetrics.length > 1 ? `${format(selectedPhysicalOpdMm, 6)} mm` : '—'}</strong></span>
              <span>Calibrated OPD<strong>{selectedRouteMetrics.length > 1 ? `${format(selectedCalibratedOpdMm, 6)} mm` : '—'}</strong></span>
              <span>Beam offset<strong>{selectedRouteMetrics.length > 1 ? `${format(selectedBeamOffsetMm, 4)} mm` : '—'}</strong></span>
              <span>Detector plane<strong>{selectedPlaneOffset?.supported ? `ΔZ ${format(selectedPlaneOffset.defocusMm, 3)} mm` : 'Sequential image'}</strong></span>
              <span>Energy accounted<strong>{format(accountedEnergy, 2)}%</strong></span>
            </div>
            {selectedAreaResult.warning ? <div className="coherent-signal-warning">{selectedAreaResult.warning}</div> : null}
          </> : <div className="coherent-signal-empty">{hasPhysicalSignalPath ? 'No rays reached this detector.' : 'Connect this detector to the optical assembly.'}</div>}
        </section>

        <section className="coherent-signal-result-card">
          <header><div><h2>{routeMetrics.length > 0 ? 'Single-group PSF reference' : 'Exact lens reference'} · {selectedSequenceLabel}</h2><p>{routeMetrics.length > 0 ? 'Diagnostic reference only; it does not replace or post-process the Port-routed physical signal.' : 'Sequential lens PSF on the selected detector without Beam Splitter, grating, target or path loss.'}</p></div></header>
          {selectedReference ? <>
            <figure className="coherent-signal-figure">
              <ImagingSignalCanvas signal={selectedReference} quantity={quantity} logScale={logScale} />
              <figcaption>Reference only · {selectedReference.width} × {selectedReference.height} pixels</figcaption>
            </figure>
            <div className="coherent-signal-metrics">
              <span>Input on detector<strong>{selectedReference.integratedPowerW.toExponential(4)} W</strong></span>
              <span>Captured<strong>{format(selectedReference.capturedFraction * 100, 2)}%</strong></span>
              <span>Detector plane<strong>{selectedPlaneOffset?.supported ? `ΔZ ${format(selectedPlaneOffset.defocusMm, 3)} mm` : 'Sequential image'}</strong></span>
              <span>Strehl<strong>{format(selectedPsf?.metrics?.strehlRatio, 4)}</strong></span>
              <span>OPD RMS<strong>{format(selectedPsf?.metrics?.opdRmsUm, 4)} µm</strong></span>
              <span>PSF sample<strong>{format(selectedPsf?.pixelSizeUm, 4)} µm</strong></span>
            </div>
          </> : <div className="coherent-signal-empty">Waiting for the exact sequential PSF.</div>}
        </section>

        {selectedSurfaceReconstruction ? <section className="coherent-signal-result-card coherent-signal-result-card--wide coherent-signal-reconstruction-card">
          <header><div><h2>Surface reconstruction · Camera 80 signal</h2><p>Camera 80 W/pixel is the only shape-measurement input. Each measured X column is correlated with the measured Camera reference column; its Detector-Y translation is converted to relative height by the grating calibration.</p></div></header>
          <div className="coherent-signal-reconstruction-grid">
            <figure className="coherent-signal-figure">
              <CoherenceEnvelopeCanvas result={selectedSurfaceReconstruction.result} />
              <figcaption>Camera 80 W/pixel → DC removal → measured-column correlation · cyan: detected y<sub>peak</sub>(x)</figcaption>
            </figure>
            <figure className="coherent-signal-figure">
              <HeightProfileCanvas result={selectedSurfaceReconstruction.result} />
              <figcaption className="coherent-signal-profile-legend"><span><i className="is-input" />Input Target</span><span><i className="is-recovered" />Reconstructed</span></figcaption>
            </figure>
          </div>
          <div className="coherent-signal-metrics">
            <span>Recovery<strong>Camera column shift → OPD → relative height</strong></span>
            <span>Input P–V<strong>{format(profilePeakToValley(selectedSurfaceReconstruction.result.targetHeightUm), 3)} µm</strong></span>
            <span>Recovered P–V<strong>{format(profilePeakToValley(selectedSurfaceReconstruction.result.recoveredHeightUm), 3)} µm</strong></span>
            {selectedRecoveredStepUm !== null ? <span>Recovered step<strong>{format(selectedRecoveredStepUm, 3)} µm</strong></span> : null}
            <span>Height RMS error<strong>{format(selectedSurfaceReconstruction.result.rmsHeightErrorUm, 4)} µm</strong></span>
            <span>Maximum error<strong>{format(selectedSurfaceReconstruction.result.maxAbsHeightErrorUm, 4)} µm</strong></span>
            <span>Target X sampling<strong>{selectedSurfaceReconstruction.result.width.toLocaleString()} points · ΔX {format(selectedSurfaceReconstruction.result.xSampleIntervalMm, 4)} mm</strong></span>
            {selectedSurfaceReconstruction.result.samplesPerTargetPeriod !== null ? <span>Sin sampling<strong>{format(selectedSurfaceReconstruction.result.samplesPerTargetPeriod, 2)} samples / period</strong></span> : null}
            <span>Depth sampling<strong>{format(selectedSurfaceReconstruction.result.detectorHeightStepUm, 4)} µm / pixel</strong></span>
            <span>Detected spectral modes<strong>{selectedSurfaceReconstruction.result.spectralSampleCount.toLocaleString()}</strong></span>
            <span>Camera ray samples<strong>{selectedSurfaceReconstruction.result.measurementSampleCount?.toLocaleString() ?? '—'} hits</strong></span>
            <span>Camera X coverage<strong>{format(selectedSurfaceReconstruction.result.signalCoverageFraction * 100, 1)}%</strong></span>
            <span>Camera reference<strong>X {format(selectedSurfaceReconstruction.result.cameraReferenceXmm, 4)} mm · column {(selectedSurfaceReconstruction.result.cameraReferenceColumn ?? 0) + 1}</strong></span>
            <span>Ridge confidence<strong>{format(selectedSurfaceReconstruction.result.meanRidgeConfidence * 100, 1)}%</strong></span>
            <span>Route OPD metadata<strong>{format(selectedSurfaceReconstruction.baseOpdMm * 1000, 3)} µm</strong></span>
            <span>Depth zero<strong>Camera reference column = 0 µm</strong></span>
            <span>Calibration range<strong>{format(selectedSurfaceReconstruction.calibrationMinUm, 1)} … {format(selectedSurfaceReconstruction.calibrationMaxUm, 1)} µm</strong></span>
            <span>Spectrum propagated<strong>{format(selectedSurfaceReconstruction.result.propagatingFraction * 100, 2)}%</strong></span>
          </div>
          {selectedSurfaceReconstruction.result.warningMessages
            .filter((warning) => !warning.startsWith('Assembly dimensions') && !warning.includes('mechanical-envelope'))
            .map((warning) => <div className="coherent-signal-warning" key={warning}>{warning}</div>)}
          <div className="coherent-signal-note">This is a Camera-derived relative profile. The configured Target is used only for the gray comparison curve and error figures. Acquire and save a flat Camera 80 reference to establish absolute height.</div>
        </section> : null}

        {selectedDualCombReconstruction ? <section className="coherent-signal-result-card coherent-signal-result-card--wide coherent-signal-reconstruction-card">
          <header><div><h2>Dual-comb surface reconstruction · Camera RF phase</h2><p>The current and flat-reference Camera pixel I/Q fields are differentially demodulated with the same LO. The optical-frequency phase slope gives OPD; reflected-path OPD is converted to relative surface height.</p></div></header>
          <figure className="coherent-signal-figure coherent-signal-dual-comb-profile">
            <HeightProfileCanvas result={selectedDualCombReconstruction.result} />
            <figcaption className="coherent-signal-profile-legend"><span><i className="is-input" />Input Target (comparison only)</span><span><i className="is-recovered" />Camera RF reconstruction</span></figcaption>
          </figure>
          <div className="coherent-signal-metrics">
            <span>Recovery<strong>{selectedDualCombReconstruction.result.reconstructionMethod === 'camera-slope' ? 'Camera X/Y shift + RF phase → calibrated height' : 'Camera RF I/Q → phase slope → OPD → height'}</strong></span>
            <span>Input P–V<strong>{format(profilePeakToValley(selectedDualCombReconstruction.result.targetHeightUm), 3)} µm</strong></span>
            <span>Recovered P–V<strong>{format(profilePeakToValley(selectedDualCombReconstruction.result.recoveredHeightUm), 3)} µm</strong></span>
            <span>Height RMS error<strong>{format(selectedDualCombReconstruction.result.rmsHeightErrorUm, 4)} µm</strong></span>
            <span>Maximum error<strong>{format(selectedDualCombReconstruction.result.maxAbsHeightErrorUm, 4)} µm</strong></span>
            <span>Profile mapping<strong>Target X → Camera {selectedDualCombReconstruction.result.profileAxis.toUpperCase()}</strong></span>
            <span>Camera sampling<strong>{selectedDualCombReconstruction.result.width.toLocaleString()} points</strong></span>
            <span>Camera coverage<strong>{format(selectedDualCombReconstruction.result.coverageFraction * 100, 1)}%</strong></span>
            <span>Matched comb lines<strong>{format(selectedDualCombReconstruction.result.meanLineCount, 1)} / X bin</strong></span>
            <span>Phase-fit RMS<strong>{format(selectedDualCombReconstruction.result.meanPhaseFitRmsRad, 5)} rad</strong></span>
            <span>System-phase calibration<strong>{selectedDualCombReconstruction.result.flatReferenceApplied ? 'Flat Camera RF reference applied' : 'Not applied'}</strong></span>
            <span>Surface calibration<strong>{selectedDualCombReconstruction.result.slopeCalibrationApplied ? `${selectedDualCombReconstruction.result.slopeCalibrationReferenceCount ?? 1} tilt × ${selectedDualCombReconstruction.result.heightCalibrationReferenceCount ?? 0} height references · mean shift ${format(selectedDualCombReconstruction.result.meanCameraShiftPx, 3)} px` : 'Not required / not detected'}</strong></span>
            <span>Maximum RF beat<strong>{format(selectedDualCombReconstruction.result.maximumBeatFrequencyHz / 1e6, 6)} MHz</strong></span>
            <span>Required Camera rate<strong>≥ {format(selectedDualCombReconstruction.result.requiredFrameRateHz / 1e6, 3)} Mfps or pixel I/Q</strong></span>
            <span>Depth zero<strong>X {format(selectedDualCombReconstruction.result.referenceXmm, 4)} mm · column {selectedDualCombReconstruction.result.referenceColumn + 1}</strong></span>
            <span>Measurement route<strong>{selectedDualCombReconstruction.measurementRouteLabel}</strong></span>
            <span>Reference route<strong>{selectedDualCombReconstruction.referenceRouteLabel}</strong></span>
            <span>LO route<strong>{selectedDualCombReconstruction.localOscillatorRouteLabel}</strong></span>
          </div>
          {selectedDualCombReconstruction.result.warningMessages.map((warning) => <div className="coherent-signal-warning" key={warning}>{warning}</div>)}
          <div className="coherent-signal-note">The orange profile is recovered only from the measured and flat-reference Camera RF fields. The configured Target supplies only the gray comparison curve and error figures. A conventional single time-integrated Camera image cannot retain dual-comb RF phase; use a high-speed frame sequence or per-pixel lock-in I/Q acquisition.</div>
        </section> : null}
      </> : <section className="coherent-signal-result-card coherent-signal-result-card--wide">
        <header><div><h2>{selectedEntry?.label ?? 'Time Detector'} · Time signal</h2><p>Fields with the same optical frequency and coherence group interfere; comb-pair differences appear as RF beats.</p></div></header>
        {selectedRawResult?.kind === 'time' && selectedRawResult.timeSignalW?.length ? <>
          <figure className="coherent-signal-figure">
            <TimeSignalCanvas result={selectedRawResult} />
            <figcaption>{selectedRawResult.timeSignalW.length.toLocaleString()} samples · {format((selectedRawResult.timeSeconds.at(-1) ?? 0) * 1e6, 3)} µs</figcaption>
          </figure>
          <div className="coherent-signal-metrics">
            <span>Integrated<strong>{selectedRawResult.integratedPowerW.toExponential(4)} W</strong></span>
            <span>Maximum<strong>{selectedRawResult.maximumWPerPixel.toExponential(4)} W</strong></span>
            <span>Detector hits<strong>{selectedRawResult.hitCount.toLocaleString()}</strong></span>
            <span>RF beats<strong>{selectedRawResult.rfBeats.length.toLocaleString()}</strong></span>
            <span>Strongest beat<strong>{selectedRawResult.rfBeats.length ? `${(selectedRawResult.rfBeats.reduce((best, item) => item.powerW > best.powerW ? item : best).frequencyHz / 1e6).toFixed(6)} MHz` : '—'}</strong></span>
            <span>Energy accounted<strong>{format(accountedEnergy, 2)}%</strong></span>
          </div>
        </> : <div className="coherent-signal-empty">{hasPhysicalSignalPath ? 'No time-domain signal reached this detector.' : 'Connect this detector to the optical assembly.'}</div>}
        {isDualCombDesign ? <div className="coherent-signal-note">A 1 × 1 Time Detector recovers one mean OPD only; it has no spatial pixels from which to reconstruct a surface. For a height profile, use an Area Detector (phase Camera) on the same Route Set and acquire per-pixel RF I/Q or a frame rate above twice the maximum beat frequency.</div> : null}
      </section>}

      {routeMetrics.length > 0 ? <section className="coherent-signal-result-card coherent-signal-result-card--wide">
        <header><div><h2>Optical route results</h2><p>One physical trace supplies Render, Detector signal and optimization metrics.</p></div></header>
        <div className="coherent-signal-metrics">
          {routeMetrics.map((route) => <span key={route.routeId} className={route.valid ? '' : 'coherent-signal-route-invalid'}>
            {route.routeLabel}<strong>{route.valid
              ? `${route.launchedRays.toLocaleString()} launched / ${route.reachedRays.toLocaleString()} hit · OPL ${format(route.oplMm, 4)} mm · Spot ${format(route.spotRmsMm * 1000, 3)} µm · WFE ${format(route.wavefrontRmsUm, 4)} µm · Strehl ${format(route.strehl, 4)} · ${route.receivedPowerW.toExponential(3)} W`
              : `Invalid · ${route.failureReason ?? 'Detector not reached'}`}</strong>
          </span>)}
        </div>
      </section> : null}

      {(branchResult?.warnings ?? []).length ? <section className="coherent-signal-result-card coherent-signal-result-card--wide">
        <header><div><h2>Trace messages</h2></div></header>
        {branchResult!.warnings.map((warning) => <div className="coherent-signal-warning" key={warning}>{warning}</div>)}
      </section> : null}
    </main>
  </div>;
}

export default CoherentSignalPage;
