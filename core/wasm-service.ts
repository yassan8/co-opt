type WasmSystemInstance = any;

let wasmSystemInstance: WasmSystemInstance | null = null;
let requireRayTracingWasmStrict = false;
let rayTracingWasmInitPromise: Promise<ReturnType<typeof getRayTracingWasmReadiness>> | null = null;
let lastRayTracingBootstrapError: string | null = null;

const REQUIRED_RAYTRACE_WASM_FUNCTIONS = [
  '_intersect_aspheric_rt10',
  '_aspheric_sag_rt10',
  '_vector_dot',
  '_vector_normalize'
];

export function getWASMSystem(): WasmSystemInstance | null {
  return wasmSystemInstance;
}

export function setWASMSystem(instance: WasmSystemInstance | null): void {
  wasmSystemInstance = instance;
}

export function setRayTracingWasmStrict(required: boolean): void {
  requireRayTracingWasmStrict = required === true;
}

export function isRayTracingWasmStrict(): boolean {
  return requireRayTracingWasmStrict === true;
}

export function getRayTracingWasmReadiness(): {
  ready: boolean;
  hasSystem: boolean;
  hasModule: boolean;
  isWASMReady: boolean;
  missingFunctions: string[];
} {
  const system = wasmSystemInstance;
  const hasSystem = !!system;
  const hasModule = !!system?.wasmModule;
  const isWASMReady = !!system?.isWASMReady;
  const missingFunctions = REQUIRED_RAYTRACE_WASM_FUNCTIONS.filter((name) => {
    const fn = system?.wasmModule?.[name];
    return typeof fn !== 'function';
  });

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

async function initializeDirectRayTracingWasmSystem(): Promise<boolean> {
  const w = (typeof window !== 'undefined') ? (window as any) : null;
  if (!w) return false;

  const waitUntil = Date.now() + 5000;
  while (typeof w.RayTracingWASM !== 'function' && Date.now() < waitUntil) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  if (typeof w.RayTracingWASM !== 'function') {
    return false;
  }

  let wasmModule: any = null;
  try {
    wasmModule = await w.RayTracingWASM();
  } catch (error) {
    lastRayTracingBootstrapError = String((error as any)?.message || error || 'RayTracingWASM init failed');
    return false;
  }

  if (!wasmModule) {
    return false;
  }

  const missingFunctions = REQUIRED_RAYTRACE_WASM_FUNCTIONS.filter((name) => typeof wasmModule?.[name] !== 'function');
  if (missingFunctions.length > 0) {
    lastRayTracingBootstrapError = `Direct RayTracingWASM missing functions: [${missingFunctions.join(',')}]`;
    return false;
  }

  const system: WasmSystemInstance = {
    wasmModule,
    isWASMReady: true,
    async forceInitializeWASM() {
      return true;
    }
  };

  setWASMSystem(system);
  if (typeof w._setWASMSystem === 'function') {
    w._setWASMSystem(system);
  }
  return true;
}

async function bootstrapRayTracingWasm(): Promise<ReturnType<typeof getRayTracingWasmReadiness>> {
  const current = getRayTracingWasmReadiness();
  if (current.ready) return current;

  if (!rayTracingWasmInitPromise) {
    rayTracingWasmInitPromise = (async () => {
      let SystemClass: any = null;
      const w = (typeof window !== 'undefined') ? (window as any) : null;

      if (w && typeof w.ForceWASMSystem === 'function') {
        SystemClass = w.ForceWASMSystem;
      }

      if (!SystemClass) {
        try {
          const mod = await import('../wasm/raytracing/force-wasm-system.ts');
          SystemClass = mod?.ForceWASMSystem ?? null;
        } catch (error) {
          lastRayTracingBootstrapError = String((error as any)?.message || error || 'Failed to import ForceWASMSystem');
          SystemClass = null;
        }
      }

      if (!SystemClass) {
        const ok = await initializeDirectRayTracingWasmSystem();
        if (ok) {
          lastRayTracingBootstrapError = null;
        }
        return getRayTracingWasmReadiness();
      }

      let system = getWASMSystem();
      const hasInitMethod = typeof system?.forceInitializeWASM === 'function';
      if (!system || !hasInitMethod) {
        try {
          system = new SystemClass();
          setWASMSystem(system);
          if (w && typeof w._setWASMSystem === 'function') {
            w._setWASMSystem(system);
          }
        } catch (_) {
          return getRayTracingWasmReadiness();
        }
      }

      try {
        await system.forceInitializeWASM();
        lastRayTracingBootstrapError = null;
      } catch (_) {
        // readiness check below will report failure details
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
  rayTracing: ReturnType<typeof getRayTracingWasmReadiness>;
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
    const mod = await import('../wasm/psf/psf-wasm-wrapper.ts');
    const W = mod?.PSFCalculatorWasm;
    if (typeof W !== 'function') {
      console.warn('⚠️ PSF WASM wrapper is unavailable; continuing with fallback path.');
    } else {
      const psf = new W();
      if (typeof psf.initializeWasm === 'function') {
        await psf.initializeWasm();
      }
      psfReady = !!psf.isReady && !psf.initializationFailed;
      if (!psfReady) {
        const message = 'MTF requires PSF WASM, but initialization failed or module is not ready';
        console.warn(`⚠️ ${message}; continuing with fallback path.`);
      }
    }
  } catch (error) {
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
