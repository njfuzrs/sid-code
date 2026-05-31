/**
 * WorkspaceProvider 实现
 * ADR-030 / S8-T08
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { WorkspaceProvider } from "./types.ts";

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
    this.baseDir = baseDir ?? join(tmpdir(), "sid-code-daemon");
  }

  getWorkdir(): string {
    if (!this.workdir) throw new Error("workspace not prepared");
    return this.workdir;
  }

  async prepare(opts: { repo: string; branch: string; commit?: string }): Promise<void> {
    const prefix = join(this.baseDir, "ws-");
    this.workdir = mkdtempSync(prefix);

    const repoUrl = opts.repo.startsWith("http")
      ? opts.repo
      : `https://github.com/${opts.repo}.git`;

    execSync(
      `git clone --depth 1 --branch ${opts.branch} ${repoUrl} ${this.workdir}`,
      { stdio: "pipe", timeout: 60_000 },
    );

    if (opts.commit) {
      execSync(`git checkout ${opts.commit}`, {
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
