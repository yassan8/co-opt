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
