// Block-based optical design schema (MVP)
// - Canonical storage: blocks[] in configuration
// - Deterministic expansion: blocks -> OpticalSystemTableData row array
// - Supported blocks (MVP): ObjectSurface, Lens, Stop, AirGap, ImageSurface
// - Glass material must exist in glass.js DB; numeric refractive index is disallowed.

import { getAllGlassDatabases, getGlassDataWithSellmeier } from './glass.ts';
import { calculateFullSystemParaxialTrace, calculateParaxialData } from '../raytracing/core/ray-paraxial.ts';

export const BLOCK_SCHEMA_VERSION = '0.1';
export const DEFAULT_SEMIDIA = '10';
export const DEFAULT_STOP_SEMI_DIAMETER = 5.0;

type LoadIssueSeverity = 'fatal' | 'warning' | 'info';
type LoadIssuePhase = 'parse' | 'validate' | 'expand';

export interface LoadIssue {
  severity: LoadIssueSeverity;
  phase: LoadIssuePhase;
  message: string;
  blockId?: string;
  surfaceIndex?: number;
}

export interface Block {
  blockId?: string;
  blockType?: string;
  role?: any;
  constraints?: Record<string, any>;
  parameters?: Record<string, any>;
  variables?: Record<string, any>;
  metadata?: Record<string, any>;
  aperture?: Record<string, any>;
}

const ALLOWED_SURF_TYPES = new Set(['', 'Spherical', 'Aspheric even', 'Aspheric odd', 'Toric']);

function normalizeSurfTypeValue(value: any): string {
  const s = String(value ?? '').trim();
  if (s === '') return '';

  // Normalize aggressively so legacy imports don't fail Blocks validation.
  // Only return canonical values in ALLOWED_SURF_TYPES (or '').
  const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();

  // Zemax/CodeV style
  // IMPORTANT:
  // - '' means "unspecified/default" and may be inferred from non-zero asphere params.
  // - 'Spherical' is an explicit choice for polynomial terms (coef*), but conic is still valid.
  if (key === 'standard' || key === 'std') return '';
  if (key === 'spherical' || key === 'sphere' || key === 'sph') return 'Spherical';
  if (key === 'asphericaleven' || key === 'asphericeven' || key === 'evenasphere' || key === 'evenaspheric') return 'Aspheric even';
  if (key === 'asphericalodd' || key === 'asphericodd' || key === 'oddasphere' || key === 'oddaspheric') return 'Aspheric odd';
  if (key === 'toric' || key === 'toroidal' || key === 'astigmatic' || key === 'anamorphic' || key === 'xypower' || key === 'x-y-power') return 'Toric';

  // Fuzzy matches
  if (key.includes('aspher') && key.includes('even')) return 'Aspheric even';
  if (key.includes('aspher') && key.includes('odd')) return 'Aspheric odd';

  // Unknown surfType: treat as spherical to keep conversion best-effort.
  return '';
}

function normalizeOptionalNumberToRowValue(value: any): string {
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

function inferThinLensReferenceIndex(material: any, rindex: any): number {
  const explicitRindex = Number(String(rindex ?? '').trim());
  if (Number.isFinite(explicitRindex) && explicitRindex > 1.0) return explicitRindex;

  const materialStr = String(material ?? '').trim();
  if (materialStr !== '') {
    const numericMaterial = Number(materialStr);
    if (Number.isFinite(numericMaterial) && numericMaterial > 1.0) return numericMaterial;

    const glass = getGlassDataWithSellmeier(materialStr);
    if (glass && typeof glass.nd === 'number' && Number.isFinite(glass.nd) && glass.nd > 1.0) {
      return glass.nd;
    }
  }

  // N-BK7 fallback keeps ThinLens numerically useful even before the user chooses a glass.
  return 1.5168;
}

function computeThinLensSurfaceRadii({ focalLength, focalLengthX, focalLengthY, material, rindex }: any): { frontRadius: string | number; backRadius: string | number; frontRadiusX: string | number; backRadiusX: string | number; effectiveIndex: number } {
  const fyNorm = normalizeThicknessToRowValue(focalLengthY ?? focalLength ?? focalLengthX);
  const fxNorm = normalizeThicknessToRowValue(focalLengthX ?? focalLengthY ?? focalLength);
  const nd = inferThinLensReferenceIndex(material, rindex);

  const buildRadiusPair = (fNorm: any) => {
    if (fNorm === 'INF') {
      return { frontRadius: 'INF', backRadius: 'INF' };
    }
    if (typeof fNorm !== 'number' || !Number.isFinite(fNorm) || Math.abs(fNorm) < 1e-12 || !Number.isFinite(nd) || nd <= 1.0) {
      return { frontRadius: 'INF', backRadius: 'INF' };
    }

    const curvature = 1 / (2 * (nd - 1.0) * fNorm);
    return {
      frontRadius: Math.abs(curvature) < 1e-12 ? 'INF' : String(1 / curvature),
      backRadius: Math.abs(curvature) < 1e-12 ? 'INF' : String(-1 / curvature),
    };
  };

  const yPair = buildRadiusPair(fyNorm);
  const xPair = buildRadiusPair(fxNorm);

  return {
    frontRadius: yPair.frontRadius,
    backRadius: yPair.backRadius,
    frontRadiusX: xPair.frontRadius,
    backRadiusX: xPair.backRadius,
    effectiveIndex: nd
  };
}

function blockAsphereLooksNonZero({ surfType, conic, coefs }: any): boolean {
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

function isPlainObject(value: any): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: any): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumericString(value: any): boolean {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s === '') return false;
  return /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s);
}

function normalizeRadiusToRowValue(value: any): string | number {
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

function normalizeThicknessToRowValue(value: any): number | string {
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

function normalizeZoomGroupName(value: any): string {
  const raw = String(value ?? '').trim();
  if (!raw) return 'Fixed';
  const upper = raw.toUpperCase();
  if (upper === 'FIXED' || upper === 'STATIC' || upper === 'BASE') return 'Fixed';
  return raw;
}

function normalizeZoomPosition(value: any): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

function parseZoomProfilePoints(value: any): Array<{ x: number; y: number }> {
  const text = String(value ?? '').trim();
  if (!text) return [{ x: 0, y: 0 }, { x: 1, y: 0 }];

  // Single-value shorthand means a constant offset over the full zoom range.
  if (!text.includes(',') && /^[-+]?((\d+\.\d*)|(\d*\.\d+)|(\d+))(?:[eE][-+]?\d+)?$/.test(text)) {
    const constantValue = Number(text);
    if (Number.isFinite(constantValue)) {
      return [{ x: 0, y: constantValue }, { x: 1, y: constantValue }];
    }
  }

  // Two-value shorthand means start:end over the normalized zoom range 0..1.
  if (!text.includes(',')) {
    const shorthandMatch = text.match(/^([^:]+):([^:]+)$/);
    if (shorthandMatch) {
      const startValue = Number(String(shorthandMatch[1]).trim());
      const endValue = Number(String(shorthandMatch[2]).trim());
      if (Number.isFinite(startValue) && Number.isFinite(endValue)) {
        return [{ x: 0, y: startValue }, { x: 1, y: endValue }];
      }
    }
  }

  const points: Array<{ x: number; y: number }> = [];
  const segments = text.split(',');
  for (const segment of segments) {
    const part = String(segment ?? '').trim();
    if (!part) continue;
    const match = part.match(/^([^:]+):([^:]+)$/);
    if (!match) continue;
    const x = Number(String(match[1]).trim());
    const y = Number(String(match[2]).trim());
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x: Math.max(0, Math.min(1, x)), y });
  }

  if (points.length === 0) return [{ x: 0, y: 0 }, { x: 1, y: 0 }];

  points.sort((left, right) => left.x - right.x);
  const deduped: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.x - point.x) <= 1e-9) {
      prev.y = point.y;
    } else {
      deduped.push({ ...point });
    }
  }

  if (deduped[0].x > 0) deduped.unshift({ x: 0, y: deduped[0].y });
  const last = deduped[deduped.length - 1];
  if (last.x < 1) deduped.push({ x: 1, y: last.y });
  return deduped;
}

function parseZoomGroupProfiles(value: any, legacyProfiles?: Record<string, any>): Record<string, Array<{ x: number; y: number }>> {
  const groups: Record<string, Array<{ x: number; y: number }>> = {};

  if (isPlainObject(value)) {
    for (const [rawGroupName, rawProfile] of Object.entries(value)) {
      const groupName = normalizeZoomGroupName(rawGroupName);
      if (groupName === 'Fixed') continue;
      groups[groupName] = parseZoomProfilePoints(rawProfile);
    }
  } else {
    const text = String(value ?? '').trim();
    if (text) {
      const entries = text.split(/\r?\n|;/);
      for (const entry of entries) {
        const line = String(entry ?? '').trim();
        if (!line) continue;
        const eqIndex = line.indexOf('=');
        if (eqIndex <= 0) continue;
        const groupName = normalizeZoomGroupName(line.slice(0, eqIndex));
        if (groupName === 'Fixed') continue;
        groups[groupName] = parseZoomProfilePoints(line.slice(eqIndex + 1));
      }
    }
  }

  if (Object.keys(groups).length > 0) return groups;

  if (legacyProfiles && typeof legacyProfiles === 'object') {
    for (const [rawGroupName, rawProfile] of Object.entries(legacyProfiles)) {
      const profileText = String(rawProfile ?? '').trim();
      if (!profileText) continue;
      const groupName = normalizeZoomGroupName(rawGroupName);
      if (groupName === 'Fixed') continue;
      groups[groupName] = parseZoomProfilePoints(profileText);
    }
  }

  return groups;
}

function parseLinkedZoomGroupDefinitions(value: any): Array<LinkedZoomGroupDefinition> {
  const linkedGroups: Array<LinkedZoomGroupDefinition> = [];
  const seen = new Set<string>();

  const assignDefinition = (rawGroupName: any, rawScale: any) => {
    const groupName = normalizeZoomGroupName(rawGroupName);
    if (!groupName || groupName === 'Fixed' || seen.has(groupName)) return;
    const scaleText = String(rawScale ?? '').trim();
    const numericScale = scaleText === '' ? 1 : Number(scaleText);
    if (!Number.isFinite(numericScale) || Math.abs(numericScale) <= 1e-12) return;
    seen.add(groupName);
    linkedGroups.push({ groupName, scale: numericScale });
  };

  if (isPlainObject(value)) {
    for (const [rawGroupName, rawScale] of Object.entries(value)) {
      assignDefinition(rawGroupName, rawScale);
    }
    return linkedGroups;
  }

  const text = String(value ?? '').trim();
  if (!text) return linkedGroups;

  for (const entry of text.split(/\r?\n|;/)) {
    const line = String(entry ?? '').trim();
    if (!line) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex > 0) {
      assignDefinition(line.slice(0, eqIndex), line.slice(eqIndex + 1));
      continue;
    }
    assignDefinition(line, 1);
  }

  return linkedGroups;
}

function normalizeZoomCompensationStroke(value: any): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function normalizeZoomCompensationSampleCount(value: any, fallback = 33): number {
  const numericValue = Math.floor(Number(value));
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.max(5, Math.min(201, numericValue));
}

function getLinkedZoomOffsetsForPosition(
  linkedGroups: Array<LinkedZoomGroupDefinition>,
  stroke: number,
  zoomPosition: number
): Map<string, number> {
  const linkedOffsets = new Map<string, number>();
  if (!Array.isArray(linkedGroups) || linkedGroups.length === 0) return linkedOffsets;
  if (!Number.isFinite(stroke) || Math.abs(stroke) <= 1e-12) return linkedOffsets;

  const effectiveZoomPosition = normalizeZoomPosition(zoomPosition);
  for (const linkedGroup of linkedGroups) {
    if (!linkedGroup || !linkedGroup.groupName) continue;
    const offset = stroke * Number(linkedGroup.scale || 0) * effectiveZoomPosition;
    if (!Number.isFinite(offset)) continue;
    linkedOffsets.set(linkedGroup.groupName, offset);
  }
  return linkedOffsets;
}

function mapToNumberRecord(input: Map<string, number>): Record<string, number> {
  const record: Record<string, number> = {};
  for (const [key, value] of input.entries()) {
    if (!key || !Number.isFinite(value)) continue;
    record[key] = value;
  }
  return record;
}

function computeZeroCrossings(samples: Array<ZoomCompensationSample>): number[] {
  const zeroCrossings: number[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const current = samples[index];
    const currentShift = Number(current?.focusShift);
    if (!Number.isFinite(currentShift)) continue;

    if (Math.abs(currentShift) <= 1e-9) {
      zeroCrossings.push(current.zoomPosition);
      continue;
    }

    if (index === 0) continue;
    const prev = samples[index - 1];
    const prevShift = Number(prev?.focusShift);
    if (!Number.isFinite(prevShift) || Math.abs(prevShift) <= 1e-9) continue;
    if ((prevShift < 0 && currentShift < 0) || (prevShift > 0 && currentShift > 0)) continue;

    const dy = currentShift - prevShift;
    if (!Number.isFinite(dy) || Math.abs(dy) <= 1e-12) continue;
    const t = -prevShift / dy;
    if (!Number.isFinite(t)) continue;
    zeroCrossings.push(prev.zoomPosition + ((current.zoomPosition - prev.zoomPosition) * t));
  }
  return zeroCrossings;
}

function getMinimumFiniteThickness(rows: any[]): number | null {
  let minThickness: number | null = null;
  for (const row of rows || []) {
    const thickness = Number(row?.thickness);
    if (!Number.isFinite(thickness)) continue;
    minThickness = minThickness === null ? thickness : Math.min(minThickness, thickness);
  }
  return minThickness;
}

export function evaluateZoomCompensation(
  blocks: Block[],
  options?: { sampleCount?: number; wavelength?: number }
): ZoomCompensationEvaluation {
  const emptyResult: ZoomCompensationEvaluation = {
    available: false,
    stroke: 0,
    sampleCount: 0,
    linkedGroups: [],
    samples: [],
    zeroCrossings: [],
    collisionPositions: [],
    minFocusShift: null,
    maxFocusShift: null
  };

  if (!Array.isArray(blocks) || blocks.length === 0) return emptyResult;

  const zoomController = blocks.find((block) => {
    const type = isPlainObject(block) ? String(block.blockType ?? '').trim() : '';
    return type === 'ObjectSurface' || type === 'ObjectPlane';
  });
  if (!zoomController) return emptyResult;

  const controllerParams = isPlainObject(zoomController?.parameters) ? zoomController.parameters : null;
  const controllerVars = isPlainObject(zoomController?.variables) ? zoomController.variables : null;
  const linkedGroups = parseLinkedZoomGroupDefinitions(getParamOrVarValue(controllerParams, controllerVars, 'zoomLinkedGroupScales'));
  const stroke = normalizeZoomCompensationStroke(getParamOrVarValue(controllerParams, controllerVars, 'zoomCompensationStroke'));
  const sampleCount = normalizeZoomCompensationSampleCount(
    options?.sampleCount ?? getParamOrVarValue(controllerParams, controllerVars, 'zoomCompensationSamples'),
    33
  );
  const wavelength = Number.isFinite(Number(options?.wavelength)) ? Number(options?.wavelength) : 0.5875618;

  const samples: Array<ZoomCompensationSample> = [];
  let baselineBackFocalLength: number | null = null;

  for (let index = 0; index < sampleCount; index += 1) {
    const zoomPosition = sampleCount <= 1 ? 0 : index / (sampleCount - 1);
    const sampleBlocks = blocks.map((block) => {
      if (!isPlainObject(block)) return block;
      return {
        ...block,
        parameters: isPlainObject(block.parameters) ? { ...block.parameters } : block.parameters,
        variables: isPlainObject(block.variables) ? { ...block.variables } : block.variables,
        metadata: isPlainObject(block.metadata) ? { ...block.metadata } : block.metadata,
        aperture: isPlainObject(block.aperture) ? { ...block.aperture } : block.aperture
      };
    });

    const sampleController = sampleBlocks.find((block) => String(block?.blockType ?? '').trim() === String(zoomController?.blockType ?? '').trim() && String(block?.blockId ?? '') === String(zoomController?.blockId ?? ''));
    if (sampleController && isPlainObject(sampleController.parameters)) {
      sampleController.parameters.zoomPosition = zoomPosition;
    }

    const expanded = expandBlocksToOpticalSystemRows(sampleBlocks);
    const rows = Array.isArray(expanded?.rows) ? expanded.rows : [];
    const paraxial = rows.length > 0 ? calculateParaxialData(rows, wavelength) : null;
    const backFocalLength = Number(paraxial?.backFocalLength);
    const imageDistance = Number(paraxial?.imageDistance);
    if (baselineBackFocalLength === null && Number.isFinite(backFocalLength)) {
      baselineBackFocalLength = backFocalLength;
    }

    const minThickness = getMinimumFiniteThickness(rows);
    const collision = Number.isFinite(minThickness) ? Number(minThickness) < 0 : false;
    const linkedOffsets = getLinkedZoomOffsetsForPosition(linkedGroups, stroke, zoomPosition);
    const focusShift = Number.isFinite(backFocalLength) && Number.isFinite(baselineBackFocalLength)
      ? backFocalLength - Number(baselineBackFocalLength)
      : null;

    samples.push({
      zoomPosition,
      backFocalLength: Number.isFinite(backFocalLength) ? backFocalLength : null,
      imageDistance: Number.isFinite(imageDistance) ? imageDistance : null,
      focusShift,
      linkedOffsets: mapToNumberRecord(linkedOffsets),
      collision,
      minThickness
    });
  }

  const finiteFocusShifts = samples
    .map((sample) => Number(sample.focusShift))
    .filter((value) => Number.isFinite(value));
  const collisionPositions = samples
    .filter((sample) => sample.collision)
    .map((sample) => sample.zoomPosition);

  return {
    available: true,
    stroke,
    sampleCount,
    linkedGroups,
    samples,
    zeroCrossings: computeZeroCrossings(samples),
    collisionPositions,
    minFocusShift: finiteFocusShifts.length > 0 ? Math.min(...finiteFocusShifts) : null,
    maxFocusShift: finiteFocusShifts.length > 0 ? Math.max(...finiteFocusShifts) : null
  };
}

type ZoomLawDefinition =
  | { type: 'profile'; points: Array<{ x: number; y: number }> }
  | { type: 'expression'; expression: string };

type ZoomLawParseResult = {
  definitions: Record<string, ZoomLawDefinition>;
  constants: Record<string, number>;
  constantExpressions: Record<string, string>;
};

type ZoomLawResolutionResult = {
  offsets: Map<string, number>;
  errors: string[];
};

type LinkedZoomGroupDefinition = {
  groupName: string;
  scale: number;
};

export type ZoomCompensationSample = {
  zoomPosition: number;
  backFocalLength: number | null;
  imageDistance: number | null;
  focusShift: number | null;
  linkedOffsets: Record<string, number>;
  collision: boolean;
  minThickness: number | null;
};

export type ZoomCompensationEvaluation = {
  available: boolean;
  stroke: number;
  sampleCount: number;
  linkedGroups: Array<LinkedZoomGroupDefinition>;
  samples: Array<ZoomCompensationSample>;
  zeroCrossings: number[];
  collisionPositions: number[];
  minFocusShift: number | null;
  maxFocusShift: number | null;
};

type ZoomLawDiagnosticState = {
  message: string | null;
};

type ZoomLawEvaluationContext = {
  objectDistanceMode: 'Finite' | 'INF';
  blocks?: Block[];
  zoomPosition?: number;
  currentGroupName?: string;
};

const autoZoomLawConstantCache = new WeakMap<Block[], { key: string; constants: Record<string, number> }>();
const zoomLawFocusTargetCache = new WeakMap<Block[], { key: string; imageDistance: number | null }>();

type CooptPerfCounter = {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
};

function recordCooptPerfSample(name: string, durationMs: number): void {
  const safeDuration = Number(durationMs);
  if (!name || !Number.isFinite(safeDuration) || safeDuration < 0) return;
  try {
    const g = globalThis as typeof globalThis & {
      __cooptPerf?: {
        samples?: Record<string, CooptPerfCounter>;
      };
    };
    if (!g.__cooptPerf || typeof g.__cooptPerf !== 'object') {
      g.__cooptPerf = { samples: {} };
    }
    if (!g.__cooptPerf.samples || typeof g.__cooptPerf.samples !== 'object') {
      g.__cooptPerf.samples = {};
    }
    const current = g.__cooptPerf.samples[name] || { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
    current.count += 1;
    current.totalMs += safeDuration;
    current.maxMs = Math.max(current.maxMs, safeDuration);
    current.lastMs = safeDuration;
    g.__cooptPerf.samples[name] = current;
  } catch (_) {
    // ignore perf recording failures
  }
}

function isZoomProfileDefinitionText(value: any): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;

  if (/^[-+]?((\d+\.\d*)|(\d*\.\d+)|(\d+))(?:[eE][-+]?\d+)?$/.test(text)) {
    return true;
  }

  if (!text.includes(',')) {
    return /^([^:]+):([^:]+)$/.test(text);
  }

  const segments = text.split(',').map((segment) => String(segment ?? '').trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => /^([^:]+):([^:]+)$/.test(segment));
}

function parseZoomLawDefinitions(value: any, legacyProfiles?: Record<string, any>): ZoomLawParseResult {
  const groups: Record<string, ZoomLawDefinition> = {};
  const constants: Record<string, number> = {};
  const constantExpressions: Record<string, string> = {};

  const assignConstant = (rawName: any, rawValue: any): boolean => {
    const nameText = String(rawName ?? '').trim();
    const match = nameText.match(/^(?:const\s+|\$)([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (!match) return false;
    const constantName = match[1];
    const valueText = String(rawValue ?? '').trim();
    const numericValue = parseZoomLawExpressionNumber(valueText);
    delete constants[constantName];
    delete constantExpressions[constantName];
    if (numericValue !== null) {
      constants[constantName] = numericValue;
    } else if (valueText) {
      constantExpressions[constantName] = valueText;
    }
    return true;
  };

  const assignDefinition = (rawGroupName: any, rawProfile: any) => {
    const groupName = normalizeZoomGroupName(rawGroupName);
    if (groupName === 'Fixed') return;
    const profileText = String(rawProfile ?? '').trim();
    if (!profileText) return;
    const hasExplicitPointSyntax = isZoomProfileDefinitionText(profileText);
    if (hasExplicitPointSyntax) {
      groups[groupName] = { type: 'profile', points: parseZoomProfilePoints(profileText) };
      return;
    }
    groups[groupName] = { type: 'expression', expression: profileText };
  };

  if (isPlainObject(value)) {
    for (const [rawGroupName, rawProfile] of Object.entries(value)) {
      if (assignConstant(rawGroupName, rawProfile)) continue;
      assignDefinition(rawGroupName, rawProfile);
    }
  } else {
    const text = String(value ?? '').trim();
    if (text) {
      const entries = text.split(/\r?\n|;/);
      for (const entry of entries) {
        const line = String(entry ?? '').trim();
        if (!line) continue;
        const eqIndex = line.indexOf('=');
        if (eqIndex <= 0) continue;
        if (assignConstant(line.slice(0, eqIndex), line.slice(eqIndex + 1))) continue;
        assignDefinition(line.slice(0, eqIndex), line.slice(eqIndex + 1));
      }
    }
  }

  if (Object.keys(groups).length > 0 || Object.keys(constants).length > 0 || Object.keys(constantExpressions).length > 0) {
    return { definitions: groups, constants, constantExpressions };
  }

  if (legacyProfiles && typeof legacyProfiles === 'object') {
    for (const [rawGroupName, rawProfile] of Object.entries(legacyProfiles)) {
      assignDefinition(rawGroupName, rawProfile);
    }
  }

  return { definitions: groups, constants, constantExpressions };
}

function parseZoomLawExpressionNumber(value: string): number | null {
  const numericText = String(value ?? '').trim();
  if (!numericText) return null;
  const parsed = Number(numericText);
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidZoomLawIdentifier(value: any): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value ?? '').trim());
}

function collectZoomLawIdentifiers(expression: string): string[] {
  const text = String(expression ?? '');
  const identifiers = new Set<string>();
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (/[A-Za-z_]/.test(ch)) {
      let end = index + 1;
      while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end += 1;
      identifiers.add(text.slice(index, end));
      index = end;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let end = index + 1;
      while (end < text.length && /[0-9.]/.test(text[end])) end += 1;
      if (end < text.length && /[eE]/.test(text[end])) {
        let expEnd = end + 1;
        if (expEnd < text.length && /[+-]/.test(text[expEnd])) expEnd += 1;
        let sawExpDigit = false;
        while (expEnd < text.length && /[0-9]/.test(text[expEnd])) {
          sawExpDigit = true;
          expEnd += 1;
        }
        if (sawExpDigit) end = expEnd;
      }
      index = end;
      continue;
    }
    index += 1;
  }
  return Array.from(identifiers);
}

function collectReferencedAutoZoomLawConstantNames(
  definitions: Record<string, ZoomLawDefinition>,
  constantExpressions: Record<string, string>,
  explicitConstants: Record<string, number>
): Set<string> {
  const referenced = new Set<string>();
  const explicitNames = new Set(Object.keys(explicitConstants || {}));

  const inspectExpression = (expression: string) => {
    const identifiers = collectZoomLawIdentifiers(expression);
    for (const identifier of identifiers) {
      if (!/^phi[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) continue;
      if (explicitNames.has(identifier)) continue;
      referenced.add(identifier);
    }
  };

  for (const definition of Object.values(definitions || {})) {
    if (!definition || definition.type !== 'expression') continue;
    inspectExpression(definition.expression);
  }
  for (const expression of Object.values(constantExpressions || {})) {
    inspectExpression(expression);
  }

  return referenced;
}

function collectReferencedAutoZoomLawCoordinateNames(
  definitions: Record<string, ZoomLawDefinition>,
  constantExpressions: Record<string, string>,
  explicitConstants: Record<string, number>
): Set<string> {
  const referenced = new Set<string>();
  const explicitNames = new Set(Object.keys(explicitConstants || {}));

  const inspectExpression = (expression: string) => {
    const identifiers = collectZoomLawIdentifiers(expression);
    for (const identifier of identifiers) {
      if (explicitNames.has(identifier)) continue;
      if (identifier === 'zObj' || identifier === 'zImg') {
        referenced.add(identifier);
        continue;
      }
      if (/^z[A-Za-z_][A-Za-z0-9_]*0$/.test(identifier)) {
        referenced.add(identifier);
        continue;
      }
      if (/^z[A-Za-z_][A-Za-z0-9_]*seed$/.test(identifier)) {
        referenced.add(identifier);
      }
    }
  };

  for (const definition of Object.values(definitions || {})) {
    if (!definition || definition.type !== 'expression') continue;
    inspectExpression(definition.expression);
  }
  for (const expression of Object.values(constantExpressions || {})) {
    inspectExpression(expression);
  }

  return referenced;
}

function resolveZoomLawConstantExpressions(
  baseConstants: Record<string, number>,
  constantExpressions: Record<string, string>
): Record<string, number> {
  const resolvedConstants: Record<string, number> = {};
  for (const [name, value] of Object.entries(baseConstants || {})) {
    if (isValidZoomLawIdentifier(name) && Number.isFinite(value)) {
      resolvedConstants[name] = Number(value);
    }
  }

  const unresolvedExpressions = new Map(Object.entries(constantExpressions || {}));
  let didResolve = true;
  while (unresolvedExpressions.size > 0 && didResolve) {
    didResolve = false;
    for (const [name, expression] of Array.from(unresolvedExpressions.entries())) {
      const diagnosticState: ZoomLawDiagnosticState = { message: null };
      const nextValue = evaluateZoomLawExpression(expression, new Map(), resolvedConstants, diagnosticState);
      if (!Number.isFinite(nextValue)) continue;
      resolvedConstants[name] = Number(nextValue);
      unresolvedExpressions.delete(name);
      didResolve = true;
    }
  }

  return resolvedConstants;
}

function buildAutoZoomLawConstantCacheKey(blocks: Block[], requiredConstantNames: Set<string>): string {
  const normalizedBlocks = Array.isArray(blocks)
    ? blocks.map((block) => {
        if (!isPlainObject(block)) return block;
        const blockType = String(block.blockType ?? '').trim();
        const rawParameters = isPlainObject(block.parameters) ? { ...block.parameters } : block.parameters;

        if (blockType === 'ObjectSurface' || blockType === 'ObjectPlane') {
          if (isPlainObject(rawParameters)) {
            delete rawParameters.zoomPosition;
            delete rawParameters.zoomGroupProfiles;
            delete rawParameters.zoomGroupAProfile;
            delete rawParameters.zoomGroupBProfile;
          }
          return {
            blockId: block.blockId ?? null,
            blockType,
            parameters: rawParameters ?? null
          };
        }

        return {
          blockId: block.blockId ?? null,
          blockType,
          parameters: rawParameters ?? null,
          variables: isPlainObject(block.variables) ? block.variables : block.variables ?? null,
          aperture: isPlainObject(block.aperture) ? block.aperture : block.aperture ?? null
        };
      })
    : [];

  return JSON.stringify({
    requiredConstantNames: Array.from(requiredConstantNames).sort(),
    blocks: normalizedBlocks
  });
}

function pickNearestFiniteValue(values: Array<number>, target: number): number | null {
  const candidates = values.filter((value) => Number.isFinite(value));
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestDistance = Math.abs(best - target);
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const distance = Math.abs(candidate - target);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function deriveZoomReferenceCoordinateConstants(
  blocks: Block[],
  requiredConstantNames: Set<string>
): Record<string, number> {
  const constants: Record<string, number> = {};
  if (!Array.isArray(blocks) || blocks.length === 0 || requiredConstantNames.size === 0) return constants;

  const clonedBlocks = blocks.map((block) => {
    if (!isPlainObject(block)) return block;
    return {
      ...block,
      parameters: isPlainObject(block.parameters) ? { ...block.parameters } : block.parameters,
      variables: isPlainObject(block.variables) ? { ...block.variables } : block.variables,
      metadata: isPlainObject(block.metadata) ? { ...block.metadata } : block.metadata,
      aperture: isPlainObject(block.aperture) ? { ...block.aperture } : block.aperture
    };
  });

  const controller = clonedBlocks.find((block) => {
    const type = isPlainObject(block) ? String(block.blockType ?? '').trim() : '';
    return type === 'ObjectSurface' || type === 'ObjectPlane';
  });
  if (isPlainObject(controller)) {
    if (!isPlainObject(controller.parameters)) controller.parameters = {};
    controller.parameters.zoomPosition = 0;
  }

  const groupByBlockId = new Map<string, string>();
  for (const block of clonedBlocks) {
    if (!isPlainObject(block) || !isZoomAnchorBlockType(block.blockType)) continue;
    const blockType = String(block.blockType ?? '').trim();
    if (blockType === 'ObjectSurface' || blockType === 'ObjectPlane' || blockType === 'ImageSurface') continue;
    const blockId = String(block.blockId ?? '').trim();
    if (!blockId) continue;
    const groupName = getBlockZoomGroup(block);
    if (!groupName || groupName === 'Fixed') continue;
    groupByBlockId.set(blockId, groupName);
  }

  const expanded = expandBlocksToOpticalSystemRows(clonedBlocks, { disableAutoZoomLawConstants: true });
  const rows = Array.isArray(expanded?.rows) ? expanded.rows : [];
  if (rows.length === 0) return constants;

  const objectThickness = normalizeThicknessToRowValue(rows[0]?.thickness);
  let currentZ = 0;
  const hasFiniteObjectReference = objectThickness !== 'INF' && Number.isFinite(Number(objectThickness));
  let coordinatesAreFinite = true;
  const groupStartZ = new Map<string, number>();
  let imageZ: number | null = null;

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (coordinatesAreFinite) {
      const prevThickness = Number(rows[index - 1]?.thickness);
      if (!Number.isFinite(prevThickness)) {
        // Infinite object distance should not discard downstream relative coordinates.
        // Treat the first physical surface after the object gap as z=0, but keep zObj
        // unavailable because there is no finite object-plane reference.
        if (index !== 1) {
          coordinatesAreFinite = false;
        }
      } else {
        currentZ += prevThickness;
      }
    }

    if (!coordinatesAreFinite) continue;

    const blockType = String(row?._blockType ?? '').trim();
    const blockId = String(row?._blockId ?? '').trim();
    if (blockType === 'ImageSurface' && imageZ === null) {
      imageZ = currentZ;
    }
    const groupName = groupByBlockId.get(blockId);
    if (groupName && !groupStartZ.has(groupName)) {
      groupStartZ.set(groupName, currentZ);
    }
  }

  if (requiredConstantNames.has('zObj') && (hasFiniteObjectReference || objectThickness === 'INF')) {
    constants.zObj = 0;
  }
  if (requiredConstantNames.has('zImg') && Number.isFinite(imageZ)) {
    constants.zImg = Number(imageZ);
  }
  for (const constantName of requiredConstantNames) {
    const groupZeroMatch = /^z([A-Za-z_][A-Za-z0-9_]*)0$/.exec(constantName);
    if (groupZeroMatch) {
      const groupName = normalizeZoomGroupName(groupZeroMatch[1]);
      const groupZ = groupStartZ.get(groupName);
      if (Number.isFinite(groupZ)) {
        constants[constantName] = Number(groupZ);
      }
      continue;
    }
    const groupSeedMatch = /^z([A-Za-z_][A-Za-z0-9_]*)seed$/.exec(constantName);
    if (groupSeedMatch) {
      const groupName = normalizeZoomGroupName(groupSeedMatch[1]);
      const groupZ = groupStartZ.get(groupName);
      if (Number.isFinite(groupZ)) {
        constants[constantName] = Number(groupZ);
      }
    }
  }

  return constants;
}

function getZoomLawEvaluationContext(blocks: Block[]): ZoomLawEvaluationContext {
  const defaultContext: ZoomLawEvaluationContext = { objectDistanceMode: 'Finite', blocks, zoomPosition: 0 };
  if (!Array.isArray(blocks) || blocks.length === 0) return defaultContext;

  const objectSurfaceBlock = blocks.find((block) => {
    const type = isPlainObject(block) ? String(block.blockType ?? '').trim() : '';
    return type === 'ObjectSurface' || type === 'ObjectPlane';
  });
  if (!isPlainObject(objectSurfaceBlock)) return defaultContext;

  const params = objectSurfaceBlock.parameters;
  const vars = isPlainObject(objectSurfaceBlock.variables) ? objectSurfaceBlock.variables : null;
  const modeRaw = getParamOrVarValue(params, vars, 'objectDistanceMode');
  const modeKey = String(modeRaw ?? '').trim().replace(/\s+/g, '').toUpperCase();
  const zoomPosition = normalizeZoomPosition(getParamOrVarValue(params, vars, 'zoomPosition'));
  return {
    objectDistanceMode: modeKey === 'INF' || modeKey === 'INFINITY' ? 'INF' : 'Finite',
    blocks,
    zoomPosition
  };
}

function cloneBlocksForZoomEvaluation(blocks: Block[]): Block[] {
  return (blocks || []).map((block) => {
    if (!isPlainObject(block)) return block;
    return {
      ...block,
      parameters: isPlainObject(block.parameters) ? { ...block.parameters } : block.parameters,
      variables: isPlainObject(block.variables) ? { ...block.variables } : block.variables,
      metadata: isPlainObject(block.metadata) ? { ...block.metadata } : block.metadata,
      aperture: isPlainObject(block.aperture) ? { ...block.aperture } : block.aperture
    };
  });
}

function clearZoomLawControllerFields(blocks: Block[], zoomPosition: number): void {
  const controller = blocks.find((block) => {
    const type = isPlainObject(block) ? String(block.blockType ?? '').trim() : '';
    return type === 'ObjectSurface' || type === 'ObjectPlane';
  });
  if (!isPlainObject(controller)) return;
  const params = isPlainObject(controller.parameters) ? controller.parameters : (controller.parameters = {});
  params.zoomPosition = zoomPosition;
  delete params.zoomGroupProfiles;
  delete params.zoomGroupAProfile;
  delete params.zoomGroupBProfile;
}

function applyResolvedZoomOffsetsToBlocks(blocks: Block[], zoomPosition: number, offsets: Map<string, number>): Block[] {
  const clonedBlocks = cloneBlocksForZoomEvaluation(blocks);

  const findNextAnchorGroup = (startIndex: number): string => {
    for (let index = startIndex; index < clonedBlocks.length; index += 1) {
      const block = clonedBlocks[index];
      if (!isPlainObject(block) || !isZoomAnchorBlockType(block.blockType)) continue;
      return getBlockZoomGroup(block);
    }
    return 'Fixed';
  };

  let prevAnchorGroup = 'Fixed';
  for (let index = 0; index < clonedBlocks.length; index += 1) {
    const block = clonedBlocks[index];
    if (!isPlainObject(block)) continue;

    const blockType = String(block.blockType ?? '').trim();
    if (blockType === 'Gap' || blockType === 'AirGap') {
      const params = isPlainObject(block.parameters) ? block.parameters : (block.parameters = {});
      const baseThickness = normalizeThicknessToRowValue(params.thickness);
      if (typeof baseThickness === 'number' && Number.isFinite(baseThickness)) {
        const nextAnchorGroup = findNextAnchorGroup(index + 1);
        const gapDelta = (offsets.get(nextAnchorGroup) ?? 0) - (offsets.get(prevAnchorGroup) ?? 0);
        params.thickness = baseThickness + gapDelta;
        if (!isPlainObject(block.metadata)) block.metadata = {};
        block.metadata.zoomDerived = {
          zoomPosition,
          prevAnchorGroup,
          nextAnchorGroup,
          baseThickness,
          gapDelta
        };
      }
      continue;
    }

    if (isZoomAnchorBlockType(blockType)) {
      prevAnchorGroup = getBlockZoomGroup(block);
    }
  }

  return clonedBlocks;
}

function calculateZoomLawFocusTargetImageDistance(blocks: Block[], evaluationContext?: ZoomLawEvaluationContext): number | null {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const mode = evaluationContext?.objectDistanceMode ?? 'Finite';
  const cacheKey = JSON.stringify({ mode });
  const cached = zoomLawFocusTargetCache.get(blocks);
  if (cached?.key === cacheKey) return cached.imageDistance;

  const baselineBlocks = cloneBlocksForZoomEvaluation(blocks);
  clearZoomLawControllerFields(baselineBlocks, 0);
  const expanded = expandBlocksToOpticalSystemRows(baselineBlocks, { disableAutoZoomLawConstants: true });
  const rows = Array.isArray(expanded?.rows) ? expanded.rows : [];
  const paraxial = rows.length > 0 ? calculateParaxialData(rows, 0.5875618) : null;
  const imageDistance = Number(paraxial?.imageDistance);
  const target = Number.isFinite(imageDistance) ? imageDistance : null;
  zoomLawFocusTargetCache.set(blocks, { key: cacheKey, imageDistance: target });
  return target;
}

function solveCamCompNumericOffset(
  bOffset: number,
  zC0: number,
  zCSeed: number | undefined,
  offsets: Map<string, number>,
  diagnosticState?: ZoomLawDiagnosticState,
  evaluationContext?: ZoomLawEvaluationContext
): number | null {
  const blocks = evaluationContext?.blocks;
  const targetGroupName = evaluationContext?.currentGroupName;
  const zoomPosition = normalizeZoomPosition(evaluationContext?.zoomPosition ?? 0);
  if (!Array.isArray(blocks) || !targetGroupName || targetGroupName === 'Fixed') return null;

  const targetImageDistance = calculateZoomLawFocusTargetImageDistance(blocks, evaluationContext);
  if (!Number.isFinite(targetImageDistance)) return null;

  const evaluateCandidate = (candidateOffset: number): {
    offset: number;
    error: number;
    imageDistance: number | null;
    minThickness: number | null;
    collision: boolean;
  } => {
    const candidateOffsets = new Map(offsets);
    candidateOffsets.set(targetGroupName, candidateOffset);
    const candidateBlocks = applyResolvedZoomOffsetsToBlocks(blocks, zoomPosition, candidateOffsets);
    clearZoomLawControllerFields(candidateBlocks, zoomPosition);
    const expanded = expandBlocksToOpticalSystemRows(candidateBlocks, { disableAutoZoomLawConstants: true });
    const rows = Array.isArray(expanded?.rows) ? expanded.rows : [];
    const paraxial = rows.length > 0 ? calculateParaxialData(rows, 0.5875618) : null;
    const imageDistance = Number(paraxial?.imageDistance);
    const minThickness = getMinimumFiniteThickness(rows);
    const collision = Number.isFinite(minThickness) ? Number(minThickness) < 0 : false;
    const error = Number.isFinite(imageDistance) ? Math.abs(imageDistance - targetImageDistance) : Infinity;
    return {
      offset: candidateOffset,
      error,
      imageDistance: Number.isFinite(imageDistance) ? imageDistance : null,
      minThickness,
      collision
    };
  };

  const isBetterCandidate = (
    candidate: { error: number; minThickness: number | null; collision: boolean },
    currentBest: { error: number; minThickness: number | null; collision: boolean }
  ): boolean => {
    if (candidate.collision !== currentBest.collision) return !candidate.collision;
    const candidateErrorFinite = Number.isFinite(candidate.error);
    const bestErrorFinite = Number.isFinite(currentBest.error);
    if (candidateErrorFinite !== bestErrorFinite) return candidateErrorFinite;
    if (candidateErrorFinite && Math.abs(candidate.error - currentBest.error) > 1e-9) {
      return candidate.error < currentBest.error;
    }
    const candidateGap = Number.isFinite(candidate.minThickness) ? Number(candidate.minThickness) : -Infinity;
    const bestGap = Number.isFinite(currentBest.minThickness) ? Number(currentBest.minThickness) : -Infinity;
    if (Math.abs(candidateGap - bestGap) > 1e-9) return candidateGap > bestGap;
    return false;
  };

  const seedOffset = Number.isFinite(zCSeed) ? Number(zCSeed) - zC0 : 0;
  const searchCenter = Number.isFinite(seedOffset) ? seedOffset : 0;
  const searchHalfRange = Math.max(60, Math.abs(bOffset) * 3, Math.abs(searchCenter) + 20);
  const coarseSteps = 33;
  let best = evaluateCandidate(searchCenter);
  const coarseStep = (searchHalfRange * 2) / (coarseSteps - 1);
  for (let index = 0; index < coarseSteps; index += 1) {
    const candidateOffset = searchCenter - searchHalfRange + (coarseStep * index);
    const candidate = evaluateCandidate(candidateOffset);
    if (isBetterCandidate(candidate, best)) best = candidate;
  }

  let refineStep = coarseStep;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    refineStep *= 0.5;
    const left = evaluateCandidate(best.offset - refineStep);
    const right = evaluateCandidate(best.offset + refineStep);
    if (isBetterCandidate(left, best)) best = left;
    if (isBetterCandidate(right, best)) best = right;
  }

  if (!Number.isFinite(best.error)) {
    if (diagnosticState) diagnosticState.message = 'camComp numeric solve could not find a finite paraxial imageDistance candidate.';
    return null;
  }

  if (diagnosticState) {
    if (best.collision) {
      const gapText = Number.isFinite(best.minThickness) ? Number(best.minThickness).toFixed(6) : 'n/a';
      diagnosticState.message = `camComp numeric solve could not find a collision-free candidate; using the least-collision candidate (minThickness ${gapText} mm, focus error ${Number(best.error).toFixed(6)} mm).`;
    } else if (best.error > 0.5) {
      const gapText = Number.isFinite(best.minThickness) ? Number(best.minThickness).toFixed(6) : 'n/a';
      diagnosticState.message = `camComp numeric solve prioritized a collision-free candidate (minThickness ${gapText} mm) with residual focus error ${Number(best.error).toFixed(6)} mm.`;
    } else {
      diagnosticState.message = null;
    }
  }
  return best.offset;
}

function solveCamCompFromIntermediateImage(
  zBPrime: number,
  phiC: number,
  zImg: number,
  zCSeed: number,
  diagnosticState?: ZoomLawDiagnosticState
): number | null {
  if (![zBPrime, phiC, zImg, zCSeed].every((value) => Number.isFinite(value))) {
    if (diagnosticState) diagnosticState.message = 'camComp requires finite intermediate-image arguments.';
    return null;
  }
  if (Math.abs(phiC) <= 1e-12) {
    if (diagnosticState) diagnosticState.message = 'camComp requires phiC to be non-zero.';
    return null;
  }

  const solveQuadraticNearest = (a: number, b: number, c: number): { solution: number | null; discriminant: number } => {
    const discriminant = (b * b) - (4 * a * c);
    if (!Number.isFinite(discriminant) || discriminant < 0) {
      return { solution: null, discriminant };
    }

    const denom = 2 * a;
    if (!(Number.isFinite(denom) && Math.abs(denom) > 1e-12)) {
      return { solution: null, discriminant };
    }

    const sqrtDisc = Math.sqrt(discriminant);
    return {
      solution: pickNearestFiniteValue([
        (-b + sqrtDisc) / denom,
        (-b - sqrtDisc) / denom
      ], zCSeed),
      discriminant
    };
  };

  const primary = solveQuadraticNearest(
    phiC,
    -phiC * (zImg + zBPrime),
    (phiC * zImg * zBPrime) + zImg - zBPrime
  );
  let solution = primary.solution;

  if (!Number.isFinite(solution)) {
    const alternate = solveQuadraticNearest(
      phiC,
      2 - (phiC * (zImg + zBPrime)),
      (phiC * zImg * zBPrime) - zImg - zBPrime
    );
    solution = alternate.solution;
    if (Number.isFinite(solution)) {
      if (diagnosticState) diagnosticState.message = null;
      return solution;
    }
  }

  if (!Number.isFinite(solution)) {
    if (diagnosticState) {
      if (!Number.isFinite(primary.discriminant)) {
        diagnosticState.message = 'camCompAbs produced a non-finite quadratic discriminant.';
      } else {
        const separation = zImg - zBPrime;
        const minPhiC = Number.isFinite(separation) && separation > 1e-12 ? (4 / separation) : NaN;
        const minPhiCText = Number.isFinite(minPhiC) ? minPhiC.toFixed(6) : 'n/a';
        const zBPrimeText = Number.isFinite(zBPrime) ? zBPrime.toFixed(6) : 'n/a';
        diagnosticState.message = `camCompAbs has no real solution because the discriminant is negative (${primary.discriminant}). With zB'=${zBPrimeText} and zImg=${zImg}, phiC must be at least ${minPhiCText} for the default compensator convention, but phiC=${phiC}.`;
      }
    }
    return null;
  }
  if (diagnosticState) diagnosticState.message = null;
  return solution;
}

function solveCamCompAbsolute(
  zB: number,
  phiB: number,
  phiC: number,
  zObj: number,
  zImg: number,
  zCSeed: number,
  diagnosticState?: ZoomLawDiagnosticState,
  evaluationContext?: ZoomLawEvaluationContext
): number | null {
  if (![zB, phiB, phiC, zImg, zCSeed].every((value) => Number.isFinite(value))) {
    if (diagnosticState) diagnosticState.message = 'camCompAbs requires finite numeric arguments.';
    return null;
  }
  if (evaluationContext?.objectDistanceMode === 'INF') {
    if (Math.abs(phiB) <= 1e-12) {
      if (diagnosticState) diagnosticState.message = 'camCompAbs in INF mode requires phiB to be non-zero.';
      return null;
    }
    const zBPrime = zB + (1 / phiB);
    return solveCamCompFromIntermediateImage(zBPrime, phiC, zImg, zCSeed, diagnosticState);
  }

  if (![zObj].every((value) => Number.isFinite(value))) {
    if (diagnosticState) diagnosticState.message = 'camCompAbs requires finite zObj in finite-object mode.';
    return null;
  }

  // Align the helper with the repo's paraxial convention:
  // finite-object initial alpha is -h / distance and imageDistance = h / alpha.
  // For a single powered group, that gives s' = s / (phi*s - 1).
  const sB = zB - zObj;
  const bDenom = (phiB * sB) - 1;
  if (!(Number.isFinite(bDenom) && Math.abs(bDenom) > 1e-12)) {
    if (diagnosticState) diagnosticState.message = 'camCompAbs encountered a singular B-group imaging denominator (phiB*sB - 1 = 0).';
    return null;
  }

  const sPrimeB = sB / bDenom;
  if (!Number.isFinite(sPrimeB)) {
    if (diagnosticState) diagnosticState.message = 'camCompAbs produced a non-finite intermediate image distance.';
    return null;
  }
  const zBPrime = zB + sPrimeB;
  return solveCamCompFromIntermediateImage(zBPrime, phiC, zImg, zCSeed, diagnosticState);
}

function solveCamCompOffset(
  bOffset: number,
  phiB: number,
  phiC: number,
  zObj: number,
  zImg: number,
  zB0: number,
  zC0: number,
  zCSeed?: number,
  offsets?: Map<string, number>,
  diagnosticState?: ZoomLawDiagnosticState,
  evaluationContext?: ZoomLawEvaluationContext
): number | null {
  if (![bOffset, phiB, phiC, zImg, zB0, zC0].every((value) => Number.isFinite(value))) {
    if (diagnosticState) diagnosticState.message = 'camComp requires finite numeric arguments.';
    return null;
  }
  if (evaluationContext?.objectDistanceMode !== 'INF' && !Number.isFinite(zObj)) {
    if (diagnosticState) diagnosticState.message = 'camComp requires finite zObj in finite-object mode.';
    return null;
  }
  const numericOffset = solveCamCompNumericOffset(bOffset, zC0, zCSeed, offsets ?? new Map(), diagnosticState, evaluationContext);
  if (Number.isFinite(numericOffset)) return numericOffset;
  const zB = zB0 + bOffset;
  const absoluteSeed = Number.isFinite(zCSeed) ? Number(zCSeed) : zC0;
  const zC = solveCamCompAbsolute(zB, phiB, phiC, zObj, zImg, absoluteSeed, diagnosticState, evaluationContext);
  if (!Number.isFinite(zC)) return null;
  const baselineZC = solveCamCompAbsolute(zB0, phiB, phiC, zObj, zImg, absoluteSeed, diagnosticState, evaluationContext);
  if (!Number.isFinite(baselineZC)) {
    if (diagnosticState) diagnosticState.message = 'camComp could not establish a finite baseline compensator position.';
    return null;
  }
  const offset = zC - baselineZC;
  if (!Number.isFinite(offset)) {
    if (diagnosticState) diagnosticState.message = 'camComp produced a non-finite compensator offset.';
    return null;
  }
  if (diagnosticState) diagnosticState.message = null;
  return offset;
}

const ZOOM_LAW_BUILTIN_NAMES = Object.freeze(['abs', 'sqrt', 'min', 'max', 'pow', 'camComp', 'camCompAbs']);

function createZoomLawBuiltins(offsets: Map<string, number>, diagnosticState?: ZoomLawDiagnosticState, evaluationContext?: ZoomLawEvaluationContext): Record<string, (...args: Array<number>) => number> {
  return {
    abs: (...args: Array<number>) => {
      if (!(args.length === 1 && Number.isFinite(args[0]))) {
        if (diagnosticState) diagnosticState.message = 'abs(...) requires exactly one finite numeric argument.';
        return NaN;
      }
      return Math.abs(args[0]);
    },
    sqrt: (...args: Array<number>) => {
      if (!(args.length === 1 && Number.isFinite(args[0]))) {
        if (diagnosticState) diagnosticState.message = 'sqrt(...) requires exactly one finite numeric argument.';
        return NaN;
      }
      if (args[0] < 0) {
        if (diagnosticState) diagnosticState.message = `sqrt(...) received a negative argument (${args[0]}).`;
        return NaN;
      }
      return Math.sqrt(args[0]);
    },
    min: (...args: Array<number>) => {
      if (!(args.length > 0 && args.every((value) => Number.isFinite(value)))) {
        if (diagnosticState) diagnosticState.message = 'min(...) requires one or more finite numeric arguments.';
        return NaN;
      }
      return Math.min(...args);
    },
    max: (...args: Array<number>) => {
      if (!(args.length > 0 && args.every((value) => Number.isFinite(value)))) {
        if (diagnosticState) diagnosticState.message = 'max(...) requires one or more finite numeric arguments.';
        return NaN;
      }
      return Math.max(...args);
    },
    pow: (...args: Array<number>) => {
      if (!(args.length === 2 && args.every((value) => Number.isFinite(value)))) {
        if (diagnosticState) diagnosticState.message = 'pow(...) requires exactly two finite numeric arguments.';
        return NaN;
      }
      return Math.pow(args[0], args[1]);
    },
    camComp: (...args: Array<number>) => {
      if (args.length < 7 || args.length > 8) {
        if (diagnosticState) diagnosticState.message = 'camComp(...) requires 7 or 8 arguments: B, phiB, phiC, zObj, zImg, zB0, zC0, [zCseed].';
        return NaN;
      }
      return solveCamCompOffset(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], offsets, diagnosticState, evaluationContext) ?? NaN;
    },
    camCompAbs: (...args: Array<number>) => {
      if (args.length !== 6) {
        if (diagnosticState) diagnosticState.message = 'camCompAbs(...) requires 6 arguments: zB, phiB, phiC, zObj, zImg, zCseed.';
        return NaN;
      }
      return solveCamCompAbsolute(args[0], args[1], args[2], args[3], args[4], args[5], diagnosticState, evaluationContext) ?? NaN;
    }
  };
}

function explainZoomLawFailure(
  groupName: string,
  definition: ZoomLawDefinition,
  offsets: Map<string, number>,
  constants: Record<string, number>,
  zoomPosition: number,
  diagnosticMessage?: string | null
): string {
  if (definition.type !== 'expression') {
    return `Law "${groupName}" could not be resolved.`;
  }

  const scope = new Set<string>();
  for (const [name, value] of offsets.entries()) {
    if (!isValidZoomLawIdentifier(name) || !Number.isFinite(value)) continue;
    scope.add(name);
  }
  for (const [name, value] of Object.entries(constants || {})) {
    if (!isValidZoomLawIdentifier(name) || !Number.isFinite(value)) continue;
    scope.add(name);
  }
  for (const name of ZOOM_LAW_BUILTIN_NAMES) {
    scope.add(name);
  }

  const identifiers = collectZoomLawIdentifiers(definition.expression);
  const missingRefs = identifiers.filter((name) => !scope.has(name));
  if (missingRefs.length > 0) {
    return `Law "${groupName}" references unresolved identifiers: ${missingRefs.join(', ')}.`;
  }

  if (diagnosticMessage) {
    return `Law "${groupName}" failed at zoom x=${Number(zoomPosition || 0).toFixed(3)}: ${diagnosticMessage}`;
  }

  if (/camComp(?:Abs)?|sqrt|min|max|pow|abs/.test(definition.expression)) {
    return `Law "${groupName}" is not solvable at zoom x=${Number(zoomPosition || 0).toFixed(3)}. Check the function arguments, cam constants, referenced groups, and discriminant.`;
  }

  return `Law "${groupName}" could not be evaluated. Check the expression syntax and referenced values.`;
}

function resolveZoomLawOffsets(
  zoomPosition: number,
  lawDefinitions: Record<string, ZoomLawDefinition>,
  lawConstants: Record<string, number>,
  evaluationContext?: ZoomLawEvaluationContext
): ZoomLawResolutionResult {
  const offsets = new Map<string, number>();
  offsets.set('Fixed', 0);

  const unresolvedDefinitions = new Map(Object.entries(lawDefinitions || {}));
  let didResolve = true;
  while (unresolvedDefinitions.size > 0 && didResolve) {
    didResolve = false;
    for (const [groupName, definition] of Array.from(unresolvedDefinitions.entries())) {
      let nextValue: number | null = null;
      const diagnosticState: ZoomLawDiagnosticState = { message: null };
      if (definition.type === 'profile') {
        nextValue = evaluateZoomProfile(definition.points, zoomPosition);
      } else {
        nextValue = evaluateZoomLawExpression(definition.expression, offsets, lawConstants, diagnosticState, { ...(evaluationContext || { objectDistanceMode: 'Finite' }), currentGroupName: groupName, zoomPosition });
      }
      if (!Number.isFinite(nextValue)) continue;
      offsets.set(groupName, Number(nextValue));
      unresolvedDefinitions.delete(groupName);
      didResolve = true;
    }
  }

  const errors: string[] = [];
  for (const [groupName, definition] of unresolvedDefinitions.entries()) {
    const diagnosticState: ZoomLawDiagnosticState = { message: null };
    if (definition.type === 'expression') {
      evaluateZoomLawExpression(definition.expression, offsets, lawConstants, diagnosticState, { ...(evaluationContext || { objectDistanceMode: 'Finite' }), currentGroupName: groupName, zoomPosition });
    }
    offsets.set(groupName, 0);
    errors.push(explainZoomLawFailure(groupName, definition, offsets, lawConstants, zoomPosition, diagnosticState.message));
  }

  return { offsets, errors };
}

function evaluateZoomLawPolynomial(expression: string, groupName: string, groupValue: number): number | null {
  const compact = String(expression ?? '').replace(/\s+/g, '');
  if (!compact) return null;

  const escapedGroupName = groupName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const groupTokenRegex = new RegExp(escapedGroupName, 'gi');
  const normalized = compact.replace(groupTokenRegex, 'X');
  if (!/^[0-9eE+\-*.^X]+$/.test(normalized)) return null;
  if (/[A-DF-WYZ]/i.test(normalized)) return null;

  const terms = normalized.match(/[+-]?[^+-]+/g);
  if (!terms || terms.length === 0) return null;

  let total = 0;
  for (const rawTerm of terms) {
    if (!rawTerm) continue;
    let sign = 1;
    let term = rawTerm;
    if (term.startsWith('+')) {
      term = term.slice(1);
    } else if (term.startsWith('-')) {
      sign = -1;
      term = term.slice(1);
    }
    if (!term) return null;

    const factors = term.split('*').filter(Boolean);
    if (factors.length === 0) return null;

    let coefficient = 1;
    let power = 0;
    for (const factor of factors) {
      if (factor === 'X') {
        power += 1;
        continue;
      }
      if (factor === 'X^2') {
        power += 2;
        continue;
      }
      const numericFactor = parseZoomLawExpressionNumber(factor);
      if (numericFactor !== null) {
        coefficient *= numericFactor;
        continue;
      }
      return null;
    }

    if (power > 2) return null;
    total += sign * coefficient * Math.pow(groupValue, power);
  }

  return Number.isFinite(total) ? total : null;
}

function evaluateZoomLawExpression(expression: string, offsets: Map<string, number>, constants?: Record<string, number>, diagnosticState?: ZoomLawDiagnosticState, evaluationContext?: ZoomLawEvaluationContext): number | null {
  const compact = String(expression ?? '').replace(/\s+/g, '');
  if (!compact) return null;

  const constantValue = parseZoomLawExpressionNumber(compact);
  if (constantValue !== null) return constantValue;

  const referencedGroups = Array.from(offsets.keys())
    .filter((groupName) => groupName !== 'Fixed')
    .sort((left, right) => right.length - left.length);

  for (const groupName of referencedGroups) {
    const baseValue = offsets.get(groupName);
    if (!Number.isFinite(baseValue)) continue;
    const evaluated = evaluateZoomLawPolynomial(compact, groupName, Number(baseValue));
    if (evaluated !== null) return evaluated;
  }

  if (!/^[0-9A-Za-z_+\-*/^().,\s]+$/.test(String(expression ?? ''))) return null;

  const scope = new Map<string, number | Function>();
  for (const [groupName, value] of offsets.entries()) {
    if (!isValidZoomLawIdentifier(groupName) || !Number.isFinite(value)) continue;
    scope.set(groupName, Number(value));
  }
  for (const [name, value] of Object.entries(constants || {})) {
    if (!isValidZoomLawIdentifier(name) || !Number.isFinite(value)) continue;
    scope.set(name, Number(value));
  }
  for (const [name, fn] of Object.entries(createZoomLawBuiltins(offsets, diagnosticState, evaluationContext))) {
    scope.set(name, fn);
  }

  const identifiers = collectZoomLawIdentifiers(expression);
  for (const identifier of identifiers) {
    if (!scope.has(identifier)) return null;
  }

  const normalized = String(expression ?? '').replace(/\^/g, '**');
  try {
    const argNames = Array.from(scope.keys());
    const argValues = argNames.map((name) => scope.get(name));
    const evaluator = new Function(...argNames, `"use strict"; return (${normalized});`);
    const evaluated = evaluator(...argValues);
    return Number.isFinite(evaluated) ? Number(evaluated) : null;
  } catch (_) {
    return null;
  }

  return null;
}

function evaluateZoomProfile(points: Array<{ x: number; y: number }>, zoomPosition: number): number {
  if (!Array.isArray(points) || points.length === 0) return 0;
  const z = normalizeZoomPosition(zoomPosition);
  if (z <= points[0].x) return points[0].y;
  for (let index = 1; index < points.length; index++) {
    const prev = points[index - 1];
    const next = points[index];
    if (z > next.x) continue;
    const dx = next.x - prev.x;
    if (!(Number.isFinite(dx) && Math.abs(dx) > 1e-12)) return next.y;
    const t = (z - prev.x) / dx;
    return prev.y + (next.y - prev.y) * t;
  }
  return points[points.length - 1].y;
}

function isZoomAnchorBlockType(blockType: any): boolean {
  const type = String(blockType ?? '').trim();
  return type !== '' && type !== 'Gap' && type !== 'AirGap';
}

function getBlockZoomGroup(block: any): string {
  if (!isPlainObject(block)) return 'Fixed';
  const params = isPlainObject(block.parameters) ? block.parameters : null;
  const vars = isPlainObject(block.variables) ? block.variables : null;
  return normalizeZoomGroupName(getParamOrVarValue(params, vars, 'zoomGroup'));
}

function estimateZoomGroupParaxialPower(blocks: Block[], groupName: string): number | null {
  const startMs = performance.now();
  try {
    if (!Array.isArray(blocks) || !groupName || groupName === 'Fixed') return null;

    let firstIndex = -1;
    let lastIndex = -1;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (!isPlainObject(block) || !isZoomAnchorBlockType(block.blockType)) continue;
      const blockType = String(block.blockType ?? '').trim();
      if (blockType === 'ObjectSurface' || blockType === 'ObjectPlane' || blockType === 'ImageSurface') continue;
      if (getBlockZoomGroup(block) !== groupName) continue;
      if (firstIndex < 0) firstIndex = index;
      lastIndex = index;
    }
    if (firstIndex < 0 || lastIndex < firstIndex) return null;

    const subgroupBlocks = blocks.slice(firstIndex, lastIndex + 1).filter((block) => {
      if (!isPlainObject(block)) return true;
      const blockType = String(block.blockType ?? '').trim();
      return blockType !== 'ObjectSurface' && blockType !== 'ObjectPlane' && blockType !== 'ImageSurface';
    });
    if (subgroupBlocks.length === 0) return null;

    const expanded = expandBlocksToOpticalSystemRows(subgroupBlocks, { disableAutoZoomLawConstants: true });
    if (!Array.isArray(expanded.rows) || expanded.rows.length < 3) return null;

    const subgroupRows = expanded.rows.map((row) => (row && typeof row === 'object') ? { ...row } : row);
    if (!subgroupRows[0] || typeof subgroupRows[0] !== 'object') return null;
    subgroupRows[0].thickness = 'INF';

    const trace = calculateFullSystemParaxialTrace(subgroupRows, 0.5875618, 'average');
    const power = Number(trace?.finalAlpha);
    return Number.isFinite(power) ? power : null;
  } finally {
    recordCooptPerfSample('blocks.estimateZoomGroupParaxialPower', performance.now() - startMs);
  }
}

function resolveAutomaticZoomLawConstants(
  blocks: Block[],
  explicitConstants: Record<string, number>,
  constantExpressions: Record<string, string>,
  definitions: Record<string, ZoomLawDefinition>
): Record<string, number> {
  const startMs = performance.now();
  try {
    const resolvedConstants: Record<string, number> = {};
    const requiredConstantNames = collectReferencedAutoZoomLawConstantNames(definitions, constantExpressions, explicitConstants);
    const requiredCoordinateNames = collectReferencedAutoZoomLawCoordinateNames(definitions, constantExpressions, explicitConstants);
    const requiredAutoNames = new Set<string>([...requiredConstantNames, ...requiredCoordinateNames]);
    const seenGroups = new Set<string>();

    if (requiredAutoNames.size > 0 && Array.isArray(blocks)) {
      const cacheKey = buildAutoZoomLawConstantCacheKey(blocks, requiredAutoNames);
      const cached = autoZoomLawConstantCache.get(blocks);
      if (cached?.key === cacheKey) {
        Object.assign(resolvedConstants, cached.constants);
      } else {
        if (requiredConstantNames.size > 0) {
          for (const block of blocks) {
            if (!isPlainObject(block) || !isZoomAnchorBlockType(block.blockType)) continue;
            const blockType = String(block.blockType ?? '').trim();
            if (blockType === 'ObjectSurface' || blockType === 'ObjectPlane' || blockType === 'ImageSurface') continue;
            const groupName = getBlockZoomGroup(block);
            if (!groupName || groupName === 'Fixed' || seenGroups.has(groupName)) continue;
            seenGroups.add(groupName);
            const constantName = `phi${groupName}`;
            if (!requiredConstantNames.has(constantName)) continue;
            const estimatedPower = estimateZoomGroupParaxialPower(blocks, groupName);
            if (Number.isFinite(estimatedPower)) {
              resolvedConstants[constantName] = Number(estimatedPower);
            }
          }
        }
        Object.assign(resolvedConstants, deriveZoomReferenceCoordinateConstants(blocks, requiredCoordinateNames));
        autoZoomLawConstantCache.set(blocks, { key: cacheKey, constants: { ...resolvedConstants } });
      }
    }

    for (const [name, value] of Object.entries(explicitConstants || {})) {
      if (Number.isFinite(value)) {
        resolvedConstants[name] = Number(value);
      }
    }

    return resolveZoomLawConstantExpressions(resolvedConstants, constantExpressions);
  } finally {
    recordCooptPerfSample('blocks.resolveAutomaticZoomLawConstants', performance.now() - startMs);
  }
}

function applyZoomMotionToBlocks(blocks: Block[], options?: { disableAutoZoomLawConstants?: boolean }): Block[] {
  const startMs = performance.now();
  try {
    if (!Array.isArray(blocks) || blocks.length === 0) return Array.isArray(blocks) ? blocks : [];

  const zoomController = blocks.find((block) => {
    const type = isPlainObject(block) ? String(block.blockType ?? '').trim() : '';
    return type === 'ObjectSurface' || type === 'ObjectPlane';
  });

  const controllerParams = isPlainObject(zoomController?.parameters) ? zoomController.parameters : null;
  const controllerVars = isPlainObject(zoomController?.variables) ? zoomController.variables : null;
  const zoomPosition = normalizeZoomPosition(getParamOrVarValue(controllerParams, controllerVars, 'zoomPosition'));
  const zoomLawEvaluationContext = getZoomLawEvaluationContext(blocks);
  const { definitions: lawDefinitions, constants: lawConstants, constantExpressions: lawConstantExpressions } = parseZoomLawDefinitions(
    getParamOrVarValue(controllerParams, controllerVars, 'zoomGroupProfiles'),
    {
      A: getParamOrVarValue(controllerParams, controllerVars, 'zoomGroupAProfile'),
      B: getParamOrVarValue(controllerParams, controllerVars, 'zoomGroupBProfile')
    }
  );
  const resolvedLawConstants = options?.disableAutoZoomLawConstants
    ? resolveZoomLawConstantExpressions({ ...(lawConstants || {}) }, lawConstantExpressions)
    : resolveAutomaticZoomLawConstants(blocks, lawConstants, lawConstantExpressions, lawDefinitions);
  const linkedGroups = parseLinkedZoomGroupDefinitions(getParamOrVarValue(controllerParams, controllerVars, 'zoomLinkedGroupScales'));
  const linkedStroke = normalizeZoomCompensationStroke(getParamOrVarValue(controllerParams, controllerVars, 'zoomCompensationStroke'));

  const { offsets } = resolveZoomLawOffsets(zoomPosition, lawDefinitions, resolvedLawConstants, zoomLawEvaluationContext);
  const linkedOffsets = getLinkedZoomOffsetsForPosition(linkedGroups, linkedStroke, zoomPosition);
  for (const [groupName, offset] of linkedOffsets.entries()) {
    offsets.set(groupName, (offsets.get(groupName) ?? 0) + offset);
  }

  const clonedBlocks = blocks.map((block) => {
    if (!isPlainObject(block)) return block;
    return {
      ...block,
      parameters: isPlainObject(block.parameters) ? { ...block.parameters } : block.parameters,
      variables: isPlainObject(block.variables) ? { ...block.variables } : block.variables,
      metadata: isPlainObject(block.metadata) ? { ...block.metadata } : block.metadata,
      aperture: isPlainObject(block.aperture) ? { ...block.aperture } : block.aperture
    };
  });

  const findNextAnchorGroup = (startIndex: number): string => {
    for (let index = startIndex; index < clonedBlocks.length; index++) {
      const block = clonedBlocks[index];
      if (!isPlainObject(block) || !isZoomAnchorBlockType(block.blockType)) continue;
      return getBlockZoomGroup(block);
    }
    return 'Fixed';
  };

  let prevAnchorGroup = 'Fixed';
  for (let index = 0; index < clonedBlocks.length; index++) {
    const block = clonedBlocks[index];
    if (!isPlainObject(block)) continue;

    const blockType = String(block.blockType ?? '').trim();
    if (blockType === 'Gap' || blockType === 'AirGap') {
      const params = isPlainObject(block.parameters) ? block.parameters : (block.parameters = {});
      const baseThickness = normalizeThicknessToRowValue(params.thickness);
      if (typeof baseThickness === 'number' && Number.isFinite(baseThickness)) {
        const nextAnchorGroup = findNextAnchorGroup(index + 1);
        const gapDelta = (offsets.get(nextAnchorGroup) ?? 0) - (offsets.get(prevAnchorGroup) ?? 0);
        params.thickness = baseThickness + gapDelta;
        if (!isPlainObject(block.metadata)) block.metadata = {};
        block.metadata.zoomDerived = {
          zoomPosition,
          prevAnchorGroup,
          nextAnchorGroup,
          baseThickness,
          gapDelta
        };
      }
      continue;
    }

    if (isZoomAnchorBlockType(blockType)) {
      prevAnchorGroup = getBlockZoomGroup(block);
    }
  }

    return clonedBlocks;
  } finally {
    recordCooptPerfSample('blocks.applyZoomMotionToBlocks', performance.now() - startMs);
  }
}

export function validateZoomLawDefinitions(blocks: Block[]): string[] {
  const startMs = performance.now();
  try {
    if (!Array.isArray(blocks) || blocks.length === 0) return [];

  const zoomController = blocks.find((block) => {
    const type = isPlainObject(block) ? String(block.blockType ?? '').trim() : '';
    return type === 'ObjectSurface' || type === 'ObjectPlane';
  });
  if (!zoomController) return [];

  const controllerParams = isPlainObject(zoomController?.parameters) ? zoomController.parameters : null;
  const controllerVars = isPlainObject(zoomController?.variables) ? zoomController.variables : null;
  const zoomPosition = normalizeZoomPosition(getParamOrVarValue(controllerParams, controllerVars, 'zoomPosition'));
  const zoomLawEvaluationContext = getZoomLawEvaluationContext(blocks);
  const { definitions: lawDefinitions, constants: lawConstants, constantExpressions: lawConstantExpressions } = parseZoomLawDefinitions(
    getParamOrVarValue(controllerParams, controllerVars, 'zoomGroupProfiles'),
    {
      A: getParamOrVarValue(controllerParams, controllerVars, 'zoomGroupAProfile'),
      B: getParamOrVarValue(controllerParams, controllerVars, 'zoomGroupBProfile')
    }
  );
    const resolvedLawConstants = resolveAutomaticZoomLawConstants(blocks, lawConstants, lawConstantExpressions, lawDefinitions);

    return resolveZoomLawOffsets(zoomPosition, lawDefinitions, resolvedLawConstants, zoomLawEvaluationContext).errors;
  } finally {
    recordCooptPerfSample('blocks.validateZoomLawDefinitions', performance.now() - startMs);
  }
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
  if (ot === 'ct' || ot === 'coord trans' || ot === 'coordinate transform' || ot === 'coordtrans' || ot === 'coordinatetransform') return true;
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
    if (t === 'image' || __isCoordTransRow(row)) continue;
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
    if (t === 'image' || __isCoordTransRow(row)) continue;
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
    if (t === 'image' || __isCoordTransRow(row)) continue;
    const blockId = String(row._blockId ?? '').trim();
    const role = String(row._surfaceRole ?? '').trim();
    if (!blockId) continue;
    const v = __getRowSemidia(row);
    if (!__semidiaHasValue(v)) continue;

    const block = byId.get(blockId);
    if (!block || typeof block !== 'object') continue;

    if (t === 'stop') {
      const s = String(v).trim();
      const n = isNumericString(s) ? Number(s) : (typeof v === 'number' ? v : NaN);
      if (Number.isFinite(n) && n > 0) {
        if (!isPlainObject(block.parameters)) block.parameters = {};
        block.parameters.semiDiameter = n;
      }
      continue;
    }

    if (!role) continue;
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
  // Disallow surfaceId / surfaceIndex only inside Block.variables.
  // Legacy metadata may contain surfaceIndex for provenance and must not fail validation.
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

  if (Array.isArray(value)) {
    for (const block of value) {
      if (!isPlainObject(block)) continue;
      if (walk(block.variables)) return true;
    }
    return false;
  }

  return walk((value && typeof value === 'object') ? (value as any).variables : value);
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

function __normalizeLegacyMaterialForBlocks(rowObj, rowIndex, issues) {
  const raw = String(rowObj?.material ?? '').trim();
  if (raw === '' || raw.toUpperCase() === 'AIR') return raw;

  // Keep numeric material names (Nd/νd) as-is without automatic glass substitution.
  // Users can manually select glass if needed.
  if (__isNumericMaterialName(raw)) {
    issues.push({
      severity: 'info',
      phase: 'validate',
      message: `Numeric material at row ${rowIndex} (${raw}) kept as synthetic glass (Nd/νd-based).`
    });
    return raw;
  }

  return raw;
}

function getVariableValue(variables: any, key: string): any {
  if (!isPlainObject(variables)) return undefined;
  const entry = variables[key];
  if (!isPlainObject(entry)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(entry, 'value')) return undefined;
  return entry.value;
}

function getParamOrVarValue(parameters: any, variables: any, key: string): any {
  if (isPlainObject(parameters) && Object.prototype.hasOwnProperty.call(parameters, key)) {
    return parameters[key];
  }
  return getVariableValue(variables, key);
}

function shouldMarkV(variableEntry: any): boolean {
  // MVP: only UI mode 'V' means variable. Empty means fixed.
  if (variableEntry === true) return true;
  if (!isPlainObject(variableEntry)) return false;
  const optimize = variableEntry.optimize;
  if (!isPlainObject(optimize)) return false;
  return optimize.mode === 'V';
}

export function configurationHasBlocks(config: any): boolean {
  return isPlainObject(config) && Array.isArray(config.blocks);
}

/**
 * Validate blocks inside a configuration.
 * @param {any} config
 * @returns {LoadIssue[]}
 */
export function validateBlocksConfiguration(config: any): LoadIssue[] {
  const issues: LoadIssue[] = [];

  if (!configurationHasBlocks(config)) return issues;

  if (includesDisallowedSurfaceReference(config.blocks)) {
    issues.push({
      severity: 'fatal',
      phase: 'validate',
      message: 'Block.variables must use block-local coordinates only (surfaceId/surfaceIndex is forbidden).'
    });
    return issues;
  }

  // ObjectSurface/ObjectPlane rules: at most one.
  try {
    const nObjectSurface = (config.blocks || []).filter(b => String(b?.blockType ?? '').trim() === 'ObjectSurface').length;
    const nObjectPlane = (config.blocks || []).filter(b => String(b?.blockType ?? '').trim() === 'ObjectPlane').length;
    if (nObjectSurface + nObjectPlane > 1) {
      issues.push({
        severity: 'fatal',
        phase: 'validate',
        message: 'Only one ObjectSurface or ObjectPlane block is supported.'
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

    const blockType = block.blockType === 'ThinLens' ? 'Paraxial' : block.blockType;
    if (block.blockType === 'ThinLens') block.blockType = 'Paraxial';
    if (blockType !== 'ObjectSurface' && blockType !== 'ObjectPlane' && blockType !== 'Lens' && blockType !== 'PositiveLens' && blockType !== 'Paraxial' && blockType !== 'Doublet' && blockType !== 'Triplet' && blockType !== 'Gap' && blockType !== 'AirGap' && blockType !== 'Stop' && blockType !== 'CoordTrans' && blockType !== 'Mirror' && blockType !== 'SingleSurface' && blockType !== 'ImageSurface') {
      issues.push({
        severity: 'fatal',
        phase: 'validate',
        message: `Unsupported blockType: ${blockType} (MVP supports ObjectSurface, ObjectPlane, Lens, ThinLens, SingleSurface, Doublet, Triplet, Gap, Stop, CoordTrans, Mirror, ImageSurface only).`,
        blockId: block.blockId
      });
      continue;
    }

    const parameters = isPlainObject(block.parameters) ? block.parameters : {};
    const variables = block.variables;

    if (blockType !== 'ImageSurface') {
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

    if (blockType === 'ObjectSurface' || blockType === 'ObjectPlane') {
      const modeRaw = getParamOrVarValue(parameters, variables, 'objectDistanceMode');
      const mode = String(modeRaw ?? '').trim();
      const modeKey = mode.replace(/\s+/g, '').toUpperCase();
      const isInf = modeKey === 'INF' || modeKey === 'INFINITY';
      const isFinite = modeKey === '' || modeKey === 'FINITE';

      if (!isInf && !isFinite) {
        issues.push({
          severity: 'fatal',
          phase: 'validate',
          message: `${blockType}.objectDistanceMode must be Finite or INF (got: ${mode})`,
          blockId: block.blockId
        });
      }

      if (!isInf) {
        const d = getParamOrVarValue(parameters, variables, 'objectDistance');
        if (d === undefined) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `${blockType}.objectDistance is required when mode is Finite.`, blockId: block.blockId });
        } else {
          const v = normalizeThicknessToRowValue(d);
          if (v === 'INF') {
            issues.push({ severity: 'warning', phase: 'validate', message: `${blockType}.objectDistance is INF; treating as INF.`, blockId: block.blockId });
          } else if (typeof v === 'number' && Number.isFinite(v) && v <= 0) {
            issues.push({ severity: 'warning', phase: 'validate', message: `${blockType}.objectDistance is <= 0 (${String(v)}).`, blockId: block.blockId });
          }
        }
      }
      // Note: objectDistance is now allowed (optional) for INF mode, used as rendering position
    }

    if (blockType === 'SingleSurface') {
      const radius = getParamOrVarValue(parameters, variables, 'radius');
      const thickness = getParamOrVarValue(parameters, variables, 'thickness');
      const material = getParamOrVarValue(parameters, variables, 'material');

      // Optional asphere parameters
      const surfType = normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, 'surfType'));

      if (surfType && !ALLOWED_SURF_TYPES.has(surfType)) {
        issues.push({ severity: 'fatal', phase: 'validate', message: `SingleSurface.surfType must be one of: Spherical, Aspheric even, Aspheric odd, Toric. Got: ${surfType}`, blockId: block.blockId });
      }

      // Toric surfaces require radiusX and radiusY instead of radius
      if (surfType === 'Toric') {
        const radiusX = getParamOrVarValue(parameters, variables, 'radiusX');
        const radiusY = getParamOrVarValue(parameters, variables, 'radiusY');
        if (radiusX === undefined) {
          issues.push({ severity: 'fatal', phase: 'validate', message: 'SingleSurface.radiusX is required for Toric surfaces.', blockId: block.blockId });
        }
        if (radiusY === undefined) {
          issues.push({ severity: 'fatal', phase: 'validate', message: 'SingleSurface.radiusY is required for Toric surfaces.', blockId: block.blockId });
        }
      } else {
        if (radius === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'SingleSurface.radius is required.', blockId: block.blockId });
      }
      if (thickness === undefined) issues.push({ severity: 'fatal', phase: 'validate', message: 'SingleSurface.thickness is required.', blockId: block.blockId });

      // Material is optional for SingleSurface (can be air/vacuum)
      if (material !== undefined && material !== null && material !== '') {
        if (typeof material === 'string' && __isNumericMaterialName(material)) {
          issues.push({
            severity: 'warning',
            phase: 'validate',
            message: `SingleSurface.material is numeric (${material}). Treated as synthetic glass; dispersion may be inaccurate.`,
            blockId: block.blockId
          });
        } else if (typeof material === 'string' && !isKnownGlassNameOnly(material) && material.trim() !== 'AIR' && material.trim() !== '') {
          issues.push({
            severity: 'warning',
            phase: 'validate',
            message: `Unknown glass name (allowed for imported/legacy designs): ${material}`,
            blockId: block.blockId
          });
        }
      }

      // Aperture shape validation (same as Mirror)
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
        issues.push({ severity: 'warning', phase: 'validate', message: `SingleSurface.apertureShape is unknown (${shape}).`, blockId: block.blockId });
      }

      const semidiaRaw = getParamOrVarValue(parameters, variables, 'semidia');
      const widthRaw = getParamOrVarValue(parameters, variables, 'apertureWidth');
      const heightRaw = getParamOrVarValue(parameters, variables, 'apertureHeight');
      const semidiaVal = Number(String(semidiaRaw ?? '').trim());
      const widthVal = Number(String(widthRaw ?? '').trim());
      const heightVal = Number(String(heightRaw ?? '').trim());

      if (shape === 'Circular') {
        if (semidiaRaw !== undefined && (!Number.isFinite(semidiaVal) || semidiaVal <= 0)) {
          issues.push({ severity: 'warning', phase: 'validate', message: `SingleSurface.semidia should be positive for Circular aperture (${String(semidiaRaw)}).`, blockId: block.blockId });
        }
      } else if (shape === 'Square') {
        const side = Number.isFinite(widthVal) ? widthVal : heightVal;
        if (!Number.isFinite(side) || side <= 0) {
          issues.push({ severity: 'warning', phase: 'validate', message: `SingleSurface.apertureWidth should be positive for Square aperture (${String(widthRaw ?? heightRaw)}).`, blockId: block.blockId });
        }
      } else if (shape === 'Rectangular') {
        if (!Number.isFinite(widthVal) || widthVal <= 0 || !Number.isFinite(heightVal) || heightVal <= 0) {
          issues.push({ severity: 'warning', phase: 'validate', message: `SingleSurface.apertureWidth/Height should be positive for Rectangular aperture (w=${String(widthRaw)}, h=${String(heightRaw)}).`, blockId: block.blockId });
        }
      }

      // Check optimize modes
      if (isPlainObject(variables)) {
        for (const [k, v] of Object.entries(variables)) {
          const varEntry = v as any;
          if (!isPlainObject(varEntry) || !isPlainObject(varEntry.optimize) || varEntry.optimize.mode === undefined) continue;
          const mode = varEntry.optimize.mode;
          if (mode !== 'V' && mode !== '' && mode !== undefined && mode !== null) {
            issues.push({
              severity: 'warning',
              phase: 'validate',
              message: `variables.${k}.optimize.mode=${String(varEntry.optimize.mode)} is not supported yet; treating as fixed.`,
              blockId: block.blockId
            });
          }
        }
      }
    }

    if (blockType === 'Lens' || blockType === 'PositiveLens' || blockType === 'Paraxial') {
      const isThinLens = blockType === 'Paraxial';
      const lensFamilyName = isThinLens ? 'Paraxial' : 'Lens';

      const frontRadius = getParamOrVarValue(parameters, variables, 'frontRadius');
      const backRadius = getParamOrVarValue(parameters, variables, 'backRadius');
      const centerThickness = getParamOrVarValue(parameters, variables, 'centerThickness');
      const focalLength = getParamOrVarValue(parameters, variables, 'focalLength');
      const focalLengthX = getParamOrVarValue(parameters, variables, 'focalLengthX');
      const focalLengthY = getParamOrVarValue(parameters, variables, 'focalLengthY');
      const material = getParamOrVarValue(parameters, variables, 'material');

      // ThinLens now uses X/Y focal lengths and defaults to X/Y power behavior.
      const thinLensHasXYPower = isThinLens && (
        (focalLengthX !== undefined && String(focalLengthX ?? '').trim() !== '') ||
        (focalLengthY !== undefined && String(focalLengthY ?? '').trim() !== '')
      );
      const thinLensSurfType = isThinLens
        ? (normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, 'surfType')) || (thinLensHasXYPower ? 'Toric' : 'Toric'))
        : '';
      const frontSurfType = (isThinLens && thinLensSurfType)
        ? thinLensSurfType
        : normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, 'frontSurfType'));
      const backSurfType = isThinLens
        ? normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, 'backSurfType') || '')
        : normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, 'backSurfType'));

      if (frontSurfType && !ALLOWED_SURF_TYPES.has(frontSurfType)) {
        issues.push({ severity: 'fatal', phase: 'validate', message: `${lensFamilyName}.frontSurfType must be one of: Spherical, Aspheric even, Aspheric odd, Toric. Got: ${frontSurfType}`, blockId: block.blockId });
      }
      if (backSurfType && !ALLOWED_SURF_TYPES.has(backSurfType)) {
        issues.push({ severity: 'fatal', phase: 'validate', message: `${lensFamilyName}.backSurfType must be one of: Spherical, Aspheric even, Aspheric odd, Toric. Got: ${backSurfType}`, blockId: block.blockId });
      }

      const hasFrontRadius = !(frontRadius === undefined || String(frontRadius ?? '').trim() === '');
      const hasBackRadius = !(backRadius === undefined || String(backRadius ?? '').trim() === '');
      const needsDerivedRadii = isThinLens && (!hasFrontRadius || !hasBackRadius);

      if (needsDerivedRadii) {
        const focalBase = focalLengthY ?? focalLength ?? focalLengthX;
        if (focalBase === undefined || String(focalBase ?? '').trim() === '') {
          issues.push({ severity: 'fatal', phase: 'validate', message: 'ThinLens.focalLengthX or ThinLens.focalLengthY is required when radii are not given.', blockId: block.blockId });
        } else {
          const f = normalizeThicknessToRowValue(focalBase);
          if (typeof f !== 'number' && f !== 'INF') {
            issues.push({ severity: 'fatal', phase: 'validate', message: `ThinLens focal length must be numeric or INF (got: ${String(focalBase)})`, blockId: block.blockId });
          } else if (typeof f === 'number' && Math.abs(f) < 1e-12) {
            issues.push({ severity: 'fatal', phase: 'validate', message: 'ThinLens focal length must be non-zero.', blockId: block.blockId });
          }
        }
      }

      // Toric front surface validation
      if (frontSurfType === 'Toric') {
        const frontRadiusX = isThinLens
          ? (getParamOrVarValue(parameters, variables, 'radiusX') ?? getParamOrVarValue(parameters, variables, 'frontRadiusX'))
          : getParamOrVarValue(parameters, variables, 'frontRadiusX');
        if (!isThinLens && (frontRadiusX === undefined || String(frontRadiusX ?? '').trim() === '')) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `${lensFamilyName}.radiusX is required for Astigmatic (X/Y power).`, blockId: block.blockId });
        }
        if (!hasFrontRadius && !needsDerivedRadii) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `${lensFamilyName}.frontRadius is required for Toric front surface.`, blockId: block.blockId });
        }
      } else if (!hasFrontRadius && !needsDerivedRadii) {
        issues.push({ severity: 'fatal', phase: 'validate', message: `${lensFamilyName}.frontRadius is required.`, blockId: block.blockId });
      }

      // Toric back surface validation
      if (backSurfType === 'Toric') {
        const backRadiusX = isThinLens
          ? (getParamOrVarValue(parameters, variables, 'radiusX') ?? getParamOrVarValue(parameters, variables, 'backRadiusX'))
          : getParamOrVarValue(parameters, variables, 'backRadiusX');
        if (!isThinLens && (backRadiusX === undefined || String(backRadiusX ?? '').trim() === '')) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `${lensFamilyName}.backRadiusX is required for Toric back surface.`, blockId: block.blockId });
        }
        if (!hasBackRadius && !needsDerivedRadii) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `${lensFamilyName}.backRadius is required for Toric back surface.`, blockId: block.blockId });
        }
      } else if (!hasBackRadius && !needsDerivedRadii) {
        issues.push({ severity: 'fatal', phase: 'validate', message: `${lensFamilyName}.backRadius is required.`, blockId: block.blockId });
      }

      if (!isThinLens && centerThickness === undefined) {
        issues.push({ severity: 'fatal', phase: 'validate', message: 'Lens.centerThickness is required.', blockId: block.blockId });
      }

      if (!isThinLens) {
        if (typeof material !== 'string' || material.trim() === '') {
          issues.push({ severity: 'warning', phase: 'validate', message: `${lensFamilyName}.material is empty; will default to N-BK7 in expansion.`, blockId: block.blockId });
        } else if (__isNumericMaterialName(material)) {
          issues.push({
            severity: 'warning',
            phase: 'validate',
            message: `${lensFamilyName}.material is numeric (${material}). Treated as synthetic glass; dispersion may be inaccurate.`,
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
      }

      // Future modes: warn but do not fail.
      if (isPlainObject(variables)) {
        for (const [k, v] of Object.entries(variables)) {
          const varEntry = v as any;
          if (!isPlainObject(varEntry) || !isPlainObject(varEntry.optimize) || varEntry.optimize.mode === undefined) continue;
          const mode = varEntry.optimize.mode;
          if (mode !== 'V' && mode !== '' && mode !== undefined && mode !== null) {
            issues.push({
              severity: 'warning',
              phase: 'validate',
              message: `variables.${k}.optimize.mode=${String(varEntry.optimize.mode)} is not supported yet; treating as fixed.`,
              blockId: block.blockId
            });
          }
        }
      }

      // Numeric sanity checks (non-fatal: allow 0/INF mapping later)
      if (!isThinLens && centerThickness !== undefined) {
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
        issues.push({ severity: 'warning', phase: 'validate', message: 'Doublet.material1 is empty; will default to N-BK7 in expansion.', blockId: block.blockId });
      } else if (__isNumericMaterialName(material1)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Doublet.material1 is numeric (${material1}). Treated as synthetic glass; dispersion may be inaccurate.`, blockId: block.blockId });
      } else if (!isKnownGlassNameOnly(material1)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name (allowed for imported/legacy designs): ${material1}`, blockId: block.blockId });
      }
      if (typeof material2 !== 'string' || material2.trim() === '') {
        issues.push({ severity: 'warning', phase: 'validate', message: 'Doublet.material2 is empty; will default to N-SF5 in expansion.', blockId: block.blockId });
      } else if (__isNumericMaterialName(material2)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Doublet.material2 is numeric (${material2}). Treated as synthetic glass; dispersion may be inaccurate.`, blockId: block.blockId });
      } else if (!isKnownGlassNameOnly(material2)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name (allowed for imported/legacy designs): ${material2}`, blockId: block.blockId });
      }

      for (let si = 1; si <= 3; si++) {
        const st = normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, `surf${si}SurfType`));
        if (st && !ALLOWED_SURF_TYPES.has(st)) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `Doublet.surf${si}SurfType must be one of: Spherical, Aspheric even, Aspheric odd, Toric. Got: ${st}`, blockId: block.blockId });
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
        issues.push({ severity: 'warning', phase: 'validate', message: 'Triplet.material1 is empty; will default to N-BK7 in expansion.', blockId: block.blockId });
      } else if (__isNumericMaterialName(material1)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Triplet.material1 is numeric (${material1}). Treated as synthetic glass; dispersion may be inaccurate.`, blockId: block.blockId });
      } else if (!isKnownGlassNameOnly(material1)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name (allowed for imported/legacy designs): ${material1}`, blockId: block.blockId });
      }
      if (typeof material2 !== 'string' || material2.trim() === '') {
        issues.push({ severity: 'warning', phase: 'validate', message: 'Triplet.material2 is empty; will default to N-SF5 in expansion.', blockId: block.blockId });
      } else if (__isNumericMaterialName(material2)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Triplet.material2 is numeric (${material2}). Treated as synthetic glass; dispersion may be inaccurate.`, blockId: block.blockId });
      } else if (!isKnownGlassNameOnly(material2)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name (allowed for imported/legacy designs): ${material2}`, blockId: block.blockId });
      }
      if (typeof material3 !== 'string' || material3.trim() === '') {
        issues.push({ severity: 'warning', phase: 'validate', message: 'Triplet.material3 is empty; will default to N-BK7 in expansion.', blockId: block.blockId });
      } else if (__isNumericMaterialName(material3)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Triplet.material3 is numeric (${material3}). Treated as synthetic glass; dispersion may be inaccurate.`, blockId: block.blockId });
      } else if (!isKnownGlassNameOnly(material3)) {
        issues.push({ severity: 'warning', phase: 'validate', message: `Unknown glass name (allowed for imported/legacy designs): ${material3}`, blockId: block.blockId });
      }

      for (let si = 1; si <= 4; si++) {
        const st = normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, `surf${si}SurfType`));
        if (st && !ALLOWED_SURF_TYPES.has(st)) {
          issues.push({ severity: 'fatal', phase: 'validate', message: `Triplet.surf${si}SurfType must be one of: Spherical, Aspheric even, Aspheric odd, Toric. Got: ${st}`, blockId: block.blockId });
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
      const coordReturnRaw = getParamOrVarValue(parameters, variables, 'coordReturn');
      const toSurfRaw = getParamOrVarValue(parameters, variables, 'toSurf');

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

      try {
        const s = String(coordReturnRaw ?? '').trim().toLowerCase();
        if (s !== '' && s !== 'none' && s !== 'orientation' && s !== 'xy' && s !== 'xyz') {
          issues.push({ severity: 'warning', phase: 'validate', message: `CoordTrans.coordReturn should be one of none/orientation/xy/xyz (got: ${String(coordReturnRaw)}).`, blockId: block.blockId });
        }
      } catch (_) {}

      try {
        const s = String(toSurfRaw ?? '').trim();
        if (s !== '') {
          const n = (typeof toSurfRaw === 'number') ? toSurfRaw : (isNumericString(s) ? Number(s) : NaN);
          if (!Number.isFinite(n) || n < 0) {
            issues.push({ severity: 'warning', phase: 'validate', message: `CoordTrans.toSurf should be a non-negative integer when provided (got: ${String(toSurfRaw)}).`, blockId: block.blockId });
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

    if (blockType === 'ImageSurface') {
      // ImageSurface now supports SingleSurface parameters (except material and abbe)
      const surfType = normalizeSurfTypeValue(getParamOrVarValue(parameters, variables, 'surfType'));

      if (surfType && !ALLOWED_SURF_TYPES.has(surfType)) {
        issues.push({ severity: 'fatal', phase: 'validate', message: `ImageSurface.surfType must be one of: Spherical, Aspheric even, Aspheric odd, Toric. Got: ${surfType}`, blockId: block.blockId });
      }

      // Toric surfaces require radiusX and radiusY instead of radius
      if (surfType === 'Toric') {
        const radiusX = getParamOrVarValue(parameters, variables, 'radiusX');
        const radiusY = getParamOrVarValue(parameters, variables, 'radiusY');
        if (radiusX === undefined) {
          issues.push({ severity: 'warning', phase: 'validate', message: 'ImageSurface with Toric surfType should have radiusX defined.', blockId: block.blockId });
        }
        if (radiusY === undefined) {
          issues.push({ severity: 'warning', phase: 'validate', message: 'ImageSurface with Toric surfType should have radiusY defined.', blockId: block.blockId });
        }
      }

      // Aperture shape validation (same as SingleSurface)
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
        issues.push({ severity: 'warning', phase: 'validate', message: `ImageSurface.apertureShape is unknown (${shape}).`, blockId: block.blockId });
      }

      const semidiaRaw = getParamOrVarValue(parameters, variables, 'semidia');
      const widthRaw = getParamOrVarValue(parameters, variables, 'apertureWidth');
      const heightRaw = getParamOrVarValue(parameters, variables, 'apertureHeight');
      const semidiaVal = Number(String(semidiaRaw ?? '').trim());
      const widthVal = Number(String(widthRaw ?? '').trim());
      const heightVal = Number(String(heightRaw ?? '').trim());

      if (shape === 'Circular') {
        if (semidiaRaw !== undefined && (!Number.isFinite(semidiaVal) || semidiaVal <= 0)) {
          issues.push({ severity: 'warning', phase: 'validate', message: `ImageSurface.semidia should be positive for Circular aperture (${String(semidiaRaw)}).`, blockId: block.blockId });
        }
      } else if (shape === 'Square') {
        const side = Number.isFinite(widthVal) ? widthVal : heightVal;
        if (!Number.isFinite(side) || side <= 0) {
          issues.push({ severity: 'warning', phase: 'validate', message: `ImageSurface.apertureWidth should be positive for Square aperture (${String(widthRaw ?? heightRaw)}).`, blockId: block.blockId });
        }
      } else if (shape === 'Rectangular') {
        if (!Number.isFinite(widthVal) || widthVal <= 0 || !Number.isFinite(heightVal) || heightVal <= 0) {
          issues.push({ severity: 'warning', phase: 'validate', message: `ImageSurface.apertureWidth/Height should be positive for Rectangular aperture (w=${String(widthRaw)}, h=${String(heightRaw)}).`, blockId: block.blockId });
        }
      }

      // Legacy semidia mode validation
      const modeRaw = parameters?.semidiaMode;
      if (modeRaw !== undefined && modeRaw !== null && String(modeRaw).trim() !== '') {
        const m = String(modeRaw).trim().toLowerCase();
        if (m !== 'manual' && m !== 'auto') {
          issues.push({ severity: 'warning', phase: 'validate', message: `ImageSurface.parameters.semidiaMode supports only 'Manual' or 'Auto' (got: ${String(modeRaw)}); ignoring.`, blockId: block.blockId });
        }
      }

      const optRaw = parameters?.optimizeSemiDia;
      if (optRaw !== undefined && optRaw !== null && String(optRaw).trim() !== '') {
        const s = String(optRaw).trim();
        if (s !== 'A' && s !== 'a') {
          issues.push({ severity: 'warning', phase: 'validate', message: `ImageSurface.parameters.optimizeSemiDia supports only 'A' (got: ${s}); ignoring.`, blockId: block.blockId });
        }
      }

      if (isPlainObject(variables) && Object.keys(variables).length > 0) {
        issues.push({
          severity: 'warning',
          phase: 'validate',
          message: 'ImageSurface.variables is ignored (Image plane is not a design variable).',
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

function createDefaultObjectRow(): any {
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

function createDefaultImageRow(id: number, overrides: any = null): any {
  const ov = (overrides && typeof overrides === 'object') ? overrides : null;
  const getOvValue = (key, defaultVal = '') => 
    ov && Object.prototype.hasOwnProperty.call(ov, key) ? ov[key] : defaultVal;
  
  return {
    id,
    'object type': 'Image',
    surfType: getOvValue('surfType', 'Spherical'),
    comment: '',
    radius: getOvValue('radius', 'INF'),
    radiusX: getOvValue('radiusX', ''),
    radiusY: getOvValue('radiusY', ''),
    axis: getOvValue('axis', ''),
    optimizeR: '',
    thickness: getOvValue('thickness', ''),
    optimizeT: '',
    semidia: getOvValue('semidia', ''),
    optimizeSemiDia: getOvValue('optimizeSemiDia', ''),
    apertureShape: getOvValue('apertureShape', 'Circular'),
    apertureWidth: getOvValue('apertureWidth', ''),
    apertureHeight: getOvValue('apertureHeight', ''),
    material: '',
    optimizeMaterial: '',
    rindex: '',
    optimizeRI: '',
    abbe: '',
    optimizeAbbe: '',
    conic: getOvValue('conic', ''),
    optimizeConic: '',
    coef1: getOvValue('coef1', ''),
    optimizeCoef1: '',
    coef2: getOvValue('coef2', ''),
    optimizeCoef2: '',
    coef3: getOvValue('coef3', ''),
    optimizeCoef3: '',
    coef4: getOvValue('coef4', ''),
    optimizeCoef4: '',
    coef5: getOvValue('coef5', ''),
    optimizeCoef5: '',
    coef6: getOvValue('coef6', ''),
    optimizeCoef6: '',
    coef7: getOvValue('coef7', ''),
    optimizeCoef7: '',
    coef8: getOvValue('coef8', ''),
    optimizeCoef8: '',
    coef9: getOvValue('coef9', ''),
    optimizeCoef9: '',
    coef10: getOvValue('coef10', ''),
    optimizeCoef10: ''
  };
}

function createBlankSurfaceRow(id: number, prevRow: any): any {
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
export function expandBlocksToOpticalSystemRows(blocks: Block[], options?: { disableAutoZoomLawConstants?: boolean }): { rows: any[]; issues: LoadIssue[] } {
  const startMs = performance.now();
  try {
  const issues: LoadIssue[] = [];

  if (!Array.isArray(blocks)) {
    issues.push({ severity: 'fatal', phase: 'expand', message: 'blocks must be an array.' });
    return { rows: [], issues };
  }

  const effectiveBlocks = applyZoomMotionToBlocks(blocks, options);

  const rows: any[] = [createDefaultObjectRow()];
  rows[0]._blockType = 'Object';
  rows[0]._blockId = null;

  // Process ObjectSurface/ObjectPlane first to ensure it's always at surface 0
  const objectSurfaceBlock = effectiveBlocks.find(b => {
    const type = isPlainObject(b) ? b.blockType : null;
    return type === 'ObjectSurface' || type === 'ObjectPlane';
  });

  if (objectSurfaceBlock && isPlainObject(objectSurfaceBlock)) {
    const params = objectSurfaceBlock.parameters;
    const vars = isPlainObject(objectSurfaceBlock.variables) ? objectSurfaceBlock.variables : null;
    try {
      const modeRaw = getParamOrVarValue(params, vars, 'objectDistanceMode');
      const mode = String(modeRaw ?? '').trim().replace(/\s+/g, '').toUpperCase();
      if (mode === 'INF' || mode === 'INFINITY') {
        rows[0].thickness = 'INF';
        const distRaw = getParamOrVarValue(params, vars, 'objectDistance');
        const distVal = normalizeThicknessToRowValue(distRaw);
        rows[0].objectRenderDistance = (typeof distVal === 'number' && Number.isFinite(distVal)) ? distVal : 10;
      } else {
        const distRaw = getParamOrVarValue(params, vars, 'objectDistance');
        rows[0].thickness = normalizeThicknessToRowValue(distRaw);
        delete rows[0].objectRenderDistance;
      }
    } catch (_) {
      // ignore
    }
  }

  const getLastRow = () => rows[rows.length - 1];

  const isStopRow = (r) => r && (r['object type'] === 'Stop' || r.object === 'Stop');

  const isCoordTransRow = (r) => {
    try {
      const st = String(r?.surfType ?? r?.['surf type'] ?? r?.type ?? '').trim().toLowerCase();
      return st === 'coord trans' || st === 'coordinate transform' || st === 'ct' || st === 'coordtrans' || st === 'coordinatetransform';
    } catch (_) {
      return false;
    }
  };

  // For semidia inheritance, skip Stop and Coord Trans rows so their special fields
  // (Stop.semiDiameter / CoordTrans decenterX) do not "bleed" into following surfaces.
  const getLastNonStopRow = () => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!isStopRow(rows[i]) && !isCoordTransRow(rows[i])) return rows[i];
    }
    return rows[0];
  };

  // Gap blocks attach thickness/material to the previous surface row.
  // Coord Trans rows reuse thickness/material for decenter parameters, so we store gap spacing separately.
  const getLastNonCoordTransRow = () => {
    for (let i = rows.length - 1; i >= 0; i--) {
      // Stop rows don't have refractive material, so skip them like CoordTrans rows
      if (!isStopRow(rows[i]) && !isCoordTransRow(rows[i])) return rows[i];
    }
    return rows[0];
  };

  let sawImageSurface = false;
  let imagePlaneBlockId = null;
  let imagePlaneOverrides = null;
  let imagePlaneVariables = null;
  let currentZSign = 1;

  const applySignedThickness = (value) => {
    if (value === 'INF') return 'INF';
    if (typeof value === 'number' && Number.isFinite(value)) return value * currentZSign;
    return value;
  };

  for (const block of effectiveBlocks) {
    const blockId = isPlainObject(block) ? block.blockId : undefined;

    if (!isPlainObject(block)) {
      issues.push({ severity: 'fatal', phase: 'expand', message: 'Block must be an object.', blockId });
      continue;
    }

    const type = block.blockType;
    const params = block.parameters;
    const vars = isPlainObject(block.variables) ? block.variables : null;
    const aperture = isPlainObject(block.aperture) ? block.aperture : null;

    if (type === 'ObjectSurface' || type === 'ObjectPlane') {
      // ObjectSurface/ObjectPlane was already processed before the loop to ensure it's at surface 0
      continue;
    }

    if (sawImageSurface) {
      issues.push({
        severity: 'warning',
        phase: 'expand',
        message: 'Blocks after ImageSurface are ignored.',
        blockId
      });
      continue;
    }

    if (type === 'ImageSurface') {
      sawImageSurface = true;
      imagePlaneBlockId = blockId || null;
      imagePlaneVariables = isPlainObject(vars) ? vars : null;

      // Apply SingleSurface parameters to ImageSurface row overrides (except material and abbe)
      try {
        const p = isPlainObject(params) ? params : {};
        const ov: any = {};

        // Copy SingleSurface parameters (except material and abbe)
        const paramsToCopy = [
          'surfType', 'radius', 'radiusX', 'radiusY', 'axis', 'thickness',
          'conic', 'coef1', 'coef2', 'coef3', 'coef4', 'coef5',
          'coef6', 'coef7', 'coef8', 'coef9', 'coef10',
          'apertureShape', 'semidia', 'apertureWidth', 'apertureHeight'
        ];

        for (const paramName of paramsToCopy) {
          if (Object.prototype.hasOwnProperty.call(p, paramName)) {
            const val = p[paramName];
            const s = String(val ?? '').trim();
            if (s !== '') ov[paramName] = val;
          }
        }

        // Handle legacy semidia modes
        if (Object.prototype.hasOwnProperty.call(p, 'optimizeSemiDia')) {
          const s = String(p.optimizeSemiDia ?? '').trim();
          if (s !== '') ov.optimizeSemiDia = p.optimizeSemiDia;
        }
        if (Object.prototype.hasOwnProperty.call(p, 'semidiaMode')) {
          const m = String(p.semidiaMode ?? '').trim().toLowerCase();
          if (m === 'auto') {
            ov.optimizeSemiDia = 'A';
          } else if (m === 'manual') {
            ov.optimizeSemiDia = '';
          }
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
        // If material is not specified or is AIR, preserve any manually-set rindex/abbe (synthetic glass)
        if (!glassName || glassName.toUpperCase() === 'AIR') return;
        const glass = getGlassDataWithSellmeier(glassName);
        // Only update if glass data is found; otherwise preserve existing rindex/abbe
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

    const hasVFlag = (vars, key) => !!(vars && Object.prototype.hasOwnProperty.call(vars, key) && shouldMarkV(vars[key]));
    const hasAnyCoefV = (vars, prefix, count = 10) => {
      if (!vars) return false;
      for (let i = 1; i <= count; i++) {
        const k = `${prefix}${i}`;
        if (Object.prototype.hasOwnProperty.call(vars, k) && shouldMarkV(vars[k])) return true;
      }
      return false;
    };

    const applyAsphereFieldsFromParams = (row, surfTypeRaw, conicRaw, coefsRaw, radiusXRaw, radiusYRaw, axisRaw, forceAsphere = false) => {
      const stNorm = normalizeSurfTypeValue(surfTypeRaw);
      let st = (stNorm && ALLOWED_SURF_TYPES.has(stNorm)) ? stNorm : '';
      if (forceAsphere && (!st || st === 'Spherical')) {
        st = 'Aspheric even';
      }
      row.surfType = st || (blockAsphereLooksNonZero({ surfType: stNorm, conic: conicRaw, coefs: coefsRaw }) ? 'Aspheric even' : 'Spherical');
      
      if (row.surfType === 'Toric') {
        // Toric surfaces use radiusX (tangential) and row.radius (sagittal/radiusY)
        // radiusY is always taken from row.radius, not a separate parameter
        
        // Only set radiusX if radiusXRaw is explicitly provided
        // Do NOT default to row.radius if radiusXRaw is undefined - that would overwrite user's radiusX
        if (radiusXRaw !== undefined) {
          row.radiusX = normalizeRadiusToRowValue(radiusXRaw);
        }
        // If radiusXRaw is undefined and row.radiusX doesn't exist yet, keep row.radiusX as is
        
        row.radiusY = row.radius; // Use existing radius field for Y direction
        row.axis = normalizeOptionalNumberToRowValue(axisRaw);
        row.conic = normalizeOptionalNumberToRowValue(conicRaw);
        // Toric surfaces don't use aspheric coefficients in initial implementation
        for (let i = 0; i < 10; i++) row[`coef${i + 1}`] = '';
      } else if (row.surfType === 'Spherical') {
        // Keep conic for spherical surfaces (k-only conic section is valid).
        row.conic = normalizeOptionalNumberToRowValue(conicRaw);
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

    if (type === 'Lens' || type === 'PositiveLens' || type === 'Paraxial') {
      const isThinLens = type === 'Paraxial';
      const front = createBlankSurfaceRow(rows.length, getLastNonStopRow());
      const back = createBlankSurfaceRow(rows.length + 1, front);

      front._blockType = isThinLens ? 'Paraxial' : 'Lens';
      front._blockId = blockId || null;
      back._blockType = isThinLens ? 'Paraxial' : 'Lens';
      back._blockId = blockId || null;

      // Stable role tags for Surface -> Block reverse mapping (Apply to Design Intent)
      front._surfaceRole = 'front';
      back._surfaceRole = 'back';

      // Persisted aperture (semidia) stored in Design Intent.
      // If aperture is not defined, clear inherited semidia to match Design Intent.
      try {
        const vFront = aperture ? (aperture.front ?? aperture.s1 ?? aperture.semidia) : null;
        const vBack = aperture ? (isThinLens ? (aperture.back ?? aperture.front ?? aperture.s1 ?? aperture.semidia) : aperture.back) : null;
        if (vFront !== null && vFront !== undefined && String(vFront).trim() !== '') {
          front.semidia = vFront;
          front.__cooptExplicitApertureSemidia = vFront;
        } else if (!aperture || !Object.prototype.hasOwnProperty.call(aperture, 'front')) {
          front.semidia = '';
        }
        if (vBack !== null && vBack !== undefined && String(vBack).trim() !== '') {
          back.semidia = vBack;
          back.__cooptExplicitApertureSemidia = vBack;
        } else if (!aperture || (!Object.prototype.hasOwnProperty.call(aperture, 'back') && !isThinLens)) {
          back.semidia = '';
        }
      } catch (_) {}

      const material = getParamOrVarValue(params, vars, 'material');
      const rindex = getParamOrVarValue(params, vars, 'rindex');
      const abbe = getParamOrVarValue(params, vars, 'abbe');
      const focalLength = getParamOrVarValue(params, vars, 'focalLength');
      const focalLengthX = getParamOrVarValue(params, vars, 'focalLengthX');
      const focalLengthY = getParamOrVarValue(params, vars, 'focalLengthY');

      if (isThinLens) {
        const thinLensFx = normalizeThicknessToRowValue(focalLengthX ?? focalLength ?? focalLengthY);
        const thinLensFy = normalizeThicknessToRowValue(focalLengthY ?? focalLength ?? focalLengthX);
        front._idealThinLens = true;
        back._idealThinLens = true;
        front._thinLensFocalLengthX = thinLensFx;
        front._thinLensFocalLengthY = thinLensFy;
        back._thinLensFocalLengthX = thinLensFx;
        back._thinLensFocalLengthY = thinLensFy;
      }

      let frontRadius = getParamOrVarValue(params, vars, 'frontRadius');
      let backRadius = getParamOrVarValue(params, vars, 'backRadius');
      let centerThickness = getParamOrVarValue(params, vars, 'centerThickness');
      let derivedThinLens: any = null;

      if (isThinLens) {
        derivedThinLens = computeThinLensSurfaceRadii({ focalLength, focalLengthX, focalLengthY, material, rindex });
        const hasFrontRadius = !(frontRadius === undefined || String(frontRadius ?? '').trim() === '');
        const hasBackRadius = !(backRadius === undefined || String(backRadius ?? '').trim() === '');
        if (!hasFrontRadius) frontRadius = derivedThinLens.frontRadius;
        if (!hasBackRadius) backRadius = derivedThinLens.backRadius;
        centerThickness = 0;
      }

      // ThinLens no longer exposes conic/axis/coef inputs.
      const thinLensHasXYInputs = isThinLens && (
        (focalLengthX !== undefined && String(focalLengthX ?? '').trim() !== '') ||
        (focalLengthY !== undefined && String(focalLengthY ?? '').trim() !== '') ||
        (getParamOrVarValue(params, vars, 'radiusX') !== undefined && String(getParamOrVarValue(params, vars, 'radiusX') ?? '').trim() !== '')
      );
      const thinSurfTypeRaw = isThinLens ? (getParamOrVarValue(params, vars, 'surfType') || (thinLensHasXYInputs ? 'Toric' : 'Toric')) : getParamOrVarValue(params, vars, 'surfType');
      const thinConicRaw = isThinLens ? '' : getParamOrVarValue(params, vars, 'conic');
      const thinCoefsRaw = isThinLens ? Array.from({ length: 10 }, () => '') : Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `coef${i + 1}`));

      const frontSurfTypeRaw = isThinLens ? thinSurfTypeRaw : getParamOrVarValue(params, vars, 'frontSurfType');
      const backSurfTypeRaw = isThinLens
        ? (normalizeSurfTypeValue(thinSurfTypeRaw) === 'Toric' ? thinSurfTypeRaw : getParamOrVarValue(params, vars, 'backSurfType'))
        : getParamOrVarValue(params, vars, 'backSurfType');
      const frontConicRaw = isThinLens ? thinConicRaw : getParamOrVarValue(params, vars, 'frontConic');
      const backConicRaw = isThinLens ? thinConicRaw : getParamOrVarValue(params, vars, 'backConic');
      const frontCoefsRaw = isThinLens
        ? thinCoefsRaw
        : Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `frontCoef${i + 1}`));
      const backCoefsRaw = isThinLens
        ? (normalizeSurfTypeValue(thinSurfTypeRaw) === 'Toric' ? thinCoefsRaw : Array.from({ length: 10 }, () => ''))
        : Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `backCoef${i + 1}`));
      
      // Toric parameters (radiusX for tangential, regular radius used for sagittal)
      const frontRadiusXRaw = isThinLens ? (getParamOrVarValue(params, vars, 'radiusX') ?? derivedThinLens?.frontRadiusX) : getParamOrVarValue(params, vars, 'frontRadiusX');
      const frontAxisRaw = isThinLens ? 0 : getParamOrVarValue(params, vars, 'frontAxis');
      const backRadiusXRaw = isThinLens ? (getParamOrVarValue(params, vars, 'radiusX') ?? derivedThinLens?.backRadiusX) : getParamOrVarValue(params, vars, 'backRadiusX');
      const backAxisRaw = isThinLens ? 0 : getParamOrVarValue(params, vars, 'backAxis');



      front.radius = normalizeRadiusToRowValue(frontRadius);
      front.thickness = applySignedThickness(normalizeThicknessToRowValue(centerThickness));
      
      // If material is missing or empty, use default N-BK7 (for legacy/imported data)
      const materialStr = String(material ?? '').trim();
      const usedDefaultMaterial = !materialStr;
      if (usedDefaultMaterial) {
        front.material = 'N-BK7';
        if (!isThinLens) {
          issues.push({
            severity: 'warning',
            phase: 'expand',
            message: 'Lens.material was empty; defaulting to N-BK7.',
            blockId
          });
        }
      } else {
        front.material = materialStr;
      }
      
      // Apply directly-specified rindex/abbe (synthetic glass) only if material was user-specified
      // If default material was used, let applyDerivedGlassDisplay fetch from glass catalog
      if (!usedDefaultMaterial) {
        if (rindex !== undefined && rindex !== null && String(rindex).trim() !== '') {
          front.rindex = String(rindex);
        }
        if (abbe !== undefined && abbe !== null && String(abbe).trim() !== '') {
          front.abbe = String(abbe);
        }
      }

      applyDerivedGlassDisplay(front);

      const frontForceAsphere = isThinLens ? false : (hasVFlag(vars, 'frontConic') || hasAnyCoefV(vars, 'frontCoef'));
      const backForceAsphere = isThinLens ? false : (hasVFlag(vars, 'backConic') || hasAnyCoefV(vars, 'backCoef'));

      applyAsphereFieldsFromParams(front, frontSurfTypeRaw, frontConicRaw, frontCoefsRaw, frontRadiusXRaw, undefined, frontAxisRaw, frontForceAsphere);

      back.radius = normalizeRadiusToRowValue(backRadius);
      back.thickness = 0; // post spacing is handled by AirGap block only
      back.material = 'AIR';

      applyAsphereFieldsFromParams(back, backSurfTypeRaw, backConicRaw, backCoefsRaw, backRadiusXRaw, undefined, backAxisRaw, backForceAsphere);

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
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'frontConic') && shouldMarkV(vars.frontConic)) {
        applyVFlag(front, 'optimizeConic');
      }
      for (let i = 1; i <= 10; i++) {
        const frontKey = `frontCoef${i}`;
        if (vars && Object.prototype.hasOwnProperty.call(vars, frontKey) && shouldMarkV(vars[frontKey])) {
          applyVFlag(front, `optimizeCoef${i}`);
        }
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'backRadius') && shouldMarkV(vars.backRadius)) {
        applyVFlag(back, 'optimizeR');
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'backConic') && shouldMarkV(vars.backConic)) {
        applyVFlag(back, 'optimizeConic');
      }
      for (let i = 1; i <= 10; i++) {
        const backKey = `backCoef${i}`;
        if (vars && Object.prototype.hasOwnProperty.call(vars, backKey) && shouldMarkV(vars[backKey])) {
          applyVFlag(back, `optimizeCoef${i}`);
        }
      }

      rows.push(front, back);
      continue;
    }

    if (type === 'SingleSurface') {
      const surf = createBlankSurfaceRow(rows.length, getLastNonStopRow());

      surf._blockType = 'SingleSurface';
      surf._blockId = blockId || null;
      surf._surfaceRole = 'single';

      const radius = getParamOrVarValue(params, vars, 'radius');
      const thickness = getParamOrVarValue(params, vars, 'thickness');
      const material = getParamOrVarValue(params, vars, 'material');
      const rindex = getParamOrVarValue(params, vars, 'rindex');
      const abbe = getParamOrVarValue(params, vars, 'abbe');

      // Optional asphere parameters
      const surfTypeRaw = getParamOrVarValue(params, vars, 'surfType');
      const conicRaw = getParamOrVarValue(params, vars, 'conic');
      const coefsRaw = Array.from({ length: 10 }, (_, i) => getParamOrVarValue(params, vars, `coef${i + 1}`));
      
      // Toric parameters
      const radiusXRaw = getParamOrVarValue(params, vars, 'radiusX');
      const radiusYRaw = getParamOrVarValue(params, vars, 'radiusY');
      const axisRaw = getParamOrVarValue(params, vars, 'axis');

      surf.radius = normalizeRadiusToRowValue(radius);
      surf.thickness = applySignedThickness(normalizeThicknessToRowValue(thickness));
      surf.material = String(material ?? '').trim();
      
      // Apply directly-specified rindex/abbe (synthetic glass) if provided
      if (rindex !== undefined && rindex !== null && String(rindex).trim() !== '') {
        surf.rindex = String(rindex);
      }
      if (abbe !== undefined && abbe !== null && String(abbe).trim() !== '') {
        surf.abbe = String(abbe);
      }

      applyDerivedGlassDisplay(surf);
      const surfForceAsphere = hasVFlag(vars, 'conic') || hasAnyCoefV(vars, 'coef');
      applyAsphereFieldsFromParams(surf, surfTypeRaw, conicRaw, coefsRaw, radiusXRaw, radiusYRaw, axisRaw, surfForceAsphere);

      // Aperture shape handling (same as Mirror)
      const shape = normalizeApertureShape(getParamOrVarValue(params, vars, 'apertureShape'));
      const semidiaRaw = getParamOrVarValue(params, vars, 'semidia');
      const widthRaw = getParamOrVarValue(params, vars, 'apertureWidth');
      const heightRaw = getParamOrVarValue(params, vars, 'apertureHeight');
      const widthVal = Number(String(widthRaw ?? '').trim());
      const heightVal = Number(String(heightRaw ?? '').trim());

      surf._apertureShape = shape;
      if (shape === 'Circular') {
        // Persisted aperture (semidia) stored in Design Intent
        if (semidiaRaw !== null && semidiaRaw !== undefined && String(semidiaRaw).trim() !== '') {
          surf.semidia = semidiaRaw;
        } else {
          const vSemidia = aperture ? aperture.semidia : null;
          if (vSemidia !== null && vSemidia !== undefined && String(vSemidia).trim() !== '') {
            surf.semidia = vSemidia;
          } else if (!aperture || !Object.prototype.hasOwnProperty.call(aperture, 'semidia')) {
            surf.semidia = '';
          }
        }
      } else {
        const w = Number.isFinite(widthVal) && widthVal > 0 ? widthVal : NaN;
        const h = Number.isFinite(heightVal) && heightVal > 0 ? heightVal : NaN;
        const side = (shape === 'Square') ? (Number.isFinite(w) ? w : h) : NaN;
        const finalW = (shape === 'Square') ? side : w;
        const finalH = (shape === 'Square') ? side : h;
        if (Number.isFinite(finalW)) surf._apertureWidth = finalW;
        if (Number.isFinite(finalH)) surf._apertureHeight = finalH;
        const maxDim = Math.max(Number.isFinite(finalW) ? finalW : 0, Number.isFinite(finalH) ? finalH : 0);
        surf.semidia = (maxDim > 0) ? String(maxDim / 2) : '';
      }

      // V flags for optimization
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius') && shouldMarkV(vars.radius)) {
        applyVFlag(surf, 'optimizeR');
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness') && shouldMarkV(vars.thickness)) {
        applyVFlag(surf, 'optimizeT');
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'material') && shouldMarkV(vars.material)) {
        applyVFlag(surf, 'optimizeMaterial');
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'conic') && shouldMarkV(vars.conic)) {
        applyVFlag(surf, 'optimizeConic');
      }
      for (let i = 1; i <= 10; i++) {
        const key = `coef${i}`;
        if (vars && Object.prototype.hasOwnProperty.call(vars, key) && shouldMarkV(vars[key])) {
          applyVFlag(surf, `optimizeCoef${i}`);
        }
      }

      rows.push(surf);
      continue;
    }

    if (type === 'CoordTrans') {
      const cb = createBlankSurfaceRow(rows.length, getLastNonStopRow());

      cb._blockType = 'CoordTrans';
      cb._blockId = blockId || null;
      cb._surfaceRole = 'ct';

      cb.surfType = 'Coord Trans';
      cb.radius = 'INF';

      const decenterX = getParamOrVarValue(params, vars, 'decenterX');
      const decenterY = getParamOrVarValue(params, vars, 'decenterY');
      const decenterZ = getParamOrVarValue(params, vars, 'decenterZ');
      const tiltX = getParamOrVarValue(params, vars, 'tiltX');
      const tiltY = getParamOrVarValue(params, vars, 'tiltY');
      const tiltZ = getParamOrVarValue(params, vars, 'tiltZ');
      const order = getParamOrVarValue(params, vars, 'order');
      const coordReturn = getParamOrVarValue(params, vars, 'coordReturn');
      const toSurf = getParamOrVarValue(params, vars, 'toSurf');

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
      cb.coordReturn = (() => {
        const s = String(coordReturn ?? '').trim().toLowerCase();
        if (s === 'orientation' || s === 'xy' || s === 'xyz') return s;
        return 'none';
      })();
      cb.toSurf = (() => {
        const s = String(toSurf ?? '').trim();
        if (s === '') return 0;
        const n = (typeof toSurf === 'number') ? toSurf : (isNumericString(s) ? Number(s) : NaN);
        if (!Number.isFinite(n) || n < 0) return 0;
        return Math.trunc(n);
      })();

      // Coord Trans field reuse (see specification/ray-tracing.md)
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

      // IMPORTANT: CT rows reuse semidia for decenterX, so their visible semidia column
      // MUST NOT vignette subsequent rays. Propagate the last non-CT/non-Stop semidia
      // so rendering/ray-tracing can use it for clearance checks after the CT.
      // Store it in a dedicated field so it doesn't overwrite decenterX.
      // ALSO: Preserve the previous surface's material and rindex so that ray tracing
      // knows what medium the ray is in when crossing the CoordTrans (ray-tracing.md spec).
      try {
        const prev = getLastNonCoordTransRow();
        if (prev) {
          // Preserve semidia for clearance checking after CT
          if (prev.semidia !== undefined && prev.semidia !== null && String(prev.semidia).trim() !== '') {
            cb.__cooptActualSemidia = prev.semidia;
          }
          // Preserve material and rindex from previous surface for ray tracing
          // (these are clobbered by CoordTrans parameter mapping, so store in dedicated fields)
          if (prev.material !== undefined && prev.material !== null && String(prev.material).trim() !== '') {
            cb.__cooptActualMaterial = prev.material;
          }
          if (prev.rindex !== undefined && prev.rindex !== null) {
            const rindexVal = String(prev.rindex).trim();
            if (rindexVal !== '') {
              cb.__cooptActualRindex = prev.rindex;
            }
          }
          if (prev.abbe !== undefined && prev.abbe !== null) {
            const abbeVal = String(prev.abbe).trim();
            if (abbeVal !== '') {
              cb.__cooptActualAbbe = prev.abbe;
            }
          }
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
      const rindex1 = getParamOrVarValue(params, vars, 'rindex1');
      const abbe1 = getParamOrVarValue(params, vars, 'abbe1');
      const rindex2 = getParamOrVarValue(params, vars, 'rindex2');
      const abbe2 = getParamOrVarValue(params, vars, 'abbe2');

      s1.radius = normalizeRadiusToRowValue(radius1);
      s1.thickness = applySignedThickness(normalizeThicknessToRowValue(thickness1));
      
      // If material is missing or empty, use default N-BK7 (for legacy/imported data)
      const material1Str = String(material1 ?? '').trim();
      const usedDefaultMaterial1 = !material1Str;
      if (usedDefaultMaterial1) {
        s1.material = 'N-BK7';
        issues.push({
          severity: 'warning',
          phase: 'expand',
          message: 'Doublet.material1 was empty; defaulting to N-BK7.',
          blockId
        });
      } else {
        s1.material = material1Str;
      }
      
      // Apply rindex/abbe only if material was user-specified
      if (!usedDefaultMaterial1) {
        if (rindex1 !== undefined && rindex1 !== null && String(rindex1).trim() !== '') {
          s1.rindex = String(rindex1);
        }
        if (abbe1 !== undefined && abbe1 !== null && String(abbe1).trim() !== '') {
          s1.abbe = String(abbe1);
        }
      }
      applyDerivedGlassDisplay(s1);

      s2.radius = normalizeRadiusToRowValue(radius2);
      s2.thickness = applySignedThickness(normalizeThicknessToRowValue(thickness2));
      
      // If material is missing or empty, use default N-SF5 (for legacy/imported data)
      const material2Str = String(material2 ?? '').trim();
      const usedDefaultMaterial2 = !material2Str;
      if (usedDefaultMaterial2) {
        s2.material = 'N-SF5';
        issues.push({
          severity: 'warning',
          phase: 'expand',
          message: 'Doublet.material2 was empty; defaulting to N-SF5.',
          blockId
        });
      } else {
        s2.material = material2Str;
      }
      
      // Apply rindex/abbe only if material was user-specified
      if (!usedDefaultMaterial2) {
        if (rindex2 !== undefined && rindex2 !== null && String(rindex2).trim() !== '') {
          s2.rindex = String(rindex2);
        }
        if (abbe2 !== undefined && abbe2 !== null && String(abbe2).trim() !== '') {
          s2.abbe = String(abbe2);
        }
      }
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

      // Toric surface parameters
      const s1RadiusX = getParamOrVarValue(params, vars, 'surf1RadiusX');
      const s2RadiusX = getParamOrVarValue(params, vars, 'surf2RadiusX');
      const s3RadiusX = getParamOrVarValue(params, vars, 'surf3RadiusX');
      const s1Axis = getParamOrVarValue(params, vars, 'surf1Axis');
      const s2Axis = getParamOrVarValue(params, vars, 'surf2Axis');
      const s3Axis = getParamOrVarValue(params, vars, 'surf3Axis');

      const s1ForceAsphere = hasVFlag(vars, 'surf1Conic') || hasAnyCoefV(vars, 'surf1Coef');
      const s2ForceAsphere = hasVFlag(vars, 'surf2Conic') || hasAnyCoefV(vars, 'surf2Coef');
      const s3ForceAsphere = hasVFlag(vars, 'surf3Conic') || hasAnyCoefV(vars, 'surf3Coef');

      applyAsphereFieldsFromParams(s1, s1SurfType, s1Conic, s1Coefs, s1RadiusX, undefined, s1Axis, s1ForceAsphere);
      applyAsphereFieldsFromParams(s2, s2SurfType, s2Conic, s2Coefs, s2RadiusX, undefined, s2Axis, s2ForceAsphere);
      applyAsphereFieldsFromParams(s3, s3SurfType, s3Conic, s3Coefs, s3RadiusX, undefined, s3Axis, s3ForceAsphere);

      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius1') && shouldMarkV(vars.radius1)) applyVFlag(s1, 'optimizeR');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness1') && shouldMarkV(vars.thickness1)) applyVFlag(s1, 'optimizeT');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'material1') && shouldMarkV(vars.material1)) applyVFlag(s1, 'optimizeMaterial');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'surf1Conic') && shouldMarkV(vars.surf1Conic)) applyVFlag(s1, 'optimizeConic');
      for (let i = 1; i <= 10; i++) {
        const key = `surf1Coef${i}`;
        if (vars && Object.prototype.hasOwnProperty.call(vars, key) && shouldMarkV(vars[key])) {
          applyVFlag(s1, `optimizeCoef${i}`);
        }
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius2') && shouldMarkV(vars.radius2)) applyVFlag(s2, 'optimizeR');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness2') && shouldMarkV(vars.thickness2)) applyVFlag(s2, 'optimizeT');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'material2') && shouldMarkV(vars.material2)) applyVFlag(s2, 'optimizeMaterial');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'surf2Conic') && shouldMarkV(vars.surf2Conic)) applyVFlag(s2, 'optimizeConic');
      for (let i = 1; i <= 10; i++) {
        const key = `surf2Coef${i}`;
        if (vars && Object.prototype.hasOwnProperty.call(vars, key) && shouldMarkV(vars[key])) {
          applyVFlag(s2, `optimizeCoef${i}`);
        }
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius3') && shouldMarkV(vars.radius3)) applyVFlag(s3, 'optimizeR');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'surf3Conic') && shouldMarkV(vars.surf3Conic)) applyVFlag(s3, 'optimizeConic');
      for (let i = 1; i <= 10; i++) {
        const key = `surf3Coef${i}`;
        if (vars && Object.prototype.hasOwnProperty.call(vars, key) && shouldMarkV(vars[key])) {
          applyVFlag(s3, `optimizeCoef${i}`);
        }
      }

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
      const rindex1 = getParamOrVarValue(params, vars, 'rindex1');
      const abbe1 = getParamOrVarValue(params, vars, 'abbe1');
      const rindex2 = getParamOrVarValue(params, vars, 'rindex2');
      const abbe2 = getParamOrVarValue(params, vars, 'abbe2');
      const rindex3 = getParamOrVarValue(params, vars, 'rindex3');
      const abbe3 = getParamOrVarValue(params, vars, 'abbe3');

      s1.radius = normalizeRadiusToRowValue(radius1);
      s1.thickness = applySignedThickness(normalizeThicknessToRowValue(thickness1));
      
      // If material is missing or empty, use default N-BK7 (for legacy/imported data)
      const material1Str = String(material1 ?? '').trim();
      const usedDefaultMaterial1 = !material1Str;
      if (usedDefaultMaterial1) {
        s1.material = 'N-BK7';
        issues.push({
          severity: 'warning',
          phase: 'expand',
          message: 'Triplet.material1 was empty; defaulting to N-BK7.',
          blockId
        });
      } else {
        s1.material = material1Str;
      }
      
      // Apply rindex/abbe only if material was user-specified
      if (!usedDefaultMaterial1) {
        if (rindex1 !== undefined && rindex1 !== null && String(rindex1).trim() !== '') {
          s1.rindex = String(rindex1);
        }
        if (abbe1 !== undefined && abbe1 !== null && String(abbe1).trim() !== '') {
          s1.abbe = String(abbe1);
        }
      }
      applyDerivedGlassDisplay(s1);

      s2.radius = normalizeRadiusToRowValue(radius2);
      s2.thickness = applySignedThickness(normalizeThicknessToRowValue(thickness2));
      
      // If material is missing or empty, use default N-SF5 (for legacy/imported data)
      const material2Str = String(material2 ?? '').trim();
      const usedDefaultMaterial2 = !material2Str;
      if (usedDefaultMaterial2) {
        s2.material = 'N-SF5';
        issues.push({
          severity: 'warning',
          phase: 'expand',
          message: 'Triplet.material2 was empty; defaulting to N-SF5.',
          blockId
        });
      } else {
        s2.material = material2Str;
      }
      
      // Apply rindex/abbe only if material was user-specified
      if (!usedDefaultMaterial2) {
        if (rindex2 !== undefined && rindex2 !== null && String(rindex2).trim() !== '') {
          s2.rindex = String(rindex2);
        }
        if (abbe2 !== undefined && abbe2 !== null && String(abbe2).trim() !== '') {
          s2.abbe = String(abbe2);
        }
      }
      applyDerivedGlassDisplay(s2);

      s3.radius = normalizeRadiusToRowValue(radius3);
      s3.thickness = applySignedThickness(normalizeThicknessToRowValue(thickness3));
      
      // If material is missing or empty, use default N-BK7 (for legacy/imported data)
      const material3Str = String(material3 ?? '').trim();
      const usedDefaultMaterial3 = !material3Str;
      if (usedDefaultMaterial3) {
        s3.material = 'N-BK7';
        issues.push({
          severity: 'warning',
          phase: 'expand',
          message: 'Triplet.material3 was empty; defaulting to N-BK7.',
          blockId
        });
      } else {
        s3.material = material3Str;
      }
      
      // Apply rindex/abbe only if material was user-specified
      if (!usedDefaultMaterial3) {
        if (rindex3 !== undefined && rindex3 !== null && String(rindex3).trim() !== '') {
          s3.rindex = String(rindex3);
        }
        if (abbe3 !== undefined && abbe3 !== null && String(abbe3).trim() !== '') {
          s3.abbe = String(abbe3);
        }
      }
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

      // Toric surface parameters
      const s1RadiusX = getParamOrVarValue(params, vars, 'surf1RadiusX');
      const s2RadiusX = getParamOrVarValue(params, vars, 'surf2RadiusX');
      const s3RadiusX = getParamOrVarValue(params, vars, 'surf3RadiusX');
      const s4RadiusX = getParamOrVarValue(params, vars, 'surf4RadiusX');
      const s1Axis = getParamOrVarValue(params, vars, 'surf1Axis');
      const s2Axis = getParamOrVarValue(params, vars, 'surf2Axis');
      const s3Axis = getParamOrVarValue(params, vars, 'surf3Axis');
      const s4Axis = getParamOrVarValue(params, vars, 'surf4Axis');

      const s1ForceAsphere = hasVFlag(vars, 'surf1Conic') || hasAnyCoefV(vars, 'surf1Coef');
      const s2ForceAsphere = hasVFlag(vars, 'surf2Conic') || hasAnyCoefV(vars, 'surf2Coef');
      const s3ForceAsphere = hasVFlag(vars, 'surf3Conic') || hasAnyCoefV(vars, 'surf3Coef');
      const s4ForceAsphere = hasVFlag(vars, 'surf4Conic') || hasAnyCoefV(vars, 'surf4Coef');

      applyAsphereFieldsFromParams(s1, s1SurfType, s1Conic, s1Coefs, s1RadiusX, undefined, s1Axis, s1ForceAsphere);
      applyAsphereFieldsFromParams(s2, s2SurfType, s2Conic, s2Coefs, s2RadiusX, undefined, s2Axis, s2ForceAsphere);
      applyAsphereFieldsFromParams(s3, s3SurfType, s3Conic, s3Coefs, s3RadiusX, undefined, s3Axis, s3ForceAsphere);
      applyAsphereFieldsFromParams(s4, s4SurfType, s4Conic, s4Coefs, s4RadiusX, undefined, s4Axis, s4ForceAsphere);

      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius1') && shouldMarkV(vars.radius1)) applyVFlag(s1, 'optimizeR');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness1') && shouldMarkV(vars.thickness1)) applyVFlag(s1, 'optimizeT');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'material1') && shouldMarkV(vars.material1)) applyVFlag(s1, 'optimizeMaterial');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'surf1Conic') && shouldMarkV(vars.surf1Conic)) applyVFlag(s1, 'optimizeConic');
      for (let i = 1; i <= 10; i++) {
        const key = `surf1Coef${i}`;
        if (vars && Object.prototype.hasOwnProperty.call(vars, key) && shouldMarkV(vars[key])) {
          applyVFlag(s1, `optimizeCoef${i}`);
        }
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius2') && shouldMarkV(vars.radius2)) applyVFlag(s2, 'optimizeR');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness2') && shouldMarkV(vars.thickness2)) applyVFlag(s2, 'optimizeT');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'material2') && shouldMarkV(vars.material2)) applyVFlag(s2, 'optimizeMaterial');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'surf2Conic') && shouldMarkV(vars.surf2Conic)) applyVFlag(s2, 'optimizeConic');
      for (let i = 1; i <= 10; i++) {
        const key = `surf2Coef${i}`;
        if (vars && Object.prototype.hasOwnProperty.call(vars, key) && shouldMarkV(vars[key])) {
          applyVFlag(s2, `optimizeCoef${i}`);
        }
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius3') && shouldMarkV(vars.radius3)) applyVFlag(s3, 'optimizeR');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness3') && shouldMarkV(vars.thickness3)) applyVFlag(s3, 'optimizeT');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'material3') && shouldMarkV(vars.material3)) applyVFlag(s3, 'optimizeMaterial');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'surf3Conic') && shouldMarkV(vars.surf3Conic)) applyVFlag(s3, 'optimizeConic');
      for (let i = 1; i <= 10; i++) {
        const key = `surf3Coef${i}`;
        if (vars && Object.prototype.hasOwnProperty.call(vars, key) && shouldMarkV(vars[key])) {
          applyVFlag(s3, `optimizeCoef${i}`);
        }
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius4') && shouldMarkV(vars.radius4)) applyVFlag(s4, 'optimizeR');
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'surf4Conic') && shouldMarkV(vars.surf4Conic)) applyVFlag(s4, 'optimizeConic');
      for (let i = 1; i <= 10; i++) {
        const key = `surf4Coef${i}`;
        if (vars && Object.prototype.hasOwnProperty.call(vars, key) && shouldMarkV(vars[key])) {
          applyVFlag(s4, `optimizeCoef${i}`);
        }
      }

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
      const mirrorForceAsphere = hasVFlag(vars, 'conic') || hasAnyCoefV(vars, 'coef');
      applyAsphereFieldsFromParams(mirror, surfTypeRaw, conicRaw, coefsRaw, undefined, undefined, undefined, mirrorForceAsphere);

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

      if (vars && Object.prototype.hasOwnProperty.call(vars, 'radius') && shouldMarkV(vars.radius)) {
        applyVFlag(mirror, 'optimizeR');
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness') && shouldMarkV(vars.thickness)) {
        applyVFlag(mirror, 'optimizeT');
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, 'conic') && shouldMarkV(vars.conic)) {
        applyVFlag(mirror, 'optimizeConic');
      }
      for (let i = 1; i <= 10; i++) {
        const key = `coef${i}`;
        if (vars && Object.prototype.hasOwnProperty.call(vars, key) && shouldMarkV(vars[key])) {
          applyVFlag(mirror, `optimizeCoef${i}`);
        }
      }

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

      const abbeRaw = getParamOrVarValue(params, vars, 'abbe');
      const abbeStr = String(abbeRaw ?? '').trim();

      if (prev && isCoordTransRow(prev)) {
        // Coord Trans rows reuse thickness/material for decenter parameters;
        // store gap spacing separately to avoid clobbering CT fields.
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
        
        // Handle abbe number: manual for numeric materials, auto-fetch for glass names
        const isNumericMaterial = __isNumericMaterialName(gapMaterial);
        if (isNumericMaterial && abbeStr !== '') {
          // Numeric material (synthetic glass) with manual abbe value
          prev.abbe = abbeStr;
        } else if (!isNumericMaterial && gapMaterial.toUpperCase() !== 'AIR') {
          // Glass name: fetch abbe from catalog
          applyDerivedGlassDisplay(prev);
        } else {
          // AIR or no material: leave abbe empty
          prev.abbe = '';
        }
        
        prev.__cooptGapApplied = true;

        if (vars && Object.prototype.hasOwnProperty.call(vars, 'thickness') && shouldMarkV(vars.thickness)) {
          applyVFlag(prev, 'optimizeT');
        }
        if (vars && Object.prototype.hasOwnProperty.call(vars, 'material') && shouldMarkV(vars.material)) {
          applyVFlag(prev, 'optimizeMaterial');
        }
        if (vars && Object.prototype.hasOwnProperty.call(vars, 'abbe') && shouldMarkV(vars.abbe)) {
          applyVFlag(prev, 'optimizeAbbe');
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

  // Append Image row (do not force AUTO/A/INF here; honor ImageSurface overrides if provided).
  const imageRow = createDefaultImageRow(rows.length, imagePlaneOverrides);
  if (imagePlaneBlockId) {
    imageRow._blockType = 'ImageSurface';
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
  } finally {
    recordCooptPerfSample('blocks.expandBlocksToOpticalSystemRows', performance.now() - startMs);
  }
}

/**
 * Best-effort conversion from legacy surface table rows into canonical Blocks.
 * This enables legacy (no-blocks) designs to enter the Blocks workflow.
 *
 * Supported (MVP):
 * - Stop rows -> Stop block (spacing after Stop is converted into a Gap block)
 * - A lens is detected as: a non-Stop row with material != AIR followed by a row with material == AIR
 *   (front row thickness becomes centerThickness; back row thickness becomes a Gap block)
 * - ImageSurface marker is always appended.
 *
 * @param {any[]} rows legacy OpticalSystemTableData-like rows
 * @returns {{ blocks: any[], issues: LoadIssue[] }}
 */
export function deriveBlocksFromLegacyOpticalSystemRows(rows: any[]): { blocks: Block[]; issues: LoadIssue[] } {
  /** @type {LoadIssue[]} */
  const issues = [];
  const blocks = [];

  if (!Array.isArray(rows) || rows.length < 2) {
    issues.push({ severity: 'fatal', phase: 'validate', message: 'opticalSystem rows must be a non-empty array.' });
    return { blocks, issues };
  }

  const legacyRows = rows;
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

  const inferImageSemidiaFromLegacyRows = () => {
    for (let idx = legacyRows.length - 1; idx >= 0; idx--) {
      const row = legacyRows[idx];
      if (!row || typeof row !== 'object') continue;
      if (__isCoordTransRow(row)) continue;
      const raw = getLegacySemidiaRaw(row);
      const s = String(raw ?? '').trim();
      if (s === '') continue;
      const n = isNumericString(s) ? Number(s) : (typeof raw === 'number' ? raw : NaN);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };

  const legacyHasV = (rowObj, key) => {
    const raw = rowObj?.[key];
    if (raw === null || raw === undefined) return false;
    const s = String(raw).trim().toUpperCase();
    return s === 'V' || s.includes('V');
  };

  const legacyVarV = (value) => ({ value, optimize: { mode: 'V' } });

  const isLegacyParaxialRow = (rowObj) => {
    if (!rowObj || typeof rowObj !== 'object') return false;
    try {
      if (rowObj._idealThinLens === true) return true;
      const blockType = String(rowObj._blockType ?? rowObj.blockType ?? '').trim();
      if (blockType === 'Paraxial' || blockType === 'ThinLens') return true;
    } catch (_) {}
    return false;
  };

  const readThinLensFocalLength = (rowObj, key) => {
    const raw = rowObj?.[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const s = String(raw).trim();
    if (s === '') return undefined;
    if (/^inf(inity)?$/i.test(s)) return 'INF';
    return isNumericString(s) ? Number(s) : undefined;
  };

  const inferLegacySurfType = (rowObj, conicValue, coefValues) => {
    const raw = normalizeSurfTypeValue(rowObj?.surfType);
    const looksAsphere = blockAsphereLooksNonZero({
      surfType: raw,
      conic: conicValue,
      coefs: Array.isArray(coefValues) ? coefValues : []
    });
    if (looksAsphere && (!raw || raw === 'Spherical')) return 'Aspheric even';
    return raw || 'Spherical';
  };

  let lensCount = 0;
  let doubletCount = 0;
  let tripletCount = 0;
  let stopCount = 0;
  let gapCount = 0;

  // Add ObjectSurface block from Object row (rows[0])
  if (legacyRows.length > 0 && legacyRows[0]) {
    const objRow = legacyRows[0];
    const objThickness = asNumberOrInfOrZero(objRow.thickness);
    const isInfinite = objThickness === 'INF' || objThickness === Infinity;
    
    blocks.push({
      blockId: 'ObjectSurface-1',
      blockType: 'ObjectSurface',
      role: null,
      constraints: {},
      parameters: {
        objectDistanceMode: isInfinite ? 'INF' : 'Finite',
        ...(isInfinite ? {} : { objectDistance: typeof objThickness === 'number' && objThickness > 0 ? objThickness : 100 })
      },
      variables: {},
      metadata: { source: 'legacy-opticalSystem' }
    });
  }

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

    if (__isCoordTransRow(r)) {
      const readCoordNumber = (preferred, fallback, defaultValue = 0) => {
        const p = preferred;
        if (typeof p === 'number' && Number.isFinite(p)) return p;
        const ps = String(p ?? '').trim();
        if (ps !== '' && isNumericString(ps)) return Number(ps);

        const f = fallback;
        if (typeof f === 'number' && Number.isFinite(f)) return f;
        const fs = String(f ?? '').trim();
        if (fs !== '' && isNumericString(fs)) return Number(fs);
        return defaultValue;
      };

      const decenterX = readCoordNumber((r as any).decenterX, r.semidia, 0);
      const decenterY = readCoordNumber((r as any).decenterY, r.material, 0);
      const decenterZ = readCoordNumber((r as any).decenterZ, r.thickness, 0);
      const tiltX = readCoordNumber((r as any).tiltX, (r as any).rindex, 0);
      const tiltY = readCoordNumber((r as any).tiltY, (r as any).abbe, 0);
      const tiltZ = readCoordNumber((r as any).tiltZ, r.conic, 0);
      const orderRaw = readCoordNumber((r as any).order, (r as any).coef1, 0);
      const order = (orderRaw === 0 || orderRaw === 1) ? orderRaw : (orderRaw > 0 ? 1 : 0);

      const coordReturnRaw = String((r as any).coordReturn ?? '').trim().toLowerCase();
      const coordReturn = (coordReturnRaw === 'orientation' || coordReturnRaw === 'xy' || coordReturnRaw === 'xyz')
        ? coordReturnRaw
        : 'none';

      const toSurfRaw = (r as any).toSurf;
      const toSurfNum = (typeof toSurfRaw === 'number')
        ? toSurfRaw
        : (isNumericString(String(toSurfRaw ?? '').trim()) ? Number(toSurfRaw) : 0);
      const toSurf = Number.isFinite(toSurfNum) ? Math.max(0, Math.trunc(toSurfNum)) : 0;

      blocks.push({
        blockId: `CoordTrans-${i}`,
        blockType: 'CoordTrans',
        role: null,
        constraints: {},
        parameters: {
          decenterX,
          decenterY,
          decenterZ,
          tiltX,
          tiltY,
          tiltZ,
          order,
          coordReturn,
          toSurf
        },
        variables: {},
        metadata: { source: 'legacy-opticalSystem' }
      });
      continue;
    }

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
      const sd = parseSemiDiameterNumber(getLegacySemidiaRaw(r));
      const params: any = {};
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

    if (isLegacyParaxialRow(r) && isLegacyParaxialRow(back)) {
      lensCount++;
      const lensId = `Paraxial-${lensCount}`;
      const fx = readThinLensFocalLength(r, '_thinLensFocalLengthX') ?? readThinLensFocalLength(back, '_thinLensFocalLengthX');
      const fy = readThinLensFocalLength(r, '_thinLensFocalLengthY') ?? readThinLensFocalLength(back, '_thinLensFocalLengthY');
      const thinSurfType = normalizeSurfTypeValue(r?.surfType) || normalizeSurfTypeValue(back?.surfType) || 'Toric';
      const materialForParaxial = material || __normalizeLegacyMaterialForBlocks(back, i + 1, issues) || 'N-BK7';

      const parameters: any = {
        material: materialForParaxial,
        surfType: thinSurfType,
      };
      if (fx !== undefined && fy !== undefined && String(fx) === String(fy)) {
        parameters.focalLength = fx;
      } else {
        if (fx !== undefined) parameters.focalLengthX = fx;
        if (fy !== undefined) parameters.focalLengthY = fy;
      }

      blocks.push({
        blockId: lensId,
        blockType: 'Paraxial',
        role: null,
        constraints: {},
        parameters,
        aperture: {
          front: getLegacySemidiaRaw(r),
          back: getLegacySemidiaRaw(back),
        },
        variables: {},
        metadata: { source: 'legacy-opticalSystem' }
      });

      const gapT = asNumberOrInfOrZero(back.thickness);
      if ((typeof gapT === 'number' && Math.abs(gapT) > 1e-12) || gapT === 'INF') {
        gapCount++;
        const bmRaw = normalizeMaterialName(back.material);
        const bmKey = bmRaw.replace(/\s+/g, '').toUpperCase();
        const matKey = String(materialForParaxial ?? '').trim().replace(/\s+/g, '').toUpperCase();
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

      i++;
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
      const conic = isNumericString(String(rowObj?.conic ?? '').trim()) ? Number(String(rowObj.conic).trim()) : (typeof rowObj?.conic === 'number' ? rowObj.conic : 0);
      const coefs = Array.from({ length: 10 }, (_, k) => {
        const vv = rowObj?.[`coef${k + 1}`];
        const s = String(vv ?? '').trim();
        if (s === '') return 0;
        return isNumericString(s) ? Number(s) : (typeof vv === 'number' && Number.isFinite(vv) ? vv : 0);
      });
      const surfType = inferLegacySurfType(rowObj, conic, coefs);
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

      // CRITICAL FIX: Ensure we have exactly the number of materials we need
      // In case materials with same name were deduplicated, add additional elements
      // We need to check how many unique materials were found by counting the chain length
      const expectedElementCount = Math.max(2, endIndex !== null ? chain.length - 1 : glasses.length);
      while (glasses.length < expectedElementCount && glasses.length < 3) {
        const nextIdx = glasses.length;
        if (nextIdx < chain.length) {
          const mmaterial = __normalizeLegacyMaterialForBlocks(chain[nextIdx], i + nextIdx, issues);
          glasses.push(mmaterial);
        } else {
          break;
        }
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
        // Preserve Abbe/Vd from Zemax ___BLANK import for each element
        const abbe1 = String(chain[0]?.abbe ?? '').trim();
        const abbe2 = String(chain[1]?.abbe ?? '').trim();
        const params = {
          radius1: radii[0],
          radius2: radii[1],
          radius3: radii[2],
          thickness1: thicknesses[0],
          thickness2: thicknesses[1],
          material1: glasses[0],
          material2: glasses[1],
          ...(abbe1 !== '' ? { abbe1 } : {}),
          ...(abbe2 !== '' ? { abbe2 } : {}),
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
        // Preserve Abbe/Vd from Zemax ___BLANK import for each element
        const abbe1 = String(chain[0]?.abbe ?? '').trim();
        const abbe2 = String(chain[1]?.abbe ?? '').trim();
        const abbe3 = String(chain[2]?.abbe ?? '').trim();
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
          ...(abbe1 !== '' ? { abbe1 } : {}),
          ...(abbe2 !== '' ? { abbe2 } : {}),
          ...(abbe3 !== '' ? { abbe3 } : {}),
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

    const frontSurfType = inferLegacySurfType(r, frontConic, frontCoefs);
    const backSurfType = inferLegacySurfType(back, backConic, backCoefs);

    // Preserve Abbe/Vd from Zemax ___BLANK import (stored in row.abbe by zemax-import.ts)
    const legacyAbbe = String(r?.abbe ?? '').trim() || String(back?.abbe ?? '').trim();

    const lensVariables: any = {};
    if (legacyHasV(r, 'optimizeR')) lensVariables.frontRadius = legacyVarV(frontRadius);
    if (legacyHasV(r, 'optimizeT')) lensVariables.centerThickness = legacyVarV(centerThickness);
    if (legacyHasV(r, 'optimizeMaterial')) lensVariables.material = legacyVarV(material);
    if (legacyHasV(r, 'optimizeConic')) lensVariables.frontConic = legacyVarV(frontConic);
    for (let i = 1; i <= 10; i++) {
      if (legacyHasV(r, `optimizeCoef${i}`)) lensVariables[`frontCoef${i}`] = legacyVarV(frontCoefs[i - 1]);
    }
    if (legacyHasV(back, 'optimizeR')) lensVariables.backRadius = legacyVarV(backRadius);
    if (legacyHasV(back, 'optimizeConic')) lensVariables.backConic = legacyVarV(backConic);
    for (let i = 1; i <= 10; i++) {
      if (legacyHasV(back, `optimizeCoef${i}`)) lensVariables[`backCoef${i}`] = legacyVarV(backCoefs[i - 1]);
    }

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
        ...(legacyAbbe !== '' ? { abbe: legacyAbbe } : {}),

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
      variables: lensVariables,
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
  const inferredImageSemidia = inferImageSemidiaFromLegacyRows();
  blocks.push({
    blockId: 'ImageSurface-1',
    blockType: 'ImageSurface',
    role: null,
    constraints: {},
    parameters: (Number.isFinite(inferredImageSemidia as any) && (inferredImageSemidia as number) > 0)
      ? { semidia: inferredImageSemidia, semidiaMode: 'Auto', optimizeSemiDia: 'A' }
      : { semidiaMode: 'Auto', optimizeSemiDia: 'A' },
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
export function expandBlocksIntoConfiguration(config: any): { expandedOpticalSystem: any[] | null; issues: LoadIssue[] } | undefined {
  if (!configurationHasBlocks(config)) {
    return { expandedOpticalSystem: null, issues: [] };
  }

  const issues = [];
  issues.push(...validateBlocksConfiguration(config));
  if (issues.some(i => i.severity === 'fatal')) {
    return { expandedOpticalSystem: null, issues };
  }

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
        if (t === 'image' || __isCoordTransRow(lr)) continue;
        const pk = __provenanceKey(lr);
        if (!pk) continue;
        const v = __getRowSemidia(lr);
        if (!__semidiaHasValue(v)) continue;
        legacyByProv.set(pk, v);
      }

      for (const er of expanded.rows) {
        if (!er || typeof er !== 'object') continue;
        const t = __rowTypeLower(er);
        if (t === 'image' || __isCoordTransRow(er)) continue;
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
export function hasGlassRegionConstraint(block: Block): boolean {
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
