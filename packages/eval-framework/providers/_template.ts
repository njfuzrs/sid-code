#!/usr/bin/env bun

/**
 * Provider 模板 — 新 agent 接入评测框架的脚手架
 *
 * 使用方法：
 *   1. 复制本文件为 providers/<your-agent>.ts
 *   2. 实现 runAgent() 函数（调用你的 agent 并收集输出）
 *   3. 在 eval.config.yaml 中注册 provider
 *   4. 运行：bun run eval:run --provider <your-agent>
 *
 * 输入契约（CLI 参数）：
 *   --prompt       必填，发给 Agent 的用户指令
 *   --case-id      必填，Case 标识
 *   --model        可选，覆盖默认模型
 *   --timeout      可选，超时毫秒数（默认 480000）
 *   --max-turns    可选，最大对话轮次
 *   --permission-mode 可选，权限模式
 *
 * 输出契约（stdout JSON）：
 *   { output, meta, error } — 详见 eval-independence-refactor.md §3.3
 */

// ============================================================
// 1. 参数解析（通用，无需修改）
// ============================================================

interface ProviderArgs {
  prompt: string;
  caseId: string;
  model: string | null;
  timeoutMs: number;
  maxTurns: number | null;
  permissionMode: string | null;
}

function parseArgs(): ProviderArgs {
  const argv = process.argv.slice(2);
  let prompt = "";
  let caseId = "unknown";
  let model: string | null = null;
  let timeoutMs = 480_000;
  let maxTurns: number | null = null;
  let permissionMode: string | null = null;

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
    } else if (argv[i] === "--permission-mode" && argv[i + 1]) {
      permissionMode = argv[++i];
    }
  }

  return { prompt, caseId, model, timeoutMs, maxTurns, permissionMode };
}

// ============================================================
// 2. Agent 调用（需要你实现）
// ============================================================

interface AgentResult {
  output: string;
  toolsUsed: string[];
  filesEdited: string[];
  numTurns: number;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
  };
}

async function runAgent(args: ProviderArgs): Promise<AgentResult> {
  // TODO: 实现你的 agent 调用逻辑
  // 示例：通过 spawn 调用 CLI、通过 HTTP 调用 API、直接调用 SDK 等
  //
  // const proc = spawn("your-agent-cli", ["--prompt", args.prompt, ...]);
  // const stdout = await collectStdout(proc);
  // return parseAgentOutput(stdout);

  throw new Error("请实现 runAgent() 函数");
}

// ============================================================
// 3. 主流程（通用，无需修改）
// ============================================================

interface ProviderOutput {
  output: string;
  meta: {
    latency_ms: number;
    exit_status: string;
    error_count: number;
    retry_count: number;
    backtrack_count: number;
    tools_used: string[];
    files_edited: string[];
    num_turns: number;
    total_tokens: number;
    total_steps: number;
    tokens?: {
      input: number;
      output: number;
      cache_read: number;
      cache_creation: number;
    };
  };
  error: boolean;
}

async function main() {
  const args = parseArgs();

  if (!args.prompt) {
    const errorResult: ProviderOutput = {
      output: "[ERROR] --prompt is required",
      meta: {
        latency_ms: 0,
        exit_status: "error",
        error_count: 1,
        retry_count: 0,
        backtrack_count: 0,
        tools_used: [],
        files_edited: [],
        num_turns: 0,
        total_tokens: 0,
        total_steps: 0,
      },
      error: true,
    };
    process.stdout.write(JSON.stringify(errorResult));
    process.exit(0);
  }

  const startMs = Date.now();

  try {
    const result = await Promise.race([
      runAgent(args),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), args.timeoutMs),
      ),
    ]);

    const latencyMs = Date.now() - startMs;
    const totalTokens =
      result.tokens.input +
      result.tokens.output +
      result.tokens.cache_read +
      result.tokens.cache_creation;

    const output: ProviderOutput = {
      output: result.output,
      meta: {
        latency_ms: latencyMs,
        exit_status: "end_turn",
        error_count: 0,
        retry_count: 0,
        backtrack_count: 0,
        tools_used: result.toolsUsed,
        files_edited: result.filesEdited,
        num_turns: result.numTurns,
        total_tokens: totalTokens,
        total_steps: result.numTurns,
        tokens: result.tokens,
      },
      error: false,
    };
    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const isTimeout = err instanceof Error && err.message === "timeout";

    const output: ProviderOutput = {
      output: isTimeout
        ? `[TIMEOUT] agent 超时 (${args.timeoutMs}ms)`
        : `[ERROR] ${err instanceof Error ? err.message : String(err)}`,
      meta: {
        latency_ms: latencyMs,
        exit_status: isTimeout ? "timeout" : "error",
        error_count: 1,
        retry_count: 0,
        backtrack_count: 0,
        tools_used: [],
        files_edited: [],
        num_turns: 0,
        total_tokens: 0,
        total_steps: 0,
      },
      error: true,
    };
    process.stdout.write(JSON.stringify(output));
  }
}

main();
