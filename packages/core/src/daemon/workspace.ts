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

    // 带协议的完整 URL 原样用（https / ssh / file，测试与自建 Git 服务走这里）；
    // 否则按 GitHub 的 owner/repo 拼。worker 传入的是 `${owner}/${repo}`，GitHub 登录名
    // 不含 ':'，不会被误判成 URL。
    const repoUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(opts.repo)
      ? opts.repo
      : `https://github.com/${opts.repo}.git`;

    // 用数组参数（execFileSync）而非字符串拼接：opts.branch / repoUrl 溯源到
    // GitHub PR webhook 载荷（外部可控），字符串插值进 shell 会导致命令注入
    // （分支名含 `;`、`$()`、空格等）。数组参数不经 shell 解析，天然免疫。
    // B43：不能用 --depth 1。浅克隆里没有 PR 分支与 base 的 merge-base，worker 的
    // `git diff origin/<base>...HEAD` 必然失败，兜底的 `HEAD~1` 在单提交历史里也不存在，
    // 整个 job 在 fork 子进程之前就报错（实测）。blob:none 拿全部提交历史、按需取文件，
    // 克隆开销接近浅克隆，三点 diff 与指定 commit checkout 都可用。
    execFileSync(
      "git",
      ["clone", "--filter=blob:none", "--no-tags", "--branch", opts.branch, repoUrl, this.workdir],
      { stdio: "pipe", timeout: 120_000 },
    );

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
