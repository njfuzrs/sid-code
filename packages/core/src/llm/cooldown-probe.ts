/**
 * 共享冷却的**探针配额判定**（三个纯函数）。
 *
 * ── 它补的是 S2 的哪个洞 ──
 *
 * S2（`availability.ts` 的共享限流冷却）让"一路撞 429、其余延迟起跑"，但它有一个
 * 结构性盲区：**冷却只有两条出口——自然到期，或该模型成功产出一次内容
 * （`clearCooldown`）。** 而当所有并发路径都在守冷却时，没人去发那一发请求，
 * 于是"成功产出"这个出口永远走不到。结果是：网关回一个偏保守的 `Retry-After`
 * （或限流窗口其实早已过去），全部路径仍然把这段睡满——S2 从"更省"退化成纯"更慢"。
 *
 * 探针就是这个洞的出口：**放一路先走，其余照旧等。** 探针成功 → `clearCooldown`
 * 一次性解放所有路径；探针失败 → 它烧掉的仅是一发请求，其余路径完全没被牵连。
 *
 * ── 为什么需要三个判定，而不是"直接放一路走" ──
 *
 * 直接放行会踩两个坑，两个都由这三个函数分别挡住：
 *
 * 1. **不是所有冷却成因都值得用一发真实请求去试。** 认证失败、模型不存在这类
 *    "敲错门"的故障，等多久答案都不会变，探针纯属白烧 → 判定 ①。
 * 2. **不是所有成因都该共用同一份配额。** 429 是**全局配额**问题（一路探出的
 *    结论对所有路径都有效，所以整个冷却窗口只该有一发探针）；而超时 / 网络抖动是
 *    **单路径**问题（我的 socket 断了，不代表你的也断），拿全局配额去卡它就是
 *    让健康的路径替坏路径背锅 → 判定 ②。
 * 3. **探针失败不等于"配额还没恢复"。** 探针撞上 401 / 模型不存在，说明的是
 *    "这次没敲对门"，它对"限流窗口过了没有"**一个字都没回答**。这种失败就该把
 *    配额还回去，否则一次无关的故障会白白吃掉整个窗口里唯一的探针机会 → 判定 ③。
 *
 * ── 来源与偏离 ──
 *
 * 形态移自 `openclaw/src/agents/failover-policy.ts`（49 行三个纯函数）。
 * **两处刻意偏离，都是我们的处境与它不同逼出来的**：
 *
 * - **词表换成我们自己的**。openclaw 的 `FailoverReason` 有 16 个成员
 *   （`auth_permanent` / `session_expired` / `tls_certificate` …），我们的分类器产出的是
 *   `errors.ts` 的三个 union。**照抄它的字符串会得到一堆我们永远不会产出的分支**——
 *   那不是移植，是把别人的词表当成我们的现实。故这里按语义重新归类，逐条给理由。
 * - **配额的作用域从"一次 fallback run"改成"一个冷却窗口 × 跨路径共享"**。
 *   openclaw 那个 `cooldownProbeUsedProviders` 是 runner 里的局部 `Set`，天然只服务
 *   单条顺序执行的降级链。我们要挡的是**6 路并发子代理同时探针**（S2 的立命之本就是
 *   跨路径协调），所以配额必须落在共享的 `availability` 上。
 *
 * 本模块**只做判定、不持状态**：状态在 `availability.ts`，编排在 `fallback.ts`。
 * 纯函数好处很直接——三条判定各自能被穷举单测，不必去构造一次真实的限流。
 */

import type { RetryableReason, StreamValidationReason, TerminalReason } from "./errors.ts";

/**
 * 能写进冷却记录的成因。
 *
 * 类型收窄成 `RetryableReason` 不是随手写的：`fallback.ts` 里唯一的冷却写点被
 * `classified instanceof RetryableError` 包着，所以冷却成因**结构上**不可能是
 * Terminal / StreamValidation。写成宽类型会让判定 ① 里出现一堆生产中永不可达的分支，
 * 那正是这个仓一直在清的"看着有能力、实际零触发"。
 */
export type CooldownCause = RetryableReason;

/**
 * 探针失败时能拿到的错误归因。
 *
 * 这里必须是**全词表**（三个 union 全收）：判定 ③ 的输入来自 `classifyError`，
 * 而探针可以死在任何一类错误上——Terminal（401）、Retryable（又一次 429）、
 * StreamValidation（流是空的）都可能。`undefined` 代表"分类器也认不出来"
 * （`classifyError` 的契约是认不出就原样返回入参），这一格必须能表达，
 * 否则调用方会被迫编一个假 reason 塞进来。
 */
export type ProbeFailureReason =
  | RetryableReason
  | TerminalReason
  | StreamValidationReason
  | undefined;

/**
 * 判定 ①：这个冷却成因，值不值得用一发真实请求去探。
 *
 * 放行的共同点是**"上游那个条件可能已经自己好了"**——配额窗口滚过去了、容量回来了、
 * 网络抖动过去了。这类成因下，一发请求能换到一个确定的答案，是划算的。
 *
 * 唯一被否的 `lock_timeout`（409）：它是**本地/会话级的锁竞争**，不是上游的可用性问题。
 * 探它等于用一发真实请求去问"锁放开了吗"——问错了对象，答案也不可复用给别的路径。
 *
 * ⚠️ **诚实记账**：生产中我们只在 `rate_limit` 上写冷却（529 刻意不写，见
 * `fallback.ts` 写点注释与 b6 的负向门禁），所以**本判定当前在生产里恒为 true**。
 * 它不是当下的活闸门，是词表边界：将来任何人新增一个冷却写点时，
 * 这里会把"不该被探的成因"挡在外面，而不是靠那个人记得。
 */
export function shouldAllowCooldownProbeForReason(cause: CooldownCause | undefined): boolean {
  return (
    cause === "rate_limit" ||
    cause === "overloaded" ||
    cause === "server_error" ||
    cause === "timeout" ||
    cause === "request_timeout" ||
    cause === "network_error"
  );
}

/**
 * 判定 ②：这个冷却成因，该不该消耗**跨路径共享**的那一份探针配额。
 *
 * 分界线是"这一发探针探出来的结论，对别的路径算不算数"：
 *
 * - **算数 → 共享配额（返回 true）**：`rate_limit` / `overloaded` / `server_error`
 *   都是**服务端侧**的状态。配额与容量是全局的，一路探出"还在限流"，
 *   其余路径再各探一发只是把限流放大一遍——正是 S2 要消灭的级联。
 *   故整个冷却窗口只给一发。
 * - **不算数 → 不消耗配额（返回 false）**：`timeout` / `request_timeout` /
 *   `network_error` 是**本路径**的状态（我这条连接断了，说明不了你那条）。
 *   拿全局配额去卡它，等于让一路的网络抖动把其余所有路径的探针机会一起吃掉——
 *   健康路径替坏路径背锅。这些成因下各路径各自探，本就不构成放大。
 *
 * 这一格对应 openclaw 把 `billing` 排除在共享配额之外的那个例外（它的 billing 也是
 * "与瞬时配额窗口无关"的一类），只是我们的例外落在另外三个成因上。
 */
export function shouldUseTransientCooldownProbeSlot(cause: CooldownCause | undefined): boolean {
  return cause === "rate_limit" || cause === "overloaded" || cause === "server_error";
}

/**
 * 判定 ③：探针失败了，这份配额该不该**还回去**。
 *
 * 判据只有一句：**这次失败，回答了"限流窗口过了没有"这个问题吗？**
 *
 * - **没回答 → 还回去（返回 true）**：401 认证失败、模型不存在、参数非法、
 *   内容策略拒绝、服务端明确要求别重试、工具调用格式错——这些都是"敲错门"，
 *   与配额窗口毫不相干。让它吃掉窗口里唯一的探针机会，等于一次无关故障
 *   把 S2 的出口锁死一整个窗口。
 * - **回答了 → 配额留在消耗态（返回 false）**：又撞一次 `rate_limit`、
 *   `quota_exhausted`（配额真的耗尽了）、流是空的——这些确实是"还没恢复"的证据，
 *   继续探只会重复烧请求。让其余路径老老实实等完冷却才是对的。
 *
 * `undefined`（分类器也认不出）同样返回 false：**不认识的失败不发还配额**。
 * 反过来（认不出就还回去）会让一类未知的确定性故障被反复探针，
 * 把"更快"换成纯粹的白烧——那是这个仓里反复出现的那种"重试必然无效"形态。
 */
export function shouldPreserveTransientCooldownProbeSlot(reason: ProbeFailureReason): boolean {
  return (
    reason === "auth_failed" ||
    reason === "model_not_found" ||
    reason === "invalid_request" ||
    reason === "content_policy" ||
    reason === "server_declined_retry" ||
    reason === "malformed_tool_call"
  );
}
