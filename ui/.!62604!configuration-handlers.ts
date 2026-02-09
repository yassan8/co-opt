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
} from '../data/table-configuration.ts';

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
