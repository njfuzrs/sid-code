#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

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
}

function parseStdoutJson(stdout: string): ParsedStdout {
  const trimmed = stdout.trim();
  const empty: ParsedStdout = { text: "", sessionId: null, trajectoryPath: null };
  if (!trimmed) return empty;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch { return { ...empty, text: trimmed }; }
    }
  }
  if (!parsed) return { ...empty, text: trimmed };

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
  return { text: text || trimmed, sessionId, trajectoryPath };
}

interface TrajMeta {
  toolsUsed: string[];
  filesEdited: string[];
  totalSteps: number;
  exitStatus: string | null;
  totalCostUsd: number;
  totalTokens: number;
}

function readTrajectoryMeta(trajPath: string | null): TrajMeta {
  const empty: TrajMeta = { toolsUsed: [], filesEdited: [], totalSteps: 0, exitStatus: null, totalCostUsd: 0, totalTokens: 0 };
  if (!trajPath || !existsSync(trajPath)) return empty;
  try {
    const obj = JSON.parse(readFileSync(trajPath, "utf-8"));
    const md = obj?.metadata || {};
    return {
      toolsUsed: md.tools_used || [],
      filesEdited: md.files_edited || [],
      totalSteps: md.total_steps || 0,
      exitStatus: md.exit_status || null,
      totalCostUsd: md.total_cost_usd || 0,
      totalTokens: md.total_tokens || 0,
    };
  } catch {
    return empty;
  }
}

function readRawTokens(trajPath: string | null): number {
  if (!trajPath) return 0;
  const rawPath = join(trajPath, "..", "raw.jsonl");
  if (!existsSync(rawPath)) return 0;
  try {
    const lines = readFileSync(rawPath, "utf-8").trim().split("\n");
    let tokens = 0;
    for (const line of lines) {
      const usage = JSON.parse(line)?.response?.usage;
      if (usage) tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
    }
    return tokens;
  } catch {
    return 0;
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
    env: { ...process.env },
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
  const trajPath = parsed.trajectoryPath;
  const meta = readTrajectoryMeta(trajPath);
  const rawTokens = readRawTokens(trajPath);
  const trajSignals = analyzeTrajectorySignals(trajPath);

  const totalTokens = rawTokens || meta.totalTokens;

  const metaOut = {
    tools_used: meta.toolsUsed,
    files_edited: meta.filesEdited,
    total_steps: meta.totalSteps,
    total_tokens: totalTokens,
    latency_ms: elapsedMs,
    exit_status: meta.exitStatus || (timedOut ? "timeout" : exitCode === 0 ? "success" : "error"),
    error_count: trajSignals.errorCount,
    retry_count: trajSignals.retryCount,
    backtrack_count: trajSignals.backtrackCount,
    session_id: parsed.sessionId,
  };

  process.stderr.write(
    `[sid-code-live] exit=${exitCode} timedOut=${timedOut} elapsed=${elapsedMs}ms `
    + `stdout=${stdoutBuf.length}B stderr=${stderrBuf.length}B `
    + `session=${parsed.sessionId || "missing"} `
    + `tools=${meta.toolsUsed.join(",")} steps=${meta.totalSteps} `
    + `tokens=${totalTokens} errors=${trajSignals.errorCount}\n`
  );

  if (parsed.text) {
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

main().catch((err) => {
  process.stdout.write(JSON.stringify({ output: `[ERROR] sid-code-live wrapper crash: ${err?.message || err}`, meta: {}, error: true }) + "\n");
  process.exit(0);
});
