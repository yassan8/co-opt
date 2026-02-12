/**
 * Toolbar button handlers
 * Extracted from dom-event-handlers.ts for use in React components
 */

import { BLOCK_SCHEMA_VERSION } from '../compat/block-schema.ts';
import { loadSystemConfigurations, saveSystemConfigurations, clearAllPersistedState } from '../data/table-configuration.ts';
import { getLoadedFileName, setLoadedFileName } from './loaded-file-storage.ts';

declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

export function handleNewFile(): void {
  if (!confirm('Create new file? Current data will be cleared.')) return;
  
  try {
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
          parameters: { objectDistanceMode: 'INF' },
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
          parameters: {},
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
  
  const sanitizedConfig = parsedConfig ? JSON.parse(JSON.stringify(parsedConfig)) : null;
  if (sanitizedConfig) {
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

export function handleSave(): void {
  try {
    if (document.activeElement) (document.activeElement as HTMLElement).blur();

    const allData = buildAllDataForExport();
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

    const blob = new Blob([JSON.stringify(allData, null, 2)], { type: 'application/json' });
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
  if (!confirm('Load default optical system? Current data will be replaced.')) return;
  
  try {
    let response = await fetch('/co-opt/defaults/default-load.json');
    if (!response.ok) {
      response = await fetch('/defaults/default-load.json');
    }
    if (!response.ok) {
      throw new Error(`Failed to load default system: ${response.statusText}`);
    }
    const data = await response.json();
    
    if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
      await (window as any).__loadAllDataObjectIntoApp(data, { filename: 'default-load.json' });
    }
    console.log('✅ Default optical system loaded successfully');
  } catch (err) {
    console.error('❌ Failed to load default system:', err);
    alert('Failed to load default optical system. Check console for details.');
  }
}

export function handleLoad(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.style.display = 'none';
  
  input.onchange = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target?.files?.[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      
      if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
        await (window as any).__loadAllDataObjectIntoApp(data, { filename: file.name });
      }
      console.log('✅ File loaded:', file.name);
    } catch (err) {
      console.error('❌ Failed to load file:', err);
      alert(`Load failed: ${(err as Error)?.message || String(err)}`);
    }
  };
  
  document.body.appendChild(input);
  input.click();
  document.body.removeChild(input);
}

export function handleClearStorage(): void {
  if (!confirm(
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

export function handleImportZemax(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zmx';
  
  input.onchange = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target?.files?.[0];
    if (!file) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const decoder = new TextDecoder('utf-8');
      const text = decoder.decode(arrayBuffer);

      if (typeof (window as any).parseZemaxFile === 'function') {
        const parsed = (window as any).parseZemaxFile(text);
        if (parsed && typeof parsed === 'object') {
          if (typeof (window as any).__loadAllDataObjectIntoApp === 'function') {
            await (window as any).__loadAllDataObjectIntoApp(parsed, { filename: file.name });
          }
          try {
            if (typeof (window as any).autoCalculateMissingSemidia === 'function') {
              (window as any).autoCalculateMissingSemidia([], []);
            }
          } catch (_) {}
        }
      }
      console.log('✅ Zemax file imported:', file.name);
    } catch (err) {
      console.error('❌ Zemax import failed:', err);
      alert(`Import failed: ${(err as Error)?.message || String(err)}`);
    }
  };
  
  input.click();
}

export function handleExportZemax(): void {
  try {
    const opticalSystemRows = (window as any).getOpticalSystemRows 
      ? (window as any).getOpticalSystemRows((window as any).tableOpticalSystem) 
      : [];
    
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
      alert('No optical system data to export');
      return;
    }
    
    if (typeof (window as any).generateZMXText === 'function') {
      const zmxText = (window as any).generateZMXText(opticalSystemRows);
      
      if (typeof (window as any).downloadZMX === 'function') {
        const filename = 'co-opt-export.zmx';
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
  // The optimize function is complex and uses window globals
  // Just trigger the button click from the legacy handler
  console.log('[Optimize] Triggering optimization through window function');
  
  // Check if optimization is available
  if (!(window as any).OptimizationMVP) {
    alert('OptimizationMVP が利用できません。');
    return;
  }
  
  // Trigger the optimization - this will be handled by the legacy setupOptimizeDesignIntentButton
  const btn = document.getElementById('optimize-design-intent-btn');
  if (btn) {
    btn.click();
  }
}

export function handleRender3D(): void {
  const w = window as any;
  if (w.__render3DInProgress) {
    return;
  }
  w.__render3DInProgress = true;
  console.log('[Render3D] Button clicked');
  
  // Ensure event listeners are set up first
  if (typeof w.setupOpticalSystemChangeListeners === 'function' && !w.__opticalSystemChangeListenersBound) {
    console.log('[Render3D] Setting up optical system change listeners');
    w.setupOpticalSystemChangeListeners(w.scene || null);
  }
  
  const existingPopup = w.popup3DWindow;
  if (existingPopup && !existingPopup.closed) {
    try {
      existingPopup.focus();
      const hasContent = existingPopup.document && existingPopup.document.getElementById('threejs-container');
      if (hasContent) {
        console.log('[Render3D] Existing popup found, focusing');
        return;
      }
    } catch (_) {}
  }
  
  // Open popup directly using the same logic as event-handlers.ts
  const popup = window.open('', '3D Optical System', 'width=800,height=600');
  if (!popup) {
    alert('Popup blocked. Please allow popups for this site.');
    return;
  }
  
  w.popup3DWindow = popup;
  
  // Initialize the popup with basic structure
  // The full initialization will be handled by the existing popup initialization code
  if (typeof w.initialize3DPopup === 'function') {
    w.initialize3DPopup(popup);
    w.__render3DInProgress = false;
    return;
  }

  // Fallback: trigger legacy handler (event-handlers.ts) without recursion
  try {
    if (typeof w.setupOpticalSystemChangeListeners === 'function') {
      w.setupOpticalSystemChangeListeners(w.scene || null);
    }
  } catch (_) {}

  if (typeof w.__open3DWindowLegacy === 'function') {
    try { w.__open3DWindowLegacy(); } catch (_) {}
  }

  w.__render3DInProgress = false;
}

export function handleSystemData(): void {
  console.log('[SystemData] Button clicked');
  const w = window as any;
  
  // Ensure event listeners are set up first
  if (typeof w.setupAnalysisWindows === 'function' && typeof w.setupOpticalSystemChangeListeners === 'function') {
    if (!w.__opticalSystemChangeListenersBound) {
      console.log('[SystemData] Setting up optical system change listeners');
      w.setupOpticalSystemChangeListeners(w.scene || null);
    }
  }
  
  if (w.__systemDataPopup && !w.__systemDataPopup.closed) {
    try { 
      console.log('[SystemData] Existing popup found, focusing');
      w.__systemDataPopup.focus(); 
    } catch (_) {}
    return;
  }
  
  // Open popup directly
  const popup = window.open('', 'System Data', 'width=1200,height=600');
  if (!popup) {
    alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
    return;
  }
  
  w.__systemDataPopup = popup;
  
  // Initialize the popup
  if (typeof w.initializeSystemDataPopup === 'function') {
    w.initializeSystemDataPopup(popup);
  } else {
    // Fallback: trigger the button's event listener
    const btn = document.getElementById('open-system-data-window-btn');
    if (btn) {
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window
      });
      // Temporarily remove React's onClick to avoid recursion
      const reactOnClick = (btn as any).onclick;
      (btn as any).onclick = null;
      btn.dispatchEvent(clickEvent);
      setTimeout(() => {
        (btn as any).onclick = reactOnClick;
      }, 0);
    }
  }
}

export function handleAnalysisSelect(selectedValue: string): void {
  const value = String(selectedValue || '').trim();
  if (!value) return;

  const analysisButtonMap: Record<string, string> = {
    'spot-diagram': 'open-spot-diagram-window-btn',
    'spherical-aberration': 'open-spherical-aberration-window-btn',
    'astigmatism': 'open-astigmatism-window-btn',
    'distortion': 'open-distortion-window-btn',
    'integrated-aberration': 'open-integrated-aberration-window-btn',
    'transverse-aberration': 'open-transverse-aberration-window-btn',
    'opd': 'open-opd-window-btn',
    'psf': 'open-psf-window-btn',
    'mtf': 'open-mtf-window-btn'
  };

  const buttonId = analysisButtonMap[value];
  if (!buttonId) return;

  const w = window as any;
  try {
    if (typeof w.setupAnalysisWindows === 'function') {
      w.setupAnalysisWindows();
    }
  } catch (_) {}

  const button = document.getElementById(buttonId);
  if (button) {
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
    button.dispatchEvent(clickEvent);
  } else {
    console.warn(`[Analysis] Button not found: ${buttonId}`);
  }
}
