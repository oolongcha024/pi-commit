import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearLine,
  clearScreenDown,
  cursorTo,
  moveCursor,
} from "node:readline";
import { createInterface } from "node:readline/promises";
import stringWidth from "string-width";
import { type Terminal, TerminalRenderer } from "./ui.js";
import { createCommitUI } from "./ui-content.js";

export function createTerminal(
  controller: AbortController,
  options: { columns?: number; color?: boolean; unicode?: boolean } = {},
): Terminal & { close(): void } {
  const output = process.stdout;
  const input = process.stdin;
  const dynamic = Boolean(output.isTTY) && process.env.TERM !== "dumb";
  const color =
    dynamic &&
    process.env.NO_COLOR === undefined &&
    process.env.FORCE_COLOR !== "0";
  const view = () =>
    new TerminalRenderer({
      columns: options.columns ?? (output.columns || 80),
      color: options.color ?? color,
      unicode: options.unicode ?? process.env.TERM !== "dumb",
    });
  const readline = createInterface({ input, output });
  let closed = false;
  let stopStatus = () => {};
  readline.on("SIGINT", () => controller.abort());
  readline.on("close", () => {
    if (!closed) controller.abort();
  });

  const terminal: Terminal & { close(): void } = {
    show(text, tone) {
      stopStatus();
      output.write(`${view().notice(text, tone)}\n`);
    },
    header(info) {
      stopStatus();
      output.write(`${view().header(info)}\n`);
    },
    draft(message) {
      stopStatus();
      output.write(view().draft(message));
    },
    divider() {
      stopStatus();
      output.write(view().divider());
    },
    section(edge) {
      stopStatus();
      output.write(view().section(edge));
    },
    status(message) {
      stopStatus();
      if (!dynamic) {
        terminal.show(message, "info");
        return () => {};
      }
      const wasRaw = input.isRaw;
      readline.pause();
      input.setRawMode?.(false);
      const start = Date.now();
      let stopped = false;
      output.write("\u001b[?25l");
      const draw = () => {
        clearLine(output, 0);
        output.write(`\r${view().status(message, Date.now() - start)}`);
      };
      draw();
      const timer = setInterval(draw, 90);
      stopStatus = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        clearLine(output, 0);
        output.write("\r\u001b[?25h");
        input.setRawMode?.(wasRaw);
        readline.resume();
      };
      return stopStatus;
    },
    async ask(hint, actions) {
      stopStatus();
      controller.signal.throwIfAborted();
      if (!dynamic) {
        output.write(`${view().notice(hint)}\n`);
        if (actions) output.write(`${view().actions(actions)}\n`);
      }
      const prompt = view().prompt();
      const question = readline.question(prompt, { signal: controller.signal });
      const clearHint = () => {
        clearScreenDown(output);
      };
      if (dynamic) {
        const placeholder = view().placeholder(hint);
        output.write(placeholder);
        moveCursor(output, -stringWidth(placeholder), 0);
        // Draw after question(): readline clears everything below its prompt.
        // Shortcuts disappear with the placeholder on first input, leaving
        // readline free to wrap long feedback without overwriting a footer.
        if (actions?.length) {
          const footer = view().actions(actions);
          output.write(`\n${footer}\n`);
          moveCursor(output, 0, -(footer.split("\n").length + 1));
          cursorTo(output, stringWidth(prompt));
        }
        input.once("keypress", clearHint);
        output.once("resize", clearHint);
      }
      try {
        return await question;
      } finally {
        input.removeListener("keypress", clearHint);
        output.removeListener("resize", clearHint);
        if (dynamic) clearScreenDown(output);
        if (controller.signal.aborted) output.write("\n");
      }
    },
    async withExternalCommand(operation, section) {
      stopStatus();
      controller.signal.throwIfAborted();
      const wasRaw = input.isRaw;
      readline.pause();
      input.setRawMode?.(false);
      if (dynamic) output.write("\u001b[?25h");
      if (section === "git") terminal.section("start");
      try {
        const result = await operation();
        controller.signal.throwIfAborted();
        return result;
      } finally {
        if (section === "git") terminal.section("end");
        input.setRawMode?.(wasRaw);
        readline.resume();
      }
    },
    async edit(message) {
      stopStatus();
      const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
      if (!editor) {
        createCommitUI(terminal).notice("missingEditor");
        return undefined;
      }
      const directory = await mkdtemp(join(tmpdir(), "pi-commit-"));
      const path = join(directory, "COMMIT_EDITMSG");
      try {
        await writeFile(path, `${message}\n`, { mode: 0o600 });
        const code = await terminal.withExternalCommand(
          () =>
            new Promise<number | null>((resolve, reject) => {
              const child = spawn(
                "/bin/sh",
                ["-c", `${editor} "$1"`, "pi-commit-editor", path],
                { stdio: "inherit" },
              );
              child.on("error", reject);
              child.on("close", resolve);
            }),
        );
        if (code !== 0) {
          createCommitUI(terminal).notice("editorFailed");
          return undefined;
        }
        return await readFile(path, "utf8");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    close() {
      stopStatus();
      closed = true;
      readline.close();
    },
  };
  return terminal;
}
