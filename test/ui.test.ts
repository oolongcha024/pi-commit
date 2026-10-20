import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { TerminalRenderer } from "../src/ui.js";

test("draft rules touch the message while its internal spacing and content stay intact", () => {
  const view = new TerminalRenderer({
    columns: 80,
    color: true,
    unicode: true,
  });
  const message =
    "🐛 fix(auth): 修复重连后的登录状态丢失\n\n- 重连成功后恢复会话状态\n- 补充状态恢复的回归测试";
  const lines = stripVTControlCharacters(view.draft(message)).split("\n");
  assert.match(lines[1] ?? "", /提交消息/);
  assert.equal(lines[2], `  ${message.split("\n")[0]}`);
  assert.equal(lines.at(-3), "  - 补充状态恢复的回归测试");
  assert.match(lines.at(-2) ?? "", /^ {2}─+$/u);
  assert.equal(
    lines
      .slice(2, -2)
      .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
      .join("\n"),
    message,
  );
});

test("narrow headers, dividers and actions fit terminal cell width with CJK and emoji", () => {
  const view = new TerminalRenderer({
    columns: 32,
    color: true,
    unicode: true,
  });
  const output =
    view.header({
      model: "modelsight/DeepSeek-V4.1-Flash",
      language: "zh",
      emoji: true,
      summary: { branch: "测试分支", files: 3, additions: 42, deletions: 18 },
    }) +
    view.actions([
      { key: "y", label: "使用旧稿提交", primary: true },
      { key: "e", label: "编辑" },
      { key: "r", label: "重新生成" },
      { key: "q", label: "退出" },
    ]);
  for (const line of output.split("\n"))
    assert.ok(stringWidth(line) <= 32, line);
  assert.ok(stringWidth(view.rule("提交消息")) <= 28);
  assert.ok(
    stringWidth(view.fit("👨‍👩‍👧‍👦 测试一个非常非常长的终端状态消息")) <= 28,
  );
  assert.doesNotMatch(
    view.fit("👨‍👩‍👧‍👦 测试一个非常非常长的终端状态消息"),
    /\uFFFD/u,
  );
});

test("plain output omits ANSI styling and retains real message content", () => {
  const view = new TerminalRenderer({
    columns: 60,
    color: false,
    unicode: false,
  });
  const text =
    view.draft("fix: handle reconnect") +
    view.notice("提交完成。", "success") +
    view.actions([{ key: "y", label: "提交" }]);
  assert.equal(stripVTControlCharacters(text), text);
  assert.match(text, /fix: handle reconnect/);
  assert.match(text, /---/);
  assert.match(text, /提交完成/);
});
