// @ts-nocheck
/**
 * MVP optimizer (coordinate descent) for Blocks-based design variables.
 *
 * - Variables are defined in Blocks: variables[*].optimize.mode === 'V'
 * - Values are applied to blocks.parameters[*] (canonical)
 * - Objective is derived from System Requirements (hard/soft, all-scenarios)
 *
 * Supports constrained and unconstrained optimization methods:
 *   - 'cd': Coordinate Descent
 *   - 'lm': Levenberg-Marquardt
 *   - 'kkt': Augmented Lagrangian + Gauss-Newton (legacy value)
 *   - 'kkt-sqp': active-set KKT Sequential Quadratic Programming
 *
 * No UI is added; the entrypoint is exposed as window.OptimizationMVP.
 */

import { expandBlocksIntoConfiguration, expandBlocksToOpticalSystemRows } from '../data/block-schema.ts';
import { listDesignVariablesFromBlocks, setDesignVariableValue } from './design-variables.ts';
import { findSimilarGlassesByNdVd, getGlassDataWithSellmeier } from '../data/glass.ts';
import { loadSystemConfigurations, saveSystemConfigurations } from '../data/table-configuration.ts';
import { tryLoadPersistedTableData as tryLoadPersistedOpticalSystemTableData } from '../data/table-optical-system.ts';
import { loadTableData as loadSystemRequirementsTableData } from '../data/table-system-requirements.ts';
import { requestRefreshBlockInspector } from '../core/window-facade.ts';
import { getWindowDebugBagValue, setWindowDebugBagValue } from '../utils/window-debug-bag.ts';
import { runKKTOptimization } from './kkt-optimizer.ts';
import { calculateParaxialData, calculateImageSpaceDiffractionParams } from '../raytracing/core/ray-paraxial.ts';
import {
  preloadOptimizerWasmBridge,
  solveLinearSystemWithOptimizerWasm,
  buildNormalEquationsWithOptimizerWasm,
  normalEqMatvecFlatWasm,
  normalEqMatvecWasm,
  getOptimizerWasmBridgeDebugInfo,
  generateFiniteDifferencePerturbationPointsWasm,
  assembleFiniteDifferenceJacobianGroupedWasm,
  optimizeSystemOneIterationWasm,
  backtrackingLineSearchArmijoWasm,
  updateTrustRegionRadiusWasm,
  solveQpSubproblemKktEqualityWasm,
  solveQpSubproblemUnconstrainedWasm
} from '../rust-wasm/ts/optimization/optimizer-wasm-bridge.ts';
import { isTauriRuntime } from '../src/desktop/runtime.ts';
import { evaluateOptimizerCandidates, evaluateOptimizerCandidatesMultiScenario, runMtfBatchViaWasm, runOptimizerStep, requestOptimizerStop, dropOptimizerSession, clearOptimizerStop } from '../src/desktop/ipc/client.ts';
import { OPERAND_DEFINITIONS } from '../ui/editors/merit-function-inspector.ts';
import { loadOptimizeRayGridSize, optimizeRayCountFromGridSize } from '../ui/optimization-settings-storage.ts';
import {
  adaptiveSpotIterationsUntilNextTransition,
  adaptiveSpotRayCountAtIteration,
  createAdaptiveSpotSamplingPlan,
} from './adaptive-spot-sampling.ts';
import {
  buildSqpLineSearchAlphas,
  buildSqpModelGradientFallbackDirection,
  isBetterSqpLookaheadCandidate,
} from './sqp-step-lookahead.ts';
import {
  initializeAdaptiveSqpDamping,
  shouldRollbackRejectedSqpState,
  sqpHessianDiagonalScale,
  updateAdaptiveSqpDamping,
} from './adaptive-sqp-damping.ts';

export const OPTIMIZER_POLICY_ID = 'bf3760cb-july28-recovery-runtime-batching';

let __optimizerStopRequested = false;

function shouldProfileNativeOptimizer(): boolean {
  try {
    const g = (typeof window !== 'undefined') ? (window as any) : null;
    return !!(g && (g.__COOPT_PROFILE_OPTIMIZER === true || g.__OPD_DEBUG === true));
  } catch (_) {
    return false;
  }
}

function logNativeOptimizerProfile(resp: any, context: { method: string; iterStart: number; iterDone: number }): void {
  const profile = resp?.profile;
  const entries = Array.isArray(profile?.operandEntries) ? profile.operandEntries : [];
  if (!profile || entries.length === 0) return;
  const topEntries = entries.slice(0, 8).map((entry: any) => ({
    key: entry?.key,
    operand: entry?.operand,
    count: Number(entry?.count) || 0,
    cacheHits: Number(entry?.cacheHits) || 0,
    cacheMisses: Number(entry?.cacheMisses) || 0,
    totalMs: Number(entry?.totalMs) || 0,
    avgMs: Number(entry?.avgMs) || 0,
    maxMs: Number(entry?.maxMs) || 0,
  }));
  console.info('[OptimizerProfile]', {
    method: context.method,
    iterStart: context.iterStart,
    iterDone: context.iterDone,
    evaluateStateCalls: Number(profile?.evaluateStateCalls) || 0,
    requirementPasses: Number(profile?.requirementPasses) || 0,
    topOperands: topEntries,
  });
}

async function runOptimizationMvpnative(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;
  const userShouldStop = (typeof opts.shouldStop === 'function') ? opts.shouldStop : null;
  const enableOptimizerProfiling = shouldProfileNativeOptimizer();

  try { await clearOptimizerStop(); } catch (_) {}

  let shouldRestorePreviousOpticalRowsOverride = true;
  const shouldStopNow = () => {
    if (__optimizerStopRequested) return true;
    try {
      return !!(userShouldStop && userShouldStop());
    } catch (_) {
      return false;
    }
  };

  if (__optimizerStopRequested) {
    return { ok: true, aborted: true, reason: 'stopped-before-start' };
  }

  const opticalSystemRows = (() => {
    if (Array.isArray(opts.opticalSystemRows) && opts.opticalSystemRows.length > 0) {
      return opts.opticalSystemRows;
    }
    try {
      if (typeof window !== 'undefined' && typeof (window as any).getOpticalSystemRows === 'function') {
        return (window as any).getOpticalSystemRows((window as any).tableOpticalSystem);
      }
    } catch (_) {}
    return [];
  })();

  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
    return { ok: false, reason: 'No opticalSystemRows for native optimization' };
  }

  const systemRequirementsRows = applyOptimizerRequirementSampling((() => {
    if (Array.isArray(opts.systemRequirementsRows) && opts.systemRequirementsRows.length > 0) {
      return opts.systemRequirementsRows;
    }
    try {
      const w = window as any;
        const cfg = (typeof w.loadSystemConfigurationsFromTableConfig === 'function')
          ? w.loadSystemConfigurationsFromTableConfig()
          : (typeof w.loadSystemConfigurations === 'function' ? w.loadSystemConfigurations() : null);
        if (Array.isArray(cfg?.systemRequirements) && cfg.systemRequirements.length > 0) {
          return cfg.systemRequirements;
        }
      } catch (_) {}
      try {
        const sre = (window as any).systemRequirementsEditor;
        if (sre && typeof sre.getData === 'function') {
          const rows = sre.getData();
          if (Array.isArray(rows)) return rows;
        }
      } catch (_) {}
      return [];
    })(), opts.spotRayCountFast, opts.mtfSamplingSizeFast);

  const sourceRows = (() => {
    if (Array.isArray(opts.sourceRows) && opts.sourceRows.length > 0) {
      return opts.sourceRows;
    }
    try {
      const table = (window as any).tableSource;
      if (table && typeof table.getData === 'function') {
        const rows = table.getData();
        if (Array.isArray(rows)) return rows;
      }
    } catch (_) {}
    return [];
  })();

  const objectRows = (() => {
    if (Array.isArray(opts.objectRows) && opts.objectRows.length > 0) {
      return opts.objectRows;
    }
    try {
      const table = (window as any).tableObject;
      if (table && typeof table.getData === 'function') {
        const rows = table.getData();
        if (Array.isArray(rows)) return rows;
      }
    } catch (_) {}
    return [];
  })();

  const activeConfigId = (() => {
    if (opts.activeConfigId !== undefined && opts.activeConfigId !== null) {
      return String(opts.activeConfigId).trim();
    }
    try {
      const w = window as any;
      const cfg = (typeof w.loadSystemConfigurationsFromTableConfig === 'function')
        ? w.loadSystemConfigurationsFromTableConfig()
        : (typeof w.loadSystemConfigurations === 'function' ? w.loadSystemConfigurations() : null);
      if (cfg && cfg.activeConfigId !== undefined && cfg.activeConfigId !== null) {
        return String(cfg.activeConfigId).trim();
      }
    } catch (_) {}
    return '';
  })();

  const methodRaw = String(opts.method || 'kkt').trim().toLowerCase();
  const normalizedMethod = methodRaw === 'global' || methodRaw === 'escape' || methodRaw === 'escapefunction' ? 'global-al' : methodRaw;
  const method = (normalizedMethod === 'cd' || normalizedMethod === 'lm' || normalizedMethod === 'kkt' || normalizedMethod === 'kkt-sqp' || normalizedMethod === 'global-al' || normalizedMethod === 'global-lm') ? normalizedMethod : 'kkt';

  const systemConfigSnapshot = (() => {
    if (opts.systemConfigSnapshot && typeof opts.systemConfigSnapshot === 'object') {
      try { return JSON.parse(JSON.stringify(opts.systemConfigSnapshot)); } catch (_) {}
      return opts.systemConfigSnapshot;
    }
    try {
      const w = window as any;
      const cfg = (typeof w.loadSystemConfigurationsFromTableConfig === 'function')
        ? w.loadSystemConfigurationsFromTableConfig()
        : (typeof w.loadSystemConfigurations === 'function' ? w.loadSystemConfigurations() : null);
      if (cfg && typeof cfg === 'object') {
        try { return JSON.parse(JSON.stringify(cfg)); } catch (_) { return cfg; }
      }
    } catch (_) {}
    return null;
  })();
  const scopedSystemRequirementsRows = expandRequirementScopesForOptimizer(
    systemRequirementsRows,
    systemConfigSnapshot,
    activeConfigId,
    sourceRows
  );
  const maxIterations = Number.isFinite(Number(opts.maxIterations))
    ? Math.max(1, Math.floor(Number(opts.maxIterations)))
    : 20;
  const adaptiveSpotSamplingPlan = createAdaptiveSpotSamplingPlan(
    opts.spotRayCountFast,
    maxIterations,
    opts.adaptiveSpotSampling !== false,
    opts.adaptiveSpotFinalFraction,
  );
  const shouldSkipLiveTableSync = (() => {
    try {
      return isTauriRuntime();
    } catch (_) {
      return false;
    }
  })();
  // Smaller chunks (5) for more responsive Stop button, avoiding UI freeze
  const chunkIterations = Number.isFinite(Number(opts.nativeChunkIterations))
    ? Math.max(1, Math.floor(Number(opts.nativeChunkIterations)))
    : Math.min(5, maxIterations);

  const readRequirementTableScoreSnapshot = () => {
    try {
      const sre = (window as any).systemRequirementsEditor;
      if (sre && typeof sre.getData === 'function') {
        const rr = sre.getData();
        if (Array.isArray(rr)) {
          let sum = 0;
          let cnt = 0;
          for (const row of rr) {
            const weight = Number(row?.weight ?? 1);
            const enabled = (row?.enabled === undefined || row?.enabled === null) ? true : !!row.enabled;
            const operand = String(row?.operand ?? '').trim();
            if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) continue;
            const contribution = Number.isFinite(Number(row?._contribution)) ? Number(row._contribution) : Number(row?.score);
            if (Number.isFinite(contribution) && contribution > 0) {
              sum += contribution;
              cnt += 1;
            }
          }
          return {
            score: (cnt > 0 && Number.isFinite(sum)) ? sum : Number.NaN,
            reqCount: cnt,
          };
        }
      }
    } catch (_) {}
    return { score: Number.NaN, reqCount: Number.NaN };
  };

  const refreshRequirementTableScore = async (reason: string) => {
    try {
      const sre = (window as any).systemRequirementsEditor;
      if (sre && typeof sre.flushPendingEdits === 'function') {
        const flushed = sre.flushPendingEdits();
        if (flushed && typeof flushed.then === 'function') await flushed;
      }
      if (sre && typeof sre.evaluateAndUpdateNow === 'function') {
        const p = sre.evaluateAndUpdateNow({ reason, forceSilent: true, silent: true });
        if (p && typeof p.then === 'function') await p;
      }
    } catch (_) {}
    return readRequirementTableScoreSnapshot();
  };

  let initialDisplayScore = Number.NaN;
  let bestDisplayScore = Number.NaN;
  try {
    const initialSnap = readRequirementTableScoreSnapshot();
    if (Number.isFinite(Number(initialSnap?.score))) {
      initialDisplayScore = Number(initialSnap.score);
      bestDisplayScore = initialDisplayScore;
    }
  } catch (_) {}

  // Do not block optimizer startup on a full requirements reevaluation.
  // Heavy operands like OPD_RMS_WAVES can take noticeable time here, but the
  // optimizer uses the native requirement rows directly and does not need this
  // UI refresh before phase start.
  try {
    void refreshRequirementTableScore(`optimize-native-${method}-start`);
  } catch (_) {}

  const sessionId = `native-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  let consumedIterations = 0;
  let rowsWorking = opticalSystemRows;
  let lastResp: any = null;
  let aborted = false;
  let errorMessage: string | null = null;
  let finalDisplayScore = Number.NaN;
  let lastNativeSpotRayCount = Number.NaN;
  let forceFinalSpotSampling = false;

  try {
    while (consumedIterations < maxIterations) {
      if (shouldStopNow()) {
        aborted = true;
        try { await requestOptimizerStop(); } catch (_) {}
        break;
      }

      const nativeSpotRayCount = adaptiveSpotRayCountAtIteration(
        adaptiveSpotSamplingPlan,
        consumedIterations,
        forceFinalSpotSampling,
      );
      const samplingStageChanged = nativeSpotRayCount !== lastNativeSpotRayCount;
      const iterationsUntilSamplingTransition = adaptiveSpotIterationsUntilNextTransition(
        adaptiveSpotSamplingPlan,
        consumedIterations,
        forceFinalSpotSampling,
      );
      const iterBudget = Math.max(1, Math.min(
        chunkIterations,
        maxIterations - consumedIterations,
        iterationsUntilSamplingTransition,
      ));
      const chunkRequirementRows = applyOptimizerRequirementSampling(
        scopedSystemRequirementsRows,
        nativeSpotRayCount,
        opts.mtfSamplingSizeFast,
      );
      let resp: any = null;
      
      try {
        resp = await runOptimizerStep({
          opticalSystemRows: rowsWorking,
          sourceRows,
          objectRows,
          activeConfigId,
          systemConfigSnapshot,
          systemRequirementsRows: chunkRequirementRows,
          sessionId,
          resetSession: consumedIterations === 0 || samplingStageChanged,
          maxIterations: iterBudget,
          method,
          emitProgress: true,
          profile: enableOptimizerProfiling,
          penaltyParameter: 1.0,
          penaltyIncreaseFactor: 1.5,
          lineSearchC: 1e-4,
          lineSearchRho: 0.5,
          lineSearchMaxBacktrack: 20,
        });
      } catch (err: any) {
        const errMsg = String(err?.message || err || 'Unknown optimizer error');
        console.error('[Optimizer Native Error]', errMsg);
        errorMessage = errMsg;
        if (onProgress) {
          try {
            onProgress({
              phase: 'error',
              iter: consumedIterations,
              current: Number.NaN,
              best: Number.NaN,
              accepted: false,
              variableId: undefined,
              method: method,
              violationScore: Number.NaN,
            });
          } catch (_) {}
        }
        aborted = true;
        break;
      }

      lastResp = resp;
      lastNativeSpotRayCount = nativeSpotRayCount;
      const iterDone = Number.isFinite(Number(resp?.iterations))
        ? Math.max(0, Math.floor(Number(resp.iterations)))
        : iterBudget;

      if (enableOptimizerProfiling) {
        logNativeOptimizerProfile(resp, {
          method: String(resp?.modeUsed || method),
          iterStart: consumedIterations,
          iterDone,
        });
      }

      if (Array.isArray(resp?.optimizedRows) && resp.optimizedRows.length > 0) {
        rowsWorking = resp.optimizedRows;
        if (!shouldSkipLiveTableSync) {
          try {
            const table = (window as any).tableOpticalSystem;
            if (table && typeof table.setData === 'function') {
              await table.setData(rowsWorking);
            }
          } catch (_) {}
        }
      }

      if (onProgress && Array.isArray(resp?.progressEvents)) {
        for (const ev of resp.progressEvents) {
          const localIter = Number.isFinite(Number(ev?.iter)) ? Math.max(0, Number(ev.iter)) : 0;
          const globalIter = Math.min(maxIterations, consumedIterations + localIter);
          const isInitialStart = consumedIterations === 0
            && localIter === 0
            && String(ev?.phase || '').trim().toLowerCase() === 'start';
          const progressCurrent = isInitialStart && Number.isFinite(initialDisplayScore)
            ? initialDisplayScore
            : ev?.current;
          const progressBest = isInitialStart && Number.isFinite(initialDisplayScore)
            ? initialDisplayScore
            : ev?.best;
          try {
            onProgress({
              phase: ev?.phase,
              iter: globalIter,
              current: progressCurrent,
              best: progressBest,
              accepted: ev?.accepted,
              rows: ev?.accepted ? rowsWorking : undefined,
              variableId: ev?.variableId,
              method: resp?.modeUsed || method,
              violationScore: ev?.violationScore,
              equalViolation: ev?.equalViolation,
              inequalViolation: ev?.inequalViolation,
              dampingFactor: ev?.dampingFactor,
              rho: ev?.rho,
              alpha: ev?.alpha,
              feasible: ev?.feasible,
              softPenalty: ev?.softPenalty,
            });
          } catch (_) {}
        }
      }

      consumedIterations += iterDone;

      const respMessage = String(resp?.message || '').toLowerCase();
      const stoppedByRust = respMessage.includes('stopped');
      if (stoppedByRust) {
        aborted = true;
        break;
      }
      if (!!resp?.converged || iterDone <= 0) {
        if (adaptiveSpotSamplingPlan.enabled && nativeSpotRayCount !== adaptiveSpotSamplingPlan.finalRayCount) {
          forceFinalSpotSampling = true;
          continue;
        }
        break;
      }
    }
  } finally {
    try { await dropOptimizerSession(sessionId); } catch (_) {}
  }

  const resp = lastResp || {
    iterations: 0,
    variableCount: 0,
    meritBefore: 0,
    meritAfter: 0,
    converged: false,
    modeUsed: method,
    requirementScoreAfter: Number.NaN,
    optimizedRows: rowsWorking,
    progressEvents: [],
    message: errorMessage || (aborted ? 'optimizer stopped by user' : 'no native optimizer response'),
  };

  const nativeFailure = !!errorMessage;

  try {
    if (Array.isArray(resp.optimizedRows) && resp.optimizedRows.length > 0) {
      const table = (window as any).tableOpticalSystem;
      if (table && typeof table.setData === 'function') {
        await table.setData(resp.optimizedRows);
      }
    }
  } catch (_) {}

  return {
    ok: !nativeFailure,
    aborted,
    before: Number(resp?.meritBefore) || 0,
    best: Number(resp?.meritAfter) || 0,
    requirementScoreBefore: Number.isFinite(initialDisplayScore)
      ? initialDisplayScore
      : Number(resp?.requirementScoreBefore ?? resp?.meritBefore) || 0,
    iterations: consumedIterations > 0 ? consumedIterations : (Number(resp?.iterations) || 0),
    variables: Number(resp?.variableCount) || 0,
    method: String(resp?.modeUsed || method),
    feasible: (Number(resp?.requirementScoreAfter) || 0) <= 1e-9,
    violationScore: Number(resp?.requirementScoreAfter) || 0,
    softPenalty: 0,
    hardViolations: [],
    softViolations: [],
    reason: nativeFailure ? String(errorMessage || 'native optimization failed') : undefined,
    nativeMessage: String(resp?.message || ''),
  };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function getActiveRequirementRowsForOptimizer(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  if (Array.isArray(opts.systemRequirementsRows) && opts.systemRequirementsRows.length > 0) {
    return opts.systemRequirementsRows;
  }
  try {
    const w = window as any;
    const cfg = (typeof w.loadSystemConfigurationsFromTableConfig === 'function')
      ? w.loadSystemConfigurationsFromTableConfig()
      : (typeof w.loadSystemConfigurations === 'function' ? w.loadSystemConfigurations() : null);
    if (Array.isArray(cfg?.systemRequirements) && cfg.systemRequirements.length > 0) {
      return cfg.systemRequirements;
    }
  } catch (_) {}
  try {
    const sre = (window as any).systemRequirementsEditor;
    if (sre && typeof sre.getData === 'function') {
      const rows = sre.getData();
      if (Array.isArray(rows)) return rows;
    }
  } catch (_) {}
  return [];
}

function applyOptimizerRequirementSampling(requirementRows, rayCount, mtfSamplingSize) {
  if (!Array.isArray(requirementRows)) return [];
  const count = Math.max(1, Math.floor(Number(rayCount) || 1));
  const mtfSampling = Math.max(16, Math.min(4096, Math.floor(Number(mtfSamplingSize) || 16)));
  return requirementRows.map((row) => {
    const operand = String(row?.operand ?? '').trim().toUpperCase();
    if (operand === 'SPOT_SIZE_ANNULAR' || operand === 'SPOT_SIZE_RECT' || operand === 'SPOT_SIZE_CURRENT') {
      return { ...row, param4: String(count) };
    }
    if (operand === 'MTFT' || operand === 'MTFS' || operand === 'MTFA' || operand === 'MTF') {
      return { ...row, param5: String(mtfSampling) };
    }
    return row;
  });
}

const NATIVE_OPTIMIZER_REQUIREMENT_OPERANDS = new Set([
    'OBJD', 'TSL', 'CTCT', 'SDIST',
    'IMD',
    'BEXP', 'EXPD', 'EXPP', 'ENPD', 'ENPP', 'ENPM',
    'PMAG', 'FNO_OBJ', 'FNO_IMG', 'FNO_WRK', 'NA_OBJ', 'NA_IMG',
    'EDGE',
    'SPOT_SIZE_ANNULAR', 'SPOT_SIZE_RECT', 'SPOT_SIZE_CURRENT',
    'TA_RMS_UM',
    'TOT3_SPH', 'TOT3_COMA', 'TOT3_ASTI', 'TOT3_FCUR', 'TOT3_DIST', 'TOT_LCA', 'TOT_TCA',
    'REAY', 'RSCE', 'TRAC', 'DIST'
]);

function isNativeOptimizerRequirementOperand(operand) {
  return NATIVE_OPTIMIZER_REQUIREMENT_OPERANDS.has(String(operand ?? '').trim().toUpperCase());
}

function findUnsupportedNativeRequirementOperands(requirementRows = []) {

  const unsupported = new Set();
  for (const row of Array.isArray(requirementRows) ? requirementRows : []) {
    if (!row || typeof row !== 'object') continue;
    const enabled = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
    const operand = String(row.operand ?? '').trim();
    const weight = Number(row.weight ?? 1);
    if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) continue;
    if (!isNativeOptimizerRequirementOperand(operand)) unsupported.add(operand);
  }
  return Array.from(unsupported);
}

function hasAsyncPreferredRequirementOperands(requirementRows = []) {
  const asyncPreferredOperands = new Set([
    'TOT3_SPH',
    'TOT3_COMA',
    'TOT3_ASTI',
    'TOT3_FCUR',
    'TOT3_DIST',
    'TOT3_PETZ',
    'TOT_LCA',
    'TOT_TCA',
    'FL',
    'EFL',
    'BFL',
    'IMD',
    'OBJD',
    'TSL',
    'BEXP',
    'EXPD',
    'EXPP',
    'ENPD',
    'ENPP',
    'ENPM',
    'PMAG',
    'FNO_OBJ',
    'FNO_IMG',
    'FNO_WRK',
    'NA_OBJ',
    'NA_IMG',
    'SPOT_SIZE_ANNULAR',
    'SPOT_SIZE_RECT',
    'SPOT_SIZE_CURRENT',
    'CRA_DEG',
    'LA_RMS_UM',
    'TA_RMS_UM',
    'OPD_RMS_WAVES',
    'OPD_RMS_UM',
    'ZERN_COEFF',
    'SA',
    'MTFT',
    'MTFS',
    'MTFA',
  ]);
  for (const row of Array.isArray(requirementRows) ? requirementRows : []) {
    if (!row || typeof row !== 'object') continue;
    const enabled = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
    const operand = String(row.operand ?? '').trim();
    const weight = Number(row.weight ?? 1);
    if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) continue;
    if (asyncPreferredOperands.has(operand)) {
      return true;
    }
  }
  return false;
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

function optimizerOperandCacheKey(item) {
  const requirement = item?.req || {};
  return [
    String(item?.configId ?? ''),
    String(item?.scenarioId ?? ''),
    String(requirement?.operand ?? ''),
    String(requirement?.param1 ?? ''),
    String(requirement?.param2 ?? ''),
    String(requirement?.param3 ?? ''),
    String(requirement?.param4 ?? ''),
    String(requirement?.param5 ?? '')
  ].join('|');
}

async function prefetchOptimizerSpotRequirementGroups(editor, items, operandValueCache) {
  if (!editor || typeof editor.calculateSpotSizeBatchViaNativeAsync !== 'function') return;
  if (typeof window !== 'undefined' && (window as any).__cooptDisableRequirementRustFirst === true) return;
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const requirement = item?.req;
    const operand = String(requirement?.operand ?? '').trim().toUpperCase();
    if (!requirement?.enabled || !['SPOT_SIZE_ANNULAR', 'SPOT_SIZE_RECT', 'SPOT_SIZE_CURRENT'].includes(operand)) continue;
    const cacheKey = optimizerOperandCacheKey(item);
    if (operandValueCache.has(cacheKey)) continue;
    const pattern = operand === 'SPOT_SIZE_RECT' ? 'grid' : 'annular';
    const groupKey = [
      String(item?.configId ?? ''),
      String(item?.scenarioId ?? ''),
      pattern,
      String(requirement?.param1 ?? ''),
      String(requirement?.param4 ?? ''),
      String(requirement?.param5 ?? '')
    ].join('|');
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ item, cacheKey });
  }

  const previousOverride = getScenarioOverrideGlobal();
  const overrideMap = previousOverride && typeof previousOverride === 'object' ? { ...previousOverride } : {};
  try {
    for (const group of groups.values()) {
      if (!Array.isArray(group) || group.length < 2) continue;
      const firstItem = group[0]?.item;
      const configId = String(firstItem?.configId ?? '');
      if (firstItem?.scenarioId) overrideMap[configId] = String(firstItem.scenarioId);
      else delete overrideMap[configId];
      setScenarioOverrideGlobal(overrideMap);
      const values = await editor.calculateSpotSizeBatchViaNativeAsync(group.map(entry => ({
        ...entry.item.req,
        configId,
      })));
      if (!Array.isArray(values) || values.length !== group.length) continue;
      for (let index = 0; index < group.length; index++) {
        const value = Number(values[index]);
        if (!Number.isFinite(value)) continue;
        operandValueCache.set(group[index].cacheKey, value);
        bumpOptimizerProfileCount('operandValueCacheHits', 1);
        bumpOptimizerProfileCount('spotRequirementBatchValues', 1);
      }
      bumpOptimizerProfileCount('spotRequirementBatchCalls', 1);
    }
  } finally {
    setScenarioOverrideGlobal(previousOverride && typeof previousOverride === 'object' ? previousOverride : null);
  }
}

async function prefetchOptimizerAsyncRequirementGroups(editor, items, operandValueCache) {
  if (!editor || typeof editor.calculateOperandValueAsync !== 'function') return;
  const asyncPrefetchOperands = new Set([
    'TA_RMS_UM',
    'OPD_RMS_WAVES',
    'OPD_RMS_UM',
    'CRA_DEG',
    'LA_RMS_UM',
    'SA',
    'ZERN_COEFF',
  ]);
  const groups = new Map<string, Array<any>>();
  const taGroups = new Map<string, Array<any>>();
  for (const item of Array.isArray(items) ? items : []) {
    const requirement = item?.req;
    const operand = String(requirement?.operand ?? '').trim().toUpperCase();
    const weight = Math.max(0, toFiniteNumber(requirement?.weight, 1)) * Math.max(0, toFiniteNumber(item?.scenarioWeight, 1));
    if (!requirement?.enabled || !asyncPrefetchOperands.has(operand) || !(weight > 0)) continue;
    const cacheKey = optimizerOperandCacheKey(item);
    if (operandValueCache.has(cacheKey)) continue;
    const configId = String(item?.configId ?? requirement?.configId ?? '');
    const scenarioId = item?.scenarioId ? String(item.scenarioId) : '';
    const groupKey = `${configId}|${scenarioId}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)?.push({
      cacheKey,
      opObj: {
        operand: requirement.operand,
        configId,
        param1: requirement.param1,
        param2: requirement.param2,
        param3: requirement.param3,
        param4: requirement.param4,
        param5: requirement.param5,
        target: requirement.target,
        weight: requirement.weight,
      },
    });
    if (operand === 'TA_RMS_UM') {
      if (!taGroups.has(groupKey)) taGroups.set(groupKey, []);
      taGroups.get(groupKey)?.push({
        cacheKey,
        opObj: {
          operand: requirement.operand,
          configId,
          param1: requirement.param1,
          param2: requirement.param2,
          param3: requirement.param3,
          param4: requirement.param4,
          param5: requirement.param5,
          target: requirement.target,
          weight: requirement.weight,
        },
      });
    }
  }
  if (groups.size === 0) return;

  const previousOverride = getScenarioOverrideGlobal();
  const overrideMap = previousOverride && typeof previousOverride === 'object' ? { ...previousOverride } : {};
  let prefetchedValues = 0;
  let prefetchFailures = 0;
  try {
    for (const [groupKey, entries] of groups.entries()) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      const sep = groupKey.indexOf('|');
      const configId = sep >= 0 ? groupKey.slice(0, sep) : groupKey;
      const scenarioId = sep >= 0 ? groupKey.slice(sep + 1) : '';
      if (scenarioId) overrideMap[configId] = scenarioId;
      else delete overrideMap[configId];
      setScenarioOverrideGlobal(overrideMap);

      const taEntries = taGroups.get(groupKey) || [];
      if (taEntries.length > 1 && typeof editor.calculateTransverseAberrationRmsBatchViaNativeAsync === 'function') {
        try {
          const taValues = await editor.calculateTransverseAberrationRmsBatchViaNativeAsync(taEntries.map((entry) => entry.opObj));
          if (Array.isArray(taValues) && taValues.length === taEntries.length) {
            for (let index = 0; index < taEntries.length; index++) {
              const value = Number(taValues[index]);
              if (!Number.isFinite(value)) continue;
              operandValueCache.set(taEntries[index].cacheKey, value);
              bumpOptimizerProfileCount('operandValueCacheHits', 1);
              prefetchedValues += 1;
            }
            bumpOptimizerProfileCount('kktTaBatchPrefetchCalls', 1);
            bumpOptimizerProfileCount('kktTaBatchPrefetchSeededValues', taEntries.length);
          }
        } catch (_) {
          prefetchFailures += taEntries.length;
          bumpOptimizerProfileCount('kktTaBatchPrefetchFailures', 1);
        }
      }

      const concurrency = Math.max(1, Math.min(4, entries.length));
      let cursor = 0;
      const workers = new Array(concurrency).fill(null).map(async () => {
        for (;;) {
          const nextIndex = cursor;
          cursor += 1;
          if (nextIndex >= entries.length) break;
          const entry = entries[nextIndex];
          if (operandValueCache.has(entry.cacheKey)) continue;
          try {
            const value = await editor.calculateOperandValueAsync(entry.opObj);
            const n = Number(value);
            if (!Number.isFinite(n)) continue;
            operandValueCache.set(entry.cacheKey, n);
            bumpOptimizerProfileCount('operandValueCacheHits', 1);
            prefetchedValues += 1;
          } catch (_) {
            prefetchFailures += 1;
          }
        }
      });
      await Promise.all(workers);
      bumpOptimizerProfileCount('kktAsyncPrefetchGroups', 1);
    }
  } finally {
    setScenarioOverrideGlobal(previousOverride && typeof previousOverride === 'object' ? previousOverride : null);
  }

  bumpOptimizerProfileCount('kktAsyncPrefetchCalls', 1);
  if (prefetchedValues > 0) bumpOptimizerProfileCount('kktAsyncPrefetchSeededValues', prefetchedValues);
  if (prefetchFailures > 0) bumpOptimizerProfileCount('kktAsyncPrefetchFailures', prefetchFailures);
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

function getLastOptimizeProfile() {
  const p = getWindowDebugBagValue('optimizerMvp', 'lastOptimizeProfile', null);
  return (p && typeof p === 'object') ? p : null;
}

function pickTimingMetricsFromProfile(profile) {
  const objectiveMs = Number(profile?.time_objective_eval) || 0;
  const wasmMs = Number(profile?.time_wasm_call) || 0;
  const jsMs = Number(profile?.time_js_overhead) || 0;
  const totalMeasured = Math.max(1e-9, objectiveMs + wasmMs + jsMs);
  const pilotCalls = Number(profile?.kktWasmPilotCalls ?? profile?.counts?.kktWasmPilotCalls) || 0;
  const pilotHits = Number(profile?.kktWasmPilotHits ?? profile?.counts?.kktWasmPilotHits) || 0;
  const pilotFallbacks = Number(profile?.kktWasmPilotFallbacks ?? profile?.counts?.kktWasmPilotFallbacks) || 0;
  const bufferCalls = Number(profile?.kktWasmBufferCalls ?? profile?.counts?.kktWasmBufferCalls) || 0;
  const bufferHits = Number(profile?.kktWasmBufferHits ?? profile?.counts?.kktWasmBufferHits) || 0;
  const bufferFallbacks = Number(profile?.kktWasmBufferFallbacks ?? profile?.counts?.kktWasmBufferFallbacks) || 0;
  const matrixFreeCalls = Number(profile?.kktMatrixFreeCalls ?? profile?.counts?.kktMatrixFreeCalls) || 0;
  const matrixFreeHits = Number(profile?.kktMatrixFreeHits ?? profile?.counts?.kktMatrixFreeHits) || 0;
  const matrixFreeFallbacks = Number(profile?.kktMatrixFreeFallbacks ?? profile?.counts?.kktMatrixFreeFallbacks) || 0;
  const matrixFreeCgIters = Number(profile?.kktMatrixFreeCgIters ?? profile?.counts?.kktMatrixFreeCgIters) || 0;
  const matrixFreeSolverIters = Number(profile?.kktMatrixFreeSolverIters ?? profile?.counts?.kktMatrixFreeSolverIters) || 0;
  const matrixFreeResidualNorm = Number(profile?.kktMatrixFreeResidualNorm ?? profile?.counts?.kktMatrixFreeResidualNorm);
  const matrixFreeMs = Number(profile?.kktMatrixFreeMs ?? profile?.counts?.kktMatrixFreeMs) || 0;

  return {
    objectiveMs,
    wasmMs,
    jsMs,
    totalMeasured,
    objectivePct: (objectiveMs / totalMeasured) * 100,
    wasmPct: (wasmMs / totalMeasured) * 100,
    jsPct: (jsMs / totalMeasured) * 100,
    wasmToObjectiveRatio: objectiveMs > 0 ? (wasmMs / objectiveMs) : null,
    objectiveToWasmRatio: wasmMs > 0 ? (objectiveMs / wasmMs) : null,
    pilotCalls,
    pilotHits,
    pilotFallbacks,
    pilotHitRatePct: pilotCalls > 0 ? (100 * pilotHits / pilotCalls) : 0,
    bufferCalls,
    bufferHits,
    bufferFallbacks,
    bufferHitRatePct: bufferCalls > 0 ? (100 * bufferHits / bufferCalls) : 0,
    matrixFreeCalls,
    matrixFreeHits,
    matrixFreeFallbacks,
    matrixFreeHitRatePct: matrixFreeCalls > 0 ? (100 * matrixFreeHits / matrixFreeCalls) : 0,
    matrixFreeCgIters,
    matrixFreeSolverIters,
    matrixFreeResidualNorm: Number.isFinite(matrixFreeResidualNorm) ? matrixFreeResidualNorm : null,
    matrixFreeMs
  };
}

function pickKktFdMetricsFromProfile(profile) {
  const pick = (k, fallback = 0) => Number(profile?.[k] ?? profile?.counts?.[k] ?? fallback) || 0;
  const rawCols = pick('kktFiniteDiffColumnsRaw');
  const effectiveCols = pick('kktFiniteDiffColumnsEffective');
  const groups = pick('kktFiniteDiffGroups');
  const residualEvals = pick('kktFiniteDiffResidualEvals');
  const analyticConstraintRows = pick('kktAnalyticConstraintRows');
  const analyticEqualityCandidateRows = pick('kktAnalyticEqualityCandidateRows');
  const analyticEqualityRows = pick('kktAnalyticEqualityRows');
  const analyticEqualityCalibratedRows = pick('kktAnalyticEqualityCalibratedRows');
  return {
    rawCols,
    effectiveCols,
    groups,
    residualEvals,
    analyticConstraintRows,
    analyticEqualityCandidateRows,
    analyticEqualityRows,
    analyticEqualityCalibratedRows,
    effectiveRatioPct: rawCols > 0 ? (100 * effectiveCols / rawCols) : 0,
    reductionPct: rawCols > 0 ? (100 * (rawCols - effectiveCols) / rawCols) : 0
  };
}

export async function profileOptimizationRun(baseOptions = {}) {
  const source = isPlainObject(baseOptions) ? baseOptions : {};
  const methodRaw = String(source.method || 'kkt').trim().toLowerCase();
  const method = methodRaw === 'cd' || methodRaw === 'coordinatedescent'
    ? 'cd'
    : methodRaw === 'kkt-sqp' || methodRaw === 'sqp' || methodRaw === 'sqp-kkt'
      ? 'kkt-sqp'
    : methodRaw === 'global' || methodRaw === 'escape' || methodRaw === 'escapefunction' || methodRaw === 'global-al'
      ? 'global-al'
    : methodRaw === 'global-lm'
      ? 'global-lm'
    : methodRaw === 'lm'
      ? 'lm'
      : 'kkt';
  const common = { ...source, method, profile: true };

  const deepClone = (value) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return null;
    }
  };

  const originalSystemConfig = loadSystemConfigurationsRaw();
  const baselineSystemConfig = deepClone(originalSystemConfig);
  const restoreBaselineConfig = () => {
    if (!baselineSystemConfig) return;
    try {
      saveSystemConfigurationsRaw(deepClone(baselineSystemConfig));
    } catch (_) {}
  };

  let runError = null;
  let result = null;
  let elapsedMs = 0;
  let profile = null;
  try {
    restoreBaselineConfig();
    const t0 = nowMs();
    result = await runOptimizationMVP(common);
    elapsedMs = nowMs() - t0;
    profile = getLastOptimizeProfile();
  } catch (error) {
    runError = error;
    profile = getLastOptimizeProfile();
  } finally {
    restoreBaselineConfig();
  }

  const timing = pickTimingMetricsFromProfile(profile);
  const kkt = (method === 'kkt' || method === 'kkt-sqp') ? pickKktFdMetricsFromProfile(profile) : null;
  const analyticCandidates = pickAnalyticDerivativeCandidates(profile, {
    limit: Number(source.analyticCandidateLimit ?? 3) || 3,
    minCalls: Number(source.analyticCandidateMinCalls ?? 5) || 5,
    minMs: Number(source.analyticCandidateMinMs ?? 1) || 1,
    hotPct: Number(source.analyticCandidateHotPct ?? 2) || 2
  });
  const counts = profile?.counts && typeof profile.counts === 'object'
    ? {
        kktFiniteDiffJacobianMs: Number(profile.counts.kktFiniteDiffJacobianMs) || 0,
        kktCandidateEvalCount: Number(profile.counts.kktCandidateEvalCount) || 0,
        kktMtfBatchCalls: Number(profile.counts.kktMtfBatchCalls) || 0,
        kktMtfBatchJobs: Number(profile.counts.kktMtfBatchJobs) || 0,
        kktMtfBatchMs: Number(profile.counts.kktMtfBatchMs) || 0,
        kktMtfBatchRayonCalls: Number(profile.counts.kktMtfBatchRayonCalls) || 0,
        kktMtfBatchFailures: Number(profile.counts.kktMtfBatchFailures) || 0,
        kktMtfPrefetchCalls: Number(profile.counts.kktMtfPrefetchCalls) || 0,
        kktMtfPrefetchSeededValues: Number(profile.counts.kktMtfPrefetchSeededValues) || 0,
        kktMtfPrefetchFailures: Number(profile.counts.kktMtfPrefetchFailures) || 0,
        kktAsyncPrefetchCalls: Number(profile.counts.kktAsyncPrefetchCalls) || 0,
        kktAsyncPrefetchGroups: Number(profile.counts.kktAsyncPrefetchGroups) || 0,
        kktAsyncPrefetchSeededValues: Number(profile.counts.kktAsyncPrefetchSeededValues) || 0,
        kktAsyncPrefetchFailures: Number(profile.counts.kktAsyncPrefetchFailures) || 0,
        kktTaBatchPrefetchCalls: Number(profile.counts.kktTaBatchPrefetchCalls) || 0,
        kktTaBatchPrefetchSeededValues: Number(profile.counts.kktTaBatchPrefetchSeededValues) || 0,
        kktTaBatchPrefetchFailures: Number(profile.counts.kktTaBatchPrefetchFailures) || 0,
        kktNativeBatchFdParityPassed: Number(profile.counts.kktNativeBatchFdParityPassed) || 0,
        kktNativeBatchFdParityFailed: Number(profile.counts.kktNativeBatchFdParityFailed) || 0,
        kktAcceptedSteps: Number(profile.counts.kktAcceptedSteps) || 0,
        kktRejectedSteps: Number(profile.counts.kktRejectedSteps) || 0,
        kktLineSearchBacktracks: Number(profile.counts.kktLineSearchBacktracks) || 0,
        kktSqpScoreProbeRecoveries: Number(profile.counts.kktSqpScoreProbeRecoveries) || 0,
        kktSqpScoreProbeEvaluations: Number(profile.counts.kktSqpScoreProbeEvaluations) || 0,
        kktSqpCoordinateProbeAccepts: Number(profile.counts.kktSqpCoordinateProbeAccepts) || 0,
        calculateOperandValueCalls: Number(profile.counts.calculateOperandValueCalls) || 0,
        operandValueCacheHits: Number(profile.counts.operandValueCacheHits) || 0,
        operandValueCacheMisses: Number(profile.counts.operandValueCacheMisses) || 0
      }
    : {};
  const summary = {
    method,
    elapsedMs,
    result: result
      ? {
          ok: !!result.ok,
          aborted: !!result.aborted,
          iterations: Number(result.iterations) || 0,
          best: Number.isFinite(Number(result.best)) ? Number(result.best) : null,
          feasible: result.feasible === undefined ? null : !!result.feasible,
          violationScore: Number.isFinite(Number(result.violationScore)) ? Number(result.violationScore) : null,
          softPenalty: Number.isFinite(Number(result.softPenalty)) ? Number(result.softPenalty) : null,
          reason: result.reason || null
        }
      : null,
    timing,
    kkt,
    counts,
    dominantSection: Array.isArray(profile?.sectionRows) ? (profile.sectionRows[0] || null) : null,
    dominantOperand: profile?.dominantOperand || null,
    dominantOperandCfg: profile?.dominantOperandCfg || null,
    analyticCandidates,
    error: runError ? String(runError instanceof Error ? runError.message : runError) : null
  };

  try {
    console.groupCollapsed('[OptimizerMVP] single-run profile', {
      method,
      ok: result ? !!result.ok : null,
      elapsedMs: Math.round(elapsedMs)
    });
    console.log('summary', summary);
    console.groupEnd();
  } catch (_) {}

  return {
    options: common,
    result,
    elapsedMs,
    profile,
    summary,
    timing,
    kkt,
    analyticCandidates,
    error: runError
  };
}

export async function compareKktAnalyticEqBenchmark(baseOptions = {}) {
  const source = isPlainObject(baseOptions) ? baseOptions : {};
  const common = { ...source };
  const repeatRaw = Number(source.repeat ?? source.benchmarkRepeat ?? 1);
  const repeat = Number.isFinite(repeatRaw) ? Math.max(1, Math.floor(repeatRaw)) : 1;
  try { delete common.repeat; } catch (_) {}
  try { delete common.benchmarkRepeat; } catch (_) {}
  try { delete common.kktUseAnalyticEqualityCtctJacobian; } catch (_) {}

  const deepClone = (v) => {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch (_) {
      return null;
    }
  };

  const originalSystemConfig = loadSystemConfigurationsRaw();
  const baselineSystemConfig = deepClone(originalSystemConfig);

  const restoreBaselineConfig = () => {
    if (!baselineSystemConfig) return;
    try {
      saveSystemConfigurationsRaw(deepClone(baselineSystemConfig));
    } catch (_) {}
  };

  const runOne = async (enableAnalyticEq) => {
    restoreBaselineConfig();
    const options = {
      ...common,
      method: 'kkt',
      profile: true,
      kktUseAnalyticEqualityCtctJacobian: !!enableAnalyticEq
    };
    const t0 = nowMs();
    const result = await runOptimizationMVP(options);
    const elapsedMs = nowMs() - t0;
    const profile = getLastOptimizeProfile();
    const timing = pickTimingMetricsFromProfile(profile);
    const kkt = pickKktFdMetricsFromProfile(profile);
    return { enableAnalyticEq: !!enableAnalyticEq, options, result, elapsedMs, profile, timing, kkt };
  };

  const offRuns = [];
  const onRuns = [];
  try {
    for (let i = 0; i < repeat; i++) {
      offRuns.push(await runOne(false));
      onRuns.push(await runOne(true));
    }
  } finally {
    try {
      if (originalSystemConfig) saveSystemConfigurationsRaw(originalSystemConfig);
    } catch (_) {}
  }

  const summarize = (runs) => {
    const values = (path) => runs.map((r) => {
      try {
        const parts = path.split('.');
        let cur = r;
        for (const p of parts) cur = cur?.[p];
        const n = Number(cur);
        return Number.isFinite(n) ? n : 0;
      } catch (_) {
        return 0;
      }
    });
    const avgOf = (path) => {
      const arr = values(path);
      if (arr.length === 0) return 0;
      return arr.reduce((a, b) => a + b, 0) / arr.length;
    };
    return {
      repeat: runs.length,
      elapsedMs: avgOf('elapsedMs'),
      objectiveMs: avgOf('timing.objectiveMs'),
      wasmMs: avgOf('timing.wasmMs'),
      jsMs: avgOf('timing.jsMs'),
      fdRawCols: avgOf('kkt.rawCols'),
      fdEffectiveCols: avgOf('kkt.effectiveCols'),
      fdGroups: avgOf('kkt.groups'),
      fdResidualEvals: avgOf('kkt.residualEvals'),
      analyticConstraintRows: avgOf('kkt.analyticConstraintRows'),
      analyticEqualityCandidateRows: avgOf('kkt.analyticEqualityCandidateRows'),
      analyticEqualityRows: avgOf('kkt.analyticEqualityRows'),
      analyticEqualityCalibratedRows: avgOf('kkt.analyticEqualityCalibratedRows'),
      fdEffectiveRatioPct: avgOf('kkt.effectiveRatioPct'),
      fdReductionPct: avgOf('kkt.reductionPct'),
      okRatePct: avgOf('result.ok') * 100
    };
  };

  const off = summarize(offRuns);
  const on = summarize(onRuns);
  const delta = {
    elapsedMs: on.elapsedMs - off.elapsedMs,
    fdEffectiveCols: on.fdEffectiveCols - off.fdEffectiveCols,
    fdReductionPct: on.fdReductionPct - off.fdReductionPct,
    analyticEqualityCandidateRows: on.analyticEqualityCandidateRows - off.analyticEqualityCandidateRows,
    analyticEqualityRows: on.analyticEqualityRows - off.analyticEqualityRows,
    analyticEqualityCalibratedRows: on.analyticEqualityCalibratedRows - off.analyticEqualityCalibratedRows
  };

  try {
    console.groupCollapsed('[OptimizerMVP] KKT analytic-equality benchmark');
    console.log('off(kktUseAnalyticEqualityCtctJacobian=false)', {
      repeat: off.repeat,
      elapsedMs: Math.round(off.elapsedMs),
      fdRawCols: Math.round(off.fdRawCols),
      fdEffectiveCols: Math.round(off.fdEffectiveCols),
      fdReductionPct: Math.round(off.fdReductionPct * 10) / 10,
      analyticEqualityCandidateRows: Math.round(off.analyticEqualityCandidateRows),
      analyticEqualityRows: Math.round(off.analyticEqualityRows),
      analyticEqualityCalibratedRows: Math.round(off.analyticEqualityCalibratedRows),
      okRatePct: Math.round(off.okRatePct * 10) / 10
    });
    console.log('on(kktUseAnalyticEqualityCtctJacobian=true)', {
      repeat: on.repeat,
      elapsedMs: Math.round(on.elapsedMs),
      fdRawCols: Math.round(on.fdRawCols),
      fdEffectiveCols: Math.round(on.fdEffectiveCols),
      fdReductionPct: Math.round(on.fdReductionPct * 10) / 10,
      analyticEqualityCandidateRows: Math.round(on.analyticEqualityCandidateRows),
      analyticEqualityRows: Math.round(on.analyticEqualityRows),
      analyticEqualityCalibratedRows: Math.round(on.analyticEqualityCalibratedRows),
      okRatePct: Math.round(on.okRatePct * 10) / 10
    });
    console.log('delta(on - off)', {
      elapsedMs: Math.round(delta.elapsedMs),
      fdEffectiveCols: Math.round(delta.fdEffectiveCols),
      fdReductionPct: Math.round(delta.fdReductionPct * 10) / 10,
      analyticEqualityCandidateRows: Math.round(delta.analyticEqualityCandidateRows),
      analyticEqualityRows: Math.round(delta.analyticEqualityRows),
      analyticEqualityCalibratedRows: Math.round(delta.analyticEqualityCalibratedRows)
    });
    console.groupEnd();
  } catch (_) {}

  return {
    off,
    on,
    delta,
    offRuns,
    onRuns
  };
}

export function pickAnalyticDerivativeCandidates(profileOrOptions = {}, maybeOptions = {}) {
  const fromOptions = (obj, key, fallback) => {
    try {
      const value = obj?.[key];
      return Number.isFinite(Number(value)) ? Number(value) : fallback;
    } catch (_) {
      return fallback;
    }
  };

  const hasProfileShape = profileOrOptions && typeof profileOrOptions === 'object' && (
    typeof profileOrOptions.operandMs === 'object'
    || typeof profileOrOptions.operandCfgMs === 'object'
    || typeof profileOrOptions.counts === 'object'
  );

  const profile = hasProfileShape ? profileOrOptions : (getLastOptimizeProfile() || {});
  const options = hasProfileShape ? maybeOptions : profileOrOptions;

  const limitRaw = fromOptions(options, 'limit', 3);
  const limit = Math.max(1, Math.floor(limitRaw));
  const minCalls = Math.max(1, Math.floor(fromOptions(options, 'minCalls', 5)));
  const minMs = Math.max(0, fromOptions(options, 'minMs', 1));
  const hotPct = Math.max(0, fromOptions(options, 'hotPct', 2));

  const byOperand = profile?.operandMs && typeof profile.operandMs === 'object'
    ? profile.operandMs
    : {};
  const byOperandCfg = profile?.operandCfgMs && typeof profile.operandCfgMs === 'object'
    ? profile.operandCfgMs
    : {};
  const totalOperandMs = Object.values(byOperand).reduce((acc, entry: any) => {
    const ms = Number(entry?.ms) || 0;
    return acc + (Number.isFinite(ms) ? Math.max(0, ms) : 0);
  }, 0);

  const candidates = Object.entries(byOperand)
    .map(([operand, entry]: [string, any]) => {
      const ms = Number(entry?.ms) || 0;
      const calls = Number(entry?.calls) || 0;
      const msPerCall = calls > 0 ? (ms / calls) : 0;
      const pctOperand = totalOperandMs > 0 ? (100 * ms / totalOperandMs) : 0;
      const cfgRows = Object.entries(byOperandCfg)
        .filter(([key]) => String(key).startsWith(`${operand}|cfg:`))
        .map(([key, cfgEntry]: [string, any]) => ({
          key,
          ms: Number(cfgEntry?.ms) || 0,
          calls: Number(cfgEntry?.calls) || 0
        }))
        .sort((a, b) => (Number(b.ms) || 0) - (Number(a.ms) || 0));

      const dominantCfg = cfgRows[0] || null;
      return {
        operand,
        ms,
        calls,
        msPerCall,
        pctOperand,
        dominantCfgKey: dominantCfg?.key || null,
        dominantCfgMs: Number(dominantCfg?.ms) || 0,
        dominantCfgCalls: Number(dominantCfg?.calls) || 0,
        score: (ms * Math.log2(calls + 2))
      };
    })
    .filter((row) => row.calls >= minCalls && row.ms >= minMs && row.pctOperand >= hotPct)
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    .slice(0, limit);

  return {
    generatedAt: new Date().toISOString(),
    limit,
    minCalls,
    minMs,
    hotPct,
    totalOperandMs,
    candidates
  };
}

export async function compareWasmPilotBenchmark(baseOptions = {}) {
  const source = isPlainObject(baseOptions) ? baseOptions : {};
  const common = { ...source };
  const repeatRaw = Number(source.repeat ?? source.benchmarkRepeat ?? 1);
  const repeat = Number.isFinite(repeatRaw) ? Math.max(1, Math.floor(repeatRaw)) : 1;
  const warmupDiscardRaw = Number(source.warmupDiscard ?? source.discardWarmup ?? (repeat > 1 ? 1 : 0));
  const warmupDiscard = Number.isFinite(warmupDiscardRaw) ? Math.max(0, Math.floor(warmupDiscardRaw)) : 0;
  const useOutlierFilter = source.filterOutliers !== false;
  try { delete common.kktUseWasmPilotOptimizer; } catch (_) {}
  try { delete common.repeat; } catch (_) {}
  try { delete common.benchmarkRepeat; } catch (_) {}
  try { delete common.warmupDiscard; } catch (_) {}
  try { delete common.discardWarmup; } catch (_) {}
  try { delete common.filterOutliers; } catch (_) {}

  const runOne = async (usePilot) => {
    const options = {
      ...common,
      profile: true,
      kktUseWasmPilotOptimizer: !!usePilot
    };
    const t0 = nowMs();
    const result = await runOptimizationMVP(options);
    const elapsedMs = nowMs() - t0;
    const profile = getLastOptimizeProfile();
    const metrics = pickTimingMetricsFromProfile(profile);
    return { usePilot: !!usePilot, options, result, elapsedMs, profile, metrics };
  };

  const summarizeRuns = (runs) => {
    const pick = (path, fallback = 0) => {
      const values = runs.map((run) => {
        try {
          const parts = path.split('.');
          let cur = run;
          for (const p of parts) cur = cur?.[p];
          const n = Number(cur);
          return Number.isFinite(n) ? n : fallback;
        } catch (_) {
          return fallback;
        }
      });
      const sum = values.reduce((acc, v) => acc + v, 0);
      const avg = values.length > 0 ? (sum / values.length) : fallback;
      const min = values.length > 0 ? Math.min(...values) : fallback;
      const max = values.length > 0 ? Math.max(...values) : fallback;
      return { avg, min, max };
    };

    const elapsed = pick('elapsedMs');
    const objectiveMs = pick('metrics.objectiveMs');
    const wasmMs = pick('metrics.wasmMs');
    const jsMs = pick('metrics.jsMs');
    const objectivePct = pick('metrics.objectivePct');
    const wasmPct = pick('metrics.wasmPct');
    const jsPct = pick('metrics.jsPct');
    const pilotHitRatePct = pick('metrics.pilotHitRatePct');
    const bufferHitRatePct = pick('metrics.bufferHitRatePct');
    const okRatePct = pick('result.ok');

    return {
      repeat: runs.length,
      elapsed,
      objectiveMs,
      wasmMs,
      jsMs,
      objectivePct,
      wasmPct,
      jsPct,
      pilotHitRatePct,
      bufferHitRatePct,
      okRatePct: okRatePct.avg * 100
    };
  };

  const medianOf = (arr) => {
    const nums = (Array.isArray(arr) ? arr : [])
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    const n = nums.length;
    if (n === 0) return null;
    const mid = Math.floor(n / 2);
    return (n % 2 === 1) ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  };

  const robustFilterRuns = (runs) => {
    const afterWarmup = Array.isArray(runs) ? runs.slice(Math.min(warmupDiscard, runs.length)) : [];
    if (!useOutlierFilter || afterWarmup.length < 5) {
      return { filtered: afterWarmup, droppedWarmup: Math.min(warmupDiscard, runs.length), droppedOutliers: 0 };
    }

    const elapsed = afterWarmup.map((r) => Number(r?.elapsedMs) || 0);
    const med = medianOf(elapsed);
    if (!(Number.isFinite(med))) {
      return { filtered: afterWarmup, droppedWarmup: Math.min(warmupDiscard, runs.length), droppedOutliers: 0 };
    }

    const absDev = elapsed.map((v) => Math.abs(v - med));
    const mad = medianOf(absDev);
    if (!(Number.isFinite(mad)) || mad <= 0) {
      return { filtered: afterWarmup, droppedWarmup: Math.min(warmupDiscard, runs.length), droppedOutliers: 0 };
    }

    const threshold = med + 6 * mad;
    const filtered = afterWarmup.filter((r) => (Number(r?.elapsedMs) || 0) <= threshold);
    const droppedOutliers = Math.max(0, afterWarmup.length - filtered.length);
    return { filtered: (filtered.length > 0 ? filtered : afterWarmup), droppedWarmup: Math.min(warmupDiscard, runs.length), droppedOutliers };
  };

  const baselineRuns = [];
  const pilotRuns = [];
  for (let i = 0; i < repeat; i++) {
    baselineRuns.push(await runOne(false));
    pilotRuns.push(await runOne(true));
  }

  const baselineFiltered = robustFilterRuns(baselineRuns);
  const pilotFiltered = robustFilterRuns(pilotRuns);

  const baseline = summarizeRuns(baselineFiltered.filtered);
  const pilot = summarizeRuns(pilotFiltered.filtered);

  const delta = {
    elapsedMs: pilot.elapsed.avg - baseline.elapsed.avg,
    objectiveMs: pilot.objectiveMs.avg - baseline.objectiveMs.avg,
    wasmMs: pilot.wasmMs.avg - baseline.wasmMs.avg,
    jsMs: pilot.jsMs.avg - baseline.jsMs.avg,
    objectivePct: pilot.objectivePct.avg - baseline.objectivePct.avg,
    wasmPct: pilot.wasmPct.avg - baseline.wasmPct.avg,
    jsPct: pilot.jsPct.avg - baseline.jsPct.avg,
    pilotHitRatePct: pilot.pilotHitRatePct.avg - baseline.pilotHitRatePct.avg,
    bufferHitRatePct: pilot.bufferHitRatePct.avg - baseline.bufferHitRatePct.avg
  };

  try {
    console.groupCollapsed('[OptimizerMVP] WASM pilot benchmark');
    console.log('baseline(kktUseWasmPilotOptimizer=false)', {
      repeat,
      droppedWarmup: baselineFiltered.droppedWarmup,
      droppedOutliers: baselineFiltered.droppedOutliers,
      usedRuns: baseline.repeat,
      elapsedAvgMs: Math.round(baseline.elapsed.avg),
      elapsedMinMs: Math.round(baseline.elapsed.min),
      elapsedMaxMs: Math.round(baseline.elapsed.max),
      objectiveAvgMs: Math.round(baseline.objectiveMs.avg),
      wasmAvgMs: Math.round(baseline.wasmMs.avg),
      jsAvgMs: Math.round(baseline.jsMs.avg),
      objectivePctAvg: Math.round(baseline.objectivePct.avg * 10) / 10,
      wasmPctAvg: Math.round(baseline.wasmPct.avg * 10) / 10,
      jsPctAvg: Math.round(baseline.jsPct.avg * 10) / 10,
      bufferHitRatePctAvg: Math.round(baseline.bufferHitRatePct.avg * 10) / 10,
      okRatePct: Math.round(baseline.okRatePct * 10) / 10
    });
    console.log('pilot(kktUseWasmPilotOptimizer=true)', {
      repeat,
      droppedWarmup: pilotFiltered.droppedWarmup,
      droppedOutliers: pilotFiltered.droppedOutliers,
      usedRuns: pilot.repeat,
      elapsedAvgMs: Math.round(pilot.elapsed.avg),
      elapsedMinMs: Math.round(pilot.elapsed.min),
      elapsedMaxMs: Math.round(pilot.elapsed.max),
      objectiveAvgMs: Math.round(pilot.objectiveMs.avg),
      wasmAvgMs: Math.round(pilot.wasmMs.avg),
      jsAvgMs: Math.round(pilot.jsMs.avg),
      objectivePctAvg: Math.round(pilot.objectivePct.avg * 10) / 10,
      wasmPctAvg: Math.round(pilot.wasmPct.avg * 10) / 10,
      jsPctAvg: Math.round(pilot.jsPct.avg * 10) / 10,
      pilotHitRatePctAvg: Math.round(pilot.pilotHitRatePct.avg * 10) / 10,
      bufferHitRatePctAvg: Math.round(pilot.bufferHitRatePct.avg * 10) / 10,
      okRatePct: Math.round(pilot.okRatePct * 10) / 10
    });
    console.log('delta(pilot - baseline)', {
      elapsedMs: Math.round(delta.elapsedMs),
      objectiveMs: Math.round(delta.objectiveMs),
      wasmMs: Math.round(delta.wasmMs),
      jsMs: Math.round(delta.jsMs),
      objectivePct: Math.round(delta.objectivePct * 10) / 10,
      wasmPct: Math.round(delta.wasmPct * 10) / 10,
      jsPct: Math.round(delta.jsPct * 10) / 10,
      pilotHitRatePct: Math.round(delta.pilotHitRatePct * 10) / 10,
      bufferHitRatePct: Math.round(delta.bufferHitRatePct * 10) / 10
    });
    console.groupEnd();
  } catch (_) {}

  return {
    baseline,
    pilot,
    delta,
    filtering: {
      warmupDiscard,
      filterOutliers: useOutlierFilter,
      baselineDroppedWarmup: baselineFiltered.droppedWarmup,
      baselineDroppedOutliers: baselineFiltered.droppedOutliers,
      pilotDroppedWarmup: pilotFiltered.droppedWarmup,
      pilotDroppedOutliers: pilotFiltered.droppedOutliers
    },
    baselineRuns,
    pilotRuns,
    baselineRunsUsed: baselineFiltered.filtered,
    pilotRunsUsed: pilotFiltered.filtered
  };
}

export async function compareMatrixFreeBenchmark(baseOptions = {}) {
  const source = isPlainObject(baseOptions) ? baseOptions : {};
  const common = { ...source };
  const matchBaselineBestStop = source.matchBaselineBestStop !== false;
  const matchBaselineBestRelTolRaw = Number(source.matchBaselineBestRelTol ?? 0);
  const matchBaselineBestRelTol = Number.isFinite(matchBaselineBestRelTolRaw)
    ? Math.max(0, matchBaselineBestRelTolRaw)
    : 0;
  const matchBaselineBestAbsTolRaw = Number(source.matchBaselineBestAbsTol ?? 0);
  const matchBaselineBestAbsTol = Number.isFinite(matchBaselineBestAbsTolRaw)
    ? Math.max(0, matchBaselineBestAbsTolRaw)
    : 0;
  const matchBaselineBestMinIterRaw = Number(source.matchBaselineBestMinIter ?? 8);
  const matchBaselineBestMinIter = Number.isFinite(matchBaselineBestMinIterRaw)
    ? Math.max(0, Math.floor(matchBaselineBestMinIterRaw))
    : 8;
  const repeatRaw = Number(source.repeat ?? source.benchmarkRepeat ?? 1);
  const repeat = Number.isFinite(repeatRaw) ? Math.max(1, Math.floor(repeatRaw)) : 1;
  const warmupDiscardRaw = Number(source.warmupDiscard ?? source.discardWarmup ?? (repeat > 1 ? 1 : 0));
  const warmupDiscard = Number.isFinite(warmupDiscardRaw) ? Math.max(0, Math.floor(warmupDiscardRaw)) : 0;
  const useOutlierFilter = source.filterOutliers !== false;
  try { delete common.kktUseMatrixFreeCore; } catch (_) {}
  try { delete common.kktMatrixFreePriority; } catch (_) {}
  try { delete common.repeat; } catch (_) {}
  try { delete common.benchmarkRepeat; } catch (_) {}
  try { delete common.warmupDiscard; } catch (_) {}
  try { delete common.discardWarmup; } catch (_) {}
  try { delete common.filterOutliers; } catch (_) {}
  try { delete common.matchBaselineBestStop; } catch (_) {}
  try { delete common.matchBaselineBestRelTol; } catch (_) {}
  try { delete common.matchBaselineBestAbsTol; } catch (_) {}
  try { delete common.matchBaselineBestMinIter; } catch (_) {}

  const deepClone = (v) => {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch (_) {
      return null;
    }
  };

  const originalSystemConfig = loadSystemConfigurationsRaw();
  const baselineSystemConfig = deepClone(originalSystemConfig);

  const restoreBaselineConfig = () => {
    if (!baselineSystemConfig) return;
    try {
      saveSystemConfigurationsRaw(deepClone(baselineSystemConfig));
    } catch (_) {}
  };

  const runOne = async (useMatrixFree, useMatrixFreePriority = false, stopBestTarget = null) => {
    restoreBaselineConfig();
    const targetBestRaw = Number(stopBestTarget);
    const hasTargetBest = Number.isFinite(targetBestRaw);
    const targetBestTol = hasTargetBest
      ? Math.max(matchBaselineBestAbsTol, Math.abs(targetBestRaw) * matchBaselineBestRelTol)
      : 0;
    const options = {
      ...common,
      profile: true,
      method: 'kkt',
      kktUseMatrixFreeCore: !!useMatrixFree,
      kktMatrixFreePriority: !!useMatrixFree && !!useMatrixFreePriority
    };
    if (useMatrixFree && hasTargetBest) {
      options.kktStopWhenBestLeq = targetBestRaw + targetBestTol;
      options.kktStopWhenBestLeqMinIter = matchBaselineBestMinIter;
    }
    const t0 = nowMs();
    const result = await runOptimizationMVP(options);
    const elapsedMs = nowMs() - t0;
    const profile = getLastOptimizeProfile();
    const metrics = pickTimingMetricsFromProfile(profile);
    return {
      useMatrixFree: !!useMatrixFree,
      useMatrixFreePriority: !!useMatrixFree && !!useMatrixFreePriority,
      options,
      result,
      elapsedMs,
      profile,
      metrics
    };
  };

  const summarizeRuns = (runs) => {
    const pick = (path, fallback = 0) => {
      const values = runs.map((run) => {
        try {
          const parts = path.split('.');
          let cur = run;
          for (const p of parts) cur = cur?.[p];
          const n = Number(cur);
          return Number.isFinite(n) ? n : fallback;
        } catch (_) {
          return fallback;
        }
      });
      const sum = values.reduce((acc, v) => acc + v, 0);
      const avg = values.length > 0 ? (sum / values.length) : fallback;
      const min = values.length > 0 ? Math.min(...values) : fallback;
      const max = values.length > 0 ? Math.max(...values) : fallback;
      return { avg, min, max };
    };

    const elapsed = pick('elapsedMs');
    const objectiveMs = pick('metrics.objectiveMs');
    const wasmMs = pick('metrics.wasmMs');
    const jsMs = pick('metrics.jsMs');
    const objectivePct = pick('metrics.objectivePct');
    const wasmPct = pick('metrics.wasmPct');
    const jsPct = pick('metrics.jsPct');
    const matrixFreeHitRatePct = pick('metrics.matrixFreeHitRatePct');
    const matrixFreeCalls = pick('metrics.matrixFreeCalls');
    const matrixFreeCgIters = pick('metrics.matrixFreeCgIters');
    const matrixFreeSolverIters = pick('metrics.matrixFreeSolverIters');
    const matrixFreeMs = pick('metrics.matrixFreeMs');
    const okRatePct = pick('result.ok');

    return {
      repeat: runs.length,
      elapsed,
      objectiveMs,
      wasmMs,
      jsMs,
      objectivePct,
      wasmPct,
      jsPct,
      matrixFreeHitRatePct,
      matrixFreeCalls,
      matrixFreeCgIters,
      matrixFreeSolverIters,
      matrixFreeMs,
      okRatePct: okRatePct.avg * 100
    };
  };

  const medianOf = (arr) => {
    const nums = (Array.isArray(arr) ? arr : [])
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    const n = nums.length;
    if (n === 0) return null;
    const mid = Math.floor(n / 2);
    return (n % 2 === 1) ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  };

  const robustFilterRuns = (runs) => {
    const afterWarmup = Array.isArray(runs) ? runs.slice(Math.min(warmupDiscard, runs.length)) : [];
    if (!useOutlierFilter || afterWarmup.length < 5) {
      return { filtered: afterWarmup, droppedWarmup: Math.min(warmupDiscard, runs.length), droppedOutliers: 0 };
    }

    const elapsed = afterWarmup.map((r) => Number(r?.elapsedMs) || 0);
    const med = medianOf(elapsed);
    if (!(Number.isFinite(med))) {
      return { filtered: afterWarmup, droppedWarmup: Math.min(warmupDiscard, runs.length), droppedOutliers: 0 };
    }

    const absDev = elapsed.map((v) => Math.abs(v - med));
    const mad = medianOf(absDev);
    if (!(Number.isFinite(mad)) || mad <= 0) {
      return { filtered: afterWarmup, droppedWarmup: Math.min(warmupDiscard, runs.length), droppedOutliers: 0 };
    }

    const threshold = med + 6 * mad;
    const filtered = afterWarmup.filter((r) => (Number(r?.elapsedMs) || 0) <= threshold);
    const droppedOutliers = Math.max(0, afterWarmup.length - filtered.length);
    return { filtered: (filtered.length > 0 ? filtered : afterWarmup), droppedWarmup: Math.min(warmupDiscard, runs.length), droppedOutliers };
  };

  const baselineRuns = [];
  const matrixFreeRuns = [];
  const matrixFreePriorityRuns = [];
  try {
    for (let i = 0; i < repeat; i++) {
      const baselineRun = await runOne(false, false);
      baselineRuns.push(baselineRun);

      let matrixFreeStopBestTarget = null;
      if (matchBaselineBestStop) {
        const baselineBest = Number(baselineRun?.result?.best);
        if (Number.isFinite(baselineBest)) matrixFreeStopBestTarget = baselineBest;
      }
      matrixFreeRuns.push(await runOne(true, false, matrixFreeStopBestTarget));
      matrixFreePriorityRuns.push(await runOne(true, true, matrixFreeStopBestTarget));
    }
  } finally {
    try {
      if (originalSystemConfig) saveSystemConfigurationsRaw(originalSystemConfig);
    } catch (_) {}
  }

  const baselineFiltered = robustFilterRuns(baselineRuns);
  const matrixFreeFiltered = robustFilterRuns(matrixFreeRuns);
  const matrixFreePriorityFiltered = robustFilterRuns(matrixFreePriorityRuns);

  const baseline = summarizeRuns(baselineFiltered.filtered);
  const matrixFree = summarizeRuns(matrixFreeFiltered.filtered);
  const matrixFreePriority = summarizeRuns(matrixFreePriorityFiltered.filtered);

  const delta = {
    elapsedMs: matrixFree.elapsed.avg - baseline.elapsed.avg,
    objectiveMs: matrixFree.objectiveMs.avg - baseline.objectiveMs.avg,
    wasmMs: matrixFree.wasmMs.avg - baseline.wasmMs.avg,
    jsMs: matrixFree.jsMs.avg - baseline.jsMs.avg,
    objectivePct: matrixFree.objectivePct.avg - baseline.objectivePct.avg,
    wasmPct: matrixFree.wasmPct.avg - baseline.wasmPct.avg,
    jsPct: matrixFree.jsPct.avg - baseline.jsPct.avg,
    matrixFreeHitRatePct: matrixFree.matrixFreeHitRatePct.avg - baseline.matrixFreeHitRatePct.avg,
    matrixFreeCalls: matrixFree.matrixFreeCalls.avg - baseline.matrixFreeCalls.avg,
    matrixFreeCgIters: matrixFree.matrixFreeCgIters.avg - baseline.matrixFreeCgIters.avg,
    matrixFreeSolverIters: matrixFree.matrixFreeSolverIters.avg - baseline.matrixFreeSolverIters.avg,
    matrixFreeMs: matrixFree.matrixFreeMs.avg - baseline.matrixFreeMs.avg
  };

  const deltaPriority = {
    elapsedMs: matrixFreePriority.elapsed.avg - baseline.elapsed.avg,
    objectiveMs: matrixFreePriority.objectiveMs.avg - baseline.objectiveMs.avg,
    wasmMs: matrixFreePriority.wasmMs.avg - baseline.wasmMs.avg,
    jsMs: matrixFreePriority.jsMs.avg - baseline.jsMs.avg,
    objectivePct: matrixFreePriority.objectivePct.avg - baseline.objectivePct.avg,
    wasmPct: matrixFreePriority.wasmPct.avg - baseline.wasmPct.avg,
    jsPct: matrixFreePriority.jsPct.avg - baseline.jsPct.avg,
    matrixFreeHitRatePct: matrixFreePriority.matrixFreeHitRatePct.avg - baseline.matrixFreeHitRatePct.avg,
    matrixFreeCalls: matrixFreePriority.matrixFreeCalls.avg - baseline.matrixFreeCalls.avg,
    matrixFreeCgIters: matrixFreePriority.matrixFreeCgIters.avg - baseline.matrixFreeCgIters.avg,
    matrixFreeSolverIters: matrixFreePriority.matrixFreeSolverIters.avg - baseline.matrixFreeSolverIters.avg,
    matrixFreeMs: matrixFreePriority.matrixFreeMs.avg - baseline.matrixFreeMs.avg
  };

  try {
    console.groupCollapsed('[OptimizerMVP] Matrix-free benchmark');
    console.log('benchmark options', {
      repeat,
      warmupDiscard,
      filterOutliers: useOutlierFilter,
      matchBaselineBestStop,
      matchBaselineBestRelTol,
      matchBaselineBestAbsTol,
      matchBaselineBestMinIter
    });
    console.log('baseline(kktUseMatrixFreeCore=false)', {
      repeat,
      droppedWarmup: baselineFiltered.droppedWarmup,
      droppedOutliers: baselineFiltered.droppedOutliers,
      usedRuns: baseline.repeat,
      elapsedAvgMs: Math.round(baseline.elapsed.avg),
      elapsedMinMs: Math.round(baseline.elapsed.min),
      elapsedMaxMs: Math.round(baseline.elapsed.max),
      objectiveAvgMs: Math.round(baseline.objectiveMs.avg),
      wasmAvgMs: Math.round(baseline.wasmMs.avg),
      jsAvgMs: Math.round(baseline.jsMs.avg),
      objectivePctAvg: Math.round(baseline.objectivePct.avg * 10) / 10,
      wasmPctAvg: Math.round(baseline.wasmPct.avg * 10) / 10,
      jsPctAvg: Math.round(baseline.jsPct.avg * 10) / 10,
      matrixFreeHitRatePctAvg: Math.round(baseline.matrixFreeHitRatePct.avg * 10) / 10,
      matrixFreeCallsAvg: Math.round(baseline.matrixFreeCalls.avg * 10) / 10,
      matrixFreeCgItersAvg: Math.round(baseline.matrixFreeCgIters.avg * 10) / 10,
      matrixFreeSolverItersAvg: Math.round(baseline.matrixFreeSolverIters.avg * 10) / 10,
      matrixFreeMsAvg: Math.round(baseline.matrixFreeMs.avg * 10) / 10,
      okRatePct: Math.round(baseline.okRatePct * 10) / 10
    });
    console.log('matrixFree(kktUseMatrixFreeCore=true)', {
      repeat,
      droppedWarmup: matrixFreeFiltered.droppedWarmup,
      droppedOutliers: matrixFreeFiltered.droppedOutliers,
      usedRuns: matrixFree.repeat,
      elapsedAvgMs: Math.round(matrixFree.elapsed.avg),
      elapsedMinMs: Math.round(matrixFree.elapsed.min),
      elapsedMaxMs: Math.round(matrixFree.elapsed.max),
      objectiveAvgMs: Math.round(matrixFree.objectiveMs.avg),
      wasmAvgMs: Math.round(matrixFree.wasmMs.avg),
      jsAvgMs: Math.round(matrixFree.jsMs.avg),
      objectivePctAvg: Math.round(matrixFree.objectivePct.avg * 10) / 10,
      wasmPctAvg: Math.round(matrixFree.wasmPct.avg * 10) / 10,
      jsPctAvg: Math.round(matrixFree.jsPct.avg * 10) / 10,
      matrixFreeHitRatePctAvg: Math.round(matrixFree.matrixFreeHitRatePct.avg * 10) / 10,
      matrixFreeCallsAvg: Math.round(matrixFree.matrixFreeCalls.avg * 10) / 10,
      matrixFreeCgItersAvg: Math.round(matrixFree.matrixFreeCgIters.avg * 10) / 10,
      matrixFreeSolverItersAvg: Math.round(matrixFree.matrixFreeSolverIters.avg * 10) / 10,
      matrixFreeMsAvg: Math.round(matrixFree.matrixFreeMs.avg * 10) / 10,
      okRatePct: Math.round(matrixFree.okRatePct * 10) / 10
    });
    console.log('matrixFreePriority(kktUseMatrixFreeCore=true,kktMatrixFreePriority=true)', {
      repeat,
      droppedWarmup: matrixFreePriorityFiltered.droppedWarmup,
      droppedOutliers: matrixFreePriorityFiltered.droppedOutliers,
      usedRuns: matrixFreePriority.repeat,
      elapsedAvgMs: Math.round(matrixFreePriority.elapsed.avg),
      elapsedMinMs: Math.round(matrixFreePriority.elapsed.min),
      elapsedMaxMs: Math.round(matrixFreePriority.elapsed.max),
      objectiveAvgMs: Math.round(matrixFreePriority.objectiveMs.avg),
      wasmAvgMs: Math.round(matrixFreePriority.wasmMs.avg),
      jsAvgMs: Math.round(matrixFreePriority.jsMs.avg),
      objectivePctAvg: Math.round(matrixFreePriority.objectivePct.avg * 10) / 10,
      wasmPctAvg: Math.round(matrixFreePriority.wasmPct.avg * 10) / 10,
      jsPctAvg: Math.round(matrixFreePriority.jsPct.avg * 10) / 10,
      matrixFreeHitRatePctAvg: Math.round(matrixFreePriority.matrixFreeHitRatePct.avg * 10) / 10,
      matrixFreeCallsAvg: Math.round(matrixFreePriority.matrixFreeCalls.avg * 10) / 10,
      matrixFreeCgItersAvg: Math.round(matrixFreePriority.matrixFreeCgIters.avg * 10) / 10,
      matrixFreeSolverItersAvg: Math.round(matrixFreePriority.matrixFreeSolverIters.avg * 10) / 10,
      matrixFreeMsAvg: Math.round(matrixFreePriority.matrixFreeMs.avg * 10) / 10,
      okRatePct: Math.round(matrixFreePriority.okRatePct * 10) / 10
    });
    console.log('delta(matrixFree - baseline)', {
      elapsedMs: Math.round(delta.elapsedMs),
      objectiveMs: Math.round(delta.objectiveMs),
      wasmMs: Math.round(delta.wasmMs),
      jsMs: Math.round(delta.jsMs),
      objectivePct: Math.round(delta.objectivePct * 10) / 10,
      wasmPct: Math.round(delta.wasmPct * 10) / 10,
      jsPct: Math.round(delta.jsPct * 10) / 10,
      matrixFreeHitRatePct: Math.round(delta.matrixFreeHitRatePct * 10) / 10,
      matrixFreeCalls: Math.round(delta.matrixFreeCalls * 10) / 10,
      matrixFreeCgIters: Math.round(delta.matrixFreeCgIters * 10) / 10,
      matrixFreeSolverIters: Math.round(delta.matrixFreeSolverIters * 10) / 10,
      matrixFreeMs: Math.round(delta.matrixFreeMs * 10) / 10
    });
    console.log('delta(matrixFreePriority - baseline)', {
      elapsedMs: Math.round(deltaPriority.elapsedMs),
      objectiveMs: Math.round(deltaPriority.objectiveMs),
      wasmMs: Math.round(deltaPriority.wasmMs),
      jsMs: Math.round(deltaPriority.jsMs),
      objectivePct: Math.round(deltaPriority.objectivePct * 10) / 10,
      wasmPct: Math.round(deltaPriority.wasmPct * 10) / 10,
      jsPct: Math.round(deltaPriority.jsPct * 10) / 10,
      matrixFreeHitRatePct: Math.round(deltaPriority.matrixFreeHitRatePct * 10) / 10,
      matrixFreeCalls: Math.round(deltaPriority.matrixFreeCalls * 10) / 10,
      matrixFreeCgIters: Math.round(deltaPriority.matrixFreeCgIters * 10) / 10,
      matrixFreeSolverIters: Math.round(deltaPriority.matrixFreeSolverIters * 10) / 10,
      matrixFreeMs: Math.round(deltaPriority.matrixFreeMs * 10) / 10
    });
    console.groupEnd();
  } catch (_) {}

  return {
    baseline,
    matrixFree,
    matrixFreePriority,
    delta,
    deltaPriority,
    filtering: {
      warmupDiscard,
      filterOutliers: useOutlierFilter,
      matchBaselineBestStop,
      matchBaselineBestRelTol,
      matchBaselineBestAbsTol,
      matchBaselineBestMinIter,
      baselineDroppedWarmup: baselineFiltered.droppedWarmup,
      baselineDroppedOutliers: baselineFiltered.droppedOutliers,
      matrixFreeDroppedWarmup: matrixFreeFiltered.droppedWarmup,
      matrixFreeDroppedOutliers: matrixFreeFiltered.droppedOutliers,
      matrixFreePriorityDroppedWarmup: matrixFreePriorityFiltered.droppedWarmup,
      matrixFreePriorityDroppedOutliers: matrixFreePriorityFiltered.droppedOutliers
    },
    baselineRuns,
    matrixFreeRuns,
    matrixFreePriorityRuns,
    baselineRunsUsed: baselineFiltered.filtered,
    matrixFreeRunsUsed: matrixFreeFiltered.filtered,
    matrixFreePriorityRunsUsed: matrixFreePriorityFiltered.filtered
  };
}

export async function compareTsVsNativeOptimizerBenchmark(baseOptions = {}) {
  const source = isPlainObject(baseOptions) ? baseOptions : {};
  const common = { ...source };
  const repeatRaw = Number(source.repeat ?? source.benchmarkRepeat ?? 1);
  const repeat = Number.isFinite(repeatRaw) ? Math.max(1, Math.floor(repeatRaw)) : 1;
  try { delete common.repeat; } catch (_) {}
  try { delete common.benchmarkRepeat; } catch (_) {}
  try { delete common.forceTs; } catch (_) {}

  const deepClone = (v) => {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch (_) {
      return null;
    }
  };

  const originalSystemConfig = loadSystemConfigurationsRaw();
  const baselineSystemConfig = deepClone(originalSystemConfig);

  const restoreBaselineConfig = () => {
    if (!baselineSystemConfig) return;
    try {
      saveSystemConfigurationsRaw(deepClone(baselineSystemConfig));
    } catch (_) {}
  };

  const runOne = async (route: 'ts' | 'native') => {
    restoreBaselineConfig();
    const options = {
      ...common,
      profile: true,
      forceTs: route === 'ts',
      forceNative: route === 'native'
    };
    const t0 = nowMs();
    const result = await runOptimizationMVP(options);
    const elapsedMs = nowMs() - t0;
    const profile = getLastOptimizeProfile();
    const metrics = pickTimingMetricsFromProfile(profile);
    return { route, options, result, elapsedMs, profile, metrics };
  };

  const tsRuns: any[] = [];
  const nativeRuns: any[] = [];
  try {
    for (let i = 0; i < repeat; i++) {
      tsRuns.push(await runOne('ts'));
      nativeRuns.push(await runOne('native'));
    }
  } finally {
    try {
      if (originalSystemConfig) saveSystemConfigurationsRaw(originalSystemConfig);
    } catch (_) {}
  }

  const summarizeRuns = (runs: any[]) => {
    const nums = (path: string, fallback = 0) => {
      return (Array.isArray(runs) ? runs : []).map((run: any) => {
        try {
          const parts = path.split('.');
          let cur: any = run;
          for (const p of parts) cur = cur?.[p];
          const n = Number(cur);
          return Number.isFinite(n) ? n : fallback;
        } catch (_) {
          return fallback;
        }
      });
    };
    const avg = (values: number[]) => {
      if (!Array.isArray(values) || values.length === 0) return 0;
      return values.reduce((a, b) => a + b, 0) / values.length;
    };
    const countTrue = (path: string) => {
      let c = 0;
      for (const run of (Array.isArray(runs) ? runs : [])) {
        try {
          const parts = path.split('.');
          let cur: any = run;
          for (const p of parts) cur = cur?.[p];
          if (cur === true) c += 1;
        } catch (_) {}
      }
      return c;
    };

    const elapsed = nums('elapsedMs');
    const iterations = nums('result.iterations');
    const best = nums('result.best', Number.NaN).filter((v: number) => Number.isFinite(v));
    const violation = nums('result.violationScore', Number.NaN).filter((v: number) => Number.isFinite(v));
    const objectiveMs = nums('metrics.objectiveMs');
    const wasmMs = nums('metrics.wasmMs');
    const jsMs = nums('metrics.jsMs');

    return {
      repeat: (Array.isArray(runs) ? runs.length : 0),
      okCount: countTrue('result.ok'),
      abortedCount: countTrue('result.aborted'),
      elapsedAvgMs: avg(elapsed),
      iterationsAvg: avg(iterations),
      bestAvg: avg(best),
      violationAvg: avg(violation),
      objectiveAvgMs: avg(objectiveMs),
      wasmAvgMs: avg(wasmMs),
      jsAvgMs: avg(jsMs)
    };
  };

  const ts = summarizeRuns(tsRuns);
  const native = summarizeRuns(nativeRuns);
  const delta = {
    elapsedAvgMs: ts.elapsedAvgMs - native.elapsedAvgMs,
    iterationsAvg: ts.iterationsAvg - native.iterationsAvg,
    bestAvg: ts.bestAvg - native.bestAvg,
    violationAvg: ts.violationAvg - native.violationAvg,
    objectiveAvgMs: ts.objectiveAvgMs - native.objectiveAvgMs,
    wasmAvgMs: ts.wasmAvgMs - native.wasmAvgMs,
    jsAvgMs: ts.jsAvgMs - native.jsAvgMs
  };

  try {
    console.groupCollapsed('[OptimizerMVP] TS(forceTs) vs Native benchmark');
    console.log('ts(forceTs=true)', {
      repeat: ts.repeat,
      okCount: ts.okCount,
      abortedCount: ts.abortedCount,
      elapsedAvgMs: Math.round(ts.elapsedAvgMs),
      iterationsAvg: Math.round(ts.iterationsAvg * 10) / 10,
      bestAvg: Number.isFinite(ts.bestAvg) ? Number(ts.bestAvg.toFixed(6)) : null,
      violationAvg: Number.isFinite(ts.violationAvg) ? Number(ts.violationAvg.toFixed(6)) : null,
      objectiveAvgMs: Math.round(ts.objectiveAvgMs),
      wasmAvgMs: Math.round(ts.wasmAvgMs),
      jsAvgMs: Math.round(ts.jsAvgMs)
    });
    console.log('native(forceTs=false)', {
      repeat: native.repeat,
      okCount: native.okCount,
      abortedCount: native.abortedCount,
      elapsedAvgMs: Math.round(native.elapsedAvgMs),
      iterationsAvg: Math.round(native.iterationsAvg * 10) / 10,
      bestAvg: Number.isFinite(native.bestAvg) ? Number(native.bestAvg.toFixed(6)) : null,
      violationAvg: Number.isFinite(native.violationAvg) ? Number(native.violationAvg.toFixed(6)) : null,
      objectiveAvgMs: Math.round(native.objectiveAvgMs),
      wasmAvgMs: Math.round(native.wasmAvgMs),
      jsAvgMs: Math.round(native.jsAvgMs)
    });
    console.log('delta(ts - native)', {
      elapsedAvgMs: Math.round(delta.elapsedAvgMs),
      iterationsAvg: Math.round(delta.iterationsAvg * 10) / 10,
      bestAvg: Number.isFinite(delta.bestAvg) ? Number(delta.bestAvg.toFixed(6)) : null,
      violationAvg: Number.isFinite(delta.violationAvg) ? Number(delta.violationAvg.toFixed(6)) : null,
      objectiveAvgMs: Math.round(delta.objectiveAvgMs),
      wasmAvgMs: Math.round(delta.wasmAvgMs),
      jsAvgMs: Math.round(delta.jsAvgMs)
    });
    console.groupEnd();
  } catch (_) {}

  return {
    ts,
    native,
    delta,
    tsRuns,
    nativeRuns
  };
}

export async function exportWasmPilotBenchmarkCsv(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const benchmark = source.benchmarkResult && typeof source.benchmarkResult === 'object'
    ? source.benchmarkResult
    : await compareWasmPilotBenchmark(source);

  const baselineRuns = Array.isArray(benchmark?.baselineRuns) ? benchmark.baselineRuns : [];
  const pilotRuns = Array.isArray(benchmark?.pilotRuns) ? benchmark.pilotRuns : [];

  const csvEscape = (value) => {
    const s = String(value ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const rows = [];
  rows.push([
    'mode',
    'runIndex',
    'elapsedMs',
    'objectiveMs',
    'wasmMs',
    'jsMs',
    'objectivePct',
    'wasmPct',
    'jsPct',
    'pilotCalls',
    'pilotHits',
    'pilotFallbacks',
    'pilotHitRatePct',
    'bufferCalls',
    'bufferHits',
    'bufferFallbacks',
    'bufferHitRatePct',
    'ok',
    'best'
  ]);

  const pushRuns = (mode, runs) => {
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i] || {};
      const metrics = run.metrics || {};
      const result = run.result || {};
      rows.push([
        mode,
        i + 1,
        Number(run.elapsedMs) || 0,
        Number(metrics.objectiveMs) || 0,
        Number(metrics.wasmMs) || 0,
        Number(metrics.jsMs) || 0,
        Number(metrics.objectivePct) || 0,
        Number(metrics.wasmPct) || 0,
        Number(metrics.jsPct) || 0,
        Number(metrics.pilotCalls) || 0,
        Number(metrics.pilotHits) || 0,
        Number(metrics.pilotFallbacks) || 0,
        Number(metrics.pilotHitRatePct) || 0,
        Number(metrics.bufferCalls) || 0,
        Number(metrics.bufferHits) || 0,
        Number(metrics.bufferFallbacks) || 0,
        Number(metrics.bufferHitRatePct) || 0,
        !!result.ok,
        Number(result.best)
      ]);
    }
  };

  pushRuns('baseline', baselineRuns);
  pushRuns('pilot', pilotRuns);

  const csv = rows
    .map((row) => row.map(csvEscape).join(','))
    .join('\n');

  const shouldDownload = source.download !== false;
  if (shouldDownload && typeof window !== 'undefined' && typeof document !== 'undefined') {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = String(source.fileName || `wasm-pilot-benchmark-${stamp}.csv`);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (_) {}
  }

  return {
    csv,
    benchmark
  };
}

export async function exportMatrixFreeBenchmarkCsv(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const benchmark = source.benchmarkResult && typeof source.benchmarkResult === 'object'
    ? source.benchmarkResult
    : await compareMatrixFreeBenchmark(source);

  const baselineRuns = Array.isArray(benchmark?.baselineRuns) ? benchmark.baselineRuns : [];
  const matrixFreeRuns = Array.isArray(benchmark?.matrixFreeRuns) ? benchmark.matrixFreeRuns : [];
  const matrixFreePriorityRuns = Array.isArray(benchmark?.matrixFreePriorityRuns) ? benchmark.matrixFreePriorityRuns : [];

  const csvEscape = (value) => {
    const s = String(value ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const rows = [];
  rows.push([
    'mode',
    'runIndex',
    'elapsedMs',
    'objectiveMs',
    'wasmMs',
    'jsMs',
    'objectivePct',
    'wasmPct',
    'jsPct',
    'matrixFreeCalls',
    'matrixFreeHits',
    'matrixFreeFallbacks',
    'matrixFreeHitRatePct',
    'matrixFreeCgIters',
    'matrixFreeSolverIters',
    'matrixFreeMs',
    'matrixFreeResidualNorm',
    'ok',
    'best'
  ]);

  const pushRuns = (mode, runs) => {
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i] || {};
      const metrics = run.metrics || {};
      const result = run.result || {};
      rows.push([
        mode,
        i + 1,
        Number(run.elapsedMs) || 0,
        Number(metrics.objectiveMs) || 0,
        Number(metrics.wasmMs) || 0,
        Number(metrics.jsMs) || 0,
        Number(metrics.objectivePct) || 0,
        Number(metrics.wasmPct) || 0,
        Number(metrics.jsPct) || 0,
        Number(metrics.matrixFreeCalls) || 0,
        Number(metrics.matrixFreeHits) || 0,
        Number(metrics.matrixFreeFallbacks) || 0,
        Number(metrics.matrixFreeHitRatePct) || 0,
        Number(metrics.matrixFreeCgIters) || 0,
        Number(metrics.matrixFreeSolverIters) || 0,
        Number(metrics.matrixFreeMs) || 0,
        Number(metrics.matrixFreeResidualNorm),
        !!result.ok,
        Number(result.best)
      ]);
    }
  };

  pushRuns('baseline', baselineRuns);
  pushRuns('matrixFree', matrixFreeRuns);
  pushRuns('matrixFreePriority', matrixFreePriorityRuns);

  const csv = rows
    .map((row) => row.map(csvEscape).join(','))
    .join('\n');

  const shouldDownload = source.download !== false;
  if (shouldDownload && typeof window !== 'undefined' && typeof document !== 'undefined') {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = String(source.fileName || `matrix-free-benchmark-${stamp}.csv`);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (_) {}
  }

  return {
    csv,
    benchmark
  };
}

function aggregateMatrixFreeRunMetrics(runs = []) {
  const safeRuns = Array.isArray(runs) ? runs : [];
  const fallbackReasons = {};
  let okCount = 0;
  let totalCalls = 0;
  let totalHits = 0;
  let totalFallbacks = 0;
  let totalCgIters = 0;
  let totalSolverIters = 0;
  let totalMatrixFreeMs = 0;
  let residualNormSum = 0;
  let residualNormCount = 0;

  for (let i = 0; i < safeRuns.length; i++) {
    const run = safeRuns[i] || {};
    const metrics = run.metrics || {};
    const profileCounts = run.profile?.counts || {};

    if (run.result?.ok === true) okCount += 1;
    totalCalls += Number(metrics.matrixFreeCalls) || 0;
    totalHits += Number(metrics.matrixFreeHits) || 0;
    totalFallbacks += Number(metrics.matrixFreeFallbacks) || 0;
    totalCgIters += Number(metrics.matrixFreeCgIters) || 0;
    totalSolverIters += Number(metrics.matrixFreeSolverIters) || 0;
    totalMatrixFreeMs += Number(metrics.matrixFreeMs) || 0;

    const residualNorm = Number(metrics.matrixFreeResidualNorm);
    if (Number.isFinite(residualNorm)) {
      residualNormSum += residualNorm;
      residualNormCount += 1;
    }

    const histogram = (profileCounts.kktMatrixFreeFallbackReasons && typeof profileCounts.kktMatrixFreeFallbackReasons === 'object')
      ? profileCounts.kktMatrixFreeFallbackReasons
      : null;
    if (!histogram) continue;
    for (const [reason, count] of Object.entries(histogram)) {
      const n = Number(count) || 0;
      if (n <= 0) continue;
      fallbackReasons[reason] = (Number(fallbackReasons[reason]) || 0) + n;
    }
  }

  const runCount = safeRuns.length;
  const unknownFallbacks = Number(fallbackReasons.unknown) || 0;
  return {
    runCount,
    okRatePct: runCount > 0 ? (100 * okCount / runCount) : 0,
    matrixFreeCalls: totalCalls,
    matrixFreeHits: totalHits,
    matrixFreeFallbacks: totalFallbacks,
    matrixFreeHitRatePct: totalCalls > 0 ? (100 * totalHits / totalCalls) : 0,
    matrixFreeFallbackRate: totalCalls > 0 ? (totalFallbacks / totalCalls) : null,
    matrixFreeUnknownFallbackRate: totalFallbacks > 0 ? (unknownFallbacks / totalFallbacks) : null,
    matrixFreeCgItersAvg: runCount > 0 ? (totalCgIters / runCount) : 0,
    matrixFreeSolverItersAvg: runCount > 0 ? (totalSolverIters / runCount) : 0,
    matrixFreeResidualNormAvg: residualNormCount > 0 ? (residualNormSum / residualNormCount) : null,
    matrixFreeMsAvg: runCount > 0 ? (totalMatrixFreeMs / runCount) : 0,
    matrixFreeFallbackReasons: fallbackReasons
  };
}

function buildMatrixFreeBenchmarkJsonSummary(benchmark, options = {}) {
  const safeBenchmark = (benchmark && typeof benchmark === 'object') ? benchmark : {};
  const baselineRunsUsed = Array.isArray(safeBenchmark.baselineRunsUsed) ? safeBenchmark.baselineRunsUsed : [];
  const matrixFreeRunsUsed = Array.isArray(safeBenchmark.matrixFreeRunsUsed) ? safeBenchmark.matrixFreeRunsUsed : [];
  const matrixFreePriorityRunsUsed = Array.isArray(safeBenchmark.matrixFreePriorityRunsUsed) ? safeBenchmark.matrixFreePriorityRunsUsed : [];

  const matrixFreePhaseC = aggregateMatrixFreeRunMetrics(matrixFreeRunsUsed);
  const matrixFreePriorityPhaseC = aggregateMatrixFreeRunMetrics(matrixFreePriorityRunsUsed);
  const baselineElapsedAvg = Number(safeBenchmark?.baseline?.elapsed?.avg) || 0;
  const matrixFreeElapsedAvg = Number(safeBenchmark?.matrixFree?.elapsed?.avg) || 0;
  const matrixFreePriorityElapsedAvg = Number(safeBenchmark?.matrixFreePriority?.elapsed?.avg) || 0;
  const matrixFreeSpeedup = (baselineElapsedAvg > 0 && matrixFreeElapsedAvg > 0)
    ? (baselineElapsedAvg / matrixFreeElapsedAvg)
    : null;
  const matrixFreePrioritySpeedup = (baselineElapsedAvg > 0 && matrixFreePriorityElapsedAvg > 0)
    ? (baselineElapsedAvg / matrixFreePriorityElapsedAvg)
    : null;

  const hasPriorityPhaseC = matrixFreePriorityPhaseC.matrixFreeCalls > 0 || matrixFreePriorityPhaseC.matrixFreeFallbacks > 0;
  const selectedMode = hasPriorityPhaseC ? 'matrixFreePriority' : 'matrixFree';
  const selectedPhaseC = hasPriorityPhaseC ? matrixFreePriorityPhaseC : matrixFreePhaseC;
  const selectedSpeedup = hasPriorityPhaseC ? matrixFreePrioritySpeedup : matrixFreeSpeedup;
  const baselineOkRatePct = Number(safeBenchmark?.baseline?.okRatePct) || 0;

  return {
    timestamp: new Date().toISOString(),
    config: {
      repeat: Number(options.repeat ?? options.benchmarkRepeat ?? 1) || 1,
      warmupDiscard: Number(options.warmupDiscard ?? options.discardWarmup ?? 0) || 0,
      filterOutliers: options.filterOutliers !== false,
      matchBaselineBestStop: options.matchBaselineBestStop !== false,
      matchBaselineBestRelTol: Number(options.matchBaselineBestRelTol ?? 0) || 0,
      matchBaselineBestAbsTol: Number(options.matchBaselineBestAbsTol ?? 0) || 0,
      matchBaselineBestMinIter: Number(options.matchBaselineBestMinIter ?? 8) || 8
    },
    filtering: safeBenchmark.filtering || {},
    baseline: safeBenchmark.baseline || {},
    matrixFree: {
      ...(safeBenchmark.matrixFree || {}),
      phaseC: matrixFreePhaseC,
      elapsedSpeedup: matrixFreeSpeedup
    },
    matrixFreePriority: {
      ...(safeBenchmark.matrixFreePriority || {}),
      phaseC: matrixFreePriorityPhaseC,
      elapsedSpeedup: matrixFreePrioritySpeedup
    },
    speedups: {
      matrixFreeElapsed: matrixFreeSpeedup,
      matrixFreePriorityElapsed: matrixFreePrioritySpeedup
    },
    phaseC: {
      selectedMode,
      elapsedSpeedup: selectedSpeedup,
      baselineOkRatePct,
      okRatePct: selectedPhaseC.okRatePct,
      okRateDeltaPct: selectedPhaseC.okRatePct - baselineOkRatePct,
      matrixFreeCalls: selectedPhaseC.matrixFreeCalls,
      matrixFreeHits: selectedPhaseC.matrixFreeHits,
      matrixFreeFallbacks: selectedPhaseC.matrixFreeFallbacks,
      matrixFreeHitRatePct: selectedPhaseC.matrixFreeHitRatePct,
      matrixFreeFallbackRate: selectedPhaseC.matrixFreeFallbackRate,
      matrixFreeUnknownFallbackRate: selectedPhaseC.matrixFreeUnknownFallbackRate,
      matrixFreeCgItersAvg: selectedPhaseC.matrixFreeCgItersAvg,
      matrixFreeSolverItersAvg: selectedPhaseC.matrixFreeSolverItersAvg,
      matrixFreeResidualNormAvg: selectedPhaseC.matrixFreeResidualNormAvg,
      matrixFreeMsAvg: selectedPhaseC.matrixFreeMsAvg,
      matrixFreeFallbackReasons: selectedPhaseC.matrixFreeFallbackReasons
    }
  };
}

export async function exportMatrixFreeBenchmarkJson(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const benchmark = source.benchmarkResult && typeof source.benchmarkResult === 'object'
    ? source.benchmarkResult
    : await compareMatrixFreeBenchmark(source);
  const summary = buildMatrixFreeBenchmarkJsonSummary(benchmark, source);
  const json = JSON.stringify(summary, null, 2);

  const shouldDownload = source.download !== false;
  if (shouldDownload && typeof window !== 'undefined' && typeof document !== 'undefined') {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = String(source.fileName || `phase-c-benchmark-${stamp}.json`);
      const blob = new Blob([`${json}\n`], { type: 'application/json;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (_) {}
  }

  return {
    json,
    summary,
    benchmark
  };
}

function summarizeGlobalVsKktRuns(runs = []) {
  const validRuns = Array.isArray(runs) ? runs : [];
  const count = validRuns.length;
  const avg = (selector) => {
    if (count <= 0) return 0;
    return validRuns.reduce((sum, run) => sum + selector(run), 0) / count;
  };
  const bestFinite = validRuns
    .map((run) => Number(run?.best))
    .filter((value) => Number.isFinite(value));
  return {
    runs: count,
    avgElapsedMs: avg((run) => Number(run?.elapsedMs) || 0),
    avgIterations: avg((run) => Number(run?.iterations) || 0),
    avgBest: avg((run) => {
      const value = Number(run?.best);
      return Number.isFinite(value) ? value : 0;
    }),
    okRatePct: count > 0 ? (100 * validRuns.filter((run) => !!run?.ok).length / count) : 0,
    feasibleRatePct: count > 0 ? (100 * validRuns.filter((run) => !!run?.feasible).length / count) : 0,
    bestMin: bestFinite.length > 0 ? Math.min(...bestFinite) : null,
    bestMax: bestFinite.length > 0 ? Math.max(...bestFinite) : null
  };
}

function filterBenchmarkRuns(runs = [], warmupDiscard = 0, filterOutliers = true) {
  const discard = Math.max(0, Math.floor(Number(warmupDiscard) || 0));
  const source = Array.isArray(runs) ? runs.slice(discard) : [];
  if (!filterOutliers || source.length < 5) {
    return {
      filtered: source,
      droppedWarmup: discard,
      droppedOutliers: 0
    };
  }

  const elapsed = source
    .map((run) => Number(run?.elapsedMs) || 0)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (elapsed.length === 0) {
    return { filtered: source, droppedWarmup: discard, droppedOutliers: 0 };
  }
  const median = elapsed.length % 2 === 1
    ? elapsed[Math.floor(elapsed.length / 2)]
    : (elapsed[(elapsed.length / 2) - 1] + elapsed[elapsed.length / 2]) / 2;
  const deviations = elapsed.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const mad = deviations.length % 2 === 1
    ? deviations[Math.floor(deviations.length / 2)]
    : (deviations[(deviations.length / 2) - 1] + deviations[deviations.length / 2]) / 2;
  if (!Number.isFinite(mad) || mad <= 0) {
    return { filtered: source, droppedWarmup: discard, droppedOutliers: 0 };
  }
  const cutoff = median + (6 * mad);
  const filtered = source.filter((run) => (Number(run?.elapsedMs) || 0) <= cutoff);
  return {
    filtered: filtered.length > 0 ? filtered : source,
    droppedWarmup: discard,
    droppedOutliers: Math.max(0, source.length - filtered.length)
  };
}

export async function compareGlobalVsKktBenchmark(baseOptions = {}) {
  const source = isPlainObject(baseOptions) ? baseOptions : {};
  const common = { ...source };
  const repeatRaw = Number(source.repeat ?? source.benchmarkRepeat ?? 1);
  const repeat = Number.isFinite(repeatRaw) ? Math.max(1, Math.floor(repeatRaw)) : 1;
  const warmupDiscardRaw = Number(source.warmupDiscard ?? source.discardWarmup ?? (repeat > 1 ? 1 : 0));
  const warmupDiscard = Number.isFinite(warmupDiscardRaw) ? Math.max(0, Math.floor(warmupDiscardRaw)) : 0;
  const filterOutliers = source.filterOutliers !== false;
  try { delete common.repeat; } catch (_) {}
  try { delete common.benchmarkRepeat; } catch (_) {}
  try { delete common.warmupDiscard; } catch (_) {}
  try { delete common.discardWarmup; } catch (_) {}
  try { delete common.filterOutliers; } catch (_) {}
  try { delete common.download; } catch (_) {}
  try { delete common.fileName; } catch (_) {}

  const deepClone = (value) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return null;
    }
  };

  const originalSystemConfig = loadSystemConfigurationsRaw();
  const baselineSystemConfig = deepClone(originalSystemConfig);
  const restoreBaselineConfig = () => {
    if (!baselineSystemConfig) return;
    try {
      saveSystemConfigurationsRaw(deepClone(baselineSystemConfig));
    } catch (_) {}
  };

  const runOne = async (method) => {
    restoreBaselineConfig();
    const options = { ...common, method, profile: true, forceTs: true };
    const t0 = nowMs();
    const result = await runOptimizationMVP(options);
    const elapsedMs = nowMs() - t0;
    const profile = getLastOptimizeProfile();
    const timing = pickTimingMetricsFromProfile(profile);
    return {
      method,
      elapsedMs,
      result,
      best: Number(result?.objectiveScore ?? result?.best ?? Number.NaN),
      feasible: result?.feasible === undefined ? null : !!result.feasible,
      ok: !!result?.ok,
      iterations: Number(result?.iterations) || 0,
      timing,
      profile
    };
  };

  const kktRuns = [];
  const globalRuns = [];
  try {
    for (let index = 0; index < repeat; index++) {
      kktRuns.push(await runOne('kkt'));
      globalRuns.push(await runOne('global'));
    }
  } finally {
    restoreBaselineConfig();
  }

  const filteredKkt = filterBenchmarkRuns(kktRuns, warmupDiscard, filterOutliers);
  const filteredGlobal = filterBenchmarkRuns(globalRuns, warmupDiscard, filterOutliers);
  const kktSummary = summarizeGlobalVsKktRuns(filteredKkt.filtered);
  const globalSummary = summarizeGlobalVsKktRuns(filteredGlobal.filtered);
  const elapsedSpeedup = (kktSummary.avgElapsedMs > 0 && globalSummary.avgElapsedMs > 0)
    ? (kktSummary.avgElapsedMs / globalSummary.avgElapsedMs)
    : null;
  const bestRatio = (Number.isFinite(globalSummary.avgBest) && Number.isFinite(kktSummary.avgBest) && globalSummary.avgBest > 0)
    ? (kktSummary.avgBest / globalSummary.avgBest)
    : null;

  try {
    console.groupCollapsed('[OptimizerMVP] global vs kkt benchmark');
    console.log('kkt', kktSummary);
    console.log('global', globalSummary);
    console.log('delta', {
      elapsedSpeedup,
      bestRatio,
      filteredKkt,
      filteredGlobal
    });
    console.groupEnd();
  } catch (_) {}

  return {
    timestamp: new Date().toISOString(),
    config: {
      repeat,
      warmupDiscard,
      filterOutliers,
      maxIterations: Number(source.maxIterations ?? common.maxIterations ?? 20) || 20,
      escapeGlobalMaxRestarts: Number(source.escapeGlobalMaxRestarts ?? common.escapeGlobalMaxRestarts ?? 4) || 4,
      escapeGlobalLocalIterations: Number(
        source.escapeGlobalLocalIterations
          ?? common.escapeGlobalLocalIterations
          ?? Math.max(
            1,
            Math.min(
              40,
              Math.ceil(
                Number(source.maxIterations ?? common.maxIterations ?? 20)
                / Math.max(1, Number(source.escapeGlobalMaxRestarts ?? common.escapeGlobalMaxRestarts ?? 4))
              )
            )
          )
      )
    },
    filtering: {
      kkt: {
        droppedWarmup: filteredKkt.droppedWarmup,
        droppedOutliers: filteredKkt.droppedOutliers,
        usedRuns: filteredKkt.filtered.length
      },
      global: {
        droppedWarmup: filteredGlobal.droppedWarmup,
        droppedOutliers: filteredGlobal.droppedOutliers,
        usedRuns: filteredGlobal.filtered.length
      }
    },
    kkt: kktSummary,
    global: globalSummary,
    speedups: {
      elapsed: elapsedSpeedup,
      bestScoreRatio: bestRatio
    },
    detail: {
      kktRuns,
      globalRuns,
      kktRunsUsed: filteredKkt.filtered,
      globalRunsUsed: filteredGlobal.filtered
    }
  };
}

export async function exportGlobalVsKktBenchmarkJson(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const benchmark = source.benchmarkResult && typeof source.benchmarkResult === 'object'
    ? source.benchmarkResult
    : await compareGlobalVsKktBenchmark(source);
  const json = JSON.stringify(benchmark, null, 2);

  const shouldDownload = source.download !== false;
  if (shouldDownload && typeof window !== 'undefined' && typeof document !== 'undefined') {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = String(source.fileName || `global-vs-kkt-benchmark-${stamp}.json`);
      const blob = new Blob([`${json}\n`], { type: 'application/json;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (_) {}
  }

  return {
    json,
    summary: benchmark,
    benchmark
  };
}

function bumpOptimizerProfileCount(name, delta = 1) {
  try {
    const g = (typeof globalThis !== 'undefined') ? globalThis : null;
    const p = g ? g.__cooptOptimizerProfileContext : null;
    const counts = p && typeof p === 'object' ? p.counts : null;
    if (!counts || typeof counts !== 'object') return;
    const key = String(name || '').trim();
    if (!key) return;
    const d = Number(delta);
    const add = Number.isFinite(d) ? d : 1;
    counts[key] = (Number(counts[key]) || 0) + add;
  } catch (_) {
    // ignore
  }
}

// Yield via MessageChannel.postMessage — not subject to Chrome's background/low-power
// timer throttling (unlike setTimeout which can be delayed to 1000ms+ in background tabs).
function yieldViaMessageChannel(callback: () => void): void {
  try {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); callback(); };
    ch.port2.postMessage(null);
    ch.port2.close();
  } catch (_) {
    // Fallback if MessageChannel is unavailable
    setTimeout(callback, 0);
  }
}

function yieldViaMicrotask(callback: () => void): void {
  try {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(callback);
      return;
    }
  } catch (_) {
    // fall through
  }
  Promise.resolve().then(callback).catch(() => callback());
}

let __cooptLastOptimizerUiYieldAt = 0;
const COOPT_OPTIMIZER_UI_YIELD_MIN_INTERVAL_MS = 120;

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

  const shouldUseImmediateBackgroundYield = (() => {
    try {
      if (!isTauriRuntime()) return false;
      const localHidden = typeof document !== 'undefined' && !!document && document.hidden === true;
      const schedulerHidden = !!(schedulerWindow && schedulerWindow.document && schedulerWindow.document.hidden === true);
      return localHidden || schedulerHidden;
    } catch (_) {
      return false;
    }
  })();

  const now = nowMs();
  if ((now - __cooptLastOptimizerUiYieldAt) < COOPT_OPTIMIZER_UI_YIELD_MIN_INTERVAL_MS) {
    return Promise.resolve();
  }
  __cooptLastOptimizerUiYieldAt = now;

  if (!prof) {
    return new Promise((resolve) => {
      if (canUseSchedulerRaf) {
        schedulerWindow.requestAnimationFrame(() => resolve());
        return;
      }
      if (shouldUseImmediateBackgroundYield) {
        yieldViaMicrotask(() => resolve());
        return;
      }
      // Use MessageChannel for yields when rAF is not available (background/low-power mode).
      // MessageChannel.postMessage fires as a task without the 1000ms+ throttle Chrome applies
      // to setTimeout(0) in background tabs or macOS low-power mode.
      yieldViaMessageChannel(() => resolve());
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
    if (shouldUseImmediateBackgroundYield) {
      yieldViaMicrotask(done);
      return;
    }
    // Use MessageChannel for yields when rAF is not available (background/low-power mode).
    yieldViaMessageChannel(done);
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

function getPrimaryWavelengthForOptimization() {
  try {
    if (typeof window !== 'undefined' && typeof window.getPrimaryWavelength === 'function') {
      const wl = Number(window.getPrimaryWavelength());
      if (Number.isFinite(wl) && wl > 0) return wl;
    }
  } catch (_) {}
  return 0.5875618;
}

function resolveParaxialScalar(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    const t = Number(value.tangential);
    if (Number.isFinite(t)) return t;
    const s = Number(value.sagittal);
    if (Number.isFinite(s)) return s;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function normalizeGapThicknessMode(raw) {
  const mode = String(raw ?? '').trim().replace(/\s+/g, '').toUpperCase();
  if (mode === 'IMD' || mode === 'BFL') return mode;
  return '';
}

function applyGapThicknessModesToBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return;
  const primaryWavelength = getPrimaryWavelengthForOptimization();
  if (!(Number.isFinite(primaryWavelength) && primaryWavelength > 0)) return;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || typeof block !== 'object') continue;

    const blockType = String(block.blockType ?? '').trim();
    if (blockType !== 'Gap' && blockType !== 'AirGap') continue;

    const params = (block.parameters && typeof block.parameters === 'object') ? block.parameters : null;
    if (!params) continue;

    const mode = normalizeGapThicknessMode(params.thicknessMode);
    if (!mode) continue;

    let target = NaN;
    try {
      const expanded = expandBlocksToOpticalSystemRows(blocks);
      const rows = (expanded && Array.isArray(expanded.rows)) ? expanded.rows : null;
      if (!rows || rows.length === 0) continue;
      const paraxial = calculateParaxialData(rows, primaryWavelength);
      target = resolveParaxialScalar(mode === 'IMD' ? paraxial?.imageDistance : paraxial?.backFocalLength);
    } catch (_) {
      target = NaN;
    }

    if (!Number.isFinite(target)) continue;
    params.thickness = target;
    try {
      if (block.variables && typeof block.variables === 'object' && block.variables.thickness && typeof block.variables.thickness === 'object') {
        block.variables.thickness.value = target;
      }
    } catch (_) {}
  }
}

function expandBlocksForOptimization(blocks) {
  if (!Array.isArray(blocks)) return null;
  let workingBlocks = blocks;
  try {
    workingBlocks = JSON.parse(JSON.stringify(blocks));
  } catch (_) {
    workingBlocks = Array.isArray(blocks) ? blocks.slice() : blocks;
  }

  // Gap.thicknessMode is a derived evaluation convenience. Keep it off the
  // canonical Design Intent blocks so non-V gaps do not persist as optimizer edits.
  applyGapThicknessModesToBlocks(workingBlocks);
  return expandBlocksToOpticalSystemRows(workingBlocks);
}

function materializeGapThicknessModesForPersistence(blocks) {
  if (!Array.isArray(blocks)) return null;
  let persistedBlocks = blocks;
  try {
    persistedBlocks = JSON.parse(JSON.stringify(blocks));
  } catch (_) {
    persistedBlocks = Array.isArray(blocks) ? blocks.slice() : blocks;
  }

  applyGapThicknessModesToBlocks(persistedBlocks);
  return persistedBlocks;
}

function materializeBlockVariableValuesFromParameters(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const params = isPlainObject(block.parameters) ? block.parameters : null;
    const vars = isPlainObject(block.variables) ? block.variables : null;
    if (!params || !vars) continue;
    for (const [key, entry] of Object.entries(vars)) {
      if (!isPlainObject(entry)) continue;
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
      entry.value = params[key];
    }
  }
  return blocks;
}

function updateExpandedOpticalSystemInConfig(config) {
  if (!config || !Array.isArray(config.blocks)) return;

  const disablePersistedTableFallback = (() => {
    try {
      return !!(typeof globalThis !== 'undefined' && (globalThis as any).__cooptDisablePersistedTableFallback);
    } catch (_) {
      return false;
    }
  })();

  const blocksHaveObjectSurface = (() => {
    try { return config.blocks.some(b => String(b?.blockType ?? '').trim() === 'ObjectSurface'); } catch (_) { return false; }
  })();

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

    if (disablePersistedTableFallback) return null;

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
  const legacyRows = (() => {
    try {
      if (Array.isArray(config?.opticalSystem) && config.opticalSystem.length > 0) {
        return config.opticalSystem;
      }
    } catch (_) {}

    if (disablePersistedTableFallback) return null;

    try {
      const rows = tryLoadPersistedOpticalSystemTableData();
      return Array.isArray(rows) ? rows : null;
    } catch (_) {
      return null;
    }
  })();

  if (Array.isArray(legacyRows) && legacyRows.length > 0) {
    try {
      config.opticalSystem = JSON.parse(JSON.stringify(legacyRows));
    } catch (_) {
      config.opticalSystem = legacyRows;
    }
  }

  const expanded = expandBlocksIntoConfiguration(config);
  const rows = (expanded && Array.isArray(expanded.expandedOpticalSystem))
    ? expanded.expandedOpticalSystem
    : (Array.isArray(config.opticalSystem) ? config.opticalSystem : null);
  if (Array.isArray(rows) && preservedObjectThickness !== null && rows[0] && typeof rows[0] === 'object') {
    rows[0].thickness = preservedObjectThickness;
  }
}

function coerceInfiniteRadiusVariableValue(key, rawValue) {
  const s = String(rawValue ?? '').trim();
  if (!/^inf(inity)?$/i.test(s)) return null;
  if (!(/^(front|back)radius$/i.test(String(key ?? '').trim()) || /^radius$/i.test(String(key ?? '').trim()) || /^surf\d+radius$/i.test(String(key ?? '').trim()))) {
    return null;
  }
  // Approximate a flat surface with a very large finite radius so numeric optimizers
  // can start moving from an INF design-intent seed.
  return 1e6;
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

    const infRadiusValue = coerceInfiniteRadiusVariableValue(key, raw);
    if (infRadiusValue !== null) {
      return { ...v, value: infRadiusValue };
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
    .filter(v => v && !isMaterialKey(v.key) && typeof v.value === 'number' && Number.isFinite(v.value));
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

function preserveBlockVariableMetadata(originalBlocks, nextBlocks) {
  if (!Array.isArray(originalBlocks) || !Array.isArray(nextBlocks)) return nextBlocks;

  const nextByBlockId = new Map();
  for (const block of nextBlocks) {
    const blockId = String(block?.blockId ?? '').trim();
    if (blockId) nextByBlockId.set(blockId, block);
  }

  for (const originalBlock of originalBlocks) {
    const blockId = String(originalBlock?.blockId ?? '').trim();
    if (!blockId) continue;
    const nextBlock = nextByBlockId.get(blockId);
    if (!nextBlock) continue;

    const originalVars = isPlainObject(originalBlock?.variables) ? originalBlock.variables : null;
    if (!originalVars) continue;

    if (!isPlainObject(nextBlock.variables)) nextBlock.variables = {};
    const nextVars = nextBlock.variables;
    const nextParams = isPlainObject(nextBlock.parameters) ? nextBlock.parameters : null;

    for (const [key, originalEntry] of Object.entries(originalVars)) {
      if (!isPlainObject(originalEntry)) continue;

      const nextEntry = isPlainObject(nextVars[key]) ? nextVars[key] : {};
      const mergedEntry = { ...originalEntry, ...nextEntry };

      const originalOptimize = isPlainObject(originalEntry.optimize) ? originalEntry.optimize : null;
      const nextOptimize = isPlainObject(nextEntry.optimize) ? nextEntry.optimize : null;
      if (originalOptimize || nextOptimize) {
        mergedEntry.optimize = {
          ...(originalOptimize || {}),
          ...(nextOptimize || {}),
        };
      }

      if (!Object.prototype.hasOwnProperty.call(mergedEntry, 'value')) {
        if (nextParams && Object.prototype.hasOwnProperty.call(nextParams, key)) {
          mergedEntry.value = nextParams[key];
        } else if (Object.prototype.hasOwnProperty.call(originalEntry, 'value')) {
          mergedEntry.value = originalEntry.value;
        }
      }

      nextVars[key] = mergedEntry;
    }
  }

  return nextBlocks;
}

function persistBlocksByConfigIdToSystemConfig({ systemConfig, configsById, targetConfigIds, blocksByConfigId }) {
  try {
    const ids = Array.isArray(targetConfigIds) ? targetConfigIds.map(id => String(id)) : [];
    for (const cid of ids) {
      const cfg = configsById ? configsById[String(cid)] : null;
      const blocks = blocksByConfigId ? blocksByConfigId[String(cid)] : null;
      if (!cfg || !Array.isArray(blocks)) continue;
      const baselineBlocks = (() => {
        const fromState = arguments[0]?.baselineBlocksByConfigId;
        const baseline = fromState && typeof fromState === 'object' ? fromState[String(cid)] : null;
        return Array.isArray(baseline) ? baseline : (Array.isArray(cfg.blocks) ? cfg.blocks : []);
      })();
      const persistedBlocks = preserveBlockVariableMetadata(
        baselineBlocks,
        materializeGapThicknessModesForPersistence(blocks),
      );
      materializeBlockVariableValuesFromParameters(persistedBlocks);
      cfg.blocks = Array.isArray(persistedBlocks)
        ? persistedBlocks
        : JSON.parse(JSON.stringify(blocks));
      updateExpandedOpticalSystemInConfig(cfg);
      syncDerivedSystemDataFromOpticalSystem(cfg);
    }
    return saveSystemConfigurationsRaw(systemConfig);
  } catch {
    return false;
  }
}

function syncDerivedSystemDataFromOpticalSystem(cfg) {
  try {
    if (!cfg || typeof cfg !== 'object') return;
    const rows = Array.isArray(cfg.opticalSystem) ? cfg.opticalSystem : null;
    if (!rows || rows.length === 0) return;

    const primaryWavelength = getPrimaryWavelengthForOptimization();
    const diffParams = calculateImageSpaceDiffractionParams(rows, primaryWavelength);
    const workingFNumber = Number(diffParams?.fNumberWorking);
    const entrancePupilDiameterMm = Number(diffParams?.entrancePupilDiameterMm);

    const nextSystemData = {
      ...(cfg.systemData && typeof cfg.systemData === 'object' ? cfg.systemData : {})
    };

    if (Number.isFinite(workingFNumber) && workingFNumber > 0) {
      nextSystemData.paraxialWorkingFNumber = workingFNumber;
    } else {
      delete nextSystemData.paraxialWorkingFNumber;
    }

    if (Number.isFinite(entrancePupilDiameterMm) && entrancePupilDiameterMm > 0) {
      nextSystemData.entrancePupilDiameterMm = entrancePupilDiameterMm;
    } else {
      delete nextSystemData.entrancePupilDiameterMm;
    }

    cfg.systemData = nextSystemData;
  } catch (_) {}
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
    const restoredBlocksByConfigId = snapshotBlocksByConfigId(finalEval.blocksSnapshot);
    const okRestore = restoreBlocksByConfigId(jointState?.blocksByConfigId, restoredBlocksByConfigId);
    if (!okRestore) return false;

    // Keep the active-config evaluator consistent with the restored blocks.
    try {
      const activeId = String(jointState?.activeConfigId ?? '').trim();
      if (activeId) {
        const ab = restoredBlocksByConfigId ? restoredBlocksByConfigId[activeId] : null;
        if (Array.isArray(ab)) updateActiveOpticalSystemOverrideFromBlocks(ab);
      }
    } catch (_) {}

    return persistBlocksByConfigIdToSystemConfig({
      systemConfig,
      configsById,
      targetConfigIds,
      blocksByConfigId: restoredBlocksByConfigId,
      baselineBlocksByConfigId: jointState?.baselineBlocksByConfigId
    });
  } catch {
    return false;
  }
}

function getFatalExpandIssuesForBlocks(blocks) {
  try {
    if (!Array.isArray(blocks) || blocks.length === 0) return [];
    const expanded = expandBlocksToOpticalSystemRows(blocks);
    const issues = Array.isArray(expanded?.issues) ? expanded.issues : [];
    return issues.filter(issue => issue && issue.severity === 'fatal');
  } catch (error) {
    return [{
      severity: 'fatal',
      phase: 'expand',
      message: (error && error.message) ? String(error.message) : 'Block expansion failed.'
    }];
  }
}

function formatFatalExpandIssues(configs) {
  const messages = [];
  for (const cfg of Array.isArray(configs) ? configs : []) {
    if (!cfg || !Array.isArray(cfg.blocks)) continue;
    const fatals = getFatalExpandIssuesForBlocks(cfg.blocks);
    if (fatals.length === 0) continue;

    const cfgLabel = cfg?.name
      ? `${String(cfg.name)}(${String(cfg?.id ?? '')})`
      : String(cfg?.id ?? '');
    const samples = fatals.slice(0, 3).map(issue => {
      const blockId = String(issue?.blockId ?? '').trim();
      const msg = String(issue?.message ?? 'Invalid block layout.').trim();
      return blockId ? `${blockId}: ${msg}` : msg;
    });
    messages.push(`${cfgLabel}: ${samples.join(' | ')}${fatals.length > 3 ? ' | ...' : ''}`);
  }
  return messages;
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

function parseFiniteRadiusForOptimizer(value) {
  const s = String(value ?? '').trim();
  if (!s || /^inf(inity)?$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) < 1e-12) return null;
  return n;
}

function parseRadiusCurvatureForOptimizer(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^inf(inity)?$/i.test(s)) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) < 1e-12) return null;
  return 1 / n;
}

function getBendingConfigForOptimizer(block) {
  const blockType = String(block?.blockType ?? '').trim();
  if (blockType === 'Lens' || blockType === 'PositiveLens') {
    return { radiusAKey: 'frontRadius', radiusBKey: 'backRadius' };
  }
  return null;
}

function getOptimizerBlockValue(block, key) {
  if (!isPlainObject(block)) return undefined;
  const params = isPlainObject(block.parameters) ? block.parameters : null;
  if (params && Object.prototype.hasOwnProperty.call(params, key)) {
    const value = params[key];
    if (value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')) {
      return value;
    }
  }
  const vars = isPlainObject(block.variables) ? block.variables : null;
  if (vars && isPlainObject(vars[key]) && Object.prototype.hasOwnProperty.call(vars[key], 'value')) {
    return vars[key].value;
  }
  return undefined;
}

function computeLensBendingValueForOptimizer(block) {
  if (!isPlainObject(block)) return '';
  const config = getBendingConfigForOptimizer(block);
  if (!config) return '';

  const c1 = parseRadiusCurvatureForOptimizer(getOptimizerBlockValue(block, config.radiusAKey));
  const c2 = parseRadiusCurvatureForOptimizer(getOptimizerBlockValue(block, config.radiusBKey));
  if (c1 === null || c2 === null) return '';

  const curvatureDiff = c1 - c2;
  if (!Number.isFinite(curvatureDiff) || Math.abs(curvatureDiff) < 1e-12) return '';

  const bending = (c1 + c2) / curvatureDiff;
  return Number.isFinite(bending) ? bending : '';
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
  if (String(key ?? '').trim().toLowerCase() === 'bending') {
    return computeLensBendingValueForOptimizer(block);
  }
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
  if (String(key ?? '').trim().toLowerCase() === 'bending') {
    return computeLensBendingValueForOptimizer(block);
  }
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
    const expanded = expandBlocksForOptimization(activeCfg?.blocks);
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

function getPreferredGlassManufacturers() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = JSON.parse(localStorage.getItem('coopt.glassMap.defaultManufacturers') || '[]');
    if (!Array.isArray(raw)) return [];
    const allow = new Set(['SCHOTT', 'HOYA', 'HIKARI', 'OHARA', 'SUMITA', 'CDGM', 'SPECIAL']);
    const out = [];
    for (const value of raw) {
      const upper = String(value ?? '').trim().toUpperCase();
      if (!upper || !allow.has(upper)) continue;
      out.push(upper);
    }
    return Array.from(new Set(out));
  } catch {
    return [];
  }
}

function isGlassAllowedByPreferredManufacturers(name, preferredManufacturers) {
  if (!Array.isArray(preferredManufacturers) || preferredManufacturers.length === 0) return true;
  try {
    const glass = getGlassDataWithSellmeier(name);
    const manufacturer = String(glass?.manufacturer ?? '').trim().toUpperCase();
    if (!manufacturer) return false;
    return preferredManufacturers.includes(manufacturer);
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
  const preferredManufacturers = getPreferredGlassManufacturers();
  // NOTE: material(V) discrete optimization must not pick AIR for Lens blocks.
  return merged
    .filter(glassExists)
    .filter(m => !isAirMaterialName(m))
    .filter(m => isGlassAllowedByPreferredManufacturers(m, preferredManufacturers))
    .slice(0, 10);
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

  const infRadiusValue = coerceInfiniteRadiusVariableValue(key, raw);
  if (infRadiusValue !== null) return { ...v, value: infRadiusValue };

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
      } else if (typeof out.value === 'number' && Number.isFinite(out.value)) {
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
    } else if (typeof out.value === 'number' && Number.isFinite(out.value)) {
      numeric.push(out);
    }
  }

  return { numeric, categoricalMaterial, errors };
}

function updateActiveOpticalSystemOverrideFromBlocks(activeBlocks) {
  try {
    const expanded = expandBlocksForOptimization(activeBlocks);
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
  const preferredManufacturers = getPreferredGlassManufacturers();

  if (isPlainObject(entry)) {
    // Support either `candidates` or `options` arrays.
    candidates = normalizeStringList(entry.candidates || entry.options || []);
  }

  if (candidates.length === 0) {
    candidates = defaultMaterialCandidatesFromConfig(activeCfg);
  }

  try {
    const id = String(variableId ?? '').trim();
    const dot = id.indexOf('.');
    if (dot > 0 && activeCfg && Array.isArray(activeCfg.blocks)) {
      const blockId = id.slice(0, dot);
      const key = id.slice(dot + 1);
      const block = activeCfg.blocks.find(b => isPlainObject(b) && String(b.blockId) === blockId);
      const params = isPlainObject(block?.parameters) ? block.parameters : null;
      const materialText = String(currentValue ?? '').trim();
      const numericMaterial = Number(materialText);
      const glass = materialText ? getGlassDataWithSellmeier(materialText) : null;
      const match = key.match(/^material(\d*)$/i);
      const suffix = match ? String(match[1] ?? '') : '';
      const rindexKey = suffix ? `rindex${suffix}` : 'rindex';
      const abbeKey = suffix ? `abbe${suffix}` : 'abbe';
      const ndRaw = params && Object.prototype.hasOwnProperty.call(params, rindexKey) ? params[rindexKey] : null;
      const vdRaw = params && Object.prototype.hasOwnProperty.call(params, abbeKey) ? params[abbeKey] : null;
      const vdTarget = Number.isFinite(Number(vdRaw)) && Number(vdRaw) > 0
        ? Number(vdRaw)
        : (Number.isFinite(Number(glass?.vd)) ? Number(glass.vd) : NaN);
      const ndTarget = Number.isFinite(Number(ndRaw)) && Number(ndRaw) > 1 && Number(ndRaw) < 4
        ? Number(ndRaw)
        : (Number.isFinite(numericMaterial) && numericMaterial > 1 && numericMaterial < 4
        ? numericMaterial
        : (Number.isFinite(Number(glass?.nd)) ? Number(glass.nd) : NaN));

      if (Number.isFinite(ndTarget) && Number.isFinite(vdTarget)) {
        const nearby = findSimilarGlassesByNdVd(ndTarget, vdTarget, 8)
          .filter(g => isGlassAllowedByPreferredManufacturers(g?.name, preferredManufacturers))
          .map(g => String(g?.name ?? '').trim())
          .filter(Boolean);
        candidates = normalizeStringList([...candidates, ...nearby]);
      }
    }
  } catch (_) {}

  // Ensure current value is included.
  const cur = String(currentValue ?? '').trim();
  let merged = normalizeStringList([cur, ...candidates])
    .filter(glassExists)
    .filter(m => !isAirMaterialName(m))
    .filter(m => m === cur || isGlassAllowedByPreferredManufacturers(m, preferredManufacturers))
    .slice(0, 12);

  // If the variable only offered AIR (or current is AIR), fall back to defaults (still excluding AIR).
  if (merged.length === 0) {
    merged = defaultMaterialCandidatesFromConfig(activeCfg);
  }

  return merged;
}

function toFiniteNumber(value, fallback = 0) {
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
    param5: r.param5,
    fieldScope: r.fieldScope,
    wavelengthScope: r.wavelengthScope,
    op,
    tol,
    target,
    weight,
    rationale: r.rationale
  };
}

function getRequirementScopeParamKey(operand, scope) {
  const definition = OPERAND_DEFINITIONS[String(operand ?? '').trim()];
  const parameters = Array.isArray(definition?.parameters) ? definition.parameters : [];
  for (const parameter of parameters) {
    const label = String(parameter?.label ?? '').toLowerCase();
    const description = String(parameter?.description ?? '').toLowerCase();
    const matches = scope === 'field'
      ? label.includes('field idx') || label.includes('object idx') || description.includes('object row')
      : label.includes('λ') || description.includes('source row');
    if (matches) return String(parameter?.key ?? '').trim() || null;
  }
  return null;
}

function expandRequirementScopesForOptimizer(rows, systemConfig, fallbackConfigId, sourceRowsOverride = null) {
  const configs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
  const expanded = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const configId = String(row.configId ?? fallbackConfigId ?? '').trim();
    const config = configs.find((entry) => String(entry?.id ?? '') === configId) || configs[0] || null;
    const objectRows = Array.isArray(config?.object) ? config.object : [];
    const sourceRows = Array.isArray(sourceRowsOverride) && sourceRowsOverride.length > 0
      ? sourceRowsOverride
      : (Array.isArray(config?.source) && config.source.length > 0
        ? config.source
        : (Array.isArray(systemConfig?.source) ? systemConfig.source : []));
    const fieldKey = getRequirementScopeParamKey(row.operand, 'field');
    const wavelengthKey = getRequirementScopeParamKey(row.operand, 'wavelength');
    const usesWeightedAllWavelengths = [
      'FL', 'EFL', 'EFFL', 'PP1', 'PP2', 'BFL',
      'IMD', 'BEXP', 'EXPD', 'EXPP', 'ENPD', 'ENPP', 'ENPM',
      'PMAG', 'FNO_OBJ', 'FNO_IMG', 'FNO_WRK', 'NA_OBJ', 'NA_IMG',
      'MTFT', 'MTFS', 'MTFA',
    ].includes(
      String(row.operand ?? '').trim().toUpperCase()
    )
      && String(row.wavelengthScope ?? '').trim().toUpperCase() === 'ALL';
    const resolveValues = (scopeValue, count, supported) => {
      if (!supported) return [null];
      const scope = String(scopeValue ?? '').trim().toUpperCase();
      if (!scope || scope === 'DEFAULT') return [null];
      if (scope === 'PRIMARY') return [''];
      if (scope !== 'ALL') return [String(scopeValue)];
      return count > 0 ? Array.from({ length: count }, (_, index) => String(index + 1)) : [null];
    };
    const fieldValues = resolveValues(row.fieldScope, objectRows.length, !!fieldKey);
    const wavelengthValues = usesWeightedAllWavelengths
      ? ['ALL_WEIGHTED']
      : resolveValues(row.wavelengthScope, sourceRows.length, !!wavelengthKey);
    for (const fieldValue of fieldValues) {
      for (const wavelengthValue of wavelengthValues) {
        const scoped = { ...row };
        if (fieldKey && fieldValue !== null) scoped[fieldKey] = fieldValue;
        if (wavelengthKey && wavelengthValue !== null) scoped[wavelengthKey] = wavelengthValue;
        expanded.push(scoped);
      }
    }
  }
  return expanded;
}

function getSystemRequirementsRaw(systemConfig, overrideRows = null) {
  if (Array.isArray(overrideRows) && overrideRows.length > 0) {
    return overrideRows;
  }
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

function updatePowellDampedBfgs(hessian, step, gradientDelta) {
  const size = Array.isArray(step) ? step.length : 0;
  if (!size || !Array.isArray(hessian) || hessian.length !== size || !Array.isArray(gradientDelta) || gradientDelta.length !== size) {
    return null;
  }

  const hessianStep = new Array(size).fill(0);
  for (let row = 0; row < size; row++) {
    if (!Array.isArray(hessian[row]) || hessian[row].length !== size) return null;
    for (let col = 0; col < size; col++) {
      hessianStep[row] += Number(hessian[row][col]) * Number(step[col]);
    }
  }

  let stepHessianStep = 0;
  let stepGradientDelta = 0;
  for (let index = 0; index < size; index++) {
    stepHessianStep += Number(step[index]) * hessianStep[index];
    stepGradientDelta += Number(step[index]) * Number(gradientDelta[index]);
  }
  if (!Number.isFinite(stepHessianStep) || stepHessianStep <= 1e-18 || !Number.isFinite(stepGradientDelta)) return null;

  const theta = stepGradientDelta >= 0.2 * stepHessianStep
    ? 1
    : (0.8 * stepHessianStep) / (stepHessianStep - stepGradientDelta);
  const dampedGradientDelta = gradientDelta.map((value, index) => (
    theta * Number(value) + (1 - theta) * hessianStep[index]
  ));
  let stepDampedGradientDelta = 0;
  for (let index = 0; index < size; index++) {
    stepDampedGradientDelta += Number(step[index]) * dampedGradientDelta[index];
  }
  if (!Number.isFinite(stepDampedGradientDelta) || stepDampedGradientDelta <= 1e-18) return null;

  const updated = Array.from({ length: size }, () => Array(size).fill(0));
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      updated[row][col] = Number(hessian[row][col])
        - (hessianStep[row] * hessianStep[col]) / stepHessianStep
        + (dampedGradientDelta[row] * dampedGradientDelta[col]) / stepDampedGradientDelta;
      if (!Number.isFinite(updated[row][col])) return null;
    }
  }
  return updated;
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

function isEvalTie(a, b) {
  if (!a || !b) return false;
  if (!!a.feasible !== !!b.feasible) return false;

  const aV = toFiniteNumber(a.violationScore, Infinity);
  const bV = toFiniteNumber(b.violationScore, Infinity);
  if (Math.abs(aV - bV) > 1e-12) return false;

  const aS = toFiniteNumber(a.score, Infinity);
  const bS = toFiniteNumber(b.score, Infinity);
  return Math.abs(aS - bS) <= 1e-12;
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
        param5: r.param5,
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

function expandRequirementsForTargetConfigs(requirements, targetConfigIds, activeConfigId) {
  const ids = Array.isArray(targetConfigIds) ? targetConfigIds.map(id => String(id)) : [];
  const idSet = new Set(ids);
  const activeId = (activeConfigId === undefined || activeConfigId === null) ? '' : String(activeConfigId).trim();
  const rows = Array.isArray(requirements) ? requirements : [];
  /** @type {any[]} */
  const out = [];

  for (const r of rows) {
    if (!r || !r.enabled) continue;
    if (!r.operand) continue;
    const cfg = String(r.configId ?? '').trim();
    if (!cfg) {
      // Keep "Current" scoped to the active configuration instead of expanding it to every target config.
      if (activeId && idSet.has(activeId)) out.push({ ...r, configId: activeId });
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
  multiScenario,
  collectRequirementSnapshots = false
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
  const operandValueCache = new Map();

  let feasible = true;
  let violationScore = 0;
  let softPenalty = 0;
  const hardViolations = [];
  const softViolations = [];
  const requirementSnapshotsById = new Map();

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
        param5: r.param5,
        target: r.target,
        weight: r.weight
      };

      const opCacheKey = [
        String(cfgId),
        String(it.scenarioId ?? ''),
        String(r.operand ?? ''),
        String(r.param1 ?? ''),
        String(r.param2 ?? ''),
        String(r.param3 ?? ''),
        String(r.param4 ?? ''),
        String(r.param5 ?? '')
      ].join('|');

      let rawValue;
      if (operandValueCache.has(opCacheKey)) {
        bumpOptimizerProfileCount('operandValueCacheHits', 1);
        rawValue = operandValueCache.get(opCacheKey);
      } else {
        bumpOptimizerProfileCount('operandValueCacheMisses', 1);
        rawValue = editor.calculateOperandValue(opObj);
        operandValueCache.set(opCacheKey, rawValue);
      }

      const evaluated = computeAmountOrPenalty(r.op, rawValue, r.target, r.tol);
      const current = evaluated.current;
      const amount = evaluated.amount;
      try {
        const reqId = (r?.id === undefined || r?.id === null) ? '' : String(r.id);
        if (reqId) {
          const contribution = Number.isFinite(amount) ? (w * Math.max(0, amount)) : null;
          const snapshot = {
            id: r.id,
            configId: cfgId,
            scenarioId: it.scenarioId ? String(it.scenarioId) : null,
            current: rawValue,
            ok: evaluated.ok === true,
            amount: Number.isFinite(amount) ? amount : null,
            contribution: Number.isFinite(contribution) ? contribution : null,
            reason: evaluated.reason,
          };
          const prevSnapshot = requirementSnapshotsById.get(reqId);
          const prevContribution = Number(prevSnapshot?.contribution);
          const nextContribution = Number(snapshot.contribution);
          if (!prevSnapshot || !Number.isFinite(prevContribution) || (Number.isFinite(nextContribution) && nextContribution >= prevContribution)) {
            requirementSnapshotsById.set(reqId, snapshot);
          }
        }
      } catch (_) {}
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
      hardViolations.push(entry);
    }

    for (const snapshot of requirementSnapshotsById.values()) {
      const contribution = Number(snapshot?.contribution);
      if (Number.isFinite(contribution) && contribution > 0) violationScore += contribution;
    }

    return {
      feasible,
      violationScore,
      softPenalty,
      hardViolations,
      softViolations,
      requirementSnapshots: collectRequirementSnapshots ? Array.from(requirementSnapshotsById.values()) : undefined
    };
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
  const snapshotCurrentSweepBlocks = () => {
    try {
      if (jointState?.blocksByConfigId) return snapshotBlocksByConfigId(jointState.blocksByConfigId);
      const cid = String(jointState?.activeConfigId ?? activeCfg?.id ?? 'active').trim() || 'active';
      return { [cid]: JSON.parse(JSON.stringify(activeCfg?.blocks || [])) };
    } catch (_) {
      return null;
    }
  };
  const withCurrentSweepSnapshot = (evalResult) => {
    if (!evalResult || typeof evalResult !== 'object') return evalResult;
    const snap = snapshotCurrentSweepBlocks();
    return snap ? { ...evalResult, blocksSnapshot: snap } : evalResult;
  };

  for (const v of catVars) {
    if (shouldStop && shouldStop()) break;

    const baseValue = String(v.value ?? '').trim();
    const forceReplaceNonGlassBase = baseValue !== '' && !isAirMaterialName(baseValue) && !glassExists(baseValue);
  const js = jointState || { blocksByConfigId: null, targetConfigIds: null, activeConfigId: activeCfg?.id };
  const { configId, baseId } = parseJointVariableId(v.id);
  const cidForCandidates = configId ? String(configId) : String(js.activeConfigId ?? '');
  const cfgViewForCandidates = { blocks: (js.blocksByConfigId && js.blocksByConfigId[cidForCandidates]) || activeCfg?.blocks };
  const candidates = getMaterialCandidatesForVar(cfgViewForCandidates, baseId, baseValue);
    const replacementCandidates = candidates.filter(c => {
      const materialName = String(c ?? '').trim();
      return materialName !== '' && materialName !== baseValue && !isAirMaterialName(materialName);
    });
    if (replacementCandidates.length === 0) continue;

    let bestLocalValue = forceReplaceNonGlassBase ? '' : baseValue;
    let bestLocalEval = forceReplaceNonGlassBase ? null : best;

    for (const cand of replacementCandidates) {
      if (shouldStop && shouldStop()) break;

      const okSet = jointState
        ? setJointDesignVariableValue(jointState, v.id, cand)
        : setDesignVariableValue(activeCfg, v.id, cand);
      if (!okSet) continue;

      const e = evalState ? withCurrentSweepSnapshot(evalState()) : null;

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

      if (e && (bestLocalEval === null || compareEval(e, bestLocalEval))) {
        bestLocalEval = e;
        bestLocalValue = cand;
      }
    }

    if (shouldStop && shouldStop()) break;

    if (bestLocalEval && (forceReplaceNonGlassBase || compareEval(bestLocalEval, best))) {
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
      if (!forceReplaceNonGlassBase) {
        if (jointState) setJointDesignVariableValue(jointState, v.id, baseValue);
        else setDesignVariableValue(activeCfg, v.id, baseValue);
      }

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

function getSurfaceTypeKeyForCoefficient(key) {
  const value = String(key ?? '').trim();
  if (!isAsphereCoefKey(value)) return null;
  if (/^front(?:coef\d+|a\d+)$/i.test(value)) return 'frontSurfType';
  if (/^back(?:coef\d+|a\d+)$/i.test(value)) return 'backSurfType';
  const surfaceMatch = value.match(/^surf(\d+)(?:coef\d+|a\d+)$/i);
  if (surfaceMatch) return `surf${surfaceMatch[1]}SurfType`;
  if (/^(?:coef\d+|a\d+)$/i.test(value)) return 'surfType';
  return null;
}

function isQconCoefficientVariable(block, key) {
  const surfaceTypeKey = getSurfaceTypeKeyForCoefficient(key);
  if (!surfaceTypeKey || !isPlainObject(block)) return false;
  const surfaceType = String(getOptimizerBlockValue(block, surfaceTypeKey) ?? '')
    .trim()
    .replace(/[\s_-]+/g, '')
    .toLowerCase();
  return surfaceType === 'qcon' || surfaceType === 'qconic' || surfaceType === 'qtype';
}

function defaultScaleForKey(key) {
  const s = String(key ?? '').trim();
  if (!s) return 1;
  if (/bending$/i.test(s)) return 0.25;
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
    // Scaling strategy: match typical coefficient magnitudes to make scaled values ~1.0.
    // Relax higher-order exponents further so A12+ terms do not become effectively frozen
    // by tiny trust-region and finite-difference scales.
    if (idx === null) return 1e-12;

    const power = 2 * (idx + 1);
    let exp = -power;
    if (power >= 20) exp += 6;
    else if (power >= 16) exp += 5;
    else if (power >= 12) exp += 4;
    else if (power >= 8) exp += 2;

    const sc = Math.pow(10, exp);
    return (Number.isFinite(sc) && sc > 0) ? sc : 1e-18;
  }
  if (/conic$/i.test(s)) return 1;
  if (/^rindex\d*$/i.test(s) || /^nd\d*$/i.test(s)) return 0.05;
  if (/^(abbe|vd)\d*$/i.test(s)) return 5;
  if (/radius$/i.test(s) || /^radius\d+$/i.test(s)) return 100;
  if (/thickness$/i.test(s) || /^thickness\d+$/i.test(s)) return 10;
  if (/semidiameter$/i.test(s) || /semidia$/i.test(s) || /^s\d+$/i.test(s)) return 10;
  return 1;
}

function defaultScaleForBlockVariable(block, key) {
  // Qcon coefficients multiply normalized Jacobi terms directly and are
  // commonly order 1. They do not use even-asphere coefficient scaling.
  if (isQconCoefficientVariable(block, key)) return 1;
  return defaultScaleForKey(key);
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
  return resetCount;
}

function clampEscapePositive(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeEscapeMinima(rawMinima) {
  if (!Array.isArray(rawMinima)) return [];
  const minima = [];
  for (const raw of rawMinima) {
    if (!raw || typeof raw !== 'object') continue;
    const center = Array.isArray(raw.center)
      ? raw.center.map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : [];
    if (center.length === 0) continue;
    const scales = Array.isArray(raw.scales)
      ? raw.scales.map((value) => clampEscapePositive(value, 1))
      : [];
    minima.push({
      center,
      scales: center.map((_, index) => clampEscapePositive(scales[index], 1)),
      width: clampEscapePositive(raw.width, 0.75),
      height: clampEscapePositive(raw.height, 1),
      label: String(raw.label || '').trim()
    });
  }
  return minima;
}

function computeEscapePenaltyScore(point, minima) {
  if (!Array.isArray(point) || point.length === 0 || !Array.isArray(minima) || minima.length === 0) {
    return 0;
  }
  let penalty = 0;
  for (const minimum of minima) {
    const center = Array.isArray(minimum?.center) ? minimum.center : [];
    if (center.length === 0) continue;
    const scales = Array.isArray(minimum?.scales) ? minimum.scales : [];
    const width = clampEscapePositive(minimum?.width, 0.75);
    const height = clampEscapePositive(minimum?.height, 1);
    let distanceSquared = 0;
    const count = Math.min(point.length, center.length);
    for (let index = 0; index < count; index++) {
      const value = Number(point[index]);
      const base = Number(center[index]);
      if (!Number.isFinite(value) || !Number.isFinite(base)) continue;
      const scale = clampEscapePositive(scales[index], 1) * width;
      const delta = (value - base) / scale;
      distanceSquared += delta * delta;
    }
    penalty += height * Math.exp(-distanceSquared);
  }
  return Number.isFinite(penalty) ? penalty : 0;
}

async function readCurrentRequirementScoreForEscapeSearch() {
  try {
    const editor = (typeof window !== 'undefined') ? window.systemRequirementsEditor : null;
    if (editor && typeof editor.evaluateAndUpdateNow === 'function') {
      const maybePromise = editor.evaluateAndUpdateNow({
        reason: 'escape-global-score',
        forceSilent: true,
        silent: true
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        await maybePromise;
      }
    }
  } catch (_) {}

  try {
    const editor = (typeof window !== 'undefined') ? window.systemRequirementsEditor : null;
    if (editor && typeof editor.getData === 'function') {
      const rows = editor.getData();
      if (Array.isArray(rows)) {
        let total = 0;
        let count = 0;
        for (const row of rows) {
          const enabled = row?.enabled === undefined || row?.enabled === null ? true : !!row.enabled;
          const operand = String(row?.operand ?? '').trim();
          const weight = Number(row?.weight ?? 1);
          if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) continue;
          const contribution = Number.isFinite(Number(row?._contribution))
            ? Number(row._contribution)
            : Number(row?.score);
          if (!Number.isFinite(contribution)) continue;
          total += Math.max(0, contribution);
          count += 1;
        }
        if (count > 0 && Number.isFinite(total)) return total;
      }
    }
  } catch (_) {}

  return Number.NaN;
}

function captureEscapeVariableState(activeCfg) {
  const allMarked = listDesignVariablesFromBlocks(activeCfg || {});
  const numericVars = Array.isArray(allMarked)
    ? allMarked.filter((entry) => Number.isFinite(Number(entry?.value)))
    : [];
  return numericVars.map((entry) => {
    const value = Number(entry.value);
    const block = Array.isArray(activeCfg?.blocks)
      ? activeCfg.blocks.find(candidate => String(candidate?.blockId ?? '') === String(entry?.blockId ?? ''))
      : null;
    const baseScale = defaultScaleForBlockVariable(block, entry?.key);
    return {
      id: String(entry.id),
      key: String(entry.key ?? ''),
      value,
      scale: Math.max(baseScale, Math.abs(value) || 0)
    };
  });
}

function getEscapeSnapshotBaseFileName() {
  let loadedName = '';
  try {
    const fromStorageApi = (typeof window !== 'undefined' && window.__cooptLoadedFileStorage && typeof window.__cooptLoadedFileStorage.getLoadedFileName === 'function')
      ? window.__cooptLoadedFileStorage.getLoadedFileName()
      : null;
    loadedName = String(fromStorageApi || '').trim();
  } catch (_) {}

  if (!loadedName) {
    try {
      loadedName = String(localStorage.getItem('loadedFileName') || '').trim();
    } catch (_) {}
  }

  if (!loadedName) {
    try {
      loadedName = String(window.__cooptLoadedFileNameRuntime || '').trim();
    } catch (_) {}
  }

  if (!loadedName) {
    return 'coopt';
  }

  const normalized = loadedName.replace(/\\/g, '/');
  const leaf = normalized.split('/').pop() || normalized;
  const noExt = leaf.replace(/\.[^.]+$/g, '');
  const safe = noExt.replace(/[^0-9A-Za-z._-]/g, '_').replace(/_+/g, '_').trim();
  return safe || 'coopt';
}

function formatEscapeSnapshotScoreToken(score) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return 'NaN';
  const formatted = Number.isInteger(numeric)
    ? String(numeric)
    : Number(numeric.toFixed(6)).toString();
  return formatted.replace(/[^0-9A-Za-z._-]/g, '_');
}

function buildEscapeSnapshotFileName(loopIndex, score) {
  const base = getEscapeSnapshotBaseFileName();
  const loopNum = String(Math.max(1, Number(loopIndex) || 1)).padStart(3, '0');
  const scoreToken = formatEscapeSnapshotScoreToken(score);
  return `${base}_${loopNum}_score_${scoreToken}.json`;
}

async function saveEscapeSnapshotToOpfs(payload, fileName) {
  try {
    if (typeof navigator === 'undefined') return false;
    const storage = navigator?.storage;
    if (!storage || typeof storage.getDirectory !== 'function') return false;

    const root = await storage.getDirectory();
    const dir = await root.getDirectoryHandle('coopt-escape-snapshots', { create: true });
    const handle = await dir.getFileHandle(String(fileName || 'escape-snapshot.json'), { create: true });
    const writable = await handle.createWritable();
    const json = JSON.stringify(payload, null, 2);
    await writable.write(`${json}\n`);
    await writable.close();

    try {
      const key = 'coopt.escapeSnapshotsIndex';
      const existing = JSON.parse(localStorage.getItem(key) || '[]');
      const list = Array.isArray(existing) ? existing : [];
      list.push({
        fileName: String(fileName || ''),
        savedAt: String(payload?.savedAt || new Date().toISOString()),
        loopScore: Number(payload?.loopScore),
        escapeLoop: Number(payload?.escapeLoop),
      });
      localStorage.setItem(key, JSON.stringify(list.slice(-2000)));
    } catch (_) {}

    return true;
  } catch (_) {
    return false;
  }
}

function downloadEscapeSnapshotJson(payload, fileName) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  try {
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([`${json}\n`], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(fileName || 'escape-snapshot.json');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (_) {}
}

async function persistEscapeSnapshotJson(payload, fileName, mode = 'auto') {
  const normalizedMode = String(mode || 'auto').trim().toLowerCase();

  // In Chrome, OPFS enables prompt-free automatic file updates.
  if (normalizedMode !== 'download') {
    const savedToOpfs = await saveEscapeSnapshotToOpfs(payload, fileName);
    if (savedToOpfs) return;
    if (normalizedMode === 'opfs') return;
  }

  downloadEscapeSnapshotJson(payload, fileName);
}

async function clearEscapeSnapshotsInOpfs() {
  const out = { ok: false, deleted: 0 };
  try {
    if (typeof navigator === 'undefined') {
      try { localStorage.removeItem('coopt.escapeSnapshotsIndex'); } catch (_) {}
      return out;
    }
    const storage = (navigator as any)?.storage;
    if (!storage || typeof storage.getDirectory !== 'function') {
      try { localStorage.removeItem('coopt.escapeSnapshotsIndex'); } catch (_) {}
      return out;
    }

    const root = await storage.getDirectory();
    const dir = await root.getDirectoryHandle('coopt-escape-snapshots', { create: true });
    const names: string[] = [];
    for await (const [name] of dir.entries()) {
      names.push(String(name || ''));
    }
    for (const name of names) {
      if (!name) continue;
      try {
        await dir.removeEntry(name, { recursive: true } as any);
        out.deleted += 1;
      } catch (_) {}
    }

    try { localStorage.removeItem('coopt.escapeSnapshotsIndex'); } catch (_) {}
    out.ok = true;
    return out;
  } catch (_) {
    try { localStorage.removeItem('coopt.escapeSnapshotsIndex'); } catch (_) {}
    return out;
  }
}

async function readAllEscapeSnapshotsFromOpfs() {
  const result = {
    ok: false,
    source: 'none',
    count: 0,
    snapshots: [] as any[],
  };

  try {
    if (typeof navigator === 'undefined') return result;
    const storage = (navigator as any)?.storage;
    if (!storage || typeof storage.getDirectory !== 'function') return result;

    const root = await storage.getDirectory();
    const dir = await root.getDirectoryHandle('coopt-escape-snapshots', { create: true });
    const entries: Array<{ name: string; handle: any }> = [];
    for await (const [name, handle] of dir.entries()) {
      entries.push({ name: String(name || ''), handle });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const snapshots: any[] = [];
    for (const entry of entries) {
      try {
        if (!entry?.handle || entry.handle.kind !== 'file') continue;
        const file = await entry.handle.getFile();
        const text = await file.text();
        let payload: any = null;
        try {
          payload = JSON.parse(text);
        } catch (_) {
          payload = null;
        }
        snapshots.push({
          fileName: entry.name,
          size: Number(file?.size) || 0,
          lastModified: Number(file?.lastModified) || 0,
          payload,
          raw: payload == null ? text : undefined,
        });
      } catch (_) {}
    }

    return {
      ok: true,
      source: 'opfs',
      count: snapshots.length,
      snapshots,
    };
  } catch (_) {
    return result;
  }
}

function normalizeZipFileName(fileName) {
  const raw = String(fileName || 'escape-snapshots-archive.zip').trim();
  if (!raw) return 'escape-snapshots-archive.zip';
  return raw.toLowerCase().endsWith('.zip') ? raw : `${raw}.zip`;
}

function sanitizeZipEntryFileName(name, fallback = 'snapshot') {
  const base = String(name || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return base || String(fallback || 'snapshot');
}

function getEscapeSnapshotZipEntryName(entry, index) {
  const payload = entry && typeof entry === 'object' ? entry.payload : null;
  const escapeLoop = Math.max(1, Number(payload?.escapeLoop) || Number(index) || 1);
  const bestScore = Number(payload?.bestScoreAtSave);
  if (Number.isFinite(bestScore)) {
    return buildEscapeSnapshotFileName(escapeLoop, bestScore);
  }
  return String(entry?.fileName || `snapshot_${String(Math.max(1, Number(index) || 1)).padStart(3, '0')}.json`);
}

function getEscapeSnapshotZipEntryDate(entry) {
  const payloadSavedAt = String(entry?.payload?.savedAt || '').trim();
  if (payloadSavedAt) {
    const parsed = new Date(payloadSavedAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const lastModified = Number(entry?.lastModified);
  if (Number.isFinite(lastModified) && lastModified > 0) {
    const parsed = new Date(lastModified);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

async function buildEscapeSnapshotsZipBlob(archive) {
  const mod = await import('jszip');
  const JSZipCtor = (mod as any)?.default || mod;
  const zip = new JSZipCtor();
  zip.file('archive-metadata.json', `${JSON.stringify({
    exportedAt: archive?.exportedAt,
    format: archive?.format,
    source: archive?.source,
    count: archive?.count,
  }, null, 2)}\n`);

  const snapshots = Array.isArray(archive?.snapshots) ? archive.snapshots : [];
  const snapshotsDir = zip.folder('snapshots');
  for (let i = 0; i < snapshots.length; i++) {
    const entry = snapshots[i] || {};
    const sourceName = sanitizeZipEntryFileName(getEscapeSnapshotZipEntryName(entry, i + 1));
    const zipName = sourceName.toLowerCase().endsWith('.json') ? sourceName : `${sourceName}.json`;
    const zipDate = getEscapeSnapshotZipEntryDate(entry);
    const text = entry?.payload == null
      ? String(entry?.raw ?? '')
      : JSON.stringify(entry.payload, null, 2);
    if (snapshotsDir && typeof snapshotsDir.file === 'function') {
      snapshotsDir.file(zipName, `${text}\n`, { date: zipDate });
    } else {
      zip.file(`snapshots/${zipName}`, `${text}\n`, { date: zipDate });
    }
  }

  return await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

async function downloadEscapeSnapshotsArchiveZip(archive, fileName) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  try {
    const blob = await buildEscapeSnapshotsZipBlob(archive);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = normalizeZipFileName(fileName);
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  } catch (_) {
    return false;
  }
}

async function exportEscapeSnapshotsArchive(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const baseName = getEscapeSnapshotBaseFileName();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = normalizeZipFileName(source.fileName || `${baseName}_escape_snapshots_${stamp}.zip`);

  const opfsRead = await readAllEscapeSnapshotsFromOpfs();
  const archive = {
    exportedAt: new Date().toISOString(),
    format: 'coopt-escape-snapshots-archive-v1',
    source: opfsRead.source,
    count: Number(opfsRead.count) || 0,
    snapshots: Array.isArray(opfsRead.snapshots) ? opfsRead.snapshots : [],
  };

  if (source.download !== false) {
    await downloadEscapeSnapshotsArchiveZip(archive, fileName);
  }

  return {
    ok: true,
    fileName,
    count: archive.count,
    archive,
  };
}

async function listEscapeSnapshots() {
  const opfsRead = await readAllEscapeSnapshotsFromOpfs();
  return {
    ok: true,
    source: opfsRead.source,
    count: Number(opfsRead.count) || 0,
    files: (Array.isArray(opfsRead.snapshots) ? opfsRead.snapshots : []).map((entry) => ({
      fileName: String(entry?.fileName || ''),
      size: Number(entry?.size) || 0,
      lastModified: Number(entry?.lastModified) || 0,
      escapeLoop: Number(entry?.payload?.escapeLoop),
      loopScore: Number(entry?.payload?.loopScore),
      savedAt: String(entry?.payload?.savedAt || ''),
    })),
  };
}

async function runEscapeFunctionGlobalOptimization(options = {}) {
  const outerOpts = isPlainObject(options) ? { ...options } : {};
  const escapeSnapshotResetOnRun = outerOpts.escapeSnapshotResetOnRun !== false;
  const escapeSnapshotSaveMode = String(outerOpts.escapeSnapshotSaveMode || 'auto').trim().toLowerCase();
  const methodRaw = String(outerOpts.method || 'global-al').trim().toLowerCase();
  // Auto mode is default. Manual inner/outer loop settings are honored only when explicitly requested.
  const escapeIterationMode = String(
    outerOpts.escapeIterationMode
      ?? outerOpts.escapeGlobalIterationMode
      ?? 'auto'
  ).trim().toLowerCase();
  const useManualEscapeIterations = escapeIterationMode === 'manual';
  
  // Auto-set inner method based on global method if not explicitly specified
  let innerMethodRaw = String(
    outerOpts.escapeInnerMethod
      || outerOpts.globalInnerMethod
      || outerOpts.escapeLocalMethod
      || (methodRaw === 'global-lm' ? 'lm' : 'kkt')
  ).trim().toLowerCase();
  
  const innerMethod = innerMethodRaw === 'cd' || innerMethodRaw === 'lm' || innerMethodRaw === 'kkt'
    ? innerMethodRaw
    : 'kkt';
  const targetIterations = Number.isFinite(Number(outerOpts.maxIterations))
    ? Math.max(1, Math.floor(Number(outerOpts.maxIterations)))
    : 24;
  const configuredOuterLoops = Number.isFinite(Number(outerOpts.escapeGlobalMaxRestarts))
    ? Math.max(1, Math.floor(Number(outerOpts.escapeGlobalMaxRestarts)))
    : 4;
  const activeCfgForEscape = getActiveConfigRef(loadSystemConfigurationsRaw());
  const escapeVariableCount = Math.max(0, captureEscapeVariableState(activeCfgForEscape).length);
  const autoInnerIterationsByBudget = Math.max(1, Math.ceil(targetIterations / Math.max(1, configuredOuterLoops)));
  const autoInnerIterationsByVariables = escapeVariableCount > 0
    ? Math.ceil(escapeVariableCount * 1.5)
    : 0;
  const innerIterationsDefault = Math.max(
    1,
    Math.min(targetIterations, Math.max(autoInnerIterationsByBudget, autoInnerIterationsByVariables))
  );
  const innerIterations = useManualEscapeIterations && Number.isFinite(Number(outerOpts.escapeGlobalLocalIterations))
    ? Math.max(1, Math.floor(Number(outerOpts.escapeGlobalLocalIterations)))
    : innerIterationsDefault;
  const useTotalIterationBudget = (() => {
    if (outerOpts.escapeGlobalUseTotalIterationBudget === true) return true;
    if (outerOpts.escapeGlobalUseTotalIterationBudget === false) return false;
    // Treat Max Iterations as a per-Escape inner budget so Global keeps
    // progressing through every configured Escape loop instead of stopping
    // at Escape 1 once the first inner run consumes the whole budget.
    return false;
  })();
  const plannedTotalIterations = useTotalIterationBudget
    ? targetIterations
    : Math.max(1, innerIterations * Math.max(1, configuredOuterLoops));
  // Escape count follows configured outer loops strictly.
  const outerLoops = Math.max(1, configuredOuterLoops);
  const escapeWidth = clampEscapePositive(outerOpts.escapeFunctionWidth ?? outerOpts.escapeGlobalWidth, 0.75);
  const escapeHeightFactor = clampEscapePositive(outerOpts.escapeFunctionHeight ?? outerOpts.escapeGlobalHeight, 4);
  const escapeHeightFloor = clampEscapePositive(outerOpts.escapeFunctionHeightFloor ?? outerOpts.escapeGlobalHeightFloor, 1);
  const minima = normalizeEscapeMinima(outerOpts.__escapeGlobalMinima);
  const progress = typeof outerOpts.onProgress === 'function' ? outerOpts.onProgress : null;
  const shouldStop = typeof outerOpts.shouldStop === 'function' ? outerOpts.shouldStop : null;
  const makeInnerOpts = (escapeMinima, iterBudget, onProgressProxy) => ({
    ...outerOpts,
    method: innerMethod,
    maxIterations: Math.max(1, Math.floor(Number(iterBudget) || innerIterations)),
    onProgress: typeof onProgressProxy === 'function' ? onProgressProxy : outerOpts.onProgress,
    forceNative: outerOpts.forceNative === undefined ? true : !!outerOpts.forceNative,
    kktUseWasmPilotOptimizer: outerOpts.kktUseWasmPilotOptimizer !== false,
    kktUseMatrixFreeCore: outerOpts.kktUseMatrixFreeCore !== false,
    kktMatrixFreePriority: outerOpts.kktMatrixFreePriority === undefined ? true : !!outerOpts.kktMatrixFreePriority,
    __escapeGlobalMinima: escapeMinima,
    __escapeGlobalDepth: Number(outerOpts.__escapeGlobalDepth || 0) + 1
  });

  let bestResult = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestSystemConfigSnapshot = null;
  let bestOpticalSystemRowsSnapshot = null;
  let totalIterations = 0;

  // Start each Global(Escape) run from a clean snapshot set to avoid mixing old files.
  if (escapeSnapshotResetOnRun) {
    try {
      await clearEscapeSnapshotsInOpfs();
    } catch (_) {}
  }

  for (let loopIndex = 0; loopIndex < outerLoops; loopIndex++) {
    if (shouldStop && shouldStop()) break;
    if (useTotalIterationBudget && totalIterations >= targetIterations) break;

    const remainingIterations = useTotalIterationBudget
      ? Math.max(1, targetIterations - totalIterations)
      : innerIterations;
    const iterBudget = useTotalIterationBudget
      ? Math.max(1, Math.min(innerIterations, remainingIterations))
      : Math.max(1, innerIterations);

    if (progress) {
      try {
        progress({
          phase: loopIndex === 0 ? 'escape-start' : 'escape-restart',
          iter: loopIndex,
          current: Number.isFinite(bestScore) ? bestScore : Number.NaN,
          best: Number.isFinite(bestScore) ? bestScore : Number.NaN,
          method: methodRaw,
          escapeLoop: loopIndex + 1,
          escapeLoops: outerLoops,
          maxIterations: plannedTotalIterations,
          accepted: false
        });
      } catch (_) {}
    }

    let loopExternalBestScore = Number.POSITIVE_INFINITY;
    const loopExternalReads: Promise<void>[] = [];
    const sampleExternalScore = (fallbackValue) => {
      const task = (async () => {
        const externalScore = await readCurrentRequirementScoreForEscapeSearch();
        const candidate = Number.isFinite(externalScore)
          ? externalScore
          : Number(fallbackValue);
        if (Number.isFinite(candidate)) {
          loopExternalBestScore = Math.min(loopExternalBestScore, candidate);
        }
      })();
      loopExternalReads.push(task);
      void task.catch(() => {});
    };
    const innerProgressProxy = (payload) => {
      if (progress) {
        try { progress(payload); } catch (_) {}
      }
      sampleExternalScore(Number(payload?.current));
    };

    const result = await runOptimizationMVP(makeInnerOpts(minima, iterBudget, innerProgressProxy));
    if (loopExternalReads.length > 0) {
      try { await Promise.allSettled(loopExternalReads); } catch (_) {}
    }
    const consumed = Number.isFinite(Number(result?.iterations))
      ? Math.max(0, Math.floor(Number(result.iterations)))
      : 0;
    totalIterations += consumed;
    const actualScore = await readCurrentRequirementScoreForEscapeSearch();
    if (Number.isFinite(actualScore)) {
      loopExternalBestScore = Math.min(loopExternalBestScore, actualScore);
    }
    const candidateScore = Number.isFinite(actualScore)
      ? actualScore
      : Number(result?.objectiveScore ?? result?.best ?? Number.NaN);
    const escapeLoopExternalBestScore = Number.isFinite(loopExternalBestScore)
      ? loopExternalBestScore
      : candidateScore;
    const escapeLoopBestScore = (() => {
      const byEscapeBest = Number(result?.best);
      if (Number.isFinite(byEscapeBest)) return byEscapeBest;
      const byObjective = Number(result?.objectiveScore);
      if (Number.isFinite(byObjective)) return byObjective;
      return Number(candidateScore);
    })();

    // Persist a JSON snapshot for each escape iteration.
    try {
      const snapshotSystemConfig = loadSystemConfigurationsRaw();
      const snapshotRows = (() => {
        try {
          if (typeof window !== 'undefined' && typeof window.getOpticalSystemRows === 'function') {
            const rows = window.getOpticalSystemRows(window.tableOpticalSystem);
            return Array.isArray(rows) ? JSON.parse(JSON.stringify(rows)) : [];
          }
        } catch (_) {}
        return [];
      })();
      const baseSystemConfig = (snapshotSystemConfig && typeof snapshotSystemConfig === 'object')
        ? (() => {
            try { return JSON.parse(JSON.stringify(snapshotSystemConfig)); } catch (_) { return snapshotSystemConfig; }
          })()
        : {};

      const activeConfig = (() => {
        try {
          const cfgs = Array.isArray((baseSystemConfig as any)?.configurations)
            ? (baseSystemConfig as any).configurations
            : [];
          const activeId = (baseSystemConfig as any)?.activeConfigId;
          return cfgs.find((c: any) => String(c?.id ?? '') === String(activeId ?? '')) || cfgs[0] || null;
        } catch (_) {
          return null;
        }
      })();

      // Save as a normal loadable design JSON (top-level configurations),
      // and keep escape-search metadata as extra fields.
      const payload = {
        ...(baseSystemConfig as any),
        savedAt: new Date().toISOString(),
        optimizer: 'global-escape',
        escapeLoop: loopIndex + 1,
        escapeLoops: outerLoops,
        loopScore: Number.isFinite(candidateScore) ? candidateScore : null,
        bestScoreAtSave: Number.isFinite(escapeLoopExternalBestScore) ? escapeLoopExternalBestScore : null,
        bestInternalScoreAtSave: Number.isFinite(escapeLoopBestScore) ? escapeLoopBestScore : null,
        globalBestAtSave: Number.isFinite(bestScore) ? bestScore : null,
        innerMethod,
        maxIterations: plannedTotalIterations,
        totalIterations,
        opticalSystemRowsSnapshot: snapshotRows,
        source: Array.isArray((baseSystemConfig as any)?.source)
          ? (baseSystemConfig as any).source
          : (Array.isArray(activeConfig?.source) ? activeConfig.source : []),
        object: Array.isArray((baseSystemConfig as any)?.object)
          ? (baseSystemConfig as any).object
          : (Array.isArray(activeConfig?.object) ? activeConfig.object : []),
      };
      const fileName = buildEscapeSnapshotFileName(loopIndex + 1, escapeLoopExternalBestScore);
      await persistEscapeSnapshotJson(payload, fileName, escapeSnapshotSaveMode);
    } catch (_) {}

    const bestCandidateForSelection = Number.isFinite(escapeLoopExternalBestScore)
      ? escapeLoopExternalBestScore
      : candidateScore;
    if (!bestResult || (Number.isFinite(bestCandidateForSelection) && bestCandidateForSelection < bestScore)) {
      bestResult = result;
      bestScore = bestCandidateForSelection;
      bestSystemConfigSnapshot = (() => {
        const fromResult = result?.systemConfigSnapshot;
        if (fromResult && typeof fromResult === 'object') {
          try { return JSON.parse(JSON.stringify(fromResult)); } catch (_) { return fromResult; }
        }
        try {
          return JSON.parse(JSON.stringify(loadSystemConfigurationsRaw()));
        } catch (_) {
          return null;
        }
      })();
      bestOpticalSystemRowsSnapshot = (() => {
        const fromResult = result?.opticalSystemRowsSnapshot;
        if (Array.isArray(fromResult) && fromResult.length > 0) {
          try { return JSON.parse(JSON.stringify(fromResult)); } catch (_) { return fromResult; }
        }
        try {
          if (typeof window !== 'undefined' && typeof window.getOpticalSystemRows === 'function') {
            const rows = window.getOpticalSystemRows(window.tableOpticalSystem);
            return Array.isArray(rows) ? JSON.parse(JSON.stringify(rows)) : [];
          }
        } catch (_) {}
        return [];
      })();
    }

    if (loopIndex >= outerLoops - 1) break;
    if (useTotalIterationBudget && totalIterations >= targetIterations) break;
    if (consumed <= 0) {
      // Prevent dead-loop when inner solver reports no progress/iterations.
      break;
    }

    const activeSystemConfig = loadSystemConfigurationsRaw();
    const activeCfg = getActiveConfigRef(activeSystemConfig);
    if (!activeCfg) break;

    const variableState = captureEscapeVariableState(activeCfg);
    if (variableState.length === 0) break;

    minima.push({
      center: variableState.map((entry) => entry.value),
      scales: variableState.map((entry) => clampEscapePositive(entry.scale, 1)),
      width: escapeWidth,
      height: Math.max(
        escapeHeightFloor,
        Math.abs(Number.isFinite(candidateScore) ? candidateScore : bestScore) * escapeHeightFactor
      ),
      label: `escape-${loopIndex + 1}`
    });
  }

  if (bestSystemConfigSnapshot) {
    try {
      saveSystemConfigurationsRaw(bestSystemConfigSnapshot);
    } catch (_) {}
  }

  if (Array.isArray(bestOpticalSystemRowsSnapshot) && bestOpticalSystemRowsSnapshot.length > 0) {
    try {
      const table = (typeof window !== 'undefined') ? window.tableOpticalSystem : null;
      if (table && typeof table.setData === 'function') {
        await table.setData(bestOpticalSystemRowsSnapshot);
      }
    } catch (_) {}
  }

  const base = bestResult && typeof bestResult === 'object' ? { ...bestResult } : {};
  return {
    ...base,
    ok: !!bestResult?.ok,
    aborted: !!bestResult?.aborted,
    method: 'global',
    globalMethod: 'escape',
    innerMethod,
    iterations: useTotalIterationBudget
      ? Math.max(0, Math.min(totalIterations, targetIterations))
      : Math.max(0, totalIterations),
    best: Number.isFinite(bestScore) ? bestScore : Number(base?.best ?? Number.NaN),
    objectiveScore: Number.isFinite(bestScore) ? bestScore : Number(base?.objectiveScore ?? Number.NaN),
    escapeMinimaCount: minima.length,
    systemConfigSnapshot: bestSystemConfigSnapshot || base?.systemConfigSnapshot,
    opticalSystemRowsSnapshot: Array.isArray(bestOpticalSystemRowsSnapshot)
      ? bestOpticalSystemRowsSnapshot
      : base?.opticalSystemRowsSnapshot
  };
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
  const configuredRayGridSize = loadOptimizeRayGridSize();
  const configuredSpotRayCount = Number.isFinite(Number(opts.spotRayCountFast))
    ? Math.max(1, Math.floor(Number(opts.spotRayCountFast)))
    : optimizeRayCountFromGridSize(configuredRayGridSize);
  const configuredMtfSamplingSize = Number.isFinite(Number(opts.mtfSamplingSizeFast))
    ? Math.max(16, Math.min(4096, Math.floor(Number(opts.mtfSamplingSizeFast))))
    : Math.max(16, configuredRayGridSize);
  const optsWithSpeedPreset = {
    ...opts,
    spotRayCountFast: configuredSpotRayCount,
    mtfSamplingSizeFast: configuredMtfSamplingSize,
    systemRequirementsRows: Array.isArray(opts.systemRequirementsRows)
      ? applyOptimizerRequirementSampling(opts.systemRequirementsRows, configuredSpotRayCount, configuredMtfSamplingSize)
      : opts.systemRequirementsRows,
    forceNative: opts.forceNative === undefined ? true : !!opts.forceNative,
    kktUseWasmPilotOptimizer: opts.kktUseWasmPilotOptimizer !== false,
    kktUseMatrixFreeCore: opts.kktUseMatrixFreeCore !== false,
    kktMatrixFreePriority: opts.kktMatrixFreePriority === undefined ? true : !!opts.kktMatrixFreePriority,
  };
  const methodRaw = String(opts.method || '').trim().toLowerCase();
  const escapeGlobalDepth = Number(optsWithSpeedPreset.__escapeGlobalDepth || 0);
  if (escapeGlobalDepth <= 0 && (methodRaw === 'global' || methodRaw === 'escape' || methodRaw === 'escapefunction' || methodRaw === 'global-al' || methodRaw === 'global-lm')) {
    return runEscapeFunctionGlobalOptimization(optsWithSpeedPreset);
  }
  const kktUseWasmPilotOptimizer = optsWithSpeedPreset?.kktUseWasmPilotOptimizer !== false;
  const systemConfigForRoute = loadSystemConfigurationsRaw();
  const activeCfgForRoute = getActiveConfigRef(systemConfigForRoute);
  const categoricalMaterialVarsForRoute = activeCfgForRoute
    ? getCategoricalMaterialVariables(activeCfgForRoute)
    : [];
  const requestedMethod = (methodRaw === 'kkt-sqp' || methodRaw === 'sqp' || methodRaw === 'sqp-kkt')
    ? 'kkt-sqp'
    : (methodRaw === 'kkt' || methodRaw === 'al' || methodRaw === 'al-gn' || methodRaw === 'augmentedlagrangian' || methodRaw === 'augmented-lagrangian')
    ? 'kkt'
    : (methodRaw === 'global-al' || methodRaw === 'global' || methodRaw === 'escape' || methodRaw === 'escapefunction')
    ? 'global-al'
    : methodRaw === 'global-lm'
    ? 'global-lm'
    : (methodRaw === 'cd' || methodRaw === 'coordinatedescent')
    ? 'cd'
    : 'lm';
  const activeRequirementRows = getActiveRequirementRowsForOptimizer(optsWithSpeedPreset);
  const coupledQconMultiStartDepth = Math.max(0, Math.floor(Number(optsWithSpeedPreset.__coupledQconMultiStartDepth) || 0));
  const numericRouteVars = activeCfgForRoute
    ? listDesignVariablesFromBlocks(activeCfgForRoute).filter(entry => Number.isFinite(Number(entry?.value)))
    : [];
  const qconRouteVars = numericRouteVars.filter(entry => {
    const block = Array.isArray(activeCfgForRoute?.blocks)
      ? activeCfgForRoute.blocks.find(candidate => String(candidate?.blockId ?? '') === String(entry?.blockId ?? ''))
      : null;
    return isQconCoefficientVariable(block, entry?.key);
  });
  const hasSpotAnnularAllRequirement = activeRequirementRows.some(row => {
    const enabled = row?.enabled === undefined || row?.enabled === null ? true : !!row.enabled;
    return enabled
      && Number(row?.weight ?? 1) > 0
      && String(row?.operand ?? '').trim().toUpperCase() === 'SPOT_SIZE_ANNULAR'
      && String(row?.fieldScope ?? '').trim().toUpperCase() === 'ALL';
  });
  const shouldRunCoupledQconMultiStart = requestedMethod === 'kkt-sqp'
    && coupledQconMultiStartDepth === 0
    && optsWithSpeedPreset.kktCoupledQconMultiStart === true
    && hasSpotAnnularAllRequirement
    && qconRouteVars.length > 1
    && qconRouteVars.length === numericRouteVars.length;

  if (shouldRunCoupledQconMultiStart) {
    const baselineSystemConfig = JSON.parse(JSON.stringify(systemConfigForRoute));
    const multiStartProgress = typeof optsWithSpeedPreset.onProgress === 'function'
      ? optsWithSpeedPreset.onProgress
      : null;
    const multiStartStartedAt = Date.now();
    const localIterations = Number.isFinite(Number(optsWithSpeedPreset.kktCoupledQconLocalIterations))
      ? Math.max(1, Math.floor(Number(optsWithSpeedPreset.kktCoupledQconLocalIterations)))
      : 2;
    let bestCandidateScore = Number.POSITIVE_INFINITY;
    let bestCandidateSystemConfig = baselineSystemConfig;
    const candidateDirections: number[][] = [[]];
    for (let mode = 0; mode < qconRouteVars.length; mode++) {
      const direction = qconRouteVars.map((_, order) => (
        Math.cos(Math.PI * (order + 0.5) * mode / qconRouteVars.length)
      ));
      const norm = Math.max(...direction.map(value => Math.abs(value)), 1e-12);
      candidateDirections.push(direction.map(value => value / norm));
      candidateDirections.push(direction.map(value => -value / norm));
    }

    for (let candidateIndex = 0; candidateIndex < candidateDirections.length; candidateIndex++) {
      const direction = candidateDirections[candidateIndex];
      if (__optimizerStopRequested) {
        saveSystemConfigurationsRaw(baselineSystemConfig);
        return { ok: true, aborted: true, reason: 'stopped-during-coupled-qcon-multi-start' };
      }
      if (multiStartProgress) {
        try {
          multiStartProgress({
            phase: 'initializing',
            method: requestedMethod,
            initialization: 'coupled-qcon-multi-start',
            candidate: candidateIndex + 1,
            candidates: candidateDirections.length,
            status: 'start',
            elapsedMs: Date.now() - multiStartStartedAt,
            best: bestCandidateScore,
          });
        } catch (_) {}
      }
      const candidateSystemConfig = JSON.parse(JSON.stringify(baselineSystemConfig));
      const candidateActiveConfig = getActiveConfigRef(candidateSystemConfig);
      if (direction.length === qconRouteVars.length) {
        for (let index = 0; index < qconRouteVars.length; index++) {
          const variable = qconRouteVars[index];
          const block = Array.isArray(candidateActiveConfig?.blocks)
            ? candidateActiveConfig.blocks.find(entry => String(entry?.blockId ?? '') === String(variable?.blockId ?? ''))
            : null;
          const amplitude = defaultScaleForBlockVariable(block, variable?.key);
          setDesignVariableValue(candidateActiveConfig, variable.id, Number(variable.value) + direction[index] * amplitude);
        }
      }
      saveSystemConfigurationsRaw(candidateSystemConfig);
      const candidateResult = await runOptimizationMVP({
        ...optsWithSpeedPreset,
        __coupledQconMultiStartDepth: coupledQconMultiStartDepth + 1,
        __disableKktNoImproveFallback: true,
        maxIterations: localIterations,
        kktInitProbe: false,
        onProgress: multiStartProgress
          ? (event) => {
              if (String(event?.phase ?? '').trim().toLowerCase() !== 'iter') return;
              try {
                multiStartProgress({
                  phase: 'initializing',
                  method: requestedMethod,
                  initialization: 'coupled-qcon-multi-start',
                  candidate: candidateIndex + 1,
                  candidates: candidateDirections.length,
                  status: 'progress',
                  localIteration: Math.max(1, Math.floor(Number(event?.iter) || 0) + 1),
                  localIterations,
                  elapsedMs: Date.now() - multiStartStartedAt,
                  best: bestCandidateScore,
                });
              } catch (_) {}
            }
          : undefined,
        onProgressKKT: undefined,
      });
      if (candidateResult?.aborted) {
        saveSystemConfigurationsRaw(baselineSystemConfig);
        return candidateResult;
      }
      const candidateScore = Number(candidateResult?.best ?? candidateResult?.objectiveScore);
      if (Number.isFinite(candidateScore) && candidateScore < bestCandidateScore) {
        bestCandidateScore = candidateScore;
        bestCandidateSystemConfig = JSON.parse(JSON.stringify(loadSystemConfigurationsRaw()));
      }
      if (multiStartProgress) {
        try {
          multiStartProgress({
            phase: 'initializing',
            method: requestedMethod,
            initialization: 'coupled-qcon-multi-start',
            candidate: candidateIndex + 1,
            candidates: candidateDirections.length,
            status: 'done',
            elapsedMs: Date.now() - multiStartStartedAt,
            best: bestCandidateScore,
          });
        } catch (_) {}
      }
    }

    saveSystemConfigurationsRaw(bestCandidateSystemConfig);
    return runOptimizationMVP({
      ...optsWithSpeedPreset,
      __coupledQconMultiStartDepth: coupledQconMultiStartDepth + 1,
    });
  }
  const unsupportedNativeOperands = findUnsupportedNativeRequirementOperands(
    activeRequirementRows
  );
  const hasHeavyAsyncRequirementOperands = hasAsyncPreferredRequirementOperands(activeRequirementRows);
  const effectiveMethod = requestedMethod;
  const effectiveOpts = optsWithSpeedPreset;
  const canAttemptNativeRoute = effectiveMethod !== 'kkt-sqp' && isTauriRuntime() && effectiveOpts.forceTs !== true;
  const shouldPreferNativeRoute = canAttemptNativeRoute && (
    effectiveOpts.forceNative === true
    || (
      unsupportedNativeOperands.length === 0
      && categoricalMaterialVarsForRoute.length === 0
      && effectiveOpts.preferNative === true
    )
  );

  if (isTauriRuntime() && effectiveOpts.forceTs !== true && unsupportedNativeOperands.length > 0) {
    try {
      console.warn('[OptimizerMVP] Falling back to TS optimizer because native optimizer does not support some active requirement operands.', {
        unsupportedOperands: unsupportedNativeOperands,
      });
    } catch (_) {}
  }

  if (isTauriRuntime() && effectiveOpts.forceTs !== true && categoricalMaterialVarsForRoute.length > 0) {
    try {
      console.warn('[OptimizerMVP] Falling back to TS optimizer because active design variables include categorical material(V) entries that native optimization does not optimize.', {
        categoricalMaterialVars: categoricalMaterialVarsForRoute.map((v: any) => String(v?.id ?? '')).filter(Boolean),
      });
    } catch (_) {}
  }

  // Native route is available on Tauri. `forceNative` keeps strict behavior for
  // benchmarking, while `preferNative` falls back to TS when native startup fails.
  if (shouldPreferNativeRoute) {
    const nativeResult = await runOptimizationMvpnative(effectiveOpts);
    if (effectiveOpts.forceNative === true || nativeResult?.ok !== false || nativeResult?.aborted) {
      return nativeResult;
    }
    try {
      console.warn('[OptimizerMVP] Native optimizer failed, falling back to TS optimizer.', {
        reason: nativeResult?.reason,
        nativeMessage: nativeResult?.nativeMessage,
      });
    } catch (_) {}
  }

  // Lightweight profiler to quickly identify bottlenecks.
  // Disabled by default; enable via { profile:true }.
  const __profileEnabled = (effectiveOpts.profile === undefined) ? false : !!effectiveOpts.profile;
  const __profile = __profileEnabled ? {
    t0: nowMs(),
    startedAt: Date.now(),
    totalMs: 0,
    timingBuckets: {
      time_objective_eval: 0,
      time_wasm_call: 0,
      time_js_overhead: 0
    },
    sectionsMs: /** @type {Record<string, number>} */ ({}),
    operandMs: /** @type {Record<string, { ms:number, calls:number }>} */ ({}),
    operandCfgMs: /** @type {Record<string, { ms:number, calls:number }>} */ ({}),
    lastSeenOperandCfg: /** @type {Record<string, any>} */ ({}),
    counts: {
      calculateOperandValueCalls: 0,
      calculateOperandValueMs: 0,
      operandValueCacheHits: 0,
      operandValueCacheMisses: 0,
      meritRuntimeCacheEnabled: 0,
      wasmLinearSolveCalls: 0,
      wasmLinearSolveHits: 0,
      wasmLinearSolveFallbacks: 0,
      wasmNormalEqCalls: 0,
      wasmNormalEqHits: 0,
      wasmNormalEqFallbacks: 0,
      kktFiniteDiffJacobianCalls: 0,
      kktFiniteDiffJacobianMs: 0,
      kktFiniteDiffColumns: 0,
      kktFiniteDiffColumnsRaw: 0,
      kktFiniteDiffColumnsEffective: 0,
      kktFiniteDiffGroups: 0,
      kktAnalyticConstraintRows: 0,
      kktAnalyticEqualityCandidateRows: 0,
      kktAnalyticEqualityRows: 0,
      kktAnalyticEqualityCalibratedRows: 0,
      kktFiniteDiffResidualEvals: 0,
      kktNativeBatchFdCalls: 0,
      kktNativeBatchFdHits: 0,
      kktNativeBatchFdFallbacks: 0,
      kktNativeBatchFdCandidates: 0,
      kktNativeBatchFdDeltaUpdates: 0,
      kktNativeBatchFdSessionReuses: 0,
      kktNativeBatchFdMs: 0,
      kktJacobianFullCalls: 0,
      kktJacobianPartialCalls: 0,
      kktJacobianReuseCalls: 0,
      kktIterCount: 0,
      kktIterMs: 0,
      evalResidualsNowCalls: 0,
      evalResidualsNowMs: 0,
      evalCompositeCalls: 0,
      evalCompositeMs: 0,
      onProgressCalls: 0,
      onProgressMs: 0,
      nextFrameCalls: 0,
      nextFrameMs: 0,
      timeObjectiveEvalCalls: 0,
      timeWasmCallCalls: 0,
      timeJsOverheadCalls: 0,
      kktWasmPilotCalls: 0,
      kktWasmPilotHits: 0,
      kktWasmPilotFallbacks: 0,
      kktWasmPilotLastReason: 'not-run',
      kktWasmBufferCalls: 0,
      kktWasmBufferHits: 0,
      kktWasmBufferFallbacks: 0,
      kktWasmBufferStatusHistogram: {},
      kktMatrixFreeCalls: 0,
      kktMatrixFreeHits: 0,
      kktMatrixFreeFallbacks: 0,
      kktMatrixFreeCgIters: 0,
      kktMatrixFreeSolverIters: 0,
      kktMatrixFreeResidualNorm: Number.NaN,
      kktMatrixFreeMs: 0,
      kktMatrixFreeLastFallbackReason: 'none',
      kktMatrixFreeFallbackReasons: {}
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

  const __profileBucketWrap = (bucket, fn) => {
    if (!__profile) return fn();
    const t = nowMs();
    try {
      return fn();
    } finally {
      const dt = Math.max(0, nowMs() - t);
      if (!Number.isFinite(dt)) return;
      const buckets = __profile.timingBuckets || (__profile.timingBuckets = {
        time_objective_eval: 0,
        time_wasm_call: 0,
        time_js_overhead: 0
      });
      if (bucket === 'time_objective_eval') {
        buckets.time_objective_eval = (Number(buckets.time_objective_eval) || 0) + dt;
        __profile.counts.timeObjectiveEvalCalls = (Number(__profile.counts.timeObjectiveEvalCalls) || 0) + 1;
      } else if (bucket === 'time_wasm_call') {
        buckets.time_wasm_call = (Number(buckets.time_wasm_call) || 0) + dt;
        __profile.counts.timeWasmCallCalls = (Number(__profile.counts.timeWasmCallCalls) || 0) + 1;
      } else if (bucket === 'time_js_overhead') {
        buckets.time_js_overhead = (Number(buckets.time_js_overhead) || 0) + dt;
        __profile.counts.timeJsOverheadCalls = (Number(__profile.counts.timeJsOverheadCalls) || 0) + 1;
      }
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
        __profile.operandValueCacheHits = Number(__profile.counts.operandValueCacheHits) || 0;
        __profile.operandValueCacheMisses = Number(__profile.counts.operandValueCacheMisses) || 0;
        __profile.operandValueCacheHitRate = (
          (__profile.operandValueCacheHits + __profile.operandValueCacheMisses) > 0
            ? (__profile.operandValueCacheHits / (__profile.operandValueCacheHits + __profile.operandValueCacheMisses))
            : 0
        );
        __profile.meritRuntimeCacheEnabled = Number(__profile.counts.meritRuntimeCacheEnabled) || 0;
        __profile.wasmLinearSolveCalls = Number(__profile.counts.wasmLinearSolveCalls) || 0;
        __profile.wasmLinearSolveHits = Number(__profile.counts.wasmLinearSolveHits) || 0;
        __profile.wasmLinearSolveFallbacks = Number(__profile.counts.wasmLinearSolveFallbacks) || 0;
        __profile.wasmNormalEqCalls = Number(__profile.counts.wasmNormalEqCalls) || 0;
        __profile.wasmNormalEqHits = Number(__profile.counts.wasmNormalEqHits) || 0;
        __profile.wasmNormalEqFallbacks = Number(__profile.counts.wasmNormalEqFallbacks) || 0;
        __profile.kktFiniteDiffJacobianCalls = Number(__profile.counts.kktFiniteDiffJacobianCalls) || 0;
        __profile.kktFiniteDiffJacobianMs = Number(__profile.counts.kktFiniteDiffJacobianMs) || 0;
        __profile.kktFiniteDiffColumns = Number(__profile.counts.kktFiniteDiffColumns) || 0;
        __profile.kktFiniteDiffColumnsRaw = Number(__profile.counts.kktFiniteDiffColumnsRaw) || 0;
        __profile.kktFiniteDiffColumnsEffective = Number(__profile.counts.kktFiniteDiffColumnsEffective) || 0;
        __profile.kktFiniteDiffGroups = Number(__profile.counts.kktFiniteDiffGroups) || 0;
        __profile.kktAnalyticConstraintRows = Number(__profile.counts.kktAnalyticConstraintRows) || 0;
        __profile.kktAnalyticEqualityCandidateRows = Number(__profile.counts.kktAnalyticEqualityCandidateRows) || 0;
        __profile.kktAnalyticEqualityRows = Number(__profile.counts.kktAnalyticEqualityRows) || 0;
        __profile.kktAnalyticEqualityCalibratedRows = Number(__profile.counts.kktAnalyticEqualityCalibratedRows) || 0;
        __profile.kktFiniteDiffResidualEvals = Number(__profile.counts.kktFiniteDiffResidualEvals) || 0;
        __profile.kktNativeBatchFdCalls = Number(__profile.counts.kktNativeBatchFdCalls) || 0;
        __profile.kktNativeBatchFdHits = Number(__profile.counts.kktNativeBatchFdHits) || 0;
        __profile.kktNativeBatchFdFallbacks = Number(__profile.counts.kktNativeBatchFdFallbacks) || 0;
        __profile.kktNativeBatchFdCandidates = Number(__profile.counts.kktNativeBatchFdCandidates) || 0;
        __profile.kktNativeBatchFdDeltaUpdates = Number(__profile.counts.kktNativeBatchFdDeltaUpdates) || 0;
        __profile.kktNativeBatchFdSessionReuses = Number(__profile.counts.kktNativeBatchFdSessionReuses) || 0;
        __profile.kktNativeBatchFdMs = Number(__profile.counts.kktNativeBatchFdMs) || 0;
        __profile.kktJacobianFullCalls = Number(__profile.counts.kktJacobianFullCalls) || 0;
        __profile.kktJacobianPartialCalls = Number(__profile.counts.kktJacobianPartialCalls) || 0;
        __profile.kktJacobianReuseCalls = Number(__profile.counts.kktJacobianReuseCalls) || 0;
        __profile.kktIterCount = Number(__profile.counts.kktIterCount) || 0;
        __profile.kktIterMs = Number(__profile.counts.kktIterMs) || 0;
        __profile.wasmBridgeDebug = getOptimizerWasmBridgeDebugInfo();
        __profile.evalResidualsNowCalls = Number(__profile.counts.evalResidualsNowCalls) || 0;
        __profile.evalResidualsNowMs = Number(__profile.counts.evalResidualsNowMs) || 0;
        __profile.evalCompositeCalls = Number(__profile.counts.evalCompositeCalls) || 0;
        __profile.evalCompositeMs = Number(__profile.counts.evalCompositeMs) || 0;
        __profile.onProgressCalls = Number(__profile.counts.onProgressCalls) || 0;
        __profile.onProgressMs = Number(__profile.counts.onProgressMs) || 0;
        __profile.nextFrameCalls = Number(__profile.counts.nextFrameCalls) || 0;
        __profile.nextFrameMs = Number(__profile.counts.nextFrameMs) || 0;
        __profile.time_objective_eval = Number(__profile.timingBuckets?.time_objective_eval) || 0;
        __profile.time_wasm_call = Number(__profile.timingBuckets?.time_wasm_call) || 0;
        const measuredJsOverhead = Number(__profile.timingBuckets?.time_js_overhead) || 0;
        const inferredJsOverhead = Math.max(0, (Number(__profile.totalMs) || 0) - __profile.time_objective_eval - __profile.time_wasm_call);
        __profile.time_js_overhead = Math.max(measuredJsOverhead, inferredJsOverhead);
        __profile.kktWasmPilotCalls = Number(__profile.counts.kktWasmPilotCalls) || 0;
        __profile.kktWasmPilotHits = Number(__profile.counts.kktWasmPilotHits) || 0;
        __profile.kktWasmPilotFallbacks = Number(__profile.counts.kktWasmPilotFallbacks) || 0;
        __profile.kktWasmPilotLastReason = String(__profile.counts.kktWasmPilotLastReason || 'not-run');
        __profile.kktWasmBufferCalls = Number(__profile.counts.kktWasmBufferCalls) || 0;
        __profile.kktWasmBufferHits = Number(__profile.counts.kktWasmBufferHits) || 0;
        __profile.kktWasmBufferFallbacks = Number(__profile.counts.kktWasmBufferFallbacks) || 0;
        __profile.kktWasmBufferStatusHistogram = (__profile.counts.kktWasmBufferStatusHistogram && typeof __profile.counts.kktWasmBufferStatusHistogram === 'object')
          ? { ...__profile.counts.kktWasmBufferStatusHistogram }
          : {};
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
      addRow('time_objective_eval', __profile.time_objective_eval, __profile.counts.timeObjectiveEvalCalls);
      addRow('time_wasm_call', __profile.time_wasm_call, __profile.counts.timeWasmCallCalls);
      addRow('time_js_overhead', __profile.time_js_overhead, __profile.counts.timeJsOverheadCalls);
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

      try {
        const analyticCandidates = pickAnalyticDerivativeCandidates(__profile, { limit: 3, minCalls: 5, minMs: 1, hotPct: 2 });
        __profile.analyticDerivativeCandidates = analyticCandidates;
        const topCandidates = Array.isArray(analyticCandidates?.candidates) ? analyticCandidates.candidates : [];
        if (topCandidates.length > 0) {
          console.log('[OptimizerMVP] analytic-derivative candidates (top)', topCandidates.map((c) => ({
            operand: c.operand,
            ms: Math.round(Number(c.ms) || 0),
            calls: Number(c.calls) || 0,
            msPerCall: Math.round((Number(c.msPerCall) || 0) * 1000) / 1000,
            pctOperand: Math.round((Number(c.pctOperand) || 0) * 10) / 10,
            dominantCfgKey: c.dominantCfgKey
          })));
        }
      } catch (_) {}

      try {
        const cacheHits = Number(__profile.counts.operandValueCacheHits) || 0;
        const cacheMisses = Number(__profile.counts.operandValueCacheMisses) || 0;
        const cacheTotal = cacheHits + cacheMisses;
        const hitRate = cacheTotal > 0 ? (100 * cacheHits / cacheTotal) : 0;
        const objectiveMs = Number(__profile.time_objective_eval) || 0;
        const wasmMs = Number(__profile.time_wasm_call) || 0;
        const jsMs = Number(__profile.time_js_overhead) || 0;
        const totalMeasured = Math.max(1e-9, objectiveMs + wasmMs + jsMs);
        const pilotCalls = Number(__profile.counts.kktWasmPilotCalls) || 0;
        const pilotHits = Number(__profile.counts.kktWasmPilotHits) || 0;
        const pilotFallbacks = Number(__profile.counts.kktWasmPilotFallbacks) || 0;
        const pilotLastReason = String(__profile.counts.kktWasmPilotLastReason || 'not-run');
        const pilotHitRatePct = pilotCalls > 0 ? (100 * pilotHits / pilotCalls) : 0;
        const bufferCalls = Number(__profile.counts.kktWasmBufferCalls) || 0;
        const bufferHits = Number(__profile.counts.kktWasmBufferHits) || 0;
        const bufferFallbacks = Number(__profile.counts.kktWasmBufferFallbacks) || 0;
        const bufferHitRatePct = bufferCalls > 0 ? (100 * bufferHits / bufferCalls) : 0;
        const bufferStatusHistogram = (__profile.counts.kktWasmBufferStatusHistogram && typeof __profile.counts.kktWasmBufferStatusHistogram === 'object')
          ? { ...__profile.counts.kktWasmBufferStatusHistogram }
          : {};
        console.log('[OptimizerMVP] cache stats', {
          operandValueCacheHits: cacheHits,
          operandValueCacheMisses: cacheMisses,
          operandValueCacheHitRatePct: Math.round(hitRate * 10) / 10,
          meritRuntimeCacheEnabled: Number(__profile.counts.meritRuntimeCacheEnabled) || 0,
          wasmLinearSolveCalls: Number(__profile.counts.wasmLinearSolveCalls) || 0,
          wasmLinearSolveHits: Number(__profile.counts.wasmLinearSolveHits) || 0,
          wasmLinearSolveFallbacks: Number(__profile.counts.wasmLinearSolveFallbacks) || 0,
          wasmNormalEqCalls: Number(__profile.counts.wasmNormalEqCalls) || 0,
          wasmNormalEqHits: Number(__profile.counts.wasmNormalEqHits) || 0,
          wasmNormalEqFallbacks: Number(__profile.counts.wasmNormalEqFallbacks) || 0,
          kktFiniteDiffJacobianCalls: Number(__profile.counts.kktFiniteDiffJacobianCalls) || 0,
          kktFiniteDiffJacobianMs: Number(__profile.counts.kktFiniteDiffJacobianMs) || 0,
          kktFiniteDiffColumns: Number(__profile.counts.kktFiniteDiffColumns) || 0,
          kktFiniteDiffColumnsRaw: Number(__profile.counts.kktFiniteDiffColumnsRaw) || 0,
          kktFiniteDiffColumnsEffective: Number(__profile.counts.kktFiniteDiffColumnsEffective) || 0,
          kktFiniteDiffGroups: Number(__profile.counts.kktFiniteDiffGroups) || 0,
          kktAnalyticConstraintRows: Number(__profile.counts.kktAnalyticConstraintRows) || 0,
          kktAnalyticEqualityCandidateRows: Number(__profile.counts.kktAnalyticEqualityCandidateRows) || 0,
          kktAnalyticEqualityRows: Number(__profile.counts.kktAnalyticEqualityRows) || 0,
          kktAnalyticEqualityCalibratedRows: Number(__profile.counts.kktAnalyticEqualityCalibratedRows) || 0,
          kktFiniteDiffResidualEvals: Number(__profile.counts.kktFiniteDiffResidualEvals) || 0,
          kktJacobianFullCalls: Number(__profile.counts.kktJacobianFullCalls) || 0,
          kktJacobianPartialCalls: Number(__profile.counts.kktJacobianPartialCalls) || 0,
          kktJacobianReuseCalls: Number(__profile.counts.kktJacobianReuseCalls) || 0,
          kktIterCount: Number(__profile.counts.kktIterCount) || 0,
          kktIterMs: Number(__profile.counts.kktIterMs) || 0,
          kktIterAvgMs: (() => {
            const c = Number(__profile.counts.kktIterCount) || 0;
            const ms = Number(__profile.counts.kktIterMs) || 0;
            return c > 0 ? ms / c : 0;
          })(),
          time_objective_eval: objectiveMs,
          time_wasm_call: wasmMs,
          time_js_overhead: jsMs,
          kktWasmPilotCalls: pilotCalls,
          kktWasmPilotHits: pilotHits,
          kktWasmPilotFallbacks: pilotFallbacks,
          kktWasmPilotLastReason: pilotLastReason,
          kktWasmBufferCalls: bufferCalls,
          kktWasmBufferHits: bufferHits,
          kktWasmBufferFallbacks: bufferFallbacks,
          kktWasmBufferHitRatePct: Math.round(bufferHitRatePct * 10) / 10,
          kktWasmBufferStatusHistogram: bufferStatusHistogram,
          kktMatrixFreeCalls: Number(__profile.counts.kktMatrixFreeCalls) || 0,
          kktMatrixFreeHits: Number(__profile.counts.kktMatrixFreeHits) || 0,
          kktMatrixFreeFallbacks: Number(__profile.counts.kktMatrixFreeFallbacks) || 0,
          kktMatrixFreeCgIters: Number(__profile.counts.kktMatrixFreeCgIters) || 0,
          kktMatrixFreeSolverIters: Number(__profile.counts.kktMatrixFreeSolverIters) || 0,
          kktMatrixFreeResidualNorm: Number(__profile.counts.kktMatrixFreeResidualNorm),
          kktMatrixFreeMs: Number(__profile.counts.kktMatrixFreeMs) || 0,
          kktMatrixFreeLastFallbackReason: String(__profile.counts.kktMatrixFreeLastFallbackReason || 'none'),
          kktMatrixFreeFallbackReasons: (__profile.counts.kktMatrixFreeFallbackReasons && typeof __profile.counts.kktMatrixFreeFallbackReasons === 'object')
            ? { ...__profile.counts.kktMatrixFreeFallbackReasons }
            : {}
        });

        console.log('[OptimizerMVP] timing comparison', {
          objectivePctOfMeasured: Math.round((objectiveMs / totalMeasured) * 1000) / 10,
          wasmPctOfMeasured: Math.round((wasmMs / totalMeasured) * 1000) / 10,
          jsOverheadPctOfMeasured: Math.round((jsMs / totalMeasured) * 1000) / 10,
          wasmToObjectiveRatio: objectiveMs > 0 ? Math.round((wasmMs / objectiveMs) * 1000) / 1000 : null,
          objectiveToWasmRatio: wasmMs > 0 ? Math.round((objectiveMs / wasmMs) * 1000) / 1000 : null,
          kktWasmPilotEnabled: kktUseWasmPilotOptimizer,
          kktMatrixFreeEnabled: kktUseMatrixFreeCore,
          kktWasmPilotHitRatePct: Math.round(pilotHitRatePct * 10) / 10,
          kktWasmPilotLastReason: pilotLastReason,
          kktWasmBufferHitRatePct: Math.round(bufferHitRatePct * 10) / 10
        });
      } catch (_) {}
      console.groupEnd();
    } catch (_) {}
  };

  // Reset global stop flags at the start of each run.
  __optimizerStopRequested = false;
  try {
    if (typeof globalThis !== 'undefined') {
      globalThis.__stopOptimization = false;
    }
  } catch (_) {}
  
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
  
  const runUntilStopped = !!effectiveOpts.runUntilStopped;
  const method = effectiveMethod;
  // 【修正】KKT法はLM法より収束が遅いため、デフォルトを100→500に増加
  const defaultMaxIter = (method === 'kkt' || method === 'kkt-sqp') ? 500 : 100;
  const maxIterations = runUntilStopped
    ? Number.MAX_SAFE_INTEGER
    : (Number.isFinite(Number(effectiveOpts.maxIterations)) ? Math.max(1, Math.floor(Number(effectiveOpts.maxIterations))) : defaultMaxIter);
  const stepFraction = Number.isFinite(Number(effectiveOpts.stepFraction)) ? Math.max(1e-6, Number(effectiveOpts.stepFraction)) : 0.02;
  const minStep = Number.isFinite(Number(effectiveOpts.minStep)) ? Math.max(1e-12, Number(effectiveOpts.minStep)) : 1e-6;
  const stepDecay = Number.isFinite(Number(effectiveOpts.stepDecay)) ? Math.min(0.95, Math.max(0.1, Number(effectiveOpts.stepDecay))) : 0.5;
  const stallLimit = runUntilStopped
    ? Number.MAX_SAFE_INTEGER
    : (Number.isFinite(Number(effectiveOpts.stallLimit)) ? Math.max(1, Math.floor(Number(effectiveOpts.stallLimit))) : 5);
  const logEvery = Number.isFinite(Number(effectiveOpts.logEvery)) ? Math.max(1, Math.floor(Number(effectiveOpts.logEvery))) : 1;

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
  const qconFdStepAbs = Number.isFinite(Number(opts.qconFdStepAbs)) ? Math.max(1e-12, Number(opts.qconFdStepAbs)) : null;
  const qconFdStepRel = Number.isFinite(Number(opts.qconFdStepRel)) ? Math.max(0, Number(opts.qconFdStepRel)) : null;
  const qconInitialStepScale = Number.isFinite(Number(opts.qconInitialStepScale))
    ? Math.max(1e-12, Number(opts.qconInitialStepScale))
    : null;

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
  // Default OFF so LM can optimize all enabled coefficients immediately unless the user
  // explicitly opts into staged continuation.
  const staged = (opts.staged === undefined) ? false : !!opts.staged;
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
  const lineSearchC = Number.isFinite(Number(opts.lineSearchC)) ? Math.max(1e-8, Number(opts.lineSearchC)) : 1e-4;
  const lineSearchRho = Number.isFinite(Number(opts.lineSearchRho)) ? Math.min(0.95, Math.max(1e-3, Number(opts.lineSearchRho))) : 0.5;
  const lineSearchMaxBacktrack = Number.isFinite(Number(opts.lineSearchMaxBacktrack)) ? Math.max(1, Math.floor(Number(opts.lineSearchMaxBacktrack))) : 20;
  const lmGeodesicAcceleration = (opts.lmGeodesicAcceleration === undefined) ? true : !!opts.lmGeodesicAcceleration;
  const lmGeodesicAsphereOnly = (opts.lmGeodesicAsphereOnly === undefined) ? true : !!opts.lmGeodesicAsphereOnly;
  const lmGeodesicProbeAlpha = Number.isFinite(Number(opts.lmGeodesicProbeAlpha))
    ? Math.max(1e-3, Math.min(0.5, Number(opts.lmGeodesicProbeAlpha)))
    : 0.1;
  const lmGeodesicAccelLimit = Number.isFinite(Number(opts.lmGeodesicAccelLimit))
    ? Math.max(0.05, Math.min(2.0, Number(opts.lmGeodesicAccelLimit)))
    : 0.75;
  // If the LM step becomes (near-)zero (common when residuals are flat / discontinuous),
  // rho tends to 0 and we can get stuck rejecting forever. Allow a tiny random exploration
  // step inside the same trust-region envelope to break out.
  // Default OFF: user requested no perturbation after rho=0.
  const lmExploreWhenFlat = (opts.lmExploreWhenFlat === undefined) ? false : !!opts.lmExploreWhenFlat;
  const lmExploreTries = Number.isFinite(Number(opts.lmExploreTries)) ? Math.max(1, Math.floor(Number(opts.lmExploreTries))) : 3;
  const useWasmLinearSolve = true;
  // Default to Rust/WASM kernels for TS KKT runs. Every call site still keeps
  // the existing fallback path, so explicit `false` remains the escape hatch.
  const kktUseMatrixFreeCore = opts?.kktUseMatrixFreeCore !== false;
  const kktMatrixFreePriority = opts?.kktMatrixFreePriority === true;
  const phaseCDebug = opts?.phaseCDebug === true;
  let kktWasmPilotFallbackLogged = false;

  if (useWasmLinearSolve) {
    try {
      await preloadOptimizerWasmBridge();
    } catch (_) {}
  }

  if (method === 'kkt' || method === 'kkt-sqp') {
    try {
      const wasmDbg = getOptimizerWasmBridgeDebugInfo();
      console.log('[WASM-PILOT] Route configured', {
        runtime: isTauriRuntime() ? 'tauri' : 'web',
        enabled: kktUseWasmPilotOptimizer,
        explicitOverride: opts?.kktUseWasmPilotOptimizer !== undefined,
        wasmBridgeReady: wasmDbg?.ready === true,
        hasPilotBufferAbi: wasmDbg?.hasPilotBufferAbi === true,
        hasBuildNormalEq: wasmDbg?.hasBuildNormalEq === true,
        initSource: wasmDbg?.initSource || 'unknown',
        initError: wasmDbg?.initError || null,
      });
    } catch (_) {}
  }

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
  let __stopReasonLogged = false;

  // Fast path for expensive operands (notably Spot RMS/diameter).
  // Optimizer can tolerate approximate evaluation to gain speed.
  // You can disable by passing { spotFastMode: false }.
  const spotFastMode = (opts.spotFastMode === undefined) ? true : !!opts.spotFastMode;
  const spotAnnularRingCountFast = Number.isFinite(Number(opts.spotAnnularRingCountFast))
    ? Math.max(1, Math.min(50, Math.floor(Number(opts.spotAnnularRingCountFast))))
    : 10;
  const spotRayCountFast = Number.isFinite(Number(opts.spotRayCountFast))
    ? Math.max(5, Math.min(1024 * 1024, Math.floor(Number(opts.spotRayCountFast))))
    : 1 + 8 * spotAnnularRingCountFast;
  const mtfSamplingSizeFast = Number.isFinite(Number(opts.mtfSamplingSizeFast))
    ? Math.max(16, Math.min(4096, Math.floor(Number(opts.mtfSamplingSizeFast))))
    : 32;
  const spotSamplingPlan = createAdaptiveSpotSamplingPlan(
    spotRayCountFast,
    maxIterations,
    opts.adaptiveSpotSampling === true,
    opts.adaptiveSpotFinalFraction,
  );
  const kktStrictRayGridSize = Number.isFinite(Number(opts?.kktStrictRayGridSize))
    ? Math.max(8, Math.floor(Number(opts.kktStrictRayGridSize)))
    : loadOptimizeRayGridSize();
  const kktStrictSpotRayCount = Number.isFinite(Number(opts?.kktStrictSpotRayCount))
    ? Math.max(5, Math.floor(Number(opts.kktStrictSpotRayCount)))
    : optimizeRayCountFromGridSize(kktStrictRayGridSize);
  const kktStrictMtfSamplingSize = Number.isFinite(Number(opts?.kktStrictMtfSamplingSize))
    ? Math.max(16, Math.floor(Number(opts.kktStrictMtfSamplingSize)))
    : Math.max(16, kktStrictRayGridSize);
  const kktStrictRefineAcceptedCandidates = opts?.kktStrictRefineAcceptedCandidates !== false;
  const kktPeriodicFullSweepEvery = Number.isFinite(Number(opts?.kktPeriodicFullSweepEvery))
    ? Math.max(1, Math.floor(Number(opts.kktPeriodicFullSweepEvery)))
    : 4;
  let activeSpotRayCount = adaptiveSpotRayCountAtIteration(spotSamplingPlan, 0);
  const activeSpotAnnularRingCount = () => spotAnnularRingCountFast;
  const shouldStop = (context: string = '') => {
    const internalStop = !!__optimizerStopRequested;
    const legacyStop = (() => {
      try { return !!(typeof globalThis !== 'undefined' && globalThis.__stopOptimization); } catch (_) { return false; }
    })();

    let userStop = false;
    let userStopError: any = null;
    try {
      userStop = userShouldStop ? !!userShouldStop() : false;
    } catch (e) {
      userStopError = e;
      userStop = false;
    }

    const stop = internalStop || userStop;
    if (stop && !__stopReasonLogged) {
      __stopReasonLogged = true;
      try {
        const uiStopReason = (() => {
          try {
            return (typeof globalThis !== 'undefined') ? ((globalThis as any).__cooptLastUiStopReason ?? null) : null;
          } catch (_) {
            return null;
          }
        })();
        console.warn('🛑 [OptimizerMVP] Stop requested', {
          context: context || 'generic',
          internalStop,
          userStop,
          legacyStop,
          uiStopReason,
          userStopError: userStopError ? String(userStopError) : null
        });
      } catch (_) {}
    }
    return stop;
  };

  const getMeritEditorHosts = (): any[] => {
    const hosts: any[] = [];
    const pushHost = (h: any) => {
      if (!h || typeof h !== 'object') return;
      if (hosts.includes(h)) return;
      hosts.push(h);
    };
    try {
      const w = (typeof window !== 'undefined') ? (window as any) : null;
      pushHost(w);
      try {
        const op = w?.opener;
        if (op && !op.closed) pushHost(op);
      } catch (_) {}
    } catch (_) {}
    return hosts;
  };

  const waitForMeritEditorReady = async (): Promise<any | null> => {
    const start = Date.now();
    const maxWaitMs = Number.isFinite(Number(opts?.meritEditorWaitMs))
      ? Math.max(0, Math.min(10000, Number(opts.meritEditorWaitMs)))
      : 2500;
    const intervalMs = 50;
    while (Date.now() - start <= maxWaitMs) {
      const hosts = getMeritEditorHosts();
      for (const h of hosts) {
        try {
          if (typeof h.__cooptInitMeritFunctionEditor === 'function') {
            h.__cooptInitMeritFunctionEditor();
          }
        } catch (_) {}
        try {
          const ed = h.meritFunctionEditor;
          if (ed && typeof ed.calculateOperandValue === 'function') {
            return ed;
          }
        } catch (_) {}
      }
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

  const fatalExpandMessages = formatFatalExpandIssues(targetConfigs);
  if (fatalExpandMessages.length > 0) {
    try {
      if (__prevCalcOperandValue) editor.calculateOperandValue = __prevCalcOperandValue;
    } catch (_) {}
    const res = {
      ok: false,
      reason: `Optimize aborted because Design Intent blocks are not expandable: ${fatalExpandMessages.join(' || ')}`
    };
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
  let __prevDisablePersistedTableFallback;
  let __prevTaEvalRunId;
  let __persistedOptimizerResultForUi = false;
  try { __prevBlocksOverride = (typeof window !== 'undefined') ? window.__cooptBlocksOverride : undefined; } catch (_) { __prevBlocksOverride = undefined; }
  try { __prevOpticalRowsOverride = (typeof globalThis !== 'undefined') ? globalThis.__cooptOpticalSystemRowsOverride : undefined; } catch (_) { __prevOpticalRowsOverride = undefined; }
  try { __prevScenarioOverride = (typeof window !== 'undefined') ? window.__cooptScenarioOverride : undefined; } catch (_) { __prevScenarioOverride = undefined; }
  try { __prevMeritFastMode = (typeof globalThis !== 'undefined') ? globalThis.__cooptMeritFastMode : undefined; } catch (_) { __prevMeritFastMode = undefined; }
  try { __prevOptimizerProfileContext = (typeof globalThis !== 'undefined') ? globalThis.__cooptOptimizerProfileContext : undefined; } catch (_) { __prevOptimizerProfileContext = undefined; }
  try { __prevDisableRayTraceDebug = (typeof globalThis !== 'undefined') ? globalThis.__COOPT_DISABLE_RAYTRACE_DEBUG : undefined; } catch (_) { __prevDisableRayTraceDebug = undefined; }
  try { __prevDisablePersistedTableFallback = (typeof globalThis !== 'undefined') ? (globalThis as any).__cooptDisablePersistedTableFallback : undefined; } catch (_) { __prevDisablePersistedTableFallback = undefined; }
  try { __prevTaEvalRunId = (typeof globalThis !== 'undefined') ? (globalThis as any).__cooptTaEvalRunId : undefined; } catch (_) { __prevTaEvalRunId = undefined; }

  const restorePreOptimizationGlobalsForUiSync = () => {
    try {
      setBlocksOverrideGlobal(__persistedOptimizerResultForUi ? undefined : __prevBlocksOverride);
    } catch (_) {}
    try {
      if (typeof window !== 'undefined') {
        try { delete (window as any).__cooptOpticalSystemByConfigId; } catch (_) {}
        try { delete (window as any).__cooptSystemConfig; } catch (_) {}
      }
    } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined') {
        if (__persistedOptimizerResultForUi) {
          try { delete globalThis.__cooptOpticalSystemRowsOverride; } catch (_) {
            globalThis.__cooptOpticalSystemRowsOverride = null;
          }
        } else {
          globalThis.__cooptOpticalSystemRowsOverride = __prevOpticalRowsOverride;
        }
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
    try {
      if (__prevCalcOperandValue && editor && typeof editor.calculateOperandValue === 'function') {
        editor.calculateOperandValue = __prevCalcOperandValue;
      }
    } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined') {
        if (__prevOptimizerProfileContext !== undefined) globalThis.__cooptOptimizerProfileContext = __prevOptimizerProfileContext;
        else {
          try { delete globalThis.__cooptOptimizerProfileContext; } catch (_) {}
        }
      }
    } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined') {
        if (__prevDisablePersistedTableFallback !== undefined) (globalThis as any).__cooptDisablePersistedTableFallback = __prevDisablePersistedTableFallback;
        else {
          try { delete (globalThis as any).__cooptDisablePersistedTableFallback; } catch (_) {}
        }

        if (__prevTaEvalRunId !== undefined) (globalThis as any).__cooptTaEvalRunId = __prevTaEvalRunId;
        else {
          try { delete (globalThis as any).__cooptTaEvalRunId; } catch (_) {}
        }

        try { delete (globalThis as any).__cooptEvalXKey; } catch (_) {}
        try { delete (globalThis as any).__cooptEvalXKeyApproxTa; } catch (_) {}
      }
    } catch (_) {}
  };

  const publishLatestSystemConfigForUiSync = () => {
    try {
      if (typeof window === 'undefined' || !systemConfig || typeof systemConfig !== 'object') return;
      const cloned = JSON.parse(JSON.stringify(systemConfig));
      window.__cooptSystemConfig = cloned;
      window.__cooptPreferRuntimeSystemConfig = true;
      window.__cooptDeferDerivedUiUntil = Date.now() + 1500;
    } catch (_) {}
  };

  const recalculateMeritIfSurfaceRangesValid = () => {
    try {
      if (!window.meritFunctionEditor || typeof window.meritFunctionEditor.calculateMerit !== 'function') {
        return;
      }

      const meritRows = (typeof window.meritFunctionEditor.getData === 'function')
        ? window.meritFunctionEditor.getData()
        : [];
      if (!Array.isArray(meritRows) || meritRows.length === 0) {
        window.meritFunctionEditor.calculateMerit();
        return;
      }

      const opticalRows = (() => {
        try {
          if (window.tableOpticalSystem && typeof window.tableOpticalSystem.getData === 'function') {
            const rows = window.tableOpticalSystem.getData();
            return Array.isArray(rows) ? rows : [];
          }
        } catch (_) {}
        return [];
      })();

      const validSurfaceIds = new Set<number>();
      for (const row of opticalRows) {
        const objectType = String((row as any)?.['object type'] ?? '').trim().toLowerCase();
        if (objectType === 'object' || objectType === 'image') continue;
        const surfaceId = Number((row as any)?.id);
        if (Number.isFinite(surfaceId)) validSurfaceIds.add(surfaceId);
      }

      const invalidEfflOperand = meritRows.find((operand: any) => {
        if (String(operand?.operand ?? '').trim().toUpperCase() !== 'EFFL') return false;
        const startSurf = Number.parseInt(String(operand?.param2 ?? '').trim(), 10);
        const endSurf = Number.parseInt(String(operand?.param3 ?? '').trim(), 10);
        if (!Number.isFinite(startSurf) || !Number.isFinite(endSurf)) return false;
        for (let surfaceId = startSurf; surfaceId <= endSurf; surfaceId += 1) {
          if (validSurfaceIds.has(surfaceId)) return false;
        }
        return true;
      });

      if (invalidEfflOperand) {
        console.warn('⚠️ [OptimizerMVP] Skipping final merit recalculation because the active merit table references non-existent EFFL surfaces after restore:', {
          operandId: invalidEfflOperand.id,
          range: `${invalidEfflOperand.param2}-${invalidEfflOperand.param3}`,
          availableSurfaces: Array.from(validSurfaceIds).sort((a, b) => a - b)
        });
        return;
      }

      window.meritFunctionEditor.calculateMerit();
    } catch (_) {}
  };

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
        spotRayCount: activeSpotRayCount,
        spotAnnularRingCount: activeSpotAnnularRingCount(),
        mtfSamplingSize: mtfSamplingSizeFast,
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

  // Avoid using persisted table-data fallback during optimization runs.
  // This prevents stale cross-file localStorage values from contaminating current design state.
  try {
    if (typeof globalThis !== 'undefined') (globalThis as any).__cooptDisablePersistedTableFallback = true;
  } catch (_) {}

  // Ensure the active-config evaluator sees Blocks, not stale live UI tables.
  try {
    if (activeConfigId !== null && activeConfigId !== undefined) {
      const ab = blocksByConfigId[String(activeConfigId)];
      if (Array.isArray(ab)) updateActiveOpticalSystemOverrideFromBlocks(ab);
    }
  } catch (_) {}

  // Run-scoped ID for TA cross-eval cache keys (prevents leakage across benchmark runs).
  try {
    if (typeof globalThis !== 'undefined') {
      const rid = `run-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      (globalThis as any).__cooptTaEvalRunId = rid;
    }
  } catch (_) {}

  try {

  const requirementsRaw = getSystemRequirementsRaw(systemConfig, opts.systemRequirementsRows);
  const requirements = (Array.isArray(requirementsRaw) ? requirementsRaw : [])
    .map(r => normalizeRequirementRow(r, systemConfig, activeConfigId));

  const expandedRequirements = expandRequirementScopesForOptimizer(
    expandRequirementsForTargetConfigs(requirements, targetConfigIds, activeConfigId),
    systemConfig,
    activeConfigId,
    Array.isArray(opts.sourceRows) ? opts.sourceRows : null
  )
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
    baselineBlocksByConfigId: snapshotBlocksByConfigId(blocksByConfigId),
    targetConfigIds,
    activeConfigId
  };

  const cloneForOptimizerResult = (value) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return null;
    }
  };

  const buildOptimizerResultSnapshotForUi = () => {
    try {
      const systemConfigSnapshot = cloneForOptimizerResult(systemConfig);
      if (!systemConfigSnapshot || typeof systemConfigSnapshot !== 'object') return null;
      try {
        const snapshotConfigs = Array.isArray(systemConfigSnapshot.configurations) ? systemConfigSnapshot.configurations : [];
        for (const cfg of snapshotConfigs) {
          const cid = String(cfg?.id ?? '').trim();
          const blocks = cid && blocksByConfigId ? blocksByConfigId[cid] : null;
          if (!cfg || !Array.isArray(blocks)) continue;
          const clonedBlocks = cloneForOptimizerResult(blocks) || blocks;
          materializeBlockVariableValuesFromParameters(clonedBlocks);
          cfg.blocks = clonedBlocks;
          try {
            const expanded = expandBlocksIntoConfiguration(cfg);
            if (expanded && Array.isArray(expanded.expandedOpticalSystem)) {
              cfg.opticalSystem = expanded.expandedOpticalSystem;
            }
          } catch (_) {
            try {
              const expandedRows = expandBlocksToOpticalSystemRows(clonedBlocks);
              if (expandedRows && Array.isArray(expandedRows.rows)) cfg.opticalSystem = expandedRows.rows;
            } catch (_) {}
          }
        }
      } catch (_) {}
      const activeId = String(systemConfigSnapshot.activeConfigId ?? jointState?.activeConfigId ?? '').trim();
      const configs = Array.isArray(systemConfigSnapshot.configurations) ? systemConfigSnapshot.configurations : [];
      const activeConfig = configs.find(c => c && String(c.id ?? '') === activeId) || configs[0] || null;
      const opticalSystemRowsSnapshot = Array.isArray(activeConfig?.opticalSystem)
        ? cloneForOptimizerResult(activeConfig.opticalSystem)
        : [];
      return {
        systemConfigSnapshot,
        opticalSystemRowsSnapshot: Array.isArray(opticalSystemRowsSnapshot) ? opticalSystemRowsSnapshot : [],
        activeConfigId: activeId,
      };
    } catch (_) {
      return null;
    }
  };

  let __lastOptimizerResultSnapshotForUi = null;

  let bestFeasibleEval = null;
  let bestInfeasibleEval = null;
  let bestScoreEval = null;
  let bestScoreBlocksSnapshot = null;
  const recordEval = (e) => {
    if (!e) return;
    const snap = (e.blocksSnapshot && typeof e.blocksSnapshot === 'object')
      ? snapshotBlocksByConfigId(e.blocksSnapshot)
      : snapshotBlocksByConfigId(blocksByConfigId);
    const scoredEval = { ...e, blocksSnapshot: snap };
    if (
      !bestScoreEval ||
      toFiniteNumber(e.score, Infinity) < (toFiniteNumber(bestScoreEval.score, Infinity) - 1e-12)
    ) {
      bestScoreEval = scoredEval;
      bestScoreBlocksSnapshot = snap;
    }
    if (e.feasible) {
      if (!bestFeasibleEval || compareEval(e, bestFeasibleEval)) {
        bestFeasibleEval = scoredEval;
      }
    } else {
      if (!bestInfeasibleEval || compareEval(e, bestInfeasibleEval)) {
        bestInfeasibleEval = scoredEval;
      }
    }
  };
  const getBestEvalSoFar = () => bestFeasibleEval || bestInfeasibleEval;
  const getBestScoreEvalSoFar = () => bestScoreEval || bestFeasibleEval || bestInfeasibleEval;
  let __lastRequirementsSnapshotAt = 0;
  const __requirementsSnapshotThrottleMs = 120;
  const evalCompositeFromRequirements = () => {
      const now = Date.now();
      const shouldCollectRequirementSnapshots = (now - __lastRequirementsSnapshotAt) >= __requirementsSnapshotThrottleMs;
    const req = evaluateRequirementsAllConfigsAllScenarios({
      expandedRequirements,
      residualItems,
        multiScenario,
        collectRequirementSnapshots: shouldCollectRequirementSnapshots
    });
    try {
        if (shouldCollectRequirementSnapshots) {
        __lastRequirementsSnapshotAt = now;
        const prevDbg = getLastOptimizerResidualDebug();
        setLastOptimizerResidualDebug({
          ...(prevDbg && typeof prevDbg === 'object' ? prevDbg : {}),
          at: now,
          method,
          requirementsSnapshot: Array.isArray(req?.requirementSnapshots) ? req.requirementSnapshots : []
        });
      }
    } catch (_) {}
    const violationScore = toFiniteNumber(req.violationScore, 0);
    const softPenalty = toFiniteNumber(req.softPenalty, 0);
    const baseScore = violationScore + softPenalty;
    let escapePenalty = 0;
    try {
      const escapeMinima = normalizeEscapeMinima(opts.__escapeGlobalMinima);
      if (escapeMinima.length > 0) {
        const point = yr.map((variable) => {
          const value = jointState
            ? Number(getJointCurrentValue(jointState, variable.id))
            : Number(getCurrentDesignValueByVariableId(activeCfg, variable.id));
          return Number.isFinite(value) ? value : 0;
        });
        escapePenalty = computeEscapePenaltyScore(point, escapeMinima);
      }
    } catch (_) {
      escapePenalty = 0;
    }
    const score = baseScore + escapePenalty;
    return {
      merit: 0,
      score,
      baseScore,
      requirementScore: baseScore,
      escapePenalty,
      feasible: !!req.feasible,
      violationScore,
      softPenalty,
      requirementSnapshots: Array.isArray(req?.requirementSnapshots) ? req.requirementSnapshots : [],
      hardViolations: req.hardViolations || [],
      softViolations: req.softViolations || []
    };
  };

  const evalCompositeFromRequirementsProfiled = __profile
    ? () => {
      return __profileBucketWrap('time_objective_eval', () => {
        const t = nowMs();
        try {
          __profile.counts.evalCompositeCalls++;
          return evalCompositeFromRequirements();
        } finally {
          const dt = nowMs() - t;
          __profile.counts.evalCompositeMs += dt;
          __profAdd('evalCompositeFromRequirements', dt);
        }
      });
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
  const hasInfiniteRadiusSeedVars = targetConfigs.some((cfg) => {
    const all = listDesignVariablesFromBlocks(cfg || {});
    return Array.isArray(all) && all.some((v) => {
      const key = String(v?.key ?? '').trim();
      const raw = String(v?.value ?? '').trim();
      return /^inf(inity)?$/i.test(raw)
        && (/^(front|back)radius$/i.test(key) || /^radius$/i.test(key) || /^surf\d+radius$/i.test(key));
    });
  });
  const asphereVarCount = vars.filter(v => isAsphereCoefKey(v?.key)).length;

  if (vars.length === 0 && catVars.length === 0) {
    return { ok: false, reason: formatNoVariableReason(activeCfg) };
  }

  // Helper functions used by both LM and AL methods
  const getScaleForVar = (v) => {
    try {
      const parsed = parseJointVariableId(v.id);
      const cfgId = parsed.configId ? String(parsed.configId) : String(activeConfigId ?? '');
      const blocks = ((jointState && jointState.blocksByConfigId && cfgId)
        ? jointState.blocksByConfigId[cfgId]
        : null) ?? activeCfg?.blocks;
      const entry = getVariableEntryFromBlocks(blocks, parsed.baseId);
      const scaleFromEntry = entry?.optimize && Number.isFinite(Number(entry.optimize.scale)) ? Number(entry.optimize.scale) : null;
      const blockId = String(parsed.baseId ?? '').split('.')[0];
      const block = Array.isArray(blocks)
        ? blocks.find(candidate => String(candidate?.blockId ?? '') === blockId)
        : null;
      const qconVariable = isQconCoefficientVariable(block, v.key);
      const base = qconVariable
        ? defaultScaleForBlockVariable(block, v.key)
        : (scaleFromEntry !== null ? Math.max(1e-30, scaleFromEntry) : defaultScaleForBlockVariable(block, v.key));
      if (qconVariable) return base;
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
    const qconVariable = (() => {
      try {
        const parsed = parseJointVariableId(v.id);
        const cfgId = parsed.configId ? String(parsed.configId) : String(activeConfigId ?? '');
        const blocks = ((jointState && jointState.blocksByConfigId && cfgId)
          ? jointState.blocksByConfigId[cfgId]
          : null) ?? activeCfg?.blocks;
        const blockId = String(parsed.baseId ?? '').split('.')[0];
        const block = Array.isArray(blocks)
          ? blocks.find(candidate => String(candidate?.blockId ?? '') === blockId)
          : null;
        return isQconCoefficientVariable(block, v.key);
      } catch (_) {
        return false;
      }
    })();

    // Prefer a scaled step so tiny coef vars get a meaningful derivative.
    // Keep relative step too so large radii still use a reasonable perturbation.
    const relFraction = qconVariable && qconFdStepRel !== null ? qconFdStepRel : fdStepFraction;
    const rel = absx * relFraction;
    const scaled = qconVariable && qconFdStepAbs !== null ? qconFdStepAbs : scale * fdScaledStep;

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

  const solveLinearSystemWithOptionalWasm = (matrix, rhs, preferSpd = true) => {
    if (__profile && __profile.counts) {
      __profile.counts.wasmLinearSolveCalls = (Number(__profile.counts.wasmLinearSolveCalls) || 0) + 1;
    }

    if (useWasmLinearSolve) {
      const wasmSolved = __profileBucketWrap('time_wasm_call', () => solveLinearSystemWithOptimizerWasm(matrix, rhs, preferSpd));
      if (Array.isArray(wasmSolved) && wasmSolved.length === rhs.length) {
        if (__profile && __profile.counts) {
          __profile.counts.wasmLinearSolveHits = (Number(__profile.counts.wasmLinearSolveHits) || 0) + 1;
        }
        return wasmSolved;
      }
    }

    if (__profile && __profile.counts) {
      __profile.counts.wasmLinearSolveFallbacks = (Number(__profile.counts.wasmLinearSolveFallbacks) || 0) + 1;
    }

    let solved = __profileBucketWrap('time_js_overhead', () => solveSymmetricPositiveDefinite(matrix, rhs));
    if (!solved) solved = __profileBucketWrap('time_js_overhead', () => solveLinearSystemFallback(matrix, rhs));
    return solved;
  };

  const updateTrustRegionRadiusWithOptionalWasm = ({
    predictedReduction,
    actualReduction,
    currentRadius,
    minRadius,
    maxRadius,
    eta1 = 0.25,
    eta2 = 0.75,
    gammaDec = 0.5,
    gammaInc = 2.0
  }) => {
    const nextRadius = __profileBucketWrap('time_wasm_call', () => updateTrustRegionRadiusWasm(
      predictedReduction,
      actualReduction,
      currentRadius,
      eta1,
      eta2,
      gammaDec,
      gammaInc,
      minRadius,
      maxRadius
    ));
    return Number.isFinite(nextRadius) ? nextRadius : null;
  };

  const sanitizeJacobianRows = (J, rowCount, colCount) => {
    const safeRowCount = Number.isFinite(Number(rowCount)) ? Math.max(0, Math.floor(Number(rowCount))) : 0;
    const safeColCount = Number.isFinite(Number(colCount)) ? Math.max(0, Math.floor(Number(colCount))) : 0;
    const out = new Array(safeRowCount);
    for (let i = 0; i < safeRowCount; i++) {
      const srcRow = Array.isArray(J?.[i]) ? J[i] : [];
      const dstRow = new Array(safeColCount).fill(0);
      for (let j = 0; j < safeColCount; j++) {
        const value = Number(srcRow[j]);
        dstRow[j] = Number.isFinite(value) ? value : 0;
      }
      out[i] = dstRow;
    }
    return out;
  };

  const buildNormalEquationsWithOptionalWasm = (J, r, m, n) => {
    if (__profile && __profile.counts) {
      __profile.counts.wasmNormalEqCalls = (Number(__profile.counts.wasmNormalEqCalls) || 0) + 1;
    }

    const rowCount = Math.max(0, Math.min(
      Number.isFinite(Number(m)) ? Math.floor(Number(m)) : 0,
      Array.isArray(J) ? J.length : 0,
      Array.isArray(r) ? r.length : 0,
    ));
    const colCount = Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0;

    if (rowCount <= 0 || colCount <= 0) {
      return {
        A: Array.from({ length: colCount }, () => Array(colCount).fill(0)),
        g: Array(colCount).fill(0),
      };
    }

    const sanitizedJ = new Array(rowCount);
    const sanitizedR = new Array(rowCount);
    for (let i = 0; i < rowCount; i++) {
      const srcRow = Array.isArray(J?.[i]) ? J[i] : [];
      const dstRow = new Array(colCount).fill(0);
      for (let j = 0; j < colCount; j++) {
        const value = Number(srcRow[j]);
        dstRow[j] = Number.isFinite(value) ? value : 0;
      }
      sanitizedJ[i] = dstRow;
      const residual = Number(r[i]);
      sanitizedR[i] = Number.isFinite(residual) ? residual : 0;
    }

    if (useWasmLinearSolve) {
      const wasmBuilt = __profileBucketWrap('time_wasm_call', () => buildNormalEquationsWithOptimizerWasm(sanitizedJ, sanitizedR, rowCount, colCount));
      if (wasmBuilt && Array.isArray(wasmBuilt.A) && Array.isArray(wasmBuilt.g)) {
        if (__profile && __profile.counts) {
          __profile.counts.wasmNormalEqHits = (Number(__profile.counts.wasmNormalEqHits) || 0) + 1;
        }
        return wasmBuilt;
      }
    }

    if (__profile && __profile.counts) {
      __profile.counts.wasmNormalEqFallbacks = (Number(__profile.counts.wasmNormalEqFallbacks) || 0) + 1;
    }

    return __profileBucketWrap('time_js_overhead', () => {
      const A = Array.from({ length: colCount }, () => Array(colCount).fill(0));
      const g = Array(colCount).fill(0);
      for (let j = 0; j < colCount; j++) {
        let gj = 0;
        for (let i = 0; i < rowCount; i++) {
          gj += sanitizedJ[i][j] * sanitizedR[i];
        }
        g[j] = gj;
      }
      for (let j = 0; j < colCount; j++) {
        for (let k = 0; k <= j; k++) {
          let s = 0;
          for (let i = 0; i < rowCount; i++) {
            s += sanitizedJ[i][j] * sanitizedJ[i][k];
          }
          A[j][k] = s;
          A[k][j] = s;
        }
      }
      return { A, g };
    });
  };

  const solveNormalEqMatrixFreeWithOptionalWasm = (J, r, damping, n) => {
    if (!kktUseMatrixFreeCore) return null;
    const __mfT0 = nowMs();
    const matrixFreeCounts = (__profile && __profile.counts) ? __profile.counts : null;
    const completeMatrixFree = (result, fallbackReason = null) => {
      if (matrixFreeCounts) {
        matrixFreeCounts.kktMatrixFreeMs = (Number(matrixFreeCounts.kktMatrixFreeMs) || 0) + Math.max(0, nowMs() - __mfT0);
      }
      if (fallbackReason && matrixFreeCounts) {
        const reason = String(fallbackReason || 'unknown');
        matrixFreeCounts.kktMatrixFreeFallbacks = (Number(matrixFreeCounts.kktMatrixFreeFallbacks) || 0) + 1;
        matrixFreeCounts.kktMatrixFreeLastFallbackReason = reason;
        const histogram = (matrixFreeCounts.kktMatrixFreeFallbackReasons && typeof matrixFreeCounts.kktMatrixFreeFallbackReasons === 'object')
          ? matrixFreeCounts.kktMatrixFreeFallbackReasons
          : (matrixFreeCounts.kktMatrixFreeFallbackReasons = {});
        histogram[reason] = (Number(histogram[reason]) || 0) + 1;
      }
      if (fallbackReason && phaseCDebug) {
        try {
          console.log('[PHASE-C][matrix-free] fallback', {
            reason: String(fallbackReason),
            damping: Number(damping),
            n,
            m: Array.isArray(J) ? J.length : null
          });
        } catch (_) {}
      }
      return result;
    };

    const completeMatrixFreeSuccess = (dx, predictedReduction, cgIters, finalResidualNorm) => {
      if (matrixFreeCounts) {
        matrixFreeCounts.kktMatrixFreeHits = (Number(matrixFreeCounts.kktMatrixFreeHits) || 0) + 1;
        matrixFreeCounts.kktMatrixFreeCgIters = (Number(matrixFreeCounts.kktMatrixFreeCgIters) || 0) + (Number(cgIters) || 0);
        matrixFreeCounts.kktMatrixFreeSolverIters = (Number(matrixFreeCounts.kktMatrixFreeSolverIters) || 0) + (Number(cgIters) || 0);
        matrixFreeCounts.kktMatrixFreeResidualNorm = Number.isFinite(finalResidualNorm) ? finalResidualNorm : Number.NaN;
      }

      if (!Array.isArray(dx) || !dx.every((v) => Number.isFinite(v))) {
        return completeMatrixFree(null, 'non-finite-solution');
      }

      return completeMatrixFree({
        dx,
        predictedReduction: Number.isFinite(predictedReduction) ? predictedReduction : Number.NaN
      });
    };

    if (!Array.isArray(J) || !Array.isArray(r) || n <= 0) return completeMatrixFree(null, 'invalid-input-shape');

    const m = Math.max(0, Math.min(J.length, r.length));
    if (m <= 0) return completeMatrixFree(null, 'invalid-residual-shape');

    const sanitizedJ = sanitizeJacobianRows(J, m, n);
    const sanitizedR = new Array(m);
    for (let i = 0; i < m; i++) {
      const residual = Number(r[i]);
      sanitizedR[i] = Number.isFinite(residual) ? residual : 0;
    }

    const jFlat = new Float64Array(m * n);
    for (let i = 0; i < m; i++) {
      const rowBase = i * n;
      for (let j = 0; j < n; j++) {
        const value = Number(sanitizedJ[i][j]);
        if (!Number.isFinite(value)) return completeMatrixFree(null, 'non-finite-jacobian');
        jFlat[rowBase + j] = value;
      }
    }

    if (__profile && __profile.counts) {
      __profile.counts.kktMatrixFreeCalls = (Number(__profile.counts.kktMatrixFreeCalls) || 0) + 1;
    }

    const g = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      let gj = 0;
      for (let i = 0; i < m; i++) {
        gj += sanitizedJ[i][j] * sanitizedR[i];
      }
      g[j] = gj;
    }
    const b = g.map((v) => -v);

    const lambda = Number.isFinite(Number(damping)) ? Math.max(0, Number(damping)) : 0;
    const matvec = (v) => {
      if (!Array.isArray(v) || v.length !== n) return null;
      let out = __profileBucketWrap('time_wasm_call', () => normalEqMatvecFlatWasm(jFlat, m, n, v, lambda));
      if (Array.isArray(out) && out.length === n) {
        return out;
      }
      return __profileBucketWrap('time_js_overhead', () => {
        const tmp = new Array(m).fill(0);
        for (let i = 0; i < m; i++) {
          let s = 0;
          const rowBase = i * n;
          for (let j = 0; j < n; j++) s += jFlat[rowBase + j] * v[j];
          tmp[i] = s;
        }
        const y = new Array(n).fill(0);
        for (let j = 0; j < n; j++) {
          let s = 0;
          for (let i = 0; i < m; i++) s += jFlat[i * n + j] * tmp[i];
          y[j] = s + lambda * v[j];
        }
        return y;
      });
    };

    const maxIter = Number.isFinite(Number(opts?.kktMatrixFreeCgMaxIter))
      ? Math.max(4, Math.floor(Number(opts.kktMatrixFreeCgMaxIter)))
      : Math.max(12, Math.min(6 * n, 192));
    const tolRel = Number.isFinite(Number(opts?.kktMatrixFreeCgTolRel))
      ? Math.max(1e-12, Number(opts.kktMatrixFreeCgTolRel))
      : 1e-8;
    const tolAbsOpt = Number.isFinite(Number(opts?.kktMatrixFreeCgTolAbs))
      ? Math.max(1e-15, Number(opts.kktMatrixFreeCgTolAbs))
      : null;

    const diagA = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      let sumSq = 0;
      for (let i = 0; i < m; i++) {
        const v = jFlat[i * n + j];
        sumSq += v * v;
      }
      const d = sumSq + lambda;
      diagA[j] = Number.isFinite(d) && d > 1e-12 ? d : 1e-12;
    }

    const x = new Array(n).fill(0);
    let residual = b.slice();
    const z = new Array(n).fill(0);
    for (let i = 0; i < n; i++) z[i] = residual[i] / diagA[i];
    let p = z.slice();

    const bNorm = Math.sqrt(Math.max(0, dot(b, b)));
    const tolAbs = tolAbsOpt !== null ? tolAbsOpt : Math.max(1e-12, bNorm * tolRel);
    let finalResidualNorm = Math.sqrt(Math.max(0, dot(residual, residual)));

    let rz = dot(residual, z);
    if (!Number.isFinite(rz) || rz <= 0) {
      // When b is already near zero, x=0 is a valid converged solution.
      if (finalResidualNorm <= tolAbs) {
        return completeMatrixFreeSuccess(x, 0, 0, finalResidualNorm);
      }
      return completeMatrixFree(null, 'invalid-initial-rz');
    }

    let cgIters = 0;
    for (let k = 0; k < maxIter; k++) {
      cgIters = k + 1;
      const Ap = matvec(p);
      if (!Array.isArray(Ap) || Ap.length !== n) return completeMatrixFree(null, 'matvec-failed');

      const pAp = dot(p, Ap);
      if (!Number.isFinite(pAp) || Math.abs(pAp) <= 1e-30) return completeMatrixFree(null, 'degenerate-pap');
      const alpha = rz / pAp;
      if (!Number.isFinite(alpha)) return completeMatrixFree(null, 'invalid-alpha');

      for (let i = 0; i < n; i++) {
        x[i] += alpha * p[i];
        residual[i] -= alpha * Ap[i];
      }

      const rNorm = Math.sqrt(Math.max(0, dot(residual, residual)));
      if (!Number.isFinite(rNorm)) return completeMatrixFree(null, 'non-finite-residual');
      finalResidualNorm = rNorm;
      if (rNorm <= tolAbs) {
        break;
      }

      for (let i = 0; i < n; i++) z[i] = residual[i] / diagA[i];
      const rzNext = dot(residual, z);
      if (!Number.isFinite(rzNext) || rzNext <= 0) return completeMatrixFree(null, 'invalid-rz-next');

      const beta = rzNext / Math.max(1e-30, rz);
      if (!Number.isFinite(beta)) return completeMatrixFree(null, 'invalid-beta');
      for (let i = 0; i < n; i++) {
        p[i] = z[i] + beta * p[i];
      }
      rz = rzNext;
    }

    const Adx = matvec(x);
    if (!Array.isArray(Adx) || Adx.length !== n) return completeMatrixFree(null, 'post-matvec-failed');
    const linear = dot(g, x);
    const quad = 0.5 * dot(x, Adx);
    const predictedReduction = -(linear + quad);

    return completeMatrixFreeSuccess(x, predictedReduction, cgIters, finalResidualNorm);
  };

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
    const evalResidualsNow = async () => {
      /** @type {number[]} */
      const residuals = [];
      const operandValueCache = new Map();

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
      let __prevRuntimeCache = null;

      const itemsArr = Array.isArray(residualItemsForLM) ? residualItemsForLM : [];
      try {
        try {
          __prevRuntimeCache = (editor && editor._runtimeCache !== undefined) ? editor._runtimeCache : null;
          if (editor) {
            editor._runtimeCache = new Map();
            if (__profile) __profile.counts.meritRuntimeCacheEnabled = (Number(__profile.counts.meritRuntimeCacheEnabled) || 0) + 1;
          }
        } catch (_) {
          __prevRuntimeCache = null;
        }

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
                const expanded = expandBlocksForOptimization(blocks);
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
          param5: r?.param5,
          target: r?.target,
          weight: r?.weight
        };

        const opCacheKey = [
          String(cfgId),
          String(sid ?? ''),
          String(r?.operand ?? ''),
          String(r?.param1 ?? ''),
          String(r?.param2 ?? ''),
          String(r?.param3 ?? ''),
          String(r?.param4 ?? ''),
          String(r?.param5 ?? '')
        ].join('|');

        let rawValue;
        if (operandValueCache.has(opCacheKey)) {
          if (__profile) __profile.counts.operandValueCacheHits = (Number(__profile.counts.operandValueCacheHits) || 0) + 1;
          rawValue = operandValueCache.get(opCacheKey);
        } else {
          if (__profile) __profile.counts.operandValueCacheMisses = (Number(__profile.counts.operandValueCacheMisses) || 0) + 1;
          if (editor && typeof editor.calculateOperandValueAsync === 'function') {
            rawValue = await editor.calculateOperandValueAsync(opObj);
          } else {
            rawValue = editor.calculateOperandValue(opObj);
          }
          operandValueCache.set(opCacheKey, rawValue);
        }

        const evaluated = computeAmountOrPenalty(r?.op, rawValue, r?.target, r?.tol);
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
        try {
          if (editor) editor._runtimeCache = __prevRuntimeCache;
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
      ? async () => {
        const tBucket = nowMs();
        const t = nowMs();
        try {
          __profile.counts.evalResidualsNowCalls++;
          return await evalResidualsNow();
        } finally {
          const dt = nowMs() - t;
          __profile.counts.evalResidualsNowMs += dt;
          __profAdd('evalResidualsNow', dt);

          const bucketDt = Math.max(0, nowMs() - tBucket);
          const buckets = __profile.timingBuckets || (__profile.timingBuckets = {
            time_objective_eval: 0,
            time_wasm_call: 0,
            time_js_overhead: 0
          });
          buckets.time_objective_eval = (Number(buckets.time_objective_eval) || 0) + bucketDt;
          __profile.counts.timeObjectiveEvalCalls = (Number(__profile.counts.timeObjectiveEvalCalls) || 0) + 1;
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
    const initial = await evalResidualsNowProfiled();
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
        const re = await evalResidualsNowProfiled();
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

      }

      // Final sync to tables
      try {
        const finalEval = getBestScoreEvalSoFar() || getBestEvalSoFar();
        restoreBestSnapshotAndPersist({ finalEval, jointState, systemConfig, configsById, targetConfigIds });
      } catch (_) {}

      restorePreOptimizationGlobalsForUiSync();
      publishLatestSystemConfigForUiSync();

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
          recalculateMeritIfSurfaceRangesValid();
        }
      } catch (_) {}
      try {
        if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.evaluateAndUpdateNow === 'function') {
          window.systemRequirementsEditor.evaluateAndUpdateNow();
        }
      } catch (_) {}

      const aborted0 = shouldStop ? !!shouldStop() : false;
      const finalEval = getBestScoreEvalSoFar() || getBestEvalSoFar();
      const finalCompositeEval0 = evalCompositeFromRequirementsProfiled();
      const finalViolationScore0 = Number.isFinite(finalCompositeEval0?.violationScore)
        ? finalCompositeEval0.violationScore
        : (finalEval ? finalEval.violationScore : 0);
      const finalSoftPenalty0 = Number.isFinite(finalCompositeEval0?.softPenalty)
        ? finalCompositeEval0.softPenalty
        : (finalEval ? finalEval.softPenalty : 0);
      const finalFeasible0 = (finalCompositeEval0?.feasible !== undefined)
        ? !!finalCompositeEval0.feasible
        : (finalEval ? finalEval.feasible : true);
      const finalBestScore0 = Number.isFinite(finalEval?.score)
        ? finalEval.score
        : best0;
      const finalObjectiveScore0 = Number.isFinite(finalBestScore0)
        ? finalBestScore0
        : (Number.isFinite(finalCompositeEval0?.score)
          ? finalCompositeEval0.score
          : best0);
      if (onProgress) {
        try {
          onProgress({
            phase: 'done',
            iter: completed0,
              current: finalObjectiveScore0,
              best: finalBestScore0,
            method: 'lm',
            multiScenario,
            requirementCount,
            ms: Math.round(nowMs() - t0),
            feasible: finalFeasible0,
            violationScore: finalViolationScore0,
            softPenalty: finalSoftPenalty0
          });
        } catch (_) {}
        await nextFrame();
      }

      return {
        ok: true,
        aborted: aborted0,
        before: before0,
          best: finalBestScore0,
        iterations: completed0,
        variables: 0,
        method: 'lm',
        feasible: finalFeasible0,
        violationScore: finalViolationScore0,
        softPenalty: finalSoftPenalty0,
        objectiveScore: finalObjectiveScore0,
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

    // Reset aspheric coefficients at the start if option is enabled (helps avoid local minima)
    if (resetAsphericCoefs) {
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
      const hasAsphereVars = curVars.some((v) => isAsphereCoefKey(v?.key) || /conic$/i.test(String(v?.key || '')));

      // Evaluate base residuals
      const base = await evalResidualsNowProfiled();
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

        // apply perturbed
        for (let k = 0; k < n; k++) {
          setJointDesignVariableValue(jointState, ids[k], xPert[k]);
        }
        maybeSave('jacobian');

        const br = await evalResidualsNowProfiled();
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
      const ne = buildNormalEquationsWithOptionalWasm(J, r0, m, n);
      const A = ne.A;
      const g = ne.g;

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

      let dx = solveLinearSystemWithOptionalWasm(Ad, b, true);
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
      let acceptedDxStep = null;

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

      const computeLmGeodesicStep = async (baseStep) => {
        if (!lmGeodesicAcceleration) return null;
        if (lmGeodesicAsphereOnly && !hasAsphereVars) return null;
        if (!Array.isArray(baseStep) || baseStep.length !== n) return null;

        let velocityNormScaled = 0;
        for (let i = 0; i < n; i++) {
          const si = scales[i] || 1;
          const vi = baseStep[i] / si;
          velocityNormScaled += vi * vi;
        }
        velocityNormScaled = Math.sqrt(Math.max(0, velocityNormScaled));
        if (!Number.isFinite(velocityNormScaled) || velocityNormScaled < 1e-12) return null;

        const probeAlpha = lmGeodesicProbeAlpha;
        const xProbe = x0.map((v, i) => v + probeAlpha * baseStep[i]);
        for (let k = 0; k < n; k++) {
          setJointDesignVariableValue(jointState, ids[k], xProbe[k]);
        }
        maybeSave('candidate');

        let probeResiduals = null;
        try {
          const probeEval = await evalResidualsNowProfiled();
          probeResiduals = Array.isArray(probeEval?.residuals) ? probeEval.residuals : null;
        } finally {
          for (let k = 0; k < n; k++) {
            setJointDesignVariableValue(jointState, ids[k], x0[k]);
          }
          maybeSave('restore');
        }

        if (!Array.isArray(probeResiduals) || probeResiduals.length < m) return null;

        const fvv = new Array(m).fill(0);
        for (let row = 0; row < m; row++) {
          let jv = 0;
          const jRow = J[row];
          for (let col = 0; col < n; col++) {
            jv += Number(jRow?.[col]) * Number(baseStep[col]);
          }
          const probeResidual = Number(probeResiduals[row]);
          const baseResidual = Number(r0[row]);
          const numerator = probeResidual - baseResidual - probeAlpha * jv;
          const secondDirectional = (2 * numerator) / (probeAlpha * probeAlpha);
          fvv[row] = Number.isFinite(secondDirectional) ? secondDirectional : 0;
        }

        const rhsAccel = buildNormalEquationsWithOptionalWasm(J, fvv, m, n).g.map((v) => -v);
        const accel = solveLinearSystemWithOptionalWasm(Ad, rhsAccel, true);
        if (!Array.isArray(accel) || accel.length !== n) return null;

        let accelNormScaled = 0;
        for (let i = 0; i < n; i++) {
          const si = scales[i] || 1;
          const ai = Number(accel[i]) / si;
          accelNormScaled += ai * ai;
        }
        accelNormScaled = Math.sqrt(Math.max(0, accelNormScaled));
        if (!Number.isFinite(accelNormScaled)) return null;

        const accelRatio = (2 * accelNormScaled) / Math.max(1e-12, velocityNormScaled);
        if (!Number.isFinite(accelRatio) || accelRatio > lmGeodesicAccelLimit) {
          return null;
        }

        const corrected = baseStep.map((v, i) => v + 0.5 * Number(accel[i]));
        if (trustRegion) {
          let maxAbs = 0;
          for (let i = 0; i < n; i++) {
            const si = scales[i] || 1;
            const di = corrected[i] / si;
            const a = Math.abs(di);
            if (a > maxAbs) maxAbs = a;
          }
          const delta = trustRegionDeltaEff;
          if (Number.isFinite(maxAbs) && maxAbs > delta && maxAbs > 0) {
            const factor = delta / maxAbs;
            for (let i = 0; i < n; i++) corrected[i] *= factor;
          }
        }

        for (const value of corrected) {
          if (!Number.isFinite(value)) return null;
        }

        return {
          step: corrected,
          accelRatio,
          velocityNormScaled,
          accelNormScaled
        };
      };

      let geodesicBaseStep = null;
      if (!exploreThisIter) {
        try {
          geodesicBaseStep = await computeLmGeodesicStep(dx);
        } catch (_) {
          geodesicBaseStep = null;
        }
      }

      for (const alpha of alphas) {
        const dxStep = exploreThisIter
          ? makeRandomStep(alpha)
          : ((alpha === 1 && geodesicBaseStep && Array.isArray(geodesicBaseStep.step))
            ? geodesicBaseStep.step.slice()
            : dx.map(v => alpha * v));
        // Candidate x
        const xCand = x0.map((v, i) => v + dxStep[i]);
        for (let k = 0; k < n; k++) {
          setJointDesignVariableValue(jointState, ids[k], xCand[k]);
        }
        maybeSave('candidate');

        const cand = await evalResidualsNowProfiled();
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
              geodesicAccelRatio: (alpha === 1 && geodesicBaseStep) ? Number(geodesicBaseStep.accelRatio) : undefined,
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
          acceptedDxStep = dxStep.slice();
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
          const actualReduction = Number.isFinite(cost0) && Number.isFinite(acceptedCost) ? (cost0 - acceptedCost) : 0;
          const predictedReduction = acceptedDxStep ? predictedReductionForStep(acceptedDxStep) : Number.NaN;
          const wasmRadius = updateTrustRegionRadiusWithOptionalWasm({
            predictedReduction,
            actualReduction,
            currentRadius: trustRegionDeltaEff,
            minRadius: minDelta,
            maxRadius: trustRegionDeltaMax,
            gammaDec: 0.95,
            gammaInc: 1.25
          });
          if (Number.isFinite(wasmRadius)) {
            trustRegionDeltaEff = wasmRadius;
          } else if (acceptedRho > 0.75) {
            trustRegionDeltaEff = Math.min(trustRegionDeltaMax, Math.max(trustRegionDelta, trustRegionDeltaEff * 1.25));
          } else if (acceptedRho > 0.25) {
            trustRegionDeltaEff = Math.min(trustRegionDeltaMax, Math.max(trustRegionDelta, trustRegionDeltaEff * 1.05));
          } else {
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
          const rejectedPred = predictedReductionForStep(dx);
          const wasmRadius = updateTrustRegionRadiusWithOptionalWasm({
            predictedReduction: rejectedPred,
            actualReduction: 0,
            currentRadius: trustRegionDeltaEff,
            minRadius: minDelta,
            maxRadius: trustRegionDeltaMax,
            gammaDec: 0.9,
            gammaInc: 1.1
          });
          trustRegionDeltaEff = Number.isFinite(wasmRadius) ? wasmRadius : Math.max(minDelta, trustRegionDeltaEff * 0.9);
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
              const rr = await evalResidualsNowProfiled();
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

    }

    // Final sync to tables (push expanded rows into Tabulator without requiring a reload)
    try {
      const finalEval = getBestScoreEvalSoFar() || getBestEvalSoFar();
      restoreBestSnapshotAndPersist({ finalEval, jointState, systemConfig, configsById, targetConfigIds });
    } catch (_) {}

    restorePreOptimizationGlobalsForUiSync();
    publishLatestSystemConfigForUiSync();

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
        recalculateMeritIfSurfaceRangesValid();
      }
    } catch (_) {}
    try {
      if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.evaluateAndUpdateNow === 'function') {
        window.systemRequirementsEditor.evaluateAndUpdateNow();
      }
    } catch (_) {}

    const t1 = nowMs();

    const finalEval = getBestScoreEvalSoFar() || getBestEvalSoFar();
    const finalCompositeEval = evalCompositeFromRequirementsProfiled();
    const finalViolationScore = Number.isFinite(finalCompositeEval?.violationScore)
      ? finalCompositeEval.violationScore
      : (finalEval ? finalEval.violationScore : 0);
    const finalSoftPenalty = Number.isFinite(finalCompositeEval?.softPenalty)
      ? finalCompositeEval.softPenalty
      : (finalEval ? finalEval.softPenalty : 0);
    const finalFeasible = (finalCompositeEval?.feasible !== undefined)
      ? !!finalCompositeEval.feasible
      : (finalEval ? finalEval.feasible : true);
    const finalBestScore = Number.isFinite(finalEval?.score)
      ? finalEval.score
      : best;
    const finalObjectiveScore = Number.isFinite(finalBestScore)
      ? finalBestScore
      : (Number.isFinite(finalCompositeEval?.score)
        ? finalCompositeEval.score
        : best);

    if (onProgress) {
      try {
        onProgress({
          phase: 'done',
          iter: completedIterations,
            current: finalObjectiveScore,
            best: finalBestScore,
          method: 'lm',
          multiScenario,
          requirementCount,
          ms: Math.round(t1 - t0),
          feasible: finalFeasible,
          violationScore: finalViolationScore,
          softPenalty: finalSoftPenalty
        });
      } catch (_) {}
      await nextFrame();
    }

    const aborted = shouldStop ? !!shouldStop() : false;
    return {
      ok: true,
      aborted,
      before,
        best: finalBestScore,
      iterations: completedIterations,
      variables: vars.length,
      method: 'lm',
      feasible: finalFeasible,
      violationScore: finalViolationScore,
      softPenalty: finalSoftPenalty,
      objectiveScore: finalObjectiveScore,
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

  // Constrained optimization: AL + Gauss-Newton or KKT-SQP.
  if (method === 'kkt' || method === 'kkt-sqp') {
    const t0 = nowMs();
    const useKktSqp = method === 'kkt-sqp';
    const kktRequirementsAsConstraints = opts?.kktRequirementsAsConstraints === true;
    const kktAllowNonmonotoneScore = opts?.kktAllowNonmonotoneScore === true;
    const kktSqpExactScaledModelPrediction = opts?.kktSqpExactScaledModelPrediction !== false;
    const kktSqpShrinkTrustOnBacktrack = opts?.kktSqpShrinkTrustOnBacktrack === true;
    const kktSqpUseBfgs = opts?.kktSqpUseBfgs !== false;
    const kktSqpBfgsBlend = Number.isFinite(Number(opts?.kktSqpBfgsBlend))
      ? Math.max(0, Math.min(1, Number(opts.kktSqpBfgsBlend)))
      : 0.25;
    const kktSqpBfgsMinBlend = Number.isFinite(Number(opts?.kktSqpBfgsMinBlend))
      ? Math.max(0, Math.min(kktSqpBfgsBlend, Number(opts.kktSqpBfgsMinBlend)))
      : Math.min(0.25, kktSqpBfgsBlend);
    const kktSqpBfgsAdaptiveBlend = opts?.kktSqpBfgsAdaptiveBlend === true;
    const kktSqpBfgsConservativeScoreRatio = Number.isFinite(Number(opts?.kktSqpBfgsConservativeScoreRatio))
      ? Math.max(0, Math.min(1, Number(opts.kktSqpBfgsConservativeScoreRatio)))
      : 0.25;
    const constrainedMethod = useKktSqp ? 'kkt-sqp' : 'kkt';
    const constrainedLabel = useKktSqp ? 'KKT-SQP' : 'AL-GN';

    const evalStateKKT = () => evalCompositeFromRequirementsProfiled();
    const shouldStopKKT = () => shouldStop(constrainedLabel);

    await sanitizeAirMaterialsInDesignIntent({
      activeCfg,
      systemConfig,
      jointState,
      categoricalVars: catVars,
      evalState: evalStateKKT,
      onProgress,
      shouldStop,
      multiScenario,
      method: constrainedMethod
    });

    if (vars.length === 0 && catVars.length === 0) {
      return { ok: false, reason: formatNoVariableReason(activeCfg) };
    }

    // Allow KKT runs with only categorical material variables.
    if (vars.length === 0) {
      const before0Eval = evalStateKKT();
      recordEval(before0Eval);
      const before0 = before0Eval.score;
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
            method: constrainedMethod,
            multiScenario,
            requirementCount: Array.isArray(expandedRequirements) ? expandedRequirements.length : 0,
            feasible: before0Eval.feasible,
            violationScore: before0Eval.violationScore,
            softPenalty: before0Eval.softPenalty
          });
        } catch (_) {}
        await nextFrame();
      }

      for (let iter = 1; iter <= maxIterations; iter++) {
        if (shouldStopKKT()) break;
        completed0 = iter;

        const sweep = await runCategoricalMaterialSweep({
          activeCfg,
          systemConfig,
          jointState,
          categoricalVars: catVars,
          evalState: evalStateKKT,
          onProgress,
          shouldStop,
          iter,
          multiScenario,
          bestEval: getBestEvalSoFar() || before0Eval
        });

        if (sweep && sweep.bestEval) {
          recordEval(sweep.bestEval);
          best0 = (getBestEvalSoFar() || sweep.bestEval).score;
        }

        if (sweep && sweep.changed) {
          stall0 = 0;
        } else {
          stall0++;
          if (!runUntilStopped && stall0 >= stallLimit) break;
        }
      }

      const finalEval0 = getBestScoreEvalSoFar() || getBestEvalSoFar();
      try {
        restoreBestSnapshotAndPersist({ finalEval: finalEval0, jointState, systemConfig, configsById, targetConfigIds });
      } catch (_) {}

      restorePreOptimizationGlobalsForUiSync();
      publishLatestSystemConfigForUiSync();

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
          recalculateMeritIfSurfaceRangesValid();
        }
      } catch (_) {}

      try {
        if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.evaluateAndUpdateNow === 'function') {
          window.systemRequirementsEditor.evaluateAndUpdateNow();
        }
      } catch (_) {}

      return {
        ok: true,
        aborted: shouldStopKKT(),
        before: before0,
        best: finalEval0 ? finalEval0.score : best0,
        iterations: completed0,
        variables: 0,
        method: constrainedMethod,
        feasible: finalEval0 ? finalEval0.feasible : true,
        violationScore: finalEval0 ? finalEval0.violationScore : 0,
        softPenalty: finalEval0 ? finalEval0.softPenalty : 0,
        objectiveScore: finalEval0 ? finalEval0.score : best0,
        hardViolations: finalEval0?.hardViolations ?? [],
        softViolations: finalEval0?.softViolations ?? []
      };
    }
    
    try {
      // Map variables to indices
      const varIds = vars.map(v => v.id);
      const initialX = vars.map(v => jointState
        ? Number(getJointCurrentValue(jointState, v.id))
        : Number(v.value) || 0
      );

      // Report start immediately, before heavy initial scoring, so Chrome can paint
      // and avoid "page unresponsive" warnings while initial evaluation is running.
      if (onProgress) {
        try {
          onProgress({
            phase: 'start',
            iter: 0,
            current: Number.NaN,
            best: Number.NaN,
            method: constrainedMethod,
            multiScenario,
            requirementCount: Array.isArray(expandedRequirements) ? expandedRequirements.length : 0,
            feasible: false
          });
        } catch (_) {}
        await nextFrame();
      }

      let initialStateEval = hasHeavyAsyncRequirementOperands ? null : evalStateKKT();
      if (initialStateEval) recordEval(initialStateEval);

      if (catVars.length > 0 && !hasHeavyAsyncRequirementOperands) {
        const sweep = await runCategoricalMaterialSweep({
          activeCfg,
          systemConfig,
          jointState,
          categoricalVars: catVars,
          evalState: evalStateKKT,
          onProgress,
          shouldStop,
          iter: 0,
          multiScenario,
          bestEval: getBestEvalSoFar() || initialStateEval
        });

        if (sweep && sweep.bestEval) {
          recordEval(sweep.bestEval);
          initialStateEval = evalStateKKT();
          recordEval(initialStateEval);
        }
      }

      let initialScore = initialStateEval?.score ?? 1e9;

      // Refresh start phase with actual initial score once available.
      if (onProgress && !hasHeavyAsyncRequirementOperands) {
        try {
          const initialRequirementScore = Number(initialStateEval?.requirementScore);
          const initialProgressScore = Number.isFinite(initialRequirementScore)
            ? initialRequirementScore
            : initialScore;
          onProgress({
            phase: 'start',
            iter: 0,
            current: initialProgressScore,
            best: initialProgressScore,
            method: constrainedMethod,
            multiScenario,
            requirementCount: Array.isArray(expandedRequirements) ? expandedRequirements.length : 0,
            feasible: initialStateEval?.feasible ?? false,
            violationScore: initialStateEval?.violationScore,
            softPenalty: initialStateEval?.softPenalty,
            requirementScore: Number.isFinite(initialRequirementScore) ? initialRequirementScore : Number.NaN
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
          const key = String((entry && typeof entry === 'object' && entry.key) ? entry.key : (fallbackKey ?? '')).trim();
          const blockId = String(parsed.baseId ?? '').split('.')[0];
          const block = Array.isArray(blocks)
            ? blocks.find(candidate => String(candidate?.blockId ?? '') === blockId)
            : null;
          const scaleRaw = Number(opt?.scale ?? opt?.stepScale ?? opt?.stepScaleAbs ?? opt?.stepScaleRel);
          if (!isQconCoefficientVariable(block, key) && Number.isFinite(scaleRaw) && scaleRaw > 0) return scaleRaw;

          const keyScale = defaultScaleForBlockVariable(block, key);
          const scale = Number.isFinite(keyScale) && keyScale > 0 ? keyScale : 1;
          return scale;
        } catch (_) {
          return 1;
        }
      };

      const varBounds = varIds.map(resolveBoundsForVarId);
      const varScales = varIds.map((id, i) => resolveScaleForVarId(id, vars[i]?.key));
      const qconVariableFlags = varIds.map((id, i) => {
        try {
          const parsed = parseJointVariableId(id);
          const cfgId = parsed.configId ? String(parsed.configId) : String(activeConfigId ?? '');
          const blocks = ((jointState && jointState.blocksByConfigId && cfgId)
            ? jointState.blocksByConfigId[cfgId]
            : null) ?? activeCfg?.blocks;
          const blockId = String(parsed.baseId ?? '').split('.')[0];
          const block = Array.isArray(blocks)
            ? blocks.find(candidate => String(candidate?.blockId ?? '') === blockId)
            : null;
          return isQconCoefficientVariable(block, vars[i]?.key);
        } catch (_) {
          return false;
        }
      });
      const qconFamilyScaleByBlock = new Map<string, number>();
      for (let i = 0; i < varIds.length; i++) {
        if (!qconVariableFlags[i]) continue;
        const parsed = parseJointVariableId(varIds[i]);
        const familyKey = `${String(parsed.configId || activeConfigId || '')}|${String(parsed.baseId || '').split('.')[0]}`;
        const coefficientMagnitude = Math.abs(Number(vars[i]?.value ?? initialX[i]) || 0);
        qconFamilyScaleByBlock.set(
          familyKey,
          Math.max(qconFamilyScaleByBlock.get(familyKey) || 0, coefficientMagnitude)
        );
      }
      const trustScales = varScales.map((scale, i) =>
        qconVariableFlags[i]
          ? (() => {
            if (qconInitialStepScale !== null) return qconInitialStepScale;
            const parsed = parseJointVariableId(varIds[i]);
            const familyKey = `${String(parsed.configId || activeConfigId || '')}|${String(parsed.baseId || '').split('.')[0]}`;
            const familyScale = qconFamilyScaleByBlock.get(familyKey) || 0;
            return Math.max(scale, familyScale);
          })()
          : scale
      );
      const clampToBounds = (x: number[]) => x.map((v, i) => {
        const b = varBounds[i];
        if (!b || (!Number.isFinite(b.min ?? NaN) && !Number.isFinite(b.max ?? NaN))) return v;
        if (!Number.isFinite(v)) return v;
        let out = v;
        if (b.min !== null && Number.isFinite(b.min)) out = Math.max(b.min, out);
        if (b.max !== null && Number.isFinite(b.max)) out = Math.min(b.max, out);
        return out;
      });

      const kktEvalCacheMax = Number.isFinite(Number(opts?.kktEvalCacheMax))
        ? Math.max(64, Math.floor(Number(opts.kktEvalCacheMax)))
        : 512;
      const kktEvalCache = new Map<string, any>();
      const kktApproxEvalCacheEnabled = opts?.kktApproxEvalCache !== false;
      const kktApproxEvalCacheMax = Number.isFinite(Number(opts?.kktApproxEvalCacheMax))
        ? Math.max(64, Math.floor(Number(opts.kktApproxEvalCacheMax)))
        : 1024;
      const kktApproxEvalCache = new Map<string, any>();
      const kktApproxEvalStepScale = Number.isFinite(Number(opts?.kktApproxEvalStepScale))
        ? Math.max(1e-6, Math.min(1e-1, Number(opts.kktApproxEvalStepScale)))
        : 1e-3;
      const kktPriorityOperandTopK = Number.isFinite(Number(opts?.kktPriorityOperandTopK))
        ? Math.max(1, Math.floor(Number(opts.kktPriorityOperandTopK)))
        : 12;
      const kktNeighborOperandCacheEnabled = opts?.kktNeighborOperandCache !== false;
      const kktNeighborOperandCacheMax = Number.isFinite(Number(opts?.kktNeighborOperandCacheMax))
        ? Math.max(64, Math.floor(Number(opts.kktNeighborOperandCacheMax)))
        : 2048;
      const kktNeighborOperandCache = new Map<string, number>();
      const kktOperandPriorityScores = new Map<string, number>();
      let kktPriorityOperandKeys = new Set<string>();
      let kktForceFullOperandSweep = true;
      const kktCachePrecision = Number.isFinite(Number(opts?.kktEvalCachePrecision))
        ? Math.max(6, Math.min(16, Math.floor(Number(opts.kktEvalCachePrecision))))
        : ((spotFastMode || kktUseMatrixFreeCore) ? 9 : 12);
      const kktTaCachePrecision = Number.isFinite(Number(opts?.kktTaCachePrecision))
        ? Math.max(3, Math.min(12, Math.floor(Number(opts.kktTaCachePrecision))))
        : ((spotFastMode || kktUseMatrixFreeCore) ? 4 : 6);
      const kktCategoricalSweepInterval = Number.isFinite(Number(opts?.kktCategoricalSweepInterval))
        ? Math.max(1, Math.floor(Number(opts.kktCategoricalSweepInterval)))
        : 3;

      const buildKktXKey = (x: number[]) => {
        const clamped = clampToBounds(x);
        const parts = new Array(clamped.length);
        for (let i = 0; i < clamped.length; i++) {
          const v = Number(clamped[i]);
          parts[i] = Number.isFinite(v) ? v.toExponential(kktCachePrecision) : String(v);
        }
        return parts.join('|');
      };

      const buildKktApproxXKey = (x: number[]) => {
        const clamped = clampToBounds(x);
        const parts = new Array(clamped.length);
        for (let i = 0; i < clamped.length; i++) {
          const value = Number(clamped[i]);
          const scale = Math.max(Math.abs(Number(varScales?.[i]) || 0), 1);
          const quantum = Math.max(1e-9, scale * kktApproxEvalStepScale);
          if (!Number.isFinite(value) || !Number.isFinite(quantum) || quantum <= 0) {
            parts[i] = String(value);
            continue;
          }
          const bucket = Math.round(value / quantum);
          parts[i] = String(bucket);
        }
        return parts.join('|');
      };

      const cloneKktEval = (src: any) => {
        const out = src && typeof src === 'object' ? src : {};
        return {
          objective: Number(out.objective),
          requirementScore: Number(out.requirementScore),
          constraints: Array.isArray(out.constraints) ? out.constraints.slice() : [],
          feasible: !!out.feasible,
          residuals: Array.isArray(out.residuals) ? out.residuals.slice() : []
        };
      };

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
          }
          // Evaluate and return score
          const state = evalCompositeFromRequirementsProfiled();
          const score = state?.score ?? 1e9;
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
              ...p,
              phase: p.phase || 'kkt-iter',
              iter: p.iter ?? 0,
              current: p.current,  // Pass actual current score, not default to initialScore
              best: p.best,        // Pass actual best score
              method: constrainedMethod,
              multiScenario,
              requirementCount: Array.isArray(expandedRequirements) ? expandedRequirements.length : 0,
              feasible: p.feasible ?? false,
              violationScore: p.violationScore,
              softPenalty: p.softPenalty,
              requirementSnapshots: Array.isArray(p.requirementSnapshots) ? p.requirementSnapshots : [],
              dampingFactor: p.dampingFactor ?? p.lmDamp,
              requirementScore: p.requirementScore
            });
          } catch (_) {}
        }
        await nextFrame();
      };

      // Cooperative yield for long KKT CPU loops (especially FD Jacobian loops in Chrome).
      // This prevents "page unresponsive" warnings by returning to the event loop regularly.
      let __lastKktCoopYieldMs = nowMs();
      const maybeYieldKktCpu = async (force = false): Promise<void> => {
        const now = nowMs();
        if (!force && (now - __lastKktCoopYieldMs) < 4) return;
        __lastKktCoopYieldMs = now;
        await nextFrame();
      };

      const withTemporaryMeritSampling = async <T>(samplingOverride: Record<string, any>, callback: () => Promise<T>): Promise<T> => {
        let previousFastMode: any = null;
        let hadFastMode = false;
        try {
          if (typeof globalThis !== 'undefined') {
            hadFastMode = Object.prototype.hasOwnProperty.call(globalThis, '__cooptMeritFastMode');
            previousFastMode = (globalThis as any).__cooptMeritFastMode;
            const baseMode = (previousFastMode && typeof previousFastMode === 'object') ? previousFastMode : {};
            (globalThis as any).__cooptMeritFastMode = {
              ...baseMode,
              ...samplingOverride,
            };
          }
        } catch (_) {}
        try {
          return await callback();
        } finally {
          try {
            if (typeof globalThis === 'undefined') return;
            if (hadFastMode) {
              (globalThis as any).__cooptMeritFastMode = previousFastMode;
            } else {
              delete (globalThis as any).__cooptMeritFastMode;
            }
          } catch (_) {}
        }
      };

      const evalSQPAtXStrict = async (x: number[]): Promise<any> => {
        return withTemporaryMeritSampling(
          {
            enabled: true,
            spotRayCount: kktStrictSpotRayCount,
            spotAnnularRingCount: activeSpotAnnularRingCount(),
            mtfSamplingSize: kktStrictMtfSamplingSize,
            spotEarlyAbortEnabled: false,
            spotEarlyAbortMaxHits: 0,
            spotEarlyAbortStreakMaxHits: 0,
          },
          () => evalSQPAtXUncached(x, null, { forceFullOperandEval: true, priorityOperandKeys: null }),
        );
      };

      const evalSQPAtXUncached = async (
        x: number[],
        seededOperandValues: Map<string, number> | null = null,
        evalPolicy: { forceFullOperandEval?: boolean; priorityOperandKeys?: Set<string> | null } | null = null,
      ) => {
        const editor = (typeof window !== 'undefined') ? window.meritFunctionEditor : null;
        if (!editor || typeof editor.calculateOperandValue !== 'function') {
          return { objective: 1e9, requirementScore: 1e3, constraints: [], feasible: false, residuals: [] };
        }

        const xClamped = clampToBounds(x);
        const saved = vars.map(v => jointState
          ? Number(getJointCurrentValue(jointState, v.id))
          : Number(v.value) || 0
        );
        let __prevTaEvalXKey: any = null;
        let __prevTaEvalXKeyApprox: any = null;

        const prev = getScenarioOverrideGlobal();
        const overrideMap = (prev && typeof prev === 'object') ? { ...prev } : {};
        let __prevRuntimeCache = null;
        const useKktRuntimeCache = opts?.kktRuntimeCache !== false;

        let objective = 0;
        let requirementScore = 0;
        const constraints: number[] = [];
        const residuals: number[] = [];

        try {
          try {
            if (typeof globalThis !== 'undefined') {
              __prevTaEvalXKey = (globalThis as any).__cooptEvalXKey;
              __prevTaEvalXKeyApprox = (globalThis as any).__cooptEvalXKeyApproxTa;
              (globalThis as any).__cooptEvalXKey = buildKktXKey(xClamped);

              const approxParts = new Array(xClamped.length);
              for (let i = 0; i < xClamped.length; i++) {
                const v = Number(xClamped[i]);
                approxParts[i] = Number.isFinite(v) ? v.toExponential(kktTaCachePrecision) : String(v);
              }
              (globalThis as any).__cooptEvalXKeyApproxTa = approxParts.join('|');
            }
          } catch (_) {}

          if (useKktRuntimeCache) {
            try {
              __prevRuntimeCache = (editor && editor._runtimeCache !== undefined) ? editor._runtimeCache : null;
              if (editor) {
                editor._runtimeCache = new Map();
                if (__profile && __profile.counts) {
                  __profile.counts.meritRuntimeCacheEnabled = (Number(__profile.counts.meritRuntimeCacheEnabled) || 0) + 1;
                }
              }
            } catch (_) {
              __prevRuntimeCache = null;
            }
          }

          for (let i = 0; i < varIds.length && i < xClamped.length; i++) {
            const varId = varIds[i];
            const newVal = xClamped[i];
            if (jointState) setJointDesignVariableValue(jointState, varId, newVal);
            else setDesignVariableValue(activeCfg, varId, newVal);
          }

          const items = Array.isArray(residualItems) ? residualItems : [];
          const worstContributionByRequirement = new Map<string, number>();
          const operandValueCache = seededOperandValues instanceof Map
            ? new Map<string, number>(seededOperandValues)
            : new Map<string, number>();
          const forceFullOperandEval = !!evalPolicy?.forceFullOperandEval;
          const priorityOperandKeys = (evalPolicy?.priorityOperandKeys instanceof Set)
            ? evalPolicy.priorityOperandKeys
            : null;
          const hasMtfResidualItems = items.some((item: any) => {
            const requirement = item?.req;
            const operand = String(requirement?.operand ?? '').trim().toUpperCase();
            const weight = Math.max(0, toFiniteNumber(requirement?.weight, 1))
              * Math.max(0, toFiniteNumber(item?.scenarioWeight, 1));
            return !!(requirement?.enabled
              && ['MTFT', 'MTFS', 'MTFA'].includes(operand)
              && String(requirement?.param1 ?? '').trim().toUpperCase() !== 'ALL_WEIGHTED'
              && weight > 0);
          });
          if (hasMtfResidualItems && operandValueCache.size === 0) {
            try {
              const candidateRowsByConfig = buildNativeCandidateRows(xClamped);
              if (candidateRowsByConfig) {
                const mtfSeededValues = await evalMtfOperandValuesNativeBatch([candidateRowsByConfig]);
                const mtfMap = Array.isArray(mtfSeededValues) ? mtfSeededValues[0] : null;
                if (mtfMap instanceof Map && mtfMap.size > 0) {
                  let seededCount = 0;
                  for (const [key, value] of mtfMap) {
                    if (!Number.isFinite(Number(value))) continue;
                    operandValueCache.set(key, Number(value));
                    seededCount++;
                  }
                  if (__profile?.counts) {
                    __profile.counts.kktMtfPrefetchCalls = (Number(__profile.counts.kktMtfPrefetchCalls) || 0) + 1;
                    __profile.counts.kktMtfPrefetchSeededValues = (Number(__profile.counts.kktMtfPrefetchSeededValues) || 0) + seededCount;
                  }
                }
              }
            } catch (_) {
              if (__profile?.counts) {
                __profile.counts.kktMtfPrefetchFailures = (Number(__profile.counts.kktMtfPrefetchFailures) || 0) + 1;
              }
            }
          }
          await prefetchOptimizerAsyncRequirementGroups(editor, items, operandValueCache);
          await prefetchOptimizerSpotRequirementGroups(editor, items, operandValueCache);
          let __evalItemCount = 0;
          for (const it of items) {
            if ((++__evalItemCount & 7) === 0) await maybeYieldKktCpu();
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
              param5: r.param5,
              target: r.target,
              weight: r.weight
            };

            const opCacheKey = optimizerOperandCacheKey(it);
            const canUseNeighborCache = kktNeighborOperandCacheEnabled
              && !forceFullOperandEval
              && priorityOperandKeys instanceof Set
              && !priorityOperandKeys.has(opCacheKey)
              && kktNeighborOperandCache.has(opCacheKey)
              && !operandValueCache.has(opCacheKey);
            let currentRaw = operandValueCache.has(opCacheKey)
              ? operandValueCache.get(opCacheKey)
              : canUseNeighborCache
                ? kktNeighborOperandCache.get(opCacheKey)
                : hasHeavyAsyncRequirementOperands && typeof editor.calculateOperandValueAsync === 'function'
                  ? await editor.calculateOperandValueAsync(opObj)
                  : editor.calculateOperandValue(opObj);
            const s = sanitizeOperandCurrentForScore(currentRaw);
            const requirementKey = String(r.id ?? `${cfgId}|${r.operand}`);
            if (!s.ok || !Number.isFinite(s.current)) {
              const penalty = __INVALID_OPERAND_PENALTY_AMOUNT;
              const contribution = w * penalty;
              worstContributionByRequirement.set(
                requirementKey,
                Math.max(worstContributionByRequirement.get(requirementKey) || 0, contribution)
              );
              const weightedResidual = Math.sqrt(w) * penalty;
              objective += weightedResidual * weightedResidual;
              residuals.push(weightedResidual);
              if (kktRequirementsAsConstraints && (r.op === '<=' || r.op === '>=')) {
                constraints.push(penalty);
              }
              if (kktNeighborOperandCacheEnabled && !canUseNeighborCache && Number.isFinite(Number(currentRaw))) {
                kktNeighborOperandCache.set(opCacheKey, Number(currentRaw));
              }
              continue;
            }

            const current = s.current;
            if (kktNeighborOperandCacheEnabled) {
              kktNeighborOperandCache.set(opCacheKey, current);
            }
            const target = toFiniteNumber(r.target, 0);
            const tol = Math.max(0, toFiniteNumber(r.tol, 0));
            const amount = computeViolationAmount(r.op, current, target, tol);
            const violationAmount = Number.isFinite(amount) ? Math.max(0, amount) : __INVALID_OPERAND_PENALTY_AMOUNT;
            const contribution = w * violationAmount;
            worstContributionByRequirement.set(
              requirementKey,
              Math.max(worstContributionByRequirement.get(requirementKey) || 0, contribution)
            );
            kktOperandPriorityScores.set(
              opCacheKey,
              Math.max(Number(kktOperandPriorityScores.get(opCacheKey)) || 0, contribution)
            );
            const scale = Math.max(1, Math.abs(tol));
            const weightedResidual = Math.sqrt(w) * (violationAmount / scale);
            objective += weightedResidual * weightedResidual;
            residuals.push(weightedResidual);

            // Keep every scoped inequality explicit even though the objective
            // uses the UI's worst scoped value once per Requirement row.
            if (kktRequirementsAsConstraints && r.op === '<=') {
              constraints.push(Math.sqrt(w) * (current - target - tol));
            } else if (kktRequirementsAsConstraints && r.op === '>=') {
              constraints.push(Math.sqrt(w) * ((target - tol) - current));
            }
          }

          for (const contribution of worstContributionByRequirement.values()) {
            requirementScore += contribution;
          }
          while (kktNeighborOperandCache.size > kktNeighborOperandCacheMax) {
            const first = kktNeighborOperandCache.keys().next();
            if (!first || first.done) break;
            kktNeighborOperandCache.delete(first.value);
          }
        } finally {
          try {
            if (typeof globalThis !== 'undefined') {
              if (__prevTaEvalXKey !== undefined) (globalThis as any).__cooptEvalXKey = __prevTaEvalXKey;
              else delete (globalThis as any).__cooptEvalXKey;
              if (__prevTaEvalXKeyApprox !== undefined) (globalThis as any).__cooptEvalXKeyApproxTa = __prevTaEvalXKeyApprox;
              else delete (globalThis as any).__cooptEvalXKeyApproxTa;
            }
          } catch (_) {}

          if (useKktRuntimeCache) {
            try {
              if (editor) editor._runtimeCache = __prevRuntimeCache;
            } catch (_) {}
          }
          setScenarioOverrideGlobal((prev && typeof prev === 'object') ? prev : null);
          for (let i = 0; i < varIds.length && i < saved.length; i++) {
            if (jointState) setJointDesignVariableValue(jointState, varIds[i], saved[i]);
            else setDesignVariableValue(activeCfg, varIds[i], saved[i]);
          }
        }

        const feasible = constraints.every(c => c <= 0);
        return { objective, requirementScore, constraints, feasible, residuals };
      };

      const evalSQPAtX = async (x: number[]) => {
        const key = buildKktXKey(x);
        if (kktEvalCache.has(key)) {
          if (__profile && __profile.counts) {
            __profile.counts.kktEvalCacheHits = (Number(__profile.counts.kktEvalCacheHits) || 0) + 1;
          }
          return cloneKktEval(kktEvalCache.get(key));
        }

        if (kktApproxEvalCacheEnabled) {
          const approxKey = buildKktApproxXKey(x);
          if (kktApproxEvalCache.has(approxKey)) {
            if (__profile && __profile.counts) {
              __profile.counts.kktEvalCacheApproxHits = (Number(__profile.counts.kktEvalCacheApproxHits) || 0) + 1;
            }
            const cached = cloneKktEval(kktApproxEvalCache.get(approxKey));
            if (kktEvalCache.size >= kktEvalCacheMax) {
              const oldest = kktEvalCache.keys().next();
              if (oldest && !oldest.done) kktEvalCache.delete(oldest.value);
            }
            kktEvalCache.set(key, cached);
            return cloneKktEval(cached);
          }
        }

        if (__profile && __profile.counts) {
          __profile.counts.kktEvalCacheMisses = (Number(__profile.counts.kktEvalCacheMisses) || 0) + 1;
        }
        const __evalT0 = (__profile) ? nowMs() : 0;
        const value = await evalSQPAtXUncached(x, null, {
          forceFullOperandEval: kktForceFullOperandSweep,
          priorityOperandKeys: kktPriorityOperandKeys,
        });
        if (__profile) {
          const dt = Math.max(0, nowMs() - __evalT0);
          const buckets = __profile.timingBuckets || (__profile.timingBuckets = { time_objective_eval: 0, time_wasm_call: 0, time_js_overhead: 0 });
          buckets.time_objective_eval = (Number(buckets.time_objective_eval) || 0) + dt;
          if (__profile.counts) __profile.counts.timeObjectiveEvalCalls = (Number(__profile.counts.timeObjectiveEvalCalls) || 0) + 1;
        }
        const storable = cloneKktEval(value);
        if (kktEvalCache.size >= kktEvalCacheMax) {
          const oldest = kktEvalCache.keys().next();
          if (oldest && !oldest.done) kktEvalCache.delete(oldest.value);
        }
        kktEvalCache.set(key, storable);
        if (kktApproxEvalCacheEnabled) {
          const approxKey = buildKktApproxXKey(x);
          if (kktApproxEvalCache.size >= kktApproxEvalCacheMax) {
            const oldest = kktApproxEvalCache.keys().next();
            if (oldest && !oldest.done) kktApproxEvalCache.delete(oldest.value);
          }
          kktApproxEvalCache.set(approxKey, storable);
        }
        return cloneKktEval(storable);
      };

      const kktEvaluationToComposite = (evaluation: any) => {
        const score = Number.isFinite(Number(evaluation?.requirementScore))
          ? Number(evaluation.requirementScore)
          : Number(evaluation?.objective);
        const constraints = Array.isArray(evaluation?.constraints) ? evaluation.constraints : [];
        return {
          score,
          requirementScore: score,
          feasible: evaluation?.feasible !== false,
          violationScore: constraints.reduce((sum, value) => {
            const violation = Math.max(0, Number(value) || 0);
            return sum + violation * violation;
          }, 0),
          softPenalty: 0,
          hardViolations: [],
          softViolations: [],
          requirementSnapshots: []
        };
      };

      if (hasHeavyAsyncRequirementOperands) {
        initialStateEval = kktEvaluationToComposite(await evalSQPAtX(initialX));
        initialScore = initialStateEval.score;
        recordEval(initialStateEval);
        if (onProgress) {
          try {
            onProgress({
              phase: 'start',
              iter: 0,
              current: initialScore,
              best: initialScore,
              method: constrainedMethod,
              multiScenario,
              requirementCount: Array.isArray(expandedRequirements) ? expandedRequirements.length : 0,
              feasible: initialStateEval.feasible,
              violationScore: initialStateEval.violationScore,
              softPenalty: initialStateEval.softPenalty,
              requirementScore: initialScore
            });
          } catch (_) {}
          await nextFrame();
        }
      }

      // Smoothmax function: smooth approximation of Math.max(0, x) for differentiability
      const smoothMax = (val: number, beta: number = 100) => {
        // Prevent overflow: for large val*beta, approximate linearly
        if (val * beta > 20) return val;
        return Math.log(1 + Math.exp(beta * val)) / beta;
      };

      const buildAugmentedResidualsFromBase = (baseEval: any, lambda: number[], penaltyMu: number, maxViol: number) => {
        const residualVector = useKktSqp
          ? (Array.isArray(baseEval?.residuals) ? baseEval.residuals.slice() : [])
          : Array.isArray(baseEval?.residuals) && baseEval.residuals.length > 0
          ? baseEval.residuals.slice()
          : (baseEval?.objective > 0 ? [Math.sqrt(baseEval.objective)] : []);
        const constraints = Array.isArray(baseEval?.constraints) ? baseEval.constraints : [];
        if (useKktSqp) {
          return { base: baseEval, residuals: residualVector.concat(constraints), baseResidualCount: residualVector.length };
        }
        const rConstr = new Array(constraints.length);
        const muScale = Math.sqrt(Math.max(1, penaltyMu));
        const adaptiveBeta = maxViol < 0.01 ? 10 : (maxViol < 0.1 ? 30 : 100);
        for (let i = 0; i < constraints.length; i++) {
          const lambdaI = Math.max(0, Number(lambda?.[i]) || 0);
          const shiftedConstraint = constraints[i] + lambdaI / Math.max(1, penaltyMu);
          rConstr[i] = muScale * smoothMax(shiftedConstraint, adaptiveBeta);
        }
        return { base: baseEval, residuals: residualVector.concat(rConstr) };
      };

      const evalAugmentedResiduals = async (x: number[], lambdaVec: number[], mu: number, maxViolContext: number = 1.0) => {
        const base = await evalSQPAtX(x);
        return buildAugmentedResidualsFromBase(base, lambdaVec, mu, maxViolContext);
      };

      const evaluateSqpFilterMerit = (evaluation: any, penalty: number) => {
        const objectiveResiduals = Array.isArray(evaluation?.residuals) ? evaluation.residuals : [];
        const constraints = Array.isArray(evaluation?.constraints) ? evaluation.constraints : [];
        const objectiveCost = objectiveResiduals.reduce((sum, value) => sum + value * value, 0);
        const violationCost = constraints.reduce((sum, value) => {
          const violation = Math.max(0, Number(value) || 0);
          return sum + violation * violation;
        }, 0);
        return objectiveCost + Math.max(1, penalty) * violationCost;
      };

      const kktUseAnalyticAsphereConstraintJacobian = opts?.kktUseAnalyticAsphereConstraintJacobian !== false;
      const kktRequirementIneqCount = (Array.isArray(residualItems) ? residualItems : []).reduce((acc, it) => {
        if (!kktRequirementsAsConstraints) return acc;
        const req = it?.req;
        if (!req || !req.enabled || !req.operand) return acc;
        const op = String(req.op || '').trim();
        return (op === '<=' || op === '>=') ? (acc + 1) : acc;
      }, 0);

      const buildActiveAsphereMonotonicConstraints = (_xClamped: number[]): Array<{ prevIdx: number; currIdx: number; value: number }> => {
        return [];
      };

      const smoothMaxDerivative = (val: number, beta: number): number => {
        const vb = Number(val) * Number(beta);
        if (!Number.isFinite(vb)) return 0;
        if (vb > 20) return 1;
        if (vb < -20) return 0;
        const e = Math.exp(vb);
        return e / (1 + e);
      };

      const applyAnalyticAsphereConstraintJacobianOverlay = (
        J: number[][],
        x: number[],
        lambdaVec: number[],
        mu: number,
        maxViol: number,
        baseResidualCount: number
      ): number => {
        if (!kktUseAnalyticAsphereConstraintJacobian) return 0;
        if (!(Array.isArray(J) && J.length > 0)) return 0;
        const n = x.length;
        if (!(n > 0)) return 0;

        const active = buildActiveAsphereMonotonicConstraints(x);
        if (!Array.isArray(active) || active.length === 0) return 0;

        const adaptiveBeta = maxViol < 0.01 ? 10 : (maxViol < 0.1 ? 30 : 100);
        const muSafe = Math.max(1e-12, Number(mu) || 0);
        const muScale = Math.sqrt(Math.max(1, Number(mu) || 0));
        const rowOffset = Math.max(0, Number(baseResidualCount) || 0) + Math.max(0, Number(kktRequirementIneqCount) || 0);

        let touched = 0;
        for (let q = 0; q < active.length; q++) {
          const row = rowOffset + q;
          if (!(row >= 0 && row < J.length)) continue;
          const item = active[q];
          const prevIdx = item.prevIdx;
          const currIdx = item.currIdx;
          if (!(prevIdx >= 0 && prevIdx < n && currIdx >= 0 && currIdx < n)) continue;

          const li = Number(lambdaVec?.[Math.max(0, Number(kktRequirementIneqCount) || 0) + q]) || 0;
          const adj = item.value + li / muSafe;
          const dsmooth = smoothMaxDerivative(adj, adaptiveBeta);
          const common = muScale * dsmooth;
          const dcdPrev = -28.8 * (Number(x[prevIdx]) || 0);
          const dcdCurr = 20 * (Number(x[currIdx]) || 0);

          J[row][prevIdx] = Number.isFinite(common * dcdPrev) ? (common * dcdPrev) : 0;
          J[row][currIdx] = Number.isFinite(common * dcdCurr) ? (common * dcdCurr) : 0;
          touched++;
        }
        return touched;
      };

      const kktUseAnalyticEqualityCtctJacobian = opts?.kktUseAnalyticEqualityCtctJacobian === true;
      const kktAnalyticEqCalibrationMaxCandidates = Number.isFinite(Number(opts?.kktAnalyticEqCalibrationMaxCandidates))
        ? Math.max(4, Math.floor(Number(opts.kktAnalyticEqCalibrationMaxCandidates)))
        : 24;
      const kktAnalyticEqMinAbsSlope = Number.isFinite(Number(opts?.kktAnalyticEqMinAbsSlope))
        ? Math.max(1e-14, Number(opts.kktAnalyticEqMinAbsSlope))
        : 1e-10;
      const equalityResidualMeta: Array<{ rowIndex: number; configId: string; req: any }> = [];
      {
        const items = Array.isArray(residualItems) ? residualItems : [];
        for (const it of items) {
          const req = it?.req;
          if (!req || !req.enabled || !req.operand) continue;
          if (String(req.op || '').trim() !== '=') continue;
          equalityResidualMeta.push({
            rowIndex: equalityResidualMeta.length,
            configId: String(it?.configId ?? req.configId ?? ''),
            req
          });
        }
      }
      let analyticEqualityRowSpecs: Array<{ rowIndex: number; terms: Array<{ varIdx: number; slope: number }> }> = [];
      let analyticEqualityCalibrated = false;

      const collectThicknessVariableIndexesForConfig = (cfgId: string): number[] => {
        const out: number[] = [];
        for (let vi = 0; vi < varIds.length; vi++) {
          const parsed = parseJointVariableId(varIds[vi]);
          const varCfg = String(parsed.configId || activeConfigId || '');
          const key = String(vars?.[vi]?.key || parsed.baseId || '').toLowerCase();
          if (cfgId && varCfg && cfgId !== varCfg) continue;
          if (!key.includes('thickness')) continue;
          out.push(vi);
        }
        return out;
      };

      const buildAnalyticEqualityTermsForRequirement = (req: any, cfgId: string): Array<{ varIdx: number; slope: number }> => {
        const operand = String(req?.operand || '').trim().toUpperCase();
        const tol = Math.max(0, toFiniteNumber(req?.tol, 0));
        const scale = Math.max(1, Math.abs(tol));
        const weight = Math.max(0, toFiniteNumber(req?.weight, 1));
        if (!(weight > 0)) return [];
        const slopeUnit = Math.sqrt(weight) / scale;
        if (!Number.isFinite(slopeUnit) || slopeUnit === 0) return [];

        if (operand === 'TSL') {
          return collectThicknessVariableIndexesForConfig(cfgId).map((varIdx) => ({ varIdx, slope: slopeUnit }));
        }

        return [];
      };

      const applyAnalyticEqualityCtctJacobianOverlay = (
        J: number[][],
        n: number,
        baseResidualCount: number
      ): number => {
        if (!kktUseAnalyticEqualityCtctJacobian) return 0;
        if (!Array.isArray(analyticEqualityRowSpecs) || analyticEqualityRowSpecs.length === 0) return 0;
        const rowCap = Math.max(0, Math.min(baseResidualCount, J.length));
        let touched = 0;
        for (const spec of analyticEqualityRowSpecs) {
          const row = Number(spec?.rowIndex);
          if (!(row >= 0 && row < rowCap)) continue;
          const terms = Array.isArray(spec?.terms) ? spec.terms : [];
          if (terms.length === 0) continue;
          for (let j = 0; j < n; j++) J[row][j] = 0;
          let rowTouched = false;
          for (const term of terms) {
            const col = Number(term?.varIdx);
            const slope = Number(term?.slope);
            if (!(col >= 0 && col < n)) continue;
            if (!Number.isFinite(slope)) continue;
            J[row][col] = slope;
            rowTouched = true;
          }
          if (!rowTouched) continue;
          touched++;
        }
        return touched;
      };

      const kktUseSparseFdGrouping = opts?.kktUseSparseFdGrouping !== false;
      const kktFdSupportThreshold = Number.isFinite(Number(opts?.kktFdSupportThreshold))
        ? Math.max(0, Number(opts.kktFdSupportThreshold))
        : 1e-10;
      const kktFdGroupingMaxCols = Number.isFinite(Number(opts?.kktFdGroupingMaxCols))
        ? Math.max(1, Math.floor(Number(opts.kktFdGroupingMaxCols)))
        : 8;
      let jacobianColumnSupports: number[][] | null = null;

      const buildSupportsFromJacobian = (J: number[][], rowCount: number, colCount: number, threshold: number): number[][] => {
        const supports: number[][] = Array.from({ length: colCount }, () => []);
        const t = Math.max(0, Number(threshold) || 0);
        for (let col = 0; col < colCount; col++) {
          const rows: number[] = [];
          for (let row = 0; row < rowCount; row++) {
            const value = Math.abs(Number(J?.[row]?.[col]) || 0);
            if (value > t) rows.push(row);
          }
          supports[col] = rows;
        }
        return supports;
      };

      const updateSupportsForColumns = (J: number[][], rowCount: number, columns: number[], threshold: number): void => {
        if (!Array.isArray(jacobianColumnSupports)) return;
        const t = Math.max(0, Number(threshold) || 0);
        for (const col of columns) {
          if (!(col >= 0 && col < jacobianColumnSupports.length)) continue;
          const rows: number[] = [];
          for (let row = 0; row < rowCount; row++) {
            const value = Math.abs(Number(J?.[row]?.[col]) || 0);
            if (value > t) rows.push(row);
          }
          jacobianColumnSupports[col] = rows;
        }
      };

      const buildDisjointColumnGroups = (columns: number[], supports: number[][], maxGroupCols: number): number[][] => {
        const groups: number[][] = [];
        const sorted = (Array.isArray(columns) ? columns.slice() : [])
          .filter((col) => Number.isFinite(col))
          .map((col) => Math.max(0, Math.floor(Number(col))))
          .sort((a, b) => a - b);
        const maxCols = Math.max(1, Math.floor(Number(maxGroupCols) || 1));

        for (const col of sorted) {
          const supportRows = Array.isArray(supports?.[col]) ? supports[col] : [];
          if (supportRows.length === 0) {
            groups.push([col]);
            continue;
          }
          let placed = false;
          for (const group of groups) {
            if (!Array.isArray(group) || group.length >= maxCols) continue;
            let conflict = false;
            for (const existingCol of group) {
              const existingRows = Array.isArray(supports?.[existingCol]) ? supports[existingCol] : [];
              if (existingRows.length === 0) {
                conflict = true;
                break;
              }
              const small = supportRows.length <= existingRows.length ? supportRows : existingRows;
              const largeSet = new Set(supportRows.length <= existingRows.length ? existingRows : supportRows);
              for (const row of small) {
                if (largeSet.has(row)) {
                  conflict = true;
                  break;
                }
              }
              if (conflict) break;
            }
            if (!conflict) {
              group.push(col);
              placed = true;
              break;
            }
          }
          if (!placed) groups.push([col]);
        }
        return groups;
      };

      const collectAnalyticEqualityVariableIndexes = (nVars: number): Set<number> => {
        const out = new Set<number>();
        const specs = Array.isArray(analyticEqualityRowSpecs) ? analyticEqualityRowSpecs : [];
        for (const spec of specs) {
          const terms = Array.isArray(spec?.terms) ? spec.terms : [];
          for (const term of terms) {
            const col = Number(term?.varIdx);
            if (Number.isFinite(col) && col >= 0 && col < nVars) {
              out.add(Math.floor(col));
            }
          }
        }
        return out;
      };

      const kktNativeBatchFdEnabled = opts?.kktUseNativeBatchFd !== false
        && useKktSqp
        && isTauriRuntime();
      const nativeBatchResidualItems = Array.isArray(residualItems)
        ? residualItems.filter((item: any) => {
            const requirement = item?.req;
            const weight = Math.max(0, toFiniteNumber(requirement?.weight, 1))
              * Math.max(0, toFiniteNumber(item?.scenarioWeight, 1));
            return !!(requirement?.enabled
              && isNativeOptimizerRequirementOperand(requirement?.operand)
              && weight > 0);
          })
        : [];
      const nativeBatchCoversAllResidualItems = nativeBatchResidualItems.length === residualItems.length;
      const nativeBatchRequirementRows = nativeBatchResidualItems.map((item: any) => {
        const requirement = item.req;
        return {
          id: requirement.id,
          configId: String(requirement.configId ?? activeConfigId ?? ''),
          enabled: true,
          operand: requirement.operand,
          op: requirement.op,
          target: requirement.target,
          tol: requirement.tol,
          weight: requirement.weight,
          param1: requirement.param1,
          param2: requirement.param2,
          param3: requirement.param3,
          param4: requirement.param4,
          param5: requirement.param5,
        };
      });
      const nativeBatchSourceRows = (() => {
        if (Array.isArray(opts?.sourceRows)) return opts.sourceRows;
        try {
          const rows = (window as any)?.tableSource?.getData?.();
          return Array.isArray(rows) ? rows : [];
        } catch (_) {
          return [];
        }
      })();
      const nativeBatchObjectRows = (() => {
        if (Array.isArray(opts?.objectRows)) return opts.objectRows;
        try {
          const rows = (window as any)?.tableObject?.getData?.();
          return Array.isArray(rows) ? rows : [];
        } catch (_) {
          return [];
        }
      })();
      const resolveScenarioTablesForConfig = (
        configIdRaw: any,
        scenarioIdRaw: any,
      ): { sourceRows: any[]; objectRows: any[] } => {
        const configId = String(configIdRaw ?? '');
        const editor = (typeof window !== 'undefined') ? (window as any).meritFunctionEditor : null;
        if (!editor || typeof editor.getConfigTablesByConfigId !== 'function') {
          return {
            sourceRows: nativeBatchSourceRows,
            objectRows: nativeBatchObjectRows,
          };
        }

        const prev = getScenarioOverrideGlobal();
        const overrideMap = (prev && typeof prev === 'object') ? { ...prev } : {};
        try {
          if (scenarioIdRaw) overrideMap[configId] = String(scenarioIdRaw);
          else delete overrideMap[configId];
          setScenarioOverrideGlobal(overrideMap);
          const tables = editor.getConfigTablesByConfigId(configId) || {};
          return {
            sourceRows: Array.isArray(tables.source) ? tables.source : nativeBatchSourceRows,
            objectRows: Array.isArray(tables.object) ? tables.object : nativeBatchObjectRows,
          };
        } catch (_) {
          return {
            sourceRows: nativeBatchSourceRows,
            objectRows: nativeBatchObjectRows,
          };
        } finally {
          setScenarioOverrideGlobal((prev && typeof prev === 'object') ? prev : null);
        }
      };
      let nativeBatchFdParityStatus: 'unchecked' | 'passed' | 'failed' = 'unchecked';
      const nativeBatchEvaluatorSessionId = `kkt-candidates-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      let nativeBatchBaseRowsByConfig: Record<string, any[]> | null = null;
      let nativeBatchSessionInitialized = false;
      let nativeBatchVariableBindings: Array<{
        variableIndex: number;
        configId: string;
        rowIndex: number;
        fieldKey: string;
        inputBaseline: number;
        outputBaseline: number;
        slope: number;
      }> | null | undefined;

      const buildNativeCandidateRows = (candidateX: number[]): Record<string, any[]> | null => {
        try {
          const candidateBlocksByConfigId = snapshotBlocksByConfigId(blocksByConfigId);
          const candidateState = {
            blocksByConfigId: candidateBlocksByConfigId,
            targetConfigIds,
            activeConfigId,
          };
          for (let index = 0; index < varIds.length && index < candidateX.length; index++) {
            setJointDesignVariableValue(candidateState, varIds[index], candidateX[index]);
          }
          const rowsByConfig: Record<string, any[]> = {};
          for (const configId of targetConfigIds) {
            const configBlocks = candidateBlocksByConfigId[String(configId)];
            const expanded = expandBlocksForOptimization(configBlocks);
            if (!Array.isArray(expanded?.rows)) return null;
            rowsByConfig[String(configId)] = expanded.rows;
          }
          return rowsByConfig;
        } catch (_) {
          return null;
        }
      };

      const buildNativeCandidateDeltas = (
        baseRowsByConfig: Record<string, any[]>,
        candidateRowsByConfig: Record<string, any[]>,
      ): Array<{ configId: string; rowIndex: number; fieldKey: string; remove?: boolean; value: any }> | null => {
        const updates: Array<{ configId: string; rowIndex: number; fieldKey: string; remove?: boolean; value: any }> = [];
        for (const configId of targetConfigIds) {
          const key = String(configId);
          const baseRows = baseRowsByConfig[key];
          const candidateRows = candidateRowsByConfig[key];
          if (!Array.isArray(baseRows) || !Array.isArray(candidateRows) || baseRows.length !== candidateRows.length) {
            return null;
          }
          for (let rowIndex = 0; rowIndex < baseRows.length; rowIndex++) {
            const baseRow = baseRows[rowIndex];
            const candidateRow = candidateRows[rowIndex];
            if (!baseRow || typeof baseRow !== 'object' || !candidateRow || typeof candidateRow !== 'object') {
              if (JSON.stringify(baseRow) !== JSON.stringify(candidateRow)) return null;
              continue;
            }
            const fieldKeys = new Set([...Object.keys(baseRow), ...Object.keys(candidateRow)]);
            for (const fieldKey of fieldKeys) {
              const baseHasField = Object.prototype.hasOwnProperty.call(baseRow, fieldKey);
              const candidateHasField = Object.prototype.hasOwnProperty.call(candidateRow, fieldKey);
              const baseValue = baseRow[fieldKey];
              const candidateValue = candidateRow[fieldKey];
              if (baseHasField === candidateHasField
                && (Object.is(baseValue, candidateValue)
                  || JSON.stringify(baseValue) === JSON.stringify(candidateValue))) {
                continue;
              }
              updates.push({
                configId: key,
                rowIndex,
                fieldKey,
                remove: !candidateHasField,
                value: candidateHasField ? candidateValue : null,
              });
            }
          }
        }
        return updates;
      };

      const calibrateNativeVariableBindings = () => {
        const baselineRows = buildNativeCandidateRows(initialX);
        if (!baselineRows) return null;
        const bindings: Array<{
          variableIndex: number;
          configId: string;
          rowIndex: number;
          fieldKey: string;
          inputBaseline: number;
          outputBaseline: number;
          slope: number;
        }> = [];
        const occupiedCells = new Set<string>();
        for (let variableIndex = 0; variableIndex < initialX.length; variableIndex++) {
          const inputBaseline = Number(initialX[variableIndex]);
          const scale = Math.abs(Number(varScales[variableIndex])) || 1;
          const probeStep = Math.max(1e-7, scale * 1e-4, Math.abs(inputBaseline) * 1e-6);
          const plusX = initialX.slice();
          const minusX = initialX.slice();
          plusX[variableIndex] = inputBaseline + probeStep;
          minusX[variableIndex] = inputBaseline - probeStep;
          const plusRows = buildNativeCandidateRows(plusX);
          const minusRows = buildNativeCandidateRows(minusX);
          if (!plusRows || !minusRows) return null;
          const plusUpdates = buildNativeCandidateDeltas(baselineRows, plusRows);
          const minusUpdates = buildNativeCandidateDeltas(baselineRows, minusRows);
          if (!plusUpdates || !minusUpdates || plusUpdates.length === 0) return null;
          const minusByCell = new Map(minusUpdates.map(update => [
            `${update.configId}|${update.rowIndex}|${update.fieldKey}`,
            update,
          ]));
          if (minusByCell.size !== plusUpdates.length) return null;
          for (const plusUpdate of plusUpdates) {
            const cellKey = `${plusUpdate.configId}|${plusUpdate.rowIndex}|${plusUpdate.fieldKey}`;
            const minusUpdate = minusByCell.get(cellKey);
            const baseValue = baselineRows[plusUpdate.configId]?.[plusUpdate.rowIndex]?.[plusUpdate.fieldKey];
            const outputBaseline = Number(baseValue);
            const plusValue = Number(plusUpdate.value);
            const minusValue = Number(minusUpdate?.value);
            if (plusUpdate.remove || minusUpdate?.remove
              || !Number.isFinite(outputBaseline)
              || !Number.isFinite(plusValue)
              || !Number.isFinite(minusValue)
              || occupiedCells.has(cellKey)) {
              return null;
            }
            const slopePlus = (plusValue - outputBaseline) / probeStep;
            const slopeMinus = (outputBaseline - minusValue) / probeStep;
            const slopeTolerance = 1e-7 * Math.max(1, Math.abs(slopePlus), Math.abs(slopeMinus));
            if (!Number.isFinite(slopePlus)
              || !Number.isFinite(slopeMinus)
              || Math.abs(slopePlus - slopeMinus) > slopeTolerance) {
              return null;
            }
            occupiedCells.add(cellKey);
            bindings.push({
              variableIndex,
              configId: plusUpdate.configId,
              rowIndex: plusUpdate.rowIndex,
              fieldKey: plusUpdate.fieldKey,
              inputBaseline,
              outputBaseline,
              slope: 0.5 * (slopePlus + slopeMinus),
            });
          }
        }
        return { baselineRows, bindings };
      };

      const buildKktEvaluationFromNativeCurrents = (currents: Array<number | null>) => {
        let objective = 0;
        let requirementScore = 0;
        const constraints: number[] = [];
        const residuals: number[] = [];
        const worstContributionByRequirement = new Map<string, number>();

        for (let index = 0; index < nativeBatchResidualItems.length; index++) {
          const item = nativeBatchResidualItems[index];
          const requirement = item.req;
          const weight = Math.max(0, toFiniteNumber(requirement.weight, 1))
            * Math.max(0, toFiniteNumber(item?.scenarioWeight, 1));
          const sanitized = sanitizeOperandCurrentForScore(currents[index]);
          const current = sanitized.ok && Number.isFinite(sanitized.current)
            ? sanitized.current
            : Number.NaN;
          const target = toFiniteNumber(requirement.target, 0);
          const tolerance = Math.max(0, toFiniteNumber(requirement.tol, 0));
          const violationAmount = Number.isFinite(current)
            ? Math.max(0, computeViolationAmount(requirement.op, current, target, tolerance))
            : __INVALID_OPERAND_PENALTY_AMOUNT;
          const requirementKey = String(requirement.id ?? `${String(item?.configId ?? '')}|${requirement.operand}`);
          const contribution = weight * violationAmount;
          worstContributionByRequirement.set(
            requirementKey,
            Math.max(worstContributionByRequirement.get(requirementKey) || 0, contribution),
          );
          const scale = Math.max(1, Math.abs(tolerance));
          const weightedResidual = Math.sqrt(weight) * (violationAmount / scale);
          objective += weightedResidual * weightedResidual;
          residuals.push(weightedResidual);

          if (kktRequirementsAsConstraints && requirement.op === '<=') {
            constraints.push(Number.isFinite(current)
              ? Math.sqrt(weight) * (current - target - tolerance)
              : __INVALID_OPERAND_PENALTY_AMOUNT);
          } else if (kktRequirementsAsConstraints && requirement.op === '>=') {
            constraints.push(Number.isFinite(current)
              ? Math.sqrt(weight) * ((target - tolerance) - current)
              : __INVALID_OPERAND_PENALTY_AMOUNT);
          }
        }
        for (const contribution of worstContributionByRequirement.values()) {
          requirementScore += contribution;
        }
        return {
          objective,
          requirementScore,
          constraints,
          feasible: constraints.every(value => value <= 0),
          residuals,
        };
      };

      const buildNativeOperandValueCache = (currents: Array<number | null>): Map<string, number> | null => {
        if (!Array.isArray(currents) || currents.length !== nativeBatchResidualItems.length) return null;
        const cache = new Map<string, number>();
        for (let index = 0; index < nativeBatchResidualItems.length; index++) {
          const value = Number(currents[index]);
          if (!Number.isFinite(value)) continue;
          cache.set(optimizerOperandCacheKey(nativeBatchResidualItems[index]), value);
        }
        return cache.size > 0 ? cache : null;
      };

      const evalMtfOperandValuesNativeBatch = async (
        candidateRows: Array<Record<string, any[]>>,
      ): Promise<Array<Map<string, number>> | null> => {
        const editor = (typeof window !== 'undefined') ? (window as any).meritFunctionEditor : null;
        if (!editor || typeof editor.getConfigTablesByConfigId !== 'function') {
          if (__profile?.counts) {
            __profile.counts.kktMtfBatchMissingEditor = (Number(__profile.counts.kktMtfBatchMissingEditor) || 0) + 1;
          }
          return null;
        }
        const mtfItems = (Array.isArray(residualItems) ? residualItems : []).filter((item: any) => {
          const requirement = item?.req;
          const operand = String(requirement?.operand ?? '').trim().toUpperCase();
          const weight = Math.max(0, toFiniteNumber(requirement?.weight, 1))
            * Math.max(0, toFiniteNumber(item?.scenarioWeight, 1));
          return !!(requirement?.enabled
            && ['MTFT', 'MTFS', 'MTFA'].includes(operand)
            && String(requirement?.param1 ?? '').trim().toUpperCase() !== 'ALL_WEIGHTED'
            && weight > 0);
        });
        if (mtfItems.length === 0 || candidateRows.length === 0) {
          if (__profile?.counts) {
            __profile.counts.kktMtfBatchNoEligibleItems = (Number(__profile.counts.kktMtfBatchNoEligibleItems) || 0) + 1;
          }
          return null;
        }

        const groups = new Map<string, any>();
        for (const item of mtfItems) {
          const requirement = item.req;
          const configId = String(item?.configId ?? requirement?.configId ?? activeConfigId ?? '');
          const scenarioId = item?.scenarioId ? String(item.scenarioId) : null;
          const { sourceRows, objectRows } = resolveScenarioTablesForConfig(configId, scenarioId);
          const wavelength = Number(editor.getSystemWavelengthFromOperandOrPrimary?.(requirement, sourceRows));
          const objectIndex = Math.max(0, Math.floor(Number(requirement?.param2 || 1)) - 1);
          const frequency = Math.max(0, Number(requirement?.param4) || 10);
          const requestedSampling = Math.floor(Number(requirement?.param5) || 32);
          const samplingOptions = new Set([16, 32, 64, 128, 256, 512, 1024, 2048, 4096]);
          const configuredSampling = samplingOptions.has(requestedSampling) ? requestedSampling : 32;
          const meritFast = (typeof globalThis !== 'undefined' && (globalThis as any).__cooptMeritFastMode) || null;
          const fastSampling = Math.floor(Number(meritFast?.mtfSamplingSize));
          const sampling = meritFast?.enabled === true && samplingOptions.has(fastSampling)
            ? Math.max(16, fastSampling)
            : Math.max(16, configuredSampling);
          if (!(Number.isFinite(wavelength) && wavelength > 0) || !objectRows[objectIndex]) {
            if (__profile?.counts) {
              __profile.counts.kktMtfBatchInvalidGroupInputs = (Number(__profile.counts.kktMtfBatchInvalidGroupInputs) || 0) + 1;
              if (!Array.isArray(__profile.mtfBatchInvalidGroupInputs)) __profile.mtfBatchInvalidGroupInputs = [];
              __profile.mtfBatchInvalidGroupInputs.push({
                configId,
                param1: requirement?.param1,
                param2: requirement?.param2,
                wavelength,
                sourceCount: sourceRows.length,
                objectIndex,
                objectCount: objectRows.length,
              });
            }
            continue;
          }
          const groupKey = [configId, scenarioId || '', wavelength, objectIndex, sampling].join('|');
          const group = groups.get(groupKey) || {
            configId,
            scenarioId,
            wavelength,
            objectIndex,
            sampling,
            sourceRows,
            objectRows,
            items: [],
            frequencies: new Set<number>(),
            itemFrequencies: [] as Array<{ item: any; frequency: number }>,
          };
          group.items.push(item);
          group.frequencies.add(frequency);
          group.itemFrequencies.push({ item, frequency });
          groups.set(groupKey, group);
        }
        if (groups.size === 0) {
          if (__profile?.counts) {
            __profile.counts.kktMtfBatchEmptyGroups = (Number(__profile.counts.kktMtfBatchEmptyGroups) || 0) + 1;
          }
          return null;
        }

        const jobs: any[] = [];
        for (let candidateIndex = 0; candidateIndex < candidateRows.length; candidateIndex++) {
          for (const [groupKey, group] of groups) {
            const rows = candidateRows[candidateIndex]?.[group.configId];
            if (!Array.isArray(rows) || rows.length === 0) {
              if (__profile?.counts) {
                __profile.counts.kktMtfBatchMissingCandidateRows = (Number(__profile.counts.kktMtfBatchMissingCandidateRows) || 0) + 1;
              }
              continue;
            }
            const objectRow = group.objectRows[group.objectIndex] || {};
            const position = String(objectRow?.position ?? objectRow?.object ?? '').toLowerCase();
            const isAngle = /\bangle\b/.test(position);
            let fieldX = Number(isAngle
              ? (objectRow?.xHeightAngle ?? objectRow?.x ?? 0)
              : (objectRow?.x ?? objectRow?.xHeight ?? objectRow?.xHeightAngle ?? 0));
            let fieldY = Number(isAngle
              ? (objectRow?.yHeightAngle ?? objectRow?.y ?? 0)
              : (objectRow?.y ?? objectRow?.yHeight ?? objectRow?.yHeightAngle ?? 0));
            if (!Number.isFinite(fieldX)) fieldX = 0;
            if (!Number.isFinite(fieldY)) fieldY = 0;
            const fieldNorm = Math.hypot(fieldX, fieldY);
            const tangentialDir = fieldNorm > 1e-12
              ? { x: fieldX / fieldNorm, y: fieldY / fieldNorm }
              : { x: 1, y: 0 };
            const diffraction = calculateImageSpaceDiffractionParams(rows, group.wavelength);
            const fNumber = Number(diffraction?.fNumberWorking);
            if (!(Number.isFinite(fNumber) && fNumber > 0)) {
              if (__profile?.counts) {
                __profile.counts.kktMtfBatchInvalidFNumber = (Number(__profile.counts.kktMtfBatchInvalidFNumber) || 0) + 1;
              }
              continue;
            }
            const sampleFrequencies = Array.from(group.frequencies)
              .map((value: number) => Number(value))
              .filter((value: number) => Number.isFinite(value) && value >= 0)
              .sort((lhs: number, rhs: number) => lhs - rhs);
            if (sampleFrequencies.length === 0) {
              if (__profile?.counts) {
                __profile.counts.kktMtfBatchEmptySampleFrequencies = (Number(__profile.counts.kktMtfBatchEmptySampleFrequencies) || 0) + 1;
              }
              continue;
            }
            if (!Array.isArray(group.sampleFrequencyKeys) || !(group.frequencyToIndex instanceof Map)) {
              group.sampleFrequencyKeys = sampleFrequencies.map((value: number) => value.toFixed(9));
              group.frequencyToIndex = new Map<string, number>();
              for (let sampleIndex = 0; sampleIndex < group.sampleFrequencyKeys.length; sampleIndex++) {
                group.frequencyToIndex.set(group.sampleFrequencyKeys[sampleIndex], sampleIndex);
              }
              group.itemFrequencyKeys = group.itemFrequencies.map((entry: { frequency: number }) => Number(entry.frequency).toFixed(9));
            }
            jobs.push({
              opdRequest: {
                opticalSystemRows: rows,
                sourceRows: group.sourceRows,
                objectRows: group.objectRows,
                objectIndex: group.objectIndex,
                gridSize: group.sampling,
                wavelengthUm: group.wavelength,
                pupilSamplingMode: isAngle && fieldNorm > 1e-12 ? 'entrance' : undefined,
                opdDisplayMode: 'pistonTiltRemoved',
              },
              wavelengthUm: group.wavelength,
              fNumber,
              pupilRange: 1,
              maxFrequencyLpmm: sampleFrequencies[sampleFrequencies.length - 1],
              points: Math.max(2, sampleFrequencies.length),
              sampleFrequenciesLpmm: sampleFrequencies,
              directEvalOnly: true,
              slimResults: true,
              method: 'malacara-wasm-required',
              tangentialDir,
              sagittalDir: { x: -tangentialDir.y, y: tangentialDir.x },
              meta: { candidateIndex, groupKey, onAxis: fieldNorm <= 1e-12, sampleFrequencyKeys: group.sampleFrequencyKeys },
            });
          }
        }
        if (jobs.length === 0) {
          if (__profile?.counts) {
            __profile.counts.kktMtfBatchEmptyJobs = (Number(__profile.counts.kktMtfBatchEmptyJobs) || 0) + 1;
          }
          return null;
        }

        const mtfBatchStartedAt = nowMs();
        if (__profile?.counts) {
          __profile.counts.kktMtfBatchCalls = (Number(__profile.counts.kktMtfBatchCalls) || 0) + 1;
          __profile.counts.kktMtfBatchJobs = (Number(__profile.counts.kktMtfBatchJobs) || 0) + jobs.length;
        }
        let response: any;
        try {
          response = await runMtfBatchViaWasm({ jobs });
        } catch (error) {
          if (__profile?.counts) {
            __profile.counts.kktMtfBatchFailures = (Number(__profile.counts.kktMtfBatchFailures) || 0) + 1;
            __profile.counts.kktMtfBatchMs = (Number(__profile.counts.kktMtfBatchMs) || 0) + (nowMs() - mtfBatchStartedAt);
          }
          throw error;
        }
        if (__profile?.counts) {
          __profile.counts.kktMtfBatchMs = (Number(__profile.counts.kktMtfBatchMs) || 0) + (nowMs() - mtfBatchStartedAt);
          if (String(response?.backend ?? '').toLowerCase().includes('rayon')) {
            __profile.counts.kktMtfBatchRayonCalls = (Number(__profile.counts.kktMtfBatchRayonCalls) || 0) + 1;
          }
        }
        const results = Array.isArray(response?.results) ? response.results : [];
        if (results.length !== jobs.length) return null;
        const seeded = candidateRows.map(() => new Map<string, number>());
        for (const result of results) {
          const meta = result?.meta || {};
          const candidateIndex = Number(meta.candidateIndex);
          const group = groups.get(String(meta.groupKey ?? ''));
          if (!Number.isInteger(candidateIndex) || !seeded[candidateIndex] || !group) continue;
          const mtf = result?.mtf || {};
          const tangentialSamples = Array.isArray(mtf?.sampledMtfTangential) ? mtf.sampledMtfTangential : [];
          const sagittalSamples = Array.isArray(mtf?.sampledMtfSagittal) ? mtf.sampledMtfSagittal : [];
          const sampleFrequencyKeys = Array.isArray(meta?.sampleFrequencyKeys)
            ? meta.sampleFrequencyKeys.map((value: any) => String(value))
            : [];
          if (sampleFrequencyKeys.length === 0) {
            continue;
          }
          const frequencyToIndex = (group.frequencyToIndex instanceof Map)
            ? group.frequencyToIndex
            : new Map<string, number>(sampleFrequencyKeys.map((key: string, index: number) => [key, index]));
          for (let entryIndex = 0; entryIndex < group.itemFrequencies.length; entryIndex++) {
            const entry = group.itemFrequencies[entryIndex];
            const item = entry.item;
            const frequencyKey = Array.isArray(group.itemFrequencyKeys)
              ? String(group.itemFrequencyKeys[entryIndex])
              : Number(entry.frequency).toFixed(9);
            const sampleIndex = Number(frequencyToIndex.get(frequencyKey));
            if (!Number.isInteger(sampleIndex) || sampleIndex < 0) continue;
            let tangential = Number(tangentialSamples[sampleIndex]);
            let sagittal = Number(sagittalSamples[sampleIndex]);
            if (meta.onAxis === true && Number.isFinite(tangential) && Number.isFinite(sagittal)) {
              tangential = sagittal = Math.max(0, Math.min(1, 0.5 * (tangential + sagittal)));
            }
            const operand = String(item?.req?.operand ?? '').trim().toUpperCase();
            const value = operand === 'MTFT'
              ? tangential
              : operand === 'MTFS'
                ? sagittal
                : (Number.isFinite(tangential) && Number.isFinite(sagittal)
                  ? 0.5 * (tangential + sagittal)
                  : Number.isFinite(tangential) ? tangential : sagittal);
            if (Number.isFinite(value)) seeded[candidateIndex].set(optimizerOperandCacheKey(item), value);
          }
        }
        return seeded;
      };

      const evalAugmentedResidualsNativeBatch = async (
        candidatePoints: number[][],
        lambdaVec: number[],
        penaltyMu: number,
        maxViolContext: number,
        onBaseEvalBatch?: ((baseEvals: any[]) => void) | null,
      ): Promise<number[][] | null> => {
        const hasMtfResidualItems = (Array.isArray(residualItems) ? residualItems : [])
          .some((item: any) => ['MTFT', 'MTFS', 'MTFA'].includes(String(item?.req?.operand ?? '').trim().toUpperCase()));

        const evalAugmentedResidualsWebBatch = async (): Promise<number[][] | null> => {
          if (kktNativeBatchFdEnabled) return null;
          if (candidatePoints.length < 2) return null;
          if (!hasMtfResidualItems) return null;

          const webBatchStartedAt = nowMs();
          const candidateRows = candidatePoints.map(buildNativeCandidateRows).filter(Boolean) as Array<Record<string, any[]>>;
          if (candidateRows.length !== candidatePoints.length) return null;

          const mtfSeededValues = await evalMtfOperandValuesNativeBatch(candidateRows);
          if (!Array.isArray(mtfSeededValues) || mtfSeededValues.length !== candidatePoints.length) return null;

          const toAugmentedResiduals = (baseEval: any): number[] => {
            const residualVector = useKktSqp
              ? (Array.isArray(baseEval?.residuals) ? baseEval.residuals.slice() : [])
              : Array.isArray(baseEval?.residuals) && baseEval.residuals.length > 0
              ? baseEval.residuals.slice()
              : (baseEval?.objective > 0 ? [Math.sqrt(baseEval.objective)] : []);
            const constraints = Array.isArray(baseEval?.constraints) ? baseEval.constraints : [];
            if (useKktSqp) return residualVector.concat(constraints);
            const rConstr = new Array(constraints.length);
            const muScale = Math.sqrt(Math.max(1, penaltyMu));
            const adaptiveBeta = maxViolContext < 0.01 ? 10 : (maxViolContext < 0.1 ? 30 : 100);
            for (let i = 0; i < constraints.length; i++) {
              const lambda = Math.max(0, Number(lambdaVec?.[i]) || 0);
              const shiftedConstraint = constraints[i] + lambda / Math.max(1, penaltyMu);
              rConstr[i] = muScale * smoothMax(shiftedConstraint, adaptiveBeta);
            }
            return residualVector.concat(rConstr);
          };

          const residuals: number[][] = [];
          const baseEvals: any[] = [];
          for (let candidateIndex = 0; candidateIndex < candidatePoints.length; candidateIndex++) {
            const seededValues = (mtfSeededValues[candidateIndex] instanceof Map)
              ? mtfSeededValues[candidateIndex]
              : null;
            const baseEval = await evalSQPAtXUncached(
              candidatePoints[candidateIndex],
              seededValues && seededValues.size > 0 ? seededValues : null,
              {
                forceFullOperandEval: kktForceFullOperandSweep,
                priorityOperandKeys: kktPriorityOperandKeys,
              },
            );
            baseEvals.push(baseEval);
            residuals.push(toAugmentedResiduals(baseEval));
          }

          if (typeof onBaseEvalBatch === 'function') {
            onBaseEvalBatch(baseEvals);
          }

          if (__profile?.counts) {
            __profile.counts.kktWebBatchFdCalls = (Number(__profile.counts.kktWebBatchFdCalls) || 0) + 1;
            __profile.counts.kktWebBatchFdCandidates = (Number(__profile.counts.kktWebBatchFdCandidates) || 0) + candidatePoints.length;
            __profile.counts.kktWebBatchFdMs = (Number(__profile.counts.kktWebBatchFdMs) || 0) + (nowMs() - webBatchStartedAt);
          }

          return residuals;
        };

        if (!kktNativeBatchFdEnabled) {
          return evalAugmentedResidualsWebBatch();
        }

        if (!kktNativeBatchFdEnabled
          || nativeBatchFdParityStatus === 'failed'
          || candidatePoints.length < 2
          || (nativeBatchRequirementRows.length === 0 && !hasMtfResidualItems)) {
          return null;
        }
        const batchStartedAt = nowMs();
        if (__profile?.counts) {
          __profile.counts.kktNativeBatchFdCalls = (Number(__profile.counts.kktNativeBatchFdCalls) || 0) + 1;
          __profile.counts.kktNativeBatchFdCandidates = (Number(__profile.counts.kktNativeBatchFdCandidates) || 0) + candidatePoints.length;
        }

        const evaluateNativeCurrentsSingleOrScenarioBatches = async (
          useVectorCandidates: boolean,
          candidateDeltas: any[][],
          baseRowsByConfig: Record<string, any[]>,
          hasNativeRequirementRows: boolean,
        ): Promise<any> => {
          if (!hasNativeRequirementRows) {
            return {
              currentsPerCandidate: candidatePoints.map(() => []),
              appliedUpdateCount: 0,
              sessionReused: false,
            };
          }

          if (!multiScenario) {
            return evaluateOptimizerCandidates({
              candidateDeltas: useVectorCandidates ? undefined : candidateDeltas,
              candidateVectors: useVectorCandidates ? candidatePoints : undefined,
              variableBindings: initializeNativeSession && useVectorCandidates
                ? nativeBatchVariableBindings as any[]
                : undefined,
              sessionId: nativeBatchEvaluatorSessionId,
              resetSession: initializeNativeSession,
              baseRowsByConfig: initializeNativeSession ? baseRowsByConfig : undefined,
              sourceRows: initializeNativeSession ? nativeBatchSourceRows : undefined,
              objectRows: initializeNativeSession ? nativeBatchObjectRows : undefined,
              systemRequirementsRows: initializeNativeSession ? nativeBatchRequirementRows : undefined,
              activeConfigId: initializeNativeSession ? String(activeConfigId ?? '') : undefined,
            });
          }

          const groups = new Map<string, {
            configId: string;
            scenarioId: string | null;
            indexes: number[];
            sourceRows: any[];
            objectRows: any[];
            requirementRows: any[];
          }>();
          for (let index = 0; index < nativeBatchResidualItems.length; index++) {
            const item = nativeBatchResidualItems[index];
            const requirement = item?.req || {};
            const configId = String(item?.configId ?? requirement?.configId ?? activeConfigId ?? '');
            const scenarioId = item?.scenarioId ? String(item.scenarioId) : null;
            const groupKey = `${configId}|${scenarioId || ''}`;
            const scenarioTables = resolveScenarioTablesForConfig(configId, scenarioId);
            const group = groups.get(groupKey) || {
              configId,
              scenarioId,
              indexes: [],
              sourceRows: scenarioTables.sourceRows,
              objectRows: scenarioTables.objectRows,
              requirementRows: [],
            };
            group.indexes.push(index);
            group.requirementRows.push({
              id: requirement.id,
              configId,
              enabled: true,
              operand: requirement.operand,
              op: requirement.op,
              target: requirement.target,
              tol: requirement.tol,
              weight: requirement.weight,
              param1: requirement.param1,
              param2: requirement.param2,
              param3: requirement.param3,
              param4: requirement.param4,
              param5: requirement.param5,
            });
            groups.set(groupKey, group);
          }

          const groupedScenarios = Array.from(groups.values());
          if (groupedScenarios.length === 0) {
            return {
              currentsPerCandidate: candidatePoints.map(() => []),
              appliedUpdateCount: 0,
              sessionReused: false,
            };
          }

          if (__profile?.counts) {
            __profile.counts.kktNativeBatchMultiScenarioIpcCalls = (Number(__profile.counts.kktNativeBatchMultiScenarioIpcCalls) || 0) + 1;
            __profile.counts.kktNativeBatchMultiScenarioGroups = (Number(__profile.counts.kktNativeBatchMultiScenarioGroups) || 0) + groupedScenarios.length;
          }

          const multiScenarioResponse = await evaluateOptimizerCandidatesMultiScenario({
            candidateDeltas: useVectorCandidates ? undefined : candidateDeltas,
            candidateVectors: useVectorCandidates ? candidatePoints : undefined,
            variableBindings: useVectorCandidates
              ? nativeBatchVariableBindings as any[]
              : undefined,
            baseRowsByConfig,
            scenarioBatches: groupedScenarios.map((group) => ({
              sourceRows: group.sourceRows,
              objectRows: group.objectRows,
              systemRequirementsRows: group.requirementRows,
              activeConfigId: group.configId,
            })),
          });

          const mergedCurrentsRows = Array.isArray(multiScenarioResponse?.currentsPerCandidate)
            ? multiScenarioResponse.currentsPerCandidate
            : [];
          if (mergedCurrentsRows.length !== candidatePoints.length) return null;

          const mergedCurrents = candidatePoints.map(
            () => new Array<number | null>(nativeBatchResidualItems.length).fill(null),
          );
          for (let candidateIndex = 0; candidateIndex < mergedCurrentsRows.length; candidateIndex++) {
            const candidateCurrents = Array.isArray(mergedCurrentsRows[candidateIndex])
              ? mergedCurrentsRows[candidateIndex]
              : [];
            let offset = 0;
            for (const group of groupedScenarios) {
              for (let localIndex = 0; localIndex < group.indexes.length; localIndex++) {
                const globalIndex = group.indexes[localIndex];
                mergedCurrents[candidateIndex][globalIndex] = candidateCurrents[offset + localIndex] ?? null;
              }
              offset += group.indexes.length;
            }
          }

          return {
            currentsPerCandidate: mergedCurrents,
            appliedUpdateCount: Number(multiScenarioResponse?.appliedUpdateCount) || 0,
            sessionReused: !!multiScenarioResponse?.sessionReused,
          };
        };

        if (nativeBatchVariableBindings === undefined) {
          const calibration = calibrateNativeVariableBindings();
          nativeBatchVariableBindings = calibration?.bindings || null;
          nativeBatchBaseRowsByConfig = calibration?.baselineRows || null;
        }
        const useVectorCandidates = Array.isArray(nativeBatchVariableBindings)
          && nativeBatchVariableBindings.length > 0
          && nativeBatchBaseRowsByConfig !== null;
        const initializeNativeSession = nativeBatchBaseRowsByConfig !== null
          && !nativeBatchSessionInitialized;
        let candidates: Array<Record<string, any[]>> = [];
        let candidateDeltas: any[][] = [];
        const needsMtfCandidateRows = hasMtfResidualItems;
        if (!useVectorCandidates || needsMtfCandidateRows) {
          candidates = candidatePoints.map(buildNativeCandidateRows).filter(Boolean) as Array<Record<string, any[]>>;
          if (candidates.length !== candidatePoints.length) return null;
        }
        if (!useVectorCandidates) {
          const baseRowsByConfig = nativeBatchBaseRowsByConfig || candidates[0];
          nativeBatchBaseRowsByConfig = baseRowsByConfig;
          candidateDeltas = candidates.map(candidate => buildNativeCandidateDeltas(baseRowsByConfig, candidate) as any[]);
          if (candidateDeltas.some(updates => !Array.isArray(updates))) return null;
        }
        const baseRowsByConfig = nativeBatchBaseRowsByConfig as Record<string, any[]>;
        try {
          const hasNativeRequirementRows = nativeBatchRequirementRows.length > 0;
          const response = await evaluateNativeCurrentsSingleOrScenarioBatches(
            useVectorCandidates,
            candidateDeltas,
            baseRowsByConfig,
            hasNativeRequirementRows,
          );
          if (!response) {
            if (__profile?.counts) {
              __profile.counts.kktNativeBatchFdFallbacks = (Number(__profile.counts.kktNativeBatchFdFallbacks) || 0) + 1;
              __profile.counts.kktNativeBatchFdMs = (Number(__profile.counts.kktNativeBatchFdMs) || 0) + (nowMs() - batchStartedAt);
            }
            return null;
          }
          if (initializeNativeSession && hasNativeRequirementRows) {
            nativeBatchSessionInitialized = true;
            if (__profile?.counts) {
              __profile.counts.kktNativeBatchFdSessionInitializations = 1;
            }
          }
          if (__profile?.counts) {
            __profile.counts.kktNativeBatchFdDeltaUpdates = (Number(__profile.counts.kktNativeBatchFdDeltaUpdates) || 0)
              + (Number(response?.appliedUpdateCount) || 0);
            if (response?.sessionReused) {
              __profile.counts.kktNativeBatchFdSessionReuses = (Number(__profile.counts.kktNativeBatchFdSessionReuses) || 0) + 1;
            }
            if (useVectorCandidates) {
              __profile.counts.kktNativeBatchFdVectorCandidates = (Number(__profile.counts.kktNativeBatchFdVectorCandidates) || 0)
                + candidatePoints.length;
            }
          }
          if (!Array.isArray(response?.currentsPerCandidate)
            || response.currentsPerCandidate.length !== candidatePoints.length) {
            if (__profile?.counts) {
              __profile.counts.kktNativeBatchFdFallbacks = (Number(__profile.counts.kktNativeBatchFdFallbacks) || 0) + 1;
              __profile.counts.kktNativeBatchFdMs = (Number(__profile.counts.kktNativeBatchFdMs) || 0) + (nowMs() - batchStartedAt);
            }
            return null;
          }
          const mtfSeededValues = needsMtfCandidateRows
            ? await evalMtfOperandValuesNativeBatch(candidates)
            : null;
          let residuals: number[][];
          const baseEvals: any[] = [];
          if (nativeBatchCoversAllResidualItems) {
            residuals = response.currentsPerCandidate.map((currents) => {
                if (!Array.isArray(currents) || currents.length !== nativeBatchResidualItems.length) return [];
                const base = buildKktEvaluationFromNativeCurrents(currents);
                baseEvals.push(base);
                const residualVector = Array.isArray(base.residuals) ? base.residuals.slice() : [];
                return residualVector.concat(base.constraints);
              });
          } else {
            residuals = [];
            if (__profile?.counts) {
              __profile.counts.kktNativeBatchFdPartialCalls = (Number(__profile.counts.kktNativeBatchFdPartialCalls) || 0) + 1;
              __profile.counts.kktNativeBatchFdPartialCandidates = (Number(__profile.counts.kktNativeBatchFdPartialCandidates) || 0)
                + response.currentsPerCandidate.length;
              __profile.counts.kktNativeBatchFdNativeRows = (Number(__profile.counts.kktNativeBatchFdNativeRows) || 0)
                + response.currentsPerCandidate.length * nativeBatchResidualItems.length;
            }
            for (let candidateIndex = 0; candidateIndex < response.currentsPerCandidate.length; candidateIndex++) {
              const currents = response.currentsPerCandidate[candidateIndex];
              const seededValues = buildNativeOperandValueCache(currents) || new Map<string, number>();
              const mtfValues = mtfSeededValues?.[candidateIndex];
              if (mtfValues instanceof Map) {
                for (const [key, value] of mtfValues) seededValues.set(key, value);
              }
              if (seededValues.size === 0) {
                residuals.push([]);
                continue;
              }
              const base = await evalSQPAtXUncached(candidatePoints[candidateIndex], seededValues, {
                forceFullOperandEval: kktForceFullOperandSweep,
                priorityOperandKeys: kktPriorityOperandKeys,
              });
              baseEvals.push(base);
              const residualVector = Array.isArray(base.residuals) ? base.residuals.slice() : [];
              residuals.push(residualVector.concat(Array.isArray(base.constraints) ? base.constraints : []));
            }
          }
          if (typeof onBaseEvalBatch === 'function') {
            onBaseEvalBatch(baseEvals);
          }
          if (nativeBatchFdParityStatus === 'unchecked') {
            const reference = await evalAugmentedResiduals(
              candidatePoints[0],
              lambdaVec,
              penaltyMu,
              maxViolContext,
            );
            const expected = Array.isArray(reference?.residuals) ? reference.residuals : [];
            const actual = residuals[0] || [];
            const parityOk = expected.length === actual.length && expected.every((value, index) => {
              const candidateValue = Number(actual[index]);
              const referenceValue = Number(value);
              if (!Number.isFinite(candidateValue) || !Number.isFinite(referenceValue)) {
                return candidateValue === referenceValue;
              }
              const tolerance = 1e-8 * Math.max(1, Math.abs(referenceValue));
              return Math.abs(candidateValue - referenceValue) <= tolerance;
            });
            nativeBatchFdParityStatus = parityOk ? 'passed' : 'failed';
            if (__profile?.counts) {
              const parityCounter = parityOk
                ? 'kktNativeBatchFdParityPassed'
                : 'kktNativeBatchFdParityFailed';
              __profile.counts[parityCounter] = (Number(__profile.counts[parityCounter]) || 0) + 1;
            }
            if (!parityOk) {
              nativeBatchBaseRowsByConfig = null;
              nativeBatchSessionInitialized = false;
              nativeBatchVariableBindings = null;
              try { await dropOptimizerSession(nativeBatchEvaluatorSessionId); } catch (_) {}
              if (__profile?.counts) {
                __profile.counts.kktNativeBatchFdFallbacks = (Number(__profile.counts.kktNativeBatchFdFallbacks) || 0) + 1;
                __profile.counts.kktNativeBatchFdMs = (Number(__profile.counts.kktNativeBatchFdMs) || 0) + (nowMs() - batchStartedAt);
              }
              return null;
            }
          }
          if (__profile?.counts) {
            __profile.counts.kktNativeBatchFdHits = (Number(__profile.counts.kktNativeBatchFdHits) || 0) + 1;
            __profile.counts.kktNativeBatchFdMs = (Number(__profile.counts.kktNativeBatchFdMs) || 0) + (nowMs() - batchStartedAt);
          }
          return residuals;
        } catch (error) {
          nativeBatchBaseRowsByConfig = null;
          nativeBatchSessionInitialized = false;
          nativeBatchVariableBindings = undefined;
          try { await dropOptimizerSession(nativeBatchEvaluatorSessionId); } catch (_) {}
          if (__profile?.counts) {
            __profile.nativeBatchFdError = String(error instanceof Error ? error.message : error);
            __profile.counts.kktNativeBatchFdErrors = (Number(__profile.counts.kktNativeBatchFdErrors) || 0) + 1;
            __profile.counts.kktNativeBatchFdFallbacks = (Number(__profile.counts.kktNativeBatchFdFallbacks) || 0) + 1;
            __profile.counts.kktNativeBatchFdMs = (Number(__profile.counts.kktNativeBatchFdMs) || 0) + (nowMs() - batchStartedAt);
          }
          return null;
        }
      };

      const finiteDiffJacobian = async (x: number[], r0: number[], lambdaVec: number[], mu: number, maxViol: number = 1.0, baseResidualCount: number = 0) => {
        const __fdT0 = nowMs();
        const n = x.length;
        const m = r0.length;
        const J = Array.from({ length: m }, () => Array(n).fill(0));
        const analyticEqCols = collectAnalyticEqualityVariableIndexes(n);
        const useWasmBatchFd = opts?.kktUseWasmBatchFd !== false;
        const canUseGrouping = kktUseSparseFdGrouping
          && Array.isArray(jacobianColumnSupports)
          && jacobianColumnSupports.length === n;
        const fdSteps = new Array(n).fill(0);
        const perturbedResidualsActive: number[][] = [];

        for (let i = 0; i < n; i++) {
          const vObj = { id: varIds[i], key: vars[i]?.key, value: x[i] };
          let eps = finiteDifferenceStepForVar(vObj);
          const xi = Number(x[i]);
          if (!Number.isFinite(eps) || eps === 0) {
            eps = Math.max(1e-8, Math.abs(xi) * 1e-6);
          }
          if (xi + eps === xi) {
            eps = Math.max(1e-8, Math.abs(xi) * 1e-6);
          }
          fdSteps[i] = eps;
        }

        let effectiveEvals = 0;
        let groupCount = 0;
        const activeCols = Array.from({ length: n }, (_, i) => i).filter((col) => !analyticEqCols.has(col));
        const nativeGroups = canUseGrouping
          ? buildDisjointColumnGroups(activeCols, jacobianColumnSupports || [], kktFdGroupingMaxCols)
          : activeCols.map((col) => [col]);
        const nativeCandidatePoints = nativeGroups.map((group) => {
          const xp = x.slice();
          for (const col of group) xp[col] = x[col] + fdSteps[col];
          return xp;
        });
        const nativeBatchResiduals = await evalAugmentedResidualsNativeBatch(nativeCandidatePoints, lambdaVec, mu, maxViol);
        const nativeBatchComplete = Array.isArray(nativeBatchResiduals)
          && nativeBatchResiduals.length === nativeGroups.length
          && nativeBatchResiduals.every((residuals) => Array.isArray(residuals) && residuals.length === m);

        if (nativeBatchComplete && nativeBatchResiduals) {
          groupCount = nativeGroups.length;
          effectiveEvals = nativeGroups.length;
          for (let groupIndex = 0; groupIndex < nativeGroups.length; groupIndex++) {
            const group = nativeGroups[groupIndex];
            const r1 = nativeBatchResiduals[groupIndex];
            for (const col of group) {
              const eps = fdSteps[col];
              const supportRows = Array.isArray(jacobianColumnSupports?.[col]) ? jacobianColumnSupports[col] : [];
              const rowsToUpdate = supportRows.length > 0 ? supportRows : Array.from({ length: m }, (_, row) => row);
              for (const row of rowsToUpdate) {
                if (!(row >= 0 && row < m)) continue;
                const deriv = (r1[row] - r0[row]) / eps;
                J[row][col] = Number.isFinite(deriv) ? Math.max(-1e12, Math.min(1e12, deriv)) : 0;
              }
            }
          }
        } else if (canUseGrouping) {
          const groups = nativeGroups;
          groupCount = groups.length;
          for (const group of groups) {
            if (shouldStopKKT()) throw Object.assign(new Error('stop'), { __cooptStop: true });
            await maybeYieldKktCpu();
            if (!Array.isArray(group) || group.length === 0) continue;
            const xp = x.slice();
            for (const col of group) {
              if (!(col >= 0 && col < n)) continue;
              xp[col] = x[col] + fdSteps[col];
            }
            const e1 = await evalAugmentedResiduals(xp, lambdaVec, mu, maxViol);
            const r1 = Array.isArray(e1?.residuals) ? e1.residuals : [];
            await maybeYieldKktCpu();
            effectiveEvals += 1;
            for (const col of group) {
              if (!(col >= 0 && col < n)) continue;
              const eps = fdSteps[col];
              if (!Number.isFinite(eps) || eps === 0) continue;
              const supportRows = Array.isArray(jacobianColumnSupports?.[col]) ? jacobianColumnSupports[col] : [];
              if (supportRows.length === 0) {
                for (let row = 0; row < Math.min(m, r1.length); row++) {
                  const deriv = (r1[row] - r0[row]) / eps;
                  J[row][col] = Number.isFinite(deriv) ? Math.max(-1e12, Math.min(1e12, deriv)) : 0;
                }
              } else {
                for (const row of supportRows) {
                  if (!(row >= 0 && row < m) || row >= r1.length) continue;
                  const deriv = (r1[row] - r0[row]) / eps;
                  J[row][col] = Number.isFinite(deriv) ? Math.max(-1e12, Math.min(1e12, deriv)) : 0;
                }
              }
            }
          }
        } else {
          const batchPoints = useWasmBatchFd
            ? __profileBucketWrap('time_wasm_call', () => generateFiniteDifferencePerturbationPointsWasm(x, fdSteps))
            : null;

          for (const i of activeCols) {
            if (shouldStopKKT()) throw Object.assign(new Error('stop'), { __cooptStop: true });
            await maybeYieldKktCpu();
            let xp = Array.isArray(batchPoints) && Array.isArray(batchPoints[i])
              ? batchPoints[i].slice()
              : x.slice();
            if (xp[i] === x[i]) {
              xp[i] = x[i] + fdSteps[i];
            }

            const e1 = await evalAugmentedResiduals(xp, lambdaVec, mu, maxViol);
            const r1 = e1.residuals;
            await maybeYieldKktCpu();
            perturbedResidualsActive.push(Array.isArray(r1) ? r1.slice(0, m) : []);
          }

          const Jw = useWasmBatchFd
            ? __profileBucketWrap('time_wasm_call', () => assembleFiniteDifferenceJacobianGroupedWasm(r0, perturbedResidualsActive, fdSteps, activeCols))
            : null;

          if (Array.isArray(Jw) && Jw.length === m) {
            for (let rowIndex = 0; rowIndex < m; rowIndex++) {
              const row = Jw[rowIndex];
              if (!Array.isArray(row)) continue;
              for (const colIndex of activeCols) {
                if (colIndex >= row.length) continue;
                const v = Number(row[colIndex]);
                J[rowIndex][colIndex] = Number.isFinite(v) ? v : 0;
              }
            }
          } else {
            for (let pos = 0; pos < activeCols.length; pos++) {
              const i = activeCols[pos];
              const r1 = perturbedResidualsActive[pos];
              const eps = fdSteps[i];
              if (!Array.isArray(r1) || !Number.isFinite(eps) || eps === 0) continue;
              for (let k = 0; k < Math.min(m, r1.length); k++) {
                const deriv = (r1[k] - r0[k]) / eps;
                J[k][i] = Number.isFinite(deriv) ? Math.max(-1e12, Math.min(1e12, deriv)) : 0;
              }
            }
          }
          effectiveEvals = activeCols.length;
          groupCount = activeCols.length;
        }

        const analyticRows = applyAnalyticAsphereConstraintJacobianOverlay(J, x, lambdaVec, mu, maxViol, baseResidualCount);
        const analyticEqRows = applyAnalyticEqualityCtctJacobianOverlay(J, n, baseResidualCount);
        jacobianColumnSupports = buildSupportsFromJacobian(J, m, n, kktFdSupportThreshold);

        if (__profile && __profile.counts) {
          __profile.counts.kktFiniteDiffJacobianCalls = (Number(__profile.counts.kktFiniteDiffJacobianCalls) || 0) + 1;
          __profile.counts.kktFiniteDiffColumns = (Number(__profile.counts.kktFiniteDiffColumns) || 0) + n;
          __profile.counts.kktFiniteDiffColumnsRaw = (Number(__profile.counts.kktFiniteDiffColumnsRaw) || 0) + n;
          __profile.counts.kktFiniteDiffColumnsEffective = (Number(__profile.counts.kktFiniteDiffColumnsEffective) || 0) + effectiveEvals;
          __profile.counts.kktFiniteDiffGroups = (Number(__profile.counts.kktFiniteDiffGroups) || 0) + groupCount;
          __profile.counts.kktFiniteDiffResidualEvals = (Number(__profile.counts.kktFiniteDiffResidualEvals) || 0) + effectiveEvals;
          __profile.counts.kktAnalyticConstraintRows = (Number(__profile.counts.kktAnalyticConstraintRows) || 0) + analyticRows;
          __profile.counts.kktAnalyticEqualityRows = (Number(__profile.counts.kktAnalyticEqualityRows) || 0) + analyticEqRows;
          __profile.counts.kktFiniteDiffJacobianMs = (Number(__profile.counts.kktFiniteDiffJacobianMs) || 0) + (nowMs() - __fdT0);
          __profile.counts.kktJacobianFullCalls = (Number(__profile.counts.kktJacobianFullCalls) || 0) + 1;
        }
        return J;
      };

      const pickJacobianRefreshColumns = (xNow: number[], xPrev: number[] | null, maxColsRaw: number): number[] => {
        const nn = xNow.length;
        const maxCols = Math.max(1, Math.min(nn, Math.floor(Number(maxColsRaw) || nn)));
        if (maxCols >= nn) {
          return Array.from({ length: nn }, (_, i) => i);
        }
        if (!xPrev || xPrev.length !== nn) {
          if (maxCols === 1) return [0];
          const picked = new Set<number>();
          for (let k = 0; k < maxCols; k++) {
            const idx = Math.round((k * (nn - 1)) / (maxCols - 1));
            picked.add(Math.max(0, Math.min(nn - 1, idx)));
          }
          return Array.from(picked).sort((a, b) => a - b);
        }
        const scored: Array<{ idx: number; score: number }> = new Array(nn);
        for (let i = 0; i < nn; i++) {
          const s = Number.isFinite(varScales[i]) && Math.abs(varScales[i]) > 1e-18 ? Math.abs(varScales[i]) : 1;
          const d = Math.abs(Number(xNow[i]) - Number(xPrev[i]));
          scored[i] = { idx: i, score: d / s };
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, maxCols).map(v => v.idx).sort((a, b) => a - b);
      };

      const finiteDiffJacobianPartial = async (
        x: number[],
        r0: number[],
        lambdaVec: number[],
        mu: number,
        maxViol: number,
        baseJ: number[][],
        refreshCols: number[],
        baseResidualCount: number = 0
      ) => {
        const __fdT0 = nowMs();
        const n = x.length;
        const m = r0.length;
        const J = Array.from({ length: m }, () => Array(n).fill(0));
        const useWasmBatchFd = opts?.kktUseWasmBatchFd !== false;
        if (Array.isArray(baseJ) && baseJ.length > 0) {
          const copyRows = Math.min(m, baseJ.length);
          for (let rowIndex = 0; rowIndex < copyRows; rowIndex++) {
            const srcRow = Array.isArray(baseJ[rowIndex]) ? baseJ[rowIndex] : null;
            if (!srcRow) continue;
            for (let colIndex = 0; colIndex < n; colIndex++) {
              const value = Number(srcRow[colIndex]);
              J[rowIndex][colIndex] = Number.isFinite(value) ? value : 0;
            }
          }
        }

        const stepByCol: Record<number, number> = {};
        for (const col of refreshCols) {
          if (!(col >= 0 && col < n)) continue;
          const vObj = { id: varIds[col], key: vars[col]?.key, value: x[col] };
          let eps = finiteDifferenceStepForVar(vObj);
          const xi = Number(x[col]);
          if (!Number.isFinite(eps) || eps === 0 || xi + eps === xi) {
            eps = Math.max(1e-8, Math.abs(xi) * 1e-6);
          }
          stepByCol[col] = eps;
        }

        const analyticEqCols = collectAnalyticEqualityVariableIndexes(n);

        const validCols = refreshCols.filter((col) => col >= 0 && col < n && !analyticEqCols.has(col) && Number.isFinite(stepByCol[col]) && stepByCol[col] !== 0);
        const canUseGrouping = kktUseSparseFdGrouping
          && Array.isArray(jacobianColumnSupports)
          && jacobianColumnSupports.length === n;
        const groups = canUseGrouping
          ? buildDisjointColumnGroups(validCols, jacobianColumnSupports || [], kktFdGroupingMaxCols)
          : validCols.map((col) => [col]);

        let effectiveEvals = 0;
        const nativeCandidatePoints = groups.map((group) => {
          const xp = x.slice();
          for (const col of group) xp[col] = x[col] + stepByCol[col];
          return xp;
        });
        const nativeBatchResiduals = await evalAugmentedResidualsNativeBatch(nativeCandidatePoints, lambdaVec, mu, maxViol);
        const nativeBatchComplete = Array.isArray(nativeBatchResiduals)
          && nativeBatchResiduals.length === groups.length
          && nativeBatchResiduals.every((residuals) => Array.isArray(residuals) && residuals.length === m);

        if (nativeBatchComplete && nativeBatchResiduals) {
          effectiveEvals = groups.length;
          for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            const group = groups[groupIndex];
            const r1 = nativeBatchResiduals[groupIndex];
            for (const col of group) {
              const eps = stepByCol[col];
              const supportRows = Array.isArray(jacobianColumnSupports?.[col]) ? jacobianColumnSupports[col] : [];
              const rowsToUpdate = supportRows.length > 0 ? supportRows : Array.from({ length: m }, (_, row) => row);
              for (const row of rowsToUpdate) {
                if (!(row >= 0 && row < m)) continue;
                const deriv = (r1[row] - r0[row]) / eps;
                J[row][col] = Number.isFinite(deriv) ? Math.max(-1e12, Math.min(1e12, deriv)) : 0;
              }
            }
          }
        } else if (!canUseGrouping && useWasmBatchFd && validCols.length > 0) {
          const partialSteps = new Array(n).fill(0);
          const perturbedResidualsActive: number[][] = [];
          for (const col of validCols) {
            partialSteps[col] = stepByCol[col];
          }

          const batchPoints = __profileBucketWrap('time_wasm_call', () => generateFiniteDifferencePerturbationPointsWasm(x, partialSteps));
          for (const col of validCols) {
            if (shouldStopKKT()) throw Object.assign(new Error('stop'), { __cooptStop: true });
            await maybeYieldKktCpu();
            let xp = Array.isArray(batchPoints) && Array.isArray(batchPoints[col])
              ? batchPoints[col].slice()
              : x.slice();
            if (xp[col] === x[col]) {
              xp[col] = x[col] + stepByCol[col];
            }
            const e1 = await evalAugmentedResiduals(xp, lambdaVec, mu, maxViol);
            const r1 = Array.isArray(e1?.residuals) ? e1.residuals : [];
            await maybeYieldKktCpu();
            perturbedResidualsActive.push(Array.isArray(r1) ? r1.slice(0, m) : r0.slice());
          }

          const Jw = __profileBucketWrap('time_wasm_call', () => assembleFiniteDifferenceJacobianGroupedWasm(r0, perturbedResidualsActive, partialSteps, validCols));
          if (Array.isArray(Jw) && Jw.length === m) {
            for (const col of validCols) {
              for (let rowIndex = 0; rowIndex < m; rowIndex++) {
                const row = Array.isArray(Jw[rowIndex]) ? Jw[rowIndex] : null;
                if (!row || col >= row.length) continue;
                const value = Number(row[col]);
                J[rowIndex][col] = Number.isFinite(value) ? value : 0;
              }
            }
          } else {
            for (let pos = 0; pos < validCols.length; pos++) {
              const col = validCols[pos];
              const r1 = perturbedResidualsActive[pos];
              const eps = stepByCol[col];
              if (!Array.isArray(r1) || !Number.isFinite(eps) || eps === 0) continue;
              for (let rowIndex = 0; rowIndex < Math.min(m, r1.length); rowIndex++) {
                const deriv = (r1[rowIndex] - r0[rowIndex]) / eps;
                J[rowIndex][col] = Number.isFinite(deriv) ? Math.max(-1e12, Math.min(1e12, deriv)) : 0;
              }
            }
          }
          effectiveEvals = validCols.length;
        } else {
          for (const group of groups) {
            if (shouldStopKKT()) throw Object.assign(new Error('stop'), { __cooptStop: true });
            await maybeYieldKktCpu();
            if (!Array.isArray(group) || group.length === 0) continue;
            const xp = x.slice();
            for (const col of group) {
              xp[col] = x[col] + stepByCol[col];
            }
            const e1 = await evalAugmentedResiduals(xp, lambdaVec, mu, maxViol);
            const r1 = Array.isArray(e1?.residuals) ? e1.residuals : [];
            await maybeYieldKktCpu();
            effectiveEvals += 1;

            for (const col of group) {
              const eps = stepByCol[col];
              if (!Number.isFinite(eps) || eps === 0) continue;
              const supportRows = Array.isArray(jacobianColumnSupports?.[col]) ? jacobianColumnSupports[col] : [];
              if (supportRows.length === 0) {
                for (let k = 0; k < Math.min(m, r1.length); k++) {
                  const deriv = (r1[k] - r0[k]) / eps;
                  J[k][col] = Number.isFinite(deriv) ? Math.max(-1e12, Math.min(1e12, deriv)) : 0;
                }
              } else {
                for (const row of supportRows) {
                  if (!(row >= 0 && row < m) || row >= r1.length) continue;
                  const deriv = (r1[row] - r0[row]) / eps;
                  J[row][col] = Number.isFinite(deriv) ? Math.max(-1e12, Math.min(1e12, deriv)) : 0;
                }
              }
            }
          }
        }

        const analyticRows = applyAnalyticAsphereConstraintJacobianOverlay(J, x, lambdaVec, mu, maxViol, baseResidualCount);
        const analyticEqRows = applyAnalyticEqualityCtctJacobianOverlay(J, n, baseResidualCount);
        updateSupportsForColumns(J, m, validCols, kktFdSupportThreshold);

        if (__profile && __profile.counts) {
          __profile.counts.kktFiniteDiffJacobianCalls = (Number(__profile.counts.kktFiniteDiffJacobianCalls) || 0) + 1;
          __profile.counts.kktFiniteDiffColumns = (Number(__profile.counts.kktFiniteDiffColumns) || 0) + refreshCols.length;
          __profile.counts.kktFiniteDiffColumnsRaw = (Number(__profile.counts.kktFiniteDiffColumnsRaw) || 0) + refreshCols.length;
          __profile.counts.kktFiniteDiffColumnsEffective = (Number(__profile.counts.kktFiniteDiffColumnsEffective) || 0) + effectiveEvals;
          __profile.counts.kktFiniteDiffGroups = (Number(__profile.counts.kktFiniteDiffGroups) || 0) + groups.length;
          __profile.counts.kktFiniteDiffResidualEvals = (Number(__profile.counts.kktFiniteDiffResidualEvals) || 0) + effectiveEvals;
          __profile.counts.kktAnalyticConstraintRows = (Number(__profile.counts.kktAnalyticConstraintRows) || 0) + analyticRows;
          __profile.counts.kktAnalyticEqualityRows = (Number(__profile.counts.kktAnalyticEqualityRows) || 0) + analyticEqRows;
          __profile.counts.kktFiniteDiffJacobianMs = (Number(__profile.counts.kktFiniteDiffJacobianMs) || 0) + (nowMs() - __fdT0);
          __profile.counts.kktJacobianPartialCalls = (Number(__profile.counts.kktJacobianPartialCalls) || 0) + 1;
        }
        return J;
      };

      let bestX = clampToBounds(initialX.slice());
      let bestScore = initialScore;
      let bestEval = initialStateEval || null;
      let bestScoreXSnapshot = bestX.slice();
      let currentX = bestX.slice();
      let completedIterations = 0;

      const applyXToDesignState = (x: number[] | null | undefined) => {
        if (!Array.isArray(x)) return false;
        try {
          for (let k = 0; k < n && k < x.length; k++) {
            if (jointState && varIds && k < varIds.length) {
              setJointDesignVariableValue(jointState, varIds[k], x[k]);
            } else if (activeCfg && varIds && k < varIds.length) {
              setDesignVariableValue(activeCfg, varIds[k], x[k]);
            }
          }
          try {
            const activeId = String(jointState?.activeConfigId ?? activeConfigId ?? '').trim();
            const activeBlocks = activeId && jointState?.blocksByConfigId ? jointState.blocksByConfigId[activeId] : null;
            if (Array.isArray(activeBlocks)) updateActiveOpticalSystemOverrideFromBlocks(activeBlocks);
          } catch (_) {}
          return true;
        } catch (_) {
          return false;
        }
      };

      const withAppliedXSnapshot = (x: number[], evalResult: any) => {
        if (!evalResult || !Array.isArray(x) || x.length === 0) return evalResult;
        const savedX = Array.isArray(currentX) ? currentX.slice() : null;
        try {
          if (!applyXToDesignState(x)) return evalResult;
          return {
            ...evalResult,
            blocksSnapshot: snapshotBlocksByConfigId(blocksByConfigId)
          };
        } catch (_) {
          return evalResult;
        } finally {
          try {
            if (savedX && savedX.length > 0) applyXToDesignState(savedX);
          } catch (_) {}
        }
      };

      const restoreBestStateAndPersist = (sourceEval: any) => {
        try {
          const sourceBlocksSnapshot = (sourceEval && sourceEval.blocksSnapshot && typeof sourceEval.blocksSnapshot === 'object')
            ? sourceEval.blocksSnapshot
            : null;
          const preferredBlocksSnapshot = sourceBlocksSnapshot || bestScoreBlocksSnapshot;
          if (preferredBlocksSnapshot && typeof preferredBlocksSnapshot === 'object') {
            const snapshot = snapshotBlocksByConfigId(preferredBlocksSnapshot);
            const restored = restoreBlocksByConfigId(blocksByConfigId, snapshot);
            if (restored) {
              try {
                const activeId = String(jointState?.activeConfigId ?? activeConfigId ?? '').trim();
                const activeBlocks = activeId && blocksByConfigId ? blocksByConfigId[activeId] : null;
                if (Array.isArray(activeBlocks)) updateActiveOpticalSystemOverrideFromBlocks(activeBlocks);
              } catch (_) {}
            } else if (!applyXToDesignState(bestX)) {
              return sourceEval || null;
            }
          } else if (!applyXToDesignState(bestX)) {
            return sourceEval || null;
          }
          let restoredEval = hasHeavyAsyncRequirementOperands
            ? sourceEval
            : evalCompositeFromRequirementsProfiled();
          const __diagSnapshotRestoredScore = Number(restoredEval?.score);
          let __diagFallbackApplied = false;
          let __diagFallbackScore: number | undefined;
          let __diagFallbackCondition = false;
          let __diagFallbackAppliedByX = false;
          let __diagBestXAppliedOk = false;
          let __diagTrackedBest = Number.NaN;
          let __diagRestoredScore = Number.NaN;
          let __diagBestXLength = Array.isArray(bestX) ? bestX.length : -1;
          let __diagUsedSourceBlocksSnapshot = !!sourceBlocksSnapshot;
          // Verify the restored state actually matches the tracked best score.
          // The block snapshot can occasionally correspond to a slightly different
          // iterate than `bestScore`; if the restored score is worse than the
          // tracked best, fall back to applying the best variable vector (bestX)
          // directly so the applied optical system / Requirement score truly
          // reflect the minimum-score state.
          try {
            const trackedBest = Number.isFinite(Number(bestScore))
              ? Number(bestScore)
              : Number(sourceEval?.score);
            const restoredScore = Number(restoredEval?.score);
            __diagTrackedBest = trackedBest;
            __diagRestoredScore = restoredScore;
            __diagFallbackCondition = (
              Number.isFinite(trackedBest)
              && Number.isFinite(restoredScore)
              && restoredScore > (trackedBest + 1e-9)
              && Array.isArray(bestX)
              && bestX.length > 0
            );
            if (__diagFallbackCondition) {
              __diagBestXAppliedOk = applyXToDesignState(bestX);
              if (__diagBestXAppliedOk) {
                __diagFallbackAppliedByX = true;
                const reEval = evalCompositeFromRequirementsProfiled();
                __diagFallbackApplied = true;
                __diagFallbackScore = Number(reEval?.score);
                if (reEval && Number(reEval.score) <= restoredScore + 1e-12) {
                  restoredEval = reEval;
                }
              }
            }
          } catch (_) {}
          const sourceScore = Number(sourceEval?.score);
          const restoredScore = Number(restoredEval?.score);
          const preferSourceEval = Number.isFinite(sourceScore)
            && (!Number.isFinite(restoredScore) || sourceScore <= (restoredScore + 1e-12));
          const scoreEval = preferSourceEval
            ? (sourceEval || restoredEval)
            : (restoredEval || sourceEval);
          const finalEval = {
            ...scoreEval,
            restoredBestScore: Number.isFinite(Number(restoredEval?.score)) ? Number(restoredEval.score) : undefined,
            sourceBestScore: Number.isFinite(Number(sourceEval?.score)) ? Number(sourceEval.score) : undefined,
            blocksSnapshot: snapshotBlocksByConfigId(blocksByConfigId)
          };
          const persisted = restoreBestSnapshotAndPersist({ finalEval, jointState, systemConfig, configsById, targetConfigIds });
          if (persisted) {
            __persistedOptimizerResultForUi = true;
            __lastOptimizerResultSnapshotForUi = buildOptimizerResultSnapshotForUi();
          }
          try {
            if (!(typeof window !== 'undefined' && (window as any).__COOPT_AL_DIAG === true)) throw new Error('AL diag disabled');
            const __diagActiveId = String(jointState?.activeConfigId ?? activeConfigId ?? '').trim();
            const __diagSnap = __lastOptimizerResultSnapshotForUi as any;
            const __diagRows = __diagSnap && Array.isArray(__diagSnap.opticalSystemRowsSnapshot)
              ? __diagSnap.opticalSystemRowsSnapshot
              : null;
            console.log('🩺 [AL-DIAG] restoreBestStateAndPersist', {
              trackedBestScore: Number(bestScore),
              sourceBestScore: Number(sourceEval?.score),
              snapshotRestoredScore: __diagSnapshotRestoredScore,
              usedSourceBlocksSnapshot: __diagUsedSourceBlocksSnapshot,
              fallbackCondition: __diagFallbackCondition,
              fallbackTrackedBest: __diagTrackedBest,
              fallbackRestoredScore: __diagRestoredScore,
              bestXLength: __diagBestXLength,
              bestXAppliedOk: __diagBestXAppliedOk,
              fallbackAppliedByX: __diagFallbackAppliedByX,
              fallbackApplied: __diagFallbackApplied,
              fallbackScore: __diagFallbackScore,
              preferSourceEval,
              finalRestoredScore: Number(restoredEval?.score),
              finalReturnedScore: Number(finalEval?.score),
              persisted,
              hasUiSnapshot: !!__diagSnap,
              uiSnapshotRowCount: __diagRows ? __diagRows.length : null,
              uiSnapshotHasConfigs: !!(__diagSnap && __diagSnap.systemConfigSnapshot
                && Array.isArray(__diagSnap.systemConfigSnapshot.configurations)
                && __diagSnap.systemConfigSnapshot.configurations.length),
              activeConfigId: __diagActiveId,
            });
          } catch (_) {}
          return finalEval;
        } catch (_) {
          return sourceEval || null;
        }
      };

      const calibrateAnalyticEqualityCtctRows = async (xRef: number[]) => {
        if (!kktUseAnalyticEqualityCtctJacobian) {
          analyticEqualityCalibrated = true;
          return;
        }
        if (analyticEqualityCalibrated) return;
        analyticEqualityCalibrated = true;
        analyticEqualityRowSpecs = [];

        try {
          const baseEval = await evalSQPAtX(xRef);
          const baseResiduals = Array.isArray(baseEval?.residuals) ? baseEval.residuals : [];
          if (baseResiduals.length === 0) return;

          const candidateRows = equalityResidualMeta
            .filter((meta) => {
              const operand = String(meta?.req?.operand || '').trim().toUpperCase();
              return operand === 'CTCT' || operand === 'OBJD' || operand === 'TSL';
            })
            .filter((meta) => meta.rowIndex >= 0 && meta.rowIndex < baseResiduals.length);

          if (__profile && __profile.counts) {
            __profile.counts.kktAnalyticEqualityCandidateRows = (Number(__profile.counts.kktAnalyticEqualityCandidateRows) || 0) + candidateRows.length;
          }

          if (candidateRows.length === 0) return;

          for (const meta of candidateRows) {
            const row = meta.rowIndex;
            const cfgId = String(meta.configId || '');
            const operand = String(meta?.req?.operand || '').trim().toUpperCase();

            const directTerms = buildAnalyticEqualityTermsForRequirement(meta?.req, cfgId);
            if (directTerms.length > 0) {
              analyticEqualityRowSpecs.push({ rowIndex: row, terms: directTerms });
              continue;
            }

            const candidateVarIdxs = collectThicknessVariableIndexesForConfig(cfgId);

            const limitedCandidates = candidateVarIdxs.slice(0, kktAnalyticEqCalibrationMaxCandidates);
            if (limitedCandidates.length === 0) continue;

            let best: { idx: number; slope: number; absSlope: number } | null = null;
            let secondAbs = 0;

            for (const vi of limitedCandidates) {
              const xv = Number(xRef[vi]);
              const vObj = { id: varIds[vi], key: vars[vi]?.key, value: xv };
              let eps = finiteDifferenceStepForVar(vObj);
              if (!Number.isFinite(eps) || eps === 0 || xv + eps === xv) {
                eps = Math.max(1e-8, Math.abs(xv) * 1e-6);
              }
              if (!Number.isFinite(eps) || eps === 0) continue;

              const xp = xRef.slice();
              xp[vi] = xv + eps;
              const e1 = await evalSQPAtX(xp);
              const r1 = Array.isArray(e1?.residuals) ? e1.residuals : [];
              if (!(row < r1.length)) continue;
              const slope = (Number(r1[row]) - Number(baseResiduals[row])) / eps;
              const absSlope = Math.abs(slope);
              if (!Number.isFinite(absSlope)) continue;

              if (!best || absSlope > best.absSlope) {
                secondAbs = best ? best.absSlope : secondAbs;
                best = { idx: vi, slope, absSlope };
              } else if (absSlope > secondAbs) {
                secondAbs = absSlope;
              }
            }

            if (!best || best.absSlope < kktAnalyticEqMinAbsSlope) continue;
            const dominance = secondAbs > 0 ? (best.absSlope / secondAbs) : Number.POSITIVE_INFINITY;
            if (!(dominance >= 3)) continue;
            if (operand === 'CTCT' || operand === 'OBJD') {
              analyticEqualityRowSpecs.push({ rowIndex: row, terms: [{ varIdx: best.idx, slope: best.slope }] });
            }
          }

          if (__profile && __profile.counts) {
            __profile.counts.kktAnalyticEqualityCalibratedRows = (Number(__profile.counts.kktAnalyticEqualityCalibratedRows) || 0) + analyticEqualityRowSpecs.length;
          }
        } catch (_) {
          analyticEqualityRowSpecs = [];
        }
      };

      if (hasHeavyAsyncRequirementOperands) {
        analyticEqualityCalibrated = true;
      } else {
        await calibrateAnalyticEqualityCtctRows(currentX);
      }
      
      // 【重要】初期評価を recordEval() に記録（LMメソッドと同様）
      // これにより getBestEvalSoFar() が null を返さず、正しくベスト追跡できる
      if (initialStateEval) {
        recordEval(initialStateEval);
      }
      
      // 【修正】ペナルティを含めた総合評価（メリット関数）でベストを追跡する
      // これにより、完全に feasible でなくても、十分に改善された解を保存できる
      const initConstraintEval = await evalSQPAtX(initialX);
      const initViolationVector = (initConstraintEval.constraints || []).map(c => Math.max(0, c));
      const initViolation = Math.sqrt(initViolationVector.reduce((acc, v) => acc + v * v, 0));
      const initialObjective = Number(initConstraintEval.objective);
      let bestMerit = (Number.isFinite(initialObjective) ? initialObjective : Number.POSITIVE_INFINITY)
        + initViolation * 10000;

      let mu = Math.max(1, Number.isFinite(Number(opts?.kktPenalty)) ? Number(opts.kktPenalty) : 1);
      let lambdaVec: number[] = [];
      let lmDamp = Number.isFinite(Number(opts?.kktSqpInitialDamping))
        ? Math.max(1e-12, Number(opts.kktSqpInitialDamping))
        : 2e-4;
      let lmDampRejectMultiplier = 2;
      let lmDampHessianScale = 1;
      let lastMaxViol = Infinity;  // Track maxViol for stagnation detection
      let violStagnationIter = 0;  // Count iterations without improvement
      let kktRejectStreak = 0;  // 【追加】Auto soft-restart: detect if stuck in reject-repeat cycle
      let consecutiveRestarts = 0;  // 【追加】連続リスタート回数をカウント
      let softRestartBestScore = Number.POSITIVE_INFINITY;
      let lastAcceptedScore = initialScore;  // 【追加】最後にアクセプトされたスコアを追跡
      let nonmonotoneAcceptStreak = 0;
      const kktNonmonotoneLocalScoreRel = Number.isFinite(Number(opts?.kktNonmonotoneLocalScoreRel))
        ? Math.max(0, Number(opts.kktNonmonotoneLocalScoreRel))
        : 1e-3;
      const kktNonmonotoneBestScoreRel = Number.isFinite(Number(opts?.kktNonmonotoneBestScoreRel))
        ? Math.max(0, Number(opts.kktNonmonotoneBestScoreRel))
        : 2e-3;
      const kktRollbackRejectStreak = Number.isFinite(Number(opts?.kktRollbackRejectStreak))
        ? Math.max(2, Math.floor(Number(opts.kktRollbackRejectStreak)))
        : 3;
      let prevConvCost = Number.POSITIVE_INFINITY;
      let feasibleConvStreak = 0;
      let stagnationIter = 0;
      const stagnationIterLimit = Number.isFinite(Number(opts?.kktStagnationIterLimit))
        ? Math.max(20, Math.floor(Number(opts.kktStagnationIterLimit)))
        : 80;
      const stagnationImproveEps = Number.isFinite(Number(opts?.kktStagnationImproveEps))
        ? Math.max(1e-10, Number(opts.kktStagnationImproveEps))
        : 1e-6;
      const kktAutoStopConfigKeys = [
        'kktPlateauStopMinIter',
        'kktPlateauStopWindow',
        'kktPlateauRelaxedMinIter',
        'kktTailStopMinIter',
        'kktTailStopWindow',
        'kktWindowTailStopMinIter',
        'kktWindowTailStopWindow',
        'kktWindowNoGainMinIter',
        'kktWindowNoGainWindow',
        'kktGoodEnoughStopMinIter',
        'kktGoodEnoughStopWindow',
        'kktHardIterCap',
        'kktMaxWallMs',
        'kktNoBestImproveMinIter',
        'kktNoBestImproveWindow',
        'kktPostBestDivergenceMinIter',
        'kktPostBestNoImproveWindow',
        'kktPostBestPatienceMinIter',
        'kktPostBestPatienceWindow'
      ];
      const hasExplicitKktAutoStopConfig = kktAutoStopConfigKeys.some((key) => opts?.[key] != null);
      const kktAutoStopEnabled = opts?.kktAutoStop === true || hasExplicitKktAutoStopConfig;
      const kktPlateauStopMinIter = Number.isFinite(Number(opts?.kktPlateauStopMinIter))
        ? Math.max(5, Math.floor(Number(opts.kktPlateauStopMinIter)))
        : 45;
      const kktPlateauStopWindow = Number.isFinite(Number(opts?.kktPlateauStopWindow))
        ? Math.max(5, Math.floor(Number(opts.kktPlateauStopWindow)))
        : 45;
      const kktPlateauBestRelImproveEps = Number.isFinite(Number(opts?.kktPlateauBestRelImproveEps))
        ? Math.max(0, Number(opts.kktPlateauBestRelImproveEps))
        : 5e-4;
      const kktPlateauMaxViol = Number.isFinite(Number(opts?.kktPlateauMaxViol))
        ? Math.max(0, Number(opts.kktPlateauMaxViol))
        : 5e-3;
      const kktPlateauViolImproveEps = Number.isFinite(Number(opts?.kktPlateauViolImproveEps))
        ? Math.max(0, Number(opts.kktPlateauViolImproveEps))
        : 1e-3;
      const kktPlateauRelaxedMaxViol = Number.isFinite(Number(opts?.kktPlateauRelaxedMaxViol))
        ? Math.max(0, Number(opts.kktPlateauRelaxedMaxViol))
        : 2e-1;
      const kktPlateauRelaxedMinIter = Number.isFinite(Number(opts?.kktPlateauRelaxedMinIter))
        ? Math.max(kktPlateauStopMinIter, Math.floor(Number(opts.kktPlateauRelaxedMinIter)))
        : Math.max(kktPlateauStopMinIter, 35);
      const kktTailStopMinIter = Number.isFinite(Number(opts?.kktTailStopMinIter))
        ? Math.max(20, Math.floor(Number(opts.kktTailStopMinIter)))
        : 120;
      const kktTailStopWindow = Number.isFinite(Number(opts?.kktTailStopWindow))
        ? Math.max(10, Math.floor(Number(opts.kktTailStopWindow)))
        : 60;
      const kktTailStopBestRelImproveEps = Number.isFinite(Number(opts?.kktTailStopBestRelImproveEps))
        ? Math.max(0, Number(opts.kktTailStopBestRelImproveEps))
        : 3e-4;
      const kktWindowTailStopMinIter = Number.isFinite(Number(opts?.kktWindowTailStopMinIter))
        ? Math.max(20, Math.floor(Number(opts.kktWindowTailStopMinIter)))
        : 60;
      const kktWindowTailStopWindow = Number.isFinite(Number(opts?.kktWindowTailStopWindow))
        ? Math.max(10, Math.floor(Number(opts.kktWindowTailStopWindow)))
        : 20;
      const kktWindowTailStopRelImproveEps = Number.isFinite(Number(opts?.kktWindowTailStopRelImproveEps))
        ? Math.max(0, Number(opts.kktWindowTailStopRelImproveEps))
        : 8e-4;
      const kktWindowTailStopMaxViol = Number.isFinite(Number(opts?.kktWindowTailStopMaxViol))
        ? Math.max(0, Number(opts.kktWindowTailStopMaxViol))
        : 1.0;
      const kktWindowNoGainMinIter = Number.isFinite(Number(opts?.kktWindowNoGainMinIter))
        ? Math.max(20, Math.floor(Number(opts.kktWindowNoGainMinIter)))
        : 110;
      const kktWindowNoGainWindow = Number.isFinite(Number(opts?.kktWindowNoGainWindow))
        ? Math.max(10, Math.floor(Number(opts.kktWindowNoGainWindow)))
        : 50;
      const kktWindowNoGainRelImproveEps = Number.isFinite(Number(opts?.kktWindowNoGainRelImproveEps))
        ? Math.max(0, Number(opts.kktWindowNoGainRelImproveEps))
        : 2e-3;
      const kktWindowNoGainMaxViol = Number.isFinite(Number(opts?.kktWindowNoGainMaxViol))
        ? Math.max(0, Number(opts.kktWindowNoGainMaxViol))
        : 1.0;
      const kktGoodEnoughStopMinIter = Number.isFinite(Number(opts?.kktGoodEnoughStopMinIter))
        ? Math.max(20, Math.floor(Number(opts.kktGoodEnoughStopMinIter)))
        : 90;
      const kktGoodEnoughStopWindow = Number.isFinite(Number(opts?.kktGoodEnoughStopWindow))
        ? Math.max(10, Math.floor(Number(opts.kktGoodEnoughStopWindow)))
        : 35;
      const kktGoodEnoughStopRecentRelImproveEps = Number.isFinite(Number(opts?.kktGoodEnoughStopRecentRelImproveEps))
        ? Math.max(0, Number(opts.kktGoodEnoughStopRecentRelImproveEps))
        : 5e-3;
      const kktGoodEnoughStopMaxViol = Number.isFinite(Number(opts?.kktGoodEnoughStopMaxViol))
        ? Math.max(0, Number(opts.kktGoodEnoughStopMaxViol))
        : 2e-1;
      const kktTailStopMaxViol = Number.isFinite(Number(opts?.kktTailStopMaxViol))
        ? Math.max(0, Number(opts.kktTailStopMaxViol))
        : 1.0;
      const kktStopWhenBestLeqRaw = Number(opts?.kktStopWhenBestLeq);
      const kktStopWhenBestLeq = Number.isFinite(kktStopWhenBestLeqRaw)
        ? kktStopWhenBestLeqRaw
        : null;
      const kktStopWhenBestLeqMinIter = Number.isFinite(Number(opts?.kktStopWhenBestLeqMinIter))
        ? Math.max(0, Math.floor(Number(opts.kktStopWhenBestLeqMinIter)))
        : 0;
      const kktHighViolThreshold = Number.isFinite(Number(opts?.kktHighViolThreshold))
        ? Math.max(0, Number(opts.kktHighViolThreshold))
        : 20;
      const kktHighViolImproveRatio = Number.isFinite(Number(opts?.kktHighViolImproveRatio))
        ? Math.max(0.5, Math.min(0.999, Number(opts.kktHighViolImproveRatio)))
        : 0.95;
      const kktHighViolStallWindow = Number.isFinite(Number(opts?.kktHighViolStallWindow))
        ? Math.max(5, Math.floor(Number(opts.kktHighViolStallWindow)))
        : 20;
      const kktHardIterCap = Number.isFinite(Number(opts?.kktHardIterCap))
        ? Math.max(20, Math.floor(Number(opts.kktHardIterCap)))
        : maxIterations;
      const kktMaxWallMs = Number.isFinite(Number(opts?.kktMaxWallMs))
        ? Math.max(1000, Math.floor(Number(opts.kktMaxWallMs)))
        : Number.POSITIVE_INFINITY;
      const kktNoBestImproveMinIter = Number.isFinite(Number(opts?.kktNoBestImproveMinIter))
        ? Math.max(20, Math.floor(Number(opts.kktNoBestImproveMinIter)))
        : 180;
      const kktNoBestImproveWindow = Number.isFinite(Number(opts?.kktNoBestImproveWindow))
        ? Math.max(10, Math.floor(Number(opts.kktNoBestImproveWindow)))
        : 120;
      const kktNoBestImproveRelEps = Number.isFinite(Number(opts?.kktNoBestImproveRelEps))
        ? Math.max(0, Number(opts.kktNoBestImproveRelEps))
        : 2e-4;
      const kktNoBestImproveMaxViol = Number.isFinite(Number(opts?.kktNoBestImproveMaxViol))
        ? Math.max(0, Number(opts.kktNoBestImproveMaxViol))
        : 20;
      const kktPostBestDivergenceMinIter = Number.isFinite(Number(opts?.kktPostBestDivergenceMinIter))
        ? Math.max(20, Math.floor(Number(opts.kktPostBestDivergenceMinIter)))
        : 45;
      const kktPostBestNoImproveWindow = Number.isFinite(Number(opts?.kktPostBestNoImproveWindow))
        ? Math.max(5, Math.floor(Number(opts.kktPostBestNoImproveWindow)))
        : 16;
      const kktPostBestDivergenceRatio = Number.isFinite(Number(opts?.kktPostBestDivergenceRatio))
        ? Math.max(2, Number(opts.kktPostBestDivergenceRatio))
        : 1.6;
      const kktPostBestDivergenceMaxViol = Number.isFinite(Number(opts?.kktPostBestDivergenceMaxViol))
        ? Math.max(0, Number(opts.kktPostBestDivergenceMaxViol))
        : 25;
      const kktPostBestPatienceMinIter = Number.isFinite(Number(opts?.kktPostBestPatienceMinIter))
        ? Math.max(20, Math.floor(Number(opts.kktPostBestPatienceMinIter)))
        : 38;
      const kktPostBestPatienceWindow = Number.isFinite(Number(opts?.kktPostBestPatienceWindow))
        ? Math.max(5, Math.floor(Number(opts.kktPostBestPatienceWindow)))
        : 16;
      const kktPostBestPatienceMaxViol = Number.isFinite(Number(opts?.kktPostBestPatienceMaxViol))
        ? Math.max(0, Number(opts.kktPostBestPatienceMaxViol))
        : 25;
      const kktPostBestRequiredImprovePct = Number.isFinite(Number(opts?.kktPostBestRequiredImprovePct))
        ? Math.max(0, Number(opts.kktPostBestRequiredImprovePct))
        : 95;
      const kktSoftRestartRejectStreak = Number.isFinite(Number(opts?.kktSoftRestartRejectStreak))
        ? Math.max(4, Math.floor(Number(opts.kktSoftRestartRejectStreak)))
        : 12;
      const kktSoftRestartRejectStreakHighViol = Number.isFinite(Number(opts?.kktSoftRestartRejectStreakHighViol))
        ? Math.max(4, Math.floor(Number(opts.kktSoftRestartRejectStreakHighViol)))
        : 8;
      const kktSoftRestartHighViolThreshold = Number.isFinite(Number(opts?.kktSoftRestartHighViolThreshold))
        ? Math.max(0, Number(opts.kktSoftRestartHighViolThreshold))
        : 40;
      let plateauNoImproveIters = 0;
      let plateauBestRef = bestScore;
      let plateauViolRef = Number.POSITIVE_INFINITY;
      let tailNoImproveIters = 0;
      let tailBestRef = bestScore;
      let windowTailRefIter = 0;
      let windowTailRefBest = bestScore;
      let noBestImproveRef = bestScore;
      let noBestImproveIters = 0;
      let lastBestIter = 0;
      let highViolRef = Number.POSITIVE_INFINITY;
      let highViolStallIters = 0;
      const bestScoreHistory: number[] = [];
      
      // 【追加】LM法と同様に、予測精度に応じて歩幅の上限を伸縮させる適応的トラスト領域
      const kktInitialTrustRegion = Number.isFinite(Number(opts?.kktInitialTrustRegion))
        ? Math.max(0.01, Math.min(2.0, Number(opts.kktInitialTrustRegion)))
        : 0.5;
      let trustRegionDeltaEff = kktInitialTrustRegion;
      let qconStagnationRestartIndex = 0;
      
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

      // 初期値が悪いケース向け: AL開始前に軽量な近傍探索で開始点を補正
      const kktInitProbeEnabled = !hasHeavyAsyncRequirementOperands && opts?.kktInitProbe !== false;
      if (kktInitProbeEnabled && currentX.length > 0) {
        const kktInitProbeMaxVars = Number.isFinite(Number(opts?.kktInitProbeMaxVars))
          ? Math.max(1, Math.floor(Number(opts.kktInitProbeMaxVars)))
          : Math.min(16, currentX.length);
        const kktInitProbeStepScale = Number.isFinite(Number(opts?.kktInitProbeStepScale))
          ? Math.max(0.5, Number(opts.kktInitProbeStepScale))
          : 3.0;
        const kktInitProbePenalty = Number.isFinite(Number(opts?.kktInitProbePenalty))
          ? Math.max(100, Number(opts.kktInitProbePenalty))
          : 10000;

        const evalInitProbeMerit = async (xProbe: number[]) => {
          const s = await evalSQPAtX(xProbe);
          const vv = (s.constraints || []).map(c => Math.max(0, c));
          const viol = Math.sqrt(vv.reduce((acc, v) => acc + v * v, 0));
          const merit = Number(s.objective) + viol * kktInitProbePenalty;
          return {
            merit: Number.isFinite(merit) ? merit : Number.POSITIVE_INFINITY,
            objective: Number(s.objective),
            violation: viol
          };
        };

        const candidateOrder = Array.from({ length: currentX.length }, (_, idx) => ({
          idx,
          scale: Number.isFinite(Number(varScales[idx])) ? Math.abs(Number(varScales[idx])) : 1
        }))
          .sort((a, b) => b.scale - a.scale)
          .slice(0, Math.min(currentX.length, kktInitProbeMaxVars));

        const probeOriginX = currentX.slice();
        let probeBestX = currentX.slice();
        let probeBest = await evalInitProbeMerit(probeBestX);

        for (const item of candidateOrder) {
          const col = item.idx;
          const vObj = { id: varIds[col], key: vars[col]?.key, value: probeBestX[col] };
          let eps = finiteDifferenceStepForVar(vObj) * kktInitProbeStepScale;
          if (!Number.isFinite(eps) || eps <= 0) {
            eps = Math.max(1e-6, Math.abs(probeBestX[col]) * 1e-4);
          }

          for (const dir of [1, -1]) {
            const trial = probeBestX.slice();
            trial[col] = clampToBounds([trial[col] + dir * eps])[0];
            if (!Number.isFinite(trial[col]) || trial[col] === probeBestX[col]) continue;
            const trialEval = await evalInitProbeMerit(trial);
            if (trialEval.merit + 1e-12 < probeBest.merit) {
              probeBest = trialEval;
              probeBestX = trial;
            }
          }
        }

        const qconProbeColumns = candidateOrder
          .map(item => item.idx)
          .filter(col => qconVariableFlags[col]);
        if (qconProbeColumns.length > 1 && opts?.kktInitCoupledQconProbe !== false) {
          const qconNaturalScale = Math.max(
            ...qconProbeColumns.map(col => Math.abs(Number(varScales[col])) || 0)
          );
          const qconFdScale = Math.max(
            ...qconProbeColumns.map(col => {
              const variable = { id: varIds[col], key: vars[col]?.key, value: probeOriginX[col] };
              return finiteDifferenceStepForVar(variable);
            })
          );
          const amplitudeCandidates = [
            qconFdScale,
            Math.sqrt(qconFdScale * qconNaturalScale),
            qconNaturalScale,
          ]
            .filter(value => Number.isFinite(value) && value > 0)
            .filter((value, index, values) => values.findIndex(other => Math.abs(other - value) <= value * 1e-12) === index);

          for (let mode = 0; mode < qconProbeColumns.length; mode++) {
            const direction = qconProbeColumns.map((_, order) => (
              Math.cos(Math.PI * (order + 0.5) * mode / qconProbeColumns.length)
            ));
            const directionNorm = Math.max(...direction.map(value => Math.abs(value)), 1e-12);
            for (const amplitude of amplitudeCandidates) {
              for (const sign of [1, -1]) {
                const trial = probeOriginX.slice();
                for (let order = 0; order < qconProbeColumns.length; order++) {
                  const col = qconProbeColumns[order];
                  trial[col] += sign * amplitude * direction[order] / directionNorm;
                }
                const boundedTrial = clampToBounds(trial);
                const trialEval = await evalInitProbeMerit(boundedTrial);
                if (trialEval.merit + 1e-12 < probeBest.merit) {
                  probeBest = trialEval;
                  probeBestX = boundedTrial;
                }
              }
            }
          }
        }

        if (probeBest.merit + 1e-12 < bestMerit) {
          currentX = probeBestX.slice();
          bestX = probeBestX.slice();
          bestScoreXSnapshot = probeBestX.slice();
          bestMerit = probeBest.merit;
          try {
            applyXToDesignState(probeBestX);
            const seededEval = evalCompositeFromRequirementsProfiled();
            if (seededEval) {
              const seededEvalWithSnapshot = withAppliedXSnapshot(probeBestX, seededEval);
              bestEval = seededEvalWithSnapshot;
              bestScore = Number.isFinite(Number(seededEvalWithSnapshot.score)) ? Number(seededEvalWithSnapshot.score) : bestScore;
              recordEval(seededEvalWithSnapshot);
            }
          } catch (_) {}
        }
      }

      // 【Broyden準Newton更新】前回のJacobian、変位dx、残差変化drを保存
      let lastJ: number[][] | null = null;
      let lastX: number[] | null = null;
      let lastR: number[] | null = null;
      let broydenSkipCount = 0;  // Broyden更新を連続で何回使ったか

      // Unified 1-loop: iterate with immediate multiplier updates (SQP-like behavior)
      const kktBroydenMaxSkips = Number.isFinite(Number(opts?.kktBroydenMaxSkips))
        ? Math.max(2, Math.floor(Number(opts.kktBroydenMaxSkips)))
        : 40;
      const kktBroydenMaxRejectStreak = Number.isFinite(Number(opts?.kktBroydenMaxRejectStreak))
        ? Math.max(1, Math.floor(Number(opts.kktBroydenMaxRejectStreak)))
        : 8;
      const kktJacobianRefreshInterval = Number.isFinite(Number(opts?.kktJacobianRefreshInterval))
        ? Math.max(2, Math.floor(Number(opts.kktJacobianRefreshInterval)))
        : 18;
      const kktJacobianMaxReuseWithoutRefresh = Number.isFinite(Number(opts?.kktJacobianMaxReuseWithoutRefresh))
        ? Math.max(1, Math.floor(Number(opts.kktJacobianMaxReuseWithoutRefresh)))
        : 36;
      const kktJacobianRejectRefreshInterval = Number.isFinite(Number(opts?.kktJacobianRejectRefreshInterval))
        ? Math.max(2, Math.floor(Number(opts.kktJacobianRejectRefreshInterval)))
        : 10;
      const kktForceRefreshOnRejectStreak = Number.isFinite(Number(opts?.kktForceRefreshOnRejectStreak))
        ? Math.max(2, Math.floor(Number(opts.kktForceRefreshOnRejectStreak)))
        : 8;
      const kktJacobianFullRefreshInterval = Number.isFinite(Number(opts?.kktJacobianFullRefreshInterval))
        ? Math.max(8, Math.floor(Number(opts.kktJacobianFullRefreshInterval)))
        : 24;
      const kktJacobianPoorModelRho = Number.isFinite(Number(opts?.kktJacobianPoorModelRho))
        ? Math.max(0, Number(opts.kktJacobianPoorModelRho))
        : 0.02;
      const kktJacobianPoorModelRelImprove = Number.isFinite(Number(opts?.kktJacobianPoorModelRelImprove))
        ? Math.max(0, Number(opts.kktJacobianPoorModelRelImprove))
        : 2e-4;
      const kktJacobianPoorModelStreakForRefresh = Number.isFinite(Number(opts?.kktJacobianPoorModelStreakForRefresh))
        ? Math.max(1, Math.floor(Number(opts.kktJacobianPoorModelStreakForRefresh)))
        : 3;
      const kktSqpScoreProbeRejectStreak = Number.isFinite(Number(opts?.kktSqpScoreProbeRejectStreak))
        ? Math.max(1, Math.floor(Number(opts.kktSqpScoreProbeRejectStreak)))
        : 1;
      const kktSqpScoreProbeMaxIter = Number.isFinite(Number(opts?.kktSqpScoreProbeMaxIter))
        ? Math.max(0, Math.floor(Number(opts.kktSqpScoreProbeMaxIter)))
        : 10;
      const kktSqpScoreProbeMinViolation = Number.isFinite(Number(opts?.kktSqpScoreProbeMinViolation))
        ? Math.max(0, Number(opts.kktSqpScoreProbeMinViolation))
        : 0.02;
      const kktSqpScoreProbeMaxVariables = Number.isFinite(Number(opts?.kktSqpScoreProbeMaxVariables))
        ? Math.max(1, Math.floor(Number(opts.kktSqpScoreProbeMaxVariables)))
        : 12;
      const kktSqpScoreProbeMinColumns = Number.isFinite(Number(opts?.kktSqpScoreProbeMinColumns))
        ? Math.max(1, Math.floor(Number(opts.kktSqpScoreProbeMinColumns)))
        : 2;
      const kktSqpScoreProbeEarlyExitDxRatio = Number.isFinite(Number(opts?.kktSqpScoreProbeEarlyExitDxRatio))
        ? Math.max(0, Math.min(1, Number(opts.kktSqpScoreProbeEarlyExitDxRatio)))
        : 0.35;
      const kktSqpScoreProbeEarlyAcceptRelImprove = Number.isFinite(Number(opts?.kktSqpScoreProbeEarlyAcceptRelImprove))
        ? Math.max(0, Number(opts.kktSqpScoreProbeEarlyAcceptRelImprove))
        : 0.002;
      const kktSqpScoreProbeAutoCap = opts?.kktSqpScoreProbeAutoCap !== false;
      const kktSqpLookaheadRejectStreakLimit = Number.isFinite(Number(opts?.kktSqpLookaheadRejectStreakLimit))
        ? Math.max(0, Math.floor(Number(opts.kktSqpLookaheadRejectStreakLimit)))
        : 0;
      const kktStrictRefineTailStartIter = Number.isFinite(Number(opts?.kktStrictRefineTailStartIter))
        ? Math.max(0, Math.floor(Number(opts.kktStrictRefineTailStartIter)))
        : 8;
      const kktStrictRefineTailMaxViolation = Number.isFinite(Number(opts?.kktStrictRefineTailMaxViolation))
        ? Math.max(0, Number(opts.kktStrictRefineTailMaxViolation))
        : 1.0;
      const kktStrictRefineTailRejectStreak = Number.isFinite(Number(opts?.kktStrictRefineTailRejectStreak))
        ? Math.max(0, Math.floor(Number(opts.kktStrictRefineTailRejectStreak)))
        : 1;
      let jacobianReuseSinceRefresh = 0;
      let forceJacobianRefreshNextIter = false;
      let poorModelStreak = 0;
      let sqpBfgsHessian: number[][] | null = null;
      let sqpBfgsPreviousX: number[] | null = null;
      let sqpBfgsPreviousObjectiveGradient: number[] | null = null;
      let sqpBfgsPreviousConstraintJacobian: number[][] | null = null;
      let sqpBfgsUpdatePending = false;
      const resetSqpBfgsState = () => {
        sqpBfgsHessian = null;
        sqpBfgsPreviousX = null;
        sqpBfgsPreviousObjectiveGradient = null;
        sqpBfgsPreviousConstraintJacobian = null;
        sqpBfgsUpdatePending = false;
      };

      for (let iter = 0; iter < maxIterations; iter++) {
        completedIterations = iter + 1;
        const __iterT0 = nowMs();
        let postEvalCached: any = null;
        let samplingTransitionEval: any = null;
        // 【高速化】受理時に評価した composite を反復末尾の進捗評価で再利用するためのキャッシュ。
        // 設計変数が変化する経路（stagnation auto-restart）では null に戻して無効化する。
        let iterAcceptedCompositeEval: any = null;
        try {
          await maybeYieldKktCpu();
          if (shouldStopKKT()) {
            break;
          }
          if (kktAutoStopEnabled && iter >= kktHardIterCap) {
            break;
          }
          const elapsedMs = nowMs() - t0;
          if (kktAutoStopEnabled && elapsedMs >= kktMaxWallMs) {
            break;
          }

          const desiredSpotRayCount = adaptiveSpotRayCountAtIteration(spotSamplingPlan, iter);
          if (desiredSpotRayCount !== activeSpotRayCount) {
            activeSpotRayCount = desiredSpotRayCount;
            try {
              const fastMode = (globalThis as any).__cooptMeritFastMode;
              if (fastMode && typeof fastMode === 'object') {
                fastMode.spotRayCount = activeSpotRayCount;
                fastMode.spotAnnularRingCount = activeSpotAnnularRingCount();
              }
            } catch (_) {}

            lastJ = null;
            lastX = null;
            lastR = null;
            broydenSkipCount = 0;
            jacobianReuseSinceRefresh = 0;
            forceJacobianRefreshNextIter = true;
            poorModelStreak = 0;
            resetSqpBfgsState();
            kktRejectStreak = 0;
            nonmonotoneAcceptStreak = 0;
            trustRegionDeltaEff = kktInitialTrustRegion;
            lambdaVec = [];

            bestFeasibleEval = null;
            bestInfeasibleEval = null;
            bestScoreEval = null;
            bestScoreBlocksSnapshot = null;
            applyXToDesignState(currentX);
            samplingTransitionEval = await evalSQPAtX(currentX);
            const rebasedEval = withAppliedXSnapshot(
              currentX,
              kktEvaluationToComposite(samplingTransitionEval),
            );
            recordEval(rebasedEval);
            bestX = currentX.slice();
            bestScoreXSnapshot = currentX.slice();
            bestScore = Number.isFinite(Number(rebasedEval?.score))
              ? Number(rebasedEval.score)
              : Number.POSITIVE_INFINITY;
            bestEval = rebasedEval;
            lastAcceptedScore = bestScore;
            const rebasedConstraints = (samplingTransitionEval?.constraints || []).map(c => Math.max(0, Number(c) || 0));
            const rebasedViolation = Math.sqrt(rebasedConstraints.reduce((acc, value) => acc + value * value, 0));
            const rebasedObjective = Number(samplingTransitionEval?.objective);
            bestMerit = (Number.isFinite(rebasedObjective) ? rebasedObjective : Number.POSITIVE_INFINITY)
              + rebasedViolation * 10000;
            lastMaxViol = Number.POSITIVE_INFINITY;
            violStagnationIter = 0;
            prevConvCost = Number.POSITIVE_INFINITY;
            feasibleConvStreak = 0;
            stagnationIter = 0;
            plateauNoImproveIters = 0;
            plateauBestRef = bestScore;
            plateauViolRef = Number.POSITIVE_INFINITY;
            tailNoImproveIters = 0;
            tailBestRef = bestScore;
            windowTailRefIter = iter;
            windowTailRefBest = bestScore;
            noBestImproveRef = bestScore;
            noBestImproveIters = 0;
            lastBestIter = iter;
            highViolRef = Number.POSITIVE_INFINITY;
            highViolStallIters = 0;
            bestScoreHistory.length = 0;
          }

        // Check current feasibility
        const preEval = samplingTransitionEval || await evalSQPAtX(currentX);
        const preFeasible = preEval.feasible || (preEval.constraints || []).every(c => c <= 1e-3);
        
        // 【追加】現在の最大制約違反を計算（適応的beta用）
        const currentConstraints = preEval.constraints || [];
        const currentMaxViol = currentConstraints.length > 0 
          ? Math.max(0, ...currentConstraints) 
          : 0;

        const periodicFullSweepDue = (iter % kktPeriodicFullSweepEvery) === 0;
        kktForceFullOperandSweep = periodicFullSweepDue;
        if (periodicFullSweepDue) {
          kktPriorityOperandKeys = new Set<string>();
        } else {
          const sortedPriorityKeys = Array.from(kktOperandPriorityScores.entries())
            .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
            .slice(0, kktPriorityOperandTopK)
            .map(([key]) => key);
          kktPriorityOperandKeys = new Set<string>(sortedPriorityKeys);
        }
        if (__profile?.counts) {
          if (periodicFullSweepDue) {
            __profile.counts.kktPriorityFullSweeps = (Number(__profile.counts.kktPriorityFullSweeps) || 0) + 1;
          } else {
            __profile.counts.kktPrioritySelectiveSweeps = (Number(__profile.counts.kktPrioritySelectiveSweeps) || 0) + 1;
            __profile.counts.kktPriorityOperandKeys = (Number(__profile.counts.kktPriorityOperandKeys) || 0) + kktPriorityOperandKeys.size;
          }
        }

        // --- 1. Compute residuals and Jacobian ---
        const aug0 = await evalAugmentedResiduals(currentX, lambdaVec, mu, currentMaxViol);
        const r0 = aug0.residuals;
        const cost0 = useKktSqp
          ? evaluateSqpFilterMerit(preEval, mu)
          : r0.reduce((acc, v) => acc + v * v, 0);
        const score0 = Number.isFinite(Number(preEval.requirementScore)) ? Number(preEval.requirementScore) : objectiveForKKT(currentX);
        if (!Number.isFinite(cost0)) break;

        const n = currentX.length;
        const m = r0.length;
        
        // 【Broyden準Newton更新】条件：前回のデータがある、連続6回未満、ステップが十分に受け入れられている
        // 【修正】連続適用回数を増やし、積極的にヤコビアン計算をスキップする
        const hasReusableJacobian = !!(lastJ && lastJ[0] && lastJ[0].length === n);
        const prevJ = hasReusableJacobian ? lastJ : null;
        const prevX = Array.isArray(lastX) ? lastX : null;
        const prevR = Array.isArray(lastR) ? lastR : null;
        const canUseBroyden = !!(prevJ && prevX && prevR &&
                  prevX.length === n && prevR.length === m &&
                  broydenSkipCount < kktBroydenMaxSkips &&
                  kktRejectStreak < kktBroydenMaxRejectStreak);

        const jacobianRefreshMaxCols = Number.isFinite(Number(opts?.kktJacobianRefreshMaxCols))
          ? Math.max(1, Math.floor(Number(opts.kktJacobianRefreshMaxCols)))
          : Math.max(3, Math.floor(n / 5));
        const jacobianPeriodicRefreshDue = (iter % kktJacobianRefreshInterval) === 0;
        const jacobianRefreshDueToReuseCap = jacobianReuseSinceRefresh >= kktJacobianMaxReuseWithoutRefresh;
        const jacobianRejectRefreshDue = kktRejectStreak > 0 && (kktRejectStreak % kktJacobianRejectRefreshInterval) === 0;
        const shouldRunFiniteDiffRefresh = forceJacobianRefreshNextIter || jacobianPeriodicRefreshDue || jacobianRefreshDueToReuseCap || jacobianRejectRefreshDue;
        const shouldRunFullJacobianRefresh = hasReusableJacobian && iter > 0 && (iter % kktJacobianFullRefreshInterval) === 0;
        
        let J: number[][];
        if (canUseBroyden && !shouldRunFiniteDiffRefresh && prevJ && prevX && prevR) {
          // Broydenランク1更新: J_new = J_old + (dr - J_old*dx) * dx^T / (dx^T dx)
          const dx = currentX.map((xi, i) => xi - prevX[i]);
          const dr = r0.map((ri, i) => ri - prevR[i]);
          
          const dxNorm2 = dx.reduce((acc, v) => acc + v * v, 0);
          if (dxNorm2 > 1e-18) {
            J = prevJ.map(row => row.slice());  // Deep copy
            
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
            
          } else {
            // dx too small, fall back to finite difference
            if (hasReusableJacobian) {
              if (shouldRunFiniteDiffRefresh) {
                if (shouldRunFullJacobianRefresh) {
                  J = await finiteDiffJacobian(currentX, r0, lambdaVec, mu, currentMaxViol, aug0.base?.residuals?.length || 0);
                } else {
                  const refreshCols = pickJacobianRefreshColumns(currentX, prevX, jacobianRefreshMaxCols);
                  J = await finiteDiffJacobianPartial(currentX, r0, lambdaVec, mu, currentMaxViol, prevJ, refreshCols, aug0.base?.residuals?.length || 0);
                }
                jacobianReuseSinceRefresh = 0;
                forceJacobianRefreshNextIter = false;
              } else {
                J = prevJ.map(row => row.slice());
                jacobianReuseSinceRefresh++;
                if (__profile && __profile.counts) {
                  __profile.counts.kktJacobianReuseCalls = (Number(__profile.counts.kktJacobianReuseCalls) || 0) + 1;
                }
              }
            } else {
              J = await finiteDiffJacobian(currentX, r0, lambdaVec, mu, currentMaxViol, aug0.base?.residuals?.length || 0);
              jacobianReuseSinceRefresh = 0;
            }
            broydenSkipCount = 0;
            lastJ = J;
          }
        } else {
          // Full finite difference Jacobian
          if (hasReusableJacobian) {
            if (shouldRunFiniteDiffRefresh) {
              if (shouldRunFullJacobianRefresh) {
                J = await finiteDiffJacobian(currentX, r0, lambdaVec, mu, currentMaxViol, aug0.base?.residuals?.length || 0);
              } else {
                const refreshCols = pickJacobianRefreshColumns(currentX, prevX, jacobianRefreshMaxCols);
                J = await finiteDiffJacobianPartial(currentX, r0, lambdaVec, mu, currentMaxViol, prevJ, refreshCols, aug0.base?.residuals?.length || 0);
              }
              jacobianReuseSinceRefresh = 0;
              forceJacobianRefreshNextIter = false;
            } else {
              J = prevJ.map(row => row.slice());
              jacobianReuseSinceRefresh++;
              if (__profile && __profile.counts) {
                __profile.counts.kktJacobianReuseCalls = (Number(__profile.counts.kktJacobianReuseCalls) || 0) + 1;
              }
            }
          } else {
            J = await finiteDiffJacobian(currentX, r0, lambdaVec, mu, currentMaxViol, aug0.base?.residuals?.length || 0);
            jacobianReuseSinceRefresh = 0;
          }
          broydenSkipCount = 0;
          lastJ = J;

        }
        
        J = sanitizeJacobianRows(J, m, n);

        // Save current state for next Broyden update
        lastX = currentX.slice();
        lastR = r0.slice();
        
        const useWasmPilotOptimizer = opts?.kktUseWasmPilotOptimizer !== false;
        let dx: number[] | null = null;
        let predictedReductionPilot = Number.NaN;
        let sqpActiveConstraintIndices: number[] = [];
        let sqpCandidateMultipliers: number[] | null = null;
        let sqpModelHessian: number[][] | null = null;
        let sqpModelGradient: number[] | null = null;

        if (useKktSqp) {
          const objectiveRowCount = Math.max(0, Math.min(m, Number(aug0.baseResidualCount) || 0));
          const objectiveJacobian = J.slice(0, objectiveRowCount);
          const objectiveResiduals = r0.slice(0, objectiveRowCount);
          const hessian = Array.from({ length: n }, () => Array(n).fill(0));
          const gradient = new Array(n).fill(0);

          for (let row = 0; row < objectiveRowCount; row++) {
            const residual = Number(objectiveResiduals[row]) || 0;
            for (let col = 0; col < n; col++) {
              const jac = Number(objectiveJacobian[row]?.[col]) || 0;
              gradient[col] += jac * residual;
              for (let col2 = 0; col2 < n; col2++) {
                hessian[col][col2] += jac * (Number(objectiveJacobian[row]?.[col2]) || 0);
              }
            }
          }

          const constraints = Array.isArray(aug0.base?.constraints) ? aug0.base.constraints : [];
          const activeTolerance = Number.isFinite(Number(opts?.kktSqpActiveTolerance))
            ? Math.max(0, Number(opts.kktSqpActiveTolerance))
            : 1e-5;
          const violatedConstraintCount = constraints.reduce(
            (count, value) => count + (Number(value) > activeTolerance ? 1 : 0),
            0
          );
          const useElasticRestorationStep = violatedConstraintCount > n;
          sqpActiveConstraintIndices = constraints
            .map((value, index) => ({ index, value: Number(value) || 0, multiplier: Math.max(0, Number(lambdaVec?.[index]) || 0) }))
            .filter(item => !useElasticRestorationStep && (item.value >= -activeTolerance || item.multiplier > 1e-10))
            .sort((a, b) => b.value - a.value)
            .slice(0, n)
            .map(item => item.index);

          const constraintJacobian = sqpActiveConstraintIndices.map(index =>
            J[objectiveRowCount + index]?.slice() || new Array(n).fill(0)
          );
          const constraintValues = sqpActiveConstraintIndices.map(index => Number(constraints[index]) || 0);
          const lagrangianGradient = gradient.slice();
          for (let constraintIndex = 0; constraintIndex < constraints.length; constraintIndex++) {
            const multiplier = Math.max(0, Number(lambdaVec?.[constraintIndex]) || 0);
            const jacobianRow = J[objectiveRowCount + constraintIndex] || [];
            for (let col = 0; col < n; col++) {
              lagrangianGradient[col] += multiplier * (Number(jacobianRow[col]) || 0);
            }
          }

          if (kktSqpUseBfgs) {
            const canApplyBfgsUpdate = sqpBfgsUpdatePending
              && sqpBfgsHessian?.length === n
              && sqpBfgsPreviousX?.length === n
              && sqpBfgsPreviousObjectiveGradient?.length === n
              && Array.isArray(sqpBfgsPreviousConstraintJacobian);
            if (canApplyBfgsUpdate) {
              const previousLagrangianGradient = sqpBfgsPreviousObjectiveGradient!.slice();
              for (let constraintIndex = 0; constraintIndex < constraints.length; constraintIndex++) {
                const multiplier = Math.max(0, Number(lambdaVec?.[constraintIndex]) || 0);
                const previousJacobianRow = sqpBfgsPreviousConstraintJacobian![constraintIndex] || [];
                for (let col = 0; col < n; col++) {
                  previousLagrangianGradient[col] += multiplier * (Number(previousJacobianRow[col]) || 0);
                }
              }
              const step = currentX.map((value, index) => value - Number(sqpBfgsPreviousX?.[index]));
              const gradientDelta = lagrangianGradient.map((value, index) => (
                value - Number(previousLagrangianGradient[index])
              ));
              const updatedHessian = updatePowellDampedBfgs(sqpBfgsHessian!, step, gradientDelta);
              if (updatedHessian) {
                const normalizedScore = Number.isFinite(score0) && Number.isFinite(initialScore) && Math.abs(initialScore) > 1e-12
                  ? Math.max(0, Math.min(1, Math.abs(score0) / Math.abs(initialScore)))
                  : 1;
                const effectiveBfgsBlend = kktSqpBfgsAdaptiveBlend
                  ? (normalizedScore <= kktSqpBfgsConservativeScoreRatio
                    ? kktSqpBfgsMinBlend
                    : kktSqpBfgsBlend)
                  : kktSqpBfgsBlend;
                sqpBfgsHessian = updatedHessian.map((row, rowIndex) => row.map((value, colIndex) => (
                  effectiveBfgsBlend * value
                  + (1 - effectiveBfgsBlend) * hessian[rowIndex][colIndex]
                )));
              }
            } else {
              sqpBfgsHessian = hessian.map(row => row.slice());
            }
            sqpBfgsPreviousX = currentX.slice();
            sqpBfgsPreviousObjectiveGradient = gradient.slice();
            sqpBfgsPreviousConstraintJacobian = constraints.map((_, constraintIndex) => (
              J[objectiveRowCount + constraintIndex]?.slice() || new Array(n).fill(0)
            ));
            sqpBfgsUpdatePending = false;
          }

          const qpHessian = kktSqpUseBfgs && sqpBfgsHessian
            ? sqpBfgsHessian
            : hessian;
          lmDampHessianScale = sqpHessianDiagonalScale(qpHessian);
          sqpModelHessian = qpHessian;
          sqpModelGradient = gradient;
          const qpDamping = Math.max(1e-12, lmDamp);
          let qpResult = constraintJacobian.length > 0
            ? solveQpSubproblemKktEqualityWasm(qpHessian, gradient, constraintJacobian, constraintValues, qpDamping)
            : solveQpSubproblemUnconstrainedWasm(qpHessian, gradient, qpDamping);

          if (!qpResult) {
            const constraintCount = constraintJacobian.length;
            const systemSize = n + constraintCount;
            const kktMatrix = Array.from({ length: systemSize }, () => Array(systemSize).fill(0));
            const rhs = new Array(systemSize).fill(0);
            for (let row = 0; row < n; row++) {
              rhs[row] = -gradient[row];
              for (let col = 0; col < n; col++) {
                kktMatrix[row][col] = qpHessian[row][col] + (row === col ? qpDamping : 0);
              }
              for (let active = 0; active < constraintCount; active++) {
                kktMatrix[row][n + active] = Number(constraintJacobian[active]?.[row]) || 0;
              }
            }
            for (let active = 0; active < constraintCount; active++) {
              rhs[n + active] = -constraintValues[active];
              for (let col = 0; col < n; col++) {
                kktMatrix[n + active][col] = Number(constraintJacobian[active]?.[col]) || 0;
              }
            }
            const solution = solveLinearSystemWithOptionalWasm(kktMatrix, rhs, false);
            if (Array.isArray(solution) && solution.length === systemSize) {
              const fallbackDx = solution.slice(0, n);
              let modelChange = 0;
              for (let row = 0; row < n; row++) {
                modelChange += gradient[row] * fallbackDx[row];
                for (let col = 0; col < n; col++) {
                  modelChange += 0.5 * fallbackDx[row] * qpHessian[row][col] * fallbackDx[col];
                }
              }
              qpResult = { dx: fallbackDx, predictedReduction: -modelChange };
            }
          }

          if (qpResult && Array.isArray(qpResult.dx) && qpResult.dx.length === n) {
            dx = qpResult.dx.slice();
            predictedReductionPilot = Number(qpResult.predictedReduction);

            sqpCandidateMultipliers = new Array(constraints.length).fill(0);
            if (constraintJacobian.length > 0) {
              const stationarityWithoutMultipliers = new Array(n).fill(0);
              for (let row = 0; row < n; row++) {
                let value = gradient[row];
                for (let col = 0; col < n; col++) {
                  value += qpHessian[row][col] * dx[col];
                }
                stationarityWithoutMultipliers[row] = value;
              }
              const multiplierMatrix = Array.from(
                { length: constraintJacobian.length },
                () => Array(constraintJacobian.length).fill(0)
              );
              const multiplierRhs = new Array(constraintJacobian.length).fill(0);
              for (let active = 0; active < constraintJacobian.length; active++) {
                for (let col = 0; col < n; col++) {
                  multiplierRhs[active] -= constraintJacobian[active][col] * stationarityWithoutMultipliers[col];
                }
                for (let active2 = 0; active2 < constraintJacobian.length; active2++) {
                  let dotProduct = 0;
                  for (let col = 0; col < n; col++) {
                    dotProduct += constraintJacobian[active][col] * constraintJacobian[active2][col];
                  }
                  multiplierMatrix[active][active2] = dotProduct + (active === active2 ? 1e-12 : 0);
                }
              }
              const activeMultipliers = solveLinearSystemWithOptionalWasm(multiplierMatrix, multiplierRhs, true);
              if (Array.isArray(activeMultipliers)) {
                for (let active = 0; active < activeMultipliers.length; active++) {
                  const constraintIndex = sqpActiveConstraintIndices[active];
                  sqpCandidateMultipliers[constraintIndex] = Math.max(0, Number(activeMultipliers[active]) || 0);
                }
              }
            }
          }
        }

        if (useKktSqp && !dx) {
          const failedSolveDamping = updateAdaptiveSqpDamping(
            { damping: lmDamp, rejectMultiplier: lmDampRejectMultiplier },
            {
              accepted: false,
              gainRatio: 0,
              hessianScale: lmDampHessianScale,
            },
          );
          lmDamp = failedSolveDamping.damping;
          lmDampRejectMultiplier = failedSolveDamping.rejectMultiplier;
          forceJacobianRefreshNextIter = true;
          lastJ = null;
          lastX = null;
          lastR = null;
          resetSqpBfgsState();
          continue;
        }

        if (!useKktSqp && kktUseMatrixFreeCore && kktMatrixFreePriority) {
          try {
            const matrixFree = solveNormalEqMatrixFreeWithOptionalWasm(J, r0, lmDamp, n);
            if (matrixFree && Array.isArray(matrixFree.dx) && matrixFree.dx.length === n) {
              dx = matrixFree.dx.slice();
              predictedReductionPilot = Number(matrixFree.predictedReduction);
            }
          } catch (_) {
            // reason classification is handled in solveNormalEqMatrixFreeWithOptionalWasm
          }
        }

        if (!useKktSqp && useWasmPilotOptimizer && !dx) {
          if (__profile && __profile.counts) {
            __profile.counts.kktWasmPilotCalls = (Number(__profile.counts.kktWasmPilotCalls) || 0) + 1;
          }
          try {
            const fdSteps = new Float64Array(n);
            for (let col = 0; col < n; col++) {
              if ((col & 7) === 0) await maybeYieldKktCpu();
              const vObj = { id: varIds[col], key: vars[col]?.key, value: currentX[col] };
              let h = finiteDifferenceStepForVar(vObj);
              const xcol = Number(currentX[col]);
              if (!Number.isFinite(h) || h === 0 || xcol + h === xcol) {
                h = Math.max(1e-8, Math.abs(xcol) * 1e-6);
              }
              fdSteps[col] = h;
            }

            // Phase B残り2: 等式行対応列のFD評価スキップ
            const analyticEqualityUsedVarIdxs = new Set<number>();
            for (const spec of (analyticEqualityRowSpecs || [])) {
              const terms = Array.isArray(spec?.terms) ? spec.terms : [];
              for (const term of terms) {
                const col = Number(term?.varIdx);
                if (col >= 0 && col < n) {
                  analyticEqualityUsedVarIdxs.add(col);
                }
              }
            }

            const residualsPerturbedFlat = new Float64Array(m * n);
            let fdEvaluatedCols = 0;
            for (let col = 0; col < n; col++) {
              if ((col & 7) === 0) await maybeYieldKktCpu();
              const base = col * m;
              if (analyticEqualityUsedVarIdxs.has(col)) {
                // 等式行対応列: FD予測値をスキップ（基準値のまま）
                for (let row = 0; row < m; row++) {
                  residualsPerturbedFlat[base + row] = r0[row];
                }
              } else {
                const h = Number(fdSteps[col]);
                for (let row = 0; row < m; row++) {
                  residualsPerturbedFlat[base + row] = r0[row] + J[row][col] * h;
                }
                fdEvaluatedCols++;
              }
            }
            if (__profile && __profile.counts) {
              __profile.counts.kktFiniteDiffColumnsEvaluated = (Number(__profile.counts.kktFiniteDiffColumnsEvaluated) || 0) + fdEvaluatedCols;
            }

            const currentXVec = Float64Array.from(currentX);
            const residual0Vec = Float64Array.from(r0);
            const varScalesVec = Float64Array.from(trustScales);

            const pilotResult = __profileBucketWrap('time_wasm_call', () => optimizeSystemOneIterationWasm({
              x: currentXVec,
              steps: fdSteps,
              residual0: residual0Vec,
              residualsPerturbed: residualsPerturbedFlat,
              damping: lmDamp,
              trustRegionRadius: Math.max(1e-4, trustRegionDeltaEff),
              varScales: varScalesVec
            }));

            if (__profile && __profile.counts) {
              try {
                const dbg = getOptimizerWasmBridgeDebugInfo();
                const bufferAttempted = dbg?.lastPilotBufferAttempted === true;
                const bufferPath = String(dbg?.lastPilotPath || 'none');
                const bufferStatusRaw = dbg?.lastPilotBufferStatus;
                const bufferStatus = bufferStatusRaw == null ? null : String(bufferStatusRaw);
                if (bufferAttempted) {
                  __profile.counts.kktWasmBufferCalls = (Number(__profile.counts.kktWasmBufferCalls) || 0) + 1;
                  if (bufferPath === 'buffer') {
                    __profile.counts.kktWasmBufferHits = (Number(__profile.counts.kktWasmBufferHits) || 0) + 1;
                  } else {
                    __profile.counts.kktWasmBufferFallbacks = (Number(__profile.counts.kktWasmBufferFallbacks) || 0) + 1;
                    const histogram = (__profile.counts.kktWasmBufferStatusHistogram && typeof __profile.counts.kktWasmBufferStatusHistogram === 'object')
                      ? __profile.counts.kktWasmBufferStatusHistogram
                      : (__profile.counts.kktWasmBufferStatusHistogram = {});
                    const key = String(bufferStatus || 'unknown');
                    histogram[key] = (Number(histogram[key]) || 0) + 1;
                  }
                }
              } catch (_) {}
            }

            if (pilotResult && pilotResult.ok && Array.isArray(pilotResult.dx) && pilotResult.dx.length === n) {
              dx = pilotResult.dx.slice();
              predictedReductionPilot = Number(pilotResult.predictedReduction);
              if (__profile && __profile.counts) {
                __profile.counts.kktWasmPilotHits = (Number(__profile.counts.kktWasmPilotHits) || 0) + 1;
              }
            }
          } catch (_) {}
        }

        if (!useKktSqp && useWasmPilotOptimizer && !dx && __profile && __profile.counts) {
          __profile.counts.kktWasmPilotFallbacks = (Number(__profile.counts.kktWasmPilotFallbacks) || 0) + 1;
          try {
            const dbg = getOptimizerWasmBridgeDebugInfo();
            const reason = String(dbg?.lastPilotReason || 'unknown');
            const detail = dbg?.lastPilotErrorDetail;
            __profile.counts.kktWasmPilotLastReason = detail ? `${reason}: ${String(detail)}` : reason;
            if (!kktWasmPilotFallbackLogged) {
              kktWasmPilotFallbackLogged = true;
              console.warn('[WASM-PILOT] Falling back to JS/TS step solve', {
                iter,
                reason,
                detail: detail ? String(detail) : null,
                lastPilotPath: dbg?.lastPilotPath || 'none',
                lastPilotBufferAttempted: dbg?.lastPilotBufferAttempted === true,
                lastPilotBufferStatus: dbg?.lastPilotBufferStatus ?? null,
              });
            }
          } catch (_) {
            __profile.counts.kktWasmPilotLastReason = 'reason-read-failed';
          }
        }

        if (!useKktSqp && !dx && kktUseMatrixFreeCore) {
          try {
            const matrixFree = solveNormalEqMatrixFreeWithOptionalWasm(J, r0, lmDamp, n);
            if (matrixFree && Array.isArray(matrixFree.dx) && matrixFree.dx.length === n) {
              dx = matrixFree.dx.slice();
              predictedReductionPilot = Number(matrixFree.predictedReduction);
            }
          } catch (_) {
            // reason classification is handled in solveNormalEqMatrixFreeWithOptionalWasm
          }
        }

        // --- 2. Build normal equations: A = J^T J, g = J^T r ---
        let A: number[][] | null = null;
        let g: number[] | null = null;
        let Ad: number[][] | null = null;
        if (!dx) {
          const ne = buildNormalEquationsWithOptionalWasm(J, r0, m, n);
          A = ne.A;
          g = ne.g;
        }
        
        // 【追加】LM法と同様に、非球面係数の暴走を防ぐティコノフ正則化を導入
        // これにより、高次非球面がノイズに過剰反応してストールするのを防ぎます
        if (!dx && A && asphericRegularization > 0) {
          for (let i = 0; i < n; i++) {
            if (isAsphereCoefKey(vars[i]?.key)) {
              A[i][i] += asphericRegularization;
            }
          }
        }
        
        // --- 3. Apply Levenberg-Marquardt damping with Jacobi Preconditioning ---
        // 【修正】Aの要素が10^24等になるような場合、浮動小数点精度（約16桁）を完全に超えて破綻するため、
        // 対角成分が1.0になるように行列をスケール（事前処理）してから解く
        if (!dx) {
          const scaleD = new Array(n);
          for (let i = 0; i < n; i++) {
            const d = A![i][i];
            scaleD[i] = (d > 1e-30) ? 1.0 / Math.sqrt(Math.abs(d)) : 1.0;
          }
        
          Ad = Array.from({ length: n }, () => Array(n).fill(0));
          for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
              Ad[i][j] = A![i][j] * scaleD[i] * scaleD[j];
            }
            // 対角成分は 1.0 になるので、そこにダンピングを足す
            Ad[i][i] = 1.0 + lmDamp;  
          }
        
          const b_scaled = g!.map((v, i) => -v * scaleD[i]);
        
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
            dx_scaled = solveLinearSystemWithOptionalWasm(Ad, b_scaled, true);
          }
          if (!dx_scaled) {
            // Matrix solver failed: increase damping significantly and retry
            lmDamp = Math.min(1e12, lmDamp * 20);  // Increased multiplier from 10
            continue;
          }

          // スケールを元に戻して、元の変数空間の探索方向 dx を得る
          dx = new Array(n);
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
            continue;
          }
        }

        if (!dx || dx.length !== n) {
          lmDamp = Math.min(1e12, lmDamp * 5);
          continue;
        }

        // --- 4. Apply trust region ---
        let maxAbs = 0;
        for (let i = 0; i < n; i++) {
          const si = trustScales[i] || 1;
          const di = dx[i] / si;
          maxAbs = Math.max(maxAbs, Math.abs(di));
        }
        
        if (maxAbs < 1e-8 && lmDamp > 1e-3) {
          const resetDamping = initializeAdaptiveSqpDamping(
            2e-4,
            lmDampHessianScale,
            2e-4,
          );
          lmDamp = resetDamping.damping;
          lmDampRejectMultiplier = resetDamping.rejectMultiplier;
          forceJacobianRefreshNextIter = true;
          continue;
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
        const meritGrad0 = new Array(n).fill(0);
        for (let j = 0; j < n; j++) {
          let gj = 0;
          for (let i = 0; i < m; i++) {
            gj += J[i][j] * r0[i];
          }
          meritGrad0[j] = 2 * gj;
        }

        const kktSqpLineSearchMaxBacktrack = Number.isFinite(Number(opts?.kktSqpLineSearchMaxBacktrack))
          ? Math.max(1, Math.floor(Number(opts.kktSqpLineSearchMaxBacktrack)))
          : Math.min(2, lineSearchMaxBacktrack);
        const kktSqpStepLookahead = useKktSqp && opts?.kktSqpStepLookahead !== false;
        const alphas = buildSqpLineSearchAlphas(
          useKktSqp ? kktSqpLineSearchMaxBacktrack : lineSearchMaxBacktrack,
          kktSqpStepLookahead,
        );
        const recoveryAlphas = useKktSqp ? [1, 0.5] : alphas;
        
        let accepted = false;
        let nextX = currentX.slice();
        let acceptedCost = cost0;
        let acceptedScore = score0;
        let acceptedRho = 0;
        let acceptedAlpha = 1;
        let acceptedDxStep: number[] | null = null;
        let acceptedSqpModelStep = false;
        let acceptedMaxViolation = currentMaxViol;
        let acceptedBaseEval: any = null;
        let allowSqpLookahead = false;
        // 【追加】LM法と同じく、二次モデルによる予測減少量(pred)を計算する関数
        const predictedReductionForStep = (dxStep: number[]) => {
          try {
            if (useKktSqp && kktSqpExactScaledModelPrediction && sqpModelHessian && sqpModelGradient) {
              let linearTerm = 0;
              let quadraticTerm = 0;
              for (let row = 0; row < n; row++) {
                linearTerm += dxStep[row] * sqpModelGradient[row];
                for (let col = 0; col < n; col++) {
                  quadraticTerm += 0.5 * dxStep[row] * sqpModelHessian[row][col] * dxStep[col];
                }
              }
              const predicted = -(linearTerm + quadraticTerm);
              return Number.isFinite(predicted) ? predicted : Number.NaN;
            }
            if (Number.isFinite(predictedReductionPilot)) {
              const baseNorm = Math.sqrt(dx.reduce((acc, v) => acc + v * v, 0));
              const stepNorm = Math.sqrt(dxStep.reduce((acc, v) => acc + v * v, 0));
              if (Number.isFinite(baseNorm) && baseNorm > 1e-20 && Number.isFinite(stepNorm)) {
                return predictedReductionPilot * (stepNorm / baseNorm);
              }
              return predictedReductionPilot;
            }
            if (!A || !g) return NaN;
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
        const lineSearchCurrentXKey = buildKktXKey(currentX);
        const lineSearchTriedKeys = new Set<string>([lineSearchCurrentXKey]);
        for (const alpha of alphas) {
          const isLookaheadAlpha = useKktSqp && alpha > 1;
          if (isLookaheadAlpha && !allowSqpLookahead) continue;
          const dxStep = dx.map(v => alpha * v);
          const trialX = clampToBounds(currentX.map((x, i) => x + dxStep[i]));
          const trialKey = buildKktXKey(trialX);
          if (lineSearchTriedKeys.has(trialKey)) {
            if (__profile?.counts) {
              __profile.counts.kktLineSearchDedupSkips = (Number(__profile.counts.kktLineSearchDedupSkips) || 0) + 1;
            }
            continue;
          }
          lineSearchTriedKeys.add(trialKey);
          if (__profile && __profile.counts) {
            __profile.counts.kktCandidateEvalCount = (Number(__profile.counts.kktCandidateEvalCount) || 0) + 1;
            if (alpha < 1) {
              __profile.counts.kktLineSearchBacktracks = (Number(__profile.counts.kktLineSearchBacktracks) || 0) + 1;
            }
          }
          const actualDxStep = trialX.map((value, index) => value - currentX[index]);
          let aug1 = await evalAugmentedResiduals(trialX, lambdaVec, mu, currentMaxViol);
          let r1 = aug1.residuals;
          let cost1 = useKktSqp
            ? evaluateSqpFilterMerit(aug1.base, mu)
            : r1.reduce((acc, v) => acc + v * v, 0);
          let score1 = Number.isFinite(Number(aug1?.base?.requirementScore)) ? Number(aug1.base.requirementScore) : objectiveForKKT(trialX);
          let trialConstraints = Array.isArray(aug1?.base?.constraints) ? aug1.base.constraints : [];
          let trialMaxViol = trialConstraints.length > 0 ? Math.max(0, ...trialConstraints) : 0;
          
          lastAlpha = alpha; // Track for progress report
          
          const improvedCost = Number.isFinite(cost1) && Number.isFinite(cost0) && cost1 < (cost0 - 1e-12);
          const improvedScore = Number.isFinite(score1) && Number.isFinite(score0) && score1 < (score0 - 1e-12);
          const improvedViolation = Number.isFinite(trialMaxViol) && Number.isFinite(currentMaxViol) && trialMaxViol < (currentMaxViol - 1e-9);
          const nonWorsenedCost = Number.isFinite(cost1) && Number.isFinite(cost0) && cost1 <= (cost0 + 1e-12);
          const nonWorsenedScore = Number.isFinite(score1) && Number.isFinite(score0) && score1 <= (score0 + 1e-12);
          const nonWorsenedViolation = Number.isFinite(trialMaxViol) && Number.isFinite(currentMaxViol) && trialMaxViol <= (currentMaxViol + 1e-9);
          const becameFeasible = trialMaxViol <= 1e-6;
          const localScoreCeiling = score0 + Math.max(1, Math.abs(score0)) * kktNonmonotoneLocalScoreRel;
          const bestScoreCeiling = bestScore + Math.max(1, Math.abs(bestScore)) * kktNonmonotoneBestScoreRel;
          const boundedNonmonotoneScore = Number.isFinite(score1)
            && score1 <= localScoreCeiling
            && score1 <= bestScoreCeiling;
          const costDominantProgress = improvedCost
            && boundedNonmonotoneScore
            && kktAllowNonmonotoneScore
            && nonmonotoneAcceptStreak < 2;
          const scoreDominantProgress = improvedScore;
          const violationDominantProgress = improvedViolation && nonWorsenedCost && nonWorsenedScore;
          const safeFeasibilityTransition = becameFeasible && (nonWorsenedCost || nonWorsenedScore);
          const acceptTrial = currentConstraints.length === 0
            ? scoreDominantProgress
            : (preFeasible
              ? (costDominantProgress || scoreDominantProgress)
              : (safeFeasibilityTransition || costDominantProgress || scoreDominantProgress || violationDominantProgress));

          if (acceptTrial) {
            const strictRefineForcedSweep = (iter % kktPeriodicFullSweepEvery) === 0;
            const strictRefineTailThrottle = useKktSqp
              && iter >= kktStrictRefineTailStartIter
              && currentMaxViol <= kktStrictRefineTailMaxViolation
              && kktRejectStreak >= kktStrictRefineTailRejectStreak;
            const shouldRunStrictRefine = kktStrictRefineAcceptedCandidates
              && (preFeasible || strictRefineForcedSweep || alpha <= 1)
              && (!strictRefineTailThrottle || strictRefineForcedSweep);
            if (shouldRunStrictRefine) {
              const strictBase = await evalSQPAtXStrict(trialX);
              const strictAug = buildAugmentedResidualsFromBase(strictBase, lambdaVec, mu, currentMaxViol);
              const strictResiduals = Array.isArray(strictAug?.residuals) ? strictAug.residuals : [];
              const strictCost = useKktSqp
                ? evaluateSqpFilterMerit(strictBase, mu)
                : strictResiduals.reduce((acc, v) => acc + v * v, 0);
              const strictScore = Number.isFinite(Number(strictBase?.requirementScore))
                ? Number(strictBase.requirementScore)
                : score1;
              const strictConstraints = Array.isArray(strictBase?.constraints) ? strictBase.constraints : [];
              const strictMaxViol = strictConstraints.length > 0 ? Math.max(0, ...strictConstraints) : 0;

              const strictImprovedCost = Number.isFinite(strictCost) && Number.isFinite(cost0) && strictCost < (cost0 - 1e-12);
              const strictImprovedScore = Number.isFinite(strictScore) && Number.isFinite(score0) && strictScore < (score0 - 1e-12);
              const strictImprovedViolation = Number.isFinite(strictMaxViol) && Number.isFinite(currentMaxViol) && strictMaxViol < (currentMaxViol - 1e-9);
              const strictNonWorsenedCost = Number.isFinite(strictCost) && Number.isFinite(cost0) && strictCost <= (cost0 + 1e-12);
              const strictNonWorsenedScore = Number.isFinite(strictScore) && Number.isFinite(score0) && strictScore <= (score0 + 1e-12);
              const strictBecameFeasible = strictMaxViol <= 1e-6;
              const strictBoundedNonmonotoneScore = Number.isFinite(strictScore)
                && strictScore <= localScoreCeiling
                && strictScore <= bestScoreCeiling;
              const strictCostDominant = strictImprovedCost
                && strictBoundedNonmonotoneScore
                && kktAllowNonmonotoneScore
                && nonmonotoneAcceptStreak < 2;
              const strictScoreDominant = strictImprovedScore;
              const strictViolationDominant = strictImprovedViolation && strictNonWorsenedCost && strictNonWorsenedScore;
              const strictSafeTransition = strictBecameFeasible && (strictNonWorsenedCost || strictNonWorsenedScore);
              const strictAccept = currentConstraints.length === 0
                ? strictScoreDominant
                : (preFeasible
                  ? (strictCostDominant || strictScoreDominant)
                  : (strictSafeTransition || strictCostDominant || strictScoreDominant || strictViolationDominant));

              if (!strictAccept) {
                if (__profile?.counts) {
                  __profile.counts.kktStrictRefineRejectedCandidates = (Number(__profile.counts.kktStrictRefineRejectedCandidates) || 0) + 1;
                }
                continue;
              }

              aug1 = strictAug;
              r1 = strictResiduals;
              cost1 = strictCost;
              score1 = strictScore;
              trialConstraints = strictConstraints;
              trialMaxViol = strictMaxViol;
              if (__profile?.counts) {
                __profile.counts.kktStrictRefineAcceptedCandidates = (Number(__profile.counts.kktStrictRefineAcceptedCandidates) || 0) + 1;
              }
            }

            const replaceAccepted = !accepted || !isLookaheadAlpha || isBetterSqpLookaheadCandidate(
              { score: acceptedScore, maxViolation: acceptedMaxViolation },
              { score: score1, maxViolation: trialMaxViol },
            );
            if (isLookaheadAlpha && !replaceAccepted) break;
            accepted = true;
            acceptedSqpModelStep = useKktSqp;
            nextX = trialX;
            acceptedCost = cost1;
            acceptedScore = score1;
            acceptedAlpha = alpha;
            acceptedDxStep = actualDxStep;
            acceptedMaxViolation = trialMaxViol;
            acceptedBaseEval = aug1?.base || null;
            
            // 【追加】予測と実際の減少量の比 (rho) を計算
            const pred = predictedReductionForStep(actualDxStep);
            const act = cost0 - cost1;
            acceptedRho = (Number.isFinite(act) && Number.isFinite(pred) && pred > 1e-30) ? (act / pred) : 0;
            
            // Broyden状態の更新：次回のイテレーションで使用
            lastJ = J.map(row => row.slice()); // Deep copy
            lastX = currentX.slice();
            lastR = r0.slice();
            
            if (useKktSqp && alpha === 1) {
              allowSqpLookahead = kktSqpStepLookahead
                && improvedScore
                && nonWorsenedViolation
                && kktRejectStreak <= kktSqpLookaheadRejectStreakLimit;
              if (allowSqpLookahead) {
                if (__profile && __profile.counts) {
                  __profile.counts.kktSqpLookaheadEligible = (Number(__profile.counts.kktSqpLookaheadEligible) || 0) + 1;
                }
                continue;
              }
            }
            if (isLookaheadAlpha && __profile && __profile.counts) {
              __profile.counts.kktSqpLookaheadAccepted = (Number(__profile.counts.kktSqpLookaheadAccepted) || 0) + 1;
            }
            if (isLookaheadAlpha && alpha < 2) continue;
            break;
          }
          if (isLookaheadAlpha) break;
        }

        if (!accepted && useKktSqp && n > 0) {
          const currentXKey = lineSearchCurrentXKey;
          const recoveryTriedKeys = new Set<string>(lineSearchTriedKeys);
          const scoreDirection = buildSqpModelGradientFallbackDirection(
            sqpModelGradient,
            trustScales,
            trustRegionDeltaEff,
          );
          if (__profile && __profile.counts) {
            __profile.counts.kktSqpModelGradientFallbacks = (Number(__profile.counts.kktSqpModelGradientFallbacks) || 0) + 1;
            __profile.counts.kktSqpCentralDifferenceProbesAvoided = (Number(__profile.counts.kktSqpCentralDifferenceProbesAvoided) || 0) + 2 * n;
          }
          if (scoreDirection) {
            for (const alpha of recoveryAlphas) {
              const dxStep = scoreDirection.map(value => alpha * value);
              const trialX = clampToBounds(currentX.map((value, col) => value + dxStep[col]));
              const trialKey = buildKktXKey(trialX);
              if (recoveryTriedKeys.has(trialKey)) {
                if (__profile?.counts) {
                  __profile.counts.kktSqpRecoveryDedupSkips = (Number(__profile.counts.kktSqpRecoveryDedupSkips) || 0) + 1;
                }
                continue;
              }
              recoveryTriedKeys.add(trialKey);
              const aug1 = await evalAugmentedResiduals(trialX, lambdaVec, mu, currentMaxViol);
              const score1 = Number(aug1?.base?.requirementScore);
              lastAlpha = alpha;
              if (!Number.isFinite(score1) || score1 >= (score0 - 1e-12)) continue;
              accepted = true;
              nextX = trialX;
              acceptedCost = evaluateSqpFilterMerit(aug1.base, mu);
              acceptedScore = score1;
              acceptedAlpha = alpha;
              acceptedDxStep = dxStep.slice();
              acceptedRho = 0;
              lastJ = null;
              lastX = null;
              lastR = null;
              forceJacobianRefreshNextIter = true;
              break;
            }
          }
          const allowExpensiveScoreProbe = iter < kktSqpScoreProbeMaxIter
            || currentMaxViol >= kktSqpScoreProbeMinViolation;
          if (!accepted && (kktRejectStreak + 1) >= kktSqpScoreProbeRejectStreak && allowExpensiveScoreProbe) {
            const scoreGradient = new Array(n).fill(0);
            let coordinateBestScore = score0;
            let coordinateBestX: number[] | null = null;
            const scoreProbeRankedColumns = Array.from({ length: n }, (_, index) => ({
              index,
              absDx: Math.abs(Number(dx?.[index]) || 0),
            })).sort((lhs, rhs) => rhs.absDx - lhs.absDx);
            const maxProbeAbsDx = scoreProbeRankedColumns.length > 0
              ? Math.abs(Number(scoreProbeRankedColumns[0]?.absDx) || 0)
              : 0;
            const scoreProbeVariableOrder = scoreProbeRankedColumns.map(item => item.index);
            const autoScoreProbeCap = kktSqpScoreProbeAutoCap
              ? Math.max(
                kktSqpScoreProbeMinColumns,
                Math.min(kktSqpScoreProbeMaxVariables, Math.max(4, Math.ceil(Math.sqrt(Math.max(1, n)) * 2))),
              )
              : kktSqpScoreProbeMaxVariables;
            const scoreProbeColumns = scoreProbeVariableOrder.slice(
              0,
              Math.max(1, Math.min(n, autoScoreProbeCap)),
            );
            let scoreProbeEarlyExit = false;
            let scoreProbeExecutedEvaluations = 0;
            const scoreProbeEvalCache = new Map<string, number>();
            for (let probeIndex = 0; probeIndex < scoreProbeColumns.length; probeIndex++) {
              const col = scoreProbeColumns[probeIndex];
              const variable = { id: varIds[col], key: vars[col]?.key, value: currentX[col] };
              const step = finiteDifferenceStepForVar(variable);
              if (!Number.isFinite(step) || step <= 0) continue;
              const plusX = clampToBounds(currentX.map((value, index) => index === col ? value + step : value));
              const minusX = clampToBounds(currentX.map((value, index) => index === col ? value - step : value));
              const plusKey = buildKktXKey(plusX);
              const minusKey = buildKktXKey(minusX);
              if (plusKey === currentXKey && minusKey === currentXKey) {
                continue;
              }

              const unresolvedBatchPoints: number[][] = [];
              const unresolvedBatchKeys: string[] = [];
              if (plusKey !== currentXKey && !scoreProbeEvalCache.has(plusKey)) {
                unresolvedBatchPoints.push(plusX);
                unresolvedBatchKeys.push(plusKey);
              }
              if (minusKey !== currentXKey && minusKey !== plusKey && !scoreProbeEvalCache.has(minusKey)) {
                unresolvedBatchPoints.push(minusX);
                unresolvedBatchKeys.push(minusKey);
              }
              if (unresolvedBatchPoints.length >= 2) {
                let batchBaseEvals: any[] | null = null;
                const batchResiduals = await evalAugmentedResidualsNativeBatch(
                  unresolvedBatchPoints,
                  lambdaVec,
                  mu,
                  currentMaxViol,
                  (baseEvals) => {
                    batchBaseEvals = Array.isArray(baseEvals) ? baseEvals : null;
                  },
                );
                if (Array.isArray(batchResiduals)
                  && batchResiduals.length === unresolvedBatchPoints.length
                  && Array.isArray(batchBaseEvals)
                  && batchBaseEvals.length === unresolvedBatchPoints.length) {
                  for (let batchIndex = 0; batchIndex < unresolvedBatchKeys.length; batchIndex++) {
                    const key = unresolvedBatchKeys[batchIndex];
                    const score = Number(batchBaseEvals[batchIndex]?.requirementScore);
                    if (Number.isFinite(score)) {
                      scoreProbeEvalCache.set(key, score);
                      scoreProbeExecutedEvaluations += 1;
                    }
                  }
                  if (__profile?.counts) {
                    __profile.counts.kktSqpScoreProbeBatchPairs = (Number(__profile.counts.kktSqpScoreProbeBatchPairs) || 0) + 1;
                  }
                }
              }

              let plusScore = Number.NaN;
              let minusScore = Number.NaN;
              if (plusKey !== currentXKey) {
                if (scoreProbeEvalCache.has(plusKey)) {
                  plusScore = Number(scoreProbeEvalCache.get(plusKey));
                } else {
                  plusScore = Number((await evalSQPAtX(plusX))?.requirementScore);
                  scoreProbeEvalCache.set(plusKey, plusScore);
                  scoreProbeExecutedEvaluations += 1;
                }
              }
              if (minusKey !== currentXKey) {
                if (scoreProbeEvalCache.has(minusKey)) {
                  minusScore = Number(scoreProbeEvalCache.get(minusKey));
                } else {
                  minusScore = Number((await evalSQPAtX(minusX))?.requirementScore);
                  scoreProbeEvalCache.set(minusKey, minusScore);
                  scoreProbeExecutedEvaluations += 1;
                }
              }
              if (Number.isFinite(plusScore) && plusScore < coordinateBestScore) {
                coordinateBestScore = plusScore;
                coordinateBestX = plusX;
              }
              if (Number.isFinite(minusScore) && minusScore < coordinateBestScore) {
                coordinateBestScore = minusScore;
                coordinateBestX = minusX;
              }
              if (Number.isFinite(plusScore) && Number.isFinite(minusScore)) {
                scoreGradient[col] = (plusScore - minusScore) / (2 * step);
              }
              const probesCompleted = probeIndex + 1;
              const scoreImprovement = Number.isFinite(coordinateBestScore) && Number.isFinite(score0)
                ? Math.max(0, score0 - coordinateBestScore)
                : 0;
              const relImproveThreshold = Number.isFinite(score0)
                ? Math.max(1e-12, Math.abs(score0) * kktSqpScoreProbeEarlyAcceptRelImprove)
                : Number.POSITIVE_INFINITY;
              const probeAbsDx = Number(scoreProbeRankedColumns[probeIndex]?.absDx) || 0;
              const probeRelDx = maxProbeAbsDx > 0 ? (probeAbsDx / maxProbeAbsDx) : 0;
              const canEarlyExit = probesCompleted >= kktSqpScoreProbeMinColumns && scoreImprovement > 0;
              const lowLeverageTail = canEarlyExit && probeRelDx <= kktSqpScoreProbeEarlyExitDxRatio;
              const confidentImprovement = canEarlyExit && scoreImprovement >= relImproveThreshold;
              if (lowLeverageTail || confidentImprovement) {
                scoreProbeEarlyExit = true;
                break;
              }
            }
            const scoreProbeDirection = buildSqpModelGradientFallbackDirection(
              scoreGradient,
              trustScales,
              trustRegionDeltaEff,
            );
            if (__profile && __profile.counts) {
              __profile.counts.kktSqpScoreProbeRecoveries = (Number(__profile.counts.kktSqpScoreProbeRecoveries) || 0) + 1;
              __profile.counts.kktSqpScoreProbeEvaluations = (Number(__profile.counts.kktSqpScoreProbeEvaluations) || 0) + scoreProbeExecutedEvaluations;
              if (scoreProbeEarlyExit) {
                __profile.counts.kktSqpScoreProbeEarlyExits = (Number(__profile.counts.kktSqpScoreProbeEarlyExits) || 0) + 1;
              }
            }
            if (coordinateBestX) {
              const aug1 = await evalAugmentedResiduals(coordinateBestX, lambdaVec, mu, currentMaxViol);
              accepted = true;
              nextX = coordinateBestX;
              acceptedCost = evaluateSqpFilterMerit(aug1.base, mu);
              acceptedScore = coordinateBestScore;
              acceptedAlpha = 1;
              acceptedDxStep = coordinateBestX.map((value, col) => value - currentX[col]);
              acceptedRho = 0;
              lastJ = null;
              lastX = null;
              lastR = null;
              forceJacobianRefreshNextIter = true;
              if (__profile && __profile.counts) {
                __profile.counts.kktSqpCoordinateProbeAccepts = (Number(__profile.counts.kktSqpCoordinateProbeAccepts) || 0) + 1;
              }
            }
            if (!accepted && scoreProbeDirection) {
              for (const alpha of recoveryAlphas) {
                const dxStep = scoreProbeDirection.map(value => alpha * value);
                const trialX = clampToBounds(currentX.map((value, col) => value + dxStep[col]));
                const trialKey = buildKktXKey(trialX);
                if (recoveryTriedKeys.has(trialKey)) {
                  if (__profile?.counts) {
                    __profile.counts.kktSqpRecoveryDedupSkips = (Number(__profile.counts.kktSqpRecoveryDedupSkips) || 0) + 1;
                  }
                  continue;
                }
                recoveryTriedKeys.add(trialKey);
                const aug1 = await evalAugmentedResiduals(trialX, lambdaVec, mu, currentMaxViol);
                const score1 = Number(aug1?.base?.requirementScore);
                lastAlpha = alpha;
                if (!Number.isFinite(score1) || score1 >= (score0 - 1e-12)) continue;
                accepted = true;
                nextX = trialX;
                acceptedCost = evaluateSqpFilterMerit(aug1.base, mu);
                acceptedScore = score1;
                acceptedAlpha = alpha;
                acceptedDxStep = dxStep.slice();
                acceptedRho = 0;
                lastJ = null;
                lastX = null;
                lastR = null;
                forceJacobianRefreshNextIter = true;
                break;
              }
            }
          } else if (!accepted && (kktRejectStreak + 1) >= kktSqpScoreProbeRejectStreak && __profile?.counts) {
            __profile.counts.kktSqpScoreProbeSkipped = (Number(__profile.counts.kktSqpScoreProbeSkipped) || 0) + 1;
          }
        }
        
        // 【修正】ステップが受け入れられたかどうかで、Nielsenの適応的ダンピングを行う
        if (!accepted) {
          // 失敗：進まない。ダンピングを増やして次回はより安全な歩幅にする
          kktRejectStreak++;  // 【追加】Consecutive rejection counter
          if (qconVariableFlags.some(Boolean)
            || (kktRejectStreak >= kktForceRefreshOnRejectStreak && jacobianReuseSinceRefresh >= 2)) {
            forceJacobianRefreshNextIter = true;
          }
          
          const rejectedDamping = updateAdaptiveSqpDamping(
            { damping: lmDamp, rejectMultiplier: lmDampRejectMultiplier },
            {
              accepted: false,
              gainRatio: 0,
              hessianScale: lmDampHessianScale,
            },
          );
          lmDamp = rejectedDamping.damping;
          lmDampRejectMultiplier = rejectedDamping.rejectMultiplier;
          applyXToDesignState(currentX);
          postEvalCached = preEval;
          iterAcceptedCompositeEval = kktEvaluationToComposite(preEval);
          
          // 【追加】リジェクト（失敗）時は歩幅の限界を狭めてより慎重にする
          const rejectedRadius = updateTrustRegionRadiusWithOptionalWasm({
            predictedReduction: predictedReductionForStep(dx),
            actualReduction: 0,
            currentRadius: trustRegionDeltaEff,
            minRadius: 0.01,
            maxRadius: 2.0,
            gammaDec: 0.5,
            gammaInc: 1.1
          });
          trustRegionDeltaEff = Number.isFinite(rejectedRadius)
            ? rejectedRadius
            : Math.max(0.01, trustRegionDeltaEff * 0.5);
          
          // Broyden状態をリセット（リジェクト時は有限差分から再計算）
          // lastJ is kept so next iteration can do partial finite-diff refresh.
          lastX = null;
          lastR = null;
          broydenSkipCount = 0;

          if (kktRejectStreak >= kktRollbackRejectStreak && Array.isArray(bestX)) {
            const shouldRollback = shouldRollbackRejectedSqpState(currentX, bestX, trustScales);
            if (shouldRollback) {
              currentX = bestX.slice();
              applyXToDesignState(currentX);
              trustRegionDeltaEff = Math.max(0.01, trustRegionDeltaEff * 0.5);
              const rollbackDamping = initializeAdaptiveSqpDamping(
                2e-4,
                lmDampHessianScale,
                2e-4,
              );
              lmDamp = rollbackDamping.damping;
              lmDampRejectMultiplier = rollbackDamping.rejectMultiplier;
            } else {
              lmDampRejectMultiplier = 2;
            }
            lastJ = null;
            lastX = null;
            lastR = null;
            resetSqpBfgsState();
            forceJacobianRefreshNextIter = true;
            if (__profile && __profile.counts) {
              const recoveryCounter = shouldRollback
                ? 'kktSqpRejectRollbacks'
                : 'kktSqpRejectAtBestRecoveries';
              __profile.counts[recoveryCounter] = (Number(__profile.counts[recoveryCounter]) || 0) + 1;
              if (shouldRollback) {
                __profile.counts.kktSqpDampingResets = (Number(__profile.counts.kktSqpDampingResets) || 0) + 1;
              }
            }
            if (shouldRollback) {
              kktRejectStreak = 0;
            }
            nonmonotoneAcceptStreak = 0;
          }
          
          // 【追加】Auto Soft-Restart: ダンピングをリセットして別の角度から再探索
          // ただし、μ と λ（制約の「壁の記憶」）はリセットしない。何度も同じ壁にぶつかるループを防ぐため
          const restartRejectThreshold = (currentMaxViol >= kktSoftRestartHighViolThreshold)
            ? Math.min(kktSoftRestartRejectStreak, kktSoftRestartRejectStreakHighViol)
            : kktSoftRestartRejectStreak;
          if (kktRejectStreak >= restartRejectThreshold) {
            consecutiveRestarts++;
            console.log(`[${constrainedLabel}] Auto soft-restart triggered at iter ${iter} (${kktRejectStreak} consecutive rejects, threshold=${restartRejectThreshold}, maxViol=${currentMaxViol.toExponential(2)}, restart #${consecutiveRestarts})`);

            const restartBestTolerance = Math.max(1e-10, Math.abs(bestScore) * 1e-10);
            const noGainSinceRestart = Number.isFinite(softRestartBestScore)
              && bestScore >= softRestartBestScore - restartBestTolerance;
            if (consecutiveRestarts >= 2 && noGainSinceRestart) {
              currentX = bestX.slice();
              for (let k = 0; k < n; k++) {
                if (jointState && varIds && k < varIds.length) {
                  setJointDesignVariableValue(jointState, varIds[k], currentX[k]);
                } else if (activeCfg && varIds && k < varIds.length) {
                  setDesignVariableValue(activeCfg, varIds[k], currentX[k]);
                }
              }
              break;
            }
            softRestartBestScore = bestScore;
            
            // 【新機能】連続リスタートが3回を超えたら、μを減らして脱出を試みる
            if (consecutiveRestarts >= 3 && mu > 10) {
              const oldMu = mu;
              mu = Math.max(1, mu * 0.5);  // μを半分にする
              console.log(`[${constrainedLabel}] Too many restarts (${consecutiveRestarts}), reducing penalty: ${oldMu.toExponential(2)} -> ${mu.toExponential(2)}`);
            }
            
            // 【修正】mu と lambdaVec はリセットしない。壁の記憶を保ったまま、ダンピングだけ安全な値に
            // mu = Math.max(1, ...);  <-- 削除：ペナルティ記憶を保つ
            // lambdaVec = [];         <-- 削除：ラグランジュ乗数の蓄積を保つ
            
            lmDamp = 1e-1;  // 安全な初期ダンピング値
            lmDampRejectMultiplier = 2;
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
            resetSqpBfgsState();
            forceJacobianRefreshNextIter = true;
            
            continue;
          }
        } else {
          kktRejectStreak = 0;  // 【追加】Reset counter on success
          consecutiveRestarts = 0;  // 【追加】受理されたら連続リスタートもリセット
          currentX = nextX;
          sqpBfgsUpdatePending = kktSqpUseBfgs
            && acceptedSqpModelStep
            && acceptedAlpha >= 0.5
            && Number.isFinite(acceptedRho)
            && acceptedRho >= kktJacobianPoorModelRho;
          nonmonotoneAcceptStreak = acceptedScore < (bestScore - 1e-12)
            ? 0
            : nonmonotoneAcceptStreak + 1;

          // A small accepted line-search factor means the current trust region
          // overestimates this local model. Start the next iteration near the
          // proven step rather than re-evaluating the same rejected full steps.
          if (acceptedAlpha < 0.5 && (!useKktSqp || kktSqpShrinkTrustOnBacktrack)) {
            trustRegionDeltaEff = Math.max(0.01, trustRegionDeltaEff * acceptedAlpha);
          }

          const acceptedRelCostDrop = Math.abs(cost0 - acceptedCost) / Math.max(1, Math.abs(cost0));
          const invalidAcceptedModel = !Number.isFinite(acceptedRho) || acceptedRho <= 0;
          const poorModel = (invalidAcceptedModel || acceptedRho < kktJacobianPoorModelRho)
            && acceptedRelCostDrop < kktJacobianPoorModelRelImprove;
          if (poorModel) {
            poorModelStreak++;
          } else {
            poorModelStreak = 0;
          }
          if (invalidAcceptedModel || poorModelStreak >= kktJacobianPoorModelStreakForRefresh) {
            forceJacobianRefreshNextIter = true;
          } else {
            forceJacobianRefreshNextIter = false;
          }
          
          // 【追加】ステップがアクセプトされた時点で、実際に設計変数をセット
          // これにより、UIが現在値を認識できるようになる
          for (let k = 0; k < n; k++) {
            if (jointState && varIds && k < varIds.length) {
              setJointDesignVariableValue(jointState, varIds[k], currentX[k]);
            }
          }
          
          const acceptedPredictedReduction = predictedReductionForStep(acceptedDxStep || dx.map(v => acceptedAlpha * v));
          const acceptedActualReduction = Number.isFinite(cost0) && Number.isFinite(acceptedCost)
            ? (cost0 - acceptedCost)
            : 0;
          if (acceptedRho > 0.75) {
              const expandedRadius = updateTrustRegionRadiusWithOptionalWasm({
                predictedReduction: acceptedPredictedReduction,
                actualReduction: acceptedActualReduction,
                currentRadius: trustRegionDeltaEff,
                minRadius: 0.01,
                maxRadius: 2.0,
                gammaDec: 0.9,
                gammaInc: 1.25
              });
              trustRegionDeltaEff = Number.isFinite(expandedRadius)
                ? expandedRadius
                : Math.min(2.0, trustRegionDeltaEff * 1.25);
          } else if (acceptedAlpha === 1 && acceptedRho > 0.25) {
            trustRegionDeltaEff = Math.min(2.0, trustRegionDeltaEff * 1.1);
          } else {
            const reducedRadius = updateTrustRegionRadiusWithOptionalWasm({
              predictedReduction: acceptedPredictedReduction,
              actualReduction: acceptedActualReduction,
              currentRadius: trustRegionDeltaEff,
              minRadius: 0.01,
              maxRadius: 2.0,
              gammaDec: 0.9,
              gammaInc: 1.1
            });
            trustRegionDeltaEff = Number.isFinite(reducedRadius)
              ? reducedRadius
              : Math.max(0.01, trustRegionDeltaEff * 0.9);
          }
          const acceptedDamping = updateAdaptiveSqpDamping(
            { damping: lmDamp, rejectMultiplier: lmDampRejectMultiplier },
            {
              accepted: true,
              gainRatio: acceptedRho,
              hessianScale: lmDampHessianScale,
            },
          );
          lmDamp = acceptedDamping.damping;
          lmDampRejectMultiplier = acceptedDamping.rejectMultiplier;

          // 【高速化】evalSQPAtX(currentX) を一度だけ計算し、ベスト更新ログ・bestMerit 計算で共有する
          // （以前は新ベスト達成時に同じ x で 2 回呼んでいた。kktEvalCache はあるが冗長を排除）
          const acceptedConstraintEval = (acceptedBaseEval && typeof acceptedBaseEval === 'object')
            ? acceptedBaseEval
            : await evalSQPAtX(currentX);
          postEvalCached = acceptedConstraintEval;
          const currentEval = kktEvaluationToComposite(acceptedConstraintEval);
          const currentScore = currentEval.score;
          iterAcceptedCompositeEval = currentEval;
          lastAcceptedScore = currentScore;

          const prevBestEval = getBestScoreEvalSoFar();
          const currentEvalWithSnapshot = withAppliedXSnapshot(currentX, currentEval);
          recordEval(currentEvalWithSnapshot);
          const prevBestScore = bestScore;
          const acceptedViolationVector = (acceptedConstraintEval.constraints || []).map(c => Math.max(0, c));
          const acceptedViolationNorm = Math.sqrt(acceptedViolationVector.reduce((acc, v) => acc + v * v, 0));
          const bestEvalNow = getBestScoreEvalSoFar();
          if (bestEvalNow) {
            bestScore = bestEvalNow.score;
            bestEval = bestEvalNow;
            if (!prevBestEval || currentScore < (prevBestScore - 1e-12)) {
              bestX = currentX.slice();
              bestScoreXSnapshot = currentX.slice();
            }
            
            if (bestScore < prevBestScore) {
              lastBestIter = iter;
              const improvement = prevBestScore - bestScore;
              const currentViolation = acceptedViolationNorm;
              const status = currentEvalWithSnapshot.feasible ? '✓FEAS' : `Viol:${currentViolation.toExponential(2)}`;
              if (onProgress) {
                try {
                  onProgress({
                    phase: 'accept',
                    iter,
                    current: currentScore,
                    best: bestScore,
                    method: constrainedMethod,
                    multiScenario,
                    requirementCount: Array.isArray(expandedRequirements) ? expandedRequirements.length : 0,
                    feasible: currentEvalWithSnapshot.feasible,
                    violationScore: currentEvalWithSnapshot.violationScore,
                    softPenalty: currentEvalWithSnapshot.softPenalty,
                    requirementSnapshots: Array.isArray(currentEvalWithSnapshot.requirementSnapshots) ? currentEvalWithSnapshot.requirementSnapshots : [],
                    requirementScore: Number(currentEvalWithSnapshot.requirementScore),
                    rows: buildOptimizerResultSnapshotForUi()?.opticalSystemRowsSnapshot ?? [],
                    alpha: lastAlpha,
                    rho: acceptedRho
                  });
                } catch (_) {}
              }
            }
          }

          if (catVars.length > 0 && (iter % kktCategoricalSweepInterval === 0)) {
            const bestEvalBeforeMaterialSweep = getBestScoreEvalSoFar();
            const sweep = await runCategoricalMaterialSweep({
              activeCfg,
              systemConfig,
              jointState,
              categoricalVars: catVars,
              evalState: evalStateKKT,
              onProgress,
              shouldStop,
              iter,
              multiScenario,
              bestEval: bestEvalBeforeMaterialSweep || currentEval
            });

            if (sweep && sweep.bestEval) {
              recordEval(sweep.bestEval);
            }

            if (sweep && sweep.changed) {
              kktEvalCache.clear();
              postEvalCached = null;
              iterAcceptedCompositeEval = null;
              forceJacobianRefreshNextIter = true;
              lastJ = null;
              lastX = null;
              lastR = null;
              broydenSkipCount = 0;
              resetSqpBfgsState();

              const materialEval = evalStateKKT();
              const materialEvalWithSnapshot = withAppliedXSnapshot(currentX, materialEval);
              recordEval(materialEvalWithSnapshot);
              lastAcceptedScore = materialEvalWithSnapshot?.score ?? lastAcceptedScore;

              const bestEvalAfterMaterialSweep = getBestScoreEvalSoFar();
              if (bestEvalAfterMaterialSweep) {
                bestScore = bestEvalAfterMaterialSweep.score;
                bestEval = bestEvalAfterMaterialSweep;
                if (!bestEvalBeforeMaterialSweep || compareEval(materialEvalWithSnapshot, bestEvalBeforeMaterialSweep)) {
                  bestX = currentX.slice();
                  bestScoreXSnapshot = currentX.slice();
                }
              }
            }
          }
          
          // bestMeritは参考値として計算（主にデバッグ用）
          // 【高速化】受理時に評価済みの acceptedConstraintEval / acceptedViolationNorm を再利用
          bestMerit = bestScore + acceptedViolationNorm * 10000;
        }

        // --- 5.5. Stagnation watchdog (auto soft-restart) ---
        // Manual Stop->Run often helps because AL state (damping / local linearization) gets reset.
        // Reproduce that behavior automatically when progress stalls for too long.
        if (accepted && Number.isFinite(lastAcceptedScore) && Number.isFinite(bestScore)) {
          const gap = Math.abs(lastAcceptedScore - bestScore);
          if (gap <= stagnationImproveEps) stagnationIter++;
          else stagnationIter = 0;
        } else {
          stagnationIter++;
        }

        if (stagnationIter >= stagnationIterLimit) {
          const jitterScale = Number.isFinite(Number(opts?.kktStagnationJitterScaled))
            ? Math.max(0, Math.min(0.2, Number(opts.kktStagnationJitterScaled)))
            : 0;
          const restartBase = bestX.slice();
          const qconColumns = qconVariableFlags
            .map((isQcon, index) => isQcon ? index : -1)
            .filter(index => index >= 0);
          const useQconOrthogonalRestart = opts?.kktQconOrthogonalRestart !== false
            && qconColumns.length > 1
            && qconColumns.length === n;
          const restartX = restartBase.slice();
          if (useQconOrthogonalRestart) {
            const mode = Math.floor(qconStagnationRestartIndex / 2) % qconColumns.length;
            const sign = (qconStagnationRestartIndex % 2 === 0) ? 1 : -1;
            const direction = qconColumns.map((_, order) => (
              Math.cos(Math.PI * (order + 0.5) * mode / qconColumns.length)
            ));
            const directionNorm = Math.max(...direction.map(value => Math.abs(value)), 1e-12);
            for (let order = 0; order < qconColumns.length; order++) {
              const col = qconColumns[order];
              const scale = Number.isFinite(varScales[col]) && varScales[col] > 0 ? varScales[col] : 1;
              restartX[col] += sign * direction[order] * scale / directionNorm;
            }
            qconStagnationRestartIndex++;
          } else {
            for (let i = 0; i < restartX.length; i++) {
              const scale = Number.isFinite(varScales[i]) && varScales[i] > 0 ? varScales[i] : 1;
              const sign = ((iter + i) % 2 === 0) ? 1 : -1;
              restartX[i] += sign * jitterScale * scale;
            }
          }

          currentX = clampToBounds(restartX);
          for (let k = 0; k < n; k++) {
            if (jointState && varIds && k < varIds.length) {
              setJointDesignVariableValue(jointState, varIds[k], currentX[k]);
            } else if (activeCfg && varIds && k < varIds.length) {
              setDesignVariableValue(activeCfg, varIds[k], currentX[k]);
            }
          }
          // 【高速化】設計変数が変わったので受理時 composite キャッシュを無効化
          iterAcceptedCompositeEval = null;

          lmDamp = 2e-4;
          lmDampRejectMultiplier = 2;
          trustRegionDeltaEff = kktInitialTrustRegion;
          kktRejectStreak = 0;
          lastJ = null;
          lastX = null;
          lastR = null;
          broydenSkipCount = 0;
          resetSqpBfgsState();
          forceJacobianRefreshNextIter = true;
          stagnationIter = 0;

          if (onProgress) {
            try {
              onProgress({
                phase: 'restart',
                iter,
                current: lastAcceptedScore,
                best: bestScore,
                method: constrainedMethod,
                multiScenario,
                requirementCount: Array.isArray(expandedRequirements) ? expandedRequirements.length : 0,
                reason: useQconOrthogonalRestart ? 'qcon-orthogonal-restart' : 'stagnation-auto-restart'
              });
            } catch (_) {}
            await nextFrame();
          }

          if (__profile && __profile.counts) {
            __profile.counts.kktIterCount = (Number(__profile.counts.kktIterCount) || 0) + 1;
            __profile.counts.kktIterMs = (Number(__profile.counts.kktIterMs) || 0) + (nowMs() - __iterT0);
          }
        }
        
        // --- 6. Update Lagrange multipliers and penalty (Delayed Schedule) ---

        const post = postEvalCached || await evalSQPAtX(currentX);
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
        const kktAggressiveViolUpdateThreshold = Number.isFinite(Number(opts?.kktAggressiveViolUpdateThreshold))
          ? Math.max(0, Number(opts.kktAggressiveViolUpdateThreshold))
          : 30;
        const kktAggressiveViolUpdateInterval = Number.isFinite(Number(opts?.kktAggressiveViolUpdateInterval))
          ? Math.max(2, Math.floor(Number(opts.kktAggressiveViolUpdateInterval)))
          : 10;
        const severeViolation = maxViol > kktAggressiveViolUpdateThreshold;
        // 【修正】kktRejectStreak < 3 に緩和：完全に凍結すると無限ループに陥る
        const isTimeToUpdate = (
          isProgressSlow
          || (iter > 0 && iter % 15 === 0)
          || (severeViolation && iter > 0 && iter % kktAggressiveViolUpdateInterval === 0)
        ) && kktRejectStreak < 3;

        if (useKktSqp && accepted && Array.isArray(sqpCandidateMultipliers)) {
          lambdaVec = sqpCandidateMultipliers.slice();
        }

        if (isTimeToUpdate) {
          // Update multipliers only when landscape should change
          if (!useKktSqp) {
            for (let i = 0; i < c.length; i++) {
              lambdaVec[i] = Math.max(0, lambdaVec[i] + mu * c[i]);
            }
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
          } else if (maxViol > 100) {
            muMultiplier = 1.2;
          } else if (maxViol > 20) {
            muMultiplier = 1.12;
          } else if (maxViol > 5) {
            muMultiplier = 1.08;
          } else if (maxViol < 1.0) {
            muMultiplier = 1.1;
          } else {
            muMultiplier = 1.2;
          }
          
          if (violStagnationIter > 3) {
            muMultiplier = Math.max(1.1, muMultiplier * 1.2);
          }
          
          // 高違反時は μ をより積極的に増やして feasibility へ寄せる
          mu = Math.min(1e5, Math.max(1, mu * muMultiplier));
          
          // ALM更新時はBroyden状態をリセット（地形が変わったため）
          // Keep lastJ for partial refresh, but disable rank-1 Broyden update across ALM changes.
          lastX = null;
          lastR = null;
          broydenSkipCount = 0;
        }

        if (maxViol > kktHighViolThreshold) {
          if (!Number.isFinite(highViolRef) || maxViol < highViolRef * kktHighViolImproveRatio) {
            highViolRef = maxViol;
            highViolStallIters = 0;
          } else {
            highViolStallIters++;
          }

          if (highViolStallIters >= kktHighViolStallWindow) {
            const highViolJitterScale = Number.isFinite(Number(opts?.kktHighViolJitterScaled))
              ? Math.max(0, Math.min(0.2, Number(opts.kktHighViolJitterScaled)))
              : 0;
            const restartBase = bestX.slice();
            const restartX = restartBase.map((v, i) => {
              const scale = Number.isFinite(varScales[i]) && varScales[i] > 0 ? varScales[i] : 1;
              const sign = ((iter + i) % 2 === 0) ? 1 : -1;
              return v + sign * highViolJitterScale * scale;
            });
            currentX = clampToBounds(restartX);
            for (let k = 0; k < n; k++) {
              if (jointState && varIds && k < varIds.length) {
                setJointDesignVariableValue(jointState, varIds[k], currentX[k]);
              } else if (activeCfg && varIds && k < varIds.length) {
                setDesignVariableValue(activeCfg, varIds[k], currentX[k]);
              }
            }
            lmDamp = Math.max(1e-3, lmDamp);
            mu = Math.max(1, mu * 0.5);
            forceJacobianRefreshNextIter = true;
            lastX = null;
            lastR = null;
            broydenSkipCount = 0;
            resetSqpBfgsState();
            highViolRef = maxViol;
            highViolStallIters = 0;
          }
        } else {
          highViolRef = maxViol;
          highViolStallIters = 0;
        }

        const divergenceScoreRatio = Number.isFinite(bestScore) && Math.abs(bestScore) > 1e-12
          ? (Math.max(0, lastAcceptedScore) / Math.max(1e-12, Math.abs(bestScore)))
          : 1;
        const shouldRollbackToBest = Number.isFinite(divergenceScoreRatio)
          && divergenceScoreRatio > 50
          && maxViol > 20
          && iter > 20;
        if (shouldRollbackToBest) {
          currentX = bestX.slice();
          for (let k = 0; k < n; k++) {
            if (jointState && varIds && k < varIds.length) {
              setJointDesignVariableValue(jointState, varIds[k], currentX[k]);
            } else if (activeCfg && varIds && k < varIds.length) {
              setDesignVariableValue(activeCfg, varIds[k], currentX[k]);
            }
          }
          mu = Math.max(1, mu * 0.3);
          lmDamp = Math.max(1e-3, lmDamp);
          forceJacobianRefreshNextIter = true;
          lastX = null;
          lastR = null;
          broydenSkipCount = 0;
          resetSqpBfgsState();
        }

        // Convergence check: feasible + stable for multiple iterations
        const currentConvCost = cost0;
        const costChange = Number.isFinite(prevConvCost)
          ? Math.abs(prevConvCost - currentConvCost)
          : Number.POSITIVE_INFINITY;
        prevConvCost = currentConvCost;

        if (maxViol <= 1e-6 && accepted && iter >= 5) {
          if (costChange < 1e-6) {
            feasibleConvStreak++;
          } else {
            feasibleConvStreak = 0;
          }

          if (feasibleConvStreak >= 3) {
            break;
          }
        } else {
          feasibleConvStreak = 0;
        }

        if (kktStopWhenBestLeq !== null
          && iter >= kktStopWhenBestLeqMinIter
          && Number.isFinite(bestScore)
          && bestScore <= kktStopWhenBestLeq) {
          break;
        }

        if (Number.isFinite(bestScore)) {
          bestScoreHistory.push(bestScore);

          const noBestRelImprove = (noBestImproveRef - bestScore) / Math.max(1, Math.abs(noBestImproveRef));
          if (noBestRelImprove > kktNoBestImproveRelEps) {
            noBestImproveRef = bestScore;
            noBestImproveIters = 0;
          } else {
            noBestImproveIters++;
          }

          const tailRelImprove = (tailBestRef - bestScore) / Math.max(1, Math.abs(tailBestRef));
          if (tailRelImprove > kktTailStopBestRelImproveEps) {
            tailBestRef = bestScore;
            tailNoImproveIters = 0;
          } else {
            tailNoImproveIters++;
          }

          const relImprove = (plateauBestRef - bestScore) / Math.max(1, Math.abs(plateauBestRef));
          const violImprove = (Number.isFinite(plateauViolRef) ? (plateauViolRef - maxViol) : Number.POSITIVE_INFINITY);
          if (relImprove > kktPlateauBestRelImproveEps || violImprove > kktPlateauViolImproveEps) {
            plateauBestRef = bestScore;
            plateauViolRef = maxViol;
            plateauNoImproveIters = 0;
          } else {
            plateauNoImproveIters++;
          }

          const strictPlateauStop = (iter >= kktPlateauStopMinIter
            && plateauNoImproveIters >= kktPlateauStopWindow
            && maxViol <= kktPlateauMaxViol);
          const relaxedPlateauStop = (iter >= kktPlateauRelaxedMinIter
            && plateauNoImproveIters >= kktPlateauStopWindow
            && maxViol <= kktPlateauRelaxedMaxViol);
          const tailStop = (iter >= kktTailStopMinIter
            && tailNoImproveIters >= kktTailStopWindow
            && maxViol <= kktTailStopMaxViol);
          let windowTailStop = false;
          let windowTailRelImprove = Number.POSITIVE_INFINITY;
          if ((iter - windowTailRefIter) >= kktWindowTailStopWindow) {
            windowTailRelImprove = (windowTailRefBest - bestScore) / Math.max(1, Math.abs(windowTailRefBest));
            if (iter >= kktWindowTailStopMinIter
              && windowTailRelImprove < kktWindowTailStopRelImproveEps
              && maxViol <= kktWindowTailStopMaxViol) {
              windowTailStop = true;
            }
            windowTailRefIter = iter;
            windowTailRefBest = bestScore;
          }

          let windowNoGainStop = false;
          let windowNoGainRelImprove = Number.POSITIVE_INFINITY;
          if (iter >= kktWindowNoGainMinIter && bestScoreHistory.length > kktWindowNoGainWindow) {
            const pastBest = Number(bestScoreHistory[bestScoreHistory.length - 1 - kktWindowNoGainWindow]);
            if (Number.isFinite(pastBest)) {
              windowNoGainRelImprove = (pastBest - bestScore) / Math.max(1, Math.abs(pastBest));
              if (windowNoGainRelImprove < kktWindowNoGainRelImproveEps && maxViol <= kktWindowNoGainMaxViol) {
                windowNoGainStop = true;
              }
            }
          }

          let goodEnoughStop = false;
          let goodEnoughRecentRelImprove = Number.POSITIVE_INFINITY;
          if (iter >= kktGoodEnoughStopMinIter && bestScoreHistory.length > kktGoodEnoughStopWindow) {
            const pastBest = Number(bestScoreHistory[bestScoreHistory.length - 1 - kktGoodEnoughStopWindow]);
            if (Number.isFinite(pastBest)) {
              goodEnoughRecentRelImprove = (pastBest - bestScore) / Math.max(1, Math.abs(pastBest));
              if (goodEnoughRecentRelImprove < kktGoodEnoughStopRecentRelImproveEps && maxViol <= kktGoodEnoughStopMaxViol) {
                goodEnoughStop = true;
              }
            }
          }

          const noBestImproveStop = (
            iter >= kktNoBestImproveMinIter
            && noBestImproveIters >= kktNoBestImproveWindow
            && maxViol <= kktNoBestImproveMaxViol
          );
          const postBestDivergenceStop = (
            iter >= kktPostBestDivergenceMinIter
            && noBestImproveIters >= kktPostBestNoImproveWindow
            && divergenceScoreRatio >= kktPostBestDivergenceRatio
            && maxViol >= kktPostBestDivergenceMaxViol
          );
          const postBestPatienceStop = (
            iter >= kktPostBestPatienceMinIter
            && (iter - lastBestIter) >= kktPostBestPatienceWindow
            && noBestImproveIters >= kktPostBestPatienceWindow
            && ((initialScore - bestScore) / Math.max(1e-12, Math.abs(initialScore)) * 100) >= kktPostBestRequiredImprovePct
            && maxViol <= kktPostBestPatienceMaxViol
          );

          if (kktAutoStopEnabled && (strictPlateauStop || relaxedPlateauStop || tailStop || windowTailStop || windowNoGainStop || goodEnoughStop || noBestImproveStop || postBestDivergenceStop || postBestPatienceStop)) {
            break;
          }
        }

        // 【高速化】受理時に評価した composite を再利用（設計変数が同じ場合）。
        // null（リジェクト時 or stagnation auto-restart 後）の場合のみ再評価する。
        const iterCompositeEval = iterAcceptedCompositeEval ?? evalCompositeFromRequirementsProfiled();
        const requirementScore = Number(iterCompositeEval?.requirementScore);
        const acceptedRowsSnapshot = accepted
          ? (buildOptimizerResultSnapshotForUi()?.opticalSystemRowsSnapshot ?? [])
          : [];

        if (onProgressKKT) {
          const displayScore = accepted ? lastAcceptedScore : bestScore;
          const currentDisplayScore = Number.isFinite(requirementScore)
            ? requirementScore
            : (iterCompositeEval?.score ?? displayScore);
          await onProgressKKT({
            iter: iter,
            current: currentDisplayScore,
            best: bestScore,
            feasible: iterCompositeEval?.feasible ?? post.feasible,
            violationScore: iterCompositeEval?.violationScore,
            softPenalty: iterCompositeEval?.softPenalty,
            requirementSnapshots: Array.isArray(iterCompositeEval?.requirementSnapshots) ? iterCompositeEval.requirementSnapshots : [],
            alpha: lastAlpha,
            rho: acceptedRho,
            mu: mu,
            maxViol: maxViol,
            lmDamp: lmDamp,
            dampingFactor: lmDamp,
            requirementScore
          });
        }

        // Report progress for UI update
        if (onProgress) {
          try {
            const progressCurrentScore = Number.isFinite(requirementScore)
              ? requirementScore
              : (iterCompositeEval?.score ?? bestScore);
            onProgress({
              phase: 'iter',
              iter: iter,
              current: progressCurrentScore,
              best: bestScore,
              method: constrainedMethod,
              multiScenario,
              requirementCount: Array.isArray(expandedRequirements) ? expandedRequirements.length : 0,
              feasible: iterCompositeEval?.feasible ?? post.feasible,
              violationScore: iterCompositeEval?.violationScore,
              softPenalty: iterCompositeEval?.softPenalty,
              requirementSnapshots: Array.isArray(iterCompositeEval?.requirementSnapshots) ? iterCompositeEval.requirementSnapshots : [],
              accepted,
              rows: acceptedRowsSnapshot,
              activeViolations: activeViolations,
              maxViolation: maxViol,
              alpha: lastAlpha,
              rho: acceptedRho,
              lmDamp: lmDamp,
              dampingFactor: lmDamp,
              requirementScore,
              mu: mu
            });
          } catch (_) {}
          await nextFrame();
        }
        } finally {
          if (__profile && __profile.counts) {
            __profile.counts.kktIterCount = (Number(__profile.counts.kktIterCount) || 0) + 1;
            __profile.counts.kktIterMs = (Number(__profile.counts.kktIterMs) || 0) + (nowMs() - __iterT0);
          }
        }
      }

      const totalImprovement = initialScore - bestScore;
      const improvementPercent = (totalImprovement / Math.max(1e-10, initialScore)) * 100;
      const t1 = nowMs();
      let restoredBestFinalEval: any = null;
      
      // 【修正】LMメソッドと同じパターン：bestX を手動で適用せず、
      // recordEval() で保存された blocksSnapshot を直接復元する
      // これにより、Stop時も確実にベスト解が復元される
      try {
        const bestFinalEval = getBestScoreEvalSoFar();
        if (bestFinalEval) {
          restoredBestFinalEval = restoreBestStateAndPersist(bestFinalEval);
          try {
            const latestUiSnapshot = buildOptimizerResultSnapshotForUi();
            if (latestUiSnapshot) {
              __lastOptimizerResultSnapshotForUi = latestUiSnapshot;
            }
          } catch (_) {}
        }
      } catch (e) {
        console.error(`[${constrainedLabel}] Error restoring/persisting best state:`, e);
      }

      if (shouldStopKKT()) {
        const stoppedFinalEval = getBestScoreEvalSoFar() || getBestEvalSoFar();
        const stoppedBestScore = Number.isFinite(stoppedFinalEval?.score) ? stoppedFinalEval.score : bestScore;
        const stoppedUiSnapshot = buildOptimizerResultSnapshotForUi() || __lastOptimizerResultSnapshotForUi || {};
        return {
          ok: true,
          aborted: true,
          before: initialScore,
          best: stoppedBestScore,
          iterations: completedIterations,
          variables: vars.length,
          method: constrainedMethod,
          feasible: stoppedFinalEval?.feasible ?? false,
          violationScore: Number.isFinite(stoppedFinalEval?.violationScore) ? stoppedFinalEval.violationScore : stoppedBestScore,
          softPenalty: Number.isFinite(stoppedFinalEval?.softPenalty) ? stoppedFinalEval.softPenalty : 0,
          objectiveScore: stoppedBestScore,
          hardViolations: stoppedFinalEval?.hardViolations ?? [],
          softViolations: stoppedFinalEval?.softViolations ?? [],
          ...stoppedUiSnapshot
        };
      }

      restorePreOptimizationGlobalsForUiSync();
      publishLatestSystemConfigForUiSync();

      // Final sync to tables - this is critical to reflect values in UI
      try {
        if (!__persistedOptimizerResultForUi && window.ConfigurationManager && typeof window.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
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
          recalculateMeritIfSurfaceRangesValid();
        }
      } catch (_) {}

      // Do not run a final System Requirements re-evaluation here. The AL path has
      // just restored/persisted the tracked best snapshot; re-evaluating from the
      // ambient UI table can overwrite that best Req snapshot with the last/host
      // state before the result snapshot is returned to App.tsx.

      // Get final best evaluation for fallback decision (objective-space)
      const bestFinalEval = restoredBestFinalEval || getBestScoreEvalSoFar();
      const finalScore = bestFinalEval ? bestFinalEval.score : bestScore;
      const noKktImprovement = Number.isFinite(finalScore)
        && Number.isFinite(initialScore)
        && finalScore >= (initialScore - 1e-12);
      const kktRelativeImprove = (Number.isFinite(initialScore) && Number.isFinite(finalScore))
        ? ((initialScore - finalScore) / Math.max(1, Math.abs(initialScore)))
        : Number.POSITIVE_INFINITY;
      const disableKktNoImproveFallback = opts?.__disableKktNoImproveFallback === true;
      const kktNoImproveFallbackIterations = Number.isFinite(Number(opts?.kktNoImproveFallbackIterations))
        ? Math.max(1, Math.floor(Number(opts.kktNoImproveFallbackIterations)))
        : Math.min(maxIterations, 20);
      const kktNoImproveFallbackMinRelImprove = Number.isFinite(Number(opts?.kktNoImproveFallbackMinRelImprove))
        ? Math.max(0, Number(opts.kktNoImproveFallbackMinRelImprove))
        : 0.0025;
      const shouldTryCdFallback = !shouldStopKKT()
        && (noKktImprovement || kktRelativeImprove < kktNoImproveFallbackMinRelImprove);
      if (shouldTryCdFallback) {
        console.warn(`[${constrainedLabel}] Improvement is insufficient. Keeping constrained optimizer result.`, {
          iterations: kktNoImproveFallbackIterations,
          variables: vars.length,
          relativeImprove: kktRelativeImprove,
          fallbackEnabled: !disableKktNoImproveFallback,
        });
      }

      // Re-evaluate after best snapshot restore can be non-deterministic for high-field
      // chief-ray solve fallbacks. Prefer the restored best eval if available.
      const finalCompositeEval = restoredBestFinalEval
        || (hasHeavyAsyncRequirementOperands ? bestFinalEval : evalCompositeFromRequirementsProfiled());
      let strictValidation: any = null;
      let strictFinalCompositeEval: any = null;
      if (kktStrictRefineAcceptedCandidates) {
        try {
          const strictTargetX = Array.isArray(bestScoreXSnapshot) && bestScoreXSnapshot.length === currentX.length
            ? bestScoreXSnapshot
            : bestX;
          const strictBaseEval = await evalSQPAtXStrict(strictTargetX);
          strictFinalCompositeEval = kktEvaluationToComposite(strictBaseEval);
          strictValidation = {
            executed: true,
            score: Number(strictFinalCompositeEval?.score),
            feasible: !!strictFinalCompositeEval?.feasible,
            violationScore: Number(strictFinalCompositeEval?.violationScore),
            spotRayCount: kktStrictSpotRayCount,
            mtfSamplingSize: kktStrictMtfSamplingSize,
            rayGridSize: kktStrictRayGridSize,
          };
          if (__profile?.counts) {
            __profile.counts.kktStrictFinalVerificationCalls = (Number(__profile.counts.kktStrictFinalVerificationCalls) || 0) + 1;
          }
        } catch (error) {
          strictValidation = {
            executed: false,
            error: String(error instanceof Error ? error.message : error),
            spotRayCount: kktStrictSpotRayCount,
            mtfSamplingSize: kktStrictMtfSamplingSize,
            rayGridSize: kktStrictRayGridSize,
          };
          if (__profile?.counts) {
            __profile.counts.kktStrictFinalVerificationErrors = (Number(__profile.counts.kktStrictFinalVerificationErrors) || 0) + 1;
          }
        }
      }

      const verificationEval = strictFinalCompositeEval || finalCompositeEval;
      const finalViolationScore = Number.isFinite(verificationEval?.violationScore)
        ? verificationEval.violationScore
        : (bestFinalEval?.violationScore ?? 0);
      const finalSoftPenalty = Number.isFinite(verificationEval?.softPenalty)
        ? verificationEval.softPenalty
        : (bestFinalEval?.softPenalty ?? 0);
      const finalFeasible = (verificationEval?.feasible !== undefined)
        ? !!verificationEval.feasible
        : (bestFinalEval?.feasible ?? false);
      const finalBestScore = Number.isFinite(verificationEval?.score)
        ? Number(verificationEval.score)
        : (Number.isFinite(bestFinalEval?.score)
        ? bestFinalEval.score
        : bestScore);
      const finalObjectiveScore = Number.isFinite(finalBestScore)
        ? finalBestScore
        : (Number.isFinite(verificationEval?.score)
          ? verificationEval.score
          : finalScore);

      if (onProgress) {
        try {
          onProgress({
            phase: 'done',
            iter: completedIterations,
            current: finalObjectiveScore,
            best: finalBestScore,
            ms: Math.round(t1 - t0),
            method: constrainedMethod,
            multiScenario,
            feasible: finalFeasible,
            violationScore: finalViolationScore,
            softPenalty: finalSoftPenalty
          });
        } catch (_) {}
      }

      const doneUiSnapshot = buildOptimizerResultSnapshotForUi() || __lastOptimizerResultSnapshotForUi || {};

      return {
        ok: true,
        aborted: shouldStopKKT(),
        before: initialScore,
        best: finalBestScore,
        iterations: completedIterations,
        variables: vars.length,
        method: constrainedMethod,
        feasible: finalFeasible,
        violationScore: finalViolationScore,
        softPenalty: finalSoftPenalty,
        objectiveScore: finalObjectiveScore,
        hardViolations: bestFinalEval?.hardViolations ?? [],
        softViolations: bestFinalEval?.softViolations ?? [],
        strictValidation,
        ...doneUiSnapshot
      };
    } catch (e: any) {
      if (e?.__cooptStop) {
        // Stop was requested mid-Jacobian. Restore/persist the best snapshot before
        // returning so the host optical system and requirement tables stay aligned.
        let stoppedFinalEval = getBestScoreEvalSoFar() || getBestEvalSoFar();
        try {
          stoppedFinalEval = restoreBestStateAndPersist(stoppedFinalEval) || stoppedFinalEval;
        } catch (_) {}
        const stoppedBestScore = Number.isFinite(stoppedFinalEval?.score) ? stoppedFinalEval.score : bestScore;
        const emergencyStoppedUiSnapshot = buildOptimizerResultSnapshotForUi() || __lastOptimizerResultSnapshotForUi || {};
        return {
          ok: true,
          aborted: true,
          before: initialScore,
          best: stoppedBestScore,
          iterations: completedIterations,
          variables: vars.length,
          method: constrainedMethod,
          feasible: stoppedFinalEval?.feasible ?? false,
          violationScore: Number.isFinite(stoppedFinalEval?.violationScore) ? stoppedFinalEval.violationScore : stoppedBestScore,
          softPenalty: Number.isFinite(stoppedFinalEval?.softPenalty) ? stoppedFinalEval.softPenalty : 0,
          objectiveScore: stoppedBestScore,
          hardViolations: stoppedFinalEval?.hardViolations ?? [],
          softViolations: stoppedFinalEval?.softViolations ?? [],
          ...emergencyStoppedUiSnapshot
        };
      }
      console.error(`[${constrainedLabel}] Fatal optimizer error:`, e);
      return {
        ok: false,
        reason: `${constrainedLabel} optimization error: ${String(e)}`
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

    const aborted0 = shouldStop ? !!shouldStop() : false;
    const finalEval = getBestEvalSoFar();
    // Ensure final state first, then sync UI/tables from restored best snapshot.
    try {
      restoreBestSnapshotAndPersist({ finalEval, jointState, systemConfig, configsById, targetConfigIds });
    } catch (_) {}

    restorePreOptimizationGlobalsForUiSync();
    publishLatestSystemConfigForUiSync();

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
        recalculateMeritIfSurfaceRangesValid();
      }
    } catch (_) {}
    try {
      if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.evaluateAndUpdateNow === 'function') {
        window.systemRequirementsEditor.evaluateAndUpdateNow();
      }
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

  restorePreOptimizationGlobalsForUiSync();
  publishLatestSystemConfigForUiSync();

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
      recalculateMeritIfSurfaceRangesValid();
    }
  } catch (_) {}
  try {
    if (window.systemRequirementsEditor && typeof window.systemRequirementsEditor.evaluateAndUpdateNow === 'function') {
      window.systemRequirementsEditor.evaluateAndUpdateNow();
    }
  } catch (_) {}

  const t1 = nowMs();

  const finalEval = getBestEvalSoFar();
  const finalCompositeEval = evalCompositeFromRequirementsProfiled();
  const finalViolationScore = Number.isFinite(finalCompositeEval?.violationScore)
    ? finalCompositeEval.violationScore
    : (finalEval ? finalEval.violationScore : 0);
  const finalSoftPenalty = Number.isFinite(finalCompositeEval?.softPenalty)
    ? finalCompositeEval.softPenalty
    : (finalEval ? finalEval.softPenalty : 0);
  const finalFeasible = (finalCompositeEval?.feasible !== undefined)
    ? !!finalCompositeEval.feasible
    : (finalEval ? finalEval.feasible : true);
  const finalBestScore = Number.isFinite(finalEval?.score)
    ? finalEval.score
    : best;
  const finalObjectiveScore = Number.isFinite(finalBestScore)
    ? finalBestScore
    : (Number.isFinite(finalCompositeEval?.score)
      ? finalCompositeEval.score
      : best);

  if (onProgress) {
    try {
      onProgress({ phase: 'done', iter: completedIterations, current: finalObjectiveScore, best: finalBestScore, multiScenario, ms: Math.round(t1 - t0), feasible: finalFeasible, violationScore: finalViolationScore, softPenalty: finalSoftPenalty });
    } catch (_) {}
    await nextFrame();
  }

  const aborted = shouldStop ? !!shouldStop() : false;
  return {
    ok: true,
    aborted,
    before,
    best: finalBestScore,
    iterations: completedIterations,
    variables: vars.length,
    method: 'cd',
    feasible: finalFeasible,
    violationScore: finalViolationScore,
    softPenalty: finalSoftPenalty,
    objectiveScore: finalObjectiveScore,
    hardViolations: finalEval ? finalEval.hardViolations : [],
    softViolations: finalEval ? finalEval.softViolations : []
  };
  } finally {
    // Always restore global overrides, even on early return/errors.
    try {
      setBlocksOverrideGlobal(__persistedOptimizerResultForUi ? undefined : __prevBlocksOverride);
    } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined') {
        if (__persistedOptimizerResultForUi) {
          try { delete globalThis.__cooptOpticalSystemRowsOverride; } catch (_) {
            globalThis.__cooptOpticalSystemRowsOverride = null;
          }
        } else {
          globalThis.__cooptOpticalSystemRowsOverride = __prevOpticalRowsOverride;
        }
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

    // Restore persisted fallback toggle.
    try {
      if (typeof globalThis !== 'undefined') {
        if (__prevDisablePersistedTableFallback !== undefined) (globalThis as any).__cooptDisablePersistedTableFallback = __prevDisablePersistedTableFallback;
        else {
          try { delete (globalThis as any).__cooptDisablePersistedTableFallback; } catch (_) {}
        }

        if (__prevTaEvalRunId !== undefined) (globalThis as any).__cooptTaEvalRunId = __prevTaEvalRunId;
        else {
          try { delete (globalThis as any).__cooptTaEvalRunId; } catch (_) {}
        }

        try { delete (globalThis as any).__cooptEvalXKey; } catch (_) {}
        try { delete (globalThis as any).__cooptEvalXKeyApproxTa; } catch (_) {}
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
    profileRun: profileOptimizationRun,
    compareWasmPilot: compareWasmPilotBenchmark,
    compareMatrixFree: compareMatrixFreeBenchmark,
    compareTsVsNative: compareTsVsNativeOptimizerBenchmark,
    compareKktAnalyticEq: compareKktAnalyticEqBenchmark,
    compareGlobalVsKkt: compareGlobalVsKktBenchmark,
    exportBenchmarkCsv: exportWasmPilotBenchmarkCsv,
    exportMatrixFreeCsv: exportMatrixFreeBenchmarkCsv,
    exportMatrixFreeJson: exportMatrixFreeBenchmarkJson,
    exportGlobalVsKktJson: exportGlobalVsKktBenchmarkJson,
    exportEscapeSnapshotsArchive,
    listEscapeSnapshots,
    pickAnalyticCandidates: pickAnalyticDerivativeCandidates,
    stop: () => {
      __optimizerStopRequested = true;
      try {
        if (typeof globalThis !== 'undefined') {
          globalThis.__stopOptimization = true;
        }
      } catch (_) {}
      try {
        void requestOptimizerStop().catch(() => {});
      } catch (_) {}
    }
  };
}
