import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { AgentClient } from "../src/agent-client.js";

test("real SDK initialization keeps the UI heartbeat running", {
  timeout: 15000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-heartbeat-"));
  const client = new AgentClient();
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  let ticks = 0;
  let last = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 50);
  try {
    await client.initialize(directory);
    // Include a delayed timer even if initialization monopolized the main thread.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(ticks >= 2, `Only ${ticks} UI frames during initialization`);
    assert.ok(maxGap < 500, `UI heartbeat blocked for ${Math.round(maxGap)}ms`);
  } finally {
    clearInterval(timer);
  }
  await assert.rejects(
    client.createAgent({
      cwd: directory,
      modelId: "missing/model",
      language: "en",
      emoji: false,
    }),
    /找不到模型/u,
  );
});

test("cancellation during worker startup rejects promptly and closes the worker", {
  timeout: 5000,
}, async () => {
  const controller = new AbortController();
  const worker = new Worker(
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000)",
    { eval: true },
  );
  const client = new AgentClient(controller.signal, worker);
  await new Promise<void>((resolve) => worker.once("online", resolve));
  const pending = client.initialize();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const start = performance.now();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(performance.now() - start < 500);
  await client.close();
  await client.close();
  await assert.rejects(client.models(), { name: "AbortError" });
});

test("worker startup failure rejects all pending requests and permits cleanup", async () => {
  const client = new AgentClient(
    undefined,
    new Worker('throw new Error("fixture startup failure")', { eval: true }),
  );
  try {
    await Promise.all([
      assert.rejects(client.initialize(), /fixture startup failure/u),
      assert.rejects(client.models(), /fixture startup failure/u),
    ]);
  } finally {
    await client.close();
  }
});

test("unexpected worker exit rejects a pending request", async () => {
  const client = new AgentClient(
    undefined,
    new Worker("process.exit(17)", { eval: true }),
  );
  try {
    await assert.rejects(client.initialize(), /模型工作线程已退出（17）/u);
  } finally {
    await client.close();
  }
});
