import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearLine, moveCursor } from "node:readline";
import { createInterface } from "node:readline/promises";
import stringWidth from "string-width";
import type { Terminal } from "./app.js";
import { TerminalRenderer } from "./ui.js";

export function createTerminal(
  controller: AbortController,
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
      columns: output.columns || 80,
      color,
      unicode: process.env.TERM !== "dumb",
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
      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let index = 0;
      let stopped = false;
      output.write("\u001b[?25l");
      const draw = () => {
        clearLine(output, 0);
        output.write(
          `\r  ${view().paint(view().fit(`${frames[index++ % frames.length]} ${message} ${Math.floor((Date.now() - start) / 1000)}s`), "cyan")}`,
        );
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
      if (actions) output.write(`${view().actions(actions)}\n`);
      if (!dynamic) output.write(`${view().notice(hint)}\n`);
      const prompt = `  ${view().paint(dynamic ? "›" : ">", "cyan")} `;
      const question = readline.question(prompt, { signal: controller.signal });
      const clearHint = () => {
        clearLine(output, 1);
      };
      if (dynamic) {
        const placeholder = view().fit(hint);
        output.write(view().paint(placeholder, "dim"));
        moveCursor(output, -stringWidth(placeholder), 0);
        input.once("keypress", clearHint);
      }
      try {
        return await question;
      } finally {
        input.removeListener("keypress", clearHint);
        if (controller.signal.aborted) output.write("\n");
      }
    },
    async withExternalCommand(operation) {
      stopStatus();
      controller.signal.throwIfAborted();
      const wasRaw = input.isRaw;
      readline.pause();
      input.setRawMode?.(false);
      if (dynamic) output.write("\u001b[?25h");
      try {
        const result = await operation();
        controller.signal.throwIfAborted();
        return result;
      } finally {
        input.setRawMode?.(wasRaw);
        readline.resume();
      }
    },
    async edit(message) {
      stopStatus();
      const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
      if (!editor) {
        terminal.show(
          "请先配置 $VISUAL 或 $EDITOR（例如 export EDITOR='code --wait'）。",
          "warning",
        );
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
          terminal.show("编辑器退出失败，保留上一版草稿。", "warning");
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
