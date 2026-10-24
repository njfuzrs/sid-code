/**
 * Prompt cache 冷热判定（§6.7「把破坏性操作对齐到代价已经产生的时刻」）
 *
 * 只回答一个问题：**现在改写已发送的历史，能不能证明不会制造一次本来不会发生的 miss？**
 * 能证明 → 冷，可以清；证明不了 → 一律按热处理，不清。
 *
 * ## 为什么是进程级、而不是 queryLoop 的 state
 *
 * 旧实现把「上次响应时刻」放在 `LoopState.lastResponseAt`。`queryLoop` 每次
 * `submitMessage` 都重建 state，所以**每条用户消息的第一轮都读到 undefined → 判冷**，
 * 用户隔 10 秒回一句也照样改写历史。轨迹回放（2026-10-24）：60 次、41/132 个
 * Anthropic 会话，间隔 p50 114s —— 全是热缓存被当冷。冷热是服务端缓存的属性，
 * 生命周期跟进程（准确说跟服务端 KV）走，不跟一条用户消息走。
 *
 * ## 为什么记「请求发出」而不是「响应返回」
 *
 * 官方文档：TTL 从**读或写该缓存的那次请求开始时**算起，每次命中刷新。生成耗时计入 TTL。
 * 用响应时刻做起点会把一次长生成的时长白白算成「还热」的余量 —— 方向是高估冷，正好是
 * 会制造 miss 的那一边。
 *
 * ## 为什么阈值是 60 分钟而不是 5 分钟
 *
 * 默认 TTL 是 5 分钟，但 1 小时 TTL 也存在，而本仓 Claude 流量基本走第三方网关，
 * 网关替我们设了什么 TTL 本地无从得知。只有取**最长可能的 TTL**，「已过期」才是一个
 * 能证明的事实；取 5 分钟只是一个猜测，猜错的代价是每次多付一整段前缀的写入价。
 * 少清几次只是少省一点本地 token，多清一次是真金白银 —— 两边代价不对称，取保守值。
 * 这条和 Claude Code `timeBasedMCConfig.ts` 选 60 的论证相同：
 * "we never force a miss that wouldn't have happened"。
 *
 * ⚠️ 这是**正确性不变量**，不是调优参数（§6.10）：刻意不读环境变量 / 远程配置。
 * 改小它就是允许系统在缓存还活着的时候改写历史。
 *
 * ## 为什么所有 Anthropic 请求都算一次「触碰」
 *
 * 主循环、fork 子代理、压缩摘要都会复用主对话前缀并刷新它的 TTL。按调用方逐一接线
 * 一定会漏（漏一条就是一次误判冷）。多记一次触碰的后果只是「更保守、少清一次」，
 * 永远不会制造 miss；所以在 provider 出口统一记，宁多勿漏。
 */

/** 服务端可能采用的最长 prompt cache TTL（1h）。超过它，任何前缀都必然已过期。 */
export const MAX_PROMPT_CACHE_TTL_MS = 60 * 60 * 1000;

/** 最近一次可能读写 prompt cache 的请求的**发出**时刻（epoch ms）；进程内尚无请求时为 undefined。 */
let lastPrefixTouchAt: number | undefined;

/** provider 发出请求时调用（含重试：重试同样会刷新 TTL）。 */
export function recordPrefixTouch(at: number = Date.now()): void {
  if (lastPrefixTouchAt === undefined || at > lastPrefixTouchAt) lastPrefixTouchAt = at;
}

/** 距上次触碰的毫秒数；进程内从未发过请求时返回 undefined（= 不知道，调用方必须按热处理）。 */
export function msSincePrefixTouch(now: number = Date.now()): number | undefined {
  return lastPrefixTouchAt === undefined ? undefined : now - lastPrefixTouchAt;
}

/**
 * 能否证明缓存已冷。
 *
 * 「不知道」（进程内首个请求之前，例如刚 resume）一律返回 false：resume 前一个进程
 * 可能几秒前刚写过这段前缀，进程重启不会清服务端缓存。
 */
export function isPrefixCacheProvablyCold(now: number = Date.now()): boolean {
  const gap = msSincePrefixTouch(now);
  return gap !== undefined && gap >= MAX_PROMPT_CACHE_TTL_MS;
}

/** 仅测试用：模块级状态在同进程多个用例之间会串。 */
export function resetPrefixTouchForTests(): void {
  lastPrefixTouchAt = undefined;
}
