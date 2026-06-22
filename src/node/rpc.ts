import type { ConfigOverrides } from "../config/resolve.ts";
import type { FileResult } from "../types.ts";

export interface WorkerRunRequest {
  type: "run";
  id: number;
  file: string;
  overrides: ConfigOverrides;
  hasGlobalOnly: boolean;
}

export interface WorkerRunResponse {
  type: "result";
  id: number;
  result: FileResult;
}

export interface WorkerRunFailure {
  type: "error";
  id: number;
  error: { message: string; stack?: string };
}

export type WorkerRequest = WorkerRunRequest;
export type WorkerResponse = WorkerRunResponse | WorkerRunFailure;
