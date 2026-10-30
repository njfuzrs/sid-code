/**
 * Daemon Worker — webhook 触发的无头 Agent 执行器
 * ADR-030 / RFC-006 / S8-T08
 *
 * 缺口 C1-0：runCodeReview 占位已被 HeadlessExecutor 真实现替换——
 * 现在 webhook PR 事件会真正 fork 一个 `sid-code -p` 子进程跑 code-review，
 * 而非返回 diff 摘要。这是 C1 与 ADR-030 的核心汇合：一份执行器，两个触发源。
 */

import type {
  GitHubPREvent,
  WorkerResult,
  DaemonConfig,
  HeadlessJob,
  ConcurrencyGate,
} from "./types.ts";
import { GitCloneWorkspaceProvider } from "./workspace.ts";
import { FileStorageAdapter } from "./storage.ts";
import { HeadlessExecutor } from "./headless-executor.ts";
import { randomBytes } from "node:crypto";

export class DaemonWorker {
  private config: DaemonConfig;
  private storage: FileStorageAdapter;
  private executor: HeadlessExecutor;
  private gate: ConcurrencyGate;

  /**
   * @param gate 并发闸门。daemon 传入自己的（与调度源共用计数）；裸起 server 时缺省为
   *             本地计数，上限 config.max_concurrent。
   */
  constructor(config: DaemonConfig, gate?: ConcurrencyGate) {
    this.config = config;
    this.gate = gate ?? localGate(config.max_concurrent);
    this.storage = new FileStorageAdapter(config.storage_path ?? "/tmp/sid-code-daemon/sessions");
    this.executor = new HeadlessExecutor({ storage: this.storage });
  }

  canAccept(): boolean {
    return this.gate.canAccept();
  }

  async handlePR(event: GitHubPREvent): Promise<WorkerResult> {
    const eventId = `pr-${event.owner}-${event.repo}-${event.number}-${randomBytes(3).toString("hex")}`;
    const start = Date.now();
    // 必须在第一个 await 之前占名额：server 先 canAccept 再调本函数，中间不能让出事件循环
    this.gate.acquire();

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
      // B43：fetch 不能带 --depth 1——会把已有的完整历史截断，merge-base 又找不到了。
      // 失败直接抛（外层记 error），不再兜底 HEAD~1：那条兜底在浅克隆里同样不存在，
      // 且「审了一个错的 diff」比「明确报错」更糟。
      execFileSync("git", ["fetch", "--no-tags", "origin", event.base_branch], {
        cwd: workdir,
        stdio: "pipe",
        timeout: 120_000,
      });
      diff = execFileSync("git", ["diff", `origin/${event.base_branch}...HEAD`], {
        cwd: workdir,
        encoding: "utf-8",
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      });

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
      try {
        await workspace.cleanup();
      } finally {
        this.gate.release();
      }
    }
  }
}

function localGate(max: number): ConcurrencyGate {
  let running = 0;
  return {
    canAccept: () => running < max,
    acquire: () => {
      running++;
    },
    release: () => {
      running--;
    },
  };
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
