// @ts-nocheck

(async () => {
  try {
    const rayTracing = await import('../raytracing/core/ray-tracing.ts');
    const marginalRayModule = await import('../raytracing/core/ray-marginal.ts');

    window['rayTracingModule'] = rayTracing;

    if (window.__cooptAsphericSagService?.setImplementation) {
      window.__cooptAsphericSagService.setImplementation(async (r, params, mode = 'even') => {
        if (!window.optimalCalculator) {
          return rayTracing.asphericSag(r, params, mode);
        }

        const rArray = Array.isArray(r) ? r : [r];
        const k = params.conic || 0;
        const coef = [params.coef1 || 0, params.coef2 || 0, params.coef3 || 0, params.coef4 || 0];

        const result = await window.optimalCalculator.calculateAsphericSag(rArray, k, coef, mode);
        return Array.isArray(r) ? result.values : result.values[0];
      });
    }

    window['intersectAsphericSurface'] = rayTracing.intersectAsphericSurface;

    const clearCache = (rayTracing as any)['clearCache'];
    const disableCache = (rayTracing as any)['disableCache'];
    const enableCache = (rayTracing as any)['enableCache'];
    const enableFullCache = (rayTracing as any)['enableFullCache'];
    const testCacheDebug = (rayTracing as any)['testCacheDebug'];
    const enablePerformanceOptimization = (rayTracing as any)['enablePerformanceOptimization'];
    const disablePerformanceOptimization = (rayTracing as any)['disablePerformanceOptimization'];

    if (typeof clearCache === 'function') window['clearCache'] = clearCache;
    if (typeof disableCache === 'function') window['disableCache'] = disableCache;
    if (typeof enableCache === 'function') window['enableCache'] = enableCache;
    if (typeof enableFullCache === 'function') window['enableFullCache'] = enableFullCache;
    if (typeof testCacheDebug === 'function') window['testCacheDebug'] = testCacheDebug;
    if (typeof enablePerformanceOptimization === 'function') window['enablePerformanceOptimization'] = enablePerformanceOptimization;
    if (typeof disablePerformanceOptimization === 'function') window['disablePerformanceOptimization'] = disablePerformanceOptimization;

    window['calculateMarginalRay'] = marginalRayModule.calculateMarginalRay;
    window['calculateAllMarginalRays'] = marginalRayModule.calculateAllMarginalRays;
  } catch (error) {
    console.error('❌ ray-tracing.js モジュールの読み込みに失敗:', error);
  }
})();
