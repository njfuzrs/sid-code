#!/usr/bin/env bun
/**
 * promptfoo exec provider: sid-code-live
 *
 * 用法(promptfooconfig.yaml):
 *   - id: 'exec:bun run providers/sid-code-live.ts'
 *     label: sid-code-live
 *     config:
 *       model: claude-opus-4-7   # 可选
 *       timeoutMs: 360000        # 可选
 *       maxTurns: 30             # 可选
 *
 * promptfoo 调用约定:
 *   $1 = 已渲染的 prompt 字符串
 *   $2 = JSON.stringify(providerConfig)
 *   $3 = JSON.stringify(context)  // 含 vars / test metadata
 *
 * 输出: 纯文本到 stdout(promptfoo 把整段 stdout 当成 model output)
 *       metadata 通过 sideband 文件传递给 javascript 断言
 */

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const ENTRYPOINT = join(REPO_ROOT, "src/entrypoints/bootstrap.ts");
const TRAJ_DIR = process.env.SID_CODE_TRAJECTORIES_DIR
  || join(homedir(), ".sid-code/trajectories");
const METADATA_DIR = join(import.meta.dir, "../.eval-metadata");

interface ProviderConfig {
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  permissionMode?: string;
  providerKey?: string;
}

function parseConfig(raw: string | undefined): ProviderConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    // promptfoo exec provider 传入的 $2 是 { id, config: {...}, env: {} }
    // 实际 config 字段在 parsed.config 中
    if (parsed.config && typeof parsed.config === "object") {
      return parsed.config as ProviderConfig;
    }
    return parsed as ProviderConfig;
  } catch {
    return {};
  }
}

function parseContext(raw: string | undefined): { vars?: Record<string, unknown> } {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function findLatestSessionDir(sinceMs: number): string | null {
  const sessionsRoot = join(TRAJ_DIR, "sessions");
  if (!existsSync(sessionsRoot)) return null;
  let bestPath: string | null = null;
  let bestMtime = 0;
  for (const name of readdirSync(sessionsRoot)) {
    const dir = join(sessionsRoot, name);
    try {
      const s = statSync(dir);
      if (!s.isDirectory()) continue;
      const mtime = s.mtimeMs;
      if (mtime < sinceMs - 1000) continue;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestPath = dir;
      }
    } catch {
      continue;
    }
  }
  return bestPath;
}

/** 优先从 stdout JSON 里拿 session_id 解析路径，避免并发时按 mtime 找错目录 */
function extractSessionIdFromStdout(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed);
    const sid = obj?.session_id;
    return typeof sid === "string" && sid ? sid : null;
  } catch {
    // stdout 可能含其他文本，尝试从最后一个 JSON 对象抽取
    const m = trimmed.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        const sid = obj?.session_id;
        return typeof sid === "string" && sid ? sid : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 等 session.traj 写入完成（最多等 maxWaitMs），避免 wrapper 提前 SIGTERM 后读到空文件 */
function waitForTrajWritten(sessionDir: string | null, maxWaitMs: number): void {
  if (!sessionDir) return;
  const trajPath = join(sessionDir, "session.traj");
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (existsSync(trajPath)) {
      try {
        const content = readFileSync(trajPath, "utf-8");
        const obj = JSON.parse(content);
        // 检查 metadata 是否已写入（exit_status 在 SessionEnd 时设置）
        if (obj?.metadata?.exit_status || (obj?.metadata?.total_steps ?? 0) > 0) {
          return;
        }
      } catch {
        // 写入中可能 JSON 不完整，继续等
      }
    }
    // busy-wait 50ms
    const start = Date.now();
    while (Date.now() - start < 50) { /* spin */ }
  }
}

function parseFinalText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  let parsed: { content?: unknown } | null = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return trimmed;
      }
    }
  }
  if (!parsed) return trimmed;
  const content = parsed.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
    return parts.join("\n");
  }
  if (typeof content === "string") return content;
  return trimmed;
}

function readTrajectoryMeta(sessionDir: string | null): {
  toolsUsed: string[];
  filesEdited: string[];
  totalSteps: number;
  exitStatus: string | null;
  totalCostUsd: number;
  totalTokens: number;
} {
  const empty = { toolsUsed: [], filesEdited: [], totalSteps: 0, exitStatus: null, totalCostUsd: 0, totalTokens: 0 };
  if (!sessionDir) return empty;

  // efficiency 维度按"LLM turn 数"打分（与 claude-code wrapper num_turns 语义对齐）。
  // session.traj 的 total_steps = trajectory.length（action + observation 总和），
  // 在多工具循环 case 会翻倍膨胀（如 case_005 一次循环 33 步实际只有 ~16 个 turn）。
  // 必须用 total_api_calls（= turn 数）才能让 gradeEfficiency 公平判分。
  const metaSnapshot = join(sessionDir, "metadata.json");
  if (existsSync(metaSnapshot)) {
    try {
      const md = JSON.parse(readFileSync(metaSnapshot, "utf-8"));
      return {
        toolsUsed: md.tools_used || [],
        filesEdited: md.files_edited || [],
        totalSteps: md.total_api_calls ?? md.total_steps ?? 0,
        exitStatus: md.exit_status || null,
        totalCostUsd: md.total_cost_usd || 0,
        totalTokens: md.total_tokens || 0,
      };
    } catch { /* fallthrough to session.traj */ }
  }

  const trajPath = join(sessionDir, "session.traj");
  if (!existsSync(trajPath)) return empty;
  try {
    const content = readFileSync(trajPath, "utf-8");
    const obj = JSON.parse(content);
    const md = obj?.metadata || {};
    return {
      toolsUsed: md.tools_used || [],
      filesEdited: md.files_edited || [],
      totalSteps: md.total_api_calls ?? md.total_steps ?? 0,
      exitStatus: md.exit_status || null,
      totalCostUsd: md.total_cost_usd || 0,
      totalTokens: md.total_tokens || 0,
    };
  } catch {
    return empty;
  }
}

function readRawMeta(sessionDir: string | null): { totalTokens: number; totalCost: number } {
  if (!sessionDir) return { totalTokens: 0, totalCost: 0 };
  const rawPath = join(sessionDir, "raw.jsonl");
  if (!existsSync(rawPath)) return { totalTokens: 0, totalCost: 0 };
  try {
    const lines = readFileSync(rawPath, "utf-8").trim().split("\n");
    let tokens = 0;
    for (const line of lines) {
      const entry = JSON.parse(line);
      const usage = entry.response?.usage;
      if (usage) {
        tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
      }
    }
    return { totalTokens: tokens, totalCost: 0 };
  } catch {
    return { totalTokens: 0, totalCost: 0 };
  }
}

function analyzeTrajectorySignals(sessionDir: string | null): {
  errorCount: number; retryCount: number; backtrackCount: number;
} {
  const empty = { errorCount: 0, retryCount: 0, backtrackCount: 0 };
  if (!sessionDir) return empty;
  const trajPath = join(sessionDir, "session.traj");
  if (!existsSync(trajPath)) return empty;
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
      if (step.tool_name === prevToolName && toolInput === prevToolInput) {
        retryCount++;
      }
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

function writeMetadataSideband(caseId: string, providerLabel: string, metadata: Record<string, unknown>) {
  try {
    mkdirSync(METADATA_DIR, { recursive: true });
    // 标准化 label：与 promptfoo 断言中 context.provider.label 的 normalize 逻辑一致
    const normalizedLabel = providerLabel.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");
    const filename = `${caseId}__${normalizedLabel}.json`;
    writeFileSync(join(METADATA_DIR, filename), JSON.stringify(metadata, null, 2));
  } catch (err) {
    process.stderr.write(`[sid-code-live] failed to write metadata sideband: ${err}\n`);
  }
}

/**
 * 尝试从 stdout buffer 中提取完整 JSON 对象。
 */
function tryExtractCompleteJson(buf: string): boolean {
  const trimmed = buf.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const prompt = process.argv[2] || "";
  const configRaw = process.argv[3];
  const contextRaw = process.argv[4];
  const config = parseConfig(configRaw);
  const ctx = parseContext(contextRaw);
  const caseId = (ctx.vars?.case_id as string) || "unknown";

  if (!prompt) {
    console.error("[sid-code-live] empty prompt, exit 1");
    process.exit(1);
  }

  const timeoutMs = config.timeoutMs ?? 360_000;
  const args = ["run", ENTRYPOINT, "-p", "--output-format", "json"];
  if (config.model) args.push("--model", config.model);
  if (config.maxTurns) args.push("--max-turns", String(config.maxTurns));
  if (config.permissionMode) args.push("--permission-mode", config.permissionMode);
  args.push(prompt);

  const startedAt = Date.now();
  process.stderr.write(`[sid-code-live] spawn: bun ${args.slice(0, 5).join(" ")} ... (prompt ${prompt.length} chars, case=${caseId})\n`);

  const child = spawn("bun", args, {
    cwd: REPO_ROOT,
    env: { ...process.env, SID_CODE_HEADLESS: "1" },
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
      // stdout JSON 完整后等 5s graceful exit：给 SessionEnd hook + trajectory 重建留够时间
      // 之前 2s 不够 → trace 写一半被 kill → sideband metadata 为空 → tool_compliance 卡 0.6
      process.stderr.write(`[sid-code-live] stdout JSON complete (${stdoutBuf.length}B), waiting 5s for graceful exit...\n`);
      setTimeout(() => {
        if (!child.killed) {
          process.stderr.write(`[sid-code-live] force kill after JSON received\n`);
          child.kill("SIGTERM");
          setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
        }
      }, 5000);
    }
  });
  child.stderr?.on("data", (chunk) => { stderrBuf += chunk.toString(); });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.stderr.write(`[sid-code-live] TIMEOUT after ${timeoutMs}ms, SIGTERM\n`);
    child.kill("SIGTERM");
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 3000);
  }, timeoutMs);

  child.on("close", (code) => resolveMain(code));
  child.on("error", () => resolveMain(null));

  const exitCode = await exitPromise;
  clearTimeout(timer);

  const elapsedMs = Date.now() - startedAt;
  // 优先用 stdout JSON 里的 session_id 定位 trajectory（精确，不依赖 mtime）
  // fallback 才用 mtime 扫描——主要给极端异常情况（stdout 没出 JSON）兜底
  const sessionIdFromStdout = extractSessionIdFromStdout(stdoutBuf);
  let sessionDir: string | null = null;
  if (sessionIdFromStdout) {
    const candidate = join(TRAJ_DIR, "sessions", sessionIdFromStdout);
    if (existsSync(candidate)) sessionDir = candidate;
  }
  if (!sessionDir) {
    sessionDir = findLatestSessionDir(startedAt);
  }
  // 等 SessionEnd hook 把 metadata 落盘（避免读到 partial trajectory，导致 tools_used=[] 误扣分）
  // 这是 case_002/005 等评分卡在 0.6 的根因之一：sideband 读到的 metadata 是空的
  waitForTrajWritten(sessionDir, 5_000);

  const meta = readTrajectoryMeta(sessionDir);
  const rawMeta = readRawMeta(sessionDir);
  const trajSignals = analyzeTrajectorySignals(sessionDir);

  // token 优先从 raw.jsonl 取（更精确），fallback 到 session.traj metadata
  const totalTokens = rawMeta.totalTokens || meta.totalTokens;

  const metadata = {
    session_id: sessionDir?.split("/").pop() || null,
    total_steps: meta.totalSteps,
    tools_used: meta.toolsUsed,
    files_edited: meta.filesEdited,
    exit_status: meta.exitStatus,
    elapsed_ms: elapsedMs,
    total_tokens: totalTokens,
    total_cost_usd: meta.totalCostUsd,
    error_count: trajSignals.errorCount,
    retry_count: trajSignals.retryCount,
    backtrack_count: trajSignals.backtrackCount,
  };

  // 写入 sideband 文件供 javascript 断言读取
  writeMetadataSideband(caseId, config.providerKey || "sid_code_live", metadata);

  process.stderr.write(
    `[sid-code-live] exit=${exitCode} timedOut=${timedOut} elapsed=${elapsedMs}ms `
    + `stdout=${stdoutBuf.length}B stderr=${stderrBuf.length}B `
    + `session=${sessionDir ? sessionDir.split("/").pop() : "none"} `
    + `tools=${meta.toolsUsed.join(",")} steps=${meta.totalSteps} `
    + `tokens=${totalTokens} errors=${trajSignals.errorCount}\n`
  );

  // 即使超时/非零退出，如果已经拿到完整 JSON 输出，仍然提取结果
  if (tryExtractCompleteJson(stdoutBuf)) {
    const text = parseFinalText(stdoutBuf);
    if (text) {
      process.stdout.write(text);
      process.exit(0);
    }
  }

  if (timedOut) {
    console.log(`[ERROR] sid-code-live TIMEOUT after ${timeoutMs}ms`);
    process.exit(0);
  }
  if (exitCode !== 0 && exitCode !== null) {
    console.log(`[ERROR] sid-code-live exit=${exitCode}\nstderr tail:\n${stderrBuf.slice(-800)}`);
    process.exit(0);
  }

  const text = parseFinalText(stdoutBuf);
  process.stdout.write(text || "[ERROR] empty output from sid-code-live");
}

main().catch((err) => {
  console.log(`[ERROR] sid-code-live wrapper crash: ${err?.message || err}`);
  process.exit(0);
});
