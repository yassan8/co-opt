/**
 * MVP optimizer (coordinate descent) for Blocks-based design variables.
 *
 * - Variables are defined in Blocks: variables[*].optimize.mode === 'V'
 * - Values are applied to blocks.parameters[*] (canonical)
 * - Objective is derived from System Requirements (hard/soft, all-scenarios)
 *
 * No UI is added; the entrypoint is exposed as window.OptimizationMVP.
 */

import { expandBlocksToOpticalSystemRows } from '../data/block-schema.ts';
import { listDesignVariablesFromBlocks, setDesignVariableValue } from './design-variables.ts';
import { getGlassDataWithSellmeier } from '../data/glass.ts';

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
    // Supports Lens (front/back), cemented elements (surfN*), and standard optical notation (a4, a6, ...).
    if (s === '') {
      if (
        /^(front|back)coef\d+$/i.test(key) ||
        /^coef\d+$/i.test(key) ||
        /^surf\d+coef\d+$/i.test(key) ||
        /^(front|back)?a\d+$/i.test(key) ||
        /^surf\d+a\d+$/i.test(key)
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

    // Treat INF (infinite radius) as curvature 0 (flat surface) for radius parameters.
    // This allows optimization to start from a flat surface: Radius=∞ → Curvature=0.
    if (/^inf(inity)?$/i.test(s)) {
      if (
        /^(front|back)radius$/i.test(key) ||
        /^radius$/i.test(key) ||
        /^surf\d+radius$/i.test(key)
      ) {
        // Note: We return radius=0 as a placeholder. The optimizer will need special
        // handling to convert between radius and curvature when applying values.
        // For now, we mark INF radius as non-optimizable by NOT converting it.
        // Users should manually set a numeric value before optimizing.
        return v;
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
    // Lens blocks: support both coef notation and standard optical notation (a4, a6, ...)
    if (/^(front|back)coef\d+$/i.test(key) || /^coef\d+$/i.test(key) || 
        /^(front|back)?a\d+$/i.test(key)) return { ...v, value: 0 };
    if (/^(front|back)conic$/i.test(key) || /^conic$/i.test(key)) return { ...v, value: 0 };

    // Multi-surface blocks (Doublet/Triplet): surf1Coef1, surf2Conic, surf1A4, surf2A6, ...
    if (/^surf\d+coef\d+$/i.test(key) || /^surf\d+a\d+$/i.test(key)) return { ...v, value: 0 };
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

      // REMOVED: Default safety clamp for asphere coefficients
      // User requested unrestricted optimization for aspherical coefficients (A4-A22)
      // If explicit min/max bounds are set, they will be respected above
      // If clampAbsMax is set in optimize options, users can still apply custom limits

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
      return 'No design variables are marked as variable (V). Open a Block in “Design Intent” and check “Optimize” for numeric parameters (e.g. frontRadius/backRadius/centerThickness, Gap.thickness, Stop.semiDiameter).';
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
  
  // Support multiple naming conventions for aspheric coefficients:
  // - coef1, coef2, ... (legacy)
  // - a4, a6, a8, a10, ... (standard optical notation, r^4, r^6, r^8, r^10)
  // - A4, A6, A8, A10, ... (uppercase variant)
  // - frontCoef1, backCoef1, surf1Coef1, etc.
  
  // Try standard optical notation: a4, a6, a8, a10, ...
  let m = s.match(/a(\d+)$/i);
  if (m) {
    const power = Number(m[1]);
    if (!Number.isFinite(power) || power % 2 !== 0) return null; // Must be even power
    // Convert power to coefficient index: a4 → idx=2, a6 → idx=3, a8 → idx=4, ...
    return power / 2;
  }
  
  // Try legacy notation: coef1, coef2, ...
  m = s.match(/coef(\d+)$/i);
  if (m) {
    const idx = Number(m[1]);
    if (!Number.isFinite(idx)) return null;
    return idx;
  }
  
  return null;
}

function isAsphereCoefKey(key) {
  return parseCoefIndexFromKey(key) !== null;
}

function defaultScaleForKey(key) {
  const s = String(key ?? '').trim();
  if (!s) return 1;
  if (isAsphereCoefKey(s)) {
    const idx = parseCoefIndexFromKey(s);
    // Heuristic scale for polynomial coefficients used in aspheric surfaces.
    // 
    // EVEN ASPHERE (default):
    //   coef1→A4(r⁴), coef2→A6(r⁶), coef3→A8(r⁸), ..., coef10→A22(r²²)
    //   Formula: r^(2*idx+2)
    //   Typical values: A4~1e-4, A6~1e-6, A8~1e-8, A10~1e-10, ...
    // 
    // ODD ASPHERE:
    //   coef1→A3(r³), coef2→A5(r⁵), coef3→A7(r⁷), ..., coef10→A21(r²¹)
    //   Formula: r^(2*idx+1)
    //   Typical values: A3~1e-3, A5~1e-5, A7~1e-7, A9~1e-9, ...
    // 
    // Note: Optimizer doesn't know even/odd mode at this point,
    // so we use even asphere scaling as default (more common).
    // For odd asphere, scales will be slightly off but still reasonable.
    // 
    // Scaling strategy: match typical coefficient magnitudes to make scaled values ~1.0
    // 
    // IMPROVEMENT: For higher-order terms (idx > 6), use slightly larger scale
    // to improve numerical stability and convergence during optimization.
    if (idx === null) return 1e-12;
    
    // Default to even asphere formula: r^(2*idx+2)
    const power = 2 * (idx + 1);  // idx=1→4, idx=2→6, idx=7→14, idx=8→16
    let exp = -power;              // base scale exponent
    
    // For higher-order terms (idx > 6: A14+), increase scale for better convergence
    if (idx > 6) {
      exp += 2;  // e.g., A14: 1e-14 → 1e-12, A16: 1e-16 → 1e-14
    }
    
    const sc = Math.pow(10, exp);
    return (Number.isFinite(sc) && sc > 0) ? sc : 1e-20;  // fallback for very high orders
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
  // Default continuation schedule for aspheric coefficients: unlock higher orders progressively.
  // Current system uses coef1=A4(r^4), coef2=A6(r^6), coef3=A8(r^8), ...
  // REVISED schedule: more gradual progression to improve convergence for higher-order terms
  // ALL stages optimize: conic, radius, thickness, and other non-coefficient parameters
  // Stage 0: idx ≤ 0 → conic + radius + thickness + etc. (NO aspheric coefficients)
  //          Quick base curvature optimization
  // Stage 1: idx ≤ 2 → above + coef1-2 (A4, A6) - most important low-order terms
  // Stage 2: idx ≤ 4 → above + coef3-4 (A8, A10) - mid-low order
  // Stage 3: idx ≤ 6 → above + coef5-6 (A12, A14) - mid-high order
  // Stage 4: idx ≤ 10 → above + coef7-10 (A16-A22) - highest order terms
  return [0, 2, 4, 6, 10];
}

function stageAllowsVariable(varKey, maxCoefIndex) {
  const idx = parseCoefIndexFromKey(varKey);
  // null means non-coefficient variable (conic, radius, thickness, etc.)
  // These are always enabled in all stages to ensure proper optimization
  // Stage 0 will optimize: conic + radius + thickness + other non-coef params
  // Stage 1+ will additionally optimize: aspheric coefficients up to maxCoefIndex
  if (idx === null) return true; // conic and other non-coef always enabled
  const maxIdx = Number.isFinite(Number(maxCoefIndex)) ? Number(maxCoefIndex) : 10;
  return idx <= maxIdx;
}

/**
 * Initialize aspheric coefficients to zero to avoid local minima.
 * This is called at the start of optimization if resetAsphericCoefficients option is enabled.
 * @param {object} params - {configsById, targetConfigIds}
 * @returns {number} - count of coefficients reset
 */
function resetAsphericCoefficientsToZero({ configsById, targetConfigIds }) {
  let resetCount = 0;
  const targetIds = Array.isArray(targetConfigIds) ? targetConfigIds : [];
  
  for (const [configId, cfg] of Object.entries(configsById || {})) {
    if (targetIds.length > 0 && !targetIds.includes(Number(configId))) continue;
    const blocks = cfg?.blocks || [];
    
    for (const blk of blocks) {
      // Reset aspheric coefficients in block parameters
      if (blk.parameters) {
        for (let i = 1; i <= 10; i++) {
          const key = `frontCoef${i}`;
          if (key in blk.parameters) {
            blk.parameters[key] = 0;
            resetCount++;
          }
        }
        for (let i = 1; i <= 10; i++) {
          const key = `backCoef${i}`;
          if (key in blk.parameters) {
            blk.parameters[key] = 0;
            resetCount++;
          }
        }
      }
      
      // Reset aspheric coefficients in block variables
      if (blk.variables) {
        for (let i = 1; i <= 10; i++) {
          const key = `frontCoef${i}`;
          if (blk.variables[key]) {
            blk.variables[key].value = 0;
            resetCount++;
          }
        }
        for (let i = 1; i <= 10; i++) {
          const key = `backCoef${i}`;
          if (blk.variables[key]) {
            blk.variables[key].value = 0;
            resetCount++;
          }
        }
      }
    }
  }
  
  console.log(`🔄 [OptimizerMVP] Reset ${resetCount} aspheric coefficients to zero`);
  return resetCount;
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
