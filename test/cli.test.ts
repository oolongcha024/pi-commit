import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");

test("help works outside Git; empty index exits before config or model initialization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-commit-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    cwd: directory,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: join(directory, "unused-agent"),
      XDG_CONFIG_HOME: join(directory, "unused-config"),
    },
  };
  const help = await exec(
    process.execPath,
    ["--import", tsx, cli, "--help"],
    options,
  );
  assert.match(help.stdout, /Usage: pi-commit/);
  await assert.rejects(
    exec(process.execPath, ["--import", tsx, cli], options),
    /不在 Git/,
  );
  await exec("git", ["init", "-q", directory]);
  const empty = await exec(
    process.execPath,
    ["--import", tsx, cli, "--model", "missing/model"],
    options,
  );
  assert.match(empty.stdout, /没有 staged 变更/);
  const files = await readdir(directory);
  assert.deepEqual(files, [".git"]);
});
