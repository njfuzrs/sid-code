/**
 * 网关请求标识提取与暂存（P2-6 / §4.1）
 *
 * ## 为什么要有它
 *
 * `raw.jsonl` 里每条记录的 `response` 只有 `content` / `stop_reason` / `usage`，
 * **没有任何 HTTP 响应头**。于是一旦怀疑"是网关自己在排队 / 限流 / 丢包"，
 * 手上没有任何标识可以拿去找网关方核对**具体是哪一次请求** —— 只能拿时间戳
 * 去让对方全量捞日志，实际操作中等于查不了。
 *
 * ## 前置门禁已实测通过（2026-08-19，本仓两族网关各抓一次）
 *
 * 方案文档要求"先抓包确认公司网关是否真的下发这类标识，不下发则直接关闭本项，
 * 不要为一个不存在的响应头写解析代码"。实测结果：**两族都下发，但头名不同**。
 *
 * | 网关 | 协议族 | 头名 | 样例值形态 |
 * | --- | --- | --- | --- |
 * | uniapi（公司网关） | openai + anthropic | `x-oneapi-request-id` | `2026081917252128945886382…` |
 * | ppchat | anthropic | `x-shellapi-request-id` | `2026082001254269571978117…` |
 *
 * 两个头名都是 One-API 系分叉的自有命名（`x-oneapi-*` / `x-shellapi-*`），
 * **不是**厂商标准头。所以候选清单必须同时覆盖：
 *   - 这两个实测存在的网关头；
 *   - 厂商官方头（`request-id` / `x-request-id` / `openai-request-id` /
 *     `anthropic-request-id`）—— 直连 `api.deepseek.com` 这类端点时用得上；
 *   - 常见反代/CDN 标识（`cf-ray` / `x-amzn-requestid` / `x-correlation-id`）——
 *     它们不是模型服务的 id，但在"请求根本没到模型"的场景里恰恰是唯一线索。
 *
 * ⚠️ **不做前缀通配**（如"任何 `*-request-id` 都算"）：那会把
 * `x-ratelimit-*` 之外的各种业务头误收进来，而这个字段是要拿去找网关方对账的 ——
 * 收错了比没收更坏（对方按一个不存在的 id 查，得出"没有这次请求"的错误结论）。
 * 清单里加一项的成本是一行，收错一次的成本是一轮排查。
 *
 * ## 为什么是"暂存 + 取走"而不是参数透传
 *
 * 采集侧唯一的入口是 `AfterModel` hook 的 `llm_response`，而它由
 * `query/loop.ts` 在**流消费完成后**组装 —— 那里拿不到 provider 内部的
 * `Response` 对象（provider 只 yield StreamEvent，响应头在它自己的作用域里）。
 * 要么给 `sendMessageStream` 的每个事件加字段、要么让 provider 侧写一个进程级
 * 暂存位。选后者，理由与 `api/rate-limit.ts` 的 `updateRateLimitStatus` 完全同构
 * （那也是 provider 侧写、消费侧读的进程级单例），本模块只是把同一范式用在
 * 一个**每轮都会变**的值上，因此额外要求"取走即清"（见 takeLastRequestId）。
 */

type HeaderSource = Headers | Record<string, string>;

/**
 * 候选头名，**按可信度排序**：越靠前越接近"模型服务自己的请求标识"。
 *
 * 顺序即优先级（`extractRequestId` 取第一个有值的）。把网关自有头放在最前面
 * 是刻意的：本仓生产流量 100% 经网关，而排查"是不是网关在排队"时要找的正是
 * **网关侧**的 id；CDN 头放最后，它只在"请求没到模型"时有用。
 */
const REQUEST_ID_HEADERS = [
  // ── 实测存在的网关头（One-API 系分叉）──
  "x-oneapi-request-id",
  "x-shellapi-request-id",
  // ── 厂商官方头（直连端点用）──
  "openai-request-id",
  "anthropic-request-id",
  "x-request-id",
  "request-id",
  // ── 反代 / CDN 标识（请求未到模型时的唯一线索）──
  "x-amzn-requestid",
  "x-correlation-id",
  "cf-ray",
] as const;

function makeGetter(headers: HeaderSource): (key: string) => string | null {
  if (typeof (headers as Headers).get === "function") {
    return (key: string) => (headers as Headers).get(key);
  }
  const record = headers as Record<string, string>;
  const lowerMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) lowerMap[k.toLowerCase()] = v;
  return (key: string) => lowerMap[key.toLowerCase()] ?? null;
}

/** 单个 id 的长度上限：截断而非丢弃 —— 超长值多半是网关拼了额外信息，前缀仍可对账。 */
const MAX_ID_LEN = 200;

export interface GatewayRequestId {
  /** 命中的响应头名（**必须一起留**：没有它就分不清这个 id 该找哪一方对账） */
  header: string;
  /** 头的值 */
  value: string;
}

/**
 * 从响应头里提取网关请求标识。返回 `undefined` 表示这一族头一个都没下发
 * （合法情况 —— 部分自建端点确实不发，那时字段就该缺席而不是填空串）。
 */
export function extractRequestId(headers: HeaderSource): GatewayRequestId | undefined {
  const get = makeGetter(headers);
  for (const header of REQUEST_ID_HEADERS) {
    const raw = get(header);
    if (!raw) continue;
    const value = raw.trim().slice(0, MAX_ID_LEN);
    if (!value) continue;
    return { header, value };
  }
  return undefined;
}

// ─── 进程级暂存（provider 侧写、采集侧取走） ───

let _pending: GatewayRequestId | undefined;

/**
 * 记录本次请求的网关标识（provider 侧在拿到响应头时调用）。
 *
 * 覆盖语义而非累积：同一轮里若发生重试 / 重开流，**后一次的 id 才是**最终产出
 * 那条响应的 id，前一次的请求已经作废。想追溯每一次 attempt 的 id 要看
 * `events.jsonl` 的 `HttpConnected`（那里逐次落，见 `emitHttpConnected`），
 * 本暂存位只服务 `raw.jsonl` 的"这条 pair 对应哪次网关请求"。
 */
export function recordRequestId(headers: HeaderSource): void {
  const id = extractRequestId(headers);
  if (id) _pending = id;
}

/**
 * 取走暂存的标识（**读一次即清**）。
 *
 * 为什么必须清：这是个进程级单例，而它的值每轮都变。不清的话，一旦某轮的
 * 响应头里没有 id（换了端点 / 请求根本没发出），采集侧会读到**上一轮**的 id
 * 并写进 `raw.jsonl` —— 那是把陈旧值当本轮事实，与本仓反复记的
 * "陈旧快照被当成实时状态"（§4.2 那个 `chunksReceived: 0`）是同一类缺陷，
 * 且这次的后果更直接：拿着错的 id 去找网关方对账。
 */
export function takeLastRequestId(): GatewayRequestId | undefined {
  const id = _pending;
  _pending = undefined;
  return id;
}

/** 清空暂存（仅测试用，避免用例间串味） */
export function __resetRequestIdForTest(): void {
  _pending = undefined;
}
