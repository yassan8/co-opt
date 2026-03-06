import { invoke } from "@tauri-apps/api/core";
import type {
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
  RunAnalysisPreviewRequest,
  RunAnalysisPreviewResponse,
  GridRecommendation,
  RecommendWavefrontGridForTimeRequest,
  RecommendWavefrontGridRequest,
} from "../../shared/contracts/analysis";

export async function opticsEcho(payload: OpticsEchoRequest): Promise<OpticsEchoResponse> {
  return invoke<OpticsEchoResponse>("optics_echo", { req: payload });
}

export async function runRaytracePreview(
  payload: RaytracePreviewRequest,
): Promise<RaytracePreviewResponse> {
  return invoke<RaytracePreviewResponse>("run_raytrace_preview", { req: payload });
}

export async function readTextFile(payload: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  return invoke<ReadTextFileResponse>("read_text_file", { req: payload });
}

export async function writeTextFile(payload: WriteTextFileRequest): Promise<WriteTextFileResponse> {
  return invoke<WriteTextFileResponse>("write_text_file", { req: payload });
}

export async function aiChat(payload: AiChatRequest): Promise<AiChatResponse> {
  return invoke<AiChatResponse>("ai_chat_stub", { req: payload });
}

export async function generateZmxText(payload: GenerateZmxTextRequest): Promise<GenerateZmxTextResponse> {
  return invoke<GenerateZmxTextResponse>("generate_zmx_text", { req: payload });
}

export async function parseZmxText(payload: ParseZmxTextRequest): Promise<ParseZmxTextResponse> {
  return invoke<ParseZmxTextResponse>("parse_zmx_text", { req: payload });
}

export async function runOptimizerStep(payload: OptimizeStepRequest): Promise<OptimizeStepResponse> {
  return invoke<OptimizeStepResponse>("run_optimizer_step", { req: payload });
}

export async function recommendWavefrontGrid(
  payload: RecommendWavefrontGridRequest,
): Promise<GridRecommendation> {
  return invoke<GridRecommendation>("recommend_wavefront_grid", { req: payload });
}

export async function recommendWavefrontGridForTime(
  payload: RecommendWavefrontGridForTimeRequest,
): Promise<GridRecommendation> {
  return invoke<GridRecommendation>("recommend_wavefront_grid_for_time", { req: payload });
}

export async function runAnalysisPreview(
  payload: RunAnalysisPreviewRequest,
): Promise<RunAnalysisPreviewResponse> {
  return invoke<RunAnalysisPreviewResponse>("run_analysis_preview", { req: payload });
}

export async function getNewProjectTemplate(): Promise<NewProjectTemplateResponse> {
  return invoke<NewProjectTemplateResponse>("new_project_template");
}

export async function getDefaultProject(): Promise<DefaultProjectResponse> {
  return invoke<DefaultProjectResponse>("load_default_project");
}
