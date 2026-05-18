/**
 * Phase 4 W11 / ADR-016: Adapter — sid-code-live
 * 通过 spawn 子进程实跑 sid-code CLI，读 trajectory 落盘解析为评分输入
 *
 * 设计要点：
 * - spawn `bun run src/entrypoints/bootstrap.ts -p --output-format json <instruction>`
 * - 等子进程退出（超时强杀）
 * - 扫 ~/.sid-code/trajectories/sessions/ 找本次跑产生的最新 session 目录
 * - 读 session.traj 解析为 trajectory + metadata
 * - 复用 sid-code.ts 的 analyzeTrajectorySignals 提 L2 信号
 */

import type { AgentOutput } from "../outcome-grader.ts";
import type { TrajectoryMetrics } from "../trajectory-grader.ts";
import { analyzeTrajectorySignals } from "./sid-code.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";

/** sid-code-live adapter 配置 */
export interface SidCodeLiveConfig {
  /** sid-code 仓库根目录（用于 spawn `bun run src/entrypoints/bootstrap.ts`） */
  cwd: string;
  /** Anthropic API Key（可选；为空时 sid-code 用 ~/.sid-code/config.yaml 配置） */
  apiKey?: string;
  /** Anthropic base URL（兼容 OpenRouter / 国内代理） */
  baseUrl?: string;
  /** 模型名（可选；为空时使用用户 ~/.sid-code/config.yaml 默认 model） */
  model?: string;
  /** 单 task 超时（毫秒，默认 360_000 = 6 分钟） */
  timeoutMs?: number;
  /** trajectory 落盘根目录（默认 ~/.sid-code/trajectories） */
  trajectoriesDir?: string;
  /** 额外系统提示词（用于注入 mock_environment 等） */
  appendSystemPrompt?: string;
  /** 启用 Plan Mode（设为 plan 即 --permission-mode plan） */
  permissionMode?: string;
  /** sid-code bin 入口（默认 src/entrypoints/bootstrap.ts） */
  entrypoint?: string;
  /** 调试日志文件路径 */
  debugLogFile?: string;
  /** 给 spawn 的额外 env 覆盖 */
  env?: Record<string, string>;
}

/** sid-code-live 单次跑分结果 */
export interface SidCodeLiveResult {
  output: AgentOutput;
  metrics: TrajectoryMetrics;
  sessionDir: string | null;
  planFilePath: string | null;
  /** 子进程 stdout（JSON 模式下含 final assistant content） */
  stdout: string;
  /** 子进程 stderr（debug 用） */
  stderr: string;
  /** 退出码（0 = 正常，null = 超时强杀） */
  exitCode: number | null;
  /** 是否触发超时 */
  timedOut: boolean;
}

interface TrajectoryFile {
  trajectory?: unknown[];
  history?: unknown[];
  info?: Record<string, unknown>;
  metadata?: {
    session_id?: string;
    tools_used?: string[];
    files_edited?: string[];
    total_steps?: number;
    exit_status?: string;
    end_time?: string;
    start_time?: string;
  };
}

/**
 * 扫 trajectoriesDir/sessions/，返回 mtime 最新且在 sinceTimestamp 之后创建/修改的 session 目录
 *
 * 暴露给单测用
 */
export function findLatestSessionDir(opts: {
  trajectoriesDir: string;
  sinceTimestamp: number;
}): string | null {
  const sessionsRoot = join(opts.trajectoriesDir, "sessions");
  if (!existsSync(sessionsRoot)) return null;
  let bestPath: string | null = null;
  let bestMtime = 0;
  let entries: string[];
  try {
    entries = readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  for (const name of entries) {
    const dir = join(sessionsRoot, name);
    let mtime = 0;
    try {
      const s = statSync(dir);
      if (!s.isDirectory()) continue;
      mtime = s.mtimeMs;
    } catch {
      continue;
    }
    if (mtime < opts.sinceTimestamp - 1000) continue;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      bestPath = dir;
    }
  }
  return bestPath;
}

/**
 * 从 stdout 解析 final_response
 * JSON 模式输出 {role, content, usage}，content 是 ContentBlock 数组
 *
 * 暴露给单测用
 */
export function parseFinalResponseFromStdout(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  // JSON 模式：取最后一个 JSON 对象（前面可能有非 JSON 输出，比如 "恢复会话" 提示）
  // 反向搜 "{\n" 起始
  let parsed: { content?: unknown } | null = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 尝试找最后一段 {...}
    const m = trimmed.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        // 不是 JSON，退化为整段 stdout
      }
    }
  }
  if (!parsed) return trimmed.slice(0, 3000);
  const content = parsed.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
    return parts.join("\n").slice(0, 3000);
  }
  if (typeof content === "string") return content.slice(0, 3000);
  return "";
}

/**
 * 从 session.traj 读 trajectory + metadata
 *
 * 暴露给单测用
 */
export function readTrajectoryFile(sessionDir: string): TrajectoryFile | null {
  const trajPath = join(sessionDir, "session.traj");
  if (!existsSync(trajPath)) return null;
  try {
    const content = readFileSync(trajPath, "utf-8");
    return JSON.parse(content) as TrajectoryFile;
  } catch {
    return null;
  }
}

/**
 * 找当前 session 目录下最新的 plan 文件
 * sid-code 的 plan 文件落在 ~/.sid-code/plans/plan-{timestamp}.md（不在 session 目录内）
 */
export function findLatestPlanFile(opts: {
  plansDir: string;
  sinceTimestamp: number;
}): string | null {
  if (!existsSync(opts.plansDir)) return null;
  let bestPath: string | null = null;
  let bestMtime = 0;
  let entries: string[];
  try {
    entries = readdirSync(opts.plansDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = join(opts.plansDir, name);
    let mtime = 0;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < opts.sinceTimestamp - 1000) continue;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      bestPath = full;
    }
  }
  return bestPath;
}

/**
 * 流式读 stdout，检测到 sid-code headless 完成标志（"会话摘要" + 闭合分隔线）后立即返回
 *
 * sid-code headless 模式 stdout 时序：
 * - tool loop 期间 process.stdout 不写任何数据（参考 src/app.ts:786 — 整个 streamBuffer 在 done 后一次性写）
 * - done 后输出 JSON / text + "会话摘要" 段（src/app.ts:802）
 * - 所以 idle 不能用来判定完成（30s idle 不代表结束），必须靠 isDone 标志 + maxBytes 兜底
 *
 * 退出条件：
 * - stream EOF（子进程退出 / 被 kill）
 * - 检测到完成标志（"会话摘要" + 闭合分隔线）
 * - maxBytes 超限（防御性）
 *
 * 暴露给单测用
 */
export async function readStreamUntilDone(
  stream: ReadableStream<Uint8Array> | undefined | null,
  opts: { maxBytes?: number } = {},
): Promise<string> {
  if (!stream) return "";
  const maxBytes = opts.maxBytes ?? 5_000_000;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";

  // 检测完成标志：含 "会话摘要" + 之后出现 2 个 20+ 长的 ── 分隔线（box-drawing 字符）
  const isDone = (s: string): boolean => {
    const idx = s.indexOf("会话摘要");
    if (idx < 0) return false;
    const after = s.slice(idx);
    return /─{20,}[\s\S]{50,}─{20,}/.test(after);
  };

  try {
    while (buf.length < maxBytes) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value) {
        buf += decoder.decode(result.value, { stream: true });
      }
      if (isDone(buf)) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return buf;
}

/**
 * 限时读取 stream（最多 timeoutMs），到 EOF 或超时即返回当前 buffer
 *
 * 暴露给单测用
 */
export async function readStreamWithTimeout(
  stream: ReadableStream<Uint8Array> | undefined | null,
  timeoutMs: number,
): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const result = await Promise.race([
        reader.read(),
        new Promise<{ timeout: true }>((resolve) =>
          setTimeout(() => resolve({ timeout: true }), remaining),
        ),
      ]);
      if ("timeout" in result) break;
      if (result.done) break;
      if (result.value) buf += decoder.decode(result.value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return buf;
}

/**
 * 跑 sid-code CLI 单次任务
 */
export async function runSidCodeLive(
  instruction: string,
  config: SidCodeLiveConfig,
): Promise<SidCodeLiveResult> {
  const home = homedir();
  const trajectoriesDir = config.trajectoriesDir || join(home, ".sid-code", "trajectories");
  const entrypoint = config.entrypoint || "src/entrypoints/bootstrap.ts";
  const timeoutMs = config.timeoutMs ?? 360_000;

  // 注：sid-code 默认 trace=enabled，会自动落 ~/.sid-code/trajectories/sessions/<id>/session.traj
  // --trace-upload-disabled 阻止子进程跑完后上传到平台并清理本地（capability eval 必须保留本地 session.traj 供 adapter 读取）
  const args = [
    "run",
    entrypoint,
    "-p",
    "--output-format",
    "json",
    "--trace-upload-disabled",
  ];
  // model 可选：未传则用用户 ~/.sid-code/config.yaml 配置的默认 model
  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.permissionMode) {
    args.push("--permission-mode", config.permissionMode);
  }
  if (config.appendSystemPrompt) {
    args.push("--append-system-prompt", config.appendSystemPrompt);
  }
  if (config.debugLogFile) {
    args.push("--debug", "--debug-log-file", config.debugLogFile);
  }
  // instruction 必须放在所有 flag 之后，作为 positional 参数被 prompt 接住
  args.push(instruction);

  // 不全量透传 process.env，避免 LLM_MODEL / LLM_BASE_URL 等覆盖用户 ~/.sid-code/config.yaml 的默认值
  // 只传必要的系统 env，让 sid-code 子进程严格按 config 文件运行
  const baseEnv: Record<string, string> = {};
  const passThroughKeys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TERM",
    "PWD",
  ];
  for (const key of passThroughKeys) {
    const v = process.env[key];
    if (v != null) baseEnv[key] = v;
  }

  const env: Record<string, string> = {
    ...baseEnv,
    // 关掉所有交互式确认（avoid TTY prompt）
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    // 如果调用方显式传了 model/baseUrl/apiKey 才注入对应 env；否则让 sid-code 走 config 默认
    ...(config.apiKey ? { ANTHROPIC_API_KEY: config.apiKey } : {}),
    ...(config.baseUrl
      ? { LLM_BASE_URL: config.baseUrl, ANTHROPIC_BASE_URL: config.baseUrl }
      : {}),
    ...(config.env || {}),
  };

  const startTs = Date.now();

  if (process.env.SID_CODE_LIVE_DEBUG === "1") {
    console.error(`[live-adapter] spawn args: bun ${args.map((a) => (a.length > 80 ? a.slice(0, 80) + "..." : JSON.stringify(a))).join(" ")}`);
    console.error(`[live-adapter] spawn env keys: ${Object.keys(env).join(", ")}`);
    console.error(`[live-adapter] cwd: ${config.cwd}`);
  }

  const proc = Bun.spawn(["bun", ...args], {
    cwd: config.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let timedOut = false;
  const hardTimer = setTimeout(() => {
    timedOut = true;
    try {
      // 先 SIGTERM 给子进程清理机会，1.5s 后还活着就 SIGKILL
      proc.kill();
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 1500);
    } catch {
      // ignore
    }
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  try {
    // 流式读 stdout，检测到 sid-code headless 完成标志后主动 kill 子进程
    // （sid-code 后台 trace upload / fetch keep-alive 等会让 proc.exited 永不返回；
    //  但只要 "会话摘要" 段已打印 + 出现闭合分隔线，业务逻辑就已结束，可以提前 kill）
    stdout = await readStreamUntilDone(proc.stdout);

    // stderr 独立读到 EOF 或 kill
    stderr = await readStreamWithTimeout(proc.stderr, 2000);

    // 主动 kill 子进程（防止后台 handle 持续 keep-alive）
    if (!timedOut) {
      try {
        proc.kill();
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 1000);
      } catch {
        // ignore
      }
    }

    // 等子进程实际退出（最多 3s，超时仍返回数据）
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    clearTimeout(hardTimer);
    return buildResult({
      instruction,
      stdout,
      stderr,
      exitCode: exitCode === null ? 0 : exitCode, // 后台 keep-alive 不算 spawn 失败
      timedOut,
      startTs,
      trajectoriesDir,
      plansDir: join(home, ".sid-code", "plans"),
    });
  } catch (err) {
    clearTimeout(hardTimer);
    return buildResult({
      instruction,
      stdout,
      stderr: stderr + `\n[adapter] spawn error: ${String(err).slice(0, 500)}`,
      exitCode: null,
      timedOut,
      startTs,
      trajectoriesDir,
      plansDir: join(home, ".sid-code", "plans"),
    });
  }
}

function buildResult(opts: {
  instruction: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  startTs: number;
  trajectoriesDir: string;
  plansDir: string;
}): SidCodeLiveResult {
  const sessionDir = findLatestSessionDir({
    trajectoriesDir: opts.trajectoriesDir,
    sinceTimestamp: opts.startTs,
  });
  const planFilePath = findLatestPlanFile({
    plansDir: opts.plansDir,
    sinceTimestamp: opts.startTs,
  });

  const trajData = sessionDir ? readTrajectoryFile(sessionDir) : null;
  const trajectory = (trajData?.trajectory || []) as Parameters<
    typeof analyzeTrajectorySignals
  >[0];
  const meta = trajData?.metadata || {};

  const signals = trajectory.length
    ? analyzeTrajectorySignals(trajectory)
    : { error_count: 0, retry_count: 0, backtrack_count: 0 };

  const finalResponse = parseFinalResponseFromStdout(opts.stdout);

  let exitStatus = meta.exit_status || "unknown";
  if (opts.timedOut) exitStatus = "timeout";
  else if (opts.exitCode != null && opts.exitCode !== 0 && !meta.exit_status) {
    exitStatus = `spawn_exit_${opts.exitCode}`;
  }

  const output: AgentOutput = {
    tools_called: meta.tools_used || [],
    files_modified: meta.files_edited || [],
    files_created: [],
    steps: meta.total_steps || trajectory.length || 0,
    final_response: finalResponse,
    exit_status: exitStatus,
  };

  const metrics: TrajectoryMetrics = {
    steps: output.steps,
    tool_calls: output.tools_called.length,
    unique_tools: [...new Set(output.tools_called)],
    error_count: signals.error_count,
    retry_count: signals.retry_count,
    backtrack_count: signals.backtrack_count,
  };

  return {
    output,
    metrics,
    sessionDir,
    planFilePath,
    stdout: opts.stdout,
    stderr: opts.stderr,
    exitCode: opts.exitCode,
    timedOut: opts.timedOut,
  };
}
