import type { CommitAgent, TurnResult } from "./agent.js";
import type { GitRepository, GitSnapshot } from "./git.js";
import { type CommitDraft, formatMessage, parseMessage } from "./message.js";
import type { Terminal } from "./ui.js";
import { createCommitUI } from "./ui-content.js";

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
  noSign?: boolean;
  signal?: AbortSignal;
}

/** User acceptance and Git execution stay outside the model tool. */
export async function runCommitLoop(options: LoopOptions): Promise<number> {
  const { agent, git, terminal, signal } = options;
  const ui = createCommitUI(terminal);
  let draft: CommitDraft | undefined;
  let expected: GitSnapshot | undefined;
  let feedback = "Generate the first draft.";
  let generate = true;
  let shownSnapshot: GitSnapshot | undefined;
  let requestFailed = false;
  let commitFailed = false;
  const exit = () => {
    ui.notice("exited");
    return 0;
  };

  while (true) {
    signal?.throwIfAborted();
    if (generate) {
      if (!(await git.hasStagedChanges())) {
        ui.notice("empty");
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
          noSign: options.noSign,
          summary: await git.summary(),
        });
        shownSnapshot = snapshot;
      }
      requestFailed = false;
      try {
        let result: TurnResult;
        const stop = ui.status(draft ? "revising" : "generating");
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
          if (result.finalText) terminal.show(result.finalText);
          else ui.notice("noDraft");
          if (result.errors.length) terminal.show(result.errors.join("\n"));
          return 1;
        }
        draft = result.draft;
        expected = snapshot;
        commitFailed = false;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error) terminal.show(error.message, "error");
        else ui.notice("requestFailed");
        if (!draft) {
          if ((await ui.ask({ kind: "retry" })).trim().toLowerCase() === "r")
            continue;
          return 1;
        }
        requestFailed = true;
        ui.notice("draftRetained");
      }
      generate = false;
    }

    if (!draft || !expected) throw new Error("缺少有效草稿或 Git 状态。");
    terminal.draft(formatMessage(draft, options.emoji));
    let input = "";
    while (!input)
      input = (
        await ui.ask({ kind: "draft", commitFailed, requestFailed })
      ).trim();
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
        if ((await ui.ask({ kind: "edit" })).trim().toLowerCase() !== "e")
          return exit();
      }
      continue;
    }
    if (command === "y") {
      const message = formatMessage(draft, options.emoji);
      const snapshot = expected;
      const status = await terminal.withExternalCommand(
        () => git.commit(message, snapshot, options.noSign),
        "git",
      );
      signal?.throwIfAborted();
      if (status === "committed") {
        ui.notice("committed");
        return 0;
      }
      if (status === "failed") {
        ui.notice("commitFailed");
        commitFailed = true;
        continue;
      }
      ui.notice("changed");
      if ((await ui.ask({ kind: "changed" })).trim().toLowerCase() !== "r")
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
