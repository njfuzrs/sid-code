#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { convertRawJsonlToTrace } from "../../scripts/eval/raw-jsonl-to-trace.ts";
import { validateTrace } from "../_types/agent-trace.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ENTRYPOINT = join(REPO_ROOT, "src/entrypoints/bootstrap.ts");

function parseArgs(): { prompt: string; caseId: string; model: string | null; timeoutMs: number; maxTurns: number | null; permissionMode: string | null } {
  const argv = process.argv.slice(2);
  let prompt = "";
  let caseId = "unknown";
  let model: string | null = null;
  let timeoutMs = 480_000;
  let maxTurns: number | null = null;
  let permissionMode: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prompt" && argv[i + 1]) { prompt = argv[++i]; }
    else if (argv[i] === "--case-id" && argv[i + 1]) { caseId = argv[++i]; }
    else if (argv[i] === "--model" && argv[i + 1]) { model = argv[++i]; }
    else if (argv[i] === "--timeout" && argv[i + 1]) { timeoutMs = parseInt(argv[++i], 10) || timeoutMs; }
    else if (argv[i] === "--max-turns" && argv[i + 1]) { maxTurns = parseInt(argv[++i], 10) || null; }
    else if (argv[i] === "--permission-mode" && argv[i + 1]) { permissionMode = argv[++i]; }
  }

  return { prompt, caseId, model, timeoutMs, maxTurns, permissionMode };
}

interface ParsedStdout {
  text: string;
  sessionId: string | null;
  trajectoryPath: string | null;
  /**
   * abort/error 标记：parseStdoutJson 检测到 stdout JSON 结构异常时置 true。
   * 异常包含但不限于：content 仅含 tool_use 而无 text block、error.aborted=true、
   * RequestAbortedError、被 SIGTERM 后子进程 dump 的部分状态。
   * wrapper 主流程看到 abnormal=true 时返回 error，避免把"工具调用中间态 JSON"
   * 作为最终答案丢给评测层（会触发 anchor 偶然命中、rubric 给 0 等假数据）。
   */
  abnormal: boolean;
  abnormalReason?: string;
}

function parseStdoutJson(stdout: string): ParsedStdout {
  const trimmed = stdout.trim();
  const empty: ParsedStdout = { text: "", sessionId: null, trajectoryPath: null, abnormal: false };
  if (!trimmed) return empty;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch {
        // 整段都不是合法 JSON：直接当 abnormal（不再 fallback "把字符串当 text"，
        // 那会让 anchor_hit 偶然命中关键字给假高分）
        return { ...empty, abnormal: true, abnormalReason: "stdout 非合法 JSON" };
      }
    }
  }
  if (!parsed) return { ...empty, abnormal: true, abnormalReason: "stdout 解析失败" };

  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
  const trajectoryPath = typeof parsed.trajectory_path === "string" ? parsed.trajectory_path : null;

  // 检测 error 字段（abort / RequestAborted / 子进程被 SIGTERM 时 sid-code 会把
  // 部分 turn 状态写到 stdout，里面带 error 块）。这种情况 content 里通常只有
  // tool_use 而没有最终 text block，绝对不能当成功输出。
  const errBlock = parsed.error;
  if (errBlock && typeof errBlock === "object") {
    const msg = (errBlock as Record<string, unknown>).message;
    return {
      text: "",
      sessionId,
      trajectoryPath,
      abnormal: true,
      abnormalReason: `stdout JSON 含 error: ${typeof msg === "string" ? msg.slice(0, 100) : JSON.stringify(errBlock).slice(0, 100)}`,
    };
  }

  let text = "";
  let hasToolUse = false;
  const content = parsed.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") text += (text ? "\n" : "") + b.text;
      else if (b.type === "tool_use") hasToolUse = true;
    }
  } else if (typeof content === "string") {
    text = content;
  }

  // content 里只有 tool_use 没有 text → 子进程在工具调用中途被 abort。abnormal=true。
  if (hasToolUse && !text) {
    return {
      text: "",
      sessionId,
      trajectoryPath,
      abnormal: true,
      abnormalReason: "stdout 仅含 tool_use 块，无最终 text 输出（子进程在工具调用中途 abort）",
    };
  }

  // 没有 text 也没有 content → 不正常（不再 fallback 用 trimmed 充当 text）
  if (!text) {
    return {
      text: "",
      sessionId,
      trajectoryPath,
      abnormal: true,
      abnormalReason: "stdout JSON 无 text 内容",
    };
  }

  return { text, sessionId, trajectoryPath, abnormal: false };
}

export interface TrajMeta {
  toolsUsed: string[];
  filesEdited: string[];
  totalSteps: number;
  exitStatus: string | null;
  totalCostUsd: number;
  totalTokens: number;
}

export function readTrajectoryMeta(trajPath: string | null): TrajMeta {
  const empty: TrajMeta = { toolsUsed: [], filesEdited: [], totalSteps: 0, exitStatus: null, totalCostUsd: 0, totalTokens: 0 };
  if (!trajPath || !existsSync(trajPath)) return empty;
  try {
    const obj = JSON.parse(readFileSync(trajPath, "utf-8"));
    const md = obj?.metadata || {};
    return {
      toolsUsed: md.tools_used || [],
      filesEdited: md.files_edited || [],
      // total_steps = trajectory.length（含 observation），多工具 case 会翻倍。
      // 改用 total_api_calls（= LLM turn 数），与 claude-code wrapper 的 num_turns 语义对齐。
      totalSteps: md.total_api_calls ?? md.total_steps ?? 0,
      exitStatus: md.exit_status || null,
      totalCostUsd: md.total_cost_usd || 0,
      totalTokens: md.total_tokens || 0,
    };
  } catch {
    return empty;
  }
}

function readRawTokens(trajPath: string | null): { total: number; breakdown: { input: number; output: number; cache_creation: number; cache_read: number } } {
  const empty = { total: 0, breakdown: { input: 0, output: 0, cache_creation: 0, cache_read: 0 } };
  if (!trajPath) return empty;
  const rawPath = join(trajPath, "..", "raw.jsonl");
  if (!existsSync(rawPath)) return empty;
  try {
    const lines = readFileSync(rawPath, "utf-8").trim().split("\n");
    // 每条 response.usage.input_tokens 是"本次 API 调用时的 prompt 总长度"（含整段历史），
    // 不是"本 turn 新增 input"。直接累加会 N² 级过计数（case_028 实测：
    // 29 条 record 累加 = 3.65M，但实际只是 167k → 22 倍虚高）。
    //
    // 正确口径：取最后一条 record 的 usage 作为最终累计快照。
    //   - input_tokens: 最后一次调用时 = 全部历史 prompt 总长度（已含所有累积）
    //   - output_tokens: 每次只是该 turn 的输出，需要累加
    //   - cache_creation / cache_read: 同 output，每次新增，需要累加
    //
    // 校准已确认（2026-05-25）：与 claude CLI 的 result.usage 口径一致。
    // 实验：case_028 用 claude-opus-4-7 跑出 result.usage = i:3053 o:6828 cc:173k cr:233k
    //   — i 是最后一次 API 调用的输入总量；o/cc/cr 是所有 turn 的累加。
    let lastInput = 0;
    let output = 0, cc = 0, cr = 0;
    for (const line of lines) {
      const usage = JSON.parse(line)?.response?.usage;
      if (usage) {
        lastInput = usage.input_tokens || 0; // 覆盖：取最后一次即可
        output += usage.output_tokens || 0;
        cc += usage.cache_creation_input_tokens || 0;
        cr += usage.cache_read_input_tokens || 0;
      }
    }
    return {
      total: lastInput + output + cc + cr,
      breakdown: { input: lastInput, output, cache_creation: cc, cache_read: cr },
    };
  } catch {
    return empty;
  }
}

function analyzeTrajectorySignals(trajPath: string | null): {
  errorCount: number; retryCount: number; backtrackCount: number;
} {
  const empty = { errorCount: 0, retryCount: 0, backtrackCount: 0 };
  if (!trajPath || !existsSync(trajPath)) return empty;
  try {
    const traj = JSON.parse(readFileSync(trajPath, "utf-8"));
    const steps = traj.trajectory || [];
    let errorCount = 0, retryCount = 0, backtrackCount = 0;
    const editedFiles = new Map<string, number>();
    let prevToolName = "";
    let prevToolInput = "";

    for (const step of steps) {
      if (step.is_error) errorCount++;
      const toolInput = JSON.stringify(step.tool_input || {});
      if (step.tool_name === prevToolName && toolInput === prevToolInput) retryCount++;
      prevToolName = step.tool_name || "";
      prevToolInput = toolInput;

      if (step.tool_name === "write" || step.tool_name === "edit") {
        const file = step.tool_input?.file_path || step.tool_input?.path || "";
        if (file) {
          const count = (editedFiles.get(file) || 0) + 1;
          editedFiles.set(file, count);
          if (count > 1) backtrackCount++;
        }
      }
    }
    return { errorCount, retryCount, backtrackCount };
  } catch {
    return empty;
  }
}

/**
 * 判断 stdout 是否已收到"最终答案 JSON"（不是中间态）。
 *
 * sid-code 在 -p json 模式下，工具调用 abort 时也可能把"部分 turn 状态" JSON dump 到 stdout，
 * 那段 JSON 里 content 数组只有 tool_use、没有 text block，并且通常带 error 字段。
 * 旧实现"只要是 valid JSON 就 SIGTERM 子进程"会让中间态被错误地视为最终答案
 * （case_027 实测：abort 后 666B JSON 被当成功，wrapper 把整段 JSON 当 text 返回 →
 *  anchor 偶然命中关键字给假高分）。
 *
 * 改成要求 JSON 里有 content[*].type==='text' && text 非空才认完整。
 * 注意：error 字段也是终止信号（已 abort），但不应判为"成功完整"。
 */
function tryExtractCompleteJson(buf: string): boolean {
  const trimmed = buf.trim();
  if (!trimmed.startsWith("{")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;

  // 含 error → 已 abort，不算"成功完整"（让 timer / 子进程自然退出兜底）
  if (obj.error && typeof obj.error === "object") return false;

  const content = obj.content;
  if (typeof content === "string" && content.length > 0) return true;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) {
        return true;
      }
    }
  }
  return false;
}

async function main() {
  const { prompt, caseId, model, timeoutMs, maxTurns, permissionMode } = parseArgs();

  if (!prompt) {
    process.stdout.write(JSON.stringify({ output: "[ERROR] empty prompt", meta: {}, error: true }) + "\n");
    process.exit(1);
  }

  const args = ["run", ENTRYPOINT, "-p", "--output-format", "json", "--trace-upload-disabled"];
  if (model) args.push("--model", model);
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  if (permissionMode) args.push("--permission-mode", permissionMode);
  args.push(prompt);

  const startedAt = Date.now();
  process.stderr.write(`[sid-code-live] spawn: bun ${args.slice(0, 5).join(" ")} ... (prompt ${prompt.length} chars, case=${caseId})\n`);

  const child = spawn("bun", args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // 评测隔离：禁用项目 CLAUDE.md 加载（含 JIT 发现），避免目录结构描述泄露成 case 锚点答案
      // 例：CLAUDE.md 第 277 行写 "AgentLoopRunner"，不隔离会让 case_001 的 anchor 虚高
      SID_CODE_DISABLE_PROJECT_RULES: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let resolved = false;
  let resolveMain: (code: number | null) => void;

  const exitPromise = new Promise<number | null>((res) => { resolveMain = res; });

  child.stdout?.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    if (!resolved && tryExtractCompleteJson(stdoutBuf)) {
      resolved = true;
      process.stderr.write(`[sid-code-live] stdout JSON complete (${stdoutBuf.length}B), trajectory已落盘 (SessionEnd 先于 stdout)\n`);
      // app.ts 已经在打印 stdout 之前 await 完 SessionEnd，trajectory 已完整落盘。
      // 这里给 1s 让进程自然退出，否则强杀。不会丢 trajectory 数据。
      setTimeout(() => {
        if (!child.killed) {
          process.stderr.write(`[sid-code-live] kill child after JSON received\n`);
          child.kill("SIGTERM");
          setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
        }
      }, 1000);
    }
  });
  child.stderr?.on("data", (chunk) => { stderrBuf += chunk.toString(); });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.stderr.write(`[sid-code-live] TIMEOUT after ${timeoutMs}ms, SIGTERM\n`);
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
  }, timeoutMs);

  child.on("close", (code) => resolveMain(code));
  child.on("error", () => resolveMain(null));

  const exitCode = await exitPromise;
  clearTimeout(timer);

  const elapsedMs = Date.now() - startedAt;
  const parsed = parseStdoutJson(stdoutBuf);
  // ⚠️ trajectory 必须从 stdout JSON 的 trajectory_path 字段拿到——
  // 严禁回退到 mtime / 文件系统扫描（如 bench-runner/adapters 里的 findLatestSessionDir）。
  // 原因：retry 场景下 mtime 会拿到上一次失败 attempt 留下的 session 目录，污染 trajectory metadata。
  // 当前路径下不可能复用旧 session：sid-code 每次 spawn 都新建 session id，
  // trajectory_path 由本次进程显式写在 stdout JSON 里，丢失就是真的丢失，应作 error 处理而非猜。
  const trajPath = parsed.trajectoryPath;
  const meta = readTrajectoryMeta(trajPath);
  const rawTokensInfo = readRawTokens(trajPath);
  const rawTokens = rawTokensInfo.total;
  const trajSignals = analyzeTrajectorySignals(trajPath);

  const totalTokens = rawTokens || meta.totalTokens;

  const metaOut = {
    tools_used: meta.toolsUsed,
    files_edited: meta.filesEdited,
    total_steps: meta.totalSteps,
    total_tokens: totalTokens,
    // token_breakdown 让 eval-judge 的 gradeCost 按 cache_read 折算，
    // 横向对比时让 sid-code（无 cache）和 claude-code（重 cache）公平对比。
    // 没读到 raw.jsonl 时是 0/0/0/0，gradeCost 会退化为按 total_tokens 评。
    token_breakdown: rawTokensInfo.breakdown,
    latency_ms: elapsedMs,
    exit_status: meta.exitStatus || (timedOut ? "timeout" : exitCode === 0 ? "success" : "error"),
    error_count: trajSignals.errorCount,
    retry_count: trajSignals.retryCount,
    backtrack_count: trajSignals.backtrackCount,
    session_id: parsed.sessionId,
    trajectory_path: trajPath,
  };

  process.stderr.write(
    `[sid-code-live] exit=${exitCode} timedOut=${timedOut} elapsed=${elapsedMs}ms `
    + `stdout=${stdoutBuf.length}B stderr=${stderrBuf.length}B `
    + `session=${parsed.sessionId || "missing"} `
    + `tools=${meta.toolsUsed.join(",")} steps=${meta.totalSteps} `
    + `tokens=${totalTokens} errors=${trajSignals.errorCount}\n`
  );

  // 校准诊断（2026-05-25 起，配对 claude-code wrapper 同名日志）：
  // input 是最后一次 API 调用的 prompt 总长度（含历史），output/cc/cr 是各 turn 累加。
  // 与 claude CLI result.usage 同语义。
  if (rawTokens > 0) {
    process.stderr.write(
      `[sid-code-live calibration] raw.jsonl 末次 i（含全历史）+ 累加 o/cc/cr（${meta.totalSteps} turn）: `
      + `i=${rawTokensInfo.breakdown.input} o=${rawTokensInfo.breakdown.output} `
      + `cc=${rawTokensInfo.breakdown.cache_creation} cr=${rawTokensInfo.breakdown.cache_read} `
      + `4sum=${rawTokens}\n`
    );
  }

  // abnormal 优先：stdout JSON 结构异常（abort / 仅 tool_use / 解析失败）
  // 立即返回 error，不再继续 anchor / rubric 流程（避免假数据）
  if (parsed.abnormal) {
    process.stdout.write(JSON.stringify({
      output: `[ERROR] sid-code-live stdout abnormal: ${parsed.abnormalReason ?? "unknown"}`,
      meta: { ...metaOut, exit_status: "abnormal_stdout" },
      error: true,
    }) + "\n");
    process.exit(0);
  }

  if (parsed.text) {
    // 健康检查：拿到 sessionId 但 trajectory_path 缺失/不存在 → 视为 error，避免上层用空 metadata 评分
    // （这也是 retry 隔离的最后一道防线：本次 attempt 的 trajectory 必须由本次 spawn 写出，
    //  缺失就让 runner 看到 error，不要 silent fallback）
    if (parsed.sessionId && (!trajPath || !existsSync(trajPath))) {
      process.stdout.write(JSON.stringify({
        output: `[ERROR] sid-code-live trajectory_path missing or not exist: session=${parsed.sessionId} path=${trajPath ?? "null"}`,
        meta: metaOut,
        error: true,
      }) + "\n");
      process.exit(0);
    }

    // B6-5：trace.json 落盘（AgentTrace v1 格式）
    // 条件：raw.jsonl 存在 + sessionId 有效；失败不阻塞主流程（best-effort）
    if (trajPath && parsed.sessionId) {
      const rawJsonlPath = join(trajPath, "..", "raw.jsonl");
      if (existsSync(rawJsonlPath)) {
        try {
          const rawText = readFileSync(rawJsonlPath, "utf-8");
          // sid-code 用短码 session ID（8 字符），trace schema §5-1 要求 UUID v4。
          // 用短码 pad 成合法 UUID 保持可追溯性。
          const sid = parsed.sessionId;
          const padded = sid.padEnd(32, "0");
          const uuidFromSid = `${padded.slice(0,8)}-${padded.slice(8,12)}-4${padded.slice(13,16)}-a${padded.slice(17,20)}-${padded.slice(20,32)}`;
          const trace = convertRawJsonlToTrace(rawText, {
            session_id: uuidFromSid,
            case_id: caseId !== "unknown" ? caseId : undefined,
            agent_kind: "sid-code",
            agent_version: "live",
            provider: model || "deepseek-v4-pro",
            trace_id: uuidFromSid,
          });
          const validation = validateTrace(trace);
          if (validation.ok) {
            const traceOutPath = join(trajPath, "..", "trace.json");
            writeFileSync(traceOutPath, JSON.stringify(trace, null, 2), "utf-8");
          }
        } catch {
          // best-effort: trace 落盘失败不影响评测主流程
        }
      }
    }

    process.stdout.write(JSON.stringify({ output: parsed.text, meta: metaOut }) + "\n");
    process.exit(0);
  }

  if (timedOut) {
    process.stdout.write(JSON.stringify({ output: `[ERROR] sid-code-live TIMEOUT after ${timeoutMs}ms`, meta: metaOut, error: true }) + "\n");
    process.exit(0);
  }
  if (exitCode !== 0 && exitCode !== null) {
    process.stdout.write(JSON.stringify({ output: `[ERROR] sid-code-live exit=${exitCode}\nstderr tail:\n${stderrBuf.slice(-800)}`, meta: metaOut, error: true }) + "\n");
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({ output: "[ERROR] empty output from sid-code-live", meta: metaOut, error: true }) + "\n");
}

if (import.meta.main) {
  main().catch((err) => {
    process.stdout.write(JSON.stringify({ output: `[ERROR] sid-code-live wrapper crash: ${err?.message || err}`, meta: {}, error: true }) + "\n");
    process.exit(0);
  });
}
