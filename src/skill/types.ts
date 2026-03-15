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
  /** 提示词模板（markdown body） */
  prompt: string;
  /** 来源 */
  source: ExtensionSource;
  /** 文件路径 */
  filePath: string;
}
