/**
 * Skill → 旧 Command 适配器（斜杠命令路径）
 *
 * 背景：应用层（app.ts）通过旧 `Registry.get(name)` 解析斜杠命令，注册的对象必须实现
 * 旧 `Command` 接口（name()/execute()）。而 skill 系统的 `skillToCommand` 产出的是
 * `UnifiedCommand` 对象字面量（type:"prompt"），两者类型不兼容——这正是 /bug-fix 报
 * "未知命令" 的原因：skill 此前只注册成了 SkillTool（模型路径），从未注册成斜杠命令。
 *
 * 本适配器把一个 SkillDefinition 包装成旧 Command，使用户可 /skill-name 直接调用：
 * - activate / inline：处理 prompt 后注入当前对话（submit_prompt），用户审批、plan mode 等全部可用。
 * - delegate / fork：在子代理中执行，返回最终输出（message）。
 *
 * 与 SkillTool（模型调用路径）互补：同一个 skill，两条调用路径（用户斜杠命令 / 模型工具）。
 */

import type { Command, AppContext, CommandResult } from "./types.ts";
import type { SkillDefinition } from "../skill/types.ts";
import { processSkillPrompt } from "../skill/prompt-processor.ts";
import { getLogger } from "../debug/logger.ts";

export class SkillCommand implements Command {
  private skill: SkillDefinition;
  /** 解析后的执行上下文：inline 注入 / fork 子代理 */
  private readonly context: "inline" | "fork";

  constructor(skill: SkillDefinition) {
    this.skill = skill;
    // context 优先于 mode；都未指定时默认 fork（与 skillToCommand 保持一致）
    this.context = skill.context ?? (skill.mode === "activate" ? "inline" : "fork");
  }

  name(): string { return this.skill.name; }
  aliases(): string[] { return []; }
  description(): string { return this.skill.description || `Skill: ${this.skill.name}`; }

  async execute(args: string, ctx: AppContext): Promise<CommandResult> {
    const log = getLogger();

    // 处理 prompt 变量替换管道（$ARGUMENTS / $1 / ${SKILL_DIR} / !`shell` 等）
    let prompt: string;
    try {
      prompt = await processSkillPrompt(
        this.skill.prompt,
        args,
        { cwd: process.cwd(), sessionId: ctx.sessionId ?? "" },
        {
          skillRoot: this.skill.skillRoot,
          loadedFrom: this.skill.loadedFrom,
          argumentNames: this.skill.argumentNames,
          shell: this.skill.shell,
          // inline 注入时带 Base directory 头部；fork 子代理不需要
          injectBaseDir: this.context === "inline" && Boolean(this.skill.skillRoot),
        },
      );
    } catch (err: any) {
      return { kind: "error", message: `Skill 提示处理失败: ${err.message}` };
    }

    // fork 模式：子代理独立执行
    if (this.context === "fork") {
      return this.executeFork(prompt, ctx);
    }

    // inline 模式：注入当前对话，触发 LLM 响应
    log.debug("SKILL", `inline 注入 skill /${this.skill.name}`);
    return { kind: "submit_prompt", prompt };
  }

  /** fork 模式：在子代理中执行，返回最终输出；无 providerRegistry 时退回 inline */
  private async executeFork(prompt: string, ctx: AppContext): Promise<CommandResult> {
    const log = getLogger();

    if (!ctx.providerRegistry) {
      log.warn("SKILL", `fork skill /${this.skill.name} 无 providerRegistry，退回 inline 注入`);
      return { kind: "submit_prompt", prompt };
    }

    try {
      const { SubAgent } = await import("../agent/sub-agent.ts");
      const subAgent = SubAgent.fromRegistry(
        ctx.providerRegistry,
        ctx.registry,
        ctx.hookSystem,
      );

      const result = await subAgent.executeCustom({
        systemPrompt: "你是一个专注的助手，请完成以下任务。",
        userPrompt: prompt,
        allowedTools: this.skill.allowedTools ?? [],
        maxTurns: this.skill.maxTurns ?? 10,
      });

      return {
        kind: "message",
        message: result.success ? result.output : `子代理执行失败: ${result.output}`,
      };
    } catch (e: any) {
      return { kind: "error", message: `fork 执行失败: ${e?.message ?? String(e)}` };
    }
  }
}
