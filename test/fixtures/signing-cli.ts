import { writeFile } from "node:fs/promises";
import { runCommitLoop } from "../../src/app.js";
import { GitRepository } from "../../src/git.js";
import { createTerminal } from "../../src/terminal.js";

const directory = process.argv[2];
if (!directory) throw new Error("Missing disposable repository");
const controller = new AbortController();
const terminal = createTerminal(controller);
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
try {
  process.exitCode = await runCommitLoop({
    git: await GitRepository.open(directory),
    terminal,
    agent: {
      async run() {
        return {
          draft: { type: "fix", description: "restore session state" },
          finalText: "",
          errors: [],
        };
      },
      dispose() {},
    },
    model: "test/local",
    language: "en",
    emoji: false,
    context: "",
    signal: controller.signal,
  });
} catch (error) {
  if (!controller.signal.aborted) throw error;
  terminal.show("SIGNING_CANCELLED", "info");
  process.exitCode = 130;
} finally {
  // Test-only markers; never print or collect the entered passphrase.
  console.log(`RAW_RESTORED=${Boolean(process.stdin.isRaw)}`);
  terminal.close();
  await writeFile(`${directory}/terminal-closed`, String(!process.stdin.isRaw));
}
