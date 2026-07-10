import { preloadRustRayTracingWasm } from "../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts";

type WorkerRequest = {
  requestId: string;
  request: {
    jobs: unknown[];
    shared?: unknown;
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
    const api = await preloadRustRayTracingWasm();
    const batchFn = (api as any)?.run_native_opd_psf_mtf_batch_wasm_json;
    if (typeof batchFn !== "function") {
      throw new Error("TF-MTF WASM batch export is unavailable in worker");
    }
    const raw = batchFn(JSON.stringify(request));
    const response = typeof raw === "string" ? JSON.parse(raw) : raw;
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
