import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitSnapshot {
  head: string;
  tree: string;
}

export interface GitSummary {
  branch: string;
  files: number;
  additions: number;
  deletions: number;
}

export class GitRepository {
  private constructor(readonly root: string) {}

  static async open(cwd: string): Promise<GitRepository> {
    try {
      const { stdout } = await exec("git", [
        "-C",
        cwd,
        "rev-parse",
        "--show-toplevel",
      ]);
      return new GitRepository(stdout.trim());
    } catch {
      throw new Error("当前目录不在 Git 工作仓库中。");
    }
  }

  private async run(args: string[]): Promise<string> {
    const { stdout } = await exec("git", ["-C", this.root, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  }

  async hasStagedChanges(): Promise<boolean> {
    try {
      await this.run(["diff", "--cached", "--quiet", "--exit-code"]);
      return false;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return true;
      throw error;
    }
  }

  async snapshot(): Promise<GitSnapshot> {
    // write-tree handles unborn HEADs and hashes exactly the current index.
    const tree = await this.run(["write-tree"]);
    let head = "UNBORN";
    try {
      head = await this.run(["rev-parse", "--verify", "HEAD"]);
    } catch {
      // Initial commits have no HEAD yet.
    }
    return { head, tree };
  }

  async summary(): Promise<GitSummary> {
    let branch: string;
    try {
      branch = await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    } catch {
      branch = await this.run(["rev-parse", "--short", "HEAD"]);
    }
    const records = (
      await this.run([
        "diff",
        "--cached",
        "--numstat",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
      ])
    ).split("\0");
    let files = 0;
    let additions = 0;
    let deletions = 0;
    for (let index = 0; index < records.length; index++) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(records[index] ?? "");
      if (!match) continue;
      files++;
      additions += match[1] === "-" ? 0 : Number(match[1]);
      deletions += match[2] === "-" ? 0 : Number(match[2]);
      // A rename/copy has an empty path followed by two NUL-delimited paths.
      if (match[3] === "") index += 2;
    }
    return { branch, files, additions, deletions };
  }

  async matches(expected: GitSnapshot): Promise<boolean> {
    const current = await this.snapshot();
    return current.head === expected.head && current.tree === expected.tree;
  }

  async commit(
    message: string,
    expected: GitSnapshot,
  ): Promise<"committed" | "changed" | "failed"> {
    const directory = await mkdtemp(join(tmpdir(), "pi-commit-message-"));
    try {
      const path = join(directory, "COMMIT_EDITMSG");
      await writeFile(path, `${message}\n`, { mode: 0o600, flag: "wx" });
      if (!(await this.matches(expected))) return "changed";
      return await new Promise((resolve, reject) => {
        const child = spawn(
          "git",
          ["-C", this.root, "commit", "--cleanup=verbatim", "-F", path],
          { stdio: "inherit" },
        );
        child.on("error", reject);
        child.on("close", (code) =>
          resolve(code === 0 ? "committed" : "failed"),
        );
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
