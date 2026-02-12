const LAST_WAVEFRONT_RUNTIME_KEY = '__cooptLastWavefrontRuntime';

type HostLike = Record<string, any> | null | undefined;

function resolveHost(host?: HostLike): Record<string, any> | null {
  const h = host ?? ((typeof globalThis !== 'undefined') ? (globalThis as any) : null);
  return (h && typeof h === 'object') ? (h as Record<string, any>) : null;
}

function ensureState(host?: HostLike): { map: any | null; meta: any | null } {
  const h = resolveHost(host);
  if (!h) return { map: null, meta: null };
  const cur = h[LAST_WAVEFRONT_RUNTIME_KEY];
  if (cur && typeof cur === 'object') {
    return {
      map: cur.map ?? null,
      meta: cur.meta ?? null,
    };
  }
  const next = { map: null, meta: null };
  h[LAST_WAVEFRONT_RUNTIME_KEY] = next;
  return next;
}

export function setLastWavefrontState(map: any, meta: any, host?: HostLike): void {
  const h = resolveHost(host);
  if (!h) return;
  h[LAST_WAVEFRONT_RUNTIME_KEY] = {
    map: map ?? null,
    meta: meta ?? null,
  };
}

export function getLastWavefrontMap(host?: HostLike): any | null {
  return ensureState(host).map ?? null;
}

export function getLastWavefrontMeta(host?: HostLike): any | null {
  return ensureState(host).meta ?? null;
}

export function patchLastWavefrontMap(
  patcher: (map: any) => void,
  options?: { host?: HostLike; fallbackMap?: any }
): any {
  const h = resolveHost(options?.host);
  if (!h) return null;
  const state = ensureState(h);
  const baseMap = (state.map && typeof state.map === 'object')
    ? state.map
    : ((options?.fallbackMap && typeof options.fallbackMap === 'object') ? options.fallbackMap : {});
  try {
    patcher(baseMap);
  } catch (_) {
    // ignore
  }
  state.map = baseMap;
  h[LAST_WAVEFRONT_RUNTIME_KEY] = state;
  return baseMap;
}
