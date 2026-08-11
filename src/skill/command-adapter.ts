/**
 * Skill → UnifiedCommand (PromptCommand) 适配器
 *
 * 当前 Skill 通过单一 `Skill` 元工具（SkillMetaTool）暴露给模型（模型调用路径）。
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

import type { UnifiedCommand, CommandContext } from "../command-contract/types.ts";
import type { SkillDefinition } from "./types.ts";
import { processSkillPrompt } from "./prompt-processor.ts";

/**
 * @param isGated 可选的 gate 查询（通常是 `(n) => manager.isGated(n)`）。
 *   P1-2：条件激活 skill 在其 `paths` 匹配的文件被接触前不应可调用——只从 listing
 *   隐藏是不够的，用户/模型仍可按名直呼绕过条件。传入后该 skill 在补全列表与执行
 *   两处都被挡住（对齐 CC：未激活的 conditionalSkills 不进 getAllCommands）。
 *   注意必须传函数而非布尔值：gate 态运行时会变（激活后解除），快照会失真。
 */
export function skillToCommand(
  skill: SkillDefinition,
  isGated?: (name: string) => boolean,
): UnifiedCommand {
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
    // 禁用的、或条件未激活的 skill 均不可见/不可调用
    isEnabled: () => !skill.disabled && !(isGated?.(skill.name) ?? false),
    context,
    allowedTools: skill.allowedTools,
    maxTurns: skill.maxTurns,
    timeoutMins: skill.timeoutMins,
    // P0-2/P0-3/P1-1：把原始定义带给 CommandExecutor，使用户斜杠路径能跑
    // 权限判定 → hooks 注册 → effort/agent 透传（与模型路径 SkillMetaTool 同一内核）。
    skill,
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
