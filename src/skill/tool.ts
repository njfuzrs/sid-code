/**
 * Skill 工具
 * 将 SkillDefinition 包装为 Tool 接口，LLM 可自动调用
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../tool/types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import { SubAgent } from "../agent/sub-agent.ts";
import { getLogger } from "../debug/logger.ts";
import type { SkillDefinition } from "./types.ts";
import { scanSkillResources } from "./resources.ts";
import { dirname } from "node:path";
import { z } from "zod/v4";

/**
 * Skill 工具输入 schema 工厂 —— 运行时校验 + JSON Schema 生成的唯一真相源。
 *
 * 动态注册的工具（每个 skill 一个实例）此前绕过执行器的 zod 校验，模型给畸形
 * 参数（如 input:123）会带病走到 executeDelegate 内部。这里补上 zodSchema 后，
 * query/agent 两个 executor 的 safeParse 在工具边界统一拦截。
 * description 取 skill 的 argumentHint（逐 skill 不同），故按实例构造。
 */
function buildSkillSchema(argumentHint?: string) {
  return z.object({
    input: z.string().describe(argumentHint || "传递给 Skill 的输入参数"),
  });
}

export class SkillTool implements Tool {
  private skill: SkillDefinition;
  private providerRegistry: ProviderRegistry;
  private toolRegistry: ToolRegistry;
  /** 权限检查器（子代理 dontAsk 语义，由主会话注入） */
  private permissionChecker?: import("../permission/types.ts").Checker;

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema: z.ZodType;

  constructor(skill: SkillDefinition, providerRegistry: ProviderRegistry, toolRegistry: ToolRegistry) {
    this.skill = skill;
    this.providerRegistry = providerRegistry;
    this.toolRegistry = toolRegistry;
    this.zodSchema = buildSkillSchema(skill.argumentHint);
  }

  /** 注入权限检查器（子代理 dontAsk 语义） */
  setPermissionChecker(checker: import("../permission/types.ts").Checker): void {
    this.permissionChecker = checker;
  }

  name(): string {
    return `skill__${this.skill.name}`;
  }

  description(): string {
    let desc = this.skill.description;
    if (this.skill.whenToUse) {
      desc += `\n何时使用: ${this.skill.whenToUse}`;
    }
    return desc;
  }

  /**
   * 缺口 E：导出 Skill 摘要条目（供 system prompt 的 skill 摘要列表使用）。
   *
   * 此前 generateSkillListingAttachment 是死代码，skill 摘要从未进系统提示词；
   * 一旦 skill 工具被 defer，模型连 whenToUse 都看不到。这里把每个 SkillTool 的
   * 摘要导出，由调用方收集后注入常驻 system prompt，实现"摘要常驻发现 + 工具按需调出"
   * 的两层结构（不依赖工具是否被 defer）。
   */
  getListingEntry(): import("./budget.ts").SkillListingEntry {
    return {
      name: this.skill.name,
      description: this.skill.description,
      whenToUse: this.skill.whenToUse,
      isBundled: this.skill.loadedFrom === "bundled" || this.skill.isBuiltin === true,
    };
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(this.zodSchema) as Record<string, unknown>;
  }

  readOnly(): boolean {
    // Skill 可能执行写操作，取决于 allowedTools
    const writeTools = ["write", "edit", "bash"];
    if (this.skill.allowedTools) {
      return !this.skill.allowedTools.some(t => writeTools.includes(t));
    }
    return true;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {    const mode = this.skill.mode || "delegate";

    if (mode === "activate") {
      return this.executeActivate(input);
    }
    return this.executeDelegate(input, signal);
  }

  /**
   * 激活模式：将 Skill 指令和资源目录注入当前对话上下文
   */
  private async executeActivate(input: unknown): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { input: string };
    const userInput = params.input || "";

    log.info("SKILL", `激活 Skill: ${this.skill.name}`, { mode: "activate" });

    const skillDir = dirname(this.skill.filePath);
    const folderStructure = await scanSkillResources(skillDir);

    const output = `<activated_skill name="${this.skill.name}">
  <instructions>
${this.skill.prompt}
  </instructions>
${folderStructure ? `\n  <available_resources>\n${folderStructure}\n  </available_resources>` : ""}
</activated_skill>

Skill "${this.skill.name}" 已激活。${userInput ? `\n\n用户输入: ${userInput}` : ""}`;

    return {
      output,
      isError: false,
    };
  }

  /**
   * 构造 delegate 子 agent 的资源清单提示片段。
   *
   * 背景：子 agent 的工作目录 = 项目目录（sub-agent.ts 的 workdir=process.cwd()），
   * 不是 skill 目录。SKILL.md 正文常写 `references/xxx.md`、`scripts/xxx.ts` 相对路径，
   * 子 agent 直接 Read 会落到项目目录而读不到。解决：把 skill 资源的**绝对目录**
   * 连同目录树注入 prompt，并明确要求用绝对路径读取/执行。
   *
   * - 无 references/scripts/assets 资源时返回空串（不污染 prompt）。
   * - filePath 缺失（理论不该发生）时降级为空串，不阻断执行。
   */
  private async buildResourceHint(): Promise<string> {
    if (!this.skill.filePath) return "";
    const skillDir = this.skill.skillRoot || dirname(this.skill.filePath);
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

  /**
   * 委托模式：通过 SubAgent 独立执行
   */
  private async executeDelegate(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { input: string };
    const userInput = params.input || "";

    log.info("SKILL", `执行 Skill: ${this.skill.name}`, { mode: "delegate", input: userInput.slice(0, 200) });

    // 注入 skill 资源清单 + 绝对目录路径（修复 delegate 模式读不到 references/scripts 的缺口）。
    // 子 agent 工作目录是项目目录（process.cwd()），而非 skill 目录，SKILL.md 正文里写的
    // `references/xxx.md`、`scripts/xxx.ts` 相对路径若直接 Read 会落到项目目录、读不到。
    // 这里把 skill 真实目录的绝对路径连同资源树告诉子 agent，并强制要求用绝对路径读取。
    const resourceHint = await this.buildResourceHint();

    // 构建用户提示词：Skill 模板 + 资源清单 + 用户输入
    const userPrompt =
      this.skill.prompt + resourceHint + (userInput ? `\n\n用户输入:\n${userInput}` : "");

    // 通过 registry 创建 SubAgent，skill.model 作为 modelOverride
    const subAgent = SubAgent.fromRegistry(
      this.providerRegistry,
      this.toolRegistry,
      undefined,
      this.skill.model,
    );
    if (this.permissionChecker) subAgent.setPermissionChecker(this.permissionChecker);

    // 使用配置的 maxTurns 和 timeout
    const maxTurns = Math.min(this.skill.maxTurns || 10, 50);
    const timeoutMins = Math.min(this.skill.timeoutMins || 2, 30);
    const timeout = timeoutMins * 60_000;

    const result = await subAgent.executeCustom({
      systemPrompt: `你是一个专门执行 "${this.skill.name}" 任务的代理。${this.skill.description}`,
      userPrompt,
      allowedTools: this.skill.allowedTools || [],
      maxTurns,
      timeout,
    }, signal);

    log.info("SKILL", `Skill ${this.skill.name} 完成`, {
      success: result.success,
      turns: result.turns,
    });

    return {
      output: result.output,
      isError: !result.success,
    };
  }
}

/**
 * 缺口 E：从工具列表中收集所有 SkillTool 的摘要条目。
 *
 * 调用方（buildInitialSystemPrompt / app.ts CLAUDE.md 重建）把 toolRegistry 的工具
 * 传进来，本函数过滤出 SkillTool 实例并导出其摘要，供 buildSystemPrompt 注入常驻
 * skill 摘要列表。空列表时返回 undefined（避免给 ctx.skillEntries 喂空数组）。
 */
export function collectSkillListingEntries(
  tools: ReadonlyArray<unknown>,
): import("./budget.ts").SkillListingEntry[] | undefined {
  const entries = tools
    .filter((t): t is SkillTool => t instanceof SkillTool)
    .map((t) => t.getListingEntry());
  return entries.length > 0 ? entries : undefined;
}
