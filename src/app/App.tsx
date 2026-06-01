import { useEffect, useRef, useState } from "react";
import * as THREE from 'three';
import { DistortionAnalysisPage } from './DistortionAnalysisPage';
import { MtfAnalysisPage } from './MtfAnalysisPage';
import MainToolbar from "../ui/components/MainToolbar";
import ConfigurationSection from "../ui/components/ConfigurationSection";
import SourceObjectSection from "../ui/components/SourceObjectSection";
import DesignIntentSection from "../ui/components/DesignIntentSection";
import ZoomSection from "../ui/components/ZoomSection.tsx";
import RequirementsSection from "../ui/components/RequirementsSection";
import LegacyPanels from "../ui/components/LegacyPanels";
import { LiteratureImportPanel, SystemDataPanel } from "../ui/components/LegacyPanels";
import {
  handleAnalysisSelect,
  handleClearStorage,
  handleExportZemax,
  handleImportZemax,
  handleLoad,
  handleLoadDefault,
  handleNewFile,
  handleOpenSettings,
  handleOptimize,
  handleRender3D,
  handleSave,
  handleShareUrl,
  handleSystemData,
} from "../../ui/toolbar-handlers";
import { runOptimizationMVP } from "../../optimization/optimizer-mvp.ts";
import { listDesignVariablesFromBlocks } from "../../optimization/design-variables.ts";
import { clearOptimizerStop, readDesktopSetting, startPreventDisplaySleep, stopPreventDisplaySleep, writeDesktopSetting } from "../../src/desktop/ipc/client.ts";
import { isTauriRuntime } from "../../src/desktop/runtime.ts";
import { getOrCreateCooptWindowSyncSenderId, requestRefreshBlockInspector } from "../../core/window-facade.ts";
import { calculateSurfaceOrigins, transformPointToGlobal, transformPointToLocal, traceRay, traceRayHitPoint } from "../../raytracing/core/ray-tracing.ts";
import { calculateParaxialData } from "../../raytracing/core/ray-paraxial.ts";
import { convertImageHeightToEffectiveObject, generateRayStartPointsForObject } from "../../optical/ray-renderer.ts";

const SURFACE_COLOR_OVERRIDES_STORAGE_KEY = 'coopt.surfaceColorOverrides';
const RENDER_SHOW_LABELS_KEY = 'coopt.render.showDesignIntentLabels';
const RENDER_SHOW_PRINCIPAL_POINTS_KEY = 'coopt.render.showPrincipalPointLabels';
const RENDER_SHOW_SURFACE_NUMBERS_KEY = 'coopt.render.showSurfaceNumberLabels';
const RENDER_DESIGN_INTENT_SYNC_KEY = 'coopt.render.designIntentLiveSync';
const OPTIMIZE_PROGRESS_SYNC_KEY = 'coopt.optimizeProgress';
const RENDER_SCALE_BAR_MIN_WIDTH_PX = 72;
const RENDER_SCALE_BAR_TARGET_WIDTH_PX = 160;
const RENDER_SCALE_BAR_MAX_WIDTH_PX = 240;
const RENDER_SURFACE_COLOR_PALETTE: Array<{ name: string; hex: string }> = [
  { name: 'Light Pink', hex: '#FFB6C1' },
  { name: 'Light Red', hex: '#FF6B6B' },
  { name: 'Light Orange', hex: '#FFA07A' },
  { name: 'Light Amber', hex: '#FFBF00' },
  { name: 'Light Yellow', hex: '#FFFF99' },
  { name: 'Light Lime', hex: '#CCFF66' },
  { name: 'Light Green', hex: '#90EE90' },
  { name: 'Light Mint', hex: '#98FF98' },
  { name: 'Light Cyan', hex: '#AFEEEE' },
  { name: 'Light Sky', hex: '#87CEEB' },
  { name: 'Light Blue', hex: '#ADD8E6' },
  { name: 'Light Indigo', hex: '#9FA8DA' },
  { name: 'Light Purple', hex: '#DDA0DD' },
  { name: 'Light Lavender', hex: '#E6E6FA' },
  { name: 'Light Peach', hex: '#FFDAB9' },
  { name: 'Light Gray', hex: '#D3D3D3' },
];

type RenderLensColorTarget = {
  label: string;
  key: string;
  keys: string[];
  frontSurfaceIndex0: number;
};

type RenderCompareScope = 'active' | 'all';
type RenderCompareOffsetDirection = 'centered' | 'positive' | 'negative';
type RenderCompareAlignReference = 'object' | 'image';

type RenderCompareEntry = {
  configId: string;
  name: string;
  rows: any[];
  objectRows: any[];
  isActive: boolean;
};

type RenderZoomUiState = {
  available: boolean;
  blockId: string;
  zoomPosition: number;
  groupNames: string[];
  lawGroups: string[];
  configName: string;
};

type WorkspaceFocus = 'configuration' | 'source' | 'intent' | 'literature' | 'zoom' | 'requirements';

type RenderTimingStage = {
  label: string;
  ms: number;
};

type CollectLegacyCrossRaysOptions = {
  rayCountOverride?: number;
};

type RenderRedrawOptions = {
  useLiveRayCount?: boolean;
  rayCountOverride?: number;
  quickInitialRayCount?: number;
  scheduleFullRayPass?: boolean;
  skipRayGeneration?: boolean;
};

type RenderImageSemidiaWarning = {
  imageSurfaceIndex: number;
  semidia: number;
  maxTargetHeight: number;
  shortfall: number;
  message: string;
};

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
      __cooptPerf?: { samples?: Record<string, CooptPerfCounter> };
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
  } catch (_) {}
}

const BLOCK_PERF_KEYS = [
  'collectLegacyCrossRays.total',
  'collectLegacyCrossRays.generate',
  'collectLegacyCrossRays.normalize',
  'collectLegacyCrossRays.limit',
  'surfaceRenderer.clear',
  'surfaceRenderer.origins',
  'surfaceRenderer.draw3d',
  'surfaceRenderer.crossSection',
  'surfaceRenderer.labels',
  'surfaceRenderer.total',
  'ray.infiniteCrossBeam.chiefSolve',
  'ray.infiniteCrossBeam.chiefRefine',
  'ray.infiniteCrossBeam.boundary',
  'ray.infiniteCrossBeam.entrance',
  'ray.infiniteCrossBeam.trace',
  'ray.infiniteCrossBeam.total',
  'blocks.expandBlocksToOpticalSystemRows',
  'blocks.applyZoomMotionToBlocks',
  'blocks.resolveAutomaticZoomLawConstants',
  'blocks.estimateZoomGroupParaxialPower',
  'blocks.validateZoomLawDefinitions',
] as const;

const BLOCK_PERF_LABELS: Record<string, string> = {
  'collectLegacyCrossRays.total': 'collectTotal',
  'collectLegacyCrossRays.generate': 'collectGen',
  'collectLegacyCrossRays.normalize': 'collectNorm',
  'collectLegacyCrossRays.limit': 'collectLimit',
  'surfaceRenderer.clear': 'surfClear',
  'surfaceRenderer.origins': 'surfOrig',
  'surfaceRenderer.draw3d': 'surf3d',
  'surfaceRenderer.crossSection': 'surfXsec',
  'surfaceRenderer.labels': 'surfLabels',
  'surfaceRenderer.total': 'surfTotal',
  'ray.infiniteCrossBeam.chiefSolve': 'chiefSolve',
  'ray.infiniteCrossBeam.chiefRefine': 'chiefRefine',
  'ray.infiniteCrossBeam.boundary': 'boundary',
  'ray.infiniteCrossBeam.entrance': 'entrance',
  'ray.infiniteCrossBeam.trace': 'traceCross',
  'ray.infiniteCrossBeam.total': 'crossTotal',
  'blocks.expandBlocksToOpticalSystemRows': 'expand',
  'blocks.applyZoomMotionToBlocks': 'zoom',
  'blocks.resolveAutomaticZoomLawConstants': 'autoPhi',
  'blocks.estimateZoomGroupParaxialPower': 'groupPhi',
  'blocks.validateZoomLawDefinitions': 'lawCheck',
};

const RENDER_3D_SURFACE_MESH_SEGMENTS = 64;
const RENDER_3D_TORIC_MESH_SEGMENTS = 96;
const RENDER_IMAGEHEIGHT_APPROX_CACHE_LIMIT = 512;
const RENDER_LEGACY_CROSS_RAYS_CACHE_LIMIT = 48;
const RENDER_IMAGEHEIGHT_EXACT_CROSS_CACHE_VERSION = 'imageheight-exact-cross-v6';

const RENDER_AUTO_APERTURE_MARGIN_FACTOR = 1.10;
const RENDER_AUTO_APERTURE_MARGIN_MM = 0.05;

function applyRenderAutoApertureMargin(radiusMm: number): number {
  const radius = Number(radiusMm);
  if (!(Number.isFinite(radius) && radius > 0)) return radius;
  return Math.max(
    radius * RENDER_AUTO_APERTURE_MARGIN_FACTOR,
    radius + RENDER_AUTO_APERTURE_MARGIN_MM,
  );
}
const renderImageHeightApproxCache = new Map<string, any>();
const renderParaxialDataCache = new Map<string, any>();
const renderLegacyCrossRaysCache = new Map<string, any[]>();

function clampRenderCacheSize(cache: Map<string, any>, limit = RENDER_IMAGEHEIGHT_APPROX_CACHE_LIMIT): void {
  while (cache.size > limit) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

function stringifyRenderSignatureValue(value: any, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const valueType = typeof value;
  if (valueType === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return String(value);
  }
  if (valueType === 'string' || valueType === 'boolean' || valueType === 'bigint') {
    return String(value);
  }
  if (valueType === 'function' || valueType === 'symbol') {
    return valueType;
  }
  if (value instanceof Date) {
    return `Date:${value.toISOString()}`;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyRenderSignatureValue(item, seen)).join(',')}]`;
  }

  if (valueType === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const keys = Object.keys(value).sort();
    const serialized = `{${keys.map((key) => `${key}:${stringifyRenderSignatureValue(value[key], seen)}`).join(',')}}`;
    seen.delete(value);
    return serialized;
  }

  return String(value);
}

function buildRenderRowsSignature(rows: any[]): string {
  if (!Array.isArray(rows)) return 'no-rows';
  return rows.map((row: any, index: number) => `${index}:${stringifyRenderSignatureValue(row ?? null)}`).join('|');
}

function getRenderParaxialDataCached(opticalSystemRows: any[], wavelengthUm: number): any {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return null;
  const signature = buildRenderRowsSignature(opticalSystemRows);
  const cacheKey = `${signature}#${Number(wavelengthUm || 0).toFixed(6)}`;
  if (renderParaxialDataCache.has(cacheKey)) {
    return renderParaxialDataCache.get(cacheKey) ?? null;
  }
  let paraxial = null;
  try {
    paraxial = calculateParaxialData(opticalSystemRows, wavelengthUm);
  } catch (_) {
    paraxial = null;
  }
  renderParaxialDataCache.set(cacheKey, paraxial);
  clampRenderCacheSize(renderParaxialDataCache, 64);
  return paraxial;
}

function buildRenderObjectRowsSignature(rows: any[]): string {
  if (!Array.isArray(rows)) return 'no-object-rows';
  return rows.map((row: any, index: number) => `${index}:${stringifyRenderSignatureValue(row ?? null)}`).join('|');
}

function cloneRenderLegacyCrossRays(rays: any[]): any[] {
  if (!Array.isArray(rays) || rays.length === 0) return [];
  return rays.map((ray: any) => ({
    ...ray,
    originalRay: ray?.originalRay && typeof ray.originalRay === 'object'
      ? { ...ray.originalRay }
      : ray?.originalRay,
  }));
}

function getCrossRayOrderPriority(ray: any): number {
  const type = String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase();
  const side = String(ray?.originalRay?.side ?? ray?.side ?? '').trim().toLowerCase();
  if (type === 'chief') return 0;
  if (side === 'upper' || side === 'top' || type === 'upper_marginal') return 1;
  if (side === 'lower' || side === 'bottom' || type === 'lower_marginal') return 2;
  if (side === 'left' || type === 'left_marginal') return 3;
  if (side === 'right' || type === 'right_marginal') return 4;
  if (type === 'vertical_cross') return 5;
  if (type === 'horizontal_cross') return 6;
  return 7;
}

function compareCrossRayDrawOrder(a: any, b: any): number {
  const priorityDelta = getCrossRayOrderPriority(a) - getCrossRayOrderPriority(b);
  if (priorityDelta !== 0) return priorityDelta;

  const ratioA = Number(a?.interpolationRatio ?? a?.originalRay?.interpolationRatio);
  const ratioB = Number(b?.interpolationRatio ?? b?.originalRay?.interpolationRatio);
  if (Number.isFinite(ratioA) && Number.isFinite(ratioB) && Math.abs(ratioA - ratioB) > 1e-9) {
    return ratioA - ratioB;
  }

  const rayIndexA = Number(a?.rayIndex ?? a?.originalRay?.rayIndex);
  const rayIndexB = Number(b?.rayIndex ?? b?.originalRay?.rayIndex);
  if (Number.isFinite(rayIndexA) && Number.isFinite(rayIndexB) && rayIndexA !== rayIndexB) {
    return rayIndexA - rayIndexB;
  }

  return 0;
}

function isHorizontalCrossRay(ray: any): boolean {
  const type = String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase();
  const side = String(ray?.originalRay?.side ?? ray?.side ?? '').trim().toLowerCase();
  return type === 'left_marginal'
    || type === 'right_marginal'
    || type === 'horizontal_cross'
    || side === 'left'
    || side === 'right';
}

function isVerticalCrossRay(ray: any): boolean {
  const type = String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase();
  const side = String(ray?.originalRay?.side ?? ray?.side ?? '').trim().toLowerCase();
  return type === 'upper_marginal'
    || type === 'lower_marginal'
    || type === 'vertical_cross'
    || side === 'upper'
    || side === 'lower'
    || side === 'top'
    || side === 'bottom';
}

function selectCrossRaysForAxis(rays: any[], desiredCount: number, axis: 'YZ' | 'XZ' | 'BOTH'): any[] {
  const ordered = Array.isArray(rays) ? [...rays].sort(compareCrossRayDrawOrder) : [];
  if (desiredCount <= 0 || ordered.length === 0) return [];
  if (axis !== 'BOTH' || desiredCount < 3) return ordered.slice(0, desiredCount);

  const selected: any[] = [];
  const remaining = [...ordered];
  const takeFirst = (predicate: (ray: any) => boolean) => {
    const index = remaining.findIndex(predicate);
    if (index < 0) return;
    selected.push(remaining.splice(index, 1)[0]);
  };

  takeFirst((ray) => String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase() === 'chief');
  takeFirst(isVerticalCrossRay);
  takeFirst(isHorizontalCrossRay);

  for (const ray of remaining) {
    if (selected.length >= desiredCount) break;
    selected.push(ray);
  }

  return selected.slice(0, desiredCount);
}

function buildRenderLegacyCrossRayCacheKey(
  opticalSystemRows: any[],
  normalizedObjectRows: any[],
  axis: 'YZ' | 'XZ' | 'BOTH',
  effectiveRayCount: number,
  primaryWavelength: number,
  requestedPupilSamplingMode: string | undefined,
  hasExactImageHeightRows: boolean,
): string {
  const crossType = axis === 'YZ' ? 'vertical' : (axis === 'XZ' ? 'horizontal' : 'both');
  return [
    buildRenderRowsSignature(opticalSystemRows),
    buildRenderObjectRowsSignature(normalizedObjectRows),
    axis,
    crossType,
    effectiveRayCount,
    Number(primaryWavelength || 0).toFixed(6),
    requestedPupilSamplingMode || '',
    hasExactImageHeightRows ? RENDER_IMAGEHEIGHT_EXACT_CROSS_CACHE_VERSION : '',
  ].join('#');
}

function filterRenderCrossRaysForAxis(rays: any[], axis: 'YZ' | 'XZ'): any[] {
  if (!Array.isArray(rays) || rays.length === 0) return [];
  return rays.filter((ray: any) => {
    const type = String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase();
    const side = String(ray?.originalRay?.side ?? ray?.side ?? '').trim().toLowerCase();
    if (type === 'chief') return true;
    if (axis === 'YZ') {
      return type === 'upper_marginal'
        || type === 'lower_marginal'
        || type === 'vertical_cross'
        || side === 'upper'
        || side === 'top'
        || side === 'lower'
        || side === 'bottom';
    }
    return type === 'left_marginal'
      || type === 'right_marginal'
      || type === 'horizontal_cross'
      || side === 'left'
      || side === 'right';
  });
}

function isRenderImageHeightObjectRow(row: any): boolean {
  const posNorm = String(row?.__cooptOriginalPosition ?? row?.position ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  const storedTarget = row?.__cooptImageHeightTarget;
  const hasStoredImageHeightTarget = storedTarget
    && Number.isFinite(Number(storedTarget.x))
    && Number.isFinite(Number(storedTarget.y));
  return posNorm === 'imageheight' || !!hasStoredImageHeightTarget;
}

function hasRenderImageHeightObjectRows(rows: any[]): boolean {
  return Array.isArray(rows) && rows.some((row: any) => isRenderImageHeightObjectRow(row));
}

function getRenderRayPathPointIndexForSurfaceIndex(opticalSystemRows: any[], surfaceIndex: number): number | null {
  if (!Array.isArray(opticalSystemRows) || !Number.isInteger(Number(surfaceIndex))) return null;
  const sIdx = Math.max(0, Math.min(Number(surfaceIndex), opticalSystemRows.length - 1));
  const isCoordTransRow = (systemRow: any) => {
    const st = String(systemRow?.surfType ?? systemRow?.['surf type'] ?? systemRow?.surface_type ?? '').trim().toLowerCase();
    return st === 'coord trans' || st === 'coordinate break' || st === 'coordtrans' || st === 'coordinatebreak' || st === 'ct';
  };
  const isObjectRow = (systemRow: any) => String(systemRow?.['object type'] ?? systemRow?.object ?? systemRow?.Object ?? '').trim().toLowerCase() === 'object';
  const isGapRow = (systemRow: any) => String(systemRow?._blockType ?? '').trim() === 'Gap';
  const isThinLensBackRow = (systemRow: any) => {
    const blockType = String(systemRow?._blockType ?? systemRow?.blockType ?? systemRow?.block_type ?? systemRow?.blockTypeName ?? '').trim().toLowerCase();
    if (blockType !== 'thinlens' && blockType !== 'paraxial') return false;
    return String(systemRow?._surfaceRole ?? systemRow?.surfaceRole ?? '').trim().toLowerCase() === 'back';
  };
  let count = 0;
  for (let index = 0; index <= sIdx; index += 1) {
    const systemRow = opticalSystemRows[index];
    if (isCoordTransRow(systemRow) || isObjectRow(systemRow) || isGapRow(systemRow) || isThinLensBackRow(systemRow)) continue;
    count += 1;
  }
  return count > 0 ? count : null;
}

function getRenderTargetPointFromRayPath(rayPath: any[], opticalSystemRows: any[], targetSurfaceIndex: number): any {
  if (!Array.isArray(rayPath)) return null;
  for (let index = rayPath.length - 1; index >= 0; index -= 1) {
    const point = rayPath[index];
    const pointSurfaceIndex = Number(point?.surfaceIndex ?? point?.surface ?? point?.surfaceIdx);
    if (Number.isInteger(pointSurfaceIndex) && pointSurfaceIndex === targetSurfaceIndex) {
      if (Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)) && Number.isFinite(Number(point?.z))) return point;
    }
  }
  const targetRayPathIndex = getRenderRayPathPointIndexForSurfaceIndex(opticalSystemRows, targetSurfaceIndex);
  if (targetRayPathIndex !== null && targetRayPathIndex >= 0 && targetRayPathIndex < rayPath.length) {
    const point = rayPath[targetRayPathIndex];
    if (point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)) && Number.isFinite(Number(point.z))) return point;
  }
  return null;
}

function isFiniteRenderPoint(point: any): boolean {
  return Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)) && Number.isFinite(Number(point?.z));
}

function replaceRenderTargetPointInRayPath(rayPath: any[], opticalSystemRows: any[], targetSurfaceIndex: number, targetPoint: any): any[] {
  if (!Array.isArray(rayPath) || !isFiniteRenderPoint(targetPoint)) return rayPath;
  let replaceIndex = -1;
  for (let index = rayPath.length - 1; index >= 0; index -= 1) {
    const pointSurfaceIndex = Number(rayPath[index]?.surfaceIndex ?? rayPath[index]?.surface ?? rayPath[index]?.surfaceIdx);
    if (Number.isInteger(pointSurfaceIndex) && pointSurfaceIndex === targetSurfaceIndex) {
      replaceIndex = index;
      break;
    }
  }
  if (replaceIndex < 0) {
    const targetRayPathIndex = getRenderRayPathPointIndexForSurfaceIndex(opticalSystemRows, targetSurfaceIndex);
    if (targetRayPathIndex !== null && targetRayPathIndex >= 0 && targetRayPathIndex < rayPath.length) {
      replaceIndex = targetRayPathIndex;
    }
  }
  if (replaceIndex < 0) return rayPath;
  const nextPath = rayPath.slice();
  nextPath[replaceIndex] = {
    ...(nextPath[replaceIndex] || null),
    ...targetPoint,
    surfaceIndex: targetSurfaceIndex,
  };
  return nextPath;
}

function buildRenderGlobalPointFromLocal(localPoint: any, surfaceInfo: any): any {
  if (!surfaceInfo || !isFiniteRenderPoint({
    x: localPoint?.x,
    y: localPoint?.y,
    z: Number.isFinite(Number(localPoint?.z)) ? localPoint.z : 0,
  })) return null;
  return transformPointToGlobal({
    x: Number(localPoint.x),
    y: Number(localPoint.y),
    z: Number.isFinite(Number(localPoint.z)) ? Number(localPoint.z) : 0,
  }, surfaceInfo, true);
}

function normalizeRenderVector3(vector: any, fallback: any = { x: 0, y: 0, z: 1 }): any {
  const x = Number(vector?.x);
  const y = Number(vector?.y);
  const z = Number(vector?.z);
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= 1e-12) return fallback;
  return { x: x / length, y: y / length, z: z / length };
}

function crossRenderVector3(a: any, b: any): any {
  return {
    x: Number(a?.y) * Number(b?.z) - Number(a?.z) * Number(b?.y),
    y: Number(a?.z) * Number(b?.x) - Number(a?.x) * Number(b?.z),
    z: Number(a?.x) * Number(b?.y) - Number(a?.y) * Number(b?.x),
  };
}

function buildRenderEmissionBasisFromChief(dir: any): { dir: any; u: any; v: any } | null {
  const unitDir = normalizeRenderVector3(dir);
  if (!isFiniteRenderPoint(unitDir)) return null;
  const reference = Math.abs(Number(unitDir.y)) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalizeRenderVector3(crossRenderVector3(reference, unitDir), { x: 1, y: 0, z: 0 });
  const v = normalizeRenderVector3(crossRenderVector3(unitDir, u), { x: 0, y: 1, z: 0 });
  return { dir: unitDir, u, v };
}

function buildRenderRayStartOnChiefPlane(chiefStart: any, candidate: any): any | null {
  if (!chiefStart?.startP || !chiefStart?.dir) return null;
  const basis = buildRenderEmissionBasisFromChief(chiefStart.dir);
  if (!basis) return null;
  const offsetU = Number(candidate?.planeCoords?.u) || 0;
  const offsetV = Number(candidate?.planeCoords?.v) || 0;
  const origin = chiefStart.startP;
  return {
    ...candidate,
    startP: {
      x: Number(origin.x) + offsetU * basis.u.x + offsetV * basis.v.x,
      y: Number(origin.y) + offsetU * basis.u.y + offsetV * basis.v.y,
      z: Number(origin.z) + offsetU * basis.u.z + offsetV * basis.v.z,
    },
    dir: basis.dir,
    description: candidate?.description,
  };
}

function buildExactRenderRaysForImageHeightObjects(
  objectRows: any[],
  opticalSystemRows: any[],
  wavelengthUm: number,
  conjugateType: 'infinite' | 'finite',
  axis: 'YZ' | 'XZ' | 'BOTH',
  rayCount: number,
): any[] {
  if (!Array.isArray(objectRows) || objectRows.length === 0) return [];
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return [];

  const traceOptions = {
    allowNonStrict: true,
    useRustWasm: true,
    requireRustWasm: true,
    disableWasmRayTracing: false,
    __renderImageHeightRustPreferred: true,
  };
  const imageSurfaceIndex = opticalSystemRows.findIndex((row: any) => {
    const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
    const normalized = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
    return normalized === 'image' || normalized.startsWith('image');
  });
  const targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);
  const surfaceInfos = withRustRenderSurfaceOrigins(() => calculateSurfaceOrigins(opticalSystemRows));
  const targetSurfaceInfo = Array.isArray(surfaceInfos) ? surfaceInfos[targetSurfaceIndex] : null;
  const getChiefResidualMm = (rayPath: any[], target: { x: number; y: number } | null) => {
    if (!target) return Number.POSITIVE_INFINITY;
    const targetPoint = getRenderTargetPointFromRayPath(rayPath, opticalSystemRows, targetSurfaceIndex);
    const localPoint = targetPoint && targetSurfaceInfo ? transformPointToLocal(targetPoint, targetSurfaceInfo) : targetPoint;
    const localX = Number(localPoint?.x);
    const localY = Number(localPoint?.y);
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) return Number.POSITIVE_INFINITY;
    return Math.hypot(localX - target.x, localY - target.y);
  };

  const rays: any[] = [];
  const objectDebug: any[] = [];
  const overlappingImageHeightSolveEntries: Array<{ objectIndex: number; targetX: number; targetY: number; solvedX: number; solvedY: number }> = [];
  const imageHeightRenderRayCount = Number.isFinite(Number(rayCount)) && Number(rayCount) <= 5
    ? 1
    : Math.max(1, Math.floor(Number(rayCount) || 1));
  objectRows.forEach((row: any, objectIndex: number) => {
    if (!isRenderImageHeightObjectRow(row)) return;
    try {
      const scopedRow = buildAxisScopedRenderImageHeightRow(row, axis);
      const resolvedObjectIndex = Number.isFinite(Number(row?.objectIndex))
        ? Number(row.objectIndex)
        : objectIndex;
      const imageHeightTarget = getRenderImageHeightTargetForAxis(row, axis);
      const exactPattern = axis === 'BOTH' ? 'annular' : 'grid';
      const crossType = axis === 'YZ' ? 'vertical' : (axis === 'XZ' ? 'horizontal' : 'both');
      const resolvedRow = convertImageHeightToEffectiveObject(
        scopedRow,
        opticalSystemRows,
        wavelengthUm,
        conjugateType,
        {
          skipTsValidation: true,
          validationTraceBackend: 'rust',
          disableSolveCache: true,
          disableWarmStartCache: true,
        }
      );
      const separatedResolvedRow = separateOverlappingRenderImageHeightSolvedField(
        resolvedRow,
        row,
        axis,
        resolvedObjectIndex,
        overlappingImageHeightSolveEntries,
      );
      const objectDiag = {
        objectIndex: resolvedObjectIndex,
        requested: rayCount,
        effectiveRequested: imageHeightRenderRayCount,
        starts: 0,
        kept: 0,
        keptPartialNoTarget: 0,
        droppedMissingStart: 0,
        droppedShortPath: 0,
        droppedNoTarget: 0,
        effectivePosition: String(separatedResolvedRow?.__cooptEffectivePosition ?? separatedResolvedRow?.position ?? ''),
        solveMode: String(separatedResolvedRow?.__cooptImageHeightSolve?.mode ?? ''),
        chiefResidualMm: null as number | null,
      };
      const chiefOnlyRayStarts = generateRayStartPointsForObject(
        separatedResolvedRow,
        opticalSystemRows,
        1,
        null,
        {
          pattern: exactPattern,
          wavelengthUm,
          conjugateType,
          pupilScale: 1,
          aimThroughStop: true,
          useChiefRayAnalysis: true,
          allowStopBasedOriginSolve: true,
          originSolveTraceBackend: 'rust',
          imageHeightValidationTraceBackend: 'rust',
          targetSurfaceIndex,
          disableCrossExtent: true,
          crossType,
          exactCrossBeamSampling: true,
          displayAxisAlignedSampling: true,
          preserveChiefNormalEmissionPlane: true,
        }
      );
      const rayStarts = generateRayStartPointsForObject(
        separatedResolvedRow,
        opticalSystemRows,
        imageHeightRenderRayCount,
        null,
        {
          pattern: exactPattern,
          wavelengthUm,
          conjugateType,
          pupilScale: 1,
          aimThroughStop: true,
          useChiefRayAnalysis: true,
          allowStopBasedOriginSolve: true,
          originSolveTraceBackend: 'rust',
          imageHeightValidationTraceBackend: 'rust',
          targetSurfaceIndex,
          disableCrossExtent: true,
          crossType,
          exactCrossBeamSampling: true,
          displayAxisAlignedSampling: true,
          preserveChiefNormalEmissionPlane: true,
        }
      );
      if (!Array.isArray(rayStarts) || rayStarts.length === 0) {
        objectDebug.push(objectDiag);
        return;
      }
      const renderRayStarts = rayStarts;
      objectDiag.starts = renderRayStarts.length;

      const expectedChiefOrigin = rayStarts.expectedChiefOrigin;
      const chiefIndex = renderRayStarts.reduce((bestIndex: number, candidate: any, candidateIndex: number) => {
        const planeU = Number(candidate?.planeCoords?.u);
        const planeV = Number(candidate?.planeCoords?.v);
        if (Number.isFinite(planeU) && Number.isFinite(planeV)) {
          const score = Math.hypot(planeU, planeV);
          const best = renderRayStarts[bestIndex];
          const bestU = Number(best?.planeCoords?.u);
          const bestV = Number(best?.planeCoords?.v);
          const bestScore = (Number.isFinite(bestU) && Number.isFinite(bestV))
            ? Math.hypot(bestU, bestV)
            : Number.POSITIVE_INFINITY;
          return score < bestScore ? candidateIndex : bestIndex;
        }

        const sx = Number(candidate?.startP?.x);
        const sy = Number(candidate?.startP?.y);
        const sz = Number(candidate?.startP?.z);
        const ox = Number(expectedChiefOrigin?.x);
        const oy = Number(expectedChiefOrigin?.y);
        const oz = Number(expectedChiefOrigin?.z);
        if ([sx, sy, sz, ox, oy, oz].every(Number.isFinite)) {
          const score = Math.hypot(sx - ox, sy - oy, sz - oz);
          const best = renderRayStarts[bestIndex];
          const bx = Number(best?.startP?.x);
          const by = Number(best?.startP?.y);
          const bz = Number(best?.startP?.z);
          const bestScore = [bx, by, bz, ox, oy, oz].every(Number.isFinite)
            ? Math.hypot(bx - ox, by - oy, bz - oz)
            : Number.POSITIVE_INFINITY;
          return score < bestScore ? candidateIndex : bestIndex;
        }

        return bestIndex;
      }, 0);
      const chiefStartCandidate = (Array.isArray(chiefOnlyRayStarts) && chiefOnlyRayStarts[0])
        ? chiefOnlyRayStarts[0]
        : (renderRayStarts[chiefIndex] || renderRayStarts[0]);
      const chiefStart = getExactImageHeightChiefStart(
        separatedResolvedRow,
        chiefStartCandidate,
        'Chief render ray (exact ImageHeight solver)'
      );
      const canUseExactChiefEmissionPlane = !!(
        chiefStart?.startP
        && chiefStart?.dir
        && separatedResolvedRow?.__cooptImageHeightSolve?.chiefRay
      );
      const tracedRayStarts = renderRayStarts.map((candidate: any, candidateIndex: number) => {
        if (candidateIndex === chiefIndex && chiefStart?.startP && chiefStart?.dir) {
          return {
            ...candidate,
            ...chiefStart,
            startP: chiefStart.startP,
            dir: chiefStart.dir,
            description: chiefStart.description || candidate?.description,
          };
        }
        if (canUseExactChiefEmissionPlane) {
          const exactPlaneStart = buildRenderRayStartOnChiefPlane(chiefStart, candidate);
          if (exactPlaneStart?.startP && exactPlaneStart?.dir) return exactPlaneStart;
        }
        return candidate;
      });
      const chiefStartP = chiefStart?.startP || { x: 0, y: 0, z: 0 };
      const chiefPlaneU = Number(chiefStartCandidate?.planeCoords?.u ?? chiefStart?.planeCoords?.u);
      const chiefPlaneV = Number(chiefStartCandidate?.planeCoords?.v ?? chiefStart?.planeCoords?.v);
      const solvedChiefLocalHit = separatedResolvedRow?.__cooptImageHeightSolve?.hit || null;
      let imageHeightTargetLocalOffset: { x: number; y: number } | null = null;
      const marginalReferenceStart = tracedRayStarts[chiefIndex]?.startP && tracedRayStarts[chiefIndex]?.dir
        ? tracedRayStarts[chiefIndex]
        : (chiefStartCandidate?.startP && chiefStartCandidate?.dir ? chiefStartCandidate : (renderRayStarts[chiefIndex] || null));
      if (targetSurfaceInfo && marginalReferenceStart?.startP && marginalReferenceStart?.dir && solvedChiefLocalHit) {
        const tracedChiefTargetPoint = traceRayHitPoint(
          opticalSystemRows,
          { pos: marginalReferenceStart.startP, dir: marginalReferenceStart.dir, wavelength: wavelengthUm },
          1.0,
          targetSurfaceIndex,
          traceOptions,
        );
        const tracedChiefLocalHit = tracedChiefTargetPoint ? transformPointToLocal(tracedChiefTargetPoint, targetSurfaceInfo) : null;
        const solvedX = Number(solvedChiefLocalHit?.x);
        const solvedY = Number(solvedChiefLocalHit?.y);
        const tracedX = Number(tracedChiefLocalHit?.x);
        const tracedY = Number(tracedChiefLocalHit?.y);
        if ([solvedX, solvedY, tracedX, tracedY].every(Number.isFinite)) {
          imageHeightTargetLocalOffset = {
            x: solvedX - tracedX,
            y: solvedY - tracedY,
          };
        }
      }

      tracedRayStarts.forEach((rayStart: any, rayIndex: number) => {
        if (!rayStart?.startP || !rayStart?.dir) {
          objectDiag.droppedMissingStart += 1;
          return;
        }
        let rayPath = traceRay(
          opticalSystemRows,
          { pos: rayStart.startP, dir: rayStart.dir, wavelength: wavelengthUm },
          1.0,
          null,
          targetSurfaceIndex,
          traceOptions,
        );
        const tracedTargetPoint = traceRayHitPoint(
          opticalSystemRows,
          { pos: rayStart.startP, dir: rayStart.dir, wavelength: wavelengthUm },
          1.0,
          targetSurfaceIndex,
          traceOptions,
        );
        const solvedChiefTargetPoint = rayIndex === chiefIndex && solvedChiefLocalHit
          ? buildRenderGlobalPointFromLocal(solvedChiefLocalHit, targetSurfaceInfo)
          : null;
        let correctedMarginalTargetPoint = null;
        if (rayIndex !== chiefIndex && imageHeightTargetLocalOffset && tracedTargetPoint && targetSurfaceInfo) {
          const tracedLocalPoint = transformPointToLocal(tracedTargetPoint, targetSurfaceInfo);
          const correctedLocalPoint = tracedLocalPoint ? {
            x: Number(tracedLocalPoint.x) + imageHeightTargetLocalOffset.x,
            y: Number(tracedLocalPoint.y) + imageHeightTargetLocalOffset.y,
            z: Number.isFinite(Number(tracedLocalPoint.z)) ? Number(tracedLocalPoint.z) : 0,
          } : null;
          correctedMarginalTargetPoint = correctedLocalPoint
            ? buildRenderGlobalPointFromLocal(correctedLocalPoint, targetSurfaceInfo)
            : null;
        }
        const preciseTargetPoint = isFiniteRenderPoint(solvedChiefTargetPoint)
          ? solvedChiefTargetPoint
          : (isFiniteRenderPoint(correctedMarginalTargetPoint) ? correctedMarginalTargetPoint : tracedTargetPoint);
        if (isFiniteRenderPoint(preciseTargetPoint)) {
          rayPath = replaceRenderTargetPointInRayPath(rayPath, opticalSystemRows, targetSurfaceIndex, preciseTargetPoint);
        }
        let targetPoint = isFiniteRenderPoint(preciseTargetPoint)
          ? preciseTargetPoint
          : getRenderTargetPointFromRayPath(rayPath, opticalSystemRows, targetSurfaceIndex);
        if (!Array.isArray(rayPath) || rayPath.length <= 1) {
          objectDiag.droppedShortPath += 1;
          return;
        }
        if (!targetPoint) {
          objectDiag.droppedNoTarget += 1;
          return;
        }
        objectDiag.kept += 1;
        if (rayIndex === chiefIndex && targetPoint) {
          const rustResidual = getChiefResidualMm(rayPath, imageHeightTarget);
          objectDiag.chiefResidualMm = Number.isFinite(rustResidual) ? rustResidual : null;
          try {
            const targetLocalPoint = targetPoint && targetSurfaceInfo ? transformPointToLocal(targetPoint, targetSurfaceInfo) : targetPoint;
            (window as any).__COOPT_LAST_IMAGEHEIGHT_EXACT_RENDER = {
              at: new Date().toISOString(),
              objectIndex: resolvedObjectIndex,
              axis,
              rayCount,
              target: imageHeightTarget,
              chiefStart: {
                x: Number(rayStart?.startP?.x),
                y: Number(rayStart?.startP?.y),
                z: Number(rayStart?.startP?.z),
              },
              chiefDir: {
                x: Number(rayStart?.dir?.x),
                y: Number(rayStart?.dir?.y),
                z: Number(rayStart?.dir?.z),
              },
              imageSurfaceIndex: targetSurfaceIndex,
              localHit: targetLocalPoint ? {
                x: Number(targetLocalPoint.x),
                y: Number(targetLocalPoint.y),
                z: Number(targetLocalPoint.z),
              } : null,
              residualMm: rustResidual,
              solve: separatedResolvedRow?.__cooptImageHeightSolve ?? row?.__cooptImageHeightSolve ?? null,
            };
          } catch (_) {}
          if (Number.isFinite(rustResidual) && rustResidual > 1e-4) {
            try {
              (window as any).__COOPT_LAST_IMAGEHEIGHT_RUST_RESIDUAL = {
                at: new Date().toISOString(),
                objectIndex: resolvedObjectIndex,
                residualMm: rustResidual,
                target: imageHeightTarget,
              };
            } catch (_) {}
          } else {
            try { delete (window as any).__COOPT_LAST_IMAGEHEIGHT_RUST_RESIDUAL; } catch (_) {
              (window as any).__COOPT_LAST_IMAGEHEIGHT_RUST_RESIDUAL = null;
            }
          }
        }

        let type = rayIndex === chiefIndex ? 'chief' : 'marginal';
        let side = 'center';
        if (rayIndex !== chiefIndex) {
          const planeU = Number(rayStart?.planeCoords?.u);
          const planeV = Number(rayStart?.planeCoords?.v);
          const deltaX = (Number.isFinite(planeU) && Number.isFinite(chiefPlaneU))
            ? planeU - chiefPlaneU
            : Number(rayStart.startP.x) - Number(chiefStartP.x);
          const deltaY = (Number.isFinite(planeV) && Number.isFinite(chiefPlaneV))
            ? planeV - chiefPlaneV
            : Number(rayStart.startP.y) - Number(chiefStartP.y);
          if (axis === 'XZ') {
            type = deltaX >= 0 ? 'right_marginal' : 'left_marginal';
            side = deltaX >= 0 ? 'right' : 'left';
          } else if (axis === 'YZ') {
            type = deltaY >= 0 ? 'upper_marginal' : 'lower_marginal';
            side = deltaY >= 0 ? 'upper' : 'lower';
          } else if (Math.abs(deltaY) >= Math.abs(deltaX)) {
            type = deltaY >= 0 ? 'upper_marginal' : 'lower_marginal';
            side = deltaY >= 0 ? 'upper' : 'lower';
          } else {
            type = deltaX >= 0 ? 'right_marginal' : 'left_marginal';
            side = deltaX >= 0 ? 'right' : 'left';
          }
        }

        rays.push({
          success: true,
          rayPath,
          objectIndex: resolvedObjectIndex,
          __cooptImageHeightExactRender: true,
          __cooptImageHeightTarget: imageHeightTarget,
          type,
          beamType: type === 'chief'
            ? 'chief'
            : (type.includes('left') || type.includes('right') ? 'horizontal' : 'vertical'),
          side,
          originalRay: {
            type,
            beamType: type === 'chief'
              ? 'chief'
              : (type.includes('left') || type.includes('right') ? 'horizontal' : 'vertical'),
            side,
            objectIndex: resolvedObjectIndex,
            origin: rayStart.startP,
            position: rayStart.startP,
            pos: rayStart.startP,
            direction: rayStart.dir,
            dir: rayStart.dir,
            wavelength: wavelengthUm,
            description: rayStart.description || (type === 'chief' ? 'Chief render ray (exact ImageHeight)' : 'Marginal render ray (exact ImageHeight)'),
          },
        });
      });
      objectDebug.push(objectDiag);
    } catch (error) {
      console.warn('[RenderWindow] Failed to build exact ImageHeight render rays:', error);
    }
  });

  try {
    (rays as any).__cooptExactRenderDebug = objectDebug;
  } catch (_) {}

  return rays;
}

function buildExactLowCountRenderRaysForObjects(
  objectRows: any[],
  opticalSystemRows: any[],
  wavelengthUm: number,
  conjugateType: 'infinite' | 'finite',
  axis: 'YZ' | 'XZ' | 'BOTH',
  rayCount: number,
): any[] {
  if (!Array.isArray(objectRows) || objectRows.length === 0) return [];
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return [];

  const desiredRayCount = Number.isFinite(Number(rayCount)) ? Math.max(1, Math.floor(Number(rayCount))) : 1;
  const generationRayCount = desiredRayCount === 1 ? 2 : desiredRayCount;

  const traceOptions = {
    allowNonStrict: true,
    useRustWasm: true,
    requireRustWasm: true,
    disableWasmRayTracing: false,
    __renderLowCountRustPreferred: true,
  };
  const imageSurfaceIndex = opticalSystemRows.findIndex((row: any) => {
    const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
    const normalized = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
    return normalized === 'image' || normalized.startsWith('image');
  });
  const targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);
  const exactPattern = axis === 'BOTH' ? 'annular' : 'grid';
  const crossType = axis === 'YZ' ? 'vertical' : (axis === 'XZ' ? 'horizontal' : 'both');
  const getCandidateScore = (candidate: any, expectedChiefOrigin: any) => {
    const planeU = Number(candidate?.planeCoords?.u);
    const planeV = Number(candidate?.planeCoords?.v);
    if (Number.isFinite(planeU) && Number.isFinite(planeV)) {
      return Math.hypot(planeU, planeV);
    }
    const sx = Number(candidate?.startP?.x);
    const sy = Number(candidate?.startP?.y);
    const sz = Number(candidate?.startP?.z);
    const ox = Number(expectedChiefOrigin?.x);
    const oy = Number(expectedChiefOrigin?.y);
    const oz = Number(expectedChiefOrigin?.z);
    if ([sx, sy, sz, ox, oy, oz].every(Number.isFinite)) {
      return Math.hypot(sx - ox, sy - oy, sz - oz);
    }
    return Number.POSITIVE_INFINITY;
  };
  const traceExactRayForRender = (startP: any, dir: any, requireTargetHit = false) => {
    let rayPath = traceRay(
      opticalSystemRows,
      { pos: startP, dir, wavelength: wavelengthUm },
      1.0,
      null,
      targetSurfaceIndex,
      traceOptions,
    );
    if (!Array.isArray(rayPath) || rayPath.length <= 1) return null;
    if (requireTargetHit && !getRenderTargetPointFromRayPath(rayPath, opticalSystemRows, targetSurfaceIndex)) {
      return null;
    }
    return rayPath;
  };

  const rays: any[] = [];
  const overlappingImageHeightSolveEntries: Array<{ objectIndex: number; targetX: number; targetY: number; solvedX: number; solvedY: number }> = [];
  objectRows.forEach((row: any, objectIndex: number) => {
    try {
      const scopedRow = isRenderImageHeightObjectRow(row)
        ? buildAxisScopedRenderImageHeightRow(row, axis)
        : row;
      const resolvedRow = isRenderImageHeightObjectRow(row)
        ? convertImageHeightToEffectiveObject(
            scopedRow,
            opticalSystemRows,
            wavelengthUm,
            conjugateType,
            {
              skipTsValidation: true,
              validationTraceBackend: 'rust',
              disableSolveCache: true,
              disableWarmStartCache: true,
            }
          )
        : row;
      const separatedResolvedRow = separateOverlappingRenderImageHeightSolvedField(
        resolvedRow,
        row,
        axis,
        objectIndex,
        overlappingImageHeightSolveEntries,
      );
      const chiefOnlyRayStarts = isRenderImageHeightObjectRow(row)
        ? generateRayStartPointsForObject(
            separatedResolvedRow,
            opticalSystemRows,
            1,
            null,
            {
              pattern: exactPattern,
              wavelengthUm,
              conjugateType,
              pupilScale: 1,
              aimThroughStop: true,
              useChiefRayAnalysis: true,
              allowStopBasedOriginSolve: true,
              originSolveTraceBackend: 'rust',
              imageHeightValidationTraceBackend: 'rust',
              targetSurfaceIndex,
              disableCrossExtent: true,
              crossType,
              exactCrossBeamSampling: true,
              displayAxisAlignedSampling: true,
              preserveChiefNormalEmissionPlane: true,
            }
          )
        : null;
      const rayStarts = generateRayStartPointsForObject(
        separatedResolvedRow,
        opticalSystemRows,
        generationRayCount,
        null,
        {
          pattern: exactPattern,
          wavelengthUm,
          conjugateType,
          pupilScale: 1,
          aimThroughStop: true,
          useChiefRayAnalysis: true,
          allowStopBasedOriginSolve: true,
          originSolveTraceBackend: 'rust',
          imageHeightValidationTraceBackend: 'rust',
          targetSurfaceIndex,
          disableCrossExtent: true,
          crossType,
          exactCrossBeamSampling: true,
          displayAxisAlignedSampling: isRenderImageHeightObjectRow(row),
          preserveChiefNormalEmissionPlane: true,
        }
      );
      const renderRayStarts = Array.isArray(rayStarts) ? rayStarts : [];
      if (renderRayStarts.length === 0) return;
      const isImageHeight = isRenderImageHeightObjectRow(row);
      const imageHeightTarget = isImageHeight ? getRenderImageHeightTargetForAxis(row, axis) : null;
      const expectedChiefOrigin = rayStarts?.expectedChiefOrigin;
      const chiefIndex = renderRayStarts.reduce((bestIndex: number, candidate: any, candidateIndex: number) => {
        const score = getCandidateScore(candidate, expectedChiefOrigin);
        const bestScore = getCandidateScore(renderRayStarts[bestIndex], expectedChiefOrigin);
        return score < bestScore ? candidateIndex : bestIndex;
      }, 0);
      const chiefStartCandidate = isImageHeight && Array.isArray(chiefOnlyRayStarts) && chiefOnlyRayStarts[0]
        ? chiefOnlyRayStarts[0]
        : (renderRayStarts[chiefIndex] || renderRayStarts[0]);
      const chiefStart = isImageHeight
        ? getExactImageHeightChiefStart(
            separatedResolvedRow,
            chiefStartCandidate,
            'Chief render ray (exact ImageHeight solver)'
          )
        : chiefStartCandidate;
      if (!chiefStart?.startP || !chiefStart?.dir) return;
      const chiefRayPath = traceExactRayForRender(chiefStart.startP, chiefStart.dir, isRenderImageHeightObjectRow(row));
      if (!chiefRayPath) return;
      const objectPosition = {
        x: Number(scopedRow?.xHeightAngle ?? scopedRow?.x ?? 0) || 0,
        y: Number(scopedRow?.yHeightAngle ?? scopedRow?.y ?? 0) || 0,
        z: 0,
      };

      const chiefPlaneU = Number(chiefStartCandidate?.planeCoords?.u ?? chiefStart?.planeCoords?.u);
      const chiefPlaneV = Number(chiefStartCandidate?.planeCoords?.v ?? chiefStart?.planeCoords?.v);
      const chiefStartP = chiefStart?.startP || { x: 0, y: 0, z: 0 };

      const pushExactRay = (rayStart: any, type: string, side: string, rayPath: any[]) => {
        rays.push({
          success: true,
          rayPath,
          objectIndex,
          objectPosition,
          ...(isImageHeight ? {
            __cooptImageHeightExactRender: true,
            __cooptImageHeightTarget: imageHeightTarget,
          } : {}),
          type,
          beamType: type === 'chief'
            ? 'chief'
            : (type.includes('left') || type.includes('right') ? 'horizontal' : 'vertical'),
          side,
          originalRay: {
            type,
            beamType: type === 'chief'
              ? 'chief'
              : (type.includes('left') || type.includes('right') ? 'horizontal' : 'vertical'),
            side,
            objectIndex,
            origin: rayStart.startP,
            position: rayStart.startP,
            pos: rayStart.startP,
            direction: rayStart.dir,
            dir: rayStart.dir,
            wavelength: wavelengthUm,
            objectPosition,
            description: rayStart.description || (type === 'chief' ? 'Chief render ray (exact)' : 'Marginal render ray (exact)'),
          },
        });
      };

      pushExactRay(chiefStart, 'chief', 'center', chiefRayPath);

      if (desiredRayCount <= 1) return;

      const additionalIndices = renderRayStarts
        .map((_: any, index: number) => index)
        .filter((index: number) => index !== chiefIndex)
        .sort((indexA: number, indexB: number) => {
          const scoreA = getCandidateScore(renderRayStarts[indexA], expectedChiefOrigin);
          const scoreB = getCandidateScore(renderRayStarts[indexB], expectedChiefOrigin);
          if (Math.abs(scoreA - scoreB) > 1e-9) return scoreA - scoreB;
          return indexA - indexB;
        });

      const candidateExactRays: Array<{ rayStart: any; type: string; side: string; rayPath: any[] }> = [];
      for (const rayIndex of additionalIndices) {
        const rayStart = renderRayStarts[rayIndex];
        if (!rayStart?.startP || !rayStart?.dir) continue;
        const rayPath = traceExactRayForRender(rayStart.startP, rayStart.dir, isImageHeight);
        if (!rayPath) continue;

        const planeU = Number(rayStart?.planeCoords?.u);
        const planeV = Number(rayStart?.planeCoords?.v);
        const deltaX = (Number.isFinite(planeU) && Number.isFinite(chiefPlaneU))
          ? planeU - chiefPlaneU
          : Number(rayStart.startP.x) - Number(chiefStartP.x);
        const deltaY = (Number.isFinite(planeV) && Number.isFinite(chiefPlaneV))
          ? planeV - chiefPlaneV
          : Number(rayStart.startP.y) - Number(chiefStartP.y);

        let type = 'marginal';
        let side = 'center';
        if (axis === 'XZ') {
          type = deltaX >= 0 ? 'right_marginal' : 'left_marginal';
          side = deltaX >= 0 ? 'right' : 'left';
        } else if (axis === 'YZ') {
          type = deltaY >= 0 ? 'upper_marginal' : 'lower_marginal';
          side = deltaY >= 0 ? 'upper' : 'lower';
        } else if (Math.abs(deltaY) >= Math.abs(deltaX)) {
          type = deltaY >= 0 ? 'upper_marginal' : 'lower_marginal';
          side = deltaY >= 0 ? 'upper' : 'lower';
        } else {
          type = deltaX >= 0 ? 'right_marginal' : 'left_marginal';
          side = deltaX >= 0 ? 'right' : 'left';
        }

        candidateExactRays.push({ rayStart, type, side, rayPath });
      }

      const selectedExactRays = selectCrossRaysForAxis(
        candidateExactRays.map((entry) => ({
          ...entry,
          originalRay: {
            type: entry.type,
            side: entry.side,
          },
        })),
        Math.max(0, desiredRayCount - 1),
        axis,
      );

      selectedExactRays.forEach((entry: any) => {
        pushExactRay(entry.rayStart, entry.type, entry.side, entry.rayPath);
      });
      return;
    } catch (error) {
      console.warn('[RenderWindow] Failed to build exact low-count render rays:', error);
    }
  });

  return rays;
}

function replaceImageHeightChiefRaysWithExactRenderTrace(
  rays: any[],
  normalizedObjectRows: any[],
  opticalSystemRows: any[],
  wavelengthUm: number,
  isInfiniteSystem: boolean,
): any[] {
  if (!Array.isArray(rays) || rays.length === 0) return rays;
  if (!Array.isArray(normalizedObjectRows) || normalizedObjectRows.length === 0) return rays;
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return rays;

  const imageSurfaceIndex = opticalSystemRows.findIndex((row: any) => {
    const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
    const normalized = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
    return normalized === 'image' || normalized.startsWith('image');
  });
  const targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);
  const traceOptions = {
    allowNonStrict: true,
    useRustWasm: true,
    requireRustWasm: true,
    disableWasmRayTracing: false,
  };
  const overlappingImageHeightSolveEntries: Array<{ objectIndex: number; targetX: number; targetY: number; solvedX: number; solvedY: number }> = [];

  const replacedRays = rays.map((ray: any) => {
    const type = String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase();
    if (type !== 'chief') return ray;
    if (ray?.__cooptImageHeightExactRender === true) return ray;

    const objectIndex = Number.isFinite(Number(ray?.objectIndex))
      ? Number(ray.objectIndex)
      : (Number.isFinite(Number(ray?.originalRay?.objectIndex)) ? Number(ray.originalRay.objectIndex) : 0);
    const objectRow = normalizedObjectRows[objectIndex];
    const posNorm = String(objectRow?.__cooptOriginalPosition ?? objectRow?.position ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
    const hasImageHeightTarget = objectRow?.__cooptImageHeightTarget
      && Number.isFinite(Number(objectRow.__cooptImageHeightTarget.x))
      && Number.isFinite(Number(objectRow.__cooptImageHeightTarget.y));
    if (posNorm !== 'imageheight' && !hasImageHeightTarget) return ray;

    const dropFallbackChiefRay = (reason: string) => {
      try {
        (window as any).__COOPT_LAST_DROPPED_IMAGEHEIGHT_CHIEF = {
          at: new Date().toISOString(),
          reason,
          objectIndex,
          target: objectRow?.__cooptImageHeightTarget ?? null,
        };
      } catch (_) {}
      return null;
    };

    try {
      const resolvedObjectRow = hasImageHeightTarget || posNorm === 'imageheight'
        ? convertImageHeightToEffectiveObject(
            objectRow,
            opticalSystemRows,
            wavelengthUm,
            isInfiniteSystem ? 'infinite' : 'finite',
            {
              skipTsValidation: true,
              validationTraceBackend: 'rust',
              disableSolveCache: true,
              disableWarmStartCache: true,
            }
          )
        : objectRow;
      const separatedResolvedObjectRow = separateOverlappingRenderImageHeightSolvedField(
        resolvedObjectRow,
        objectRow,
        'BOTH',
        objectIndex,
        overlappingImageHeightSolveEntries,
      );
      const rayStarts = generateRayStartPointsForObject(
          separatedResolvedObjectRow,
        opticalSystemRows,
        1,
        null,
        {
          pattern: 'annular',
          wavelengthUm,
          conjugateType: isInfiniteSystem ? 'infinite' : 'finite',
          aimThroughStop: true,
          useChiefRayAnalysis: true,
          allowStopBasedOriginSolve: true,
          imageHeightValidationTraceBackend: 'rust',
          preserveChiefNormalEmissionPlane: true,
          targetSurfaceIndex,
          disableCrossExtent: true,
        }
      );
      const chiefStart = getExactImageHeightChiefStart(
        separatedResolvedObjectRow,
        Array.isArray(rayStarts) ? rayStarts[0] : null,
        'Chief render ray (exact ImageHeight solver)'
      );
      if (!chiefStart?.startP || !chiefStart?.dir) return dropFallbackChiefRay('no-chief-start');

      const rayPath = traceRay(
        opticalSystemRows,
        { pos: chiefStart.startP, dir: chiefStart.dir, wavelength: wavelengthUm },
        1.0,
        null,
        targetSurfaceIndex,
        traceOptions,
      );
      if (!Array.isArray(rayPath) || rayPath.length <= 1) return dropFallbackChiefRay('invalid-ray-path');
      const reachedTarget = !!getRenderTargetPointFromRayPath(rayPath, opticalSystemRows, targetSurfaceIndex);
      if (!reachedTarget) {
        return dropFallbackChiefRay('did-not-reach-target');
      }

      return {
        ...ray,
        success: true,
        rayPath,
        objectIndex,
        type: 'chief',
        beamType: 'chief',
        side: 'center',
        originalRay: {
          ...(ray?.originalRay || {}),
          type: 'chief',
          beamType: 'chief',
          side: 'center',
          objectIndex,
          origin: chiefStart.startP,
          position: chiefStart.startP,
          pos: chiefStart.startP,
          direction: chiefStart.dir,
          dir: chiefStart.dir,
          wavelength: wavelengthUm,
          description: chiefStart.description || 'Chief render ray (exact ImageHeight)',
        },
      };
    } catch (error) {
      console.warn('[RenderWindow] Failed to replace ImageHeight chief ray with exact render trace:', error);
      return dropFallbackChiefRay('replacement-error');
    }
  });

  return replacedRays.filter((ray: any) => !!ray);
}

function getRenderImageHeightTarget(row: any): { x: number; y: number } | null {
  const positionNorm = String(row?.position ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  const effectivePositionNorm = String(row?.__cooptEffectivePosition ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  const isRawImageHeightRow = positionNorm === 'imageheight' && !effectivePositionNorm;
  const tableX = Number(row?.xHeightAngle);
  const tableY = Number(row?.yHeightAngle);
  if (isRawImageHeightRow && Number.isFinite(tableX) && Number.isFinite(tableY)) {
    return { x: tableX, y: tableY };
  }

  const storedTarget = row?.__cooptImageHeightTarget;
  if (storedTarget && Number.isFinite(Number(storedTarget.x)) && Number.isFinite(Number(storedTarget.y))) {
    return { x: Number(storedTarget.x), y: Number(storedTarget.y) };
  }

  const heightX = Number(row?.xHeight ?? row?.heightX ?? row?.['object x']);
  const heightY = Number(row?.yHeight ?? row?.heightY ?? row?.['object y']);
  if (Number.isFinite(heightX) && Number.isFinite(heightY)) {
    return { x: heightX, y: heightY };
  }

  if (Number.isFinite(tableX) && Number.isFinite(tableY)) {
    return { x: tableX, y: tableY };
  }
  return null;
}

function getRenderImageHeightTargetForAxis(
  row: any,
  axis: 'YZ' | 'XZ' | 'BOTH',
): { x: number; y: number } | null {
  const target = getRenderImageHeightTarget(row);
  if (!target) return null;
  if (axis === 'XZ') return { x: target.x, y: 0 };
  if (axis === 'YZ') return { x: 0, y: target.y };
  return target;
}

function getExactImageHeightChiefStart(resolvedRow: any, fallbackRayStart: any, label: string): any {
  const chiefOrigin = resolvedRow?.__cooptImageHeightSolve?.chiefRay?.origin;
  const chiefDir = resolvedRow?.__cooptImageHeightSolve?.chiefRay?.dir;
  const ox = Number(chiefOrigin?.x);
  const oy = Number(chiefOrigin?.y);
  const oz = Number(chiefOrigin?.z);
  const dx = Number(chiefDir?.x);
  const dy = Number(chiefDir?.y);
  const dz = Number(chiefDir?.z);
  if (![ox, oy, oz, dx, dy, dz].every(Number.isFinite)) return fallbackRayStart;

  return {
    ...(fallbackRayStart && typeof fallbackRayStart === 'object' ? fallbackRayStart : {}),
    startP: { x: ox, y: oy, z: oz },
    dir: { x: dx, y: dy, z: dz },
    planeCoords: fallbackRayStart?.planeCoords ?? { u: 0, v: 0 },
    description: fallbackRayStart?.description || label,
  };
}

function separateOverlappingRenderImageHeightSolvedField(
  resolvedRow: any,
  sourceRow: any,
  axis: 'YZ' | 'XZ' | 'BOTH',
  objectIndex: number,
  seenEntries: Array<{ objectIndex: number; targetX: number; targetY: number; solvedX: number; solvedY: number }>,
): any {
  if (!resolvedRow || typeof resolvedRow !== 'object') return resolvedRow;
  if (!isRenderImageHeightObjectRow(sourceRow)) return resolvedRow;

  const target = getRenderImageHeightTarget(sourceRow);
  if (!target) return resolvedRow;

  const solvedX = Number(resolvedRow?.xHeightAngle ?? resolvedRow?.xHeight ?? resolvedRow?.x);
  const solvedY = Number(resolvedRow?.yHeightAngle ?? resolvedRow?.yHeight ?? resolvedRow?.y);
  if (!Number.isFinite(solvedX) || !Number.isFinite(solvedY)) return resolvedRow;

  const overlappingEntries = seenEntries.filter((entry) => (
    Math.abs(entry.solvedX - solvedX) <= 1e-9
    && Math.abs(entry.solvedY - solvedY) <= 1e-9
    && (Math.abs(entry.targetX - target.x) > 1e-6 || Math.abs(entry.targetY - target.y) > 1e-6)
  ));

  let adjustedRow = resolvedRow;
  if (overlappingEntries.length > 0) {
    const firstOverlap = overlappingEntries[0];
    const deltaTargetX = target.x - firstOverlap.targetX;
    const deltaTargetY = target.y - firstOverlap.targetY;
    const splitOrdinal = overlappingEntries.length;
    const baseMagnitude = Math.max(Math.abs(deltaTargetX), Math.abs(deltaTargetY), 1);
    const splitStep = Math.min(5e-3, Math.max(1e-4, baseMagnitude * 1e-4));
    const fallbackSign = (objectIndex - firstOverlap.objectIndex) >= 0 ? 1 : -1;

    let offsetX = 0;
    let offsetY = 0;
    if (axis === 'YZ') {
      offsetY = splitStep * splitOrdinal * (Math.sign(deltaTargetY) || Math.sign(deltaTargetX) || fallbackSign);
    } else if (axis === 'XZ') {
      offsetX = splitStep * splitOrdinal * (Math.sign(deltaTargetX) || Math.sign(deltaTargetY) || fallbackSign);
    } else if (Math.abs(deltaTargetX) >= Math.abs(deltaTargetY)) {
      offsetX = splitStep * splitOrdinal * (Math.sign(deltaTargetX) || fallbackSign);
      offsetY = splitStep * 0.35 * splitOrdinal * (Math.sign(deltaTargetY) || Math.sign(deltaTargetX) || fallbackSign);
    } else {
      offsetY = splitStep * splitOrdinal * (Math.sign(deltaTargetY) || fallbackSign);
      offsetX = splitStep * 0.35 * splitOrdinal * (Math.sign(deltaTargetX) || Math.sign(deltaTargetY) || fallbackSign);
    }

    adjustedRow = {
      ...resolvedRow,
      xHeightAngle: solvedX + offsetX,
      yHeightAngle: solvedY + offsetY,
      x: Number.isFinite(Number(resolvedRow?.x)) ? Number(resolvedRow.x) + offsetX : solvedX + offsetX,
      y: Number.isFinite(Number(resolvedRow?.y)) ? Number(resolvedRow.y) + offsetY : solvedY + offsetY,
      __cooptRenderImageHeightSplit: {
        objectIndex,
        splitOrdinal,
        offsetX,
        offsetY,
        baseSolved: { x: solvedX, y: solvedY },
        target: { x: target.x, y: target.y },
      },
    };
  }

  seenEntries.push({
    objectIndex,
    targetX: target.x,
    targetY: target.y,
    solvedX,
    solvedY,
  });
  return adjustedRow;
}

function buildAxisScopedRenderImageHeightRow(
  row: any,
  axis: 'YZ' | 'XZ' | 'BOTH',
): any {
  const fullTarget = getRenderImageHeightTarget(row);
  if (!fullTarget) return row;
  return {
    ...row,
    __cooptCrossSectionAxis: axis,
    __cooptOriginalImageHeightTarget: row?.__cooptOriginalImageHeightTarget ?? fullTarget,
  };
}

function withRustRenderSurfaceOrigins<T>(callback: () => T): T {
  const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
  const hadOwnFlag = !!(g && Object.prototype.hasOwnProperty.call(g, '__COOPT_USE_RUST_SURFACE_ORIGINS'));
  const previousFlag = g ? g.__COOPT_USE_RUST_SURFACE_ORIGINS : undefined;
  if (g) g.__COOPT_USE_RUST_SURFACE_ORIGINS = true;
  try {
    return callback();
  } finally {
    if (!g) return;
    if (hadOwnFlag) {
      g.__COOPT_USE_RUST_SURFACE_ORIGINS = previousFlag;
    } else {
      try { delete g.__COOPT_USE_RUST_SURFACE_ORIGINS; } catch (_) {
        g.__COOPT_USE_RUST_SURFACE_ORIGINS = previousFlag;
      }
    }
  }
}

function buildRenderObjectColorSlotMap(rows: any[]): Map<number, number> {
  const slotByKey = new Map<string, number>();
  const objectSlotMap = new Map<number, number>();
  if (!Array.isArray(rows) || rows.length === 0) return objectSlotMap;

  rows.forEach((row: any, index: number) => {
    const target = getRenderImageHeightTarget(row);
    const key = target
      ? `imageheight:${target.x.toFixed(6)}:${target.y.toFixed(6)}`
      : `object:${index}`;
    let slot = slotByKey.get(key);
    if (!Number.isFinite(slot)) {
      slot = slotByKey.size;
      slotByKey.set(key, slot);
    }
    objectSlotMap.set(index, Number(slot));
  });

  return objectSlotMap;
}

function attachRenderObjectColorSlots(rays: any[], objectRows: any[]): any[] {
  if (!Array.isArray(rays) || rays.length === 0) return Array.isArray(rays) ? rays : [];
  const colorSlotMap = buildRenderObjectColorSlotMap(objectRows);
  if (colorSlotMap.size === 0) return rays;

  return rays.map((ray: any) => {
    const objectIndex = Number.isFinite(Number(ray?.objectIndex))
      ? Number(ray.objectIndex)
      : (Number.isFinite(Number(ray?.originalRay?.objectIndex)) ? Number(ray.originalRay.objectIndex) : 0);
    const colorSlot = colorSlotMap.get(objectIndex);
    if (!Number.isFinite(colorSlot)) return ray;
    return {
      ...ray,
      __cooptColorSlot: Number(colorSlot),
      originalRay: {
        ...(ray?.originalRay || {}),
        __cooptColorSlot: Number(colorSlot),
      },
    };
  });
}

function preserveRenderImageHeightRow(
  row: any,
  index: number,
  _opticalSystemRows: any[],
  wavelengthUm: number,
  conjugateType: 'infinite' | 'finite'
): any {
  const target = getRenderImageHeightTarget(row);
  if (!target) return row;

  return {
    ...row,
    __cooptOriginalPosition: row?.__cooptOriginalPosition ?? row?.position,
    __cooptImageHeightTarget: { x: target.x, y: target.y },
    __cooptRenderApproxImageHeight: false,
    __cooptRenderApproxDebug: {
      objectIndex: index,
      sourcePosition: row?.position ?? null,
      targetX: target.x,
      targetY: target.y,
      conjugateType,
      wavelengthUm,
      normalization: 'preserve-imageheight-row',
    },
  };
}

function readRenderSurfaceSemidiaMm(surface: any): number | null {
  const candidates: Array<{ value: any; isDiameter: boolean }> = [
    { value: surface?.__cooptActualSemidia, isDiameter: false },
    { value: surface?.semidia, isDiameter: false },
    { value: surface?.semiDiameter, isDiameter: false },
    { value: surface?.['Semi Diameter'], isDiameter: false },
    { value: surface?.['semi diameter'], isDiameter: false },
    { value: surface?.diameter, isDiameter: true },
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate.value);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    return candidate.isDiameter ? parsed * 0.5 : parsed;
  }
  return null;
}

function getMaxRenderImageHeightTargetMm(objectRows: any[]): number | null {
  if (!Array.isArray(objectRows) || objectRows.length === 0) return null;
  let maxTarget = 0;
  for (const row of objectRows) {
    const target = getRenderImageHeightTarget(row);
    if (!target) continue;
    const candidate = Math.max(Math.abs(Number(target.x) || 0), Math.abs(Number(target.y) || 0));
    if (Number.isFinite(candidate)) maxTarget = Math.max(maxTarget, candidate);
  }
  return maxTarget > 0 ? maxTarget : null;
}

function getRenderImageSemidiaWarning(opticalSystemRows: any[], objectRows: any[]): RenderImageSemidiaWarning | null {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return null;
  const maxTargetHeight = getMaxRenderImageHeightTargetMm(objectRows);
  if (!(Number.isFinite(maxTargetHeight) && maxTargetHeight > 0)) return null;
  const imageSurfaceIndex = opticalSystemRows.findIndex((row: any) => {
    const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
    const normalized = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    return normalized === 'image' || normalized.startsWith('image');
  });
  if (imageSurfaceIndex < 0) return null;
  const semidia = readRenderSurfaceSemidiaMm(opticalSystemRows[imageSurfaceIndex]);
  if (!(Number.isFinite(semidia) && semidia > 0)) return null;
  const shortfall = Number(maxTargetHeight) - Number(semidia);
  if (!(Number.isFinite(shortfall) && shortfall > 1e-6)) return null;
  return {
    imageSurfaceIndex,
    semidia: Number(semidia),
    maxTargetHeight: Number(maxTargetHeight),
    shortfall,
    message: `Warning: Image semidia ${Number(semidia).toFixed(2)} < max Image Height ${Number(maxTargetHeight).toFixed(2)}`,
  };
}

function applyRenderImageSemidiaWarning(rows: any[], warning: RenderImageSemidiaWarning | null): any[] {
  if (!warning || !Array.isArray(rows) || rows.length === 0) return rows;
  if (!Number.isInteger(warning.imageSurfaceIndex) || warning.imageSurfaceIndex < 0 || warning.imageSurfaceIndex >= rows.length) return rows;
  const nextRows = rows.slice();
  nextRows[warning.imageSurfaceIndex] = {
    ...(rows[warning.imageSurfaceIndex] || {}),
    __cooptRenderImageSemidiaWarning: warning,
  };
  return nextRows;
}

function formatRenderWindowStatus(baseStatus: string, warning: RenderImageSemidiaWarning | null): string {
  if (!warning) return baseStatus;
  return `${baseStatus} | ${warning.message}`;
}

function readCooptPerfCounters(): Record<string, CooptPerfCounter> {
  try {
    const raw = (globalThis as typeof globalThis & {
      __cooptPerf?: { samples?: Record<string, CooptPerfCounter> };
    }).__cooptPerf?.samples;
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(
      Object.entries(raw).map(([name, counter]) => [
        name,
        {
          count: Number(counter?.count) || 0,
          totalMs: Number(counter?.totalMs) || 0,
          maxMs: Number(counter?.maxMs) || 0,
          lastMs: Number(counter?.lastMs) || 0,
        }
      ])
    );
  } catch (_) {
    return {};
  }
}

function summarizeCooptPerfCounters(options?: {
  limit?: number;
  sortBy?: 'lastMs' | 'totalMs' | 'maxMs' | 'avgMs' | 'count';
  names?: string[];
  minCount?: number;
  minMs?: number;
}): Array<{
  name: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  lastMs: number;
}> {
  const counters = readCooptPerfCounters();
  const limit = Math.max(1, Math.min(50, Number(options?.limit) || 10));
  const sortBy = options?.sortBy || 'lastMs';
  const minCount = Math.max(0, Number(options?.minCount) || 0);
  const minMs = Math.max(0, Number(options?.minMs) || 0);
  const includeNames = Array.isArray(options?.names) && options?.names.length > 0
    ? new Set(options?.names.map((name) => String(name || '').trim()).filter(Boolean))
    : null;

  const rows = Object.entries(counters)
    .map(([name, counter]) => {
      const count = Number(counter?.count) || 0;
      const totalMs = Number(counter?.totalMs) || 0;
      const maxMs = Number(counter?.maxMs) || 0;
      const lastMs = Number(counter?.lastMs) || 0;
      const avgMs = count > 0 ? totalMs / count : 0;
      return { name, count, totalMs, avgMs, maxMs, lastMs };
    })
    .filter((row) => {
      if (includeNames && !includeNames.has(row.name)) return false;
      if (row.count < minCount) return false;
      return Math.max(row.lastMs, row.maxMs, row.avgMs, row.totalMs) >= minMs;
    })
    .sort((left, right) => {
      const delta = Number(right[sortBy]) - Number(left[sortBy]);
      if (Math.abs(delta) > 0.001) return delta;
      return right.totalMs - left.totalMs;
    })
    .slice(0, limit);

  return rows.map((row) => ({
    ...row,
    totalMs: Number(row.totalMs.toFixed(2)),
    avgMs: Number(row.avgMs.toFixed(2)),
    maxMs: Number(row.maxMs.toFixed(2)),
    lastMs: Number(row.lastMs.toFixed(2)),
  }));
}

function clearCooptPerfCounters(names?: string[]): void {
  try {
    const g = globalThis as typeof globalThis & {
      __cooptPerf?: { samples?: Record<string, CooptPerfCounter> };
    };
    if (!g.__cooptPerf || typeof g.__cooptPerf !== 'object') {
      g.__cooptPerf = { samples: {} };
      return;
    }
    if (!g.__cooptPerf.samples || typeof g.__cooptPerf.samples !== 'object') {
      g.__cooptPerf.samples = {};
      return;
    }
    if (!Array.isArray(names) || names.length <= 0) {
      g.__cooptPerf.samples = {};
      return;
    }
    for (const name of names) {
      delete g.__cooptPerf.samples[String(name || '')];
    }
  } catch (_) {}
}

function diffCooptPerfCounters(
  before: Record<string, CooptPerfCounter>,
  keys: readonly string[]
): Array<{ name: string; countDelta: number; totalMsDelta: number; lastMs: number; maxMs: number }> {
  const after = readCooptPerfCounters();
  const results: Array<{ name: string; countDelta: number; totalMsDelta: number; lastMs: number; maxMs: number }> = [];
  for (const name of keys) {
    const prev = before[name] || { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
    const next = after[name] || { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
    const countDelta = Math.max(0, next.count - prev.count);
    const totalMsDelta = Math.max(0, next.totalMs - prev.totalMs);
    if (countDelta <= 0 && totalMsDelta <= 0.25) continue;
    results.push({ name, countDelta, totalMsDelta, lastMs: next.lastMs, maxMs: next.maxMs });
  }
  return results;
}

function formatTimingMs(durationMs: number): string {
  const safe = Number(durationMs);
  if (!Number.isFinite(safe) || safe < 0.5) return '0ms';
  if (safe >= 100) return `${Math.round(safe)}ms`;
  if (safe >= 10) return `${safe.toFixed(1)}ms`;
  return `${safe.toFixed(2)}ms`;
}

function formatRenderTimingSummary(
  stages: RenderTimingStage[],
  blockPerfEntries: Array<{ name: string; countDelta: number; totalMsDelta: number }>
): string {
  const parts: string[] = [];
  for (const stage of stages) {
    if (!Number.isFinite(stage.ms) || stage.ms < 1) continue;
    parts.push(`${stage.label} ${formatTimingMs(stage.ms)}`);
  }
  for (const entry of blockPerfEntries) {
    if (!Number.isFinite(entry.totalMsDelta) || entry.totalMsDelta < 1) continue;
    const label = BLOCK_PERF_LABELS[entry.name] || entry.name;
    const suffix = entry.countDelta > 1 ? `/${entry.countDelta}x` : '';
    parts.push(`${label} ${formatTimingMs(entry.totalMsDelta)}${suffix}`);
  }
  return parts.join(' | ');
}

function getInitial3DLightRayCount(rayCount: number): number {
  const safeRayCount = Number.isFinite(Number(rayCount)) ? Math.max(1, Math.floor(Number(rayCount))) : 1;
  return safeRayCount;
}

function getLiveRenderRayCount(rayCount: number): number {
  const safeRayCount = Number.isFinite(Number(rayCount)) ? Math.max(1, Math.floor(Number(rayCount))) : 1;
  return safeRayCount;
}

function isPlainObject(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseColorToInt(value: any): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(0xffffff, Math.floor(value)));
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const expanded = hex.split('').map((ch) => ch + ch).join('');
      const n = Number.parseInt(expanded, 16);
      return Number.isFinite(n) ? n : null;
    }
    if (hex.length === 6) {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  if (/^0x[0-9a-f]+$/i.test(s)) {
    const n = Number.parseInt(s.slice(2), 16);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.max(0, Math.min(0xffffff, Math.floor(n))) : null;
}

function colorIntToHexString(value: number | null, fallback = '#00CCFF'): string {
  if (!Number.isFinite(Number(value))) return fallback;
  const safe = Math.max(0, Math.min(0xffffff, Math.floor(Number(value))));
  return `#${safe.toString(16).padStart(6, '0').toUpperCase()}`;
}

function surfaceColorKeyStable(surface: any, index0: number): string {
  try {
    const bid = String(surface?._blockId ?? '').trim();
    const role = String(surface?._surfaceRole ?? '').trim();
    if (bid && role) return `p:${bid}|${role}`;
  } catch (_) {}
  try {
    const sid = Number(surface?.id);
    if (Number.isFinite(sid)) return `id:${Math.floor(sid)}`;
  } catch (_) {}
  return `i:${Math.floor(Number(index0) || 0)}`;
}

function surfaceColorKeysAll(surface: any, index0: number): string[] {
  const keys: string[] = [];
  try {
    const bid = String(surface?._blockId ?? '').trim();
    const role = String(surface?._surfaceRole ?? '').trim();
    if (bid && role) keys.push(`p:${bid}|${role}`);
  } catch (_) {}
  try {
    const sid = Number(surface?.id);
    if (Number.isFinite(sid)) keys.push(`id:${Math.floor(sid)}`);
  } catch (_) {}
  keys.push(`i:${Math.floor(Number(index0) || 0)}`);
  return [...new Set(keys.map((k) => String(k || '').trim()).filter(Boolean))];
}

function resolveOverrideColorHex(overrides: Record<string, any>, keys: string[]): string | null {
  for (const key of keys) {
    const parsed = parseColorToInt(overrides?.[key]);
    if (parsed !== null) return colorIntToHexString(parsed);
  }
  return null;
}

function loadSurfaceColorOverridesSafe(): Record<string, any> {
  try {
    const raw = localStorage.getItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveSurfaceColorOverridesSafe(overrides: Record<string, any>): void {
  try {
    localStorage.setItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
  } catch (_) {}
}

function formatRenderScaleLabelMm(distanceMm: number): string {
  const mm = Number(distanceMm);
  if (!Number.isFinite(mm) || mm <= 0) return 'Scale unavailable';
  if (mm >= 1000) {
    const m = mm / 1000;
    return m >= 10 ? `${Math.round(m)} m` : `${m.toFixed(1)} m`;
  }
  if (mm >= 1) {
    if (mm >= 100) return `${Math.round(mm)} mm`;
    if (mm >= 10) return `${mm.toFixed(1)} mm`;
    return `${mm.toFixed(2)} mm`;
  }
  const um = mm * 1000;
  if (um >= 100) return `${Math.round(um)} μm`;
  if (um >= 10) return `${um.toFixed(1)} μm`;
  return `${um.toFixed(2)} μm`;
}

function chooseRenderScaleBar(mmPerPixel: number): { label: string; widthPx: number } {
  const mmpp = Number(mmPerPixel);
  if (!Number.isFinite(mmpp) || mmpp <= 0) {
    return { label: 'Scale unavailable', widthPx: RENDER_SCALE_BAR_TARGET_WIDTH_PX };
  }

  const minDistanceMm = 0.001; // 1 μm
  const niceSteps = [1, 2, 5];
  const targetDistanceMm = Math.max(minDistanceMm, mmpp * RENDER_SCALE_BAR_TARGET_WIDTH_PX);
  const exponent = Math.floor(Math.log10(targetDistanceMm));

  let bestDistanceMm = targetDistanceMm;
  let bestWidthPx = targetDistanceMm / mmpp;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let exp = exponent - 1; exp <= exponent + 1; exp += 1) {
    for (const step of niceSteps) {
      const distanceMm = Math.max(minDistanceMm, step * (10 ** exp));
      const widthPx = distanceMm / mmpp;
      if (!Number.isFinite(widthPx) || widthPx <= 0) continue;

      const clampedWidthPx = Math.max(
        RENDER_SCALE_BAR_MIN_WIDTH_PX,
        Math.min(RENDER_SCALE_BAR_MAX_WIDTH_PX, widthPx),
      );
      const penalty = widthPx < RENDER_SCALE_BAR_MIN_WIDTH_PX || widthPx > RENDER_SCALE_BAR_MAX_WIDTH_PX ? 1000 : 0;
      const score = penalty + Math.abs(clampedWidthPx - RENDER_SCALE_BAR_TARGET_WIDTH_PX);
      if (score < bestScore) {
        bestScore = score;
        bestDistanceMm = distanceMm;
        bestWidthPx = clampedWidthPx;
      }
    }
  }

  return {
    label: formatRenderScaleLabelMm(bestDistanceMm),
    widthPx: bestWidthPx,
  };
}

function applyRenderImageHeightDisplaySpacing(
  opticalSystemRows: any[],
  objectRows: any[],
  wavelengthUm = 0.5876,
): any[] {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return opticalSystemRows;
  const maxTargetHeight = getMaxRenderImageHeightTargetMm(objectRows);
  if (!(Number.isFinite(maxTargetHeight) && maxTargetHeight > 0)) return opticalSystemRows;

  const objectSurface = opticalSystemRows[0] || {};
  const thicknessRaw = objectSurface?.thickness;
  const thicknessStr = String(thicknessRaw ?? '').trim().toUpperCase();
  const thicknessVal = Number(thicknessRaw);
  const isInfiniteSystem = (
    thicknessRaw === Infinity ||
    thicknessStr === 'INF' ||
    thicknessStr === 'INFINITY' ||
    thicknessStr === '∞' ||
    (Number.isFinite(thicknessVal) && Math.abs(thicknessVal) > 1e6)
  );
  if (!isInfiniteSystem) return opticalSystemRows;

  const currentRenderDistance = Number(objectSurface?.objectRenderDistance);
  if (Number.isFinite(currentRenderDistance) && currentRenderDistance > 0) {
    return opticalSystemRows;
  }

  let displayDistance = 0;

  try {
    const paraxial = getRenderParaxialDataCached(opticalSystemRows, wavelengthUm);
    const focalLength = Math.abs(Number(paraxial?.focalLength));
    if (Number.isFinite(focalLength) && focalLength > 0) {
      displayDistance = Math.max(displayDistance, focalLength);
    }
  } catch (_) {}

  displayDistance = Math.max(displayDistance, 100);

  displayDistance = Math.max(displayDistance, Number(maxTargetHeight));
  if (!(Number.isFinite(displayDistance) && displayDistance > 0)) return opticalSystemRows;
  if (Number.isFinite(currentRenderDistance) && Math.abs(currentRenderDistance - displayDistance) < 1e-6) {
    return opticalSystemRows;
  }

  const nextRows = opticalSystemRows.slice();
  nextRows[0] = {
    ...objectSurface,
    objectRenderDistance: displayDistance,
    __cooptRenderImageHeightDisplayDistance: displayDistance,
  };
  return nextRows;
}

function isCoordBreakSurface(surface: any): boolean {
  const surfType = String(surface?.surfType || surface?.type || '').trim().toLowerCase();
  const objType = String(surface?.['object type'] || '').trim().toLowerCase();
  return (
    surfType === 'coord break' || surfType === 'coordinate break' ||
    surfType === 'cb' || surfType === 'coordtrans' ||
    surfType === 'coordinatebreak' || surfType === 'coord trans' ||
    surfType === 'coordinate transform' || surfType === 'ct' ||
    objType === 'coord break' || objType === 'coordinate break' ||
    objType === 'cb' || objType === 'coordtrans' ||
    objType === 'coordinatebreak'
  );
}

function isGapSurface(surface: any): boolean {
  const blockType = String(surface?._blockType ?? surface?.blockType ?? '').trim().toLowerCase();
  if (blockType === 'gap' || blockType === 'airgap') return true;
  const objType = String(surface?.['object type'] ?? surface?.type ?? '').trim().toLowerCase();
  if (objType === 'gap' || objType === 'air gap' || objType === 'airgap') return true;
  const role = String(surface?._surfaceRole ?? '').trim().toLowerCase();
  if (role === 'gap' || role === 'airgap') return true;
  return false;
}

function isObjectSurface(surface: any): boolean {
  const objectType = String(surface?.['object type'] ?? surface?.type ?? '').trim().toLowerCase();
  return objectType === 'object';
}

function isImageSurface(surface: any): boolean {
  const objectType = String(surface?.['object type'] ?? surface?.type ?? '').trim().toLowerCase();
  const blockType = String(surface?._blockType ?? surface?.blockType ?? '').trim().toLowerCase();
  return objectType === 'image' || blockType === 'imagesurface';
}

function isStopSurface(surface: any): boolean {
  const objectType = String(surface?.['object type'] ?? surface?.type ?? '').trim().toLowerCase();
  const blockType = String(surface?._blockType ?? surface?.blockType ?? '').trim().toLowerCase();
  return objectType === 'stop' || objectType === 'sto' || blockType === 'stop';
}

function hasLensTag(surface: any): boolean {
  const blockType = String(surface?._blockType ?? surface?.blockType ?? '').trim().toLowerCase();
  const surfaceRole = String(surface?._surfaceRole ?? surface?.surfaceRole ?? '').trim().toLowerCase();
  if (blockType === 'lens' || blockType === 'glass' || blockType === 'element') return true;
  if (surfaceRole === 'lens' || surfaceRole === 'front' || surfaceRole === 'back') return true;
  if (/^s\d+$/.test(surfaceRole)) return true;
  return false;
}

function isRenderableLensCandidateSurface(surface: any): boolean {
  if (!surface) return false;
  if (isObjectSurface(surface)) return false;
  if (isImageSurface(surface)) return false;
  if (isStopSurface(surface)) return false;
  if (isGapSurface(surface)) return false;
  if (isCoordBreakSurface(surface)) return false;
  return true;
}

function isGlassMaterial(materialValue: any): boolean {
  const material = String(materialValue ?? '').trim().toUpperCase();
  if (!material) return false;
  return !(material === 'AIR' || material === '0' || material === 'MIRROR');
}

function isLensInterval(front: any, back: any): boolean {
  if (!front || !back) return false;
  if (!isRenderableLensCandidateSurface(front) || !isRenderableLensCandidateSurface(back)) return false;
  const frontBlockId = String(front?._blockId ?? front?.blockId ?? '').trim();
  const backBlockId = String(back?._blockId ?? back?.blockId ?? '').trim();
  if (!frontBlockId || !backBlockId || frontBlockId !== backBlockId) return false;
  return (isGlassMaterial(front?.material) || hasLensTag(front)) && (isGlassMaterial(back?.material) || hasLensTag(back));
}

function buildRenderableSurfaceNumberMap(opticalSystemRows: any[]): Map<number, number> {
  const surfaceNumberMap = new Map<number, number>();
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return surfaceNumberMap;
  let visibleSurfaceNo = 0;
  for (let index = 0; index < opticalSystemRows.length; index += 1) {
    const surface = opticalSystemRows[index];
    if (!isRenderableLensCandidateSurface(surface)) continue;
    visibleSurfaceNo += 1;
    surfaceNumberMap.set(index, visibleSurfaceNo);
  }
  return surfaceNumberMap;
}

function buildRenderLensColorTargets(opticalSystemRows: any[]): RenderLensColorTarget[] {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length < 2) return [];
  const targets: RenderLensColorTarget[] = [];
  const visibleSurfaceNumberMap = buildRenderableSurfaceNumberMap(opticalSystemRows);
  let lensNo = 0;
  for (let i = 0; i < opticalSystemRows.length - 1; i++) {
    const front = opticalSystemRows[i];
    const back = opticalSystemRows[i + 1];
    if (!isLensInterval(front, back)) continue;
    lensNo += 1;
    const frontSurfaceNo = visibleSurfaceNumberMap.get(i) ?? (i + 1);
    const backSurfaceNo = visibleSurfaceNumberMap.get(i + 1) ?? (i + 2);
    targets.push({
      label: `Object ${lensNo} (S${frontSurfaceNo}-S${backSurfaceNo})`,
      key: surfaceColorKeyStable(front, i),
      keys: surfaceColorKeysAll(front, i),
      frontSurfaceIndex0: i,
    });
  }
  return targets;
}

function RenderUcsIcon() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const size = 128;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1.35, 1.35, 1.35, -1.35, 0.1, 10);
    camera.position.set(0, 0, 3.2);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size, false);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    host.replaceChildren(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);

    const createTextSprite = (text: string, color: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = 'bold 56px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 8;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeText(text, 64, 64);
      ctx.fillStyle = color;
      ctx.fillText(text, 64, 64);
      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(0.68, 0.68, 1);
      return sprite;
    };

    const makeAxis = (dir: THREE.Vector3, color: number, label: string, cssColor: string) => {
      const material = new THREE.MeshBasicMaterial({ color });
      const axis = new THREE.Group();
      const shaftLength = 0.72;
      const headLength = 0.26;
      const shaftRadius = 0.055;
      const headRadius = 0.14;

      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 16),
        material,
      );
      shaft.position.y = shaftLength / 2;

      const head = new THREE.Mesh(
        new THREE.ConeGeometry(headRadius, headLength, 20),
        material,
      );
      head.position.y = shaftLength + headLength / 2;

      axis.add(shaft, head);
      const sprite = createTextSprite(label, cssColor);
      if (sprite) {
        sprite.position.y = shaftLength + headLength + 0.16;
        axis.add(sprite);
      }
      axis.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      return axis;
    };

    group.add(
      makeAxis(new THREE.Vector3(1, 0, 0), 0xD32F2F, 'X', '#D32F2F'),
      makeAxis(new THREE.Vector3(0, 1, 0), 0x111111, 'Y', '#111111'),
      makeAxis(new THREE.Vector3(0, 0, 1), 0x16A34A, 'Z', '#16A34A'),
      new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 16), new THREE.MeshBasicMaterial({ color: 0x4B5563 })),
    );

    let rafId: number | null = null;
    const tick = () => {
      try {
        const w = window as any;
        const mainCamera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
        if (mainCamera?.quaternion) {
          if (typeof mainCamera.updateMatrixWorld === 'function') {
            mainCamera.updateMatrixWorld(true);
          }
          group.quaternion.copy(mainCamera.quaternion).invert();
        }
        renderer.render(scene, camera);
      } catch (_) {}
      try {
        rafId = requestAnimationFrame(tick);
      } catch (_) {
        rafId = null;
      }
    };

    tick();

    return () => {
      try { if (rafId !== null) cancelAnimationFrame(rafId); } catch (_) {}
      try { renderer.dispose(); } catch (_) {}
      try { host.replaceChildren(); } catch (_) {}
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 12,
        bottom: 12,
        width: 128,
        height: 128,
        pointerEvents: 'none',
        zIndex: 2,
        overflow: 'visible',
      }}
    >
      <div ref={hostRef} style={{ width: '100%', height: '100%', overflow: 'visible' }} />
    </div>
  );
}

// ---- Settings window page component ----
const FORCE_MODE_KEY = 'coopt.forceInfinitePupilMode';
const GLASS_MAP_MFR_KEY = 'coopt.glassMap.defaultManufacturers';
const DARK_MODE_KEY = 'coopt.darkMode';
const ALLOWED_MFR = ['SCHOTT', 'HOYA', 'HIKARI', 'OHARA', 'Sumita', 'CDGM', 'Special'] as const;

function sanitizeForceModeValue(v: any): 'stop' | 'entrance' | '' {
  const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
  return (s === 'stop' || s === 'entrance') ? s : '';
}

function readForceModeFromUrl(): 'stop' | 'entrance' | '' {
  try {
    return sanitizeForceModeValue(new URL(window.location.href).searchParams.get('coopt_force_mode'));
  } catch (_) { return ''; }
}

function applyForceModeToWindowGlobals(m: 'stop' | 'entrance' | ''): void {
  const w = window as any;
  try {
    if (typeof w.__cooptSetForceInfinitePupilMode === 'function') {
      w.__cooptSetForceInfinitePupilMode(m);
      return;
    }
  } catch (_) {}
  try {
    if (m) { w.__COOPT_FORCE_INFINITE_PUPIL_MODE = m; }
    else { try { delete w.__COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { w.__COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; } }
  } catch (_) {}
}

function readCurrentForceMode(): 'stop' | 'entrance' | '' {
  try {
    const w = window as any;
    const fromWindow = sanitizeForceModeValue(w.__COOPT_FORCE_INFINITE_PUPIL_MODE);
    if (fromWindow) return fromWindow;
  } catch (_) {}
  try {
    const fromStorage = sanitizeForceModeValue(localStorage.getItem(FORCE_MODE_KEY));
    if (fromStorage) return fromStorage;
  } catch (_) {}
  return readForceModeFromUrl();
}

function DesktopSettingsPage() {
  const [forceMode, setForceMode] = useState<'stop' | 'entrance' | ''>(readForceModeFromUrl);
  const [mfrs, setMfrs] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(GLASS_MAP_MFR_KEY) || '[]'); } catch (_) { return []; }
  });
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try { return localStorage.getItem(DARK_MODE_KEY) === 'true'; } catch (_) { return false; }
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    readDesktopSetting(FORCE_MODE_KEY).then((val) => {
      const m = sanitizeForceModeValue(val);
      if (m) { setForceMode(m); applyForceModeToWindowGlobals(m); }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const handleForceModeChange = async (val: 'stop' | 'entrance' | '') => {
    setForceMode(val);
    applyForceModeToWindowGlobals(val);
    try { if (val) localStorage.setItem(FORCE_MODE_KEY, val); else localStorage.removeItem(FORCE_MODE_KEY); } catch (_) {}
    await writeDesktopSetting(FORCE_MODE_KEY, val || null);
    try {
      const w = window as any;
      if (typeof w.__cooptBroadcastForceInfinitePupilMode === 'function') w.__cooptBroadcastForceInfinitePupilMode(val);
    } catch (_) {}
  };

  const handleMfrChange = (mfr: string, checked: boolean) => {
    const next = checked ? [...mfrs, mfr] : mfrs.filter(m => m !== mfr);
    setMfrs(next);
    try { if (next.length) localStorage.setItem(GLASS_MAP_MFR_KEY, JSON.stringify(next)); else localStorage.removeItem(GLASS_MAP_MFR_KEY); } catch (_) {}
  };

  const handleDarkModeChange = (enabled: boolean) => {
    setDarkMode(enabled);
    try { localStorage.setItem(DARK_MODE_KEY, enabled ? 'true' : 'false'); } catch (_) {}
    try { document.body.classList.toggle('dark-mode', enabled); } catch (_) {}
    const o = (window as any).opener;
    try { if (o && typeof o.__cooptSetDarkMode === 'function') o.__cooptSetDarkMode(enabled); } catch (_) {}
  };

  const mfrSet = new Set(mfrs.map(s => String(s).toUpperCase()));

  return (
    <div style={{ height: '100vh', width: '100vw', fontFamily: 'Arial, sans-serif', background: '#f4f4f4', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 12, background: '#fff', flex: '1 1 auto', overflow: 'auto' }}>
        <div style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px 0' }}>Glass Map: Default Manufacturers</div>
        <div style={{ fontSize: 12, color: '#666', lineHeight: 1.35, margin: '0 0 10px 0' }}>
          Choose which manufacturers are enabled by default when opening Glass Map.<br />
          If nothing is selected, Glass Map will show all manufacturers.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '8px 0 14px 0' }}>
          {ALLOWED_MFR.map(mfr => (
            <label key={mfr}>
              <input type="checkbox" checked={mfrSet.has(mfr.toUpperCase())} onChange={e => handleMfrChange(mfr, e.target.checked)} />{' '}{mfr}
            </label>
          ))}
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px 0' }}>Dark Mode</div>
        <div style={{ fontSize: 12, color: '#666', lineHeight: 1.35, margin: '0 0 10px 0' }}>Enable VS Code-style dark mode for the entire UI.</div>
        <label style={{ margin: '8px 0 14px 0', display: 'block' }}>
          <input type="checkbox" checked={darkMode} onChange={e => handleDarkModeChange(e.target.checked)} />{' '}Enable Dark Mode
        </label>

        <div style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px 0' }}>Infinite Field: Pupil Sampling Mode</div>
        <div style={{ fontSize: 12, color: '#666', lineHeight: 1.35, margin: '0 0 10px 0' }}>
          Fix the sampling mode used for infinite-field wavefront/PSF/MTF generation.<br />
          This sets <code>__COOPT_FORCE_INFINITE_PUPIL_MODE</code> to <code>stop</code> or <code>entrance</code>.
        </div>
        {!loaded && <div style={{ fontSize: 12, color: '#888' }}>Loading…</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '8px 0 12px 0' }}>
          {(['', 'stop', 'entrance'] as const).map(val => (
            <label key={val}>
              <input type="radio" name="force-mode" value={val} checked={forceMode === val} onChange={() => handleForceModeChange(val)} />
              {' '}{val === '' ? 'Auto (default)' : val === 'stop' ? <>Force <code>stop</code></> : <>Force <code>entrance</code></>}
            </label>
          ))}
        </div>
        <div style={{ fontSize: 12, color: '#666' }}>Note: Changes take effect on the next calculation.</div>
      </div>
    </div>
  );
}

export default function App() {
  const optimizeRowsSyncKey = 'coopt.optimizeRowsSync';
  const [renderWindowStatus, setRenderWindowStatus] = useState("Initializing...");
  const [renderViewAxis, setRenderViewAxis] = useState<'YZ' | 'XZ'>('YZ');
  const [renderViewMode, setRenderViewMode] = useState<'3D' | 'XZ' | 'YZ'>('3D');
  const [renderCompareScope, setRenderCompareScope] = useState<RenderCompareScope>('active');
  const [renderCompareOffsetDirection, setRenderCompareOffsetDirection] = useState<RenderCompareOffsetDirection>('centered');
  const [renderCompareOffsetStepMm, setRenderCompareOffsetStepMm] = useState(20);
  const [renderCompareAlignReference, setRenderCompareAlignReference] = useState<RenderCompareAlignReference>('object');
  const [renderRayCount, setRenderRayCount] = useState(5);
  const [renderSurfaceColorsCollapsed, setRenderSurfaceColorsCollapsed] = useState(true);
  const [renderLensColorTargets, setRenderLensColorTargets] = useState<RenderLensColorTarget[]>([]);
  const [renderColorUiRevision, setRenderColorUiRevision] = useState(0);
  const [renderScaleLabel, setRenderScaleLabel] = useState('Scale unavailable');
  const [renderScaleBarWidthPx, setRenderScaleBarWidthPx] = useState(RENDER_SCALE_BAR_TARGET_WIDTH_PX);
  const [renderZoomUiRevision, setRenderZoomUiRevision] = useState(0);
  const [workspaceFocus, setWorkspaceFocus] = useState<WorkspaceFocus>('configuration');
  const renderScaleRafRef = useRef<number | null>(null);
  const optimizeDisplaySleepBlockTokenRef = useRef<string | null>(null);
  const optimizeWakeLockRef = useRef<any>(null);
  const renderViewModeRef = useRef<'3D' | 'XZ' | 'YZ'>('3D');
  const renderViewAxisRef = useRef<'YZ' | 'XZ'>('YZ');
  const renderRayCountRef = useRef(5);
  const renderRayCountDebounceRef = useRef<number | null>(null);
  const renderRedrawInFlightRef = useRef(false);
  const renderDrawRequestSeqRef = useRef(0);
  const renderImageSemidiaWarningRef = useRef<RenderImageSemidiaWarning | null>(null);
  const renderLastTimingRef = useRef<{ mode: string; summary: string; stages: RenderTimingStage[]; blockPerf: Array<{ name: string; countDelta: number; totalMsDelta: number }> } | null>(null);
  const renderActiveRowsRef = useRef<any[] | null>(null);
  const renderActiveObjectRowsRef = useRef<any[] | null>(null);
  const renderPendingRowsRef = useRef<any[] | null>(null);
  const renderPendingObjectRowsRef = useRef<any[] | null>(null);
  const renderPendingSyncStampRef = useRef('');
  const renderNeedsVisibilityReplayRef = useRef(false);
  const renderLastCompletedSyncSignatureRef = useRef('');
  const renderScheduledRedrawRafRef = useRef<number | null>(null);
  const renderScheduledRedrawArgsRef = useRef<{
    modeOverride?: '3D' | 'XZ' | 'YZ';
    axisOverride?: 'YZ' | 'XZ';
    requestId?: number;
    redrawOptions?: RenderRedrawOptions;
  } | null>(null);
  const renderScheduledRedrawPromiseRef = useRef<{
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason?: any) => void;
  } | null>(null);
  const renderDeferredFullPassTimerRef = useRef<number | null>(null);
  const render3DPrevRowsRef = useRef<any[] | null>(null);
  const render3DPrevOriginsRef = useRef<any[] | null>(null);
  const [renderShowDesignIntentLabels, setRenderShowDesignIntentLabels] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RENDER_SHOW_LABELS_KEY) === 'true';
    } catch (_) {
      return false;
    }
  });
  const [renderShowPrincipalPointLabels, setRenderShowPrincipalPointLabels] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RENDER_SHOW_PRINCIPAL_POINTS_KEY) === 'true';
    } catch (_) {
      return false;
    }
  });
  const [renderShowSurfaceNumberLabels, setRenderShowSurfaceNumberLabels] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RENDER_SHOW_SURFACE_NUMBERS_KEY) === 'true';
    } catch (_) {
      return false;
    }
  });
  const [renderDesignIntentLiveSync, setRenderDesignIntentLiveSync] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(RENDER_DESIGN_INTENT_SYNC_KEY);
      return stored === null ? true : stored === 'true';
    } catch (_) {
      return true;
    }
  });
  const [astigChiefRayDefinition, setAstigChiefRayDefinition] = useState('stop-center');
  const [astigBeamPattern, setAstigBeamPattern] = useState<'cross' | 'grid' | 'annular'>('annular');
  const [astigRayCount, setAstigRayCount] = useState(30);
  const [astigRingCount, setAstigRingCount] = useState(32);
  const [astigStatus, setAstigStatus] = useState('');
  const [astigBusy, setAstigBusy] = useState(false);
  const [astigProgress, setAstigProgress] = useState(0);
  const [astigProgressText, setAstigProgressText] = useState('');
  const isRenderWindowMode = (() => {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('coopt_render_window') === '1';
    } catch (_) {
      return false;
    }
  })();
  const [renderViewportVisible, setRenderViewportVisible] = useState(false);
  const [renderStartupBreakdown, setRenderStartupBreakdown] = useState('');

  useEffect(() => {
    try {
      if (localStorage.getItem(RENDER_DESIGN_INTENT_SYNC_KEY) === null) {
        localStorage.setItem(RENDER_DESIGN_INTENT_SYNC_KEY, 'true');
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    renderViewModeRef.current = renderViewMode;
  }, [renderViewMode]);

  useEffect(() => {
    renderViewAxisRef.current = renderViewAxis;
  }, [renderViewAxis]);

  useEffect(() => {
    renderRayCountRef.current = renderRayCount;
  }, [renderRayCount]);

  const analysisWindowMode = (() => {
    try {
      const url = new URL(window.location.href);
      const enabled = url.searchParams.get('coopt_analysis_window') === '1';
      const analysis = String(url.searchParams.get('coopt_analysis') || '').trim();
      return { enabled, analysis };
    } catch (_) {
      return { enabled: false, analysis: '' };
    }
  })();
  const isOptimizeWindowMode = (() => {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('coopt_optimize_window') === '1';
    } catch (_) {
      return false;
    }
  })();
  const [optMethod, setOptMethod] = useState<'kkt' | 'lm' | 'cd'>('kkt');
  const [optMaxIterations, setOptMaxIterations] = useState(5000);
  const [optAutoRenderOnAccept, setOptAutoRenderOnAccept] = useState(false);
  const [optRunning, setOptRunning] = useState(false);
  const [optStopRequested, setOptStopRequested] = useState(false);
  const [, setSystemConfigVersion] = useState(0);
  const [optimizeState, setOptimizeState] = useState<any>({
    status: 'idle',
    phase: 'ready',
    modeUsed: 'kkt',
    iterations: 0,
    variableCount: 0,
    requirementCount: 0,
    meritBefore: NaN,
    meritAfter: NaN,
    requirementScoreBefore: NaN,
    requirementScoreAfter: NaN,
    requirementScoreTable: NaN,
    best: NaN,
    acceptCount: 0,
    rejectCount: 0,
    issue: '-',
    percent: 0,
    progressEvents: [],
  });

  const acquireOptimizeWakeLock = async (): Promise<boolean> => {
    try {
      if (isTauriRuntime()) return false;
      const nav = navigator as any;
      const wakeLock = nav?.wakeLock;
      if (!wakeLock || typeof wakeLock.request !== 'function') return false;
      const existing = optimizeWakeLockRef.current;
      if (existing && existing.released !== true) return true;
      const sentinel = await wakeLock.request('screen');
      optimizeWakeLockRef.current = sentinel;
      try {
        if (sentinel && typeof sentinel.addEventListener === 'function') {
          sentinel.addEventListener('release', () => {
            if (optimizeWakeLockRef.current === sentinel) {
              optimizeWakeLockRef.current = null;
            }
          });
        }
      } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  };

  const releaseOptimizeWakeLock = async (): Promise<void> => {
    const sentinel = optimizeWakeLockRef.current;
    optimizeWakeLockRef.current = null;
    if (!sentinel || typeof sentinel.release !== 'function') return;
    try {
      await sentinel.release();
    } catch (_) {}
  };

  useEffect(() => {
    return () => {
      const token = optimizeDisplaySleepBlockTokenRef.current;
      optimizeDisplaySleepBlockTokenRef.current = null;
      if (token) {
        void stopPreventDisplaySleep(token);
      }
      void releaseOptimizeWakeLock();
    };
  }, []);

  useEffect(() => {
    if (!optRunning || isTauriRuntime()) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void acquireOptimizeWakeLock();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [optRunning]);

  const countOptimizeFlags = (rows: any[]): number => {
    if (!Array.isArray(rows)) return 0;
    return rows.reduce((acc: number, row: any) => {
      if (!row || typeof row !== 'object') return acc;
      let c = 0;
      for (const k of Object.keys(row)) {
        if (!k.startsWith('optimize')) continue;
        const v = row[k];
        const t = String(v ?? '').trim().toLowerCase();
        if (v === true || v === 1 || t === 'v' || t === 'true' || t === '1') c += 1;
      }
      return acc + c;
    }, 0);
  };

  const getSystemConfigFromWindow = (targetWindow: any): any => {
    try {
      const runtimeConfig = targetWindow?.__cooptSystemConfig;
      const shouldPreferRuntime = !!targetWindow?.__cooptPreferRuntimeSystemConfig;
      const deferDerivedUntil = Number(targetWindow?.__cooptDeferDerivedUiUntil);
      const shouldUseDeferredRuntime = Number.isFinite(deferDerivedUntil) && deferDerivedUntil > Date.now();
      if (runtimeConfig && (shouldPreferRuntime || shouldUseDeferredRuntime)) {
        return JSON.parse(JSON.stringify(runtimeConfig));
      }
    } catch (_) {}
    try {
      if (targetWindow && typeof targetWindow.loadSystemConfigurationsFromTableConfig === 'function') {
        return targetWindow.loadSystemConfigurationsFromTableConfig();
      }
      if (targetWindow && typeof targetWindow.loadSystemConfigurations === 'function') {
        return targetWindow.loadSystemConfigurations();
      }
    } catch (_) {}
    return null;
  };

  function approxEqualNumber(left: any, right: any, epsilon = 1e-9): boolean {
    const l = Number(left);
    const r = Number(right);
    if (!Number.isFinite(l) && !Number.isFinite(r)) return true;
    if (!Number.isFinite(l) || !Number.isFinite(r)) return false;
    return Math.abs(l - r) <= epsilon;
  }

  function surfaceIdentityKey(surface: any, index0: number): string {
    const blockId = String(surface?._blockId ?? '').trim();
    const role = String(surface?._surfaceRole ?? '').trim();
    const id = String(surface?.id ?? '').trim();
    const surfType = String(surface?.surfType ?? surface?.type ?? '').trim();
    const objectType = String(surface?.['object type'] ?? '').trim();
    return [index0, blockId, role, id, surfType, objectType].join('|');
  }

  function rotationMatrixStable(left: any, right: any): boolean {
    const leftRows = Array.isArray(left) ? left : null;
    const rightRows = Array.isArray(right) ? right : null;
    if (!leftRows && !rightRows) return true;
    if (!leftRows || !rightRows || leftRows.length !== rightRows.length) return false;
    for (let rowIndex = 0; rowIndex < leftRows.length; rowIndex += 1) {
      const leftRow = Array.isArray(leftRows[rowIndex]) ? leftRows[rowIndex] : null;
      const rightRow = Array.isArray(rightRows[rowIndex]) ? rightRows[rowIndex] : null;
      if (!leftRow && !rightRow) continue;
      if (!leftRow || !rightRow || leftRow.length !== rightRow.length) return false;
      for (let colIndex = 0; colIndex < leftRow.length; colIndex += 1) {
        if (!approxEqualNumber(leftRow[colIndex], rightRow[colIndex])) return false;
      }
    }
    return true;
  }

  function getUserDataSurfaceIndex0(userData: any): number | null {
    const direct = Number(userData?.surfaceIndex0);
    if (Number.isInteger(direct) && direct >= 0) return direct;

    const raw = Number(userData?.surfaceIndex);
    if (!Number.isInteger(raw)) return null;
    if (userData?.type === 'surfaceProfile' || userData?.type === 'connectionLine') {
      return raw > 0 ? raw - 1 : raw;
    }
    return raw >= 0 ? raw : null;
  }

  function translateSceneObjectGeometry(object: any, dx: number, dy: number, dz: number): void {
    if (!object) return;
    if (object.geometry?.attributes?.position?.array) {
      const positions = object.geometry.attributes.position.array as ArrayLike<number> & { [index: number]: number };
      for (let index = 0; index < positions.length; index += 3) {
        positions[index] += dx;
        positions[index + 1] += dy;
        positions[index + 2] += dz;
      }
      object.geometry.attributes.position.needsUpdate = true;
      if (typeof object.geometry.computeBoundingSphere === 'function') object.geometry.computeBoundingSphere();
      if (typeof object.geometry.computeBoundingBox === 'function') object.geometry.computeBoundingBox();
      return;
    }
    if (object.position && typeof object.position.set === 'function') {
      object.position.set(
        Number(object.position.x || 0) + dx,
        Number(object.position.y || 0) + dy,
        Number(object.position.z || 0) + dz,
      );
    }
  }

  function canFastTranslate3DPreview(prevRows: any[], nextRows: any[], prevOrigins: any[], nextOrigins: any[], labelsEnabled: boolean): boolean {
    if (labelsEnabled) return false;
    if (!Array.isArray(prevRows) || !Array.isArray(nextRows) || !Array.isArray(prevOrigins) || !Array.isArray(nextOrigins)) return false;
    if (prevRows.length === 0 || prevRows.length !== nextRows.length || prevOrigins.length !== nextOrigins.length || prevRows.length !== prevOrigins.length) return false;

    for (let index = 0; index < prevRows.length; index += 1) {
      if (surfaceIdentityKey(prevRows[index], index) !== surfaceIdentityKey(nextRows[index], index)) return false;
      if (!rotationMatrixStable(prevOrigins[index]?.rotationMatrix, nextOrigins[index]?.rotationMatrix)) return false;
    }
    return true;
  }

  function tryFastTranslateRender3DPreview(
    scene: any,
    prevRows: any[],
    nextRows: any[],
    prevOrigins: any[],
    nextOrigins: any[],
    labelsEnabled: boolean,
  ): boolean {
    if (!scene || !canFastTranslate3DPreview(prevRows, nextRows, prevOrigins, nextOrigins, labelsEnabled)) return false;

    const surfaceDeltaByIndex = new Map<number, { dx: number; dy: number; dz: number }>();
    for (let index = 0; index < nextOrigins.length; index += 1) {
      const prevOrigin = prevOrigins[index]?.origin;
      const nextOrigin = nextOrigins[index]?.origin;
      const dx = Number(nextOrigin?.x || 0) - Number(prevOrigin?.x || 0);
      const dy = Number(nextOrigin?.y || 0) - Number(prevOrigin?.y || 0);
      const dz = Number(nextOrigin?.z || 0) - Number(prevOrigin?.z || 0);
      if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9 || Math.abs(dz) > 1e-9) {
        surfaceDeltaByIndex.set(index, { dx, dy, dz });
      }
    }

    if (surfaceDeltaByIndex.size === 0) return true;

    scene.traverse((child: any) => {
      const type = child?.userData?.type;
      if (type === 'optical-ray' || child?.userData?.isRayLine || child?.userData?.rayType === 'crossBeam') {
        return;
      }
      const surfaceIndex0 = getUserDataSurfaceIndex0(child?.userData);
      if (surfaceIndex0 === null) return;
      const delta = surfaceDeltaByIndex.get(surfaceIndex0);
      if (!delta) return;
      translateSceneObjectGeometry(child, delta.dx, delta.dy, delta.dz);
    });

    return true;
  }

  const getActiveConfigFromSystemConfig = (systemConfig: any): any => {
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) return null;
    const activeId = systemConfig.activeConfigId;
    return systemConfig.configurations.find((c: any) => c && String(c.id) === String(activeId))
      || systemConfig.configurations[0]
      || null;
  };

  const readOptimizeVariableCountFromWindow = (targetWindow: any): { count: number; hasConfig: boolean } => {
    try {
      const systemConfig = getSystemConfigFromWindow(targetWindow);
      const activeCfg = getActiveConfigFromSystemConfig(systemConfig);
      const hasConfig = !!(systemConfig && Array.isArray(systemConfig.configurations) && activeCfg);
      const allVars = listDesignVariablesFromBlocks(activeCfg || {});
      return {
        count: Array.isArray(allVars) ? allVars.length : 0,
        hasConfig,
      };
    } catch (_) {
      return { count: 0, hasConfig: false };
    }
  };

  const countBlockOptimizeVariables = (targetWindow: any): number => {
    try {
      const primary = readOptimizeVariableCountFromWindow(targetWindow);
      if (primary.hasConfig) return primary.count;

      const windowsToProbe: any[] = [];
      try {
        const opener = targetWindow?.opener;
        if (opener && !opener.closed) {
          windowsToProbe.push(opener);
        }
      } catch (_) {}
      if (typeof window !== 'undefined' && window && window !== targetWindow && !windowsToProbe.includes(window)) {
        windowsToProbe.push(window);
      }

      for (const win of windowsToProbe) {
        const next = readOptimizeVariableCountFromWindow(win);
        if (next.hasConfig) return next.count;
      }
      return 0;
    } catch (_) {
      return 0;
    }
  };

  const countOptimizeVariablesFromSystemConfig = (systemConfig: any): number => {
    try {
      const activeCfg = getActiveConfigFromSystemConfig(systemConfig);
      const allVars = listDesignVariablesFromBlocks(activeCfg || {});
      return Array.isArray(allVars) ? allVars.length : 0;
    } catch (_) {
      return 0;
    }
  };

  const getConfigRowsForRender = (targetWindow: any, cfg: any, systemConfig?: any): any[] => {
    if (!cfg || typeof cfg !== 'object') return [];
    try {
      const activeId = systemConfig?.activeConfigId;
      const isActive = activeId !== undefined && activeId !== null && String(cfg.id) === String(activeId);
      if (isActive && typeof targetWindow?.getOpticalSystemRows === 'function') {
        const tableRows = targetWindow.getOpticalSystemRows(targetWindow.tableOpticalSystem);
        if (Array.isArray(tableRows) && tableRows.length > 0) {
          return tableRows;
        }
      }
    } catch (_) {}

    try {
      if (Array.isArray(cfg.blocks) && cfg.blocks.length > 0 && typeof targetWindow?.expandBlocksToOpticalSystemRows === 'function') {
        const expanded = targetWindow.expandBlocksToOpticalSystemRows(cfg.blocks);
        if (expanded && Array.isArray(expanded.rows) && expanded.rows.length > 0) {
          return expanded.rows;
        }
      }
    } catch (_) {}

    return Array.isArray(cfg.opticalSystem) ? cfg.opticalSystem : [];
  };

  const getConfigObjectRowsForRender = (targetWindow: any, cfg: any, systemConfig?: any): any[] => {
    if (!cfg || typeof cfg !== 'object') return [];
    try {
      const activeId = systemConfig?.activeConfigId;
      const isActive = activeId !== undefined && activeId !== null && String(cfg.id) === String(activeId);
      if (isActive && typeof targetWindow?.getObjectRows === 'function') {
        const tableRows = targetWindow.getObjectRows(targetWindow.tableObject);
        if (Array.isArray(tableRows) && tableRows.length > 0) {
          return tableRows;
        }
      }
    } catch (_) {}

    return Array.isArray(cfg.object) ? cfg.object : [];
  };

  const getRenderCompareEntries = (targetWindow: any): RenderCompareEntry[] => {
    try {
      const systemConfig = getSystemConfigFromWindow(targetWindow);
      const configs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
      if (configs.length === 0) return [];
      const activeId = systemConfig?.activeConfigId;
      const mapped = configs.map((cfg: any) => ({
        configId: String(cfg?.id ?? ''),
        name: String(cfg?.name ?? cfg?.id ?? 'Config').trim() || 'Config',
        rows: getConfigRowsForRender(targetWindow, cfg, systemConfig),
        objectRows: getConfigObjectRowsForRender(targetWindow, cfg, systemConfig),
        isActive: activeId !== undefined && activeId !== null && String(cfg?.id) === String(activeId),
      })).filter((entry: RenderCompareEntry) => Array.isArray(entry.rows) && entry.rows.length > 0);
      if (mapped.length <= 1) return mapped;
      const activeEntry = mapped.find((entry) => entry.isActive) || mapped[0];
      const rest = mapped.filter((entry) => entry !== activeEntry);
      return [activeEntry, ...rest];
    } catch (_) {
      return [];
    }
  };

  const getRenderHostWindow = (): any => {
    try {
      const openerWindow = (window as any).opener;
      if (openerWindow && !openerWindow.closed) return openerWindow;
    } catch (_) {}
    return window as any;
  };

  const getOptimizeHostWindow = (): any => {
    const currentWindow = window as any;
    try {
      const cachedHostWindow = currentWindow.__cooptOptimizeHostWindow;
      if (cachedHostWindow && cachedHostWindow !== currentWindow && !cachedHostWindow.closed) {
        return cachedHostWindow;
      }
    } catch (_) {}
    try {
      const openerWindow = currentWindow.opener;
      if (openerWindow && !openerWindow.closed) {
        try {
          currentWindow.__cooptOptimizeHostWindow = openerWindow;
        } catch (_) {}
        return openerWindow;
      }
    } catch (_) {}
    return currentWindow;
  };

  const getOptimizeSyncTargetWindow = (): any => {
    if (isOptimizeWindowMode) {
      return getOptimizeHostWindow();
    }
    return window as any;
  };

  const normalizeRenderObjectRows = (targetWindow: any, objectRows: any[], opticalSystemRows: any[]): any[] => {
    if (!Array.isArray(objectRows) || objectRows.length === 0) return [];
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return objectRows;

    const objectSurface = opticalSystemRows[0] || {};
    const thicknessRaw = objectSurface?.thickness;
    const thicknessStr = String(thicknessRaw ?? '').trim().toUpperCase();
    const thicknessVal = Number(thicknessRaw);
    const conjugateType = (
      thicknessRaw === Infinity ||
      thicknessStr === 'INF' ||
      thicknessStr === 'INFINITY' ||
      thicknessStr === '∞' ||
      (Number.isFinite(thicknessVal) && Math.abs(thicknessVal) > 1e6)
    ) ? 'infinite' : 'finite';

    let primaryWavelength = 0.5876;
    try {
      if (typeof targetWindow?.getPrimaryWavelength === 'function') {
        const wl = Number(targetWindow.getPrimaryWavelength());
        if (Number.isFinite(wl) && wl > 0) primaryWavelength = wl;
      }
    } catch (_) {}

    return objectRows.map((row: any) => {
      const posNorm = String(row?.position ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
      const storedTarget = row?.__cooptImageHeightTarget;
      const hasStoredImageHeightTarget = storedTarget
        && Number.isFinite(Number(storedTarget.x))
        && Number.isFinite(Number(storedTarget.y));
      if (posNorm !== 'imageheight' && !hasStoredImageHeightTarget) return row;
      try {
        return preserveRenderImageHeightRow(row, Number(row?.objectIndex) || 0, opticalSystemRows, primaryWavelength, conjugateType);
      } catch (error) {
        console.warn('[RenderWindow] ImageHeight normalization failed; using raw object row.', error);
        return row;
      }
    });
  };

  const getRenderObjectRows = (targetWindow?: any, opticalSystemRowsOverride?: any[]): any[] => {
    const hostWindow = targetWindow || getRenderHostWindow();
    const preferConfigRows = Array.isArray(opticalSystemRowsOverride) && opticalSystemRowsOverride.length > 0;
    let objectRows: any[] = [];

    const finalizeObjectRows = (rows: any[]): any[] => {
      if (!Array.isArray(rows)) return [];
      if (preferConfigRows) {
        return normalizeRenderObjectRows(hostWindow, rows, opticalSystemRowsOverride);
      }
      return rows;
    };

    if (preferConfigRows) {
      try {
        const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        const overrideRows = g && Array.isArray(g.__cooptRenderObjectRowsOverride) && g.__cooptRenderObjectRowsOverride.length > 0
          ? g.__cooptRenderObjectRowsOverride
          : null;
        if (overrideRows) {
          objectRows = overrideRows;
        }
      } catch (_) {}

      try {
        if (objectRows.length === 0) {
          const systemConfig = getSystemConfigFromWindow(hostWindow);
          const activeCfg = getActiveConfigFromSystemConfig(systemConfig);
          if (Array.isArray(activeCfg?.object) && activeCfg.object.length > 0) {
            objectRows = activeCfg.object;
          }
        }
      } catch (_) {}
    }

    try {
      if (objectRows.length === 0) {
        const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        const overrideRows = g && Array.isArray(g.__cooptRenderObjectRowsOverride) && g.__cooptRenderObjectRowsOverride.length > 0
          ? g.__cooptRenderObjectRowsOverride
          : null;
        if (overrideRows) {
          objectRows = overrideRows;
        }
      }
    } catch (_) {}

    try {
      if (objectRows.length === 0 && typeof hostWindow?.getObjectRows === 'function') {
        const rows = hostWindow.getObjectRows(hostWindow.tableObject);
        if (Array.isArray(rows) && rows.length > 0) objectRows = rows;
      }
    } catch (_) {}

    try {
      if (objectRows.length === 0) {
        const systemConfig = getSystemConfigFromWindow(hostWindow);
        const activeCfg = getActiveConfigFromSystemConfig(systemConfig);
        if (Array.isArray(activeCfg?.object) && activeCfg.object.length > 0) objectRows = activeCfg.object;
      }
    } catch (_) {}
    try {
      if (objectRows.length === 0 && typeof window?.getObjectRows === 'function') {
        const rows = window.getObjectRows((window as any).tableObject);
        if (Array.isArray(rows) && rows.length > 0) objectRows = rows;
      }
    } catch (_) {}
    return finalizeObjectRows(objectRows);
  };

  const parseZoomLawGroupNames = (rawValue: any): string[] => {
    const raw = String(rawValue ?? '').trim();
    if (!raw) return [];
    const groupNames: string[] = [];
    for (const line of raw.split(/\r?\n|;/)) {
      const trimmed = String(line ?? '').trim();
      if (!trimmed) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex <= 0) continue;
      const name = String(trimmed.slice(0, eqIndex)).trim();
      if (/^(?:const\s+|\$)[A-Za-z_][A-Za-z0-9_]*$/i.test(name)) continue;
      if (name && !groupNames.includes(name)) groupNames.push(name);
    }
    return groupNames;
  };

  const getRenderZoomUiState = (): RenderZoomUiState => {
    try {
      const hostWindow = getRenderHostWindow();
      const systemConfig = getSystemConfigFromWindow(hostWindow);
      const activeCfg = getActiveConfigFromSystemConfig(systemConfig);
      const blocks = Array.isArray(activeCfg?.blocks) ? activeCfg.blocks : [];
      if (blocks.length === 0) {
        return { available: false, blockId: '', zoomPosition: 0, groupNames: [], lawGroups: [], configName: '' };
      }

      const controller = blocks.find((block: any) => {
        const blockType = String(block?.blockType ?? '').trim();
        return blockType === 'ObjectSurface' || blockType === 'ObjectPlane';
      });
      if (!controller) {
        return { available: false, blockId: '', zoomPosition: 0, groupNames: [], lawGroups: [], configName: String(activeCfg?.name ?? '').trim() };
      }

      const params = (controller.parameters && typeof controller.parameters === 'object') ? controller.parameters : {};
      const rawZoomPosition = Number(params.zoomPosition);
      const zoomPosition = Number.isFinite(rawZoomPosition) ? Math.max(0, Math.min(1, rawZoomPosition)) : 0;
      const lawGroups = parseZoomLawGroupNames(params.zoomGroupProfiles);
      const groupNames: string[] = [];
      for (const block of blocks) {
        const blockType = String(block?.blockType ?? '').trim();
        if (!blockType || blockType === 'Gap' || blockType === 'AirGap' || blockType === 'ImageSurface' || blockType === 'ObjectSurface' || blockType === 'ObjectPlane') {
          continue;
        }
        const blockParams = (block?.parameters && typeof block.parameters === 'object') ? block.parameters : {};
        const groupName = String(blockParams.zoomGroup ?? '').trim();
        if (groupName && !groupNames.includes(groupName)) groupNames.push(groupName);
      }

      return {
        available: true,
        blockId: String(controller.blockId ?? '').trim(),
        zoomPosition,
        groupNames,
        lawGroups,
        configName: String(activeCfg?.name ?? '').trim(),
      };
    } catch (_) {
      return { available: false, blockId: '', zoomPosition: 0, groupNames: [], lawGroups: [], configName: '' };
    }
  };

  const applyRenderZoomPosition = async (nextZoomPosition: number): Promise<boolean> => {
    const safeZoomPosition = Math.max(0, Math.min(1, Number(nextZoomPosition) || 0));
    try {
      const hostWindow = getRenderHostWindow();
      const systemConfig = getSystemConfigFromWindow(hostWindow);
      const activeCfg = getActiveConfigFromSystemConfig(systemConfig);
      const blocks = Array.isArray(activeCfg?.blocks) ? activeCfg.blocks : [];
      if (!activeCfg || blocks.length === 0) return false;

      const controller = blocks.find((block: any) => {
        const blockType = String(block?.blockType ?? '').trim();
        return blockType === 'ObjectSurface' || blockType === 'ObjectPlane';
      });
      if (!controller) return false;

      if (!controller.parameters || typeof controller.parameters !== 'object') controller.parameters = {};
      controller.parameters.zoomPosition = safeZoomPosition;
      if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
      activeCfg.metadata.modified = new Date().toISOString();

      let renderRows: any[] = [];
      try {
        const expander = hostWindow?.expandBlocksToOpticalSystemRows || (window as any)?.expandBlocksToOpticalSystemRows;
        if (Array.isArray(activeCfg.blocks) && activeCfg.blocks.length > 0 && typeof expander === 'function') {
          const expanded = expander(activeCfg.blocks);
          if (expanded && Array.isArray(expanded.rows) && expanded.rows.length > 0) {
            renderRows = expanded.rows;
            activeCfg.opticalSystem = expanded.rows;
          }
        }
      } catch (_) {}
      if (renderRows.length === 0 && Array.isArray(activeCfg.opticalSystem) && activeCfg.opticalSystem.length > 0) {
        renderRows = activeCfg.opticalSystem;
      }

      if (typeof hostWindow.saveSystemConfigurationsFromTableConfig === 'function') {
        hostWindow.saveSystemConfigurationsFromTableConfig(systemConfig);
      } else if (typeof hostWindow.saveSystemConfigurations === 'function') {
        hostWindow.saveSystemConfigurations(systemConfig);
      }

      if (typeof hostWindow.loadActiveConfigurationToTables === 'function') {
        await Promise.resolve(hostWindow.loadActiveConfigurationToTables({ applyToUI: true }));
      }
      try { requestRefreshBlockInspector(hostWindow); } catch (_) {}
      try {
        hostWindow.dispatchEvent(new CustomEvent('coopt:system-configurations-updated'));
      } catch (_) {}

      if (hostWindow !== window) {
        try {
          if (typeof (window as any).loadActiveConfigurationToTables === 'function') {
            await Promise.resolve((window as any).loadActiveConfigurationToTables({ applyToUI: true }));
          }
        } catch (_) {}
      }

      if (renderRows.length > 0) {
        try {
          const renderWindow = window as any;
          if (typeof renderWindow.__cooptRenderWindowRedraw === 'function') {
            await Promise.resolve(renderWindow.__cooptRenderWindowRedraw(renderRows));
            return true;
          }
        } catch (_) {}
      }

      await redrawCurrentRenderView();
      return true;
    } catch (err) {
      console.error('[RenderWindow] Failed to apply zoom position:', err);
      return false;
    }
  };

  const collectCrossSectionCameraBoundsOverride = (sceneForDraw: any, axis: 'XZ' | 'YZ') => {
    const verticalIndex = axis === 'XZ' ? 0 : 1;
    const bounds = { minY: Infinity, maxY: -Infinity };
    try {
      if (sceneForDraw) {
        sceneForDraw.traverse((child: any) => {
          if (child?.userData?.rayType === 'crossBeam' && child.geometry) {
            const positions = child.geometry.attributes?.position;
            const posArray = positions?.array as ArrayLike<number> | undefined;
            if (posArray && typeof posArray.length === 'number' && posArray.length >= verticalIndex + 1) {
              for (let i = verticalIndex; i < posArray.length; i += 3) {
                const coord = posArray[i];
                if (Number.isFinite(coord)) {
                  bounds.minY = Math.min(bounds.minY, coord);
                  bounds.maxY = Math.max(bounds.maxY, coord);
                }
              }
            }
          }
        });
      }
    } catch (_) {}

    return (Number.isFinite(bounds.minY) && Number.isFinite(bounds.maxY))
      ? bounds
      : null;
  };

  const isRenderWindowOpticalArtifact = (child: any): boolean => {
    const userData = child?.userData || {};
    const type = String(userData?.type ?? '');
    if (type === 'popupLensFill' && userData?.isUltraDebugOverlay === true) return false;
    return !!(
      type === 'lensSurface' ||
      type === 'semidiaRing' ||
      type === 'ring' ||
      type === 'apertureRect' ||
      type === 'connectionCornerRing' ||
      type === 'thinLensArrow' ||
      type === 'plane-crosshair' ||
      type === 'surface-origin-marker' ||
      type === 'design-intent-label' ||
      type === 'design-intent-label-line' ||
      type === 'surfaceProfile' ||
      type === 'connectionLine' ||
      type === 'renderWindowDirectFill' ||
      type === 'popupLensFill' ||
      type === 'optical-ray' ||
      type === 'ray' ||
      type === 'crossSection' ||
      userData?.isLensSurface === true ||
      userData?.isOpticalElement === true ||
      userData?.isRayLine === true ||
      userData?.surfaceType === '3DSurface' ||
      userData?.rayType === 'crossBeam'
    );
  };

  const removeRenderWindowObjects = (sceneForDraw: any, objects: any[]): void => {
    if (!sceneForDraw || !Array.isArray(objects) || objects.length === 0) return;
    [...new Set(objects)].forEach((obj: any) => {
      try { sceneForDraw.remove(obj); } catch (_) {}
      try { if (obj.geometry) obj.geometry.dispose(); } catch (_) {}
      try {
        if (obj.material) {
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          materials.forEach((material: any) => {
            try { if (material?.map && typeof material.map.dispose === 'function') material.map.dispose(); } catch (_) {}
            try { if (typeof material?.dispose === 'function') material.dispose(); } catch (_) {}
          });
        }
      } catch (_) {}
    });
  };

  const buildRenderCompareOffsets = (count: number): number[] => {
    const step = Math.max(0, Number(renderCompareOffsetStepMm) || 0);
    if (count <= 0 || step <= 0) return Array.from({ length: Math.max(0, count) }, () => 0);
    if (renderCompareOffsetDirection === 'positive') {
      return Array.from({ length: count }, (_, index) => index * step);
    }
    if (renderCompareOffsetDirection === 'negative') {
      return Array.from({ length: count }, (_, index) => -index * step);
    }
    return Array.from({ length: count }, (_, index) => {
      if (index === 0) return 0;
      const ring = Math.ceil(index / 2);
      return (index % 2 === 1 ? 1 : -1) * ring * step;
    });
  };

  const applyRenderCompareOffset = (group: THREE.Group, axis: 'YZ' | 'XZ', offsetMm: number): void => {
    group.position.set(0, 0, 0);
    if (!Number.isFinite(offsetMm) || Math.abs(offsetMm) < 1e-9) return;
    if (axis === 'YZ') {
      group.position.y = offsetMm;
      return;
    }
    group.position.x = offsetMm;
  };

  const findImageSurfaceIndexForRenderCompare = (rows: any[]): number => {
    if (!Array.isArray(rows) || rows.length === 0) return -1;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      const objectType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
      const surfaceType = String(row?.surfType ?? row?.surfaceType ?? row?.type ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
      const blockType = String(row?._blockType ?? row?.blockType ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
      if (objectType === 'image' || objectType === 'imagesurface' || surfaceType === 'imagesurface' || blockType === 'imagesurface') {
        return index;
      }
    }
    return rows.length - 1;
  };

  const resolveRenderCompareImageZ = (rows: any[]): number | null => {
    try {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const imageSurfaceIndex = findImageSurfaceIndexForRenderCompare(rows);
      if (imageSurfaceIndex < 0) return null;
      const origins = calculateSurfaceOrigins(rows);
      const z = Number(origins?.[imageSurfaceIndex]?.origin?.z);
      return Number.isFinite(z) ? z : null;
    } catch (_) {
      return null;
    }
  };

  const resolveRenderCompareReferenceZ = (entries: RenderCompareEntry[]): number | null => {
    if (renderCompareAlignReference !== 'image') return null;
    const activeEntry = entries.find((entry) => entry.isActive) || entries[0] || null;
    if (!activeEntry) return null;
    return resolveRenderCompareImageZ(activeEntry.rows);
  };

  const applyRenderCompareTransform = (group: THREE.Group, axis: 'YZ' | 'XZ', offsetMm: number, imageAlignZOffsetMm = 0): void => {
    applyRenderCompareOffset(group, axis, offsetMm);
    if (Number.isFinite(imageAlignZOffsetMm) && Math.abs(imageAlignZOffsetMm) >= 1e-9) {
      group.position.z += imageAlignZOffsetMm;
    }
  };

  useEffect(() => {
    const refreshStatusBar = () => {
      setSystemConfigVersion((version) => version + 1);
    };

    window.addEventListener('coopt:system-configurations-updated', refreshStatusBar);
    return () => {
      window.removeEventListener('coopt:system-configurations-updated', refreshStatusBar);
    };
  }, []);

  useEffect(() => {
    const optimizeStatus = String(optimizeState?.status || 'idle').toLowerCase();
    // Keep host score synchronization active whenever the optimize window is open
    // and the optimizer is not currently running. If this is limited to `idle`, the
    // listener is torn down after a run finishes with `done` / `stopped`, and score
    // changes in the host are only picked up after reopening the window.
    if (!isOptimizeWindowMode || optRunning) return;
    let cancelled = false;
    let retryTimer: any = null;

    const refreshPreRunScore = async (triggerEval = true): Promise<boolean> => {
      try {
        const w = window as any;
        const hostWin = getOptimizeHostWindow();
        const sre = hostWin.systemRequirementsEditor || w.systemRequirementsEditor;
        if (triggerEval && sre && typeof sre.evaluateAndUpdateNow === 'function') {
          const p = sre.evaluateAndUpdateNow({ reason: 'optimize-window-prerun', forceSilent: true, silent: true });
          if (p && typeof p.then === 'function') await p;
        }

        const cfg = getSystemConfigFromWindow(hostWin) || getSystemConfigFromWindow(w) || null;
        const activeConfigId = (cfg && cfg.activeConfigId !== undefined && cfg.activeConfigId !== null)
          ? String(cfg.activeConfigId).trim()
          : '';

        const rows = (() => {
          try {
            if (sre && typeof sre.getData === 'function') {
              const d = sre.getData();
              if (Array.isArray(d)) return d;
            }
          } catch (_) {}
          try {
            if (Array.isArray(cfg?.systemRequirements)) {
              return cfg.systemRequirements;
            }
          } catch (_) {}
          return [];
        })();

        const opticalRows = await (async () => {
          try {
            if (typeof hostWin.getOpticalSystemRows === 'function') {
              const d0 = hostWin.getOpticalSystemRows(hostWin.tableOpticalSystem);
              if (Array.isArray(d0) && d0.length > 0) return d0;
            }
            if (typeof w.getOpticalSystemRows === 'function') {
              const d0 = w.getOpticalSystemRows(w.tableOpticalSystem);
              if (Array.isArray(d0) && d0.length > 0) return d0;
            }
            const table = hostWin.tableOpticalSystem || w.tableOpticalSystem;
            if (table && typeof table.getData === 'function') {
              const d = await table.getData();
              if (Array.isArray(d)) return d;
            }
          } catch (_) {}
          try {
            const activeId = cfg?.activeConfigId;
            const activeCfg = Array.isArray(cfg?.configurations)
              ? (cfg.configurations.find((c: any) => c && String(c.id) === String(activeId)) || cfg.configurations[0])
              : null;
            if (Array.isArray(activeCfg?.opticalSystem) && activeCfg.opticalSystem.length > 0) {
              return activeCfg.opticalSystem;
            }
            if (activeCfg && Array.isArray(activeCfg.blocks) && activeCfg.blocks.length > 0 && typeof (hostWin.expandBlocksToOpticalSystemRows || w.expandBlocksToOpticalSystemRows) === 'function') {
              const expander = hostWin.expandBlocksToOpticalSystemRows || w.expandBlocksToOpticalSystemRows;
              const expanded = expander(activeCfg.blocks);
              if (expanded && Array.isArray(expanded.rows) && expanded.rows.length > 0) {
                return expanded.rows;
              }
            }
          } catch (_) {}
          return [];
        })();

        const parseLocalRows = (key: string) => {
          try {
            const raw = localStorage.getItem(key);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
          } catch (_) {
            return [];
          }
        };

        const sourceRows = (() => {
          try {
            const table = hostWin.tableSource || w.tableSource;
            if (table && typeof table.getData === 'function') {
              const d = table.getData();
              if (Array.isArray(d) && d.length > 0) return d;
            }
          } catch (_) {}
          try {
            if (Array.isArray(cfg?.source) && cfg.source.length > 0) {
              return cfg.source;
            }
          } catch (_) {}
          const v = parseLocalRows('tableData_source');
          return Array.isArray(v) ? v : [];
        })();

        const objectRows = (() => {
          try {
            const table = hostWin.tableObject || w.tableObject;
            if (table && typeof table.getData === 'function') {
              const d = table.getData();
              if (Array.isArray(d) && d.length > 0) return d;
            }
          } catch (_) {}
          try {
            const activeId = cfg?.activeConfigId;
            const activeCfg = Array.isArray(cfg?.configurations)
              ? (cfg.configurations.find((c: any) => c && String(c.id) === String(activeId)) || cfg.configurations[0])
              : null;
            if (Array.isArray(activeCfg?.object) && activeCfg.object.length > 0) {
              return activeCfg.object;
            }
          } catch (_) {}
          const v = parseLocalRows('tableData_object');
          return Array.isArray(v) ? v : [];
        })();

        const normalizeConfigId = (row: any): string => {
          try {
            if (sre && typeof sre._normalizeConfigId === 'function') {
              return String(sre._normalizeConfigId(row?.configId, cfg, activeConfigId) || '').trim();
            }
          } catch (_) {}
          const rawCfg = String(row?.configId ?? '').trim();
          return rawCfg || activeConfigId;
        };

        const enabledRows = Array.isArray(rows)
          ? rows.filter((row: any) => {
            const enabled = (row?.enabled === undefined || row?.enabled === null) ? true : !!row.enabled;
            const operand = String(row?.operand ?? '').trim();
            const weight = Number(row?.weight ?? 1);
            return enabled && !!operand && Number.isFinite(weight) && weight > 0;
          })
          : [];

        const activeRows = Array.isArray(enabledRows)
          ? enabledRows
          : [];

        let tableScore = Number.NaN;
        {
          let sum = 0;
          let cnt = 0;
          for (const row of activeRows) {
            const c = Number.isFinite(Number(row?._contribution))
              ? Number(row?._contribution)
              : Number(row?.score);
            if (Number.isFinite(c)) {
              if (c > 0) sum += c;
              cnt += 1;
            }
          }
          if (cnt > 0 && Number.isFinite(sum)) tableScore = sum;
        }

        // Use TS-side table score (same evaluation as "Update Requirement").
        let safeScore = Number.isFinite(tableScore) ? tableScore : Number.NaN;
        let variableCount = 0;
        if (!Number.isFinite(safeScore)) {
          let score = 0;
          let finiteCount = 0;
          for (const row of activeRows) {
            const c = Number.isFinite(Number(row?._contribution))
              ? Number(row?._contribution)
              : Number(row?.score);
            if (Number.isFinite(c)) {
              if (c > 0) score += c;
              finiteCount += 1;
            }
          }
          if (finiteCount > 0 && Number.isFinite(score)) safeScore = score;
        }
        variableCount = countBlockOptimizeVariables(hostWin);

        if (!cancelled) {
          setOptimizeState((prev: any) => ({
            ...prev,
            requirementCount: activeRows.length,
            variableCount: Number.isFinite(variableCount) ? variableCount : prev.variableCount,
            requirementScoreBefore: safeScore,
            meritBefore: safeScore,
            requirementScoreAfter: optimizeStatus === 'idle'
              ? safeScore
              : prev.requirementScoreAfter,
            requirementScoreTable: optimizeStatus === 'idle'
              ? tableScore
              : prev.requirementScoreTable,
            meritAfter: optimizeStatus === 'idle'
              ? safeScore
              : prev.meritAfter,
            best: optimizeStatus === 'idle'
              ? (Number.isFinite(safeScore) ? safeScore : prev.best)
              : prev.best,
          }));
        }
        return Number.isFinite(safeScore) || Number.isFinite(tableScore);
      } catch (_) {
        return false;
      }
    };

    let attempts = 0;
    const maxAttempts = 50;
    const runWithRetry = async () => {
      if (cancelled || optRunning) return;
      const ok = await refreshPreRunScore(true);
      attempts += 1;
      if (!ok && attempts < maxAttempts && !cancelled && !optRunning) {
        retryTimer = setTimeout(() => {
          void runWithRetry();
        }, 200);
      }
    };

    void runWithRetry();

    const w = window as any;
    const hostWin = getOptimizeHostWindow();
    let refreshScheduledTimer: any = null;
    let refreshInFlight = false;
    let refreshPending = false;
    const scheduleHostScoreRefresh = (reason: string, triggerEval = true, delayMs = 120) => {
      if (cancelled || optRunning) return;
      if (refreshScheduledTimer) {
        clearTimeout(refreshScheduledTimer);
        refreshScheduledTimer = null;
      }
      refreshScheduledTimer = setTimeout(() => {
        refreshScheduledTimer = null;
        if (cancelled || optRunning || refreshInFlight) {
          refreshPending = true;
          return;
        }
        refreshInFlight = true;
        void refreshPreRunScore(triggerEval)
          .catch(() => false)
          .finally(() => {
            refreshInFlight = false;
            if (refreshPending && !cancelled && !optRunning) {
              refreshPending = false;
              scheduleHostScoreRefresh(`${reason}:pending`, triggerEval, 0);
            }
          });
      }, delayMs);
    };

    let lastObservedRequirementEvalAt = 0;
    try {
      const state = hostWin?.__cooptLastRequirementsEval;
      const at = Number(state?.at ?? 0);
      const stage = String(state?.stage ?? '').trim().toLowerCase();
      if (Number.isFinite(at) && at > 0 && stage === 'done') {
        lastObservedRequirementEvalAt = at;
      }
    } catch (_) {}

    const requirementEvalPollTimer = window.setInterval(() => {
      if (cancelled || optRunning) return;
      try {
        const state = hostWin?.__cooptLastRequirementsEval;
        const at = Number(state?.at ?? 0);
        const stage = String(state?.stage ?? '').trim().toLowerCase();
        if (!Number.isFinite(at) || at <= lastObservedRequirementEvalAt || stage !== 'done') return;
        lastObservedRequirementEvalAt = at;
        scheduleHostScoreRefresh('host-requirement-eval-done', false, 0);
      } catch (_) {}
    }, 250);

    const forceRefreshPollTimer = window.setInterval(() => {
      if (cancelled || optRunning) return;
      scheduleHostScoreRefresh('host-periodic-refresh', true, 0);
    }, 1500);

    const onHostRequirementsUpdated = () => {
      scheduleHostScoreRefresh('host-requirements-updated', true, 0);
    };
    const onHostSystemConfigurationsUpdated = () => {
      scheduleHostScoreRefresh('host-system-configurations-updated', true, 0);
    };
    try { hostWin?.addEventListener?.('coopt:requirements-updated', onHostRequirementsUpdated); } catch (_) {}
    try { hostWin?.addEventListener?.('coopt:system-configurations-updated', onHostSystemConfigurationsUpdated); } catch (_) {}

    // Listen for requirement score changes pushed by the main window while this popup is idle
    const onRequirementScoreSync = (e: StorageEvent) => {
      if (e.key !== 'coopt.requirementScoreSync' || !e.newValue) return;
      if (cancelled) return;
      try {
        const payload = JSON.parse(e.newValue);
        const score = Number(payload?.score);
        if (!Number.isFinite(score)) return;
        setOptimizeState((prev: any) => ({
          ...prev,
          requirementScoreBefore: score,
          meritBefore: score,
          requirementScoreAfter: optimizeStatus === 'idle'
            ? score
            : prev.requirementScoreAfter,
          requirementScoreTable: optimizeStatus === 'idle'
            ? score
            : prev.requirementScoreTable,
          meritAfter: optimizeStatus === 'idle'
            ? score
            : prev.meritAfter,
          best: optimizeStatus === 'idle'
            ? (Number.isFinite(score) ? score : prev.best)
            : prev.best,
        }));
      } catch (_) {}
    };
    window.addEventListener('storage', onRequirementScoreSync);

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (refreshScheduledTimer) {
        clearTimeout(refreshScheduledTimer);
        refreshScheduledTimer = null;
      }
      try { window.clearInterval(requirementEvalPollTimer); } catch (_) {}
      try { window.clearInterval(forceRefreshPollTimer); } catch (_) {}
      try { hostWin?.removeEventListener?.('coopt:requirements-updated', onHostRequirementsUpdated); } catch (_) {}
      try { hostWin?.removeEventListener?.('coopt:system-configurations-updated', onHostSystemConfigurationsUpdated); } catch (_) {}
      window.removeEventListener('storage', onRequirementScoreSync);
    };
  }, [isOptimizeWindowMode, optRunning, optMethod, optimizeState?.status]);


  useEffect(() => {
    if (isOptimizeWindowMode || analysisWindowMode.enabled || isSettingsWindowMode) return;

    let lastReqEvalAt = 0;
    const REQUIREMENT_EVAL_SYNC_INTERVAL_MS = 250;

    const requestRequirementReeval = async (reason: string, force = false) => {
      const now = Date.now();
      if (!force && (now - lastReqEvalAt) < REQUIREMENT_EVAL_SYNC_INTERVAL_MS) return;
      lastReqEvalAt = now;
      try {
        const w = window as any;
        const reqEditor = w.systemRequirementsEditor;
        if (reqEditor && typeof reqEditor.flushPendingEdits === 'function') {
          const flushPromise = reqEditor.flushPendingEdits();
          if (flushPromise && typeof flushPromise.then === 'function') await flushPromise;
        }
        if (reqEditor && typeof reqEditor.evaluateAndUpdateNow === 'function') {
          const p = reqEditor.evaluateAndUpdateNow({ reason, forceSilent: true, silent: true });
          if (p && typeof p.then === 'function') await p;
        }
      } catch (_) {}
      // Broadcast updated score to optimize popup (if open and idle)
      try {
        const score = readRequirementTableScoreFromHost();
        if (Number.isFinite(score)) {
          localStorage.setItem('coopt.requirementScoreSync', JSON.stringify({ ts: Date.now(), score }));
        }
      } catch (_) {}
    };

    const waitRequirementEvalDone = async (startedAt: number, timeoutMs = 2000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const s = (window as any).__cooptLastRequirementsEval;
          const at = Number(s?.at ?? 0);
          const stage = String(s?.stage ?? '').trim().toLowerCase();
          if (at > startedAt && stage === 'done') return;
        } catch (_) {}
        if (Date.now() >= deadline) return;
        await new Promise((r) => setTimeout(r, 30));
      }
    };

    const readRequirementTableScoreFromHost = (): number => {
      try {
        const w = getOptimizeSyncTargetWindow();
        const sre = w.systemRequirementsEditor;
        if (!sre || typeof sre.getData !== 'function') return Number.NaN;
        const rr = sre.getData();
        if (!Array.isArray(rr) || rr.length === 0) return Number.NaN;

        const cfg = getSystemConfigFromWindow(w);

        const activeConfigId = (cfg && cfg.activeConfigId !== undefined && cfg.activeConfigId !== null)
          ? String(cfg.activeConfigId).trim()
          : '';

        const normalizeConfigId = (row: any): string => {
          try {
            if (typeof sre._normalizeConfigId === 'function') {
              return String(sre._normalizeConfigId(row?.configId, cfg, activeConfigId) || '').trim();
            }
          } catch (_) {}
          const rawCfg = String(row?.configId ?? '').trim();
          return rawCfg || activeConfigId;
        };

        let sum = 0;
        let cnt = 0;
        for (const row of rr) {
          const enabled = (row?.enabled === undefined || row?.enabled === null) ? true : !!row.enabled;
          const operand = String(row?.operand ?? '').trim();
          const weight = Number(row?.weight ?? 1);
          if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) continue;
          const c = Number.isFinite(Number(row?._contribution))
            ? Number(row?._contribution)
            : Number(row?.score);
          if (Number.isFinite(c)) {
            if (c > 0) sum += c;
            cnt += 1;
          }
        }

        return (cnt > 0 && Number.isFinite(sum)) ? sum : Number.NaN;
      } catch (_) {
        return Number.NaN;
      }
    };

    const parseMaybeNumber = (v: any): any => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : v;
      const s = String(v ?? '').trim();
      if (!s) return '';
      if (/^[-+]?((\d+\.\d*)|(\d*\.\d+)|(\d+))(e[-+]?\d+)?$/i.test(s)) return Number(s);
      return v;
    };

    const setParam = (block: any, key: string, value: any) => {
      if (!block || typeof block !== 'object' || !key) return;
      if (!block.parameters || typeof block.parameters !== 'object') block.parameters = {};
      block.parameters[key] = parseMaybeNumber(value);
    };

    const setParamAndLegacyVar = (block: any, key: string, value: any) => {
      setParam(block, key, value);
      if (!block || typeof block !== 'object' || !block.variables || typeof block.variables !== 'object') return;
      const entry = block.variables[key];
      if (!entry || typeof entry !== 'object') return;
      if (Object.prototype.hasOwnProperty.call(entry, 'value')) {
        entry.value = parseMaybeNumber(value);
      }
    };

    const shouldMarkV = (entry: any) => {
      const mode = String(entry?.optimize?.mode ?? '').trim().toUpperCase();
      return mode === 'V' || mode === 'TRUE';
    };

    const sanitizeExclusiveGlassVarFamily = (block: any, suffix = '') => {
      if (!block || typeof block !== 'object' || !block.variables || typeof block.variables !== 'object') return;
      const materialKey = `material${suffix}`;
      const familyKeys = [materialKey, `rindex${suffix}`, `abbe${suffix}`, `vd${suffix}`, `nd${suffix}`];
      const enabledKeys = familyKeys.filter((key) => shouldMarkV(block.variables?.[key]));
      if (enabledKeys.length <= 1) return;

      const keepKey = enabledKeys.includes(materialKey) ? materialKey : enabledKeys[0];
      for (const key of familyKeys) {
        if (key === keepKey) continue;
        const entry = block.variables?.[key];
        if (!entry || typeof entry !== 'object') continue;
        if (!entry.optimize || typeof entry.optimize !== 'object') entry.optimize = {};
        entry.optimize.mode = 'F';
      }
    };

    const mergeBlockVariablesFromSnapshot = (block: any, snapshotVars: any) => {
      if (!block || typeof block !== 'object' || !snapshotVars || typeof snapshotVars !== 'object') return;
      if (!block.variables || typeof block.variables !== 'object') {
        block.variables = cloneJson(snapshotVars) || snapshotVars;
        return;
      }

      const currentParams = (block.parameters && typeof block.parameters === 'object') ? block.parameters : {};
      for (const [key, snapshotEntry] of Object.entries(snapshotVars)) {
        if (!snapshotEntry || typeof snapshotEntry !== 'object') continue;
        const currentEntry = (block.variables && typeof block.variables[key] === 'object') ? block.variables[key] : {};
        const mergedEntry: any = {
          ...snapshotEntry,
          ...currentEntry,
        };
        const snapshotOptimize = (snapshotEntry as any).optimize;
        const currentOptimize = currentEntry.optimize;
        if ((snapshotOptimize && typeof snapshotOptimize === 'object') || (currentOptimize && typeof currentOptimize === 'object')) {
          mergedEntry.optimize = {
            ...(snapshotOptimize && typeof snapshotOptimize === 'object' ? snapshotOptimize : {}),
            ...(currentOptimize && typeof currentOptimize === 'object' ? currentOptimize : {}),
          };
        }
        if (!Object.prototype.hasOwnProperty.call(mergedEntry, 'value') && Object.prototype.hasOwnProperty.call(currentParams, key)) {
          mergedEntry.value = currentParams[key];
        }
        block.variables[key] = mergedEntry;
      }
    };

    const syncCoefSeries = (block: any, targetPrefix: string, row: any) => {
      let sawCoefKey = false;
      for (let i = 1; i <= 10; i++) {
        const sourceKey = `coef${i}`;
        const targetKey = `${targetPrefix}${i}`;
        if (Object.prototype.hasOwnProperty.call(row, sourceKey)) {
          setParam(block, targetKey, (row as any)[sourceKey]);
          sawCoefKey = true;
        }
      }
      if (!sawCoefKey) {
        for (let i = 1; i <= 10; i++) {
          setParam(block, `${targetPrefix}${i}`, '');
        }
      }
    };

    const updateBlockByRole = (block: any, role: string, row: any) => {
      const blockType = String(block?.blockType ?? '');
      const r = String(role || '').trim();
      const radius = row?.radius;
      const thickness = row?.thickness;
      const material = row?.material;
      const conic = row?.conic;
      const surfType = String(row?.surfType ?? row?.surfaceType ?? '').trim();

      if (blockType === 'Lens') {
        if (r === 'front') {
          setParamAndLegacyVar(block, 'frontRadius', radius);
          setParamAndLegacyVar(block, 'centerThickness', thickness);
          setParamAndLegacyVar(block, 'material', material);
          if (row?.rindex !== undefined) setParamAndLegacyVar(block, 'rindex', row.rindex);
          if (row?.abbe !== undefined) setParamAndLegacyVar(block, 'abbe', row.abbe);
          setParamAndLegacyVar(block, 'frontConic', conic);
          if (surfType) setParamAndLegacyVar(block, 'frontSurfType', surfType);
          if (row?.radiusX !== undefined && row?.radiusX !== '') setParamAndLegacyVar(block, 'frontRadiusX', row.radiusX);
          if (row?.axis !== undefined && row?.axis !== '') setParamAndLegacyVar(block, 'frontAxis', row.axis);
          syncCoefSeries(block, 'frontCoef', row);
          sanitizeExclusiveGlassVarFamily(block);
        } else if (r === 'back') {
          setParamAndLegacyVar(block, 'backRadius', radius);
          setParamAndLegacyVar(block, 'backConic', conic);
          if (surfType) setParamAndLegacyVar(block, 'backSurfType', surfType);
          if (row?.radiusX !== undefined && row?.radiusX !== '') setParamAndLegacyVar(block, 'backRadiusX', row.radiusX);
          if (row?.axis !== undefined && row?.axis !== '') setParamAndLegacyVar(block, 'backAxis', row.axis);
          syncCoefSeries(block, 'backCoef', row);
        }
      } else if (blockType === 'SingleSurface') {
        setParamAndLegacyVar(block, 'radius', radius);
        setParamAndLegacyVar(block, 'thickness', thickness);
        setParamAndLegacyVar(block, 'material', material);
        if (row?.rindex !== undefined) setParamAndLegacyVar(block, 'rindex', row.rindex);
        if (row?.abbe !== undefined) setParamAndLegacyVar(block, 'abbe', row.abbe);
        setParamAndLegacyVar(block, 'conic', conic);
        if (surfType) setParamAndLegacyVar(block, 'surfType', surfType);
        if (row?.radiusX !== undefined && row?.radiusX !== '') setParamAndLegacyVar(block, 'radiusX', row.radiusX);
        if (row?.radiusY !== undefined && row?.radiusY !== '') setParamAndLegacyVar(block, 'radiusY', row.radiusY);
        if (row?.axis !== undefined && row?.axis !== '') setParamAndLegacyVar(block, 'axis', row.axis);
        syncCoefSeries(block, 'coef', row);
        sanitizeExclusiveGlassVarFamily(block);
      } else if (blockType === 'Mirror') {
        setParamAndLegacyVar(block, 'radius', radius);
        setParamAndLegacyVar(block, 'thickness', thickness);
        setParamAndLegacyVar(block, 'conic', conic);
        if (surfType) setParamAndLegacyVar(block, 'surfType', surfType);
        syncCoefSeries(block, 'coef', row);
      } else if (blockType === 'Doublet') {
        const idx = r === 's1' ? '1' : (r === 's2' ? '2' : (r === 's3' ? '3' : ''));
        if (!idx) return;
        setParamAndLegacyVar(block, `radius${idx}`, radius);
        setParamAndLegacyVar(block, `surf${idx}Conic`, conic);
        if (surfType) setParamAndLegacyVar(block, `surf${idx}SurfType`, surfType);
        if (idx === '1') {
          setParamAndLegacyVar(block, 'thickness1', thickness);
          setParamAndLegacyVar(block, 'material1', material);
          if (row?.rindex !== undefined) setParamAndLegacyVar(block, 'rindex1', row.rindex);
          if (row?.abbe !== undefined) setParamAndLegacyVar(block, 'abbe1', row.abbe);
          sanitizeExclusiveGlassVarFamily(block, '1');
        }
        if (idx === '2') {
          setParamAndLegacyVar(block, 'thickness2', thickness);
          setParamAndLegacyVar(block, 'material2', material);
          if (row?.rindex !== undefined) setParamAndLegacyVar(block, 'rindex2', row.rindex);
          if (row?.abbe !== undefined) setParamAndLegacyVar(block, 'abbe2', row.abbe);
          sanitizeExclusiveGlassVarFamily(block, '2');
        }
        syncCoefSeries(block, `surf${idx}Coef`, row);
      } else if (blockType === 'Triplet') {
        const idx = r === 's1' ? '1' : (r === 's2' ? '2' : (r === 's3' ? '3' : (r === 's4' ? '4' : '')));
        if (!idx) return;
        setParamAndLegacyVar(block, `radius${idx}`, radius);
        setParamAndLegacyVar(block, `surf${idx}Conic`, conic);
        if (surfType) setParamAndLegacyVar(block, `surf${idx}SurfType`, surfType);
        if (idx === '1') {
          setParamAndLegacyVar(block, 'thickness1', thickness);
          setParamAndLegacyVar(block, 'material1', material);
          if (row?.rindex !== undefined) setParamAndLegacyVar(block, 'rindex1', row.rindex);
          if (row?.abbe !== undefined) setParamAndLegacyVar(block, 'abbe1', row.abbe);
          sanitizeExclusiveGlassVarFamily(block, '1');
        }
        if (idx === '2') {
          setParamAndLegacyVar(block, 'thickness2', thickness);
          setParamAndLegacyVar(block, 'material2', material);
          if (row?.rindex !== undefined) setParamAndLegacyVar(block, 'rindex2', row.rindex);
          if (row?.abbe !== undefined) setParamAndLegacyVar(block, 'abbe2', row.abbe);
          sanitizeExclusiveGlassVarFamily(block, '2');
        }
        if (idx === '3') {
          setParamAndLegacyVar(block, 'thickness3', thickness);
          setParamAndLegacyVar(block, 'material3', material);
          if (row?.rindex !== undefined) setParamAndLegacyVar(block, 'rindex3', row.rindex);
          if (row?.abbe !== undefined) setParamAndLegacyVar(block, 'abbe3', row.abbe);
          sanitizeExclusiveGlassVarFamily(block, '3');
        }
        syncCoefSeries(block, `surf${idx}Coef`, row);
      } else if (blockType === 'Stop' && (r === 'stop' || r === 'single')) {
        setParamAndLegacyVar(block, 'semiDiameter', row?.semidia);
      }

      if (row?.semidia !== undefined && row?.semidia !== '' && r) {
        if (!block.aperture || typeof block.aperture !== 'object') block.aperture = {};
        block.aperture[r] = row.semidia;
      }
    };

    const syncGapBlocksFromRows = (rows: any[], blocks: any[]) => {
      if (!Array.isArray(rows) || !Array.isArray(blocks)) return 0;

      const normalizeType = (t: any) => String(t ?? '').trim().toLowerCase();
      const resolveGapMaterialFromRow = (row: any): any => {
        if (!row || typeof row !== 'object') return row?.material;
        const explicitGapMaterial = row.__cooptGapMaterial;
        if (explicitGapMaterial !== undefined) return explicitGapMaterial;
        const rowBlockType = String(row?._blockType ?? row?.blockType ?? '').trim();
        if (rowBlockType === 'CoordTrans') return undefined;
        return row?.material;
      };
      const resolveGapRindexFromRow = (row: any): any => {
        if (!row || typeof row !== 'object') return row?.rindex;
        if (row.__cooptGapRindex !== undefined) return row.__cooptGapRindex;
        const rowBlockType = String(row?._blockType ?? row?.blockType ?? '').trim();
        if (rowBlockType === 'CoordTrans') return undefined;
        return row?.rindex;
      };
      const resolveGapAbbeFromRow = (row: any): any => {
        if (!row || typeof row !== 'object') return row?.abbe;
        if (row.__cooptGapAbbe !== undefined) return row.__cooptGapAbbe;
        const rowBlockType = String(row?._blockType ?? row?.blockType ?? '').trim();
        if (rowBlockType === 'CoordTrans') return undefined;
        return row?.abbe;
      };
      const gapBlocks = blocks.filter((b: any) => {
        const t = normalizeType(b?.blockType);
        return t === 'gap' || t === 'airgap';
      });
      if (gapBlocks.length === 0) return 0;

      const usedRows = new Set<number>();
      const pickRowForGap = (gapBlockId: string): any => {
        if (gapBlockId) {
          for (let i = 0; i < rows.length; i++) {
            if (usedRows.has(i)) continue;
            const r = rows[i];
            if (!r || typeof r !== 'object') continue;
            if (String(r?._blockId ?? '').trim() === gapBlockId) {
              usedRows.add(i);
              return r;
            }
          }
        }

        for (let i = 0; i < rows.length; i++) {
          if (usedRows.has(i)) continue;
          const r = rows[i];
          if (!r || typeof r !== 'object') continue;
          if (r?.__cooptGapApplied === true || normalizeType(r?._blockType) === 'gap') {
            usedRows.add(i);
            return r;
          }
        }
        return null;
      };

      let touched = 0;
      for (const gb of gapBlocks) {
        const gapId = String(gb?.blockId ?? '').trim();
        const row = pickRowForGap(gapId);
        if (!row) continue;
        setParamAndLegacyVar(gb, 'thickness', row?.__cooptGapThickness ?? row?.thickness);
        const gapMaterial = resolveGapMaterialFromRow(row);
        const gapRindex = resolveGapRindexFromRow(row);
        const gapAbbe = resolveGapAbbeFromRow(row);
        if (gapMaterial !== undefined) setParamAndLegacyVar(gb, 'material', gapMaterial);
        if (gapRindex !== undefined) setParamAndLegacyVar(gb, 'rindex', gapRindex);
        if (gapAbbe !== undefined && gapAbbe !== '') setParamAndLegacyVar(gb, 'abbe', gapAbbe);
        sanitizeExclusiveGlassVarFamily(gb);
        touched += 1;
      }
      return touched;
    };

    const syncRowsBackToActiveBlocks = (rows: any[], objectRows?: any[]) => {
      if (!Array.isArray(rows) || rows.length === 0) return;
      const w = getOptimizeSyncTargetWindow();
      try {
        const cfg = typeof w.loadSystemConfigurationsFromTableConfig === 'function'
          ? w.loadSystemConfigurationsFromTableConfig()
          : (typeof w.loadSystemConfigurations === 'function' ? w.loadSystemConfigurations() : null);
        if (!cfg || !Array.isArray(cfg.configurations)) return;
        const activeId = cfg.activeConfigId;
        const active = cfg.configurations.find((c: any) => String(c?.id) === String(activeId));
        if (!active) {
          return;
        }

        // Blocks are canonical, so optimized rows must be written back into the
        // active block graph instead of stopping at the expanded table rows.

        const cloneValue = (value: any) => {
          try {
            return JSON.parse(JSON.stringify(value));
          } catch (_) {
            return Array.isArray(value) ? value.slice() : value;
          }
        };

        if (Array.isArray(objectRows)) {
          active.object = cloneValue(objectRows);
        }

        if (!Array.isArray(active.blocks) || active.blocks.length === 0) {
          active.opticalSystem = cloneValue(rows);
          if (!active.metadata || typeof active.metadata !== 'object') active.metadata = {};
          active.metadata.modified = new Date().toISOString();
          if (typeof w.saveSystemConfigurationsFromTableConfig === 'function') {
            w.saveSystemConfigurationsFromTableConfig(cfg);
          } else if (typeof w.saveSystemConfigurations === 'function') {
            w.saveSystemConfigurations(cfg);
          }
          return;
        }

        const blockById = new Map<string, any>();
        const blockVariableSnapshots = new Map<string, any>();
        for (const b of active.blocks) {
          const id = String(b?.blockId ?? '').trim();
          if (id) {
            blockById.set(id, b);
            if (b?.variables && typeof b.variables === 'object') {
              blockVariableSnapshots.set(id, cloneJson(b.variables) || b.variables);
            }
          }
        }

        let touched = 0;
        for (const row of rows) {
          const blockId = String(row?._blockId ?? '').trim();
          const role = String(row?._surfaceRole ?? '').trim();
          if (!blockId || !role) continue;
          const block = blockById.get(blockId);
          if (!block) continue;
          updateBlockByRole(block, role, row);
          touched += 1;
        }

        touched += syncGapBlocksFromRows(rows, active.blocks);

        for (const block of active.blocks) {
          const blockId = String(block?.blockId ?? '').trim();
          if (!blockId) continue;
          mergeBlockVariablesFromSnapshot(block, blockVariableSnapshots.get(blockId));
        }

        if (touched > 0) {
          if (typeof w.expandBlocksIntoConfiguration === 'function') {
            w.expandBlocksIntoConfiguration(active);
          } else if (typeof w.expandBlocksToOpticalSystemRows === 'function') {
            const expanded = w.expandBlocksToOpticalSystemRows(active.blocks);
            if (expanded && Array.isArray(expanded.rows)) {
              active.opticalSystem = expanded.rows;
            }
          }
        } else {
          active.opticalSystem = cloneValue(rows);
        }

        if (!active.metadata || typeof active.metadata !== 'object') active.metadata = {};
        active.metadata.modified = new Date().toISOString();

        if (typeof w.saveSystemConfigurationsFromTableConfig === 'function') {
          w.saveSystemConfigurationsFromTableConfig(cfg);
        } else if (typeof w.saveSystemConfigurations === 'function') {
          w.saveSystemConfigurations(cfg);
        }
      } catch (_) {}
    };

    (window as any).__cooptSyncRowsBackToActiveBlocks = (rows: any[], objectRows?: any[]) => {
      syncRowsBackToActiveBlocks(rows, objectRows);
    };

    const cloneJson = (v: any) => {
      try {
        return JSON.parse(JSON.stringify(v));
      } catch (_) {
        return null;
      }
    };

    const loadSystemConfigSnapshot = (): any => {
      const w = getOptimizeSyncTargetWindow();
      try {
        const cfg = typeof w.loadSystemConfigurationsFromTableConfig === 'function'
          ? w.loadSystemConfigurationsFromTableConfig()
          : (typeof w.loadSystemConfigurations === 'function' ? w.loadSystemConfigurations() : null);
        return cloneJson(cfg);
      } catch (_) {
        return null;
      }
    };

    const loadOpticalRowsSnapshot = (): any[] => {
      const w = getOptimizeSyncTargetWindow();
      try {
        const rows = typeof w.getOpticalSystemRows === 'function'
          ? w.getOpticalSystemRows(w.tableOpticalSystem)
          : [];
        return Array.isArray(rows) ? (cloneJson(rows) || []) : [];
      } catch (_) {
        return [];
      }
    };

    const applySystemConfigSnapshotSync = (snapshot: any): void => {
      const w = getOptimizeSyncTargetWindow();
      if (!snapshot || typeof snapshot !== 'object') return;
      try {
        const cloned = cloneJson(snapshot);
        if (!cloned) return;
        if (typeof w.saveSystemConfigurationsFromTableConfig === 'function') {
          w.saveSystemConfigurationsFromTableConfig(cloned);
        } else if (typeof w.saveSystemConfigurations === 'function') {
          w.saveSystemConfigurations(cloned);
        }
        if (typeof w.loadActiveConfigurationToTables === 'function') {
          w.loadActiveConfigurationToTables();
        }
        requestRefreshBlockInspector(w);
        if (typeof w.refreshAllUI === 'function') {
          w.refreshAllUI();
        }
      } catch (_) {}
    };

    const applyOpticalRowsSnapshotSync = (rowsSnapshot: any[]): void => {
      const w = getOptimizeSyncTargetWindow();
      if (!Array.isArray(rowsSnapshot) || rowsSnapshot.length === 0) return;
      try {
        const rows = cloneJson(rowsSnapshot) || [];
        const table = w.tableOpticalSystem;
        if (table && typeof table.replaceData === 'function') {
          table.replaceData(rows);
        } else if (table && typeof table.setData === 'function') {
          table.setData(rows);
        }
        syncRowsBackToActiveBlocks(rows);
        if (typeof w.loadActiveConfigurationToTables === 'function') {
          w.loadActiveConfigurationToTables();
        }
      } catch (_) {}
    };

    const recordOptimizationUndoFromSnapshots = (
      beforeSnapshot: any,
      beforeRowsSnapshot: any[],
      afterSnapshot: any,
      afterRowsSnapshot: any[],
      description = 'Optimization apply'
    ): void => {
      try {
        const beforeText = beforeSnapshot ? JSON.stringify(beforeSnapshot) : '';
        const afterText = afterSnapshot ? JSON.stringify(afterSnapshot) : '';
        const beforeRowsText = JSON.stringify(beforeRowsSnapshot || []);
        const afterRowsText = JSON.stringify(afterRowsSnapshot || []);
        const configChanged = !!beforeText && !!afterText && beforeText !== afterText;
        const rowsChanged = beforeRowsText !== afterRowsText;
        const changed = configChanged || rowsChanged;
        const undoHistory = (window as any).undoHistory;
        if (!changed || !undoHistory || typeof undoHistory.record !== 'function') return;
        const isOptimizationRun = String(description || '').trim() === 'Optimization run';
        const cmd = {
          id: `opt-main-apply-${Date.now()}`,
          __cooptOptimizationCommand: isOptimizationRun,
          __cooptPostOptimizationTrailing: !isOptimizationRun,
          description,
          name: 'Optimization',
          timestamp: Date.now(),
          execute: () => {
            applySystemConfigSnapshotSync(afterSnapshot);
            applyOpticalRowsSnapshotSync(afterRowsSnapshot);
          },
          undo: () => {
            applySystemConfigSnapshotSync(beforeSnapshot);
            applyOpticalRowsSnapshotSync(beforeRowsSnapshot);
          },
        } as any;
        undoHistory.record(cmd);
        try {
          (globalThis as any).__cooptLastOptimizationUndoRecordAt = Number(cmd.timestamp) || Date.now();
        } catch (_) {}
      } catch (_) {}
    };

    (window as any).__cooptRecordOptimizationUndoFromSnapshots = (
      beforeSnapshot: any,
      beforeRowsSnapshot: any[],
      afterSnapshot: any,
      afterRowsSnapshot: any[],
      description = 'Optimization apply'
    ) => {
      recordOptimizationUndoFromSnapshots(beforeSnapshot, beforeRowsSnapshot, afterSnapshot, afterRowsSnapshot, description);
    };

    let lastOptimizeApplyToken: string | null = null;

    const applyOptimizedRows = async (
      rows: any[],
      applyToken = '',
      undoSnapshots?: {
        beforeConfig?: any;
        beforeRows?: any[];
        afterConfig?: any;
        afterRows?: any[];
      },
      options?: {
        syncBlocks?: boolean;
      }
    ) => {
      if (!Array.isArray(rows) || rows.length === 0) return;
      const w = window as any;
      let beforeSnapshot: any = null;
      let beforeRowsSnapshot: any[] = [];
      let afterSnapshot: any = null;
      let afterRowsSnapshot: any[] = [];
      const undoHistory = w.undoHistory;
      const shouldSyncBlocks = options?.syncBlocks !== false;
      const prevIsExecuting = !!undoHistory?.isExecuting;
      try {
        if (applyToken && lastOptimizeApplyToken === applyToken) {
          return;
        }
        if (undoHistory) {
          undoHistory.isExecuting = true;
        }
        beforeSnapshot = loadSystemConfigSnapshot();
        beforeRowsSnapshot = loadOpticalRowsSnapshot();
        const table = w.tableOpticalSystem;
        if (table && typeof table.setData === 'function') {
          await table.setData(rows);
        }
        if (shouldSyncBlocks) {
          syncRowsBackToActiveBlocks(rows);
        }
        afterSnapshot = loadSystemConfigSnapshot();
        afterRowsSnapshot = loadOpticalRowsSnapshot();

        if (applyToken) {
          lastOptimizeApplyToken = applyToken;
        }

        requestRefreshBlockInspector(w);
        if (typeof w.refreshAllUI === 'function') {
          w.refreshAllUI();
        }
        await requestRequirementReeval('optimize-storage-sync');
        if (typeof w.drawOpticalSystem === 'function') {
          w.drawOpticalSystem();
        }
        try {
          applyRenderSync(rows);
        } catch (_) {}
      } catch (_) {}
      finally {
        if (undoHistory) {
          undoHistory.isExecuting = prevIsExecuting;
        }
      }

      try {
        recordOptimizationUndoFromSnapshots(
          undoSnapshots?.beforeConfig ?? beforeSnapshot,
          Array.isArray(undoSnapshots?.beforeRows) ? undoSnapshots?.beforeRows : beforeRowsSnapshot,
          undoSnapshots?.afterConfig ?? afterSnapshot,
          Array.isArray(undoSnapshots?.afterRows) ? undoSnapshots?.afterRows : afterRowsSnapshot,
          'Optimization apply'
        );
      } catch (_) {}
    };

    // Called by optimize popup to synchronously apply rows and get latest table score.
    (window as any).__cooptRefreshRequirementTableScoreForOptimize = async (
      rows: any[],
      reason = 'optimize-host-refresh',
      options?: { syncBlocks?: boolean }
    ) => {
      if (!Array.isArray(rows) || rows.length === 0) return Number.NaN;
      const startedAt = Date.now();
      await applyOptimizedRows(rows, '', undefined, { syncBlocks: options?.syncBlocks === true });
      await requestRequirementReeval(reason, true);
      await waitRequirementEvalDone(startedAt);
      return readRequirementTableScoreFromHost();
    };

    (window as any).__cooptPerfTop = (options?: {
      limit?: number;
      sortBy?: 'lastMs' | 'totalMs' | 'maxMs' | 'avgMs' | 'count';
      names?: string[];
      minCount?: number;
      minMs?: number;
    }) => summarizeCooptPerfCounters(options);

    (window as any).__cooptPerfReset = (names?: string[]) => {
      clearCooptPerfCounters(names);
    };

    const currentRenderSyncSenderId = getOrCreateCooptWindowSyncSenderId();

    const readHandledRenderSyncStamp = () => {
      try {
        const stamp = String((window as any).__cooptLastRenderSyncStamp ?? '');
        return stamp || lastRenderSyncStamp;
      } catch (_) {
        return lastRenderSyncStamp;
      }
    };

    const markHandledRenderSyncStamp = (target: any, stamp: string) => {
      if (!target || !stamp) return;
      try {
        target.__cooptLastRenderSyncStamp = stamp;
      } catch (_) {}
    };

    const applyRenderSync = (rows: any[], syncStamp = '', objectRows?: any[], systemConfig?: any) => {
      try {
        const w = window as any;
        const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        const prevRunning = g ? !!g.__cooptOptimizerIsRunning : false;
        const prevObjectOverride = g ? g.__cooptRenderObjectRowsOverride : null;
        const clonedSystemConfig = systemConfig && typeof systemConfig === 'object'
          ? (cloneJson(systemConfig) || systemConfig)
          : null;
        if (syncStamp) {
          lastRenderSyncStamp = syncStamp;
          markHandledRenderSyncStamp(w, syncStamp);
        }
        if (g && rows.length > 0) g.__cooptOpticalSystemRowsOverride = rows;
        if (g && Array.isArray(objectRows)) g.__cooptRenderObjectRowsOverride = objectRows;
        if (clonedSystemConfig) {
          try { w.__cooptPendingRenderSystemConfig = clonedSystemConfig; } catch (_) {}
        }
        // Set optimizer flag so draw-cross handler skips loadActiveConfigurationToTables
        if (g) g.__cooptOptimizerIsRunning = true;
        try {
          if (typeof w.__cooptRenderWindowRedraw === 'function') {
            void Promise.resolve(w.__cooptRenderWindowRedraw(rows, syncStamp || undefined, objectRows));
          } else if (typeof w.drawOpticalSystem === 'function') {
            w.drawOpticalSystem();
          }
        } catch (_) {}
        try {
          const popup = w.popup3DWindow;
          if (popup && !popup.closed) {
            if (clonedSystemConfig) {
              try {
                popup.__cooptPendingRenderSystemConfig = clonedSystemConfig;
                popup.__cooptSystemConfig = clonedSystemConfig;
                popup.__cooptPreferRuntimeSystemConfig = true;
              } catch (_) {}
            }
            if (typeof popup.__cooptRenderWindowRedraw === 'function') {
              void Promise.resolve(popup.__cooptRenderWindowRedraw(rows, syncStamp || undefined, objectRows));
            } else if (typeof popup.postMessage === 'function') {
              try { popup.__cooptPendingRenderObjectRows = Array.isArray(objectRows) ? objectRows : []; } catch (_) {}
              popup.postMessage(
                syncStamp
                  ? { action: 'request-redraw', rows, objectRows, systemConfig: clonedSystemConfig, ts: syncStamp, token: syncStamp }
                  : { action: 'request-redraw', rows, objectRows, systemConfig: clonedSystemConfig },
                '*'
              );
            }
          }
        } catch (_) {}
        // Restore flags after popup message roundtrip (~400 ms)
        setTimeout(() => {
          try {
            if (g) g.__cooptOptimizerIsRunning = prevRunning;
            if (g) g.__cooptOpticalSystemRowsOverride = null;
            if (g) g.__cooptRenderObjectRowsOverride = prevObjectOverride;
          } catch (_) {}
        }, 400);
      } catch (_) {}
    };

    let lastRenderSyncStamp = '';
    let lastOptimizeProgressStamp = '';
    const applyRenderSyncPayload = (payload: any) => {
      try {
        const senderId = String(payload?.senderId ?? '').trim();
        if (senderId && senderId === currentRenderSyncSenderId) return;
        const stamp = String(payload?.ts ?? payload?.token ?? '');
        if (stamp && stamp === readHandledRenderSyncStamp()) return;
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : undefined;
        const systemConfig = payload?.systemConfig && typeof payload.systemConfig === 'object' ? payload.systemConfig : undefined;
        applyRenderSync(rows, stamp, objectRows, systemConfig);
      } catch (_) {}
    };

    const applyOptimizeProgressPayload = (payload: any) => {
      try {
        const stamp = String(payload?.ts ?? payload?.token ?? '');
        if (stamp && stamp === lastOptimizeProgressStamp) return;
        if (stamp) lastOptimizeProgressStamp = stamp;
        const progressPhase = String(payload?.phase ?? '').trim().toLowerCase();
        const reqSnapshot = Array.isArray(payload?.requirementSnapshots) ? payload.requirementSnapshots : [];
        if (reqSnapshot.length > 0) {
          const sre = (window as any).systemRequirementsEditor;
          if (sre && typeof sre.applyOptimizerRequirementSnapshot === 'function') {
            sre.applyOptimizerRequirementSnapshot(reqSnapshot);
          }
          return;
        }

        // Live progress must not apply optical rows. Final done/stop sync owns table/config persistence.
      } catch (_) {}
    };

    const onStorage = (ev: StorageEvent) => {

      if (ev.key === OPTIMIZE_PROGRESS_SYNC_KEY && ev.newValue && !isOptimizeWindowMode) {
        try {
          const payload = JSON.parse(ev.newValue);
          applyOptimizeProgressPayload(payload);
        } catch (_) {}
        return;
      }

      // Handle live render sync from the optimize window (Tauri WebviewWindow sends rows here)
      if (ev.key === 'coopt.renderSyncRequest' && ev.newValue && !isOptimizeWindowMode) {
        try {
          const payload = JSON.parse(ev.newValue);
          applyRenderSyncPayload(payload);
        } catch (_) {}
        return;
      }
      if (ev.key !== optimizeRowsSyncKey || !ev.newValue) return;
      try {
        const payload = JSON.parse(ev.newValue);
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const token = String(payload?.ts ?? payload?.token ?? '');
        const undoSnapshots = {
          beforeConfig: payload?.beforeConfigSnapshot,
          beforeRows: Array.isArray(payload?.beforeRowsSnapshot) ? payload.beforeRowsSnapshot : [],
          afterConfig: payload?.afterConfigSnapshot,
          afterRows: Array.isArray(payload?.afterRowsSnapshot) ? payload.afterRowsSnapshot : [],
        };
        void applyOptimizedRows(rows, token, undoSnapshots, { syncBlocks: payload?.syncBlocks === true });
      } catch (_) {}
    };

    let tauriUnlisten: (() => void) | null = null;
    let tauriListenerCancelled = false;
    if (!isOptimizeWindowMode) {
      void (async () => {
        try {
          const mod = await import('@tauri-apps/api/event');
          if (tauriListenerCancelled || !mod || typeof (mod as any).listen !== 'function') return;
          const renderUnlisten = await (mod as any).listen('coopt-render-sync-request', (ev: any) => {
            try {
              applyRenderSyncPayload(ev?.payload);
            } catch (_) {}
          });
          const progressUnlisten = await (mod as any).listen('coopt-optimize-progress', (ev: any) => {
            try {
              applyOptimizeProgressPayload(ev?.payload);
            } catch (_) {}
          });
          const unlisten = await (mod as any).listen('coopt-optimize-rows-sync', (ev: any) => {
            try {
              const rows = Array.isArray(ev?.payload?.rows) ? ev.payload.rows : [];
              const token = String(ev?.payload?.ts ?? ev?.payload?.token ?? '');
              const undoSnapshots = {
                beforeConfig: ev?.payload?.beforeConfigSnapshot,
                beforeRows: Array.isArray(ev?.payload?.beforeRowsSnapshot) ? ev.payload.beforeRowsSnapshot : [],
                afterConfig: ev?.payload?.afterConfigSnapshot,
                afterRows: Array.isArray(ev?.payload?.afterRowsSnapshot) ? ev.payload.afterRowsSnapshot : [],
              };
              void applyOptimizedRows(rows, token, undoSnapshots, { syncBlocks: ev?.payload?.syncBlocks === true });
            } catch (_) {}
          });
          if (tauriListenerCancelled) {
            try { unlisten(); } catch (_) {}
            try { renderUnlisten(); } catch (_) {}
            try { progressUnlisten(); } catch (_) {}
            return;
          }
          tauriUnlisten = () => {
            try { unlisten(); } catch (_) {}
            try { renderUnlisten(); } catch (_) {}
            try { progressUnlisten(); } catch (_) {}
          };
        } catch (_) {}
      })();
    }

    window.addEventListener('storage', onStorage);
    const renderSyncPollTimer = !isOptimizeWindowMode
      ? window.setInterval(() => {
          try {
            const raw = localStorage.getItem('coopt.renderSyncRequest');
            if (!raw) return;
            const payload = JSON.parse(raw);
            applyRenderSyncPayload(payload);
          } catch (_) {}
        }, 180)
      : null;
    const optimizeProgressPollTimer = !isOptimizeWindowMode
      ? window.setInterval(() => {
          try {
            const raw = localStorage.getItem(OPTIMIZE_PROGRESS_SYNC_KEY);
            if (!raw) return;
            const payload = JSON.parse(raw);
            applyOptimizeProgressPayload(payload);
          } catch (_) {}
        }, 180)
      : null;
    return () => {
      window.removeEventListener('storage', onStorage);
      if (renderSyncPollTimer !== null) {
        try { window.clearInterval(renderSyncPollTimer); } catch (_) {}
      }
      if (optimizeProgressPollTimer !== null) {
        try { window.clearInterval(optimizeProgressPollTimer); } catch (_) {}
      }
      tauriListenerCancelled = true;
      if (tauriUnlisten) {
        try { tauriUnlisten(); } catch (_) {}
      }
      try { delete (window as any).__cooptRecordOptimizationUndoFromSnapshots; } catch (_) {
        (window as any).__cooptRecordOptimizationUndoFromSnapshots = undefined;
      }
      try { delete (window as any).__cooptRefreshRequirementTableScoreForOptimize; } catch (_) {
        (window as any).__cooptRefreshRequirementTableScoreForOptimize = undefined;
      }
      try { delete (window as any).__cooptPerfTop; } catch (_) {
        (window as any).__cooptPerfTop = undefined;
      }
      try { delete (window as any).__cooptPerfReset; } catch (_) {
        (window as any).__cooptPerfReset = undefined;
      }
    };
  }, [isOptimizeWindowMode]);
  const isSettingsWindowMode = (() => {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('coopt_settings_window') === '1';
    } catch (_) {
      return false;
    }
  })();

  const ensurePlotlyLoaded = async (): Promise<void> => {
    const w = window as any;
    if (w.Plotly && typeof w.Plotly.newPlot === 'function') {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector('script[data-coopt-plotly="1"]') as HTMLScriptElement | null;
      if (existing) {
        if (w.Plotly && typeof w.Plotly.newPlot === 'function') {
          resolve();
          return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Failed to load Plotly')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://cdn.plot.ly/plotly-2.32.0.min.js';
      script.async = true;
      script.setAttribute('data-coopt-plotly', '1');
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error('Failed to load Plotly')), { once: true });
      document.head.appendChild(script);
    });

    if (!(window as any).Plotly || typeof (window as any).Plotly.newPlot !== 'function') {
      throw new Error('Plotly is unavailable');
    }
  };

  const ensureRenderCanvasAttached = (): boolean => {
    try {
      const w = window as any;
      const container = document.getElementById('threejs-canvas-container');
      if (!container) return false;

      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      const canvas = renderer?.domElement;
      if (!renderer || !canvas) return false;

      if (canvas.parentElement !== container) {
        container.appendChild(canvas);
      }

      const width = Math.max(1, container.clientWidth || window.innerWidth || 1);
      const height = Math.max(1, container.clientHeight || (window.innerHeight - 44) || 1);
      if (typeof renderer.setPixelRatio === 'function') {
        renderer.setPixelRatio(window.devicePixelRatio || 1);
      }
      if (typeof renderer.setSize === 'function') {
        renderer.setSize(width, height, false);
      }
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      return true;
    } catch (_) {
      return false;
    }
  };

  const syncOrthoBoundsToRendererAspect = (): void => {
    try {
      const w = window as any;
      const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      if (!camera?.isOrthographicCamera || !renderer || typeof renderer.getSize !== 'function') return;

      const THREERef = w.THREE;
      if (!THREERef?.Vector2) return;

      const size = renderer.getSize(new THREERef.Vector2());
      const width = Number(size?.x) || 0;
      const height = Number(size?.y) || 0;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return;

      const aspect = width / height;
      const currentHeight = (camera.top - camera.bottom) || 1;
      const centerX = (camera.left + camera.right) / 2;
      const centerY = (camera.top + camera.bottom) / 2;
      const nextWidth = currentHeight * aspect;

      camera.left = centerX - nextWidth / 2;
      camera.right = centerX + nextWidth / 2;
      camera.top = centerY + currentHeight / 2;
      camera.bottom = centerY - currentHeight / 2;
      camera.updateProjectionMatrix();
    } catch (_) {}
  };

const collectLegacyCrossRays = async (
  opticalSystemRows: any[],
  axis: 'YZ' | 'XZ' | 'BOTH' = 'BOTH',
  objectRowsOverride?: any[],
  options?: CollectLegacyCrossRaysOptions
): Promise<any[]> => {
    const totalStartMs = performance.now();
    const w = window as any;
    try {
      const getObjectRows = w.getObjectRows;
      const objectRowsRaw = Array.isArray(objectRowsOverride)
        ? objectRowsOverride
        : ((typeof getObjectRows === 'function') ? (getObjectRows(w.tableObject) || []) : []);
      const objectRows = Array.isArray(objectRowsRaw) ? objectRowsRaw : [];

      const objectSurface = opticalSystemRows[0] || {};
      const thicknessRaw = objectSurface?.thickness;
      const thicknessStr = String(thicknessRaw ?? '').trim().toUpperCase();
      const thicknessVal = Number(thicknessRaw);
      const isInfiniteSystem = (
        thicknessRaw === Infinity ||
        thicknessStr === 'INF' ||
        thicknessStr === 'INFINITY' ||
        thicknessStr === '∞' ||
        (Number.isFinite(thicknessVal) && Math.abs(thicknessVal) > 1e6)
      );

      const primaryWavelength = (typeof w.getPrimaryWavelength === 'function')
        ? (Number(w.getPrimaryWavelength()) || 0.5876)
        : 0.5876;
      const currentRenderRayCount = Math.max(1, Math.floor(Number(renderRayCountRef.current) || 1));
      const effectiveRayCount = (() => {
        const override = Number(options?.rayCountOverride);
        if (Number.isFinite(override) && override > 0) return Math.max(1, Math.floor(override));
        return currentRenderRayCount;
      })();

      const toNumber = (value: any) => {
        const parsed = parseFloat(String(value ?? ''));
        return Number.isFinite(parsed) ? parsed : 0;
      };

      let crossBeamResult: any = null;
      const crossType = axis === 'YZ' ? 'vertical' : (axis === 'XZ' ? 'horizontal' : 'both');
      const requestedPupilSamplingMode = readCurrentForceMode() || undefined;
      const normalizedObjectRows = objectRows.map((row: any, index: number) => {
        const posNorm = String(row?.position ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
        const storedTarget = row?.__cooptImageHeightTarget;
        const hasStoredImageHeightTarget = storedTarget
          && Number.isFinite(Number(storedTarget.x))
          && Number.isFinite(Number(storedTarget.y));
        if (posNorm !== 'imageheight' && !hasStoredImageHeightTarget) return row;
        try {
          return preserveRenderImageHeightRow(row, index, opticalSystemRows, primaryWavelength, isInfiniteSystem ? 'infinite' : 'finite');
        } catch (error) {
          console.warn('[collectLegacyCrossRays] ImageHeight approximation failed, using raw row:', error);
          return row;
        }
      });

      const cacheHasExactRows = effectiveRayCount <= 5 || normalizedObjectRows.some((row: any) => isRenderImageHeightObjectRow(row));
      const cacheKey = buildRenderLegacyCrossRayCacheKey(
        opticalSystemRows,
        normalizedObjectRows,
        axis,
        effectiveRayCount,
        primaryWavelength,
        requestedPupilSamplingMode,
        cacheHasExactRows,
      );
      const cachedRays = renderLegacyCrossRaysCache.get(cacheKey);
      if (cachedRays) {
        return attachRenderObjectColorSlots(cloneRenderLegacyCrossRays(cachedRays), normalizedObjectRows);
      }

      const hasExactImageHeightRows = normalizedObjectRows.some((row: any) => isRenderImageHeightObjectRow(row));
      if (effectiveRayCount <= 5 || hasExactImageHeightRows) {
        const exactImageHeightRows = normalizedObjectRows.filter((row: any) => isRenderImageHeightObjectRow(row));
        const exactNonImageHeightRows = normalizedObjectRows.filter((row: any) => !isRenderImageHeightObjectRow(row));
        const exactImageHeightRays = buildExactRenderRaysForImageHeightObjects(
          exactImageHeightRows,
          opticalSystemRows,
          primaryWavelength,
          isInfiniteSystem ? 'infinite' : 'finite',
          axis,
          effectiveRayCount,
        );
        const exactLowCountRays = buildExactLowCountRenderRaysForObjects(
          exactNonImageHeightRows,
          opticalSystemRows,
          primaryWavelength,
          isInfiniteSystem ? 'infinite' : 'finite',
          axis,
          effectiveRayCount,
        );
        const mergedExactRays = [
          ...(Array.isArray(exactImageHeightRays) ? exactImageHeightRays : []),
          ...(Array.isArray(exactLowCountRays) ? exactLowCountRays : []),
        ];
        if (mergedExactRays.length > 0) {
          const colorizedMergedExactRays = attachRenderObjectColorSlots(mergedExactRays, normalizedObjectRows);
          renderLegacyCrossRaysCache.set(cacheKey, cloneRenderLegacyCrossRays(colorizedMergedExactRays));
          clampRenderCacheSize(renderLegacyCrossRaysCache, RENDER_LEGACY_CROSS_RAYS_CACHE_LIMIT);
          return colorizedMergedExactRays;
        }
      }

      const directExactImageHeightRows: any[] = [];
      const crossBeamGenerationRows: any[] = [];
      normalizedObjectRows.forEach((row: any, index: number) => {
        if (isRenderImageHeightObjectRow(row)) {
          directExactImageHeightRows.push({
            ...row,
            objectIndex: Number.isFinite(Number(row?.objectIndex)) ? Number(row.objectIndex) : index,
          });
          return;
        }

        crossBeamGenerationRows.push({
          ...row,
          objectIndex: Number.isFinite(Number(row?.objectIndex)) ? Number(row.objectIndex) : index,
        });
      });
      try {
        const classificationSummary = normalizedObjectRows.map((row: any, index: number) => {
          const posNorm = String(row?.position ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
          const originalPosNorm = String(row?.__cooptOriginalPosition ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
          const storedTarget = row?.__cooptImageHeightTarget;
          const hasStoredImageHeightTarget = !!(
            storedTarget
            && Number.isFinite(Number(storedTarget.x))
            && Number.isFinite(Number(storedTarget.y))
          );
          return {
            index,
            objectIndex: Number.isFinite(Number(row?.objectIndex)) ? Number(row.objectIndex) : index,
            position: row?.position ?? null,
            originalPosition: row?.__cooptOriginalPosition ?? null,
            posNorm,
            originalPosNorm,
            hasStoredImageHeightTarget,
            bucket: isRenderImageHeightObjectRow(row) ? 'exact-imageheight' : 'legacy-crossbeam',
          };
        });
        (w as any).__COOPT_LAST_RENDER_IMAGEHEIGHT_CLASSIFICATION = {
          at: new Date().toISOString(),
          axis,
          effectiveRayCount,
          isInfiniteSystem,
          directExactImageHeightCount: directExactImageHeightRows.length,
          legacyCrossBeamCount: crossBeamGenerationRows.length,
          rows: classificationSummary,
        };
      } catch (_) {}
      const exactImageHeightRays = buildExactRenderRaysForImageHeightObjects(
        directExactImageHeightRows,
        opticalSystemRows,
        primaryWavelength,
        isInfiniteSystem ? 'infinite' : 'finite',
        axis,
        effectiveRayCount,
      );
      try {
        const lastClassification = (w as any).__COOPT_LAST_RENDER_IMAGEHEIGHT_CLASSIFICATION;
        if (lastClassification && typeof lastClassification === 'object') {
          lastClassification.exactImageHeightRayCount = Array.isArray(exactImageHeightRays) ? exactImageHeightRays.length : 0;
          lastClassification.objectDebug = Array.isArray((exactImageHeightRays as any)?.__cooptExactRenderDebug)
            ? (exactImageHeightRays as any).__cooptExactRenderDebug
            : [];
        }
      } catch (_) {}
      const generateStartMs = performance.now();
      if (crossBeamGenerationRows.length > 0 && isInfiniteSystem && typeof w.generateInfiniteSystemCrossBeam === 'function') {
        const objectAngles = crossBeamGenerationRows.map((row: any) => {
          return {
            x: toNumber(row?.xHeightAngle ?? row?.x),
            y: toNumber(row?.yHeightAngle ?? row?.y),
            objectIndex: Number.isFinite(Number(row?.objectIndex)) ? Number(row.objectIndex) : 0,
          };
        });

        const isImageRow = (row: any) => {
          const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
          const normalized = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
          return normalized === 'image' || normalized.startsWith('image');
        };
        const imageSurfaceIndex = opticalSystemRows.findIndex((row: any) => row && isImageRow(row));
        const targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);

        crossBeamResult = await w.generateInfiniteSystemCrossBeam(opticalSystemRows, objectAngles, {
          rayCount: effectiveRayCount,
          debugMode: false,
          wavelength: primaryWavelength,
          useRustWasm: true,
          crossType,
          pupilSamplingMode: requestedPupilSamplingMode,
          targetSurfaceIndex,
          angleUnit: 'deg',
          chiefZ: -20
        });
      } else if (crossBeamGenerationRows.length > 0 && typeof w.generateCrossBeam === 'function') {
        const allObjectPositions = crossBeamGenerationRows.map((row: any, index: number) => {
          if (Array.isArray(row)) {
            return { x: toNumber(row[1]), y: toNumber(row[2]), z: 0, objectIndex: index };
          }
          return {
            x: toNumber(row?.xHeightAngle ?? row?.x ?? row?.height ?? row?.heightX),
            y: toNumber(row?.yHeightAngle ?? row?.y ?? row?.height ?? row?.heightY),
            z: 0,
            objectIndex: row?.objectIndex ?? index
          };
        });

        crossBeamResult = await w.generateCrossBeam(opticalSystemRows, allObjectPositions, {
          rayCount: effectiveRayCount,
          debugMode: false,
          wavelength: primaryWavelength,
          useRustWasm: true,
          crossType
        });
      }
      recordCooptPerfSample('collectLegacyCrossRays.generate', performance.now() - generateStartMs);

      let allRays: any[] = [...exactImageHeightRays];
      if (!crossBeamResult || crossBeamResult.success === false) {
        recordCooptPerfSample('collectLegacyCrossRays.normalize', 0);
        recordCooptPerfSample('collectLegacyCrossRays.limit', 0);
        recordCooptPerfSample('collectLegacyCrossRays.total', performance.now() - totalStartMs);
        const colorizedAllRays = attachRenderObjectColorSlots(allRays, normalizedObjectRows);
        if (allRays.length > 0) {
          renderLegacyCrossRaysCache.set(cacheKey, cloneRenderLegacyCrossRays(colorizedAllRays));
          clampRenderCacheSize(renderLegacyCrossRaysCache, RENDER_LEGACY_CROSS_RAYS_CACHE_LIMIT);
        }
        return colorizedAllRays;
      }

      const normalizeStartMs = performance.now();
      const objectResults = Array.isArray(crossBeamResult.objectResults)
        ? crossBeamResult.objectResults
        : (Array.isArray(crossBeamResult.results) ? crossBeamResult.results : null);
      if (objectResults) {
        objectResults.forEach((result: any, resultIndex: number) => {
          const objectIndex = Number.isFinite(Number(result?.objectIndex))
            ? Number(result.objectIndex)
            : resultIndex;
          const tracedRays = Array.isArray(result?.tracedRays)
            ? result.tracedRays
            : (Array.isArray(result?.rays) ? result.rays : []);

          const normalized = tracedRays.map((ray: any) => {
            const fallbackType = ray?.type || ray?.beamType || 'chief';
            const fallbackSide = ray?.side;
            const resolvedObjectIndex = Number.isFinite(Number(ray?.objectIndex))
              ? Number(ray.objectIndex)
              : objectIndex;
            return {
              ...ray,
              objectIndex: resolvedObjectIndex,
              originalRay: {
                ...(ray?.originalRay || {}),
                type: ray?.originalRay?.type || fallbackType,
                side: ray?.originalRay?.side || fallbackSide,
                objectIndex: Number.isFinite(Number(ray?.originalRay?.objectIndex))
                  ? Number(ray.originalRay.objectIndex)
                  : resolvedObjectIndex
              }
            };
          });
          allRays = allRays.concat(normalized);
        });
      } else if (
        crossBeamResult.allCrossBeamRays && Array.isArray(crossBeamResult.allCrossBeamRays) &&
        crossBeamResult.allTracedRays && Array.isArray(crossBeamResult.allTracedRays)
      ) {
        // Fallback only for legacy return shapes. Index-based zipping is unsafe when
        // per-object tracing drops rays, so prefer objectResults/results above.
        allRays = allRays.concat(crossBeamResult.allTracedRays.map((tracedRay: any, index: number) => {
          const crossRay = crossBeamResult.allCrossBeamRays[index];
          if (crossRay) {
            tracedRay.type = tracedRay.type ?? crossRay.type;
            tracedRay.beamType = tracedRay.beamType ?? crossRay.beamType;
            tracedRay.side = tracedRay.side ?? crossRay.side;
            tracedRay.objectIndex = tracedRay.objectIndex ?? crossRay.objectIndex;
            tracedRay.originalRay = {
              ...(crossRay || {}),
              ...(tracedRay.originalRay || {}),
              type: tracedRay.originalRay?.type || crossRay.type,
              side: tracedRay.originalRay?.side || crossRay.side,
              objectIndex: tracedRay.originalRay?.objectIndex ?? tracedRay.objectIndex ?? crossRay.objectIndex
            };
          }
          return tracedRay;
        }));
      } else if (crossBeamResult.allCrossBeamRays && Array.isArray(crossBeamResult.allCrossBeamRays)) {
        allRays = allRays.concat(crossBeamResult.allCrossBeamRays);
      } else if (crossBeamResult.allTracedRays && Array.isArray(crossBeamResult.allTracedRays)) {
        allRays = allRays.concat(crossBeamResult.allTracedRays);
      } else if (crossBeamResult.tracedRays && Array.isArray(crossBeamResult.tracedRays)) {
        allRays = allRays.concat(crossBeamResult.tracedRays);
      } else if (Array.isArray(crossBeamResult)) {
        allRays = allRays.concat(crossBeamResult);
      }
      const normalizedAllRaysRaw = Array.isArray(allRays) ? allRays.map((ray: any) => {
        const inferredObjectIndex = Number.isFinite(Number(ray?.objectIndex))
          ? Number(ray.objectIndex)
          : (Number.isFinite(Number(ray?.originalRay?.objectIndex))
            ? Number(ray.originalRay.objectIndex)
            : 0);
        return {
          ...ray,
          objectIndex: inferredObjectIndex,
          originalRay: {
            ...(ray?.originalRay || {}),
            type: ray?.originalRay?.type || ray?.type,
            side: ray?.originalRay?.side || ray?.side,
            objectIndex: inferredObjectIndex
          }
        };
      }) : [];
      const normalizedAllRays = normalizedAllRaysRaw;
      recordCooptPerfSample('collectLegacyCrossRays.normalize', performance.now() - normalizeStartMs);

      const desiredCount = effectiveRayCount;
      const limitStartMs = performance.now();
      const exactImageHeightRaysOnly = normalizedAllRays.filter((ray: any) => ray?.__cooptImageHeightExactRender === true);
      const limitCandidateRays = normalizedAllRays.filter((ray: any) => ray?.__cooptImageHeightExactRender !== true);
      const grouped = new Map<number, any[]>();
      limitCandidateRays.forEach((ray: any) => {
        const objectIndex = Number.isFinite(Number(ray?.objectIndex)) ? Number(ray.objectIndex) : 0;
        if (!grouped.has(objectIndex)) grouped.set(objectIndex, []);
        grouped.get(objectIndex)!.push(ray);
      });

      const limitedRays: any[] = [...exactImageHeightRaysOnly];
      const perObjectCount = {};
      exactImageHeightRaysOnly.forEach((ray: any) => {
        const objectIndex = Number.isFinite(Number(ray?.objectIndex)) ? Number(ray.objectIndex) : 0;
        perObjectCount[objectIndex] = (Number(perObjectCount[objectIndex]) || 0) + 1;
      });
      grouped.forEach((rays, objectIndex) => {
        const chief = rays.filter((r: any) => String(r?.originalRay?.type || r?.type || '').toLowerCase() === 'chief');
        const nonChief = rays.filter((r: any) => String(r?.originalRay?.type || r?.type || '').toLowerCase() !== 'chief');

        const ordered = [...chief, ...nonChief]
          .sort(compareCrossRayDrawOrder)
          .map((r: any) => ({
          ...r,
          objectIndex,
          originalRay: {
            ...(r?.originalRay || {}),
            type: r?.originalRay?.type || r?.type,
            side: r?.originalRay?.side || r?.side,
            objectIndex
          }
          }));

        const alreadyKept = Number(perObjectCount[objectIndex]) || 0;
        const remainingSlots = Math.max(0, desiredCount - alreadyKept);
        const limited = remainingSlots > 0 ? selectCrossRaysForAxis(ordered, remainingSlots, axis) : [];
        perObjectCount[objectIndex] = alreadyKept + limited.length;
        limitedRays.push(...limited);
      });

      const finalRays = directExactImageHeightRows.length > 0
        ? limitedRays
        : replaceImageHeightChiefRaysWithExactRenderTrace(
            limitedRays,
            normalizedObjectRows,
            opticalSystemRows,
            primaryWavelength,
            isInfiniteSystem,
          );
      const colorizedFinalRays = attachRenderObjectColorSlots(finalRays, normalizedObjectRows);

      recordCooptPerfSample('collectLegacyCrossRays.limit', performance.now() - limitStartMs);
      recordCooptPerfSample('collectLegacyCrossRays.total', performance.now() - totalStartMs);

      renderLegacyCrossRaysCache.set(cacheKey, cloneRenderLegacyCrossRays(colorizedFinalRays));
      clampRenderCacheSize(renderLegacyCrossRaysCache, RENDER_LEGACY_CROSS_RAYS_CACHE_LIMIT);

      return colorizedFinalRays;
    } catch (error) {
      recordCooptPerfSample('collectLegacyCrossRays.total', performance.now() - totalStartMs);
      console.error('[RenderWindow] Legacy cross-beam generation failed:', error);
      return [];
    }
  };

  const applyRenderWindowDirectCrossFill = (scene: any, axis: 'YZ' | 'XZ', opticalSystemRows: any[]): number => {
    const w = window as any;
    const THREE = w?.THREE;
    if (!scene || !THREE || !Array.isArray(opticalSystemRows) || opticalSystemRows.length < 2) return 0;

    const toRemove: any[] = [];
    scene.traverse((child: any) => {
      if (child?.userData?.type === 'renderWindowDirectFill') {
        toRemove.push(child);
      }
    });
    [...new Set(toRemove)].forEach((obj: any) => {
      scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose());
        else obj.material.dispose();
      }
    });

    const getSemidia = (surface: any): number | null => {
      const candidates: Array<{ value: any; isDiameter: boolean }> = [
        { value: surface?.semidia, isDiameter: false },
        { value: surface?.semiDiameter, isDiameter: false },
        { value: surface?.['semi-diameter'], isDiameter: false },
        { value: surface?.semi_diameter, isDiameter: false },
        { value: surface?.clearAperture, isDiameter: false },
        { value: surface?.Clear_Aperture, isDiameter: false },
        { value: surface?.diameter, isDiameter: true }
      ];
      for (const candidate of candidates) {
        const n = Number(candidate.value);
        const parsed = Number.isFinite(n) ? n : parseFloat(String(candidate.value ?? ''));
        if (Number.isFinite(parsed) && parsed > 0) {
          return candidate.isDiameter ? parsed * 0.5 : parsed;
        }
      }
      return null;
    };

    const readWorldPolylinePoints = (lineObj: any): any[] => {
      if (!lineObj?.geometry?.attributes?.position) return [];
      const attr = lineObj.geometry.attributes.position;
      const points: any[] = [];
      for (let idx = 0; idx < attr.count; idx++) {
        const p = new THREE.Vector3(attr.getX(idx), attr.getY(idx), attr.getZ(idx));
        if (typeof lineObj.localToWorld === 'function') {
          lineObj.localToWorld(p);
        }
        // Keep generated fill geometry in the target scene's local space.
        // In compare mode the target scene is a translated group, so world-space
        // vertices would be shifted twice if we skip this conversion.
        if (scene && typeof scene.worldToLocal === 'function') {
          scene.worldToLocal(p);
        }
        if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
          points.push(p);
        }
      }
      return points;
    };

    const orientPolyline = (points: any[], startRef: any, endRef: any): any[] => {
      if (!Array.isArray(points) || points.length < 2 || !startRef || !endRef) return points || [];
      const d1 = points[0].distanceTo(startRef) + points[points.length - 1].distanceTo(endRef);
      const d2 = points[0].distanceTo(endRef) + points[points.length - 1].distanceTo(startRef);
      return d1 <= d2 ? points.slice() : points.slice().reverse();
    };

    const samplePolyline = (points: any[], count: number): any[] => {
      if (!Array.isArray(points) || points.length < 2 || count < 2) return [];
      const sampled: any[] = [];
      for (let s = 0; s < count; s++) {
        const t = s / (count - 1);
        const idx = Math.round(t * (points.length - 1));
        const p = points[Math.max(0, Math.min(idx, points.length - 1))];
        if (p) sampled.push(p.clone());
      }
      return sampled;
    };

    const surfaceOriginsZ: number[] = [];
    let zAccum = 0;
    for (let i = 0; i < opticalSystemRows.length; i++) {
      surfaceOriginsZ.push(zAccum);
      const tRaw = opticalSystemRows[i]?.thickness;
      const tNum = Number(tRaw);
      const tParsed = Number.isFinite(tNum) ? tNum : parseFloat(String(tRaw ?? ''));
      if (Number.isFinite(tParsed)) zAccum += tParsed;
    }

    const fillColor = 0x00ccff;
    const isWhiteLike = (value: number | null): boolean => {
      if (value === null || !Number.isFinite(value)) return false;
      const r = (value >> 16) & 0xff;
      const g = (value >> 8) & 0xff;
      const b = value & 0xff;
      return r >= 245 && g >= 245 && b >= 245;
    };
    const colorOverrides = loadSurfaceColorOverridesSafe();
    let createdCount = 0;

    const profileMap = new Map<number, any>();
    const connectionMap = new Map<number, any[]>();
    scene.traverse((child: any) => {
      const ud = child?.userData || {};
      if (ud.type === 'surfaceProfile' && ud.profileType === axis) {
        const surfaceIndex = Number(ud.surfaceIndex);
        if (Number.isFinite(surfaceIndex)) {
          profileMap.set(surfaceIndex, child);
        }
      }
      if (ud.type === 'connectionLine' && ud.direction === axis) {
        const surfaceIndex = Number(ud.surfaceIndex);
        if (Number.isFinite(surfaceIndex)) {
          if (!connectionMap.has(surfaceIndex)) connectionMap.set(surfaceIndex, []);
          connectionMap.get(surfaceIndex)!.push(child);
        }
      }
    });

    for (let i = 0; i < opticalSystemRows.length - 1; i++) {
      const front = opticalSystemRows[i];
      const back = opticalSystemRows[i + 1];
      if (!isLensInterval(front, back)) continue;

      // Skip thin-lens (Paraxial) intervals: front/back share the same z, which would
      // produce a degenerate fill mesh that visually covers the profile line.
      const frontIsThin = !!(front?._idealThinLens) || String(front?._blockType || '').toLowerCase() === 'paraxial' || String(front?._blockType || '').toLowerCase() === 'thinlens';
      const backIsThin = !!(back?._idealThinLens) || String(back?._blockType || '').toLowerCase() === 'paraxial' || String(back?._blockType || '').toLowerCase() === 'thinlens';
      if (frontIsThin || backIsThin) continue;

      const frontIndex = i + 1;
      const backIndex = i + 2;
      const frontLine = profileMap.get(frontIndex);
      const backLine = profileMap.get(backIndex);

      let frontPoints = frontLine ? readWorldPolylinePoints(frontLine) : [];
      let backPoints = backLine ? readWorldPolylinePoints(backLine) : [];

      let geometry: any = null;
      let frontNeg: any = null;
      let frontPos: any = null;
      let backNeg: any = null;
      let backPos: any = null;
      if (frontPoints.length >= 2 && backPoints.length >= 2) {
        const frontStart = frontPoints[0];
        const frontEnd = frontPoints[frontPoints.length - 1];
        const backStart = backPoints[0];
        const backEnd = backPoints[backPoints.length - 1];

        const forwardCost = frontStart.distanceToSquared(backStart) + frontEnd.distanceToSquared(backEnd);
        const reverseCost = frontStart.distanceToSquared(backEnd) + frontEnd.distanceToSquared(backStart);
        const alignedBack = orientPolyline(backPoints, frontStart, frontEnd);
        const backUsed = (forwardCost <= reverseCost) ? alignedBack : alignedBack.slice().reverse();

        frontNeg = frontPoints[0].clone();
        frontPos = frontPoints[frontPoints.length - 1].clone();
        backNeg = backUsed[0].clone();
        backPos = backUsed[backUsed.length - 1].clone();

        const sampleCount = Math.max(8, Math.min(48, Math.min(frontPoints.length, backUsed.length)));
        const sampledFront = samplePolyline(frontPoints, sampleCount);
        const sampledBack = samplePolyline(backUsed, sampleCount);

        if (sampledFront.length >= 2 && sampledBack.length >= 2 && sampledFront.length === sampledBack.length) {
          const vertexCount = sampledFront.length * 2;
          const positions = new Float32Array(vertexCount * 3);
          const triangles: number[] = [];

          for (let j = 0; j < sampledFront.length; j++) {
            const f = sampledFront[j];
            const b = sampledBack[j];
            const fi = j * 2;
            const bi = fi + 1;

            positions[fi * 3] = f.x;
            positions[fi * 3 + 1] = f.y;
            positions[fi * 3 + 2] = f.z;

            positions[bi * 3] = b.x;
            positions[bi * 3 + 1] = b.y;
            positions[bi * 3 + 2] = b.z;

            if (j < sampledFront.length - 1) {
              const a = fi;
              const bIdx = bi;
              const c = fi + 2;
              const d = bi + 2;
              triangles.push(a, bIdx, c);
              triangles.push(bIdx, d, c);
            }
          }

          if (triangles.length >= 3) {
            const indexArray = vertexCount > 65535 ? new Uint32Array(triangles) : new Uint16Array(triangles);
            geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
            geometry.computeVertexNormals();
          }
        }
      }

      if (!geometry) {
        const sd1 = getSemidia(front);
        const sd2 = getSemidia(back);
        if (!Number.isFinite(sd1) || !Number.isFinite(sd2) || (sd1 as number) <= 0 || (sd2 as number) <= 0) continue;

        const z1 = surfaceOriginsZ[i] ?? 0;
        const z2 = surfaceOriginsZ[i + 1] ?? z1;

        const positions = new Float32Array(12);
        if (axis === 'YZ') {
          positions.set([
            0, -(sd1 as number), z1,
            0, (sd1 as number), z1,
            0, -(sd2 as number), z2,
            0, (sd2 as number), z2
          ]);
        } else {
          positions.set([
            -(sd1 as number), 0, z1,
            (sd1 as number), 0, z1,
            -(sd2 as number), 0, z2,
            (sd2 as number), 0, z2
          ]);
        }

        const indices = new Uint16Array([0, 1, 2, 1, 3, 2]);
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();

        if (axis === 'YZ') {
          frontNeg = new THREE.Vector3(0, -(sd1 as number), z1);
          frontPos = new THREE.Vector3(0, (sd1 as number), z1);
          backNeg = new THREE.Vector3(0, -(sd2 as number), z2);
          backPos = new THREE.Vector3(0, (sd2 as number), z2);
        } else {
          frontNeg = new THREE.Vector3(-(sd1 as number), 0, z1);
          frontPos = new THREE.Vector3((sd1 as number), 0, z1);
          backNeg = new THREE.Vector3(-(sd2 as number), 0, z2);
          backPos = new THREE.Vector3((sd2 as number), 0, z2);
        }
      }

      const overrideKeys = surfaceColorKeysAll(front, i);
      let colorOverride: number | null = null;
      for (const key of overrideKeys) {
        const parsed = parseColorToInt(colorOverrides?.[key]);
        if (parsed !== null) {
          colorOverride = parsed;
          break;
        }
      }
      const lensColor = (colorOverride !== null && !isWhiteLike(colorOverride)) ? colorOverride : fillColor;

      const material = new THREE.MeshBasicMaterial({
        color: lensColor,
        transparent: true,
        opacity: 0.52,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 60000;
      mesh.userData = {
        type: 'renderWindowDirectFill',
        axis,
        intervalIndex: i,
        isDebugOverlay: true
      };
      scene.add(mesh);
      createdCount += 1;

      const axisCoord = (p: any) => axis === 'YZ' ? Number(p?.y) : Number(p?.x);
      const sideLines = (connectionMap.get(frontIndex) || [])
        .map((lineObj: any) => {
          const pts = readWorldPolylinePoints(lineObj);
          if (pts.length < 3) return null;
          const avg = pts.reduce((sum: number, p: any) => sum + axisCoord(p), 0) / pts.length;
          return { pts, avg };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.avg - b.avg);

      const addLSideFill = (linePts: any[], frontEnd: any, backEnd: any) => {
        if (!linePts || linePts.length < 3 || !frontEnd || !backEnd) return;
        const p0 = linePts[0];
        const p1 = linePts[Math.floor(linePts.length / 2)];
        const p2 = linePts[linePts.length - 1];

        const directCost = p0.distanceToSquared(frontEnd) + p2.distanceToSquared(backEnd);
        const reverseCost = p0.distanceToSquared(backEnd) + p2.distanceToSquared(frontEnd);

        const f = (directCost <= reverseCost) ? p0 : p2;
        const b = (directCost <= reverseCost) ? p2 : p0;
        const elbow = p1;

        if (!elbow) return;

        const sidePositions = new Float32Array([
          f.x, f.y, f.z,
          elbow.x, elbow.y, elbow.z,
          b.x, b.y, b.z
        ]);
        const sideGeometry = new THREE.BufferGeometry();
        sideGeometry.setAttribute('position', new THREE.BufferAttribute(sidePositions, 3));
        sideGeometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
        sideGeometry.computeVertexNormals();

        const sideMaterial = new THREE.MeshBasicMaterial({
          color: lensColor,
          transparent: true,
          opacity: 0.52,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false
        });
        const sideMesh = new THREE.Mesh(sideGeometry, sideMaterial);
        sideMesh.frustumCulled = false;
        sideMesh.renderOrder = 60001;
        sideMesh.userData = {
          type: 'renderWindowDirectFill',
          axis,
          intervalIndex: i,
          isEdgeLFill: true
        };
        scene.add(sideMesh);
      };

      if (sideLines.length >= 1) {
        addLSideFill(sideLines[0].pts, frontNeg, backNeg);
      }
      if (sideLines.length >= 2) {
        addLSideFill(sideLines[sideLines.length - 1].pts, frontPos, backPos);
      }
    }

    return createdCount;
  };

  const resolveRenderRedrawRayCountOverride = (options?: RenderRedrawOptions): number | undefined => {
    const explicitOverride = Number(options?.rayCountOverride);
    if (Number.isFinite(explicitOverride) && explicitOverride > 0) {
      return Math.max(1, Math.floor(explicitOverride));
    }
    if (options?.useLiveRayCount === false) {
      return undefined;
    }
    return getLiveRenderRayCount(renderRayCountRef.current);
  };

  const resolveQuickInitialRenderRayCount = (options?: RenderRedrawOptions): number | undefined => {
    const quickOverride = Number(options?.quickInitialRayCount);
    if (Number.isFinite(quickOverride) && quickOverride > 0) {
      return Math.max(1, Math.floor(quickOverride));
    }
    return undefined;
  };

  const clearRenderRedrawCaches = (): void => {
    const w = window as any;
    try { renderParaxialDataCache.clear(); } catch (_) {}
    try {
      if (typeof w.__cooptClearRenderRayTracingCaches === 'function') {
        w.__cooptClearRenderRayTracingCaches();
      }
    } catch (_) {}
  };

  const scheduleDeferredFullRenderPass = (requestId?: number): void => {
    if (renderDeferredFullPassTimerRef.current !== null) {
      window.clearTimeout(renderDeferredFullPassTimerRef.current);
      renderDeferredFullPassTimerRef.current = null;
    }
    renderDeferredFullPassTimerRef.current = window.setTimeout(() => {
      renderDeferredFullPassTimerRef.current = null;
      if (!isLatestRenderDrawRequest(requestId)) return;
      scheduleRenderRedraw(undefined, undefined, beginRenderDrawRequest(), { useLiveRayCount: true }).catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    }, 0);
  };

  const buildRenderSyncSignature = (rows: any[], redrawOptions?: RenderRedrawOptions): string => {
    const quickRayCount = resolveQuickInitialRenderRayCount(redrawOptions);
    return [
      renderViewModeRef.current,
      renderViewAxisRef.current,
      Number(quickRayCount || resolveRenderRedrawRayCountOverride(redrawOptions) || getLiveRenderRayCount(renderRayCountRef.current) || 0),
      buildRenderRowsSignature(rows),
    ].join('#');
  };

  const hydrateRenderRowsFromLatestSyncPayload = (): boolean => {
    const w = window as any;
    const hasActiveRows = Array.isArray(renderActiveRowsRef.current) && renderActiveRowsRef.current.length > 0;
    let rows: any[] = [];
    let objectRows: any[] = [];
    let systemConfig: any = null;
    let syncStamp = '';

    try {
      if (Array.isArray(w.__cooptPendingRenderRows) && w.__cooptPendingRenderRows.length > 0) {
        rows = w.__cooptPendingRenderRows;
      }
      if (Array.isArray(w.__cooptPendingRenderObjectRows) && w.__cooptPendingRenderObjectRows.length > 0) {
        objectRows = w.__cooptPendingRenderObjectRows;
      }
      if (w.__cooptPendingRenderSystemConfig && typeof w.__cooptPendingRenderSystemConfig === 'object') {
        systemConfig = w.__cooptPendingRenderSystemConfig;
      }
      syncStamp = String(w.__cooptPendingRenderSyncStamp ?? '').trim();
    } catch (_) {}

    if (rows.length === 0 && !hasActiveRows) {
      try {
        const raw = localStorage.getItem('coopt.renderSyncRequest');
        if (raw) {
          const payload = JSON.parse(raw);
          syncStamp = String(payload?.ts ?? payload?.token ?? '').trim();
          rows = Array.isArray(payload?.rows) ? payload.rows : [];
          objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : objectRows;
          systemConfig = payload?.systemConfig && typeof payload.systemConfig === 'object' ? payload.systemConfig : systemConfig;
        }
      } catch (_) {}
    }

    if (hasActiveRows && rows.length > 0) {
      const handledStamp = String(w.__cooptLastRenderSyncStamp ?? '').trim();
      if (!syncStamp || syncStamp === handledStamp) {
        return false;
      }
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return false;
    }

    renderActiveRowsRef.current = rows;
    renderPendingRowsRef.current = rows;
    renderNeedsVisibilityReplayRef.current = false;
    if (Array.isArray(objectRows)) {
      renderActiveObjectRowsRef.current = objectRows;
      renderPendingObjectRowsRef.current = objectRows;
    }
    if (systemConfig && typeof systemConfig === 'object') {
      try { w.__cooptPendingRenderSystemConfig = systemConfig; } catch (_) {}
    }
    try {
      w.__cooptPendingRenderSyncStamp = syncStamp || '';
    } catch (_) {}
    return true;
  };

  const drawCrossSectionView = async (axis: 'YZ' | 'XZ', requestId?: number, redrawOptions?: RenderRedrawOptions): Promise<boolean> => {
    const w = window as any;
    const timingStages: RenderTimingStage[] = [];
    const blockPerfBefore = readCooptPerfCounters();
    const quickInitialRayCount = resolveQuickInitialRenderRayCount(redrawOptions);
    const fullRayCount = resolveRenderRedrawRayCountOverride(redrawOptions);
    const effectiveRayCountOverride = quickInitialRayCount || fullRayCount;
    const shouldSkipRayGeneration = redrawOptions?.skipRayGeneration === true;
    const rustOriginsGlobal = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
    const hadOwnRustOriginsFlag = !!(rustOriginsGlobal && Object.prototype.hasOwnProperty.call(rustOriginsGlobal, '__COOPT_USE_RUST_SURFACE_ORIGINS'));
    const previousRustOriginsFlag = rustOriginsGlobal ? rustOriginsGlobal.__COOPT_USE_RUST_SURFACE_ORIGINS : undefined;
    if (rustOriginsGlobal) rustOriginsGlobal.__COOPT_USE_RUST_SURFACE_ORIGINS = true;
    let overrideRows: any[] = [];
    try {
      const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
      const hostWindow = getRenderHostWindow();
      const localOverride = g && Array.isArray(g.__cooptOpticalSystemRowsOverride) && g.__cooptOpticalSystemRowsOverride.length > 0
        ? g.__cooptOpticalSystemRowsOverride
        : null;
      const hostOverride = hostWindow && Array.isArray((hostWindow as any).__cooptOpticalSystemRowsOverride) && (hostWindow as any).__cooptOpticalSystemRowsOverride.length > 0
        ? (hostWindow as any).__cooptOpticalSystemRowsOverride
        : null;
      const resolvedOverride = localOverride ?? hostOverride ?? [];
      overrideRows = Array.isArray(resolvedOverride) ? resolvedOverride : [];
    } catch (_) {
      overrideRows = [];
    }

    try {
      const cm = w.ConfigurationManager;
      if (overrideRows.length === 0 && cm && typeof cm.loadActiveConfigurationToTables === 'function') {
        const startMs = performance.now();
        await Promise.resolve(cm.loadActiveConfigurationToTables({ applyToUI: true }));
        timingStages.push({ label: 'load', ms: performance.now() - startMs });
      }
    } catch (_) {}

    try {
      if (overrideRows.length === 0 && typeof w.initializeAllTables === 'function') {
        const startMs = performance.now();
        w.initializeAllTables();
        timingStages.push({ label: 'tables', ms: performance.now() - startMs });
      }
    } catch (_) {}

    ensureRenderCanvasAttached();

    const rowsStartMs = performance.now();
    const hostWindow = getRenderHostWindow();
    const compareEntries = overrideRows.length === 0 && renderCompareScope === 'all' ? getRenderCompareEntries(hostWindow) : [];
    const compareEnabled = overrideRows.length === 0 && compareEntries.length > 1;
    const activeCompareEntry = compareEntries.find((entry) => entry.isActive) || compareEntries[0] || null;

    let rows: any[] = overrideRows || activeCompareEntry?.rows || [];
    if (!rows.length) {
      try {
        if (typeof w.getOpticalSystemRows === 'function') {
          const r = w.getOpticalSystemRows(w.tableOpticalSystem);
          rows = Array.isArray(r) ? r : [];
        }
      } catch (_) {
        rows = [];
      }
    }
    timingStages.push({ label: 'rows', ms: performance.now() - rowsStartMs });

    if (!rows.length) {
      setRenderWindowStatus('No optical data');
      return false;
    }

    try {
      const scenePrepStartMs = performance.now();
      const sceneForDraw = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      const renderObjectRows = !compareEnabled ? getRenderObjectRows(hostWindow, rows) : [];
      const imageSemidiaWarning = !compareEnabled ? getRenderImageSemidiaWarning(rows, renderObjectRows) : null;
      const rowsWithDisplaySpacing = !compareEnabled ? applyRenderImageHeightDisplaySpacing(rows, renderObjectRows) : rows;
      const rowsForRender = !compareEnabled ? applyRenderImageSemidiaWarning(rowsWithDisplaySpacing, imageSemidiaWarning) : rows;
      renderImageSemidiaWarningRef.current = imageSemidiaWarning;
        let rayCollectMs = 0;
        let rayDrawMs = 0;
      if (sceneForDraw && typeof w.clearAllOpticalElements === 'function') {
        try { w.clearAllOpticalElements(sceneForDraw); } catch (_) {}
      }
      if (sceneForDraw) {
        try {
          const compareGroupsToRemove: any[] = [];
          const raysToRemove: any[] = [];
          sceneForDraw.traverse((child: any) => {
            if (child?.userData?.type === 'renderCompareGroup') {
              compareGroupsToRemove.push(child);
              return;
            }
            if (isRenderWindowOpticalArtifact(child)) {
              raysToRemove.push(child);
            }
          });
          [...new Set(compareGroupsToRemove)].forEach((group: any) => {
            try {
              group.traverse((child: any) => {
                if (child?.geometry) child.geometry.dispose();
                if (child?.material) {
                  if (Array.isArray(child.material)) child.material.forEach((m: any) => m.dispose());
                  else child.material.dispose();
                }
              });
            } catch (_) {}
            sceneForDraw.remove(group);
          });
          removeRenderWindowObjects(sceneForDraw, raysToRemove);
        } catch (_) {}
      }
      timingStages.push({ label: 'scene', ms: performance.now() - scenePrepStartMs });

      if (typeof w.drawOpticalSystemSurfaces === 'function' && sceneForDraw) {
        const surfacesStartMs = performance.now();
        if (compareEnabled) {
          const offsets = buildRenderCompareOffsets(compareEntries.length);
          const compareReferenceImageZ = resolveRenderCompareReferenceZ(compareEntries);
          for (let index = 0; index < compareEntries.length; index += 1) {
            const entry = compareEntries[index];
            const entryImageZ = renderCompareAlignReference === 'image' ? resolveRenderCompareImageZ(entry.rows) : null;
            const imageAlignZOffset = (Number.isFinite(Number(compareReferenceImageZ)) && Number.isFinite(Number(entryImageZ)))
              ? Number(compareReferenceImageZ) - Number(entryImageZ)
              : 0;
            const group = new THREE.Group();
            group.name = `render-compare-${entry.configId}`;
            group.userData = {
              type: 'renderCompareGroup',
              configId: entry.configId,
              configName: entry.name,
              compareOffsetMm: offsets[index] || 0,
              compareAlignReference: renderCompareAlignReference,
              compareImageAlignZOffsetMm: imageAlignZOffset,
              compareAxis: axis,
            };
            applyRenderCompareTransform(group, axis, offsets[index] || 0, imageAlignZOffset);
            sceneForDraw.add(group);
            w.drawOpticalSystemSurfaces({
              opticalSystemData: entry.rows,
              scene: group,
              crossSectionOnly: true,
              showSurfaceOrigins: false,
              showSemidiaRing: false,
              showMirrorBackText: false,
              showDesignIntentLabels: renderShowDesignIntentLabels,
              showPrincipalPointLabels: renderShowPrincipalPointLabels,
              showSurfaceNumberLabels: renderShowSurfaceNumberLabels,
              crossSectionDirection: axis,
              crossSectionCenterOffset: 0
            });

            try {
              applyRenderWindowDirectCrossFill(group, axis, entry.rows);
            } catch (fillErr) {
              console.warn('[RenderWindow] Compare cross-section lens fill failed:', fillErr);
            }

            const collectStartMs = performance.now();
            const compareRays = await collectLegacyCrossRays(entry.rows, axis, entry.objectRows, {
              rayCountOverride: effectiveRayCountOverride,
            });
            rayCollectMs += performance.now() - collectStartMs;
            if (compareRays.length > 0 && typeof w.drawCrossBeamRays === 'function') {
              const drawStartMs = performance.now();
              w.drawCrossBeamRays(compareRays, group);
              rayDrawMs += performance.now() - drawStartMs;
            }
          }
        } else {
          w.drawOpticalSystemSurfaces({
            opticalSystemData: rowsForRender,
            scene: sceneForDraw,
            crossSectionOnly: true,
            showSurfaceOrigins: false,
            showSemidiaRing: false,
            showMirrorBackText: false,
            showDesignIntentLabels: renderShowDesignIntentLabels,
            showPrincipalPointLabels: renderShowPrincipalPointLabels,
            showSurfaceNumberLabels: renderShowSurfaceNumberLabels,
            crossSectionDirection: axis,
            crossSectionCenterOffset: 0
          });
        }
        timingStages.push({ label: 'surfaces', ms: performance.now() - surfacesStartMs });
      }

      if (sceneForDraw) {
        try {
          sceneForDraw.traverse((child: any) => {
            const ud = child?.userData || {};
            if (ud.type === 'surfaceProfile' && (ud.profileType === 'YZ' || ud.profileType === 'XZ')) {
              child.visible = ud.profileType === axis;
            }
            if (ud.type === 'connectionLine' && (ud.direction === 'YZ' || ud.direction === 'XZ')) {
              child.visible = ud.direction === axis;
            }
          });
        } catch (_) {}
      }

      if (!compareEnabled && !shouldSkipRayGeneration) {
        const collectStartMs = performance.now();
        const legacyCrossRays = await collectLegacyCrossRays(
          rowsForRender,
          axis,
          Array.isArray(renderObjectRows) && renderObjectRows.length > 0 ? renderObjectRows : undefined,
          {
            rayCountOverride: effectiveRayCountOverride,
          }
        );
        const filteredCrossRays = legacyCrossRays;
        rayCollectMs += performance.now() - collectStartMs;
        if (!isLatestRenderDrawRequest(requestId)) {
          return false;
        }
        try {
          const showDrawCrossCoordinateReport = (w as any).__cooptShowDrawCrossCoordinateReport;
          if (typeof showDrawCrossCoordinateReport === 'function') {
            const imageSurfaceIndex = rowsForRender.findIndex((row: any) => {
              const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
              const normalized = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
              return normalized === 'image' || normalized.startsWith('image');
            });
            const targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, rows.length - 1);
            showDrawCrossCoordinateReport(
              filteredCrossRays,
              rowsForRender,
              Array.isArray(renderObjectRows) ? renderObjectRows : [],
              targetSurfaceIndex,
              window
            );
          }
        } catch (_) {}
        try {
          const classification = (w as any).__COOPT_LAST_RENDER_IMAGEHEIGHT_CLASSIFICATION;
          if (classification && hasImageHeightRows) {
            const rowSummary = Array.isArray(classification.rows)
              ? classification.rows.map((entry: any) => {
                  const objectIndex = Number.isFinite(Number(entry?.objectIndex)) ? Number(entry.objectIndex) : '?';
                  const bucket = String(entry?.bucket ?? 'unknown');
                  const position = String(entry?.position ?? '');
                  const originalPosition = String(entry?.originalPosition ?? '');
                  return `obj${objectIndex + 1}:${bucket}:${position}${originalPosition ? `/${originalPosition}` : ''}`;
                }).join(' | ')
              : 'rows=n/a';
            const objectDebugSummary = Array.isArray(classification.objectDebug)
              ? classification.objectDebug.map((entry: any) => {
                  const objectIndex = Number.isFinite(Number(entry?.objectIndex)) ? Number(entry.objectIndex) : '?';
                  const residualRaw = entry?.chiefResidualMm;
                  const residualNumber = typeof residualRaw === 'number' ? residualRaw : NaN;
                  const residualLabel = Number.isFinite(residualNumber)
                    ? ` r=${residualNumber.toFixed(4)}`
                    : ' r=-';
                  return `obj${objectIndex + 1}:${Number(entry?.kept) || 0}/${Number(entry?.starts) || 0}/${Number(entry?.requested) || 0}${residualLabel}`;
                }).join(' | ')
              : 'debug=n/a';
            setRenderVisibleDebug([
              `[ImageHeight ${axis}] req=${Number(classification.effectiveRayCount) || 0} exactRows=${Number(classification.directExactImageHeightCount) || 0} legacyRows=${Number(classification.legacyCrossBeamCount) || 0} exactRays=${Number(classification.exactImageHeightRayCount) || 0}`,
              objectDebugSummary,
              rowSummary,
            ].join('\n'));
          } else {
            setRenderVisibleDebug('');
          }
        } catch (_) {
          setRenderVisibleDebug('');
        }
        if (filteredCrossRays.length > 0 && typeof w.drawCrossBeamRays === 'function') {
          const drawStartMs = performance.now();
          w.drawCrossBeamRays(filteredCrossRays, sceneForDraw);
          rayDrawMs += performance.now() - drawStartMs;
        }
        try {
          applyRenderWindowDirectCrossFill(sceneForDraw, axis, rowsForRender);
        } catch (fillErr) {
          console.warn('[RenderWindow] Cross-section lens fill failed:', fillErr);
        }

      }
      if (rayCollectMs > 0) timingStages.push({ label: 'rayCollect', ms: rayCollectMs });
      if (rayDrawMs > 0) timingStages.push({ label: 'rayDraw', ms: rayDrawMs });

      const cameraStartMs = performance.now();
      if (axis === 'XZ' && typeof w.setCameraForXZCrossSection === 'function') {
        w.setCameraForXZCrossSection({ includeRayStartMargin: true, storeDrawCrossBounds: true });
      } else if (axis === 'YZ' && typeof w.setCameraForYZCrossSection === 'function') {
        w.setCameraForYZCrossSection({ includeRayStartMargin: true, storeDrawCrossBounds: true });
      }
      timingStages.push({ label: 'camera', ms: performance.now() - cameraStartMs });

      if (!isLatestRenderDrawRequest(requestId)) {
        return false;
      }

      syncOrthoBoundsToRendererAspect();
      const renderStartMs = performance.now();
      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
      if (renderer && scene && camera && typeof renderer.render === 'function') {
        renderer.render(scene, camera);
      }
      timingStages.push({ label: 'render', ms: performance.now() - renderStartMs });
      scheduleRenderScaleOverlayUpdate();

      if (!isLatestRenderDrawRequest(requestId)) {
        return false;
      }
      markRenderViewportReady();
      publishRenderTiming(compareEnabled ? `Ready (${axis} compare)` : `Ready (${axis} section)`, `cross-${axis}`, timingStages, blockPerfBefore);
      if (redrawOptions?.scheduleFullRayPass === true && (shouldSkipRayGeneration || Number(fullRayCount || 0) > Number(effectiveRayCountOverride || 0))) {
        scheduleDeferredFullRenderPass(requestId);
      }
      return true;
    } catch (err) {
      console.error('[RenderWindow] Cross-section draw failed:', err);
      setRenderWindowStatus('Draw failed');
      return false;
    } finally {
      if (rustOriginsGlobal) {
        if (hadOwnRustOriginsFlag) {
          rustOriginsGlobal.__COOPT_USE_RUST_SURFACE_ORIGINS = previousRustOriginsFlag;
        } else {
          try { delete rustOriginsGlobal.__COOPT_USE_RUST_SURFACE_ORIGINS; } catch (_) {
            rustOriginsGlobal.__COOPT_USE_RUST_SURFACE_ORIGINS = previousRustOriginsFlag;
          }
        }
      }
    }
  };

  const drawRender3DView = async (startupStages?: RenderTimingStage[], requestId?: number, redrawOptions?: RenderRedrawOptions): Promise<boolean> => {
    const w = window as any;
    const hostWindow = getRenderHostWindow();
    const timingStages: RenderTimingStage[] = Array.isArray(startupStages) ? [...startupStages] : [];
    const blockPerfBefore = readCooptPerfCounters();
    const quickInitialRayCount = resolveQuickInitialRenderRayCount(redrawOptions);
    const fullRayCount = resolveRenderRedrawRayCountOverride(redrawOptions);
    const effectiveRayCountOverride = quickInitialRayCount || fullRayCount;
    const shouldSkipRayGeneration = redrawOptions?.skipRayGeneration === true;
    const rustOriginsGlobal = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
    const hadOwnRustOriginsFlag = !!(rustOriginsGlobal && Object.prototype.hasOwnProperty.call(rustOriginsGlobal, '__COOPT_USE_RUST_SURFACE_ORIGINS'));
    const previousRustOriginsFlag = rustOriginsGlobal ? rustOriginsGlobal.__COOPT_USE_RUST_SURFACE_ORIGINS : undefined;
    if (rustOriginsGlobal) rustOriginsGlobal.__COOPT_USE_RUST_SURFACE_ORIGINS = true;

    try {
      setRenderVisibleDebug('');
      ensureRenderCanvasAttached();

      let rows: any[] = [];
      let hasOverrideRows = false;
      const rowsStartMs = performance.now();
      try {
        const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        const overrideRows = g && Array.isArray(g.__cooptOpticalSystemRowsOverride) && g.__cooptOpticalSystemRowsOverride.length > 0
          ? g.__cooptOpticalSystemRowsOverride
          : null;
        if (overrideRows) {
          rows = overrideRows;
          hasOverrideRows = true;
        }
      } catch (_) {
        rows = [];
        hasOverrideRows = false;
      }
      timingStages.push({ label: 'rows', ms: performance.now() - rowsStartMs });
      if (Array.isArray(startupStages)) updateRenderStartupBreakdown(timingStages);
      try {
        if (!rows.length && typeof w.getOpticalSystemRows === 'function') {
          const r = w.getOpticalSystemRows(w.tableOpticalSystem);
          rows = Array.isArray(r) ? r : [];
        }
      } catch (_) {
        rows = [];
      }

      if (!rows.length) {
        setRenderWindowStatus('No optical data');
        return false;
      }

      const renderObjectRows = getRenderObjectRows(hostWindow, rows);
      const imageSemidiaWarning = getRenderImageSemidiaWarning(rows, renderObjectRows);
      const rowsWithDisplaySpacing = applyRenderImageHeightDisplaySpacing(rows, renderObjectRows);
      const rowsForRender = applyRenderImageSemidiaWarning(rowsWithDisplaySpacing, imageSemidiaWarning);
      renderImageSemidiaWarningRef.current = imageSemidiaWarning;

      const sceneForDraw = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      if (!sceneForDraw) {
        setRenderWindowStatus('Scene unavailable');
        return false;
      }

      const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
      const isZoomPreviewActive = !!g?.__cooptZoomPreviewActive;
      const allowFastZoomPreview = false;
      const isInitial3DPass = !render3DPrevRowsRef.current && Array.isArray(startupStages) && startupStages.length > 0;
      const prevRows = render3DPrevRowsRef.current;
      const prevOrigins = render3DPrevOriginsRef.current;
      let nextSurfaceOrigins: any[] | null = null;
      if (isZoomPreviewActive && allowFastZoomPreview) {
        const previewStartMs = performance.now();
        try {
          nextSurfaceOrigins = withRustRenderSurfaceOrigins(() => calculateSurfaceOrigins(rowsForRender));
        } catch (_) {
          nextSurfaceOrigins = null;
        }
        if (
          Array.isArray(nextSurfaceOrigins) &&
          tryFastTranslateRender3DPreview(
            sceneForDraw,
            prevRows || [],
            rows,
            prevOrigins || [],
            nextSurfaceOrigins,
            renderShowDesignIntentLabels || renderShowPrincipalPointLabels || renderShowSurfaceNumberLabels,
          )
        ) {
          const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
          const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
          const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
          if (renderer && scene && camera && typeof renderer.render === 'function') {
            renderer.render(scene, camera);
          }
          render3DPrevRowsRef.current = rows;
          render3DPrevOriginsRef.current = nextSurfaceOrigins;
          scheduleRenderScaleOverlayUpdate();
          markRenderViewportReady();
          timingStages.push({ label: 'preview', ms: performance.now() - previewStartMs });
          publishRenderTiming('Ready (3D preview)', '3d-preview', timingStages, blockPerfBefore);
          return true;
        }
        timingStages.push({ label: 'preview', ms: performance.now() - previewStartMs });
      }

      const scenePrepStartMs = performance.now();
  if (Array.isArray(startupStages)) updateRenderStartupBreakdown(timingStages);
      if (typeof w.clearAllOpticalElements === 'function') {
        try { w.clearAllOpticalElements(sceneForDraw); } catch (_) {}
      }

      try {
        const objectsToRemove: any[] = [];
        sceneForDraw.traverse((child: any) => {
          if (child?.userData?.type === 'renderCompareGroup' || isRenderWindowOpticalArtifact(child)) {
            objectsToRemove.push(child);
          }
        });
        removeRenderWindowObjects(sceneForDraw, objectsToRemove);
      } catch (_) {}
      timingStages.push({ label: 'scene', ms: performance.now() - scenePrepStartMs });

      if (typeof w.drawOpticalSystemSurfaces === 'function') {
        if (!Array.isArray(nextSurfaceOrigins)) {
          try {
            nextSurfaceOrigins = withRustRenderSurfaceOrigins(() => calculateSurfaceOrigins(rowsForRender));
          } catch (_) {
            nextSurfaceOrigins = null;
          }
        }
        const surfacesStartMs = performance.now();
        w.drawOpticalSystemSurfaces({
          opticalSystemData: rowsForRender,
          surfaceOrigins: nextSurfaceOrigins,
          scene: sceneForDraw,
          crossSectionOnly: false,
          showSurfaceOrigins: false,
          showSemidiaRing: true,
          showMirrorBackText: false,
          showDesignIntentLabels: renderShowDesignIntentLabels,
          showPrincipalPointLabels: renderShowPrincipalPointLabels,
          showSurfaceNumberLabels: renderShowSurfaceNumberLabels,
          surfaceMeshSegments: RENDER_3D_SURFACE_MESH_SEGMENTS,
          toricMeshSegments: RENDER_3D_TORIC_MESH_SEGMENTS,
          crossSectionDirection: 'YZ',
          crossSectionCenterOffset: 0
        });
        timingStages.push({ label: 'surfaces', ms: performance.now() - surfacesStartMs });
        if (Array.isArray(startupStages)) updateRenderStartupBreakdown(timingStages);
      }

      if (!shouldSkipRayGeneration) {
        const rayCollectStartMs = performance.now();
        const legacyCrossRays = await collectLegacyCrossRays(
          rowsForRender,
          'BOTH',
          Array.isArray(renderObjectRows) && renderObjectRows.length > 0 ? renderObjectRows : undefined,
          {
            rayCountOverride: effectiveRayCountOverride,
          }
        );
        timingStages.push({ label: 'rayCollect', ms: performance.now() - rayCollectStartMs });
        if (Array.isArray(startupStages)) updateRenderStartupBreakdown(timingStages);
        if (!isLatestRenderDrawRequest(requestId)) {
          return false;
        }
        if (legacyCrossRays.length > 0 && typeof w.drawCrossBeamRays === 'function') {
          const rayDrawStartMs = performance.now();
          w.drawCrossBeamRays(legacyCrossRays, sceneForDraw);
          timingStages.push({ label: 'rayDraw', ms: performance.now() - rayDrawStartMs });
          if (Array.isArray(startupStages)) updateRenderStartupBreakdown(timingStages);
        }
      }

      try {
        const cameraStartMs = performance.now();
        // Calculate actual bounds of drawn rays before adjusting camera
        const rayBoundsForCamera = { minY: Infinity, maxY: -Infinity };
        if (sceneForDraw) {
          sceneForDraw.traverse((child: any) => {
            if (child?.userData?.rayType === 'crossBeam' && child.geometry) {
              const positions = child.geometry.attributes?.position;
              const posArray = positions?.array as ArrayLike<number> | undefined;
              if (posArray && typeof posArray.length === 'number' && posArray.length >= 2) {
                for (let i = 1; i < posArray.length; i += 3) {
                  const y = posArray[i];
                  if (Number.isFinite(y)) {
                    rayBoundsForCamera.minY = Math.min(rayBoundsForCamera.minY, y);
                    rayBoundsForCamera.maxY = Math.max(rayBoundsForCamera.maxY, y);
                  }
                }
              }
            }
          });
        }
        
        const cameraBoundsOverride = (Number.isFinite(rayBoundsForCamera.minY) && Number.isFinite(rayBoundsForCamera.maxY))
          ? { minY: rayBoundsForCamera.minY, maxY: rayBoundsForCamera.maxY }
          : null;
        
        if (typeof w.setCameraForYZCrossSection === 'function') {
          w.setCameraForYZCrossSection({ includeRayStartMargin: true, storeDrawCrossBounds: true, cameraBoundsOverride });
        } else if (typeof w.fitCameraToScene === 'function') {
          w.fitCameraToScene();
        } else if (typeof w.adjustCameraView === 'function') {
          const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
          const controls = w.controls || (typeof w.getControls === 'function' ? w.getControls() : null);
          const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
          w.adjustCameraView(sceneForDraw, camera, controls, renderer);
        }
        timingStages.push({ label: 'camera', ms: performance.now() - cameraStartMs });
        if (Array.isArray(startupStages)) updateRenderStartupBreakdown(timingStages);
      } catch (_) {}

      if (!isLatestRenderDrawRequest(requestId)) {
        return false;
      }

      const renderStartMs = performance.now();
      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
      if (renderer && scene && camera && typeof renderer.render === 'function') {
        renderer.render(scene, camera);
      }
      timingStages.push({ label: 'render', ms: performance.now() - renderStartMs });
      if (Array.isArray(startupStages)) updateRenderStartupBreakdown(timingStages);
      render3DPrevRowsRef.current = rows;
      render3DPrevOriginsRef.current = nextSurfaceOrigins;
      scheduleRenderScaleOverlayUpdate();

      if (!isLatestRenderDrawRequest(requestId)) {
        return false;
      }
      markRenderViewportReady();
      publishRenderTiming('Ready (3D)', '3d', timingStages, blockPerfBefore);
      if (redrawOptions?.scheduleFullRayPass === true && (shouldSkipRayGeneration || Number(fullRayCount || 0) > Number(effectiveRayCountOverride || 0))) {
        scheduleDeferredFullRenderPass(requestId);
      }
      return true;
    } catch (err) {
      console.error('[RenderWindow] 3D draw failed:', err);
      setRenderWindowStatus('Draw failed');
      return false;
    } finally {
      if (rustOriginsGlobal) {
        if (hadOwnRustOriginsFlag) {
          rustOriginsGlobal.__COOPT_USE_RUST_SURFACE_ORIGINS = previousRustOriginsFlag;
        } else {
          try { delete rustOriginsGlobal.__COOPT_USE_RUST_SURFACE_ORIGINS; } catch (_) {
            rustOriginsGlobal.__COOPT_USE_RUST_SURFACE_ORIGINS = previousRustOriginsFlag;
          }
        }
      }
    }
  };

  const refreshRenderLensTargets = (rowsMaybe?: any[]): RenderLensColorTarget[] => {
    let rows = Array.isArray(rowsMaybe) ? rowsMaybe : [];
    if (!rows.length) {
      try {
        const w = window as any;
        if (typeof w.getOpticalSystemRows === 'function') {
          const fetched = w.getOpticalSystemRows(w.tableOpticalSystem);
          rows = Array.isArray(fetched) ? fetched : [];
        }
      } catch (_) {
        rows = [];
      }
    }
    const targets = buildRenderLensColorTargets(rows);
    setRenderLensColorTargets(targets);
    return targets;
  };

  const updateRenderScaleOverlay = () => {
    try {
      const w = window as any;
      const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      if (!camera?.isOrthographicCamera || !renderer) {
        setRenderScaleLabel((prev) => prev === 'Scale unavailable' ? prev : 'Scale unavailable');
        setRenderScaleBarWidthPx(RENDER_SCALE_BAR_TARGET_WIDTH_PX);
        return;
      }

      const widthPx = Math.max(
        1,
        Number(renderer?.domElement?.clientWidth) || 0,
        Number(renderer?.domElement?.width) || 0
      );
      const baseWorldWidth = Math.abs((Number(camera.right) || 0) - (Number(camera.left) || 0));
      const zoom = Math.max(0.0001, Number(camera.zoom) || 1);
      const worldWidth = baseWorldWidth / zoom;
      if (!Number.isFinite(worldWidth) || worldWidth <= 0 || widthPx <= 0) {
        setRenderScaleLabel((prev) => prev === 'Scale unavailable' ? prev : 'Scale unavailable');
        setRenderScaleBarWidthPx(RENDER_SCALE_BAR_TARGET_WIDTH_PX);
        return;
      }

      const mmPerPixel = worldWidth / widthPx;
      const scaleInfo = chooseRenderScaleBar(mmPerPixel);
      setRenderScaleLabel((prev) => prev === scaleInfo.label ? prev : scaleInfo.label);
      setRenderScaleBarWidthPx((prev) => Math.abs(prev - scaleInfo.widthPx) < 0.5 ? prev : scaleInfo.widthPx);
    } catch (_) {
      setRenderScaleLabel((prev) => prev === 'Scale unavailable' ? prev : 'Scale unavailable');
      setRenderScaleBarWidthPx(RENDER_SCALE_BAR_TARGET_WIDTH_PX);
    }
  };

  const scheduleRenderScaleOverlayUpdate = () => {
    try {
      if (renderScaleRafRef.current !== null) {
        cancelAnimationFrame(renderScaleRafRef.current);
      }
      renderScaleRafRef.current = requestAnimationFrame(() => {
        renderScaleRafRef.current = null;
        updateRenderScaleOverlay();
      });
    } catch (_) {
      updateRenderScaleOverlay();
    }
  };

  const publishRenderTiming = (
    baseStatus: string,
    mode: string,
    stages: RenderTimingStage[],
    blockPerfBefore: Record<string, CooptPerfCounter>
  ) => {
    const blockPerf = diffCooptPerfCounters(blockPerfBefore, BLOCK_PERF_KEYS);
    const summary = formatRenderTimingSummary(stages, blockPerf);
    const detail = { mode, summary, stages, blockPerf };
    renderLastTimingRef.current = detail;
    try {
      (globalThis as any).__cooptLastRenderTiming = detail;
    } catch (_) {}
    setRenderWindowStatus(formatRenderWindowStatus(baseStatus, renderImageSemidiaWarningRef.current));
  };

  const beginRenderDrawRequest = (): number => {
    renderDrawRequestSeqRef.current += 1;
    return renderDrawRequestSeqRef.current;
  };

  const isLatestRenderDrawRequest = (requestId?: number): boolean => {
    if (!Number.isFinite(Number(requestId))) return true;
    return Number(requestId) === renderDrawRequestSeqRef.current;
  };

  const setRenderVisibleDebug = (_text: string) => {
    try {
      const doc = window.document;
      const existingBanner = doc.getElementById('coopt-drawcross-debug-banner');
      if (existingBanner) existingBanner.remove();
    } catch (_) {}
  };

  const markRenderViewportReady = (): void => {
    if (!isRenderWindowMode) return;
    setRenderStartupBreakdown('');
    setRenderViewportVisible(true);
  };

  const updateRenderStartupBreakdown = (stages: RenderTimingStage[]): void => {
    if (!isRenderWindowMode) return;
    setRenderStartupBreakdown(formatRenderTimingSummary(stages, []));
  };

  const redrawCurrentRenderView = async (
    modeOverride?: '3D' | 'XZ' | 'YZ',
    axisOverride?: 'YZ' | 'XZ',
    requestId?: number,
    redrawOptions?: RenderRedrawOptions,
  ) => {
    const effectiveRequestId = Number.isFinite(Number(requestId))
      ? Number(requestId)
      : beginRenderDrawRequest();
    const nextMode = modeOverride ?? renderViewModeRef.current;
    const nextAxis = (axisOverride ?? renderViewAxisRef.current) === 'XZ' ? 'XZ' : 'YZ';
    const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
    const hasRowsOverride = g && Array.isArray(g.__cooptOpticalSystemRowsOverride) && g.__cooptOpticalSystemRowsOverride.length > 0;
    const shouldApplyActiveRows = !hasRowsOverride && Array.isArray(renderActiveRowsRef.current) && renderActiveRowsRef.current.length > 0;
    const prevRowsOverride = g ? g.__cooptOpticalSystemRowsOverride : undefined;
    const prevObjectRowsOverride = g ? g.__cooptRenderObjectRowsOverride : undefined;
    if (g && shouldApplyActiveRows) {
      g.__cooptOpticalSystemRowsOverride = renderActiveRowsRef.current;
      if (Array.isArray(renderActiveObjectRowsRef.current)) {
        g.__cooptRenderObjectRowsOverride = renderActiveObjectRowsRef.current;
      }
    }
    try {
      if (nextMode === '3D') {
        await drawRender3DView(undefined, effectiveRequestId, redrawOptions);
        return;
      }
      await drawCrossSectionView(nextAxis, effectiveRequestId, redrawOptions);
    } finally {
      if (g && shouldApplyActiveRows) {
        g.__cooptOpticalSystemRowsOverride = prevRowsOverride;
        g.__cooptRenderObjectRowsOverride = prevObjectRowsOverride;
      }
    }
  };

  const scheduleRenderRedraw = (
    modeOverride?: '3D' | 'XZ' | 'YZ',
    axisOverride?: 'YZ' | 'XZ',
    requestId?: number,
    redrawOptions?: RenderRedrawOptions,
  ): Promise<void> => {
    renderScheduledRedrawArgsRef.current = { modeOverride, axisOverride, requestId, redrawOptions };
    if (!renderScheduledRedrawPromiseRef.current) {
      let resolvePromise!: () => void;
      let rejectPromise!: (reason?: any) => void;
      const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      renderScheduledRedrawPromiseRef.current = { promise, resolve: resolvePromise, reject: rejectPromise };
    }
    if (renderScheduledRedrawRafRef.current !== null) {
      return renderScheduledRedrawPromiseRef.current.promise;
    }
    renderScheduledRedrawRafRef.current = window.requestAnimationFrame(() => {
      renderScheduledRedrawRafRef.current = null;
      const pendingArgs = renderScheduledRedrawArgsRef.current;
      renderScheduledRedrawArgsRef.current = null;
      const pendingPromise = renderScheduledRedrawPromiseRef.current;
      renderScheduledRedrawPromiseRef.current = null;
      void redrawCurrentRenderView(
        pendingArgs?.modeOverride,
        pendingArgs?.axisOverride,
        pendingArgs?.requestId,
        pendingArgs?.redrawOptions,
      ).then(() => {
        pendingPromise?.resolve();
      }).catch((error) => {
        pendingPromise?.reject(error);
      });
    });
    return renderScheduledRedrawPromiseRef.current.promise;
  };

  useEffect(() => {
    if (!isRenderWindowMode) return;
    try {
      localStorage.setItem(RENDER_SHOW_LABELS_KEY, renderShowDesignIntentLabels ? 'true' : 'false');
    } catch (_) {}
    scheduleRenderRedraw().catch(() => {
      setRenderWindowStatus('Draw failed');
    });
  }, [renderShowDesignIntentLabels]);

  useEffect(() => {
    if (!isRenderWindowMode) return;
    try {
      localStorage.setItem(RENDER_SHOW_PRINCIPAL_POINTS_KEY, renderShowPrincipalPointLabels ? 'true' : 'false');
    } catch (_) {}
    scheduleRenderRedraw().catch(() => {
      setRenderWindowStatus('Draw failed');
    });
  }, [renderShowPrincipalPointLabels]);

  useEffect(() => {
    if (!isRenderWindowMode) return;
    try {
      localStorage.setItem(RENDER_SHOW_SURFACE_NUMBERS_KEY, renderShowSurfaceNumberLabels ? 'true' : 'false');
    } catch (_) {}
    scheduleRenderRedraw().catch(() => {
      setRenderWindowStatus('Draw failed');
    });
  }, [renderShowSurfaceNumberLabels]);

  useEffect(() => {
    if (!isRenderWindowMode) return;
    scheduleRenderRedraw().catch(() => {
      setRenderWindowStatus('Draw failed');
    });
  }, [isRenderWindowMode, renderCompareScope, renderCompareOffsetDirection, renderCompareOffsetStepMm, renderCompareAlignReference]);

  useEffect(() => {
    if (!isRenderWindowMode) return;
    if (renderRayCountDebounceRef.current !== null) {
      clearTimeout(renderRayCountDebounceRef.current);
      renderRayCountDebounceRef.current = null;
    }
    clearRenderRedrawCaches();
    const requestId = beginRenderDrawRequest();
    renderRayCountDebounceRef.current = window.setTimeout(() => {
      renderRayCountDebounceRef.current = null;
      scheduleRenderRedraw(undefined, undefined, requestId, {
        useLiveRayCount: false,
        rayCountOverride: renderRayCountRef.current,
      }).catch(() => {
        if (isLatestRenderDrawRequest(requestId)) {
          setRenderWindowStatus('Draw failed');
        }
      });
    }, 180);
    return () => {
      if (renderRayCountDebounceRef.current !== null) {
        clearTimeout(renderRayCountDebounceRef.current);
        renderRayCountDebounceRef.current = null;
      }
    };
  }, [renderRayCount]);

  useEffect(() => {
    return () => {
      if (renderRayCountDebounceRef.current !== null) {
        clearTimeout(renderRayCountDebounceRef.current);
        renderRayCountDebounceRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isRenderWindowMode) return;

    let boundControls: any = null;
    const onViewChange = () => {
      scheduleRenderScaleOverlayUpdate();
    };
    const bindControls = () => {
      try {
        const w = window as any;
        const controls = w.controls || (typeof w.getControls === 'function' ? w.getControls() : null);
        if (controls === boundControls) return;
        if (boundControls && typeof boundControls.removeEventListener === 'function') {
          boundControls.removeEventListener('change', onViewChange);
        }
        boundControls = controls;
        if (boundControls && typeof boundControls.addEventListener === 'function') {
          boundControls.addEventListener('change', onViewChange);
        }
      } catch (_) {}
    };

    bindControls();
    const rebindTimer = window.setInterval(bindControls, 800);
    window.addEventListener('resize', onViewChange);
    window.addEventListener('wheel', onViewChange, { passive: true });
    scheduleRenderScaleOverlayUpdate();

    return () => {
      try { window.clearInterval(rebindTimer); } catch (_) {}
      try { window.removeEventListener('resize', onViewChange); } catch (_) {}
      try { window.removeEventListener('wheel', onViewChange as EventListener); } catch (_) {}
      try {
        if (boundControls && typeof boundControls.removeEventListener === 'function') {
          boundControls.removeEventListener('change', onViewChange);
        }
      } catch (_) {}
      try {
        if (renderScaleRafRef.current !== null) {
          cancelAnimationFrame(renderScaleRafRef.current);
          renderScaleRafRef.current = null;
        }
      } catch (_) {}
    };
  }, [isRenderWindowMode, renderViewMode, renderViewAxis]);

  useEffect(() => {
    if (!isRenderWindowMode) return;
    const w = window as any;
    const shouldDeferRenderRedrawWhileInactive = () => {
      try {
        if (document.visibilityState === 'hidden') return true;
      } catch (_) {}
      return false;
    };
    w.__cooptRenderWindowRedraw = async (rows?: any[], syncStamp?: string, objectRows?: any[]) => {
      const normalizedSyncStamp = String(syncStamp ?? '').trim();
      let appliedPendingSystemConfig = false;
      try {
        const pendingSystemConfig = w.__cooptPendingRenderSystemConfig;
        if (pendingSystemConfig && typeof pendingSystemConfig === 'object') {
          let clonedPendingSystemConfig: any = pendingSystemConfig;
          try {
            clonedPendingSystemConfig = JSON.parse(JSON.stringify(pendingSystemConfig));
          } catch (_) {}
          try {
            w.__cooptSystemConfig = clonedPendingSystemConfig;
            w.__cooptPreferRuntimeSystemConfig = true;
          } catch (_) {}
          appliedPendingSystemConfig = true;
        }
      } catch (_) {
      } finally {
        try { delete w.__cooptPendingRenderSystemConfig; } catch (_) {}
      }
      if (Array.isArray(objectRows)) {
        renderActiveObjectRowsRef.current = objectRows.length > 0 ? objectRows : [];
        renderPendingObjectRowsRef.current = objectRows.length > 0 ? objectRows : [];
      }
      if (Array.isArray(rows) && rows.length > 0) {
        renderActiveRowsRef.current = rows;
        if (normalizedSyncStamp) {
          renderPendingSyncStampRef.current = normalizedSyncStamp;
        }
        clearRenderRedrawCaches();
        renderLastCompletedSyncSignatureRef.current = '';
        if (shouldDeferRenderRedrawWhileInactive()) {
          renderPendingRowsRef.current = rows;
          renderNeedsVisibilityReplayRef.current = true;
          return;
        }
        const redrawSignature = buildRenderSyncSignature(rows, { useLiveRayCount: true });
        if (!renderNeedsVisibilityReplayRef.current && redrawSignature === renderLastCompletedSyncSignatureRef.current && !renderRedrawInFlightRef.current) {
          return;
        }
        renderPendingRowsRef.current = rows;
        try {
          w.__cooptPendingRenderRows = [];
          w.__cooptPendingRenderObjectRows = [];
          w.__cooptPendingRenderSyncStamp = normalizedSyncStamp;
        } catch (_) {}
      } else if (normalizedSyncStamp) {
        try { w.__cooptLastRenderSyncStamp = normalizedSyncStamp; } catch (_) {}
      }
      if (renderRedrawInFlightRef.current) {
        return;
      }
      renderRedrawInFlightRef.current = true;
      try {
        let shouldDrawCurrentView = !Array.isArray(rows) || rows.length === 0;
        while (shouldDrawCurrentView || (Array.isArray(renderPendingRowsRef.current) && renderPendingRowsRef.current.length > 0)) {
          const queuedSyncStamp = String(renderPendingSyncStampRef.current ?? '').trim();
          const queuedRows = Array.isArray(renderPendingRowsRef.current) && renderPendingRowsRef.current.length > 0
            ? renderPendingRowsRef.current
            : (shouldDrawCurrentView && Array.isArray(renderActiveRowsRef.current) && renderActiveRowsRef.current.length > 0
              ? renderActiveRowsRef.current
              : null);
          const queuedObjectRows = Array.isArray(renderPendingObjectRowsRef.current)
            ? renderPendingObjectRowsRef.current
            : (shouldDrawCurrentView && Array.isArray(renderActiveObjectRowsRef.current)
              ? renderActiveObjectRowsRef.current
              : null);
          renderPendingRowsRef.current = null;
          renderPendingObjectRowsRef.current = null;
          shouldDrawCurrentView = false;
          const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
          const prevRunning = g ? !!g.__cooptOptimizerIsRunning : false;
          const prevRowsOverride = g ? g.__cooptOpticalSystemRowsOverride : undefined;
          const prevObjectRowsOverride = g ? g.__cooptRenderObjectRowsOverride : undefined;
          if (g) g.__cooptOptimizerIsRunning = true;
          if (g && Array.isArray(queuedRows)) g.__cooptOpticalSystemRowsOverride = queuedRows;
          if (g && Array.isArray(queuedObjectRows)) g.__cooptRenderObjectRowsOverride = queuedObjectRows;
          const redrawRequestId = beginRenderDrawRequest();
          try {
            if (queuedRows) {
              try {
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              } catch (_) {}
            }
            const quickInitialRayCount = Math.min(3, Math.max(1, Number(getLiveRenderRayCount(renderRayCountRef.current) || 1)));
            const redrawOk = await redrawCurrentRenderView(undefined, undefined, redrawRequestId, {
              quickInitialRayCount,
              scheduleFullRayPass: true,
              useLiveRayCount: true,
              skipRayGeneration: true,
            });
            if (queuedSyncStamp && redrawOk !== false) {
              try { w.__cooptLastRenderSyncStamp = queuedSyncStamp; } catch (_) {}
              if (String(renderPendingSyncStampRef.current ?? '').trim() === queuedSyncStamp) {
                renderPendingSyncStampRef.current = '';
              }
            }
            if (queuedRows && redrawOk !== false) {
              renderLastCompletedSyncSignatureRef.current = buildRenderSyncSignature(queuedRows, { useLiveRayCount: true });
            }
          } finally {
            if (g) {
              g.__cooptOptimizerIsRunning = prevRunning;
              g.__cooptOpticalSystemRowsOverride = prevRowsOverride;
              g.__cooptRenderObjectRowsOverride = prevObjectRowsOverride;
            }
          }
        }
      } catch (_) {
      } finally {
        renderRedrawInFlightRef.current = false;
      }
    };

    const canReplayPendingRenderSync = () => {
      try {
        if (document.visibilityState === 'visible') return true;
      } catch (_) {}
      return false;
    };

    const onVisibilityChange = () => {
      if (!canReplayPendingRenderSync()) return;
      if (!renderNeedsVisibilityReplayRef.current) return;
      const queuedRows = Array.isArray(renderPendingRowsRef.current) ? renderPendingRowsRef.current : null;
      const queuedObjectRows = Array.isArray(renderPendingObjectRowsRef.current) ? renderPendingObjectRowsRef.current : null;
      renderNeedsVisibilityReplayRef.current = false;
      if (queuedRows && queuedRows.length > 0 && typeof w.__cooptRenderWindowRedraw === 'function') {
        void Promise.resolve(w.__cooptRenderWindowRedraw(queuedRows, undefined, queuedObjectRows || undefined));
        return;
      }
      scheduleRenderRedraw().catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onVisibilityChange);
    window.addEventListener('pageshow', onVisibilityChange);

    try {
      const pendingRows = Array.isArray(w.__cooptPendingRenderRows) ? w.__cooptPendingRenderRows : [];
      const pendingObjectRows = Array.isArray(w.__cooptPendingRenderObjectRows) ? w.__cooptPendingRenderObjectRows : [];
      if (pendingRows.length > 0) {
        const toReplay = pendingRows;
        const objectRowsToReplay = pendingObjectRows;
        w.__cooptPendingRenderRows = [];
        w.__cooptPendingRenderObjectRows = [];
        void Promise.resolve(w.__cooptRenderWindowRedraw(toReplay, undefined, objectRowsToReplay));
      }
    } catch (_) {}

    try {
      const raw = localStorage.getItem('coopt.renderSyncRequest');
      if (raw) {
        const payload = JSON.parse(raw);
        const stamp = String(payload?.ts ?? payload?.token ?? '').trim();
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
        const systemConfig = payload?.systemConfig && typeof payload.systemConfig === 'object' ? payload.systemConfig : null;
        const handledStamp = String(w.__cooptLastRenderSyncStamp ?? '').trim();
        if (rows.length > 0 && stamp && stamp !== handledStamp) {
          if (systemConfig) {
            try { w.__cooptPendingRenderSystemConfig = systemConfig; } catch (_) {}
          }
          try { w.__cooptPendingRenderRows = rows; } catch (_) {}
          try { w.__cooptPendingRenderObjectRows = objectRows; } catch (_) {}
          void Promise.resolve(w.__cooptRenderWindowRedraw(rows, stamp, objectRows));
        }
      }
    } catch (_) {}

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onVisibilityChange);
      window.removeEventListener('pageshow', onVisibilityChange);
      renderPendingRowsRef.current = null;
      renderPendingObjectRowsRef.current = null;
      renderActiveRowsRef.current = null;
      renderActiveObjectRowsRef.current = null;
      renderPendingSyncStampRef.current = '';
      renderNeedsVisibilityReplayRef.current = false;
      renderLastCompletedSyncSignatureRef.current = '';
      renderRedrawInFlightRef.current = false;
      try { delete (w as any).__cooptRenderWindowRedraw; } catch (_) {
        (w as any).__cooptRenderWindowRedraw = undefined;
      }
    };
  }, [isRenderWindowMode]);

  useEffect(() => {
    if (!isRenderWindowMode) return;

    const w = window as any;
    const onMessage = (event: MessageEvent) => {
      const data = event?.data;
      if (!data || typeof data !== 'object' || data.action !== 'request-redraw') return;

      void (async () => {
        try {
          const stamp = String((data as any).ts ?? (data as any).token ?? '');
          const systemConfig = (data as any).systemConfig && typeof (data as any).systemConfig === 'object'
            ? (data as any).systemConfig
            : null;
          const rows = Array.isArray((data as any).rows) ? (data as any).rows : null;
          const objectRows = Array.isArray((data as any).objectRows) ? (data as any).objectRows : null;
          if (systemConfig) {
            try { w.__cooptPendingRenderSystemConfig = systemConfig; } catch (_) {}
          }
          if (rows && rows.length > 0) {
            try { w.__cooptPendingRenderRows = rows; } catch (_) {}
            try { w.__cooptPendingRenderObjectRows = objectRows || []; } catch (_) {}
            if (typeof w.__cooptRenderWindowRedraw === 'function') {
              await Promise.resolve(w.__cooptRenderWindowRedraw(rows, stamp || undefined, objectRows || undefined));
              return;
            }
          }

          try {
            const cm = w.ConfigurationManager;
            if (cm && typeof cm.loadActiveConfigurationToTables === 'function') {
              await Promise.resolve(cm.loadActiveConfigurationToTables({ applyToUI: true }));
            }
          } catch (err) {
            console.warn('[RenderWindow] Configuration reload failed before message redraw:', err);
          }

          if (typeof w.__cooptRenderWindowRedraw === 'function') {
            await Promise.resolve(w.__cooptRenderWindowRedraw());
          }
        } catch (_) {}
      })();
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, [isRenderWindowMode]);

  useEffect(() => {
    // FIRST: Signal that React is mounted so main.ts can start initializing
    // This breaks the deadlock where main.ts waits for React and React waits for main.ts
    (window as typeof window & { __cooptReactMounted?: boolean })
      .__cooptReactMounted = true;
    window.dispatchEvent(new CustomEvent("coopt:react-mounted"));

    const w = window as any;
    const scheduleDeferredStartupWork = (work: () => void): void => {
      window.setTimeout(() => {
        try {
          work();
        } catch (_) {}
      }, 0);
    };
    const shouldSuppressStartupConfigApply = (): boolean => {
      try {
        const until = Number(w.__cooptSuppressStartupConfigApplyUntil || 0);
        return Number.isFinite(until) && until > Date.now();
      } catch (_) {
        return false;
      }
    };
    const hasPendingRenderStartupSync = (): boolean => {
      if (renderRedrawInFlightRef.current) return true;
      try {
        if (Array.isArray(renderPendingRowsRef.current) && renderPendingRowsRef.current.length > 0) return true;
      } catch (_) {}
      try {
        if (Array.isArray(w.__cooptPendingRenderRows) && w.__cooptPendingRenderRows.length > 0) return true;
      } catch (_) {}
      try {
        const raw = localStorage.getItem('coopt.renderSyncRequest');
        if (!raw) return false;
        const payload = JSON.parse(raw);
        const stamp = String(payload?.ts ?? payload?.token ?? '').trim();
        const handledStamp = String(w.__cooptLastRenderSyncStamp ?? '').trim();
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        return rows.length > 0 && (!stamp || stamp !== handledStamp);
      } catch (_) {
        return false;
      }
    };
    const replayPendingRenderStartupSync = (): boolean => {
      try {
        const pendingRows = Array.isArray(w.__cooptPendingRenderRows) ? w.__cooptPendingRenderRows : [];
        const pendingObjectRows = Array.isArray(w.__cooptPendingRenderObjectRows) ? w.__cooptPendingRenderObjectRows : [];
        if (pendingRows.length > 0 && typeof w.__cooptRenderWindowRedraw === 'function') {
          void Promise.resolve(w.__cooptRenderWindowRedraw(pendingRows, undefined, pendingObjectRows));
          return true;
        }
      } catch (_) {}
      try {
        const raw = localStorage.getItem('coopt.renderSyncRequest');
        if (!raw) return false;
        const payload = JSON.parse(raw);
        const stamp = String(payload?.ts ?? payload?.token ?? '').trim();
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
        const systemConfig = payload?.systemConfig && typeof payload.systemConfig === 'object' ? payload.systemConfig : null;
        const handledStamp = String(w.__cooptLastRenderSyncStamp ?? '').trim();
        if (rows.length === 0 || (stamp && stamp === handledStamp) || typeof w.__cooptRenderWindowRedraw !== 'function') {
          return false;
        }
        if (systemConfig) {
          try { w.__cooptPendingRenderSystemConfig = systemConfig; } catch (_) {}
        }
        try { w.__cooptPendingRenderRows = rows; } catch (_) {}
        try { w.__cooptPendingRenderObjectRows = objectRows; } catch (_) {}
        void Promise.resolve(w.__cooptRenderWindowRedraw(rows, stamp || undefined, objectRows));
        return true;
      } catch (_) {
        return false;
      }
    };
    
    const initializeAfterMainTS = (_mode: "main-ready" | "module-loaded" | "fallback") => {
      if (isRenderWindowMode) {
        const drawWithPreparedData = async (): Promise<boolean> => {
          const w = window as any;
          const startupStages: RenderTimingStage[] = [];
          ensureRenderCanvasAttached();

          let rowCount = 0;
          try {
            if (typeof w.getOpticalSystemRows === 'function') {
              const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
              rowCount = Array.isArray(rows) ? rows.length : 0;
            }
          } catch (_) {}

          if (rowCount === 0) {
            try {
              const cm = w.ConfigurationManager;
              if (cm && typeof cm.loadActiveConfigurationToTables === 'function') {
                const startMs = performance.now();
                await Promise.resolve(cm.loadActiveConfigurationToTables({ applyToUI: true }));
                startupStages.push({ label: 'load', ms: performance.now() - startMs });
              }
            } catch (err) {
              console.warn('[RenderWindow] Configuration load failed before draw:', err);
            }

            try {
              if (typeof w.initializeAllTables === 'function') {
                const startMs = performance.now();
                w.initializeAllTables();
                startupStages.push({ label: 'tables', ms: performance.now() - startMs });
              }
            } catch (_) {}

            try {
              if (typeof w.getOpticalSystemRows === 'function') {
                const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
                rowCount = Array.isArray(rows) ? rows.length : 0;
              }
            } catch (_) {}
          }

          if (rowCount === 0) {
            setRenderWindowStatus('No optical data');
            setRenderLensColorTargets([]);
            return false;
          }

          try {
            const currentMode = renderViewModeRef.current;
            const currentAxis = renderViewAxisRef.current;
            const requestId = beginRenderDrawRequest();
            const quickInitialRayCount = Math.min(3, Math.max(1, Number(getLiveRenderRayCount(renderRayCountRef.current) || 1)));
            const ok = currentMode === '3D'
              ? await drawRender3DView(startupStages, requestId, { quickInitialRayCount, scheduleFullRayPass: true, useLiveRayCount: true, skipRayGeneration: true })
              : await drawCrossSectionView(currentMode === 'XZ' ? 'XZ' : currentAxis === 'XZ' ? 'XZ' : 'YZ', requestId, { quickInitialRayCount, scheduleFullRayPass: true, useLiveRayCount: true, skipRayGeneration: true });
            if (!ok) {
              setRenderWindowStatus('Draw failed');
              return false;
            }
          } catch (err) {
            console.error('[RenderWindow] Failed to draw optical system:', err);
            setRenderWindowStatus('Draw failed');
            return false;
          }

          const hasCanvas = ensureRenderCanvasAttached() || !!document.querySelector('#threejs-canvas-container canvas');
          if (hasCanvas) {
            window.setTimeout(() => {
              try {
                if (typeof w.getOpticalSystemRows === 'function') {
                  const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
                  refreshRenderLensTargets(rows);
                } else {
                  refreshRenderLensTargets([]);
                }
              } catch (_) {
                refreshRenderLensTargets([]);
              }
            }, 0);
            const currentMode = renderViewModeRef.current;
            const currentAxis = renderViewAxisRef.current;
            if (!renderLastTimingRef.current) {
              setRenderWindowStatus(
                currentMode === '3D'
                  ? 'Ready (3D)'
                  : `Ready (${currentMode === 'XZ' ? 'XZ' : currentAxis === 'XZ' ? 'XZ' : 'YZ'} section)`
              );
            }
            return true;
          }

          const hasRenderer = !!(w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null));
          if (!hasRenderer) {
            setRenderWindowStatus('Renderer unavailable');
          } else if (!hasCanvas) {
            setRenderWindowStatus('Canvas unavailable');
          } else {
            setRenderWindowStatus('Draw unavailable');
          }
          return false;
        };

        setRenderStartupBreakdown('');
        setRenderViewportVisible(false);
        if (hasPendingRenderStartupSync()) {
          setRenderWindowStatus('Waiting for render data...');
          window.setTimeout(() => {
            if (!replayPendingRenderStartupSync()) {
              drawWithPreparedData().catch(() => {
                setRenderWindowStatus('Draw unavailable');
              });
            }
          }, 0);
        } else {
          setRenderWindowStatus('Initializing...');
          drawWithPreparedData().catch(() => {
            setRenderWindowStatus('Draw unavailable');
          });
        }
        return;
      }
      
      // Load active configuration to tables (this expands Blocks to Optical System rows)
      if (!shouldSuppressStartupConfigApply() && typeof (window as any).loadActiveConfigurationToTables === 'function') {
        try {
          (window as any).loadActiveConfigurationToTables();
        } catch (err) {
          console.error("[React] Failed to load active configuration:", err);
        }
      }

      if (analysisWindowMode.enabled) {
        if (typeof (window as any).setupAnalysisWindows === 'function') {
          (window as any).setupAnalysisWindows();
        }
        return;
      }

      scheduleDeferredStartupWork(() => {
        if (typeof (window as any).initializeAllTables === 'function') {
          (window as any).initializeAllTables();
        }

        requestRefreshBlockInspector();

        if (typeof (window as any).setupAnalysisWindows === 'function') {
          (window as any).setupAnalysisWindows();
        }
        if (typeof (window as any).setupOpticalSystemChangeListeners === 'function') {
          (window as any).setupOpticalSystemChangeListeners(null);
        }
      });
      
      // Verify optical system data is available
      setTimeout(() => {
        const w = window as any;
        if (typeof w.getOpticalSystemRows === 'function' && w.tableOpticalSystem) {
          w.getOpticalSystemRows(w.tableOpticalSystem);
        }
      }, 200);
    };

    const isMainReady = () => !!w.__cooptMainReady;
    const isMainModuleLoaded = () => !!w.__cooptMainModuleLoaded || typeof w.getOpticalSystemRows === "function";

    if (isMainReady()) {
      setTimeout(() => initializeAfterMainTS("main-ready"), 0);
      return;
    }

    if (isMainModuleLoaded()) {
      setTimeout(() => initializeAfterMainTS("module-loaded"), 0);
      return;
    }

    let initialized = false;
    const completeInit = (mode: "main-ready" | "module-loaded" | "fallback") => {
      if (initialized) return;
      initialized = true;
      setTimeout(() => initializeAfterMainTS(mode), 0);
    };

    const onMainReady = () => completeInit("main-ready");
    const onMainModuleLoaded = () => completeInit("module-loaded");
    const onMainLoadFailed = (evt: Event) => {
      const detail = (evt as CustomEvent<any>)?.detail;
      console.error("[React] main.ts load failed", detail || { message: w.__cooptMainLoadError || "unknown" });
    };

    window.addEventListener("coopt:main-ready", onMainReady, { once: true });
    window.addEventListener("coopt:main-module-loaded", onMainModuleLoaded, { once: true });
    window.addEventListener("coopt:main-load-failed", onMainLoadFailed);

    const fallbackTimer = window.setTimeout(() => {
      if (initialized) return;
      const status = {
        getOpticalSystemRows: typeof w.getOpticalSystemRows,
        initializeAllTables: typeof w.initializeAllTables,
        loadActiveConfigurationToTables: typeof w.loadActiveConfigurationToTables,
        mainReadyFlag: !!w.__cooptMainReady,
        mainModuleLoaded: !!w.__cooptMainModuleLoaded,
        mainLoadError: w.__cooptMainLoadError || null
      };
      if (status.mainLoadError) {
        console.warn("[React] main bootstrap timeout after load error, proceeding with fallback", status);
      } else {
        console.info("[React] main bootstrap slow-start, proceeding with fallback", status);
      }
      completeInit("fallback");
    }, 30000);

    return () => {
      window.clearTimeout(fallbackTimer);
      window.removeEventListener("coopt:main-ready", onMainReady);
      window.removeEventListener("coopt:main-module-loaded", onMainModuleLoaded);
      window.removeEventListener("coopt:main-load-failed", onMainLoadFailed);
    };
  }, [analysisWindowMode.enabled, isOptimizeWindowMode, isRenderWindowMode, isSettingsWindowMode]);

  useEffect(() => {
    if (!isRenderWindowMode) return;
    const onResize = () => {
      try {
        ensureRenderCanvasAttached();
        syncOrthoBoundsToRendererAspect();
        const w = window as any;
        const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
        const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
        const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
        if (renderer && scene && camera && typeof renderer.render === 'function') {
          renderer.render(scene, camera);
        }
      } catch (_) {}
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isRenderWindowMode, renderViewAxis]);

  // Settings window mode is fully handled by DesktopSettingsPage React component below.

  useEffect(() => {
    if (!isOptimizeWindowMode) return;
    try {
      const w = window as any;
      const sourceWindow = getOptimizeHostWindow();
      const sourceSystemConfig = getSystemConfigFromWindow(sourceWindow);
      let rows = sourceWindow.getOpticalSystemRows ? sourceWindow.getOpticalSystemRows(sourceWindow.tableOpticalSystem) : [];
      let reqRows: any[] = [];
      try {
        const cfg = sourceSystemConfig;
        const activeId = cfg?.activeConfigId;
        const activeCfg = Array.isArray(cfg?.configurations)
          ? (cfg.configurations.find((c: any) => c && String(c.id) === String(activeId)) || cfg.configurations[0])
          : null;
        if (activeCfg && Array.isArray(activeCfg.blocks) && activeCfg.blocks.length > 0 && typeof sourceWindow.expandBlocksToOpticalSystemRows === 'function') {
          const expanded = sourceWindow.expandBlocksToOpticalSystemRows(activeCfg.blocks);
          if (expanded && Array.isArray(expanded.rows) && expanded.rows.length > 0) {
            rows = expanded.rows;
          }
        }
        if (Array.isArray(cfg?.systemRequirements)) {
          reqRows = cfg.systemRequirements;
        }
      } catch (_) {}
      if (!Array.isArray(reqRows) || reqRows.length === 0) {
        reqRows = (sourceWindow.systemRequirementsEditor && typeof sourceWindow.systemRequirementsEditor.getData === 'function')
          ? sourceWindow.systemRequirementsEditor.getData()
          : [];
      }
      if ((!Array.isArray(reqRows) || reqRows.length === 0) && Array.isArray(sourceSystemConfig?.systemRequirements)) {
        reqRows = sourceSystemConfig.systemRequirements;
      }
      const variableCount = countBlockOptimizeVariables(sourceWindow);
      setOptimizeState((prev: any) => ({
        ...prev,
        variableCount,
        requirementCount: Array.isArray(reqRows) ? reqRows.length : 0,
      }));
    } catch (_) {}
    return () => {};
  }, [isOptimizeWindowMode]);

  useEffect(() => {
    if (!analysisWindowMode.enabled) return;
    if (analysisWindowMode.analysis === 'astigmatism') return;
    if (analysisWindowMode.analysis === 'mtf' || analysisWindowMode.analysis === 'through-focus-mtf' || analysisWindowMode.analysis === 'field-mtf' || analysisWindowMode.analysis === 'distortion' || analysisWindowMode.analysis === 'distortion-grid') return;

    let restoreOpener: (() => void) | null = null;
    let tauriCloseUnlisten: (() => void) | null = null;
    try {
      const openerDescriptor = Object.getOwnPropertyDescriptor(window, 'opener');
      Object.defineProperty(window, 'opener', {
        configurable: true,
        get: () => window,
      });
      restoreOpener = () => {
        try {
          if (openerDescriptor) {
            Object.defineProperty(window, 'opener', openerDescriptor);
          } else {
            delete (window as any).opener;
          }
        } catch (_) {}
      };
    } catch (_) {}

    if (isTauriRuntime()) {
      (async () => {
        try {
          const [{ getCurrentWindow }, { getCurrentWebviewWindow }] = await Promise.all([
            import('@tauri-apps/api/window'),
            import('@tauri-apps/api/webviewWindow'),
          ]);
          const currentWindow = getCurrentWindow();
          const currentWebview = getCurrentWebviewWindow();
          const bootstrapStartedAt = Date.now();

          console.log('ℹ️ [Analysis][Desktop] bootstrap window:', {
            label: currentWindow.label,
            webviewLabel: currentWebview.label,
            analysis: analysisWindowMode.analysis,
          });

          tauriCloseUnlisten = await currentWindow.onCloseRequested((event) => {
            const elapsed = Date.now() - bootstrapStartedAt;
            if (elapsed < 8000) {
              console.warn('⚠️ [Analysis][Desktop] unexpected close requested during bootstrap', {
                label: currentWindow.label,
                analysis: analysisWindowMode.analysis,
                elapsed,
              });
              event.preventDefault();
            }
          });
        } catch (err) {
          console.error('❌ [Analysis][Desktop] failed to attach close-request guard:', err);
        }
      })();
    }

    const analysisButtonMap: Record<string, string> = {
      'system-data': 'open-system-data-window-btn',
      'spot-diagram': 'open-spot-diagram-window-btn',
      'spherical-aberration': 'open-spherical-aberration-window-btn',
      'astigmatism': 'open-astigmatism-window-btn',
      'distortion': 'open-distortion-window-btn',
      'distortion-grid': 'open-distortion-grid-window-btn',
      'magnification-chromatic-aberration': 'open-magnification-chromatic-aberration-window-btn',
      'integrated-aberration': 'open-integrated-aberration-window-btn',
      'transverse-aberration': 'open-transverse-aberration-window-btn',
      'opd': 'open-opd-window-btn',
      'psf': 'open-psf-window-btn',
      'mtf': 'open-mtf-window-btn',
      'through-focus-spot': 'open-through-focus-spot-window-btn',
      'through-focus-mtf': 'open-through-focus-mtf-window-btn',
      'field-mtf': 'open-field-mtf-window-btn',
    };
    const analysisPopupTitleMap: Record<string, string> = {
      'system-data': 'System Data',
      'spot-diagram': 'Spot Diagram',
      'spherical-aberration': 'Spherical Aberration',
      'astigmatism': 'Astigmatism',
      'distortion': 'Distortion',
      'distortion-grid': 'Distortion Grid',
      'magnification-chromatic-aberration': 'Lateral Chromatic Aberration',
      'integrated-aberration': 'Integrated Aberration',
      'transverse-aberration': 'Transverse Aberration',
      'opd': 'Optical Path Difference',
      'psf': 'Point Spread Function',
      'mtf': 'Modulation Transfer Function',
      'through-focus-spot': 'Through-Focus Spot',
      'through-focus-mtf': 'Through-Focus MTF',
      'field-mtf': 'Object MTF',
    };
    const reactManagedAnalysis = new Set(['mtf', 'through-focus-mtf', 'field-mtf', 'distortion', 'distortion-grid']);

    const targetButtonId = analysisButtonMap[analysisWindowMode.analysis];
    const targetPopupTitle = analysisPopupTitleMap[analysisWindowMode.analysis];
    if (targetPopupTitle) {
      document.title = targetPopupTitle;
    }

    // These analyses have first-class React pages in this window already.
    // Do not re-dispatch the hidden legacy popup button, or it can overwrite
    // the current page with an older alternate renderer.
    if (reactManagedAnalysis.has(analysisWindowMode.analysis)) {
      return;
    }

    let disposed = false;
    let rafId = 0;
    let timeoutId = 0;
    let tries = 0;
    const maxTries = 180;

    const attemptLaunch = () => {
      if (disposed) return;
      if (analysisWindowMode.analysis === 'system-data') {
        return;
      }
      tries += 1;
      const w = window as any;
      try {
        if (typeof w.setupAnalysisWindows === 'function') {
          w.setupAnalysisWindows();
        }
      } catch (_) {}

      if (targetPopupTitle) {
        try {
          w.__preopenedAnalysisPopupMap = w.__preopenedAnalysisPopupMap || {};
          w.__preopenedAnalysisPopupMap[targetPopupTitle] = window;
        } catch (_) {}
      }

      const button = targetButtonId ? document.getElementById(targetButtonId) : null;
      if (button) {
        try {
          const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          button.dispatchEvent(clickEvent);
        } catch (_) {}
        return;
      }

      if (tries >= maxTries) {
        return;
      }
      rafId = window.requestAnimationFrame(attemptLaunch);
    };

    const onMainReady = () => {
      if (disposed) return;
      try { window.cancelAnimationFrame(rafId); } catch (_) {}
      rafId = window.requestAnimationFrame(attemptLaunch);
    };

    window.addEventListener('coopt:main-ready', onMainReady);
    timeoutId = window.setTimeout(() => {
      if (disposed) return;
      attemptLaunch();
    }, 0);
    rafId = window.requestAnimationFrame(attemptLaunch);

    return () => {
      disposed = true;
      try { window.removeEventListener('coopt:main-ready', onMainReady); } catch (_) {}
      try { window.cancelAnimationFrame(rafId); } catch (_) {}
      try { window.clearTimeout(timeoutId); } catch (_) {}
      if (targetPopupTitle) {
        try {
          const store = (window as any).__preopenedAnalysisPopupMap;
          if (store && store[targetPopupTitle] === window) {
            delete store[targetPopupTitle];
          }
        } catch (_) {}
      }
      if (tauriCloseUnlisten) {
        try { tauriCloseUnlisten(); } catch (_) {}
      }
      if (restoreOpener) restoreOpener();
    };
  }, [analysisWindowMode.enabled, analysisWindowMode.analysis]);

  if (isSettingsWindowMode) {
    return <DesktopSettingsPage />;
  }

  if (analysisWindowMode.analysis === 'mtf' || analysisWindowMode.analysis === 'through-focus-mtf' || analysisWindowMode.analysis === 'field-mtf') {
    return <MtfAnalysisPage type={analysisWindowMode.analysis as any} />;
  }

  if (analysisWindowMode.analysis === 'distortion' || analysisWindowMode.analysis === 'distortion-grid') {
    return <DistortionAnalysisPage type={analysisWindowMode.analysis as any} />;
  }

  if (isOptimizeWindowMode) {
    const percent = Number.isFinite(Number(optimizeState?.percent)) ? Math.max(0, Math.min(100, Number(optimizeState.percent))) : 0;

    const getSystemConfigFromTargetWindow = (targetWindow: any) => {
      return getSystemConfigFromWindow(targetWindow);
    };

    const getCurrentOpticalRowsFromTargetWindow = (targetWindow: any, cfgOverride?: any): any[] => {
      try {
        if (targetWindow && typeof targetWindow.getOpticalSystemRows === 'function') {
          const rows = targetWindow.getOpticalSystemRows(targetWindow.tableOpticalSystem);
          if (Array.isArray(rows) && rows.length > 0) return rows;
        }
      } catch (_) {}
      try {
        const cfg = cfgOverride ?? getSystemConfigFromTargetWindow(targetWindow);
        const activeId = cfg?.activeConfigId;
        const activeCfg = Array.isArray(cfg?.configurations)
          ? (cfg.configurations.find((c: any) => c && String(c.id) === String(activeId)) || cfg.configurations[0])
          : null;
        if (Array.isArray(activeCfg?.opticalSystem) && activeCfg.opticalSystem.length > 0) {
          return activeCfg.opticalSystem;
        }
      } catch (_) {}
      return [];
    };

    const getRequirementMetricsFromTargetWindow = (targetWindow: any) => {
      const cfg = getSystemConfigFromTargetWindow(targetWindow);
      const activeConfigId = (cfg && cfg.activeConfigId !== undefined && cfg.activeConfigId !== null)
        ? String(cfg.activeConfigId).trim()
        : '';
      const reqEditor = targetWindow?.systemRequirementsEditor || (window as any).systemRequirementsEditor;

      const normalizeConfigId = (row: any): string => {
        try {
          if (reqEditor && typeof reqEditor._normalizeConfigId === 'function') {
            return String(reqEditor._normalizeConfigId(row?.configId, cfg, activeConfigId) || '').trim();
          }
        } catch (_) {}
        const rawCfg = String(row?.configId ?? '').trim();
        return rawCfg || activeConfigId;
      };

      const rows = (() => {
        try {
          if (reqEditor && typeof reqEditor.getData === 'function') {
            const data = reqEditor.getData();
            if (Array.isArray(data)) return data;
          }
        } catch (_) {}
        try {
          if (Array.isArray(cfg?.systemRequirements)) return cfg.systemRequirements;
        } catch (_) {}
        return [];
      })();

      const activeRows = Array.isArray(rows)
        ? rows.filter((row: any) => {
          if (!row || typeof row !== 'object') return false;
          const enabled = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
          const operand = String(row.operand ?? '').trim();
          const weight = Number(row.weight ?? 1);
          if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) return false;
          normalizeConfigId(row);
          return true;
        })
        : [];

      let score = Number.NaN;
      let sum = 0;
      let count = 0;
      for (const row of activeRows) {
        const contribution = Number.isFinite(Number(row?._contribution))
          ? Number(row._contribution)
          : Number(row?.score);
        if (Number.isFinite(contribution)) {
          if (contribution > 0) sum += contribution;
          count += 1;
        }
      }
      if (count > 0 && Number.isFinite(sum)) score = sum;
      return { score, requirementCount: activeRows.length };
    };

    const syncHostDesignIntentAndRequirements = async (
      targetWindow: any,
      reason: string,
      phase: 'before' | 'after',
      rowsForScore?: any[]
    ) => {
      const shouldReloadTables = !(
        phase === 'after'
        && /^optimize-(finished|stopped)-(reload|sync)$/i.test(String(reason ?? '').trim())
      );

      try {
        if (shouldReloadTables && phase === 'after' && targetWindow && targetWindow !== window) {
          try { delete targetWindow.__cooptPreferRuntimeSystemConfig; } catch (_) {}
          try { delete targetWindow.__cooptSystemConfig; } catch (_) {}
          try { targetWindow.__cooptDeferDerivedUiUntil = Date.now() + 1500; } catch (_) {}
        }
        const cm = targetWindow?.ConfigurationManager;
        const reqEditor = targetWindow?.systemRequirementsEditor || (window as any).systemRequirementsEditor;
        if (reqEditor && typeof reqEditor.flushPendingEdits === 'function') {
          const flushPromise = reqEditor.flushPendingEdits();
          if (flushPromise && typeof flushPromise.then === 'function') await flushPromise;
        }
        if (shouldReloadTables && cm && typeof cm.loadActiveConfigurationToTables === 'function') {
          await Promise.resolve(cm.loadActiveConfigurationToTables({
            applyToUI: true,
            suppressOpticalSystemDataChanged: true,
          }));
        } else if (shouldReloadTables && targetWindow && typeof targetWindow.loadActiveConfigurationToTables === 'function') {
          await Promise.resolve(targetWindow.loadActiveConfigurationToTables({
            applyToUI: true,
            suppressOpticalSystemDataChanged: true,
          }));
        }
      } catch (_) {}

      let refreshedScore = Number.NaN;
      const hostRows = Array.isArray(rowsForScore) && rowsForScore.length > 0
        ? rowsForScore
        : getCurrentOpticalRowsFromTargetWindow(targetWindow);

      try {
        const refreshFn = targetWindow?.__cooptRefreshRequirementTableScoreForOptimize;
        if (typeof refreshFn === 'function' && Array.isArray(hostRows) && hostRows.length > 0) {
          refreshedScore = Number(await refreshFn(hostRows, reason));
        } else {
          const reqEditor = targetWindow?.systemRequirementsEditor || (window as any).systemRequirementsEditor;
          if (reqEditor && typeof reqEditor.evaluateAndUpdateNow === 'function') {
            const p = reqEditor.evaluateAndUpdateNow({ reason, forceSilent: true, silent: true });
            if (p && typeof p.then === 'function') await p;
          }
        }
      } catch (_) {}

      const metrics = getRequirementMetricsFromTargetWindow(targetWindow);
      const effectiveScore = Number.isFinite(refreshedScore) ? refreshedScore : metrics.score;
      const variableCount = countBlockOptimizeVariables(targetWindow);

      setOptimizeState((prev: any) => {
        const next: any = {
          ...prev,
          variableCount: Number.isFinite(variableCount) ? variableCount : prev.variableCount,
          requirementCount: Number.isFinite(Number(metrics.requirementCount))
            ? Number(metrics.requirementCount)
            : prev.requirementCount,
        };

        if (phase === 'before') {
          next.requirementScoreBefore = Number.isFinite(effectiveScore) ? effectiveScore : prev.requirementScoreBefore;
          next.requirementScoreAfter = Number.isFinite(effectiveScore) ? effectiveScore : prev.requirementScoreAfter;
          next.requirementScoreTable = Number.isFinite(effectiveScore) ? effectiveScore : prev.requirementScoreTable;
          next.meritBefore = Number.isFinite(effectiveScore) ? effectiveScore : prev.meritBefore;
          next.meritAfter = Number.isFinite(effectiveScore) ? effectiveScore : prev.meritAfter;
          next.best = Number.isFinite(effectiveScore) ? effectiveScore : prev.best;
        } else {
          next.requirementScoreAfter = Number.isFinite(effectiveScore) ? effectiveScore : prev.requirementScoreAfter;
          next.requirementScoreTable = Number.isFinite(effectiveScore) ? effectiveScore : prev.requirementScoreTable;
          next.meritAfter = Number.isFinite(effectiveScore) ? effectiveScore : prev.meritAfter;
          if (Number.isFinite(effectiveScore)) {
            next.best = Number.isFinite(prev.best) ? Math.min(prev.best, effectiveScore) : effectiveScore;
          }
        }

        return next;
      });

      return {
        rows: hostRows,
        score: effectiveScore,
        requirementCount: metrics.requirementCount,
        variableCount,
      };
    };

    const maybeAutoRender = async (rowsSnapshot: any[]) => {
      if (!optAutoRenderOnAccept) return;
      try {
        const rows = Array.isArray(rowsSnapshot) ? rowsSnapshot : [];
        const objectRows = getRenderObjectRows(window as any, rows);
        const systemConfig = loadSystemConfigSnapshot();
        const syncToken = `${Date.now()}-opt-auto-render`;
        applyRenderSync(rows, syncToken, objectRows, systemConfig);
      } catch (_) {}
    };

    const runOptimize = async () => {
      if (optRunning) return;
      const w = window as any;
      const hostWindow = getOptimizeHostWindow();
      const loadHostSystemConfigSnapshot = () => {
        return getSystemConfigFromWindow(hostWindow) || getSystemConfigFromWindow(w) || null;
      };

      try {
        if (hostWindow) {
          delete hostWindow.__cooptPreferRuntimeSystemConfig;
          delete hostWindow.__cooptSystemConfig;
        }
      } catch (_) {}
      try {
        delete w.__cooptPreferRuntimeSystemConfig;
        delete w.__cooptSystemConfig;
      } catch (_) {}

      const cloneJsonLocal = (v: any) => {
        try { return JSON.parse(JSON.stringify(v)); } catch (_) { return null; }
      };

      const publishRuntimeSystemConfigForOptimizeSync = (nextConfig: any, deferMs = 1500) => {
        const clonedConfig = nextConfig && typeof nextConfig === 'object'
          ? (cloneJsonLocal(nextConfig) || nextConfig)
          : null;
        const applyToWindow = (target: any) => {
          if (!target) return;
          try {
            if (clonedConfig) {
              target.__cooptSystemConfig = cloneJsonLocal(clonedConfig) || clonedConfig;
              target.__cooptPreferRuntimeSystemConfig = true;
              target.__cooptDeferDerivedUiUntil = Date.now() + Math.max(0, Number(deferMs) || 0);
            } else {
              delete target.__cooptPreferRuntimeSystemConfig;
              delete target.__cooptSystemConfig;
            }
          } catch (_) {}
        };
        applyToWindow(hostWindow);
        if (w !== hostWindow) applyToWindow(w);
      };

      let frozenHostConfigForRun: any = null;
      try {
        const hostConfigBeforeSync = loadHostSystemConfigSnapshot();
        frozenHostConfigForRun = cloneJsonLocal(hostConfigBeforeSync) || hostConfigBeforeSync || null;
        if (frozenHostConfigForRun) {
          try {
            hostWindow.__cooptSystemConfig = cloneJsonLocal(frozenHostConfigForRun) || frozenHostConfigForRun;
            hostWindow.__cooptPreferRuntimeSystemConfig = true;
            hostWindow.__cooptDeferDerivedUiUntil = Date.now() + 60000;
          } catch (_) {}
          try {
            w.__cooptSystemConfig = cloneJsonLocal(frozenHostConfigForRun) || frozenHostConfigForRun;
            w.__cooptPreferRuntimeSystemConfig = true;
            w.__cooptDeferDerivedUiUntil = Date.now() + 60000;
          } catch (_) {}
        }
      } catch (_) {}

      await syncHostDesignIntentAndRequirements(hostWindow, 'optimize-run-click', 'before');

      try {
        if (hostWindow === w) {
          try { delete w.__cooptPreferRuntimeSystemConfig; } catch (_) {}
          try { delete w.__cooptSystemConfig; } catch (_) {}
        }

        const hostConfig = loadHostSystemConfigSnapshot();
        if (hostConfig && typeof hostConfig === 'object') {
          const clonedHostConfig = cloneJson(hostConfig) || hostConfig;
          w.__cooptSystemConfig = clonedHostConfig;
          w.__cooptPreferRuntimeSystemConfig = true;
          w.__cooptDeferDerivedUiUntil = Date.now() + 1500;
        } else {
          try { delete w.__cooptPreferRuntimeSystemConfig; } catch (_) {}
          try { delete w.__cooptSystemConfig; } catch (_) {}
        }
      } catch (_) {}

      const captureHostOptimizeSnapshot = () => {
        try {
          const cfg = loadHostSystemConfigSnapshot();
          const rows = typeof hostWindow.getOpticalSystemRows === 'function'
            ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem)
            : [];
          return {
            config: cloneJsonLocal(cfg),
            rows: Array.isArray(rows) ? (cloneJsonLocal(rows) || []) : [],
          };
        } catch (_) {
          return { config: null, rows: [] };
        }
      };

      // Snapshot at the exact Run-button click timing for deterministic Undo baseline.
      const clickSnapshot = captureHostOptimizeSnapshot();
      try {
        const frozenRunConfig = clickSnapshot?.config && typeof clickSnapshot.config === 'object'
          ? (cloneJsonLocal(clickSnapshot.config) || clickSnapshot.config)
          : null;
        if (frozenRunConfig) {
          try {
            hostWindow.__cooptSystemConfig = cloneJsonLocal(frozenRunConfig) || frozenRunConfig;
            hostWindow.__cooptPreferRuntimeSystemConfig = true;
            hostWindow.__cooptDeferDerivedUiUntil = Date.now() + 60000;
          } catch (_) {}
          try {
            w.__cooptSystemConfig = cloneJsonLocal(frozenRunConfig) || frozenRunConfig;
            w.__cooptPreferRuntimeSystemConfig = true;
            w.__cooptDeferDerivedUiUntil = Date.now() + 60000;
          } catch (_) {}
        }
      } catch (_) {}
      const sleepBlockToken = isTauriRuntime()
        ? `optimize-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        : '';

      const maxIterations = Math.max(1, Math.floor(Number(optMaxIterations) || 1));

      let rows = w.getOpticalSystemRows ? w.getOpticalSystemRows(w.tableOpticalSystem) : [];
      if ((!Array.isArray(rows) || rows.length === 0) && hostWindow !== w) {
        try {
          rows = hostWindow.getOpticalSystemRows ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem) : [];
        } catch (_) {}
      }
      try {
        const cfg = loadHostSystemConfigSnapshot();
        const activeId = cfg?.activeConfigId;
        const activeCfg = Array.isArray(cfg?.configurations)
          ? (cfg.configurations.find((c: any) => c && String(c.id) === String(activeId)) || cfg.configurations[0])
          : null;
        if (activeCfg && Array.isArray(activeCfg.blocks) && activeCfg.blocks.length > 0 && typeof hostWindow.expandBlocksToOpticalSystemRows === 'function') {
          const expanded = hostWindow.expandBlocksToOpticalSystemRows(activeCfg.blocks);
          if (expanded && Array.isArray(expanded.rows) && expanded.rows.length > 0) {
            rows = expanded.rows;
          }
        }
      } catch (_) {}
      if (!Array.isArray(rows) || rows.length === 0) {
        setOptimizeState((prev: any) => ({ ...prev, status: 'error', issue: 'No optical system data', phase: 'error' }));
        return;
      }

      const activeConfigId = (() => {
        try {
          const cfg = loadHostSystemConfigSnapshot();
          if (cfg && cfg.activeConfigId !== undefined && cfg.activeConfigId !== null) {
            return String(cfg.activeConfigId).trim();
          }
        } catch (_) {}
        return '';
      })();

      const normalizeRequirementConfigId = (row: any): string => {
        try {
          const sre = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
          const cfg = loadHostSystemConfigSnapshot();
          if (sre && typeof sre._normalizeConfigId === 'function') {
            return String(sre._normalizeConfigId(row?.configId, cfg, activeConfigId) || '').trim();
          }
        } catch (_) {}
        const rawCfg = String(row?.configId ?? '').trim();
        return rawCfg || activeConfigId;
      };

      const collectSystemRequirementsRows = (): any[] => {
        try {
          const cfg = getSystemConfigFromWindow(hostWindow);
          if (Array.isArray(cfg?.systemRequirements) && cfg.systemRequirements.length > 0) {
            return cfg.systemRequirements;
          }
        } catch (_) {}
        try {
          const sre = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
          if (sre && typeof sre.getData === 'function') {
            const req = sre.getData();
            if (Array.isArray(req)) return req;
          }
        } catch (_) {}
        // 3rd fallback: read directly from shared 'systemRequirementsData' localStorage key.
        // This works in Tauri WebviewWindow where systemRequirementsEditor is not initialized.
        try {
          const rawReqs = localStorage.getItem('systemRequirementsData');
          if (rawReqs) {
            const parsed = JSON.parse(rawReqs);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
          }
        } catch (_) {}
        return [];
      };

      const countActiveRequirements = (rows: any[], strictActiveConfig = true): number => {
        if (!Array.isArray(rows) || rows.length === 0) return 0;
        return rows.reduce((acc: number, row: any) => {
          if (!row || typeof row !== 'object') return acc;
          const enabled = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
          const operand = String(row.operand ?? '').trim();
          const weight = Number(row.weight ?? 1);
          const reqCfg = normalizeRequirementConfigId(row);
          if (strictActiveConfig && activeConfigId && reqCfg !== activeConfigId) return acc;
          if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) return acc;
          return acc + 1;
        }, 0);
      };

      let systemRequirementsRows = collectSystemRequirementsRows();
      let activeRequirementCount = countActiveRequirements(systemRequirementsRows, true);

      if (activeRequirementCount <= 0) {
        try {
          const reqEditor = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
          if (reqEditor && typeof reqEditor.evaluateAndUpdateNow === 'function') {
            const p = reqEditor.evaluateAndUpdateNow({ reason: 'optimize-prerun-guard', forceSilent: true, silent: true });
            if (p && typeof p.then === 'function') {
              await p;
            }
          }
        } catch (_) {}

        systemRequirementsRows = collectSystemRequirementsRows();
        activeRequirementCount = countActiveRequirements(systemRequirementsRows, true);
      }

      if (activeRequirementCount <= 0) {
        // Fallback: allow optimization to proceed when requirements exist but configId mapping is temporarily stale.
        activeRequirementCount = countActiveRequirements(systemRequirementsRows, false);
      }

      if (activeRequirementCount <= 0) {
        setOptimizeState((prev: any) => ({
          ...prev,
          status: 'error',
          phase: 'error',
          issue: 'No active System Requirements (check enabled/weight/operand)',
        }));
        return;
      }

      const optimizeVarCount = Math.max(
        countBlockOptimizeVariables(hostWindow),
        countOptimizeVariablesFromSystemConfig(frozenHostConfigForRun),
        countOptimizeVariablesFromSystemConfig(clickSnapshot?.config),
      );
      if (optimizeVarCount <= 0) {
        setOptimizeState((prev: any) => ({
          ...prev,
          status: 'error',
          phase: 'error',
          issue: 'No optimize variables found (check Design Intent -> Optimize flags)',
          variableCount: 0,
        }));
        return;
      }

      (window as any).__cooptOptimizeStopRequested = false;
      try { (globalThis as any).__stopOptimization = false; } catch (_) {}
      try { await clearOptimizerStop(); } catch (_) {}
      try {
        const g = window as any;
        if (g.__cooptStopPulseTimer) {
          clearInterval(g.__cooptStopPulseTimer);
          g.__cooptStopPulseTimer = null;
        }
      } catch (_) {}
      setOptStopRequested(false);
      setOptRunning(true);
      optimizeDisplaySleepBlockTokenRef.current = sleepBlockToken || null;
      if (sleepBlockToken) {
        try { await startPreventDisplaySleep(sleepBlockToken); } catch (_) {}
      } else {
        try { await acquireOptimizeWakeLock(); } catch (_) {}
      }
      setOptimizeState((prev: any) => ({
        ...prev,
        status: 'running',
        phase: 'starting',
        modeUsed: optMethod,
        iterations: 0,
        acceptCount: 0,
        rejectCount: 0,
        issue: '-',
        percent: 0,
        progressEvents: [],
      }));

      const sourceRows = (() => {
        try {
          const table = hostWindow.tableSource || w.tableSource;
          if (table && typeof table.getData === 'function') {
            const d = table.getData();
            if (Array.isArray(d)) return d;
          }
        } catch (_) {}
        return [];
      })();

      const objectRows = (() => {
        try {
          const table = hostWindow.tableObject || w.tableObject;
          if (table && typeof table.getData === 'function') {
            const d = table.getData();
            if (Array.isArray(d)) return d;
          }
        } catch (_) {}
        return [];
      })();

      try {
        if (typeof hostWindow.__cooptInitMeritFunctionEditor === 'function') {
          hostWindow.__cooptInitMeritFunctionEditor();
        }
      } catch (_) {}
      try {
        if (typeof w.__cooptInitMeritFunctionEditor === 'function') {
          w.__cooptInitMeritFunctionEditor();
        }
      } catch (_) {}

      try {
        let tsAcceptCount = 0;
        let tsRejectCount = 0;
        let tsBestScore = Number.POSITIVE_INFINITY;
        let tsBestRequirementScore = Number.POSITIVE_INFINITY;
        let renderSyncSequence = 0;
        let lastRenderSyncAt = 0;
        const RENDER_SYNC_MIN_INTERVAL_MS = 400;
        const renderSyncQueue: any[][] = [];
        let renderSyncInFlight = false;
        let lastQueuedRenderSyncSignature = '';
        let lastCompletedRenderSyncSignature = '';
        let reqEvalInFlight = false;
        let optimizeFinalized = false;
        let lastReqEvalAt = 0;
        const REQ_EVAL_THROTTLE_MS = 1200;

        const materializeAutoImageSemidiaForRender = async (rowsInput: any[], allowHeavyTrace = true): Promise<any[]> => {
          const rows = Array.isArray(rowsInput) ? (cloneJsonLocal(rowsInput) || rowsInput) : [];
          if (!Array.isArray(rows) || rows.length === 0) return [];

          const imageSurfaceIndex = rows.findIndex((row: any) => {
            const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
            const normalized = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
            return normalized === 'image' || normalized.startsWith('image');
          });
          if (imageSurfaceIndex < 0) return rows;

          const imageSurface = rows[imageSurfaceIndex] || null;
          const opt = String(imageSurface?.optimizeSemiDia ?? '').trim().toUpperCase();
          const semidiaRaw = imageSurface?.semidia;
          const semidiaMode = String(imageSurface?.semidiaMode ?? '').trim().toLowerCase();
          const shouldAuto = opt === 'A' || String(semidiaRaw ?? '').trim().toLowerCase() === 'auto' || semidiaMode === 'auto';
          if (!shouldAuto) return rows;
          if (!allowHeavyTrace) return rows;

          try {
            const rays = await collectLegacyCrossRays(rows, 'BOTH');
            const chiefRays = Array.isArray(rays)
              ? rays.filter((ray: any) => {
                  const label = String(ray?.beamType ?? ray?.type ?? ray?.originalRay?.type ?? '').trim().toLowerCase();
                  const isChiefLike = !label
                    || label.includes('chief')
                    || label.includes('center')
                    || label.includes('middle');
                  return isChiefLike && Array.isArray(ray?.rayPath) && ray.rayPath.length > 0;
                })
              : [];
            const candidateRays = chiefRays.length > 0 ? chiefRays : (Array.isArray(rays) ? rays : []);
            if (candidateRays.length === 0) return rows;

            const isCoordTransRow = (row: any) => {
              const st = String(row?.surfType ?? row?.['surf type'] ?? row?.surface_type ?? '').trim().toLowerCase();
              return st === 'coord trans' || st === 'coordinate break' || st === 'coordtrans' || st === 'coordinatebreak' || st === 'ct';
            };
            const isObjectRow = (row: any) => {
              const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? '';
              return String(raw ?? '').trim().toLowerCase() === 'object';
            };
            const isGapRow = (row: any) => String(row?._blockType ?? '').trim() === 'Gap';
            const isThinLensBackRow = (row: any) => {
              const blockType = String(row?._blockType ?? row?.blockType ?? row?.block_type ?? row?.blockTypeName ?? '').trim().toLowerCase();
              if (blockType !== 'thinlens' && blockType !== 'paraxial') return false;
              return String(row?._surfaceRole ?? row?.surfaceRole ?? '').trim().toLowerCase() === 'back';
            };
            const getRayPathPointIndexForSurfaceIndex = (surfaceIndex: number) => {
              let count = 0;
              for (let index = 0; index <= surfaceIndex; index += 1) {
                const row = rows[index];
                if (isCoordTransRow(row) || isObjectRow(row) || isGapRow(row) || isThinLensBackRow(row)) continue;
                count += 1;
              }
              return count > 0 ? count : null;
            };
            const imageRayPathIndex = getRayPathPointIndexForSurfaceIndex(imageSurfaceIndex);
            const pickImagePointFromRay = (ray: any) => {
              const candidatePaths = [ray?.rayPath, ray?.rayPathToTarget, ray?.path, ray?.originalRay?.rayPath];
              for (const path of candidatePaths) {
                if (!Array.isArray(path) || path.length === 0) continue;
                if (imageRayPathIndex !== null && imageRayPathIndex >= 0 && imageRayPathIndex < path.length) {
                  const direct = path[imageRayPathIndex];
                  if (direct && Number.isFinite(Number(direct.x)) && Number.isFinite(Number(direct.y))) return direct;
                }
                for (let index = path.length - 1; index >= 0; index -= 1) {
                  const point = path[index];
                  const pointSurfaceIndex = Number(point?.surfaceIndex ?? point?.surface ?? point?.surfaceIdx);
                  if (Number.isInteger(pointSurfaceIndex) && pointSurfaceIndex === imageSurfaceIndex) {
                    if (Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y))) return point;
                  }
                }
              }
              return null;
            };

            const surfaceInfos = calculateSurfaceOrigins(rows);
            const imageSurfaceInfo = Array.isArray(surfaceInfos) ? surfaceInfos[imageSurfaceIndex] : null;
            let maxHeight = 0;

            for (const ray of candidateRays) {
              const imagePoint = pickImagePointFromRay(ray);
              if (!imagePoint) continue;
              const localPoint = imageSurfaceInfo ? transformPointToLocal(imagePoint, imageSurfaceInfo) : imagePoint;
              const localX = Number(localPoint?.x);
              const localY = Number(localPoint?.y);
              if (!Number.isFinite(localX) || !Number.isFinite(localY)) continue;
              const height = Math.max(Math.abs(localX), Math.abs(localY));
              if (Number.isFinite(height) && height > maxHeight) {
                maxHeight = height;
              }
            }

            if (maxHeight > 0) {
              const resolvedSemidia = applyRenderAutoApertureMargin(maxHeight);
              rows[imageSurfaceIndex] = {
                ...rows[imageSurfaceIndex],
                semidia: resolvedSemidia,
                __cooptActualSemidia: resolvedSemidia,
              };
            }
          } catch (_) {}

          return rows;
        };

        const resolveRowsForRender = (rowsFromProgress?: any[]): any[] => {
          let rowsForRender: any[] = [];
          try {
            const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
            const localOverride = g && Array.isArray(g.__cooptOpticalSystemRowsOverride) && g.__cooptOpticalSystemRowsOverride.length > 0
              ? g.__cooptOpticalSystemRowsOverride
              : null;
            const hostOverride = hostWindow && Array.isArray((hostWindow as any).__cooptOpticalSystemRowsOverride) && (hostWindow as any).__cooptOpticalSystemRowsOverride.length > 0
              ? (hostWindow as any).__cooptOpticalSystemRowsOverride
              : null;
            const tableRows = (typeof w.getOpticalSystemRows === 'function') ? w.getOpticalSystemRows(w.tableOpticalSystem) : [];
            const hostTableRows = (hostWindow !== w && typeof hostWindow.getOpticalSystemRows === 'function')
              ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem)
              : [];
            const progressRows = Array.isArray(rowsFromProgress) && rowsFromProgress.length > 0
              ? rowsFromProgress
              : null;
            const currentRows = progressRows ?? localOverride ?? hostOverride ?? tableRows ?? hostTableRows ?? [];
            rowsForRender = Array.isArray(currentRows) ? currentRows : [];
          } catch (_) {
            rowsForRender = [];
          }
          return Array.isArray(rowsForRender) ? (cloneJsonLocal(rowsForRender) || rowsForRender) : [];
        };

        const performRenderSync = async (rowsForRender: any[], options?: { finalizeAutoSemidia?: boolean }) => {
          if (!optAutoRenderOnAccept) return;

          const renderRows = await materializeAutoImageSemidiaForRender(rowsForRender, options?.finalizeAutoSemidia === true);

          // Ensure Render window is opened/focused in desktop mode as auto-render target.
          try {
            const openRender = (hostWindow as any).__cooptOpenRenderWindow || (window as any).__cooptOpenRenderWindow;
            if (isTauriRuntime() && typeof openRender === 'function') {
              await Promise.resolve(openRender());
              await new Promise<void>((resolve) => setTimeout(resolve, 220));
            } else if (typeof (hostWindow as any).handleRender3D === 'function') {
              (hostWindow as any).handleRender3D();
            } else {
              const openBtn = hostWindow?.document?.getElementById?.('open-3d-window-btn') as HTMLButtonElement | null;
              if (openBtn && typeof openBtn.click === 'function') {
                openBtn.click();
              }
            }
          } catch (_) {}

          // Signal the main window via localStorage (works across Tauri WebviewWindows
          // where hostWindow === w and direct DOM access is impossible).
          const payloadToken = `${Date.now()}-${++renderSyncSequence}`;
          const objectRows = getRenderObjectRows(hostWindow as any, renderRows);
          const systemConfig = (() => {
            try {
              const cfg = getSystemConfigFromWindow(hostWindow as any);
              return cfg && typeof cfg === 'object' ? (cloneJson(cfg) || cfg) : null;
            } catch (_) {
              return null;
            }
          })();

          try {
            const payload = {
              ts: payloadToken,
              token: payloadToken,
              rows: renderRows,
              objectRows,
              systemConfig,
              senderId: getOrCreateCooptWindowSyncSenderId(),
            };
            localStorage.setItem('coopt.renderSyncRequest', JSON.stringify(payload));
            if (isTauriRuntime()) {
              await (async () => {
                try {
                  const core = await import('@tauri-apps/api/core');
                  if (core && typeof (core as any).invoke === 'function') {
                    let synced = false;
                    for (let attempt = 0; attempt < 5 && !synced; attempt += 1) {
                      try {
                        await (core as any).invoke('sync_render_rows', { rows: renderRows });
                        synced = true;
                      } catch (_) {
                        if (attempt >= 4) throw _;
                      }
                      if (!synced) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 180));
                      }
                    }
                  }
                } catch (_) {}
                try {
                  const mod = await import('@tauri-apps/api/event');
                  if (mod && typeof (mod as any).emit === 'function') {
                    await (mod as any).emit('coopt-render-sync-request', payload);
                  }
                } catch (_) {}
              })();
            }
          } catch (_) {}

          // Guard the draw path so it prefers accepted rows during optimize progress sync.
          let prevHostRunning: any;
          let prevHostRowsOverride: any;
          let prevLocalRunning: any;
          let prevLocalRowsOverride: any;
          try {
            prevHostRunning = (hostWindow as any).__cooptOptimizerIsRunning;
            prevHostRowsOverride = (hostWindow as any).__cooptOpticalSystemRowsOverride;
            prevLocalRunning = (w as any).__cooptOptimizerIsRunning;
            prevLocalRowsOverride = (w as any).__cooptOpticalSystemRowsOverride;
            if (renderRows.length > 0) {
              (hostWindow as any).__cooptOpticalSystemRowsOverride = renderRows;
              (w as any).__cooptOpticalSystemRowsOverride = renderRows;
            }
            (hostWindow as any).__cooptOptimizerIsRunning = true;
            (w as any).__cooptOptimizerIsRunning = true;
          } catch (_) {}

          try {
            if (typeof hostWindow.drawOpticalSystem === 'function') {
              hostWindow.drawOpticalSystem();
            }
          } catch (_) {}
          try {
            const popup = hostWindow.popup3DWindow;
            if (popup && !popup.closed) {
              if (typeof popup.__cooptRenderWindowRedraw === 'function') {
                if (systemConfig) {
                  try {
                    popup.__cooptPendingRenderSystemConfig = systemConfig;
                    popup.__cooptSystemConfig = systemConfig;
                    popup.__cooptPreferRuntimeSystemConfig = true;
                  } catch (_) {}
                }
                await Promise.resolve(popup.__cooptRenderWindowRedraw(renderRows, payloadToken, objectRows));
              } else if (typeof popup.postMessage === 'function') {
                try { popup.__cooptPendingRenderRows = renderRows; } catch (_) {}
                try { popup.__cooptPendingRenderObjectRows = objectRows; } catch (_) {}
                if (systemConfig) {
                  try {
                    popup.__cooptPendingRenderSystemConfig = systemConfig;
                    popup.__cooptSystemConfig = systemConfig;
                    popup.__cooptPreferRuntimeSystemConfig = true;
                  } catch (_) {}
                }
                popup.postMessage({ action: 'request-redraw', rows: renderRows, objectRows, systemConfig, ts: payloadToken, token: payloadToken }, '*');
                await new Promise<void>((resolve) => setTimeout(resolve, 180));
              }
            }
          } catch (_) {}
          try {
            if (hostWindow !== w && typeof w.drawOpticalSystem === 'function') {
              w.drawOpticalSystem();
            }
          } catch (_) {}

          try {
            (hostWindow as any).__cooptOptimizerIsRunning = prevHostRunning;
            (hostWindow as any).__cooptOpticalSystemRowsOverride = prevHostRowsOverride;
            (w as any).__cooptOptimizerIsRunning = prevLocalRunning;
            (w as any).__cooptOpticalSystemRowsOverride = prevLocalRowsOverride;
          } catch (_) {}
        };

        const drainRenderSyncQueue = async () => {
          if (renderSyncInFlight) return;
          renderSyncInFlight = true;
          try {
            while (renderSyncQueue.length > 0) {
              const nextRequest = renderSyncQueue.shift();
              const nextRows = Array.isArray(nextRequest?.rows) ? nextRequest.rows : null;
              if (!Array.isArray(nextRows) || nextRows.length === 0) continue;
              const nextSignature = buildRenderRowsSignature(nextRows);
              if (nextSignature && nextSignature === lastCompletedRenderSyncSignature) continue;
              await performRenderSync(nextRows, { finalizeAutoSemidia: nextRequest?.finalizeAutoSemidia === true });
              lastCompletedRenderSyncSignature = nextSignature;
            }
          } finally {
            renderSyncInFlight = false;
          }
        };

        const requestRenderSync = (rowsFromProgress?: any[], options?: { finalizeAutoSemidia?: boolean }) => {
          const rowsForRender = resolveRowsForRender(rowsFromProgress);
          if (!Array.isArray(rowsForRender) || rowsForRender.length === 0) return;
          const signature = buildRenderRowsSignature(rowsForRender);
          if (signature && (signature === lastQueuedRenderSyncSignature || signature === lastCompletedRenderSyncSignature)) {
            return;
          }
          if (renderSyncInFlight) {
            renderSyncQueue.length = 0;
          }
          renderSyncQueue.push({ rows: rowsForRender, finalizeAutoSemidia: options?.finalizeAutoSemidia === true });
          lastQueuedRenderSyncSignature = signature;
          void drainRenderSyncQueue();
        };

        const loadHostConfigSnapshot = () => {
          try {
            const cfg = getSystemConfigFromWindow(hostWindow);
            return cloneJsonLocal(cfg);
          } catch (_) {
            return null;
          }
        };

        const loadHostRowsSnapshot = () => {
          try {
            const r = typeof hostWindow.getOpticalSystemRows === 'function'
              ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem)
              : [];
            return Array.isArray(r) ? (cloneJsonLocal(r) || []) : [];
          } catch (_) {
            return [];
          }
        };

        const beforeHostConfigSnapshot = clickSnapshot?.config ?? loadHostConfigSnapshot();
        const beforeHostRowsSnapshot = clickSnapshot?.rows ?? loadHostRowsSnapshot();

        const getRequirementTableScoreSnapshot = () => {
          try {
            const sre = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
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
                  const c = Number.isFinite(Number(row?._contribution)) ? Number(row._contribution) : Number(row?.score);
                  if (Number.isFinite(c) && c > 0) {
                    sum += c;
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

        const scheduleRequirementRefresh = (progressEvent?: any) => {
          if (optimizeFinalized) return;
          const now = Date.now();
          if (reqEvalInFlight) return;
          if ((now - lastReqEvalAt) < REQ_EVAL_THROTTLE_MS) return;
          lastReqEvalAt = now;
          reqEvalInFlight = true;

          void (async () => {
            try {
              const sre = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
              const payloadReqSnapshot = Array.isArray(progressEvent?.requirementSnapshots)
                ? progressEvent.requirementSnapshots
                : null;
              const dbg = (w.__cooptLastOptimizerResidualDebug && typeof w.__cooptLastOptimizerResidualDebug === 'object')
                ? w.__cooptLastOptimizerResidualDebug
                : null;
              const reqSnapshot = (payloadReqSnapshot && payloadReqSnapshot.length > 0)
                ? payloadReqSnapshot
                : (Array.isArray(dbg?.requirementsSnapshot) ? dbg.requirementsSnapshot : null);

              const progressPhase = String(progressEvent?.phase ?? '').trim().toLowerCase();
              const shouldAllowFallbackEval = progressPhase === 'accept' || progressPhase === 'done' || progressPhase === 'stopped';

              let appliedSnapshot = false;
              if (sre && typeof sre.applyOptimizerRequirementSnapshot === 'function' && reqSnapshot && reqSnapshot.length > 0) {
                appliedSnapshot = !!sre.applyOptimizerRequirementSnapshot(reqSnapshot);
              }

              if (!appliedSnapshot && shouldAllowFallbackEval && sre && typeof sre.evaluateAndUpdateNow === 'function') {
                const p = sre.evaluateAndUpdateNow({ reason: 'optimize-progress-live', forceSilent: true, silent: true });
                if (p && typeof (p as any).then === 'function') {
                  await p;
                }
              }

              if (!appliedSnapshot && !shouldAllowFallbackEval) {
                return;
              }

              const snap = getRequirementTableScoreSnapshot();
              const tableScore = Number(snap.score);
              if (!Number.isFinite(tableScore)) return;
              tsBestRequirementScore = Math.min(tsBestRequirementScore, tableScore);
              if (optimizeFinalized) return;

              setOptimizeState((prev: any) => ({
                ...prev,
                meritAfter: tableScore,
                requirementScoreAfter: tableScore,
                requirementScoreTable: tableScore,
                best: Number.isFinite(tsBestScore)
                  ? tsBestScore
                  : (Number.isFinite(tsBestRequirementScore)
                    ? tsBestRequirementScore
                    : prev.best),
              }));
            } catch (_) {
              // ignore live refresh failures and keep progress loop running
            } finally {
              reqEvalInFlight = false;
            }
          })();
        };

        const optimizerRunner = (() => {
          try {
            const hostOpt = hostWindow?.OptimizationMVP;
            if (hostWindow && hostWindow !== w && hostOpt && typeof hostOpt.run === 'function') {
              return {
                source: 'host-window',
                run: hostOpt.run.bind(hostOpt),
              };
            }
          } catch (_) {}
          return {
            source: 'local-window',
            run: runOptimizationMVP,
          };
        })();

        const tsResult: any = await optimizerRunner.run({
          opticalSystemRows: rows,
          sourceRows,
          objectRows,
          activeConfigId,
          systemRequirementsRows,
          method: optMethod,
          maxIterations,
          forceTs: true,
          shouldStop: () => !!(window as any).__cooptOptimizeStopRequested,
          onProgress: (ev: any) => {
            const phase = String(ev?.phase ?? 'running');
            const phaseLower = phase.toLowerCase();
            const progressMethod = String(ev?.method ?? (optMethod || 'kkt')).trim().toLowerCase();
            const iter = Number(ev?.iter ?? 0);
            try {
              const requirementSnapshots = Array.isArray(ev?.requirementSnapshots) ? ev.requirementSnapshots : [];
              if (requirementSnapshots.length > 0) {
                const payloadToken = `${Date.now()}-${iter}-${Math.random().toString(36).slice(2, 8)}`;
                const payload = {
                  ts: payloadToken,
                  token: payloadToken,
                  phase,
                  iter,
                  current: ev?.current,
                  best: ev?.best,
                  violationScore: ev?.violationScore,
                  requirementSnapshots,
                  rows: [],
                };
                localStorage.setItem(OPTIMIZE_PROGRESS_SYNC_KEY, JSON.stringify(payload));
                if (isTauriRuntime()) {
                  void (async () => {
                    try {
                      const mod = await import('@tauri-apps/api/event');
                      if (mod && typeof (mod as any).emit === 'function') {
                        await (mod as any).emit('coopt-optimize-progress', payload);
                      }
                    } catch (_) {}
                  })();
                }
              }
            } catch (_) {}
            scheduleRequirementRefresh(ev);
            const snap = getRequirementTableScoreSnapshot();
            const progressCurrentScore = Number(ev?.current);
            const progressBestScore = Number(ev?.best);
            const progressViolationScore = Number(ev?.violationScore);
            const tableScore = Number(snap.score);
            // ev.current = violationScore + softPenalty (total Requirement score)
            // ev.violationScore = hard violations only (fall back)
            const displayScore = Number.isFinite(progressCurrentScore)
              ? progressCurrentScore
              : (Number.isFinite(progressViolationScore)
                ? progressViolationScore
                : (Number.isFinite(tableScore) ? tableScore : Number.NaN));

            if (phaseLower === 'accept') tsAcceptCount += 1;
            if (phaseLower === 'reject') tsRejectCount += 1;
            if (Number.isFinite(progressBestScore)) {
              tsBestScore = Math.min(tsBestScore, progressBestScore);
            }
            if (Number.isFinite(displayScore)) {
              tsBestRequirementScore = Math.min(tsBestRequirementScore, displayScore);
            }

            const shouldAutoRenderPhase = phaseLower === 'accept' || phaseLower === 'done';
            if (shouldAutoRenderPhase) {
              const now = Date.now();
              if ((now - lastRenderSyncAt) >= RENDER_SYNC_MIN_INTERVAL_MS || phaseLower === 'done') {
                lastRenderSyncAt = now;
                requestRenderSync(
                  Array.isArray((ev as any)?.rows) ? (ev as any).rows : undefined,
                  { finalizeAutoSemidia: phaseLower === 'done' }
                );
              }
            }

            setOptimizeState((prev: any) => ({
              ...prev,
              status: 'running',
              phase,
              modeUsed: progressMethod || optMethod,
              iterations: iter,
              meritBefore: prev.meritBefore,
              meritAfter: Number.isFinite(displayScore) ? displayScore : prev.meritAfter,
              requirementScoreBefore: prev.requirementScoreBefore,
              requirementScoreAfter: Number.isFinite(displayScore) ? displayScore : prev.requirementScoreAfter,
              requirementScoreTable: Number.isFinite(displayScore) ? displayScore : prev.requirementScoreTable,
              acceptCount: tsAcceptCount,
              rejectCount: tsRejectCount,
              issue: '-',
              percent: maxIterations > 0 ? Math.round((Math.max(0, iter) / maxIterations) * 100) : 0,
              best: Number.isFinite(tsBestScore)
                ? tsBestScore
                : (Number.isFinite(tsBestRequirementScore)
                  ? tsBestRequirementScore
                  : prev.best),
            }));
          },
        });

        if (!tsResult || tsResult.ok !== true) {
          throw new Error(`[${optimizerRunner.source}] ${String(tsResult?.reason || 'TS/WASM optimizer returned non-ok result')}`);
        }

        const tsIterations = Number(tsResult?.iterations ?? NaN);
        const tsAborted = !!(tsResult?.aborted || (window as any).__cooptOptimizeStopRequested);
        // Stop 時は iterations=0 でも正常系として扱い、Best 復元・同期処理を継続する。
        if ((!Number.isFinite(tsIterations) || tsIterations <= 0) && !tsAborted) {
          throw new Error(`TS/WASM optimizer produced no iterations (iterations=${String(tsResult?.iterations)})`);
        }

        optimizeFinalized = true;

        const clearOptimizeRuntimeConfigOverride = () => {
          const clearTarget = (target: any) => {
            if (!target) return;
            try { delete target.__cooptPreferRuntimeSystemConfig; } catch (_) {}
            try { delete target.__cooptSystemConfig; } catch (_) {}
            try { delete target.__cooptDeferDerivedUiUntil; } catch (_) {}
          };
          clearTarget(hostWindow);
          if (w !== hostWindow) clearTarget(w);
        };

        const applyHostSystemConfigSnapshot = async (snapshot: any, rowsSnapshot?: any[]) => {
          const cloned = snapshot && typeof snapshot === 'object'
            ? (cloneJsonLocal(snapshot) || snapshot)
            : null;
          if (!cloned) return false;
          const applyToTarget = async (target: any) => {
            if (!target) return false;
            try {
              clearOptimizeRuntimeConfigOverride();
              if (typeof target.saveSystemConfigurationsFromTableConfig === 'function') {
                target.saveSystemConfigurationsFromTableConfig(cloneJsonLocal(cloned) || cloned);
              } else if (typeof target.saveSystemConfigurations === 'function') {
                target.saveSystemConfigurations(cloneJsonLocal(cloned) || cloned);
              }
              clearOptimizeRuntimeConfigOverride();
              if (Array.isArray(rowsSnapshot) && rowsSnapshot.length > 0) {
                const rows = cloneJsonLocal(rowsSnapshot) || rowsSnapshot;
                const table = target.tableOpticalSystem;
                const previousDepth = Number(target.__suppressOpticalSystemDataChangedDepth || 0);
                try {
                  target.__suppressOpticalSystemDataChangedDepth = previousDepth + 1;
                  target.__suppressOpticalSystemDataChanged = true;
                  if (table && typeof table.replaceData === 'function') {
                    await Promise.resolve(table.replaceData(rows));
                  } else if (table && typeof table.setData === 'function') {
                    await Promise.resolve(table.setData(rows));
                  }
                  if (typeof target.__cooptSyncRowsBackToActiveBlocks === 'function') {
                    target.__cooptSyncRowsBackToActiveBlocks(rows);
                  }
                } finally {
                  try {
                    setTimeout(() => {
                      target.__suppressOpticalSystemDataChangedDepth = previousDepth;
                      target.__suppressOpticalSystemDataChanged = previousDepth > 0;
                    }, 0);
                  } catch (_) {
                    target.__suppressOpticalSystemDataChangedDepth = previousDepth;
                    target.__suppressOpticalSystemDataChanged = previousDepth > 0;
                  }
                }
                try { requestRefreshBlockInspector(target); } catch (_) {}
                try { if (typeof target.refreshAllUI === 'function') target.refreshAllUI(); } catch (_) {}
                try { if (typeof target.drawOpticalSystem === 'function') target.drawOpticalSystem(); } catch (_) {}
              } else {
                const cm = target?.ConfigurationManager;
                if (cm && typeof cm.loadActiveConfigurationToTables === 'function') {
                  await Promise.resolve(cm.loadActiveConfigurationToTables({
                    applyToUI: true,
                    suppressOpticalSystemDataChanged: true,
                  }));
                } else if (typeof target.loadActiveConfigurationToTables === 'function') {
                  await Promise.resolve(target.loadActiveConfigurationToTables({
                    applyToUI: true,
                    suppressOpticalSystemDataChanged: true,
                  }));
                }
              }
              clearOptimizeRuntimeConfigOverride();
              return true;
            } catch (_) {
              return false;
            }
          };
          const hostApplied = await applyToTarget(hostWindow);
          if (!hostApplied && w !== hostWindow) return applyToTarget(w);
          return hostApplied;
        };

        clearOptimizeRuntimeConfigOverride();

        const resultConfigSnapshot = tsResult?.systemConfigSnapshot && typeof tsResult.systemConfigSnapshot === 'object'
          ? (cloneJsonLocal(tsResult.systemConfigSnapshot) || tsResult.systemConfigSnapshot)
          : null;
        const resultRowsSnapshot = Array.isArray(tsResult?.opticalSystemRowsSnapshot)
          ? (cloneJsonLocal(tsResult.opticalSystemRowsSnapshot) || tsResult.opticalSystemRowsSnapshot)
          : [];

        if (tsAborted && resultConfigSnapshot) {
          await applyHostSystemConfigSnapshot(resultConfigSnapshot, resultRowsSnapshot);
        }

        if (tsAborted) {
          try { localStorage.removeItem(OPTIMIZE_PROGRESS_SYNC_KEY); } catch (_) {}
          try { localStorage.removeItem(optimizeRowsSyncKey); } catch (_) {}
        }

        let afterHostConfigSnapshot: any = null;
        let afterHostRowsSnapshot: any[] = [];
        try {
          afterHostConfigSnapshot = resultConfigSnapshot || loadHostConfigSnapshot();
          afterHostRowsSnapshot = resultRowsSnapshot.length > 0 ? resultRowsSnapshot : loadHostRowsSnapshot();
          if (!tsAborted && typeof hostWindow.__cooptRecordOptimizationUndoFromSnapshots === 'function') {
            hostWindow.__cooptRecordOptimizationUndoFromSnapshots(
              beforeHostConfigSnapshot,
              beforeHostRowsSnapshot,
              afterHostConfigSnapshot,
              afterHostRowsSnapshot,
              'Optimization run'
            );
          }
        } catch (_) {}

        if (!tsAborted) {
          try {
            const latestRowsBeforeReload = hostWindow.getOpticalSystemRows ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem) : [];
            if (Array.isArray(latestRowsBeforeReload) && latestRowsBeforeReload.length > 0) {
              const finalizeRowsFn = hostWindow.__cooptRefreshRequirementTableScoreForOptimize;
              if (typeof finalizeRowsFn === 'function') {
                await finalizeRowsFn(latestRowsBeforeReload, 'optimize-finished-finalize', { syncBlocks: true });
              }
            }

            await syncHostDesignIntentAndRequirements(hostWindow, 'optimize-finished-reload', 'after');

            const rowsAfter = hostWindow.getOpticalSystemRows ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem) : [];
            if (Array.isArray(rowsAfter) && rowsAfter.length > 0) {
              await maybeAutoRender(rowsAfter);
              const applyToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
              localStorage.setItem(optimizeRowsSyncKey, JSON.stringify({
                rows: rowsAfter,
                token: applyToken,
                syncBlocks: true,
                beforeConfigSnapshot: beforeHostConfigSnapshot,
                beforeRowsSnapshot: beforeHostRowsSnapshot,
                afterConfigSnapshot: afterHostConfigSnapshot,
                afterRowsSnapshot: afterHostRowsSnapshot,
              }));
              try {
                const mod = await import('@tauri-apps/api/event');
                if (mod && typeof (mod as any).emit === 'function') {
                  await (mod as any).emit('coopt-optimize-rows-sync', {
                    rows: rowsAfter,
                    token: applyToken,
                    syncBlocks: true,
                    beforeConfigSnapshot: beforeHostConfigSnapshot,
                    beforeRowsSnapshot: beforeHostRowsSnapshot,
                    afterConfigSnapshot: afterHostConfigSnapshot,
                    afterRowsSnapshot: afterHostRowsSnapshot,
                  });
                }
              } catch (_) {}
            }
          } catch (_) {}

          try {
            const latestRows = hostWindow.getOpticalSystemRows ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem) : [];
            await syncHostDesignIntentAndRequirements(
              hostWindow,
              'optimize-finished-sync',
              'after',
              Array.isArray(latestRows) ? latestRows : []
            );
          } catch (_) {}
        }

        let finalTableScore = Number.NaN;
        if (!tsAborted) {
          try {
            const sre = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
            if (sre && typeof sre.evaluateAndUpdateNow === 'function') {
              const p = sre.evaluateAndUpdateNow({ reason: 'optimize-final-score', forceSilent: true, silent: true });
              if (p && typeof (p as any).then === 'function') {
                await p;
              }
            }
            if (sre && typeof sre.getData === 'function') {
              const rr = sre.getData();
              if (Array.isArray(rr)) {
                let sum = 0;
                let cnt = 0;
                for (const row of rr) {
                  const c = Number.isFinite(Number(row?._contribution)) ? Number(row._contribution) : Number(row?.score);
                  if (Number.isFinite(c) && c > 0) { sum += c; cnt += 1; }
                }
                if (cnt > 0 && Number.isFinite(sum)) finalTableScore = sum;
              }
            }
          } catch (_) {}
        }

        const resultBestScore = Number(tsResult?.best);
        const resultObjectiveScore = Number(tsResult?.objectiveScore);
        if (Number.isFinite(resultBestScore)) {
          tsBestScore = Math.min(tsBestScore, resultBestScore);
        }

        if (tsAborted && Number.isFinite(resultBestScore)) {
          finalTableScore = resultBestScore;
        }

        const finalScore = tsAborted
          ? (Number.isFinite(resultBestScore) ? resultBestScore : (Number.isFinite(resultObjectiveScore) ? resultObjectiveScore : Number.NaN))
          : (Number.isFinite(resultObjectiveScore)
            ? resultObjectiveScore
            : (Number.isFinite(finalTableScore) ? finalTableScore : Number.NaN));
        const finalBest = tsAborted
          ? (Number.isFinite(resultBestScore) ? resultBestScore : finalScore)
          : (Number.isFinite(tsBestScore)
            ? tsBestScore
            : (Number.isFinite(tsBestRequirementScore)
              ? tsBestRequirementScore
              : finalScore));
        const aborted = tsAborted;

        setOptimizeState((prev: any) => ({
          ...prev,
          status: aborted ? 'stopped' : 'done',
          phase: aborted ? 'stopped' : 'done',
          issue: aborted ? 'Stopped by user' : '-',
          iterations: Number.isFinite(tsIterations) ? tsIterations : prev.iterations,
          variableCount: Number.isFinite(Number(tsResult?.variables)) ? Number(tsResult.variables) : prev.variableCount,
          requirementCount: Number.isFinite(Number(tsResult?.hardViolations?.length))
            ? Number(tsResult.hardViolations.length)
            : prev.requirementCount,
          requirementScoreAfter: Number.isFinite(finalScore) ? finalScore : prev.requirementScoreAfter,
          requirementScoreTable: Number.isFinite(finalTableScore)
            ? finalTableScore
            : (Number.isFinite(finalScore) ? finalScore : prev.requirementScoreTable),
          meritAfter: Number.isFinite(finalTableScore) ? finalTableScore
            : (Number.isFinite(finalScore) ? finalScore : prev.meritAfter),
          best: Number.isFinite(finalBest) ? finalBest : prev.best,
          percent: 100,
        }));

      } catch (tsErr) {
        setOptimizeState((prev: any) => ({
          ...prev,
          status: 'error',
          phase: 'error',
          issue: (tsErr as any)?.message || String(tsErr),
          percent: 100,
        }));
      } finally {
        try {
          delete w.__cooptPreferRuntimeSystemConfig;
          delete w.__cooptSystemConfig;
        } catch (_) {}
        try {
          if (hostWindow) {
            delete hostWindow.__cooptPreferRuntimeSystemConfig;
            delete hostWindow.__cooptSystemConfig;
          }
        } catch (_) {}
        const activeSleepBlockToken = optimizeDisplaySleepBlockTokenRef.current;
        optimizeDisplaySleepBlockTokenRef.current = null;
        if (activeSleepBlockToken) {
          try { await stopPreventDisplaySleep(activeSleepBlockToken); } catch (_) {}
        }
        try { await releaseOptimizeWakeLock(); } catch (_) {}
        try { await clearOptimizerStop(); } catch (_) {}
        try {
          const g = window as any;
          if (g.__cooptStopPulseTimer) {
            clearInterval(g.__cooptStopPulseTimer);
            g.__cooptStopPulseTimer = null;
          }
        } catch (_) {}
        setOptRunning(false);
        setOptStopRequested(false);
        (window as any).__cooptOptimizeStopRequested = false;
        try { (globalThis as any).__stopOptimization = false; } catch (_) {}
        try {
          (window as any).__cooptOptimizerIsRunning = false;
          if (hostWindow && hostWindow !== w) {
            hostWindow.__cooptOptimizerIsRunning = false;
          }
        } catch (_) {}
      }
    };

    return (
      <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', background: '#f4f4f4', color: '#222', padding: 12, boxSizing: 'border-box', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600, flex: '0 0 auto' }}>Optimize Progress</div>
          <div style={{ height: 6, background: '#eceef2', borderRadius: 999, overflow: 'hidden', flex: '1 1 auto', minWidth: 120 }}>
            <div style={{ width: `${percent}%`, height: '100%', background: '#4f8cff', transition: 'width 120ms linear' }} />
          </div>
          <div style={{ fontSize: 12, color: '#666', flex: '0 0 auto' }}>{optRunning ? 'Running' : String(optimizeState?.status || 'Idle')}</div>
        </div>
        <div style={{ fontSize: 12, color: '#555' }}>Updates per candidate evaluation (±step)</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" disabled={optRunning} onClick={() => { void runOptimize(); }} style={{ padding: '6px 10px' }}>Run</button>
          <button type="button" disabled={!optRunning} onClick={() => {
            (window as any).__cooptOptimizeStopRequested = true;
            try { (globalThis as any).__stopOptimization = true; } catch (_) {}
            setOptStopRequested(true);
            try {
              const wAny = window as any;
              if (wAny.OptimizationMVP && typeof wAny.OptimizationMVP.stop === 'function') {
                wAny.OptimizationMVP.stop();
              }
              const op = wAny.opener;
              if (op && !op.closed && op.OptimizationMVP && typeof op.OptimizationMVP.stop === 'function') {
                op.OptimizationMVP.stop();
              }
            } catch (_) {}
            setOptimizeState((prev: any) => ({ ...prev, phase: 'stopping', issue: 'Stop requested...' }));
          }} style={{ padding: '6px 10px' }}>Stop</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: '#555', display: 'flex', alignItems: 'center', gap: 6 }}>
            Method
            <select value={optMethod} disabled={optRunning} onChange={(e) => setOptMethod((e.target.value as 'kkt' | 'lm' | 'cd'))} style={{ padding: '4px 6px' }}>
              <option value="kkt">Augmented Lagrangian (AL)</option>
              <option value="lm">Levenberg-Marquardt (LM)</option>
              <option value="cd">Coordinate Descent (CD)</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: '#555', display: 'flex', alignItems: 'center', gap: 6 }}>
            Max Iterations
            <input
              type="number"
              min={1}
              step={1}
              value={optMaxIterations}
              disabled={optRunning}
              onChange={(e) => {
                const n = Number(e.target.value);
                setOptMaxIterations(Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1);
              }}
              style={{ width: 100, padding: '4px 6px' }}
            />
          </label>
          <label style={{ fontSize: 12, color: '#555', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={optAutoRenderOnAccept} disabled={optRunning} onChange={(e) => setOptAutoRenderOnAccept(!!e.target.checked)} style={{ width: 16, height: 16 }} />
            Auto-render
          </label>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Phase</span><span>{String(optimizeState?.phase || '-')}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Decision</span><span>{String(optimizeState?.phase === 'accept' ? 'ACCEPT' : optimizeState?.phase === 'reject' ? 'REJECT' : '-')}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Accept/Reject</span><span>{`${Number(optimizeState?.acceptCount || 0)} / ${Number(optimizeState?.rejectCount || 0)}`}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Iter</span><span>{String(optimizeState?.iterations ?? 0)}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Vars</span><span>{String(optimizeState?.variableCount ?? 0)}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Req</span><span>{String(optimizeState?.requirementCount ?? '-')}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Score</span><span>{Number.isFinite(Number(optimizeState?.meritAfter)) ? Number(optimizeState.meritAfter).toFixed(6) : '-'}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Best</span><span>{Number.isFinite(Number(optimizeState?.best)) ? Number(optimizeState.best).toFixed(6) : '-'}</span></div>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><span style={{ display: 'inline-block', width: 110, color: '#555' }}>Issue</span><span>{String(optimizeState?.issue || '-')}</span></div>
        </div>
      </div>
    );
  }

  useEffect(() => {
    if (!(analysisWindowMode.enabled && analysisWindowMode.analysis === 'astigmatism')) return;
    setAstigBusy(false);
    setAstigProgress(0);
    setAstigProgressText('');
    setAstigStatus('Press Show to render');
  }, [analysisWindowMode.enabled, analysisWindowMode.analysis]);

  if (analysisWindowMode.enabled && analysisWindowMode.analysis === 'system-data') {
    const isBrowserSystemDataPage = !isTauriRuntime();

    return (
      <>
        <div style={{ height: '100vh', width: '100vw', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#f4f4f4' }}>
          <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex' }}>
            <SystemDataPanel visible />
          </div>
        </div>
        <div style={{ display: 'none' }}>
          <MainToolbar />
          <ConfigurationSection />
          <SourceObjectSection />
          <DesignIntentSection />
          <RequirementsSection />
        </div>
      </>
    );
  }

  if (analysisWindowMode.enabled && analysisWindowMode.analysis === 'astigmatism') {
    const rerenderAstigmatism = async () => {
      const w = window as any;
      if (typeof w.showAstigmatismDiagram !== 'function') {
        setAstigStatus('Astigmatism function unavailable');
        return;
      }
      setAstigBusy(true);
      setAstigProgress(0);
      setAstigProgressText('Preparing...');
      setAstigStatus('');
      try {
        await ensurePlotlyLoaded();
        await Promise.resolve(w.showAstigmatismDiagram({
          containerId: 'analysis-astig-container',
          chiefRayDefinition: astigChiefRayDefinition,
          pattern: astigBeamPattern,
          rayCount: astigRayCount,
          ringCount: astigRingCount,
          onProgress: ({ percent, message }: { percent?: number; message?: string }) => {
            let nextPercent: number | null = null;
            if (typeof percent === 'number' && Number.isFinite(percent)) {
              nextPercent = Math.max(0, Math.min(100, percent));
              setAstigProgress(nextPercent);
            }
            if (typeof message === 'string' && message.trim()) {
              setAstigProgressText(message);
            } else if (nextPercent !== null) {
              setAstigProgressText(`${Math.round(nextPercent)}%`);
            }
          },
        }));
        setAstigProgress(100);
        setAstigProgressText('Done');
        await new Promise<void>((resolve) => window.setTimeout(resolve, 700));
        setAstigProgress(0);
        setAstigProgressText('');
      } catch (err) {
        setAstigProgressText('');
        setAstigStatus(`Astigmatism error: ${(err as any)?.message || String(err)}`);
      } finally {
        setAstigBusy(false);
      }
    };

    return (
      <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', background: '#f4f4f4' }}>
        <div style={{ padding: '10px 12px', background: '#f8f8f8', borderBottom: '1px solid #ddd', display: 'flex', gap: 10, alignItems: 'center' }}>
          <label htmlFor="analysis-astig-chief-ray" style={{ fontSize: 12, color: '#333' }}>Chief ray:</label>
          <select
            id="analysis-astig-chief-ray"
            value={astigChiefRayDefinition}
            onChange={(e) => setAstigChiefRayDefinition(e.target.value)}
            style={{ padding: '5px 8px', fontSize: 12, border: '1px solid #bbb', borderRadius: 4, background: 'white' }}
          >
            <option value="stop-center">Stop center</option>
            <option value="beam-midpoint">Beam midpoint</option>
            <option value="beam-centroid">Beam centroid</option>
          </select>
          <label htmlFor="analysis-astig-beam-pattern" style={{ fontSize: 12, color: '#333' }}>Beam:</label>
          <select
            id="analysis-astig-beam-pattern"
            value={astigBeamPattern}
            onChange={(e) => setAstigBeamPattern(e.target.value as 'cross' | 'grid' | 'annular')}
            style={{ padding: '5px 8px', fontSize: 12, border: '1px solid #bbb', borderRadius: 4, background: 'white' }}
          >
            <option value="cross">Cross</option>
            <option value="grid">Grid</option>
            <option value="annular">Annular</option>
          </select>
          <label htmlFor="analysis-astig-ray-count" style={{ fontSize: 12, color: '#333' }}>Rays:</label>
          <input
            id="analysis-astig-ray-count"
            type="number"
            min={9}
            max={2001}
            step={1}
            value={astigRayCount}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              if (!Number.isFinite(parsed)) return;
              setAstigRayCount(Math.max(9, Math.min(2001, Math.round(parsed))));
            }}
            style={{ width: 88, padding: '5px 8px', fontSize: 12, border: '1px solid #bbb', borderRadius: 4, background: 'white' }}
          />
          {astigBeamPattern === 'annular' && (
            <>
              <label htmlFor="analysis-astig-ring-count" style={{ fontSize: 12, color: '#333' }}>Rings:</label>
              <input
                id="analysis-astig-ring-count"
                type="number"
                min={1}
                max={64}
                step={1}
                value={astigRingCount}
                onChange={(e) => {
                  const parsed = Number(e.target.value);
                  if (!Number.isFinite(parsed)) return;
                  setAstigRingCount(Math.max(1, Math.min(64, Math.round(parsed))));
                }}
                style={{ width: 78, padding: '5px 8px', fontSize: 12, border: '1px solid #bbb', borderRadius: 4, background: 'white' }}
              />
            </>
          )}
          <button
            type="button"
            onClick={rerenderAstigmatism}
            disabled={astigBusy}
            style={{ padding: '6px 10px', border: '1px solid #bbb', borderRadius: 4, background: '#f8f8f8', cursor: astigBusy ? 'default' : 'pointer', fontSize: 12 }}
          >
            {astigBusy ? 'Rendering...' : 'Show'}
          </button>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: astigStatus.startsWith('Astigmatism error:') ? '#b00020' : '#666' }}>
            {astigStatus || ''}
          </span>
        </div>
        {(astigBusy || !!astigProgressText) && (
          <>
            <div style={{ padding: '6px 12px', fontSize: 12, color: '#333', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 40 }}>{Math.round(astigProgress)}%</span>
              <span>{astigProgressText || 'Calculating...'}</span>
            </div>
            <div style={{ height: 4, background: '#e6e6e6', width: '100%' }}>
              <div
                style={{
                  height: '100%',
                  width: `${astigProgress}%`,
                  background: '#1677ff',
                  transition: 'width 120ms linear'
                }}
              />
            </div>
          </>
        )}
        <div id="analysis-astig-container" style={{ flex: 1, minHeight: 0, background: 'white' }} />
      </div>
    );
  }

  if (analysisWindowMode.enabled) {
    return (
      <>
        <div style={{ height: '100vh', width: '100vw', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f4f4f4', color: '#444', fontSize: 13 }}>
          Launching analysis window...
        </div>
        <div style={{ display: 'none' }}>
          <MainToolbar />
          <ConfigurationSection />
          <SourceObjectSection />
          <DesignIntentSection />
        </div>
      </>
    );
  }

  if (isRenderWindowMode) {

    const handleRenderDraw = async () => {
      try {
        const w = window as any;
        const startupStages: RenderTimingStage[] = [];
        try {
          const cm = w.ConfigurationManager;
          if (cm && typeof cm.loadActiveConfigurationToTables === 'function') {
            const startMs = performance.now();
            await Promise.resolve(cm.loadActiveConfigurationToTables({ applyToUI: true }));
            startupStages.push({ label: 'load', ms: performance.now() - startMs });
          }
        } catch (_) {}

        try {
          if (typeof w.initializeAllTables === 'function') {
            const startMs = performance.now();
            w.initializeAllTables();
            startupStages.push({ label: 'tables', ms: performance.now() - startMs });
          }
        } catch (_) {}

        ensureRenderCanvasAttached();

        try {
          const startMs = performance.now();
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          startupStages.push({ label: 'raf', ms: performance.now() - startMs });
        } catch (_) {}

        let rowCount = 0;
        try {
          if (typeof w.getOpticalSystemRows === 'function') {
            const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
            rowCount = Array.isArray(rows) ? rows.length : 0;
          }
        } catch (_) {}

        if (rowCount === 0) {
          setRenderWindowStatus('No optical data');
          setRenderLensColorTargets([]);
          return;
        }

        try {
          if (typeof w.getOpticalSystemRows === 'function') {
            const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
            refreshRenderLensTargets(rows);
          }
        } catch (_) {
          refreshRenderLensTargets([]);
        }

        renderViewModeRef.current = '3D';
        setRenderViewMode('3D');
        const ok = await drawRender3DView(startupStages, beginRenderDrawRequest());
        if (!ok) return;

        ensureRenderCanvasAttached();
      } catch (err) {
        console.error('[RenderWindow] Manual draw failed:', err);
        setRenderWindowStatus('Draw failed');
      }
    };

    const handleViewXZ = () => {
      renderViewAxisRef.current = 'XZ';
      renderViewModeRef.current = 'XZ';
      setRenderViewAxis('XZ');
      setRenderViewMode('XZ');
      refreshRenderLensTargets();
      scheduleRenderRedraw('XZ', 'XZ').catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    };

    const handleViewYZ = () => {
      renderViewAxisRef.current = 'YZ';
      renderViewModeRef.current = 'YZ';
      setRenderViewAxis('YZ');
      setRenderViewMode('YZ');
      refreshRenderLensTargets();
      scheduleRenderRedraw('YZ', 'YZ').catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    };

    const handleRenderCompareScopeChange = (scope: RenderCompareScope) => {
      if (renderViewModeRef.current === '3D') {
        const sectionAxis = renderViewAxisRef.current === 'XZ' ? 'XZ' : 'YZ';
        renderViewAxisRef.current = sectionAxis;
        renderViewModeRef.current = sectionAxis;
        setRenderViewAxis(sectionAxis);
        setRenderViewMode(sectionAxis);
      }
      setRenderCompareScope(scope);
    };

    const handleSetLensColor = (target: RenderLensColorTarget, colorHex: string | null) => {
      const keys = Array.isArray(target?.keys) ? target.keys : [target?.key];
      const validKeys = [...new Set(keys.map((k) => String(k || '').trim()).filter(Boolean))];
      if (validKeys.length === 0) return;
      const next = { ...loadSurfaceColorOverridesSafe() };
      if (!colorHex) {
        for (const k of validKeys) delete next[k];
      } else {
        for (const k of validKeys) next[k] = colorHex;
      }
      saveSurfaceColorOverridesSafe(next);
      setRenderColorUiRevision((v) => v + 1);
      scheduleRenderRedraw().catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    };

    const handleResetAllLensColors = () => {
      const next = { ...loadSurfaceColorOverridesSafe() };
      for (const target of renderLensColorTargets) {
        const keys = Array.isArray(target?.keys) ? target.keys : [target?.key];
        for (const k of keys) {
          const kk = String(k || '').trim();
          if (kk) delete next[kk];
        }
      }
      saveSurfaceColorOverridesSafe(next);
      setRenderColorUiRevision((v) => v + 1);
      scheduleRenderRedraw().catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    };

    const handleToggleRenderLabels = (enabled: boolean) => {
      setRenderShowDesignIntentLabels(enabled);
      try {
        localStorage.setItem(RENDER_SHOW_LABELS_KEY, enabled ? 'true' : 'false');
      } catch (_) {}
    };

    const handleToggleRenderPrincipalPoints = (enabled: boolean) => {
      setRenderShowPrincipalPointLabels(enabled);
      try {
        localStorage.setItem(RENDER_SHOW_PRINCIPAL_POINTS_KEY, enabled ? 'true' : 'false');
      } catch (_) {}
    };

    const handleToggleRenderSurfaceNumbers = (enabled: boolean) => {
      setRenderShowSurfaceNumberLabels(enabled);
      try {
        localStorage.setItem(RENDER_SHOW_SURFACE_NUMBERS_KEY, enabled ? 'true' : 'false');
      } catch (_) {}
    };

    const handleToggleRenderDesignIntentLiveSync = (enabled: boolean) => {
      setRenderDesignIntentLiveSync(enabled);
      try {
        localStorage.setItem(RENDER_DESIGN_INTENT_SYNC_KEY, enabled ? 'true' : 'false');
      } catch (_) {}
    };

    const comparePreviewEntries = renderCompareScope === 'all' ? getRenderCompareEntries(window as any) : [];
    const comparePreviewOffsets = buildRenderCompareOffsets(comparePreviewEntries.length);
    const comparePreviewReferenceImageZ = resolveRenderCompareReferenceZ(comparePreviewEntries);
    const compareDirectionLabel = renderViewMode === 'YZ'
      ? (renderCompareOffsetDirection === 'positive' ? 'Up' : renderCompareOffsetDirection === 'negative' ? 'Down' : 'Centered')
      : (renderCompareOffsetDirection === 'positive' ? 'Right' : renderCompareOffsetDirection === 'negative' ? 'Left' : 'Centered');
    const compareAlignLabel = renderCompareAlignReference === 'image' ? 'Image' : 'Object';
    return (
      <>
        <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', margin: 0 }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #ddd', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={handleRenderDraw}>Render</button>
            <button type="button" onClick={handleViewXZ}>X-Z View</button>
            <button type="button" onClick={handleViewYZ}>Y-Z View</button>
            <label htmlFor="render-compare-scope" style={{ marginLeft: 12, fontSize: 12, fontWeight: 500 }}>Configs</label>
            <select
              id="render-compare-scope"
              value={renderCompareScope}
              onChange={(e) => handleRenderCompareScopeChange(e.target.value === 'all' ? 'all' : 'active')}
              style={{ height: 28 }}
            >
              <option value="active">Active only</option>
              <option value="all">All configs</option>
            </select>
            <label htmlFor="render-compare-direction" style={{ fontSize: 12, fontWeight: 500, opacity: renderCompareScope === 'all' ? 1 : 0.5 }}>
              {renderViewMode === 'YZ' ? 'Offset Y' : 'Offset X'}
            </label>
            <select
              id="render-compare-direction"
              value={renderCompareOffsetDirection}
              onChange={(e) => setRenderCompareOffsetDirection((e.target.value as RenderCompareOffsetDirection) || 'centered')}
              disabled={renderCompareScope !== 'all'}
              style={{ height: 28 }}
            >
              <option value="centered">Centered</option>
              <option value="positive">{renderViewMode === 'YZ' ? 'Up' : 'Right'}</option>
              <option value="negative">{renderViewMode === 'YZ' ? 'Down' : 'Left'}</option>
            </select>
            <label htmlFor="render-compare-step" style={{ fontSize: 12, fontWeight: 500, opacity: renderCompareScope === 'all' ? 1 : 0.5 }}>Step (mm)</label>
            <input
              id="render-compare-step"
              type="number"
              min={0}
              step={1}
              value={renderCompareOffsetStepMm}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                setRenderCompareOffsetStepMm(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0);
              }}
              disabled={renderCompareScope !== 'all'}
              style={{ width: 86 }}
            />
            <label htmlFor="render-compare-align" style={{ fontSize: 12, fontWeight: 500, opacity: renderCompareScope === 'all' && renderViewMode !== '3D' ? 1 : 0.5 }}>Align</label>
            <select
              id="render-compare-align"
              value={renderCompareAlignReference}
              onChange={(e) => setRenderCompareAlignReference(e.target.value === 'image' ? 'image' : 'object')}
              disabled={renderCompareScope !== 'all' || renderViewMode === '3D'}
              style={{ height: 28 }}
            >
              <option value="object">Object</option>
              <option value="image">Image</option>
            </select>
            <label htmlFor="render-ray-count-input" style={{ marginLeft: 12, fontSize: 12, fontWeight: 500 }}>Raynum</label>
            <input
              id="render-ray-count-input"
              type="number"
              min={1}
              max={10001}
              step={1}
              value={renderRayCount}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                if (Number.isFinite(parsed) && parsed > 0) {
                  setRenderRayCount(parsed);
                } else if (e.target.value === '') {
                  setRenderRayCount(5);
                }
              }}
              style={{ width: 84 }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500 }}>
              <input
                type="checkbox"
                checked={renderShowDesignIntentLabels}
                onChange={(e) => handleToggleRenderLabels(e.target.checked)}
              />
              Labels
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500 }}>
              <input
                type="checkbox"
                checked={renderShowPrincipalPointLabels}
                onChange={(e) => handleToggleRenderPrincipalPoints(e.target.checked)}
              />
              Paraxial
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500 }}>
              <input
                type="checkbox"
                checked={renderShowSurfaceNumberLabels}
                onChange={(e) => handleToggleRenderSurfaceNumbers(e.target.checked)}
              />
              Surface No.
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500 }} title="Reflect Design Intent numeric edits in an open Render window">
              <input
                type="checkbox"
                checked={renderDesignIntentLiveSync}
                onChange={(e) => handleToggleRenderDesignIntentLiveSync(e.target.checked)}
              />
              Intent Sync
            </label>
            {renderCompareScope === 'all' && (
              <span style={{ fontWeight: 400, fontSize: 12, color: '#666' }}>
                {renderViewMode === '3D'
                  ? 'Compare offset applies to X-Z / Y-Z views.'
                  : `${comparePreviewEntries.length || 0} configs, ${compareDirectionLabel}, step ${Math.max(0, Number(renderCompareOffsetStepMm) || 0)} mm, align ${compareAlignLabel}`}
              </span>
            )}
            <span style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 12, color: '#666' }}>{renderWindowStatus}</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#fff', overflow: 'hidden' }}>
              <div
                id="threejs-canvas-container"
                aria-label="Optical system 3D canvas"
                style={{
                  width: '100%',
                  height: '100%',
                  minHeight: 0,
                  opacity: renderViewportVisible ? 1 : 0,
                  transition: 'opacity 90ms linear',
                }}
              />
              {!renderViewportVisible && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)',
                    color: '#334155',
                    fontSize: 14,
                    fontWeight: 600,
                    letterSpacing: '0.01em',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '0 28px', textAlign: 'center' }}>
                    <div>{String(renderWindowStatus || '').trim() || 'Initializing...'}</div>
                    {String(renderStartupBreakdown || '').trim() && (
                      <div style={{ fontSize: 12, fontWeight: 500, color: '#475569', letterSpacing: '0', maxWidth: 720 }}>
                        {renderStartupBreakdown}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {renderCompareScope === 'all' && renderViewMode !== '3D' && comparePreviewEntries.length > 1 && (
                <div
                  style={{
                    position: 'absolute',
                    top: 12,
                    left: 12,
                    zIndex: 3,
                    background: 'rgba(255,255,255,0.9)',
                    border: '1px solid rgba(17,24,39,0.12)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    maxWidth: 260,
                    boxShadow: '0 8px 20px rgba(0,0,0,0.08)',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#111827' }}>Compare Offsets</div>
                  {comparePreviewEntries.map((entry, index) => {
                    const offset = comparePreviewOffsets[index] || 0;
                    const signed = offset > 0 ? `+${offset}` : `${offset}`;
                    const imageZ = renderCompareAlignReference === 'image' ? resolveRenderCompareImageZ(entry.rows) : null;
                    const zOffset = (Number.isFinite(Number(comparePreviewReferenceImageZ)) && Number.isFinite(Number(imageZ)))
                      ? Number(comparePreviewReferenceImageZ) - Number(imageZ)
                      : 0;
                    const zSigned = zOffset > 0 ? `+${zOffset.toFixed(3)}` : zOffset.toFixed(3);
                    return (
                      <div key={entry.configId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 12, color: '#374151' }}>
                        <span style={{ fontWeight: entry.isActive ? 700 : 500 }}>{entry.name}{entry.isActive ? ' (active)' : ''}</span>
                        <span>{renderCompareAlignReference === 'image' ? `${signed} mm, Z ${zSigned}` : `${signed} mm`}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <RenderUcsIcon />
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: 14,
                  transform: 'translateX(-50%)',
                  pointerEvents: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  alignItems: 'center',
                }}
              >
                <div style={{ position: 'relative', width: `${renderScaleBarWidthPx}px`, height: 14 }}>
                  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderTop: '2px solid #111827' }} />
                  {Array.from({ length: 11 }).map((_, idx) => {
                    const isMajor = idx === 0 || idx === 10;
                    const isMid = idx === 5;
                    return (
                      <div
                        key={idx}
                        style={{
                          position: 'absolute',
                          left: `${(idx / 10) * 100}%`,
                          bottom: 0,
                          width: 0,
                          height: isMajor ? 12 : (isMid ? 9 : 6),
                          borderLeft: '2px solid #111827',
                          transform: idx === 10 ? 'translateX(-2px)' : 'none',
                        }}
                      />
                    );
                  })}
                </div>
                <span style={{ width: `${renderScaleBarWidthPx}px`, fontSize: 11, lineHeight: 1, color: '#111827', fontWeight: 600, textShadow: '0 0 2px rgba(255,255,255,0.95)', textAlign: 'right' }}>{renderScaleLabel}</span>
              </div>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  bottom: 0,
                  width: renderSurfaceColorsCollapsed ? 34 : 274,
                  borderLeft: '1px solid #ddd',
                  background: '#fafafa',
                  display: 'flex',
                  flexDirection: 'column',
                  transition: 'width 120ms ease',
                  overflow: 'hidden',
                  zIndex: 2,
                  boxShadow: renderSurfaceColorsCollapsed ? 'none' : '-4px 0 12px rgba(0,0,0,0.08)',
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setRenderSurfaceColorsCollapsed((prev) => {
                      const next = !prev;
                      if (!next) refreshRenderLensTargets();
                      return next;
                    });
                  }}
                  title={renderSurfaceColorsCollapsed ? 'Open surface colors' : 'Collapse surface colors'}
                  style={{
                    width: '100%',
                    border: 0,
                    borderBottom: '1px solid #e3e3e3',
                    background: '#f0f0f0',
                    textAlign: 'left',
                    padding: renderSurfaceColorsCollapsed ? '10px 8px' : '10px 10px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {renderSurfaceColorsCollapsed ? '▶' : '▼ Surface Colors'}
                </button>

                {!renderSurfaceColorsCollapsed && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid #ececec' }}>
                      <button type="button" onClick={() => { refreshRenderLensTargets(); }} style={{ fontSize: 11, padding: '4px 8px' }}>Refresh</button>
                      <button type="button" onClick={handleResetAllLensColors} style={{ fontSize: 11, padding: '4px 8px' }}>Reset All</button>
                    </div>
                    <div style={{ padding: 8, overflow: 'auto', flex: 1, minHeight: 0 }}>
                      {renderLensColorTargets.length === 0 ? (
                        <div style={{ fontSize: 12, color: '#777' }}>No object intervals detected.</div>
                      ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                          <thead>
                            <tr>
                              <th style={{ textAlign: 'left', padding: '4px 2px', borderBottom: '1px solid #ddd' }}>Object</th>
                              <th style={{ textAlign: 'left', padding: '4px 2px', borderBottom: '1px solid #ddd' }}>Color</th>
                            </tr>
                          </thead>
                          <tbody>
                            {renderLensColorTargets.map((target) => {
                              const overrides = loadSurfaceColorOverridesSafe();
                              const selectedHex = resolveOverrideColorHex(overrides, target.keys) || '#00CCFF';
                              return (
                                <tr key={`${target.key}-${target.frontSurfaceIndex0}`}>
                                  <td style={{ padding: '5px 2px', borderBottom: '1px solid #eee' }}>{target.label}</td>
                                  <td style={{ padding: '5px 2px', borderBottom: '1px solid #eee' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                      <select
                                        value={resolveOverrideColorHex(loadSurfaceColorOverridesSafe(), target.keys) ?? ''}
                                        onChange={(e) => handleSetLensColor(target, e.target.value || null)}
                                        style={{ flex: 1, minWidth: 0, fontSize: 11, backgroundColor: selectedHex }}
                                      >
                                        <option value="">Default</option>
                                        {RENDER_SURFACE_COLOR_PALETTE.map((entry) => (
                                          <option key={entry.hex} value={entry.hex}>{entry.name}</option>
                                        ))}
                                      </select>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        <div style={{ display: 'none' }}>
          <MainToolbar />
          <ConfigurationSection />
          <SourceObjectSection />
          <DesignIntentSection />
          <RequirementsSection />
          <LegacyPanels />
        </div>
      </>
    );
  }

  const selectWorkspaceTab = (focus: WorkspaceFocus) => {
    if (workspaceFocus === focus) return;

    setWorkspaceFocus(focus);

    try {
      if (window.scrollY > 0) {
        window.scrollTo({ top: 0, behavior: 'auto' });
      }
    } catch (_) {}

    try {
      window.requestAnimationFrame(() => {
        try {
          const w = window as any;
          if (focus === 'source') {
            w.tableSource?.redraw?.(true);
            w.tableObject?.redraw?.(true);
            return;
          }
          if (focus === 'intent') {
            w.tableOpticalSystem?.redraw?.(true);
          }
        } catch (_) {}
      });
    } catch (_) {}
  };

  useEffect(() => {
    const w = window as any;
    w.__cooptFocusZoomTab = () => {
      selectWorkspaceTab('zoom');
      try {
        const container = document.getElementById('zoom-container');
        container?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (_) {}
    };

    return () => {
      try {
        if (w.__cooptFocusZoomTab) delete w.__cooptFocusZoomTab;
      } catch (_) {
        w.__cooptFocusZoomTab = undefined;
      }
    };
  }, []);

  const workspaceSections: Array<{
    key: WorkspaceFocus;
    label: string;
    icon: string;
  }> = [
    { key: 'configuration', label: 'System', icon: '🧭' },
    { key: 'source', label: 'Sources / Objects', icon: '🔎' },
    { key: 'intent', label: 'Design Intent', icon: '🧩' },
    { key: 'requirements', label: 'Requirements', icon: '📏' },
    { key: 'zoom', label: 'Zoom', icon: '🔭' },
    { key: 'literature', label: 'Patent', icon: '📚' },
  ];

  const variableCountSummary = (() => {
    try {
      return countBlockOptimizeVariables(window);
    } catch (_) {
      return 0;
    }
  })();

  const optimizeStatusText = optRunning ? 'Running' : String(optimizeState?.status || 'Idle');
  const optimizeTone = optRunning
    ? '#2563eb'
    : (String(optimizeState?.status || '').toLowerCase() === 'error' ? '#b91c1c' : '#4b5563');
  const activeWorkspaceLabel = workspaceSections.find((s) => s.key === workspaceFocus)?.label || 'System';
  const [openMenu, setOpenMenu] = useState<null | 'file' | 'data' | 'edit' | 'view' | 'run' | 'analysis' | 'settings'>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const menuHost = document.querySelector('.app-shell__menubar');
      if (menuHost && !menuHost.contains(target)) {
        setOpenMenu(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const closeWorkspaceMenus = () => {
    setOpenMenu(null);
  };

  const toggleWorkspaceMenu = (menu: 'file' | 'data' | 'edit' | 'view' | 'run' | 'analysis' | 'settings') => () => {
    setOpenMenu((current) => (current === menu ? null : menu));
  };

  const handleMenuMouseEnter = (menu: 'file' | 'data' | 'edit' | 'view' | 'run' | 'analysis' | 'settings') => {
    setOpenMenu(menu);
  };

  const handleMenuMouseLeave = () => {
    setOpenMenu(null);
  };

  const runMenuAction = (action: () => void) => () => {
    closeWorkspaceMenus();
    action();
  };

  const runAnalysisAction = (value: string) => () => {
    closeWorkspaceMenus();
    handleAnalysisSelect(value);
  };

  const handleUndoMenu = () => {
    try {
      (window as any).undoHistory?.undo?.();
    } catch (_) {}
  };

  const handleRedoMenu = () => {
    try {
      (window as any).undoHistory?.redo?.();
    } catch (_) {}
  };

  const renderWorkspaceTabContent = () => {
    return (
      <>
        <div className={`app-shell__tabBody${workspaceFocus === 'configuration' ? '' : ' is-hidden'}`}>
          <ConfigurationSection />
        </div>
        <div className={`app-shell__tabBody${workspaceFocus === 'source' ? '' : ' is-hidden'}`}>
          <SourceObjectSection />
        </div>
        <div className={`app-shell__tabBody${workspaceFocus === 'intent' ? '' : ' is-hidden'}`}>
          <DesignIntentSection />
        </div>
        <div className={`app-shell__tabBody${workspaceFocus === 'literature' ? '' : ' is-hidden'}`}>
          <LiteratureImportPanel />
        </div>
        <div className={`app-shell__tabBody${workspaceFocus === 'zoom' ? '' : ' is-hidden'}`}>
          <ZoomSection />
        </div>
        <div className={`app-shell__tabBody${workspaceFocus === 'requirements' ? '' : ' is-hidden'}`}>
          <RequirementsSection />
        </div>
      </>
    );
  };

  return (
    <div className="app-shell">
      <div className="app-shell__header">
        <MainToolbar minimal />
      </div>

      <div className="app-shell__menubar" role="menubar" aria-label="Application menu" onMouseLeave={handleMenuMouseLeave}>
        <div className={`app-shell__menu${openMenu === 'file' ? ' is-open' : ''}`} onMouseEnter={() => handleMenuMouseEnter('file')}>
          <button type="button" className="app-shell__menuSummary" aria-haspopup="menu" aria-expanded={openMenu === 'file'} onClick={toggleWorkspaceMenu('file')}>File</button>
          <div className="app-shell__menuPanel" role="menu">
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleNewFile)}>New</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleLoad)}>Load…</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleLoadDefault)}>Load Default</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleSave)}>Save</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleShareUrl)}>Share URL</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleClearStorage)}>Clear Cache</button>
          </div>
        </div>

        <div className={`app-shell__menu${openMenu === 'data' ? ' is-open' : ''}`} onMouseEnter={() => handleMenuMouseEnter('data')}>
          <button type="button" className="app-shell__menuSummary" aria-haspopup="menu" aria-expanded={openMenu === 'data'} onClick={toggleWorkspaceMenu('data')}>Data</button>
          <div className="app-shell__menuPanel" role="menu">
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleImportZemax)}>Import Zemax</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleExportZemax)}>Export Zemax</button>
          </div>
        </div>

        <div className={`app-shell__menu${openMenu === 'edit' ? ' is-open' : ''}`} onMouseEnter={() => handleMenuMouseEnter('edit')}>
          <button type="button" className="app-shell__menuSummary" aria-haspopup="menu" aria-expanded={openMenu === 'edit'} onClick={toggleWorkspaceMenu('edit')}>Edit</button>
          <div className="app-shell__menuPanel" role="menu">
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleUndoMenu)}>Undo</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleRedoMenu)}>Redo</button>
          </div>
        </div>

        <div className={`app-shell__menu${openMenu === 'view' ? ' is-open' : ''}`} onMouseEnter={() => handleMenuMouseEnter('view')}>
          <button type="button" className="app-shell__menuSummary" aria-haspopup="menu" aria-expanded={openMenu === 'view'} onClick={toggleWorkspaceMenu('view')}>View</button>
          <div className="app-shell__menuPanel" role="menu">
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleRender3D)}>Open Render</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleSystemData)}>Open System Data</button>
          </div>
        </div>

        <div className={`app-shell__menu${openMenu === 'run' ? ' is-open' : ''}`} onMouseEnter={() => handleMenuMouseEnter('run')}>
          <button type="button" className="app-shell__menuSummary" aria-haspopup="menu" aria-expanded={openMenu === 'run'} onClick={toggleWorkspaceMenu('run')}>Run</button>
          <div className="app-shell__menuPanel" role="menu">
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleOptimize)}>Optimize</button>
          </div>
        </div>

        <div className={`app-shell__menu${openMenu === 'analysis' ? ' is-open' : ''}`} onMouseEnter={() => handleMenuMouseEnter('analysis')}>
          <button type="button" className="app-shell__menuSummary" aria-haspopup="menu" aria-expanded={openMenu === 'analysis'} onClick={toggleWorkspaceMenu('analysis')}>Analysis</button>
          <div className="app-shell__menuPanel" role="menu">
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('spot-diagram')}>Spot Diagram</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('spherical-aberration')}>Spherical Aberration</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('astigmatism')}>Astigmatism</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('distortion')}>Distortion</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('distortion-grid')}>Distortion Grid</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('magnification-chromatic-aberration')}>Lateral Chromatic Aberration</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('integrated-aberration')}>Integrated Aberration</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('transverse-aberration')}>Transverse Aberration</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('opd')}>Optical Path Difference</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('psf')}>Point Spread Function</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('mtf')}>Modulation Transfer Function</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('through-focus-spot')}>Through-Focus Spot</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('through-focus-mtf')}>Through-Focus MTF</button>
            <button type="button" className="app-shell__menuAction" onClick={runAnalysisAction('field-mtf')}>Object MTF</button>
          </div>
        </div>

        <div className={`app-shell__menu${openMenu === 'settings' ? ' is-open' : ''}`} onMouseEnter={() => handleMenuMouseEnter('settings')}>
          <button type="button" className="app-shell__menuSummary" aria-haspopup="menu" aria-expanded={openMenu === 'settings'} onClick={toggleWorkspaceMenu('settings')}>Settings</button>
          <div className="app-shell__menuPanel" role="menu">
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleOpenSettings)}>Open Settings</button>
          </div>
        </div>
      </div>

      <div className="app-shell__body app-shell__body--tabs">
        <main className="app-shell__workspace">
          <section className="app-shell__workspacePane">
            <div className="app-shell__tabbar" role="tablist" aria-label="Workspace tabs">
              {workspaceSections.map((section) => (
                <button
                  key={section.key}
                  type="button"
                  role="tab"
                  aria-selected={workspaceFocus === section.key}
                  className={`app-shell__tabButton${workspaceFocus === section.key ? ' is-active' : ''}`}
                  onClick={() => selectWorkspaceTab(section.key)}
                >
                  <span>{section.label}</span>
                </button>
              ))}
            </div>

            <div className="app-shell__tabPanel">
              {renderWorkspaceTabContent()}
            </div>
          </section>
        </main>
      </div>

      <div className="app-shell__statusbar">
        <span>Ready</span>
        <span>•</span>
        <span>View: {activeWorkspaceLabel}</span>
        <span>•</span>
        <span>Variables: {variableCountSummary}</span>
        <span>•</span>
        <span>Optimizer: {optimizeStatusText}</span>
      </div>

      <div style={{ display: 'none' }}>
        <LegacyPanels />
      </div>
    </div>
  );
}
