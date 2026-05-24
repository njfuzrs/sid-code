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

interface StreamMeta {
  text: string;
  toolsUsed: string[];
  filesEdited: string[];
  numTurns: number;
  totalCostUsd: number;
  totalTokens: number;
  errorCount: number;
  retryCount: number;
  backtrackCount: number;
  exitStatus: string | null;
}

// Edit / Write / NotebookEdit 等会修改文件的工具列表，files_edited 取这些工具的 file_path
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);

function parseStreamJson(stdout: string): StreamMeta {
  const empty: StreamMeta = {
    text: "", toolsUsed: [], filesEdited: [], numTurns: 0, totalCostUsd: 0,
    totalTokens: 0, errorCount: 0, retryCount: 0, backtrackCount: 0, exitStatus: null,
  };
  if (!stdout.trim()) return empty;

  // stream-json 每行一个 JSON 对象
  const lines = stdout.split("\n").filter(l => l.trim().startsWith("{"));
  const toolsSeen = new Set<string>();
  const filesEdited = new Set<string>();
  const editCount = new Map<string, number>();
  let lastTool = "";
  let lastInput = "";
  let retryCount = 0;
  let backtrackCount = 0;
  let errorCount = 0;
  let text = "";
  let numTurns = 0;
  let totalCostUsd = 0;
  let totalTokens = 0;
  let exitStatus: string | null = null;
  const finalTextParts: string[] = [];

  for (const line of lines) {
    let evt: Record<string, unknown>;
    try { evt = JSON.parse(line); } catch { continue; }

    if (evt.type === "assistant" && evt.message && typeof evt.message === "object") {
      const msg = evt.message as Record<string, unknown>;
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            finalTextParts.push(b.text);
          } else if (b.type === "tool_use" && typeof b.name === "string") {
            toolsSeen.add(b.name);
            const inp = (b.input as Record<string, unknown>) || {};
            const inpStr = JSON.stringify(inp);
            if (b.name === lastTool && inpStr === lastInput) retryCount++;
            lastTool = b.name;
            lastInput = inpStr;

            if (FILE_WRITE_TOOLS.has(b.name)) {
              const fp = (inp.file_path || inp.notebook_path || inp.path) as string | undefined;
              if (fp) {
                filesEdited.add(fp);
                const n = (editCount.get(fp) || 0) + 1;
                editCount.set(fp, n);
                if (n > 1) backtrackCount++;
              }
            }
          }
        }
      }
    } else if (evt.type === "user" && evt.message && typeof evt.message === "object") {
      const msg = evt.message as Record<string, unknown>;
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result" && b.is_error === true) errorCount++;
        }
      }
    } else if (evt.type === "result") {
      // 最后一行 result 包含完整 metadata
      if (typeof evt.result === "string") text = evt.result;
      numTurns = (evt.num_turns as number) || 0;
      totalCostUsd = (evt.total_cost_usd as number) || 0;
      const usage = evt.usage as Record<string, number> | undefined;
      if (usage) {
        totalTokens = (usage.input_tokens || 0)
          + (usage.output_tokens || 0)
          + (usage.cache_creation_input_tokens || 0)
          + (usage.cache_read_input_tokens || 0);
      }
      if (evt.is_error === true || evt.subtype === "error") exitStatus = "error";
      else if (evt.subtype === "success") exitStatus = "success";
    }
  }

  return {
    text: text || finalTextParts.join("\n"),
    toolsUsed: [...toolsSeen],
    filesEdited: [...filesEdited],
    numTurns,
    totalCostUsd,
    totalTokens,
    errorCount,
    retryCount,
    backtrackCount,
    exitStatus,
  };
}

async function main() {
  const { prompt, caseId, model, timeoutMs, maxTurns, skipPermissions, cliPath } = parseArgs();

  if (!prompt) {
    process.stdout.write(JSON.stringify({ output: "[ERROR] empty prompt", meta: {}, error: true }) + "\n");
    process.exit(1);
  }

  // 用 stream-json 才能拿到 tools_used / files_edited / errors（关键修复）
  // text/json 单结果输出格式丢失了所有中间事件
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
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
  const parsed = parseStreamJson(stdoutBuf);

  const metaOut = {
    tools_used: parsed.toolsUsed,
    files_edited: parsed.filesEdited,
    total_steps: parsed.numTurns,
    total_tokens: parsed.totalTokens,
    latency_ms: elapsedMs,
    exit_status: timedOut ? "timeout" : (parsed.exitStatus || (exitCode === 0 ? "success" : "error")),
    error_count: parsed.errorCount,
    retry_count: parsed.retryCount,
    backtrack_count: parsed.backtrackCount,
    total_cost_usd: parsed.totalCostUsd,
  };

  process.stderr.write(
    `[claude-code] exit=${exitCode} timedOut=${timedOut} elapsed=${elapsedMs}ms `
    + `stdout=${stdoutBuf.length}B turns=${parsed.numTurns} `
    + `tools=${parsed.toolsUsed.join(",")} errors=${parsed.errorCount}\n`
  );

  if (timedOut) {
    process.stdout.write(JSON.stringify({ output: `[ERROR] claude-code TIMEOUT after ${timeoutMs}ms`, meta: metaOut, error: true }) + "\n");
    process.exit(0);
  }
  if (exitCode !== 0) {
    process.stdout.write(JSON.stringify({ output: `[ERROR] claude-code exit=${exitCode}\nstderr tail:\n${stderrBuf.slice(-800)}`, meta: metaOut, error: true }) + "\n");
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({ output: parsed.text || "[ERROR] empty output from claude-code", meta: metaOut, error: !parsed.text }) + "\n");
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ output: `[ERROR] claude-code wrapper crash: ${err?.message || err}`, meta: {}, error: true }) + "\n");
  process.exit(0);
});
