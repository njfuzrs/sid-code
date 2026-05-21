#!/usr/bin/env bun
/**
 * promptfoo exec provider: sid-code-live
 *
 * 用法(promptfooconfig.yaml):
 *   - id: 'exec:bun run providers/sid-code-live.ts'
 *     label: sid-code-live
 *     config:
 *       model: claude-opus-4-7   # 可选
 *       timeoutMs: 360000        # 可选
 *       maxTurns: 30             # 可选
 *
 * promptfoo 调用约定:
 *   $1 = 已渲染的 prompt 字符串
 *   $2 = JSON.stringify(providerConfig)
 *   $3 = JSON.stringify(context)  // 含 vars / test metadata
 *
 * 输出: 纯文本到 stdout(promptfoo 把整段 stdout 当成 model output)
 *      在 stderr 输出诊断信息(promptfoo 默认不展示,debug 时看)
 */

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const ENTRYPOINT = join(REPO_ROOT, "src/entrypoints/bootstrap.ts");
const TRAJ_DIR = process.env.SID_CODE_TRAJECTORIES_DIR
  || join(homedir(), ".sid-code/trajectories");

interface ProviderConfig {
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  permissionMode?: string;
}

function parseConfig(raw: string | undefined): ProviderConfig {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ProviderConfig;
  } catch {
    return {};
  }
}

function findLatestSessionDir(sinceMs: number): string | null {
  const sessionsRoot = join(TRAJ_DIR, "sessions");
  if (!existsSync(sessionsRoot)) return null;
  let bestPath: string | null = null;
  let bestMtime = 0;
  for (const name of readdirSync(sessionsRoot)) {
    const dir = join(sessionsRoot, name);
    try {
      const s = statSync(dir);
      if (!s.isDirectory()) continue;
      const mtime = s.mtimeMs;
      if (mtime < sinceMs - 1000) continue;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestPath = dir;
      }
    } catch {
      continue;
    }
  }
  return bestPath;
}

function parseFinalText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  let parsed: { content?: unknown } | null = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return trimmed;
      }
    }
  }
  if (!parsed) return trimmed;
  const content = parsed.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
    return parts.join("\n");
  }
  if (typeof content === "string") return content;
  return trimmed;
}

function readTrajectoryMeta(sessionDir: string | null): {
  toolsUsed: string[];
  filesEdited: string[];
  totalSteps: number;
  exitStatus: string | null;
} {
  if (!sessionDir) {
    return { toolsUsed: [], filesEdited: [], totalSteps: 0, exitStatus: null };
  }
  const trajPath = join(sessionDir, "session.traj");
  if (!existsSync(trajPath)) {
    return { toolsUsed: [], filesEdited: [], totalSteps: 0, exitStatus: null };
  }
  try {
    const content = readFileSync(trajPath, "utf-8");
    const obj = JSON.parse(content);
    const md = obj?.metadata || {};
    return {
      toolsUsed: md.tools_used || [],
      filesEdited: md.files_edited || [],
      totalSteps: md.total_steps || 0,
      exitStatus: md.exit_status || null,
    };
  } catch {
    return { toolsUsed: [], filesEdited: [], totalSteps: 0, exitStatus: null };
  }
}

/**
 * 尝试从 stdout buffer 中提取完整 JSON 对象。
 * sid-code --output-format json 输出一个完整 JSON 对象后 process.exit(0)。
 * 如果进程因某种原因没退出但 JSON 已完整，提前收割结果。
 */
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
  const prompt = process.argv[2] || "";
  const configRaw = process.argv[3];
  const config = parseConfig(configRaw);

  if (!prompt) {
    console.error("[sid-code-live] empty prompt, exit 1");
    process.exit(1);
  }

  const timeoutMs = config.timeoutMs ?? 360_000;
  const args = ["run", ENTRYPOINT, "-p", "--output-format", "json"];
  if (config.model) args.push("--model", config.model);
  if (config.maxTurns) args.push("--max-turns", String(config.maxTurns));
  if (config.permissionMode) args.push("--permission-mode", config.permissionMode);
  args.push(prompt);

  const startedAt = Date.now();
  process.stderr.write(`[sid-code-live] spawn: bun ${args.slice(0, 5).join(" ")} ... (prompt ${prompt.length} chars)\n`);

  const child = spawn("bun", args, {
    cwd: REPO_ROOT,
    env: { ...process.env, SID_CODE_HEADLESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let resolved = false;
  let resolveMain: (code: number | null) => void;

  const exitPromise = new Promise<number | null>((res) => { resolveMain = res; });

  child.stdout?.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    // 检测 stdout 是否已收到完整 JSON — 如果是，给一个短延时后主动 kill
    if (!resolved && tryExtractCompleteJson(stdoutBuf)) {
      resolved = true;
      process.stderr.write(`[sid-code-live] stdout JSON complete (${stdoutBuf.length}B), waiting 2s for graceful exit...\n`);
      setTimeout(() => {
        if (!child.killed) {
          process.stderr.write(`[sid-code-live] force kill after JSON received\n`);
          child.kill("SIGTERM");
          setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
        }
      }, 2000);
    }
  });
  child.stderr?.on("data", (chunk) => { stderrBuf += chunk.toString(); });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.stderr.write(`[sid-code-live] TIMEOUT after ${timeoutMs}ms, SIGTERM\n`);
    child.kill("SIGTERM");
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 3000);
  }, timeoutMs);

  child.on("close", (code) => resolveMain(code));
  child.on("error", () => resolveMain(null));

  const exitCode = await exitPromise;
  clearTimeout(timer);

  const elapsedMs = Date.now() - startedAt;
  const sessionDir = findLatestSessionDir(startedAt);
  const meta = readTrajectoryMeta(sessionDir);

  process.stderr.write(
    `[sid-code-live] exit=${exitCode} timedOut=${timedOut} elapsed=${elapsedMs}ms `
    + `stdout=${stdoutBuf.length}B stderr=${stderrBuf.length}B `
    + `session=${sessionDir ? sessionDir.split("/").pop() : "none"} `
    + `tools=${meta.toolsUsed.join(",")} steps=${meta.totalSteps}\n`
  );

  // 即使超时/非零退出，如果已经拿到完整 JSON 输出，仍然提取结果
  if (tryExtractCompleteJson(stdoutBuf)) {
    const text = parseFinalText(stdoutBuf);
    if (text) {
      process.stdout.write(text);
      process.exit(0);
    }
  }

  if (timedOut) {
    console.log(`[ERROR] sid-code-live TIMEOUT after ${timeoutMs}ms`);
    process.exit(0);
  }
  if (exitCode !== 0 && exitCode !== null) {
    console.log(`[ERROR] sid-code-live exit=${exitCode}\nstderr tail:\n${stderrBuf.slice(-800)}`);
    process.exit(0);
  }

  const text = parseFinalText(stdoutBuf);
  process.stdout.write(text || "[ERROR] empty output from sid-code-live");
}

main().catch((err) => {
  console.log(`[ERROR] sid-code-live wrapper crash: ${err?.message || err}`);
  process.exit(0);
});
