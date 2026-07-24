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
import { homedir, platform } from "os";
import { existsSync, watch, realpathSync } from "fs";
import type { FSWatcher } from "fs";
import { getLogger } from "../debug/logger.ts";
import { sidHomePath } from "./paths.ts";
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

/**
 * M6：用户级规则目录候选（~/.claude/rules 优先，回退 ~/.sid-code/rules）。
 * 优先级介于 user 层（全局 CLAUDE.md）之后、project 层之前。
 */
function userRulesDirs(): string[] {
  return [
    join(homedir(), ".claude", "rules"),
    join(homedir(), ".sid-code", "rules"),
  ];
}

/**
 * M8：企业级 managed 目录候选（按平台）。放合并链最前（最高优先级基座）。
 * - macOS: /Library/Application Support/SidCode
 * - Linux: /etc/sid-code
 * - Windows: %PROGRAMDATA%\SidCode（回退 C:\ProgramData\SidCode）
 */
function managedRootDirs(): string[] {
  const p = platform();
  if (p === "darwin") return ["/Library/Application Support/SidCode"];
  if (p === "win32") {
    const programData = process.env.PROGRAMDATA || "C:\\ProgramData";
    return [join(programData, "SidCode")];
  }
  // linux 及其它类 unix
  return ["/etc/sid-code"];
}

/**
 * M9：安全解析路径——若为 symlink 则跟随到 realpath，断链/不存在时回退原路径。
 * 用于规则目录扫描与循环检测，防 symlink 环 + 指向意外目标。
 */
function safeResolvePath(absolutePath: string): string {
  // 直接 realpathSync：解析路径中**所有**层级的 symlink（含父目录），
  // 得到唯一 canonical 路径，作为去重键最可靠（symlink 与真身归一）。
  try {
    return realpathSync(absolutePath);
  } catch {
    // 文件不存在 / 断链 / 权限 → 回退原路径（不抛异常）
    return absolutePath;
  }
}

/** frontmatter 块匹配（文件开头的 --- ... ---） */
const RULES_FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

// ─── M4：外部导入跳过收集器 ───
// processImports 遇到未批准的外部导入时经 onExternalSkipped 回调这里暂存。
// 上层（app 启动流程）加载完 CLAUDE.md 后调 consumeSkippedExternalImports()
// 判断是否需要弹审批对话框 / 注入 system-reminder。
const _skippedExternalImports = new Set<string>();

/** 记录一个被跳过的外部导入路径（M4）。 */
export function recordSkippedExternalImport(absolutePath: string): void {
  _skippedExternalImports.add(absolutePath);
}

/** 读取并清空被跳过的外部导入列表（M4）。 */
export function consumeSkippedExternalImports(): string[] {
  const list = [..._skippedExternalImports];
  _skippedExternalImports.clear();
  return list;
}

/** 只读快照：当前是否有被跳过的外部导入（不清空）。 */
export function hasSkippedExternalImports(): boolean {
  return _skippedExternalImports.size > 0;
}

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
  layer?: "managed" | "user" | "userRulesDir" | "project" | "subdir" | "rulesDir" | "local";
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

/**
 * M7：向上遍历父目录链，收集**所有**命中的 CLAUDE.md（不 early-return）。
 * 返回顺序：根（最浅）在前 → cwd（最深）在后，使越深的目录优先级越高（后者覆盖前者）。
 *
 * 上界：遍历到文件系统根或家目录为止（避免扫到无关的系统上层目录）。
 * 每一层只取第一个命中的候选文件名（同层多个候选取优先级最高的）。
 * 用 realpath 去重，防 symlink 使同一文件重复计入。
 */
export async function findCLAUDEmdChain(startDir: string): Promise<string[]> {
  const log = getLogger();
  const chain: string[] = [];
  const seen = new Set<string>();
  const home = homedir();
  let currentDir = startDir;
  const fsRoot = "/";

  // 上界：家目录的父目录（含家目录本身仍遍历），或文件系统根。
  const homeParent = dirname(home);

  while (true) {
    for (const filename of CLAUDE_MD_FILES) {
      const candidatePath = join(currentDir, filename);
      if (existsSync(candidatePath)) {
        const real = safeResolvePath(candidatePath);
        if (!seen.has(real)) {
          seen.add(real);
          chain.push(candidatePath);
          log.debug("RULES", `父链命中 CLAUDE.md: ${candidatePath}`);
        }
        break; // 同层只取第一个命中
      }
    }

    // 到达上界则停：文件系统根、或家目录父级（不再往系统上层扫）
    if (currentDir === fsRoot || currentDir === home || currentDir === homeParent) break;
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  // 反转：根在前、cwd 在后（越深优先级越高）
  chain.reverse();
  return chain;
}

/** 查找全局 CLAUDE.md */
export function findGlobalCLAUDEmd(): string | null {
  const globalPath = join(homedir(), ".claude", "CLAUDE.md");
  if (existsSync(globalPath)) return globalPath;
  // 也检查 sid-code 自己的配置目录
  const sidCodePath = sidHomePath("CLAUDE.md");
  if (existsSync(sidCodePath)) return sidCodePath;
  return null;
}

/**
 * M8：查找企业级 managed CLAUDE.md（按平台系统级目录）。
 * 最高优先级——放合并链最前作为组织策略基座（用户/项目无法覆盖其存在，但可累积）。
 * 返回第一个存在的 <managedRoot>/CLAUDE.md。
 */
export function findManagedCLAUDEmd(): string | null {
  const log = getLogger();
  for (const root of managedRootDirs()) {
    const candidate = join(root, "CLAUDE.md");
    if (existsSync(candidate)) {
      log.info("RULES", `找到企业级 managed CLAUDE.md: ${candidate}`);
      return candidate;
    }
  }
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
    // M4：外部导入（项目根之外，含 ~/）需批准。读 project 级批准位；未批准时外部导入被跳过。
    // 被跳过的外部导入经模块级收集器暂存，供上层注入 system-reminder 提示用户批准。
    let externalApproved = false;
    try {
      const { getClaudeMdExternalImportsApproved } = await import("./app-config.ts");
      externalApproved = getClaudeMdExternalImportsApproved(projectRoot) === true;
    } catch { /* 读批准位失败 → 保守按未批准处理 */ }
    content = await processImports(content, filePath, {
      allowedDirectories: allowedDirs,
      projectRoot,
      externalApproved,
      onExternalSkipped: (p) => recordSkippedExternalImport(p),
    });

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
 * 通用规则目录加载器：扫描 dir 下所有 *.md，按文件名排序逐个解析。
 * M9：跟随 symlink（Glob followSymlinks）+ realpath 去重防环——同一 realpath 只加载一次。
 *
 * @param dir         规则目录绝对路径
 * @param layer       赋给加载结果的 layer 标记
 * @param parseRoot   传给 loadAndParse 的 projectRoot（决定 @import 的 allowedDirs / 外部判定）
 * @param seen        跨调用共享的 realpath 去重集合（防同一文件经不同 symlink 重复加载）
 */
async function loadRulesFromDir(
  dir: string,
  layer: NonNullable<ProjectRules["layer"]>,
  parseRoot: string | undefined,
  seen: Set<string>,
): Promise<ProjectRules[]> {
  const log = getLogger();
  if (!existsSync(dir)) return [];

  const out: ProjectRules[] = [];
  try {
    const entries = await Array.fromAsync(
      // followSymlinks:true —— 跟随目录/文件 symlink（对齐 CC safeResolvePath 语义）
      new Bun.Glob("**/*.md").scan({ cwd: dir, onlyFiles: true, followSymlinks: true }),
    );
    entries.sort();
    for (const rel of entries) {
      const full = join(dir, rel);
      // M9：realpath 归一去重，防 symlink 环 / 重复指向同一文件
      const real = safeResolvePath(full);
      if (seen.has(real)) {
        log.debug("RULES", `规则文件已加载（symlink 去重），跳过: ${full}`);
        continue;
      }
      seen.add(real);
      const rules = await loadAndParse(full, parseRoot);
      if (rules) {
        rules.layer = layer;
        out.push(rules);
        log.debug("RULES", `加载规则目录文件[${layer}]: ${full}`);
      }
    }
  } catch (err) {
    log.debug("RULES", `加载规则目录失败: ${dir}`, err);
  }
  return out;
}

/**
 * 加载项目级 .claude/rules/ 目录下的所有 *.md 规则文件（rulesDir 层）。
 */
async function loadRulesDir(projectRoot: string, seen: Set<string>): Promise<ProjectRules[]> {
  return loadRulesFromDir(join(projectRoot, CLAUDE_RULES_DIR), "rulesDir", projectRoot, seen);
}

/**
 * M6：加载用户级规则目录（~/.claude/rules 优先，回退 ~/.sid-code/rules）。
 * layer=userRulesDir，优先级在 user 层之后、project 层之前。
 * 两个候选都存在时都加载（去重由 seen 保证）。
 */
async function loadUserRulesDir(seen: Set<string>): Promise<ProjectRules[]> {
  const out: ProjectRules[] = [];
  for (const dir of userRulesDirs()) {
    // parseRoot 传 homedir：允许 @import 家目录内文件（视作内部，不触发外部审批）
    const rules = await loadRulesFromDir(dir, "userRulesDir", homedir(), seen);
    out.push(...rules);
  }
  return out;
}

/**
 * M8：加载企业级 managed 规则目录（<managedRoot>/rules/*.md）。
 * layer=managed，最高优先级（放合并链最前）。
 */
async function loadManagedRulesDir(seen: Set<string>): Promise<ProjectRules[]> {
  const out: ProjectRules[] = [];
  for (const root of managedRootDirs()) {
    const rules = await loadRulesFromDir(join(root, "rules"), "managed", undefined, seen);
    out.push(...rules);
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
  // M9：跨所有规则目录/文件共享的 realpath 去重集合，防 symlink 重复加载 / 环。
  const seenRealPaths = new Set<string>();

  // 0. M8：加载企业级 managed CLAUDE.md（最高优先级基座，放合并链最前）
  const managedPath = findManagedCLAUDEmd();
  let managedRules: ProjectRules | null = null;
  if (managedPath) {
    managedRules = await loadAndParse(managedPath);
    if (managedRules) {
      managedRules.layer = "managed";
      seenRealPaths.add(safeResolvePath(managedPath));
      log.info("RULES", `加载企业级 managed 规则: ${managedPath}`);
    }
  }

  // 0.5 M8：加载企业级 managed 规则目录（<managedRoot>/rules/*.md）
  const managedRulesDirRules = await loadManagedRulesDir(seenRealPaths);

  // 1. 加载全局 CLAUDE.md（User 层）
  const globalPath = findGlobalCLAUDEmd();
  let globalRules: ProjectRules | null = null;
  if (globalPath) {
    globalRules = await loadAndParse(globalPath);
    if (globalRules) {
      globalRules.layer = "user";
      seenRealPaths.add(safeResolvePath(globalPath));
      log.info("RULES", `加载全局规则: ${globalPath}`);
    }
  }

  // 1.5 M6：加载用户级规则目录（~/.claude/rules 或 ~/.sid-code/rules），userRulesDir 层
  const userRulesDirRules = await loadUserRulesDir(seenRealPaths);

  // 2. M7：加载父目录链上**所有** CLAUDE.md（根在前、cwd 在后，越深优先级越高）
  //    取代原来只加载最近一个根的做法。
  const chain = await findCLAUDEmdChain(startDir);
  // 过滤掉已被 managed/global 加载的（realpath 去重）
  const chainFiltered = chain.filter((p) => !seenRealPaths.has(safeResolvePath(p)));
  // 项目根 = 父链最深一层所在目录（无命中时回退 startDir），供子目录/rulesDir 定位
  const projectPath = chainFiltered.length > 0 ? chainFiltered[chainFiltered.length - 1] : null;
  const projectRoot = projectPath ? dirname(projectPath) : startDir;

  let projectChainRules: ProjectRules | null = null;
  for (const p of chainFiltered) {
    seenRealPaths.add(safeResolvePath(p));
    const rules = await loadAndParse(p, projectRoot);
    if (rules) {
      // 最深一层标 project，其余父层标 subdir（语义：父层是外围上下文）
      rules.layer = p === projectPath ? "project" : "subdir";
      log.info("RULES", `加载父链规则[${rules.layer}]: ${p}`);
      projectChainRules = projectChainRules ? mergeProjectRules(projectChainRules, rules) : rules;
    }
  }

  // 3. 查找并加载子目录 CLAUDE.md（Subdir 层）
  const subFiles = await findProjectCLAUDEmdFiles(projectRoot);
  // 过滤掉已加载的（父链 / 全局 / managed，realpath 去重）
  const subFilesFiltered = subFiles.filter((f) => !seenRealPaths.has(safeResolvePath(f)));

  let subRules: ProjectRules | null = null;
  for (const subFile of subFilesFiltered) {
    seenRealPaths.add(safeResolvePath(subFile));
    const rules = await loadAndParse(subFile, projectRoot);
    if (rules) {
      rules.layer = "subdir";
      log.info("RULES", `加载子目录规则: ${subFile}`);
      subRules = subRules ? mergeProjectRules(subRules, rules) : rules;
    }
  }

  // 4. 加载 .claude/rules/ 目录规则（rulesDir 层）
  const rulesDirRules = await loadRulesDir(projectRoot, seenRealPaths);

  // 5. 加载本地私有规则（Local 层，优先级最高）
  const localRules = await loadLocalRules(projectRoot);

  // 6. 按优先级链合并，frontmatter paths 不匹配的规则被跳过
  //    顺序（后者覆盖/累积在前者之上）：
  //    managed → user → userRulesDir → 父链(project+subdir) → 子目录 → rulesDir → local
  const ordered: (ProjectRules | null)[] = [
    managedRules,
    ...managedRulesDirRules,
    globalRules,
    ...userRulesDirRules,
    projectChainRules,
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

  // M10：变更去抖——目录级监听 fs.watch 对单次保存可能触发多个事件，
  // 且规则重建（重读盘 + 重展开 @import）较重，200ms 去抖合并抖动。
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const fireChange = (path: string) => {
    log.info("RULES", `规则变更检测: ${path}`);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // 清除系统提示词缓存
      clearPromptCache();
      // 通知回调
      onChange?.(path);
    }, 200);
  };

  // 收集需要监听的文件
  const filesToWatch: string[] = [];

  // 项目级
  const projectPath = findCLAUDEmdSync(startDir);
  if (projectPath) filesToWatch.push(projectPath);

  // 全局
  const globalPath = findGlobalCLAUDEmd();
  if (globalPath) filesToWatch.push(globalPath);

  // M8：企业级 managed CLAUDE.md
  const managedPath = findManagedCLAUDEmd();
  if (managedPath) filesToWatch.push(managedPath);

  // M10：目录级监听——.claude/rules/ + 用户级 rules 目录。
  // 目录内 *.md 增删改都触发重建（fs.watch 目录级，recursive 尽力而为）。
  const projectRoot = projectPath ? dirname(projectPath) : startDir;
  const dirsToWatch: string[] = [join(projectRoot, CLAUDE_RULES_DIR), ...userRulesDirs()];

  if (filesToWatch.length === 0 && dirsToWatch.every((d) => !existsSync(d))) {
    log.debug("RULES", "无 CLAUDE.md / rules 目录需要监听");
    return;
  }

  for (const filePath of filesToWatch) {
    try {
      const watcher = watch(filePath, (eventType) => {
        if (eventType === "change" || eventType === "rename") {
          fireChange(filePath);
        }
      });
      activeWatchers.push(watcher);
      log.debug("RULES", `开始监听文件: ${filePath}`);
    } catch (err) {
      log.warn("RULES", `监听 CLAUDE.md 失败: ${filePath}`, err);
    }
  }

  // M10：监听 rules 目录（仅对 .md 变更触发）
  for (const dir of dirsToWatch) {
    if (!existsSync(dir)) continue;
    try {
      // recursive:true 在 macOS/Windows 支持；Linux 尽力而为（顶层 .md 仍可监听）
      const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
        // 仅 .md 文件变更才重建（忽略临时文件 / 非规则文件）
        if (filename && !String(filename).endsWith(".md")) return;
        if (eventType === "change" || eventType === "rename") {
          fireChange(join(dir, String(filename ?? "")));
        }
      });
      activeWatchers.push(watcher);
      log.debug("RULES", `开始监听规则目录: ${dir}`);
    } catch (err) {
      log.warn("RULES", `监听规则目录失败: ${dir}`, err);
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
