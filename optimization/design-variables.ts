/**
 * Blocks (Design Intent) → design-variable registry
 *
 * This module is intentionally UI-agnostic.
 * Optimizers can use it to enumerate variables and apply updates.
 */

import { getGlassDataWithSellmeier } from '../data/glass.ts';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isNumericString(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t === '') return false;
  const n = Number(t);
  return Number.isFinite(n);
}

function normalizeMaybeNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return value;
    if (/^inf(inity)?$/i.test(s)) return value;
    if (isNumericString(s)) return Number(s);
  }
  return value;
}

function parseFiniteRadius(value) {
  const normalized = normalizeMaybeNumber(value);
  if (typeof normalized === 'string') {
    const s = normalized.trim();
    if (!s || /^inf(inity)?$/i.test(s)) return null;
    const numeric = Number(s);
    if (!Number.isFinite(numeric) || Math.abs(numeric) < 1e-12) return null;
    return numeric;
  }
  if (typeof normalized === 'number') {
    if (!Number.isFinite(normalized) || Math.abs(normalized) < 1e-12) return null;
    return normalized;
  }
  return null;
}

function parseRadiusCurvature(value) {
  const normalized = normalizeMaybeNumber(value);
  if (typeof normalized === 'string') {
    const s = normalized.trim();
    if (!s) return null;
    if (/^inf(inity)?$/i.test(s)) return 0;
    const numeric = Number(s);
    if (!Number.isFinite(numeric) || Math.abs(numeric) < 1e-12) return null;
    return 1 / numeric;
  }
  if (typeof normalized === 'number') {
    if (!Number.isFinite(normalized) || Math.abs(normalized) < 1e-12) return null;
    return 1 / normalized;
  }
  return null;
}

function isLensBlock(block) {
  const blockType = String(block?.blockType ?? '').trim();
  return blockType === 'Lens' || blockType === 'PositiveLens';
}

function getBendingConfig(block) {
  if (isLensBlock(block)) {
    return {
      radiusAKey: 'frontRadius',
      radiusBKey: 'backRadius',
      syncKeys: /^(frontRadius|backRadius)$/i
    };
  }
  return null;
}

function getBlockValue(block, key) {
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

function computeLensBendingValue(block) {
  if (!isPlainObject(block)) return '';
  const config = getBendingConfig(block);
  if (!config) return '';

  const c1 = parseRadiusCurvature(getBlockValue(block, config.radiusAKey));
  const c2 = parseRadiusCurvature(getBlockValue(block, config.radiusBKey));
  if (c1 === null || c2 === null) return '';

  const curvatureDiff = c1 - c2;
  if (!Number.isFinite(curvatureDiff) || Math.abs(curvatureDiff) < 1e-12) return '';

  const bending = (c1 + c2) / curvatureDiff;
  return Number.isFinite(bending) ? bending : '';
}

function resolveLensBendingUpdate(block, bendingValue) {
  if (!isPlainObject(block)) return null;
  const config = getBendingConfig(block);
  if (!config) return null;
  const params = isPlainObject(block.parameters) ? block.parameters : null;
  if (!params) return null;

  const nextBending = Number(bendingValue);
  if (!Number.isFinite(nextBending)) return null;

  const c1 = parseRadiusCurvature(params[config.radiusAKey]);
  const c2 = parseRadiusCurvature(params[config.radiusBKey]);
  if (c1 === null || c2 === null) return null;
  const curvatureDiff = c1 - c2;
  if (!Number.isFinite(curvatureDiff) || Math.abs(curvatureDiff) < 1e-12) return null;

  const curvatureSum = nextBending * curvatureDiff;
  const nextC1 = (curvatureSum + curvatureDiff) / 2;
  const nextC2 = (curvatureSum - curvatureDiff) / 2;
  if (!Number.isFinite(nextC1) || !Number.isFinite(nextC2)) return null;
  if (Math.abs(nextC1) > 1e6 || Math.abs(nextC2) > 1e6) return null;

  const curvatureToRadius = (curvature) => {
    if (!Number.isFinite(curvature) || Math.abs(curvature) > 1e6) return null;
    if (Math.abs(curvature) < 1e-12) return 'INF';
    const radius = 1 / curvature;
    return Number.isFinite(radius) ? radius : null;
  };

  const nextRadiusA = curvatureToRadius(nextC1);
  const nextRadiusB = curvatureToRadius(nextC2);
  if (nextRadiusA === null || nextRadiusB === null) return null;

  return {
    radiusA: nextRadiusA,
    radiusB: nextRadiusB,
    radiusAKey: config.radiusAKey,
    radiusBKey: config.radiusBKey,
    bending: nextBending
  };
}

function syncDerivedLensBendingValue(block) {
  if (!isPlainObject(block)) return;
  const params = ensureBlockParameters(block);
  if (!params) return;
  if (!getBendingConfig(block)) return;
  const bending = computeLensBendingValue(block);
  params.bending = bending;
  syncLegacyVariableValue(block, 'bending', bending);
}

function shouldMarkV(variableEntry) {
  if (variableEntry === true) return true;
  if (!isPlainObject(variableEntry)) return false;
  const opt = variableEntry.optimize;
  if (!isPlainObject(opt)) return false;
  const mode = String(opt.mode ?? '').trim().toUpperCase();
  return mode === 'V' || mode.includes('V');
}

function isUnsupportedCategoricalKey(key) {
  const s = String(key ?? '').trim().toLowerCase();
  if (!s) return false;
  if (s === 'surftype' || s === 'frontsurftype' || s === 'backsurftype') return true;
  if (/^surf\d+surftype$/.test(s)) return true;
  if (s === 'objectdistancemode' || s === 'thicknessmode') return true;
  if (s === 'apertureshape' || s === 'imagesemidiamode') return true;
  return false;
}

function isDerivedGapThicknessVariable(block, key) {
  if (!isPlainObject(block)) return false;
  if (String(key ?? '').trim().toLowerCase() !== 'thickness') return false;

  const blockType = String(block.blockType ?? '').trim();
  if (blockType !== 'Gap' && blockType !== 'AirGap') return false;

  const params = isPlainObject(block.parameters) ? block.parameters : null;
  const mode = String(params?.thicknessMode ?? '').trim().replace(/\s+/g, '').toUpperCase();
  return mode === 'IMD' || mode === 'BFL';
}

function getValueFromBlock(block, key) {
  if (!isPlainObject(block)) return '';
  if (String(key ?? '').trim().toLowerCase() === 'bending') {
    if (getBendingConfig(block)) {
      return computeLensBendingValue(block);
    }
  }
  // Canonical source of truth is parameters.* when present.
  // (Legacy blocks may still keep a duplicated value in variables.*.value.)
  const params = isPlainObject(block.parameters) ? block.parameters : null;
  if (params && Object.prototype.hasOwnProperty.call(params, key)) {
    const v = params[key];
    // If parameters contains an "empty placeholder" (common during migrations),
    // fall back to variables.*.value.
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

function ensureBlockParameters(block) {
  if (!isPlainObject(block)) return null;
  if (!isPlainObject(block.parameters)) block.parameters = {};
  return block.parameters;
}

function syncLegacyVariableValue(block, key, value) {
  if (!isPlainObject(block) || !isPlainObject(block.variables) || !isPlainObject(block.variables[key])) return;
  const entry = block.variables[key];
  if (Object.prototype.hasOwnProperty.call(entry, 'value')) {
    entry.value = value;
  }
}

function shouldSyncDerivedGlassField(block, key) {
  if (!isPlainObject(block) || !isPlainObject(block.variables)) return true;
  const entry = block.variables[key];
  return !shouldMarkV(entry);
}

function syncDerivedGlassParameters(block, key, materialValue) {
  const materialKey = String(key ?? '').trim();
  const match = materialKey.match(/^material(\d+)?$/i);
  if (!match) return;

  const materialText = String(materialValue ?? '').trim();
  if (!materialText || materialText.toUpperCase() === 'AIR') return;

  const glass = getGlassDataWithSellmeier(materialText);
  if (!glass || typeof glass !== 'object') return;

  const suffix = String(match[1] ?? '').trim();
  const params = ensureBlockParameters(block);
  if (!params) return;

  const rindexKey = suffix ? `rindex${suffix}` : 'rindex';
  const abbeKey = suffix ? `abbe${suffix}` : 'abbe';

  if (shouldSyncDerivedGlassField(block, rindexKey) && Number.isFinite(glass.nd)) {
    const nd = String(glass.nd);
    params[rindexKey] = nd;
    syncLegacyVariableValue(block, rindexKey, nd);
  }
  if (shouldSyncDerivedGlassField(block, abbeKey) && Number.isFinite(glass.vd)) {
    const vd = String(glass.vd);
    params[abbeKey] = vd;
    syncLegacyVariableValue(block, abbeKey, vd);
  }
}

/**
 * Returns variable descriptors for blocks where variables[*].optimize.mode === 'V'.
 *
 * @param {any[]|{blocks:any[]}} blocksOrConfig
 * @returns {Array<{id:string, blockId:string, blockType:string, key:string, value:any}>}
 */
export function listDesignVariablesFromBlocks(blocksOrConfig) {
  const blocks = Array.isArray(blocksOrConfig)
    ? blocksOrConfig
    : (blocksOrConfig && Array.isArray(blocksOrConfig.blocks) ? blocksOrConfig.blocks : []);

  /** @type {Array<{id:string, blockId:string, blockType:string, key:string, value:any}>} */
  const out = [];

  for (const b of blocks) {
    if (!isPlainObject(b)) continue;
    const blockId = String(b.blockId ?? '').trim();
    if (!blockId) continue;
    const blockType = String(b.blockType ?? '').trim();

    const vars = isPlainObject(b.variables) ? b.variables : null;
    if (!vars) continue;

    for (const key of Object.keys(vars)) {
      const entry = vars[key];
      if (!shouldMarkV(entry)) continue;
      if (isUnsupportedCategoricalKey(key)) continue;
      if (isDerivedGapThicknessVariable(b, key)) continue;
      if (blockType === 'Doublet' && String(key).trim().toLowerCase() === 'bending') continue;

      const value = normalizeMaybeNumber(getValueFromBlock(b, key));
      out.push({
        id: `${blockId}.${key}`,
        blockId,
        blockType,
        key,
        value
      });
    }
  }

  return out;
}

/**
 * Applies a new value into the block parameters (canonical value store).
 * This does not change optimize flags.
 *
 * @param {{blocks:any[]}} config
 * @param {string} variableId format: "<blockId>.<key>"
 * @param {any} newValue
 * @returns {boolean}
 */
export function setDesignVariableValue(config, variableId, newValue) {
  if (!config || !Array.isArray(config.blocks)) return false;
  const id = String(variableId ?? '').trim();
  const dot = id.indexOf('.');
  if (dot <= 0) return false;

  const blockId = id.slice(0, dot);
  const key = id.slice(dot + 1);
  if (!blockId || !key) return false;

  const block = config.blocks.find(b => isPlainObject(b) && String(b.blockId) === blockId);
  if (!block) return false;

  const params = ensureBlockParameters(block);
  if (!params) return false;

  const bendingConfig = getBendingConfig(block);

  if (String(key).trim().toLowerCase() === 'bending' && bendingConfig) {
    const resolved = resolveLensBendingUpdate(block, newValue);
    if (!resolved) return false;

    params[resolved.radiusAKey] = resolved.radiusA;
    params[resolved.radiusBKey] = resolved.radiusB;
    params.bending = resolved.bending;
    syncLegacyVariableValue(block, resolved.radiusAKey, resolved.radiusA);
    syncLegacyVariableValue(block, resolved.radiusBKey, resolved.radiusB);
    syncLegacyVariableValue(block, 'bending', resolved.bending);
    return true;
  }

  const normalized = normalizeMaybeNumber(newValue);
  params[key] = normalized;
  syncDerivedGlassParameters(block, key, normalized);

  // Keep legacy duplicated storage in sync, if present.
  syncLegacyVariableValue(block, key, normalized);
  if (bendingConfig && (bendingConfig.syncKeys.test(String(key ?? '').trim()) || String(key ?? '').trim().toLowerCase() === 'bending')) {
    syncDerivedLensBendingValue(block);
  }

  return true;
}
