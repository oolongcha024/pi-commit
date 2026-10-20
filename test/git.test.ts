import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitRepository } from "../src/git.js";

const exec = promisify(execFile);

test("no-sign overrides required signing for one commit without skipping hooks or changing config", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-commit-no-sign-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", directory, ...args])).stdout;
  await git("init", "-q");
  const signer = join(directory, "reject-signing");
  await writeFile(signer, "#!/bin/sh\ntouch signer-called\nexit 1\n");
  await chmod(signer, 0o700);
  for (const [name, value] of Object.entries({
    "user.email": "test@example.invalid",
    "user.name": "Test",
    "commit.gpgsign": "true",
    "gpg.format": "openpgp",
    "gpg.program": signer,
    "core.hooksPath": ".git/hooks",
  }))
    await git("config", name, value);
  const hook = join(directory, ".git/hooks/pre-commit");
  await writeFile(hook, "#!/bin/sh\ntouch hook-called\n");
  await chmod(hook, 0o700);
  await writeFile(join(directory, "file.txt"), "first\n");
  await git("add", "file.txt");
  const repository = await GitRepository.open(directory);
  const snapshot = await repository.snapshot();
  assert.equal(
    await repository.commit("fix: signed attempt", snapshot),
    "failed",
  );
  await access(join(directory, "signer-called"));
  await rm(join(directory, "signer-called"));
  await rm(join(directory, "hook-called"));

  assert.equal(
    await repository.commit("fix: unsigned attempt", snapshot, true),
    "committed",
  );
  await assert.rejects(access(join(directory, "signer-called")));
  await access(join(directory, "hook-called"));
  assert.doesNotMatch(await git("cat-file", "-p", "HEAD"), /^gpgsig /mu);
  assert.equal((await git("config", "--get", "commit.gpgsign")).trim(), "true");
  await writeFile(join(directory, "file.txt"), "second\n");
  await git("add", "file.txt");
  assert.equal(
    await repository.commit(
      "fix: signing still required",
      await repository.snapshot(),
    ),
    "failed",
  );
  await access(join(directory, "signer-called"));
});

test("Git snapshots protect staged content and HEAD; commit accepts literal text", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-commit-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", directory, ...args])).stdout;
  await git("init", "-q");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.hooksPath", ".git/hooks");
  const repository = await GitRepository.open(directory);
  assert.equal(await repository.hasStagedChanges(), false);
  await writeFile(join(directory, "file.txt"), "first\n");
  await git("add", "file.txt");
  assert.equal(await repository.hasStagedChanges(), true);
  assert.deepEqual(await repository.summary(), {
    branch: (await git("symbolic-ref", "--short", "HEAD")).trim(),
    files: 1,
    additions: 1,
    deletions: 0,
  });
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.head, "UNBORN");

  // Unstaged edits are outside the snapshot boundary and must survive a commit.
  await writeFile(join(directory, "file.txt"), "second\n");
  assert.equal(await repository.matches(snapshot), true);
  await git("add", "file.txt");
  assert.equal(await repository.commit("fix: stale", snapshot), "changed");
  const current = await repository.snapshot();
  const message =
    "fix: handle $HOME and `literal`\n\nNo shell expansion $(touch bad).";
  assert.equal(await repository.commit(message, current), "committed");
  assert.equal((await git("log", "-1", "--format=%B")).trimEnd(), message);
  assert.equal(await repository.matches(current), false);

  await writeFile(join(directory, "file.txt"), "third\n");
  await git("add", "file.txt");
  const hook = join(directory, ".git/hooks/commit-msg");
  await writeFile(hook, "#!/bin/sh\necho rejected-test-hook >&2\nexit 1\n");
  await chmod(hook, 0o755);
  const beforeHook = await repository.snapshot();
  assert.equal(await repository.commit("fix: third", beforeHook), "failed");
  assert.deepEqual(await repository.snapshot(), beforeHook);
  assert.equal(await readFile(join(directory, "file.txt"), "utf8"), "third\n");
});

test("staged summaries count renames once and handle binary files and unusual paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-commit-stats-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (...args: string[]) =>
    exec("git", ["-C", directory, ...args]);
  await git("init", "-q");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.hooksPath", ".git/hooks");
  await writeFile(join(directory, "before.txt"), "first\nsecond\n");
  await git("add", "before.txt");
  await git("commit", "-qm", "initial");
  await git("mv", "before.txt", "after\tname\n.txt");
  await writeFile(join(directory, "image.bin"), Buffer.from([0, 1, 2]));
  await git("add", "image.bin");
  const repository = await GitRepository.open(directory);
  const summary = await repository.summary();
  assert.equal(summary.files, 2);
  assert.equal(summary.additions, 0);
  assert.equal(summary.deletions, 0);
  await git("checkout", "--detach", "-q");
  assert.match((await repository.summary()).branch, /^[0-9a-f]{7,}$/u);
});
