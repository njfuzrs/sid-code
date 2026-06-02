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

/** 本地私有规则文件名（不检入代码库，优先级最高） */
const CLAUDE_LOCAL_FILES = [
  "CLAUDE.local.md",
  ".claude/CLAUDE.local.md",
] as const;

/** 项目规则目录（.claude/rules/*.md） */
const CLAUDE_RULES_DIR = ".claude/rules";

/** frontmatter 块匹配（文件开头的 --- ... ---） */
const RULES_FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

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
  /**
   * frontmatter paths 条件过滤（glob 模式数组）。
   * 仅当当前工作的文件路径匹配任一 glob 时，此规则才生效。
   * 为空 / undefined 表示无条件生效。
   */
  paths?: string[];
  /** 规则层级（用于调试与优先级展示） */
  layer?: "user" | "project" | "subdir" | "rulesDir" | "local";
}

/**
 * 解析文件开头的 frontmatter，返回 { paths, body }。
 * 只支持 `paths:` 字段（数组或逗号分隔），其余忽略。
 */
export function parseRulesFrontmatter(content: string): { paths?: string[]; body: string } {
  const m = content.match(RULES_FRONTMATTER_RE);
  if (!m) return { body: content };
  const block = m[1];
  const body = content.slice(m[0].length);
  let paths: string[] | undefined;

  // 支持两种写法：
  //   paths: ["src/**", "lib/**"]
  //   paths:
  //     - src/**
  //     - lib/**
  const inlineMatch = block.match(/^paths:\s*\[(.*)\]\s*$/m);
  if (inlineMatch) {
    paths = inlineMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  } else {
    const lines = block.split("\n");
    const idx = lines.findIndex((l) => /^paths:\s*$/.test(l));
    if (idx >= 0) {
      const collected: string[] = [];
      for (let i = idx + 1; i < lines.length; i++) {
        const itemMatch = lines[i].match(/^\s*-\s*(.+?)\s*$/);
        if (!itemMatch) break;
        collected.push(itemMatch[1].replace(/^["']|["']$/g, ""));
      }
      if (collected.length > 0) paths = collected;
    } else {
      // 单值写法 paths: src/**
      const singleMatch = block.match(/^paths:\s*(.+?)\s*$/m);
      if (singleMatch) {
        paths = singleMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }
    }
  }
  return { paths, body };
}

/**
 * 判断规则的 paths 条件是否匹配给定的活动文件列表。
 * - 无 paths 条件：始终匹配
 * - 有 paths 条件：任一 activeFile 匹配任一 glob 即生效
 */
export function rulesPathsMatch(paths: string[] | undefined, activeFiles: string[]): boolean {
  if (!paths || paths.length === 0) return true;
  if (activeFiles.length === 0) return false;
  for (const pattern of paths) {
    const glob = new Bun.Glob(pattern);
    for (const file of activeFiles) {
      if (glob.match(file)) return true;
    }
  }
  return false;
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

    // 累积型字段用 includes 匹配（宽松，多匹配无害）
    // 覆盖型字段（permission/model）用精确匹配（严格，防止文档标题误匹配）
    if (titleClean.includes("instruction") || titleClean.includes("指令")) {
      rules.instructions = (rules.instructions || "") + section.content + "\n";
    } else if (titleClean.includes("disallowed tool") || titleClean.includes("禁止的工具") || titleClean.includes("工具黑名单")) {
      rules.disallowedTools = parseListItems(section.content);
    } else if (titleClean.includes("allowed tool") || titleClean.includes("允许的工具") || titleClean.includes("工具白名单")) {
      rules.allowedTools = parseListItems(section.content);
    } else if (titleClean === "permission mode" || titleClean === "permission"
            || titleClean === "权限模式") {
      // 精确匹配：避免 "权限系统增强" 等文档标题误匹配
      const firstLine = section.content.trim().split("\n")[0];
      if (firstLine) rules.permissionMode = firstLine.trim();
    } else if (titleClean === "model" || titleClean === "模型") {
      // 精确匹配：避免 "模型切换功能" 等文档标题误匹配
      const firstLine = section.content.trim().split("\n")[0];
      if (firstLine) rules.model = firstLine.trim();
    } else if (titleClean.includes("system prompt") || titleClean.includes("系统提示")) {
      rules.systemPromptAddition = (rules.systemPromptAddition || "") + section.content + "\n";
    } else if (titleClean.includes("custom rule") || titleClean.includes("自定义规则")) {
      rules.customRules = [...(rules.customRules || []), ...parseListItems(section.content)];
    } else if (titleClean.includes("memory") || titleClean.includes("记忆")) {
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
  // 先剥离 frontmatter（提取 paths 条件），用 body 做段落解析
  const { paths, body } = parseRulesFrontmatter(content);
  const sections = splitSections(body);
  const rules = extractRules(sections, sourcePath, content);
  if (paths) rules.paths = paths;
  return rules;
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
    // paths 条件在合并前已被各文件单独应用；合并结果无条件生效（不再携带 paths）
    layer: override.layer || base.layer,
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
async function loadAndParse(filePath: string, projectRoot?: string): Promise<ProjectRules | null> {
  const log = getLogger();
  try {
    const file = Bun.file(filePath);
    let content = await file.text();

    // 处理 @import 指令
    const { processImports } = await import("./import-processor.ts");
    const allowedDirs = projectRoot ? [projectRoot, homedir()] : [homedir()];
    content = await processImports(content, filePath, { allowedDirectories: allowedDirs });

    log.debug("RULES", `加载 CLAUDE.md: ${filePath} (${content.length} 字符)`);
    return parseClaudeMd(content, filePath);
  } catch (err) {
    log.error("RULES", `读取 CLAUDE.md 失败: ${filePath}`, err);
    return null;
  }
}

/**
 * 在项目根目录下递归搜索 CLAUDE.md 文件。
 * - BFS 搜索，最大深度 3 层
 * - 跳过 node_modules、.git、dist 等目录
 * - 文件身份去重（处理大小写不敏感文件系统）
 */
async function findProjectCLAUDEmdFiles(projectRoot: string): Promise<string[]> {
  const log = getLogger();
  const found: string[] = [];
  const visited = new Set<string>();
  const maxDepth = 3;

  // 需要跳过的目录
  const skipDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "coverage",
    ".cache",
    "tmp",
    "temp",
  ]);

  async function searchDir(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    // 去重（处理大小写不敏感文件系统）
    const normalizedDir = dir.toLowerCase();
    if (visited.has(normalizedDir)) return;
    visited.add(normalizedDir);

    try {
      const entries = await Array.fromAsync(
        new Bun.Glob("*").scan({ cwd: dir, onlyFiles: false })
      );

      for (const entry of entries) {
        const fullPath = join(dir, entry);

        // 检查是否是 CLAUDE.md 文件
        if (CLAUDE_MD_FILES.some(name => entry === name || fullPath.endsWith(name))) {
          if (existsSync(fullPath)) {
            found.push(fullPath);
            log.debug("RULES", `发现子目录 CLAUDE.md: ${fullPath}`);
          }
          continue;
        }

        // 递归搜索子目录
        if (!skipDirs.has(entry)) {
          try {
            const stat = await Bun.file(fullPath).stat();
            if (stat.isDirectory()) {
              await searchDir(fullPath, depth + 1);
            }
          } catch {
            // 忽略无法访问的目录
          }
        }
      }
    } catch (err) {
      log.debug("RULES", `搜索目录失败: ${dir}`, err);
    }
  }

  await searchDir(projectRoot, 0);
  return found;
}

/**
 * 加载 .claude/rules/ 目录下的所有 *.md 规则文件。
 * 按文件名排序，逐个解析（各自可带 frontmatter paths 条件）。
 */
async function loadRulesDir(projectRoot: string): Promise<ProjectRules[]> {
  const log = getLogger();
  const rulesDir = join(projectRoot, CLAUDE_RULES_DIR);
  if (!existsSync(rulesDir)) return [];

  const out: ProjectRules[] = [];
  try {
    const entries = await Array.fromAsync(
      new Bun.Glob("**/*.md").scan({ cwd: rulesDir, onlyFiles: true }),
    );
    entries.sort();
    for (const rel of entries) {
      const full = join(rulesDir, rel);
      const rules = await loadAndParse(full, projectRoot);
      if (rules) {
        rules.layer = "rulesDir";
        out.push(rules);
        log.debug("RULES", `加载规则目录文件: ${full}`);
      }
    }
  } catch (err) {
    log.debug("RULES", `加载 .claude/rules/ 失败: ${rulesDir}`, err);
  }
  return out;
}

/**
 * 加载本地私有规则 CLAUDE.local.md（不检入代码库，优先级最高）。
 */
async function loadLocalRules(projectRoot: string): Promise<ProjectRules | null> {
  const log = getLogger();
  for (const name of CLAUDE_LOCAL_FILES) {
    const candidate = join(projectRoot, name);
    if (existsSync(candidate)) {
      const rules = await loadAndParse(candidate, projectRoot);
      if (rules) {
        rules.layer = "local";
        log.info("RULES", `加载本地私有规则: ${candidate}`);
        return rules;
      }
    }
  }
  return null;
}

/**
 * 加载并合并所有 CLAUDE.md（全局 + 项目根 + 子目录）
 * 返回合并后的结构化规则。
 *
 * 优先级链（后者覆盖/累积在前者之上）：
 *   User(全局) → Project(项目根) → Subdir(子目录) → rulesDir(.claude/rules/) → Local(CLAUDE.local.md)
 *
 * @param startDir   起始目录
 * @param opts.activeFiles  当前活动文件列表（相对项目根），用于 frontmatter paths 条件过滤
 */
export async function loadAllCLAUDEmd(
  startDir: string,
  opts?: { activeFiles?: string[] },
): Promise<ProjectRules | null> {
  const log = getLogger();
  const activeFiles = opts?.activeFiles ?? [];

  // 1. 加载全局 CLAUDE.md（User 层）
  const globalPath = findGlobalCLAUDEmd();
  let globalRules: ProjectRules | null = null;
  if (globalPath) {
    globalRules = await loadAndParse(globalPath);
    if (globalRules) {
      globalRules.layer = "user";
      log.info("RULES", `加载全局规则: ${globalPath}`);
    }
  }

  // 2. 加载项目根 CLAUDE.md（Project 层）
  const projectPath = await findCLAUDEmd(startDir);
  let projectRules: ProjectRules | null = null;
  if (projectPath) {
    projectRules = await loadAndParse(projectPath, startDir);
    if (projectRules) {
      projectRules.layer = "project";
      log.info("RULES", `加载项目规则: ${projectPath}`);
    }
  }

  // 3. 查找并加载子目录 CLAUDE.md（Subdir 层）
  const projectRoot = projectPath ? dirname(projectPath) : startDir;
  const subFiles = await findProjectCLAUDEmdFiles(projectRoot);

  // 过滤掉已经加载的根文件
  const subFilesFiltered = subFiles.filter(f => f !== projectPath && f !== globalPath);

  let subRules: ProjectRules | null = null;
  for (const subFile of subFilesFiltered) {
    const rules = await loadAndParse(subFile, projectRoot);
    if (rules) {
      rules.layer = "subdir";
      log.info("RULES", `加载子目录规则: ${subFile}`);
      subRules = subRules ? mergeProjectRules(subRules, rules) : rules;
    }
  }

  // 4. 加载 .claude/rules/ 目录规则（rulesDir 层）
  const rulesDirRules = await loadRulesDir(projectRoot);

  // 5. 加载本地私有规则（Local 层，优先级最高）
  const localRules = await loadLocalRules(projectRoot);

  // 6. 按优先级链合并，frontmatter paths 不匹配的规则被跳过
  const ordered: (ProjectRules | null)[] = [
    globalRules,
    projectRules,
    subRules,
    ...rulesDirRules,
    localRules,
  ];

  let merged: ProjectRules | null = null;
  for (const r of ordered) {
    if (!r) continue;
    // frontmatter paths 条件过滤
    if (!rulesPathsMatch(r.paths, activeFiles)) {
      log.debug("RULES", `规则 paths 条件不匹配，跳过: ${r.sourcePath}`);
      continue;
    }
    merged = merged ? mergeProjectRules(merged, r) : r;
  }

  if (merged) {
    log.info("RULES", "规则合并完成");
  }

  return merged;
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
