import {
  getRustRayTracingWasmSync,
  getRustRayTracingWasmInitError,
  preloadRustRayTracingWasm,
  getMissingRequiredRustRayTracingWasmFunctions,
  type RustRayTracingWasm
} from '../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';
import type { RayTracingWasmReadiness } from '../src/shared/contracts/wasm';

type LegacyWasmSystemInstance = {
  isWASMReady?: boolean;
  forceAsphericSag?: (...args: number[]) => number;
  forceAsphericSagBatch?: (...args: unknown[]) => unknown;
  wasmModule?: unknown;
  [key: string]: unknown;
};

type RustWasmBackendSystemInstance = {
  backend: 'rust-wasm';
  isWASMReady: boolean;
  api: RustRayTracingWasm;
};

type WasmSystemInstance = LegacyWasmSystemInstance | RustWasmBackendSystemInstance;
export type WasmAsphericSagFn = (...args: number[]) => number;
export type WasmAsphericSagBatchFn = (...args: unknown[]) => unknown;
export type LegacyWasmModule = {
  [key: string]: unknown;
};

function hasReadyLegacyAsphericSag(system: WasmSystemInstance | null | undefined): system is LegacyWasmSystemInstance & { isWASMReady: true; forceAsphericSag: WasmAsphericSagFn } {
  return !!system
    && system.isWASMReady === true
    && typeof system.forceAsphericSag === 'function';
}

function hasReadyLegacyAsphericSagBatch(system: WasmSystemInstance | null | undefined): system is LegacyWasmSystemInstance & { isWASMReady: true; forceAsphericSagBatch: WasmAsphericSagBatchFn } {
  return !!system
    && system.isWASMReady === true
    && typeof system.forceAsphericSagBatch === 'function';
}

function hasReadyLegacyWasmModule(system: WasmSystemInstance | null | undefined): system is LegacyWasmSystemInstance & { isWASMReady: true; wasmModule: LegacyWasmModule } {
  return !!system
    && system.isWASMReady === true
    && typeof system.wasmModule === 'object'
    && system.wasmModule !== null;
}

let wasmSystemInstance: WasmSystemInstance | null = null;
let requireRayTracingWasmStrict = false;
let requirePsfWasmStrict = true;
let rayTracingWasmInitPromise: Promise<ReturnType<typeof getRayTracingWasmReadiness>> | null = null;
let lastRayTracingBootstrapError: string | null = null;

export function getWASMSystem(): WasmSystemInstance | null {
  return wasmSystemInstance;
}

export function setWASMSystem(instance: WasmSystemInstance | null): void {
  wasmSystemInstance = instance;
}

export function getLegacyWasmAsphericSagFn(system: WasmSystemInstance | null = wasmSystemInstance): WasmAsphericSagFn | null {
  return hasReadyLegacyAsphericSag(system) ? system.forceAsphericSag : null;
}

export function getLegacyWasmAsphericSagBatchFn(system: WasmSystemInstance | null = wasmSystemInstance): WasmAsphericSagBatchFn | null {
  if (!hasReadyLegacyAsphericSagBatch(system)) return null;
  return system.forceAsphericSagBatch;
}

export function getLegacyWasmModule(system: WasmSystemInstance | null = wasmSystemInstance): LegacyWasmModule | null {
  return hasReadyLegacyWasmModule(system) ? system.wasmModule : null;
}

export function setRayTracingWasmStrict(required: boolean): void {
  requireRayTracingWasmStrict = required === true;
}

export function isRayTracingWasmStrict(): boolean {
  return requireRayTracingWasmStrict === true;
}

export function setPsfWasmStrict(required: boolean): void {
  requirePsfWasmStrict = required === true;
}

export function isPsfWasmStrict(): boolean {
  return requirePsfWasmStrict === true;
}

export function getRayTracingWasmReadiness(): RayTracingWasmReadiness {
  const rustApi = getRustRayTracingWasmSync();
  const hasSystem = !!rustApi;
  const hasModule = !!rustApi;
  const isWASMReady = !!rustApi;
  const missingFunctions = getMissingRequiredRustRayTracingWasmFunctions(rustApi);

  return {
    ready: hasSystem && hasModule && isWASMReady && missingFunctions.length === 0,
    hasSystem,
    hasModule,
    isWASMReady,
    missingFunctions
  };
}

export function assertRayTracingWasmReady(context = 'Ray tracing WASM is required'): void {
  const state = getRayTracingWasmReadiness();
  if (!state.ready) {
    const details = [
      `hasSystem=${state.hasSystem}`,
      `hasModule=${state.hasModule}`,
      `isWASMReady=${state.isWASMReady}`,
      `missing=[${state.missingFunctions.join(',')}]`
    ].join(' ');
    throw new Error(`${context}. ${details}`);
  }
}

async function bootstrapRayTracingWasm(): Promise<RayTracingWasmReadiness> {
  const current = getRayTracingWasmReadiness();
  if (current.ready) return current;

  if (!rayTracingWasmInitPromise) {
    rayTracingWasmInitPromise = (async () => {
      try {
        const api = getRustRayTracingWasmSync() || await preloadRustRayTracingWasm();
        if (!api) {
          lastRayTracingBootstrapError = getRustRayTracingWasmInitError() || 'Rust ray tracing WASM init failed';
          return getRayTracingWasmReadiness();
        }
        setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });
        lastRayTracingBootstrapError = null;
      } catch (error) {
        lastRayTracingBootstrapError = String((error as any)?.message || error || 'Rust ray tracing WASM init failed');
      }

      return getRayTracingWasmReadiness();
    })();
  }

  try {
    return await rayTracingWasmInitPromise;
  } finally {
    rayTracingWasmInitPromise = null;
  }
}

export async function ensureMtfWasmReady(): Promise<{
  ready: boolean;
  rayTracing: RayTracingWasmReadiness;
  psfReady: boolean;
}> {
  const rayTracing = await bootstrapRayTracingWasm();
  if (!rayTracing.ready) {
    const detail = lastRayTracingBootstrapError ? ` bootstrapError=${lastRayTracingBootstrapError}` : '';
    throw new Error(
      `MTF requires RayTracing WASM. hasSystem=${rayTracing.hasSystem} hasModule=${rayTracing.hasModule} isWASMReady=${rayTracing.isWASMReady} missing=[${rayTracing.missingFunctions.join(',')}]${detail}`
    );
  }

  let psfReady = false;

  try {
    const mod = await import('../rust-wasm/ts/psf/psf-wasm-wrapper.ts');
    const W = mod?.PSFCalculatorWasm;
    if (typeof W !== 'function') {
      if (requirePsfWasmStrict) {
        throw new Error('MTF requires PSF WASM wrapper, but wrapper is unavailable');
      }
      console.warn('⚠️ PSF WASM wrapper is unavailable; continuing with fallback path.');
    } else {
      const psf = new W();
      if (typeof psf.initializeWasm === 'function') {
        await psf.initializeWasm();
      }
      psfReady = !!psf.isReady && !psf.initializationFailed;
      if (!psfReady) {
        const message = 'MTF requires PSF WASM, but initialization failed or module is not ready';
        if (requirePsfWasmStrict) {
          throw new Error(message);
        }
        console.warn(`⚠️ ${message}; continuing with fallback path.`);
      }
    }
  } catch (error) {
    if (requirePsfWasmStrict) {
      throw error;
    }
    console.warn('⚠️ PSF WASM readiness check failed; continuing with fallback path:', error);
    psfReady = false;
  }

  return {
    ready: rayTracing.ready,
    rayTracing,
    psfReady
  };
}

export function installWasmServiceGlobals(target: any = globalThis): void {
  try {
    if (!target) return;
    if (target.__cooptWasmServiceInstalled) return;
    target.__cooptWasmServiceInstalled = true;

    const getter = () => wasmSystemInstance;
    const setter = (instance: WasmSystemInstance | null) => {
      wasmSystemInstance = instance;
    };

    if (typeof target.getWASMSystem !== 'function') {
      target.getWASMSystem = getter;
    }
    if (typeof target._setWASMSystem !== 'function') {
      target._setWASMSystem = setter;
    }

    const w = (typeof window !== 'undefined') ? window : null;
    if (w) {
      if (typeof w.getWASMSystem !== 'function') w.getWASMSystem = getter;
      if (typeof w._setWASMSystem !== 'function') w._setWASMSystem = setter;
    }
  } catch (_) {
    // ignore
  }
}

// Install immediately on module load (used from index.html <head> for early availability).
installWasmServiceGlobals();
