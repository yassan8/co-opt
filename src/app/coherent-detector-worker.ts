import {
  convolveDetectorFieldsWithCoherentPsf,
  type CoherentFieldDetectorSignal,
} from '../../analysis/detector-signal.ts';

type WorkerRequest = {
  options: Parameters<typeof convolveDetectorFieldsWithCoherentPsf>[0];
};

type WorkerResponse = {
  ok: boolean;
  result?: CoherentFieldDetectorSignal | null;
  error?: string;
  progress?: { completedModes: number; totalModes: number };
};

function modeKey(sample: WorkerRequest['options']['spectralFields'][number]): string {
  return `${sample.coherenceGroupId || 'source'}:${sample.frequencyHz.toPrecision(15)}`;
}

function convolveMemoryBounded(options: WorkerRequest['options']): CoherentFieldDetectorSignal | null {
  const pixelCount = Math.max(1, Math.round(options.width)) * Math.max(1, Math.round(options.height));
  const grouped = new Map<string, typeof options.spectralFields>();
  for (const sample of options.spectralFields) {
    const key = modeKey(sample);
    const samples = grouped.get(key) ?? [];
    samples.push(sample);
    grouped.set(key, samples);
  }
  const modeGroups = Array.from(grouped.values());
  // Small calculations are faster in one pass. Large broadband Cameras are
  // split by optical-frequency mode so complex route maps from earlier modes
  // can be released before the next modes are constructed.
  if (pixelCount < 1_000_000 || modeGroups.length <= 8) {
    return convolveDetectorFieldsWithCoherentPsf(options);
  }

  const width = Math.max(1, Math.round(options.width));
  const height = Math.max(1, Math.round(options.height));
  const powerWPerPixel = new Float64Array(pixelCount);
  const electronsPerPixel = new Float64Array(pixelCount);
  let inputFieldPowerW = 0;
  let spectralModeCount = 0;
  let interferingModeCount = 0;
  let complexKernelCount = 0;
  const warnings = new Set<string>();
  const batchSize = 4;

  for (let start = 0; start < modeGroups.length; start += batchSize) {
    const batchSamples = modeGroups.slice(start, start + batchSize).flat();
    const partial = convolveDetectorFieldsWithCoherentPsf({ ...options, spectralFields: batchSamples });
    if (partial) {
      for (let index = 0; index < pixelCount; index += 1) {
        powerWPerPixel[index] += partial.signal.powerWPerPixel[index] ?? 0;
        electronsPerPixel[index] += partial.signal.electronsPerPixel[index] ?? 0;
      }
      inputFieldPowerW += partial.inputFieldPowerW;
      spectralModeCount += partial.spectralModeCount;
      interferingModeCount += partial.interferingModeCount;
      complexKernelCount = Math.max(complexKernelCount, partial.complexKernelCount);
      if (partial.warning) warnings.add(partial.warning);
    }
    self.postMessage({
      ok: true,
      progress: {
        completedModes: Math.min(modeGroups.length, start + batchSize),
        totalModes: modeGroups.length,
      },
    } satisfies WorkerResponse);
  }

  if (spectralModeCount === 0) return null;
  const bitDepth = Math.max(1, Math.min(30, Math.round(Number(options.detector.bitDepth) || 16)));
  const maximumAdu = 2 ** bitDepth - 1;
  const fullWellCandidate = Number(options.detector.saturationElectrons);
  const fullWell = Number.isFinite(fullWellCandidate) && fullWellCandidate > 0
    ? fullWellCandidate
    : Number.POSITIVE_INFINITY;
  const aduPerPixel = new Uint32Array(pixelCount);
  let integratedPowerW = 0;
  let maximumPowerWPerPixel = 0;
  let maximumElectronsPerPixel = 0;
  let saturatedPixelCount = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const power = powerWPerPixel[index];
    const electrons = electronsPerPixel[index];
    integratedPowerW += power;
    maximumPowerWPerPixel = Math.max(maximumPowerWPerPixel, power);
    maximumElectronsPerPixel = Math.max(maximumElectronsPerPixel, electrons);
    if (electrons >= fullWell) saturatedPixelCount += 1;
    aduPerPixel[index] = Number.isFinite(fullWell)
      ? Math.round(Math.max(0, Math.min(1, electrons / fullWell)) * maximumAdu)
      : 0;
  }
  warnings.add(`Accumulated ${spectralModeCount} spectral modes in memory-bounded batches.`);
  return {
    signal: {
      kind: 'area', width, height, powerWPerPixel, electronsPerPixel, aduPerPixel,
      integratedPowerW, maximumPowerWPerPixel, maximumElectronsPerPixel,
      capturedFraction: inputFieldPowerW > 0 ? Math.max(0, Math.min(1, integratedPowerW / inputFieldPowerW)) : 0,
      saturatedPixelCount, bitDepth,
      exposureTimeS: Math.max(0, Number(options.detector.exposureTimeS) || 0),
    },
    spectralModeCount,
    interferingModeCount,
    inputFieldPowerW,
    complexKernelCount,
    warning: Array.from(warnings).join(' '),
  };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  try {
    const result = convolveMemoryBounded(event.data.options);
    const response: WorkerResponse = { ok: true, result };
    const transfers = result ? [
      result.signal.powerWPerPixel.buffer,
      result.signal.electronsPerPixel.buffer,
      result.signal.aduPerPixel.buffer,
    ] : [];
    self.postMessage(response, { transfer: transfers });
  } catch (error) {
    const response: WorkerResponse = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
