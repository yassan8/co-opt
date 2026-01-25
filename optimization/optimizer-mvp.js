/**
 * MVP optimizer (coordinate descent) for Blocks-based design variables.
 *
 * - Variables are defined in Blocks: variables[*].optimize.mode === 'V'
 * - Values are applied to blocks.parameters[*] (canonical)
 * - Objective is derived from System Requirements (hard/soft, all-scenarios)
 *
 * No UI is added; the entrypoint is exposed as window.OptimizationMVP.
 */

import { expandBlocksToOpticalSystemRows } from '../data/block-schema.js';
import { listDesignVariablesFromBlocks, setDesignVariableValue } from './design-variables.js';
import { getGlassDataWithSellmeier } from '../data/glass.js';

let __optimizerStopRequested = false;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nowMs() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

function nextFrame() {
  const prof = (() => {
    try {
      const g = (typeof globalThis !== 'undefined') ? globalThis : null;
      const p = g ? g.__cooptOptimizerProfileContext : null;
      return (p && typeof p === 'object') ? p : null;
    } catch (_) {
      return null;
    }
  })();

  const schedulerWindow = (() => {
    try {
      const g = (typeof globalThis !== 'undefined') ? globalThis : null;
      const w = g ? g.__cooptOptimizerSchedulerWindow : null;
      if (!w || typeof w !== 'object') return null;
      if (w.closed) return null;
      return w;
    } catch (_) {
      return null;
    }
  })();

  const canUseSchedulerRaf = (() => {
    try {
      if (!schedulerWindow) return false;
      if (typeof schedulerWindow.requestAnimationFrame !== 'function') return false;
      const d = schedulerWindow.document;
      if (d && d.hidden) return false;
      return true;
    } catch (_) {
      return false;
    }
  })();

  const canUseSchedulerTimers = (() => {
    try {
      if (!schedulerWindow) return false;
      if (typeof schedulerWindow.setTimeout !== 'function') return false;
      const d = schedulerWindow.document;
      if (d && d.hidden) return false;
      return true;
    } catch (_) {
      return false;
    }
  })();

  const canUseRaf = (() => {
    try {
      if (typeof requestAnimationFrame !== 'function') return false;
      // rAF can fully pause in background tabs/windows; fall back to timers there.
      if (typeof document !== 'undefined' && document && document.hidden) return false;
      return true;
    } catch (_) {
      return false;
    }
  })();

  if (!prof) {
    return new Promise((resolve) => {
      if (canUseSchedulerRaf) {
        schedulerWindow.requestAnimationFrame(() => resolve());
        return;
      }
      if (canUseSchedulerTimers) {
        schedulerWindow.setTimeout(() => resolve(), 0);
        return;
      }
      if (canUseRaf) {
        requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(() => resolve(), 0);
    });
  }

  const t = nowMs();
  return new Promise((resolve) => {
    const done = () => {
      try {
        const dt = nowMs() - t;
        if (prof.counts) {
          prof.counts.nextFrameCalls = (Number(prof.counts.nextFrameCalls) || 0) + 1;
          prof.counts.nextFrameMs = (Number(prof.counts.nextFrameMs) || 0) + dt;
        }
        if (prof.sectionsMs) {
          prof.sectionsMs.nextFrame = (Number(prof.sectionsMs.nextFrame) || 0) + dt;
        }
      } catch (_) {}
      resolve();
    };

    if (canUseSchedulerRaf) {
      schedulerWindow.requestAnimationFrame(() => done());
      return;
    }
    if (canUseSchedulerTimers) {
      schedulerWindow.setTimeout(() => done(), 0);
      return;
    }
    if (canUseRaf) {
      requestAnimationFrame(() => done());
      return;
    }
    setTimeout(() => done(), 0);
  });
}

function getMeritEvaluator() {
  const editor = (typeof window !== 'undefined') ? window.meritFunctionEditor : null;
  if (editor && typeof editor.calculateMeritValueOnly === 'function') {
    return () => editor.calculateMeritValueOnly();
  }
  if (editor && typeof editor.calculateMerit === 'function') {
    return () => {
      editor.calculateMerit();
      try {
        if (typeof window !== 'undefined' && window.systemRequirementsEditor && typeof window.systemRequirementsEditor.evaluateAndUpdateNow === 'function') {
          window.systemRequirementsEditor.evaluateAndUpdateNow();
        }
      } catch (_) {}
      const el = document.getElementById('total-merit-value');
      const n = el ? Number(el.textContent) : NaN;
      return Number.isFinite(n) ? n : Infinity;
    };
  }
  return null;
}

function getMeritBreakdownEvaluator() {
  const editor = (typeof window !== 'undefined') ? window.meritFunctionEditor : null;
  if (editor && typeof editor.calculateMeritBreakdownOnly === 'function') {
    return () => editor.calculateMeritBreakdownOnly();
  }
  return null;
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function norm2Squared(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    s += x * x;
  }
  return s;
}

function solveSymmetricPositiveDefinite(A, b) {
  // Cholesky decomposition: A = L L^T.
  const n = b.length;
  /** @type {number[][]} */
  const L = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(sum > 0) || !Number.isFinite(sum)) return null;
        L[i][j] = Math.sqrt(sum);
      } else {
        const denom = L[j][j];
        if (!Number.isFinite(denom) || denom === 0) return null;
        L[i][j] = sum / denom;
      }
    }
  }

  // Solve L y = b
  const y = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i][k] * y[k];
    const denom = L[i][i];
    if (!Number.isFinite(denom) || denom === 0) return null;
    y[i] = sum / denom;
  }

  // Solve L^T x = y
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
    const denom = L[i][i];
    if (!Number.isFinite(denom) || denom === 0) return null;
    x[i] = sum / denom;
  }

  return x;
}

function solveLinearSystemFallback(A, b) {
  // Gaussian elimination with partial pivoting.
  const n = b.length;
  const M = A.map((row) => row.slice());
  const x = b.slice();

  for (let k = 0; k < n; k++) {
    // pivot
    let pivotRow = k;
    let pivotVal = Math.abs(M[k][k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(M[i][k]);
      if (v > pivotVal) {
        pivotVal = v;
        pivotRow = i;
      }
    }
    if (!Number.isFinite(pivotVal) || pivotVal === 0) return null;
    if (pivotRow !== k) {
      const tmp = M[k];
      M[k] = M[pivotRow];
      M[pivotRow] = tmp;
      const t = x[k];
      x[k] = x[pivotRow];
      x[pivotRow] = t;
    }

    // eliminate
    const pivot = M[k][k];
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / pivot;
      if (!Number.isFinite(f)) return null;
      M[i][k] = 0;
      for (let j = k + 1; j < n; j++) {
        M[i][j] -= f * M[k][j];
      }
      x[i] -= f * x[k];
    }
  }

  // back substitute
  const out = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = x[i];
    for (let j = i + 1; j < n; j++) sum -= M[i][j] * out[j];
    const denom = M[i][i];
    if (!Number.isFinite(denom) || denom === 0) return null;
    out[i] = sum / denom;
  }
  return out;
}

function buildResidualVectorFromBreakdown(breakdown) {
  const terms = Array.isArray(breakdown?.terms) ? breakdown.terms : [];
  const residuals = [];
  for (const t of terms) {
    const r = Number(t?.weightedResidual);
    if (!Number.isFinite(r)) continue;
    residuals.push(r);
  }
  return residuals;
}

function evalResidualsAllScenarios(activeCfg, evalBreakdown, configId) {
  const scenarios = Array.isArray(activeCfg?.scenarios) ? activeCfg.scenarios : null;
  if (!scenarios || scenarios.length === 0) {
    const br = evalBreakdown();
    const r = buildResidualVectorFromBreakdown(br);
    return { cost: norm2Squared(r), residuals: r, breakdown: br };
  }

  const key = String(configId);
  const prev = (typeof window !== 'undefined') ? window.__cooptScenarioOverride : null;
  const overrideMap = (prev && typeof prev === 'object') ? { ...prev } : {};

  const stacked = [];
  let cost = 0;
  try {
    for (const scn of scenarios) {
      if (!scn || scn.id === undefined || scn.id === null) continue;
      const w = Number(scn.weight);
      const weight = Number.isFinite(w) ? w : 1;
      const sqrtW = (weight >= 0) ? Math.sqrt(weight) : NaN;

      overrideMap[key] = String(scn.id);
      if (typeof window !== 'undefined') window.__cooptScenarioOverride = overrideMap;

      const br = evalBreakdown();
      const r0 = buildResidualVectorFromBreakdown(br);
      for (const ri of r0) {
        const v = Number.isFinite(sqrtW) ? (sqrtW * ri) : ri;
        stacked.push(v);
        cost += v * v;
      }
    }
    return { cost, residuals: stacked, breakdown: null };
  } finally {
    if (typeof window !== 'undefined') {
      if (prev && typeof prev === 'object') {
        window.__cooptScenarioOverride = prev;
      } else {
        try { delete window.__cooptScenarioOverride; } catch (_) {}
      }
    }
  }
}

function evalMeritAllScenarios(activeCfg, evalMerit, configId) {
  const scenarios = Array.isArray(activeCfg?.scenarios) ? activeCfg.scenarios : null;
  if (!scenarios || scenarios.length === 0) return evalMerit();

  // Non-persistent override hook consumed by merit-function-editor.
  const key = String(configId);
  const prev = (typeof window !== 'undefined') ? window.__cooptScenarioOverride : null;
  const overrideMap = (prev && typeof prev === 'object') ? { ...prev } : {};

  let total = 0;
  try {
    for (const scn of scenarios) {
      if (!scn || scn.id === undefined || scn.id === null) continue;
      const w = Number(scn.weight);
      const weight = Number.isFinite(w) ? w : 1;
      overrideMap[key] = String(scn.id);
      if (typeof window !== 'undefined') window.__cooptScenarioOverride = overrideMap;
      const m = evalMerit();
      total += weight * m;
    }
    return total;
  } finally {
    if (typeof window !== 'undefined') {
      // Restore previous override (or delete)
      if (prev && typeof prev === 'object') {
        window.__cooptScenarioOverride = prev;
      } else {
        try { delete window.__cooptScenarioOverride; } catch (_) {}
      }
    }
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
  return systemConfig.configurations.find(c => c && c.id === activeId) || systemConfig.configurations[0] || null;
}

function updateExpandedOpticalSystemInConfig(config) {
  if (!config || !Array.isArray(config.blocks)) return;

  const blocksHaveObjectSurface = (() => {
    try { return config.blocks.some(b => String(b?.blockType ?? '').trim() === 'ObjectSurface'); } catch (_) { return false; }
  })();

  const pickPreservedSemidiaRows = () => {
    // Prefer the current config.opticalSystem (may include user edits not represented in Blocks)
    try {
      if (Array.isArray(config?.opticalSystem) && config.opticalSystem.length > 0) return config.opticalSystem;
    } catch (_) {}

    // Fallback: preserve from the currently displayed table data (localStorage)
    try {
      const json = localStorage.getItem('OpticalSystemTableData');
      if (!json) return null;
      const rows = JSON.parse(json);
      return Array.isArray(rows) ? rows : null;
    } catch (_) {
      return null;
    }
  };

  const pickPreservedObjectThickness = () => {
    // ObjectSurface is canonical for object distance in Blocks-only mode.
    if (blocksHaveObjectSurface) return null;

    // Prefer the current config.opticalSystem (may include user edits not represented in Blocks)
    try {
      const v = config?.opticalSystem?.[0]?.thickness;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      const s = String(v ?? '').trim();
      if (s && /^inf(inity)?$/i.test(s)) return 'INF';
      if (s && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) {
        const n = Number(s);
        if (Number.isFinite(n)) return n;
      }
    } catch (_) {}

    // Fallback: preserve from the currently displayed table data (localStorage)
    try {
      const json = localStorage.getItem('OpticalSystemTableData');
      if (!json) return null;
      const rows = JSON.parse(json);
      const v = rows?.[0]?.thickness;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      const s = String(v ?? '').trim();
      if (s && /^inf(inity)?$/i.test(s)) return 'INF';
      if (s && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) {
        const n = Number(s);
        if (Number.isFinite(n)) return n;
      }
    } catch (_) {}

    return null;
  };

  const preservedObjectThickness = pickPreservedObjectThickness();
  const preservedSemidiaRows = pickPreservedSemidiaRows();
  const expanded = expandBlocksToOpticalSystemRows(config.blocks);
  if (expanded && Array.isArray(expanded.rows)) {
    if (preservedObjectThickness !== null && expanded.rows[0] && typeof expanded.rows[0] === 'object') {
      expanded.rows[0].thickness = preservedObjectThickness;
    }

    // Preserve per-surface semidia for non-Stop rows.
    // Blocks only model Stop.semiDiameter; other semidia values are surface-table details.
    try {
      if (Array.isArray(preservedSemidiaRows) && preservedSemidiaRows.length > 0) {
        const n = Math.min(preservedSemidiaRows.length, expanded.rows.length);
        for (let i = 0; i < n; i++) {
          const er = expanded.rows[i];
          const lr = preservedSemidiaRows[i];
          if (!er || typeof er !== 'object' || !lr || typeof lr !== 'object') continue;
          const t = String(er['object type'] ?? er.object ?? '').trim().toLowerCase();
          if (t === 'stop') continue; // Stop semidia should come from Blocks.
          const lsRaw = lr.semidia ?? lr['Semi Diameter'] ?? lr['semi diameter'] ?? lr.semiDiameter ?? lr.semiDia;
          const ls = String(lsRaw ?? '').trim();
          if (ls !== '') er.semidia = lsRaw;
        }
      }
    } catch (_) {}

    config.opticalSystem = expanded.rows;
  }
}

function getNumericVariables(activeCfg) {
  const all = listDesignVariablesFromBlocks(activeCfg);
  const coerceBlankToZero = (v) => {
    if (!v || typeof v !== 'object') return v;
    if (typeof v.value === 'number' && Number.isFinite(v.value)) return v;

    const key = String(v.key ?? '').trim();
    const raw = v.value;
    const s = String(raw ?? '').trim();

    // Treat empty asphere terms as 0 so they can be optimized from a "blank" UI state.
    // Supports Lens (front/back), and cemented elements (surfN* for Doublet/Triplet).
    if (s === '') {
      if (
        /^(front|back)coef\d+$/i.test(key) ||
        /^coef\d+$/i.test(key) ||
        /^surf\d+coef\d+$/i.test(key)
      ) {
        return { ...v, value: 0 };
      }
      if (
        /^(front|back)conic$/i.test(key) ||
        /^conic$/i.test(key) ||
        /^surf\d+conic$/i.test(key)
      ) {
        return { ...v, value: 0 };
      }
    }

    // Numeric string → number
    if (s !== '') {
      const n = Number(s);
      if (Number.isFinite(n)) return { ...v, value: n };
    }

    return v;
  };

  return all
    .map(coerceBlankToZero)
    .filter(v => v && typeof v.value === 'number' && Number.isFinite(v.value));
}

function parseJointVariableId(variableId) {
  const s = String(variableId ?? '').trim();
  if (!s) return { configId: null, baseId: '' };
  const idx = s.indexOf(':');
  if (idx > 0) {
    const configId = s.slice(0, idx).trim();
    const baseId = s.slice(idx + 1).trim();
    return { configId: configId || null, baseId };
  }
  return { configId: null, baseId: s };
}

function snapshotBlocksByConfigId(blocksByConfigId) {
  const out = {};
  for (const [k, v] of Object.entries(blocksByConfigId || {})) {
    try {
      out[String(k)] = JSON.parse(JSON.stringify(v));
    } catch {
      out[String(k)] = null;
    }
  }
  return out;
}

function restoreBlocksByConfigId(blocksByConfigId, snapshot) {
  if (!blocksByConfigId || typeof blocksByConfigId !== 'object' || !snapshot || typeof snapshot !== 'object') return false;
  try {
    for (const [k, v] of Object.entries(snapshot)) {
      if (!Object.prototype.hasOwnProperty.call(blocksByConfigId, k)) continue;
      blocksByConfigId[k] = Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : blocksByConfigId[k];
    }
    return true;
  } catch {
    return false;
  }
}

function persistBlocksByConfigIdToSystemConfig({ systemConfig, configsById, targetConfigIds, blocksByConfigId }) {
  try {
    const ids = Array.isArray(targetConfigIds) ? targetConfigIds.map(id => String(id)) : [];
    for (const cid of ids) {
      const cfg = configsById ? configsById[String(cid)] : null;
      const blocks = blocksByConfigId ? blocksByConfigId[String(cid)] : null;
      if (!cfg || !Array.isArray(blocks)) continue;
      cfg.blocks = JSON.parse(JSON.stringify(blocks));
      updateExpandedOpticalSystemInConfig(cfg);
    }
    return saveSystemConfigurationsRaw(systemConfig);
  } catch {
    return false;
  }
}

function restoreBestSnapshotAndPersist({
  finalEval,
  jointState,
  systemConfig,
  configsById,
  targetConfigIds
}) {
  try {
    if (!finalEval || !finalEval.blocksSnapshot) return false;
    const okRestore = restoreBlocksByConfigId(jointState?.blocksByConfigId, finalEval.blocksSnapshot);
    if (!okRestore) return false;

    // Keep the active-config evaluator consistent with the restored blocks.
    try {
      const activeId = String(jointState?.activeConfigId ?? '').trim();
      if (activeId) {
        const ab = jointState?.blocksByConfigId ? jointState.blocksByConfigId[activeId] : null;
        if (Array.isArray(ab)) updateActiveOpticalSystemOverrideFromBlocks(ab);
      }
    } catch (_) {}

    return persistBlocksByConfigIdToSystemConfig({
      systemConfig,
      configsById,
      targetConfigIds,
      blocksByConfigId: jointState?.blocksByConfigId
    });
  } catch {
    return false;
  }
}

function getScopeFromVariableEntry(entry) {
  try {
    const s = String(entry?.optimize?.scope ?? '').trim();
    if (s === 'global' || s === 'shared') return 'global';
    if (s === 'perConfig' || s === 'local' || s === 'per-config') return 'perConfig';
  } catch (_) {}
  return 'perConfig';
}

function getVariableEntryById(config, variableId) {
  if (!config || !Array.isArray(config.blocks)) return null;
  const id = String(variableId ?? '').trim();
  const dot = id.indexOf('.');
  if (dot <= 0) return null;
  const blockId = id.slice(0, dot);
  const key = id.slice(dot + 1);
  if (!blockId || !key) return null;

  const block = config.blocks.find(b => isPlainObject(b) && String(b.blockId) === blockId);
  if (!block) return null;
  const vars = isPlainObject(block.variables) ? block.variables : null;
  if (!vars) return null;
  return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : null;
}

function getVariableEntryFromBlocks(blocks, baseId) {
  if (!Array.isArray(blocks)) return null;
  const id = String(baseId ?? '').trim();
  const dot = id.indexOf('.');
  if (dot <= 0) return null;
  const blockId = id.slice(0, dot);
  const key = id.slice(dot + 1);
  if (!blockId || !key) return null;

  const block = blocks.find(b => isPlainObject(b) && String(b.blockId) === blockId);
  if (!block) return null;
  const vars = isPlainObject(block.variables) ? block.variables : null;
  if (!vars) return null;
  return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : null;
}

function getCurrentDesignValueFromBlocks(blocks, baseId) {
  if (!Array.isArray(blocks)) return '';
  const id = String(baseId ?? '').trim();
  const dot = id.indexOf('.');
  if (dot <= 0) return '';
  const blockId = id.slice(0, dot);
  const key = id.slice(dot + 1);
  if (!blockId || !key) return '';

  const block = blocks.find(b => isPlainObject(b) && String(b.blockId) === blockId);
  if (!block) return '';
  const params = isPlainObject(block.parameters) ? block.parameters : null;
  if (params && Object.prototype.hasOwnProperty.call(params, key)) {
    const v = params[key];
    if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) {
      return v;
    }
  }
  const vars = isPlainObject(block.variables) ? block.variables : null;
  if (vars && isPlainObject(vars[key]) && Object.prototype.hasOwnProperty.call(vars[key], 'value')) {
    return vars[key].value;
  }
  return '';
}

function getCurrentDesignValueByVariableId(config, variableId) {
  if (!config || !Array.isArray(config.blocks)) return '';
  const id = String(variableId ?? '').trim();
  const dot = id.indexOf('.');
  if (dot <= 0) return '';
  const blockId = id.slice(0, dot);
  const key = id.slice(dot + 1);
  if (!blockId || !key) return '';
  const block = config.blocks.find(b => isPlainObject(b) && String(b.blockId) === blockId);
  if (!block) return '';
  const params = isPlainObject(block.parameters) ? block.parameters : null;
  if (params && Object.prototype.hasOwnProperty.call(params, key)) {
    const v = params[key];
    if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) {
      return v;
    }
  }
  const vars = isPlainObject(block.variables) ? block.variables : null;
  if (vars && isPlainObject(vars[key]) && Object.prototype.hasOwnProperty.call(vars[key], 'value')) {
    return vars[key].value;
  }
  return '';
}

function getMaterialIssueForBlock(activeCfg, blockId) {
  try {
    const expanded = expandBlocksToOpticalSystemRows(activeCfg?.blocks);
    const issues = Array.isArray(expanded?.issues) ? expanded.issues : [];
    const bid = String(blockId ?? '').trim();
    if (!bid) return null;
    const hit = issues.find(it => String(it?.blockId ?? '') === bid && typeof it?.message === 'string' && it.message.includes('Lens.material'));
    return hit ? String(hit.message) : null;
  } catch {
    return null;
  }
}

function normalizeStringList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const v of list) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    const key = s.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function isAirMaterialName(name) {
  const s = String(name ?? '').trim();
  if (!s) return false;
  return s.toUpperCase() === 'AIR';
}

function isMaterialKey(key) {
  const s = String(key ?? '').trim();
  if (!s) return false;
  return /^material\d*$/i.test(s);
}

function glassExists(name) {
  const s = String(name ?? '').trim();
  if (!s) return false;
  if (s.toUpperCase() === 'AIR') return true;
  try {
    return !!getGlassDataWithSellmeier(s);
  } catch {
    return false;
  }
}

function defaultMaterialCandidatesFromConfig(activeCfg) {
  // Conservative defaults: prefer materials already present in the current design,
  // plus a small list of common glasses (only if found in DB).
  const fromDesign = [];
  try {
    for (const b of (Array.isArray(activeCfg?.blocks) ? activeCfg.blocks : [])) {
      const params = b?.parameters;
      if (params && typeof params === 'object') {
        for (const k of Object.keys(params)) {
          if (!isMaterialKey(k)) continue;
          const m = params[k];
          if (m !== undefined && m !== null && String(m).trim() !== '') {
            fromDesign.push(String(m));
          }
        }
      }
    }
  } catch (_) {}

  const common = ['N-BK7', 'FUSED SILICA', 'N-SF11', 'N-F2', 'N-LAK10', 'S-BSL7', 'S-FPL53'];
  const merged = normalizeStringList([...fromDesign, ...common]);
  // NOTE: material(V) discrete optimization must not pick AIR for Lens blocks.
  return merged.filter(glassExists).filter(m => !isAirMaterialName(m)).slice(0, 40);
}

function getCategoricalMaterialVariables(activeCfg) {
  const all = listDesignVariablesFromBlocks(activeCfg);
  return all.filter(v => {
    if (!v || !isMaterialKey(v.key)) return false;
    const s = String(v.value ?? '').trim();
    return s !== '';
  });
}

function coerceBlankAsphereToZero(v) {
  if (!v || typeof v !== 'object') return v;
  if (typeof v.value === 'number' && Number.isFinite(v.value)) return v;

  const key = String(v.key ?? '').trim();
  const raw = v.value;
  const s = String(raw ?? '').trim();

  if (s === '') {
    // Lens blocks
    if (/^(front|back)coef\d+$/i.test(key) || /^coef\d+$/i.test(key)) return { ...v, value: 0 };
    if (/^(front|back)conic$/i.test(key) || /^conic$/i.test(key)) return { ...v, value: 0 };

    // Multi-surface blocks (Doublet/Triplet): surf1Coef1, surf2Conic, ...
    if (/^surf\d+coef\d+$/i.test(key)) return { ...v, value: 0 };
    if (/^surf\d+conic$/i.test(key)) return { ...v, value: 0 };
  }

  if (s !== '') {
    const n = Number(s);
    if (Number.isFinite(n)) return { ...v, value: n };
  }

  return v;
}

function enumerateJointVariables({
  targetConfigIds,
  blocksByConfigId,
  activeConfigId
}) {
  const ids = Array.isArray(targetConfigIds) ? targetConfigIds.map(id => String(id)) : [];
  const activeId = String(activeConfigId ?? '').trim();

  /** @type {Array<{id:string, key:string, value:any, blockId:string, blockType:string, scope:'global'|'perConfig'}>} */
  const numeric = [];
  /** @type {Array<{id:string, key:string, value:any, blockId:string, blockType:string, scope:'global'|'perConfig'}>} */
  const categoricalMaterial = [];

  /** @type {Map<string, {base:any, seen:Set<string>}>} */
  const globalMap = new Map();
  /** @type {Array<string>} */
  const errors = [];

  for (const cfgId of ids) {
    const blocks = blocksByConfigId ? blocksByConfigId[cfgId] : null;
    if (!Array.isArray(blocks)) {
      errors.push(`Config ${cfgId} has no blocks.`);
      continue;
    }
    const cfgView = { blocks };
    const all = listDesignVariablesFromBlocks(cfgView);
    for (const v0 of all) {
      const entry = getVariableEntryById(cfgView, v0.id);
      const scope = getScopeFromVariableEntry(entry);
      const v = coerceBlankAsphereToZero(v0);

      if (scope === 'global') {
        const baseId = String(v.id);
        if (!globalMap.has(baseId)) {
          globalMap.set(baseId, { base: { ...v, id: baseId, scope: 'global' }, seen: new Set([cfgId]) });
        } else {
          globalMap.get(baseId).seen.add(cfgId);
        }

        // Prefer the active config's current value as the representative starting point.
        if (cfgId === activeId) {
          const cur = globalMap.get(baseId);
          if (cur && cur.base) cur.base.value = v.value;
        }
        continue;
      }

      const jointId = `${cfgId}:${String(v.id)}`;
      const out = { ...v, id: jointId, scope: 'perConfig' };
      if (isMaterialKey(out.key)) {
        const s = String(out.value ?? '').trim();
        if (s !== '') categoricalMaterial.push(out);
      } else {
        numeric.push(out);
      }
    }
  }

  // Validate global vars exist in all target configs.
  for (const [baseId, info] of globalMap.entries()) {
    const seen = info.seen;
    if (seen.size !== ids.length) {
      const missing = ids.filter(id => !seen.has(id));
      errors.push(`Global variable ${baseId} is missing in config(s): ${missing.join(', ')}`);
    }
  }

  // Append global vars, split numeric vs material.
  for (const [baseId, info] of globalMap.entries()) {
    const out = info.base;
    if (!out) continue;
    if (isMaterialKey(out.key)) {
      const s = String(out.value ?? '').trim();
      if (s !== '') categoricalMaterial.push(out);
    } else {
      numeric.push(out);
    }
  }

  return { numeric, categoricalMaterial, errors };
}

function updateActiveOpticalSystemOverrideFromBlocks(activeBlocks) {
  try {
    const expanded = expandBlocksToOpticalSystemRows(activeBlocks);
    const rows = (expanded && Array.isArray(expanded.rows)) ? expanded.rows : null;
    if (typeof globalThis !== 'undefined') {
      globalThis.__cooptOpticalSystemRowsOverride = rows;
    }
  } catch (_) {
    try {
      if (typeof globalThis !== 'undefined') globalThis.__cooptOpticalSystemRowsOverride = null;
    } catch (_) {}
  }
}

function setJointDesignVariableValue({ blocksByConfigId, targetConfigIds, activeConfigId }, jointVariableId, newValue) {
  const { configId, baseId } = parseJointVariableId(jointVariableId);
  const activeId = String(activeConfigId ?? '').trim();
  const ids = Array.isArray(targetConfigIds) ? targetConfigIds.map(id => String(id)) : [];

  const clampValueIfNeeded = (blocks, rawValue) => {
    try {
      const n = (typeof rawValue === 'number') ? rawValue : Number(rawValue);
      if (!Number.isFinite(n)) return rawValue;

      const entry = getVariableEntryFromBlocks(blocks, baseId);
      const opt = (entry && typeof entry === 'object') ? entry.optimize : null;

      // Respect explicit bounds if present.
      const minV = (opt && Number.isFinite(Number(opt.min))) ? Number(opt.min) : null;
      const maxV = (opt && Number.isFinite(Number(opt.max))) ? Number(opt.max) : null;
      if (minV !== null || maxV !== null) {
        const lo = (minV !== null) ? minV : -Infinity;
        const hi = (maxV !== null) ? maxV : Infinity;
        const clamped = Math.max(lo, Math.min(hi, n));
        return Number.isFinite(clamped) ? clamped : rawValue;
      }

      // Default safety clamp for asphere coefficients (prevents catastrophic ray-trace failures).
      // coef1*r^2, coef2*r^4, ... can blow up quickly if coefficients drift.
      const dot = String(baseId || '').indexOf('.');
      const key = (dot >= 0) ? String(baseId).slice(dot + 1) : '';
      const idx = parseCoefIndexFromKey(key);
      if (idx !== null) {
        // Allow override: optimize.clampAbsMax
        const overrideAbs = (opt && Number.isFinite(Number(opt.clampAbsMax))) ? Math.max(0, Number(opt.clampAbsMax)) : null;
        const baseScale = defaultScaleForKey(key);
        const absMax = overrideAbs !== null ? overrideAbs : Math.max(1e-30, 1e3 * baseScale);
        const clamped = Math.max(-absMax, Math.min(absMax, n));
        return Number.isFinite(clamped) ? clamped : rawValue;
      }

      return rawValue;
    } catch (_) {
      return rawValue;
    }
  };

  const applyTo = configId ? [String(configId)] : ids;
  let okAny = false;
  for (const cid of applyTo) {
    const blocks = blocksByConfigId ? blocksByConfigId[cid] : null;
    if (!Array.isArray(blocks)) continue;
    const cfgView = { blocks };
    const v2 = clampValueIfNeeded(blocks, newValue);
    const ok = setDesignVariableValue(cfgView, baseId, v2);
    if (ok) okAny = true;
    if (cid === activeId) {
      updateActiveOpticalSystemOverrideFromBlocks(blocks);
    }
  }
  return okAny;
}

function getJointCurrentValue({ blocksByConfigId, activeConfigId }, jointVariableId) {
  const { configId, baseId } = parseJointVariableId(jointVariableId);
  const activeId = String(activeConfigId ?? '').trim();
  const cid = configId ? String(configId) : activeId;
  const blocks = blocksByConfigId ? blocksByConfigId[cid] : null;
  return getCurrentDesignValueFromBlocks(blocks, baseId);
}

function getJointVariableEntry({ blocksByConfigId, activeConfigId }, jointVariableId) {
  const { configId, baseId } = parseJointVariableId(jointVariableId);
  const activeId = String(activeConfigId ?? '').trim();
  const cid = configId ? String(configId) : activeId;
  const blocks = blocksByConfigId ? blocksByConfigId[cid] : null;
  return getVariableEntryFromBlocks(blocks, baseId);
}

function getMaterialCandidatesForVar(activeCfg, variableId, currentValue) {
  const entry = getVariableEntryById(activeCfg, variableId);
  let candidates = [];

  if (isPlainObject(entry)) {
    // Support either `candidates` or `options` arrays.
    candidates = normalizeStringList(entry.candidates || entry.options || []);
  }

  if (candidates.length === 0) {
    candidates = defaultMaterialCandidatesFromConfig(activeCfg);
  }

  // Ensure current value is included.
  const cur = String(currentValue ?? '').trim();
  let merged = normalizeStringList([cur, ...candidates])
    .filter(glassExists)
    .filter(m => !isAirMaterialName(m));

  // If the variable only offered AIR (or current is AIR), fall back to defaults (still excluding AIR).
  if (merged.length === 0) {
    merged = defaultMaterialCandidatesFromConfig(activeCfg);
  }

  return merged;
}

function toFiniteNumber(value, fallback = 0) {
  if (value === undefined || value === null) return fallback;

  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return fallback;
    const n = Number(s);
    return Number.isFinite(n) ? n : fallback;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRequirementRow(raw, systemConfig, activeConfigId) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const cfg0 = String(r.configId ?? '').trim();
  // NOTE: blank configId means "apply to all configs" in multi-config optimization.
  // (The Requirements UI may still treat blank as "current"; optimizer expands it.)
  let configIdRaw = cfg0;

  // Backward compatibility: allow specifying config by name (e.g. "Wide").
  // Optimizer must resolve to actual configuration id; otherwise evaluation can silently fall
  // back to the active config and make Score look wrong vs the Requirements table.
  if (configIdRaw) {
    try {
      const configs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
      const byId = configs.find(c => c && String(c.id) === configIdRaw);
      if (!byId) {
        const byName = configs.find(c => c && String(c.name).trim() === configIdRaw);
        if (byName) configIdRaw = String(byName.id);
      }
    } catch (_) {}
  }

  let enabled = true;
  if (r.enabled !== undefined && r.enabled !== null) {
    if (typeof r.enabled === 'string') {
      const s = r.enabled.trim().toLowerCase();
      if (s === '') enabled = true;
      else if (s === 'false' || s === '0' || s === 'no' || s === 'off') enabled = false;
      else if (s === 'true' || s === '1' || s === 'yes' || s === 'on') enabled = true;
      else enabled = true;
    } else {
      enabled = !!r.enabled;
    }
  }
  const op0 = String(r.op || '').trim();
  const op = (op0 === '<=' || op0 === '>=' || op0 === '=') ? op0 : '=';
  const tol = toFiniteNumber(r.tol, 0);
  const target = toFiniteNumber(r.target, 0);
  const weight = toFiniteNumber(r.weight, 1);

  // Migration: SPOT_SIZE was replaced by explicit sampling variants.
  // Default to Annular to preserve a deterministic behavior.
  const operandRaw = String(r.operand || '').trim();
  const operand = (operandRaw === 'SPOT_SIZE') ? 'SPOT_SIZE_ANNULAR' : operandRaw;

  return {
    id: r.id,
    enabled,
    operand,
    configId: configIdRaw,
    param1: r.param1,
    param2: r.param2,
    param3: r.param3,
    param4: r.param4,
    op,
    tol,
    target,
    weight,
    rationale: r.rationale
  };
}

function getSystemRequirementsRaw(systemConfig) {
  try {
    if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.getData === 'function') {
      const d = window.systemRequirementsEditor.getData();
      if (Array.isArray(d)) return d;
    }
  } catch (_) {}
  try {
    const json = localStorage.getItem('systemRequirementsData');
    const d = json ? JSON.parse(json) : null;
    return Array.isArray(d) ? d : [];
  } catch (_) {
    // ignore
  }

  // Fallback: legacy embedding inside systemConfigurations
  if (systemConfig && Array.isArray(systemConfig.systemRequirements)) {
    return systemConfig.systemRequirements;
  }
  return [];
}

function computeViolationAmount(op, current, target, tol) {
  const c = toFiniteNumber(current, NaN);
  const t = toFiniteNumber(target, NaN);
  const z = Math.max(0, toFiniteNumber(tol, 0));
  if (!Number.isFinite(c) || !Number.isFinite(t)) return NaN;

  if (op === '<=') return Math.max(0, c - (t + z));
  if (op === '>=') return Math.max(0, (t - z) - c);
  // '='
  return Math.max(0, Math.abs(c - t) - z);
}

// Keep scoring semantics consistent with the System Requirements UI:
// many operands historically return ~1e9 on ray-trace failure.
// We treat those values as invalid measurements and apply a stable penalty
// so the optimizer doesn't explode to ~1e11 due to sentinel magnitudes.
const __INVALID_OPERAND_ABS_LIMIT = 1e8;
const __INVALID_OPERAND_PENALTY_AMOUNT = 1e4;

function sanitizeOperandCurrentForScore(rawCurrent) {
  const v = Number(rawCurrent);
  if (!Number.isFinite(v)) return { ok: false, current: NaN };
  if (Math.abs(v) >= __INVALID_OPERAND_ABS_LIMIT) return { ok: false, current: NaN };
  return { ok: true, current: v };
}

function computeAmountOrPenalty(op, rawCurrent, target, tol) {
  const s = sanitizeOperandCurrentForScore(rawCurrent);
  if (!s.ok) {
    return { ok: false, current: s.current, amount: __INVALID_OPERAND_PENALTY_AMOUNT, reason: 'invalid-current' };
  }
  const amount = computeViolationAmount(op, s.current, target, tol);
  if (!Number.isFinite(amount)) {
    return { ok: false, current: s.current, amount: __INVALID_OPERAND_PENALTY_AMOUNT, reason: 'non-finite-amount' };
  }
  return { ok: true, current: s.current, amount, reason: amount > 0 ? 'violation' : 'ok' };
}

function compareEval(a, b) {
  // Return true if a is strictly better than b.
  if (!b) return true;
  if (!a) return false;

  const aFeas = !!a.feasible;
  const bFeas = !!b.feasible;
  if (aFeas && !bFeas) return true;
  if (!aFeas && bFeas) return false;

  const aV = toFiniteNumber(a.violationScore, Infinity);
  const bV = toFiniteNumber(b.violationScore, Infinity);
  if (!aFeas && !bFeas) {
    if (aV < bV - 1e-12) return true;
    if (aV > bV + 1e-12) return false;
  }

  const aS = toFiniteNumber(a.score, Infinity);
  const bS = toFiniteNumber(b.score, Infinity);
  return aS < bS - 1e-12;
}

function snapshotBlocks(activeCfg) {
  try {
    return JSON.parse(JSON.stringify(activeCfg.blocks));
  } catch {
    return null;
  }
}

function restoreBlocks(activeCfg, blocksSnapshot) {
  if (!activeCfg || !Array.isArray(blocksSnapshot)) return false;
  try {
    activeCfg.blocks = JSON.parse(JSON.stringify(blocksSnapshot));
    return true;
  } catch {
    return false;
  }
}

function evaluateRequirementsAllScenarios({
  activeCfg,
  activeConfigId,
  requirements,
  multiScenario
}) {
  const editor = (typeof window !== 'undefined') ? window.meritFunctionEditor : null;
  if (!editor || typeof editor.calculateOperandValue !== 'function') {
    return { feasible: true, violationScore: 0, softPenalty: 0, hardViolations: [], softViolations: [] };
  }

  const scenarios = (multiScenario && Array.isArray(activeCfg?.scenarios) && activeCfg.scenarios.length > 0)
    ? activeCfg.scenarios
    : null;

  const rows = Array.isArray(requirements) ? requirements : [];
  if (rows.length === 0) {
    return { feasible: true, violationScore: 0, softPenalty: 0, hardViolations: [], softViolations: [] };
  }

  const key = String(activeConfigId);
  const prev = (typeof window !== 'undefined') ? window.__cooptScenarioOverride : null;
  const overrideMap = (prev && typeof prev === 'object') ? { ...prev } : {};

  let feasible = true;
  let violationScore = 0;
  let softPenalty = 0;
  const hardViolations = [];
  const softViolations = [];

  const evalOnce = (scenarioId, scenarioWeight) => {
    for (const r of rows) {
      if (!r || !r.enabled) continue;
      if (!r.operand) continue;
      // Only enforce requirements for the active configuration being optimized.
      if (String(r.configId).trim() !== String(activeConfigId).trim()) continue;

      const w = Math.max(0, toFiniteNumber(r.weight, 1)) * Math.max(0, toFiniteNumber(scenarioWeight, 1));
      if (!(w > 0)) continue; // Treat weight<=0 as disabled.

      const opObj = {
        operand: r.operand,
        configId: String(r.configId),
        param1: r.param1,
        param2: r.param2,
        param3: r.param3,
        param4: r.param4,
        target: r.target,
        weight: r.weight
      };

      const evaluated = computeAmountOrPenalty(r.op, editor.calculateOperandValue(opObj), r.target, r.tol);
      const current = evaluated.current;
      const amount = evaluated.amount;
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const entry = {
        id: r.id,
        operand: r.operand,
        configId: r.configId,
        scenarioId: scenarioId ? String(scenarioId) : null,
        op: r.op,
        target: r.target,
        tol: r.tol,
        weight: w,
        current,
        amount,
        reason: evaluated.reason
      };

      feasible = false;
      violationScore += w * amount; // linear
      hardViolations.push(entry);
    }
  };

  try {
    if (!scenarios) {
      // Respect whatever activeScenarioId is set to (or none).
      evalOnce(null, 1);
    } else {
      for (const scn of scenarios) {
        if (!scn || scn.id === undefined || scn.id === null) continue;
        const w = toFiniteNumber(scn.weight, 1);
        const scenarioWeight = Number.isFinite(w) ? w : 1;
        overrideMap[key] = String(scn.id);
        if (typeof window !== 'undefined') window.__cooptScenarioOverride = overrideMap;
        evalOnce(scn.id, scenarioWeight);
      }
    }

    return { feasible, violationScore, softPenalty, hardViolations, softViolations };
  } finally {
    if (typeof window !== 'undefined') {
      if (prev && typeof prev === 'object') {
        window.__cooptScenarioOverride = prev;
      } else {
        try { delete window.__cooptScenarioOverride; } catch (_) {}
      }
    }
  }
}

function expandRequirementsForTargetConfigs(requirements, targetConfigIds) {
  const ids = Array.isArray(targetConfigIds) ? targetConfigIds.map(id => String(id)) : [];
  const idSet = new Set(ids);
  const rows = Array.isArray(requirements) ? requirements : [];
  /** @type {any[]} */
  const out = [];

  for (const r of rows) {
    if (!r || !r.enabled) continue;
    if (!r.operand) continue;
    const cfg = String(r.configId ?? '').trim();
    if (!cfg) {
      for (const id of ids) out.push({ ...r, configId: String(id) });
      continue;
    }
    if (!idSet.has(cfg)) continue;
    out.push(r);
  }

  return out;
}

function buildResidualItemsForConfigs(expandedRequirements, configsById, multiScenario) {
  const reqs = Array.isArray(expandedRequirements) ? expandedRequirements : [];
  /** @type {Array<{configId:string, scenarioId:string|null, scenarioWeight:number, req:any}>} */
  const items = [];
  for (const r of reqs) {
    const configId = String(r?.configId ?? '').trim();
    if (!configId) continue;
    const cfg = configsById && Object.prototype.hasOwnProperty.call(configsById, configId) ? configsById[configId] : null;
    const scenarios = (multiScenario && cfg && Array.isArray(cfg.scenarios) && cfg.scenarios.length > 0) ? cfg.scenarios : null;

    if (!scenarios) {
      items.push({ configId, scenarioId: null, scenarioWeight: 1, req: r });
      continue;
    }

    for (const scn of scenarios) {
      if (!scn || scn.id === undefined || scn.id === null) continue;
      const sid = String(scn.id);
      const sw = toFiniteNumber(scn.weight, 1);
      items.push({ configId, scenarioId: sid, scenarioWeight: Number.isFinite(sw) ? sw : 1, req: r });
    }
  }
  return items;
}

function evaluateRequirementsAllConfigsAllScenarios({
  expandedRequirements,
  residualItems,
  multiScenario
}) {
  const editor = (typeof window !== 'undefined') ? window.meritFunctionEditor : null;
  if (!editor || typeof editor.calculateOperandValue !== 'function') {
    return { feasible: true, violationScore: 0, softPenalty: 0, hardViolations: [], softViolations: [] };
  }

  const rows = Array.isArray(expandedRequirements) ? expandedRequirements : [];
  if (rows.length === 0) {
    return { feasible: true, violationScore: 0, softPenalty: 0, hardViolations: [], softViolations: [] };
  }

  const items = Array.isArray(residualItems) ? residualItems : buildResidualItemsForConfigs(rows, {}, !!multiScenario);
  const prev = (typeof window !== 'undefined') ? window.__cooptScenarioOverride : null;
  const overrideMap = (prev && typeof prev === 'object') ? { ...prev } : {};

  let feasible = true;
  let violationScore = 0;
  let softPenalty = 0;
  const hardViolations = [];
  const softViolations = [];

  try {
    for (const it of items) {
      const r = it.req;
      if (!r || !r.enabled) continue;
      if (!r.operand) continue;
      const w = Math.max(0, toFiniteNumber(r.weight, 1)) * Math.max(0, toFiniteNumber(it.scenarioWeight, 1));
      if (!(w > 0)) continue;

      const cfgId = String(it.configId);
      if (it.scenarioId) {
        overrideMap[cfgId] = String(it.scenarioId);
      } else {
        delete overrideMap[cfgId];
      }
      if (typeof window !== 'undefined') window.__cooptScenarioOverride = overrideMap;

      const opObj = {
        operand: r.operand,
        configId: cfgId,
        param1: r.param1,
        param2: r.param2,
        param3: r.param3,
        param4: r.param4,
        target: r.target,
        weight: r.weight
      };

      const evaluated = computeAmountOrPenalty(r.op, editor.calculateOperandValue(opObj), r.target, r.tol);
      const current = evaluated.current;
      const amount = evaluated.amount;
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const entry = {
        id: r.id,
        operand: r.operand,
        configId: cfgId,
        scenarioId: it.scenarioId ? String(it.scenarioId) : null,
        op: r.op,
        target: r.target,
        tol: r.tol,
        weight: w,
        current,
        amount,
        reason: evaluated.reason
      };

      feasible = false;
      violationScore += w * amount;
      hardViolations.push(entry);
    }

    return { feasible, violationScore, softPenalty, hardViolations, softViolations };
  } finally {
    if (typeof window !== 'undefined') {
      if (prev && typeof prev === 'object') {
        window.__cooptScenarioOverride = prev;
      } else {
        try { delete window.__cooptScenarioOverride; } catch (_) {}
      }
    }
  }
}

async function sanitizeAirMaterialsInDesignIntent({
  activeCfg,
  systemConfig,
  jointState,
  categoricalVars,
  evalState,
  onProgress,
  shouldStop,
  multiScenario,
  method
}) {
  const catVars = Array.isArray(categoricalVars) ? categoricalVars : getCategoricalMaterialVariables(activeCfg);
  if (!Array.isArray(catVars) || catVars.length === 0) {
    return { changed: false, changedCount: 0 };
  }

  let changedCount = 0;

  for (const v of catVars) {
    if (shouldStop && shouldStop()) break;

    const baseValue = String(v.value ?? '').trim();
    if (!isAirMaterialName(baseValue)) continue;

    const js = jointState || { blocksByConfigId: null, targetConfigIds: null, activeConfigId: activeCfg?.id };
    const { configId, baseId } = parseJointVariableId(v.id);
    const cidForCandidates = configId ? String(configId) : String(js.activeConfigId ?? '');
    const cfgViewForCandidates = { blocks: (js.blocksByConfigId && js.blocksByConfigId[cidForCandidates]) || activeCfg?.blocks };
    const candidates = getMaterialCandidatesForVar(cfgViewForCandidates, baseId, baseValue)
      .filter(m => !isAirMaterialName(m));
    if (candidates.length === 0) continue;

    let bestLocalValue = candidates[0];
    let bestLocalEval = null;

    for (const cand of candidates) {
      if (shouldStop && shouldStop()) break;

      const okSet = jointState
        ? setJointDesignVariableValue(jointState, v.id, cand)
        : setDesignVariableValue(activeCfg, v.id, cand);
      if (!okSet) continue;

      const e = evalState ? evalState() : null;
      const c = e ? e.score : NaN;

      let materialIssue = null;
      try {
        const cidForIssue = configId ? String(configId) : String(js.activeConfigId ?? '');
        const cfgViewForIssue = jointState
          ? { blocks: js.blocksByConfigId ? js.blocksByConfigId[cidForIssue] : null }
          : activeCfg;
        materialIssue = getMaterialIssueForBlock(cfgViewForIssue, v.blockId);
      } catch (_) {}

      if (onProgress) {
        try {
          onProgress({
            phase: 'sanitize-material',
            iter: 0,
            variableId: v.id,
            baseValue,
            candidateValue: cand,
            effectiveValue: jointState ? getJointCurrentValue(jointState, v.id) : getCurrentDesignValueByVariableId(activeCfg, v.id),
            materialIssue,
            current: c,
            best: c,
            method,
            multiScenario,
            kind: 'categorical'
          });
        } catch (_) {}
        await nextFrame();
      }

      if (e && compareEval(e, bestLocalEval)) {
        bestLocalEval = e;
        bestLocalValue = cand;
      }
    }

    if (shouldStop && shouldStop()) break;

    // Force a non-AIR material even if it worsens cost, because AIR is invalid for Lens materials.
  if (jointState) setJointDesignVariableValue(jointState, v.id, bestLocalValue);
  else setDesignVariableValue(activeCfg, v.id, bestLocalValue);
    changedCount++;

    if (onProgress) {
      try {
        onProgress({
          phase: 'sanitize-material-accept',
          iter: 0,
          variableId: v.id,
          acceptedValue: bestLocalValue,
          effectiveValue: jointState ? getJointCurrentValue(jointState, v.id) : getCurrentDesignValueByVariableId(activeCfg, v.id),
          materialIssue: (() => {
            try {
              const js2 = jointState || { blocksByConfigId: null, targetConfigIds: null, activeConfigId: activeCfg?.id };
              const { configId: c2 } = parseJointVariableId(v.id);
              const cidForIssue = c2 ? String(c2) : String(js2.activeConfigId ?? '');
              const cfgViewForIssue = jointState
                ? { blocks: js2.blocksByConfigId ? js2.blocksByConfigId[cidForIssue] : null }
                : activeCfg;
              return getMaterialIssueForBlock(cfgViewForIssue, v.blockId);
            } catch (_) {
              return null;
            }
          })(),
          current: bestLocalEval ? bestLocalEval.score : NaN,
          best: bestLocalEval ? bestLocalEval.score : NaN,
          method,
          multiScenario,
          kind: 'categorical'
        });
      } catch (_) {}
      await nextFrame();
    }
  }

  return { changed: changedCount > 0, changedCount };
}

async function runCategoricalMaterialSweep({
  activeCfg,
  systemConfig,
  jointState,
  categoricalVars,
  evalState,
  onProgress,
  shouldStop,
  iter,
  multiScenario,
  bestEval
}) {
  const catVars = Array.isArray(categoricalVars) ? categoricalVars : getCategoricalMaterialVariables(activeCfg);
  if (!Array.isArray(catVars) || catVars.length === 0) {
    return { changed: false, bestEval };
  }

  let best = bestEval;
  let changed = false;

  for (const v of catVars) {
    if (shouldStop && shouldStop()) break;

    const baseValue = String(v.value ?? '').trim();
  const js = jointState || { blocksByConfigId: null, targetConfigIds: null, activeConfigId: activeCfg?.id };
  const { configId, baseId } = parseJointVariableId(v.id);
  const cidForCandidates = configId ? String(configId) : String(js.activeConfigId ?? '');
  const cfgViewForCandidates = { blocks: (js.blocksByConfigId && js.blocksByConfigId[cidForCandidates]) || activeCfg?.blocks };
  const candidates = getMaterialCandidatesForVar(cfgViewForCandidates, baseId, baseValue);
    if (candidates.length <= 1) continue;

    let bestLocalValue = baseValue;
    let bestLocalEval = best;

    for (const cand of candidates) {
      if (shouldStop && shouldStop()) break;
      if (String(cand).trim() === baseValue) continue;
      if (isAirMaterialName(cand)) continue;

      const okSet = jointState
        ? setJointDesignVariableValue(jointState, v.id, cand)
        : setDesignVariableValue(activeCfg, v.id, cand);
      if (!okSet) continue;

      const e = evalState ? evalState() : null;

      let materialIssue = null;
      try {
        const cidForIssue = configId ? String(configId) : String(js.activeConfigId ?? '');
        const cfgViewForIssue = jointState
          ? { blocks: js.blocksByConfigId ? js.blocksByConfigId[cidForIssue] : null }
          : activeCfg;
        materialIssue = getMaterialIssueForBlock(cfgViewForIssue, v.blockId);
      } catch (_) {}

      if (onProgress) {
        try {
          onProgress({
            phase: 'candidate',
            iter,
            variableId: v.id,
            baseValue,
            candidateValue: cand,
            effectiveValue: jointState ? getJointCurrentValue(jointState, v.id) : getCurrentDesignValueByVariableId(activeCfg, v.id),
            materialIssue,
            current: e ? e.score : NaN,
            best: best ? best.score : NaN,
            multiScenario,
            kind: 'categorical',
            feasible: e ? e.feasible : undefined,
            violationScore: e ? e.violationScore : undefined
          });
        } catch (_) {}
        await nextFrame();
      }

      if (e && compareEval(e, bestLocalEval)) {
        bestLocalEval = e;
        bestLocalValue = cand;
      }
    }

    if (shouldStop && shouldStop()) break;

    if (bestLocalEval && compareEval(bestLocalEval, best)) {
      if (jointState) setJointDesignVariableValue(jointState, v.id, bestLocalValue);
      else setDesignVariableValue(activeCfg, v.id, bestLocalValue);
      best = bestLocalEval;
      changed = true;

      if (onProgress) {
        try {
          onProgress({
            phase: 'accept',
            iter,
            variableId: v.id,
            acceptedValue: bestLocalValue,
            effectiveValue: jointState ? getJointCurrentValue(jointState, v.id) : getCurrentDesignValueByVariableId(activeCfg, v.id),
            materialIssue: (() => {
              try {
                const cidForIssue = configId ? String(configId) : String(js.activeConfigId ?? '');
                const cfgViewForIssue = jointState
                  ? { blocks: js.blocksByConfigId ? js.blocksByConfigId[cidForIssue] : null }
                  : activeCfg;
                return getMaterialIssueForBlock(cfgViewForIssue, v.blockId);
              } catch (_) {
                return null;
              }
            })(),
            current: best ? best.score : NaN,
            best: best ? best.score : NaN,
            multiScenario,
            kind: 'categorical',
            feasible: best ? best.feasible : undefined,
            violationScore: best ? best.violationScore : undefined
          });
        } catch (_) {}
        await nextFrame();
      }
    } else {
      // Restore
      if (jointState) setJointDesignVariableValue(jointState, v.id, baseValue);
      else setDesignVariableValue(activeCfg, v.id, baseValue);

      if (onProgress) {
        try {
          onProgress({
            phase: 'reject',
            iter,
            variableId: v.id,
            effectiveValue: jointState ? getJointCurrentValue(jointState, v.id) : getCurrentDesignValueByVariableId(activeCfg, v.id),
            materialIssue: (() => {
              try {
                const cidForIssue = configId ? String(configId) : String(js.activeConfigId ?? '');
                const cfgViewForIssue = jointState
                  ? { blocks: js.blocksByConfigId ? js.blocksByConfigId[cidForIssue] : null }
                  : activeCfg;
                return getMaterialIssueForBlock(cfgViewForIssue, v.blockId);
              } catch (_) {
                return null;
              }
            })(),
            current: best ? best.score : NaN,
            best: best ? best.score : NaN,
            multiScenario,
            kind: 'categorical',
            feasible: best ? best.feasible : undefined,
            violationScore: best ? best.violationScore : undefined
          });
        } catch (_) {}
        await nextFrame();
      }
    }
  }

  return { changed, bestEval: best };
}

function formatNoVariableReason(activeCfg) {
  try {
    const allMarked = listDesignVariablesFromBlocks(activeCfg);
    if (!Array.isArray(allMarked) || allMarked.length === 0) {
      return 'No design variables are marked as variable (V). Open a Block in “Design Intent (Blocks)” and check “Optimize” for numeric parameters (e.g. frontRadius/backRadius/centerThickness, AirGap.thickness, Stop.semiDiameter).';
    }

    const nonNumeric = allMarked.filter(v => !(v && typeof v.value === 'number' && Number.isFinite(v.value)));
    if (nonNumeric.length > 0) {
      const sample = nonNumeric.slice(0, 6).map(v => `${String(v?.id ?? '')}=${String(v?.value ?? '')}`).filter(Boolean).join(', ');
      return `No numeric design variables are marked as variable (V). Currently marked V but non-numeric/empty: ${sample}${nonNumeric.length > 6 ? ', ...' : ''}. Mark numeric parameters as “Optimize” to enable Optimize.`;
    }

    return 'No numeric design variables are marked as variable (V).';
  } catch (_) {
    return 'No numeric design variables are marked as variable (V).';
  }
}

function initialStepForValue(value, stepFraction, minStep) {
  const v = Math.abs(Number(value));
  const s = Math.max(minStep, v * stepFraction);
  // If value is very small, ensure a non-trivial step.
  return Math.max(s, minStep);
}

function parseCoefIndexFromKey(key) {
  const s = String(key ?? '').trim();
  if (!s) return null;
  const m = s.match(/coef(\d+)$/i);
  if (!m) return null;
  const idx = Number(m[1]);
  if (!Number.isFinite(idx)) return null;
  return idx;
}

function isAsphereCoefKey(key) {
  return parseCoefIndexFromKey(key) !== null;
}

function defaultScaleForKey(key) {
  const s = String(key ?? '').trim();
  if (!s) return 1;
  if (isAsphereCoefKey(s)) {
    const idx = parseCoefIndexFromKey(s);
    // Heuristic scale for polynomial coefficients used in ray-tracing.js:
    // coef1*r^2, coef2*r^4, ...
    // Lower-order terms typically need much larger magnitudes than higher orders.
    // This scale is primarily used for FD steps and trust-region clipping.
    // coef1: 1e-6, coef2: 1e-8, coef3: 1e-10, ...
    if (idx === null) return 1e-12;
    const exp = -6 - 2 * Math.max(0, idx - 1);
    const sc = Math.pow(10, exp);
    return (Number.isFinite(sc) && sc > 0) ? sc : 1e-12;
  }
  if (/conic$/i.test(s)) return 1;
  if (/radius$/i.test(s)) return 100;
  if (/thickness$/i.test(s)) return 10;
  if (/semidiameter$/i.test(s) || /semidia$/i.test(s)) return 10;
  return 1;
}

function buildStagedCoefMaxList(opts) {
  if (opts && Array.isArray(opts.stageMaxCoef)) {
    const arr = opts.stageMaxCoef
      .map(v => Number(v))
      .filter(v => Number.isFinite(v) && v >= 0)
      .sort((a, b) => a - b);
    if (arr.length > 0) return arr;
  }
  // Default continuation schedule for asphere: unlock higher orders gradually.
  return [0, 2, 4, 6, 8, 10];
}

function stageAllowsVariable(varKey, maxCoefIndex) {
  const idx = parseCoefIndexFromKey(varKey);
  if (idx === null) return true; // non-coef always enabled
  const maxIdx = Number.isFinite(Number(maxCoefIndex)) ? Number(maxCoefIndex) : 10;
  return idx <= maxIdx;
}

/**
 * Run coordinate descent optimization on the active configuration.
 *
 * @param {{
 *   runUntilStopped?: boolean,
 *   maxIterations?: number,
 *   stepFraction?: number,
 *   minStep?: number,
 *   stepDecay?: number,
 *   stallLimit?: number,
 *   logEvery?: number
 * }=} options
 * @returns {{ ok: boolean, before?: number, best?: number, iterations?: number, variables?: number, reason?: string }}
 */
export async function runOptimizationMVP(options = {}) {
  const opts = isPlainObject(options) ? options : {};

  // Lightweight profiler to quickly identify bottlenecks.
  // Enabled by default; disable via { profile:false }.
  const __profileEnabled = (opts.profile === undefined) ? true : !!opts.profile;
  const __profile = __profileEnabled ? {
    t0: nowMs(),
    startedAt: Date.now(),
    totalMs: 0,
    sectionsMs: /** @type {Record<string, number>} */ ({}),
    operandMs: /** @type {Record<string, { ms:number, calls:number }>} */ ({}),
    operandCfgMs: /** @type {Record<string, { ms:number, calls:number }>} */ ({}),
    lastSeenOperandCfg: /** @type {Record<string, any>} */ ({}),
    counts: {
      calculateOperandValueCalls: 0,
      calculateOperandValueMs: 0,
      evalResidualsNowCalls: 0,
      evalResidualsNowMs: 0,
      evalCompositeCalls: 0,
      evalCompositeMs: 0,
      onProgressCalls: 0,
      onProgressMs: 0,
      nextFrameCalls: 0,
      nextFrameMs: 0
    }
  } : null;

  let __profileEmitted = false;

  const __profAdd = (name, dt) => {
    if (!__profile) return;
    const key = String(name || 'unknown');
    const v = Number(dt);
    if (!Number.isFinite(v) || v < 0) return;
    __profile.sectionsMs[key] = (__profile.sectionsMs[key] || 0) + v;
  };

  const __profWrap = (name, fn) => {
    if (!__profile) return fn();
    const t = nowMs();
    try {
      return fn();
    } finally {
      __profAdd(name, nowMs() - t);
    }
  };

  const __emitProfileSummary = (result) => {
    if (!__profile) return;
    __profileEmitted = true;
    try {
      __profile.totalMs = nowMs() - __profile.t0;
      __profile.endedAt = Date.now();
      __profile.method = String(opts.method || 'lm');
      __profile.result = result || null;

      // Convenience top-level aliases (older snippets expect these at root).
      if (__profile.counts && typeof __profile.counts === 'object') {
        __profile.calculateOperandValueCalls = Number(__profile.counts.calculateOperandValueCalls) || 0;
        __profile.calculateOperandValueMs = Number(__profile.counts.calculateOperandValueMs) || 0;
        __profile.evalResidualsNowCalls = Number(__profile.counts.evalResidualsNowCalls) || 0;
        __profile.evalResidualsNowMs = Number(__profile.counts.evalResidualsNowMs) || 0;
        __profile.evalCompositeCalls = Number(__profile.counts.evalCompositeCalls) || 0;
        __profile.evalCompositeMs = Number(__profile.counts.evalCompositeMs) || 0;
        __profile.onProgressCalls = Number(__profile.counts.onProgressCalls) || 0;
        __profile.onProgressMs = Number(__profile.counts.onProgressMs) || 0;
        __profile.nextFrameCalls = Number(__profile.counts.nextFrameCalls) || 0;
        __profile.nextFrameMs = Number(__profile.counts.nextFrameMs) || 0;
      }
    } catch (_) {}

    try {
      if (typeof window !== 'undefined') window.__cooptLastOptimizeProfile = __profile;
    } catch (_) {}

    try {
      const totalMs = Number(__profile.totalMs) || 0;
      const rows = [];

      const addRow = (section, ms, calls) => {
        const t = Number(ms);
        const c = Number(calls);
        const pct = (totalMs > 0 && Number.isFinite(t)) ? (100 * t / totalMs) : 0;
        const per = (Number.isFinite(t) && Number.isFinite(c) && c > 0) ? (t / c) : null;
        rows.push({
          section,
          ms: Number.isFinite(t) ? Math.round(t) : null,
          pctTotal: Number.isFinite(pct) ? Math.round(pct * 10) / 10 : null,
          calls: Number.isFinite(c) ? c : null,
          msPerCall: (per === null || !Number.isFinite(per)) ? null : Math.round(per * 1000) / 1000
        });
      };

      // Note: these timers are not mutually exclusive (nested). pctTotal is still
      // useful as an upper bound for “how much of wall time is spent here”.
      addRow('calculateOperandValue', __profile.counts.calculateOperandValueMs, __profile.counts.calculateOperandValueCalls);
      addRow('evalResidualsNow', __profile.counts.evalResidualsNowMs, __profile.counts.evalResidualsNowCalls);
      addRow('evalCompositeFromRequirements', __profile.counts.evalCompositeMs, __profile.counts.evalCompositeCalls);
      addRow('onProgress', __profile.counts.onProgressMs, __profile.counts.onProgressCalls);
      addRow('nextFrame', __profile.counts.nextFrameMs, __profile.counts.nextFrameCalls);

      for (const k of Object.keys(__profile.sectionsMs || {})) {
        if (k === 'evalResidualsNow' || k === 'evalCompositeFromRequirements' || k === 'calculateOperandValue') continue;
        addRow(String(k), __profile.sectionsMs[k], null);
      }

      rows.sort((a, b) => (Number(b.ms) || 0) - (Number(a.ms) || 0));

      console.groupCollapsed('[OptimizerMVP] profile', {
        totalMs: Math.round(totalMs),
        method: __profile.method,
        ok: result ? !!result.ok : null,
        aborted: result ? !!result.aborted : null
      });
      if (typeof console.table === 'function') console.table(rows);
      else console.log(rows);

      // Operand-level breakdown (dominant hot path).
      const byOperand = [];
      try {
        const m = __profile.operandMs || {};
        for (const k of Object.keys(m)) {
          const e = m[k];
          const ms = Number(e?.ms);
          const calls = Number(e?.calls);
          if (!Number.isFinite(ms) || ms <= 0) continue;
          const pct = (totalMs > 0) ? (100 * ms / totalMs) : 0;
          const per = (Number.isFinite(calls) && calls > 0) ? (ms / calls) : null;
          byOperand.push({ operand: k, ms: Math.round(ms), pctTotal: Math.round(pct * 10) / 10, calls: Number.isFinite(calls) ? calls : null, msPerCall: (per === null || !Number.isFinite(per)) ? null : Math.round(per * 1000) / 1000 });
        }
      } catch (_) {}
      byOperand.sort((a, b) => (Number(b.ms) || 0) - (Number(a.ms) || 0));
      if (byOperand.length > 0) {
        console.log('[OptimizerMVP] profile by operand (top 12)');
        if (typeof console.table === 'function') console.table(byOperand.slice(0, 12));
        else console.log(byOperand.slice(0, 12));

        // Ensure the top operand is visible even when console.table output isn't copied.
        try {
          __profile.dominantOperand = byOperand[0] || null;
          console.log('[OptimizerMVP] dominant operand', __profile.dominantOperand);
        } catch (_) {}
      }

      // Operand+config breakdown (helps catch one heavy config).
      const byOperandCfg = [];
      try {
        const m = __profile.operandCfgMs || {};
        for (const k of Object.keys(m)) {
          const e = m[k];
          const ms = Number(e?.ms);
          const calls = Number(e?.calls);
          if (!Number.isFinite(ms) || ms <= 0) continue;
          const pct = (totalMs > 0) ? (100 * ms / totalMs) : 0;
          const per = (Number.isFinite(calls) && calls > 0) ? (ms / calls) : null;
          byOperandCfg.push({ key: k, ms: Math.round(ms), pctTotal: Math.round(pct * 10) / 10, calls: Number.isFinite(calls) ? calls : null, msPerCall: (per === null || !Number.isFinite(per)) ? null : Math.round(per * 1000) / 1000 });
        }
      } catch (_) {}
      byOperandCfg.sort((a, b) => (Number(b.ms) || 0) - (Number(a.ms) || 0));
      if (byOperandCfg.length > 0) {
        console.log('[OptimizerMVP] profile by operand+config (top 12)');
        if (typeof console.table === 'function') console.table(byOperandCfg.slice(0, 12));
        else console.log(byOperandCfg.slice(0, 12));

        // Same as above: make sure the top entry is visible in plain logs.
        try {
          __profile.dominantOperandCfg = byOperandCfg[0] || null;
          console.log('[OptimizerMVP] dominant operand+config', __profile.dominantOperandCfg);
        } catch (_) {}
      }

      // If the dominant hot spot is a Spot operand, surface its debug snapshot.
      try {
        const dom = __profile.dominantOperandCfg;
        const domKey = dom && dom.key ? String(dom.key) : '';
        const sep = domKey.indexOf('|cfg:');
        const domOperand = (sep >= 0) ? domKey.slice(0, sep) : '';
        const domCfgLabel = (sep >= 0) ? domKey.slice(sep + 5) : '';
        const isSpot = !!domOperand && String(domOperand).startsWith('SPOT_SIZE');
        if (isSpot) {
          const last = (__profile.lastSeenOperandCfg && domKey && __profile.lastSeenOperandCfg[domKey])
            ? __profile.lastSeenOperandCfg[domKey]
            : null;

          const cfgForKey = (domCfgLabel && domCfgLabel !== 'active') ? String(domCfgLabel) : '';
          const spotDebugKey = `operand:${String(domOperand ?? '')}|cfg:${String(cfgForKey ?? '')}`
            + `|p1:${String(last?.param1 ?? '')}|p2:${String(last?.param2 ?? '')}`
            + `|p3:${String(last?.param3 ?? '')}|p4:${String(last?.param4 ?? '')}`;

          let spotDebug = null;
          try {
            const fastByKey = (typeof window !== 'undefined' && window.__cooptSpotSizeDebugFastByKey && typeof window.__cooptSpotSizeDebugFastByKey === 'object')
              ? window.__cooptSpotSizeDebugFastByKey
              : null;
            const anyByKey = (typeof window !== 'undefined' && window.__cooptSpotSizeDebugByKey && typeof window.__cooptSpotSizeDebugByKey === 'object')
              ? window.__cooptSpotSizeDebugByKey
              : null;
            spotDebug = (fastByKey && fastByKey[spotDebugKey])
              ? fastByKey[spotDebugKey]
              : (anyByKey && anyByKey[spotDebugKey])
                ? anyByKey[spotDebugKey]
                : null;
          } catch (_) {
            spotDebug = null;
          }

          __profile.dominantSpotDebugKey = spotDebugKey;
          __profile.dominantSpotDebug = spotDebug;
          console.log('[OptimizerMVP] dominant spot debug key', spotDebugKey);
          console.log('[OptimizerMVP] dominant spot debug', spotDebug);
        }
      } catch (_) {}

      const top = rows[0];
      if (top && top.section) {
        console.log('[OptimizerMVP] profile dominant', {
          section: top.section,
          ms: top.ms,
          pctTotal: top.pctTotal,
          calls: top.calls
        });
      }
      console.groupEnd();
    } catch (_) {}
  };

  // Reset global stop flag at the start of each run.
  __optimizerStopRequested = false;
  const runUntilStopped = !!opts.runUntilStopped;
  const methodRaw = String(opts.method || '').trim().toLowerCase();
  const method = (methodRaw === 'cd' || methodRaw === 'coordinatedescent') ? 'cd' : 'lm';
  const maxIterations = runUntilStopped
    ? Number.MAX_SAFE_INTEGER
    : (Number.isFinite(Number(opts.maxIterations)) ? Math.max(1, Math.floor(Number(opts.maxIterations))) : 20);
  const stepFraction = Number.isFinite(Number(opts.stepFraction)) ? Math.max(1e-6, Number(opts.stepFraction)) : 0.02;
  const minStep = Number.isFinite(Number(opts.minStep)) ? Math.max(1e-12, Number(opts.minStep)) : 1e-6;
  const stepDecay = Number.isFinite(Number(opts.stepDecay)) ? Math.min(0.95, Math.max(0.1, Number(opts.stepDecay))) : 0.5;
  const stallLimit = runUntilStopped
    ? Number.MAX_SAFE_INTEGER
    : (Number.isFinite(Number(opts.stallLimit)) ? Math.max(1, Math.floor(Number(opts.stallLimit))) : 3);
  const logEvery = Number.isFinite(Number(opts.logEvery)) ? Math.max(1, Math.floor(Number(opts.logEvery))) : 1;

  const lmLambda0 = Number.isFinite(Number(opts.lmLambda0)) ? Math.max(1e-12, Number(opts.lmLambda0)) : 1e-3;
  const lmLambdaUp = Number.isFinite(Number(opts.lmLambdaUp)) ? Math.max(1.1, Number(opts.lmLambdaUp)) : 10;
  const lmLambdaDown = Number.isFinite(Number(opts.lmLambdaDown)) ? Math.min(0.95, Math.max(1e-3, Number(opts.lmLambdaDown))) : 0.3;
  const fdStepFraction = Number.isFinite(Number(opts.fdStepFraction)) ? Math.max(1e-10, Number(opts.fdStepFraction)) : 1e-4;
  // Default must be tiny enough for asphere coefficients (often ~1e-12 and smaller).
  // A too-large absolute FD step will destroy Jacobians for coef vars.
  const fdMinStep = Number.isFinite(Number(opts.fdMinStep)) ? Math.max(1e-30, Number(opts.fdMinStep)) : 1e-18;
  const fdScaledStep = Number.isFinite(Number(opts.fdScaledStep)) ? Math.max(1e-9, Number(opts.fdScaledStep)) : 1e-3;

  // Continuation/staged optimization for aspherics.
  // Enabled by default for LM because it significantly reduces local-minimum trapping.
  const staged = (opts.staged === undefined) ? true : !!opts.staged;
  const stageMaxCoefList = staged ? buildStagedCoefMaxList(opts) : [10];
  const stageStallLimit = Number.isFinite(Number(opts.stageStallLimit)) ? Math.max(1, Math.floor(Number(opts.stageStallLimit))) : 2;

  // Trust region / step control in scaled coordinates.
  const trustRegion = (opts.trustRegion === undefined) ? true : !!opts.trustRegion;
  // In staged LM (especially with asphere coefficients), smaller steps are much more stable.
  const trustRegionDelta = Number.isFinite(Number(opts.trustRegionDelta))
    ? Math.max(1e-6, Number(opts.trustRegionDelta))
    : ((method === 'lm' && staged) ? 0.05 : 0.2);
  const trustRegionDeltaMax = Number.isFinite(Number(opts.trustRegionDeltaMax))
    ? Math.max(trustRegionDelta, Number(opts.trustRegionDeltaMax))
    : Math.max(trustRegionDelta, 1.0);

  // Optional: restart/jitter when LM is stuck (e.g. reject streak) to escape local minima.
  // This is intentionally simple; it prefers coefficient-like variables but will fall back
  // to jittering active variables if no coef vars are present (common in early-stage designs).
  const restartOnRejectStreak = Number.isFinite(Number(opts.restartOnRejectStreak))
    ? Math.max(1, Math.floor(Number(opts.restartOnRejectStreak)))
    : 8;
  const restartMaxCount = Number.isFinite(Number(opts.restartMaxCount))
    ? Math.max(0, Math.floor(Number(opts.restartMaxCount)))
    : 2;
  // Jitter magnitude is in scaled coordinates: delta = jitterScaled * scale(var)
  const restartJitterScaled = Number.isFinite(Number(opts.restartJitterScaled))
    ? Math.max(0, Number(opts.restartJitterScaled))
    : 0.035;

  // Backtracking line search along LM step.
  const backtracking = (opts.backtracking === undefined) ? true : !!opts.backtracking;
  const backtrackingMaxTries = Number.isFinite(Number(opts.backtrackingMaxTries)) ? Math.max(1, Math.floor(Number(opts.backtrackingMaxTries))) : 8;

  // If the LM step becomes (near-)zero (common when residuals are flat / discontinuous),
  // rho tends to 0 and we can get stuck rejecting forever. Allow a tiny random exploration
  // step inside the same trust-region envelope to break out.
  // Default OFF: user requested no perturbation after rho=0.
  const lmExploreWhenFlat = (opts.lmExploreWhenFlat === undefined) ? false : !!opts.lmExploreWhenFlat;
  const lmExploreTries = Number.isFinite(Number(opts.lmExploreTries)) ? Math.max(1, Math.floor(Number(opts.lmExploreTries))) : 3;

  // Persistence control: for correctness, we default to saving in inner loops.
  // If you want speed and your evaluator reads from the live activeCfg object,
  // set persistInnerLoop=false.
  const persistInnerLoop = (opts.persistInnerLoop === undefined) ? true : !!opts.persistInnerLoop;

  const multiScenario = !!opts.multiScenario;
  const onProgressRaw = (typeof opts.onProgress === 'function') ? opts.onProgress : null;
  const onProgress = (!onProgressRaw)
    ? null
    : (!__profile)
      ? onProgressRaw
      : (payload) => {
        const t = nowMs();
        try {
          __profile.counts.onProgressCalls++;
          onProgressRaw(payload);
        } catch (_) {
        } finally {
          const dt = nowMs() - t;
          __profile.counts.onProgressMs += dt;
          __profAdd('onProgress', dt);
        }
      };
  const userShouldStop = (typeof opts.shouldStop === 'function') ? opts.shouldStop : null;

  // Fast path for expensive operands (notably Spot RMS/diameter).
  // Optimizer can tolerate approximate evaluation to gain speed.
  // You can disable by passing { spotFastMode: false }.
  const spotFastMode = (opts.spotFastMode === undefined) ? true : !!opts.spotFastMode;
  const spotRayCountFast = Number.isFinite(Number(opts.spotRayCountFast))
    ? Math.max(5, Math.min(2000, Math.floor(Number(opts.spotRayCountFast))))
    : 101;
  const spotAnnularRingCountFast = Number.isFinite(Number(opts.spotAnnularRingCountFast))
    ? Math.max(1, Math.min(50, Math.floor(Number(opts.spotAnnularRingCountFast))))
    : 6;
  const shouldStop = () => {
    if (__optimizerStopRequested) return true;
    try { return userShouldStop ? !!userShouldStop() : false; } catch (_) { return false; }
  };

  const editor = (typeof window !== 'undefined') ? window.meritFunctionEditor : null;
  if (!editor || typeof editor.calculateOperandValue !== 'function') {
    return { ok: false, reason: 'meritFunctionEditor.calculateOperandValue() is not ready.' };
  }

  // Instrument calculateOperandValue() calls (dominant hot path in most runs).
  let __prevCalcOperandValue = null;
  try {
    if (__profile) {
      __prevCalcOperandValue = editor.calculateOperandValue;
      const original = editor.calculateOperandValue.bind(editor);
      editor.calculateOperandValue = (opObj) => {
        const t = nowMs();
        try {
          return original(opObj);
        } finally {
          const dt = nowMs() - t;
          __profile.counts.calculateOperandValueCalls++;
          __profile.counts.calculateOperandValueMs += dt;
          __profAdd('calculateOperandValue', dt);

          try {
            const opName = (opObj && opObj.operand !== undefined && opObj.operand !== null)
              ? String(opObj.operand)
              : 'UNKNOWN';
            const cfg = (opObj && opObj.configId !== undefined && opObj.configId !== null)
              ? String(opObj.configId)
              : '';

            const byOp = __profile.operandMs;
            const prevOp = byOp[opName] || { ms: 0, calls: 0 };
            prevOp.ms += dt;
            prevOp.calls += 1;
            byOp[opName] = prevOp;

            const key = cfg ? `${opName}|cfg:${cfg}` : `${opName}|cfg:active`;
            const byOpCfg = __profile.operandCfgMs;
            const prevCfg = byOpCfg[key] || { ms: 0, calls: 0 };
            prevCfg.ms += dt;
            prevCfg.calls += 1;
            byOpCfg[key] = prevCfg;

            // Keep last params for this operand+cfg so we can fetch spot debug snapshots.
            __profile.lastSeenOperandCfg[key] = {
              operand: opName,
              configId: cfg,
              param1: opObj?.param1,
              param2: opObj?.param2,
              param3: opObj?.param3,
              param4: opObj?.param4
            };
          } catch (_) {}
        }
      };
    }
  } catch (_) {
    __prevCalcOperandValue = null;
  }

  const systemConfig = loadSystemConfigurationsRaw();
  if (!systemConfig) {
    try {
      if (__prevCalcOperandValue) editor.calculateOperandValue = __prevCalcOperandValue;
    } catch (_) {}
    const res = { ok: false, reason: 'systemConfigurations not found.' };
    __emitProfileSummary(res);
    return res;
  }

  const activeCfg = getActiveConfigRef(systemConfig);
  const activeConfigId = activeCfg ? activeCfg.id : null;

  const allConfigs = Array.isArray(systemConfig.configurations) ? systemConfig.configurations : [];
  if (allConfigs.length === 0) {
    try {
      if (__prevCalcOperandValue) editor.calculateOperandValue = __prevCalcOperandValue;
    } catch (_) {}
    const res = { ok: false, reason: 'No configurations found in systemConfigurations.' };
    __emitProfileSummary(res);
    return res;
  }

  // Multi-config optimization: target ALL configurations.
  const targetConfigs = allConfigs;
  const targetConfigIds = targetConfigs
    .filter(c => c && c.id !== undefined && c.id !== null)
    .map(c => String(c.id));

  /** @type {Record<string, any>} */
  const configsById = {};
  for (const c of targetConfigs) {
    if (!c || c.id === undefined || c.id === null) continue;
    configsById[String(c.id)] = c;
  }

  // Validate that every targeted config has Blocks (Design Intent).
  const noBlocks = targetConfigs
    .filter(c => !c || !Array.isArray(c.blocks) || c.blocks.length === 0)
    .map(c => c?.name ? `${String(c.name)}(${String(c?.id ?? '')})` : String(c?.id ?? ''));
  if (noBlocks.length > 0) {
    try {
      if (__prevCalcOperandValue) editor.calculateOperandValue = __prevCalcOperandValue;
    } catch (_) {}
    const res = { ok: false, reason: `Some configurations have no Design Intent (blocks): ${noBlocks.join(', ')}` };
    __emitProfileSummary(res);
    return res;
  }

  // Non-persistent override map so Merit evaluation can see in-flight block edits.
  /** @type {Record<string, any[]>} */
  const blocksByConfigId = {};
  for (const cid of targetConfigIds) {
    const cfg = configsById[cid];
    blocksByConfigId[cid] = JSON.parse(JSON.stringify(cfg.blocks || []));
  }

  let __prevBlocksOverride;
  let __prevOpticalRowsOverride;
  let __prevScenarioOverride;
  let __prevMeritFastMode;
  let __prevOptimizerProfileContext;
  let __prevDisableRayTraceDebug;
  try { __prevBlocksOverride = (typeof window !== 'undefined') ? window.__cooptBlocksOverride : undefined; } catch (_) { __prevBlocksOverride = undefined; }
  try { __prevOpticalRowsOverride = (typeof globalThis !== 'undefined') ? globalThis.__cooptOpticalSystemRowsOverride : undefined; } catch (_) { __prevOpticalRowsOverride = undefined; }
  try { __prevScenarioOverride = (typeof window !== 'undefined') ? window.__cooptScenarioOverride : undefined; } catch (_) { __prevScenarioOverride = undefined; }
  try { __prevMeritFastMode = (typeof globalThis !== 'undefined') ? globalThis.__cooptMeritFastMode : undefined; } catch (_) { __prevMeritFastMode = undefined; }
  try { __prevOptimizerProfileContext = (typeof globalThis !== 'undefined') ? globalThis.__cooptOptimizerProfileContext : undefined; } catch (_) { __prevOptimizerProfileContext = undefined; }
  try { __prevDisableRayTraceDebug = (typeof globalThis !== 'undefined') ? globalThis.__COOPT_DISABLE_RAYTRACE_DEBUG : undefined; } catch (_) { __prevDisableRayTraceDebug = undefined; }

  try {
    if (typeof window !== 'undefined') window.__cooptBlocksOverride = blocksByConfigId;
  } catch (_) {}

  // Allow shared yield helpers (e.g. nextFrame()) to attribute time to this run.
  try {
    if (__profile && typeof globalThis !== 'undefined') {
      globalThis.__cooptOptimizerProfileContext = __profile;
    }
  } catch (_) {}

  // Tell merit-function evaluation to use a fast approximation for Spot-based operands.
  // (This avoids the Spot Diagram generator and reduces ray count.)
  try {
    if (spotFastMode && typeof globalThis !== 'undefined') {
      const spotEarlyAbortEnabled = (opts.spotEarlyAbortEnabled === undefined) ? true : !!opts.spotEarlyAbortEnabled;
      const spotEarlyAbortMinAttempt = Number.isFinite(Number(opts.spotEarlyAbortMinAttempt))
        ? Math.max(5, Math.floor(Number(opts.spotEarlyAbortMinAttempt)))
        : 8;
      const spotEarlyAbortMinHitRate = Number.isFinite(Number(opts.spotEarlyAbortMinHitRate))
        ? Math.max(0.001, Math.min(0.999, Number(opts.spotEarlyAbortMinHitRate)))
        : 0.20;
      const spotEarlyAbortMaxHits = Number.isFinite(Number(opts.spotEarlyAbortMaxHits))
        ? Math.max(0, Math.floor(Number(opts.spotEarlyAbortMaxHits)))
        : 8;
      const spotEarlyAbortMaxAttempt = Number.isFinite(Number(opts.spotEarlyAbortMaxAttempt))
        ? Math.max(spotEarlyAbortMinAttempt, Math.floor(Number(opts.spotEarlyAbortMaxAttempt)))
        : 12;
      const spotEarlyAbortMissStreakMin = Number.isFinite(Number(opts.spotEarlyAbortMissStreakMin))
        ? Math.max(5, Math.floor(Number(opts.spotEarlyAbortMissStreakMin)))
        : 8;
      const spotEarlyAbortBlockStreakMin = Number.isFinite(Number(opts.spotEarlyAbortBlockStreakMin))
        ? Math.max(3, Math.floor(Number(opts.spotEarlyAbortBlockStreakMin)))
        : 4;
      const spotEarlyAbortStreakMaxHits = Number.isFinite(Number(opts.spotEarlyAbortStreakMaxHits))
        ? Math.max(0, Math.floor(Number(opts.spotEarlyAbortStreakMaxHits)))
        : 12;

      globalThis.__cooptMeritFastMode = {
        enabled: true,
        spotRayCount: spotRayCountFast,
        spotAnnularRingCount: spotAnnularRingCountFast,
        // Keep semantics aligned with Requirements/Spot Diagram (surfaceIndex, primary wavelength, etc.)
        // while still avoiding reading live UI tables for non-active configs.
        spotUseUiDefaults: true,
        spotUseUiTables: false,
        // Fast-mode early-abort knobs (hit-rate based)
        spotEarlyAbortEnabled,
        spotEarlyAbortMinAttempt,
        spotEarlyAbortMinHitRate,
        spotEarlyAbortMaxHits
        ,
        // Additional early-abort knobs (streak/cap based)
        spotEarlyAbortMaxAttempt,
        spotEarlyAbortMissStreakMin,
        spotEarlyAbortBlockStreakMin,
        spotEarlyAbortStreakMaxHits
      };
    }
  } catch (_) {}

  // Disable ray-tracing detailed debug logging during optimization.
  // This prevents the WASM intersection fast-path from being bypassed due to debugLog being non-null.
  try {
    if (typeof globalThis !== 'undefined') globalThis.__COOPT_DISABLE_RAYTRACE_DEBUG = true;
  } catch (_) {}

  // Ensure the active-config evaluator sees Blocks, not stale live UI tables.
  try {
    if (activeConfigId !== null && activeConfigId !== undefined) {
      const ab = blocksByConfigId[String(activeConfigId)];
      if (Array.isArray(ab)) updateActiveOpticalSystemOverrideFromBlocks(ab);
    }
  } catch (_) {}

  try {

  const requirementsRaw = getSystemRequirementsRaw(systemConfig);
  const requirements = (Array.isArray(requirementsRaw) ? requirementsRaw : [])
    .map(r => normalizeRequirementRow(r, systemConfig, activeConfigId));

  const expandedRequirements = expandRequirementsForTargetConfigs(requirements, targetConfigIds)
    .filter(r => {
      const w = toFiniteNumber(r.weight, 1);
      return w > 0;
    });

  const requirementCount = expandedRequirements.length;
  if (requirementCount === 0) {
    return { ok: false, reason: 'No active System Requirements for any configuration (check operand / enabled / weight).' };
  }

  const residualItems = buildResidualItemsForConfigs(expandedRequirements, configsById, multiScenario);
  const residualCount = residualItems.length;
  if (residualCount === 0) {
    return { ok: false, reason: 'No residual items were generated for the selected configs/scenarios.' };
  }

  const jointState = {
    blocksByConfigId,
    targetConfigIds,
    activeConfigId
  };

  let bestFeasibleEval = null;
  let bestInfeasibleEval = null;
  const recordEval = (e) => {
    if (!e) return;
    const snap = snapshotBlocksByConfigId(blocksByConfigId);
    if (e.feasible) {
      if (!bestFeasibleEval || compareEval(e, bestFeasibleEval)) {
        bestFeasibleEval = { ...e, blocksSnapshot: snap };
      }
    } else {
      if (!bestInfeasibleEval || compareEval(e, bestInfeasibleEval)) {
        bestInfeasibleEval = { ...e, blocksSnapshot: snap };
      }
    }
  };
  const getBestEvalSoFar = () => bestFeasibleEval || bestInfeasibleEval;
  const evalCompositeFromRequirements = () => {
    const req = evaluateRequirementsAllConfigsAllScenarios({
      expandedRequirements,
      residualItems,
      multiScenario
    });
    const violationScore = toFiniteNumber(req.violationScore, 0);
    const softPenalty = toFiniteNumber(req.softPenalty, 0);
    const score = violationScore + softPenalty;
    return {
      merit: 0,
      score,
      feasible: !!req.feasible,
      violationScore,
      softPenalty,
      hardViolations: req.hardViolations || [],
      softViolations: req.softViolations || []
    };
  };

  const evalCompositeFromRequirementsProfiled = __profile
    ? () => {
      const t = nowMs();
      try {
        __profile.counts.evalCompositeCalls++;
        return evalCompositeFromRequirements();
      } finally {
        const dt = nowMs() - t;
        __profile.counts.evalCompositeMs += dt;
        __profAdd('evalCompositeFromRequirements', dt);
      }
    }
    : evalCompositeFromRequirements;

  const jointVars = enumerateJointVariables({ targetConfigIds, blocksByConfigId, activeConfigId });
  if (Array.isArray(jointVars.errors) && jointVars.errors.length > 0) {
    return { ok: false, reason: `Design variables are inconsistent across configs: ${jointVars.errors.slice(0, 6).join(' | ')}${jointVars.errors.length > 6 ? ' | ...' : ''}` };
  }

  const vars = (Array.isArray(jointVars.numeric) ? jointVars.numeric : [])
    .map(coerceBlankAsphereToZero)
    .filter(v => v && typeof v.value === 'number' && Number.isFinite(v.value));
  const catVars = Array.isArray(jointVars.categoricalMaterial) ? jointVars.categoricalMaterial : [];
  if (vars.length === 0 && catVars.length === 0) {
    return { ok: false, reason: formatNoVariableReason(activeCfg) };
  }

  // DLS/LM mode
  if (method === 'lm') {
    const t0 = nowMs();

    let __prevOpticalSystemRowsOverride;
    try {
      __prevOpticalSystemRowsOverride = (typeof globalThis !== 'undefined') ? globalThis.__cooptOpticalSystemRowsOverride : undefined;
    } catch (_) {
      __prevOpticalSystemRowsOverride = undefined;
    }

    try {

    // Use a fixed-length residual vector for LM so the Jacobian dimension is stable.
    // Multi-config: residual items are pre-expanded by (configs × requirements × scenarios).
    const residualItemsForLM = residualItems;
    const nonFiniteResidualPenalty = Number.isFinite(Number(opts.nonFiniteResidualPenalty))
      ? Math.max(1, Number(opts.nonFiniteResidualPenalty))
      : 1e4;

    // Debug aid: record the worst residual contributor so we can see which operand
    // is driving the cost to ~1e9 (e.g., when an operand returns 1e9).
    let __cooptLastResidualDebugAt = 0;
    const __cooptResidualDebugThrottleMs = 200;

    // Residuals are built from Requirements violation amounts.
    // Hard+soft are both included as residuals (soft continues to improve after feasible).
    const evalResidualsNow = () => {
      /** @type {number[]} */
      const residuals = [];

      // Also compute the linear composite score (same semantics as evalCompositeFromRequirements)
      // without re-evaluating operands.
      let feasible = true;
      let violationScore = 0;
      let softPenalty = 0;
      const hardViolations = [];
      const softViolations = [];

      // Multi-config correctness: `getOpticalSystemRows()` consults globalThis.__cooptOpticalSystemRowsOverride.
      // When evaluating residuals for different configIds, we must swap the override accordingly,
      // otherwise many operands appear constant (J≈0 → dx≈0 → pred≈0 → rho=0) and LM stalls.
      let __prevOptRows = undefined;
      const __rowsByCfg = new Map();
      let __lastCfgId = null;

      let worst = null;
      let worstContribution = -Infinity;
      let nonFiniteCount = 0;

      const prev = (typeof window !== 'undefined') ? window.__cooptScenarioOverride : null;
      const overrideMap = (prev && typeof prev === 'object') ? { ...prev } : {};

      const itemsArr = Array.isArray(residualItemsForLM) ? residualItemsForLM : [];
      try {
        try {
          __prevOptRows = (typeof globalThis !== 'undefined') ? globalThis.__cooptOpticalSystemRowsOverride : undefined;
        } catch (_) {
          __prevOptRows = undefined;
        }

        for (let itemIndex = 0; itemIndex < itemsArr.length; itemIndex++) {
          const it = itemsArr[itemIndex];
          const r = it?.req;
          const cfgIdRaw = String(it?.configId ?? '').trim();
          const cfgId = cfgIdRaw || String(activeConfigId ?? '').trim();
        const sid = it?.scenarioId ? String(it.scenarioId) : null;
        const sw = toFiniteNumber(it?.scenarioWeight, 1);

        const w = Math.max(0, toFiniteNumber(r?.weight, 1)) * Math.max(0, toFiniteNumber(sw, 1));
        if (!(w > 0)) {
          residuals.push(0);
          continue;
        }

        const sqrtW = (w >= 0) ? Math.sqrt(w) : NaN;
        if (!Number.isFinite(sqrtW)) {
          residuals.push(0);
          continue;
        }

        if (cfgId) {
          if (sid) overrideMap[cfgId] = sid;
          else delete overrideMap[cfgId];
          if (typeof window !== 'undefined') window.__cooptScenarioOverride = overrideMap;
        }

        // Switch optical system override to the config under evaluation.
        try {
          if (__lastCfgId !== cfgId) {
            __lastCfgId = cfgId;
            if (__rowsByCfg.has(cfgId)) {
              if (typeof globalThis !== 'undefined') globalThis.__cooptOpticalSystemRowsOverride = __rowsByCfg.get(cfgId);
            } else {
              const blocks = (blocksByConfigId && cfgId) ? blocksByConfigId[cfgId] : null;
              let rows = null;
              if (Array.isArray(blocks)) {
                const expanded = expandBlocksToOpticalSystemRows(blocks);
                rows = (expanded && Array.isArray(expanded.rows)) ? expanded.rows : null;
              }
              __rowsByCfg.set(cfgId, rows);
              if (typeof globalThis !== 'undefined') globalThis.__cooptOpticalSystemRowsOverride = rows;
            }
          }
        } catch (_) {}

        const opObj = {
          operand: r?.operand,
          configId: cfgId,
          param1: r?.param1,
          param2: r?.param2,
          param3: r?.param3,
          param4: r?.param4,
          target: r?.target,
          weight: r?.weight
        };

        const evaluated = computeAmountOrPenalty(r?.op, editor.calculateOperandValue(opObj), r?.target, r?.tol);
        const current = evaluated.current;
        let residualVal = 0;
        const amount = evaluated.amount;
        let worstReason = evaluated.reason;

        if (evaluated.reason !== 'ok' && evaluated.reason !== 'violation') {
          nonFiniteCount++;
          residualVal = sqrtW * nonFiniteResidualPenalty;
        } else {
          residualVal = sqrtW * Math.max(0, amount);
        }

        residuals.push(residualVal);

        // Composite score (linear penalty) and violation lists.
        try {
          if (Number.isFinite(amount) && amount > 0) {
            const entry = {
              id: r?.id,
              operand: r?.operand,
              configId: cfgId,
              scenarioId: sid ? String(sid) : null,
              op: r?.op,
              target: r?.target,
              tol: r?.tol,
              weight: w,
              current,
              amount,
              reason: worstReason
            };

            feasible = false;
            violationScore += w * amount;
            hardViolations.push(entry);
          }
        } catch (_) {}

        const contrib = residualVal * residualVal;
        if (Number.isFinite(contrib) && contrib > worstContribution) {
          worstContribution = contrib;
          worst = {
            itemIndex,
            residual: residualVal,
            contribution: contrib,
            reason: worstReason,
            reqId: r?.id,
            operand: r?.operand,
            op: r?.op,
            target: r?.target,
            tol: r?.tol,
            configId: cfgId,
            scenarioId: sid,
            current,
            amount,
            weight: w,
            param1: r?.param1,
            param2: r?.param2,
            param3: r?.param3,
            param4: r?.param4
          };
        }
        }
      } finally {
        try {
          if (typeof globalThis !== 'undefined') {
            globalThis.__cooptOpticalSystemRowsOverride = __prevOptRows;
          }
        } catch (_) {}
      }

      try {
        // residuals were evaluated in the loop above.
      } finally {
        try {
          if (typeof window !== 'undefined') {
            if (prev && typeof prev === 'object') window.__cooptScenarioOverride = prev;
            else delete window.__cooptScenarioOverride;
          }
        } catch (_) {}
      }

      const cost = norm2Squared(residuals);

      const composite = {
        merit: 0,
        feasible,
        violationScore,
        softPenalty,
        score: violationScore + softPenalty,
        hardViolations,
        softViolations
      };

      try {
        if (typeof window !== 'undefined') {
          const t = Date.now();

          // If the worst residual came from a Spot operand, link it to Spot debug snapshots.
          let spotDebugKey = null;
          let spotDebug = null;
          let isSpotWorst = false;
          try {
            if (worst && worst.operand && String(worst.operand).startsWith('SPOT_SIZE')) {
              isSpotWorst = true;
              spotDebugKey = `operand:${String(worst.operand ?? '')}|cfg:${String(worst.configId ?? '')}`
                + `|p1:${String(worst.param1 ?? '')}|p2:${String(worst.param2 ?? '')}`
                + `|p3:${String(worst.param3 ?? '')}|p4:${String(worst.param4 ?? '')}`;
              const fastByKey = (window.__cooptSpotSizeDebugFastByKey && typeof window.__cooptSpotSizeDebugFastByKey === 'object')
                ? window.__cooptSpotSizeDebugFastByKey
                : null;
              const anyByKey = (window.__cooptSpotSizeDebugByKey && typeof window.__cooptSpotSizeDebugByKey === 'object')
                ? window.__cooptSpotSizeDebugByKey
                : null;
              spotDebug = (fastByKey && spotDebugKey && fastByKey[spotDebugKey])
                ? fastByKey[spotDebugKey]
                : (anyByKey && spotDebugKey && anyByKey[spotDebugKey])
                  ? anyByKey[spotDebugKey]
                  : null;
            }
          } catch (_) {
            isSpotWorst = false;
            spotDebugKey = null;
            spotDebug = null;
          }

          const prevDbg = (window.__cooptLastOptimizerResidualDebug && typeof window.__cooptLastOptimizerResidualDebug === 'object')
            ? window.__cooptLastOptimizerResidualDebug
            : null;
          const shouldForceUpdateForSpot = isSpotWorst && (spotDebugKey && (!prevDbg || prevDbg.spotDebugKey !== spotDebugKey || !prevDbg.spotDebug));
          const shouldUpdate = shouldForceUpdateForSpot || (t - __cooptLastResidualDebugAt >= __cooptResidualDebugThrottleMs);
          if (shouldUpdate) {
            __cooptLastResidualDebugAt = t;
            window.__cooptLastOptimizerResidualDebug = {
              at: t,
              method: 'lm',
              residualCount: residuals.length,
              nonFiniteCount,
              cost,
              worst,
              spotDebugKey,
              spotDebug
            };
          }
        }
      } catch (_) {}
      return { cost, residuals, breakdown: null, composite };
    };

    const evalResidualsNowProfiled = __profile
      ? () => {
        const t = nowMs();
        try {
          __profile.counts.evalResidualsNowCalls++;
          return evalResidualsNow();
        } finally {
          const dt = nowMs() - t;
          __profile.counts.evalResidualsNowMs += dt;
          __profAdd('evalResidualsNow', dt);
        }
      }
      : evalResidualsNow;

    const snapshotX = () => {
      return vars.map(v => ({
        id: v.id,
        value: Number(getJointCurrentValue(jointState, v.id))
      })).filter(e => Number.isFinite(e.value));
    };

    const setX = (x) => {
      for (const e of x) {
        setJointDesignVariableValue(jointState, e.id, e.value);
      }
    };

    const splitVariableId = (variableId) => {
      const id = String(variableId ?? '').trim();
      const dot = id.indexOf('.');
      if (dot <= 0) return { blockId: '', key: '' };
      return { blockId: id.slice(0, dot), key: id.slice(dot + 1) };
    };

    const getScaleForVar = (v) => {
      try {
        const entry = getJointVariableEntry(jointState, v.id);
        const scaleFromEntry = entry?.optimize && Number.isFinite(Number(entry.optimize.scale)) ? Number(entry.optimize.scale) : null;
        const base = scaleFromEntry !== null ? Math.max(1e-30, scaleFromEntry) : defaultScaleForKey(v.key);
        const mag = Math.abs(Number(v.value));
        const s = Math.max(base, Number.isFinite(mag) ? mag : 0);
        return Number.isFinite(s) && s > 0 ? s : base;
      } catch (_) {
        const base = defaultScaleForKey(v?.key);
        const mag = Math.abs(Number(v?.value));
        const s = Math.max(base, Number.isFinite(mag) ? mag : 0);
        return Number.isFinite(s) && s > 0 ? s : base;
      }
    };

    const finiteDifferenceStepForVar = (v) => {
      const x = Number(v.value);
      const absx = Math.abs(x);
      const scale = getScaleForVar(v);

      // Prefer a scaled step so tiny coef vars get a meaningful derivative.
      // Keep relative step too so large radii still use a reasonable perturbation.
      const rel = absx * fdStepFraction;
      const scaled = scale * fdScaledStep;

      // Allow per-variable overrides via optimize.fdStepAbs / optimize.fdStepRel if present.
      try {
        const entry = getJointVariableEntry(jointState, v.id);
        const o = entry?.optimize;
        const absOverride = o && Number.isFinite(Number(o.fdStepAbs)) ? Math.max(0, Number(o.fdStepAbs)) : null;
        const relOverride = o && Number.isFinite(Number(o.fdStepRel)) ? Math.max(0, Number(o.fdStepRel)) : null;
        const rel2 = relOverride !== null ? absx * relOverride : rel;
        const h0 = Math.max(rel2, scaled);
        const h = absOverride !== null ? Math.max(absOverride, h0) : Math.max(fdMinStep, h0);
        return Number.isFinite(h) && h > 0 ? h : Math.max(fdMinStep, 1e-18);
      } catch (_) {
        const h = Math.max(fdMinStep, rel, scaled);
        return Number.isFinite(h) && h > 0 ? h : Math.max(fdMinStep, 1e-18);
      }
    };

    const maybeSave = (_why) => {
      // No-op in multi-config mode: evaluator reads from window.__cooptBlocksOverride.
    };


    let lambda = lmLambda0;
    let completedIterations = 0;
    let best = Infinity;
    let before = Infinity;
    let bestCost = Infinity;
    let trustRegionDeltaEff = trustRegionDelta;
    let bestXSnapshot = null;
    let rejectStreak = 0;
    let restartCount = 0;

    const evalStateLM = () => evalCompositeFromRequirementsProfiled();

    // If a previous run ever set material(V)=AIR, fix it up before starting LM.
    await sanitizeAirMaterialsInDesignIntent({
      activeCfg,
      systemConfig,
      jointState,
      categoricalVars: catVars,
      evalState: evalStateLM,
      onProgress,
      shouldStop,
      multiScenario,
      method: 'lm'
    });

    try {
      const ab = blocksByConfigId[String(activeConfigId)];
      if (Array.isArray(ab)) updateActiveOpticalSystemOverrideFromBlocks(ab);
    } catch (_) {}
    const initial = evalResidualsNowProfiled();
    const initialEval = (initial && initial.composite) ? initial.composite : evalCompositeFromRequirementsProfiled();
    recordEval(initialEval);
    before = initialEval.score;
    best = (getBestEvalSoFar() || initialEval).score;
    bestCost = Number.isFinite(initial?.cost) ? initial.cost : Infinity;
    bestXSnapshot = snapshotX();

    if (initialEval.feasible && before <= 0) {
      if (onProgress) {
        try {
          onProgress({
            phase: 'done',
            iter: 0,
            current: before,
            best,
            method: 'lm',
            multiScenario,
            requirementCount,
            residualCount: Array.isArray(initial?.residuals) ? initial.residuals.length : 0,
            feasible: true,
            violationScore: 0,
            softPenalty: 0,
            ms: 0
          });
        } catch (_) {}
        await nextFrame();
      }

      return {
        ok: true,
        aborted: false,
        before,
        best,
        iterations: 0,
        variables: vars.length,
        method: 'lm',
        feasible: true,
        violationScore: 0,
        softPenalty: 0,
        hardViolations: [],
        softViolations: []
      };
    }

    // Optional: categorical material sweep (discrete) before LM.
    // This keeps LM on numeric vars but allows Material to change.
    if (catVars && catVars.length > 0) {
      const sweep = await runCategoricalMaterialSweep({
        activeCfg,
        systemConfig,
        jointState,
        categoricalVars: catVars,
        evalState: evalStateLM,
        onProgress,
        shouldStop,
        iter: 0,
        multiScenario,
        bestEval: getBestEvalSoFar() || initialEval
      });
      if (sweep && sweep.bestEval) {
        recordEval(sweep.bestEval);
        // Recompute residuals baseline after discrete change.
        const re = evalResidualsNowProfiled();
        const reEval = (re && re.composite) ? re.composite : evalCompositeFromRequirementsProfiled();
        recordEval(reEval);
        before = reEval.score;
        best = (getBestEvalSoFar() || reEval).score;
      }
    }

    // If there are only categorical vars (e.g. Doublet.material1/material2),
    // we can still optimize via discrete sweep.
    if (vars.length === 0) {
      const before0Eval = getBestEvalSoFar() || initialEval;
      const before0 = before;
      let best0 = (getBestEvalSoFar() || before0Eval).score;
      let stall0 = 0;
      let completed0 = 0;

      if (onProgress) {
        try {
          onProgress({
            phase: 'start',
            iter: 0,
            current: before0,
            best: best0,
            method: 'lm',
            multiScenario,
            requirementCount,
            residualCount: Array.isArray(initial?.residuals) ? initial.residuals.length : 0,
            feasible: before0Eval ? before0Eval.feasible : undefined,
            violationScore: before0Eval ? before0Eval.violationScore : undefined,
            softPenalty: before0Eval ? before0Eval.softPenalty : undefined
          });
        } catch (_) {}
        await nextFrame();
      }

      for (let iter = 1; iter <= maxIterations; iter++) {
        if (shouldStop && shouldStop()) break;
        completed0 = iter;

        const sweep = await runCategoricalMaterialSweep({
          activeCfg,
          systemConfig,
          jointState,
          categoricalVars: catVars,
          evalState: evalStateLM,
          onProgress,
          shouldStop,
          iter,
          multiScenario,
          bestEval: getBestEvalSoFar() || before0Eval
        });

        if (sweep && sweep.bestEval) recordEval(sweep.bestEval);

        if (sweep && sweep.changed && sweep.bestEval) {
          best0 = (getBestEvalSoFar() || sweep.bestEval).score;
          stall0 = 0;
        } else {
          stall0++;
          if (!runUntilStopped && stall0 >= stallLimit) break;
        }

        if (iter % logEvery === 0) {
          console.log(`🔁 [OptimizerMVP] iter ${iter}/${maxIterations}`, { method: 'lm(categorical-only)', best: best0 });
        }
      }

      // Final sync to tables
      try {
        const finalEval = getBestEvalSoFar();
        restoreBestSnapshotAndPersist({ finalEval, jointState, systemConfig, configsById, targetConfigIds });
      } catch (_) {}

      try {
        if (window.ConfigurationManager && typeof window.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
          await window.ConfigurationManager.loadActiveConfigurationToTables({
            applyToUI: true,
            suppressOpticalSystemDataChanged: true,
          });
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
      try {
        if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.evaluateAndUpdateNow === 'function') {
          window.systemRequirementsEditor.evaluateAndUpdateNow();
        }
      } catch (_) {}

      const aborted0 = shouldStop ? !!shouldStop() : false;
      const finalEval = getBestEvalSoFar();
      if (onProgress) {
        try {
          onProgress({
            phase: 'done',
            iter: completed0,
            current: best0,
            best: best0,
            method: 'lm',
            multiScenario,
            requirementCount,
            ms: Math.round(nowMs() - t0),
            feasible: finalEval ? finalEval.feasible : true,
            violationScore: finalEval ? finalEval.violationScore : 0,
            softPenalty: finalEval ? finalEval.softPenalty : 0
          });
        } catch (_) {}
        await nextFrame();
      }

      return {
        ok: true,
        aborted: aborted0,
        before: before0,
        best: best0,
        iterations: completed0,
        variables: 0,
        method: 'lm',
        feasible: finalEval ? finalEval.feasible : true,
        violationScore: finalEval ? finalEval.violationScore : 0,
        softPenalty: finalEval ? finalEval.softPenalty : 0,
        hardViolations: finalEval ? finalEval.hardViolations : [],
        softViolations: finalEval ? finalEval.softViolations : []
      };
    }

    if (onProgress) {
      const be = getBestEvalSoFar();
      try {
        onProgress({
          phase: 'start',
          iter: 0,
          current: before,
          best,
          method: 'lm',
          multiScenario,
          requirementCount,
          residualCount: Array.isArray(initial?.residuals) ? initial.residuals.length : 0,
          feasible: be ? be.feasible : undefined,
          violationScore: be ? be.violationScore : undefined,
          softPenalty: be ? be.softPenalty : undefined
        });
      } catch (_) {}
      await nextFrame();
    }

    console.log('🚀 [OptimizerMVP] start', { method: 'lm', vars: vars.length, before, maxIterations, multiScenario });

    let stageIndex = 0;
    let stageNoImprove = 0;
    const lastStageIndex = Math.max(0, stageMaxCoefList.length - 1);

    // User preference: once rho hits 0 (flat/degenerate LM model), do not inject random perturbations.
    let __lmExploreDisabledAfterZeroRho = false;

    for (let iter = 1; iter <= maxIterations; iter++) {
      if (shouldStop && shouldStop()) {
        if (onProgress) {
          try { onProgress({ phase: 'stopped', iter, current: best, best, method: 'lm', multiScenario, requirementCount }); } catch (_) {}
          await nextFrame();
        }
        break;
      }

      completedIterations = iter;

      const curVarsAll = vars.map(v => ({ ...v, value: Number(getJointCurrentValue(jointState, v.id)) }))
        .filter(v => v && typeof v.value === 'number' && Number.isFinite(v.value));
      const maxCoef = stageMaxCoefList[Math.min(stageIndex, lastStageIndex)];
      let curVars = staged
        ? curVarsAll.filter(v => stageAllowsVariable(v.key, maxCoef))
        : curVarsAll;

      // Safety + staging correctness: if the stage filter yields no variables (common when only
      // coef vars are marked V and maxCoef=0), try enabling the lowest-order coef first.
      if (curVars.length === 0 && curVarsAll.length > 0) {
        const relaxedMax = Math.max(1, Number.isFinite(Number(maxCoef)) ? Number(maxCoef) : 1);
        const partial = curVarsAll.filter(v => stageAllowsVariable(v.key, relaxedMax));
        curVars = (partial.length > 0) ? partial : curVarsAll;
      }

      const n = curVars.length;
      const x0 = curVars.map(v => v.value);
      const ids = curVars.map(v => v.id);
      const keys = curVars.map(v => v.key);
      const scales = curVars.map(v => getScaleForVar(v));

      // Evaluate base residuals
      const base = evalResidualsNowProfiled();
      const r0 = base.residuals;
      const m = r0.length;
      const cost0 = base.cost;
      if (!Number.isFinite(cost0)) {
        return { ok: false, reason: 'Requirements residual evaluation returned non-finite value.' };
      }
      const baseEval = (base && base.composite) ? base.composite : evalCompositeFromRequirementsProfiled();
      recordEval(baseEval);
      best = (getBestEvalSoFar() || baseEval).score;
      if (Number.isFinite(cost0) && cost0 < bestCost) bestCost = cost0;

      if (onProgress) {
        try {
          onProgress({
            phase: 'iter',
            iter,
            current: baseEval.score,
            best,
            lambda,
            method: 'lm',
            multiScenario,
            requirementCount,
            residualCount: m,
            feasible: baseEval.feasible,
            violationScore: baseEval.violationScore,
            softPenalty: baseEval.softPenalty,
            bestFeasibleFound: !!bestFeasibleEval,
            stageIndex,
            stageMaxCoef: maxCoef,
            activeVariables: n
          });
        } catch (_) {}
        await nextFrame();
      }

      // Build Jacobian J (m x n) via forward differences.
      if (onProgress) {
        try { onProgress({ phase: 'jacobian', iter, current: baseEval.score, best, lambda, method: 'lm', multiScenario, requirementCount, residualCount: m }); } catch (_) {}
        await nextFrame();
      }

      /** @type {number[][]} */
      const J = Array.from({ length: m }, () => Array(n).fill(0));

      for (let j = 0; j < n; j++) {
        if (shouldStop && shouldStop()) break;

        const xj = x0[j];
        const h = finiteDifferenceStepForVar({ id: ids[j], key: keys[j], value: xj });
        const xPert = x0.slice();
        xPert[j] = xj + h;

        // apply perturbed
        for (let k = 0; k < n; k++) {
          setJointDesignVariableValue(jointState, ids[k], xPert[k]);
        }
        maybeSave('jacobian');

        const br = evalResidualsNowProfiled();
        const r1 = br.residuals;
        const mm = Math.min(m, r1.length);
        for (let i = 0; i < mm; i++) {
          J[i][j] = (r1[i] - r0[i]) / h;
        }
        for (let i = mm; i < m; i++) {
          J[i][j] = 0;
        }

        if (onProgress) {
          try { onProgress({ phase: 'jacobian-col', iter, col: j + 1, cols: n, current: baseEval.score, best, lambda, method: 'lm', multiScenario, requirementCount, residualCount: m }); } catch (_) {}
          await nextFrame();
        }
      }

      // restore x0
      for (let k = 0; k < n; k++) {
        setJointDesignVariableValue(jointState, ids[k], x0[k]);
      }
      maybeSave('jacobian');

      if (shouldStop && shouldStop()) break;

      // Compute normal equations: A = J^T J, g = J^T r
      /** @type {number[][]} */
      const A = Array.from({ length: n }, () => Array(n).fill(0));
      const g = Array(n).fill(0);

      for (let j = 0; j < n; j++) {
        let gj = 0;
        for (let i = 0; i < m; i++) {
          gj += J[i][j] * r0[i];
        }
        g[j] = gj;
      }

      for (let j = 0; j < n; j++) {
        for (let k = 0; k <= j; k++) {
          let s = 0;
          for (let i = 0; i < m; i++) {
            s += J[i][j] * J[i][k];
          }
          A[j][k] = s;
          A[k][j] = s;
        }
      }

      // Damping: A_damped = A + lambda * diag(A) + lambda * I
      /** @type {number[][]} */
      const Ad = A.map((row) => row.slice());
      for (let i = 0; i < n; i++) {
        const d = A[i][i];
        const diag = (Number.isFinite(d) && d > 0) ? d : 1;
        Ad[i][i] = d + lambda * diag + lambda;
      }

      const b = g.map((v) => -v);

      if (onProgress) {
        try { onProgress({ phase: 'solve', iter, current: baseEval.score, best, lambda, method: 'lm', multiScenario, requirementCount, residualCount: m, lmCost: cost0 }); } catch (_) {}
        await nextFrame();
      }

      let dx = solveSymmetricPositiveDefinite(Ad, b);
      if (!dx) dx = solveLinearSystemFallback(Ad, b);
      if (!dx) {
        // increase damping and continue
        lambda *= lmLambdaUp;
        continue;
      }

      // Trust region (scaled): clip dx so max |dx_i/scale_i| <= delta.
      if (trustRegion) {
        let maxAbs = 0;
        for (let i = 0; i < n; i++) {
          const si = scales[i] || 1;
          const di = dx[i] / si;
          const a = Math.abs(di);
          if (a > maxAbs) maxAbs = a;
        }
        const delta = trustRegionDeltaEff;
        if (Number.isFinite(maxAbs) && maxAbs > delta && maxAbs > 0) {
          const f = delta / maxAbs;
          for (let i = 0; i < n; i++) dx[i] *= f;
        }
      }

      // Detect a near-zero step in scaled coordinates.
      let dxScaledMaxAbs = 0;
      for (let i = 0; i < n; i++) {
        const si = scales[i] || 1;
        const di = dx[i] / si;
        const a = Math.abs(di);
        if (a > dxScaledMaxAbs) dxScaledMaxAbs = a;
      }
      const flatLmStep = !(Number.isFinite(dxScaledMaxAbs)) || dxScaledMaxAbs < 1e-12;

      const exploreThisIter = (lmExploreWhenFlat && flatLmStep && !__lmExploreDisabledAfterZeroRho);

      const makeRandomStep = (alpha) => {
        const step = new Array(n);
        const baseDelta = trustRegion ? trustRegionDeltaEff : 0.2;
        const maxScaled = Math.max(1e-12, Math.min(1.0, Number(alpha) || 1) * baseDelta);
        for (let i = 0; i < n; i++) {
          const si = scales[i] || 1;
          const u = (Math.random() * 2 - 1);
          step[i] = u * maxScaled * si;
        }
        return step;
      };

      const defaultAlphas = backtracking
        ? Array.from({ length: backtrackingMaxTries }, (_, i) => Math.pow(0.5, i))
        : [1];
      const alphas = exploreThisIter
        ? Array.from({ length: Math.max(1, lmExploreTries) }, (_, i) => defaultAlphas[Math.min(i, defaultAlphas.length - 1)] ?? 1)
        : defaultAlphas;

      let accepted = false;
      let acceptedEval = null;
      let acceptedCost = Infinity;
      let acceptedAlpha = 1;
      let acceptedRho = 0;

      const predictedReductionForStep = (dxStep) => {
        // Predicted decrease for the *same* objective as `cost = ||r||^2`.
        // For the LM damped quadratic model with SPD matrix Ad:
        //   phi = 0.5||r||^2, model reduction ≈ 0.5 * dx^T Ad dx  (always >= 0)
        // Therefore for cost (=2*phi), predicted reduction is:
        //   predCost = dx^T Ad dx
        try {
          let dxAdx = 0;
          for (let i = 0; i < n; i++) {
            let s = 0;
            for (let k = 0; k < n; k++) s += Ad[i][k] * dxStep[k];
            dxAdx += dxStep[i] * s;
          }
          return Number.isFinite(dxAdx) ? dxAdx : NaN;
        } catch (_) {
          return NaN;
        }
      };

      for (const alpha of alphas) {
        const dxStep = exploreThisIter ? makeRandomStep(alpha) : dx.map(v => alpha * v);
        // Candidate x
        const xCand = x0.map((v, i) => v + dxStep[i]);
        for (let k = 0; k < n; k++) {
          setJointDesignVariableValue(jointState, ids[k], xCand[k]);
        }
        maybeSave('candidate');

        const cand = evalResidualsNowProfiled();
        const cost1 = cand.cost;
        const candEval = (cand && cand.composite) ? cand.composite : evalCompositeFromRequirementsProfiled();

        const pred = predictedReductionForStep(dxStep);
        const act = (Number.isFinite(cost0) && Number.isFinite(cost1)) ? (cost0 - cost1) : NaN;
        const rho = (Number.isFinite(act) && Number.isFinite(pred) && pred > 1e-30) ? (act / pred) : 0;

        if (onProgress) {
          try {
            onProgress({
              phase: 'candidate',
              iter,
              current: candEval.score,
              best,
              lambda,
              method: 'lm',
              multiScenario,
              requirementCount,
              residualCount: m,
              feasible: candEval.feasible,
              violationScore: candEval.violationScore,
              softPenalty: candEval.softPenalty,
              alpha,
              rho,
              stageIndex,
              stageMaxCoef: maxCoef
            });
          } catch (_) {}
          await nextFrame();
        }

        // Accept based on the LM objective we actually minimized (squared residual cost).
        // Use rho only for damping adaptation; do not reject true improvements.
        const improved = Number.isFinite(cost1) && (cost1 < cost0);
        if (improved) {
          accepted = true;
          acceptedEval = candEval;
          acceptedCost = cost1;
          acceptedAlpha = alpha;
          acceptedRho = rho;
          break;
        }

        // Restore before trying smaller alpha
        for (let k = 0; k < n; k++) {
          setJointDesignVariableValue(jointState, ids[k], x0[k]);
        }
        maybeSave('restore');
      }

      if (accepted && acceptedEval) {
        recordEval(acceptedEval);
        const bestBefore = best;
        best = (getBestEvalSoFar() || acceptedEval).score;
        const costBefore = bestCost;
        if (Number.isFinite(acceptedCost) && acceptedCost < bestCost) bestCost = acceptedCost;
        if (Number.isFinite(acceptedCost) && acceptedCost <= bestCost) {
          bestXSnapshot = snapshotX();
        }

        rejectStreak = 0;

        // Adaptive trust region: if rho is high, allow larger steps; otherwise decay back to base.
        // This is especially helpful for spot-size hinge constraints where the quadratic model is
        // only reliable intermittently.
        if (trustRegion) {
          if (acceptedRho > 0.75) {
            trustRegionDeltaEff = Math.min(trustRegionDeltaMax, Math.max(trustRegionDelta, trustRegionDeltaEff * 1.25));
          } else if (acceptedRho > 0.25) {
            trustRegionDeltaEff = Math.min(trustRegionDeltaMax, Math.max(trustRegionDelta, trustRegionDeltaEff * 1.05));
          } else {
            trustRegionDeltaEff = Math.max(trustRegionDelta, trustRegionDeltaEff * 0.95);
          }
        }

        // Adaptive lambda update based on gain ratio.
        // High rho => model predicted well => reduce lambda more.
        // Medium rho => keep lambda roughly.
        const downSqrt = Math.sqrt(Math.max(1e-6, lmLambdaDown));
        const factor = (acceptedRho > 0.75) ? lmLambdaDown
          : (acceptedRho > 0.25) ? downSqrt
            : 1;
        lambda = Math.max(1e-18, lambda * factor);

        // Once rho is 0 (degenerate/flat model), permanently disable random exploration steps.
        // This matches the requested behavior: no perturbation after rho=0.
        if (!__lmExploreDisabledAfterZeroRho && Number.isFinite(acceptedRho) && acceptedRho === 0) {
          __lmExploreDisabledAfterZeroRho = true;
        }
        // Drive continuation on the LM objective (cost), not the composite linear score.
        stageNoImprove = (bestCost < costBefore) ? 0 : (stageNoImprove + 1);

        if (onProgress) {
          try {
            onProgress({
              phase: 'accept',
              iter,
              current: acceptedEval.score,
              best,
              lambda,
              method: 'lm',
              multiScenario,
              requirementCount,
              residualCount: m,
              feasible: acceptedEval.feasible,
              violationScore: acceptedEval.violationScore,
              softPenalty: acceptedEval.softPenalty,
              alpha: acceptedAlpha,
              rho: acceptedRho,
              stageIndex,
              stageMaxCoef: maxCoef
            });
          } catch (_) {}
          await nextFrame();
        }
      } else {
        // Reject: ensure we are restored and increase damping.
        for (let k = 0; k < n; k++) {
          setJointDesignVariableValue(jointState, ids[k], x0[k]);
        }
        maybeSave('reject');

        lambda *= lmLambdaUp;
        stageNoImprove++;
        rejectStreak++;

        if (trustRegion) {
          // On rejection, shrink toward base (but never below the base delta).
          trustRegionDeltaEff = Math.max(trustRegionDelta, trustRegionDeltaEff * 0.9);
        }

        // If we're stuck rejecting, try a controlled restart: restore best state and jitter coef vars.
        if (
          restartMaxCount > 0
          && restartJitterScaled > 0
          && rejectStreak >= restartOnRejectStreak
          && restartCount < restartMaxCount
          && bestXSnapshot
        ) {
          restartCount++;
          rejectStreak = 0;
          stageNoImprove = 0;
          lambda = lmLambda0;
          trustRegionDeltaEff = trustRegionDelta;

          try {
            setX(bestXSnapshot);
          } catch (_) {
            try {
              for (const e of bestXSnapshot) setJointDesignVariableValue(jointState, e.id, e.value);
            } catch (_) {}
          }

          const varsNow = vars.map(v => ({ ...v, value: Number(getJointCurrentValue(jointState, v.id)) }))
            .filter(v => v && typeof v.value === 'number' && Number.isFinite(v.value));
          const coefLike = (v) => {
            const k = String(v?.key ?? '');
            return /^coef\d+$/i.test(k) || /^asphcoef\d+$/i.test(k) || k.toLowerCase().includes('coef');
          };
          const maxCoefNow = stageMaxCoefList[Math.min(stageIndex, lastStageIndex)];
          const stageAllowed = varsNow.filter(v => (!staged || stageAllowsVariable(v.key, maxCoefNow)));
          const coefCandidates = stageAllowed.filter(v => coefLike(v));
          const jitterable = (coefCandidates.length > 0) ? coefCandidates : stageAllowed;
          for (const v of jitterable) {
            const scale = getScaleForVar(v);
            const u = (Math.random() * 2 - 1);
            const dv = u * restartJitterScaled * scale;
            const next = Number(v.value) + dv;
            if (Number.isFinite(next)) setJointDesignVariableValue(jointState, v.id, next);
          }
          maybeSave('restart');

          if (onProgress) {
            try {
              const rr = evalResidualsNowProfiled();
              const ee = (rr && rr.composite) ? rr.composite : evalCompositeFromRequirementsProfiled();
              onProgress({
                phase: 'restart',
                iter,
                current: ee.score,
                best,
                lambda,
                method: 'lm',
                multiScenario,
                requirementCount,
                residualCount: Array.isArray(rr?.residuals) ? rr.residuals.length : undefined,
                stageIndex,
                stageMaxCoef: maxCoefNow,
                activeVariables: jitterable.length,
                restartCount
              });
            } catch (_) {}
            await nextFrame();
          }
        }
        if (onProgress) {
          try {
            onProgress({
              phase: 'reject',
              iter,
              current: baseEval.score,
              best,
              lambda,
              method: 'lm',
              multiScenario,
              requirementCount,
              residualCount: m,
              feasible: baseEval.feasible,
              violationScore: baseEval.violationScore,
              softPenalty: baseEval.softPenalty,
              stageIndex,
              stageMaxCoef: maxCoef
            });
          } catch (_) {}
          await nextFrame();
        }
      }

      // Stage advancement on stall (continuation): if we are not improving, unlock more coef.
      if (staged && stageIndex < lastStageIndex && stageNoImprove >= stageStallLimit) {
        stageIndex++;
        stageNoImprove = 0;
        if (onProgress) {
          try {
            onProgress({
              phase: 'stage',
              iter,
              current: best,
              best,
              lambda,
              method: 'lm',
              multiScenario,
              requirementCount,
              stageIndex,
              stageMaxCoef: stageMaxCoefList[Math.min(stageIndex, lastStageIndex)]
            });
          } catch (_) {}
          await nextFrame();
        }
      }

      if (iter % logEvery === 0) {
        console.log(`🔁 [OptimizerMVP] iter ${iter}/${maxIterations}`, { method: 'lm', best, lambda });
      }
    }

    // Final sync to tables (push expanded rows into Tabulator without requiring a reload)
    try {
      const finalEval = getBestEvalSoFar();
      restoreBestSnapshotAndPersist({ finalEval, jointState, systemConfig, configsById, targetConfigIds });
    } catch (_) {}

    try {
      if (window.ConfigurationManager && typeof window.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
        await window.ConfigurationManager.loadActiveConfigurationToTables({
          applyToUI: true,
          suppressOpticalSystemDataChanged: true,
        });
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
    try {
      if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.evaluateAndUpdateNow === 'function') {
        window.systemRequirementsEditor.evaluateAndUpdateNow();
      }
    } catch (_) {}

    const t1 = nowMs();
    console.log('✅ [OptimizerMVP] done', { method: 'lm', before, best, ms: Math.round(t1 - t0) });

    if (onProgress) {
      const finalEval = getBestEvalSoFar();
      try {
        onProgress({
          phase: 'done',
          iter: completedIterations,
          current: best,
          best,
          method: 'lm',
          multiScenario,
          requirementCount,
          ms: Math.round(t1 - t0),
          feasible: finalEval ? finalEval.feasible : true,
          violationScore: finalEval ? finalEval.violationScore : 0,
          softPenalty: finalEval ? finalEval.softPenalty : 0
        });
      } catch (_) {}
      await nextFrame();
    }

    const aborted = shouldStop ? !!shouldStop() : false;
    const finalEval = getBestEvalSoFar();
    return {
      ok: true,
      aborted,
      before,
      best,
      iterations: completedIterations,
      variables: vars.length,
      method: 'lm',
      feasible: finalEval ? finalEval.feasible : true,
      violationScore: finalEval ? finalEval.violationScore : 0,
      softPenalty: finalEval ? finalEval.softPenalty : 0,
      hardViolations: finalEval ? finalEval.hardViolations : [],
      softViolations: finalEval ? finalEval.softViolations : []
    };
    } finally {
      try {
        if (typeof globalThis !== 'undefined') {
          globalThis.__cooptOpticalSystemRowsOverride = __prevOpticalSystemRowsOverride;
        }
      } catch (_) {}
    }
  }

  // Coordinate descent mode (legacy MVP)

  // Per-variable step sizes
  const stepById = new Map();
  for (const v of vars) {
    stepById.set(v.id, initialStepForValue(v.value, stepFraction, minStep));
  }

  const t0 = nowMs();
  const evalStateCD = () => evalCompositeFromRequirementsProfiled();

  // If a previous run ever set material(V)=AIR, fix it up before starting CD.
  await sanitizeAirMaterialsInDesignIntent({
    activeCfg,
    systemConfig,
    jointState,
    categoricalVars: catVars,
    evalState: evalStateCD,
    onProgress,
    shouldStop,
    multiScenario,
    method: 'cd'
  });

  // If there are only categorical vars, we can still optimize via discrete sweep.
  if (vars.length === 0) {
    const before0Eval = evalStateCD();
    recordEval(before0Eval);
    const before0 = before0Eval.score;
    let best0 = (getBestEvalSoFar() || before0Eval).score;
    let stall0 = 0;
    let completed0 = 0;

    if (onProgress) {
      try { onProgress({ phase: 'start', iter: 0, current: before0, best: best0, multiScenario, method: 'cd', feasible: before0Eval.feasible, violationScore: before0Eval.violationScore, softPenalty: before0Eval.softPenalty }); } catch (_) {}
      await nextFrame();
    }

    for (let iter = 1; iter <= maxIterations; iter++) {
      if (shouldStop && shouldStop()) break;
      completed0 = iter;

      const sweep = await runCategoricalMaterialSweep({
        activeCfg,
        systemConfig,
        jointState,
        categoricalVars: catVars,
        evalState: evalStateCD,
        onProgress,
        shouldStop,
        iter,
        multiScenario,
        bestEval: getBestEvalSoFar() || before0Eval
      });
      if (sweep && sweep.bestEval) {
        recordEval(sweep.bestEval);
        best0 = (getBestEvalSoFar() || sweep.bestEval).score;
        stall0 = 0;
      } else {
        stall0++;
        if (!runUntilStopped && stall0 >= stallLimit) break;
      }
    }

    // Final sync to tables
    try {
      if (window.ConfigurationManager && typeof window.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
        await window.ConfigurationManager.loadActiveConfigurationToTables({
          applyToUI: true,
          suppressOpticalSystemDataChanged: true,
        });
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
    try {
      if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.evaluateAndUpdateNow === 'function') {
        window.systemRequirementsEditor.evaluateAndUpdateNow();
      }
    } catch (_) {}

    const aborted0 = shouldStop ? !!shouldStop() : false;
    const finalEval = getBestEvalSoFar();
    // Ensure final state
    try {
      restoreBestSnapshotAndPersist({ finalEval, jointState, systemConfig, configsById, targetConfigIds });
    } catch (_) {}
    return {
      ok: true,
      aborted: aborted0,
      before: before0,
      best: best0,
      iterations: completed0,
      variables: 0,
      method: 'cd',
      feasible: finalEval ? finalEval.feasible : true,
      violationScore: finalEval ? finalEval.violationScore : 0,
      softPenalty: finalEval ? finalEval.softPenalty : 0,
      hardViolations: finalEval ? finalEval.hardViolations : [],
      softViolations: finalEval ? finalEval.softViolations : []
    };
  }

  const beforeEval = evalStateCD();
  recordEval(beforeEval);
  const before = beforeEval.score;
  let best = (getBestEvalSoFar() || beforeEval).score;

  if (onProgress) {
    try {
      onProgress({ phase: 'start', iter: 0, current: before, best, multiScenario, feasible: beforeEval.feasible, violationScore: beforeEval.violationScore, softPenalty: beforeEval.softPenalty });
    } catch (_) {}
    await nextFrame();
  }

  let stall = 0;
  let completedIterations = 0;

  console.log('🚀 [OptimizerMVP] start', { method: 'cd', vars: vars.length, before, maxIterations, stepFraction, minStep, multiScenario });

  if (shouldStop && shouldStop()) {
    if (onProgress) {
      try { onProgress({ phase: 'stopped', iter: 0, current: before, best, multiScenario }); } catch (_) {}
      await nextFrame();
    }
    const finalEval = getBestEvalSoFar();
    return {
      ok: true,
      aborted: true,
      before,
      best,
      iterations: 0,
      variables: vars.length,
      method: 'cd',
      feasible: finalEval ? finalEval.feasible : true,
      violationScore: finalEval ? finalEval.violationScore : 0,
      softPenalty: finalEval ? finalEval.softPenalty : 0,
      hardViolations: finalEval ? finalEval.hardViolations : [],
      softViolations: finalEval ? finalEval.softViolations : []
    };
  }

  for (let iter = 1; iter <= maxIterations; iter++) {
    if (shouldStop && shouldStop()) {
      if (onProgress) {
        try { onProgress({ phase: 'stopped', iter, current: best, best, multiScenario }); } catch (_) {}
        await nextFrame();
      }
      break;
    }

    completedIterations = iter;

    let improvedThisIter = false;

    // Discrete sweep for Material variables (if any)
    if (catVars && catVars.length > 0) {
      const sweep = await runCategoricalMaterialSweep({
        activeCfg,
        systemConfig,
        jointState,
        categoricalVars: catVars,
        evalState: evalStateCD,
        onProgress,
        shouldStop,
        iter,
        multiScenario,
        bestEval: getBestEvalSoFar() || beforeEval
      });
      if (sweep && sweep.changed && sweep.bestEval) {
        recordEval(sweep.bestEval);
        best = (getBestEvalSoFar() || sweep.bestEval).score;
        improvedThisIter = true;
      }
    }

    // Refresh variable list each outer iter (in case user toggled flags mid-run)
    const curJointVars = enumerateJointVariables({ targetConfigIds, blocksByConfigId, activeConfigId });
    const curVars = (Array.isArray(curJointVars.numeric) ? curJointVars.numeric : [])
      .map(coerceBlankAsphereToZero)
      .filter(v => v && typeof v.value === 'number' && Number.isFinite(v.value));

    for (const v of curVars) {
      if (shouldStop && shouldStop()) {
        if (onProgress) {
          try { onProgress({ phase: 'stopped', iter, variableId: v.id, current: best, best, multiScenario }); } catch (_) {}
          await nextFrame();
        }
        break;
      }

      const step0 = stepById.has(v.id) ? stepById.get(v.id) : initialStepForValue(v.value, stepFraction, minStep);
      let step = step0;

      const baseValue = v.value;
      let bestLocalValue = baseValue;
      const baseEvalVar = evalStateCD();
      let bestLocalEval = baseEvalVar;

      const candidates = [baseValue + step, baseValue - step];
      for (const cand of candidates) {
        if (shouldStop && shouldStop()) {
          if (onProgress) {
            try { onProgress({ phase: 'stopped', iter, variableId: v.id, current: best, best, multiScenario }); } catch (_) {}
            await nextFrame();
          }
          break;
        }

        if (!Number.isFinite(cand)) continue;

        const okSet = setJointDesignVariableValue(jointState, v.id, cand);
        if (!okSet) continue;

        const e = evalStateCD();

        if (onProgress) {
          try {
            onProgress({
              phase: 'candidate',
              iter,
              variableId: v.id,
              baseValue,
              candidateValue: cand,
              current: e.score,
              best,
              multiScenario,
              feasible: e.feasible,
              violationScore: e.violationScore,
              softPenalty: e.softPenalty
            });
          } catch (_) {}
          await nextFrame();
        }

        if (compareEval(e, bestLocalEval)) {
          bestLocalEval = e;
          bestLocalValue = cand;
        }
      }

      if (shouldStop && shouldStop()) {
        // Break out after candidate loop
        break;
      }

      if (compareEval(bestLocalEval, baseEvalVar)) {
        // Accept improvement
        setJointDesignVariableValue(jointState, v.id, bestLocalValue);

        recordEval(bestLocalEval);
        best = (getBestEvalSoFar() || bestLocalEval).score;
        improvedThisIter = true;

        if (onProgress) {
          try {
            onProgress({
              phase: 'accept',
              iter,
              variableId: v.id,
              acceptedValue: bestLocalValue,
              current: best,
              best,
              multiScenario,
              feasible: bestLocalEval.feasible,
              violationScore: bestLocalEval.violationScore,
              softPenalty: bestLocalEval.softPenalty
            });
          } catch (_) {}
          await nextFrame();
        }
        // Keep step (or slightly grow later if desired)
      } else {
        // Restore and shrink step
        setJointDesignVariableValue(jointState, v.id, baseValue);

        step = Math.max(minStep, step0 * stepDecay);
        stepById.set(v.id, step);

        if (onProgress) {
          try {
            onProgress({
              phase: 'reject',
              iter,
              variableId: v.id,
              current: best,
              best,
              multiScenario,
              feasible: baseEvalVar.feasible,
              violationScore: baseEvalVar.violationScore,
              softPenalty: baseEvalVar.softPenalty
            });
          } catch (_) {}
          await nextFrame();
        }
      }
    }

    if (shouldStop && shouldStop()) {
      break;
    }

    if (iter % logEvery === 0) {
      console.log(`🔁 [OptimizerMVP] iter ${iter}/${maxIterations}`, { best, improved: improvedThisIter, stall });
    }

    if (improvedThisIter) {
      stall = 0;
    } else {
      stall++;
      if (!runUntilStopped) {
        // Stop early if we are stalling and steps are tiny
        let allTiny = true;
        for (const s of stepById.values()) {
          if (s > minStep * 1.01) {
            allTiny = false;
            break;
          }
        }
        if (stall >= stallLimit || allTiny) {
          break;
        }
      }
    }
  }

  // Final sync to tables (expanded surface table etc.)
  try {
    const finalEval = getBestEvalSoFar();
    restoreBestSnapshotAndPersist({ finalEval, jointState, systemConfig, configsById, targetConfigIds });
  } catch (_) {}

  try {
    if (window.ConfigurationManager && typeof window.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
      await window.ConfigurationManager.loadActiveConfigurationToTables({
        applyToUI: true,
        suppressOpticalSystemDataChanged: true,
      });
    }
  } catch (_) {}

  try {
    if (typeof window.refreshBlockInspector === 'function') window.refreshBlockInspector();
  } catch (_) {}

  try {
    // Update UI once at the end
    if (window.meritFunctionEditor && typeof window.meritFunctionEditor.calculateMerit === 'function') {
      window.meritFunctionEditor.calculateMerit();
    }
  } catch (_) {}
  try {
    if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.evaluateAndUpdateNow === 'function') {
      window.systemRequirementsEditor.evaluateAndUpdateNow();
    }
  } catch (_) {}

  const t1 = nowMs();
  console.log('✅ [OptimizerMVP] done', { method: 'cd', before, best, ms: Math.round(t1 - t0) });

  if (onProgress) {
    try {
      const finalEval = getBestEvalSoFar();
      onProgress({ phase: 'done', iter: completedIterations, current: best, best, multiScenario, ms: Math.round(t1 - t0), feasible: finalEval ? finalEval.feasible : true, violationScore: finalEval ? finalEval.violationScore : 0, softPenalty: finalEval ? finalEval.softPenalty : 0 });
    } catch (_) {}
    await nextFrame();
  }

  const aborted = shouldStop ? !!shouldStop() : false;
  const finalEval = getBestEvalSoFar();
  return {
    ok: true,
    aborted,
    before,
    best,
    iterations: completedIterations,
    variables: vars.length,
    method: 'cd',
    feasible: finalEval ? finalEval.feasible : true,
    violationScore: finalEval ? finalEval.violationScore : 0,
    softPenalty: finalEval ? finalEval.softPenalty : 0,
    hardViolations: finalEval ? finalEval.hardViolations : [],
    softViolations: finalEval ? finalEval.softViolations : []
  };
  } finally {
    // Always restore global overrides, even on early return/errors.
    try {
      if (typeof window !== 'undefined') {
        if (__prevBlocksOverride !== undefined) window.__cooptBlocksOverride = __prevBlocksOverride;
        else {
          try { delete window.__cooptBlocksOverride; } catch (_) {}
        }
      }
    } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined') {
        globalThis.__cooptOpticalSystemRowsOverride = __prevOpticalRowsOverride;
      }
    } catch (_) {}
    try {
      if (typeof window !== 'undefined') {
        if (__prevScenarioOverride && typeof __prevScenarioOverride === 'object') window.__cooptScenarioOverride = __prevScenarioOverride;
        else {
          try { delete window.__cooptScenarioOverride; } catch (_) {}
        }
      }
    } catch (_) {}

    try {
      if (typeof globalThis !== 'undefined') {
        if (__prevMeritFastMode !== undefined) globalThis.__cooptMeritFastMode = __prevMeritFastMode;
        else {
          try { delete globalThis.__cooptMeritFastMode; } catch (_) {}
        }
      }
    } catch (_) {}

    try {
      if (typeof globalThis !== 'undefined') {
        if (__prevDisableRayTraceDebug !== undefined) globalThis.__COOPT_DISABLE_RAYTRACE_DEBUG = __prevDisableRayTraceDebug;
        else {
          try { delete globalThis.__COOPT_DISABLE_RAYTRACE_DEBUG; } catch (_) {}
        }
      }
    } catch (_) {}

    // Always restore operand evaluator hook.
    try {
      if (__prevCalcOperandValue && editor && typeof editor.calculateOperandValue === 'function') {
        editor.calculateOperandValue = __prevCalcOperandValue;
      }
    } catch (_) {}

    // Always restore the profile context.
    try {
      if (typeof globalThis !== 'undefined') {
        if (__prevOptimizerProfileContext !== undefined) globalThis.__cooptOptimizerProfileContext = __prevOptimizerProfileContext;
        else {
          try { delete globalThis.__cooptOptimizerProfileContext; } catch (_) {}
        }
      }
    } catch (_) {}

    // Persist + print profile summary.
    try {
      const aborted = shouldStop ? !!shouldStop() : false;
      if (!__profileEmitted) __emitProfileSummary({ ok: true, aborted });
    } catch (_) {
      try { if (!__profileEmitted) __emitProfileSummary(null); } catch (_) {}
    }
  }
}

// Global entrypoint (console-driven)
if (typeof window !== 'undefined') {
  window.OptimizationMVP = {
    run: runOptimizationMVP,
    stop: () => { __optimizerStopRequested = true; }
  };
}
