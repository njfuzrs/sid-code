/**
 * 系统提示词构建模块
 * 对标 Claude Code 的 11 部分动态拼接：固定模板 + 动态附件 + 优先级排序 + Token 截断 + 缓存
 */

import type { LegacyTool as Tool } from "../tool/types.ts";
import type { Attachment } from "./attachments.ts";
import { platform, homedir } from "os";
import { cwd } from "process";
import { estimateTokens, truncateToLimit } from "./token-utils.ts";
import {
  PRIORITY,
  generateClaudeMdAttachment,
  generateGitStatusAttachment,
  generatePermissionModeAttachment,
  generateDiagnosticsAttachment,
  generateIDESelectionAttachment,
  generateTodoListAttachment,
  generateMemoryAttachment,
} from "./attachments.ts";
import { getLogger } from "../debug/logger.ts";

/** 系统提示词构建上下文 */
export interface SystemPromptContext {
  // 基础
  /** 已注册的工具实例（用于获取 usageGuide） */
  tools: Tool[];
  /** 项目规则（CLAUDE.md 内容） */
  projectRules?: string;
  /** 项目规则来源路径（用于注入时标注） */
  projectRulesPath?: string;
  /** 追加的系统提示词 */
  appendPrompt?: string;
  /** 从文件加载的系统提示词 */
  filePrompt?: string;

  // 动态上下文
  /** 工作目录 */
  workingDir?: string;
  /** 权限模式 */
  permissionMode?: string;
  /** 是否包含 Git 状态 */
  gitStatus?: boolean;
  /** IDE 选中代码 */
  ideSelection?: string;
  /** 诊断信息 */
  diagnostics?: string;
  /** Todo 列表 */
  todoList?: string;
  /** 记忆摘要（全局/项目双层记忆） */
  memorySummary?: string;

  // 限制
  /** 系统提示词最大 token 数（默认 180000） */
  maxTokens?: number;
}

/** 缓存条目 */
interface CacheEntry {
  content: string;
  timestamp: number;
}

/** 缓存配置 */
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const CACHE_MAX_SIZE = 100;

/** 缓存存储 */
const cache = new Map<string, CacheEntry>();

/** 简单字符串 hash（用于缓存键） */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // 转为 32 位整数
  }
  return hash.toString(36);
}

/** 生成缓存键 */
function generateCacheKey(ctx: SystemPromptContext): string {
  return [
    ctx.workingDir || cwd(),
    ctx.permissionMode || "default",
    ctx.gitStatus ? "git" : "nogit",
    ctx.tools.length.toString(),
    ctx.projectRules ? simpleHash(ctx.projectRules) : "",
    ctx.appendPrompt ? simpleHash(ctx.appendPrompt) : "",
    ctx.filePrompt ? simpleHash(ctx.filePrompt) : "",
    ctx.ideSelection ? simpleHash(ctx.ideSelection) : "",
    ctx.diagnostics ? simpleHash(ctx.diagnostics) : "",
    ctx.todoList ? simpleHash(ctx.todoList) : "",
    ctx.memorySummary ? simpleHash(ctx.memorySummary) : "",
  ].filter(Boolean).join(":");
}

/** 清理过期缓存 */
function cleanExpiredCache(): void {
  if (cache.size < CACHE_MAX_SIZE) return;

  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      cache.delete(key);
    }
  }
}

/** 清除所有缓存（供外部调用，如 CLAUDE.md 变更时） */
export function clearPromptCache(): void {
  cache.clear();
}

/**
 * 构建完整的系统提示词
 * 固定模板（身份、环境、工具指南、约束）+ 动态附件（按优先级排序）+ Token 截断 + 缓存
 */
export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const log = getLogger();

  // 检查缓存
  const cacheKey = generateCacheKey(ctx);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    log.debug("PROMPT", "使用缓存的系统提示词");
    return cached.content;
  }

  // 清理过期缓存
  cleanExpiredCache();

  // 1. 构建核心部分（固定模板，必须保留）
  const coreParts: string[] = [
    buildIdentitySection(),
    buildEnvironmentSection(ctx.workingDir),
  ];

  if (ctx.tools.length > 0) {
    coreParts.push(buildToolGuideSection(ctx.tools));
  }

  coreParts.push(buildConstraintsSection());

  // 2. 收集动态附件
  const attachments: Attachment[] = [];

  // 权限模式提示词
  if (ctx.permissionMode && ctx.permissionMode !== "default") {
    attachments.push(generatePermissionModeAttachment(ctx.permissionMode));
  }

  // CLAUDE.md 项目规则
  if (ctx.projectRules) {
    attachments.push(generateClaudeMdAttachment(ctx.projectRules, ctx.projectRulesPath));
  }

  // Git 状态
  if (ctx.gitStatus) {
    const workDir = ctx.workingDir || cwd();
    const gitAttachment = generateGitStatusAttachment(workDir);
    if (gitAttachment) {
      attachments.push(gitAttachment);
    }
  }

  // IDE 选中代码
  if (ctx.ideSelection) {
    attachments.push(generateIDESelectionAttachment(ctx.ideSelection));
  }

  // 诊断信息
  if (ctx.diagnostics) {
    attachments.push(generateDiagnosticsAttachment(ctx.diagnostics));
  }

  // Todo 列表
  if (ctx.todoList) {
    attachments.push(generateTodoListAttachment(ctx.todoList));
  }

  // 记忆（全局/项目双层）
  if (ctx.memorySummary) {
    attachments.push(generateMemoryAttachment(ctx.memorySummary));
  }

  // 追加提示词
  if (ctx.appendPrompt) {
    attachments.push({
      type: "append",
      label: "追加提示词",
      content: ctx.appendPrompt,
      priority: PRIORITY.APPEND_PROMPT,
    });
  }

  // 文件提示词
  if (ctx.filePrompt) {
    attachments.push({
      type: "file",
      label: "文件提示词",
      content: ctx.filePrompt,
      priority: PRIORITY.FILE_PROMPT,
    });
  }

  // 3. 按优先级排序（数字越小越靠前）
  attachments.sort((a, b) => a.priority - b.priority);

  // 记录每个附件的名称和 token 数
  for (const att of attachments) {
    const attTokens = estimateTokens(att.content);
    const displayName = att.label || att.type;
    log.info("PROMPT", `附件: ${displayName}(${(attTokens / 1000).toFixed(1)}K tok, priority=${att.priority})`);
  }

  // 4. 拼接所有部分（静态区 + DYNAMIC_BOUNDARY + 动态区）
  const staticContent = coreParts.join("\n\n");
  const dynamicParts = attachments.map((a) => a.content);

  // 插入 DYNAMIC_BOUNDARY 标记（提示 LLM provider 在此处设置 cache_control: ephemeral）
  const DYNAMIC_BOUNDARY = "\n\n<!-- DYNAMIC_BOUNDARY -->\n\n";
  let content: string;
  if (dynamicParts.length > 0) {
    content = staticContent + DYNAMIC_BOUNDARY + dynamicParts.join("\n\n");
  } else {
    content = staticContent;
  }

  // 5. Token 估算和截断
  const maxTokens = ctx.maxTokens || 180000;
  const tokens = estimateTokens(content);

  if (tokens > maxTokens) {
    log.warn("PROMPT", `系统提示词超限 (${tokens} > ${maxTokens} tokens)，执行截断`);
    const result = truncateToLimit(coreParts, attachments, maxTokens);
    content = result.content;
    // 记录截断详情
    if (result.truncated) {
      const name = result.truncated.label || result.truncated.type;
      log.info("PROMPT", `附件被部分截断: ${name}(priority=${result.truncated.priority})`);
    }
    for (const att of result.discarded) {
      const name = att.label || att.type;
      log.info("PROMPT", `附件被丢弃: ${name}(priority=${att.priority})`);
    }
    log.info("PROMPT", `截断后 ${estimateTokens(content)} tokens, 包含${result.included.length}个附件, 丢弃${result.discarded.length}个`);
  }

  log.info("PROMPT", `系统提示词构建完成: ${content.length}字符, ~${estimateTokens(content)} tokens, ${attachments.length}个附件`);

  // 6. 写入缓存
  cache.set(cacheKey, { content, timestamp: Date.now() });

  return content;
}

/** 构建身份指令部分 */
function buildIdentitySection(): string {
  return `你是 sid-code AI 编程助手，一个专业的代码辅助工具。你可以：
- 帮助用户编写、修改、调试代码
- 执行 shell 命令、读写文件
- 解释技术概念、提供最佳实践建议
- 使用工具完成复杂任务

你的回复应该简洁、专业、可操作。`;
}

/** 构建环境信息部分 */
function buildEnvironmentSection(workingDir?: string): string {
  const workDir = workingDir || cwd();
  const homeDir = homedir();
  const os = platform();
  const shell = process.env.SHELL || "unknown";
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  return `
<environment>
## 环境信息
- 工作目录: ${workDir}
- 用户主目录: ${homeDir}
- 操作系统: ${os}
- Shell: ${shell}
- 当前日期: ${date}
</environment>`;
}

/** 构建工具使用指南部分 */
function buildToolGuideSection(tools: Tool[]): string {
  const toolList = tools.map((t) => `  - ${t.name()}: ${t.description()}`).join("\n");

  // 收集工具自带的使用指南
  const customGuides: string[] = [];
  for (const tool of tools) {
    if (tool.usageGuide) {
      const guide = tool.usageGuide();
      if (guide) {
        customGuides.push(`\n### ${tool.name()} 工具使用指南\n${guide}`);
      }
    }
  }

  return `
<tool-guide>
## 可用工具
你可以使用以下工具完成任务：

${toolList}

### 工具使用原则
1. **优先使用专用工具**：例如用 read 读文件，不要用 bash cat
2. **并行执行只读工具**：多个 read/grep/glob 可以并行调用
3. **串行执行写入工具**：write/edit/bash 必须串行执行，避免冲突
4. **先读后写**：修改文件前必须先用 read 读取内容
5. **验证结果**：执行写入操作后，用 read 或 bash 验证结果
6. **错误处理**：工具执行失败时，分析错误原因，调整参数重试

### 常见任务模式
- **读取文件**: 使用 read 工具，支持行偏移和限制
- **搜索文件**: 使用 glob 工具（按文件名）或 grep 工具（按内容）
- **修改文件**: 先 read 读取，再 edit 精确替换（不要用 bash sed）
- **创建文件**: 使用 write 工具（不要用 bash echo 或 cat）
- **执行命令**: 使用 bash 工具，必须提供 description 参数说明命令意图，设置合理的超时时间
- **搜索内容**: grep 工具默认只返回文件路径（省 token），需要看内容时用 output_mode=content
${customGuides.length > 0 ? "\n" + customGuides.join("\n") : ""}
</tool-guide>`;
}

/** 构建行为约束部分 */
function buildConstraintsSection(): string {
  return `
<constraints>
## 行为约束
1. **语言要求**: 所有回复、代码注释、文档均使用中文
2. **先确认再行动**: 对于破坏性操作（删除文件、强制推送等），先向用户确认
3. **最小化修改**: 只修改必要的代码，不要过度重构或添加不必要的功能
4. **保持简洁**: 回复简洁明了，避免冗长的解释
5. **安全第一**: 不执行危险命令，不泄露敏感信息
6. **验证假设**: 不确定时，先用工具验证（如检查文件是否存在）
7. **错误透明**: 遇到错误时，如实告知用户，不要隐藏或猜测
</constraints>`;
}
