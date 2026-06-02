/**
 * Prompt Cache breakpoint 放置策略
 *
 * 职责（对标 Claude Code 的 addCacheBreakpoints）：
 * - 在 system / tools / 消息序列上精确放置 cache_control 标记
 * - skipCacheWrite 模式：fire-and-forget 请求只读缓存不写新缓存（避免子代理污染缓存）
 *
 * 设计为纯函数，操作"已转换为 API 格式的载荷"（带 content 数组的对象），
 * 不耦合 SDK 类型 —— Provider 在转换完消息后调用本模块统一打标。
 *
 * 与现状的关系：anthropic.ts 当前在 sendMessageStream 内联打标（行 77-109）。
 * 本模块把策略抽出来集中可测；anthropic.ts 可选择委托（见 markSystemBlocks 的 DYNAMIC_BOUNDARY 支持）。
 */

/** cache_control 标记 */
export interface CacheControl {
  type: "ephemeral";
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

const EPHEMERAL: CacheControl = { type: "ephemeral" };

/** system prompt 静态/动态分区边界（与 anthropic.ts 现状一致） */
export const DYNAMIC_BOUNDARY = "\n\n<!-- DYNAMIC_BOUNDARY -->\n\n";

/**
 * 将 system prompt 字符串拆分为带 cache_control 的 SystemBlock 数组。
 * 含 DYNAMIC_BOUNDARY 时拆静态/动态两区，分别打标（跨会话缓存 + 会话内缓存）。
 */
export function buildSystemBlocks(system: string | undefined): SystemBlock[] | undefined {
  if (!system) return undefined;
  const idx = system.indexOf(DYNAMIC_BOUNDARY);
  if (idx !== -1) {
    return [
      { type: "text", text: system.slice(0, idx), cache_control: EPHEMERAL },
      { type: "text", text: system.slice(idx + DYNAMIC_BOUNDARY.length), cache_control: EPHEMERAL },
    ];
  }
  return [{ type: "text", text: system, cache_control: EPHEMERAL }];
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
 * 在消息序列中放置 cache breakpoint。
 *
 * 规则：
 * 1. 正常模式：标记最后一条消息（确保整个前缀被缓存）
 * 2. skipCacheWrite 模式：标记倒数第二条（读缓存但不写入新缓存）
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
}): { system?: SystemBlock[]; markedMessageIndex: number } {
  clearCacheBreakpoints(params.messages);
  const system = buildSystemBlocks(params.system);
  const markedMessageIndex = addMessageCacheBreakpoint(params.messages, params.options);
  return { system, markedMessageIndex };
}
