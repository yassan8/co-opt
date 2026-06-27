export function storageGetItem(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

export function storageSetItem(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return;
    localStorage.setItem(key, value);
  } catch (_) {
    // ignore
  }
}

export function storageRemoveItem(key: string): void {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return;
    localStorage.removeItem(key);
  } catch (_) {
    // ignore
  }
}
