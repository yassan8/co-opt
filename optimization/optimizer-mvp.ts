// @ts-nocheck
/**
 * MVP optimizer (coordinate descent) for Blocks-based design variables.
 *
 * - Variables are defined in Blocks: variables[*].optimize.mode === 'V'
 * - Values are applied to blocks.parameters[*] (canonical)
 * - Objective is derived from System Requirements (hard/soft, all-scenarios)
 *
 * Supports three optimization methods:
 *   - 'cd': Coordinate Descent
 *   - 'lm': Levenberg-Marquardt
 *   - 'kkt': KKT-based SQP (Sequential Quadratic Programming)
 *
 * No UI is added; the entrypoint is exposed as window.OptimizationMVP.
 */

import { expandBlocksToOpticalSystemRows } from '../data/block-schema.ts';
import { listDesignVariablesFromBlocks, setDesignVariableValue } from './design-variables.ts';
import { getGlassDataWithSellmeier } from '../data/glass.ts';
import { loadSystemConfigurations, saveSystemConfigurations } from '../data/table-configuration.ts';
import { tryLoadPersistedTableData as tryLoadPersistedOpticalSystemTableData } from '../data/table-optical-system.ts';
import { loadTableData as loadSystemRequirementsTableData } from '../data/table-system-requirements.ts';
import { requestRefreshBlockInspector } from '../core/window-facade.ts';
import { getWindowDebugBagValue, setWindowDebugBagValue } from '../utils/window-debug-bag.ts';
import { runKKTOptimization } from './kkt-optimizer.ts';

let __optimizerStopRequested = false;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nowMs() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

function getScenarioOverrideGlobal() {
  try {
    return (typeof window !== 'undefined') ? (window as any).__cooptScenarioOverride : null;
  } catch (_) {
    return null;
  }
}

function setScenarioOverrideGlobal(value) {
  try {
    if (typeof window === 'undefined') return;
    if (value && typeof value === 'object') {
      (window as any)['__cooptScenarioOverride'] = value;
      return;
    }
    try { delete (window as any).__cooptScenarioOverride; } catch (_) {}
  } catch (_) {
    // ignore
  }
}

function setBlocksOverrideGlobal(value) {
  try {
    if (typeof window === 'undefined') return;
    if (value !== undefined) {
      (window as any)['__cooptBlocksOverride'] = value;
      return;
    }
    try { delete (window as any).__cooptBlocksOverride; } catch (_) {}
  } catch (_) {
    // ignore
  }
}

function getSpotSizeDebugFastByKeyMap() {
  const fromBag = getWindowDebugBagValue('optimizerMvp', 'spotSizeDebugFastByKey', null);
  if (fromBag && typeof fromBag === 'object') return fromBag;
  try {
    if (typeof window === 'undefined') return null;
    const legacy = (window as any).__cooptSpotSizeDebugFastByKey;
    return (legacy && typeof legacy === 'object') ? legacy : null;
  } catch (_) {
    return null;
  }
}

function getLastOptimizerResidualDebug() {
  const fromBag = getWindowDebugBagValue('optimizerMvp', 'lastOptimizerResidualDebug', null);
  if (fromBag && typeof fromBag === 'object') return fromBag;
  try {
    if (typeof window === 'undefined') return null;
    const legacy = (window as any).__cooptLastOptimizerResidualDebug;
    return (legacy && typeof legacy === 'object') ? legacy : null;
  } catch (_) {
    return null;
  }
}

function setLastOptimizerResidualDebug(value) {
  setWindowDebugBagValue('optimizerMvp', 'lastOptimizerResidualDebug', value && typeof value === 'object' ? value : null);
}

function setLastOptimizeProfile(value) {
  setWindowDebugBagValue('optimizerMvp', 'lastOptimizeProfile', value && typeof value === 'object' ? value : null);
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
  const prev = getScenarioOverrideGlobal();
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
      setScenarioOverrideGlobal(overrideMap);

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
    setScenarioOverrideGlobal((prev && typeof prev === 'object') ? prev : null);
  }
}

function evalMeritAllScenarios(activeCfg, evalMerit, configId) {
  const scenarios = Array.isArray(activeCfg?.scenarios) ? activeCfg.scenarios : null;
  if (!scenarios || scenarios.length === 0) return evalMerit();

  // Non-persistent override hook consumed by merit-function-editor.
  const key = String(configId);
  const prev = getScenarioOverrideGlobal();
  const overrideMap = (prev && typeof prev === 'object') ? { ...prev } : {};

  let total = 0;
  try {
    for (const scn of scenarios) {
      if (!scn || scn.id === undefined || scn.id === null) continue;
      const w = Number(scn.weight);
      const weight = Number.isFinite(w) ? w : 1;
      overrideMap[key] = String(scn.id);
      setScenarioOverrideGlobal(overrideMap);
      const m = evalMerit();
      total += weight * m;
    }
    return total;
  } finally {
    setScenarioOverrideGlobal((prev && typeof prev === 'object') ? prev : null);
  }
}

function loadSystemConfigurationsRaw() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return loadSystemConfigurations();
  } catch {
    return null;
  }
}

function saveSystemConfigurationsRaw(systemConfig) {
  try {
    if (typeof localStorage === 'undefined') return false;
    saveSystemConfigurations(systemConfig);
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
      const rows = tryLoadPersistedOpticalSystemTableData();
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
      const rows = tryLoadPersistedOpticalSystemTableData();
      if (!rows) return null;
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
    
    // Debug: Log conic changes
    if (ok && baseId && baseId.toLowerCase().includes('conic')) {
      console.log(`🔄 [Variable Update] ${baseId} = ${v2} (config: ${cid})`);
    }
    
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
    const d = loadSystemRequirementsTableData();
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
const __INVALID_OPERAND_PENALTY_AMOUNT = 1e3;  // Reduced from 1e4 to prevent residuals explosion

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
  const prev = getScenarioOverrideGlobal();
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
        setScenarioOverrideGlobal(overrideMap);
        evalOnce(scn.id, scenarioWeight);
      }
    }

    return { feasible, violationScore, softPenalty, hardViolations, softViolations };
  } finally {
    setScenarioOverrideGlobal((prev && typeof prev === 'object') ? prev : null);
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
  const prev = getScenarioOverrideGlobal();
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
      setScenarioOverrideGlobal(overrideMap);

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
    setScenarioOverrideGlobal((prev && typeof prev === 'object') ? prev : null);
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
  // Disabled by default; enable via { profile:true }.
  const __profileEnabled = (opts.profile === undefined) ? false : !!opts.profile;
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
      setLastOptimizeProfile(__profile);
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
            const fastByKey = getSpotSizeDebugFastByKeyMap();
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
  
  // Reset MeritFunctionEditor debug counters to ensure clean state
  try {
    if (typeof window !== 'undefined' && window.meritFunctionEditor) {
      // Reset LA_RMS_UM call counter
      if (typeof window.meritFunctionEditor.__laRmsCallCount !== 'undefined') {
        window.meritFunctionEditor.__laRmsCallCount = 0;
      }
      // Reset any other counters if needed
    }
  } catch (_) {}
  
  // Clear spot diagram debug cache to ensure fresh evaluations
  try {
    if (typeof window !== 'undefined') {
      setWindowDebugBagValue('optimizerMvp', 'spotSizeDebugFast', null);
      setWindowDebugBagValue('optimizerMvp', 'spotSizeDebugFastByKey', {});
    }
  } catch (_) {}
  
  // Clear any leftover override variables from previous optimization runs
  // This ensures a clean slate and prevents state contamination between runs
  try {
    if (typeof window !== 'undefined') {
      // Clear blocks override (will be set fresh during this run)
      setBlocksOverrideGlobal(undefined);
      // Clear scenario override (will be managed within this run)
      setScenarioOverrideGlobal(null);
    }
    if (typeof globalThis !== 'undefined') {
      // Clear optical system rows override (will be managed within this run)
      delete globalThis.__cooptOpticalSystemRowsOverride;
      // Clear fast mode settings (will be set fresh during this run)
      delete globalThis.__cooptMeritFastMode;
    }
  } catch (_) {}
  
  const runUntilStopped = !!opts.runUntilStopped;
  const methodRaw = String(opts.method || '').trim().toLowerCase();
  const method = (methodRaw === 'kkt' || methodRaw === 'sqp')
    ? 'kkt'
    : (methodRaw === 'cd' || methodRaw === 'coordinatedescent')
    ? 'cd'
    : 'lm';
  // 【修正】KKT法はLM法より収束が遅いため、デフォルトを100→500に増加
  const defaultMaxIter = (method === 'kkt') ? 500 : 100;
  const maxIterations = runUntilStopped
    ? Number.MAX_SAFE_INTEGER
    : (Number.isFinite(Number(opts.maxIterations)) ? Math.max(1, Math.floor(Number(opts.maxIterations))) : defaultMaxIter);
  const stepFraction = Number.isFinite(Number(opts.stepFraction)) ? Math.max(1e-6, Number(opts.stepFraction)) : 0.02;
  const minStep = Number.isFinite(Number(opts.minStep)) ? Math.max(1e-12, Number(opts.minStep)) : 1e-6;
  const stepDecay = Number.isFinite(Number(opts.stepDecay)) ? Math.min(0.95, Math.max(0.1, Number(opts.stepDecay))) : 0.5;
  const stallLimit = runUntilStopped
    ? Number.MAX_SAFE_INTEGER
    : (Number.isFinite(Number(opts.stallLimit)) ? Math.max(1, Math.floor(Number(opts.stallLimit))) : 5);
  const logEvery = Number.isFinite(Number(opts.logEvery)) ? Math.max(1, Math.floor(Number(opts.logEvery))) : 1;

  const lmLambda0 = Number.isFinite(Number(opts.lmLambda0)) ? Math.max(1e-12, Number(opts.lmLambda0)) : 1e-3;
  const lmLambdaUp = Number.isFinite(Number(opts.lmLambdaUp)) ? Math.max(1.1, Number(opts.lmLambdaUp)) : 10;
  const lmLambdaDown = Number.isFinite(Number(opts.lmLambdaDown)) ? Math.min(0.95, Math.max(1e-3, Number(opts.lmLambdaDown))) : 0.3;
  // Nielsen/Marquardt adaptive damping: use tau to scale initial lambda based on J^T*J
  const lmTau = Number.isFinite(Number(opts.lmTau)) ? Math.max(1e-6, Number(opts.lmTau)) : 1e-3;
  const fdStepFraction = Number.isFinite(Number(opts.fdStepFraction)) ? Math.max(1e-10, Number(opts.fdStepFraction)) : 2e-3;
  // Default must be tiny enough for asphere coefficients (often ~1e-12 and smaller).
  // A too-large absolute FD step will destroy Jacobians for coef vars.
  const fdMinStep = Number.isFinite(Number(opts.fdMinStep)) ? Math.max(1e-30, Number(opts.fdMinStep)) : 1e-18;
  const fdScaledStep = Number.isFinite(Number(opts.fdScaledStep)) ? Math.max(1e-9, Number(opts.fdScaledStep)) : 8e-3;

  // Aspheric coefficient regularization (Tikhonov): penalizes large high-order terms
  // Helps prevent overfitting and improves manufacturability
  // alphaReg = 0: no regularization (default for fast convergence)
  // alphaReg > 0: add penalty term alphaReg * ||coef||^2 to cost function
  // 
  // IMPROVEMENT: For high-order coefficients (A14+), consider enabling gentle regularization
  // to improve convergence. Use opts.asphericRegularization to control this.
  // Suggested value for difficult cases: 1e-6 to 1e-4
  const asphericRegularization = Number.isFinite(Number(opts.asphericRegularization)) ? Math.max(0, Number(opts.asphericRegularization)) : 0;

  // Continuation/staged optimization for aspherics.
  // Enabled by default for LM because it significantly reduces local-minimum trapping.
  const staged = (opts.staged === undefined) ? true : !!opts.staged;
  const stageMaxCoefList = staged ? buildStagedCoefMaxList(opts) : [10];
  // Fast stall limit: move to next stage quickly
  const stageStallLimit = Number.isFinite(Number(opts.stageStallLimit)) ? Math.max(1, Math.floor(Number(opts.stageStallLimit))) : 5;

  // Trust region / step control in scaled coordinates.
  const trustRegion = (opts.trustRegion === undefined) ? true : !!opts.trustRegion;
  // In staged LM (especially with asphere coefficients), larger trust region for faster convergence.
  const trustRegionDelta = Number.isFinite(Number(opts.trustRegionDelta))
    ? Math.max(1e-6, Number(opts.trustRegionDelta))
    : ((method === 'lm' && staged) ? 0.15 : 0.2);
  const trustRegionDeltaMax = Number.isFinite(Number(opts.trustRegionDeltaMax))
    ? Math.max(trustRegionDelta, Number(opts.trustRegionDeltaMax))
    : Math.max(trustRegionDelta, 2.0);

  // Reset aspheric coefficients to zero before optimization to avoid local minima
  const resetAsphericCoefs = !!opts.resetAsphericCoefficients;

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
  const backtrackingMaxTries = Number.isFinite(Number(opts.backtrackingMaxTries)) ? Math.max(1, Math.floor(Number(opts.backtrackingMaxTries))) : 5;

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

  const waitForMeritEditorReady = async (): Promise<any | null> => {
    const w = (typeof window !== 'undefined') ? (window as any) : null;
    const start = Date.now();
    const maxWaitMs = Number.isFinite(Number(opts?.meritEditorWaitMs))
      ? Math.max(0, Math.min(10000, Number(opts.meritEditorWaitMs)))
      : 2500;
    const intervalMs = 50;
    while (Date.now() - start <= maxWaitMs) {
      try {
        if (w && typeof w.__cooptInitMeritFunctionEditor === 'function') {
          w.__cooptInitMeritFunctionEditor();
        }
      } catch (_) {}
      const ed = w ? w.meritFunctionEditor : null;
      if (ed && typeof ed.calculateOperandValue === 'function') return ed;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  };

  const editor = await waitForMeritEditorReady();
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
    setBlocksOverrideGlobal(blocksByConfigId);
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

      const prev = getScenarioOverrideGlobal();
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
          setScenarioOverrideGlobal(overrideMap);
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
          setScenarioOverrideGlobal((prev && typeof prev === 'object') ? prev : null);
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
              const fastByKey = getSpotSizeDebugFastByKeyMap();
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

          const prevDbg = getLastOptimizerResidualDebug();
          const shouldForceUpdateForSpot = isSpotWorst && (spotDebugKey && (!prevDbg || prevDbg.spotDebugKey !== spotDebugKey || !prevDbg.spotDebug));
          const shouldUpdate = shouldForceUpdateForSpot || (t - __cooptLastResidualDebugAt >= __cooptResidualDebugThrottleMs);
          if (shouldUpdate) {
            __cooptLastResidualDebugAt = t;
            setLastOptimizerResidualDebug({
              at: t,
              method: 'lm',
              residualCount: residuals.length,
              nonFiniteCount,
              cost,
              worst,
              spotDebugKey,
              spotDebug
            });
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
    let lambdaInitialized = false; // Will be set adaptively from first Jacobian (Nielsen method)
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
        requestRefreshBlockInspector();
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

    console.log('🚀 [OptimizerMVP] start', { 
      method: 'lm', 
      vars: vars.length, 
      before: before.toFixed(6), 
      maxIterations, 
      stallLimit,
      stageStallLimit,
      multiScenario,
      staged,
      stages: staged ? stageMaxCoefList.length : 1
    });

    // Reset aspheric coefficients at the start if option is enabled (helps avoid local minima)
    if (resetAsphericCoefs) {
      console.log('🔄 [OptimizerMVP] Resetting aspheric coefficients to zero to avoid local minima...');
      const resetCount = resetAsphericCoefficientsToZero({ configsById, targetConfigIds });
      if (resetCount > 0) {
        // Sync to tables after reset
        try {
          if (window.ConfigurationManager && typeof window.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
            await window.ConfigurationManager.loadActiveConfigurationToTables({
              applyToUI: false,
              suppressOpticalSystemDataChanged: true,
            });
          }
        } catch (_) {}
        // Re-evaluate initial state after reset
        before0Eval = await evalStateLM();
        before = before0Eval.cost;
        best = before;
        console.log(`🔄 [OptimizerMVP] After reset: cost=${before.toFixed(6)}, reset ${resetCount} coefficients`);
      }
    }

    let stageIndex = 0;
    let stageNoImprove = 0;
    const lastStageIndex = Math.max(0, stageMaxCoefList.length - 1);

    // User preference: once rho hits 0 (flat/degenerate LM model), do not inject random perturbations.
    let __lmExploreDisabledAfterZeroRho = false;

    for (let iter = 1; iter <= maxIterations; iter++) {
      // Stage-dependent trust region: only Stage 0 uses smaller steps
      // Stage 0: moderate steps (0.05) for base optimization
      // Stage 1+: full steps (trustRegionDelta=0.15) for fast convergence
      const stageBaseTrustDelta = stageIndex === 0 ? 0.05 : trustRegionDelta;
      if (iter === 1 || trustRegionDeltaEff > stageBaseTrustDelta * 1.5) {
        trustRegionDeltaEff = stageBaseTrustDelta;
      }
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
          // Debug info: track aspheric coefficient values during optimization
          const asphericVars = curVars.filter(v => isAsphereCoefKey(v.key) || /conic$/i.test(v.key));
          const asphericDebug = asphericVars.length > 0 ? {
            count: asphericVars.length,
            values: asphericVars.map(v => ({ key: v.key, value: v.value }))
          } : undefined;

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
            activeVariables: n,
            asphericDebug
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

        // Debug: Log step size for conic variables
        if (keys[j] && keys[j].toLowerCase().includes('conic')) {
          console.log(`🔬 [Jacobian] ${keys[j]}: value=${xj.toFixed(6)}, step=${h.toFixed(8)}, perturbed=${(xj+h).toFixed(6)}`);
        }

        // apply perturbed
        for (let k = 0; k < n; k++) {
          setJointDesignVariableValue(jointState, ids[k], xPert[k]);
        }
        maybeSave('jacobian');

        const br = evalResidualsNowProfiled();
        const r1 = br.residuals;
        const mm = Math.min(m, r1.length);
        
        // Calculate column magnitude for debugging
        let colMagnitude = 0;
        for (let i = 0; i < mm; i++) {
          const derivative = (r1[i] - r0[i]) / h;
          colMagnitude += derivative * derivative;
          // Numerical stability: clamp extremely large derivatives (likely numerical errors)
          // This prevents singular or near-singular Jacobian matrices
          const maxDerivMag = 1e12;
          if (Number.isFinite(derivative)) {
            J[i][j] = Math.max(-maxDerivMag, Math.min(maxDerivMag, derivative));
          } else {
            J[i][j] = 0; // Treat NaN/Inf as zero derivative
          }
        }
        for (let i = mm; i < m; i++) {
          J[i][j] = 0;
        }
        
        // Debug: Log Jacobian column magnitude for conic variables
        if (keys[j] && keys[j].toLowerCase().includes('conic')) {
          const colNorm = Math.sqrt(colMagnitude);
          console.log(`🔬 [Jacobian] ${keys[j]}: ||J[:,${j}]|| = ${colNorm.toExponential(3)}`);
          if (colNorm < 1e-6) {
            console.warn(`⚠️ [Jacobian] ${keys[j]}: Column has very small magnitude - parameter may not affect merit function`);
          }
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

      // Nielsen adaptive initialization: lambda_0 = tau * max(diag(A))
      if (!lambdaInitialized) {
        let maxDiag = 0;
        for (let i = 0; i < n; i++) {
          const d = A[i][i];
          if (Number.isFinite(d) && d > maxDiag) maxDiag = d;
        }
        if (maxDiag > 0 && lmTau > 0) {
          lambda = lmTau * maxDiag;
          lambdaInitialized = true;
        }
      }

      // Add Tikhonov regularization for aspheric coefficients (if enabled)
      // Adds alphaReg to diagonal elements for aspheric coefficient variables
      // This penalizes large coefficient magnitudes, improving manufacturability
      if (asphericRegularization > 0) {
        for (let i = 0; i < n; i++) {
          const key = keys[i];
          if (isAsphereCoefKey(key)) {
            A[i][i] += asphericRegularization;
          }
        }
      }

      // Numerical stability: ensure all diagonal elements are positive
      // This prevents singular or near-singular matrices
      const minDiag = 1e-30;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(A[i][i]) || A[i][i] < minDiag) {
          A[i][i] = minDiag;
        }
      }

      // Damping: A_damped = A + lambda * diag(A) + lambda * I
      // This is the Marquardt modification (combines Levenberg and Marquardt approaches)
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
        // Stability tuning: linear solver failed, increase damping
        lambda *= lmLambdaUp;
        // Safety check: if lambda becomes too large, the problem may be ill-conditioned
        // Reset to Nielsen-based initialization and reduce trust region
        if (lambda > 1e10) {
          let maxDiag = 0;
          for (let i = 0; i < n; i++) {
            const d = A[i][i];
            if (Number.isFinite(d) && d > maxDiag) maxDiag = d;
          }
          lambda = (maxDiag > 0) ? lmTau * maxDiag : lmLambda0;
          trustRegionDeltaEff = Math.max(trustRegionDelta * 0.5, trustRegionDelta);
        }
        continue;
      }

      // Trust region (scaled): clip dx so max |dx_i/scale_i| <= delta.
      // Stability tuning: prevents overly large steps in scaled coordinates
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

      // Numerical stability check: detect NaN or Inf in step
      let stepValid = true;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(dx[i])) {
          stepValid = false;
          break;
        }
      }
      if (!stepValid) {
        // Numerical instability detected, increase damping significantly
        lambda *= lmLambdaUp * lmLambdaUp;
        trustRegionDeltaEff = Math.max(trustRegionDelta, trustRegionDeltaEff * 0.5);
        continue;
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
        // Predicted decrease using the linearized model: m(0) - m(dx)
        // For LM method: pred = dx^T * g + 0.5 * dx^T * A * dx
        // where g = -J^T * r (gradient) and A = J^T * J
        // This is more accurate than the simplified version
        try {
          // Linear term: dx^T * g
          let linearTerm = 0;
          for (let i = 0; i < n; i++) {
            linearTerm += dxStep[i] * g[i];
          }
          
          // Quadratic term: 0.5 * dx^T * A * dx
          let quadTerm = 0;
          for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let k = 0; k < n; k++) {
              sum += A[i][k] * dxStep[k];
            }
            quadTerm += dxStep[i] * sum;
          }
          quadTerm *= 0.5;
          
          const pred = -(linearTerm + quadTerm); // Negative because g points downhill
          return Number.isFinite(pred) ? pred : NaN;
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
        // Stability tuning: prevents trust region from becoming too small or too large
        // This is especially helpful for spot-size hinge constraints where the quadratic model is
        // only reliable intermittently.
        if (trustRegion) {
          const minDelta = trustRegionDelta * 0.1; // Prevent collapse to zero
          if (acceptedRho > 0.75) {
            trustRegionDeltaEff = Math.min(trustRegionDeltaMax, Math.max(trustRegionDelta, trustRegionDeltaEff * 1.25));
          } else if (acceptedRho > 0.25) {
            trustRegionDeltaEff = Math.min(trustRegionDeltaMax, Math.max(trustRegionDelta, trustRegionDeltaEff * 1.05));
          } else {
            // Stability: don't shrink below minimum threshold
            trustRegionDeltaEff = Math.max(minDelta, trustRegionDeltaEff * 0.95);
          }
        }

        // Nielsen/Marquardt adaptive lambda update based on gain ratio.
        // This uses a smooth function rather than discrete thresholds for better behavior.
        // Reference: Nielsen, H.B. (1999), "Damping Parameter in Marquardt's Method"
        // factor = max(1/3, 1 - (2*rho - 1)^3) when rho > threshold
        const rhoThreshold = 0.0001; // Numerical threshold for accepting step
        let factor;
        if (acceptedRho > rhoThreshold) {
          // Smooth decrease: higher rho → smaller factor → smaller lambda
          const smoothTerm = Math.pow(2 * acceptedRho - 1, 3);
          factor = Math.max(1.0 / 3.0, 1.0 - smoothTerm);
          factor = Math.max(lmLambdaDown, Math.min(1.0, factor));
        } else {
          // Very poor prediction: increase damping significantly
          factor = lmLambdaUp;
        }
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
          // Stability tuning: On rejection, shrink toward base with minimum threshold
          const minDelta = trustRegionDelta * 0.1;
          trustRegionDeltaEff = Math.max(minDelta, trustRegionDeltaEff * 0.9);
        }
        
        // Stability check: if lambda is becoming extremely large, reset
        if (lambda > 1e12) {
          lambda = lmLambda0 * 100;
          trustRegionDeltaEff = trustRegionDelta * 0.5;
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
        const stageInfo = staged ? ` stage=${stageIndex}/${lastStageIndex} stall=${stageNoImprove}/${stageStallLimit}` : '';
        console.log(`🔁 [OptimizerMVP] iter ${iter}/${maxIterations}${stageInfo}`, { method: 'lm', best, lambda: lambda.toExponential(2) });
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
      requestRefreshBlockInspector();
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
    const improvement = before > 0 ? ((before - best) / before * 100).toFixed(2) : '0.00';
    console.log('✅ [OptimizerMVP] done', { 
      method: 'lm', 
      before: before.toFixed(6), 
      best: best.toFixed(6), 
      improvement: `${improvement}%`,
      iterations: completedIterations,
      ms: Math.round(t1 - t0) 
    });

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

  // KKT-based optimization (method === 'kkt')
  console.log('[DEBUG] method=', method, 'vars.length=', vars.length);
  if (method === 'kkt') {
    const t0 = nowMs();
    console.log('[DEBUG] AL block entered. vars.length=', vars.length);
    
    // Early return if no continuous variables
    if (vars.length === 0) {
      console.log('❌ [AL] No continuous variables to optimize. vars.length = 0');
      return {
        ok: false,
        reason: 'No continuous design variables found for AL optimization'
      };
    }
    
    try {
      // Map variables to indices
      const varIds = vars.map(v => v.id);
      const initialX = vars.map(v => jointState
        ? Number(getJointCurrentValue(jointState, v.id))
        : Number(v.value) || 0
      );

      // Compute initial state before optimization
      const initialStateEval = evalCompositeFromRequirementsProfiled();
      const initialScore = initialStateEval?.score ?? 1e9;

      console.log('🚀 [AL] Starting optimization with', vars.length, 'variables, initial score:', initialScore);

      // Report start phase
      if (onProgress) {
        try {
          onProgress({
            phase: 'start',
            iter: 0,
            current: initialScore,
            best: initialScore,
            method: 'kkt',
            multiScenario,
            requirementCount: Array.isArray(expandedRequirements) ? expandedRequirements.length : 0,
            feasible: initialStateEval?.feasible ?? false
          });
        } catch (_) {}
        await nextFrame();
      }

      // Box constraints (bounds) from Design Intent optimize.min/max/clampAbsMax
      const resolveBoundsForVarId = (varId: string) => {
        try {
          const parsed = parseJointVariableId(varId);
          const cfgId = parsed.configId ? String(parsed.configId) : String(activeConfigId ?? '');
          const blocks = (jointState && jointState.blocksByConfigId && cfgId)
            ? jointState.blocksByConfigId[cfgId]
            : activeCfg?.blocks;
          const entry = getVariableEntryFromBlocks(blocks, parsed.baseId);
          const opt = (entry && typeof entry === 'object') ? entry.optimize : null;
          let minV = Number.isFinite(Number(opt?.min)) ? Number(opt.min) : null;
          let maxV = Number.isFinite(Number(opt?.max)) ? Number(opt.max) : null;
          const absMaxRaw = Number(opt?.clampAbsMax);
          const clampAbsMax = Number.isFinite(absMaxRaw) ? Math.abs(absMaxRaw) : null;

          if (clampAbsMax !== null) {
            minV = (minV === null) ? -clampAbsMax : Math.max(minV, -clampAbsMax);
            maxV = (maxV === null) ? clampAbsMax : Math.min(maxV, clampAbsMax);
          }

          if (minV !== null && maxV !== null && minV > maxV) {
            const tmp = minV;
            minV = maxV;
            maxV = tmp;
          }
          return { min: minV, max: maxV };
        } catch (_) {
          return { min: null, max: null };
        }
      };

      const resolveScaleForVarId = (varId: string, fallbackKey?: string) => {
        try {
          const parsed = parseJointVariableId(varId);
          const cfgId = parsed.configId ? String(parsed.configId) : String(activeConfigId ?? '');
          const blocks = (jointState && jointState.blocksByConfigId && cfgId)
            ? jointState.blocksByConfigId[cfgId]
            : activeCfg?.blocks;
          const entry = getVariableEntryFromBlocks(blocks, parsed.baseId);
          const opt = (entry && typeof entry === 'object') ? entry.optimize : null;
          const scaleRaw = Number(opt?.scale ?? opt?.stepScale ?? opt?.stepScaleAbs ?? opt?.stepScaleRel);
          if (Number.isFinite(scaleRaw) && scaleRaw > 0) return scaleRaw;

          const key = String((entry && typeof entry === 'object' && entry.key) ? entry.key : (fallbackKey ?? '')).trim();
          const keyScale = defaultScaleForKey(key);
          const scale = Number.isFinite(keyScale) && keyScale > 0 ? keyScale : 1;
          return scale;
        } catch (_) {
          return 1;
        }
      };

      const varBounds = varIds.map(resolveBoundsForVarId);
      const varScales = varIds.map((id, i) => resolveScaleForVarId(id, vars[i]?.key));
      const clampToBounds = (x: number[]) => x.map((v, i) => {
        const b = varBounds[i];
        if (!b || (!Number.isFinite(b.min ?? NaN) && !Number.isFinite(b.max ?? NaN))) return v;
        if (!Number.isFinite(v)) return v;
        let out = v;
        if (b.min !== null && Number.isFinite(b.min)) out = Math.max(b.min, out);
        if (b.max !== null && Number.isFinite(b.max)) out = Math.min(b.max, out);
        return out;
      });

      // Objective function: minimize composite score of residuals
      // Saves/restores state to avoid side effects
      let evalCallCount = 0;
      const objectiveForKKT = (x: number[]) => {
        evalCallCount++;
        // Save current values
        const saved = vars.map(v => jointState 
          ? Number(getJointCurrentValue(jointState, v.id))
          : Number(v.value) || 0
        );
        try {
          // Set variables to x values
          for (let i = 0; i < varIds.length && i < x.length; i++) {
            const varId = varIds[i];
            const newVal = x[i];
            const setOk = jointState
              ? setJointDesignVariableValue(jointState, varId, newVal)
              : setDesignVariableValue(activeCfg, varId, newVal);
            if (evalCallCount <= 3 && i === 0) {
              console.log(`  [DEBUG] Call#${evalCallCount} Setting ${varId} = ${newVal.toFixed(6)}, result: ${setOk}`);
            }
          }
          // Evaluate and return score
          const state = evalCompositeFromRequirementsProfiled();
          const score = state?.score ?? 1e9;
          if (evalCallCount <= 3) {
            console.log(`  [DEBUG] Call#${evalCallCount} Evaluation: ${score.toFixed(6)}`);
          }
          return score;
        } finally {
          // Restore to saved state
          for (let i = 0; i < varIds.length && i < saved.length; i++) {
            if (jointState) {
              setJointDesignVariableValue(jointState, varIds[i], saved[i]);
            } else {
              setDesignVariableValue(activeCfg, varIds[i], saved[i]);
            }
          }
        }
      };

      // Progress callback
      const onProgressKKT = async (p: any) => {
        if (onProgress && typeof onProgress === 'function') {
          try {
            onProgress({
              phase: p.phase || 'kkt-iter',
              iter: p.iter ?? 0,
              current: p.current,  // Pass actual current score, not default to initialScore
              best: p.best,        // Pass actual best score
              method: 'kkt',
              multiScenario,
              requirementCount: Array.isArray(expandedRequirements) ? expandedRequirements.length : 0,
              feasible: p.feasible ?? false
            });
          } catch (_) {}
        }
        await nextFrame();
      };

      const shouldStopKKT = () => {
        if (userShouldStop && typeof userShouldStop === 'function') {
          return userShouldStop();
        }
        return __optimizerStopRequested || (typeof globalThis !== 'undefined' && globalThis.__stopOptimization);
      };

      const evalSQPAtX = (x: number[]) => {
        const editor = (typeof window !== 'undefined') ? window.meritFunctionEditor : null;
        if (!editor || typeof editor.calculateOperandValue !== 'function') {
          return { objective: 1e9, constraints: [], feasible: false, residuals: [] };
        }

        const xClamped = clampToBounds(x);
        const saved = vars.map(v => jointState
          ? Number(getJointCurrentValue(jointState, v.id))
          : Number(v.value) || 0
        );

        const prev = getScenarioOverrideGlobal();
        const overrideMap = (prev && typeof prev === 'object') ? { ...prev } : {};

        let objective = 0;
        const constraints: number[] = [];
        const residuals: number[] = [];

        try {
          for (let i = 0; i < varIds.length && i < xClamped.length; i++) {
            const varId = varIds[i];
            const newVal = xClamped[i];
            if (jointState) setJointDesignVariableValue(jointState, varId, newVal);
            else setDesignVariableValue(activeCfg, varId, newVal);
          }

          const items = Array.isArray(residualItems) ? residualItems : [];
          for (const it of items) {
            const r = it?.req;
            if (!r || !r.enabled || !r.operand) continue;

            const w = Math.max(0, toFiniteNumber(r.weight, 1)) * Math.max(0, toFiniteNumber(it?.scenarioWeight, 1));
            if (!(w > 0)) continue;

            const cfgId = String(it?.configId ?? '');
            if (it?.scenarioId) overrideMap[cfgId] = String(it.scenarioId);
            else delete overrideMap[cfgId];
            setScenarioOverrideGlobal(overrideMap);

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

            const currentRaw = editor.calculateOperandValue(opObj);
            const s = sanitizeOperandCurrentForScore(currentRaw);
            if (!s.ok || !Number.isFinite(s.current)) {
              const penalty = __INVALID_OPERAND_PENALTY_AMOUNT;
              objective += w * penalty * penalty;
              residuals.push(Math.sqrt(w) * penalty);
              constraints.push(penalty);
              continue;
            }

            const current = s.current;
            const target = toFiniteNumber(r.target, 0);
            const tol = Math.max(0, toFiniteNumber(r.tol, 0));
            const scale = Math.max(1, Math.abs(tol));
            const residual = (current - target) / scale;
            objective += w * residual * residual;
            
            // 【修正】等式制約のみ residuals に追加。不等式は constraints のみで処理
            if (r.op === '=') {
              residuals.push(Math.sqrt(w) * residual);
              // 【修正】等式制約は residuals で処理済みなので constraints に追加しない
            } else if (r.op === '<=') {
              constraints.push(current - target - tol);
            } else if (r.op === '>=') {
              constraints.push((target - tol) - current);
            }
            // 【削除】else で等式制約を2つの不等式として重複登録するのを削除しました
          }
        } finally {
          setScenarioOverrideGlobal((prev && typeof prev === 'object') ? prev : null);
          for (let i = 0; i < varIds.length && i < saved.length; i++) {
            if (jointState) setJointDesignVariableValue(jointState, varIds[i], saved[i]);
            else setDesignVariableValue(activeCfg, varIds[i], saved[i]);
          }
        }

        // Check aspheric coefficient monotonicity
        const asphericGroups = new Map<string, Array<{idx: number, order: number, value: number}>>();
        for (let i = 0; i < Math.min(varIds.length, xClamped.length); i++) {
          const varId = varIds[i];
          const match = varId.match(/^(\d+):(.+?)\.(.+Coef)(\d+)$/);
          if (match) {
            const [_, blockId, blockName, coefPrefix, orderStr] = match;
            const order = parseInt(orderStr);
            if (order >= 4) {
              const key = `${blockId}:${blockName}.${coefPrefix}`;
              if (!asphericGroups.has(key)) asphericGroups.set(key, []);
              asphericGroups.get(key)!.push({idx: i, order, value: xClamped[i]});
            }
          }
        }

        for (const [_, group] of asphericGroups) {
          if (group.length < 2) continue;
          group.sort((a, b) => a.order - b.order);
          for (let i = 1; i < group.length; i++) {
            // 【修正】微分不可能な Math.abs を避け、値の二乗で比較（滑らかな関数）
            const prevSq = group[i - 1].value * group[i - 1].value;
            const currSq = group[i].value * group[i].value;
            if (prevSq > 1e-30) {
              // currAbs > 1.2 * prevAbs  =>  currSq > 1.44 * prevSq
              const violation = currSq - 1.44 * prevSq;
              if (violation > 0) {
                // 【修正】1e6は強すぎて地形を壊すため、10程度に抑えて滑らかにする
                constraints.push(violation * 10);
              }
            }
          }
        }

        const feasible = constraints.every(c => c <= 0);
        return { objective, constraints, feasible, residuals };
      };

      console.log('🔄 [AL] Starting unified 1-loop SQP (max:', maxIterations, 'iters)');

      // Smoothmax function: smooth approximation of Math.max(0, x) for differentiability
      const smoothMax = (val: number, beta: number = 100) => {
        // Prevent overflow: for large val*beta, approximate linearly
        if (val * beta > 20) return val;
        return Math.log(1 + Math.exp(beta * val)) / beta;
      };

      const evalAugmentedResiduals = (x: number[], lambdaVec: number[], mu: number, maxViolContext: number = 1.0) => {
        const base = evalSQPAtX(x);
        const res = Array.isArray(base.residuals) && base.residuals.length > 0
          ? base.residuals.slice()
          : (base.objective > 0 ? [Math.sqrt(base.objective)] : []);
        const c = base.constraints || [];
        const rConstr = new Array(c.length);
        
        // 【修正】動的なノーマライズ（residualNormFactorなど）を完全削除
        // Jacobi Preconditioning があるため、値が巨大でも行列計算は破綻しません
        // 有限差分のヤコビアン計算では、関数内のノーマライズは勾配を消失させます
        const muScale = Math.sqrt(Math.max(1, mu));
        
        // 【追加】適応的beta：制約違反が小さい時はbetaを下げてスコア改善を優先
        // maxViol < 0.01 の時は beta=10 に下げ、制約を少し緩めてスコアを下げる余地を作る
        const adaptiveBeta = maxViolContext < 0.01 ? 10 : (maxViolContext < 0.1 ? 30 : 100);
        
        for (let i = 0; i < c.length; i++) {
          const li = Number.isFinite(lambdaVec[i]) ? lambdaVec[i] : 0;
          // 【修正】純粋な制約違反量を使用（scale による割り算を削除）
          const adj = c[i] + li / Math.max(1e-12, mu);
          rConstr[i] = muScale * smoothMax(adj, adaptiveBeta);
        }
        return { base, residuals: res.concat(rConstr) };
      };

      const finiteDiffJacobian = (x: number[], r0: number[], lambdaVec: number[], mu: number, maxViol: number = 1.0) => {
        const n = x.length;
        const m = r0.length;
        const J = Array.from({ length: m }, () => Array(n).fill(0));
        
        // 【修正】倍精度浮動小数点の桁落ちを防ぐ最適な刻み幅の基準（約 1.5e-8）
        const sqrtEps = 1.49e-8;

        for (let i = 0; i < n; i++) {
          const baseScale = Math.max(1e-12, Number(varScales[i]) || 1);
          const valueScale = Math.max(1e-12, Math.abs(x[i]));
          const stepBase = Math.max(baseScale, valueScale);
          
          // 【修正】相対ステップを sqrtEps ベースにし、下限を 1e-10 に引き上げ
          let eps = Math.max(1e-10, stepBase * sqrtEps);
          
          const xp = x.slice();
          xp[i] += eps;

          // 【追加】浮動小数点の限界で値が変わらない場合は、強制的に情報落ちしない幅まで拡大
          if (xp[i] === x[i]) {
            eps = Math.max(1e-8, Math.abs(x[i]) * 1e-6);
            xp[i] = x[i] + eps;
          }

          const e1 = evalAugmentedResiduals(xp, lambdaVec, mu, maxViol);
          const r1 = e1.residuals;
          
          for (let k = 0; k < Math.min(m, r1.length); k++) {
            const deriv = (r1[k] - r0[k]) / eps;
            J[k][i] = Number.isFinite(deriv) ? Math.max(-1e12, Math.min(1e12, deriv)) : 0;
          }
        }
        return J;
      };

      let bestX = clampToBounds(initialX.slice());
      let bestScore = initialScore;
      let bestEval = initialStateEval || null;
      let currentX = bestX.slice();
      
      // 【重要】初期評価を recordEval() に記録（LMメソッドと同様）
      // これにより getBestEvalSoFar() が null を返さず、正しくベスト追跡できる
      if (initialStateEval) {
        recordEval(initialStateEval);
      }
      
      // 【修正】ペナルティを含めた総合評価（メリット関数）でベストを追跡する
      // これにより、完全に feasible でなくても、十分に改善された解を保存できる
      const initConstraintEval = evalSQPAtX(initialX);
      const initViolationVector = (initConstraintEval.constraints || []).map(c => Math.max(0, c));
      const initViolation = Math.sqrt(initViolationVector.reduce((acc, v) => acc + v * v, 0));
      let bestMerit = initialScore + initViolation * 10000;  // Penalty-weighted merit

      let mu = Math.max(1, Number.isFinite(Number(opts?.kktPenalty)) ? Number(opts.kktPenalty) : 1);
      let lambdaVec: number[] = [];
      let lmDamp = 2e-4;  // 【最適刖5e-4→2e-4：初期ダンピングをさらに小さく、爆速探索
      let lastMaxViol = Infinity;  // Track maxViol for stagnation detection
      let violStagnationIter = 0;  // Count iterations without improvement
      let kktRejectStreak = 0;  // 【追加】Auto soft-restart: detect if stuck in reject-repeat cycle
      let consecutiveRestarts = 0;  // 【追加】連続リスタート回数をカウント
      let lastAcceptedScore = initialScore;  // 【追加】最後にアクセプトされたスコアを追跡
      
      // 【追加】LM法と同様に、予測精度に応じて歩幅の上限を伸縮させる適応的トラスト領域
      let trustRegionDeltaEff = 0.5;
      
      // 【重要】Stop後のRun時に現在のシステム状態から再開するため、
      // 現在の設計変数値をcurrentXに読み込む（これがStop→Runで良く収束する理由）
      for (let i = 0; i < varIds.length; i++) {
        if (jointState) {
          const val = getJointCurrentValue(jointState, varIds[i]);
          if (Number.isFinite(val)) currentX[i] = val;
        } else if (activeCfg) {
          const val = getDesignVariableValue(activeCfg, varIds[i]);
          if (Number.isFinite(val)) currentX[i] = val;
        }
      }

      // 【Broyden準Newton更新】前回のJacobian、変位dx、残差変化drを保存
      let lastJ: number[][] | null = null;
      let lastX: number[] | null = null;
      let lastR: number[] | null = null;
      let broydenSkipCount = 0;  // Broyden更新を連続で何回使ったか

      // Unified 1-loop: iterate with immediate multiplier updates (SQP-like behavior)
      for (let iter = 0; iter < maxIterations; iter++) {
        if (shouldStopKKT()) {
          console.log('⏸️  [AL] User stop requested at iter', iter);
          break;
        }

        // Check current feasibility
        const preEval = evalSQPAtX(currentX);
        const preFeasible = preEval.feasible || (preEval.constraints || []).every(c => c <= 1e-3);
        
        // 【追加】現在の最大制約違反を計算（適応的beta用）
        const currentConstraints = preEval.constraints || [];
        const currentMaxViol = currentConstraints.length > 0 
          ? Math.max(0, ...currentConstraints) 
          : 0;

        // --- 1. Compute residuals and Jacobian ---
        const aug0 = evalAugmentedResiduals(currentX, lambdaVec, mu, currentMaxViol);
        const r0 = aug0.residuals;
        const cost0 = r0.reduce((acc, v) => acc + v * v, 0);
        if (!Number.isFinite(cost0)) break;

        const n = currentX.length;
        const m = r0.length;
        
        // 【Broyden準Newton更新】条件：前回のデータがある、連続6回未満、ステップが十分に受け入れられている
        // 【修正】連続適用回数を増やし、積極的にヤコビアン計算をスキップする
        const canUseBroyden = lastJ && lastX && lastR && 
                              lastJ.length === m && lastJ[0] && lastJ[0].length === n &&
                              lastX.length === n && lastR.length === m &&
                              broydenSkipCount < 6 &&  // 【4→6】より多く省略して計算時間削減
                              kktRejectStreak < 4;  // 少々のリジェクト中でもBroydenを継続
        
        let J: number[][];
        if (canUseBroyden) {
          // Broydenランク1更新: J_new = J_old + (dr - J_old*dx) * dx^T / (dx^T dx)
          const dx = currentX.map((xi, i) => xi - lastX![i]);
          const dr = r0.map((ri, i) => ri - lastR![i]);
          
          const dxNorm2 = dx.reduce((acc, v) => acc + v * v, 0);
          if (dxNorm2 > 1e-18) {
            J = lastJ.map(row => row.slice());  // Deep copy
            
            // Compute J_old * dx
            const Jdx = new Array(m).fill(0);
            for (let i = 0; i < m; i++) {
              for (let j = 0; j < n; j++) {
                Jdx[i] += J[i][j] * dx[j];
              }
            }
            
            // Update: J[i][j] += (dr[i] - Jdx[i]) * dx[j] / dxNorm2
            for (let i = 0; i < m; i++) {
              const numerator = dr[i] - Jdx[i];
              for (let j = 0; j < n; j++) {
                J[i][j] += numerator * dx[j] / dxNorm2;
              }
            }
            broydenSkipCount++;
            
            if (iter < 3 || iter % 100 === 0) {
              console.log(`[Broyden] Iter ${iter}: Using rank-1 update (skip count: ${broydenSkipCount}/6)`);
            }
          } else {
            // dx too small, fall back to finite difference
            J = finiteDiffJacobian(currentX, r0, lambdaVec, mu, currentMaxViol);
            broydenSkipCount = 0;
            lastJ = J;
          }
        } else {
          // Full finite difference Jacobian
          J = finiteDiffJacobian(currentX, r0, lambdaVec, mu, currentMaxViol);
          broydenSkipCount = 0;
          lastJ = J;
          
          if (iter < 3 || iter % 100 === 0) {
            console.log(`[Broyden] Iter ${iter}: Full finite-diff Jacobian computed`);
          }
        }
        
        // Save current state for next Broyden update
        lastX = currentX.slice();
        lastR = r0.slice();
        
        // 【最適化】デバッグログを削減
        if (iter < 3 || iter % 100 === 0) {
          let jMaxAbs = 0, jMinAbs = Infinity, jZeroCount = 0, jNaNCount = 0;
          for (let i = 0; i < m; i++) {
            for (let j = 0; j < n; j++) {
              const jVal = J[i][j];
              if (!Number.isFinite(jVal)) jNaNCount++;
              else if (Math.abs(jVal) < 1e-20) jZeroCount++;
              else {
                jMaxAbs = Math.max(jMaxAbs, Math.abs(jVal));
                jMinAbs = Math.min(jMinAbs, Math.abs(jVal));
              }
            }
          }
          console.log(`[DEBUG iter${iter}] Jacobian: ${jNaNCount} NaN, ${jZeroCount} ~zero, range [${jMinAbs.toExponential(2)}, ${jMaxAbs.toExponential(2)}]`);
        }

        // --- 2. Build normal equations: A = J^T J, g = J^T r ---
        const A = Array.from({ length: n }, () => Array(n).fill(0));
        const g = Array(n).fill(0);
        for (let j = 0; j < n; j++) {
          let gj = 0;
          for (let i = 0; i < m; i++) gj += J[i][j] * r0[i];
          g[j] = gj;
        }
        
        // Debug: Check gradient g
        if (iter < 3 || iter % 100 === 0) {
          let gMaxAbs = 0, gMinAbs = Infinity, gZeroCount = 0;
          for (let j = 0; j < n; j++) {
            if (Math.abs(g[j]) < 1e-20) gZeroCount++;
            else {
              gMaxAbs = Math.max(gMaxAbs, Math.abs(g[j]));
              gMinAbs = Math.min(gMinAbs, Math.abs(g[j]));
            }
          }
          console.log(`[DEBUG iter${iter}] Gradient g: ${gZeroCount}/${n} ~zero, range [${gMinAbs.toExponential(2)}, ${gMaxAbs.toExponential(2)}]`);
        }
        for (let j = 0; j < n; j++) {
          for (let k = 0; k <= j; k++) {
            let s = 0;
            for (let i = 0; i < m; i++) s += J[i][j] * J[i][k];
            A[j][k] = s;
            A[k][j] = s;
          }
        }
        
        if (iter < 3 || iter % 100 === 0) {
          let aMaxDiag = 0, aMinDiag = Infinity;
          for (let i = 0; i < n; i++) {
            const d = Math.abs(A[i][i]);
            aMaxDiag = Math.max(aMaxDiag, d);
            aMinDiag = Math.min(aMinDiag, d);
          }
          const cond = aMaxDiag / Math.max(1e-30, aMinDiag);
          console.log(`[DEBUG iter${iter}] Matrix A: diagRange [${aMinDiag.toExponential(2)}, ${aMaxDiag.toExponential(2)}], cond=${cond.toExponential(2)}`);
        }

        // --- 3. Apply Levenberg-Marquardt damping with Jacobi Preconditioning ---
        // 【修正】Aの要素が10^24等になるような場合、浮動小数点精度（約16桁）を完全に超えて破綻するため、
        // 対角成分が1.0になるように行列をスケール（事前処理）してから解く
        const scaleD = new Array(n);
        for (let i = 0; i < n; i++) {
          const d = A[i][i];
          scaleD[i] = (d > 1e-30) ? 1.0 / Math.sqrt(Math.abs(d)) : 1.0;
        }
        
        if (iter < 3 || iter % 100 === 0) {
          let scaleMinAbs = Infinity, scaleMaxAbs = 0;
          for (let i = 0; i < n; i++) {
            scaleMinAbs = Math.min(scaleMinAbs, Math.abs(scaleD[i]));
            scaleMaxAbs = Math.max(scaleMaxAbs, Math.abs(scaleD[i]));
          }
          console.log(`[DEBUG iter${iter}] Preconditioning scales: [${scaleMinAbs.toExponential(2)}, ${scaleMaxAbs.toExponential(2)}]`);
        }
        
        const Ad = Array.from({ length: n }, () => Array(n).fill(0));
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            Ad[i][j] = A[i][j] * scaleD[i] * scaleD[j];
          }
          // 対角成分は 1.0 になるので、そこにダンピングを足す
          Ad[i][i] = 1.0 + lmDamp;  
        }
        
        if (iter < 3 || iter % 100 === 0) {
          let adMaxDiag = 0, adMinDiag = Infinity;
          for (let i = 0; i < n; i++) {
            const d = Math.abs(Ad[i][i]);
            adMaxDiag = Math.max(adMaxDiag, d);
            adMinDiag = Math.min(adMinDiag, d);
          }
          const adCond = adMaxDiag / Math.max(1e-30, adMinDiag);
          console.log(`[DEBUG iter${iter}] Precond Matrix Ad: diagRange [${adMinDiag.toExponential(2)}, ${adMaxDiag.toExponential(2)}], cond=${adCond.toExponential(2)}`);
        }

        const b_scaled = g.map((v, i) => -v * scaleD[i]);
        
        // Validate preconditioned matrix before solving
        let isMatrixGood = true;
        for (let i = 0; i < n; i++) {
          const d = Ad[i][i];
          if (!Number.isFinite(d) || d <= 0) {
            isMatrixGood = false;
            break;
          }
        }
        
        let dx_scaled = null;
        if (isMatrixGood) {
          dx_scaled = solveSymmetricPositiveDefinite(Ad, b_scaled);
        }
        if (!dx_scaled) {
          dx_scaled = solveLinearSystemFallback(Ad, b_scaled);
        }
        if (!dx_scaled) {
          // Matrix solver failed: increase damping significantly and retry
          lmDamp = Math.min(1e12, lmDamp * 20);  // Increased multiplier from 10
          if (iter < 5 || iter % 20 === 0) {
            console.log(`[DEBUG] Matrix solve failed, increased lmDamp to ${lmDamp.toExponential(2)}`);
          }
          continue;
        }

        // スケールを元に戻して、元の変数空間の探索方向 dx を得る
        let dx = new Array(n);
        let dxHasNaN = false;
        for (let i = 0; i < n; i++) {
          const scaled = dx_scaled[i] * scaleD[i];
          dx[i] = scaled;
          if (!Number.isFinite(scaled)) {
            dxHasNaN = true;
          }
        }
        
        if (dxHasNaN) {
          // Step contains NaN/Inf: increase damping and retry
          lmDamp = Math.min(1e12, lmDamp * 15);
          if (iter < 3 || iter % 100 === 0) {
            console.log(`[DEBUG] Step contains NaN/Inf, increased lmDamp to ${lmDamp.toExponential(2)}`);
          }
          continue;
        }

        // --- 4. Apply trust region ---
        let maxAbs = 0;
        for (let i = 0; i < n; i++) {
          const si = varScales[i] || 1;
          const di = dx[i] / si;
          maxAbs = Math.max(maxAbs, Math.abs(di));
        }
        
        // 【修正】ステップが小さすぎる場合は再度damping をリセット
        // これにより、ill-conditioning から逃げることができる
        if (maxAbs < 1e-8 && lmDamp > 1e-3) {
          if (iter < 3 || iter % 100 === 0) {
            console.log(`[DEBUG] Step too small (${maxAbs.toExponential(2)}), resetting lmDamp from ${lmDamp.toExponential(2)}`);
          }
          lmDamp = 5e-4;  // 【最適化】リセット時も初期値に合わせる
          // 【修正】ここで mu を上げると、ストール時に「壁を高くする」悪循環になるので削除
          // The wall (penalty) is the problem when stalled; raising it won't help
          continue;  // Skip this iteration and recalculate
        }
        
        // 【修正】固定の delta ではなく、適応的トラスト領域を適用する
        // 予測精度（ρ）に応じて歩幅の限界を動的に伸縮させることで、細かい谷底でも進める
        const delta = trustRegionDeltaEff;
        if (Number.isFinite(maxAbs) && maxAbs > delta && maxAbs > 0) {
          const f = delta / maxAbs;
          for (let i = 0; i < n; i++) dx[i] *= f;
        }

        // --- 5. Line search ---
        // 【修正】Infeasibleな場合でも、必ず alpha=1（フルステップ）から試す！
        // ニュートン法系は alpha=1 で最も効率よく境界に到達する
        const alphas = preFeasible 
          ? [1, 0.5, 0.25]  // Feasible: 3回試行
          : [1, 0.5, 0.25, 0.125, 0.0625];  // Infeasible: フルステップから開始
        
        let accepted = false;
        let nextX = currentX.slice();
        let acceptedCost = cost0;
        let acceptedRho = 0;

        // 【追加】LM法と同じく、二次モデルによる予測減少量(pred)を計算する関数
        const predictedReductionForStep = (dxStep: number[]) => {
          try {
            let linearTerm = 0;
            for (let i = 0; i < n; i++) linearTerm += dxStep[i] * g[i];
            
            let quadTerm = 0;
            for (let i = 0; i < n; i++) {
              let sum = 0;
              for (let k = 0; k < n; k++) sum += A[i][k] * dxStep[k];
              quadTerm += dxStep[i] * sum;
            }
            quadTerm *= 0.5;
            
            const pred = -(linearTerm + quadTerm);
            return Number.isFinite(pred) ? pred : NaN;
          } catch (_) {
            return NaN;
          }
        };

        let lastAlpha = 0; // Track last alpha tried for progress reporting
        for (const alpha of alphas) {
          const dxStep = dx.map(v => alpha * v);
          const trialX = clampToBounds(currentX.map((x, i) => x + dxStep[i]));
          const aug1 = evalAugmentedResiduals(trialX, lambdaVec, mu, currentMaxViol);
          const r1 = aug1.residuals;
          const cost1 = r1.reduce((acc, v) => acc + v * v, 0);
          
          lastAlpha = alpha; // Track for progress report
          
          if (Number.isFinite(cost1) && cost1 < cost0) {
            accepted = true;
            nextX = trialX;
            acceptedCost = cost1;
            
            // 【追加】予測と実際の減少量の比 (rho) を計算
            const pred = predictedReductionForStep(dxStep);
            const act = cost0 - cost1;
            acceptedRho = (Number.isFinite(act) && Number.isFinite(pred) && pred > 1e-30) ? (act / pred) : 0;
            
            // Broyden状態の更新：次回のイテレーションで使用
            lastJ = J.map(row => row.slice()); // Deep copy
            lastX = currentX.slice();
            lastR = r0.slice();
            
            // 【最適化】Feasibleで最初の試行（alpha=1）に成功したら即座に終了
            if (preFeasible && alpha === 1) {
              break;  // Full step accepted, no need to try smaller steps
            }
            break;  // Accept and move to damping update
          }
        }
        
        // 【修正】ステップが受け入れられたかどうかで、Nielsenの適応的ダンピングを行う
        if (!accepted) {
          // 失敗：進まない。ダンピングを増やして次回はより安全な歩幅にする
          kktRejectStreak++;  // 【追加】Consecutive rejection counter
          
          // 【改善】3.0→2.0：さらに穏やかに増加して探索を続ける
          lmDamp = Math.min(1e12, lmDamp * 2.0);  // More conservative increase
          if (lmDamp > 1e9) lmDamp = 2e-4;  // スタック時はリセット（初期値に合わせる）
          
          // 【追加】リジェクト（失敗）時は歩幅の限界を狭めてより慎重にする
          trustRegionDeltaEff = Math.max(0.01, trustRegionDeltaEff * 0.5);
          
          // Broyden状態をリセット（リジェクト時は有限差分から再計算）
          lastJ = null;
          lastX = null;
          lastR = null;
          broydenSkipCount = 0;
          
          // 【追加】Auto Soft-Restart: ダンピングをリセットして別の角度から再探索
          // ただし、μ と λ（制約の「壁の記憶」）はリセットしない。何度も同じ壁にぶつかるループを防ぐため
          if (kktRejectStreak >= 12) {  // 【修正】8→12：リスタートを減らして収束を優先
            consecutiveRestarts++;
            console.log(`♻️ [AL] Auto soft-restart triggered at iter ${iter} (${kktRejectStreak} consecutive rejects, restart #${consecutiveRestarts})`);
            
            // 【新機能】連続リスタートが3回を超えたら、μを減らして脱出を試みる
            if (consecutiveRestarts >= 3 && mu > 10) {
              const oldMu = mu;
              mu = Math.max(1, mu * 0.5);  // μを半分にする
              console.log(`  ⚠️ [AL] Too many restarts (${consecutiveRestarts}), reducing μ: ${oldMu.toExponential(2)} → ${mu.toExponential(2)}`);
            }
            
            // 【修正】mu と lambdaVec はリセットしない。壁の記憶を保ったまま、ダンピングだけ安全な値に
            // mu = Math.max(1, ...);  <-- 削除：ペナルティ記憶を保つ
            // lambdaVec = [];         <-- 削除：ラグランジュ乗数の蓄積を保つ
            
            lmDamp = 1e-1;  // 安全な初期ダンピング値
            kktRejectStreak = 0;
            violStagnationIter = 0;
            currentX = bestX.slice();  // 一番良かった場所から再開
            
            // 【重要】bestXを設計変数に設定（これがないと評価が正しくない）
            for (let k = 0; k < n; k++) {
              if (jointState && varIds && k < varIds.length) {
                setJointDesignVariableValue(jointState, varIds[k], bestX[k]);
              } else if (activeCfg && varIds && k < varIds.length) {
                setDesignVariableValue(activeCfg, varIds[k], bestX[k]);
              }
            }
            
            // Broyden状態もリセット（再スタート時は有限差分から再計算）
            lastJ = null;
            lastX = null;
            lastR = null;
            broydenSkipCount = 0;
            
            continue;
          }
        } else {
          kktRejectStreak = 0;  // 【追加】Reset counter on success
          consecutiveRestarts = 0;  // 【追加】受理されたら連続リスタートもリセット
          currentX = nextX;
          
          // 【追加】ステップがアクセプトされた時点で、実際に設計変数をセット
          // これにより、UIが現在値を認識できるようになる
          for (let k = 0; k < n; k++) {
            if (jointState && varIds && k < varIds.length) {
              setJointDesignVariableValue(jointState, varIds[k], currentX[k]);
            }
          }
          
          // 成功：現在位置を更新し、ダンピングを rho に応じて滑らかに減らす（LM法と同じ戦略）
          const rhoThreshold = 0.25;  // Accept range: rho > 0.25 means good prediction
          let factor;
          if (acceptedRho > rhoThreshold) {
            // 【最適化】予測が良い場合はより積極的に減らす
            const smoothTerm = Math.pow(2 * acceptedRho - 1, 3);
            factor = Math.max(1.0 / 8.0, 1.0 - smoothTerm);  // 0.125-1.0（さらに積極的）
            factor = Math.max(0.08, Math.min(1.0, factor));  // 0.1→0.08：より積極的な減少
            
            // 【追加】予測精度が非常に高い場合は、トラスト領域を拡大して一気に進む
            if (acceptedRho > 0.75) {
              trustRegionDeltaEff = Math.min(2.0, trustRegionDeltaEff * 1.25);
            }
          } else if (acceptedRho > 0.004) {
            // 【改善】予測がまあまあ（0.004 < rho <= 0.25）の場合も穏やかに減らす
            factor = 0.75;  // 0.85 → 0.75（さらに積極的）
          } else {
            // 【改善】予測が悪い（rho <= 0.004）場合は増やす（ただしLM並みには保つ）
            factor = 1.5;  // 2.0 → 1.5（やや穏やかに）
            // 【追加】予測精度が低い場合は、トラスト領域を少し縮小する
            trustRegionDeltaEff = Math.max(0.01, trustRegionDeltaEff * 0.9);
          }
          lmDamp = Math.max(1e-12, lmDamp * factor);

          // 【修正】currentXはすでに設計変数に設定済み（Line 4757-4764）なので、
          // objectiveForKKT()ではなく直接評価する（変数の復元を避けるため）
          const currentEval = evalCompositeFromRequirementsProfiled();
          const currentScore = currentEval?.score ?? 1e9;
          lastAcceptedScore = currentScore;  // 【追加】アクセプトされたスコアを記録
          
          // 【重要修正】LM法と同じくrecordEval()を使ってBest管理を統一
          // これにより、feasible/infeasibleの自動判定とBest値の正確な追跡が可能になる
          recordEval(currentEval);
          const prevBestScore = bestScore;
          const bestEvalNow = getBestEvalSoFar();
          if (bestEvalNow) {
            bestScore = bestEvalNow.score;
            bestEval = bestEvalNow;
            // bestXは常に現在のcurrentXを保存（後で復元するため）
            bestX = currentX.slice();
            
            if (bestScore < prevBestScore) {
              const improvement = prevBestScore - bestScore;
              const currentConstraintEval = evalSQPAtX(currentX);
              const currentViolationVector = (currentConstraintEval.constraints || []).map(c => Math.max(0, c));
              const currentViolation = Math.sqrt(currentViolationVector.reduce((acc, v) => acc + v * v, 0));
              const status = currentEval.feasible ? '✓FEAS' : `Viol:${currentViolation.toExponential(2)}`;
              console.log(`🏆 [AL] Iter ${iter}: NEW BEST! Score: ${bestScore.toFixed(6)} (Δ${improvement.toFixed(3)}), ${status}, α=${lastAlpha.toFixed(3)}, ρ=${acceptedRho.toFixed(3)}`);
              
              if (onProgress) {
                try {
                  onProgress({ phase: 'accept', iter, current: bestScore, best: bestScore, method: 'kkt', feasible: currentEval.feasible, alpha: lastAlpha, rho: acceptedRho });
                } catch (_) {}
              }
            }
          }
          
          // bestMeritは参考値として計算（主にデバッグ用）
          const currentConstraintEval = evalSQPAtX(currentX);
          const currentViolationVector = (currentConstraintEval.constraints || []).map(c => Math.max(0, c));
          const currentViolation = Math.sqrt(currentViolationVector.reduce((acc, v) => acc + v * v, 0));
          bestMerit = bestScore + currentViolation * 10000;
        }
        
        // --- 6. Update Lagrange multipliers and penalty (Delayed Schedule) ---

        const post = evalSQPAtX(currentX);
        const c = post.constraints || [];
        if (lambdaVec.length !== c.length) lambdaVec = new Array(c.length).fill(0);
        
        let maxViol = 0;
        let activeViolations = 0;
        for (let i = 0; i < c.length; i++) {
          const ci = c[i];
          maxViol = Math.max(maxViol, ci);
          if (ci > 1e-6) activeViolations++;
        }

        // 【重要改善】ALM パラメータ（μ, λ）の遅延更新スケジュール
        // 失敗している（ストール中）時に地形を変えると、LM法の二次予測が永遠に外れるため、
        // 進捗がある時か定期的なイテレーションでのみ更新し、ストール中は地形を固定させる
        const costDiff = Math.abs(cost0 - acceptedCost);
        const relativeCostDiff = costDiff / Math.max(1e-10, cost0);
        const isProgressSlow = accepted && (relativeCostDiff < 1e-3);
        // 【修正】kktRejectStreak < 3 に緩和：完全に凍結すると無限ループに陥る
        const isTimeToUpdate = (isProgressSlow || (iter > 0 && iter % 15 === 0)) && kktRejectStreak < 3;

        if (isTimeToUpdate) {
          // Update multipliers only when landscape should change
          for (let i = 0; i < c.length; i++) {
            lambdaVec[i] = Math.max(0, lambdaVec[i] + mu * c[i]);
          }

          // Check constraint violation trend for penalty scaling
          if (Math.abs(maxViol - lastMaxViol) < 1e-3 * Math.max(1, lastMaxViol)) {
            violStagnationIter++;
          } else {
            violStagnationIter = 0;
          }
          lastMaxViol = maxViol;

          // Adaptive penalty update (only when updating ALM)
          let muMultiplier = 1.0;
          if (maxViol < 0.01) {
            muMultiplier = 1.0;  // 十分に改善中
          } else if (maxViol < 1.0) {
            muMultiplier = 1.1;
          } else {
            muMultiplier = 1.2;
          }
          
          if (violStagnationIter > 3) {
            muMultiplier = Math.max(1.2, muMultiplier * 1.5);
          }
          
          // 【修正】μ の上限を 1e5 に保つ（1e6 はペナルティが支配的になる）
          mu = Math.min(1e5, Math.max(1, mu * muMultiplier));
          
          // ALM更新時はBroyden状態をリセット（地形が変わったため）
          lastJ = null;
          lastX = null;
          lastR = null;
          broydenSkipCount = 0;
        } else {
          // On iterations where we don't update ALM, keep landscape stable for LM convergence
          if (iter % 100 === 0) {
            console.log(`  [AL ALM delayed] Landscape frozen. Updates only when: accepting steps AND kktRejectStreak==0 AND (progress<1e-3 OR iter%20==0)`);
          }
        }

        // Show progress every 10 iterations with current vs best
        if (iter % 10 === 0) {
          console.log(`📊 [AL] Iter ${iter}: Current=${lastAcceptedScore.toFixed(4)}, Best=${bestScore.toFixed(4)}, Δ=${(lastAcceptedScore-bestScore).toFixed(2)}, maxViol=${maxViol.toExponential(2)}, mu=${mu.toExponential(2)}, lmDamp=${lmDamp.toExponential(1)}, broyden=${broydenSkipCount}/6`);
        }

        // Convergence check: feasible + no improvement in cost
        if (maxViol <= 1e-6 && accepted) {
          const costChange = Math.abs(cost0 - r0.reduce((acc, v) => acc + v * v, 0));
          if (costChange < 1e-6) {  // 【修正】1e-8 → 1e-6：より緩い収束判定
            console.log('🎯 [AL] Converged at iter', iter, 'with score', bestScore.toFixed(6));
            break;
          }
        }

        if (onProgressKKT) {
          // 【修正】accepted時のコスト値を報告。UIが現在値の変化を認識できるように
          const displayScore = accepted ? objectiveForKKT(currentX) : bestScore;
          await onProgressKKT({
            iter: iter,
            current: displayScore,
            best: bestScore,
            feasible: post.feasible,
            alpha: lastAlpha,
            rho: acceptedRho,
            mu: mu,
            maxViol: maxViol,
            lmDamp: lmDamp
          });
        }

        // Report progress for UI update
        if (onProgress) {
          try {
            onProgress({
              phase: 'iter',
              iter: iter,
              current: lastAcceptedScore,
              best: bestScore,
              method: 'kkt',
              multiScenario,
              requirementCount: Array.isArray(expandedRequirements) ? expandedRequirements.length : 0,
              feasible: post.feasible,
              activeViolations: activeViolations,
              maxViolation: maxViol,
              alpha: lastAlpha,
              rho: acceptedRho,
              lmDamp: lmDamp,
              mu: mu
            });
          } catch (_) {}
          await nextFrame();
        }
      }

      const totalImprovement = initialScore - bestScore;
      const improvementPercent = (totalImprovement / Math.max(1e-10, initialScore)) * 100;
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📈 [AL] OPTIMIZATION COMPLETE`);
      console.log(`   Initial Score:  ${initialScore.toFixed(6)}`);
      console.log(`   🏆 Best Score:  ${bestScore.toFixed(6)}`);
      console.log(`   Improvement:    ${totalImprovement.toFixed(6)} (${improvementPercent.toFixed(2)}%)`);
      console.log(`   Best Merit:     ${bestMerit.toFixed(2)}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      const t1 = nowMs();
      
      // 【修正】LMメソッドと同じパターン：bestX を手動で適用せず、
      // recordEval() で保存された blocksSnapshot を直接復元する
      // これにより、Stop時も確実にベスト解が復元される
      console.log('🔧 [AL] Restoring best solution from snapshot...');
      try {
        const bestFinalEval = getBestEvalSoFar();
        if (bestFinalEval) {
          restoreBestSnapshotAndPersist({ finalEval: bestFinalEval, jointState, systemConfig, configsById, targetConfigIds });
          console.log(`✅ [AL] Best solution restored (Score: ${bestFinalEval.score.toFixed(6)})`);
        } else {
          console.warn('⚠️  [AL] No best evaluation found - keeping current state');
        }
      } catch (e) {
        console.error('❌ [AL] Error restoring/persisting best state:', e);
      }

      // Final sync to tables - this is critical to reflect values in UI
      try {
        if (window.ConfigurationManager && typeof window.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
          await window.ConfigurationManager.loadActiveConfigurationToTables({
            applyToUI: true,
            suppressOpticalSystemDataChanged: true,
          });
        }
      } catch (_) {}

      try {
        requestRefreshBlockInspector();
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

      // Get final best evaluation for progress reporting
      const bestFinalEval = getBestEvalSoFar();
      const finalScore = bestFinalEval ? bestFinalEval.score : bestScore;

      if (onProgress) {
        try {
          onProgress({
            phase: 'done',
            iter: maxIterations,
            current: finalScore,
            best: finalScore,
            ms: Math.round(t1 - t0),
            method: 'kkt',
            multiScenario,
            feasible: bestFinalEval?.feasible ?? false,
            violationScore: bestFinalEval?.violationScore ?? 0,
            softPenalty: bestFinalEval?.softPenalty ?? 0
          });
        } catch (_) {}
      }

      return {
        ok: true,
        before: initialScore,
        best: finalScore,
        iterations: maxIterations,
        variables: vars.length
      };
    } catch (e) {
      console.error('❌ [AL Optimizer] Fatal error:', e);
      return {
        ok: false,
        reason: `AL optimization error: ${String(e)}`
      };
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
      requestRefreshBlockInspector();
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
    requestRefreshBlockInspector();
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
      setBlocksOverrideGlobal(__prevBlocksOverride);
    } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined') {
        globalThis.__cooptOpticalSystemRowsOverride = __prevOpticalRowsOverride;
      }
    } catch (_) {}
    try {
      setScenarioOverrideGlobal((__prevScenarioOverride && typeof __prevScenarioOverride === 'object') ? __prevScenarioOverride : null);
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
  window['OptimizationMVP'] = {
    run: runOptimizationMVP,
    stop: () => { __optimizerStopRequested = true; }
  };
}
