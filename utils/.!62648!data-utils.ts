/**
 * Data Utilities Module
 * JS_lensDraw v3 - Data Retrieval and Management Functions
 */

import { 
    calculateParaxialData,
    calculateFullSystemParaxialTrace
} from '../raytracing/core/ray-paraxial.ts';
import { calculateSurfaceOrigins } from '../raytracing/core/ray-tracing.ts';
import { getPrimaryWavelength } from '../data/glass.ts';
import { calculateSeidelCoefficients, formatSeidelCoefficients } from '../evaluation/aberrations/seidel-coefficients.ts';
import { getActiveConfiguration } from '../data/table-configuration.ts';
import { configurationHasBlocks, expandBlocksToOpticalSystemRows } from '../data/block-schema.ts';

const DATA_UTILS_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__DATA_UTILS_DEBUG);
const duLog = (...args) => { if (DATA_UTILS_DEBUG) console.log(...args); };
const duWarn = (...args) => { if (DATA_UTILS_DEBUG) console.warn(...args); };

let warnedUsingDummyOpticalSystemData = false;
let warnedUsingLocalStorageOpticalSystemData = false;
let warnedUsingBlocksOpticalSystemData = false;

function __du_isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function __du_cloneJson(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

function __du_parseOverrideKey(variableId) {
  const s = String(variableId ?? '');
  const dot = s.indexOf('.');
  if (dot <= 0) return null;
  const blockId = s.slice(0, dot);
  const key = s.slice(dot + 1);
  if (!blockId || !key) return null;
  return { blockId, key };
}

function __du_applyOverridesToBlocks(blocks, overrides) {
  const cloned = __du_cloneJson(blocks);
  if (!Array.isArray(cloned)) return Array.isArray(blocks) ? blocks : [];
  if (!__du_isPlainObject(overrides)) return cloned;

  const byId = new Map();
  for (const b of cloned) {
    const id = __du_isPlainObject(b) ? String(b.blockId ?? '') : '';
    if (id) byId.set(id, b);
  }

  for (const [varId, rawVal] of Object.entries(overrides)) {
    const parsed = __du_parseOverrideKey(varId);
    if (!parsed) continue;
    const blk = byId.get(String(parsed.blockId));
    if (!blk) continue;

    // Allow overrides to target per-surface semidia stored in block.aperture[role]
    // via keys like: "BlockId.aperture.front" / "BlockId.aperture.s1".
    try {
      const k = String(parsed.key ?? '');
      const m = /^aperture\.(.+)$/.exec(k);
      if (m) {
        const role = String(m[1] ?? '').trim();
        if (role) {
          if (!__du_isPlainObject(blk.aperture)) blk.aperture = {};
          const n = Number(rawVal);
          blk.aperture[role] = Number.isFinite(n) ? n : rawVal;
          continue;
        }
      }
    } catch (_) {}

    if (!__du_isPlainObject(blk.parameters)) continue;
    const n = Number(rawVal);
    blk.parameters[parsed.key] = Number.isFinite(n) ? n : rawVal;
  }

  return cloned;
}

function __du_pickLegacyRowsForSemidia(activeCfg) {
  try {
    const legacy = Array.isArray(activeCfg?.opticalSystem) ? activeCfg.opticalSystem : null;
    if (legacy && legacy.length > 0) return legacy;
  } catch (_) {}

  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('OpticalSystemTableData') : null;
    if (!raw) return null;
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : null;
  } catch (_) {
    return null;
  }
}

function __du_preserveLegacySemidiaIntoExpandedRows(expandedRows, legacyRows, blocksForExplicitAperture) {
  if (!Array.isArray(expandedRows) || !Array.isArray(legacyRows)) return;
  const hasValue = (v) => {
    if (v === null || v === undefined) return false;
    const s = String(v).trim();
    return s !== '';
  };
  const getLegacySemidia = (row) => {
    if (!row || typeof row !== 'object') return null;
    return row.semidia ?? row['Semi Diameter'] ?? row['semi diameter'] ?? row.semiDiameter ?? row.semiDia;
  };

  const rowType = (row) => String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
  const isSkippableRow = (row) => {
    const t = rowType(row);
    return t === 'stop' || t === 'sto' || t === 'image' || t === 'object'
      || t === 'coordtrans' || t === 'coord trans' || t === 'ct';
  };
  const keyFor = (row) => {
    if (!row || typeof row !== 'object') return '';
    const bid = String(row._blockId ?? '').trim();
    const role = String(row._surfaceRole ?? '').trim();
    return (bid && role) ? `${bid}|${role}` : '';
  };

  // Build a quick lookup so explicit Design Intent aperture overrides win.
  const explicit = new Map();
  try {
    if (Array.isArray(blocksForExplicitAperture)) {
      for (const b of blocksForExplicitAperture) {
        const id = b && typeof b === 'object' ? String(b.blockId ?? '').trim() : '';
        if (!id) continue;
        const ap = (b && typeof b === 'object' && b.aperture && typeof b.aperture === 'object') ? b.aperture : null;
        if (ap) {
          for (const [role, v] of Object.entries(ap)) {
            if (!hasValue(v)) continue;
            explicit.set(`p:${id}|${String(role)}`, v);
          }
        }

        // Mirror uses parameters.semidia (not block.aperture). Treat it as explicit.
        try {
          const bt = String(b?.blockType ?? '').trim();
          if (bt === 'Mirror') {
            const v = b?.parameters?.semidia;
            if (hasValue(v)) {
              explicit.set(`p:${id}|mirror`, v);
            }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  // Prefer provenance-based mapping when available, otherwise do a stable two-pointer
  // walk that skips non-physical rows (Object/Image/Stop/CoordTrans).
  const legacyByKey = new Map();
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

    // If Design Intent explicitly specified this surface semidia, never override it.
    try {
      const bid = String(e?._blockId ?? '').trim();
      const role = String(e?._surfaceRole ?? '').trim();
      if (bid && role) {
        const pk = `p:${bid}|${role}`;
        if (explicit.has(pk)) continue;
      }
    } catch (_) {}

    const lsRaw = getLegacySemidia(l);
    if (hasValue(lsRaw)) e.semidia = lsRaw;
  }
}

function __du_expandActiveBlocksToRows() {
  try {
    if (typeof getActiveConfiguration !== 'function') return null;
    const activeCfg = getActiveConfiguration();
    if (!configurationHasBlocks(activeCfg)) return null;

    const scenarios = Array.isArray(activeCfg?.scenarios) ? activeCfg.scenarios : null;
    const scenarioId = activeCfg?.activeScenarioId ? String(activeCfg.activeScenarioId) : '';
    const scn = (scenarioId && scenarios)
      ? scenarios.find(s => s && String(s.id) === String(scenarioId))
      : null;
    const overrides = scn && __du_isPlainObject(scn.overrides) ? scn.overrides : null;
    const blocksToExpand = overrides
      ? __du_applyOverridesToBlocks(activeCfg.blocks, overrides)
      : activeCfg.blocks;

    const expanded = expandBlocksToOpticalSystemRows(blocksToExpand);
    const rows = expanded && Array.isArray(expanded.rows) ? expanded.rows : null;
    if (!rows || rows.length === 0) return null;

    // Legacy semidia merge is now opt-in only.
    try {
      const allowLegacySemidia = !!(typeof globalThis !== 'undefined' && globalThis.__cooptEnableLegacySemidiaMerge === true);
      if (allowLegacySemidia) {
        const legacyRows = __du_pickLegacyRowsForSemidia(activeCfg);
        if (legacyRows) __du_preserveLegacySemidiaIntoExpandedRows(rows, legacyRows, blocksToExpand);
      }
    } catch (_) {}

    const __du_blocksHaveObjectSurface = (blocks) => {
      try {
        return Array.isArray(blocks) && blocks.some(b => {
          const bt = String(b?.blockType ?? '').trim();
          return bt === 'ObjectSurface' || bt === 'ObjectPlane';
        });
      } catch (_) {
        return false;
      }
    };

    // Preserve object thickness if present in config.opticalSystem.
    // BUT: when ObjectSurface exists, blocks are canonical for object distance.
    try {
      if (!__du_blocksHaveObjectSurface(blocksToExpand)) {
        const preferredThickness = activeCfg?.opticalSystem?.[0]?.thickness;
        if (preferredThickness !== undefined && preferredThickness !== null && String(preferredThickness).trim() !== '') {
          rows[0] = { ...rows[0], thickness: preferredThickness };
        }
      }
    } catch (_) {}

    return rows;
  } catch {
    return null;
  }
}

function tryGetLocalStorageArray(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Get optical system table data
 * @param {Object} tableOpticalSystem - The optical system table instance (optional)
 * @returns {Array} Optical system data
 */
export function getOpticalSystemRows(tableOpticalSystem) {
  duLog('🔍 getOpticalSystemRows called with tableOpticalSystem:', !!tableOpticalSystem);
  try {
    // Optimization override: allow callers (e.g. optimizer) to provide a transient
    // optical system row set without mutating the Tabulator UI.
    // This is critical for finite-difference Jacobians where table UI might not refresh.
    try {
      const ov = (typeof globalThis !== 'undefined') ? globalThis.__cooptOpticalSystemRowsOverride : null;
      if (Array.isArray(ov)) return ov;
    } catch (_) {}

    // Blocks-first mode: if Design Intent (blocks) exists, it is the source of truth.
    // This intentionally bypasses the Expanded Optical System (Tabulator/localStorage) to
    // prevent drift between Requirements/Optimize/Evaluation.
    //
    // IMPORTANT: This can surprise users when they manually tweak the Optical System table
    // (e.g. moving image plane by ±1–2mm) and evaluations (OPD/PSF/etc) don't change.
    // For debugging / manual sweeps, you can force using the table via:
    //   globalThis.__cooptPreferTableOpticalSystemRows = true
    const preferTable = !!(typeof globalThis !== 'undefined' && globalThis.__cooptPreferTableOpticalSystemRows === true);
    if (!preferTable) {
      const blockRows = __du_expandActiveBlocksToRows();
      if (Array.isArray(blockRows) && blockRows.length > 0) {
        if (!warnedUsingBlocksOpticalSystemData) {
          console.warn('⚠️ Using Design Intent (blocks) as the optical system source of truth; Optical System table edits are ignored. Set globalThis.__cooptPreferTableOpticalSystemRows=true to force using the table rows.');
          warnedUsingBlocksOpticalSystemData = true;
        }
        return blockRows;
      }
    }

    // First try with provided table instance
    if (tableOpticalSystem && typeof tableOpticalSystem.getData === 'function') {
      duLog('📊 Using provided tableOpticalSystem.getData()');
      const data = tableOpticalSystem.getData();
      duLog('📋 tableOpticalSystem data:', data ? data.length : 0, 'rows');
      return data || [];
    }
    
    // Try window.tableOpticalSystem (the actual table object)
    if (window.tableOpticalSystem && typeof window.tableOpticalSystem.getData === 'function') {
      duLog('📊 Using window.tableOpticalSystem.getData()');
      const data = window.tableOpticalSystem.getData();
      duLog('📋 window.tableOpticalSystem data:', data ? data.length : 0, 'rows');
      return data || [];
    }
    
    // Try global opticalSystemTabulator
    if (window.opticalSystemTabulator && typeof window.opticalSystemTabulator.getData === 'function') {
      duLog('📊 Using window.opticalSystemTabulator.getData()');
      const data = window.opticalSystemTabulator.getData();
      duLog('📋 opticalSystemTabulator data:', data ? data.length : 0, 'rows');
      return data || [];
    }
    
    // Try DOM element tabulator
    const tableElement = document.getElementById('table-optical-system');
    if (tableElement && tableElement.tabulator) {
      duLog('📊 Using DOM element tabulator.getData()');
      const data = tableElement.tabulator.getData();
      duLog('📋 DOM tabulator data:', data ? data.length : 0, 'rows');
      return data || [];
    }
    
    // Try alternative table element ID
    const altTableElement = document.getElementById('optical-system-table');
    if (altTableElement && altTableElement.tabulator) {
      duLog('📊 Using alternative DOM element tabulator.getData()');
      const data = altTableElement.tabulator.getData();
      duLog('📋 Alt DOM tabulator data:', data ? data.length : 0, 'rows');
      return data || [];
    }
    
    // Fallback: localStorage (works even if Tabulator failed to initialize)
    const localStorageRows = tryGetLocalStorageArray('OpticalSystemTableData');
    if (localStorageRows && localStorageRows.length > 0) {
      if (!warnedUsingLocalStorageOpticalSystemData) {
        console.warn('⚠️ No optical system table found; using OpticalSystemTableData from localStorage');
        warnedUsingLocalStorageOpticalSystemData = true;
      }
      return localStorageRows;
    }

    if (!warnedUsingDummyOpticalSystemData) {
      console.warn('⚠️ No optical system table found; using dummy data (enable __DATA_UTILS_DEBUG for details)');
      warnedUsingDummyOpticalSystemData = true;
    }
    return createDummyOpticalSystemData();
  } catch (error) {
    console.error('❌ Error retrieving optical system data:', error);

    // Fallback: localStorage
    const localStorageRows = tryGetLocalStorageArray('OpticalSystemTableData');
    if (localStorageRows && localStorageRows.length > 0) {
      if (!warnedUsingLocalStorageOpticalSystemData) {
        console.warn('⚠️ Using OpticalSystemTableData from localStorage due to error');
        warnedUsingLocalStorageOpticalSystemData = true;
      }
      return localStorageRows;
    }

    if (!warnedUsingDummyOpticalSystemData) {
      console.warn('⚠️ Using dummy optical system data due to error (enable __DATA_UTILS_DEBUG for details)');
      warnedUsingDummyOpticalSystemData = true;
    }
    return createDummyOpticalSystemData();
  }
}

/**
 * Get object table data
 * @param {Object} tableObject - The object table instance
 * @returns {Array} Object data
 */
export function getObjectRows(tableObject) {
  try {
    if (tableObject && typeof tableObject.getData === 'function') {
      return tableObject.getData();
    }
    
    // Try window.tableObject (the actual table object)
    if (window.tableObject && typeof window.tableObject.getData === 'function') {
      return window.tableObject.getData();
    }
    
    else if (window.objectTabulator && typeof window.objectTabulator.getData === 'function') {
      duLog('📊 Using window.objectTabulator.getData()');
      const data = window.objectTabulator.getData();
      duLog('📋 window.objectTabulator data:', data);
      return data;
    }
    else {
      duLog('📊 Trying to get tabulator from table element');
      const tableElement = document.getElementById('table-object');
      if (tableElement && tableElement.tabulator) {
        duLog('📊 Using tableElement.tabulator.getData()');
        const data = tableElement.tabulator.getData();
        duLog('📋 tableElement.tabulator data:', data);
        return data;
      }
      duWarn('⚠️ No tabulator instance found');
    }
  } catch (error) {
    console.error('❌ Error retrieving object data:', error);
  }
  duLog('📊 Returning empty array');
  return [];
}

/**
 * Get source table data
 * @param {Object} tableSource - The source table instance
 * @returns {Array} Source data
 */
export function getSourceRows(tableSource) {
  try {
    if (tableSource && typeof tableSource.getData === 'function') {
      return tableSource.getData();
    }
    
    // Try window.tableSource (the actual table object)
    if (window.tableSource && typeof window.tableSource.getData === 'function') {
      return window.tableSource.getData();
    }
    
    else if (window.sourceTabulator && typeof window.sourceTabulator.getData === 'function') {
      return window.sourceTabulator.getData();
    }
    else {
      const tableElement = document.getElementById('table-source');
      if (tableElement && tableElement.tabulator) {
        return tableElement.tabulator.getData();
      }
    }
  } catch (error) {
    // console.error('❌ Error retrieving source data:', error);
  }
  return [];
}

/**
