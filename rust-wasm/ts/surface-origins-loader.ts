/* globalThis loader for Rust/Wasm surface_origins */

function getSurfaceOriginsModuleUrl(cacheKey?: number): string {
  const rawBase = String(import.meta.env.BASE_URL || '/');
  const base = `${rawBase.startsWith('/') ? rawBase : `/${rawBase}`}${rawBase.endsWith('/') ? '' : '/'}`;
  const url = `${base}rust-wasm/pkg/surface_origins.js`;
  return Number.isFinite(cacheKey) ? `${url}?v=${cacheKey}` : url;
}

export async function ensureSurfaceOriginsModuleLoaded(): Promise<any | null> {
  const g = globalThis as any;

  if (g?.__cooptSurfaceOriginsModule) {
    return g.__cooptSurfaceOriginsModule;
  }

  if (g?.__cooptSurfaceOriginsModulePromise) {
    const existing = await g.__cooptSurfaceOriginsModulePromise;
    if (existing) return existing;
  }

  if (g?.__cooptSurfaceOriginsModuleLoadPromise) {
    return await g.__cooptSurfaceOriginsModuleLoadPromise;
  }

  g.__cooptSurfaceOriginsModuleLoadPromise = (async () => {
    try {
      const moduleUrl = getSurfaceOriginsModuleUrl();
      const mod = await import(/* @vite-ignore */ moduleUrl);
      g.__cooptSurfaceOriginsModule = mod;
      g.__cooptSurfaceOriginsModuleError = null;
      g.__cooptSurfaceOriginsModulePromise = Promise.resolve(mod);
      return mod;
    } catch (error) {
      console.warn('⚠️ [Startup] Rust/Wasm surface_origins loader failed:', error);
      g.__cooptSurfaceOriginsModuleError = error;
      g.__cooptSurfaceOriginsModulePromise = Promise.resolve(null);
      return null;
    } finally {
      g.__cooptSurfaceOriginsModuleLoadPromise = null;
    }
  })();

  return await g.__cooptSurfaceOriginsModuleLoadPromise;
}

export async function reloadSurfaceOriginsModule(): Promise<any | null> {
  const g = globalThis as any;
  delete g.__cooptSurfaceOriginsModule;
  delete g.__cooptSurfaceOriginsModulePromise;
  delete g.__cooptSurfaceOriginsModuleLoadPromise;
  const cacheKey = Date.now();
  try {
    const moduleUrl = getSurfaceOriginsModuleUrl(cacheKey);
    const mod = await import(/* @vite-ignore */ moduleUrl);
    g.__cooptSurfaceOriginsModule = mod;
    g.__cooptSurfaceOriginsModuleError = null;
    g.__cooptSurfaceOriginsModulePromise = Promise.resolve(mod);
    return mod;
  } catch (error) {
    console.warn('⚠️ [Startup] Rust/Wasm surface_origins reload failed:', error);
    g.__cooptSurfaceOriginsModuleError = error;
    g.__cooptSurfaceOriginsModulePromise = Promise.resolve(null);
    throw error;
  }
}

void ensureSurfaceOriginsModuleLoaded();