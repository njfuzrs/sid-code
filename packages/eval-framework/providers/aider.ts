#!/usr/bin/env bun

/**
 * Aider Provider — 接入 aider (https://aider.chat) 的评测 wrapper
 *
 * aider 是一个基于 CLI 的 AI 编程助手，支持多种 LLM 后端。
 * 本 provider 通过 spawn aider CLI 并收集其输出来完成评测。
 *
 * 前置条件：
 *   - 已安装 aider: pip install aider-chat
 *   - 已配置 API key（OPENAI_API_KEY 或 ANTHROPIC_API_KEY）
 *
 * 注册到 eval.config.yaml：
 *   aider:
 *     script: ./providers/aider.ts
 *     default_model: gpt-4o
 *     timeout_ms: 600000
 *     max_turns: 50
 */

import { spawn } from "node:child_process";

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
  let timeoutMs = 600_000;
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
  };
  error: boolean;
}

async function runAider(args: ProviderArgs): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const model = args.model ?? "gpt-4o";

  const aiderArgs = [
    "--yes-always",
    "--no-auto-commits",
    "--no-git",
    "--no-pretty",
    "--no-stream",
    "--model", model,
    "--message", args.prompt,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn("aider", aiderArgs, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("timeout"));
    }, args.timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.end();
  });
}

function extractFilesEdited(output: string): string[] {
  const files: string[] = [];
  const patterns = [
    /Applied edit to (.+)/g,
    /Wrote (.+)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(output)) !== null) {
      files.push(match[1].trim());
    }
  }
  return [...new Set(files)];
}

async function main() {
  const args = parseArgs();

  if (!args.prompt) {
    const errorResult: ProviderOutput = {
      output: "[ERROR] --prompt is required",
      meta: { latency_ms: 0, exit_status: "error", error_count: 1, retry_count: 0, backtrack_count: 0, tools_used: [], files_edited: [], num_turns: 0, total_tokens: 0, total_steps: 0 },
      error: true,
    };
    process.stdout.write(JSON.stringify(errorResult));
    process.exit(0);
  }

  const startMs = Date.now();

  try {
    const result = await runAider(args);
    const latencyMs = Date.now() - startMs;
    const filesEdited = extractFilesEdited(result.stdout);

    const output: ProviderOutput = {
      output: result.stdout,
      meta: {
        latency_ms: latencyMs,
        exit_status: result.exitCode === 0 ? "end_turn" : "error",
        error_count: result.exitCode === 0 ? 0 : 1,
        retry_count: 0,
        backtrack_count: 0,
        tools_used: ["Edit"],
        files_edited: filesEdited,
        num_turns: 1,
        total_tokens: 0,
        total_steps: 1,
      },
      error: result.exitCode !== 0,
    };
    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const isTimeout = err instanceof Error && err.message === "timeout";

    const output: ProviderOutput = {
      output: isTimeout
        ? `[TIMEOUT] aider 超时 (${args.timeoutMs}ms)`
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
