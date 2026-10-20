import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const available =
  process.platform !== "win32" &&
  !spawnSync("python3", ["--version"]).error &&
  !spawnSync("ssh-keygen", ["-?"]).error;
const runner = fileURLToPath(
  new URL("./fixtures/signing-pty.py", import.meta.url),
);
const fixture = fileURLToPath(
  new URL("./fixtures/signing-cli.ts", import.meta.url),
);

async function signingCase(
  t: TestContext,
  scenario: "success" | "retry" | "cancel",
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-commit-signing-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scratch = join(directory, "scratch");
  await mkdir(scratch);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    SSH_AUTH_SOCK: "",
    SSH_ASKPASS_REQUIRE: "never",
    DISPLAY: "",
    TMPDIR: scratch,
  };
  const git = async (...args: string[]) =>
    exec("git", ["-C", directory, ...args], { env });
  await git("init", "-q");
  const key = join(directory, "disposable-key");
  // Public fixture credential for a disposable key; never use a user's keys/agent.
  const password = "pi-commit-disposable-test-passphrase";
  await exec(
    "ssh-keygen",
    [
      "-q",
      "-t",
      "ed25519",
      "-a",
      "1",
      "-N",
      password,
      "-f",
      key,
      "-C",
      "probe@example.invalid",
    ],
    { env },
  );
  for (const [name, value] of Object.entries({
    "user.name": "Test",
    "user.email": "probe@example.invalid",
    "gpg.format": "ssh",
    "gpg.ssh.program": "ssh-keygen",
    "user.signingkey": key,
    "commit.gpgsign": "true",
    "core.hooksPath": ".git/hooks",
  }))
    await git("config", name, value);
  await writeFile(join(directory, "file.txt"), "staged signing fixture\n");
  await git("add", "file.txt");
  const editor = join(directory, "editor.mjs");
  await writeFile(
    editor,
    "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], 'fix: revise signed draft\\n');\n",
  );
  const { stdout } = await exec("python3", [runner], {
    env: {
      ...env,
      SIGNING_TEST_COMMAND: JSON.stringify([
        process.execPath,
        "--import",
        import.meta.resolve("tsx"),
        fixture,
        directory,
      ]),
      SIGNING_TEST_SCENARIO: scenario,
      SIGNING_TEST_PASSWORD: password,
      EDITOR: `"${process.execPath}" "${editor}"`,
      VISUAL: "",
    },
    timeout: 12000,
    killSignal: "SIGKILL",
  });
  const observed = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(
    observed.password_prompt_seen,
    true,
    "Real SSH signer must ask for its passphrase",
  );
  assert.equal(
    observed.password_echoed,
    false,
    "Signing input must not be echoed by readline",
  );
  assert.equal(
    observed.exit_code,
    scenario === "cancel" ? 130 : 0,
    "Signing must finish without hanging",
  );
  assert.equal(
    observed.raw_restored,
    true,
    "Return terminal control to the CLI before closing it",
  );
  assert.equal(
    await readFile(join(directory, "terminal-closed"), "utf8"),
    "true",
  );
  assert.deepEqual(
    (await readdir(scratch)).filter((name) => name.startsWith("pi-commit-")),
    [],
    "Temporary message/editor files must be removed",
  );
  if (scenario === "cancel") {
    assert.equal(observed.cancelled, true);
    assert.equal(observed.committed, false);
    await assert.rejects(git("rev-parse", "--verify", "HEAD"));
  } else {
    assert.equal(observed.committed, true);
    const allowed = join(directory, "allowed-signers");
    await writeFile(
      allowed,
      `probe@example.invalid ${await readFile(`${key}.pub`, "utf8")}`,
    );
    await git("config", "gpg.ssh.allowedSignersFile", allowed);
    await git("verify-commit", "HEAD");
    const { stdout: message } = await git("log", "-1", "--format=%B");
    assert.equal(
      message.trim(),
      scenario === "retry"
        ? "fix: revise signed draft"
        : "fix: restore session state",
    );
    if (scenario === "retry") assert.equal(observed.retried_after_edit, true);
  }
}

test(
  "SSH signing: password stays hidden and commit verifies",
  { skip: !available, timeout: 20000 },
  async (t) => signingCase(t, "success"),
);
test(
  "SSH signing: wrong password preserves draft for editing and retry",
  { skip: !available, timeout: 20000 },
  async (t) => signingCase(t, "retry"),
);
test(
  "SSH signing: Ctrl+C cancels without committing and restores terminal",
  { skip: !available, timeout: 20000 },
  async (t) => signingCase(t, "cancel"),
);
