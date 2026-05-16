declare global {
  interface Window {
    [key: string]: any;
    __cooptWindowFacadeInstalled?: boolean;
    __cooptRenderSyncSenderId?: string;
  }
}

type ExposeOptions = {
  overwrite?: boolean;
};

export function exposeWindowValue(name: string, value: any, options?: ExposeOptions): void {
  try {
    if (typeof window === 'undefined') return;
    const overwrite = !!options?.overwrite;
    if (!overwrite && (window as any)[name] !== undefined) return;
    (window as any)[name] = value;
  } catch (_) {
    // ignore
  }
}

export function installCooptWindowFacadeMarker(): void {
  try {
    if (typeof window === 'undefined') return;
    if (window['__cooptWindowFacadeInstalled']) return;
    window['__cooptWindowFacadeInstalled'] = true;
  } catch (_) {
    // ignore
  }
}

export function getOrCreateCooptWindowSyncSenderId(): string {
  try {
    if (typeof window === 'undefined') return 'coopt-render-sync-server';
    const existing = String(window.__cooptRenderSyncSenderId ?? '').trim();
    if (existing) return existing;
    const next = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `coopt-render-sync-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.__cooptRenderSyncSenderId = next;
    return next;
  } catch (_) {
    return `coopt-render-sync-${Date.now()}`;
  }
}

export function callFunctionOnWindow(targetWindow: any, name: string, ...args: any[]): any {
  try {
    const w = targetWindow ?? (typeof window !== 'undefined' ? window : null);
    if (!w) return undefined;
    const fn = w[name];
    if (typeof fn !== 'function') return undefined;
    return fn(...args);
  } catch (_) {
    return undefined;
  }
}

export function callWindowFunction(name: string, ...args: any[]): any {
  return callFunctionOnWindow(typeof window !== 'undefined' ? window : null, name, ...args);
}

let _refreshBlockInspectorTimer: number | null = null;
export function requestRefreshBlockInspector(targetWindow?: any): void {
  const w = targetWindow ?? (typeof window !== 'undefined' ? window : null);
  if (!w) return;
  if (_refreshBlockInspectorTimer !== null) {
    clearTimeout(_refreshBlockInspectorTimer);
  }
  _refreshBlockInspectorTimer = setTimeout(() => {
    _refreshBlockInspectorTimer = null;
    callFunctionOnWindow(w, 'refreshBlockInspector');
  }, 80) as unknown as number;
}

export function requestUpdateSurfaceNumberSelect(targetWindow?: any): void {
  callFunctionOnWindow(targetWindow ?? (typeof window !== 'undefined' ? window : null), 'updateSurfaceNumberSelect');
}
