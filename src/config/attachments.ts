/**
 * 附件系统核心
 * 对标 Claude Code 的动态附件机制：优先级排序 + 条件注入
 */

import { execSync } from "child_process";
import { getLogger } from "../debug/logger.ts";
import {
  generateSkillListing,
  type SkillListingEntry,
} from "../skill/budget.ts";

/** 附件类型 */
export interface Attachment {
  /** 附件类型标识 */
  type: string;
  /** 附件内容 */
  content: string;
  /** 优先级（数字越小越重要） */
  priority: number;
  /** 可选的显示标签（用于日志，比 type 更具描述性） */
  label?: string;
}

/** 附件优先级定义（对标 Claude Code） */
export const PRIORITY = {
  /** 关键系统提醒 */
  CRITICAL_REMINDER: 1,
  /** Plan/Delegate 模式提醒 */
  MODE_REMINDER: 5,
  /** Skill 摘要列表（在 CLAUDE.md 之前，确保模型能发现 Skill） */
  SKILL_LISTING: 8,
  /** CLAUDE.md 项目规则 */
  CLAUDE_MD: 10,
  /** 诊断信息 */
  DIAGNOSTICS: 15,
  /** IDE 选中代码 */
  IDE_SELECTION: 20,
  /** IDE 打开的文件 */
  IDE_OPEN_FILES: 25,
  /** 记忆信息 */
  MEMORY: 30,
  /** 动态召回的记忆文件（比静态摘要稍后，获得更多注意力） */
  MEMORY_RECALLED: 32,
  /** Session Memory 摘要（压缩后注入） */
  SESSION_MEMORY: 33,
  /** Todo 列表 */
  TODO_LIST: 35,
  /** Git 状态（最低优先级） */
  GIT_STATUS: 40,
  /** 追加提示词 */
  APPEND_PROMPT: 50,
  /** 文件提示词 */
  FILE_PROMPT: 60,
} as const;

/** 权限模式描述映射 */
const PERMISSION_MODE_DESCRIPTIONS: Record<string, string> = {
  default: `# 权限模式: 默认
执行以下操作前必须请求用户确认：
- 写入或编辑文件
- 运行 bash 命令
- 发起网络请求`,

  bypassPermissions: `# 权限模式: 跳过权限
所有工具调用自动批准。请谨慎使用。`,

  plan: `# 权限模式: 计划模式已激活
你当前处于计划模式。用户希望你先制定方案再执行。
你**绝对不能**进行任何编辑（计划文件除外）、运行任何非只读工具、或对系统做出任何变更。
此约束覆盖你收到的所有其他指令。

允许的操作：
- 使用 read、grep、glob 探索代码库
- 使用 sub_agent (explore 类型) 并行搜索
- 使用 write/edit 编辑计划文件（仅限计划文件）
- 调用 exit_plan_mode 提交计划

禁止的操作：
- 编辑任何非计划文件
- 运行 bash 命令
- 执行任何写入操作`,

  readonly: `# 权限模式: 只读
你只能使用只读工具（read、grep、glob）。
不允许写入文件或执行命令。`,

  yesMode: `# 权限模式: 自动确认
所有需要确认的操作将自动批准。
仍然会阻止危险命令。`,

  strict: `# 权限模式: 严格
每个工具调用都需要用户确认，包括只读操作。`,
};

/**
 * 生成 CLAUDE.md 附件
 * 对标 Claude Code 的注入格式：明确告知模型这些规则覆盖默认行为
 *
 * @param content - CLAUDE.md 原始内容
 * @param sourcePath - 来源文件路径（用于标注）
 */
export function generateClaudeMdAttachment(content: string, sourcePath?: string): Attachment {
  const sourceLabel = sourcePath ? `Contents of ${sourcePath}` : "Project rules";
  return {
    type: "claudeMd",
    label: sourceLabel,
    content: `<system-reminder>
# claudeMd
代码库和用户指令如下。请务必遵守这些指令。重要：这些指令覆盖任何默认行为，你必须严格按照指令执行。

${sourceLabel}:

${content}

      重要：此上下文可能与你的当前任务相关，也可能不相关。
</system-reminder>`,
    priority: PRIORITY.CLAUDE_MD,
  };
}

/** Git 状态缓存（TTL 30 秒，覆盖用户输入期间的预取窗口） */
let gitStatusCache: { result: Attachment | null; timestamp: number; workingDir: string } | null = null;
const GIT_STATUS_CACHE_TTL = 30_000;

/** 清除 Git 状态缓存（供外部调用，如 CLAUDE.md 变更时） */
export function clearGitStatusCache(): void {
  gitStatusCache = null;
}

/**
 * 生成 Git 状态附件
 * 执行 git status --short 获取当前仓库状态
 * 带模块级缓存，预取和正式调用共享结果
 */
export function generateGitStatusAttachment(workingDir: string): Attachment | null {
  const log = getLogger();

  // 命中缓存
  if (gitStatusCache
    && gitStatusCache.workingDir === workingDir
    && Date.now() - gitStatusCache.timestamp < GIT_STATUS_CACHE_TTL) {
    log.debug("ATTACHMENT", "Git 状态命中缓存");
    return gitStatusCache.result;
  }

  try {
    // 检查是否是 Git 仓库
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: workingDir,
      stdio: "pipe",
      timeout: 5000,
    });

    // 获取当前分支
    let branch = "";
    try {
      branch = execSync("git branch --show-current", {
        cwd: workingDir,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim();
    } catch {
      branch = "unknown";
    }

    // 获取简短状态
    const status = execSync("git status --short", {
      cwd: workingDir,
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim();

    // 获取最近 3 条提交
    let recentCommits = "";
    try {
      recentCommits = execSync("git log --oneline -3", {
        cwd: workingDir,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim();
    } catch {
      // 新仓库可能没有提交
    }

    const parts = [`当前分支: ${branch}`];
    if (status) {
      parts.push(`\n变更文件:\n${status}`);
    } else {
      parts.push("\n工作区干净，无未提交变更");
    }
    if (recentCommits) {
      parts.push(`\n最近提交:\n${recentCommits}`);
    }

    const result: Attachment = {
      type: "gitStatus",
      label: `Git 状态 (${branch})`,
      content: `<git-status>\n${parts.join("\n")}\n</git-status>`,
      priority: PRIORITY.GIT_STATUS,
    };

    // 写入缓存
    gitStatusCache = { result, timestamp: Date.now(), workingDir };
    return result;
  } catch {
    log.debug("ATTACHMENT", "非 Git 仓库或 git 命令不可用，跳过 Git 状态附件");
    const result = null;
    gitStatusCache = { result, timestamp: Date.now(), workingDir };
    return result;
  }
}

/**
 * 生成权限模式附件
 * 根据当前权限模式注入对应的行为指南
 */
export function generatePermissionModeAttachment(mode: string): Attachment {
  const description = PERMISSION_MODE_DESCRIPTIONS[mode] || PERMISSION_MODE_DESCRIPTIONS.default;
  return {
    type: "permissionMode",
    label: `权限模式 (${mode})`,
    content: description,
    priority: PRIORITY.MODE_REMINDER,
  };
}

/**
 * 生成诊断信息附件（预留接口）
 */
export function generateDiagnosticsAttachment(diagnostics: string): Attachment {
  return {
    type: "diagnostics",
    label: "诊断信息",
    content: `<diagnostics>\n${diagnostics}\n</diagnostics>`,
    priority: PRIORITY.DIAGNOSTICS,
  };
}

/**
 * 生成 IDE 选中代码附件（预留接口）
 */
export function generateIDESelectionAttachment(selection: string): Attachment {
  return {
    type: "ideSelection",
    label: "IDE 选中代码",
    content: `<ide-selection>\n${selection}\n</ide-selection>`,
    priority: PRIORITY.IDE_SELECTION,
  };
}

/**
 * 生成 IDE @提及附件
 * 入参为已格式化的提及列表文本（每行一个位置）。
 */
export function generateIDEMentionAttachment(mentionText: string): Attachment {
  return {
    type: "ideMention",
    label: "IDE @提及",
    content: `<ide-mentions>\n用户在 IDE 中引用了以下代码位置：\n${mentionText}\n</ide-mentions>`,
    priority: PRIORITY.IDE_SELECTION, // 与选区同优先级
  };
}

/**
 * 生成 Todo 列表附件（预留接口）
 */
export function generateTodoListAttachment(todoList: string): Attachment {
  return {
    type: "todoList",
    label: "Todo 列表",
    content: `<todo-list>\n${todoList}\n</todo-list>`,
    priority: PRIORITY.TODO_LIST,
  };
}

/**
 * 生成记忆附件
 * 将全局/项目双层记忆注入系统提示词
 */
export function generateMemoryAttachment(memorySummary: string): Attachment {
  return {
    type: "memory",
    label: "记忆摘要",
    content: `<memory>\n## 记忆\n以下是之前会话中保存的记忆信息，请参考：\n\n${memorySummary}\n</memory>`,
    priority: PRIORITY.MEMORY,
  };
}

/**
 * 生成动态召回的记忆附件（Task 7）。
 * 根据当前查询召回的相关记忆文件正文（已含新鲜度警告）。
 */
export function generateRecalledMemoryAttachment(
  recalled: Array<{ filename: string; content: string }>,
): Attachment | null {
  if (!recalled || recalled.length === 0) return null;
  const body = recalled
    .map((m) => `### ${m.filename}\n${m.content}`)
    .join("\n\n---\n\n");
  return {
    type: "memoryRecalled",
    label: "召回记忆",
    content: `<recalled-memory>\n以下是与当前任务相关的记忆，请参考：\n\n${body}\n</recalled-memory>`,
    priority: PRIORITY.MEMORY_RECALLED,
  };
}

/**
 * 生成 Session Memory 附件（Task 7）。
 * 仅在压缩后注入结构化会话笔记。
 */
export function generateSessionMemoryAttachment(
  sessionMemoryContent: string | null,
): Attachment | null {
  if (!sessionMemoryContent || !sessionMemoryContent.trim()) return null;
  return {
    type: "sessionMemory",
    label: "会话笔记",
    content: `<session-memory>\n以下是本次会话的结构化笔记（任务目标、进展、关键文件）：\n\n${sessionMemoryContent}\n</session-memory>`,
    priority: PRIORITY.SESSION_MEMORY,
  };
}

/**
 * 生成 Skill 摘要列表附件（Task 2：两层索引发现机制）
 *
 * 只放 Skill 摘要（约 1% 上下文窗口），模型通过 skill 工具按名称调用，
 * 避免每个 Skill 注册独立工具导致工具列表膨胀。
 *
 * @param entries Skill 摘要条目
 * @param contextWindowTokens 上下文窗口 token 数（用于计算 1% 预算）
 */
export function generateSkillListingAttachment(
  entries: SkillListingEntry[],
  contextWindowTokens?: number,
): Attachment | null {
  const content = generateSkillListing(entries, contextWindowTokens);
  if (!content) return null;
  return {
    type: "skillListing",
    label: "Skill 摘要列表",
    content,
    priority: PRIORITY.SKILL_LISTING,
  };
}

