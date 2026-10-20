export const EMOJI = {
  feat: "✨",
  fix: "🐛",
  docs: "📝",
  style: "🎨",
  refactor: "♻️",
  perf: "⚡️",
  test: "✅",
  build: "👷",
  ci: "💚",
  chore: "🔧",
  revert: "⏪",
} as const;

export interface CommitDraft {
  type: string;
  description: string;
  scope?: string;
  body?: string;
  breakingChange?: string;
}

export type DraftResult =
  | { accepted: true; draft: CommitDraft }
  | { accepted: false; errors: string[] };

function hasControlCharacters(text: string, multiline: boolean): boolean {
  return [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (
      (code < 32 && !(multiline && code === 10)) ||
      (code >= 127 && code <= 159) ||
      code === 0x2028 ||
      code === 0x2029
    );
  });
}

export function validateDraft(input: unknown): DraftResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { accepted: false, errors: ["Expected a commit message object."] };
  }
  const value = input as Record<string, unknown>;
  const errors: string[] = [];
  const normalized: Record<string, string> = {};
  for (const key of [
    "type",
    "description",
    "scope",
    "body",
    "breakingChange",
  ]) {
    const field = value[key];
    if (field === undefined && key !== "type" && key !== "description")
      continue;
    if (typeof field !== "string") {
      errors.push(`${key}: expected a string.`);
      continue;
    }
    const multiline = key === "body" || key === "breakingChange";
    const text = field.replace(/\r\n/g, "\n");
    if (hasControlCharacters(text, multiline)) {
      errors.push(
        `${key}: contains a control character or an invalid line break.`,
      );
    }
    normalized[key] = text.trim();
    if (!normalized[key])
      errors.push(`${key}: must not be empty; omit optional fields instead.`);
  }
  if (
    typeof value.type === "string" &&
    !Object.hasOwn(EMOJI, normalized.type ?? "")
  ) {
    errors.push(`type: choose one of ${Object.keys(EMOJI).join(", ")}.`);
  }
  if (normalized.scope && /[()!:]/u.test(normalized.scope)) {
    errors.push(
      "scope: supply only the scope name, without parentheses, ! or colon.",
    );
  }
  if (
    normalized.description &&
    /^\p{Extended_Pictographic}/u.test(normalized.description)
  ) {
    errors.push(
      "description: omit the emoji; the application adds it from type.",
    );
  }
  if (normalized.breakingChange?.startsWith("BREAKING CHANGE:")) {
    errors.push(
      "breakingChange: supply only the explanation, without the footer label.",
    );
  }
  for (const key of Object.keys(value)) {
    if (
      !["type", "description", "scope", "body", "breakingChange"].includes(key)
    ) {
      errors.push(`${key}: unsupported field.`);
    }
  }
  if (errors.length > 0) return { accepted: false, errors };
  return { accepted: true, draft: normalized as unknown as CommitDraft };
}

export function formatMessage(draft: CommitDraft, emoji: boolean): string {
  const prefix = emoji ? `${EMOJI[draft.type as keyof typeof EMOJI]} ` : "";
  const scope = draft.scope ? `(${draft.scope})` : "";
  const breaking = draft.breakingChange ? "!" : "";
  return [
    `${prefix}${draft.type}${scope}${breaking}: ${draft.description}`,
    draft.body,
    draft.breakingChange
      ? `BREAKING CHANGE: ${draft.breakingChange}`
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

/** Parse editor text back into the same structure; the formatter owns emoji. */
export function parseMessage(input: string): DraftResult {
  const normalized = input.replace(/\r\n/g, "\n");
  if (hasControlCharacters(normalized, true)) {
    return {
      accepted: false,
      errors: [
        "message: contains a control character or an invalid line break.",
      ],
    };
  }
  const text = normalized.trimEnd();
  const [rawSubject = "", ...lines] = text.split("\n");
  const subject = rawSubject.replace(
    /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D)* /u,
    "",
  );
  const match = /^([a-z]+)(?:\(([^()]*)\))?(!)?: (.+)$/u.exec(subject);
  if (!match) {
    return {
      accepted: false,
      errors: [
        "subject: expected type(scope)!: description (scope and ! are optional).",
      ],
    };
  }
  if (lines.length && lines[0] !== "") {
    return {
      accepted: false,
      errors: ["body: separate the subject and body with a blank line."],
    };
  }
  let body = lines.join("\n").trim();
  let breakingChange: string | undefined;
  const footer = /(?:^|\n\n)BREAKING CHANGE: ([\s\S]*)$/u.exec(body);
  if (footer) {
    breakingChange = footer[1];
    body = body.slice(0, footer.index).trimEnd();
  }
  if (Boolean(match[3]) !== (breakingChange !== undefined)) {
    return {
      accepted: false,
      errors: [
        "breakingChange: use both subject ! and a BREAKING CHANGE: footer.",
      ],
    };
  }
  return validateDraft({
    type: match[1],
    description: match[4],
    ...(match[2] !== undefined ? { scope: match[2] } : {}),
    ...(body ? { body } : {}),
    ...(breakingChange !== undefined ? { breakingChange } : {}),
  });
}
