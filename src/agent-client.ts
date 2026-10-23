import { Worker } from "node:worker_threads";
import type { CommitAgent, TurnResult } from "./agent.js";
import type {
  AvailableModel,
  WorkerOperation,
  WorkerResponse,
} from "./agent-worker-protocol.js";
import type { WritingOptions } from "./prompt.js";

function startWorker(): Worker {
  const url = new URL("./agent-worker.js", import.meta.url);
  if (import.meta.url.endsWith(".ts")) {
    url.pathname = url.pathname.replace(/\.js$/u, ".ts");
    // tsx's CLI loader does not install TypeScript resolution in new workers.
    return new Worker(
      `import("tsx/esm/api").then(({ tsImport }) => tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)}))`,
      { eval: true },
    );
  }
  return new Worker(url);
}

/** Owns the SDK worker, including startup, cancellation and shutdown. */
export class AgentClient {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();
  private failure?: Error;
  private closing?: Promise<void>;
  private exited: Promise<void>;
  private abort = () => {
    this.fail(new DOMException("操作已取消。", "AbortError"));
    this.worker.postMessage({ kind: "abort" });
    void this.close();
  };

  constructor(
    private signal?: AbortSignal,
    worker = startWorker(),
  ) {
    this.worker = worker;
    this.worker.on("message", (response: WorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if ("error" in response) {
        const error = new Error(response.error.message);
        error.name = response.error.name;
        pending.reject(error);
      } else pending.resolve(response.value);
    });
    this.worker.on("error", (error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
    this.exited = new Promise((resolve) => {
      this.worker.once("exit", (code) => {
        this.fail(new Error(`模型工作线程已退出（${code}）。`));
        this.signal?.removeEventListener("abort", this.abort);
        resolve();
      });
    });
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
  }

  private request<T>(operation: WorkerOperation): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing) return Promise.reject(new Error("模型工作线程已关闭。"));
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.postMessage({ id, operation });
    });
  }

  initialize(agentDir?: string): Promise<void> {
    return this.request({ kind: "initialize", agentDir });
  }

  models(): Promise<AvailableModel[]> {
    return this.request({ kind: "models" });
  }

  async createAgent(
    options: WritingOptions & { cwd: string; modelId: string },
  ): Promise<CommitAgent> {
    await this.request({ kind: "create", ...options });
    return {
      run: async (input, signal) => {
        signal?.throwIfAborted();
        signal?.addEventListener("abort", this.abort, { once: true });
        try {
          return await this.request<TurnResult>({ kind: "run", input });
        } finally {
          signal?.removeEventListener("abort", this.abort);
        }
      },
      dispose: () => {
        void this.close();
      },
    };
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.fail(new Error("模型工作线程已关闭。"));
      this.closing = (async () => {
        this.worker.postMessage({ kind: "close" });
        const timeout = setTimeout(() => {
          void this.worker.terminate();
        }, 1000);
        try {
          await this.exited;
        } finally {
          clearTimeout(timeout);
        }
      })();
    }
    return this.closing;
  }
}
