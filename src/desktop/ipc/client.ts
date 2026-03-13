import { invoke } from "@tauri-apps/api/core";
import type {
  NativeAstigmatismRequest,
  NativeAstigmatismResponse,
  NativeAstigmatismDebugRequest,
  NativeAstigmatismDebugResponse,
  NativeTransverseAberrationRequest,
  NativeTransverseAberrationResponse,
  NativeOpdMapRequest,
  NativeOpdMapResponse,
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

function deriveMaxFieldAngleNativeLike(objectRows: any[]): number {
  const rows = Array.isArray(objectRows) ? objectRows : [];
  if (rows.length === 0) return 20;
  let maxAngle = 0;
  for (const row of rows) {
    const candidates = [
      row?.yFieldAngle,
      row?.yAngle,
      row?.fieldAngle,
      row?.xFieldAngle,
      row?.xAngle,
      row?.xHeightAngle,
      row?.yHeightAngle,
    ];
    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value)) {
        maxAngle = Math.max(maxAngle, Math.abs(value));
      }
    }
  }
  return maxAngle > 0 ? maxAngle : 20;
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
  if (!isTauriRuntime()) {
    const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
    if (opticalSystemRows.length === 0) {
      throw new Error("runNativeSpotRaytrace(web): opticalSystemRows is empty");
    }

    const targetSurface = Number.isInteger(payload?.surfaceIndex)
      ? Math.max(0, Number(payload.surfaceIndex))
      : Math.max(0, opticalSystemRows.length - 1);

    const toSeriesColor = (index: number) => {
      const palette = ["#60a5fa", "#34d399", "#f59e0b", "#f472b6", "#a78bfa", "#22d3ee"];
      return palette[index % palette.length];
    };

    if (Array.isArray(payload?.raySeries) && payload.raySeries.length > 0) {
      const { traceRayEvalBatchSummary } = await import("../../../raytracing/core/ray-tracing.ts");
      const requestSeries = payload.raySeries;
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
        const points = normalizedSummaries
          .filter((s: any) => !!s?.success && s?.hitPoint)
          .map((s: any) => ({ xUm: Number(s?.hitPoint?.x) * 1000, yUm: Number(s?.hitPoint?.y) * 1000 }))
          .filter((p: any) => Number.isFinite(p.xUm) && Number.isFinite(p.yUm));
        const chiefIdx = rays.findIndex((r: any) => r?.isChief === true);
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

      return {
        backend: "web-rust-wasm",
        surfaceIndex: targetSurface,
        tracedRays: totalHitRays,
        requestedRays: totalAttemptedRays,
        generatedRays: totalAttemptedRays,
        wavelengthCount: new Set(series.map((s: any) => Number(s.wavelengthUm)).filter((v: number) => Number.isFinite(v) && v > 0)).size,
        totalAttemptedRays,
        totalHitRays,
        maxHitRays,
        meanHitRatePercent,
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
        .map((p: any) => ({ xUm: Number(p?.x) * 1000, yUm: Number(p?.y) * 1000 }))
        .filter((p: any) => Number.isFinite(p.xUm) && Number.isFinite(p.yUm));
      const chiefSrc = pointsRaw.find((p: any) => p?.isChiefRay === true) || pointsRaw[0];
      const chiefPointUm = chiefSrc
        ? { xUm: Number(chiefSrc?.x) * 1000, yUm: Number(chiefSrc?.y) * 1000 }
        : undefined;
      const wl = Number(pointsRaw.find((p: any) => Number(p?.wavelength) > 0)?.wavelength);

      return {
        label: String(obj?.objectId || obj?.objectType || `Object ${idx + 1}`),
        color: toSeriesColor(idx),
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

    return {
      backend: "web-rust-wasm",
      surfaceIndex: targetSurface,
      tracedRays: totalHitRays,
      requestedRays: totalAttemptedRays,
      generatedRays: totalAttemptedRays,
      wavelengthCount: new Set(series.map((s: any) => Number(s.wavelengthUm)).filter((v: number) => Number.isFinite(v) && v > 0)).size,
      totalAttemptedRays,
      totalHitRays,
      maxHitRays,
      meanHitRatePercent,
      seriesStats,
      series,
      message: "Computed via Web Rust/WASM spot raytrace API",
    };
  }
  return invokeCommand<NativeSpotRaytraceRequest, NativeSpotRaytraceResponse>("run_native_spot_raytrace", payload);
}

export async function runNativeSphericalAberration(
  payload: NativeSphericalAberrationRequest,
): Promise<NativeSphericalAberrationResponse> {
  if (!isTauriRuntime()) {
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

export async function logNativeAstigmatismDebug(
  payload: NativeAstigmatismDebugRequest,
): Promise<NativeAstigmatismDebugResponse> {
  return invokeCommand<NativeAstigmatismDebugRequest, NativeAstigmatismDebugResponse>("log_native_astigmatism_debug", payload);
}

export async function runNativeAstigmatism(
  payload: NativeAstigmatismRequest,
): Promise<NativeAstigmatismResponse> {
  if (!isTauriRuntime()) {
    const { calculateAstigmatismDataNativeLike } = await import("../../../evaluation/aberrations/astigmatism.ts");
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
  if (!isTauriRuntime()) {
    const {
      calculateTransverseAberrationAsync,
      getPrimaryWavelengthForAberration,
    } = await import("../../../evaluation/aberrations/transverse-aberration.ts");

    const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
    const targetSurfaceIndex = Number.isInteger(payload?.surfaceIndex)
      ? Math.max(0, Number(payload.surfaceIndex))
      : Math.max(0, opticalSystemRows.length - 1);
    const wavelength = Number.isFinite(Number(payload?.wavelength))
      ? Number(payload.wavelength)
      : getPrimaryWavelengthForAberration();

    const result = await calculateTransverseAberrationAsync(
      opticalSystemRows,
      targetSurfaceIndex,
      null,
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
  return invokeCommand<NativeTransverseAberrationRequest, NativeTransverseAberrationResponse>(
    "run_native_transverse_aberration",
    payload,
  );
}

export async function runNativeOpdMap(
  payload: NativeOpdMapRequest,
): Promise<NativeOpdMapResponse> {
  if (!isTauriRuntime()) {
    const opdDebug = isOpdDebugEnabled();
    const { createOPDCalculator, createWavefrontAnalyzer } = await import("../../../evaluation/wavefront/wavefront.ts");
    const opticalSystemRows = Array.isArray(payload?.opticalSystemRows) ? payload.opticalSystemRows : [];
    if (opticalSystemRows.length === 0) throw new Error("runNativeOpdMap(web): opticalSystemRows is empty");

    const sourceRows = Array.isArray(payload?.sourceRows) ? payload.sourceRows : [];
    const objectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : [];
    const objectIndex = Number.isInteger(payload?.objectIndex) ? Math.max(0, Number(payload.objectIndex)) : 0;
    const selectedObject = objectRows[objectIndex] || objectRows[0] || {};

    const wavelengthUm = (() => {
      const explicit = Number(payload?.wavelengthUm);
      if (Number.isFinite(explicit) && explicit > 0) return explicit;

      // Prefer source row explicitly marked as primary.
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
    const fieldSetting = isAngle
      ? { type: "angle", fieldAngle: { x: xVal, y: yVal }, wavelength: wavelengthUm, objectIndex }
      : { type: "height", objectHeight: { x: xVal, y: yVal }, wavelength: wavelengthUm, objectIndex };

    const gridSize = Number.isFinite(Number(payload?.gridSize)) ? Math.max(17, Math.floor(Number(payload.gridSize))) : 129;
    const requestedPupilSamplingMode = (payload?.pupilSamplingMode === "stop" || payload?.pupilSamplingMode === "entrance")
      ? payload.pupilSamplingMode
      : "stop";
    const opdDisplayMode = String(payload?.opdDisplayMode || "pistonTiltRemoved");

    const calculator = createOPDCalculator(opticalSystemRows, wavelengthUm);
    const analyzer = createWavefrontAnalyzer(calculator);

    // Prefer native Rust-WASM OPD API when available to reduce JS/Rust algorithm drift.
    try {
      const targetSurfaceWasm = (() => {
        const v = Number(payload?.surfaceIndex);
        if (Number.isInteger(v) && v >= 0) return v;
        const imageIdx = opticalSystemRows.findIndex((r: any) => String(r?.["object type"] ?? r?.object ?? "").toLowerCase() === "image");
        return imageIdx > 0 ? imageIdx : Math.max(0, opticalSystemRows.length - 1);
      })();
      const stopSurfaceWasm = Number((calculator as any)?.stopSurfaceIndex ?? 0);

      const { preloadRustRayTracingWasm } = await import("../../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts");
      const rust = await preloadRustRayTracingWasm();
      const runNativeWasm = (rust as any)?.run_native_opd_map_wasm_json;
      if (opdDebug) {
        console.log("[runNativeOpdMap(web)] WASM function available:", typeof runNativeWasm === "function");
      }
      if (typeof runNativeWasm === "function") {
        const reqForWasm = {
          opticalSystemRows,
          sourceRows,
          objectRows,
          objectIndex,
          surfaceIndex: targetSurfaceWasm,
          stopSurfaceIndex: stopSurfaceWasm,
          gridSize,
          wavelengthUm,
          pupilSamplingMode: requestedPupilSamplingMode,
          opdDisplayMode,
        };
        if (opdDebug) {
          console.log("[runNativeOpdMap(web)] Calling WASM with:", {
            gridSize, wavelengthUm, pupilSamplingMode: requestedPupilSamplingMode, opdDisplayMode,
            targetSurface: targetSurfaceWasm, stopSurface: stopSurfaceWasm,
            objectIndex, rowCount: opticalSystemRows.length,
          });
        }
        const wasmOutRaw = runNativeWasm(JSON.stringify(reqForWasm));
        const wasmOut = (typeof wasmOutRaw === "string") ? JSON.parse(wasmOutRaw) : wasmOutRaw;
        const rawOpdGrid = Array.isArray(wasmOut?.rawOpdGrid) ? wasmOut.rawOpdGrid : null;
        const displayOpdGrid = Array.isArray(wasmOut?.displayOpdGrid) ? wasmOut.displayOpdGrid : rawOpdGrid;
        const wasmMessage = String(wasmOut?.message || "");
        const usedChiefFallback = wasmMessage.includes("fallback to nearest successful sample");
        if (opdDebug) {
          console.log("[runNativeOpdMap(web)] WASM returned:", {
            hasRawGrid: !!rawOpdGrid, hasDisplayGrid: !!displayOpdGrid,
            sampleCount: wasmOut?.sampleCount, hitCount: wasmOut?.hitCount,
            hitRate: wasmOut?.sampleCount > 0 ? (wasmOut.hitCount / wasmOut.sampleCount * 100).toFixed(1) + '%' : 'n/a',
            usedChiefFallback, message: wasmMessage,
          });
        }
        if (usedChiefFallback) {
          // Chief fallback means center ray failed; nearest-sample OPL used as reference.
          // Since display mode is pistonTiltRemoved, the constant OPL offset is corrected automatically.
          // Accept the result — do NOT fall through to the TypeScript OPD path.
          if (opdDebug) {
            try {
              console.warn("[runNativeOpdMap(web)] Chief ray fallback used; accepting WASM result (piston/tilt removal compensates)", {
                backend: wasmOut?.backend,
                message: wasmMessage,
                chiefHitStatus: wasmOut?.chiefHitStatus,
                sampleCount: wasmOut?.sampleCount,
                hitCount: wasmOut?.hitCount,
              });
            } catch (_) {}
          }
        }
        if (rawOpdGrid && displayOpdGrid) {
          return {
            backend: String(wasmOut?.backend || "web-rust-wasm-native-api"),
            chiefReferenceMode: String(wasmOut?.chiefReferenceMode || ""),
            targetSurface: targetSurfaceWasm,
            stopSurface: stopSurfaceWasm,
            requestedObjectIndex: objectIndex,
            usedObjectIndex: objectIndex,
            usedObjectPosition: isAngle ? "angle" : "height",
            usedObjectX: xVal,
            usedObjectY: yVal,
            wavelengthUm,
            gridSize: Number.isFinite(Number(wasmOut?.gridSize)) ? Number(wasmOut.gridSize) : gridSize,
            sampleCount: Number.isFinite(Number(wasmOut?.sampleCount)) ? Number(wasmOut.sampleCount) : 0,
            hitCount: Number.isFinite(Number(wasmOut?.hitCount)) ? Number(wasmOut.hitCount) : 0,
            pupilSamplingMode: String(wasmOut?.pupilSamplingMode || requestedPupilSamplingMode),
            rawOpdGrid,
            displayOpdGrid,
            message: String(wasmOut?.message || "Computed via Rust-WASM native OPD API"),
          } as NativeOpdMapResponse;
        }
      }
    } catch (_wasmErr) {
      // WASM OPD call failed — likely missing chief ray or JSON parse error.
      // Will fall back to existing TS web path when native WASM OPD API is unavailable.
      console.error("[runNativeOpdMap(web)] ❌ WASM OPD block threw exception. Error:", _wasmErr);
    }

    const isInfiniteField = !(calculator as any)?.isFiniteForField?.(fieldSetting);
    if (isInfiniteField) {
      // If we reach here, WASM either was unavailable or threw.
      // Stop mode MUST use WASM. TypeScript OPD calculation for stop mode is broken (RMS ~22000 λ).
      console.error("[runNativeOpdMap(web)] ⚠️ WASM OPD path did not return — falling through to TypeScript path.",
        "requestedPupilSamplingMode=", requestedPupilSamplingMode,
        "isInfiniteField=", isInfiniteField,
        "If stop mode: WASM must be fixed, NOT the TypeScript path.");
      const shouldUsePreferredWavefrontRoute = requestedPupilSamplingMode !== "stop";
      let preferredWavefrontMap: any = null;
      if (shouldUsePreferredWavefrontRoute) {
        const prevForcedModeForPreferred = (globalThis as any).__COOPT_FORCE_INFINITE_PUPIL_MODE;
        try {
          (globalThis as any).__COOPT_FORCE_INFINITE_PUPIL_MODE = requestedPupilSamplingMode;
          preferredWavefrontMap = await analyzer.generateWavefrontMap(fieldSetting, gridSize, "circular", {
            forceRustWasm: true,
            skipZernikeFit: true,
            opdDisplayMode,
            traceOptions: {
              useRustWasm: true,
              requireRustWasm: true,
              allowNonStrict: false,
            },
          });
        } catch (_) {
          preferredWavefrontMap = null;
        } finally {
          try {
            if (prevForcedModeForPreferred === undefined) {
              delete (globalThis as any).__COOPT_FORCE_INFINITE_PUPIL_MODE;
            } else {
              (globalThis as any).__COOPT_FORCE_INFINITE_PUPIL_MODE = prevForcedModeForPreferred;
            }
          } catch (_) {
            // Just cleanup errors, don't interfere with parsing
          }
        }

        const preferredCoords = Array.isArray(preferredWavefrontMap?.pupilCoordinates)
          ? preferredWavefrontMap.pupilCoordinates
          : [];
        const preferredRawValues = Array.isArray(preferredWavefrontMap?.raw?.opdsInWavelengths)
          ? preferredWavefrontMap.raw.opdsInWavelengths
          : (Array.isArray(preferredWavefrontMap?.opdsInWavelengths) ? preferredWavefrontMap.opdsInWavelengths : []);
        const preferredDisplayValues = Array.isArray(preferredWavefrontMap?.display?.opdsInWavelengths)
          ? preferredWavefrontMap.display.opdsInWavelengths
          : preferredRawValues;
      }

      if (preferredRawValues.length > 0) {
        try {
          const allVals = preferredRawValues.map(Number).filter(Number.isFinite);
          if (allVals.length > 0) {
            const rms = Math.sqrt(allVals.reduce((s, v) => s + v * v, 0) / allVals.length);
            const mn = Math.min(...allVals);
            const mx = Math.max(...allVals);
            console.log('[runNativeOpdMap] wavefront route opdsInWavelengths: count=', allVals.length, 'rms=', rms.toFixed(4), 'λ  min=', mn.toFixed(4), 'max=', mx.toFixed(4), '  (if rms>>10 λ, OPD calculation itself is the issue)');
          }
        } catch (_) {}
      }

      if (preferredWavefrontMap && preferredCoords.length > 0 && preferredRawValues.length > 0) {
        const nPreferred = Math.max(1, Number(preferredWavefrontMap?.gridSize) || gridSize);
        const rawOpdGridPreferred: Array<Array<number | null>> = Array.from({ length: nPreferred }, () => Array.from({ length: nPreferred }, () => null));
        const displayOpdGridPreferred: Array<Array<number | null>> = Array.from({ length: nPreferred }, () => Array.from({ length: nPreferred }, () => null));

        let hitCountPreferred = 0;
        const mPreferred = Math.min(preferredCoords.length, preferredRawValues.length, preferredDisplayValues.length);
        for (let i = 0; i < mPreferred; i++) {
          const p = preferredCoords[i] || {};
          const ix = Number.isInteger((p as any).ix)
            ? Number((p as any).ix)
            : Math.round(((Number((p as any).x) + 1) * 0.5) * (nPreferred - 1));
          const iy = Number.isInteger((p as any).iy)
            ? Number((p as any).iy)
            : Math.round(((Number((p as any).y) + 1) * 0.5) * (nPreferred - 1));
          if (ix < 0 || iy < 0 || ix >= nPreferred || iy >= nPreferred) continue;
          const rv = Number(preferredRawValues[i]);
          const dv = Number(preferredDisplayValues[i]);
          if (Number.isFinite(rv)) {
            rawOpdGridPreferred[iy][ix] = rv;
            hitCountPreferred += 1;
          }
          if (Number.isFinite(dv)) displayOpdGridPreferred[iy][ix] = dv;
        }

        let targetSurfacePreferred = Number(payload?.surfaceIndex);
        if (!Number.isInteger(targetSurfacePreferred) || targetSurfacePreferred < 0) {
          targetSurfacePreferred = Math.max(0, opticalSystemRows.findIndex((r: any) => String(r?.["object type"] ?? r?.object ?? "").toLowerCase() === "image"));
          if (targetSurfacePreferred <= 0) targetSurfacePreferred = Math.max(0, opticalSystemRows.length - 1);
        }

        const effectivePupilSamplingModePreferred = (() => {
          const mode = String((preferredWavefrontMap as any)?.pupilSamplingMode || "").toLowerCase();
          if (mode === "stop" || mode === "entrance") return mode;
          return requestedPupilSamplingMode;
        })();

        return {
          backend: "web-rust-wasm",
          targetSurface: targetSurfacePreferred,
          stopSurface: Number((calculator as any)?.stopSurfaceIndex ?? 0),
          requestedObjectIndex: objectIndex,
          usedObjectIndex: objectIndex,
          usedObjectPosition: isAngle ? "angle" : "height",
          usedObjectX: xVal,
          usedObjectY: yVal,
          wavelengthUm,
          gridSize: nPreferred,
          sampleCount: nPreferred * nPreferred,
          hitCount: hitCountPreferred,
          pupilSamplingMode: effectivePupilSamplingModePreferred,
          rawOpdGrid: rawOpdGridPreferred,
          displayOpdGrid: displayOpdGridPreferred,
          message: "Computed via Web Rust/WASM OPD API (wavefront route)",
        };
      }

      const prevForcedMode = (globalThis as any).__COOPT_FORCE_INFINITE_PUPIL_MODE;
      const wasmTraceOptions = {
        useRustWasm: true,
        requireRustWasm: true,
        allowNonStrict: false,
      };

      try {
        (globalThis as any).__COOPT_FORCE_INFINITE_PUPIL_MODE = requestedPupilSamplingMode;
        (calculator as any).referenceOpticalPath = null;
        (calculator as any).setReferenceRay(fieldSetting);
      } finally {
        try {
          if (prevForcedMode === undefined) {
            delete (globalThis as any).__COOPT_FORCE_INFINITE_PUPIL_MODE;
          } else {
            (globalThis as any).__COOPT_FORCE_INFINITE_PUPIL_MODE = prevForcedMode;
          }
        } catch (_) {}
      }

      const effectivePupilSamplingMode = (() => {
        const mode = String((calculator as any)?._getInfinitePupilMode?.(fieldSetting) || requestedPupilSamplingMode).toLowerCase();
        return mode === "entrance" ? "entrance" : "stop";
      })();
      let targetSurface = Number(payload?.surfaceIndex);
      if (!Number.isInteger(targetSurface) || targetSurface < 0) {
        targetSurface = Math.max(0, opticalSystemRows.findIndex((r: any) => String(r?.["object type"] ?? r?.object ?? "").toLowerCase() === "image"));
        if (targetSurface <= 0) targetSurface = Math.max(0, opticalSystemRows.length - 1);
      }

      // Infinite field direction computed from field angle — matches native Rust's infinite_direction.
      const _angleXr = ((fieldSetting as any).fieldAngle?.x || 0) * Math.PI / 180;
      const _angleYr = ((fieldSetting as any).fieldAngle?.y || 0) * Math.PI / 180;
      const _dxInf = Math.sin(_angleXr) * Math.cos(_angleYr);
      const _dyInf = Math.sin(_angleYr) * Math.cos(_angleXr);
      const _dzInf = Math.cos(_angleXr) * Math.cos(_angleYr);
      const _dirMag = Math.hypot(_dxInf, _dyInf, _dzInf) || 1;
      const chiefDirection = { x: _dxInf / _dirMag, y: _dyInf / _dirMag, z: _dzInf / _dirMag };

      const n0Obj = Number((calculator as any)?.getObjectSpaceRefractiveIndex?.()) || 1.0;
      const stopSurfaceIndex = Number((calculator as any)?.stopSurfaceIndex ?? 0);
      const stopCenterRaw = (calculator as any)?.getSurfaceOrigin?.(stopSurfaceIndex) || { x: 0, y: 0, z: 0 };
      const stopCenter = {
        x: Number(stopCenterRaw?.x) || 0,
        y: Number(stopCenterRaw?.y) || 0,
        z: Number(stopCenterRaw?.z) || 0,
      };
      const objectPlaneOrigin = (calculator as any)?.getSurfaceOrigin?.(0) || { x: 0, y: 0, z: 0 };
      const objectPlaneZ = Number(objectPlaneOrigin?.z) || 0;
      const infiniteObjectZ = resolveInfiniteObjectZNativeLike(opticalSystemRows, selectedObject, objectPlaneZ);
      const safeK = Math.abs(chiefDirection.z) > 1e-12 ? chiefDirection.z : (chiefDirection.z >= 0 ? 1e-12 : -1e-12);
      const dz = stopCenter.z - infiniteObjectZ;
      const baseOriginX = stopCenter.x - (chiefDirection.x / safeK) * dz;
      const baseOriginY = stopCenter.y - (chiefDirection.y / safeK) * dz;
      const originSag = computeObjectSurfaceSagNativeLike(opticalSystemRows, baseOriginX, baseOriginY);
      const emissionOrigin: { x: number; y: number; z: number } = {
        x: baseOriginX,
        y: baseOriginY,
        z: infiniteObjectZ + originSag,
      };

      const chiefProbeRay = {
        pos: { x: emissionOrigin.x, y: emissionOrigin.y, z: emissionOrigin.z },
        dir: chiefDirection,
        wavelength: wavelengthUm,
      };
      const chiefTraced = (calculator as any)?.traceRayToEval?.(chiefProbeRay, n0Obj, wasmTraceOptions)
        || (calculator as any)?.generateInfiniteChiefRay?.(fieldSetting)
        || (calculator as any)?.referenceChiefRay
        || (calculator as any)?.referenceRay
        || null;

      // Perpendicular basis — same algorithm as native Rust build_perpendicular_basis_native.
      const _parallelAxes = (calculator as any)?._buildPerpendicularAxes?.(chiefDirection)
        || { ex: { x: 0, y: 1, z: 0 }, ey: { x: 0, y: 0, z: 1 } };
      const _pEx = _parallelAxes.ex;
      const _pEy = _parallelAxes.ey;

      const stopRadius = Number((calculator as any)?._getCachedStopRadiusMm?.());
      const entranceRadius = Number((calculator as any)?._getCachedEntranceRadiusMm?.());
      const fieldMagnitude = Math.hypot(xVal, yVal);
      const entranceRadiusScale = Math.max(0.76, Math.min(0.92, 0.92 - 0.012 * fieldMagnitude));
      // Match native Rust: sampling_radius = stop_radius.min(entrance_radius) for stop mode.
      const samplingRadiusMm = effectivePupilSamplingMode === "entrance"
        ? Math.max(0.01, (Number.isFinite(entranceRadius) && entranceRadius > 0 ? entranceRadius : Number.isFinite(stopRadius) && stopRadius > 0 ? stopRadius : 1) * entranceRadiusScale)
        : Math.max(0.01,
            (Number.isFinite(stopRadius) && stopRadius > 0 && Number.isFinite(entranceRadius) && entranceRadius > 0)
              ? Math.min(stopRadius, entranceRadius)
              : (Number.isFinite(stopRadius) && stopRadius > 0 ? stopRadius : 1));
      const chiefOpl = Number((calculator as any)?.calculateOpticalPath?.(chiefTraced));
      if (!(Number.isFinite(chiefOpl) && chiefOpl > 0)) {
        throw new Error("runNativeOpdMap(web): chief optical path is invalid");
      }

      let launchOrigin = emissionOrigin;
      try {
        const chiefPath = (calculator as any)?.extractPathData?.(chiefTraced);
        const p0 = Array.isArray(chiefPath) ? chiefPath[0] : null;
        const x0 = Number((p0 as any)?.x);
        const y0 = Number((p0 as any)?.y);
        const z0 = Number((p0 as any)?.z);
        if (Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(z0)) {
          launchOrigin = { x: x0, y: y0, z: z0 };
        }
      } catch (_) {}

      const n = gridSize;
      const pupilCoordinates: Array<{ x: number; y: number; ix: number; iy: number; r: number }> = [];
      const rawOpdsMicrons: number[] = [];
      const rawOpdsWaves: number[] = [];
      let sampleCount = 0;
      for (let iy = 0; iy < n; iy++) {
        const v = n > 1 ? -1 + (2 * iy) / (n - 1) : 0;
        for (let ix = 0; ix < n; ix++) {
          const u = n > 1 ? -1 + (2 * ix) / (n - 1) : 0;
          const radius = Math.hypot(u, v);
          if (!(Number.isFinite(radius) && radius <= 1.0 + 1e-9)) continue;
          sampleCount += 1;

          // Parallel-shift approach matching native Rust build_marginal_ray in infinite mode:
          //   origin = effective_emission_origin + u_axis * u * sampling_radius
          //                                      + v_axis * v * sampling_radius
          // No Newton iteration for marginal rays — native does the same for infinite conjugates.
          if (!launchOrigin) continue;
          const ox = launchOrigin.x + _pEx.x * u * samplingRadiusMm + _pEy.x * v * samplingRadiusMm;
          const oy = launchOrigin.y + _pEx.y * u * samplingRadiusMm + _pEy.y * v * samplingRadiusMm;
          const oz = launchOrigin.z + _pEx.z * u * samplingRadiusMm + _pEy.z * v * samplingRadiusMm;
          const marginalRay = { pos: { x: ox, y: oy, z: oz }, dir: chiefDirection, wavelength: wavelengthUm };
          const traced = (calculator as any)?.traceRayToEval?.(marginalRay, n0Obj, wasmTraceOptions);
          const opl = Number((calculator as any)?.calculateOpticalPath?.(traced));
          if (!Number.isFinite(opl)) continue;

          const opdMicrons = opl - chiefOpl;
          const opdWaves = opdMicrons / wavelengthUm;
          if (!(Number.isFinite(opdMicrons) && Number.isFinite(opdWaves))) continue;

          pupilCoordinates.push({ x: u, y: v, ix, iy, r: radius });
          rawOpdsMicrons.push(opdMicrons);
          rawOpdsWaves.push(opdWaves);
        }
      }

      const rawOpdGrid = buildOpdGridFromSamples(n, pupilCoordinates, rawOpdsWaves);
      const displayOpdGrid = applyOpdDisplayModeGridNativeLike(rawOpdGrid, opdDisplayMode);

      const chiefReferenceMode = effectivePupilSamplingMode === "entrance"
        ? (requestedPupilSamplingMode === "entrance"
          ? `entrance-chief-requested(web,r=${entranceRadiusScale.toFixed(3)})`
          : `entrance-chief-fallback(web,r=${entranceRadiusScale.toFixed(3)})`)
        : "center-chief";

      return {
        backend: "web-rust-wasm",
        targetSurface,
        stopSurface: Number((calculator as any)?.stopSurfaceIndex ?? 0),
        requestedObjectIndex: objectIndex,
        usedObjectIndex: objectIndex,
        usedObjectPosition: isAngle ? "angle" : "height",
        usedObjectX: xVal,
        usedObjectY: yVal,
        wavelengthUm,
        gridSize: n,
        sampleCount,
        hitCount: pupilCoordinates.length,
        pupilSamplingMode: effectivePupilSamplingMode,
        rawOpdGrid,
        displayOpdGrid,
        message: `Computed via Web Rust/WASM OPD API (chief reference mode=${chiefReferenceMode})`,
      };
    }

    let wavefrontMap: any;
    const prevForcedMode = (globalThis as any).__COOPT_FORCE_INFINITE_PUPIL_MODE;
    try {
      // Native parity: default should stay stop-sampling unless explicitly entrance.
      (globalThis as any).__COOPT_FORCE_INFINITE_PUPIL_MODE = requestedPupilSamplingMode;
      wavefrontMap = await analyzer.generateWavefrontMap(fieldSetting, gridSize, "circular", {
        forceRustWasm: true,
        skipZernikeFit: true,
        opdDisplayMode,
        traceOptions: {
          useRustWasm: true,
          requireRustWasm: true,
          allowNonStrict: false,
        },
      });
    } finally {
      try {
        if (prevForcedMode === undefined) {
          delete (globalThis as any).__COOPT_FORCE_INFINITE_PUPIL_MODE;
        } else {
          (globalThis as any).__COOPT_FORCE_INFINITE_PUPIL_MODE = prevForcedMode;
        }
      } catch (_) {}
    }

    const n = Math.max(1, Number(wavefrontMap?.gridSize) || gridSize);
    const rawValues = Array.isArray(wavefrontMap?.raw?.opdsInWavelengths)
      ? wavefrontMap.raw.opdsInWavelengths
      : (Array.isArray(wavefrontMap?.opdsInWavelengths) ? wavefrontMap.opdsInWavelengths : []);
    const displayValues = Array.isArray(wavefrontMap?.display?.opdsInWavelengths)
      ? wavefrontMap.display.opdsInWavelengths
      : rawValues;
    const coords = Array.isArray(wavefrontMap?.pupilCoordinates) ? wavefrontMap.pupilCoordinates : [];

    const rawOpdGrid: Array<Array<number | null>> = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
    const displayOpdGrid: Array<Array<number | null>> = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
    let hitCount = 0;
    const m = Math.min(coords.length, rawValues.length, displayValues.length);
    for (let i = 0; i < m; i++) {
      const p = coords[i] || {};
      const ix = Number.isInteger((p as any).ix)
        ? Number((p as any).ix)
        : Math.round(((Number((p as any).x) + 1) * 0.5) * (n - 1));
      const iy = Number.isInteger((p as any).iy)
        ? Number((p as any).iy)
        : Math.round(((Number((p as any).y) + 1) * 0.5) * (n - 1));
      if (ix < 0 || iy < 0 || ix >= n || iy >= n) continue;
      const rv = Number(rawValues[i]);
      const dv = Number(displayValues[i]);
      if (Number.isFinite(rv)) {
        rawOpdGrid[iy][ix] = rv;
        hitCount += 1;
      }
      if (Number.isFinite(dv)) displayOpdGrid[iy][ix] = dv;
    }

    let targetSurface = Number(payload?.surfaceIndex);
    if (!Number.isInteger(targetSurface) || targetSurface < 0) {
      targetSurface = Math.max(0, opticalSystemRows.findIndex((r: any) => String(r?.["object type"] ?? r?.object ?? "").toLowerCase() === "image"));
      if (targetSurface <= 0) targetSurface = Math.max(0, opticalSystemRows.length - 1);
    }

    const effectivePupilSamplingMode = (() => {
      const mode = String((wavefrontMap as any)?.pupilSamplingMode || "").toLowerCase();
      if (mode === "stop" || mode === "entrance") return mode;
      return requestedPupilSamplingMode;
    })();

    return {
      backend: "web-rust-wasm",
      targetSurface,
      stopSurface: Number((calculator as any)?.stopSurfaceIndex ?? 0),
      requestedObjectIndex: objectIndex,
      usedObjectIndex: objectIndex,
      usedObjectPosition: isAngle ? "angle" : "height",
      usedObjectX: xVal,
      usedObjectY: yVal,
      wavelengthUm,
      gridSize: n,
      sampleCount: n * n,
      hitCount,
      pupilSamplingMode: effectivePupilSamplingMode,
      rawOpdGrid,
      displayOpdGrid,
      message: "Computed via Web Rust/WASM OPD API",
    };
  }
  return invokeCommand<NativeOpdMapRequest, NativeOpdMapResponse>("run_native_opd_map", payload);
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

    const frequencyAxis: number[] = [];
    const mtfSagittal: number[] = [];
    const mtfTangential: number[] = [];
    for (let i = 0; i < points; i++) {
      const f = (i / Math.max(1, points - 1)) * maxFreq;
      frequencyAxis.push(f);
      mtfSagittal.push(sampleLinear(freqDiscrete, sagittalDiscrete, f));
      mtfTangential.push(sampleLinear(freqDiscrete, tangentialDiscrete, f));
    }
    if (mtfSagittal.length > 0) mtfSagittal[0] = 1;
    if (mtfTangential.length > 0) mtfTangential[0] = 1;

    return {
      backend: "web-rust-wasm",
      frequencyAxis,
      mtfTangential,
      mtfSagittal,
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

        const s = samplingSize;
        const gridOpd = Array.from({ length: s }, () => Array.from({ length: s }, () => 0));
        const pupilMask = Array.from({ length: s }, () => Array.from({ length: s }, () => false));
        const raw = Array.isArray(opdResp?.rawOpdGrid) ? opdResp.rawOpdGrid : [];
        const display = Array.isArray(opdResp?.displayOpdGrid) ? opdResp.displayOpdGrid : [];
        for (let iy = 0; iy < s; iy++) {
          for (let ix = 0; ix < s; ix++) {
            const rawCell = Number((raw as any)?.[iy]?.[ix]);
            if (!Number.isFinite(rawCell)) continue;
            const displayCell = Number((display as any)?.[iy]?.[ix]);
            const waves = Number.isFinite(displayCell) ? displayCell : rawCell;
            pupilMask[iy][ix] = true;
            // Native contract expects OPD in um, while OPD map grids are in waves.
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
  if (!isTauriRuntime()) {
    const { showFieldMTFDiagram } = await import("../../../evaluation/mtf-plot.ts");
    const progress = typeof (payload as any)?.onProgress === 'function'
      ? (payload as any).onProgress
      : undefined;
    const hidden = document.createElement("div");
    hidden.style.display = "none";
    document.body.appendChild(hidden);
    try {
      const out: any = await showFieldMTFDiagram({
        wavelengthMicrons: Array.isArray(payload?.wavelengths) && payload.wavelengths.length > 1
          ? 'all'
          : (Array.isArray(payload?.wavelengths) && payload.wavelengths.length === 1 ? payload.wavelengths[0] : undefined),
        firstFrequencyLpmm: payload?.firstFrequencyLpmm,
        secondFrequencyLpmm: payload?.secondFrequencyLpmm,
        fieldMin: payload?.fieldMin,
        fieldMax: payload?.fieldMax,
        steps: payload?.steps,
        samplingSize: payload?.samplingSize,
        zeroPadTo: payload?.zeroPadTo,
        opdDisplayMode: payload?.opdDisplayMode,
        fieldAxisMode: payload?.fieldAxisMode as any,
        containerElement: hidden,
        onProgress: progress,
      });
      const traces = Array.isArray(out?.traces) ? out.traces : [];
      const xAxis = traces.length > 0 && Array.isArray(traces[0]?.x) ? traces[0].x.map((v: any) => Number(v)) : [];
      const f1 = Number(payload?.firstFrequencyLpmm);
      const f2 = Number(payload?.secondFrequencyLpmm);
      const byWl = new Map<string, any>();

      for (const tr of traces) {
        const name = String(tr?.name || '');
        const nmMatch = name.match(/([0-9]+(?:\.[0-9]+)?)\s*nm/i);
        const wlUm = nmMatch ? (Number(nmMatch[1]) / 1000) : (Array.isArray(payload?.wavelengths) && payload.wavelengths.length ? Number(payload.wavelengths[0]) : 0.5876);
        const key = `${wlUm}`;
        if (!byWl.has(key)) {
          byWl.set(key, {
            wavelengthUm: wlUm,
            label: `${(wlUm * 1000).toFixed(1)}nm`,
            meridionalFirst: [],
            sagittalFirst: [],
            meridionalSecond: [],
            sagittalSecond: [],
            fieldDiagnostics: [],
          });
        }
        const row = byWl.get(key);
        const yVals = Array.isArray(tr?.y) ? tr.y.map((v: any) => Number(v)) : [];
        const freqMatch = name.match(/([0-9]+(?:\.[0-9]+)?)\s*lp\/mm/i);
        const freq = freqMatch ? Number(freqMatch[1]) : NaN;
        const isFirst = Number.isFinite(f1) && Number.isFinite(freq) ? Math.abs(freq - f1) <= Math.abs(freq - f2) : true;
        const isMeridional = /meridional|tangential/i.test(name);
        const isSagittal = /sagittal/i.test(name);
        if (isMeridional && isFirst) row.meridionalFirst = yVals;
        else if (isMeridional) row.meridionalSecond = yVals;
        else if (isSagittal && isFirst) row.sagittalFirst = yVals;
        else if (isSagittal) row.sagittalSecond = yVals;
      }

      return {
        backend: "web-rust-wasm",
        xAxis,
        axisMode: String(payload?.fieldAxisMode || 'angle') as any,
        series: Array.from(byWl.values()),
        message: "Computed via Web Rust/WASM Field MTF API",
      };
    } finally {
      try { hidden.remove(); } catch (_) {}
    }
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
    const finiteSystem = isFiniteConjugateNativeLike(opticalSystemRows);
    const objectDistance = getObjectDistanceMmNativeLike(opticalSystemRows);
    const paraxial = calculateParaxialData(opticalSystemRows, wavelength);
    const focalLength = Number(paraxial?.focalLength);
    const imageDistance = Number(paraxial?.imageDistance);
    const magnification = heightMode && finiteSystem && Number.isFinite(imageDistance) && Math.abs(objectDistance) > 1e-12
      ? (imageDistance / objectDistance)
      : -1;

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
      rayCount: 11,
      ringCount: 1,
      pattern: "cross",
      wavelengthMode: "primary",
    });

    const realHeights = new Array(fieldSamples.length).fill(null) as Array<number | null>;
    const series = Array.isArray(spotResponse?.series) ? spotResponse.series : [];
    for (const row of series as any[]) {
      const match = String(row?.label || "").match(/Field-(\d+)/);
      if (!match) continue;
      const index = Number(match[1]);
      if (!Number.isInteger(index) || index < 0 || index >= realHeights.length) continue;
      const yUm = Number(row?.chiefPointUm?.yUm);
      if (Number.isFinite(yUm)) {
        realHeights[index] = Math.abs(yUm / 1000);
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
      if (!Number.isFinite(Number(height))) return null;
      return (Number(height) - ideal) / ideal;
    });
    const distortionPercent = distortion.map((value) => (Number.isFinite(Number(value)) ? Number(value) * 100 : null));

    return {
      backend: "web-rust-wasm",
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
    const maxFieldAngle = deriveMaxFieldAngleNativeLike(Array.isArray(payload?.objectRows) ? payload.objectRows : []);
    const paraxial = calculateParaxialData(opticalSystemRows, wavelength);
    const focalLength = Number(paraxial?.focalLength);
    if (!(Number.isFinite(focalLength) && Math.abs(focalLength) > 1e-12)) {
      throw new Error("Web grid distortion calculation failed: focal length is unavailable");
    }
    const maxImageHeight = focalLength * Math.tan((maxFieldAngle * Math.PI) / 180);
    const step = (2 * maxImageHeight) / Math.max(1, gridSize - 1);

    const idealX: number[] = [];
    const idealY: number[] = [];
    const objectRows: any[] = [];
    for (let yi = 0; yi < gridSize; yi++) {
      const imageY = -maxImageHeight + yi * step;
      const thetaYRad = Math.atan(imageY / focalLength);
      const thetaY = (thetaYRad * 180) / Math.PI;
      for (let xi = 0; xi < gridSize; xi++) {
        const imageX = -maxImageHeight + xi * step;
        const thetaXRad = Math.atan(imageX / focalLength);
        const thetaX = (thetaXRad * 180) / Math.PI;
        const index = yi * gridSize + xi;
        idealX.push(imageX);
        idealY.push(imageY);
        if (finiteSystem) {
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

    const spotResponse = await runNativeSpotRaytrace({
      opticalSystemRows,
      sourceRows,
      objectRows,
      surfaceIndex,
      rayCount: 11,
      ringCount: 1,
      pattern: "cross",
      wavelengthMode: "primary",
    });
    const realX = new Array(idealX.length).fill(null) as Array<number | null>;
    const realY = new Array(idealY.length).fill(null) as Array<number | null>;
    const series = Array.isArray(spotResponse?.series) ? spotResponse.series : [];
    for (const row of series as any[]) {
      const match = String(row?.label || "").match(/Field-(\d+)/);
      if (!match) continue;
      const index = Number(match[1]);
      if (!Number.isInteger(index) || index < 0 || index >= realX.length) continue;
      const xUm = Number(row?.chiefPointUm?.xUm);
      const yUm = Number(row?.chiefPointUm?.yUm);
      if (Number.isFinite(xUm) && Number.isFinite(yUm)) {
        realX[index] = xUm / 1000;
        realY[index] = yUm / 1000;
      }
    }

    return {
      backend: "web-rust-wasm",
      idealX,
      idealY,
      realX,
      realY,
      gridSize,
      maxFieldAngle,
      meta: {
        wavelength,
        focalLength,
        finiteSystem,
        surfaceIndex,
      },
      message: "Computed via Web Rust/WASM grid distortion API",
    };
  }
  return invokeCommand<NativeGridDistortionRequest, NativeGridDistortionResponse>("run_native_grid_distortion", payload);
}

export async function runNativeMagnificationChromaticAberration(
  payload: NativeMagnificationChromaticAberrationRequest,
): Promise<NativeMagnificationChromaticAberrationResponse> {
  if (!isTauriRuntime()) {
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
        chiefRayDefinition: payload?.chiefRayDefinition || 'stop-center',
        requireRustWasm: true,
      },
    );
    if (!result) throw new Error("Web LCA calculation failed");
    return result as NativeMagnificationChromaticAberrationResponse;
  }
  return invokeCommand<NativeMagnificationChromaticAberrationRequest, NativeMagnificationChromaticAberrationResponse>(
    "run_native_magnification_chromatic_aberration",
    payload,
  );
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
  return invokeCommand<boolean>("optimizer_request_stop");
}

export async function clearOptimizerStop(): Promise<boolean> {
  return invokeCommand<boolean>("optimizer_clear_stop");
}

export async function dropOptimizerSession(sessionId: string): Promise<boolean> {
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
