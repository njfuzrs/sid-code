/**
 * HeadlessExecutor — 无头执行器（缺口 C1-0）
 *
 * 「无人值守地真正跑一遍 agent」这件事至今没有真实实现（worker.ts:92 占位）。
 * 本执行器填掉该占位，并被两个触发源共用：
 *   - 调度源（daemon Scheduler onFire）：source="schedule"
 *   - webhook worker（DaemonWorker.handlePR）：source="webhook"
 *
 * 设计决策（见架构方案 §3.2）：每次 fire 用 Bun.spawn 起一个 `sid-code -p` 子进程，
 * 而非进程内 `await app.runHeadless()`。理由：
 *   1. 隔离爆炸半径——单个任务崩溃/OOM/死循环不拖垮守护进程
 *   2. 会话状态干净——子进程天然每次全新，不会反复 init() 同一 App 漂移
 *   3. 复用现成入口——`sid-code -p` 是稳定无头路径，零新代码
 *   4. 超时可控——子进程可 SIGTERM→SIGKILL，进程内 await 难以强制中断跑飞的 query loop
 *   5. 对齐 cc——Desktop「fresh session when a task is due」= 全新进程
 *
 * 权限模型（§5.3）：默认只读（不传 --allowed-tools 时走 plan/默认权限），
 * 任务级 allowedTools 白名单显式放行；G-13 守护进程绝不 auto-commit/push。
 */

import { spawn } from "node:child_process";
import type { HeadlessJob, WorkerResult, StorageAdapter } from "./types.ts";
import { getLogger } from "../debug/logger.ts";
import { resolveExecutable } from "../bootstrap/resolve-executable.ts";

/** 默认超时：30 分钟（对齐 fork 子代理上限） */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** SIGTERM 后等多久强制 SIGKILL */
const KILL_GRACE_MS = 5_000;

export interface HeadlessExecutorOptions {
  /** 结果落盘（复用 daemon StorageAdapter）；缺省不落盘 */
  storage?: StorageAdapter;
}

export interface HeadlessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 抽取出的最终响应文本（--output-format json 时从 content 拼接） */
  finalText: string;
  durationMs: number;
}

export class HeadlessExecutor {
  constructor(private opts: HeadlessExecutorOptions = {}) {}

  /**
   * 执行一个无头 job：fork `sid-code -p` 子进程，捕获输出，落盘审计。
   * 不抛异常——所有失败封装进 WorkerResult.status。
   */
  async run(job: HeadlessJob): Promise<WorkerResult> {
    const start = Date.now();
    const log = getLogger();
    log.info(
      "DAEMON",
      `headless job 启动 source=${job.source} id=${job.jobId} cwd=${job.workspaceDir}`,
    );

    let runResult: HeadlessRunResult;
    try {
      runResult = await this.spawnSidCode(job);
    } catch (err: any) {
      const durationMs = Date.now() - start;
      log.error("DAEMON", `headless job spawn 失败 id=${job.jobId}: ${err?.message ?? err}`);
      return {
        event_id: job.jobId,
        skill: job.source,
        status: "error",
        duration_ms: durationMs,
        error: err?.message ?? String(err),
      };
    }

    // 落盘审计（每个 job 的结果存 StorageAdapter，可后续复盘）
    if (this.opts.storage) {
      try {
        await this.opts.storage.saveSession(job.jobId, {
          job: {
            jobId: job.jobId,
            source: job.source,
            workspaceDir: job.workspaceDir,
            prompt: job.prompt,
            allowedTools: job.allowedTools ?? [],
          },
          output: runResult.finalText,
          exitCode: runResult.exitCode,
          timedOut: runResult.timedOut,
          stderr: runResult.stderr.slice(-4000),
          completed_at: start + runResult.durationMs,
        });
      } catch (err: any) {
        log.warn("DAEMON", `headless job 落盘失败 id=${job.jobId}: ${err?.message ?? err}`);
      }
    }

    if (runResult.timedOut) {
      log.warn(
        "DAEMON",
        `headless job 超时 id=${job.jobId} (${job.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)`,
      );
      return {
        event_id: job.jobId,
        skill: job.source,
        status: "timeout",
        output: runResult.finalText,
        duration_ms: runResult.durationMs,
        error: `子进程超时 (${job.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)`,
      };
    }

    if (runResult.exitCode !== 0) {
      log.warn("DAEMON", `headless job 退出码非 0 id=${job.jobId} exit=${runResult.exitCode}`);
      return {
        event_id: job.jobId,
        skill: job.source,
        status: "error",
        output: runResult.finalText,
        duration_ms: runResult.durationMs,
        error: runResult.stderr.slice(-2000) || `exit=${runResult.exitCode}`,
      };
    }

    log.info(
      "DAEMON",
      `headless job 完成 id=${job.jobId} (${(runResult.durationMs / 1000).toFixed(1)}s)`,
    );
    return {
      event_id: job.jobId,
      skill: job.source,
      status: "success",
      output: runResult.finalText,
      duration_ms: runResult.durationMs,
    };
  }

  /**
   * fork `sid-code -p --output-format json <prompt>` 子进程。
   * 复用 command/review.ts 的成熟 spawn 模式：定位 bootstrap.ts、SIGTERM→SIGKILL 超时。
   */
  private spawnSidCode(job: HeadlessJob): Promise<HeadlessRunResult> {
    const { cmd, baseArgs } = resolveExecutable();
    const timeoutMs = job.timeoutMs > 0 ? job.timeoutMs : DEFAULT_TIMEOUT_MS;

    const cmdArgs: string[] = [...baseArgs, "-p", "--output-format", "json"];
    if (job.model) {
      cmdArgs.push("--model", job.model);
    }
    // 预授权白名单注入（§5.3）：声明了才放行，否则默认只读
    if (job.allowedTools && job.allowedTools.length > 0) {
      cmdArgs.push("--allowed-tools", job.allowedTools.join(","));
    } else {
      // 无白名单 → 强制 plan 只读模式，绝不写文件/跑破坏性命令
      cmdArgs.push("--permission-mode", "plan");
    }
    cmdArgs.push(job.prompt);

    const start = Date.now();
    return new Promise<HeadlessRunResult>((resolve) => {
      const child = spawn(cmd, cmdArgs, {
        cwd: job.workspaceDir,
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          // 子进程可据此识别自己是 daemon 触发的无头 job
          SID_DAEMON_JOB: job.jobId,
          SID_DAEMON_SOURCE: job.source,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* 已退出 */
          }
        }, KILL_GRACE_MS);
      }, timeoutMs);

      child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
      child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

      const finish = (exitCode: number) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        resolve({
          exitCode,
          stdout,
          stderr,
          timedOut,
          finalText: extractFinalResponse(stdout),
          durationMs: Date.now() - start,
        });
      };

      child.on("exit", (code) => finish(code ?? 1));
      child.on("error", (err) => {
        stderrChunks.push(Buffer.from(`spawn error: ${err.message}\n`));
        finish(1);
      });
    });
  }
}

/**
 * 从 `sid-code -p --output-format json` 的 stdout 抽取最终文本。
 * 输出形如 { session_id, role, content: [{type:"text",text}], usage }。
 * 兼容 review.ts 旧口径（final_response / text 字段）。
 */
export function extractFinalResponse(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.final_response === "string") return parsed.final_response;
    if (typeof parsed.text === "string") return parsed.text;
    // app.ts runHeadless json 模式：content 是 ContentBlock[]
    if (Array.isArray(parsed.content)) {
      return parsed.content
        .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n");
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}
