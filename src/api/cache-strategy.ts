/**
 * Prompt Cache breakpoint 放置策略
 *
 * 职责（对标 Claude Code 的 addCacheBreakpoints）：
 * - 在 system / tools / 消息序列上精确放置 cache_control 标记
 * - skipCacheWrite 模式：fire-and-forget 请求只读缓存不写新缓存（避免子代理污染缓存）
 * - G4 Global Scope：静态区可标记 scope=global，让所有用户共享同一份 KV Cache（SaaS 规模命中率远超 org 级）
 * - G12 四块精细分区：attribution（不缓存）/ corePrefix（global）/ staticExtensions（org）/ dynamic（会话内）
 *
 * 设计为纯函数，操作"已转换为 API 格式的载荷"（带 content 数组的对象），
 * 不耦合 SDK 类型 —— Provider 在转换完消息后调用本模块统一打标。
 *
 * ⚠️ 断点数量约束（对标 Claude Code claude.ts:3078-3089，G14 审计确认）：
 *
 * - **System blocks**：可以有多个 cache_control（每个 block 独立标记）—— OK。
 *   system 总在请求最前面，服务端按序处理，多个 block 边界是合法的前缀缓存分层。
 * - **Messages 序列**：只放 **1 个** cache_control（最后一条或倒数第二条）。
 *   原因：服务端 KV 驱逐策略下，messages 上多断点会导致中间位置的 KV pages 无法被及时释放，
 *   降低服务端内存效率。
 *
 * 不要在 messages 上标记多个断点！本模块的 addMessageCacheBreakpoint 已保证只标记 1 条；
 * 若未来新增标记路径，必须维持"messages 仅 1 个 cache_control"这一不变量
 * （clearCacheBreakpoints 先清场即为此服务）。
 */

/** 缓存作用域（G4）。global 让所有用户共享 KV Cache，org 为组织级（默认）。 */
export type CacheScope = "global" | "org";

/** cache_control 标记（G4：可选 scope） */
export interface CacheControl {
  type: "ephemeral";
  scope?: CacheScope;
}

/** 可被打标的 content block（鸭子类型） */
export interface CacheableBlock {
  type: string;
  cache_control?: CacheControl;
  [key: string]: unknown;
}

/** 可被打标的消息（鸭子类型） */
export interface CacheableMessage {
  role: string;
  content: CacheableBlock[] | string;
}

/** system prompt block */
export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface CacheStrategyOptions {
  /** 是否跳过缓存写入（子代理 fire-and-forget 请求） */
  skipCacheWrite?: boolean;
}

/** buildSystemBlocks 选项（G4） */
export interface BuildSystemBlocksOptions {
  /**
   * 是否对静态区启用 global scope（G4）。
   * 仅当静态区内容确实跨用户一致（无组织/用户特定内容注入）时才应开启。
   * 动态区始终 org 级（含用户特定内容）。
   */
  globalScopeEnabled?: boolean;
}

const EPHEMERAL: CacheControl = { type: "ephemeral" };
const EPHEMERAL_GLOBAL: CacheControl = { type: "ephemeral", scope: "global" };

/** system prompt 静态/动态分区边界（与 anthropic.ts 现状一致） */
export const DYNAMIC_BOUNDARY = "\n\n<!-- DYNAMIC_BOUNDARY -->\n\n";

/**
 * 按 DYNAMIC_BOUNDARY 拆分 system 字符串为静态/动态两段。
 *
 * 供不支持"消息级 cache_control 分段"的协议（如 OpenAI/DeepSeek）使用——
 * 这类协议只能做整体前缀匹配，动态区必须搬离 system message 单独处理，
 * 否则动态内容的任何变化都会打断其后全部历史消息的缓存复用。
 */
export function splitSystemByDynamicBoundary(
  system: string,
): { staticContent: string; dynamicContent?: string } {
  const idx = system.indexOf(DYNAMIC_BOUNDARY);
  if (idx === -1) return { staticContent: system };
  return {
    staticContent: system.slice(0, idx),
    dynamicContent: system.slice(idx + DYNAMIC_BOUNDARY.length),
  };
}

/**
 * 将 system prompt 字符串拆分为带 cache_control 的 SystemBlock 数组。
 * 含 DYNAMIC_BOUNDARY 时拆静态/动态两区，分别打标（跨会话缓存 + 会话内缓存）。
 *
 * G4：globalScopeEnabled 时，静态区标记 scope=global（跨用户共享 KV Cache）；
 * 动态区始终 org 级（不带 scope）。
 */
export function buildSystemBlocks(
  system: string | undefined,
  options?: BuildSystemBlocksOptions,
): SystemBlock[] | undefined {
  if (!system) return undefined;
  const staticControl = options?.globalScopeEnabled ? EPHEMERAL_GLOBAL : EPHEMERAL;
  const { staticContent, dynamicContent } = splitSystemByDynamicBoundary(system);
  if (dynamicContent !== undefined) {
    return [
      { type: "text", text: staticContent, cache_control: staticControl },
      // 动态区始终 org 级（含用户特定内容），不用 global scope
      { type: "text", text: dynamicContent, cache_control: EPHEMERAL },
    ];
  }
  // 无边界：整段视为静态区
  return [{ type: "text", text: staticContent, cache_control: staticControl }];
}

/** 可被打标的工具定义（鸭子类型；只关心 cache_control 字段是否可挂） */
export interface CacheableTool {
  name: string;
  cache_control?: CacheControl;
  [key: string]: unknown;
}

/**
 * 增强 5.1：在工具数组的**最后一个**工具上放一个 cache breakpoint（对齐 CC toolToAPISchema cacheControl）。
 *
 * 为什么放最后一个：tools 数组整体在 system 之前、messages 之后被服务端处理，
 * 在末尾工具打一个断点 = 把"整个工具区"纳入前缀缓存的一个独立分层，
 * 工具定义每请求稳定 → 高命中。放最后一个而非每个，保证只 +1 个断点（守住 ≤4 上限）。
 *
 * scope：仅直连 Anthropic 且工具区确实跨用户一致时才用 global（与 system 静态区同策略）；
 * 走网关时降级为普通 ephemeral（org 级）或由调用方直接不打（见 anthropic.ts 门控）。
 *
 * @returns 是否成功打标（空数组返回 false）
 */
export function markLastToolCacheBreakpoint(
  tools: CacheableTool[] | undefined,
  options?: { globalScope?: boolean },
): boolean {
  if (!tools || tools.length === 0) return false;
  const last = tools[tools.length - 1];
  last.cache_control = options?.globalScope ? EPHEMERAL_GLOBAL : EPHEMERAL;
  return true;
}

/** 在指定消息的最后一个 content block 上打标 */
export function markLastContentBlock(message: CacheableMessage | undefined): boolean {
  if (!message) return false;
  const content = message.content;
  if (Array.isArray(content) && content.length > 0) {
    content[content.length - 1].cache_control = EPHEMERAL;
    return true;
  }
  return false;
}

/** 清除所有消息上已有的 cache_control（重新打标前清场，避免标记叠加超过 4 个断点上限） */
export function clearCacheBreakpoints(messages: CacheableMessage[]): void {
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.cache_control) delete block.cache_control;
      }
    }
  }
}

/**
 * 在**最后一条 `role === "user"` 的消息**末块放 cache breakpoint（P1-4 收口）。
 *
 * 与 {@link addMessageCacheBreakpoint} 的区别是**语义而非实现**，别把两者合并：
 * 那个函数打的是最后一条消息（不论 role），本函数倒序找最后一条 user 消息。
 * **assistant / `role: "tool"` 结尾时两者落点不同。**
 *
 * 这是 anthropic 生产路径（流式 + 非流式）此前各自手写倒序循环的行为，
 * 收口时刻意**保留**它而不是换成 `addMessageCacheBreakpoint` —— 后者是行为变更。
 * 上一版博客把这处重复描述为"功能上没错、只是三种写法"，实测是语义分叉。
 *
 * @returns 被打标的消息索引（-1 表示未打标）
 */
export function markLastUserMessageCacheBreakpoint(messages: CacheableMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    // 空 content 的 user 消息跳过继续往前找 —— 与手写循环一致
    // （它要求 content.length > 0 才打标并 break）
    if (markLastContentBlock(msg)) return i;
  }
  return -1;
}

/**
 * 在消息序列中放置 cache breakpoint。
 *
 * 规则（G14：messages 仅 1 个断点）：
 * 1. 正常模式：标记最后一条消息（确保整个前缀被缓存）
 * 2. skipCacheWrite 模式：标记倒数第二条（读缓存但不写入新缓存）
 *
 * ⚠️ 与 {@link markLastUserMessageCacheBreakpoint} 语义不同（见那边的注释）：
 * 本函数不看 role。anthropic 生产路径用的是那个，不是这个。
 *
 * 返回被打标的消息索引（-1 表示未打标）。
 */
export function addMessageCacheBreakpoint(
  messages: CacheableMessage[],
  options?: CacheStrategyOptions,
): number {
  if (messages.length === 0) return -1;

  if (options?.skipCacheWrite) {
    if (messages.length >= 2) {
      const idx = messages.length - 2;
      return markLastContentBlock(messages[idx]) ? idx : -1;
    }
    // 只有一条消息时，skipCacheWrite 不写任何断点
    return -1;
  }

  const idx = messages.length - 1;
  return markLastContentBlock(messages[idx]) ? idx : -1;
}

/**
 * 一站式打标：system blocks + 消息 breakpoint。
 * 先清场再打标，保证幂等。
 */
export function addCacheBreakpoints(params: {
  messages: CacheableMessage[];
  system?: string;
  options?: CacheStrategyOptions;
  /** G4：静态区是否用 global scope */
  buildOptions?: BuildSystemBlocksOptions;
}): { system?: SystemBlock[]; markedMessageIndex: number } {
  clearCacheBreakpoints(params.messages);
  const system = buildSystemBlocks(params.system, params.buildOptions);
  const markedMessageIndex = addMessageCacheBreakpoint(params.messages, params.options);
  return { system, markedMessageIndex };
}

/**
 * Anthropic 每请求最多 4 个 cache_control 断点，超限直接 400（整请求失败）。
 *
 * § 比 CC 更进一步：CC 只打点记录断点数（tengu_api_cache_breakpoints），**不做阈值保护**——
 * 未来某次改动多标一个断点会静默上线,到生产才 400。这里把"comment-only 不变量"升级为
 * 运行时护栏,在真正发请求前拦截。
 *
 * § 策略(dev-loud / prod-safe)：
 *   - 统计 system blocks + messages 上的 cache_control 总数(tools 侧当前不标,预留计入)。
 *   - 超过 4：非生产(NODE_ENV!=production)直接抛错,让单测/本地立刻暴露;
 *     生产环境打 error 日志但不抛(宁可这一轮不命中缓存,也不因护栏把请求打挂)。
 *
 * @returns 实际断点总数(便于调用方按需记录)
 */
export function countCacheBreakpoints(
  system: SystemBlock[] | undefined,
  messages: CacheableMessage[],
  tools?: CacheableTool[],
): number {
  let count = 0;
  for (const b of system ?? []) {
    if (b.cache_control) count++;
  }
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === "object" && block.cache_control) count++;
      }
    }
  }
  // 工具区断点（增强 5.1）：tools 数组里挂了 cache_control 的工具计入总数，守 ≤4 上限。
  for (const t of tools ?? []) {
    if (t && typeof t === "object" && t.cache_control) count++;
  }
  return count;
}

/** Anthropic 每请求 cache_control 断点硬上限 */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * 断言 cache_control 断点总数未超 Anthropic 上限。发请求前调用。
 * 超限时:非生产抛错(暴露 bug);生产打 error 不抛(容错优先)。
 */
export function assertCacheBreakpointBudget(
  system: SystemBlock[] | undefined,
  messages: CacheableMessage[],
  logger?: { error: (tag: string, msg: string) => void },
  tools?: CacheableTool[],
): void {
  const count = countCacheBreakpoints(system, messages, tools);
  if (count <= MAX_CACHE_BREAKPOINTS) return;
  const detail = `cache_control 断点数 ${count} 超过 Anthropic 上限 ${MAX_CACHE_BREAKPOINTS}，请求会 400`;
  if (process.env.NODE_ENV === "production") {
    logger?.error("CACHE", detail);
  } else {
    throw new Error(detail);
  }
}
