/**
 * Daemon Worker — webhook 触发的无头 Agent 执行器
 * ADR-030 / RFC-006 / S8-T08
 *
 * 缺口 C1-0：runCodeReview 占位已被 HeadlessExecutor 真实现替换——
 * 现在 webhook PR 事件会真正 fork 一个 `sid-code -p` 子进程跑 code-review，
 * 而非返回 diff 摘要。这是 C1 与 ADR-030 的核心汇合：一份执行器，两个触发源。
 */

import type { GitHubPREvent, WorkerResult, DaemonConfig, HeadlessJob } from "./types.ts";
import { GitCloneWorkspaceProvider } from "./workspace.ts";
import { FileStorageAdapter } from "./storage.ts";
import { HeadlessExecutor } from "./headless-executor.ts";
import { randomBytes } from "node:crypto";

export class DaemonWorker {
  private config: DaemonConfig;
  private storage: FileStorageAdapter;
  private executor: HeadlessExecutor;
  private running = 0;

  constructor(config: DaemonConfig) {
    this.config = config;
    this.storage = new FileStorageAdapter(config.storage_path ?? "/tmp/sid-code-daemon/sessions");
    this.executor = new HeadlessExecutor({ storage: this.storage });
  }

  canAccept(): boolean {
    return this.running < this.config.max_concurrent;
  }

  async handlePR(event: GitHubPREvent): Promise<WorkerResult> {
    const eventId = `pr-${event.owner}-${event.repo}-${event.number}-${randomBytes(3).toString("hex")}`;
    const start = Date.now();
    this.running++;

    const workspace = new GitCloneWorkspaceProvider(this.config.workspace_base);

    try {
      await workspace.prepare({
        repo: `${event.owner}/${event.repo}`,
        branch: event.branch,
        commit: event.commit_sha,
      });

      const workdir = workspace.getWorkdir();

      // 生成 diff（base_branch...branch）
      // 用数组参数（execFileSync）：event.base_branch 来自 GitHub PR webhook 载荷
      // （外部可控），字符串插值进 shell 会命令注入。数组参数不经 shell 解析。
      const { execFileSync } = await import("node:child_process");
      let diff: string;
      try {
        execFileSync("git", ["fetch", "origin", event.base_branch, "--depth", "1"], {
          cwd: workdir,
          stdio: "pipe",
          timeout: 30_000,
        });
        diff = execFileSync("git", ["diff", `origin/${event.base_branch}...HEAD`], {
          cwd: workdir,
          encoding: "utf-8",
          timeout: 30_000,
        });
      } catch {
        diff = execFileSync("git", ["diff", "HEAD~1"], {
          cwd: workdir,
          encoding: "utf-8",
          timeout: 30_000,
        });
      }

      // 缺口 C1-0：真正调用 code-review Skill —— fork 无头子进程，而非占位摘要。
      const job: HeadlessJob = {
        jobId: eventId,
        prompt: buildCodeReviewPrompt(event, diff),
        workspaceDir: workdir,
        timeoutMs: this.config.job_timeout_ms ?? 30 * 60_000,
        source: "webhook",
        // PR review 只读：不放行写工具，激活 code-review Skill 走默认 plan 只读
        allowedTools: this.config.allowed_tools ?? [],
      };
      const result = await this.executor.run(job);

      return {
        event_id: eventId,
        skill: "code-review",
        status: result.status,
        output: result.output,
        duration_ms: Date.now() - start,
        error: result.error,
      };
    } catch (err) {
      return {
        event_id: eventId,
        skill: "code-review",
        status: "error",
        duration_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await workspace.cleanup();
      this.running--;
    }
  }
}

/** 拼 code-review 的 prompt：激活 Skill + 注入 PR diff */
function buildCodeReviewPrompt(event: GitHubPREvent, diff: string): string {
  return `请用 code-review Skill 审查以下 Pull Request 的代码变更。

PR: ${event.owner}/${event.repo}#${event.number}（分支 ${event.branch} → ${event.base_branch}）

要求：
- 引用具体 file:line 行号（RL-007 不编造问题）
- 不调用 edit / write 工具修改文件（RL-001 不删用户代码）
- 输出结构化 markdown 报告：顶层 Verdict + 每个 finding 的 severity / file:line / Issue / Suggested Fix

\`\`\`diff
${diff.slice(0, 200_000)}
\`\`\``;
}
