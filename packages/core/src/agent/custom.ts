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
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * frontmatter `timeout` 的合法区间（毫秒）。
 *
 * B5-5（§5 缺口 C）：此前 `timeout` **完全无上限**——frontmatter 写
 * `timeout: 999999999` 就能把单个子代理的最坏墙钟拉到 11 天。这不是理论风险：
 * 缺口 C 已算清退避累计（base 5s / cap 120s）第 7 次就到 395s，超时越大 = 越多次
 * 退避真的被跑完，"有界"这个安全性质是**靠外层超时提供的**，把它放开就一起没了。
 *
 * 上限取 600s：内置 agent 最长 360s（`agent-definition.ts`），留出约 1.7× 余量给
 * 自定义 agent 声明更重的任务，同时保证最坏耗时仍在"人能等"的量级。
 * 下限取 10s：比一次退避（cap 120s）还短的 timeout 会让子代理在第一次限流退避中途
 * 就被 abort，永远等不到重试结果——写这种值几乎总是笔误，钳到 10s 并 warn 比默默接受好。
 *
 * 越界不报错、不 spawn 失败，而是**钳制到边界 + warn**：与本文件其它 frontmatter
 * 字段（permissionMode / isolation 非法值 warn 跳过）的既有口径一致。
 */
export const CUSTOM_AGENT_TIMEOUT_MIN_MS = 10_000;
export const CUSTOM_AGENT_TIMEOUT_MAX_MS = 600_000;

/**
 * 解析并钳制 frontmatter `timeout`（B5-5）。
 *
 * @returns 钳制后的毫秒值；非数字 / NaN / 非正数 → `undefined`（由调用方回落默认 300s）。
 */
export function parseAgentTimeout(raw: unknown, agentName: string): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    // 非数字（含 NaN / Infinity）：静默回落默认值。frontmatter 未声明是常态，不该 warn。
    if (raw !== undefined && raw !== null) {
      getLogger().warn(
        "CUSTOM_AGENT",
        `Agent ${agentName} 的 timeout=${String(raw)} 非有效数字，已忽略（回落默认 300s）`,
      );
    }
    return undefined;
  }
  if (raw <= 0) {
    getLogger().warn(
      "CUSTOM_AGENT",
      `Agent ${agentName} 的 timeout=${raw} 非正数，已忽略（回落默认 300s）`,
    );
    return undefined;
  }
  if (raw < CUSTOM_AGENT_TIMEOUT_MIN_MS) {
    getLogger().warn(
      "CUSTOM_AGENT",
      `Agent ${agentName} 的 timeout=${raw}ms 小于下限，已钳制到 ${CUSTOM_AGENT_TIMEOUT_MIN_MS}ms`,
    );
    return CUSTOM_AGENT_TIMEOUT_MIN_MS;
  }
  if (raw > CUSTOM_AGENT_TIMEOUT_MAX_MS) {
    getLogger().warn(
      "CUSTOM_AGENT",
      `Agent ${agentName} 的 timeout=${raw}ms 超过上限，已钳制到 ${CUSTOM_AGENT_TIMEOUT_MAX_MS}ms`,
    );
    return CUSTOM_AGENT_TIMEOUT_MAX_MS;
  }
  return raw;
}

/** 合法权限模式名（P2-1 校验，对齐 src/permission/mode.ts PermissionMode）。 */
const VALID_PERMISSION_MODES = new Set([
  "default",
  "always-allow",
  "deny-write",
  "acceptEdits",
  "plan",
  "dontAsk",
  "auto",
  "dangerously-skip-permissions",
]);

/**
 * 从 frontmatter 提取扩展字段（P0-2/P1-1/P1-2/P2-1 共用）。
 * 非法值 warn 跳过（不 spawn 失败），返回可直接展开进 CustomAgentDefinition 的部分对象。
 */
export function parseAgentExtendedFrontmatter(
  fm: Record<string, unknown>,
  agentName: string,
): Pick<
  CustomAgentDefinition,
  "model" | "skills" | "color" | "permissionMode" | "hooks" | "background" | "isolation"
> {
  const log = getLogger();
  const out: Pick<
    CustomAgentDefinition,
    "model" | "skills" | "color" | "permissionMode" | "hooks" | "background" | "isolation"
  > = {};

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
    else if (pm)
      log.warn("CUSTOM_AGENT", `Agent ${agentName} 的 permissionMode="${pm}" 非法，已忽略`);
  }

  // hooks（P2-1）：透传对象/数组，非法结构由 hook 注册层校验。
  if (fm.hooks && typeof fm.hooks === "object") out.hooks = fm.hooks;

  // background（P2-1）：布尔。
  if (typeof fm.background === "boolean") out.background = fm.background;

  // isolation（P2-1）：仅接受 "worktree"，非法值 warn 跳过。
  if (typeof fm.isolation === "string") {
    const iso = fm.isolation.trim();
    if (iso === "worktree") out.isolation = "worktree";
    else if (iso)
      log.warn(
        "CUSTOM_AGENT",
        `Agent ${agentName} 的 isolation="${iso}" 非法（仅支持 worktree），已忽略`,
      );
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
    const files = await this.extensionLoader.scan(
      "agents",
      projectDir ?? process.cwd(),
      scanOptions,
    );
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
        // B5-5：钳制到 [10s, 600s]。此前是裸 `typeof === "number"` 直通，无任何上限。
        timeout: parseAgentTimeout(fm.timeout, agentName),
        // P0-2/P1-1/P1-2/P2-1：消费扩展 frontmatter 字段（model/skills/color/permissionMode/hooks/background/isolation）。
        ...parseAgentExtendedFrontmatter(fm, agentName),
      });
    }

    if (agents.length > 0) {
      log.info("CUSTOM_AGENT", `加载了 ${agents.length} 个自定义 Agent`, {
        names: agents.map((a) => a.name),
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

  constructor(
    def: CustomAgentDefinition,
    providerRegistry: ProviderRegistry,
    toolRegistry: ToolRegistry,
  ) {
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
    return !this.def.tools.some((t) => writeTools.includes(t));
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const log = getLogger();
    const params = input as { task: string };
    const task = params.task || "";

    log.info("CUSTOM_AGENT", `执行自定义 Agent: ${this.def.name}`, { task: task.slice(0, 200) });

    const subAgent = SubAgent.fromRegistry(this.providerRegistry, this.toolRegistry);

    const result = await subAgent.executeCustom(
      {
        systemPrompt: this.def.prompt,
        userPrompt: task,
        allowedTools: this.def.tools,
        // P2-2：自定义 Agent 无独立 maxTurns 声明字段，与常规非 fork 子代理同档，默认从 10 提到 30
        maxTurns: 30,
        // 三级回退：Frontmatter 声明 > 默认 300s（对齐 task 类型，自定义 agent 执行复杂任务）
        timeout: this.def.timeout ?? 300_000,
        // G13：把自定义 Agent 类型透传给子代理，让 save_memory 的 agent scope 定位到该类型记忆目录
        type: this.def.name,
      },
      signal,
    );

    // P0-1：把自定义子代理消耗的 token/费用回写主会话
    if (this.usageSink) {
      const u = result.usage;
      const hasUsage =
        (u?.inputTokens ?? 0) > 0 ||
        (u?.outputTokens ?? 0) > 0 ||
        (u?.cacheReadInputTokens ?? 0) > 0 ||
        (u?.cacheCreationInputTokens ?? 0) > 0;
      if (hasUsage) {
        try {
          this.usageSink(result);
        } catch (err: any) {
          log.warn("CUSTOM_AGENT", `usage 归集失败（不影响结果）: ${err?.message}`);
        }
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
