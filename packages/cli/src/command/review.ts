/**
 * sid-code review — 子命令入口
 *
 * 用法:
 *   git diff main...HEAD | sid-code review
 *   sid-code review --diff /tmp/pr.diff
 *   sid-code review --diff /tmp/pr.diff --model deepseek-v4-pro
 *
 * 流程:
 *   1. 解析 args (--diff / --model / --timeout / --help)
 *   2. 读 unified diff (stdin 或 --diff 文件)
 *   3. 加载 src/skill/builtin/code-review/SKILL.md body
 *   4. 拼 system prompt + 用户 query, spawn sid-code 主进程 -p 无头模式
 *   5. 把 final response markdown 写到 stdout
 *
 * 由 RFC-001 §4 / TODO-M4-M5 §S5-T13 定义.
 */

import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveExecutable } from "@sid-code/core/bootstrap/resolve-executable.ts";

interface ReviewOptions {
  diffPath?: string;
  model?: string;
  timeoutMs: number;
  help: boolean;
}

function printHelp(): void {
  console.log(`sid-code review — 用 code-review Skill 审查 unified diff

用法:
  git diff main...HEAD | sid-code review        从 stdin 读 diff
  sid-code review --diff <path>                  从文件读 diff
  sid-code review --diff <path> --model <model>  指定 LLM

选项:
  --diff <path>     从文件读 unified diff (默认从 stdin)
  --model <model>   指定 LLM 模型 (默认走 config.provider 默认)
  --timeout <ms>    LLM 超时毫秒 (默认 180000)
  -h, --help        显示帮助

示例:
  git diff origin/main | sid-code review
  sid-code review --diff /tmp/pr-1234.diff --model deepseek-v4-pro

输出:
  Markdown 格式的 Code Review 报告写到 stdout, 含 file:line 引用.

注意:
  本命令不修改文件 (allowed-tools 限定 read/grep/glob/bash, RL-001 守护).`);
}

function parseReviewArgs(args: string[]): ReviewOptions {
  try {
    const { values } = parseArgs({
      args,
      options: {
        diff: { type: "string" },
        model: { type: "string" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });
    return {
      diffPath: values.diff,
      model: values.model,
      timeoutMs: values.timeout ? parseInt(values.timeout, 10) : 180000,
      help: !!values.help,
    };
  } catch (err: any) {
    console.error(`错误: ${err.message}\n使用 sid-code review --help 查看用法`);
    process.exit(1);
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function loadCodeReviewSkillPrompt(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const skillFile = join(__dirname, "..", "skill", "builtin", "code-review", "SKILL.md");
  if (!existsSync(skillFile)) {
    throw new Error(`code-review SKILL.md 不存在: ${skillFile}`);
  }
  const md = readFileSync(skillFile, "utf-8");
  const match = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1] : md;
}

function buildSystemPrompt(skillBody: string): string {
  return `你是 code-review 助手。基于用户提供的 PR diff 给出结构化 Code Review 报告。
输出必须:
  (1) 引用具体 file:line 行号(RL-007 不编造问题)
  (2) 不调用 edit / write 工具修改文件(RL-001 不删用户代码)
  (3) 中文 PR 用中文 review

以下是激活的 code-review Skill 提示, 请严格按其约束执行:

${skillBody}`;
}

function buildUserQuery(diffText: string): string {
  return `请审查以下 unified diff 的代码变更, 输出结构化 Code Review:

\`\`\`diff
${diffText}
\`\`\`

请给出 markdown 报告, 含:
- 顶层 Verdict (approve / request_changes / needs_discussion)
- 每个 finding 的 severity / file:line / Issue / Suggested Fix
- 必要时引用 reference_answer 风格的可执行修改建议`;
}

async function spawnSidCode(
  prompt: string,
  opts: ReviewOptions,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const { cmd, baseArgs } = resolveExecutable();

  const cmdArgs: string[] = [...baseArgs, "-p", "--output-format", "json"];
  if (opts.model) {
    cmdArgs.push("--model", opts.model);
  }
  cmdArgs.push(prompt);

  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, opts.timeoutMs);

    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        timedOut,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      stderrChunks.push(Buffer.from(`spawn error: ${err.message}\n`));
      resolve({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        timedOut: false,
      });
    });
  });
}

function extractFinalResponse(stdout: string): string {
  // sid-code -p --output-format json 输出形如:
  //   { "session_id": ..., "final_response": "...", "tools_called": [...], ... }
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.final_response === "string") return parsed.final_response;
    if (typeof parsed.text === "string") return parsed.text;
    return trimmed;
  } catch {
    // 不是 JSON, 直接返回原文
    return trimmed;
  }
}

export async function handleReviewCommand(args: string[]): Promise<void> {
  const opts = parseReviewArgs(args);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // 1. 读 diff
  let diffText = "";
  if (opts.diffPath) {
    if (!existsSync(opts.diffPath)) {
      console.error(`错误: --diff 路径不存在: ${opts.diffPath}`);
      process.exit(1);
    }
    diffText = readFileSync(opts.diffPath, "utf-8");
  } else {
    diffText = await readStdin();
  }

  if (!diffText.trim()) {
    console.error("错误: 未提供 unified diff (stdin 为空且未指定 --diff)");
    console.error("用法: git diff main...HEAD | sid-code review");
    console.error("     sid-code review --diff /tmp/pr.diff");
    process.exit(1);
  }

  // 2. 加载 SKILL.md body
  let skillBody: string;
  try {
    skillBody = loadCodeReviewSkillPrompt();
  } catch (err: any) {
    console.error(`错误: 加载 code-review Skill 失败: ${err.message}`);
    process.exit(1);
  }

  // 3. 拼 prompt
  const systemPrompt = buildSystemPrompt(skillBody);
  const userQuery = buildUserQuery(diffText);
  const fullPrompt = `${systemPrompt}\n\n---\n\n用户输入:\n${userQuery}`;

  // 4. spawn sid-code -p
  console.error(
    `[sid-code review] 调用 code-review Skill (model=${opts.model || "default"}, diff=${diffText.length} chars)...`,
  );
  const startedAt = Date.now();
  const result = await spawnSidCode(fullPrompt, opts);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (result.timedOut) {
    console.error(`[sid-code review] ⚠️  超时 (${opts.timeoutMs}ms), 已 kill`);
    process.exit(1);
  }
  if (result.exitCode !== 0) {
    console.error(`[sid-code review] ⚠️  sid-code 主进程 exit=${result.exitCode}`);
    if (result.stderr) console.error(result.stderr);
    process.exit(result.exitCode);
  }

  // 5. 输出最终响应
  const finalResponse = extractFinalResponse(result.stdout);
  if (!finalResponse) {
    console.error("[sid-code review] ⚠️  未抽到 final_response, 直接输出原始 stdout:");
    process.stdout.write(result.stdout);
    process.exit(1);
  }

  console.error(`[sid-code review] ✅ 完成 (${elapsed}s)`);
  process.stdout.write(finalResponse);
  if (!finalResponse.endsWith("\n")) process.stdout.write("\n");
}
