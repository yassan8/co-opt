// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

import {
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
  reorderConfiguration,
  renameConfiguration,
  getConfigurationList
} from '../data/table-configuration.ts';
import { saveTableData as saveSourceTableData, tryLoadPersistedTableData as tryLoadPersistedSourceTableData } from '../data/table-source.ts';
import { tryLoadPersistedTableData as tryLoadPersistedOpticalSystemTableData } from '../data/table-optical-system.ts';
import { tryLoadPersistedTableData as tryLoadPersistedMeritFunctionTableData } from '../data/table-merit-function.ts';
import { tryLoadPersistedTableData as tryLoadPersistedSystemRequirementsTableData } from '../data/table-system-requirements.ts';
import { saveTableData as saveObjectTableData, tryLoadPersistedTableData as tryLoadPersistedObjectTableData } from '../data/table-object.ts';
import { requestRefreshBlockInspector, requestUpdateSurfaceNumberSelect } from '../core/window-facade.ts';

let autoSaveIntervalId: number | null = null;
let isConfigurationSwitching = false;
let beforeUnloadHandlerInstalled = false;
let lastConfigSwitchTimestamp = 0;
let draggedConfigId: string | null = null;
let configurationDelegatedListenersInstalled = false;

function areTablesReady(): boolean {
  return !!(w.tableSource && w.tableObject && w.tableOpticalSystem);
}

function ensureActiveConfigAppliedToTables(): void {
  try {
    if (typeof window === 'undefined') return;
    if (w.__configurationApplyPending) return;
    w.__configurationApplyPending = true;

    const tryApply = (): boolean => {
      if (!areTablesReady()) return false;
      loadActiveConfigurationToTables({ applyToUI: true }).catch(e => {
        console.error('❌ [Configuration UI] Failed to apply active configuration:', e);
      });
      return true;
    };

    if (tryApply()) {
      w.__configurationApplyPending = false;
      return;
    }

    let attempts = 0;
    const maxAttempts = 8;
    const timer = setInterval(() => {
      attempts += 1;
      if (tryApply() || attempts >= maxAttempts) {
        clearInterval(timer);
        w.__configurationApplyPending = false;
      }
    }, 200);

    try {
      window.addEventListener('coopt:react-mounted', () => {
        tryApply();
      }, { once: true });
    } catch (_) {}
  } catch (_) {}
}

function setConfigControlsEnabled(enabled: boolean): void {
  const ids = [
    'add-config-btn',
    'delete-config-btn',
    'duplicate-config-btn',
    'rename-config-btn'
  ];
  for (const id of ids) {
    const el = document.getElementById(id) as HTMLButtonElement | HTMLSelectElement | null;
    if (el) el.disabled = !enabled;
  }
}

function shouldSkipAutoSave(): boolean {
  try {
    // Skip if config switching is in progress
    if (isConfigurationSwitching) return true;

    // Skip while optimizer is running so periodic table autosave cannot
    // overwrite the optimizer's final persisted best snapshot.
    if (w.__cooptOptimizerIsRunning === true) return true;

    // Skip briefly after optimization completes so post-run UI/table sync cannot
    // be re-persisted from stale table projections.
    const timeSinceOptimizationSync = Date.now() - Number(w.__cooptLastOptimizationSyncAt || 0);
    if (Number.isFinite(timeSinceOptimizationSync) && timeSinceOptimizationSync >= 0 && timeSinceOptimizationSync < 10000) {
      return true;
    }
    
    // Skip if explicitly disabled
    if (w.__configurationAutoSaveDisabled === true) return true;
    
    // CRITICAL: Skip autosave for 10 seconds after config switch to prevent saving stale table data
    const timeSinceSwitch = Date.now() - lastConfigSwitchTimestamp;
    if (timeSinceSwitch < 10000) {
      console.log(`⏸️ [Configuration] Skipping autosave (${Math.floor(timeSinceSwitch/1000)}s since config switch)`);
      return true;
    }
    
    return false;
  } catch (_) {
    return isConfigurationSwitching;
  }
}

function stopAutoSave(): void {
  const globalIntervalId = Number(w.__configurationAutoSaveIntervalId);
  if (Number.isFinite(globalIntervalId) && globalIntervalId !== 0) {
    clearInterval(globalIntervalId);
    w.__configurationAutoSaveIntervalId = null;
  }
  if (autoSaveIntervalId !== null) {
    clearInterval(autoSaveIntervalId);
    autoSaveIntervalId = null;
  }
}

/**
 * Configuration UIを初期化
 */
export function initializeConfigurationUI(): void {
  // 既に初期化済みの場合はUIを更新してイベントリスナーを再設定
  try {
    if (typeof window !== 'undefined' && w.__configurationUIInitialized) {
      updateConfigurationSelect();
      updateConfigInfo();
      setupConfigurationEventListeners();
      // ページリロード後、アクティブなconfigurationをテーブルに読み込む
      loadActiveConfigurationToTables({ applyToUI: true }).then(() => {
      }).catch(e => {
        console.error('❌ [Configuration UI] Failed to load active configuration:', e);
      });
      ensureActiveConfigAppliedToTables();
      return;
    }
  } catch (_) {}
  
  try {
    if (typeof window !== 'undefined') {
      w.__configurationUIInitialized = true;
    }
  } catch (_) {}

  try {
    if (typeof window !== 'undefined' && !w.__configurationReactHook) {
      w.__configurationReactHook = true;
      window.addEventListener('coopt:react-mounted', () => {
        try { updateConfigurationSelect(); } catch (_) {}
        try { updateConfigInfo(); } catch (_) {}
        try { setupConfigurationEventListeners(); } catch (_) {}
      }, { once: true });
    }
  } catch (_) {}
  
  // 既存のConfigurationシステムを初期化（初回起動時）
  initializeConfigurationSystem();
  
  // UIコンポーネントを更新
  updateConfigurationSelect();
  updateConfigInfo();
  
  // イベントリスナー設定
  setupConfigurationEventListeners();
  
  // 初回起動時もアクティブなconfigurationをテーブルに読み込む
  loadActiveConfigurationToTables({ applyToUI: true }).then(() => {
  }).catch(e => {
    console.error('❌ [Configuration UI] Failed to load active configuration:', e);
  });
  ensureActiveConfigAppliedToTables();
}

// Auto-init as a fallback if the host page doesn't call initializeConfigurationUI.
// DISABLED: main.js will call initializeConfigurationUI explicitly
/*
try {
  if (typeof window !== 'undefined') {
    const boot = () => {
      try { initializeConfigurationUI(); } catch (_) {}
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }
} catch (_) {}
*/

// Allow other modules (e.g. Load flow) to refresh the config dropdown/info
// without re-initializing event listeners or requiring a browser reload.
try {
  if (typeof window !== 'undefined') {
    if (typeof w.refreshConfigurationUI !== 'function') {
      w.refreshConfigurationUI = () => {
        try { updateConfigurationSelect(); } catch (_) {}
        try { updateConfigInfo(); } catch (_) {}
      };
    }
  }
} catch (_) {}

/**
 * Configurationシステムの初期化（初回起動時のマイグレーション）
 */
function initializeConfigurationSystem(): void {
  let systemConfig = loadSystemConfigurations();
  
  // 既存データのマイグレーション: localStorageに個別データがある場合、Config 1に統合
  const persistedSource = tryLoadPersistedSourceTableData();
  const hasSourceData = persistedSource !== null;
  const persistedObject = tryLoadPersistedObjectTableData();
  const hasObjectData = persistedObject !== null;
  const persistedOptical = tryLoadPersistedOpticalSystemTableData();
  const hasOpticalData = persistedOptical !== null;
  const persistedMerit = tryLoadPersistedMeritFunctionTableData();
  const hasMeritData = persistedMerit !== null;
  const persistedRequirements = tryLoadPersistedSystemRequirementsTableData();
  const hasRequirementsData = persistedRequirements !== null;
  
  const config1 = systemConfig.configurations[0];
  let needsSave = false;
  
  if (systemConfig.configurations.length === 1 && 
      (hasSourceData || hasObjectData || hasOpticalData || hasMeritData || hasRequirementsData)) {
    
    if (hasSourceData) {
      config1.source = persistedSource as any;
      needsSave = true;
    }
    if (hasObjectData) {
      config1.object = persistedObject as any;
      needsSave = true;
    }
    if (hasOpticalData) {
      config1.opticalSystem = persistedOptical as any;
      needsSave = true;
    }
    if (hasMeritData) {
      config1.meritFunction = persistedMerit as any;
      needsSave = true;
    }
    if (hasRequirementsData && Array.isArray(systemConfig.systemRequirements) && systemConfig.systemRequirements.length === 0) {
      systemConfig.systemRequirements = persistedRequirements as any;
      needsSave = true;
    }
    
    // System Data を移行
    const refFLInput = document.getElementById('reference-focal-length') as HTMLInputElement | null;
    if (!config1.systemData) {
      config1.systemData = {};
    }
    config1.systemData.referenceFocalLength = refFLInput ? refFLInput.value : '';
    
    if (needsSave) {
      saveSystemConfigurations(systemConfig);
    }
  }
  
  // 初回起動時、またはlocalStorageにsource/objectデータがない場合は、
  // Config 1のデフォルトデータをlocalStorageに保存
  if (!hasSourceData && config1 && Array.isArray(config1.source) && config1.source.length > 0) {
    saveSourceTableData(config1.source as any);
  }
  if (!hasObjectData && config1 && Array.isArray(config1.object) && config1.object.length > 0) {
    saveObjectTableData(config1.object as any);
  }
  if (!hasRequirementsData) {
    saveSystemRequirementsTableData(
      Array.isArray(systemConfig.systemRequirements) ? systemConfig.systemRequirements as any : []
    );
  }

  // Migration: ensure block-based configs preserve legacy Object row thickness for conjugate detection.
  try {
    let changed = false;
    for (const cfg of systemConfig.configurations || []) {
      if (!cfg || typeof cfg !== 'object') continue;
      const hasBlocks = Array.isArray((cfg as any).blocks) && (cfg as any).blocks.length > 0;
      if (!hasBlocks) continue;

      const t = (cfg as any).opticalSystem?.[0]?.thickness;
      const tStr = (t === undefined || t === null) ? '' : String(t).trim().toUpperCase();
      const hasThickness = (t === Infinity) || (tStr !== '' && tStr !== 'UNDEFINED');
      if (hasThickness) continue;

      // If the config has a legacy opticalSystem snapshot, use its first-row thickness.
      const legacy0 = Array.isArray((cfg as any).opticalSystem) ? (cfg as any).opticalSystem[0] : null;
      if (legacy0 && typeof legacy0 === 'object' && legacy0.thickness !== undefined && legacy0.thickness !== null) {
        continue;
      }

      // As a fallback, if cfg.opticalSystem exists with rows, keep it; otherwise leave as-is.
      // The updated saveCurrentToActiveConfiguration will populate this going forward.
      if (!Array.isArray((cfg as any).opticalSystem)) {
        (cfg as any).opticalSystem = [];
        changed = true;
      }
    }

    if (changed) {
      saveSystemConfigurations(systemConfig);
    }
  } catch (_) {}
  
  // CRITICAL: Validate all configurations on startup
  // Ensure localStorage contains fresh data for all configs
  let configsRefreshed = false;
  for (const cfg of systemConfig.configurations) {
    if (!cfg || typeof cfg !== 'object') continue;
    
    // Check if config has valid data structure
    const hasObject = Array.isArray(cfg.object) && cfg.object.length > 0;
    const hasOptical = Array.isArray(cfg.opticalSystem) && cfg.opticalSystem.length > 0;
    
    // If config data looks valid, ensure it's current
    if (hasObject || hasOptical) {
      // Config has data, mark as refreshed to ensure localStorage has latest
      configsRefreshed = true;
    }
  }
  
  // If we have multiple configs with data, save to ensure localStorage sync
  if (systemConfig.configurations.length > 1 || configsRefreshed) {
    saveSystemConfigurations(systemConfig);
  }
}

/**
 * Configuration UIを更新
 */
function updateConfigurationSelect(): void {
  // Keep Spot Diagram config selector synchronized with available configs.
  try {
    if (typeof window !== 'undefined' && typeof w.updateSpotDiagramConfigSelect === 'function') {
      w.updateSpotDiagramConfigSelect();
    }
  } catch (_) {}

  renderConfigurationOrderList();
}

function clearConfigDropIndicator(row: HTMLElement | null): void {
  if (!row) return;
  row.classList.remove('drag-over-before');
  row.classList.remove('drag-over-after');
}

function handleConfigurationReorder(targetConfigId: string, position: 'before' | 'after'): void {
  if (!draggedConfigId || draggedConfigId === targetConfigId) {
    return;
  }

  const changed = reorderConfiguration(draggedConfigId, targetConfigId, position);
  if (!changed) {
    return;
  }

  updateConfigurationSelect();
  updateConfigInfo();
}

async function activateConfiguration(newConfigId: string): Promise<void> {
  const normalizedConfigId = String(newConfigId ?? '').trim();
  const currentConfigId = getActiveConfigId();

  if (!normalizedConfigId || String(normalizedConfigId) === String(currentConfigId)) {
    return;
  }

  if (!areTablesReady()) {
    console.warn('⚠️ [Configuration] Tables not ready yet, deferring config switch...');
    setTimeout(() => {
      if (areTablesReady()) {
        void activateConfiguration(normalizedConfigId);
      }
    }, 500);
    return;
  }

  if (isConfigurationSwitching) {
    return;
  }

  isConfigurationSwitching = true;
  try {
    if (typeof window !== 'undefined') {
      (w as any).__configurationSwitching = true;
    }
  } catch (_) {}
  stopAutoSave();
  setConfigControlsEnabled(false);

  console.log(`🔄 [Configuration] Switching from ${currentConfigId} to ${normalizedConfigId}...`);
  console.log(`💾 [Configuration] Saving current config ${currentConfigId} before switch...`);
  saveCurrentToActiveConfiguration();
  console.log('✅ [Configuration] Current config saved');

  try {
    setActiveConfiguration(normalizedConfigId);

    const targetConfig = getActiveConfiguration();
    if (!targetConfig) {
      throw new Error(`Target configuration ${normalizedConfigId} not found`);
    }

    const hasValidObject = Array.isArray(targetConfig.object) && targetConfig.object.length > 0;
    const hasValidOptical = Array.isArray(targetConfig.opticalSystem) && targetConfig.opticalSystem.length > 0;
    const hasValidBlocks = Array.isArray(targetConfig.blocks) && targetConfig.blocks.length > 0;

    if (!hasValidObject) {
      console.warn(`⚠️ [Configuration] Target config ${targetConfig.name} has no Object data`);
    }

    if (!hasValidOptical && !hasValidBlocks) {
      console.warn(`⚠️ [Configuration] Target config ${targetConfig.name} has no Optical System or Blocks data`);
    }

    console.log(`🔄 [Configuration] Loading configuration ${normalizedConfigId} "${targetConfig.name}" to tables...`);
    console.log('🔍 [Configuration] Target config data:', {
      hasObject: hasValidObject,
      objectCount: targetConfig.object?.length || 0,
      hasOptical: hasValidOptical,
      opticalCount: targetConfig.opticalSystem?.length || 0,
      hasBlocks: hasValidBlocks,
      blocksCount: targetConfig.blocks?.length || 0
    });
    console.log('🔍 [Configuration] Tables available:', {
      source: !!w.tableSource,
      object: !!w.tableObject,
      opticalSystem: !!w.tableOpticalSystem
    });

    await loadActiveConfigurationToTables({ applyToUI: true });
    console.log(`✅ [Configuration] Configuration ${normalizedConfigId} loaded to tables`);

    try {
      if (typeof window !== 'undefined') {
        if (typeof w.updateWavefrontObjectSelect === 'function') {
          w.updateWavefrontObjectSelect();
        }
        if (typeof w.updatePSFObjectOptions === 'function') {
          w.updatePSFObjectOptions();
        } else if (typeof w.setupPSFObjectSelect === 'function') {
          w.setupPSFObjectSelect();
        }
      }
    } catch (e) {
      console.warn('⚠️ [Configuration] Failed to refresh object selects:', e);
    }

    updateConfigurationSelect();
    updateConfigInfo();

    try {
      const spotCfg = document.getElementById('spot-diagram-config-select') as HTMLSelectElement | null;
      if (spotCfg) {
        const desired = String(normalizedConfigId);
        const has = Array.from(spotCfg.options || []).some(o => String(o.value) === desired);
        spotCfg.value = has ? desired : '';
      }
    } catch (_) {}
    try { w.updateSurfaceNumberSelectLegacy(); } catch (_) {}
    try { requestUpdateSurfaceNumberSelect(); } catch (_) {}

    try {
      if (typeof window !== 'undefined' && typeof w.updateSpotDiagramConfigSelect === 'function') {
        w.updateSpotDiagramConfigSelect();
      }
    } catch (_) {}

    try {
      requestRefreshBlockInspector();
    } catch (e) {
      console.warn('⚠️ [Configuration] Failed to refresh Design Intent (Blocks):', e);
    }

    try {
      const popup = w.popup3DWindow;
      if (popup && !popup.closed && typeof popup.postMessage === 'function') {
        popup.postMessage({ action: 'request-redraw' }, '*');
      }
    } catch (e) {
      console.warn('⚠️ [Configuration] Failed to request 3D popup redraw:', e);
    }
  } finally {
    isConfigurationSwitching = false;
    try {
      if (typeof window !== 'undefined') {
        setTimeout(() => {
          try { (w as any).__configurationSwitching = false; } catch (_) {}
        }, 0);
      }
    } catch (_) {}
    lastConfigSwitchTimestamp = Date.now();
    setConfigControlsEnabled(true);
    setupAutoSave();
    console.log('✅ [Configuration] Config switch complete, autosave will resume after 10s');
  }
}

function renderConfigurationOrderList(): void {
  const container = document.getElementById('config-order-list');
  if (!container) return;

  const configList = getConfigurationList();
  container.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'config-order-list-title';
  title.textContent = 'Drag to reorder';
  container.appendChild(title);

  if (configList.length <= 1) {
    const empty = document.createElement('div');
    empty.className = 'config-order-empty';
    empty.textContent = 'Add another configuration to change the order.';
    container.appendChild(empty);
    return;
  }

  configList.forEach((config: any) => {
    const row = document.createElement('div');
    row.className = 'config-order-row';
    row.draggable = true;
    row.dataset.configId = String(config.id);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    if (config.active) row.classList.add('active');

    const handle = document.createElement('span');
    handle.className = 'config-order-handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to reorder';

    const name = document.createElement('span');
    name.className = 'config-order-name';
    name.textContent = config.active ? `${config.name} ★` : config.name;

    row.appendChild(handle);
    row.appendChild(name);

    row.addEventListener('dragstart', (event: DragEvent) => {
      draggedConfigId = String(config.id);
      row.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(config.id));
      }
    });

    row.addEventListener('dragend', () => {
      draggedConfigId = null;
      row.classList.remove('dragging');
      clearConfigDropIndicator(row);
    });

    row.addEventListener('dragover', (event: DragEvent) => {
      if (!draggedConfigId || draggedConfigId === String(config.id)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const isBefore = event.clientY < rect.top + rect.height / 2;
      row.classList.toggle('drag-over-before', isBefore);
      row.classList.toggle('drag-over-after', !isBefore);
    });

    row.addEventListener('dragleave', (event: DragEvent) => {
      const related = event.relatedTarget as Node | null;
      if (related && row.contains(related)) return;
      clearConfigDropIndicator(row);
    });

    row.addEventListener('drop', (event: DragEvent) => {
      if (!draggedConfigId || draggedConfigId === String(config.id)) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = row.getBoundingClientRect();
      const position: 'before' | 'after' = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      clearConfigDropIndicator(row);
      handleConfigurationReorder(String(config.id), position);
    });

    row.addEventListener('click', () => {
      void activateConfiguration(String(config.id));
    });

    row.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      void activateConfiguration(String(config.id));
    });

    container.appendChild(row);
  });
}

/**
 * Configuration情報表示を更新
 */
function updateConfigInfo(): void {
  const infoDiv = document.getElementById('config-info');
  if (!infoDiv) return;
  
  const activeConfig = getActiveConfiguration();
  const configList = getConfigurationList();
  
  if (!activeConfig) {
    infoDiv.innerHTML = '<em>No configuration found</em>';
    return;
  }
  
  const modifiedDate = new Date(activeConfig.metadata.modified).toLocaleString('ja-JP');
  
  infoDiv.innerHTML = `
    <strong>Active:</strong> ${activeConfig.name} | 
    <strong>Total Configs:</strong> ${configList.length} | 
    <strong>Last Modified:</strong> ${modifiedDate}
  `;
}

/**
 * イベントリスナー設定
 */
function setupConfigurationEventListeners(): void {
  const globalListenersInstalled = w.__configurationDelegatedListenersInstalled === true;
  if (globalListenersInstalled) {
    configurationDelegatedListenersInstalled = true;
  }

  if (!configurationDelegatedListenersInstalled) {
    configurationDelegatedListenersInstalled = true;
    w.__configurationDelegatedListenersInstalled = true;

    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest('button');
      if (!button) return;

      switch (button.id) {
        case 'add-config-btn':
          event.preventDefault();
          handleAddConfiguration();
          break;
        case 'delete-config-btn':
          event.preventDefault();
          handleDeleteConfiguration();
          break;
        case 'duplicate-config-btn':
          event.preventDefault();
          handleDuplicateConfiguration();
          break;
        case 'rename-config-btn':
          event.preventDefault();
          handleRenameConfiguration();
          break;
        default:
          break;
      }
    });
  }
  
  // テーブル変更時に自動保存
  setupAutoSave();
}

/**
 * Configuration追加ハンドラー
 */
function handleAddConfiguration(): void {
  const name = prompt('新しいConfiguration名を入力してください:', `Config ${getConfigurationList().length + 1}`);
  
  if (!name || name.trim() === '') {
    return;
  }
  
  // 現在の編集内容を保存してから追加
  saveCurrentToActiveConfiguration();
  
  const newId = addConfiguration(name.trim());
  
  if (newId) {
    alert(`Configuration "${name}" を作成しました。`);
    updateConfigurationSelect();
    updateConfigInfo();
  }
}

/**
 * Configuration削除ハンドラー
 */
function handleDeleteConfiguration(): void {
  const activeId = getActiveConfigId();
  const activeConfig = getActiveConfiguration();
  const configList = getConfigurationList();
  
  if (configList.length <= 1) {
    alert('最後のConfigurationは削除できません。');
    return;
  }
  
  const confirmed = confirm(`Configuration "${activeConfig.name}" を削除しますか？\n\nこの操作は元に戻せません。`);
  
  if (!confirmed) return;
  
  const success = deleteConfiguration(activeId);
  
  if (success) {
    alert(`Configuration "${activeConfig.name}" を削除しました。`);
    
    // アクティブなConfigurationが変わったのでUIに反映
    isConfigurationSwitching = true;
    stopAutoSave();
    loadActiveConfigurationToTables({ applyToUI: true }).finally(() => {
      updateConfigurationSelect();
      updateConfigInfo();

      try {
        requestRefreshBlockInspector();
      } catch (e) {
        console.warn('⚠️ [Configuration] Failed to refresh Design Intent (Blocks):', e);
      }

      isConfigurationSwitching = false;
      setupAutoSave();
    });
  }
}

/**
 * Configuration複製ハンドラー
 */
function handleDuplicateConfiguration(): void {
  const activeId = getActiveConfigId();
  const activeConfig = getActiveConfiguration();
  
  // 現在の編集内容を保存してから複製
  saveCurrentToActiveConfiguration();
  
  const newId = duplicateConfiguration(activeId);
  
  if (newId) {
    alert(`Configuration "${activeConfig.name}" を複製しました。`);
    updateConfigurationSelect();
    updateConfigInfo();
  }
}

/**
 * Configuration名前変更ハンドラー
 */
function handleRenameConfiguration(): void {
  
  const activeId = getActiveConfigId();
  const activeConfig = getActiveConfiguration();
  
  console.log('📋 [Configuration] Active ID:', activeId, 'Active Config:', activeConfig);
  
  const newName = prompt('新しいConfiguration名を入力してください:', activeConfig.name);
  
  if (!newName || newName.trim() === '' || newName.trim() === activeConfig.name) {
    console.log('⚠️ [Configuration] Rename cancelled or unchanged');
    return;
  }
  
  const success = renameConfiguration(activeId, newName.trim());
  
  if (success) {
    alert(`Configuration名を "${newName}" に変更しました。`);
    updateConfigurationSelect();
    updateConfigInfo();
    console.log('✅ [Configuration] Rename successful');
  } else {
    console.error('❌ [Configuration] Rename failed');
  }
}

/**
 * テーブル変更時の自動保存を設定
 */
function setupAutoSave(): void {
  // 既存のテーブルにイベントリスナーを追加
  // 各テーブルが変更されたときに、アクティブなConfigurationに自動保存

  const globalIntervalId = Number(w.__configurationAutoSaveIntervalId);
  if (Number.isFinite(globalIntervalId) && globalIntervalId !== 0) {
    autoSaveIntervalId = globalIntervalId;
  }

  // 定期的に自動保存（5秒ごと）
  if (autoSaveIntervalId === null) {
    autoSaveIntervalId = window.setInterval(() => {
      if (shouldSkipAutoSave()) return;
      saveCurrentToActiveConfiguration();
    }, 5000);
    w.__configurationAutoSaveIntervalId = autoSaveIntervalId;
  }

  if (w.__configurationBeforeUnloadHandlerInstalled === true) {
    beforeUnloadHandlerInstalled = true;
  }

  const isSecondaryWindowContext = (() => {
    try {
      const url = new URL(window.location.href);
      return [
        'coopt_render_window',
        'coopt_analysis_window',
        'coopt_optimize_window',
        'coopt_settings_window'
      ].some((key) => url.searchParams.get(key) === '1');
    } catch (_) {
      return false;
    }
  })();

  // ページ離脱時に保存
  if (!beforeUnloadHandlerInstalled && !isSecondaryWindowContext) {
    beforeUnloadHandlerInstalled = true;
    w.__configurationBeforeUnloadHandlerInstalled = true;
    window.addEventListener('beforeunload', () => {
      if (shouldSkipAutoSave()) return;
      saveCurrentToActiveConfiguration();
    });
  }
}

// グローバルエクスポート
if (typeof window !== 'undefined') {
  w.initializeConfigurationUI = initializeConfigurationUI;
  w.loadActiveConfigurationToTables = loadActiveConfigurationToTables;
}
