import { preloadRustRayTracingWasm } from '../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';

const metadataHandleCache = new Map<string, number>();
const METADATA_HANDLE_CACHE_LIMIT = 16;

self.onmessage = async (event: MessageEvent<any>) => {
  const requestId = String(event.data?.requestId || '');
  try {
    const rust = await preloadRustRayTracingWasm();
    const trace = rust?.trace_ray_batch_hit_point_with_rows_json;
    if (typeof trace !== 'function') throw new Error('Spot rows-json WASM export is unavailable');
    const opticalSystemRows = Array.isArray(event.data?.opticalSystemRows) ? event.data.opticalSystemRows : [];
    const opticalRowsJson = typeof event.data?.opticalRowsJson === 'string'
      ? event.data.opticalRowsJson
      : JSON.stringify(opticalSystemRows);
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
    const targetSurfaceIndex = Number(event.data?.targetSurfaceIndex);
    const wavelengthUm = Number(event.data?.wavelengthUm) || 0.5876;
    const nStart = Number(event.data?.nStart) || 1;
    const registerRows = rust?.register_trace_system_metadata_with_rows_json;
    const traceCached = rust?.trace_ray_batch_hit_point_cached;
    let raw: Float64Array | number[] | null = null;
    if (typeof registerRows === 'function' && typeof traceCached === 'function') {
      const metadataKey = `${targetSurfaceIndex}|${wavelengthUm.toFixed(9)}|${opticalRowsJson}`;
      let metadataHandle = Number(metadataHandleCache.get(metadataKey)) || 0;
      if (!(metadataHandle > 0)) {
        metadataHandle = Number(registerRows(opticalRowsJson, wavelengthUm, targetSurfaceIndex)) || 0;
        if (metadataHandle > 0) {
          metadataHandleCache.set(metadataKey, metadataHandle);
          while (metadataHandleCache.size > METADATA_HANDLE_CACHE_LIMIT) {
            const oldestKey = metadataHandleCache.keys().next().value;
            if (oldestKey === undefined) break;
            metadataHandleCache.delete(oldestKey);
          }
        }
      }
      if (metadataHandle > 0) {
        raw = traceCached(raysFlat, rays.length, targetSurfaceIndex, nStart, metadataHandle);
      }
    }
    if (!raw || typeof (raw as any).length !== 'number' || (raw as any).length < rays.length * 6) {
      raw = trace(opticalRowsJson, raysFlat, rays.length, targetSurfaceIndex, wavelengthUm, nStart);
    }
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
