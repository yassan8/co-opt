declare global {
  interface Window {
    __cooptSpotPattern?: string;
    __cooptSpotDiagramSettingsByConfigId?: Record<string, any>;
  }
}

import { storageGetItem, storageSetItem } from './ui-storage-gateway.ts';

export type SpotPattern = 'grid' | 'annular';

function normalizePattern(v: any): SpotPattern | null {
  const p = String(v ?? '').trim().toLowerCase();
  return (p === 'grid' || p === 'annular') ? (p as SpotPattern) : null;
}

function getWindowTarget(preferOpener: boolean): any {
  try {
    if (preferOpener && typeof window !== 'undefined' && (window as any).opener) return (window as any).opener;
  } catch (_) {}
  return (typeof window !== 'undefined') ? window : null;
}

export function getSpotDiagramPattern(): SpotPattern | null {
  try {
    const p0 = normalizePattern((window as any).__cooptSpotPattern);
    if (p0) return p0;
  } catch (_) {}
  try {
    return normalizePattern(storageGetItem('spotDiagramPattern'));
  } catch (_) {
    return null;
  }
}

export function setSpotDiagramPattern(pattern: SpotPattern, opts?: { preferOpener?: boolean }): void {
  const target = getWindowTarget(!!opts?.preferOpener);
  if (!target) return;
  try {
    target.__cooptSpotPattern = pattern;
  } catch (_) {}
  try {
    if (target.localStorage) {
      storageSetItem('spotDiagramPattern', pattern);
    }
  } catch (_) {
    // ignore
  }
}

export function loadSpotDiagramSettingsByConfigId(): Record<string, any> {
  try {
    const raw = storageGetItem('spotDiagramSettingsByConfigId');
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, any>;
  } catch (_) {
    return {};
  }
}

export function saveSpotDiagramSettingsByConfigId(map: Record<string, any>): void {
  try {
    storageSetItem('spotDiagramSettingsByConfigId', JSON.stringify(map || {}));
  } catch (_) {
    // ignore
  }
  try {
    if (typeof window !== 'undefined') {
      (window as any).__cooptSpotDiagramSettingsByConfigId = map;
    }
  } catch (_) {
    // ignore
  }
}

export function upsertSpotDiagramSettingsForConfig(cfgKey: string, entry: Record<string, any>): void {
  if (!cfgKey) return;
  const map = loadSpotDiagramSettingsByConfigId();
  map[cfgKey] = entry;
  saveSpotDiagramSettingsByConfigId(map);
}

export function loadLastSpotDiagramSettings(): Record<string, any> {
  try {
    const raw = storageGetItem('lastSpotDiagramSettings');
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, any>;
  } catch (_) {
    return {};
  }
}

export function saveLastSpotDiagramSettings(settings: Record<string, any>): void {
  try {
    storageSetItem('lastSpotDiagramSettings', JSON.stringify(settings || {}));
  } catch (_) {
    // ignore
  }
}

export function loadLastSpotSettings(): Record<string, any> {
  try {
    const raw = storageGetItem('lastSpotSettings');
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, any>;
  } catch (_) {
    return {};
  }
}
