/**
 * Blocks (Design Intent) → design-variable registry
 *
 * This module is intentionally UI-agnostic.
 * Optimizers can use it to enumerate variables and apply updates.
 */

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

function shouldMarkV(variableEntry) {
  if (variableEntry === true) return true;
  if (!isPlainObject(variableEntry)) return false;
  const opt = variableEntry.optimize;
  if (!isPlainObject(opt)) return false;
  return opt.mode === 'V';
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

function getValueFromBlock(block, key) {
  if (!isPlainObject(block)) return '';
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
  const normalized = normalizeMaybeNumber(newValue);
  params[key] = normalized;

  // Keep legacy duplicated storage in sync, if present.
  if (isPlainObject(block.variables) && isPlainObject(block.variables[key])) {
    const entry = block.variables[key];
    if (Object.prototype.hasOwnProperty.call(entry, 'value')) {
      entry.value = normalized;
    }
  }

  return true;
}
