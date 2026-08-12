/**
 * 单一 Skill 元工具（P0-1 核心架构对齐）
 *
 * 背景（缺口）：此前每个 skill 注册一个独立 `skill__<name>` 工具（tool.ts），导致：
 *   1. 工具池膨胀（N skill = N 工具定义常驻首轮上下文，靠 MAX_SKILLS=50 硬顶）
 *   2. 信息重复（N 个工具 description + 一份 skill 摘要 listing，同信息进两次上下文）
 *   3. 两层发现失效（skill 工具未声明 shouldDefer，"按需调出"从未发生）
 *
 * CC 做法：全局只有一个 `Skill` 工具，input_schema = { skill, args? }，按名字分发。
 * 摘要 listing 常驻 system prompt 供发现；模型按名调用唯一元工具执行。工具数不随 skill 增长。
 *
 * 本工具是 skill 模型调用路径的唯一入口，汇合：
 *   - P0-3 权限判定（authorizeSkill / resolveSkillAsk，子代理 checker 语义 ask→deny）
 *   - P0-2 生命周期 hooks 注册（registerSkillLifecycleHooks，先权限后 hooks）
 *   - P1-1 effort/agent 透传（buildDelegateTask）
 *   - P3-1 args 参数用通用说明，不塞 argumentHint（argument-hint 只给用户 slash 补全）
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../tool/types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import type { HookSystem } from "../hook/system.ts";
import type { Checker, PermissionRule } from "../permission/types.ts";
import type { SkillDefinition } from "./types.ts";
import type { SkillManager } from "./manager.ts";
import { dirname } from "node:path";
import { SubAgent } from "../agent/sub-agent.ts";
import { getLogger } from "../debug/logger.ts";
import { scanSkillResources } from "./resources.ts";
import {
  authorizeSkill,
  resolveSkillAsk,
  registerSkillLifecycleHooks,
  normalizeSkillEffort,
  resolveSkillAgentType,
} from "./executor.ts";
import { z } from "zod/v4";

/** 元工具名（对齐 CC 的 SKILL_TOOL_NAME='Skill'） */
export const SKILL_TOOL_NAME = "Skill";

/**
 * 元工具输入 schema：{ skill: string, args?: string }。
 * P3-1：args 用通用说明，不塞任何单个 skill 的 argumentHint（那是给用户 slash 补全的）。
 */
const metaSchema = z.object({
  skill: z.string().describe("要调用的 Skill 名称（见 system prompt 的 Skill 摘要列表）"),
  args: z.string().optional().describe("传递给 Skill 的输入参数（可选）"),
});

export class SkillMetaTool implements Tool {
  readonly zodSchema = metaSchema;

  private manager: SkillManager;
  private providerRegistry: ProviderRegistry;
  private toolRegistry: ToolRegistry;
  private hookSystem?: HookSystem;
  private permissionChecker?: Checker;
  private permissionRules?: PermissionRule;
  /** 审计第 19 条：activate 分支上报 skill 调用，供压缩时重注入工作流指令 */
  private invokedSkillSink?: (name: string, content: string) => void;

  constructor(
    manager: SkillManager,
    providerRegistry: ProviderRegistry,
    toolRegistry: ToolRegistry,
  ) {
    this.manager = manager;
    this.providerRegistry = providerRegistry;
    this.toolRegistry = toolRegistry;
  }

  /** P0-2：注入 HookSystem（setter 回填，仿 app.ts wireToolHookSystem） */
  setHookSystem(hookSystem: HookSystem): void {
    this.hookSystem = hookSystem;
  }

  /** P0-3：注入权限检查器（子代理 dontAsk 语义，由主会话回填） */
  setPermissionChecker(checker: Checker): void {
    this.permissionChecker = checker;
  }

  /** P0-3：注入统一权限规则（含 Skill(name) 规则），由 cli 回填 */
  setPermissionRules(rules: PermissionRule): void {
    this.permissionRules = rules;
  }

  /**
   * 审计第 19 条：注入 skill 调用上报回调（app 侧接 ctxMgr.addInvokedSkill）。
   *
   * activate 模式把 skill 的 prompt 作为工具结果注入主对话，压缩会把这段旧消息丢掉；
   * ctxMgr 的保留机制（buildInvokedSkillMessages）需要知道「调用过哪些 skill、内容是什么」
   * 才能重注入。这里用 setter 注入而非构造入参，与 setHookSystem / setPermissionChecker
   * 同一模式，避免 skill 层反向依赖 context 层。未注入时退化为不上报（压缩后遗忘工作流）。
   */
  setInvokedSkillSink(sink: (name: string, content: string) => void): void {
    this.invokedSkillSink = sink;
  }

  /**
   * 按 skill 的 mode 分档（本仓库唯一需要函数形态的工具，见 `tool/types.ts` 的说明）。
   *
   * - `activate` 模式：`output` 是 `${header}${skill.prompt}${resources}${inputSection}`
   *   ——**整份 skill 提示词** + 资源清单，注入当前对话上下文用（`executeActivate`）。
   *   动辄数千字符的工作流指令，打到屏幕上纯属噪音 → `"summary"`。
   * - `delegate` 模式：`output` 是子代理跑完后的**真实工作成果**（`executeDelegate` 返回
   *   `result.output`）——那是用户要的交付内容，必须原样展示 → 返回 `undefined` 走默认。
   *
   * 一刀切任何一档都是错的：全 summary 会吞掉 delegate 的交付物，全默认则继续泄漏
   * activate 的提示词。故按 `input.skill` 查 manager 的实际 mode 判定。
   *
   * 容错：skill 查不到 / 未指定时返 `undefined`（原样展示）。那些路径下 `execute` 会走
   * `isError: true` 的错误分支，而消费侧以 `!isError` 为门，本就不受本字段管辖。
   */
  resultDisplayMode(input: unknown): "summary" | undefined {
    const skillName = (input as { skill?: unknown } | undefined)?.skill;
    if (typeof skillName !== "string" || !skillName) return undefined;
    const skill = this.manager.getSkill(skillName);
    if (!skill) return undefined;
    // mode 缺省是 delegate（与 execute() 里 `skill.mode || "delegate"` 保持一致）
    return (skill.mode || "delegate") === "activate" ? "summary" : undefined;
  }

  name(): string {
    return SKILL_TOOL_NAME;
  }

  description(): string {
    return (
      "调用一个可用的 Skill（专业能力包）。可用 Skill 及其用途见 system prompt 的" +
      " Skill 摘要列表。按 skill 名称调用，args 传入参数。"
    );
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(this.zodSchema) as Record<string, unknown>;
  }

  readOnly(): boolean {
    // 元工具是否只读取决于被调用的 skill——保守起见声明为非只读（skill 可能 write/edit/bash）。
    // 具体 skill 的写能力由其 allowedTools + 子代理内权限判定把控。
    return false;
  }

  /**
   * P0-1 + P3-2：导出可被模型调用的 skill 摘要条目，供 system prompt 的常驻 skill listing 使用。
   *
   * 数据源从 SkillManager 取（此前来自各 SkillTool 实例，现工具收敛为单一元工具）。
   * disableModelInvocation / disabled 的 skill 不进模型 listing（模型看到也调不了）。
   */
  getListingEntries(): import("./budget.ts").SkillListingEntry[] {
    // P1-2/P3-2：只列可 listing 的 skill（排除被 gate 的条件激活 skill）。
    // 条件 skill 激活后由 SkillActivationCoordinator 经 reminder 增量注入，不进静态 system prompt。
    return this.manager.getListableSkills().map((s) => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      isBundled: s.loadedFrom === "bundled" || s.isBuiltin === true,
    }));
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { skill?: string; args?: string };
    const skillName = (params.skill || "").trim();
    const userInput = params.args || "";

    if (!skillName) {
      return { output: "错误：必须指定 skill 名称。", isError: true };
    }

    // 按名分发（不区分大小写）
    const skill = this.manager.getSkill(skillName);
    if (!skill) {
      const available = this.manager
        .getSkills()
        .filter((s) => !s.disableModelInvocation)
        .map((s) => s.name);
      return {
        output: `错误：未知 Skill "${skillName}"。可用: ${available.join(", ") || "（无）"}`,
        isError: true,
      };
    }

    // disableModelInvocation 的 skill 经元工具调用被拒（但仍在用户 / 列表）
    if (skill.disableModelInvocation) {
      return {
        output: `错误：Skill "${skill.name}" 已禁止模型自动调用（仅可用户通过 /${skill.name} 触发）。`,
        isError: true,
      };
    }

    if (skill.disabled) {
      return { output: `错误：Skill "${skill.name}" 已被禁用。`, isError: true };
    }

    // P1-2：条件激活 skill 在触发前不可调用。gate 只把它挡出 listing 是不够的——
    // 模型仍可凭猜名或历史上下文按名直接调用，绕过 paths 条件。CC 的口径是
    // getAllCommands 不含未激活的 conditionalSkills，findCommand 直接失败（errorCode 2），
    // 这里给出等价语义并说明触发条件，便于模型转向正确做法。
    if (this.manager.isGated(skill.name)) {
      const paths = skill.paths?.length ? skill.paths.join(", ") : "特定文件";
      return {
        output: `错误：Skill "${skill.name}" 是条件激活 skill，尚未触发（需先接触匹配 ${paths} 的文件），当前不可调用。`,
        isError: true,
      };
    }

    // ── P0-3：权限判定（先于 hooks 注册与执行）──
    const auth = authorizeSkill(skill, { permissionRules: this.permissionRules });
    if (auth.decision === "deny") {
      log.warn("SKILL", `skill "${skill.name}" 被权限拒绝`);
      return { output: `权限拒绝：${auth.reason ?? skill.name}`, isError: true };
    }
    if (auth.decision === "ask") {
      // 模型路径用子代理 checker（dontAsk 语义：ask→deny）
      const allowed = await resolveSkillAsk(skill, auth.reason ?? "", {
        checker: this.permissionChecker,
      });
      if (!allowed) {
        return { output: `权限未授予：Skill "${skill.name}" 需确认但未获批准。`, isError: true };
      }
    }

    // ── P0-2：授权通过后注册生命周期 hooks（MCP 来源已在内部拒绝）──
    // 模型路径 skill 走 delegate 子代理执行。子代理有独立 hookSystem 时，hooks 应注册到子代理侧；
    // 但当前 SubAgent.fromRegistry 复用主 hookSystem，故注册到主 hookSystem 并在 delegate 返回后卸载，
    // 避免 delegate skill 的 hooks 泄漏到主会话（对齐 §18 P0-2 实施方案第 3 点的作用域决策）。
    const registeredHookCount = registerSkillLifecycleHooks(skill, this.hookSystem);

    try {
      const mode = skill.mode || "delegate";
      if (mode === "activate") {
        return await this.executeActivate(skill, userInput);
      }
      return await this.executeDelegate(skill, userInput, signal);
    } finally {
      // delegate skill 的 hooks 是本次调用作用域，返回后卸载（activate 注入主对话则长期存活，
      // 但 activate 走的是 inline 语义，此处 delegate 分支才卸载）。为简化：只要注册过就卸载，
      // activate 模式若需长期 hooks 应通过 inline 斜杠路径（SkillCommand）注入。
      if (registeredHookCount > 0 && this.hookSystem) {
        const removed = this.hookSystem.removeSkillHooks(skill.name);
        if (removed > 0) {
          log.debug("SKILL", `delegate skill "${skill.name}" 返回，卸载 ${removed} 个会话 hook`);
        }
      }
    }
  }

  /** 激活模式：将 Skill 指令和资源目录作为工具结果返回（注入当前对话上下文） */
  private async executeActivate(skill: SkillDefinition, userInput: string): Promise<ToolResult> {
    const log = getLogger();
    log.info("SKILL", `激活 Skill: ${skill.name}`, { mode: "activate" });

    const folderStructure = skill.skillRoot ? await scanSkillResources(skill.skillRoot) : "";
    const header = skill.skillRoot ? `Base directory for this skill: ${skill.skillRoot}\n\n` : "";
    const resources = folderStructure ? `\n\n可用资源:\n${folderStructure}` : "";
    const inputSection = userInput ? `\n\n用户输入:\n${userInput}` : "";

    this.manager.activateSkill(skill.name);

    const output = `${header}${skill.prompt}${resources}${inputSection}`;

    // 审计第 19 条：在真正执行注入的这一方上报，供压缩时重注入 skill 工作流指令。
    // 上报的是实际进入上下文的完整内容（含 Base directory 头部与资源清单），
    // 而非裸 skill.prompt——压缩后重注入的必须与模型当初看到的一致。
    // delegate 分支不上报：那份 prompt 活在子代理上下文里，主对话压缩与它无关。
    try {
      this.invokedSkillSink?.(skill.name, output);
    } catch (e: any) {
      // 上报失败只影响「压缩后能否重注入」，不该让 skill 调用本身失败
      log.warn("SKILL", `记录 activate skill 调用失败（不阻断）: ${e?.message ?? String(e)}`);
    }

    return { output, isError: false };
  }

  /** delegate 模式：子代理执行，返回最终输出（P1-1：透传 effort/agent） */
  private async executeDelegate(
    skill: SkillDefinition,
    userInput: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const log = getLogger();
    log.info("SKILL", `执行 Skill: ${skill.name}`, {
      mode: "delegate",
      input: userInput.slice(0, 200),
    });

    // 资源清单 + 绝对目录路径（delegate 子 agent 工作目录是项目目录，需绝对路径读 skill 资源）
    const resourceHint = await this.buildResourceHint(skill);
    const userPrompt =
      skill.prompt + resourceHint + (userInput ? `\n\n用户输入:\n${userInput}` : "");

    // P1-1：effort/agent 透传
    const effort = normalizeSkillEffort(skill.effort);
    const agentType = await resolveSkillAgentType(skill.agent, skill.name);

    const subAgent = SubAgent.fromRegistry(
      this.providerRegistry,
      this.toolRegistry,
      this.hookSystem,
      skill.model,
    );
    if (this.permissionChecker) subAgent.setPermissionChecker(this.permissionChecker);

    const maxTurns = Math.min(skill.maxTurns || 30, 50);
    const timeoutMins = Math.min(skill.timeoutMins || 2, 30);
    const timeout = timeoutMins * 60_000;

    const result = await subAgent.executeCustom(
      {
        systemPrompt: `你是一个专门执行 "${skill.name}" 任务的代理。${skill.description}`,
        userPrompt,
        allowedTools: skill.allowedTools || [],
        maxTurns,
        timeout,
        // P1-1：effort 透传（provider reasoningEffort 生效）
        effort,
        // P1-1：agent 优先作为 agent 类型（memory/system prompt 跟随）；否则沿用 skill:<name>
        type: agentType ?? `skill:${skill.name}`,
      },
      signal,
    );

    log.info("SKILL", `Skill ${skill.name} 完成`, {
      success: result.success,
      turns: result.turns,
    });

    return { output: result.output, isError: !result.success };
  }

  /**
   * 构造 delegate 子代理的资源清单提示片段。
   *
   * 背景：子代理的工作目录 = 项目目录（sub-agent.ts 的 workdir=process.cwd()），不是 skill
   * 目录。SKILL.md 正文常写 `references/xxx.md`、`scripts/xxx.ts` 这类相对路径，子代理直接
   * Read 会落到项目目录而读不到。解决：把 skill 资源的**绝对目录**连同目录树注入 prompt，
   * 并明确要求用绝对路径读取/执行——只给出目录路径是不够的，模型仍会沿用正文里的相对写法。
   *
   * - 无 references/scripts/assets 资源时返回空串（不污染 prompt）。
   * - skillRoot 缺失时回退 dirname(filePath)；两者都无则返回空串，不阻断执行。
   */
  private async buildResourceHint(skill: SkillDefinition): Promise<string> {
    const skillDir = skill.skillRoot || (skill.filePath ? dirname(skill.filePath) : "");
    if (!skillDir) return "";

    let folderStructure: string;
    try {
      folderStructure = await scanSkillResources(skillDir);
    } catch {
      return "";
    }
    if (!folderStructure) return "";

    return `\n\n---\n\n## Skill 资源文件（重要：读取方式）

本 Skill 自带以下资源文件，位于**绝对目录** \`${skillDir}\`：

${folderStructure}

**读取规则（务必遵守）**：
- 你的工作目录是被处理的**项目目录**，不是上面的 Skill 目录。
- SKILL.md 正文里出现的 \`references/xxx\`、\`scripts/xxx\`、\`validations/xxx\` 等相对路径，**一律拼成绝对路径**再访问：例如 \`${skillDir}/references/output-template.md\`。
- 用 \`read\` 工具读 references/validations，用 \`bash\` 执行 scripts 时也用上述绝对路径。
- **切勿**用相对路径直接读这些资源——那会落到项目目录、读取失败。`;
  }
}
