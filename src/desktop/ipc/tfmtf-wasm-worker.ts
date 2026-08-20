// Keep Worker results numerically identical to the main-thread batch route.
// In particular this preserves the wavelength-index enrichment and Image
// Height object normalization performed before Rust/WASM receives a batch.
// `client.ts` also imports legacy ray-tracing helpers which register debug
// callbacks on `window`.  A module Worker has `self` but no `window`; install
// the standard alias before lazily importing that shared evaluator.
const workerGlobal = globalThis as any;
if (typeof workerGlobal.window === "undefined") workerGlobal.window = workerGlobal;

let runMtfBatchViaWasmPromise: Promise<(request: any) => Promise<any>> | null = null;
async function runMtfBatchViaWasmInWorker(request: any): Promise<any> {
  if (!runMtfBatchViaWasmPromise) {
    runMtfBatchViaWasmPromise = import("./client.ts")
      .then(({ runMtfBatchViaWasm }) => runMtfBatchViaWasm);
  }
  const runMtfBatchViaWasm = await runMtfBatchViaWasmPromise;
  return runMtfBatchViaWasm(request);
}

type WorkerRequest = {
  requestId: string;
  request: {
    jobs?: unknown[];
    shared?: unknown;
    optimizerSharedMtfBatches?: Array<{
      shared?: unknown;
      jobs?: unknown[];
      jobIndexes?: number[];
    }>;
  };
};

type WorkerResponse = {
  requestId: string;
  ok: boolean;
  response?: unknown;
  error?: string;
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { requestId, request } = event.data || {};
  try {
    const sharedBatches = Array.isArray(request?.optimizerSharedMtfBatches)
      ? request.optimizerSharedMtfBatches
      : null;
    let response: any;
    if (sharedBatches && sharedBatches.length > 0) {
      const results: any[] = [];
      // One candidate/wavelength context is one Rust batch. This preserves
      // per-wavelength refractive indices while removing repeated lens rows
      // from both the worker message and the JS→WASM JSON payload.
      for (const sharedBatch of sharedBatches) {
        const batchResponse = await runMtfBatchViaWasmInWorker({
          shared: sharedBatch?.shared,
          jobs: Array.isArray(sharedBatch?.jobs) ? sharedBatch.jobs : [],
        });
        const batchResults = Array.isArray(batchResponse?.results) ? batchResponse.results : [];
        const jobIndexes = Array.isArray(sharedBatch?.jobIndexes) ? sharedBatch.jobIndexes : [];
        for (let index = 0; index < batchResults.length; index += 1) {
          const result = batchResults[index];
          results.push({
            ...result,
            jobIndex: Number.isInteger(Number(jobIndexes[index])) ? Number(jobIndexes[index]) : result?.jobIndex,
          });
        }
      }
      response = {
        backend: "web-rust-wasm-opd-psf-mtf-worker-shared-batches",
        results,
        sharedBatchCount: sharedBatches.length,
      };
    } else {
      response = await runMtfBatchViaWasmInWorker(request);
    }
    const message: WorkerResponse = { requestId, ok: true, response };
    self.postMessage(message);
  } catch (error) {
    const message: WorkerResponse = {
      requestId,
      ok: false,
      error: String(error instanceof Error ? error.message : error),
    };
    self.postMessage(message);
  }
};

export {};
