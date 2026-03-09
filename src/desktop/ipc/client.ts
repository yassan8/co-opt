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

function invokeCommand<TResponse>(command: string): Promise<TResponse>;
function invokeCommand<TRequest, TResponse>(command: string, payload: TRequest): Promise<TResponse>;
function invokeCommand<TRequest, TResponse>(command: string, payload?: TRequest): Promise<TResponse> {
  if (payload === undefined) {
    return invoke<TResponse>(command);
  }
  return invoke<TResponse>(command, { req: payload });
}

function assertArrayField(value: unknown, fieldName: string, commandName: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${commandName} requires ${fieldName} to be an array`);
  }
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
  return invokeCommand<NativeSpotRaytraceRequest, NativeSpotRaytraceResponse>("run_native_spot_raytrace", payload);
}

export async function runNativeSphericalAberration(
  payload: NativeSphericalAberrationRequest,
): Promise<NativeSphericalAberrationResponse> {
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
  return invokeCommand<NativeAstigmatismRequest, NativeAstigmatismResponse>("run_native_astigmatism", payload);
}

export async function runNativeTransverseAberration(
  payload: NativeTransverseAberrationRequest,
): Promise<NativeTransverseAberrationResponse> {
  return invokeCommand<NativeTransverseAberrationRequest, NativeTransverseAberrationResponse>(
    "run_native_transverse_aberration",
    payload,
  );
}

export async function runNativeOpdMap(
  payload: NativeOpdMapRequest,
): Promise<NativeOpdMapResponse> {
  return invokeCommand<NativeOpdMapRequest, NativeOpdMapResponse>("run_native_opd_map", payload);
}

export async function runNativePsfMap(
  payload: NativePsfMapRequest,
): Promise<NativePsfMapResponse> {
  return invokeCommand<NativePsfMapRequest, NativePsfMapResponse>("run_native_psf_map", payload);
}

export async function runNativeMtfMap(
  payload: NativeMtfMapRequest,
): Promise<NativeMtfMapResponse> {
  return invokeCommand<NativeMtfMapRequest, NativeMtfMapResponse>("run_native_mtf_map", payload);
}

export async function runNativeThroughFocusMtfMap(
  payload: NativeThroughFocusMtfMapRequest,
): Promise<NativeThroughFocusMtfMapResponse> {
  return invokeCommand<NativeThroughFocusMtfMapRequest, NativeThroughFocusMtfMapResponse>(
    "run_native_through_focus_mtf_map",
    payload,
  );
}

export async function runNativeFieldMtfMap(
  payload: NativeFieldMtfMapRequest,
): Promise<NativeFieldMtfMapResponse> {
  return invokeCommand<NativeFieldMtfMapRequest, NativeFieldMtfMapResponse>(
    "run_native_field_mtf_map",
    payload,
  );
}

export async function runNativeDistortion(
  payload: NativeDistortionRequest,
): Promise<NativeDistortionResponse> {
  return invokeCommand<NativeDistortionRequest, NativeDistortionResponse>("run_native_distortion", payload);
}

export async function runNativeGridDistortion(
  payload: NativeGridDistortionRequest,
): Promise<NativeGridDistortionResponse> {
  return invokeCommand<NativeGridDistortionRequest, NativeGridDistortionResponse>("run_native_grid_distortion", payload);
}

export async function runNativeMagnificationChromaticAberration(
  payload: NativeMagnificationChromaticAberrationRequest,
): Promise<NativeMagnificationChromaticAberrationResponse> {
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
