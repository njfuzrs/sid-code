/**
 * CLAUDE.md 规则文件加载与解析
 * 对标 Claude Code：结构化解析 + 多文件合并 + 向上查找 + 文件变化监听
 *
 * 支持的规则类型（按 Markdown 标题识别）：
 * - Instructions: 指令（累积）
 * - Allowed Tools: 工具白名单
 * - Disallowed Tools: 工具黑名单
 * - Permission Mode: 权限模式
 * - Model: 模型选择
 * - System Prompt Addition: 额外系统提示
 * - Custom Rules: 自定义规则（累积）
 * - Memory: 记忆键值对（累积）
 */

import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, watch } from "fs";
import type { FSWatcher } from "fs";
import { getLogger } from "../debug/logger.ts";
import { clearPromptCache } from "./system-prompt.ts";

/** CLAUDE.md 文件名候选列表（对标 Claude Code） */
const CLAUDE_MD_FILES = [
  "CLAUDE.md",
  ".claude.md",
  "claude.md",
  ".claude/CLAUDE.md",
  ".claude/instructions.md",
] as const;

// ─── 结构化解析 ───

/** Markdown 段落 */
interface ClaudeMdSection {
  title: string;
  level: number;
  content: string;
}

/** 解析后的项目规则 */
export interface ProjectRules {
  /** 原始内容（完整 Markdown） */
  rawContent: string;
  /** 来源文件路径 */
  sourcePath: string;
  /** 指令（累积型） */
  instructions?: string;
  /** 工具白名单 */
  allowedTools?: string[];
  /** 工具黑名单 */
  disallowedTools?: string[];
  /** 权限模式 */
  permissionMode?: string;
  /** 模型选择 */
  model?: string;
  /** 额外系统提示 */
  systemPromptAddition?: string;
  /** 自定义规则（累积型） */
  customRules?: string[];
  /** 记忆键值对（累积型） */
  memory?: Record<string, string>;
}

/** 按 Markdown 标题分段 */
function splitSections(content: string): ClaudeMdSection[] {
  const lines = content.split("\n");
  const sections: ClaudeMdSection[] = [];
  let current: ClaudeMdSection = { title: "", level: 0, content: "" };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      // 保存上一个 section
      if (current.title || current.content.trim()) {
        sections.push({ ...current, content: current.content.trimEnd() });
      }
      current = {
        title: headingMatch[2].trim(),
        level: headingMatch[1].length,
        content: "",
      };
    } else {
      current.content += line + "\n";
    }
  }

  // 保存最后一个 section
  if (current.title || current.content.trim()) {
    sections.push({ ...current, content: current.content.trimEnd() });
  }

  return sections;
}

/** 从 Markdown 内容中解析列表项 */
function parseListItems(content: string): string[] {
  const items: string[] = [];
  for (const line of content.split("\n")) {
    // 匹配 - item 或 * item 或 数字. item
    const match = line.match(/^\s*[-*]\s+(.+)$/) || line.match(/^\s*\d+\.\s+(.+)$/);
    if (match) {
      items.push(match[1].trim());
    }
  }
  return items;
}

/** 从 Markdown 内容中解析键值对（**key**: value 格式） */
function parseKeyValuePairs(content: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of content.split("\n")) {
    // 匹配 - **key**: value 或 **key**: value
    const match = line.match(/^\s*[-*]?\s*\*\*(.+?)\*\*\s*[:：]\s*(.+)$/);
    if (match) {
      pairs[match[1].trim()] = match[2].trim();
    }
  }
  return pairs;
}

/** 从段落中提取结构化规则 */
function extractRules(sections: ClaudeMdSection[], sourcePath: string, rawContent: string): ProjectRules {
  const rules: ProjectRules = { rawContent, sourcePath };

  for (const section of sections) {
    // 去掉标题中的序号前缀（如 "10. 权限系统增强" → "权限系统增强"）
    const titleClean = section.title.replace(/^\d+[\.\-\s]+/, "").trim().toLowerCase();

    // 精确匹配配置标题，避免误匹配文档描述性标题
    // 例如 "Instructions" 匹配，但 "10. 权限系统增强" 不匹配 "permission mode"
    if (titleClean === "instructions" || titleClean === "指令") {
      rules.instructions = (rules.instructions || "") + section.content + "\n";
    } else if (titleClean === "disallowed tools" || titleClean === "disallowed tool"
            || titleClean === "禁止的工具" || titleClean === "工具黑名单") {
      rules.disallowedTools = parseListItems(section.content);
    } else if (titleClean === "allowed tools" || titleClean === "allowed tool"
            || titleClean === "允许的工具" || titleClean === "工具白名单") {
      rules.allowedTools = parseListItems(section.content);
    } else if (titleClean === "permission mode" || titleClean === "permission"
            || titleClean === "权限模式") {
      const firstLine = section.content.trim().split("\n")[0];
      if (firstLine) rules.permissionMode = firstLine.trim();
    } else if (titleClean === "model" || titleClean === "模型") {
      const firstLine = section.content.trim().split("\n")[0];
      if (firstLine) rules.model = firstLine.trim();
    } else if (titleClean === "system prompt addition" || titleClean === "system prompt"
            || titleClean === "系统提示") {
      rules.systemPromptAddition = (rules.systemPromptAddition || "") + section.content + "\n";
    } else if (titleClean === "custom rules" || titleClean === "custom rule"
            || titleClean === "自定义规则") {
      rules.customRules = [...(rules.customRules || []), ...parseListItems(section.content)];
    } else if (titleClean === "memory" || titleClean === "记忆") {
      rules.memory = { ...(rules.memory || {}), ...parseKeyValuePairs(section.content) };
    }
  }

  // 清理 instructions 末尾空白
  if (rules.instructions) {
    rules.instructions = rules.instructions.trimEnd();
  }
  if (rules.systemPromptAddition) {
    rules.systemPromptAddition = rules.systemPromptAddition.trimEnd();
  }

  return rules;
}

/** 解析 CLAUDE.md 内容为结构化规则 */
export function parseClaudeMd(content: string, sourcePath: string): ProjectRules {
  const sections = splitSections(content);
  return extractRules(sections, sourcePath, content);
}

// ─── 多文件合并 ───

/**
 * 合并多层规则
 * - 覆盖型字段：后者覆盖前者（allowedTools, disallowedTools, permissionMode, model）
 * - 累积型字段：合并（instructions, customRules, memory, systemPromptAddition）
 * - rawContent：拼接所有来源
 */
export function mergeProjectRules(base: ProjectRules, override: ProjectRules): ProjectRules {
  return {
    // 原始内容拼接
    rawContent: base.rawContent + "\n\n---\n\n" + override.rawContent,
    sourcePath: override.sourcePath,

    // 累积型：合并
    instructions: [base.instructions, override.instructions].filter(Boolean).join("\n\n") || undefined,
    systemPromptAddition: [base.systemPromptAddition, override.systemPromptAddition].filter(Boolean).join("\n\n") || undefined,
    customRules: [...(base.customRules || []), ...(override.customRules || [])].length > 0
      ? [...(base.customRules || []), ...(override.customRules || [])]
      : undefined,
    memory: (base.memory || override.memory)
      ? { ...(base.memory || {}), ...(override.memory || {}) }
      : undefined,

    // 覆盖型：后者优先
    allowedTools: override.allowedTools || base.allowedTools,
    disallowedTools: override.disallowedTools || base.disallowedTools,
    permissionMode: override.permissionMode || base.permissionMode,
    model: override.model || base.model,
  };
}

// ─── 文件查找 ───

/** 向上查找 CLAUDE.md 文件（返回第一个找到的路径） */
export async function findCLAUDEmd(startDir: string): Promise<string | null> {
  const log = getLogger();
  let currentDir = startDir;
  const root = "/";

  while (currentDir !== root) {
    for (const filename of CLAUDE_MD_FILES) {
      const candidatePath = join(currentDir, filename);
      if (existsSync(candidatePath)) {
        log.debug("RULES", `找到项目 CLAUDE.md: ${candidatePath}`);
        return candidatePath;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  log.debug("RULES", "未找到项目级 CLAUDE.md");
  return null;
}

/** 查找全局 CLAUDE.md */
export function findGlobalCLAUDEmd(): string | null {
  const globalPath = join(homedir(), ".claude", "CLAUDE.md");
  if (existsSync(globalPath)) return globalPath;
  // 也检查 sid-code 自己的配置目录
  const sidCodePath = join(homedir(), ".sid-code", "CLAUDE.md");
  if (existsSync(sidCodePath)) return sidCodePath;
  return null;
}

/** 加载单个 CLAUDE.md 文件并解析 */
async function loadAndParse(filePath: string): Promise<ProjectRules | null> {
  const log = getLogger();
  try {
    const file = Bun.file(filePath);
    const content = await file.text();
    log.debug("RULES", `加载 CLAUDE.md: ${filePath} (${content.length} 字符)`);
    return parseClaudeMd(content, filePath);
  } catch (err) {
    log.error("RULES", `读取 CLAUDE.md 失败: ${filePath}`, err);
    return null;
  }
}

/**
 * 加载并合并所有 CLAUDE.md（全局 + 项目）
 * 返回合并后的结构化规则
 */
export async function loadAllCLAUDEmd(startDir: string): Promise<ProjectRules | null> {
  const log = getLogger();

  // 1. 加载全局 CLAUDE.md
  const globalPath = findGlobalCLAUDEmd();
  let globalRules: ProjectRules | null = null;
  if (globalPath) {
    globalRules = await loadAndParse(globalPath);
    if (globalRules) {
      log.info("RULES", `加载全局规则: ${globalPath}`);
    }
  }

  // 2. 加载项目 CLAUDE.md
  const projectPath = await findCLAUDEmd(startDir);
  let projectRules: ProjectRules | null = null;
  if (projectPath) {
    projectRules = await loadAndParse(projectPath);
    if (projectRules) {
      log.info("RULES", `加载项目规则: ${projectPath}`);
    }
  }

  // 3. 合并（项目覆盖全局）
  if (globalRules && projectRules) {
    log.info("RULES", "合并全局 + 项目规则");
    return mergeProjectRules(globalRules, projectRules);
  }

  return projectRules || globalRules;
}

/**
 * 兼容旧接口：加载 CLAUDE.md 原始内容
 * @deprecated 请使用 loadAllCLAUDEmd 获取结构化规则
 */
export async function loadCLAUDEmd(startDir: string): Promise<string | null> {
  const rules = await loadAllCLAUDEmd(startDir);
  return rules?.rawContent || null;
}

// ─── 文件变化监听 ───

/** 活跃的文件监听器 */
const activeWatchers: FSWatcher[] = [];

/**
 * 监听 CLAUDE.md 文件变化
 * 变化时清除系统提示词缓存，下次请求自动使用新规则
 */
export function watchCLAUDEmd(
  startDir: string,
  onChange?: (path: string) => void,
): void {
  const log = getLogger();

  // 收集需要监听的文件
  const filesToWatch: string[] = [];

  // 项目级
  const projectPath = findCLAUDEmdSync(startDir);
  if (projectPath) filesToWatch.push(projectPath);

  // 全局
  const globalPath = findGlobalCLAUDEmd();
  if (globalPath) filesToWatch.push(globalPath);

  if (filesToWatch.length === 0) {
    log.debug("RULES", "无 CLAUDE.md 文件需要监听");
    return;
  }

  for (const filePath of filesToWatch) {
    try {
      const watcher = watch(filePath, (eventType) => {
        if (eventType === "change") {
          log.info("RULES", `CLAUDE.md 变化检测: ${filePath}`);
          // 清除系统提示词缓存
          clearPromptCache();
          // 通知回调
          onChange?.(filePath);
        }
      });
      activeWatchers.push(watcher);
      log.debug("RULES", `开始监听: ${filePath}`);
    } catch (err) {
      log.warn("RULES", `监听 CLAUDE.md 失败: ${filePath}`, err);
    }
  }
}

/** 停止所有文件监听 */
export function unwatchCLAUDEmd(): void {
  for (const watcher of activeWatchers) {
    watcher.close();
  }
  activeWatchers.length = 0;
}

/** 同步版本的向上查找（用于监听初始化） */
function findCLAUDEmdSync(startDir: string): string | null {
  let currentDir = startDir;
  const root = "/";

  while (currentDir !== root) {
    for (const filename of CLAUDE_MD_FILES) {
      const candidatePath = join(currentDir, filename);
      if (existsSync(candidatePath)) return candidatePath;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return null;
}
