export type AsphericSagFn = (r: any, params: any, mode?: string) => any;

let currentImpl: AsphericSagFn | null = null;

export function getAsphericSagImplementation(): AsphericSagFn | null {
  return currentImpl;
}

export function setAsphericSagImplementation(fn: AsphericSagFn | null): void {
  currentImpl = fn;
}

export function installAsphericSagGlobal(target: any = globalThis): void {
  try {
    if (!target) return;
    if (target.__cooptAsphericSagServiceInstalled) return;
    target.__cooptAsphericSagServiceInstalled = true;

    const facade = {
      getImplementation: getAsphericSagImplementation,
      setImplementation: setAsphericSagImplementation
    };
    target.__cooptAsphericSagService = facade;

    const asphericSagFacade: AsphericSagFn = (r, params, mode = 'even') => {
      const impl = currentImpl;
      if (typeof impl !== 'function') {
        throw new Error('asphericSag implementation is not installed');
      }
      return impl(r, params, mode);
    };

    if (typeof window !== 'undefined' && typeof (window as any)['asphericSag'] !== 'function') {
      (window as any)['asphericSag'] = asphericSagFacade as any;
    }
    if (typeof target['asphericSag'] !== 'function') {
      target['asphericSag'] = asphericSagFacade as any;
    }
  } catch (_) {
    // ignore
  }
}

installAsphericSagGlobal();
