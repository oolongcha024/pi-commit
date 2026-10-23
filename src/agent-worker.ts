import { parentPort } from "node:worker_threads";
import { createCommitAgent, createModelRuntime } from "./agent.js";
import type {
  WorkerOperation,
  WorkerRequest,
  WorkerResponse,
} from "./agent-worker-protocol.js";

if (!parentPort) throw new Error("Model worker requires a parent port");
const port = parentPort;
const controller = new AbortController();
let runtime: Awaited<ReturnType<typeof createModelRuntime>>;
let agent: Awaited<ReturnType<typeof createCommitAgent>> | undefined;
let agentDir: string | undefined;
let queue = Promise.resolve();

async function execute(operation: WorkerOperation) {
  controller.signal.throwIfAborted();
  switch (operation.kind) {
    case "initialize":
      agentDir = operation.agentDir;
      runtime = await createModelRuntime(agentDir, controller.signal);
      return;
    case "models":
      return (
        await runtime.getAvailable(undefined, { signal: controller.signal })
      ).map(({ provider, id }) => ({ provider, id }));
    case "create":
      agent = await createCommitAgent({
        ...operation,
        agentDir,
        runtime,
        signal: controller.signal,
      });
      return;
    case "run":
      if (!agent) throw new Error("模型会话尚未初始化。");
      return agent.run(operation.input, controller.signal);
  }
}

port.on("message", (request: WorkerRequest) => {
  if ("kind" in request) {
    controller.abort();
    if (request.kind === "close") {
      void queue.finally(() => {
        agent?.dispose();
        port.close();
      });
    }
    return;
  }
  queue = queue.then(async () => {
    let response: WorkerResponse;
    try {
      response = { id: request.id, value: await execute(request.operation) };
    } catch (error) {
      response = {
        id: request.id,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    port.postMessage(response);
  });
});
