/**
 * 附件系统核心
 * 对标 Claude Code 的动态附件机制：优先级排序 + 条件注入
 */

import { execSync } from "child_process";
import { getLogger } from "../debug/logger.ts";

/** 附件类型 */
export interface Attachment {
  /** 附件类型标识 */
  type: string;
  /** 附件内容 */
  content: string;
  /** 优先级（数字越小越重要） */
  priority: number;
}

/** 附件优先级定义（对标 Claude Code） */
export const PRIORITY = {
  /** 关键系统提醒 */
  CRITICAL_REMINDER: 1,
  /** Plan/Delegate 模式提醒 */
  MODE_REMINDER: 5,
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

  plan: `# 权限模式: 规划
你应该：
1. 充分探索代码库
2. 设计实现方案
3. 向用户展示你的计划
暂时不要写入或编辑文件。`,

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
 * 内容由外部传入（rules.ts 负责查找和加载）
 */
export function generateClaudeMdAttachment(content: string): Attachment {
  return {
    type: "claudeMd",
    content: `<project-rules>\n${content}\n</project-rules>`,
    priority: PRIORITY.CLAUDE_MD,
  };
}

/**
 * 生成 Git 状态附件
 * 执行 git status --short 获取当前仓库状态
 */
export function generateGitStatusAttachment(workingDir: string): Attachment | null {
  const log = getLogger();

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

    return {
      type: "gitStatus",
      content: `<git-status>\n${parts.join("\n")}\n</git-status>`,
      priority: PRIORITY.GIT_STATUS,
    };
  } catch {
    log.debug("ATTACHMENT", "非 Git 仓库或 git 命令不可用，跳过 Git 状态附件");
    return null;
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
    content: `<ide-selection>\n${selection}\n</ide-selection>`,
    priority: PRIORITY.IDE_SELECTION,
  };
}

/**
 * 生成 Todo 列表附件（预留接口）
 */
export function generateTodoListAttachment(todoList: string): Attachment {
  return {
    type: "todoList",
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
    content: `<memory>\n## 记忆\n以下是之前会话中保存的记忆信息，请参考：\n\n${memorySummary}\n</memory>`,
    priority: PRIORITY.MEMORY,
  };
}
