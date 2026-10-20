// Opt-in live integration check. Uses only a disposable repository, never commits.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCommitAgent, createModelRuntime } from "../src/agent.js";
import { formatMessage } from "../src/message.js";

const modelId = process.env.PI_COMMIT_SMOKE_MODEL || process.argv[2];
if (!modelId)
  throw new Error(
    "Usage: pnpm smoke provider/model (uses existing pi credentials)",
  );
const cwd = await mkdtemp(join(tmpdir(), "pi-commit-live-"));
const exec = promisify(execFile);
let agent: Awaited<ReturnType<typeof createCommitAgent>> | undefined;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 180000);
try {
  await exec("git", ["-C", cwd, "init", "-q"]);
  await writeFile(
    join(cwd, "README.md"),
    "# Example\n\nDocument the setup process.\n",
  );
  await exec("git", ["-C", cwd, "add", "README.md"]);
  const runtime = await createModelRuntime(undefined, controller.signal);
  agent = await createCommitAgent({
    cwd,
    runtime,
    modelId,
    language: "en",
    emoji: true,
  });
  const first = await agent.run(
    "Generate one commit draft for this staged README addition.",
    controller.signal,
  );
  assert.ok(first.draft, first.finalText || first.errors.join("\n"));
  console.log(formatMessage(first.draft, true));
  const second = await agent.run(
    "Rewrite the description and any body in concise Chinese. Keep the correct type.",
    controller.signal,
  );
  assert.ok(second.draft, second.finalText || second.errors.join("\n"));
  console.log(formatMessage(second.draft, true));
  assert.match(second.draft.description, /\p{Script=Han}/u);
  agent.dispose();
  agent = undefined;
  await writeFile(
    join(cwd, "CONTRIBUTING.md"),
    "# Commit convention\n\nEvery commit subject MUST start with '[TASK-123] ' before any type. This exact prefix is mandatory.\n",
  );
  await exec("git", ["-C", cwd, "add", "CONTRIBUTING.md"]);
  agent = await createCommitAgent({
    cwd,
    runtime,
    modelId,
    language: "en",
    emoji: true,
  });
  const incompatible = await agent.run(
    "Inspect all staged changes and applicable repository commit requirements, then generate a draft if supported.",
    controller.signal,
  );
  assert.equal(
    incompatible.draft,
    undefined,
    "Incompatible repository format must not produce a draft",
  );
  assert.ok(
    incompatible.finalText.trim(),
    "Explain why the repository convention is unsupported",
  );
  console.log(incompatible.finalText);
  console.log(
    "Live SDK smoke passed: shared auth, two in-memory turns and incompatible convention handling.",
  );
} finally {
  clearTimeout(timeout);
  agent?.dispose();
  await rm(cwd, { recursive: true, force: true });
}
