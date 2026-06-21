/**
 * 工具注册表（分层架构）
 *
 * Layer 1：静态注册（内置工具 + MCP 工具分开存储）
 * Layer 2：动态过滤与组装（isEnabled + deny rules + 模式裁剪 + prompt cache 排序）
 *
 * 注：本注册表显式以 `LegacyTool` 为元素类型（历史上曾用 `LegacyTool as Tool` 别名
 * 伪装成新接口，掩盖了"实际全跑 LegacyTool"的事实）。现已正名为 LegacyTool——
 * 由此产生的 @deprecated 提示是**正确的迁移信号**：待 25 个工具全部迁移到新版泛型
 * `Tool` 接口后，此处一并升级，deprecation 自然消除。
 */

import type { LegacyTool } from "./types.ts";
import type { ToolDefinition } from "../llm/types.ts";
import { z } from "zod/v4";
import { getLogger } from "../debug/index.ts";
import { searchToolsWithScoring } from "./tool-search-scoring.ts";

/**
 * 生成单个工具的 LLM 定义。
 *
 * input_schema 来源优先级：
 * 1. 工具提供了 zodSchema → 用 z.toJSONSchema 自动生成（zod v4 内置，无需第三方库），
 *    保证"运行时校验器"与"发给 LLM 的描述"同源，杜绝漂移。
 * 2. 否则回退到手写 inputSchema()（迁移期间未提供 zodSchema 的工具）。
 *
 * z.toJSONSchema 失败时（极少数 schema 含不可序列化结构）降级回退 inputSchema()，
 * 并打 warn 日志，避免单个工具拖垮整个定义列表。
 */
function toolToDefinition(t: LegacyTool): ToolDefinition {
  let desc = t.description();
  if (t.usageGuide) {
    const guide = t.usageGuide();
    if (guide) desc += `\n\n使用指南:\n${guide}`;
  }

  let inputSchema: Record<string, unknown>;
  if (t.zodSchema) {
    try {
      inputSchema = z.toJSONSchema(t.zodSchema) as Record<string, unknown>;
    } catch (err: any) {
      getLogger().warn(
        "TOOL",
        `工具 ${t.name()} 的 zodSchema 转 JSON Schema 失败，回退手写 inputSchema(): ${err?.message ?? err}`,
      );
      inputSchema = t.inputSchema();
    }
  } else {
    inputSchema = t.inputSchema();
  }

  return {
    name: t.name(),
    description: desc,
    input_schema: inputSchema,
  };
}

/** 工具池组装配置 */
export interface AssembleOptions {
  /** 权限规则（deny rules 过滤） */
  denyRules?: string[];
  /** 运行模式 */
  mode?: "normal" | "plan" | "simple";
  /** 子代理类型 */
  agentType?: string;
}

/** simple 模式下可用的工具 */
const SIMPLE_MODE_TOOLS = new Set([
  "read", "grep", "glob", "ls", "read_many",
]);

export class Registry {
  private builtInTools = new Map<string, LegacyTool>();
  private mcpTools = new Map<string, LegacyTool>();
  /** 延迟加载工具集合（预留给 ToolSearch） */
  private deferredTools = new Set<string>();
  /**
   * 运行时激活集合（ToolSearch 调出）。
   *
   * 工具默认延迟（静态 shouldDefer 字段 或 deferredTools 名单）后，模型经 tool_search
   * 把某工具激活；激活后该工具在后续轮次进入首轮上下文（activeDefinitions 不再过滤它）。
   * 这是 markDeferred/unmarkDeferred 之外的"按需调出"通道——名单标记的是"默认不可见"，
   * 激活集合标记的是"已被模型显式调出、本会话保持可见"，二者正交。
   */
  private activatedTools = new Set<string>();

  // ===== Layer 1：静态注册 =====

  /** 注册工具（自动区分内置/MCP） */
  register(tool: LegacyTool): void {
    const name = tool.name();
    if (name.startsWith("mcp__")) {
      this.mcpTools.set(name, tool);
    } else {
      this.builtInTools.set(name, tool);
    }
  }

  /** 根据名称查找工具（两层都查） */
  get(name: string): LegacyTool | undefined {
    return this.builtInTools.get(name) ?? this.mcpTools.get(name);
  }

  /** 返回所有已注册的工具（内置优先，MCP 在后） */
  all(): LegacyTool[] {
    return [...this.builtInTools.values(), ...this.mcpTools.values()];
  }

  // ===== Layer 2：动态过滤与组装 =====

  /**
   * 组装最终工具池
   * 内置工具在前（稳定顺序，利于 prompt cache），MCP 工具在后
   */
  assembleToolPool(options?: AssembleOptions): LegacyTool[] {
    // 1. 内置工具过滤
    let builtIn = [...this.builtInTools.values()];

    // 2. deny rules 过滤
    if (options?.denyRules?.length) {
      const denySet = new Set(options.denyRules);
      builtIn = builtIn.filter(t => !denySet.has(t.name()));
    }

    // 3. 运行模式裁剪
    if (options?.mode === "simple") {
      builtIn = builtIn.filter(t => SIMPLE_MODE_TOOLS.has(t.name()));
    }

    // 4. MCP 工具（同样应用 deny rules，但不受模式裁剪影响）
    let mcp = [...this.mcpTools.values()];
    if (options?.denyRules?.length) {
      const denySet = new Set(options.denyRules);
      mcp = mcp.filter(t => !denySet.has(t.name()));
    }

    // 4.1 MCP 工具按名称排序，保证 prompt cache 稳定性。
    //   多个 MCP server 的连接顺序不确定，会导致工具定义顺序漂移，
    //   进而使 Anthropic prompt cache（基于 tools 定义内容哈希）失效。
    //   内置工具顺序是人工精心编排的（不排序），仅对 MCP 部分排序。
    mcp.sort((a, b) => a.name().localeCompare(b.name()));

    // 5. 内置工具在前（稳定顺序），MCP 工具在后
    return [...builtIn, ...mcp];
  }

  /** 返回所有工具的 LLM 定义（用于发送给 AI） */
  definitions(options?: AssembleOptions): ToolDefinition[] {
    const tools = options ? this.assembleToolPool(options) : this.all();
    const defs = tools.map(toolToDefinition);
    // D2 前缀稳定性：工具定义按 name 固定字典序输出，杜绝注册顺序抖动（尤其 MCP 异步连接顺序）
    // 废掉工具 schema 缓存前缀。序列化顺序只影响请求载荷的缓存前缀，不影响执行查找（按 name 索引）。
    defs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return defs;
  }

  /** 按名称过滤，返回只包含指定工具的新 Registry */
  filter(names: string[]): Registry {
    const filtered = new Registry();
    for (const name of names) {
      const tool = this.get(name);
      if (tool) filtered.register(tool);
    }
    return filtered;
  }

  /** 移除名称以指定前缀开头的所有工具 */
  removeByPrefix(prefix: string): void {
    for (const name of this.builtInTools.keys()) {
      if (name.startsWith(prefix)) this.builtInTools.delete(name);
    }
    for (const name of this.mcpTools.keys()) {
      if (name.startsWith(prefix)) this.mcpTools.delete(name);
    }
  }

  /** 已注册工具数量 */
  size(): number {
    return this.builtInTools.size + this.mcpTools.size;
  }

  /** 内置工具数量 */
  builtInSize(): number {
    return this.builtInTools.size;
  }

  /** MCP 工具数量 */
  mcpSize(): number {
    return this.mcpTools.size;
  }

  // ===== Layer 3：延迟发现（ToolSearch 基础设施） =====
  //
  // 延迟判定多来源（OR 关系，alwaysLoad 与运行时激活优先级最高）：
  // 1. 工具实例的 shouldDefer 字段（内置长尾工具静态声明）
  // 2. MCP 工具(mcp__ 前缀)默认延迟——MCP 是上下文膨胀主因，延迟机制首要对象
  // 3. deferredTools 运行时名单（运行时动态标记的兜底通道）
  // alwaysLoad=true 或已被 ToolSearch 激活的工具强制不延迟，保证首轮可见。

  /** 判定工具是否应延迟加载（不进首轮 LLM 上下文） */
  private isToolDeferred(tool: LegacyTool): boolean {
    if (tool.alwaysLoad) return false;
    // 已被 ToolSearch 运行时激活 → 不再延迟，进首轮上下文
    if (this.activatedTools.has(tool.name())) return false;
    if (tool.shouldDefer) return true;
    // MCP 工具默认延迟：MCP 才是上下文膨胀的主因（单个 server 动辄几十个工具），
    // 延迟加载机制的首要服务对象就是它们（对标 claude-code isDeferredTool 的
    // `tool.isMcp === true` 规则）。按名称前缀识别，与 register() 的内置/MCP 分流同源。
    if (tool.name().startsWith("mcp__")) return true;
    return this.deferredTools.has(tool.name());
  }

  /** 标记工具为可延迟加载（ToolSearch 运行时使用） */
  markDeferred(toolName: string): void {
    this.deferredTools.add(toolName);
    // 重新延迟时清除激活态，保证语义一致（再次延迟意味着撤回此前的调出）
    this.activatedTools.delete(toolName);
  }

  /** 取消延迟标记 */
  unmarkDeferred(toolName: string): void {
    this.deferredTools.delete(toolName);
  }

  /**
   * 激活一个延迟工具（ToolSearchTool 调出）。
   *
   * 激活后该工具不再被 activeDefinitions 过滤，后续轮次进入首轮上下文。
   * 返回是否实际发生状态变化（true=之前确实延迟、现已激活；false=本就可见/未注册）。
   * 用于 ToolSearchTool 区分"新调出"与"已可见"，给模型更精确的反馈。
   */
  activateTool(toolName: string): boolean {
    const tool = this.get(toolName);
    if (!tool) return false;
    if (!this.isToolDeferred(tool)) return false; // 本就可见，无需激活
    this.activatedTools.add(toolName);
    return true;
  }

  /** 工具当前是否已被运行时激活 */
  isActivated(toolName: string): boolean {
    return this.activatedTools.has(toolName);
  }

  /** 检查工具是否为延迟加载（字段 + 名单双来源） */
  isDeferred(toolName: string): boolean {
    const tool = this.get(toolName);
    if (tool) return this.isToolDeferred(tool);
    return this.deferredTools.has(toolName);
  }

  /** 获取非延迟工具的定义（用于初始 prompt，减少 token 消耗） */
  activeDefinitions(options?: AssembleOptions): ToolDefinition[] {
    const tools = options ? this.assembleToolPool(options) : this.all();
    return tools
      .filter((t) => !this.isToolDeferred(t))
      .map(toolToDefinition);
  }

  /**
   * 搜索延迟工具（ToolSearchTool 调用）。
   *
   * 委托 tool-search-scoring 的加权评分（对标 claude-code searchToolsWithKeywords）：
   * 工具名按 CamelCase/mcp__ 拆词，名命中 > searchHint > description，MCP 工具加权，
   * 支持 "+term" 必需词与 mcp__ 前缀快路径。返回按相关度降序排列的工具实例。
   *
   * 内部不截断（取大上限 50），由调用方（ToolSearchTool）按 max_results 截断——
   * 这样调用方能拿到完整排序、自行决定展示多少。
   */
  searchDeferredTools(query: string): LegacyTool[] {
    const deferred = this.all().filter((t) => this.isToolDeferred(t));
    const deferredInfo = deferred.map((t) => ({
      name: t.name(),
      description: t.description(),
      searchHint: t.searchHint,
    }));

    // 严守"仅搜索延迟工具"契约：deferred 同时作为搜索池与精确名快路径的回退池，
    // 不外溢到非延迟工具（跨全量池的精确名匹配由 ToolSearchTool 层的 registry.get
    // 负责，那里语义是"选已加载工具是无害 no-op"）。
    const scored = searchToolsWithScoring(query, deferredInfo, deferredInfo, 50);
    return scored
      .map((s) => this.get(s.name))
      .filter((t): t is LegacyTool => t !== undefined);
  }

  /** 延迟工具数量（字段 + 名单双来源，去重） */
  deferredSize(): number {
    const names = new Set<string>();
    for (const t of this.all()) {
      if (this.isToolDeferred(t)) names.add(t.name());
    }
    // 名单里可能有尚未注册的工具名，一并计入
    for (const name of this.deferredTools) names.add(name);
    return names.size;
  }

  /**
   * 列出当前所有延迟工具的名称（已排序，去重）。
   *
   * 供主循环每轮注入 <available-deferred-tools> 提醒——模型据此知道"有哪些工具
   * 尚未加载、可经 tool_search 调出"。这是延迟加载可用性的关键：不告诉模型延迟工具
   * 的名字，模型就无从搜索（对标 claude-code claude.ts 的 deferredToolList 注入）。
   * 仅返回名称（不含 description/searchHint），与 claude-code formatDeferredToolLine 一致——
   * 名字足够触发 tool_search，schema 留到激活后再给，避免首轮 token 浪费。
   */
  deferredToolNames(): string[] {
    const names = new Set<string>();
    for (const t of this.all()) {
      if (this.isToolDeferred(t)) names.add(t.name());
    }
    return [...names].sort();
  }
}
