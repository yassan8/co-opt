/**
 * Blocks (Design Intent) → design-variable registry
 *
 * This module is intentionally UI-agnostic.
 * Optimizers can use it to enumerate variables and apply updates.
 */

import { getGlassDataWithSellmeier } from '../data/glass.ts';

export interface ToleranceVariableDescriptor {
  id: string;
  configId?: string;
  blockId: string;
  blockType: string;
  key: string;
  value: number;
  label: string;
  unit: string;
  category: 'radius' | 'thickness' | 'material' | 'asphere' | 'decenter' | 'tilt' | 'aperture' | 'position' | 'other';
  suggestedCompensator?: boolean;
}

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
    if (blockType === 'Stop') continue;

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

/** Returns the current numeric value for any stable "blockId.parameter" reference. */
export function getDesignVariableValue(config, variableId) {
  if (!config || !Array.isArray(config.blocks)) return '';
  const id = String(variableId ?? '').trim();
  const dot = id.indexOf('.');
  if (dot <= 0) return '';
  const blockId = id.slice(0, dot);
  const key = id.slice(dot + 1);
  const block = config.blocks.find((entry) => isPlainObject(entry) && String(entry.blockId) === blockId);
  return block ? getValueFromBlock(block, key) : '';
}

const TOLERANCE_BLOCK_TYPES = new Set([
  'Lens', 'PositiveLens', 'Doublet', 'Triplet', 'Surface', 'Stop', 'Gap', 'AirGap',
  'CoordinateTransform', 'Paraxial', 'ParaxialLens', 'IdealLens', 'Mirror', 'FoldMirror',
  'BeamSplitter', 'NDFilter', 'ReflectionGrating', 'Target', 'AreaDetector', 'TimeDetector',
]);

const TOLERANCE_KEY_PATTERN = /(radius|thickness|conic|coef|coefficient|qcon|decenter|tilt|position[xyz]|rotation[xyz]|rindex|refractiveindex|abbe|semi(?:dia|diameter)|wedge|distance|focal(?:length)?[xy]?|pixelpitch|pitchum)/i;
const TOLERANCE_KEY_DENY_PATTERN = /(sample|sampling|count|number|rays?|wavelength|power|weight|primary|mode|shape|profile|order|density|efficiency|reflect|transmi|phase|exposure|bitdepth|saturation|fillfactor|quantum|responsivity|period|amplitude|offset|height|width|depth)/i;

function toleranceCategory(key) {
  const value = String(key ?? '').toLowerCase();
  if (value.includes('radius') || value.includes('focal')) return 'radius';
  if (value.includes('thickness') || value.includes('distance')) return 'thickness';
  if (value.includes('rindex') || value.includes('refractive') || value.includes('abbe')) return 'material';
  if (value.includes('conic') || value.includes('coef') || value.includes('qcon')) return 'asphere';
  if (value.includes('decenter')) return 'decenter';
  if (value.includes('tilt') || value.includes('rotation')) return 'tilt';
  if (value.includes('semi')) return 'aperture';
  if (value.includes('position')) return 'position';
  return 'other';
}

function toleranceUnit(key, category) {
  const value = String(key ?? '').toLowerCase();
  if (category === 'tilt' || value.includes('angle')) return 'deg';
  if (category === 'material' || category === 'asphere') return '';
  if (value.includes('pitchum')) return 'µm';
  return 'mm';
}

function readableToleranceKey(key) {
  return String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (value) => value.toUpperCase());
}

/**
 * Enumerates manufacturing/alignment values independently from Optimize's V flags.
 * Categorical and calculation-control fields are intentionally omitted.
 */
export function listToleranceVariablesFromConfig(config): ToleranceVariableDescriptor[] {
  if (!config || !Array.isArray(config.blocks)) return [];
  const out: ToleranceVariableDescriptor[] = [];
  const seen = new Set();
  const blocks = config.blocks;
  let lastGapId = '';
  for (const block of blocks) {
    const blockType = String(block?.blockType ?? '').trim();
    if (blockType === 'Gap' || blockType === 'AirGap') lastGapId = String(block?.blockId ?? '');
  }

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    if (!isPlainObject(block)) continue;
    const blockId = String(block.blockId ?? '').trim();
    const blockType = String(block.blockType ?? '').trim();
    if (!blockId || !TOLERANCE_BLOCK_TYPES.has(blockType)) continue;
    const keys = new Set([
      ...Object.keys(isPlainObject(block.parameters) ? block.parameters : {}),
      ...Object.keys(isPlainObject(block.variables) ? block.variables : {}),
    ]);
    for (const key of keys) {
      if (!TOLERANCE_KEY_PATTERN.test(key) || TOLERANCE_KEY_DENY_PATTERN.test(key)) continue;
      if (/^(bending|objectdistance|imagedistance|thicknessmode|semidiamode)$/i.test(key)) continue;
      const numeric = Number(getValueFromBlock(block, key));
      if (!Number.isFinite(numeric)) continue;
      const id = `${blockId}.${key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const category = toleranceCategory(key);
      const blockLabel = String(block?.parameters?.label ?? block?.parameters?.name ?? block?.metadata?.label ?? blockId);
      out.push({
        id,
        blockId,
        blockType,
        key,
        value: numeric,
        label: `${blockLabel} · ${readableToleranceKey(key)}`,
        unit: toleranceUnit(key, category),
        category,
        suggestedCompensator: blockId === lastGapId && /^thickness$/i.test(key),
      });
    }
  }

  for (const connection of (Array.isArray(config.designConnections) ? config.designConnections : [])) {
    const ownerId = String(connection?.id ?? '').trim();
    if (!ownerId) continue;
    for (const key of CONNECTION_VARIABLE_KEYS) {
      const value = Number(assemblyVariableValue(config, 'connection', connection, key));
      if (!Number.isFinite(value)) continue;
      const id = `connection:${ownerId}.${key}`;
      out.push({
        id,
        blockId: `connection:${ownerId}`,
        blockType: 'PortConnection',
        key,
        value,
        label: `${String(connection?.label ?? ownerId)} · ${readableToleranceKey(key)}`,
        unit: key === 'distanceMm' ? 'mm' : 'deg',
        category: key === 'distanceMm' ? 'position' : 'tilt',
      });
    }
  }

  for (const group of (Array.isArray(config.sequentialGroups) ? config.sequentialGroups : [])) {
    const ownerId = String(group?.id ?? '').trim();
    if (!ownerId) continue;
    for (const key of GROUP_VARIABLE_KEYS) {
      const value = Number(assemblyVariableValue(config, 'group', group, key));
      if (!Number.isFinite(value)) continue;
      const id = `group:${ownerId}.${key}`;
      out.push({
        id,
        blockId: `group:${ownerId}`,
        blockType: 'SequentialGroupPose',
        key,
        value,
        label: `${String(group?.label ?? ownerId)} · ${readableToleranceKey(key)}`,
        unit: key.startsWith('position') ? 'mm' : 'deg',
        category: key.startsWith('position') ? 'position' : 'tilt',
      });
    }
  }
  return out;
}

const CONNECTION_VARIABLE_KEYS = ['distanceMm', 'azimuthDeg', 'elevationDeg'];
const GROUP_VARIABLE_KEYS = ['positionX', 'positionY', 'positionZ', 'rotationX', 'rotationY', 'rotationZ'];

function assemblyVariableValue(config, kind, owner, key) {
  if (kind === 'connection') return normalizeMaybeNumber(owner?.[key]);
  const root = owner?.rootTransform ?? {};
  if (key === 'positionX') return normalizeMaybeNumber(root?.positionMm?.x ?? 0);
  if (key === 'positionY') return normalizeMaybeNumber(root?.positionMm?.y ?? 0);
  if (key === 'positionZ') return normalizeMaybeNumber(root?.positionMm?.z ?? 0);
  if (key === 'rotationX') return normalizeMaybeNumber(root?.rotationDeg?.x ?? 0);
  if (key === 'rotationY') return normalizeMaybeNumber(root?.rotationDeg?.y ?? 0);
  if (key === 'rotationZ') return normalizeMaybeNumber(root?.rotationDeg?.z ?? 0);
  return '';
}

/** Continuous Port-route layout variables, expressed with the same descriptors as block variables. */
export function listAssemblyDesignVariables(config) {
  if (!config || typeof config !== 'object') return [];
  const out = [];
  for (const connection of (Array.isArray(config.designConnections) ? config.designConnections : [])) {
    const ownerId = String(connection?.id ?? '').trim();
    if (!ownerId) continue;
    for (const key of CONNECTION_VARIABLE_KEYS) {
      const entry = connection?.variables?.[key];
      if (!shouldMarkV(entry)) continue;
      out.push({
        id: `connection:${ownerId}.${key}`,
        blockId: `connection:${ownerId}`,
        blockType: 'PortConnection',
        key,
        value: assemblyVariableValue(config, 'connection', connection, key),
      });
    }
  }
  for (const group of (Array.isArray(config.sequentialGroups) ? config.sequentialGroups : [])) {
    const ownerId = String(group?.id ?? '').trim();
    if (!ownerId) continue;
    for (const key of GROUP_VARIABLE_KEYS) {
      const entry = group?.rootTransformVariables?.[key];
      if (!shouldMarkV(entry)) continue;
      out.push({
        id: `group:${ownerId}.${key}`,
        blockId: `group:${ownerId}`,
        blockType: 'SequentialGroupPose',
        key,
        value: assemblyVariableValue(config, 'group', group, key),
      });
    }
  }
  return out;
}

export function getAssemblyVariableEntry(config, variableId) {
  const match = String(variableId ?? '').trim().match(/^(connection|group):(.+)\.([^.]+)$/);
  if (!match || !config || typeof config !== 'object') return null;
  const [, kind, ownerId, key] = match;
  if (kind === 'connection') {
    const owner = (config.designConnections ?? []).find((item) => String(item?.id) === ownerId);
    return owner?.variables?.[key] ?? null;
  }
  const owner = (config.sequentialGroups ?? []).find((item) => String(item?.id) === ownerId);
  return owner?.rootTransformVariables?.[key] ?? null;
}

export function getAssemblyDesignVariableValue(config, variableId) {
  const match = String(variableId ?? '').trim().match(/^(connection|group):(.+)\.([^.]+)$/);
  if (!match || !config || typeof config !== 'object') return '';
  const [, kind, ownerId, key] = match;
  const owner = kind === 'connection'
    ? (config.designConnections ?? []).find((item) => String(item?.id) === ownerId)
    : (config.sequentialGroups ?? []).find((item) => String(item?.id) === ownerId);
  return owner ? assemblyVariableValue(config, kind, owner, key) : '';
}

export function setAssemblyDesignVariableValue(config, variableId, newValue) {
  const match = String(variableId ?? '').trim().match(/^(connection|group):(.+)\.([^.]+)$/);
  const numeric = Number(newValue);
  if (!match || !Number.isFinite(numeric) || !config || typeof config !== 'object') return false;
  const [, kind, ownerId, key] = match;
  if (kind === 'connection') {
    if (!CONNECTION_VARIABLE_KEYS.includes(key)) return false;
    const owner = (config.designConnections ?? []).find((item) => String(item?.id) === ownerId);
    if (!owner) return false;
    owner[key] = key === 'distanceMm' ? Math.max(0, numeric) : (key === 'elevationDeg' ? Math.max(-90, Math.min(90, numeric)) : numeric);
    if (owner.variables?.[key]) owner.variables[key].value = owner[key];
    return true;
  }
  if (!GROUP_VARIABLE_KEYS.includes(key)) return false;
  const owner = (config.sequentialGroups ?? []).find((item) => String(item?.id) === ownerId);
  if (!owner) return false;
  if (!owner.rootTransform) owner.rootTransform = { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } };
  if (!owner.rootTransform.positionMm) owner.rootTransform.positionMm = { x: 0, y: 0, z: 0 };
  if (!owner.rootTransform.rotationDeg) owner.rootTransform.rotationDeg = { x: 0, y: 0, z: 0 };
  const positionKey = key.startsWith('position');
  const axis = key.slice(-1).toLowerCase();
  (positionKey ? owner.rootTransform.positionMm : owner.rootTransform.rotationDeg)[axis] = numeric;
  if (owner.rootTransformVariables?.[key]) owner.rootTransformVariables[key].value = numeric;
  return true;
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
  if (String(block.blockType ?? '').trim() === 'Stop') return false;

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
