#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { CommitAgent, createModelRuntime } from "./agent.js";
import { runCommitLoop } from "./app.js";
import { loadPreferences, preferencesPath, savePreferences } from "./config.js";
import { GitRepository } from "./git.js";
import { createTerminal } from "./terminal.js";

const HELP = `Usage: pi-commit [options] [修改背景...]

从整个 Git index 生成 Conventional Commit，并通过反馈或编辑修改。

Options:
  --language <zh|en>       消息语言（默认 en，可通过个人配置修改）
  --emoji                 根据 type 自动添加 emoji
  --no-emoji              本次关闭 emoji
  --model <provider/model> 本次使用的 pi 模型
  --agent-dir <path>      pi 配置目录（默认遵循 PI_CODING_AGENT_DIR）
  --help, -h              显示帮助
  --version, -v           显示版本

个人配置：${preferencesPath()}
首次未指定模型时，选择并保存到个人配置；不修改 pi 的偏好。`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      language: { type: "string" },
      emoji: { type: "boolean" },
      "no-emoji": { type: "boolean" },
      model: { type: "string" },
      "agent-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log("0.1.0");
    return 0;
  }
  if (values.language && values.language !== "zh" && values.language !== "en") {
    throw new Error("--language 必须为 zh 或 en。");
  }
  if (values.emoji && values["no-emoji"])
    throw new Error("--emoji 和 --no-emoji 不能同时使用。");

  const git = await GitRepository.open(process.cwd());
  if (!(await git.hasStagedChanges())) {
    console.log("没有 staged 变更，请先 git add。");
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("pi-commit 需要交互式终端。");
  }

  const preferences = await loadPreferences();
  const language =
    values.language === "zh" || values.language === "en"
      ? values.language
      : (preferences.language ?? "en");
  const emoji = values["no-emoji"]
    ? false
    : (values.emoji ?? preferences.emoji ?? false);
  const controller = new AbortController();
  const terminal = createTerminal(controller);
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let agent: CommitAgent | undefined;
  try {
    const stopLoading = terminal.status("正在加载模型配置…");
    let sdk: typeof import("./agent.js");
    let runtime: Awaited<ReturnType<typeof createModelRuntime>>;
    try {
      sdk = await import("./agent.js");
      controller.signal.throwIfAborted();
      runtime = await sdk.createModelRuntime(
        values["agent-dir"],
        controller.signal,
      );
    } finally {
      stopLoading();
    }
    controller.signal.throwIfAborted();
    let modelId = values.model ?? preferences.model;
    if (!modelId) {
      const available = await runtime.getAvailable(undefined, {
        signal: controller.signal,
      });
      if (!available.length) {
        throw new Error(
          "未找到有可用认证的 pi 模型。请在 pi 中 /login，或配置 provider 环境变量与 models.json。扩展动态注册的 provider 暂不支持。",
        );
      }
      terminal.show("选择默认模型：");
      available.forEach((model, index) => {
        terminal.show(`${index + 1}. ${model.provider}/${model.id}`);
      });
      while (!modelId) {
        const input = (await terminal.ask("输入模型编号，或 q 退出")).trim();
        if (input.toLowerCase() === "q") return 0;
        const selected = /^\d+$/u.test(input)
          ? available[Number(input) - 1]
          : undefined;
        if (!selected) {
          terminal.show("请输入列表中的模型编号。");
          continue;
        }
        modelId = `${selected.provider}/${selected.id}`;
      }
      await savePreferences({ ...preferences, model: modelId });
    }
    agent = await sdk.createCommitAgent({
      cwd: git.root,
      runtime,
      modelId,
      language,
      emoji,
      agentDir: values["agent-dir"],
      signal: controller.signal,
    });
    return await runCommitLoop({
      agent,
      git,
      terminal,
      emoji,
      model: modelId,
      language,
      context: positionals.join(" "),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      terminal.show("已取消。", "info");
      return 130;
    }
    throw error;
  } finally {
    agent?.dispose();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    terminal.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "pi-commit 执行失败。",
  );
  process.exitCode = 1;
}
