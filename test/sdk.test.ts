import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createCommitAgent, createModelRuntime } from "../src/agent.js";

test("real pi SDK: bash, validation retry, two memory-only turns and isolated resources", {
  timeout: 30000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-commit-sdk-"));
  const agentDir = join(directory, "agent");
  const cwd = join(directory, "repo");
  await mkdir(agentDir);
  await mkdir(cwd);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = promisify(execFile);
  await git("git", ["-C", cwd, "init", "-q"]);
  await writeFile(join(cwd, "example.txt"), "example\n");
  await git("git", ["-C", cwd, "add", "example.txt"]);
  await writeFile(join(cwd, "AGENTS.md"), "UNTRACKED_CONTEXT_MUST_NOT_LOAD");
  await writeFile(
    join(agentDir, "APPEND_SYSTEM.md"),
    "USER_PROMPT_MUST_NOT_LOAD",
  );
  await mkdir(join(agentDir, "extensions"));
  await writeFile(
    join(agentDir, "extensions", "hostile.ts"),
    "throw new Error('EXTENSION_MUST_NOT_LOAD');",
  );
  const requests: Record<string, unknown>[] = [];
  const responses = [
    { name: "bash", arguments: { command: "git diff --cached --stat" } },
    {
      name: "write_commit_message",
      arguments: { type: "wrong", description: "add example" },
    },
    {
      name: "write_commit_message",
      arguments: { type: "feat", description: "add example" },
    },
    "",
    {
      name: "write_commit_message",
      arguments: { type: "feat", description: "添加示例" },
    },
    "",
  ];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const next = responses.shift();
    if (next === undefined) {
      response.writeHead(500).end("Unexpected request");
      return;
    }
    const tool = typeof next !== "string";
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta: unknown, finish_reason: string | null = null) => {
      response.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    };
    send({ role: "assistant" });
    send(
      tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${requests.length}`,
                type: "function",
                function: {
                  name: next.name,
                  arguments: JSON.stringify(next.arguments),
                },
              },
            ],
          }
        : { content: next },
    );
    send({}, tool ? "tool_calls" : "stop");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "test-provider": {
          api: "openai-completions",
          apiKey: "local-test-key",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [{ id: "test-model", contextWindow: 32768, maxTokens: 1024 }],
        },
      },
    }),
  );
  const runtime = await createModelRuntime(agentDir);
  const agent = await createCommitAgent({
    cwd,
    agentDir,
    runtime,
    modelId: "test-provider/test-model",
    language: "en",
    emoji: true,
  });
  t.after(() => agent.dispose());
  assert.deepEqual(agent.session.getActiveToolNames().sort(), [
    "bash",
    "write_commit_message",
  ]);
  assert.doesNotMatch(
    agent.session.systemPrompt,
    /UNTRACKED_CONTEXT_MUST_NOT_LOAD|USER_PROMPT_MUST_NOT_LOAD/,
  );
  const first = await agent.run("Generate the message.");
  assert.deepEqual(first.draft, { type: "feat", description: "add example" });
  assert.deepEqual(first.errors, []);
  assert.match(JSON.stringify(requests[2]), /choose one of/);
  const second = await agent.run("改成中文");
  assert.deepEqual(second.draft, { type: "feat", description: "添加示例" });
  assert.match(JSON.stringify(requests[4]), /Generate the message/);
  assert.match(JSON.stringify(requests[4]), /改成中文/);
  assert.equal(responses.length, 0);
  assert.equal((await readdir(agentDir)).includes("sessions"), false);
  assert.equal((await readdir(agentDir)).includes("settings.json"), false);

  await assert.rejects(
    createCommitAgent({
      cwd,
      agentDir,
      runtime,
      modelId: "unknown/model",
      language: "en",
      emoji: false,
    }),
    /找不到模型/,
  );
});
