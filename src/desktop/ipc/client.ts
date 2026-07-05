import { invoke } from "@tauri-apps/api/core";
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
  NativeOpdMapRequest,
  NativeOpdMapResponse,
  NativeOpdRmsWavesRequest,
  NativeOpdRmsWavesResponse,
  NativePsfMapRequest,
  NativePsfMapResponse,
  NativeMtfMapRequest,
  NativeMtfMapResponse,
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
} from "../../shared/contracts/io-ai";
import type {
  DefaultProjectResponse,
  NewProjectTemplateResponse,
} from "../../shared/contracts/project";
import type {
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

    if (typeof createWavefrontAnalyzer === "function") {
      const analyzer = createWavefrontAnalyzer(calc) as any;
      if (analyzer && typeof analyzer.generateWavefrontMap === "function") {
        const map = await analyzer.generateWavefrontMap(fieldSetting, gridSize, "circular", {
          recordRays: false,
          progressEvery: 0,
          opdMode: "referenceSphere",
          opdDisplayMode,
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
            return {
              backend: "web-rust-wasm-js-reference",
              chiefReferenceMode: `js-reference-sphere(${requestedPupilSamplingMode})`,
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
            ? calc.calculateOPDReferenceSphere(pupilX, pupilY, fieldSetting, false, { pupilSamplingMode: requestedPupilSamplingMode })
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
    return {
      backend: "web-rust-wasm-js-reference",
      chiefReferenceMode: `js-reference-sphere(${requestedPupilSamplingMode})`,
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

async function normalizeTransverseObjectRowsForImageHeight(
  opticalSystemRows: any[],
  sourceRows: any[],
  objectRows: any[],
  explicitWavelength?: number,
): Promise<any[]> {
  const parseFiniteNumber = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const rows = Array.isArray(objectRows) ? objectRows : [];
  if (rows.length === 0) return [];

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

  const [{ detectConjugateType }, { convertImageHeightToEffectiveObject }] = await Promise.all([
    import("../../../utils/conjugate-detection.ts"),
    import("../../../optical/ray-renderer.ts"),
  ]);
  const conjugateType = String(detectConjugateType(opticalSystemRows) || "").toLowerCase() === "finite"
    ? "finite"
    : "infinite";
  const wavelength = Number.isFinite(Number(explicitWavelength))
    ? Number(explicitWavelength)
    : getPrimaryWavelengthFromSourceRows(sourceRows);

  return normalizedRows.map((row) => {
    const posNorm = String((row as any)?.position ?? "").trim().toLowerCase();
    if (posNorm !== "imageheight") return row;

    const preservedTarget = {
      x: parseFiniteNumber((row as any)?.__cooptImageHeightTarget?.x)
        ?? parseFiniteNumber((row as any)?.xHeight)
        ?? parseFiniteNumber((row as any)?.x)
        ?? parseFiniteNumber((row as any)?.["object x"])
        ?? 0,
      y: parseFiniteNumber((row as any)?.__cooptImageHeightTarget?.y)
        ?? parseFiniteNumber((row as any)?.yHeight)
        ?? parseFiniteNumber((row as any)?.y)
        ?? parseFiniteNumber((row as any)?.["object y"])
        ?? 0,
    };

    try {
      const effective = convertImageHeightToEffectiveObject(row, opticalSystemRows, wavelength, conjugateType, {
        skipTsValidation: true,
        validationTraceBackend: 'rust',
      });
      if (effective && typeof effective === "object") {
        return {
          ...row,
          ...effective,
          __cooptImageHeightTarget: preservedTarget,
          position: (row as any)?.position,
          __cooptOriginalPosition: row.position,
        };
      }
    } catch (_) {
      // Fall through to the original row so the existing path still runs.
    }

    return {
      ...row,
      __cooptImageHeightTarget: preservedTarget,
      __cooptOriginalPosition: row.position,
    };
  });
}

function buildTransverseFieldSettingsFromObjectRows(objectRows: any[] = []): any[] {
  return objectRows.map((row, index) => {
    const originalPositionType = String((row as any)?.__cooptOriginalPosition ?? (row as any)?.position ?? (row as any)?.fieldType ?? (row as any)?.type ?? "").trim().toLowerCase();
    const positionType = String((row as any)?.position ?? (row as any)?.fieldType ?? (row as any)?.type ?? "").trim().toLowerCase();
    const isAngle = positionType.includes("angle") && !positionType.includes("rect") && !positionType.includes("height");
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
    const pointX = pointModeLabel === "Angle"
      ? parseNumber((row as any)?.xFieldAngle ?? (row as any)?.xAngle ?? (row as any)?.xHeightAngle ?? (row as any)?.x)
      : pointModeLabel === "Image Height"
        ? imageHeightTargetX ?? parseNumber((row as any)?.xHeight ?? (row as any)?.x ?? (row as any)?.["object x"] ?? (row as any)?.xHeightAngle)
      : parseNumber((row as any)?.xHeight ?? (row as any)?.x ?? (row as any)?.xHeightAngle ?? (row as any)?.["object x"]);
    const pointY = pointModeLabel === "Angle"
      ? parseNumber((row as any)?.yFieldAngle ?? (row as any)?.fieldAngle ?? (row as any)?.yAngle ?? (row as any)?.yHeightAngle ?? (row as any)?.y)
      : pointModeLabel === "Image Height"
        ? imageHeightTargetY ?? parseNumber((row as any)?.yHeight ?? (row as any)?.y ?? (row as any)?.["object y"] ?? (row as any)?.yHeightAngle)
      : parseNumber((row as any)?.yHeight ?? (row as any)?.y ?? (row as any)?.yHeightAngle ?? (row as any)?.["object y"]);
    const pointXText = Number.isFinite(pointX as number) ? (pointX as number).toFixed(3) : "0.000";
    const pointYText = Number.isFinite(pointY as number) ? (pointY as number).toFixed(3) : "0.000";
    const displayNameBase = String((row as any)?.comment ?? (row as any)?.name ?? "").trim();
    const displayNameCore = `Object ${index + 1} (${pointModeLabel}: X=${pointXText} ${pointUnit}, Y=${pointYText} ${pointUnit})`;
    const displayName = displayNameBase ? `${displayNameCore} - ${displayNameBase}` : displayNameCore;

    if (isAngle) {
      const xAngle = Number.isFinite(pointX as number) ? Number(pointX) : 0;
      const yAngle = Number.isFinite(pointY as number) ? Number(pointY) : 0;
      return {
        objectIndex: index + 1,
        fieldType: "Angle",
        fieldAngle: yAngle,
        xFieldAngle: xAngle,
        yFieldAngle: yAngle,
        displayName,
      };
    }

    const xHeight = Number.isFinite(pointX as number) ? Number(pointX) : 0;
    const yHeight = Number.isFinite(pointY as number) ? Number(pointY) : 0;
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
  const thickness = (row0 as any)?.thickness ?? (row0 as any)?.Thickness ?? (row0 as any)?.distance;
  return !isInfinitySpec(thickness);
}

function getObjectDistanceMmNativeLike(opticalSystemRows: any[]): number {
  const row0 = Array.isArray(opticalSystemRows) ? opticalSystemRows[0] : null;
  if (!row0 || typeof row0 !== "object") return 0;
  const raw = (row0 as any)?.thickness ?? (row0 as any)?.Thickness ?? (row0 as any)?.distance;
  if (isInfinitySpec(raw)) return 0;
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

function deriveGridFieldModeNativeLike(objectRows: any[]): "angle" | "height" | "imageheight" {
  const rows = Array.isArray(objectRows) ? objectRows : [];
  if (rows.some((row) => getObjectPositionTagNativeLike(row).includes("imageheight"))) return "imageheight";
  if (rows.some((row) => {
    const tag = getObjectPositionTagNativeLike(row);
    return tag.includes("rectangle") || tag.includes("rect") || tag.includes("height");
  })) {
    return "height";
  }
  if (rows.some((row) => getObjectPositionTagNativeLike(row).includes("angle"))) return "angle";

  const hasNumericHeight = rows.some((row) => {
    const value = Number(row?.yHeight ?? row?.y ?? row?.height ?? row?.["object y"]);
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
      x: pick(row?.__cooptImageHeightTarget?.x, row?.xHeight, row?.x, row?.["object x"], row?.xHeightAngle),
      y: pick(row?.__cooptImageHeightTarget?.y, row?.yHeight, row?.y, row?.["object y"], row?.yHeightAngle),
    };
  }

  if (mode === "height") {
    return {
      x: pick(row?.xHeight, row?.x, row?.["object x"], row?.xHeightAngle),
      y: pick(row?.yHeight, row?.y, row?.["object y"], row?.yHeightAngle),
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

  const removeDefocus = m === "pistontiltdefocusremoved";
  const basisDim = removeDefocus ? 4 : 3;

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

      const phi = removeDefocus
        ? [1.0, xn, yn, 2.0 * rn2 - 1.0]
        : [1.0, u, v, 0.0];
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

      let fit = coeff[0] + coeff[1] * u + coeff[2] * v;
      if (removeDefocus) {
        fit = coeff[0] + coeff[1] * xn + coeff[2] * yn + coeff[3] * (2.0 * rn2 - 1.0);
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

    if (Array.isArray(payload?.raySeries) && payload.raySeries.length > 0) {
      const { traceRayEvalBatchSummary } = await import("../../../raytracing/core/ray-tracing.ts");
      const requestSeries = payload.raySeries;
      const traceStartMs = nowMs();
      const traceOptions = {
        useRustWasm: true,
        requireRustWasm: true,
        allowNonStrict: false,
      } as any;

      const series = requestSeries.map((entry: any, idx: number) => {
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

        const summaries = traceRayEvalBatchSummary(opticalSystemRows, batch, 1.0, targetSurface, traceOptions);
        const normalizedSummaries = Array.isArray(summaries) ? summaries : [];
        const chiefIdx = rays.findIndex((r: any) => r?.isChief === true);
        const points = normalizedSummaries
          .map((s: any, rayIndex: number) => {
            if (!s?.success || !s?.hitPoint) return null;
            const xUm = Number(s?.hitPoint?.x) * 1000;
            const yUm = Number(s?.hitPoint?.y) * 1000;
            if (!Number.isFinite(xUm) || !Number.isFinite(yUm)) return null;
            return {
              xUm,
              yUm,
              rayIndex,
              isChiefRay: rayIndex === chiefIdx,
            };
          })
          .filter((p: any) => !!p);
        const chiefSummary = (chiefIdx >= 0 && chiefIdx < normalizedSummaries.length)
          ? normalizedSummaries[chiefIdx]
          : normalizedSummaries.find((s: any) => !!s?.success && s?.hitPoint);
        const chiefPointUm = (chiefSummary && chiefSummary.hitPoint)
          ? { xUm: Number(chiefSummary.hitPoint.x) * 1000, yUm: Number(chiefSummary.hitPoint.y) * 1000 }
          : undefined;
        const statusCounts = normalizedSummaries.reduce((acc: Record<string, number>, s: any) => {
          const status = String(s?.status || (s?.success ? "ok" : "unknown"));
          acc[status] = (acc[status] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        const wl = rays.find((r: any) => Number(r?.wavelengthUm) > 0)?.wavelengthUm;

        return {
          label: String(entry?.label || `Series ${idx + 1}`),
          color: String(entry?.color || toSeriesColor(idx)),
          objectIndex: idx,
          wavelengthUm: Number(wl) > 0 ? Number(wl) : undefined,
          points,
          chiefPointUm,
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
        backend: "web-rust-wasm",
        surfaceIndex: targetSurface,
        tracedRays: totalHitRays,
        requestedRays: totalAttemptedRays,
        generatedRays: totalAttemptedRays,
        wavelengthCount: new Set(series.map((s: any) => Number(s.wavelengthUm)).filter((v: number) => Number.isFinite(v) && v > 0)).size,
        seriesCount: seriesStats.length,
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
    const sourceRowsRaw = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
    const sourceRows = pickPrimarySourceRowsNativeLike(sourceRowsRaw, payload?.wavelengthMode);
    const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
    const rayCount = Number.isInteger(payload?.rayCount) ? Math.max(1, Number(payload.rayCount)) : 501;
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
    const series = spotData.map((obj: any, idx: number) => {
      const pointsRaw = Array.isArray(obj?.spotPoints) ? obj.spotPoints : [];
      const points = pointsRaw
        .map((p: any) => ({
          xUm: Number(p?.x) * 1000,
          yUm: Number(p?.y) * 1000,
          rayIndex: Number.isInteger(p?.rayIndex) ? Number(p.rayIndex) : undefined,
          isChiefRay: p?.isChiefRay === true,
          pupilU: Number.isFinite(Number(p?.pupilU)) ? Number(p.pupilU) : undefined,
          pupilV: Number.isFinite(Number(p?.pupilV)) ? Number(p.pupilV) : undefined,
        }))
        .filter((p: any) => Number.isFinite(p.xUm) && Number.isFinite(p.yUm));
      // Native spot behavior: if a strict chief marker is unavailable,
      // use the first successful hit as chief fallback.
      const chiefSrc = (
        pointsRaw.find((p: any) => p?.isChiefRay === true)
        || pointsRaw[0]
      );
      const chiefPointUm = chiefSrc
        ? { xUm: Number(chiefSrc?.x) * 1000, yUm: Number(chiefSrc?.y) * 1000 }
        : undefined;
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
      Number.isInteger(payload?.rayCount) ? Number(payload.rayCount) : 51,
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

    return {
      backend: String((wasmOut as any)?.backend || "web-rust-wasm"),
      metrics,
      message: String((wasmOut as any)?.message || "Computed via Web Rust/WASM paraxial metrics API"),
    } as NativeParaxialMetricsResponse;
  }

  return invokeCommand<NativeParaxialMetricsRequest, NativeParaxialMetricsResponse>(
    "run_native_paraxial_metrics",
    {
      opticalSystemRows,
      sourceRows,
      objectRows,
    },
  );
}

export async function runNativeSeidel(
  payload: NativeSeidelRequest,
): Promise<NativeSeidelResponse> {
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
  const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
  const afocal = payload?.afocal === true;
  const referenceWavelengthUm = Number(payload?.referenceWavelengthUm);

  if (!isTauriRuntime()) {
    if (opticalSystemRows.length === 0) throw new Error("runNativeSeidel(web): opticalSystemRows is empty");

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
      opticalSystemRows,
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

export async function runNativeAstigmatism(
  payload: NativeAstigmatismRequest,
): Promise<NativeAstigmatismResponse> {
  if (!isTauriRuntime()) {
    const {
      calculateAstigmatismDataNativeLike,
    } = await import("../../../evaluation/aberrations/astigmatism.ts");
    const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
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

    return {
      ...(result as any),
      backend: "web-rust-wasm",
      message: "Computed via Web Rust/WASM astigmatism API",
    } as NativeAstigmatismResponse;
  }
  return invokeCommand<NativeAstigmatismRequest, NativeAstigmatismResponse>("run_native_astigmatism", payload);
}

export async function runNativeTransverseAberration(
  payload: NativeTransverseAberrationRequest,
): Promise<NativeTransverseAberrationResponse> {
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
  const normalizedObjectRows = await normalizeTransverseObjectRowsForImageHeight(
    opticalSystemRows,
    sourceRows,
    Array.isArray(payload?.objectRows) ? payload.objectRows : [],
    Number(payload?.wavelength),
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
        // Keep Paraxial/ThinLens compatible with the same non-strict fallback path
        // used by Spot Diagram and Grid Distortion in web mode.
        requireRustWasm: false,
      },
    );
    if (!result) throw new Error("Web transverse aberration calculation failed");
    return {
      ...(result as any),
      backend: "web-rust-wasm",
      message: "Computed via Web Rust/WASM transverse aberration API",
    } as NativeTransverseAberrationResponse;
  }
  const normalizedPayload = {
    ...payload,
    opticalSystemRows,
    sourceRows,
    objectRows: normalizedObjectRows,
  };
  return invokeCommand<NativeTransverseAberrationRequest, NativeTransverseAberrationResponse>(
    "run_native_transverse_aberration",
    normalizedPayload,
  );
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

function hasParaxialOrThinLensNativeLike(opticalSystemRows: any[] = []): boolean {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return false;

  for (const row of opticalSystemRows) {
    if (!row || typeof row !== "object") continue;
    const surfType = String((row as any)?.surfType ?? (row as any)?.type ?? (row as any)?.surfaceType ?? "").trim().toLowerCase();
    const blockType = String((row as any)?._blockType ?? (row as any)?.blockType ?? "").trim().toLowerCase();
    const isIdealParaxial = (
      blockType === "paraxial"
      || blockType === "thinlens"
      || surfType === "thinlens"
      || Number.isFinite(Number((row as any)?._thinLensFocalLengthX))
      || Number.isFinite(Number((row as any)?._thinLensFocalLengthY))
    );
    if (isIdealParaxial) return true;
  }
  return false;
}

function isIdealParaxialOnlyNativeOpdSystem(opticalSystemRows: any[] = []): boolean {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return false;

  let hasIdealParaxial = false;
  for (const row of opticalSystemRows) {
    if (!row || typeof row !== "object") continue;

    const objectType = String((row as any)?.["object type"] ?? (row as any)?.object ?? (row as any)?.Object ?? "").trim().toLowerCase();
    const surfType = String((row as any)?.surfType ?? (row as any)?.type ?? (row as any)?.surfaceType ?? "").trim().toLowerCase();
    const blockType = String((row as any)?._blockType ?? (row as any)?.blockType ?? "").trim().toLowerCase();

    const isIdealParaxial = (
      blockType === "paraxial"
      || blockType === "thinlens"
      || surfType === "thinlens"
      || Number.isFinite(Number((row as any)?._thinLensFocalLengthX))
      || Number.isFinite(Number((row as any)?._thinLensFocalLengthY))
    );
    if (isIdealParaxial) {
      hasIdealParaxial = true;
      continue;
    }

    const isPassiveRow = (
      objectType === ""
      || objectType === "object"
      || objectType === "image"
      || objectType === "stop"
      || surfType === "gap"
      || surfType === "air gap"
      || blockType === "gap"
      || blockType === "air gap"
      || surfType === "coordinate break"
      || surfType === "coordbrk"
      || blockType === "coordinate break"
      || blockType === "coordbrk"
    );
    if (isPassiveRow) continue;

    return false;
  }

  return hasIdealParaxial;
}

function computeFiniteGridRmsNativeLike(grid: any): number {
  if (!Array.isArray(grid) || grid.length === 0) return Number.NaN;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (const row of grid) {
    if (!Array.isArray(row)) continue;
    for (const value of row) {
      const numeric = Number(value);
      if (numeric === 0) continue;
      if (!Number.isFinite(numeric)) continue;
      sum += numeric;
      sumSq += numeric * numeric;
      count += 1;
    }
  }
  if (count === 0) return Number.NaN;
  const mean = sum / count;
  const variance = Math.max(0, (sumSq / count) - (mean * mean));
  return Math.sqrt(variance);
}

function parseThinLensFocalValueNativeLike(value: unknown): number {
  if (isInfinitySpec(value)) return Number.POSITIVE_INFINITY;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || Math.abs(numeric) < 1e-12) return Number.POSITIVE_INFINITY;
  return Math.abs(numeric);
}

function getThinLensFocalPairNativeLike(row: any): { fx: number; fy: number } {
  return {
    fx: parseThinLensFocalValueNativeLike(row?._thinLensFocalLengthX ?? row?.focalLengthX ?? row?.focalLength ?? row?._thinLensFocalLengthY ?? row?.focalLengthY),
    fy: parseThinLensFocalValueNativeLike(row?._thinLensFocalLengthY ?? row?.focalLengthY ?? row?.focalLength ?? row?._thinLensFocalLengthX ?? row?.focalLengthX),
  };
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
  if (!isIdealParaxialOnlyNativeOpdSystem(opticalSystemRows) || !response || typeof response !== "object") {
    return response;
  }

  const displayRms = Number((response as any).rmsWaves);
  if (!(Number.isFinite(displayRms) && displayRms <= 2e-2)) {
    return response;
  }

  return {
    ...response,
    rmsWaves: 0,
    message: String((response as any).message || "") + " [ideal-paraxial-display-normalized]",
  } as NativeOpdRmsWavesResponse;
}

export async function runNativeOpdMap(
  payload: NativeOpdMapRequest,
): Promise<NativeOpdMapResponse> {
  const normalizedPayload: NativeOpdMapRequest = {
    ...(payload || {} as any),
    surfaceIndex: Number.isInteger((payload as any)?.surfaceIndex)
      ? Math.max(0, Number((payload as any).surfaceIndex))
      : pickImageSurfaceIndexNativeLike(Array.isArray((payload as any)?.opticalSystemRows) ? (payload as any).opticalSystemRows : []),
  } as NativeOpdMapRequest;
  payload = normalizedPayload;
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
  if (!isTauriRuntime()) {
    if (opticalSystemRows.length === 0) throw new Error("runNativeOpdMap(web): opticalSystemRows is empty");

    const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
    const inputObjectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
    const objectRows = await normalizeTransverseObjectRowsForImageHeight(
      opticalSystemRows,
      sourceRows,
      inputObjectRows,
      Number(payload?.wavelengthUm),
    );
    const objectIndex = Number.isInteger(payload?.objectIndex) ? Math.max(0, Number(payload.objectIndex)) : 0;
    const selectedObject = objectRows[objectIndex] || objectRows[0] || {};
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
    const objectType = String((selectedObject as any)?.position ?? (selectedObject as any)?.object ?? '').toLowerCase();
    const isAngle = objectType.includes("angle") || objectType === "point";
    const xVal = Number((selectedObject as any)?.xHeightAngle ?? (selectedObject as any)?.xFieldAngle ?? (selectedObject as any)?.xHeight ?? (selectedObject as any)?.x ?? 0) || 0;
    const yVal = Number((selectedObject as any)?.yHeightAngle ?? (selectedObject as any)?.yFieldAngle ?? (selectedObject as any)?.fieldAngle ?? (selectedObject as any)?.yHeight ?? (selectedObject as any)?.y ?? 0) || 0;
    const gridSize = Number.isFinite(Number(payload?.gridSize)) ? Math.max(17, Math.floor(Number(payload.gridSize))) : 129;
    const requestedPupilSamplingMode = (payload?.pupilSamplingMode === "stop" || payload?.pupilSamplingMode === "entrance")
      ? payload.pupilSamplingMode
      : (isInfiniteConjugateRows(opticalSystemRows) ? "entrance" : "stop");
    const opdDisplayMode = String(payload?.opdDisplayMode || "pistonTiltRemoved");
    const targetSurface = Number.isInteger(payload?.surfaceIndex) && Number(payload.surfaceIndex) >= 0
      ? Number(payload.surfaceIndex)
      : pickImageSurfaceIndexNativeLike(opticalSystemRows);

    if (isImageHeightNativeObjectRow(selectedObject) || isAngle) {
      return clampIdealParaxialNativeOpdResponse(
        opticalSystemRows,
        await computeReferenceOpdMapViaRustTracedJsMath(
          opticalSystemRows,
          objectRows,
          objectIndex,
          wavelengthUm,
          gridSize,
          requestedPupilSamplingMode,
          opdDisplayMode,
        ),
      );
    }

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
      opticalSystemRows,
      sourceRows,
      objectRows,
      objectIndex,
      surfaceIndex: targetSurface,
      gridSize,
      wavelengthUm,
      pupilSamplingMode: requestedPupilSamplingMode,
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

    return clampIdealParaxialNativeOpdResponse(opticalSystemRows, {
      backend: String(wasmOut?.backend || "web-rust-wasm-native-api"),
      chiefReferenceMode: String(wasmOut?.chiefReferenceMode || ""),
      targetSurface: Number.isFinite(Number(wasmOut?.targetSurface)) ? Number(wasmOut.targetSurface) : targetSurface,
      stopSurface: Number.isFinite(Number(wasmOut?.stopSurface)) ? Number(wasmOut.stopSurface) : 0,
      requestedObjectIndex: objectIndex,
      usedObjectIndex: Number.isFinite(Number(wasmOut?.usedObjectIndex)) ? Number(wasmOut.usedObjectIndex) : objectIndex,
      usedObjectPosition: String(wasmOut?.usedObjectPosition || (isAngle ? "angle" : "height")),
      usedObjectX: Number.isFinite(Number(wasmOut?.usedObjectX)) ? Number(wasmOut.usedObjectX) : xVal,
      usedObjectY: Number.isFinite(Number(wasmOut?.usedObjectY)) ? Number(wasmOut.usedObjectY) : yVal,
      wavelengthUm,
      gridSize: Number.isFinite(Number(wasmOut?.gridSize)) ? Number(wasmOut.gridSize) : gridSize,
      sampleCount: Number.isFinite(Number(wasmOut?.sampleCount)) ? Number(wasmOut.sampleCount) : 0,
      hitCount: Number.isFinite(Number(wasmOut?.hitCount)) ? Number(wasmOut.hitCount) : 0,
      pupilSamplingMode: String(wasmOut?.pupilSamplingMode || requestedPupilSamplingMode),
      rawOpdGrid,
      displayOpdGrid,
      referenceSphereOpdGrid,
      message: String(wasmOut?.message || "Computed via Rust-WASM native OPD API"),
    } as NativeOpdMapResponse);
  }
  const nativeResponse = await invokeCommand<NativeOpdMapRequest, NativeOpdMapResponse>("run_native_opd_map", normalizedPayload);
  return clampIdealParaxialNativeOpdResponse(
    Array.isArray(normalizedPayload?.opticalSystemRows) ? normalizedPayload.opticalSystemRows : [],
    nativeResponse,
  );
}

export async function runNativeOpdRmsWaves(
  payload: NativeOpdRmsWavesRequest,
): Promise<NativeOpdRmsWavesResponse> {
  const normalizedPayload: NativeOpdRmsWavesRequest = {
    ...(payload || {} as any),
    surfaceIndex: Number.isInteger((payload as any)?.surfaceIndex)
      ? Math.max(0, Number((payload as any).surfaceIndex))
      : pickImageSurfaceIndexNativeLike(Array.isArray((payload as any)?.opticalSystemRows) ? (payload as any).opticalSystemRows : []),
  } as NativeOpdRmsWavesRequest;
  payload = normalizedPayload;
  const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
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
    const isAngle = objectType.includes("angle") || objectType === "point";
    const xVal = Number((requestedObject as any)?.xHeightAngle ?? (requestedObject as any)?.xFieldAngle ?? (requestedObject as any)?.xHeight ?? (requestedObject as any)?.x ?? 0) || 0;
    const yVal = Number((requestedObject as any)?.yHeightAngle ?? (requestedObject as any)?.yFieldAngle ?? (requestedObject as any)?.fieldAngle ?? (requestedObject as any)?.yHeight ?? (requestedObject as any)?.y ?? 0) || 0;
    const gridSize = Number.isFinite(Number(payload?.gridSize)) ? Math.max(17, Math.floor(Number(payload.gridSize))) : 129;
    const requestedPupilSamplingMode = (payload?.pupilSamplingMode === "stop" || payload?.pupilSamplingMode === "entrance")
      ? payload.pupilSamplingMode
      : (isInfiniteConjugateRows(opticalSystemRows) ? "entrance" : "stop");
    const opdDisplayMode = String(payload?.opdDisplayMode || "pistonTiltRemoved");
    const targetSurface = Number.isInteger(payload?.surfaceIndex) && Number(payload.surfaceIndex) >= 0
      ? Number(payload.surfaceIndex)
      : pickImageSurfaceIndexNativeLike(opticalSystemRows);

    if (isImageHeightNativeObjectRow(requestedObject)) {
      const mapResponse = await computeReferenceOpdMapViaRustTracedJsMath(
        opticalSystemRows,
        objectRows,
        objectIndex,
        wavelengthUm,
        gridSize,
        requestedPupilSamplingMode,
        opdDisplayMode,
      );
      return clampIdealParaxialNativeOpdRmsResponse(opticalSystemRows, {
        backend: String(mapResponse?.backend || "web-rust-wasm-js-reference"),
        chiefReferenceMode: String(mapResponse?.chiefReferenceMode || ""),
        targetSurface: Number.isFinite(Number(mapResponse?.targetSurface)) ? Number(mapResponse.targetSurface) : targetSurface,
        stopSurface: Number.isFinite(Number(mapResponse?.stopSurface)) ? Number(mapResponse.stopSurface) : 0,
        requestedObjectIndex: objectIndex,
        usedObjectIndex: Number.isFinite(Number(mapResponse?.usedObjectIndex)) ? Number(mapResponse.usedObjectIndex) : objectIndex,
        usedObjectPosition: String(mapResponse?.usedObjectPosition || (isAngle ? "angle" : "height")),
        usedObjectX: Number.isFinite(Number(mapResponse?.usedObjectX)) ? Number(mapResponse.usedObjectX) : xVal,
        usedObjectY: Number.isFinite(Number(mapResponse?.usedObjectY)) ? Number(mapResponse.usedObjectY) : yVal,
        wavelengthUm,
        gridSize: Number.isFinite(Number(mapResponse?.gridSize)) ? Number(mapResponse.gridSize) : gridSize,
        sampleCount: Number.isFinite(Number(mapResponse?.sampleCount)) ? Number(mapResponse.sampleCount) : 0,
        hitCount: Number.isFinite(Number(mapResponse?.hitCount)) ? Number(mapResponse.hitCount) : 0,
        pupilSamplingMode: mapResponse?.pupilSamplingMode === "entrance" ? "entrance" : "stop",
        rmsWaves: computeFiniteGridRmsNativeLike(Array.isArray(mapResponse?.displayOpdGrid) ? mapResponse.displayOpdGrid : []),
        message: String(mapResponse?.message || "Computed via JS reference-sphere math with Rust/WASM ray tracing"),
      } as NativeOpdRmsWavesResponse);
    }

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
      opticalSystemRows,
      sourceRows,
      objectRows,
      objectIndex,
      surfaceIndex: targetSurface,
      gridSize,
      wavelengthUm,
      pupilSamplingMode: requestedPupilSamplingMode,
      opdDisplayMode,
    }));
    const wasmOut = (typeof wasmOutRaw === "string") ? JSON.parse(wasmOutRaw) : wasmOutRaw;
    return clampIdealParaxialNativeOpdRmsResponse(opticalSystemRows, {
      backend: String(wasmOut?.backend || "web-rust-wasm-native-api"),
      chiefReferenceMode: String(wasmOut?.chiefReferenceMode || ""),
      targetSurface: Number.isFinite(Number(wasmOut?.targetSurface)) ? Number(wasmOut.targetSurface) : targetSurface,
      stopSurface: Number.isFinite(Number(wasmOut?.stopSurface)) ? Number(wasmOut.stopSurface) : 0,
      requestedObjectIndex: objectIndex,
      usedObjectIndex: Number.isFinite(Number(wasmOut?.usedObjectIndex)) ? Number(wasmOut.usedObjectIndex) : objectIndex,
      usedObjectPosition: String(wasmOut?.usedObjectPosition || (isAngle ? "angle" : "height")),
      usedObjectX: Number.isFinite(Number(wasmOut?.usedObjectX)) ? Number(wasmOut.usedObjectX) : xVal,
      usedObjectY: Number.isFinite(Number(wasmOut?.usedObjectY)) ? Number(wasmOut.usedObjectY) : yVal,
      wavelengthUm,
      gridSize: Number.isFinite(Number(wasmOut?.gridSize)) ? Number(wasmOut.gridSize) : gridSize,
      sampleCount: Number.isFinite(Number(wasmOut?.sampleCount)) ? Number(wasmOut.sampleCount) : 0,
      hitCount: Number.isFinite(Number(wasmOut?.hitCount)) ? Number(wasmOut.hitCount) : 0,
      pupilSamplingMode: wasmOut?.pupilSamplingMode === "entrance" ? "entrance" : "stop",
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
    const { PSFCalculator } = await import("../../../evaluation/psf/psf-calculator.ts");
    const size = Array.isArray(payload?.gridOpd) ? payload.gridOpd.length : 0;
    if (size <= 0) throw new Error("runNativePsfMap(web): gridOpd is empty");

    const toGrid = (src: any, fallback = 0) =>
      Array.from({ length: size }, (_, y) =>
        Float32Array.from(
          Array.from({ length: size }, (_, x) => {
            const v = Number(src?.[y]?.[x]);
            return Number.isFinite(v) ? v : fallback;
          }),
        ),
      );
    const opdGrid = toGrid(payload.gridOpd, 0);
    const ampGrid = toGrid(payload.gridAmplitude, 1);
    const maskGrid = Array.from({ length: size }, (_, y) =>
      Array.from({ length: size }, (_, x) => !!payload?.pupilMask?.[y]?.[x]),
    );
    const xCoords = Array.from({ length: size }, (_, i) => -1 + (2 * i) / Math.max(1, size - 1));
    const yCoords = xCoords.slice();

    const calc = new PSFCalculator();
    const res = await calc.calculatePSF(
      {
        wavelength: Number(payload?.wavelengthUm) || 0.5876,
        gridData: {
          opd: opdGrid,
          amplitude: ampGrid,
          pupilMask: maskGrid,
          xCoords,
          yCoords,
        },
      },
      {
        samplingSize: size,
        wavelength: Number(payload?.wavelengthUm) || 0.5876,
        pixelSize: Number.isFinite(Number(payload?.pixelSizeUm)) ? Number(payload?.pixelSizeUm) : null,
        removeTilt: payload?.removeTilt !== false,
        zeroPadTo: Number.isFinite(Number(payload?.zeroPadTo)) ? Number(payload.zeroPadTo) : 0,
        recenterIfWrapped: payload?.recenterIfWrapped === true,
        // Web native mode must stay on Rust/WASM FFT path.
        forceWasmFFT: true,
      },
    );
    return {
      backend: "web-rust-wasm",
      gridSize: size,
      fftSize: Array.isArray((res as any)?.psfData) ? (res as any).psfData.length : size,
      psfData: Array.isArray((res as any)?.psfData) ? (res as any).psfData : [],
      metrics: ((res as any)?.metrics || {}) as any,
      pixelSizeUm: Number.isFinite(Number((res as any)?.metadata?.pixelSize))
        ? Number((res as any).metadata.pixelSize)
        : (Number.isFinite(Number((res as any)?.options?.pixelSize))
            ? Number((res as any).options.pixelSize)
            : undefined),
      message: "Computed via Web Rust/WASM PSF API",
    };
  }
  return invokeCommand<NativePsfMapRequest, NativePsfMapResponse>("run_native_psf_map", payload);
}

export async function runNativeMtfMap(
  payload: NativeMtfMapRequest,
): Promise<NativeMtfMapResponse> {
  if (!isTauriRuntime()) {
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

    const dfLpmm = (1 / (n * pixelSizeUm)) * 1000;
    const nyquistLpmm = (0.5 / pixelSizeUm) * 1000;
    const maxFreqReq = Number.isFinite(Number(payload?.maxFrequencyLpmm)) ? Number(payload.maxFrequencyLpmm) : nyquistLpmm;
    const maxFreq = Math.max(0, Math.min(maxFreqReq, nyquistLpmm));
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

    const points = Math.max(2, Math.min(2048, Math.floor(Number(payload?.points) || freqDiscrete.length)));
    const directEvalOnly = !!payload?.directEvalOnly;
    const sampledFrequenciesLpmm = (Array.isArray(payload?.sampleFrequenciesLpmm) ? payload.sampleFrequenciesLpmm : [])
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 0);
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
      for (let i = 0; i < points; i++) {
        const f = (i / Math.max(1, points - 1)) * maxFreq;
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
    const samplingSize = Math.max(32, Math.min(4096, Math.floor(Number(payload?.samplingSize) || 256)));

    const zeroPadTo = Math.floor(Number(payload?.zeroPadTo) || 0);
    const requestedFftSize = (Number.isFinite(zeroPadTo) && zeroPadTo >= samplingSize)
      ? zeroPadTo
      : samplingSize;
    const pixelSizeUm = (Number.isFinite(Number(payload?.pixelSizeUm)) && Number(payload?.pixelSizeUm) > 0)
      ? Number(payload?.pixelSizeUm)
      : 1.0;
    const opdDisplayMode = String(payload?.opdDisplayMode || "pistonTiltRemoved");

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

    const totalRuns = Math.max(1, wavelengths.length * xAxis.length);
    let completed = 0;
    const series: Array<{ wavelengthUm: number; label: string; mtfTangential: number[]; mtfSagittal: number[] }> = [];

    // Load WASM once before the computation loops so PSF/MTF use the same
    // null-cell handling as the native Tauri path.
    let _wasmPsfFn: ((json: string) => unknown) | null = null;
    let _wasmMtfFn: ((json: string) => unknown) | null = null;
    try {
      const { preloadRustRayTracingWasm } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
      const rust = await preloadRustRayTracingWasm();
      const psfFn = (rust as any)?.run_native_psf_from_opd_wasm_json;
      const mtfFn = (rust as any)?.run_native_mtf_from_psf_wasm_json;
      if (typeof psfFn === "function" && typeof mtfFn === "function") {
        _wasmPsfFn = psfFn;
        _wasmMtfFn = mtfFn;
      }
    } catch (_) {}

    for (let wi = 0; wi < wavelengths.length; wi++) {
      const wl = wavelengths[wi];
      const tanVec: number[] = [];
      const sagVec: number[] = [];

      for (let si = 0; si < xAxis.length; si++) {
        const defocusMm = xAxis[si];
        const shiftedRows = cloneOpticalSystemRowsWithDefocusShiftNativeLike(opticalSystemRows as any[], defocusMm);

        const opdResp = await runNativeOpdMap({
          opticalSystemRows: shiftedRows,
          sourceRows,
          objectRows,
          objectIndex,
          surfaceIndex: undefined,
          gridSize: samplingSize,
          wavelengthUm: wl,
          pupilSamplingMode: payload?.pupilSamplingMode,
          opdDisplayMode,
        } as NativeOpdMapRequest);

        if (_wasmPsfFn !== null && _wasmMtfFn !== null) {
          // ── WASM path: correctly handles null = outside-pupil cells ──────────
          // OPD grids are passed in waves (with null for outside pupil).
          // The WASM function converts waves→µm internally and skips null cells,
          // matching the native Tauri `run_native_psf_map` behaviour exactly.
          const psfReqJson = JSON.stringify({
            rawOpdGrid: opdResp.rawOpdGrid,
            displayOpdGrid: opdResp.displayOpdGrid,
            wavelengthUm: wl,
            pixelSizeUm,
            zeroPadTo: requestedFftSize,
            removeTilt: false,
          });
          const psfRaw = _wasmPsfFn(psfReqJson);
          const psfOut: any = typeof psfRaw === "string" ? JSON.parse(psfRaw) : psfRaw;

          const mtfReqJson = JSON.stringify({
            psfData: psfOut?.psfData,
            pixelSizeUm,
            maxFrequencyLpmm: Math.max(targetFreqLpmm * 2, 1),
            targetFrequencyLpmm: targetFreqLpmm,
            points: 121,
          });
          const mtfRaw = _wasmMtfFn(mtfReqJson);
          const mtfOut: any = typeof mtfRaw === "string" ? JSON.parse(mtfRaw) : mtfRaw;

          const tanVal = Number(mtfOut?.targetMtfTangential);
          const sagVal = Number(mtfOut?.targetMtfSagittal);
          tanVec.push(Number.isFinite(tanVal) ? tanVal : 0);
          sagVec.push(Number.isFinite(sagVal) ? sagVal : 0);
        } else {
          // ── TypeScript fallback: null-cell bug fixed ──────────────────────────
          // Cells with null rawOpdGrid value are outside the pupil; skip them.
          const s = samplingSize;
          const gridOpd = Array.from({ length: s }, () => Array.from({ length: s }, () => 0));
          const pupilMask = Array.from({ length: s }, () => Array.from({ length: s }, () => false));
          const raw = Array.isArray(opdResp?.rawOpdGrid) ? opdResp.rawOpdGrid : [];
          const display = Array.isArray(opdResp?.displayOpdGrid) ? opdResp.displayOpdGrid : [];
          for (let iy = 0; iy < s; iy++) {
            for (let ix = 0; ix < s; ix++) {
              const rawCellVal = (raw as any)?.[iy]?.[ix];
              // null / undefined → outside pupil → skip (was Number(null)=0 bug)
              if (rawCellVal === null || rawCellVal === undefined) continue;
              const rawCell = Number(rawCellVal);
              if (!Number.isFinite(rawCell)) continue;
              const displayCellVal = (display as any)?.[iy]?.[ix];
              const dispNum = (displayCellVal !== null && displayCellVal !== undefined) ? Number(displayCellVal) : NaN;
              const waves = Number.isFinite(dispNum) ? dispNum : rawCell;
              pupilMask[iy][ix] = true;
              gridOpd[iy][ix] = waves * wl;
            }
          }

          const psfResp = await runNativePsfMap({
            gridOpd,
            pupilMask,
            gridAmplitude: [],
            wavelengthUm: wl,
            pixelSizeUm,
            removeTilt: false,
            zeroPadTo: requestedFftSize,
            recenterIfWrapped: false,
          } as NativePsfMapRequest);

          const mtfResp = await runNativeMtfMap({
            psfData: psfResp.psfData,
            pixelSizeUm,
            maxFrequencyLpmm: Math.max(targetFreqLpmm * 2, 1),
            points: 121,
          } as NativeMtfMapRequest);

          tanVec.push(interpolateAxisValue(mtfResp.frequencyAxis || [], mtfResp.mtfTangential || [], targetFreqLpmm));
          sagVec.push(interpolateAxisValue(mtfResp.frequencyAxis || [], mtfResp.mtfSagittal || [], targetFreqLpmm));
        }

        completed += 1;
        if (typeof onProgress === "function") {
          const percent = 10 + (completed / totalRuns) * 85;
          onProgress({
            percent: Math.max(0, Math.min(100, percent)),
            message: `Computing TF-MTF: λ=${(wl * 1000).toFixed(1)}nm (${wi + 1}/${wavelengths.length}), step ${si + 1}/${xAxis.length}`,
          });
        }
      }

      series.push({
        wavelengthUm: wl,
        label: `${(wl * 1000).toFixed(1)}nm`,
        mtfTangential: tanVec,
        mtfSagittal: sagVec,
      });
    }

    return {
      backend: "web-rust-wasm",
      xAxis,
      series,
      message: "Computed via Web Rust/WASM Through-Focus MTF API",
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

  const samplingSize = Number.isFinite(Number(payload?.samplingSize)) ? Math.max(32, Math.floor(Number(payload?.samplingSize))) : 256;
  const zeroPadToRaw = Number.isFinite(Number(payload?.zeroPadTo)) ? Math.floor(Number(payload?.zeroPadTo)) : 0;
  // Parity with on-axis handleComputeMtf path: when zeroPad is 0 ("auto"),
  // enforce a minimum FFT size of 512 so the pixel pitch used for PSF sampling
  // matches the on-axis pipeline. Without this, real lens systems produce
  // near-zero MTF because pixelSizeUm = basePitch*(sampling/FFT) collapses to
  // the raw airy pitch and undersamples the diffraction-limited PSF lobe.
  const minRecommendedFftSize = 512;
  const requestedFftSize = (!zeroPadToRaw || zeroPadToRaw === 0)
    ? Math.max(samplingSize, minRecommendedFftSize)
    : Math.max(samplingSize, zeroPadToRaw);
  const axisMode = payload?.fieldAxisMode === "height" ? "height" : "angle";
  const firstFrequencyLpmm = Number.isFinite(Number(payload?.firstFrequencyLpmm)) ? Number(payload?.firstFrequencyLpmm) : 10;
  const secondFrequencyLpmm = Number.isFinite(Number(payload?.secondFrequencyLpmm)) ? Number(payload?.secondFrequencyLpmm) : 30;
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
    : (forcedPupilSamplingMode || "entrance");
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
    // Always use entrance-pupil mode, including on-axis (zero field).
    // Stop-mode over-estimates the stop radius, causing ~85% ray failure and a sparse OPD grid
    // which produces a noisy PSF and jagged high-frequency MTF at every field height.
    // The anchored entrance pupil radius from the max field is a good estimate for on-axis too.
    const primaryMode = requestedPupilSamplingMode || "entrance";
    // Use the anchored entrance pupil radius for all fields (including on-axis) for consistency.
    const primaryRadius = fixedPupilRadiusMm;
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
    firstLo: number | null;
    firstHi: number | null;
    secondLo: number | null;
    secondHi: number | null;
  }> => {
    const maxTargetFrequencyLpmm = Math.max(0, Number(firstFrequencyLpmm) || 0, Number(secondFrequencyLpmm) || 0);
    const mtfMaxFrequencyLpmm = Math.max(1, maxTargetFrequencyLpmm * 2);
    const targetFreqs = [firstFrequencyLpmm, secondFrequencyLpmm]
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 0);

    const mtfResp = await runNativeMtfMap({
      psfData,
      pixelSizeUm,
      maxFrequencyLpmm: mtfMaxFrequencyLpmm,
      points: 2,
      sampleFrequenciesLpmm: targetFreqs,
      directEvalOnly: true,
    } as NativeMtfMapRequest);

    const freqAxis = Array.isArray((mtfResp as any)?.frequencyAxis) ? (mtfResp as any).frequencyAxis : [];
    const mtfTangential = Array.isArray((mtfResp as any)?.mtfTangential) ? (mtfResp as any).mtfTangential : [];
    const mtfSagittal = Array.isArray((mtfResp as any)?.mtfSagittal) ? (mtfResp as any).mtfSagittal : [];
    const sampledTangential = Array.isArray((mtfResp as any)?.sampledMtfTangential) ? (mtfResp as any).sampledMtfTangential : [];
    const sampledSagittal = Array.isArray((mtfResp as any)?.sampledMtfSagittal) ? (mtfResp as any).sampledMtfSagittal : [];
    const tanAxis = inferTanAxis(fieldValue, fieldVector);
    const tanVals = tanAxis === "x" ? mtfSagittal : mtfTangential;
    const sagVals = tanAxis === "x" ? mtfTangential : mtfSagittal;

    const hasDirectSamples = sampledTangential.length >= 2 && sampledSagittal.length >= 2;
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

    return {
      firstM,
      firstS,
      secondM,
      secondS,
      firstLo: findLowerBracketValue(freqAxis, firstFrequencyLpmm),
      firstHi: findUpperBracketValue(freqAxis, firstFrequencyLpmm),
      secondLo: findLowerBracketValue(freqAxis, secondFrequencyLpmm),
      secondHi: findUpperBracketValue(freqAxis, secondFrequencyLpmm),
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
    firstLo: number | null;
    firstHi: number | null;
    secondLo: number | null;
    secondHi: number | null;
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

          let firstM = Number.NaN, firstS = Number.NaN, secondM = Number.NaN, secondS = Number.NaN;
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
          } catch (fieldErr: any) {
            opdRespAny = { error: String(fieldErr?.message || fieldErr || "field failed") };
          }

          meridionalFirstRaw.push(Number.isFinite(firstM) ? firstM : Number.NaN);
          sagittalFirstRaw.push(Number.isFinite(firstS) ? firstS : Number.NaN);
          meridionalSecondRaw.push(Number.isFinite(secondM) ? secondM : Number.NaN);
          sagittalSecondRaw.push(Number.isFinite(secondS) ? secondS : Number.NaN);

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

        if (!sampleFromObjectRows) {
          suppressFieldCurveOutliersInPlace({
            diagnostics: fieldDiagnostics,
            curves: [meridionalFirst, sagittalFirst, meridionalSecond, sagittalSecond],
          });
        }

        series.push({
          wavelengthUm: wl,
          label: `${(wl * 1000).toFixed(1)}nm`,
          meridionalFirst,
          sagittalFirst,
          meridionalSecond,
          sagittalSecond,
          fieldDiagnostics,
        });

        if (!sampleFromObjectRows) {
          fillNaNGapsInPlace(meridionalFirst);
          fillNaNGapsInPlace(sagittalFirst);
          fillNaNGapsInPlace(meridionalSecond);
          fillNaNGapsInPlace(sagittalSecond);
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
        let firstLo: number | null = null;
        let firstHi: number | null = null;
        let secondLo: number | null = null;
        let secondHi: number | null = null;
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
          firstLo = samples.firstLo;
          firstHi = samples.firstHi;
          secondLo = samples.secondLo;
          secondHi = samples.secondHi;

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
            firstLo = idealSamples.firstLo;
            firstHi = idealSamples.firstHi;
            secondLo = idealSamples.secondLo;
            secondHi = idealSamples.secondHi;
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

      if (!sampleFromObjectRows) {
        suppressFieldCurveOutliersInPlace({
          diagnostics: fieldDiagnostics,
          curves: [meridionalFirst, sagittalFirst, meridionalSecond, sagittalSecond],
        });

        fillNaNGapsInPlace(meridionalFirst);
        fillNaNGapsInPlace(sagittalFirst);
        fillNaNGapsInPlace(meridionalSecond);
        fillNaNGapsInPlace(sagittalSecond);
      }

      series.push({
        wavelengthUm: wl,
        label: `${(wl * 1000).toFixed(1)}nm`,
        meridionalFirst,
        sagittalFirst,
        meridionalSecond,
        sagittalSecond,
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
  if (!isTauriRuntime()) {
    const toFiniteNumberOrNull = (value: unknown): number | null => {
      return (typeof value === "number" && Number.isFinite(value)) ? value : null;
    };

    const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
    const fieldSamples = Array.isArray(payload?.fieldSamples)
      ? payload.fieldSamples.map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : [];
    if (opticalSystemRows.length === 0) {
      throw new Error("runNativeDistortion(web): opticalSystemRows is empty");
    }
    if (fieldSamples.length === 0) {
      throw new Error("runNativeDistortion(web): fieldSamples is empty");
    }

    const { calculateParaxialData } = await import("../../../raytracing/core/ray-paraxial.ts");
    const surfaceIndex = Number.isInteger(payload?.surfaceIndex)
      ? Math.max(0, Number(payload.surfaceIndex))
      : pickImageSurfaceIndexNativeLike(opticalSystemRows);
    const heightMode = payload?.heightMode === true;
    const wavelength = Number.isFinite(Number(payload?.wavelength)) && Number(payload?.wavelength) > 0
      ? Number(payload.wavelength)
      : getPrimaryWavelengthUm(Array.isArray(payload?.sourceRows) ? payload.sourceRows : [], 0.5876);
    const sourceRows = Array.isArray(payload?.sourceRows) && payload.sourceRows.length > 0
      ? payload.sourceRows
      : buildDefaultDistortionSourceRows(wavelength);
    const distortionRayFanCount = 51;

    // Distortion in web mode should prefer the dedicated native-like WASM path first.
    // If coverage is insufficient, we fall back to render-style spot tracing below.
    const preferRenderHighAngleRays = false;

    // Prefer direct distortion WASM export when available.
    let directWasmError: string | null = null;
    try {
      if (!preferRenderHighAngleRays && !directDistortionWasmUnavailableInSession) {
        const { preloadRustRayTracingWasm } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
        const wasmApi = await preloadRustRayTracingWasm();
        if (wasmApi && typeof wasmApi.run_native_distortion_wasm_json === "function") {
          const wasmReq = {
            opticalSystemRows,
            sourceRows,
            fieldSamples,
            surfaceIndex,
            heightMode,
            wavelength,
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
            const minimumFinitePairs = Math.max(3, Math.ceil(expectedPoints * 0.6));
            if (finitePairCount < minimumFinitePairs) {
              try {
                console.warn("runNativeDistortion(web): direct WASM sparse coverage", {
                  finitePairCount,
                  minimumFinitePairs,
                  expectedPoints,
                });
              } catch {
                // Ignore logging failures in restricted runtimes.
              }
            }

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
    const paraxial = calculateParaxialData(opticalSystemRows, wavelength);

    // Tauri parity: estimate focal length/magnification from real chief-ray traces,
    // not only from paraxial outputs.
    let focalLength = Number(paraxial?.focalLength);
    let magnification = -1;

    try {
      const thetaDeg = 0.1;
      const thetaRad = thetaDeg * Math.PI / 180;
      const focalProbeObjectRows = finiteSystem
        ? [{
          id: "Field-0",
          name: "Field-0",
          position: "Rectangle",
          xHeight: 0,
          yHeight: objectDistance * Math.tan(thetaRad),
          x: 0,
          y: objectDistance * Math.tan(thetaRad),
        }]
        : [{
          id: "Field-0",
          name: "Field-0",
          position: "Angle",
          xHeightAngle: 0,
          yHeightAngle: thetaDeg,
          x: 0,
          y: thetaDeg,
        }];

      const focalProbeResp = await runNativeSpotRaytrace({
        opticalSystemRows,
        sourceRows,
        objectRows: focalProbeObjectRows,
        surfaceIndex,
        rayCount: distortionRayFanCount,
        ringCount: 1,
        pattern: "cross",
        wavelengthMode: "primary",
        forceRustWasm: false,
      });

      const focalProbeSeries = Array.isArray(focalProbeResp?.series) ? focalProbeResp.series : [];
      const focalProbeRow = focalProbeSeries[0] as any;
      const focalChiefYUm = Number(
        (focalProbeRow?.chiefPointUm && typeof focalProbeRow.chiefPointUm === "object" ? focalProbeRow.chiefPointUm.yUm : undefined)
        ?? (Array.isArray(focalProbeRow?.points) ? focalProbeRow.points[0]?.yUm : undefined)
      );
      if (Number.isFinite(focalChiefYUm) && Math.abs(thetaRad) > 1e-12) {
        const focalFromChief = Math.abs((focalChiefYUm / 1000) / Math.tan(thetaRad));
        if (Number.isFinite(focalFromChief) && Math.abs(focalFromChief) > 1e-9) {
          focalLength = focalFromChief;
        }
      }
    } catch {
      // Keep paraxial focal length fallback.
    }

    if (heightMode && finiteSystem) {
      try {
        const magProbeObjectRows = [{
          id: "Field-0",
          name: "Field-0",
          position: "Rectangle",
          xHeight: 0,
          yHeight: 1,
          x: 0,
          y: 1,
        }];

        const magProbeResp = await runNativeSpotRaytrace({
          opticalSystemRows,
          sourceRows,
          objectRows: magProbeObjectRows,
          surfaceIndex,
          rayCount: distortionRayFanCount,
          ringCount: 1,
          pattern: "cross",
          wavelengthMode: "primary",
          forceRustWasm: false,
        });

        const magProbeSeries = Array.isArray(magProbeResp?.series) ? magProbeResp.series : [];
        const magProbeRow = magProbeSeries[0] as any;
        const magChiefYUm = Number(
          (magProbeRow?.chiefPointUm && typeof magProbeRow.chiefPointUm === "object" ? magProbeRow.chiefPointUm.yUm : undefined)
          ?? (Array.isArray(magProbeRow?.points) ? magProbeRow.points[0]?.yUm : undefined)
        );
        if (Number.isFinite(magChiefYUm)) {
          const magFromChief = Math.abs(magChiefYUm / 1000);
          if (Number.isFinite(magFromChief)) {
            magnification = magFromChief;
          }
        }
      } catch {
        // Keep default -1 magnification when probe fails.
      }
    }

    const objectRows = fieldSamples.map((sample, index) => {
      if (heightMode) {
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

    const spotResponse = await runNativeSpotRaytrace({
      opticalSystemRows,
      sourceRows,
      objectRows,
      surfaceIndex,
      // Match native distortion implementation: cross pattern with 51 rays.
      // This keeps web fallback behavior consistent with native and avoids
      // chief-pick instability from a single-ray synthetic pattern.
      rayCount: distortionRayFanCount,
      ringCount: 1,
      pattern: "cross",
      wavelengthMode: "primary",
      // Use render high-angle ray generation path (non-strict).
      // Strict mode can drop mid-field points for wide-angle systems.
      forceRustWasm: false,
    });

    const realHeights = new Array(fieldSamples.length).fill(null) as Array<number | null>;
    const series = Array.isArray(spotResponse?.series) ? spotResponse.series : [];
    for (const row of series as any[]) {
      const match = String(row?.label || "").match(/Field-(\d+)/);
      if (!match) continue;
      const index = Number(match[1]);
      if (!Number.isInteger(index) || index < 0 || index >= realHeights.length) continue;
      const chiefPointUm = row?.chiefPointUm;
      const points = Array.isArray(row?.points) ? row.points : [];
      const fallbackPoint = points[0] || null;
      const yUm = Number(
        (chiefPointUm && typeof chiefPointUm === "object" ? chiefPointUm.yUm : undefined)
        ?? fallbackPoint?.yUm
      );
      if (Number.isFinite(yUm)) {
        realHeights[index] = Math.abs(yUm / 1000);
      }
    }

    // Recover missing fields via a second strict raytrace pass without synthetic smoothing/interpolation.
    // We only retry fields with no valid hit from the primary pass.
    const missingFieldIndices = realHeights
      .map((value, index) => ({ value, index }))
      .filter((entry) => !(typeof entry.value === "number" && Number.isFinite(entry.value)))
      .map((entry) => entry.index);

    let recoveredFieldCount = 0;
    let wasmMissingRecoveryCount = 0;
    let missingFieldWasmRecoveryError: string | null = null;
    if (missingFieldIndices.length > 0) {
      const retryObjectRows = missingFieldIndices
        .map((index) => objectRows[index])
        .filter((row) => !!row);

      if (retryObjectRows.length > 0) {
        try {
          const retrySpotResponse = await runNativeSpotRaytrace({
            opticalSystemRows,
            sourceRows,
            objectRows: retryObjectRows,
            surfaceIndex,
            rayCount: distortionRayFanCount,
            ringCount: 1,
            pattern: "cross",
            wavelengthMode: "primary",
            // Recovery pass keeps native-like fallback behavior where strict chief can miss.
            forceRustWasm: false,
          });

          const retrySeries = Array.isArray(retrySpotResponse?.series) ? retrySpotResponse.series : [];
          for (const row of retrySeries as any[]) {
            const match = String(row?.label || "").match(/Field-(\d+)/);
            if (!match) continue;
            const index = Number(match[1]);
            if (!Number.isInteger(index) || index < 0 || index >= realHeights.length) continue;
            if (typeof realHeights[index] === "number" && Number.isFinite(realHeights[index])) continue;

            const chiefPointUm = row?.chiefPointUm;
            const points = Array.isArray(row?.points) ? row.points : [];
            const fallbackPoint = points[0] || null;
            const yUm = Number(
              (chiefPointUm && typeof chiefPointUm === "object" ? chiefPointUm.yUm : undefined)
              ?? fallbackPoint?.yUm
            );
            if (!Number.isFinite(yUm)) continue;

            realHeights[index] = Math.abs(yUm / 1000);
            recoveredFieldCount += 1;
          }
        } catch (retryError) {
          try {
            console.warn("runNativeDistortion(web): missing-field retry failed", {
              error: retryError instanceof Error ? retryError.message : String(retryError),
              missingFieldIndices,
            });
          } catch {
            // Ignore logging failures in restricted runtimes.
          }
        }
      }
    }

    // If spot-based recovery still leaves gaps, recover only unresolved fields
    // through the native-like distortion WASM API and merge those real heights.
    const unresolvedFieldIndices = realHeights
      .map((value, index) => ({ value, index }))
      .filter((entry) => !(typeof entry.value === "number" && Number.isFinite(entry.value)))
      .map((entry) => entry.index);

    if (unresolvedFieldIndices.length > 0 && !directDistortionWasmUnavailableInSession) {
      try {
        const { preloadRustRayTracingWasm } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
        const wasmApi = await preloadRustRayTracingWasm();
        if (wasmApi && typeof wasmApi.run_native_distortion_wasm_json === "function") {
          const unresolvedFieldSamples = unresolvedFieldIndices.map((index) => fieldSamples[index]);
          const wasmReq = {
            opticalSystemRows,
            sourceRows,
            fieldSamples: unresolvedFieldSamples,
            surfaceIndex,
            heightMode,
            wavelength,
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

    const idealHeights = fieldSamples.map((sample) => {
      if (heightMode) {
        return finiteSystem ? magnification * sample : sample;
      }
      const thetaRad = sample * Math.PI / 180;
      return Number.isFinite(focalLength) ? focalLength * Math.tan(thetaRad) : Math.tan(thetaRad);
    });
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
      for (let i = 0; i < distortionPercent.length; i += 1) {
        const raw = distortionPercent[i];
        if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
        const cur = raw;
        if (prev !== null && cur + 1e-9 < prev) {
          out.push({ fromIndex: prevIndex, toIndex: i, fromValue: prev, toValue: cur });
        }
        prev = cur;
        prevIndex = i;
      }
      return out;
    })();
    const diagnosticsPayload = {
      backend: "web-rust-wasm-spot-fallback",
      surfaceIndex,
      directWasmError,
      focalLength,
      magnification,
      missingFieldCountBeforeRetry: missingFieldIndices.length,
      recoveredFieldCount,
      wasmMissingRecoveryCount,
      missingFieldWasmRecoveryError,
      monotonicBreakCount: monotonicBreaks.length,
      monotonicBreaks,
      points: fallbackDiagnostics,
    };
    try {
      (globalThis as any).__cooptLastDistortionFallbackDiagnostics = diagnosticsPayload;
      console.warn("runNativeDistortion(web): fallback diagnostics", diagnosticsPayload);
      console.warn("runNativeDistortion(web): fallback diagnostics json", JSON.stringify(diagnosticsPayload));
    } catch {
      // Ignore logging failures in restricted runtimes.
    }

    return {
      backend: "web-rust-wasm-spot-fallback",
      fieldValues: fieldSamples,
      idealHeights,
      realHeights,
      distortion,
      distortionPercent,
      meta: {
        wavelength,
        focalLength: Number.isFinite(focalLength) ? focalLength : NaN,
        finiteSystem,
        heightMode,
        magnification: Number.isFinite(magnification) ? magnification : -1,
        surfaceIndex,
        directWasmError,
        missingFieldCountBeforeRetry: missingFieldIndices.length,
        recoveredFieldCount,
        wasmMissingRecoveryCount,
        missingFieldWasmRecoveryError,
        interpolationFilledCount: 0,
      },
      message: "Computed via Web Rust/WASM distortion API",
    };
  }
  return invokeCommand<NativeDistortionRequest, NativeDistortionResponse>("run_native_distortion", payload);
}

export async function runNativeGridDistortion(
  payload: NativeGridDistortionRequest,
): Promise<NativeGridDistortionResponse> {
  if (!isTauriRuntime()) {
    const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
    if (opticalSystemRows.length === 0) {
      throw new Error("runNativeGridDistortion(web): opticalSystemRows is empty");
    }

    const { calculateParaxialData } = await import("../../../raytracing/core/ray-paraxial.ts");
    const surfaceIndex = Number.isInteger(payload?.surfaceIndex)
      ? Math.max(0, Number(payload.surfaceIndex))
      : pickImageSurfaceIndexNativeLike(opticalSystemRows);
    const gridSize = Number.isInteger(payload?.gridSize) ? Math.max(2, Math.min(200, Number(payload.gridSize))) : 20;
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
    const paraxial = calculateParaxialData(opticalSystemRows, wavelength);
    let focalLength = Number(paraxial?.focalLength);
    let magnification = -1;
    try {
      const thetaDeg = 0.1;
      const thetaRad = thetaDeg * Math.PI / 180;
      const focalProbeObjectRows = finiteSystem
        ? [{
          id: "Field-0",
          name: "Field-0",
          position: "Rectangle",
          xHeight: 0,
          yHeight: objectDistance * Math.tan(thetaRad),
          x: 0,
          y: objectDistance * Math.tan(thetaRad),
        }]
        : [{
          id: "Field-0",
          name: "Field-0",
          position: "Angle",
          xHeightAngle: 0,
          yHeightAngle: thetaDeg,
          x: 0,
          y: thetaDeg,
        }];
      const focalProbeResp = await runNativeSpotRaytrace({
        opticalSystemRows,
        sourceRows,
        objectRows: focalProbeObjectRows,
        surfaceIndex,
        rayCount: 51,
        ringCount: 1,
        pattern: "cross",
        wavelengthMode: "primary",
        forceRustWasm: false,
      });
      const focalProbeSeries = Array.isArray(focalProbeResp?.series) ? focalProbeResp.series : [];
      const focalProbeRow = focalProbeSeries[0] as any;
      const focalChiefYUm = Number(
        (focalProbeRow?.chiefPointUm && typeof focalProbeRow.chiefPointUm === "object" ? focalProbeRow.chiefPointUm.yUm : undefined)
        ?? (Array.isArray(focalProbeRow?.points) ? focalProbeRow.points[0]?.yUm : undefined)
      );
      if (Number.isFinite(focalChiefYUm) && Math.abs(thetaRad) > 1e-12) {
        const focalFromChief = Math.abs((focalChiefYUm / 1000) / Math.tan(thetaRad));
        if (Number.isFinite(focalFromChief) && Math.abs(focalFromChief) > 1e-9) {
          focalLength = focalFromChief;
        }
      }
    } catch {
      // Keep paraxial focal length fallback.
    }
    if (gridFieldMode === "height" && finiteSystem) {
      try {
        const magProbeResp = await runNativeSpotRaytrace({
          opticalSystemRows,
          sourceRows,
          objectRows: [{
            id: "Field-0",
            name: "Field-0",
            position: "Rectangle",
            xHeight: 0,
            yHeight: 1,
            x: 0,
            y: 1,
          }],
          surfaceIndex,
          rayCount: 51,
          ringCount: 1,
          pattern: "cross",
          wavelengthMode: "primary",
          forceRustWasm: false,
        });
        const magProbeSeries = Array.isArray(magProbeResp?.series) ? magProbeResp.series : [];
        const magProbeRow = magProbeSeries[0] as any;
        const magChiefYUm = Number(
          (magProbeRow?.chiefPointUm && typeof magProbeRow.chiefPointUm === "object" ? magProbeRow.chiefPointUm.yUm : undefined)
          ?? (Array.isArray(magProbeRow?.points) ? magProbeRow.points[0]?.yUm : undefined)
        );
        if (Number.isFinite(magChiefYUm)) {
          const magFromChief = Math.abs(magChiefYUm / 1000);
          if (Number.isFinite(magFromChief) && Math.abs(magFromChief) > 1e-9) {
            magnification = magFromChief;
          }
        }
      } catch {
        // Keep default magnification fallback.
      }
    }
    const hasFiniteFocalLength = Number.isFinite(focalLength) && Math.abs(focalLength) > 1e-12;
    // Match distortion behavior: continue with a normalized focal length instead of hard-failing.
    const focalLengthForGrid = hasFiniteFocalLength ? focalLength : 1.0;
    const imageScaleForHeight = (gridFieldMode === "height" && finiteSystem && Number.isFinite(magnification) && Math.abs(magnification) > 1e-9)
      ? Math.abs(magnification)
      : 1.0;
    const maxImageX = gridFieldMode === "angle"
      ? focalLengthForGrid * Math.tan((gridFieldExtents.x * Math.PI) / 180)
      : gridFieldMode === "height"
        ? gridFieldExtents.x * imageScaleForHeight
        : gridFieldExtents.x;
    const maxImageY = gridFieldMode === "angle"
      ? focalLengthForGrid * Math.tan((gridFieldExtents.y * Math.PI) / 180)
      : gridFieldMode === "height"
        ? gridFieldExtents.y * imageScaleForHeight
        : gridFieldExtents.y;
    const stepX = (2 * maxImageX) / Math.max(1, gridSize - 1);
    const stepY = (2 * maxImageY) / Math.max(1, gridSize - 1);

    const idealX: number[] = [];
    const idealY: number[] = [];
    const objectRows: any[] = [];
    for (let yi = 0; yi < gridSize; yi++) {
      const imageY = -maxImageY + yi * stepY;
      const thetaYRad = Math.atan(imageY / focalLengthForGrid);
      const thetaY = (thetaYRad * 180) / Math.PI;
      for (let xi = 0; xi < gridSize; xi++) {
        const imageX = -maxImageX + xi * stepX;
        const thetaXRad = Math.atan(imageX / focalLengthForGrid);
        const thetaX = (thetaXRad * 180) / Math.PI;
        const index = yi * gridSize + xi;
        idealX.push(imageX);
        idealY.push(imageY);
        if (gridFieldMode === "imageheight") {
          objectRows.push({
            id: `Field-${index}`,
            name: `Field-${index}`,
            position: "ImageHeight",
            objectType: "ImageHeight",
            xHeightAngle: imageX,
            yHeightAngle: imageY,
            xHeight: imageX,
            yHeight: imageY,
            x: imageX,
            y: imageY,
            __cooptImageHeightTarget: { x: imageX, y: imageY },
          });
        } else if (gridFieldMode === "height") {
          const objectX = finiteSystem && imageScaleForHeight > 1e-9 ? (imageX / imageScaleForHeight) : imageX;
          const objectY = finiteSystem && imageScaleForHeight > 1e-9 ? (imageY / imageScaleForHeight) : imageY;
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

    const traceObjectRows = gridFieldMode === "imageheight"
      ? await normalizeTransverseObjectRowsForImageHeight(opticalSystemRows, sourceRows, objectRows, wavelength)
      : objectRows;

    const realX = new Array(idealX.length).fill(null) as Array<number | null>;
    const realY = new Array(idealY.length).fill(null) as Array<number | null>;
    let directChiefRayCount = 0;

    const spotResponse = await runNativeSpotRaytrace({
      opticalSystemRows,
      sourceRows,
      objectRows: traceObjectRows,
      surfaceIndex,
      rayCount: 51,
      ringCount: 1,
      pattern: "cross",
      wavelengthMode: "primary",
      forceRustWasm: false,
    });

    const series = Array.isArray(spotResponse?.series) ? spotResponse.series : [];
    for (const row of series as any[]) {
      const match = String(row?.label || "").match(/Field-(\d+)/);
      if (!match) continue;
      const index = Number(match[1]);
      if (!Number.isInteger(index) || index < 0 || index >= realX.length) continue;
      const chiefPointUm = row?.chiefPointUm;
      const fallbackPoint = Array.isArray(row?.points) ? row.points[0] : null;
      const xMm = Number(
        (chiefPointUm && typeof chiefPointUm === "object" ? chiefPointUm.xUm : undefined)
        ?? fallbackPoint?.xUm
      ) / 1000;
      const yMm = Number(
        (chiefPointUm && typeof chiefPointUm === "object" ? chiefPointUm.yUm : undefined)
        ?? fallbackPoint?.yUm
      ) / 1000;
      if (Number.isFinite(xMm) && Number.isFinite(yMm)) {
        realX[index] = xMm;
        realY[index] = yMm;
        directChiefRayCount += 1;
      }
    }

    let missingFieldFallbackCount = 0;
    for (let i = 0; i < realX.length; i++) {
      const rx = Number(realX[i]);
      const ry = Number(realY[i]);
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) {
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
      maxFieldAngle: gridFieldMode === "angle" ? Math.max(gridFieldExtents.x, gridFieldExtents.y) : NaN,
      meta: {
        wavelength,
        focalLength: hasFiniteFocalLength ? focalLength : NaN,
        focalLengthFallbackUsed: !hasFiniteFocalLength,
        focalLengthForGrid,
        finiteSystem,
        gridFieldMode,
        maxImageX,
        maxImageY,
        surfaceIndex,
        directChiefRayCount,
        missingFieldFallbackCount,
      },
      message: "Computed via Web Rust/WASM grid distortion API",
    };
  }
  return invokeCommand<NativeGridDistortionRequest, NativeGridDistortionResponse>("run_native_grid_distortion", payload);
}

export async function runNativeMagnificationChromaticAberration(
  payload: NativeMagnificationChromaticAberrationRequest,
): Promise<NativeMagnificationChromaticAberrationResponse> {
  const tauriRuntime = isTauriRuntime();
  if (tauriRuntime) {
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
