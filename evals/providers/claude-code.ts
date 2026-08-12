#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  validateTrace,
  type AgentTrace,
  type TraceSpan,
} from "eval-framework/trace/agent-trace.ts";

function parseArgs(): {
  prompt: string;
  caseId: string;
  model: string | null;
  timeoutMs: number;
  maxTurns: number | null;
  skipPermissions: boolean;
  cliPath: string;
} {
  const argv = process.argv.slice(2);
  let prompt = "";
  let caseId = "unknown";
  let model: string | null = null;
  let timeoutMs = 360_000;
  let maxTurns: number | null = null;
  let skipPermissions = true;
  let cliPath = "claude";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prompt" && argv[i + 1]) {
      prompt = argv[++i];
    } else if (argv[i] === "--case-id" && argv[i + 1]) {
      caseId = argv[++i];
    } else if (argv[i] === "--model" && argv[i + 1]) {
      model = argv[++i];
    } else if (argv[i] === "--timeout" && argv[i + 1]) {
      timeoutMs = parseInt(argv[++i], 10) || timeoutMs;
    } else if (argv[i] === "--max-turns" && argv[i + 1]) {
      maxTurns = parseInt(argv[++i], 10) || null;
    } else if (argv[i] === "--skip-permissions") {
      skipPermissions = true;
    } else if (argv[i] === "--no-skip-permissions") {
      skipPermissions = false;
    } else if (argv[i] === "--cli-path" && argv[i + 1]) {
      cliPath = argv[++i];
    }
  }

  return { prompt, caseId, model, timeoutMs, maxTurns, skipPermissions, cliPath };
}

export interface StreamMeta {
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
  /**
   * 校准诊断（2026-05-24）：result 事件的原始 usage 与各 assistant turn usage 累加值。
   * 用于事后对比 claude CLI 的 result.usage 是"累计"还是"最后一次"语义。
   * 仅 stderr 输出，不写入 metaOut。
   */
  rawResultUsage: Record<string, number> | null;
  assistantUsageSum: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);

/**
 * 流式 stream-json 解析器：增量消费，避免单 stdout string 累加。
 * 状态机内部，每次喂一行 JSON 就更新内部状态。
 *
 * 单测见 evals/providers/claude-code.test.ts。改解析逻辑前先跑测试。
 */
export class StreamJsonParser {
  meta: StreamMeta = {
    text: "",
    toolsUsed: [],
    filesEdited: [],
    numTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    errorCount: 0,
    retryCount: 0,
    backtrackCount: 0,
    exitStatus: null,
    sawResult: false,
    eventCount: 0,
    rawResultUsage: null,
    assistantUsageSum: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
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
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return;
    }

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
      // 累加 turn-level usage 用于 stderr 校准诊断（不进 totalTokens，避免与 result.usage 双倍）
      const u = msg.usage as Record<string, number> | undefined;
      if (u) {
        this.meta.assistantUsageSum.input_tokens += u.input_tokens || 0;
        this.meta.assistantUsageSum.output_tokens += u.output_tokens || 0;
        this.meta.assistantUsageSum.cache_creation_input_tokens +=
          u.cache_creation_input_tokens || 0;
        this.meta.assistantUsageSum.cache_read_input_tokens += u.cache_read_input_tokens || 0;
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
        // 校准已确认（2026-05-25）：claude CLI 的 result.usage 是真实累计：
        //   - input_tokens = 最后一次 API 调用的 prompt 总长度（含全部历史 + cache 复用）
        //   - output_tokens / cache_creation / cache_read = 所有 turn 累加
        // 4 项相加 ≈ "整个 session 的总 token 流量"（含 cache 复用倍数）。
        //
        // ⚠️ 不要把 assistant 事件的 usage 累加当作 totalTokens：
        //   stream-json 模式下，assistant event 是流式 message_delta 片段，
        //   每个片段的 usage 是该响应到当前时点的累积快照（同一 turn 出现多次），
        //   累加会双倍计数。case_028 实测：assistant 累加 4sum=1.5M / result.usage 4sum=417k。
        //   assistantUsageSum 字段仅用于 stderr 诊断，不进 totalTokens。
        this.meta.rawResultUsage = { ...usage };
        this.meta.totalTokens =
          (usage.input_tokens || 0) +
          (usage.output_tokens || 0) +
          (usage.cache_creation_input_tokens || 0) +
          (usage.cache_read_input_tokens || 0);
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
    process.stdout.write(
      JSON.stringify({ output: "[ERROR] empty prompt", meta: {}, error: true }) + "\n",
    );
    process.exit(1);
  }

  // --verbose 是 claude CLI 强制要求（"--print + --output-format=stream-json requires --verbose"）
  // stream-json 模式才能拿到 tool_use 事件、files_edited、usage 等 trajectory metadata
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
  // 评测隔离：--bare 跳过 CLAUDE.md auto-discovery（与 sid-code 的 SID_CODE_DISABLE_PROJECT_RULES 对齐）
  // 否则 claude 会读项目根 CLAUDE.md 里的目录结构（如 "AgentLoopRunner / src/agent/loop.ts"），
  // 让 case_001 类锚点查询的 anchor 维度虚高。
  // --bare 同时跳过 hooks/LSP/plugin/auto-memory，对评测来说反而是干净的中性环境。
  args.push("--bare");
  if (model) args.push("--model", model);
  if (skipPermissions) args.push("--dangerously-skip-permissions");
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  args.push(prompt);

  const startedAt = Date.now();
  process.stderr.write(
    `[claude-code] spawn: ${cliPath} ${args.slice(0, 5).join(" ")} ... (prompt ${prompt.length} chars, case=${caseId})\n`,
  );

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
      try {
        child.kill("SIGKILL");
      } catch {}
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
  child.stderr?.on("data", (c) => {
    stderrBuf += c.toString();
  });

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
    // token_breakdown：从 result.usage 抽出 4 项原始数，让 eval-judge 的 gradeCost
    // 按 cache_read * 0.1x 折算后再评分（claude-opus 重 cache，不折算会被 raw token 全价计费）。
    // result.usage 缺失时（incomplete stream）退化为 0，gradeCost 退化为 total_tokens 评分。
    token_breakdown: parsed.rawResultUsage
      ? {
          input: parsed.rawResultUsage.input_tokens || 0,
          output: parsed.rawResultUsage.output_tokens || 0,
          cache_creation: parsed.rawResultUsage.cache_creation_input_tokens || 0,
          cache_read: parsed.rawResultUsage.cache_read_input_tokens || 0,
        }
      : { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
    latency_ms: elapsedMs,
    exit_status: timedOut ? "timeout" : parsed.exitStatus || (exitCode === 0 ? "success" : "error"),
    error_count: parsed.errorCount,
    retry_count: parsed.retryCount,
    backtrack_count: parsed.backtrackCount,
    total_cost_usd: parsed.totalCostUsd,
  };

  process.stderr.write(
    `[claude-code] exit=${exitCode} timedOut=${timedOut} elapsed=${elapsedMs}ms ` +
      `stdout=${stdoutBytes}B events=${parsed.eventCount} sawResult=${parsed.sawResult} ` +
      `turns=${parsed.numTurns} tools=${parsed.toolsUsed.join(",")} errors=${parsed.errorCount}\n`,
  );

  // 校准诊断（2026-05-25 修订）：
  // result.usage 是真实累计；assistantUsageSum 是 streaming message_delta 累加（含双倍计数），
  // 仅用于事后诊断 streaming 协议变更。两者比值应远 >1（重复计数证据），不再作为"语义判断"。
  if (parsed.rawResultUsage) {
    const r4 =
      (parsed.rawResultUsage.input_tokens || 0) +
      (parsed.rawResultUsage.output_tokens || 0) +
      (parsed.rawResultUsage.cache_creation_input_tokens || 0) +
      (parsed.rawResultUsage.cache_read_input_tokens || 0);
    process.stderr.write(
      `[claude-code calibration] result.usage: i=${parsed.rawResultUsage.input_tokens || 0} ` +
        `o=${parsed.rawResultUsage.output_tokens || 0} ` +
        `cc=${parsed.rawResultUsage.cache_creation_input_tokens || 0} ` +
        `cr=${parsed.rawResultUsage.cache_read_input_tokens || 0} 4sum=${r4} ` +
        `(num_turns=${parsed.numTurns})\n`,
    );
  }

  // 健康检查：exit=0 但没有 result 事件 → 说明输出在中途被截断/丢失，应当标 error
  if (!timedOut && exitCode === 0 && !parsed.sawResult) {
    process.stdout.write(
      JSON.stringify({
        output: `[ERROR] claude-code stream-json incomplete: no result event (events=${parsed.eventCount}, stdout=${stdoutBytes}B)`,
        meta: metaOut,
        error: true,
      }) + "\n",
    );
    process.exit(0);
  }

  if (timedOut) {
    process.stdout.write(
      JSON.stringify({
        output: `[ERROR] claude-code TIMEOUT after ${timeoutMs}ms`,
        meta: metaOut,
        error: true,
      }) + "\n",
    );
    process.exit(0);
  }
  if (exitCode !== 0) {
    process.stdout.write(
      JSON.stringify({
        output: `[ERROR] claude-code exit=${exitCode}\nstderr tail:\n${stderrBuf.slice(-800)}`,
        meta: metaOut,
        error: true,
      }) + "\n",
    );
    process.exit(0);
  }

  // B6-5：trace.json 落盘（AgentTrace v1 简化版——从 streaming events 构建）
  // claude-code 没有 raw.jsonl，用 StreamMeta 构建只含顶层元数据 + 1 个 summary span 的 trace
  if (parsed.text && parsed.sawResult) {
    try {
      const now = new Date().toISOString();
      const startIso = new Date(startedAt).toISOString();
      const sessionUuid = crypto.randomUUID();
      const usage = parsed.rawResultUsage || {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      const summarySpan: TraceSpan = {
        span_id: 0,
        span_kind: "thought",
        started_at: startIso,
        ended_at: now,
        duration_ms: elapsedMs,
        role: "assistant",
        agent_label: "primary",
        thought: parsed.text.slice(0, 8192),
      };
      const trace: AgentTrace = {
        trace_id: sessionUuid,
        session_id: sessionUuid,
        agent_kind: "claude-code",
        agent_version: "cli",
        case_id: caseId !== "unknown" ? caseId : undefined,
        provider: "anthropic",
        model: model || "claude-opus-4-7",
        started_at: startIso,
        ended_at: now,
        total_duration_ms: elapsedMs,
        total_input_tokens: usage.input_tokens || 0,
        total_output_tokens: usage.output_tokens || 0,
        total_cache_read_tokens: usage.cache_read_input_tokens || 0,
        total_cache_creation_tokens: usage.cache_creation_input_tokens || 0,
        billable_tokens:
          (usage.input_tokens || 0) +
          (usage.output_tokens || 0) +
          (usage.cache_creation_input_tokens || 0) +
          Math.round((usage.cache_read_input_tokens || 0) * 0.1),
        status: "ok",
        final_output: parsed.text.slice(0, 8192),
        spans: [summarySpan],
      };
      const validation = validateTrace(trace);
      if (validation.ok) {
        const traceDir = join(import.meta.dir, "..", "_traces", "claude-code");
        mkdirSync(traceDir, { recursive: true });
        const traceOutPath = join(traceDir, `${caseId}-${sessionUuid.slice(0, 8)}.json`);
        writeFileSync(traceOutPath, JSON.stringify(trace, null, 2), "utf-8");
      }
    } catch {
      // best-effort
    }
  }

  process.stdout.write(
    JSON.stringify({
      output: parsed.text || "[ERROR] empty output from claude-code",
      meta: metaOut,
      error: !parsed.text,
    }) + "\n",
  );
}

if (import.meta.main) {
  main().catch((err) => {
    process.stdout.write(
      JSON.stringify({
        output: `[ERROR] claude-code wrapper crash: ${err?.message || err}`,
        meta: {},
        error: true,
      }) + "\n",
    );
    process.exit(0);
  });
}
