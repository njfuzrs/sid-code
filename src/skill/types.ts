/**
 * Skill 系统类型定义
 * Skill 是带元数据的提示词模板，LLM 可自动调用
 */

import type { ExtensionSource } from "../extension/types.ts";

/** Skill 加载位置（对齐 Claude Code loadedFrom） */
export type SkillLoadedFrom = "builtin" | "bundled" | "skills" | "mcp" | "plugin" | "managed";

/** Skill 生命周期钩子声明（frontmatter 中的 hooks 字段） */
export interface SkillHookEntry {
  /** 匹配的工具名（如 "write" / "edit" / "bash"） */
  matcher: string;
  /** 该 matcher 下的钩子命令列表 */
  hooks: Array<{
    /** shell 命令（支持 ${SKILL_DIR} 替换） */
    command: string;
    /** 是否一次性钩子（执行一次后自动移除） */
    once?: boolean;
  }>;
}

/** 按事件名分组的 Skill 钩子配置 */
export type SkillHooksConfig = Record<string, SkillHookEntry[]>;

/** Skill 定义 */
export interface SkillDefinition {
  /** Skill 名称 */
  name: string;
  /** Skill 描述 */
  description: string;
  /** 允许使用的工具列表 */
  allowedTools?: string[];
  /** 何时使用此 Skill（提示 LLM） */
  whenToUse?: string;
  /** 参数提示 */
  argumentHint?: string;
  /** 指定模型（可选） */
  model?: string;
  /** 禁止 LLM 自动调用（仅手动触发） */
  disableModelInvocation?: boolean;
  /** 执行模式：activate（上下文注入）或 delegate（子代理执行，默认） */
  mode?: "activate" | "delegate";
  /**
   * 执行上下文（对齐 Claude Code context 字段）：
   * inline（注入当前对话）或 fork（子代理执行）。
   * 优先级高于 mode；未指定时由 mode 推导。
   */
  context?: "inline" | "fork";
  /** 最大轮次（delegate 模式，默认 10，最大 50） */
  maxTurns?: number;
  /** 超时时间（分钟，delegate 模式，默认 2，最大 30） */
  timeoutMins?: number;
  /** 提示词模板（markdown body） */
  prompt: string;
  /** 来源 */
  source: ExtensionSource | "mcp";
  /** 加载位置（用于发现过滤与 MCP 安全隔离） */
  loadedFrom?: SkillLoadedFrom;
  /** 文件路径 */
  filePath: string;
  /** Skill 文件所在目录（${SKILL_DIR} 替换用） */
  skillRoot?: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否为内置 Skill */
  isBuiltin?: boolean;

  // ===== 新增字段（对齐 Claude Code frontmatter 完整规范） =====

  /** 用户能否通过 /name 调用（默认 true） */
  userInvocable?: boolean;
  /** 版本号 */
  version?: string;
  /** 推理努力程度：low/medium/high/max */
  effort?: string;
  /** fork 时使用的代理类型 */
  agent?: string;
  /** !`cmd` 使用的 shell（默认 bash） */
  shell?: string;
  /** 命名参数列表（支持 $arg_name 替换） */
  argumentNames?: string[];
  /** 条件激活路径模式（glob），只在操作匹配文件时激活 */
  paths?: string[];
  /** 生命周期钩子声明 */
  hooks?: SkillHooksConfig;
}
