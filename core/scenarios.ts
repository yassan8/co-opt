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

import { expandBlocksToOpticalSystemRows } from '../data/block-schema.ts';
import type { Block, Configuration } from '../types/index.js';

interface Scenario {
  id: string;
  name: string;
  weight: number;
  overrides: Record<string, any>;
}

interface SystemConfigurations {
  configurations: Configuration[];
  activeConfigId: string;
}

interface ExpandResult {
  rows: any[];
  issues: Array<{ severity: string; phase: string; message: string }>;
}

interface ScenarioResult {
  ok: boolean;
  reason?: string;
  id?: string;
  issues?: any[];
}

function isPlainObject(v: any): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function cloneJson<T>(v: T): T | null {
  try {
    // structuredClone is not guaranteed everywhere; JSON clone is enough for our schema.
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

function loadSystemConfigurationsRaw(): SystemConfigurations | null {
  try {
    const json = localStorage.getItem('systemConfigurations');
    if (!json) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function saveSystemConfigurationsRaw(systemConfig: SystemConfigurations): boolean {
  try {
    localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
    return true;
  } catch {
    return false;
  }
}

function getActiveConfigRef(systemConfig: SystemConfigurations | null): Configuration | null {
  if (!systemConfig || !Array.isArray(systemConfig.configurations)) return null;
  const activeId = systemConfig.activeConfigId;
  return systemConfig.configurations.find(c => c && String(c.id) === String(activeId)) || systemConfig.configurations[0] || null;
}

function ensureScenarioContainer(activeCfg: Configuration): void {
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

function findScenario(activeCfg: Configuration, scenarioId: string): Scenario | null {
  if (!activeCfg || !Array.isArray(activeCfg.scenarios)) return null;
  const id = String(scenarioId);
  return activeCfg.scenarios.find(s => s && String(s.id) === id) || null;
}

interface ParsedOverrideKey {
  blockId: string;
  key: string;
}

function parseOverrideKey(variableId: string): ParsedOverrideKey | null {
  const s = String(variableId ?? '');
  const dot = s.indexOf('.');
  if (dot <= 0) return null;
  const blockId = s.slice(0, dot);
  const key = s.slice(dot + 1);
  if (!blockId || !key) return null;
  return { blockId, key };
}

function applyOverridesToBlocks(blocks: Block[], overrides: Record<string, any>): Block[] {
  const cloned = cloneJson(blocks);
  if (!Array.isArray(cloned)) return Array.isArray(blocks) ? blocks : [];
  if (!isPlainObject(overrides)) return cloned;

  const byId = new Map<string, Block>();
  for (const b of cloned) {
    const id = isPlainObject(b) ? String(b.blockId ?? '') : '';
    if (id) byId.set(id, b);
  }

  for (const [varId, rawVal] of Object.entries(overrides)) {
    const parsed = parseOverrideKey(varId);
    if (!parsed) continue;
    const blk = byId.get(String(parsed.blockId));
    if (!blk || !isPlainObject((blk as any).parameters)) continue;

    // Prefer numeric when possible.
    const n = Number(rawVal);
    (blk as any).parameters[parsed.key] = Number.isFinite(n) ? n : rawVal;
  }

  return cloned;
}

function preserveLegacySemidiaIntoExpandedRows(expandedRows: any[], legacyRows: any[]): void {
  if (!Array.isArray(expandedRows) || !Array.isArray(legacyRows)) return;
  const n = Math.min(expandedRows.length, legacyRows.length);
  const hasValue = (v: any): boolean => {
    if (v === null || v === undefined) return false;
    const s = String(v).trim();
    return s !== '';
  };
  const getLegacySemidia = (row: any): any => {
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

function pickLegacyRowsForSemidia(activeCfg: Configuration): any[] | null {
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

function expandActiveConfigWithScenario(activeCfg: Configuration, scenarioId?: string): ExpandResult {
  if (!activeCfg || !Array.isArray(activeCfg.blocks)) return { rows: [], issues: [{ severity: 'fatal', phase: 'expand', message: 'Active config has no blocks.' }] };

  ensureScenarioContainer(activeCfg);
  const scn = findScenario(activeCfg, scenarioId || activeCfg.activeScenarioId || 'base');
  const overrides = scn && isPlainObject(scn.overrides) ? scn.overrides : {};

  const blocksToExpand = applyOverridesToBlocks(activeCfg.blocks, overrides);
  const legacyRows = pickLegacyRowsForSemidia(activeCfg);
  const expanded = expandBlocksToOpticalSystemRows(blocksToExpand);
  try {
    if (legacyRows && Array.isArray(expanded?.rows)) {
      preserveLegacySemidiaIntoExpandedRows(expanded.rows, legacyRows);
    }
  } catch (_) {}
  return expanded as ExpandResult;
}

function refreshUI(): void {
  try {
    if ((window as any).ConfigurationManager && typeof (window as any).ConfigurationManager.loadActiveConfigurationToTables === 'function') {
      (window as any).ConfigurationManager.loadActiveConfigurationToTables();
    }
  } catch (_) {}

  try {
    if (typeof (window as any).refreshBlockInspector === 'function') (window as any).refreshBlockInspector();
  } catch (_) {}

  try {
    if ((window as any).meritFunctionEditor && typeof (window as any).meritFunctionEditor.calculateMerit === 'function') {
      (window as any).meritFunctionEditor.calculateMerit();
    }
  } catch (_) {}
}

export function listScenarios(): Array<{ id: string; name: string; weight: number }> {
  const systemConfig = loadSystemConfigurationsRaw();
  const activeCfg = getActiveConfigRef(systemConfig);
  if (!activeCfg) return [];
  ensureScenarioContainer(activeCfg);
  return (activeCfg.scenarios || []).map(s => ({ id: s.id, name: s.name, weight: s.weight }));
}

export function addScenario(name: string = 'Scenario', weight: number = 1): ScenarioResult {
  const systemConfig = loadSystemConfigurationsRaw();
  if (!systemConfig) return { ok: false, reason: 'systemConfigurations not found.' };
  const activeCfg = getActiveConfigRef(systemConfig);
  if (!activeCfg) return { ok: false, reason: 'Active configuration not found.' };
  ensureScenarioContainer(activeCfg);

  const id = `scn_${Date.now()}`;
  if (!activeCfg.scenarios) activeCfg.scenarios = [];
  activeCfg.scenarios.push({ id, name: String(name), weight: Number(weight) || 1, overrides: {} });
  activeCfg.activeScenarioId = id;

  saveSystemConfigurationsRaw(systemConfig);
  refreshUI();
  return { ok: true, id };
}

export function setActiveScenario(scenarioId: string): ScenarioResult {
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

export function setOverride(scenarioId: string, variableId: string, value: any): ScenarioResult {
  const systemConfig = loadSystemConfigurationsRaw();
  if (!systemConfig) return { ok: false, reason: 'systemConfigurations not found.' };
  const activeCfg = getActiveConfigRef(systemConfig);
  if (!activeCfg) return { ok: false, reason: 'Active configuration not found.' };
  ensureScenarioContainer(activeCfg);

  const scn = findScenario(activeCfg, scenarioId || activeCfg.activeScenarioId || 'base');
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

export function clearOverride(scenarioId: string, variableId: string): ScenarioResult {
  const systemConfig = loadSystemConfigurationsRaw();
  if (!systemConfig) return { ok: false, reason: 'systemConfigurations not found.' };
  const activeCfg = getActiveConfigRef(systemConfig);
  if (!activeCfg) return { ok: false, reason: 'Active configuration not found.' };
  ensureScenarioContainer(activeCfg);

  const scn = findScenario(activeCfg, scenarioId || activeCfg.activeScenarioId || 'base');
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

export function rebuildOpticalSystemFromActiveScenario(): ScenarioResult {
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
  (window as any).Scenarios = {
    list: listScenarios,
    add: addScenario,
    setActive: setActiveScenario,
    setOverride,
    clearOverride,
    rebuild: rebuildOpticalSystemFromActiveScenario
  };
}
