/**
 * Skill → UnifiedCommand (PromptCommand) 适配器
 *
 * 当前 Skill 通过 SkillTool 注册到 ToolRegistry（模型调用路径）。
 * 本适配器让每个 Skill 同时成为一个 PromptCommand，使用户可以通过 /skill-name
 * 直接调用 Skill —— 同一个 Skill，两种调用路径（用户 / 模型）。
 *
 * 上下文映射（context 优先于 mode）：
 * - context="fork" 或 mode="delegate"（默认）→ 子代理执行，带工具/轮次限制
 * - context="inline" 或 mode="activate"        → 注入当前对话上下文
 *
 * Prompt 处理走 processSkillPrompt() 管道：
 * $ARGUMENTS / $1 / $arg_name / ${SKILL_DIR} / ${SESSION_ID} / !`shell`
 */

import type { UnifiedCommand, CommandContext } from "../command/types.ts";
import type { SkillDefinition } from "./types.ts";
import { processSkillPrompt } from "./prompt-processor.ts";

export function skillToCommand(skill: SkillDefinition): UnifiedCommand {
  // context 优先于 mode；都未指定时默认 fork（与旧行为一致）
  const context: "inline" | "fork" =
    skill.context ?? (skill.mode === "activate" ? "inline" : "fork");

  return {
    type: "prompt",
    name: skill.name,
    description: skill.description,
    argumentHint: skill.argumentHint,
    source: skill.source === "mcp" ? "mcp" : "skill",
    whenToUse: skill.whenToUse,
    // userInvocable 默认 true；disableModelInvocation 只限制模型路径
    userInvocable: skill.userInvocable !== false,
    disableModelInvocation: skill.disableModelInvocation,
    isEnabled: () => !skill.disabled,
    context,
    allowedTools: skill.allowedTools,
    maxTurns: skill.maxTurns,
    async getPromptForCommand(args: string, ctx: CommandContext) {
      return processSkillPrompt(
        skill.prompt,
        args,
        { cwd: ctx.cwd, sessionId: ctx.sessionId },
        {
          skillRoot: skill.skillRoot,
          loadedFrom: skill.loadedFrom,
          argumentNames: skill.argumentNames,
          shell: skill.shell,
          // inline 注入时带 Base directory 头部；fork 子代理不需要
          injectBaseDir: context === "inline" && Boolean(skill.skillRoot),
        },
      );
    },
  };
}
