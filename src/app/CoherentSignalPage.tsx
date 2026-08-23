import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { calculateImagingDetectorSignal, convolveDetectorPowerWithPsf, type ImagingDetectorSignal } from '../../analysis/detector-signal.ts';
import { publishNonSequentialTrace, runNonSequentialTrace, type NonSequentialTraceResult } from '../../analysis/nonsequential-trace.ts';
import { readActiveCoherentDesign, subscribeActiveCoherentDesign, type ActiveCoherentDesignSnapshot } from '../../data/coherent-config-store.ts';
import { computeFieldPsf, type FieldPsfComputeResult } from './MultiFieldPsfPage.tsx';
import { createCancelToken, getBestHost, getRows, type CancelToken } from './PsfAnalysisPage.tsx';
import './CoherentSignalPage.css';

const finite = (value: unknown, fallback = 0): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const format = (value: unknown, digits = 3): string => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';

type DisplayQuantity = 'adu' | 'electrons' | 'power';

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
  return <canvas ref={ref} className="coherent-signal-heatmap" aria-label={`Exact lens ${quantity} detector signal`} />;
}

export function CoherentSignalPage() {
  const [snapshot, setSnapshot] = useState<ActiveCoherentDesignSnapshot>(() => readActiveCoherentDesign());
  const [objectIndex, setObjectIndex] = useState(0);
  const [samplingSize, setSamplingSize] = useState(64);
  const [quantity, setQuantity] = useState<DisplayQuantity>('adu');
  const [logScale, setLogScale] = useState(false);
  const [psf, setPsf] = useState<FieldPsfComputeResult | null>(null);
  const [imagingSignal, setImagingSignal] = useState<ImagingDetectorSignal | null>(null);
  const [branchResult, setBranchResult] = useState<NonSequentialTraceResult | null>(null);
  const [hybridBranchSignal, setHybridBranchSignal] = useState<ImagingDetectorSignal | null>(null);
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState('');
  const runToken = useRef(0);
  const cancelRef = useRef<CancelToken | null>(null);
  const design = snapshot.design;
  const connectedComponentIds = useMemo(() => new Set(
    design.connections.flatMap((connection) => [connection.fromComponentId, connection.toComponentId]),
  ), [design.connections]);
  const connectedPathCount = useMemo(() => new Set(
    design.connections.map((connection) => connection.pathId || 'main'),
  ).size, [design.connections]);
  const hasPhysicalSignalPath = design.connections.length > 0;
  const hasConnectedSplitter = design.components.some((component) => (
    component.kind === 'beam-splitter' && connectedComponentIds.has(component.id)
  ));
  const hasAreaDetectorBlock = design.components.some((component) => component.kind === 'detector' && component.metadata?.source === 'blocks');

  useEffect(() => subscribeActiveCoherentDesign((next) => {
    runToken.current += 1;
    cancelRef.current?.abort('Config changed');
    setSnapshot(next);
    setBranchResult(null);
    setHybridBranchSignal(null);
    setStatus('Config updated · recalculating…');
  }), []);

  const run = useCallback(async (quality: 'preview' | 'full') => {
    const tokenId = ++runToken.current;
    cancelRef.current?.abort('Superseded');
    const cancel = createCancelToken();
    cancelRef.current = cancel;
    setError('');
    setStatus(quality === 'preview' ? 'Exact lens preview…' : 'Exact lens + Hybrid Assembly…');
    try {
      const host = getBestHost();
      const opticalRows = getRows(host, 'optical');
      const objectRows = getRows(host, 'object');
      const sourceRows = getRows(host, 'source');
      if (!opticalRows.length) throw new Error('No exact sequential optical surfaces are available.');
      if (!objectRows.length) throw new Error('No field/object definition is available.');
      const activeObjectIndex = Math.max(0, Math.min(objectRows.length - 1, objectIndex));
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
        token: cancel,
        onProgress: (percent, message) => {
          if (tokenId === runToken.current) setStatus(`${message} · ${Math.min(99, Math.round(percent))}%`);
        },
      });
      if (tokenId !== runToken.current || cancel.aborted) return;
      // The first result is the exact sequential-lens baseline. Physical
      // assembly losses are applied only by the connected Hybrid trace below.
      const throughput = 1;
      const nextSignal = calculateImagingDetectorSignal({
        spectralPsf: nextPsf.spectralComponents,
        detector: design.detector,
        totalPowerW: design.source.totalPowerW,
        opticalThroughput: throughput,
      });
      setPsf(nextPsf);
      setImagingSignal(nextSignal);

      let nextBranch: NonSequentialTraceResult | null = null;
      if (hasPhysicalSignalPath && design.connections.length > 0) {
        nextBranch = await runNonSequentialTrace(design, quality);
        if (tokenId !== runToken.current || cancel.aborted) return;
        setBranchResult(nextBranch);
        const physicalDetector = nextBranch.detectors.find((entry) => entry.kind !== 'time');
        setHybridBranchSignal(physicalDetector ? convolveDetectorPowerWithPsf({
          powerWPerPixel: physicalDetector.intensityWPerPixel,
          width: physicalDetector.width,
          height: physicalDetector.height,
          detector: design.detector,
          psfData: nextPsf.psfData,
          psfPixelSizeUm: nextPsf.pixelSizeUm,
          wavelengthNm: design.source.centerWavelengthNm,
        }) : null);
        publishNonSequentialTrace(nextBranch, design);
      } else {
        setBranchResult(null);
        setHybridBranchSignal(null);
      }
      setStatus(`${quality === 'preview' ? 'Preview' : 'Done'} · exact ${nextPsf.backend} PSF · ${nextPsf.wavelengthCount} wavelength${nextPsf.wavelengthCount === 1 ? '' : 's'}${nextBranch ? ` · ${nextBranch.generatedRayCount.toLocaleString()} branch rays` : ''}`);
    } catch (caught: any) {
      if (cancel.aborted || caught?.code === 'CANCELLED') return;
      if (tokenId !== runToken.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus('Calculation failed');
    }
  }, [design, hasPhysicalSignalPath, objectIndex, samplingSize]);

  useEffect(() => {
    const preview = window.setTimeout(() => void run('preview'), 180);
    const full = window.setTimeout(() => void run('full'), 1400);
    return () => { window.clearTimeout(preview); window.clearTimeout(full); };
  }, [run]);

  useEffect(() => () => cancelRef.current?.abort('Window closed'), []);

  const host = getBestHost();
  const objectRows = getRows(host, 'object');
  const branchDetector = branchResult?.detectors.find((entry) => entry.kind !== 'time');

  return <div className="analysis-window-page coherent-signal-page">
    <header className="analysis-window-commandbar coherent-signal-commandbar">
      <div className="coherent-signal-identity">
        <div className="coherent-signal-title"><strong>Detector Signal</strong><span>{snapshot.configName}</span></div>
      </div>
      <div className="coherent-signal-controls" role="group" aria-label="Signal display controls">
        <label className="window-inline-field coherent-signal-control coherent-signal-control--field">
          <span>Field</span>
          <select value={objectIndex} onChange={(event) => setObjectIndex(Number(event.target.value))}>
            {objectRows.map((row, index) => <option key={index} value={index}>{index + 1}: X {row.xHeightAngle ?? row.x ?? 0}, Y {row.yHeightAngle ?? row.y ?? 0}</option>)}
          </select>
        </label>
        <label className="window-inline-field coherent-signal-control">
          <span>Pupil sampling</span>
          <select value={samplingSize} onChange={(event) => setSamplingSize(Number(event.target.value))}>
            <option value={32}>32 × 32</option><option value={64}>64 × 64</option><option value={128}>128 × 128</option><option value={256}>256 × 256</option>
          </select>
        </label>
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
        <button className="analysis-window-primary-action" type="button" onClick={() => void run('full')}>Run</button>
      </div>
    </header>

    <section className="coherent-signal-overview" aria-label="Current signal model">
      <div><span>Lens</span><strong>Exact surfaces</strong></div>
      <div><span>Detector</span><strong>{design.detector.pixelCountX} × {design.detector.pixelCountY} · {format(design.detector.pixelPitchUm, 3)} µm</strong></div>
      <div><span>Physical signal</span><strong>{design.connections.length > 0 ? `${connectedPathCount} path · ${design.connections.length} connection${design.connections.length === 1 ? '' : 's'}` : 'Not connected'}</strong></div>
      <div><span>Beam splitter</span><strong>{hasConnectedSplitter ? `${design.beamSplitter.model === 'ideal' || !design.beamSplitter.model ? 'Ideal' : design.beamSplitter.model} · R ${format(design.beamSplitter.reflectance * 100, 1)}% / T ${format(design.beamSplitter.transmittance * 100, 1)}%` : 'Not in signal path'}</strong></div>
      <div className="coherent-signal-status" aria-live="polite"><span>Status</span><strong>{status}</strong></div>
    </section>

    {error ? <div className="analysis-window-error coherent-signal-error">{error}</div> : null}
    {!hasAreaDetectorBlock ? <div className="coherent-signal-warning coherent-signal-page-warning">No Area Detector block is present. Add an Area Detector in Design Intents to define the real sensor; until then the image-surface defaults are used.</div> : null}

    <main className="coherent-signal-results-grid">
      <section className="coherent-signal-result-card">
        <header><div><h2>Designed lens → Detector</h2><p>Exact curvature, thickness, glass, asphere/Qcon/Toric, stop, decenter and vignetting.</p></div></header>
        {imagingSignal ? <>
          <figure className="coherent-signal-figure">
            <ImagingSignalCanvas signal={imagingSignal} quantity={quantity} logScale={logScale} />
            <figcaption>{quantity === 'adu' ? 'ADU' : quantity === 'electrons' ? 'Electrons / pixel' : 'W / pixel'} · {logScale ? 'Log' : 'Linear'} · {imagingSignal.width} × {imagingSignal.height} pixels</figcaption>
          </figure>
          <div className="coherent-signal-metrics">
            <span>Integrated<strong>{imagingSignal.integratedPowerW.toExponential(4)} W</strong></span>
            <span>Maximum<strong>{imagingSignal.maximumPowerWPerPixel.toExponential(4)} W/pixel</strong></span>
            <span>Peak charge<strong>{imagingSignal.maximumElectronsPerPixel.toExponential(4)} e⁻</strong></span>
            <span>Captured<strong>{format(imagingSignal.capturedFraction * 100, 2)}%</strong></span>
            <span>Saturated<strong>{imagingSignal.saturatedPixelCount.toLocaleString()} px</strong></span>
            <span>Strehl<strong>{format(psf?.metrics?.strehlRatio, 4)}</strong></span>
            <span>OPD RMS<strong>{format(psf?.metrics?.opdRmsUm, 4)} µm</strong></span>
            <span>PSF sample<strong>{format(psf?.pixelSizeUm, 4)} µm</strong></span>
          </div>
        </> : <div className="coherent-signal-empty">Waiting for the exact sequential PSF.</div>}
      </section>

      {branchResult && branchDetector && hybridBranchSignal ? <section className="coherent-signal-result-card">
        <header><div><h2>Physical path × designed lens</h2><p>Beam splitter, grating, target and detector intersections filtered by the exact designed-lens PSF.</p></div></header>
        <figure className="coherent-signal-figure">
          <ImagingSignalCanvas signal={hybridBranchSignal} quantity={quantity} logScale={logScale} />
          <figcaption>{quantity === 'adu' ? 'ADU' : quantity === 'electrons' ? 'Electrons / pixel' : 'W / pixel'} · {logScale ? 'Log' : 'Linear'} · {hybridBranchSignal.width} × {hybridBranchSignal.height} pixels</figcaption>
        </figure>
        <div className="coherent-signal-metrics">
          <span>Detected<strong>{hybridBranchSignal.integratedPowerW.toExponential(4)} W</strong></span>
          <span>Maximum<strong>{hybridBranchSignal.maximumPowerWPerPixel.toExponential(4)} W/pixel</strong></span>
          <span>Peak charge<strong>{hybridBranchSignal.maximumElectronsPerPixel.toExponential(4)} e⁻</strong></span>
          <span>Captured after PSF<strong>{format(hybridBranchSignal.capturedFraction * 100, 2)}%</strong></span>
          <span>Saturated<strong>{hybridBranchSignal.saturatedPixelCount.toLocaleString()} px</strong></span>
          <span>Detector hits<strong>{branchDetector.hitCount.toLocaleString()}</strong></span>
          <span>Branch rays<strong>{branchResult.generatedRayCount.toLocaleString()}</strong></span>
          <span>Energy accounted<strong>{format((branchResult.energy.detectedRayPowerW + branchResult.energy.escapedPowerW + branchResult.energy.absorbedPowerW + branchResult.energy.truncatedPowerW) / Math.max(branchResult.energy.emittedPowerW, 1e-30) * 100, 2)}%</strong></span>
        </div>
        {branchResult.warnings.map((warning) => <div className="coherent-signal-warning" key={warning}>{warning}</div>)}
      </section> : null}


    </main>
  </div>;
}

export default CoherentSignalPage;