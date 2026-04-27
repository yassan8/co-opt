// Design normalization (入口互換吸収)
//
// Goal:
// - Accept multiple input shapes (legacy tables, configurations wrapper, shorthand {system, blocks})
// - Normalize into a single canonical payload shape:
//     { configurations: <systemConfigurationsObject> }
// - Do not alert here. Return issues for the UI layer.

/**
 * @typedef {'fatal'|'warning'} LoadIssueSeverity
 * @typedef {'parse'|'normalize'|'validate'|'expand'} LoadIssuePhase
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

function deepCloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isNumericString(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s === '') return false;
  return /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s);
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && isNumericString(value)) return Number(value);
  return NaN;
}

function defaultSourceRows() {
  return [
    { id: 1, wavelength: 0.4358343, weight: 1.0, primary: '', angle: 0 },
    { id: 2, wavelength: 0.5875618, weight: 1.0, primary: 'Primary Wavelength', angle: 5 },
    { id: 3, wavelength: 0.6562725, weight: 1.0, primary: '', angle: 10 }
  ];
}

function defaultObjectRows() {
  return [
    { id: 1, xHeightAngle: 0, yHeightAngle: 0, position: 'Rectangle', angle: 0 },
    { id: 2, xHeightAngle: 0, yHeightAngle: 5, position: 'Rectangle', angle: 5 },
    { id: 3, xHeightAngle: 0, yHeightAngle: 10, position: 'Rectangle', angle: 10 }
  ];
}

function looksLikeCompactOpticalDiffRows(rows, baseRows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  if (!Array.isArray(baseRows) || baseRows.length === 0) return false;
  if (rows.length >= baseRows.length) return false;

  const baseIds = new Set(
    baseRows
      .map((row) => String(row?.id ?? '').trim())
      .filter(Boolean)
  );

  let matchedRows = 0;
  for (const row of rows) {
    if (!isPlainObject(row)) return false;
    const keys = Object.keys(row);
    const rowId = String(row?.id ?? '').trim();
    if (!rowId || !baseIds.has(rowId)) return false;
    if (keys.length > 6) return false;
    matchedRows += 1;
  }

  return matchedRows === rows.length;
}

function mergeOpticalRowDiffs(baseRows, overrideRows) {
  const mergedRows = Array.isArray(baseRows) ? deepCloneJson(baseRows) : [];
  const mergedById = new Map();

  for (const row of mergedRows) {
    const rowId = String(row?.id ?? '').trim();
    if (rowId) mergedById.set(rowId, row);
  }

  for (const rawOverride of Array.isArray(overrideRows) ? overrideRows : []) {
    if (!isPlainObject(rawOverride)) continue;
    const rowId = String(rawOverride?.id ?? '').trim();
    const override = deepCloneJson(rawOverride);
    if (!rowId || !mergedById.has(rowId)) {
      mergedRows.push(override);
      continue;
    }
    Object.assign(mergedById.get(rowId), override);
  }

  return mergedRows;
}

function expandCompactConfigurationPayload(raw, issues) {
  if (!isPlainObject(raw?.configurations) || !Array.isArray(raw.configurations.configurations)) return;

  const wrapper = raw.configurations;
  const configs = wrapper.configurations;
  const baseObject = Array.isArray(raw.object) ? raw.object : null;
  const baseOpticalSystem = Array.isArray(raw.opticalSystem) ? raw.opticalSystem : null;
  const baseSystemData = isPlainObject(raw.systemData) ? raw.systemData : { referenceFocalLength: '' };
  const schemaVersion = String(raw.schemaVersion ?? wrapper.schemaVersion ?? '0.1').trim() || '0.1';
  const now = new Date().toISOString();

  if (!Array.isArray(wrapper.meritFunction) && Array.isArray(raw.meritFunction)) {
    wrapper.meritFunction = deepCloneJson(raw.meritFunction);
  }
  if (!Array.isArray(wrapper.systemRequirements) && Array.isArray(raw.systemRequirements)) {
    wrapper.systemRequirements = deepCloneJson(raw.systemRequirements);
  }
  if (!isPlainObject(wrapper.optimizationRules) && isPlainObject(raw.optimizationRules)) {
    wrapper.optimizationRules = deepCloneJson(raw.optimizationRules);
  }

  let expandedCount = 0;

  for (const cfg of configs) {
    if (!isPlainObject(cfg)) continue;

    const hasCompactOnlyShape = (
      !Array.isArray(cfg.object)
      && !isPlainObject(cfg.systemData)
      && !isPlainObject(cfg.metadata)
      && (cfg.schemaVersion === undefined || cfg.schemaVersion === null || String(cfg.schemaVersion).trim() === '')
    );

    if (hasCompactOnlyShape && looksLikeCompactOpticalDiffRows(cfg.opticalSystem, baseOpticalSystem)) {
      cfg.opticalSystem = mergeOpticalRowDiffs(baseOpticalSystem, cfg.opticalSystem);
      expandedCount += 1;
    } else if ((!Array.isArray(cfg.opticalSystem) || cfg.opticalSystem.length === 0) && Array.isArray(baseOpticalSystem) && baseOpticalSystem.length > 0) {
      cfg.opticalSystem = deepCloneJson(baseOpticalSystem);
    }

    if ((!Array.isArray(cfg.object) || cfg.object.length === 0) && Array.isArray(baseObject) && baseObject.length > 0) {
      cfg.object = deepCloneJson(baseObject);
    }

    if (!isPlainObject(cfg.systemData)) {
      cfg.systemData = deepCloneJson(baseSystemData);
    }

    if (!isPlainObject(cfg.metadata)) {
      cfg.metadata = {
        created: now,
        modified: now,
        optimizationTarget: null,
        locked: false,
      };
    } else {
      if (!cfg.metadata.created) cfg.metadata.created = now;
      if (!cfg.metadata.modified) cfg.metadata.modified = now;
      if (cfg.metadata.locked === undefined) cfg.metadata.locked = false;
    }

    if (cfg.schemaVersion === undefined || cfg.schemaVersion === null || String(cfg.schemaVersion).trim() === '') {
      cfg.schemaVersion = schemaVersion;
    }
  }

  if (expandedCount > 0) {
    issues.push({
      severity: 'warning',
      phase: 'normalize',
      message: `${expandedCount} compact configurations were expanded from top-level opticalSystem/object/systemData.`
    });
  }
}

function normalizeBlockType(rawType) {
  const t = String(rawType || '').trim();
  if (!t) return '';
  const key = t
    .replace(/\s+/g, '')
    .replace(/[_-]+/g, '')
    .toLowerCase();

  if (key === 'thinlens' || key === 'thin' || key === 'thin-lens' || key === 'thin_lens') return 'Paraxial';
  if (key === 'positivelens' || key === 'lens' || key === 'singlet') return 'Lens';
  // Gap (legacy alias: AirGap)
  if (key === 'gap' || key === 'airgap' || key === 'air' || key === 'space' || key === 'freespace') return 'Gap';
  if (key === 'stop' || key === 'aperturestop' || key === 'aperture') return 'Stop';
  if (key === 'imagesurface' || key === 'image' || key === 'image_surface' || key === 'imagesurface') return 'ImageSurface';
  return t;
}

function coerceVariablesShape(variables) {
  // Accept:
  //   variables: { frontRadius: 50 }
  //   variables: { frontRadius: { value: 50, optimize: { mode: 'V' } } }
  //   variables: { frontRadius: { value: 50 } }
  if (!isPlainObject(variables)) return {};
  const out = {};
  for (const [k, v] of Object.entries(variables)) {
    if (isPlainObject(v) && Object.prototype.hasOwnProperty.call(v, 'value')) {
      out[k] = v;
      continue;
    }
    // Allow optimize-only shorthand: { optimize:{mode:'V'} } without value
    if (isPlainObject(v) && Object.prototype.hasOwnProperty.call(v, 'optimize') && !Object.prototype.hasOwnProperty.call(v, 'value')) {
      out[k] = v;
      continue;
    }
    out[k] = { value: v };
  }
  return out;
}

function coerceParametersShape(parameters) {
  // Accept missing / non-object parameters.
  return isPlainObject(parameters) ? { ...parameters } : {};
}

function normalizeSystemToTables(system, issues) {
  const source = [];
  const object = [];

  const wavelengths = Array.isArray(system?.wavelengths) ? system.wavelengths : null;
  if (!wavelengths || wavelengths.length === 0) {
    issues.push({ severity: 'warning', phase: 'normalize', message: 'system.wavelengths is missing; using default wavelengths.' });
    return { source: defaultSourceRows(), object: defaultObjectRows() };
  }

  // Source rows
  const wNums = wavelengths
    .map(w => (typeof w === 'number' ? w : toNumber(String(w))))
    .filter(n => Number.isFinite(n) && n > 0);

  if (wNums.length === 0) {
    issues.push({ severity: 'warning', phase: 'normalize', message: 'system.wavelengths has no valid numeric entries; using default wavelengths.' });
    return { source: defaultSourceRows(), object: defaultObjectRows() };
  }

  // Primary: prefer ~0.5876 if present, else first
  let primaryIndex = 0;
  for (let i = 0; i < wNums.length; i++) {
    if (Math.abs(wNums[i] - 0.5876) < 0.01) {
      primaryIndex = i;
      break;
    }
  }

  for (let i = 0; i < wNums.length; i++) {
    source.push({
      id: i + 1,
      wavelength: wNums[i],
      weight: 1.0,
      primary: i === primaryIndex ? 'Primary Wavelength' : '',
      angle: 0
    });
  }

  // Object rows (fields)
  const fields = Array.isArray(system?.fields) ? system.fields : null;
  if (!fields || fields.length === 0) {
    issues.push({ severity: 'warning', phase: 'normalize', message: 'system.fields is missing; using default fields.' });
    return { source, object: defaultObjectRows() };
  }

  const angles = [];
  for (const f of fields) {
    if (!isPlainObject(f)) continue;
    const t = String(f.type || '').trim();
    if (t !== 'Angle') continue;
    const v = toNumber(f.value);
    if (Number.isFinite(v)) angles.push(v);
  }

  if (angles.length === 0) {
    issues.push({ severity: 'warning', phase: 'normalize', message: 'system.fields has no usable Angle entries; using default fields.' });
    return { source, object: defaultObjectRows() };
  }

  for (let i = 0; i < angles.length; i++) {
    object.push({
      id: i + 1,
      xHeightAngle: 0,
      yHeightAngle: angles[i],
      position: 'Rectangle',
      angle: angles[i]
    });
  }

  return { source, object };
}

function ensureBlockIds(blocks, issues) {
  const autoAssigned = [];
  const migratedStopSemidia = [];
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!isPlainObject(b)) {
      issues.push({ severity: 'fatal', phase: 'normalize', message: `blocks[${i}] must be an object.` });
      continue;
    }
    const blockType = normalizeBlockType(b.blockType);
    if (!blockType) {
      issues.push({ severity: 'fatal', phase: 'normalize', message: `blocks[${i}].blockType is required.` });
      continue;
    }

    const rawBlockId = typeof b.blockId === 'string' ? b.blockId : '';
    const trimmedBlockId = rawBlockId.trim();
    const blockId = trimmedBlockId ? trimmedBlockId : `${blockType}-${i + 1}`;
    if (!trimmedBlockId) {
      autoAssigned.push({ blockId, blockType, index: i });
    }

    const parameters = blockType === 'ImageSurface' ? undefined : coerceParametersShape(b.parameters);
    const variables = coerceVariablesShape(b.variables);

    // Stop.semiDiameter: canonical source is parameters.semiDiameter.
    // For compatibility, migrate variables.semiDiameter.value -> parameters.semiDiameter when missing.
    if (blockType === 'Stop') {
      const hasParam = isPlainObject(parameters) && Object.prototype.hasOwnProperty.call(parameters, 'semiDiameter');
      const v = isPlainObject(variables) ? variables.semiDiameter : undefined;
      const vVal = isPlainObject(v) && Object.prototype.hasOwnProperty.call(v, 'value') ? v.value : undefined;
      if (!hasParam && vVal !== undefined) {
        if (isPlainObject(parameters)) {
          parameters.semiDiameter = typeof vVal === 'number' ? vVal : (isNumericString(String(vVal)) ? Number(vVal) : vVal);
          migratedStopSemidia.push(blockId);
        }
      }
    }

    out.push({
      blockId,
      blockType,
      role: b.role ?? null,
      constraints: isPlainObject(b.constraints) ? b.constraints : {},
      parameters,
      variables,
      metadata: isPlainObject(b.metadata) ? b.metadata : {}
    });
  }

  if (autoAssigned.length > 0) {
    const preview = autoAssigned.slice(0, 5).map(a => a.blockId).join(', ');
    const more = autoAssigned.length > 5 ? `, ...(+${autoAssigned.length - 5} more)` : '';
    issues.push({
      severity: 'warning',
      phase: 'normalize',
      message: `${autoAssigned.length} blocks were missing blockId; auto-assigned: ${preview}${more}.`
    });
  }

  if (migratedStopSemidia.length > 0) {
    const preview = migratedStopSemidia.slice(0, 5).join(', ');
    const more = migratedStopSemidia.length > 5 ? `, ...(+${migratedStopSemidia.length - 5} more)` : '';
    issues.push({
      severity: 'warning',
      phase: 'normalize',
      message: `${migratedStopSemidia.length} Stop blocks migrated variables.semiDiameter -> parameters.semiDiameter: ${preview}${more}.`
    });
  }

  return out;
}

/**
 * Normalize any supported payload into canonical shape.
 *
 * Canonical output:
 *   { configurations: <systemConfigurationsObject> }
 *
 * @param {any} raw
 * @returns {{ normalized: any, issues: LoadIssue[] }}
 */
export function normalizeDesign(raw) {
  /** @type {LoadIssue[]} */
  const issues = [];

  if (!isPlainObject(raw)) {
    issues.push({ severity: 'fatal', phase: 'normalize', message: 'Top-level JSON must be an object.' });
    return { normalized: null, issues };
  }

  // Compatibility: promote per-configuration source -> top-level source.
  // The app treats Source as a shared (global) table across configurations.
  if (!Array.isArray(raw.source) && isPlainObject(raw.configurations) && Array.isArray(raw.configurations.configurations)) {
    const firstConfigWithSource = raw.configurations.configurations.find(c => isPlainObject(c) && Array.isArray(c.source));
    if (firstConfigWithSource && Array.isArray(firstConfigWithSource.source)) {
      raw.source = firstConfigWithSource.source;
      issues.push({ severity: 'warning', phase: 'normalize', message: 'Configuration-level source detected; promoted to top-level source.' });
    }
  }

  expandCompactConfigurationPayload(raw, issues);

  // Case 1: already canonical save wrapper: { configurations: <systemConfigurations> }
  if (isPlainObject(raw.configurations) && Array.isArray(raw.configurations.configurations)) {
    // Compatibility: allow top-level systemRequirements field and merge into configurations.
    if (Array.isArray(raw.systemRequirements) && !Array.isArray(raw.configurations.systemRequirements)) {
      raw.configurations.systemRequirements = raw.systemRequirements;
    }
    return { normalized: raw, issues };
  }

  // Case 2: legacy save format: { source, object, opticalSystem, meritFunction, systemData, configurations?: ... }
  if (isPlainObject(raw.configurations) && raw.configurations.configurations) {
    // Compatibility: allow top-level systemRequirements field and merge into configurations.
    if (Array.isArray(raw.systemRequirements) && !Array.isArray(raw.configurations.systemRequirements)) {
      raw.configurations.systemRequirements = raw.systemRequirements;
    }
    // weird but accept
    return { normalized: raw, issues };
  }

  // Case 3: shorthand block schema: { system: {...}, blocks: [...] }
  if (isPlainObject(raw.system) && Array.isArray(raw.blocks)) {
    const { source, object } = normalizeSystemToTables(raw.system, issues);

    const blocks = ensureBlockIds(raw.blocks, issues);
    if (issues.some(i => i.severity === 'fatal')) return { normalized: null, issues };

    const systemConfigurations = {
      configurations: [
        {
          id: 1,
          name: 'Config 1',
          schemaVersion: '0.1',
          blocks,
          scenarios: Array.isArray(raw.scenarios) ? raw.scenarios : undefined,
          activeScenarioId: (raw.activeScenarioId !== undefined && raw.activeScenarioId !== null) ? String(raw.activeScenarioId) : undefined,
          source,
          object,
          opticalSystem: [],
          systemData: { referenceFocalLength: '' },
          metadata: {
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            optimizationTarget: null,
            locked: false,
            designer: { type: 'imported', name: 'shorthand', confidence: null }
          }
        }
      ],
      activeConfigId: 1,
      meritFunction: Array.isArray(raw.meritFunction) ? raw.meritFunction : [],
      systemRequirements: Array.isArray(raw.systemRequirements) ? raw.systemRequirements : [],
      optimizationRules: isPlainObject(raw.optimizationRules) ? raw.optimizationRules : {}
    };

    return { normalized: { configurations: systemConfigurations }, issues };
  }

  // Case 3b: AI shorthand: { blocks: [...] } (no system). Use defaults for system tables.
  if (Array.isArray(raw.blocks)) {
    issues.push({ severity: 'warning', phase: 'normalize', message: 'Top-level blocks provided without system; using default wavelengths/fields.' });

    const blocks = ensureBlockIds(raw.blocks, issues);
    if (issues.some(i => i.severity === 'fatal')) return { normalized: null, issues };

    const systemConfigurations = {
      configurations: [
        {
          id: 1,
          name: 'Config 1',
          schemaVersion: '0.1',
          blocks,
          scenarios: Array.isArray(raw.scenarios) ? raw.scenarios : undefined,
          activeScenarioId: (raw.activeScenarioId !== undefined && raw.activeScenarioId !== null) ? String(raw.activeScenarioId) : undefined,
          source: defaultSourceRows(),
          object: defaultObjectRows(),
          opticalSystem: [],
          systemData: { referenceFocalLength: '' },
          metadata: {
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            optimizationTarget: null,
            locked: false,
            designer: { type: 'imported', name: 'ai-shorthand', confidence: null }
          }
        }
      ],
      activeConfigId: 1,
      meritFunction: Array.isArray(raw.meritFunction) ? raw.meritFunction : [],
      systemRequirements: Array.isArray(raw.systemRequirements) ? raw.systemRequirements : [],
      optimizationRules: isPlainObject(raw.optimizationRules) ? raw.optimizationRules : {}
    };

    return { normalized: { configurations: systemConfigurations }, issues };
  }

  // Case 4: older table-only format (no configurations): migrate to canonical.
  if (Array.isArray(raw.source) || Array.isArray(raw.object) || Array.isArray(raw.opticalSystem)) {
    const systemConfigurations = {
      configurations: [
        {
          id: 1,
          name: 'Config 1',
          schemaVersion: null,
          blocks: null,
          source: Array.isArray(raw.source) ? raw.source : [],
          object: Array.isArray(raw.object) ? raw.object : [],
          opticalSystem: Array.isArray(raw.opticalSystem) ? raw.opticalSystem : [],
          systemData: isPlainObject(raw.systemData) ? raw.systemData : { referenceFocalLength: '' },
          metadata: {
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            optimizationTarget: null,
            locked: false,
            designer: { type: 'imported', name: 'legacy', confidence: null }
          }
        }
      ],
      activeConfigId: 1,
      meritFunction: Array.isArray(raw.meritFunction) ? raw.meritFunction : [],
      systemRequirements: Array.isArray(raw.systemRequirements) ? raw.systemRequirements : [],
      optimizationRules: isPlainObject(raw.optimizationRules) ? raw.optimizationRules : {}
    };

    issues.push({ severity: 'warning', phase: 'normalize', message: 'Legacy table format detected; normalized into configurations wrapper.' });
    return { normalized: { configurations: systemConfigurations }, issues };
  }

  issues.push({ severity: 'fatal', phase: 'normalize', message: 'Unrecognized JSON format.' });
  return { normalized: null, issues };
}
