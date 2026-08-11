/**
 * keep-alive 连接池开关（ECONNRESET / EPIPE 后禁用）
 * ================================================
 *
 * 背景（B1-b / §五之二 漏斗-2）：`fallback.ts` 检测到 ECONNRESET/EPIPE 后会置位
 * `ctx.disableKeepAlive` 与 `config.disableKeepAlive`，但**全仓没有任何消费者**
 * （实测 `grep -rn "disableKeepAlive" src/ | grep -v fallback.ts` 零命中）。
 * 即：我们以为处理了「陈旧 keep-alive socket 导致的连接重置」，实际只是设了个没人读的标志位。
 *
 * ECONNRESET/EPIPE 的典型成因是连接池里的 socket 已被对端（或中间网关/LB）单方面关闭，
 * 但本地池仍认为它可用，下一个请求复用到这条死连接即刻被 reset。此时**原样重试仍会
 * 命中同一条死 socket**，重试次数被白白烧掉。正解是重试前禁用连接复用，强制新建连接。
 *
 * 对标 claude-code `utils/proxy.ts:27-35 / :295`：
 *   - 模块级 `let keepAliveDisabled = false`（不是实例字段——它描述的是**进程级传输层**
 *     状态，不是某次调用的状态；多 provider / 多并发请求共享同一个连接池，
 *     所以状态位置在模块级才正确）
 *   - `disableKeepAlive()` 单向置位（只关不开：一旦发现池子脏了，本进程后续都不再复用）
 *   - 真消费点：fetch 选项里 `{ keepalive: false }`
 *
 * 运行时说明（与 CC 注释一致）：Bun 的原生 fetch 尊重 `keepalive: false` 并据此绕过连接
 * 复用；Node/undici 下该字段对池化是 no-op。sid-code 编译产物跑在 Bun 上，故此开关在
 * 生产路径有效。即便在 no-op 的运行时，它也不会造成错误行为（最差退化为「原样重试」，
 * 即修复前的现状）。
 */

/** 进程级：是否已禁用 keep-alive 连接复用。单向置位（只关不开）。 */
let keepAliveDisabled = false;

/**
 * 禁用 keep-alive 连接复用（ECONNRESET/EPIPE 后调用）。
 * 幂等、单向：重复调用无副作用，且不提供「重新启用」的生产接口——
 * 连接池一旦被证明会给出死 socket，本进程剩余时间里都按不可信处理。
 */
export function disableKeepAlive(): void {
  keepAliveDisabled = true;
}

/** 查询当前是否已禁用 keep-alive（供日志/断言用）。 */
export function isKeepAliveDisabled(): boolean {
  return keepAliveDisabled;
}

/**
 * 取 fetch 的 keep-alive 相关选项。
 *
 * 未禁用时返回**空对象**——保证规范路径逐字段不变（不下发 `keepalive: true`，
 * 避免改变运行时默认行为）。禁用后返回 `{ keepalive: false }`。
 */
export function getKeepAliveFetchOptions(): { keepalive?: false } {
  return keepAliveDisabled ? { keepalive: false } : {};
}

/**
 * 包装一个 fetch：禁用 keep-alive 时把 `keepalive: false` 注入 init。
 *
 * 给「fetch 调用点不在我们手里」的场景用（如 Anthropic SDK：client 构造时传自定义
 * fetch，请求 init 由 SDK 内部构造）。每次调用时**动态读取**开关，所以构造早于
 * `disableKeepAlive()` 也能生效——这正是接线必须走包装而非构造期快照的原因。
 *
 * @param baseFetch 底层 fetch（默认全局 fetch）。
 */
export function wrapFetchWithKeepAlive(
  baseFetch?: (input: any, init?: RequestInit) => Promise<Response>,
): (input: any, init?: RequestInit) => Promise<Response> {
  const underlying = baseFetch ?? ((input: any, init?: RequestInit) => fetch(input, init));
  return function keepAliveAwareFetch(input: any, init?: RequestInit): Promise<Response> {
    const opts = getKeepAliveFetchOptions();
    if (opts.keepalive === undefined) return underlying(input, init);
    return underlying(input, { ...(init ?? {}), ...opts } as RequestInit);
  };
}

/** 仅供测试：重置开关（生产不提供「重新启用」路径，见 disableKeepAlive 注释）。 */
export function _resetKeepAliveForTesting(): void {
  keepAliveDisabled = false;
}
