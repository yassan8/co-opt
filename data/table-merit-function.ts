// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}

// Merit Function table persistence gateway (global, shared across configurations)
// - Canonical storage is gradually moving into systemConfigurations via table-configuration.ts
// - This module provides a single place for localStorage IO for the projection key.

type MeritRow = Record<string, any>;

const STORAGE_KEY = 'meritFunctionData';

export function loadTableData(): MeritRow[] {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return [];
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) return [];
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTableData(rows: MeritRow[]): void {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return;
    if (!Array.isArray(rows)) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // ignore
  }
}

// localStorage に実データがある場合のみ読み込む（無い場合は null）
// Migration/初期化判定に使う。デフォルト値を返さない点が重要。
export function tryLoadPersistedTableData(): MeritRow[] | null {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) return null;
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
