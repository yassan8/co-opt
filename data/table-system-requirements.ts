// System Requirements table persistence gateway
// - Canonical state lives in systemConfig.systemRequirements (data/table-configuration.ts)
// - This module manages the legacy/global table cache key: systemRequirementsData

type AnyRow = Record<string, any>;

const STORAGE_KEY = 'systemRequirementsData';

export function loadTableData(): AnyRow[] {
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

export function saveTableData(data: AnyRow[]): void {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return;
    if (!Array.isArray(data)) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

// localStorage に実データがある場合のみ読み込む（無い場合は null）
// Migration/初期化判定に使う。デフォルト値 ([]) を返さない点が重要。
export function tryLoadPersistedTableData(): AnyRow[] | null {
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
