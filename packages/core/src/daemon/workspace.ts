/**
 * WorkspaceProvider 实现
 * ADR-030 / S8-T08
 */

import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { WorkspaceProvider } from "./types.ts";
import { sidTempPath } from "@sid-code/shared/utils/temp-dir.ts";

export class LocalWorkspaceProvider implements WorkspaceProvider {
  private workdir: string;

  constructor(workdir?: string) {
    this.workdir = workdir ?? process.cwd();
  }

  getWorkdir(): string {
    return this.workdir;
  }

  async prepare(): Promise<void> {
    // CLI 模式: no-op，直接用当前目录
  }

  async cleanup(): Promise<void> {
    // CLI 模式: no-op
  }
}

export class GitCloneWorkspaceProvider implements WorkspaceProvider {
  private workdir: string = "";
  private baseDir: string;

  constructor(baseDir?: string) {
    // 多用户隔离：默认放进带 UID 的 sid-code 临时根下（getSidTempDir），避免共享 /tmp 串扰
    this.baseDir = baseDir ?? sidTempPath("daemon");
  }

  getWorkdir(): string {
    if (!this.workdir) throw new Error("workspace not prepared");
    return this.workdir;
  }

  async prepare(opts: { repo: string; branch: string; commit?: string }): Promise<void> {
    // mkdtempSync 要求父目录已存在；以 0o700 创建隔离 base
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    const prefix = join(this.baseDir, "ws-");
    this.workdir = mkdtempSync(prefix);

    const repoUrl = opts.repo.startsWith("http")
      ? opts.repo
      : `https://github.com/${opts.repo}.git`;

    // 用数组参数（execFileSync）而非字符串拼接：opts.branch / repoUrl 溯源到
    // GitHub PR webhook 载荷（外部可控），字符串插值进 shell 会导致命令注入
    // （分支名含 `;`、`$()`、空格等）。数组参数不经 shell 解析，天然免疫。
    execFileSync("git", ["clone", "--depth", "1", "--branch", opts.branch, repoUrl, this.workdir], {
      stdio: "pipe",
      timeout: 60_000,
    });

    if (opts.commit) {
      execFileSync("git", ["checkout", opts.commit], {
        cwd: this.workdir,
        stdio: "pipe",
        timeout: 30_000,
      });
    }
  }

  async cleanup(): Promise<void> {
    if (this.workdir && existsSync(this.workdir)) {
      rmSync(this.workdir, { recursive: true, force: true });
      this.workdir = "";
    }
  }
}
