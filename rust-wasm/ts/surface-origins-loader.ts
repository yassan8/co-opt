/* globalThis loader for Rust/Wasm surface_origins */

function normalizeBasePath(rawBase: string): string {
  const trimmed = String(rawBase || '/').trim();
  if (!trimmed) return '/';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function resolveBaseCandidates(): string[] {
  const candidates: string[] = [];

  const pushUnique = (value: unknown) => {
    const normalized = normalizeBasePath(String(value || '/'));
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  try {
    pushUnique((import.meta as any)?.env?.BASE_URL || '/');
  } catch {
    pushUnique('/');
  }

  try {
    const path = String((globalThis as any)?.location?.pathname || '/');
    if (path.startsWith('/co-opt/')) pushUnique('/co-opt/');
    pushUnique('/');
  } catch {
    pushUnique('/');
  }

  return candidates;
}

function buildSurfaceOriginsModuleUrlCandidates(cacheKey?: number): string[] {
  const urls: string[] = [];

  for (const base of resolveBaseCandidates()) {
    urls.push(`${base}rust-wasm/pkg/surface_origins.js`);
    urls.push(`${base}pkg/surface_origins.js`);
  }

  const seen = new Set<string>();
  const withCache = urls
    .map((url) => Number.isFinite(cacheKey) ? `${url}?v=${cacheKey}` : url)
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });

  return withCache;
}

async function importSurfaceOriginsModuleWithFallback(cacheKey?: number): Promise<any | null> {
  const g = globalThis as any;

  // Prefer bundled relative import so Vite can rewrite hashed asset paths.
  try {
    const bundled = await import('../pkg/surface_origins.js');
    g.__cooptSurfaceOriginsModuleUrlUsed = 'bundled:../pkg/surface_origins.js';
    g.__cooptSurfaceOriginsModuleUrlTried = ['bundled:../pkg/surface_origins.js'];
    return bundled;
  } catch {
    // Continue with runtime URL fallbacks.
  }

  const urls = buildSurfaceOriginsModuleUrlCandidates(cacheKey);
  g.__cooptSurfaceOriginsModuleUrlTried = urls;

  for (const moduleUrl of urls) {
    try {
      const mod = await import(/* @vite-ignore */ moduleUrl);
      g.__cooptSurfaceOriginsModuleUrlUsed = moduleUrl;
      return mod;
    } catch {
      // Try next candidate.
    }
  }

  return null;
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
      const mod = await importSurfaceOriginsModuleWithFallback();
      if (!mod) {
        throw new Error('surface_origins module could not be resolved from bundled import or URL fallbacks');
      }
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
    const mod = await importSurfaceOriginsModuleWithFallback(cacheKey);
    if (!mod) {
      throw new Error('surface_origins reload could not resolve module URL');
    }
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