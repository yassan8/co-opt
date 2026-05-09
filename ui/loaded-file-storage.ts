declare global {
  interface Window {
    __cooptLoadedFileNameRuntime?: string | null;
    __cooptLoadedFileWarnRuntime?: boolean;
    __cooptLoadedFileStorage?: {
      getLoadedFileName: () => string | null;
      getLoadedFileWarn: () => boolean;
      setLoadedFileName: (name: string | null) => void;
      setLoadedFileWarn: (warn: boolean) => void;
      setLoadedFileState: (name: string | null, warn: boolean) => void;
    };
  }
}

import { storageGetItem, storageSetItem, storageRemoveItem } from './ui-storage-gateway.ts';

function getRuntimeLoadedFileName(): string | null {
  try {
    const s = String(window.__cooptLoadedFileNameRuntime ?? '').trim();
    return s ? s : null;
  } catch (_) {
    return null;
  }
}

function getRuntimeLoadedFileWarn(): boolean {
  try {
    return !!window.__cooptLoadedFileWarnRuntime;
  } catch (_) {
    return false;
  }
}

export function getLoadedFileName(): string | null {
  try {
    const v = storageGetItem('loadedFileName');
    const s = (v ?? '').trim();
    if (s) return s;
  } catch (_) {
    // ignore and fall back to runtime state
  }
  return getRuntimeLoadedFileName();
}

export function getLoadedFileWarn(): boolean {
  try {
    const persisted = !!storageGetItem('loadedFileWarn');
    if (persisted) return true;
  } catch (_) {
    // ignore and fall back to runtime state
  }
  return getRuntimeLoadedFileWarn();
}

export function setLoadedFileName(name: string | null): void {
  const s = (name ?? '').trim();
  try {
    window.__cooptLoadedFileNameRuntime = s || null;
  } catch (_) {
    // ignore
  }
  try {
    if (!s) {
      storageRemoveItem('loadedFileName');
      return;
    }
    storageSetItem('loadedFileName', s);
  } catch (_) {
    // ignore
  }
}

export function setLoadedFileWarn(warn: boolean): void {
  try {
    window.__cooptLoadedFileWarnRuntime = !!warn;
  } catch (_) {
    // ignore
  }
  try {
    if (warn) {
      storageSetItem('loadedFileWarn', '1');
      return;
    }
    storageRemoveItem('loadedFileWarn');
  } catch (_) {
    // ignore
  }
}

export function setLoadedFileState(name: string | null, warn: boolean): void {
  setLoadedFileName(name);
  setLoadedFileWarn(warn);
}

// Legacy/non-module callers (index.html inline scripts)
try {
  if (!window['__cooptLoadedFileStorage']) {
    window['__cooptLoadedFileStorage'] = {
      getLoadedFileName,
      getLoadedFileWarn,
      setLoadedFileName,
      setLoadedFileWarn,
      setLoadedFileState
    };
  }
} catch (_) {
  // ignore
}
