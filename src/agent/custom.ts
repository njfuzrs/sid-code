/**
 * 自定义 Agent
 * 从 .sid-code/agents/*.md 加载用户自定义 Agent 定义
 * 每个 Agent 包装为 Tool，LLM 可自动调用
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "../tool/types.ts";
import type { ProviderRegistry } from "../llm/registry.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import { ExtensionLoader } from "../extension/loader.ts";
import type { ScanOptions } from "../extension/types.ts";
import { SubAgent } from "./sub-agent.ts";
import { getLogger } from "../debug/logger.ts";
import type { ExtensionSource } from "../extension/types.ts";
import { z } from "zod/v4";

/**
 * 自定义 Agent 工具输入 schema —— 运行时校验 + JSON Schema 生成的唯一真相源。
 *
 * 动态注册（每个自定义 agent 一个实例），所有实例 schema 相同（固定 task 字段），
 * 故用模块级常量。补上后 executor 的 safeParse 在工具边界拦截畸形 task 参数。
 */
const customAgentSchema = z.object({
  task: z.string().describe("要执行的任务描述"),
});

/** 自定义 Agent 定义 */
export interface CustomAgentDefinition {
  name: string;
  description: string;
  tools: string[];
  prompt: string;
  source: ExtensionSource;
  filePath: string;
  /** 超时时间（毫秒），默认 300_000（5 分钟，对齐 task 类型） */
  timeout?: number;
  /** 模型覆盖（P0-2，frontmatter model；"inherit"/空 = 继承主模型） */
  model?: string;
  /** 预加载技能名列表（P1-1，frontmatter skills） */
  skills?: string[];
  /** UI 区分色（P1-2，frontmatter color） */
  color?: string;
  /** 权限模式（P2-1，frontmatter permissionMode） */
  permissionMode?: string;
  /** agent 专用 hooks（P2-1，frontmatter hooks） */
  hooks?: unknown;
  /** 是否默认后台执行（P2-1，frontmatter background） */
  background?: boolean;
  /** 是否默认 worktree 隔离（P2-1，frontmatter isolation） */
  isolation?: "worktree";
}

/**
 * 解析「逗号分隔字符串或 YAML 数组」双格式字段（tools/skills 共用）。
 * 非字符串非数组 → 空数组。
 */
export function parseListField(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map(String).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** 合法权限模式名（P2-1 校验，对齐 src/permission/mode.ts PermissionMode）。 */
const VALID_PERMISSION_MODES = new Set([
  "default", "always-allow", "deny-write", "acceptEdits",
  "plan", "dontAsk", "auto", "dangerously-skip-permissions",
]);

/**
 * 从 frontmatter 提取扩展字段（P0-2/P1-1/P1-2/P2-1 共用）。
 * 非法值 warn 跳过（不 spawn 失败），返回可直接展开进 CustomAgentDefinition 的部分对象。
 */
export function parseAgentExtendedFrontmatter(
  fm: Record<string, unknown>,
  agentName: string,
): Pick<CustomAgentDefinition, "model" | "skills" | "color" | "permissionMode" | "hooks" | "background" | "isolation"> {
  const log = getLogger();
  const out: Pick<CustomAgentDefinition, "model" | "skills" | "color" | "permissionMode" | "hooks" | "background" | "isolation"> = {};

  // model（P0-2）："inherit"（大小写不敏感）视为不设。
  if (typeof fm.model === "string") {
    const m = fm.model.trim();
    if (m && m.toLowerCase() !== "inherit") out.model = m;
  }

  // skills（P1-1）：双格式解析。
  const skills = parseListField(fm.skills);
  if (skills.length > 0) out.skills = skills;

  // color（P1-2）：字符串；色板校验交给注册层（此处只透传，非法值由 color 注册器 warn）。
  if (typeof fm.color === "string" && fm.color.trim()) out.color = fm.color.trim();

  // permissionMode（P2-1）：枚举校验，非法值 warn 跳过。
  if (typeof fm.permissionMode === "string") {
    const pm = fm.permissionMode.trim();
    if (VALID_PERMISSION_MODES.has(pm)) out.permissionMode = pm;
    else if (pm) log.warn("CUSTOM_AGENT", `Agent ${agentName} 的 permissionMode="${pm}" 非法，已忽略`);
  }

  // hooks（P2-1）：透传对象/数组，非法结构由 hook 注册层校验。
  if (fm.hooks && typeof fm.hooks === "object") out.hooks = fm.hooks;

  // background（P2-1）：布尔。
  if (typeof fm.background === "boolean") out.background = fm.background;

  // isolation（P2-1）：仅接受 "worktree"，非法值 warn 跳过。
  if (typeof fm.isolation === "string") {
    const iso = fm.isolation.trim();
    if (iso === "worktree") out.isolation = "worktree";
    else if (iso) log.warn("CUSTOM_AGENT", `Agent ${agentName} 的 isolation="${iso}" 非法（仅支持 worktree），已忽略`);
  }

  return out;
}

/** 自定义 Agent 加载器 */
export class CustomAgentLoader {
  private extensionLoader: ExtensionLoader;

  constructor(extensionLoader?: ExtensionLoader) {
    this.extensionLoader = extensionLoader ?? new ExtensionLoader();
  }

  /** 加载所有自定义 Agent 定义 */
  async loadAll(projectDir?: string, scanOptions?: ScanOptions): Promise<CustomAgentDefinition[]> {
    const log = getLogger();
    const files = await this.extensionLoader.scan("agents", projectDir ?? process.cwd(), scanOptions);
    const agents: CustomAgentDefinition[] = [];

    for (const file of files) {
      const fm = file.frontmatter;

      // 解析 tools（支持逗号分隔字符串或数组）
      const tools = parseListField(fm.tools);
      const agentName = (fm.name as string) || file.name;

      agents.push({
        name: agentName,
        description: (fm.description as string) || "",
        tools,
        prompt: file.body,
        source: file.source,
        filePath: file.filePath,
        timeout: typeof fm.timeout === "number" ? fm.timeout : undefined,
        // P0-2/P1-1/P1-2/P2-1：消费扩展 frontmatter 字段（model/skills/color/permissionMode/hooks/background/isolation）。
        ...parseAgentExtendedFrontmatter(fm, agentName),
      });
    }

    if (agents.length > 0) {
      log.info("CUSTOM_AGENT", `加载了 ${agents.length} 个自定义 Agent`, {
        names: agents.map(a => a.name),
      });
    }

    return agents;
  }
}

/**
 * 自定义 Agent 工具（包装为 Tool 接口）。
 *
 * @deprecated P2-4：双注册收敛后，自定义/插件 agent 不再包装为独立 `agent__xxx` 工具，
 * 而是统一通过 `sub_agent({type: "<name>"})` 访问（对齐 CC 单 Agent 工具模型）。
 * cli.ts 已停止注册此类实例；保留类定义仅为兼容期回归测试与潜在外部引用。
 * 新代码请勿再注册 CustomAgentTool——用 registerDynamicAgents 让 agent 进 sub_agent 通道。
 */
export class CustomAgentTool implements Tool {
  private def: CustomAgentDefinition;
  private providerRegistry: ProviderRegistry;
  private toolRegistry: ToolRegistry;
  /** 子代理 usage 归集 sink（P0-1，由主会话注入） */
  private usageSink?: import("./tool.ts").SubAgentUsageSink;

  /** zod schema：执行器据此做运行时校验，registry 据此生成 LLM 定义 */
  readonly zodSchema = customAgentSchema;

  constructor(def: CustomAgentDefinition, providerRegistry: ProviderRegistry, toolRegistry: ToolRegistry) {
    this.def = def;
    this.providerRegistry = providerRegistry;
    this.toolRegistry = toolRegistry;
  }

  /** 注入 usage 归集 sink（P0-1） */
  setUsageSink(sink: import("./tool.ts").SubAgentUsageSink): void {
    this.usageSink = sink;
  }

  /** 注入错误回调（推入统一错误面板），由 wireToolErrorCallback 鸭子类型接线注入。 */
  private onErrorCallback?: (message: string) => void;
  setErrorCallback(cb: (message: string) => void): void {
    this.onErrorCallback = cb;
  }

  name(): string {
    return `agent__${this.def.name}`;
  }

  description(): string {
    return this.def.description || `自定义 Agent: ${this.def.name}`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(customAgentSchema) as Record<string, unknown>;
  }

  readOnly(): boolean {
    const writeTools = ["write", "edit", "bash"];
    return !this.def.tools.some(t => writeTools.includes(t));
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { task: string };
    const task = params.task || "";

    log.info("CUSTOM_AGENT", `执行自定义 Agent: ${this.def.name}`, { task: task.slice(0, 200) });

    const subAgent = SubAgent.fromRegistry(this.providerRegistry, this.toolRegistry);

    const result = await subAgent.executeCustom({
      systemPrompt: this.def.prompt,
      userPrompt: task,
      allowedTools: this.def.tools,
      // P2-2：自定义 Agent 无独立 maxTurns 声明字段，与常规非 fork 子代理同档，默认从 10 提到 30
      maxTurns: 30,
      // 三级回退：Frontmatter 声明 > 默认 300s（对齐 task 类型，自定义 agent 执行复杂任务）
      timeout: this.def.timeout ?? 300_000,
      // G13：把自定义 Agent 类型透传给子代理，让 save_memory 的 agent scope 定位到该类型记忆目录
      type: this.def.name,
    }, signal);

    // P0-1：把自定义子代理消耗的 token/费用回写主会话
    if (this.usageSink) {
      const u = result.usage;
      const hasUsage = (u?.inputTokens ?? 0) > 0 || (u?.outputTokens ?? 0) > 0 ||
        (u?.cacheReadInputTokens ?? 0) > 0 || (u?.cacheCreationInputTokens ?? 0) > 0;
      if (hasUsage) {
        try { this.usageSink(result); }
        catch (err: any) { log.warn("CUSTOM_AGENT", `usage 归集失败（不影响结果）: ${err?.message}`); }
      }
    }

    log.info("CUSTOM_AGENT", `Agent ${this.def.name} 完成`, {
      success: result.success,
      turns: result.turns,
    });

    if (!result.success && this.onErrorCallback) {
      this.onErrorCallback(result.output);
    }

    return {
      output: result.output,
      isError: !result.success,
    };
  }
}
