// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

// System Configuration管理モジュール
// 複数のConfigurationを保存・切り替え可能にする

import { BLOCK_SCHEMA_VERSION, DEFAULT_STOP_SEMI_DIAMETER, configurationHasBlocks, validateBlocksConfiguration, expandBlocksToOpticalSystemRows, isPhysicalBlockType, type DesignConnection, type PortRoute, type PortRouteSet, type LoadIssue } from './block-schema.ts';
import { storageGetItem, storageSetItem, storageRemoveItem } from '../utils/local-storage-gateway.ts';
import { calculateParaxialData, getRefractiveIndex } from '../raytracing/core/ray-paraxial.ts';
import { getGlassDataWithSellmeier, getPrimaryWavelength } from './glass.ts';
import { tryLoadPersistedTableData as tryLoadPersistedSystemRequirementsTableData } from './table-system-requirements.ts';
import { normalizeCoherentAssemblyDesign, type CoherentAssemblyDesign } from '../analysis/coherent-assembly.ts';
import { migrateLegacyCoherentDesign } from '../analysis/hybrid-design.ts';

// Block interface (for type safety with block-schema)
interface Block {
  blockId?: string;
  blockType?: string;
  role?: any;
  constraints?: Record<string, any>;
  parameters?: Record<string, any>;
  variables?: Record<string, any>;
  metadata?: Record<string, any>;
}

interface SaveConfigurationOptions {
  syncExpandedRowsToBlocks?: boolean;
}

const STORAGE_KEY = "systemConfigurations";

const CONFIG_DEBUG = !!(typeof globalThis !== 'undefined' && w.__CONFIG_DEBUG);
const cfgLog = (...args: any[]): void => { if (CONFIG_DEBUG) console.log(...args); };
const cfgWarn = (...args: any[]): void => { if (CONFIG_DEBUG) console.warn(...args); };

let warnedActiveConfigNotFound = false;
const loggedBlockValidationFatalKeys = new Set<string>();
const APERTURE_TRACKED_BLOCK_TYPES = new Set(['lens', 'paraxial', 'thinlens', 'doublet', 'triplet', 'singlesurface', 'mirror']);

function idsEqual(a: any, b: any): boolean {
  return String(a ?? '') === String(b ?? '');
}

export function shouldPreferImportedOpticalRows(cfg: any): boolean {
  try {
    if (!cfg || typeof cfg !== 'object') return false;
    const metadata = cfg.metadata && typeof cfg.metadata === 'object' ? cfg.metadata : null;
    const hasExplicitRows = Array.isArray(cfg.opticalSystem) && cfg.opticalSystem.length > 0;
    if (!hasExplicitRows) return false;
    return !!(metadata?.importRowsPreferred || metadata?.importAnalyzeMode);
  } catch (_) {
    return false;
  }
}

function isPlaceholderThreeBlockConfig(cfg: any): boolean {
  try {
    if (!cfg || typeof cfg !== 'object') return false;
    const blocks = Array.isArray(cfg.blocks) ? cfg.blocks : [];
    if (blocks.length !== 3) return false;
    const blockTypes = blocks.map((b: any) => String(b?.blockType ?? '').trim()).sort();
    const expected = ['ImageSurface', 'ObjectSurface', 'Stop'];
    for (let i = 0; i < expected.length; i++) {
      if (blockTypes[i] !== expected[i]) return false;
    }
    const opticalLen = Array.isArray(cfg.opticalSystem) ? cfg.opticalSystem.length : 0;
    return opticalLen <= 3;
  } catch (_) {
    return false;
  }
}

function isPlaceholderThreeBlockSystemConfig(systemConfig: any): boolean {
  try {
    const cfgs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
    if (cfgs.length !== 1) return false;
    const active = cfgs.find((c: any) => idsEqual(c?.id, systemConfig?.activeConfigId)) || cfgs[0];
    return isPlaceholderThreeBlockConfig(active);
  } catch (_) {
    return false;
  }
}

function hasRicherThanPlaceholderContent(systemConfig: any): boolean {
  try {
    const cfgs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
    if (cfgs.length > 1) return true;
    const active = cfgs.find((c: any) => idsEqual(c?.id, systemConfig?.activeConfigId)) || cfgs[0];
    if (!active || typeof active !== 'object') return false;
    if (!isPlaceholderThreeBlockConfig(active)) return true;
    const opticalLen = Array.isArray(active.opticalSystem) ? active.opticalSystem.length : 0;
    return opticalLen > 3;
  } catch (_) {
    return false;
  }
}

function cloneSystemConfiguration<T>(value: T): T | null {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return null;
  }
}

function isPlainObjectRecord(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFixedStopBlocksForConfiguration(config: any): void {
  const blocks = Array.isArray(config?.blocks) ? config.blocks : [];
  for (const block of blocks) {
    if (String(block?.blockType ?? '').trim() !== 'Stop') continue;

    if (!isPlainObjectRecord(block.parameters)) block.parameters = {};
    const legacySemiDiameter = isPlainObjectRecord(block.variables?.semiDiameter)
      ? block.variables.semiDiameter.value
      : undefined;
    if (
      !Object.prototype.hasOwnProperty.call(block.parameters, 'semiDiameter')
      && legacySemiDiameter !== undefined
    ) {
      block.parameters.semiDiameter = legacySemiDiameter;
    }

    // The stop defines the fixed aperture reference. It is never a design variable.
    block.variables = {};
  }
}

function mergeVariableEntriesFromBaseline(currentVars: any, baselineVars: any, currentParams?: any): Record<string, any> {
  const current = isPlainObjectRecord(currentVars) ? currentVars : {};
  const baseline = isPlainObjectRecord(baselineVars) ? baselineVars : {};
  const params = isPlainObjectRecord(currentParams) ? currentParams : {};
  const merged: Record<string, any> = { ...baseline, ...current };

  for (const [key, baselineEntry] of Object.entries(baseline)) {
    const currentEntry = current[key];
    if (!isPlainObjectRecord(baselineEntry) || !isPlainObjectRecord(currentEntry)) continue;

    const mergedEntry: Record<string, any> = { ...baselineEntry, ...currentEntry };
    if (isPlainObjectRecord(baselineEntry.optimize) || isPlainObjectRecord(currentEntry.optimize)) {
      mergedEntry.optimize = {
        ...(isPlainObjectRecord(baselineEntry.optimize) ? baselineEntry.optimize : {}),
        ...(isPlainObjectRecord(currentEntry.optimize) ? currentEntry.optimize : {}),
      };
    }
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      mergedEntry.value = params[key];
    }
    merged[key] = mergedEntry;
  }

  return merged;
}

function mergeBlockVariablesFromBaselineConfig(targetConfig: any, baselineConfig: any): void {
  if (!targetConfig || !baselineConfig) return;
  const targetBlocks = Array.isArray(targetConfig.blocks) ? targetConfig.blocks : null;
  const baselineBlocks = Array.isArray(baselineConfig.blocks) ? baselineConfig.blocks : null;
  if (!targetBlocks || !baselineBlocks || targetBlocks.length === 0 || baselineBlocks.length === 0) return;

  const baselineBlocksById = new Map<string, any>();
  for (const block of baselineBlocks) {
    const blockId = String(block?.blockId ?? '').trim();
    if (blockId) baselineBlocksById.set(blockId, block);
  }

  for (const block of targetBlocks) {
    const blockId = String(block?.blockId ?? '').trim();
    if (!blockId) continue;
    const baselineBlock = baselineBlocksById.get(blockId);
    if (String(block?.blockType ?? '').trim() === 'Stop') {
      normalizeFixedStopBlocksForConfiguration(targetConfig);
      continue;
    }
    if (!baselineBlock || !isPlainObjectRecord(baselineBlock.variables)) continue;
    block.variables = mergeVariableEntriesFromBaseline(block.variables, baselineBlock.variables, block.parameters);
  }
}

function mergeBlockVariablesFromBaselineSystemConfig(targetSystemConfig: any, baselineSystemConfig: any): void {
  const targetConfigs = Array.isArray(targetSystemConfig?.configurations) ? targetSystemConfig.configurations : null;
  const baselineConfigs = Array.isArray(baselineSystemConfig?.configurations) ? baselineSystemConfig.configurations : null;
  if (!targetConfigs || !baselineConfigs || targetConfigs.length === 0 || baselineConfigs.length === 0) return;

  const baselineConfigById = new Map<string, any>();
  for (const cfg of baselineConfigs) {
    const configId = String(cfg?.id ?? '').trim();
    if (configId) baselineConfigById.set(configId, cfg);
  }

  for (const cfg of targetConfigs) {
    const configId = String(cfg?.id ?? '').trim();
    if (!configId) continue;
    mergeBlockVariablesFromBaselineConfig(cfg, baselineConfigById.get(configId));
  }
}

function loadPersistedSystemConfigurationsFromStorage(): SystemConfiguration | null {
  try {
    const json = storageGetItem(STORAGE_KEY);
    if (!json) return null;
    return normalizeLoadedSystemConfiguration(JSON.parse(json) as SystemConfiguration);
  } catch (_) {
    return null;
  }
}

export function loadPersistedSystemConfigurations(): SystemConfiguration | null {
  return loadPersistedSystemConfigurationsFromStorage();
}

function normalizeLoadedSystemConfiguration(systemConfig: SystemConfiguration | null | undefined): SystemConfiguration | null {
  if (!systemConfig || typeof systemConfig !== 'object') return null;
  if (!Array.isArray(systemConfig.configurations)) return null;
  if (!Array.isArray(systemConfig.toleranceStudies)) systemConfig.toleranceStudies = [];

  for (const cfg of systemConfig.configurations) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (!cfg.metadata || typeof cfg.metadata !== 'object') cfg.metadata = {} as ConfigurationMetadata;
    if (!cfg.metadata.created) cfg.metadata.created = new Date().toISOString();
    if (!cfg.metadata.modified) cfg.metadata.modified = cfg.metadata.created;
    if (cfg.metadata.locked === undefined) cfg.metadata.locked = false;
    if (!cfg.systemData || typeof cfg.systemData !== 'object') {
      cfg.systemData = { referenceFocalLength: '' };
    }
    if (cfg.name === undefined || cfg.name === null) {
      cfg.name = `Config ${String(cfg.id ?? '') || ''}`.trim() || 'Config';
    }
    if (cfg.coherentDesign && Array.isArray(cfg.blocks) && !cfg.blocks.some((block: any) => isPhysicalBlockType(block?.blockType))) {
      const migrated = migrateLegacyCoherentDesign(normalizeCoherentAssemblyDesign(cfg.coherentDesign), cfg.blocks as any);
      cfg.blocks = migrated.blocks as any;
      cfg.designConnections = migrated.designConnections;
      delete cfg.coherentDesign;
      cfg.schemaVersion = BLOCK_SCHEMA_VERSION;
      cfg.metadata.coherentDesignMigrated = true;
      cfg.metadata.modified = new Date().toISOString();
    }
    normalizeImageSurfaceBlocksForConfiguration(cfg);
    normalizeFixedStopBlocksForConfiguration(cfg);
    backfillMissingGlassPropertiesForConfiguration(cfg);
    interpolateExplicitApertureSemidiaForConfiguration(cfg);
    normalizeLensSectionAnalysisInputs(cfg);
  }

  return systemConfig;
}

function loadRuntimeSystemConfigurations(): SystemConfiguration | null {
  try {
    const runtimeConfig = cloneSystemConfiguration<SystemConfiguration>(w.__cooptSystemConfig);
    return normalizeLoadedSystemConfiguration(runtimeConfig);
  } catch (_) {
    return null;
  }
}

function shouldPreferRuntimeSystemConfigurations(): boolean {
  try {
    return !!w.__cooptPreferRuntimeSystemConfig;
  } catch (_) {
    return false;
  }
}

function hasUsableExplicitApertureSemidia(value: any): boolean {
  const text = String(value ?? '').trim();
  if (!text || text.toLowerCase() === 'auto') return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function getOpticalRowSemidiaValue(row: any): any {
  if (!row || typeof row !== 'object') return undefined;
  return row.__cooptActualSemidia ?? row.semidia ?? row['Semi Diameter'] ?? row['semi diameter'] ?? row.semiDiameter ?? row.semiDia;
}

function normalizeImageSurfaceBlocksForConfiguration(cfg: any): void {
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.blocks)) return;

  const imageSurfaceBlocks = cfg.blocks.filter((block: any) => {
    return block && typeof block === 'object' && String(block.blockType ?? '').trim() === 'ImageSurface';
  });
  if (imageSurfaceBlocks.length <= 1) return;

  const retainedImageSurface = imageSurfaceBlocks[imageSurfaceBlocks.length - 1];
  cfg.blocks = cfg.blocks.filter((block: any) => {
    return !(block && typeof block === 'object' && String(block.blockType ?? '').trim() === 'ImageSurface');
  });
  cfg.blocks.push(retainedImageSurface);
}

function interpolateExplicitApertureSemidiaForConfiguration(cfg: any): void {
  if (!cfg || typeof cfg !== 'object') return;
  const opticalRows = Array.isArray(cfg.opticalSystem) ? cfg.opticalSystem : null;
  if (!opticalRows || opticalRows.length === 0) return;

  const explicitByProvenance = new Map<string, any>();
  try {
    if (configurationHasBlocks(cfg) && Array.isArray(cfg.blocks)) {
      const expanded = expandBlocksToOpticalSystemRows(cfg.blocks);
      const expandedRows = Array.isArray(expanded?.rows) ? expanded.rows : [];
      for (const expandedRow of expandedRows) {
        const blockId = String(expandedRow?._blockId ?? expandedRow?.blockId ?? '').trim();
        const surfaceRole = String(expandedRow?._surfaceRole ?? expandedRow?.surfaceRole ?? '').trim().toLowerCase();
        const explicit = expandedRow?.__cooptExplicitApertureSemidia;
        if (!blockId || !surfaceRole || !hasUsableExplicitApertureSemidia(explicit)) continue;
        explicitByProvenance.set(`${blockId}::${surfaceRole}`, explicit);
      }
    }
  } catch (_) {}

  for (const row of opticalRows) {
    if (!row || typeof row !== 'object') continue;
    if (hasUsableExplicitApertureSemidia(row.__cooptExplicitApertureSemidia)) continue;

    const blockId = String(row._blockId ?? row.blockId ?? '').trim();
    const surfaceRole = String(row._surfaceRole ?? row.surfaceRole ?? '').trim().toLowerCase();
    const provenanceKey = blockId && surfaceRole ? `${blockId}::${surfaceRole}` : '';
    if (provenanceKey && explicitByProvenance.has(provenanceKey)) {
      row.__cooptExplicitApertureSemidia = explicitByProvenance.get(provenanceKey);
      continue;
    }

    const blockType = String(row._blockType ?? row.blockType ?? '').trim().toLowerCase();
    if (!APERTURE_TRACKED_BLOCK_TYPES.has(blockType)) continue;

    const fallbackSemidia = getOpticalRowSemidiaValue(row);
    if (hasUsableExplicitApertureSemidia(fallbackSemidia)) {
      row.__cooptExplicitApertureSemidia = fallbackSemidia;
    }
  }
}

function hasOpticalValue(value: any): boolean {
  return String(value ?? '').trim() !== '';
}

function backfillOpticalPropertiesFromMaterial(target: any, suffix = ''): void {
  if (!target || typeof target !== 'object') return;

  const materialKey = `material${suffix}`;
  const rindexKey = `rindex${suffix}`;
  const abbeKey = `abbe${suffix}`;
  const vdKey = `vd${suffix}`;
  const material = String(target[materialKey] ?? '').trim();
  if (!material || material.toUpperCase() === 'AIR') return;

  const glass = getGlassDataWithSellmeier(material);
  if (!glass) return;

  if (!hasOpticalValue(target[rindexKey]) && Number.isFinite(glass.nd)) {
    target[rindexKey] = String(glass.nd);
  }

  if (!hasOpticalValue(target[abbeKey]) && !hasOpticalValue(target[vdKey]) && Number.isFinite(glass.vd)) {
    target[abbeKey] = String(glass.vd);
  }
}

function backfillMissingGlassPropertiesForConfiguration(cfg: any): void {
  if (!cfg || typeof cfg !== 'object') return;

  if (Array.isArray(cfg.opticalSystem)) {
    for (const row of cfg.opticalSystem) {
      backfillOpticalPropertiesFromMaterial(row);
    }
  }

  if (Array.isArray(cfg.blocks)) {
    for (const block of cfg.blocks) {
      const parameters = block?.parameters;
      if (!parameters || typeof parameters !== 'object') continue;
      backfillOpticalPropertiesFromMaterial(parameters);
      backfillOpticalPropertiesFromMaterial(parameters, '1');
      backfillOpticalPropertiesFromMaterial(parameters, '2');
      backfillOpticalPropertiesFromMaterial(parameters, '3');
    }
  }
}

interface SystemData {
  referenceFocalLength?: string | number;
  entrancePupilDiameterMm?: number | null;
  paraxialWorkingFNumber?: number | null;
}

interface ConfigurationMetadata {
  created: string;
  modified: string;
  optimizationTarget?: any;
  locked: boolean;
  coherentDesignMigrated?: boolean;
  designer?: {
    type: "human" | "ai" | "imported";
    name: string;
    confidence: number | null;
  };
}

export type LensSectionInputMode = 'route' | 'local' | 'disabled';
export type LensSectionPort = 'Front' | 'Back';

export interface AnalysisSourceSet {
  id: string;
  label: string;
  rows: any[];
}

export interface AnalysisFieldSet {
  id: string;
  label: string;
  rows: any[];
}

export interface LensSectionInputBinding {
  sectionId: string;
  port: LensSectionPort;
  mode: LensSectionInputMode;
  sourceSetId: string;
  fieldSetId: string;
}

export const DEFAULT_SOURCE_SET_ID = 'source-default';
export const DEFAULT_FIELD_SET_ID = 'field-default';
const ACTIVE_SOURCE_SET_STORAGE_PREFIX = 'coopt.analysisInput.activeSourceSet.';
const ACTIVE_FIELD_SET_STORAGE_PREFIX = 'coopt.analysisInput.activeFieldSet.';

function cloneRowsForAnalysisSet(rows: any): any[] {
  if (!Array.isArray(rows)) return [];
  try {
    return JSON.parse(JSON.stringify(rows));
  } catch (_) {
    return rows.map((row: any) => row && typeof row === 'object' ? { ...row } : row);
  }
}

function readGlobalSourceRowsForAnalysisSet(): any[] {
  try {
    const parsed = JSON.parse(storageGetItem('sourceTableData') || 'null');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/** Add named analysis inputs to legacy configurations without changing legacy analysis results. */
export function normalizeLensSectionAnalysisInputs(cfg: Configuration): Configuration {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const globalSourceRows = readGlobalSourceRowsForAnalysisSet();
  const legacySourceRows = globalSourceRows.length > 0 ? globalSourceRows : cloneRowsForAnalysisSet(cfg.source);
  const legacyFieldRows = cloneRowsForAnalysisSet(cfg.object);

  if (!Array.isArray(cfg.sourceSets) || cfg.sourceSets.length === 0) {
    cfg.sourceSets = [{ id: DEFAULT_SOURCE_SET_ID, label: 'Default source', rows: cloneRowsForAnalysisSet(legacySourceRows) }];
  } else {
    cfg.sourceSets = cfg.sourceSets
      .filter((set: any) => set && typeof set === 'object')
      .map((set: any, index: number) => ({
        id: String(set.id ?? '').trim() || `source-set-${index + 1}`,
        label: String(set.label ?? '').trim() || `Source set ${index + 1}`,
        rows: cloneRowsForAnalysisSet(set.rows)
      }));
  }
  if (!cfg.sourceSets.some((set) => set.id === DEFAULT_SOURCE_SET_ID)) {
    cfg.sourceSets.unshift({ id: DEFAULT_SOURCE_SET_ID, label: 'Default source', rows: cloneRowsForAnalysisSet(legacySourceRows) });
  }

  if (!Array.isArray(cfg.fieldSets) || cfg.fieldSets.length === 0) {
    cfg.fieldSets = [{ id: DEFAULT_FIELD_SET_ID, label: 'Default field', rows: cloneRowsForAnalysisSet(legacyFieldRows) }];
  } else {
    cfg.fieldSets = cfg.fieldSets
      .filter((set: any) => set && typeof set === 'object')
      .map((set: any, index: number) => ({
        id: String(set.id ?? '').trim() || `field-set-${index + 1}`,
        label: String(set.label ?? '').trim() || `Field set ${index + 1}`,
        rows: cloneRowsForAnalysisSet(set.rows)
      }));
  }
  if (!cfg.fieldSets.some((set) => set.id === DEFAULT_FIELD_SET_ID)) {
    cfg.fieldSets.unshift({ id: DEFAULT_FIELD_SET_ID, label: 'Default field', rows: cloneRowsForAnalysisSet(legacyFieldRows) });
  }

  const sourceIds = new Set(cfg.sourceSets.map((set) => set.id));
  const fieldIds = new Set(cfg.fieldSets.map((set) => set.id));
  cfg.lensSectionInputs = (Array.isArray(cfg.lensSectionInputs) ? cfg.lensSectionInputs : [])
    .filter((binding: any) => binding && typeof binding === 'object')
    .map((binding: any) => ({
      sectionId: String(binding.sectionId ?? '').trim() || 'main',
      port: String(binding.port ?? '').toLowerCase() === 'back' ? 'Back' : 'Front',
      mode: ['route', 'local', 'disabled'].includes(String(binding.mode ?? ''))
        ? binding.mode as LensSectionInputMode
        : 'route',
      sourceSetId: sourceIds.has(String(binding.sourceSetId ?? '')) ? String(binding.sourceSetId) : DEFAULT_SOURCE_SET_ID,
      fieldSetId: fieldIds.has(String(binding.fieldSetId ?? '')) ? String(binding.fieldSetId) : DEFAULT_FIELD_SET_ID
    }));
  return cfg;
}

export function getLensSectionInputBinding(
  cfg: Configuration,
  sectionId: string,
  port: LensSectionPort
): LensSectionInputBinding {
  normalizeLensSectionAnalysisInputs(cfg);
  const normalizedSectionId = String(sectionId ?? '').trim() || 'main';
  const existing = cfg.lensSectionInputs?.find((binding) => (
    binding.sectionId === normalizedSectionId && binding.port === port
  ));
  if (existing) return { ...existing };
  return {
    sectionId: normalizedSectionId,
    port,
    mode: normalizedSectionId === 'main' && port === 'Front' ? 'local' : 'route',
    sourceSetId: DEFAULT_SOURCE_SET_ID,
    fieldSetId: DEFAULT_FIELD_SET_ID
  };
}

export function setLensSectionInputBinding(cfg: Configuration, next: LensSectionInputBinding): void {
  normalizeLensSectionAnalysisInputs(cfg);
  const normalized: LensSectionInputBinding = {
    ...getLensSectionInputBinding(cfg, next.sectionId, next.port),
    ...next,
    sectionId: String(next.sectionId ?? '').trim() || 'main',
    port: next.port === 'Back' ? 'Back' : 'Front'
  };
  cfg.lensSectionInputs = (cfg.lensSectionInputs ?? []).filter((binding) => !(
    binding.sectionId === normalized.sectionId && binding.port === normalized.port
  ));
  cfg.lensSectionInputs.push(normalized);
}

export function resolveLensSectionAnalysisInput(
  cfg: Configuration,
  sectionId: string,
  port: LensSectionPort
): LensSectionInputBinding & { sourceRows: any[]; fieldRows: any[] } {
  normalizeLensSectionAnalysisInputs(cfg);
  const binding = getLensSectionInputBinding(cfg, sectionId, port);
  const sourceSet = cfg.sourceSets?.find((set) => set.id === binding.sourceSetId) ?? cfg.sourceSets?.[0];
  const fieldSet = cfg.fieldSets?.find((set) => set.id === binding.fieldSetId) ?? cfg.fieldSets?.[0];
  return {
    ...binding,
    sourceRows: cloneRowsForAnalysisSet(sourceSet?.rows),
    fieldRows: cloneRowsForAnalysisSet(fieldSet?.rows)
  };
}

export function getActiveAnalysisSetId(kind: 'source' | 'field', cfg: Configuration): string {
  normalizeLensSectionAnalysisInputs(cfg);
  const prefix = kind === 'source' ? ACTIVE_SOURCE_SET_STORAGE_PREFIX : ACTIVE_FIELD_SET_STORAGE_PREFIX;
  const fallback = kind === 'source' ? DEFAULT_SOURCE_SET_ID : DEFAULT_FIELD_SET_ID;
  const sets = kind === 'source' ? cfg.sourceSets! : cfg.fieldSets!;
  const stored = String(storageGetItem(`${prefix}${String(cfg.id)}`) ?? '').trim();
  return sets.some((set) => set.id === stored) ? stored : fallback;
}

export function setActiveAnalysisSetId(kind: 'source' | 'field', cfg: Configuration, setId: string): void {
  const prefix = kind === 'source' ? ACTIVE_SOURCE_SET_STORAGE_PREFIX : ACTIVE_FIELD_SET_STORAGE_PREFIX;
  storageSetItem(`${prefix}${String(cfg.id)}`, String(setId));
}

export function persistRowsToActiveAnalysisSet(kind: 'source' | 'field', rows: any[]): void {
  try {
    const systemConfig = loadSystemConfigurations();
    const cfg = systemConfig.configurations.find((entry) => idsEqual(entry?.id, systemConfig.activeConfigId));
    if (!cfg) return;
    normalizeLensSectionAnalysisInputs(cfg);
    const activeSetId = getActiveAnalysisSetId(kind, cfg);
    const sets = kind === 'source' ? cfg.sourceSets! : cfg.fieldSets!;
    const target = sets.find((set) => set.id === activeSetId) ?? sets[0];
    if (target) target.rows = cloneRowsForAnalysisSet(rows);
    if (kind === 'source') cfg.source = cloneRowsForAnalysisSet(rows);
    else cfg.object = cloneRowsForAnalysisSet(rows);
    cfg.metadata.modified = new Date().toISOString();
    saveSystemConfigurations(systemConfig);
  } catch (_) {}
}

export interface Configuration {
  id: number | string;
  name: string;
  schemaVersion: string;
  blocks: Block[];
  source: any[];
  object: any[];
  opticalSystem: any[];
  systemData: SystemData;
  metadata: ConfigurationMetadata;
  meritFunction?: any[];
  scenarios?: any[];
  activeScenarioId?: string | number;
  /** Normal UI uses scene-derived routing; saved Port paths remain an advanced compatibility mode. */
  assemblyRoutingMode?: 'automatic-scene' | 'engineered-paths';
  /** Port graph for physical assembly blocks stored in blocks[]. */
  designConnections?: DesignConnection[];
  /** Saved, deterministic connection traversal order for Hybrid analyses. */
  portRoutes?: PortRoute[];
  /** Measurement/reference routes grouped by receiving detector. */
  routeSets?: PortRouteSet[];
  /** Named exact sequential sections addressable from the Hybrid port graph. */
  sequentialGroups?: Array<{
    id: string;
    label: string;
    blockIds: string[];
    pathLabel?: string;
    rootTransform?: {
      positionMm: { x: number; y: number; z: number };
      rotationDeg: { x: number; y: number; z: number };
    };
    rootTransformVariables?: Partial<Record<
      'positionX' | 'positionY' | 'positionZ' | 'rotationX' | 'rotationY' | 'rotationZ',
      { value?: number; optimize?: { mode?: 'F' | 'V'; min?: number; max?: number; scale?: number } }
    >>;
  }>;
  /** Named wavelength tables selectable by Lens design launch profiles. */
  sourceSets?: AnalysisSourceSet[];
  /** Named object/field tables selectable by Lens design launch profiles. */
  fieldSets?: AnalysisFieldSet[];
  /** Front/Back launch behavior for standalone and port-routed section analysis. */
  lensSectionInputs?: LensSectionInputBinding[];
  /** Legacy 0.1 assembly snapshot; migrated into blocks[] on load. */
  coherentDesign?: CoherentAssemblyDesign;
}

export interface SystemConfiguration {
  configurations: Configuration[];
  activeConfigId: number | string;
  meritFunction: any[];
  systemRequirements: any[];
  /** Saved sensitivity/tolerance studies; Requirements remain the pass/fail specification. */
  toleranceStudies?: any[];
  optimizationRules: Record<string, any>;
}

interface ConfigurationListItem {
  id: number | string;
  name: string;
  active: boolean;
  created: string;
  modified: string;
  locked: boolean;
  coherentDesignMigrated?: boolean;
}

interface LoadConfigurationOptions {
  applyToUI?: boolean;
  suppressOpticalSystemDataChanged?: boolean;
}

// 初期Configuration構造
function createDefaultConfiguration(id: number, name: string): Configuration {
  const defaultBlocks: Block[] = [
    {
      blockId: 'ObjectSurface-1',
      blockType: 'ObjectSurface',
      role: null,
      constraints: {},
      parameters: {
        objectDistanceMode: 'INF',
        objectDistance: 10
      },
      variables: {},
      metadata: { source: 'default' }
    },
    {
      blockId: 'Stop-1',
      blockType: 'Stop',
      role: null,
      constraints: {},
      parameters: {
        semiDiameter: DEFAULT_STOP_SEMI_DIAMETER
      },
      variables: {},
      metadata: { source: 'default' }
    },
    {
      blockId: 'ImageSurface-1',
      blockType: 'ImageSurface',
      role: null,
      constraints: {},
      parameters: { semidiaMode: 'Manual' },
      variables: {},
      metadata: { source: 'default' }
    }
  ];

  return {
    id: id,
    name: name,
    // Block schema (canonical for AI designs; optional during transition)
    schemaVersion: BLOCK_SCHEMA_VERSION,
    blocks: defaultBlocks,
    assemblyRoutingMode: 'automatic-scene',
    source: [
      { id: 1, wavelength: 0.4358343, weight: 1, primary: '', angle: 0 },
      { id: 2, wavelength: 0.5875618, weight: 1, primary: 'Primary Wavelength', angle: 0 },
      { id: 3, wavelength: 0.6562725, weight: 1, primary: '', angle: 0 }
    ],
    object: [
      { id: 1, xHeightAngle: 0, yHeightAngle: 0, position: 'Angle', angle: 0 },
      { id: 2, xHeightAngle: 0, yHeightAngle: 17.05, position: 'Angle', angle: 0 }
    ],
    opticalSystem: [],
    // meritFunctionは各configから削除（グローバルに移動）
    systemData: {
      referenceFocalLength: '' // 空文字列は "Auto" を意味する
    },
    metadata: {
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      optimizationTarget: null,  // 将来のAI最適化用
      locked: false,
      designer: {
        type: "human",  // "human" | "ai" | "imported"
        name: "user",   // user name or "GPT" or "patent" etc.
        confidence: null  // AI confidence score (0-1) or null for human/imported
      }
    }
  };
}

// システム全体のConfiguration状態を管理
const defaultSystemConfig: SystemConfiguration = {
  configurations: [
    createDefaultConfiguration(1, "Config 1")
  ],
  activeConfigId: 1,
  meritFunction: [],  // グローバルなMerit Function（全configで共有、各行にconfigId指定）
  systemRequirements: [], // グローバルなSystem Requirements（全configで共有、各行にconfigId指定）
  toleranceStudies: [],
  optimizationRules: {}  // フェーズ4用（空で準備）
};

// localStorageからConfiguration全体を読み込み
export function loadSystemConfigurations(): SystemConfiguration {
  cfgLog('🔵 [Configuration] Loading system configurations from localStorage...');
  const runtimeConfig = loadRuntimeSystemConfigurations();
  if (shouldPreferRuntimeSystemConfigurations() && runtimeConfig) {
    cfgLog('🔵 [Configuration] Using runtime system config override');
    return runtimeConfig;
  }

  const json = storageGetItem(STORAGE_KEY);
  
  if (json) {
    try {
      const parsed = normalizeLoadedSystemConfiguration(JSON.parse(json) as SystemConfiguration);
      if (!parsed) throw new Error('Invalid persisted system config');
      cfgLog('🔵 [Configuration] Loaded configurations:', parsed.configurations.length);
      return parsed;
    } catch (e) {
      console.error('❌ [Configuration] Parse error; using default system config:', e);
    }
  }

  if (runtimeConfig) {
    cfgLog('🔵 [Configuration] Falling back to runtime system config');
    return runtimeConfig;
  }
  
  cfgLog('🔵 [Configuration] Using default system config');
  return defaultSystemConfig;
}

// Configuration全体を保存
export function saveSystemConfigurations(systemConfig: SystemConfiguration): void {
  cfgLog('🔵 [Configuration] Saving system configurations...');
  if (systemConfig && systemConfig.configurations) {
    let configToSave: SystemConfiguration = systemConfig;
    let persistedConfigForGuard: SystemConfiguration | null = null;

    try {
      const runtimeConfig = loadRuntimeSystemConfigurations();
      if (runtimeConfig) mergeBlockVariablesFromBaselineSystemConfig(systemConfig, runtimeConfig);
    } catch (_) {
      // ignore
    }
    try {
      const persistedConfig = loadPersistedSystemConfigurationsFromStorage();
      persistedConfigForGuard = persistedConfig;
      if (persistedConfig) mergeBlockVariablesFromBaselineSystemConfig(systemConfig, persistedConfig);
    } catch (_) {
      // ignore
    }
    try {
      if (
        persistedConfigForGuard
        && isPlaceholderThreeBlockSystemConfig(systemConfig)
        && hasRicherThanPlaceholderContent(persistedConfigForGuard)
      ) {
        cfgWarn('⚠️ [Configuration] Prevented placeholder overwrite of richer persisted configuration.');
        configToSave = persistedConfigForGuard;
      }
    } catch (_) {
      // ignore guard errors
    }
    try {
      for (const cfg of configToSave.configurations) {
        normalizeImageSurfaceBlocksForConfiguration(cfg);
        normalizeFixedStopBlocksForConfiguration(cfg);
        interpolateExplicitApertureSemidiaForConfiguration(cfg);
        normalizeLensSectionAnalysisInputs(cfg);
      }
    } catch (_) {}
    try {
      w.__cooptSystemConfig = cloneSystemConfiguration(configToSave) ?? configToSave;
    } catch (_) {
      // ignore
    }
    storageSetItem(STORAGE_KEY, JSON.stringify(configToSave));
    cfgLog(`💾 [Configuration] Saved ${configToSave.configurations.length} configurations`);
  } else {
    console.error('❌ [Configuration] Invalid system config, not saving:', systemConfig);
  }
}

// Projection cache helpers (legacy localStorage keys)
// Keep these in one place so other modules don't touch localStorage keys directly.
export function clearObjectTableDataProjection(): void {
  try {
    storageRemoveItem('objectTableData');
  } catch (_) {
    // ignore
  }
}

export function loadSystemDataProjection(): SystemData {
  try {
    const json = storageGetItem('systemData');
    if (!json) return { referenceFocalLength: '' };
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return { referenceFocalLength: '' };
    return {
      referenceFocalLength: (parsed as any).referenceFocalLength ?? ''
    };
  } catch (_) {
    return { referenceFocalLength: '' };
  }
}

export function saveSystemDataProjection(data: SystemData): void {
  try {
    storageSetItem('systemData', JSON.stringify({
      referenceFocalLength: data?.referenceFocalLength ?? ''
    }));
  } catch (_) {
    // ignore
  }
}

export function saveReferenceFocalLengthProjection(value: string | number): void {
  saveSystemDataProjection({ referenceFocalLength: value });
}

export function clearAllPersistedState(): void {
  try {
    const keys = [
      'systemConfigurations',
      'sourceTableData',
      'objectTableData',
      'OpticalSystemTableData',
      'meritFunctionData',
      'systemRequirementsData',
      'systemData',
      'spotDiagramSettingsByConfigId',
      'spotDiagramPattern',
      'loadedFileName',
      'loadedFileWarn',
      'toolbarCollapsed',
      'lastWavefrontSnapshot',
      'lastPsfMeta',
      'lastPsfError',
      'lastSpotDiagramSettings',
      'lastSpotSettings',
      'coopt.renderSyncRequest',
      'coopt.autoRecoverDefaultLensData.v1',
      'coopt.forceInfinitePupilMode',
      'coopt.glassMap.defaultManufacturers',
      'coopt.darkMode'
    ];
    for (const key of keys) {
      try { storageRemoveItem(key); } catch (_) {}
    }
  } catch (_) {
    // ignore
  }
  try { delete w.__cooptSystemConfig; } catch (_) {}
  try { delete w.__cooptPreferRuntimeSystemConfig; } catch (_) {}
  try { delete w.__cooptLoadedFileNameRuntime; } catch (_) {}
  try { delete w.__cooptLoadedFileWarnRuntime; } catch (_) {}
}

// Legacy/non-module callers (index.html inline scripts)
try {
  if (!w.__cooptSystemDataProjection) {
    w.__cooptSystemDataProjection = {
      loadSystemDataProjection,
      saveSystemDataProjection,
      saveReferenceFocalLengthProjection,
      clearAllPersistedState
    };
  }
} catch (_) {
  // ignore
}

// アクティブなConfigurationを取得
export function getActiveConfiguration(): Configuration {
  const systemConfig = loadSystemConfigurations();
  const activeConfig = systemConfig.configurations.find(c => idsEqual(c?.id, systemConfig.activeConfigId));
  
  if (!activeConfig) {
    if (!warnedActiveConfigNotFound) {
      console.warn('⚠️ [Configuration] Active config not found, using first');
      warnedActiveConfigNotFound = true;
    }
    return systemConfig.configurations[0];
  }
  
  return activeConfig;
}

// アクティブなConfiguration IDを取得
export function getActiveConfigId(): number | string {
  const systemConfig = loadSystemConfigurations();
  return systemConfig.activeConfigId;
}

// アクティブなConfigurationを変更
export function setActiveConfiguration(configId: number | string): boolean {
  const systemConfig = loadSystemConfigurations();
  const config = systemConfig.configurations.find(c => idsEqual(c?.id, configId));
  
  if (!config) {
    console.error('❌ [Configuration] Config not found:', configId);
    return false;
  }
  
  // Preserve the config's id type (string/number) to avoid strict-equality mismatches.
  systemConfig.activeConfigId = config.id;
  saveSystemConfigurations(systemConfig);
  cfgLog(`✅ [Configuration] Active config changed to: ${config.name}`);
  return true;
}

// 現在のテーブルデータをアクティブなConfigurationに保存
export function saveCurrentToActiveConfiguration(options: SaveConfigurationOptions = {}): void {
  cfgLog('🔵 [Configuration] Saving current table data to active configuration...');
  
  let systemConfig = loadSystemConfigurations();
  let activeConfig = systemConfig.configurations.find(c => idsEqual(c?.id, systemConfig.activeConfigId));
  
  if (!activeConfig) {
    console.error('❌ [Configuration] Active config not found');
    return;
  }
  
  // 各テーブルからデータを取得
  // Source/Field tables edit the currently selected named sets in this config.
  normalizeLensSectionAnalysisInputs(activeConfig);
  try {
    const globalSource = w.tableSource ? w.tableSource.getData() : [];
    storageSetItem('sourceTableData', JSON.stringify(globalSource));
    const activeSourceSet = activeConfig.sourceSets?.find((set) => set.id === getActiveAnalysisSetId('source', activeConfig));
    if (activeSourceSet && Array.isArray(globalSource)) activeSourceSet.rows = cloneRowsForAnalysisSet(globalSource);
    if (Array.isArray(globalSource)) activeConfig.source = cloneRowsForAnalysisSet(globalSource);
  } catch (_) {}
  
  // Do not wipe object rows when this window does not host the Object table
  // (e.g. optimize/render child windows).
  const objectDataFromTable = (w.tableObject && typeof w.tableObject.getData === 'function')
    ? w.tableObject.getData()
    : null;
  if (Array.isArray(objectDataFromTable)) {
    activeConfig.object = objectDataFromTable;
    const activeFieldSet = activeConfig.fieldSets?.find((set) => set.id === getActiveAnalysisSetId('field', activeConfig));
    if (activeFieldSet) activeFieldSet.rows = cloneRowsForAnalysisSet(objectDataFromTable);
  }

  // Expanded Optical System is derived from Blocks.
  // When Blocks exist, do NOT overwrite config.opticalSystem from the (disabled/no-op) surface table.
  const opticalRowsFromTable = (() => {
    try {
      if (typeof w.getOpticalSystemRows === 'function') {
        const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
        if (Array.isArray(rows)) return rows;
      }
    } catch (_) {}
    try {
      if (w.tableOpticalSystem && typeof w.tableOpticalSystem.getData === 'function') {
        const rows = w.tableOpticalSystem.getData();
        if (Array.isArray(rows)) return rows;
      }
    } catch (_) {}
    return [];
  })();
  if (!configurationHasBlocks(activeConfig) || shouldPreferImportedOpticalRows(activeConfig)) {
    activeConfig.opticalSystem = opticalRowsFromTable;
  } else {
    try {
      if (options.syncExpandedRowsToBlocks !== false && Array.isArray(opticalRowsFromTable) && opticalRowsFromTable.length > 0 && typeof w.__cooptSyncRowsBackToActiveBlocks === 'function') {
        const clonedRows = cloneSystemConfiguration<any[]>(opticalRowsFromTable) ?? opticalRowsFromTable;
        const clonedObjectRows = Array.isArray(objectDataFromTable)
          ? (cloneSystemConfiguration<any[]>(objectDataFromTable) ?? objectDataFromTable)
          : undefined;
        w.__cooptSyncRowsBackToActiveBlocks(clonedRows, clonedObjectRows);
        systemConfig = loadSystemConfigurations();
        activeConfig = systemConfig.configurations.find(c => idsEqual(c?.id, systemConfig.activeConfigId));
        if (!activeConfig) {
          console.error('❌ [Configuration] Active config not found after sync');
          return;
        }
      }
      const expanded = expandBlocksToOpticalSystemRows(activeConfig.blocks);
      if (Array.isArray(expanded?.rows)) {
        activeConfig.opticalSystem = expanded.rows;
      }
    } catch (_) {}
  }
  
  // Merit/Requirements are global. Preserve the current persisted values when the
  // current window does not host those editors (e.g. optimize/render child windows).
  if (w.meritFunctionEditor && typeof w.meritFunctionEditor.getData === 'function') {
    const meritRows = w.meritFunctionEditor.getData();
    if (Array.isArray(meritRows)) {
      systemConfig.meritFunction = meritRows;
    }
  }

  if (w.systemRequirementsEditor && typeof w.systemRequirementsEditor.getData === 'function') {
    const requirementRows = w.systemRequirementsEditor.getData();
    if (Array.isArray(requirementRows)) {
      systemConfig.systemRequirements = requirementRows;
    }
  }
  
  // System Data を保存（localStorageとconfigの両方）
  const refFLInput = document.getElementById('reference-focal-length') as HTMLInputElement | null;
  if (!activeConfig.systemData) {
    activeConfig.systemData = {};
  }
  activeConfig.systemData.referenceFocalLength = refFLInput ? refFLInput.value : '';
  
  // localStorageにも保存
  saveSystemDataProjection(activeConfig.systemData);
  
  // メタデータ更新
  activeConfig.metadata.modified = new Date().toISOString();
  
  saveSystemConfigurations(systemConfig);
}

// アクティブなConfigurationのデータをlocalStorageに展開（各テーブル用）
export async function loadActiveConfigurationToTables(options: LoadConfigurationOptions = {}): Promise<void> {
  // Persist any pending debounced surface-edit -> blocks sync BEFORE we read and
  // re-expand the blocks below. Blocks are canonical, so if a recent edit (e.g. a
  // Qcon->Spherical surfType change) is still sitting in the 120ms debounce, the
  // re-expansion here would regenerate the surface rows from the stale block and
  // the pending timer would then write that reverted value back, discarding the
  // edit. Flushing first guarantees the edit reaches the block before re-expand.
  try {
    const flushWindows: any[] = [];
    const currentWin: any = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : null);
    if (currentWin) flushWindows.push(currentWin);
    try {
      const openerWin = currentWin?.opener;
      if (openerWin && !openerWin.closed && !flushWindows.includes(openerWin)) flushWindows.push(openerWin);
    } catch (_) {}
    for (const flushWin of flushWindows) {
      try {
        if (flushWin && typeof flushWin.__cooptFlushPendingRowsToBlocks === 'function') {
          flushWin.__cooptFlushPendingRowsToBlocks();
        }
      } catch (_) {}
    }
  } catch (_) {}

  const systemConfig = loadSystemConfigurations();
  // IMPORTANT: Use the active config object from this `systemConfig` instance.
  // Calling getActiveConfiguration() would reload from localStorage and return a different object,
  // so in-place mutations (e.g. auto-assigning blockId) would not persist when saving.
  const activeConfig = systemConfig.configurations.find(c => idsEqual(c?.id, systemConfig.activeConfigId)) || systemConfig.configurations[0];
  
  if (!activeConfig) {
    console.error('❌ [Configuration] No active config found');
    return;
  }

  // Normalize legacy blockType values before validation
  try {
    if (Array.isArray(activeConfig.blocks)) {
      for (const b of activeConfig.blocks) {
        if (!b || typeof b !== 'object') continue;
        const t = String((b as any).blockType ?? '').trim();
        if (t === 'ImagePlane') (b as any).blockType = 'ImageSurface';
        else if (t === 'ObjectPlane') (b as any).blockType = 'ObjectSurface';
        else if (t === 'AirGap') (b as any).blockType = 'Gap';
      }
    }
  } catch (_) {}

  // If the active config uses blocks, deterministically expand to legacy surface rows for UI/evaluation.
  const preferImportedOpticalRows = shouldPreferImportedOpticalRows(activeConfig);
  normalizeLensSectionAnalysisInputs(activeConfig);
  const activeSourceSet = activeConfig.sourceSets?.find((set) => set.id === getActiveAnalysisSetId('source', activeConfig))
    ?? activeConfig.sourceSets?.[0];
  const activeFieldSet = activeConfig.fieldSets?.find((set) => set.id === getActiveAnalysisSetId('field', activeConfig))
    ?? activeConfig.fieldSets?.[0];
  const activeSourceRows = cloneRowsForAnalysisSet(activeSourceSet?.rows ?? activeConfig.source);
  const activeFieldRows = cloneRowsForAnalysisSet(activeFieldSet?.rows ?? activeConfig.object);
  let effectiveOpticalSystem = activeConfig.opticalSystem;
  if (configurationHasBlocks(activeConfig) && !preferImportedOpticalRows) {
    const normalizeIdsInPlace = (rows: any[]): void => {
      if (!Array.isArray(rows)) return;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i] && typeof rows[i] === 'object') rows[i].id = i;
      }
    };

    // Ensure every block has a stable id so expanded rows carry provenance (_blockId).
    const ensureBlocksHaveBlockIdsInPlace = (blocks: Block[]): number => {
      if (!Array.isArray(blocks)) return 0;
      const used = new Set<string>();
      for (const b of blocks) {
        const id = typeof b?.blockId === 'string' ? b.blockId.trim() : '';
        if (id) used.add(id);
      }
      let assigned = 0;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (!b || typeof b !== 'object') continue;
        const raw = typeof b.blockId === 'string' ? b.blockId.trim() : '';
        if (raw) continue;
        const type = String(b.blockType || 'Block').trim() || 'Block';
        const base = `${type}-${i + 1}`;
        let id = base;
        let suffix = 2;
        while (used.has(id)) {
          id = `${base}-${suffix++}`;
        }
        b.blockId = id;
        used.add(id);
        assigned++;
      }
      return assigned;
    };

    try {
      const assigned = ensureBlocksHaveBlockIdsInPlace(activeConfig.blocks);
      if (assigned > 0) {
        cfgWarn(`⚠️ [Configuration] ${assigned} blocks were missing blockId; auto-assigned for provenance.`);
        try {
          if (!activeConfig.metadata) activeConfig.metadata = {} as ConfigurationMetadata;
          activeConfig.metadata.modified = new Date().toISOString();
        } catch (_) {}
        saveSystemConfigurations(systemConfig);
      }
    } catch (e) {
      cfgWarn('⚠️ [Configuration] Failed to ensure blockId for blocks:', e);
    }

    const issues = validateBlocksConfiguration(activeConfig);
    const fatals = issues.filter(i => i && i.severity === 'fatal');
    const warnings = issues.filter(i => i && i.severity === 'warning');

    for (const w of warnings) cfgWarn('⚠️ [Configuration] Block validation warning:', w);
    if (fatals.length > 0) {
      for (const f of fatals) {
        const msg = (f && typeof f === 'object' && 'message' in f) ? (f as any).message : String(f);
        const bid = (f && typeof f === 'object' && (f as any).blockId) ? ` [blockId=${(f as any).blockId}]` : '';
        const key = `${String((f as any)?.blockId ?? '')}::${String(msg)}`;
        if (!loggedBlockValidationFatalKeys.has(key)) {
          loggedBlockValidationFatalKeys.add(key);
          console.error(`❌ [Configuration] Block validation error${bid}: ${msg}`, f);
        }
      }
      // Keep legacy opticalSystem as-is to avoid breaking the UI.
    } else {
      // Re-apply thicknessMode (IMD/BFL) using this config's own paraxial data.
      // Ensures each config gets its own independently computed value on config switch.
      let expandedRowsForUi: { rows: any[]; issues: LoadIssue[] } | null = null;
      try {
        const hasThicknessMode = Array.isArray(activeConfig.blocks) && (activeConfig.blocks as any[]).some((b: any) => {
          const m = String(b?.parameters?.thicknessMode ?? '').trim().toUpperCase();
          return m === 'IMD' || m === 'BFL';
        });
        if (hasThicknessMode) {
          const wl = (() => { try { const v = Number(getPrimaryWavelength()); return (Number.isFinite(v) && v > 0) ? v : 0.5876; } catch(_) { return 0.5876; } })();
          const probeExpanded = expandBlocksToOpticalSystemRows(activeConfig.blocks);
          const probeRows = probeExpanded?.rows;
          if (Array.isArray(probeRows) && probeRows.length > 0) {
            const paraxial = calculateParaxialData(probeRows, wl);
            if (paraxial) {
              let mutated = false;
              const getBlockParamValue = (block: any, key: string): any => {
                const vars = block?.variables;
                const variableEntry = vars && typeof vars === 'object' ? vars[key] : undefined;
                if (variableEntry && typeof variableEntry === 'object' && Object.prototype.hasOwnProperty.call(variableEntry, 'value')) {
                  return variableEntry.value;
                }
                const params = block?.parameters;
                return params && typeof params === 'object' ? params[key] : undefined;
              };
              for (const block of activeConfig.blocks as any[]) {
                if (!block || typeof block !== 'object') continue;
                const bt = String((block as any).blockType ?? '').trim();
                if (bt !== 'Gap' && bt !== 'AirGap') continue;
                const params = (block as any).parameters;
                if (!params) continue;
                const mode = String(params.thicknessMode ?? '').trim().toUpperCase();
                if (mode !== 'IMD' && mode !== 'BFL') continue;
                const reducedDistance = Number(mode === 'IMD' ? paraxial.imageDistance : paraxial.backFocalLength);
                if (!Number.isFinite(reducedDistance)) continue;
                const gapRefractiveIndex = Number(getRefractiveIndex({
                  material: getBlockParamValue(block, 'material'),
                  rindex: getBlockParamValue(block, 'rindex'),
                  abbe: getBlockParamValue(block, 'abbe'),
                }, wl));
                const mediumScale = (Number.isFinite(gapRefractiveIndex) && gapRefractiveIndex > 0)
                  ? gapRefractiveIndex
                  : 1;
                const target = reducedDistance * mediumScale;
                if (!Number.isFinite(target)) continue;
                if (Number.isFinite(Number(params.thickness)) && Math.abs(Number(params.thickness) - target) <= 1e-9) continue;
                params.thickness = target;
                if ((block as any).variables?.thickness && typeof (block as any).variables.thickness === 'object' && 'value' in (block as any).variables.thickness) {
                  (block as any).variables.thickness.value = target;
                }
                mutated = true;
              }
              if (mutated) {
                try { if (!(activeConfig as any).metadata) (activeConfig as any).metadata = {}; (activeConfig as any).metadata.modified = new Date().toISOString(); } catch(_) {}
                saveSystemConfigurations(systemConfig);
              } else {
                expandedRowsForUi = probeExpanded;
              }
            } else {
              expandedRowsForUi = probeExpanded;
            }
          } else {
            expandedRowsForUi = probeExpanded;
          }
        }
      } catch (_) {}
      const expanded = expandedRowsForUi ?? expandBlocksToOpticalSystemRows(activeConfig.blocks);
      for (const w of expanded.issues.filter(i => i && i.severity === 'warning')) cfgWarn('⚠️ [Configuration] Block expand warning:', w);
      const expandFatals = expanded.issues.filter(i => i && i.severity === 'fatal');
      if (expandFatals.length > 0) {
        for (const f of expandFatals) console.error('❌ [Configuration] Block expand error:', f);
      } else {
        normalizeIdsInPlace(expanded.rows);
        effectiveOpticalSystem = expanded.rows;
      }
    }
  }
  
  // 各テーブルのlocalStorageに書き込み
  // Project the currently edited named sets into the legacy Source/Field tables.
  // Old configurations have one synthesized default set, so their behavior is unchanged.
  try {
    storageSetItem('sourceTableData', JSON.stringify(activeSourceRows));
  } catch (_) {}
  storageSetItem('objectTableData', JSON.stringify(activeFieldRows));
  if (effectiveOpticalSystem) {
    if (configurationHasBlocks(activeConfig) && !preferImportedOpticalRows) {
      // Blocks-only evaluation path should not persist Expanded Optical System rows.
      // This avoids drift between Design Intent and any stale surface-table snapshots.
      try { storageRemoveItem('OpticalSystemTableData'); } catch (_) {}
    } else {
      storageSetItem('OpticalSystemTableData', JSON.stringify(effectiveOpticalSystem));
    }
  }
  
  // Merit Function はグローバルから読み込み
  if (systemConfig.meritFunction) {
    storageSetItem('meritFunctionData', JSON.stringify(systemConfig.meritFunction));
  }

  // System Requirements are global. Do not let an empty global array wipe an existing
  // persisted table cache during startup before migration/editor initialization completes.
  if (Array.isArray(systemConfig.systemRequirements) && systemConfig.systemRequirements.length > 0) {
    storageSetItem('systemRequirementsData', JSON.stringify(systemConfig.systemRequirements));
  } else {
    try {
      const persistedRequirements = tryLoadPersistedSystemRequirementsTableData();
      if (!Array.isArray(persistedRequirements)) {
        storageSetItem('systemRequirementsData', JSON.stringify([]));
      }
    } catch (_) {
      storageSetItem('systemRequirementsData', JSON.stringify([]));
    }
  }
  
  // System Data をlocalStorageに保存（リロード後も復元できるように）
  if (activeConfig.systemData) {
    saveSystemDataProjection(activeConfig.systemData);
  } else {
    saveSystemDataProjection({ referenceFocalLength: '' });
  }

  // Optional: apply to already-initialized UI (avoids full reload)
  if (options && options.applyToUI) {
    const suppressOpticalSystemDataChanged = (enabled: boolean): void => {
      const key = '__suppressOpticalSystemDataChangedDepth';
      const depth = Number(w[key] || 0);
      if (enabled) {
        w[key] = depth + 1;
        w.__suppressOpticalSystemDataChanged = true;
        return;
      }
      const next = Math.max(0, depth - 1);
      w[key] = next;
      w.__suppressOpticalSystemDataChanged = next > 0;
    };

    const applyTableData = async (table: any, data: any[]): Promise<void> => {
      if (!table || !Array.isArray(data)) {
        return;
      }
      try {
        if (typeof table.blockRedraw === 'function') table.blockRedraw();

        const isOpticalSystemTable = table === w.tableOpticalSystem;
        const shouldSuppress = !!(options && options.suppressOpticalSystemDataChanged && isOpticalSystemTable);
        if (shouldSuppress) {
          suppressOpticalSystemDataChanged(true);
        }

        if (typeof table.replaceData === 'function') {
          await table.replaceData(data);
        } else if (typeof table.setData === 'function') {
          await table.setData(data);
        }

        if (typeof table.redraw === 'function') table.redraw(true);
      } catch (e) {
        cfgWarn('⚠️ [Configuration] Failed to apply table data:', e);
      } finally {
        if (table === w.tableOpticalSystem) {
          // Release on next tick so async Tabulator events (dataChanged) are still suppressed.
          setTimeout(() => suppressOpticalSystemDataChanged(false), 0);
        }
        if (typeof table.restoreRedraw === 'function') table.restoreRedraw();
      }
    };

    // Update tabulator tables if present
    await applyTableData(w.tableSource, activeSourceRows);
    await applyTableData(w.tableObject, activeFieldRows);
    await applyTableData(w.tableOpticalSystem, effectiveOpticalSystem || []);

    // Update system data input (reference focal length)
    try {
      const refFLInput = document.getElementById('reference-focal-length') as HTMLInputElement | null;
      if (refFLInput) {
        refFLInput.value = activeConfig.systemData?.referenceFocalLength?.toString() ?? '';
      }
    } catch (_) {}
  }
  
  cfgLog(`✅ [Configuration] Loaded: ${activeConfig.name}`);
}

// 新しいConfigurationを追加
export function addConfiguration(name: string): number {
  const systemConfig = loadSystemConfigurations();
  
  // 新しいID生成（最大ID + 1）
  const maxId = Math.max(...systemConfig.configurations.map(c => Number(c.id) || 0), 0);
  const newId = maxId + 1;
  
  const newConfig = createDefaultConfiguration(newId, name);
  
  // 現在のアクティブなConfigurationのデータをコピー
  const activeConfig = getActiveConfiguration();
  if (activeConfig) {
    newConfig.blocks = JSON.parse(JSON.stringify(activeConfig.blocks ?? []));
    newConfig.source = JSON.parse(JSON.stringify(activeConfig.source ?? []));
    newConfig.object = JSON.parse(JSON.stringify(activeConfig.object ?? []));
    newConfig.opticalSystem = JSON.parse(JSON.stringify(activeConfig.opticalSystem ?? []));
    newConfig.systemData = JSON.parse(JSON.stringify(activeConfig.systemData ?? { referenceFocalLength: '' }));
    newConfig.designConnections = JSON.parse(JSON.stringify(activeConfig.designConnections ?? []));
    newConfig.sequentialGroups = JSON.parse(JSON.stringify(activeConfig.sequentialGroups ?? []));
    newConfig.sourceSets = JSON.parse(JSON.stringify(activeConfig.sourceSets ?? []));
    newConfig.fieldSets = JSON.parse(JSON.stringify(activeConfig.fieldSets ?? []));
    newConfig.lensSectionInputs = JSON.parse(JSON.stringify(activeConfig.lensSectionInputs ?? []));
    newConfig.portRoutes = JSON.parse(JSON.stringify(activeConfig.portRoutes ?? []));
    newConfig.routeSets = JSON.parse(JSON.stringify(activeConfig.routeSets ?? []));
    if (activeConfig.coherentDesign) {
      newConfig.coherentDesign = JSON.parse(JSON.stringify(activeConfig.coherentDesign));
    }
    if (activeConfig.meritFunction) {
      newConfig.meritFunction = JSON.parse(JSON.stringify(activeConfig.meritFunction));
    }
  }
  
  systemConfig.configurations.push(newConfig);
  saveSystemConfigurations(systemConfig);
  
  cfgLog(`✅ [Configuration] Added new configuration: ${name} (ID: ${newId})`);
  return newId;
}

// Configurationを削除
export function deleteConfiguration(configId: number | string): boolean {
  const systemConfig = loadSystemConfigurations();
  
  // 最後の1つは削除不可
  if (systemConfig.configurations.length <= 1) {
    cfgWarn('⚠️ [Configuration] Cannot delete last configuration');
    return false;
  }
  
  const index = systemConfig.configurations.findIndex(c => idsEqual(c?.id, configId));
  
  if (index === -1) {
    console.error('❌ [Configuration] Config not found:', configId);
    return false;
  }
  
  const configName = systemConfig.configurations[index].name;
  systemConfig.configurations.splice(index, 1);
  
  // アクティブなConfigurationが削除された場合、最初のConfigurationをアクティブに
  if (idsEqual(systemConfig.activeConfigId, configId)) {
    systemConfig.activeConfigId = systemConfig.configurations[0].id;
    cfgLog(`🔄 [Configuration] Active config changed to: ${systemConfig.configurations[0].name}`);
  }
  
  saveSystemConfigurations(systemConfig);
  cfgLog(`✅ [Configuration] Deleted configuration: ${configName}`);
  return true;
}

// Configurationを複製
export function duplicateConfiguration(configId: number | string): number | null {
  const systemConfig = loadSystemConfigurations();
  const sourceConfig = systemConfig.configurations.find(c => c.id === configId);
  
  if (!sourceConfig) {
    console.error('❌ [Configuration] Config not found:', configId);
    return null;
  }
  
  // 新しいID生成
  const maxId = Math.max(...systemConfig.configurations.map(c => Number(c.id) || 0), 0);
  const newId = maxId + 1;
  
  // 完全なコピーを作成
  const newConfig = JSON.parse(JSON.stringify(sourceConfig)) as Configuration;
  newConfig.id = newId;
  newConfig.name = `${sourceConfig.name} (Copy)`;
  newConfig.metadata.created = new Date().toISOString();
  newConfig.metadata.modified = new Date().toISOString();
  
  systemConfig.configurations.push(newConfig);
  saveSystemConfigurations(systemConfig);
  
  cfgLog(`✅ [Configuration] Duplicated configuration: ${newConfig.name} (ID: ${newId})`);
  return newId;
}

// Configuration名を変更
export function renameConfiguration(configId: number | string, newName: string): boolean {
  const systemConfig = loadSystemConfigurations();
  const config = systemConfig.configurations.find(c => c.id === configId);
  
  if (!config) {
    console.error('❌ [Configuration] Config not found:', configId);
    return false;
  }
  
  const oldName = config.name;
  config.name = newName;
  config.metadata.modified = new Date().toISOString();
  
  saveSystemConfigurations(systemConfig);
  cfgLog(`✅ [Configuration] Renamed: ${oldName} → ${newName}`);
  return true;
}

// Configurationの並び順を変更
export function reorderConfiguration(
  configId: number | string,
  targetConfigId: number | string,
  position: 'before' | 'after'
): boolean {
  const systemConfig = loadSystemConfigurations();
  const configs = Array.isArray(systemConfig.configurations) ? systemConfig.configurations : [];

  if (configs.length < 2) {
    return false;
  }

  const fromIndex = configs.findIndex(c => idsEqual(c?.id, configId));
  const targetIndex = configs.findIndex(c => idsEqual(c?.id, targetConfigId));

  if (fromIndex === -1 || targetIndex === -1 || fromIndex === targetIndex) {
    return false;
  }

  const reordered = configs.slice();
  const [moved] = reordered.splice(fromIndex, 1);
  if (!moved) {
    return false;
  }

  let insertIndex = targetIndex;
  if (position === 'after') insertIndex += 1;
  if (fromIndex < insertIndex) insertIndex -= 1;
  insertIndex = Math.max(0, Math.min(reordered.length, insertIndex));

  reordered.splice(insertIndex, 0, moved);
  systemConfig.configurations = reordered;
  saveSystemConfigurations(systemConfig);

  cfgLog(`✅ [Configuration] Reordered: ${String(configId)} ${position} ${String(targetConfigId)}`);
  return true;
}

// 全Configuration一覧を取得（テーブル表示用）
export function getConfigurationList(): ConfigurationListItem[] {
  const systemConfig = loadSystemConfigurations();
  return systemConfig.configurations.map(c => ({
    id: c.id,
    name: c.name,
    active: idsEqual(c.id, systemConfig.activeConfigId),
    created: c.metadata.created,
    modified: c.metadata.modified,
    locked: c.metadata.locked
  }));
}

// グローバルにエクスポート
if (typeof window !== 'undefined') {
  w.ConfigurationManager = {
    loadSystemConfigurations,
    saveSystemConfigurations,
    getActiveConfiguration,
    getActiveConfigId,
    setActiveConfiguration,
    saveCurrentToActiveConfiguration,
    loadActiveConfigurationToTables,
    addConfiguration,
    deleteConfiguration,
    duplicateConfiguration,
    reorderConfiguration,
    renameConfiguration,
    getConfigurationList
  };
}
