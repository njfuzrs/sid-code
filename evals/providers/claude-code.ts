#!/usr/bin/env bun

import { spawn } from "node:child_process";

function parseArgs(): { prompt: string; caseId: string; model: string | null; timeoutMs: number; maxTurns: number | null; skipPermissions: boolean; cliPath: string } {
  const argv = process.argv.slice(2);
  let prompt = "";
  let caseId = "unknown";
  let model: string | null = null;
  let timeoutMs = 360_000;
  let maxTurns: number | null = null;
  let skipPermissions = true;
  let cliPath = "claude";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prompt" && argv[i + 1]) { prompt = argv[++i]; }
    else if (argv[i] === "--case-id" && argv[i + 1]) { caseId = argv[++i]; }
    else if (argv[i] === "--model" && argv[i + 1]) { model = argv[++i]; }
    else if (argv[i] === "--timeout" && argv[i + 1]) { timeoutMs = parseInt(argv[++i], 10) || timeoutMs; }
    else if (argv[i] === "--max-turns" && argv[i + 1]) { maxTurns = parseInt(argv[++i], 10) || null; }
    else if (argv[i] === "--skip-permissions") { skipPermissions = true; }
    else if (argv[i] === "--no-skip-permissions") { skipPermissions = false; }
    else if (argv[i] === "--cli-path" && argv[i + 1]) { cliPath = argv[++i]; }
  }

  return { prompt, caseId, model, timeoutMs, maxTurns, skipPermissions, cliPath };
}

function extractResult(obj: Record<string, unknown> | null): string {
  if (!obj) return "";
  if (typeof obj.result === "string") return obj.result;
  if (Array.isArray(obj.content)) {
    return (obj.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("\n");
  }
  return "";
}

function parseFinal(stdout: string): { text: string; numTurns: number; totalCostUsd: number } {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "", numTurns: 0, totalCostUsd: 0 };
  try {
    if (trimmed.startsWith("{")) {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      return {
        text: extractResult(obj),
        numTurns: (obj.num_turns as number) || 0,
        totalCostUsd: (obj.total_cost_usd as number) || 0,
      };
    }
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed) as Array<Record<string, unknown>>;
      return {
        text: arr.map(extractResult).filter(Boolean).join("\n"),
        numTurns: arr.length,
        totalCostUsd: 0,
      };
    }
  } catch {
    // fall through
  }
  return { text: trimmed, numTurns: 0, totalCostUsd: 0 };
}

async function main() {
  const { prompt, caseId, model, timeoutMs, maxTurns, skipPermissions, cliPath } = parseArgs();

  if (!prompt) {
    process.stdout.write(JSON.stringify({ output: "[ERROR] empty prompt", meta: {}, error: true }) + "\n");
    process.exit(1);
  }

  const args: string[] = ["-p", "--output-format", "json"];
  if (model) args.push("--model", model);
  if (skipPermissions) args.push("--dangerously-skip-permissions");
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  args.push(prompt);

  const startedAt = Date.now();
  process.stderr.write(`[claude-code] spawn: ${cliPath} ${args.slice(0, 5).join(" ")} ... (prompt ${prompt.length} chars, case=${caseId})\n`);

  const child = spawn(cliPath, args, {
    env: {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.stderr.write(`[claude-code] TIMEOUT after ${timeoutMs}ms\n`);
    child.kill("SIGTERM");
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 3000);
  }, timeoutMs);

  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout?.on("data", (c) => { stdoutBuf += c.toString(); });
  child.stderr?.on("data", (c) => { stderrBuf += c.toString(); });

  const exitCode: number | null = await new Promise((res) => {
    child.on("close", (code) => res(code));
    child.on("error", () => res(null));
  });
  clearTimeout(timer);

  const elapsedMs = Date.now() - startedAt;
  const { text, numTurns, totalCostUsd } = parseFinal(stdoutBuf);

  const metaOut = {
    tools_used: [],
    files_edited: [],
    total_steps: numTurns,
    total_tokens: 0,
    latency_ms: elapsedMs,
    exit_status: timedOut ? "timeout" : exitCode === 0 ? "success" : "error",
    error_count: 0,
    retry_count: 0,
    backtrack_count: 0,
    total_cost_usd: totalCostUsd,
  };

  process.stderr.write(
    `[claude-code] exit=${exitCode} timedOut=${timedOut} elapsed=${elapsedMs}ms `
    + `stdout=${stdoutBuf.length}B numTurns=${numTurns}\n`
  );

  if (timedOut) {
    process.stdout.write(JSON.stringify({ output: `[ERROR] claude-code TIMEOUT after ${timeoutMs}ms`, meta: metaOut, error: true }) + "\n");
    process.exit(0);
  }
  if (exitCode !== 0) {
    process.stdout.write(JSON.stringify({ output: `[ERROR] claude-code exit=${exitCode}\nstderr tail:\n${stderrBuf.slice(-800)}`, meta: metaOut, error: true }) + "\n");
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({ output: text || "[ERROR] empty output from claude-code", meta: metaOut, error: !text }) + "\n");
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ output: `[ERROR] claude-code wrapper crash: ${err?.message || err}`, meta: {}, error: true }) + "\n");
  process.exit(0);
});
