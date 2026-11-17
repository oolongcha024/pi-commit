import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";

export interface TerminalHeader {
  model: string;
  language: "zh" | "en";
  emoji: boolean;
  noSign?: boolean;
  summary: {
    branch: string;
    files: number;
    additions: number;
    deletions: number;
  };
}

export interface TerminalAction {
  key: string;
  label: string;
  primary?: boolean;
}

export interface Terminal {
  show(text: string, tone?: NoticeTone): void;
  header(info: TerminalHeader): void;
  draft(message: string): void;
  divider(): void;
  status(message: string): () => void;
  section(edge: "start" | "end"): void;
  withExternalCommand<T>(
    operation: () => Promise<T>,
    section?: "git",
  ): Promise<T>;
  ask(prompt: string, actions?: TerminalAction[]): Promise<string>;
  edit(message: string): Promise<string | undefined>;
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
// Powerline branch glyph, included in Nerd Fonts.
const branchIcon = "\ue0a0";

/** Terminal-only presentation; commit message text stays owned by message.ts. */
export class TerminalRenderer {
  readonly width: number;

  constructor(
    private options: { columns: number; color: boolean; unicode: boolean },
  ) {
    this.width = Math.max(1, options.columns);
  }

  paint(text: string, tone: Tone): string {
    return this.options.color ? `\u001b[${codes[tone]}m${text}\u001b[0m` : text;
  }

  fit(text: string, width = this.width): string {
    const clean = stripVTControlCharacters(text).split("\n")[0] ?? "";
    if (stringWidth(clean) <= width) return clean;
    let result = "";
    let used = 0;
    for (const { segment } of segments.segment(clean)) {
      const size = stringWidth(segment);
      if (used + size > width - 1) break;
      result += segment;
      used += size;
    }
    return result + (this.options.unicode ? "…" : ".");
  }

  private lines(text: string, columns = this.width): string[] {
    const result: string[] = [];
    for (const line of stripVTControlCharacters(text).split("\n")) {
      let current = "";
      let width = 0;
      for (const { segment } of segments.segment(line)) {
        const size = stringWidth(segment);
        if (current && width + size > columns) {
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
      return this.paint(dash.repeat(this.width), "cyan");
    }
    return this.paint(
      `${dash.repeat(2)} ${label} ${dash.repeat(this.width - stringWidth(label) - 4)}`,
      "cyan",
    );
  }

  header(info: TerminalHeader): string {
    const branch = this.options.unicode ? `${branchIcon} ` : "";
    const title = this.fit(`pi-commit / ${branch}${info.summary.branch}`);
    const { files, additions, deletions } = info.summary;
    const metadata = `${files} staged  +${additions} −${deletions} · ${info.model} · ${info.language === "zh" ? "中文" : "English"}${info.emoji ? " · emoji" : ""}${info.noSign ? " · 不签名" : ""}`;
    return [
      `${this.paint(title.slice(0, 9), "bold")}${title.slice(9)}`,
      ...this.lines(metadata).map((line) =>
        line
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
          .join(""),
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
    // Presentation never adds whitespace to the message itself.
    return [title, ...body, "", ""].join("\n");
  }

  divider(): string {
    const dash = this.options.unicode ? "─" : "-";
    return `\n${this.paint(dash.repeat(this.width), "dim")}\n\n`;
  }

  actions(actions: TerminalAction[]): string {
    const rows: string[] = [];
    let row = "";
    let width = 0;
    for (const action of actions) {
      const prefix = this.options.unicode && action.key === "y" ? "✓ " : "";
      const label = `${prefix}${action.key} ${action.label}`;
      const size = stringWidth(label);
      if (row && width + 2 + size > this.width) {
        rows.push(row);
        row = "";
        width = 0;
      }
      const gap = row ? "  " : "";
      row +=
        gap +
        this.paint(prefix, action.primary ? "green" : "dim") +
        this.paint(action.key, action.primary ? "green" : "bold") +
        this.paint(` ${action.label}`, "dim");
      width += gap.length + size;
    }
    if (row) rows.push(row);
    return rows.join("\n");
  }

  status(message: string, elapsedMs = 0): string {
    const frames = this.options.unicode
      ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
      : ["|", "/", "-", "\\"];
    const frame = frames[Math.floor(elapsedMs / 90) % frames.length];
    const text = this.fit(
      `${frame} ${message} ${Math.floor(elapsedMs / 1000)}s`,
    );
    return text
      .split(/( \d+s)$/u)
      .map((part, index) => this.paint(part, index === 1 ? "dim" : "cyan"))
      .join("");
  }

  prompt(): string {
    return `${this.paint(this.options.unicode ? "›" : ">", "cyan")} `;
  }

  placeholder(hint: string): string {
    return this.paint(this.fit(hint, Math.max(1, this.width - 2)), "dim");
  }

  section(edge: "start" | "end"): string {
    return `\n${this.rule(edge === "start" ? "git" : "")}\n`;
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
          ? "-"
          : tone === "error"
            ? "x"
            : "!";
    return this.lines(text, Math.max(1, this.width - (tone ? 2 : 0)))
      .map((line, index) => {
        const prefix =
          tone && index === 0
            ? `${this.paint(icon, color)} `
            : tone
              ? "  "
              : "";
        return `${prefix}${tone && index === 0 ? this.paint(line, color) : line}`;
      })
      .join("\n");
  }
}
