import type { NoticeTone, TerminalAction } from "./ui.js";

/** Presentation states shared by the real flow and the offline UI preview. */
export const notices = {
  exited: { text: "已退出，未创建提交。", tone: "info" },
  empty: { text: "没有 staged 变更，已退出。" },
  noDraft: { text: "模型未交付有效草稿，已退出。" },
  requestFailed: { text: "模型请求失败。", tone: "error" },
  draftRetained: { text: "请求失败，上一版草稿已保留。", tone: "warning" },
  committing: { text: "正在检查并提交，运行 Git hooks…", tone: "info" },
  committed: { text: "提交完成。", tone: "success" },
  commitFailed: {
    text: "Git 提交失败，草稿已保留。请检查上方 Git 错误后重试。",
    tone: "warning",
  },
  changed: {
    text: "HEAD 或暂存内容已变化，当前消息尚未提交。",
    tone: "warning",
  },
  cancelled: { text: "已取消。", tone: "info" },
  selectModel: { text: "选择默认模型：" },
  invalidModel: { text: "请输入列表中的模型编号。" },
  missingEditor: {
    text: "请先配置 $VISUAL 或 $EDITOR（例如 export EDITOR='code --wait'）。",
    tone: "warning",
  },
  editorFailed: { text: "编辑器退出失败，保留上一版草稿。", tone: "warning" },
} satisfies Record<string, { text: string; tone?: NoticeTone }>;

export const statuses = {
  loading: "正在加载模型配置…",
  generating: "正在生成提交消息…",
  revising: "正在根据反馈修改…",
};

export type PromptState =
  | { kind: "draft"; requestFailed?: boolean; commitFailed?: boolean }
  | { kind: "retry" | "edit" | "changed" | "model" };

export function promptContent(state: PromptState): {
  hint: string;
  actions?: TerminalAction[];
} {
  switch (state.kind) {
    case "draft":
      return {
        hint: "输入修改意见，或选择操作",
        actions: [
          {
            key: "y",
            label: state.commitFailed
              ? "重试提交"
              : state.requestFailed
                ? "使用旧稿提交"
                : "提交",
            primary: true,
          },
          { key: "e", label: "编辑" },
          { key: "r", label: state.requestFailed ? "重试生成" : "重新生成" },
          { key: "q", label: "退出" },
        ],
      };
    case "retry":
    case "changed":
      return {
        hint: "选择下一步操作",
        actions: [
          {
            key: "r",
            label: state.kind === "retry" ? "重试" : "基于新状态重新生成",
            primary: true,
          },
          { key: "q", label: "退出" },
        ],
      };
    case "edit":
      return {
        hint: "修正消息格式后继续",
        actions: [
          { key: "e", label: "继续编辑", primary: true },
          { key: "q", label: "退出" },
        ],
      };
    case "model":
      return { hint: "输入模型编号，或 q 退出" };
  }
}

/** Owns copy and action presentation; callers only supply the current state. */
export function createCommitUI(
  terminal: Pick<import("./ui.js").Terminal, "show" | "ask" | "status">,
) {
  return {
    notice(name: keyof typeof notices) {
      const notice: { text: string; tone?: NoticeTone } = notices[name];
      terminal.show(notice.text, notice.tone);
    },
    status(name: keyof typeof statuses) {
      return terminal.status(statuses[name]);
    },
    ask(state: PromptState) {
      const { hint, actions } = promptContent(state);
      return terminal.ask(hint, actions);
    },
  };
}
