/**
 * Toolbar button handlers
 * Extracted from dom-event-handlers.ts for use in React components
 */

import { BLOCK_SCHEMA_VERSION, deriveBlocksFromLegacyOpticalSystemRows } from '../data/block-schema.ts';
import { loadSystemConfigurations, loadPersistedSystemConfigurations, saveSystemConfigurations, clearAllPersistedState, shouldPreferImportedOpticalRows } from '../data/table-configuration.ts';
import { parseZMXArrayBufferToOpticalSystemRows } from '../import-export/zemax-import.ts';
import { getLoadedFileName, setLoadedFileName } from './loaded-file-storage.ts';
import { openJsonFromNativeDialog, openTextFromNativeDialog, saveJsonFromNativeDialog, saveTextFromNativeDialog } from '../src/desktop/adapters/file.ts';
import { basenameFromPath, isTauriRuntime } from '../src/desktop/runtime.ts';
import { generateZmxText, getDefaultProject, getNewProjectTemplate, parseZmxText, readDesktopSetting, recommendWavefrontGrid, runAnalysisPreview, writeDesktopSetting } from '../src/desktop/ipc/client.ts';
import { getOrCreateCooptWindowSyncSenderId } from '../core/window-facade.ts';
import { loadBrowserDefaultProjectJson } from '../utils/default-project-loader.ts';
import { buildShareUrlFromCompressedString, encodeAllDataToCompressedString } from '../utils/url-share.ts';
import { listDesignVariablesFromBlocks } from '../optimization/design-variables.ts';
import { createOptimizationActivityGuard } from '../utils/optimization-activity-guard.ts';

declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

const FORCE_INFINITE_PUPIL_MODE_KEY = 'coopt.forceInfinitePupilMode';
const FORCE_INFINITE_PUPIL_MODE_EVENT = 'coopt-force-infinite-pupil-mode-changed';
const RENDER_DESIGN_INTENT_SYNC_KEY = 'coopt.render.designIntentLiveSync';
const SYSTEM_DATA_STORAGE_KEY = 'coopt.systemDataText';

function clearSystemDataCache(): void {
  try {
    w.__cooptSystemDataText = '';
  } catch (_) {}
  try {
    localStorage.removeItem(SYSTEM_DATA_STORAGE_KEY);
  } catch (_) {}
  try {
    if (typeof w.__cooptPushSystemDataText === 'function') {
      w.__cooptPushSystemDataText('');
      return;
    }
  } catch (_) {}
  try {
    const ids = ['system-data', 'systemData', 'popup-system-data'];
    for (const id of ids) {
      const ta = document.getElementById(id) as HTMLTextAreaElement | null;
      if (ta && typeof ta.value === 'string') {
        ta.value = '';
      }
    }
  } catch (_) {}
}

function unwrapSnapshotLikePayload(input: any): any {
  const raw = input && typeof input === 'object' ? input : null;
  if (!raw) return input;

  // Guard: archive metadata itself is not a design file.
  if (String(raw?.format || '').trim() === 'coopt-escape-snapshots-archive-v1' && !Array.isArray(raw?.configurations)) {
    const e = new Error('This file is archive metadata, not a design snapshot. Please load a file under snapshots/*.json.');
    (e as any).__cooptLoadGuard = 'archive-metadata';
    throw e;
  }

  let wrapped = raw.systemConfigSnapshot
    || (raw.payload && typeof raw.payload === 'object' ? raw.payload.systemConfigSnapshot : null);

  if (!wrapped && typeof raw.systemConfigSnapshot === 'string') {
    try { wrapped = JSON.parse(raw.systemConfigSnapshot); } catch (_) {}
  }
  if (!wrapped && typeof raw?.payload?.systemConfigSnapshot === 'string') {
    try { wrapped = JSON.parse(raw.payload.systemConfigSnapshot); } catch (_) {}
  }

  if (!wrapped || typeof wrapped !== 'object' || !Array.isArray(wrapped.configurations)) {
    return input;
  }

  let out: any = wrapped;
  try { out = JSON.parse(JSON.stringify(wrapped)); } catch (_) { out = wrapped; }

  const rowsSnapshot = Array.isArray(raw.opticalSystemRowsSnapshot)
    ? raw.opticalSystemRowsSnapshot
    : (Array.isArray(raw?.payload?.opticalSystemRowsSnapshot) ? raw.payload.opticalSystemRowsSnapshot : null);
  const cfgs = Array.isArray(out?.configurations) ? out.configurations : [];
  const activeId = String(out?.activeConfigId ?? '').trim();
  const activeCfg = cfgs.find((c: any) => String(c?.id ?? '').trim() === activeId) || cfgs[0];
  if (activeCfg && rowsSnapshot && rowsSnapshot.length > 0 && (!Array.isArray(activeCfg.opticalSystem) || activeCfg.opticalSystem.length === 0)) {
    activeCfg.opticalSystem = rowsSnapshot;
  }

  if (!Array.isArray(out?.source)) {
    if (Array.isArray(raw?.source)) out.source = raw.source;
    else if (Array.isArray(raw?.payload?.source)) out.source = raw.payload.source;
  }
  if (!Array.isArray(out?.object)) {
    if (Array.isArray(raw?.object)) out.object = raw.object;
    else if (Array.isArray(raw?.payload?.object)) out.object = raw.payload.object;
  }
  if (!Array.isArray(out?.meritFunction)) {
    if (Array.isArray(raw?.meritFunction)) out.meritFunction = raw.meritFunction;
    else if (Array.isArray(raw?.payload?.meritFunction)) out.meritFunction = raw.payload.meritFunction;
  }
  if (!Array.isArray(out?.systemRequirements)) {
    if (Array.isArray(raw?.systemRequirements)) out.systemRequirements = raw.systemRequirements;
    else if (Array.isArray(raw?.payload?.systemRequirements)) out.systemRequirements = raw.payload.systemRequirements;
  }

  return out;
}

function isDesignPayloadLike(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  if (Array.isArray((data as any).configurations)) return true;
  if (data.systemConfigurations && Array.isArray(data.systemConfigurations.configurations)) return true;
  if (data.configurations && Array.isArray(data.configurations.configurations)) return true;
  if (Array.isArray(data.opticalSystem) || Array.isArray(data.blocks)) return true;
  return false;
}

function cloneRuntimeSystemConfig(): any {
  try {
    const runtimeSystemConfig = typeof w.loadSystemConfigurations === 'function'
      ? w.loadSystemConfigurations()
      : loadSystemConfigurations();
    return runtimeSystemConfig && typeof runtimeSystemConfig === 'object'
      ? JSON.parse(JSON.stringify(runtimeSystemConfig))
      : null;
  } catch (_) {
    return null;
  }
}

function cloneCanonicalSystemConfig(): any {
  try {
    const persistedSystemConfig = typeof loadPersistedSystemConfigurations === 'function'
      ? loadPersistedSystemConfigurations()
      : null;
    if (persistedSystemConfig && typeof persistedSystemConfig === 'object' && Array.isArray(persistedSystemConfig.configurations) && persistedSystemConfig.configurations.length > 0) {
      return JSON.parse(JSON.stringify(persistedSystemConfig));
    }
  } catch (_) {}
  return cloneRuntimeSystemConfig();
}

function publishRuntimeSystemConfigSnapshot(systemConfig: any, deferMs = 1500): void {
  try {
    const cloned = systemConfig && typeof systemConfig === 'object'
      ? JSON.parse(JSON.stringify(systemConfig))
      : null;
    if (!cloned) return;
    (window as any).__cooptSystemConfig = cloned;
    (window as any).__cooptPreferRuntimeSystemConfig = true;
    (window as any).__cooptDeferDerivedUiUntil = Date.now() + Math.max(0, Number(deferMs) || 0);
  } catch (_) {}
}

function shouldIncludeSystemConfigInRenderPayload(reason: string): boolean {
  void reason;
  return true;
}

function buildLiveRenderSyncPayload(reason = 'render-open') {
  let rows: any[] = [];
  let objectRows: any[] = [];
  let systemConfig: any = null;
  let includeSystemConfig = shouldIncludeSystemConfigInRenderPayload(reason);
  const preferLiveTableRows = !includeSystemConfig;

  try {
    const runtimeSystemConfig = typeof w.loadSystemConfigurations === 'function'
      ? w.loadSystemConfigurations()
      : loadSystemConfigurations();
    if (includeSystemConfig) {
      try {
        systemConfig = JSON.parse(JSON.stringify(runtimeSystemConfig));
      } catch (_) {
        systemConfig = runtimeSystemConfig ?? null;
      }
    }
    const activeConfig = Array.isArray(runtimeSystemConfig?.configurations)
      ? (runtimeSystemConfig.configurations.find((cfg: any) => String(cfg?.id ?? '') === String(runtimeSystemConfig?.activeConfigId ?? ''))
        || runtimeSystemConfig.configurations[0]
        || null)
      : null;
    const preferImportedRows = shouldPreferImportedOpticalRows(activeConfig);

    if (preferImportedRows && !includeSystemConfig) {
      includeSystemConfig = true;
      try {
        systemConfig = JSON.parse(JSON.stringify(runtimeSystemConfig));
      } catch (_) {
        systemConfig = runtimeSystemConfig ?? null;
      }
    }

    if (Array.isArray(activeConfig?.object) && activeConfig.object.length > 0) {
      objectRows = activeConfig.object.slice();
    }

    if (preferLiveTableRows && typeof (window as any).getOpticalSystemRows === 'function') {
      const liveRows = (window as any).getOpticalSystemRows((window as any).tableOpticalSystem);
      if (Array.isArray(liveRows) && liveRows.length > 0) {
        rows = liveRows.slice();
      }
    }

    if (rows.length === 0 && preferImportedRows && Array.isArray(activeConfig?.opticalSystem) && activeConfig.opticalSystem.length > 0) {
      rows = activeConfig.opticalSystem.slice();
    }

    const activeBlocks = Array.isArray(activeConfig?.blocks) ? activeConfig.blocks : [];
    if (rows.length === 0 && activeBlocks.length > 0 && typeof w.expandBlocksToOpticalSystemRows === 'function') {
      const expanded = w.expandBlocksToOpticalSystemRows(activeBlocks);
      const expandedRows = expanded && Array.isArray(expanded.rows) ? expanded.rows : [];
      if (expandedRows.length > 0) {
        rows = expandedRows.slice();
      }
    }

    if (rows.length === 0 && Array.isArray(activeConfig?.opticalSystem) && activeConfig.opticalSystem.length > 0) {
      rows = activeConfig.opticalSystem.slice();
    }
  } catch (_) {}

  if (rows.length === 0) {
    rows = (window as any).getOpticalSystemRows && typeof (window as any).getOpticalSystemRows === 'function'
      ? ((window as any).getOpticalSystemRows((window as any).tableOpticalSystem) || [])
      : [];
  }

  if (objectRows.length === 0) {
    objectRows = (window as any).tableObject && typeof (window as any).tableObject.getData === 'function'
      ? ((window as any).tableObject.getData() || [])
      : [];
  }

  const token = `${Date.now()}-${reason}`;
  return {
    ts: token,
    token,
    rows: Array.isArray(rows) ? rows : [],
    objectRows: Array.isArray(objectRows) ? objectRows : [],
    systemConfig,
    senderId: getOrCreateCooptWindowSyncSenderId(),
  };
}

async function requestRenderWindowRefresh(targetWindow?: any, reason = 'render-open'): Promise<void> {
  const payload = buildLiveRenderSyncPayload(reason);

  try { localStorage.setItem(RENDER_DESIGN_INTENT_SYNC_KEY, 'true'); } catch (_) {}
  try {
    (window as any).__cooptRenderSnapshotRows = payload.rows;
    (window as any).__cooptRenderSnapshotObjectRows = payload.objectRows;
    if (payload.systemConfig && typeof payload.systemConfig === 'object') {
      (window as any).__cooptRenderSnapshotSystemConfig = payload.systemConfig;
    }
  } catch (_) {}

  try {
    if (targetWindow && !targetWindow.closed) {
      try { targetWindow.__cooptRenderSnapshotRows = payload.rows; } catch (_) {}
      try { targetWindow.__cooptRenderSnapshotObjectRows = payload.objectRows; } catch (_) {}
      try { targetWindow.__cooptPendingRenderRows = payload.rows; } catch (_) {}
      try { targetWindow.__cooptPendingRenderObjectRows = payload.objectRows; } catch (_) {}
      try {
        if (payload.systemConfig && typeof payload.systemConfig === 'object') {
          targetWindow.__cooptRenderSnapshotSystemConfig = payload.systemConfig;
          targetWindow.__cooptPendingRenderSystemConfig = payload.systemConfig;
          targetWindow.__cooptSystemConfig = payload.systemConfig;
          targetWindow.__cooptPreferRuntimeSystemConfig = true;
        }
      } catch (_) {}
      if (typeof targetWindow.__cooptRenderWindowRedraw === 'function') {
        await Promise.resolve(targetWindow.__cooptRenderWindowRedraw(payload.rows, payload.token, payload.objectRows));
      } else if (typeof targetWindow.postMessage === 'function') {
        targetWindow.postMessage({ action: 'request-redraw', rows: payload.rows, objectRows: payload.objectRows, systemConfig: payload.systemConfig, ts: payload.token, token: payload.token }, '*');
      }
    }
  } catch (_) {}

  try {
    localStorage.setItem('coopt.renderSyncRequest', JSON.stringify(payload));
  } catch (_) {}

  if (!isTauriRuntime()) return;

  try {
    const mod = await import('@tauri-apps/api/event');
    if (mod && typeof (mod as any).emit === 'function') {
      await (mod as any).emit('coopt-render-sync-request', payload);
    }
  } catch (_) {}
}

function sanitizeForceInfinitePupilMode(v: any): 'stop' | 'entrance' | '' {
  const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
  return (s === 'stop' || s === 'entrance') ? s : '';
}

function readForceInfinitePupilModeFromWindow(target: any): 'stop' | 'entrance' | '' {
  if (!target) return '';
  try {
    if (typeof target.__cooptGetForceInfinitePupilMode === 'function') {
      const m = sanitizeForceInfinitePupilMode(target.__cooptGetForceInfinitePupilMode());
      if (m) return m;
    }
  } catch (_) {}
  try {
    return sanitizeForceInfinitePupilMode(target.__COOPT_FORCE_INFINITE_PUPIL_MODE ?? target.COOPT_FORCE_INFINITE_PUPIL_MODE);
  } catch (_) {
    return '';
  }
}

function readPersistedForceInfinitePupilMode(): 'stop' | 'entrance' | '' {
  try {
    return sanitizeForceInfinitePupilMode(localStorage.getItem(FORCE_INFINITE_PUPIL_MODE_KEY));
  } catch (_) {
    return '';
  }
}

function writePersistedForceInfinitePupilMode(mode: string): void {
  const m = sanitizeForceInfinitePupilMode(mode);
  try {
    if (m) localStorage.setItem(FORCE_INFINITE_PUPIL_MODE_KEY, m);
    else localStorage.removeItem(FORCE_INFINITE_PUPIL_MODE_KEY);
  } catch (_) {}
}

async function readDesktopForceInfinitePupilMode(): Promise<'stop' | 'entrance' | ''> {
  try {
    const invoke = (window as any)?.__TAURI_INTERNALS__?.invoke || (window as any)?.__TAURI__?.core?.invoke;
    if (typeof invoke === 'function') {
      const raw = await invoke('read_desktop_setting', { key: FORCE_INFINITE_PUPIL_MODE_KEY });
      return sanitizeForceInfinitePupilMode(raw);
    }
    const v = await readDesktopSetting(FORCE_INFINITE_PUPIL_MODE_KEY);
    return sanitizeForceInfinitePupilMode(v);
  } catch (_) {
    return '';
  }
}

async function writeDesktopForceInfinitePupilMode(mode: string): Promise<void> {
  const m = sanitizeForceInfinitePupilMode(mode);
  try {
    const invoke = (window as any)?.__TAURI_INTERNALS__?.invoke || (window as any)?.__TAURI__?.core?.invoke;
    if (typeof invoke === 'function') {
      await invoke('write_desktop_setting', { key: FORCE_INFINITE_PUPIL_MODE_KEY, value: m || null });
      return;
    }
  } catch (_) {}
  await writeDesktopSetting(FORCE_INFINITE_PUPIL_MODE_KEY, m || null);
}

function applyForceInfinitePupilModeToWindow(target: any, mode: string): void {
  if (!target) return;
  const m = sanitizeForceInfinitePupilMode(mode);
  try {
    if (typeof target.__cooptSetForceInfinitePupilMode === 'function') {
      target.__cooptSetForceInfinitePupilMode(m);
      return;
    }
  } catch (_) {}
  try {
    if (m) {
      target.__COOPT_FORCE_INFINITE_PUPIL_MODE = m;
      target.COOPT_FORCE_INFINITE_PUPIL_MODE = m;
    } else {
      try { delete target.__COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { target.__COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
      try { delete target.COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { target.COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
    }
  } catch (_) {}
}

function getCurrentForceInfinitePupilMode(): 'stop' | 'entrance' | '' {
  const fromWindow = readForceInfinitePupilModeFromWindow(window);
  if (fromWindow) return fromWindow;
  return readPersistedForceInfinitePupilMode();
}

function installDesktopForceInfinitePupilModeBridge(): void {
  if (!isTauriRuntime()) return;
  if (w.__cooptForceInfinitePupilModeBridgeInstalled) return;
  w.__cooptForceInfinitePupilModeBridgeInstalled = true;

  w.__cooptBroadcastForceInfinitePupilMode = (mode: any) => {
    const m = sanitizeForceInfinitePupilMode(mode);
    applyForceInfinitePupilModeToWindow(window, m);
    writePersistedForceInfinitePupilMode(m);
    (async () => {
      await writeDesktopForceInfinitePupilMode(m);
      try {
        const mod = await import('@tauri-apps/api/event');
        if (mod && typeof (mod as any).emit === 'function') {
          await (mod as any).emit(FORCE_INFINITE_PUPIL_MODE_EVENT, { mode: m });
        }
        if (mod && typeof (mod as any).emitTo === 'function') {
          try { await (mod as any).emitTo('main', FORCE_INFINITE_PUPIL_MODE_EVENT, { mode: m }); } catch (_) {}
          try { await (mod as any).emitTo('settings-window', FORCE_INFINITE_PUPIL_MODE_EVENT, { mode: m }); } catch (_) {}
        }
      } catch (_) {}
    })();
  };

  w.__cooptReadDesktopSetting = async (key: string) => {
    try {
      return await readDesktopSetting(String(key || ''));
    } catch (_) {
      return null;
    }
  };

  w.__cooptWriteDesktopSetting = async (key: string, value: string | null) => {
    try {
      await writeDesktopSetting(String(key || ''), value);
    } catch (_) {}
  };

  (async () => {
    let shouldKeepRuntimeSnapshot = false;
    try {
      const mod = await import('@tauri-apps/api/event');
      if (!mod || typeof (mod as any).listen !== 'function') return;
      const unlisten = await (mod as any).listen(FORCE_INFINITE_PUPIL_MODE_EVENT, (event: any) => {
        const m = sanitizeForceInfinitePupilMode(event?.payload?.mode);
        applyForceInfinitePupilModeToWindow(window, m);
        writePersistedForceInfinitePupilMode(m);
        void writeDesktopForceInfinitePupilMode(m);
      });
      w.__cooptForceInfinitePupilModeBridgeUnlisten = unlisten;
    } catch (_) {}
  })();

  // Hydrate from desktop-shared store for windows with isolated localStorage.
  (async () => {
    const m = await readDesktopForceInfinitePupilMode();
    if (!m) return;
    applyForceInfinitePupilModeToWindow(window, m);
    writePersistedForceInfinitePupilMode(m);
  })();
}

export function handleNewFile(): void {
  if (!isTauriRuntime() && !confirm('Create new file? Current data will be cleared.')) return;
  
  try {
    if (isTauriRuntime()) {
      (async () => {
        try {
          const { project } = await getNewProjectTemplate();
          if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
            await (window as any).__loadAllDataObjectIntoApp(project, { filename: 'new-project-template.json' });
          }
          setLoadedFileName('new-project-template.json');
          try {
            window.dispatchEvent(new CustomEvent('coopt:loaded-file-updated'));
          } catch (_) {}
          console.log('✅ [New File] Loaded Rust template project.');
        } catch (desktopErr) {
          console.error('❌ [New File] Rust template load failed:', desktopErr);
          alert(`New file failed: ${(desktopErr as Error)?.message || String(desktopErr)}`);
        }
      })();
      return;
    }

    console.log('🔵 [New File] Clearing localStorage and creating default configuration...');
    clearAllPersistedState();
    
    const defaultConfig = {
      id: 1,
      name: 'Config 1',
      schemaVersion: BLOCK_SCHEMA_VERSION,
      blocks: [
        {
          blockId: 'ObjectSurface-1',
          blockType: 'ObjectSurface',
          role: null,
          constraints: {},
          parameters: { objectDistanceMode: 'INF', objectDistance: 10 },
          variables: {},
          metadata: { source: 'default' }
        },
        {
          blockId: 'Stop-1',
          blockType: 'Stop',
          role: null,
          constraints: {},
          parameters: { semiDiameter: 10 },
          variables: {},
          metadata: { source: 'default' }
        },
        {
          blockId: 'ImageSurface-1',
          blockType: 'ImageSurface',
          role: null,
          constraints: {},
          parameters: { semidiaMode: 'Manual' },
          variables: {},
          metadata: { source: 'default' }
        }
      ],
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
      systemData: { referenceFocalLength: '' },
      metadata: {
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        locked: false
      },
      meritFunction: []
    };
    
    const systemConfig = {
      configurations: [defaultConfig],
      activeConfigId: 1,
      meritFunction: [],
      systemRequirements: [],
      optimizationRules: {}
    };
    
    saveSystemConfigurations(systemConfig);
    console.log('✅ [New File] Default configuration created, reloading...');
    location.reload();
  } catch (err) {
    console.error('❌ Failed to create new file:', err);
    alert('Failed to create new file. See console for details.');
  }
}

function getSanitizedConfigurationsForExport(): any {
  const parsedConfig = (() => {
    try {
      if (typeof localStorage === 'undefined') return null;
      return loadSystemConfigurations();
    } catch {
      return null;
    }
  })();

  const liveSource = w.tableSource ? w.tableSource.getData() : [];
  const liveObject = w.tableObject ? w.tableObject.getData() : [];
  const liveOpticalSystem = w.tableOpticalSystem ? w.tableOpticalSystem.getData() : [];
  const liveMeritFunction = w.meritFunctionEditor ? w.meritFunctionEditor.getData() : [];
  const liveSystemRequirements = w.systemRequirementsEditor ? w.systemRequirementsEditor.getData() : [];
  const refFLInput = document.getElementById('reference-focal-length') as HTMLInputElement | null;
  
  const sanitizedConfig = parsedConfig ? JSON.parse(JSON.stringify(parsedConfig)) : null;
  if (sanitizedConfig) {
    try {
      const activeId = sanitizedConfig.activeConfigId;
      const activeCfg = Array.isArray(sanitizedConfig.configurations)
        ? (sanitizedConfig.configurations.find((cfg: any) => String(cfg?.id) === String(activeId)) || sanitizedConfig.configurations[0])
        : null;
      if (activeCfg && typeof activeCfg === 'object') {
        activeCfg.source = liveSource;
        activeCfg.object = liveObject;
        activeCfg.opticalSystem = liveOpticalSystem;
        activeCfg.systemData = {
          ...(activeCfg.systemData && typeof activeCfg.systemData === 'object' ? activeCfg.systemData : {}),
          referenceFocalLength: refFLInput ? refFLInput.value : ''
        };
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
      }
      sanitizedConfig.meritFunction = liveMeritFunction;
      sanitizedConfig.systemRequirements = liveSystemRequirements;
    } catch (_) {}
    try { delete sanitizedConfig.meritFunction; } catch (_) {}
    try { delete sanitizedConfig.systemRequirements; } catch (_) {}
    try {
      if (Array.isArray(sanitizedConfig.configurations)) {
        for (const cfg of sanitizedConfig.configurations) {
          if (cfg && typeof cfg === 'object') {
            try { delete cfg.source; } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }
  return sanitizedConfig;
}

function buildAllDataForExport(): any {
  const refFLInput = document.getElementById('reference-focal-length') as HTMLInputElement;
  const referenceFocalLength = refFLInput ? refFLInput.value : '';

  let opticalSystemData = w.tableOpticalSystem ? w.tableOpticalSystem.getData() : [];
  
  try {
    const systemConfig = (typeof w.loadSystemConfigurations === 'function') 
      ? w.loadSystemConfigurations() 
      : null;
    const activeId = systemConfig?.activeConfigId;
    const activeCfg = Array.isArray(systemConfig?.configurations)
      ? (systemConfig.configurations.find((c: any) => String(c?.id) === String(activeId)) || systemConfig.configurations[0])
      : null;
    
    const configurationHasBlocks = (cfg: any) => {
      try {
        return cfg && Array.isArray(cfg.blocks) && cfg.blocks.length > 0;
      } catch (_) { return false; }
    };
    
    if (activeCfg && configurationHasBlocks(activeCfg)) {
      if (typeof w.expandBlocksToOpticalSystemRows === 'function') {
        const expanded = w.expandBlocksToOpticalSystemRows(activeCfg.blocks);
        if (expanded && Array.isArray(expanded.rows)) {
          opticalSystemData = expanded.rows;
        }
      }
    }
  } catch (_) {}

  return {
    source: w.tableSource ? w.tableSource.getData() : [],
    object: w.tableObject ? w.tableObject.getData() : [],
    opticalSystem: opticalSystemData,
    meritFunction: w.meritFunctionEditor ? w.meritFunctionEditor.getData() : [],
    systemRequirements: w.systemRequirementsEditor ? w.systemRequirementsEditor.getData() : [],
    systemData: {
      referenceFocalLength: referenceFocalLength
    },
    configurations: getSanitizedConfigurationsForExport()
  };
}

function __compactSharePayloadValue(value: any): any {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const compacted = value
      .map((item) => __compactSharePayloadValue(item))
      .filter((item) => item !== undefined);
    return compacted.length > 0 ? compacted : undefined;
  }
  if (typeof value !== 'object') {
    return value;
  }

  const compacted: any = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'modified') continue;
    if (key === 'referenceFocalLength' && String(raw ?? '').trim() === '') continue;
    const next = __compactSharePayloadValue(raw);
    if (next !== undefined) {
      compacted[key] = next;
    }
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function buildAllDataForShareExport(): any {
  const configurations = getSanitizedConfigurationsForExport();
  if (!configurations || !Array.isArray(configurations.configurations)) {
    return buildAllDataForExport();
  }

  const shareConfigurations = JSON.parse(JSON.stringify(configurations));
  try {
    if (Array.isArray(shareConfigurations.configurations)) {
      for (const cfg of shareConfigurations.configurations) {
        if (!cfg || typeof cfg !== 'object') continue;
        if (Array.isArray(cfg.blocks) && cfg.blocks.length > 0) {
          delete cfg.opticalSystem;
        }
        if (cfg.metadata && typeof cfg.metadata === 'object') {
          delete cfg.metadata.modified;
          if (Object.keys(cfg.metadata).length === 0) delete cfg.metadata;
        }
        if (cfg.systemData && typeof cfg.systemData === 'object') {
          const refFL = String(cfg.systemData.referenceFocalLength ?? '').trim();
          if (!refFL) delete cfg.systemData.referenceFocalLength;
          if (Object.keys(cfg.systemData).length === 0) delete cfg.systemData;
        }
      }
    }
  } catch (_) {}

  return __compactSharePayloadValue({
    configurations: shareConfigurations,
    meritFunction: w.meritFunctionEditor ? w.meritFunctionEditor.getData() : [],
    systemRequirements: w.systemRequirementsEditor ? w.systemRequirementsEditor.getData() : []
  }) ?? { configurations: shareConfigurations };
}

function showShareUrlLengthOnButton(urlLength: number): void {
  const btn = document.getElementById('share-url-btn') as HTMLButtonElement | null;
  if (!btn) return;

  const nextLabel = `Share URL (${urlLength} chars)`;
  const restoreMs = 8000;
  const previousTimer = Number((btn as any).__cooptShareUrlLabelTimer);
  if (Number.isFinite(previousTimer) && previousTimer > 0) {
    window.clearTimeout(previousTimer);
  }

  if (!(btn as any).__cooptShareUrlLabelOriginal) {
    (btn as any).__cooptShareUrlLabelOriginal = btn.textContent || 'Share URL';
  }

  btn.textContent = nextLabel;
  btn.title = nextLabel;

  const restoreLabel = String((btn as any).__cooptShareUrlLabelOriginal || 'Share URL');
  (btn as any).__cooptShareUrlLabelTimer = window.setTimeout(() => {
    btn.textContent = restoreLabel;
    btn.title = restoreLabel;
    (btn as any).__cooptShareUrlLabelTimer = 0;
  }, restoreMs);
}

function showShareUrlLengthBanner(urlLength: number): void {
  const bannerId = 'coopt-share-url-banner';
  let banner = document.getElementById(bannerId) as HTMLDivElement | null;
  if (!banner) {
    banner = document.createElement('div');
    banner.id = bannerId;
    banner.style.position = 'fixed';
    banner.style.top = '14px';
    banner.style.right = '14px';
    banner.style.zIndex = '2147483647';
    banner.style.padding = '10px 14px';
    banner.style.borderRadius = '10px';
    banner.style.border = '1px solid rgba(15, 23, 42, 0.14)';
    banner.style.background = 'rgba(15, 23, 42, 0.94)';
    banner.style.color = '#f8fafc';
    banner.style.fontSize = '12px';
    banner.style.fontWeight = '600';
    banner.style.letterSpacing = '0.01em';
    banner.style.boxShadow = '0 12px 30px rgba(15, 23, 42, 0.28)';
    banner.style.opacity = '0';
    banner.style.transform = 'translateY(-6px)';
    banner.style.transition = 'opacity 140ms ease, transform 140ms ease';
    banner.style.pointerEvents = 'none';
    document.body.appendChild(banner);
  }

  const message = `Share URL length: ${urlLength} chars`;
  banner.textContent = message;
  banner.title = message;
  banner.style.opacity = '1';
  banner.style.transform = 'translateY(0)';

  const previousTimer = Number((banner as any).__cooptHideTimer);
  if (Number.isFinite(previousTimer) && previousTimer > 0) {
    window.clearTimeout(previousTimer);
  }

  (banner as any).__cooptHideTimer = window.setTimeout(() => {
    banner!.style.opacity = '0';
    banner!.style.transform = 'translateY(-6px)';
    (banner as any).__cooptHideTimer = 0;
  }, 5000);
}

function announceShareUrlLength(urlLength: number): void {
  try {
    const loadedFileName = document.getElementById('loaded-file-name') as HTMLSpanElement | null;
    if (loadedFileName) {
      loadedFileName.textContent = `Share URL: ${urlLength} chars`;
      loadedFileName.style.color = '#0f766e';
    }
  } catch (_) {}

  try {
    window.dispatchEvent(new CustomEvent('coopt:share-url-generated', {
      detail: { urlLength }
    }));
  } catch (_) {}
}

export function handleSave(): void {
  try {
    if (document.activeElement) (document.activeElement as HTMLElement).blur();

    const allData = buildAllDataForExport();
    const serialized = JSON.stringify(allData, null, 2);

    if (isTauriRuntime()) {
      (async () => {
        try {
          const savedPath = await saveJsonFromNativeDialog(serialized);
          if (!savedPath) return;
          const filename = basenameFromPath(savedPath);
          setLoadedFileName(filename);
          try {
            window.dispatchEvent(new CustomEvent('coopt:loaded-file-updated'));
          } catch (_) {}
          console.log('✅ データが保存されました:', savedPath);
        } catch (nativeErr) {
          console.error('❌ Native save failed:', nativeErr);
          alert(`Native save failed: ${(nativeErr as Error)?.message || String(nativeErr)}`);
        }
      })();
      return;
    }

    const loadedFileName = getLoadedFileName();
    let defaultName = 'optical_system_data';
    
    if (loadedFileName) {
      defaultName = loadedFileName.replace(/\.json$/i, '');
    }

    let filename = prompt(
      "保存するファイル名を入力してください（拡張子 .json は自動で付きます）\n\n" +
      "※ダウンロードフォルダに既存ファイルがある場合はブラウザが自動的に連番を付けます",
      defaultName
    );
    
    if (!filename) return;
    if (!filename.endsWith('.json')) filename += '.json';

    const blob = new Blob([serialized], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    
    setLoadedFileName(filename);
    try {
      window.dispatchEvent(new CustomEvent('coopt:loaded-file-updated'));
    } catch (_) {}
    console.log('✅ データが保存されました:', filename);
  } catch (err) {
    console.error('❌ Failed to save:', err);
    alert(`Save failed: ${(err as Error)?.message || String(err)}`);
  }
}

export async function handleLoadDefault(): Promise<void> {
  if (!isTauriRuntime() && !confirm('Load default optical system? Current data will be replaced.')) return;
  
  try {
    clearSystemDataCache();
    if (isTauriRuntime()) {
      const { project } = await getDefaultProject();
      if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
        const ok = await (window as any).__loadAllDataObjectIntoApp(project, { filename: 'default-load.json' });
        if (!ok) throw new Error('Default project load returned false.');
      }
      setLoadedFileName('default-load.json');
      try {
        window.dispatchEvent(new CustomEvent('coopt:loaded-file-updated'));
      } catch (_) {}
      return;
    }

    const data = await loadBrowserDefaultProjectJson();
    
    if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
      const ok = await (window as any).__loadAllDataObjectIntoApp(data, { filename: 'default-load.json' });
      if (!ok) throw new Error('Default project load returned false.');
    }
    setLoadedFileName('default-load.json');
    try {
      window.dispatchEvent(new CustomEvent('coopt:loaded-file-updated'));
    } catch (_) {}
  } catch (err) {
    console.error('❌ Failed to load default system:', err);
    alert('Failed to load default optical system. Check console for details.');
  }
}

export function handleLoad(): void {
  if (isTauriRuntime()) {
    (async () => {
      try {
        const picked = await openJsonFromNativeDialog();
        if (!picked) return;
        clearSystemDataCache();
        const data = unwrapSnapshotLikePayload(JSON.parse(picked.content));
        if (!isDesignPayloadLike(data)) {
          throw new Error('Selected JSON is not a loadable design format. Choose a design file or snapshots/*.json.');
        }
        const loadedFilename = basenameFromPath(picked.path);
        if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
          const ok = await (window as any).__loadAllDataObjectIntoApp(data, { filename: loadedFilename });
          if (!ok) {
            const reason = String((window as any).__cooptLastLoadFailureReason || '').trim();
            throw new Error(reason ? `App loader returned false (${reason}).` : 'App loader returned false (reason unavailable; reload app and retry).');
          }
        }
        setLoadedFileName(loadedFilename);
        try {
          window.dispatchEvent(new CustomEvent('coopt:loaded-file-updated'));
        } catch (_) {}
        console.log('✅ File loaded:', picked.path);
      } catch (err) {
        console.error('❌ Failed to load file (native):', err);
        alert(`Load failed: ${(err as Error)?.message || String(err)}`);
      }
    })();
    return;
  }

  try {
    if ((window as any).__cooptFileLoadInProgress) {
      console.warn('⚠️ [Load] File load already in progress');
      return;
    }
  } catch (_) {}

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.style.display = 'none';
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      input.value = '';
    } catch (_) {}
    try {
      if (input.parentNode) {
        input.parentNode.removeChild(input);
      }
    } catch (_) {}
    try {
      window.removeEventListener('focus', onWindowFocusAfterPicker, true);
    } catch (_) {}
  };

  const onWindowFocusAfterPicker = () => {
    window.setTimeout(() => {
      try {
        const hasFile = !!(input.files && input.files.length > 0);
        if (!hasFile) {
          cleanup();
        }
      } catch (_) {
        cleanup();
      }
    }, 0);
  };
  
  input.onchange = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target?.files?.[0];
    if (!file) {
      cleanup();
      return;
    }
    
    try {
      clearSystemDataCache();
      const text = await file.text();
      const data = unwrapSnapshotLikePayload(JSON.parse(text));
      if (!isDesignPayloadLike(data)) {
        throw new Error('Selected JSON is not a loadable design format. Choose a design file or snapshots/*.json.');
      }
      
      if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
        const ok = await (window as any).__loadAllDataObjectIntoApp(data, { filename: file.name });
        if (!ok) {
          const reason = String((window as any).__cooptLastLoadFailureReason || '').trim();
          throw new Error(reason ? `App loader returned false (${reason}).` : 'App loader returned false (reason unavailable; reload app and retry).');
        }
      }
      setLoadedFileName(file.name);
      try {
        window.dispatchEvent(new CustomEvent('coopt:loaded-file-updated'));
      } catch (_) {}
      console.log('✅ File loaded:', file.name);
    } catch (err) {
      console.error('❌ Failed to load file:', err);
      alert(`Load failed: ${(err as Error)?.message || String(err)}`);
    } finally {
      cleanup();
    }
  };
  
  document.body.appendChild(input);
  window.addEventListener('focus', onWindowFocusAfterPicker, true);
  input.click();
}

export function handleClearStorage(): void {
  if (!isTauriRuntime() && !confirm(
    '⚠️ ローカルストレージをクリアします。すべての未保存データが失われます。\n\n' +
    'Clear localStorage? All unsaved data will be lost.'
  )) return;
  
  try {
    clearAllPersistedState();
    console.log('✅ localStorage cleared');
    alert('Storage cleared. Page will reload.');
    location.reload();
  } catch (err) {
    console.error('❌ Failed to clear storage:', err);
    alert(`Clear storage failed: ${(err as Error)?.message || String(err)}`);
  }
}

export async function handleShareUrl(): Promise<void> {
  try {
    if (document.activeElement) (document.activeElement as HTMLElement).blur();

    let compressed: string;
    try {
      const allData = buildAllDataForShareExport();
      compressed = await encodeAllDataToCompressedString(allData);
    } catch (encodeErr) {
      alert((encodeErr as Error)?.message || 'Failed to generate share URL');
      return;
    }

    const base = `${location.origin}${location.pathname}`;
    const url = buildShareUrlFromCompressedString(compressed, base);

    const urlLength = url.length;
    announceShareUrlLength(urlLength);
    showShareUrlLengthOnButton(urlLength);
    showShareUrlLengthBanner(urlLength);
    if (urlLength >= 2000) {
      const ok = confirm(`Share URL is long (${urlLength} chars) and may not work in some apps.\n\nContinue?`);
      if (!ok) return;
    }

    // Show the length synchronously in a modal before any async clipboard call.
    prompt(`Share URL (${urlLength} chars):`, url);

    try {
      await navigator.clipboard.writeText(url);
    } catch (_) {
      prompt(`Copy this URL (${urlLength} chars):`, url);
    }
  } catch (err) {
    alert(`Share failed: ${(err as Error)?.message || String(err)}`);
  }
}

function __coopt_isInfLike(value: any): boolean {
  if (value === Infinity) return true;
  const s = String(value ?? '').trim().toUpperCase();
  return s === 'INF' || s === 'INFINITY' || s === '∞';
}

const __COOPT_DEFAULT_INF_OBJECT_DISTANCE_MM = 10;

function __coopt_buildFallbackBlocksFromRows(rows: any[]): any[] {
  const safeRows = Array.isArray(rows) ? rows : [];
  const blocks: any[] = [];

  const inferImageSemidia = (): number | null => {
    for (let idx = safeRows.length - 1; idx >= 0; idx--) {
      const row = safeRows[idx] || {};
      const raw = row?.semidia ?? row?.semiDiameter ?? row?.semiDia ?? row?.['semi diameter'] ?? row?.['Semi Diameter'];
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };

  const first = safeRows[0] || {};
  const objectDistanceMode = __coopt_isInfLike(first?.thickness) ? 'INF' : 'Finite';
  const objectDistanceVal = Number(first?.thickness);
  const objectRenderDistanceVal = Number(first?.objectRenderDistance);
  const objectParameters = objectDistanceMode === 'INF'
    ? { objectDistanceMode: 'INF' }
    : { objectDistanceMode: 'Finite' };
  if (objectDistanceMode === 'INF') {
    if (Number.isFinite(objectRenderDistanceVal) && objectRenderDistanceVal > 0) objectParameters.objectDistance = objectRenderDistanceVal;
    else objectParameters.objectDistance = __COOPT_DEFAULT_INF_OBJECT_DISTANCE_MM;
  } else if (Number.isFinite(objectDistanceVal) && objectDistanceVal > 0) {
    objectParameters.objectDistance = objectDistanceVal;
  }
  blocks.push({
    blockId: 'ObjectSurface-1',
    blockType: 'ObjectSurface',
    role: null,
    constraints: {},
    parameters: objectParameters,
    variables: {},
    metadata: { source: 'zemax-fallback' }
  });

  let stopCount = 0;
  let singleCount = 0;
  let gapCount = 0;

  const end = Math.max(1, safeRows.length - 1);
  for (let i = 1; i < end; i++) {
    const row = safeRows[i] || {};
    const objType = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
    const isStop = objType === 'stop' || objType === 'sto';

    if (isStop) {
      stopCount++;
      const stopSemidiaRaw = row?.semidia ?? row?.semiDiameter ?? row?.semiDia ?? row?.['semi diameter'] ?? row?.['Semi Diameter'];
      const sdNum = Number(stopSemidiaRaw);
      blocks.push({
        blockId: `Stop-${stopCount}`,
        blockType: 'Stop',
        role: null,
        constraints: {},
        parameters: Number.isFinite(sdNum) && sdNum > 0 ? { semiDiameter: sdNum } : {},
        variables: {},
        metadata: { source: 'zemax-fallback' }
      });

      const tRaw = row?.thickness;
      const tNum = Number(tRaw);
      const hasGap = __coopt_isInfLike(tRaw) || (Number.isFinite(tNum) && Math.abs(tNum) > 1e-12);
      if (hasGap) {
        gapCount++;
        blocks.push({
          blockId: `Gap-${gapCount}`,
          blockType: 'Gap',
          role: null,
          constraints: {},
          parameters: { thickness: __coopt_isInfLike(tRaw) ? 'INF' : tNum, material: 'AIR' },
          variables: {},
          metadata: { source: 'zemax-fallback', from: 'stop-thickness' }
        });
      }
      continue;
    }

    singleCount++;
    const surfTypeRaw = String(row?.surfType ?? '').trim();
    const surfType = surfTypeRaw || 'Spherical';
    const radius = __coopt_isInfLike(row?.radius) ? 'INF' : (String(row?.radius ?? '').trim() === '' ? 'INF' : row.radius);
    const tRaw = row?.thickness;
    const tNum = Number(tRaw);
    const thickness = __coopt_isInfLike(tRaw) ? 'INF' : (Number.isFinite(tNum) ? tNum : 0);
    const material = String(row?.material ?? '').trim();
    const conicNum = Number(row?.conic);

    const params: any = {
      radius,
      thickness,
      material,
      surfType,
      conic: Number.isFinite(conicNum) ? conicNum : 0,
      semidia: row?.semidia ?? ''
    };

    const qconNradNum = Number(row?.qconNrad);
    if (surfType === 'Qcon' && Number.isFinite(qconNradNum)) {
      params.qconNrad = qconNradNum;
    }

    if (surfType === 'Toric') {
      params.radiusX = __coopt_isInfLike(row?.radiusX) ? 'INF' : (String(row?.radiusX ?? '').trim() === '' ? 'INF' : row.radiusX);
      params.radiusY = __coopt_isInfLike(row?.radiusY) ? 'INF' : (String(row?.radiusY ?? '').trim() === '' ? 'INF' : row.radiusY);
      const axisNum = Number(row?.axis);
      params.axis = Number.isFinite(axisNum) ? axisNum : 0;
    }

    for (let k = 1; k <= 10; k++) {
      const n = Number(row?.[`coef${k}`]);
      params[`coef${k}`] = Number.isFinite(n) ? n : 0;
    }

    blocks.push({
      blockId: `SingleSurface-${singleCount}`,
      blockType: 'SingleSurface',
      role: null,
      constraints: {},
      parameters: params,
      variables: {},
      metadata: { source: 'zemax-fallback', rowIndex: i }
    });
  }

  const imageSemidia = inferImageSemidia();
  blocks.push({
    blockId: 'ImageSurface-1',
    blockType: 'ImageSurface',
    role: null,
    constraints: {},
    parameters: Number.isFinite(imageSemidia as any) && (imageSemidia as number) > 0
      ? { semidia: imageSemidia, semidiaMode: 'Auto', optimizeSemiDia: 'A' }
      : { semidiaMode: 'Auto', optimizeSemiDia: 'A' },
    variables: {},
    metadata: { source: 'zemax-fallback' }
  });

  return blocks;
}

function __coopt_shouldAcceptDerivedBlocks(blocks: any[], rows: any[]): boolean {
  if (!Array.isArray(blocks) || blocks.length === 0) return false;

  const physicalBlocks = blocks.filter((block: any) => {
    const blockType = String(block?.blockType ?? '').trim();
    return blockType !== 'ObjectSurface' && blockType !== 'ObjectPlane' && blockType !== 'ImageSurface';
  });

  if (physicalBlocks.length === 0) return false;

  const physicalRowCount = Math.max(0, (Array.isArray(rows) ? rows.length : 0) - 2);
  if (physicalRowCount >= 4 && physicalBlocks.length <= 1) return false;

  return true;
}

function __coopt_normalizeObjectDistanceInBlocks(blocks: any[]): any[] {
  if (!Array.isArray(blocks)) return [];

  let hasObjectSurface = false;
  for (const block of blocks) {
    if (!block || block.blockType !== 'ObjectSurface') continue;
    hasObjectSurface = true;
    const params = (block.parameters && typeof block.parameters === 'object')
      ? block.parameters
      : (block.parameters = {});

    const modeRaw = String(params.objectDistanceMode ?? '').trim();
    const infMode = __coopt_isInfLike(modeRaw);
    if (infMode) {
      params.objectDistanceMode = 'INF';
      const dInf = Number(params.objectDistance);
      if (Number.isFinite(dInf) && dInf > 0) params.objectDistance = dInf;
      else params.objectDistance = __COOPT_DEFAULT_INF_OBJECT_DISTANCE_MM;
      continue;
    }

    params.objectDistanceMode = 'Finite';
    const d = Number(params.objectDistance);
    if (Number.isFinite(d) && d > 0) params.objectDistance = d;
    else delete params.objectDistance;
  }

  if (!hasObjectSurface) {
    blocks.unshift({
      blockId: 'ObjectSurface-1',
      blockType: 'ObjectSurface',
      role: null,
      constraints: {},
      parameters: { objectDistanceMode: 'Finite' },
      variables: {},
      metadata: { source: 'zemax-fallback', inserted: true }
    });
  }

  return blocks;
}

function __cooptIsSemidiaMissing(row: any): boolean {
  const raw = row?.semidia ?? row?.semiDiameter ?? row?.semiDia ?? row?.['semi diameter'] ?? row?.['Semi Diameter'];
  if (raw === null || raw === undefined) return true;
  const text = String(raw).trim();
  if (text === '') return true;
  const n = Number(text);
  return !(Number.isFinite(n) && n > 0);
}

function __cooptHasAnyMissingSemidia(rows: any[]): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.some((row: any, index: number) => {
    const objType = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
    if (objType === 'object') return false;
    if (objType === 'ct') return false;
    if (index === 0) return false;
    return __cooptIsSemidiaMissing(row);
  });
}

function __cooptIsImageSemidiaMissing(rows: any[]): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return true;
  const imageIndex = rows.findIndex((row: any, index: number) => {
    if (index === rows.length - 1) return true;
    const objType = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
    return objType === 'image';
  });
  if (imageIndex < 0) return true;
  return __cooptIsSemidiaMissing(rows[imageIndex]);
}

export function handleImportZemax(): void {
  if (isTauriRuntime()) {
    (async () => {
      try {
        const picked = await openTextFromNativeDialog({
          filters: [{ name: 'Zemax', extensions: ['zmx'] }],
        });
        if (!picked) return;

        const encoded = new TextEncoder().encode(picked.content);
        const arrayBuffer = encoded.buffer.slice(
          encoded.byteOffset,
          encoded.byteOffset + encoded.byteLength,
        ) as ArrayBuffer;

        const syntheticFile = { name: basenameFromPath(picked.path), size: encoded.byteLength } as const;
        console.log('📥 [Zemax Import] Selected file:', syntheticFile.name, `(${syntheticFile.size} bytes)`);

        const now = new Date().toISOString();
          let parsed: any;
          try {
            parsed = await parseZmxText({ text: picked.content });
          } catch (rustParseErr) {
            console.warn('⚠️ [Zemax Import] Rust parser failed, fallback to TS parser:', rustParseErr);
            const encoded = new TextEncoder().encode(picked.content);
            const arrayBuffer = encoded.buffer.slice(
              encoded.byteOffset,
              encoded.byteOffset + encoded.byteLength,
            ) as ArrayBuffer;
            parsed = parseZMXArrayBufferToOpticalSystemRows(arrayBuffer);
          }

        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Invalid Zemax parse result.');
        }

        console.log('📥 [Zemax Import] Parsed:', {
          rows: Array.isArray(parsed?.rows) ? parsed.rows.length : 0,
          sourceRows: Array.isArray(parsed?.sourceRows) ? parsed.sourceRows.length : 0,
          objectRows: Array.isArray(parsed?.objectRows) ? parsed.objectRows.length : 0,
          issues: Array.isArray(parsed?.issues) ? parsed.issues.length : 0
        });

        const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
        const sourceRows = Array.isArray(parsed?.sourceRows) ? parsed.sourceRows : [];
        const objectRows = Array.isArray(parsed?.objectRows) ? parsed.objectRows : [];
        const parsedStopIndex = rows.findIndex((r: any) => {
          const ot = String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
          return ot === 'stop';
        });
        const stopSemidiaWasMissing = (() => {
          if (parsedStopIndex < 0) return false;
          const stopRow = rows[parsedStopIndex] || {};
          const raw = stopRow?.semidia ?? stopRow?.semiDiameter ?? stopRow?.semiDia ?? stopRow?.['semi diameter'] ?? stopRow?.['Semi Diameter'];
          if (raw === null || raw === undefined) return true;
          const s = String(raw).trim();
          if (s === '') return true;
          const n = Number(s);
          return !(Number.isFinite(n) && n > 0);
        })();
        const hasMissingSemidia = __cooptHasAnyMissingSemidia(rows);
        const shouldRunSemidiaAutoFill = hasMissingSemidia || stopSemidiaWasMissing;
        const shouldRunImageSemidiaAutoFill = __cooptIsImageSemidiaMissing(rows);

        let blocks: any[] = [];
        try {
          const derived = deriveBlocksFromLegacyOpticalSystemRows(rows);
          const fatals = Array.isArray(derived?.issues)
            ? derived.issues.filter((it: any) => it?.severity === 'fatal')
            : [];
          if (Array.isArray(derived?.blocks) && derived.blocks.length > 0 && fatals.length === 0 && __coopt_shouldAcceptDerivedBlocks(derived.blocks, rows)) {
            blocks = __coopt_normalizeObjectDistanceInBlocks(derived.blocks);
          } else {
            blocks = [];
            if (fatals.length > 0) {
              console.warn('⚠️ [Zemax Import] deriveBlocks had fatals; using explicit rows only:', fatals);
            } else if (Array.isArray(derived?.blocks) && derived.blocks.length > 0) {
              console.warn('⚠️ [Zemax Import] derived blocks were too lossy; using explicit rows only.');
            }
          }
        } catch (e) {
          console.warn('⚠️ [Zemax Import] deriveBlocks failed; using explicit rows only:', e);
          blocks = [];
        }

        const payload = {
          configurations: [{
            id: 1,
            name: 'Config 1',
            schemaVersion: BLOCK_SCHEMA_VERSION,
            blocks,
            source: sourceRows,
            object: objectRows,
            opticalSystem: rows,
            meritFunction: [],
            systemData: { referenceFocalLength: '' },
            metadata: {
              created: now,
              modified: now,
              locked: false,
              importedFrom: 'zemax',
              importAnalyzeMode: blocks.length === 0,
              importRowsPreferred: true
            }
          }],
          activeConfigId: 1,
          meritFunction: [],
          systemRequirements: [],
          optimizationRules: {}
        };

        if (typeof (window as any).__loadAllDataObjectIntoApp !== 'function') {
          throw new Error('App loader is not ready. Please reload and try again.');
        }
        const loaded = await (window as any).__loadAllDataObjectIntoApp(payload, { filename: syntheticFile.name });
        if (!loaded) {
          throw new Error('Zemax import parsed, but app load step returned false.');
        }

        try {
          if (shouldRunSemidiaAutoFill && typeof (window as any).autoCalculateMissingSemidia === 'function') {
            (window as any).autoCalculateMissingSemidia(sourceRows, objectRows, {
              entrancePupilDiameterMm: Number(parsed?.entrancePupilDiameterMm),
              stopSemidiaWasMissing
            });
          }
        } catch (_) {}

        try {
          if (shouldRunImageSemidiaAutoFill && typeof (window as any).calculateImageSemiDiaFromChiefRays === 'function') {
            const tryAutoImageSemidia = (triesLeft: number) => {
              setTimeout(() => {
                try {
                  Promise.resolve((window as any).calculateImageSemiDiaFromChiefRays())
                    .then((ok: any) => {
                      if (ok === true) {
                        try {
                          if (typeof (window as any).refreshBlockInspector === 'function') {
                            (window as any).refreshBlockInspector();
                          }
                        } catch (_) {}
                        try {
                          if (typeof (window as any).refreshAllUI === 'function') {
                            (window as any).refreshAllUI();
                          }
                        } catch (_) {}
                        return;
                      }
                      if (triesLeft > 0) {
                        tryAutoImageSemidia(triesLeft - 1);
                      }
                    })
                    .catch(() => {
                      if (triesLeft > 0) {
                        tryAutoImageSemidia(triesLeft - 1);
                      }
                    });
                } catch (_) {
                  if (triesLeft > 0) {
                    tryAutoImageSemidia(triesLeft - 1);
                  }
                }
              }, 200);
            };
            tryAutoImageSemidia(4);
          }
        } catch (_) {}

        if (Array.isArray(parsed?.issues)) {
          const fatal = parsed.issues.filter((it: any) => it?.severity === 'fatal');
          if (fatal.length > 0) {
            console.warn('⚠️ Zemax import issues:', fatal);
          }
        }
        console.log('✅ Zemax file imported:', syntheticFile.name);
      } catch (err) {
        console.error('❌ Zemax import failed:', err);
        alert(`Import failed: ${(err as Error)?.message || String(err)}`);
      }
    })();
    return;
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zmx';
  
  input.onchange = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target?.files?.[0];

    try {
      if (input.parentNode) input.parentNode.removeChild(input);
    } catch (_) {}

    if (!file) return;

    try {
      console.log('📥 [Zemax Import] Selected file:', file.name, `(${file.size} bytes)`);
      const arrayBuffer = await file.arrayBuffer();
      const now = new Date().toISOString();
      const parsed: any = parseZMXArrayBufferToOpticalSystemRows(arrayBuffer);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid Zemax parse result.');
      }

      console.log('📥 [Zemax Import] Parsed:', {
        rows: Array.isArray(parsed?.rows) ? parsed.rows.length : 0,
        sourceRows: Array.isArray(parsed?.sourceRows) ? parsed.sourceRows.length : 0,
        objectRows: Array.isArray(parsed?.objectRows) ? parsed.objectRows.length : 0,
        issues: Array.isArray(parsed?.issues) ? parsed.issues.length : 0
      });

      const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
      const sourceRows = Array.isArray(parsed?.sourceRows) ? parsed.sourceRows : [];
      const objectRows = Array.isArray(parsed?.objectRows) ? parsed.objectRows : [];
      const parsedStopIndex = rows.findIndex((r: any) => {
        const ot = String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
        return ot === 'stop';
      });
      const stopSemidiaWasMissing = (() => {
        if (parsedStopIndex < 0) return false;
        const stopRow = rows[parsedStopIndex] || {};
        const raw = stopRow?.semidia ?? stopRow?.semiDiameter ?? stopRow?.semiDia ?? stopRow?.['semi diameter'] ?? stopRow?.['Semi Diameter'];
        if (raw === null || raw === undefined) return true;
        const s = String(raw).trim();
        if (s === '') return true;
        const n = Number(s);
        return !(Number.isFinite(n) && n > 0);
      })();
      const hasMissingSemidia = __cooptHasAnyMissingSemidia(rows);
      const shouldRunSemidiaAutoFill = hasMissingSemidia || stopSemidiaWasMissing;
      const shouldRunImageSemidiaAutoFill = __cooptIsImageSemidiaMissing(rows);

      let blocks: any[] = [];
      try {
        const derived = deriveBlocksFromLegacyOpticalSystemRows(rows);
        const fatals = Array.isArray(derived?.issues)
          ? derived.issues.filter((it: any) => it?.severity === 'fatal')
          : [];
        if (Array.isArray(derived?.blocks) && derived.blocks.length > 0 && fatals.length === 0 && __coopt_shouldAcceptDerivedBlocks(derived.blocks, rows)) {
          blocks = __coopt_normalizeObjectDistanceInBlocks(derived.blocks);
        } else {
          blocks = [];
          if (fatals.length > 0) {
            console.warn('⚠️ [Zemax Import] deriveBlocks had fatals; using explicit rows only:', fatals);
          } else if (Array.isArray(derived?.blocks) && derived.blocks.length > 0) {
            console.warn('⚠️ [Zemax Import] derived blocks were too lossy; using explicit rows only.');
          }
        }
      } catch (e) {
        console.warn('⚠️ [Zemax Import] deriveBlocks failed; using explicit rows only:', e);
        blocks = [];
      }

      const payload = {
        configurations: [{
          id: 1,
          name: 'Config 1',
          schemaVersion: BLOCK_SCHEMA_VERSION,
          blocks,
          source: sourceRows,
          object: objectRows,
          opticalSystem: rows,
          meritFunction: [],
          systemData: { referenceFocalLength: '' },
          metadata: {
            created: now,
            modified: now,
            locked: false,
            importedFrom: 'zemax',
            importAnalyzeMode: blocks.length === 0,
            importRowsPreferred: true
          }
        }],
        activeConfigId: 1,
        meritFunction: [],
        systemRequirements: [],
        optimizationRules: {}
      };

      if (typeof (window as any).__loadAllDataObjectIntoApp !== 'function') {
        throw new Error('App loader is not ready. Please reload and try again.');
      }
      const loaded = await (window as any).__loadAllDataObjectIntoApp(payload, { filename: file.name });
      if (!loaded) {
        throw new Error('Zemax import parsed, but app load step returned false.');
      }

      try {
        if (shouldRunSemidiaAutoFill && typeof (window as any).autoCalculateMissingSemidia === 'function') {
          (window as any).autoCalculateMissingSemidia(sourceRows, objectRows, {
            entrancePupilDiameterMm: Number(parsed?.entrancePupilDiameterMm),
            stopSemidiaWasMissing
          });
        }
      } catch (_) {}

      try {
        if (shouldRunImageSemidiaAutoFill && typeof (window as any).calculateImageSemiDiaFromChiefRays === 'function') {
          const tryAutoImageSemidia = (triesLeft: number) => {
            setTimeout(() => {
              try {
                Promise.resolve((window as any).calculateImageSemiDiaFromChiefRays())
                  .then((ok: any) => {
                    if (ok === true) {
                      try {
                        if (typeof (window as any).refreshBlockInspector === 'function') {
                          (window as any).refreshBlockInspector();
                        }
                      } catch (_) {}
                      try {
                        if (typeof (window as any).refreshAllUI === 'function') {
                          (window as any).refreshAllUI();
                        }
                      } catch (_) {}
                      return;
                    }
                    if (triesLeft > 0) {
                      tryAutoImageSemidia(triesLeft - 1);
                    }
                  })
                  .catch(() => {
                    if (triesLeft > 0) {
                      tryAutoImageSemidia(triesLeft - 1);
                    }
                  });
              } catch (_) {
                if (triesLeft > 0) {
                  tryAutoImageSemidia(triesLeft - 1);
                }
              }
            }, 200);
          };
          tryAutoImageSemidia(4);
        }
      } catch (_) {}

      if (Array.isArray(parsed?.issues)) {
        const fatal = parsed.issues.filter((it: any) => it?.severity === 'fatal');
        if (fatal.length > 0) {
          console.warn('⚠️ Zemax import issues:', fatal);
        }
      }
      console.log('✅ Zemax file imported:', file.name);
    } catch (err) {
      console.error('❌ Zemax import failed:', err);
      alert(`Import failed: ${(err as Error)?.message || String(err)}`);
    }
  };
  
  document.body.appendChild(input);
  input.click();
}

export function handleExportZemax(): void {
  try {
    const opticalSystemRows = (window as any).getOpticalSystemRows 
      ? (window as any).getOpticalSystemRows((window as any).tableOpticalSystem) 
      : [];
    const sourceRows = (window as any).tableSource && typeof (window as any).tableSource.getData === 'function'
      ? (window as any).tableSource.getData()
      : [];
    const objectRows = (window as any).tableObject && typeof (window as any).tableObject.getData === 'function'
      ? (window as any).tableObject.getData()
      : [];
    
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
      alert('No optical system data to export');
      return;
    }

    const loaded = String(getLoadedFileName() ?? '').replace(/\s*\(surfaces only\)\s*$/i, '').trim();
    const defaultFilename = loaded
      ? (/\.json$/i.test(loaded) ? loaded.replace(/\.json$/i, '.zmx') : (/\.zmx$/i.test(loaded) ? loaded : `${loaded}.zmx`))
      : 'co-opt-export.zmx';

    let filename = prompt(
      'Zemaxエクスポートのファイル名を入力してください（.zmx は自動補完）',
      defaultFilename
    );
    if (!filename) return;
    filename = filename.trim();
    if (!filename) return;
    if (!/\.zmx$/i.test(filename)) filename += '.zmx';
    
    if (isTauriRuntime()) {
      (async () => {
        try {
          const generated = await generateZmxText({
            opticalSystemRows,
            sourceRows,
            objectRows,
            title: 'co-opt export',
            units: 'MM',
          });
          const savedPath = await saveTextFromNativeDialog(generated.zmxText, {
            filters: [{ name: 'Zemax', extensions: ['zmx'] }],
          });
          if (!savedPath) return;
          console.log('✅ Zemax file exported successfully:', savedPath);
        } catch (nativeErr) {
          console.error('❌ Native Zemax export failed:', nativeErr);
          alert(`Export failed: ${(nativeErr as Error)?.message || String(nativeErr)}`);
        }
      })();
      return;
    }

    if (typeof (window as any).generateZMXText === 'function') {
      const zmxText = (window as any).generateZMXText(opticalSystemRows, {
        sourceRows,
        objectRows
      });

      if (typeof (window as any).downloadZMX === 'function') {
        (window as any).downloadZMX(zmxText, filename);
        console.log('✅ Zemax file exported successfully');
      } else {
        console.error('❌ downloadZMX function not available');
        alert('Export function not available');
      }
    } else {
      console.error('❌ generateZMXText function not available');
      alert('Export function not available');
    }
  } catch (err) {
    console.error('❌ Zemax export failed:', err);
    alert(`Export failed: ${(err as Error)?.message || String(err)}`);
  }
}

// Note: Optimize button handler is very complex and should remain in dom-event-handlers.ts
// We'll trigger it through a window function
export function handleOptimize(): void {
  const isOptimizeWindowContext = (() => {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('coopt_optimize_window') === '1';
    } catch (_) {
      return false;
    }
  })();

  const optimizeProgressStorageKey = 'coopt.optimizeProgress';

  const publishOptimizeProgress = (payload: Record<string, any>) => {
    try {
      localStorage.setItem(
        optimizeProgressStorageKey,
        JSON.stringify({
          ts: Date.now(),
          ...payload,
        })
      );
    } catch (_) {}
  };

  const persistCurrentDesignIntent = () => {
    try {
      const cm = (window as any).ConfigurationManager;
      if (cm && typeof cm.saveCurrentToActiveConfiguration === 'function') {
        cm.saveCurrentToActiveConfiguration();
      }
    } catch (_) {}
  };

  const persistCurrentSystemConfigSnapshot = () => {
    try {
      const currentConfig = typeof (window as any).loadSystemConfigurationsFromTableConfig === 'function'
        ? (window as any).loadSystemConfigurationsFromTableConfig()
        : (typeof (window as any).loadSystemConfigurations === 'function'
          ? (window as any).loadSystemConfigurations()
          : null);
      if (!currentConfig || typeof currentConfig !== 'object') return;

      const cloned = JSON.parse(JSON.stringify(currentConfig));
      if (typeof (window as any).saveSystemConfigurationsFromTableConfig === 'function') {
        (window as any).saveSystemConfigurationsFromTableConfig(cloned);
      } else if (typeof (window as any).saveSystemConfigurations === 'function') {
        (window as any).saveSystemConfigurations(cloned);
      }
    } catch (_) {}
  };

  const persistCurrentRequirements = async () => {
    try {
      const reqEditor = (window as any).systemRequirementsEditor;
      if (reqEditor && typeof reqEditor.flushPendingEdits === 'function') {
        const flushResult = reqEditor.flushPendingEdits();
        if (flushResult && typeof flushResult.then === 'function') {
          await flushResult;
        }
      }
      if (reqEditor && typeof reqEditor.saveToStorage === 'function') {
        reqEditor.saveToStorage();
      } else if (reqEditor && typeof reqEditor.syncRequirementsToSystemConfigFromStorage === 'function') {
        reqEditor.syncRequirementsToSystemConfigFromStorage();
      }
    } catch (_) {}
  };

  if (!isOptimizeWindowContext) {
    const optimizeWindowName = 'coopt-optimize-progress-window';
    const optimizeWindowFeatures = 'width=560,height=640,resizable=yes,scrollbars=yes';
    const preopenedWebPopup = !isTauriRuntime()
      ? window.open('', optimizeWindowName, optimizeWindowFeatures)
      : null;

    (async () => {
      try {
        persistCurrentDesignIntent();
        await persistCurrentRequirements();
        persistCurrentSystemConfigSnapshot();

        // Keep Optimize Progress score aligned with the main UI by forcing
        // one explicit "Update Requirement" evaluation before opening.
        const runRequirementUpdateBeforeOpen = async (): Promise<void> => {
          const startedAt = Date.now();
          try {
            const reqEditor = (window as any).systemRequirementsEditor;
            if (reqEditor && typeof reqEditor.evaluateAndUpdateNow === 'function') {
              const r = reqEditor.evaluateAndUpdateNow({
                reason: 'optimize-open-prerun',
                forceSilent: true,
                silent: true,
              });
              if (r && typeof r.then === 'function') {
                await r;
              }
            }
          } catch (_) {}

          // Wait briefly for async table writes that finish after the Promise resolves.
          const deadline = Date.now() + 2500;
          while (Date.now() < deadline) {
            try {
              const s = (window as any).__cooptLastRequirementsEval;
              const at = Number(s?.at ?? 0);
              const stage = String(s?.stage ?? '').trim().toLowerCase();
              if (at >= startedAt && stage === 'done') break;
            } catch (_) {}
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
        };

        await runRequirementUpdateBeforeOpen();

        const url = new URL(window.location.href);
        url.searchParams.set('coopt_optimize_window', '1');
        if (isTauriRuntime()) {
          const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
          const label = 'optimize-progress-window';
          const existing = await WebviewWindow.getByLabel(label);
          if (existing) {
            await existing.setFocus();
            return;
          }

          new WebviewWindow(label, {
            title: 'Optimize Progress',
            url: url.toString(),
            width: 560,
            height: 640,
            resizable: true,
            focus: true,
          });
          return;
        }

        const webPopup = preopenedWebPopup && !preopenedWebPopup.closed
          ? preopenedWebPopup
          : window.open(url.toString(), optimizeWindowName, optimizeWindowFeatures);
        if (webPopup && !webPopup.closed) {
          try { webPopup.location.href = url.toString(); } catch (_) {}
          try { webPopup.focus(); } catch (_) {}
          return;
        }

        console.warn('⚠️ [Optimize] optimize progress window was blocked by the browser.');
      } catch (err) {
        try { if (preopenedWebPopup && !preopenedWebPopup.closed) preopenedWebPopup.close(); } catch (_) {}
        console.error('❌ [Optimize] failed to open optimize progress window:', err);
      }
    })();
    return;
  }

  // In web mode, optimize progress already runs in its own window/context.
  // Avoid opening an additional about:blank helper popup.
  const popup = null;
  const hasPopup = !!(popup && !popup.closed);
  const shouldShowMainAlert = !isTauriRuntime();

  const popupSet = (id: string, text: string) => {
    try {
      if (!popup || popup.closed) return;
      const el = popup.document.getElementById(id);
      if (el) el.textContent = text;
    } catch (_) {}
  };

  const popupBar = (pct: number) => {
    try {
      if (!popup || popup.closed) return;
      const el = popup.document.getElementById('opt-bar') as HTMLElement | null;
      if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    } catch (_) {}
  };

  const popupLog = (line: string) => {
    try {
      if (!popup || popup.closed) return;
      const el = popup.document.getElementById('opt-log');
      if (!el) return;
      el.textContent = `${el.textContent || ''}${line}\n`;
      el.scrollTop = el.scrollHeight;
    } catch (_) {}
  };

  (async () => {
    let shouldKeepRuntimeSnapshot = false;
    try {
      const systemConfig = cloneCanonicalSystemConfig();
      const activeConfig = Array.isArray(systemConfig?.configurations)
        ? (systemConfig.configurations.find((cfg: any) => String(cfg?.id ?? '') === String(systemConfig?.activeConfigId ?? ''))
          || systemConfig.configurations[0]
          || null)
        : null;
      const preRunVariableCount = (() => {
        try {
          const vars = listDesignVariablesFromBlocks(activeConfig || {});
          return Array.isArray(vars) ? vars.length : 0;
        } catch (_) {
          return 0;
        }
      })();

      publishOptimizeProgress({
        phase: 'starting',
        modeUsed: 'kkt',
        status: 'running',
        variableCount: preRunVariableCount,
        percent: 5,
      });

      const opticalSystemRows = (() => {
        try {
          const blocks = Array.isArray(activeConfig?.blocks) ? activeConfig.blocks : [];
          if (blocks.length > 0 && typeof (window as any).expandBlocksToOpticalSystemRows === 'function') {
            const expanded = (window as any).expandBlocksToOpticalSystemRows(blocks);
            if (expanded && Array.isArray(expanded.rows) && expanded.rows.length > 0) {
              return expanded.rows;
            }
          }
        } catch (_) {}
        return (window as any).getOpticalSystemRows
          ? (window as any).getOpticalSystemRows((window as any).tableOpticalSystem)
          : [];
      })();

      if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
        publishOptimizeProgress({
          phase: 'failed',
          status: 'error',
          message: 'No optical data available',
          percent: 100,
        });
        if (shouldShowMainAlert) {
          alert('最適化対象の光学系データがありません。');
        }
        return;
      }

      const systemRequirementsRows = (() => {
        try {
          const sre = (window as any).systemRequirementsEditor;
          if (sre && typeof sre.getData === 'function') {
            const rows = sre.getData();
            if (Array.isArray(rows)) return rows;
          }
        } catch (_) {}
        return [];
      })();

      const sourceRows = (window as any).tableSource && typeof (window as any).tableSource.getData === 'function'
        ? (window as any).tableSource.getData()
        : [];
      const objectRows = (window as any).tableObject && typeof (window as any).tableObject.getData === 'function'
        ? (window as any).tableObject.getData()
        : [];
      const activeConfigId = (() => {
        try {
          if (systemConfig && systemConfig.activeConfigId !== undefined && systemConfig.activeConfigId !== null) {
            return String(systemConfig.activeConfigId).trim();
          }
        } catch (_) {}
        return '';
      })();

      const opt = (window as any).OptimizationMVP;
      if (!opt || typeof opt.run !== 'function') {
        publishOptimizeProgress({
          phase: 'failed',
          status: 'error',
          message: 'OptimizationMVP is not available',
          percent: 100,
        });
        if (shouldShowMainAlert) {
          alert('OptimizationMVP が利用できません。');
        }
        return;
      }

      const cloneJsonLocal = (value: any) => {
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
      };

      const frozenRunSystemConfig = cloneJsonLocal(systemConfig) || systemConfig || null;
      try {
        if (frozenRunSystemConfig) {
          (window as any).__cooptSystemConfig = cloneJsonLocal(frozenRunSystemConfig) || frozenRunSystemConfig;
          (window as any).__cooptPreferRuntimeSystemConfig = true;
          (window as any).__cooptDeferDerivedUiUntil = Date.now() + 60000;
        }
      } catch (_) {}

      // Capture state before optimization for undo recording
      let beforeOptimizationState: any = null;
      try {
        beforeOptimizationState = cloneCanonicalSystemConfig() || cloneJsonLocal(frozenRunSystemConfig);
      } catch (_) {}

      const progressEvents: any[] = [];
      const optimizationActivityGuard = createOptimizationActivityGuard('toolbar-optimize');
      let result: any = null;
      try {
        await optimizationActivityGuard.acquire();
        result = await opt.run({
          opticalSystemRows,
          sourceRows,
          objectRows,
          activeConfigId,
          systemRequirementsRows,
          method: 'kkt',
          maxIterations: 24,
          preferNative: isTauriRuntime(),
          onProgress: (ev: any) => {
            if (!ev || typeof ev !== 'object') return;
            progressEvents.push(ev);
          },
        });
      } finally {
        await optimizationActivityGuard.release();
      }

      const modeUsed = String(result?.method || 'kkt');
      shouldKeepRuntimeSnapshot = !!result?.ok;
      const meritBefore = Number(result?.before ?? Number.NaN);
      const requirementScoreBefore = Number(
        result?.requirementScoreBefore ?? result?.violationScoreBefore ?? Number.NaN
      );
      const requirementScoreAfter = Number(result?.violationScore ?? Number.NaN);
      const meritAfter = Number.isFinite(requirementScoreAfter)
        ? requirementScoreAfter
        : Number(result?.best ?? Number.NaN);
      const iterations = Number(result?.iterations ?? 0);
      const variableCount = Number(result?.variables ?? preRunVariableCount ?? 0);
      const converged = !result?.aborted;

      publishOptimizeProgress({
        phase: 'computed',
        status: 'running',
        modeUsed,
        iterations,
        variableCount,
        meritBefore,
        meritAfter,
        requirementScoreBefore,
        requirementScoreAfter,
        converged,
        progressEvents,
        percent: 75,
      });

      popupSet('opt-mode', `mode: ${modeUsed}`);
      popupSet('opt-state', 'state: applying result...');
      popupBar(75);

      // TS optimizer applies to configuration/table internally.
      try {
        if (typeof (window as any).drawOpticalSystem === 'function') {
          (window as any).drawOpticalSystem();
        }
      } catch (applyErr) {
        console.warn('⚠️ [Optimize][TS] result apply failed:', applyErr);
      }

      // Record undo command for optimization
      try {
        if (beforeOptimizationState && w.undoHistory && result?.ok) {
          const afterOptimizationState = cloneCanonicalSystemConfig();
          publishRuntimeSystemConfigSnapshot(afterOptimizationState, 60000);
          if (afterOptimizationState && JSON.stringify(beforeOptimizationState) !== JSON.stringify(afterOptimizationState)) {
            const before = beforeOptimizationState;
            const after = afterOptimizationState;
            const command = {
              timestamp: Date.now(),
              __cooptOptimizationCommand: true,
              description: 'Optimization',
              name: 'Optimization',
              execute: async () => {
                saveSystemConfigurations(after);
                try {
                  if (w.ConfigurationManager && typeof w.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
                    await w.ConfigurationManager.loadActiveConfigurationToTables({ applyToUI: true });
                  }
                } catch (_) {}
              },
              undo: async () => {
                saveSystemConfigurations(before);
                try {
                  if (w.ConfigurationManager && typeof w.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
                    await w.ConfigurationManager.loadActiveConfigurationToTables({ applyToUI: true });
                  }
                } catch (_) {}
              },
              redo: function() { return (this as any).execute(); },
            };
            w.undoHistory.record(command);
            try {
              (globalThis as any).__cooptLastOptimizationUndoRecordAt = Number(command.timestamp) || Date.now();
            } catch (_) {}
            try {
              (globalThis as any).__cooptUndoRecordSuppressedUntil = Date.now() + 1500;
            } catch (_) {}
          }
        }
      } catch (_) {}

      publishRuntimeSystemConfigSnapshot(cloneCanonicalSystemConfig(), 60000);

      console.log('✅ [Optimize][TS]', result);
      if (Array.isArray(progressEvents) && progressEvents.length > 0) {
        console.log('📈 [Optimize][TS][Progress]', progressEvents.slice(-8));
        for (const ev of progressEvents.slice(-24)) {
          popupLog(`${ev.phase} iter=${ev.iter} current=${Number(ev.current).toFixed(6)} best=${Number(ev.best).toFixed(6)}`);
        }
      }
      popupSet('opt-iter', String(iterations));
      popupSet('opt-vars', String(variableCount));
      popupSet('opt-merit', `${Number.isFinite(meritBefore) ? meritBefore.toFixed(6) : 'NaN'} -> ${Number.isFinite(meritAfter) ? meritAfter.toFixed(6) : 'NaN'}`);
      popupSet('opt-req', `${Number.isFinite(requirementScoreAfter) ? requirementScoreAfter.toFixed(6) : 'NaN'}`);
      popupSet('opt-status', converged ? 'converged' : 'in-progress');
      popupSet('opt-state', 'state: completed');
      popupBar(100);

      publishOptimizeProgress({
        phase: 'completed',
        status: converged ? 'converged' : 'in-progress',
        modeUsed,
        iterations,
        variableCount,
        meritBefore,
        meritAfter,
        requirementScoreBefore,
        requirementScoreAfter,
        converged,
        progressEvents,
        percent: 100,
      });

      if (!hasPopup && shouldShowMainAlert) {
        alert(
          [
            `Optimizer (${result.modeUsed}) completed`,
            `iterations: ${result.iterations}`,
            `variables: ${result.variableCount}`,
            `merit: ${result.meritBefore.toFixed(6)} -> ${result.meritAfter.toFixed(6)}`,
            `requirements: ${result.requirementScoreBefore.toFixed(6)} -> ${result.requirementScoreAfter.toFixed(6)}`,
            result.converged ? 'status: converged' : 'status: in-progress',
            'note: progress popup was blocked/unavailable',
          ].join('\n')
        );
      }
    } catch (err) {
      console.error('❌ [Optimize] failed:', err);
      publishOptimizeProgress({
        phase: 'failed',
        status: 'error',
        message: (err as Error)?.message || String(err),
        percent: 100,
      });
      popupSet('opt-status', 'error');
      popupSet('opt-state', 'state: failed');
      popupBar(100);
      popupLog(`ERROR: ${(err as Error)?.message || String(err)}`);
      if (shouldShowMainAlert) {
        alert(
          [
            `Optimize failed: ${(err as Error)?.message || String(err)}`,
            hasPopup ? '' : 'note: progress popup was blocked/unavailable',
          ].filter(Boolean).join('\n')
        );
      }
    } finally {
      if (!shouldKeepRuntimeSnapshot) {
        try {
          delete (window as any).__cooptPreferRuntimeSystemConfig;
        } catch (_) {}
        try {
          delete (window as any).__cooptSystemConfig;
        } catch (_) {}
      }
    }
  })();
}

async function openRenderWindowDesktop(): Promise<void> {
  if (!isTauriRuntime()) return;

  try { localStorage.setItem(RENDER_DESIGN_INTENT_SYNC_KEY, 'true'); } catch (_) {}

  console.log('[Render3D][Desktop] openRenderWindowDesktop() called');

  const url = new URL(window.location.href);
  url.searchParams.delete('coopt_optimize_window');
  url.searchParams.delete('coopt_analysis_window');
  url.searchParams.delete('coopt_analysis');
  url.searchParams.delete('coopt_settings_window');
  url.searchParams.set('coopt_render_window', '1');
  const finalUrl = url.toString();

  console.log('[Render3D][Desktop] render URL:', finalUrl);

  const ensureRenderWindowVisible = async (): Promise<boolean> => {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const label = 'render-window';
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        let existing: any = null;
        try { existing = await WebviewWindow.getByLabel(label); } catch (_) {}
        if (existing) {
          try {
            if (typeof existing.show === 'function') await existing.show();
            if (typeof existing.unminimize === 'function') await existing.unminimize();
            await existing.setFocus();
          } catch (_) {}
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    } catch (_) {}
    return false;
  };

  const waitForRenderWindowClosed = async (WebviewWindow: any, label: string, timeoutMs = 120): Promise<void> => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      let current: any = null;
      try { current = await WebviewWindow.getByLabel(label); } catch (_) {}
      if (!current) return;
      await new Promise((resolve) => setTimeout(resolve, 24));
    }
  };

  // Primary: use Rust backend command (bypasses frontend IPC issues)
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_render_window', { url: finalUrl });
    if (await ensureRenderWindowVisible()) {
      await requestRenderWindowRefresh(undefined, 'render-open-desktop');
      console.log('✅ [Render3D][Desktop] open_render_window invoke succeeded');
      return;
    }
    console.warn('[Render3D][Desktop] Rust invoke returned but render window was not detected; falling back to WebviewWindow');
  } catch (invokeErr) {
    console.warn('[Render3D][Desktop] Rust invoke failed, falling back to WebviewWindow:', invokeErr);
  }

  // Fallback: JS-side WebviewWindow API
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const label = 'render-window';
    let existing: any = null;
    try { existing = await WebviewWindow.getByLabel(label); } catch (_) {}
    console.log('[Render3D][Desktop] existing window:', existing);

    if (existing) {
      try {
        if (typeof existing.close === 'function') {
          await existing.close();
        }
        await waitForRenderWindowClosed(WebviewWindow, label);
      } catch (e) {
        console.warn('[Render3D][Desktop] close existing failed:', e);
        try { await existing.close(); } catch (_) {}
        await waitForRenderWindowClosed(WebviewWindow, label, 160);
      }
    }

    const created = new WebviewWindow(label, {
      title: 'Render Optical System',
      url: finalUrl,
      width: 1100,
      height: 760,
      resizable: true,
      focus: true,
    });
    created.once('tauri://created', () => {
      void requestRenderWindowRefresh(undefined, 'render-open-desktop-created');
      console.log('✅ [Render3D][Desktop] render window created via WebviewWindow');
    });
    created.once('tauri://error', (error) => {
      console.error('❌ [Render3D][Desktop] WebviewWindow creation error:', error);
      alert('Failed to open Render window. See console for details.');
    });
  } catch (fbErr) {
    console.error('[Render3D][Desktop] fallback WebviewWindow error:', fbErr);
    alert('Failed to open Render window.');
  }
}

try {
  (window as any).__cooptOpenRenderWindow = openRenderWindowDesktop;
} catch (_) {}

export function handleRender3D(): void {
  const w = window as any;
  if (w.__render3DInProgress) {
    return;
  }
  w.__render3DInProgress = true;

  try { localStorage.setItem(RENDER_DESIGN_INTENT_SYNC_KEY, 'true'); } catch (_) {}

  try {
    if (isTauriRuntime()) {
      (async () => {
        try {
          try {
            const cm = (window as any).ConfigurationManager;
            if (cm && typeof cm.saveCurrentToActiveConfiguration === 'function') {
              cm.saveCurrentToActiveConfiguration();
            }
          } catch (_) {}

          await openRenderWindowDesktop();
        } catch (err) {
          console.error('❌ [Render3D][Desktop] WebviewWindow error:', err);
          alert('Failed to open Render window.');
        }
      })();
      return;
    }

    if (isRenderWindowContext()) {
      return;
    }

    try {
      if (w.popup3DWindow && !w.popup3DWindow.closed) {
        try {
          const cm = (window as any).ConfigurationManager;
          if (cm && typeof cm.saveCurrentToActiveConfiguration === 'function') {
            cm.saveCurrentToActiveConfiguration();
          }
        } catch (_) {}
        try { w.popup3DWindow.close(); } catch (_) {}
        w.popup3DWindow = null;
      }

      try {
        const cm = (window as any).ConfigurationManager;
        if (cm && typeof cm.saveCurrentToActiveConfiguration === 'function') {
          cm.saveCurrentToActiveConfiguration();
        }
      } catch (_) {}

      const url = new URL(window.location.href);
      url.searchParams.delete('coopt_optimize_window');
      url.searchParams.delete('coopt_analysis_window');
      url.searchParams.delete('coopt_analysis');
      url.searchParams.delete('coopt_settings_window');
      url.searchParams.set('coopt_render_window', '1');
      url.searchParams.set('coopt_render_boot', String(Date.now()));

      const popup = window.open(url.toString(), `3D Optical System ${Date.now()}`, 'width=1100,height=760,resizable=yes,scrollbars=yes');
      if (!popup) {
        alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
        return;
      }
      w.popup3DWindow = popup;
      void requestRenderWindowRefresh(popup, 'render-open-popup-created');
      return;
    } catch (err) {
      console.error('❌ [Render3D] Failed to open popup render window:', err);
    }

    alert('Failed to open Render popup. Please retry.');
  } finally {
    w.__render3DInProgress = false;
  }
}

type AnalysisWindowKey =
  | 'system-data'
  | 'spot-diagram'
  | 'spherical-aberration'
  | 'astigmatism'
  | 'distortion'
  | 'distortion-grid'
  | 'magnification-chromatic-aberration'
  | 'integrated-aberration'
  | 'transverse-aberration'
  | 'opd'
  | 'psf'
  | 'mtf'
  | 'through-focus-spot'
  | 'through-focus-mtf'
  | 'field-mtf';

const ANALYSIS_WINDOW_SIZE_MAP: Record<AnalysisWindowKey, { width: number; height: number; title: string }> = {
  'system-data': { width: 1200, height: 760, title: 'System Data' },
  'spot-diagram': { width: 980, height: 760, title: 'Spot Diagram' },
  'spherical-aberration': { width: 980, height: 760, title: 'Spherical Aberration' },
  'astigmatism': { width: 980, height: 760, title: 'Astigmatism' },
  'distortion': { width: 980, height: 760, title: 'Distortion' },
  'distortion-grid': { width: 980, height: 760, title: 'Distortion Grid' },
  'magnification-chromatic-aberration': { width: 980, height: 760, title: 'Lateral Chromatic Aberration' },
  'integrated-aberration': { width: 980, height: 760, title: 'Integrated Aberration' },
  'transverse-aberration': { width: 980, height: 760, title: 'Transverse Aberration' },
  'opd': { width: 980, height: 760, title: 'Optical Path Difference' },
  'psf': { width: 980, height: 760, title: 'Point Spread Function' },
  'mtf': { width: 980, height: 760, title: 'Modulation Transfer Function' },
  'through-focus-spot': { width: 1100, height: 820, title: 'Through-Focus Spot' },
  'through-focus-mtf': { width: 1100, height: 820, title: 'Through-Focus MTF' },
  'field-mtf': { width: 1100, height: 820, title: 'Object MTF' },
};

function isAnalysisWindowContext(): boolean {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get('coopt_analysis_window') === '1';
  } catch (_) {
    return false;
  }
}

function isSettingsWindowContext(): boolean {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get('coopt_settings_window') === '1';
  } catch (_) {
    return false;
  }
}

async function openDesktopSettingsWindow(): Promise<boolean> {
  if (!isTauriRuntime()) return false;

  installDesktopForceInfinitePupilModeBridge();

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const label = 'settings-window';
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return true;
  }

  const url = new URL(window.location.href);
  url.searchParams.set('coopt_settings_window', '1');
  let forceMode = getCurrentForceInfinitePupilMode();
  if (!forceMode) {
    forceMode = await readDesktopForceInfinitePupilMode();
  }
  if (forceMode) {
    url.searchParams.set('coopt_force_mode', forceMode);
  } else {
    url.searchParams.delete('coopt_force_mode');
  }

  new WebviewWindow(label, {
    title: 'Settings',
    url: url.toString(),
    width: 520,
    height: 620,
    resizable: true,
    focus: true,
  });
  return true;
}

async function openDesktopAnalysisWindow(kind: AnalysisWindowKey): Promise<boolean> {
  if (!isTauriRuntime()) return false;

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const label = `analysis-${kind}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return true;
  }

  const url = new URL(window.location.href);
  url.searchParams.set('coopt_analysis_window', '1');
  url.searchParams.set('coopt_analysis', kind);

  const winCfg = ANALYSIS_WINDOW_SIZE_MAP[kind] || { width: 980, height: 760, title: 'Analysis' };
  const created = new WebviewWindow(label, {
    title: winCfg.title,
    url: url.toString(),
    width: winCfg.width,
    height: winCfg.height,
    resizable: true,
    focus: true,
  });
  created.once('tauri://created', () => {
    console.log(`✅ [Analysis][Desktop] created ${label}`);
  });
  created.once('tauri://error', (error) => {
    console.error(`❌ [Analysis][Desktop] failed to create ${label}:`, error);
    alert(`Failed to open ${winCfg.title} window.`);
  });
  return true;
}

function isRenderWindowContext(): boolean {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get('coopt_render_window') === '1';
  } catch (_) {
    return false;
  }
}

function isModernSystemDataPopup(popup: any): boolean {
  try {
    if (!popup || popup.closed) return false;
    const href = String(popup.location?.href || '');
    if (href.includes('coopt_analysis_window=1') && href.includes('coopt_analysis=system-data')) {
      return true;
    }
  } catch (_) {}
  return false;
}

function openWebAnalysisPopup(kind: AnalysisWindowKey): boolean {
  try {
    if (kind === 'system-data') {
      try {
        const existing = (w as any).__systemDataPopup;
        if (existing && !existing.closed && !isModernSystemDataPopup(existing)) {
          existing.close();
          (w as any).__systemDataPopup = null;
        }
      } catch (_) {}
    }

    const url = new URL(window.location.href);
    url.searchParams.delete('coopt_render_window');
    url.searchParams.delete('coopt_optimize_window');
    url.searchParams.delete('coopt_settings_window');
    url.searchParams.set('coopt_analysis_window', '1');
    url.searchParams.set('coopt_analysis', kind);
    url.searchParams.set('v', String(Date.now()));

    const cfg = ANALYSIS_WINDOW_SIZE_MAP[kind] || { width: 980, height: 760, title: 'Analysis' };
    const left = Math.max(0, Math.floor((window.screenX || 0) + (window.outerWidth - cfg.width) / 2));
    const top = Math.max(0, Math.floor((window.screenY || 0) + (window.outerHeight - cfg.height) / 2));
    const features = [
      `width=${cfg.width}`,
      `height=${cfg.height}`,
      `left=${left}`,
      `top=${top}`,
      'resizable=yes',
      'scrollbars=yes'
    ].join(',');

    const popup = window.open(url.toString(), `coopt-analysis-${kind}`, features);
    if (!popup) {
      alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
      return false;
    }
    if (kind === 'system-data') {
      try { (w as any).__systemDataPopup = popup; } catch (_) {}
    }
    try { popup.focus(); } catch (_) {}
    return true;
  } catch (err) {
    console.error('❌ [Analysis][Web] Failed to open popup:', err);
    return false;
  }
}

w.__cooptOpenSystemDataWindow = (text?: string): boolean => {
  const value = typeof text === 'string' ? text : '';
  if (typeof text === 'string') {
    try {
      w.__cooptSystemDataText = value;
    } catch (_) {}
    try {
      if (typeof w.__cooptPushSystemDataText === 'function') {
        w.__cooptPushSystemDataText(value);
      }
    } catch (_) {}
    try {
      localStorage.setItem(SYSTEM_DATA_STORAGE_KEY, value);
    } catch (_) {}
  }

  if (isTauriRuntime() && !isAnalysisWindowContext()) {
    void openDesktopAnalysisWindow('system-data').catch((err) => {
      console.error('❌ [SystemData][Desktop] WebviewWindow error:', err);
    });
    return true;
  }

  if (isAnalysisWindowContext()) {
    return false;
  }

  return openWebAnalysisPopup('system-data');
};

export function handleSystemData(): void {
  console.log('[SystemData] Button clicked');

  if (isTauriRuntime() && !isAnalysisWindowContext()) {
    (async () => {
      try {
        await openDesktopAnalysisWindow('system-data');
      } catch (err) {
        console.error('❌ [SystemData][Desktop] WebviewWindow error:', err);
      }
    })();
    return;
  }

  if (isAnalysisWindowContext()) {
    return;
  }

  w.__cooptOpenSystemDataWindow();
}

export function handleAnalysisSelect(selectedValue: string): void {
  const value = String(selectedValue || '').trim();
  if (!value) return;

  const analysisButtonMap: Record<string, string> = {
    'spot-diagram': 'open-spot-diagram-window-btn',
    'spherical-aberration': 'open-spherical-aberration-window-btn',
    'astigmatism': 'open-astigmatism-window-btn',
    'distortion': 'open-distortion-window-btn',
    'distortion-grid': 'open-distortion-grid-window-btn',
    'magnification-chromatic-aberration': 'open-magnification-chromatic-aberration-window-btn',
    'integrated-aberration': 'open-integrated-aberration-window-btn',
    'transverse-aberration': 'open-transverse-aberration-window-btn',
    'opd': 'open-opd-window-btn',
    'psf': 'open-psf-window-btn',
    'mtf': 'open-mtf-window-btn',
    'through-focus-spot': 'open-through-focus-spot-window-btn',
    'through-focus-mtf': 'open-through-focus-mtf-window-btn',
    'field-mtf': 'open-field-mtf-window-btn'
  };

  const buttonId = analysisButtonMap[value];

  const mappedAnalysisKind = (
    value in ANALYSIS_WINDOW_SIZE_MAP ? value : null
  ) as AnalysisWindowKey | null;

  if (isTauriRuntime() && !isAnalysisWindowContext() && mappedAnalysisKind && buttonId) {
    (async () => {
      try {
        await openDesktopAnalysisWindow(mappedAnalysisKind);
      } catch (err) {
        console.error('❌ [Analysis][Desktop] WebviewWindow error:', err);
      }
    })();
    return;
  }

  // Web mode: keep opening analysis in popup windows.
  if (!isTauriRuntime()) {
    if (mappedAnalysisKind) {
      openWebAnalysisPopup(mappedAnalysisKind);
      return;
    }
  }

  if (buttonId) {
    const button = document.getElementById(buttonId);
    if (button) {
      const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
      button.dispatchEvent(clickEvent);
    }
  }

  if (isTauriRuntime()) {
    (async () => {
      try {
        const purpose = (value === 'opd' || value === 'psf' || value === 'mtf')
          ? 'high-quality'
          : 'interactive';
        const rec = await recommendWavefrontGrid({
          purpose,
          fieldAngleDeg: 0,
        });
        try {
          (window as any).__cooptRustAnalysisRecommendation = rec;
        } catch (_) {}
        console.log('✅ [Analysis][Rust] grid recommendation:', rec);

        if (value === 'opd' || value === 'psf' || value === 'mtf') {
          const opticalSystemRows = (window as any).getOpticalSystemRows
            ? (window as any).getOpticalSystemRows((window as any).tableOpticalSystem)
            : [];
          const sourceRows = (window as any).tableSource && typeof (window as any).tableSource.getData === 'function'
            ? (window as any).tableSource.getData()
            : [];
          const objectRows = (window as any).tableObject && typeof (window as any).tableObject.getData === 'function'
            ? (window as any).tableObject.getData()
            : [];

          const preview = await runAnalysisPreview({
            kind: value as 'opd' | 'psf' | 'mtf',
            opticalSystemRows,
            sourceRows,
            objectRows,
          });
          try {
            (window as any).__cooptRustAnalysisPreview = preview;
          } catch (_) {}
          console.log('✅ [Analysis][Rust] preview:', preview);
        }
      } catch (err) {
        console.error('❌ [Analysis][Rust] recommendation failed:', err);
      }
    })();
  }
}

export function handleOpenSettings(): void {
  installDesktopForceInfinitePupilModeBridge();

  if (isTauriRuntime() && !isSettingsWindowContext() && !isAnalysisWindowContext()) {
    (async () => {
      try {
        await openDesktopSettingsWindow();
      } catch (err) {
        console.error('❌ [Settings][Desktop] WebviewWindow error:', err);
        alert('Failed to open Settings window.');
      }
    })();
    return;
  }

  if (isSettingsWindowContext()) {
    return;
  }

  const sanitizeMode = (v: any): string => {
    const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
    return (s === 'stop' || s === 'entrance') ? s : '';
  };

  const getCurrentMode = (): string => {
    try {
      if (typeof window.__cooptGetForceInfinitePupilMode === 'function') {
        const m = sanitizeMode(window.__cooptGetForceInfinitePupilMode());
        if (m) return m;
      }
    } catch (_) {}
    try {
      return sanitizeMode(localStorage.getItem(FORCE_INFINITE_PUPIL_MODE_KEY));
    } catch (_) {
      return '';
    }
  };

  try {
    const url = new URL(window.location.href);
    url.searchParams.set('coopt_settings_window', '1');
    const mode = getCurrentMode();
    if (mode) {
      url.searchParams.set('coopt_force_mode', mode);
    } else {
      url.searchParams.delete('coopt_force_mode');
    }

    const width = 520;
    const height = 620;
    const left = Math.max(0, Math.floor((window.screenX || 0) + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.floor((window.screenY || 0) + (window.outerHeight - height) / 2));
    const features = [
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
      'resizable=yes',
      'scrollbars=yes',
    ].join(',');

    const popup = window.open(url.toString(), 'coopt-settings', features);
    if (!popup) {
      alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
      return;
    }
    try { popup.focus(); } catch (_) {}
  } catch (_) {
    alert('Failed to open Settings page.');
  }
}
