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

type IndexedMtfJob = {
  job: any;
  originalIndex: number;
};

/**
 * A tolerance batch is allowed to contain an optically invalid perturbation.
 * The Rust batch API fails fast when one job has no valid pupil samples, so
 * recursively isolate that job instead of rejecting every otherwise valid
 * candidate in the Worker message.
 */
async function runMtfBatchResilient(request: any): Promise<any> {
  const jobs = Array.isArray(request?.jobs) ? request.jobs : [];
  const indexedJobs: IndexedMtfJob[] = jobs.map((job: any, originalIndex: number) => ({
    job,
    originalIndex,
  }));

  const runSubset = async (subset: IndexedMtfJob[]): Promise<any[]> => {
    if (subset.length === 0) return [];
    try {
      const batchResponse = await runMtfBatchViaWasmInWorker({
        ...request,
        jobs: subset.map((entry) => entry.job),
      });
      const batchResults = Array.isArray(batchResponse?.results) ? batchResponse.results : [];
      return batchResults.map((result: any, localIndex: number) => {
        const reportedIndex = Number(result?.jobIndex);
        const resolvedLocalIndex = Number.isInteger(reportedIndex)
          && reportedIndex >= 0
          && reportedIndex < subset.length
          ? reportedIndex
          : localIndex;
        const source = subset[resolvedLocalIndex] ?? subset[localIndex];
        return {
          ...result,
          jobIndex: source?.originalIndex ?? localIndex,
          meta: result?.meta ?? source?.job?.meta,
        };
      });
    } catch (error) {
      if (subset.length > 1) {
        const middle = Math.ceil(subset.length / 2);
        const [left, right] = await Promise.all([
          runSubset(subset.slice(0, middle)),
          runSubset(subset.slice(middle)),
        ]);
        return [...left, ...right];
      }
      const failed = subset[0];
      return [{
        jobIndex: failed.originalIndex,
        meta: failed.job?.meta,
        error: String(error instanceof Error ? error.message : error),
      }];
    }
  };

  const results = await runSubset(indexedJobs);
  return {
    backend: "web-rust-wasm-opd-psf-mtf-worker-resilient",
    results,
    failedJobs: results.filter((result: any) => typeof result?.error === "string").length,
  };
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
        const batchResponse = await runMtfBatchResilient({
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
        failedJobs: results.filter((result: any) => typeof result?.error === "string").length,
      };
    } else {
      response = await runMtfBatchResilient(request);
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
