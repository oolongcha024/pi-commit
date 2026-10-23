import type { TurnResult } from "./agent.js";
import type { WritingOptions } from "./prompt.js";

export type WorkerOperation =
  | { kind: "initialize"; agentDir?: string }
  | { kind: "models" }
  | ({ kind: "create"; cwd: string; modelId: string } & WritingOptions)
  | { kind: "run"; input: string };

export type WorkerRequest =
  | { id: number; operation: WorkerOperation }
  | { kind: "abort" | "close" };

export interface AvailableModel {
  provider: string;
  id: string;
}

export type WorkerResponse =
  | { id: number; value: AvailableModel[] | TurnResult | undefined }
  | { id: number; error: { name: string; message: string } };
