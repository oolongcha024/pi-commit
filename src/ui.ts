import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import type { GitSummary } from "./git.js";

export interface TerminalHeader {
  model: string;
  language: "zh" | "en";
  emoji: boolean;
  noSign?: boolean;
  summary: GitSummary;
}

export interface TerminalAction {
  key: string;
  label: string;
  primary?: boolean;
}

type Tone = "dim" | "bold" | "cyan" | "green" | "yellow" | "red";
export type NoticeTone = "info" | "success" | "warning" | "error";
const codes: Record<Tone, number> = {
  dim: 2,
  bold: 1,
  cyan: 36,
  green: 32,
  yellow: 33,
  red: 31,
};
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Terminal-only presentation; commit message text stays owned by message.ts. */
export class TerminalRenderer {
  readonly width: number;

  constructor(
    private options: { columns: number; color: boolean; unicode: boolean },
  ) {
    this.width = Math.max(1, Math.min(96, options.columns - 4));
  }

  paint(text: string, tone: Tone): string {
    return this.options.color ? `\u001b[${codes[tone]}m${text}\u001b[0m` : text;
  }

  fit(text: string): string {
    const clean = stripVTControlCharacters(text).split("\n")[0] ?? "";
    if (stringWidth(clean) <= this.width) return clean;
    let result = "";
    let width = 0;
    for (const { segment } of segments.segment(clean)) {
      const size = stringWidth(segment);
      if (width + size > this.width - 1) break;
      result += segment;
      width += size;
    }
    return result + (this.options.unicode ? "…" : ".");
  }

  private lines(text: string): string[] {
    const result: string[] = [];
    for (const line of stripVTControlCharacters(text).split("\n")) {
      let current = "";
      let width = 0;
      for (const { segment } of segments.segment(line)) {
        const size = stringWidth(segment);
        if (current && width + size > this.width) {
          result.push(current);
          current = "";
          width = 0;
        }
        current += segment;
        width += size;
      }
      result.push(current);
    }
    return result;
  }

  rule(label = ""): string {
    const dash = this.options.unicode ? "─" : "-";
    if (!label || stringWidth(label) + 6 > this.width) {
      return this.paint(dash.repeat(this.width), "dim");
    }
    return this.paint(
      `${dash.repeat(2)} ${label} ${dash.repeat(this.width - stringWidth(label) - 4)}`,
      "dim",
    );
  }

  header(info: TerminalHeader): string {
    const brand = `${this.paint(this.options.unicode ? "›_" : ">_", "cyan")} ${this.paint("pi-commit", "bold")}`;
    const branch = stripVTControlCharacters(info.summary.branch);
    const branchLabel = `${this.options.unicode ? "⑂" : "@"} ${branch}`;
    const gap =
      this.width -
      stringWidth(stripVTControlCharacters(brand)) -
      stringWidth(branchLabel);
    const title =
      gap >= 3
        ? `${brand}${" ".repeat(gap)}${this.paint(branchLabel, "dim")}`
        : brand;
    const metadata = `${info.model} · ${info.language === "zh" ? "中文" : "English"} · ${info.emoji ? "Emoji" : "无 emoji"}${info.noSign ? " · 不签名" : ""}`;
    const { files, additions, deletions } = info.summary;
    const stats = `${files} 个暂存文件 · +${additions} −${deletions}`;
    return [
      "",
      `  ${title}`,
      "",
      ...this.lines(metadata).map((line) => `  ${this.paint(line, "dim")}`),
      ...this.lines(stats).map(
        (line) =>
          `  ${line
            .split(/([+−]\d+)/u)
            .map((part) =>
              this.paint(
                part,
                part.startsWith("+")
                  ? "green"
                  : part.startsWith("−")
                    ? "red"
                    : "dim",
              ),
            )
            .join("")}`,
      ),
      "",
    ].join("\n");
  }

  draft(message: string): string {
    const [subject = "", ...body] = message.split("\n");
    const separator = subject.indexOf(": ");
    const title =
      separator < 0
        ? this.paint(subject, "bold")
        : `${this.paint(subject.slice(0, separator + 1), "cyan")} ${this.paint(subject.slice(separator + 2), "bold")}`;
    // No blank line between either rule and the message; keep message-internal spacing.
    return [
      "",
      `  ${this.rule("提交消息")}`,
      `  ${title}`,
      ...body.map((line) => (line ? `  ${this.paint(line, "dim")}` : "")),
      `  ${this.rule()}`,
      "",
    ].join("\n");
  }

  actions(actions: TerminalAction[]): string {
    const rows: string[] = [];
    let row = "";
    let width = 0;
    for (const action of actions) {
      const label = `${action.key} ${action.label}`;
      const size = stringWidth(label);
      if (row && width + 4 + size > this.width) {
        rows.push(`  ${row}`);
        row = "";
        width = 0;
      }
      const gap = row ? "    " : "";
      row +=
        gap +
        this.paint(action.key, action.primary ? "green" : "bold") +
        this.paint(` ${action.label}`, action.primary ? "green" : "dim");
      width += gap.length + size;
    }
    if (row) rows.push(`  ${row}`);
    return ["", ...rows, ""].join("\n");
  }

  notice(text: string, tone?: NoticeTone): string {
    const color =
      tone === "success"
        ? "green"
        : tone === "warning"
          ? "yellow"
          : tone === "error"
            ? "red"
            : "cyan";
    const icon =
      tone === "success"
        ? this.options.unicode
          ? "✓"
          : "+"
        : tone === "info"
          ? this.options.unicode
            ? "·"
            : "-"
          : "!";
    return this.lines(text)
      .map((line, index) => {
        const prefix =
          tone && index === 0
            ? `${this.paint(icon, color)} `
            : tone
              ? "  "
              : "";
        return `  ${prefix}${tone && index === 0 ? this.paint(line, color) : line}`;
      })
      .join("\n");
  }
}
