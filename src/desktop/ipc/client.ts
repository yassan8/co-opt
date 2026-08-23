import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { detectConjugateType } from "../../../utils/conjugate-detection.ts";
import type {
  NativeChiefRayAngleRequest,
  NativeChiefRayAngleResponse,
  NativeParaxialMetrics,
  NativeParaxialMetricsRequest,
  NativeParaxialMetricsResponse,
  NativeSeidelRequest,
  NativeSeidelResponse,
  NativeAstigmatismRequest,
  NativeAstigmatismResponse,
  NativeAstigmatismDebugRequest,
  NativeAstigmatismDebugResponse,
  NativeTransverseAberrationRequest,
  NativeTransverseAberrationResponse,
  NativeTransverseRmsRequest,
  NativeTransverseRmsResponse,
  NativeTransverseRmsBatchRequest,
  NativeTransverseRmsBatchResponse,
  NativeOpdMapRequest,
  NativeOpdMapResponse,
  OpdChiefRayMode,
  OpdPupilNormalizationMode,
  OpdExitPupilReferencePointMode,
  OpdReferenceSphereOptions,
  OpdReferenceMode,
  NativeOpdRmsWavesRequest,
  NativeOpdRmsWavesResponse,
  NativePsfMapRequest,
  NativePsfMapResponse,
  NativeMtfMapRequest,
  NativeMtfMapResponse,
  NativeOptimizerMtfBatchRequest,
  NativeOptimizerMtfBatchResponse,
  NativeFieldMtfMapRequest,
  NativeFieldMtfMapResponse,
  NativeThroughFocusMtfMapRequest,
  NativeThroughFocusMtfMapResponse,
  NativeSphericalAberrationRequest,
  NativeSphericalAberrationResponse,
  NativeSpotRaytraceRequest,
  NativeSpotRaytraceResponse,
  NativeDistortionRequest,
  NativeDistortionResponse,
  NativeGridDistortionRequest,
  NativeGridDistortionResponse,
  NativeMagnificationChromaticAberrationRequest,
  NativeMagnificationChromaticAberrationResponse,
  OpticsEchoRequest,
  OpticsEchoResponse,
  RaytracePreviewRequest,
  RaytracePreviewResponse,
} from "../../shared/contracts/optics";

const normalizeNativePoint = (value: any) => Array.isArray(value) && value.length >= 3
  ? { x: Number(value[0]), y: Number(value[1]), z: Number(value[2]) }
  : value;
import type {
  AiChatRequest,
  AiChatResponse,
  GenerateZmxTextRequest,
  GenerateZmxTextResponse,
  ParseZmxTextRequest,
  ParseZmxTextResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ExportFreeCadDocumentRequest,
  ExportFreeCadDocumentResponse,
} from "../../shared/contracts/io-ai";
import type {
  DefaultProjectResponse,
  NewProjectTemplateResponse,
} from "../../shared/contracts/project";
import type {
  EvaluateOptimizerCandidatesRequest,
  EvaluateOptimizerCandidatesMultiScenarioRequest,
  EvaluateOptimizerCandidatesResponse,
  OptimizeStepRequest,
  OptimizeStepResponse,
  OptimizerDropSessionRequest,
} from "../../shared/contracts/optimizer";
import type {
  RunAnalysisComputeRequest,
  RunAnalysisComputeResponse,
  RunAnalysisPreviewRequest,
  RunAnalysisPreviewResponse,
  RunSystemDataReportRequest,
  RunSystemDataReportResponse,
  GridRecommendation,
  RecommendWavefrontGridForTimeRequest,
  RecommendWavefrontGridRequest,
} from "../../shared/contracts/analysis";
import type { InvokeRequestEnvelope } from "../../shared/contracts/ipc";
import { isTauriRuntime } from "../runtime";
import { asphericSag } from "../../../raytracing/core/ray-tracing.ts";
import { getRefractiveIndex as getParaxialRefractiveIndex } from "../../../raytracing/core/ray-paraxial.ts";
import {
  getIdealThinLensFocalPair,
  hasAnamorphicIdealThinLens,
  hasIdealThinLens,
  isRotationallySymmetricIdealThinLensOnlySystem,
} from "../../../utils/ideal-thin-lens.ts";

export async function readDesktopSetting(key: string): Promise<string | null> {
  const k = String(key ?? "").trim();
  if (!k) return null;
  try {
    const value = await invoke<string | null>("read_desktop_setting", { key: k });
    return (typeof value === "string" && value.trim()) ? value : null;
  } catch (_) {
    return null;
  }
}

export async function writeDesktopSetting(key: string, value: string | null): Promise<void> {
  const k = String(key ?? "").trim();
  if (!k) return;
  try {
    const v = (typeof value === "string" && value.trim()) ? value.trim() : null;
    await invoke<void>("write_desktop_setting", { key: k, value: v });
  } catch (_) {
    // ignore desktop setting write errors and keep local fallback behavior
  }
}

export async function startPreventDisplaySleep(token: string): Promise<boolean> {
  const key = String(token ?? "").trim();
  if (!key || !isTauriRuntime()) return false;
  try {
    return !!(await invoke<boolean>("start_prevent_display_sleep", { token: key }));
  } catch (_) {
    return false;
  }
}

export async function stopPreventDisplaySleep(token: string): Promise<boolean> {
  const key = String(token ?? "").trim();
  if (!key || !isTauriRuntime()) return false;
  try {
    return !!(await invoke<boolean>("stop_prevent_display_sleep", { token: key }));
  } catch (_) {
    return false;
  }
}

function invokeCommand<TResponse>(command: string): Promise<TResponse>;
function invokeCommand<TRequest, TResponse>(command: string, payload: TRequest): Promise<TResponse>;
function invokeCommand<TRequest, TResponse>(command: string, payload?: TRequest): Promise<TResponse> {
  if (payload === undefined) {
    return invoke<TResponse>(command);
  }
  const envelope: InvokeRequestEnvelope<TRequest> = { req: payload };
  return invoke<TResponse>(command, envelope);
}

function assertArrayField(value: unknown, fieldName: string, commandName: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${commandName} requires ${fieldName} to be an array`);
  }
}

function enrichRowsWithResolvedRindexForWasm(rows: any[], wavelengthUm: number): any[] {
  if (!Array.isArray(rows) || rows.length === 0) return Array.isArray(rows) ? rows : [];
  const wl = Number.isFinite(Number(wavelengthUm)) && Number(wavelengthUm) > 0 ? Number(wavelengthUm) : 0.5876;
  let changed = false;
  const mapped = rows.map((row: any) => {
    if (!row || typeof row !== "object") return row;
    let resolved = Number.NaN;
    try {
      resolved = Number(getParaxialRefractiveIndex(row, wl));
    } catch (_) {
      resolved = Number.NaN;
    }
    if (!Number.isFinite(resolved) || resolved <= 0) return row;
    const prev = Number((row as any)?.__cooptResolvedRindex);
    if (Number.isFinite(prev) && Math.abs(prev - resolved) <= 1e-12) return row;
    changed = true;
    return {
      ...row,
      __cooptResolvedRindex: resolved,
    };
  });
  return changed ? mapped : rows;
}

function isOpdDebugEnabled(): boolean {
  try {
    const g = (typeof globalThis !== "undefined") ? (globalThis as any) : null;
    if (g && (g.__OPD_DEBUG || g.__PSF_DEBUG)) return true;
    const opener = g?.opener;
    if (opener && (opener.__OPD_DEBUG || opener.__PSF_DEBUG)) return true;
  } catch (_) {
    // ignore
  }
  return false;
}

function shouldUseLegacyWavefrontOpdRoute(): boolean {
  return false;
}

function sanitizePupilSamplingMode(value: unknown): "stop" | "entrance" | "" {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode === "stop" || mode === "entrance" ? mode : "";
}

function sanitizeOpdReferenceMode(value: unknown): OpdReferenceMode {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (mode) {
    case "exit-pupil":
    case "image-sphere":
    case "optalix-direct":
    case "image-plane":
    case "absolute":
    case "absolute2":
    case "afocal-image-space":
      return mode;
    default:
      return "exit-pupil";
  }
}

function sanitizeOpdChiefRayMode(value: unknown): OpdChiefRayMode {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (mode === "entrance-pupil-center" || mode === "transmitted-pupil-center") return mode;
  return "stop-center";
}

function sanitizeOpdPupilNormalizationMode(value: unknown): OpdPupilNormalizationMode {
  return typeof value === "string" && value.trim().toLowerCase() === "effective-transmitted-pupil"
    ? "effective-transmitted-pupil"
    : "fixed-entrance-pupil";
}

function sanitizeOpdExitPupilReferencePointMode(value: unknown): OpdExitPupilReferencePointMode {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode === "exit-pupil-center" ? "exit-pupil-center" : "chief-ray-intersection";
}

export function readConfiguredOpdExitPupilReferencePointMode(): OpdExitPupilReferencePointMode {
  try {
    const g = (typeof globalThis !== "undefined") ? (globalThis as any) : null;
    const direct = sanitizeOpdExitPupilReferencePointMode(
      g?.__COOPT_OPD_EXIT_PUPIL_REFERENCE_POINT_MODE ?? g?.COOPT_OPD_EXIT_PUPIL_REFERENCE_POINT_MODE,
    );
    if (direct !== "chief-ray-intersection"
      || g?.__COOPT_OPD_EXIT_PUPIL_REFERENCE_POINT_MODE
      || g?.COOPT_OPD_EXIT_PUPIL_REFERENCE_POINT_MODE) return direct;
    const opener = g?.opener;
    const openerValue = opener?.__COOPT_OPD_EXIT_PUPIL_REFERENCE_POINT_MODE
      ?? opener?.COOPT_OPD_EXIT_PUPIL_REFERENCE_POINT_MODE;
    if (openerValue !== undefined && openerValue !== null && String(openerValue).trim()) {
      return sanitizeOpdExitPupilReferencePointMode(openerValue);
    }
  } catch (_) {
    // Ignore cross-window access failures and use local storage/default below.
  }
  try {
    const stored = localStorage.getItem("coopt.opd.exitPupilReferencePointMode");
    if (stored) return sanitizeOpdExitPupilReferencePointMode(stored);
  } catch (_) {
    // Ignore unavailable storage.
  }
  return "chief-ray-intersection";
}

export function readConfiguredOpdReferenceSphereOptions(): OpdReferenceSphereOptions {
  const defaults: OpdReferenceSphereOptions = {
    referenceSphereWavelengthMode: "primary-wavelength",
    opdDisplayMode: "raw",
    exitPupilPositionSign: "as-is",
    exitPupilPlaneDefinition: "surface-local-axis",
    chiefImagePoint: "chief-ray-image-point",
    sphereIntersection: "exit-pupil-side",
    opticalPathSign: "positive",
    exitPupilDirection: "image-to-exit-pupil",
  };
  try {
    const g = (typeof globalThis !== "undefined") ? (globalThis as any) : null;
    const raw = g?.__COOPT_OPD_REFERENCE_SPHERE_OPTIONS
      ?? g?.COOPT_OPD_REFERENCE_SPHERE_OPTIONS
      ?? localStorage.getItem("coopt.opd.referenceSphereOptions");
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object") {
      return {
        ...defaults,
        ...parsed,
        referenceSphereWavelengthMode: parsed.referenceSphereWavelengthMode === "per-wavelength"
          ? "per-wavelength"
          : defaults.referenceSphereWavelengthMode,
        opdDisplayMode: parsed.opdDisplayMode === "pistonRemoved"
          || parsed.opdDisplayMode === "pistonTiltRemoved"
          || parsed.opdDisplayMode === "pistonDefocusRemoved"
          || parsed.opdDisplayMode === "pistonTiltDefocusRemoved"
          ? parsed.opdDisplayMode
          : defaults.opdDisplayMode,
        chiefImagePoint: parsed.chiefImagePoint === "paraxial-image-point"
          || parsed.chiefImagePoint === "sagittal-best-focus-point"
          || parsed.chiefImagePoint === "tangential-best-focus-point"
          || parsed.chiefImagePoint === "tan-sag-mid-focus-point"
          || parsed.chiefImagePoint === "rms-wavefront-best-focus-point"
          || parsed.chiefImagePoint === "circle-of-least-confusion-point"
          || parsed.chiefImagePoint === "defocus-zero-reference-point"
          || parsed.chiefImagePoint === "weighted-tan-sag-focus-point"
          || parsed.chiefImagePoint === "per-wavelength-best-focus-point"
          || parsed.chiefImagePoint === "target-surface-center"
          ? parsed.chiefImagePoint
          : defaults.chiefImagePoint,
      };
    }
  } catch (_) {
    // Ignore unavailable or malformed settings and use defaults.
  }
  return defaults;
}

export function readConfiguredOpdChiefRayMode(): OpdChiefRayMode {
  try {
    const g = (typeof globalThis !== "undefined") ? (globalThis as any) : null;
    const direct = sanitizeOpdChiefRayMode(g?.__COOPT_OPD_CHIEF_RAY_MODE ?? g?.COOPT_OPD_CHIEF_RAY_MODE);
    if (direct !== "stop-center" || g?.__COOPT_OPD_CHIEF_RAY_MODE || g?.COOPT_OPD_CHIEF_RAY_MODE) return direct;
    const opener = g?.opener;
    const openerValue = opener?.__COOPT_OPD_CHIEF_RAY_MODE ?? opener?.COOPT_OPD_CHIEF_RAY_MODE;
    if (openerValue !== undefined && openerValue !== null && String(openerValue).trim()) {
      return sanitizeOpdChiefRayMode(openerValue);
    }
  } catch (_) {
    // Ignore cross-window access failures and use local storage/default below.
  }
  try {
    const stored = localStorage.getItem("coopt.opd.chiefRayMode");
    if (stored) return sanitizeOpdChiefRayMode(stored);
  } catch (_) {
    // Ignore unavailable storage.
  }
  return "stop-center";
}

export function readConfiguredOpdPupilNormalizationMode(): OpdPupilNormalizationMode {
  try {
    const g = (typeof globalThis !== "undefined") ? (globalThis as any) : null;
    const direct = sanitizeOpdPupilNormalizationMode(
      g?.__COOPT_OPD_PUPIL_NORMALIZATION_MODE ?? g?.COOPT_OPD_PUPIL_NORMALIZATION_MODE,
    );
    if (direct !== "fixed-entrance-pupil" || g?.__COOPT_OPD_PUPIL_NORMALIZATION_MODE || g?.COOPT_OPD_PUPIL_NORMALIZATION_MODE) return direct;
    const openerValue = g?.opener?.__COOPT_OPD_PUPIL_NORMALIZATION_MODE ?? g?.opener?.COOPT_OPD_PUPIL_NORMALIZATION_MODE;
    if (openerValue !== undefined && openerValue !== null && String(openerValue).trim()) {
      return sanitizeOpdPupilNormalizationMode(openerValue);
    }
  } catch (_) {
    // Ignore cross-window access failures and use local storage/default below.
  }
  try {
    const stored = localStorage.getItem("coopt.opd.pupilNormalizationMode");
    if (stored) return sanitizeOpdPupilNormalizationMode(stored);
  } catch (_) {
    // Ignore unavailable storage.
  }
  return "fixed-entrance-pupil";
}

export function readConfiguredOpdReferenceMode(): OpdReferenceMode {
  try {
    const g = (typeof globalThis !== "undefined") ? (globalThis as any) : null;
    const direct = sanitizeOpdReferenceMode(g?.__COOPT_OPD_REFERENCE_MODE ?? g?.COOPT_OPD_REFERENCE_MODE);
    if (direct !== "exit-pupil" || g?.__COOPT_OPD_REFERENCE_MODE || g?.COOPT_OPD_REFERENCE_MODE) return direct;
    const opener = g?.opener;
    const openerValue = opener?.__COOPT_OPD_REFERENCE_MODE ?? opener?.COOPT_OPD_REFERENCE_MODE;
    if (openerValue !== undefined && openerValue !== null && String(openerValue).trim()) {
      return sanitizeOpdReferenceMode(openerValue);
    }
  } catch (_) {
    // Ignore cross-window access failures and use local storage/default below.
  }
  try {
    const stored = localStorage.getItem("coopt.opd.referenceMode");
    if (stored) return sanitizeOpdReferenceMode(stored);
  } catch (_) {
    // Ignore unavailable storage.
  }
  return "exit-pupil";
}

function readForcedInfinitePupilMode(): "stop" | "entrance" | "" {
  try {
    const g = (typeof globalThis !== "undefined") ? (globalThis as any) : null;
    const direct = sanitizePupilSamplingMode(g?.__COOPT_FORCE_INFINITE_PUPIL_MODE ?? g?.COOPT_FORCE_INFINITE_PUPIL_MODE);
    if (direct) return direct;
    const openerDirect = sanitizePupilSamplingMode(g?.opener?.__COOPT_FORCE_INFINITE_PUPIL_MODE ?? g?.opener?.COOPT_FORCE_INFINITE_PUPIL_MODE);
    if (openerDirect) return openerDirect;
  } catch (_) {
    // ignore global lookup errors
  }
  try {
    const persisted = sanitizePupilSamplingMode(localStorage.getItem("coopt.forceInfinitePupilMode"));
    if (persisted) return persisted;
  } catch (_) {
    // ignore storage lookup errors
  }
  return "";
}

function isImageHeightNativeObjectRow(row: any): boolean {
  const position = String(
    row?.__cooptOriginalPosition
    ?? row?.position
    ?? row?.objectType
    ?? row?.type
    ?? "",
  ).trim().toLowerCase();
  return position.includes("imageheight");
}

function toWavefrontFieldSettingFromObjectRow(objRow: any, index0: number, opticalSystemRows: any[]): any {
  const isInfiniteSystem = isInfiniteConjugateRows(opticalSystemRows);
  const pickFirstFinite = (values: any[], fallback = 0): number => {
    for (const value of values) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  };

  if (!objRow || typeof objRow !== "object") {
    return isInfiniteSystem
      ? {
        type: "Angle",
        position: "Angle",
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
        type: "Rectangle",
        position: "Rectangle",
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

  const fieldX = pickFirstFinite([
    objRow?.xHeightAngle,
    objRow?.xFieldAngle,
    objRow?.xHeight,
    objRow?.x,
    objRow?.angleX,
    objRow?.Hx,
  ], 0);
  const fieldY = pickFirstFinite([
    objRow?.yHeightAngle,
    objRow?.yFieldAngle,
    objRow?.fieldAngle,
    objRow?.yHeight,
    objRow?.y,
    objRow?.angleY,
    objRow?.Hy,
  ], 0);
  const objectIndex1 = index0 + 1;
  const displayName = String(objRow?.comment || objRow?.name || `Object ${objectIndex1}`);

  if (isInfiniteSystem) {
    return {
      type: "Angle",
      position: "Angle",
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
    type: "Rectangle",
    position: "Rectangle",
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

async function computeReferenceOpdMapViaRustTracedJsMath(
  opticalSystemRows: any[],
  objectRows: any[],
  objectIndex: number,
  wavelengthUm: number,
  gridSize: number,
  requestedPupilSamplingMode: "stop" | "entrance",
  pupilRadiusMm: number | undefined,
  referenceMode: OpdReferenceMode,
  opdDisplayMode: string,
): Promise<NativeOpdMapResponse> {
  const [{ createOPDCalculator, createWavefrontAnalyzer }] = await Promise.all([
    import("../../../evaluation/wavefront/wavefront.ts"),
  ]);

  const selectedObject = objectRows[objectIndex] || objectRows[0] || {};
  const fieldSetting = toWavefrontFieldSettingFromObjectRow(selectedObject, objectIndex, opticalSystemRows);
  const calc = createOPDCalculator(opticalSystemRows, wavelengthUm) as any;
  const globalScope = (typeof globalThis !== "undefined") ? (globalThis as any) : null;
  const overrideKey = "__cooptTraceOptionsOverride";
  const prevOverride = globalScope ? globalScope[overrideKey] : undefined;
  const prevOverrideObj = (prevOverride && typeof prevOverride === "object" && !Array.isArray(prevOverride)) ? prevOverride : null;

  if (globalScope) {
    globalScope[overrideKey] = {
      ...(prevOverrideObj || {}),
      useRustWasm: true,
      requireRustWasm: true,
      allowNonStrict: false,
      requireForwardHit: true,
      pupilSamplingMode: requestedPupilSamplingMode,
    };
  }

  try {
    if (typeof calc?.setReferenceRay === "function") {
      calc.setReferenceRay(fieldSetting);
    }

    const readReferenceGeometry = () => {
      try {
        const last = calc?.getLastRayCalculation?.();
        const lastGeometry = last?.referenceSphere;
        const lastCenter = lastGeometry?.referenceSphereCenter;
        const lastRadius = Number(lastGeometry?.imageSphereRadius);
        if (lastCenter && Number.isFinite(lastRadius)) {
          return {
            center: {
              x: Number(lastCenter.x),
              y: Number(lastCenter.y),
              z: Number(lastCenter.z),
            },
            radiusMm: lastRadius,
          };
        }

        const imagePoint = calc?.getChiefRayImagePoint?.();
        const geometry = referenceMode === "exit-pupil"
          ? calc?.calculateExitPupilReferenceSphereGeometry?.(imagePoint)
          : calc?.calculateImageSphereGeometry?.(imagePoint);
        const center = geometry?.referenceSphereCenter;
        const radiusMm = Number(geometry?.imageSphereRadius);
        if (!center || !Number.isFinite(radiusMm)) return null;
        return {
          center: {
            x: Number(center.x),
            y: Number(center.y),
            z: Number(center.z),
          },
          radiusMm,
        };
      } catch (_) {
        return null;
      }
    };

    if (typeof createWavefrontAnalyzer === "function") {
      const analyzer = createWavefrontAnalyzer(calc) as any;
      if (analyzer && typeof analyzer.generateWavefrontMap === "function") {
        const map = await analyzer.generateWavefrontMap(fieldSetting, gridSize, "circular", {
          recordRays: false,
          progressEvery: 0,
          opdMode: "referenceSphere",
          referenceMode,
          opdDisplayMode,
          pupilScaleRadiusMm: Number.isFinite(Number(pupilRadiusMm)) && Number(pupilRadiusMm) > 0
            ? Number(pupilRadiusMm)
            : undefined,
          renderFromZernike: false,
          skipZernikeFit: true,
          fullBatchTraceExperimental: false,
        });
        if (map && !map.error && Array.isArray(map.pupilCoordinates)) {
          const rawValues = Array.isArray(map?.raw?.opdsInWavelengths)
            ? map.raw.opdsInWavelengths
            : (Array.isArray(map?.opdsInWavelengths) ? map.opdsInWavelengths : []);
          const displayValues = Array.isArray(map?.display?.opdsInWavelengths)
            ? map.display.opdsInWavelengths
            : rawValues;
          const rawOpdGrid = Array.from({ length: gridSize }, () => Array.from({ length: gridSize }, () => null as number | null));
          const displayOpdGrid = Array.from({ length: gridSize }, () => Array.from({ length: gridSize }, () => null as number | null));
          let hitCount = 0;
          const count = Math.min(map.pupilCoordinates.length, rawValues.length);
          for (let i = 0; i < count; i++) {
            const coord = map.pupilCoordinates[i] || {};
            const ix = Number(coord.ix);
            const iy = Number(coord.iy);
            if (!Number.isInteger(ix) || !Number.isInteger(iy) || ix < 0 || iy < 0 || ix >= gridSize || iy >= gridSize) continue;
            const rawValue = Number(rawValues[i]);
            if (!Number.isFinite(rawValue)) continue;
            rawOpdGrid[iy][ix] = rawValue;
            const displayValue = Number(displayValues[i]);
            displayOpdGrid[iy][ix] = Number.isFinite(displayValue) ? displayValue : rawValue;
            hitCount += 1;
          }
          if (hitCount > 0) {
            const referenceGeometry = readReferenceGeometry();
            return {
              backend: "web-rust-wasm-js-reference",
              chiefReferenceMode: `js-${referenceMode}(${requestedPupilSamplingMode})`,
              targetSurface: pickImageSurfaceIndexNativeLike(opticalSystemRows),
              stopSurface: 0,
              requestedObjectIndex: objectIndex,
              usedObjectIndex: objectIndex,
              usedObjectPosition: String(selectedObject?.__cooptOriginalPosition ?? selectedObject?.position ?? ""),
              usedObjectX: Number(selectedObject?.__cooptImageHeightTarget?.x ?? selectedObject?.xHeightAngle ?? selectedObject?.xHeight ?? selectedObject?.x ?? 0) || 0,
              usedObjectY: Number(selectedObject?.__cooptImageHeightTarget?.y ?? selectedObject?.yHeightAngle ?? selectedObject?.yHeight ?? selectedObject?.y ?? 0) || 0,
              wavelengthUm,
              gridSize,
              sampleCount: hitCount,
              hitCount,
              pupilSamplingMode: requestedPupilSamplingMode,
              referenceMode,
              referenceSphereCenter: referenceGeometry?.center,
              referenceSphereRadiusMm: referenceGeometry?.radiusMm,
              rawOpdGrid,
              displayOpdGrid,
              referenceSphereOpdGrid: rawOpdGrid,
              message: "Computed via JS reference-sphere math with Rust/WASM ray tracing",
            } as NativeOpdMapResponse;
          }
        }
      }
    }

    const rawOpdGrid = Array.from({ length: gridSize }, () => Array.from({ length: gridSize }, () => null as number | null));
    const displayOpdGrid = Array.from({ length: gridSize }, () => Array.from({ length: gridSize }, () => null as number | null));
    const pupilCoordinates: Array<{ x: number; y: number }> = [];
    const opdsMicrons: number[] = [];
    const sampleIndices: Array<{ gridX: number; gridY: number }> = [];

    for (let gridY = 0; gridY < gridSize; gridY++) {
      const pupilY = gridSize > 1 ? -1 + (2 * gridY) / (gridSize - 1) : 0;
      for (let gridX = 0; gridX < gridSize; gridX++) {
        const pupilX = gridSize > 1 ? -1 + (2 * gridX) / (gridSize - 1) : 0;
        if ((pupilX * pupilX + pupilY * pupilY) > 1.000001) continue;

        const opdUm = Number(
          typeof calc?.calculateOPDReferenceSphere === "function"
            ? calc.calculateOPDReferenceSphere(pupilX, pupilY, fieldSetting, false, { pupilSamplingMode: requestedPupilSamplingMode, referenceMode })
            : calc?.calculateOPD?.(pupilX, pupilY, fieldSetting)
        );
        if (!Number.isFinite(opdUm)) continue;

        const opdWaves = opdUm / wavelengthUm;
        rawOpdGrid[gridY][gridX] = opdWaves;
        displayOpdGrid[gridY][gridX] = opdWaves;
        pupilCoordinates.push({ x: pupilX, y: pupilY });
        opdsMicrons.push(opdUm);
        sampleIndices.push({ gridX, gridY });
      }
    }

    if (typeof calc?._removeBestFitPlane === "function" && opdDisplayMode !== "raw") {
      const fit = calc._removeBestFitPlane(pupilCoordinates, opdsMicrons);
      if (Array.isArray(fit?.residualWaves) && fit.residualWaves.length === sampleIndices.length) {
        for (let i = 0; i < sampleIndices.length; i++) {
          const value = Number(fit.residualWaves[i]);
          if (!Number.isFinite(value)) continue;
          const sample = sampleIndices[i];
          displayOpdGrid[sample.gridY][sample.gridX] = value;
        }
      }
    } else if (opdDisplayMode === "pistonRemoved" && sampleIndices.length > 0) {
      let sum = 0;
      let count = 0;
      for (const sample of sampleIndices) {
        const value = Number(rawOpdGrid[sample.gridY][sample.gridX]);
        if (!Number.isFinite(value)) continue;
        sum += value;
        count += 1;
      }
      const mean = count > 0 ? sum / count : 0;
      for (const sample of sampleIndices) {
        const value = Number(rawOpdGrid[sample.gridY][sample.gridX]);
        if (!Number.isFinite(value)) continue;
        displayOpdGrid[sample.gridY][sample.gridX] = value - mean;
      }
    }

    const hitCount = sampleIndices.length;
    const referenceGeometry = readReferenceGeometry();
    return {
      backend: "web-rust-wasm-js-reference",
      chiefReferenceMode: `js-${referenceMode}(${requestedPupilSamplingMode})`,
      targetSurface: pickImageSurfaceIndexNativeLike(opticalSystemRows),
      stopSurface: 0,
      requestedObjectIndex: objectIndex,
      usedObjectIndex: objectIndex,
      usedObjectPosition: String(selectedObject?.__cooptOriginalPosition ?? selectedObject?.position ?? ""),
      usedObjectX: Number(selectedObject?.__cooptImageHeightTarget?.x ?? selectedObject?.xHeight ?? selectedObject?.x ?? 0) || 0,
      usedObjectY: Number(selectedObject?.__cooptImageHeightTarget?.y ?? selectedObject?.yHeight ?? selectedObject?.y ?? 0) || 0,
      wavelengthUm,
      gridSize,
      sampleCount: hitCount,
      hitCount,
      pupilSamplingMode: requestedPupilSamplingMode,
      referenceMode,
      referenceSphereCenter: referenceGeometry?.center,
      referenceSphereRadiusMm: referenceGeometry?.radiusMm,
      rawOpdGrid,
      displayOpdGrid,
      referenceSphereOpdGrid: rawOpdGrid,
      message: "Computed via JS reference-sphere math with Rust/WASM ray tracing",
    } as NativeOpdMapResponse;
  } finally {
    if (globalScope) {
      if (prevOverride === undefined) {
        delete globalScope[overrideKey];
      } else {
        globalScope[overrideKey] = prevOverride;
      }
    }
  }
}

// Session-scoped guard: once direct distortion WASM export is known-missing,
// skip repeated attempts to reduce console noise and extra overhead.
let directDistortionWasmUnavailableInSession = false;
const directDistortionSparseCoverageWarnedKeys = new Set<string>();
const transverseObjectNormalizationCache = new Map<string, any[]>();
const TRANSVERSE_OBJECT_NORMALIZATION_CACHE_LIMIT = 16;

function clonePlain<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    if (Array.isArray(value)) return value.map((item) => ({ ...(item as any) })) as T;
    if (value && typeof value === 'object') return { ...(value as any) } as T;
    return value;
  }
}

function getPrimaryWavelengthFromSourceRows(sourceRows: any[] = []): number {
  let fallback = 0.5876;

  for (const row of sourceRows) {
    const wavelength = Number((row as any)?.wavelength ?? (row as any)?.Wavelength);
    if (!Number.isFinite(wavelength) || wavelength <= 0) continue;
    fallback = wavelength;

    const primaryFlag = (row as any)?.primary ?? (row as any)?.Primary ?? (row as any)?.["Primary Wavelength"] ?? (row as any)?.isPrimary;
    const isPrimary = typeof primaryFlag === "boolean"
      ? primaryFlag
      : String(primaryFlag ?? "").trim().toLowerCase();
    if (isPrimary === true || isPrimary === "true" || isPrimary === "1" || isPrimary === "yes" || (typeof isPrimary === "string" && isPrimary.includes("primary"))) {
      return wavelength;
    }
  }

  return fallback;
}

function isInfiniteConjugateRows(opticalSystemRows: any[] = []): boolean {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return false;
  const thickness = (opticalSystemRows[0] as any)?.thickness;
  if (thickness === Infinity) return true;
  const text = String(thickness ?? '').trim().toUpperCase();
  return text === 'INF' || text === 'INFINITY';
}

export async function normalizeTransverseObjectRowsForImageHeight(
  opticalSystemRows: any[],
  sourceRows: any[],
  objectRows: any[],
  explicitWavelength?: number,
  options?: {
    onProgress?: (evt: { percent?: number; message?: string }) => void;
    progressStart?: number;
    progressEnd?: number;
    progressLabel?: string;
    preferParaxialImageHeight?: boolean;
  },
): Promise<any[]> {
  const parseFiniteNumber = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const rows = Array.isArray(objectRows) ? objectRows : [];
  if (rows.length === 0) return [];
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
  const progressStart = Number.isFinite(Number(options?.progressStart)) ? Number(options?.progressStart) : 0;
  const progressEnd = Number.isFinite(Number(options?.progressEnd)) ? Number(options?.progressEnd) : 100;
  const progressLabel = String(options?.progressLabel || "ImageHeight conversion");
  const preferParaxialImageHeight = options?.preferParaxialImageHeight === true;
  const emitProgress = (percent: number, message: string) => {
    if (!onProgress) return;
    try {
      onProgress({
        percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined,
        message,
      });
    } catch {
      // Ignore progress callback failures.
    }
  };

  const normalizedRows = rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    const normalizedRow = { ...row } as any;
    const targetX = normalizedRow?.__cooptImageHeightTarget?.x;
    const targetY = normalizedRow?.__cooptImageHeightTarget?.y;
    if (normalizedRow.xHeightAngle == null && normalizedRow["object x"] != null) normalizedRow.xHeightAngle = normalizedRow["object x"];
    if (normalizedRow.yHeightAngle == null && normalizedRow["object y"] != null) normalizedRow.yHeightAngle = normalizedRow["object y"];
    if (normalizedRow.xHeightAngle == null && normalizedRow.xHeight != null) normalizedRow.xHeightAngle = normalizedRow.xHeight;
    if (normalizedRow.yHeightAngle == null && normalizedRow.yHeight != null) normalizedRow.yHeightAngle = normalizedRow.yHeight;
    if (normalizedRow.xHeightAngle == null && normalizedRow.x != null) normalizedRow.xHeightAngle = normalizedRow.x;
    if (normalizedRow.yHeightAngle == null && normalizedRow.y != null) normalizedRow.yHeightAngle = normalizedRow.y;
    if (normalizedRow.xHeightAngle == null && targetX != null) normalizedRow.xHeightAngle = targetX;
    if (normalizedRow.yHeightAngle == null && targetY != null) normalizedRow.yHeightAngle = targetY;
    if (normalizedRow.position == null && normalizedRow.objectType != null) normalizedRow.position = normalizedRow.objectType;
    return normalizedRow;
  });

  const hasImageHeight = normalizedRows.some((row) => String((row as any)?.position ?? "").trim().toLowerCase() === "imageheight");
  if (!hasImageHeight) return normalizedRows;

  emitProgress(progressStart, `${progressLabel}: preparing...`);

  const [{ detectConjugateType }, { calculateParaxialData }] = await Promise.all([
    import("../../../utils/conjugate-detection.ts"),
    import("../../../raytracing/core/ray-paraxial.ts"),
  ]);
  const conjugateType = String(detectConjugateType(opticalSystemRows) || "").toLowerCase() === "finite"
    ? "finite"
    : "infinite";
  const wavelength = Number.isFinite(Number(explicitWavelength))
    ? Number(explicitWavelength)
    : getPrimaryWavelengthFromSourceRows(sourceRows);

  const normalizationCacheKey = (() => {
    try {
      return JSON.stringify({
        opticalSystemRows,
        wavelength: Number.isFinite(Number(wavelength)) ? Number(wavelength) : 0.5876,
        conjugateType,
        preferParaxialImageHeight,
        rows: normalizedRows,
      });
    } catch (_) {
      return null;
    }
  })();
  if (normalizationCacheKey && transverseObjectNormalizationCache.has(normalizationCacheKey)) {
    return clonePlain(transverseObjectNormalizationCache.get(normalizationCacheKey) || []);
  }

  const sharedParaxial = (() => {
    try { return calculateParaxialData(opticalSystemRows, wavelength); } catch (_) { return null; }
  })();

  let convertImageHeightToEffectiveObject: null | ((...args: any[]) => any) = null;
  let sharedSurfaceOrigins: any = null;
  const sharedImageSurfaceIndex = (() => {
    for (let i = 0; i < opticalSystemRows.length; i++) {
      const row = opticalSystemRows[i];
      const pos = String((row as any)?.position ?? (row as any)?.objectType ?? (row as any)?.type ?? '').trim().toLowerCase();
      if (pos === 'image') return i;
    }
    return Math.max(0, opticalSystemRows.length - 1);
  })();
  let sharedStopInfo: any = null;
  let sharedStopCenter3d: any = null;
  let sharedSolveScopeKey: string | null = null;

  const needsExactSolver = !(preferParaxialImageHeight && sharedParaxial);
  if (needsExactSolver) {
    const [{ convertImageHeightToEffectiveObject: convertFn }, { calculateSurfaceOrigins }, { findStopSurface }] = await Promise.all([
      import("../../../optical/ray-renderer.ts"),
      import("../../../raytracing/core/ray-tracing.ts"),
      import("../../../optical/system-renderer.ts"),
    ]);
    convertImageHeightToEffectiveObject = convertFn;
    sharedSurfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
    sharedStopInfo = findStopSurface(opticalSystemRows, sharedSurfaceOrigins);
    sharedStopCenter3d = (() => {
      try { return extractStopCenter3d(sharedStopInfo); } catch (_) { return null; }
    })();
    sharedSolveScopeKey = `${JSON.stringify(opticalSystemRows)}||${Number.isFinite(Number(wavelength)) ? Number(wavelength) : 0.5876}||${conjugateType}||rust-only`;
  }

  const imageHeightCount = normalizedRows.reduce((acc, row) => {
    const posNorm = String((row as any)?.position ?? "").trim().toLowerCase();
    return posNorm === "imageheight" ? acc + 1 : acc;
  }, 0);
  let convertedCount = 0;
  const convertedRows: any[] = [];

  for (let rowIndex = 0; rowIndex < normalizedRows.length; rowIndex += 1) {
    const row = normalizedRows[rowIndex];
    const posNorm = String((row as any)?.position ?? "").trim().toLowerCase();
    if (posNorm !== "imageheight") {
      convertedRows.push(row);
      continue;
    }

    const preservedTarget = {
      x: parseFiniteNumber((row as any)?.__cooptImageHeightTarget?.x)
        ?? parseFiniteNumber((row as any)?.xHeightAngle)
        ?? parseFiniteNumber((row as any)?.xHeight)
        ?? parseFiniteNumber((row as any)?.x)
        ?? parseFiniteNumber((row as any)?.["object x"])
        ?? 0,
      y: parseFiniteNumber((row as any)?.__cooptImageHeightTarget?.y)
        ?? parseFiniteNumber((row as any)?.yHeightAngle)
        ?? parseFiniteNumber((row as any)?.yHeight)
        ?? parseFiniteNumber((row as any)?.y)
        ?? parseFiniteNumber((row as any)?.["object y"])
        ?? 0,
    };

    try {
      let effective = null;
      if (preferParaxialImageHeight && sharedParaxial) {
        if (conjugateType === 'infinite') {
          const focalLength = Number(sharedParaxial?.focalLength);
          const effectiveFocalLength = (Number.isFinite(focalLength) && Math.abs(focalLength) > 1e-12)
            ? Math.abs(focalLength)
            : 1;
          const solvedX = Math.atan2(Number.isFinite(preservedTarget.x) ? preservedTarget.x : 0, effectiveFocalLength) * (180 / Math.PI);
          const solvedY = Math.atan2(Number.isFinite(preservedTarget.y) ? preservedTarget.y : 0, effectiveFocalLength) * (180 / Math.PI);
          effective = {
            ...row,
            position: 'Angle',
            __cooptEffectivePosition: 'Angle',
            xFieldAngle: solvedX,
            yFieldAngle: solvedY,
            xHeightAngle: solvedX,
            yHeightAngle: solvedY,
            x: solvedX,
            y: solvedY,
            __cooptImageHeightSolve: {
              conjugateType,
              mode: 'infinite-angle-paraxial-fast',
              paraxial: { x: solvedX, y: solvedY },
              solved: { x: solvedX, y: solvedY },
              hit: { x: preservedTarget.x, y: preservedTarget.y },
              imageSurfaceIndex: sharedImageSurfaceIndex,
              wavelengthUm: wavelength,
            },
          };
        } else {
          const imgDist = Number(sharedParaxial?.imageDistance);
          const objSurf = opticalSystemRows?.[0];
          const objDist = objSurf ? Number(objSurf.thickness) : NaN;
          const mag = (Number.isFinite(imgDist) && Number.isFinite(objDist) && Math.abs(objDist) > 1e-12)
            ? (imgDist / objDist)
            : 1;
          const absMag = Math.abs(mag);
          const scale = absMag > 1e-12 ? 1 / absMag : 1;
          const solvedX = preservedTarget.x * scale;
          const solvedY = preservedTarget.y * scale;
          effective = {
            ...row,
            position: 'Rectangle',
            __cooptEffectivePosition: 'Rectangle',
            xHeight: solvedX,
            yHeight: solvedY,
            xHeightAngle: solvedX,
            yHeightAngle: solvedY,
            x: solvedX,
            y: solvedY,
            __cooptImageHeightSolve: {
              conjugateType,
              mode: 'finite-rectangle-paraxial-fast',
              paraxial: { x: solvedX, y: solvedY },
              solved: { x: solvedX, y: solvedY },
              hit: { x: preservedTarget.x, y: preservedTarget.y },
              imageSurfaceIndex: sharedImageSurfaceIndex,
              wavelengthUm: wavelength,
            },
          };
        }
      }
      let usedExactSolver = false;
      if (!effective && convertImageHeightToEffectiveObject) {
        usedExactSolver = true;
        effective = convertImageHeightToEffectiveObject(row, opticalSystemRows, wavelength, conjugateType, {
          skipTsValidation: true,
          validationTraceBackend: 'rust',
          precomputedSurfaceOrigins: sharedSurfaceOrigins,
          precomputedImageSurfaceIndex: sharedImageSurfaceIndex,
          precomputedStopInfo: sharedStopInfo,
          precomputedStopCenter3d: sharedStopCenter3d,
          precomputedParaxial: sharedParaxial,
          precomputedParaxialOnlyModel: false,
          precomputedSolveScopeKey: sharedSolveScopeKey,
        });
      }
      if (effective && typeof effective === "object") {
        const effectiveRow = { ...effective } as any;
        const effectivePosition = String(effectiveRow?.__cooptEffectivePosition ?? "").trim();
        if (effectivePosition.toLowerCase() === "rectangle") {
          const solvedX = parseFiniteNumber(effectiveRow?.xHeight)
            ?? parseFiniteNumber(effectiveRow?.x)
            ?? parseFiniteNumber(effectiveRow?.xHeightAngle)
            ?? 0;
          const solvedY = parseFiniteNumber(effectiveRow?.yHeight)
            ?? parseFiniteNumber(effectiveRow?.y)
            ?? parseFiniteNumber(effectiveRow?.yHeightAngle)
            ?? 0;
          effectiveRow.position = "Rectangle";
          effectiveRow.xHeight = solvedX;
          effectiveRow.yHeight = solvedY;
          effectiveRow.x = solvedX;
          effectiveRow.y = solvedY;
        } else if (effectivePosition.toLowerCase() === "angle") {
          const solvedX = parseFiniteNumber(effectiveRow?.xFieldAngle)
            ?? parseFiniteNumber(effectiveRow?.xAngle)
            ?? parseFiniteNumber(effectiveRow?.xHeightAngle)
            ?? 0;
          const solvedY = parseFiniteNumber(effectiveRow?.yFieldAngle)
            ?? parseFiniteNumber(effectiveRow?.yAngle)
            ?? parseFiniteNumber(effectiveRow?.fieldAngle)
            ?? parseFiniteNumber(effectiveRow?.yHeightAngle)
            ?? 0;
          effectiveRow.position = "Angle";
          effectiveRow.xHeightAngle = solvedX;
          effectiveRow.yHeightAngle = solvedY;
          effectiveRow.x = solvedX;
          effectiveRow.y = solvedY;
        }
        convertedRows.push({
          ...row,
          ...effectiveRow,
          __cooptImageHeightTarget: preservedTarget,
          position: effectiveRow.__cooptEffectivePosition ?? effectiveRow.position ?? (row as any)?.position,
          __cooptOriginalPosition: row.position,
        });
        convertedCount += 1;
        const percent = progressStart + ((progressEnd - progressStart) * convertedCount) / Math.max(1, imageHeightCount);
        emitProgress(percent, `${progressLabel}: converting ${convertedCount}/${imageHeightCount}`);
        if ((convertedCount % 3) === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        continue;
      }
    } catch (_) {
      // Fall through to the original row so the existing path still runs.
    }

    convertedRows.push({
      ...row,
      __cooptImageHeightTarget: preservedTarget,
      __cooptOriginalPosition: row.position,
    });
    convertedCount += 1;
    const percent = progressStart + ((progressEnd - progressStart) * convertedCount) / Math.max(1, imageHeightCount);
    emitProgress(percent, `${progressLabel}: converting ${convertedCount}/${imageHeightCount}`);
    if ((convertedCount % 3) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  emitProgress(progressEnd, `${progressLabel}: done`);
  if (normalizationCacheKey) {
    transverseObjectNormalizationCache.set(normalizationCacheKey, clonePlain(convertedRows));
    while (transverseObjectNormalizationCache.size > TRANSVERSE_OBJECT_NORMALIZATION_CACHE_LIMIT) {
      const firstKey = transverseObjectNormalizationCache.keys().next().value;
      if (firstKey !== undefined) transverseObjectNormalizationCache.delete(firstKey);
    }
  }
  return convertedRows;
}

function buildTransverseFieldSettingsFromObjectRows(objectRows: any[] = []): any[] {
  return objectRows.map((row, index) => {
    const originalPositionType = String((row as any)?.__cooptOriginalPosition ?? (row as any)?.position ?? (row as any)?.fieldType ?? (row as any)?.type ?? "").trim().toLowerCase();
    const positionType = String((row as any)?.position ?? (row as any)?.fieldType ?? (row as any)?.type ?? "").trim().toLowerCase();
    const isAngle = isAngleObjectPositionTagNativeLike(positionType);
    const parseNumber = (value: unknown): number | null => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const pointModeLabel = originalPositionType.includes("imageheight")
      ? "Image Height"
      : originalPositionType.includes("point")
        ? "Point"
        : isAngle
          ? "Angle"
          : "Point";
    const pointUnit = pointModeLabel === "Angle" ? "deg" : "mm";
    const imageHeightTargetX = parseNumber((row as any)?.__cooptImageHeightTarget?.x);
    const imageHeightTargetY = parseNumber((row as any)?.__cooptImageHeightTarget?.y);
    const displayPointX = pointModeLabel === "Angle"
      ? parseNumber((row as any)?.xFieldAngle ?? (row as any)?.xAngle ?? (row as any)?.xHeightAngle ?? (row as any)?.x)
      : pointModeLabel === "Image Height"
        ? imageHeightTargetX ?? parseNumber((row as any)?.xHeight ?? (row as any)?.x ?? (row as any)?.["object x"] ?? (row as any)?.xHeightAngle)
      : parseNumber((row as any)?.xHeight ?? (row as any)?.x ?? (row as any)?.xHeightAngle ?? (row as any)?.["object x"]);
    const displayPointY = pointModeLabel === "Angle"
      ? parseNumber((row as any)?.yFieldAngle ?? (row as any)?.fieldAngle ?? (row as any)?.yAngle ?? (row as any)?.yHeightAngle ?? (row as any)?.y)
      : pointModeLabel === "Image Height"
        ? imageHeightTargetY ?? parseNumber((row as any)?.yHeight ?? (row as any)?.y ?? (row as any)?.["object y"] ?? (row as any)?.yHeightAngle)
      : parseNumber((row as any)?.yHeight ?? (row as any)?.y ?? (row as any)?.yHeightAngle ?? (row as any)?.["object y"]);
    const actualAngleX = parseNumber((row as any)?.xFieldAngle ?? (row as any)?.xAngle ?? (row as any)?.xHeightAngle ?? (row as any)?.x);
    const actualAngleY = parseNumber((row as any)?.yFieldAngle ?? (row as any)?.fieldAngle ?? (row as any)?.yAngle ?? (row as any)?.yHeightAngle ?? (row as any)?.y);
    const actualHeightX = parseNumber((row as any)?.xHeight ?? (row as any)?.x ?? (row as any)?.xHeightAngle ?? (row as any)?.["object x"]);
    const actualHeightY = parseNumber((row as any)?.yHeight ?? (row as any)?.y ?? (row as any)?.yHeightAngle ?? (row as any)?.["object y"]);
    const pointXText = Number.isFinite(displayPointX as number) ? (displayPointX as number).toFixed(3) : "0.000";
    const pointYText = Number.isFinite(displayPointY as number) ? (displayPointY as number).toFixed(3) : "0.000";
    const displayNameBase = String((row as any)?.comment ?? (row as any)?.name ?? "").trim();
    const displayNameCore = `Object ${index + 1} (${pointModeLabel}: X=${pointXText} ${pointUnit}, Y=${pointYText} ${pointUnit})`;
    const displayName = displayNameBase ? `${displayNameCore} - ${displayNameBase}` : displayNameCore;

    if (isAngle) {
      const xAngle = Number.isFinite(actualAngleX as number) ? Number(actualAngleX) : 0;
      const yAngle = Number.isFinite(actualAngleY as number) ? Number(actualAngleY) : 0;
      return {
        objectIndex: index + 1,
        fieldType: "Angle",
        fieldAngle: yAngle,
        xFieldAngle: xAngle,
        yFieldAngle: yAngle,
        displayName,
      };
    }

    const xHeight = Number.isFinite(actualHeightX as number) ? Number(actualHeightX) : 0;
    const yHeight = Number.isFinite(actualHeightY as number) ? Number(actualHeightY) : 0;
    return {
      objectIndex: index + 1,
      fieldType: "Rectangle",
      xHeight,
      yHeight,
      displayName,
    };
  });
}

function validateAnalysisPreviewRequest(payload: RunAnalysisPreviewRequest): void {
  if (!payload || typeof payload !== "object") {
    throw new Error("run_analysis_preview requires a request payload");
  }
  assertArrayField(payload.opticalSystemRows, "opticalSystemRows", "run_analysis_preview");
  if (payload.sourceRows !== undefined) {
    assertArrayField(payload.sourceRows, "sourceRows", "run_analysis_preview");
  }
  if (payload.objectRows !== undefined) {
    assertArrayField(payload.objectRows, "objectRows", "run_analysis_preview");
  }
}

function validateAnalysisComputeRequest(payload: RunAnalysisComputeRequest): void {
  if (!payload || typeof payload !== "object") {
    throw new Error("run_analysis_compute requires a request payload");
  }
  assertArrayField(payload.opticalSystemRows, "opticalSystemRows", "run_analysis_compute");
  if (payload.sourceRows !== undefined) {
    assertArrayField(payload.sourceRows, "sourceRows", "run_analysis_compute");
  }
  if (payload.objectRows !== undefined) {
    assertArrayField(payload.objectRows, "objectRows", "run_analysis_compute");
  }
}

function validateSystemDataReportRequest(payload: RunSystemDataReportRequest): void {
  if (!payload || typeof payload !== "object") {
    throw new Error("run_system_data_report requires a request payload");
  }
  assertArrayField(payload.opticalSystemRows, "opticalSystemRows", "run_system_data_report");
  if (payload.sourceRows !== undefined) {
    assertArrayField(payload.sourceRows, "sourceRows", "run_system_data_report");
  }
  if (payload.objectRows !== undefined) {
    assertArrayField(payload.objectRows, "objectRows", "run_system_data_report");
  }
}

function interpolateAxisValue(axis: number[], values: number[], target: number): number {
  if (!Array.isArray(axis) || !Array.isArray(values) || axis.length === 0 || axis.length !== values.length) {
    return 0;
  }
  if (!Number.isFinite(target)) {
    return 0;
  }

  const firstX = Number(axis[0]);
  const lastX = Number(axis[axis.length - 1]);
  if (!Number.isFinite(firstX) || !Number.isFinite(lastX)) {
    return 0;
  }
  if (target <= firstX) {
    return Number.isFinite(Number(values[0])) ? Number(values[0]) : 0;
  }
  if (target >= lastX) {
    const tail = Number(values[values.length - 1]);
    return Number.isFinite(tail) ? tail : 0;
  }

  for (let i = 1; i < axis.length; i++) {
    const x0 = Number(axis[i - 1]);
    const x1 = Number(axis[i]);
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) continue;
    if (target > x1) continue;
    const y0 = Number(values[i - 1]);
    const y1 = Number(values[i]);
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return 0;
    const t = (target - x0) / (x1 - x0);
    return y0 + (y1 - y0) * t;
  }
  return 0;
}

function findLowerBracketValue(axis: number[], target: number): number | null {
  if (!Array.isArray(axis) || axis.length === 0 || !Number.isFinite(target)) {
    return null;
  }
  const numericAxis = axis.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (numericAxis.length === 0) {
    return null;
  }
  if (target <= numericAxis[0]) {
    return numericAxis[0];
  }
  for (let index = 1; index < numericAxis.length; index++) {
    if (target <= numericAxis[index]) {
      return numericAxis[index - 1];
    }
  }
  return numericAxis[numericAxis.length - 1];
}

function findUpperBracketValue(axis: number[], target: number): number | null {
  if (!Array.isArray(axis) || axis.length === 0 || !Number.isFinite(target)) {
    return null;
  }
  const numericAxis = axis.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (numericAxis.length === 0) {
    return null;
  }
  if (target >= numericAxis[numericAxis.length - 1]) {
    return numericAxis[numericAxis.length - 1];
  }
  for (let index = 0; index < numericAxis.length; index++) {
    if (target <= numericAxis[index]) {
      return numericAxis[index];
    }
  }
  return numericAxis[numericAxis.length - 1];
}

function cloneOpticalSystemRowsWithDefocusShiftNativeLike(rows: any[], defocusShiftMm: number): any[] {
  const src = Array.isArray(rows) ? rows : [];
  const out = src.map((row) => (row && typeof row === "object") ? { ...row } : row);
  const shift = Number(defocusShiftMm);
  if (!(Number.isFinite(shift) && Math.abs(shift) > 1e-15)) {
    return out;
  }

  const imageIdx = out.findIndex((row: any) =>
    String(row?.["object type"] ?? row?.object ?? row?.Object ?? "").trim().toLowerCase() === "image",
  );
  const targetIdx = imageIdx > 0 ? imageIdx - 1 : Math.max(0, out.length - 2);
  if (targetIdx < 0 || targetIdx >= out.length) {
    return out;
  }

  const targetRow = (out[targetIdx] && typeof out[targetIdx] === "object") ? { ...out[targetIdx] } : {};
  const currentThickness = Number((targetRow as any).thickness);
  (targetRow as any).thickness = (Number.isFinite(currentThickness) ? currentThickness : 0) + shift;
  out[targetIdx] = targetRow;
  return out;
}

function getPrimaryWavelengthUm(sourceRows: any[], fallback = 0.5876): number {
  const rows = Array.isArray(sourceRows) ? sourceRows : [];
  const isPrimary = (row: any) => {
    const v = row?.primary ?? row?.Primary ?? row?.["Primary Wavelength"];
    if (v === true || v === 1) return true;
    const s = String(v ?? "").trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s.includes("primary");
  };

  const picked = rows.find((row: any) => isPrimary(row));
  const primary = Number(picked?.wavelength ?? picked?.Wavelength);
  if (Number.isFinite(primary) && primary > 0) {
    return primary;
  }

  for (const row of rows) {
    const wl = Number(row?.wavelength ?? row?.Wavelength);
    if (Number.isFinite(wl) && wl > 0) {
      return wl;
    }
  }
  return fallback;
}

function isInfinitySpec(value: unknown): boolean {
  if (value === Infinity || value === -Infinity) return true;
  const text = String(value ?? "").trim().toUpperCase();
  return text === "INF" || text === "INFINITY" || text === "∞";
}

function pickImageSurfaceIndexNativeLike(opticalSystemRows: any[]): number {
  const rows = Array.isArray(opticalSystemRows) ? opticalSystemRows : [];
  if (rows.length === 0) return 0;
  let imageIndex = -1;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] || {};
    const objectType = String(row?.["object type"] ?? row?.object ?? row?.Object ?? "").trim().toLowerCase();
    if (objectType === "image") imageIndex = index;
  }
  return imageIndex >= 0 ? imageIndex : Math.max(0, rows.length - 1);
}

function isFiniteConjugateNativeLike(opticalSystemRows: any[]): boolean {
  const row0 = Array.isArray(opticalSystemRows) ? opticalSystemRows[0] : null;
  if (!row0 || typeof row0 !== "object") return false;
  return detectConjugateType(opticalSystemRows) === "finite";
}

function getObjectDistanceMmNativeLike(opticalSystemRows: any[]): number {
  const row0 = Array.isArray(opticalSystemRows) ? opticalSystemRows[0] : null;
  if (!row0 || typeof row0 !== "object") return 0;
  if (detectConjugateType(opticalSystemRows) === "infinite") return 0;
  const raw = (row0 as any)?.thickness ?? (row0 as any)?.Thickness ?? (row0 as any)?.distance;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function buildDefaultDistortionSourceRows(wavelengthUm: number): any[] {
  const wavelength = Number.isFinite(Number(wavelengthUm)) && Number(wavelengthUm) > 0 ? Number(wavelengthUm) : 0.5876;
  return [{
    id: "DistortionPrimarySource",
    name: "DistortionPrimarySource",
    wavelength,
    weight: 1,
    primary: "Primary Wavelength",
    isPrimary: true,
    color: "#22c55e",
  }];
}

function buildDistortionSourceRowsForWavelength(sourceRows: any[], wavelengthUm: number): any[] {
  const wavelength = Number.isFinite(Number(wavelengthUm)) && Number(wavelengthUm) > 0
    ? Number(wavelengthUm)
    : getPrimaryWavelengthUm(sourceRows, 0.5876);
  const rows = Array.isArray(sourceRows) ? sourceRows : [];
  if (rows.length === 0) {
    return buildDefaultDistortionSourceRows(wavelength);
  }

  let picked: any = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const wl = Number((row as any)?.wavelength ?? (row as any)?.Wavelength);
    if (!Number.isFinite(wl) || wl <= 0) continue;
    const delta = Math.abs(wl - wavelength);
    if (delta < bestDelta) {
      bestDelta = delta;
      picked = row;
    }
  }

  const base = picked && typeof picked === "object"
    ? { ...picked }
    : {};
  return [{
    ...base,
    id: String(base?.id ?? base?.name ?? "DistortionPrimarySource"),
    name: String(base?.name ?? base?.id ?? "DistortionPrimarySource"),
    wavelength,
    Wavelength: wavelength,
    weight: Number.isFinite(Number(base?.weight)) ? Number(base.weight) : 1,
    intensity: Number.isFinite(Number(base?.intensity)) ? Number(base.intensity) : 1,
    primary: "Primary Wavelength",
    isPrimary: true,
  }];
}

function pickPrimarySourceRowsNativeLike(sourceRows: any[], wavelengthMode?: string): any[] {
  const rows = Array.isArray(sourceRows) ? sourceRows : [];
  if (String(wavelengthMode || "all").trim().toLowerCase() !== "primary") {
    return rows;
  }
  if (rows.length === 0) return rows;
  const primaryWavelength = getPrimaryWavelengthUm(rows, 0.5876);
  const picked = rows.find((row: any) => {
    const wl = Number(row?.wavelength ?? row?.Wavelength);
    return Number.isFinite(wl) && Math.abs(wl - primaryWavelength) < 1e-12;
  });
  return picked ? [picked] : [rows[0]];
}

function getObjectPositionTagNativeLike(row: any): string {
  return String(row?.position ?? row?.object ?? row?.objectType ?? row?.type ?? "").trim().toLowerCase();
}

function isAngleObjectPositionTagNativeLike(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  return normalized === "angle"
    || normalized === "point"
    || normalized === "fieldangle"
    || normalized === "objectangle";
}

function deriveGridFieldModeNativeLike(objectRows: any[]): "angle" | "height" | "imageheight" {
  const rows = Array.isArray(objectRows) ? objectRows : [];
  if (rows.some((row) => getObjectPositionTagNativeLike(row).includes("imageheight"))) return "imageheight";
  if (rows.some((row) => {
    const tag = getObjectPositionTagNativeLike(row);
    return tag.includes("rectangle") || tag.includes("rect") || tag.includes("height");
  })) {
    return "height";
  }
  if (rows.some((row) => isAngleObjectPositionTagNativeLike(getObjectPositionTagNativeLike(row)))) return "angle";

  const hasNumericHeight = rows.some((row) => {
    const value = Number(row?.yHeight ?? row?.height ?? row?.["object y"]);
    return Number.isFinite(value);
  });
  return hasNumericHeight ? "height" : "angle";
}

function readGridFieldVectorNativeLike(row: any, mode: "angle" | "height" | "imageheight"): { x: number; y: number } {
  const pick = (...candidates: any[]): number => {
    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value)) return value;
    }
    return 0;
  };

  if (mode === "imageheight") {
    return {
      // Object-table data keeps the selected field value in the historical
      // xHeightAngle/yHeightAngle columns; position defines its actual unit.
      x: pick(row?.__cooptImageHeightTarget?.x, row?.xHeight, row?.xHeightAngle, row?.x, row?.["object x"]),
      y: pick(row?.__cooptImageHeightTarget?.y, row?.yHeight, row?.yHeightAngle, row?.y, row?.["object y"]),
    };
  }

  if (mode === "height") {
    return {
      // Do not mix angle columns into object-height extents.
      x: pick(row?.xHeight, row?.x, row?.["object x"]),
      y: pick(row?.yHeight, row?.y, row?.["object y"]),
    };
  }

  return {
    x: pick(row?.xFieldAngle, row?.xAngle, row?.xHeightAngle, row?.x),
    y: pick(row?.yFieldAngle, row?.fieldAngle, row?.yAngle, row?.yHeightAngle, row?.y),
  };
}

function deriveGridAxisExtentsNativeLike(objectRows: any[], mode: "angle" | "height" | "imageheight"): { x: number; y: number } {
  const rows = Array.isArray(objectRows) ? objectRows : [];
  if (rows.length === 0) return { x: 20, y: 20 };

  let maxX = 0;
  let maxY = 0;
  for (const row of rows) {
    const vector = readGridFieldVectorNativeLike(row, mode);
    if (Number.isFinite(vector.x)) maxX = Math.max(maxX, Math.abs(vector.x));
    if (Number.isFinite(vector.y)) maxY = Math.max(maxY, Math.abs(vector.y));
  }
  if (!(maxX > 0) && maxY > 0) maxX = maxY;
  if (!(maxY > 0) && maxX > 0) maxY = maxX;
  if (!(maxX > 0) && !(maxY > 0)) return { x: 20, y: 20 };
  return { x: maxX, y: maxY };
}

function isSkippableRayPathRowNativeLike(row: any): boolean {
  if (!row || typeof row !== "object") return true;
  const objectType = String(row?.["object type"] ?? row?.object ?? row?.Object ?? row?.type ?? "").trim().toLowerCase();
  if (!objectType) return false;
  if (objectType === "object") return true;
  if (objectType === "gap" || objectType.includes("gap")) return true;
  if (objectType === "ct" || objectType.includes("coordinate") || objectType.includes("coordtrans")) return true;

  const blockType = String(row?._blockType ?? row?.blockType ?? "").trim().toLowerCase();
  if (blockType === "paraxial" || blockType === "thinlens") {
    const surfaceRole = String(row?._surfaceRole ?? row?.surfaceRole ?? "").trim().toLowerCase();
    if (surfaceRole === "back") return true;
  }

  return false;
}

function surfaceIndexToRayPathPointIndexNativeLike(opticalSystemRows: any[], surfaceIndex: number | null | undefined): number | null {
  const rows = Array.isArray(opticalSystemRows) ? opticalSystemRows : [];
  if (!rows.length || surfaceIndex === null || surfaceIndex === undefined || !Number.isFinite(Number(surfaceIndex))) {
    return null;
  }
  const sIdx = Math.max(0, Math.min(Number(surfaceIndex), rows.length - 1));
  if (isSkippableRayPathRowNativeLike(rows[sIdx])) return null;

  let pointCount = 0;
  for (let index = 0; index <= sIdx; index += 1) {
    if (isSkippableRayPathRowNativeLike(rows[index])) continue;
    pointCount += 1;
  }
  return pointCount > 0 ? pointCount : null;
}

function normalizeDirectionVector(x: number, y: number, z: number): { x: number; y: number; z: number } {
  const mag = Math.hypot(x, y, z) || 1;
  return { x: x / mag, y: y / mag, z: z / mag };
}

function buildPerpendicularBasis(direction: { x: number; y: number; z: number }): {
  u: { x: number; y: number; z: number };
  v: { x: number; y: number; z: number };
} {
  const d = normalizeDirectionVector(direction.x, direction.y, direction.z);
  const helper = Math.abs(d.z) < 0.9
    ? { x: 0, y: 0, z: 1 }
    : { x: 0, y: 1, z: 0 };
  const ux = d.y * helper.z - d.z * helper.y;
  const uy = d.z * helper.x - d.x * helper.z;
  const uz = d.x * helper.y - d.y * helper.x;
  const u = normalizeDirectionVector(ux, uy, uz);
  const vx = d.y * u.z - d.z * u.y;
  const vy = d.z * u.x - d.x * u.z;
  const vz = d.x * u.y - d.y * u.x;
  const v = normalizeDirectionVector(vx, vy, vz);
  return { u, v };
}

function resolveInfiniteObjectZNativeLike(rows: any[], selectedObject: any, objectPlaneZ: number): number {
  const row0 = Array.isArray(rows) ? rows[0] : null;
  const rowRenderDistance = Number((row0 as any)?.objectRenderDistance);
  const objectRenderDistance = Number(
    selectedObject?.objectRenderDistance
      ?? selectedObject?.renderDistance
      ?? selectedObject?.distance
      ?? selectedObject?.z,
  );
  const renderDistance = (Number.isFinite(rowRenderDistance) && Math.abs(rowRenderDistance) > 1e-12)
    ? rowRenderDistance
    : ((Number.isFinite(objectRenderDistance) && Math.abs(objectRenderDistance) > 1e-12) ? objectRenderDistance : 0);

  if (Number.isFinite(renderDistance) && Math.abs(renderDistance) > 1e-12) {
    return -Math.abs(renderDistance);
  }
  return objectPlaneZ - 25.0;
}

function computeObjectSurfaceSagNativeLike(rows: any[], x: number, y: number): number {
  const row0 = Array.isArray(rows) ? rows[0] : null;
  if (!row0 || typeof row0 !== "object") return 0;

  const radius = Number((row0 as any)?.radius);
  if (!(Number.isFinite(radius) && Math.abs(radius) > 1e-12)) return 0;

  const conic = Number((row0 as any)?.conic);
  const surfType = String((row0 as any)?.surfType ?? (row0 as any)?.type ?? "").toLowerCase();
  const mode = surfType.includes("odd") ? "odd" : "even";
  const params: any = {
    radius,
    conic: Number.isFinite(conic) ? conic : 0,
  };
  for (let i = 1; i <= 10; i++) {
    const key = `coef${i}`;
    const c = Number((row0 as any)?.[key]);
    params[key] = Number.isFinite(c) ? c : 0;
  }

  const rho = Math.hypot(x, y);
  const sag = Number(asphericSag(rho, params, mode));
  return Number.isFinite(sag) ? sag : 0;
}

function buildOpdGridFromSamples(
  gridSize: number,
  pupilCoordinates: Array<{ x: number; y: number; ix: number; iy: number; r: number }>,
  values: number[],
): Array<Array<number | null>> {
  const n = Math.max(1, Math.floor(Number(gridSize) || 1));
  const out: Array<Array<number | null>> = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
  const count = Math.min(pupilCoordinates.length, values.length);
  for (let i = 0; i < count; i++) {
    const p = pupilCoordinates[i];
    const value = Number(values[i]);
    if (!p || !Number.isFinite(value)) continue;
    if (p.ix < 0 || p.iy < 0 || p.ix >= n || p.iy >= n) continue;
    out[p.iy][p.ix] = value;
  }
  return out;
}

function applyOpdDisplayModeNativeLike(
  analyzer: any,
  pupilCoordinates: Array<{ x: number; y: number; ix: number; iy: number; r: number }>,
  rawOpdsMicrons: number[],
  wavelengthUm: number,
  opdDisplayMode: string,
): number[] {
  const mode = String(opdDisplayMode || "pistonTiltRemoved");
  if (mode === "pistonTiltRemoved") {
    const fit = analyzer?._removeBestFitPlane?.(pupilCoordinates, rawOpdsMicrons);
    if (Array.isArray(fit?.residualMicrons) && fit.residualMicrons.length === rawOpdsMicrons.length) {
      return fit.residualMicrons.map((value: unknown) => Number(value) / wavelengthUm);
    }
    const low = analyzer?._calculateLowOrderRemovedStats?.(
      pupilCoordinates,
      rawOpdsMicrons,
      { removeIndices: [0, 1, 2], maxOrder: 2, pupilRange: 1.0 },
    );
    if (Array.isArray(low?.residualWaves) && low.residualWaves.length === rawOpdsMicrons.length) {
      return low.residualWaves.map((value: unknown) => Number(value));
    }
  }

  if (mode === "pistonTiltDefocusRemoved") {
    const low = analyzer?._calculateLowOrderRemovedStats?.(
      pupilCoordinates,
      rawOpdsMicrons,
      { removeIndices: [0, 1, 2, 4], maxOrder: 2, pupilRange: 1.0 },
    );
    if (Array.isArray(low?.residualWaves) && low.residualWaves.length === rawOpdsMicrons.length) {
      return low.residualWaves.map((value: unknown) => Number(value));
    }
  }

  return rawOpdsMicrons.map((value) => Number(value) / wavelengthUm);
}

function solveLinearSystemNativeLike(normal: number[][], rhs: number[]): number[] | null {
  const n = Math.min(normal.length, rhs.length);
  if (n <= 0) return null;
  const a: number[][] = Array.from({ length: n }, (_, i) => {
    const row = Array.from({ length: n + 1 }, (_, j) => (j < n ? Number(normal[i]?.[j]) : Number(rhs[i])));
    return row;
  });

  for (let col = 0; col < n; col++) {
    let pivot = col;
    let pivotAbs = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r][col]);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivot = r;
      }
    }
    if (!(Number.isFinite(pivotAbs) && pivotAbs > 1e-18)) return null;
    if (pivot !== col) {
      const tmp = a[col];
      a[col] = a[pivot];
      a[pivot] = tmp;
    }

    const piv = a[col][col];
    for (let c = col; c <= n; c++) a[col][c] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (!Number.isFinite(f) || Math.abs(f) < 1e-18) continue;
      for (let c = col; c <= n; c++) {
        a[r][c] -= f * a[col][c];
      }
    }
  }

  return Array.from({ length: n }, (_, i) => Number(a[i][n]));
}

function applyOpdDisplayModeGridNativeLike(
  rawGrid: Array<Array<number | null>>,
  mode: string,
): Array<Array<number | null>> {
  const m = String(mode || "pistonTiltRemoved").toLowerCase();
  if (m === "raw") return rawGrid.map((row) => row.slice());

  const h = rawGrid.length;
  if (h <= 0) return rawGrid.map((row) => row.slice());
  const w = Array.isArray(rawGrid[0]) ? rawGrid[0].length : 0;
  if (w <= 0) return rawGrid.map((row) => row.slice());

  const removeTilt = m === "pistontiltremoved" || m === "pistontiltdefocusremoved";
  const removeDefocus = m === "pistondefocusremoved" || m === "pistontiltdefocusremoved";
  const removePiston = m === "pistonremoved" || removeTilt || removeDefocus;
  if (!removePiston) return rawGrid.map((row) => row.slice());
  const basisDim = removeTilt && removeDefocus ? 4 : (removeTilt || removeDefocus ? 3 : 1);

  let pupilRadius = 0;
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const rawCell = rawGrid[iy]?.[ix];
      if (rawCell === null || rawCell === undefined) continue;
      const z = Number(rawCell);
      if (!Number.isFinite(z)) continue;
      const u = w > 1 ? -1 + (2 * ix) / (w - 1) : 0;
      const v = h > 1 ? -1 + (2 * iy) / (h - 1) : 0;
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      const r = Math.hypot(u, v);
      if (Number.isFinite(r) && r > pupilRadius) pupilRadius = r;
    }
  }
  if (!(Number.isFinite(pupilRadius) && pupilRadius > 1e-12)) pupilRadius = 1.0;

  const normal = Array.from({ length: basisDim }, () => Array.from({ length: basisDim }, () => 0));
  const rhs = Array.from({ length: basisDim }, () => 0);
  let sampleCount = 0;

  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const rawCell = rawGrid[iy]?.[ix];
      if (rawCell === null || rawCell === undefined) continue;
      const z = Number(rawCell);
      if (!Number.isFinite(z)) continue;
      const u = w > 1 ? -1 + (2 * ix) / (w - 1) : 0;
      const v = h > 1 ? -1 + (2 * iy) / (h - 1) : 0;
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      const xn = u / pupilRadius;
      const yn = v / pupilRadius;
      const rn2 = xn * xn + yn * yn;
      if (!Number.isFinite(rn2) || rn2 > 1.0 + 1e-9) continue;

      const phi = removeTilt && removeDefocus
        ? [1.0, xn, yn, 2.0 * rn2 - 1.0]
        : removeTilt
          ? [1.0, u, v, 0.0]
          : removeDefocus
            ? [1.0, 2.0 * rn2 - 1.0, 0.0, 0.0]
            : [1.0, 0.0, 0.0, 0.0];
      for (let i = 0; i < basisDim; i++) {
        rhs[i] += phi[i] * z;
        for (let j = 0; j < basisDim; j++) {
          normal[i][j] += phi[i] * phi[j];
        }
      }
      sampleCount += 1;
    }
  }

  if (sampleCount < basisDim) return rawGrid.map((row) => row.slice());
  const coeff = solveLinearSystemNativeLike(normal, rhs);
  if (!coeff || coeff.length < basisDim) return rawGrid.map((row) => row.slice());

  const out: Array<Array<number | null>> = rawGrid.map((row) => row.slice());
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const rawCell = rawGrid[iy]?.[ix];
      if (rawCell === null || rawCell === undefined) {
        out[iy][ix] = null;
        continue;
      }
      const z = Number(rawCell);
      if (!Number.isFinite(z)) {
        out[iy][ix] = null;
        continue;
      }
      const u = w > 1 ? -1 + (2 * ix) / (w - 1) : 0;
      const v = h > 1 ? -1 + (2 * iy) / (h - 1) : 0;
      const xn = u / pupilRadius;
      const yn = v / pupilRadius;
      const rn2 = xn * xn + yn * yn;
      if (!Number.isFinite(rn2) || rn2 > 1.0 + 1e-9) {
        out[iy][ix] = null;
        continue;
      }

      let fit = coeff[0];
      if (removeTilt && removeDefocus) {
        fit = coeff[0] + coeff[1] * xn + coeff[2] * yn + coeff[3] * (2.0 * rn2 - 1.0);
      } else if (removeTilt) {
        fit = coeff[0] + coeff[1] * u + coeff[2] * v;
      } else if (removeDefocus) {
        fit = coeff[0] + coeff[1] * (2.0 * rn2 - 1.0);
      }
      out[iy][ix] = z - fit;
    }
  }

  return out;
}

export async function opticsEcho(payload: OpticsEchoRequest): Promise<OpticsEchoResponse> {
  return invokeCommand<OpticsEchoRequest, OpticsEchoResponse>("optics_echo", payload);
}

export async function runRaytracePreview(
  payload: RaytracePreviewRequest,
): Promise<RaytracePreviewResponse> {
  return invokeCommand<RaytracePreviewRequest, RaytracePreviewResponse>("run_raytrace_preview", payload);
}

type SpotWasmWorkerPool = { workers: Worker[] };
let spotWasmWorkerPool: SpotWasmWorkerPool | null = null;
let spotWasmWorkerPoolQueue: Promise<void> = Promise.resolve();
let spotWasmWorkerRequestSequence = 0;
const SPOT_WASM_WORKER_MIN_RAYS = 512;
const SPOT_WASM_WORKER_TIMEOUT_MS = 12000;
const SPOT_WASM_WORKER_MAX_COUNT = 8;
let spotWasmWorkerPoolDisabledAfterFailure = false;

function resetSpotWasmWorkerPool(): void {
  if (!spotWasmWorkerPool) return;
  for (const worker of spotWasmWorkerPool.workers) {
    try { worker.terminate(); } catch (_) {}
  }
  spotWasmWorkerPool = null;
}

function getSpotWasmWorkerPool(workerCount: number): SpotWasmWorkerPool {
  const count = Math.max(1, Math.floor(workerCount));
  if (spotWasmWorkerPool?.workers.length === count) return spotWasmWorkerPool;
  resetSpotWasmWorkerPool();
  spotWasmWorkerPool = {
    workers: Array.from({ length: count }, () => new Worker(
      new URL("../../../evaluation/spot-wasm-worker.ts", import.meta.url),
      { type: "module" },
    )),
  };
  return spotWasmWorkerPool;
}

async function runSpotWasmWorkerJobs(jobs: any[]): Promise<any[][]> {
  if (!Array.isArray(jobs) || jobs.length === 0 || typeof Worker === "undefined") return [];
  const hardwareConcurrency = typeof navigator !== "undefined" ? Number(navigator.hardwareConcurrency) : jobs.length;
  const workerCount = Math.max(1, Math.min(
    jobs.length,
    SPOT_WASM_WORKER_MAX_COUNT,
    Number.isFinite(hardwareConcurrency) ? Math.max(1, Math.floor(hardwareConcurrency)) : jobs.length,
  ));
  const execute = async () => {
    const pool = getSpotWasmWorkerPool(workerCount);
    const output: any[][] = new Array(jobs.length);
    let nextJob = 0;
    await Promise.all(pool.workers.map(async (worker) => {
      while (nextJob < jobs.length) {
        const jobIndex = nextJob++;
        const requestId = `spot-${Date.now()}-${++spotWasmWorkerRequestSequence}-${jobIndex}`;
        output[jobIndex] = await new Promise<any[]>((resolve, reject) => {
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          const cleanup = () => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            if (timeoutId !== null) clearTimeout(timeoutId);
          };
          const onMessage = (event: MessageEvent<any>) => {
            if (event.data?.requestId !== requestId) return;
            cleanup();
            if (event.data?.ok !== true) reject(new Error(String(event.data?.error || "Spot WASM worker failed")));
            else resolve(Array.isArray(event.data?.summaries) ? event.data.summaries : []);
          };
          const onError = (event: ErrorEvent) => {
            cleanup();
            reject(new Error(String(event.message || "Spot WASM worker error")));
          };
          worker.addEventListener("message", onMessage);
          worker.addEventListener("error", onError);
          timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error(`Spot WASM worker timed out after ${SPOT_WASM_WORKER_TIMEOUT_MS} ms`));
          }, SPOT_WASM_WORKER_TIMEOUT_MS);
          try {
            worker.postMessage({ requestId, ...jobs[jobIndex] });
          } catch (error) {
            cleanup();
            reject(error);
          }
        });
      }
    }));
    return output;
  };
  const scheduled = spotWasmWorkerPoolQueue.then(execute, execute);
  spotWasmWorkerPoolQueue = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

export async function runNativeSpotRaytrace(
  payload: NativeSpotRaytraceRequest,
): Promise<NativeSpotRaytraceResponse> {
  const nowMs = () => {
    try {
      if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return performance.now();
      }
    } catch (_) {}
    return Date.now();
  };
  const normalizedPayload: NativeSpotRaytraceRequest = {
    ...(payload || {} as any),
    surfaceIndex: Number.isInteger((payload as any)?.surfaceIndex)
      ? Math.max(0, Number((payload as any).surfaceIndex))
      : pickImageSurfaceIndexNativeLike(Array.isArray((payload as any)?.opticalSystemRows) ? (payload as any).opticalSystemRows : []),
  } as NativeSpotRaytraceRequest;

  if (!isTauriRuntime() || normalizedPayload?.forceRustWasm === true) {
    const strictChiefOnly = normalizedPayload?.strictChiefOnly === true;
    const opticalSystemRows = Array.isArray(normalizedPayload?.opticalSystemRows) ? normalizedPayload.opticalSystemRows : [];
    if (opticalSystemRows.length === 0) {
      throw new Error("runNativeSpotRaytrace(web): opticalSystemRows is empty");
    }

    const targetSurface = Number.isInteger(normalizedPayload?.surfaceIndex)
      ? Math.max(0, Number(normalizedPayload.surfaceIndex))
      : Math.max(0, opticalSystemRows.length - 1);

    const toSeriesColor = (index: number) => {
      const palette = ["#60a5fa", "#34d399", "#f59e0b", "#f472b6", "#a78bfa", "#22d3ee"];
      return palette[index % palette.length];
    };
    const buildSpotMetrics = (points: Array<{ xUm: number; yUm: number }>, chiefPointUm?: { xUm: number; yUm: number }) => {
      if (!Array.isArray(points) || points.length === 0 || !chiefPointUm) {
        return { rmsUm: undefined, diameterUm: undefined };
      }
      const cx = Number(chiefPointUm.xUm);
      const cy = Number(chiefPointUm.yUm);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        return { rmsUm: undefined, diameterUm: undefined };
      }
      let sumSq = 0;
      let maxR2 = 0;
      let count = 0;
      for (const point of points) {
        const x = Number(point?.xUm);
        const y = Number(point?.yUm);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const dx = x - cx;
        const dy = y - cy;
        const r2 = dx * dx + dy * dy;
        sumSq += r2;
        if (r2 > maxR2) maxR2 = r2;
        count += 1;
      }
      if (count <= 0) {
        return { rmsUm: undefined, diameterUm: undefined };
      }
      return {
        rmsUm: Math.sqrt(sumSq / count),
        diameterUm: 2 * Math.sqrt(maxR2),
      };
    };

    if (Array.isArray(payload?.raySeries) && payload.raySeries.length > 0) {
      const { traceRayEvalBatchSummary, calculateSurfaceOrigins, transformPointToLocal } = await import("../../../raytracing/core/ray-tracing.ts");
      const requestSeries = payload.raySeries;
      const traceStartMs = nowMs();
      const requestedTraceBackend = String((payload as any)?.renderTraceBackend || "").trim().toLowerCase();
      const useRustTrace = requestedTraceBackend === "ts" ? false : true;
      const allowNonStrictRaytrace = (payload as any)?.allowNonStrictRaytrace === true;
      const traceOptions = {
        useRustWasm: useRustTrace,
        requireRustWasm: useRustTrace,
        disableWasmRayTracing: !useRustTrace,
        allowNonStrict: allowNonStrictRaytrace,
      } as any;

      type SpotSeriesDescriptor = {
        entry: any;
        index: number;
        rays: any[];
        wavelengthUm: number;
        batch: any[];
      };
      const descriptors: SpotSeriesDescriptor[] = requestSeries.map((entry: any, idx: number) => {
        const rays = Array.isArray(entry?.rays) ? entry.rays : [];
        const batch = rays.map((ray: any) => ({
          wavelength: Number(ray?.wavelengthUm) > 0 ? Number(ray.wavelengthUm) : 0.5876,
          pos: {
            x: Number(ray?.startP?.x) || 0,
            y: Number(ray?.startP?.y) || 0,
            z: Number(ray?.startP?.z) || 0,
          },
          dir: {
            x: Number(ray?.dir?.x) || 0,
            y: Number(ray?.dir?.y) || 0,
            z: Number(ray?.dir?.z) || 1,
          },
        }));

        const wavelengthUm = Number(rays.find((ray: any) => Number(ray?.wavelengthUm) > 0)?.wavelengthUm) || 0.5876;
        return { entry, index: idx, rays, wavelengthUm, batch };
      });

      const surfaceInfoList = calculateSurfaceOrigins(opticalSystemRows);
      const targetSurfaceInfo = Array.isArray(surfaceInfoList) && targetSurface < surfaceInfoList.length
        ? surfaceInfoList[targetSurface]
        : null;
      const toTargetLocalPoint = (point: any) => {
        if (!point || typeof point !== "object") return null;
        const local = targetSurfaceInfo ? transformPointToLocal(point, targetSurfaceInfo) : point;
        const x = Number(local?.x);
        const y = Number(local?.y);
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
      };
      // Rust/WASM prepares refractive-index metadata from the first ray's wavelength.
      // Keep wavelength groups separate, while flattening every field/series in a group
      // into one boundary crossing. Ray order and sampling are unchanged.
      const wavelengthGroups = new Map<string, SpotSeriesDescriptor[]>();
      for (const descriptor of descriptors) {
        const key = descriptor.wavelengthUm.toFixed(9);
        const group = wavelengthGroups.get(key);
        if (group) group.push(descriptor);
        else wavelengthGroups.set(key, [descriptor]);
      }
      const summariesBySeries: any[][] = descriptors.map(() => []);
      const preparedGroups = Array.from(wavelengthGroups.values()).map((group) => {
        const flatBatch: any[] = [];
        const offsets: Array<{ descriptor: SpotSeriesDescriptor; start: number; end: number }> = [];
        for (const descriptor of group) {
          const start = flatBatch.length;
          flatBatch.push(...descriptor.batch);
          offsets.push({ descriptor, start, end: flatBatch.length });
        }
        return { flatBatch, offsets, wavelengthUm: group[0]?.wavelengthUm || 0.5876 };
      });
      const preparedSeries = descriptors.map((descriptor) => ({
        flatBatch: descriptor.batch,
        offsets: [{
          descriptor,
          start: 0,
          end: descriptor.batch.length,
        }],
        wavelengthUm: descriptor.wavelengthUm,
      }));
      const totalRayCount = preparedSeries.reduce((sum, group) => sum + group.flatBatch.length, 0);
      let workerGroupSummaries: any[][] | null = null;
      const canUseWorkerPool = useRustTrace
        && !spotWasmWorkerPoolDisabledAfterFailure
        && preparedSeries.length > 1
        // A default optimizer Spot batch is 11 fields x 8 x 8 = 704 rays.
        // Parallelize it across the persistent field workers; the timeout below
        // guarantees recovery to the main WASM instance if a worker stalls.
        && totalRayCount >= SPOT_WASM_WORKER_MIN_RAYS
        && typeof Worker !== "undefined"
        && (typeof globalThis === "undefined" || (globalThis as any).__COOPT_SPOT_WORKERS !== false);
      if (canUseWorkerPool) {
        try {
          const rowsJsonByWavelength = new Map<string, string>();
          const getRowsJson = (wavelengthUm: number) => {
            const key = wavelengthUm.toFixed(9);
            const cached = rowsJsonByWavelength.get(key);
            if (cached !== undefined) return cached;
            const serialized = JSON.stringify(enrichRowsWithResolvedRindexForWasm(opticalSystemRows, wavelengthUm));
            rowsJsonByWavelength.set(key, serialized);
            return serialized;
          };
          workerGroupSummaries = await runSpotWasmWorkerJobs(preparedSeries.map((group) => ({
            opticalRowsJson: getRowsJson(group.wavelengthUm),
            rays: group.flatBatch,
            nStart: 1,
            targetSurfaceIndex: targetSurface,
            wavelengthUm: group.wavelengthUm,
            traceOptions,
          })));
        } catch (error) {
          resetSpotWasmWorkerPool();
          spotWasmWorkerPoolDisabledAfterFailure = true;
          console.warn("[Spot WorkerPool] failed; retrying on the main WASM instance", error);
          workerGroupSummaries = null;
        }
      }
      const processedGroups = workerGroupSummaries ? preparedSeries : preparedGroups;
      processedGroups.forEach(({ flatBatch, offsets }, groupIndex) => {
        const groupSummaries = workerGroupSummaries
          ? workerGroupSummaries[groupIndex]
          : (flatBatch.length > 0
            ? traceRayEvalBatchSummary(opticalSystemRows, flatBatch, 1.0, targetSurface, traceOptions)
            : []);
        const normalizedGroupSummaries = Array.isArray(groupSummaries) ? groupSummaries : [];
        for (const { descriptor, start, end } of offsets) {
          summariesBySeries[descriptor.index] = normalizedGroupSummaries.slice(start, end);
        }
      });

      const series = descriptors.map(({ entry, index: idx, rays, wavelengthUm }) => {
        const normalizedSummaries = summariesBySeries[idx] || [];

        const chiefIdx = rays.findIndex((r: any) => r?.isChief === true);
        const points = normalizedSummaries
          .map((s: any, rayIndex: number) => {
            if (!s?.success) return null;
            const local = toTargetLocalPoint(s?.hitPoint);
            if (!local) return null;
            const xUm = local.x * 1000;
            const yUm = local.y * 1000;
            return {
              xUm,
              yUm,
              rayIndex,
              isChiefRay: rayIndex === chiefIdx,
            };
          })
          .filter((p: any) => !!p);
        const chiefSummary = strictChiefOnly
          ? ((chiefIdx >= 0 && chiefIdx < normalizedSummaries.length)
            ? normalizedSummaries[chiefIdx]
            : null)
          : ((chiefIdx >= 0 && chiefIdx < normalizedSummaries.length)
            ? normalizedSummaries[chiefIdx]
            : normalizedSummaries.find((s: any) => !!s?.success && s?.hitPoint));
        const chiefLocal = toTargetLocalPoint(chiefSummary?.hitPoint);
        const chiefPointUm = chiefLocal
          ? { xUm: chiefLocal.x * 1000, yUm: chiefLocal.y * 1000 }
          : undefined;
        const spotMetrics = buildSpotMetrics(points, chiefPointUm as any);
        const statusCounts = normalizedSummaries.reduce((acc: Record<string, number>, s: any) => {
          const status = String(s?.status || (s?.success ? "ok" : "unknown"));
          acc[status] = (acc[status] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        return {
          label: String(entry?.label || `Series ${idx + 1}`),
          color: String(entry?.color || toSeriesColor(idx)),
          objectIndex: idx,
          wavelengthUm,
          points,
          chiefPointUm,
          rmsUm: Number.isFinite(Number(spotMetrics.rmsUm)) ? Number(spotMetrics.rmsUm) : undefined,
          diameterUm: Number.isFinite(Number(spotMetrics.diameterUm)) ? Number(spotMetrics.diameterUm) : undefined,
          hasFieldAngle: entry?.hasFieldAngle === true,
          statusCounts,
        };
      });

      const seriesStats = series.map((s: any, idx: number) => ({
        label: s.label,
        attemptedRays: Array.isArray(requestSeries[idx]?.rays) ? requestSeries[idx].rays.length : 0,
        hitRays: Array.isArray(s.points) ? s.points.length : 0,
        missRays: (() => {
          const attempted = Array.isArray(requestSeries[idx]?.rays) ? requestSeries[idx].rays.length : 0;
          const hit = Array.isArray(s.points) ? s.points.length : 0;
          return Math.max(0, attempted - hit);
        })(),
        statusCounts: (s && typeof s.statusCounts === "object" && !Array.isArray(s.statusCounts)) ? s.statusCounts : {},
        apertureBlockRays: Number(s?.statusCounts?.aperture_block || 0),
        noIntersectionRays: Number(s?.statusCounts?.no_intersection || 0),
        tirRays: Number(s?.statusCounts?.total_internal_reflection || 0),
        unknownFailRays: Number(s?.statusCounts?.unknown || 0),
        hitRatePercent: (() => {
          const attempted = Array.isArray(requestSeries[idx]?.rays) ? requestSeries[idx].rays.length : 0;
          return attempted > 0 ? ((s.points.length / attempted) * 100) : 0;
        })(),
      }));

      const totalAttemptedRays = seriesStats.reduce((sum: number, s: any) => sum + Number(s.attemptedRays || 0), 0);
      const totalHitRays = seriesStats.reduce((sum: number, s: any) => sum + Number(s.hitRays || 0), 0);
      const maxHitRays = seriesStats.reduce((max: number, s: any) => Math.max(max, Number(s.hitRays || 0)), 0);
      const meanHitRatePercent = seriesStats.length > 0
        ? seriesStats.reduce((sum: number, s: any) => sum + Number(s.hitRatePercent || 0), 0) / seriesStats.length
        : 0;
      const objectCount = new Set(
        requestSeries.map((entry: any, idx: number) => String(entry?.label || `Series ${idx + 1}`).replace(/\s+(Primary(?:\s*\([^)]*\))?|\d+(?:\.\d+)?\s*nm)\s*$/i, "").trim() || `Series ${idx + 1}`)
      ).size;
      const raysPerSeries = seriesStats.length > 0
        ? Math.max(0, ...seriesStats.map((s: any) => Number(s?.attemptedRays) || 0))
        : 0;
      const traceMs = Math.max(0, nowMs() - traceStartMs);

      return {
        backend: workerGroupSummaries ? "web-rust-wasm-series-worker-batch" : "web-rust-wasm-wavelength-batch",
        surfaceIndex: targetSurface,
        tracedRays: totalHitRays,
        requestedRays: totalAttemptedRays,
        generatedRays: totalAttemptedRays,
        wavelengthCount: new Set(series.map((s: any) => Number(s.wavelengthUm)).filter((v: number) => Number.isFinite(v) && v > 0)).size,
        seriesCount: seriesStats.length,
        traceBatchCount: processedGroups.length,
        objectCount,
        raysPerSeries,
        totalAttemptedRays,
        totalHitRays,
        maxHitRays,
        meanHitRatePercent,
        traceMs,
        seriesStats,
        series,
        message: "Computed via Web Rust/WASM spot raytrace API",
      };
    }

    const { generateSpotDiagramAsync } = await import("../../../evaluation/spot-diagram.ts");
    const { calculateSurfaceOrigins, transformPointToLocal } = await import("../../../raytracing/core/ray-tracing.ts");
    const sourceRowsRaw = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
    const sourceRows = pickPrimarySourceRowsNativeLike(sourceRowsRaw, payload?.wavelengthMode);
    const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
    const rayCount = Number.isInteger(payload?.rayCount)
      ? Math.max(1, Math.min(1001, Number(payload.rayCount)))
      : 501;
    const ringCount = Number.isInteger(payload?.ringCount) ? Math.max(1, Number(payload.ringCount)) : 10;

    const pattern = String(payload?.pattern || "annular").toLowerCase();
    const prevPattern = (globalThis as any).rayEmissionPattern;
    try {
      (globalThis as any).rayEmissionPattern = pattern;
    } catch (_) {}

    let out: any;
    try {
      out = await generateSpotDiagramAsync(
        opticalSystemRows,
        sourceRows,
        objectRows,
        targetSurface + 1,
        rayCount,
        ringCount,
        {
          useRustWasm: true,
          requireRustWasm: true,
          strictChiefRayMarker: payload?.forceRustWasm === true,
          // Keep LCA parity deterministic: avoid field-wise adaptive pupil scaling/retry behavior.
          physicalVignetting: payload?.forceRustWasm === true ? false : undefined,
          traceOptions: {
            useRustWasm: true,
            requireRustWasm: true,
            allowNonStrict: false,
          },
        },
      );
    } finally {
      try {
        (globalThis as any).rayEmissionPattern = prevPattern;
      } catch (_) {}
    }

    const spotData = Array.isArray(out?.spotData) ? out.spotData : [];
    const surfaceInfoList = calculateSurfaceOrigins(opticalSystemRows);
    const targetSurfaceInfo = (Array.isArray(surfaceInfoList) && targetSurface >= 0 && targetSurface < surfaceInfoList.length)
      ? surfaceInfoList[targetSurface]
      : null;
    const toLocalPointMm = (p: any): { x: number; y: number } | null => {
      if (!p || typeof p !== "object") return null;
      const px = Number(p?.x);
      const py = Number(p?.y);
      const pz = Number(p?.z);
      const gx = Number(p?.globalX);
      const gy = Number(p?.globalY);
      const gz = Number(p?.globalZ);

      // Prefer explicit global coords when present, then convert to target-surface local.
      if (targetSurfaceInfo && Number.isFinite(gx) && Number.isFinite(gy)) {
        const globalPoint = {
          x: gx,
          y: gy,
          z: Number.isFinite(gz) ? gz : (Number.isFinite(pz) ? pz : 0),
        };
        const localPoint = transformPointToLocal(globalPoint, targetSurfaceInfo);
        const lx = Number(localPoint?.x);
        const ly = Number(localPoint?.y);
        if (Number.isFinite(lx) && Number.isFinite(ly)) {
          return { x: lx, y: ly };
        }
      }

      // Fallback to raw coordinates when conversion is not possible.
      if (Number.isFinite(px) && Number.isFinite(py)) {
        return { x: px, y: py };
      }
      return null;
    };
    const series = spotData.map((obj: any, idx: number) => {
      const pointsRaw = Array.isArray(obj?.spotPoints) ? obj.spotPoints : [];
      const points = pointsRaw
        .map((p: any) => {
          const local = toLocalPointMm(p);
          if (!local) return null;
          return {
            xUm: local.x * 1000,
            yUm: local.y * 1000,
            rayIndex: Number.isInteger(p?.rayIndex) ? Number(p.rayIndex) : undefined,
            isChiefRay: p?.isChiefRay === true,
            pupilU: Number.isFinite(Number(p?.pupilU)) ? Number(p.pupilU) : undefined,
            pupilV: Number.isFinite(Number(p?.pupilV)) ? Number(p.pupilV) : undefined,
          };
        })
        .filter((p: any) => !!p && Number.isFinite(p.xUm) && Number.isFinite(p.yUm));
      const chiefSrc = strictChiefOnly
        ? pointsRaw.find((p: any) => p?.isChiefRay === true)
        : (pointsRaw.find((p: any) => p?.isChiefRay === true) || pointsRaw[0]);
      const chiefLocal = toLocalPointMm(chiefSrc);
      const chiefPointUm = chiefLocal
        ? { xUm: chiefLocal.x * 1000, yUm: chiefLocal.y * 1000 }
        : undefined;
      const spotMetrics = buildSpotMetrics(points, chiefPointUm as any);
      const wl = Number(pointsRaw.find((p: any) => Number(p?.wavelength) > 0)?.wavelength);

      return {
        label: String(obj?.objectId || obj?.objectType || `Object ${idx + 1}`),
        color: toSeriesColor(idx),
        objectIndex: idx,
        wavelengthUm: Number.isFinite(wl) && wl > 0 ? wl : undefined,
        points,
        chiefPointUm: chiefPointUm && Number.isFinite(chiefPointUm.xUm) && Number.isFinite(chiefPointUm.yUm)
          ? chiefPointUm
          : undefined,
        rmsUm: Number.isFinite(Number(spotMetrics.rmsUm)) ? Number(spotMetrics.rmsUm) : undefined,
        diameterUm: Number.isFinite(Number(spotMetrics.diameterUm)) ? Number(spotMetrics.diameterUm) : undefined,
        hasFieldAngle: true,
      };
    });

    const seriesStats = series.map((s: any, idx: number) => {
      const src = spotData[idx] || {};
      const attemptedRays = Number(src?.totalRays);
      const hitRays = Number(src?.successfulRays);
      const attempted = Number.isFinite(attemptedRays) ? attemptedRays : (Array.isArray(s.points) ? s.points.length : 0);
      const hits = Number.isFinite(hitRays) ? hitRays : (Array.isArray(s.points) ? s.points.length : 0);
      return {
        label: s.label,
        attemptedRays: attempted,
        hitRays: hits,
        hitRatePercent: attempted > 0 ? (hits / attempted) * 100 : 0,
      };
    });

    const totalAttemptedRays = seriesStats.reduce((sum: number, s: any) => sum + Number(s.attemptedRays || 0), 0);
    const totalHitRays = seriesStats.reduce((sum: number, s: any) => sum + Number(s.hitRays || 0), 0);
    const maxHitRays = seriesStats.reduce((max: number, s: any) => Math.max(max, Number(s.hitRays || 0)), 0);
    const meanHitRatePercent = seriesStats.length > 0
      ? seriesStats.reduce((sum: number, s: any) => sum + Number(s.hitRatePercent || 0), 0) / seriesStats.length
      : 0;
    const raysPerSeries = seriesStats.length > 0
      ? Math.max(0, ...seriesStats.map((s: any) => Number(s?.attemptedRays) || 0))
      : 0;

    return {
      backend: "web-rust-wasm",
      surfaceIndex: targetSurface,
      tracedRays: totalHitRays,
      requestedRays: totalAttemptedRays,
      generatedRays: totalAttemptedRays,
      wavelengthCount: new Set(series.map((s: any) => Number(s.wavelengthUm)).filter((v: number) => Number.isFinite(v) && v > 0)).size,
      seriesCount: seriesStats.length,
      objectCount: series.length,
      raysPerSeries,
      totalAttemptedRays,
      totalHitRays,
      maxHitRays,
      meanHitRatePercent,
      seriesStats,
      series,
      message: "Computed via Web Rust/WASM spot raytrace API",
    };
  }
  return invokeCommand<NativeSpotRaytraceRequest, NativeSpotRaytraceResponse>("run_native_spot_raytrace", normalizedPayload);
}

export async function runNativeSphericalAberration(
  payload: NativeSphericalAberrationRequest,
): Promise<NativeSphericalAberrationResponse> {
  if (!isTauriRuntime()) {
    const {
      preloadRustRayTracingWasm,
      getRustRayTracingWasmSync,
      getRustRayTracingWasmInitError,
    } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");

    // In strict mode, spherical aberration tracing must not start before Rust-WASM is ready.
    const rustApi = getRustRayTracingWasmSync() || await preloadRustRayTracingWasm();
    if (!rustApi) {
      const initError = getRustRayTracingWasmInitError?.() || "Rust-WASM backend is unavailable";
      throw new Error(`Web spherical aberration requires Rust-WASM, but initialization failed: ${initError}`);
    }

    // Keep the global WASM service synchronized for code paths that read getWASMSystem().
    try {
      const g = (typeof globalThis !== "undefined") ? (globalThis as any) : null;
      if (g && typeof g._setWASMSystem === "function") {
        g._setWASMSystem({ backend: "rust-wasm", isWASMReady: true, api: rustApi });
      }
    } catch {
      // Ignore global wiring failures and continue with direct Rust API path.
    }

    const { calculateLongitudinalAberrationAsync } = await import("../../../evaluation/aberrations/longitudinal-aberration.ts");
    const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
    const targetSurfaceIndex = Number.isInteger(payload?.surfaceIndex)
      ? Math.max(0, Number(payload.surfaceIndex))
      : Math.max(0, opticalSystemRows.length - 1);

    const wavelengths = (() => {
      const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
      const picked = sourceRows
        .map((row: any) => Number(row?.wavelength))
        .filter((wl: number) => Number.isFinite(wl) && wl > 0);
      if (payload?.wavelengthMode === 'primary' && picked.length > 0) return [picked[0]];
      return picked;
    })();

    const result = await calculateLongitudinalAberrationAsync(
      opticalSystemRows,
      targetSurfaceIndex,
      wavelengths,
      Number.isInteger(payload?.rayCount) ? Number(payload.rayCount) : 21,
      {
        requireRustWasm: true,
        referenceFocusMode: payload?.referenceFocusMode,
      },
    );
    if (!result) throw new Error("Web spherical aberration calculation failed");
    return {
      ...(result as any),
      backend: "web-rust-wasm",
      message: "Computed via Web Rust/WASM spherical aberration API",
      summary: (result as any)?.metadata || {},
    } as NativeSphericalAberrationResponse;
  }
  return invokeCommand<NativeSphericalAberrationRequest, NativeSphericalAberrationResponse>("run_native_spherical_aberration", payload);
}

export async function runNativeChiefRayAngle(
  payload: NativeChiefRayAngleRequest,
): Promise<NativeChiefRayAngleResponse> {
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
  const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];

  if (!isTauriRuntime()) {
    if (opticalSystemRows.length === 0) throw new Error("runNativeChiefRayAngle(web): opticalSystemRows is empty");
    if (objectRows.length === 0) throw new Error("runNativeChiefRayAngle(web): objectRows is empty");

    const { preloadRustRayTracingWasm, getRustRayTracingWasmInitError } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
    const rust = await preloadRustRayTracingWasm();
    const runNativeWasm = (rust as any)?.run_native_chief_ray_angle_wasm_json;
    if (typeof runNativeWasm !== "function") {
      const initError = String(getRustRayTracingWasmInitError?.() || "").trim();
      throw new Error(
        "runNativeChiefRayAngle(web): Rust-WASM chief ray angle API is unavailable. "
        + `Reason=${initError || "missing export run_native_chief_ray_angle_wasm_json"}`,
      );
    }

    const wasmOutRaw = runNativeWasm(JSON.stringify({
      opticalSystemRows,
      sourceRows,
      objectRows,
    }));
    const wasmOut = (typeof wasmOutRaw === "string") ? JSON.parse(wasmOutRaw) : wasmOutRaw;
    const chiefRayAngleDeg = Number((wasmOut as any)?.chiefRayAngleDeg);
    if (!Number.isFinite(chiefRayAngleDeg)) {
      throw new Error(
        "runNativeChiefRayAngle(web): Rust-WASM chief ray angle API returned no finite value. "
        + `Message=${String((wasmOut as any)?.message || "unknown")}`,
      );
    }

    return {
      backend: String((wasmOut as any)?.backend || "web-rust-wasm"),
      chiefRayAngleDeg,
      message: String((wasmOut as any)?.message || "Computed via Web Rust/WASM chief ray angle API"),
    } as NativeChiefRayAngleResponse;
  }

  return invokeCommand<NativeChiefRayAngleRequest, NativeChiefRayAngleResponse>(
    "run_native_chief_ray_angle",
    {
      opticalSystemRows,
      sourceRows,
      objectRows,
    },
  );
}

function buildAxisParaxialMetricSet(
  base: NativeParaxialMetrics,
  focalLength: unknown,
  backFocalLength: unknown,
  imageDistance: unknown,
  magnification?: unknown,
  workingFNumber?: unknown,
): NativeParaxialMetrics {
  const efl = Number(focalLength);
  const bfl = Number(backFocalLength);
  const imd = Number(imageDistance);
  const enpd = Number(base.ENPD);
  const expd = Number(base.EXPD);
  const beta = Number(magnification);
  const requestedWorkingFNumber = Number(workingFNumber);
  const finiteMetric = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
  const fnoImg = Number.isFinite(efl) && Math.abs(enpd) > 1e-12 ? Math.abs(efl / enpd) : 0;
  const fnoWrk = Number.isFinite(requestedWorkingFNumber) && requestedWorkingFNumber > 0
    ? Math.abs(requestedWorkingFNumber)
    : (requestedWorkingFNumber === Infinity
      ? Infinity
      : (Number.isFinite(imd) && Math.abs(expd) > 1e-12 ? Math.abs(imd / expd) : 0));
  const naImg = fnoWrk > 1e-12 ? 1 / (2 * fnoWrk) : 0;
  const fnoObj = Number.isFinite(beta) && Math.abs(beta) > 1e-12 && fnoWrk > 0
    ? Math.abs(fnoWrk / beta)
    : 0;
  const naObj = Number.isFinite(beta) ? Math.abs(naImg * beta) : 0;
  return {
    ...base,
    FL: finiteMetric(efl),
    EFL: finiteMetric(efl),
    BFL: finiteMetric(bfl),
    IMD: Number.isFinite(imd) ? imd : (imd === Infinity ? Infinity : finiteMetric(imd)),
    PMAG: finiteMetric(beta),
    FNO_OBJ: finiteMetric(fnoObj),
    FNO_IMG: finiteMetric(fnoImg),
    FNO_WRK: Number.isFinite(fnoWrk) ? fnoWrk : (fnoWrk === Infinity ? Infinity : finiteMetric(fnoWrk)),
    NA_OBJ: finiteMetric(naObj),
    NA_IMG: finiteMetric(naImg),
  };
}

async function addAxisResolvedParaxialMetrics(
  response: NativeParaxialMetricsResponse,
  opticalSystemRows: any[],
  sourceRows: any[],
): Promise<NativeParaxialMetricsResponse> {
  const { calculateParaxialData } = await import("../../../raytracing/core/ray-paraxial.ts");
  const wavelength = getPrimaryWavelengthUm(sourceRows, 0.5876);
  const paraxial = calculateParaxialData(opticalSystemRows, wavelength);
  if (!paraxial || !response?.metrics) return response;

  const objectThickness = Number(opticalSystemRows?.[0]?.thickness);
  const initialAlpha = Number.isFinite(objectThickness) && Math.abs(objectThickness) > 1e-12
    ? -1 / objectThickness
    : NaN;
  const magnificationFor = (finalAlpha: unknown): number => {
    const alpha = Number(finalAlpha);
    return Number.isFinite(initialAlpha) && Number.isFinite(alpha) && Math.abs(alpha) > 1e-12
      ? initialAlpha / alpha
      : 0;
  };
  const exitPupilPosition = Number(paraxial?.exitPupilDetails?.position);
  const exitPupilDiameter = Number(paraxial?.exitPupilDetails?.diameter);
  const workingFNumberFor = (imageDistance: unknown): number => {
    const distance = Number(imageDistance);
    if (distance === Infinity) return Infinity;
    return Number.isFinite(distance)
      && Number.isFinite(exitPupilPosition)
      && Number.isFinite(exitPupilDiameter)
      && Math.abs(exitPupilDiameter) > 1e-12
      ? Math.abs((-exitPupilPosition + distance) / exitPupilDiameter)
      : NaN;
  };

  const imageDistanceForX = paraxial.imageDistanceX ?? paraxial.imageDistance;
  const imageDistanceForY = paraxial.imageDistanceY ?? paraxial.imageDistance;

  const x = buildAxisParaxialMetricSet(
    response.metrics,
    paraxial.focalLengthX ?? paraxial.focalLength,
    paraxial.backFocalLengthX ?? paraxial.backFocalLength,
    imageDistanceForX,
    magnificationFor(paraxial.finalAlphaX ?? paraxial.finalAlpha),
    workingFNumberFor(imageDistanceForX),
  );
  const y = buildAxisParaxialMetricSet(
    response.metrics,
    paraxial.focalLengthY ?? paraxial.focalLength,
    paraxial.backFocalLengthY ?? paraxial.backFocalLength,
    imageDistanceForY,
    magnificationFor(paraxial.finalAlphaY ?? paraxial.finalAlpha),
    workingFNumberFor(imageDistanceForY),
  );
  const yPowered = Math.abs(Number(y.EFL)) > 1e-12;
  const xPowered = Math.abs(Number(x.EFL)) > 1e-12;
  const xFiniteFocus = Number.isFinite(Number(x.IMD));
  const yFiniteFocus = Number.isFinite(Number(y.IMD));
  const primaryAxis: "x" | "y" = xFiniteFocus !== yFiniteFocus
    ? (xFiniteFocus ? "x" : "y")
    : (yPowered || !xPowered ? "y" : "x");
  return {
    ...response,
    metrics: hasAnamorphicIdealThinLens(opticalSystemRows) ? (primaryAxis === "x" ? x : y) : response.metrics,
    axisMetrics: { x, y },
    axisFocusStatus: {
      x: xFiniteFocus ? "finite" : "afocal",
      y: yFiniteFocus ? "finite" : "afocal",
    },
    primaryAxis,
    message: `${response.message} (axis-resolved X/Y paraxial model)`,
  };
}

export async function runNativeParaxialMetrics(
  payload: NativeParaxialMetricsRequest,
): Promise<NativeParaxialMetricsResponse> {
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
  const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];

  if (!isTauriRuntime()) {
    if (opticalSystemRows.length === 0) throw new Error("runNativeParaxialMetrics(web): opticalSystemRows is empty");

    const { preloadRustRayTracingWasm, getRustRayTracingWasmInitError } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
    const rust = await preloadRustRayTracingWasm();
    const runNativeWasm = (rust as any)?.run_native_paraxial_metrics_wasm_json;
    if (typeof runNativeWasm !== "function") {
      const initError = String(getRustRayTracingWasmInitError?.() || "").trim();
      throw new Error(
        "runNativeParaxialMetrics(web): Rust-WASM paraxial metrics API is unavailable. "
        + `Reason=${initError || "missing export run_native_paraxial_metrics_wasm_json"}`,
      );
    }

    const wasmOutRaw = runNativeWasm(JSON.stringify({
      opticalSystemRows,
      sourceRows,
      objectRows,
    }));
    const wasmOut = (typeof wasmOutRaw === "string") ? JSON.parse(wasmOutRaw) : wasmOutRaw;
    const rawMetrics = ((wasmOut as any)?.metrics && typeof (wasmOut as any).metrics === "object")
      ? (wasmOut as any).metrics
      : {};
    const toMetric = (key: keyof NativeParaxialMetrics): number => {
      const value = Number((rawMetrics as any)?.[key]);
      return Number.isFinite(value) ? value : 0;
    };
    const metrics: NativeParaxialMetrics = {
      FL: toMetric("FL"),
      EFL: toMetric("EFL"),
      BFL: toMetric("BFL"),
      IMD: toMetric("IMD"),
      OBJD: toMetric("OBJD"),
      TSL: toMetric("TSL"),
      BEXP: toMetric("BEXP"),
      EXPD: toMetric("EXPD"),
      EXPP: toMetric("EXPP"),
      ENPD: toMetric("ENPD"),
      ENPP: toMetric("ENPP"),
      ENPM: toMetric("ENPM"),
      PMAG: toMetric("PMAG"),
      FNO_OBJ: toMetric("FNO_OBJ"),
      FNO_IMG: toMetric("FNO_IMG"),
      FNO_WRK: toMetric("FNO_WRK"),
      NA_OBJ: toMetric("NA_OBJ"),
      NA_IMG: toMetric("NA_IMG"),
    };

    const response = {
      backend: String((wasmOut as any)?.backend || "web-rust-wasm"),
      metrics,
      message: String((wasmOut as any)?.message || "Computed via Web Rust/WASM paraxial metrics API"),
    } as NativeParaxialMetricsResponse;
    return addAxisResolvedParaxialMetrics(response, opticalSystemRows, sourceRows);
  }

  const response = await invokeCommand<NativeParaxialMetricsRequest, NativeParaxialMetricsResponse>(
    "run_native_paraxial_metrics",
    {
      opticalSystemRows,
      sourceRows,
      objectRows,
    },
  );
  return addAxisResolvedParaxialMetrics(response, opticalSystemRows, sourceRows);
}

export async function runNativeSeidel(
  payload: NativeSeidelRequest,
): Promise<NativeSeidelResponse> {
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
  const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
  const afocal = payload?.afocal === true;
  const referenceWavelengthUm = Number(payload?.referenceWavelengthUm);

  if (hasAnamorphicIdealThinLens(opticalSystemRows)) {
    throw new Error(
      "Classical Seidel coefficients assume a rotationally symmetric system and are unavailable for different ideal-lens X/Y powers.",
    );
  }
  if (isRotationallySymmetricIdealThinLensOnlySystem(opticalSystemRows)) {
    const wavelengthUm = Number.isFinite(referenceWavelengthUm) && referenceWavelengthUm > 0
      ? referenceWavelengthUm
      : getPrimaryWavelengthUm(sourceRows, 0.5876);
    return {
      backend: "ideal-paraxial-analytic",
      totals: { I: 0, II: 0, III: 0, P: 0, IV: 0, V: 0, LCA: 0, TCA: 0 },
      surfaceCoefficients: [],
      stopSurfaceIndex: Math.max(0, opticalSystemRows.findIndex((row: any) => String(row?.["object type"] ?? row?.object ?? "").trim().toLowerCase() === "stop")),
      wavelengthUm,
      message: "Ideal rotationally symmetric Paraxial/ThinLens system: Seidel coefficients are zero by definition",
    };
  }
  if (hasIdealThinLens(opticalSystemRows)) {
    throw new Error(
      "Seidel coefficients for a mixed real-surface + ideal Paraxial/ThinLens system are not implemented. Replace the ideal block with real surfaces for this analysis.",
    );
  }

  if (!isTauriRuntime()) {
    if (opticalSystemRows.length === 0) throw new Error("runNativeSeidel(web): opticalSystemRows is empty");

    const wavelengthUm = (() => {
      if (Number.isFinite(referenceWavelengthUm) && referenceWavelengthUm > 0) return referenceWavelengthUm;
      for (const row of sourceRows) {
        const primaryRaw = String((row as any)?.primary ?? '').trim().toLowerCase();
        const primaryBool = Boolean((row as any)?.primary === true || (row as any)?.isPrimary === true);
        const wl = Number((row as any)?.wavelength);
        if ((primaryBool || primaryRaw.includes('primary')) && Number.isFinite(wl) && wl > 0) {
          return wl;
        }
      }
      for (const row of sourceRows) {
        const wl = Number((row as any)?.wavelength);
        if (Number.isFinite(wl) && wl > 0) return wl;
      }
      return 0.5876;
    })();
    const rowsForWasm = enrichRowsWithResolvedRindexForWasm(opticalSystemRows, wavelengthUm);
    const { preloadRustRayTracingWasm, getRustRayTracingWasmInitError } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
    const rust = await preloadRustRayTracingWasm();
    const runNativeWasm = (rust as any)?.run_native_seidel_wasm_json;
    if (typeof runNativeWasm !== "function") {
      const initError = String(getRustRayTracingWasmInitError?.() || "").trim();
      throw new Error(
        "runNativeSeidel(web): Rust-WASM Seidel API is unavailable. "
        + `Reason=${initError || "missing export run_native_seidel_wasm_json"}`,
      );
    }

    const wasmOutRaw = runNativeWasm(JSON.stringify({
      opticalSystemRows: rowsForWasm,
      sourceRows,
      objectRows,
      afocal,
      referenceWavelengthUm: Number.isFinite(referenceWavelengthUm) ? referenceWavelengthUm : undefined,
    }));
    const wasmOut = (typeof wasmOutRaw === "string") ? JSON.parse(wasmOutRaw) : wasmOutRaw;
    return {
      backend: String((wasmOut as any)?.backend || "web-rust-wasm"),
      totals: ((wasmOut as any)?.totals && typeof (wasmOut as any).totals === "object") ? (wasmOut as any).totals : {},
      surfaceCoefficients: Array.isArray((wasmOut as any)?.surfaceCoefficients) ? (wasmOut as any).surfaceCoefficients : [],
      stopSurfaceIndex: Number((wasmOut as any)?.stopSurfaceIndex) || 0,
      wavelengthUm: Number((wasmOut as any)?.wavelengthUm) || 0,
      message: String((wasmOut as any)?.message || "Computed via Web Rust/WASM Seidel API"),
    } as NativeSeidelResponse;
  }

  return invokeCommand<NativeSeidelRequest, NativeSeidelResponse>(
    "run_native_seidel",
    {
      opticalSystemRows,
      sourceRows,
      objectRows,
      afocal,
      referenceWavelengthUm: Number.isFinite(referenceWavelengthUm) ? referenceWavelengthUm : undefined,
    },
  );
}

export async function logNativeAstigmatismDebug(
  payload: NativeAstigmatismDebugRequest,
): Promise<NativeAstigmatismDebugResponse> {
  return invokeCommand<NativeAstigmatismDebugRequest, NativeAstigmatismDebugResponse>("log_native_astigmatism_debug", payload);
}

function hasQconSurfaceNativeLike(opticalSystemRows: any[] = []): boolean {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return false;

  for (const row of opticalSystemRows) {
    if (!row || typeof row !== "object") continue;
    const surfType = String((row as any)?.surfType ?? (row as any)?.["surf type"] ?? (row as any)?.type ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
    if (surfType.includes("qcon")) return true;
  }
  return false;
}

export async function runNativeAstigmatism(
  payload: NativeAstigmatismRequest,
): Promise<NativeAstigmatismResponse> {
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const forceWebQconFallback = hasQconSurfaceNativeLike(opticalSystemRows);
  const forceWasmInTauri = payload?.forceWasmInTauri === true || payload?.requireRustWasm === true;

  if (!isTauriRuntime() || forceWebQconFallback || forceWasmInTauri) {
    const {
      calculateAstigmatismDataNativeLike,
    } = await import("../../../evaluation/aberrations/astigmatism.ts");
    const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
    const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
    const targetSurfaceIndex = Number.isInteger(payload?.surfaceIndex)
      ? Math.max(0, Number(payload.surfaceIndex))
      : Math.max(0, opticalSystemRows.length - 1);

    const result = await calculateAstigmatismDataNativeLike(
      opticalSystemRows,
      sourceRows,
      objectRows,
      targetSurfaceIndex,
      {
        pointCount: Number.isInteger(payload?.pointCount) ? Number(payload.pointCount) : undefined,
        rayCount: Number.isInteger(payload?.rayCount) ? Number(payload.rayCount) : 100,
        ringCount: Number.isInteger(payload?.ringCount) ? Number(payload.ringCount) : 10,
        pattern: (payload?.pattern === "grid" || payload?.pattern === "cross" || payload?.pattern === "annular")
          ? payload.pattern
          : "annular",
        requireRustWasm: true,
        // Keep the web fallback aligned with the native Rust implementation.
        // The native astigmatism backend currently ignores chiefRayMode and always
        // evaluates against the stop-center chief reference.
        chiefRayMode: "stopCenter",
        wavelengthMode: payload?.wavelengthMode === "primary" ? "primary" : "all",
      },
    );

    if (!result) {
      throw new Error("Web astigmatism calculation failed");
    }

    const webResult = {
      ...(result as any),
      backend: "web-rust-wasm",
      message: "Computed via Web Rust/WASM astigmatism API",
    } as NativeAstigmatismResponse;

    const hasUsableRows = (() => {
      const rows = Array.isArray((webResult as any)?.data) ? (webResult as any).data : [];
      return rows.some((row: any) => (
        Number.isFinite(Number(row?.meridionalDeviation)) || Number.isFinite(Number(row?.sagittalDeviation))
      ));
    })();

    if (forceWebQconFallback && isTauriRuntime() && !hasUsableRows) {
      try {
        return await invokeCommand<NativeAstigmatismRequest, NativeAstigmatismResponse>("run_native_astigmatism", payload);
      } catch {
        // Keep web fallback result when native rescue is unavailable.
      }
    }

    return webResult;
  }
  return invokeCommand<NativeAstigmatismRequest, NativeAstigmatismResponse>("run_native_astigmatism", payload);
}

export async function runNativeTransverseAberration(
  payload: NativeTransverseAberrationRequest,
): Promise<NativeTransverseAberrationResponse> {
  const profileTransverse = !!(
    (payload && typeof payload === 'object' && payload.profileTransverse === true) ||
    (typeof globalThis !== 'undefined' && (globalThis as any).__COOPT_PROFILE_TRANSVERSE === true)
  );
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
  const normalizedObjectRows = await normalizeTransverseObjectRowsForImageHeight(
    opticalSystemRows,
    sourceRows,
    Array.isArray(payload?.objectRows) ? payload.objectRows : [],
    Number(payload?.wavelength),
    { preferParaxialImageHeight: true },
  );

  if (!isTauriRuntime()) {
    const {
      calculateTransverseAberrationAsync,
      getPrimaryWavelengthForAberration,
    } = await import("../../../evaluation/aberrations/transverse-aberration.ts");

    const targetSurfaceIndex = Number.isInteger(payload?.surfaceIndex)
      ? Math.max(0, Number(payload.surfaceIndex))
      : Math.max(0, opticalSystemRows.length - 1);
    const wavelength = Number.isFinite(Number(payload?.wavelength))
      ? Number(payload.wavelength)
      : getPrimaryWavelengthForAberration();
    const fieldSettings = normalizedObjectRows.length > 0
      ? buildTransverseFieldSettingsFromObjectRows(normalizedObjectRows)
      : null;

    const result = await calculateTransverseAberrationAsync(
      opticalSystemRows,
      targetSurfaceIndex,
      fieldSettings,
      wavelength,
      Number.isInteger(payload?.rayCount) ? Number(payload.rayCount) : 51,
      {
        requireRustWasm: true,
      },
    );
    if (!result) throw new Error("Web transverse aberration calculation failed");
    return {
      ...(result as any),
      backend: "web-rust-wasm",
      message: "Computed via Web Rust/WASM transverse aberration API",
    } as NativeTransverseAberrationResponse;
  }
  const jobId = String(payload?.jobId || `native-transverse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let unlistenNativeProfile: null | (() => void) = null;
  if (profileTransverse) {
    try {
      unlistenNativeProfile = await listen('analysis-progress', (event: any) => {
        try {
          const data = event?.payload || {};
          if (!data || String(data.jobId || '') !== jobId) return;
          const message = String(data.message || data.phase || '');
          if (message) {
            console.info(message);
          }
        } catch (_) {}
      });
    } catch (_) {
      unlistenNativeProfile = null;
    }
  }
  const normalizedPayload = {
    ...payload,
    opticalSystemRows,
    sourceRows,
    objectRows: normalizedObjectRows,
    jobId,
    profileTransverse: !!(
      (payload && typeof payload === 'object' && payload.profileTransverse === true) ||
      (typeof globalThis !== 'undefined' && (globalThis as any).__COOPT_PROFILE_TRANSVERSE === true)
    ),
  };
  try {
    return await invokeCommand<NativeTransverseAberrationRequest, NativeTransverseAberrationResponse>(
      "run_native_transverse_aberration",
      normalizedPayload,
    );
  } finally {
    if (typeof unlistenNativeProfile === 'function') {
      try { unlistenNativeProfile(); } catch (_) {}
    }
  }
}

export async function runNativeTransverseRmsUm(
  payload: NativeTransverseRmsRequest,
): Promise<NativeTransverseRmsResponse> {
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
  const normalizedObjectRows = await normalizeTransverseObjectRowsForImageHeight(
    opticalSystemRows,
    sourceRows,
    Array.isArray(payload?.objectRows) ? payload.objectRows : [],
    Number(payload?.wavelength),
  );

  const componentRaw = String(payload?.component ?? "total").trim().toLowerCase();
  const component = componentRaw === "meridional" || componentRaw === "sagittal"
    ? componentRaw
    : "total";

  if (!isTauriRuntime()) {
    const aberrationResponse = await runNativeTransverseAberration({
      ...payload,
      opticalSystemRows,
      sourceRows,
      objectRows: normalizedObjectRows,
    });

    const collectStats = (series: any[]) => {
      let sumSq = 0;
      let count = 0;
      if (!Array.isArray(series)) return { sumSq, count };
      for (const item of series) {
        const pts = Array.isArray(item?.points) ? item.points : [];
        for (const point of pts) {
          const value = Number(point?.transverseAberration);
          if (!Number.isFinite(value)) continue;
          sumSq += value * value;
          count += 1;
        }
      }
      return { sumSq, count };
    };

    const meridionalStats = collectStats((aberrationResponse as any)?.meridionalData);
    const sagittalStats = collectStats((aberrationResponse as any)?.sagittalData);

    let sumSq = 0;
    let count = 0;
    if (component === "meridional") {
      sumSq = meridionalStats.sumSq;
      count = meridionalStats.count;
      if (count === 0 && sagittalStats.count > 0) {
        sumSq = sagittalStats.sumSq;
        count = sagittalStats.count;
      }
    } else if (component === "sagittal") {
      sumSq = sagittalStats.sumSq;
      count = sagittalStats.count;
      if (count === 0 && meridionalStats.count > 0) {
        sumSq = meridionalStats.sumSq;
        count = meridionalStats.count;
      }
    } else {
      sumSq = meridionalStats.sumSq + sagittalStats.sumSq;
      count = meridionalStats.count + sagittalStats.count;
    }

    if (count <= 0) {
      throw new Error("Web transverse RMS calculation failed");
    }

    return {
      backend: String((aberrationResponse as any)?.backend || "web-rust-wasm"),
      wavelength: Number((aberrationResponse as any)?.wavelength ?? payload?.wavelength ?? 0.5876),
      targetSurface: Number((aberrationResponse as any)?.targetSurface ?? 0),
      stopSurface: Number((aberrationResponse as any)?.stopSurface ?? 0),
      rayCount: Number.isInteger(payload?.rayCount) ? Number(payload.rayCount) : 51,
      component: component as NativeTransverseRmsResponse["component"],
      meridionalCount: meridionalStats.count,
      sagittalCount: sagittalStats.count,
      rmsUm: Math.sqrt(sumSq / count) * 1000,
      message: "Computed via Web Rust/WASM transverse RMS API",
    };
  }

  return invokeCommand<NativeTransverseRmsRequest, NativeTransverseRmsResponse>(
    "run_native_transverse_rms_um",
    {
      ...payload,
      opticalSystemRows,
      sourceRows,
      objectRows: normalizedObjectRows,
      component,
    },
  );
}

export async function runNativeTransverseRmsBatch(
  payload: NativeTransverseRmsBatchRequest,
): Promise<NativeTransverseRmsBatchResponse> {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) {
    return { backend: "native-rust-transverse-rms-batch", results: [], message: "No transverse RMS items" };
  }

  if (!isTauriRuntime()) {
    const results = await Promise.all(items.map((item) => runNativeTransverseRmsUm(item)));
    return {
      backend: "web-rust-wasm-native-api",
      results,
      message: "Computed via Web Rust/WASM transverse RMS batch API",
    };
  }

  return invokeCommand<NativeTransverseRmsBatchRequest, NativeTransverseRmsBatchResponse>(
    "run_native_transverse_rms_batch",
    { items },
  );
}

function hasParaxialOrThinLensNativeLike(opticalSystemRows: any[] = []): boolean {
  return hasIdealThinLens(opticalSystemRows);
}

function isIdealParaxialOnlyNativeOpdSystem(opticalSystemRows: any[] = []): boolean {
  return isRotationallySymmetricIdealThinLensOnlySystem(opticalSystemRows);
}

function computeFiniteGridRmsNativeLike(grid: any): number {
  if (!Array.isArray(grid) || grid.length === 0) return Number.NaN;
  let directSumSq = 0;
  let directCount = 0;
  for (const row of grid) {
    if (!Array.isArray(row)) continue;
    for (const value of row) {
      if (value === null || value === undefined) continue;
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) continue;
      directSumSq += numeric * numeric;
      directCount += 1;
    }
  }
  if (directCount === 0) return Number.NaN;
  return Math.sqrt(Math.max(0, directSumSq / directCount));

  /* istanbul ignore next: retained below only for historical fallback reference. */
  const height = grid.length;
  const width = grid.reduce((max: number, row: any) => Array.isArray(row) ? Math.max(max, row.length) : max, 0);
  if (width === 0) return Number.NaN;
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  let sumYY = 0;
  let sumZ = 0;
  let sumXZ = 0;
  let sumYZ = 0;
  let fallbackSum = 0;
  let fallbackSumSq = 0;
  const coordinate = (index: number, length: number) => length <= 1 ? 0 : -1 + (2 * index) / (length - 1);

  for (let iy = 0; iy < height; iy += 1) {
    const row = grid[iy];
    if (!Array.isArray(row)) continue;
    const y = coordinate(iy, height);
    for (let ix = 0; ix < row.length; ix += 1) {
      const value = Number(row[ix]);
      if (!Number.isFinite(value)) continue;
      const x = coordinate(ix, width);
      count += 1;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
      sumYY += y * y;
      sumZ += value;
      sumXZ += x * value;
      sumYZ += y * value;
      fallbackSum += value;
      fallbackSumSq += value * value;
    }
  }
  if (count === 0) return Number.NaN;

  const matrix = [
    [count, sumX, sumY, sumZ],
    [sumX, sumXX, sumXY, sumXZ],
    [sumY, sumXY, sumYY, sumYZ],
  ];
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    if (Math.abs(matrix[pivot][column]) < 1e-18) {
      const mean = fallbackSum / count;
      return Math.sqrt(Math.max(0, fallbackSumSq / count - mean * mean));
    }
    if (pivot !== column) [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let index = column; index < 4; index += 1) matrix[column][index] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let index = column; index < 4; index += 1) matrix[row][index] -= factor * matrix[column][index];
    }
  }

  const piston = matrix[0][3];
  const tiltX = matrix[1][3];
  const tiltY = matrix[2][3];
  let residualSumSq = 0;
  for (let iy = 0; iy < height; iy += 1) {
    const row = grid[iy];
    if (!Array.isArray(row)) continue;
    const y = coordinate(iy, height);
    for (let ix = 0; ix < row.length; ix += 1) {
      const value = Number(row[ix]);
      if (!Number.isFinite(value)) continue;
      const x = coordinate(ix, width);
      const residual = value - (piston + tiltX * x + tiltY * y);
      residualSumSq += residual * residual;
    }
  }
  return Math.sqrt(Math.max(0, residualSumSq / count));
}

function getThinLensFocalPairNativeLike(row: any): { fx: number; fy: number } {
  return getIdealThinLensFocalPair(row);
}

function buildIdealParaxialAnalyticOpdResponse(
  opticalSystemRows: any[],
  payload: NativeOpdMapRequest,
  wavelengthUm: number,
  gridSize: number,
  opdDisplayMode: string,
  objectIndex: number,
  isAngle: boolean,
  xVal: number,
  yVal: number,
): NativeOpdMapResponse | null {
  if (!isIdealParaxialOnlyNativeOpdSystem(opticalSystemRows)) return null;

  const targetSurface = Number.isInteger(payload?.surfaceIndex)
    ? Math.max(0, Number(payload.surfaceIndex))
    : pickImageSurfaceIndexNativeLike(opticalSystemRows);

  let lensIndex = -1;
  let fx = Number.POSITIVE_INFINITY;
  let fy = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= targetSurface && i < opticalSystemRows.length; i++) {
    const row = opticalSystemRows[i];
    if (!hasParaxialOrThinLensNativeLike([row])) continue;
    const pair = getThinLensFocalPairNativeLike(row);
    if (Number.isFinite(pair.fx) || Number.isFinite(pair.fy)) {
      lensIndex = i;
      fx = pair.fx;
      fy = pair.fy;
    }
  }
  if (lensIndex < 0) return null;
  if (!Number.isFinite(fx) && Number.isFinite(fy)) fx = fy;
  if (!Number.isFinite(fy) && Number.isFinite(fx)) fy = fx;
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;

  const originsZ = Array.from({ length: opticalSystemRows.length }, () => 0);
  let runningZ = 0;
  for (let i = 0; i < opticalSystemRows.length; i++) {
    originsZ[i] = runningZ;
    const rawThickness = opticalSystemRows[i]?.thickness ?? opticalSystemRows[i]?.Thickness;
    if (!isInfinitySpec(rawThickness)) {
      const thickness = Number(rawThickness);
      if (Number.isFinite(thickness)) runningZ += thickness;
    }
  }

  const lensZ = Number(originsZ[lensIndex]) || 0;
  const targetZ = Number(originsZ[targetSurface]) || lensZ;
  const imageDistanceMm = targetZ - lensZ;
  if (!(Number.isFinite(imageDistanceMm) && imageDistanceMm >= 0)) return null;

  const stopSurface = Math.max(0, opticalSystemRows.findIndex((r: any) => String(r?.["object type"] ?? r?.object ?? r?.Object ?? "").trim().toLowerCase() === "stop"));
  const stopRow = opticalSystemRows[stopSurface] || {};
  const semidia = Math.abs(Number(stopRow?.semidia ?? stopRow?.Semidia ?? stopRow?.["Semi Diameter"]));
  const aperture = Math.abs(Number(stopRow?.aperture ?? stopRow?.Aperture));
  const pupilRadiusMm = Math.max(0.01,
    Number.isFinite(aperture) && aperture > 0 ? aperture * 0.5 :
    Number.isFinite(semidia) && semidia > 0 ? semidia : 5,
  );

  const rawOpdGrid: Array<Array<number | null>> = Array.from({ length: gridSize }, () => Array.from({ length: gridSize }, () => null));
  let hitCount = 0;
  let sampleCount = 0;
  for (let iy = 0; iy < gridSize; iy++) {
    const v = gridSize > 1 ? -1 + (2 * iy) / (gridSize - 1) : 0;
    for (let ix = 0; ix < gridSize; ix++) {
      const u = gridSize > 1 ? -1 + (2 * ix) / (gridSize - 1) : 0;
      const r2 = u * u + v * v;
      if (!Number.isFinite(r2) || r2 > 1 + 1e-9) continue;
      sampleCount += 1;
      const x = u * pupilRadiusMm;
      const y = v * pupilRadiusMm;
      const opdMm = 0.5 * (
        ((imageDistanceMm - fx) * (x * x)) / Math.max(1e-12, fx * fx)
        + ((imageDistanceMm - fy) * (y * y)) / Math.max(1e-12, fy * fy)
      );
      const opdWaves = (opdMm * 1000.0) / Math.max(1e-12, wavelengthUm);
      rawOpdGrid[iy][ix] = Number.isFinite(opdWaves) ? opdWaves : null;
      hitCount += 1;
    }
  }

  const displayOpdGrid = applyOpdDisplayModeGridNativeLike(rawOpdGrid, opdDisplayMode);
  return {
    backend: "ideal-paraxial-analytic",
    targetSurface,
    stopSurface,
    requestedObjectIndex: objectIndex,
    usedObjectIndex: objectIndex,
    usedObjectPosition: isAngle ? "angle" : "height",
    usedObjectX: xVal,
    usedObjectY: yVal,
    wavelengthUm,
    gridSize,
    sampleCount,
    hitCount,
    pupilSamplingMode: "stop",
    rawOpdGrid,
    displayOpdGrid,
    message: `Computed via analytic ideal-paraxial defocus model (imageDistance=${imageDistanceMm.toFixed(6)}mm, fx=${fx.toFixed(6)}mm, fy=${fy.toFixed(6)}mm)`,
  } as NativeOpdMapResponse;
}

function clampIdealParaxialNativeOpdResponse(
  opticalSystemRows: any[] = [],
  response: NativeOpdMapResponse,
): NativeOpdMapResponse {
  if (!isIdealParaxialOnlyNativeOpdSystem(opticalSystemRows) || !response || typeof response !== "object") {
    return response;
  }

  const displayGrid = Array.isArray((response as any).displayOpdGrid)
    ? (response as any).displayOpdGrid
    : null;
  const displayRms = computeFiniteGridRmsNativeLike(displayGrid);
  if (!(Number.isFinite(displayRms) && displayRms <= 2e-2)) {
    return response;
  }

  const zeroFiniteGrid = (grid: any) => {
    if (!Array.isArray(grid)) return grid;
    return grid.map((row: any) => {
      if (!Array.isArray(row)) return row;
      return row.map((v: any) => (Number.isFinite(Number(v)) ? 0 : v));
    });
  };

  return {
    ...response,
    displayOpdGrid: zeroFiniteGrid(displayGrid),
    message: String((response as any).message || "") + " [ideal-paraxial-display-normalized]",
  } as NativeOpdMapResponse;
}

function clampIdealParaxialNativeOpdRmsResponse(
  opticalSystemRows: any[] = [],
  response: NativeOpdRmsWavesResponse,
): NativeOpdRmsWavesResponse {
  const displayRmsWaves = Number(response?.rmsWaves);
  const referenceOpdRmsUm = Number(response?.referenceOpdRmsUm);
  const wavelengthUm = Number(response?.wavelengthUm);
  const namedResponse = {
    ...response,
    displayRmsWaves: Number.isFinite(displayRmsWaves) ? displayRmsWaves : undefined,
    referenceRmsWaves: Number.isFinite(referenceOpdRmsUm) && Number.isFinite(wavelengthUm) && wavelengthUm > 0
      ? referenceOpdRmsUm / wavelengthUm
      : undefined,
  } as NativeOpdRmsWavesResponse;
  if (!isIdealParaxialOnlyNativeOpdSystem(opticalSystemRows) || !response || typeof response !== "object") {
    return namedResponse;
  }

  const displayRms = Number((namedResponse as any).rmsWaves);
  if (!(Number.isFinite(displayRms) && displayRms <= 2e-2)) {
    return namedResponse;
  }

  return {
    ...namedResponse,
    rmsWaves: 0,
    displayRmsWaves: 0,
    message: String((response as any).message || "") + " [ideal-paraxial-display-normalized]",
  } as NativeOpdRmsWavesResponse;
}

export async function runNativeOpdMap(
  payload: NativeOpdMapRequest,
): Promise<NativeOpdMapResponse> {
  const scaleToReferenceWavelength = (response: NativeOpdMapResponse): NativeOpdMapResponse => {
    if ((payload as any)?.opdWaveNormalization === "trace") {
      return response;
    }
    const traceWavelengthUm = Number(response?.wavelengthUm ?? payload?.wavelengthUm);
    const referenceWavelengthUm = Number(payload?.opdReferenceWavelengthUm);
    if (!Number.isFinite(traceWavelengthUm) || traceWavelengthUm <= 0
      || !Number.isFinite(referenceWavelengthUm) || referenceWavelengthUm <= 0) {
      return response;
    }
    const responseReferenceWavelengthUm = Number(response?.opdReferenceWavelengthUm);
    if (Number.isFinite(responseReferenceWavelengthUm)
      && Math.abs(responseReferenceWavelengthUm - referenceWavelengthUm) <= 1e-12) {
      return response;
    }
    const scale = traceWavelengthUm / referenceWavelengthUm;
    const scaleGrid = (grid: Array<Array<number | null>> | undefined) => Array.isArray(grid)
      ? grid.map((row) => row.map((value) => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) * scale : null))
      : grid;
    return {
      ...response,
      opdReferenceWavelengthUm: referenceWavelengthUm,
      rawOpdGrid: scaleGrid(response.rawOpdGrid) as Array<Array<number | null>>,
      unreferencedOpdGrid: scaleGrid(response.unreferencedOpdGrid),
      displayOpdGrid: scaleGrid(response.displayOpdGrid) as Array<Array<number | null>>,
      referenceSphereOpdGrid: scaleGrid(response.referenceSphereOpdGrid),
    };
  };
  const normalizedPayload: NativeOpdMapRequest = {
    ...(payload || {} as any),
    referenceMode: sanitizeOpdReferenceMode((payload as any)?.referenceMode || readConfiguredOpdReferenceMode()),
    surfaceIndex: Number.isInteger((payload as any)?.surfaceIndex)
      ? Math.max(0, Number((payload as any).surfaceIndex))
      : pickImageSurfaceIndexNativeLike(Array.isArray((payload as any)?.opticalSystemRows) ? (payload as any).opticalSystemRows : []),
  } as NativeOpdMapRequest;
  payload = normalizedPayload;
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const configuredReferenceMode = sanitizeOpdReferenceMode(payload?.referenceMode);
  const requestedPupilSamplingMode = (payload?.pupilSamplingMode === "stop" || payload?.pupilSamplingMode === "entrance")
    ? payload.pupilSamplingMode
    : "stop";
  const requestedChiefRayMode = sanitizeOpdChiefRayMode(payload?.chiefRayMode);
  const pupilNormalizationMode = sanitizeOpdPupilNormalizationMode(payload?.pupilNormalizationMode);
  const requestedExitPupilReferencePointMode = sanitizeOpdExitPupilReferencePointMode(
    payload?.exitPupilReferencePointMode,
  );
  const referenceSphereOptions = payload?.referenceSphereOptions || readConfiguredOpdReferenceSphereOptions();
  if (!isTauriRuntime() || configuredReferenceMode !== "exit-pupil" || requestedPupilSamplingMode === "entrance") {
    if (opticalSystemRows.length === 0) throw new Error("runNativeOpdMap(web): opticalSystemRows is empty");

    const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
    const inputObjectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
    let objectRows = inputObjectRows;
    const objectIndex = Number.isInteger(payload?.objectIndex) ? Math.max(0, Number(payload.objectIndex)) : 0;
    let selectedObject = objectRows[objectIndex] || objectRows[0] || {};
    const wavelengthUm = (() => {
      const explicit = Number(payload?.wavelengthUm);
      if (Number.isFinite(explicit) && explicit > 0) return explicit;
      for (const row of sourceRows) {
        const primaryRaw = String((row as any)?.primary ?? '').trim().toLowerCase();
        const primaryBool = Boolean((row as any)?.primary === true || (row as any)?.isPrimary === true);
        const wl = Number((row as any)?.wavelength);
        if ((primaryBool || primaryRaw.includes('primary')) && Number.isFinite(wl) && wl > 0) {
          return wl;
        }
      }
      for (const row of sourceRows) {
        const wl = Number((row as any)?.wavelength);
        if (Number.isFinite(wl) && wl > 0) return wl;
      }
      return 0.5876;
    })();
    objectRows = await normalizeTransverseObjectRowsForImageHeight(
      opticalSystemRows,
      sourceRows,
      inputObjectRows,
      wavelengthUm,
      { preferParaxialImageHeight: false },
    );
    selectedObject = objectRows[objectIndex] || objectRows[0] || {};
    const objectType = String((selectedObject as any)?.position ?? (selectedObject as any)?.object ?? '').toLowerCase();
    const isAngle = isAngleObjectPositionTagNativeLike(objectType);
    const xVal = Number((selectedObject as any)?.xHeightAngle ?? (selectedObject as any)?.xFieldAngle ?? (selectedObject as any)?.xHeight ?? (selectedObject as any)?.x ?? 0) || 0;
    const yVal = Number((selectedObject as any)?.yHeightAngle ?? (selectedObject as any)?.yFieldAngle ?? (selectedObject as any)?.fieldAngle ?? (selectedObject as any)?.yHeight ?? (selectedObject as any)?.y ?? 0) || 0;
    const gridSize = Number.isFinite(Number(payload?.gridSize)) ? Math.max(17, Math.floor(Number(payload.gridSize))) : 129;
    const referenceMode = sanitizeOpdReferenceMode(payload?.referenceMode);
    const opdDisplayMode = String(payload?.opdDisplayMode || "pistonTiltRemoved");
    const targetSurface = Number.isInteger(payload?.surfaceIndex) && Number(payload.surfaceIndex) >= 0
      ? Number(payload.surfaceIndex)
      : pickImageSurfaceIndexNativeLike(opticalSystemRows);

    let chiefRayLaunchOrigin = payload?.chiefRayLaunchOrigin;
    let chiefRayLaunchDirection = payload?.chiefRayLaunchDirection;
    if (isAngle && (Math.abs(xVal) > 1e-12 || Math.abs(yVal) > 1e-12)
      && (!chiefRayLaunchOrigin || !chiefRayLaunchDirection)) {
      try {
        const { generateRayStartPointsForObject } = await import("../../../optical/ray-renderer.ts");
        const chiefRays = generateRayStartPointsForObject(
          selectedObject,
          opticalSystemRows,
          3,
          null,
          {
            pattern: "annular",
            wavelengthUm,
            aimThroughStop: true,
            useChiefRayAnalysis: true,
            allowStopBasedOriginSolve: true,
            originSolveTraceBackend: "rust",
            strictChiefDirectionSolve: true,
            targetSurfaceIndex: targetSurface,
          },
        ) as any;
        const solvedOrigin = chiefRays?.expectedChiefOrigin ?? chiefRays?.[0]?.startP;
        const solvedDirection = chiefRays?.expectedChiefDir ?? chiefRays?.[0]?.dir;
        if ([solvedOrigin?.x, solvedOrigin?.y, solvedOrigin?.z, solvedDirection?.x, solvedDirection?.y, solvedDirection?.z]
          .every((value) => Number.isFinite(Number(value)))) {
          chiefRayLaunchOrigin = {
            x: Number(solvedOrigin.x),
            y: Number(solvedOrigin.y),
            z: Number(solvedOrigin.z),
          };
          chiefRayLaunchDirection = {
            x: Number(solvedDirection.x),
            y: Number(solvedDirection.y),
            z: Number(solvedDirection.z),
          };
        }
      } catch (_) {}
    }

    const rowsForWasm = enrichRowsWithResolvedRindexForWasm(opticalSystemRows, wavelengthUm);
    const referenceWavelengthMode = String(referenceSphereOptions.referenceSphereWavelengthMode || "primary-wavelength");
    const referenceWavelength = referenceWavelengthMode === "primary-wavelength"
      ? getPrimaryWavelengthFromSourceRows(sourceRows)
      : wavelengthUm;
    const referenceRowsForWasm = referenceWavelengthMode === "primary-wavelength"
      ? enrichRowsWithResolvedRindexForWasm(opticalSystemRows, referenceWavelength)
      : undefined;
    const { preloadRustRayTracingWasm, getRustRayTracingWasmInitError } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
    const rust = await preloadRustRayTracingWasm();
    const runNativeWasm = (rust as any)?.run_native_opd_map_wasm_json;
    if (typeof runNativeWasm !== "function") {
      const initError = String(getRustRayTracingWasmInitError?.() || "").trim();
      throw new Error(
        "runNativeOpdMap(web): Rust-WASM OPD API is unavailable. "
        + `Reason=${initError || "missing export run_native_opd_map_wasm_json"}`,
      );
    }

    const wasmOutRaw = runNativeWasm(JSON.stringify({
      opticalSystemRows: rowsForWasm,
      referenceOpticalSystemRows: referenceRowsForWasm,
      sourceRows,
      objectRows,
      objectIndex,
      surfaceIndex: targetSurface,
      gridSize,
      wavelengthUm,
      opdReferenceWavelengthUm: Number.isFinite(Number(payload?.opdReferenceWavelengthUm))
        ? Number(payload.opdReferenceWavelengthUm)
        : undefined,
      opdWaveNormalization: payload?.opdWaveNormalization,
      pupilRadiusMm: Number.isFinite(Number(payload?.pupilRadiusMm)) && Number(payload.pupilRadiusMm) > 0
        ? Number(payload.pupilRadiusMm)
        : undefined,
      entrancePupilPositionFromFirstSurfaceMm: Number.isFinite(Number(payload?.entrancePupilPositionFromFirstSurfaceMm))
        ? Number(payload.entrancePupilPositionFromFirstSurfaceMm)
        : undefined,
      exitPupilPositionFromLastSurfaceMm: Number.isFinite(Number(payload?.exitPupilPositionFromLastSurfaceMm))
        ? Number(payload.exitPupilPositionFromLastSurfaceMm)
        : undefined,
      pupilGridSampling: (payload as any)?.pupilGridSampling,
      pupilSamplingMode: requestedPupilSamplingMode,
      chiefRayMode: requestedChiefRayMode,
      referenceRayPupilCoordinate: payload?.referenceRayPupilCoordinate,
      chiefRayLaunchOrigin,
      chiefRayLaunchDirection,
      sampleRayLaunchOrigin: payload?.sampleRayLaunchOrigin,
      preserveImageHeightChiefRay: payload?.preserveImageHeightChiefRay === true,
      resolveImageHeightChiefRayInRuntime: payload?.resolveImageHeightChiefRayInRuntime === true,
      aimPupilSamplesToStop: payload?.aimPupilSamplesToStop === true,
      aimPupilSamplesAtReferenceWavelength: (payload as any)?.aimPupilSamplesAtReferenceWavelength === true,
      includeMeridionalTermSamples: (payload as any)?.includeMeridionalTermSamples === true,
      excludeObjectSpaceOpl: (payload as any)?.excludeObjectSpaceOpl === true,
      pupilNormalizationMode,
      exitPupilReferencePointMode: requestedExitPupilReferencePointMode,
      referenceSphereOptions,
      referenceMode,
      referenceSphereGeometry: payload?.referenceSphereGeometry,
      opdDisplayMode,
    }));
    const wasmOut = (typeof wasmOutRaw === "string") ? JSON.parse(wasmOutRaw) : wasmOutRaw;
    const rawOpdGrid = Array.isArray(wasmOut?.rawOpdGrid) ? wasmOut.rawOpdGrid : null;
    const displayOpdGrid = Array.isArray(wasmOut?.displayOpdGrid) ? wasmOut.displayOpdGrid : rawOpdGrid;
    const referenceSphereOpdGrid = Array.isArray(wasmOut?.referenceSphereOpdGrid)
      ? wasmOut.referenceSphereOpdGrid
      : rawOpdGrid;
    if (!rawOpdGrid || !displayOpdGrid) {
      throw new Error(
        "runNativeOpdMap(web): Rust-WASM OPD API returned no OPD grid. "
        + `Message=${String(wasmOut?.message || "unknown")}`,
      );
    }

    return scaleToReferenceWavelength(clampIdealParaxialNativeOpdResponse(opticalSystemRows, {
      backend: String(wasmOut?.backend || "web-rust-wasm-native-api"),
      chiefReferenceMode: String(wasmOut?.chiefReferenceMode || ""),
      chiefRayLaunchOrigin: wasmOut?.chiefRayLaunchOrigin && typeof wasmOut.chiefRayLaunchOrigin === "object"
        ? normalizeNativePoint(wasmOut.chiefRayLaunchOrigin)
        : undefined,
      imageHeightChiefRayApplied: wasmOut?.imageHeightChiefRayApplied === true,
      imageHeightChiefRayPreserved: wasmOut?.imageHeightChiefRayPreserved === true,
      imageHeightChiefRayRuntimeResolved: wasmOut?.imageHeightChiefRayRuntimeResolved === true,
      imageHeightChiefDirection: wasmOut?.imageHeightChiefDirection && typeof wasmOut.imageHeightChiefDirection === "object"
        ? normalizeNativePoint(wasmOut.imageHeightChiefDirection)
        : undefined,
      imageHeightRuntimeSolvedAngle: wasmOut?.imageHeightRuntimeSolvedAngle && typeof wasmOut.imageHeightRuntimeSolvedAngle === "object"
        ? normalizeNativePoint(wasmOut.imageHeightRuntimeSolvedAngle)
        : undefined,
      imageHeightSolverHit: wasmOut?.imageHeightSolverHit && typeof wasmOut.imageHeightSolverHit === "object"
        ? normalizeNativePoint(wasmOut.imageHeightSolverHit)
        : undefined,
      imageHeightSolverSurfaceIndex: Number.isInteger(Number(wasmOut?.imageHeightSolverSurfaceIndex))
        ? Number(wasmOut.imageHeightSolverSurfaceIndex)
        : undefined,
      chiefStopPoint: wasmOut?.chiefStopPoint && typeof wasmOut.chiefStopPoint === "object"
        ? normalizeNativePoint(wasmOut.chiefStopPoint)
        : undefined,
      chiefStopDirection: wasmOut?.chiefStopDirection && typeof wasmOut.chiefStopDirection === "object"
        ? normalizeNativePoint(wasmOut.chiefStopDirection)
        : undefined,
      chiefSurfaceTrace: Array.isArray(wasmOut?.chiefSurfaceTrace)
        ? wasmOut.chiefSurfaceTrace.map((entry: any) => entry?.diagnostic === "firstSurfaceTraceStatusCounts"
          ? {
              diagnostic: entry.diagnostic,
              status3Count: Number(entry.status3Count),
              status4Count: Number(entry.status4Count),
              statusOtherCount: Number(entry.statusOtherCount),
              validCount: Number(entry.validCount),
            }
          : {
              surfaceIndex: Number(entry?.surfaceIndex),
              oplUm: Number.isFinite(Number(entry?.oplUm)) ? Number(entry.oplUm) : undefined,
              globalPoint: normalizeNativePoint(entry?.globalPoint),
              point: normalizeNativePoint(entry?.point),
              direction: normalizeNativePoint(entry?.direction),
            }).filter((entry: any) => entry.diagnostic === "firstSurfaceTraceStatusCounts"
            || (Number.isInteger(entry.surfaceIndex)
              && Number.isFinite(entry.point?.x) && Number.isFinite(entry.point?.y) && Number.isFinite(entry.point?.z)
              && Number.isFinite(entry.direction?.x) && Number.isFinite(entry.direction?.y) && Number.isFinite(entry.direction?.z)))
        : undefined,
      sampleRayLaunchOriginApplied: wasmOut?.sampleRayLaunchOriginApplied === true,
      transmittedPupilCenterUv: Array.isArray(wasmOut?.transmittedPupilCenterUv)
        && Number.isFinite(Number(wasmOut.transmittedPupilCenterUv[0]))
        && Number.isFinite(Number(wasmOut.transmittedPupilCenterUv[1]))
        ? { u: Number(wasmOut.transmittedPupilCenterUv[0]), v: Number(wasmOut.transmittedPupilCenterUv[1]) }
        : undefined,
      targetSurface: Number.isFinite(Number(wasmOut?.targetSurface)) ? Number(wasmOut.targetSurface) : targetSurface,
      stopSurface: Number.isFinite(Number(wasmOut?.stopSurface)) ? Number(wasmOut.stopSurface) : 0,
      requestedObjectIndex: objectIndex,
      usedObjectIndex: Number.isFinite(Number(wasmOut?.usedObjectIndex)) ? Number(wasmOut.usedObjectIndex) : objectIndex,
      usedObjectPosition: String(wasmOut?.usedObjectPosition || (isAngle ? "angle" : "height")),
      usedObjectX: Number.isFinite(Number(wasmOut?.usedObjectX)) ? Number(wasmOut.usedObjectX) : xVal,
      usedObjectY: Number.isFinite(Number(wasmOut?.usedObjectY)) ? Number(wasmOut.usedObjectY) : yVal,
      imageHeightTargetX: Number.isFinite(Number(selectedObject?.__cooptImageHeightTarget?.x))
        ? Number(selectedObject.__cooptImageHeightTarget.x)
        : undefined,
      imageHeightTargetY: Number.isFinite(Number(selectedObject?.__cooptImageHeightTarget?.y))
        ? Number(selectedObject.__cooptImageHeightTarget.y)
        : undefined,
      chiefImageLocalPoint: wasmOut?.chiefImageLocalPoint && typeof wasmOut.chiefImageLocalPoint === "object"
        ? normalizeNativePoint(wasmOut.chiefImageLocalPoint)
        : undefined,
      wavelengthUm,
      referenceSphereWavelengthUsed: Number.isFinite(Number(wasmOut?.referenceSphereWavelengthUsed))
        ? Number(wasmOut.referenceSphereWavelengthUsed)
        : undefined,
      primaryReferenceGeometryApplied: wasmOut?.primaryReferenceGeometryApplied === true,
      currentReferenceSphereRadiusMm: wasmOut?.currentReferenceSphereRadiusMm != null && Number.isFinite(Number(wasmOut.currentReferenceSphereRadiusMm))
        ? Number(wasmOut.currentReferenceSphereRadiusMm)
        : undefined,
      primaryReferenceSphereRadiusMm: wasmOut?.primaryReferenceSphereRadiusMm != null && Number.isFinite(Number(wasmOut.primaryReferenceSphereRadiusMm))
        ? Number(wasmOut.primaryReferenceSphereRadiusMm)
        : undefined,
      opdReferenceWavelengthUm: Number.isFinite(Number(wasmOut?.opdReferenceWavelengthUm))
        ? Number(wasmOut.opdReferenceWavelengthUm)
        : undefined,
      gridSize: Number.isFinite(Number(wasmOut?.gridSize)) ? Number(wasmOut.gridSize) : gridSize,
      effectivePupilRadiusMm: Number.isFinite(Number(wasmOut?.effectivePupilRadiusMm))
        ? Number(wasmOut.effectivePupilRadiusMm)
        : undefined,
      pupilMaskGrid: Array.isArray(wasmOut?.pupilMaskGrid)
        ? wasmOut.pupilMaskGrid
        : undefined,
      entrancePupilCoordinateXGrid: Array.isArray(wasmOut?.entrancePupilCoordinateXGrid)
        ? wasmOut.entrancePupilCoordinateXGrid
        : undefined,
      entrancePupilCoordinateYGrid: Array.isArray(wasmOut?.entrancePupilCoordinateYGrid)
        ? wasmOut.entrancePupilCoordinateYGrid
        : undefined,
      targetHitXGridMm: Array.isArray(wasmOut?.targetHitXGridMm)
        ? wasmOut.targetHitXGridMm
        : undefined,
      targetHitYGridMm: Array.isArray(wasmOut?.targetHitYGridMm)
        ? wasmOut.targetHitYGridMm
        : undefined,
      displayFit: wasmOut?.displayFit && typeof wasmOut.displayFit === "object"
        ? wasmOut.displayFit
        : undefined,
      wavefrontFit: wasmOut?.wavefrontFit && typeof wasmOut.wavefrontFit === "object"
        ? wasmOut.wavefrontFit
        : undefined,
      chiefOplUm: Number.isFinite(Number(wasmOut?.chiefOplUm))
        ? Number(wasmOut.chiefOplUm)
        : undefined,
      chiefReferenceSphereOpdUm: Number.isFinite(Number(wasmOut?.chiefReferenceSphereOpdUm))
        ? Number(wasmOut.chiefReferenceSphereOpdUm)
        : undefined,
      opdTermSamples: Array.isArray(wasmOut?.opdTermSamples)
        ? wasmOut.opdTermSamples
        : undefined,
      referenceSphereCenter: wasmOut?.referenceSphereCenter && typeof wasmOut.referenceSphereCenter === "object"
        ? normalizeNativePoint(wasmOut.referenceSphereCenter)
        : undefined,
      referenceSphereRadiusMm: Number.isFinite(Number(wasmOut?.referenceSphereRadiusMm))
        ? Number(wasmOut.referenceSphereRadiusMm)
        : undefined,
      referenceSphereDirection: wasmOut?.referenceSphereDirection && typeof wasmOut.referenceSphereDirection === "object"
        ? normalizeNativePoint(wasmOut.referenceSphereDirection)
        : undefined,
      chiefImagePoint: wasmOut?.chiefImagePoint && typeof wasmOut.chiefImagePoint === "object"
        ? normalizeNativePoint(wasmOut.chiefImagePoint)
        : undefined,
      paraxialImagePoint: wasmOut?.paraxialImagePoint && typeof wasmOut.paraxialImagePoint === "object"
        ? normalizeNativePoint(wasmOut.paraxialImagePoint)
        : undefined,
      sagittalBestFocusPoint: wasmOut?.sagittalBestFocusPoint && typeof wasmOut.sagittalBestFocusPoint === "object"
        ? normalizeNativePoint(wasmOut.sagittalBestFocusPoint)
        : undefined,
      tangentialBestFocusPoint: wasmOut?.tangentialBestFocusPoint && typeof wasmOut.tangentialBestFocusPoint === "object"
        ? normalizeNativePoint(wasmOut.tangentialBestFocusPoint)
        : undefined,
      rmsBestFocusPoint: wasmOut?.rmsBestFocusPoint && typeof wasmOut.rmsBestFocusPoint === "object"
        ? normalizeNativePoint(wasmOut.rmsBestFocusPoint)
        : undefined,
      rmsBestFocusDiagnostics: wasmOut?.rmsBestFocusDiagnostics && typeof wasmOut.rmsBestFocusDiagnostics === "object"
        ? wasmOut.rmsBestFocusDiagnostics
        : undefined,
      selectedImagePoint: wasmOut?.selectedImagePoint && typeof wasmOut.selectedImagePoint === "object"
        ? normalizeNativePoint(wasmOut.selectedImagePoint)
        : undefined,
      selectedImagePointMode: typeof wasmOut?.selectedImagePointMode === "string"
        ? wasmOut.selectedImagePointMode
        : undefined,
      exitPupilCenter: wasmOut?.exitPupilCenter && typeof wasmOut.exitPupilCenter === "object"
        ? normalizeNativePoint(wasmOut.exitPupilCenter)
        : undefined,
      sampleCount: Number.isFinite(Number(wasmOut?.sampleCount)) ? Number(wasmOut.sampleCount) : 0,
      hitCount: Number.isFinite(Number(wasmOut?.hitCount)) ? Number(wasmOut.hitCount) : 0,
      referenceCorrectedSampleCount: Number.isFinite(Number(wasmOut?.referenceCorrectedSampleCount))
        ? Number(wasmOut.referenceCorrectedSampleCount)
        : undefined,
      referenceOpdRmsUm: Number.isFinite(Number(wasmOut?.referenceOpdRmsUm))
        ? Number(wasmOut.referenceOpdRmsUm)
        : undefined,
      trackedOpdRmsUm: Number.isFinite(Number(wasmOut?.trackedOpdRmsUm))
        ? Number(wasmOut.trackedOpdRmsUm)
        : undefined,
      beforeTargetTrackedOpdRmsUm: Number.isFinite(Number(wasmOut?.beforeTargetTrackedOpdRmsUm))
        ? Number(wasmOut.beforeTargetTrackedOpdRmsUm)
        : undefined,
      targetSegmentOpdRmsUm: Number.isFinite(Number(wasmOut?.targetSegmentOpdRmsUm))
        ? Number(wasmOut.targetSegmentOpdRmsUm)
        : undefined,
      firstSurfaceOpdRmsUm: Number.isFinite(Number(wasmOut?.firstSurfaceOpdRmsUm))
        ? Number(wasmOut.firstSurfaceOpdRmsUm)
        : undefined,
      firstSurfaceExcludedOpdRmsUm: Number.isFinite(Number(wasmOut?.firstSurfaceExcludedOpdRmsUm))
        ? Number(wasmOut.firstSurfaceExcludedOpdRmsUm)
        : undefined,
      spherePathDeltaRmsUm: Number.isFinite(Number(wasmOut?.spherePathDeltaRmsUm))
        ? Number(wasmOut.spherePathDeltaRmsUm)
        : undefined,
      spherePathOptimalScale: Number.isFinite(Number(wasmOut?.spherePathOptimalScale))
        ? Number(wasmOut.spherePathOptimalScale)
        : undefined,
      spherePathOptimalRmsUm: Number.isFinite(Number(wasmOut?.spherePathOptimalRmsUm))
        ? Number(wasmOut.spherePathOptimalRmsUm)
        : undefined,
      currentReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.currentReferenceOpdRmsUm))
        ? Number(wasmOut.currentReferenceOpdRmsUm)
        : undefined,
      alternateSphereIntersection: wasmOut?.alternateSphereIntersection === "opposite-side"
        ? "opposite-side"
        : wasmOut?.alternateSphereIntersection === "exit-pupil-side"
          ? "exit-pupil-side"
          : undefined,
      alternateReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.alternateReferenceOpdRmsUm))
        ? Number(wasmOut.alternateReferenceOpdRmsUm)
        : undefined,
      targetOriginReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.targetOriginReferenceOpdRmsUm))
        ? Number(wasmOut.targetOriginReferenceOpdRmsUm)
        : undefined,
      imageSpaceN: Number.isFinite(Number(wasmOut?.imageSpaceN))
        ? Number(wasmOut.imageSpaceN)
        : undefined,
      airReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.airReferenceOpdRmsUm))
        ? Number(wasmOut.airReferenceOpdRmsUm)
        : undefined,
      imagePlaneReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.imagePlaneReferenceOpdRmsUm))
        ? Number(wasmOut.imagePlaneReferenceOpdRmsUm)
        : undefined,
      stopImageReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.stopImageReferenceOpdRmsUm))
        ? Number(wasmOut.stopImageReferenceOpdRmsUm)
        : undefined,
      stopReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.stopReferenceOpdRmsUm))
        ? Number(wasmOut.stopReferenceOpdRmsUm)
        : undefined,
      alternateOpticalPathSign: wasmOut?.alternateOpticalPathSign === "negative"
        ? "negative"
        : wasmOut?.alternateOpticalPathSign === "positive"
          ? "positive"
          : undefined,
      alternateSignReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.alternateSignReferenceOpdRmsUm))
        ? Number(wasmOut.alternateSignReferenceOpdRmsUm)
        : undefined,
      axisReferenceSphereRmsUm: Number.isFinite(Number(wasmOut?.axisReferenceSphereRmsUm))
        ? Number(wasmOut.axisReferenceSphereRmsUm)
        : undefined,
      sphereRadiusOptimalScale: Number.isFinite(Number(wasmOut?.sphereRadiusOptimalScale))
        ? Number(wasmOut.sphereRadiusOptimalScale)
        : undefined,
      sphereRadiusOptimalRmsUm: Number.isFinite(Number(wasmOut?.sphereRadiusOptimalRmsUm))
        ? Number(wasmOut.sphereRadiusOptimalRmsUm)
        : undefined,
      pupilSamplingMode: String(wasmOut?.pupilSamplingMode || requestedPupilSamplingMode),
      chiefRayMode: sanitizeOpdChiefRayMode(wasmOut?.chiefRayMode || requestedChiefRayMode),
      pupilNormalizationMode: sanitizeOpdPupilNormalizationMode(
        wasmOut?.pupilNormalizationMode || pupilNormalizationMode,
      ),
      exitPupilReferencePointMode: sanitizeOpdExitPupilReferencePointMode(
        wasmOut?.exitPupilReferencePointMode || requestedExitPupilReferencePointMode,
      ),
      referenceMode: sanitizeOpdReferenceMode(wasmOut?.referenceMode || referenceMode),
      rawOpdGrid,
      rawWasmRmsWaves: computeFiniteGridRmsNativeLike(rawOpdGrid),
      rawWasmOpdWaveNormalization: String(payload?.opdWaveNormalization || "primary"),
      unreferencedOpdGrid: Array.isArray(wasmOut?.unreferencedOpdGrid)
        ? wasmOut.unreferencedOpdGrid
        : undefined,
      displayOpdGrid,
      referenceSphereOpdGrid,
      message: String(wasmOut?.message || "Computed via Rust-WASM native OPD API"),
    } as NativeOpdMapResponse));
  }
  const nativeResponse = await invokeCommand<NativeOpdMapRequest, NativeOpdMapResponse>("run_native_opd_map", normalizedPayload);
  return scaleToReferenceWavelength(clampIdealParaxialNativeOpdResponse(
    Array.isArray(normalizedPayload?.opticalSystemRows) ? normalizedPayload.opticalSystemRows : [],
    nativeResponse,
  ));
}

export async function runNativeOpdRmsWaves(
  payload: NativeOpdRmsWavesRequest,
): Promise<NativeOpdRmsWavesResponse> {
  const normalizedPayload: NativeOpdRmsWavesRequest = {
    ...(payload || {} as any),
    referenceMode: sanitizeOpdReferenceMode((payload as any)?.referenceMode || readConfiguredOpdReferenceMode()),
    surfaceIndex: Number.isInteger((payload as any)?.surfaceIndex)
      ? Math.max(0, Number((payload as any).surfaceIndex))
      : pickImageSurfaceIndexNativeLike(Array.isArray((payload as any)?.opticalSystemRows) ? (payload as any).opticalSystemRows : []),
  } as NativeOpdRmsWavesRequest;
  payload = normalizedPayload;
  if (normalizedPayload.referenceMode === "exit-pupil") {
    const mapResponse = await runNativeOpdMap(normalizedPayload as NativeOpdMapRequest);
    const displayGrid = Array.isArray(mapResponse.displayOpdGrid)
      ? mapResponse.displayOpdGrid
      : mapResponse.rawOpdGrid;
    const rmsGrid = String(normalizedPayload.opdDisplayMode || "raw").trim().toLowerCase() === "raw"
      ? mapResponse.rawOpdGrid
      : displayGrid;
    const rmsWaves = computeFiniteGridRmsNativeLike(rmsGrid);
    let sampleCount = 0;
    for (const row of rmsGrid || []) {
      if (!Array.isArray(row)) continue;
      for (const value of row) {
        if (value === null || value === undefined) continue;
        if (Number.isFinite(Number(value))) sampleCount += 1;
      }
    }
    return {
      backend: `${mapResponse.backend}:rms`,
      chiefReferenceMode: mapResponse.chiefReferenceMode,
      chiefRayLaunchOrigin: mapResponse.chiefRayLaunchOrigin,
      chiefSurfaceTrace: mapResponse.chiefSurfaceTrace,
      imageHeightChiefRayApplied: mapResponse.imageHeightChiefRayApplied,
      imageHeightChiefRayPreserved: mapResponse.imageHeightChiefRayPreserved,
      imageHeightChiefRayRuntimeResolved: mapResponse.imageHeightChiefRayRuntimeResolved,
      imageHeightChiefDirection: mapResponse.imageHeightChiefDirection,
      imageHeightRuntimeSolvedAngle: mapResponse.imageHeightRuntimeSolvedAngle,
      imageHeightSolverHit: mapResponse.imageHeightSolverHit,
      imageHeightSolverSurfaceIndex: mapResponse.imageHeightSolverSurfaceIndex,
      sampleRayLaunchOriginApplied: mapResponse.sampleRayLaunchOriginApplied,
      transmittedPupilCenterUv: mapResponse.transmittedPupilCenterUv,
      targetSurface: mapResponse.targetSurface,
      stopSurface: mapResponse.stopSurface,
      requestedObjectIndex: mapResponse.requestedObjectIndex,
      usedObjectIndex: mapResponse.usedObjectIndex,
      usedObjectPosition: mapResponse.usedObjectPosition,
      usedObjectX: mapResponse.usedObjectX,
      usedObjectY: mapResponse.usedObjectY,
      wavelengthUm: mapResponse.wavelengthUm,
      chiefOplUm: mapResponse.chiefOplUm,
      chiefReferenceSphereOpdUm: mapResponse.chiefReferenceSphereOpdUm,
      referenceSphereWavelengthUsed: mapResponse.referenceSphereWavelengthUsed,
      primaryReferenceGeometryApplied: mapResponse.primaryReferenceGeometryApplied,
      currentReferenceSphereRadiusMm: mapResponse.currentReferenceSphereRadiusMm,
      primaryReferenceSphereRadiusMm: mapResponse.primaryReferenceSphereRadiusMm,
      gridSize: mapResponse.gridSize,
      effectivePupilRadiusMm: mapResponse.effectivePupilRadiusMm,
      pupilMaskGrid: mapResponse.pupilMaskGrid,
      entrancePupilCoordinateXGrid: (mapResponse as any).entrancePupilCoordinateXGrid,
      entrancePupilCoordinateYGrid: (mapResponse as any).entrancePupilCoordinateYGrid,
      displayOpdGrid: mapResponse.displayOpdGrid,
      unreferencedOpdGrid: mapResponse.unreferencedOpdGrid,
      opdTermSamples: mapResponse.opdTermSamples,
      sampleCount,
      hitCount: mapResponse.hitCount,
      referenceCorrectedSampleCount: mapResponse.referenceCorrectedSampleCount,
      referenceOpdRmsUm: mapResponse.referenceOpdRmsUm,
      trackedOpdRmsUm: mapResponse.trackedOpdRmsUm,
      beforeTargetTrackedOpdRmsUm: mapResponse.beforeTargetTrackedOpdRmsUm,
      targetSegmentOpdRmsUm: mapResponse.targetSegmentOpdRmsUm,
      spherePathDeltaRmsUm: mapResponse.spherePathDeltaRmsUm,
      spherePathOptimalScale: mapResponse.spherePathOptimalScale,
      spherePathOptimalRmsUm: mapResponse.spherePathOptimalRmsUm,
      currentReferenceOpdRmsUm: mapResponse.currentReferenceOpdRmsUm,
      alternateSphereIntersection: mapResponse.alternateSphereIntersection,
      alternateReferenceOpdRmsUm: mapResponse.alternateReferenceOpdRmsUm,
      targetOriginReferenceOpdRmsUm: mapResponse.targetOriginReferenceOpdRmsUm,
      imageSpaceN: mapResponse.imageSpaceN,
      airReferenceOpdRmsUm: mapResponse.airReferenceOpdRmsUm,
      alternateOpticalPathSign: mapResponse.alternateOpticalPathSign,
      alternateSignReferenceOpdRmsUm: mapResponse.alternateSignReferenceOpdRmsUm,
      axisReferenceSphereRmsUm: mapResponse.axisReferenceSphereRmsUm,
      sphereRadiusOptimalScale: mapResponse.sphereRadiusOptimalScale,
      sphereRadiusOptimalRmsUm: mapResponse.sphereRadiusOptimalRmsUm,
      referenceSphereCenter: mapResponse.referenceSphereCenter,
      referenceSphereRadiusMm: mapResponse.referenceSphereRadiusMm,
      referenceSphereDirection: mapResponse.referenceSphereDirection,
      chiefImagePoint: mapResponse.chiefImagePoint,
      paraxialImagePoint: mapResponse.paraxialImagePoint,
      sagittalBestFocusPoint: mapResponse.sagittalBestFocusPoint,
      tangentialBestFocusPoint: mapResponse.tangentialBestFocusPoint,
      rmsBestFocusPoint: mapResponse.rmsBestFocusPoint,
      rmsBestFocusDiagnostics: mapResponse.rmsBestFocusDiagnostics,
      selectedImagePoint: mapResponse.selectedImagePoint,
      selectedImagePointMode: mapResponse.selectedImagePointMode,
      exitPupilCenter: mapResponse.exitPupilCenter,
      displayFit: mapResponse.displayFit,
      wavefrontFit: mapResponse.wavefrontFit,
      referenceSphereOpdGrid: mapResponse.referenceSphereOpdGrid,
      pupilSamplingMode: mapResponse.pupilSamplingMode,
      referenceMode: mapResponse.referenceMode,
      rmsWaves,
      message: `${mapResponse.message} (RMS)`,
    } as NativeOpdRmsWavesResponse;
  }
  if (!isTauriRuntime()) {
    const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
    const inputObjectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
    const objectRows = await normalizeTransverseObjectRowsForImageHeight(
      opticalSystemRows,
      sourceRows,
      inputObjectRows,
      Number(payload?.wavelengthUm),
    );
    const objectIndex = Number.isInteger(payload?.objectIndex) ? Math.max(0, Number(payload.objectIndex)) : 0;
    const requestedObject = objectRows[objectIndex] || objectRows[0] || {};
    const wavelengthUm = (() => {
      const explicit = Number(payload?.wavelengthUm);
      if (Number.isFinite(explicit) && explicit > 0) return explicit;
      for (const row of sourceRows) {
        const primaryRaw = String((row as any)?.primary ?? '').trim().toLowerCase();
        const primaryBool = Boolean((row as any)?.primary === true || (row as any)?.isPrimary === true);
        const wl = Number((row as any)?.wavelength);
        if ((primaryBool || primaryRaw.includes('primary')) && Number.isFinite(wl) && wl > 0) {
          return wl;
        }
      }
      for (const row of sourceRows) {
        const wl = Number((row as any)?.wavelength);
        if (Number.isFinite(wl) && wl > 0) return wl;
      }
      return 0.5876;
    })();
    const objectType = String((requestedObject as any)?.position ?? (requestedObject as any)?.object ?? '').toLowerCase();
    const isAngle = isAngleObjectPositionTagNativeLike(objectType);
    const xVal = Number((requestedObject as any)?.xHeightAngle ?? (requestedObject as any)?.xFieldAngle ?? (requestedObject as any)?.xHeight ?? (requestedObject as any)?.x ?? 0) || 0;
    const yVal = Number((requestedObject as any)?.yHeightAngle ?? (requestedObject as any)?.yFieldAngle ?? (requestedObject as any)?.fieldAngle ?? (requestedObject as any)?.yHeight ?? (requestedObject as any)?.y ?? 0) || 0;
    const gridSize = Number.isFinite(Number(payload?.gridSize)) ? Math.max(17, Math.floor(Number(payload.gridSize))) : 129;
    const requestedPupilSamplingMode = (payload?.pupilSamplingMode === "stop" || payload?.pupilSamplingMode === "entrance")
      ? payload.pupilSamplingMode
      : "stop";
    const referenceMode = sanitizeOpdReferenceMode(payload?.referenceMode);
    const opdDisplayMode = String(payload?.opdDisplayMode || "pistonTiltRemoved");
    const targetSurface = Number.isInteger(payload?.surfaceIndex) && Number(payload.surfaceIndex) >= 0
      ? Number(payload.surfaceIndex)
      : pickImageSurfaceIndexNativeLike(opticalSystemRows);

    const rowsForWasm = enrichRowsWithResolvedRindexForWasm(opticalSystemRows, wavelengthUm);
    const referenceWavelengthMode = String(payload?.referenceSphereOptions?.referenceSphereWavelengthMode || "primary-wavelength");
    const referenceWavelength = referenceWavelengthMode === "primary-wavelength"
      ? getPrimaryWavelengthFromSourceRows(sourceRows)
      : wavelengthUm;
    const referenceRowsForWasm = referenceWavelengthMode === "primary-wavelength"
      ? enrichRowsWithResolvedRindexForWasm(opticalSystemRows, referenceWavelength)
      : undefined;
    const { preloadRustRayTracingWasm, getRustRayTracingWasmInitError } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
    const rust = await preloadRustRayTracingWasm();
    const runNativeWasm = (rust as any)?.run_native_opd_rms_waves_wasm_json;
    if (typeof runNativeWasm !== "function") {
      const initError = String(getRustRayTracingWasmInitError?.() || "").trim();
      throw new Error(
        "runNativeOpdRmsWaves(web): Rust-WASM OPD RMS API is unavailable. "
        + `Reason=${initError || "missing export run_native_opd_rms_waves_wasm_json"}`,
      );
    }

    const wasmOutRaw = runNativeWasm(JSON.stringify({
      opticalSystemRows: rowsForWasm,
      referenceOpticalSystemRows: referenceRowsForWasm,
      sourceRows,
      objectRows,
      objectIndex,
      surfaceIndex: targetSurface,
      gridSize,
      wavelengthUm,
      opdReferenceWavelengthUm: Number.isFinite(Number(payload?.opdReferenceWavelengthUm))
        ? Number(payload.opdReferenceWavelengthUm)
        : undefined,
      opdWaveNormalization: payload?.opdWaveNormalization,
      pupilRadiusMm: Number.isFinite(Number(payload?.pupilRadiusMm)) && Number(payload.pupilRadiusMm) > 0
        ? Number(payload.pupilRadiusMm)
        : undefined,
      entrancePupilPositionFromFirstSurfaceMm: Number.isFinite(Number(payload?.entrancePupilPositionFromFirstSurfaceMm))
        ? Number(payload.entrancePupilPositionFromFirstSurfaceMm)
        : undefined,
      exitPupilPositionFromLastSurfaceMm: Number.isFinite(Number(payload?.exitPupilPositionFromLastSurfaceMm))
        ? Number(payload.exitPupilPositionFromLastSurfaceMm)
        : undefined,
      pupilGridSampling: payload?.pupilGridSampling,
      pupilSamplingMode: requestedPupilSamplingMode,
      chiefRayMode: payload?.chiefRayMode,
      referenceRayPupilCoordinate: payload?.referenceRayPupilCoordinate,
      sampleRayLaunchOrigin: payload?.sampleRayLaunchOrigin,
      preserveImageHeightChiefRay: payload?.preserveImageHeightChiefRay === true,
      resolveImageHeightChiefRayInRuntime: payload?.resolveImageHeightChiefRayInRuntime === true,
      aimPupilSamplesToStop: payload?.aimPupilSamplesToStop === true,
      aimPupilSamplesAtReferenceWavelength: payload?.aimPupilSamplesAtReferenceWavelength === true,
      includeMeridionalTermSamples: payload?.includeMeridionalTermSamples === true,
      excludeObjectSpaceOpl: (payload as any)?.excludeObjectSpaceOpl === true,
      pupilNormalizationMode: payload?.pupilNormalizationMode,
      exitPupilReferencePointMode: payload?.exitPupilReferencePointMode,
      referenceSphereOptions: payload?.referenceSphereOptions,
      referenceMode,
      referenceSphereGeometry: payload?.referenceSphereGeometry,
      opdDisplayMode,
    }));
    const wasmOut = (typeof wasmOutRaw === "string") ? JSON.parse(wasmOutRaw) : wasmOutRaw;
    return clampIdealParaxialNativeOpdRmsResponse(opticalSystemRows, {
      backend: String(wasmOut?.backend || "web-rust-wasm-native-api"),
      chiefReferenceMode: String(wasmOut?.chiefReferenceMode || ""),
      chiefRayLaunchOrigin: wasmOut?.chiefRayLaunchOrigin && typeof wasmOut.chiefRayLaunchOrigin === "object"
        ? normalizeNativePoint(wasmOut.chiefRayLaunchOrigin)
        : undefined,
      sampleRayLaunchOriginApplied: wasmOut?.sampleRayLaunchOriginApplied === true,
      transmittedPupilCenterUv: Array.isArray(wasmOut?.transmittedPupilCenterUv)
        && Number.isFinite(Number(wasmOut.transmittedPupilCenterUv[0]))
        && Number.isFinite(Number(wasmOut.transmittedPupilCenterUv[1]))
        ? { u: Number(wasmOut.transmittedPupilCenterUv[0]), v: Number(wasmOut.transmittedPupilCenterUv[1]) }
        : undefined,
      targetSurface: Number.isFinite(Number(wasmOut?.targetSurface)) ? Number(wasmOut.targetSurface) : targetSurface,
      stopSurface: Number.isFinite(Number(wasmOut?.stopSurface)) ? Number(wasmOut.stopSurface) : 0,
      requestedObjectIndex: objectIndex,
      usedObjectIndex: Number.isFinite(Number(wasmOut?.usedObjectIndex)) ? Number(wasmOut.usedObjectIndex) : objectIndex,
      usedObjectPosition: String(wasmOut?.usedObjectPosition || (isAngle ? "angle" : "height")),
      usedObjectX: Number.isFinite(Number(wasmOut?.usedObjectX)) ? Number(wasmOut.usedObjectX) : xVal,
      usedObjectY: Number.isFinite(Number(wasmOut?.usedObjectY)) ? Number(wasmOut.usedObjectY) : yVal,
      imageHeightTargetX: Number.isFinite(Number(requestedObject?.__cooptImageHeightTarget?.x))
        ? Number(requestedObject.__cooptImageHeightTarget.x)
        : undefined,
      imageHeightTargetY: Number.isFinite(Number(requestedObject?.__cooptImageHeightTarget?.y))
        ? Number(requestedObject.__cooptImageHeightTarget.y)
        : undefined,
      wavelengthUm,
      chiefOplUm: Number.isFinite(Number(wasmOut?.chiefOplUm))
        ? Number(wasmOut.chiefOplUm)
        : undefined,
      chiefReferenceSphereOpdUm: Number.isFinite(Number(wasmOut?.chiefReferenceSphereOpdUm))
        ? Number(wasmOut.chiefReferenceSphereOpdUm)
        : undefined,
      referenceSphereWavelengthUsed: Number.isFinite(Number(wasmOut?.referenceSphereWavelengthUsed))
        ? Number(wasmOut.referenceSphereWavelengthUsed)
        : undefined,
      primaryReferenceGeometryApplied: wasmOut?.primaryReferenceGeometryApplied === true,
      currentReferenceSphereRadiusMm: wasmOut?.currentReferenceSphereRadiusMm != null && Number.isFinite(Number(wasmOut.currentReferenceSphereRadiusMm))
        ? Number(wasmOut.currentReferenceSphereRadiusMm)
        : undefined,
      primaryReferenceSphereRadiusMm: wasmOut?.primaryReferenceSphereRadiusMm != null && Number.isFinite(Number(wasmOut.primaryReferenceSphereRadiusMm))
        ? Number(wasmOut.primaryReferenceSphereRadiusMm)
        : undefined,
      gridSize: Number.isFinite(Number(wasmOut?.gridSize)) ? Number(wasmOut.gridSize) : gridSize,
      effectivePupilRadiusMm: Number.isFinite(Number(wasmOut?.effectivePupilRadiusMm))
        ? Number(wasmOut.effectivePupilRadiusMm)
        : undefined,
      pupilMaskGrid: Array.isArray(wasmOut?.pupilMaskGrid)
        ? wasmOut.pupilMaskGrid
        : undefined,
      unreferencedOpdGrid: Array.isArray(wasmOut?.unreferencedOpdGrid)
        ? wasmOut.unreferencedOpdGrid
        : undefined,
      sampleCount: Number.isFinite(Number(wasmOut?.sampleCount)) ? Number(wasmOut.sampleCount) : 0,
      hitCount: Number.isFinite(Number(wasmOut?.hitCount)) ? Number(wasmOut.hitCount) : 0,
      referenceCorrectedSampleCount: Number.isFinite(Number(wasmOut?.referenceCorrectedSampleCount))
        ? Number(wasmOut.referenceCorrectedSampleCount)
        : undefined,
      referenceOpdRmsUm: Number.isFinite(Number(wasmOut?.referenceOpdRmsUm))
        ? Number(wasmOut.referenceOpdRmsUm)
        : undefined,
      trackedOpdRmsUm: Number.isFinite(Number(wasmOut?.trackedOpdRmsUm))
        ? Number(wasmOut.trackedOpdRmsUm)
        : undefined,
      beforeTargetTrackedOpdRmsUm: Number.isFinite(Number(wasmOut?.beforeTargetTrackedOpdRmsUm))
        ? Number(wasmOut.beforeTargetTrackedOpdRmsUm)
        : undefined,
      targetSegmentOpdRmsUm: Number.isFinite(Number(wasmOut?.targetSegmentOpdRmsUm))
        ? Number(wasmOut.targetSegmentOpdRmsUm)
        : undefined,
      spherePathDeltaRmsUm: Number.isFinite(Number(wasmOut?.spherePathDeltaRmsUm))
        ? Number(wasmOut.spherePathDeltaRmsUm)
        : undefined,
      spherePathOptimalScale: Number.isFinite(Number(wasmOut?.spherePathOptimalScale))
        ? Number(wasmOut.spherePathOptimalScale)
        : undefined,
      spherePathOptimalRmsUm: Number.isFinite(Number(wasmOut?.spherePathOptimalRmsUm))
        ? Number(wasmOut.spherePathOptimalRmsUm)
        : undefined,
      currentReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.currentReferenceOpdRmsUm))
        ? Number(wasmOut.currentReferenceOpdRmsUm)
        : undefined,
      alternateSphereIntersection: wasmOut?.alternateSphereIntersection === "opposite-side"
        ? "opposite-side"
        : wasmOut?.alternateSphereIntersection === "exit-pupil-side"
          ? "exit-pupil-side"
          : undefined,
      alternateReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.alternateReferenceOpdRmsUm))
        ? Number(wasmOut.alternateReferenceOpdRmsUm)
        : undefined,
      targetOriginReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.targetOriginReferenceOpdRmsUm))
        ? Number(wasmOut.targetOriginReferenceOpdRmsUm)
        : undefined,
      imageSpaceN: Number.isFinite(Number(wasmOut?.imageSpaceN))
        ? Number(wasmOut.imageSpaceN)
        : undefined,
      airReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.airReferenceOpdRmsUm))
        ? Number(wasmOut.airReferenceOpdRmsUm)
        : undefined,
      alternateOpticalPathSign: wasmOut?.alternateOpticalPathSign === "negative"
        ? "negative"
        : wasmOut?.alternateOpticalPathSign === "positive"
          ? "positive"
          : undefined,
      alternateSignReferenceOpdRmsUm: Number.isFinite(Number(wasmOut?.alternateSignReferenceOpdRmsUm))
        ? Number(wasmOut.alternateSignReferenceOpdRmsUm)
        : undefined,
      axisReferenceSphereRmsUm: Number.isFinite(Number(wasmOut?.axisReferenceSphereRmsUm))
        ? Number(wasmOut.axisReferenceSphereRmsUm)
        : undefined,
      sphereRadiusOptimalScale: Number.isFinite(Number(wasmOut?.sphereRadiusOptimalScale))
        ? Number(wasmOut.sphereRadiusOptimalScale)
        : undefined,
      sphereRadiusOptimalRmsUm: Number.isFinite(Number(wasmOut?.sphereRadiusOptimalRmsUm))
        ? Number(wasmOut.sphereRadiusOptimalRmsUm)
        : undefined,
      pupilSamplingMode: wasmOut?.pupilSamplingMode === "entrance" ? "entrance" : "stop",
      referenceMode: sanitizeOpdReferenceMode(wasmOut?.referenceMode || referenceMode),
      referenceSphereCenter: wasmOut?.referenceSphereCenter && typeof wasmOut.referenceSphereCenter === "object"
        ? normalizeNativePoint(wasmOut.referenceSphereCenter)
        : undefined,
      referenceSphereRadiusMm: Number.isFinite(Number(wasmOut?.referenceSphereRadiusMm))
        ? Number(wasmOut.referenceSphereRadiusMm)
        : undefined,
      chiefImagePoint: wasmOut?.chiefImagePoint && typeof wasmOut.chiefImagePoint === "object"
        ? normalizeNativePoint(wasmOut.chiefImagePoint)
        : undefined,
      paraxialImagePoint: wasmOut?.paraxialImagePoint && typeof wasmOut.paraxialImagePoint === "object"
        ? normalizeNativePoint(wasmOut.paraxialImagePoint)
        : undefined,
      sagittalBestFocusPoint: wasmOut?.sagittalBestFocusPoint && typeof wasmOut.sagittalBestFocusPoint === "object"
        ? normalizeNativePoint(wasmOut.sagittalBestFocusPoint)
        : undefined,
      tangentialBestFocusPoint: wasmOut?.tangentialBestFocusPoint && typeof wasmOut.tangentialBestFocusPoint === "object"
        ? normalizeNativePoint(wasmOut.tangentialBestFocusPoint)
        : undefined,
      rmsBestFocusPoint: wasmOut?.rmsBestFocusPoint && typeof wasmOut.rmsBestFocusPoint === "object"
        ? normalizeNativePoint(wasmOut.rmsBestFocusPoint)
        : undefined,
      rmsBestFocusDiagnostics: wasmOut?.rmsBestFocusDiagnostics && typeof wasmOut.rmsBestFocusDiagnostics === "object"
        ? wasmOut.rmsBestFocusDiagnostics
        : undefined,
      selectedImagePoint: wasmOut?.selectedImagePoint && typeof wasmOut.selectedImagePoint === "object"
        ? normalizeNativePoint(wasmOut.selectedImagePoint)
        : undefined,
      selectedImagePointMode: typeof wasmOut?.selectedImagePointMode === "string"
        ? wasmOut.selectedImagePointMode
        : undefined,
      rmsWaves: Number(wasmOut?.rmsWaves),
      message: String(wasmOut?.message || "Computed via Rust-WASM native OPD RMS API"),
    } as NativeOpdRmsWavesResponse);
  }

  const nativeResponse = await invokeCommand<NativeOpdRmsWavesRequest, NativeOpdRmsWavesResponse>("run_native_opd_rms_waves", normalizedPayload);
  return clampIdealParaxialNativeOpdRmsResponse(
    Array.isArray(normalizedPayload?.opticalSystemRows) ? normalizedPayload.opticalSystemRows : [],
    nativeResponse,
  );
}

export async function runNativePsfMap(
  payload: NativePsfMapRequest,
): Promise<NativePsfMapResponse> {
  if (!isTauriRuntime()) {
    const size = Array.isArray(payload?.gridOpd) ? payload.gridOpd.length : 0;
    if (size <= 0) throw new Error("runNativePsfMap(web): gridOpd is empty");
    const wavelengthUm = Number(payload?.wavelengthUm) || 0.5876;
    const { preloadRustRayTracingWasm, getRustRayTracingWasmInitError } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
    const rust = await preloadRustRayTracingWasm();
    const runNativePsfWasm = (rust as any)?.run_native_psf_from_opd_wasm_json;
    if (typeof runNativePsfWasm !== "function") {
      const initError = String(getRustRayTracingWasmInitError?.() || "").trim();
      throw new Error(
        "runNativePsfMap(web): Rust-WASM PSF API is unavailable. "
        + `Reason=${initError || "missing export run_native_psf_from_opd_wasm_json"}`,
      );
    }

    const rawOpdGrid = Array.from({ length: size }, (_, y) =>
      Array.from({ length: size }, (_, x) => {
        if (!payload?.pupilMask?.[y]?.[x]) return null;
        const opdUm = Number(payload?.gridOpd?.[y]?.[x]);
        if (!Number.isFinite(opdUm)) return null;
        return opdUm / Math.max(1e-12, wavelengthUm);
      }),
    );
    const displayOpdGrid = rawOpdGrid;
    const psfRaw = runNativePsfWasm(JSON.stringify({
      rawOpdGrid,
      displayOpdGrid,
      wavelengthUm,
      pixelSizeUm: Number.isFinite(Number(payload?.pixelSizeUm)) ? Number(payload?.pixelSizeUm) : 1,
      removeTilt: payload?.removeTilt === true,
      zeroPadTo: Number.isFinite(Number(payload?.zeroPadTo)) ? Number(payload.zeroPadTo) : 0,
      propagationMode: payload?.propagationMode,
      targetHitXGridMm: payload?.targetHitXGridMm,
      targetHitYGridMm: payload?.targetHitYGridMm,
      rayHitsUm: payload?.rayHitsUm,
      hybridOutputSize: payload?.hybridOutputSize,
      diffractionFwhmXUm: payload?.diffractionFwhmXUm,
      diffractionFwhmYUm: payload?.diffractionFwhmYUm,
      gridAmplitude: payload?.gridAmplitude,
    }));
    const res: any = (typeof psfRaw === "string") ? JSON.parse(psfRaw) : psfRaw;

    return {
      backend: String((res as any)?.backend || "web-rust-wasm-psf"),
      gridSize: size,
      fftSize: Array.isArray((res as any)?.psfData) ? (res as any).psfData.length : size,
      psfData: Array.isArray((res as any)?.psfData) ? (res as any).psfData : [],
      metrics: ((res as any)?.metrics || {}) as any,
      pixelSizeUm: Number.isFinite(Number((res as any)?.pixelSizeUm))
        ? Number((res as any).pixelSizeUm)
        : (Number.isFinite(Number(payload?.pixelSizeUm)) ? Number(payload?.pixelSizeUm) : undefined),
      method: (res as any)?.method === "hybrid-geometric" ? "hybrid-geometric" : "coherent-fft",
      fieldOfViewUm: Number.isFinite(Number((res as any)?.fieldOfViewUm))
        ? Number((res as any).fieldOfViewUm)
        : undefined,
      geometricSpanUm: (res as any)?.geometricSpanUm,
      geometricSampling: (res as any)?.geometricSampling,
      phaseSampling: (res as any)?.phaseSampling,
      diagnostic: typeof (res as any)?.diagnostic === "string" ? (res as any).diagnostic : undefined,
      message: String((res as any)?.message || "Computed via Web Rust/WASM PSF API"),
    };
  }
  return invokeCommand<NativePsfMapRequest, NativePsfMapResponse>("run_native_psf_map", payload);
}

export async function runMtfBatchViaWasm(
  request: any,
): Promise<any> {
  {
    const {
      preloadRustRayTracingWasm,
      ensureRustRayTracingWasmThreadPool,
      getRustRayTracingWasmInitError,
    } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
    const rust = await preloadRustRayTracingWasm();
    const batchFn = (rust as any)?.run_native_opd_psf_mtf_batch_wasm_json;
    if (typeof batchFn !== "function") {
      const initError = String(getRustRayTracingWasmInitError?.() || "").trim();
      throw new Error(
        "runMtfBatchViaWasm(web): Rust-WASM batch MTF API is unavailable. "
        + `Reason=${initError || "missing export run_native_opd_psf_mtf_batch_wasm_json"}`,
      );
    }

    const enableWasmThreads = typeof globalThis !== "undefined"
      && (globalThis as any).__COOPT_MTF_ENABLE_RAYON !== false
      && (globalThis as any).crossOriginIsolated === true
      && typeof (globalThis as any).SharedArrayBuffer === "function";
    const wasmThreadsActive = enableWasmThreads
      ? await ensureRustRayTracingWasmThreadPool(rust)
      : false;

    const preparedRequest = request && typeof request === "object"
      ? {
        ...request,
        parallel: enableWasmThreads && request.parallel !== false,
        shared: request.shared && typeof request.shared === "object"
          ? {
            ...request.shared,
            opdRequest: request.shared.opdRequest && typeof request.shared.opdRequest === "object"
              ? { ...request.shared.opdRequest }
              : request.shared.opdRequest,
          }
          : request.shared,
        jobs: Array.isArray(request.jobs)
          ? request.jobs.map((job: any) => ({
            ...job,
            opdRequest: job?.opdRequest && typeof job.opdRequest === "object"
              ? { ...job.opdRequest }
              : job?.opdRequest,
          }))
          : request.jobs,
      }
      : request;
    // A batch can contain finite-difference candidates with different optical
    // rows at the same wavelength.  Caching by wavelength alone aliases those
    // candidates to whichever system happened to be prepared first, which
    // makes their MTF residuals identical and corrupts the Jacobian.  Preserve
    // the inexpensive identity cache, but scope it to the actual row array as
    // well as its wavelength.
    const enrichedRowsCache = new WeakMap<object, Map<string, any[]>>();
    let enrichedRowsCacheHits = 0;
    const getCachedEnrichedRows = (rows: any[], wavelengthUm: number): any[] => {
      const numericWavelength = Number.isFinite(wavelengthUm) && wavelengthUm > 0 ? wavelengthUm : 0.5876;
      const cacheKey = numericWavelength.toFixed(9);
      const cacheOwner = (rows && typeof rows === "object") ? rows as unknown as object : null;
      const cacheByWavelength = cacheOwner
        ? (enrichedRowsCache.get(cacheOwner) || new Map<string, any[]>())
        : null;
      if (cacheOwner && cacheByWavelength && !enrichedRowsCache.has(cacheOwner)) {
        enrichedRowsCache.set(cacheOwner, cacheByWavelength);
      }
      const cached = cacheByWavelength?.get(cacheKey);
      if (cached) {
        enrichedRowsCacheHits += 1;
        return cached;
      }
      const enriched = enrichRowsWithResolvedRindexForWasm(rows, numericWavelength);
      cacheByWavelength?.set(cacheKey, enriched);
      return enriched;
    };
    const sharedOpdRequest = preparedRequest?.shared?.opdRequest;
    if (sharedOpdRequest && typeof sharedOpdRequest === "object") {
      const wavelengthUm = Number(sharedOpdRequest.wavelengthUm);
      const opticalRows = Array.isArray(sharedOpdRequest.opticalSystemRows)
        ? sharedOpdRequest.opticalSystemRows
        : [];
      if (opticalRows.length > 0) {
        const enrichedRows = getCachedEnrichedRows(opticalRows, wavelengthUm);
        sharedOpdRequest.opticalSystemRows = enrichedRows;
        const objectRows = Array.isArray(sharedOpdRequest.objectRows) ? sharedOpdRequest.objectRows : [];
        if (objectRows.length > 0) {
          sharedOpdRequest.objectRows = await normalizeTransverseObjectRowsForImageHeight(
            enrichedRows,
            Array.isArray(sharedOpdRequest.sourceRows) ? sharedOpdRequest.sourceRows : [],
            objectRows,
            wavelengthUm,
          );
        }
      }
    }
    for (const job of Array.isArray(preparedRequest?.jobs) ? preparedRequest.jobs : []) {
      const jobOpdRequest = job?.opdRequest;
      if (!jobOpdRequest || typeof jobOpdRequest !== "object") continue;
      const wavelengthUm = Number(jobOpdRequest.wavelengthUm ?? sharedOpdRequest?.wavelengthUm);
      if (Array.isArray(jobOpdRequest.opticalSystemRows) && jobOpdRequest.opticalSystemRows.length > 0) {
        const enrichedRows = getCachedEnrichedRows(jobOpdRequest.opticalSystemRows, wavelengthUm);
        jobOpdRequest.opticalSystemRows = enrichedRows;
        if (Array.isArray(jobOpdRequest.objectRows) && jobOpdRequest.objectRows.length > 0) {
          jobOpdRequest.objectRows = await normalizeTransverseObjectRowsForImageHeight(
            enrichedRows,
            Array.isArray(jobOpdRequest.sourceRows) ? jobOpdRequest.sourceRows : [],
            jobOpdRequest.objectRows,
            wavelengthUm,
          );
        }
      }
    }

    let sharedSourceRowsRemoved = 0;
    const sharedSourceRows = sharedOpdRequest && typeof sharedOpdRequest === "object"
      && Array.isArray(sharedOpdRequest.sourceRows)
      ? sharedOpdRequest.sourceRows
      : null;
    if (sharedSourceRows) {
      for (const job of Array.isArray(preparedRequest?.jobs) ? preparedRequest.jobs : []) {
        const jobOpdRequest = job?.opdRequest;
        if (!jobOpdRequest || typeof jobOpdRequest !== "object") continue;
        if (Array.isArray(jobOpdRequest.sourceRows)) {
          delete jobOpdRequest.sourceRows;
          sharedSourceRowsRemoved += 1;
        }
      }
    }

    const requestJson = JSON.stringify(preparedRequest);
    console.info(`[TFMTF BatchPrep] jobs=${Array.isArray(preparedRequest?.jobs) ? preparedRequest.jobs.length : 0}, wavelengthRowCacheHits=${enrichedRowsCacheHits}, cacheKey=rowIdentity+wavelength, sharedSourceRowsRemoved=${sharedSourceRowsRemoved}, requestChars=${requestJson.length}`);

    const wasmOutRaw = batchFn(requestJson);
    const wasmOut = (typeof wasmOutRaw === "string") ? JSON.parse(wasmOutRaw) : wasmOutRaw;
    if (!wasmOut || typeof wasmOut !== "object") {
      throw new Error("runMtfBatchViaWasm(web): Rust-WASM batch API returned invalid response");
    }
    return wasmThreadsActive && preparedRequest?.parallel === true
      ? { ...wasmOut, backend: "web-rust-wasm-opd-psf-mtf-rayon" }
      : wasmOut;
  }
}

/**
 * Desktop-only compact MTF evaluator for optimizer finite-difference batches.
 * The Rust command owns the candidate jobs and runs them on Rayon workers; it
 * returns the same `{ results: [{ jobIndex, meta, mtf }] }` shape consumed by
 * the optimizer's existing WASM batch parser.
 */
export async function runNativeOptimizerMtfBatch(
  request: NativeOptimizerMtfBatchRequest,
): Promise<NativeOptimizerMtfBatchResponse> {
  if (!isTauriRuntime()) {
    throw new Error("runNativeOptimizerMtfBatch is available only in the desktop runtime");
  }
  return invokeCommand<NativeOptimizerMtfBatchRequest, NativeOptimizerMtfBatchResponse>(
    "run_native_optimizer_mtf_batch",
    request,
  );
}

type MtfWasmWorkerPool = {
  workerCount: number;
  workers: Worker[];
};

// Optimizer finite-difference batches arrive once per iteration.  Creating a
// fresh WASM worker for every batch loses more time to startup/compilation than
// it saves in tracing.  Keep this pool process-local and serialize batches so
// each worker has at most one in-flight request.
let mtfWasmWorkerPool: MtfWasmWorkerPool | null = null;
let mtfWasmWorkerPoolQueue: Promise<void> = Promise.resolve();
let mtfWasmWorkerRequestSequence = 0;

function disposeMtfWasmWorkerPool(): void {
  const pool = mtfWasmWorkerPool;
  mtfWasmWorkerPool = null;
  if (!pool) return;
  for (const worker of pool.workers) {
    try {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    } catch (_) {}
  }
}

/**
 * Release browser-only optimizer workers after a run completes.
 *
 * The pools intentionally stay warm while finite-difference batches are being
 * evaluated, but keeping the final WASM workers alive after the optimizer is
 * idle retains their module heaps and event handlers. Wait for the serialized
 * queues before terminating so a final batch cannot be interrupted.
 */
export async function releaseWebOptimizerWorkerResources(): Promise<{
  spotWorkers: number;
  mtfWorkers: number;
}> {
  await Promise.allSettled([spotWasmWorkerPoolQueue, mtfWasmWorkerPoolQueue]);
  const spotWorkers = spotWasmWorkerPool?.workers.length ?? 0;
  const mtfWorkers = mtfWasmWorkerPool?.workers.length ?? 0;
  resetSpotWasmWorkerPool();
  disposeMtfWasmWorkerPool();
  spotWasmWorkerPoolQueue = Promise.resolve();
  mtfWasmWorkerPoolQueue = Promise.resolve();
  return { spotWorkers, mtfWorkers };
}

function getMtfWasmWorkerPool(workerCount: number): MtfWasmWorkerPool {
  if (mtfWasmWorkerPool && mtfWasmWorkerPool.workerCount === workerCount) {
    return mtfWasmWorkerPool;
  }
  disposeMtfWasmWorkerPool();
  mtfWasmWorkerPool = {
    workerCount,
    workers: Array.from({ length: workerCount }, () => new Worker(
      new URL("./tfmtf-wasm-worker.ts", import.meta.url),
      { type: "module" },
    )),
  };
  return mtfWasmWorkerPool;
}

export function splitMtfJobsAcrossWorkers(jobs: unknown[], workerCount: number): {
  chunks: unknown[][];
  chunkJobIndexes: number[][];
  strategy: string;
} {
  const chunks: unknown[][] = Array.from({ length: workerCount }, () => []);
  const chunkJobIndexes: number[][] = Array.from({ length: workerCount }, () => []);
  const candidateGroups = new Map<number, Array<{ job: unknown; originalIndex: number }>>();
  let hasCandidateIndexForEveryJob = jobs.length > 0;

  for (let originalIndex = 0; originalIndex < jobs.length; originalIndex += 1) {
    const job = jobs[originalIndex];
    const candidateIndex = Number((job as any)?.meta?.candidateIndex);
    if (!Number.isInteger(candidateIndex) || candidateIndex < 0) {
      hasCandidateIndexForEveryJob = false;
      break;
    }
    const group = candidateGroups.get(candidateIndex) || [];
    group.push({ job, originalIndex });
    candidateGroups.set(candidateIndex, group);
  }

  if (hasCandidateIndexForEveryJob && candidateGroups.size > 0) {
    // A candidate's jobs share its optical system.  Keeping the complete
    // candidate on one worker lets the WASM batch reuse packed surface metadata
    // across its fields and wavelengths, while still evaluating candidates in
    // parallel for finite differences.
    const workerLoads = new Array(workerCount).fill(0);
    const groups = Array.from(candidateGroups.entries())
      .sort((lhs, rhs) => rhs[1].length - lhs[1].length || lhs[0] - rhs[0]);
    for (const [, group] of groups) {
      let target = 0;
      for (let index = 1; index < workerLoads.length; index += 1) {
        if (workerLoads[index] < workerLoads[target]) target = index;
      }
      chunks[target].push(...group.map((entry) => entry.job));
      chunkJobIndexes[target].push(...group.map((entry) => entry.originalIndex));
      workerLoads[target] += group.length;
    }
    return { chunks, chunkJobIndexes, strategy: 'candidate-affinity' };
  }

  jobs.forEach((job, index) => {
    const target = index % workerCount;
    chunks[target].push(job);
    chunkJobIndexes[target].push(index);
  });
  return { chunks, chunkJobIndexes, strategy: 'round-robin' };
}

export function remapMtfWorkerChunkResults(
  response: any,
  originalJobIndexes: number[],
  allJobs: unknown[],
): any[] {
  const workerResults = Array.isArray(response?.results) ? response.results : [];
  return workerResults.map((result: any, responseIndex: number) => {
    const reportedLocalIndex = Number(result?.jobIndex);
    const localIndex = Number.isInteger(reportedLocalIndex)
      && reportedLocalIndex >= 0
      && reportedLocalIndex < originalJobIndexes.length
      ? reportedLocalIndex
      : responseIndex;
    const globalIndex = originalJobIndexes[localIndex];
    if (!Number.isInteger(globalIndex) || globalIndex < 0 || globalIndex >= allJobs.length) {
      throw new Error(`TF-MTF WASM worker returned an unmappable local result index ${String(result?.jobIndex)}`);
    }
    const originalMeta = (allJobs[globalIndex] as any)?.meta;
    return {
      ...result,
      jobIndex: globalIndex,
      meta: {
        ...(originalMeta && typeof originalMeta === 'object' ? originalMeta : {}),
        ...(result?.meta && typeof result.meta === 'object' ? result.meta : {}),
        jobIndex: globalIndex,
      },
    };
  });
}

type SharedMtfWorkerBatch = {
  shared: Record<string, unknown>;
  jobs: unknown[];
  jobIndexes: number[];
};

function haveEquivalentMtfTableRows(left: any[], right: any[]): boolean {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  // Table accessors may return independent clones for two requirements that
  // address the same candidate/wavelength/field. The Worker shared format is
  // valid for those clones too, and avoids repeating Image Height conversion
  // and packed-surface construction. Rows are plain table data, so a stable
  // JSON comparison is a conservative structural-equivalence check.
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch (_) {
    return false;
  }
}

/**
 * Finite-difference candidates use one lens for every field.  Group a
 * candidate/wavelength into the established Rust `shared` batch format so the
 * browser neither structured-clones nor JSON-stringifies those lens rows once
 * per field.  Wavelengths must stay separate: refractive indices and packed
 * surface metadata are wavelength-dependent.
 */
function buildSharedMtfWorkerRequest(request: any, jobs: unknown[]): any {
  const groups = new Map<string, {
    opticalRows: any[];
    sourceRows: any[];
    objectRows: any[];
    wavelength: number;
    jobs: Array<{ job: any; index: number }>;
  }>();

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index] as any;
    const opd = job?.opdRequest;
    const candidateIndex = Number(job?.meta?.candidateIndex);
    const wavelength = Number(opd?.wavelengthUm ?? job?.wavelengthUm);
    const opticalRows = Array.isArray(opd?.opticalSystemRows) ? opd.opticalSystemRows : null;
    const sourceRows = Array.isArray(opd?.sourceRows) ? opd.sourceRows : null;
    const objectRows = Array.isArray(opd?.objectRows) ? opd.objectRows : null;
    if (!Number.isInteger(candidateIndex) || candidateIndex < 0
      || !Number.isFinite(wavelength) || wavelength <= 0
      || !opticalRows || opticalRows.length === 0 || !sourceRows || !objectRows) {
      return { ...request, jobs };
    }
    const key = `${candidateIndex}|${wavelength.toFixed(9)}`;
    const group = groups.get(key);
    // Do not compact unusual callers that place distinct system/table arrays
    // under the same nominal candidate and wavelength.
    if (group && (!haveEquivalentMtfTableRows(group.opticalRows, opticalRows)
      || !haveEquivalentMtfTableRows(group.sourceRows, sourceRows)
      || !haveEquivalentMtfTableRows(group.objectRows, objectRows))) {
      return { ...request, jobs };
    }
    if (group) {
      group.jobs.push({ job, index });
    } else {
      groups.set(key, { opticalRows, sourceRows, objectRows, wavelength, jobs: [{ job, index }] });
    }
  }

  if (groups.size === 0) return { ...request, jobs };
  const optimizerSharedMtfBatches: SharedMtfWorkerBatch[] = [];
  for (const group of groups.values()) {
    const firstOpd = group.jobs[0]?.job?.opdRequest || {};
    const shared = {
      opdRequest: {
        ...firstOpd,
        opticalSystemRows: group.opticalRows,
        sourceRows: group.sourceRows,
        objectRows: group.objectRows,
        wavelengthUm: group.wavelength,
      },
    };
    const compactJobs = group.jobs.map(({ job }) => {
      const opd = { ...(job?.opdRequest || {}) };
      delete opd.opticalSystemRows;
      delete opd.sourceRows;
      delete opd.objectRows;
      return { ...job, opdRequest: opd };
    });
    optimizerSharedMtfBatches.push({
      shared,
      jobs: compactJobs,
      jobIndexes: group.jobs.map(({ index }) => index),
    });
  }

  return { ...request, jobs: undefined, optimizerSharedMtfBatches };
}

export async function runMtfBatchViaWasmWorkerPool(request: any): Promise<any> {
  const jobs = Array.isArray(request?.jobs) ? request.jobs : [];
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const logElapsed = () => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    return Math.max(0, now - startedAt).toFixed(1);
  };
  if (jobs.length <= 1 || typeof Worker === "undefined") {
    console.info(`[TFMTF WorkerPool] bypassed: jobs=${jobs.length}, worker=${typeof Worker !== "undefined"}, elapsed=${logElapsed()}ms`);
    return runMtfBatchViaWasm(request);
  }

  if (
    typeof crossOriginIsolated !== "undefined"
    && crossOriginIsolated
    && typeof SharedArrayBuffer === "function"
  ) {
    console.info(`[TFMTF WorkerPool] bypassed: crossOriginIsolated=true, using Rayon WASM path, jobs=${jobs.length}`);
    const rayonResponse = await runMtfBatchViaWasm(request);
    const rayonNow = typeof performance !== "undefined" ? performance.now() : Date.now();
    console.info(`[TFMTF WorkerPool] Rayon finished: jobs=${jobs.length}, elapsed=${Math.max(0, rayonNow - startedAt).toFixed(1)}ms`);
    return rayonResponse;
  }

  const hardwareConcurrency = typeof navigator !== "undefined"
    ? Number(navigator.hardwareConcurrency)
    : 4;
  const candidateIndexes = new Set<number>();
  let allJobsHaveCandidateIndex = jobs.length > 0;
  for (const job of jobs) {
    const candidateIndex = Number((job as any)?.meta?.candidateIndex);
    if (!Number.isInteger(candidateIndex) || candidateIndex < 0) {
      allJobsHaveCandidateIndex = false;
      break;
    }
    candidateIndexes.add(candidateIndex);
  }
  const parallelGroupLimit = allJobsHaveCandidateIndex && candidateIndexes.size > 0
    ? candidateIndexes.size
    : jobs.length;
  const workerCount = Math.max(1, Math.min(6, jobs.length, parallelGroupLimit, Number.isFinite(hardwareConcurrency) ? hardwareConcurrency : 4));
  console.info(`[TFMTF WorkerPool] starting: jobs=${jobs.length}, workers=${workerCount}, hardwareConcurrency=${hardwareConcurrency}`);
  const runPoolBatch = async (): Promise<any> => {
    const { chunks, chunkJobIndexes, strategy } = splitMtfJobsAcrossWorkers(jobs, workerCount);
    const pool = getMtfWasmWorkerPool(workerCount);
    const responses = await Promise.all(chunks.map((chunk, index) => new Promise<any>((resolve, reject) => {
      const requestId = `tfmtf-${Date.now()}-${++mtfWasmWorkerRequestSequence}-${index}`;
      const worker = pool.workers[index];
      worker.onmessage = (event: MessageEvent<any>) => {
        const message = event.data;
        if (message?.requestId !== requestId) return;
        if (message.ok !== true) {
          reject(new Error(String(message.error || "TF-MTF WASM worker failed")));
          return;
        }
        resolve(message.response);
      };
      worker.onerror = (event) => reject(new Error(String(event.message || "TF-MTF WASM worker error")));
      worker.postMessage({
        requestId,
        request: buildSharedMtfWorkerRequest(request, chunk),
      });
    })));
    const results = responses
      .flatMap((response, workerIndex) => remapMtfWorkerChunkResults(
        response,
        chunkJobIndexes[workerIndex],
        jobs,
      ))
      .sort((left, right) => Number(left?.jobIndex) - Number(right?.jobIndex));
    const sharedBatchCount = responses.reduce((total, response) => (
      total + Math.max(0, Math.floor(Number(response?.sharedBatchCount) || 0))
    ), 0);
    if (results.length !== jobs.length) {
      throw new Error(`TF-MTF WASM worker pool returned ${results.length}/${jobs.length} results`);
    }
    const uniqueJobIndexes = new Set(results.map((result) => Number(result?.jobIndex)));
    if (uniqueJobIndexes.size !== jobs.length) {
      throw new Error(`TF-MTF WASM worker pool returned ${uniqueJobIndexes.size}/${jobs.length} unique job indexes`);
    }
    return {
      backend: "web-rust-wasm-opd-psf-mtf-worker-pool",
      results,
      workerCount,
      workerStrategy: strategy,
      sharedBatchCount,
      message: `Computed ${jobs.length} TF-MTF jobs across ${workerCount} persistent WASM workers (${strategy})`,
    };
  };

  const scheduled = mtfWasmWorkerPoolQueue.then(runPoolBatch, runPoolBatch);
  mtfWasmWorkerPoolQueue = scheduled.then(() => undefined, () => undefined);
  try {
    return await scheduled;
  } catch (error) {
    disposeMtfWasmWorkerPool();
    console.warn(`[TFMTF WorkerPool] failed after ${logElapsed()}ms; retrying on the main WASM instance`, error);
    return runMtfBatchViaWasm(request);
  } finally {
    console.info(`[TFMTF WorkerPool] finished: jobs=${jobs.length}, workers=${workerCount}, elapsed=${logElapsed()}ms`);
  }
}

export async function runNativeMtfMap(
  payload: NativeMtfMapRequest,
): Promise<NativeMtfMapResponse> {
  if (!isTauriRuntime()) {
    const requestedMethod = String((payload as any)?.method || "hopkins-tcc").trim().toLowerCase();
    if (requestedMethod !== "malacara-wasm-required") {
      const { preloadRustRayTracingWasm, getRustRayTracingWasmInitError } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
      const api = await preloadRustRayTracingWasm();
      const fn = (api as any)?.run_native_mtf_from_psf_wasm_json;
      if (typeof fn !== "function") {
        const initError = String(getRustRayTracingWasmInitError?.() || "").trim();
        throw new Error(
          "runNativeMtfMap(web): Rust-WASM MTF API is unavailable. "
          + `Reason=${initError || "missing export run_native_mtf_from_psf_wasm_json"}`,
        );
      }
      const reqJson = JSON.stringify({
        psfData: payload?.psfData,
        pixelSizeUm: Number(payload?.pixelSizeUm),
        maxFrequencyLpmm: Number(payload?.maxFrequencyLpmm),
        targetFrequencyLpmm: Number((payload as any)?.targetFrequencyLpmm),
        sampleFrequenciesLpmm: Array.isArray(payload?.sampleFrequenciesLpmm) ? payload.sampleFrequenciesLpmm : undefined,
        directEvalOnly: payload?.directEvalOnly === true,
        points: Number(payload?.points),
      });
      const raw = fn(reqJson);
      const resp: any = (typeof raw === "string") ? JSON.parse(raw) : raw;
      if (!resp || typeof resp !== "object") {
        throw new Error("runNativeMtfMap(web): Rust-WASM MTF returned invalid response");
      }
      return resp as NativeMtfMapResponse;
    }

    if (payload?.method === "malacara-wasm-required") {
      const { preloadRustRayTracingWasm } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
      const api = await preloadRustRayTracingWasm();
      if (!api || typeof (api as any).run_native_mtf_malacara_from_opd_wasm_json !== "function") {
        throw new Error("runNativeMtfMap(web): Rust/WASM Malacara export is unavailable");
      }
      const reqJson = JSON.stringify({
        displayOpdGrid: (payload as any)?.displayOpdGrid,
        rawOpdGrid: (payload as any)?.rawOpdGrid,
        amplitudeGrid: (payload as any)?.amplitudeGrid,
        wavelengthUm: Number((payload as any)?.wavelengthUm),
        fNumber: Number((payload as any)?.fNumber),
        pupilRange: Number((payload as any)?.pupilRange),
        maxFrequencyLpmm: Number(payload?.maxFrequencyLpmm),
        points: Number(payload?.points),
        sampleFrequenciesLpmm: Array.isArray(payload?.sampleFrequenciesLpmm) ? payload.sampleFrequenciesLpmm : undefined,
        directEvalOnly: payload?.directEvalOnly === true,
        tangentialDir: (payload as any)?.tangentialDir,
        sagittalDir: (payload as any)?.sagittalDir,
      });
      let resp: any;
      try {
        resp = (api as any).run_native_mtf_malacara_from_opd_wasm_json(reqJson);
      } catch (e: any) {
        throw new Error(`runNativeMtfMap(web): Rust/WASM Malacara call failed (${String(e?.message || e)})`);
      }
      if (!resp || typeof resp !== "object") {
        throw new Error("runNativeMtfMap(web): Rust/WASM Malacara returned invalid response");
      }
      return resp as NativeMtfMapResponse;
    }

    const { fft2D_WASM } = await import("../../../rust-wasm/ts/raytracing/fft-wasm-wrapper.ts");
    const psf = Array.isArray(payload?.psfData) ? payload.psfData : [];
    const n = psf.length;
    if (n <= 1 || !Array.isArray(psf[0]) || psf[0].length !== n) {
      throw new Error("runNativeMtfMap(web): psfData must be NxN");
    }
    const pixelSizeUm = Number(payload?.pixelSizeUm);
    if (!(Number.isFinite(pixelSizeUm) && pixelSizeUm > 0)) {
      throw new Error("runNativeMtfMap(web): pixelSizeUm must be positive");
    }

    const method = String((payload as any)?.method || "hopkins-tcc").trim().toLowerCase();
    const useHopkinsTcc = method === "hopkins-tcc" || method === "hopkins" || method === "auto";

    const dfLpmm = (1 / (n * pixelSizeUm)) * 1000;
    const nyquistLpmm = (0.5 / pixelSizeUm) * 1000;
    const maxFreqReq = Number.isFinite(Number(payload?.maxFrequencyLpmm)) ? Number(payload.maxFrequencyLpmm) : nyquistLpmm;
    const maxFreq = Math.max(0, Math.min(maxFreqReq, nyquistLpmm));
    const points = Math.max(2, Math.min(2048, Math.floor(Number(payload?.points) || 128)));
    const directEvalOnly = !!payload?.directEvalOnly;
    const sampledFrequenciesLpmm = (Array.isArray(payload?.sampleFrequenciesLpmm) ? payload.sampleFrequenciesLpmm : [])
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 0)
      .map((v) => Math.min(v, nyquistLpmm));

    if (useHopkinsTcc) {
      const lsfX = Array.from({ length: n }, () => 0);
      const lsfY = Array.from({ length: n }, () => 0);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const v = Number(psf[y][x]);
          const vv = Number.isFinite(v) ? v : 0;
          lsfX[x] += vv;
          lsfY[y] += vv;
        }
      }

      const buildLag = (lsf: number[]) => {
        const lag = new Array(lsf.length).fill(0);
        for (let d = 0; d < lsf.length; d++) {
          let acc = 0;
          for (let i = 0; i < lsf.length - d; i++) {
            acc += lsf[i] * lsf[i + d];
          }
          lag[d] = acc;
        }
        return lag;
      };

      const evalHopkins = (freqs: number[], lsf: number[]) => {
        if (!Array.isArray(freqs) || freqs.length === 0 || !Array.isArray(lsf) || lsf.length === 0) return [];
        const lag = buildLag(lsf);
        const dc = Math.max(1e-12, Math.abs(lsf.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0)));
        const nFloat = Math.max(1, lsf.length);
        return freqs.map((fRaw) => {
          const f = Math.max(0, Math.min(nyquistLpmm, Number(fRaw) || 0));
          const idx = f / Math.max(1e-12, dfLpmm);
          const base = (2 * Math.PI * idx) / nFloat;
          let otfPower = lag[0] || 0;
          for (let d = 1; d < lag.length; d++) {
            otfPower += 2 * lag[d] * Math.cos(base * d);
          }
          const mtf = Math.sqrt(Math.max(0, otfPower)) / dc;
          return Math.max(0, Math.min(1, mtf));
        });
      };

      const frequencyAxis = directEvalOnly
        ? []
        : Array.from({ length: points }, (_, i) => {
            const t = points > 1 ? (i / (points - 1)) : 0;
            return maxFreq * t;
          });

      const mtfTangential = evalHopkins(frequencyAxis, lsfY);
      const mtfSagittal = evalHopkins(frequencyAxis, lsfX);
      if (mtfTangential.length > 0 && (frequencyAxis[0] ?? 0) <= 1e-12) mtfTangential[0] = 1;
      if (mtfSagittal.length > 0 && (frequencyAxis[0] ?? 0) <= 1e-12) mtfSagittal[0] = 1;

      const sampledMtfTangential = sampledFrequenciesLpmm.length > 0
        ? evalHopkins(sampledFrequenciesLpmm, lsfY)
        : undefined;
      const sampledMtfSagittal = sampledFrequenciesLpmm.length > 0
        ? evalHopkins(sampledFrequenciesLpmm, lsfX)
        : undefined;

      if (sampledMtfTangential && sampledMtfTangential.length > 0 && (sampledFrequenciesLpmm[0] ?? 0) <= 1e-12) {
        sampledMtfTangential[0] = 1;
      }
      if (sampledMtfSagittal && sampledMtfSagittal.length > 0 && (sampledFrequenciesLpmm[0] ?? 0) <= 1e-12) {
        sampledMtfSagittal[0] = 1;
      }

      return {
        backend: "web-rust-wasm-hopkins-tcc",
        frequencyAxis,
        mtfTangential,
        mtfSagittal,
        sampledFrequenciesLpmm: sampledFrequenciesLpmm.length > 0 ? sampledFrequenciesLpmm : undefined,
        sampledMtfTangential,
        sampledMtfSagittal,
        nyquistLpmm,
        message: "Computed via Web Rust/WASM MTF API (Hopkins-TCC)",
      };
    }

    const real = Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => {
      const v = Number(psf[y][x]);
      return Number.isFinite(v) ? v : 0;
    }));
    const imag = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
    const otf = await fft2D_WASM(real, imag, { fallbackToJS: false });

    const dcRe = Number(otf?.real?.[0]?.[0]) || 0;
    const dcIm = Number(otf?.imag?.[0]?.[0]) || 0;
    const dcMag = Math.hypot(dcRe, dcIm);
    if (!(Number.isFinite(dcMag) && dcMag > 0)) {
      throw new Error("runNativeMtfMap(web): invalid OTF DC component");
    }

    
    const kMax = Math.max(0, Math.min(Math.floor(n / 2), Math.floor(maxFreq / Math.max(dfLpmm, 1e-12))));

    const freqDiscrete: number[] = [];
    const sagittalDiscrete: number[] = [];
    const tangentialDiscrete: number[] = [];
    for (let k = 0; k <= kMax; k++) {
      const reX = Number(otf?.real?.[0]?.[k]) || 0;
      const imX = Number(otf?.imag?.[0]?.[k]) || 0;
      const reY = Number(otf?.real?.[k]?.[0]) || 0;
      const imY = Number(otf?.imag?.[k]?.[0]) || 0;
      freqDiscrete.push(k * dfLpmm);
      sagittalDiscrete.push(Math.hypot(reX, imX) / dcMag);
      tangentialDiscrete.push(Math.hypot(reY, imY) / dcMag);
    }

    const pointsLegacy = Math.max(2, Math.min(2048, Math.floor(Number(payload?.points) || freqDiscrete.length)));
    const sampleLinear = (xArr: number[], yArr: number[], x: number) => {
      if (xArr.length === 0 || yArr.length === 0) return 0;
      if (x <= xArr[0]) return yArr[0] ?? 0;
      const last = xArr.length - 1;
      if (x >= xArr[last]) return yArr[last] ?? 0;
      for (let i = 1; i < xArr.length; i++) {
        const x0 = xArr[i - 1];
        const x1 = xArr[i];
        if (x <= x1 && x1 > x0) {
          const t = (x - x0) / (x1 - x0);
          return (yArr[i - 1] ?? 0) + ((yArr[i] ?? 0) - (yArr[i - 1] ?? 0)) * t;
        }
      }
      return yArr[last] ?? 0;
    };

    const sampledMtfTangential = sampledFrequenciesLpmm.length > 0
      ? sampledFrequenciesLpmm.map((f) => Math.max(0, Math.min(1, sampleLinear(freqDiscrete, tangentialDiscrete, f))))
      : undefined;
    const sampledMtfSagittal = sampledFrequenciesLpmm.length > 0
      ? sampledFrequenciesLpmm.map((f) => Math.max(0, Math.min(1, sampleLinear(freqDiscrete, sagittalDiscrete, f))))
      : undefined;

    const frequencyAxis: number[] = [];
    const mtfSagittal: number[] = [];
    const mtfTangential: number[] = [];
    if (!directEvalOnly) {
      for (let i = 0; i < pointsLegacy; i++) {
        const f = (i / Math.max(1, pointsLegacy - 1)) * maxFreq;
        frequencyAxis.push(f);
        mtfSagittal.push(sampleLinear(freqDiscrete, sagittalDiscrete, f));
        mtfTangential.push(sampleLinear(freqDiscrete, tangentialDiscrete, f));
      }
      if (mtfSagittal.length > 0) mtfSagittal[0] = 1;
      if (mtfTangential.length > 0) mtfTangential[0] = 1;
    }

    return {
      backend: "web-rust-wasm",
      frequencyAxis,
      mtfTangential,
      mtfSagittal,
      sampledFrequenciesLpmm: sampledFrequenciesLpmm.length > 0 ? sampledFrequenciesLpmm : undefined,
      sampledMtfTangential,
      sampledMtfSagittal,
      nyquistLpmm,
      message: "Computed via Web Rust/WASM MTF API",
    };
  }
  return invokeCommand<NativeMtfMapRequest, NativeMtfMapResponse>("run_native_mtf_map", payload);
}

export async function runNativeThroughFocusMtfMap(
  payload: NativeThroughFocusMtfMapRequest,
  onProgress?: (evt: { percent?: number; message?: string }) => void,
): Promise<NativeThroughFocusMtfMapResponse> {
  if (!isTauriRuntime()) {
    const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
    if (opticalSystemRows.length === 0) {
      throw new Error("runNativeThroughFocusMtfMap(web): opticalSystemRows is empty");
    }

    const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
    const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
    const objectIndex = Number.isInteger(payload?.objectIndex) ? Math.max(0, Number(payload.objectIndex)) : 0;

    const defocusMinRaw = Number(payload?.defocusMinMm);
    const defocusMaxRaw = Number(payload?.defocusMaxMm);
    const defocusMin = Number.isFinite(defocusMinRaw) ? defocusMinRaw : -0.1;
    const defocusMax = Number.isFinite(defocusMaxRaw) ? defocusMaxRaw : 0.1;
    const minMm = Math.min(defocusMin, defocusMax);
    const maxMm = Math.max(defocusMin, defocusMax);
    const steps = Math.max(3, Math.min(201, Math.floor(Number(payload?.steps) || 21)));
    const targetFreqLpmm = Math.max(0, Number(payload?.targetFrequencyLpmm) || 10);
    const samplingSize = Math.max(32, Math.min(4096, Math.floor(Number(payload?.samplingSize) || 32)));

    const requestedFftSize = samplingSize;
    const pixelSizeUm = (Number.isFinite(Number(payload?.pixelSizeUm)) && Number(payload?.pixelSizeUm) > 0)
      ? Number(payload?.pixelSizeUm)
      : 1.0;
    const opdDisplayMode = String(payload?.opdDisplayMode || "pistonTiltRemoved");
    const mtfMethod = (typeof (payload as any)?.method === "string" && String((payload as any).method).trim())
      ? String((payload as any).method).trim()
      : "hopkins-tcc";

    const xAxis = Array.from({ length: steps }, (_, i) => {
      const t = steps > 1 ? i / (steps - 1) : 0;
      return minMm + t * (maxMm - minMm);
    });

    const wavelengths = (() => {
      const picked = (Array.isArray(payload?.wavelengths) ? payload.wavelengths : [])
        .map((w: any) => Number(w))
        .filter((w: number) => Number.isFinite(w) && w > 0)
        .sort((a: number, b: number) => a - b);
      const unique: number[] = [];
      for (const w of picked) {
        if (!unique.some((u) => Math.abs(u - w) < 1e-9)) {
          unique.push(w);
        }
      }
      if (unique.length > 0) return unique;
      return [getPrimaryWavelengthUm(sourceRows, 0.5876)];
    })();

    const series: Array<{ wavelengthUm: number; label: string; mtfTangential: number[]; mtfSagittal: number[] }> = [];
    const { calculateImageSpaceDiffractionParams } = await import("../../../raytracing/core/ray-paraxial.ts");
    const selectedObject = objectRows[objectIndex] || objectRows[0] || {};
    const selectedX = Number((selectedObject as any)?.xHeightAngle ?? (selectedObject as any)?.xHeight ?? (selectedObject as any)?.x ?? 0) || 0;
    const selectedY = Number((selectedObject as any)?.yHeightAngle ?? (selectedObject as any)?.yHeight ?? (selectedObject as any)?.y ?? 0) || 0;
    const directionNorm = Math.hypot(selectedX, selectedY);
    const tangentialDir = directionNorm > 1e-12
      ? { x: selectedX / directionNorm, y: selectedY / directionNorm }
      : { x: 1, y: 0 };
    const sagittalDir = { x: -tangentialDir.y, y: tangentialDir.x };

    // Progress tracking helper
    const setProgress = (percent: number, message: string) => {
      if (typeof onProgress === "function") {
        onProgress({
          percent: Math.max(0, Math.min(100, percent)),
          message,
        });
      }
    };

    // ── Batch API Path: Compute all OPD/PSF/MTF in parallel ──
    // Build jobs for all (wavelength, defocus) combinations
    setProgress(10, "Building batch jobs for Through-Focus MTF...");
    
    const jobs: any[] = [];
    const jobIndexToCoordinates: Array<{ wi: number; si: number; wl: number; defocusMm: number }> = [];
    
    for (let wi = 0; wi < wavelengths.length; wi++) {
      const wl = wavelengths[wi];
      for (let si = 0; si < xAxis.length; si++) {
        const defocusMm = xAxis[si];
        
        jobs.push({
          opdRequest: {
            wavelengthUm: wl,
            opticalSystemRows,
            sourceRows,
            objectRows,
            objectIndex,
            pupilSamplingMode: payload?.pupilSamplingMode,
            opdDisplayMode,
          },
          defocusMm,
          wavelengthUm: wl,
          pixelSizeUm,
          zeroPadTo: requestedFftSize,
          removeTilt: false,
          maxFrequencyLpmm: Math.max(targetFreqLpmm * 2, 1),
          targetFrequencyLpmm: targetFreqLpmm,
          sampleFrequenciesLpmm: [targetFreqLpmm],
          directEvalOnly: true,
          points: 2,
          slimResults: true,
          method: mtfMethod,
          meta: {
            wi,
            si,
            wl,
            defocusMm,
            jobIndex: jobs.length,
          },
        });
        jobIndexToCoordinates.push({ wi, si, wl, defocusMm });
      }
    }

    setProgress(25, `Executing batch MTF computation (${jobs.length} jobs)...`);

    // Execute batch via WASM
    const batchResp = await runMtfBatchViaWasmWorkerPool({
      jobs,
      shared: {
        opdRequest: {
          opticalSystemRows,
          sourceRows,
          objectRows,
          objectIndex,
          wavelengthUm: wavelengths.length > 0 ? wavelengths[0] : getPrimaryWavelengthUm(sourceRows, 0.5876),
          surfaceIndex: undefined,
          gridSize: samplingSize,
          pupilSamplingMode: payload?.pupilSamplingMode,
          opdDisplayMode,
        },
      },
    });

    if (!Array.isArray(batchResp?.results)) {
      throw new Error("runNativeThroughFocusMtfMap(web): Batch API returned no results");
    }

    // Restore results to matrix form [wavelength][defocusStep]
    const mtfMatrix: any[][] = Array(wavelengths.length).fill(null).map(() => Array(xAxis.length).fill(null));
    
    setProgress(75, "Parsing batch results...");
    
    for (const result of batchResp.results) {
      const coords = jobIndexToCoordinates[result.jobIndex] || jobIndexToCoordinates[result.meta?.jobIndex];
      if (!coords) continue;
      
      const { wi, si } = coords;
      if (mtfMatrix[wi] && si < mtfMatrix[wi].length) {
        mtfMatrix[wi][si] = result;
      }
    }

    // Convert matrix results to series format
    setProgress(85, "Formatting results...");
    
    for (let wi = 0; wi < wavelengths.length; wi++) {
      const wl = wavelengths[wi];
      const tanVec: number[] = [];
      const sagVec: number[] = [];

      for (let si = 0; si < xAxis.length; si++) {
        const result = mtfMatrix[wi][si];
        const mtfResp = result?.mtf || result;
        
        if (!mtfResp) {
          // Fallback for missing result
          tanVec.push(0);
          sagVec.push(0);
          continue;
        }

        let tan = Number.NaN;
        let sag = Number.NaN;
        const opd = result?.opd || {};
        const displayOpdGrid = Array.isArray(opd.displayOpdGrid) ? opd.displayOpdGrid : opd.rawOpdGrid;
        if (Array.isArray(displayOpdGrid) && displayOpdGrid.length > 1) {
          const diffraction = calculateImageSpaceDiffractionParams(opticalSystemRows, wl);
          const fNumber = Number(diffraction?.fNumberWorking);
          const toMicronGrid = (grid: any) => Array.isArray(grid)
            ? grid.map((row: any) => Array.isArray(row)
              ? row.map((value: any) => Number.isFinite(Number(value)) ? Number(value) * wl : null)
              : row)
            : [];
          const nativeMtf = await runNativeMtfMap({
            method: "malacara-wasm-required",
            displayOpdGrid: toMicronGrid(displayOpdGrid),
            rawOpdGrid: toMicronGrid(Array.isArray(opd.rawOpdGrid) ? opd.rawOpdGrid : displayOpdGrid),
            amplitudeGrid: displayOpdGrid.map((row: any[]) => row.map((value: any) => Number.isFinite(Number(value)) ? 1 : 0)),
            wavelengthUm: wl,
            fNumber,
            pupilRange: 1,
            maxFrequencyLpmm: targetFreqLpmm,
            points: 2,
            sampleFrequenciesLpmm: [targetFreqLpmm],
            directEvalOnly: true,
            tangentialDir,
            sagittalDir,
          } as any);
          const sampledTan = Array.isArray(nativeMtf.sampledMtfTangential) ? Number(nativeMtf.sampledMtfTangential[0]) : Number.NaN;
          const sampledSag = Array.isArray(nativeMtf.sampledMtfSagittal) ? Number(nativeMtf.sampledMtfSagittal[0]) : Number.NaN;
          tan = Number.isFinite(sampledTan)
            ? sampledTan
            : interpolateAxisValue(nativeMtf.frequencyAxis || [], nativeMtf.mtfTangential || [], targetFreqLpmm);
          sag = Number.isFinite(sampledSag)
            ? sampledSag
            : interpolateAxisValue(nativeMtf.frequencyAxis || [], nativeMtf.mtfSagittal || [], targetFreqLpmm);
        }
        if (!Number.isFinite(tan) || !Number.isFinite(sag)) {
          const sampledTan = Array.isArray(mtfResp?.sampledMtfTangential) ? Number(mtfResp.sampledMtfTangential[0]) : Number(mtfResp?.targetMtfTangential);
          const sampledSag = Array.isArray(mtfResp?.sampledMtfSagittal) ? Number(mtfResp.sampledMtfSagittal[0]) : Number(mtfResp?.targetMtfSagittal);
          tan = Number.isFinite(sampledTan) ? sampledTan : interpolateAxisValue(mtfResp?.frequencyAxis || [], mtfResp?.mtfTangential || [], targetFreqLpmm);
          sag = Number.isFinite(sampledSag) ? sampledSag : interpolateAxisValue(mtfResp?.frequencyAxis || [], mtfResp?.mtfSagittal || [], targetFreqLpmm);
        }
        tanVec.push(tan);
        sagVec.push(sag);
      }

      series.push({
        wavelengthUm: wl,
        label: `${(wl * 1000).toFixed(1)}nm`,
        mtfTangential: tanVec,
        mtfSagittal: sagVec,
      });
    }

    setProgress(100, "Through-Focus MTF computation complete");

    return {
      backend: "web-rust-wasm-batch",
      xAxis,
      series,
      message: "Computed via Web Rust/WASM Through-Focus MTF Batch API (optimized)",
    };
  }
  return invokeCommand<NativeThroughFocusMtfMapRequest, NativeThroughFocusMtfMapResponse>(
    "run_native_through_focus_mtf_map",
    payload,
  );
}

export async function runNativeFieldMtfMap(
  payload: NativeFieldMtfMapRequest,
): Promise<NativeFieldMtfMapResponse> {
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
  const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
  const objectIndex = Number.isFinite(Number(payload?.objectIndex)) ? Math.max(0, Math.floor(Number(payload?.objectIndex))) : 0;
  const normalizedInputObjectRows = objectRows.map((row) => {
    if (!row || typeof row !== "object") return row;
    const normalizedRow = { ...row } as any;
    const targetX = normalizedRow?.__cooptImageHeightTarget?.x;
    const targetY = normalizedRow?.__cooptImageHeightTarget?.y;
    if (normalizedRow.xHeightAngle == null && normalizedRow["object x"] != null) normalizedRow.xHeightAngle = normalizedRow["object x"];
    if (normalizedRow.yHeightAngle == null && normalizedRow["object y"] != null) normalizedRow.yHeightAngle = normalizedRow["object y"];
    if (normalizedRow.xHeightAngle == null && normalizedRow.xHeight != null) normalizedRow.xHeightAngle = normalizedRow.xHeight;
    if (normalizedRow.yHeightAngle == null && normalizedRow.yHeight != null) normalizedRow.yHeightAngle = normalizedRow.yHeight;
    if (normalizedRow.xHeightAngle == null && normalizedRow.x != null) normalizedRow.xHeightAngle = normalizedRow.x;
    if (normalizedRow.yHeightAngle == null && normalizedRow.y != null) normalizedRow.yHeightAngle = normalizedRow.y;
    if (normalizedRow.xHeightAngle == null && targetX != null) normalizedRow.xHeightAngle = targetX;
    if (normalizedRow.yHeightAngle == null && targetY != null) normalizedRow.yHeightAngle = targetY;
    if (normalizedRow.position == null && normalizedRow.objectType != null) normalizedRow.position = normalizedRow.objectType;
    return normalizedRow;
  });
  const hasImageHeightObjectRows = normalizedInputObjectRows.some((row) => String((row as any)?.position ?? "").trim().toLowerCase() === "imageheight");
  // Prefer the dedicated native field-MTF command on desktop for all object row types.
  // Shared route remains as a full fallback if native path is unavailable/fails.
  const preferSharedFieldMtfRoute = !isTauriRuntime();
  const sampleFromObjectRows = payload?.sampleFromObjectRows === true && normalizedInputObjectRows.length > 0;

  const samplingSize = Number.isFinite(Number(payload?.samplingSize)) ? Math.max(32, Math.floor(Number(payload?.samplingSize))) : 32;
  const requestedFftSize = samplingSize;
  const axisMode = payload?.fieldAxisMode === "height" ? "height" : "angle";
  const firstFrequencyLpmm = Number.isFinite(Number(payload?.firstFrequencyLpmm)) ? Number(payload?.firstFrequencyLpmm) : 10;
  const secondFrequencyLpmm = Number.isFinite(Number(payload?.secondFrequencyLpmm)) ? Number(payload?.secondFrequencyLpmm) : 30;
  const thirdFrequencyLpmm = Number.isFinite(Number(payload?.thirdFrequencyLpmm)) ? Number(payload?.thirdFrequencyLpmm) : 40;
  const fieldMinRaw = Number.isFinite(Number(payload?.fieldMin)) ? Number(payload?.fieldMin) : 0;
  const fieldMaxRaw = Number.isFinite(Number(payload?.fieldMax)) ? Number(payload?.fieldMax) : 10;
  const fieldMin = Math.min(fieldMinRaw, fieldMaxRaw);
  const fieldMax = Math.max(fieldMinRaw, fieldMaxRaw);
  const steps = Number.isFinite(Number(payload?.steps)) ? Math.max(3, Math.floor(Number(payload?.steps))) : 21;
  const opdDisplayMode = String(payload?.opdDisplayMode || "pistonTiltRemoved");
  const hasExplicitPupilSamplingMode = payload?.pupilSamplingMode === "stop" || payload?.pupilSamplingMode === "entrance";
  const forcedPupilSamplingMode = readForcedInfinitePupilMode();
  const requestedPupilSamplingMode = hasExplicitPupilSamplingMode
    ? payload.pupilSamplingMode
    : forcedPupilSamplingMode;
  const mtfMethod = (typeof (payload as any)?.method === "string" && String((payload as any).method).trim())
    ? String((payload as any).method).trim()
    : "hopkins-tcc";
  const onProgress = typeof (payload as any)?.onProgress === "function" ? (payload as any).onProgress : null;

  if (!preferSharedFieldMtfRoute && isTauriRuntime()) {
    try {
      const nativePayload: NativeFieldMtfMapRequest = {
        ...(payload as NativeFieldMtfMapRequest),
        objectRows: normalizedInputObjectRows,
      };
      return await invokeCommand<NativeFieldMtfMapRequest, NativeFieldMtfMapResponse>(
        "run_native_field_mtf_map",
        nativePayload,
      );
    } catch (_) {
      // Keep the Rust/WASM fallback below if the direct native command is unavailable.
    }
  }

  const fillNaNGapsInPlace = (arr: number[]) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    const n = arr.length;
    let firstValid = -1;
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(arr[i])) {
        firstValid = i;
        break;
      }
    }
    if (firstValid < 0) {
      for (let i = 0; i < n; i++) arr[i] = 0;
      return;
    }
    for (let i = 0; i < firstValid; i++) arr[i] = arr[firstValid];
    let lastValid = firstValid;
    let i = firstValid + 1;
    while (i < n) {
      if (Number.isFinite(arr[i])) {
        lastValid = i;
        i += 1;
        continue;
      }
      const gapStart = i;
      while (i < n && !Number.isFinite(arr[i])) i += 1;
      const gapEnd = i - 1;
      if (i < n) {
        const leftV = arr[lastValid];
        const rightV = arr[i];
        const span = i - lastValid;
        for (let k = gapStart; k <= gapEnd; k++) {
          const t = (k - lastValid) / span;
          arr[k] = leftV + t * (rightV - leftV);
        }
        lastValid = i;
      } else {
        for (let k = gapStart; k <= gapEnd; k++) arr[k] = arr[lastValid];
      }
    }
  };

  let lastProgressYieldAt = 0;
  const maybeYieldForProgressPaint = async () => {
    const now = (typeof performance !== "undefined" && typeof performance.now === "function")
      ? performance.now()
      : Date.now();
    if ((now - lastProgressYieldAt) < 12) return;
    lastProgressYieldAt = now;
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 0);
    });
  };

  const suppressFieldCurveOutliersInPlace = ({
    diagnostics,
    curves,
  }: {
    diagnostics: any[];
    curves: number[][];
  }): number => {
    if (!Array.isArray(curves) || curves.length === 0) return 0;
    const usableCurves = curves.filter((curve) => Array.isArray(curve) && curve.length >= 3);
    if (usableCurves.length === 0) return 0;
    let suppressed = 0;
    const annotateSuppressed = (index: number, reason: string, curveIndex: number) => {
      const diag = diagnostics[index];
      if (!diag || typeof diag !== "object") return;
      diag.outlierSuppressed = true;
      const existingReason = Array.isArray(diag.outlierReasons) ? diag.outlierReasons.slice() : [];
      existingReason.push(`${curveIndex}:${reason}`);
      diag.outlierReasons = existingReason;
    };

    for (let curveIndex = 0; curveIndex < usableCurves.length; curveIndex += 1) {
      const curve = usableCurves[curveIndex];
      for (let index = 1; index < curve.length - 1; index += 1) {
        const prev = Number(curve[index - 1]);
        const cur = Number(curve[index]);
        const next = Number(curve[index + 1]);
        if (!(Number.isFinite(prev) && Number.isFinite(cur) && Number.isFinite(next))) continue;
        const neighborMax = Math.max(prev, next);
        const neighborMin = Math.min(prev, next);
        const neighborSpread = Math.abs(prev - next);
        const isolatedPeak = (cur - neighborMax) > 0.18 && neighborSpread <= 0.04;
        const isolatedDip = (neighborMin - cur) > 0.18 && neighborSpread <= 0.04;
        if (!(isolatedPeak || isolatedDip)) continue;
        curve[index] = Number.NaN;
        annotateSuppressed(index, isolatedPeak ? "single-point-peak" : "single-point-dip", curveIndex);
        suppressed += 1;
      }
    }
    return suppressed;
  };

  const syntheticXAxis = Array.from({ length: steps }, (_, i) => {
    if (steps <= 1) return fieldMin;
    const t = i / (steps - 1);
    return fieldMin + t * (fieldMax - fieldMin);
  });

  const wavelengths = (() => {
    const out = (Array.isArray(payload?.wavelengths) ? payload.wavelengths : [])
      .map((w) => Number(w))
      .filter((w) => Number.isFinite(w) && w > 0);
    if (out.length > 0) return out;
    return [getPrimaryWavelengthUm(sourceRows as any[], 0.5876)];
  })();

  const cloneObjectRowsForCall = (rows: any[]): any[] => rows.map((r: any) => {
    try { return JSON.parse(JSON.stringify(r)); } catch (_) { return { ...(r || {}) }; }
  });

  const isImageHeightObject = (index: number): boolean => {
    const row = normalizedInputObjectRows[Math.max(0, Math.min(index, normalizedInputObjectRows.length - 1))] as any;
    const position = String(row?.__cooptOriginalPosition ?? row?.position ?? row?.object ?? row?.objectType ?? "").trim().toLowerCase();
    return position === "imageheight";
  };

  const getFieldValueFromObjectRow = (row: any): number => {
    const setting = buildTransverseFieldSettingsFromObjectRows([row])?.[0] || {};
    const raw = axisMode === "angle"
      ? Number(setting?.yFieldAngle ?? setting?.fieldAngle)
      : Number(setting?.yHeight);
    return Number.isFinite(raw) ? raw : 0;
  };

  const buildObjectRowSamples = async (wavelengthUm: number): Promise<Array<{ fieldValue: number; objectRowIndex: number; objectRowsForCall: any[]; fieldVector: { x: number; y: number } }>> => {
    const normalizedRows = await normalizeTransverseObjectRowsForImageHeight(
      opticalSystemRows,
      sourceRows,
      normalizedInputObjectRows,
      wavelengthUm,
    );
    if (normalizedRows.length === 0) {
      return syntheticXAxis.map((fieldValue) => ({
        fieldValue,
        objectRowIndex: 0,
        objectRowsForCall: cloneObjectRowsForCall(cloneObjectRowsForField(fieldValue, wavelengthUm, axisMode, 0)),
        fieldVector: { x: 0, y: fieldValue },
      }));
    }
    return normalizedRows
      .map((row, index) => {
        const sourceRow = normalizedInputObjectRows[index] && typeof normalizedInputObjectRows[index] === "object"
          ? normalizedInputObjectRows[index]
          : row;
        const sourcePosNorm = String((sourceRow as any)?.position ?? (sourceRow as any)?.object ?? (sourceRow as any)?.objectType ?? "").trim().toLowerCase();
        const imageHeightFieldX = Number(
          (sourceRow as any)?.__cooptImageHeightTarget?.x
          ?? (sourceRow as any)?.xHeight
          ?? (sourceRow as any)?.x
          ?? (sourceRow as any)?.["object x"]
          ?? 0,
        ) || 0;
        const imageHeightFieldY = Number(
          (sourceRow as any)?.__cooptImageHeightTarget?.y
          ?? (sourceRow as any)?.yHeight
          ?? (sourceRow as any)?.y
          ?? (sourceRow as any)?.["object y"]
          ?? 0,
        ) || 0;
        const fieldValue = axisMode === "height" && sourcePosNorm === "imageheight"
          ? imageHeightFieldY
          : getFieldValueFromObjectRow(row);
        const fieldX = axisMode === "height" && sourcePosNorm === "imageheight"
          ? imageHeightFieldX
          : (Number((row as any)?.__cooptImageHeightTarget?.x ?? (row as any)?.xHeight ?? (row as any)?.x ?? (row as any)?.xHeightAngle ?? 0) || 0);
        const fieldY = axisMode === "height" && sourcePosNorm === "imageheight"
          ? imageHeightFieldY
          : (Number((row as any)?.__cooptImageHeightTarget?.y ?? (row as any)?.yHeight ?? (row as any)?.y ?? (row as any)?.yHeightAngle ?? fieldValue) || fieldValue);
        return {
          fieldValue,
          objectRowIndex: index,
          objectRowsForCall: cloneObjectRowsForCall(normalizedRows),
          fieldVector: { x: fieldX, y: fieldY },
        };
      })
      .filter((sample) => Number.isFinite(sample.fieldValue))
      .sort((a, b) => a.fieldValue - b.fieldValue || a.objectRowIndex - b.objectRowIndex);
  };

  const objectRowSamples = sampleFromObjectRows
    ? await buildObjectRowSamples(wavelengths[0])
    : [];
  const xAxis = sampleFromObjectRows ? syntheticXAxis : syntheticXAxis;

  const resampleCurveOntoXAxis = (sourceAxis: number[], sourceValues: number[], targetAxis: number[]): number[] => {
    if (!Array.isArray(sourceAxis) || !Array.isArray(sourceValues) || sourceAxis.length === 0 || sourceAxis.length !== sourceValues.length) {
      return targetAxis.map(() => Number.NaN);
    }
    return targetAxis.map((target) => interpolateAxisValue(sourceAxis, sourceValues, target));
  };

  let imageHeightConjugateType: "finite" | "infinite" | null = null;
  let convertImageHeightToEffectiveObjectFn: null | ((obj: any, opticalRows: any[], wavelengthUm: number, conjugateType: "finite" | "infinite") => any) = null;
  if (hasImageHeightObjectRows) {
    const [{ detectConjugateType }, { convertImageHeightToEffectiveObject }] = await Promise.all([
      import("../../../utils/conjugate-detection.ts"),
      import("../../../optical/ray-renderer.ts"),
    ]);
    imageHeightConjugateType = String(detectConjugateType(opticalSystemRows) || "").toLowerCase() === "finite"
      ? "finite"
      : "infinite";
    convertImageHeightToEffectiveObjectFn = convertImageHeightToEffectiveObject;
  }

  const cloneObjectRowsForField = (fieldValue: number, wavelengthUm?: number, axisModeOverride: "angle" | "height" = axisMode, targetObjectIndex: number = objectIndex): any[] => {
    const cloned = Array.isArray(normalizedInputObjectRows)
      ? normalizedInputObjectRows.map((r: any) => {
          try { return JSON.parse(JSON.stringify(r)); } catch (_) { return { ...(r || {}) }; }
        })
      : [];
    if (!cloned.length) {
      cloned.push(axisModeOverride === "angle"
        ? { name: "AutoField0", position: "Angle", xHeightAngle: 0, yHeightAngle: fieldValue, x: 0, y: fieldValue }
        : { name: "AutoField0", position: "Rectangle", xHeight: 0, yHeight: fieldValue, x: 0, y: fieldValue });
    }
    const idx = Math.max(0, Math.min(targetObjectIndex, cloned.length - 1));
    const row: any = cloned[idx] && typeof cloned[idx] === "object" ? cloned[idx] : {};
    const sourceRow: any = normalizedInputObjectRows[idx] && typeof normalizedInputObjectRows[idx] === "object" ? normalizedInputObjectRows[idx] : row;
    const originalPosNorm = String(sourceRow?.__cooptOriginalPosition ?? sourceRow?.position ?? sourceRow?.object ?? sourceRow?.objectType ?? "").trim().toLowerCase();
    const useImageHeight = axisModeOverride === "height"
      && originalPosNorm === "imageheight"
      && !!convertImageHeightToEffectiveObjectFn
      && !!imageHeightConjugateType;
    if (axisModeOverride === "angle") {
      row.position = "Angle";
      row.xHeightAngle = 0;
      row.yHeightAngle = fieldValue;
      row.x = 0;
      row.y = fieldValue;
    } else if (useImageHeight) {
      const imageHeightRow = {
        ...row,
        position: "ImageHeight",
        objectType: "ImageHeight",
        xHeightAngle: 0,
        yHeightAngle: fieldValue,
        x: 0,
        y: fieldValue,
        __cooptOriginalPosition: sourceRow?.position ?? sourceRow?.object ?? sourceRow?.objectType ?? "ImageHeight",
      };
      try {
        const effective = convertImageHeightToEffectiveObjectFn!(imageHeightRow, opticalSystemRows, Number.isFinite(Number(wavelengthUm)) ? Number(wavelengthUm) : wavelengths[0], imageHeightConjugateType!);
        if (effective && typeof effective === "object") {
          cloned[idx] = {
            ...imageHeightRow,
            ...effective,
            __cooptOriginalPosition: imageHeightRow.__cooptOriginalPosition,
          };
          return cloned;
        }
      } catch (_) {
        // Fall back to finite-height approximation below if exact conversion fails.
      }
      row.position = "Rectangle";
      row.xHeight = 0;
      row.yHeight = fieldValue;
      row.x = 0;
      row.y = fieldValue;
    } else {
      row.position = "Rectangle";
      row.xHeight = 0;
      row.yHeight = fieldValue;
      row.x = 0;
      row.y = fieldValue;
    }
    cloned[idx] = row;
    return cloned;
  };

  const shouldRetryWithStop = (message: unknown): boolean => {
    return /entrance.*fail|entrance pupil|entrance unreachable|No valid OPD samples|trace to eval failed/i.test(String(message || ""));
  };

  const summarizeOpdCoverage = (response: any): { hitRate: number; hitCount: number; sampleCount: number } => {
    const sampleCount = Number(response?.sampleCount || 0);
    const hitCount = Number(response?.hitCount || 0);
    const hitRate = sampleCount > 0 ? (hitCount / sampleCount) : 0;
    return { hitRate, hitCount, sampleCount };
  };

  const isSparseOpdResponse = (response: any): boolean => {
    const { hitRate, hitCount, sampleCount } = summarizeOpdCoverage(response);
    if (!(sampleCount > 0) || !(hitCount > 0)) return true;
    if (hitRate < 0.05) return true;
    if (hitRate < 0.12 && hitCount < 4096) return true;
    return false;
  };

  const withCoverageNote = (response: any, label: string): any => {
    if (!response || typeof response !== "object") return response;
    const { hitRate, hitCount, sampleCount } = summarizeOpdCoverage(response);
    return {
      ...response,
      message: `${String(response?.message || "")}${response?.message ? " | " : ""}${label} (hit-rate=${hitRate.toFixed(3)}, hits=${hitCount}, samples=${sampleCount})`,
    };
  };

  const runFieldOpdWithRetry = async ({
    wl,
    fieldValue,
    requestedObjectIndex,
    objectRowsOverride,
    fixedTargetSurfaceIndex,
    fixedPupilRadiusMm,
    runNativeOpdWasmJson,
  }: {
    wl: number;
    fieldValue: number;
    requestedObjectIndex?: number;
    objectRowsOverride?: any[];
    fixedTargetSurfaceIndex?: number;
    fixedPupilRadiusMm?: number;
    runNativeOpdWasmJson?: ((json: string) => unknown) | null;
  }): Promise<{ response: any | null; errorMessage: string }> => {
    const activeObjectIndex = Number.isFinite(Number(requestedObjectIndex)) ? Math.max(0, Math.floor(Number(requestedObjectIndex))) : objectIndex;
    const executeOpd = async ({
      objectRowsForCall,
      pupilSamplingMode,
      pupilRadiusMm,
    }: {
      objectRowsForCall: any[];
      pupilSamplingMode?: "stop" | "entrance";
      pupilRadiusMm?: number;
    }): Promise<any> => {
      const req = {
        opticalSystemRows,
        sourceRows,
        objectRows: objectRowsForCall,
        objectIndex: activeObjectIndex,
        surfaceIndex: fixedTargetSurfaceIndex,
        gridSize: samplingSize,
        wavelengthUm: wl,
        pupilRadiusMm,
        pupilSamplingMode,
        opdDisplayMode,
      };
      if (runNativeOpdWasmJson) {
        const raw = runNativeOpdWasmJson(JSON.stringify(req));
        return (typeof raw === "string") ? JSON.parse(raw) : raw;
      }
      return await runNativeOpdMap(req as NativeOpdMapRequest);
    };

    const tryFieldModes = async ({
      objectRowsForCall,
      primaryMode,
      pupilRadiusMm,
    }: {
      objectRowsForCall: any[];
      primaryMode?: "stop" | "entrance";
      pupilRadiusMm?: number;
    }): Promise<{ response: any | null; errorMessage: string }> => {
      const errors: string[] = [];
      let bestSparseResponse: any = null;
      let bestSparseHitRate = -1;
      const trySingleMode = async (mode: "stop" | "entrance" | undefined): Promise<any | null> => {
        const label = mode || "auto";
        try {
          const response = await executeOpd({ objectRowsForCall, pupilSamplingMode: mode, pupilRadiusMm });
          if (!isSparseOpdResponse(response)) {
            return response;
          }
          const { hitRate } = summarizeOpdCoverage(response);
          const sparseResponse = withCoverageNote(response, `sparse ${label} OPD samples`);
          if (hitRate > bestSparseHitRate) {
            bestSparseHitRate = hitRate;
            bestSparseResponse = sparseResponse;
          }
          errors.push(`${label}=sparse(hitRate=${hitRate.toFixed(3)})`);
          return null;
        } catch (err: any) {
          errors.push(`${label}=${String(err?.message || err || "field failed")}`);
          return null;
        }
      };

      const primaryResponse = await trySingleMode(primaryMode);
      if (primaryResponse) {
        return { response: primaryResponse, errorMessage: "" };
      }

      if (!hasExplicitPupilSamplingMode) {
        const fallbackModes: Array<"entrance" | "stop"> = [];
        if (primaryMode === "entrance") {
          fallbackModes.push("stop");
        } else if (primaryMode === "stop") {
          fallbackModes.push("entrance");
        } else {
          fallbackModes.push("entrance", "stop");
        }
        if (primaryMode === "entrance" && errors.length > 0 && !shouldRetryWithStop(errors[0])) {
          fallbackModes.length = 0;
          fallbackModes.push("stop");
        }

        for (const fallbackMode of fallbackModes) {
          const fallbackResponse = await trySingleMode(fallbackMode);
          if (fallbackResponse) {
            return { response: fallbackResponse, errorMessage: "" };
          }
        }
      }

      if (bestSparseResponse) {
        return { response: bestSparseResponse, errorMessage: errors.join(" ; ") || "field sparse" };
      }

      return { response: null, errorMessage: errors.join(" ; ") || "field failed" };
    };

    const isZeroField = !(Math.abs(Number(fieldValue)) > 1e-12);
    const primaryObjectRows = Array.isArray(objectRowsOverride) && objectRowsOverride.length > 0
      ? objectRowsOverride
      : cloneObjectRowsForField(fieldValue, wl, axisMode, activeObjectIndex);
    const primaryMode = requestedPupilSamplingMode
      || (isImageHeightObject(activeObjectIndex) ? "entrance" : "stop");
    const primaryRadius = primaryMode === "entrance" ? fixedPupilRadiusMm : undefined;
    const primaryResult = await tryFieldModes({
      objectRowsForCall: primaryObjectRows,
      primaryMode,
      pupilRadiusMm: primaryRadius,
    });
    if (primaryResult.response) return primaryResult;

    if (axisMode === "angle" && isZeroField) {
      const finiteResult = await tryFieldModes({
        objectRowsForCall: cloneObjectRowsForField(0, wl, "height", activeObjectIndex),
        primaryMode: requestedPupilSamplingMode,
        pupilRadiusMm: undefined,
      });
      if (finiteResult.response) return finiteResult;

      return {
        response: null,
        errorMessage: [primaryResult.errorMessage, finiteResult.errorMessage].filter(Boolean).join(" ; ") || "field failed",
      };
    }

    return primaryResult;
  };

  const inferTanAxis = (fieldValue: number, fieldVector?: { x?: number; y?: number }): "x" | "y" => {
    const vx = Number(fieldVector?.x);
    const vy = Number(fieldVector?.y);
    if (Number.isFinite(vx) || Number.isFinite(vy)) {
      const ax = Math.abs(Number.isFinite(vx) ? vx : 0);
      const ay = Math.abs(Number.isFinite(vy) ? vy : 0);
      if (ax > ay) return "x";
      if (ay > ax) return "y";
    }
    return Math.abs(Number(fieldValue)) > 0 ? "y" : "x";
  };

  const computeFieldCurveSamples = async ({
    psfData,
    pixelSizeUm,
    fieldValue,
    fieldVector,
  }: {
    psfData: number[][];
    pixelSizeUm: number;
    fieldValue: number;
    fieldVector?: { x?: number; y?: number };
  }): Promise<{
    firstM: number;
    firstS: number;
    secondM: number;
    secondS: number;
    thirdM: number;
    thirdS: number;
    firstLo: number | null;
    firstHi: number | null;
    secondLo: number | null;
    secondHi: number | null;
    thirdLo: number | null;
    thirdHi: number | null;
  }> => {
    const maxTargetFrequencyLpmm = Math.max(0, Number(firstFrequencyLpmm) || 0, Number(secondFrequencyLpmm) || 0, Number(thirdFrequencyLpmm) || 0);
    const mtfMaxFrequencyLpmm = Math.max(1, maxTargetFrequencyLpmm * 2);
    const targetFreqs = [firstFrequencyLpmm, secondFrequencyLpmm, thirdFrequencyLpmm]
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 0);

    const mtfResp = await runNativeMtfMap({
      psfData,
      pixelSizeUm,
      maxFrequencyLpmm: mtfMaxFrequencyLpmm,
      points: 3,
      sampleFrequenciesLpmm: targetFreqs,
      directEvalOnly: true,
      method: mtfMethod as any,
    } as NativeMtfMapRequest);

    const freqAxis = Array.isArray((mtfResp as any)?.frequencyAxis) ? (mtfResp as any).frequencyAxis : [];
    const mtfTangential = Array.isArray((mtfResp as any)?.mtfTangential) ? (mtfResp as any).mtfTangential : [];
    const mtfSagittal = Array.isArray((mtfResp as any)?.mtfSagittal) ? (mtfResp as any).mtfSagittal : [];
    const sampledTangential = Array.isArray((mtfResp as any)?.sampledMtfTangential) ? (mtfResp as any).sampledMtfTangential : [];
    const sampledSagittal = Array.isArray((mtfResp as any)?.sampledMtfSagittal) ? (mtfResp as any).sampledMtfSagittal : [];
    const tanAxis = inferTanAxis(fieldValue, fieldVector);
    const tanVals = tanAxis === "x" ? mtfSagittal : mtfTangential;
    const sagVals = tanAxis === "x" ? mtfTangential : mtfSagittal;

    const hasDirectSamples = sampledTangential.length >= 3 && sampledSagittal.length >= 3;
    const firstM = hasDirectSamples
      ? (tanAxis === "x" ? Number(sampledSagittal[0]) : Number(sampledTangential[0]))
      : interpolateAxisValue(freqAxis, tanVals, firstFrequencyLpmm);
    const firstS = hasDirectSamples
      ? (tanAxis === "x" ? Number(sampledTangential[0]) : Number(sampledSagittal[0]))
      : interpolateAxisValue(freqAxis, sagVals, firstFrequencyLpmm);
    const secondM = hasDirectSamples
      ? (tanAxis === "x" ? Number(sampledSagittal[1]) : Number(sampledTangential[1]))
      : interpolateAxisValue(freqAxis, tanVals, secondFrequencyLpmm);
    const secondS = hasDirectSamples
      ? (tanAxis === "x" ? Number(sampledTangential[1]) : Number(sampledSagittal[1]))
      : interpolateAxisValue(freqAxis, sagVals, secondFrequencyLpmm);
    const thirdM = hasDirectSamples
      ? (tanAxis === "x" ? Number(sampledSagittal[2]) : Number(sampledTangential[2]))
      : interpolateAxisValue(freqAxis, tanVals, thirdFrequencyLpmm);
    const thirdS = hasDirectSamples
      ? (tanAxis === "x" ? Number(sampledTangential[2]) : Number(sampledSagittal[2]))
      : interpolateAxisValue(freqAxis, sagVals, thirdFrequencyLpmm);

    return {
      firstM,
      firstS,
      secondM,
      secondS,
      thirdM,
      thirdS,
      firstLo: findLowerBracketValue(freqAxis, firstFrequencyLpmm),
      firstHi: findUpperBracketValue(freqAxis, firstFrequencyLpmm),
      secondLo: findLowerBracketValue(freqAxis, secondFrequencyLpmm),
      secondHi: findUpperBracketValue(freqAxis, secondFrequencyLpmm),
      thirdLo: findLowerBracketValue(freqAxis, thirdFrequencyLpmm),
      thirdHi: findUpperBracketValue(freqAxis, thirdFrequencyLpmm),
    };
  };

  const maybeComputeIdealParaxialFieldCurveSamples = async ({
    displayOpdGrid,
    pupilMask,
    wavelengthUm,
    pixelSizeUm,
    fieldValue,
  }: {
    displayOpdGrid: Array<Array<number | null>>;
    pupilMask: boolean[][];
    wavelengthUm: number;
    pixelSizeUm: number;
    fieldValue: number;
  }): Promise<({
    firstM: number;
    firstS: number;
    secondM: number;
    secondS: number;
    thirdM: number;
    thirdS: number;
    firstLo: number | null;
    firstHi: number | null;
    secondLo: number | null;
    secondHi: number | null;
    thirdLo: number | null;
    thirdHi: number | null;
    wavefrontRms: number;
  }) | null> => {
    const wavefrontRms = computeFiniteGridRmsNativeLike(displayOpdGrid);
    const forceIdealParaxialMtf = isIdealParaxialOnlyNativeOpdSystem(opticalSystemRows)
      && opdDisplayMode !== "pistonTiltDefocusRemoved"
      && Number.isFinite(wavefrontRms)
      && wavefrontRms <= 2e-2;
    if (!forceIdealParaxialMtf) return null;

    const zeroOpdGrid = Array.from({ length: samplingSize }, () => Array.from({ length: samplingSize }, () => 0));
    const idealPsfResp = await runNativePsfMap({
      gridOpd: zeroOpdGrid,
      pupilMask,
      wavelengthUm,
      pixelSizeUm,
      removeTilt: false,
      zeroPadTo: requestedFftSize,
      recenterIfWrapped: false,
    } as NativePsfMapRequest);

    const samples = await computeFieldCurveSamples({
      psfData: (idealPsfResp as any)?.psfData,
      pixelSizeUm,
      fieldValue,
    });

    return {
      ...samples,
      wavefrontRms,
    };
  };

  const resolvePixelSizeUm = async (wl: number): Promise<number> => {
    const explicit = Number(payload?.pixelSizeUm);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;

    let pupilDiameterMm = Number.NaN;
    let focalLengthMm = Number.NaN;
    try {
      const { calculateImageSpaceDiffractionParams, calculateFocalLength, findStopSurfaceIndex } = await import("../../../raytracing/core/ray-paraxial.ts");
      const { derivePupilAndFocalLengthMmFromParaxial } = await import("../../../evaluation/spot-diagram.ts");

      const diffParams: any = calculateImageSpaceDiffractionParams(opticalSystemRows as any[], wl);
      const fWork = Number(diffParams?.fNumberWorking);
      const fl = Number(diffParams?.focalLengthMm);
      if (Number.isFinite(fl) && fl > 0 && Number.isFinite(fWork) && fWork > 0) {
        focalLengthMm = Math.abs(fl);
        pupilDiameterMm = focalLengthMm / fWork;
      }

      const derived: any = derivePupilAndFocalLengthMmFromParaxial(opticalSystemRows as any[], wl, true);
      const derivedPupilDiameterMm = Number(derived?.pupilDiameterMm);
      const derivedFocalLengthMm = Number(derived?.focalLengthMm);
      if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0) && Number.isFinite(derivedPupilDiameterMm) && derivedPupilDiameterMm > 0) {
        pupilDiameterMm = Math.abs(derivedPupilDiameterMm);
      }
      if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0) && Number.isFinite(derivedFocalLengthMm) && derivedFocalLengthMm > 0) {
        focalLengthMm = Math.abs(derivedFocalLengthMm);
      }

      if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0)) {
        const si = Number(findStopSurfaceIndex(opticalSystemRows as any[]));
        const stopRow: any = (Number.isFinite(si) && si >= 0) ? (opticalSystemRows as any[])[si] : null;
        const sdRaw = stopRow?.semidia ?? stopRow?.Semidia ?? stopRow?.["Semi Diameter"] ?? stopRow?.aperture ?? stopRow?.Aperture ?? Number.NaN;
        const sd = Math.abs(parseFloat(sdRaw));
        if (Number.isFinite(sd) && sd > 0) {
          const isApertureField = !!(stopRow && (stopRow.aperture !== undefined || stopRow.Aperture !== undefined));
          const stopRadiusMm = isApertureField ? (sd * 0.5) : sd;
          if (Number.isFinite(stopRadiusMm) && stopRadiusMm > 0) {
            pupilDiameterMm = stopRadiusMm * 2;
          }
        }
      }

      if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) {
        const fl2 = Number(calculateFocalLength(opticalSystemRows as any[], wl));
        if (Number.isFinite(fl2) && Math.abs(fl2) > 1e-9 && fl2 !== Infinity) {
          focalLengthMm = Math.abs(fl2);
        }
      }
    } catch (_) {
      // fallback below
    }

    if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) focalLengthMm = 100.0;
    if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0)) pupilDiameterMm = 10.0;
    const basePixelPitchUm = (wl * Math.abs(Number(focalLengthMm))) / Math.max(1e-12, Math.abs(Number(pupilDiameterMm)));
    return basePixelPitchUm * (samplingSize / requestedFftSize);
  };

  // Compute entrance pupil radius from paraxial data so every OPD call gets a correct
  // pupilRadiusMm from the start.  The Rust/WASM stop-mode over-estimates the stop radius
  // by ~2.6x (hitRate ≈ 0.15 for on-axis), producing a sparse OPD grid and a noisy PSF.
  // By passing the paraxial value the WASM uses it directly instead of its own estimate.
  const resolveEntrancePupilRadiusMm = async (wl: number): Promise<number> => {
    try {
      const { derivePupilAndFocalLengthMmFromParaxial } = await import("../../../evaluation/spot-diagram.ts");
      const derived: any = derivePupilAndFocalLengthMmFromParaxial(opticalSystemRows as any[], wl, true);
      const d = Number(derived?.pupilDiameterMm);
      if (Number.isFinite(d) && d > 0) return d / 2;
    } catch (_) {}
    try {
      const { calculateImageSpaceDiffractionParams } = await import("../../../raytracing/core/ray-paraxial.ts");
      const diffParams: any = calculateImageSpaceDiffractionParams(opticalSystemRows as any[], wl);
      const fWork = Number(diffParams?.fNumberWorking);
      const fl = Number(diffParams?.focalLengthMm);
      if (Number.isFinite(fl) && fl > 0 && Number.isFinite(fWork) && fWork > 0) {
        return Math.abs(fl) / (2 * fWork);
      }
    } catch (_) {}
    return Number.NaN;
  };

  // Try direct Rust/WASM field sweep first on desktop runtime.
  // On Web this path is usually slower than the legacy route, so skip it.
  if (!preferSharedFieldMtfRoute && isTauriRuntime()) {
  try {
    const { preloadRustRayTracingWasm } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
    const rust = await preloadRustRayTracingWasm();
    const runNativeOpdWasm = (typeof (rust as any)?.run_native_opd_map_wasm_json === "function")
      ? (rust as any).run_native_opd_map_wasm_json
      : null;
    const runNativePsfWasm = (typeof (rust as any)?.run_native_psf_from_opd_wasm_json === "function")
      ? (rust as any).run_native_psf_from_opd_wasm_json
      : null;
    const runNativeMtfWasm = (typeof (rust as any)?.run_native_mtf_from_psf_wasm_json === "function")
      ? (rust as any).run_native_mtf_from_psf_wasm_json
      : null;

    if (runNativeOpdWasm && runNativePsfWasm && runNativeMtfWasm) {
      const series: any[] = [];
      const totalPoints = Math.max(1, wavelengths.length * xAxis.length);
      let completedPoints = 0;

      for (const wl of wavelengths) {
        const activeSamples = sampleFromObjectRows ? await buildObjectRowSamples(wl) : xAxis.map((fieldValue) => ({ fieldValue, objectRowIndex: objectIndex, objectRowsForCall: [] as any[], fieldVector: { x: 0, y: fieldValue } }));
        const sampleAxis = sampleFromObjectRows ? activeSamples.map((sample) => sample.fieldValue) : xAxis.slice();
        const meridionalFirstRaw: number[] = [];
        const sagittalFirstRaw: number[] = [];
        const meridionalSecondRaw: number[] = [];
        const sagittalSecondRaw: number[] = [];
        const meridionalThirdRaw: number[] = [];
        const sagittalThirdRaw: number[] = [];
        const fieldDiagnostics: any[] = [];
        const pixelSizeUm = await resolvePixelSizeUm(wl);

        let fixedTargetSurfaceIndex: number | undefined = undefined;
        // Pre-initialize from paraxial so every field (including on-axis) gets a
        // stable entrance pupil estimate before the anchor call. Object-row
        // sampling needs the same radius; otherwise off-axis fields often fall
        // back to sparse OPD grids and collapse the MTF curve toward zero.
        const paraxialPupilRadiusMm = await resolveEntrancePupilRadiusMm(wl);
        let fixedPupilRadiusMm: number | undefined = (Number.isFinite(paraxialPupilRadiusMm) && paraxialPupilRadiusMm > 0)
          ? paraxialPupilRadiusMm
          : undefined;
        // Choose an anchor field with the largest |value| so the entrance pupil
        // radius is well-defined. On-axis (0 deg) is degenerate for entrance
        // sampling and must not be used as anchor.
        const anchorIndex = (() => {
          let idx = -1;
          let best = 0;
          for (let i = 0; i < activeSamples.length; i++) {
            const v = Math.abs(Number(activeSamples[i]?.fieldValue));
            if (Number.isFinite(v) && v > best) { best = v; idx = i; }
          }
          return idx;
        })();
        const defaultPupilSamplingMode = requestedPupilSamplingMode
          || (isImageHeightObject(objectIndex) ? "entrance" : "stop");
        const shouldAnchorEntranceRadius = defaultPupilSamplingMode === "entrance" && anchorIndex >= 0;
        try {
          const anchorSample = anchorIndex >= 0 ? activeSamples[anchorIndex] : null;
          const anchorFieldValue = anchorSample ? Number(anchorSample.fieldValue) : 0;
          const anchorObjectRows = anchorSample && anchorSample.objectRowsForCall.length > 0
            ? anchorSample.objectRowsForCall
            : cloneObjectRowsForField(anchorFieldValue, wl, axisMode, anchorSample?.objectRowIndex ?? objectIndex);
          const anchorPupilSamplingMode = defaultPupilSamplingMode;
          const anchorRaw = runNativeOpdWasm(JSON.stringify({
            opticalSystemRows,
            sourceRows,
            objectRows: anchorObjectRows,
            objectIndex: anchorSample?.objectRowIndex ?? objectIndex,
            surfaceIndex: undefined,
            gridSize: samplingSize,
            wavelengthUm: wl,
            pupilSamplingMode: anchorPupilSamplingMode,
            opdDisplayMode,
          }));
          const anchorOpdResp: any = (typeof anchorRaw === "string") ? JSON.parse(anchorRaw) : anchorRaw;
          const anchorTargetSurface = Number(anchorOpdResp?.targetSurface);
          if (Number.isFinite(anchorTargetSurface)) fixedTargetSurfaceIndex = anchorTargetSurface;
          const anchorEffectiveRadius = Number(anchorOpdResp?.effectivePupilRadiusMm);
          if (shouldAnchorEntranceRadius && Number.isFinite(anchorEffectiveRadius) && anchorEffectiveRadius > 0) {
            fixedPupilRadiusMm = anchorEffectiveRadius;
          }
        } catch (_) {
          // keep sweep without fixed anchor
        }

        for (let fieldIndex = 0; fieldIndex < activeSamples.length; fieldIndex++) {
          const sample = activeSamples[fieldIndex];
          const fieldValue = sample.fieldValue;
          const overallIndex = completedPoints + 1;
          if (onProgress) {
            const pct = 5 + (overallIndex / totalPoints) * 90;
            const unit = axisMode === "height" ? "mm" : "deg";
            onProgress({
              percent: Math.max(5, Math.min(95, pct)),
              message: `Computing Object MTF: λ=${(wl * 1000).toFixed(1)}nm, point ${fieldIndex + 1}/${activeSamples.length} (${Number(fieldValue).toFixed(3)} ${unit})`,
            });
            await maybeYieldForProgressPaint();
          }

          let firstM = Number.NaN, firstS = Number.NaN, secondM = Number.NaN, secondS = Number.NaN, thirdM = Number.NaN, thirdS = Number.NaN;
          let opdRespAny: any = {};
          try {
            const opdResult = await runFieldOpdWithRetry({
              wl,
              fieldValue,
              requestedObjectIndex: sample.objectRowIndex,
              objectRowsOverride: sample.objectRowsForCall,
              fixedTargetSurfaceIndex,
              fixedPupilRadiusMm,
              runNativeOpdWasmJson: runNativeOpdWasm,
            });
            if (!opdResult.response) {
              throw new Error(opdResult.errorMessage || "field failed");
            }
            const opdResp: any = opdResult.response;
            opdRespAny = opdResp;

            const psfRaw = runNativePsfWasm(JSON.stringify({
              rawOpdGrid: opdResp?.rawOpdGrid,
              displayOpdGrid: opdResp?.displayOpdGrid,
              wavelengthUm: wl,
              pixelSizeUm,
              removeTilt: false,
              zeroPadTo: requestedFftSize,
            }));
            const psfResp: any = (typeof psfRaw === "string") ? JSON.parse(psfRaw) : psfRaw;

            const samples = await computeFieldCurveSamples({
              psfData: psfResp?.psfData,
              pixelSizeUm,
              fieldValue,
              fieldVector: sample.fieldVector,
            });
            firstM = samples.firstM;
            firstS = samples.firstS;
            secondM = samples.secondM;
            secondS = samples.secondS;
            thirdM = samples.thirdM;
            thirdS = samples.thirdS;
          } catch (fieldErr: any) {
            opdRespAny = { error: String(fieldErr?.message || fieldErr || "field failed") };
          }

          meridionalFirstRaw.push(Number.isFinite(firstM) ? firstM : Number.NaN);
          sagittalFirstRaw.push(Number.isFinite(firstS) ? firstS : Number.NaN);
          meridionalSecondRaw.push(Number.isFinite(secondM) ? secondM : Number.NaN);
          sagittalSecondRaw.push(Number.isFinite(secondS) ? secondS : Number.NaN);
          meridionalThirdRaw.push(Number.isFinite(thirdM) ? thirdM : Number.NaN);
          sagittalThirdRaw.push(Number.isFinite(thirdS) ? thirdS : Number.NaN);

          const sampleCount = Number(opdRespAny?.sampleCount || 0);
          const hitCount = Number(opdRespAny?.hitCount || 0);
          fieldDiagnostics.push({
            fieldValue,
            effectivePupilSamplingMode: String(opdRespAny?.pupilSamplingMode || ""),
            effectivePupilRadiusMm: Number(opdRespAny?.effectivePupilRadiusMm),
            usedObjectPosition: String(opdRespAny?.usedObjectPosition || ""),
            targetSurfaceIndex: Number(opdRespAny?.targetSurface),
            usedObjectIndex: Number(opdRespAny?.usedObjectIndex),
            opdSampleCount: sampleCount,
            opdHitCount: hitCount,
            opdHitRate: sampleCount > 0 ? (hitCount / sampleCount) : 0,
            opdMessage: String(opdRespAny?.message || opdRespAny?.error || ""),
            firstFrequencyLpmm,
            firstValueMeridional: firstM,
            firstValueSagittal: firstS,
            secondFrequencyLpmm,
            secondValueMeridional: secondM,
            secondValueSagittal: secondS,
          });

          completedPoints += 1;
        }

        const meridionalFirst = sampleFromObjectRows ? resampleCurveOntoXAxis(sampleAxis, meridionalFirstRaw, xAxis) : meridionalFirstRaw;
        const sagittalFirst = sampleFromObjectRows ? resampleCurveOntoXAxis(sampleAxis, sagittalFirstRaw, xAxis) : sagittalFirstRaw;
        const meridionalSecond = sampleFromObjectRows ? resampleCurveOntoXAxis(sampleAxis, meridionalSecondRaw, xAxis) : meridionalSecondRaw;
        const sagittalSecond = sampleFromObjectRows ? resampleCurveOntoXAxis(sampleAxis, sagittalSecondRaw, xAxis) : sagittalSecondRaw;
        const meridionalThird = sampleFromObjectRows ? resampleCurveOntoXAxis(sampleAxis, meridionalThirdRaw, xAxis) : meridionalThirdRaw;
        const sagittalThird = sampleFromObjectRows ? resampleCurveOntoXAxis(sampleAxis, sagittalThirdRaw, xAxis) : sagittalThirdRaw;

        if (!sampleFromObjectRows) {
          suppressFieldCurveOutliersInPlace({
            diagnostics: fieldDiagnostics,
            curves: [meridionalFirst, sagittalFirst, meridionalSecond, sagittalSecond, meridionalThird, sagittalThird],
          });
        }

        series.push({
          wavelengthUm: wl,
          label: `${(wl * 1000).toFixed(1)}nm`,
          meridionalFirst,
          sagittalFirst,
          meridionalSecond,
          sagittalSecond,
          meridionalThird,
          sagittalThird,
          fieldDiagnostics,
        });

        if (!sampleFromObjectRows) {
          fillNaNGapsInPlace(meridionalFirst);
          fillNaNGapsInPlace(sagittalFirst);
          fillNaNGapsInPlace(meridionalSecond);
          fillNaNGapsInPlace(sagittalSecond);
          fillNaNGapsInPlace(meridionalThird);
          fillNaNGapsInPlace(sagittalThird);
        }
      }

      return {
        backend: isTauriRuntime() ? "tauri-rust-wasm-field-mtf" : "web-rust-wasm-field-mtf",
        xAxis,
        axisMode,
        series,
        message: "Object MTF computed via Rust/WASM OPD-PSF-MTF pipeline",
      };
    }
  } catch (_) {
    // Keep platform fallback below.
  }
  }

  // Reuse the TF-MTF batch kernel for browser Object MTF. Each field sample is
  // an independent OPD -> PSF -> direct-frequency MTF job, so Rayon can work
  // across fields and the JS/WASM boundary is crossed once per wavelength.
  const batchCompatibleMtfMethod = ["hopkins-tcc", "hopkins", "auto"].includes(mtfMethod.toLowerCase());
  if (!isTauriRuntime() && batchCompatibleMtfMethod && !isIdealParaxialOnlyNativeOpdSystem(opticalSystemRows)) {
    try {
      const batchSeries: any[] = [];
      const targetFrequencies = [firstFrequencyLpmm, secondFrequencyLpmm, thirdFrequencyLpmm]
        .map((frequency) => Number(frequency))
        .filter((frequency) => Number.isFinite(frequency) && frequency >= 0);
      const maxFrequencyLpmm = Math.max(1, ...targetFrequencies) * 2;

      for (const wl of wavelengths) {
        const activeSamples = sampleFromObjectRows
          ? await buildObjectRowSamples(wl)
          : xAxis.map((fieldValue) => ({
            fieldValue,
            objectRowIndex: objectIndex,
            objectRowsForCall: cloneObjectRowsForCall(cloneObjectRowsForField(fieldValue, wl, axisMode, objectIndex)),
            fieldVector: { x: 0, y: fieldValue },
          }));
        const batchPixelSizeUm = await resolvePixelSizeUm(wl);
        const regularMtfSurfaceIndex = (() => {
          let imageIndex = -1;
          for (let index = 0; index < opticalSystemRows.length; index += 1) {
            const row = opticalSystemRows[index] || {};
            const objectType = String(
              row?.["object type"] ?? row?.object ?? row?.Object ?? row?.position ?? "",
            ).trim().toLowerCase();
            if (objectType === "image") imageIndex = index;
          }
          return imageIndex >= 0 ? imageIndex : Math.max(0, opticalSystemRows.length - 1);
        })();
        const validatedChiefRays = await Promise.all(activeSamples.map(async (sample) => {
          if (axisMode !== "angle" || Math.abs(Number(sample.fieldValue)) <= 1e-12) return null;
          try {
            const { generateRayStartPointsForObject } = await import("../../../optical/ray-renderer.ts");
            const selectedObject = sample.objectRowsForCall?.[sample.objectRowIndex]
              || sample.objectRowsForCall?.[0]
              || {};
            const chiefRays = generateRayStartPointsForObject(
              selectedObject,
              opticalSystemRows,
              3,
              null,
              {
                pattern: "annular",
                wavelengthUm: wl,
                aimThroughStop: true,
                useChiefRayAnalysis: true,
                allowStopBasedOriginSolve: true,
                originSolveTraceBackend: "rust",
                strictChiefDirectionSolve: true,
                targetSurfaceIndex: regularMtfSurfaceIndex,
              },
            ) as any;
            const origin = chiefRays?.expectedChiefOrigin ?? chiefRays?.[0]?.startP;
            const direction = chiefRays?.expectedChiefDir ?? chiefRays?.[0]?.dir;
            if (![origin?.x, origin?.y, origin?.z, direction?.x, direction?.y, direction?.z]
              .every((value) => Number.isFinite(Number(value)))) {
              return null;
            }
            return {
              origin: { x: Number(origin.x), y: Number(origin.y), z: Number(origin.z) },
              direction: { x: Number(direction.x), y: Number(direction.y), z: Number(direction.z) },
            };
          } catch (_) {
            return null;
          }
        }));
        const jobs = activeSamples.map((sample, fieldIndex) => ({
          opdRequest: {
            sourceRows,
            objectRows: sample.objectRowsForCall,
            objectIndex: sample.objectRowIndex,
            // Match runDesktopNativeOpdMapForPopup, which fixes the image
            // evaluation surface for regular MTF.
            surfaceIndex: regularMtfSurfaceIndex,
            gridSize: samplingSize,
            wavelengthUm: wl,
            pupilSamplingMode: requestedPupilSamplingMode
              || (isImageHeightObject(sample.objectRowIndex) ? "entrance" : "stop"),
            chiefRayLaunchOrigin: validatedChiefRays[fieldIndex]?.origin,
            chiefRayLaunchDirection: validatedChiefRays[fieldIndex]?.direction,
            opdDisplayMode,
          },
          wavelengthUm: wl,
          pixelSizeUm: batchPixelSizeUm,
          zeroPadTo: requestedFftSize,
          removeTilt: false,
          maxFrequencyLpmm,
          sampleFrequenciesLpmm: targetFrequencies,
          directEvalOnly: true,
          points: targetFrequencies.length,
          slimResults: true,
          method: mtfMethod,
          meta: { fieldIndex, fieldValue: sample.fieldValue },
        }));

        if (onProgress) {
          onProgress({
            percent: 25,
            message: `Executing Object MTF batch (${jobs.length} fields)...`,
          });
        }
        const batchResp = await runMtfBatchViaWasmWorkerPool({
          jobs,
          shared: {
            opdRequest: {
              opticalSystemRows,
              sourceRows,
              objectRows: activeSamples[0]?.objectRowsForCall || objectRows,
              objectIndex,
              wavelengthUm: wl,
              surfaceIndex: regularMtfSurfaceIndex,
              gridSize: samplingSize,
              pupilSamplingMode: requestedPupilSamplingMode
                || (isImageHeightObject(objectIndex) ? "entrance" : "stop"),
              opdDisplayMode,
            },
          },
        });
        if (!Array.isArray(batchResp?.results) || batchResp.results.length !== jobs.length) {
          throw new Error(`Object MTF batch returned ${batchResp?.results?.length || 0}/${jobs.length} results`);
        }

        const resultByField = new Map<number, any>();
        for (const result of batchResp.results) {
          const fieldIndex = Number(result?.meta?.fieldIndex ?? result?.jobIndex);
          if (Number.isInteger(fieldIndex)) resultByField.set(fieldIndex, result);
        }
        const meridionalFirst: number[] = [];
        const sagittalFirst: number[] = [];
        const meridionalSecond: number[] = [];
        const sagittalSecond: number[] = [];
        const meridionalThird: number[] = [];
        const sagittalThird: number[] = [];
        const fieldDiagnostics: any[] = [];

        activeSamples.forEach((sample, fieldIndex) => {
          const result = resultByField.get(fieldIndex);
          const mtf = result?.mtf || {};
          const sampledTan = Array.isArray(mtf.sampledMtfTangential) ? mtf.sampledMtfTangential : [];
          const sampledSag = Array.isArray(mtf.sampledMtfSagittal) ? mtf.sampledMtfSagittal : [];
          const tanAxis = inferTanAxis(sample.fieldValue, sample.fieldVector);
          const tanValues = tanAxis === "x" ? sampledSag : sampledTan;
          const sagValues = tanAxis === "x" ? sampledTan : sampledSag;
          const valueAt = (values: any[], index: number) => {
            const value = Number(values[index]);
            return Number.isFinite(value) ? value : Number.NaN;
          };
          const firstM = valueAt(tanValues, 0);
          const firstS = valueAt(sagValues, 0);
          const secondM = valueAt(tanValues, 1);
          const secondS = valueAt(sagValues, 1);
          const thirdM = valueAt(tanValues, 2);
          const thirdS = valueAt(sagValues, 2);
          const opd = result?.opd || {};
          if (fieldIndex === 0 && Math.abs(Number(firstFrequencyLpmm) - 10) < 1e-9) {
            console.info("[Object MTF Compare] batch", {
              wavelengthUm: wl,
              fieldValue: sample.fieldValue,
              samplingSize,
              pixelSizeUm: batchPixelSizeUm,
              frequencyLpmm: targetFrequencies,
              tangentialAt10: firstM,
              sagittalAt10: firstS,
              opdBackend: result?.backend,
              opdTargetSurface: opd?.targetSurface,
              opdPupilSamplingMode: opd?.pupilSamplingMode,
              opdPupilRadiusMm: opd?.effectivePupilRadiusMm,
              opdHitRate: Number(opd?.sampleCount) > 0
                ? Number(opd?.hitCount || 0) / Number(opd?.sampleCount)
                : 0,
            });
          }
          meridionalFirst.push(firstM);
          sagittalFirst.push(firstS);
          meridionalSecond.push(secondM);
          sagittalSecond.push(secondS);
          meridionalThird.push(thirdM);
          sagittalThird.push(thirdS);
          const sampleCount = Number(opd.sampleCount || 0);
          const hitCount = Number(opd.hitCount || 0);
          fieldDiagnostics.push({
            fieldValue: sample.fieldValue,
            effectivePupilSamplingMode: String(opd.pupilSamplingMode || ""),
            effectivePupilRadiusMm: Number(opd.effectivePupilRadiusMm),
            usedObjectPosition: String(opd.usedObjectPosition || ""),
            targetSurfaceIndex: Number(opd.targetSurface),
            usedObjectIndex: Number(opd.usedObjectIndex),
            opdSampleCount: sampleCount,
            opdHitCount: hitCount,
            opdHitRate: sampleCount > 0 ? hitCount / sampleCount : 0,
            opdMessage: String(opd.message || "Computed via Object MTF batch"),
            firstFrequencyLpmm,
            firstValueMeridional: firstM,
            firstValueSagittal: firstS,
            secondFrequencyLpmm,
            secondValueMeridional: secondM,
            secondValueSagittal: secondS,
          });
        });

        if (!sampleFromObjectRows) {
          suppressFieldCurveOutliersInPlace({
            diagnostics: fieldDiagnostics,
            curves: [meridionalFirst, sagittalFirst, meridionalSecond, sagittalSecond, meridionalThird, sagittalThird],
          });
          fillNaNGapsInPlace(meridionalFirst);
          fillNaNGapsInPlace(sagittalFirst);
          fillNaNGapsInPlace(meridionalSecond);
          fillNaNGapsInPlace(sagittalSecond);
          fillNaNGapsInPlace(meridionalThird);
          fillNaNGapsInPlace(sagittalThird);
        }
        batchSeries.push({
          wavelengthUm: wl,
          label: `${(wl * 1000).toFixed(1)}nm`,
          meridionalFirst,
          sagittalFirst,
          meridionalSecond,
          sagittalSecond,
          meridionalThird,
          sagittalThird,
          fieldDiagnostics,
        });
      }

      if (onProgress) {
        onProgress({ percent: 100, message: "Object MTF batch computation complete" });
      }
      return {
        backend: "web-rust-wasm-object-mtf-batch",
        xAxis,
        axisMode,
        series: batchSeries,
        message: "Object MTF computed via Web Rust/WASM OPD-PSF-MTF batch API",
      };
    } catch (batchError) {
      console.warn("[Object MTF Batch] falling back to retry-capable field path", batchError);
    }
  }

  if (!isTauriRuntime()) {
    let runNativeOpdWasmDirect: ((json: string) => unknown) | null = null;
    // Pure paraxial/ThinLens systems must skip the raw WASM OPD path because the Rust fast path
    // does not apply the ideal thin-lens bend and returns incorrect (large) OPD values.
    // Force null so runFieldOpdWithRetry falls back to runNativeOpdMap which handles paraxial correctly.
    if (!preferSharedFieldMtfRoute && !isIdealParaxialOnlyNativeOpdSystem(opticalSystemRows)) try {
      const { preloadRustRayTracingWasm } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
      const rust = await preloadRustRayTracingWasm();
      const fn = (rust as any)?.run_native_opd_map_wasm_json;
      if (typeof fn === "function") runNativeOpdWasmDirect = fn;
    } catch (_) {
      runNativeOpdWasmDirect = null;
    }

    const series: any[] = [];
    const totalPoints = Math.max(1, wavelengths.length * xAxis.length);
    let completedPoints = 0;

    for (const wl of wavelengths) {
      const activeSamples = sampleFromObjectRows ? await buildObjectRowSamples(wl) : xAxis.map((fieldValue) => ({ fieldValue, objectRowIndex: objectIndex, objectRowsForCall: [] as any[], fieldVector: { x: 0, y: fieldValue } }));
      const sampleAxis = sampleFromObjectRows ? activeSamples.map((sample) => sample.fieldValue) : xAxis.slice();
      const meridionalFirstRaw: number[] = [];
      const sagittalFirstRaw: number[] = [];
      const meridionalSecondRaw: number[] = [];
      const sagittalSecondRaw: number[] = [];
      const meridionalThirdRaw: number[] = [];
      const sagittalThirdRaw: number[] = [];
      const fieldDiagnostics: any[] = [];
      const requestedPixelSizeUm = await resolvePixelSizeUm(wl);

      let fixedTargetSurfaceIndex: number | undefined = undefined;
      // Pre-initialize from paraxial so every field (including on-axis) gets a
      // stable entrance pupil estimate before the anchor call. Object-row
      // sampling needs the same radius; otherwise off-axis fields often fall
      // back to sparse OPD grids and collapse the MTF curve toward zero.
      const paraxialPupilRadiusMm = await resolveEntrancePupilRadiusMm(wl);
      let fixedPupilRadiusMm: number | undefined = (Number.isFinite(paraxialPupilRadiusMm) && paraxialPupilRadiusMm > 0)
        ? paraxialPupilRadiusMm
        : undefined;
      const anchorIndex = (() => {
        let idx = -1;
        let best = 0;
        for (let i = 0; i < activeSamples.length; i++) {
          const v = Math.abs(Number(activeSamples[i]?.fieldValue));
          if (Number.isFinite(v) && v > best) { best = v; idx = i; }
        }
        return idx;
      })();
      const shouldAnchorEntranceRadius =
        requestedPupilSamplingMode !== "stop"
        && anchorIndex >= 0;
      try {
        const anchorSample = anchorIndex >= 0 ? activeSamples[anchorIndex] : null;
        const anchorFieldValue = anchorSample ? Number(anchorSample.fieldValue) : 0;
        const anchorObjectRows = anchorSample && anchorSample.objectRowsForCall.length > 0
          ? anchorSample.objectRowsForCall
          : cloneObjectRowsForField(anchorFieldValue, wl, axisMode, anchorSample?.objectRowIndex ?? objectIndex);
        const anchorAutoMode = "entrance";
        const anchorPupilSamplingMode = requestedPupilSamplingMode || anchorAutoMode;
        const anchorOpdResp: any = await runNativeOpdMap({
          opticalSystemRows,
          sourceRows,
          objectRows: anchorObjectRows,
          objectIndex: anchorSample?.objectRowIndex ?? objectIndex,
          surfaceIndex: undefined,
          gridSize: samplingSize,
          wavelengthUm: wl,
          pupilSamplingMode: anchorPupilSamplingMode,
          opdDisplayMode,
        } as NativeOpdMapRequest);
        const anchorTargetSurface = Number(anchorOpdResp?.targetSurface);
        if (Number.isFinite(anchorTargetSurface)) fixedTargetSurfaceIndex = anchorTargetSurface;
        const anchorEffectiveRadius = Number(anchorOpdResp?.effectivePupilRadiusMm);
        if (shouldAnchorEntranceRadius && Number.isFinite(anchorEffectiveRadius) && anchorEffectiveRadius > 0) {
          fixedPupilRadiusMm = anchorEffectiveRadius;
        }
      } catch (_) {
        // Anchor is best-effort in web path.
      }

      for (let fieldIndex = 0; fieldIndex < activeSamples.length; fieldIndex++) {
        const sample = activeSamples[fieldIndex];
        const fieldValue = sample.fieldValue;
        const overallIndex = completedPoints + 1;
        if (onProgress) {
          const pct = 5 + (overallIndex / totalPoints) * 90;
          const unit = axisMode === "height" ? "mm" : "deg";
          onProgress({
            percent: Math.max(5, Math.min(95, pct)),
            message: `Computing Object MTF: λ=${(wl * 1000).toFixed(1)}nm, point ${fieldIndex + 1}/${activeSamples.length} (${Number(fieldValue).toFixed(3)} ${unit})`,
          });
          await maybeYieldForProgressPaint();
        }

        let firstM = Number.NaN;
        let firstS = Number.NaN;
        let secondM = Number.NaN;
        let secondS = Number.NaN;
        let thirdM = Number.NaN;
        let thirdS = Number.NaN;
        let firstLo: number | null = null;
        let firstHi: number | null = null;
        let secondLo: number | null = null;
        let secondHi: number | null = null;
        let thirdLo: number | null = null;
        let thirdHi: number | null = null;
        let opdRespAny: any = {};

        try {
          const opdResult = await runFieldOpdWithRetry({
            wl,
            fieldValue,
            requestedObjectIndex: sample.objectRowIndex,
            objectRowsOverride: sample.objectRowsForCall,
            fixedTargetSurfaceIndex,
            fixedPupilRadiusMm,
            runNativeOpdWasmJson: runNativeOpdWasmDirect,
          });
          if (!opdResult.response) {
            throw new Error(opdResult.errorMessage || "field failed");
          }
          const opdResp = opdResult.response as any;
          opdRespAny = opdResp as any;

          const s = samplingSize;
          const gridOpd = Array.from({ length: s }, () => Array.from({ length: s }, () => 0));
          const pupilMask = Array.from({ length: s }, () => Array.from({ length: s }, () => false));
          const displayOpdGrid = Array.isArray((opdResp as any)?.displayOpdGrid) ? (opdResp as any).displayOpdGrid : [];
          const rawOpdGrid = Array.isArray((opdResp as any)?.rawOpdGrid) ? (opdResp as any).rawOpdGrid : [];
          for (let iy = 0; iy < s; iy++) {
            const rowDisplay = displayOpdGrid[iy] || [];
            const rowRaw = rawOpdGrid[iy] || [];
            for (let ix = 0; ix < s; ix++) {
              const rawCell = rowRaw[ix];
              if (rawCell === null || rawCell === undefined || rawCell === "") continue;
              const vRawWaves = Number(rawCell);
              if (!Number.isFinite(vRawWaves)) continue;
              const displayCell = rowDisplay[ix];
              const vDisplayWaves = (displayCell === null || displayCell === undefined || displayCell === "") ? Number.NaN : Number(displayCell);
              const vWaves = Number.isFinite(vDisplayWaves) ? vDisplayWaves : vRawWaves;
              gridOpd[iy][ix] = vWaves * wl;
              pupilMask[iy][ix] = true;
            }
          }

          const psfResp = await runNativePsfMap({
            gridOpd,
            pupilMask,
            wavelengthUm: wl,
            pixelSizeUm: requestedPixelSizeUm,
            removeTilt: false,
            zeroPadTo: requestedFftSize,
            recenterIfWrapped: false,
          } as NativePsfMapRequest);

          const effectivePixelSizeUm = Number.isFinite(Number((psfResp as any)?.pixelSizeUm))
            ? Number((psfResp as any).pixelSizeUm)
            : requestedPixelSizeUm;

          const samples = await computeFieldCurveSamples({
            psfData: (psfResp as any)?.psfData,
            pixelSizeUm: effectivePixelSizeUm,
            fieldValue,
              fieldVector: sample.fieldVector,
          });
          firstM = samples.firstM;
          firstS = samples.firstS;
          secondM = samples.secondM;
          secondS = samples.secondS;
          thirdM = samples.thirdM;
          thirdS = samples.thirdS;
          firstLo = samples.firstLo;
          firstHi = samples.firstHi;
          secondLo = samples.secondLo;
          secondHi = samples.secondHi;
          thirdLo = samples.thirdLo;
          thirdHi = samples.thirdHi;

          const idealSamples = await maybeComputeIdealParaxialFieldCurveSamples({
            displayOpdGrid,
            pupilMask,
            wavelengthUm: wl,
            pixelSizeUm: effectivePixelSizeUm,
            fieldValue,
          });
          if (idealSamples) {
            firstM = idealSamples.firstM;
            firstS = idealSamples.firstS;
            secondM = idealSamples.secondM;
            secondS = idealSamples.secondS;
            thirdM = idealSamples.thirdM;
            thirdS = idealSamples.thirdS;
            firstLo = idealSamples.firstLo;
            firstHi = idealSamples.firstHi;
            secondLo = idealSamples.secondLo;
            secondHi = idealSamples.secondHi;
            thirdLo = idealSamples.thirdLo;
            thirdHi = idealSamples.thirdHi;
            opdRespAny = {
              ...(opdRespAny || {}),
              message: `${String(opdRespAny?.message || "")}${opdRespAny?.message ? " | " : ""}ideal-diffraction-override(rms=${idealSamples.wavefrontRms.toExponential(3)})`,
            };
          }
        } catch (fieldErr: any) {
          opdRespAny = { error: String(fieldErr?.message || fieldErr || "field failed") };
        }

        meridionalFirstRaw.push(Number.isFinite(firstM) ? firstM : Number.NaN);
        sagittalFirstRaw.push(Number.isFinite(firstS) ? firstS : Number.NaN);
        meridionalSecondRaw.push(Number.isFinite(secondM) ? secondM : Number.NaN);
        sagittalSecondRaw.push(Number.isFinite(secondS) ? secondS : Number.NaN);
        meridionalThirdRaw.push(Number.isFinite(thirdM) ? thirdM : Number.NaN);
        sagittalThirdRaw.push(Number.isFinite(thirdS) ? thirdS : Number.NaN);

        const sampleCount = Number(opdRespAny?.sampleCount || 0);
        const hitCount = Number(opdRespAny?.hitCount || 0);
        fieldDiagnostics.push({
          fieldValue,
          effectivePupilSamplingMode: String(opdRespAny?.pupilSamplingMode || ""),
          effectivePupilRadiusMm: Number(opdRespAny?.effectivePupilRadiusMm),
          usedObjectPosition: String(opdRespAny?.usedObjectPosition || ""),
          targetSurfaceIndex: Number(opdRespAny?.targetSurface),
          usedObjectIndex: Number(opdRespAny?.usedObjectIndex),
            requestedPixelSizeUm,
          opdSampleCount: sampleCount,
          opdHitCount: hitCount,
          opdHitRate: sampleCount > 0 ? (hitCount / sampleCount) : 0,
          opdMessage: String(opdRespAny?.message || opdRespAny?.error || ""),
          firstFrequencyLpmm,
            firstBracketLowLpmm: firstLo,
            firstBracketHighLpmm: firstHi,
          firstValueMeridional: firstM,
          firstValueSagittal: firstS,
          secondFrequencyLpmm,
            secondBracketLowLpmm: secondLo,
            secondBracketHighLpmm: secondHi,
          secondValueMeridional: secondM,
          secondValueSagittal: secondS,
        });

        completedPoints += 1;
      }

      const meridionalFirst = sampleFromObjectRows ? resampleCurveOntoXAxis(sampleAxis, meridionalFirstRaw, xAxis) : meridionalFirstRaw;
      const sagittalFirst = sampleFromObjectRows ? resampleCurveOntoXAxis(sampleAxis, sagittalFirstRaw, xAxis) : sagittalFirstRaw;
      const meridionalSecond = sampleFromObjectRows ? resampleCurveOntoXAxis(sampleAxis, meridionalSecondRaw, xAxis) : meridionalSecondRaw;
      const sagittalSecond = sampleFromObjectRows ? resampleCurveOntoXAxis(sampleAxis, sagittalSecondRaw, xAxis) : sagittalSecondRaw;
      const meridionalThird = sampleFromObjectRows ? resampleCurveOntoXAxis(sampleAxis, meridionalThirdRaw, xAxis) : meridionalThirdRaw;
      const sagittalThird = sampleFromObjectRows ? resampleCurveOntoXAxis(sampleAxis, sagittalThirdRaw, xAxis) : sagittalThirdRaw;

      if (!sampleFromObjectRows) {
        suppressFieldCurveOutliersInPlace({
          diagnostics: fieldDiagnostics,
          curves: [meridionalFirst, sagittalFirst, meridionalSecond, sagittalSecond, meridionalThird, sagittalThird],
        });

        fillNaNGapsInPlace(meridionalFirst);
        fillNaNGapsInPlace(sagittalFirst);
        fillNaNGapsInPlace(meridionalSecond);
        fillNaNGapsInPlace(sagittalSecond);
        fillNaNGapsInPlace(meridionalThird);
        fillNaNGapsInPlace(sagittalThird);
      }

      series.push({
        wavelengthUm: wl,
        label: `${(wl * 1000).toFixed(1)}nm`,
        meridionalFirst,
        sagittalFirst,
        meridionalSecond,
        sagittalSecond,
        meridionalThird,
        sagittalThird,
        fieldDiagnostics,
      });
    }

    return {
      backend: "web-field-mtf-direct",
      xAxis,
      axisMode,
      series,
      message: "Object MTF computed via direct OPD-PSF-MTF sweep (web)",
    };
  }

  return invokeCommand<NativeFieldMtfMapRequest, NativeFieldMtfMapResponse>(
    "run_native_field_mtf_map",
    payload,
  );
}

export async function runNativeDistortion(
  payload: NativeDistortionRequest,
): Promise<NativeDistortionResponse> {
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const forceWebQconFallback = hasQconSurfaceNativeLike(opticalSystemRows);
  if (!isTauriRuntime() || forceWebQconFallback) {
    const onProgress = typeof (payload as any)?.onProgress === "function"
      ? (payload as any).onProgress as ((evt: { percent?: number; message?: string }) => void)
      : null;
    const emitProgress = (percent: number, message: string) => {
      if (!onProgress) return;
      try {
        onProgress({
          percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined,
          message,
        });
      } catch {
        // Ignore progress callback failures.
      }
    };
    const toFiniteNumberOrNull = (value: unknown): number | null => {
      return (typeof value === "number" && Number.isFinite(value)) ? value : null;
    };
    const getSpotGravityYUm = (row: any): number | null => {
      const points = Array.isArray(row?.points) ? row.points : [];
      let sumY = 0;
      let count = 0;
      for (const p of points) {
        const y = Number(p?.yUm);
        if (!Number.isFinite(y)) continue;
        sumY += y;
        count += 1;
      }
      if (count > 0) return sumY / count;
      const chiefPointUm = row?.chiefPointUm;
      const yChief = Number(
        chiefPointUm && typeof chiefPointUm === "object"
          ? chiefPointUm.yUm
          : undefined,
      );
      return Number.isFinite(yChief) ? yChief : null;
    };
    const getSpotChiefYUm = (row: any): number | null => {
      const chiefPointUm = row?.chiefPointUm;
      const yChief = Number(
        chiefPointUm && typeof chiefPointUm === "object"
          ? chiefPointUm.yUm
          : undefined,
      );
      return Number.isFinite(yChief) ? yChief : null;
    };

    const fieldSamples = Array.isArray(payload?.fieldSamples)
      ? payload.fieldSamples.map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : [];
    if (opticalSystemRows.length === 0) {
      throw new Error("runNativeDistortion(web): opticalSystemRows is empty");
    }
    if (fieldSamples.length === 0) {
      throw new Error("runNativeDistortion(web): fieldSamples is empty");
    }

    const surfaceIndex = Number.isInteger(payload?.surfaceIndex)
      ? Math.max(0, Number(payload.surfaceIndex))
      : pickImageSurfaceIndexNativeLike(opticalSystemRows);
    const heightMode = payload?.heightMode === true;
    const distortionMetric = String((payload as any)?.distortionMetric || "").trim().toLowerCase() === "chief-ray"
      ? "chief-ray"
      : "spot-gravity";
    const getSpotDistortionYUm = (row: any): number | null => (
      distortionMetric === "chief-ray"
        ? getSpotChiefYUm(row)
        : getSpotGravityYUm(row)
    );
    const wavelength = Number.isFinite(Number(payload?.wavelength)) && Number(payload?.wavelength) > 0
      ? Number(payload.wavelength)
      : getPrimaryWavelengthUm(Array.isArray(payload?.sourceRows) ? payload.sourceRows : [], 0.5876);
    const sourceRowsRaw = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
    const sourceRows = buildDistortionSourceRowsForWavelength(sourceRowsRaw, wavelength);
    const sharedParaxialWavelength = getPrimaryWavelengthUm(sourceRowsRaw, wavelength);
    const sharedParaxialSourceRows = buildDistortionSourceRowsForWavelength(sourceRowsRaw, sharedParaxialWavelength);
    const inputObjectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
    const inputFieldMode = deriveGridFieldModeNativeLike(inputObjectRows);
    const distortionRayFanCount = 21;
    emitProgress(2, "Distortion: preparing...");

    // Distortion in web mode should prefer the dedicated native-like WASM path first.
    // If coverage is insufficient, we fall back to render-style spot tracing below.
    const preferRenderHighAngleRays = false;
    // The direct chief-ray API handles ImageHeight by converting each requested
    // image height to its paraxial field angle. Keep ImageHeight on this single,
    // continuity-aware path instead of mixing render-ray fallback branches.
    const allowDirectWasmDistortion = distortionMetric === "chief-ray";

    // Prefer direct distortion WASM export when available.
    let directWasmError: string | null = null;
    try {
      if (allowDirectWasmDistortion && !preferRenderHighAngleRays && !directDistortionWasmUnavailableInSession) {
        emitProgress(8, "Distortion: trying direct Rust/WASM distortion...");
        const { preloadRustRayTracingWasm } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
        const wasmApi = await preloadRustRayTracingWasm();
        if (wasmApi && typeof wasmApi.run_native_distortion_wasm_json === "function") {
          const wasmReq = {
            opticalSystemRows,
            sourceRows,
            objectRows: inputObjectRows,
            fieldSamples,
            surfaceIndex,
            heightMode,
            wavelength,
            distortionMetric,
          };
          const wasmRaw = wasmApi.run_native_distortion_wasm_json(JSON.stringify(wasmReq));
          const wasmResp = (typeof wasmRaw === "string") ? JSON.parse(wasmRaw) : wasmRaw;
          if (wasmResp && typeof wasmResp === "object") {
            const fieldValues = Array.isArray((wasmResp as any).fieldValues)
              ? (wasmResp as any).fieldValues.map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v))
              : fieldSamples;
            const idealHeights = Array.isArray((wasmResp as any).idealHeights)
              ? (wasmResp as any).idealHeights.map((v: any) => Number(v))
              : [];
            const realHeights = Array.isArray((wasmResp as any).realHeights)
              ? (wasmResp as any).realHeights.map((v: any) => toFiniteNumberOrNull(v))
              : [];
            const distortion = Array.isArray((wasmResp as any).distortion)
              ? (wasmResp as any).distortion.map((v: any) => toFiniteNumberOrNull(v))
              : [];
            const distortionPercent = Array.isArray((wasmResp as any).distortionPercent)
              ? (wasmResp as any).distortionPercent.map((v: any) => toFiniteNumberOrNull(v))
              : [];

            // Keep direct-WASM path active even if coverage is sparse.
            // We still report coverage for diagnostics, but do not force fallback.
            const pairCount = Math.min(fieldValues.length, distortionPercent.length);
            let finitePairCount = 0;
            for (let i = 0; i < pairCount; i += 1) {
              const y = fieldValues[i];
              const x = distortionPercent[i];
              if (Number.isFinite(y) && typeof x === "number" && Number.isFinite(x)) {
                finitePairCount += 1;
              }
            }
            const expectedPoints = Math.max(1, fieldSamples.length);
            const minimumFinitePairs = Math.min(expectedPoints, Math.max(3, Math.ceil(expectedPoints * 0.6)));
            const hasSparseCoverage = expectedPoints >= 3 && finitePairCount < minimumFinitePairs;
            // Skip sparse-coverage warning for tiny samples where coverage ratios are not meaningful.
            if (hasSparseCoverage) {
              try {
                const warnKey = `${expectedPoints}|${finitePairCount}|${minimumFinitePairs}`;
                if (!directDistortionSparseCoverageWarnedKeys.has(warnKey)) {
                  directDistortionSparseCoverageWarnedKeys.add(warnKey);
                  console.warn("runNativeDistortion(web): direct WASM sparse coverage", {
                    finitePairCount,
                    minimumFinitePairs,
                    expectedPoints,
                  });
                }
              } catch {
                // Ignore logging failures in restricted runtimes.
              }
            }

            // Only keep direct-WASM results when coverage is good enough.
            // Sparse coverage creates misleading plots, so we deliberately
            // continue to the spot-based fallback path.
            if (!hasSparseCoverage && finitePairCount > 0) {
              return {
                backend: String((wasmResp as any).backend || "web-rust-wasm"),
                fieldValues,
                idealHeights,
                realHeights,
                distortion,
                distortionPercent,
                meta: ((wasmResp as any).meta && typeof (wasmResp as any).meta === "object")
                  ? (wasmResp as any).meta
                  : {},
                message: String((wasmResp as any).message || "Computed via Web Rust/WASM distortion API"),
              };
            }

            if (allowDirectWasmDistortion) {
              const mergedFieldValues = [...fieldSamples];
              const mergedIdealHeights = fieldSamples.map((_, idx) => Number(idealHeights[idx]));
              const mergedRealHeights = fieldSamples.map((_, idx) => toFiniteNumberOrNull(realHeights[idx]));
              const mergedDistortion = fieldSamples.map((_, idx) => toFiniteNumberOrNull(distortion[idx]));
              const mergedDistortionPercent = fieldSamples.map((_, idx) => toFiniteNumberOrNull(distortionPercent[idx]));
              const unresolvedIndices = [] as number[];
              const pairCountForRecovery = mergedFieldValues.length;
              for (let i = 0; i < pairCountForRecovery; i += 1) {
                const y = mergedFieldValues[i];
                const x = mergedDistortionPercent[i];
                if (!(Number.isFinite(y) && typeof x === "number" && Number.isFinite(x))) {
                  unresolvedIndices.push(i);
                }
              }

              let perFieldRecoveryCount = 0;
              for (let i = 0; i < unresolvedIndices.length; i += 1) {
                const idx = unresolvedIndices[i];
                const sample = fieldSamples[idx];
                if (!Number.isFinite(Number(sample))) continue;
                try {
                  emitProgress(12 + (i / Math.max(1, unresolvedIndices.length)) * 36, "Distortion: recovering direct chief-ray fields...");
                  const oneReq = {
                    opticalSystemRows,
                    sourceRows,
                    objectRows: inputObjectRows,
                    fieldSamples: [sample],
                    surfaceIndex,
                    heightMode,
                    wavelength,
                    distortionMetric,
                  };
                  const oneRaw = wasmApi.run_native_distortion_wasm_json(JSON.stringify(oneReq));
                  const oneResp = (typeof oneRaw === "string") ? JSON.parse(oneRaw) : oneRaw;
                  const oneIdeal = Array.isArray((oneResp as any)?.idealHeights) ? Number((oneResp as any).idealHeights[0]) : Number.NaN;
                  const oneReal = Array.isArray((oneResp as any)?.realHeights) ? toFiniteNumberOrNull((oneResp as any).realHeights[0]) : null;
                  const oneDist = Array.isArray((oneResp as any)?.distortion) ? toFiniteNumberOrNull((oneResp as any).distortion[0]) : null;
                  const onePct = Array.isArray((oneResp as any)?.distortionPercent) ? toFiniteNumberOrNull((oneResp as any).distortionPercent[0]) : null;
                  if (Number.isFinite(oneIdeal)) mergedIdealHeights[idx] = oneIdeal;
                  mergedRealHeights[idx] = oneReal;
                  mergedDistortion[idx] = oneDist;
                  mergedDistortionPercent[idx] = onePct;
                  if (typeof onePct === "number" && Number.isFinite(onePct)) {
                    perFieldRecoveryCount += 1;
                  }
                } catch {
                  // Keep unresolved point as null.
                }
              }

              let recoveredFinitePairs = 0;
              const recoveredPairCount = mergedFieldValues.length;
              for (let i = 0; i < recoveredPairCount; i += 1) {
                const y = mergedFieldValues[i];
                const x = mergedDistortionPercent[i];
                if (Number.isFinite(y) && typeof x === "number" && Number.isFinite(x)) {
                  recoveredFinitePairs += 1;
                }
              }

              if (recoveredFinitePairs >= minimumFinitePairs) {
                return {
                  backend: "web-rust-wasm-native-distortion-api-chief-direct",
                  fieldValues: mergedFieldValues,
                  idealHeights: mergedIdealHeights,
                  realHeights: mergedRealHeights,
                  distortion: mergedDistortion,
                  distortionPercent: mergedDistortionPercent,
                  meta: {
                    ...(((wasmResp as any).meta && typeof (wasmResp as any).meta === "object") ? (wasmResp as any).meta : {}),
                    distortionDefinition: "chief-ray",
                    directChiefPerFieldRecoveryCount: perFieldRecoveryCount,
                    finitePairCount: recoveredFinitePairs,
                    minimumFinitePairs,
                    expectedPoints,
                  },
                  message: "Computed via direct chief-ray distortion API with per-field recovery",
                };
              }
            }

            directWasmError = hasSparseCoverage
              ? `direct WASM sparse coverage (finite=${finitePairCount}, minimum=${minimumFinitePairs}, expected=${expectedPoints})`
              : `direct WASM returned no finite distortion points (expectedPoints=${expectedPoints})`;
            try {
              console.warn("runNativeDistortion(web): direct WASM coverage insufficient, using spot fallback", {
                hasSparseCoverage,
                finitePairCount,
                minimumFinitePairs,
                expectedPoints,
              });
            } catch {
              // Ignore logging failures in restricted runtimes.
            }
          }
        }
      }
    } catch (_) {
      // Keep render-style spot fallback below for environments without direct distortion export.
      directWasmError = (_ instanceof Error) ? (_.message || String(_)) : String(_);
      if (directWasmError.includes("run_native_distortion_wasm_json") && directWasmError.includes("not a function")) {
        directDistortionWasmUnavailableInSession = true;
      }
      try {
        console.warn("runNativeDistortion(web): direct WASM path failed, using spot fallback", { error: directWasmError });
      } catch {
        // Ignore logging failures in restricted runtimes.
      }
    }

    const finiteSystem = isFiniteConjugateNativeLike(opticalSystemRows);
    const objectDistance = getObjectDistanceMmNativeLike(opticalSystemRows);
    let focalLength = Number.NaN;
    let magnification = -1;
    try {
      const paraxialResp = await runNativeParaxialMetrics({
        opticalSystemRows,
        sourceRows: sharedParaxialSourceRows,
        objectRows: inputObjectRows,
      });
      const efl = Number((paraxialResp as any)?.metrics?.EFL);
      const fl = Number((paraxialResp as any)?.metrics?.FL);
      const candidate = Number.isFinite(efl) && Math.abs(efl) > 1e-12 ? efl : fl;
      if (Number.isFinite(candidate) && Math.abs(candidate) > 1e-12) {
        focalLength = Math.abs(candidate);
      }
    } catch {
      // Keep invalid focalLength and throw below.
    }
    if (!(Number.isFinite(focalLength) && Math.abs(focalLength) > 1e-12)) {
      throw new Error("runNativeDistortion(web): failed to resolve paraxial focal length");
    }

    const computeParaxialIdealHeight = (sampleRaw: number): number => {
      const sample = Number(sampleRaw);
      if (!Number.isFinite(sample)) return Number.NaN;
      if (!heightMode) {
        const wParaxialRad = sample * Math.PI / 180;
        return focalLength * Math.tan(wParaxialRad);
      }
      const isImageHeightMode = inputFieldMode === "imageheight" || !finiteSystem;
      if (isImageHeightMode) {
        const wParaxialRad = Math.atan2(sample, focalLength);
        return focalLength * Math.tan(wParaxialRad);
      }
      const objectDistanceAbs = Math.abs(objectDistance);
      if (!(Number.isFinite(objectDistanceAbs) && objectDistanceAbs > 1e-12)) {
        return Number.NaN;
      }
      const wParaxialRad = Math.atan2(sample, objectDistanceAbs);
      return focalLength * Math.tan(wParaxialRad);
    };

    // For ImageHeight distortion, prefer a direct centerline reconstruction when
    // direct distortion coverage is sparse. This avoids unnecessary 2D grid work.
    const enableLegacyCenterlineSpotFallback = false;
    if (enableLegacyCenterlineSpotFallback && distortionMetric !== "chief-ray" && heightMode && inputFieldMode === "imageheight" && inputObjectRows.length > 0) {
      try {
        emitProgress(18, "Distortion: tracing ImageHeight centerline...");
        const centerlineObjectRows = fieldSamples.map((sample, index) => {
          const thetaRad = Math.atan2(Number(sample), focalLength);
          const thetaDeg = thetaRad * 180 / Math.PI;
          const objectDistanceAbs = Math.abs(objectDistance);
          if (finiteSystem && Number.isFinite(objectDistanceAbs) && objectDistanceAbs > 1e-12) {
            const objectY = objectDistanceAbs * Math.tan(thetaRad);
            return {
              id: `Field-${index}`,
              name: `Field-${index}`,
              position: "Rectangle",
              xHeight: 0,
              yHeight: objectY,
              x: 0,
              y: objectY,
            };
          }
          return {
          id: `Field-${index}`,
          name: `Field-${index}`,
          position: "Angle",
          xHeightAngle: 0,
          yHeightAngle: thetaDeg,
          x: 0,
          y: thetaDeg,
          };
        });

        emitProgress(52, "Distortion: tracing centerline rays...");
        const centerlineResp = await runNativeSpotRaytrace({
          opticalSystemRows,
          sourceRows,
          objectRows: centerlineObjectRows,
          surfaceIndex,
          rayCount: 11,
          ringCount: 1,
          pattern: "cross",
          wavelengthMode: "primary",
          forceRustWasm: true,
          strictChiefOnly: distortionMetric === "chief-ray",
        });

        const idealHeights = fieldSamples.map((sample) => computeParaxialIdealHeight(Number(sample)));
        const realHeights = new Array(fieldSamples.length).fill(null) as Array<number | null>;
        const centerlineSeries = Array.isArray(centerlineResp?.series) ? centerlineResp.series : [];
        for (const row of centerlineSeries as any[]) {
          const match = String(row?.label || "").match(/Field-(\d+)/);
          if (!match) continue;
          const idx = Number(match[1]);
          if (!Number.isInteger(idx) || idx < 0 || idx >= realHeights.length) continue;
          const yUmRaw = getSpotDistortionYUm(row);
          const yUm = toFiniteNumberOrNull(yUmRaw);
          if (typeof yUm === "number") {
            realHeights[idx] = Math.abs(yUm / 1000);
          }
        }

        const distortion = idealHeights.map((ideal, index) => {
          const real = realHeights[index];
          if (!Number.isFinite(ideal)) return null;
          if (Math.abs(ideal) < 1e-12) return 0;
          if (typeof real !== "number" || !Number.isFinite(real)) return null;
          return (real - ideal) / ideal;
        });
        const distortionPercent = distortion.map((value) => (
          typeof value === "number" && Number.isFinite(value) ? value * 100 : null
        ));

        let finitePairCount = 0;
        for (let i = 0; i < fieldSamples.length; i += 1) {
          const y = Number(fieldSamples[i]);
          const x = distortionPercent[i];
          if (Number.isFinite(y) && typeof x === "number" && Number.isFinite(x)) finitePairCount += 1;
        }
        const minimumFinitePairs = Math.min(fieldSamples.length, Math.max(3, Math.ceil(fieldSamples.length * 0.6)));
        if (finitePairCount >= minimumFinitePairs) {
          emitProgress(90, "Distortion: centerline reconstruction complete");
          return {
            backend: "web-rust-wasm-centerline-spot-fallback",
            fieldValues: fieldSamples,
            idealHeights,
            realHeights,
            distortion,
            distortionPercent,
            meta: {
              wavelength,
              surfaceIndex,
              heightMode,
              paraxialAngleUnit: "radian",
              idealHeightFormula: "tan(w_paraxial_rad) * EFL",
              distortionDefinition: distortionMetric === "chief-ray" ? "chief-ray" : "spot-gravity-centroid",
              centerlinePointCount: fieldSamples.length,
              finitePairCount,
              minimumFinitePairs,
              directWasmError,
            },
            message: "Computed via ImageHeight centerline spot fallback",
          };
        }
      } catch {
        // Keep spot-based fallback below if centerline reconstruction fails.
      }
    }

    emitProgress(62, "Distortion: running render raytrace fallback...");
    magnification = -1;
    const chiefRayHighAccuracy = distortionMetric === "chief-ray";
    const distortionTraceRayCount = chiefRayHighAccuracy ? 31 : distortionRayFanCount;
    const distortionTraceRingCount = chiefRayHighAccuracy ? 8 : 1;
    const distortionTracePattern = chiefRayHighAccuracy ? "annular" : "cross";

    const objectRows = fieldSamples.map((sample, index) => {
      if (heightMode) {
        if (inputFieldMode === "imageheight") {
          const thetaRad = Math.atan2(Number(sample), focalLength);
          const thetaDeg = thetaRad * 180 / Math.PI;
          const objectDistanceAbs = Math.abs(objectDistance);
          if (finiteSystem && Number.isFinite(objectDistanceAbs) && objectDistanceAbs > 1e-12) {
            const objectY = objectDistanceAbs * Math.tan(thetaRad);
            return {
              id: `Field-${index}`,
              name: `Field-${index}`,
              position: "Rectangle",
              xHeight: 0,
              yHeight: objectY,
              x: 0,
              y: objectY,
            };
          }
          return {
            id: `Field-${index}`,
            name: `Field-${index}`,
            position: "Angle",
            xHeightAngle: 0,
            yHeightAngle: thetaDeg,
            x: 0,
            y: thetaDeg,
          };
        }
        // For infinite systems, height-mode samples are image heights. Trace them
        // as Angle rays (paraxial angle = atan(h / EFL)) so the spot raytrace can
        // reach the image surface; the ideal height remains the input sample.
        if (!finiteSystem && Number.isFinite(focalLength) && Math.abs(focalLength) > 1e-12) {
          const thetaRad = Math.atan2(sample, focalLength);
          return {
            id: `Field-${index}`,
            name: `Field-${index}`,
            position: "Angle",
            xHeightAngle: 0,
            yHeightAngle: thetaRad * 180 / Math.PI,
            x: 0,
            y: thetaRad * 180 / Math.PI,
          };
        }
        return {
          id: `Field-${index}`,
          name: `Field-${index}`,
          position: "Rectangle",
          xHeight: 0,
          yHeight: sample,
          x: 0,
          y: sample,
        };
      }
      if (finiteSystem) {
        const thetaRad = sample * Math.PI / 180;
        const objectHeight = objectDistance * Math.tan(thetaRad);
        return {
          id: `Field-${index}`,
          name: `Field-${index}`,
          position: "Rectangle",
          xHeight: 0,
          yHeight: objectHeight,
          x: 0,
          y: objectHeight,
        };
      }
      return {
        id: `Field-${index}`,
        name: `Field-${index}`,
        position: "Angle",
        xHeightAngle: 0,
        yHeightAngle: sample,
        x: 0,
        y: sample,
      };
    });

    const traceObjectRows = objectRows;

    const runRenderRaytraceForRows = async (
      rowsForTrace: any[],
      options?: {
        strictChiefOnly?: boolean;
        rayCount?: number;
        pattern?: string;
        preferAccurateChief?: boolean;
      },
    ) => {
      const rows = Array.isArray(rowsForTrace) ? rowsForTrace : [];
      if (rows.length === 0) {
        return {
          series: [],
        } as any;
      }

      const [{ generateRayStartPointsForObject }, { detectConjugateType }] = await Promise.all([
        import("../../../optical/ray-renderer.ts"),
        import("../../../utils/conjugate-detection.ts"),
      ]);

      const conjugateType = String(detectConjugateType(opticalSystemRows) || "").toLowerCase() === "finite"
        ? "finite"
        : "infinite";
      const strictChiefOnly = options?.strictChiefOnly === true;
      const preferAccurateChief = options?.preferAccurateChief === true;
      const requestedRayCount = Number.isFinite(Number(options?.rayCount))
        ? Math.max(1, Math.min(31, Math.floor(Number(options?.rayCount))))
        : distortionTraceRayCount;
      const requestedPattern = strictChiefOnly
        ? "annular"
        : "grid";

      const raySeries: any[] = [];
      for (let idx = 0; idx < rows.length; idx += 1) {
        const row = rows[idx];
          let starts: any[] = [];
          try {
            const generated = generateRayStartPointsForObject(
              row,
              opticalSystemRows,
              strictChiefOnly ? 1 : requestedRayCount,
              null,
              {
                pattern: requestedPattern,
                wavelengthUm: wavelength,
                conjugateType,
                // Keep fallback responsive: avoid render-only expensive chief/stop solves.
                aimThroughStop: strictChiefOnly && preferAccurateChief,
                useChiefRayAnalysis: strictChiefOnly && preferAccurateChief,
                allowStopBasedOriginSolve: false,
                originSolveTraceBackend: "rust",
                imageHeightValidationTraceBackend: "rust",
                targetSurfaceIndex: surfaceIndex,
                disableCrossExtent: strictChiefOnly,
                exactCrossBeamSampling: false,
                displayAxisAlignedSampling: false,
                preserveChiefNormalEmissionPlane: false,
                crossType: "both",
                pupilScale: 1,
              },
            );
            starts = Array.isArray(generated) ? generated : [];
          } catch {
            // Skip this field and continue tracing remaining fields.
            starts = [];
          }

          const startRows = Array.isArray(starts) ? starts : [];
          let rays = startRows
            .map((start: any) => {
              const startP = start?.startP ?? start?.origin ?? start?.pos ?? start?.originalRay?.origin ?? start?.originalRay?.pos;
              const dir = start?.dir ?? start?.direction ?? start?.originalRay?.direction ?? start?.originalRay?.dir;
              const sx = Number(startP?.x);
              const sy = Number(startP?.y);
              const sz = Number(startP?.z);
              const dx = Number(dir?.x);
              const dy = Number(dir?.y);
              const dz = Number(dir?.z);
              if (![sx, sy, sz, dx, dy, dz].every(Number.isFinite)) return null;
              const dNorm = Math.hypot(dx, dy, dz);
              if (!Number.isFinite(dNorm) || dNorm <= 1e-12) return null;
              const wl = Number(start?.wavelength ?? start?.originalRay?.wavelength ?? wavelength);
              const type = String(start?.originalRay?.type ?? start?.type ?? "").trim().toLowerCase();
              const isChief = start?.isChief === true || start?.originalRay?.isChief === true || type === "chief";
              return {
                startP: { x: sx, y: sy, z: sz },
                dir: { x: dx / dNorm, y: dy / dNorm, z: dz / dNorm },
                wavelengthUm: Number.isFinite(wl) && wl > 0 ? wl : wavelength,
                pupilU: Number.isFinite(Number(start?.planeCoords?.u)) ? Number(start.planeCoords.u) : undefined,
                pupilV: Number.isFinite(Number(start?.planeCoords?.v)) ? Number(start.planeCoords.v) : undefined,
                isChief,
              };
            })
            .filter((ray: any) => !!ray);

          if (strictChiefOnly && rays.length > 0) {
            const chief = rays.find((ray: any) => ray?.isChief === true) || rays[0];
            rays = chief ? [{ ...chief, isChief: true }] : [];
          }

          if (rays.length > 0) {
            raySeries.push({
              label: String(row?.id || row?.name || `Field-${idx}`),
              hasFieldAngle: true,
              rays,
            });
          }

          if (((idx + 1) % 2) === 0 || idx === rows.length - 1) {
            const progress = 64 + ((idx + 1) / Math.max(1, rows.length)) * 18;
            emitProgress(progress, `Distortion: generating render rays ${idx + 1}/${rows.length}...`);
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
      }

      if (raySeries.length === 0) {
        return {
          backend: "web-rust-wasm-render-raytrace-fallback-empty",
          surfaceIndex,
          tracedRays: 0,
          requestedRays: 0,
          generatedRays: 0,
          wavelengthCount: 0,
          seriesCount: 0,
          objectCount: rows.length,
          raysPerSeries: 0,
          totalAttemptedRays: 0,
          totalHitRays: 0,
          maxHitRays: 0,
          meanHitRatePercent: 0,
          seriesStats: [],
          series: [],
          message: "Render raytrace fallback generated no valid rays",
        } as any;
      }

      emitProgress(84, `Distortion: tracing render rays (${raySeries.length} fields)...`);
      const mergedSeries: any[] = [];
      const mergedSeriesStats: any[] = [];
      let totalAttemptedRays = 0;
      let totalHitRays = 0;
      let maxHitRays = 0;

      for (let i = 0; i < raySeries.length; i += 1) {
        const entry = raySeries[i];
        const strictTrace = strictChiefOnly && preferAccurateChief;
        try {
          const partial = await runNativeSpotRaytrace({
            opticalSystemRows,
            sourceRows,
            surfaceIndex,
            wavelengthMode: "primary",
            forceRustWasm: true,
            strictChiefOnly,
            raySeries: [entry],
            // Keep generic fallback responsive, but allow strict low-field chief retrace when requested.
            renderTraceBackend: strictTrace ? "rust" : "ts",
            allowNonStrictRaytrace: strictTrace ? false : true,
          } as any);

          const partialSeries = Array.isArray((partial as any)?.series) ? (partial as any).series : [];
          const partialStats = Array.isArray((partial as any)?.seriesStats) ? (partial as any).seriesStats : [];
          mergedSeries.push(...partialSeries);
          mergedSeriesStats.push(...partialStats);

          const attempted = Number((partial as any)?.totalAttemptedRays);
          const hits = Number((partial as any)?.totalHitRays);
          const maxHits = Number((partial as any)?.maxHitRays);
          if (Number.isFinite(attempted)) totalAttemptedRays += Math.max(0, attempted);
          if (Number.isFinite(hits)) totalHitRays += Math.max(0, hits);
          if (Number.isFinite(maxHits)) maxHitRays = Math.max(maxHitRays, Math.max(0, maxHits));
        } catch {
          // Skip failed field and continue with remaining fields.
        }

        if (((i + 1) % 2) === 0 || i === raySeries.length - 1) {
          const progress = 84 + ((i + 1) / Math.max(1, raySeries.length)) * 10;
          emitProgress(progress, `Distortion: tracing render rays ${i + 1}/${raySeries.length}...`);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      const wavelengthValues = mergedSeries
        .map((s: any) => Number(s?.wavelengthUm))
        .filter((v: number) => Number.isFinite(v) && v > 0);
      const meanHitRatePercent = totalAttemptedRays > 0 ? (totalHitRays / totalAttemptedRays) * 100 : 0;

      return {
        backend: "web-rust-wasm-render-raytrace-fallback",
        surfaceIndex,
        tracedRays: totalHitRays,
        requestedRays: totalAttemptedRays,
        generatedRays: totalAttemptedRays,
        wavelengthCount: new Set(wavelengthValues).size,
        seriesCount: mergedSeries.length,
        objectCount: rows.length,
        raysPerSeries: mergedSeriesStats.length > 0
          ? Math.max(0, ...mergedSeriesStats.map((s: any) => Number(s?.attemptedRays) || 0))
          : 0,
        totalAttemptedRays,
        totalHitRays,
        maxHitRays,
        meanHitRatePercent,
        seriesStats: mergedSeriesStats,
        series: mergedSeries,
        message: "Computed via render-raytrace per-field fallback",
      } as any;
    };

    const spotResponse = await runRenderRaytraceForRows(traceObjectRows, {
      strictChiefOnly: distortionMetric === "chief-ray",
      rayCount: distortionMetric === "chief-ray" && heightMode ? 1 : distortionTraceRayCount,
      pattern: distortionMetric === "chief-ray" && heightMode ? "annular" : distortionTracePattern,
      preferAccurateChief: distortionMetric === "chief-ray" && heightMode,
    });
    const renderRaytraceSeriesCount = Array.isArray((spotResponse as any)?.series)
      ? (spotResponse as any).series.length
      : 0;
    const renderRaytraceAttemptedRays = Number((spotResponse as any)?.totalAttemptedRays);
    const renderRaytraceHitRays = Number((spotResponse as any)?.totalHitRays);
    const fastRenderFallbackMode = true;
    emitProgress(94, "Distortion: finalizing...");

    const realHeights = new Array(fieldSamples.length).fill(null) as Array<number | null>;
    const series = Array.isArray(spotResponse?.series) ? spotResponse.series : [];
    for (const row of series as any[]) {
      const match = String(row?.label || "").match(/Field-(\d+)/);
      if (!match) continue;
      const index = Number(match[1]);
      if (!Number.isInteger(index) || index < 0 || index >= realHeights.length) continue;
      const yUmRaw = getSpotDistortionYUm(row);
      const yUm = toFiniteNumberOrNull(yUmRaw);
      if (typeof yUm === "number") {
        realHeights[index] = Math.abs(yUm / 1000);
      }
    }

    let lowFieldInterpolationRecoveryCount = 0;

    // Recover missing fields via a second strict raytrace pass without synthetic smoothing/interpolation.
    // We only retry fields with no valid hit from the primary pass.
    const missingFieldIndices = realHeights
      .map((value, index) => ({ value, index }))
      .filter((entry) => !(typeof entry.value === "number" && Number.isFinite(entry.value)))
      .map((entry) => entry.index);

    let recoveredFieldCount = 0;
    let wasmMissingRecoveryCount = 0;
    let lowFieldChiefRecoveryCount = 0;
    let missingFieldWasmRecoveryError: string | null = null;
    let missingFieldRetryFailures: Array<{ index: number; error: string }> = [];

    // Compute IH<=10mm chief-ray points by direct retrace (no interpolation/smoothing).
    if (heightMode && distortionMetric === "chief-ray") {
      const lowFieldThresholdMm = 10;
      const lowFieldIndices = fieldSamples
        .map((v, index) => ({ v: Number(v), index }))
        .filter((entry) => Number.isFinite(entry.v) && entry.v >= -1e-12 && entry.v <= lowFieldThresholdMm + 1e-12)
        .map((entry) => entry.index);

      for (let i = 0; i < lowFieldIndices.length; i += 1) {
        const targetIndex = lowFieldIndices[i];
        if (typeof realHeights[targetIndex] === "number" && Number.isFinite(realHeights[targetIndex])) {
          continue;
        }
        const row = objectRows[targetIndex];
        if (!row) continue;
        try {
          const lowFieldResp = await runRenderRaytraceForRows([row], {
            strictChiefOnly: true,
            rayCount: 1,
            pattern: "annular",
            preferAccurateChief: true,
          });
          const lowSeries = Array.isArray(lowFieldResp?.series) ? lowFieldResp.series : [];
          const lowRow = (lowSeries[0] ?? null) as any;
          const yUmRaw = getSpotDistortionYUm(lowRow);
          const yUm = toFiniteNumberOrNull(yUmRaw);
          if (!(typeof yUm === "number")) continue;

          const wasMissing = !(typeof realHeights[targetIndex] === "number" && Number.isFinite(realHeights[targetIndex]));
          realHeights[targetIndex] = Math.abs(yUm / 1000);
          if (wasMissing) recoveredFieldCount += 1;
          lowFieldChiefRecoveryCount += 1;
        } catch {
          // Keep original value when low-field retrace fails.
        }

        if (((i + 1) % 2) === 0 || i === lowFieldIndices.length - 1) {
          const progress = 94 + ((i + 1) / Math.max(1, lowFieldIndices.length)) * 3;
          emitProgress(progress, `Distortion: refining low-field chief rays ${i + 1}/${lowFieldIndices.length}...`);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }

    if (!fastRenderFallbackMode && missingFieldIndices.length > 0) {
      for (const missingIndex of missingFieldIndices) {
        if (!Number.isInteger(missingIndex) || missingIndex < 0 || missingIndex >= objectRows.length) continue;
        const row = objectRows[missingIndex];
        if (!row) continue;
        try {
          const retrySpotResponse = await runRenderRaytraceForRows([row], {
            strictChiefOnly: distortionMetric === "chief-ray",
            rayCount: distortionTraceRayCount,
            pattern: distortionTracePattern,
          });
          const retrySeries = Array.isArray(retrySpotResponse?.series) ? retrySpotResponse.series : [];
          const retryRow = (retrySeries[0] ?? null) as any;
          const yUmRaw = getSpotDistortionYUm(retryRow);
          const yUm = toFiniteNumberOrNull(yUmRaw);
          if (!(typeof yUm === "number")) continue;
          realHeights[missingIndex] = Math.abs(yUm / 1000);
          recoveredFieldCount += 1;
        } catch (retryError) {
          missingFieldRetryFailures.push({
            index: missingIndex,
            error: retryError instanceof Error ? retryError.message : String(retryError),
          });
        }
      }
    }

    if (!fastRenderFallbackMode && distortionMetric === "chief-ray") {
      const lowFieldThresholdMm = 10;
      const lowFieldUnresolvedIndices = realHeights
        .map((value, index) => ({ value, index }))
        .filter((entry) => !(typeof entry.value === "number" && Number.isFinite(entry.value)))
        .map((entry) => entry.index)
        .filter((index) => {
          const fv = Number(fieldSamples[index]);
          return Number.isFinite(fv) && fv >= -1e-12 && fv <= lowFieldThresholdMm + 1e-12;
        });

      for (const lowIdx of lowFieldUnresolvedIndices) {
        const row = objectRows[lowIdx];
        if (!row) continue;
        try {
          const strictChiefResp = await runRenderRaytraceForRows([row], {
            strictChiefOnly: true,
            rayCount: Math.max(121, distortionRayFanCount),
            pattern: "annular",
          });
          const strictSeries = Array.isArray(strictChiefResp?.series) ? strictChiefResp.series : [];
          const strictRow = (strictSeries[0] ?? null) as any;
          const yUmRaw = getSpotDistortionYUm(strictRow);
          const yUm = toFiniteNumberOrNull(yUmRaw);
          if (!(typeof yUm === "number")) continue;
          realHeights[lowIdx] = Math.abs(yUm / 1000);
          recoveredFieldCount += 1;
          lowFieldChiefRecoveryCount += 1;
        } catch {
          // Keep unresolved if strict chief re-search fails.
        }
      }
    }

    // If spot-based recovery still leaves gaps, recover only unresolved fields
    // through the native-like distortion WASM API and merge those real heights.
    const unresolvedFieldIndices = realHeights
      .map((value, index) => ({ value, index }))
      .filter((entry) => !(typeof entry.value === "number" && Number.isFinite(entry.value)))
      .map((entry) => entry.index);

    if (!fastRenderFallbackMode && distortionMetric === "chief-ray" && unresolvedFieldIndices.length > 0 && !directDistortionWasmUnavailableInSession) {
      try {
        const { preloadRustRayTracingWasm } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
        const wasmApi = await preloadRustRayTracingWasm();
        if (wasmApi && typeof wasmApi.run_native_distortion_wasm_json === "function") {
          const unresolvedFieldSamples = unresolvedFieldIndices.map((index) => fieldSamples[index]);
          const wasmReq = {
            opticalSystemRows,
            sourceRows,
            objectRows: inputObjectRows,
            fieldSamples: unresolvedFieldSamples,
            surfaceIndex,
            heightMode,
            wavelength,
            distortionMetric,
          };
          const wasmRaw = wasmApi.run_native_distortion_wasm_json(JSON.stringify(wasmReq));
          const wasmResp = (typeof wasmRaw === "string") ? JSON.parse(wasmRaw) : wasmRaw;
          const wasmRealHeights = Array.isArray((wasmResp as any)?.realHeights)
            ? (wasmResp as any).realHeights.map((v: any) => toFiniteNumberOrNull(v))
            : [];

          for (let i = 0; i < unresolvedFieldIndices.length; i += 1) {
            const targetIndex = unresolvedFieldIndices[i];
            const h = wasmRealHeights[i];
            if (typeof h === "number" && Number.isFinite(h)) {
              realHeights[targetIndex] = Math.abs(h);
              recoveredFieldCount += 1;
              wasmMissingRecoveryCount += 1;
            }
          }
        }
      } catch (wasmRecoveryError) {
        missingFieldWasmRecoveryError = wasmRecoveryError instanceof Error
          ? (wasmRecoveryError.message || String(wasmRecoveryError))
          : String(wasmRecoveryError);
        try {
          console.warn("runNativeDistortion(web): unresolved-field WASM recovery failed", {
            error: missingFieldWasmRecoveryError,
            unresolvedFieldIndices,
          });
        } catch {
          // Ignore logging failures in restricted runtimes.
        }
      }
    }

    let gridCenterlineRecoveryCount = 0;
    if (!fastRenderFallbackMode && distortionMetric === "chief-ray" && heightMode && inputFieldMode === "imageheight" && inputObjectRows.length > 0) {
      try {
        const gridSizeForRecovery = Math.max(11, fieldSamples.length);
        const gridResp = await runNativeGridDistortion({
          opticalSystemRows,
          sourceRows,
          objectRows: inputObjectRows,
          surfaceIndex,
          gridSize: gridSizeForRecovery,
          wavelength,
          detailProgress: false,
        });

        const idealX = Array.isArray((gridResp as any)?.idealX) ? (gridResp as any).idealX.map((v: any) => Number(v)) : [];
        const idealY = Array.isArray((gridResp as any)?.idealY) ? (gridResp as any).idealY.map((v: any) => Number(v)) : [];
        const realY = Array.isArray((gridResp as any)?.realY)
          ? (gridResp as any).realY.map((v: any) => toFiniteNumberOrNull(v))
          : [];
        const n = Math.min(idealX.length, idealY.length, realY.length);

        let minAbsX = Number.POSITIVE_INFINITY;
        for (let i = 0; i < n; i += 1) {
          const x = idealX[i];
          if (Number.isFinite(x)) minAbsX = Math.min(minAbsX, Math.abs(x));
        }

        const centerline: Array<{ idealY: number; realY: number | null }> = [];
        if (Number.isFinite(minAbsX)) {
          const tol = Math.max(1e-9, minAbsX * 1e-6);
          for (let i = 0; i < n; i += 1) {
            const x = idealX[i];
            const y = idealY[i];
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            if (Math.abs(Math.abs(x) - minAbsX) > tol) continue;
            centerline.push({ idealY: y, realY: realY[i] });
          }
          centerline.sort((a, b) => a.idealY - b.idealY);
        }

        const finiteCenterline = centerline.filter((row) => typeof row.realY === "number" && Number.isFinite(row.realY));
        const interpolateRealY = (target: number): number | null => {
          if (finiteCenterline.length === 0 || !Number.isFinite(target)) return null;
          if (target <= finiteCenterline[0].idealY) return Number(finiteCenterline[0].realY);
          const tail = finiteCenterline[finiteCenterline.length - 1];
          if (target >= tail.idealY) return Number(tail.realY);
          for (let i = 1; i < finiteCenterline.length; i += 1) {
            const left = finiteCenterline[i - 1];
            const right = finiteCenterline[i];
            if (!(target <= right.idealY)) continue;
            const dy = right.idealY - left.idealY;
            if (!Number.isFinite(dy) || Math.abs(dy) <= 1e-12) return Number(left.realY);
            const t = (target - left.idealY) / dy;
            const leftY = Number(left.realY);
            const rightY = Number(right.realY);
            if (!Number.isFinite(leftY) || !Number.isFinite(rightY)) return null;
            return leftY + (rightY - leftY) * t;
          }
          return null;
        };

        for (let i = 0; i < fieldSamples.length; i += 1) {
          const fv = Number(fieldSamples[i]);
          if (!Number.isFinite(fv) || fv < -1e-12) continue;
          const current = realHeights[i];
          const looksRectangularArtifact = typeof current === "number" && Number.isFinite(current) && current <= 1e-6 && fv > 0.5;
          const needsRecovery = !(typeof current === "number" && Number.isFinite(current)) || looksRectangularArtifact;
          if (!needsRecovery) continue;
          const ry = interpolateRealY(fv);
          if (!(typeof ry === "number" && Number.isFinite(ry))) continue;
          realHeights[i] = Math.abs(ry);
          gridCenterlineRecoveryCount += 1;
        }
      } catch {
        // Keep current chief-ray values if grid centerline recovery fails.
      }
    }

    const idealHeights = fieldSamples.map((sample) => computeParaxialIdealHeight(Number(sample)));
    const distortion = realHeights.map((height, index) => {
      const ideal = Number(idealHeights[index]);
      if (!Number.isFinite(ideal)) return null;
      if (Math.abs(ideal) < 1e-12) return 0;
      if (typeof height !== "number" || !Number.isFinite(height)) return null;
      return (height - ideal) / ideal;
    });
    const distortionPercent = distortion.map((value) => (
      typeof value === "number" && Number.isFinite(value)
        ? value * 100
        : null
    ));

    let interpolationFilledCount = 0;

    const unresolvedAfterRecoveryIndices = realHeights
      .map((value, index) => ({ value, index }))
      .filter((entry) => !(typeof entry.value === "number" && Number.isFinite(entry.value)))
      .map((entry) => entry.index);
    if (missingFieldRetryFailures.length > 0 && unresolvedAfterRecoveryIndices.length > 0) {
      try {
        console.warn("runNativeDistortion(web): missing-field retry failed", {
          error: missingFieldRetryFailures[0]?.error || "Unknown retry failure",
          missingFieldIndices,
          unresolvedAfterRecoveryIndices,
          retryFailures: missingFieldRetryFailures,
        });
      } catch {
        // Ignore logging failures in restricted runtimes.
      }
    }

    const fallbackDiagnostics = fieldSamples.map((fieldDeg, index) => ({
      index,
      fieldDeg,
      idealHeightMm: Number.isFinite(Number(idealHeights[index])) ? Number(idealHeights[index]) : null,
      realHeightMm: (typeof realHeights[index] === "number" && Number.isFinite(realHeights[index]))
        ? realHeights[index]
        : null,
      distortionPercent: (typeof distortionPercent[index] === "number" && Number.isFinite(distortionPercent[index]))
        ? distortionPercent[index]
        : null,
    }));
    const monotonicBreaks = (() => {
      const out: Array<{ fromIndex: number; toIndex: number; fromValue: number; toValue: number }> = [];
      let prev: number | null = null;
      let prevIndex = -1;
      let expectedSign = 0; // +1 increasing, -1 decreasing
      for (let i = 0; i < distortionPercent.length; i += 1) {
        const raw = distortionPercent[i];
        if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
        const cur = raw;
        if (prev !== null) {
          const delta = cur - prev;
          if (Math.abs(delta) > 1e-9) {
            const sign = delta > 0 ? 1 : -1;
            if (expectedSign === 0) {
              expectedSign = sign;
            } else if (sign !== expectedSign) {
              out.push({ fromIndex: prevIndex, toIndex: i, fromValue: prev, toValue: cur });
            }
          }
        }
        prev = cur;
        prevIndex = i;
      }
      return out;
    })();
    const diagnosticsPayload = {
      backend: "web-rust-wasm-render-raytrace-fallback",
      surfaceIndex,
      directWasmError,
      focalLength,
      magnification,
      missingFieldCountBeforeRetry: missingFieldIndices.length,
      recoveredFieldCount,
      wasmMissingRecoveryCount,
      lowFieldChiefRecoveryCount,
      gridCenterlineRecoveryCount,
      lowFieldInterpolationRecoveryCount,
      missingFieldWasmRecoveryError,
      interpolationFilledCount,
      renderRaytraceSeriesCount,
      renderRaytraceAttemptedRays: Number.isFinite(renderRaytraceAttemptedRays) ? renderRaytraceAttemptedRays : 0,
      renderRaytraceHitRays: Number.isFinite(renderRaytraceHitRays) ? renderRaytraceHitRays : 0,
      unresolvedAfterRecoveryCount: unresolvedAfterRecoveryIndices.length,
      monotonicBreakCount: monotonicBreaks.length,
      monotonicBreaks,
      distortionDefinition: distortionMetric === "chief-ray" ? "chief-ray" : "spot-gravity-centroid",
      paraxialAngleUnit: "radian",
      idealHeightFormula: "tan(w_paraxial_rad) * EFL",
      points: fallbackDiagnostics,
    };
    // Fallback diagnostics logging is intentionally disabled in UI runtime.

    emitProgress(100, "Distortion: done");

    return {
      backend: "web-rust-wasm-render-raytrace-fallback",
      fieldValues: fieldSamples,
      idealHeights,
      realHeights,
      distortion,
      distortionPercent,
      meta: {
        wavelength,
        focalLength: Number.isFinite(focalLength) ? focalLength : NaN,
        paraxialReferenceMode: "strict-paraxial-trace",
        paraxialAngleUnit: "radian",
        idealHeightFormula: "tan(w_paraxial_rad) * EFL",
        finiteSystem,
        heightMode,
        distortionDefinition: distortionMetric === "chief-ray" ? "chief-ray" : "spot-gravity-centroid",
        magnification: Number.isFinite(magnification) ? magnification : -1,
        surfaceIndex,
        directWasmError,
        missingFieldCountBeforeRetry: missingFieldIndices.length,
        recoveredFieldCount,
        wasmMissingRecoveryCount,
        lowFieldChiefRecoveryCount,
        gridCenterlineRecoveryCount,
        lowFieldInterpolationRecoveryCount,
        missingFieldWasmRecoveryError,
        interpolationFilledCount,
        renderRaytraceSeriesCount,
        renderRaytraceAttemptedRays: Number.isFinite(renderRaytraceAttemptedRays) ? renderRaytraceAttemptedRays : 0,
        renderRaytraceHitRays: Number.isFinite(renderRaytraceHitRays) ? renderRaytraceHitRays : 0,
        unresolvedAfterRecoveryCount: unresolvedAfterRecoveryIndices.length,
      },
      message: "Computed via Web Rust/WASM distortion API",
    };
  }
  const invokePayload: NativeDistortionRequest = { ...(payload || {}) };
  delete (invokePayload as any).onProgress;
  return invokeCommand<NativeDistortionRequest, NativeDistortionResponse>("run_native_distortion", invokePayload);
}

export async function runNativeGridDistortion(
  payload: NativeGridDistortionRequest,
): Promise<NativeGridDistortionResponse> {
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const forceWebQconFallback = hasQconSurfaceNativeLike(opticalSystemRows);
  if (!isTauriRuntime() || forceWebQconFallback) {
    const onProgress = typeof (payload as any)?.onProgress === "function"
      ? (payload as any).onProgress as ((evt: { percent?: number; message?: string }) => void)
      : null;
    const emitProgress = (percent: number, message: string) => {
      if (!onProgress) return;
      try {
        onProgress({
          percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined,
          message,
        });
      } catch {
        // Ignore progress callback failures.
      }
    };

    if (opticalSystemRows.length === 0) {
      throw new Error("runNativeGridDistortion(web): opticalSystemRows is empty");
    }

    emitProgress(2, "Grid distortion: preparing Rust/WASM trace...");

    const { calculateParaxialData } = await import("../../../raytracing/core/ray-paraxial.ts");
    const surfaceIndex = Number.isInteger(payload?.surfaceIndex)
      ? Math.max(0, Number(payload.surfaceIndex))
      : pickImageSurfaceIndexNativeLike(opticalSystemRows);
    const gridSize = Number.isInteger(payload?.gridSize) ? Math.max(2, Math.min(40, Number(payload.gridSize))) : 20;
    const wavelength = Number.isFinite(Number(payload?.wavelength)) && Number(payload?.wavelength) > 0
      ? Number(payload.wavelength)
      : getPrimaryWavelengthUm(Array.isArray(payload?.sourceRows) ? payload.sourceRows : [], 0.5876);
    const sourceRows = Array.isArray(payload?.sourceRows) && payload.sourceRows.length > 0
      ? payload.sourceRows
      : buildDefaultDistortionSourceRows(wavelength);
    const finiteSystem = isFiniteConjugateNativeLike(opticalSystemRows);
    const objectDistance = getObjectDistanceMmNativeLike(opticalSystemRows);
    const inputObjectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
    const gridFieldMode = deriveGridFieldModeNativeLike(inputObjectRows);
    const gridFieldExtents = deriveGridAxisExtentsNativeLike(inputObjectRows, gridFieldMode);
    const requestedSensorWidthMm = Number(payload?.sensorWidthMm);
    const requestedSensorHeightMm = Number(payload?.sensorHeightMm);
    const hasSensorWidth = Number.isFinite(requestedSensorWidthMm) && requestedSensorWidthMm > 1e-9;
    const hasSensorHeight = Number.isFinite(requestedSensorHeightMm) && requestedSensorHeightMm > 1e-9;
    if (hasSensorWidth !== hasSensorHeight) {
      throw new Error("runNativeGridDistortion(web): sensorWidthMm and sensorHeightMm must be specified together");
    }
    const sensorOverrideUsed = hasSensorWidth && hasSensorHeight;
    const sensorWidthMm = sensorOverrideUsed ? Math.abs(requestedSensorWidthMm) : Number.NaN;
    const sensorHeightMm = sensorOverrideUsed ? Math.abs(requestedSensorHeightMm) : Number.NaN;
    const paraxial = calculateParaxialData(opticalSystemRows, wavelength);
    emitProgress(4, "Grid distortion: estimating paraxial model...");
    const pickFiniteFocalLength = (...candidates: unknown[]) => {
      for (const value of candidates) {
        const candidate = Number(value);
        if (Number.isFinite(candidate) && Math.abs(candidate) > 1e-12) return Math.abs(candidate);
      }
      return Number.NaN;
    };
    const focalLengthX = pickFiniteFocalLength(
      paraxial?.focalLengthX,
      paraxial?.sagittal?.focalLength,
      paraxial?.focalLength,
      paraxial?.effectiveFocalLength,
    );
    const focalLengthY = pickFiniteFocalLength(
      paraxial?.focalLengthY,
      paraxial?.tangential?.focalLength,
      paraxial?.focalLength,
      paraxial?.effectiveFocalLength,
    );
    const imageDistanceX = Number(paraxial?.imageDistanceX ?? paraxial?.sagittal?.imageDistance ?? paraxial?.imageDistance ?? paraxial?.image_distance);
    const imageDistanceY = Number(paraxial?.imageDistanceY ?? paraxial?.tangential?.imageDistance ?? paraxial?.imageDistance ?? paraxial?.image_distance);
    const magnificationX = (
      gridFieldMode === "height"
      && finiteSystem
      && Number.isFinite(imageDistanceX)
      && Number.isFinite(objectDistance)
      && Math.abs(objectDistance) > 1e-12
    )
      ? Math.abs(imageDistanceX / objectDistance)
      : -1;
    const magnificationY = (
      gridFieldMode === "height"
      && finiteSystem
      && Number.isFinite(imageDistanceY)
      && Number.isFinite(objectDistance)
      && Math.abs(objectDistance) > 1e-12
    )
      ? Math.abs(imageDistanceY / objectDistance)
      : -1;
    const hasFiniteFocalLengthX = Number.isFinite(focalLengthX) && Math.abs(focalLengthX) > 1e-12;
    const hasFiniteFocalLengthY = Number.isFinite(focalLengthY) && Math.abs(focalLengthY) > 1e-12;
    // Keep the grid operational for an afocal axis while reporting the fallback.
    const focalLengthForGridX = hasFiniteFocalLengthX ? focalLengthX : 1.0;
    const focalLengthForGridY = hasFiniteFocalLengthY ? focalLengthY : 1.0;
    const axisAnamorphic = Math.abs(focalLengthForGridX - focalLengthForGridY) > 1e-9 * Math.max(1, focalLengthForGridX, focalLengthForGridY);
    const imageScaleForHeightX = (gridFieldMode === "height" && finiteSystem && Number.isFinite(magnificationX) && Math.abs(magnificationX) > 1e-9)
      ? Math.abs(magnificationX)
      : 1.0;
    const imageScaleForHeightY = (gridFieldMode === "height" && finiteSystem && Number.isFinite(magnificationY) && Math.abs(magnificationY) > 1e-9)
      ? Math.abs(magnificationY)
      : 1.0;
    const maxImageX = gridFieldMode === "angle"
      ? focalLengthForGridX * Math.tan((gridFieldExtents.x * Math.PI) / 180)
      : gridFieldMode === "height"
        ? gridFieldExtents.x * imageScaleForHeightX
        : gridFieldExtents.x;
    const maxImageY = gridFieldMode === "angle"
      ? focalLengthForGridY * Math.tan((gridFieldExtents.y * Math.PI) / 180)
      : gridFieldMode === "height"
        ? gridFieldExtents.y * imageScaleForHeightY
        : gridFieldExtents.y;
    const imageHeightToObjectScaleX = gridFieldMode === "imageheight" && finiteSystem && Number.isFinite(imageDistanceX) && Number.isFinite(objectDistance) && Math.abs(imageDistanceX) > 1e-12
      ? Math.abs(objectDistance / imageDistanceX) : 1.0;
    const imageHeightToObjectScaleY = gridFieldMode === "imageheight" && finiteSystem && Number.isFinite(imageDistanceY) && Number.isFinite(objectDistance) && Math.abs(imageDistanceY) > 1e-12
      ? Math.abs(objectDistance / imageDistanceY) : 1.0;
    const gridRangeScale = Math.SQRT2 / 2;
    const scaledMaxImageX = sensorOverrideUsed ? sensorWidthMm / 2 : maxImageX * gridRangeScale;
    const scaledMaxImageY = sensorOverrideUsed ? sensorHeightMm / 2 : maxImageY * gridRangeScale;
    const stepX = (2 * scaledMaxImageX) / Math.max(1, gridSize - 1);
    const stepY = (2 * scaledMaxImageY) / Math.max(1, gridSize - 1);
    const fieldMaxX = gridFieldMode === "angle"
      ? (Math.atan(scaledMaxImageX / focalLengthForGridX) * 180) / Math.PI
      : gridFieldMode === "height" && finiteSystem && imageScaleForHeightX > 1e-9
        ? scaledMaxImageX / imageScaleForHeightX
        : scaledMaxImageX;
    const fieldMaxY = gridFieldMode === "angle"
      ? (Math.atan(scaledMaxImageY / focalLengthForGridY) * 180) / Math.PI
      : gridFieldMode === "height" && finiteSystem && imageScaleForHeightY > 1e-9
        ? scaledMaxImageY / imageScaleForHeightY
        : scaledMaxImageY;

    const idealX: number[] = [];
    const idealY: number[] = [];
    const objectRows: any[] = [];
    for (let yi = 0; yi < gridSize; yi++) {
      const imageY = -scaledMaxImageY + yi * stepY;
      const thetaYRad = Math.atan(imageY / focalLengthForGridY);
      const thetaY = (thetaYRad * 180) / Math.PI;
      for (let xi = 0; xi < gridSize; xi++) {
        const imageX = -scaledMaxImageX + xi * stepX;
        const thetaXRad = Math.atan(imageX / focalLengthForGridX);
        const thetaX = (thetaXRad * 180) / Math.PI;
        const index = yi * gridSize + xi;
        idealX.push(imageX);
        idealY.push(imageY);
        if (gridFieldMode === "imageheight") {
          if (finiteSystem) {
            const objectX = imageX * imageHeightToObjectScaleX;
            const objectY = imageY * imageHeightToObjectScaleY;
            objectRows.push({
              id: `Field-${index}`,
              name: `Field-${index}`,
              position: "Rectangle",
              xHeight: objectX,
              yHeight: objectY,
              x: objectX,
              y: objectY,
              __cooptOriginalPosition: "ImageHeight",
              __cooptImageHeightTarget: { x: imageX, y: imageY },
            });
          } else {
            objectRows.push({
              id: `Field-${index}`,
              name: `Field-${index}`,
              position: "Angle",
              xHeightAngle: thetaX,
              yHeightAngle: thetaY,
              x: thetaX,
              y: thetaY,
              __cooptOriginalPosition: "ImageHeight",
              __cooptImageHeightTarget: { x: imageX, y: imageY },
            });
          }
        } else if (gridFieldMode === "height") {
          const objectX = finiteSystem && imageScaleForHeightX > 1e-9 ? (imageX / imageScaleForHeightX) : imageX;
          const objectY = finiteSystem && imageScaleForHeightY > 1e-9 ? (imageY / imageScaleForHeightY) : imageY;
          objectRows.push({
            id: `Field-${index}`,
            name: `Field-${index}`,
            position: "Rectangle",
            xHeight: objectX,
            yHeight: objectY,
            x: objectX,
            y: objectY,
          });
        } else if (finiteSystem) {
          const objectX = objectDistance * Math.tan(thetaXRad);
          const objectY = objectDistance * Math.tan(thetaYRad);
          objectRows.push({
            id: `Field-${index}`,
            name: `Field-${index}`,
            position: "Rectangle",
            xHeight: objectX,
            yHeight: objectY,
            x: objectX,
            y: objectY,
          });
        } else {
          objectRows.push({
            id: `Field-${index}`,
            name: `Field-${index}`,
            position: "Angle",
            xHeightAngle: thetaX,
            yHeightAngle: thetaY,
            x: thetaX,
            y: thetaY,
          });
        }
      }
    }

    emitProgress(10, "Grid distortion: grid generated, starting trace...");

    const traceObjectRows = objectRows;

    const realX = new Array(idealX.length).fill(null) as Array<number | null>;
    const realY = new Array(idealY.length).fill(null) as Array<number | null>;
    let radialWasmChiefRayCount = 0;
    let exactWasmChiefRayCount = 0;
    let spotFallbackChiefRayCount = 0;
    let radialWasmChiefRayError = "";
    let exactWasmChiefRayError = "";
    let spotFallbackChiefRayError = "";

    // Grid distortion needs one deterministic stop-centred chief ray per field.
    // The spot-diagram generator is designed for pupil sampling and can reject
    // otherwise valid outer-field chief rays when its sampled bundle is vignetted.
    // Use the dedicated radial distortion and exact WASM chief-ray tracers first,
    // reserving spot tracing for uncommon points those solvers cannot reach.
    try {
      const { preloadRustRayTracingWasm } = await import(
        "../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts"
      );
      const rust = await preloadRustRayTracingWasm();
      const traceRadialDistortion = (rust as any)?.run_native_distortion_wasm_json;

      // A conventional grid-distortion plot is radial for a centred optical
      // system. Reuse the same robust distortion solver as the 1-D plot, then
      // project each traced radial image height back onto its grid azimuth.
      if (typeof traceRadialDistortion === "function" && !axisAnamorphic) {
        try {
          const radialSamples = idealX.map((x, index) => {
            const radius = Math.hypot(x, idealY[index]);
            if (gridFieldMode === "angle") {
              return (Math.atan(radius / focalLengthForGridX) * 180) / Math.PI;
            }
            if (gridFieldMode === "height" && finiteSystem && imageScaleForHeightX > 1e-9) {
              return radius / imageScaleForHeightX;
            }
            return radius;
          });
          // Trace from the axis outwards. The exact chief-ray solver deliberately
          // reuses the previous field as its next seed, so arbitrary row-major
          // grid order (corner -> centre -> corner) can lose wide-angle fields.
          const maxRadialSample = Math.max(0, ...radialSamples);
          const seedSampleCount = 81;
          const seedSamples = Array.from({ length: seedSampleCount }, (_, index) => ({
            sample: maxRadialSample * index / Math.max(1, seedSampleCount - 1),
            index: null as number | null,
          }));
          const radialOrder = radialSamples
            .map((sample, index) => ({ sample, index: index as number | null }))
            .concat(seedSamples)
            .sort((a, b) => a.sample - b.sample);
          const sortedRadialSamples = radialOrder.map((entry) => entry.sample);
          const radialRaw = traceRadialDistortion(JSON.stringify({
            opticalSystemRows,
            sourceRows,
            objectRows: inputObjectRows,
            fieldSamples: sortedRadialSamples,
            surfaceIndex,
            heightMode: gridFieldMode !== "angle",
            wavelength,
            distortionMetric: "chief-ray",
          }));
          const radialResponse = typeof radialRaw === "string" ? JSON.parse(radialRaw) : radialRaw;
          const radialRealHeights = Array.isArray((radialResponse as any)?.realHeights)
            ? (radialResponse as any).realHeights
            : [];
          for (let sortedIndex = 0; sortedIndex < radialOrder.length; sortedIndex += 1) {
            const index = radialOrder[sortedIndex].index;
            if (index === null) continue;
            const idealRadius = Math.hypot(idealX[index], idealY[index]);
            const rawRealRadius = radialRealHeights[sortedIndex];
            if (rawRealRadius === null || rawRealRadius === undefined) continue;
            const realRadius = Number(rawRealRadius);
            if (!Number.isFinite(realRadius)) continue;
            if (idealRadius <= 1e-12) {
              realX[index] = 0;
              realY[index] = 0;
            } else {
              realX[index] = realRadius * idealX[index] / idealRadius;
              realY[index] = realRadius * idealY[index] / idealRadius;
            }
            radialWasmChiefRayCount += 1;
          }
        } catch (error) {
          radialWasmChiefRayError = String((error as any)?.message || error || "radial WASM distortion failed");
        }
      } else {
        radialWasmChiefRayError = axisAnamorphic
          ? "radial shortcut disabled for axis-resolved X/Y power"
          : "missing run_native_distortion_wasm_json";
      }

      const traceInfinite = (rust as any)?.trace_image_height_infinite_candidate_exact_with_rows;
      const traceFinite = (rust as any)?.trace_image_height_finite_candidate_with_rows;
      const exactTrace = finiteSystem ? traceFinite : traceInfinite;
      if (typeof exactTrace !== "function") {
        throw new Error(finiteSystem
          ? "missing trace_image_height_finite_candidate_with_rows"
          : "missing trace_image_height_infinite_candidate_exact_with_rows");
      }

      const progressStride = Math.max(1, Math.ceil(traceObjectRows.length / 100));
      for (let index = 0; index < traceObjectRows.length; index += 1) {
        if (realX[index] !== null && realY[index] !== null) continue;
        const row = traceObjectRows[index] as any;
        const inputX = finiteSystem
          ? Number(row?.xHeight ?? row?.x ?? 0)
          : Number(row?.xHeightAngle ?? row?.xFieldAngle ?? row?.x ?? 0);
        const inputY = finiteSystem
          ? Number(row?.yHeight ?? row?.y ?? 0)
          : Number(row?.yHeightAngle ?? row?.yFieldAngle ?? row?.y ?? 0);
        try {
          const traced = Array.from(exactTrace(
            opticalSystemRows,
            surfaceIndex,
            wavelength,
            Number.isFinite(inputX) ? inputX : 0,
            Number.isFinite(inputY) ? inputY : 0,
          ) as ArrayLike<number>);
          const status = Number(traced[0]);
          const xMm = Number(traced[1]);
          const yMm = Number(traced[2]);
          if (status === 1 && Number.isFinite(xMm) && Number.isFinite(yMm)) {
            realX[index] = xMm;
            realY[index] = yMm;
            exactWasmChiefRayCount += 1;
          }
        } catch {
          // Leave this point missing so the spot fallback can retry it below.
        }
        if ((index + 1) % progressStride === 0 || index + 1 === traceObjectRows.length) {
          emitProgress(
            10 + (65 * (index + 1)) / Math.max(1, traceObjectRows.length),
            `Grid distortion exact chief rays: point ${index + 1}/${traceObjectRows.length}`,
          );
        }
      }
    } catch (error) {
      exactWasmChiefRayError = String((error as any)?.message || error || "exact WASM chief ray failed");
    }

    const assignChiefPoint = (row: any) => {
      const match = String(row?.label || "").match(/Field-(\d+)/);
      if (!match) return;
      const index = Number(match[1]);
      if (!Number.isInteger(index) || index < 0 || index >= realX.length) return;
      const chiefPointUm = row?.chiefPointUm;
      const xMm = Number(
        (chiefPointUm && typeof chiefPointUm === "object" ? chiefPointUm.xUm : undefined)
      ) / 1000;
      const yMm = Number(
        (chiefPointUm && typeof chiefPointUm === "object" ? chiefPointUm.yUm : undefined)
      ) / 1000;
      if (Number.isFinite(xMm) && Number.isFinite(yMm)) {
        realX[index] = xMm;
        realY[index] = yMm;
        spotFallbackChiefRayCount += 1;
      }
    };

    const fallbackObjectRows = traceObjectRows.filter((_, index) => (
      realX[index] === null || realY[index] === null
    ));
    const totalTracePoints = Math.max(1, fallbackObjectRows.length);
    const detailedProgress = payload?.detailProgress === true && onProgress !== null;
    if (detailedProgress && fallbackObjectRows.length > 0) {
      for (let i = 0; i < fallbackObjectRows.length; i += 1) {
        const row = fallbackObjectRows[i];
        try {
          const spotResponse = await runNativeSpotRaytrace({
            opticalSystemRows,
            sourceRows,
            objectRows: [row],
            surfaceIndex,
            rayCount: 11,
            ringCount: 1,
            pattern: "cross",
            wavelengthMode: "primary",
            forceRustWasm: true,
            strictChiefOnly: true,
          });
          const series = Array.isArray(spotResponse?.series) ? spotResponse.series : [];
          for (const s of series as any[]) {
            assignChiefPoint(s);
          }
        } catch (error) {
          if (!spotFallbackChiefRayError) {
            spotFallbackChiefRayError = String(
              (error as any)?.message || error || "spot fallback chief ray failed",
            );
          }
        }
        emitProgress(
          75 + (15 * (i + 1)) / totalTracePoints,
          `Grid distortion spot fallback: point ${i + 1}/${totalTracePoints}`,
        );
      }
    } else if (fallbackObjectRows.length > 0) {
      try {
        const spotResponse = await runNativeSpotRaytrace({
          opticalSystemRows,
          sourceRows,
          objectRows: fallbackObjectRows,
          surfaceIndex,
          rayCount: 11,
          ringCount: 1,
          pattern: "cross",
          wavelengthMode: "primary",
          forceRustWasm: true,
          strictChiefOnly: true,
        });

        const series = Array.isArray(spotResponse?.series) ? spotResponse.series : [];
        let processed = 0;
        for (const row of series as any[]) {
          assignChiefPoint(row);
          processed += 1;
          emitProgress(
            75 + (15 * processed) / Math.max(1, totalTracePoints),
            `Grid distortion spot fallback: point ${Math.min(processed, totalTracePoints)}/${totalTracePoints}`,
          );
        }
      } catch (error) {
        spotFallbackChiefRayError = String(
          (error as any)?.message || error || "spot fallback chief ray failed",
        );
      }
    }

    let missingFieldFallbackCount = 0;
    for (let i = 0; i < realX.length; i++) {
      const rx = realX[i];
      const ry = realY[i];
      if (rx === null || ry === null || !Number.isFinite(rx) || !Number.isFinite(ry)) {
        realX[i] = null;
        realY[i] = null;
        missingFieldFallbackCount += 1;
      }
    }

    return {
      backend: "web-rust-wasm",
      idealX,
      idealY,
      realX,
      realY,
      gridSize,
      maxFieldAngle: gridFieldMode === "angle" ? Math.max(fieldMaxX, fieldMaxY) : NaN,
      meta: {
        wavelength,
        focalLength: hasFiniteFocalLengthY ? focalLengthY : NaN,
        focalLengthX: hasFiniteFocalLengthX ? focalLengthX : NaN,
        focalLengthY: hasFiniteFocalLengthY ? focalLengthY : NaN,
        focalLengthFallbackUsed: !hasFiniteFocalLengthX || !hasFiniteFocalLengthY,
        focalLengthForGridX,
        focalLengthForGridY,
        axisAnamorphic,
        finiteSystem,
        gridFieldMode,
        sensorOverrideUsed,
        ...(sensorOverrideUsed ? { sensorWidthMm, sensorHeightMm } : {}),
        fieldMaxX,
        fieldMaxY,
        objectMaxHeight: (gridFieldMode === "height" || gridFieldMode === "imageheight")
          ? (sensorOverrideUsed ? Math.hypot(scaledMaxImageX, scaledMaxImageY) : Number(gridFieldExtents.y))
          : NaN,
        maxImageX: scaledMaxImageX,
        maxImageY: scaledMaxImageY,
        surfaceIndex,
        directChiefRayCount: radialWasmChiefRayCount + exactWasmChiefRayCount + spotFallbackChiefRayCount,
        radialWasmChiefRayCount,
        exactWasmChiefRayCount,
        spotFallbackChiefRayCount,
        radialWasmChiefRayError,
        exactWasmChiefRayError,
        spotFallbackChiefRayError,
        missingFieldFallbackCount,
        detailedProgressUsed: detailedProgress,
      },
      message: "Computed via Web Rust/WASM grid distortion API",
    };
  }
  const invokePayload: NativeGridDistortionRequest = { ...(payload || {}) };
  delete (invokePayload as any).onProgress;
  delete (invokePayload as any).detailProgress;
  return invokeCommand<NativeGridDistortionRequest, NativeGridDistortionResponse>("run_native_grid_distortion", invokePayload);
}

export async function runNativeMagnificationChromaticAberration(
  payload: NativeMagnificationChromaticAberrationRequest,
): Promise<NativeMagnificationChromaticAberrationResponse> {
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const tauriRuntime = isTauriRuntime();
  const chiefRayDefinition = String(payload?.chiefRayDefinition || "stop-center").trim().toLowerCase();
  const useExactStopCenterWasmInTauri = tauriRuntime && chiefRayDefinition.startsWith("stop-center");
  if (tauriRuntime && !useExactStopCenterWasmInTauri) {
    try {
      return await invokeCommand<NativeMagnificationChromaticAberrationRequest, NativeMagnificationChromaticAberrationResponse>(
        "run_native_magnification_chromatic_aberration",
        payload,
      );
    } catch (error) {
      console.warn("[LCA] Native Rust backend failed; falling back to Rust/WASM wrapper", error);
    }
  }

  const { calculateMagnificationChromaticAberrationData } = await import(
    "../../../evaluation/aberrations/magnification-chromatic-aberration.ts"
  );
  const result = await calculateMagnificationChromaticAberrationData(
    Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [],
    Array.isArray(payload?.fieldSamples) ? payload.fieldSamples : [],
    Array.isArray(payload?.wavelengths) ? payload.wavelengths : [],
    {
      sourceRows: Array.isArray(payload?.sourceRows) ? payload.sourceRows : [],
      referenceWavelength: Number.isFinite(Number(payload?.referenceWavelength))
        ? Number(payload.referenceWavelength)
        : 0.5876,
      heightMode: payload?.heightMode === true,
      imageHeightMode: payload?.imageHeightMode === true,
      rayCount: Number.isInteger(payload?.rayCount) ? Number(payload.rayCount) : undefined,
      ringCount: Number.isInteger(payload?.ringCount) ? Number(payload.ringCount) : undefined,
      chiefRayDefinition: payload?.chiefRayDefinition || "stop-center",
      requireRustWasm: true,
      forceWasmInTauri: true,
    },
  );
  if (!result) throw new Error("LCA WASM calculation failed");

  const normalized = result as NativeMagnificationChromaticAberrationResponse & { meta?: any };
  normalized.backend = tauriRuntime ? "tauri-rust-wasm" : "web-rust-wasm";
  normalized.meta = {
    ...(normalized.meta || {}),
    executionMode: tauriRuntime ? "tauri-wasm" : "web-wasm",
    nativeTauriInvokeDisabled: true,
    exactStopCenterChiefFallback: useExactStopCenterWasmInTauri,
  };
  normalized.imageHeightMode = payload?.imageHeightMode === true || normalized.imageHeightMode === true;
  return normalized;
}

export async function readTextFile(payload: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  return invokeCommand<ReadTextFileRequest, ReadTextFileResponse>("read_text_file", payload);
}

export async function writeTextFile(payload: WriteTextFileRequest): Promise<WriteTextFileResponse> {
  return invokeCommand<WriteTextFileRequest, WriteTextFileResponse>("write_text_file", payload);
}

export async function exportFreeCadDocument(payload: ExportFreeCadDocumentRequest): Promise<ExportFreeCadDocumentResponse> {
  return invokeCommand<ExportFreeCadDocumentRequest, ExportFreeCadDocumentResponse>("export_free_cad_document", payload);
}

export async function aiChat(payload: AiChatRequest): Promise<AiChatResponse> {
  return invokeCommand<AiChatRequest, AiChatResponse>("ai_chat_stub", payload);
}

export async function generateZmxText(payload: GenerateZmxTextRequest): Promise<GenerateZmxTextResponse> {
  return invokeCommand<GenerateZmxTextRequest, GenerateZmxTextResponse>("generate_zmx_text", payload);
}

export async function parseZmxText(payload: ParseZmxTextRequest): Promise<ParseZmxTextResponse> {
  return invokeCommand<ParseZmxTextRequest, ParseZmxTextResponse>("parse_zmx_text", payload);
}

export async function runOptimizerStep(payload: OptimizeStepRequest): Promise<OptimizeStepResponse> {
  return invokeCommand<OptimizeStepRequest, OptimizeStepResponse>("run_optimizer_step", payload);
}

export async function evaluateOptimizerCandidates(
  payload: EvaluateOptimizerCandidatesRequest,
): Promise<EvaluateOptimizerCandidatesResponse> {
  return invokeCommand<EvaluateOptimizerCandidatesRequest, EvaluateOptimizerCandidatesResponse>(
    "evaluate_optimizer_candidates",
    payload,
  );
}

export async function evaluateOptimizerCandidatesMultiScenario(
  payload: EvaluateOptimizerCandidatesMultiScenarioRequest,
): Promise<EvaluateOptimizerCandidatesResponse> {
  return invokeCommand<EvaluateOptimizerCandidatesMultiScenarioRequest, EvaluateOptimizerCandidatesResponse>(
    "evaluate_optimizer_candidates_multi_scenario",
    payload,
  );
}

export async function requestOptimizerStop(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invokeCommand<boolean>("optimizer_request_stop");
}

export async function clearOptimizerStop(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invokeCommand<boolean>("optimizer_clear_stop");
}

export async function dropOptimizerSession(sessionId: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const payload: OptimizerDropSessionRequest = { sessionId };
  return invokeCommand<OptimizerDropSessionRequest, boolean>("optimizer_drop_session", payload);
}

export async function recommendWavefrontGrid(
  payload: RecommendWavefrontGridRequest,
): Promise<GridRecommendation> {
  return invokeCommand<RecommendWavefrontGridRequest, GridRecommendation>("recommend_wavefront_grid", payload);
}

export async function recommendWavefrontGridForTime(
  payload: RecommendWavefrontGridForTimeRequest,
): Promise<GridRecommendation> {
  return invokeCommand<RecommendWavefrontGridForTimeRequest, GridRecommendation>("recommend_wavefront_grid_for_time", payload);
}

export async function runAnalysisPreview(
  payload: RunAnalysisPreviewRequest,
): Promise<RunAnalysisPreviewResponse> {
  validateAnalysisPreviewRequest(payload);
  return invokeCommand<RunAnalysisPreviewRequest, RunAnalysisPreviewResponse>("run_analysis_preview", payload);
}

export async function runAnalysisCompute(
  payload: RunAnalysisComputeRequest,
): Promise<RunAnalysisComputeResponse> {
  validateAnalysisComputeRequest(payload);
  return invokeCommand<RunAnalysisComputeRequest, RunAnalysisComputeResponse>("run_analysis_compute", payload);
}

export async function runSystemDataReport(
  payload: RunSystemDataReportRequest,
): Promise<RunSystemDataReportResponse> {
  validateSystemDataReportRequest(payload);
  return invokeCommand<RunSystemDataReportRequest, RunSystemDataReportResponse>("run_system_data_report", payload);
}

export async function getNewProjectTemplate(): Promise<NewProjectTemplateResponse> {
  return invokeCommand<NewProjectTemplateResponse>("new_project_template");
}

export async function getDefaultProject(): Promise<DefaultProjectResponse> {
  return invokeCommand<DefaultProjectResponse>("load_default_project");
}
