// Block-based optical design schema (MVP)
// - Canonical storage: blocks[] in configuration
// - Deterministic expansion: blocks -> OpticalSystemTableData row array
// - Supported blocks (MVP): ObjectPlane, Lens, Stop, AirGap, ImagePlane
// - Glass material must exist in glass.js DB; numeric refractive index is disallowed.

import { getAllGlassDatabases, getGlassDataWithSellmeier } from './glass.js';

export const BLOCK_SCHEMA_VERSION = '0.1';
export const DEFAULT_SEMIDIA = '10';
export const DEFAULT_STOP_SEMI_DIAMETER = 5.0;

const ALLOWED_SURF_TYPES = new Set(['', 'Spherical', 'Aspheric even', 'Aspheric odd']);

function normalizeSurfTypeValue(value) {
  const s = String(value ?? '').trim();
  if (s === '') return '';

  // Normalize aggressively so legacy imports don't fail Blocks validation.
  // Only return canonical values in ALLOWED_SURF_TYPES (or '').
  const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();

  // Zemax/CodeV style
  // IMPORTANT:
  // - '' means "unspecified/default" and may be inferred from non-zero asphere params.
  // - 'Spherical' is an explicit choice and MUST override any leftover conic/coefs.
  if (key === 'standard' || key === 'std') return '';
  if (key === 'spherical' || key === 'sphere' || key === 'sph') return 'Spherical';
  if (key === 'asphericaleven' || key === 'asphericeven' || key === 'evenasphere' || key === 'evenaspheric') return 'Aspheric even';
  if (key === 'asphericalodd' || key === 'asphericodd' || key === 'oddasphere' || key === 'oddaspheric') return 'Aspheric odd';

  // Fuzzy matches
  if (key.includes('aspher') && key.includes('even')) return 'Aspheric even';
  if (key.includes('aspher') && key.includes('odd')) return 'Aspheric odd';

  // Unknown surfType: treat as spherical to keep conversion best-effort.
  return '';
}

function normalizeOptionalNumberToRowValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const s = String(value).trim();
  if (s === '') return '';
  if (isNumericString(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? String(n) : '';
  }
  return '';
}

function blockAsphereLooksNonZero({ surfType, conic, coefs }) {
  const st = normalizeSurfTypeValue(surfType);
  if (st === 'Aspheric even' || st === 'Aspheric odd') return true;
  const c = Number(String(conic ?? '').trim());
  if (Number.isFinite(c) && Math.abs(c) > 0) return true;
  if (Array.isArray(coefs)) {
    for (const v of coefs) {
      const n = Number(String(v ?? '').trim());
      if (Number.isFinite(n) && Math.abs(n) > 0) return true;
    }
  }
  return false;
}

/**
 * @typedef {'fatal'|'warning'} LoadIssueSeverity
 * @typedef {'parse'|'validate'|'expand'} LoadIssuePhase
 * @typedef {{
 *   severity: LoadIssueSeverity,
 *   phase: LoadIssuePhase,
 *   message: string,
 *   blockId?: string,
 *   surfaceIndex?: number
 * }} LoadIssue
 */

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumericString(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s === '') return false;
  return /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s);
}

function normalizeRadiusToRowValue(value) {
  if (value === null || value === undefined) return 'INF';
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return 'INF';
    if (/^inf(inity)?$/i.test(s)) return 'INF';
    if (isNumericString(s)) {
      const n = Number(s);
      if (!Number.isFinite(n) || Math.abs(n) < 1e-12) return 'INF';
      return String(n);
    }
    return s;
  }
  if (isFiniteNumber(value)) {
    if (Math.abs(value) < 1e-12) return 'INF';
    return String(value);
  }
  return 'INF';
}

function normalizeThicknessToRowValue(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return 0;
    if (/^inf(inity)?$/i.test(s)) return 'INF';
    if (isNumericString(s)) return Number(s);
    return 0;
  }
  if (isFiniteNumber(value)) return value;
  return 0;
}

function normalizeSemidia(prevRow) {
  const prev = prevRow?.semidia;
  if (typeof prev === 'number' && Number.isFinite(prev)) return String(prev);
  if (typeof prev === 'string') {
    const s = prev.trim();
    if (isNumericString(s)) {
      const n = Number(s);
      if (Number.isFinite(n)) return String(n);
    }
  }
  // Unspecified semidia should stay unspecified.
  // Treating missing semidia as a numeric default (e.g., 10mm) silently introduces
  // a physical aperture limit and can incorrectly vignette off-axis rays.
  return '';
}

function __semidiaHasValue(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  return s !== '';
}

function __getRowSemidia(row) {
  if (!row || typeof row !== 'object') return null;
  return row.semidia ?? row['Semi Diameter'] ?? row['semi diameter'] ?? row.semiDiameter ?? row.semiDia;
}

function __rowTypeLower(row) {
  return String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
}

function __isCoordTransRow(row) {
  if (!row || typeof row !== 'object') return false;
  const ot = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
  if (ot === 'ct' || ot === 'coord trans' || ot === 'coordinate transform') return true;
  const st = String(row?.surfType ?? row?.['surface type'] ?? row?.surfaceType ?? '').trim().toLowerCase();
  return st === 'ct' || st === 'coord trans' || st === 'coordinate transform' || st === 'coordtrans' || st === 'coordinatetransform';
}

function __provenanceKey(row) {
  if (!row || typeof row !== 'object') return null;
  const blockId = row._blockId;
  const role = row._surfaceRole;
  const bid = (blockId === null || blockId === undefined) ? '' : String(blockId).trim();
  const r = (role === null || role === undefined) ? '' : String(role).trim();
  if (!bid || !r) return null;
  return `p:${bid}|${r}`;
}

function __captureSemidiaOverridesFromRows(rows, existingOverrides) {
  const out = (existingOverrides && typeof existingOverrides === 'object') ? { ...existingOverrides } : {};
  if (!Array.isArray(rows)) return out;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    const t = __rowTypeLower(row);
    if (t === 'stop' || t === 'image' || __isCoordTransRow(row)) continue;
    const v = __getRowSemidia(row);
    if (!__semidiaHasValue(v)) continue;
    const pk = __provenanceKey(row);
    const key = pk || `i:${i}`;
    const incoming = String(v).trim();
    const existing = __semidiaHasValue(out[key]) ? String(out[key]).trim() : '';
    // Do not overwrite a non-default existing value with default '10' (common failure mode).
    if (existing !== '' && existing !== String(DEFAULT_SEMIDIA).trim() && incoming === String(DEFAULT_SEMIDIA).trim()) {
      continue;
    }
    out[key] = v;
  }
  return out;
}

function __applySemidiaOverridesToRows(rows, overrides) {
  if (!Array.isArray(rows) || !overrides || typeof overrides !== 'object') return;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    const t = __rowTypeLower(row);
    if (t === 'stop' || t === 'image' || __isCoordTransRow(row)) continue;
    const pk = __provenanceKey(row);
    let v = null;
    if (pk && __semidiaHasValue(overrides[pk])) v = overrides[pk];
    else {
      const ik = `i:${i}`;
      if (__semidiaHasValue(overrides[ik])) v = overrides[ik];
    }
    if (__semidiaHasValue(v)) row.semidia = v;
  }
}

function __captureBlockApertureFromLegacyRows(blocks, legacyRows) {
  if (!Array.isArray(blocks) || !Array.isArray(legacyRows)) return;
  const byId = new Map();
  for (const b of blocks) {
    const id = String(b?.blockId ?? '').trim();
    if (!id) continue;
    byId.set(id, b);
  }

  for (const row of legacyRows) {
    if (!row || typeof row !== 'object') continue;
    const t = __rowTypeLower(row);
    if (t === 'stop' || t === 'image' || __isCoordTransRow(row)) continue;
    const blockId = String(row._blockId ?? '').trim();
    const role = String(row._surfaceRole ?? '').trim();
    if (!blockId || !role) continue;
    const v = __getRowSemidia(row);
    if (!__semidiaHasValue(v)) continue;

    const block = byId.get(blockId);
    if (!block || typeof block !== 'object') continue;
    if (!isPlainObject(block.aperture)) block.aperture = {};

    const incoming = String(v).trim();
    const existing = __semidiaHasValue(block.aperture[role]) ? String(block.aperture[role]).trim() : '';
    // Do not overwrite a non-default existing value with default '10'.
    if (existing !== '' && existing !== String(DEFAULT_SEMIDIA).trim() && incoming === String(DEFAULT_SEMIDIA).trim()) {
      continue;
    }
    block.aperture[role] = v;
  }
}

function includesDisallowedSurfaceReference(value) {
  // Disallow surfaceId / surfaceIndex anywhere inside Block.variables
  const seen = new Set();

  const walk = (v) => {
    if (!v || typeof v !== 'object') return false;
    if (seen.has(v)) return false;
    seen.add(v);

    if (Array.isArray(v)) {
      for (const item of v) {
        if (walk(item)) return true;
      }
      return false;
    }

    for (const [k, vv] of Object.entries(v)) {
      if (k === 'surfaceId' || k === 'surfaceIndex') return true;
      if (walk(vv)) return true;
    }
    return false;
  };

  return walk(value);
}

function isKnownGlassNameOnly(glassName) {
  if (typeof glassName !== 'string') return false;
  const name = glassName.trim();
  if (name === '') return false;
  if (isNumericString(name)) return false; // numeric refractive index is forbidden
  const data = getGlassDataWithSellmeier(name);
  return !!data;
}

function isDisallowedMaterialToken(material) {
  // NOTE: numeric "material" is allowed in this codebase (see glass.js:getGlassDataWithSellmeier).
  // Keep the helper for legacy callsites, but do NOT treat numeric material as fatal.
  return false;
}

function __isNumericMaterialName(material) {
  if (typeof material !== 'string') return false;
  const s = material.trim();
  if (!isNumericString(s)) return false;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < 4;
}

function __findClosestGlassNameByNdVd(targetNd, targetVd) {
  if (!Number.isFinite(targetNd) || !Number.isFinite(targetVd) || targetNd <= 0 || targetVd <= 0) return null;
  const dbs = getAllGlassDatabases();

  let best = null;
  let bestScore = Infinity;

  for (const db of dbs) {
    if (!Array.isArray(db)) continue;
    for (const g of db) {
      if (!g) continue;
      const nd = g.nd;
      const vd = g.vd;
      if (!Number.isFinite(nd) || !Number.isFinite(vd)) continue;
      // Weighted squared error (simple, fast, robust enough for import).
      const dn = nd - targetNd;
      const dv = vd - targetVd;
      const score = dn * dn + (dv * dv) * 1e-4;
      if (score < bestScore) {
        bestScore = score;
        best = g;
      }
    }
  }
  return best && typeof best.name === 'string' ? best.name : null;
}

function __normalizeLegacyMaterialForBlocks(rowObj, rowIndex, issues) {
  const raw = String(rowObj?.material ?? '').trim();
  if (raw === '' || raw.toUpperCase() === 'AIR') return raw;

  // If legacy stores numeric refractive index in material, try to map to a real glass name
  // using (rindex, abbe) if available. If not, keep the numeric name (synthetic glass).
  if (__isNumericMaterialName(raw)) {
    const nd = Number(raw);
    const vd = Number.parseFloat(String(rowObj?.abbe ?? '').trim());
    const vdOk = Number.isFinite(vd) && vd > 0;
    if (vdOk) {
      const guess = __findClosestGlassNameByNdVd(nd, vd);
      if (guess) {
        issues.push({
          severity: 'warning',
          phase: 'validate',
          message: `Numeric material at row ${rowIndex} (${raw}, Abbe=${vd}) mapped to closest glass: ${guess}`
        });
        return guess;
      }
    }

    issues.push({
      severity: 'warning',
      phase: 'validate',
      message: `Numeric material at row ${rowIndex} (${raw}) kept as synthetic glass (dispersion may be inaccurate).`
    });
    return raw;
  }

  return raw;
}

function getVariableValue(variables, key) {
  if (!isPlainObject(variables)) return undefined;
  const entry = variables[key];
  if (!isPlainObject(entry)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(entry, 'value')) return undefined;
  return entry.value;
}

function getParamOrVarValue(parameters, variables, key) {
  if (isPlainObject(parameters) && Object.prototype.hasOwnProperty.call(parameters, key)) {
    return parameters[key];
  }
  return getVariableValue(variables, key);
}

function shouldMarkV(variableEntry) {
  // MVP: only UI mode 'V' means variable. Empty means fixed.
  if (variableEntry === true) return true;
  if (!isPlainObject(variableEntry)) return false;
  const optimize = variableEntry.optimize;
  if (!isPlainObject(optimize)) return false;
  return optimize.mode === 'V';
}

export function configurationHasBlocks(config) {
  return isPlainObject(config) && Array.isArray(config.blocks);
}

/**
 * Validate blocks inside a configuration.
 * @param {any} config
 * @returns {LoadIssue[]}
 */
export function validateBlocksConfiguration(config) {
  /** @type {LoadIssue[]} */
  const issues = [];

  if (!configurationHasBlocks(config)) return issues;

  if (includesDisallowedSurfaceReference(config.blocks)) {
    issues.push({
      severity: 'fatal',
      phase: 'validate',
      message: 'Block.variables must use block-local coordinates only (surfaceId/surfaceIndex is forbidden).'
    });
    return issues;
  }

  // ObjectPlane rules: at most one.
  try {
    const nObjectPlane = (config.blocks || []).filter(b => String(b?.blockType ?? '').trim() === 'ObjectPlane').length;
    if (nObjectPlane > 1) {
      issues.push({
        severity: 'fatal',
        phase: 'validate',
        message: 'Only one ObjectPlane block is supported.'
      });
    }
  } catch (_) {}

  for (const block of config.blocks) {
    const blockId = isPlainObject(block) ? block.blockId : undefined;

    if (!isPlainObject(block)) {
      issues.push({ severity: 'fatal', phase: 'validate', message: 'Block must be an object.', blockId });
      continue;
    }

    if (typeof block.blockId !== 'string' || block.blockId.trim() === '') {
      issues.push({ severity: 'fatal', phase: 'validate', message: 'blockId is required.', blockId });
      continue;
    }

    if (typeof block.blockType !== 'string' || block.blockType.trim() === '') {
      issues.push({ severity: 'fatal', phase: 'validate', message: 'blockType is required.', blockId: block.blockId });
      continue;
    }

    const blockType = block.blockType;
    if (blockType !== 'ObjectPlane' && blockType !== 'Lens' && blockType !== 'PositiveLens' && blockType !== 'Doublet' && blockType !== 'Triplet' && blockType !== 'Gap' && blockType !== 'AirGap' && blockType !== 'Stop' && blockType !== 'CoordTrans' && blockType !== 'Mirror' && blockType !== 'ImagePlane') {
      issues.push({
        severity: 'fatal',
        phase: 'validate',
        message: `Unsupported blockType: ${blockType} (MVP supports ObjectPlane, Lens, Doublet, Triplet, Gap, Stop, CoordTrans, Mirror, ImagePlane only).`,
        blockId: block.blockId
      });
      continue;
    }

    const parameters = isPlainObject(block.parameters) ? block.parameters : {};
    const variables = block.variables;

    if (blockType !== 'ImagePlane') {
      const hasParams = isPlainObject(block.parameters);
      const hasVars = isPlainObject(block.variables);
      if (!hasParams && !hasVars) {
        issues.push({ severity: 'fatal', phase: 'validate', message: 'Either parameters or variables must be provided.', blockId: block.blockId });
        continue;
      }
    }

    if (variables !== undefined && !isPlainObject(variables)) {
      issues.push({ severity: 'fatal', phase: 'validate', message: 'variables must be an object when provided.', blockId: block.blockId });
      continue;
    }

    if (blockType === 'ObjectPlane') {
      const modeRaw = getParamOrVarValue(parameters, variables, 'objectDistanceMode');
      const mode = String(modeRaw ?? '').trim();
      const modeKey = mode.replace(/\s+/g, '').toUpperCase();
      const isInf = modeKey === 'INF' || modeKey === 'INFINITY';
      const isFinite = modeKey === '' || modeKey === 'FINITE';

      if (!isInf && !isFinite) {
        issues.push({
          severity: 'fatal',
          phase: 'validate',
          message: `ObjectPlane.objectDistanceMode must be Finite or INF (got: ${mode})`,
          blockId: block.blockId
        });
      }

      if (!isInf) {
        const d = getParamOrVarValue(parameters, variables, 'objectDistance');
        if (d === undefined) {
          issues.push({ severity: 'fatal', phase: 'validate', message: 'ObjectPlane.objectDistance is required when mode is Finite.', blockId: block.blockId });
        } else {
          const v = normalizeThicknessToRowValue(d);
          if (v === 'INF') {
            issues.push({ severity: 'warning', phase: 'validate', message: 'ObjectPlane.objectDistance is INF; treating as INF.', blockId: block.blockId });
          } else if (typeof v === 'number' && Number.isFinite(v) && v <= 0) {
            issues.push({ severity: 'warning', phase: 'validate', message: `ObjectPlane.objectDistance is <= 0 (${String(v)}).`, blockId: block.blockId });
          }
        }
      }
    }

    if (blockType === 'Lens' || blockType === 'PositiveLens') {
      const frontRadius = getParamOrVarValue(parameters, variables, 'frontRadius');
      const backRadius = getParamOrVarValue(parameters, variables, 'backRadius');
      const centerThickness = getParamOrVarValue(parameters, variables, 'centerThickness');
      const material = getParamOrVarValue(parameters, variables, 'material');

      // Optional asphere parameters (canonical): front/back surfType + conic + coef1..coef10.
      // These are not required, but when provided they must be well-formed.
      const frontSurfType = normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, 'frontSurfType'));
      const backSurfType = normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, 'backSurfType'));

      if (frontSurfType && !ALLOWED_SURF_TYPES.has(frontSurfType)) {
        issues.push({ severity: 'fatal', phase: 'validate', message: `Lens.frontSurfType must be one of: Spherical, Aspheric even, Aspheric odd. Got: ${frontSurfType}`, blockId: block.blockId });
      }
      if (backSurfType && !ALLOWED_SURF_TYPES.has(backSurfType)) {
        issues.push({ severity: 'fatal', phase: 'validate', message: `Lens.backSurfType must be one of: Spherical, Aspheric even, Aspheric odd. Got: ${backSurfType}`, blockId: block.blockId });
      }

      if (frontRadius === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Lens.frontRadius is required.', blockId: block.blockId });
      if (backRadius === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Lens.backRadius is required.', blockId: block.blockId });
      if (centerThickness === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Lens.centerThickness is required.', blockId: block.blockId });

      if (typeof material !== 'string' || material.trim() === '') {
        issues.push({ severity: 'fatal', phase: 'validate', message: 'Lens.material (glass name) is required.', blockId: block.blockId });
      } else if (__isNumericMaterialName(material)) {
        issues.push({
          severity: 'warning',
          phase: 'validate',
          message: `Lens.material is numeric (${material}). Treated as synthetic glass; dispersion may be inaccurate.`,
          blockId: block.blockId
        });
      } else if (!isKnownGlassNameOnly(material)) {
        issues.push({
          severity: 'warning',
          phase: 'validate',
          message: `Unknown glass name (allowed for imported/legacy designs): ${material}`,
          blockId: block.blockId
        });
      }

      // Future modes: warn but do not fail.
      if (isPlainObject(variables)) {
        for (const [k, v] of Object.entries(variables)) {
          if (!isPlainObject(v) || !isPlainObject(v.optimize) || v.optimize.mode === undefined) continue;
          const mode = v.optimize.mode;
          if (mode !== 'V' && mode !== '' && mode !== undefined && mode !== null) {
            issues.push({
              severity: 'warning',
              phase: 'validate',
              message: `variables.${k}.optimize.mode=${String(v.optimize.mode)} is not supported yet; treating as fixed.`,
              blockId: block.blockId
            });
          }
        }
      }

      // Numeric sanity checks (non-fatal: allow 0/INF mapping later)
      if (centerThickness !== undefined) {
        const t = normalizeThicknessToRowValue(centerThickness);
        if (t === 'INF') {
          issues.push({
            severity: 'warning',
            phase: 'validate',
            message: 'Lens.centerThickness is INF; this is unusual. Treating as INF.',
            blockId: block.blockId
          });
        }
      }
    }

    if (blockType === 'Mirror') {
      const radius = getParamOrVarValue(parameters, variables, 'radius');
      const thickness = getParamOrVarValue(parameters, variables, 'thickness');
      const material = getParamOrVarValue(parameters, variables, 'material');

      const surfType = normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, 'surfType'));
      if (surfType && !ALLOWED_SURF_TYPES.has(surfType)) {
        issues.push({ severity: 'fatal', phase: 'validate', message: `Mirror.surfType must be one of: Spherical, Aspheric even, Aspheric odd. Got: ${surfType}`, blockId: block.blockId });
      }

      if (radius === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Mirror.radius is required.', blockId: block.blockId });
      if (thickness === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Mirror.thickness is required.', blockId: block.blockId });

      if (typeof material !== 'string' || material.trim() === '') {
        issues.push({ severity: 'warning', phase: 'validate', message: 'Mirror.material is missing; MIRROR will be assumed.', blockId: block.blockId });
      } else if (String(material).trim().toUpperCase() !== 'MIRROR') {
        issues.push({ severity: 'warning', phase: 'validate', message: `Mirror.material should be MIRROR (got: ${String(material)})`, blockId: block.blockId });
      }

      const normalizeShape = (v) => {
        const s = String(v ?? '').trim();
        if (!s) return 'Circular';
        const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
        if (key === 'circle' || key === 'circular') return 'Circular';
        if (key === 'square' || key === 'sq') return 'Square';
        if (key === 'rect' || key === 'rectangle' || key === 'rectangular') return 'Rectangular';
        return s;
      };

      const shape = normalizeShape(getParamOrVarValue(parameters, variables, 'apertureShape'));
      if (shape !== 'Circular' && shape !== 'Square' && shape !== 'Rectangular') {
        issues.push({ severity: 'warning', phase: 'validate', message: `Mirror.apertureShape is unknown (${shape}).`, blockId: block.blockId });
      }

      const semidiaRaw = getParamOrVarValue(parameters, variables, 'semidia');
      const widthRaw = getParamOrVarValue(parameters, variables, 'apertureWidth');
      const heightRaw = getParamOrVarValue(parameters, variables, 'apertureHeight');
      const semidiaVal = Number(String(semidiaRaw ?? '').trim());
      const widthVal = Number(String(widthRaw ?? '').trim());
      const heightVal = Number(String(heightRaw ?? '').trim());

      if (shape === 'Circular') {
        if (semidiaRaw !== undefined && (!Number.isFinite(semidiaVal) || semidiaVal <= 0)) {
          issues.push({ severity: 'warning', phase: 'validate', message: `Mirror.semidia should be positive for Circular aperture (${String(semidiaRaw)}).`, blockId: block.blockId });
        }
      } else if (shape === 'Square') {
        const side = Number.isFinite(widthVal) ? widthVal : heightVal;
        if (!Number.isFinite(side) || side <= 0) {
          issues.push({ severity: 'warning', phase: 'validate', message: `Mirror.apertureWidth should be positive for Square aperture (${String(widthRaw ?? heightRaw)}).`, blockId: block.blockId });
        }
      } else if (shape === 'Rectangular') {
        if (!Number.isFinite(widthVal) || widthVal <= 0 || !Number.isFinite(heightVal) || heightVal <= 0) {
          issues.push({ severity: 'warning', phase: 'validate', message: `Mirror.apertureWidth/Height should be positive for Rectangular aperture (w=${String(widthRaw)}, h=${String(heightRaw)}).`, blockId: block.blockId });
        }
      }
    }

    if (blockType === 'Doublet') {
      const radius1 = getParamOrVarValue(parameters, variables, 'radius1');
      const radius2 = getParamOrVarValue(parameters, variables, 'radius2');
      const radius3 = getParamOrVarValue(parameters, variables, 'radius3');
      const thickness1 = getParamOrVarValue(parameters, variables, 'thickness1');
      const thickness2 = getParamOrVarValue(parameters, variables, 'thickness2');
      const material1 = getParamOrVarValue(parameters, variables, 'material1');
      const material2 = getParamOrVarValue(parameters, variables, 'material2');

      if (radius1 === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Doublet.radius1 is required.', blockId: block.blockId });
      if (radius2 === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Doublet.radius2 is required.', blockId: block.blockId });
      if (radius3 === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Doublet.radius3 is required.', blockId: block.blockId });
      if (thickness1 === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Doublet.thickness1 is required.', blockId: block.blockId });
      if (thickness2 === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Doublet.thickness2 is required.', blockId: block.blockId });

      if (typeof material1 !== 'string' || material1.trim() === '') {
        issues.push({ severity: 'fatal', phase: 'validate', message: 'Doublet.material1 (glass name) is required.', blockId: block.blockId });
      } else if (__isNumericMaterialName(material1)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Doublet.material1 is numeric (${material1}). Treated as synthetic glass; dispersion may be inaccurate.`, blockId: block.blockId });
      } else if (!isKnownGlassNameOnly(material1)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name (allowed for imported/legacy designs): ${material1}`, blockId: block.blockId });
      }
      if (typeof material2 !== 'string' || material2.trim() === '') {
        issues.push({ severity: 'fatal', phase: 'validate', message: 'Doublet.material2 (glass name) is required.', blockId: block.blockId });
      } else if (__isNumericMaterialName(material2)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Doublet.material2 is numeric (${material2}). Treated as synthetic glass; dispersion may be inaccurate.`, blockId: block.blockId });
      } else if (!isKnownGlassNameOnly(material2)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name (allowed for imported/legacy designs): ${material2}`, blockId: block.blockId });
      }

      for (let si = 1; si <= 3; si++) {
        const st = normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, `surf${si}SurfType`));
        if (st && !ALLOWED_SURF_TYPES.has(st)) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `Doublet.surf${si}SurfType must be one of: Spherical, Aspheric even, Aspheric odd. Got: ${st}`, blockId: block.blockId });
        }
      }
    }

    if (blockType === 'Triplet') {
      const radius1 = getParamOrVarValue(parameters, variables, 'radius1');
      const radius2 = getParamOrVarValue(parameters, variables, 'radius2');
      const radius3 = getParamOrVarValue(parameters, variables, 'radius3');
      const radius4 = getParamOrVarValue(parameters, variables, 'radius4');
      const thickness1 = getParamOrVarValue(parameters, variables, 'thickness1');
      const thickness2 = getParamOrVarValue(parameters, variables, 'thickness2');
      const thickness3 = getParamOrVarValue(parameters, variables, 'thickness3');
      const material1 = getParamOrVarValue(parameters, variables, 'material1');
      const material2 = getParamOrVarValue(parameters, variables, 'material2');
      const material3 = getParamOrVarValue(parameters, variables, 'material3');

      if (radius1 === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Triplet.radius1 is required.', blockId: block.blockId });
      if (radius2 === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Triplet.radius2 is required.', blockId: block.blockId });
      if (radius3 === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Triplet.radius3 is required.', blockId: block.blockId });
      if (radius4 === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Triplet.radius4 is required.', blockId: block.blockId });
      if (thickness1 === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Triplet.thickness1 is required.', blockId: block.blockId });
      if (thickness2 === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Triplet.thickness2 is required.', blockId: block.blockId });
      if (thickness3 === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'Triplet.thickness3 is required.', blockId: block.blockId });

      if (typeof material1 !== 'string' || material1.trim() === '') {
        issues.push({ severity: 'fatal', phase: 'validate', message: 'Triplet.material1 (glass name) is required.', blockId: block.blockId });
      } else if (__isNumericMaterialName(material1)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Triplet.material1 is numeric (${material1}). Treated as synthetic glass; dispersion may be inaccurate.`, blockId: block.blockId });
      } else if (!isKnownGlassNameOnly(material1)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name (allowed for imported/legacy designs): ${material1}`, blockId: block.blockId });
      }
      if (typeof material2 !== 'string' || material2.trim() === '') {
        issues.push({ severity: 'fatal', phase: 'validate', message: 'Triplet.material2 (glass name) is required.', blockId: block.blockId });
      } else if (__isNumericMaterialName(material2)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Triplet.material2 is numeric (${material2}). Treated as synthetic glass; dispersion may be inaccurate.`, blockId: block.blockId });
      } else if (!isKnownGlassNameOnly(material2)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name (allowed for imported/legacy designs): ${material2}`, blockId: block.blockId });
      }
      if (typeof material3 !== 'string' || material3.trim() === '') {
        issues.push({ severity: 'fatal', phase: 'validate', message: 'Triplet.material3 (glass name) is required.', blockId: block.blockId });
      } else if (__isNumericMaterialName(material3)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Triplet.material3 is numeric (${material3}). Treated as synthetic glass; dispersion may be inaccurate.`, blockId: block.blockId });
      } else if (!isKnownGlassNameOnly(material3)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name (allowed for imported/legacy designs): ${material3}`, blockId: block.blockId });
      }

      for (let si = 1; si <= 4; si++) {
        const st = normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, `surf${si}SurfType`));
        if (st && !ALLOWED_SURF_TYPES.has(st)) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `Triplet.surf${si}SurfType must be one of: Spherical, Aspheric even, Aspheric odd. Got: ${st}`, blockId: block.blockId });
        }
      }
    }

    if (blockType === 'Gap' || blockType === 'AirGap') {
      const thickness = getParamOrVarValue(parameters, variables, 'thickness');
      if (thickness === undefined) {
        issues.push({ severity: 'fatal', phase: 'validate', message: 'Gap.thickness is required.', blockId: block.blockId });
      }

      // Optional: thicknessMode (manual/IMD/BFL) for pre-image gap convenience.
      // When enabled by UI, it writes the computed numeric thickness back into parameters.thickness.
      try {
        const tmRaw = getParamOrVarValue(parameters, variables, 'thicknessMode');
        const tm = String(tmRaw ?? '').trim().replace(/\s+/g, '').toUpperCase();
        if (tm !== '' && tm !== 'IMD' && tm !== 'BFL') {
          issues.push({ severity: 'warning', phase: 'validate', message: `Gap.thicknessMode supports only 'IMD' or 'BFL' (got: ${String(tmRaw)}); ignoring.`, blockId: block.blockId });
        }
      } catch (_) {}

      // Optional: Gap.material (AIR or a glass name). Default is AIR (n≈1).
      const materialRaw = getParamOrVarValue(parameters, variables, 'material');
      const material = String(materialRaw ?? '').trim();
      const matKey = material.replace(/\s+/g, '').toUpperCase();
      if (material !== '' && matKey !== 'AIR') {
        if (__isNumericMaterialName(material)) {
          issues.push({ severity: 'warning', phase: 'validate', message: `Gap.material is numeric (${material}). Treated as synthetic glass; dispersion may be inaccurate.`, blockId: block.blockId });
        } else if (!isKnownGlassNameOnly(material)) {
          issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name (allowed for imported/legacy designs): ${material}`, blockId: block.blockId });
        }
      }

      // Warn if optimize mode is not V
      if (isPlainObject(variables) && isPlainObject(variables.thickness) && isPlainObject(variables.thickness.optimize)) {
        const mode = variables.thickness.optimize.mode;
        if (mode !== undefined && mode !== null && mode !== '' && mode !== 'V') {
          issues.push({
            severity: 'warning',
            phase: 'validate',
            message: `Gap.variables.thickness.optimize.mode=${String(mode)} is not supported yet; treating as fixed.`,
            blockId: block.blockId
          });
        }
      }
    }

    if (blockType === 'CoordTrans') {
      // CoordTrans is a non-refractive row that applies a coordinate transform.
      // Mapping to expanded Optical System (ray-tracing.md):
      // semidia->decenterX, material->decenterY, thickness->decenterZ,
      // rindex->tiltX, abbe->tiltY, conic->tiltZ, coef1->order (0/1)

      const decenterX = getParamOrVarValue(parameters, variables, 'decenterX');
      const decenterY = getParamOrVarValue(parameters, variables, 'decenterY');
      const decenterZ = getParamOrVarValue(parameters, variables, 'decenterZ');
      const tiltX = getParamOrVarValue(parameters, variables, 'tiltX');
      const tiltY = getParamOrVarValue(parameters, variables, 'tiltY');
      const tiltZ = getParamOrVarValue(parameters, variables, 'tiltZ');
      const orderRaw = getParamOrVarValue(parameters, variables, 'order');

      // All numeric fields are optional; blank means 0.
      // When provided, must be parseable as a number.
      const numericKeys = [
        ['decenterX', decenterX],
        ['decenterY', decenterY],
        ['decenterZ', decenterZ],
        ['tiltX', tiltX],
        ['tiltY', tiltY],
        ['tiltZ', tiltZ]
      ];
      for (const [k, v] of numericKeys) {
        const s = String(v ?? '').trim();
        if (s === '') continue;
        if (!isNumericString(s) && !(typeof v === 'number' && Number.isFinite(v))) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `CoordTrans.${k} must be numeric when provided (got: ${String(v)})`, blockId: block.blockId });
        }
      }

      try {
        const s = String(orderRaw ?? '').trim();
        if (s !== '') {
          const n = (typeof orderRaw === 'number') ? orderRaw : (isNumericString(s) ? Number(s) : NaN);
          if (!Number.isFinite(n) || (n !== 0 && n !== 1)) {
            issues.push({ severity: 'fatal', phase: 'validate', message: `CoordTrans.order must be 0 or 1 when provided (got: ${String(orderRaw)})`, blockId: block.blockId });
          }
        }
      } catch (_) {}
    }

    if (blockType === 'Stop') {
      // Stop is a definition point: semiDiameter may be omitted (defaulted during expand).
      // Source of truth is parameters.semiDiameter (normalize step may migrate legacy variables into parameters).
      const semiDiameter = parameters?.semiDiameter;
      if (semiDiameter !== undefined) {
        const n = typeof semiDiameter === 'number' ? semiDiameter : (isNumericString(String(semiDiameter)) ? Number(semiDiameter) : NaN);
        if (!Number.isFinite(n) || n <= 0) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `Stop.parameters.semiDiameter must be a positive number (got: ${String(semiDiameter)})`, blockId: block.blockId });
        }
      }
    }

    if (blockType === 'ImagePlane') {
      // Optional parameters supported:
      // - semidia: numeric (image semi diameter)
      // - optimizeSemiDia: 'A' to auto-update semidia by chief ray tracing (UI-triggered)
      const semidiaRaw = parameters?.semidia;
      if (semidiaRaw !== undefined && semidiaRaw !== null && String(semidiaRaw).trim() !== '') {
        const n = (typeof semidiaRaw === 'number') ? semidiaRaw : (isNumericString(String(semidiaRaw)) ? Number(semidiaRaw) : NaN);
        if (!Number.isFinite(n) || n <= 0) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `ImagePlane.parameters.semidia must be a positive number when provided (got: ${String(semidiaRaw)})`, blockId: block.blockId });
        }
      }

      const optRaw = parameters?.optimizeSemiDia;
      if (optRaw !== undefined && optRaw !== null && String(optRaw).trim() !== '') {
        const s = String(optRaw).trim();
        if (s !== 'A' && s !== 'a') {
          issues.push({ severity: 'warning', phase: 'validate', message: `ImagePlane.parameters.optimizeSemiDia supports only 'A' (got: ${s}); ignoring.`, blockId: block.blockId });
        }
      }

      if (isPlainObject(variables) && Object.keys(variables).length > 0) {
        issues.push({
          severity: 'warning',
          phase: 'validate',
          message: 'ImagePlane.variables is ignored (Image plane is not a design variable).',
          blockId: block.blockId
        });
      }
    }
  }

  // Ordering rules (MVP): Gap attaches spacing/medium to the previous physical surface.
  // Gap is stored as a block but expands onto the previous surface row's thickness/material.
  // This includes Stop rows (Stop is still a surface in the expanded table).

  return issues;
}

function createDefaultObjectRow() {
  return {
    id: 0,
    'object type': 'Object',
    surfType: 'Spherical',
    comment: '',
    radius: 'INF',
    optimizeR: '',
    thickness: 100,
    optimizeT: '',
    semidia: '',
    optimizeSemiDia: '',
    material: 'AIR',
    optimizeMaterial: '',
    rindex: '',
    optimizeRI: '',
    abbe: '',
    optimizeAbbe: '',
    conic: '',
    optimizeConic: '',
    coef1: '',
    optimizeCoef1: '',
    coef2: '',
    optimizeCoef2: '',
    coef3: '',
    optimizeCoef3: '',
    coef4: '',
    optimizeCoef4: '',
    coef5: '',
    optimizeCoef5: '',
    coef6: '',
    optimizeCoef6: '',
    coef7: '',
    optimizeCoef7: '',
    coef8: '',
    optimizeCoef8: '',
    coef9: '',
    optimizeCoef9: '',
    coef10: '',
    optimizeCoef10: ''
  };
}

function createDefaultImageRow(id, overrides = null) {
  const ov = (overrides && typeof overrides === 'object') ? overrides : null;
  return {
    id,
    'object type': 'Image',
    surfType: 'Spherical',
    comment: '',
    radius: 'INF',
    optimizeR: '',
    thickness: '',
    optimizeT: '',
    semidia: ov && Object.prototype.hasOwnProperty.call(ov, 'semidia') ? ov.semidia : '',
    optimizeSemiDia: ov && Object.prototype.hasOwnProperty.call(ov, 'optimizeSemiDia') ? ov.optimizeSemiDia : '',
    material: '',
    optimizeMaterial: '',
    rindex: '',
    optimizeRI: '',
    abbe: '',
    optimizeAbbe: '',
    conic: '',
    optimizeConic: '',
    coef1: '',
    optimizeCoef1: '',
    coef2: '',
    optimizeCoef2: '',
    coef3: '',
    optimizeCoef3: '',
    coef4: '',
    optimizeCoef4: '',
    coef5: '',
    optimizeCoef5: '',
    coef6: '',
    optimizeCoef6: '',
    coef7: '',
    optimizeCoef7: '',
    coef8: '',
    optimizeCoef8: '',
    coef9: '',
    optimizeCoef9: '',
    coef10: '',
    optimizeCoef10: ''
  };
}

function createBlankSurfaceRow(id, prevRow) {
  const semidia = normalizeSemidia(prevRow);
  return {
    id,
    'object type': '',
    surfType: 'Spherical',
    comment: '',
    radius: 'INF',
    optimizeR: '',
    thickness: 0,
    optimizeT: '',
    semidia,
    optimizeSemiDia: '',
    material: 'AIR',
    optimizeMaterial: '',
    rindex: '',
    optimizeRI: '',
    abbe: '',
    optimizeAbbe: '',
    conic: '',
    optimizeConic: '',
    coef1: '',
    optimizeCoef1: '',
    coef2: '',
    optimizeCoef2: '',
    coef3: '',
    optimizeCoef3: '',
    coef4: '',
    optimizeCoef4: '',
    coef5: '',
    optimizeCoef5: '',
    coef6: '',
    optimizeCoef6: '',
    coef7: '',
    optimizeCoef7: '',
    coef8: '',
    optimizeCoef8: '',
    coef9: '',
    optimizeCoef9: '',
    coef10: '',
    optimizeCoef10: ''
  };
}

function applyVFlag(row, fieldKey) {
  if (!row || typeof row !== 'object') return;
  row[fieldKey] = 'V';
}

/**
 * Expand blocks into an OpticalSystemTableData row array.
 * Output includes Object and Image rows.
 *
 * @param {any[]} blocks
 * @returns {{ rows: any[], issues: LoadIssue[] }}
 */
export function expandBlocksToOpticalSystemRows(blocks) {
  /** @type {LoadIssue[]} */
  const issues = [];

  if (!Array.isArray(blocks)) {
    issues.push({ severity: 'fatal', phase: 'expand', message: 'blocks must be an array.' });
    return { rows: [], issues };
  }

  const rows = [createDefaultObjectRow()];
  rows[0]._blockType = 'Object';
  rows[0]._blockId = null;

  const getLastRow = () => rows[rows.length - 1];

  const isStopRow = (r) => r && (r['object type'] === 'Stop' || r.object === 'Stop');

  const isCoordTransRow = (r) => {
    try {
      const st = String(r?.surfType ?? r?.['surf type'] ?? r?.type ?? '').trim().toLowerCase();
      return st === 'coord trans' || st === 'coordinate transform' || st === 'ct';
    } catch (_) {
      return false;
    }
  };

  // For semidia inheritance, skip Stop and Coord Break rows so their special fields
  // (Stop.semiDiameter / CoordTrans decenterX) do not "bleed" into following surfaces.
  const getLastNonStopRow = () => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!isStopRow(rows[i]) && !isCoordTransRow(rows[i])) return rows[i];
    }
    return rows[0];
  };

  // Gap blocks attach thickness/material to the previous surface row.
  // Coord Break rows reuse thickness/material for decenter parameters, so we store gap spacing separately.
  const getLastNonCoordTransRow = () => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!isCoordTransRow(rows[i])) return rows[i];
    }
    return rows[0];
  };

  let sawImagePlane = false;
  let imagePlaneBlockId = null;
  let imagePlaneOverrides = null;
  let currentZSign = 1;

  const applySignedThickness = (value) => {
    if (value === 'INF') return 'INF';
    if (typeof value === 'number' && Number.isFinite(value)) return value * currentZSign;
    return value;
  };

  for (const block of blocks) {
    const blockId = isPlainObject(block) ? block.blockId : undefined;

    if (!isPlainObject(block)) {
      issues.push({ severity: 'fatal', phase: 'expand', message: 'Block must be an object.', blockId });
      continue;
    }

    const type = block.blockType;
    const params = block.parameters;
    const vars = isPlainObject(block.variables) ? block.variables : null;
    const aperture = isPlainObject(block.aperture) ? block.aperture : null;

    if (type === 'ObjectPlane') {
      // ObjectPlane is a non-surface block that defines the distance from the object plane
      // to the first surface (stored as Object row thickness).
      try {
        const modeRaw = getParamOrVarValue(params, vars, 'objectDistanceMode');
        const mode = String(modeRaw ?? '').trim().replace(/\s+/g, '').toUpperCase();
        if (mode === 'INF' || mode === 'INFINITY') {
          rows[0].thickness = 'INF';
        } else {
          const distRaw = getParamOrVarValue(params, vars, 'objectDistance');
          rows[0].thickness = normalizeThicknessToRowValue(distRaw);
        }
      } catch (_) {
        // ignore
      }
      continue;
    }

    if (sawImagePlane) {
      issues.push({
        severity: 'warning',
        phase: 'expand',
        message: 'Blocks after ImagePlane are ignored.',
        blockId
      });
      continue;
    }

    if (type === 'ImagePlane') {
      sawImagePlane = true;
      imagePlaneBlockId = blockId || null;

      // Optional ImagePlane row overrides (applied to the appended Image row).
      try {
        const p = isPlainObject(params) ? params : {};
        const ov = {};

        if (Object.prototype.hasOwnProperty.call(p, 'semidia')) {
          const s = String(p.semidia ?? '').trim();
          if (s !== '') ov.semidia = p.semidia;
        }
        if (Object.prototype.hasOwnProperty.call(p, 'optimizeSemiDia')) {
          const s = String(p.optimizeSemiDia ?? '').trim();
          if (s !== '') ov.optimizeSemiDia = p.optimizeSemiDia;
        }

        imagePlaneOverrides = Object.keys(ov).length > 0 ? ov : null;
      } catch (_) {
        imagePlaneOverrides = null;
      }
      continue;
    }

    const applyDerivedGlassDisplay = (row) => {
      try {
        if (!row || typeof row !== 'object') return;
        const glassName = String(row.material ?? '').trim();
        if (!glassName || glassName.toUpperCase() === 'AIR') return;
        const glass = getGlassDataWithSellmeier(glassName);
        if (glass && typeof glass.nd === 'number' && Number.isFinite(glass.nd)) {
          row.rindex = String(glass.nd);
        }
        if (glass && typeof glass.vd === 'number' && Number.isFinite(glass.vd)) {
          row.abbe = String(glass.vd);
        }
      } catch (_) {
        // ignore
      }
    };

    const applyAsphereFieldsFromParams = (row, surfTypeRaw, conicRaw, coefsRaw) => {
      const stNorm = normalizeSurfTypeValue(surfTypeRaw);
      const st = (stNorm && ALLOWED_SURF_TYPES.has(stNorm)) ? stNorm : '';
      row.surfType = st || (blockAsphereLooksNonZero({ surfType: stNorm, conic: conicRaw, coefs: coefsRaw }) ? 'Aspheric even' : 'Spherical');
      if (row.surfType === 'Spherical') {
        row.conic = '';
        for (let i = 0; i < 10; i++) row[`coef${i + 1}`] = '';
      } else {
        row.conic = normalizeOptionalNumberToRowValue(conicRaw);
        for (let i = 0; i < 10; i++) row[`coef${i + 1}`] = normalizeOptionalNumberToRowValue(coefsRaw?.[i]);
      }
    };

    const normalizeApertureShape = (value) => {
      const s = String(value ?? '').trim();
      if (!s) return 'Circular';
      const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
      if (key === 'circle' || key === 'circular') return 'Circular';
      if (key === 'square' || key === 'sq') return 'Square';
      if (key === 'rect' || key === 'rectangle' || key === 'rectangular') return 'Rectangular';
      return s;
    };

    if (type === 'Lens' || type === 'PositiveLens') {
      const front = createBlankSurfaceRow(rows.length, getLastNonStopRow());
      const back = createBlankSurfaceRow(rows.length + 1, front);

      front._blockType = 'Lens';
      front._blockId = blockId || null;
      back._blockType = 'Lens';
      back._blockId = blockId || null;

      // Stable role tags for Surface -> Block reverse mapping (Apply to Design Intent)
      front._surfaceRole = 'front';
      back._surfaceRole = 'back';

      // Persisted aperture (semidia) stored in Design Intent.
      // If aperture is not defined, clear inherited semidia to match Design Intent.
      try {
        const vFront = aperture ? aperture.front : null;
        const vBack = aperture ? aperture.back : null;
        if (vFront !== null && vFront !== undefined && String(vFront).trim() !== '') {
          front.semidia = vFront;
        } else if (!aperture || !Object.prototype.hasOwnProperty.call(aperture, 'front')) {
          front.semidia = '';
        }
        if (vBack !== null && vBack !== undefined && String(vBack).trim() !== '') {
          back.semidia = vBack;
        } else if (!aperture || !Object.prototype.hasOwnProperty.call(aperture, 'back')) {
          back.semidia = '';
        }
      } catch (_) {}

      const frontRadius = getParamOrVarValue(params, vars, 'frontRadius');
      const backRadius = getParamOrVarValue(params, vars, 'backRadius');
      const centerThickness = getParamOrVarValue(params, vars, 'centerThickness');
      const material = getParamOrVarValue(params, vars, 'material');

      // Optional asphere (canonical, per-surface)
      const frontSurfTypeRaw = getParamOrVarValue(params, vars, 'frontSurfType');
      const backSurfTypeRaw = getParamOrVarValue(params, vars, 'backSurfType');
      const frontConicRaw = getParamOrVarValue(params, vars, 'frontConic');
      const backConicRaw = getParamOrVarValue(params, vars, 'backConic');
      const frontCoefsRaw = Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `frontCoef${i + 1}`));
      const backCoefsRaw = Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `backCoef${i + 1}`));

      front.radius = normalizeRadiusToRowValue(frontRadius);
      front.thickness = applySignedThickness(normalizeThicknessToRowValue(centerThickness));
      front.material = String(material ?? '').trim();

      applyDerivedGlassDisplay(front);

      applyAsphereFieldsFromParams(front, frontSurfTypeRaw, frontConicRaw, frontCoefsRaw);

      back.radius = normalizeRadiusToRowValue(backRadius);
      back.thickness = 0; // post spacing is handled by AirGap block only
      back.material = 'AIR';

      applyAsphereFieldsFromParams(back, backSurfTypeRaw, backConicRaw, backCoefsRaw);

      // Only set optimize flags for variables explicitly present.
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'frontRadius') && shouldMarkV(vars.frontRadius)) {
        applyVFlag(front, 'optimizeR');
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'centerThickness') && shouldMarkV(vars.centerThickness)) {
        applyVFlag(front, 'optimizeT');
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'material') && shouldMarkV(vars.material)) {
        applyVFlag(front, 'optimizeMaterial');
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'backRadius') && shouldMarkV(vars.backRadius)) {
        applyVFlag(back, 'optimizeR');
      }

      rows.push(front, back);
      continue;
    }

    if (type === 'CoordTrans') {
      const cb = createBlankSurfaceRow(rows.length, getLastNonStopRow());

      cb._blockType = 'CoordTrans';
      cb._blockId = blockId || null;
      cb._surfaceRole = 'ct';

      cb.surfType = 'Coord Break';
      cb.radius = 'INF';

      const decenterX = getParamOrVarValue(params, vars, 'decenterX');
      const decenterY = getParamOrVarValue(params, vars, 'decenterY');
      const decenterZ = getParamOrVarValue(params, vars, 'decenterZ');
      const tiltX = getParamOrVarValue(params, vars, 'tiltX');
      const tiltY = getParamOrVarValue(params, vars, 'tiltY');
      const tiltZ = getParamOrVarValue(params, vars, 'tiltZ');
      const order = getParamOrVarValue(params, vars, 'order');

      // Also store explicit CoordTrans params to avoid collisions with reused table fields.
      // (Rendering / ray-tracing prefer these when present.)
      cb.decenterX = (typeof decenterX === 'number') ? decenterX : (isNumericString(String(decenterX ?? '').trim()) ? Number(decenterX) : 0);
      cb.decenterY = (typeof decenterY === 'number') ? decenterY : (isNumericString(String(decenterY ?? '').trim()) ? Number(decenterY) : 0);
      cb.decenterZ = (typeof decenterZ === 'number') ? decenterZ : (isNumericString(String(decenterZ ?? '').trim()) ? Number(decenterZ) : 0);
      cb.tiltX = (typeof tiltX === 'number') ? tiltX : (isNumericString(String(tiltX ?? '').trim()) ? Number(tiltX) : 0);
      cb.tiltY = (typeof tiltY === 'number') ? tiltY : (isNumericString(String(tiltY ?? '').trim()) ? Number(tiltY) : 0);
      cb.tiltZ = (typeof tiltZ === 'number') ? tiltZ : (isNumericString(String(tiltZ ?? '').trim()) ? Number(tiltZ) : 0);
      cb.order = (() => {
        const s = String(order ?? '').trim();
        if (s === '') return 1;
        const n = (typeof order === 'number') ? order : (isNumericString(s) ? Number(s) : NaN);
        return (n === 0 || n === 1) ? n : 1;
      })();

      // Coord Break field reuse (see specification/ray-tracing.md)
      cb.semidia = normalizeOptionalNumberToRowValue(decenterX);
      cb.material = normalizeOptionalNumberToRowValue(decenterY);
      cb.thickness = (() => {
        const s = String(decenterZ ?? '').trim();
        if (s === '') return 0;
        if (typeof decenterZ === 'number' && Number.isFinite(decenterZ)) return decenterZ;
        if (isNumericString(s)) return Number(s);
        return 0;
      })();
      cb.rindex = normalizeOptionalNumberToRowValue(tiltX);
      cb.abbe = normalizeOptionalNumberToRowValue(tiltY);
      cb.conic = normalizeOptionalNumberToRowValue(tiltZ);
      cb.coef1 = normalizeOptionalNumberToRowValue(order);

      // IMPORTANT: CB rows reuse semidia for decenterX, so their visible semidia column
      // MUST NOT vignette subsequent rays. Propagate the last non-CB/non-Stop semidia
      // so rendering/ray-tracing can use it for clearance checks after the CB.
      // Store it in a dedicated field so it doesn't overwrite decenterX.
      try {
        const prev = getLastNonCoordTransRow();
        if (prev && prev.semidia !== undefined && prev.semidia !== null && String(prev.semidia).trim() !== '') {
          cb.__cooptActualSemidia = prev.semidia;
        }
      } catch (_) {}

      rows.push(cb);
      continue;
    }

    if (type === 'Doublet') {
      const s1 = createBlankSurfaceRow(rows.length, getLastNonStopRow());
      const s2 = createBlankSurfaceRow(rows.length + 1, s1);
      const s3 = createBlankSurfaceRow(rows.length + 2, s2);

      for (const r of [s1, s2, s3]) {
        r._blockType = 'Doublet';
        r._blockId = blockId || null;
      }
      s1._surfaceRole = 's1';
      s2._surfaceRole = 's2';
      s3._surfaceRole = 's3';

      // Persisted aperture (semidia) stored in Design Intent.
      // If aperture is not defined, clear inherited semidia to match Design Intent.
      try {
        const v1 = aperture ? aperture.s1 : null;
        const v2 = aperture ? aperture.s2 : null;
        const v3 = aperture ? aperture.s3 : null;
        if (v1 !== null && v1 !== undefined && String(v1).trim() !== '') {
          s1.semidia = v1;
        } else if (!aperture || !Object.prototype.hasOwnProperty.call(aperture, 's1')) {
          s1.semidia = '';
        }
        if (v2 !== null && v2 !== undefined && String(v2).trim() !== '') {
          s2.semidia = v2;
        } else if (!aperture || !Object.prototype.hasOwnProperty.call(aperture, 's2')) {
          s2.semidia = '';
        }
        if (v3 !== null && v3 !== undefined && String(v3).trim() !== '') {
          s3.semidia = v3;
        } else if (!aperture || !Object.prototype.hasOwnProperty.call(aperture, 's3')) {
          s3.semidia = '';
        }
      } catch (_) {}

      const radius1 = getParamOrVarValue(params, vars, 'radius1');
      const radius2 = getParamOrVarValue(params, vars, 'radius2');
      const radius3 = getParamOrVarValue(params, vars, 'radius3');
      const thickness1 = getParamOrVarValue(params, vars, 'thickness1');
      const thickness2 = getParamOrVarValue(params, vars, 'thickness2');
      const material1 = getParamOrVarValue(params, vars, 'material1');
      const material2 = getParamOrVarValue(params, vars, 'material2');

      s1.radius = normalizeRadiusToRowValue(radius1);
      s1.thickness = applySignedThickness(normalizeThicknessToRowValue(thickness1));
      s1.material = String(material1 ?? '').trim();
      applyDerivedGlassDisplay(s1);

      s2.radius = normalizeRadiusToRowValue(radius2);
      s2.thickness = applySignedThickness(normalizeThicknessToRowValue(thickness2));
      s2.material = String(material2 ?? '').trim();
      applyDerivedGlassDisplay(s2);

      s3.radius = normalizeRadiusToRowValue(radius3);
      s3.thickness = 0; // post spacing handled by AirGap only
      s3.material = 'AIR';

      const s1SurfType = getParamOrVarValue(params, vars, 'surf1SurfType');
      const s2SurfType = getParamOrVarValue(params, vars, 'surf2SurfType');
      const s3SurfType = getParamOrVarValue(params, vars, 'surf3SurfType');
      const s1Conic = getParamOrVarValue(params, vars, 'surf1Conic');
      const s2Conic = getParamOrVarValue(params, vars, 'surf2Conic');
      const s3Conic = getParamOrVarValue(params, vars, 'surf3Conic');
      const s1Coefs = Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `surf1Coef${i + 1}`));
      const s2Coefs = Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `surf2Coef${i + 1}`));
      const s3Coefs = Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `surf3Coef${i + 1}`));

      applyAsphereFieldsFromParams(s1, s1SurfType, s1Conic, s1Coefs);
      applyAsphereFieldsFromParams(s2, s2SurfType, s2Conic, s2Coefs);
      applyAsphereFieldsFromParams(s3, s3SurfType, s3Conic, s3Coefs);

      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius1') && shouldMarkV(vars.radius1)) applyVFlag(s1, 'optimizeR');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness1') && shouldMarkV(vars.thickness1)) applyVFlag(s1, 'optimizeT');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'material1') && shouldMarkV(vars.material1)) applyVFlag(s1, 'optimizeMaterial');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius2') && shouldMarkV(vars.radius2)) applyVFlag(s2, 'optimizeR');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness2') && shouldMarkV(vars.thickness2)) applyVFlag(s2, 'optimizeT');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'material2') && shouldMarkV(vars.material2)) applyVFlag(s2, 'optimizeMaterial');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius3') && shouldMarkV(vars.radius3)) applyVFlag(s3, 'optimizeR');

      rows.push(s1, s2, s3);
      continue;
    }

    if (type === 'Triplet') {
      const s1 = createBlankSurfaceRow(rows.length, getLastNonStopRow());
      const s2 = createBlankSurfaceRow(rows.length + 1, s1);
      const s3 = createBlankSurfaceRow(rows.length + 2, s2);
      const s4 = createBlankSurfaceRow(rows.length + 3, s3);

      for (const r of [s1, s2, s3, s4]) {
        r._blockType = 'Triplet';
        r._blockId = blockId || null;
      }
      s1._surfaceRole = 's1';
      s2._surfaceRole = 's2';
      s3._surfaceRole = 's3';
      s4._surfaceRole = 's4';

      // Persisted aperture (semidia) stored in Design Intent.
      // If aperture is not defined, clear inherited semidia to match Design Intent.
      try {
        const v1 = aperture ? aperture.s1 : null;
        const v2 = aperture ? aperture.s2 : null;
        const v3 = aperture ? aperture.s3 : null;
        const v4 = aperture ? aperture.s4 : null;
        if (v1 !== null && v1 !== undefined && String(v1).trim() !== '') {
          s1.semidia = v1;
        } else if (!aperture || !Object.prototype.hasOwnProperty.call(aperture, 's1')) {
          s1.semidia = '';
        }
        if (v2 !== null && v2 !== undefined && String(v2).trim() !== '') {
          s2.semidia = v2;
        } else if (!aperture || !Object.prototype.hasOwnProperty.call(aperture, 's2')) {
          s2.semidia = '';
        }
        if (v3 !== null && v3 !== undefined && String(v3).trim() !== '') {
          s3.semidia = v3;
        } else if (!aperture || !Object.prototype.hasOwnProperty.call(aperture, 's3')) {
          s3.semidia = '';
        }
        if (v4 !== null && v4 !== undefined && String(v4).trim() !== '') {
          s4.semidia = v4;
        } else if (!aperture || !Object.prototype.hasOwnProperty.call(aperture, 's4')) {
          s4.semidia = '';
        }
      } catch (_) {}

      const radius1 = getParamOrVarValue(params, vars, 'radius1');
      const radius2 = getParamOrVarValue(params, vars, 'radius2');
      const radius3 = getParamOrVarValue(params, vars, 'radius3');
      const radius4 = getParamOrVarValue(params, vars, 'radius4');
      const thickness1 = getParamOrVarValue(params, vars, 'thickness1');
      const thickness2 = getParamOrVarValue(params, vars, 'thickness2');
      const thickness3 = getParamOrVarValue(params, vars, 'thickness3');
      const material1 = getParamOrVarValue(params, vars, 'material1');
      const material2 = getParamOrVarValue(params, vars, 'material2');
      const material3 = getParamOrVarValue(params, vars, 'material3');

      s1.radius = normalizeRadiusToRowValue(radius1);
      s1.thickness = applySignedThickness(normalizeThicknessToRowValue(thickness1));
      s1.material = String(material1 ?? '').trim();
      applyDerivedGlassDisplay(s1);

      s2.radius = normalizeRadiusToRowValue(radius2);
      s2.thickness = applySignedThickness(normalizeThicknessToRowValue(thickness2));
      s2.material = String(material2 ?? '').trim();
      applyDerivedGlassDisplay(s2);

      s3.radius = normalizeRadiusToRowValue(radius3);
      s3.thickness = applySignedThickness(normalizeThicknessToRowValue(thickness3));
      s3.material = String(material3 ?? '').trim();
      applyDerivedGlassDisplay(s3);

      s4.radius = normalizeRadiusToRowValue(radius4);
      s4.thickness = 0; // post spacing handled by AirGap only
      s4.material = 'AIR';

      const s1SurfType = getParamOrVarValue(params, vars, 'surf1SurfType');
      const s2SurfType = getParamOrVarValue(params, vars, 'surf2SurfType');
      const s3SurfType = getParamOrVarValue(params, vars, 'surf3SurfType');
      const s4SurfType = getParamOrVarValue(params, vars, 'surf4SurfType');
      const s1Conic = getParamOrVarValue(params, vars, 'surf1Conic');
      const s2Conic = getParamOrVarValue(params, vars, 'surf2Conic');
      const s3Conic = getParamOrVarValue(params, vars, 'surf3Conic');
      const s4Conic = getParamOrVarValue(params, vars, 'surf4Conic');
      const s1Coefs = Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `surf1Coef${i + 1}`));
      const s2Coefs = Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `surf2Coef${i + 1}`));
      const s3Coefs = Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `surf3Coef${i + 1}`));
      const s4Coefs = Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `surf4Coef${i + 1}`));

      applyAsphereFieldsFromParams(s1, s1SurfType, s1Conic, s1Coefs);
      applyAsphereFieldsFromParams(s2, s2SurfType, s2Conic, s2Coefs);
      applyAsphereFieldsFromParams(s3, s3SurfType, s3Conic, s3Coefs);
      applyAsphereFieldsFromParams(s4, s4SurfType, s4Conic, s4Coefs);

      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius1') && shouldMarkV(vars.radius1)) applyVFlag(s1, 'optimizeR');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness1') && shouldMarkV(vars.thickness1)) applyVFlag(s1, 'optimizeT');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'material1') && shouldMarkV(vars.material1)) applyVFlag(s1, 'optimizeMaterial');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius2') && shouldMarkV(vars.radius2)) applyVFlag(s2, 'optimizeR');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness2') && shouldMarkV(vars.thickness2)) applyVFlag(s2, 'optimizeT');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'material2') && shouldMarkV(vars.material2)) applyVFlag(s2, 'optimizeMaterial');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius3') && shouldMarkV(vars.radius3)) applyVFlag(s3, 'optimizeR');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness3') && shouldMarkV(vars.thickness3)) applyVFlag(s3, 'optimizeT');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'material3') && shouldMarkV(vars.material3)) applyVFlag(s3, 'optimizeMaterial');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius4') && shouldMarkV(vars.radius4)) applyVFlag(s4, 'optimizeR');

      rows.push(s1, s2, s3, s4);
      continue;
    }

    if (type === 'Mirror') {
      const mirror = createBlankSurfaceRow(rows.length, getLastNonStopRow());
      mirror._blockType = 'Mirror';
      mirror._blockId = blockId || null;
      mirror._surfaceRole = 'mirror';

      const radius = getParamOrVarValue(params, vars, 'radius');
      const thickness = getParamOrVarValue(params, vars, 'thickness');
      const matRaw = getParamOrVarValue(params, vars, 'material');

      mirror.radius = normalizeRadiusToRowValue(radius);

      const surfTypeRaw = getParamOrVarValue(params, vars, 'surfType');
      const conicRaw = getParamOrVarValue(params, vars, 'conic');
      const coefsRaw = Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `coef${i + 1}`));
      applyAsphereFieldsFromParams(mirror, surfTypeRaw, conicRaw, coefsRaw);

      const mat = String(matRaw ?? '').trim();
      mirror.material = mat ? mat : 'MIRROR';
      if (mirror.material.toUpperCase() !== 'MIRROR') mirror.material = 'MIRROR';
      applyDerivedGlassDisplay(mirror);

      const shape = normalizeApertureShape(getParamOrVarValue(params, vars, 'apertureShape'));
      const semidiaRaw = getParamOrVarValue(params, vars, 'semidia');
      const widthRaw = getParamOrVarValue(params, vars, 'apertureWidth');
      const heightRaw = getParamOrVarValue(params, vars, 'apertureHeight');
      const widthVal = Number(String(widthRaw ?? '').trim());
      const heightVal = Number(String(heightRaw ?? '').trim());

      mirror._apertureShape = shape;
      if (shape === 'Circular') {
        if (semidiaRaw !== null && semidiaRaw !== undefined && String(semidiaRaw).trim() !== '') {
          mirror.semidia = semidiaRaw;
        } else {
          mirror.semidia = '';
        }
      } else {
        const w = Number.isFinite(widthVal) && widthVal > 0 ? widthVal : NaN;
        const h = Number.isFinite(heightVal) && heightVal > 0 ? heightVal : NaN;
        const side = (shape === 'Square') ? (Number.isFinite(w) ? w : h) : NaN;
        const finalW = (shape === 'Square') ? side : w;
        const finalH = (shape === 'Square') ? side : h;
        if (Number.isFinite(finalW)) mirror._apertureWidth = finalW;
        if (Number.isFinite(finalH)) mirror._apertureHeight = finalH;
        const maxDim = Math.max(Number.isFinite(finalW) ? finalW : 0, Number.isFinite(finalH) ? finalH : 0);
        mirror.semidia = (maxDim > 0) ? String(maxDim / 2) : '';
      }

      // Mirror flips propagation direction for subsequent thickness values.
      currentZSign *= -1;
      mirror.thickness = applySignedThickness(normalizeThicknessToRowValue(thickness));

      rows.push(mirror);
      continue;
    }

    if (type === 'Gap' || type === 'AirGap') {
      if (rows.length <= 1) {
        issues.push({
          severity: 'fatal',
          phase: 'expand',
          message: 'Gap cannot appear before any surface (no previous surface to attach thickness/material to).',
          blockId,
          surfaceIndex: 0
        });
        continue;
      }

      let prev = getLastRow();
      // Never touch Image surface auto fields (Image row is appended later; this is a safety check).
      if (prev && (prev['object type'] === 'Image' || prev.object === 'Image')) {
        issues.push({
          severity: 'fatal',
          phase: 'expand',
          message: 'Gap cannot modify the Image surface.',
          blockId,
          surfaceIndex: typeof prev.id === 'number' ? prev.id : undefined
        });
        continue;
      }

      if (prev && (prev['object type'] === 'Object' || prev.object === 'Object')) {
        issues.push({
          severity: 'fatal',
          phase: 'expand',
          message: 'Gap cannot attach to Object surface (place a Lens/Stop first).',
          blockId,
          surfaceIndex: typeof prev.id === 'number' ? prev.id : undefined
        });
        continue;
      }

      // If multiple Gap blocks are consecutive, each must create its own spacing.
      // The legacy model stores spacing on the previous surface, so we insert a
      // blank air surface to attach the next gap without overwriting the prior one.
      if (prev && prev.__cooptGapApplied) {
        const blank = createBlankSurfaceRow(rows.length, prev);
        blank._blockType = 'Gap';
        blank._blockId = blockId || null;
        rows.push(blank);
        prev = blank;
      }

      const thickness = getParamOrVarValue(params, vars, 'thickness');
      const signedThickness = applySignedThickness(normalizeThicknessToRowValue(thickness));

      const matRaw = getParamOrVarValue(params, vars, 'material');
      const mat = String(matRaw ?? '').trim();
      const matKey = mat.replace(/\s+/g, '').toUpperCase();
      const gapMaterial = (mat === '' || matKey === 'AIR') ? 'AIR' : mat;

      if (prev && isCoordTransRow(prev)) {
        // Coord Break rows reuse thickness/material for decenter parameters;
        // store gap spacing separately to avoid clobbering CB fields.
        prev.__cooptGapThickness = signedThickness;
        prev.__cooptGapMaterial = gapMaterial;
        prev.__cooptGapApplied = true;
        if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness') && shouldMarkV(vars.thickness)) {
          prev.__cooptGapOptimizeT = 'V';
        }
        if (vars && Object.prototype.hasOwnProperty.call(vars, 'material') && shouldMarkV(vars.material)) {
          prev.__cooptGapOptimizeMaterial = 'V';
        }
      } else {
        prev.thickness = signedThickness;
        prev.material = gapMaterial;
        applyDerivedGlassDisplay(prev);
        prev.__cooptGapApplied = true;

        if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness') && shouldMarkV(vars.thickness)) {
          applyVFlag(prev, 'optimizeT');
        }
        if (vars && Object.prototype.hasOwnProperty.call(vars, 'material') && shouldMarkV(vars.material)) {
          applyVFlag(prev, 'optimizeMaterial');
        }
      }
      continue;
    }

    if (type === 'Stop') {
      const stop = createBlankSurfaceRow(rows.length, getLastNonStopRow());
      stop['object type'] = 'Stop';
      stop.radius = 'INF';
      stop.material = 'AIR';
      stop.thickness = 0;

      stop._blockType = 'Stop';
      stop._blockId = blockId || null;
      stop._surfaceRole = 'stop';

      const sdRaw = params?.semiDiameter;
      const sd = typeof sdRaw === 'number' ? sdRaw : (isNumericString(String(sdRaw)) ? Number(sdRaw) : NaN);
      const finalSd = Number.isFinite(sd) && sd > 0 ? sd : DEFAULT_STOP_SEMI_DIAMETER;
      stop.semidia = String(finalSd);

      rows.push(stop);
      continue;
    }

    issues.push({
      severity: 'fatal',
      phase: 'expand',
      message: `Unsupported blockType during expand: ${String(type)}`,
      blockId
    });
  }

  // Append Image row (do not force AUTO/A/INF here; honor ImagePlane overrides if provided).
  const imageRow = createDefaultImageRow(rows.length, imagePlaneOverrides);
  if (imagePlaneBlockId) {
    imageRow._blockType = 'ImagePlane';
    imageRow._blockId = imagePlaneBlockId;
  } else {
    imageRow._blockType = 'Image';
    imageRow._blockId = null;
  }
  rows.push(imageRow);

  // Fix ids to match final indices
  for (let i = 0; i < rows.length; i++) {
    rows[i].id = i;
    // Ensure object type at first/last (legacy table expects this)
    if (i === 0) rows[i]['object type'] = 'Object';
    if (i === rows.length - 1) rows[i]['object type'] = 'Image';
  }

  return { rows, issues };
}

/**
 * Best-effort conversion from legacy surface table rows into canonical Blocks.
 * This enables legacy (no-blocks) designs to enter the Blocks workflow.
 *
 * Supported (MVP):
 * - Stop rows -> Stop block (spacing after Stop is converted into a Gap block)
 * - A lens is detected as: a non-Stop row with material != AIR followed by a row with material == AIR
 *   (front row thickness becomes centerThickness; back row thickness becomes a Gap block)
 * - ImagePlane marker is always appended.
 *
 * @param {any[]} rows legacy OpticalSystemTableData-like rows
 * @returns {{ blocks: any[], issues: LoadIssue[] }}
 */
export function deriveBlocksFromLegacyOpticalSystemRows(rows) {
  /** @type {LoadIssue[]} */
  const issues = [];
  const blocks = [];

  if (!Array.isArray(rows) || rows.length < 2) {
    issues.push({ severity: 'fatal', phase: 'validate', message: 'opticalSystem rows must be a non-empty array.' });
    return { blocks, issues };
  }

  const legacyRows = rows.filter(r => !__isCoordTransRow(r));
  if (legacyRows.length !== rows.length) {
    issues.push({ severity: 'warning', phase: 'validate', message: 'Coord Break rows are excluded from legacy-to-blocks conversion.' });
  }
  if (legacyRows.length < 2) {
    issues.push({ severity: 'fatal', phase: 'validate', message: 'opticalSystem rows must contain at least Object and Image rows after filtering.' });
    return { blocks, issues };
  }

  const isStopRow = (r) => {
    const t = String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
    return t === 'stop';
  };
  const isImageRow = (r) => {
    const t = String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
    return t === 'image';
  };
  const normalizeMaterialName = (m) => String(m ?? '').trim();
  const isAirName = (m) => normalizeMaterialName(m).toUpperCase() === 'AIR';
  const isEmptyMaterial = (m) => normalizeMaterialName(m) === '';
  const asNumberOrInfOrZero = (v) => {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s = String(v).trim();
    if (s === '') return 0;
    if (/^inf(inity)?$/i.test(s)) return 'INF';
    if (isNumericString(s)) return Number(s);
    return 0;
  };
  const parseRadiusValue = (v) => {
    if (v === null || v === undefined) return 'INF';
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s = String(v).trim();
    if (s === '') return 'INF';
    if (/^inf(inity)?$/i.test(s)) return 'INF';
    if (isNumericString(s)) return Number(s);
    return s;
  };
  const parseSemiDiameterNumber = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s = String(v ?? '').trim();
    if (s === '') return NaN;
    return isNumericString(s) ? Number(s) : NaN;
  };

  const getLegacySemidiaRaw = (row) => {
    if (!row || typeof row !== 'object') return null;
    return row.semidia ?? row['Semi Diameter'] ?? row['semi diameter'] ?? row.semiDiameter ?? row.semiDia;
  };

  const legacyHasV = (rowObj, key) => {
    const raw = rowObj?.[key];
    if (raw === null || raw === undefined) return false;
    const s = String(raw).trim().toUpperCase();
    return s === 'V' || s.includes('V');
  };

  const legacyVarV = (value) => ({ value, optimize: { mode: 'V' } });

  let lensCount = 0;
  let doubletCount = 0;
  let tripletCount = 0;
  let stopCount = 0;
  let gapCount = 0;

  // We skip the first Object row and stop before the final Image row if present.
  let end = legacyRows.length;
  for (let k = legacyRows.length - 1; k >= 0; k--) {
    if (isImageRow(legacyRows[k])) {
      end = k;
      break;
    }
  }

  for (let i = 1; i < end; i++) {
    const r = legacyRows[i];
    if (!r || typeof r !== 'object') {
      issues.push({ severity: 'warning', phase: 'validate', message: `Row ${i} is not an object (skipped during Blocks conversion).` });
      continue;
    }

    const surfType = normalizeSurfTypeValue(r.surfType);
    // normalizeSurfTypeValue() only returns allowed values; keep this check defensive.
    if (surfType && !ALLOWED_SURF_TYPES.has(surfType)) {
      issues.push({
        severity: 'warning',
        phase: 'validate',
        message: `Unsupported surfType at row ${i}: ${String(r.surfType)} (treated as Spherical during Blocks conversion).`
      });
    }

    const material = __normalizeLegacyMaterialForBlocks(r, i, issues);
    const stopRowHasGlass = isStopRow(r) && material !== '' && !isAirName(material);
    if (isStopRow(r) && !stopRowHasGlass) {
      stopCount++;
      const blockId = `Stop-${stopCount}`;
      const sd = parseSemiDiameterNumber(r.semidia);
      const params = {};
      if (Number.isFinite(sd) && sd > 0) params.semiDiameter = sd;

      blocks.push({
        blockId,
        blockType: 'Stop',
        role: null,
        constraints: {},
        parameters: params,
        variables: {},
        metadata: { source: 'legacy-opticalSystem' }
      });

      // Preserve spacing after Stop as a Gap block (Gap attaches to the previous surface on expand).
      const t = asNumberOrInfOrZero(r.thickness);
      if ((typeof t === 'number' && Math.abs(t) > 1e-12) || t === 'INF') {
        gapCount++;
        const mRaw = normalizeMaterialName(r.material);
        const mKey = mRaw.replace(/\s+/g, '').toUpperCase();
        const gapMat = (mRaw === '' || mKey === 'AIR') ? 'AIR' : mRaw;
        blocks.push({
          blockId: `Gap-${gapCount}`,
          blockType: 'Gap',
          role: null,
          constraints: {},
          parameters: { thickness: t, material: gapMat },
          variables: legacyHasV(r, 'optimizeT') ? { thickness: legacyVarV(t) } : {},
          metadata: { source: 'legacy-opticalSystem', from: 'Stop.thickness', rowIndex: i }
        });
      }
      continue;
    }

    if (stopRowHasGlass) {
      issues.push({
        severity: 'warning',
        phase: 'validate',
        message: `Stop row ${i} has glass material and will be treated as a lens surface (Stop block omitted).`
      });
    }

    // Lens detection (legacy convention): a singlet is typically represented as two consecutive
    // spherical rows with the SAME glass name in the "material" column (often repeated on both surfaces).
    // Some files leave the back-surface material empty; treat that as "same as front".
    // We also allow back-surface material AIR (some tables encode medium-after-surface), but do not require it.
    if (material === '' || isAirName(material)) {
      // Not a lens front. In legacy files, AIR/empty rows can exist; skip them.
      continue;
    }
    if (!isKnownGlassNameOnly(material)) {
      issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name at row ${i} (allowed for imported/legacy designs): ${material}` });
    }

    // Find immediate next physical surface row as the back surface.
    if (i + 1 >= end) {
      issues.push({ severity: 'fatal', phase: 'validate', message: `Lens front at row ${i} has no following back surface row.` });
      continue;
    }
    const back = legacyRows[i + 1];
    if (!back || typeof back !== 'object') {
      issues.push({ severity: 'fatal', phase: 'validate', message: `Lens back row ${i + 1} is not an object.` });
      continue;
    }
    if (isStopRow(back)) {
      issues.push({ severity: 'fatal', phase: 'validate', message: `Cannot infer Lens at row ${i}: next row is Stop.` });
      continue;
    }

    const backMaterialRaw = __normalizeLegacyMaterialForBlocks(back, i + 1, issues);
    const backMaterial = isEmptyMaterial(backMaterialRaw) ? material : backMaterialRaw;
    const backMaterialUpper = backMaterial.toUpperCase();
    const materialUpper = material.toUpperCase();
    const backLooksLikeSameGlass = backMaterialUpper === materialUpper;
    const backLooksLikeAir = backMaterialRaw !== '' && isAirName(backMaterialRaw);

    // Cemented group detection (medium-after-surface convention): front glass -> another glass (not AIR).
    // Interpret as a cemented interface, and try to build Doublet/Triplet blocks.
    const backLooksLikeOtherGlass = !backLooksLikeSameGlass && !backLooksLikeAir
      && !isEmptyMaterial(backMaterialRaw);

    const readSurfaceAsphere = (rowObj, surfIdx) => {
      const surfType = normalizeSurfTypeValue(rowObj?.surfType) || 'Spherical';
      const conic = isNumericString(String(rowObj?.conic ?? '').trim()) ? Number(String(rowObj.conic).trim()) : (typeof rowObj?.conic === 'number' ? rowObj.conic : 0);
      const coefs = Array.from({ length: 10 }, (_, k) => {
        const vv = rowObj?.[`coef${k + 1}`];
        const s = String(vv ?? '').trim();
        if (s === '') return 0;
        return isNumericString(s) ? Number(s) : (typeof vv === 'number' && Number.isFinite(vv) ? vv : 0);
      });
      return {
        [`surf${surfIdx}SurfType`]: surfType,
        [`surf${surfIdx}Conic`]: conic,
        ...Object.fromEntries(coefs.map((v, idx) => [`surf${surfIdx}Coef${idx + 1}`, v]))
      };
    };

    if (backLooksLikeOtherGlass) {
      /** @type {any[]} */
      const chain = [r];
      /** @type {string[]} */
      const glasses = [material];

      // Walk forward until we hit a surface whose medium-after is AIR.
      let k = i + 1;
      let endIndex = null;
      for (; k < end; k++) {
        const rr = rows[k];
        if (!rr || typeof rr !== 'object') {
          issues.push({ severity: 'fatal', phase: 'validate', message: `Cemented group row ${k} is not an object.` });
          break;
        }
        if (isStopRow(rr)) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `Cannot infer cemented lens group at row ${i}: encountered Stop at row ${k}.` });
          break;
        }
        chain.push(rr);
        const mm = __normalizeLegacyMaterialForBlocks(rr, k, issues);
        if (mm !== '' && isAirName(mm)) {
          endIndex = k;
          break;
        }
        if (mm === '') {
          // Best-effort: some legacy tables leave the last "material" cell empty.
          // Treat it as the termination (AIR) so the cemented group can still be converted.
          issues.push({ severity: 'warning', phase: 'validate', message: `Cemented lens group at row ${i}: missing material at row ${k} (treated as AIR terminator for Blocks conversion).` });
          endIndex = k;
          break;
        }
        if (!isKnownGlassNameOnly(mm)) {
          issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name at row ${k} (allowed for imported/legacy designs): ${mm}` });
        }
        // The legacy "material" column may encode the medium-after-surface.
        // In that convention, the same glass can appear on multiple consecutive surfaces.
        // Only count a new element when the glass actually changes.
        const last = glasses.length > 0 ? glasses[glasses.length - 1] : '';
        if (String(mm).trim().toUpperCase() !== String(last).trim().toUpperCase()) {
          glasses.push(mm);
        }
        if (glasses.length > 3) {
          issues.push({
            severity: 'fatal',
            phase: 'validate',
            message: `Cemented group at row ${i} has ${glasses.length} glasses (more than Triplet). Not supported yet.`
          });
          break;
        }
      }

      if (endIndex === null) {
        // Could not terminate at AIR; fall back to legacy singlet logic by continuing.
        continue;
      }

      const elementCount = glasses.length;
      const surfaceCount = elementCount + 1;
      if (chain.length < surfaceCount) {
        issues.push({ severity: 'fatal', phase: 'validate', message: `Cemented group at row ${i} is truncated (expected ${surfaceCount} surfaces, got ${chain.length}).` });
        continue;
      }

      const radii = chain.slice(0, surfaceCount).map(s => parseRadiusValue(s.radius));
      const thicknesses = chain.slice(0, elementCount).map(s => asNumberOrInfOrZero(s.thickness));

      if (elementCount === 2) {
        doubletCount++;
        const id = `Doublet-${doubletCount}`;
        const params = {
          radius1: radii[0],
          radius2: radii[1],
          radius3: radii[2],
          thickness1: thicknesses[0],
          thickness2: thicknesses[1],
          material1: glasses[0],
          material2: glasses[1],
          ...readSurfaceAsphere(chain[0], 1),
          ...readSurfaceAsphere(chain[1], 2),
          ...readSurfaceAsphere(chain[2], 3),
        };
        blocks.push({
          blockId: id,
          blockType: 'Doublet',
          role: null,
          constraints: {},
          parameters: params,
          aperture: {
            s1: getLegacySemidiaRaw(chain[0]),
            s2: getLegacySemidiaRaw(chain[1]),
            s3: getLegacySemidiaRaw(chain[2]),
          },
          variables: {},
          metadata: { source: 'legacy-opticalSystem' }
        });

        // Spacing after the last surface becomes a Gap block.
        const lastSurf = chain[2];
        const gapT = asNumberOrInfOrZero(lastSurf.thickness);
        if ((typeof gapT === 'number' && Math.abs(gapT) > 1e-12) || gapT === 'INF') {
          gapCount++;
          const mRaw = normalizeMaterialName(lastSurf.material);
          const mKey = mRaw.replace(/\s+/g, '').toUpperCase();
          const gKeys = new Set(glasses.map(g => String(g ?? '').replace(/\s+/g, '').toUpperCase()).filter(Boolean));
          const gapMat = (mRaw === '' || mKey === 'AIR' || gKeys.has(mKey)) ? 'AIR' : mRaw;
          blocks.push({
            blockId: `Gap-${gapCount}`,
            blockType: 'Gap',
            role: null,
            constraints: {},
            parameters: { thickness: gapT, material: gapMat },
            variables: legacyHasV(lastSurf, 'optimizeT') ? { thickness: legacyVarV(gapT) } : {},
            metadata: { source: 'legacy-opticalSystem' }
          });
        }

        i += 2; // consumed up to surface 3 (i, i+1, i+2)
        continue;
      }

      if (elementCount === 3) {
        tripletCount++;
        const id = `Triplet-${tripletCount}`;
        const params = {
          radius1: radii[0],
          radius2: radii[1],
          radius3: radii[2],
          radius4: radii[3],
          thickness1: thicknesses[0],
          thickness2: thicknesses[1],
          thickness3: thicknesses[2],
          material1: glasses[0],
          material2: glasses[1],
          material3: glasses[2],
          ...readSurfaceAsphere(chain[0], 1),
          ...readSurfaceAsphere(chain[1], 2),
          ...readSurfaceAsphere(chain[2], 3),
          ...readSurfaceAsphere(chain[3], 4),
        };
        blocks.push({
          blockId: id,
          blockType: 'Triplet',
          role: null,
          constraints: {},
          parameters: params,
          aperture: {
            s1: getLegacySemidiaRaw(chain[0]),
            s2: getLegacySemidiaRaw(chain[1]),
            s3: getLegacySemidiaRaw(chain[2]),
            s4: getLegacySemidiaRaw(chain[3]),
          },
          variables: {},
          metadata: { source: 'legacy-opticalSystem' }
        });

        const lastSurf = chain[3];
        const gapT = asNumberOrInfOrZero(lastSurf.thickness);
        if ((typeof gapT === 'number' && Math.abs(gapT) > 1e-12) || gapT === 'INF') {
          gapCount++;
          const mRaw = normalizeMaterialName(lastSurf.material);
          const mKey = mRaw.replace(/\s+/g, '').toUpperCase();
          const gKeys = new Set(glasses.map(g => String(g ?? '').replace(/\s+/g, '').toUpperCase()).filter(Boolean));
          const gapMat = (mRaw === '' || mKey === 'AIR' || gKeys.has(mKey)) ? 'AIR' : mRaw;
          blocks.push({
            blockId: `Gap-${gapCount}`,
            blockType: 'Gap',
            role: null,
            constraints: {},
            parameters: { thickness: gapT, material: gapMat },
            variables: legacyHasV(lastSurf, 'optimizeT') ? { thickness: legacyVarV(gapT) } : {},
            metadata: { source: 'legacy-opticalSystem' }
          });
        }

        i += 3; // consumed up to surface 4
        continue;
      }

      // Should not reach here due to glasses.length cap, but keep safe.
      continue;
    }

    if (!(backLooksLikeSameGlass || backLooksLikeAir)) {
      issues.push({
        severity: 'fatal',
        phase: 'validate',
        message:
          `Cannot infer singlet Lens at row ${i}: back surface material must match front glass (or be empty/AIR). ` +
          `front=${material}, back=${backMaterialRaw || '(empty)'}`
      });
      continue;
    }

    lensCount++;
    const lensId = `Lens-${lensCount}`;
    const frontRadius = parseRadiusValue(r.radius);
    const backRadius = parseRadiusValue(back.radius);
    const centerThickness = asNumberOrInfOrZero(r.thickness);

    const frontSurfType = normalizeSurfTypeValue(r.surfType) || 'Spherical';
    const backSurfType = normalizeSurfTypeValue(back.surfType) || 'Spherical';
    const frontConic = isNumericString(String(r.conic ?? '').trim()) ? Number(String(r.conic).trim()) : (typeof r.conic === 'number' ? r.conic : 0);
    const backConic = isNumericString(String(back.conic ?? '').trim()) ? Number(String(back.conic).trim()) : (typeof back.conic === 'number' ? back.conic : 0);
    const frontCoefs = Array.from({ length: 10 }, (_, k) => {
      const vv = r[`coef${k + 1}`];
      const s = String(vv ?? '').trim();
      if (s === '') return 0;
      return isNumericString(s) ? Number(s) : (typeof vv === 'number' && Number.isFinite(vv) ? vv : 0);
    });
    const backCoefs = Array.from({ length: 10 }, (_, k) => {
      const vv = back[`coef${k + 1}`];
      const s = String(vv ?? '').trim();
      if (s === '') return 0;
      return isNumericString(s) ? Number(s) : (typeof vv === 'number' && Number.isFinite(vv) ? vv : 0);
    });

    blocks.push({
      blockId: lensId,
      blockType: 'Lens',
      role: null,
      constraints: {},
      parameters: {
        frontRadius,
        backRadius,
        centerThickness,
        material,

        frontSurfType,
        frontConic,
        ...Object.fromEntries(frontCoefs.map((v, idx) => [`frontCoef${idx + 1}`, v])),

        backSurfType,
        backConic,
        ...Object.fromEntries(backCoefs.map((v, idx) => [`backCoef${idx + 1}`, v]))
      },
      aperture: {
        front: getLegacySemidiaRaw(r),
        back: getLegacySemidiaRaw(back),
      },
      variables: {},
      metadata: { source: 'legacy-opticalSystem' }
    });

    // Spacing after the lens back surface becomes a Gap block.
    const gapT = asNumberOrInfOrZero(back.thickness);
    if ((typeof gapT === 'number' && Math.abs(gapT) > 1e-12) || gapT === 'INF') {
      gapCount++;
      const bmRaw = normalizeMaterialName(back.material);
      const bmKey = bmRaw.replace(/\s+/g, '').toUpperCase();
      const matKey = String(material ?? '').trim().replace(/\s+/g, '').toUpperCase();
      const gapMat = (bmRaw === '' || bmKey === 'AIR' || bmKey === matKey) ? 'AIR' : bmRaw;
      blocks.push({
        blockId: `Gap-${gapCount}`,
        blockType: 'Gap',
        role: null,
        constraints: {},
        parameters: { thickness: gapT, material: gapMat },
        variables: legacyHasV(back, 'optimizeT') ? { thickness: legacyVarV(gapT) } : {},
        metadata: { source: 'legacy-opticalSystem' }
      });
    }

    i++; // consumed back row
  }

  // Marker block
  blocks.push({
    blockId: 'ImagePlane-1',
    blockType: 'ImagePlane',
    role: null,
    constraints: {},
    parameters: undefined,
    variables: {},
    metadata: { source: 'legacy-opticalSystem' }
  });

  return { blocks, issues };
}

/**
 * Expand blocks for a configuration in-place (derives opticalSystem from blocks).
 *
 * @param {any} config
 * @returns {{ expandedOpticalSystem: any[]|null, issues: LoadIssue[] }}
 */
export function expandBlocksIntoConfiguration(config) {
  if (!configurationHasBlocks(config)) return { expandedOpticalSystem: null, issues: [] };

  const issues = [];
  issues.push(...validateBlocksConfiguration(config));
  if (issues.some(i => i.severity === 'fatal')) return { expandedOpticalSystem: null, issues };

  // Preserve per-surface semidia (aperture) from existing opticalSystem rows when available.
  // Blocks only model Stop.semiDiameter; other semidia values are surface-table details.
  const legacyRows = Array.isArray(config?.opticalSystem) ? config.opticalSystem : null;

  // Persist semidia in Design Intent (blocks) keyed by provenance (blockId + surfaceRole).
  try { __captureBlockApertureFromLegacyRows(config.blocks, legacyRows); } catch (_) {}

  // Persist semidia as configuration-level overrides so it survives any regeneration.
  try {
    config.semidiaOverrides = __captureSemidiaOverridesFromRows(legacyRows, config?.semidiaOverrides);
  } catch (_) {}

  const expanded = expandBlocksToOpticalSystemRows(config.blocks);
  issues.push(...expanded.issues);
  if (expanded.issues.some(i => i.severity === 'fatal')) return { expandedOpticalSystem: null, issues };

  // Preserve semidia from existing opticalSystem rows using provenance keys.
  // (Index-based copying breaks when a CB surface is inserted/deleted.)
  try {
    if (Array.isArray(legacyRows) && Array.isArray(expanded?.rows)) {
      /** @type {Map<string, any>} */
      const legacyByProv = new Map();
      for (const lr of legacyRows) {
        if (!lr || typeof lr !== 'object') continue;
        const t = __rowTypeLower(lr);
        if (t === 'stop' || t === 'image' || __isCoordTransRow(lr)) continue;
        const pk = __provenanceKey(lr);
        if (!pk) continue;
        const v = __getRowSemidia(lr);
        if (!__semidiaHasValue(v)) continue;
        legacyByProv.set(pk, v);
      }

      for (const er of expanded.rows) {
        if (!er || typeof er !== 'object') continue;
        const t = __rowTypeLower(er);
        if (t === 'stop' || t === 'image' || __isCoordTransRow(er)) continue;
        const pk = __provenanceKey(er);
        if (!pk) continue;
        if (legacyByProv.has(pk)) er.semidia = legacyByProv.get(pk);
      }
    }
  } catch (_) {}

  // Apply persisted overrides last (provenance-keyed when possible).
  try { __applySemidiaOverridesToRows(expanded?.rows, config?.semidiaOverrides); } catch (_) {}

  config.opticalSystem = expanded.rows;
  return { expandedOpticalSystem: expanded.rows, issues };
}

/**
 * Returns true if the given block contains a usable glass region constraint.
 *
 * Expected shape:
 *   block.constraints.glassRegion = { minNd, maxNd, minVd, maxVd }
 *
 * @param {any} block
 * @returns {boolean}
 */
export function hasGlassRegionConstraint(block) {
  try {
    const gr = block?.constraints?.glassRegion;
    if (!gr || typeof gr !== 'object') return false;

    const minNd = Number(gr.minNd ?? gr.ndMin);
    const maxNd = Number(gr.maxNd ?? gr.ndMax);
    const minVd = Number(gr.minVd ?? gr.vdMin);
    const maxVd = Number(gr.maxVd ?? gr.vdMax);

    if (![minNd, maxNd, minVd, maxVd].every(Number.isFinite)) return false;
    if (!(maxNd > minNd)) return false;
    if (!(maxVd > minVd)) return false;
    return true;
  } catch (_) {
    return false;
  }
}
