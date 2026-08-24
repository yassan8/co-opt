import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  calculateImagingDetectorSignal,
  convolveDetectorFieldsWithCoherentPsf,
  convolveDetectorPowerWithPsf,
  type ImagingDetectorSignal,
} from '../../analysis/detector-signal.ts';
import type { CoherentDetectorSpec } from '../../analysis/coherent-assembly.ts';
import {
  publishNonSequentialTrace,
  runNonSequentialTrace,
  type NonSequentialDetectorResult,
  type NonSequentialTraceResult,
} from '../../analysis/nonsequential-trace.ts';
import {
  readActiveCoherentDesign,
  subscribeActiveCoherentDesign,
  type ActiveCoherentDesignSnapshot,
} from '../../data/coherent-config-store.ts';
import { computeFieldPsf, type FieldPsfComputeResult } from './MultiFieldPsfPage.tsx';
import { createCancelToken, getBestHost, getRows, type CancelToken } from './PsfAnalysisPage.tsx';
import './CoherentSignalPage.css';

const finite = (value: unknown, fallback = 0): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const format = (value: unknown, digits = 3): string => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';

type DisplayQuantity = 'adu' | 'electrons' | 'power';
type AreaResult = {
  signal: ImagingDetectorSignal;
  propagation: 'coherent-field' | 'intensity-fallback';
  spectralModeCount: number;
  complexKernelCount: number;
  warning: string;
};

function detectorId(detector: CoherentDetectorSpec, index: number): string {
  return String(detector.id ?? detector.componentId ?? `detector-${index + 1}`);
}

function ImagingSignalCanvas({ signal, quantity, logScale }: { signal: ImagingDetectorSignal; quantity: DisplayQuantity; logScale: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = signal.width;
    canvas.height = signal.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const image = context.createImageData(signal.width, signal.height);
    const values = quantity === 'adu' ? signal.aduPerPixel : quantity === 'electrons' ? signal.electronsPerPixel : signal.powerWPerPixel;
    let maximum = 0;
    for (const value of values) maximum = Math.max(maximum, Number(value) || 0);
    maximum = Math.max(maximum, 1e-30);
    for (let index = 0; index < values.length; index += 1) {
      const linear = Math.max(0, Number(values[index]) || 0) / maximum;
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
  const [psf, setPsf] = useState<FieldPsfComputeResult | null>(null);
  const [referenceSignals, setReferenceSignals] = useState<Record<string, ImagingDetectorSignal>>({});
  const [branchResult, setBranchResult] = useState<NonSequentialTraceResult | null>(null);
  const [areaResults, setAreaResults] = useState<Record<string, AreaResult>>({});
  const [status, setStatus] = useState('Ready');
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
    (component.kind === 'detector' || component.kind === 'time-detector') && component.metadata?.source === 'blocks'
  )).length;

  useEffect(() => subscribeActiveCoherentDesign((next) => {
    runToken.current += 1;
    cancelRef.current?.abort('Config changed');
    setSnapshot(next);
    setBranchResult(null);
    setAreaResults({});
    setReferenceSignals({});
    setStatus('Config updated · recalculating…');
  }), []);

  const run = useCallback(async (quality: 'preview' | 'full') => {
    const tokenId = ++runToken.current;
    cancelRef.current?.abort('Superseded');
    const cancel = createCancelToken();
    cancelRef.current = cancel;
    setError('');
    setStatus(quality === 'preview' ? 'Previewing exact lens…' : 'Tracing assembly and exact lens…');
    try {
      const host = getBestHost();
      const opticalRows = getRows(host, 'optical');
      const objectRows = getRows(host, 'object');
      const sourceRows = getRows(host, 'source');
      if (!opticalRows.length) throw new Error('No exact sequential optical surfaces are available.');
      if (!objectRows.length) throw new Error('No field/object definition is available.');
      const activeObjectIndex = Math.max(0, Math.min(objectRows.length - 1, objectIndex));

      let nextBranch: NonSequentialTraceResult | null = null;
      if (hasPhysicalSignalPath) {
        nextBranch = await runNonSequentialTrace(design, quality);
        if (tokenId !== runToken.current || cancel.aborted) return;
        setBranchResult(nextBranch);
        publishNonSequentialTrace(nextBranch, design);
      } else {
        setBranchResult(null);
      }

      const nextPsf = await computeFieldPsf({
        host,
        opticalRows,
        sourceRows,
        fieldObjectRow: { ...objectRows[activeObjectIndex] },
        wavelengthValue: 'all',
        samplingSize: quality === 'preview' ? Math.min(32, samplingSize) : samplingSize,
        zeroPad: quality === 'preview' ? 'none' : 'auto',
        colorMode: 'true',
        opdMode: 'raw',
        logScale: false,
        includeComplexField: true,
        token: cancel,
        onProgress: (percent, message) => {
          if (tokenId === runToken.current) setStatus(`${message} · ${Math.min(99, Math.round(percent))}%`);
        },
      });
      if (tokenId !== runToken.current || cancel.aborted) return;

      const totalSourcePowerW = (design.sources?.length ? design.sources : [design.source])
        .reduce((sum, source) => sum + Math.max(0, finite(source.totalPowerW)), 0);
      const nextReferenceSignals: Record<string, ImagingDetectorSignal> = {};
      for (const entry of detectorEntries) {
        if (entry.detector.kind === 'time') continue;
        nextReferenceSignals[entry.id] = calculateImagingDetectorSignal({
          spectralPsf: nextPsf.spectralComponents,
          detector: entry.detector,
          totalPowerW: totalSourcePowerW,
          opticalThroughput: 1,
        });
      }

      const nextAreaResults: Record<string, AreaResult> = {};
      for (const detectorResult of nextBranch?.detectors ?? []) {
        if (detectorResult.kind === 'time') continue;
        const spec = detectorEntries.find((entry) => entry.id === detectorResult.detectorId)?.detector;
        if (!spec) continue;
        const coherent = convolveDetectorFieldsWithCoherentPsf({
          spectralFields: detectorResult.spectralFields ?? [],
          width: detectorResult.width,
          height: detectorResult.height,
          detector: spec,
          spectralPsf: nextPsf.spectralComponents,
        });
        if (coherent) {
          nextAreaResults[detectorResult.detectorId] = {
            signal: coherent.signal,
            propagation: 'coherent-field',
            spectralModeCount: coherent.spectralModeCount,
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
            psfData: nextPsf.psfData,
            psfPixelSizeUm: nextPsf.pixelSizeUm,
            wavelengthNm,
          }),
          propagation: 'intensity-fallback',
          spectralModeCount: 0,
          complexKernelCount: 0,
          warning: 'This field uses an intensity PSF fallback because the exact-lens complex field was unavailable.',
        };
      }

      setPsf(nextPsf);
      setReferenceSignals(nextReferenceSignals);
      setAreaResults(nextAreaResults);
      const detectorHits = (nextBranch?.detectors ?? []).reduce((sum, entry) => sum + entry.hitCount, 0);
      setStatus(`${quality === 'preview' ? 'Preview' : 'Done'} · ${detectorEntries.length} detector${detectorEntries.length === 1 ? '' : 's'} · ${detectorHits.toLocaleString()} hits · ${nextPsf.wavelengthCount} exact-lens wavelength${nextPsf.wavelengthCount === 1 ? '' : 's'}`);
    } catch (caught: any) {
      if (cancel.aborted || caught?.code === 'CANCELLED') return;
      if (tokenId !== runToken.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus('Calculation failed');
    }
  }, [design, detectorEntries, hasPhysicalSignalPath, objectIndex, samplingSize]);

  useEffect(() => {
    const preview = window.setTimeout(() => void run('preview'), 180);
    const full = window.setTimeout(() => void run('full'), 1400);
    return () => { window.clearTimeout(preview); window.clearTimeout(full); };
  }, [run]);

  useEffect(() => () => cancelRef.current?.abort('Window closed'), []);

  const host = getBestHost();
  const objectRows = getRows(host, 'object');
  const selectedEntry = detectorEntries.find((entry) => entry.id === selectedDetectorId) ?? detectorEntries[0];
  const selectedRawResult = branchResult?.detectors.find((entry) => entry.detectorId === selectedEntry?.id);
  const selectedAreaResult = selectedEntry ? areaResults[selectedEntry.id] : undefined;
  const selectedReference = selectedEntry ? referenceSignals[selectedEntry.id] : undefined;
  const physicalDetectorConnected = selectedEntry
    ? connectedComponentIds.has(selectedEntry.detector.componentId ?? selectedEntry.id)
    : false;
  const accountedEnergy = branchResult
    ? (branchResult.energy.detectedRayPowerW + branchResult.energy.escapedPowerW + branchResult.energy.absorbedPowerW + branchResult.energy.truncatedPowerW)
      / Math.max(branchResult.energy.emittedPowerW, 1e-30) * 100
    : 0;

  return <div className="analysis-window-page coherent-signal-page">
    <header className="analysis-window-commandbar coherent-signal-commandbar">
      <div className="coherent-signal-identity">
        <div className="coherent-signal-title"><strong>Coherent Signal</strong><span>{snapshot.configName}</span></div>
      </div>
      <div className="coherent-signal-controls" role="group" aria-label="Signal display controls">
        <label className="window-inline-field coherent-signal-control coherent-signal-control--field">
          <span>Field</span>
          <select value={objectIndex} onChange={(event) => setObjectIndex(Number(event.target.value))}>
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
          <span>Pupil sampling</span>
          <select value={samplingSize} onChange={(event) => setSamplingSize(Number(event.target.value))}>
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
      <div className="coherent-signal-status" aria-live="polite"><span>Status</span><strong>{status}</strong></div>
    </section>

    {error ? <div className="analysis-window-error coherent-signal-error">{error}</div> : null}
    {physicalDetectorCount === 0 ? <div className="coherent-signal-warning coherent-signal-page-warning">Add an Area Detector or Time Detector in Design Intents, then connect it to the assembly.</div> : null}
    {selectedEntry && !physicalDetectorConnected ? <div className="coherent-signal-warning coherent-signal-page-warning">{selectedEntry.label} is not connected, so it cannot receive assembly rays.</div> : null}
    {detectorEntries.length > 1 ? <div className="coherent-signal-note">All detectors are calculated in one run. Choose a detector above to inspect it. A detector absorbs the first ray that reaches its active surface; a detector directly behind it will not receive that ray.</div> : null}

    <main className="coherent-signal-results-grid">
      {selectedEntry?.detector.kind !== 'time' ? <>
        <section className="coherent-signal-result-card coherent-signal-result-card--primary">
          <header><div><h2>{selectedEntry?.label ?? 'Detector'} · Physical signal</h2><p>Assembly amplitude and phase pass through the exact sequential-lens complex PSF before detector conversion.</p></div></header>
          {selectedAreaResult && selectedRawResult ? <>
            <figure className="coherent-signal-figure">
              <ImagingSignalCanvas signal={selectedAreaResult.signal} quantity={quantity} logScale={logScale} />
              <figcaption>{quantity === 'adu' ? 'ADU' : quantity === 'electrons' ? 'Electrons / pixel' : 'W / pixel'} · {logScale ? 'Log' : 'Linear'} · {selectedAreaResult.signal.width} × {selectedAreaResult.signal.height} pixels</figcaption>
            </figure>
            <div className="coherent-signal-metrics">
              <span>Propagation<strong>{selectedAreaResult.propagation === 'coherent-field' ? 'Complex field + exact lens' : 'Intensity fallback'}</strong></span>
              <span>Detected<strong>{selectedAreaResult.signal.integratedPowerW.toExponential(4)} W</strong></span>
              <span>Maximum<strong>{selectedAreaResult.signal.maximumPowerWPerPixel.toExponential(4)} W/pixel</strong></span>
              <span>Peak charge<strong>{selectedAreaResult.signal.maximumElectronsPerPixel.toExponential(4)} e⁻</strong></span>
              <span>Saturated<strong>{selectedAreaResult.signal.saturatedPixelCount.toLocaleString()} px</strong></span>
              <span>Detector hits<strong>{selectedRawResult.hitCount.toLocaleString()}</strong></span>
              <span>Coherent modes<strong>{selectedAreaResult.spectralModeCount.toLocaleString()}</strong></span>
              <span>Lens wavelengths<strong>{selectedAreaResult.complexKernelCount.toLocaleString()}</strong></span>
              <span>Energy accounted<strong>{format(accountedEnergy, 2)}%</strong></span>
            </div>
            {selectedAreaResult.warning ? <div className="coherent-signal-warning">{selectedAreaResult.warning}</div> : null}
          </> : <div className="coherent-signal-empty">{hasPhysicalSignalPath ? 'No rays reached this detector.' : 'Connect this detector to the optical assembly.'}</div>}
        </section>

        <section className="coherent-signal-result-card">
          <header><div><h2>Exact lens reference</h2><p>Sequential lens PSF on the selected detector without Beam Splitter, grating, target or path loss.</p></div></header>
          {selectedReference ? <>
            <figure className="coherent-signal-figure">
              <ImagingSignalCanvas signal={selectedReference} quantity={quantity} logScale={logScale} />
              <figcaption>Reference only · {selectedReference.width} × {selectedReference.height} pixels</figcaption>
            </figure>
            <div className="coherent-signal-metrics">
              <span>Input on detector<strong>{selectedReference.integratedPowerW.toExponential(4)} W</strong></span>
              <span>Captured<strong>{format(selectedReference.capturedFraction * 100, 2)}%</strong></span>
              <span>Strehl<strong>{format(psf?.metrics?.strehlRatio, 4)}</strong></span>
              <span>OPD RMS<strong>{format(psf?.metrics?.opdRmsUm, 4)} µm</strong></span>
              <span>PSF sample<strong>{format(psf?.pixelSizeUm, 4)} µm</strong></span>
            </div>
          </> : <div className="coherent-signal-empty">Waiting for the exact sequential PSF.</div>}
        </section>
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
      </section>}

      {(branchResult?.warnings ?? []).length ? <section className="coherent-signal-result-card coherent-signal-result-card--wide">
        <header><div><h2>Trace messages</h2></div></header>
        {branchResult!.warnings.map((warning) => <div className="coherent-signal-warning" key={warning}>{warning}</div>)}
      </section> : null}
    </main>
  </div>;
}

export default CoherentSignalPage;
