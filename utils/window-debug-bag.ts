export function setWindowDebugBagValue(namespace: string, key: string, value: any): void {
  try {
    if (typeof window === 'undefined') return;
    const ns = String(namespace || '').trim();
    const k = String(key || '').trim();
    if (!ns || !k) return;
    const currentRoot = (window as any).__cooptDebugBags;
    const root = (currentRoot && typeof currentRoot === 'object') ? currentRoot : {};
    const currentBag = root[ns];
    const bag = (currentBag && typeof currentBag === 'object') ? currentBag : {};
    bag[k] = value;
    root[ns] = bag;
    (window as any).__cooptDebugBags = root;
  } catch (_) {
    // ignore
  }
}

export function getWindowDebugBagValue(namespace: string, key: string, fallbackValue: any = null): any {
  try {
    if (typeof window === 'undefined') return fallbackValue;
    const ns = String(namespace || '').trim();
    const k = String(key || '').trim();
    if (!ns || !k) return fallbackValue;
    const root = (window as any).__cooptDebugBags;
    if (!root || typeof root !== 'object') return fallbackValue;
    const bag = root[ns];
    if (!bag || typeof bag !== 'object') return fallbackValue;
    return (k in bag) ? bag[k] : fallbackValue;
  } catch (_) {
    return fallbackValue;
  }
}
