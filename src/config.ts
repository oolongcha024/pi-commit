import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface Preferences {
  language?: "zh" | "en";
  emoji?: boolean;
  model?: string;
}

export function preferencesPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "pi-commit",
    "config.json",
  );
}

export function expandPath(path: string): string {
  return resolve(
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? join(homedir(), path.slice(2))
        : path,
  );
}

export async function loadPreferences(
  path = preferencesPath(),
): Promise<Preferences> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const data: unknown = JSON.parse(content);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`配置必须是 JSON 对象：${path}`);
  }
  const value = data as Record<string, unknown>;
  if (
    value.language !== undefined &&
    value.language !== "zh" &&
    value.language !== "en"
  ) {
    throw new Error(`配置 language 必须为 zh 或 en：${path}`);
  }
  if (value.emoji !== undefined && typeof value.emoji !== "boolean") {
    throw new Error(`配置 emoji 必须为 boolean：${path}`);
  }
  if (
    value.model !== undefined &&
    (typeof value.model !== "string" || !value.model.includes("/"))
  ) {
    throw new Error(`配置 model 必须为 provider/model：${path}`);
  }
  return value as Preferences;
}

export async function savePreferences(
  preferences: Preferences,
  path = preferencesPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}
