/* globalThis loader for Rust/Wasm surface_origins */

(async () => {
  try {
    const mod = await import('./surface_origins.js');
    if (typeof mod?.default === 'function') {
      await mod.default();
    }
    globalThis.__cooptSurfaceOriginsModule = mod;
    globalThis.__cooptSurfaceOriginsModulePromise = Promise.resolve(mod);
  } catch (error) {
    console.warn('⚠️ [Startup] Rust/Wasm surface_origins loader failed:', error);
    globalThis.__cooptSurfaceOriginsModuleError = error;
    globalThis.__cooptSurfaceOriginsModulePromise = Promise.resolve(null);
  }
})();