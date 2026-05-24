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
  /** 是否收到 type=result 事件（健康检查：没收到说明输出被截断） */
  sawResult: boolean;
  /** 解析到的总事件数（用于诊断） */
  eventCount: number;
}

const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);

/**
 * 流式 stream-json 解析器：增量消费，避免单 stdout string 累加。
 * 状态机内部，每次喂一行 JSON 就更新内部状态。
 */
class StreamJsonParser {
  meta: StreamMeta = {
    text: "", toolsUsed: [], filesEdited: [], numTurns: 0, totalCostUsd: 0,
    totalTokens: 0, errorCount: 0, retryCount: 0, backtrackCount: 0,
    exitStatus: null, sawResult: false, eventCount: 0,
  };
  private toolsSeen = new Set<string>();
  private filesEdited = new Set<string>();
  private editCount = new Map<string, number>();
  private finalTextParts: string[] = [];
  private lastTool = "";
  private lastInput = "";

  feed(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let evt: Record<string, unknown>;
    try { evt = JSON.parse(trimmed); } catch { return; }

    this.meta.eventCount++;

    if (evt.type === "assistant" && evt.message && typeof evt.message === "object") {
      const msg = evt.message as Record<string, unknown>;
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            this.finalTextParts.push(b.text);
          } else if (b.type === "tool_use" && typeof b.name === "string") {
            this.toolsSeen.add(b.name);
            const inp = (b.input as Record<string, unknown>) || {};
            const inpStr = JSON.stringify(inp);
            if (b.name === this.lastTool && inpStr === this.lastInput) this.meta.retryCount++;
            this.lastTool = b.name;
            this.lastInput = inpStr;

            if (FILE_WRITE_TOOLS.has(b.name)) {
              const fp = (inp.file_path || inp.notebook_path || inp.path) as string | undefined;
              if (fp) {
                this.filesEdited.add(fp);
                const n = (this.editCount.get(fp) || 0) + 1;
                this.editCount.set(fp, n);
                if (n > 1) this.meta.backtrackCount++;
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
          if (b.type === "tool_result" && b.is_error === true) this.meta.errorCount++;
        }
      }
    } else if (evt.type === "result") {
      this.meta.sawResult = true;
      if (typeof evt.result === "string") this.meta.text = evt.result;
      this.meta.numTurns = (evt.num_turns as number) || 0;
      this.meta.totalCostUsd = (evt.total_cost_usd as number) || 0;
      const usage = evt.usage as Record<string, number> | undefined;
      if (usage) {
        this.meta.totalTokens = (usage.input_tokens || 0)
          + (usage.output_tokens || 0)
          + (usage.cache_creation_input_tokens || 0)
          + (usage.cache_read_input_tokens || 0);
      }
      if (evt.is_error === true || evt.subtype === "error") this.meta.exitStatus = "error";
      else if (evt.subtype === "success") this.meta.exitStatus = "success";
    }
  }

  finalize(): StreamMeta {
    this.meta.toolsUsed = [...this.toolsSeen];
    this.meta.filesEdited = [...this.filesEdited];
    if (!this.meta.text) this.meta.text = this.finalTextParts.join("\n");
    return this.meta;
  }
}

async function main() {
  const { prompt, caseId, model, timeoutMs, maxTurns, skipPermissions, cliPath } = parseArgs();

  if (!prompt) {
    process.stdout.write(JSON.stringify({ output: "[ERROR] empty prompt", meta: {}, error: true }) + "\n");
    process.exit(1);
  }

  // --verbose 是 claude CLI 强制要求（"--print + --output-format=stream-json requires --verbose"）
  // stream-json 模式才能拿到 tool_use 事件、files_edited、usage 等 trajectory metadata
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

  // 增量行解析：避免 stdout 累加成单个超长 string（高 max-turns case 输出会到几 MB）
  const parser = new StreamJsonParser();
  let stdoutPartial = "";
  let stdoutBytes = 0;
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    stdoutPartial += chunk.toString();
    let nl = stdoutPartial.indexOf("\n");
    while (nl !== -1) {
      parser.feed(stdoutPartial.slice(0, nl));
      stdoutPartial = stdoutPartial.slice(nl + 1);
      nl = stdoutPartial.indexOf("\n");
    }
  });
  // stderr 体积一般很小，保留累加以便 ERROR 时回显
  let stderrBuf = "";
  child.stderr?.on("data", (c) => { stderrBuf += c.toString(); });

  const exitCode: number | null = await new Promise((res) => {
    child.on("close", (code) => res(code));
    child.on("error", () => res(null));
  });
  clearTimeout(timer);

  // 喂剩余的最后一行（如果没有 trailing newline）
  if (stdoutPartial.trim()) parser.feed(stdoutPartial);
  const parsed = parser.finalize();

  const elapsedMs = Date.now() - startedAt;

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
    + `stdout=${stdoutBytes}B events=${parsed.eventCount} sawResult=${parsed.sawResult} `
    + `turns=${parsed.numTurns} tools=${parsed.toolsUsed.join(",")} errors=${parsed.errorCount}\n`
  );

  // 健康检查：exit=0 但没有 result 事件 → 说明输出在中途被截断/丢失，应当标 error
  if (!timedOut && exitCode === 0 && !parsed.sawResult) {
    process.stdout.write(JSON.stringify({
      output: `[ERROR] claude-code stream-json incomplete: no result event (events=${parsed.eventCount}, stdout=${stdoutBytes}B)`,
      meta: metaOut,
      error: true,
    }) + "\n");
    process.exit(0);
  }

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
