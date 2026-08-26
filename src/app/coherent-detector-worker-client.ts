import {
  convolveDetectorFieldsWithCoherentPsf,
  type CoherentFieldDetectorSignal,
} from '../../analysis/detector-signal.ts';

type ConvolutionOptions = Parameters<typeof convolveDetectorFieldsWithCoherentPsf>[0];
type AbortLike = {
  readonly aborted: boolean;
  readonly reason: unknown;
  onAbort: (listener: (reason?: unknown) => void) => void;
};

type WorkerResponse = {
  ok: boolean;
  result?: CoherentFieldDetectorSignal | null;
  error?: string;
  progress?: { completedModes: number; totalModes: number };
};

function cancelledError(reason: unknown): Error & { code: string } {
  const error = new Error(String(reason || 'Cancelled')) as Error & { code: string };
  error.code = 'CANCELLED';
  return error;
}

/** Keeps the UI responsive while the coherent PSF is accumulated. */
export function convolveDetectorFieldsInWorker(
  options: ConvolutionOptions,
  token?: AbortLike,
  onProgress?: (completedModes: number, totalModes: number) => void,
): Promise<CoherentFieldDetectorSignal | null> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve(convolveDetectorFieldsWithCoherentPsf(options));
  }
  if (token?.aborted) return Promise.reject(cancelledError(token.reason));

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./coherent-detector-worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      callback();
    };
    token?.onAbort((reason) => finish(() => reject(cancelledError(reason))));
    worker.onerror = (event) => finish(() => reject(new Error(event.message || 'Coherent Detector worker failed.')));
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response?.progress) {
        onProgress?.(response.progress.completedModes, response.progress.totalModes);
        return;
      }
      if (!response?.ok) {
        finish(() => reject(new Error(response?.error || 'Coherent Detector worker failed.')));
        return;
      }
      finish(() => resolve(response.result ?? null));
    };
    worker.postMessage({ options });
  });
}
