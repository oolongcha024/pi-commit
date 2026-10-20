import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMessage, parseMessage, validateDraft } from "../src/message.js";

test("structured messages round-trip with generated emoji, body and breaking footer", () => {
  const draft = {
    type: "refactor",
    scope: "cli",
    description: "统一配置入口",
    body: "- 保留模型选择\n- 迁移原有配置",
    breakingChange: "旧的配置格式不再支持\n请迁移配置文件",
  };
  const message = formatMessage(draft, true);
  assert.equal(
    message,
    "♻️ refactor(cli)!: 统一配置入口\n\n- 保留模型选择\n- 迁移原有配置\n\nBREAKING CHANGE: 旧的配置格式不再支持\n请迁移配置文件",
  );
  assert.deepEqual(parseMessage(message), { accepted: true, draft });
  assert.deepEqual(parseMessage(`${message.replace(/\n/g, "\r\n")}\r\n`), {
    accepted: true,
    draft,
  });
});

test("editor emoji is discarded and regenerated from type and setting", () => {
  const result = parseMessage("🐛 docs: explain configuration");
  assert.ok(result.accepted);
  assert.equal(
    formatMessage(result.draft, true),
    "📝 docs: explain configuration",
  );
  assert.equal(
    formatMessage(result.draft, false),
    "docs: explain configuration",
  );
});

test("reject invalid fields without imposing language or length rules", () => {
  for (const input of [
    { type: "unknown", description: "change" },
    { type: "fix", description: "" },
    { type: "fix", description: "a\nb" },
    { type: "fix", description: "fix", scope: "(cli)" },
    { type: "fix", description: "fix", scope: "" },
    { type: "fix", description: "fix", body: "\u001b[31mred" },
    { type: "fix", description: "🐛 fix" },
    { type: "fix", description: "fix", emoji: "🐛" },
    { type: "fix", description: "fix", breakingChange: "BREAKING CHANGE: old" },
  ])
    assert.equal(validateDraft(input).accepted, false, JSON.stringify(input));
  assert.equal(
    validateDraft({ type: "fix", description: "a".repeat(200) }).accepted,
    true,
  );
  assert.equal(
    validateDraft({ type: "fix", description: "修复 HTTP parser" }).accepted,
    true,
  );
});

test("manual messages require structural separators and matching breaking markers", () => {
  for (const text of [
    "fix: update\nbody",
    "fix!: update",
    "fix: update\n\nBREAKING CHANGE: removed API",
    "fix!: update\n\nBREAKING CHANGE: ",
    "fix(): update",
    "fix: update\u0000",
    "fix: update\t",
    "fix: update\r",
  ])
    assert.equal(parseMessage(text).accepted, false, text);
});
