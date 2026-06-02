/**
 * Bundled Skill 注册机制（Task 6）
 *
 * Bundled Skill 是编译时内置的核心能力，不依赖磁盘 .md 文件。
 * 与磁盘 Skill 相比，Bundled Skill 支持：
 *   - 动态内容生成（getPromptForCommand 可执行任意逻辑）
 *   - 携带参考文件（运行时安全提取到临时目录）
 *   - Feature flag 门控（isEnabled）
 *
 * 注册的 Bundled Skill 以 UnifiedCommand(PromptCommand) 形式暴露，
 * 与磁盘 Skill / 自定义命令走完全相同的执行路径。
 */

import type {
  UnifiedCommand,
  CommandContext,
} from "../../command/types.ts";
import { extractBundledSkillFiles } from "./extract.ts";
import { getLogger } from "../../debug/logger.ts";

/** Bundled Skill 定义 */
export interface BundledSkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  allowedTools?: string[];
  userInvocable?: boolean;
  context?: "inline" | "fork";
  model?: string;
  maxTurns?: number;
  /** 禁止模型自动调用 */
  disableModelInvocation?: boolean;
  /** 动态启用条件（feature flag 门控） */
  isEnabled?: () => boolean;
  /** 附带的参考文件（编译时嵌入，运行时提取）—— 相对路径 → 内容 */
  files?: Record<string, string>;
  /** 核心方法：生成 prompt 内容 */
  getPromptForCommand(args: string, context: CommandContext): Promise<string>;
}

const bundledSkills: UnifiedCommand[] = [];

/** 注册一个 Bundled Skill（幂等：同名重复注册会覆盖） */
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const { files } = definition;
  let getPromptForCommand = definition.getPromptForCommand;

  // 携带参考文件 → 包装 getPromptForCommand 实现懒提取（闭包级 memoize）
  if (files && Object.keys(files).length > 0) {
    let extractionPromise: Promise<string | null> | undefined;
    const inner = definition.getPromptForCommand;

    getPromptForCommand = async (args, ctx) => {
      extractionPromise ??= extractBundledSkillFiles(definition.name, files);
      const extractedDir = await extractionPromise;
      const content = await inner(args, ctx);
      if (extractedDir) {
        return `Base directory for this skill: ${extractedDir}\n\n${content}`;
      }
      return content;
    };
  }

  const command: UnifiedCommand = {
    type: "prompt",
    name: definition.name,
    description: definition.description,
    source: "skill",
    whenToUse: definition.whenToUse,
    argumentHint: definition.argumentHint,
    allowedTools: definition.allowedTools,
    userInvocable: definition.userInvocable ?? true,
    disableModelInvocation: definition.disableModelInvocation,
    context: definition.context ?? "fork",
    maxTurns: definition.maxTurns,
    isEnabled: definition.isEnabled,
    getPromptForCommand,
  };

  // 同名覆盖
  const idx = bundledSkills.findIndex((s) => s.name === definition.name);
  if (idx >= 0) {
    bundledSkills[idx] = command;
  } else {
    bundledSkills.push(command);
  }

  getLogger().debug("SKILL", `注册 Bundled Skill: ${definition.name}`);
}

/** 获取所有已启用的 Bundled Skill */
export function getBundledSkills(): UnifiedCommand[] {
  return bundledSkills.filter((s) => (s.isEnabled ? s.isEnabled() : true));
}

/** 清空注册表（测试用） */
export function clearBundledSkills(): void {
  bundledSkills.length = 0;
}

/** 是否已注册指定 Bundled Skill */
export function hasBundledSkill(name: string): boolean {
  return bundledSkills.some((s) => s.name === name);
}
