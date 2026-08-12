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
import { join, resolve as resolvePath } from "node:path";
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
  /** plan 文件被 write/edit 成功的次数（从 trajectory 真命中解析；plan_recovery capability 用） */
  planFileUpdateCount: number;
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
 * JSON 模式输出 {session_id, trajectory_path, role, content, usage}，content 是 ContentBlock 数组
 *
 * 暴露给单测用
 */
export function parseFinalResponseFromStdout(stdout: string): {
  text: string;
  sessionId: string | null;
  trajectoryPath: string | null;
} {
  const trimmed = stdout.trim();
  const empty = { text: "", sessionId: null, trajectoryPath: null };
  if (!trimmed) return empty;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {}
    }
  }
  if (!parsed) return { ...empty, text: trimmed.slice(0, 3000) };

  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
  const trajectoryPath = typeof parsed.trajectory_path === "string" ? parsed.trajectory_path : null;

  let text = "";
  const content = parsed.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") text += (text ? "\n" : "") + b.text;
    }
  } else if (typeof content === "string") {
    text = content;
  }
  return { text: text.slice(0, 3000), sessionId, trajectoryPath };
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
 * 从 trajectory 数 plan 文件被 write/edit 成功的真命中次数
 * （W12.D3 / ADR-017 §2.5：替代 run-plan-capability.ts 的粗估实现）
 *
 * 规则：
 * - 只数 message_type === "action" 且 tool_name in {"write","edit"} 的步骤
 * - 必须 tool_input.file_path 与 planFilePath 精确匹配（resolve 后比较）
 * - 后跟一个 message_type === "observation" 的 step 且 role === "user"
 *   （observation 通常是工具结果；is_error 字段在 sid-code trace builder 中可能未透传，
 *    保守起见：只要 observation 出现就视为"工具完成"，不区分错误 — 大部分错误情况下
 *    sid-code permission 拒绝是 trace 里的 tool_result.is_error=true 也会落 observation；
 *    实际命中误差由 trace builder 决定，这里采取"宽松计数 + LLM Judge 把关"策略）
 * - 退化：如果没有 observation 或下一步未知，仍计入（trajectory 末尾的工具调用）
 *
 * 暴露给单测用
 */
export function countPlanFileUpdates(opts: {
  trajectory: Array<Record<string, unknown>> | undefined;
  planFilePath: string | null;
}): number {
  if (!opts.planFilePath || !opts.trajectory?.length) return 0;
  const planResolved = resolvePath(opts.planFilePath);

  let count = 0;
  for (const step of opts.trajectory) {
    if (step.message_type !== "action") continue;
    const tool = (step.tool_name ?? "").toString().toLowerCase();
    if (tool !== "write" && tool !== "edit") continue;
    const input = step.tool_input as Record<string, unknown> | undefined;
    const fp = input?.file_path;
    if (typeof fp !== "string" || !fp) continue;
    try {
      if (resolvePath(fp) === planResolved) count++;
    } catch {
      // ignore unresolvable paths
    }
  }
  return count;
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
 * - deadlineMs 触发（W12.D4 hotfix：防 Bun.spawn timeout SIGKILL 后 reader 仍卡住 await read）
 * - maxBytes 超限（防御性）
 *
 * W12.D4 hotfix（spec: docs/specs/active/W12-adapter-stability-hotfix.md）：
 * 之前没有 deadlineMs 时，hardTimer 触发 proc.kill 后 await reader.read() 仍 block —
 * 子进程被 SIGTERM 后仍可能继续写完当前 chunk，reader loop 永不退出（实测 plan_007 跑 1273s vs 360s timeout）。
 *
 * 暴露给单测用
 */
export async function readStreamUntilDone(
  stream: ReadableStream<Uint8Array> | undefined | null,
  opts: { maxBytes?: number; deadlineMs?: number } = {},
): Promise<{ buf: string; timedOut: boolean }> {
  if (!stream) return { buf: "", timedOut: false };
  const maxBytes = opts.maxBytes ?? 5_000_000;
  const deadline = opts.deadlineMs != null ? Date.now() + opts.deadlineMs : null;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  let timedOut = false;

  // 检测完成标志：含 "会话摘要" + 之后出现 2 个 20+ 长的 ── 分隔线（box-drawing 字符）
  const isDone = (s: string): boolean => {
    const idx = s.indexOf("会话摘要");
    if (idx < 0) return false;
    const after = s.slice(idx);
    return /─{20,}[\s\S]{50,}─{20,}/.test(after);
  };

  try {
    while (buf.length < maxBytes) {
      if (deadline != null && Date.now() >= deadline) {
        timedOut = true;
        break;
      }

      let done = false;
      if (deadline != null) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          timedOut = true;
          break;
        }
        // race 模式：read() vs deadline 超时
        const race = await Promise.race([
          reader.read().then((r) => ({ ...r, __timeout: false as const })),
          new Promise<{ __timeout: true; done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ __timeout: true, done: true, value: undefined }), remaining),
          ),
        ]);
        if (race.__timeout) {
          timedOut = true;
          break;
        }
        done = race.done;
        if (race.value) {
          buf += decoder.decode(race.value, { stream: true });
        }
      } else {
        const result = await reader.read();
        done = result.done;
        if (result.value) {
          buf += decoder.decode(result.value, { stream: true });
        }
      }

      if (done) break;
      if (isDone(buf)) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return { buf, timedOut };
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
  const args = ["run", entrypoint, "-p", "--output-format", "json", "--trace-upload-disabled"];
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

  // 不全量透传 process.env，避免 SID_CODE_LLM_MODEL / SID_CODE_LLM_BASE_URL 等覆盖用户 ~/.sid-code/config.yaml 的默认值
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
      ? { SID_CODE_LLM_BASE_URL: config.baseUrl, ANTHROPIC_BASE_URL: config.baseUrl }
      : {}),
    ...(config.env || {}),
  };

  const startTs = Date.now();

  if (process.env.SID_CODE_LIVE_DEBUG === "1") {
    console.error(
      `[live-adapter] spawn args: bun ${args.map((a) => (a.length > 80 ? a.slice(0, 80) + "..." : JSON.stringify(a))).join(" ")}`,
    );
    console.error(`[live-adapter] spawn env keys: ${Object.keys(env).join(", ")}`);
    console.error(`[live-adapter] cwd: ${config.cwd}`);
  }

  const proc = Bun.spawn(["bun", ...args], {
    cwd: config.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });

  // W12.D4 hotfix: readStreamUntilDone deadline = spawn timeout + 5s 兜底
  // Bun.spawn 内置 timeout 会在 timeoutMs 后发 SIGKILL，reader deadline 是二级保险
  const readerDeadlineMs = timeoutMs + 5_000;

  let stdout = "";
  let stderr = "";
  try {
    const { buf, timedOut: streamTimedOut } = await readStreamUntilDone(proc.stdout, {
      deadlineMs: readerDeadlineMs,
    });
    stdout = buf;

    // stderr 独立读到 EOF 或 kill
    stderr = await readStreamWithTimeout(proc.stderr, 2000);

    // 主动 kill 子进程（防止后台 handle 持续 keep-alive）
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore — 可能已被 Bun timeout 杀掉
    }

    // 等子进程实际退出（最多 3s，超时仍返回数据）
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);

    // 判定超时：Bun spawn timeout 触发（signalCode=SIGKILL）或 reader deadline 触发
    const spawnTimedOut = proc.signalCode === "SIGKILL" && Date.now() - startTs >= timeoutMs * 0.9;
    const timedOut = spawnTimedOut || streamTimedOut;

    return buildResult({
      instruction,
      stdout,
      stderr,
      exitCode: exitCode === null ? 0 : exitCode,
      timedOut,
      startTs,
      trajectoriesDir,
      plansDir: join(home, ".sid-code", "plans"),
    });
  } catch (err) {
    return buildResult({
      instruction,
      stdout,
      stderr: stderr + `\n[adapter] spawn error: ${String(err).slice(0, 500)}`,
      exitCode: null,
      timedOut: Date.now() - startTs >= timeoutMs * 0.9,
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
  // 优先从 stdout JSON 解析 trajectory_path（sid-code --output-format json 暴露）
  // 失败时退回 mtime 反查作为兼容路径
  const parsed = parseFinalResponseFromStdout(opts.stdout);
  let sessionDir: string | null = null;
  if (parsed.trajectoryPath) {
    sessionDir = join(parsed.trajectoryPath, "..");
  } else {
    sessionDir = findLatestSessionDir({
      trajectoriesDir: opts.trajectoriesDir,
      sinceTimestamp: opts.startTs,
    });
  }
  const planFilePath = findLatestPlanFile({
    plansDir: opts.plansDir,
    sinceTimestamp: opts.startTs,
  });

  const trajData = sessionDir ? readTrajectoryFile(sessionDir) : null;
  const trajectory = (trajData?.trajectory || []) as Parameters<typeof analyzeTrajectorySignals>[0];
  const meta = trajData?.metadata || {};

  const signals = trajectory.length
    ? analyzeTrajectorySignals(trajectory)
    : { error_count: 0, retry_count: 0, backtrack_count: 0 };

  // W12.D3：从 trajectory 解析 plan 文件真命中次数
  const planFileUpdateCount = countPlanFileUpdates({
    trajectory: trajectory as Array<Record<string, unknown>>,
    planFilePath,
  });

  const finalResponse = parsed.text;

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
    planFileUpdateCount,
    stdout: opts.stdout,
    stderr: opts.stderr,
    exitCode: opts.exitCode,
    timedOut: opts.timedOut,
  };
}
