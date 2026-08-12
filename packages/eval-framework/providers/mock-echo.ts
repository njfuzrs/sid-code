#!/usr/bin/env bun

/**
 * mock-echo provider — 验证 eval-runner 全流程的最小 provider
 *
 * 行为：直接将 prompt 原样返回作为 output，不调用任何 agent。
 * 用途：验证 eval-runner → provider → eval-judge 全链路可跑通。
 */

function parseArgs() {
  const argv = process.argv.slice(2);
  let prompt = "";
  let caseId = "unknown";
  let timeoutMs = 480_000;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prompt" && argv[i + 1]) {
      prompt = argv[++i];
    } else if (argv[i] === "--case-id" && argv[i + 1]) {
      caseId = argv[++i];
    } else if (argv[i] === "--timeout" && argv[i + 1]) {
      timeoutMs = parseInt(argv[++i], 10) || timeoutMs;
    }
  }

  return { prompt, caseId, timeoutMs };
}

const args = parseArgs();

const result = {
  output: args.prompt,
  meta: {
    latency_ms: 1,
    exit_status: "end_turn",
    error_count: 0,
    retry_count: 0,
    backtrack_count: 0,
    tools_used: [],
    files_edited: [],
    num_turns: 1,
    total_tokens: 100,
    total_steps: 1,
  },
  error: false,
};

process.stdout.write(JSON.stringify(result));
