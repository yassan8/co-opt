import { miscellaneousDB, oharaGlassDB, schottGlassDB, calculateRefractiveIndex, getGlassDataWithSellmeier, getAllGlassDatabases, getPrimaryWavelength } from './glass.ts';
import { loadSystemConfigurations, saveSystemConfigurations, loadActiveConfigurationToTables, getActiveConfiguration } from './table-configuration.ts';
import { configurationHasBlocks, validateBlocksConfiguration, expandBlocksToOpticalSystemRows, deriveBlocksFromLegacyOpticalSystemRows } from './block-schema.ts';

function shouldDisableExpandedOpticalSystemUI() {
  try {
    // Blocks are canonical. When present, do not generate Expanded Optical System UI.
    // This prevents surface-table drift and enforces the Design Intent workflow.
    const cfg = (typeof getActiveConfiguration === 'function') ? getActiveConfiguration() : null;
    return !!cfg && configurationHasBlocks(cfg);
  } catch {
    return false;
  }
}

function createNoopOpticalSystemTable() {
  let _data = [];
  return {
    on() { return this; },
    off() { return this; },
    getData() { return Array.isArray(_data) ? _data : []; },
    setData(d) { _data = Array.isArray(d) ? d : []; return Promise.resolve(); },
    replaceData(d) { _data = Array.isArray(d) ? d : []; return Promise.resolve(); },
    updateRow(rowId, patch) {
      try {
        const idNum = (typeof rowId === 'number') ? rowId : Number(rowId);
        const idx = Array.isArray(_data) ? _data.findIndex(r => Number(r?.id) === idNum) : -1;
        if (idx >= 0) {
          const cur = _data[idx] && typeof _data[idx] === 'object' ? _data[idx] : {};
          const p = (patch && typeof patch === 'object') ? patch : {};
          _data[idx] = { ...cur, ...p };
        }
      } catch (_) {}
      return Promise.resolve();
    },
    updateData(rows) {
      try {
        if (!Array.isArray(rows)) return Promise.resolve();
        for (const r of rows) {
          const idNum = Number(r?.id);
          if (!Number.isFinite(idNum)) continue;
          const idx = Array.isArray(_data) ? _data.findIndex(x => Number(x?.id) === idNum) : -1;
          if (idx >= 0) {
            const cur = _data[idx] && typeof _data[idx] === 'object' ? _data[idx] : {};
            _data[idx] = { ...cur, ...(r && typeof r === 'object' ? r : {}) };
          }
        }
      } catch (_) {}
      return Promise.resolve();
    },
    updateColumnDefinition() { return; },
    addRow() { return Promise.resolve(); },
    deleteRow() { return Promise.resolve(); },
    deselectRow() { return; },
    getSelectedCells() { return []; },
    getSelectedRows() { return []; },
    getSelectedData() { return []; },
    getElement() {
      try {
        return document.getElementById('table-optical-system') || null;
      } catch {
        return null;
      }
    }
  };
}

