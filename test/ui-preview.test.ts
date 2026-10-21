import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";

const exec = promisify(execFile);
const script = fileURLToPath(
  new URL("../scripts/ui-preview.ts", import.meta.url),
);

test("offline preview renders all states outside a repository without configuration or writes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-commit-ui-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { stdout } = await exec(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      script,
      "--all",
      "--no-color",
      "--ascii",
      "--width",
      "32",
    ],
    {
      cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(cwd, "missing-agent"),
        XDG_CONFIG_HOME: cwd,
      },
      timeout: 10000,
    },
  );
  assert.equal(stripVTControlCharacters(stdout), stdout);
  assert.equal((stdout.match(/^=== /gmu) ?? []).length, 20);
  for (const expected of [
    "正在生成提交消息",
    "使用旧稿提交",
    "重试生成",
    "重试提交",
    "基于新状态重新生成",
    "继续编辑",
    "提交完成",
    "已取消",
  ]) {
    assert.ok(stdout.includes(expected), expected);
  }
  assert.deepEqual(await readdir(cwd), []);
});

test("preview selects a single state and rejects unknown scenes or invalid widths", async () => {
  const run = (...args: string[]) =>
    exec(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), script, ...args],
      { timeout: 10000 },
    );
  const { stdout } = await run(
    "--scene",
    "revision-error",
    "--static",
    "--no-color",
  );
  assert.equal((stdout.match(/^=== /gmu) ?? []).length, 1);
  assert.match(stdout, /使用旧稿提交/u);
  assert.match(stdout, /重试生成/u);
  assert.ok(
    stdout.indexOf("› 输入修改意见") < stdout.indexOf("y 使用旧稿提交"),
  );
  const { stdout: success } = await run(
    "--scene",
    "success",
    "--static",
    "--no-color",
  );
  assert.match(success, /pi-commit \/ \ue0a0 feat\/session-recovery/u);
  assert.match(success, /── git ─/u);
  assert.ok(success.indexOf("── git") < success.indexOf("[main a1b2c3d]"));
  assert.match(success, /files changed[^\n]*\n\n─+\n✓ 提交完成/u);
  await assert.rejects(run("--scene", "not-a-scene"), /未知场景/u);
  await assert.rejects(run("--width", "NaN"), /--width/u);
});
