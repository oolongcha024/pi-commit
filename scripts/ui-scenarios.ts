import type { Terminal, TerminalHeader } from "../src/ui.js";
import { createCommitUI, type PromptState } from "../src/ui-content.js";

const header: TerminalHeader = {
  model: "example/demo-model",
  language: "zh",
  emoji: true,
  summary: {
    branch: "feat/session-recovery",
    files: 3,
    additions: 42,
    deletions: 18,
  },
};
const draft =
  "🐛 fix(auth): 修复重连后的登录状态丢失\n\n- 重连成功后恢复会话状态\n- 补充状态恢复的回归测试";
const feedback = "> 标题再具体一点，突出断线重连";
const revisedDraft =
  "🐛 fix(auth): 修复断线重连后的登录状态丢失\n\n- 重连成功后恢复会话状态\n- 补充状态恢复的回归测试";

type PreviewTerminal = Pick<
  Terminal,
  "header" | "draft" | "divider" | "show" | "status" | "section"
>;
export interface Scenario {
  id: string;
  label: string;
  show(terminal: PreviewTerminal): undefined | (() => void);
  prompt?: PromptState;
}

function scene(
  id: string,
  label: string,
  show: (
    terminal: PreviewTerminal,
    ui: ReturnType<typeof createCommitUI>,
  ) => undefined | (() => void),
  prompt?: PromptState,
): Scenario {
  return {
    id,
    label,
    prompt,
    show(terminal) {
      const ui = createCommitUI({
        ...terminal,
        async ask() {
          throw new Error("Scenarios only describe presentation.");
        },
      });
      return show(terminal, ui);
    },
  };
}

export const scenarios: Scenario[] = [
  scene("loading", "初始化模型", (_t, ui) => ui.status("loading")),
  scene(
    "model",
    "首次选择模型",
    (t, ui) => {
      ui.notice("selectModel");
      t.show("1. example/demo-model\n2. example/another-model");
    },
    { kind: "model" },
  ),
  scene("generating", "首次生成", (t, ui) => {
    t.header(header);
    return ui.status("generating");
  }),
  scene(
    "draft",
    "草稿待确认",
    (t) => {
      t.header(header);
      t.draft(draft);
    },
    { kind: "draft" },
  ),
  scene("revising", "根据反馈改稿", (t, ui) => {
    t.header(header);
    t.draft(draft);
    t.show(feedback);
    t.divider();
    return ui.status("revising");
  }),
  scene(
    "revised",
    "改稿完成待确认",
    (t) => {
      t.header(header);
      t.draft(draft);
      t.show(feedback);
      t.divider();
      t.draft(revisedDraft);
    },
    { kind: "draft" },
  ),
  scene(
    "request-error",
    "首次请求失败",
    (t) => {
      t.header(header);
      t.show("连接超时，请稍后重试。", "error");
    },
    { kind: "retry" },
  ),
  scene(
    "revision-error",
    "改稿失败，保留旧稿",
    (t, ui) => {
      t.header(header);
      t.show("连接超时，请稍后重试。", "error");
      ui.notice("draftRetained");
      t.draft(draft);
    },
    { kind: "draft", requestFailed: true },
  ),
  scene(
    "invalid-edit",
    "手动编辑格式错误",
    (t) => {
      t.header(header);
      t.draft(draft);
      t.show("提交标题必须符合 Conventional Commit 格式。", "warning");
    },
    { kind: "edit" },
  ),
  scene(
    "missing-editor",
    "未配置编辑器",
    (t, ui) => {
      t.header(header);
      ui.notice("missingEditor");
      t.draft(draft);
    },
    { kind: "draft" },
  ),
  scene(
    "editor-error",
    "编辑器退出失败",
    (t, ui) => {
      t.header(header);
      ui.notice("editorFailed");
      t.draft(draft);
    },
    { kind: "draft" },
  ),
  scene("committing", "提交与 hooks 执行中", (t) => {
    t.header(header);
    t.draft(draft);
    t.section("start");
    t.show("Running pre-commit checks...\n✔ lint passed\nRunning tests...");
  }),
  scene(
    "commit-error",
    "提交失败待重试",
    (t, ui) => {
      t.header(header);
      t.section("start");
      t.show(
        "Running pre-commit checks...\n✖ lint failed\npre-commit hook exited with code 1",
      );
      t.section("end");
      ui.notice("commitFailed");
      t.draft(draft);
    },
    { kind: "draft", commitFailed: true },
  ),
  scene(
    "changed",
    "暂存区或 HEAD 变化",
    (t, ui) => {
      t.header(header);
      t.draft(draft);
      t.section("start");
      t.section("end");
      ui.notice("changed");
    },
    { kind: "changed" },
  ),
  scene("success", "提交成功", (t, ui) => {
    t.header(header);
    t.draft(draft);
    t.section("start");
    t.show(
      "Running pre-commit checks...\n✔ lint passed\n✔ tests passed\n[main a1b2c3d] fix(auth): 修复重连后的登录状态丢失\n 3 files changed, 42 insertions(+), 18 deletions(-)",
    );
    t.section("end");
    ui.notice("committed");
  }),
  scene("no-draft", "模型未交付有效草稿", (t, ui) => {
    t.header(header);
    ui.notice("noDraft");
    t.show("仓库要求的提交标题格式与 Conventional Commits 不兼容。");
  }),
  scene("empty", "没有暂存变更", (_t, ui) => {
    ui.notice("empty");
  }),
  scene("cancelled", "取消操作", (_t, ui) => {
    ui.notice("cancelled");
  }),
  scene("exited", "退出且未提交", (_t, ui) => {
    ui.notice("exited");
  }),
  scene(
    "english",
    "英文、无 emoji、不签名",
    (t) => {
      t.header({ ...header, language: "en", emoji: false, noSign: true });
      t.draft(
        "fix(auth): restore session after reconnect\n\n- Restore the previous session\n- Cover reconnect recovery",
      );
    },
    { kind: "draft" },
  ),
  scene(
    "long",
    "长分支、长消息、中英混排",
    (t) => {
      t.header({
        ...header,
        summary: {
          ...header.summary,
          branch: "feat/非常长的分支名称-session-recovery-and-reconnection",
        },
      });
      t.draft(
        "✨ feat(session): 支持断线重连后恢复用户会话并同步工作区状态\n\n- Restore session metadata，保留用户之前选择的工作区与尚未保存的偏好设置\n\nBREAKING CHANGE: 会话恢复配置由 reconnect 迁移到 session.recovery",
      );
    },
    { kind: "draft" },
  ),
];
