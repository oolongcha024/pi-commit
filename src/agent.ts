import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expandPath } from "./config.js";
import { type CommitDraft, validateDraft } from "./message.js";
import { systemPrompt, type WritingOptions } from "./prompt.js";

export const draftSchema = Type.Object(
  {
    type: Type.String({
      description: "Conventional Commit type, e.g. fix. No emoji.",
    }),
    description: Type.String({
      description:
        "Single-line subject description, without a type prefix or emoji.",
    }),
    scope: Type.Optional(
      Type.String({ description: "Scope name only, without parentheses." }),
    ),
    body: Type.Optional(
      Type.String({ description: "Optional explanatory body." }),
    ),
    breakingChange: Type.Optional(
      Type.String({
        description:
          "Evidence-backed breaking change explanation, without the footer label.",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface TurnResult {
  draft?: CommitDraft;
  finalText: string;
  errors: string[];
}

export interface CommitAgent {
  run(input: string, signal?: AbortSignal): Promise<TurnResult>;
  dispose(): void;
}

export async function createModelRuntime(
  agentDir?: string,
  signal?: AbortSignal,
): Promise<ModelRuntime> {
  const directory = agentDir ? expandPath(agentDir) : getAgentDir();
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    signal,
  });
  if (runtime.getError())
    throw new Error(`pi 模型配置加载失败：${runtime.getError()}`);
  return runtime;
}

export function createResources(
  cwd: string,
  agentDir: string,
  options: WritingOptions,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: systemPrompt(options),
    appendSystemPromptOverride: () => [],
  });
}

export async function createCommitAgent(
  options: WritingOptions & {
    cwd: string;
    agentDir?: string;
    runtime: ModelRuntime;
    modelId: string;
    signal?: AbortSignal;
  },
): Promise<CommitAgent & { session: AgentSession }> {
  const separator = options.modelId.indexOf("/");
  const provider = options.modelId.slice(0, separator);
  const id = options.modelId.slice(separator + 1);
  const model = options.runtime.getModel(provider, id);
  if (separator < 1 || !model) {
    throw new Error(`找不到模型 ${options.modelId}；请检查 pi models.json。`);
  }
  if (
    !(
      await options.runtime.getAvailable(provider, { signal: options.signal })
    ).some((candidate) => candidate.id === id)
  ) {
    throw new Error(
      `模型 ${options.modelId} 没有可用认证。请在对应 pi 配置目录中使用 pi /login，或配置该 provider 的环境变量。`,
    );
  }

  let current: TurnResult = { finalText: "", errors: [] };
  const tool = defineTool({
    name: "write_commit_message",
    label: "交付提交消息",
    description:
      "Validate and deliver one structured commit draft for the whole index. Does not commit. Correct errors and retry when rejected.",
    parameters: draftSchema,
    async execute(_id, input) {
      const result = validateDraft(input);
      if (result.accepted) {
        current.draft = result.draft;
        current.errors = [];
      } else {
        current.errors = result.errors;
      }
      const response = result.accepted ? { accepted: true } : result;
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        details: response,
      };
    },
  });

  const directory = options.agentDir
    ? expandPath(options.agentDir)
    : getAgentDir();
  const resources = createResources(options.cwd, directory, options);
  await resources.reload();
  options.signal?.throwIfAborted();
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: directory,
    modelRuntime: options.runtime,
    model,
    resourceLoader: resources,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager: SettingsManager.inMemory(),
    tools: ["bash", "write_commit_message"],
    customTools: [tool],
  });
  if (options.signal?.aborted) {
    session.dispose();
    options.signal.throwIfAborted();
  }

  return {
    session,
    async run(input, signal) {
      signal?.throwIfAborted();
      current = { finalText: "", errors: [] };
      let failure: string | undefined;
      const unsubscribe = session.subscribe((event) => {
        if (
          event.type === "message_end" &&
          event.message.role === "assistant"
        ) {
          const message = event.message;
          failure =
            message.stopReason === "error" || message.stopReason === "aborted"
              ? message.errorMessage || message.stopReason
              : undefined;
        }
        if (
          event.type === "tool_execution_end" &&
          event.toolName === "write_commit_message" &&
          event.isError
        ) {
          const result = event.result as {
            content?: { type: string; text?: string }[];
          };
          current.errors = result.content
            ?.filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .filter(Boolean) ?? ["草稿工具参数无效。"];
        }
      });
      const abort = () => {
        void session.abort();
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        await session.prompt(input, { expandPromptTemplates: false });
        signal?.throwIfAborted();
        if (failure) {
          throw new Error(
            `模型 ${options.modelId} 请求失败：${failure}。认证失效时请在 pi 中重新 /login。`,
          );
        }
        current.finalText = session.getLastAssistantText() ?? "";
        return current;
      } finally {
        unsubscribe();
        signal?.removeEventListener("abort", abort);
      }
    },
    dispose: () => session.dispose(),
  };
}
