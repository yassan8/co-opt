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
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "../../shared/contracts/io-ai";

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
