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

    // ── P0-3：权限判定（用户路径可用主会话弹窗做 ask）──
    const { authorizeSkill, resolveSkillAsk, registerSkillLifecycleHooks } = await import("../skill/executor.ts");
    const rawRules = ctx.permissionChecker && typeof (ctx.permissionChecker as { getRules?: () => unknown }).getRules === "function"
      ? (ctx.permissionChecker as unknown as { getRules: () => import("../permission/types.ts").PermissionRule | null }).getRules()
      : null;
    const auth = authorizeSkill(this.skill, { permissionRules: rawRules ?? undefined });
    if (auth.decision === "deny") {
      return { kind: "error", message: `权限拒绝：Skill "${this.skill.name}" 被规则拒绝` };
    }
    if (auth.decision === "ask") {
      const allowed = await resolveSkillAsk(this.skill, auth.reason ?? "", {
        // 用户路径优先用主会话确认回调（若上层提供）；否则回退 checker
        confirm: ctx.requestUserConfirmation
          ? (desc: string) => ctx.requestUserConfirmation!(desc)
          : undefined,
        checker: ctx.permissionChecker ?? undefined,
      });
      if (!allowed) {
        return { kind: "error", message: `已取消：Skill "${this.skill.name}" 未获授权` };
      }
    }

    // ── P0-2：授权通过后注册生命周期 hooks（MCP 来源内部拒绝）──
    // inline 语义把 skill 注入主对话、长期存活，hooks 也应持续到会话结束（不卸载）；
    // fork 在子代理内执行，hooks 作用域限定本次调用，executeFork 返回后卸载。
    const hookCount = registerSkillLifecycleHooks(this.skill, ctx.hookSystem);

    // fork 模式：子代理独立执行
    if (this.context === "fork") {
      try {
        return await this.executeFork(prompt, ctx);
      } finally {
        if (hookCount > 0 && ctx.hookSystem) {
          ctx.hookSystem.removeSkillHooks(this.skill.name);
        }
      }
    }

    // inline 模式：注入当前对话，触发 LLM 响应（hooks 随会话长期存活，不卸载）
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
      const { normalizeSkillEffort, resolveSkillAgentType } = await import("../skill/executor.ts");
      const subAgent = SubAgent.fromRegistry(
        ctx.providerRegistry,
        ctx.registry,
        ctx.hookSystem,
        this.skill.model,
      );

      // P1-1：effort/agent 透传（与模型路径 SkillMetaTool 同口径）
      const effort = normalizeSkillEffort(this.skill.effort);
      const agentType = await resolveSkillAgentType(this.skill.agent, this.skill.name);

      const result = await subAgent.executeCustom({
        systemPrompt: "你是一个专注的助手，请完成以下任务。",
        userPrompt: prompt,
        allowedTools: this.skill.allowedTools ?? [],
        // P2-2：与 command/executor.ts 的 fork 命令同档，默认从 10 提到 30
        maxTurns: this.skill.maxTurns ?? 30,
        effort,
        type: agentType ?? `skill:${this.skill.name}`,
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
