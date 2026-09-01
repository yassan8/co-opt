import { useEffect, useRef, useState } from "react";
import Plotly from 'plotly.js-dist-min';
import * as THREE from 'three';
import { BasicAnalysisPage, type BasicAnalysisType } from './BasicAnalysisPage';
import { DistortionAnalysisPage } from './DistortionAnalysisPage';
import { MtfAnalysisPage } from './MtfAnalysisPage';
import { PsfAnalysisPage } from './PsfAnalysisPage';
import { MultiFieldPsfPage } from './MultiFieldPsfPage';
import { ImageSimulationPage } from './ImageSimulationPage';
import ToleranceAnalysisPage from './ToleranceAnalysisPage';
import {
  DESIGN_CONNECTION_SELECTED_EVENT,
  installNonSequentialRenderOverlay,
  PORT_ROUTED_RENDER_STATUS_EVENT,
  RENDER_CONNECTIONS_STORAGE_KEY,
  RENDER_CONNECTIONS_VISIBILITY_EVENT,
  type PortRoutedRenderStatusDetail,
} from './nonsequential-render-overlay';
import { CoherentInterferometerPage } from './CoherentInterferometerEntry';
import { cloneOptimizeConfigWithLiveObjectRows } from './optimize-run-config';
import { WavefrontAnalysisPage } from './WavefrontAnalysisPage';
import { AnalysisRayCountField } from './AnalysisRayCountField';
import {
  getOptimizedResultApplySnapshots,
  injectActiveOpticalRows,
  selectCanonicalOptimizedRows,
} from './optimized-result-sync.ts';
import MainToolbar from "../ui/components/MainToolbar";
import ConfigurationSection from "../ui/components/ConfigurationSection";
import SourceObjectSection, { FieldSection, SourceSection } from "../ui/components/SourceObjectSection";
import DesignIntentSection from "../ui/components/DesignIntentSection";
import RequirementsSection from "../ui/components/RequirementsSection";
import LegacyPanels from "../ui/components/LegacyPanels";
import { LiteratureImportPanel, SystemDataPanel } from "../ui/components/LegacyPanels";
import {
  handleClearStorage,
  handleExportZemax,
  handleImportZemax,
  handleLoad,
  handleLoadExample,
  handleNewFile,
  handleSave,
  handleShareUrl,
} from "../../ui/toolbar-handlers";
import { OPTIMIZER_POLICY_ID, runOptimizationMVP } from "../../optimization/optimizer-mvp.ts";
import { listDesignVariablesFromBlocks } from "../../optimization/design-variables.ts";
import { clearOptimizerStop, exportFreeCadDocument, readDesktopSetting, releaseWebOptimizerWorkerResources, runNativeChiefRayAngle, startPreventDisplaySleep, stopPreventDisplaySleep, writeDesktopSetting } from "../../src/desktop/ipc/client.ts";
import { isTauriRuntime } from "../../src/desktop/runtime.ts";
import { getOrCreateCooptWindowSyncSenderId, requestRefreshBlockInspector } from "../../core/window-facade.ts";
import { calculateSurfaceOrigins, transformPointToGlobal, transformPointToLocal, traceRay, traceRayHitPoint } from "../../raytracing/core/ray-tracing.ts";
import { calculateParaxialData } from "../../raytracing/core/ray-paraxial.ts";
import { calculateChiefRayNewton } from "../../evaluation/aberrations/transverse-aberration.ts";
import { convertImageHeightToEffectiveObject, generateRayStartPointsForObject, solveRayOriginToStopPointFast } from "../../optical/ray-renderer.ts";
import { findStopSurface } from "../../optical/system-renderer.ts";
import { detectConjugateType } from "../../utils/conjugate-detection.ts";
import { listBundledExampleProjectFiles } from "../../utils/default-project-loader.ts";
import { getLoadedFileName, getLoadedFileWarn } from "../../ui/loaded-file-storage";
import { createOpticalSceneSolidGroup, downloadStl, generateOpticalSceneStl } from "../../import-export/stl-export.ts";
import { downloadFreeCadDocument, generateFreeCadDocument } from "../../import-export/freecad-export.ts";
import {
  loadOptimizeRayGridSize,
  OPTIMIZE_RAY_GRID_SIZES,
  saveOptimizeRayGridSize,
  type OptimizeRayGridSize,
} from "../../ui/optimization-settings-storage.ts";
import { getRustRayTracingWasmSync } from "../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts";
import {
  calculateOptimizeConsoleImprovement,
  formatOptimizeConsoleCell,
  formatOptimizeConsoleHeader,
  formatOptimizeConsoleRow,
  formatOptimizeElapsed,
  shouldAppendOptimizeConsoleRow,
} from './optimize-console-format.ts';
import { calculateMdiTileLayout, type MdiTileRect } from './mdi-layout.ts';

const SURFACE_COLOR_OVERRIDES_STORAGE_KEY = 'coopt.surfaceColorOverrides';
const RENDER_SHOW_LABELS_KEY = 'coopt.render.showDesignIntentLabels';
const RENDER_SHOW_PRINCIPAL_POINTS_KEY = 'coopt.render.showPrincipalPointLabels';
const RENDER_SHOW_SURFACE_NUMBERS_KEY = 'coopt.render.showSurfaceNumberLabels';
const RENDER_SHOW_SOLIDS_KEY = 'coopt.render.showSolids';
const RENDER_SHOW_SECTION_CUT_KEY = 'coopt.render.showSectionCut';
const RENDER_SECTION_ANGLE_KEY = 'coopt.render.sectionAngleDegrees';
const RENDER_DESIGN_INTENT_SYNC_KEY = 'coopt.render.designIntentLiveSync';
const OPTIMIZE_PROGRESS_SYNC_KEY = 'coopt.optimizeProgress';
const NAVIGATOR_COLLAPSED_KEY = 'coopt.workspace.navigatorCollapsed';
const NAVIGATOR_TREE_GROUPS_KEY = 'coopt.workspace.navigatorTreeGroups';
const SYSTEM_TEXT_WINDOW_ID = 'system-text-window';
const SYSTEM_TEXT_WINDOW_TITLE = 'System Console';
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

const EXAMPLE_PROJECT_FILES = listBundledExampleProjectFiles();

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

const WORKSPACE_KEYS = ['configuration', 'source', 'field', 'intent', 'literature', 'requirements'] as const;
type WorkspaceFocus = typeof WORKSPACE_KEYS[number];

type MdiAuxWindowState = {
  id: string;
  title: string;
  url: string;
  open: boolean;
  minimized: boolean;
  maximized: boolean;
  restoreBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
};

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
const RENDER_IMAGEHEIGHT_EXACT_CROSS_CACHE_VERSION = 'imageheight-exact-cross-v8';

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
  if (axis !== 'BOTH') {
    const getType = (ray: any) => String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase();
    const getAxisCoord = (ray: any) => {
      const stopAxis = Number(ray?.__cooptStopAxisCoord ?? ray?.originalRay?.__cooptStopAxisCoord);
      if (Number.isFinite(stopAxis)) return stopAxis;
      if (axis === 'XZ') {
        const startX = Number(
          ray?.rayStart?.startP?.x
          ?? ray?.rayStart?.origin?.x
          ?? ray?.originalRay?.origin?.x
          ?? ray?.originalRay?.position?.x
          ?? ray?.originalRay?.pos?.x
          ?? ray?.rayPath?.[0]?.x
        );
        if (Number.isFinite(startX)) return startX;
        const planeU = Number(ray?.rayStart?.planeCoords?.u ?? ray?.originalRay?.planeCoords?.u ?? ray?.planeCoords?.u);
        return Number.isFinite(planeU) ? planeU : Number.NaN;
      }
      const startY = Number(
        ray?.rayStart?.startP?.y
        ?? ray?.rayStart?.origin?.y
        ?? ray?.originalRay?.origin?.y
        ?? ray?.originalRay?.position?.y
        ?? ray?.originalRay?.pos?.y
        ?? ray?.rayPath?.[0]?.y
      );
      if (Number.isFinite(startY)) return startY;
      const planeV = Number(ray?.rayStart?.planeCoords?.v ?? ray?.originalRay?.planeCoords?.v ?? ray?.planeCoords?.v);
      return Number.isFinite(planeV) ? planeV : Number.NaN;
    };
    const chief = ordered.find((ray) => getType(ray) === 'chief') || null;
    if (desiredCount === 1) return chief ? [chief] : ordered.slice(0, 1);

    const finiteCandidates = ordered
      .filter((ray) => ray !== chief)
      .map((ray) => ({ ray, coord: getAxisCoord(ray) }))
      .filter((entry) => Number.isFinite(entry.coord));
    if (finiteCandidates.length === 0) return chief ? [chief] : ordered.slice(0, desiredCount);

    const minCoord = Math.min(...finiteCandidates.map((entry) => entry.coord));
    const maxCoord = Math.max(...finiteCandidates.map((entry) => entry.coord));
    const chiefCoordRaw = chief ? getAxisCoord(chief) : Number.NaN;
    const centerCoord = Number.isFinite(chiefCoordRaw) ? chiefCoordRaw : (minCoord + maxCoord) / 2;
    const remaining = [...finiteCandidates];
    const selected = chief ? [chief] : [];
    const slots = Math.max(0, desiredCount - selected.length);
    const negativeSlots = Math.floor(slots / 2);
    const positiveSlots = slots - negativeSlots;
    const pickUniformSide = (from: number, count: number) => {
      for (let index = count; index >= 1; index -= 1) {
        if (remaining.length === 0) break;
        const target = centerCoord + (from - centerCoord) * (index / count);
        let bestIndex = 0;
        for (let candidateIndex = 1; candidateIndex < remaining.length; candidateIndex += 1) {
          if (Math.abs(remaining[candidateIndex].coord - target) < Math.abs(remaining[bestIndex].coord - target)) {
            bestIndex = candidateIndex;
          }
        }
        selected.push(remaining.splice(bestIndex, 1)[0].ray);
      }
    };
    pickUniformSide(minCoord, negativeSlots);
    pickUniformSide(maxCoord, positiveSlots);
    return selected.slice(0, desiredCount);
  }
  const getType = (ray: any) => String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase();
  const chief = ordered.find((ray) => getType(ray) === 'chief') || null;
  if (desiredCount === 1) return chief ? [chief] : ordered.slice(0, 1);

  const getStopCoord = (ray: any, coordAxis: 'x' | 'y') => {
    const key = coordAxis === 'x' ? '__cooptStopXCoord' : '__cooptStopYCoord';
    const stopCoord = Number(ray?.[key] ?? ray?.originalRay?.[key]);
    if (Number.isFinite(stopCoord)) return stopCoord;
    const startCoord = Number(ray?.rayStart?.startP?.[coordAxis] ?? ray?.originalRay?.origin?.[coordAxis]);
    return Number.isFinite(startCoord) ? startCoord : Number.NaN;
  };
  const selectUniformAxis = (candidates: any[], coordAxis: 'x' | 'y', count: number) => {
    if (count <= 0) return [];
    const center = chief ? getStopCoord(chief, coordAxis) : 0;
    const finite = candidates
      .map((ray) => ({ ray, coord: getStopCoord(ray, coordAxis) }))
      .filter((entry) => Number.isFinite(entry.coord));
    const negative = finite.filter((entry) => entry.coord < center - 1e-9);
    const positive = finite.filter((entry) => entry.coord > center + 1e-9);
    const negativeCount = Math.floor(count / 2);
    const positiveCount = count - negativeCount;
    const selected: any[] = [];
    const pickSide = (entries: Array<{ ray: any; coord: number }>, sideCount: number, extremeMode: 'min' | 'max') => {
      if (sideCount <= 0 || entries.length === 0) return;
      const pool = [...entries];
      const extreme = extremeMode === 'min'
        ? Math.min(...pool.map((entry) => entry.coord))
        : Math.max(...pool.map((entry) => entry.coord));
      for (let index = sideCount; index >= 1; index -= 1) {
        if (pool.length === 0) break;
        const target = center + (extreme - center) * (index / sideCount);
        let bestIndex = 0;
        for (let candidateIndex = 1; candidateIndex < pool.length; candidateIndex += 1) {
          if (Math.abs(pool[candidateIndex].coord - target) < Math.abs(pool[bestIndex].coord - target)) {
            bestIndex = candidateIndex;
          }
        }
        selected.push(pool.splice(bestIndex, 1)[0].ray);
      }
    };
    pickSide(negative, negativeCount, 'min');
    pickSide(positive, positiveCount, 'max');
    return selected;
  };
  const candidates = ordered.filter((ray) => ray !== chief);
  const availableSlots = Math.max(0, desiredCount - (chief ? 1 : 0));
  const horizontalCount = Math.floor(availableSlots / 2);
  const verticalCount = availableSlots - horizontalCount;
  const selected = chief ? [chief] : [];
  selected.push(...selectUniformAxis(candidates.filter(isHorizontalCrossRay), 'x', horizontalCount));
  selected.push(...selectUniformAxis(candidates.filter(isVerticalCrossRay), 'y', verticalCount));
  return selected.slice(0, desiredCount);
}

function appendDirectStopCardinalRenderRays(
  sourceRays: any[],
  opticalSystemRows: any[],
  wavelengthUm: number,
  requestedRayCount: number,
): any[] {
  const rays = Array.isArray(sourceRays) ? [...sourceRays] : [];
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length < 2) return rays;

  const stopSurfaceIndex = opticalSystemRows.findIndex((row: any) => {
    const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
    return String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '') === 'stop';
  });
  // This direct construction is exact when Stop is the first physical plane.
  // More complex pre-stop optics continue to use the normal pupil solver.
  if (stopSurfaceIndex !== 1) return rays;

  let stopSurfaceInfo: any = null;
  try {
    const surfaceInfos = withRustRenderSurfaceOrigins(() => calculateSurfaceOrigins(opticalSystemRows));
    stopSurfaceInfo = Array.isArray(surfaceInfos) ? surfaceInfos[stopSurfaceIndex] : null;
  } catch (_) {}
  if (!stopSurfaceInfo) return rays;

  const stopRow = opticalSystemRows[stopSurfaceIndex] || {};
  const circularRadius = Number(stopRow?.semidia ?? stopRow?.semiDiameter);
  const halfWidth = Number(stopRow?.apertureWidth) / 2;
  const halfHeight = Number(stopRow?.apertureHeight) / 2;
  const radiusX = Number.isFinite(halfWidth) && halfWidth > 0
    ? halfWidth
    : (Number.isFinite(circularRadius) && circularRadius > 0 ? circularRadius : 0);
  const radiusY = Number.isFinite(halfHeight) && halfHeight > 0
    ? halfHeight
    : (Number.isFinite(circularRadius) && circularRadius > 0 ? circularRadius : 0);
  if (!(radiusX > 0) || !(radiusY > 0)) return rays;

  const targetSurfaceIndex = (() => {
    const imageIndex = opticalSystemRows.findIndex((row: any) => {
      const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
      return String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '').startsWith('image');
    });
    return imageIndex >= 0 ? imageIndex : opticalSystemRows.length - 1;
  })();
  const axisCountRaw = Math.max(3, Math.floor(Number(requestedRayCount) || 3));
  const axisCount = axisCountRaw % 2 === 0 ? axisCountRaw + 1 : axisCountRaw;
  const sideSamples = Math.max(1, Math.floor((axisCount - 1) / 2));
  const objectsWithNonChief = new Set<number>();
  const chiefByObject = new Map<number, any>();
  rays.forEach((ray: any) => {
    const objectIndexRaw = Number(ray?.objectIndex ?? ray?.originalRay?.objectIndex ?? 0);
    const objectIndex = Number.isFinite(objectIndexRaw) ? objectIndexRaw : 0;
    const type = String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase();
    if (type === 'chief') chiefByObject.set(objectIndex, ray);
    else objectsWithNonChief.add(objectIndex);
  });

  const rustReady = !!getRustRayTracingWasmSync();
  const traceOptions = {
    allowNonStrict: true,
    useRustWasm: rustReady,
    requireRustWasm: false,
    disableWasmRayTracing: false,
    __renderDirectStopFallback: true,
  };
  chiefByObject.forEach((chief: any, objectIndex: number) => {
    if (objectsWithNonChief.has(objectIndex)) return;
    const chiefPath = Array.isArray(chief?.rayPath) ? chief.rayPath : [];
    const startPoint = chief?.originalRay?.origin
      ?? chief?.originalRay?.position
      ?? chief?.originalRay?.pos
      ?? chiefPath[0];
    if (!isFiniteRenderPoint(startPoint)) return;

    const targets: Array<{ x: number; y: number; type: string; side: string; stopX: number; stopY: number }> = [];
    for (let sample = 1; sample <= sideSamples; sample += 1) {
      const fraction = sample / sideSamples;
      const x = radiusX * fraction;
      const y = radiusY * fraction;
      targets.push(
        { x: -x, y: 0, type: sample === sideSamples ? 'left_marginal' : 'horizontal_cross', side: 'left', stopX: -x, stopY: 0 },
        { x, y: 0, type: sample === sideSamples ? 'right_marginal' : 'horizontal_cross', side: 'right', stopX: x, stopY: 0 },
        { x: 0, y: -y, type: sample === sideSamples ? 'lower_marginal' : 'vertical_cross', side: 'lower', stopX: 0, stopY: -y },
        { x: 0, y, type: sample === sideSamples ? 'upper_marginal' : 'vertical_cross', side: 'upper', stopX: 0, stopY: y },
      );
    }

    targets.forEach((target) => {
      const stopTarget = buildRenderGlobalPointFromLocal({ x: target.x, y: target.y, z: 0 }, stopSurfaceInfo);
      if (!isFiniteRenderPoint(stopTarget)) return;
      const dx = Number(stopTarget.x) - Number(startPoint.x);
      const dy = Number(stopTarget.y) - Number(startPoint.y);
      const dz = Number(stopTarget.z) - Number(startPoint.z);
      const length = Math.hypot(dx, dy, dz);
      if (!(length > 1e-12)) return;
      const direction = { x: dx / length, y: dy / length, z: dz / length };
      const rayPath = traceRay(
        opticalSystemRows,
        { pos: startPoint, dir: direction, wavelength: wavelengthUm },
        1.0,
        null,
        targetSurfaceIndex,
        traceOptions,
      );
      if (!Array.isArray(rayPath) || rayPath.length <= 1) return;
      rays.push({
        ...chief,
        rayPath,
        type: target.type,
        side: target.side,
        __cooptDirectStopFallback: true,
        __cooptStopXCoord: target.stopX,
        __cooptStopYCoord: target.stopY,
        originalRay: {
          ...(chief?.originalRay || {}),
          type: target.type,
          side: target.side,
          origin: startPoint,
          position: startPoint,
          pos: startPoint,
          direction,
          dir: direction,
          __cooptDirectStopFallback: true,
          __cooptStopXCoord: target.stopX,
          __cooptStopYCoord: target.stopY,
        },
      });
    });
  });
  return rays;
}

function normalizeExactSectionCandidates(
  candidates: Array<{ rayStart: any; type: string; side: string; rayPath: any[] }>,
  axis: 'YZ' | 'XZ' | 'BOTH',
): Array<{ rayStart: any; type: string; side: string; rayPath: any[] }> {
  if (!Array.isArray(candidates) || candidates.length === 0 || axis === 'BOTH') return Array.isArray(candidates) ? candidates : [];

  const primaryCoord = (entry: any) => {
    if (axis === 'XZ') {
      const startX = Number(entry?.rayStart?.startP?.x);
      if (Number.isFinite(startX)) return startX;
      const planeU = Number(entry?.rayStart?.planeCoords?.u);
      return Number.isFinite(planeU) ? planeU : 0;
    }
    const startY = Number(entry?.rayStart?.startP?.y);
    if (Number.isFinite(startY)) return startY;
    const planeV = Number(entry?.rayStart?.planeCoords?.v);
    return Number.isFinite(planeV) ? planeV : 0;
  };

  const negativeSide = axis === 'XZ' ? 'left' : 'lower';
  const positiveSide = axis === 'XZ' ? 'right' : 'upper';
  const marginalTypeForSide = (side: string) => {
    if (axis === 'XZ') return side === 'left' ? 'left_marginal' : 'right_marginal';
    return side === 'lower' ? 'lower_marginal' : 'upper_marginal';
  };
  const crossType = axis === 'XZ' ? 'horizontal_cross' : 'vertical_cross';

  const classifySide = (entry: any) => {
    const coord = primaryCoord(entry);
    if (coord < 0) return negativeSide;
    if (coord > 0) return positiveSide;
    if (entry?.side === negativeSide || entry?.side === positiveSide) return entry.side;
    // For zero primary coord, infer side from orthogonal pupil coord before defaulting.
    if (axis === 'XZ') {
      const planeV = Number(entry?.rayStart?.planeCoords?.v ?? entry?.originalRay?.planeCoords?.v ?? entry?.planeCoords?.v);
      if (Number.isFinite(planeV)) return planeV < 0 ? negativeSide : positiveSide;
    } else {
      const planeU = Number(entry?.rayStart?.planeCoords?.u ?? entry?.originalRay?.planeCoords?.u ?? entry?.planeCoords?.u);
      if (Number.isFinite(planeU)) return planeU < 0 ? negativeSide : positiveSide;
    }
    return positiveSide;
  };

  const bySide = new Map<string, any[]>();
  [negativeSide, positiveSide].forEach((side) => bySide.set(side, []));
  candidates.forEach((entry) => {
    const side = classifySide(entry);
    if (!bySide.has(side)) bySide.set(side, []);
    bySide.get(side)!.push({ ...entry, side });
  });

  const normalized: Array<{ rayStart: any; type: string; side: string; rayPath: any[] }> = [];
  [negativeSide, positiveSide].forEach((side) => {
    const ordered = [...(bySide.get(side) || [])].sort((a, b) => Math.abs(primaryCoord(b)) - Math.abs(primaryCoord(a)));
    ordered.forEach((entry, index) => {
      const explicitType = String(entry?.type ?? '').trim().toLowerCase();
      const keepCross = explicitType === crossType;
      normalized.push({
        ...entry,
        side,
        type: keepCross ? crossType : (index === 0 ? marginalTypeForSide(side) : crossType),
      });
    });
  });

  return normalized;
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

function normalizeRenderObjectPositionTag(value: any): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function isRenderImageHeightObjectRow(row: any): boolean {
  const currentPosNorm = normalizeRenderObjectPositionTag(row?.position);
  const originalPosNorm = normalizeRenderObjectPositionTag(row?.__cooptOriginalPosition);
  const storedTarget = row?.__cooptImageHeightTarget;
  const hasStoredImageHeightTarget = storedTarget
    && Number.isFinite(Number(storedTarget.x))
    && Number.isFinite(Number(storedTarget.y));
  if (currentPosNorm === 'imageheight') return true;
  if (currentPosNorm && currentPosNorm !== 'imageheight') return false;
  return originalPosNorm === 'imageheight' || !!hasStoredImageHeightTarget;
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

function getRenderStopSurfaceInfo(opticalSystemRows: any[]): { index: number; center: { x: number; y: number; z: number } } | null {
  try {
    const surfaceInfos = withRustRenderSurfaceOrigins(() => calculateSurfaceOrigins(opticalSystemRows));
    const stopInfo = findStopSurface(opticalSystemRows, surfaceInfos);
    const index = Number(stopInfo?.index);
    const src = stopInfo?.origin?.origin ?? stopInfo?.origin ?? stopInfo?.center ?? stopInfo?.position;
    const center = {
      x: Number(src?.x),
      y: Number(src?.y),
      z: Number(src?.z),
    };
    if (!Number.isInteger(index) || ![center.x, center.y, center.z].every(Number.isFinite)) return null;
    return { index, center };
  } catch (_) {
    return null;
  }
}

function ensureRenderChiefStartHitsStopCenter(
  rayStart: any,
  opticalSystemRows: any[],
  wavelengthUm: number,
  preferredTraceBackend: 'rust' | 'ts',
  objectIndex: number,
): any {
  if (!rayStart?.startP || !rayStart?.dir) return rayStart;
  const stopInfo = getRenderStopSurfaceInfo(opticalSystemRows);
  if (!stopInfo) return rayStart;
  const ray = { pos: rayStart.startP, dir: rayStart.dir, wavelength: wavelengthUm };
  const hit = traceRayHitPoint(opticalSystemRows, ray, 1.0, stopInfo.index, {
    allowNonStrict: true,
    useRustWasm: preferredTraceBackend === 'rust',
    requireRustWasm: false,
    disableWasmRayTracing: preferredTraceBackend !== 'rust',
  });
  const relativeHit = hit ? {
    x: Number(hit.x) - stopInfo.center.x,
    y: Number(hit.y) - stopInfo.center.y,
    z: Number(hit.z) - stopInfo.center.z,
  } : null;
  const residual = relativeHit ? Math.hypot(relativeHit.x, relativeHit.y) : Number.POSITIVE_INFINITY;
  const objectSurface = Array.isArray(opticalSystemRows) ? opticalSystemRows[0] : null;
  const logChiefStopDiagnostic = (entry: any) => {
    try {
      const w = window as any;
      const list = Array.isArray(w.__COOPT_RENDER_CHIEF_STOP_LOG)
        ? w.__COOPT_RENDER_CHIEF_STOP_LOG
        : [];
      list.push(entry);
      while (list.length > 200) list.shift();
      w.__COOPT_RENDER_CHIEF_STOP_LOG = list;
      w.__COOPT_LAST_RENDER_CHIEF_STOP_DIAG = entry;
      console.log('[RenderChiefStopDiag]', entry);
    } catch (_) {}
  };

  const baseDiagnostic = {
    at: new Date().toISOString(),
    objectIndex,
    stopSurfaceIndex: stopInfo.index,
    objectRenderDistance: Number(objectSurface?.objectRenderDistance),
    renderImageHeightDisplayDistance: Number.isFinite(Number(objectSurface?.__cooptRenderImageHeightDisplayDistance))
      ? Number(objectSurface?.__cooptRenderImageHeightDisplayDistance)
      : (Number.isFinite(Number(objectSurface?.objectRenderDistance)) ? Number(objectSurface?.objectRenderDistance) : null),
    objectThickness: objectSurface?.thickness ?? null,
    startP: {
      x: Number(rayStart.startP.x),
      y: Number(rayStart.startP.y),
      z: Number(rayStart.startP.z),
    },
    direction: {
      x: Number(rayStart.dir.x),
      y: Number(rayStart.dir.y),
      z: Number(rayStart.dir.z),
    },
    stopCenter: { ...stopInfo.center },
    stopHit: hit ? { x: Number(hit.x), y: Number(hit.y), z: Number(hit.z) } : null,
    relativeToStopCenter: relativeHit,
    residualXYMm: residual,
  };

  if (Number.isFinite(residual) && residual <= 1e-3) {
    logChiefStopDiagnostic({ ...baseDiagnostic, status: 'ok' });
    return rayStart;
  }

  const refined = solveRayOriginToStopPointFast(
    rayStart.startP,
    rayStart.dir,
    stopInfo.center,
    stopInfo.index,
    opticalSystemRows,
    wavelengthUm,
    preferredTraceBackend,
  );
  if (!refined || ![refined.x, refined.y, refined.z].every(Number.isFinite)) {
    logChiefStopDiagnostic({ ...baseDiagnostic, status: 'solve-failed' });
    return rayStart;
  }

  const refinedHit = traceRayHitPoint(opticalSystemRows, { pos: refined, dir: rayStart.dir, wavelength: wavelengthUm }, 1.0, stopInfo.index, {
    allowNonStrict: true,
    useRustWasm: preferredTraceBackend === 'rust',
    requireRustWasm: false,
    disableWasmRayTracing: preferredTraceBackend !== 'rust',
  });
  const refinedRelativeHit = refinedHit ? {
    x: Number(refinedHit.x) - stopInfo.center.x,
    y: Number(refinedHit.y) - stopInfo.center.y,
    z: Number(refinedHit.z) - stopInfo.center.z,
  } : null;
  const refinedResidual = refinedRelativeHit ? Math.hypot(refinedRelativeHit.x, refinedRelativeHit.y) : Number.POSITIVE_INFINITY;
  const correctedDiagnostic = {
    ...baseDiagnostic,
    status: 'corrected',
    correctedStartP: { x: Number(refined.x), y: Number(refined.y), z: Number(refined.z) },
    correctedStopHit: refinedHit ? { x: Number(refinedHit.x), y: Number(refinedHit.y), z: Number(refinedHit.z) } : null,
    correctedRelativeToStopCenter: refinedRelativeHit,
    correctedResidualXYMm: refinedResidual,
  };
  try {
    (window as any).__COOPT_LAST_RENDER_CHIEF_STOP_CORRECTION = {
      at: new Date().toISOString(),
      objectIndex,
      stopSurfaceIndex: stopInfo.index,
      beforeResidualMm: residual,
      afterResidualMm: refinedResidual,
      beforeOrigin: rayStart.startP,
      afterOrigin: refined,
      direction: rayStart.dir,
    };
  } catch (_) {}
  const strictStopCenterToleranceMm = 1e-2;
  const materialImprovementMm = Math.max(1e-4, Math.abs(residual) * 0.01);
  const hasMaterialImprovement = Number.isFinite(refinedResidual) && refinedResidual < residual - materialImprovementMm;
  if (!Number.isFinite(refinedResidual) || (refinedResidual > strictStopCenterToleranceMm && !hasMaterialImprovement)) {
    logChiefStopDiagnostic({ ...correctedDiagnostic, status: 'correction-rejected' });
    return rayStart;
  }
  logChiefStopDiagnostic(refinedResidual <= strictStopCenterToleranceMm
    ? correctedDiagnostic
    : { ...correctedDiagnostic, status: 'correction-improved' });
  return {
    ...rayStart,
    startP: { x: refined.x, y: refined.y, z: refined.z },
    isChief: true,
  };
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

function logQconTraceSummaryForRender(tag: string): void {
  try {
    const w = window as any;
    const logs = Array.isArray(w.__COOPT_QCON_TRACE_LOG) ? w.__COOPT_QCON_TRACE_LOG : [];
    if (!logs.length) return;

    const failures = logs.filter((entry: any) => {
      const status = String(entry?.status ?? '').toLowerCase();
      return status === 'no_intersection' || status === 'tir';
    });
    if (!failures.length) return;

    const grouped = new Map<string, { count: number; last: any }>();
    for (const entry of failures) {
      const key = `${Number(entry?.surfaceIndex)}:${String(entry?.status ?? '')}`;
      const current = grouped.get(key);
      if (current) {
        current.count += 1;
        current.last = entry;
      } else {
        grouped.set(key, { count: 1, last: entry });
      }
    }

    const summary = Array.from(grouped.entries())
      .map(([key, info]) => {
        const [surfaceIndexRaw, status] = key.split(':');
        const surfaceIndex = Number(surfaceIndexRaw);
        return {
          surfaceIndex,
          surfaceNumber: Number.isFinite(surfaceIndex) ? surfaceIndex + 1 : null,
          status,
          count: info.count,
          lastHitRadius: Number(info.last?.hitRadius),
          lastSagResidual: Number(info.last?.sagResidual),
          mode: String(info.last?.mode ?? ''),
        };
      })
      .sort((a, b) => a.surfaceIndex - b.surfaceIndex);

    const digest = JSON.stringify(summary);
    if (w.__COOPT_LAST_QCON_TRACE_SUMMARY_DIGEST === digest) return;
    w.__COOPT_LAST_QCON_TRACE_SUMMARY_DIGEST = digest;
    w.__COOPT_LAST_QCON_TRACE_SUMMARY = {
      at: new Date().toISOString(),
      tag,
      totalEntries: logs.length,
      failureEntries: failures.length,
      summary,
      latestFailure: failures[failures.length - 1],
    };
    console.warn('[QconTraceSummary]', w.__COOPT_LAST_QCON_TRACE_SUMMARY);
  } catch (_) {
    // ignore summary logging failures
  }
}

function projectPointToChiefNormalPlane(chiefOrigin: any, chiefDir: any, point: any): any {
  const origin = {
    x: Number(chiefOrigin?.x) || 0,
    y: Number(chiefOrigin?.y) || 0,
    z: Number(chiefOrigin?.z) || 0,
  };
  const p = {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    z: Number(point?.z) || 0,
  };
  const n = normalizeRenderVector3(chiefDir, { x: 0, y: 0, z: 1 });
  const vx = p.x - origin.x;
  const vy = p.y - origin.y;
  const vz = p.z - origin.z;
  const dist = vx * n.x + vy * n.y + vz * n.z;
  return {
    x: p.x - dist * n.x,
    y: p.y - dist * n.y,
    z: p.z - dist * n.z,
  };
}

function translateRenderRayPathAlongChiefNormal(path: any[], targetStart: any, chiefOrigin: any, chiefDir: any): any[] {
  const points = Array.isArray(path) ? path : [];
  if (points.length < 1) return points;
  const first = points[0] || {};
  const fx = Number(first?.x);
  const fy = Number(first?.y);
  const fz = Number(first?.z);
  const tx = Number(targetStart?.x);
  const ty = Number(targetStart?.y);
  const tz = Number(targetStart?.z);
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || !Number.isFinite(fz)) return points;
  const n = normalizeRenderVector3(chiefDir, { x: 0, y: 0, z: 1 });
  const hasTarget = Number.isFinite(tx) && Number.isFinite(ty) && Number.isFinite(tz);
  let deltaN = 0;
  if (hasTarget) {
    deltaN = (tx - fx) * n.x + (ty - fy) * n.y + (tz - fz) * n.z;
  } else {
    const ox = Number(chiefOrigin?.x) || 0;
    const oy = Number(chiefOrigin?.y) || 0;
    const oz = Number(chiefOrigin?.z) || 0;
    deltaN = -((fx - ox) * n.x + (fy - oy) * n.y + (fz - oz) * n.z);
  }
  const dx = deltaN * n.x;
  const dy = deltaN * n.y;
  const dz = deltaN * n.z;
  if (Math.abs(dx) <= 1e-12 && Math.abs(dy) <= 1e-12 && Math.abs(dz) <= 1e-12) return points;
  return points.map((point: any) => {
    if (!point || typeof point !== 'object') return point;
    return {
      ...point,
      x: Number(point?.x) + dx,
      y: Number(point?.y) + dy,
      z: Number(point?.z) + dz,
    };
  });
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

  const rustReady = !!getRustRayTracingWasmSync();
  const preferredTraceBackend = rustReady ? 'rust' : 'ts';

  const traceOptions = {
    allowNonStrict: true,
    useRustWasm: rustReady,
    requireRustWasm: false,
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
      const exactPattern = 'grid';
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
          originSolveTraceBackend: preferredTraceBackend,
          imageHeightValidationTraceBackend: preferredTraceBackend,
          targetSurfaceIndex,
          disableCrossExtent: true,
          crossType,
          exactCrossBeamSampling: true,
          displayAxisAlignedSampling: axis !== 'BOTH',
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
          originSolveTraceBackend: preferredTraceBackend,
          imageHeightValidationTraceBackend: preferredTraceBackend,
          targetSurfaceIndex,
          disableCrossExtent: true,
          crossType,
          exactCrossBeamSampling: true,
          displayAxisAlignedSampling: axis !== 'BOTH',
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
        if (candidate?.isChief === true || candidate?.originalRay?.isChief === true) return candidateIndex;
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
      const rawChiefStart = getExactImageHeightChiefStart(
        separatedResolvedRow,
        chiefStartCandidate,
        'Chief render ray (exact ImageHeight solver)'
      );
      const chiefStart = ensureRenderChiefStartHitsStopCenter(
        rawChiefStart,
        opticalSystemRows,
        wavelengthUm,
        preferredTraceBackend,
        resolvedObjectIndex,
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
        // Reuse the target-surface hit already present in rayPath instead of
        // running a second full trace (traceRayHitPoint) per ray. traceRay and
        // traceRayHitPoint perform the same deterministic trace to the same
        // surface, so the extracted point matches; only fall back to a
        // dedicated hit-point trace when the path does not contain the target
        // surface (e.g. the ray was blocked before reaching it).
        let tracedTargetPoint = getRenderTargetPointFromRayPath(rayPath, opticalSystemRows, targetSurfaceIndex);
        if (!isFiniteRenderPoint(tracedTargetPoint)) {
          tracedTargetPoint = traceRayHitPoint(
            opticalSystemRows,
            { pos: rayStart.startP, dir: rayStart.dir, wavelength: wavelengthUm },
            1.0,
            targetSurfaceIndex,
            traceOptions,
          );
        }
        const solvedChiefTargetPoint = rayIndex === chiefIndex && solvedChiefLocalHit
          ? buildRenderGlobalPointFromLocal(solvedChiefLocalHit, targetSurfaceInfo)
          : null;
        const preciseTargetPoint = isFiniteRenderPoint(solvedChiefTargetPoint)
          ? solvedChiefTargetPoint
          : tracedTargetPoint;
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
  logQconTraceSummaryForRender('buildExactRenderRaysForImageHeightObjects');

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

  const requestedRayCount = Number.isFinite(Number(rayCount)) ? Math.max(1, Math.floor(Number(rayCount))) : 1;
  const desiredRayCount = requestedRayCount > 1 && requestedRayCount % 2 === 0
    ? requestedRayCount + 1
    : requestedRayCount;
  const desiredAdditionalRayCount = axis === 'BOTH'
    ? Math.max(0, 2 * (desiredRayCount - 1))
    : Math.max(0, desiredRayCount - 1);
  const generationRayCount = axis === 'BOTH'
    ? (desiredRayCount === 1 ? 2 : desiredRayCount)
    : Math.max(desiredRayCount === 1 ? 2 : desiredRayCount, 6);
  const rustReady = !!getRustRayTracingWasmSync();
  const preferredTraceBackend = rustReady ? 'rust' : 'ts';

  const traceOptions = {
    allowNonStrict: true,
    useRustWasm: rustReady,
    requireRustWasm: false,
    disableWasmRayTracing: false,
    __renderLowCountRustPreferred: true,
  };
  const imageSurfaceIndex = opticalSystemRows.findIndex((row: any) => {
    const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
    const normalized = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
    return normalized === 'image' || normalized.startsWith('image');
  });
  const targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);
  const stopSurfaceIndex = opticalSystemRows.findIndex((row: any) => {
    const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
    return String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '') === 'stop';
  });
  const exactPattern = 'grid';
  const crossType = axis === 'YZ' ? 'vertical' : (axis === 'XZ' ? 'horizontal' : 'both');
  const getCandidateScore = (candidate: any, expectedChiefOrigin: any) => {
    if (candidate?.isChief === true || candidate?.originalRay?.isChief === true) return -1;
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
  let onAxisSectionStopInterval: { min: number; max: number } | null = null;
  objectRows.forEach((row: any, objectIndex: number) => {
    try {
      const scopedRow = buildAxisScopedRenderObjectRow(row, axis);
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
        : scopedRow;
      const separatedResolvedRow = separateOverlappingRenderImageHeightSolvedField(
        resolvedRow,
        row,
        axis,
        objectIndex,
        overlappingImageHeightSolveEntries,
      );
      const isImageHeight = isRenderImageHeightObjectRow(row);
      const candidateGenerationRayCount = (!isImageHeight && conjugateType === 'infinite')
        ? Math.max(generationRayCount, 100)
        : generationRayCount;
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
              originSolveTraceBackend: preferredTraceBackend,
              imageHeightValidationTraceBackend: preferredTraceBackend,
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
        candidateGenerationRayCount,
        null,
        {
          pattern: exactPattern,
          wavelengthUm,
          conjugateType,
          pupilScale: 1,
          aimThroughStop: true,
          useChiefRayAnalysis: true,
          allowStopBasedOriginSolve: true,
          originSolveTraceBackend: preferredTraceBackend,
          imageHeightValidationTraceBackend: preferredTraceBackend,
          targetSurfaceIndex,
          disableCrossExtent: true,
          crossType,
          exactCrossBeamSampling: true,
          displayAxisAlignedSampling: axis !== 'BOTH',
          preserveChiefNormalEmissionPlane: true,
        }
      );
      const renderRayStarts = Array.isArray(rayStarts) ? rayStarts : [];
      if (renderRayStarts.length === 0) return;
      const imageHeightTarget = isImageHeight ? getRenderImageHeightTargetForAxis(row, axis) : null;
      const expectedChiefOrigin = rayStarts?.expectedChiefOrigin;
      const explicitCenterIndex = renderRayStarts.findIndex((candidate: any) => {
        if (candidate?.isChief === true || candidate?.originalRay?.isChief === true) return true;
        const planeU = Number(candidate?.planeCoords?.u);
        const planeV = Number(candidate?.planeCoords?.v);
        return Math.abs(planeU) <= 1e-9 && Math.abs(planeV) <= 1e-9;
      });
      const chiefIndex = explicitCenterIndex >= 0
        ? explicitCenterIndex
        : renderRayStarts.reduce((bestIndex: number, candidate: any, candidateIndex: number) => {
        const score = getCandidateScore(candidate, expectedChiefOrigin);
        const bestScore = getCandidateScore(renderRayStarts[bestIndex], expectedChiefOrigin);
        return score < bestScore ? candidateIndex : bestIndex;
      }, 0);
      const chiefStartCandidate = isImageHeight && Array.isArray(chiefOnlyRayStarts) && chiefOnlyRayStarts[0]
        ? chiefOnlyRayStarts[0]
        : (renderRayStarts[chiefIndex] || renderRayStarts[0]);
      const rawChiefStart = isImageHeight
        ? getExactImageHeightChiefStart(
            separatedResolvedRow,
            chiefStartCandidate,
            'Chief render ray (exact ImageHeight solver)'
          )
        : chiefStartCandidate;
      const chiefStart = ensureRenderChiefStartHitsStopCenter(
        rawChiefStart,
        opticalSystemRows,
        wavelengthUm,
        preferredTraceBackend,
        objectIndex,
      );
      if (!chiefStart?.startP || !chiefStart?.dir) return;
      const tracedRayStarts = renderRayStarts.map((candidate: any, candidateIndex: number) => {
        if (candidateIndex === chiefIndex) {
          return {
            ...candidate,
            ...chiefStart,
            startP: chiefStart.startP,
            dir: chiefStart.dir,
            description: chiefStart.description || candidate?.description,
          };
        }
        return candidate;
      });
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

      const pushExactRay = (rayStart: any, type: string, side: string, rayPath: any[], pinnedLowCount = false) => {
        const stopPoint = stopSurfaceIndex >= 0
          ? getRenderTargetPointFromRayPath(rayPath, opticalSystemRows, stopSurfaceIndex)
          : null;
        const stopAxisCoord = axis === 'XZ' ? Number(stopPoint?.x) : Number(stopPoint?.y);
        rays.push({
          success: true,
          rayPath,
          objectIndex,
          objectPosition,
          ...(Number.isFinite(stopAxisCoord) ? { __cooptStopAxisCoord: stopAxisCoord } : {}),
          ...(isImageHeight ? {
            __cooptImageHeightExactRender: true,
            __cooptImageHeightTarget: imageHeightTarget,
          } : {}),
          type,
          beamType: type === 'chief'
            ? 'chief'
            : (type.includes('left') || type.includes('right') ? 'horizontal' : 'vertical'),
          side,
          __cooptPinnedLowCount: pinnedLowCount,
          originalRay: {
            type,
            beamType: type === 'chief'
              ? 'chief'
              : (type.includes('left') || type.includes('right') ? 'horizontal' : 'vertical'),
            side,
            __cooptPinnedLowCount: pinnedLowCount,
            objectIndex,
            origin: rayStart.startP,
            position: rayStart.startP,
            pos: rayStart.startP,
            planeCoords: rayStart?.planeCoords,
            direction: rayStart.dir,
            dir: rayStart.dir,
            wavelength: wavelengthUm,
            objectPosition,
            ...(Number.isFinite(stopAxisCoord) ? { __cooptStopAxisCoord: stopAxisCoord } : {}),
            description: rayStart.description || (type === 'chief' ? 'Chief render ray (exact)' : 'Marginal render ray (exact)'),
          },
        });
      };

      pushExactRay(chiefStart, 'chief', 'center', chiefRayPath, false);

      if (desiredRayCount <= 1) return;

      // Infinite Angle low-count preset:
      // - BOTH: chief + 4 cardinals (<=5)
      // - YZ/XZ: chief + 2 marginals (<=3)
      // This keeps low-count rendering stable and intuitive without requiring high ray counts.
      const useInfiniteLowCountCardinalPreset =
        conjugateType === 'infinite'
        && !isImageHeight
        && ((axis === 'BOTH' && desiredRayCount <= 5) || (axis !== 'BOTH' && desiredRayCount <= 3));
      if (useInfiniteLowCountCardinalPreset) {
        const candidates = tracedRayStarts
          .map((rayStart: any, index: number) => ({ rayStart, index }))
          .filter((entry: any) => entry.index !== chiefIndex)
          .map((entry: any) => {
            const rayStart = entry.rayStart;
            if (!rayStart?.startP || !rayStart?.dir) return null;
            const rayPath = traceExactRayForRender(rayStart.startP, rayStart.dir, false);
            if (!rayPath) return null;
            const u = Number(rayStart?.planeCoords?.u);
            const v = Number(rayStart?.planeCoords?.v);
            return {
              ...entry,
              rayPath,
              u: Number.isFinite(u) ? u : Number.NaN,
              v: Number.isFinite(v) ? v : Number.NaN,
            };
          })
          .filter((entry: any) => entry && (Number.isFinite(entry.u) || Number.isFinite(entry.v)));

        if (candidates.length > 0) {
          const used = new Set<number>();
          const pick = (key: 'u' | 'v', mode: 'min' | 'max') => {
            const pool = candidates.filter((entry: any) => !used.has(entry.index) && Number.isFinite(Number(entry[key])));
            if (pool.length === 0) return null;
            const best = pool.reduce((acc: any, cur: any) => {
              if (!acc) return cur;
              return mode === 'min'
                ? (Number(cur[key]) < Number(acc[key]) ? cur : acc)
                : (Number(cur[key]) > Number(acc[key]) ? cur : acc);
            }, null);
            if (!best) return null;
            used.add(best.index);
            return best;
          };
          const mirrorCandidate = (seed: any, axisToMirror: 'u' | 'v') => {
            if (!seed?.rayStart) return null;
            const u0 = Number(seed?.rayStart?.planeCoords?.u);
            const v0 = Number(seed?.rayStart?.planeCoords?.v);
            const hasU = Number.isFinite(u0);
            const hasV = Number.isFinite(v0);
            if (!hasU && !hasV) return null;
            const mirroredU = axisToMirror === 'u'
              ? -(hasU ? u0 : 0)
              : (hasU ? u0 : 0);
            const mirroredV = axisToMirror === 'v'
              ? -(hasV ? v0 : 0)
              : (hasV ? v0 : 0);
            const rebuiltStart = buildRenderRayStartOnChiefPlane(chiefStart, {
              ...(seed.rayStart || {}),
              planeCoords: { u: mirroredU, v: mirroredV },
            });
            if (!rebuiltStart?.startP || !rebuiltStart?.dir) return null;
            const mirroredPath = traceExactRayForRender(rebuiltStart.startP, rebuiltStart.dir, false);
            if (!mirroredPath) return null;
            return {
              rayStart: rebuiltStart,
              rayPath: mirroredPath,
              u: mirroredU,
              v: mirroredV,
            };
          };

          if (axis === 'YZ') {
            const baseCount = rays.length;
            let lower = null as any;
            let upper = null as any;
            if (desiredRayCount >= 2) {
              lower = pick('v', 'min');
              if (lower) pushExactRay(lower.rayStart, 'lower_marginal', 'lower', lower.rayPath, true);
            }
            if (desiredRayCount >= 3) {
              upper = pick('v', 'max');
              if (upper) pushExactRay(upper.rayStart, 'upper_marginal', 'upper', upper.rayPath, true);
            }
            if (desiredRayCount >= 3 && (!lower || !upper)) {
              if (!lower && upper) {
                const mirrored = mirrorCandidate(upper, 'v');
                if (mirrored) {
                  lower = mirrored;
                  pushExactRay(mirrored.rayStart, 'lower_marginal', 'lower', mirrored.rayPath, true);
                }
              }
              if (!upper && lower) {
                const mirrored = mirrorCandidate(lower, 'v');
                if (mirrored) {
                  upper = mirrored;
                  pushExactRay(mirrored.rayStart, 'upper_marginal', 'upper', mirrored.rayPath, true);
                }
              }
            }
            const added = rays.length - baseCount;
            const requiredAdded = Math.max(0, Math.min(2, desiredRayCount - 1));
            if (added >= requiredAdded) return;
          }

          if (axis === 'XZ') {
            const baseCount = rays.length;
            let left = null as any;
            let right = null as any;
            if (desiredRayCount >= 2) {
              left = pick('u', 'min');
              if (left) pushExactRay(left.rayStart, 'left_marginal', 'left', left.rayPath, true);
            }
            if (desiredRayCount >= 3) {
              right = pick('u', 'max');
              if (right) pushExactRay(right.rayStart, 'right_marginal', 'right', right.rayPath, true);
            }
            if (desiredRayCount >= 3 && (!left || !right)) {
              if (!left && right) {
                const mirrored = mirrorCandidate(right, 'u');
                if (mirrored) {
                  left = mirrored;
                  pushExactRay(mirrored.rayStart, 'left_marginal', 'left', mirrored.rayPath, true);
                }
              }
              if (!right && left) {
                const mirrored = mirrorCandidate(left, 'u');
                if (mirrored) {
                  right = mirrored;
                  pushExactRay(mirrored.rayStart, 'right_marginal', 'right', mirrored.rayPath, true);
                }
              }
            }
            const added = rays.length - baseCount;
            const requiredAdded = Math.max(0, Math.min(2, desiredRayCount - 1));
            if (added >= requiredAdded) return;
          }

          if (axis === 'BOTH') {
            const baseCount = rays.length;
            let upper = null as any;
            let lower = null as any;
            let left = null as any;
            let right = null as any;
            if (desiredRayCount >= 2) {
              upper = pick('v', 'max');
              if (upper) pushExactRay(upper.rayStart, 'upper_marginal', 'upper', upper.rayPath, true);
            }
            if (desiredRayCount >= 3) {
              lower = pick('v', 'min');
              if (lower) pushExactRay(lower.rayStart, 'lower_marginal', 'lower', lower.rayPath, true);
            }
            if (desiredRayCount >= 4) {
              left = pick('u', 'min');
              if (left) pushExactRay(left.rayStart, 'left_marginal', 'left', left.rayPath, true);
            }
            if (desiredRayCount >= 5) {
              right = pick('u', 'max');
              if (right) pushExactRay(right.rayStart, 'right_marginal', 'right', right.rayPath, true);
            }
            if (desiredRayCount >= 3 && (!upper || !lower)) {
              if (!upper && lower) {
                const mirrored = mirrorCandidate(lower, 'v');
                if (mirrored) {
                  upper = mirrored;
                  pushExactRay(mirrored.rayStart, 'upper_marginal', 'upper', mirrored.rayPath, true);
                }
              }
              if (!lower && upper) {
                const mirrored = mirrorCandidate(upper, 'v');
                if (mirrored) {
                  lower = mirrored;
                  pushExactRay(mirrored.rayStart, 'lower_marginal', 'lower', mirrored.rayPath, true);
                }
              }
            }
            if (desiredRayCount >= 5 && (!left || !right)) {
              if (!left && right) {
                const mirrored = mirrorCandidate(right, 'u');
                if (mirrored) {
                  left = mirrored;
                  pushExactRay(mirrored.rayStart, 'left_marginal', 'left', mirrored.rayPath, true);
                }
              }
              if (!right && left) {
                const mirrored = mirrorCandidate(left, 'u');
                if (mirrored) {
                  right = mirrored;
                  pushExactRay(mirrored.rayStart, 'right_marginal', 'right', mirrored.rayPath, true);
                }
              }
            }
            const added = rays.length - baseCount;
            const requiredAdded = Math.max(0, Math.min(4, desiredRayCount - 1));
            if (added >= requiredAdded) return;
          }
        }
      }

      const collectAxisCandidateExactRays = (candidateStarts: any[], candidateExpectedChiefOrigin: any) => {
        const starts = Array.isArray(candidateStarts) ? candidateStarts : [];
        if (starts.length === 0) return [] as Array<{ rayStart: any; type: string; side: string; rayPath: any[] }>;
        const localExplicitCenterIndex = starts.findIndex((candidate: any) => {
          const planeU = Number(candidate?.planeCoords?.u);
          const planeV = Number(candidate?.planeCoords?.v);
          return Math.abs(planeU) <= 1e-9 && Math.abs(planeV) <= 1e-9;
        });
        const localChiefIndex = localExplicitCenterIndex >= 0
          ? localExplicitCenterIndex
          : starts.reduce((bestIndex: number, candidate: any, candidateIndex: number) => {
              const score = getCandidateScore(candidate, candidateExpectedChiefOrigin);
              const bestScore = getCandidateScore(starts[bestIndex], candidateExpectedChiefOrigin);
              return score < bestScore ? candidateIndex : bestIndex;
            }, 0);
        const additionalIndices = starts
          .map((_: any, index: number) => index)
          .filter((index: number) => index !== localChiefIndex)
          .sort((indexA: number, indexB: number) => {
            const scoreA = getCandidateScore(starts[indexA], candidateExpectedChiefOrigin);
            const scoreB = getCandidateScore(starts[indexB], candidateExpectedChiefOrigin);
            if (Math.abs(scoreA - scoreB) > 1e-9) return scoreA - scoreB;
            return indexA - indexB;
          });

        const candidates: Array<{ rayStart: any; type: string; side: string; rayPath: any[] }> = [];
        for (const rayIndex of additionalIndices) {
          const rayStart = starts[rayIndex];
          if (!rayStart?.startP || !rayStart?.dir) continue;
          const rayPath = traceExactRayForRender(rayStart.startP, rayStart.dir, isImageHeight);
          if (!rayPath) continue;

          const planeU = Number(rayStart?.planeCoords?.u);
          const planeV = Number(rayStart?.planeCoords?.v);
          const deltaX = Number.isFinite(planeU)
            ? planeU
            : (Number(rayStart.startP.x) - Number(chiefStartP.x));
          const deltaY = Number.isFinite(planeV)
            ? planeV
            : (Number(rayStart.startP.y) - Number(chiefStartP.y));

          let type = 'marginal';
          let side = 'center';
          if (axis === 'XZ') {
            const hasUV = Number.isFinite(planeU) && Number.isFinite(planeV);
            if (hasUV && Math.abs(planeV) > Math.abs(planeU) + 1e-9) {
              // Orthogonal cardinal rays should remain cross rays (not re-labeled as marginals).
              type = 'horizontal_cross';
              side = planeV >= 0 ? 'right' : 'left';
            } else {
              type = deltaX >= 0 ? 'right_marginal' : 'left_marginal';
              side = deltaX >= 0 ? 'right' : 'left';
            }
          } else if (axis === 'YZ') {
            const hasUV = Number.isFinite(planeU) && Number.isFinite(planeV);
            if (hasUV && Math.abs(planeU) > Math.abs(planeV) + 1e-9) {
              // Orthogonal cardinal rays should remain cross rays (not re-labeled as marginals).
              type = 'vertical_cross';
              side = planeU >= 0 ? 'upper' : 'lower';
            } else {
              type = deltaY >= 0 ? 'upper_marginal' : 'lower_marginal';
              side = deltaY >= 0 ? 'upper' : 'lower';
            }
          } else if (Math.abs(deltaY) >= Math.abs(deltaX)) {
            type = deltaY >= 0 ? 'upper_marginal' : 'lower_marginal';
            side = deltaY >= 0 ? 'upper' : 'lower';
          } else {
            type = deltaX >= 0 ? 'right_marginal' : 'left_marginal';
            side = deltaX >= 0 ? 'right' : 'left';
          }

          const stopPoint = stopSurfaceIndex >= 0
            ? getRenderTargetPointFromRayPath(rayPath, opticalSystemRows, stopSurfaceIndex)
            : null;
          const stopXCoord = Number(stopPoint?.x);
          const stopYCoord = Number(stopPoint?.y);
          const stopAxisCoord = axis === 'XZ' ? stopXCoord : stopYCoord;
          candidates.push({
            rayStart,
            type,
            side,
            rayPath,
            ...(Number.isFinite(stopXCoord) ? { __cooptStopXCoord: stopXCoord } : {}),
            ...(Number.isFinite(stopYCoord) ? { __cooptStopYCoord: stopYCoord } : {}),
            ...(Number.isFinite(stopAxisCoord) ? { __cooptStopAxisCoord: stopAxisCoord } : {}),
          });
        }
        return candidates;
      };

      const resampleInfiniteSectionCandidates = (candidates: any[]) => {
        if (conjugateType !== 'infinite' || axis === 'BOTH' || desiredAdditionalRayCount < 2) return candidates;
        const coordKey = axis === 'XZ' ? '__cooptStopXCoord' : '__cooptStopYCoord';
        const sorted = candidates
          .map((entry: any) => ({ ...entry, stopCoord: Number(entry?.[coordKey]) }))
          .filter((entry: any) => Number.isFinite(entry.stopCoord))
          .sort((a: any, b: any) => a.stopCoord - b.stopCoord);
        if (sorted.length < 2 || stopSurfaceIndex < 0) return candidates;

        const chiefStopPoint = getRenderTargetPointFromRayPath(chiefRayPath, opticalSystemRows, stopSurfaceIndex);
        const chiefStopCoord = Number(axis === 'XZ' ? chiefStopPoint?.x : chiefStopPoint?.y);
        if (!Number.isFinite(chiefStopCoord)) return candidates;

        if (objectIndex === 0) {
          onAxisSectionStopInterval = {
            min: sorted[0].stopCoord,
            max: sorted[sorted.length - 1].stopCoord,
          };
        }

        const interpolateAtStopCoord = (targetCoord: number, type: string, side: string) => {
          let lower = sorted[0];
          let upper = sorted[sorted.length - 1];
          for (let index = 0; index + 1 < sorted.length; index += 1) {
            if (sorted[index].stopCoord <= targetCoord && sorted[index + 1].stopCoord >= targetCoord) {
              lower = sorted[index];
              upper = sorted[index + 1];
              break;
            }
          }
          let bestEntry: any = null;
          for (let iteration = 0; iteration < 6; iteration += 1) {
            const span = upper.stopCoord - lower.stopCoord;
            const ratio = Math.abs(span) > 1e-12 ? (targetCoord - lower.stopCoord) / span : 0;
            const lowerU = Number(lower?.rayStart?.planeCoords?.u) || 0;
            const lowerV = Number(lower?.rayStart?.planeCoords?.v) || 0;
            const upperU = Number(upper?.rayStart?.planeCoords?.u) || 0;
            const upperV = Number(upper?.rayStart?.planeCoords?.v) || 0;
            const rayStart = buildRenderRayStartOnChiefPlane(chiefStart, {
              ...(lower?.rayStart || {}),
              planeCoords: {
                u: lowerU + (upperU - lowerU) * ratio,
                v: lowerV + (upperV - lowerV) * ratio,
              },
            });
            if (!rayStart?.startP || !rayStart?.dir) break;
            const rayPath = traceExactRayForRender(rayStart.startP, rayStart.dir, isImageHeight);
            if (!rayPath) break;
            const stopPoint = getRenderTargetPointFromRayPath(rayPath, opticalSystemRows, stopSurfaceIndex);
            const stopXCoord = Number(stopPoint?.x);
            const stopYCoord = Number(stopPoint?.y);
            const actualCoord = axis === 'XZ' ? stopXCoord : stopYCoord;
            if (!Number.isFinite(actualCoord)) break;
            bestEntry = {
              rayStart,
              type,
              side,
              rayPath,
              ...(Number.isFinite(stopXCoord) ? { __cooptStopXCoord: stopXCoord } : {}),
              ...(Number.isFinite(stopYCoord) ? { __cooptStopYCoord: stopYCoord } : {}),
              __cooptStopAxisCoord: actualCoord,
            };
            if (Math.abs(actualCoord - targetCoord) <= 1e-9) break;
            const bracketEntry = { rayStart, stopCoord: actualCoord };
            if (actualCoord < targetCoord) lower = bracketEntry;
            else upper = bracketEntry;
          }
          return bestEntry;
        };

        const negativeCount = Math.floor(desiredAdditionalRayCount / 2);
        const positiveCount = desiredAdditionalRayCount - negativeCount;
        const resampled: any[] = [];
        const buildBlendedSectionEntry = (boundaryEntry: any, fraction: number, type: string, side: string) => {
          const boundaryPath = Array.isArray(boundaryEntry?.rayPath) ? boundaryEntry.rayPath : [];
          const pointCount = Math.min(chiefRayPath.length, boundaryPath.length);
          if (pointCount < 2) return null;
          const rayPath = Array.from({ length: pointCount }, (_, pointIndex) => {
            const chiefPoint = chiefRayPath[pointIndex];
            const boundaryPoint = boundaryPath[pointIndex];
            return {
              ...chiefPoint,
              ...boundaryPoint,
              x: Number(chiefPoint.x) + (Number(boundaryPoint.x) - Number(chiefPoint.x)) * fraction,
              y: Number(chiefPoint.y) + (Number(boundaryPoint.y) - Number(chiefPoint.y)) * fraction,
              z: Number(chiefPoint.z) + (Number(boundaryPoint.z) - Number(chiefPoint.z)) * fraction,
            };
          });
          const boundaryStart = boundaryEntry?.rayStart || {};
          const startP = rayPath[0];
          const planeU = (Number(boundaryStart?.planeCoords?.u) || 0) * fraction;
          const planeV = (Number(boundaryStart?.planeCoords?.v) || 0) * fraction;
          const stopPoint = getRenderTargetPointFromRayPath(rayPath, opticalSystemRows, stopSurfaceIndex);
          const stopXCoord = Number(stopPoint?.x);
          const stopYCoord = Number(stopPoint?.y);
          return {
            rayStart: {
              ...boundaryStart,
              startP,
              dir: boundaryStart?.dir || chiefStart.dir,
              planeCoords: { u: planeU, v: planeV },
            },
            type,
            side,
            rayPath,
            ...(Number.isFinite(stopXCoord) ? { __cooptStopXCoord: stopXCoord } : {}),
            ...(Number.isFinite(stopYCoord) ? { __cooptStopYCoord: stopYCoord } : {}),
            __cooptStopAxisCoord: axis === 'XZ' ? stopXCoord : stopYCoord,
            __cooptUniformSectionBlend: true,
          };
        };
        const resolveLimitedBoundaryEntry = (candidate: any, limit: number, type: string, side: string) => {
          if (Math.abs(candidate.stopCoord - limit) <= 1e-9) return candidate;
          const limited = interpolateAtStopCoord(limit, type, side);
          const limitedCoord = Number(limited?.__cooptStopAxisCoord);
          if (limited && Number.isFinite(limitedCoord) && Math.abs(limitedCoord - limit) <= 1e-7) {
            return { ...limited, stopCoord: limitedCoord };
          }
          const span = candidate.stopCoord - chiefStopCoord;
          const fraction = Math.abs(span) > 1e-12
            ? Math.max(0, Math.min(1, (limit - chiefStopCoord) / span))
            : 1;
          const blended = buildBlendedSectionEntry(candidate, fraction, type, side);
          const blendedCoord = Number(blended?.__cooptStopAxisCoord);
          return blended && Number.isFinite(blendedCoord)
            ? { ...blended, stopCoord: blendedCoord }
            : candidate;
        };
        const appendSide = (boundaryEntry: any, count: number, side: string, marginalType: string, crossType: string) => {
          const boundary = boundaryEntry.stopCoord;
          for (let index = 1; index <= count; index += 1) {
            const fraction = index / count;
            const target = chiefStopCoord + (boundary - chiefStopCoord) * fraction;
            const type = index === count ? marginalType : crossType;
            let entry = interpolateAtStopCoord(target, type, side);
            const actualCoord = Number(entry?.__cooptStopAxisCoord);
            if (!Number.isFinite(actualCoord) || Math.abs(actualCoord - target) > 1e-7) {
              entry = buildBlendedSectionEntry(boundaryEntry, fraction, type, side);
            }
            if (entry) resampled.push(entry);
          }
        };
        const negativeLimit = onAxisSectionStopInterval
          ? Math.max(sorted[0].stopCoord, onAxisSectionStopInterval.min)
          : sorted[0].stopCoord;
        const positiveLimit = onAxisSectionStopInterval
          ? Math.min(sorted[sorted.length - 1].stopCoord, onAxisSectionStopInterval.max)
          : sorted[sorted.length - 1].stopCoord;
        const negativeSide = axis === 'XZ' ? 'left' : 'lower';
        const positiveSide = axis === 'XZ' ? 'right' : 'upper';
        const negativeMarginal = axis === 'XZ' ? 'left_marginal' : 'lower_marginal';
        const positiveMarginal = axis === 'XZ' ? 'right_marginal' : 'upper_marginal';
        const sectionCrossType = axis === 'XZ' ? 'horizontal_cross' : 'vertical_cross';
        const negativeBoundaryEntry = resolveLimitedBoundaryEntry(sorted[0], negativeLimit, negativeMarginal, negativeSide);
        const positiveBoundaryEntry = resolveLimitedBoundaryEntry(sorted[sorted.length - 1], positiveLimit, positiveMarginal, positiveSide);
        appendSide(
          negativeBoundaryEntry,
          negativeCount,
          negativeSide,
          negativeMarginal,
          sectionCrossType,
        );
        appendSide(
          positiveBoundaryEntry,
          positiveCount,
          positiveSide,
          positiveMarginal,
          sectionCrossType,
        );
        return resampled.length === desiredAdditionalRayCount ? resampled : candidates;
      };

      const selectExactCandidates = (candidates: Array<{ rayStart: any; type: string; side: string; rayPath: any[] }>) => {
        const normalized = normalizeExactSectionCandidates(candidates, axis);
        const selected = selectCrossRaysForAxis(
          normalized.map((entry) => ({
            ...entry,
            originalRay: {
              type: entry.type,
              side: entry.side,
              __cooptStopXCoord: entry.__cooptStopXCoord,
              __cooptStopYCoord: entry.__cooptStopYCoord,
              __cooptStopAxisCoord: entry.__cooptStopAxisCoord,
            },
          })),
          desiredAdditionalRayCount,
          axis,
        );
        return { normalized, selected };
      };

      const crossCandidateType = axis === 'XZ'
        ? 'horizontal_cross'
        : (axis === 'YZ' ? 'vertical_cross' : '');
      const negativeMarginalType = axis === 'XZ' ? 'left_marginal' : 'lower_marginal';
      const positiveMarginalType = axis === 'XZ' ? 'right_marginal' : 'upper_marginal';
      const requiredAdditionalCount = desiredAdditionalRayCount;

      let candidateExactRays = collectAxisCandidateExactRays(tracedRayStarts, expectedChiefOrigin);
      candidateExactRays = resampleInfiniteSectionCandidates(candidateExactRays);
      let { normalized: normalizedExactCandidates, selected: selectedExactRays } = selectExactCandidates(candidateExactRays);
      let selectedHasCrossCandidate = crossCandidateType
        ? selectedExactRays.some((entry: any) => String(entry?.type ?? '').trim().toLowerCase() === crossCandidateType)
        : false;

      if (axis !== 'BOTH' && desiredRayCount >= 4 && !selectedHasCrossCandidate) {
        const oddFallbackGenerationRayCount = candidateGenerationRayCount % 2 === 0
          ? Math.max(5, candidateGenerationRayCount - 1)
          : candidateGenerationRayCount;
        if (oddFallbackGenerationRayCount !== candidateGenerationRayCount) {
          const fallbackRayStarts = generateRayStartPointsForObject(
            separatedResolvedRow,
            opticalSystemRows,
            oddFallbackGenerationRayCount,
            null,
            {
              pattern: exactPattern,
              wavelengthUm,
              conjugateType,
              pupilScale: 1,
              aimThroughStop: true,
              useChiefRayAnalysis: true,
              allowStopBasedOriginSolve: true,
              originSolveTraceBackend: preferredTraceBackend,
              imageHeightValidationTraceBackend: preferredTraceBackend,
              targetSurfaceIndex,
              disableCrossExtent: true,
              crossType,
              exactCrossBeamSampling: true,
              displayAxisAlignedSampling: axis !== 'BOTH',
              preserveChiefNormalEmissionPlane: true,
            }
          );
          const fallbackStarts = Array.isArray(fallbackRayStarts) ? fallbackRayStarts : [];
          if (fallbackStarts.length > 0) {
            const fallbackExpectedChiefOrigin = (fallbackRayStarts as any)?.expectedChiefOrigin;
            const fallbackCandidateExactRays = collectAxisCandidateExactRays(fallbackStarts, fallbackExpectedChiefOrigin);
            const fallbackSelection = selectExactCandidates(fallbackCandidateExactRays);
            const fallbackHasCrossCandidate = crossCandidateType
              ? fallbackSelection.selected.some((entry: any) => String(entry?.type ?? '').trim().toLowerCase() === crossCandidateType)
              : false;
            if (fallbackHasCrossCandidate || fallbackSelection.selected.length > selectedExactRays.length) {
              candidateExactRays = fallbackCandidateExactRays;
              normalizedExactCandidates = fallbackSelection.normalized;
              selectedExactRays = fallbackSelection.selected;
            }
          }
        }
      }

      let syntheticCrossAdded = false;
      const requiredCrossCount = desiredRayCount === 5 ? 2 : 1;
      const countCrossInSelected = (items: any[]) => {
        if (!crossCandidateType) return 0;
        return (Array.isArray(items) ? items : []).filter((entry: any) => String(entry?.type ?? '').trim().toLowerCase() === crossCandidateType).length;
      };
      if (conjugateType !== 'infinite' && axis !== 'BOTH' && desiredRayCount >= 4 && (
        countCrossInSelected(selectedExactRays) < requiredCrossCount || selectedExactRays.length < requiredAdditionalCount
      )) {
        const pickByType = (items: any[], typeName: string) => {
          return items.find((entry: any) => String(entry?.type ?? '').trim().toLowerCase() === typeName) || null;
        };
        const negativeEntry = pickByType(selectedExactRays, negativeMarginalType)
          || pickByType(normalizedExactCandidates, negativeMarginalType);
        const positiveEntry = pickByType(selectedExactRays, positiveMarginalType)
          || pickByType(normalizedExactCandidates, positiveMarginalType);

        if (negativeEntry?.rayStart?.startP && negativeEntry?.rayStart?.dir && positiveEntry?.rayStart?.startP && positiveEntry?.rayStart?.dir) {
          const nStart = negativeEntry.rayStart.startP;
          const pStart = positiveEntry.rayStart.startP;
          const nDir = negativeEntry.rayStart.dir;
          const pDir = positiveEntry.rayStart.dir;
          const synthStart = {
            x: (Number(nStart.x) + Number(pStart.x)) / 2,
            y: (Number(nStart.y) + Number(pStart.y)) / 2,
            z: (Number(nStart.z) + Number(pStart.z)) / 2,
          };
          const synthDirRaw = {
            x: (Number(nDir.x) + Number(pDir.x)) / 2,
            y: (Number(nDir.y) + Number(pDir.y)) / 2,
            z: (Number(nDir.z) + Number(pDir.z)) / 2,
          };
          const synthDirNorm = Math.hypot(synthDirRaw.x, synthDirRaw.y, synthDirRaw.z);
          const synthDir = synthDirNorm > 1e-9
            ? {
                x: synthDirRaw.x / synthDirNorm,
                y: synthDirRaw.y / synthDirNorm,
                z: synthDirRaw.z / synthDirNorm,
              }
            : { x: 0, y: 0, z: 1 };
          const synthPathFromPair = (negativeRayPath: any[], positiveRayPath: any[], t = 0.5) => {
            const leftPath = Array.isArray(negativeRayPath) ? negativeRayPath : [];
            const rightPath = Array.isArray(positiveRayPath) ? positiveRayPath : [];
            const pointCount = Math.min(leftPath.length, rightPath.length);
            if (pointCount < 2) return null;
            const blended = [] as any[];
            const alpha = Math.max(0, Math.min(1, Number(t)));
            for (let i = 0; i < pointCount; i += 1) {
              const lp = leftPath[i] || {};
              const rp = rightPath[i] || {};
              const lx = Number(lp?.x);
              const ly = Number(lp?.y);
              const lz = Number(lp?.z);
              const rx = Number(rp?.x);
              const ry = Number(rp?.y);
              const rz = Number(rp?.z);
              blended.push({
                ...lp,
                ...rp,
                x: Number.isFinite(lx) && Number.isFinite(rx) ? (1 - alpha) * lx + alpha * rx : (Number.isFinite(lx) ? lx : rx),
                y: Number.isFinite(ly) && Number.isFinite(ry) ? (1 - alpha) * ly + alpha * ry : (Number.isFinite(ly) ? ly : ry),
                z: Number.isFinite(lz) && Number.isFinite(rz) ? (1 - alpha) * lz + alpha * rz : (Number.isFinite(lz) ? lz : rz),
                surfaceIndex: Number.isFinite(Number(lp?.surfaceIndex)) ? Number(lp.surfaceIndex) : Number(rp?.surfaceIndex),
              });
            }
            return blended.length >= 2 ? blended : null;
          };
          const nU = Number(negativeEntry?.rayStart?.planeCoords?.u);
          const pU = Number(positiveEntry?.rayStart?.planeCoords?.u);
          const nV = Number(negativeEntry?.rayStart?.planeCoords?.v);
          const pV = Number(positiveEntry?.rayStart?.planeCoords?.v);
          const edgeBiasedPair = axis === 'YZ' ? [0.05, 0.95] : [0.35, 0.65];
          const tCandidates = requiredCrossCount >= 2 ? [...edgeBiasedPair, 0.5] : [0.5, ...edgeBiasedPair];
          let synthIndex = 0;
          for (const t of tCandidates) {
            const currentCrossCount = countCrossInSelected(selectedExactRays);
            if (currentCrossCount >= requiredCrossCount && selectedExactRays.length >= requiredAdditionalCount) break;

            const localStart = {
              x: (1 - t) * Number(nStart.x) + t * Number(pStart.x),
              y: (1 - t) * Number(nStart.y) + t * Number(pStart.y),
              z: (1 - t) * Number(nStart.z) + t * Number(pStart.z),
            };
            const projectedLocalStart = projectPointToChiefNormalPlane(chiefStart.startP, chiefStart.dir, localStart);
            const localDirRaw = {
              x: (1 - t) * Number(nDir.x) + t * Number(pDir.x),
              y: (1 - t) * Number(nDir.y) + t * Number(pDir.y),
              z: (1 - t) * Number(nDir.z) + t * Number(pDir.z),
            };
            const localDirNorm = Math.hypot(localDirRaw.x, localDirRaw.y, localDirRaw.z);
            const localDir = localDirNorm > 1e-9
              ? { x: localDirRaw.x / localDirNorm, y: localDirRaw.y / localDirNorm, z: localDirRaw.z / localDirNorm }
              : synthDir;

            const tracedSyntheticPath = traceExactRayForRender(projectedLocalStart, localDir, isImageHeight);
            const fallbackBlendedPath = synthPathFromPair(negativeEntry?.rayPath, positiveEntry?.rayPath, t);
            const synthPathRaw = Array.isArray(tracedSyntheticPath) && tracedSyntheticPath.length > 1
              ? tracedSyntheticPath
              : fallbackBlendedPath;
            const synthPath = Array.isArray(synthPathRaw)
              ? translateRenderRayPathAlongChiefNormal(synthPathRaw, projectedLocalStart, chiefStart.startP, chiefStart.dir)
              : synthPathRaw;
            if (!synthPath) continue;

            const synthAxisCoord = axis === 'XZ'
              ? (Number.isFinite(Number(localStart.x)) ? Number(localStart.x) : (Number.isFinite(nU) && Number.isFinite(pU) ? (1 - t) * nU + t * pU : Number.NaN))
              : (Number.isFinite(Number(localStart.y)) ? Number(localStart.y) : (Number.isFinite(nV) && Number.isFinite(pV) ? (1 - t) * nV + t * pV : Number.NaN));
            const synthSide = axis === 'XZ'
              ? (synthAxisCoord < -1e-9 ? 'left' : (synthAxisCoord > 1e-9 ? 'right' : (t < 0.5 ? 'left' : (t > 0.5 ? 'right' : 'center'))))
              : (synthAxisCoord < -1e-9 ? 'lower' : (synthAxisCoord > 1e-9 ? 'upper' : (t < 0.5 ? 'lower' : (t > 0.5 ? 'upper' : 'center'))));
            const synthEntry = {
              rayStart: {
                startP: projectedLocalStart,
                dir: localDir,
                planeCoords: {
                  u: Number.isFinite(nU) && Number.isFinite(pU) ? (1 - t) * nU + t * pU : 0,
                  v: Number.isFinite(nV) && Number.isFinite(pV) ? (1 - t) * nV + t * pV : 0,
                },
              },
              type: crossCandidateType,
              side: synthSide,
              interpolationRatio: t,
              rayPath: synthPath,
              __cooptSyntheticCross: true,
              __cooptSyntheticCrossIndex: synthIndex++,
            };

            if (selectedExactRays.length < requiredAdditionalCount) {
              selectedExactRays = [...selectedExactRays, synthEntry];
              syntheticCrossAdded = true;
              continue;
            }

            if (countCrossInSelected(selectedExactRays) < requiredCrossCount) {
              const replaceIndex = selectedExactRays.findIndex((entry: any) => {
                const type = String(entry?.type ?? '').trim().toLowerCase();
                return type !== negativeMarginalType && type !== positiveMarginalType && type !== crossCandidateType;
              });
              if (replaceIndex >= 0) {
                selectedExactRays = selectedExactRays.map((entry: any, index: number) => index === replaceIndex ? synthEntry : entry);
                syntheticCrossAdded = true;
              }
            }
          }

          selectedHasCrossCandidate = countCrossInSelected(selectedExactRays) > 0;
        }
      }

      try {
        (window as any).__cooptLastExactLowCountDebug = {
          axis,
          desiredRayCount,
          generationRayCount,
          objectIndex,
          totalStartCount: tracedRayStarts.length,
          tracedCandidateCount: candidateExactRays.length,
          normalizedCandidateCount: normalizedExactCandidates.length,
          selectedCandidateCount: selectedExactRays.length,
          selectedHasCrossCandidate,
          syntheticCrossAdded,
          tracedSides: candidateExactRays.map((entry) => ({
            type: entry.type,
            side: entry.side,
            u: Number(entry?.rayStart?.planeCoords?.u ?? NaN),
            v: Number(entry?.rayStart?.planeCoords?.v ?? NaN),
          })),
          normalizedSides: normalizedExactCandidates.map((entry) => ({
            type: entry.type,
            side: entry.side,
            u: Number(entry?.rayStart?.planeCoords?.u ?? NaN),
            v: Number(entry?.rayStart?.planeCoords?.v ?? NaN),
          })),
          selectedSides: selectedExactRays.map((entry: any) => ({
            type: entry.type,
            side: entry.side,
            u: Number(entry?.rayStart?.planeCoords?.u ?? NaN),
            v: Number(entry?.rayStart?.planeCoords?.v ?? NaN),
          })),
        };
      } catch (_) {}

      selectedExactRays.forEach((entry: any) => {
        pushExactRay(entry.rayStart, entry.type, entry.side, entry.rayPath);
      });
      return;
    } catch (error) {
      console.warn('[RenderWindow] Failed to build exact low-count render rays:', error);
    }
  });

  logQconTraceSummaryForRender('buildExactLowCountRenderRaysForObjects');
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

  const rustReady = !!getRustRayTracingWasmSync();
  const preferredTraceBackend = rustReady ? 'rust' : 'ts';

  const imageSurfaceIndex = opticalSystemRows.findIndex((row: any) => {
    const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
    const normalized = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
    return normalized === 'image' || normalized.startsWith('image');
  });
  const targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);
  const traceOptions = {
    allowNonStrict: true,
    useRustWasm: rustReady,
    requireRustWasm: false,
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
    const hasImageHeightTarget = objectRow?.__cooptImageHeightTarget
      && Number.isFinite(Number(objectRow.__cooptImageHeightTarget.x))
      && Number.isFinite(Number(objectRow.__cooptImageHeightTarget.y));
    if (!isRenderImageHeightObjectRow(objectRow)) return ray;

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
      const resolvedObjectRow = hasImageHeightTarget || isRenderImageHeightObjectRow(objectRow)
        ? convertImageHeightToEffectiveObject(
            objectRow,
            opticalSystemRows,
            wavelengthUm,
            isInfiniteSystem ? 'infinite' : 'finite',
            {
              skipTsValidation: true,
              validationTraceBackend: preferredTraceBackend,
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
          imageHeightValidationTraceBackend: preferredTraceBackend,
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
  const positionNorm = normalizeRenderObjectPositionTag(row?.position);
  const effectivePositionNorm = normalizeRenderObjectPositionTag(row?.__cooptEffectivePosition);
  const isRawImageHeightRow = positionNorm === 'imageheight' && !effectivePositionNorm;
  const tableX = Number(row?.xHeightAngle);
  const tableY = Number(row?.yHeightAngle);
  if (isRawImageHeightRow && Number.isFinite(tableX) && Number.isFinite(tableY)) {
    return { x: tableX, y: tableY };
  }

  if (positionNorm && positionNorm !== 'imageheight') return null;

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
  if (![ox, oy, oz, dx, dy, dz].every(Number.isFinite)) {
    return fallbackRayStart?.startP && fallbackRayStart?.dir
      ? {
        ...fallbackRayStart,
        isChief: true,
        description: fallbackRayStart?.description || label,
      }
      : fallbackRayStart;
  }

  return {
    ...(fallbackRayStart && typeof fallbackRayStart === 'object' ? fallbackRayStart : {}),
    startP: { x: ox, y: oy, z: oz },
    dir: { x: dx, y: dy, z: dz },
    isChief: true,
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

function buildAxisScopedRenderObjectRow(
  row: any,
  axis: 'YZ' | 'XZ' | 'BOTH',
): any {
  const scopedRow = buildAxisScopedRenderImageHeightRow(row, axis);
  if (axis === 'BOTH') return scopedRow;
  return {
    ...scopedRow,
    __cooptCrossSectionAxis: axis,
    ...(axis === 'XZ'
      ? { yHeightAngle: 0, yAngle: 0, objectAngleY: 0, y: 0, angle: 0, angleY: 0 }
      : { xHeightAngle: 0, xAngle: 0, objectAngleX: 0, x: 0, angleX: 0 }),
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

function summarizeRenderSectionRayAngles(
  rays: any[],
  axis: 'XZ' | 'YZ',
  opticalSystemRows?: any[],
  objectRows?: any[],
): {
  text: string;
  reqDefaultObjectIndex: number | null;
  maxChief3DObjectIndex: number | null;
  maxRenderChief3DDeg: number | null;
} {
  if (!Array.isArray(rays) || rays.length === 0) {
    return { text: '', reqDefaultObjectIndex: null, maxChief3DObjectIndex: null, maxRenderChief3DDeg: null };
  }

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

  const imageSurfaceIndex = Array.isArray(opticalSystemRows)
    ? opticalSystemRows.findIndex((row: any) => {
      const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
      const normalized = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
      return normalized === 'image' || normalized.startsWith('image');
    })
    : -1;

  const imagePathPointIndex = ((): number | null => {
    if (!Array.isArray(opticalSystemRows) || imageSurfaceIndex < 0) return null;
    let count = 0;
    for (let index = 0; index <= imageSurfaceIndex; index += 1) {
      const row = opticalSystemRows[index];
      if (isCoordTransRow(row) || isObjectRow(row) || isGapRow(row) || isThinLensBackRow(row)) continue;
      count += 1;
    }
    return count > 0 ? count : null;
  })();

  const pickPath = (ray: any): any[] | null => {
    const candidatePaths = [ray?.rayPath, ray?.rayPathToTarget, ray?.path, ray?.originalRay?.rayPath];
    for (const candidate of candidatePaths) {
      if (Array.isArray(candidate) && candidate.length >= 2) return candidate;
    }
    return null;
  };

  const toSegmentDir = (ray: any): { x: number; y: number; z: number } | null => {
    const path = pickPath(ray);
    if (!Array.isArray(path) || path.length < 2) return null;

    let p0 = path[path.length - 2];
    let p1 = path[path.length - 1];

    if (imagePathPointIndex !== null) {
      if (imagePathPointIndex >= 1 && imagePathPointIndex < path.length) {
        p1 = path[imagePathPointIndex];
        p0 = path[imagePathPointIndex - 1];
      } else if (imageSurfaceIndex >= 0) {
        for (let index = path.length - 1; index >= 1; index -= 1) {
          const pointSurfaceIndex = Number(path[index]?.surfaceIndex ?? path[index]?.surface ?? path[index]?.surfaceIdx);
          if (Number.isInteger(pointSurfaceIndex) && pointSurfaceIndex === imageSurfaceIndex) {
            p1 = path[index];
            p0 = path[index - 1];
            break;
          }
        }
      }
    }

    const dx = Number(p1?.x) - Number(p0?.x);
    const dy = Number(p1?.y) - Number(p0?.y);
    const dz = Number(p1?.z) - Number(p0?.z);
    if (![dx, dy, dz].every(Number.isFinite)) return null;
    const norm = Math.hypot(dx, dy, dz);
    if (!(Number.isFinite(norm) && norm > 1e-12)) return null;
    return { x: dx / norm, y: dy / norm, z: dz / norm };
  };

  const toDeg = (numerator: number, z: number): number => {
    if (!Number.isFinite(numerator) || !Number.isFinite(z)) return Number.NaN;
    const deg = Math.atan2(Math.abs(numerator), Math.abs(z)) * 180 / Math.PI;
    return Number.isFinite(deg) ? deg : Number.NaN;
  };

  type ObjAngleStats = {
    chief3DMax: number;
    chiefProjMax: number;
    allProjMax: number;
  };
  const statsByObject = new Map<number, ObjAngleStats>();

  let chief3DMax = Number.NEGATIVE_INFINITY;
  let chiefProjMax = Number.NEGATIVE_INFINITY;
  let allProjMax = Number.NEGATIVE_INFINITY;
  let chief3DMaxObject = -1;
  let chiefProjMaxObject = -1;
  let allProjMaxObject = -1;

  for (const ray of rays) {
    const dir = toSegmentDir(ray);
    if (!dir) continue;

    const objectIndexRaw = Number(ray?.objectIndex ?? ray?.originalRay?.objectIndex);
    const objectIndex = Number.isFinite(objectIndexRaw) ? Math.max(0, Math.floor(objectIndexRaw)) : 0;
    let objStats = statsByObject.get(objectIndex);
    if (!objStats) {
      objStats = {
        chief3DMax: Number.NEGATIVE_INFINITY,
        chiefProjMax: Number.NEGATIVE_INFINITY,
        allProjMax: Number.NEGATIVE_INFINITY,
      };
      statsByObject.set(objectIndex, objStats);
    }

    const projComp = axis === 'YZ' ? dir.y : dir.x;
    const projDeg = toDeg(projComp, dir.z);
    if (Number.isFinite(projDeg)) {
      objStats.allProjMax = Math.max(objStats.allProjMax, projDeg);
      if (projDeg > allProjMax) {
        allProjMax = projDeg;
        allProjMaxObject = objectIndex;
      }
    }

    const typeLabel = String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase();
    const isChief = typeLabel.includes('chief');
    if (!isChief) continue;

    const chief3DDeg = toDeg(Math.hypot(dir.x, dir.y), dir.z);
    if (Number.isFinite(chief3DDeg)) {
      objStats.chief3DMax = Math.max(objStats.chief3DMax, chief3DDeg);
      if (chief3DDeg > chief3DMax) {
        chief3DMax = chief3DDeg;
        chief3DMaxObject = objectIndex;
      }
    }
    if (Number.isFinite(projDeg)) {
      objStats.chiefProjMax = Math.max(objStats.chiefProjMax, projDeg);
      if (projDeg > chiefProjMax) {
        chiefProjMax = projDeg;
        chiefProjMaxObject = objectIndex;
      }
    }
  }

  if (!Number.isFinite(chief3DMax)) {
    return {
      text: Number.isFinite(allProjMax)
        ? ` | Max(${axis})=${allProjMax.toFixed(3)}deg`
        : '',
      reqDefaultObjectIndex: null,
      maxChief3DObjectIndex: null,
      maxRenderChief3DDeg: null,
    };
  }

  const chiefProjText = Number.isFinite(chiefProjMax) ? chiefProjMax.toFixed(3) : 'N/A';
  const maxProjText = Number.isFinite(allProjMax) ? allProjMax.toFixed(3) : 'N/A';

  const objectIndices = Array.from(statsByObject.keys()).sort((a, b) => a - b);
  const formatObjectLabel = (objectIndex: number): string => {
    const idxLabel = `Obj${objectIndex + 1}`;
    if (!Array.isArray(objectRows) || objectIndex < 0 || objectIndex >= objectRows.length) return idxLabel;
    const row = objectRows[objectIndex];
    const rowIdRaw = row?.id;
    if (rowIdRaw === undefined || rowIdRaw === null || String(rowIdRaw).trim() === '') return idxLabel;
    return `${idxLabel}[id=${String(rowIdRaw).trim()}]`;
  };
  if (objectIndices.length <= 1) {
    return {
      text: ` | RenderChief@Image(3D)=${chief3DMax.toFixed(3)}deg, RenderChief(${axis})=${chiefProjText}deg, Max(${axis})=${maxProjText}deg`,
      reqDefaultObjectIndex: objectIndices.length === 1 ? objectIndices[0] : null,
      maxChief3DObjectIndex: chief3DMaxObject >= 0 ? chief3DMaxObject : null,
      maxRenderChief3DDeg: Number.isFinite(chief3DMax) ? chief3DMax : null,
    };
  }

  const reqDefaultObjectIndex = objectIndices[0];
  const reqDefaultStats = statsByObject.get(reqDefaultObjectIndex) || null;
  const reqChief3DText = Number.isFinite(Number(reqDefaultStats?.chief3DMax))
    ? Number(reqDefaultStats?.chief3DMax).toFixed(3)
    : 'N/A';
  const reqChiefProjText = Number.isFinite(Number(reqDefaultStats?.chiefProjMax))
    ? Number(reqDefaultStats?.chiefProjMax).toFixed(3)
    : 'N/A';
  const reqObjText = formatObjectLabel(reqDefaultObjectIndex);
  const chiefMaxObjText = chief3DMaxObject >= 0 ? formatObjectLabel(chief3DMaxObject) : 'N/A';
  const projMaxObjText = allProjMaxObject >= 0 ? formatObjectLabel(allProjMaxObject) : 'N/A';
  const chiefProjMaxObjText = chiefProjMaxObject >= 0 ? formatObjectLabel(chiefProjMaxObject) : 'N/A';

  return {
    text: ` | ${reqObjText}: RenderChief@Image(3D)=${reqChief3DText}deg, RenderChief(${axis})=${reqChiefProjText}deg | MaxRenderChief(3D)=${chief3DMax.toFixed(3)}deg@${chiefMaxObjText}, MaxRenderChief(${axis})=${chiefProjText}deg@${chiefProjMaxObjText}, Max(${axis})=${maxProjText}deg@${projMaxObjText}`,
    reqDefaultObjectIndex,
    maxChief3DObjectIndex: chief3DMaxObject >= 0 ? chief3DMaxObject : null,
    maxRenderChief3DDeg: Number.isFinite(chief3DMax) ? chief3DMax : null,
  };
}

const renderReqChiefAngleCache = new Map<string, number>();

function renderToFiniteNumber(value: any, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readPrimaryWavelengthFromSourceRowsForRender(sourceRows: any[]): number {
  if (!Array.isArray(sourceRows) || sourceRows.length === 0) return 0.5876;
  const pickWavelength = (row: any): number => {
    const candidate = Number(row?.wavelength ?? row?.Wavelength ?? row?.lambda ?? row?.Lambda);
    return Number.isFinite(candidate) && candidate > 0 ? candidate : Number.NaN;
  };
  const primaryRow = sourceRows.find((row: any) => {
    const raw = row?.isPrimary ?? row?.primary ?? row?.Primary;
    if (raw === true || raw === 1) return true;
    const s = String(raw ?? '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'primary';
  });
  const primaryWl = pickWavelength(primaryRow);
  if (Number.isFinite(primaryWl)) return primaryWl;
  for (const row of sourceRows) {
    const wl = pickWavelength(row);
    if (Number.isFinite(wl)) return wl;
  }
  return 0.5876;
}

function isRenderInfiniteSystemFromRows(opticalSystemRows: any[]): boolean {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return false;
  const t = opticalSystemRows[0]?.thickness;
  if (t === Infinity) return true;
  const s = (t === undefined || t === null) ? '' : String(t).trim().toUpperCase();
  if (s === 'INF' || s === 'INFINITY' || s === '∞') return true;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n) > 1e6;
}

function toReqFieldSettingFromRenderObjectRow(
  objRow: any,
  index0: number,
  opticalSystemRows: any[],
  wavelengthUm: number,
): any {
  const isInfiniteSystem = isRenderInfiniteSystemFromRows(opticalSystemRows);
  if (!objRow || typeof objRow !== 'object') {
    return isInfiniteSystem
      ? {
        type: 'Angle',
        position: 'Angle',
        objectIndex: index0 + 1,
        displayName: `Object ${index0 + 1}`,
        x: 0,
        y: 0,
        fieldAngle: { x: 0, y: 0 },
        xFieldAngle: 0,
        yFieldAngle: 0,
        xHeightAngle: 0,
        yHeightAngle: 0,
        angleX: 0,
        angleY: 0,
        xHeight: 0,
        yHeight: 0,
      }
      : {
        type: 'Rectangle',
        position: 'Rectangle',
        objectIndex: index0 + 1,
        displayName: `Object ${index0 + 1}`,
        x: 0,
        y: 0,
        xHeight: 0,
        yHeight: 0,
        fieldAngle: { x: 0, y: 0 },
        fieldX: 0,
        fieldY: 0,
      };
  }

  let normalizedRow = objRow;
  const positionRaw = String(objRow.position ?? objRow.fieldType ?? objRow.type ?? '').trim().toLowerCase();
  if (positionRaw.includes('imageheight') && Array.isArray(opticalSystemRows) && opticalSystemRows.length > 0) {
    try {
      const conjugateType = detectConjugateType(opticalSystemRows) === 'finite' ? 'finite' : 'infinite';
      const effectiveRow = convertImageHeightToEffectiveObject(
        objRow,
        opticalSystemRows,
        wavelengthUm,
        conjugateType,
        {
          skipTsValidation: true,
          validationTraceBackend: 'rust',
        },
      );
      if (effectiveRow && typeof effectiveRow === 'object') {
        normalizedRow = {
          ...objRow,
          ...effectiveRow,
          position: objRow.position,
          __cooptOriginalPosition: objRow.position,
        };
      }
    } catch (_) {}
  }

  const pickFirstFinite = (values: any[], fallback = 0): number => {
    for (const value of values) {
      const n = renderToFiniteNumber(value, Number.NaN);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  };

  const fieldX = pickFirstFinite([
    normalizedRow.xHeightAngle,
    normalizedRow.xFieldAngle,
    normalizedRow.xHeight,
    normalizedRow.x,
    normalizedRow.angleX,
    normalizedRow.Hx,
  ], 0);
  const fieldY = pickFirstFinite([
    normalizedRow.yHeightAngle,
    normalizedRow.yFieldAngle,
    normalizedRow.fieldAngle,
    normalizedRow.yHeight,
    normalizedRow.y,
    normalizedRow.angleY,
    normalizedRow.Hy,
  ], 0);
  const objectIndex1 = index0 + 1;
  const displayName = String(normalizedRow.comment || normalizedRow.name || `Object ${objectIndex1}`);

  if (isInfiniteSystem) {
    return {
      type: 'Angle',
      position: 'Angle',
      objectIndex: objectIndex1,
      displayName,
      x: fieldX,
      y: fieldY,
      fieldAngle: { x: fieldX, y: fieldY },
      xFieldAngle: fieldX,
      yFieldAngle: fieldY,
      xHeightAngle: fieldX,
      yHeightAngle: fieldY,
      angleX: fieldX,
      angleY: fieldY,
      xHeight: 0,
      yHeight: 0,
    };
  }

  return {
    type: 'Rectangle',
    position: 'Rectangle',
    objectIndex: objectIndex1,
    displayName,
    x: fieldX,
    y: fieldY,
    xHeight: fieldX,
    yHeight: fieldY,
    fieldAngle: { x: 0, y: 0 },
    fieldX,
    fieldY,
  };
}

function computeReqChiefAngleDegViaJsForObject(
  opticalSystemRows: any[],
  objectRows: any[],
  sourceRows: any[],
  objectIndex0: number,
): number | null {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return null;
  if (!Array.isArray(objectRows) || objectIndex0 < 0 || objectIndex0 >= objectRows.length) return null;

  const objRow = objectRows[objectIndex0];
  const wavelengthUm = readPrimaryWavelengthFromSourceRowsForRender(sourceRows);
  const fieldSetting = toReqFieldSettingFromRenderObjectRow(objRow, objectIndex0, opticalSystemRows, wavelengthUm);
  const chiefResult = calculateChiefRayNewton(opticalSystemRows, fieldSetting, wavelengthUm, 'unified', { rayCount: 51 });

  const dir = chiefResult?.rayData?.dir || chiefResult?.dir;
  const dx = renderToFiniteNumber(dir?.x, Number.NaN);
  const dy = renderToFiniteNumber(dir?.y, Number.NaN);
  const dz = renderToFiniteNumber(dir?.z, Number.NaN);
  if (![dx, dy, dz].every(Number.isFinite)) return null;

  const transverse = Math.sqrt(dx * dx + dy * dy);
  const angleDeg = Math.atan2(transverse, Math.abs(dz)) * 180 / Math.PI;
  return Number.isFinite(angleDeg) ? Math.abs(angleDeg) : null;
}

async function computeReqChiefAngleDegViaNativeForObject(
  opticalSystemRows: any[],
  objectRows: any[],
  sourceRows: any[],
  objectIndex0: number,
): Promise<{ value: number | null; reason?: string }> {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return { value: null, reason: 'no-optical' };
  if (!Array.isArray(objectRows) || objectRows.length === 0) return { value: null, reason: 'no-object' };
  if (!Number.isInteger(objectIndex0) || objectIndex0 < 0 || objectIndex0 >= objectRows.length) return { value: null, reason: 'bad-index' };

  const objectRow = objectRows[objectIndex0];
  if (!objectRow || typeof objectRow !== 'object') return { value: null, reason: 'bad-object-row' };

  const sourceKey = Array.isArray(sourceRows)
    ? sourceRows.map((row: any) => {
      try {
        const wl = row?.wavelength ?? row?.Wavelength ?? '';
        const wt = row?.weight ?? row?.Weight ?? '';
        const isPrimary = row?.isPrimary ?? row?.primary ?? '';
        return `${String(wl)}:${String(wt)}:${String(isPrimary)}`;
      } catch (_) {
        return '';
      }
    }).join('|')
    : '';
  const key = `${buildRenderRowsSignature(opticalSystemRows)}|${buildRenderObjectRowsSignature(objectRows)}|src=${sourceKey}|obj=${objectIndex0}`;
  if (renderReqChiefAngleCache.has(key)) return { value: renderReqChiefAngleCache.get(key) ?? null, reason: 'ok' };

  try {
    const response = await runNativeChiefRayAngle({
      opticalSystemRows,
      objectRows: [objectRow],
      sourceRows: Array.isArray(sourceRows) ? sourceRows : [],
    } as any);
    const value = Number(response?.chiefRayAngleDeg);
    const resolved = Number.isFinite(value) ? value : null;
    if (resolved !== null) {
      renderReqChiefAngleCache.set(key, resolved);
      if (renderReqChiefAngleCache.size > 64) {
        const firstKey = renderReqChiefAngleCache.keys().next().value;
        if (firstKey !== undefined) renderReqChiefAngleCache.delete(firstKey);
      }
    }
    return { value: resolved, reason: resolved === null ? 'native-invalid' : 'ok' };
  } catch (error) {
    const jsFallback = computeReqChiefAngleDegViaJsForObject(opticalSystemRows, objectRows, sourceRows, objectIndex0);
    if (Number.isFinite(jsFallback)) {
      const resolvedFallback = Number(jsFallback);
      renderReqChiefAngleCache.set(key, resolvedFallback);
      if (renderReqChiefAngleCache.size > 64) {
        const firstKey = renderReqChiefAngleCache.keys().next().value;
        if (firstKey !== undefined) renderReqChiefAngleCache.delete(firstKey);
      }
      return { value: resolvedFallback, reason: 'js-fallback' };
    }
    const nativeMessage = String((error as any)?.message || '').trim();
    if (nativeMessage) {
      return { value: null, reason: `native-throw:${nativeMessage}` };
    }
    return { value: null, reason: 'native-throw' };
  }
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

function getObjectSurfaceRenderDistanceFromConfig(targetWindow: any): number | null {
  try {
    const cfgRoot = getSystemConfigFromWindow(targetWindow);
    const configs = Array.isArray(cfgRoot?.configurations) ? cfgRoot.configurations : [];
    const activeId = cfgRoot?.activeConfigId;
    const activeConfig = configs.find((cfg: any) => String(cfg?.id) === String(activeId)) || configs[0] || null;
    const blocks = Array.isArray(activeConfig?.blocks) ? activeConfig.blocks : [];
    const objectBlock = blocks.find((block: any) => {
      const type = String(block?.blockType ?? '').trim();
      return type === 'ObjectSurface' || type === 'ObjectPlane';
    });
    if (!objectBlock) return null;
    const params = objectBlock.parameters && typeof objectBlock.parameters === 'object' ? objectBlock.parameters : {};
    const vars = objectBlock.variables && typeof objectBlock.variables === 'object' ? objectBlock.variables : {};
    const readValue = (key: string) => {
      if (Object.prototype.hasOwnProperty.call(params, key)) return params[key];
      const variableValue = vars[key];
      if (variableValue && typeof variableValue === 'object' && Object.prototype.hasOwnProperty.call(variableValue, 'value')) {
        return variableValue.value;
      }
      return undefined;
    };
    const mode = String(readValue('objectDistanceMode') ?? '').trim().replace(/\s+/g, '').toUpperCase();
    if (mode !== 'INF' && mode !== 'INFINITY') return null;
    const distance = Number(readValue('objectDistance'));
    return Number.isFinite(distance) && distance > 0 ? distance : null;
  } catch (_) {
    return null;
  }
}

function syncRenderObjectDistanceFromConfig(opticalSystemRows: any[], targetWindow: any): any[] {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return opticalSystemRows;
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
  const configuredDistance = getObjectSurfaceRenderDistanceFromConfig(targetWindow);
  if (!(Number.isFinite(configuredDistance) && configuredDistance > 0)) return opticalSystemRows;
  const currentDistance = Number(objectSurface?.objectRenderDistance);
  if (Number.isFinite(currentDistance) && Math.abs(currentDistance - configuredDistance) <= 1e-9) return opticalSystemRows;
  const nextRows = opticalSystemRows.slice();
  nextRows[0] = {
    ...objectSurface,
    objectRenderDistance: configuredDistance,
    __cooptRenderImageHeightDisplayDistance: configuredDistance,
    __cooptRenderObjectDistanceFromBlocks: configuredDistance,
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

function isLensFrontSurface(front: any): boolean {
  return isGlassMaterial(front?.material) || hasLensTag(front);
}

function isLensInterval(front: any, back: any): boolean {
  if (!front || !back) return false;
  if (!isRenderableLensCandidateSurface(front) || !isRenderableLensCandidateSurface(back)) return false;
  const frontBlockId = String(front?._blockId ?? front?.blockId ?? '').trim();
  const backBlockId = String(back?._blockId ?? back?.blockId ?? '').trim();
  const frontIsLens = isLensFrontSurface(front);
  const backIsLens = isGlassMaterial(back?.material) || hasLensTag(back);
  if (frontBlockId || backBlockId) {
    return !!(frontBlockId && backBlockId && frontBlockId === backBlockId && frontIsLens && backIsLens);
  }
  return frontIsLens;
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
const OPD_REFERENCE_MODE_KEY = 'coopt.opd.referenceMode';
const OPD_CHIEF_RAY_MODE_KEY = 'coopt.opd.chiefRayMode';
const OPD_PUPIL_NORMALIZATION_MODE_KEY = 'coopt.opd.pupilNormalizationMode';
const OPD_EXIT_PUPIL_REFERENCE_POINT_MODE_KEY = 'coopt.opd.exitPupilReferencePointMode';
const OPD_REFERENCE_SPHERE_OPTIONS_KEY = 'coopt.opd.referenceSphereOptions';
const GLASS_MAP_MFR_KEY = 'coopt.glassMap.defaultManufacturers';
const DARK_MODE_KEY = 'coopt.darkMode';
const ALLOWED_MFR = ['SCHOTT', 'HOYA', 'HIKARI', 'OHARA', 'Sumita', 'CDGM', 'Special'] as const;

function sanitizeForceModeValue(v: any): 'stop' | 'entrance' | '' {
  const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
  return (s === 'stop' || s === 'entrance') ? s : '';
}

type OpdReferenceModeSetting = 'exit-pupil' | 'image-plane';
type OpdChiefRayModeSetting = 'stop-center' | 'entrance-pupil-center' | 'transmitted-pupil-center';
type OpdPupilNormalizationModeSetting = 'fixed-entrance-pupil' | 'effective-transmitted-pupil';
type OpdExitPupilReferencePointModeSetting = 'chief-ray-intersection' | 'exit-pupil-center';
type OpdReferenceSphereOptionsSetting = {
  referenceSphereWavelengthMode: 'primary-wavelength' | 'per-wavelength';
  opdDisplayMode: 'raw' | 'pistonRemoved' | 'pistonTiltRemoved' | 'pistonDefocusRemoved' | 'pistonTiltDefocusRemoved';
  exitPupilPositionSign: 'as-is' | 'negated';
  exitPupilPlaneDefinition: 'surface-local-axis' | 'global-z';
  chiefImagePoint: 'chief-ray-image-point' | 'paraxial-image-point' | 'sagittal-best-focus-point' | 'tangential-best-focus-point' | 'tan-sag-mid-focus-point' | 'rms-wavefront-best-focus-point' | 'circle-of-least-confusion-point' | 'defocus-zero-reference-point' | 'weighted-tan-sag-focus-point' | 'per-wavelength-best-focus-point' | 'target-surface-center';
  sphereIntersection: 'exit-pupil-side' | 'opposite-side';
  opticalPathSign: 'positive' | 'negative';
  exitPupilDirection: 'image-to-exit-pupil' | 'exit-pupil-to-image';
};

const DEFAULT_OPD_REFERENCE_SPHERE_OPTIONS: OpdReferenceSphereOptionsSetting = {
  referenceSphereWavelengthMode: 'primary-wavelength',
  opdDisplayMode: 'raw',
  exitPupilPositionSign: 'as-is',
  exitPupilPlaneDefinition: 'surface-local-axis',
  chiefImagePoint: 'chief-ray-image-point',
  sphereIntersection: 'exit-pupil-side',
  opticalPathSign: 'positive',
  exitPupilDirection: 'image-to-exit-pupil',
};

function sanitizeOpdReferenceModeSetting(v: any): OpdReferenceModeSetting {
  const mode = String(v ?? '').trim().toLowerCase();
  return mode === 'exit-pupil' || mode === 'image-plane' ? mode : 'exit-pupil';
}

function sanitizeOpdChiefRayModeSetting(v: any): OpdChiefRayModeSetting {
  const mode = String(v ?? '').trim().toLowerCase();
  return mode === 'entrance-pupil-center' || mode === 'transmitted-pupil-center' ? mode : 'stop-center';
}

function sanitizeOpdPupilNormalizationModeSetting(v: any): OpdPupilNormalizationModeSetting {
  return String(v ?? '').trim().toLowerCase() === 'effective-transmitted-pupil'
    ? 'effective-transmitted-pupil'
    : 'fixed-entrance-pupil';
}

function sanitizeOpdExitPupilReferencePointModeSetting(v: any): OpdExitPupilReferencePointModeSetting {
  const mode = String(v ?? '').trim().toLowerCase();
  return mode === 'exit-pupil-center' ? mode : 'chief-ray-intersection';
}

function sanitizeOpdReferenceSphereOptionsSetting(v: any): OpdReferenceSphereOptionsSetting {
  const raw = v && typeof v === 'object' ? v : {};
  return {
    referenceSphereWavelengthMode: raw.referenceSphereWavelengthMode === 'per-wavelength' ? 'per-wavelength' : 'primary-wavelength',
    opdDisplayMode: raw.opdDisplayMode === 'pistonRemoved' || raw.opdDisplayMode === 'pistonTiltRemoved' || raw.opdDisplayMode === 'pistonDefocusRemoved' || raw.opdDisplayMode === 'pistonTiltDefocusRemoved'
      ? raw.opdDisplayMode
      : 'raw',
    exitPupilPositionSign: raw.exitPupilPositionSign === 'negated' ? 'negated' : 'as-is',
    exitPupilPlaneDefinition: raw.exitPupilPlaneDefinition === 'global-z' ? 'global-z' : 'surface-local-axis',
    chiefImagePoint: raw.chiefImagePoint === 'paraxial-image-point'
      || raw.chiefImagePoint === 'sagittal-best-focus-point'
      || raw.chiefImagePoint === 'tangential-best-focus-point'
      || raw.chiefImagePoint === 'tan-sag-mid-focus-point'
      || raw.chiefImagePoint === 'rms-wavefront-best-focus-point'
      || raw.chiefImagePoint === 'circle-of-least-confusion-point'
      || raw.chiefImagePoint === 'defocus-zero-reference-point'
      || raw.chiefImagePoint === 'weighted-tan-sag-focus-point'
      || raw.chiefImagePoint === 'per-wavelength-best-focus-point'
      || raw.chiefImagePoint === 'target-surface-center'
      ? raw.chiefImagePoint
      : 'chief-ray-image-point',
    sphereIntersection: raw.sphereIntersection === 'opposite-side' ? 'opposite-side' : 'exit-pupil-side',
    opticalPathSign: raw.opticalPathSign === 'negative' ? 'negative' : 'positive',
    exitPupilDirection: raw.exitPupilDirection === 'exit-pupil-to-image' ? 'exit-pupil-to-image' : 'image-to-exit-pupil',
  };
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

function applyOpdReferenceModeToWindowGlobals(mode: OpdReferenceModeSetting): void {
  const w = window as any;
  try {
    w.__COOPT_OPD_REFERENCE_MODE = mode;
    w.COOPT_OPD_REFERENCE_MODE = mode;
  } catch (_) {}
}

function applyOpdChiefRayModeToWindowGlobals(mode: OpdChiefRayModeSetting): void {
  const w = window as any;
  try {
    w.__COOPT_OPD_CHIEF_RAY_MODE = mode;
    w.COOPT_OPD_CHIEF_RAY_MODE = mode;
  } catch (_) {}
}

function applyOpdPupilNormalizationModeToWindowGlobals(mode: OpdPupilNormalizationModeSetting): void {
  const w = window as any;
  try {
    w.__COOPT_OPD_PUPIL_NORMALIZATION_MODE = mode;
    w.COOPT_OPD_PUPIL_NORMALIZATION_MODE = mode;
  } catch (_) {}
}

function applyOpdExitPupilReferencePointModeToWindowGlobals(mode: OpdExitPupilReferencePointModeSetting): void {
  const w = window as any;
  try {
    w.__COOPT_OPD_EXIT_PUPIL_REFERENCE_POINT_MODE = mode;
    w.COOPT_OPD_EXIT_PUPIL_REFERENCE_POINT_MODE = mode;
  } catch (_) {}
}

function applyOpdReferenceSphereOptionsToWindowGlobals(options: OpdReferenceSphereOptionsSetting): void {
  const w = window as any;
  try {
    w.__COOPT_OPD_REFERENCE_SPHERE_OPTIONS = options;
    w.COOPT_OPD_REFERENCE_SPHERE_OPTIONS = options;
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
  const [opdReferenceMode, setOpdReferenceMode] = useState<OpdReferenceModeSetting>(() => {
    try { return sanitizeOpdReferenceModeSetting(localStorage.getItem(OPD_REFERENCE_MODE_KEY)); } catch (_) { return 'exit-pupil'; }
  });
  const [opdChiefRayMode, setOpdChiefRayMode] = useState<OpdChiefRayModeSetting>(() => {
    try { return sanitizeOpdChiefRayModeSetting(localStorage.getItem(OPD_CHIEF_RAY_MODE_KEY)); } catch (_) { return 'stop-center'; }
  });
  const [opdPupilNormalizationMode, setOpdPupilNormalizationMode] = useState<OpdPupilNormalizationModeSetting>(() => {
    try { return sanitizeOpdPupilNormalizationModeSetting(localStorage.getItem(OPD_PUPIL_NORMALIZATION_MODE_KEY)); } catch (_) { return 'fixed-entrance-pupil'; }
  });
  const [opdExitPupilReferencePointMode, setOpdExitPupilReferencePointMode] = useState<OpdExitPupilReferencePointModeSetting>(() => {
    try {
      return sanitizeOpdExitPupilReferencePointModeSetting(localStorage.getItem(OPD_EXIT_PUPIL_REFERENCE_POINT_MODE_KEY));
    } catch (_) { return 'chief-ray-intersection'; }
  });
  const [opdReferenceSphereOptions, setOpdReferenceSphereOptions] = useState<OpdReferenceSphereOptionsSetting>(() => {
    try {
      return sanitizeOpdReferenceSphereOptionsSetting(JSON.parse(localStorage.getItem(OPD_REFERENCE_SPHERE_OPTIONS_KEY) || '{}'));
    } catch (_) { return DEFAULT_OPD_REFERENCE_SPHERE_OPTIONS; }
  });
  const [mfrs, setMfrs] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(GLASS_MAP_MFR_KEY) || '[]'); } catch (_) { return []; }
  });
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try { return localStorage.getItem(DARK_MODE_KEY) === 'true'; } catch (_) { return false; }
  });
  const [optimizeRayGridSize, setOptimizeRayGridSize] = useState<OptimizeRayGridSize>(loadOptimizeRayGridSize);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    readDesktopSetting(FORCE_MODE_KEY).then((val) => {
      const m = sanitizeForceModeValue(val);
      if (m) { setForceMode(m); applyForceModeToWindowGlobals(m); }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    readDesktopSetting(OPD_PUPIL_NORMALIZATION_MODE_KEY).then((val) => {
      const mode = sanitizeOpdPupilNormalizationModeSetting(val || localStorage.getItem(OPD_PUPIL_NORMALIZATION_MODE_KEY));
      setOpdPupilNormalizationMode(mode);
      applyOpdPupilNormalizationModeToWindowGlobals(mode);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    readDesktopSetting(OPD_REFERENCE_SPHERE_OPTIONS_KEY).then((val) => {
      const parsed = val ? JSON.parse(val) : JSON.parse(localStorage.getItem(OPD_REFERENCE_SPHERE_OPTIONS_KEY) || '{}');
      const options = sanitizeOpdReferenceSphereOptionsSetting(parsed);
      setOpdReferenceSphereOptions(options);
      applyOpdReferenceSphereOptionsToWindowGlobals(options);
    }).catch(() => applyOpdReferenceSphereOptionsToWindowGlobals(opdReferenceSphereOptions));
  }, []);

  useEffect(() => {
    readDesktopSetting(OPD_EXIT_PUPIL_REFERENCE_POINT_MODE_KEY).then((val) => {
      const mode = sanitizeOpdExitPupilReferencePointModeSetting(
        val || localStorage.getItem(OPD_EXIT_PUPIL_REFERENCE_POINT_MODE_KEY),
      );
      setOpdExitPupilReferencePointMode(mode);
      applyOpdExitPupilReferencePointModeToWindowGlobals(mode);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    readDesktopSetting(OPD_REFERENCE_MODE_KEY).then((val) => {
      const mode = sanitizeOpdReferenceModeSetting(val || localStorage.getItem(OPD_REFERENCE_MODE_KEY));
      setOpdReferenceMode(mode);
      applyOpdReferenceModeToWindowGlobals(mode);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    readDesktopSetting(OPD_CHIEF_RAY_MODE_KEY).then((val) => {
      const mode = sanitizeOpdChiefRayModeSetting(val || localStorage.getItem(OPD_CHIEF_RAY_MODE_KEY));
      setOpdChiefRayMode(mode);
      applyOpdChiefRayModeToWindowGlobals(mode);
    }).catch(() => {});
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

  const handleOpdReferenceModeChange = async (val: OpdReferenceModeSetting) => {
    setOpdReferenceMode(val);
    applyOpdReferenceModeToWindowGlobals(val);
    try { localStorage.setItem(OPD_REFERENCE_MODE_KEY, val); } catch (_) {}
    await writeDesktopSetting(OPD_REFERENCE_MODE_KEY, val);
  };

  const handleOpdChiefRayModeChange = async (val: OpdChiefRayModeSetting) => {
    setOpdChiefRayMode(val);
    applyOpdChiefRayModeToWindowGlobals(val);
    try { localStorage.setItem(OPD_CHIEF_RAY_MODE_KEY, val); } catch (_) {}
    await writeDesktopSetting(OPD_CHIEF_RAY_MODE_KEY, val);
  };

  const handleOpdPupilNormalizationModeChange = async (val: OpdPupilNormalizationModeSetting) => {
    setOpdPupilNormalizationMode(val);
    applyOpdPupilNormalizationModeToWindowGlobals(val);
    try { localStorage.setItem(OPD_PUPIL_NORMALIZATION_MODE_KEY, val); } catch (_) {}
    await writeDesktopSetting(OPD_PUPIL_NORMALIZATION_MODE_KEY, val);
  };

  const handleOpdExitPupilReferencePointModeChange = async (val: OpdExitPupilReferencePointModeSetting) => {
    setOpdExitPupilReferencePointMode(val);
    applyOpdExitPupilReferencePointModeToWindowGlobals(val);
    try { localStorage.setItem(OPD_EXIT_PUPIL_REFERENCE_POINT_MODE_KEY, val); } catch (_) {}
    await writeDesktopSetting(OPD_EXIT_PUPIL_REFERENCE_POINT_MODE_KEY, val);
  };

  const handleOpdReferenceSphereOptionChange = async (key: keyof OpdReferenceSphereOptionsSetting, value: string) => {
    const next = sanitizeOpdReferenceSphereOptionsSetting({ ...opdReferenceSphereOptions, [key]: value });
    setOpdReferenceSphereOptions(next);
    applyOpdReferenceSphereOptionsToWindowGlobals(next);
    const serialized = JSON.stringify(next);
    try { localStorage.setItem(OPD_REFERENCE_SPHERE_OPTIONS_KEY, serialized); } catch (_) {}
    await writeDesktopSetting(OPD_REFERENCE_SPHERE_OPTIONS_KEY, serialized);
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

  const handleOptimizeRayGridSizeChange = (value: string) => {
    const next = saveOptimizeRayGridSize(value);
    setOptimizeRayGridSize(next);
  };

  const mfrSet = new Set(mfrs.map(s => String(s).toUpperCase()));

  return (
    <div className="settings-page">
      <div className="settings-page__content">
        <div className="settings-section-title is-first">Glass Map: Default Manufacturers</div>
        <div className="settings-section-help">
          Choose which manufacturers are enabled by default when opening Glass Map.<br />
          If nothing is selected, Glass Map will show all manufacturers.
        </div>
        <div className="settings-choice-grid">
          {ALLOWED_MFR.map(mfr => (
            <label key={mfr}>
              <input type="checkbox" checked={mfrSet.has(mfr.toUpperCase())} onChange={e => handleMfrChange(mfr, e.target.checked)} />{' '}{mfr}
            </label>
          ))}
        </div>

        <div className="settings-section-title">Appearance</div>
        <div className="settings-section-help">Use a dark workspace palette throughout Co-opt.</div>
        <label className="settings-toggle-row">
          <input type="checkbox" checked={darkMode} onChange={e => handleDarkModeChange(e.target.checked)} />{' '}Enable Dark Mode
        </label>

        <div className="settings-section-title">Optimization</div>
        <div className="settings-section-help">
          Select the pupil sampling density used by Spot operands during optimization.
        </div>
        <label className="settings-field-row">
          <span>Ray grid</span>
          <select
            aria-label="Optimize Ray Grid Size"
            value={optimizeRayGridSize}
            onChange={e => handleOptimizeRayGridSizeChange(e.target.value)}
          >
            {OPTIMIZE_RAY_GRID_SIZES.map(size => (
              <option key={size} value={size}>{size}x{size}</option>
            ))}
          </select>
        </label>

        <div className="settings-section-title">Analysis Defaults</div>
        <div className="settings-section-help">
          Fix the sampling mode used for infinite-field wavefront/PSF/MTF generation.<br />
          This sets <code>__COOPT_FORCE_INFINITE_PUPIL_MODE</code> to <code>stop</code> or <code>entrance</code>.
        </div>
        {!loaded && <div className="settings-loading">Loading…</div>}
        <div className="settings-choice-list" role="group" aria-label="Infinite field pupil sampling mode">
          {(['', 'stop', 'entrance'] as const).map(val => (
            <label key={val}>
              <input type="radio" name="force-mode" value={val} checked={forceMode === val} onChange={() => handleForceModeChange(val)} />
              {' '}{val === '' ? 'Auto (default)' : val === 'stop' ? <>Force <code>stop</code></> : <>Force <code>entrance</code></>}
            </label>
          ))}
        </div>
        <div className="settings-note">Changes take effect on the next calculation.</div>

        <div className="settings-subtitle">OPD Reference</div>
        <div className="settings-section-help">
          Select the reference used for OPD, wavefront, PSF, and MTF calculations.
        </div>
        <div className="settings-choice-list" role="group" aria-label="OPD reference">
          <label>
            <input type="radio" name="opd-reference-mode" value="exit-pupil" checked={opdReferenceMode === 'exit-pupil'} onChange={() => handleOpdReferenceModeChange('exit-pupil')} />{' '}
            Exit Pupil
          </label>
          <label>
            <input type="radio" name="opd-reference-mode" value="image-plane" checked={opdReferenceMode === 'image-plane'} onChange={() => handleOpdReferenceModeChange('image-plane')} />{' '}
            Image Plane
          </label>
        </div>
        <div className="settings-note">Changes take effect on the next calculation.</div>

        <div className="settings-subtitle">OPD Chief Ray</div>
        <div className="settings-section-help">
          Select the center used by the chief ray for OPD reference calculations.
        </div>
        <div className="settings-choice-list" role="group" aria-label="OPD chief ray">
          <label>
            <input type="radio" name="opd-chief-ray-mode" value="stop-center" checked={opdChiefRayMode === 'stop-center'} onChange={() => handleOpdChiefRayModeChange('stop-center')} />{' '}
            Stop Center
          </label>
          <label>
            <input type="radio" name="opd-chief-ray-mode" value="entrance-pupil-center" checked={opdChiefRayMode === 'entrance-pupil-center'} onChange={() => handleOpdChiefRayModeChange('entrance-pupil-center')} />{' '}
            Entrance Pupil Center
          </label>
          <label>
            <input type="radio" name="opd-chief-ray-mode" value="transmitted-pupil-center" checked={opdChiefRayMode === 'transmitted-pupil-center'} onChange={() => handleOpdChiefRayModeChange('transmitted-pupil-center')} />{' '}
            Transmitted Pupil Center
          </label>
        </div>

        <div className="settings-subtitle">OPD Pupil Normalization</div>
        <div className="settings-section-help">
          Select whether the OPD Fan coordinate uses the fixed paraxial entrance pupil or the transmitted pupil envelope.
        </div>
        <div className="settings-choice-list" role="group" aria-label="OPD pupil normalization">
          <label>
            <input type="radio" name="opd-pupil-normalization-mode" value="fixed-entrance-pupil" checked={opdPupilNormalizationMode === 'fixed-entrance-pupil'} onChange={() => handleOpdPupilNormalizationModeChange('fixed-entrance-pupil')} />{' '}
            Fixed Entrance Pupil
          </label>
          <label>
            <input type="radio" name="opd-pupil-normalization-mode" value="effective-transmitted-pupil" checked={opdPupilNormalizationMode === 'effective-transmitted-pupil'} onChange={() => handleOpdPupilNormalizationModeChange('effective-transmitted-pupil')} />{' '}
            Effective Transmitted Pupil
          </label>
        </div>

        <div className="settings-subtitle">Exit Pupil Reference Point</div>
        <div className="settings-section-help">
          Select the point on the exit pupil used to define the reference sphere.
        </div>
        <div className="settings-choice-list" role="group" aria-label="Exit pupil reference point">
          <label>
            <input type="radio" name="opd-exit-pupil-reference-point-mode" value="chief-ray-intersection" checked={opdExitPupilReferencePointMode === 'chief-ray-intersection'} onChange={() => handleOpdExitPupilReferencePointModeChange('chief-ray-intersection')} />{' '}
            Chief Ray / Exit Pupil Intersection
          </label>
          <label>
            <input type="radio" name="opd-exit-pupil-reference-point-mode" value="exit-pupil-center" checked={opdExitPupilReferencePointMode === 'exit-pupil-center'} onChange={() => handleOpdExitPupilReferencePointModeChange('exit-pupil-center')} />{' '}
            Exit Pupil Center
          </label>
        </div>

        <details className="settings-advanced">
          <summary>Reference Sphere Conventions</summary>
          <p>Configure the geometric and sign conventions used by the OPD reference sphere.</p>
          <div className="settings-advanced__grid">
          <label>Reference sphere wavelength
            <select value={opdReferenceSphereOptions.referenceSphereWavelengthMode} onChange={e => handleOpdReferenceSphereOptionChange('referenceSphereWavelengthMode', e.target.value)}>
              <option value="primary-wavelength">Primary wavelength</option><option value="per-wavelength">Per wavelength</option>
            </select>
          </label>
          <div>
            <div style={{ marginBottom: 4 }}>OPD defocus treatment</div>
            <label style={{ display: 'block', marginBottom: 4 }}>
              <input type="radio" name="opd-display-mode" value="raw" checked={opdReferenceSphereOptions.opdDisplayMode === 'raw'} onChange={() => handleOpdReferenceSphereOptionChange('opdDisplayMode', 'raw')} />{' '}
              Raw
            </label>
            <label style={{ display: 'block', marginBottom: 4 }}>
              <input type="radio" name="opd-display-mode" value="pistonRemoved" checked={opdReferenceSphereOptions.opdDisplayMode === 'pistonRemoved'} onChange={() => handleOpdReferenceSphereOptionChange('opdDisplayMode', 'pistonRemoved')} />{' '}
              Remove piston
            </label>
            <label style={{ display: 'block', marginBottom: 4 }}>
              <input type="radio" name="opd-display-mode" value="pistonTiltRemoved" checked={opdReferenceSphereOptions.opdDisplayMode === 'pistonTiltRemoved'} onChange={() => handleOpdReferenceSphereOptionChange('opdDisplayMode', 'pistonTiltRemoved')} />{' '}
              Remove piston / tilt
            </label>
            <label style={{ display: 'block', marginBottom: 4 }}>
              <input type="radio" name="opd-display-mode" value="pistonDefocusRemoved" checked={opdReferenceSphereOptions.opdDisplayMode === 'pistonDefocusRemoved'} onChange={() => handleOpdReferenceSphereOptionChange('opdDisplayMode', 'pistonDefocusRemoved')} />{' '}
              Remove piston / defocus
            </label>
            <label style={{ display: 'block' }}>
              <input type="radio" name="opd-display-mode" value="pistonTiltDefocusRemoved" checked={opdReferenceSphereOptions.opdDisplayMode === 'pistonTiltDefocusRemoved'} onChange={() => handleOpdReferenceSphereOptionChange('opdDisplayMode', 'pistonTiltDefocusRemoved')} />{' '}
              Remove piston / tilt / defocus
            </label>
          </div>
          <label>Exit pupil position sign
            <select value={opdReferenceSphereOptions.exitPupilPositionSign} onChange={e => handleOpdReferenceSphereOptionChange('exitPupilPositionSign', e.target.value)}>
              <option value="as-is">As configured</option><option value="negated">Negated</option>
            </select>
          </label>
          <label>Exit pupil plane
            <select value={opdReferenceSphereOptions.exitPupilPlaneDefinition} onChange={e => handleOpdReferenceSphereOptionChange('exitPupilPlaneDefinition', e.target.value)}>
              <option value="surface-local-axis">Surface local axis</option><option value="global-z">Global Z plane</option>
            </select>
          </label>
          <div>
            <div style={{ marginBottom: 4 }}>Image point reference</div>
            <label style={{ display: 'block', marginBottom: 4 }}>
              <input type="radio" name="opd-image-point-reference" value="chief-ray-image-point" checked={opdReferenceSphereOptions.chiefImagePoint === 'chief-ray-image-point'} onChange={() => handleOpdReferenceSphereOptionChange('chiefImagePoint', 'chief-ray-image-point')} />{' '}
              Chief-ray image point
            </label>
            <label style={{ display: 'block', marginBottom: 4 }}>
              <input type="radio" name="opd-image-point-reference" value="paraxial-image-point" checked={opdReferenceSphereOptions.chiefImagePoint === 'paraxial-image-point'} onChange={() => handleOpdReferenceSphereOptionChange('chiefImagePoint', 'paraxial-image-point')} />{' '}
              Paraxial image point
            </label>
            <label style={{ display: 'block' }}>
              <input type="radio" name="opd-image-point-reference" value="sagittal-best-focus-point" checked={opdReferenceSphereOptions.chiefImagePoint === 'sagittal-best-focus-point'} onChange={() => handleOpdReferenceSphereOptionChange('chiefImagePoint', 'sagittal-best-focus-point')} />{' '}
              Sagittal best-focus point
            </label>
            <label style={{ display: 'block', marginTop: 4 }}>
              <input type="radio" name="opd-image-point-reference" value="tangential-best-focus-point" checked={opdReferenceSphereOptions.chiefImagePoint === 'tangential-best-focus-point'} onChange={() => handleOpdReferenceSphereOptionChange('chiefImagePoint', 'tangential-best-focus-point')} />{' '}
              Tangential best-focus point
            </label>
            <label style={{ display: 'block', marginTop: 4 }}>
              <input type="radio" name="opd-image-point-reference" value="tan-sag-mid-focus-point" checked={opdReferenceSphereOptions.chiefImagePoint === 'tan-sag-mid-focus-point'} onChange={() => handleOpdReferenceSphereOptionChange('chiefImagePoint', 'tan-sag-mid-focus-point')} />{' '}
              Tan/Sag mid-focus point
            </label>
            <label style={{ display: 'block', marginTop: 4 }}>
              <input type="radio" name="opd-image-point-reference" value="rms-wavefront-best-focus-point" checked={opdReferenceSphereOptions.chiefImagePoint === 'rms-wavefront-best-focus-point'} onChange={() => handleOpdReferenceSphereOptionChange('chiefImagePoint', 'rms-wavefront-best-focus-point')} />{' '}
              Minimum RMS wavefront focus
            </label>
            <label style={{ display: 'block', marginTop: 4 }}>
              <input type="radio" name="opd-image-point-reference" value="circle-of-least-confusion-point" checked={opdReferenceSphereOptions.chiefImagePoint === 'circle-of-least-confusion-point'} onChange={() => handleOpdReferenceSphereOptionChange('chiefImagePoint', 'circle-of-least-confusion-point')} />{' '}
              Circle of least confusion
            </label>
            <label style={{ display: 'block', marginTop: 4 }}>
              <input type="radio" name="opd-image-point-reference" value="defocus-zero-reference-point" checked={opdReferenceSphereOptions.chiefImagePoint === 'defocus-zero-reference-point'} onChange={() => handleOpdReferenceSphereOptionChange('chiefImagePoint', 'defocus-zero-reference-point')} />{' '}
              Defocus-zero reference point
            </label>
            <label style={{ display: 'block', marginTop: 4 }}>
              <input type="radio" name="opd-image-point-reference" value="weighted-tan-sag-focus-point" checked={opdReferenceSphereOptions.chiefImagePoint === 'weighted-tan-sag-focus-point'} onChange={() => handleOpdReferenceSphereOptionChange('chiefImagePoint', 'weighted-tan-sag-focus-point')} />{' '}
              Weighted Tan/Sag focus
            </label>
            <label style={{ display: 'block', marginTop: 4 }}>
              <input type="radio" name="opd-image-point-reference" value="per-wavelength-best-focus-point" checked={opdReferenceSphereOptions.chiefImagePoint === 'per-wavelength-best-focus-point'} onChange={() => handleOpdReferenceSphereOptionChange('chiefImagePoint', 'per-wavelength-best-focus-point')} />{' '}
              Per-wavelength best focus
            </label>
          </div>
          <label>Sphere intersection
            <select value={opdReferenceSphereOptions.sphereIntersection} onChange={e => handleOpdReferenceSphereOptionChange('sphereIntersection', e.target.value)}>
              <option value="exit-pupil-side">Exit-pupil side</option><option value="opposite-side">Opposite side</option>
            </select>
          </label>
          <label>Optical path sign
            <select value={opdReferenceSphereOptions.opticalPathSign} onChange={e => handleOpdReferenceSphereOptionChange('opticalPathSign', e.target.value)}>
              <option value="positive">Positive</option><option value="negative">Negative</option>
            </select>
          </label>
          <label>Exit pupil direction
            <select value={opdReferenceSphereOptions.exitPupilDirection} onChange={e => handleOpdReferenceSphereOptionChange('exitPupilDirection', e.target.value)}>
              <option value="image-to-exit-pupil">Image to exit pupil</option><option value="exit-pupil-to-image">Exit pupil to image</option>
            </select>
          </label>
          </div>
        </details>
      </div>
    </div>
  );
}

export default function App() {
  const optimizeRowsSyncKey = 'coopt.optimizeRowsSync';
  useEffect(() => {
    return installNonSequentialRenderOverlay();
  }, []);

  const [renderWindowStatus, setRenderWindowStatus] = useState("Initializing...");
  const portRoutedRenderActiveRef = useRef(false);
  useEffect(() => {
    const handlePortRoutedStatus = (event: Event) => {
      const detail = (event as CustomEvent<PortRoutedRenderStatusDetail>).detail;
      const previouslyOwnedRays = portRoutedRenderActiveRef.current;
      // Keep the legacy rays available while a Port-routed trace is still
      // running, failed, or returned no drawable rays.  The routed overlay
      // takes ownership only after it has a completed, non-empty result.
      portRoutedRenderActiveRef.current = detail?.active === true
        && detail.state === 'ready'
        && Number(detail.rayCount) > 0;
      if (previouslyOwnedRays && !portRoutedRenderActiveRef.current) {
        // A stale routed result may already have caused the base rays to be
        // omitted. Regenerate them when the next trace cannot own the view.
        window.setTimeout(() => {
          try { void (window as any).__cooptRenderWindowRedraw?.(); } catch (_) {}
        }, 0);
      }
      if (!detail?.active) return;
      if (detail.state === 'tracing') {
        setRenderWindowStatus(`Tracing optical routes (${detail.routeCount} ${detail.routeCount === 1 ? 'route' : 'routes'})...`);
        return;
      }
      if (detail.state === 'error') {
        setRenderWindowStatus('Optical route trace failed');
        return;
      }
      if (detail.state === 'ready') {
        setRenderWindowStatus(
          `Ready (${detail.rayCount} routed rays · ${detail.routeCount} ${detail.routeCount === 1 ? 'route' : 'routes'})`,
        );
      }
    };
    window.addEventListener(PORT_ROUTED_RENDER_STATUS_EVENT, handlePortRoutedStatus);
    return () => window.removeEventListener(PORT_ROUTED_RENDER_STATUS_EVENT, handlePortRoutedStatus);
  }, []);
  const [renderViewAxis, setRenderViewAxis] = useState<'YZ' | 'XZ'>('YZ');
  const [renderViewMode, setRenderViewMode] = useState<'3D' | 'XZ' | 'YZ'>('3D');
  const [renderExportFormat, setRenderExportFormat] = useState<'fcstd' | 'solid-stl' | 'surface-stl'>(() => (
    isTauriRuntime() ? 'fcstd' : 'solid-stl'
  ));
  const [renderShowSolids, setRenderShowSolids] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RENDER_SHOW_SOLIDS_KEY) === 'true'
        || localStorage.getItem(RENDER_SHOW_SECTION_CUT_KEY) === 'true';
    } catch (_) {
      return false;
    }
  });
  const [renderShowSectionCut, setRenderShowSectionCut] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RENDER_SHOW_SECTION_CUT_KEY) === 'true';
    } catch (_) {
      return false;
    }
  });
  const [renderShowPortConnections, setRenderShowPortConnections] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RENDER_CONNECTIONS_STORAGE_KEY) !== 'false';
    } catch (_) {
      return true;
    }
  });
  const [renderSectionAngle, setRenderSectionAngle] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem(RENDER_SECTION_ANGLE_KEY));
      return Number.isFinite(stored) ? ((stored % 360) + 360) % 360 : 90;
    } catch (_) {
      return 90;
    }
  });
  const [renderCompareScope, setRenderCompareScope] = useState<RenderCompareScope>('active');
  const [renderCompareOffsetDirection, setRenderCompareOffsetDirection] = useState<RenderCompareOffsetDirection>('centered');
  const [renderCompareOffsetStepMm, setRenderCompareOffsetStepMm] = useState(20);
  const [renderCompareAlignReference, setRenderCompareAlignReference] = useState<RenderCompareAlignReference>('object');
  const [renderRayCount, setRenderRayCount] = useState(6);
  const [renderOptionsOpen, setRenderOptionsOpen] = useState(false);
  const [renderSurfaceColorsCollapsed, setRenderSurfaceColorsCollapsed] = useState(true);
  const [renderLensColorTargets, setRenderLensColorTargets] = useState<RenderLensColorTarget[]>([]);
  const [renderColorUiRevision, setRenderColorUiRevision] = useState(0);
  const [renderScaleLabel, setRenderScaleLabel] = useState('Scale unavailable');
  const [renderScaleBarWidthPx, setRenderScaleBarWidthPx] = useState(RENDER_SCALE_BAR_TARGET_WIDTH_PX);
  const [renderZoomUiRevision, setRenderZoomUiRevision] = useState(0);
  const [workspaceFocus, setWorkspaceFocus] = useState<WorkspaceFocus>('configuration');
  const mdiDesktopRef = useRef<HTMLDivElement>(null);
  const mdiDragRef = useRef<{
    key: string;
    pointerId: number;
    startMouseX: number;
    startMouseY: number;
    startWinX: number;
    startWinY: number;
    lastX: number;
    lastY: number;
    el: HTMLElement;
  } | null>(null);
  const mdiResizeRef = useRef<{
    key: string;
    pointerId: number;
    startMouseX: number;
    startMouseY: number;
    startWidth: number;
    startHeight: number;
    el: HTMLElement;
  } | null>(null);
  const [mdiWindowStates, setMdiWindowStates] = useState<Record<WorkspaceFocus, {
    open: boolean;
    minimized: boolean;
    maximized: boolean;
    restoreBounds?: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
  }>>({
    configuration: { open: true,  minimized: false, maximized: false, restoreBounds: null, x: 12,  y: 12,  width: 940, height: 620, zIndex: 6 },
    source:        { open: false, minimized: false, maximized: false, restoreBounds: null, x: 36,  y: 36,  width: 920, height: 580, zIndex: 5 },
    field:         { open: false, minimized: false, maximized: false, restoreBounds: null, x: 48,  y: 48,  width: 920, height: 580, zIndex: 4 },
    intent:        { open: false, minimized: false, maximized: false, restoreBounds: null, x: 60,  y: 60,  width: 980, height: 640, zIndex: 3 },
    requirements:  { open: false, minimized: false, maximized: false, restoreBounds: null, x: 84,  y: 84,  width: 860, height: 560, zIndex: 2 },
    literature:    { open: false, minimized: false, maximized: false, restoreBounds: null, x: 108, y: 108, width: 840, height: 540, zIndex: 1 },
  });
  const [mdiAuxWindows, setMdiAuxWindows] = useState<Record<string, MdiAuxWindowState>>(() => ({
    [SYSTEM_TEXT_WINDOW_ID]: {
      id: SYSTEM_TEXT_WINDOW_ID,
      title: SYSTEM_TEXT_WINDOW_TITLE,
      url: '',
      open: true,
      minimized: false,
      maximized: false,
      restoreBounds: null,
      x: 160,
      y: 110,
      width: 760,
      height: 360,
      zIndex: 7,
    },
  }));
  const [systemTextLines, setSystemTextLines] = useState<string[]>([]);
  const [systemTextCommand, setSystemTextCommand] = useState('');
  const [systemTextHistory, setSystemTextHistory] = useState<string[]>([]);
  const systemTextLogRef = useRef<HTMLDivElement | null>(null);
  const lastOptimizeLogSignatureRef = useRef('');
  const optimizeConsoleHeaderWrittenRef = useRef(false);
  const optimizeConsolePrevMinRef = useRef<number>(Number.NaN);
  const optimizeConsoleLastIterRef = useRef<number>(-1);
  const optimizeConsoleStartedAtRef = useRef<number>(0);
  const [treeOpenGroups, setTreeOpenGroups] = useState<Set<string>>(() => {
    const defaults = new Set(['panels', 'analysis', 'analysis-image-quality', 'analysis-simulation']);
    try {
      const stored = JSON.parse(localStorage.getItem(NAVIGATOR_TREE_GROUPS_KEY) || 'null');
      return Array.isArray(stored) ? new Set(stored.map(String)) : defaults;
    } catch (_) {
      return defaults;
    }
  });
  const [navigatorCollapsed, setNavigatorCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(NAVIGATOR_COLLAPSED_KEY);
      return stored === null ? true : stored === 'true';
    } catch (_) {
      return true;
    }
  });
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
  const renderLabelVisibilityRef = useRef({
    designIntent: renderShowDesignIntentLabels,
    principalPoints: renderShowPrincipalPointLabels,
    surfaceNumbers: renderShowSurfaceNumberLabels,
  });
  renderLabelVisibilityRef.current = {
    designIntent: renderShowDesignIntentLabels,
    principalPoints: renderShowPrincipalPointLabels,
    surfaceNumbers: renderShowSurfaceNumberLabels,
  };
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
  const [astigPointCount, setAstigPointCount] = useState(21);
  const [astigRayCount, setAstigRayCount] = useState(101);
  const [astigRingCount, setAstigRingCount] = useState(256);
  const [astigFocusRange, setAstigFocusRange] = useState(0.4);
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
  const [optMethod, setOptMethod] = useState<'kkt-sqp' | 'kkt' | 'lm' | 'cd' | 'global-al' | 'global-lm'>('kkt-sqp');
  const [optMaxIterations, setOptMaxIterations] = useState(20);
  const [optMaxEscapeLoops, setOptMaxEscapeLoops] = useState(1);
  const [optEscapeFunctionWidth, setOptEscapeFunctionWidth] = useState(1);
  const [optEscapeFunctionHeight, setOptEscapeFunctionHeight] = useState(0.1);
  const [optAutoRenderOnAccept, setOptAutoRenderOnAccept] = useState(true);
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
    bestRequirementScore: NaN,
    acceptCount: 0,
    rejectCount: 0,
    escapeLoop: null,
    escapeLoops: null,
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

  const shouldPreferImportedOpticalRowsInConfig = (cfg: any): boolean => {
    try {
      if (!cfg || typeof cfg !== 'object') return false;
      if (!Array.isArray(cfg.opticalSystem) || cfg.opticalSystem.length === 0) return false;
      const metadata = cfg.metadata && typeof cfg.metadata === 'object' ? cfg.metadata : null;
      return !!(metadata?.importRowsPreferred || metadata?.importAnalyzeMode);
    } catch (_) {
      return false;
    }
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
    if (shouldPreferImportedOpticalRowsInConfig(cfg)) {
      return Array.isArray(cfg.opticalSystem) ? cfg.opticalSystem : [];
    }
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

  const filterEnabledObjectRowsForRender = (rows: any[]): any[] => {
    if (!Array.isArray(rows)) return [];
    return rows.filter((row: any) => row && row.enabled !== false);
  };

  const getConfigObjectRowsForRender = (targetWindow: any, cfg: any, systemConfig?: any): any[] => {
    if (!cfg || typeof cfg !== 'object') return [];
    try {
      const activeId = systemConfig?.activeConfigId;
      const isActive = activeId !== undefined && activeId !== null && String(cfg.id) === String(activeId);
      if (isActive && typeof targetWindow?.getObjectRows === 'function') {
        const tableRows = targetWindow.getObjectRows(targetWindow.tableObject);
        if (Array.isArray(tableRows)) {
          return filterEnabledObjectRowsForRender(tableRows);
        }
      }
    } catch (_) {}

    return filterEnabledObjectRowsForRender(Array.isArray(cfg.object) ? cfg.object : []);
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
      const parentWindow = (window as any).parent;
      if (parentWindow && parentWindow !== window && !parentWindow.closed) return parentWindow;
    } catch (_) {}
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
      const parentWindow = currentWindow.parent;
      if (parentWindow && parentWindow !== currentWindow && !parentWindow.closed) {
        try {
          currentWindow.__cooptOptimizeHostWindow = parentWindow;
        } catch (_) {}
        return parentWindow;
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

  const appendSystemTextLine = (lineRaw: any) => {
    const line = String(lineRaw ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!line) return;
    setSystemTextLines((prev) => {
      const next = [...prev, ...line.split('\n')];
      if (next.length > 3000) {
        return next.slice(next.length - 3000);
      }
      return next;
    });
  };

  const appendOptimizeConsoleLine = (line: string) => {
    try {
      const hostWindow = getRenderHostWindow() as any;
      if (hostWindow && hostWindow !== window && typeof hostWindow.__cooptTextWindowWrite === 'function') {
        hostWindow.__cooptTextWindowWrite(line);
        return;
      }
    } catch (_) {}
    appendSystemTextLine(line);
  };

  const appendOptimizeConsoleHeader = () => {
    appendOptimizeConsoleLine(formatOptimizeConsoleHeader());
  };

  const appendOptimizeConsoleRow = (row: {
    iter: number;
    elapsedMs: number;
    min: number;
    damping: number;
    rho: number;
    alpha: number;
    improv: number;
  }) => {
    appendOptimizeConsoleLine(formatOptimizeConsoleRow(row));
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
    let objectRowsResolved = false;

    const finalizeObjectRows = (rows: any[]): any[] => {
      if (!Array.isArray(rows)) return [];
      const enabledRows = filterEnabledObjectRowsForRender(rows);
      if (preferConfigRows) {
        return normalizeRenderObjectRows(hostWindow, enabledRows, opticalSystemRowsOverride);
      }
      return enabledRows;
    };

    if (preferConfigRows) {
      try {
        const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        const overrideRows = g && Array.isArray(g.__cooptRenderObjectRowsOverride)
          ? g.__cooptRenderObjectRowsOverride
          : null;
        if (overrideRows) {
          objectRows = overrideRows;
          objectRowsResolved = true;
        }
      } catch (_) {}

      try {
        if (!objectRowsResolved) {
          const systemConfig = getSystemConfigFromWindow(hostWindow);
          const activeCfg = getActiveConfigFromSystemConfig(systemConfig);
          if (Array.isArray(activeCfg?.object)) {
            objectRows = activeCfg.object;
            objectRowsResolved = true;
          }
        }
      } catch (_) {}
    }

    try {
      if (!objectRowsResolved) {
        const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        const overrideRows = g && Array.isArray(g.__cooptRenderObjectRowsOverride)
          ? g.__cooptRenderObjectRowsOverride
          : null;
        if (overrideRows) {
          objectRows = overrideRows;
          objectRowsResolved = true;
        }
      }
    } catch (_) {}

    try {
      if (!objectRowsResolved && hostWindow?.tableObject && typeof hostWindow?.getObjectRows === 'function') {
        const rows = hostWindow.getObjectRows(hostWindow.tableObject);
        if (Array.isArray(rows)) {
          objectRows = rows;
          objectRowsResolved = true;
        }
      }
    } catch (_) {}

    try {
      if (!objectRowsResolved) {
        const systemConfig = getSystemConfigFromWindow(hostWindow);
        const activeCfg = getActiveConfigFromSystemConfig(systemConfig);
        if (Array.isArray(activeCfg?.object)) {
          objectRows = activeCfg.object;
          objectRowsResolved = true;
        }
      }
    } catch (_) {}
    try {
      if (!objectRowsResolved && (window as any).tableObject && typeof window?.getObjectRows === 'function') {
        const rows = window.getObjectRows((window as any).tableObject);
        if (Array.isArray(rows)) {
          objectRows = rows;
          objectRowsResolved = true;
        }
      }
    } catch (_) {}
    return finalizeObjectRows(objectRows);
  };

  const getRenderSourceRows = (targetWindow?: any): any[] => {
    const hostWindow = targetWindow || getRenderHostWindow();
    let sourceRows: any[] = [];

    try {
      const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
      const overrideRows = g && Array.isArray(g.__cooptRenderSourceRowsOverride) && g.__cooptRenderSourceRowsOverride.length > 0
        ? g.__cooptRenderSourceRowsOverride
        : null;
      if (overrideRows) sourceRows = overrideRows;
    } catch (_) {}

    try {
      if (sourceRows.length === 0 && typeof hostWindow?.getSourceRows === 'function') {
        const rows = hostWindow.getSourceRows(hostWindow.tableSource);
        if (Array.isArray(rows) && rows.length > 0) sourceRows = rows;
      }
    } catch (_) {}

    try {
      if (sourceRows.length === 0) {
        const systemConfig = getSystemConfigFromWindow(hostWindow);
        const activeCfg = getActiveConfigFromSystemConfig(systemConfig);
        if (Array.isArray(activeCfg?.source) && activeCfg.source.length > 0) sourceRows = activeCfg.source;
      }
    } catch (_) {}

    try {
      if (sourceRows.length === 0 && typeof window?.getSourceRows === 'function') {
        const rows = window.getSourceRows((window as any).tableSource);
        if (Array.isArray(rows) && rows.length > 0) sourceRows = rows;
      }
    } catch (_) {}

    return Array.isArray(sourceRows) ? sourceRows : [];
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
      type === 'renderSolidGroup' ||
      type === 'renderSolid' ||
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
            bestRequirementScore: optimizeStatus === 'idle'
              ? (Number.isFinite(tableScore) ? tableScore : (Number.isFinite(safeScore) ? safeScore : prev.bestRequirementScore))
              : prev.bestRequirementScore,
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
    const getRecentBestRequirementSnapshotScore = (): number => {
      try {
        const state = hostWin?.__cooptOptimizeBestRequirementSnapshotApplied || w.__cooptOptimizeBestRequirementSnapshotApplied;
        const at = Number(state?.at ?? 0);
        const score = Number(state?.score);
        if (Number.isFinite(at) && at > 0 && (Date.now() - at) < 10000 && Number.isFinite(score)) return score;
      } catch (_) {}
      return Number.NaN;
    };
    const scheduleHostScoreRefresh = (reason: string, triggerEval = true, delayMs = 120) => {
      if (cancelled || optRunning) return;
      const lockedBestScore = getRecentBestRequirementSnapshotScore();
      if (Number.isFinite(lockedBestScore)) {
        setOptimizeState((prev: any) => ({
          ...prev,
          requirementScoreAfter: lockedBestScore,
          requirementScoreTable: lockedBestScore,
          meritAfter: lockedBestScore,
          best: lockedBestScore,
          bestRequirementScore: lockedBestScore,
        }));
        return;
      }
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
          bestRequirementScore: optimizeStatus === 'idle'
            ? (Number.isFinite(score) ? score : prev.bestRequirementScore)
            : prev.bestRequirementScore,
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
      if (value === undefined) return;
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

      // Do not force-disable other glass-family optimize flags during row-back sync.
      // Forced exclusivity here made Abbe/Vd checkboxes appear to "fall off" after UI refresh.
      return;
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
        if (Object.prototype.hasOwnProperty.call(currentParams, key) && /^(?:material|rindex|abbe|vd|nd)\d*$/i.test(String(key ?? '').trim())) {
          mergedEntry.value = currentParams[key];
        } else if (!Object.prototype.hasOwnProperty.call(mergedEntry, 'value') && Object.prototype.hasOwnProperty.call(currentParams, key)) {
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

    const pickRowValue = (row: any, keys: string[]): any => {
      if (!row || typeof row !== 'object') return undefined;
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
        const value = row[key];
        if (value !== undefined) return value;
      }
      return undefined;
    };

    const updateBlockByRole = (block: any, role: string, row: any) => {
      const blockType = String(block?.blockType ?? '');
      const r = String(role || '').trim();
      const radius = pickRowValue(row, ['radius', 'radius of curvature', 'Radius', 'R']);
      const thickness = pickRowValue(row, ['thickness', 'distance', 'Thickness']);
      const material = pickRowValue(row, ['material', 'glass', 'Material']);
      const conic = pickRowValue(row, ['conic', 'Conic']);
      const surfType = String(pickRowValue(row, ['surfType', 'surfaceType', 'surf type']) ?? '').trim();

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

        if (shouldPreferImportedOpticalRowsInConfig(active) || !Array.isArray(active.blocks) || active.blocks.length === 0) {
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
          if (String(block?.blockType ?? '').trim() === 'Stop') {
            block.variables = {};
            continue;
          }
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

    const getDiagRowsFingerprint = (rowsInput: any[]): any => {
      const rows = Array.isArray(rowsInput) ? rowsInput : [];
      const firstLens = rows.find((row: any) => {
        const type = String(row?.['object type'] ?? row?.object ?? row?.type ?? '').trim().toLowerCase();
        return type !== 'object' && type !== 'image';
      }) || rows[1] || rows[0] || null;
      return {
        rowCount: rows.length,
        firstId: firstLens?.id ?? firstLens?._id ?? null,
        firstBlockId: firstLens?._blockId ?? null,
        firstRole: firstLens?._surfaceRole ?? null,
        firstRadius: firstLens?.['radius of curvature'] ?? firstLens?.radius ?? firstLens?.R ?? null,
        firstThickness: firstLens?.thickness ?? firstLens?.distance ?? null,
        firstMaterial: firstLens?.material ?? firstLens?.glass ?? null,
      };
    };

    const getDiagConfigFingerprint = (cfg: any): any => {
      const activeId = String(cfg?.activeConfigId ?? '').trim();
      const active = Array.isArray(cfg?.configurations)
        ? (cfg.configurations.find((c: any) => String(c?.id ?? '') === activeId) || cfg.configurations[0])
        : null;
      const rows = Array.isArray(active?.opticalSystem)
        ? active.opticalSystem
        : (Array.isArray(active?.opticalSystemRows) ? active.opticalSystemRows : []);
      const firstBlock = Array.isArray(active?.blocks) ? active.blocks[0] : null;
      return {
        activeId,
        configCount: Array.isArray(cfg?.configurations) ? cfg.configurations.length : null,
        optical: getDiagRowsFingerprint(rows),
        firstBlockId: firstBlock?.blockId ?? null,
        firstBlockType: firstBlock?.type ?? firstBlock?.blockType ?? null,
        firstBlockParams: firstBlock?.parameters ? {
          radius: firstBlock.parameters.radius ?? firstBlock.parameters.frontRadius ?? null,
          backRadius: firstBlock.parameters.backRadius ?? null,
          thickness: firstBlock.parameters.thickness ?? null,
          material: firstBlock.parameters.material ?? null,
        } : null,
      };
    };

    const getDiagRequirementScore = (target: any): number => {
      try {
        const sre = target?.systemRequirementsEditor || (window as any).systemRequirementsEditor;
        const data = sre && typeof sre.getData === 'function' ? sre.getData() : [];
        if (!Array.isArray(data)) return Number.NaN;
        let sum = 0;
        let count = 0;
        for (const row of data) {
          const enabled = (row?.enabled === undefined || row?.enabled === null) ? true : !!row.enabled;
          const operand = String(row?.operand ?? '').trim();
          const weight = Number(row?.weight ?? 1);
          if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) continue;
          const contribution = Number.isFinite(Number(row?._contribution)) ? Number(row._contribution) : Number(row?.score);
          if (!Number.isFinite(contribution)) continue;
          if (contribution > 0) sum += contribution;
          count += 1;
        }
        return count > 0 ? sum : Number.NaN;
      } catch (_) {
        return Number.NaN;
      }
    };

    const logOptimizeSyncDiag = (label: string, extra: any = {}): void => {
      try {
        if ((window as any).__COOPT_AL_DIAG !== true) return;
        const target = getOptimizeSyncTargetWindow();
        const rows = typeof target.getOpticalSystemRows === 'function'
          ? target.getOpticalSystemRows(target.tableOpticalSystem)
          : [];
        const cfg = typeof target.loadSystemConfigurationsFromTableConfig === 'function'
          ? target.loadSystemConfigurationsFromTableConfig()
          : (typeof target.loadSystemConfigurations === 'function' ? target.loadSystemConfigurations() : null);
        console.log('🩺 [AL-DIAG][overwrite-sync]', {
          label,
          at: Date.now(),
          rows: getDiagRowsFingerprint(rows),
          config: getDiagConfigFingerprint(cfg),
          requirementScore: getDiagRequirementScore(target),
          extra,
        });
      } catch (_) {}
    };

    const applyOpticalRowsSnapshotSync = (rowsSnapshot: any[]): void => {
      const w = getOptimizeSyncTargetWindow();
      if (!Array.isArray(rowsSnapshot) || rowsSnapshot.length === 0) return;
      try {
        logOptimizeSyncDiag('applyOpticalRowsSnapshotSync:before', { incomingRows: getDiagRowsFingerprint(rowsSnapshot) });
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
        logOptimizeSyncDiag('applyOpticalRowsSnapshotSync:after', { incomingRows: getDiagRowsFingerprint(rowsSnapshot) });
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
            logOptimizeSyncDiag('undo-command:execute-afterSnapshot', {
              description,
              afterRows: getDiagRowsFingerprint(afterRowsSnapshot || []),
              afterConfig: getDiagConfigFingerprint(afterSnapshot),
            });
            applySystemConfigSnapshotSync(afterSnapshot);
            applyOpticalRowsSnapshotSync(afterRowsSnapshot);
          },
          undo: () => {
            logOptimizeSyncDiag('undo-command:undo-beforeSnapshot', {
              description,
              beforeRows: getDiagRowsFingerprint(beforeRowsSnapshot || []),
              beforeConfig: getDiagConfigFingerprint(beforeSnapshot),
            });
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
        recordUndo?: boolean;
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

        beforeSnapshot = loadSystemConfigSnapshot();
        beforeRowsSnapshot = loadOpticalRowsSnapshot();

        // Prefer canonical optimizer snapshot (blocks + active config) when available.
        // Relying only on table rows can lose block linkage metadata and later reloads
        // may fall back to pre-optimization blocks.
        if (undoSnapshots?.afterConfig && typeof undoSnapshots.afterConfig === 'object') {
          try {
            logOptimizeSyncDiag('applyOptimizedRows:before-afterConfig', {
              token: applyToken,
              incomingRows: getDiagRowsFingerprint(rows),
              afterConfig: getDiagConfigFingerprint(undoSnapshots.afterConfig),
            });
            applySystemConfigSnapshotSync(undoSnapshots.afterConfig);
            logOptimizeSyncDiag('applyOptimizedRows:after-afterConfig', { token: applyToken });
          } catch (_) {}
        }

        if (undoHistory) {
          undoHistory.isExecuting = true;
        }
        const table = w.tableOpticalSystem;
        if (table && typeof table.setData === 'function') {
          await table.setData(rows);
        }
        if (shouldSyncBlocks) {
          syncRowsBackToActiveBlocks(rows);
        }
        logOptimizeSyncDiag('applyOptimizedRows:after-table-and-blocks', {
          token: applyToken,
          incomingRows: getDiagRowsFingerprint(rows),
          recordUndo: options?.recordUndo !== false,
        });
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
        if (options?.recordUndo !== false) {
          recordOptimizationUndoFromSnapshots(
            undoSnapshots?.beforeConfig ?? beforeSnapshot,
            Array.isArray(undoSnapshots?.beforeRows) ? undoSnapshots?.beforeRows : beforeRowsSnapshot,
            undoSnapshots?.afterConfig ?? afterSnapshot,
            Array.isArray(undoSnapshots?.afterRows) ? undoSnapshots?.afterRows : afterRowsSnapshot,
            'Optimization apply'
          );
        }
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
      if (options?.syncBlocks !== false) {
        syncRowsBackToActiveBlocks(rows);
      }
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
        const activeRenderSyncLease = g?.__cooptRenderSyncLease;
        const hasActiveRenderSyncLease = !!activeRenderSyncLease && typeof activeRenderSyncLease === 'object';
        const prevRunning = hasActiveRenderSyncLease
          ? !!activeRenderSyncLease.prevRunning
          : (g ? !!g.__cooptOptimizerIsRunning : false);
        const prevRowsOverride = hasActiveRenderSyncLease
          ? activeRenderSyncLease.prevRowsOverride
          : (g ? g.__cooptOpticalSystemRowsOverride : null);
        const prevObjectOverride = hasActiveRenderSyncLease
          ? activeRenderSyncLease.prevObjectOverride
          : (g ? g.__cooptRenderObjectRowsOverride : null);
        const restoreScheduledAt = Date.now();
        const renderSyncLease = { prevRunning, prevRowsOverride, prevObjectOverride };
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
        if (g) {
          g.__cooptRenderSyncLease = renderSyncLease;
          g.__cooptOptimizerIsRunning = true;
        }
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
            if (!g || g.__cooptRenderSyncLease !== renderSyncLease) return;
            const optimizationEndedAt = Number(g.__cooptLastOptimizationSyncAt) || 0;
            g.__cooptOptimizerIsRunning = optimizationEndedAt >= restoreScheduledAt ? false : prevRunning;
            g.__cooptOpticalSystemRowsOverride = optimizationEndedAt >= restoreScheduledAt ? null : prevRowsOverride;
            g.__cooptRenderObjectRowsOverride = prevObjectOverride;
            delete g.__cooptRenderSyncLease;
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
        // Progress messages are display-only for the host. The final done/stop
        // result snapshot is the single owner of Req/Render/table/config updates.
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
        const senderId = String(payload?.senderId ?? '').trim();
        if (senderId && senderId === getOrCreateCooptWindowSyncSenderId()) return;
        const createdAt = Number(payload?.createdAt ?? 0);
        if (!Number.isFinite(createdAt) || createdAt <= 0 || (Date.now() - createdAt) > 10000) return;
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const token = String(payload?.ts ?? payload?.token ?? '');
        if (token) {
          try {
            const handledKey = `coopt.optimizeRowsSync.handled.${token}`;
            if (localStorage.getItem(handledKey)) return;
            localStorage.setItem(handledKey, String(Date.now()));
            setTimeout(() => { try { localStorage.removeItem(handledKey); } catch (_) {} }, 15000);
          } catch (_) {}
        }
        const undoSnapshots = getOptimizedResultApplySnapshots(payload);
        logOptimizeSyncDiag('storage-optimizeRowsSync:received', {
          token,
          rows: getDiagRowsFingerprint(rows),
          afterConfig: getDiagConfigFingerprint(payload?.afterConfigSnapshot),
          afterRows: getDiagRowsFingerprint(Array.isArray(payload?.afterRowsSnapshot) ? payload.afterRowsSnapshot : []),
        });
        void applyOptimizedRows(rows, token, undoSnapshots, { syncBlocks: payload?.syncBlocks === true, recordUndo: false });
        try { localStorage.removeItem(optimizeRowsSyncKey); } catch (_) {}
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
              const senderId = String(ev?.payload?.senderId ?? '').trim();
              if (senderId && senderId === getOrCreateCooptWindowSyncSenderId()) return;
              const createdAt = Number(ev?.payload?.createdAt ?? 0);
              if (!Number.isFinite(createdAt) || createdAt <= 0 || (Date.now() - createdAt) > 10000) return;
              const rows = Array.isArray(ev?.payload?.rows) ? ev.payload.rows : [];
              const token = String(ev?.payload?.ts ?? ev?.payload?.token ?? '');
              if (token) {
                try {
                  const handledKey = `coopt.optimizeRowsSync.handled.${token}`;
                  if (localStorage.getItem(handledKey)) return;
                  localStorage.setItem(handledKey, String(Date.now()));
                  setTimeout(() => { try { localStorage.removeItem(handledKey); } catch (_) {} }, 15000);
                } catch (_) {}
              }
              const undoSnapshots = getOptimizedResultApplySnapshots(ev?.payload);
              logOptimizeSyncDiag('tauri-optimizeRowsSync:received', {
                token,
                rows: getDiagRowsFingerprint(rows),
                afterConfig: getDiagConfigFingerprint(ev?.payload?.afterConfigSnapshot),
                afterRows: getDiagRowsFingerprint(Array.isArray(ev?.payload?.afterRowsSnapshot) ? ev.payload.afterRowsSnapshot : []),
              });
              void applyOptimizedRows(rows, token, undoSnapshots, { syncBlocks: ev?.payload?.syncBlocks === true, recordUndo: false });
              try { localStorage.removeItem(optimizeRowsSyncKey); } catch (_) {}
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
    w.Plotly = Plotly;
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

      const cacheKey = buildRenderLegacyCrossRayCacheKey(
        opticalSystemRows,
        normalizedObjectRows,
        axis,
        effectiveRayCount,
        primaryWavelength,
        requestedPupilSamplingMode,
        true,
      );
      const cachedRays = renderLegacyCrossRaysCache.get(cacheKey);
      if (cachedRays) {
        return attachRenderObjectColorSlots(cloneRenderLegacyCrossRays(cachedRays), normalizedObjectRows);
      }

      try {
        const classificationSummary = normalizedObjectRows.map((row: any, index: number) => ({
          index,
          objectIndex: Number.isFinite(Number(row?.objectIndex)) ? Number(row.objectIndex) : index,
          position: row?.position ?? null,
          originalPosition: row?.__cooptOriginalPosition ?? null,
          bucket: isRenderImageHeightObjectRow(row) ? 'exact-imageheight' : 'exact-cross',
        }));
        (w as any).__COOPT_LAST_RENDER_IMAGEHEIGHT_CLASSIFICATION = {
          at: new Date().toISOString(),
          axis,
          effectiveRayCount,
          isInfiniteSystem,
          directExactImageHeightCount: normalizedObjectRows.filter((row: any) => isRenderImageHeightObjectRow(row)).length,
          legacyCrossBeamCount: 0,
          rows: classificationSummary,
          objectDebug: [],
          exactImageHeightRayCount: 0,
        };
      } catch (_) {}

      // Always use exact rays for render window
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
      let allExactRays = mergedExactRays;

      // Fallback exact generation path for windows where object rows are sparse/unavailable.
      if ((!Array.isArray(allExactRays) || allExactRays.length === 0) && normalizedObjectRows.length > 0) {
        const fallbackExactRays = buildExactLowCountRenderRaysForObjects(
          normalizedObjectRows,
          opticalSystemRows,
          primaryWavelength,
          isInfiniteSystem ? 'infinite' : 'finite',
          axis,
          effectiveRayCount,
        );
        allExactRays = Array.isArray(fallbackExactRays) ? fallbackExactRays : [];
      }

      if (!Array.isArray(allExactRays) || allExactRays.length === 0) {
        recordCooptPerfSample('collectLegacyCrossRays.normalize', 0);
        recordCooptPerfSample('collectLegacyCrossRays.limit', 0);
        recordCooptPerfSample('collectLegacyCrossRays.total', performance.now() - totalStartMs);
        return [];
      }

      const normalizedAllRaysRaw = allExactRays.map((ray: any) => {
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
            objectIndex: inferredObjectIndex,
          },
        };
      });
      const stopSurfaceIndex = opticalSystemRows.findIndex((row: any) => {
        const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
        return String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '') === 'stop';
      });
      const getStopPoint = (ray: any) => stopSurfaceIndex >= 0
        ? getRenderTargetPointFromRayPath(ray?.rayPath, opticalSystemRows, stopSurfaceIndex)
        : null;
      const onAxisRays = normalizedAllRaysRaw.filter((ray: any) => Number(ray?.objectIndex) === 0);
      const onAxisStopPoints = onAxisRays.map(getStopPoint).filter((point: any) => (
        point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
      ));
      const onAxisStopLimits = onAxisStopPoints.length > 0
        ? {
            minX: Math.min(...onAxisStopPoints.map((point: any) => Number(point.x))),
            maxX: Math.max(...onAxisStopPoints.map((point: any) => Number(point.x))),
            minY: Math.min(...onAxisStopPoints.map((point: any) => Number(point.y))),
            maxY: Math.max(...onAxisStopPoints.map((point: any) => Number(point.y))),
          }
        : null;
      const chiefByObject = new Map<number, any>();
      normalizedAllRaysRaw.forEach((ray: any) => {
        const type = String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase();
        if (type === 'chief') chiefByObject.set(Number(ray.objectIndex), ray);
      });
      const normalizedAllRays = normalizedAllRaysRaw.map((ray: any) => {
        const objectIndex = Number(ray?.objectIndex);
        if (!onAxisStopLimits || objectIndex === 0) return ray;
        const stopPoint = getStopPoint(ray);
        const chief = chiefByObject.get(objectIndex);
        const chiefStopPoint = getStopPoint(chief);
        if (!stopPoint || !chiefStopPoint) return ray;
        let fraction = 1;
        (['x', 'y'] as const).forEach((coordinateAxis) => {
          const coordinate = Number(stopPoint[coordinateAxis]);
          const chiefCoordinate = Number(chiefStopPoint[coordinateAxis]);
          const minLimit = coordinateAxis === 'x' ? onAxisStopLimits.minX : onAxisStopLimits.minY;
          const maxLimit = coordinateAxis === 'x' ? onAxisStopLimits.maxX : onAxisStopLimits.maxY;
          const limitedCoordinate = Math.max(minLimit, Math.min(maxLimit, coordinate));
          const span = coordinate - chiefCoordinate;
          if (Number.isFinite(coordinate) && Number.isFinite(chiefCoordinate) && Math.abs(span) > 1e-12) {
            fraction = Math.min(fraction, Math.max(0, Math.min(1, (limitedCoordinate - chiefCoordinate) / span)));
          }
        });
        if (fraction >= 1 - 1e-9) return ray;
        const chiefPath = Array.isArray(chief?.rayPath) ? chief.rayPath : [];
        const rayPath = Array.isArray(ray?.rayPath) ? ray.rayPath : [];
        const pointCount = Math.min(chiefPath.length, rayPath.length);
        if (pointCount < 2) return ray;
        const constrainedPath = Array.from({ length: pointCount }, (_, pointIndex) => ({
          ...rayPath[pointIndex],
          x: Number(chiefPath[pointIndex].x) + (Number(rayPath[pointIndex].x) - Number(chiefPath[pointIndex].x)) * fraction,
          y: Number(chiefPath[pointIndex].y) + (Number(rayPath[pointIndex].y) - Number(chiefPath[pointIndex].y)) * fraction,
          z: Number(chiefPath[pointIndex].z) + (Number(rayPath[pointIndex].z) - Number(chiefPath[pointIndex].z)) * fraction,
        }));
        return {
          ...ray,
          rayPath: constrainedPath,
          __cooptStopXCoord: Number(chiefStopPoint.x) + (Number(stopPoint.x) - Number(chiefStopPoint.x)) * fraction,
          __cooptStopYCoord: Number(chiefStopPoint.y) + (Number(stopPoint.y) - Number(chiefStopPoint.y)) * fraction,
          originalRay: {
            ...(ray.originalRay || {}),
            __cooptStopXCoord: Number(chiefStopPoint.x) + (Number(stopPoint.x) - Number(chiefStopPoint.x)) * fraction,
            __cooptStopYCoord: Number(chiefStopPoint.y) + (Number(stopPoint.y) - Number(chiefStopPoint.y)) * fraction,
          },
        };
      });
      recordCooptPerfSample('collectLegacyCrossRays.normalize', 0);

      const normalizedAxisCount = effectiveRayCount > 1 && effectiveRayCount % 2 === 0
        ? effectiveRayCount + 1
        : effectiveRayCount;
      const desiredCount = axis === 'BOTH'
        ? Math.max(1, 2 * normalizedAxisCount - 1)
        : normalizedAxisCount;
      const exactImageHeightRaysOnly = normalizedAllRays.filter((ray: any) => ray?.__cooptImageHeightExactRender === true);
      const nonExactCandidateRays = normalizedAllRays.filter((ray: any) => ray?.__cooptImageHeightExactRender !== true);
      const limitCandidateRays = nonExactCandidateRays;
      const grouped = new Map<number, any[]>();
      limitCandidateRays.forEach((ray: any) => {
        const objectIndex = Number.isFinite(Number(ray?.objectIndex)) ? Number(ray.objectIndex) : 0;
        if (!grouped.has(objectIndex)) grouped.set(objectIndex, []);
        grouped.get(objectIndex)!.push(ray);
      });

      const limitedRays: any[] = [...exactImageHeightRaysOnly];
      const perObjectCount: Record<number, number> = {};
      exactImageHeightRaysOnly.forEach((ray: any) => {
        const objectIndex = Number.isFinite(Number(ray?.objectIndex)) ? Number(ray.objectIndex) : 0;
        perObjectCount[objectIndex] = (Number(perObjectCount[objectIndex]) || 0) + 1;
      });

      grouped.forEach((rays, objectIndex) => {
        const alreadyKept = Number(perObjectCount[objectIndex]) || 0;
        const remainingSlots = Math.max(0, desiredCount - alreadyKept);
        const pinnedCandidates = Array.isArray(rays)
          ? rays.filter((ray: any) => ray?.__cooptPinnedLowCount === true || ray?.originalRay?.__cooptPinnedLowCount === true)
          : [];
        const selected = remainingSlots > 0
          ? (() => {
              if (pinnedCandidates.length <= 0) {
                return selectCrossRaysForAxis(rays, remainingSlots, axis);
              }
              const orderedAll = Array.isArray(rays) ? [...rays].sort(compareCrossRayDrawOrder) : [];
              const chief = orderedAll.find((ray: any) => String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase() === 'chief') || null;
              const pool = [...pinnedCandidates].sort(compareCrossRayDrawOrder);
              const picked: any[] = [];
              if (chief) picked.push(chief);
              for (const candidate of pool) {
                if (picked.length >= remainingSlots) break;
                if (picked.includes(candidate)) continue;
                picked.push(candidate);
              }
              if (picked.length < remainingSlots) {
                for (const candidate of orderedAll) {
                  if (picked.length >= remainingSlots) break;
                  if (picked.includes(candidate)) continue;
                  picked.push(candidate);
                }
              }
              return picked.slice(0, remainingSlots);
            })()
          : [];
        perObjectCount[objectIndex] = alreadyKept + selected.length;
        limitedRays.push(...selected);
      });

      const finalRays = exactImageHeightRows.length > 0
        ? limitedRays
        : replaceImageHeightChiefRaysWithExactRenderTrace(
            limitedRays,
            normalizedObjectRows,
            opticalSystemRows,
            primaryWavelength,
            isInfiniteSystem,
          );
      const colorizedFinalRays = attachRenderObjectColorSlots(finalRays, normalizedObjectRows);
      recordCooptPerfSample('collectLegacyCrossRays.limit', 0);
      recordCooptPerfSample('collectLegacyCrossRays.total', performance.now() - totalStartMs);

      try {
        const lastClassification = (w as any).__COOPT_LAST_RENDER_IMAGEHEIGHT_CLASSIFICATION;
        if (lastClassification && typeof lastClassification === 'object') {
          lastClassification.exactImageHeightRayCount = Array.isArray(colorizedFinalRays) ? colorizedFinalRays.length : 0;
          lastClassification.objectDebug = Array.isArray((exactImageHeightRays as any)?.__cooptExactRenderDebug)
            ? (exactImageHeightRays as any).__cooptExactRenderDebug
            : [];
        }
      } catch (_) {}

      renderLegacyCrossRaysCache.set(cacheKey, cloneRenderLegacyCrossRays(colorizedFinalRays));
      clampRenderCacheSize(renderLegacyCrossRaysCache, RENDER_LEGACY_CROSS_RAYS_CACHE_LIMIT);
      return colorizedFinalRays;
    } catch (error) {
      recordCooptPerfSample('collectLegacyCrossRays.total', performance.now() - totalStartMs);
      console.warn('[RenderWindow] Exact ray generation failed:', error);
      return [];
    }
  };

  const calculateRenderChiefAngleDegForRequirement = async (request: any): Promise<any> => {
    try {
      const opticalSystemRows = Array.isArray(request?.opticalSystemRows) ? request.opticalSystemRows : [];
      const objectRows = Array.isArray(request?.objectRows) ? request.objectRows : [];
      const objectIndex0 = Math.max(0, Math.floor(Number(request?.objectIndex0) || 0));
      if (opticalSystemRows.length === 0 || objectRows.length === 0) {
        return { ok: false, reason: 'missing-rows' };
      }

      const inferAxis = (): 'YZ' | 'XZ' | 'BOTH' => {
        const explicit = String(request?.axis ?? '').trim().toUpperCase();
        if (explicit === 'YZ' || explicit === 'XZ' || explicit === 'BOTH') return explicit as 'YZ' | 'XZ' | 'BOTH';
        const row = objectRows[objectIndex0];
        const target = getRenderImageHeightTarget(row);
        if (target) return Math.abs(Number(target.y)) >= Math.abs(Number(target.x)) ? 'YZ' : 'XZ';
        return 'BOTH';
      };
      const axis = inferAxis();
      const rays = await collectLegacyCrossRays(
        opticalSystemRows,
        axis,
        objectRows,
        {
          rayCountOverride: Number.isFinite(Number(request?.rayCount)) ? Number(request.rayCount) : undefined,
        },
      );
      if (!Array.isArray(rays) || rays.length === 0) {
        return { ok: false, reason: 'no-rays', axis };
      }

      const imageSurfaceIndex = opticalSystemRows.findIndex((row: any) => {
        const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
        const normalized = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
        return normalized === 'image' || normalized.startsWith('image');
      });
      const imagePathPointIndex = imageSurfaceIndex >= 0
        ? getRenderRayPathPointIndexForSurfaceIndex(opticalSystemRows, imageSurfaceIndex)
        : null;
      const pickPath = (ray: any): any[] | null => {
        const candidatePaths = [ray?.rayPath, ray?.rayPathToTarget, ray?.path, ray?.originalRay?.rayPath];
        for (const candidate of candidatePaths) {
          if (Array.isArray(candidate) && candidate.length >= 2) return candidate;
        }
        return null;
      };

      let bestAngle = Number.NEGATIVE_INFINITY;
      let chiefCount = 0;
      for (const ray of rays) {
        const rayObjectIndexRaw = Number(ray?.objectIndex ?? ray?.originalRay?.objectIndex);
        const rayObjectIndex = Number.isFinite(rayObjectIndexRaw) ? Math.max(0, Math.floor(rayObjectIndexRaw)) : 0;
        if (rayObjectIndex !== objectIndex0) continue;
        const typeLabel = String(ray?.originalRay?.type ?? ray?.type ?? '').trim().toLowerCase();
        if (!typeLabel.includes('chief')) continue;
        const path = pickPath(ray);
        if (!Array.isArray(path) || path.length < 2) continue;

        let p0 = path[path.length - 2];
        let p1 = path[path.length - 1];
        if (imagePathPointIndex !== null) {
          if (imagePathPointIndex >= 1 && imagePathPointIndex < path.length) {
            p1 = path[imagePathPointIndex];
            p0 = path[imagePathPointIndex - 1];
          } else if (imageSurfaceIndex >= 0) {
            for (let index = path.length - 1; index >= 1; index -= 1) {
              const pointSurfaceIndex = Number(path[index]?.surfaceIndex ?? path[index]?.surface ?? path[index]?.surfaceIdx);
              if (Number.isInteger(pointSurfaceIndex) && pointSurfaceIndex === imageSurfaceIndex) {
                p1 = path[index];
                p0 = path[index - 1];
                break;
              }
            }
          }
        }

        const dx = Number(p1?.x) - Number(p0?.x);
        const dy = Number(p1?.y) - Number(p0?.y);
        const dz = Number(p1?.z) - Number(p0?.z);
        const norm = Math.hypot(dx, dy, dz);
        if (!(Number.isFinite(norm) && norm > 1e-12)) continue;
        const ux = dx / norm;
        const uy = dy / norm;
        const uz = dz / norm;
        const angleDeg = Math.atan2(Math.hypot(ux, uy), Math.abs(uz)) * 180 / Math.PI;
        if (Number.isFinite(angleDeg)) {
          chiefCount += 1;
          bestAngle = Math.max(bestAngle, Math.abs(angleDeg));
        }
      }

      if (!Number.isFinite(bestAngle)) {
        return { ok: false, reason: 'no-chief-angle', axis, chiefCount };
      }
      return { ok: true, angleDeg: bestAngle, axis, chiefCount };
    } catch (error) {
      return { ok: false, reason: String((error as any)?.message || error || 'error') };
    }
  };

  try {
    (window as any).__cooptCalculateRenderChiefAngleDegForRequirement = calculateRenderChiefAngleDegForRequirement;
  } catch (_) {}

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
      // Yield two animation frames so the quick-pass 3D result actually paints
      // before the heavy (synchronous) full ray-tracing pass blocks the main
      // thread. Without this, the last painted frame stays stale (e.g. the
      // "Initializing scene..." status) for the entire trace duration.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!isLatestRenderDrawRequest(requestId)) return;
          scheduleRenderRedraw(undefined, undefined, beginRenderDrawRequest(), { useLiveRayCount: true }).catch(() => {
            setRenderWindowStatus('Draw failed');
          });
        });
      });
    }, 0);
  };

  const buildRenderSyncSignature = (rows: any[], objectRows?: any[], redrawOptions?: RenderRedrawOptions): string => {
    const quickRayCount = resolveQuickInitialRenderRayCount(redrawOptions);
    return [
      renderViewModeRef.current,
      renderViewAxisRef.current,
      Number(quickRayCount || resolveRenderRedrawRayCountOverride(redrawOptions) || getLiveRenderRayCount(renderRayCountRef.current) || 0),
      buildRenderRowsSignature(rows),
      buildRenderObjectRowsSignature(Array.isArray(objectRows) ? objectRows : []),
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
      const renderSourceRows = !compareEnabled ? getRenderSourceRows(hostWindow) : [];
      const imageSemidiaWarning = !compareEnabled ? getRenderImageSemidiaWarning(rows, renderObjectRows) : null;
      const rowsWithObjectDistance = !compareEnabled ? syncRenderObjectDistanceFromConfig(rows, hostWindow) : rows;
      const rowsWithDisplaySpacing = !compareEnabled ? applyRenderImageHeightDisplaySpacing(rowsWithObjectDistance, renderObjectRows) : rowsWithObjectDistance;
      const rowsForRender = !compareEnabled ? applyRenderImageSemidiaWarning(rowsWithDisplaySpacing, imageSemidiaWarning) : rowsWithObjectDistance;
      renderImageSemidiaWarningRef.current = imageSemidiaWarning;
      let rayCollectMs = 0;
      let rayDrawMs = 0;
      let renderAngleStatusSuffix = '';
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
              showDesignIntentLabels: renderLabelVisibilityRef.current.designIntent,
              showPrincipalPointLabels: renderLabelVisibilityRef.current.principalPoints,
              showSurfaceNumberLabels: renderLabelVisibilityRef.current.surfaceNumbers,
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
            if (compareRays.length > 0 && typeof w.drawSectionPlaneRays === 'function') {
              const drawStartMs = performance.now();
              w.drawSectionPlaneRays(compareRays, group);
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
            showDesignIntentLabels: renderLabelVisibilityRef.current.designIntent,
            showPrincipalPointLabels: renderLabelVisibilityRef.current.principalPoints,
            showSurfaceNumberLabels: renderLabelVisibilityRef.current.surfaceNumbers,
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

      if (!compareEnabled && sceneForDraw) {
        try {
          applyRenderWindowDirectCrossFill(sceneForDraw, axis, rowsForRender);
        } catch (fillErr) {
          console.warn('[RenderWindow] Cross-section lens fill failed:', fillErr);
        }
      }

      if (!compareEnabled && !shouldSkipRayGeneration) {
        const collectStartMs = performance.now();
        const legacyCrossRays = await collectLegacyCrossRays(
          rowsForRender,
          axis,
          Array.isArray(renderObjectRows) ? renderObjectRows : [],
          {
            rayCountOverride: effectiveRayCountOverride,
          }
        );
        const groupedSectionRays = new Map<number, any[]>();
        (Array.isArray(legacyCrossRays) ? legacyCrossRays : []).forEach((ray: any) => {
          const rawObjectIndex = Number(ray?.objectIndex ?? ray?.originalRay?.objectIndex ?? 0);
          const objectIndex = Number.isFinite(rawObjectIndex) ? rawObjectIndex : 0;
          if (!groupedSectionRays.has(objectIndex)) groupedSectionRays.set(objectIndex, []);
          groupedSectionRays.get(objectIndex)!.push(ray);
        });
        const requestedSectionRayCount = Math.max(1, Math.floor(Number(effectiveRayCountOverride) || 1));
        const sectionAxisRayCount = requestedSectionRayCount > 1 && requestedSectionRayCount % 2 === 0
          ? requestedSectionRayCount + 1
          : requestedSectionRayCount;
        const sectionRays = Array.from(groupedSectionRays.entries())
          .sort((a, b) => a[0] - b[0])
          .flatMap(([, group]) => selectCrossRaysForAxis(group, sectionAxisRayCount, axis));
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
              sectionRays,
              rowsForRender,
              Array.isArray(renderObjectRows) ? renderObjectRows : [],
              targetSurfaceIndex,
              window
            );
          }
        } catch (_) {}
        if (sectionRays.length > 0 && typeof w.drawSectionPlaneRays === 'function') {
          const drawStartMs = performance.now();
          w.drawSectionPlaneRays(sectionRays, sceneForDraw);
          rayDrawMs += performance.now() - drawStartMs;
        }
      }
      if (rayCollectMs > 0) timingStages.push({ label: 'rayCollect', ms: rayCollectMs });
      if (rayDrawMs > 0) timingStages.push({ label: 'rayDraw', ms: rayDrawMs });

      const cameraStartMs = performance.now();
      if (axis === 'XZ' && typeof w.setCameraForXZCrossSection === 'function') {
        w.setCameraForXZCrossSection({
          includeRayStartMargin: true,
          storeDrawCrossBounds: true,
          centerVerticalOnOpticalAxis: true,
          fitOpticalSystemOnly: true,
        });
      } else if (axis === 'YZ' && typeof w.setCameraForYZCrossSection === 'function') {
        w.setCameraForYZCrossSection({
          includeRayStartMargin: true,
          storeDrawCrossBounds: true,
          centerVerticalOnOpticalAxis: true,
          fitOpticalSystemOnly: true,
        });
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
      const readyStatus = compareEnabled
        ? `Ready (${axis} compare)`
        : `Ready (${axis} section)${renderAngleStatusSuffix}`;
      publishRenderTiming(readyStatus, `cross-${axis}`, timingStages, blockPerfBefore);
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
    const shouldSkipRayGeneration = redrawOptions?.skipRayGeneration === true || portRoutedRenderActiveRef.current;
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
      const rowsWithObjectDistance = syncRenderObjectDistanceFromConfig(rows, hostWindow);
      const rowsWithDisplaySpacing = applyRenderImageHeightDisplaySpacing(rowsWithObjectDistance, renderObjectRows);
      const rowsForRender = applyRenderImageSemidiaWarning(rowsWithDisplaySpacing, imageSemidiaWarning);
      renderImageSemidiaWarningRef.current = imageSemidiaWarning;

      let sceneForDraw = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      if (!sceneForDraw) {
        setRenderWindowStatus('Initializing scene...');
        const sceneWaitStartMs = performance.now();
        const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        const sceneWaitBudgetMs = Number.isFinite(Number(g?.__COOPT_RENDER_SCENE_WAIT_MS))
          ? Math.max(0, Math.floor(Number(g.__COOPT_RENDER_SCENE_WAIT_MS)))
          : 10000;
        const scenePollMs = Number.isFinite(Number(g?.__COOPT_RENDER_SCENE_POLL_MS))
          ? Math.max(16, Math.floor(Number(g.__COOPT_RENDER_SCENE_POLL_MS)))
          : 40;
        let attemptCount = 0;

        const waitForScenePoll = () => new Promise<void>((resolve) => {
          window.setTimeout(() => resolve(), scenePollMs);
        });

        // In hidden/inactive windows requestAnimationFrame can be heavily throttled
        // or suspended, so use a time-based poll to avoid getting stuck.
        while (!sceneForDraw && (performance.now() - sceneWaitStartMs) < sceneWaitBudgetMs) {
          if (!isLatestRenderDrawRequest(requestId)) {
            return false;
          }
          attemptCount += 1;
          if (attemptCount === 1 || attemptCount % 25 === 0) {
            const elapsedMs = Math.round(performance.now() - sceneWaitStartMs);
            console.warn(`[RenderWindow] Waiting for scene initialization: ${elapsedMs}ms (attempt ${attemptCount})`);
          }
          if (attemptCount === 1 || attemptCount % 10 === 0) {
            ensureRenderCanvasAttached();
          }
          await waitForScenePoll();
          sceneForDraw = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
        }
        if (!sceneForDraw) {
          const elapsedMs = Math.round(performance.now() - sceneWaitStartMs);
          console.error(`[RenderWindow] Scene initialization timed out after ${elapsedMs}ms (${attemptCount} polls)`);
          setRenderWindowStatus('Scene unavailable');
          return false;
        }
        const sceneWaitMs = performance.now() - sceneWaitStartMs;
        timingStages.push({ label: 'sceneWait', ms: sceneWaitMs });
        if (Array.isArray(startupStages)) updateRenderStartupBreakdown(timingStages);
        console.log(`[RenderWindow] Scene ready after ${Math.round(sceneWaitMs)}ms`);
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
            renderLabelVisibilityRef.current.designIntent || renderLabelVisibilityRef.current.principalPoints || renderLabelVisibilityRef.current.surfaceNumbers,
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
      setRenderWindowStatus('Preparing render scene...');
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
        setRenderWindowStatus('Drawing surfaces...');
        w.drawOpticalSystemSurfaces({
          opticalSystemData: rowsForRender,
          surfaceOrigins: nextSurfaceOrigins,
          scene: sceneForDraw,
          crossSectionOnly: false,
          showSurfaceOrigins: false,
          showSemidiaRing: true,
          showMirrorBackText: false,
          showDesignIntentLabels: renderLabelVisibilityRef.current.designIntent,
          showPrincipalPointLabels: renderLabelVisibilityRef.current.principalPoints,
          showSurfaceNumberLabels: renderLabelVisibilityRef.current.surfaceNumbers,
          surfaceMeshSegments: RENDER_3D_SURFACE_MESH_SEGMENTS,
          toricMeshSegments: RENDER_3D_TORIC_MESH_SEGMENTS,
          crossSectionDirection: 'YZ',
          crossSectionCenterOffset: 0
        });
        timingStages.push({ label: 'surfaces', ms: performance.now() - surfacesStartMs });
        if (Array.isArray(startupStages)) updateRenderStartupBreakdown(timingStages);
      }

      if (renderShowSolids) {
        const solidsStartMs = performance.now();
        setRenderWindowStatus('Building solid lenses...');
        const solidScene = createOpticalSceneSolidGroup(sceneForDraw, rowsForRender, {
          sectionAngleDegrees: renderShowSectionCut ? renderSectionAngle : null,
        });
        if (solidScene.solidCount > 0) {
          // Retain the source surfaces at low opacity so exports can still find
          // them while the closed display meshes provide the visible volume.
          sceneForDraw.traverse((child: any) => {
            const artifactType = String(child?.userData?.type || '');
            const isSourceSurface = child?.userData?.isLensSurface === true;
            const isSourceOutline = artifactType === 'semidiaRing'
              || artifactType === 'apertureRect'
              || artifactType === 'connectionCornerRing';
            if (!isSourceSurface && !(renderShowSectionCut && isSourceOutline)) return;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach((material: any) => {
              if (!material) return;
              material.transparent = true;
              material.opacity = renderShowSectionCut
                ? 0
                : Math.min(0.1, Number(material.opacity) || 0.1);
              material.depthWrite = false;
              material.needsUpdate = true;
            });
          });

          solidScene.group.traverse((child: any) => {
            if (!child?.isMesh) return;
            try { child.material?.dispose?.(); } catch (_) {}
            child.material = new THREE.MeshPhongMaterial({
              color: Number(child.userData?.displayColor) || 0x67c7ff,
              transparent: true,
              opacity: renderShowSectionCut ? 0.82 : 0.62,
              side: THREE.DoubleSide,
              depthWrite: true,
              shininess: 90,
              specular: 0xffffff,
            });
            child.renderOrder = 1;
          });
          solidScene.group.add(new THREE.HemisphereLight(0xffffff, 0x31506b, 1.35));
          const solidKeyLight = new THREE.DirectionalLight(0xffffff, 1.1);
          solidKeyLight.position.set(-1, 1.5, 2);
          solidScene.group.add(solidKeyLight);
          sceneForDraw.add(solidScene.group);
        }
        timingStages.push({ label: 'solids', ms: performance.now() - solidsStartMs });
      }

      let rendered3DRayCount = 0;
      let render3DTransverseRadiusMm = 0;
      if (!shouldSkipRayGeneration) {
        const rayCollectStartMs = performance.now();
        setRenderWindowStatus('Tracing rays / calculating image height...');
        // Let the browser paint the "Tracing rays..." status before the heavy,
        // largely-synchronous ray trace runs, so the UI does not appear frozen
        // on a stale status while tracing.
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(fallbackTimer);
            resolve();
          };
          // A detached/occluded MDI iframe may suspend requestAnimationFrame.
          // Never let that visual yield prevent the actual ray trace.
          const fallbackTimer = window.setTimeout(finish, 80);
          requestAnimationFrame(() => requestAnimationFrame(finish));
        });
        if (!isLatestRenderDrawRequest(requestId)) {
          return false;
        }
        const collectedCrossRays = await collectLegacyCrossRays(
          rowsForRender,
          'BOTH',
          Array.isArray(renderObjectRows) ? renderObjectRows : [],
          {
            rayCountOverride: effectiveRayCountOverride,
          }
        );
        const primaryWavelength = (typeof w.getPrimaryWavelength === 'function')
          ? (Number(w.getPrimaryWavelength()) || 0.5876)
          : 0.5876;
        // A finite system whose Stop is the first physical plane needs no
        // iterative pupil solve for cardinal rays. If the combined sampler
        // returned only chiefs, aim directly at uniformly sampled Stop points
        // and trace those rays through the same exact surface sequence.
        const legacyCrossRays = appendDirectStopCardinalRenderRays(
          collectedCrossRays,
          rowsForRender,
          primaryWavelength,
          Number(effectiveRayCountOverride ?? renderRayCountRef.current ?? 1),
        );
        timingStages.push({ label: 'rayCollect', ms: performance.now() - rayCollectStartMs });
        rendered3DRayCount = legacyCrossRays.length;
        for (const ray of legacyCrossRays) {
          const rayPath = Array.isArray(ray?.rayPath)
            ? ray.rayPath
            : (Array.isArray(ray?.rayPathToTarget) ? ray.rayPathToTarget : []);
          for (const point of rayPath) {
            const x = Number(point?.x);
            const y = Number(point?.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            render3DTransverseRadiusMm = Math.max(render3DTransverseRadiusMm, Math.hypot(x, y));
          }
        }
        try {
          (window as any).__COOPT_LAST_RENDER_3D_RAY_SUMMARY = {
            at: new Date().toISOString(),
            requestedPerObject: Number(effectiveRayCountOverride ?? renderRayCountRef.current ?? 0),
            objectCount: Array.isArray(renderObjectRows) ? renderObjectRows.length : 0,
            collectedRayCount: rendered3DRayCount,
            initialCollectedRayCount: collectedCrossRays.length,
            directStopFallbackRayCount: legacyCrossRays.filter((ray: any) => ray?.__cooptDirectStopFallback === true).length,
            transverseRadiusMm: render3DTransverseRadiusMm,
            types: legacyCrossRays.reduce((counts: Record<string, number>, ray: any) => {
              const type = String(ray?.originalRay?.type ?? ray?.type ?? 'unknown');
              counts[type] = (counts[type] || 0) + 1;
              return counts;
            }, {}),
          };
        } catch (_) {}
        if (Array.isArray(startupStages)) updateRenderStartupBreakdown(timingStages);
        if (!isLatestRenderDrawRequest(requestId)) {
          return false;
        }
        if (legacyCrossRays.length > 0 && typeof w.drawCrossBeamRays === 'function') {
          const rayDrawStartMs = performance.now();
          w.drawCrossBeamRays(legacyCrossRays, sceneForDraw);
          try {
            let sceneRayObjectCount = 0;
            sceneForDraw.traverse((child: any) => {
              if (child?.userData?.rayType === 'crossBeam') sceneRayObjectCount += 1;
            });
            const summary = (window as any).__COOPT_LAST_RENDER_3D_RAY_SUMMARY;
            if (summary && typeof summary === 'object') summary.sceneRayObjectCount = sceneRayObjectCount;
          } catch (_) {}
          timingStages.push({ label: 'rayDraw', ms: performance.now() - rayDrawStartMs });
          if (Array.isArray(startupStages)) updateRenderStartupBreakdown(timingStages);
        }
      }

      try {
        setRenderWindowStatus('Finalizing camera and render...');
        const cameraStartMs = performance.now();
        if (typeof w.fitCameraToOpticalSystem === 'function') {
          // 3D must restore its oblique camera after either cross-section
          // view. fitCameraToOpticalSystem keeps optical Z horizontal while
          // still exposing both transverse axes; the Hybrid overlay then fits
          // the complete assembly without replacing this direction.
          w.fitCameraToOpticalSystem();
        } else if (typeof w.fitCameraToScene === 'function') {
          w.fitCameraToScene();
        } else if (typeof w.adjustCameraView === 'function') {
          const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
          const controls = w.controls || (typeof w.getControls === 'function' ? w.getControls() : null);
          const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
          w.adjustCameraView(sceneForDraw, camera, controls, renderer);
        }
        // Keep the optical Z axis horizontal in the default 3D view. Users can
        // still orbit manually when they want to inspect the X-pupil bundle.
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
      const ready3DLabel = renderShowSectionCut
        ? `Ready (3D section ${Math.round(renderSectionAngle)}°)`
        : `Ready (3D · ${rendered3DRayCount} rays)`;
      publishRenderTiming(ready3DLabel, '3d', timingStages, blockPerfBefore);
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

  const setRenderVisibleDebug = (text: string) => {
    try {
      const doc = window.document;
      let banner = doc.getElementById('coopt-drawcross-debug-banner') as HTMLDivElement | null;
      const safeText = String(text ?? '');
      if (!safeText) {
        if (banner) banner.remove();
        return;
      }
      if (!banner) {
        banner = doc.createElement('div');
        banner.id = 'coopt-drawcross-debug-banner';
        banner.style.position = 'fixed';
        banner.style.left = '8px';
        banner.style.bottom = '8px';
        banner.style.zIndex = '2147483647';
        banner.style.maxWidth = 'min(720px, calc(100vw - 16px))';
        banner.style.maxHeight = '40vh';
        banner.style.overflow = 'auto';
        banner.style.padding = '8px 10px';
        banner.style.background = 'rgba(0, 0, 0, 0.82)';
        banner.style.color = '#9ef59e';
        banner.style.border = '1px solid rgba(158, 245, 158, 0.35)';
        banner.style.borderRadius = '6px';
        banner.style.fontFamily = 'Consolas, "Courier New", monospace';
        banner.style.fontSize = '11px';
        banner.style.lineHeight = '1.35';
        banner.style.whiteSpace = 'pre-wrap';
        banner.style.pointerEvents = 'none';
        (doc.body || doc.documentElement)?.appendChild(banner);
      }
      banner.textContent = safeText;
      try {
        (window as any).__cooptLastSectionDebug = safeText;
        const history = Array.isArray((window as any).__cooptSectionDebugHistory)
          ? (window as any).__cooptSectionDebugHistory
          : [];
        history.push(safeText);
        (window as any).__cooptSectionDebugHistory = history.slice(-20);
      } catch (_) {}
      try {
        console.warn(safeText);
      } catch (_) {}
    } catch (_) {}
  };

  const markRenderViewportReady = (): void => {
    if (!isRenderWindowMode) return;
    setRenderStartupBreakdown('');
    setRenderViewportVisible(true);
    window.dispatchEvent(new CustomEvent('coopt:render-redraw-complete'));
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
    try {
      localStorage.setItem(RENDER_SHOW_SOLIDS_KEY, renderShowSolids ? 'true' : 'false');
      localStorage.setItem(RENDER_SHOW_SECTION_CUT_KEY, renderShowSectionCut ? 'true' : 'false');
      localStorage.setItem(RENDER_SECTION_ANGLE_KEY, String(renderSectionAngle));
    } catch (_) {}
    scheduleRenderRedraw().catch(() => {
      setRenderWindowStatus('Draw failed');
    });
  }, [renderShowSolids, renderShowSectionCut, renderSectionAngle]);

  useEffect(() => {
    try {
      localStorage.setItem(RENDER_CONNECTIONS_STORAGE_KEY, renderShowPortConnections ? 'true' : 'false');
    } catch (_) {}
    window.dispatchEvent(new CustomEvent(RENDER_CONNECTIONS_VISIBILITY_EVENT, {
      detail: { visible: renderShowPortConnections },
    }));
  }, [renderShowPortConnections]);

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
    const releasePendingSystemConfigPreference = () => {
      if (renderRedrawInFlightRef.current) return;
      if (renderNeedsVisibilityReplayRef.current) return;
      if (Array.isArray(renderPendingRowsRef.current) && renderPendingRowsRef.current.length > 0) return;
      try { delete w.__cooptPreferRuntimeSystemConfig; } catch (_) {}
    };
    w.__cooptRenderWindowRedraw = async (rows?: any[], syncStamp?: string, objectRows?: any[]) => {
      const normalizedSyncStamp = String(syncStamp ?? '').trim();
      let appliedSystemConfig = false;
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
            appliedSystemConfig = true;
          } catch (_) {}
        }
      } catch (_) {
      } finally {
        try { delete w.__cooptPendingRenderSystemConfig; } catch (_) {}
      }
      if (appliedSystemConfig) {
        // The Render iframe has its own event scope. Notify its Hybrid overlay
        // immediately after adopting the host Config so detector pitch/count,
        // component envelopes and port positions rebuild before ray redraw.
        try {
          window.dispatchEvent(new CustomEvent('coopt:system-configurations-updated', {
            detail: { reason: 'render-system-config-sync' },
          }));
        } catch (_) {}
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
        const redrawSignature = buildRenderSyncSignature(rows, Array.isArray(objectRows) ? objectRows : [], { useLiveRayCount: true });
        if (!renderNeedsVisibilityReplayRef.current && redrawSignature === renderLastCompletedSyncSignatureRef.current && !renderRedrawInFlightRef.current) {
          releasePendingSystemConfigPreference();
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
            const redrawOptions: RenderRedrawOptions = renderViewModeRef.current === '3D'
              ? { useLiveRayCount: true }
              : {
                  quickInitialRayCount: Math.min(3, Math.max(1, Number(getLiveRenderRayCount(renderRayCountRef.current) || 1))),
                  scheduleFullRayPass: true,
                  useLiveRayCount: true,
                  skipRayGeneration: true,
                };
            const redrawOk: any = await redrawCurrentRenderView(undefined, undefined, redrawRequestId, redrawOptions);
            if (queuedSyncStamp && redrawOk !== false) {
              try { w.__cooptLastRenderSyncStamp = queuedSyncStamp; } catch (_) {}
              if (String(renderPendingSyncStampRef.current ?? '').trim() === queuedSyncStamp) {
                renderPendingSyncStampRef.current = '';
              }
            }
            if (queuedRows && redrawOk !== false) {
              renderLastCompletedSyncSignatureRef.current = buildRenderSyncSignature(queuedRows, Array.isArray(queuedObjectRows) ? queuedObjectRows : [], { useLiveRayCount: true });
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
        releasePendingSystemConfigPreference();
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
        void Promise.resolve(w.__cooptRenderWindowRedraw(queuedRows, undefined, queuedObjectRows || undefined))
          .finally(releasePendingSystemConfigPreference);
        return;
      }
      scheduleRenderRedraw()
        .catch(() => {
          setRenderWindowStatus('Draw failed');
        })
        .finally(releasePendingSystemConfigPreference);
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
            // Show empty-state immediately; do table/config hydration in background so
            // users are not blocked for several seconds before seeing "No optical data".
            setRenderWindowStatus('No optical data');
            setRenderLensColorTargets([]);

            void (async () => {
              let redrawRequested = false;
              const requestRedrawIfRowsReady = (): boolean => {
                try {
                  if (redrawRequested || typeof w.getOpticalSystemRows !== 'function') return redrawRequested;
                  const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
                  const nextCount = Array.isArray(rows) ? rows.length : 0;
                  if (nextCount > 0) {
                    redrawRequested = true;
                    scheduleRenderRedraw().catch(() => {
                      setRenderWindowStatus('Draw failed');
                    });
                    return true;
                  }
                } catch (_) {}
                return false;
              };

              // Trigger a redraw as soon as rows arrive instead of waiting for
              // the full hydration chain to settle.
              for (let attempt = 0; attempt < 25 && !redrawRequested; attempt++) {
                if (requestRedrawIfRowsReady()) break;
                await new Promise((resolve) => window.setTimeout(resolve, 120));
              }

              try {
                const cm = w.ConfigurationManager;
                if (cm && typeof cm.loadActiveConfigurationToTables === 'function') {
                  void Promise.resolve(cm.loadActiveConfigurationToTables({ applyToUI: true }))
                    .catch((err) => {
                      console.warn('[RenderWindow] Deferred configuration load failed:', err);
                    });
                }
              } catch (_) {}

              try {
                if (typeof w.initializeAllTables === 'function') {
                  void Promise.resolve(w.initializeAllTables());
                }
              } catch (_) {}

              // Final check after deferred hydration tasks were kicked.
              requestRedrawIfRowsReady();
            })();

            return false;
          }

          try {
            const currentMode = renderViewModeRef.current;
            const currentAxis = renderViewAxisRef.current;
            const requestId = beginRenderDrawRequest();
            const quickInitialRayCount = Math.min(3, Math.max(1, Number(getLiveRenderRayCount(renderRayCountRef.current) || 1)));
            const ok = currentMode === '3D'
              ? await drawRender3DView(startupStages, requestId, { useLiveRayCount: true })
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
      try {
        const __firstLensRadius = (sc: any): any => {
          try {
            const cfgs = Array.isArray(sc?.configurations) ? sc.configurations : [];
            const aId = sc?.activeConfigId;
            const ac = cfgs.find((c: any) => c && String(c.id) === String(aId)) || cfgs[0];
            const blks = Array.isArray(ac?.blocks) ? ac.blocks : [];
            for (const b of blks) {
              const p = b?.parameters;
              if (p && (p.radius1 !== undefined || p.radius !== undefined)) {
                return { blockId: b?.blockId, radius1: p.radius1, radius: p.radius, thickness: p.thickness };
              }
            }
          } catch (_) {}
          return null;
        };
        let __storageCfg: any = null;
        try {
          __storageCfg = typeof sourceWindow.loadSystemConfigurations === 'function'
            ? sourceWindow.loadSystemConfigurations()
            : null;
        } catch (_) {}
        const __runtimeCfg = sourceWindow.__cooptSystemConfig || null;
        if ((window as any).__COOPT_AL_DIAG === true) {
          console.log('🩺 [AL-DIAG] Optimize REOPEN read', {
            preferRuntimeFlag: !!sourceWindow.__cooptPreferRuntimeSystemConfig,
            deferUntil: Number(sourceWindow.__cooptDeferDerivedUiUntil) || 0,
            now: Date.now(),
            usedConfigFirstLens: __firstLensRadius(sourceSystemConfig),
            storageConfigFirstLens: __firstLensRadius(__storageCfg),
            runtimeConfigFirstLens: __firstLensRadius(__runtimeCfg),
          });
        }
      } catch (_) {}
      let rows = sourceWindow.getOpticalSystemRows ? sourceWindow.getOpticalSystemRows(sourceWindow.tableOpticalSystem) : [];
      let reqRows: any[] = [];
      try {
        const cfg = sourceSystemConfig;
        const activeId = cfg?.activeConfigId;
        const activeCfg = Array.isArray(cfg?.configurations)
          ? (cfg.configurations.find((c: any) => c && String(c.id) === String(activeId)) || cfg.configurations[0])
          : null;
        if (activeCfg && !shouldPreferImportedOpticalRowsInConfig(activeCfg) && Array.isArray(activeCfg.blocks) && activeCfg.blocks.length > 0 && typeof sourceWindow.expandBlocksToOpticalSystemRows === 'function') {
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
    if (analysisWindowMode.analysis === 'mtf' || analysisWindowMode.analysis === 'through-focus-mtf' || analysisWindowMode.analysis === 'field-mtf' || analysisWindowMode.analysis === 'distortion' || analysisWindowMode.analysis === 'distortion-grid' || analysisWindowMode.analysis === 'spot-diagram' || analysisWindowMode.analysis === 'spherical-aberration' || analysisWindowMode.analysis === 'magnification-chromatic-aberration' || analysisWindowMode.analysis === 'integrated-aberration' || analysisWindowMode.analysis === 'transverse-aberration' || analysisWindowMode.analysis === 'opd-fan' || analysisWindowMode.analysis === 'through-focus-spot' || analysisWindowMode.analysis === 'opd' || analysisWindowMode.analysis === 'psf' || analysisWindowMode.analysis === 'multi-field-psf' || analysisWindowMode.analysis === 'image-simulation' || analysisWindowMode.analysis === 'sensitivity-analysis' || analysisWindowMode.analysis === 'tolerance-analysis') return;

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
      'opd-fan': 'open-opd-fan-window-btn',
      'opd': 'open-opd-window-btn',
      'psf': 'open-psf-window-btn',
      'multi-field-psf': 'open-multi-field-psf-window-btn',
      'image-simulation': 'open-image-simulation-window-btn',
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
      'opd-fan': 'Optical Path Difference Fan',
      'opd': 'Optical Path Difference',
      'psf': 'Point Spread Function',
      'multi-field-psf': 'Multi-Field PSF',
      'image-simulation': 'Image Simulation',
      'coherent-interferometer': 'Coherent Signal',
      'sensitivity-analysis': 'Sensitivity Analysis',
      'tolerance-analysis': 'Tolerance Analysis',
      'mtf': 'Modulation Transfer Function',
      'through-focus-spot': 'Through-Focus Spot',
      'through-focus-mtf': 'Through-Focus MTF',
      'field-mtf': 'Field MTF',
    };
    const reactManagedAnalysis = new Set(['mtf', 'through-focus-mtf', 'field-mtf', 'distortion', 'distortion-grid', 'spot-diagram', 'spherical-aberration', 'magnification-chromatic-aberration', 'integrated-aberration', 'transverse-aberration', 'opd-fan', 'through-focus-spot', 'opd', 'psf', 'multi-field-psf', 'image-simulation', 'coherent-interferometer', 'sensitivity-analysis', 'tolerance-analysis']);

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

  if (['spot-diagram', 'spherical-aberration', 'magnification-chromatic-aberration', 'integrated-aberration', 'transverse-aberration', 'opd-fan', 'through-focus-spot'].includes(analysisWindowMode.analysis)) {
    return <BasicAnalysisPage type={analysisWindowMode.analysis as BasicAnalysisType} />;
  }

  if (analysisWindowMode.analysis === 'opd') {
    return <WavefrontAnalysisPage />;
  }

  if (analysisWindowMode.analysis === 'psf') {
    return <PsfAnalysisPage />;
  }

  if (analysisWindowMode.analysis === 'multi-field-psf') {
    return <MultiFieldPsfPage />;
  }

  if (analysisWindowMode.analysis === 'coherent-interferometer') {
    return <CoherentInterferometerPage />;
  }

  if (analysisWindowMode.analysis === 'image-simulation') {
    return <ImageSimulationPage />;
  }

  if (analysisWindowMode.analysis === 'sensitivity-analysis') {
    return <ToleranceAnalysisPage mode="sensitivity" />;
  }
  if (analysisWindowMode.analysis === 'tolerance-analysis') {
    return <ToleranceAnalysisPage mode="tolerance" />;
  }

  if (isOptimizeWindowMode) {
    const optimizeStateStatus = String(optimizeState?.status || 'Idle');
    const optimizeHasDoneStatus = /^(done|finished|complete)$/i.test(optimizeStateStatus);
    const optimizeHasTerminalStatus = optimizeHasDoneStatus || /^(stopped|error)$/i.test(optimizeStateStatus);
    const rawOptimizePercent = Number.isFinite(Number(optimizeState?.percent))
      ? Math.max(0, Math.min(100, Number(optimizeState.percent)))
      : 0;
    const percent = optimizeHasDoneStatus ? rawOptimizePercent : Math.min(99, rawOptimizePercent);

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
          refreshedScore = Number(await refreshFn(hostRows, reason, { syncBlocks: true }));
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
          next.bestRequirementScore = Number.isFinite(effectiveScore) ? effectiveScore : prev.bestRequirementScore;
        } else {
          next.requirementScoreAfter = Number.isFinite(effectiveScore) ? effectiveScore : prev.requirementScoreAfter;
          next.requirementScoreTable = Number.isFinite(effectiveScore) ? effectiveScore : prev.requirementScoreTable;
          next.meritAfter = Number.isFinite(effectiveScore) ? effectiveScore : prev.meritAfter;
          if (Number.isFinite(effectiveScore)) {
            next.best = Number.isFinite(prev.best) ? Math.min(prev.best, effectiveScore) : effectiveScore;
            next.bestRequirementScore = Number.isFinite(prev.bestRequirementScore)
              ? Math.min(prev.bestRequirementScore, effectiveScore)
              : effectiveScore;
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

    const runOptimize = async () => {
      if (optRunning) return;
      const w = window as any;
      const hostWindow = getOptimizeHostWindow();
      const cloneJsonLocal = (v: any) => {
        try { return JSON.parse(JSON.stringify(v)); } catch (_) { return null; }
      };
      const loadHostSystemConfigSnapshot = () => {
        return getSystemConfigFromWindow(hostWindow) || getSystemConfigFromWindow(w) || null;
      };

      // The Object table is the user's latest Field definition. Capture and
      // persist it before touching runtime overrides; otherwise a stale saved
      // configuration can be reloaded here and collapse the table back to its
      // original min/max rows when Optimize starts.
      const liveObjectRowsAtRunClick = (() => {
        try {
          const table = hostWindow?.tableObject || w.tableObject;
          const rows = table && typeof table.getData === 'function' ? table.getData() : [];
          return Array.isArray(rows) ? (cloneJsonLocal(rows) || rows.map((row: any) => ({ ...row }))) : [];
        } catch (_) {
          return [];
        }
      })();
      const synchronizedHostConfigAtRunClick = cloneOptimizeConfigWithLiveObjectRows(
        loadHostSystemConfigSnapshot(),
        liveObjectRowsAtRunClick,
      );
      if (synchronizedHostConfigAtRunClick) {
        try {
          if (typeof hostWindow?.saveSystemConfigurationsFromTableConfig === 'function') {
            hostWindow.saveSystemConfigurationsFromTableConfig(cloneJsonLocal(synchronizedHostConfigAtRunClick) || synchronizedHostConfigAtRunClick);
          } else if (typeof hostWindow?.saveSystemConfigurations === 'function') {
            hostWindow.saveSystemConfigurations(cloneJsonLocal(synchronizedHostConfigAtRunClick) || synchronizedHostConfigAtRunClick);
          }
        } catch (_) {}
        for (const target of [hostWindow, w].filter((target, index, values) => target && values.indexOf(target) === index)) {
          try {
            target.__cooptSystemConfig = cloneJsonLocal(synchronizedHostConfigAtRunClick) || synchronizedHostConfigAtRunClick;
            target.__cooptPreferRuntimeSystemConfig = true;
            target.__cooptDeferDerivedUiUntil = Date.now() + 60000;
          } catch (_) {}
        }
      }

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
              delete target.__cooptDeferDerivedUiUntil;
            }
          } catch (_) {}
        };
        applyToWindow(hostWindow);
        if (w !== hostWindow) applyToWindow(w);
      };

      let frozenHostConfigForRun: any = null;
      try {
        const hostConfigBeforeSync = synchronizedHostConfigAtRunClick || loadHostSystemConfigSnapshot();
        frozenHostConfigForRun = cloneJsonLocal(hostConfigBeforeSync) || hostConfigBeforeSync || null;
        if (frozenHostConfigForRun) {
          try {
            w.__cooptSystemConfig = cloneJsonLocal(frozenHostConfigForRun) || frozenHostConfigForRun;
            w.__cooptPreferRuntimeSystemConfig = true;
            w.__cooptDeferDerivedUiUntil = Date.now() + 60000;
          } catch (_) {}
        }
      } catch (_) {}

      await syncHostDesignIntentAndRequirements(hostWindow, 'optimize-run-click', 'before');

      try {
        const hostConfig = synchronizedHostConfigAtRunClick || loadHostSystemConfigSnapshot();
        if (hostConfig && typeof hostConfig === 'object') {
          const clonedHostConfig = cloneJsonLocal(hostConfig) || hostConfig;
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
            w.__cooptSystemConfig = cloneJsonLocal(frozenRunConfig) || frozenRunConfig;
            w.__cooptPreferRuntimeSystemConfig = true;
            w.__cooptDeferDerivedUiUntil = Date.now() + 60000;
          } catch (_) {}
        }
      } catch (_) {}
      const sleepBlockToken = isTauriRuntime()
        ? `optimize-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        : '';

      const publishRunConfigForOptimizerOnly = (cfg: any, requirementRows?: any[]) => {
        const clonedConfig = cfg && typeof cfg === 'object'
          ? (cloneJsonLocal(cfg) || cfg)
          : null;
        if (clonedConfig && Array.isArray(requirementRows) && requirementRows.length > 0) {
          try {
            clonedConfig.systemRequirements = cloneJsonLocal(requirementRows) || requirementRows;
          } catch (_) {}
        }
        const targets = [w, hostWindow].filter((target, index, arr) => target && arr.indexOf(target) === index);
        for (const target of targets) {
          try {
            if (clonedConfig) {
              target.__cooptSystemConfig = cloneJsonLocal(clonedConfig) || clonedConfig;
              target.__cooptPreferRuntimeSystemConfig = true;
              target.__cooptDeferDerivedUiUntil = Date.now() + 60000;
            }
          } catch (_) {}
        }
      };

      const clearRunConfigForOptimizerOnly = () => {
        const targets = [w, hostWindow].filter((target, index, arr) => target && arr.indexOf(target) === index);
        for (const target of targets) {
          try { delete target.__cooptPreferRuntimeSystemConfig; } catch (_) {}
          try { delete target.__cooptSystemConfig; } catch (_) {}
          try { delete target.__cooptDeferDerivedUiUntil; } catch (_) {}
        }
      };

      const maxIterations = Math.max(1, Math.floor(Number(optMaxIterations) || 1));
      const maxEscapeLoops = Math.max(1, Math.floor(Number(optMaxEscapeLoops) || 1));

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
        if (activeCfg && !shouldPreferImportedOpticalRowsInConfig(activeCfg) && Array.isArray(activeCfg.blocks) && activeCfg.blocks.length > 0 && typeof hostWindow.expandBlocksToOpticalSystemRows === 'function') {
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
      optimizeConsoleHeaderWrittenRef.current = false;
      optimizeConsolePrevMinRef.current = Number.NaN;
      optimizeConsoleLastIterRef.current = -1;
      optimizeConsoleStartedAtRef.current = Date.now();
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
        escapeLoop: null,
        escapeLoops: null,
        issue: '-',
        percent: 0,
        progressEvents: [],
      }));
      appendOptimizeConsoleLine(`[Optimizer] policy=${OPTIMIZER_POLICY_ID} runner=local-window`);
      appendOptimizeConsoleHeader();
      optimizeConsoleHeaderWrittenRef.current = true;

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
        let tsBestRequirementSnapshot: any[] = [];
        let renderSyncSequence = 0;
        let lastRenderSyncAt = 0;
        const RENDER_SYNC_MIN_INTERVAL_MS = 400;
        const renderSyncQueue: Array<{ rows: any[]; finalizeAutoSemidia?: boolean }> = [];
        let renderSyncInFlight = false;
        let renderSyncDrainPromise: Promise<void> | null = null;
        let lastQueuedRenderSyncSignature = '';
        let lastCompletedRenderSyncSignature = '';
        let optimizeFinalized = false;

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

        const performRenderSync = async (rowsForRender: any[], options?: { finalizeAutoSemidia?: boolean; force?: boolean }) => {
          if (!optAutoRenderOnAccept && options?.force !== true) return;

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
            const renderIframe = hostWindow?.document?.querySelector?.('iframe[title="Render"]') as HTMLIFrameElement | null;
            const embeddedRenderWindow = renderIframe?.contentWindow as any;
            if (embeddedRenderWindow && typeof embeddedRenderWindow.__cooptRenderWindowRedraw === 'function') {
              if (systemConfig) {
                try {
                  embeddedRenderWindow.__cooptPendingRenderSystemConfig = systemConfig;
                  embeddedRenderWindow.__cooptSystemConfig = systemConfig;
                  embeddedRenderWindow.__cooptPreferRuntimeSystemConfig = true;
                } catch (_) {}
              }
              await Promise.resolve(embeddedRenderWindow.__cooptRenderWindowRedraw(renderRows, payloadToken, objectRows));
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
          if (!renderSyncDrainPromise) {
            const pendingDrain = drainRenderSyncQueue().catch((error) => {
              console.warn('[Optimize] Render sync queue failed', error);
            });
            renderSyncDrainPromise = pendingDrain;
            void pendingDrain.finally(() => {
              if (renderSyncDrainPromise === pendingDrain) renderSyncDrainPromise = null;
            });
          }
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

        const getDiagRowsFingerprintLocal = (rowsInput: any[]): any => {
          const rows = Array.isArray(rowsInput) ? rowsInput : [];
          const firstLens = rows.find((row: any) => {
            const type = String(row?.['object type'] ?? row?.object ?? row?.type ?? '').trim().toLowerCase();
            return type !== 'object' && type !== 'image';
          }) || rows[1] || rows[0] || null;
          return {
            rowCount: rows.length,
            firstId: firstLens?.id ?? firstLens?._id ?? null,
            firstBlockId: firstLens?._blockId ?? null,
            firstRole: firstLens?._surfaceRole ?? null,
            firstRadius: firstLens?.['radius of curvature'] ?? firstLens?.radius ?? firstLens?.R ?? null,
            firstThickness: firstLens?.thickness ?? firstLens?.distance ?? null,
            firstMaterial: firstLens?.material ?? firstLens?.glass ?? null,
          };
        };

        const getDiagConfigFingerprintLocal = (cfg: any): any => {
          const activeId = String(cfg?.activeConfigId ?? '').trim();
          const active = Array.isArray(cfg?.configurations)
            ? (cfg.configurations.find((c: any) => String(c?.id ?? '') === activeId) || cfg.configurations[0])
            : null;
          const rows = Array.isArray(active?.opticalSystem)
            ? active.opticalSystem
            : (Array.isArray(active?.opticalSystemRows) ? active.opticalSystemRows : []);
          const firstBlock = Array.isArray(active?.blocks) ? active.blocks[0] : null;
          return {
            activeId,
            configCount: Array.isArray(cfg?.configurations) ? cfg.configurations.length : null,
            optical: getDiagRowsFingerprintLocal(rows),
            firstBlockId: firstBlock?.blockId ?? null,
            firstBlockType: firstBlock?.type ?? firstBlock?.blockType ?? null,
            firstBlockParams: firstBlock?.parameters ? {
              radius: firstBlock.parameters.radius ?? firstBlock.parameters.frontRadius ?? null,
              backRadius: firstBlock.parameters.backRadius ?? null,
              thickness: firstBlock.parameters.thickness ?? null,
              material: firstBlock.parameters.material ?? null,
            } : null,
          };
        };

        const logDoneApplyDiag = (label: string, extra: any = {}) => {
          try {
            if ((window as any).__COOPT_AL_DIAG !== true) return;
            const hostRows = typeof hostWindow.getOpticalSystemRows === 'function'
              ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem)
              : [];
            console.log('🩺 [AL-DIAG][done-apply]', {
              label,
              at: Date.now(),
              hostRows: getDiagRowsFingerprintLocal(hostRows),
              hostConfig: getDiagConfigFingerprintLocal(loadHostConfigSnapshot()),
              beforeRows: getDiagRowsFingerprintLocal(beforeHostRowsSnapshot),
              beforeConfig: getDiagConfigFingerprintLocal(beforeHostConfigSnapshot),
              requirementScore: getRequirementTableScoreSnapshot().score,
              extra,
            });
          } catch (_) {}
        };

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

        const getRequirementSnapshotScore = (snapshotRows: any[]): number => {
          try {
            if (!Array.isArray(snapshotRows) || snapshotRows.length === 0) return Number.NaN;
            let sum = 0;
            let count = 0;
            for (const row of snapshotRows) {
              const contribution = Number(row?.contribution ?? row?._contribution ?? row?.score);
              if (!Number.isFinite(contribution)) continue;
              if (contribution > 0) sum += contribution;
              count += 1;
            }
            return count > 0 && Number.isFinite(sum) ? sum : Number.NaN;
          } catch (_) {
            return Number.NaN;
          }
        };

        const optimizerRunner = {
          source: 'local-window',
          run: runOptimizationMVP,
        };

        let tsResult: any = null;
        try {
          publishRunConfigForOptimizerOnly(clickSnapshot?.config || frozenHostConfigForRun, systemRequirementsRows);
          tsResult = await optimizerRunner.run({
            opticalSystemRows: rows,
            sourceRows,
            objectRows,
            activeConfigId,
            systemRequirementsRows,
            method: optMethod,
            maxIterations,
            escapeGlobalMaxRestarts: maxEscapeLoops,
            escapeFunctionWidth: optEscapeFunctionWidth,
            escapeFunctionHeight: optEscapeFunctionHeight,
            preferNative: isTauriRuntime(),
            kktUseWasmPilotOptimizer: true,
            // Collect low-overhead timing counters for every local run.  The
            // detailed table stays out of the browser developer console; the
            // concise, non-overlapping-in-total cost summary is printed below.
            profile: true,
            profileConsole: false,
            shouldStop: () => !!(window as any).__cooptOptimizeStopRequested,
            onProgress: (ev: any) => {
            const phase = String(ev?.phase ?? 'running');
            const phaseLower = phase.toLowerCase();
            const elapsedMs = Math.max(0, Date.now() - optimizeConsoleStartedAtRef.current);
            const progressMethod = String(ev?.method ?? (optMethod || 'kkt')).trim().toLowerCase();
            const iter = Number(ev?.iter ?? 0);
            const requirementSnapshots = Array.isArray(ev?.requirementSnapshots) ? ev.requirementSnapshots : [];
            try {
              if (requirementSnapshots.length > 0) {
                const localReqEditor = w.systemRequirementsEditor;
                const hostReqEditor = hostWindow?.systemRequirementsEditor;
                if (localReqEditor && localReqEditor !== hostReqEditor && typeof localReqEditor.applyOptimizerRequirementSnapshot === 'function') {
                  localReqEditor.applyOptimizerRequirementSnapshot(requirementSnapshots);
                }
              }
            } catch (_) {}
            // Keep live progress local to this window. Updating the host Req/Render
            // during optimization creates competing state writers; final done/stop
            // snapshot application below is the only host-facing update path.
            const snap = getRequirementTableScoreSnapshot();
            const progressBestScore = Number(ev?.best);
            const snapshotScore = getRequirementSnapshotScore(requirementSnapshots);
            const eventRequirementScore = Number(ev?.requirementScore);
            const tableScore = Number(snap.score);
            // Only externally meaningful Requirement scores may reach the console.
            // KKT/SQP objective, merit, violation, and best values stay internal.
            const displayScore = Number.isFinite(eventRequirementScore)
              ? eventRequirementScore
              : (Number.isFinite(snapshotScore)
                ? snapshotScore
                : (phaseLower === 'start' && Number.isFinite(tableScore) ? tableScore : Number.NaN));
            const scorelessStart = phaseLower === 'start'
              && !Number.isFinite(eventRequirementScore)
              && !Number.isFinite(snapshotScore);
            const requirementDisplayScore = !scorelessStart && Number.isFinite(displayScore)
              ? displayScore
              : Number.NaN;

            if (phaseLower === 'initializing') {
              const candidate = Math.max(1, Math.floor(Number(ev?.candidate) || 1));
              const candidates = Math.max(candidate, Math.floor(Number(ev?.candidates) || candidate));
              const initializationStatus = String(ev?.status ?? '').trim().toLowerCase();
              const bestCandidate = Number(ev?.best);
              if (initializationStatus === 'start' && candidate === 1) {
                appendOptimizeConsoleLine(`[${formatOptimizeElapsed(elapsedMs)}] Initializing Qcon candidates 1/${candidates}...`);
              } else if (initializationStatus === 'progress') {
                const localIteration = Math.max(1, Math.floor(Number(ev?.localIteration) || 1));
                const localIterations = Math.max(localIteration, Math.floor(Number(ev?.localIterations) || localIteration));
                appendOptimizeConsoleLine(
                  `[${formatOptimizeElapsed(elapsedMs)}] Qcon candidate ${candidate}/${candidates}, local iteration ${localIteration}/${localIterations}`
                );
              } else if (initializationStatus === 'done') {
                const bestText = Number.isFinite(bestCandidate)
                  ? `  Best ${formatOptimizeConsoleCell(bestCandidate, 14, 6).trim()}`
                  : '';
                appendOptimizeConsoleLine(`[${formatOptimizeElapsed(elapsedMs)}] Initialized Qcon candidate ${candidate}/${candidates}${bestText}`);
              }
            }

            const dampingFactor = Number(
              ev?.dampingFactor ??
              ev?.lmDamp ??
              ev?.damping ??
              ev?.lambda ??
              ev?.stepScale ??
              Number.NaN
            );
            const rho = Number(ev?.rho ?? Number.NaN);
            const alpha = Number(ev?.alpha ?? Number.NaN);
            const consoleMin = Number.isFinite(progressBestScore)
              ? progressBestScore
              : requirementDisplayScore;
            const previousMin = optimizeConsolePrevMinRef.current;
            const improvement = calculateOptimizeConsoleImprovement(previousMin, consoleMin);
            const iterInt = Number.isFinite(iter) ? Math.max(0, Math.floor(iter)) : -1;
            const consoleIter = (progressMethod === 'kkt' || progressMethod === 'kkt-sqp') && phaseLower !== 'start'
              ? iterInt + 1
              : iterInt;
            const isConsoleProgressPhase = phaseLower === 'start'
              || phaseLower === 'iter'
              || phaseLower === 'kkt-iter';
            if (phaseLower === 'restart') {
              const reason = String(ev?.reason ?? 'optimizer-restart').trim();
              appendOptimizeConsoleLine(`[${formatOptimizeElapsed(elapsedMs)}] ${reason}`);
            }
            if (isConsoleProgressPhase
              && shouldAppendOptimizeConsoleRow(phaseLower, ev?.accepted, previousMin, consoleMin)
              && Number.isFinite(consoleMin)
              && consoleIter >= 0
              && consoleIter > optimizeConsoleLastIterRef.current) {
              if (!optimizeConsoleHeaderWrittenRef.current) {
                appendOptimizeConsoleHeader();
                optimizeConsoleHeaderWrittenRef.current = true;
              }
              appendOptimizeConsoleRow({
                iter: consoleIter,
                elapsedMs,
                min: consoleMin,
                damping: dampingFactor,
                rho,
                alpha,
                improv: improvement,
              });
              optimizeConsoleLastIterRef.current = consoleIter;
              if (Number.isFinite(consoleMin)) {
                optimizeConsolePrevMinRef.current = consoleMin;
              }
            }

            if (phaseLower === 'accept') tsAcceptCount += 1;
            if (phaseLower === 'reject') tsRejectCount += 1;
            const acceptedRows = Array.isArray(ev?.rows) ? ev.rows : [];
            if (optAutoRenderOnAccept
              && acceptedRows.length > 0
              && (phaseLower === 'accept' || ev?.accepted === true)) {
              const now = Date.now();
              if ((now - lastRenderSyncAt) >= RENDER_SYNC_MIN_INTERVAL_MS) {
                lastRenderSyncAt = now;
                requestRenderSync(acceptedRows);
              }
            }
            if (Number.isFinite(progressBestScore)) {
              tsBestScore = Math.min(tsBestScore, progressBestScore);
            }
            if (Number.isFinite(requirementDisplayScore)) {
              if (requirementDisplayScore < tsBestRequirementScore) {
                tsBestRequirementScore = requirementDisplayScore;
                tsBestRequirementSnapshot = requirementSnapshots.length > 0
                  ? (cloneJsonLocal(requirementSnapshots) || requirementSnapshots)
                  : tsBestRequirementSnapshot;
              }
            }

            if (phaseLower === 'done') {
              lastRenderSyncAt = Date.now();
            }

            const runningPercent = phaseLower === 'initializing'
              ? Math.round((Math.max(0, Number(ev?.candidate) || 0) / Math.max(1, Number(ev?.candidates) || 1)) * 100)
              : (maxIterations > 0 ? Math.round((Math.max(0, iter) / maxIterations) * 100) : 0);
            setOptimizeState((prev: any) => ({
              ...prev,
              status: 'running',
              phase,
              modeUsed: progressMethod || optMethod,
              iterations: iter,
              escapeLoop: Number.isFinite(Number(ev?.escapeLoop)) ? Number(ev.escapeLoop) : prev.escapeLoop,
              escapeLoops: Number.isFinite(Number(ev?.escapeLoops)) ? Number(ev.escapeLoops) : prev.escapeLoops,
              meritBefore: prev.meritBefore,
              meritAfter: Number.isFinite(requirementDisplayScore) ? requirementDisplayScore : prev.meritAfter,
              requirementScoreBefore: prev.requirementScoreBefore,
              requirementScoreAfter: Number.isFinite(requirementDisplayScore) ? requirementDisplayScore : prev.requirementScoreAfter,
              requirementScoreTable: Number.isFinite(requirementDisplayScore) ? requirementDisplayScore : prev.requirementScoreTable,
              acceptCount: tsAcceptCount,
              rejectCount: tsRejectCount,
              issue: '-',
              percent: Math.min(99, Math.max(0, runningPercent)),
              best: Number.isFinite(tsBestRequirementScore)
                ? tsBestRequirementScore
                : prev.best,
              bestRequirementScore: Number.isFinite(tsBestRequirementScore)
                ? tsBestRequirementScore
                : prev.bestRequirementScore,
            }));
            },
          });
        } finally {
          clearRunConfigForOptimizerOnly();
        }

        if (!tsResult || tsResult.ok !== true) {
          throw new Error(`[${optimizerRunner.source}] ${String(tsResult?.reason || 'TS/WASM optimizer returned non-ok result')}`);
        }

        const tsIterations = Number(tsResult?.iterations ?? NaN);
        const tsAborted = !!(tsResult?.aborted || (window as any).__cooptOptimizeStopRequested);
        // Stop 時は iterations=0 でも正常系として扱い、Best 復元・同期処理を継続する。
        if ((!Number.isFinite(tsIterations) || tsIterations <= 0) && !tsAborted) {
          throw new Error(`TS/WASM optimizer produced no iterations (iterations=${String(tsResult?.iterations)})`);
        }

        // Timers are intentionally reported as individual (and potentially
        // nested) measurements.  They identify which work dominates a run,
        // without falsely implying that the values can be added together.
        try {
          const profile = (w as any)?.OptimizationMVP?.getLastProfile?.();
          const profileStartedAt = Number(profile?.startedAt);
          const runStartedAt = Number(optimizeConsoleStartedAtRef.current);
          if (profile && (!Number.isFinite(profileStartedAt) || profileStartedAt >= runStartedAt - 1000)) {
            const counts = profile?.counts || {};
            const asInt = (value: any) => Math.max(0, Math.floor(Number(value) || 0));
            const asSeconds = (value: any) => `${(Math.max(0, Number(value) || 0) / 1000).toFixed(1)}s`;
            const totalMs = Number(profile?.totalMs);
            const fdMs = Number(counts?.kktFiniteDiffJacobianMs);
            const mtfMs = Number(counts?.kktMtfBatchMs);
            const fdCalls = asInt(counts?.kktFiniteDiffJacobianCalls);
            const fdColumns = asInt(counts?.kktFiniteDiffColumnsEffective || counts?.kktFiniteDiffColumns);
            const candidateEvals = asInt(counts?.kktCandidateEvalCount);
            const mtfCalls = asInt(counts?.kktMtfBatchCalls);
            const mtfJobs = asInt(counts?.kktMtfBatchJobs);
            const workerPoolCalls = asInt(counts?.kktMtfWorkerPoolCalls);
            const workers = asInt(counts?.kktMtfWorkerPoolWorkers);
            const sharedBatches = asInt(counts?.kktMtfWorkerSharedBatches);
            const accepted = asInt(counts?.kktAcceptedSteps);
            const rejected = asInt(counts?.kktRejectedSteps);
            const backtracks = asInt(counts?.kktLineSearchBacktracks);
            appendOptimizeConsoleLine(
              `[Cost] total ${asSeconds(totalMs)} | FD Jacobian ${asSeconds(fdMs)} (${fdCalls}x, ${fdColumns} cols) `
              + `| MTF ${asSeconds(mtfMs)} (${mtfCalls} batches, ${mtfJobs} jobs, pool ${workerPoolCalls}x/${workers}, shared ${sharedBatches}) `
              + `| trial ${candidateEvals}, accept/reject ${accepted}/${rejected}, backtrack ${backtracks}`
            );
          }
        } catch (_) {}

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
          const cloned = injectActiveOpticalRows(snapshot, Array.isArray(rowsSnapshot) ? rowsSnapshot : []);
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

        const extractRowsFromConfigSnapshot = (cfg: any, directRows: any[] = []): any[] => {
          const expander = hostWindow?.expandBlocksToOpticalSystemRows || w?.expandBlocksToOpticalSystemRows;
          return selectCanonicalOptimizedRows(cfg, directRows, expander);
        };

        const resultConfigSnapshot = tsResult?.systemConfigSnapshot && typeof tsResult.systemConfigSnapshot === 'object'
          ? (cloneJsonLocal(tsResult.systemConfigSnapshot) || tsResult.systemConfigSnapshot)
          : null;
        const resultRowsDirect = Array.isArray(tsResult?.opticalSystemRowsSnapshot)
          ? (cloneJsonLocal(tsResult.opticalSystemRowsSnapshot) || tsResult.opticalSystemRowsSnapshot)
          : [];
        const resultRowsFromBlocks = extractRowsFromConfigSnapshot(resultConfigSnapshot, resultRowsDirect);
        const resultRowsSnapshot = Array.isArray(resultRowsFromBlocks) && resultRowsFromBlocks.length > 0
          ? resultRowsFromBlocks
          : resultRowsDirect;

        try {
          if ((window as any).__COOPT_AL_DIAG !== true) throw new Error('AL diag disabled');
          const __diagCfgArr = resultConfigSnapshot && Array.isArray(resultConfigSnapshot.configurations)
            ? resultConfigSnapshot.configurations
            : null;
          console.log('🩺 [AL-DIAG] App.tsx tsResult snapshot', {
            tsResultBest: Number((tsResult as any)?.best),
            tsResultObjective: Number((tsResult as any)?.objectiveScore),
            hasResultConfigSnapshot: !!resultConfigSnapshot,
            configCount: __diagCfgArr ? __diagCfgArr.length : null,
            resultRowsSnapshotCount: Array.isArray(resultRowsSnapshot) ? resultRowsSnapshot.length : null,
            firstRowRadius: Array.isArray(resultRowsSnapshot) && resultRowsSnapshot.length > 1
              ? (resultRowsSnapshot[1] as any)?.['radius of curvature']
              : null,
          });
        } catch (_) {}

        let hostResultSnapshotApplied = false;
        if (resultConfigSnapshot) {
          logDoneApplyDiag('before-applyHostSystemConfigSnapshot', {
            resultRows: getDiagRowsFingerprintLocal(resultRowsSnapshot),
            resultConfig: getDiagConfigFingerprintLocal(resultConfigSnapshot),
          });
          hostResultSnapshotApplied = !!(await applyHostSystemConfigSnapshot(resultConfigSnapshot, resultRowsSnapshot));
          logDoneApplyDiag('after-applyHostSystemConfigSnapshot', {
            hostResultSnapshotApplied,
            resultRows: getDiagRowsFingerprintLocal(resultRowsSnapshot),
          });
        }

        const committedRowsSnapshot = Array.isArray(resultRowsSnapshot) && resultRowsSnapshot.length > 0
          ? (cloneJsonLocal(resultRowsSnapshot) || resultRowsSnapshot)
          : [];

        const finalizeHostResultSnapshot = async (reason: string) => {
          try {
            if (resultConfigSnapshot) {
              logDoneApplyDiag(`before-finalizeHostResultSnapshot:${reason}`, {
                resultRows: getDiagRowsFingerprintLocal(committedRowsSnapshot),
                resultConfig: getDiagConfigFingerprintLocal(resultConfigSnapshot),
              });
              await applyHostSystemConfigSnapshot(resultConfigSnapshot, committedRowsSnapshot);
              logDoneApplyDiag(`after-finalizeHostResultSnapshot:${reason}`, {
                resultRows: getDiagRowsFingerprintLocal(committedRowsSnapshot),
              });
              return;
            }
            if (Array.isArray(committedRowsSnapshot) && committedRowsSnapshot.length > 0) {
              const rows = cloneJsonLocal(committedRowsSnapshot) || committedRowsSnapshot;
              const table = hostWindow.tableOpticalSystem;
              const previousDepth = Number(hostWindow.__suppressOpticalSystemDataChangedDepth || 0);
              try {
                hostWindow.__suppressOpticalSystemDataChangedDepth = previousDepth + 1;
                hostWindow.__suppressOpticalSystemDataChanged = true;
                if (table && typeof table.replaceData === 'function') {
                  await Promise.resolve(table.replaceData(rows));
                } else if (table && typeof table.setData === 'function') {
                  await Promise.resolve(table.setData(rows));
                }
                if (typeof hostWindow.__cooptSyncRowsBackToActiveBlocks === 'function') {
                  hostWindow.__cooptSyncRowsBackToActiveBlocks(rows);
                }
              } finally {
                try {
                  setTimeout(() => {
                    hostWindow.__suppressOpticalSystemDataChangedDepth = previousDepth;
                    hostWindow.__suppressOpticalSystemDataChanged = previousDepth > 0;
                  }, 50);
                } catch (_) {
                  hostWindow.__suppressOpticalSystemDataChangedDepth = previousDepth;
                  hostWindow.__suppressOpticalSystemDataChanged = previousDepth > 0;
                }
              }
              logDoneApplyDiag(`after-finalizeHostRows:${reason}`, {
                resultRows: getDiagRowsFingerprintLocal(committedRowsSnapshot),
              });
            }
          } catch (_) {}
          try { requestRefreshBlockInspector(hostWindow); } catch (_) {}
          try { if (typeof hostWindow.refreshAllUI === 'function') hostWindow.refreshAllUI(); } catch (_) {}
          try { if (typeof hostWindow.drawOpticalSystem === 'function') hostWindow.drawOpticalSystem(); } catch (_) {}
        };

        try {
          if ((window as any).__COOPT_AL_DIAG !== true) throw new Error('AL diag disabled');
          const __diagHostRows = hostWindow.getOpticalSystemRows
            ? hostWindow.getOpticalSystemRows(hostWindow.tableOpticalSystem)
            : [];
          console.log('🩺 [AL-DIAG] App.tsx host rows after apply', {
            hostRowCount: Array.isArray(__diagHostRows) ? __diagHostRows.length : null,
            hostFirstRowRadius: Array.isArray(__diagHostRows) && __diagHostRows.length > 1
              ? (__diagHostRows[1] as any)?.['radius of curvature']
              : null,
          });
        } catch (_) {}

        if (tsAborted) {
          try { localStorage.removeItem(OPTIMIZE_PROGRESS_SYNC_KEY); } catch (_) {}
          try { localStorage.removeItem(optimizeRowsSyncKey); } catch (_) {}
        }

        let afterHostConfigSnapshot: any = null;
        let afterHostRowsSnapshot: any[] = [];
        try {
          afterHostConfigSnapshot = resultConfigSnapshot
            ? injectActiveOpticalRows(resultConfigSnapshot, resultRowsSnapshot)
            : loadHostConfigSnapshot();
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
            const latestRowsBeforeReload = Array.isArray(committedRowsSnapshot) && committedRowsSnapshot.length > 0
              ? (cloneJsonLocal(committedRowsSnapshot) || committedRowsSnapshot)
              : [];
            if (Array.isArray(latestRowsBeforeReload) && latestRowsBeforeReload.length > 0) {
              const finalizeRowsFn = hostWindow.__cooptRefreshRequirementTableScoreForOptimize;
              if (typeof finalizeRowsFn === 'function') {
                logDoneApplyDiag('before-optimize-finished-finalize', {
                  latestRowsBeforeReload: getDiagRowsFingerprintLocal(latestRowsBeforeReload),
                });
                await finalizeRowsFn(latestRowsBeforeReload, 'optimize-finished-finalize', { syncBlocks: true });
                logDoneApplyDiag('after-optimize-finished-finalize', {
                  latestRowsBeforeReload: getDiagRowsFingerprintLocal(latestRowsBeforeReload),
                });
              }
            }

            logDoneApplyDiag('before-optimize-finished-reload', {
              latestRowsBeforeReload: getDiagRowsFingerprintLocal(latestRowsBeforeReload),
            });
            await syncHostDesignIntentAndRequirements(
              hostWindow,
              'optimize-finished-reload',
              'after',
              Array.isArray(latestRowsBeforeReload) ? latestRowsBeforeReload : []
            );
            logDoneApplyDiag('after-optimize-finished-reload', {
              latestRowsBeforeReload: getDiagRowsFingerprintLocal(latestRowsBeforeReload),
            });

            const rowsAfter = Array.isArray(committedRowsSnapshot) && committedRowsSnapshot.length > 0
              ? (cloneJsonLocal(committedRowsSnapshot) || committedRowsSnapshot)
              : [];
            if (Array.isArray(rowsAfter) && rowsAfter.length > 0) {
              renderSyncQueue.length = 0;
              const pendingRenderSync = renderSyncDrainPromise;
              if (pendingRenderSync) await pendingRenderSync;
              await performRenderSync(rowsAfter, { finalizeAutoSemidia: true, force: true });
              const applyToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
              const applyCreatedAt = Date.now();
              const shouldBroadcastRowsSync = true;
              logDoneApplyDiag('before-optimizeRowsSync-setItem', {
                applyToken,
                shouldBroadcastRowsSync,
                hostResultSnapshotApplied,
                rowsAfter: getDiagRowsFingerprintLocal(rowsAfter),
                afterConfig: getDiagConfigFingerprintLocal(afterHostConfigSnapshot),
                afterRows: getDiagRowsFingerprintLocal(afterHostRowsSnapshot),
              });
              if (shouldBroadcastRowsSync) {
                localStorage.setItem(optimizeRowsSyncKey, JSON.stringify({
                  rows: rowsAfter,
                  token: applyToken,
                  createdAt: applyCreatedAt,
                  senderId: getOrCreateCooptWindowSyncSenderId(),
                  best: Number(tsResult?.best),
                  objectiveScore: Number(tsResult?.objectiveScore),
                  syncBlocks: true,
                  afterConfigSnapshot: afterHostConfigSnapshot,
                  afterRowsSnapshot: afterHostRowsSnapshot,
                }));
                logDoneApplyDiag('after-optimizeRowsSync-setItem', { applyToken });
              } else {
                try { localStorage.removeItem(optimizeRowsSyncKey); } catch (_) {}
                logDoneApplyDiag('skip-optimizeRowsSync-setItem', { applyToken, hostResultSnapshotApplied });
              }
              try {
                const mod = await import('@tauri-apps/api/event');
                if (shouldBroadcastRowsSync && mod && typeof (mod as any).emit === 'function') {
                  await (mod as any).emit('coopt-optimize-rows-sync', {
                    rows: rowsAfter,
                    token: applyToken,
                    createdAt: applyCreatedAt,
                    senderId: getOrCreateCooptWindowSyncSenderId(),
                    best: Number(tsResult?.best),
                    objectiveScore: Number(tsResult?.objectiveScore),
                    syncBlocks: true,
                    afterConfigSnapshot: afterHostConfigSnapshot,
                    afterRowsSnapshot: afterHostRowsSnapshot,
                  });
                  logDoneApplyDiag('after-tauri-optimize-rows-sync-emit', { applyToken });
                }
              } catch (_) {}
            }
          } catch (_) {}

          try {
            const latestRows = Array.isArray(committedRowsSnapshot) && committedRowsSnapshot.length > 0
              ? (cloneJsonLocal(committedRowsSnapshot) || committedRowsSnapshot)
              : [];
            logDoneApplyDiag('before-optimize-finished-sync', {
              latestRows: getDiagRowsFingerprintLocal(latestRows),
            });
            await syncHostDesignIntentAndRequirements(
              hostWindow,
              'optimize-finished-sync',
              'after',
              Array.isArray(latestRows) ? latestRows : []
            );
            logDoneApplyDiag('after-optimize-finished-sync', {
              latestRows: getDiagRowsFingerprintLocal(latestRows),
            });
          } catch (_) {}

          await finalizeHostResultSnapshot('after-done-sync');
        }

        let finalTableScore = Number.NaN;
        if (!tsAborted) {
          try {
            const sre = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
            if (sre && typeof sre.evaluateAndUpdateNow === 'function') {
              logDoneApplyDiag('before-optimize-final-score-eval');
              const p = sre.evaluateAndUpdateNow({ reason: 'optimize-final-score', forceSilent: true, silent: true });
              if (p && typeof (p as any).then === 'function') {
                await p;
              }
              logDoneApplyDiag('after-optimize-final-score-eval');
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

            if (
              Array.isArray(tsBestRequirementSnapshot)
              && tsBestRequirementSnapshot.length > 0
              && sre
              && typeof sre.applyOptimizerRequirementSnapshot === 'function'
            ) {
              logDoneApplyDiag('before-apply-best-requirement-snapshot', {
                bestRequirementScore: tsBestRequirementScore,
                snapshotRows: Array.isArray(tsBestRequirementSnapshot) ? tsBestRequirementSnapshot.length : 0,
              });
              const appliedBestRequirementSnapshot = !!sre.applyOptimizerRequirementSnapshot(tsBestRequirementSnapshot);
              logDoneApplyDiag('after-apply-best-requirement-snapshot', {
                appliedBestRequirementSnapshot,
                bestRequirementScore: tsBestRequirementScore,
              });
              if (appliedBestRequirementSnapshot) {
                const bestScoreForLock = Number.isFinite(tsBestRequirementScore)
                  ? tsBestRequirementScore
                  : Number.NaN;
                try {
                  hostWindow.__cooptOptimizeBestRequirementSnapshotApplied = {
                    at: Date.now(),
                    score: bestScoreForLock,
                    source: 'optimize-done-best-snapshot',
                  };
                } catch (_) {}
                try {
                  w.__cooptOptimizeBestRequirementSnapshotApplied = {
                    at: Date.now(),
                    score: bestScoreForLock,
                    source: 'optimize-done-best-snapshot',
                  };
                } catch (_) {}
              }
            }
          } catch (_) {}
        }

        const pickBestFiniteMin = (...values: number[]) => {
          let best = Number.NaN;
          for (const value of values) {
            if (!Number.isFinite(value)) continue;
            best = Number.isFinite(best) ? Math.min(best, value) : value;
          }
          return best;
        };

        const abortedTrackedBest = pickBestFiniteMin(tsBestRequirementScore, finalTableScore);

        if (tsAborted && Number.isFinite(abortedTrackedBest)) {
          finalTableScore = abortedTrackedBest;
        }

        await finalizeHostResultSnapshot(tsAborted ? 'after-stop-score' : 'after-done-score');

        try {
          const sre = hostWindow.systemRequirementsEditor || w.systemRequirementsEditor;
          if (
            Array.isArray(tsBestRequirementSnapshot)
            && tsBestRequirementSnapshot.length > 0
            && sre
            && typeof sre.applyOptimizerRequirementSnapshot === 'function'
          ) {
            logDoneApplyDiag('before-final-apply-best-requirement-snapshot', {
              tsAborted,
              bestRequirementScore: tsBestRequirementScore,
              snapshotRows: tsBestRequirementSnapshot.length,
            });
            const appliedBestRequirementSnapshot = !!sre.applyOptimizerRequirementSnapshot(tsBestRequirementSnapshot);
            logDoneApplyDiag('after-final-apply-best-requirement-snapshot', {
              tsAborted,
              appliedBestRequirementSnapshot,
              bestRequirementScore: tsBestRequirementScore,
            });
            if (appliedBestRequirementSnapshot) {
              const bestScoreForLock = Number.isFinite(tsBestRequirementScore)
                ? tsBestRequirementScore
                : Number.NaN;
              try {
                hostWindow.__cooptOptimizeBestRequirementSnapshotApplied = {
                  at: Date.now(),
                  score: bestScoreForLock,
                  source: tsAborted ? 'optimize-stop-final-best-snapshot' : 'optimize-done-final-best-snapshot',
                };
              } catch (_) {}
              try {
                w.__cooptOptimizeBestRequirementSnapshotApplied = {
                  at: Date.now(),
                  score: bestScoreForLock,
                  source: tsAborted ? 'optimize-stop-final-best-snapshot' : 'optimize-done-final-best-snapshot',
                };
              } catch (_) {}
            }
          }
        } catch (_) {}

        const doneTrackedBestRequirementScore = pickBestFiniteMin(tsBestRequirementScore, finalTableScore);

        const finalScore = tsAborted
          ? abortedTrackedBest
          : (Number.isFinite(doneTrackedBestRequirementScore)
            ? doneTrackedBestRequirementScore
            : (Number.isFinite(finalTableScore)
              ? finalTableScore
              : Number.NaN));
        const finalBest = tsAborted
          ? abortedTrackedBest
          : (Number.isFinite(tsBestRequirementScore)
            ? tsBestRequirementScore
            : (Number.isFinite(finalTableScore)
              ? finalTableScore
              : finalScore));

        try {
          if ((window as any).__COOPT_AL_DIAG === true) {
            console.log('🩺 [AL-DIAG] done score aggregation', {
              tsAborted,
              tsBestRequirementScore,
              finalTableScore,
              doneTrackedBestRequirementScore,
              finalScore,
              finalBest,
            });
          }
        } catch (_) {}
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
          requirementScoreTable: Number.isFinite(finalScore)
            ? finalScore
            : (Number.isFinite(finalTableScore) ? finalTableScore : prev.requirementScoreTable),
          meritAfter: Number.isFinite(finalScore) ? finalScore
            : (Number.isFinite(finalTableScore) ? finalTableScore : prev.meritAfter),
          best: Number.isFinite(finalBest) ? finalBest : prev.best,
          bestRequirementScore: aborted
            ? (Number.isFinite(finalBest)
              ? finalBest
              : (Number.isFinite(finalScore) ? finalScore : prev.bestRequirementScore))
            : (Number.isFinite(tsBestRequirementScore)
              ? tsBestRequirementScore
              : (Number.isFinite(finalTableScore)
                ? finalTableScore
                : (Number.isFinite(finalScore) ? finalScore : prev.bestRequirementScore))),
          percent: aborted
            ? Math.min(99, Math.max(0, Number(prev.percent) || 0))
            : 100,
        }));

      } catch (tsErr) {
        setOptimizeState((prev: any) => ({
          ...prev,
          status: 'error',
          phase: 'error',
          issue: (tsErr as any)?.message || String(tsErr),
          percent: Math.min(99, Math.max(0, Number(prev.percent) || 0)),
        }));
      } finally {
        try {
          delete w.__cooptPreferRuntimeSystemConfig;
          delete w.__cooptSystemConfig;
          delete w.__cooptDeferDerivedUiUntil;
        } catch (_) {}
        try {
          if (hostWindow) {
            delete hostWindow.__cooptPreferRuntimeSystemConfig;
            delete hostWindow.__cooptSystemConfig;
            delete hostWindow.__cooptDeferDerivedUiUntil;
          }
        } catch (_) {}
        const activeSleepBlockToken = optimizeDisplaySleepBlockTokenRef.current;
        optimizeDisplaySleepBlockTokenRef.current = null;
        if (activeSleepBlockToken) {
          try { await stopPreventDisplaySleep(activeSleepBlockToken); } catch (_) {}
        }
        try { await releaseOptimizeWakeLock(); } catch (_) {}
        try { await clearOptimizerStop(); } catch (_) {}
        if (!isTauriRuntime()) {
          try { await releaseWebOptimizerWorkerResources(); } catch (_) {}
        }
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
          const optimizationEndedAt = Date.now();
          const cleanupTargets = new Set<any>([w, window, hostWindow]);
          try { cleanupTargets.add(hostWindow?.popup3DWindow); } catch (_) {}
          try {
            cleanupTargets.add(hostWindow?.document?.querySelector?.('iframe[title="Render"]')?.contentWindow);
          } catch (_) {}
          for (const target of cleanupTargets) {
            if (!target || target.closed) continue;
            target.__cooptLastOptimizationSyncAt = optimizationEndedAt;
            target.__cooptOptimizerIsRunning = false;
            target.__cooptOptimizeStopRequested = false;
            target.__cooptOpticalSystemRowsOverride = null;
            target.__cooptDrawCrossLastData = null;
            target.__cooptDrawCrossInFlight = false;
            try { delete target.__cooptRenderSyncLease; } catch (_) {}
          }
        } catch (_) {}
      }
    };

    const exportEscapeSnapshots = async () => {
      try {
        const w = window as any;
        const hostWindow = getOptimizeHostWindow();
        const candidates = [w, hostWindow, w?.opener];
        let exporter: any = null;
        for (const candidate of candidates) {
          if (!candidate || candidate.closed) continue;
          const opt = candidate.OptimizationMVP;
          if (opt && typeof opt.exportEscapeSnapshotsArchive === 'function') {
            exporter = opt.exportEscapeSnapshotsArchive.bind(opt);
            break;
          }
        }

        if (!exporter) {
          setOptimizeState((prev: any) => ({
            ...prev,
            issue: 'Export unavailable: OptimizationMVP.exportEscapeSnapshotsArchive not found',
          }));
          return;
        }

        const out = await exporter({ download: true });
        const count = Number(out?.count) || 0;
        const fileName = String(out?.fileName || 'escape-snapshots-archive.json');
        setOptimizeState((prev: any) => ({
          ...prev,
          issue: `Exported ${count} snapshots: ${fileName}`,
        }));
      } catch (err) {
        setOptimizeState((prev: any) => ({
          ...prev,
          issue: `Export failed: ${(err as any)?.message || String(err)}`,
        }));
      }
    };

    const requestOptimizeStop = () => {
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
    };

    const optimizeDisplayScore = Number.isFinite(Number(optimizeState?.requirementScoreTable))
      ? Number(optimizeState.requirementScoreTable)
      : (Number.isFinite(Number(optimizeState?.requirementScoreAfter))
        ? Number(optimizeState.requirementScoreAfter)
        : (Number.isFinite(Number(optimizeState?.meritAfter)) ? Number(optimizeState.meritAfter) : Number.NaN));
    const optimizeDisplayBest = Number.isFinite(Number(optimizeState?.bestRequirementScore))
      ? Number(optimizeState.bestRequirementScore)
      : (Number.isFinite(Number(optimizeState?.best)) ? Number(optimizeState.best) : Number.NaN);
    const optimizeEscapeLoopLabel = (() => {
      const loop = Number(optimizeState?.escapeLoop);
      if (Number.isFinite(loop) && loop > 0) {
        return `${Math.max(0, Math.floor(loop))}`;
      }
      return '-';
    })();
    const optimizePhase = String(optimizeState?.phase || '-');
    const optimizeDecision = optimizeState?.phase === 'accept'
      ? 'ACCEPT'
      : (optimizeState?.phase === 'reject' ? 'REJECT' : '-');
    const optimizeStatusLabel = optimizeHasTerminalStatus
      ? optimizeStateStatus
      : (optStopRequested && optRunning ? 'Stopping' : (optRunning ? 'Running' : optimizeStateStatus));
    const optimizeStatusClass = optimizeHasTerminalStatus
      ? (/error|fail/i.test(optimizeStatusLabel) ? ' is-error' : (optimizeHasDoneStatus ? ' is-complete' : ''))
      : (optRunning ? ' is-running' : '');
    const usesEscapeLoops = optMethod === 'global-al' || optMethod === 'global-lm';

    return (
      <div className="optimize-progress-page">
        <header className="optimize-progress-header">
          <div className="optimize-progress-heading">
            <div>
              <div className="optimize-progress-eyebrow">Optimizer</div>
              <h1>Optimize Progress</h1>
            </div>
            <span className={`optimize-progress-status${optimizeStatusClass}`}>{optimizeStatusLabel}</span>
          </div>
          <div className="optimize-progress-track-row">
            <div
              className="optimize-progress-track"
              role="progressbar"
              aria-label="Optimization progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
            >
              <div className="optimize-progress-track-value" style={{ width: `${percent}%` }} />
            </div>
            <span className="optimize-progress-percent">{Math.round(percent)}%</span>
          </div>
        </header>

        <div className="optimize-progress-actions">
          <div className="optimize-progress-action-group">
            <button type="button" className="optimize-progress-button is-primary" disabled={optRunning} onClick={() => { void runOptimize(); }}>Run</button>
            <button type="button" className="optimize-progress-button is-danger" disabled={!optRunning} onClick={requestOptimizeStop}>Stop</button>
          </div>
          <button type="button" className="optimize-progress-button" disabled={optRunning} onClick={() => { void exportEscapeSnapshots(); }}>Export Snapshots</button>
        </div>

        <section className="optimize-progress-card" aria-labelledby="optimize-run-settings-title">
          <div className="optimize-progress-card-header">
            <h2 id="optimize-run-settings-title">Run settings</h2>
            <span>Locked while optimization is running</span>
          </div>
          <div className="optimize-progress-settings-grid">
            <label className="optimize-progress-field is-wide">
              <span>Method</span>
              <select value={optMethod} disabled={optRunning} onChange={(e) => setOptMethod((e.target.value as 'kkt-sqp' | 'kkt' | 'lm' | 'cd' | 'global-al' | 'global-lm'))}>
                <option value="kkt-sqp">KKT-SQP</option>
                <option value="kkt">AL + Gauss-Newton</option>
                <option value="global-al">Global AL + Gauss-Newton (Escape Function)</option>
                <option value="global-lm">Global LM (LM + Escape Function)</option>
                <option value="lm">Levenberg-Marquardt (LM)</option>
                <option value="cd">Coordinate Descent (CD)</option>
              </select>
            </label>
            <label className="optimize-progress-field">
              <span>Max iterations</span>
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
              />
            </label>
            <label className="optimize-progress-field">
              <span>Max escape loops (Global only)</span>
              <input
                type="number"
                min={1}
                step={1}
                value={optMaxEscapeLoops}
                disabled={optRunning || !usesEscapeLoops}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setOptMaxEscapeLoops(Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1);
                }}
              />
            </label>
            <label className="optimize-progress-field">
              <span>Escape width (W)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={optEscapeFunctionWidth}
                disabled={optRunning}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setOptEscapeFunctionWidth(Number.isFinite(n) ? n : 1);
                }}
              />
            </label>
            <label className="optimize-progress-field">
              <span>Escape height (H)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={optEscapeFunctionHeight}
                disabled={optRunning}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setOptEscapeFunctionHeight(Number.isFinite(n) ? n : 0.1);
                }}
              />
            </label>
            <label className="optimize-progress-toggle is-wide">
              <input type="checkbox" checked={optAutoRenderOnAccept} disabled={optRunning} onChange={(e) => setOptAutoRenderOnAccept(!!e.target.checked)} />
              <span>
                <strong>Auto-render accepted steps</strong>
                <small>Refresh the optical view after each accepted update.</small>
              </span>
            </label>
          </div>
        </section>

        <section className="optimize-progress-metrics" aria-label="Optimization summary">
          <div className="optimize-progress-metric"><span>Iteration</span><strong>{String(optimizeState?.iterations ?? 0)}</strong></div>
          <div className="optimize-progress-metric"><span>Score</span><strong>{Number.isFinite(optimizeDisplayScore) ? optimizeDisplayScore.toFixed(6) : '-'}</strong></div>
          <div className="optimize-progress-metric"><span>Best</span><strong>{Number.isFinite(optimizeDisplayBest) ? optimizeDisplayBest.toFixed(6) : '-'}</strong></div>
          <div className="optimize-progress-metric"><span>Accept / Reject</span><strong>{`${Number(optimizeState?.acceptCount || 0)} / ${Number(optimizeState?.rejectCount || 0)}`}</strong></div>
        </section>

        <section className="optimize-progress-card" aria-labelledby="optimize-run-details-title">
          <div className="optimize-progress-card-header">
            <h2 id="optimize-run-details-title">Run details</h2>
          </div>
          <dl className="optimize-progress-details">
            <div><dt>Phase</dt><dd>{optimizePhase}</dd></div>
            <div><dt>Decision</dt><dd>{optimizeDecision}</dd></div>
            <div><dt>Escape loop</dt><dd>{optimizeEscapeLoopLabel}</dd></div>
            <div><dt>Variables</dt><dd>{String(optimizeState?.variableCount ?? 0)}</dd></div>
            <div><dt>Requirements</dt><dd>{String(optimizeState?.requirementCount ?? '-')}</dd></div>
            <div className="is-wide"><dt>Issue</dt><dd>{String(optimizeState?.issue || '-')}</dd></div>
          </dl>
        </section>
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
        <div className="analysis-window-page analysis-window-page--system-data">
          <div className="analysis-window-result">
            <SystemDataPanel visible />
          </div>
        </div>
        <div style={{ display: 'none' }}>
          <MainToolbar />
          <ConfigurationSection />
          <SourceObjectSection />
          <DesignIntentSection hideTable />
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
          pointCount: astigPointCount,
          rayCount: astigRayCount,
          ringCount: astigRingCount,
          focusRange: astigFocusRange,
          requireRustWasm: true,
          forceWasmInTauri: true,
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
      <div className="analysis-window-page">
        <div className="analysis-window-commandbar">
          <label className="analysis-window-field" htmlFor="analysis-astig-chief-ray"><span>Chief ray</span>
          <select
            id="analysis-astig-chief-ray"
            value={astigChiefRayDefinition}
            onChange={(e) => setAstigChiefRayDefinition(e.target.value)}
          >
            <option value="stop-center">Stop center</option>
            <option value="beam-midpoint">Beam midpoint</option>
            <option value="beam-centroid">Beam centroid</option>
          </select>
          </label>
          <label className="analysis-window-field" htmlFor="analysis-astig-beam-pattern"><span>Pupil pattern</span>
          <select
            id="analysis-astig-beam-pattern"
            value={astigBeamPattern}
            onChange={(e) => setAstigBeamPattern(e.target.value as 'cross' | 'grid' | 'annular')}
          >
            <option value="cross">Cross</option>
            <option value="grid">Grid</option>
            <option value="annular">Annular</option>
          </select>
          </label>
          <details className="analysis-window-options">
            <summary>Options</summary>
            <div className="analysis-window-options__panel">
              <AnalysisRayCountField
                id="analysis-astig-ray-count"
                value={astigRayCount}
                min={9}
                max={2001}
                onValueChange={(value) => {
                  const parsed = Number(value);
                  if (!Number.isFinite(parsed)) return;
                  setAstigRayCount(Math.max(9, Math.min(2001, Math.round(parsed))));
                }}
              />
              <label className="analysis-window-field" htmlFor="analysis-astig-point-count"><span>Field samples</span>
                <input
                  id="analysis-astig-point-count"
                  type="number"
                  min={2}
                  max={201}
                  step={1}
                  value={astigPointCount}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    if (!Number.isFinite(parsed)) return;
                    setAstigPointCount(Math.max(2, Math.min(201, Math.round(parsed))));
                  }}
                />
              </label>
              {astigBeamPattern === 'annular' && (
              <label className="analysis-window-field" htmlFor="analysis-astig-ring-count"><span>Rings</span>
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
                  setAstigRingCount(Math.max(1, Math.min(1024, Math.round(parsed))));
                }}
              />
              </label>
              )}
              <label className="analysis-window-field" htmlFor="analysis-astig-focus-range"><span>Focus range ± mm</span>
                <input
                  id="analysis-astig-focus-range"
                  type="number"
                  min={0}
                  step={0.01}
                  value={astigFocusRange}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    if (!Number.isFinite(parsed)) return;
                    setAstigFocusRange(Math.max(0, parsed));
                  }}
                />
              </label>
            </div>
          </details>
          <button
            type="button"
            className="analysis-window-primary-action"
            onClick={rerenderAstigmatism}
            disabled={astigBusy}
          >
            {astigBusy ? 'Rendering...' : 'Show'}
          </button>
          <span className={`analysis-window-status${astigStatus.startsWith('Astigmatism error:') ? ' is-error' : ''}`}>
            {astigStatus || ''}
          </span>
        </div>
        {(astigBusy || !!astigProgressText) && (
          <div className="analysis-window-progress">
            <div className="analysis-window-progress__label">
              <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 40 }}>{Math.round(astigProgress)}%</span>
              <span>{astigProgressText || 'Calculating...'}</span>
            </div>
            <div className="analysis-window-progress__track">
              <div
                className="analysis-window-progress__value"
                style={{ width: `${astigProgress}%` }}
              />
            </div>
          </div>
        )}
        <div id="analysis-astig-container" className="analysis-window-canvas" />
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
          <DesignIntentSection hideTable />
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

    const handleExportCad = async () => {
      try {
        const w = window as any;
        const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
        if (!scene) {
          throw new Error('Render scene is not ready. Press Render first.');
        }

        const native = isTauriRuntime();
        setRenderWindowStatus(renderExportFormat === 'fcstd' ? 'Generating FreeCAD document...' : 'Generating STL...');
        const opticalSystemRows = typeof w.getOpticalSystemRows === 'function'
          ? w.getOpticalSystemRows(w.tableOpticalSystem)
          : [];
        const solid = renderExportFormat !== 'surface-stl';
        const result = generateOpticalSceneStl(scene, {
          binary: renderExportFormat !== 'fcstd' && !native,
          opticalSystemRows,
          solid,
        });
        const loaded = String(getLoadedFileName() ?? '')
          .replace(/\s*\(surfaces only\)\s*$/i, '')
          .replace(/\.(json|zmx)$/i, '')
          .trim();
        const baseName = loaded || 'co-opt-render';

        if (renderExportFormat === 'fcstd') {
          if (!native) {
            const exported = await generateFreeCadDocument(result.solidMeshes, baseName);
            downloadFreeCadDocument(exported.data, `${baseName}.FCStd`);
            setRenderWindowStatus(`FreeCAD exported: ${exported.solidCount} solids, ${exported.triangleCount.toLocaleString()} triangles`);
            return;
          }
          const { save } = await import('@tauri-apps/plugin-dialog');
          const target = await save({
            defaultPath: `${baseName}.FCStd`,
            filters: [{ name: 'FreeCAD document', extensions: ['FCStd'] }],
          });
          if (!target) {
            setRenderWindowStatus(`Ready (${renderViewModeRef.current} view)`);
            return;
          }
          const exported = await exportFreeCadDocument({
            outputPath: target,
            stlText: String(result.data),
          });
          setRenderWindowStatus(`FreeCAD exported: ${exported.solidCount || result.solidCount} solids`);
          return;
        }

        const filename = `${baseName}.stl`;

        if (native) {
          const { saveTextFromNativeDialog } = await import('../desktop/adapters/file.ts');
          const savedPath = await saveTextFromNativeDialog(String(result.data), {
            filters: [{ name: 'STL mesh', extensions: ['stl'] }],
          });
          if (!savedPath) {
            setRenderWindowStatus(`Ready (${renderViewModeRef.current} view)`);
            return;
          }
        } else {
          downloadStl(result.data, filename);
        }

        setRenderWindowStatus(solid
          ? `STL exported: ${result.solidCount} solids, ${result.triangleCount.toLocaleString()} triangles`
          : `STL exported: ${result.meshCount} surfaces, ${result.triangleCount.toLocaleString()} triangles`);
      } catch (err) {
        console.error('[RenderWindow] CAD export failed:', err);
        const message = (err as Error)?.message || String(err);
        setRenderWindowStatus('Export failed');
        alert(`Export failed: ${message}`);
      }
    };

    const refreshRenderCrossSectionSurfaces = (axis: 'XZ' | 'YZ') => {
      const w = window as any;
      const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      const rows = typeof w.getOpticalSystemRows === 'function'
        ? w.getOpticalSystemRows(w.tableOpticalSystem)
        : [];
      if (!scene || !Array.isArray(rows) || rows.length === 0) return;

      if (typeof w.drawOpticalSystemSurfaces === 'function') {
        w.drawOpticalSystemSurfaces({
          opticalSystemData: rows,
          scene,
          crossSectionOnly: true,
          showSurfaceOrigins: false,
          showSemidiaRing: false,
          showMirrorBackText: false,
          showDesignIntentLabels: renderLabelVisibilityRef.current.designIntent,
          showPrincipalPointLabels: renderLabelVisibilityRef.current.principalPoints,
          showSurfaceNumberLabels: renderLabelVisibilityRef.current.surfaceNumbers,
          crossSectionDirection: axis,
          crossSectionCenterOffset: 0,
        });
      }
      applyRenderWindowDirectCrossFill(scene, axis, rows);
      scene.traverse((child: any) => {
        const userData = child?.userData || {};
        if (userData.type === 'surfaceProfile' && (userData.profileType === 'YZ' || userData.profileType === 'XZ')) {
          child.visible = userData.profileType === axis;
        }
        if (userData.type === 'connectionLine' && (userData.direction === 'YZ' || userData.direction === 'XZ')) {
          child.visible = userData.direction === axis;
        }
      });
    };

    const switchRenderSectionView = (axis: 'XZ' | 'YZ') => {
      const w = window as any;
      refreshRenderCrossSectionSurfaces(axis);
      if (axis === 'XZ' && typeof w.setCameraForXZCrossSection === 'function') {
        w.setCameraForXZCrossSection({
          includeRayStartMargin: true,
          preserveDrawCrossBounds: true,
          storeDrawCrossBounds: true,
        });
      } else if (axis === 'YZ' && typeof w.setCameraForYZCrossSection === 'function') {
        w.setCameraForYZCrossSection({
          includeRayStartMargin: true,
          preserveDrawCrossBounds: true,
          storeDrawCrossBounds: true,
        });
      }
      syncOrthoBoundsToRendererAspect();
      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
      if (renderer && scene && camera && typeof renderer.render === 'function') {
        renderer.render(scene, camera);
      }
      setRenderWindowStatus(`Ready (${axis} view)`);
    };

    const handleViewXZ = () => {
      renderViewAxisRef.current = 'XZ';
      renderViewModeRef.current = 'XZ';
      setRenderViewAxis('XZ');
      setRenderViewMode('XZ');
      switchRenderSectionView('XZ');
      setRenderWindowStatus('Tracing XZ section rays...');
      scheduleRenderRedraw('XZ', 'XZ', beginRenderDrawRequest()).catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    };

    const handleViewYZ = () => {
      renderViewAxisRef.current = 'YZ';
      renderViewModeRef.current = 'YZ';
      setRenderViewAxis('YZ');
      setRenderViewMode('YZ');
      switchRenderSectionView('YZ');
      setRenderWindowStatus('Tracing YZ section rays...');
      scheduleRenderRedraw('YZ', 'YZ', beginRenderDrawRequest()).catch(() => {
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
        <div className="render-window-page">
          <div className="render-window-commandbar window-commandbar">
            <div className="window-segmented-control" role="group" aria-label="Render view">
              <button type="button" aria-pressed={renderViewMode === '3D'} onClick={handleRenderDraw}>3D</button>
              <button type="button" aria-pressed={renderViewMode === 'XZ'} onClick={handleViewXZ}>X-Z</button>
              <button type="button" aria-pressed={renderViewMode === 'YZ'} onClick={handleViewYZ}>Y-Z</button>
            </div>
            <button
              type="button"
              className="render-toolbar-popover-button"
              aria-expanded={renderOptionsOpen}
              onClick={() => {
                setRenderOptionsOpen((open) => !open);
                setRenderSurfaceColorsCollapsed(true);
              }}
            >
              Options
            </button>
            {renderOptionsOpen && (
              <div className="render-options-panel render-options-panel--unified">
            <label
              title="Display closed lens volumes in the 3D view"
              style={{ display: 'flex', alignItems: 'center', gap: 3, height: 27, padding: '0 3px', fontSize: 11, fontWeight: 500, opacity: renderViewMode === '3D' ? 1 : 0.5, whiteSpace: 'nowrap' }}
            >
              <input
                type="checkbox"
                checked={renderShowSolids}
                disabled={renderViewMode !== '3D'}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setRenderShowSolids(checked);
                  if (!checked) setRenderShowSectionCut(false);
                }}
              />
              Solid
            </label>
            <label
              title="Cut away the half facing the selected angle around +Z"
              style={{ display: 'flex', alignItems: 'center', gap: 3, height: 27, padding: '0 2px', fontSize: 11, fontWeight: 500, opacity: renderViewMode === '3D' ? 1 : 0.5, whiteSpace: 'nowrap' }}
            >
              <input
                type="checkbox"
                checked={renderShowSectionCut}
                disabled={renderViewMode !== '3D'}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setRenderShowSectionCut(checked);
                  if (checked) setRenderShowSolids(true);
                }}
              />
              Section
            </label>
            <label
              title="Section opening direction: 0°=+X, 90°=+Y, 180°=-X, 270°=-Y"
              style={{ display: 'flex', alignItems: 'center', gap: 2, height: 27, fontSize: 11, fontWeight: 500, opacity: renderViewMode === '3D' && renderShowSectionCut ? 1 : 0.5, whiteSpace: 'nowrap' }}
            >
              <input
                aria-label="3D section angle"
                type="number"
                min={0}
                max={359}
                step={1}
                value={renderSectionAngle}
                disabled={renderViewMode !== '3D' || !renderShowSectionCut}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  setRenderSectionAngle(((value % 360) + 360) % 360);
                }}
                style={{ width: 55, height: 27, fontSize: 12 }}
              />
              °
            </label>
            <span className="render-options-divider" />
            <select
              aria-label="Export format"
              value={renderExportFormat}
              onChange={(event) => setRenderExportFormat(event.target.value as 'fcstd' | 'solid-stl' | 'surface-stl')}
              style={{ height: 27, width: 176, fontSize: 12 }}
            >
              <option value="fcstd">FreeCAD Document (.FCStd)</option>
              <option value="solid-stl">Solid STL (.stl)</option>
              <option value="surface-stl">Surface STL (.stl)</option>
            </select>
            <button
              type="button"
              onClick={() => void handleExportCad()}
              title="Export the rendered optical system in the selected CAD format"
              style={{ height: 27 }}
            >
              Export
            </button>
            <label htmlFor="render-ray-count" style={{ marginLeft: 4, fontSize: 11, fontWeight: 500 }}>Rays</label>
            <input
              id="render-ray-count"
              type="number"
              min={6}
              step={1}
              value={renderRayCount}
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value, 10);
                if (!Number.isFinite(parsed)) return;
                setRenderRayCount(Math.max(6, parsed));
              }}
              style={{ width: 54, height: 27, fontSize: 12 }}
            />
                <span className="render-options-divider" />
                <label htmlFor="render-compare-scope">Configs</label>
                <select id="render-compare-scope" value={renderCompareScope} onChange={(e) => handleRenderCompareScopeChange(e.target.value === 'all' ? 'all' : 'active')}>
                  <option value="active">Active only</option>
                  <option value="all">All configs</option>
                </select>
                <label htmlFor="render-compare-direction" style={{ opacity: renderCompareScope === 'all' ? 1 : 0.5 }}>{renderViewMode === 'YZ' ? 'Offset Y' : 'Offset X'}</label>
                <select id="render-compare-direction" value={renderCompareOffsetDirection} onChange={(e) => setRenderCompareOffsetDirection((e.target.value as RenderCompareOffsetDirection) || 'centered')} disabled={renderCompareScope !== 'all'}>
                  <option value="centered">Centered</option>
                  <option value="positive">{renderViewMode === 'YZ' ? 'Up' : 'Right'}</option>
                  <option value="negative">{renderViewMode === 'YZ' ? 'Down' : 'Left'}</option>
                </select>
                <label htmlFor="render-compare-step" style={{ opacity: renderCompareScope === 'all' ? 1 : 0.5 }}>Step mm</label>
                <input id="render-compare-step" type="number" min={0} step={1} value={renderCompareOffsetStepMm} onChange={(e) => { const parsed = Number.parseFloat(e.target.value); setRenderCompareOffsetStepMm(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0); }} disabled={renderCompareScope !== 'all'} />
                <label htmlFor="render-compare-align" style={{ opacity: renderCompareScope === 'all' && renderViewMode !== '3D' ? 1 : 0.5 }}>Align</label>
                <select id="render-compare-align" value={renderCompareAlignReference} onChange={(e) => setRenderCompareAlignReference(e.target.value === 'image' ? 'image' : 'object')} disabled={renderCompareScope !== 'all' || renderViewMode === '3D'}>
                  <option value="object">Object</option>
                  <option value="image">Image</option>
                </select>
                <span className="render-options-divider" />
                <label className="render-option-toggle" title="Show intended Port Connections as dotted arrows. Solid coloured lines remain traced rays."><input type="checkbox" checked={renderShowPortConnections} onChange={(e) => setRenderShowPortConnections(e.target.checked)} />Connections</label>
                <label className="render-option-toggle"><input type="checkbox" checked={renderShowDesignIntentLabels} onChange={(e) => handleToggleRenderLabels(e.target.checked)} />Labels</label>
                <label className="render-option-toggle"><input type="checkbox" checked={renderShowPrincipalPointLabels} onChange={(e) => handleToggleRenderPrincipalPoints(e.target.checked)} />Paraxial</label>
                <label className="render-option-toggle"><input type="checkbox" checked={renderShowSurfaceNumberLabels} onChange={(e) => handleToggleRenderSurfaceNumbers(e.target.checked)} />Surface No.</label>
                <label className="render-option-toggle" title="Reflect Design Intent numeric edits in an open Render window"><input type="checkbox" checked={renderDesignIntentLiveSync} onChange={(e) => handleToggleRenderDesignIntentLiveSync(e.target.checked)} />Intent Sync</label>
                {renderCompareScope === 'all' && <span className="render-options-note">{renderViewMode === '3D' ? 'Compare offset applies to X-Z / Y-Z views.' : `${comparePreviewEntries.length || 0} configs, ${compareDirectionLabel}, step ${Math.max(0, Number(renderCompareOffsetStepMm) || 0)} mm, align ${compareAlignLabel}`}</span>}
              </div>
            )}
            <button
              type="button"
              className="render-toolbar-popover-button"
              aria-expanded={!renderSurfaceColorsCollapsed}
              onClick={() => {
                setRenderOptionsOpen(false);
                setRenderSurfaceColorsCollapsed((collapsed) => {
                  const next = !collapsed;
                  if (!next) refreshRenderLensTargets();
                  return next;
                });
              }}
            >
              Colors
            </button>
            <span className="render-window-status" title={renderWindowStatus}>{renderWindowStatus}</span>
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
              {!renderSurfaceColorsCollapsed && (
                <div className="render-surface-colors-panel">
                    <div className="render-surface-colors-header">
                      <strong>Surface Colors</strong>
                      <button type="button" onClick={() => setRenderSurfaceColorsCollapsed(true)} aria-label="Close surface colors">×</button>
                    </div>
                    <div className="render-surface-colors-actions">
                      <span>Changes apply immediately</span>
                      <button type="button" onClick={handleResetAllLensColors}>Reset colors</button>
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
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <span
                                        aria-hidden="true"
                                        title={`Current color: ${selectedHex}`}
                                        style={{
                                          width: 16,
                                          height: 16,
                                          flex: '0 0 16px',
                                          borderRadius: 3,
                                          backgroundColor: selectedHex,
                                          border: '1px solid rgba(15, 23, 42, 0.35)',
                                          boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.35)',
                                        }}
                                      />
                                      <select
                                        value={resolveOverrideColorHex(loadSurfaceColorOverridesSafe(), target.keys) ?? ''}
                                        onChange={(e) => handleSetLensColor(target, e.target.value || null)}
                                        aria-label={`${target.label} color`}
                                        style={{ flex: 1, minWidth: 0, fontSize: 11, backgroundColor: '#FFFFFF', color: '#111827' }}
                                      >
                                        <option value="" style={{ backgroundColor: '#00CCFF', color: '#111827' }}>Default</option>
                                        {RENDER_SURFACE_COLOR_PALETTE.map((entry) => (
                                          <option
                                            key={entry.hex}
                                            value={entry.hex}
                                            style={{ backgroundColor: entry.hex, color: '#111827' }}
                                          >
                                            {entry.name}
                                          </option>
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
                </div>
              )}
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
            return;
          }
          if (focus === 'field') {
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
      selectWorkspaceTab('intent');
      try {
        const container = document.getElementById('design-intent-container');
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
    { key: 'configuration', label: 'Config', icon: '🧭' },
    { key: 'source', label: 'Source', icon: 'λ' },
    { key: 'field', label: 'Field', icon: '◎' },
    { key: 'intent', label: 'Design Intent', icon: '🧩' },
    { key: 'requirements', label: 'Requirements', icon: '📏' },
    { key: 'literature', label: 'Prescription Import', icon: '📚' },
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
  const resolveStatusFile = () => {
    try {
      const rawName = String(getLoadedFileName() || '').trim();
      const warn = !!getLoadedFileWarn();
      if (!rawName) {
        return { text: 'No file loaded', color: '#64748b' };
      }

      const hasPath = /[\\/]/.test(rawName) || /^[A-Za-z]:/.test(rawName);
      const normalized = rawName.replace(/\\/g, '/');
      const slashIndex = normalized.lastIndexOf('/');
      const dir = hasPath
        ? (slashIndex >= 0 ? normalized.slice(0, slashIndex) : normalized)
        : '.';
      const file = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
      const pathText = `${dir}/${file}`;

      return {
        text: warn ? `${pathText} (surfaces only)` : pathText,
        color: warn ? '#b45309' : '#334155'
      };
    } catch (_) {
      return { text: 'No file loaded', color: '#64748b' };
    }
  };
  const [{ text: statusFileText, color: statusFileColor }, setStatusFile] = useState(resolveStatusFile);
  const activeWorkspaceLabel = workspaceSections.find((s) => s.key === workspaceFocus)?.label || 'Config';
  type WorkspaceMenu = 'file' | 'data' | 'edit' | 'view' | 'window' | 'run' | 'analysis';
  const [openMenu, setOpenMenu] = useState<WorkspaceMenu | null>(null);
  const [isExamplesMenuExpanded, setIsExamplesMenuExpanded] = useState(false);

  useEffect(() => {
    const refresh = () => {
      setStatusFile(resolveStatusFile());
    };
    refresh();
    window.addEventListener('coopt:loaded-file-updated', refresh as EventListener);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('coopt:loaded-file-updated', refresh as EventListener);
      window.removeEventListener('storage', refresh);
    };
  }, []);

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

  useEffect(() => {
    if (openMenu !== 'file' && isExamplesMenuExpanded) {
      setIsExamplesMenuExpanded(false);
    }
  }, [openMenu, isExamplesMenuExpanded]);

  const closeWorkspaceMenus = () => {
    setOpenMenu(null);
  };

  const toggleWorkspaceMenu = (menu: WorkspaceMenu) => () => {
    setOpenMenu((current) => (current === menu ? null : menu));
  };

  const handleMenuMouseEnter = (menu: WorkspaceMenu) => {
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
    openAnalysisMdiWindow(value);
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
          <SourceSection />
        </div>
        <div className={`app-shell__tabBody${workspaceFocus === 'field' ? '' : ' is-hidden'}`}>
          <FieldSection />
        </div>
        <div className={`app-shell__tabBody${workspaceFocus === 'intent' ? '' : ' is-hidden'}`}>
          <DesignIntentSection />
        </div>
        <div className={`app-shell__tabBody${workspaceFocus === 'literature' ? '' : ' is-hidden'}`}>
          <LiteratureImportPanel />
        </div>
        <div className={`app-shell__tabBody${workspaceFocus === 'requirements' ? '' : ' is-hidden'}`}>
          <RequirementsSection />
        </div>
      </>
    );
  };

  const WIN_ANALYSIS_GROUPS = [
    {
      id: 'image-quality', label: 'Image Quality', items: [
        { value: 'spot-diagram', label: 'Spot Diagram' },
        { value: 'psf', label: 'PSF', beta: true },
        { value: 'multi-field-psf', label: 'Multi-Field PSF' },
        { value: 'mtf', label: 'MTF', beta: true },
        { value: 'field-mtf', label: 'Field MTF', beta: true },
      ],
    },
    {
      id: 'aberrations', label: 'Aberrations', items: [
        { value: 'spherical-aberration', label: 'Spherical Aberration' },
        { value: 'astigmatism', label: 'Astigmatism' },
        { value: 'magnification-chromatic-aberration', label: 'Lateral Chromatic Aberration' },
        { value: 'transverse-aberration', label: 'Transverse Aberration' },
        { value: 'integrated-aberration', label: 'Integrated Aberration' },
        { value: 'opd-fan', label: 'OPD Fan', beta: true },
        { value: 'opd', label: 'OPD', beta: true },
      ],
    },
    {
      id: 'field-focus', label: 'Field & Focus', items: [
        { value: 'distortion', label: 'Distortion' },
        { value: 'distortion-grid', label: 'Grid Distortion' },
        { value: 'through-focus-spot', label: 'Through-Focus Spot' },
        { value: 'through-focus-mtf', label: 'Through-Focus MTF', beta: true },
      ],
    },
    {
      id: 'simulation', label: 'Simulation', items: [
        { value: 'image-simulation', label: 'Image Simulation' },
        { value: 'coherent-interferometer', label: 'Coherent Signal' },
      ],
    },
    {
      id: 'engineering', label: 'Engineering', items: [
        { value: 'sensitivity-analysis', label: 'Sensitivity Analysis' },
        { value: 'tolerance-analysis', label: 'Tolerance Analysis' },
      ],
    },
  ];
  const WIN_ANALYSIS_ITEMS = WIN_ANALYSIS_GROUPS.flatMap((group) => group.items);

  const getNextMdiZIndex = () => {
    const zWorkspace = Object.values(mdiWindowStates).map((w) => Number(w.zIndex) || 0);
    const zAux = Object.values(mdiAuxWindows).map((w) => Number(w.zIndex) || 0);
    return Math.max(0, ...zWorkspace, ...zAux) + 1;
  };

  const getMdiDesktopBounds = () => {
    const el = mdiDesktopRef.current;
    const width = Math.max(420, Math.round(el?.clientWidth || window.innerWidth || 1200));
    const height = Math.max(280, Math.round(el?.clientHeight || window.innerHeight || 800));
    return { x: 0, y: 0, width, height };
  };

  const normalizeMdiBoundsForOpen = (
    bounds: { x?: number; y?: number; width?: number; height?: number },
    fallback: { x: number; y: number; width: number; height: number }
  ) => {
    const desktop = getMdiDesktopBounds();
    const minWidth = 320;
    const minHeight = 180;
    const maxWidth = Math.max(minWidth, desktop.width);
    const maxHeight = Math.max(minHeight, desktop.height);

    const rawWidth = Number(bounds?.width);
    const rawHeight = Number(bounds?.height);
    const width = Math.max(minWidth, Math.min(maxWidth, Number.isFinite(rawWidth) ? rawWidth : fallback.width));
    const height = Math.max(minHeight, Math.min(maxHeight, Number.isFinite(rawHeight) ? rawHeight : fallback.height));

    const rawX = Number(bounds?.x);
    const rawY = Number(bounds?.y);
    const baseX = Number.isFinite(rawX) ? rawX : fallback.x;
    const baseY = Number.isFinite(rawY) ? rawY : fallback.y;
    const maxX = Math.max(0, desktop.width - width);
    const maxY = Math.max(0, desktop.height - height);

    return {
      x: Math.min(Math.max(0, Math.round(baseX)), Math.round(maxX)),
      y: Math.min(Math.max(0, Math.round(baseY)), Math.round(maxY)),
      width: Math.round(width),
      height: Math.round(height),
    };
  };

  const buildMdiModeUrl = (mode: 'render' | 'analysis' | 'settings' | 'optimize', analysis?: string) => {
    const url = new URL(window.location.href);
    const cacheBust = url.searchParams.get('v');
    url.search = '';
    if (cacheBust) {
      url.searchParams.set('v', cacheBust);
    }
    if (mode === 'render') {
      url.searchParams.set('coopt_render_window', '1');
    } else if (mode === 'optimize') {
      url.searchParams.set('coopt_optimize_window', '1');
    } else if (mode === 'settings') {
      url.searchParams.set('coopt_settings_window', '1');
    } else {
      url.searchParams.set('coopt_analysis_window', '1');
      if (analysis) url.searchParams.set('coopt_analysis', analysis);
    }
    return url.toString();
  };

  const openMdiAuxWindow = (id: string, title: string, url: string, defaultBounds?: { width?: number; height?: number; x?: number; y?: number }) => {
    const nextZ = getNextMdiZIndex();
    setMdiAuxWindows((prev) => {
      const existing = prev[id];
      const defaultX = defaultBounds?.x ?? (180 + (Object.keys(prev).length % 7) * 24);
      const defaultY = defaultBounds?.y ?? (90 + (Object.keys(prev).length % 7) * 24);
      const normalized = normalizeMdiBoundsForOpen(
        {
          x: existing?.x,
          y: existing?.y,
          width: existing?.width,
          height: existing?.height,
        },
        {
          x: defaultX,
          y: defaultY,
          width: defaultBounds?.width ?? 920,
          height: defaultBounds?.height ?? 620,
        }
      );
      return {
        ...prev,
        [id]: {
          id,
          title,
          url,
          open: true,
          minimized: false,
          maximized: false,
          restoreBounds: null,
          x: normalized.x,
          y: normalized.y,
          width: normalized.width,
          height: normalized.height,
          zIndex: nextZ,
        }
      };
    });
  };

  const closeMdiAuxWindow = (id: string) => {
    if (id === SYSTEM_TEXT_WINDOW_ID) return;
    setMdiAuxWindows((prev) => prev[id] ? ({ ...prev, [id]: { ...prev[id], open: false } }) : prev);
  };

  const minimizeMdiAuxWindow = (id: string) => {
    setMdiAuxWindows((prev) => prev[id] ? ({ ...prev, [id]: { ...prev[id], minimized: !prev[id].minimized } }) : prev);
  };

  const bringMdiAuxToFront = (id: string) => {
    const nextZ = getNextMdiZIndex();
    setMdiAuxWindows((prev) => prev[id] ? ({ ...prev, [id]: { ...prev[id], zIndex: nextZ } }) : prev);
  };

  const openRenderMdiWindow = () => {
    openMdiAuxWindow('render', 'Render', buildMdiModeUrl('render'));
  };

  const openSystemDataMdiWindow = () => {
    openMdiAuxWindow('analysis-system-data', 'System Data', buildMdiModeUrl('analysis', 'system-data'));
  };

  const openAnalysisMdiWindow = (value: string, label?: string) => {
    const item = WIN_ANALYSIS_ITEMS.find((a) => a.value === value);
    const title = label || item?.label || value;
    openMdiAuxWindow(`analysis-${value}`, title, buildMdiModeUrl('analysis', value));
  };

  const openSettingsMdiWindow = () => {
    openMdiAuxWindow('settings', 'Settings', buildMdiModeUrl('settings'), { width: 520, height: 620, x: 220, y: 110 });
  };

  const openOptimizeMdiWindow = () => {
    openMdiAuxWindow('optimize', 'Optimize Progress', buildMdiModeUrl('optimize'), { width: 620, height: 680, x: 200, y: 80 });
  };

  const focusSystemConsoleWindow = () => {
    const nextZ = getNextMdiZIndex();
    setMdiAuxWindows((prev) => {
      const current = prev[SYSTEM_TEXT_WINDOW_ID];
      if (!current) return prev;
      return {
        ...prev,
        [SYSTEM_TEXT_WINDOW_ID]: {
          ...current,
          open: true,
          minimized: false,
          zIndex: nextZ,
        },
      };
    });
  };

  const deriveWavefrontPupilRadiusMm = (opticalSystemRows: any[], objectRows: any[]) => {
    const readPositive = (row: any, keys: string[]) => {
      for (const key of keys) {
        const value = Number(row?.[key]);
        if (Number.isFinite(value) && value > 0) return Math.abs(value);
      }
      return Number.NaN;
    };
    const isStop = (row: any) => String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase() === 'stop';
    const stopRow = opticalSystemRows.find(isStop);
    if (!stopRow) return { radiusMm: undefined, source: 'unavailable' };

    const stopAperture = readPositive(stopRow, ['aperture', 'Aperture']);
    const stopSemidia = readPositive(stopRow, ['__cooptActualSemidia', '__cooptExplicitApertureSemidia', 'semidia', 'Semidia', 'Semi Diameter']);
    let radiusMm = Number.isFinite(stopAperture) ? stopAperture * 0.5 : stopSemidia;
    if (!(Number.isFinite(radiusMm) && radiusMm > 0)) return { radiusMm: undefined, source: 'unavailable' };

    for (const row of opticalSystemRows) {
      if (isStop(row)) continue;
      const clearAperture = readPositive(row, ['__cooptActualSemidia', '__cooptExplicitApertureSemidia', 'semidia', 'Semidia', 'Semi Diameter']);
      if (Number.isFinite(clearAperture)) radiusMm = Math.min(radiusMm, clearAperture);
    }

    let vignetteFactor = 1;
    for (const row of [...opticalSystemRows, ...objectRows]) {
      for (const key of ['vignettingFactor', 'vignetteFactor', 'vignetting', 'vignette', 'vignettingX', 'vignettingY', 'vignetteX', 'vignetteY']) {
        const value = Number(row?.[key]);
        if (Number.isFinite(value) && value >= 0 && value <= 1) vignetteFactor = Math.min(vignetteFactor, value);
      }
    }
    radiusMm *= vignetteFactor;
    return {
      radiusMm: Number.isFinite(radiusMm) && radiusMm > 0 ? radiusMm : undefined,
      source: vignetteFactor < 1 ? 'stop-clear-aperture-vignetting' : 'stop-clear-aperture',
    };
  };

  const runWavefrontRmsConsoleCommand = async (
    requestedGridSize = 129,
    requestedPupilRadiusMm?: number,
    requestedWavelengthsUm?: number[],
    requestedRelativeWeights?: number[],
    requestedSphereWavelengthMode?: 'primary-wavelength' | 'per-wavelength',
    requestedChiefImagePoint?: 'chief-ray-image-point' | 'paraxial-image-point' | 'target-surface-center' | 'per-wavelength-best-focus-point',
    requestedDisplayMode?: 'raw' | 'pistonRemoved' | 'pistonTiltRemoved' | 'referenceSphereTiltRemoved' | 'pistonDefocusRemoved' | 'pistonTiltDefocusRemoved',
    requestedPupilNormalizationMode?: 'fixed-entrance-pupil' | 'effective-transmitted-pupil',
    requestedDefocusScale?: number,
    requestedFixedReferenceSphereGeometry = false,
    requestedExitPupilReferencePointMode?: 'chief-ray-intersection' | 'exit-pupil-center',
    requestedFieldMode: 'primary-fixed' | 'per-wavelength' = 'primary-fixed',
    requestedChiefRayMode?: 'stop-center' | 'entrance-pupil-center' | 'transmitted-pupil-center',
    requestedReferenceRayPupilCoordinate?: { x: number; y: number },
    requestedDetailedDiagnostics = false,
    requestedOpdTermDiagnostics = false,
  ) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const hostWindow = getRenderHostWindow();
      const opdReferenceMode = sanitizeOpdReferenceModeSetting(
        (hostWindow as any).__COOPT_OPD_REFERENCE_MODE || localStorage.getItem(OPD_REFERENCE_MODE_KEY),
      );
      const opdChiefRayMode = requestedChiefRayMode || sanitizeOpdChiefRayModeSetting(
        (hostWindow as any).__COOPT_OPD_CHIEF_RAY_MODE || localStorage.getItem(OPD_CHIEF_RAY_MODE_KEY),
      );
      const referenceRayPupilCoordinate = requestedReferenceRayPupilCoordinate;
      const configuredPupilNormalizationMode = sanitizeOpdPupilNormalizationModeSetting(
        (hostWindow as any).__COOPT_OPD_PUPIL_NORMALIZATION_MODE || localStorage.getItem(OPD_PUPIL_NORMALIZATION_MODE_KEY),
      );
      const opdPupilNormalizationMode = requestedPupilNormalizationMode || configuredPupilNormalizationMode;
      const opdExitPupilReferencePointMode = requestedExitPupilReferencePointMode || sanitizeOpdExitPupilReferencePointModeSetting(
        (hostWindow as any).__COOPT_OPD_EXIT_PUPIL_REFERENCE_POINT_MODE || localStorage.getItem(OPD_EXIT_PUPIL_REFERENCE_POINT_MODE_KEY),
      );
      let opdReferenceSphereOptions = DEFAULT_OPD_REFERENCE_SPHERE_OPTIONS;
      try {
        const storedOptions = (hostWindow as any).__COOPT_OPD_REFERENCE_SPHERE_OPTIONS
          || JSON.parse(localStorage.getItem(OPD_REFERENCE_SPHERE_OPTIONS_KEY) || '{}');
        opdReferenceSphereOptions = sanitizeOpdReferenceSphereOptionsSetting(storedOptions);
      } catch (_) {}
      if (requestedSphereWavelengthMode) {
        opdReferenceSphereOptions = { ...opdReferenceSphereOptions, referenceSphereWavelengthMode: requestedSphereWavelengthMode };
      }
      if (requestedChiefImagePoint) {
        opdReferenceSphereOptions = { ...opdReferenceSphereOptions, chiefImagePoint: requestedChiefImagePoint };
      }
      const systemConfig = getSystemConfigFromWindow(hostWindow);
      const activeConfig = getActiveConfigFromSystemConfig(systemConfig);
      const opticalSystemRows = getConfigRowsForRender(hostWindow, activeConfig, systemConfig);
      const renderedObjectRows = Array.isArray(activeConfig?.object) && activeConfig.object.length > 0
        ? activeConfig.object
        : getRenderObjectRows(hostWindow, opticalSystemRows);
      const objectRows = renderedObjectRows.map((row: any) => {
        const originalPosition = String(row?.__cooptOriginalPosition ?? '').trim().toLowerCase();
        const target = row?.__cooptImageHeightTarget;
        if (originalPosition !== 'imageheight' || !target || !Number.isFinite(Number(target.y))) return row;
        return {
          ...row,
          position: 'ImageHeight',
          xHeight: Number(target.x ?? 0),
          yHeight: Number(target.y),
          xHeightAngle: Number(target.x ?? 0),
          yHeightAngle: Number(target.y),
          x: Number(target.x ?? 0),
          y: Number(target.y),
        };
      });
      const sourceRows = getRenderSourceRows(hostWindow);
      const pupilRadiusOverrideMm = Number.isFinite(Number(requestedPupilRadiusMm)) && Number(requestedPupilRadiusMm) > 0
        ? Number(requestedPupilRadiusMm)
        : undefined;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (opticalSystemRows.length === 0 || objectRows.length === 0 || sourceRows.length === 0) {
        appendSystemTextLine('wav: optical system, object, or wavelength data is unavailable.');
        return;
      }

      const rawWavelengths = (requestedWavelengthsUm
        ? requestedWavelengthsUm.map((wavelengthUm, index) => ({
          index,
          wavelengthUm: Number(wavelengthUm),
          relativeWeight: Number(requestedRelativeWeights?.[index] ?? sourceRows[index]?.relativeWeight ?? sourceRows[index]?.relWeight ?? sourceRows[index]?.weight ?? sourceRows[index]?.weighting ?? (index === 0 ? 1 : 0)),
        }))
        : sourceRows.map((row: any, index: number) => ({
          index,
          wavelengthUm: Number(row?.wavelength ?? row?.Wavelength),
          relativeWeight: Number(row?.relativeWeight ?? row?.relWeight ?? row?.weight ?? row?.weighting ?? (index === 0 ? 1 : 0)),
        })))
      .filter((entry) => Number.isFinite(entry.wavelengthUm) && entry.wavelengthUm > 0);
      if (rawWavelengths.length === 0) {
        appendSystemTextLine('wav: no valid wavelengths were found.');
        return;
      }
      const primaryIndex = requestedWavelengthsUm
        ? rawWavelengths.reduce((bestIndex, entry, index, entries) => (
          entry.relativeWeight > entries[bestIndex].relativeWeight ? index : bestIndex
        ), 0)
        : rawWavelengths.findIndex((entry) => {
          const row: any = sourceRows[entry.index] || {};
          const rawPrimary = row?.isPrimary ?? row?.primary ?? row?.Primary ?? row?.['Primary Wavelength'];
          const primaryText = String(rawPrimary ?? '').trim().toLowerCase();
          return rawPrimary === true
            || primaryText === 'true'
            || primaryText === '1'
            || primaryText === 'yes'
            || primaryText.includes('primary');
        });
      const primaryWeight = (primaryIndex >= 0 ? rawWavelengths[primaryIndex]?.relativeWeight : undefined)
        || rawWavelengths.find((entry) => entry.relativeWeight > 0)?.relativeWeight
        || 1;
      const wavelengths = rawWavelengths.map((entry) => ({
        ...entry,
        relativeWeight: entry.relativeWeight / primaryWeight,
      }));
      const effectiveRmsDisplayMode = Number.isFinite(requestedDefocusScale)
        ? `pistonDefocusScaled:${Math.max(0, Math.min(1, Number(requestedDefocusScale))).toFixed(6)}`
        : requestedDisplayMode || 'pistonRemoved';
      const backendRmsDisplayMode = effectiveRmsDisplayMode === 'referenceSphereTiltRemoved'
        ? 'pistonTiltRemoved'
        : effectiveRmsDisplayMode;

      appendSystemTextLine('WAVEFRONT ABERRATION (co-opt RMS/lambda)');
      appendSystemTextLine(`Wavelengths: ${wavelengths.map((entry) => `${entry.index + 1}=${entry.wavelengthUm.toFixed(6)}um`).join(', ')}`);
      const primaryWavelength = primaryIndex >= 0
        ? rawWavelengths[primaryIndex]?.wavelengthUm
        : rawWavelengths[0]?.wavelengthUm;
      if (requestedDetailedDiagnostics) {
        appendSystemTextLine(`Reference: ${opdReferenceMode} | Image point: ${opdReferenceSphereOptions.chiefImagePoint} | RMS: ${effectiveRmsDisplayMode} | Pupil: ${opdPupilNormalizationMode}`);
        if (requestedFixedReferenceSphereGeometry) appendSystemTextLine('Reference sphere geometry: fixed from chief-ray primary-wavelength result per Field');
        appendSystemTextLine(`Reference sphere wavelength: ${opdReferenceSphereOptions.referenceSphereWavelengthMode} (primary=${Number(primaryWavelength ?? 0).toFixed(6)}um)`);
        appendSystemTextLine(`Pupil radius: ${pupilRadiusOverrideMm != null ? `${pupilRadiusOverrideMm.toFixed(6)} mm (command override)` : 'native-derived from optical system and vignetting'}`);
      }
      appendSystemTextLine(`OPD conditions: ${requestedFieldMode === 'per-wavelength' ? 'Per-wavelength Field' : 'Primary-fixed Field'} | ${pupilRadiusOverrideMm != null ? 'command pupil override' : 'native-derived pupil'} | reference ray X=${Number(referenceRayPupilCoordinate?.x ?? 0).toFixed(6)}, Y=${Number(referenceRayPupilCoordinate?.y ?? 0).toFixed(6)}`);
      appendSystemTextLine(' Field  Wavel.  Rel.Wgt        RMS/lambda');
      appendSystemTextLine('------------------------------------------');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const [{ normalizeTransverseObjectRowsForImageHeight, runNativeOpdMap, runNativeOpdRmsWaves }, { calculateExitPupilDiameter, calculatePupilsByNewSpec }] = await Promise.all([
        import('../desktop/ipc/client.ts'),
        import('../../raytracing/core/ray-paraxial.ts'),
      ]);
      const tracedObjectRows = await normalizeTransverseObjectRowsForImageHeight(
        opticalSystemRows,
        sourceRows,
        objectRows,
        Number(primaryWavelength),
      );
      const tracedObjectRowsByWavelength = requestedFieldMode === 'per-wavelength'
        ? new Map(await Promise.all(wavelengths.map(async (wavelength) => [
          wavelength.index,
          await normalizeTransverseObjectRowsForImageHeight(
            opticalSystemRows,
            sourceRows,
            objectRows,
            wavelength.wavelengthUm,
          ),
        ] as const)))
        : undefined;
      const primaryPupils = calculatePupilsByNewSpec(opticalSystemRows, Number(primaryWavelength));
      const entrancePupilPositionFromFirstSurfaceMm = Number(primaryPupils?.entrancePupil?.position);
      const derivedEntrancePupilDiameterMm = Number(primaryPupils?.entrancePupil?.diameter);
      const effectivePupilRadiusMm = pupilRadiusOverrideMm
        ?? (Number.isFinite(derivedEntrancePupilDiameterMm) && derivedEntrancePupilDiameterMm > 0
          ? derivedEntrancePupilDiameterMm / 2
          : undefined);
      const exitPupilPositionFromLastSurfaceMm = Number(
        calculateExitPupilDiameter(opticalSystemRows, Number(primaryWavelength))?.position,
      );
      const summarizePupilMask = (mask: any) => {
        if (!Array.isArray(mask) || mask.length === 0) return null;
        const height = mask.length;
        const width = mask.reduce((max: number, row: any) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
        if (width === 0) return null;
        const centerX = (width - 1) / 2;
        const centerY = (height - 1) / 2;
        const scale = Math.max(centerX, centerY) || 1;
        let candidateCount = 0;
        let validCount = 0;
        let sumU = 0;
        let sumV = 0;
        let minU = Infinity;
        let maxU = -Infinity;
        let minV = Infinity;
        let maxV = -Infinity;
        let maxRadius = 0;
        for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
          const row = Array.isArray(mask[rowIndex]) ? mask[rowIndex] : [];
          for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
            const value = row[columnIndex];
            if (value === null || value === undefined) continue;
            candidateCount += 1;
            if (value !== true) continue;
            validCount += 1;
            const u = (columnIndex - centerX) / scale;
            const v = (rowIndex - centerY) / scale;
            const radius = Math.hypot(u, v);
            sumU += u;
            sumV += v;
            minU = Math.min(minU, u);
            maxU = Math.max(maxU, u);
            minV = Math.min(minV, v);
            maxV = Math.max(maxV, v);
            maxRadius = Math.max(maxRadius, radius);
          }
        }
        if (validCount === 0) return { candidateCount, validCount, validRatio: 0 };
        return {
          candidateCount,
          validCount,
          validRatio: validCount / Math.max(1, candidateCount),
          centroidU: sumU / validCount,
          centroidV: sumV / validCount,
          minU,
          maxU,
          minV,
          maxV,
          maxRadius,
        };
      };
      const conditionReferenceGrid = (grid: any) => {
        if (!Array.isArray(grid) || grid.length === 0) return null;
        const rowIndex = (grid.length - 1) / 2;
        if (!Number.isInteger(rowIndex) || !Array.isArray(grid[rowIndex])) return null;
        const width = grid[rowIndex].length;
        if (width === 0) return null;
        const sampleColumn = (-1 / 32 + 1) * (width - 1) / 2;
        const leftColumn = Math.floor(sampleColumn);
        const rightColumn = Math.ceil(sampleColumn);
        if (grid[rowIndex][leftColumn] == null || grid[rowIndex][rightColumn] == null) return null;
        const leftValue = Number(grid[rowIndex][leftColumn]);
        const rightValue = Number(grid[rowIndex][rightColumn]);
        if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return null;
        const fraction = sampleColumn - leftColumn;
        const referenceValue = leftValue + (rightValue - leftValue) * fraction;
        let squareSum = 0;
        let finiteCount = 0;
        const conditionedGrid = grid.map((row: any) => Array.isArray(row) ? row.map((value: any) => {
          if (value == null) return null;
          const numericValue = Number(value);
          if (!Number.isFinite(numericValue)) return null;
          const conditionedValue = numericValue - referenceValue;
          squareSum += conditionedValue * conditionedValue;
          finiteCount += 1;
          return conditionedValue;
        }) : []);
        return finiteCount > 0
          ? { grid: conditionedGrid, rmsWaves: Math.sqrt(squareSum / finiteCount), referenceValue }
          : null;
      };
      let weightedSquareSum = 0;
      let weightSum = 0;
      let validSampleWeightedSquareSum = 0;
      let validSampleWeightSum = 0;
      let referenceWeightedSquareSum = 0;
      let referenceWeightSum = 0;
      let pooledReferenceSquareSum = 0;
      let pooledReferenceSampleWeight = 0;
      let backendName = '';
      for (let objectIndex = 0; objectIndex < objectRows.length; objectIndex += 1) {
        let fixedReferenceSphereGeometry: {
          center: { x: number; y: number; z: number };
          radiusMm: number;
          direction: { x: number; y: number; z: number };
        } | undefined;
        if (requestedFixedReferenceSphereGeometry) {
          try {
            const chiefGeometryResult: any = await runNativeOpdRmsWaves({
              opticalSystemRows,
              sourceRows,
              objectRows: tracedObjectRows,
              objectIndex,
              wavelengthUm: Number(primaryWavelength),
              gridSize: requestedGridSize,
              pupilRadiusMm: effectivePupilRadiusMm,
              entrancePupilPositionFromFirstSurfaceMm: Number.isFinite(entrancePupilPositionFromFirstSurfaceMm)
                ? entrancePupilPositionFromFirstSurfaceMm
                : undefined,
              exitPupilPositionFromLastSurfaceMm: Number.isFinite(exitPupilPositionFromLastSurfaceMm)
                ? exitPupilPositionFromLastSurfaceMm
                : undefined,
              pupilSamplingMode: 'entrance',
              chiefRayMode: opdChiefRayMode,
              referenceRayPupilCoordinate,
              pupilNormalizationMode: opdPupilNormalizationMode,
              exitPupilReferencePointMode: opdExitPupilReferencePointMode,
              referenceSphereOptions: { ...opdReferenceSphereOptions, chiefImagePoint: 'chief-ray-image-point' },
              referenceMode: opdReferenceMode,
              opdDisplayMode: 'raw',
            });
            const center = chiefGeometryResult?.referenceSphereCenter;
            const direction = chiefGeometryResult?.referenceSphereDirection;
            const radiusMm = Number(chiefGeometryResult?.referenceSphereRadiusMm);
            if (center && direction && Number.isFinite(radiusMm) && radiusMm > 0) {
              fixedReferenceSphereGeometry = {
                center: { x: Number(center.x), y: Number(center.y), z: Number(center.z) },
                radiusMm,
                direction: { x: Number(direction.x), y: Number(direction.y), z: Number(direction.z) },
              };
            }
          } catch (_) {
            appendSystemTextLine(`  Field ${objectIndex + 1}: fixed chief reference geometry unavailable`);
          }
        }
        for (const wavelength of wavelengths) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          let result: any;
          try {
            const fieldObjectRows = tracedObjectRowsByWavelength?.get(wavelength.index) || tracedObjectRows;
            result = await runNativeOpdRmsWaves({
              opticalSystemRows,
              sourceRows,
              objectRows: fieldObjectRows,
              objectIndex,
              wavelengthUm: wavelength.wavelengthUm,
              gridSize: requestedGridSize,
              pupilRadiusMm: effectivePupilRadiusMm,
              entrancePupilPositionFromFirstSurfaceMm: Number.isFinite(entrancePupilPositionFromFirstSurfaceMm)
                ? entrancePupilPositionFromFirstSurfaceMm
                : undefined,
              exitPupilPositionFromLastSurfaceMm: Number.isFinite(exitPupilPositionFromLastSurfaceMm)
                ? exitPupilPositionFromLastSurfaceMm
                : undefined,
              pupilSamplingMode: 'entrance',
              chiefRayMode: opdChiefRayMode,
              referenceRayPupilCoordinate,
              pupilNormalizationMode: opdPupilNormalizationMode,
              exitPupilReferencePointMode: opdExitPupilReferencePointMode,
              referenceSphereOptions: opdReferenceSphereOptions,
              referenceSphereGeometry: fixedReferenceSphereGeometry,
              referenceMode: opdReferenceMode,
              opdDisplayMode: backendRmsDisplayMode,
            });
          } catch (error) {
            appendSystemTextLine(`  Field ${objectIndex + 1} Wavel. ${wavelength.index + 1}: failed: ${String((error as any)?.message || error)}`);
            continue;
          }
          if (!backendName && result?.backend) backendName = String(result.backend);
          const maskSummary = summarizePupilMask(result?.pupilMaskGrid);
          if (requestedDetailedDiagnostics && maskSummary) {
            appendSystemTextLine(`  Mask Field ${objectIndex + 1} Wavel. ${wavelength.index + 1}: valid=${maskSummary.validCount}/${maskSummary.candidateCount} ratio=${maskSummary.validRatio.toFixed(4)}${maskSummary.validCount > 0 ? ` centroid=(${maskSummary.centroidU.toFixed(4)},${maskSummary.centroidV.toFixed(4)}) bounds=(${maskSummary.minU.toFixed(4)},${maskSummary.maxU.toFixed(4)})x(${maskSummary.minV.toFixed(4)},${maskSummary.maxV.toFixed(4)}) rmax=${maskSummary.maxRadius.toFixed(4)}` : ''}`);
          }
          const conditionedReference = conditionReferenceGrid(result?.referenceSphereOpdGrid);
          const nativeRms = Number(result?.displayRmsWaves ?? result?.rmsWaves);
          const rms = effectiveRmsDisplayMode === 'raw' && conditionedReference
            ? conditionedReference.rmsWaves
            : nativeRms;
          if (!Number.isFinite(rms)) continue;
          const validSampleCount = maskSummary?.validCount ?? Number(result?.sampleCount ?? 0);
          if (requestedDetailedDiagnostics) {
            const sphereCenter = result?.referenceSphereCenter;
            const sphereText = sphereCenter
              ? ` sphere=(${Number(sphereCenter.x).toFixed(3)},${Number(sphereCenter.y).toFixed(3)},${Number(sphereCenter.z).toFixed(3)}) r=${Number(result?.referenceSphereRadiusMm ?? 0).toFixed(3)}`
              : '';
            const direction = result?.referenceSphereDirection;
            const directionText = direction
              ? ` dir=(${Number(direction.x).toFixed(6)},${Number(direction.y).toFixed(6)},${Number(direction.z).toFixed(6)})`
              : '';
            const exitPupilPoint = result?.exitPupilCenter;
            const exitPupilText = exitPupilPoint
              ? ` exit=(${Number(exitPupilPoint.x).toFixed(3)},${Number(exitPupilPoint.y).toFixed(3)},${Number(exitPupilPoint.z).toFixed(3)})`
              : '';
            const gridSize = Number(result?.gridSize ?? requestedGridSize);
            const candidateCount = maskSummary?.candidateCount
              ?? (gridSize > 1 ? Math.round(Math.PI * ((gridSize - 1) / 2) ** 2) : 1);
            const hitCount = Number(result?.hitCount ?? 0);
            const validRatio = candidateCount > 0 ? validSampleCount / candidateCount : 0;
            const geometrySource = result?.primaryReferenceGeometryApplied === true
              ? 'cross-wavelength-primary'
              : Math.abs(Number(wavelength.wavelengthUm) - Number(result?.referenceSphereWavelengthUsed)) <= 1e-12
                ? 'native-primary'
                : 'per-wavelength';
            const currentRadiusText = Number.isFinite(Number(result?.currentReferenceSphereRadiusMm))
              ? Number(result.currentReferenceSphereRadiusMm).toFixed(6)
              : 'n/a';
            const primaryRadiusText = result?.primaryReferenceSphereRadiusMm != null && Number.isFinite(Number(result.primaryReferenceSphereRadiusMm))
              ? Number(result.primaryReferenceSphereRadiusMm).toFixed(6)
              : 'n/a';
            const formatPoint = (point: any) => point && [point.x, point.y, point.z].every((value: any) => Number.isFinite(Number(value)))
              ? `(${Number(point.x).toFixed(6)},${Number(point.y).toFixed(6)},${Number(point.z).toFixed(6)})`
              : 'unavailable';
            const selectedPointText = formatPoint(result?.selectedImagePoint);
            const rmsBestFocusPointText = formatPoint(result?.rmsBestFocusPoint);
            const runtimeAngle = result?.imageHeightRuntimeSolvedAngle;
            const runtimeAngleText = runtimeAngle
              ? `->(${Number(runtimeAngle.x).toFixed(6)},${Number(runtimeAngle.y).toFixed(6)}) runtime=${result?.imageHeightChiefRayRuntimeResolved === true ? 'resolved' : 'not-resolved'} preserved=${result?.imageHeightChiefRayPreserved === true ? 'yes' : 'no'}`
              : '';
            appendSystemTextLine(`  Field ${objectIndex + 1} input: ${String(result?.usedObjectPosition || 'unknown')} target=(${Number(result?.imageHeightTargetX ?? 0).toFixed(6)},${Number(result?.imageHeightTargetY ?? 0).toFixed(6)}) angle=(${Number(result?.usedObjectX ?? 0).toFixed(6)},${Number(result?.usedObjectY ?? 0).toFixed(6)})${runtimeAngleText}${sphereText}${directionText}${exitPupilText} refWl=${Number(result?.referenceSphereWavelengthUsed ?? 0).toFixed(6)} geometry=${geometrySource} radius=${currentRadiusText}->${primaryRadiusText} pupilRadius=${Number(result?.effectivePupilRadiusMm ?? 0).toFixed(6)} chiefMode=${String(result?.chiefReferenceMode ?? 'unknown')} corrected=${Number(result?.referenceCorrectedSampleCount ?? 0)} grid=${gridSize} hit=${hitCount}/${candidateCount} finite=${validSampleCount} validRatio=${validRatio.toFixed(4)} trackedRmsUm=${Number(result?.trackedOpdRmsUm ?? 0).toFixed(6)} beforeTargetRmsUm=${Number(result?.beforeTargetTrackedOpdRmsUm ?? 0).toFixed(6)} targetSegmentRmsUm=${Number(result?.targetSegmentOpdRmsUm ?? 0).toFixed(6)} sphereDeltaRmsUm=${Number(result?.spherePathDeltaRmsUm ?? 0).toFixed(6)} pathScale*=${Number(result?.spherePathOptimalScale ?? 0).toFixed(6)} minRmsUm=${Number(result?.spherePathOptimalRmsUm ?? 0).toFixed(6)} refRmsUm=${Number(result?.referenceOpdRmsUm ?? 0).toFixed(6)} currentRmsUm=${Number(result?.currentReferenceOpdRmsUm ?? 0).toFixed(6)} alternate(${String(result?.alternateSphereIntersection ?? 'unknown')})RmsUm=${Number(result?.alternateReferenceOpdRmsUm ?? 0).toFixed(6)} targetOriginRmsUm=${Number(result?.targetOriginReferenceOpdRmsUm ?? 0).toFixed(6)} imageSpaceN=${Number(result?.imageSpaceN ?? 0).toFixed(6)} airRmsUm=${Number(result?.airReferenceOpdRmsUm ?? 0).toFixed(6)} alternateSign(${String(result?.alternateOpticalPathSign ?? 'unknown')})RmsUm=${Number(result?.alternateSignReferenceOpdRmsUm ?? 0).toFixed(6)} axisReferenceRmsUm=${Number(result?.axisReferenceSphereRmsUm ?? 0).toFixed(6)} radiusScale*=${Number(result?.sphereRadiusOptimalScale ?? 0).toFixed(6)} radiusRmsUm=${Number(result?.sphereRadiusOptimalRmsUm ?? 0).toFixed(6)}`);
            appendSystemTextLine(`       imagePointMode=${String(result?.selectedImagePointMode ?? 'unknown')} selected=${selectedPointText} rmsBestFocus=${rmsBestFocusPointText}`);
            const focusDiagnostics = result?.rmsBestFocusDiagnostics;
            if (focusDiagnostics) {
              appendSystemTextLine(`       rmsFocus range=${String(focusDiagnostics.searchRangeMode)} baseZ=${Number(focusDiagnostics.baseZ).toFixed(6)} deltaZ=${Number(focusDiagnostics.bestFocusDeltaZ).toFixed(6)} paraxialRmsMm=${Number(focusDiagnostics.paraxialRmsMm).toFixed(6)} bestRmsMm=${Number(focusDiagnostics.bestFocusRmsMm).toFixed(6)} improvementMm=${Number(focusDiagnostics.improvementMm).toFixed(6)} rays=${Number(focusDiagnostics.rayCount)}`);
            }
          }
          const relativeWeight = Number.isFinite(wavelength.relativeWeight) ? wavelength.relativeWeight : 0;
          const fieldText = String(objectIndex + 1).padStart(6, ' ');
          const wavelengthText = String(wavelength.index + 1).padStart(7, ' ');
          const weightText = relativeWeight.toFixed(3).padStart(9, ' ');
          const rmsText = rms.toFixed(5).padStart(16, ' ');
          appendSystemTextLine(`${fieldText}${wavelengthText}${weightText}${rmsText}`);
          const diagnosticWavelength = Math.max(1e-12, Number(wavelength.wavelengthUm));
          const trackedRmsUm = Number(result?.trackedOpdRmsUm);
          const referenceRmsUm = Number(result?.referenceOpdRmsUm);
          if (requestedDetailedDiagnostics && (Number.isFinite(trackedRmsUm) || Number.isFinite(referenceRmsUm))) {
            appendSystemTextLine(`       diagnostic preRef=${Number.isFinite(trackedRmsUm) ? (trackedRmsUm * 1000 / diagnosticWavelength).toFixed(5) : 'n/a'} postRef=${Number.isFinite(referenceRmsUm) ? (referenceRmsUm * 1000 / diagnosticWavelength).toFixed(5) : 'n/a'} waves valid=${Number(result?.referenceCorrectedSampleCount ?? result?.hitCount ?? 0)}`);
          }
          const displayFit = result?.wavefrontFit || result?.displayFit;
          if (requestedDetailedDiagnostics && displayFit && Number.isFinite(Number(displayFit.piston))) {
            appendSystemTextLine(`       fit basis=${String(displayFit.basis ?? 'unknown')} coord=${String(displayFit.coordinateSource ?? 'unknown')} samples=${Number(displayFit.sampleCount ?? 0)} physical=${Number(displayFit.physicalCoordinateSampleCount ?? 0)} meanR2=${Number(displayFit.defocusMeanRadiusSquared ?? 0).toFixed(6)} pistonWaves=${Number(displayFit.piston).toFixed(6)} defocusWaves=${Number(displayFit.defocus ?? 0).toFixed(6)} scale=${Number(displayFit.defocusScale ?? 0).toFixed(6)} tilt=retained`);
          }
          if (requestedOpdTermDiagnostics && Array.isArray(result?.opdTermSamples)) {
            for (const sample of result.opdTermSamples) {
              appendSystemTextLine(`       opdTerms ${String(sample?.label ?? 'sample')} uv=(${Number(sample?.pupilU ?? 0).toFixed(4)},${Number(sample?.pupilV ?? 0).toFixed(4)}) tracked=${(Number(sample?.chiefOplUm) - Number(sample?.marginalOplUm)).toFixed(6)}um beforeTarget=${Number(sample?.beforeTargetOpdUm ?? 0).toFixed(6)}um targetSegment=${Number(sample?.targetSegmentOpdUm ?? 0).toFixed(6)}um sphereDelta=${Number(sample?.spherePathDeltaUm ?? 0).toFixed(6)}um reference=${Number(sample?.referenceOpdUm ?? 0).toFixed(6)}um`);
            }
          }
          if (relativeWeight > 0) {
            weightedSquareSum += relativeWeight * rms * rms;
            weightSum += relativeWeight;
            const validSampleWeight = Math.max(0, validSampleCount);
            validSampleWeightedSquareSum += relativeWeight * validSampleWeight * rms * rms;
            validSampleWeightSum += relativeWeight * validSampleWeight;
            const referenceRmsWaves = conditionedReference?.rmsWaves
              ?? Number(result?.referenceRmsWaves ?? result?.referenceOpdRmsUm / Math.max(1e-12, Number(wavelength.wavelengthUm)));
            if (Number.isFinite(referenceRmsWaves)) {
              referenceWeightedSquareSum += relativeWeight * referenceRmsWaves * referenceRmsWaves;
              referenceWeightSum += relativeWeight;
            }
            const referenceGrid = conditionedReference?.grid ?? result?.referenceSphereOpdGrid;
            if (Array.isArray(referenceGrid)) {
              let pooledFiniteCount = 0;
              let pooledSquareSum = 0;
              for (const gridRow of referenceGrid) {
                if (!Array.isArray(gridRow)) continue;
                for (const value of gridRow) {
                  const opdWaves = Number(value);
                  if (!Number.isFinite(opdWaves)) continue;
                  pooledFiniteCount += 1;
                  pooledSquareSum += opdWaves * opdWaves;
                }
              }
              pooledReferenceSquareSum += relativeWeight * pooledSquareSum;
              pooledReferenceSampleWeight += relativeWeight * pooledFiniteCount;
            }
          }
        }
      }
      if (weightSum > 0) {
        appendSystemTextLine('------------------------------------------');
        appendSystemTextLine(` Individual-cell RMS/lambda: ${(Math.sqrt(weightedSquareSum / weightSum)).toFixed(5).padStart(16, ' ')}`);
        if (validSampleWeightSum > 0) {
          appendSystemTextLine(` Valid-sample-weighted RMS/lambda: ${(Math.sqrt(validSampleWeightedSquareSum / validSampleWeightSum)).toFixed(5).padStart(16, ' ')}`);
        }
        if (referenceWeightSum > 0) {
          appendSystemTextLine(` Reference-sphere total RMS/lambda: ${(Math.sqrt(referenceWeightedSquareSum / referenceWeightSum)).toFixed(5).padStart(16, ' ')}`);
        }
        if (pooledReferenceSampleWeight > 0) {
          appendSystemTextLine(` Pooled reference-ray RMS/lambda: ${(Math.sqrt(pooledReferenceSquareSum / pooledReferenceSampleWeight)).toFixed(5).padStart(16, ' ')}`);
        }
      }
      if (backendName) appendSystemTextLine(`Backend: ${backendName}`);
    } catch (error) {
      appendSystemTextLine(`wav: failed: ${String((error as any)?.message || error)}`);
    }
  };

  const runChiefRayOpdConsoleCommand = async (
    requestedDetailedDiagnostics = false,
    requestedChiefRayMode: 'stop-center' | 'entrance-pupil-center' | 'transmitted-pupil-center' = 'stop-center',
    requestedChiefImagePoint: 'chief-ray-image-point' | 'paraxial-image-point' | 'target-surface-center' = 'chief-ray-image-point',
    requestedExitPupilReferencePointMode: 'chief-ray-intersection' | 'exit-pupil-center' = 'chief-ray-intersection',
    requestedComparisonRay: { x: number; y: number } = { x: -1 / 32, y: 0 },
    requestedPupilSamplingMode: 'entrance' | 'stop' = 'entrance',
    requestedPupilFit = false,
    requestedGlobalReferenceSphere = false,
    requestedOpdBasis: 'sphere' | 'chief' = 'sphere',
    requestedPupilRadiusMode: 'effective' | 'nominal' | 'per-wavelength-nominal' = 'effective',
    requestedDirectOpd = false,
    requestedRsiPrimaryLaunchBlend = 0,
    requestedPreserveImageHeightChiefRay = false,
    requestedResolveImageHeightChiefRayInRuntime = false,
  ) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      const hostWindow = getRenderHostWindow();
      const systemConfig = getSystemConfigFromWindow(hostWindow);
      const activeConfig = getActiveConfigFromSystemConfig(systemConfig);
      const opticalSystemRows = getConfigRowsForRender(hostWindow, activeConfig, systemConfig);
      const objectRows = getRenderObjectRows(hostWindow, opticalSystemRows);
      const sourceRows = getRenderSourceRows(hostWindow);
      if (opticalSystemRows.length === 0 || objectRows.length === 0 || sourceRows.length === 0) {
        appendSystemTextLine('opd: optical system, object, or wavelength data is unavailable.');
        return;
      }
      const wavelengths = sourceRows.map((row: any, index: number) => ({
        index,
        wavelengthUm: Number(row?.wavelength ?? row?.Wavelength),
      })).filter((entry) => Number.isFinite(entry.wavelengthUm) && entry.wavelengthUm > 0);
      if (wavelengths.length === 0) {
        appendSystemTextLine('opd: no valid wavelengths were found.');
        return;
      }
      const primaryIndex = wavelengths.findIndex((entry) => {
        const row: any = sourceRows[entry.index] || {};
        const rawPrimary = row?.isPrimary ?? row?.primary ?? row?.Primary ?? row?.['Primary Wavelength'];
        const primaryText = String(rawPrimary ?? '').trim().toLowerCase();
        return rawPrimary === true || primaryText === 'true' || primaryText === '1'
          || primaryText === 'yes' || primaryText.includes('primary');
      });
      const resolvedPrimaryIndex = primaryIndex >= 0 ? primaryIndex : 0;
      const primaryWavelength = wavelengths[resolvedPrimaryIndex].wavelengthUm;
      const [{ normalizeTransverseObjectRowsForImageHeight, runNativeOpdMap }, { calculateEntrancePupilDiameter, calculateExitPupilDiameter, calculatePupilsByNewSpec }] = await Promise.all([
        import('../desktop/ipc/client.ts'),
        import('../../raytracing/core/ray-paraxial.ts'),
      ]);
      const tracedObjectRows = await normalizeTransverseObjectRowsForImageHeight(
        opticalSystemRows,
        sourceRows,
        objectRows,
        primaryWavelength,
      );
      const entrancePupilPosition = Number(calculatePupilsByNewSpec(opticalSystemRows, primaryWavelength)?.entrancePupil?.position);
      const exitPupilPosition = Number(calculateExitPupilDiameter(opticalSystemRows, primaryWavelength)?.position);
      const nominalEntrancePupilDiameter = Number(calculateEntrancePupilDiameter(opticalSystemRows, primaryWavelength));
      const nominalEntrancePupilRadius = nominalEntrancePupilDiameter > 0 && Number.isFinite(nominalEntrancePupilDiameter)
        ? nominalEntrancePupilDiameter / 2
        : undefined;
      const requestedPupilRadiusMm = requestedPupilRadiusMode === 'nominal' ? nominalEntrancePupilRadius : undefined;
      const chiefOplUm: number[][] = [];
      const sampledOpdMm: Array<Array<number | null>> = [];
      const referenceSphereOpdGridsMm: Array<Array<Array<Array<number | null>>>> = [];
      const chiefRelativeOpdGridsMm: Array<Array<Array<Array<number | null>>>> = [];
      const transmittedPupilCenters: Array<Array<{ u: number; v: number } | undefined>> = [];
      const tracedFieldInputs: Array<{
        position: string;
        x: number;
        y: number;
        chiefLaunchOrigin?: { x: number; y: number; z: number };
        imageHeightChiefRayApplied: boolean;
        imageHeightChiefRayPreserved: boolean;
        imageHeightChiefRayRuntimeResolved: boolean;
        imageHeightChiefDirection?: { x: number; y: number; z: number };
        imageHeightRuntimeSolvedAngle?: { x: number; y: number; z: number };
        imageHeightSolverHit?: { x: number; y: number; z: number };
        imageHeightSolverSurfaceIndex?: number;
        chiefStopPoint?: { x: number; y: number; z: number };
        chiefStopDirection?: { x: number; y: number; z: number };
        chiefImagePoint?: { x: number; y: number; z: number };
        chiefImageLocalPoint?: { x: number; y: number; z: number };
        chiefSurfaceTrace?: Array<{ surfaceIndex: number; point: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } }>;
        sourcePosition: string;
        imageHeightTargetY?: number;
        imageHeightSolveMode?: string;
      } | undefined> = [];
      let primaryLaunchOverrideRequestedCount = 0;
      let primaryLaunchOverrideAppliedCount = 0;
      let globalReferenceSphereGeometry: { center: any; radiusMm: number; direction: any } | undefined;
      const comparisonGridSize = 129;
      const comparisonRelativeApertureX = requestedComparisonRay.x;
      const comparisonRelativeApertureY = requestedComparisonRay.y;
      const comparisonGridIndex = (relativeAperture: number) => Math.round((relativeAperture + 1) * (comparisonGridSize - 1) / 2);
      const comparisonXIndex = comparisonGridIndex(comparisonRelativeApertureX);
      const comparisonYIndex = comparisonGridIndex(comparisonRelativeApertureY);
        const referenceRayPupilCoordinate = requestedOpdBasis === 'chief'
          ? { x: 0, y: 0 }
          : requestedComparisonRay;
      // Chief-relative display needs the unreferenced OPD grid, which the RMS wrapper does not preserve.
      const runOpdComparison = runNativeOpdMap;
      for (let objectIndex = 0; objectIndex < objectRows.length; objectIndex += 1) {
        const referenceSphereOptions = {
          referenceSphereWavelengthMode: 'primary-wavelength' as const,
          chiefImagePoint: requestedChiefImagePoint,
          sphereIntersection: 'exit-pupil-side' as const,
          exitPupilDirection: 'image-to-exit-pupil' as const,
        };
        const primaryResult: any = await runOpdComparison({
          opticalSystemRows,
          sourceRows,
          objectRows: tracedObjectRows,
          objectIndex,
          wavelengthUm: primaryWavelength,
          gridSize: comparisonGridSize,
          pupilRadiusMm: requestedPupilRadiusMode === 'per-wavelength-nominal'
            ? nominalEntrancePupilRadius
            : requestedPupilRadiusMm,
          entrancePupilPositionFromFirstSurfaceMm: Number.isFinite(entrancePupilPosition) ? entrancePupilPosition : undefined,
          exitPupilPositionFromLastSurfaceMm: Number.isFinite(exitPupilPosition) ? exitPupilPosition : undefined,
          pupilSamplingMode: requestedPupilSamplingMode,
          chiefRayMode: requestedChiefRayMode,
            referenceRayPupilCoordinate,
          preserveImageHeightChiefRay: requestedPreserveImageHeightChiefRay,
          resolveImageHeightChiefRayInRuntime: requestedResolveImageHeightChiefRayInRuntime,
          pupilNormalizationMode: 'fixed-entrance-pupil',
          exitPupilReferencePointMode: requestedExitPupilReferencePointMode,
          referenceMode: 'reference-sphere',
          referenceSphereOptions,
          referenceSphereGeometry: requestedGlobalReferenceSphere ? globalReferenceSphereGeometry : undefined,
          opdDisplayMode: 'raw',
        });
        const calculatedReferenceSphereGeometry = primaryResult?.referenceSphereCenter
          && Number.isFinite(Number(primaryResult?.referenceSphereRadiusMm))
          && primaryResult?.referenceSphereDirection
          ? {
              center: primaryResult.referenceSphereCenter,
              radiusMm: Number(primaryResult.referenceSphereRadiusMm),
              direction: primaryResult.referenceSphereDirection,
            }
          : undefined;
        if (requestedGlobalReferenceSphere && !globalReferenceSphereGeometry) {
          globalReferenceSphereGeometry = calculatedReferenceSphereGeometry;
        }
        const referenceSphereGeometry = requestedGlobalReferenceSphere
          ? globalReferenceSphereGeometry
          : calculatedReferenceSphereGeometry;
        const primaryChiefLaunchOrigin = primaryResult?.chiefRayLaunchOrigin;
        const primaryImageHeightChiefDirection = primaryResult?.imageHeightChiefDirection;
        const primaryImageHeightRuntimeSolvedAngle = primaryResult?.imageHeightRuntimeSolvedAngle;
        const primaryImageHeightSolverHit = primaryResult?.imageHeightSolverHit;
        const primaryChiefStopPoint = primaryResult?.chiefStopPoint;
        const primaryChiefStopDirection = primaryResult?.chiefStopDirection;
        const primaryChiefImagePoint = primaryResult?.chiefImagePoint;
        const primaryChiefImageLocalPoint = primaryResult?.chiefImageLocalPoint;
        const tracedObjectRow = tracedObjectRows[objectIndex] || {};
        const imageHeightTargetY = Number(tracedObjectRow?.__cooptImageHeightTarget?.y);
        const toNativePoint = (value: any): { x: number; y: number; z: number } | undefined => (
          [value?.x, value?.y, value?.z].every((coordinate) => Number.isFinite(Number(coordinate)))
            ? { x: Number(value.x), y: Number(value.y), z: Number(value.z) }
            : undefined
        );
        tracedFieldInputs[objectIndex] = {
          position: String(primaryResult?.usedObjectPosition || 'unknown'),
          x: Number(primaryResult?.usedObjectX),
          y: Number(primaryResult?.usedObjectY),
          chiefLaunchOrigin: toNativePoint(primaryChiefLaunchOrigin),
          imageHeightChiefRayApplied: primaryResult?.imageHeightChiefRayApplied === true,
          imageHeightChiefRayPreserved: primaryResult?.imageHeightChiefRayPreserved === true,
          imageHeightChiefRayRuntimeResolved: primaryResult?.imageHeightChiefRayRuntimeResolved === true,
          imageHeightChiefDirection: toNativePoint(primaryImageHeightChiefDirection),
          imageHeightRuntimeSolvedAngle: toNativePoint(primaryImageHeightRuntimeSolvedAngle),
          imageHeightSolverHit: toNativePoint(primaryImageHeightSolverHit),
          imageHeightSolverSurfaceIndex: Number.isInteger(Number(primaryResult?.imageHeightSolverSurfaceIndex))
            ? Number(primaryResult.imageHeightSolverSurfaceIndex)
            : undefined,
          chiefStopPoint: toNativePoint(primaryChiefStopPoint),
          chiefStopDirection: toNativePoint(primaryChiefStopDirection),
          chiefImagePoint: toNativePoint(primaryChiefImagePoint),
          chiefImageLocalPoint: toNativePoint(primaryChiefImageLocalPoint),
          chiefSurfaceTrace: Array.isArray(primaryResult?.chiefSurfaceTrace) ? primaryResult.chiefSurfaceTrace : undefined,
          sourcePosition: String(tracedObjectRow?.__cooptOriginalPosition ?? tracedObjectRow?.position ?? 'unknown'),
          imageHeightTargetY: Number.isFinite(imageHeightTargetY) ? imageHeightTargetY : undefined,
          imageHeightSolveMode: typeof tracedObjectRow?.__cooptImageHeightSolve?.mode === 'string'
            ? tracedObjectRow.__cooptImageHeightSolve.mode
            : undefined,
        };
        const fieldValues: number[] = [];
        for (const wavelength of wavelengths) {
          const request = {
            opticalSystemRows,
            sourceRows,
            objectRows: tracedObjectRows,
            objectIndex,
            wavelengthUm: wavelength.wavelengthUm,
            gridSize: comparisonGridSize,
            pupilRadiusMm: requestedPupilRadiusMode === 'per-wavelength-nominal'
              ? Number(calculateEntrancePupilDiameter(opticalSystemRows, wavelength.wavelengthUm)) / 2
              : requestedPupilRadiusMm,
            entrancePupilPositionFromFirstSurfaceMm: Number.isFinite(entrancePupilPosition) ? entrancePupilPosition : undefined,
            exitPupilPositionFromLastSurfaceMm: Number.isFinite(exitPupilPosition) ? exitPupilPosition : undefined,
            pupilSamplingMode: requestedPupilSamplingMode,
            chiefRayMode: requestedChiefRayMode,
              referenceRayPupilCoordinate,
            preserveImageHeightChiefRay: requestedPreserveImageHeightChiefRay,
            resolveImageHeightChiefRayInRuntime: requestedResolveImageHeightChiefRayInRuntime,
            pupilNormalizationMode: 'fixed-entrance-pupil',
            exitPupilReferencePointMode: requestedExitPupilReferencePointMode,
            referenceMode: 'reference-sphere',
            referenceSphereOptions,
            referenceSphereGeometry,
            opdDisplayMode: 'raw',
          };
          let result: any = await runOpdComparison(request);
          if (requestedRsiPrimaryLaunchBlend > 0 && wavelength.index !== resolvedPrimaryIndex) {
            const currentChiefLaunchOrigin = result?.chiefRayLaunchOrigin;
            const originValues = [primaryChiefLaunchOrigin?.x, primaryChiefLaunchOrigin?.y, primaryChiefLaunchOrigin?.z,
              currentChiefLaunchOrigin?.x, currentChiefLaunchOrigin?.y, currentChiefLaunchOrigin?.z];
            if (originValues.every((value) => Number.isFinite(Number(value)))) {
              const blend = requestedRsiPrimaryLaunchBlend;
              result = await runOpdComparison({
                ...request,
                sampleRayLaunchOrigin: {
                  x: Number(currentChiefLaunchOrigin.x) + blend * (Number(primaryChiefLaunchOrigin.x) - Number(currentChiefLaunchOrigin.x)),
                  y: Number(currentChiefLaunchOrigin.y) + blend * (Number(primaryChiefLaunchOrigin.y) - Number(currentChiefLaunchOrigin.y)),
                  z: Number(currentChiefLaunchOrigin.z) + blend * (Number(primaryChiefLaunchOrigin.z) - Number(currentChiefLaunchOrigin.z)),
                },
              });
            }
            primaryLaunchOverrideRequestedCount += 1;
            if (result?.sampleRayLaunchOriginApplied === true) primaryLaunchOverrideAppliedCount += 1;
          }
          const oplUm = Number(result?.chiefOplUm);
          if (!Number.isFinite(oplUm)) throw new Error(`Field ${objectIndex + 1} Colour ${wavelength.index + 1}: chief OPL unavailable`);
          fieldValues[wavelength.index] = oplUm;
          transmittedPupilCenters[objectIndex] ??= [];
          const transmittedPupilCenter = result?.transmittedPupilCenterUv;
          const legacyTransmittedPupilCenter = /\(u=([-+\d.eE]+),v=([-+\d.eE]+),r=/.exec(String(result?.chiefReferenceMode || ''));
          const transmittedPupilU = Number.isFinite(Number(transmittedPupilCenter?.u))
            ? Number(transmittedPupilCenter.u)
            : Number(legacyTransmittedPupilCenter?.[1]);
          const transmittedPupilV = Number.isFinite(Number(transmittedPupilCenter?.v))
            ? Number(transmittedPupilCenter.v)
            : Number(legacyTransmittedPupilCenter?.[2]);
          transmittedPupilCenters[objectIndex][wavelength.index] = Number.isFinite(transmittedPupilU)
            && Number.isFinite(transmittedPupilV)
            ? { u: transmittedPupilU, v: transmittedPupilV }
            : undefined;
          if (!sampledOpdMm[objectIndex]) sampledOpdMm[objectIndex] = [];
          const referenceSphereGrid = result?.referenceSphereOpdGrid;
          referenceSphereOpdGridsMm[objectIndex] ??= [];
          referenceSphereOpdGridsMm[objectIndex][wavelength.index] = Array.isArray(referenceSphereGrid)
            ? referenceSphereGrid.map((row: unknown) => Array.isArray(row)
              ? row.map((value) => {
                  const waves = Number(value);
                  return Number.isFinite(waves) ? waves * wavelength.wavelengthUm / 1000 : null;
                })
              : [])
            : [];
          const chiefRelativeGrid = result?.unreferencedOpdGrid;
          chiefRelativeOpdGridsMm[objectIndex] ??= [];
          chiefRelativeOpdGridsMm[objectIndex][wavelength.index] = Array.isArray(chiefRelativeGrid)
            ? chiefRelativeGrid.map((row: unknown) => Array.isArray(row)
              ? row.map((value) => {
                  const waves = Number(value);
                  return Number.isFinite(waves) ? waves * wavelength.wavelengthUm / 1000 : null;
                })
              : [])
            : [];
          const sampledOpdWaves = Number(referenceSphereGrid?.[comparisonYIndex]?.[comparisonXIndex]);
          sampledOpdMm[objectIndex][wavelength.index] = Number.isFinite(sampledOpdWaves)
            ? sampledOpdWaves * wavelength.wavelengthUm / 1000
            : null;
        }
        chiefOplUm[objectIndex] = fieldValues;
      }
      appendSystemTextLine(requestedDirectOpd
        ? `OPTICAL PATH DIFFERENCE (co-opt ${requestedOpdBasis === 'chief' ? 'chief-relative' : 'reference-sphere'} single ray, mm)`
        : requestedOpdBasis === 'chief'
        ? 'OPTICAL PATH DIFFERENCE (co-opt chief-relative single ray, mm)'
        : 'OPTICAL PATH DIFFERENCE (co-opt reference-sphere comparison ray, mm)');
      const pupilDescription = requestedPupilRadiusMode === 'per-wavelength-nominal'
        ? `per-wavelength-nominal(${wavelengths.map((wavelength) => `${(Number(calculateEntrancePupilDiameter(opticalSystemRows, wavelength.wavelengthUm)) / 2).toFixed(6)}mm`).join('/')})`
        : requestedPupilRadiusMm != null
          ? `nominal(${requestedPupilRadiusMm.toFixed(6)}mm)`
          : 'effective';
      appendSystemTextLine(`Ray: relative aperture X=${comparisonRelativeApertureX.toFixed(6)}, Y=${comparisonRelativeApertureY.toFixed(6)}; reference: ${requestedDirectOpd ? (requestedOpdBasis === 'chief' ? 'same Field and wavelength chief ray' : 'same Field and wavelength reference sphere') : requestedOpdBasis === 'chief' ? 'same Field and wavelength chief ray' : 'Field 1 and Primary Colour'}; sphere: ${requestedGlobalReferenceSphere ? 'Field 1 Primary shared globally' : 'primary shared per Field'}; chief=${requestedChiefRayMode}; point=${requestedChiefImagePoint}; exit=${requestedExitPupilReferencePointMode}; sampling=${requestedPupilSamplingMode}${requestedRsiPrimaryLaunchBlend > 0 ? `+primary-launch(${requestedRsiPrimaryLaunchBlend.toFixed(6)})` : ''}; pupil=${pupilDescription}; fit-basis=${requestedOpdBasis}`);
      appendSystemTextLine(requestedDirectOpd
        ? (requestedOpdBasis === 'chief' ? 'Sign: chief OPL minus sampled-ray OPL' : 'Sign: reference-sphere OPL minus sampled-ray OPL')
        : requestedOpdBasis === 'chief'
        ? 'Sign: chief OPL minus sampled-ray OPL'
        : 'Sign: spectral direction normalized about Primary Colour');
      if (requestedRsiPrimaryLaunchBlend > 0) {
        appendSystemTextLine(`RSI primary-launch override: native applied=${primaryLaunchOverrideAppliedCount}/${primaryLaunchOverrideRequestedCount}`);
      }
      appendSystemTextLine(' Field  Colour                 OPD (mm)');
      for (let objectIndex = 0; objectIndex < chiefOplUm.length; objectIndex += 1) {
        for (const wavelength of wavelengths) {
          if (requestedDirectOpd || requestedOpdBasis === 'chief') {
            const directOpdMm = (requestedOpdBasis === 'chief'
              ? chiefRelativeOpdGridsMm
              : referenceSphereOpdGridsMm)[objectIndex]?.[wavelength.index]?.[comparisonYIndex]?.[comparisonXIndex];
            const directText = directOpdMm != null && Number.isFinite(directOpdMm)
              ? Number(directOpdMm).toFixed(12).padStart(22)
              : 'n/a'.padStart(22);
            appendSystemTextLine(` ${String(objectIndex + 1).padStart(5)} ${String(wavelength.index + 1).padStart(7)} ${directText}`);
            if (requestedDetailedDiagnostics && wavelength.index === resolvedPrimaryIndex) {
              const tracedFieldInput = tracedFieldInputs[objectIndex];
              if (tracedFieldInput) {
                const launch = tracedFieldInput.chiefLaunchOrigin;
                const imageHeightChiefDirection = tracedFieldInput.imageHeightChiefDirection;
                const imageHeightRuntimeSolvedAngle = tracedFieldInput.imageHeightRuntimeSolvedAngle;
                const imageHeightSolverHit = tracedFieldInput.imageHeightSolverHit;
                const stopPoint = tracedFieldInput.chiefStopPoint;
                const stopDirection = tracedFieldInput.chiefStopDirection;
                const imagePoint = tracedFieldInput.chiefImagePoint;
                const imageLocalPoint = tracedFieldInput.chiefImageLocalPoint;
                const sourceField = `; sourceField position=${tracedFieldInput.sourcePosition}`
                  + (Number.isFinite(tracedFieldInput.imageHeightTargetY) ? ` imageHeightY=${tracedFieldInput.imageHeightTargetY.toFixed(9)}` : '')
                  + (tracedFieldInput.imageHeightSolveMode ? ` solve=${tracedFieldInput.imageHeightSolveMode}` : '');
                const imageHit = imagePoint ? `; chiefImage x=${imagePoint.x.toFixed(9)} y=${imagePoint.y.toFixed(9)} z=${imagePoint.z.toFixed(9)}`
                  + (Number.isFinite(tracedFieldInput.imageHeightTargetY) ? ` residualY=${(imagePoint.y - tracedFieldInput.imageHeightTargetY).toFixed(9)}` : '')
                  : '';
                const imageLocalHit = imageLocalPoint ? `; chiefImageLocal x=${imageLocalPoint.x.toFixed(9)} y=${imageLocalPoint.y.toFixed(9)} z=${imageLocalPoint.z.toFixed(9)}`
                  + (Number.isFinite(tracedFieldInput.imageHeightTargetY) ? ` residualY=${(imageLocalPoint.y - tracedFieldInput.imageHeightTargetY).toFixed(9)}` : '')
                  : '';
                appendSystemTextLine(
                  `       nativeField position=${tracedFieldInput.position} x=${tracedFieldInput.x.toFixed(9)} y=${tracedFieldInput.y.toFixed(9)}`
                  + (launch ? `; chiefLaunch x=${launch.x.toFixed(9)} y=${launch.y.toFixed(9)} z=${launch.z.toFixed(9)}` : '')
                  + `; imageHeightChief applied=${tracedFieldInput.imageHeightChiefRayApplied ? '1' : '0'} preserved=${tracedFieldInput.imageHeightChiefRayPreserved ? '1' : '0'} runtime=${tracedFieldInput.imageHeightChiefRayRuntimeResolved ? '1' : '0'}`
                  + (imageHeightChiefDirection ? ` dirY=${imageHeightChiefDirection.y.toFixed(9)} dirZ=${imageHeightChiefDirection.z.toFixed(9)}` : '')
                  + (imageHeightRuntimeSolvedAngle ? ` runtimeAngleY=${imageHeightRuntimeSolvedAngle.y.toFixed(9)}` : '')
                  + (imageHeightSolverHit ? `; solverHit x=${imageHeightSolverHit.x.toFixed(9)} y=${imageHeightSolverHit.y.toFixed(9)} z=${imageHeightSolverHit.z.toFixed(9)} surface=${tracedFieldInput.imageHeightSolverSurfaceIndex ?? 'unknown'}` : '')
                  + (stopPoint ? `; chiefStop x=${stopPoint.x.toFixed(9)} y=${stopPoint.y.toFixed(9)} z=${stopPoint.z.toFixed(9)}` : '')
                  + (stopDirection ? `; chiefStopDir x=${stopDirection.x.toFixed(9)} y=${stopDirection.y.toFixed(9)} z=${stopDirection.z.toFixed(9)}` : '')
                  + imageHit
                  + imageLocalHit
                  + sourceField
                );
                if (objectIndex === tracedFieldInputs.length - 1 && Array.isArray(tracedFieldInput.chiefSurfaceTrace)) {
                  appendSystemTextLine('       PRIMARY CHIEF SURFACE TRACE (local coordinates)');
                  for (const state of tracedFieldInput.chiefSurfaceTrace) {
                    appendSystemTextLine(`       REL ${String(state.surfaceIndex + 1).padStart(3)} X=${state.point.x.toFixed(5)} Y=${state.point.y.toFixed(5)} Z=${state.point.z.toFixed(5)} CX=${state.direction.x.toFixed(7)} CY=${state.direction.y.toFixed(7)} CZ=${state.direction.z.toFixed(7)}`);
                  }
                }
              }
            }
            continue;
          }
          const sampleMm = sampledOpdMm[objectIndex]?.[wavelength.index];
          const fieldPrimaryMm = sampledOpdMm[objectIndex]?.[resolvedPrimaryIndex];
          const axialColourMm = sampledOpdMm[0]?.[wavelength.index];
          const axialPrimaryMm = sampledOpdMm[0]?.[resolvedPrimaryIndex];
          if (![sampleMm, fieldPrimaryMm, axialColourMm, axialPrimaryMm].every((value) => value != null && Number.isFinite(value))) {
            appendSystemTextLine(` ${String(objectIndex + 1).padStart(5)} ${String(wavelength.index + 1).padStart(7)} ${'n/a'.padStart(22)}`);
            continue;
          }
          const rawValueMm = Number(sampleMm) - Number(fieldPrimaryMm) - Number(axialColourMm) + Number(axialPrimaryMm);
          const rawChiefOplMm = (chiefOplUm[objectIndex][wavelength.index]
            - chiefOplUm[objectIndex][resolvedPrimaryIndex]
            - chiefOplUm[0][wavelength.index]
            + chiefOplUm[0][resolvedPrimaryIndex]) / 1000;
          const spectralDirection = Math.sign(primaryWavelength - wavelength.wavelengthUm);
          const valueMm = spectralDirection === 0 ? 0 : rawValueMm * spectralDirection;
          const chiefOplValueMm = spectralDirection === 0 ? 0 : rawChiefOplMm * spectralDirection;
          appendSystemTextLine(` ${String(objectIndex + 1).padStart(5)} ${String(wavelength.index + 1).padStart(7)} ${valueMm.toFixed(12).padStart(22)}`);
          if (requestedDetailedDiagnostics) {
            const tracedFieldInput = tracedFieldInputs[objectIndex];
            if (wavelength.index === resolvedPrimaryIndex && tracedFieldInput) {
              const launch = tracedFieldInput.chiefLaunchOrigin;
              const imageHeightChiefDirection = tracedFieldInput.imageHeightChiefDirection;
              const imageHeightRuntimeSolvedAngle = tracedFieldInput.imageHeightRuntimeSolvedAngle;
              const imageHeightSolverHit = tracedFieldInput.imageHeightSolverHit;
              const stopPoint = tracedFieldInput.chiefStopPoint;
              const stopDirection = tracedFieldInput.chiefStopDirection;
              const imagePoint = tracedFieldInput.chiefImagePoint;
              const imageLocalPoint = tracedFieldInput.chiefImageLocalPoint;
              const sourceField = `; sourceField position=${tracedFieldInput.sourcePosition}`
                + (Number.isFinite(tracedFieldInput.imageHeightTargetY) ? ` imageHeightY=${tracedFieldInput.imageHeightTargetY.toFixed(9)}` : '')
                + (tracedFieldInput.imageHeightSolveMode ? ` solve=${tracedFieldInput.imageHeightSolveMode}` : '');
              const imageHit = imagePoint ? `; chiefImage x=${imagePoint.x.toFixed(9)} y=${imagePoint.y.toFixed(9)} z=${imagePoint.z.toFixed(9)}`
                + (Number.isFinite(tracedFieldInput.imageHeightTargetY) ? ` residualY=${(imagePoint.y - tracedFieldInput.imageHeightTargetY).toFixed(9)}` : '')
                : '';
              const imageLocalHit = imageLocalPoint ? `; chiefImageLocal x=${imageLocalPoint.x.toFixed(9)} y=${imageLocalPoint.y.toFixed(9)} z=${imageLocalPoint.z.toFixed(9)}`
                + (Number.isFinite(tracedFieldInput.imageHeightTargetY) ? ` residualY=${(imageLocalPoint.y - tracedFieldInput.imageHeightTargetY).toFixed(9)}` : '')
                : '';
              appendSystemTextLine(
                `       nativeField position=${tracedFieldInput.position} x=${tracedFieldInput.x.toFixed(9)} y=${tracedFieldInput.y.toFixed(9)}`
                + (launch ? `; chiefLaunch x=${launch.x.toFixed(9)} y=${launch.y.toFixed(9)} z=${launch.z.toFixed(9)}` : '')
                + `; imageHeightChief applied=${tracedFieldInput.imageHeightChiefRayApplied ? '1' : '0'} preserved=${tracedFieldInput.imageHeightChiefRayPreserved ? '1' : '0'} runtime=${tracedFieldInput.imageHeightChiefRayRuntimeResolved ? '1' : '0'}`
                + (imageHeightChiefDirection ? ` dirY=${imageHeightChiefDirection.y.toFixed(9)} dirZ=${imageHeightChiefDirection.z.toFixed(9)}` : '')
                + (imageHeightRuntimeSolvedAngle ? ` runtimeAngleY=${imageHeightRuntimeSolvedAngle.y.toFixed(9)}` : '')
                + (imageHeightSolverHit ? `; solverHit x=${imageHeightSolverHit.x.toFixed(9)} y=${imageHeightSolverHit.y.toFixed(9)} z=${imageHeightSolverHit.z.toFixed(9)} surface=${tracedFieldInput.imageHeightSolverSurfaceIndex ?? 'unknown'}` : '')
                + (stopPoint ? `; chiefStop x=${stopPoint.x.toFixed(9)} y=${stopPoint.y.toFixed(9)} z=${stopPoint.z.toFixed(9)}` : '')
                + (stopDirection ? `; chiefStopDir x=${stopDirection.x.toFixed(9)} y=${stopDirection.y.toFixed(9)} z=${stopDirection.z.toFixed(9)}` : '')
                + imageHit
                + imageLocalHit
                + sourceField
              );
            }
            appendSystemTextLine(`       chiefOpl=${(chiefOplUm[objectIndex][wavelength.index] / 1000).toFixed(12)} mm referenceRayDoubleDifference=${valueMm.toFixed(12)} mm chiefOplDoubleDifference=${chiefOplValueMm.toFixed(12)} mm`);
            const transmittedPupilCenter = transmittedPupilCenters[objectIndex]?.[wavelength.index];
            if (transmittedPupilCenter) appendSystemTextLine(`       transmittedPupilCenter=(u=${transmittedPupilCenter.u.toFixed(6)}, v=${transmittedPupilCenter.v.toFixed(6)})`);
          }
        }
      }
      if (requestedPupilFit) {
        const comparedOpdGridsMm = requestedOpdBasis === 'chief'
          ? chiefRelativeOpdGridsMm
          : referenceSphereOpdGridsMm;
        const optalixOpdMm = [
          [0, 0, 0],
          [-0.1390136788e-6, 0, -0.1704400887e-7],
          [-0.5399195118e-6, 0, -0.2118370048e-6],
          [-0.1149045936e-5, 0, -0.4508545359e-6],
          [-0.1897933338e-5, 0, -0.7449473429e-6],
          [-0.2705162210e-5, 0, -0.1062509376e-5],
          [-0.3458456163e-5, 0, -0.1359999430e-5],
          [-0.4043324140e-5, 0, -0.1593527671e-5],
          [-0.4358425116e-5, 0, -0.1724933917e-5],
          [-0.4348004005e-5, 0, -0.1733990111e-5],
          [-0.4017089637e-5, 0, -0.1623581745e-5],
        ];
        type FitCandidate = { x: number; y: number; maeMm: number; rmseMm: number };
        const gridSize = comparedOpdGridsMm[0]?.[0]?.length ?? 0;
        const bestCandidates: Record<string, FitCandidate | undefined> = {};
        const calculateMetrics = (valuesMm: number[][], colourIndexes: number[]) => {
          let sumAbs = 0;
          let sumSquares = 0;
          let count = 0;
          for (let fieldIndex = 1; fieldIndex < objectRows.length; fieldIndex += 1) {
            for (const colourIndex of colourIndexes) {
              const deltaMm = valuesMm[fieldIndex]?.[colourIndex] - optalixOpdMm[fieldIndex][colourIndex];
              if (!Number.isFinite(deltaMm)) continue;
              sumAbs += Math.abs(deltaMm);
              sumSquares += deltaMm * deltaMm;
              count += 1;
            }
          }
          return count > 0 ? { maeMm: sumAbs / count, rmseMm: Math.sqrt(sumSquares / count) } : undefined;
        };
        const evaluateCandidate = (xIndex: number, yIndex: number, colourIndexes: number[]): FitCandidate | undefined => {
          let sumAbs = 0;
          let sumSquares = 0;
          let count = 0;
          for (let fieldIndex = 1; fieldIndex < objectRows.length; fieldIndex += 1) {
            for (const colourIndex of colourIndexes) {
              const sampleMm = comparedOpdGridsMm[fieldIndex]?.[colourIndex]?.[yIndex]?.[xIndex];
              const fieldPrimaryMm = comparedOpdGridsMm[fieldIndex]?.[resolvedPrimaryIndex]?.[yIndex]?.[xIndex];
              const axialColourMm = comparedOpdGridsMm[0]?.[colourIndex]?.[yIndex]?.[xIndex];
              const axialPrimaryMm = comparedOpdGridsMm[0]?.[resolvedPrimaryIndex]?.[yIndex]?.[xIndex];
              if (![sampleMm, fieldPrimaryMm, axialColourMm, axialPrimaryMm].every((value) => value != null && Number.isFinite(value))) return undefined;
              const direction = Math.sign(primaryWavelength - wavelengths[colourIndex].wavelengthUm);
              const predictedMm = direction * (Number(sampleMm) - Number(fieldPrimaryMm) - Number(axialColourMm) + Number(axialPrimaryMm));
              const deltaMm = predictedMm - optalixOpdMm[fieldIndex][colourIndex];
              sumAbs += Math.abs(deltaMm);
              sumSquares += deltaMm * deltaMm;
              count += 1;
            }
          }
          return count > 0 ? {
            x: -1 + 2 * xIndex / (gridSize - 1),
            y: -1 + 2 * yIndex / (gridSize - 1),
            maeMm: sumAbs / count,
            rmseMm: Math.sqrt(sumSquares / count),
          } : undefined;
        };
        for (let yIndex = 0; yIndex < gridSize; yIndex += 1) {
          for (let xIndex = 0; xIndex < gridSize; xIndex += 1) {
            const pupilX = -1 + 2 * xIndex / (gridSize - 1);
            const pupilY = -1 + 2 * yIndex / (gridSize - 1);
            if (pupilX * pupilX + pupilY * pupilY > 1 + 1e-9) continue;
            for (const [label, colourIndexes] of [['combined', [0, 2]], ['colour-1', [0]], ['colour-3', [2]]] as const) {
              const candidate = evaluateCandidate(xIndex, yIndex, colourIndexes);
              if (candidate && (!bestCandidates[label] || candidate.maeMm < bestCandidates[label]!.maeMm)) bestCandidates[label] = candidate;
            }
          }
        }
        appendSystemTextLine(`OPTALIX FIXED-PUPIL 2D FIT (Fields 2-11; ${requestedOpdBasis === 'chief' ? 'chief-relative OPD' : 'referenceRayDoubleDifference'})`);
        for (const label of ['combined', 'colour-1', 'colour-3']) {
          const candidate = bestCandidates[label];
          if (candidate) appendSystemTextLine(` ${label.padEnd(10)} ray=(${candidate.x.toFixed(6)}, ${candidate.y.toFixed(6)}) MAE=${(candidate.maeMm * 1e6).toFixed(6)} um RMSE=${(candidate.rmseMm * 1e6).toFixed(6)} um`);
        }
        const pupilMeanMm = comparedOpdGridsMm.map((field) => field.map((grid) => {
          let sum = 0;
          let count = 0;
          for (const row of grid || []) {
            for (const value of row || []) {
              if (value != null && Number.isFinite(value)) {
                sum += value;
                count += 1;
              }
            }
          }
          return count > 0 ? sum / count : Number.NaN;
        }));
        const pupilMeanDoubleDifferenceMm = pupilMeanMm.map((field, fieldIndex) => field.map((value, colourIndex) => {
          const direction = Math.sign(primaryWavelength - wavelengths[colourIndex].wavelengthUm);
          return direction * (value - pupilMeanMm[fieldIndex][resolvedPrimaryIndex] - pupilMeanMm[0][colourIndex] + pupilMeanMm[0][resolvedPrimaryIndex]);
        }));
        const pupilMeanMetrics = calculateMetrics(pupilMeanDoubleDifferenceMm, [0, 2]);
        if (pupilMeanMetrics) appendSystemTextLine(` pupil-mean  ray=(pupil average) MAE=${(pupilMeanMetrics.maeMm * 1e6).toFixed(6)} um RMSE=${(pupilMeanMetrics.rmseMm * 1e6).toFixed(6)} um`);
        if (requestedOpdBasis === 'chief') {
          type FieldPrimaryCandidate = FitCandidate & { sign: number };
          let bestFieldPrimary: FieldPrimaryCandidate | undefined;
          for (let yIndex = 0; yIndex < gridSize; yIndex += 1) {
            for (let xIndex = 0; xIndex < gridSize; xIndex += 1) {
              const pupilX = -1 + 2 * xIndex / (gridSize - 1);
              const pupilY = -1 + 2 * yIndex / (gridSize - 1);
              if (pupilX * pupilX + pupilY * pupilY > 1 + 1e-9) continue;
              for (const sign of [1, -1]) {
                let sumAbs = 0;
                let sumSquares = 0;
                let count = 0;
                let valid = true;
                for (let fieldIndex = 0; fieldIndex < objectRows.length && valid; fieldIndex += 1) {
                  for (const colourIndex of [0, 2]) {
                    const sampleMm = chiefRelativeOpdGridsMm[fieldIndex]?.[colourIndex]?.[yIndex]?.[xIndex];
                    const primaryMm = chiefRelativeOpdGridsMm[fieldIndex]?.[resolvedPrimaryIndex]?.[yIndex]?.[xIndex];
                    if (![sampleMm, primaryMm].every((value) => value != null && Number.isFinite(value))) {
                      valid = false;
                      break;
                    }
                    const predictedMm = sign * (Number(sampleMm) - Number(primaryMm));
                    const deltaMm = predictedMm - optalixOpdMm[fieldIndex][colourIndex];
                    sumAbs += Math.abs(deltaMm);
                    sumSquares += deltaMm * deltaMm;
                    count += 1;
                  }
                }
                const candidate = valid && count > 0 ? {
                  x: pupilX,
                  y: pupilY,
                  sign,
                  maeMm: sumAbs / count,
                  rmseMm: Math.sqrt(sumSquares / count),
                } : undefined;
                if (candidate && (!bestFieldPrimary || candidate.maeMm < bestFieldPrimary.maeMm)) bestFieldPrimary = candidate;
              }
            }
          }
          if (bestFieldPrimary) {
            appendSystemTextLine(` chief-primary ray=(${bestFieldPrimary.x.toFixed(6)}, ${bestFieldPrimary.y.toFixed(6)}) sign=${bestFieldPrimary.sign > 0 ? '+' : '-'} MAE=${(bestFieldPrimary.maeMm * 1e6).toFixed(6)} um RMSE=${(bestFieldPrimary.rmseMm * 1e6).toFixed(6)} um`);
          }
          let bestChiefAbsolute: FieldPrimaryCandidate | undefined;
          for (let yIndex = 0; yIndex < gridSize; yIndex += 1) {
            for (let xIndex = 0; xIndex < gridSize; xIndex += 1) {
              const pupilX = -1 + 2 * xIndex / (gridSize - 1);
              const pupilY = -1 + 2 * yIndex / (gridSize - 1);
              if (pupilX * pupilX + pupilY * pupilY > 1 + 1e-9) continue;
              for (const sign of [1, -1]) {
                let sumAbs = 0;
                let sumSquares = 0;
                let count = 0;
                let valid = true;
                for (let fieldIndex = 0; fieldIndex < objectRows.length && valid; fieldIndex += 1) {
                  for (const colourIndex of wavelengths.map(({ index }) => index)) {
                    const sampleMm = chiefRelativeOpdGridsMm[fieldIndex]?.[colourIndex]?.[yIndex]?.[xIndex];
                    if (!(sampleMm != null && Number.isFinite(sampleMm))) {
                      valid = false;
                      break;
                    }
                    const deltaMm = sign * Number(sampleMm) - optalixOpdMm[fieldIndex][colourIndex];
                    sumAbs += Math.abs(deltaMm);
                    sumSquares += deltaMm * deltaMm;
                    count += 1;
                  }
                }
                const candidate = valid && count > 0 ? {
                  x: pupilX,
                  y: pupilY,
                  sign,
                  maeMm: sumAbs / count,
                  rmseMm: Math.sqrt(sumSquares / count),
                } : undefined;
                if (candidate && (!bestChiefAbsolute || candidate.maeMm < bestChiefAbsolute.maeMm)) bestChiefAbsolute = candidate;
              }
            }
          }
          if (bestChiefAbsolute) {
            appendSystemTextLine(` chief-absolute ray=(${bestChiefAbsolute.x.toFixed(6)}, ${bestChiefAbsolute.y.toFixed(6)}) sign=${bestChiefAbsolute.sign > 0 ? '+' : '-'} MAE=${(bestChiefAbsolute.maeMm * 1e6).toFixed(6)} um RMSE=${(bestChiefAbsolute.rmseMm * 1e6).toFixed(6)} um`);
          }
          type ChiefOplCandidate = { sign: number; maeMm: number; rmseMm: number };
          let bestChiefOplPrimary: ChiefOplCandidate | undefined;
          for (const sign of [1, -1]) {
            let sumAbs = 0;
            let sumSquares = 0;
            let count = 0;
            let valid = true;
            for (let fieldIndex = 0; fieldIndex < objectRows.length && valid; fieldIndex += 1) {
              const primaryOplUm = chiefOplUm[fieldIndex]?.[resolvedPrimaryIndex];
              if (!Number.isFinite(primaryOplUm)) {
                valid = false;
                break;
              }
              for (const colourIndex of wavelengths.map(({ index }) => index)) {
                const sampleOplUm = chiefOplUm[fieldIndex]?.[colourIndex];
                if (!Number.isFinite(sampleOplUm)) {
                  valid = false;
                  break;
                }
                const predictedMm = sign * (sampleOplUm - primaryOplUm) / 1000;
                const deltaMm = predictedMm - optalixOpdMm[fieldIndex][colourIndex];
                sumAbs += Math.abs(deltaMm);
                sumSquares += deltaMm * deltaMm;
                count += 1;
              }
            }
            const candidate = valid && count > 0 ? {
              sign,
              maeMm: sumAbs / count,
              rmseMm: Math.sqrt(sumSquares / count),
            } : undefined;
            if (candidate && (!bestChiefOplPrimary || candidate.maeMm < bestChiefOplPrimary.maeMm)) bestChiefOplPrimary = candidate;
          }
          if (bestChiefOplPrimary) {
            appendSystemTextLine(` chief-opl-primary ray=(stop-center) sign=${bestChiefOplPrimary.sign > 0 ? '+' : '-'} MAE=${(bestChiefOplPrimary.maeMm * 1e6).toFixed(6)} um RMSE=${(bestChiefOplPrimary.rmseMm * 1e6).toFixed(6)} um`);
          }
        }
        type ChiefOplCrossTermCandidate = { mode: 'raw' | 'spectral'; sign: number; maeMm: number; rmseMm: number };
        let bestChiefOplCrossTerm: ChiefOplCrossTermCandidate | undefined;
        for (const mode of ['raw', 'spectral'] as const) {
          for (const sign of [1, -1]) {
            let sumAbs = 0;
            let sumSquares = 0;
            let count = 0;
            let valid = true;
            for (let fieldIndex = 0; fieldIndex < objectRows.length && valid; fieldIndex += 1) {
              const fieldPrimaryOplUm = chiefOplUm[fieldIndex]?.[resolvedPrimaryIndex];
              const axialPrimaryOplUm = chiefOplUm[0]?.[resolvedPrimaryIndex];
              if (!(Number.isFinite(fieldPrimaryOplUm) && Number.isFinite(axialPrimaryOplUm))) {
                valid = false;
                break;
              }
              for (const wavelength of wavelengths) {
                const sampleOplUm = chiefOplUm[fieldIndex]?.[wavelength.index];
                const axialOplUm = chiefOplUm[0]?.[wavelength.index];
                if (!(Number.isFinite(sampleOplUm) && Number.isFinite(axialOplUm))) {
                  valid = false;
                  break;
                }
                const spectralDirection = mode === 'spectral'
                  ? Math.sign(primaryWavelength - wavelength.wavelengthUm)
                  : 1;
                const predictedMm = sign * spectralDirection * (
                  sampleOplUm - fieldPrimaryOplUm - axialOplUm + axialPrimaryOplUm
                ) / 1000;
                const deltaMm = predictedMm - optalixOpdMm[fieldIndex][wavelength.index];
                sumAbs += Math.abs(deltaMm);
                sumSquares += deltaMm * deltaMm;
                count += 1;
              }
            }
            const candidate = valid && count > 0 ? {
              mode,
              sign,
              maeMm: sumAbs / count,
              rmseMm: Math.sqrt(sumSquares / count),
            } : undefined;
            if (candidate && (!bestChiefOplCrossTerm || candidate.maeMm < bestChiefOplCrossTerm.maeMm)) bestChiefOplCrossTerm = candidate;
          }
        }
        if (bestChiefOplCrossTerm) {
          appendSystemTextLine(` chief-opl-cross-term ray=(stop-center) mode=${bestChiefOplCrossTerm.mode} sign=${bestChiefOplCrossTerm.sign > 0 ? '+' : '-'} MAE=${(bestChiefOplCrossTerm.maeMm * 1e6).toFixed(6)} um RMSE=${(bestChiefOplCrossTerm.rmseMm * 1e6).toFixed(6)} um`);
        }
      }
      appendSystemTextLine(`Backend: ${String(chiefOplUm.length > 0 ? 'web-rust-wasm-native-api:map' : 'unknown')}`);
    } catch (error) {
      appendSystemTextLine(`opd: failed: ${String((error as any)?.message || error)}`);
    }
  };

  const runSystemTextCommand = (rawCommand: string) => {
    const command = String(rawCommand ?? '').trim();
    if (!command) return;
    setSystemTextHistory((prev) => {
      const next = [command, ...prev.filter((entry) => entry !== command)];
      return next.slice(0, 30);
    });
    const lower = command.toLowerCase();
    if (lower === 'wav') {
      setSystemTextLines([]);
    }
    if (lower === 'cls') {
      setSystemTextLines([]);
      return;
    }
    appendSystemTextLine(`> ${command}`);
    if (lower === 'help') {
      appendSystemTextLine('Commands: cls, help, wasm reload, opd [chief=stop|entrance|transmitted] [point=chief|paraxial|target] [exit=chief|center] [ray=x,y] [sampling=entrance|stop] [pupil=effective|nominal|per-wavelength-nominal] [sphere=field|global] [basis=sphere|chief] [direct=1] [rsi=0..1] [imgchief=1|runtime] [fit=1] [detail=1], wav [grid] [pupil=radius] [sphere=primary|per-wavelength] [point=chief|paraxial|target|per-wavelength-best-focus|paraxial-fixed-sphere|per-wavelength-best-focus-fixed-sphere] [exit=chief|center] [mode=raw|piston|piston-tilt|reference-sphere-tilt|piston-defocus|piston-tilt-defocus] [defocus=0..1] [norm=fixed|effective] [detail=1] [wl=w1,w2,...] [wt=w1,w2,...]');
      return;
    }
    if (lower === 'wasm reload') {
      void (async () => {
        try {
          const { reloadRustRayTracingWasm, getRustRayTracingWasmInitError } = await import('../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
          const api = await reloadRustRayTracingWasm();
          appendSystemTextLine(api
            ? 'wasm: reloaded current artifact.'
            : `wasm: reload failed: ${String(getRustRayTracingWasmInitError?.() || 'unknown initialization error')}`);
        } catch (error) {
          appendSystemTextLine(`wasm: reload failed: ${String((error as any)?.message || error)}`);
        }
      })();
      return;
    }
    if (lower === 'opd' || lower.startsWith('opd ')) {
      const detailArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^detail=/i.test(argument));
      const requestedDetailedDiagnostics = detailArgument
        ? ['1', 'true', 'yes', 'on'].includes(detailArgument.slice(detailArgument.indexOf('=') + 1).toLowerCase())
        : false;
      const chiefArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^chief=/i.test(argument));
      const chiefValue = chiefArgument?.slice(chiefArgument.indexOf('=') + 1).toLowerCase();
      const requestedChiefRayMode = chiefValue === 'entrance'
        ? 'entrance-pupil-center'
        : chiefValue === 'transmitted'
          ? 'transmitted-pupil-center'
          : 'stop-center';
      const pointArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^point=/i.test(argument));
      const pointValue = pointArgument?.slice(pointArgument.indexOf('=') + 1).toLowerCase();
      const requestedChiefImagePoint = pointValue === 'paraxial'
        ? 'paraxial-image-point'
        : pointValue === 'target'
          ? 'target-surface-center'
          : 'chief-ray-image-point';
      const exitArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^exit=/i.test(argument));
      const exitValue = exitArgument?.slice(exitArgument.indexOf('=') + 1).toLowerCase();
      const requestedExitPupilReferencePointMode = exitValue === 'center'
        ? 'exit-pupil-center'
        : 'chief-ray-intersection';
      const rayArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^ray=/i.test(argument));
      const rayValues = rayArgument?.slice(rayArgument.indexOf('=') + 1).split(',').map(Number);
      const requestedComparisonRay = rayValues?.length === 2
        && rayValues.every((value) => Number.isFinite(value) && Math.abs(value) <= 1)
        ? { x: rayValues[0], y: rayValues[1] }
        : undefined;
      const samplingArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^sampling=/i.test(argument));
      const requestedPupilSamplingMode = samplingArgument?.slice(samplingArgument.indexOf('=') + 1).toLowerCase() === 'stop'
        ? 'stop'
        : 'entrance';
      const fitArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^fit=/i.test(argument));
      const requestedPupilFit = fitArgument
        ? ['1', 'true', 'yes', 'on'].includes(fitArgument.slice(fitArgument.indexOf('=') + 1).toLowerCase())
        : false;
      const sphereArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^sphere=/i.test(argument));
      const requestedGlobalReferenceSphere = sphereArgument?.slice(sphereArgument.indexOf('=') + 1).toLowerCase() === 'global';
      const basisArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^basis=/i.test(argument));
      const requestedOpdBasis = basisArgument?.slice(basisArgument.indexOf('=') + 1).toLowerCase() === 'chief'
        ? 'chief'
        : 'sphere';
      const pupilArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^pupil=/i.test(argument));
      const pupilValue = pupilArgument?.slice(pupilArgument.indexOf('=') + 1).toLowerCase();
      const requestedPupilRadiusMode = pupilValue === 'per-wavelength-nominal'
        ? 'per-wavelength-nominal'
        : pupilValue === 'nominal'
          ? 'nominal'
          : 'effective';
      const directArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^direct=/i.test(argument));
      const requestedDirectOpd = directArgument
        ? ['1', 'true', 'yes', 'on'].includes(directArgument.slice(directArgument.indexOf('=') + 1).toLowerCase())
        : false;
      const rsiArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^rsi=/i.test(argument));
      const rsiValue = rsiArgument?.slice(rsiArgument.indexOf('=') + 1).toLowerCase();
      const requestedRsiPrimaryLaunchBlend = ['true', 'yes', 'on'].includes(String(rsiValue))
        ? 1
        : Math.min(1, Math.max(0, Number(rsiValue)));
      const imageHeightChiefArgument = command.slice(3).trim().split(/\s+/).find((argument) => /^imgchief=/i.test(argument));
      const imageHeightChiefValue = imageHeightChiefArgument?.slice(imageHeightChiefArgument.indexOf('=') + 1).toLowerCase();
      const requestedResolveImageHeightChiefRayInRuntime = imageHeightChiefValue === 'runtime';
      const requestedPreserveImageHeightChiefRay = imageHeightChiefArgument
        ? requestedResolveImageHeightChiefRayInRuntime || ['1', 'true', 'yes', 'on'].includes(String(imageHeightChiefValue))
        : false;
      void runChiefRayOpdConsoleCommand(requestedDetailedDiagnostics, requestedChiefRayMode, requestedChiefImagePoint, requestedExitPupilReferencePointMode, requestedComparisonRay, requestedPupilSamplingMode, requestedPupilFit, requestedGlobalReferenceSphere, requestedOpdBasis, requestedPupilRadiusMode, requestedDirectOpd, Number.isFinite(requestedRsiPrimaryLaunchBlend) ? requestedRsiPrimaryLaunchBlend : 0, requestedPreserveImageHeightChiefRay, requestedResolveImageHeightChiefRayInRuntime);
      return;
    }
    if (lower === 'wav' || lower.startsWith('wav ')) {
      const commandArguments = command.slice(3).trim().split(/\s+/).filter(Boolean);
      const gridArgument = Number(commandArguments[0]);
      const pupilArgument = commandArguments.find((argument) => /^pupil=/i.test(argument));
      const requestedPupilRadiusMm = pupilArgument ? Number(pupilArgument.slice(pupilArgument.indexOf('=') + 1)) : undefined;
      const wavelengthArgument = commandArguments.find((argument) => /^wl=/i.test(argument));
      const requestedWavelengthsUm = wavelengthArgument
        ? wavelengthArgument.slice(wavelengthArgument.indexOf('=') + 1).split(',').map(Number).filter((value) => Number.isFinite(value) && value > 0)
        : undefined;
      const weightArgument = commandArguments.find((argument) => /^wt=/i.test(argument));
      const requestedRelativeWeights = weightArgument
        ? weightArgument.slice(weightArgument.indexOf('=') + 1).split(',').map(Number).filter((value) => Number.isFinite(value) && value >= 0)
        : undefined;
      const sphereArgument = commandArguments.find((argument) => /^sphere=/i.test(argument));
      const sphereValue = sphereArgument?.slice(sphereArgument.indexOf('=') + 1).toLowerCase();
      const requestedSphereWavelengthMode = sphereValue === 'per-wavelength'
        ? 'per-wavelength'
        : sphereValue === 'primary'
          ? 'primary-wavelength'
          : undefined;
      const pointArgument = commandArguments.find((argument) => /^point=/i.test(argument));
      const pointValue = pointArgument?.slice(pointArgument.indexOf('=') + 1).toLowerCase();
      const fixedReferenceSphereGeometry = pointValue?.endsWith('-fixed-sphere') === true;
      const imagePointValue = fixedReferenceSphereGeometry
        ? pointValue?.slice(0, -'-fixed-sphere'.length)
        : pointValue;
      const requestedChiefImagePoint = imagePointValue === 'paraxial'
        ? 'paraxial-image-point'
        : imagePointValue === 'target'
          ? 'target-surface-center'
          : imagePointValue === 'per-wavelength-best-focus'
            ? 'per-wavelength-best-focus-point'
          : imagePointValue === 'chief'
            ? 'chief-ray-image-point'
            : undefined;
      const modeArgument = commandArguments.find((argument) => /^mode=/i.test(argument));
      const modeValue = modeArgument?.slice(modeArgument.indexOf('=') + 1).toLowerCase();
      const requestedDisplayMode = modeValue === 'piston-tilt-defocus'
        ? 'pistonTiltDefocusRemoved'
        : modeValue === 'piston-tilt'
        ? 'pistonTiltRemoved'
        : modeValue === 'reference-sphere-tilt'
        ? 'referenceSphereTiltRemoved'
        : modeValue === 'piston-defocus'
        ? 'pistonDefocusRemoved'
        : modeValue === 'piston'
          ? 'pistonRemoved'
          : modeValue === 'raw'
            ? 'raw'
            : undefined;
      const normArgument = commandArguments.find((argument) => /^norm=/i.test(argument));
      const normValue = normArgument?.slice(normArgument.indexOf('=') + 1).toLowerCase();
      const requestedPupilNormalizationMode = normValue === 'effective'
        ? 'effective-transmitted-pupil'
        : normValue === 'fixed'
          ? 'fixed-entrance-pupil'
          : undefined;
      const exitArgument = commandArguments.find((argument) => /^exit=/i.test(argument));
      const exitValue = exitArgument?.slice(exitArgument.indexOf('=') + 1).toLowerCase();
      const requestedExitPupilReferencePointMode = exitValue === 'center'
        ? 'exit-pupil-center'
        : exitValue === 'chief'
          ? 'chief-ray-intersection'
          : undefined;
      const fieldArgument = commandArguments.find((argument) => /^field=/i.test(argument));
      const fieldValue = fieldArgument?.slice(fieldArgument.indexOf('=') + 1).toLowerCase();
      const requestedFieldMode = fieldValue === 'per-wavelength'
        ? 'per-wavelength'
        : 'primary-fixed';
      const chiefArgument = commandArguments.find((argument) => /^chief=/i.test(argument));
      const chiefValue = chiefArgument?.slice(chiefArgument.indexOf('=') + 1).toLowerCase();
      const requestedChiefRayMode = chiefValue === 'entrance'
        ? 'entrance-pupil-center'
        : chiefValue === 'transmitted'
          ? 'transmitted-pupil-center'
          : chiefValue === 'stop'
            ? 'stop-center'
            : undefined;
      const referenceRayArgument = commandArguments.find((argument) => /^ref-ray=/i.test(argument));
      const referenceRayValue = referenceRayArgument?.slice(referenceRayArgument.indexOf('=') + 1).toLowerCase();
      const requestedReferenceRayPupilCoordinate = referenceRayValue === 'near-chief'
        ? { x: -1 / 32, y: 0 }
        : undefined;
      const termsArgument = commandArguments.find((argument) => /^terms=/i.test(argument));
      const requestedOpdTermDiagnostics = termsArgument?.slice(termsArgument.indexOf('=') + 1) === '1';
      const defocusArgument = commandArguments.find((argument) => /^defocus=/i.test(argument));
      const requestedDefocusScale = defocusArgument
        ? Number(defocusArgument.slice(defocusArgument.indexOf('=') + 1))
        : undefined;
      const detailArgument = commandArguments.find((argument) => /^detail=/i.test(argument));
      const requestedDetailedDiagnostics = detailArgument
        ? ['1', 'true', 'yes', 'on'].includes(detailArgument.slice(detailArgument.indexOf('=') + 1).toLowerCase())
        : false;
      const gridSize = Number.isFinite(gridArgument)
        ? Math.max(17, Math.min(257, Math.floor(gridArgument)))
        : 129;
      void runWavefrontRmsConsoleCommand(gridSize, requestedPupilRadiusMm, requestedWavelengthsUm, requestedRelativeWeights, requestedSphereWavelengthMode, requestedChiefImagePoint, requestedDisplayMode, requestedPupilNormalizationMode, requestedDefocusScale, fixedReferenceSphereGeometry, requestedExitPupilReferencePointMode, requestedFieldMode, requestedChiefRayMode, requestedReferenceRayPupilCoordinate, requestedDetailedDiagnostics, requestedOpdTermDiagnostics);
      return;
    }
    appendSystemTextLine(`Command not identified : ${command}`);
  };

  useEffect(() => {
    setSystemTextLines((prev) => {
      if (prev.length > 0) return prev;
      return [
        'co-opt System Console',
        'Type "help" for commands. Type "cls" to clear window.',
      ];
    });
  }, []);

  useEffect(() => {
    const el = systemTextLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [systemTextLines]);

  useEffect(() => {
    const wAny = window as any;
    const previousWriter = wAny.__cooptTextWindowWrite;
    const nextWriter = (message: any) => {
      appendSystemTextLine(message);
    };
    wAny.__cooptTextWindowWrite = nextWriter;
    return () => {
      try {
        if (wAny.__cooptTextWindowWrite === nextWriter) {
          if (typeof previousWriter === 'function') {
            wAny.__cooptTextWindowWrite = previousWriter;
          } else {
            delete wAny.__cooptTextWindowWrite;
          }
        }
      } catch (_) {}
    };
  }, []);

  useEffect(() => {
    const phase = String(optimizeState?.phase ?? '').trim().toLowerCase();
    const iterations = Number(optimizeState?.iterations ?? 0);
    const score = Number(optimizeState?.requirementScoreAfter ?? optimizeState?.meritAfter);
    const best = Number(optimizeState?.bestRequirementScore ?? optimizeState?.best);
    const signature = [
      optRunning ? '1' : '0',
      phase,
      String(iterations),
      Number.isFinite(score) ? score.toFixed(6) : '-',
      Number.isFinite(best) ? best.toFixed(6) : '-',
      String(optEscapeFunctionHeight),
      String(optEscapeFunctionWidth),
    ].join('|');
    if (signature === lastOptimizeLogSignatureRef.current) return;
    lastOptimizeLogSignatureRef.current = signature;

    if (optRunning) return;

    if (phase === 'done' || phase === 'stopped' || phase === 'error') {
      appendSystemTextLine(
        `[Optimize] ${phase} score=${Number.isFinite(score) ? score.toFixed(6) : '-'} best=${Number.isFinite(best) ? best.toFixed(6) : '-'} H=${optEscapeFunctionHeight} W=${optEscapeFunctionWidth}`
      );
    }
  }, [optRunning, optimizeState, optEscapeFunctionHeight, optEscapeFunctionWidth]);

  const syncWorkspaceUiAfterOpen = () => {
    const run = async () => {
      try {
        const w = window as any;
        if (typeof w.initializeAllTables === 'function') {
          w.initializeAllTables();
        }
      } catch (_) {}
      try {
        const mgr = (window as any).ConfigurationManager;
        if (mgr && typeof mgr.loadActiveConfigurationToTables === 'function') {
          await Promise.resolve(mgr.loadActiveConfigurationToTables({ applyToUI: true }));
        } else if (typeof (window as any).loadActiveConfigurationToTables === 'function') {
          await Promise.resolve((window as any).loadActiveConfigurationToTables({ applyToUI: true }));
        }
      } catch (_) {}
      try { requestRefreshBlockInspector(window); } catch (_) {}
      try { if (typeof (window as any).refreshBlockInspector === 'function') (window as any).refreshBlockInspector(); } catch (_) {}
      try { if (typeof (window as any).refreshAllUI === 'function') (window as any).refreshAllUI(); } catch (_) {}
    };

    void run();
    setTimeout(() => { void run(); }, 120);
    setTimeout(() => { void run(); }, 420);
  };

  const openMdiWindow = (key: WorkspaceFocus) => {
    setMdiWindowStates(prev => {
      const max = getNextMdiZIndex();
      const current = prev[key];
      const normalized = normalizeMdiBoundsForOpen(
        {
          x: current?.x,
          y: current?.y,
          width: current?.width,
          height: current?.height,
        },
        {
          x: 32,
          y: 32,
          width: 900,
          height: 620,
        }
      );
      return {
        ...prev,
        [key]: {
          ...current,
          open: true,
          minimized: false,
          maximized: false,
          restoreBounds: null,
          x: normalized.x,
          y: normalized.y,
          width: normalized.width,
          height: normalized.height,
          zIndex: max,
        }
      };
    });
    selectWorkspaceTab(key);
    syncWorkspaceUiAfterOpen();
  };

  (window as any).__cooptOpenDesignConnection = (detail: {
    connectionId?: string;
    fromComponentId?: string;
    toComponentId?: string;
  }) => {
    openMdiWindow('intent');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(DESIGN_CONNECTION_SELECTED_EVENT, { detail }));
    }, 120);
  };

  const closeMdiWindow = (key: WorkspaceFocus) => {
    setMdiWindowStates(prev => ({ ...prev, [key]: { ...prev[key], open: false } }));
  };

  const minimizeMdiWindow = (key: WorkspaceFocus) => {
    setMdiWindowStates(prev => ({ ...prev, [key]: { ...prev[key], minimized: !prev[key].minimized } }));
  };

  const bringMdiToFront = (key: WorkspaceFocus) => {
    setMdiWindowStates(prev => {
      const max = getNextMdiZIndex();
      return { ...prev, [key]: { ...prev[key], zIndex: max } };
    });
    selectWorkspaceTab(key);
  };

  const toggleMdiWindowMaximize = (key: WorkspaceFocus) => {
    const nextZ = getNextMdiZIndex();
    const desktop = getMdiDesktopBounds();
    setMdiWindowStates((prev) => {
      const w = prev[key];
      if (!w) return prev;
      if (w.maximized) {
        const restore = w.restoreBounds;
        if (restore) {
          return {
            ...prev,
            [key]: {
              ...w,
              maximized: false,
              x: restore.x,
              y: restore.y,
              width: restore.width,
              height: restore.height,
              zIndex: nextZ,
            }
          };
        }
        return {
          ...prev,
          [key]: {
            ...w,
            maximized: false,
            zIndex: nextZ,
          }
        };
      }
      return {
        ...prev,
        [key]: {
          ...w,
          maximized: true,
          minimized: false,
          restoreBounds: { x: w.x, y: w.y, width: w.width, height: w.height },
          x: desktop.x,
          y: desktop.y,
          width: desktop.width,
          height: desktop.height,
          zIndex: nextZ,
        }
      };
    });
    selectWorkspaceTab(key);
  };

  const toggleMdiAuxWindowMaximize = (id: string) => {
    const nextZ = getNextMdiZIndex();
    const desktop = getMdiDesktopBounds();
    setMdiAuxWindows((prev) => {
      const w = prev[id];
      if (!w) return prev;
      if (w.maximized) {
        const restore = w.restoreBounds;
        if (restore) {
          return {
            ...prev,
            [id]: {
              ...w,
              maximized: false,
              x: restore.x,
              y: restore.y,
              width: restore.width,
              height: restore.height,
              zIndex: nextZ,
            }
          };
        }
        return {
          ...prev,
          [id]: {
            ...w,
            maximized: false,
            zIndex: nextZ,
          }
        };
      }
      return {
        ...prev,
        [id]: {
          ...w,
          maximized: true,
          minimized: false,
          restoreBounds: { x: w.x, y: w.y, width: w.width, height: w.height },
          x: desktop.x,
          y: desktop.y,
          width: desktop.width,
          height: desktop.height,
          zIndex: nextZ,
        }
      };
    });
  };

  const handleWinTitlePointerDown = (e: React.PointerEvent, key: string, wsState: { x: number; y: number }) => {
    if (e.button !== 0) return;
    const isMaximized = (WORKSPACE_KEYS as readonly string[]).includes(key)
      ? !!mdiWindowStates[key as WorkspaceFocus]?.maximized
      : !!mdiAuxWindows[key]?.maximized;
    if (isMaximized) return;
    e.preventDefault();
    const el = (e.currentTarget as HTMLElement).closest('.win-mdi-window') as HTMLElement | null;
    if (!el) return;
    if ((WORKSPACE_KEYS as readonly string[]).includes(key)) {
      bringMdiToFront(key as WorkspaceFocus);
    } else {
      bringMdiAuxToFront(key);
    }
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch (_) {}
    mdiDragRef.current = {
      key,
      pointerId: e.pointerId,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startWinX: wsState.x,
      startWinY: wsState.y,
      lastX: wsState.x,
      lastY: wsState.y,
      el,
    };
    el.style.willChange = 'transform';
  };

  const handleWinResizePointerDown = (e: React.PointerEvent, key: string, wsState: { x: number; y: number; width: number; height: number }) => {
    if (e.button !== 0) return;
    const isMaximized = (WORKSPACE_KEYS as readonly string[]).includes(key)
      ? !!mdiWindowStates[key as WorkspaceFocus]?.maximized
      : !!mdiAuxWindows[key]?.maximized;
    if (isMaximized) return;
    e.preventDefault();
    e.stopPropagation();

    const el = (e.currentTarget as HTMLElement).closest('.win-mdi-window') as HTMLElement | null;
    if (!el) return;
    if ((WORKSPACE_KEYS as readonly string[]).includes(key)) {
      bringMdiToFront(key as WorkspaceFocus);
    } else {
      bringMdiAuxToFront(key);
    }
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch (_) {}
    mdiResizeRef.current = {
      key,
      pointerId: e.pointerId,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startWidth: wsState.width,
      startHeight: wsState.height,
      el,
    };
  };

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (mdiDragRef.current && e.pointerId === mdiDragRef.current.pointerId) {
        const { startMouseX, startMouseY, startWinX, startWinY, el } = mdiDragRef.current;
        const x = Math.max(0, startWinX + e.clientX - startMouseX);
        const y = Math.max(0, startWinY + e.clientY - startMouseY);
        mdiDragRef.current.lastX = x;
        mdiDragRef.current.lastY = y;
        el.style.transform = `translate3d(${x - startWinX}px, ${y - startWinY}px, 0)`;
        return;
      }

      if (!mdiResizeRef.current || e.pointerId !== mdiResizeRef.current.pointerId) return;
      const { key, startMouseX, startMouseY, startWidth, startHeight } = mdiResizeRef.current;
      const width = Math.max(420, Math.round(startWidth + e.clientX - startMouseX));
      const height = Math.max(280, Math.round(startHeight + e.clientY - startMouseY));
      if ((WORKSPACE_KEYS as readonly string[]).includes(key)) {
        setMdiWindowStates(prev => {
          const w = prev[key as WorkspaceFocus];
          if (!w || w.maximized || w.minimized) return prev;
          return {
            ...prev,
            [key as WorkspaceFocus]: {
              ...w,
              width,
              height,
            }
          };
        });
      } else {
        setMdiAuxWindows(prev => {
          const w = prev[key];
          if (!w || w.maximized || w.minimized) return prev;
          return {
            ...prev,
            [key]: {
              ...w,
              width,
              height,
            }
          };
        });
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (mdiDragRef.current && e.pointerId === mdiDragRef.current.pointerId) {
        const { key, lastX, lastY, el } = mdiDragRef.current;
        el.style.transform = '';
        el.style.willChange = '';
        if ((WORKSPACE_KEYS as readonly string[]).includes(key)) {
          setMdiWindowStates(prev => ({ ...prev, [key as WorkspaceFocus]: { ...prev[key as WorkspaceFocus], x: lastX, y: lastY } }));
        } else {
          setMdiAuxWindows(prev => prev[key] ? ({ ...prev, [key]: { ...prev[key], x: lastX, y: lastY } }) : prev);
        }
        mdiDragRef.current = null;
        return;
      }

      if (mdiResizeRef.current && e.pointerId === mdiResizeRef.current.pointerId) {
        const { key, el } = mdiResizeRef.current;
        if ((WORKSPACE_KEYS as readonly string[]).includes(key)) {
          setMdiWindowStates(prev => {
            const w = prev[key as WorkspaceFocus];
            if (!w || w.maximized || w.minimized) return prev;
            return { ...prev, [key as WorkspaceFocus]: { ...w, width: Math.max(420, Math.round(el.offsetWidth)), height: Math.max(280, Math.round(el.offsetHeight)) } };
          });
        } else {
          setMdiAuxWindows(prev => {
            const w = prev[key];
            if (!w || w.maximized || w.minimized) return prev;
            return { ...prev, [key]: { ...w, width: Math.max(420, Math.round(el.offsetWidth)), height: Math.max(280, Math.round(el.offsetHeight)) } };
          });
        }
        mdiResizeRef.current = null;
      }
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, []);

  const toggleTreeGroup = (group: string) => {
    setTreeOpenGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      try { localStorage.setItem(NAVIGATOR_TREE_GROUPS_KEY, JSON.stringify(Array.from(next))); } catch (_) {}
      return next;
    });
  };

  const autoArrangeMdiWindows = () => {
    const openWindows = [
      ...WORKSPACE_KEYS
        .filter((key) => mdiWindowStates[key].open)
        .map((key) => ({ kind: 'workspace' as const, id: key, zIndex: mdiWindowStates[key].zIndex })),
      ...Object.values(mdiAuxWindows)
        .filter((windowState) => windowState.open)
        .map((windowState) => ({ kind: 'aux' as const, id: windowState.id, zIndex: windowState.zIndex })),
    ].sort((a, b) => a.zIndex - b.zIndex);
    if (openWindows.length === 0) return;

    const desktop = getMdiDesktopBounds();
    const layout = calculateMdiTileLayout(openWindows.length, desktop.width, desktop.height);
    const nextZ = getNextMdiZIndex();
    const workspaceRects = new Map<WorkspaceFocus, { rect: MdiTileRect; zIndex: number }>();
    const auxRects = new Map<string, { rect: MdiTileRect; zIndex: number }>();

    openWindows.forEach((windowEntry, index) => {
      const placement = { rect: layout[index], zIndex: nextZ + index };
      if (windowEntry.kind === 'workspace') workspaceRects.set(windowEntry.id, placement);
      else auxRects.set(windowEntry.id, placement);
    });

    setMdiWindowStates((prev) => {
      const next = { ...prev };
      workspaceRects.forEach(({ rect, zIndex }, key) => {
        next[key] = {
          ...next[key],
          ...rect,
          minimized: false,
          maximized: false,
          restoreBounds: null,
          zIndex,
        };
      });
      return next;
    });
    setMdiAuxWindows((prev) => {
      const next = { ...prev };
      auxRects.forEach(({ rect, zIndex }, id) => {
        if (!next[id]) return;
        next[id] = {
          ...next[id],
          ...rect,
          minimized: false,
          maximized: false,
          restoreBounds: null,
          zIndex,
        };
      });
      return next;
    });

    window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };

  const toggleNavigatorCollapsed = () => {
    setNavigatorCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        localStorage.setItem(NAVIGATOR_COLLAPSED_KEY, String(next));
      } catch (_) {}
      return next;
    });
  };

  const syncWindowGeometry = (key: WorkspaceFocus, el: HTMLElement | null) => {
    if (!el) return;
    setMdiWindowStates(prev => {
      const w = prev[key];
      if (!w || w.maximized || w.minimized) return prev;
      const x = Math.max(0, Math.round(el.offsetLeft));
      const y = Math.max(0, Math.round(el.offsetTop));
      const width = Math.max(420, Math.round(el.offsetWidth));
      const height = Math.max(280, Math.round(el.offsetHeight));
      return {
        ...prev,
        [key]: {
          ...w,
          x,
          y,
          width,
          height,
        }
      };
    });
  };

  const syncAuxWindowGeometry = (key: string, el: HTMLElement | null) => {
    if (!el) return;
    setMdiAuxWindows(prev => {
      const w = prev[key];
      if (!w || w.maximized || w.minimized) return prev;
      const x = Math.max(0, Math.round(el.offsetLeft));
      const y = Math.max(0, Math.round(el.offsetTop));
      const width = Math.max(420, Math.round(el.offsetWidth));
      const height = Math.max(280, Math.round(el.offsetHeight));
      return {
        ...prev,
        [key]: {
          ...w,
          x,
          y,
          width,
          height,
        }
      };
    });
  };

  return (
    <div className="app-shell win-mdi-shell">

      {/* ── Windows-style menu bar ── */}
      <div className="app-shell__menubar win-menubar" role="menubar" aria-label="Application menu" onMouseLeave={handleMenuMouseLeave}>
        <div className={`app-shell__menu${openMenu === 'file' ? ' is-open' : ''}`} onMouseEnter={() => handleMenuMouseEnter('file')}>
          <button type="button" className="app-shell__menuSummary" aria-haspopup="menu" aria-expanded={openMenu === 'file'} onClick={toggleWorkspaceMenu('file')}>File</button>
          <div className="app-shell__menuPanel" role="menu">
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleNewFile)}>New</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleLoad)}>Load…</button>
            <button
              type="button"
              className="app-shell__menuAction"
              aria-expanded={isExamplesMenuExpanded}
              onClick={() => setIsExamplesMenuExpanded((prev) => !prev)}
            >
              {isExamplesMenuExpanded ? 'Examples ▾' : 'Examples ▸'}
            </button>
            {isExamplesMenuExpanded && EXAMPLE_PROJECT_FILES.map((fileName) => (
              <button
                key={fileName}
                type="button"
                className="app-shell__menuAction"
                onClick={runMenuAction(() => { void handleLoadExample(fileName); })}
              >
                {fileName}
              </button>
            ))}
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleSave)}>Save</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleImportZemax)}>Import Zemax</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleExportZemax)}>Export Zemax</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleShareUrl)}>Share URL</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(handleClearStorage)}>Clear Cache</button>
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
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(openRenderMdiWindow)}>Render</button>
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(openSystemDataMdiWindow)}>System Data</button>
          </div>
        </div>
        <div className={`app-shell__menu${openMenu === 'window' ? ' is-open' : ''}`} onMouseEnter={() => handleMenuMouseEnter('window')}>
          <button type="button" className="app-shell__menuSummary" aria-haspopup="menu" aria-expanded={openMenu === 'window'} onClick={toggleWorkspaceMenu('window')}>Window</button>
          <div className="app-shell__menuPanel" role="menu">
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(autoArrangeMdiWindows)}>Auto Arrange</button>
          </div>
        </div>
        <div className={`app-shell__menu${openMenu === 'run' ? ' is-open' : ''}`} onMouseEnter={() => handleMenuMouseEnter('run')}>
          <button type="button" className="app-shell__menuSummary" aria-haspopup="menu" aria-expanded={openMenu === 'run'} onClick={toggleWorkspaceMenu('run')}>Run</button>
          <div className="app-shell__menuPanel" role="menu">
            <button type="button" className="app-shell__menuAction" onClick={runMenuAction(openOptimizeMdiWindow)}>Optimize</button>
          </div>
        </div>
        <div className={`app-shell__menu${openMenu === 'analysis' ? ' is-open' : ''}`} onMouseEnter={() => handleMenuMouseEnter('analysis')}>
          <button type="button" className="app-shell__menuSummary" aria-haspopup="menu" aria-expanded={openMenu === 'analysis'} onClick={toggleWorkspaceMenu('analysis')}>Analysis</button>
          <div className="app-shell__menuPanel" role="menu">
            {WIN_ANALYSIS_ITEMS.map(a => (
              <button key={a.value} type="button" className="app-shell__menuAction" onClick={runAnalysisAction(a.value)}>{a.label}</button>
            ))}
          </div>
        </div>
        <div className="app-shell__menu">
          <button type="button" className="app-shell__menuItem" onClick={runMenuAction(openSettingsMdiWindow)}>Settings</button>
        </div>
      </div>

      {/* Keep toolbar DOM hooks for legacy handlers, but do not reserve visible layout space. */}
      <div style={{ display: 'none' }}>
        <MainToolbar minimal />
      </div>

      {/* ── Main body: left navigator tree + MDI desktop ── */}
      <div className={`win-mdi-body${navigatorCollapsed ? ' is-navigator-collapsed' : ''}`}>

        {/* Left navigator tree */}
        <aside className={`win-tree-panel${navigatorCollapsed ? ' is-collapsed' : ''}`} aria-label="Workspace navigator">
          <div className="win-tree-panel-header">
            {!navigatorCollapsed && <div className="win-tree-section-header">Navigator</div>}
            <button
              type="button"
              className="win-tree-collapse-button"
              onClick={toggleNavigatorCollapsed}
              aria-expanded={!navigatorCollapsed}
              aria-label={navigatorCollapsed ? 'Open navigator' : 'Collapse navigator'}
              title={navigatorCollapsed ? 'Open Navigator' : 'Collapse Navigator'}
            >
              <span aria-hidden="true">{navigatorCollapsed ? '›' : '‹'}</span>
            </button>
          </div>

          {navigatorCollapsed && (
            <button
              type="button"
              className="win-tree-rail-label"
              onClick={toggleNavigatorCollapsed}
              aria-label="Open navigator"
              title="Open Navigator"
            >
              Navigator
            </button>
          )}

          {!navigatorCollapsed && <div className="win-tree-content">

          <div className="win-tree-group">
            <div
              className={`win-tree-group-label${treeOpenGroups.has('panels') ? ' is-open' : ''}`}
              onClick={() => toggleTreeGroup('panels')}
            >
              <span className="win-tree-caret">{treeOpenGroups.has('panels') ? '▾' : '▸'}</span>
              <span>Workspace</span>
            </div>
            {treeOpenGroups.has('panels') && (
              <div className="win-tree-children">
                {workspaceSections.map(s => (
                  <div
                    key={s.key}
                    className={`win-tree-leaf${mdiWindowStates[s.key].open ? ' is-open' : ''}${workspaceFocus === s.key ? ' is-active' : ''}`}
                    onClick={() => openMdiWindow(s.key)}
                  >
                    {s.label}
                  </div>
                ))}
                <div
                  className={`win-tree-leaf${mdiAuxWindows[SYSTEM_TEXT_WINDOW_ID]?.open ? ' is-open' : ''}`}
                  onClick={() => { closeWorkspaceMenus(); focusSystemConsoleWindow(); }}
                >
                  {SYSTEM_TEXT_WINDOW_TITLE}
                </div>
              </div>
            )}
          </div>

          <div className="win-tree-group">
            <div
              className={`win-tree-group-label${treeOpenGroups.has('analysis') ? ' is-open' : ''}`}
              onClick={() => toggleTreeGroup('analysis')}
            >
              <span className="win-tree-caret">{treeOpenGroups.has('analysis') ? '▾' : '▸'}</span>
              <span>Analysis</span>
            </div>
            {treeOpenGroups.has('analysis') && (
              <div className="win-tree-children">
                <div className="win-tree-subgroup">
                  <div
                    className={`win-tree-subgroup-label${treeOpenGroups.has('analysis-system') ? ' is-open' : ''}`}
                    onClick={() => toggleTreeGroup('analysis-system')}
                  >
                    <span className="win-tree-caret">{treeOpenGroups.has('analysis-system') ? '▾' : '▸'}</span>
                    <span>System</span>
                  </div>
                  {treeOpenGroups.has('analysis-system') && <div className="win-tree-subgroup-children">
                    <div
                      className={`win-tree-leaf${mdiAuxWindows.render?.open ? ' is-open' : ''}`}
                      onClick={() => { closeWorkspaceMenus(); openRenderMdiWindow(); }}
                    >Render</div>
                    <div
                      className={`win-tree-leaf${mdiAuxWindows['analysis-system-data']?.open ? ' is-open' : ''}`}
                      onClick={() => { closeWorkspaceMenus(); openSystemDataMdiWindow(); }}
                    >System Data</div>
                  </div>}
                </div>
                {WIN_ANALYSIS_GROUPS.map((group) => {
                  const groupKey = `analysis-${group.id}`;
                  const isOpen = treeOpenGroups.has(groupKey);
                  return <div className="win-tree-subgroup" key={group.id}>
                    <div
                      className={`win-tree-subgroup-label${isOpen ? ' is-open' : ''}`}
                      onClick={() => toggleTreeGroup(groupKey)}
                    >
                      <span className="win-tree-caret">{isOpen ? '▾' : '▸'}</span>
                      <span>{group.label}</span>
                    </div>
                    {isOpen && <div className="win-tree-subgroup-children">
                      {group.items.map((item) => (
                        <div
                          key={item.value}
                          className={`win-tree-leaf${mdiAuxWindows[`analysis-${item.value}`]?.open ? ' is-open' : ''}`}
                          onClick={() => { closeWorkspaceMenus(); openAnalysisMdiWindow(item.value, item.label); }}
                        >
                          <span>{item.label}</span>
                          {item.beta ? <span className="win-tree-beta">Beta</span> : null}
                        </div>
                      ))}
                    </div>}
                  </div>;
                })}
              </div>
            )}
          </div>
          </div>}
        </aside>

        {/* MDI desktop */}
        <div className="win-mdi-desktop" ref={mdiDesktopRef}>
          {workspaceSections.map(s => {
            const ws = mdiWindowStates[s.key];
            if (!ws.open) return null;
            return (
              <div
                key={s.key}
                className={`win-mdi-window win-mdi-window--${s.key}${ws.minimized ? ' is-minimized' : ''}${ws.maximized ? ' is-maximized' : ''}${workspaceFocus === s.key ? ' is-focused' : ''}`}
                style={{ left: ws.x, top: ws.y, width: ws.width, height: ws.minimized ? 44 : ws.height, zIndex: ws.zIndex }}
                onPointerDownCapture={() => bringMdiToFront(s.key)}
                onFocusCapture={() => bringMdiToFront(s.key)}
                onPointerUp={(e) => syncWindowGeometry(s.key, e.currentTarget as HTMLElement)}
                onMouseUp={(e) => syncWindowGeometry(s.key, e.currentTarget as HTMLElement)}
              >
                <div
                  className={`win-mdi-titlebar${workspaceFocus === s.key ? ' is-focused' : ''}`}
                  onPointerDown={(e) => handleWinTitlePointerDown(e, s.key, ws)}
                >
                  <div className="win-mdi-traffic">
                    <button
                      type="button"
                      className="win-mdi-btn win-mdi-btn--close"
                      title="Close"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); closeMdiWindow(s.key); }}
                    />
                    <button
                      type="button"
                      className="win-mdi-btn win-mdi-btn--minimize"
                      title="Minimize"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); minimizeMdiWindow(s.key); }}
                    />
                    <button
                      type="button"
                      className="win-mdi-btn win-mdi-btn--zoom"
                      title="Zoom"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); toggleMdiWindowMaximize(s.key); }}
                    />
                  </div>
                  <span className="win-mdi-title">{s.label}</span>
                  <div className="win-mdi-controls">
                    <button type="button" className="win-mdi-btn win-mdi-btn--ghost" aria-hidden="true" tabIndex={-1} />
                  </div>
                </div>
                {!ws.minimized && (
                  <div className="win-mdi-content">
                    {s.key === 'configuration' && <ConfigurationSection />}
                    {s.key === 'source'        && <SourceSection />}
                    {s.key === 'field'         && <FieldSection />}
                    {s.key === 'intent'        && <DesignIntentSection />}
                    {s.key === 'literature'    && <LiteratureImportPanel />}
                    {s.key === 'requirements'  && <RequirementsSection />}
                  </div>
                )}
                <button
                  type="button"
                  className="win-mdi-resizeHandle"
                  aria-label="Resize window"
                  onPointerDown={(e) => handleWinResizePointerDown(e, s.key, ws)}
                />
              </div>
            );
          })}
          {Object.values(mdiAuxWindows).map((aux) => {
            if (!aux.open) return null;
            const isSystemTextWindow = aux.id === SYSTEM_TEXT_WINDOW_ID;
            return (
              <div
                key={aux.id}
                className={`win-mdi-window${aux.minimized ? ' is-minimized' : ''}${aux.maximized ? ' is-maximized' : ''}`}
                style={{ left: aux.x, top: aux.y, width: aux.width, height: aux.minimized ? 44 : aux.height, zIndex: aux.zIndex }}
                onPointerDownCapture={() => bringMdiAuxToFront(aux.id)}
                onFocusCapture={() => bringMdiAuxToFront(aux.id)}
                onPointerUp={(e) => syncAuxWindowGeometry(aux.id, e.currentTarget as HTMLElement)}
                onMouseUp={(e) => syncAuxWindowGeometry(aux.id, e.currentTarget as HTMLElement)}
              >
                <div
                  className="win-mdi-titlebar is-focused"
                  onPointerDown={(e) => handleWinTitlePointerDown(e, aux.id, aux)}
                >
                  <div className="win-mdi-traffic">
                    {isSystemTextWindow ? (
                      <button
                        type="button"
                        className="win-mdi-btn win-mdi-btn--ghost"
                        aria-hidden="true"
                        tabIndex={-1}
                      />
                    ) : (
                      <button
                        type="button"
                        className="win-mdi-btn win-mdi-btn--close"
                        title="Close"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); closeMdiAuxWindow(aux.id); }}
                      />
                    )}
                    <button
                      type="button"
                      className="win-mdi-btn win-mdi-btn--minimize"
                      title="Minimize"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); minimizeMdiAuxWindow(aux.id); }}
                    />
                    <button
                      type="button"
                      className="win-mdi-btn win-mdi-btn--zoom"
                      title="Zoom"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); toggleMdiAuxWindowMaximize(aux.id); }}
                    />
                  </div>
                  <span className="win-mdi-title">{aux.title}</span>
                  <div className="win-mdi-controls">
                    <button type="button" className="win-mdi-btn win-mdi-btn--ghost" aria-hidden="true" tabIndex={-1} />
                  </div>
                </div>
                {!aux.minimized && (
                  <div className="win-mdi-content" style={isSystemTextWindow ? undefined : { padding: 0 }}>
                    {isSystemTextWindow ? (
                      <div className="system-text-window">
                        <div className="system-text-window__log" ref={systemTextLogRef}>
                          {systemTextLines.map((line, index) => (
                            <div key={`line-${index}`} className="system-text-window__line">{line}</div>
                          ))}
                        </div>
                        <form
                          className="system-text-window__commandRow"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const cmd = systemTextCommand;
                            setSystemTextCommand('');
                            runSystemTextCommand(cmd);
                          }}
                        >
                          <label className="system-text-window__label" htmlFor="system-text-window-command">Command</label>
                          <input
                            id="system-text-window-command"
                            className="system-text-window__input"
                            list="system-text-window-history"
                            value={systemTextCommand}
                            onChange={(e) => setSystemTextCommand(e.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <datalist id="system-text-window-history">
                            {systemTextHistory.map((entry, index) => (
                              <option key={`history-${index}`} value={entry} />
                            ))}
                          </datalist>
                        </form>
                      </div>
                    ) : (
                      <iframe
                        title={aux.title}
                        src={aux.url}
                        onFocus={() => bringMdiAuxToFront(aux.id)}
                        style={{ width: '100%', height: '100%', border: 'none', background: '#ffffff' }}
                      />
                    )}
                  </div>
                )}
                <button
                  type="button"
                  className="win-mdi-resizeHandle"
                  aria-label="Resize window"
                  onPointerDown={(e) => handleWinResizePointerDown(e, aux.id, aux)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Windows-style status bar ── */}
      <div className="app-shell__statusbar win-statusbar">
        <span className="win-statusbar-pane">Ready</span>
        <span className="win-statusbar-pane" style={{ color: statusFileColor }}>{statusFileText}</span>
        <span className="win-statusbar-pane">View: {activeWorkspaceLabel}</span>
        <span className="win-statusbar-pane">Variables: {variableCountSummary}</span>
        <span className="win-statusbar-pane" style={{ color: optimizeTone }}>Optimizer: {optimizeStatusText}</span>
      </div>

      <div style={{ display: 'none' }}>
        <LegacyPanels />
      </div>
    </div>
  );
}
