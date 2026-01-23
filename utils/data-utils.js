/**
 * Data Utilities Module
 * JS_lensDraw v3 - Data Retrieval and Management Functions
 */

import { 
    calculateParaxialData,
    calculateFullSystemParaxialTrace
} from '../raytracing/core/ray-paraxial.js';
import { calculateSurfaceOrigins } from '../raytracing/core/ray-tracing.js';
import { getPrimaryWavelength } from '../data/glass.js';
import { calculateSeidelCoefficients, formatSeidelCoefficients } from '../evaluation/aberrations/seidel-coefficients.js';
import { getActiveConfiguration } from '../data/table-configuration.js';
import { configurationHasBlocks, expandBlocksToOpticalSystemRows } from '../data/block-schema.js';

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
      || t === 'coordbreak' || t === 'coord break' || t === 'cb';
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
  // walk that skips non-physical rows (Object/Image/Stop/CoordBreak).
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

    const __du_blocksHaveObjectPlane = (blocks) => {
      try {
        return Array.isArray(blocks) && blocks.some(b => String(b?.blockType ?? '').trim() === 'ObjectPlane');
      } catch (_) {
        return false;
      }
    };

    // Preserve object thickness if present in config.opticalSystem.
    // BUT: when ObjectPlane exists, blocks are canonical for object distance.
    try {
      if (!__du_blocksHaveObjectPlane(blocksToExpand)) {
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
 * Surface Origins（各面の原点座標）をDebug Dataに出力する関数
 * @param {Object} tableOpticalSystem - The optical system table instance
 */
export function displayCoordinateTransformMatrix(tableOpticalSystem) {
  duLog('🔄 Starting displayCoordinateTransformMatrix function');
  try {
    const opticalSystemRows = getOpticalSystemRows(tableOpticalSystem);
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
      duWarn('⚠️ No optical system data found');
      return;
    }
    
    // Surface Originsを計算
    const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
    
    let debugOutput = "=== Surface Origins (各面の原点座標) ===\n";
    debugOutput += `計算日時: ${new Date().toLocaleString()}\n\n`;
    
    surfaceOrigins.forEach((surfaceData, index) => {
      const surface = opticalSystemRows[index];
      const origin = surfaceData.origin;
      
      debugOutput += `Surface ${index + 1}: ${surface.surfType || 'Standard'}\n`;
      debugOutput += `  Origin: X=${origin.x.toFixed(6)}, Y=${origin.y.toFixed(6)}, Z=${origin.z.toFixed(6)}\n`;
      
      if (surface.surfType === 'Coord Break' || surface.surfType === 'Coordinate Break') {
        debugOutput += `  Decenter: X=${surface.decenterX || surface.semidia || 0}, Y=${surface.decenterY || surface.material || 0}\n`;
        debugOutput += `  Tilt: X=${surface.tiltX || surface.rindex || 0}°, Y=${surface.tiltY || surface.abbe || 0}°, Z=${surface.tiltZ || surface.conic || 0}°\n`;
      }
      
      if (surface.thickness) {
        debugOutput += `  Thickness: ${surface.thickness}\n`;
      }
      
      debugOutput += "\n";
    });
    
    // System Dataエリアに出力
    const systemTextarea = document.getElementById('system-data');
    if (systemTextarea) {
      systemTextarea.value = debugOutput;
      duLog('✅ Surface origins output to system data');
    } else {
      console.error('❌ System data textarea not found');
    }
    
  } catch (error) {
    console.error('❌ Error in displayCoordinateTransformMatrix:', error);
  }
}

/**
 * 近軸計算結果をDebug Dataに出力する関数
 * @param {Object} tableOpticalSystem - The optical system table instance (optional)
 */
export function outputParaxialDataToDebug(tableOpticalSystem = null) {
  duLog('📐 Starting outputParaxialDataToDebug function');
  duLog('🔍 tableOpticalSystem argument:', !!tableOpticalSystem);
  try {
    const opticalSystemRows = getOpticalSystemRows(tableOpticalSystem);
    duLog('📊 opticalSystemRows:', opticalSystemRows ? opticalSystemRows.length : 0, 'rows');
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
      duWarn('⚠️ No optical system data found');
      return;
    }
    
    // 主波長を取得
    const primaryWavelength = getPrimaryWavelength();
    duLog('🌈 Primary wavelength:', primaryWavelength);
    
    // 近軸計算を実行
    const paraxialData = calculateParaxialData(opticalSystemRows, primaryWavelength);
    duLog('📏 Paraxial data:', paraxialData);
    
    let debugOutput = "=== System Data ===\n";
    debugOutput += `Calculation Time: ${new Date().toLocaleString()}\n\n`;
    
    if (paraxialData) {
      duLog('✅ Paraxial data calculation successful');
      // === PRIMARY SYSTEM DATA ===
      debugOutput += "=== Primary Optical System Data ===\n";
      debugOutput += `Primary Wavelength:               ${primaryWavelength} μm\n`;
      debugOutput += `Focal Length (FL):                ${paraxialData.focalLength?.toFixed(6) || 'N/A'} mm\n`;
      
      // Calculate EFL using h[1] / α[IMG-1] formula considering actual object thickness
      let eflValue = 'N/A';
      try {
        // Use the actual optical system with current object thickness for EFL calculation
        const eflResult = calculateFullSystemParaxialTrace(opticalSystemRows, primaryWavelength);
        duLog('🔍 EFL calculation result:', eflResult);
        if (eflResult && Math.abs(eflResult.finalAlpha) > 1e-10) {
          const efl = 1.0 / eflResult.finalAlpha; // h[1] = 1.0, so EFL = h[1] / α[IMG-1]
          eflValue = efl.toFixed(6);
        }
      } catch (error) {
        duWarn('EFL calculation error:', error);
      }
      debugOutput += `Effective Focal Length (EFL):     ${eflValue} mm\n`;
      
      debugOutput += `Back Focal Length (BFL):          ${paraxialData.backFocalLength?.toFixed(6) || 'N/A'} mm\n`;
      debugOutput += `Image Distance:                   ${paraxialData.imageDistance?.toFixed(6) || 'N/A'} mm\n`;
      
      // Object and Image Distances
      const objectThickness = opticalSystemRows[0].thickness;
      const objectDistanceStr = String(objectThickness).toUpperCase();
      
      if (objectDistanceStr === "INF" || objectDistanceStr === "INFINITY") {
        debugOutput += `Object Distance:                  Infinity (infinite object)\n`;
      } else {
        const objectDistance = parseFloat(objectThickness) || 0;
        debugOutput += `Object Distance:                  ${objectDistance.toFixed(6)} mm\n`;
      }
      
      // Total System Length (sum of all thicknesses)
      let totalThickness = 0;
      for (let i = 0; i < opticalSystemRows.length; i++) {
        const thickness = opticalSystemRows[i].thickness;
        const thicknessStr = String(thickness).toUpperCase();
        if (thicknessStr !== "INF" && thicknessStr !== "INFINITY") {
          const thicknessValue = parseFloat(thickness);
          if (isFinite(thicknessValue)) {
            totalThickness += thicknessValue;
          }
        }
      }
      debugOutput += `Total System Length:              ${totalThickness.toFixed(6)} mm\n`;
      
      // === ADDITIONAL PARAXIAL PARAMETERS ===
      // Get necessary values for calculations
      const newSpecPupils = paraxialData.newSpecPupils;
      const exitPupil = newSpecPupils?.exitPupil;
      const entrancePupil = newSpecPupils?.entrancePupil;
      const focalLength = paraxialData.focalLength;
      
      // Paraxial Magnification β = α[1] / α[IMG]
      let paraxialMagnification = 'N/A';
      
      if (objectDistanceStr === "INF" || objectDistanceStr === "INFINITY") {
        paraxialMagnification = '0.000000'; // Infinite object
      } else {
        // Calculate initial alpha for finite object
        const objectDistance = parseFloat(objectThickness);
        if (isFinite(objectDistance) && objectDistance !== 0) {
          const initialAlpha = -1.0 / (1.0 * objectDistance); // α[1] = -h[1]/(n*d0)
          const finalAlpha = paraxialData.finalAlpha;
          if (finalAlpha && Math.abs(finalAlpha) > 1e-10) {
            const beta = initialAlpha / finalAlpha;
            paraxialMagnification = beta.toFixed(6);
          }
        }
      }

      // === Pupil details (for quick verification) ===
      if (exitPupil && typeof exitPupil.diameter === 'number') {
        const betaExp = (typeof exitPupil.betaExp === 'number') ? exitPupil.betaExp : exitPupil.magnification;
        const betaExpStr = (typeof betaExp === 'number' && isFinite(betaExp)) ? betaExp.toFixed(6) : 'N/A';
        debugOutput += `Exit Pupil Magnification (βexp): ${betaExpStr}\n`;
        debugOutput += `Exit Pupil Diameter (ExPD):     ${exitPupil.diameter.toFixed(6)} mm\n`;
      }
      debugOutput += `Paraxial Magnification:           ${paraxialMagnification}\n`;
      
      // Object Space F# = ABS(F#_work / β) if β≠0, else 0
      let objectSpaceFNumber = 'N/A';
      if (paraxialMagnification !== 'N/A') {
        const beta = parseFloat(paraxialMagnification);
        if (Math.abs(beta) > 1e-10) {
          // Calculate F#_work first (Paraxial Working F#)
          // 新しい計算式による射出瞳径を優先使用
          const exitPupilDiameter = paraxialData.exitPupilDetails?.diameter || exitPupil?.diameter;
          const exitPupilPosition = paraxialData.exitPupilDetails?.position || exitPupil?.position;
          
          if (exitPupilPosition && exitPupilDiameter) {
            const fNumberWork = Math.abs(exitPupilPosition) / exitPupilDiameter;
            const fNumberObj = Math.abs(fNumberWork / beta);
            objectSpaceFNumber = fNumberObj.toFixed(6);
          }
        } else {
          objectSpaceFNumber = '0.000000'; // β = 0 case
        }
      }
      debugOutput += `Object Space F#:                  ${objectSpaceFNumber}\n`;
      
      // Image Space F# = f' / EnPD
      let imageSpaceFNumber = 'N/A';
      if (focalLength && entrancePupil && entrancePupil.diameter) {
        const fNumberImg = focalLength / entrancePupil.diameter;
        imageSpaceFNumber = fNumberImg.toFixed(6);
      }
      debugOutput += `Image Space F#:                   ${imageSpaceFNumber}\n`;
      
      // Paraxial Working F# = (-ExP + id) / ExPD (using exit pupil position from origin)
      let paraxialWorkingFNumber = 'N/A';
      
      // Get exit pupil position from origin (not from Image plane)
      let exitPupilPositionFromOrigin = null;
      let exitPupilDiameterForWorkingF = null;
      
      if (paraxialData.exitPupilDetails && paraxialData.exitPupilDetails.position !== undefined && paraxialData.exitPupilDetails.position !== null) {
        exitPupilPositionFromOrigin = paraxialData.exitPupilDetails.position;
        exitPupilDiameterForWorkingF = paraxialData.exitPupilDetails.diameter;
      }
      
      if (exitPupilPositionFromOrigin !== null && exitPupilDiameterForWorkingF && paraxialData.imageDistance) {
        const fNumberWork = (-exitPupilPositionFromOrigin + paraxialData.imageDistance) / exitPupilDiameterForWorkingF;
        paraxialWorkingFNumber = fNumberWork.toFixed(6);
      }
      debugOutput += `Paraxial Working F#:              ${paraxialWorkingFNumber}\n`;
      
      // Object Space NA = ABS(NA_img * β)
      let objectSpaceNA = 'N/A';
      let imageSpaceNA = 'N/A';
      
      // Image Space NA = 1/(2 * F#_work)
      if (paraxialWorkingFNumber !== 'N/A') {
        const fNumberWork = parseFloat(paraxialWorkingFNumber);
        const naImg = 1.0 / (2.0 * fNumberWork);
        imageSpaceNA = naImg.toFixed(6);
        
        // Object Space NA calculation
        if (paraxialMagnification !== 'N/A') {
          const beta = parseFloat(paraxialMagnification);
          const naObj = Math.abs(naImg * beta);
          objectSpaceNA = naObj.toFixed(6);
        }
      }
      debugOutput += `Object Space NA:                  ${objectSpaceNA}\n`;
      debugOutput += `Image Space NA:                   ${imageSpaceNA}\n`;
      
      // === PUPIL CALCULATION RESULTS ===
      debugOutput += "\n=== Pupil Calculation ===\n";
      
      // 新しい計算式の結果を優先表示
      if (paraxialData.exitPupilDetails && paraxialData.exitPupilDetails.diameter !== null) {
        debugOutput += `Exit Pupil Diameter:              ${paraxialData.exitPupilDetails.diameter.toFixed(6)} mm\n`;
        // Exit Pupil PositionをImage面からの距離として表示
        const exitPupilPosFromOrigin = paraxialData.exitPupilDetails.position;
        const imageDistance = paraxialData.imageDistance;
        let exitPupilPosFromImage = 'N/A';
        if (exitPupilPosFromOrigin !== null && exitPupilPosFromOrigin !== undefined && imageDistance) {
          exitPupilPosFromImage = (exitPupilPosFromOrigin - imageDistance).toFixed(6);
        }
        debugOutput += `Exit Pupil Position:              ${exitPupilPosFromImage} mm (from Image)\n`;
        debugOutput += `Exit Pupil Magnification:         ${paraxialData.exitPupilDetails.magnification?.toFixed(6) || 'N/A'}\n`;
      } else if (paraxialData.newSpecPupils && paraxialData.newSpecPupils.exitPupil) {
        const exitPupil = paraxialData.newSpecPupils.exitPupil;
        // Exit Pupil PositionをImage面からの距離として表示
        const exitPupilPosFromOrigin = exitPupil.position;
        const imageDistance = paraxialData.imageDistance;
        let exitPupilPosFromImage = 'N/A';
        if (exitPupilPosFromOrigin !== null && exitPupilPosFromOrigin !== undefined && imageDistance) {
          exitPupilPosFromImage = (exitPupilPosFromOrigin - imageDistance).toFixed(6);
        }
        debugOutput += `Exit Pupil Position:              ${exitPupilPosFromImage} mm (from Image)\n`;
  debugOutput += `Exit Pupil Diameter:              ${exitPupil.diameter?.toFixed(6) || 'N/A'} mm\n`;
        debugOutput += `Exit Pupil Magnification:         ${exitPupil.magnification?.toFixed(6) || 'N/A'}\n`;
      }
      
      if (paraxialData.newSpecPupils && paraxialData.newSpecPupils.entrancePupil) {
        const entrancePupil = paraxialData.newSpecPupils.entrancePupil;
        debugOutput += `Entrance Pupil Position:          ${entrancePupil.position?.toFixed(6) || 'N/A'} mm\n`;
        debugOutput += `Entrance Pupil Diameter:          ${entrancePupil.diameter?.toFixed(6) || 'N/A'} mm\n`;
        debugOutput += `Entrance Pupil Magnification:     ${entrancePupil.magnification?.toFixed(6) || 'N/A'}\n`;
      }
      
      debugOutput += "\n";
      
      // === DETAILED CALCULATION INFORMATION ===
      if (paraxialData.exitPupilDetails && paraxialData.exitPupilDetails.specMethodDetails) {
        const details = paraxialData.exitPupilDetails.specMethodDetails;
        debugOutput += "=== Exit Pupil Calculation Details ===\n";
        debugOutput += `Method: Chief/Marginal Ray Tracing (New Method)\n`;
  debugOutput += `Formula: Exit Pupil Diameter = abs(stop_sr * βexp * 2)\n`;
        debugOutput += `Status: ${details.isValid ? 'Valid' : 'Invalid'}\n`;
        
        if (details.isValid) {
          debugOutput += `\nCalculation Parameters:\n`;
          debugOutput += `  stop_sr (Stop Surface Radius): ${details.stopRadius?.toFixed(6) || 'N/A'} mm\n`;
          debugOutput += `  βexp (Stop→Image Magnification): ${details.βexp?.toFixed(6) || 'N/A'}\n`;
          // βenpは現行のExPD算出では未使用\n`;
          if (details.warning) {
            debugOutput += `Warning: ${details.warning}\n`;
          }
          debugOutput += `\nCalculation Steps:\n`;
          debugOutput += `  Exit Pupil Diameter: ${details.exitPupilDiameter?.toFixed(6) || 'N/A'} mm\n`;
          debugOutput += `  Final Calculation: {${details.h_final?.toFixed(6)}/${details.M?.toFixed(6)}*(${details.C?.toFixed(6)}-${details.M?.toFixed(6)})} * ${details.entrancePupilDiameter?.toFixed(6)}\n`;
          debugOutput += `  Result: ${paraxialData.exitPupilDiameter?.toFixed(6)} mm\n`;
        } else if (details.warning) {
          debugOutput += `Warning: ${details.warning}\n`;
        }
        debugOutput += "\n";
      }
      
      // 入射瞳位置の表示
      debugOutput += "\n";
      
      // === SURFACE DETAILS ===
      if (paraxialData.surfaceDetails && paraxialData.surfaceDetails.length > 0) {
        debugOutput += "=== Surface Details ===\n";
        paraxialData.surfaceDetails.forEach((surface, index) => {
          debugOutput += `Surface ${index + 1}:\n`;
          if (surface.power !== undefined) {
            debugOutput += `  Power: ${surface.power.toFixed(6)} D\n`;
          }
          if (surface.radius !== undefined) {
            debugOutput += `  Radius: ${surface.radius} mm\n`;
          }
          if (surface.thickness !== undefined) {
            debugOutput += `  Thickness: ${surface.thickness} mm\n`;
          }
          if (surface.refractiveIndex !== undefined) {
            debugOutput += `  Refractive Index: ${surface.refractiveIndex}\n`;
          }
          debugOutput += "\n";
        });
      }
    } else {
      duWarn('❌ Paraxial data calculation failed');
      debugOutput += "Paraxial calculation failed.\n";
    }
    
    duLog('📝 Final debug output length:', debugOutput.length);
    duLog('📝 Debug output sample:', debugOutput.substring(0, 500) + '...');
    
    // System Dataエリアに出力
    const systemTextarea = document.getElementById('system-data');
    if (systemTextarea) {
      systemTextarea.value = debugOutput;
      duLog('✅ Paraxial data output to system data - length:', debugOutput.length);
    } else {
      console.error('❌ System data textarea not found');
    }
  } catch (error) {
    console.error('❌ Error in outputParaxialDataToDebug:', error);
  }
}

/**
 * Seidel係数をSystem Dataに出力する関数
 */
export function outputSeidelCoefficientsToDebug() {
  duLog('🔬 Starting outputSeidelCoefficientsToDebug function');
  
  try {
    const opticalSystemRows = getOpticalSystemRows();
    duLog('📊 opticalSystemRows:', opticalSystemRows ? opticalSystemRows.length : 0, 'rows');
    
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
      duWarn('⚠️ No optical system data found');
      return;
    }
    
    // Objectテーブルのデータを取得
    const objectRows = window.tableObject ? window.tableObject.getData() : [];
    
    // 主波長を取得
    const primaryWavelength = getPrimaryWavelength();
    duLog('🌈 Primary wavelength:', primaryWavelength);
    
    let debugOutput = "";
    let seidelData = null;
    
    try {
      seidelData = calculateSeidelCoefficients(opticalSystemRows, primaryWavelength, objectRows);
      
      if (seidelData) {
        duLog('✅ Seidel coefficients calculation successful');
        debugOutput += formatSeidelCoefficients(seidelData);
        
        // 色収差の波長別光線追跡データを追加
        if (seidelData.chromaticTraceDataOutput) {
          debugOutput += seidelData.chromaticTraceDataOutput;
        }
      } else {
        duWarn('❌ Seidel coefficients calculation failed');
        debugOutput += "Seidel coefficients calculation failed.\n";
      }
    } catch (error) {
      console.error('❌ Seidel coefficients calculation error:', error);
      debugOutput += `Seidel coefficients calculation error: ${error.message}\n`;
    }
    
    duLog('📝 Final Seidel output length:', debugOutput.length);
    
    // System Dataエリアに出力
    const systemTextarea = document.getElementById('system-data');
    if (systemTextarea) {
      systemTextarea.value = debugOutput;
      duLog('✅ Seidel coefficients output to system data');
    } else {
      console.error('❌ System data textarea not found');
    }

    // Block Contribution Summary (under System Evaluation)
    try {
      renderBlockContributionSummaryFromSeidel(seidelData, opticalSystemRows);
    } catch (e) {
      // Keep System Data output working even if summary fails.
      console.warn('⚠️ Block contribution summary render failed:', e);
    }
    
  } catch (error) {
    console.error('❌ Error in outputSeidelCoefficientsToDebug:', error);
  }
}

function padLeft(value, width) {
  const s = String(value ?? '');
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function padRight(value, width) {
  const s = String(value ?? '');
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function aggregateBlockContributionFromSeidel(seidelData, opticalSystemRows) {
  const coeffs = seidelData?.surfaceCoefficients;
  const rows = Array.isArray(opticalSystemRows) ? opticalSystemRows : [];

  const out = {
    version: 1,
    updatedAt: Date.now(),
    byBlockId: Object.create(null),
    totals: {
      surfaceCount: 0,
      sumLCA: 0,
      sumTCA: 0,
    },
    meta: {
      hasSurfaceCoefficients: Array.isArray(coeffs) && coeffs.length > 0,
    },
  };

  if (!Array.isArray(coeffs) || coeffs.length === 0) return out;

  const groups = new Map();
  const roleGroups = new Map();

  for (const sc of coeffs) {
    const surfaceIndex = Number(sc?.surfaceIndex);
    if (!Number.isFinite(surfaceIndex) || surfaceIndex < 0 || surfaceIndex >= rows.length) continue;

    const row = rows[surfaceIndex];
    const blockId = row?._blockId;
    const blockType = row?._blockType;
    const role = row?._surfaceRole ?? '(none)';
    if (!blockId) continue;
    if (blockType === 'ImagePlane' || blockType === 'Image') continue;

    const key = String(blockId);
    const current = groups.get(key) || {
      blockId: key,
      blockType: blockType ?? '(unknown)',
      firstSurfaceIndex: surfaceIndex,
      surfaceCount: 0,
      sumLCA: 0,
      sumTCA: 0,
    };
    current.firstSurfaceIndex = Math.min(current.firstSurfaceIndex, surfaceIndex);
    current.surfaceCount += 1;
    current.sumLCA += safeNumber(sc?.LCA);
    current.sumTCA += safeNumber(sc?.TCA);
    groups.set(key, current);

    const roleKey = `${key}:${String(role)}`;
    const roleCurrent = roleGroups.get(roleKey) || {
      blockId: key,
      blockType: blockType ?? '(unknown)',
      role: String(role),
      firstSurfaceIndex: surfaceIndex,
      surfaceCount: 0,
      sumLCA: 0,
      sumTCA: 0,
    };
    roleCurrent.firstSurfaceIndex = Math.min(roleCurrent.firstSurfaceIndex, surfaceIndex);
    roleCurrent.surfaceCount += 1;
    roleCurrent.sumLCA += safeNumber(sc?.LCA);
    roleCurrent.sumTCA += safeNumber(sc?.TCA);
    roleGroups.set(roleKey, roleCurrent);
  }

  const list = Array.from(groups.values()).sort((a, b) => a.firstSurfaceIndex - b.firstSurfaceIndex);
  const roleList = Array.from(roleGroups.values()).sort((a, b) => {
    if (a.firstSurfaceIndex !== b.firstSurfaceIndex) return a.firstSurfaceIndex - b.firstSurfaceIndex;
    if (a.blockId !== b.blockId) return String(a.blockId).localeCompare(String(b.blockId));
    return String(a.role).localeCompare(String(b.role));
  });

  for (const g of list) {
    out.byBlockId[g.blockId] = {
      blockId: g.blockId,
      blockType: g.blockType,
      firstSurfaceIndex: g.firstSurfaceIndex,
      surfaceCount: g.surfaceCount,
      sumLCA: g.sumLCA,
      sumTCA: g.sumTCA,
      roles: [],
    };
    out.totals.surfaceCount += g.surfaceCount;
    out.totals.sumLCA += g.sumLCA;
    out.totals.sumTCA += g.sumTCA;
  }

  for (const rg of roleList) {
    const block = out.byBlockId[rg.blockId];
    if (!block) continue;
    block.roles.push({
      role: rg.role,
      firstSurfaceIndex: rg.firstSurfaceIndex,
      surfaceCount: rg.surfaceCount,
      sumLCA: rg.sumLCA,
      sumTCA: rg.sumTCA,
    });
  }

  return out;
}

function formatBlockContributionSummary(seidelData, opticalSystemRows) {
  const coeffs = seidelData?.surfaceCoefficients;
  if (!Array.isArray(coeffs) || coeffs.length === 0) {
    return '=== Block Contribution Summary ===\nNo surface coefficients available.\n';
  }

  const rows = Array.isArray(opticalSystemRows) ? opticalSystemRows : [];
  const groups = new Map();
  const roleGroups = new Map();

  for (const sc of coeffs) {
    const surfaceIndex = Number(sc?.surfaceIndex);
    if (!Number.isFinite(surfaceIndex) || surfaceIndex < 0 || surfaceIndex >= rows.length) continue;

    const row = rows[surfaceIndex];
    const blockId = row?._blockId;
    const blockType = row?._blockType;
    const role = row?._surfaceRole ?? '(none)';
    if (!blockId) continue;
    if (blockType === 'ImagePlane' || blockType === 'Image') continue;

    const key = String(blockId);
    const current = groups.get(key) || {
      blockId: key,
      blockType: blockType ?? '(unknown)',
      firstSurfaceIndex: surfaceIndex,
      surfaceCount: 0,
      sumLCA: 0,
      sumTCA: 0,
    };
    current.firstSurfaceIndex = Math.min(current.firstSurfaceIndex, surfaceIndex);
    current.surfaceCount += 1;
    current.sumLCA += safeNumber(sc?.LCA);
    current.sumTCA += safeNumber(sc?.TCA);
    groups.set(key, current);

    const roleKey = `${key}:${String(role)}`;
    const roleCurrent = roleGroups.get(roleKey) || {
      blockId: key,
      blockType: blockType ?? '(unknown)',
      role: String(role),
      firstSurfaceIndex: surfaceIndex,
      surfaceCount: 0,
      sumLCA: 0,
      sumTCA: 0,
    };
    roleCurrent.firstSurfaceIndex = Math.min(roleCurrent.firstSurfaceIndex, surfaceIndex);
    roleCurrent.surfaceCount += 1;
    roleCurrent.sumLCA += safeNumber(sc?.LCA);
    roleCurrent.sumTCA += safeNumber(sc?.TCA);
    roleGroups.set(roleKey, roleCurrent);
  }

  const list = Array.from(groups.values()).sort((a, b) => a.firstSurfaceIndex - b.firstSurfaceIndex);

  let out = '';
  out += '=== Block Contribution Summary (LCA/TCA) ===\n';
  out += 'Aggregated from Seidel surfaceCoefficients using expanded-row provenance (_blockId/_blockType).\n\n';

  const header = [
    padRight('BlockId', 22),
    padRight('Type', 10),
    padLeft('Surf', 6),
    padLeft('ΣLCA', 14),
    padLeft('ΣTCA', 14),
  ].join(' ');
  out += header + '\n';
  out += '-'.repeat(header.length) + '\n';

  let totalSurf = 0;
  let totalLCA = 0;
  let totalTCA = 0;

  for (const g of list) {
    totalSurf += g.surfaceCount;
    totalLCA += g.sumLCA;
    totalTCA += g.sumTCA;
    out += [
      padRight(g.blockId, 22),
      padRight(g.blockType, 10),
      padLeft(g.surfaceCount, 6),
      padLeft(g.sumLCA.toExponential(6), 14),
      padLeft(g.sumTCA.toExponential(6), 14),
    ].join(' ') + '\n';
  }

  out += '-'.repeat(header.length) + '\n';
  out += [
    padRight('TOTAL', 22),
    padRight('', 10),
    padLeft(totalSurf, 6),
    padLeft(totalLCA.toExponential(6), 14),
    padLeft(totalTCA.toExponential(6), 14),
  ].join(' ') + '\n';

  // Role breakdown
  const roleList = Array.from(roleGroups.values()).sort((a, b) => {
    if (a.firstSurfaceIndex !== b.firstSurfaceIndex) return a.firstSurfaceIndex - b.firstSurfaceIndex;
    if (a.blockId !== b.blockId) return String(a.blockId).localeCompare(String(b.blockId));
    return String(a.role).localeCompare(String(b.role));
  });

  if (roleList.length > 0) {
    out += '\n';
    out += '--- Role Breakdown (within block) ---\n';
    const roleHeader = [
      padRight('BlockId', 22),
      padRight('Role', 10),
      padLeft('Surf', 6),
      padLeft('ΣLCA', 14),
      padLeft('ΣTCA', 14),
    ].join(' ');
    out += roleHeader + '\n';
    out += '-'.repeat(roleHeader.length) + '\n';

    for (const g of roleList) {
      out += [
        padRight(g.blockId, 22),
        padRight(g.role, 10),
        padLeft(g.surfaceCount, 6),
        padLeft(g.sumLCA.toExponential(6), 14),
        padLeft(g.sumTCA.toExponential(6), 14),
      ].join(' ') + '\n';
    }
  }

  return out;
}

export function renderBlockContributionSummaryFromSeidel(seidelData, opticalSystemRows) {
  // Always refresh structured aggregation (used by Apply Reason panel).
  try {
    globalThis.__blockContributionData = aggregateBlockContributionFromSeidel(seidelData, opticalSystemRows);
  } catch (e) {
    console.warn('⚠️ Failed to aggregate block contribution data:', e);
  }

  const section = document.getElementById('block-contribution-section');
  const textarea = document.getElementById('block-contribution-summary');
  if (!section || !textarea) return;

  const text = formatBlockContributionSummary(seidelData, opticalSystemRows);
  textarea.value = text;
  section.style.display = 'block';
}

function formatSignedFixed(n, digits) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'N/A';
  const abs = Math.abs(v).toFixed(digits);
  return (v >= 0 ? `+${abs}` : `-${abs}`);
}

function coerceFiniteNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  if (/^inf(inity)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeObjectType(row) {
  const raw = row && typeof row === 'object'
    ? (row['object type'] ?? row.objectType ?? row.object ?? row.type)
    : null;
  return String(raw ?? '').trim().toLowerCase();
}

// Spec: last refractive surface = the surface immediately before Image.
// BFL = z_image - z_last = (in sequential model) thickness of the last surface before Image.
export function computeBFLFromSurfaceRows(surfaceRows) {
  const rows = Array.isArray(surfaceRows) ? surfaceRows : [];
  if (rows.length < 2) return null;

  let imageIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (normalizeObjectType(rows[i]) === 'image') {
      imageIdx = i;
      break;
    }
  }

  if (imageIdx <= 0) return null;
  const lastIdx = imageIdx - 1;
  const t = coerceFiniteNumber(rows[lastIdx]?.thickness);
  return t;
}

export function renderSystemConstraintsFromSurfaceRows(surfaceRows) {
  const textarea = document.getElementById('system-constraints-summary');
  if (!textarea) return;

  // Ensure a stable header even if early returns happen.
  if (!textarea.value) {
    textarea.value = '=== System Requirements ===\n\n';
  }

  const bfl = computeBFLFromSurfaceRows(surfaceRows);

  const labelWidth = 28;
  const pad = (s) => String(s).padEnd(labelWidth);

  let out = '';
  out += '=== System Requirements ===\n\n';

  if (bfl === null) {
    out += `${pad('Back Focal Length (BFL):')} N/A\n`;
    textarea.value = out;
    return;
  }

  out += `${pad('Back Focal Length (BFL):')} ${bfl.toFixed(3)} mm\n`;

  textarea.value = out;
}

/**
 * Output optical system debug data to console and textarea
 * @param {Object} tableOpticalSystem - The optical system table instance
 * @param {Object} tableObject - The object table instance
 * @param {Object} tableSource - The source table instance
 */
export function outputDebugSystemData(tableOpticalSystem, tableObject, tableSource) {
  duLog('🔍 Starting outputDebugSystemData function');
  
  try {
    // Get data from all tables
    const opticalSystemRows = getOpticalSystemRows(tableOpticalSystem);
    const objectRows = getObjectRows(tableObject);
    const sourceRows = getSourceRows(tableSource);
    
    // Create debug output
    let debugOutput = '=== JS_lensDraw v3 - System Debug Data ===\n';
    debugOutput += `Generated: ${new Date().toLocaleString()}\n\n`;
    
    // Optical System Data
    debugOutput += '📊 OPTICAL SYSTEM DATA:\n';
    debugOutput += `Surfaces: ${opticalSystemRows.length}\n`;
    opticalSystemRows.forEach((row, index) => {
      debugOutput += `  Surface ${index}: R=${row.radius}, t=${row.thickness}, n=${row.nd}, material=${row.material}\n`;
    });
    debugOutput += '\n';
    
    // Object Data
    debugOutput += '🎯 OBJECT DATA:\n';
    debugOutput += `Objects: ${objectRows.length}\n`;
    objectRows.forEach((row, index) => {
      debugOutput += `  Object ${index}: height=${row.height}, distance=${row.distance}, angle=${row.angle}\n`;
    });
    debugOutput += '\n';
    
    // Source Data
    debugOutput += '💡 SOURCE DATA:\n';
    debugOutput += `Sources: ${sourceRows.length}\n`;
    sourceRows.forEach((row, index) => {
      debugOutput += `  Source ${index}: wavelength=${row.wavelength}, primary=${row.primary}\n`;
    });
    debugOutput += '\n';
    
    // Output to console
    duLog(debugOutput);
    
    // Output to textarea if available
    const systemDataTextarea = document.getElementById('system-data');
    if (systemDataTextarea) {
      systemDataTextarea.value = debugOutput;
      duLog('✅ System debug data output to textarea');
    } else {
      duLog('ℹ️ System data textarea not found, console output only');
    }
    
  } catch (error) {
    console.error('❌ Error in outputDebugSystemData:', error);
  }
}

/**
 * Debug function to check table initialization status
 */
export function debugTableStatus() {
  duLog('🔍 Debugging table status:');
  duLog('  - window.opticalSystemTabulator:', !!window.opticalSystemTabulator);
  duLog('  - window.tableOpticalSystem:', !!window.tableOpticalSystem);
  duLog('  - window.tableObject:', !!window.tableObject);
  duLog('  - window.tableSource:', !!window.tableSource);
    
    // Check DOM elements
    const opticalSystemTableElement = document.getElementById('table-optical-system');
    duLog('  - table-optical-system element:', !!opticalSystemTableElement);
    if (opticalSystemTableElement) {
      duLog('  - table-optical-system tabulator:', !!opticalSystemTableElement.tabulator);
    }
    
    const altOpticalSystemTableElement = document.getElementById('optical-system-table');
    duLog('  - optical-system-table element:', !!altOpticalSystemTableElement);
    if (altOpticalSystemTableElement) {
      duLog('  - optical-system-table tabulator:', !!altOpticalSystemTableElement.tabulator);
    }
    
    // Try to get data
    const opticalSystemData = getOpticalSystemRows();
    duLog('  - optical system data rows:', opticalSystemData ? opticalSystemData.length : 0);
    
    return {
        opticalSystemTabulator: !!window.opticalSystemTabulator,
        tableOpticalSystem: !!window.tableOpticalSystem,
        tableObject: !!window.tableObject,
        tableSource: !!window.tableSource,
        opticalSystemDataRows: opticalSystemData ? opticalSystemData.length : 0
    };
}

/**
 * Create dummy optical system data for testing
 */
export function createDummyOpticalSystemData() {
    return [
        {
            id: 1,
            surface: 'Object',
            type: 'plane',
            radius: 'INF',
            thickness: 100,
            material: 'air',
            semidiameter: 5,
            conic: 0,
            stop: false,
            variable: false
        },
        {
            id: 2,
            surface: 'S1',
            type: 'spherical',
            radius: 50,
            thickness: 10,
            material: 'BK7',
            semidiameter: 20,
            conic: 0,
            stop: false,
            variable: false
        },
        {
            id: 3,
            surface: 'S2',
            type: 'spherical',
            radius: -50,
            thickness: 90,
            material: 'air',
            semidiameter: 20,
            conic: 0,
            stop: false,
            variable: false
        },
        {
            id: 4,
            surface: 'Image',
            type: 'plane',
            radius: 'INF',
            thickness: 0,
            material: 'air',
            semidiameter: 10,
            conic: 0,
            stop: false,
            variable: false
        }
    ];
}

/**
 * Initialize tables with dummy data for testing
 */
export function initializeTablesWithDummyData() {
  duLog('🔧 Initializing tables with dummy data...');
    
    try {
        // Initialize optical system table with dummy data
        if (window.tableOpticalSystem && typeof window.tableOpticalSystem.setData === 'function') {
            const dummyOpticalData = createDummyOpticalSystemData();
            window.tableOpticalSystem.setData(dummyOpticalData);
            duLog('✅ Optical system table initialized with dummy data');
        }
        
        // Initialize object table with dummy data
        if (window.tableObject && typeof window.tableObject.setData === 'function') {
            const dummyObjectData = [
                { id: 1, height: 10, distance: 100, angle: 0, wavelength: 0.55, primary: true }
            ];
            window.tableObject.setData(dummyObjectData);
            duLog('✅ Object table initialized with dummy data');
        }
        
        // Initialize source table with dummy data
        if (window.tableSource && typeof window.tableSource.setData === 'function') {
            const dummySourceData = [
                { id: 1, wavelength: 0.55, primary: true },
                { id: 2, wavelength: 0.48, primary: false },
                { id: 3, wavelength: 0.65, primary: false }
            ];
            window.tableSource.setData(dummySourceData);
            duLog('✅ Source table initialized with dummy data');
        }
        
          duLog('✅ All tables initialized with dummy data');
        return true;
        
    } catch (error) {
        console.error('❌ Error initializing tables with dummy data:', error);
        return false;
    }
}
