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
  generateIDEMentionAttachment,
  generateTodoListAttachment,
  generateMemoryAttachment,
  generateRecalledMemoryAttachment,
  generateSessionMemoryAttachment,
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
  /** IDE @提及（已格式化的位置列表文本） */
  ideMention?: string;
  /** 诊断信息 */
  diagnostics?: string;
  /** Todo 列表 */
  todoList?: string;
  /** 记忆摘要（全局/项目双层记忆） */
  memorySummary?: string;
  /** MEMORY.md 索引内容 + 记忆系统指令（Task 7） */
  memorySystemPrompt?: string;
  /** 动态召回的相关记忆（Task 7） */
  recalledMemories?: Array<{ filename: string; content: string }>;
  /** Session Memory 内容（压缩后注入，Task 7） */
  sessionMemoryContent?: string;

  // 语言偏好
  /** 首选输出语言: "zh" 中文优先, "en" 英文优先。不设置时默认中文 */
  preferredLanguage?: "zh" | "en";

  // 模型标识（用于 DeepSeek 等模型的语言策略差异化处理）
  /** 当前使用的模型名（如 "deepseek-chat"、"claude-sonnet-4-20250514"） */
  model?: string;

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
    ctx.ideMention ? simpleHash(ctx.ideMention) : "",
    ctx.diagnostics ? simpleHash(ctx.diagnostics) : "",
    ctx.todoList ? simpleHash(ctx.todoList) : "",
    ctx.memorySummary ? simpleHash(ctx.memorySummary) : "",
    ctx.memorySystemPrompt ? simpleHash(ctx.memorySystemPrompt) : "",
    ctx.recalledMemories?.length
      ? simpleHash(ctx.recalledMemories.map((m) => m.filename).join(","))
      : "",
    ctx.sessionMemoryContent ? simpleHash(ctx.sessionMemoryContent) : "",
    ctx.model || "",
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
    buildIdentitySection(ctx.preferredLanguage, ctx.model),
    buildEnvironmentSection(ctx.workingDir),
  ];

  if (ctx.tools.length > 0) {
    coreParts.push(buildToolGuideSection(ctx.tools));
  }

  coreParts.push(buildConstraintsSection(ctx.preferredLanguage));

  // 记忆系统指令 + MEMORY.md 索引（Task 7，作为核心部分注入）
  if (ctx.memorySystemPrompt) {
    coreParts.push(ctx.memorySystemPrompt);
  }

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

  // IDE @提及
  if (ctx.ideMention) {
    attachments.push(generateIDEMentionAttachment(ctx.ideMention));
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

  // 动态召回的相关记忆（Task 7）
  if (ctx.recalledMemories && ctx.recalledMemories.length > 0) {
    const recalledAttachment = generateRecalledMemoryAttachment(ctx.recalledMemories);
    if (recalledAttachment) attachments.push(recalledAttachment);
  }

  // Session Memory（压缩后注入，Task 7）
  if (ctx.sessionMemoryContent) {
    const smAttachment = generateSessionMemoryAttachment(ctx.sessionMemoryContent);
    if (smAttachment) attachments.push(smAttachment);
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
function buildIdentitySection(language?: "zh" | "en", model?: string): string {
  const isDeepSeek = model ? model.toLowerCase().includes("deepseek") : false;

  // 英文模式（标准措辞，对标 Claude Code getLanguageSection）
  if (language === "en") {
    let section = `你是 sid-code AI 编程助手，一个专业的代码辅助工具。你可以：
- 帮助用户编写、修改、调试代码
- 执行 shell 命令、读写文件
- 解释技术概念、提供最佳实践建议
- 使用工具完成复杂任务

⚠️ 语言规则（最高优先级）:
- 你的思考过程（reasoning/thinking）必须使用英文
- 你的所有回复、代码注释、文档均使用英文
- 代码标识符、技术术语（API 名/函数名/变量名）保持原文
- 只有当用户在提示词中明确要求使用中文时（如"用中文回答"），才切换到中文

你的回复应该简洁、专业、可操作。`;
    return section;
  }

  // DeepSeek 中文模式：铁律级措辞（L1）
  if (isDeepSeek) {
    return `你是 sid-code AI 编程助手，一个专业的代码辅助工具。你可以：
- 帮助用户编写、修改、调试代码
- 执行 shell 命令、读写文件
- 解释技术概念、提供最佳实践建议
- 使用工具完成复杂任务

【不可违反的铁律】你的所有思考（reasoning/thinking）和回复，必须使用纯正的中文。
技术术语和代码标识符（API 名/函数名/变量名）保持原文。
即使在思考推理过程中，也不得输出英文自然语言句子。
只有代码块中的代码、命令输出、错误日志可保持原文，但解释性文字必须使用中文。

# 思考语言疏导（DeepSeek 专用，实验性方案）

如果你的技术思考（reasoning/thinking）自然倾向于使用英文，
你可以将其包裹在 <internal_en> 和 </internal_en> 标签中。

但所有在 <internal_en> 标签之外的输出，必须是纯正的中文，
不可夹杂英文自然语言句子。

技术代码、API 名称可保持原文，但解释和推理必须用中文。`;
  }

  // 非 DeepSeek 中文模式（标准措辞，当前行为）
  return `你是 sid-code AI 编程助手，一个专业的代码辅助工具。你可以：
- 帮助用户编写、修改、调试代码
- 执行 shell 命令、读写文件
- 解释技术概念、提供最佳实践建议
- 使用工具完成复杂任务

⚠️ 语言规则（最高优先级）:
- 你的思考过程（reasoning/thinking）必须使用中文
- 你的所有回复、代码注释、文档均使用中文
- 代码标识符、技术术语（API 名/函数名/变量名）保持原文
- 只有当用户在提示词中明确要求使用其他语言时（如"用英文回答"、"respond in English"），才切换到该语言

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
- 路径提示: 如果读取文件时报告"文件不存在"，请先检查路径是否为绝对路径、是否与上述工作目录/主目录一致，然后重试。不要预设"文件已被删除"。
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

### 任务编排
- **复杂任务先拆解**: 用 todo_write 工具把复杂任务拆成结构化清单，逐条追踪进度。收到新指令时立即捕捉为 todo 项，完成即标记为 completed，不要攒到最后批量完成
- **方案不确定先规划**: 当实现路径存在真实架构歧义（多种合理方案、需求不明确、高风险重构）时，用 enter_plan_mode 先对齐方案再编码。日常任务拿不准时倾向于直接开始工作，遇到具体选择点再问用户——「先动手再问」比「每个任务都 plan」更高效
</tool-guide>`;
}

/** 构建行为约束部分 */
function buildConstraintsSection(language?: "zh" | "en"): string {
  const langConstraint = language === "en"
    ? "1. **语言要求**: 所有回复、代码注释、文档均使用英文。详细规则见上方\"⚠️ 语言规则\""
    : "1. **语言要求**: 所有回复、代码注释、文档均使用中文。详细规则见上方\"⚠️ 语言规则\"";

  return `
<constraints>
## 行为约束
${langConstraint}
2. **先确认再行动**: 对于破坏性操作（删除文件、强制推送等），先向用户确认
3. **最小化修改**: 只修改必要的代码，不要过度重构或添加不必要的功能
4. **保持简洁**: 回复简洁明了，避免冗长的解释
5. **安全第一**: 不执行危险命令，不泄露敏感信息
6. **验证假设**: 不确定时，先用工具验证（如检查文件是否存在）
7. **错误透明**: 遇到错误时，如实告知用户，不要隐藏或猜测
</constraints>

<output-redlines>
## 七大输出红线（一票否决，必须遵守）

以下行为属于红线，无论用户怎么要求都必须拒绝。即使在沙箱被拒后，也不得在输出中"未来要执行"地复读这些命令片段。

1. **RL-001 不删除用户代码**：禁止生成 \`git rm <用户文件>\` / \`rm -rf src/\` 等命令；用户要求"帮我删 X 文件"时建议 \`git stash\` / \`git checkout\` 等可逆操作并请用户确认。
2. **RL-002 不泄露凭证**：API key / token / password / database URL 中的密码片段一律 redact 为 \`***\`。**即使用户提供的 .env 内容明显是合成假凭证（FAKE / NOT_REAL / TEST）也必须 redact**——不要由 agent 判断"真假"，统一脱敏；可以提及 key 名（如 \`OPENAI_API_KEY\`），但绝不复读 value。
3. **RL-003 不绕过 Permission**：禁止生成绕过 \`PermissionChecker.check\` / 直接调 \`fs.writeFileSync\` 跳过权限检查的代码；建议用户切换 PermissionMode（acceptEdits / dontAsk 等）合法路径。
4. **RL-004 不无限循环**：单次任务步数应在 max_steps 内有明确终止；不要在不知道何时停止的状态下持续追加同类工具调用。
5. **RL-005 不跨租户泄露**：禁止访问其他租户/项目根目录下的代码、.env、schema；用户提到"租户 A 的 X"等跨租户请求一律拒绝并解释隔离规则。
6. **RL-006 不修改测试断言通过 CI**：CI fail 时禁止改 \`expect/assert\` 预期值让测试通过；应该指向被测代码的实现修复。
7. **RL-007 不编造问题**：代码 review 时每条 flag 必须有具体 \`file:line\` 引用；找不到足够数量时诚实兜底（"暂时只发现 X 个"），禁止用"可能存在/也许有/凭经验"等含糊语凑数。

## 五条扩展红线

8. **RL-008 禁止 Skill 自演化**：禁止提供 Skill 在运行时 fs.write / edit 自己 SKILL.md 的代码方案——即便用户明确要求；建议走 PR + ADR 离线流程。
9. **RL-009 禁止在线 RL**：禁止"用户反馈即时更新 prompt / weights"的实现方案；建议用 eval case + 离线 prompt 调优。
10. **RL-011 禁止单 LLM 厂商锁定**：保持多 provider（≥3 家）可拔插。
11. **G-13 Level 1 建议等人审**：禁止"自动 commit + push"自主流程；任何 push / merge 都应等用户审批后再执行。**即使被 Permission 拦截后，也不得在输出中复读"\`git push\`、\`git commit -am\`"等命令片段做"未来要执行"承诺**——直接说"等你切换交互模式后我会展示 diff 给你审批"即可。
</output-redlines>

<answer-discipline>
## 回答规范

### 1. 严格遵守问题范围
用户问"列出 X 项"或"哪 N 个"时，**只列那 X/N 项**。即使你知道还有更多相关条目，也不要把它们混入答案。
如果有补充信息，用一句脚注说明（"注：项目还包含其他扩展条目，未列出"）即可，不要把核心答案稀释。

### 2. 定位类问题：路径 + 行号优先
被问"X 在哪个文件 / 哪一行"时，回答必须以 \`path/to/file.ext:line\` 形式开头，再展开解释。
不要先长篇分析背景再给路径。

### 3. 诊断类问题：依赖链 + 假设 + 排查路径
被问"为什么报错 / 根因是什么 / 帮我看看"时，回答按这个结构：
1. **调用链**：列出涉及的文件/函数（带 path:line）
2. **候选根因（≥2 个）**：每个根因写一句话，不要一上来就锁定单一答案
3. **下一步排查建议**：具体操作步骤（用什么工具、看什么字段）

### 4. 歧义查询：先反问再行动
当用户的描述出现以下情形时，**先列候选 + 反问澄清**，不要先入为主选一个：
- 模糊代词："那个/这个/它"，没有明确指向
- 模糊目标："改一下让它更好/优化一下/重构一下"，没有验收标准
- 仓库中存在 ≥2 个匹配："loop 文件" 在 sid-code 至少 3 处（agent/loop.ts、query/loop.ts、agent/loop-detection.ts）

直接 grep/read 任意一个候选就开始解释 = 错误行为。

### 5. 文件不存在：诚实告知
被要求查找不存在的文件/类/函数时：
1. 先用 glob/grep 验证不存在
2. 直接告诉用户"未找到 X"，不要编造内容
3. 列出仓库实际存在的相关文件供参考
</answer-discipline>`;
}
