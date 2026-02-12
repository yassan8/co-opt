import {
  storageGetItem,
  storageSetItem,
  storageRemoveItem,
} from '../../utils/local-storage-gateway';

export function loadLastWavefrontSnapshot(): any | null {
  try {
    const json = storageGetItem('lastWavefrontSnapshot');
    if (!json) return null;
    const parsed = JSON.parse(json);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function saveLastWavefrontSnapshot(snapshot: any): void {
  try {
    storageSetItem('lastWavefrontSnapshot', JSON.stringify(snapshot));
  } catch (_) {
    // ignore
  }
}

export function clearLastWavefrontSnapshot(): void {
  try {
    storageRemoveItem('lastWavefrontSnapshot');
  } catch (_) {
    // ignore
  }
}

export function loadLastPsfMeta(): any | null {
  try {
    const json = storageGetItem('lastPsfMeta');
    if (!json) return null;
    const parsed = JSON.parse(json);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function loadLastPsfError(): any | null {
  try {
    const json = storageGetItem('lastPsfError');
    if (!json) return null;
    const parsed = JSON.parse(json);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (_) {
    return null;
  }
}
