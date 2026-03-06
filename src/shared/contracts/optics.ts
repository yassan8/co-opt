export interface OpticsEchoRequest {
  jobId: string;
  payload: number[];
}

export interface OpticsEchoResponse {
  jobId: string;
  count: number;
  payloadSum: number;
}

export interface RaytracePreviewRequest {
  lensId: string;
  fieldIndex: number;
  rayCount: number;
}

export interface RaytracePreviewResponse {
  lensId: string;
  fieldIndex: number;
  tracedRays: number;
  rmsSpotUm: number;
}
