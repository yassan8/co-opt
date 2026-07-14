/* globalThis loader for Rust/Wasm surface_origins */

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
      const mod = await import('../../public/rust-wasm/pkg/surface_origins.js');
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
    const moduleUrl = new URL('../../public/rust-wasm/pkg/surface_origins.js', import.meta.url);
    moduleUrl.searchParams.set('v', String(cacheKey));
    const mod = await import(/* @vite-ignore */ moduleUrl.href);
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