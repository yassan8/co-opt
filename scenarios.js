/**
 * Multi-State / Scenarios support (console-driven).
 *
 * Design intent remains canonical in `config.blocks`.
 * A scenario is a set of parameter overrides applied on top of blocks.
 *
 * Storage location (per configuration):
 *   config.scenarios: Array<{ id, name, weight, overrides: Record<string, any> }>
 *   config.activeScenarioId: string
 *
 * Override key format:
 *   "<blockId>.<paramKey>" (same as design-variables variableId)
 */

import { expandBlocksToOpticalSystemRows } from './data/block-schema.js';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function cloneJson(v) {
  try {
    // structuredClone is not guaranteed everywhere; JSON clone is enough for our schema.
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

function loadSystemConfigurationsRaw() {
  try {
    const json = localStorage.getItem('systemConfigurations');
    if (!json) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function saveSystemConfigurationsRaw(systemConfig) {
  try {
    localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
    return true;
  } catch {
    return false;
  }
}

function getActiveConfigRef(systemConfig) {
  if (!systemConfig || !Array.isArray(systemConfig.configurations)) return null;
  const activeId = systemConfig.activeConfigId;
  return systemConfig.configurations.find(c => c && String(c.id) === String(activeId)) || systemConfig.configurations[0] || null;
}

function ensureScenarioContainer(activeCfg) {
  if (!activeCfg) return;
  if (!Array.isArray(activeCfg.scenarios) || activeCfg.scenarios.length === 0) {
    activeCfg.scenarios = [
      {
        id: 'base',
        name: 'Base',
        weight: 1,
        overrides: {}
      }
    ];
  }
  if (!activeCfg.activeScenarioId) {
    activeCfg.activeScenarioId = String(activeCfg.scenarios[0].id);
  }
}

function findScenario(activeCfg, scenarioId) {
  if (!activeCfg || !Array.isArray(activeCfg.scenarios)) return null;
  const id = String(scenarioId);
  return activeCfg.scenarios.find(s => s && String(s.id) === id) || null;
}

function parseOverrideKey(variableId) {
  const s = String(variableId ?? '');
  const dot = s.indexOf('.');
  if (dot <= 0) return null;
  const blockId = s.slice(0, dot);
  const key = s.slice(dot + 1);
  if (!blockId || !key) return null;
  return { blockId, key };
}

function applyOverridesToBlocks(blocks, overrides) {
  const cloned = cloneJson(blocks);
  if (!Array.isArray(cloned)) return Array.isArray(blocks) ? blocks : [];
  if (!isPlainObject(overrides)) return cloned;

  const byId = new Map();
  for (const b of cloned) {
    const id = isPlainObject(b) ? String(b.blockId ?? '') : '';
    if (id) byId.set(id, b);
  }

  for (const [varId, rawVal] of Object.entries(overrides)) {
    const parsed = parseOverrideKey(varId);
    if (!parsed) continue;
    const blk = byId.get(String(parsed.blockId));
    if (!blk || !isPlainObject(blk.parameters)) continue;

    // Prefer numeric when possible.
    const n = Number(rawVal);
    blk.parameters[parsed.key] = Number.isFinite(n) ? n : rawVal;
  }

  return cloned;
}

function preserveLegacySemidiaIntoExpandedRows(expandedRows, legacyRows) {
  if (!Array.isArray(expandedRows) || !Array.isArray(legacyRows)) return;
  const n = Math.min(expandedRows.length, legacyRows.length);
  const hasValue = (v) => {
    if (v === null || v === undefined) return false;
    const s = String(v).trim();
    return s !== '';
  };
  const getLegacySemidia = (row) => {
    if (!row || typeof row !== 'object') return null;
    return row.semidia ?? row['Semi Diameter'] ?? row['semi diameter'] ?? row.semiDiameter ?? row.semiDia;
  };

  for (let i = 0; i < n; i++) {
    const e = expandedRows[i];
    const l = legacyRows[i];
    if (!e || typeof e !== 'object' || !l || typeof l !== 'object') continue;
    const t = String(e['object type'] ?? e.object ?? '').trim().toLowerCase();
    if (t === 'stop' || t === 'image') continue;
    const lsRaw = getLegacySemidia(l);
    if (hasValue(lsRaw)) e.semidia = lsRaw;
  }
}

function pickLegacyRowsForSemidia(activeCfg) {
  try {
    const legacy = Array.isArray(activeCfg?.opticalSystem) ? activeCfg.opticalSystem : null;
    if (legacy && legacy.length > 0) return legacy;
  } catch (_) {}

  // Fallback: current UI table snapshot (active config only).
  try {
    const raw = localStorage.getItem('OpticalSystemTableData');
    if (!raw) return null;
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : null;
  } catch (_) {
    return null;
  }
}

function expandActiveConfigWithScenario(activeCfg, scenarioId) {
  if (!activeCfg || !Array.isArray(activeCfg.blocks)) return { rows: [], issues: [{ severity: 'fatal', phase: 'expand', message: 'Active config has no blocks.' }] };

  ensureScenarioContainer(activeCfg);
  const scn = findScenario(activeCfg, scenarioId || activeCfg.activeScenarioId);
  const overrides = scn && isPlainObject(scn.overrides) ? scn.overrides : {};

  const blocksToExpand = applyOverridesToBlocks(activeCfg.blocks, overrides);
  const legacyRows = pickLegacyRowsForSemidia(activeCfg);
  const expanded = expandBlocksToOpticalSystemRows(blocksToExpand);
  try {
    if (legacyRows && Array.isArray(expanded?.rows)) {
      preserveLegacySemidiaIntoExpandedRows(expanded.rows, legacyRows);
    }
  } catch (_) {}
  return expanded;
}

function refreshUI() {
  try {
    if (window.ConfigurationManager && typeof window.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
      window.ConfigurationManager.loadActiveConfigurationToTables();
    }
  } catch (_) {}

  try {
    if (typeof window.refreshBlockInspector === 'function') window.refreshBlockInspector();
  } catch (_) {}

  try {
    if (window.meritFunctionEditor && typeof window.meritFunctionEditor.calculateMerit === 'function') {
      window.meritFunctionEditor.calculateMerit();
    }
  } catch (_) {}
}

export function listScenarios() {
  const systemConfig = loadSystemConfigurationsRaw();
  const activeCfg = getActiveConfigRef(systemConfig);
  if (!activeCfg) return [];
  ensureScenarioContainer(activeCfg);
  return activeCfg.scenarios.map(s => ({ id: s.id, name: s.name, weight: s.weight }));
}

export function addScenario(name = 'Scenario', weight = 1) {
  const systemConfig = loadSystemConfigurationsRaw();
  if (!systemConfig) return { ok: false, reason: 'systemConfigurations not found.' };
  const activeCfg = getActiveConfigRef(systemConfig);
  if (!activeCfg) return { ok: false, reason: 'Active configuration not found.' };
  ensureScenarioContainer(activeCfg);

  const id = `scn_${Date.now()}`;
  activeCfg.scenarios.push({ id, name: String(name), weight: Number(weight) || 1, overrides: {} });
  activeCfg.activeScenarioId = id;

  saveSystemConfigurationsRaw(systemConfig);
  refreshUI();
  return { ok: true, id };
}

export function setActiveScenario(scenarioId) {
  const systemConfig = loadSystemConfigurationsRaw();
  if (!systemConfig) return { ok: false, reason: 'systemConfigurations not found.' };
  const activeCfg = getActiveConfigRef(systemConfig);
  if (!activeCfg) return { ok: false, reason: 'Active configuration not found.' };
  ensureScenarioContainer(activeCfg);

  const scn = findScenario(activeCfg, scenarioId);
  if (!scn) return { ok: false, reason: `Scenario not found: ${scenarioId}` };

  activeCfg.activeScenarioId = String(scn.id);

  // Sync opticalSystem to the now-active scenario.
  const expanded = expandActiveConfigWithScenario(activeCfg, scn.id);
  if (expanded && Array.isArray(expanded.rows)) {
    activeCfg.opticalSystem = expanded.rows;
  }

  saveSystemConfigurationsRaw(systemConfig);
  refreshUI();
  return { ok: true };
}

export function setOverride(scenarioId, variableId, value) {
  const systemConfig = loadSystemConfigurationsRaw();
  if (!systemConfig) return { ok: false, reason: 'systemConfigurations not found.' };
  const activeCfg = getActiveConfigRef(systemConfig);
  if (!activeCfg) return { ok: false, reason: 'Active configuration not found.' };
  ensureScenarioContainer(activeCfg);

  const scn = findScenario(activeCfg, scenarioId || activeCfg.activeScenarioId);
  if (!scn) return { ok: false, reason: `Scenario not found: ${scenarioId}` };

  if (!isPlainObject(scn.overrides)) scn.overrides = {};
  scn.overrides[String(variableId)] = value;

  // Keep active scenario in sync if we changed it.
  if (String(activeCfg.activeScenarioId) === String(scn.id)) {
    const expanded = expandActiveConfigWithScenario(activeCfg, scn.id);
    if (expanded && Array.isArray(expanded.rows)) {
      activeCfg.opticalSystem = expanded.rows;
    }
  }

  saveSystemConfigurationsRaw(systemConfig);
  refreshUI();
  return { ok: true };
}

export function clearOverride(scenarioId, variableId) {
  const systemConfig = loadSystemConfigurationsRaw();
  if (!systemConfig) return { ok: false, reason: 'systemConfigurations not found.' };
  const activeCfg = getActiveConfigRef(systemConfig);
  if (!activeCfg) return { ok: false, reason: 'Active configuration not found.' };
  ensureScenarioContainer(activeCfg);

  const scn = findScenario(activeCfg, scenarioId || activeCfg.activeScenarioId);
  if (!scn) return { ok: false, reason: `Scenario not found: ${scenarioId}` };

  if (isPlainObject(scn.overrides)) {
    delete scn.overrides[String(variableId)];
  }

  if (String(activeCfg.activeScenarioId) === String(scn.id)) {
    const expanded = expandActiveConfigWithScenario(activeCfg, scn.id);
    if (expanded && Array.isArray(expanded.rows)) {
      activeCfg.opticalSystem = expanded.rows;
    }
  }

  saveSystemConfigurationsRaw(systemConfig);
  refreshUI();
  return { ok: true };
}

export function rebuildOpticalSystemFromActiveScenario() {
  const systemConfig = loadSystemConfigurationsRaw();
  if (!systemConfig) return { ok: false, reason: 'systemConfigurations not found.' };
  const activeCfg = getActiveConfigRef(systemConfig);
  if (!activeCfg) return { ok: false, reason: 'Active configuration not found.' };

  ensureScenarioContainer(activeCfg);
  const expanded = expandActiveConfigWithScenario(activeCfg, activeCfg.activeScenarioId);
  if (expanded && Array.isArray(expanded.rows)) {
    activeCfg.opticalSystem = expanded.rows;
  }

  saveSystemConfigurationsRaw(systemConfig);
  refreshUI();
  return { ok: true, issues: expanded.issues || [] };
}

// Global entrypoint
if (typeof window !== 'undefined') {
  window.Scenarios = {
    list: listScenarios,
    add: addScenario,
    setActive: setActiveScenario,
    setOverride,
    clearOverride,
    rebuild: rebuildOpticalSystemFromActiveScenario
  };
}
