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
  renameConfiguration,
  getConfigurationList
} from '../data/table-configuration.js';

let autoSaveIntervalId: number | null = null;
let isConfigurationSwitching = false;
let beforeUnloadHandlerInstalled = false;

function setConfigControlsEnabled(enabled: boolean): void {
  const ids = [
    'config-select',
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
    return isConfigurationSwitching || w.__configurationAutoSaveDisabled === true;
  } catch (_) {
    return isConfigurationSwitching;
  }
}

function stopAutoSave(): void {
  if (autoSaveIntervalId !== null) {
    clearInterval(autoSaveIntervalId);
    autoSaveIntervalId = null;
  }
}

/**
 * Configuration UIを初期化
 */
export function initializeConfigurationUI(): void {
  console.log('🔵 [Configuration UI] initializeConfigurationUI called');
  
  // 既に初期化済みの場合はUIを更新してイベントリスナーを再設定
  try {
    if (typeof window !== 'undefined' && w.__configurationUIInitialized) {
      console.log('🔵 [Configuration UI] Already initialized, refreshing UI');
      updateConfigurationSelect();
      updateConfigInfo();
      setupConfigurationEventListeners();
      return;
    }
  } catch (_) {}
  
  try {
    if (typeof window !== 'undefined') {
      w.__configurationUIInitialized = true;
    }
  } catch (_) {}
  
  console.log('🔵 [Configuration UI] First-time initialization');
  
  // 既存のConfigurationシステムを初期化（初回起動時）
  initializeConfigurationSystem();
  
  // UIコンポーネントを更新
  console.log('🔵 [Configuration UI] Updating UI components');
  updateConfigurationSelect();
  updateConfigInfo();
  
  // イベントリスナー設定
  console.log('🔵 [Configuration UI] Setting up event listeners');
  setupConfigurationEventListeners();
  
  console.log('✅ [Configuration UI] Initialization complete');
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
  const sourceData = localStorage.getItem('sourceTableData');
  const objectData = localStorage.getItem('objectTableData');
  const opticalData = localStorage.getItem('OpticalSystemTableData');
  const meritData = localStorage.getItem('meritFunctionData');
  
  if (systemConfig.configurations.length === 1 && 
      systemConfig.configurations[0].source.length === 0 &&
      (sourceData || objectData || opticalData || meritData)) {
    
    console.log('🔄 [Configuration] Migrating existing data to Config 1...');
    
    const config1 = systemConfig.configurations[0];
    config1.source = sourceData ? JSON.parse(sourceData) : [];
    config1.object = objectData ? JSON.parse(objectData) : [];
    config1.opticalSystem = opticalData ? JSON.parse(opticalData) : [];
    config1.meritFunction = meritData ? JSON.parse(meritData) : [];
    
    // System Data を移行
    const refFLInput = document.getElementById('reference-focal-length') as HTMLInputElement | null;
    if (!config1.systemData) {
      config1.systemData = {};
    }
    config1.systemData.referenceFocalLength = refFLInput ? refFLInput.value : '';
    
    saveSystemConfigurations(systemConfig);
    console.log('✅ [Configuration] Migration complete');
  }
}

/**
 * Configuration選択ドロップダウンを更新
 */
function updateConfigurationSelect(): void {
  const select = document.getElementById('config-select') as HTMLSelectElement | null;
  console.log('🔵 [Configuration UI] updateConfigurationSelect - select element:', !!select);
  if (!select) {
    console.warn('⚠️ [Configuration UI] config-select element not found!');
    return;
  }
  
  const configList = getConfigurationList();
  const activeId = getActiveConfigId();
  console.log('🔵 [Configuration UI] Config list:', configList.length, 'items, active ID:', activeId);
  
  select.innerHTML = '';
  
  configList.forEach((config: any) => {
    const option = document.createElement('option');
    option.value = String(config.id);
    option.textContent = config.name;
    
    if (config.active) {
      option.selected = true;
      option.classList.add('active-config');
      option.textContent += ' ★';
    }
    
    select.appendChild(option);
  });
  
  console.log('✅ [Configuration UI] Updated config-select with', configList.length, 'options');

  // Keep Spot Diagram config selector synchronized with available configs.
  try {
    if (typeof window !== 'undefined' && typeof w.updateSpotDiagramConfigSelect === 'function') {
      w.updateSpotDiagramConfigSelect();
    }
  } catch (_) {}
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
  
  // Configuration選択変更
  const select = document.getElementById('config-select');
  if (select) {
    select.addEventListener('change', handleConfigurationChange);
  }
  
  // Add Configボタン
  const addBtn = document.getElementById('add-config-btn');
  if (addBtn) {
    addBtn.addEventListener('click', handleAddConfiguration);
  }
  
  // Delete Configボタン
  const deleteBtn = document.getElementById('delete-config-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', handleDeleteConfiguration);
  }
  
  // Duplicate Configボタン
  const duplicateBtn = document.getElementById('duplicate-config-btn');
  if (duplicateBtn) {
    duplicateBtn.addEventListener('click', handleDuplicateConfiguration);
  }
  
  // Rename Configボタン
  const renameBtn = document.getElementById('rename-config-btn');
  if (renameBtn) {
    renameBtn.addEventListener('click', handleRenameConfiguration);
  }
  
  // テーブル変更時に自動保存
  setupAutoSave();
}

/**
 * Configuration変更ハンドラー
 */
async function handleConfigurationChange(event: Event): Promise<void> {
  const target = event.target as HTMLSelectElement;
  const newConfigId = parseInt(target.value);
  const currentConfigId = getActiveConfigId();
  
  if (newConfigId === currentConfigId) return;

  // Prevent overlapping async switches which can overwrite the wrong config
  // (rare but possible with fast UI interactions).
  if (isConfigurationSwitching) {
    try { target.value = String(currentConfigId); } catch (_) {}
    return;
  }
  isConfigurationSwitching = true;
  stopAutoSave();
  setConfigControlsEnabled(false);
  
  console.log(`🔄 [Configuration] Switching from ${currentConfigId} to ${newConfigId}...`);
  
  // 現在の編集内容を保存
  saveCurrentToActiveConfiguration();

  try {
    // 新しいConfigurationに切り替え
    setActiveConfiguration(newConfigId);
    
    // 新しいConfigurationのデータをロード
    await loadActiveConfigurationToTables({ applyToUI: true });

  // Config切替後、Objectリストを即時反映（PSF/Wavefront）
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

  // UI表示を更新
  updateConfigurationSelect();
  updateConfigInfo();

  // Sync Spot Diagram config selection with active config and refresh surface list.
  try {
    const spotCfg = document.getElementById('spot-diagram-config-select') as HTMLSelectElement | null;
    if (spotCfg) {
      const desired = String(newConfigId);
      const has = Array.from(spotCfg.options || []).some(o => String(o.value) === desired);
      spotCfg.value = has ? desired : '';
    }
  } catch (_) {}
  try { w.updateSurfaceNumberSelectLegacy(); } catch (_) {}
  try { w.updateSurfaceNumberSelect(); } catch (_) {}

  // Spot Diagram config selector may exist and should mirror available configs.
  try {
    if (typeof window !== 'undefined' && typeof w.updateSpotDiagramConfigSelect === 'function') {
      w.updateSpotDiagramConfigSelect();
    }
  } catch (_) {}

  // Design Intent (Blocks) 表示を更新
  try {
    if (typeof window !== 'undefined' && typeof w.refreshBlockInspector === 'function') {
      w.refreshBlockInspector();
    }
  } catch (e) {
    console.warn('⚠️ [Configuration] Failed to refresh Design Intent (Blocks):', e);
  }

  // Render Optical System (3D popup) を自動再描画
  try {
    const popup = w.popup3DWindow;
    if (popup && !popup.closed && typeof popup.postMessage === 'function') {
      popup.postMessage({ action: 'request-redraw' }, '*');
    }
  } catch (e) {
    console.warn('⚠️ [Configuration] Failed to request 3D popup redraw:', e);
  }

  } finally {
    // Switching guard解除 + autosave再開
    isConfigurationSwitching = false;
    setConfigControlsEnabled(true);
    setupAutoSave();
  }
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
        if (typeof window !== 'undefined' && typeof w.refreshBlockInspector === 'function') {
          w.refreshBlockInspector();
        }
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
  
  // 定期的に自動保存（5秒ごと）
  if (autoSaveIntervalId === null) {
    autoSaveIntervalId = window.setInterval(() => {
      if (shouldSkipAutoSave()) return;
      saveCurrentToActiveConfiguration();
    }, 5000);
  }
  
  // ページ離脱時に保存
  if (!beforeUnloadHandlerInstalled) {
    beforeUnloadHandlerInstalled = true;
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
