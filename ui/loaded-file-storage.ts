declare global {
  interface Window {
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

export function getLoadedFileName(): string | null {
  try {
    const v = storageGetItem('loadedFileName');
    const s = (v ?? '').trim();
    return s ? s : null;
  } catch (_) {
    return null;
  }
}

export function getLoadedFileWarn(): boolean {
  try {
    return !!storageGetItem('loadedFileWarn');
  } catch (_) {
    return false;
  }
}

export function setLoadedFileName(name: string | null): void {
  try {
    const s = (name ?? '').trim();
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
