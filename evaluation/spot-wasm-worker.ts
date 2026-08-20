import { preloadRustRayTracingWasm } from '../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';

self.onmessage = async (event: MessageEvent<any>) => {
  const requestId = String(event.data?.requestId || '');
  try {
    const rust = await preloadRustRayTracingWasm();
    const trace = rust?.trace_ray_batch_hit_point_with_rows_json;
    if (typeof trace !== 'function') throw new Error('Spot rows-json WASM export is unavailable');
    const opticalSystemRows = Array.isArray(event.data?.opticalSystemRows) ? event.data.opticalSystemRows : [];
    const rays = Array.isArray(event.data?.rays) ? event.data.rays : [];
    const raysFlat = new Float64Array(rays.length * 6);
    for (let index = 0; index < rays.length; index += 1) {
      const ray = rays[index] || {};
      const base = index * 6;
      raysFlat[base] = Number(ray?.pos?.x);
      raysFlat[base + 1] = Number(ray?.pos?.y);
      raysFlat[base + 2] = Number(ray?.pos?.z);
      raysFlat[base + 3] = Number(ray?.dir?.x);
      raysFlat[base + 4] = Number(ray?.dir?.y);
      raysFlat[base + 5] = Number(ray?.dir?.z);
    }
    const raw = trace(
      JSON.stringify(opticalSystemRows),
      raysFlat,
      rays.length,
      Number(event.data?.targetSurfaceIndex),
      Number(event.data?.wavelengthUm) || 0.5876,
      Number(event.data?.nStart) || 1,
    );
    const statusLabel = (code: number) => (
      code === 1 ? 'ok'
        : code === 2 ? 'invalid_input'
          : code === 3 ? 'no_intersection'
            : code === 4 ? 'aperture_block'
              : code === 5 ? 'tir'
                : code === 6 ? 'not_reached'
                  : 'unknown'
    );
    const summaries = Array.from({ length: rays.length }, (_, index) => {
      const base = index * 6;
      const code = Number((raw as any)?.[base]);
      const x = Number((raw as any)?.[base + 2]);
      const y = Number((raw as any)?.[base + 3]);
      const z = Number((raw as any)?.[base + 4]);
      const success = code === 1 && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
      return {
        success,
        status: statusLabel(code),
        hitPoint: success ? { x, y, z } : null,
        oplMicrons: Number((raw as any)?.[base + 1]),
      };
    });
    self.postMessage({ requestId, ok: true, summaries: Array.isArray(summaries) ? summaries : [] });
  } catch (error: any) {
    self.postMessage({ requestId, ok: false, error: String(error?.message || error || 'Spot WASM worker failed') });
  }
};
