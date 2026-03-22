/**
 * Skill 系统类型定义
 * Skill 是带元数据的提示词模板，LLM 可自动调用
 */

import type { ExtensionSource } from "../extension/types.ts";

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
  /** 最大轮次（delegate 模式，默认 10，最大 50） */
  maxTurns?: number;
  /** 超时时间（分钟，delegate 模式，默认 2，最大 30） */
  timeoutMins?: number;
  /** 提示词模板（markdown body） */
  prompt: string;
  /** 来源 */
  source: ExtensionSource;
  /** 文件路径 */
  filePath: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否为内置 Skill */
  isBuiltin?: boolean;
}
