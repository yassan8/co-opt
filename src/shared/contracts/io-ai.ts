export interface ReadTextFileRequest {
  path: string;
}

export interface ReadTextFileResponse {
  path: string;
  content: string;
}

export interface WriteTextFileRequest {
  path: string;
  content: string;
}

export interface WriteTextFileResponse {
  path: string;
  bytesWritten: number;
}

export interface ExportFreeCadDocumentRequest {
  outputPath: string;
  stlText: string;
}

export interface ExportFreeCadDocumentResponse {
  path: string;
  solidCount: number;
  freeCadCommand: string;
}

export interface AiChatRequest {
  provider: string;
  model: string;
  userMessage: string;
}

export interface AiChatResponse {
  provider: string;
  model: string;
  answer: string;
}

export interface GenerateZmxTextRequest {
  opticalSystemRows: unknown[];
  sourceRows?: unknown[];
  objectRows?: unknown[];
  title?: string;
  units?: string;
}

export interface GenerateZmxTextResponse {
  zmxText: string;
}

export interface ParseZmxTextRequest {
  text: string;
}

export interface ParseZmxTextResponse {
  rows: unknown[];
  issues: Array<{ severity: string; message: string }>;
  sourceRows: unknown[];
  objectRows: unknown[];
  entrancePupilDiameterMm: number | null;
}
