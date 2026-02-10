// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

// System Configuration管理モジュール
// 複数のConfigurationを保存・切り替え可能にする

import { BLOCK_SCHEMA_VERSION, DEFAULT_STOP_SEMI_DIAMETER, configurationHasBlocks, validateBlocksConfiguration, expandBlocksToOpticalSystemRows } from './block-schema.ts';

// Block interface (for type safety with block-schema)
interface Block {
  blockId?: string;
  blockType?: string;
  role?: any;
  constraints?: Record<string, any>;
  parameters?: Record<string, any>;
  variables?: Record<string, any>;
  metadata?: Record<string, any>;
}

const STORAGE_KEY = "systemConfigurations";

const CONFIG_DEBUG = !!(typeof globalThis !== 'undefined' && w.__CONFIG_DEBUG);
const cfgLog = (...args: any[]): void => { if (CONFIG_DEBUG) console.log(...args); };
const cfgWarn = (...args: any[]): void => { if (CONFIG_DEBUG) console.warn(...args); };

let warnedActiveConfigNotFound = false;

function idsEqual(a: any, b: any): boolean {
  return String(a ?? '') === String(b ?? '');
}

interface SystemData {
  referenceFocalLength?: string | number;
}

interface ConfigurationMetadata {
  created: string;
  modified: string;
  optimizationTarget?: any;
  locked: boolean;
  designer?: {
    type: "human" | "ai" | "imported";
    name: string;
    confidence: number | null;
  };
}

export interface Configuration {
  id: number | string;
  name: string;
  schemaVersion: string;
  blocks: Block[];
  source: any[];
  object: any[];
  opticalSystem: any[];
  systemData: SystemData;
  metadata: ConfigurationMetadata;
  meritFunction?: any[];
}

interface SystemConfiguration {
  configurations: Configuration[];
  activeConfigId: number | string;
  meritFunction: any[];
  systemRequirements: any[];
  optimizationRules: Record<string, any>;
}

interface ConfigurationListItem {
  id: number | string;
  name: string;
  active: boolean;
  created: string;
  modified: string;
  locked: boolean;
}

interface LoadConfigurationOptions {
  applyToUI?: boolean;
  suppressOpticalSystemDataChanged?: boolean;
}

// 初期Configuration構造
function createDefaultConfiguration(id: number, name: string): Configuration {
  const defaultBlocks: Block[] = [
    {
      blockId: 'ObjectSurface-1',
      blockType: 'ObjectSurface',
      role: null,
      constraints: {},
      parameters: {
        objectDistanceMode: 'INF'
      },
      variables: {},
      metadata: { source: 'default' }
    },
    {
      blockId: 'Stop-1',
      blockType: 'Stop',
      role: null,
      constraints: {},
      parameters: {
        semiDiameter: DEFAULT_STOP_SEMI_DIAMETER
      },
      variables: {},
      metadata: { source: 'default' }
    },
    {
      blockId: 'ImageSurface-1',
      blockType: 'ImageSurface',
      role: null,
      constraints: {},
      parameters: undefined,
      variables: {},
      metadata: { source: 'default' }
    }
  ];

  return {
    id: id,
    name: name,
    // Block schema (canonical for AI designs; optional during transition)
    schemaVersion: BLOCK_SCHEMA_VERSION,
    blocks: defaultBlocks,
    source: [
      { id: 1, wavelength: 0.4358343, weight: 1, primary: '', angle: 0 },
      { id: 2, wavelength: 0.5875618, weight: 1, primary: 'Primary Wavelength', angle: 0 },
      { id: 3, wavelength: 0.6562725, weight: 1, primary: '', angle: 0 }
    ],
    object: [
      { id: 1, xHeightAngle: 0, yHeightAngle: 0, position: 'Angle', angle: 0 },
      { id: 2, xHeightAngle: 0, yHeightAngle: 17.05, position: 'Angle', angle: 0 }
    ],
    opticalSystem: [],
    // meritFunctionは各configから削除（グローバルに移動）
    systemData: {
      referenceFocalLength: '' // 空文字列は "Auto" を意味する
    },
    metadata: {
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      optimizationTarget: null,  // 将来のAI最適化用
      locked: false,
      designer: {
        type: "human",  // "human" | "ai" | "imported"
        name: "user",   // user name or "GPT" or "patent" etc.
        confidence: null  // AI confidence score (0-1) or null for human/imported
      }
    }
  };
}

// システム全体のConfiguration状態を管理
const defaultSystemConfig: SystemConfiguration = {
  configurations: [
    createDefaultConfiguration(1, "Config 1")
  ],
  activeConfigId: 1,
  meritFunction: [],  // グローバルなMerit Function（全configで共有、各行にconfigId指定）
  systemRequirements: [], // グローバルなSystem Requirements（全configで共有、各行にconfigId指定）
  optimizationRules: {}  // フェーズ4用（空で準備）
};

// localStorageからConfiguration全体を読み込み
export function loadSystemConfigurations(): SystemConfiguration {
  cfgLog('🔵 [Configuration] Loading system configurations from localStorage...');
  const json = localStorage.getItem(STORAGE_KEY);
  
  if (json) {
    try {
      const parsed = JSON.parse(json) as SystemConfiguration;
      // Normalize legacy configs to avoid UI crashes (missing metadata/systemData).
      if (parsed && Array.isArray(parsed.configurations)) {
        for (const cfg of parsed.configurations) {
          if (!cfg || typeof cfg !== 'object') continue;
          if (!cfg.metadata || typeof cfg.metadata !== 'object') cfg.metadata = {} as ConfigurationMetadata;
          if (!cfg.metadata.created) cfg.metadata.created = new Date().toISOString();
          if (!cfg.metadata.modified) cfg.metadata.modified = cfg.metadata.created;
          if (cfg.metadata.locked === undefined) cfg.metadata.locked = false;
          if (!cfg.systemData || typeof cfg.systemData !== 'object') {
            cfg.systemData = { referenceFocalLength: '' };
          }
          if (cfg.name === undefined || cfg.name === null) {
            cfg.name = `Config ${String(cfg.id ?? '') || ''}`.trim() || 'Config';
          }
        }
      }
      cfgLog('🔵 [Configuration] Loaded configurations:', parsed.configurations.length);
      return parsed;
    } catch (e) {
      console.error('❌ [Configuration] Parse error; using default system config:', e);
    }
  }
  
  cfgLog('🔵 [Configuration] Using default system config');
  return defaultSystemConfig;
}

// Configuration全体を保存
export function saveSystemConfigurations(systemConfig: SystemConfiguration): void {
  cfgLog('🔵 [Configuration] Saving system configurations...');
  if (systemConfig && systemConfig.configurations) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(systemConfig));
    cfgLog(`💾 [Configuration] Saved ${systemConfig.configurations.length} configurations`);
  } else {
    console.error('❌ [Configuration] Invalid system config, not saving:', systemConfig);
  }
}

// アクティブなConfigurationを取得
export function getActiveConfiguration(): Configuration {
  const systemConfig = loadSystemConfigurations();
  const activeConfig = systemConfig.configurations.find(c => idsEqual(c?.id, systemConfig.activeConfigId));
  
  if (!activeConfig) {
    if (!warnedActiveConfigNotFound) {
      console.warn('⚠️ [Configuration] Active config not found, using first');
      warnedActiveConfigNotFound = true;
    }
    return systemConfig.configurations[0];
  }
  
  return activeConfig;
}

// アクティブなConfiguration IDを取得
export function getActiveConfigId(): number | string {
  const systemConfig = loadSystemConfigurations();
  return systemConfig.activeConfigId;
}

// アクティブなConfigurationを変更
export function setActiveConfiguration(configId: number | string): boolean {
  const systemConfig = loadSystemConfigurations();
  const config = systemConfig.configurations.find(c => idsEqual(c?.id, configId));
  
  if (!config) {
    console.error('❌ [Configuration] Config not found:', configId);
    return false;
  }
  
  // Preserve the config's id type (string/number) to avoid strict-equality mismatches.
  systemConfig.activeConfigId = config.id;
  saveSystemConfigurations(systemConfig);
  cfgLog(`✅ [Configuration] Active config changed to: ${config.name}`);
  return true;
}

// 現在のテーブルデータをアクティブなConfigurationに保存
export function saveCurrentToActiveConfiguration(): void {
  cfgLog('🔵 [Configuration] Saving current table data to active configuration...');
  
  const systemConfig = loadSystemConfigurations();
  const activeConfig = systemConfig.configurations.find(c => c.id === systemConfig.activeConfigId);
  
  if (!activeConfig) {
    console.error('❌ [Configuration] Active config not found');
    return;
  }
  
  // 各テーブルからデータを取得
  // Source is global (shared across configurations).
  // Persist it to the shared storage key, but do not store it per-config.
  try {
    const globalSource = w.tableSource ? w.tableSource.getData() : [];
    localStorage.setItem('sourceTableData', JSON.stringify(globalSource));
  } catch (_) {}
  activeConfig.object = w.tableObject ? w.tableObject.getData() : [];

  // Expanded Optical System is derived from Blocks.
  // When Blocks exist, do NOT overwrite config.opticalSystem from the (disabled/no-op) surface table.
  if (!configurationHasBlocks(activeConfig)) {
    activeConfig.opticalSystem = w.tableOpticalSystem ? w.tableOpticalSystem.getData() : [];
  }
  
  // Merit Function はグローバルに保存（各configには保存しない）
  systemConfig.meritFunction = w.meritFunctionEditor ? w.meritFunctionEditor.getData() : [];

  // System Requirements はグローバルに保存（各configには保存しない）
  systemConfig.systemRequirements = w.systemRequirementsEditor ? w.systemRequirementsEditor.getData() : [];
  
  // System Data を保存（localStorageとconfigの両方）
  const refFLInput = document.getElementById('reference-focal-length') as HTMLInputElement | null;
  if (!activeConfig.systemData) {
    activeConfig.systemData = {};
  }
  activeConfig.systemData.referenceFocalLength = refFLInput ? refFLInput.value : '';
  
  // localStorageにも保存
  localStorage.setItem('systemData', JSON.stringify(activeConfig.systemData));
  
  // メタデータ更新
  activeConfig.metadata.modified = new Date().toISOString();
  
  saveSystemConfigurations(systemConfig);
  cfgLog(`✅ [Configuration] Saved to: ${activeConfig.name}`);
}

// アクティブなConfigurationのデータをlocalStorageに展開（各テーブル用）
export async function loadActiveConfigurationToTables(options: LoadConfigurationOptions = {}): Promise<void> {
  cfgLog('🔵 [Configuration] Loading active configuration to tables...');
  
  const systemConfig = loadSystemConfigurations();
  // IMPORTANT: Use the active config object from this `systemConfig` instance.
  // Calling getActiveConfiguration() would reload from localStorage and return a different object,
  // so in-place mutations (e.g. auto-assigning blockId) would not persist when saving.
  const activeConfig = systemConfig.configurations.find(c => idsEqual(c?.id, systemConfig.activeConfigId)) || systemConfig.configurations[0];
  
  if (!activeConfig) {
    console.error('❌ [Configuration] No active config found');
    return;
  }

  // Normalize legacy blockType values before validation
  try {
    if (Array.isArray(activeConfig.blocks)) {
      for (const b of activeConfig.blocks) {
        if (!b || typeof b !== 'object') continue;
        const t = String((b as any).blockType ?? '').trim();
        if (t === 'ImagePlane') (b as any).blockType = 'ImageSurface';
        else if (t === 'ObjectPlane') (b as any).blockType = 'ObjectSurface';
        else if (t === 'AirGap') (b as any).blockType = 'Gap';
      }
    }
  } catch (_) {}

  // If the active config uses blocks, deterministically expand to legacy surface rows for UI/evaluation.
  let effectiveOpticalSystem = activeConfig.opticalSystem;
  if (configurationHasBlocks(activeConfig)) {
    const overlayProvenance = (legacyRows: any[], expandedRows: any[]): void => {
      if (!Array.isArray(legacyRows) || !Array.isArray(expandedRows)) return;
      const n = Math.min(legacyRows.length, expandedRows.length);
      for (let i = 0; i < n; i++) {
        const src = expandedRows[i];
        const dst = legacyRows[i];
        if (!src || typeof src !== 'object' || !dst || typeof dst !== 'object') continue;
        if ('_blockId' in src) dst._blockId = src._blockId;
        if ('_blockType' in src) dst._blockType = src._blockType;
        if ('_surfaceRole' in src) dst._surfaceRole = src._surfaceRole;
      }
    };

    const preserveLegacySemidiaIntoExpanded = (expandedRows: any[], legacyRows: any[]): void => {
      if (!Array.isArray(expandedRows) || !Array.isArray(legacyRows)) return;
      const hasValue = (v: any): boolean => {
        if (v === null || v === undefined) return false;
        const s = String(v).trim();
        return s !== '';
      };
      const getLegacySemidia = (row: any): any => {
        if (!row || typeof row !== 'object') return null;
        return row.semidia ?? row['Semi Diameter'] ?? row['semi diameter'] ?? row.semiDiameter ?? row.semiDia;
      };
      const rowType = (row: any): string => {
        const t = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
        return t;
      };

      const isSkippableRow = (row: any): boolean => {
        const t = rowType(row);
        return t === 'stop' || t === 'sto' || t === 'image' || t === 'object'
          || t === 'coordtrans' || t === 'coord trans' || t === 'ct';
      };
      const keyFor = (row: any): string => {
        if (!row || typeof row !== 'object') return '';
        const bid = String(row._blockId ?? '').trim();
        const role = String(row._surfaceRole ?? '').trim();
        return (bid && role) ? `${bid}|${role}` : '';
      };

      const legacyByKey = new Map<string, any>();
      try {
        for (const l of legacyRows) {
          if (!l || typeof l !== 'object') continue;
          if (isSkippableRow(l)) continue;
          const k = keyFor(l);
          if (k) legacyByKey.set(k, l);
        }
      } catch (_) {}

      let li = 0;
      for (let ei = 0; ei < expandedRows.length; ei++) {
        const e = expandedRows[ei];
        if (!e || typeof e !== 'object') continue;

        // Blocks only model Stop.semiDiameter; per-surface semidia is a table-level detail.
        // Therefore, preserve legacy semidia only for physical surfaces.
        if (isSkippableRow(e)) continue;

        let l = null;
        try {
          const k = keyFor(e);
          if (k && legacyByKey.has(k)) l = legacyByKey.get(k);
        } catch (_) {
          l = null;
        }
        if (!l) {
          while (li < legacyRows.length && isSkippableRow(legacyRows[li])) li++;
          l = (li < legacyRows.length) ? legacyRows[li] : null;
          li++;
        }
        if (!l || typeof l !== 'object') continue;

        const lsRaw = getLegacySemidia(l);
        if (hasValue(lsRaw)) e.semidia = lsRaw;
      }
    };

    const normalizeIdsInPlace = (rows: any[]): void => {
      if (!Array.isArray(rows)) return;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i] && typeof rows[i] === 'object') rows[i].id = i;
      }
    };

    const blocksHaveObjectSurface = ((): boolean => {
      try { return Array.isArray(activeConfig?.blocks) && activeConfig.blocks.some(b => String(b?.blockType ?? '').trim() === 'ObjectSurface'); } catch (_) { return false; }
    })();

    const pickPreservedObjectThickness = (): any => {
      // ObjectSurface is canonical for object distance in Blocks-only mode.
      if (blocksHaveObjectSurface) return null;

      try {
        const v = activeConfig?.opticalSystem?.[0]?.thickness;
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        const s = String(v ?? '').trim();
        if (s && /^inf(inity)?$/i.test(s)) return 'INF';
        if (s && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) {
          const n = Number(s);
          if (Number.isFinite(n)) return n;
        }
      } catch (_) {}

      try {
        const json = localStorage.getItem('OpticalSystemTableData');
        if (!json) return null;
        const rows = JSON.parse(json);
        const v = rows?.[0]?.thickness;
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        const s = String(v ?? '').trim();
        if (s && /^inf(inity)?$/i.test(s)) return 'INF';
        if (s && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) {
          const n = Number(s);
          if (Number.isFinite(n)) return n;
        }
      } catch (_) {}

      return null;
    };

    const preservedObjectThickness = pickPreservedObjectThickness();

    // Ensure every block has a stable id so expanded rows carry provenance (_blockId).
    const ensureBlocksHaveBlockIdsInPlace = (blocks: Block[]): number => {
      if (!Array.isArray(blocks)) return 0;
      const used = new Set<string>();
      for (const b of blocks) {
        const id = typeof b?.blockId === 'string' ? b.blockId.trim() : '';
        if (id) used.add(id);
      }
      let assigned = 0;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (!b || typeof b !== 'object') continue;
        const raw = typeof b.blockId === 'string' ? b.blockId.trim() : '';
        if (raw) continue;
        const type = String(b.blockType || 'Block').trim() || 'Block';
        const base = `${type}-${i + 1}`;
        let id = base;
        let suffix = 2;
        while (used.has(id)) {
          id = `${base}-${suffix++}`;
        }
        b.blockId = id;
        used.add(id);
        assigned++;
      }
      return assigned;
    };

    try {
      const assigned = ensureBlocksHaveBlockIdsInPlace(activeConfig.blocks);
      if (assigned > 0) {
        cfgWarn(`⚠️ [Configuration] ${assigned} blocks were missing blockId; auto-assigned for provenance.`);
        try {
          if (!activeConfig.metadata) activeConfig.metadata = {} as ConfigurationMetadata;
          activeConfig.metadata.modified = new Date().toISOString();
        } catch (_) {}
        saveSystemConfigurations(systemConfig);
      }
    } catch (e) {
      cfgWarn('⚠️ [Configuration] Failed to ensure blockId for blocks:', e);
    }

    const issues = validateBlocksConfiguration(activeConfig);
    const fatals = issues.filter(i => i && i.severity === 'fatal');
    const warnings = issues.filter(i => i && i.severity === 'warning');

    for (const w of warnings) cfgWarn('⚠️ [Configuration] Block validation warning:', w);
    if (fatals.length > 0) {
      for (const f of fatals) console.error('❌ [Configuration] Block validation error:', f);
      // Keep legacy opticalSystem as-is to avoid breaking the UI.
    } else {
      const expanded = expandBlocksToOpticalSystemRows(activeConfig.blocks);
      for (const w of expanded.issues.filter(i => i && i.severity === 'warning')) cfgWarn('⚠️ [Configuration] Block expand warning:', w);
      const expandFatals = expanded.issues.filter(i => i && i.severity === 'fatal');
      if (expandFatals.length > 0) {
        for (const f of expandFatals) console.error('❌ [Configuration] Block expand error:', f);
      } else {
        const legacyRows = Array.isArray(activeConfig.opticalSystem) ? activeConfig.opticalSystem : null;

        // Prefer expanded rows so block edits are reflected in the UI deterministically.
        // Preserve user-entered legacy semidia where the expanded row doesn't specify it.
        if (legacyRows && legacyRows.length > 0) {
          preserveLegacySemidiaIntoExpanded(expanded.rows, legacyRows);
        }
        if (preservedObjectThickness !== null && expanded.rows[0] && typeof expanded.rows[0] === 'object') {
          expanded.rows[0].thickness = preservedObjectThickness;
        }
        normalizeIdsInPlace(expanded.rows);
        // Ensure provenance keys are present even if expand implementation changes.
        try { overlayProvenance(expanded.rows, expanded.rows); } catch (_) {}
        effectiveOpticalSystem = expanded.rows;
      }
    }
  }
  
  // 各テーブルのlocalStorageに書き込み
  // Source is global. Do not override it on configuration switches.
  // Back-compat: if global source is missing but this config has legacy source, seed it once.
  try {
    const hasGlobal = !!localStorage.getItem('sourceTableData');
    const legacy = Array.isArray(activeConfig.source) ? activeConfig.source : null;
    if (!hasGlobal && legacy && legacy.length > 0) {
      localStorage.setItem('sourceTableData', JSON.stringify(legacy));
    }
  } catch (_) {}
  if (activeConfig.object) {
    localStorage.setItem('objectTableData', JSON.stringify(activeConfig.object));
  }
  if (effectiveOpticalSystem) {
    if (configurationHasBlocks(activeConfig)) {
      // Blocks-only evaluation path should not persist Expanded Optical System rows.
      // This avoids drift between Design Intent and any stale surface-table snapshots.
      try { localStorage.removeItem('OpticalSystemTableData'); } catch (_) {}
    } else {
      localStorage.setItem('OpticalSystemTableData', JSON.stringify(effectiveOpticalSystem));
    }
  }
  
  // Merit Function はグローバルから読み込み
  if (systemConfig.meritFunction) {
    localStorage.setItem('meritFunctionData', JSON.stringify(systemConfig.meritFunction));
  }

  // System Requirements はグローバルから読み込み
  if (systemConfig.systemRequirements) {
    localStorage.setItem('systemRequirementsData', JSON.stringify(systemConfig.systemRequirements));
  }
  
  // System Data をlocalStorageに保存（リロード後も復元できるように）
  if (activeConfig.systemData) {
    localStorage.setItem('systemData', JSON.stringify(activeConfig.systemData));
  } else {
    localStorage.setItem('systemData', JSON.stringify({ referenceFocalLength: '' }));
  }

  // Optional: apply to already-initialized UI (avoids full reload)
  if (options && options.applyToUI) {
    const suppressOpticalSystemDataChanged = (enabled: boolean): void => {
      const key = '__suppressOpticalSystemDataChangedDepth';
      const depth = Number(w[key] || 0);
      if (enabled) {
        w[key] = depth + 1;
        w.__suppressOpticalSystemDataChanged = true;
        return;
      }
      const next = Math.max(0, depth - 1);
      w[key] = next;
      w.__suppressOpticalSystemDataChanged = next > 0;
    };

    const applyTableData = async (table: any, data: any[]): Promise<void> => {
      if (!table || !Array.isArray(data)) return;
      try {
        if (typeof table.blockRedraw === 'function') table.blockRedraw();

        const isOpticalSystemTable = table === w.tableOpticalSystem;
        const shouldSuppress = !!(options && options.suppressOpticalSystemDataChanged && isOpticalSystemTable);
        if (shouldSuppress) {
          suppressOpticalSystemDataChanged(true);
        }

        if (typeof table.replaceData === 'function') {
          await table.replaceData(data);
        } else if (typeof table.setData === 'function') {
          await table.setData(data);
        }

        if (typeof table.redraw === 'function') table.redraw(true);
      } catch (e) {
        cfgWarn('⚠️ [Configuration] Failed to apply table data:', e);
      } finally {
        if (table === w.tableOpticalSystem) {
          // Release on next tick so async Tabulator events (dataChanged) are still suppressed.
          setTimeout(() => suppressOpticalSystemDataChanged(false), 0);
        }
        if (typeof table.restoreRedraw === 'function') table.restoreRedraw();
      }
    };

    // Update tabulator tables if present
    // Source is global; do not swap per config.
    let globalSourceRows: any[] = [];
    try {
      const json = localStorage.getItem('sourceTableData');
      const parsed = json ? JSON.parse(json) : null;
      globalSourceRows = Array.isArray(parsed) ? parsed : [];
    } catch (_) {}

    await applyTableData(w.tableSource, globalSourceRows);
    await applyTableData(w.tableObject, activeConfig.object || []);
    await applyTableData(w.tableOpticalSystem, effectiveOpticalSystem || []);

    // Update system data input (reference focal length)
    try {
      const refFLInput = document.getElementById('reference-focal-length') as HTMLInputElement | null;
      if (refFLInput) {
        refFLInput.value = activeConfig.systemData?.referenceFocalLength?.toString() ?? '';
      }
    } catch (_) {}
  }
  
  cfgLog(`✅ [Configuration] Loaded: ${activeConfig.name}`);
}

// 新しいConfigurationを追加
export function addConfiguration(name: string): number {
  const systemConfig = loadSystemConfigurations();
  
  // 新しいID生成（最大ID + 1）
  const maxId = Math.max(...systemConfig.configurations.map(c => Number(c.id) || 0), 0);
  const newId = maxId + 1;
  
  const newConfig = createDefaultConfiguration(newId, name);
  
  // 現在のアクティブなConfigurationのデータをコピー
  const activeConfig = getActiveConfiguration();
  if (activeConfig) {
    newConfig.object = JSON.parse(JSON.stringify(activeConfig.object));
    newConfig.opticalSystem = JSON.parse(JSON.stringify(activeConfig.opticalSystem));
    if (activeConfig.meritFunction) {
      newConfig.meritFunction = JSON.parse(JSON.stringify(activeConfig.meritFunction));
    }
  }
  
  systemConfig.configurations.push(newConfig);
  saveSystemConfigurations(systemConfig);
  
  cfgLog(`✅ [Configuration] Added new configuration: ${name} (ID: ${newId})`);
  return newId;
}

// Configurationを削除
export function deleteConfiguration(configId: number | string): boolean {
  const systemConfig = loadSystemConfigurations();
  
  // 最後の1つは削除不可
  if (systemConfig.configurations.length <= 1) {
    cfgWarn('⚠️ [Configuration] Cannot delete last configuration');
    return false;
  }
  
  const index = systemConfig.configurations.findIndex(c => idsEqual(c?.id, configId));
  
  if (index === -1) {
    console.error('❌ [Configuration] Config not found:', configId);
    return false;
  }
  
  const configName = systemConfig.configurations[index].name;
  systemConfig.configurations.splice(index, 1);
  
  // アクティブなConfigurationが削除された場合、最初のConfigurationをアクティブに
  if (idsEqual(systemConfig.activeConfigId, configId)) {
    systemConfig.activeConfigId = systemConfig.configurations[0].id;
    cfgLog(`🔄 [Configuration] Active config changed to: ${systemConfig.configurations[0].name}`);
  }
  
  saveSystemConfigurations(systemConfig);
  cfgLog(`✅ [Configuration] Deleted configuration: ${configName}`);
  return true;
}

// Configurationを複製
export function duplicateConfiguration(configId: number | string): number | null {
  const systemConfig = loadSystemConfigurations();
  const sourceConfig = systemConfig.configurations.find(c => c.id === configId);
  
  if (!sourceConfig) {
    console.error('❌ [Configuration] Config not found:', configId);
    return null;
  }
  
  // 新しいID生成
  const maxId = Math.max(...systemConfig.configurations.map(c => Number(c.id) || 0), 0);
  const newId = maxId + 1;
  
  // 完全なコピーを作成
  const newConfig = JSON.parse(JSON.stringify(sourceConfig)) as Configuration;
  newConfig.id = newId;
  newConfig.name = `${sourceConfig.name} (Copy)`;
  newConfig.metadata.created = new Date().toISOString();
  newConfig.metadata.modified = new Date().toISOString();
  
  systemConfig.configurations.push(newConfig);
  saveSystemConfigurations(systemConfig);
  
  cfgLog(`✅ [Configuration] Duplicated configuration: ${newConfig.name} (ID: ${newId})`);
  return newId;
}

// Configuration名を変更
export function renameConfiguration(configId: number | string, newName: string): boolean {
  const systemConfig = loadSystemConfigurations();
  const config = systemConfig.configurations.find(c => c.id === configId);
  
  if (!config) {
    console.error('❌ [Configuration] Config not found:', configId);
    return false;
  }
  
  const oldName = config.name;
  config.name = newName;
  config.metadata.modified = new Date().toISOString();
  
  saveSystemConfigurations(systemConfig);
  cfgLog(`✅ [Configuration] Renamed: ${oldName} → ${newName}`);
  return true;
}

// 全Configuration一覧を取得（テーブル表示用）
export function getConfigurationList(): ConfigurationListItem[] {
  const systemConfig = loadSystemConfigurations();
  return systemConfig.configurations.map(c => ({
    id: c.id,
    name: c.name,
    active: c.id === systemConfig.activeConfigId,
    created: c.metadata.created,
    modified: c.metadata.modified,
    locked: c.metadata.locked
  }));
}

// グローバルにエクスポート
if (typeof window !== 'undefined') {
  w.ConfigurationManager = {
    loadSystemConfigurations,
    saveSystemConfigurations,
    getActiveConfiguration,
    getActiveConfigId,
    setActiveConfiguration,
    saveCurrentToActiveConfiguration,
    loadActiveConfigurationToTables,
    addConfiguration,
    deleteConfiguration,
    duplicateConfiguration,
    renameConfiguration,
    getConfigurationList
  };
}
