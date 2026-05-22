#!/usr/bin/env bun
/**
 * promptfoo exec provider: claude-code
 *
 * 用法(promptfooconfig.yaml):
 *   - id: 'exec:bun run providers/claude-code.ts'
 *     label: claude-code
 *     config:
 *       model: claude-opus-4-7      # 可选
 *       timeoutMs: 360000           # 可选
 *       maxTurns: 30                # 可选
 *       skipPermissions: true       # 默认 true(无头跑必需)
 *
 * promptfoo 调用约定:
 *   $1 = 已渲染的 prompt 字符串
 *   $2 = JSON.stringify(providerConfig)
 *   $3 = JSON.stringify(context)
 *
 * 输出: 纯文本到 stdout
 *       metadata 通过 sideband 文件传递给 javascript 断言
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const METADATA_DIR = join(import.meta.dir, "../.eval-metadata");

interface ProviderConfig {
  cliPath?: string;
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  skipPermissions?: boolean;
  providerKey?: string;
}

function parseConfig(raw: string | undefined): ProviderConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
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

function parseFinal(stdout: string): { text: string; meta: Record<string, unknown> } {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "", meta: {} };
  try {
    if (trimmed.startsWith("{")) {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      return {
        text: extractResult(obj),
        meta: {
          num_turns: obj.num_turns,
          total_cost_usd: obj.total_cost_usd,
        },
      };
    }
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed) as Array<Record<string, unknown>>;
      const last = arr[arr.length - 1] || {};
      return {
        text: arr.map(extractResult).filter(Boolean).join("\n"),
        meta: { num_messages: arr.length, last_keys: Object.keys(last) },
      };
    }
  } catch {
    // 透传 stdout
  }
  return { text: trimmed, meta: { parse_fallback: true } };
}

function writeMetadataSideband(caseId: string, providerLabel: string, metadata: Record<string, unknown>) {
  try {
    mkdirSync(METADATA_DIR, { recursive: true });
    const normalizedLabel = providerLabel.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");
    const filename = `${caseId}__${normalizedLabel}.json`;
    writeFileSync(join(METADATA_DIR, filename), JSON.stringify(metadata, null, 2));
  } catch (err) {
    process.stderr.write(`[claude-code] failed to write metadata sideband: ${err}\n`);
  }
}

async function main() {
  const prompt = process.argv[2] || "";
  const config = parseConfig(process.argv[3]);
  const ctx = parseContext(process.argv[4]);
  const caseId = (ctx.vars?.case_id as string) || "unknown";

  if (!prompt) {
    console.error("[claude-code] empty prompt, exit 1");
    process.exit(1);
  }

  const cliPath = config.cliPath || "claude";
  const timeoutMs = config.timeoutMs ?? 360_000;
  const skipPermissions = config.skipPermissions !== false;

  const args: string[] = ["-p", "--output-format", "json"];
  if (config.model) args.push("--model", config.model);
  if (skipPermissions) args.push("--dangerously-skip-permissions");
  if (config.maxTurns) args.push("--max-turns", String(config.maxTurns));
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
  const { text, meta } = parseFinal(stdoutBuf);

  // 写入 sideband metadata
  writeMetadataSideband(caseId, config.providerKey || "claude_code", {
    total_steps: (meta.num_turns as number) || 0,
    total_cost_usd: (meta.total_cost_usd as number) || 0,
    elapsed_ms: elapsedMs,
    tools_used: [],
    files_edited: [],
    error_count: 0,
    retry_count: 0,
    backtrack_count: 0,
    total_tokens: 0,
  });

  process.stderr.write(
    `[claude-code] exit=${exitCode} timedOut=${timedOut} elapsed=${elapsedMs}ms `
    + `stdout=${stdoutBuf.length}B meta=${JSON.stringify(meta)}\n`
  );

  if (timedOut) {
    console.log(`[ERROR] claude-code TIMEOUT after ${timeoutMs}ms`);
    process.exit(0);
  }
  if (exitCode !== 0) {
    console.log(`[ERROR] claude-code exit=${exitCode}\nstderr tail:\n${stderrBuf.slice(-800)}`);
    process.exit(0);
  }

  process.stdout.write(text || "[ERROR] empty output from claude-code");
}

main().catch((err) => {
  console.log(`[ERROR] claude-code wrapper crash: ${err?.message || err}`);
  process.exit(0);
});
