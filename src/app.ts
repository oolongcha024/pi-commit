import type { CommitAgent, TurnResult } from "./agent.js";
import type { GitRepository, GitSnapshot } from "./git.js";
import { type CommitDraft, formatMessage, parseMessage } from "./message.js";
import type { NoticeTone, TerminalAction, TerminalHeader } from "./ui.js";

export interface Terminal {
  show(text: string, tone?: NoticeTone): void;
  header(info: TerminalHeader): void;
  draft(message: string): void;
  status(message: string): () => void;
  ask(prompt: string, actions?: TerminalAction[]): Promise<string>;
  edit(message: string): Promise<string | undefined>;
}

export interface LoopOptions {
  agent: CommitAgent;
  git: Pick<
    GitRepository,
    "root" | "snapshot" | "summary" | "hasStagedChanges" | "commit"
  >;
  terminal: Terminal;
  emoji: boolean;
  context: string;
  model: string;
  language: "zh" | "en";
  signal?: AbortSignal;
}

/** User acceptance and Git execution stay outside the model tool. */
export async function runCommitLoop(options: LoopOptions): Promise<number> {
  const { agent, git, terminal, signal } = options;
  let draft: CommitDraft | undefined;
  let expected: GitSnapshot | undefined;
  let feedback = "Generate the first draft.";
  let generate = true;
  let shownSnapshot: GitSnapshot | undefined;
  let requestFailed = false;
  let commitFailed = false;
  const exit = () => {
    terminal.show("已退出，未创建提交。", "info");
    return 0;
  };

  while (true) {
    signal?.throwIfAborted();
    if (generate) {
      if (!(await git.hasStagedChanges())) {
        terminal.show("没有 staged 变更，已退出。");
        return 0;
      }
      const snapshot = await git.snapshot();
      if (
        !shownSnapshot ||
        shownSnapshot.head !== snapshot.head ||
        shownSnapshot.tree !== snapshot.tree
      ) {
        terminal.header({
          model: options.model,
          language: options.language,
          emoji: options.emoji,
          summary: await git.summary(),
        });
        shownSnapshot = snapshot;
      }
      requestFailed = false;
      try {
        let result: TurnResult;
        const stop = terminal.status(
          draft ? "正在根据反馈修改…" : "正在生成提交消息…",
        );
        try {
          result = await agent.run(
            [
              `Repository root: ${JSON.stringify(git.root)}`,
              `Current HEAD and index tree: ${JSON.stringify(snapshot)}. Reinspect this state; older evidence may be stale.`,
              `User-provided background: ${JSON.stringify(options.context)}`,
              draft
                ? `Current accepted draft (including manual edits): ${JSON.stringify(draft)}`
                : "",
              `User feedback: ${JSON.stringify(feedback)}`,
            ]
              .filter(Boolean)
              .join("\n"),
            signal,
          );
        } finally {
          stop();
        }
        signal?.throwIfAborted();
        if (!result.draft) {
          terminal.show(result.finalText || "模型未交付有效草稿，已退出。");
          if (result.errors.length) terminal.show(result.errors.join("\n"));
          return 1;
        }
        draft = result.draft;
        expected = snapshot;
        commitFailed = false;
      } catch (error) {
        signal?.throwIfAborted();
        terminal.show(
          error instanceof Error ? error.message : "模型请求失败。",
          "error",
        );
        if (!draft) {
          if (
            (
              await terminal.ask("选择下一步操作", [
                { key: "r", label: "重试", primary: true },
                { key: "q", label: "退出" },
              ])
            )
              .trim()
              .toLowerCase() === "r"
          )
            continue;
          return 1;
        }
        requestFailed = true;
        terminal.show("请求失败，上一版草稿已保留。", "warning");
      }
      generate = false;
    }

    if (!draft || !expected) throw new Error("缺少有效草稿或 Git 状态。");
    terminal.draft(formatMessage(draft, options.emoji));
    const actions: TerminalAction[] = [
      {
        key: "y",
        label: commitFailed
          ? "重试提交"
          : requestFailed
            ? "使用旧稿提交"
            : "提交",
        primary: true,
      },
      { key: "e", label: "编辑" },
      { key: "r", label: requestFailed ? "重试生成" : "重新生成" },
      { key: "q", label: "退出" },
    ];
    let input = "";
    while (!input)
      input = (await terminal.ask("输入修改意见，或选择操作", actions)).trim();
    signal?.throwIfAborted();
    const command = input.toLowerCase();
    if (command === "q") return exit();
    if (command === "r") {
      if (!requestFailed)
        feedback =
          "Generate a fresh draft for the current staged changes. Preserve applicable earlier feedback and manual edits.";
      generate = true;
      continue;
    }
    if (command === "e") {
      let text = formatMessage(draft, options.emoji);
      while (true) {
        const edited = await terminal.edit(text);
        signal?.throwIfAborted();
        if (edited === undefined) break;
        text = edited;
        const result = parseMessage(text);
        if (result.accepted) {
          draft = result.draft;
          commitFailed = false;
          break;
        }
        terminal.show(result.errors.join("\n"), "warning");
        if (
          (
            await terminal.ask("修正消息格式后继续", [
              { key: "e", label: "继续编辑", primary: true },
              { key: "q", label: "退出" },
            ])
          )
            .trim()
            .toLowerCase() !== "e"
        )
          return exit();
      }
      continue;
    }
    if (command === "y") {
      terminal.show("正在检查并提交，运行 Git hooks…", "info");
      const status = await git.commit(
        formatMessage(draft, options.emoji),
        expected,
      );
      if (status === "committed") {
        terminal.show("提交完成。", "success");
        return 0;
      }
      if (status === "failed") {
        terminal.show(
          "Git 提交失败，草稿已保留。修正 hook 问题后可以重试。",
          "warning",
        );
        commitFailed = true;
        continue;
      }
      terminal.show("HEAD 或暂存内容已变化，当前消息尚未提交。", "warning");
      if (
        (
          await terminal.ask("选择下一步操作", [
            { key: "r", label: "基于新状态重新生成", primary: true },
            { key: "q", label: "退出" },
          ])
        )
          .trim()
          .toLowerCase() !== "r"
      )
        return exit();
      feedback =
        "HEAD or index changed. Review all current staged changes and generate a new draft. Preserve applicable earlier feedback.";
      generate = true;
      continue;
    }
    feedback = input;
    generate = true;
  }
}
