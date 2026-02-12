type WasmSystemInstance = any;

let wasmSystemInstance: WasmSystemInstance | null = null;

export function getWASMSystem(): WasmSystemInstance | null {
  return wasmSystemInstance;
}

export function setWASMSystem(instance: WasmSystemInstance | null): void {
  wasmSystemInstance = instance;
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
