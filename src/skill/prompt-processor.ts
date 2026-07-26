/**
 * Skill Prompt 处理管道
 *
 * 对齐 Claude Code 的变量替换能力，在 Skill 被调用时把原始 markdown body
 * 处理成最终注入对话的 prompt 文本：
 *
 *   1. 注入 Base directory 头部（让模型知道 Skill 资源在哪）
 *   2. $ARGUMENTS / $@ / $* / {{args}} → 完整参数字符串
 *   3. $1 $2 ... → 位置参数
 *   4. $arg_name → 命名参数（frontmatter arguments 字段）
 *   5. ${SKILL_DIR} / ${CLAUDE_SKILL_DIR} → Skill 自身目录
 *   6. ${SESSION_ID} / ${CLAUDE_SESSION_ID} → 当前会话 ID
 *   7. !`cmd` → 内联 shell 命令执行（仅非 MCP Skill）
 *
 * 安全：MCP Skill（loadedFrom="mcp"）被视为不可信来源，
 * 禁止内联 shell 执行，${SKILL_DIR} 替换为占位提示。
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getLogger } from "../debug/logger.ts";
import type { SkillLoadedFrom } from "./types.ts";

const execAsync = promisify(exec);

/** 内联 shell 命令超时（毫秒） */
const SHELL_TIMEOUT_MS = 10_000;

export interface ProcessSkillPromptOptions {
  /** Skill 自身目录（${SKILL_DIR} 替换 + Base directory 头部） */
  skillRoot?: string;
  /** 加载位置（MCP 来源禁止 shell 执行） */
  loadedFrom?: SkillLoadedFrom;
  /** 命名参数列表（支持 $arg_name 替换） */
  argumentNames?: string[];
  /** 是否注入 Base directory 头部（默认在有 skillRoot 时注入） */
  injectBaseDir?: boolean;
  /** 内联 shell 使用的 shell（默认系统默认） */
  shell?: string;
}

export interface SkillPromptContext {
  cwd: string;
  sessionId: string;
}

/**
 * 处理 Skill prompt：执行完整的变量替换管道
 */
export async function processSkillPrompt(
  rawContent: string,
  args: string,
  context: SkillPromptContext,
  options: ProcessSkillPromptOptions = {},
): Promise<string> {
  let content = rawContent;
  const isMcp = options.loadedFrom === "mcp";

  // Step 1: 注入 Base directory 头部（仅本地 Skill）
  const injectBase = options.injectBaseDir ?? Boolean(options.skillRoot);
  if (options.skillRoot && injectBase && !isMcp) {
    content = `Base directory for this skill: ${options.skillRoot}\n\n${content}`;
  }

  // Step 2-4: 参数替换
  content = substituteArguments(content, args, options.argumentNames);

  // Step 5: ${SKILL_DIR} 替换
  // P1-3 变量兼容：同时认 CC 的 ${CLAUDE_SKILL_DIR}（loadSkillsDir.ts）与 sid 原生 ${SKILL_DIR}，
  // 避免从 CC 迁移的 skill 变量原样残留在 prompt。两套名等价替换。
  const skillDirRe = /\$\{(?:CLAUDE_)?SKILL_DIR\}/g;
  if (isMcp) {
    content = content.replace(
      skillDirRe,
      "[MCP Skill 不支持 SKILL_DIR 变量]",
    );
  } else if (options.skillRoot) {
    const skillDir = options.skillRoot.replace(/\\/g, "/");
    content = content.replace(skillDirRe, skillDir);
  }

  // Step 6: ${SESSION_ID} 替换（同时认 CC 的 ${CLAUDE_SESSION_ID}）
  content = content.replace(/\$\{(?:CLAUDE_)?SESSION_ID\}/g, context.sessionId);

  // Step 7: 内联 shell 命令 —— 仅非 MCP Skill
  if (isMcp) {
    const shellMatches = content.match(/!`[^`]+`/g);
    if (shellMatches) {
      getLogger().warn(
        "SKILL",
        `MCP Skill 包含 ${shellMatches.length} 个内联 shell 命令，已忽略`,
      );
      content = content.replace(
        /!`[^`]+`/g,
        "[MCP Skill 不允许执行内联 shell 命令]",
      );
    }
  } else {
    content = await executeShellCommandsInPrompt(
      content,
      context.cwd,
      options.shell,
    );
  }

  return content;
}

/**
 * 参数替换：$ARGUMENTS / $@ / $* / {{args}} / $1 $2 / $arg_name
 */
export function substituteArguments(
  content: string,
  args: string,
  argumentNames?: string[],
): string {
  const trimmed = args.trim();

  // $ARGUMENTS / $@ / $* / {{args}} → 完整参数字符串
  let result = content.replace(/\$ARGUMENTS|\$@|\$\*|\{\{args\}\}/g, trimmed);

  const parts = trimmed.split(/\s+/).filter(Boolean);

  // 命名参数：$arg_name → 对应位置的值（在 $1 之前替换，避免与位置参数冲突）
  if (argumentNames && argumentNames.length > 0) {
    for (let i = 0; i < argumentNames.length; i++) {
      const name = argumentNames[i];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      const value = i < parts.length ? parts[i] : "";
      // 用单词边界避免 $file 误伤 $filename
      result = result.replace(
        new RegExp(`\\$${name}\\b`, "g"),
        value,
      );
    }
  }

  // $1, $2, ... → 位置参数
  result = result.replace(/\$(\d+)/g, (_m, idx) => {
    const i = parseInt(idx, 10) - 1;
    return i >= 0 && i < parts.length ? parts[i] : "";
  });

  return result;
}

/**
 * 内联 Shell 命令执行：匹配 !`command` 语法，把 stdout 替换进 prompt
 */
export async function executeShellCommandsInPrompt(
  content: string,
  cwd: string,
  shell?: string,
): Promise<string> {
  const shellRegex = /!`([^`]+)`/g;
  const matches = [...content.matchAll(shellRegex)];
  if (matches.length === 0) return content;

  let result = content;
  for (const match of matches) {
    const command = match[1];
    try {
      const { stdout } = await execAsync(command, {
        cwd,
        timeout: SHELL_TIMEOUT_MS,
        shell,
      });
      result = result.replace(match[0], stdout.trim());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = result.replace(match[0], `[shell error: ${msg}]`);
    }
  }

  return result;
}
