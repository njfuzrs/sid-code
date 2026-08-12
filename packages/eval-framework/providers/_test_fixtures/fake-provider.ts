#!/usr/bin/env bun
/**
 * Fake provider 脚本，专供 eval-runner e2e 测试使用。
 *
 * 通过环境变量控制行为，避免真的去调 LLM：
 *   FAKE_MODE=success            正常输出 JSON
 *   FAKE_MODE=retryable_error    输出 ECONNRESET，error=true → eval-runner 应重试
 *   FAKE_MODE=non_retryable      输出 [ERROR] empty output → eval-runner 不应重试
 *   FAKE_MODE=parse_error        输出非 JSON 垃圾 → wrapper 层 parse_error
 *   FAKE_MODE=hang               sleep 永久（用来测外层 timeout）
 *   FAKE_MODE=succeed_after=N    前 N 次返回 retryable_error，第 N+1 次成功
 *                                通过 FAKE_STATE_FILE 文件持久化重试计数
 *
 * 不接受 LLM 相关 args，但兼容 wrapper 协议（--prompt/--case-id/--model/--timeout/--max-turns）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

function parseArgs() {
  const argv = process.argv.slice(2);
  let prompt = "";
  let caseId = "unknown";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prompt" && argv[i + 1]) prompt = argv[++i];
    else if (argv[i] === "--case-id" && argv[i + 1]) caseId = argv[++i];
    else i++; // skip --model/--timeout/--max-turns 的值
  }
  return { prompt, caseId };
}

function emitSuccess(prompt: string) {
  const meta = {
    tools_used: ["read"],
    files_edited: [],
    total_steps: 1,
    total_tokens: 100,
    latency_ms: 10,
    exit_status: "success",
    error_count: 0,
    retry_count: 0,
    backtrack_count: 0,
  };
  process.stdout.write(
    JSON.stringify({ output: `fake answer to: ${prompt.slice(0, 50)}`, meta }) + "\n",
  );
  process.exit(0);
}

function emitError(reason: string, errSubstring: string) {
  const meta = {
    tools_used: [],
    files_edited: [],
    total_steps: 0,
    total_tokens: 0,
    latency_ms: 0,
    exit_status: "error",
    error_count: 0,
    retry_count: 0,
    backtrack_count: 0,
  };
  process.stderr.write(`[fake-provider] ${errSubstring}\n`);
  process.stdout.write(JSON.stringify({ output: `[ERROR] ${reason}`, meta, error: true }) + "\n");
  process.exit(0);
}

const { prompt } = parseArgs();
const mode = process.env.FAKE_MODE || "success";

if (mode === "success") {
  emitSuccess(prompt);
} else if (mode === "retryable_error") {
  emitError("retryable", "ECONNRESET socket hang up");
} else if (mode === "non_retryable") {
  emitError("non-retryable: empty output from model", "model returned no content");
} else if (mode === "parse_error") {
  // 故意输出非 JSON
  process.stdout.write("garbage non-json output\n");
  process.exit(0);
} else if (mode === "hang") {
  // 永远不退出（测外层 timeout）
  setInterval(() => {}, 1_000_000);
} else if (mode.startsWith("succeed_after=")) {
  const n = parseInt(mode.split("=")[1], 10);
  const stateFile = process.env.FAKE_STATE_FILE;
  if (!stateFile) {
    emitError("missing FAKE_STATE_FILE", "config error");
  } else {
    let count = 0;
    if (existsSync(stateFile)) count = parseInt(readFileSync(stateFile, "utf-8"), 10) || 0;
    count += 1;
    writeFileSync(stateFile, String(count));
    if (count <= n) emitError("retryable", "ECONNRESET");
    else emitSuccess(prompt);
  }
} else {
  emitError(`unknown FAKE_MODE: ${mode}`, "config error");
}
