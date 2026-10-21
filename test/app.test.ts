import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommitAgent, TurnResult } from "../src/agent.js";
import { type LoopOptions, runCommitLoop } from "../src/app.js";
import type { GitSnapshot } from "../src/git.js";
import type { Terminal } from "../src/ui.js";

function fixture(
  turns: (TurnResult | Error)[],
  inputs: string[],
  edits: string[] = [],
) {
  const output: string[] = [];
  const requests: string[] = [];
  const commits: string[] = [];
  const signingOverrides: (boolean | undefined)[] = [];
  const statuses: ("committed" | "changed" | "failed")[] = [];
  const agent: CommitAgent = {
    async run(input) {
      requests.push(input);
      const result = turns.shift();
      if (!result) throw new Error("Unexpected agent invocation");
      if (result instanceof Error) throw result;
      return result;
    },
    dispose() {},
  };
  const terminal: Terminal = {
    show: (text) => output.push(text),
    header() {},
    draft: (text) => {
      output.push(text);
    },
    status: () => () => {},
    withExternalCommand: async (operation) => operation(),
    async ask() {
      const input = inputs.shift();
      assert.notEqual(input, undefined, "Unexpected user prompt");
      return input ?? "q";
    },
    async edit() {
      return edits.shift();
    },
  };
  let tree = 0;
  const snapshots: GitSnapshot[] = [];
  const options: LoopOptions = {
    agent,
    terminal,
    emoji: true,
    context: "restore state",
    model: "test/model",
    language: "zh",
    git: {
      root: "/repo",
      summary: async () => ({
        branch: "main",
        files: 1,
        additions: 2,
        deletions: 0,
      }),
      hasStagedChanges: async () => true,
      snapshot: async () => {
        const result = { head: "head", tree: String(tree++) };
        snapshots.push(result);
        return result;
      },
      async commit(message, _snapshot, noSign) {
        commits.push(message);
        signingOverrides.push(noSign);
        return statuses.shift() ?? "committed";
      },
    },
  };
  return {
    options,
    output,
    requests,
    commits,
    statuses,
    snapshots,
    signingOverrides,
  };
}

const draft = { type: "fix", description: "restore state" };
const accepted = { draft, finalText: "THIS MUST NOT BE COMMITTED", errors: [] };

test("manual edit becomes feedback context; only the accepted formatted draft is committed", async () => {
  const f = fixture(
    [
      accepted,
      { ...accepted, draft: { type: "docs", description: "explain recovery" } },
    ],
    ["e", "改成文档", "y"],
    ["🐛 docs(cli): explain state"],
  );
  assert.equal(await runCommitLoop(f.options), 0);
  assert.match(f.requests[1] ?? "", /explain state/);
  assert.deepEqual(f.commits, ["📝 docs: explain recovery"]);
});

test("turn with no accepted draft prints explanation and exits even after an earlier draft", async () => {
  const f = fixture(
    [accepted, { finalText: "仓库格式不兼容", errors: ["invalid type"] }],
    ["调整"],
  );
  assert.equal(await runCommitLoop(f.options), 1);
  assert.ok(f.output.includes("仓库格式不兼容"));
  assert.ok(f.output.includes("invalid type"));
  assert.deepEqual(f.commits, []);
});

test("request failure preserves previous draft and allows explicit acceptance", async () => {
  const f = fixture([accepted, new Error("network failure")], ["shorter", "y"]);
  assert.equal(await runCommitLoop(f.options), 0);
  assert.deepEqual(f.commits, ["🐛 fix: restore state"]);
});

test("changed Git state requires regeneration and a new acceptance", async () => {
  const f = fixture(
    [
      accepted,
      { ...accepted, draft: { type: "feat", description: "add recovery" } },
    ],
    ["y", "r", "y"],
  );
  f.statuses.push("changed", "committed");
  assert.equal(await runCommitLoop(f.options), 0);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.commits, [
    "🐛 fix: restore state",
    "✨ feat: add recovery",
  ]);
  assert.equal(f.snapshots.length, 2);
});

test("failed hook preserves draft; quitting never retries the commit", async () => {
  const f = fixture([accepted], ["y", "q"]);
  f.statuses.push("failed");
  assert.equal(await runCommitLoop(f.options), 0);
  assert.equal(f.commits.length, 1);
});

test("invalid manual edit cannot be submitted and can be corrected", async () => {
  const f = fixture(
    [accepted],
    ["e", "e", "y"],
    ["not a subject", "docs: explain recovery"],
  );
  assert.equal(await runCommitLoop(f.options), 0);
  assert.deepEqual(f.commits, ["📝 docs: explain recovery"]);
});

test("cancellation after model response never commits", async () => {
  const f = fixture([accepted], []);
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.agent.run = async () => {
    controller.abort();
    return accepted;
  };
  await assert.rejects(runCommitLoop(f.options), { name: "AbortError" });
  assert.deepEqual(f.commits, []);
});

test("r regenerates a draft and never submits it without y", async () => {
  const f = fixture([accepted, accepted], ["r", "q"]);
  assert.equal(await runCommitLoop(f.options), 0);
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1] ?? "", /Generate a fresh draft/);
  assert.deepEqual(f.commits, []);
});

test("r retries the failed feedback instead of sending a literal r", async () => {
  const f = fixture(
    [accepted, new Error("timeout"), accepted],
    ["shorter", "r", "q"],
  );
  assert.equal(await runCommitLoop(f.options), 0);
  assert.match(f.requests[2] ?? "", /shorter/);
  assert.deepEqual(f.commits, []);
});

test("empty input neither submits nor redraws the draft", async () => {
  const f = fixture([accepted], ["", "q"]);
  let displays = 0;
  f.options.terminal.draft = () => {
    displays++;
  };
  assert.equal(await runCommitLoop(f.options), 0);
  assert.equal(displays, 1);
  assert.deepEqual(f.commits, []);
});

test("cancellation during Git stops the loop instead of asking to retry", async () => {
  const f = fixture([accepted], ["y"]);
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.git.commit = async () => {
    controller.abort();
    return "failed";
  };
  await assert.rejects(runCommitLoop(f.options), { name: "AbortError" });
  assert.ok(!f.output.includes("提交完成。"));
});

test("no-sign reaches Git on the initial attempt and on retries", async () => {
  const f = fixture([accepted], ["y", "y"]);
  f.options.noSign = true;
  f.statuses.push("failed", "committed");
  assert.equal(await runCommitLoop(f.options), 0);
  assert.deepEqual(f.signingOverrides, [true, true]);
});
