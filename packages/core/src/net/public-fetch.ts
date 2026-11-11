/**
 * 内置公共数据源的 HTTP 拉取 —— 域名首试，IPv4 兜底。
 *
 * ── 为什么需要这一层（2026-11-11 在真实网络上定位到）────────────────────
 *
 * Bun 1.4 的内置 `fetch` 没有实现 Happy Eyeballs（RFC 8305）：域名同时有 AAAA 和 A
 * 记录时，它会去连 IPv6，且**失败后不回落 IPv4**，一直挂到调用方自己的超时把请求
 * abort 掉。国内不少家宽 / 办公网正是这种形态 —— 有全局 IPv6 地址、有默认路由，
 * 但上游实际不通（TCP 三次握手能成，TLS 与后续数据包进黑洞）。
 *
 * 实测对比（同一台机器、同一个 URL）：
 * - curl（实现了 Happy Eyeballs）：1.2s 拉完 6MB；
 * - Bun `fetch` 走域名：60s 仍 `AbortError: The operation was aborted.`；
 * - Bun `fetch` 强制直连 IPv4（SNI 仍是域名）：0.9s 成功；
 * - `dns.setDefaultResultOrder("ipv4first")` 与命令行
 *   `--dns-result-order=ipv4first` **对内置 fetch 都无效**（实测），所以只能在调用侧
 *   自己解析地址、自己决定连哪个。
 *
 * ── 适用范围（很重要）────────────────────────────────────────────────
 *
 * 只给**仓库内置的公共数据源**用：模型目录镜像、分发的二进制这类全球可达的双栈端点，
 * 走 IPv4 不会错。
 *
 * **不要**拿它替换用户配置的端点（LLM baseURL / MCP / webhook / OTLP）—— 企业内网
 * 端点可能只有 IPv6 可达，强制 IPv4 会反向把它弄坏；那些端点的可达性是用户的网络
 * 责任，不是仓库的。
 *
 * ── 顺序：为什么是「先域名、后 IPv4」而不是反过来 ────────────────────────
 *
 * 正常网络里域名路径本来就通，先试它可以做到**零额外开销**（不查 DNS、不多一次请求），
 * 也保住了单测里 `globalThis.fetch` 被 mock 时不会触发真实 DNS 查询。只有当域名路径在
 * 首试预算内没拿到响应头时，才判定「这条链路大概率是 IPv6 黑洞」，转而逐个直连 IPv4。
 *
 * 首试预算（4s）只覆盖「建立连接 + 拿到响应头」，拿到头之后会延长到总预算再读 body，
 * 所以「慢但可用」的大文件不会被误判。
 */
import { lookup } from "node:dns/promises";

/** 域名首试预算：只用于连接 + 响应头，拿到头就延长到总预算。 */
const HOST_ATTEMPT_MS = 4_000;
/** 单个 IPv4 直连的预算（同样只覆盖连接 + 响应头）。 */
const PER_ADDRESS_MS = 4_000;
/** DNS 解析预算：解析本身不该成为瓶颈，超时就交给调用方按失败处理。 */
const DNS_TIMEOUT_MS = 3_000;
/** 默认总预算，与既有调用方（目录同步 / 构建脚本）的 15s 对齐。 */
const DEFAULT_TIMEOUT_MS = 15_000;
/** 默认 body 上限，与模型目录同步的上限（32MiB）一致。 */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
/** 需要交回域名路径去跟随的重定向；304 不在其中（它是条件请求的「没变」）。 */
const FOLLOWABLE_REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Bun 给 fetch 扩展的选项：把 TLS 的 SNI 固定回原域名。
 * `@types/bun` 1.4.4 没有声明它，这里补一份最小形状（运行时确有该字段，实测生效）。
 */
interface BunFetchInit extends RequestInit {
  tls?: { servername?: string };
}

export interface PublicFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  /** 整次调用的总预算（含 DNS 与全部尝试）。默认 15s。 */
  timeoutMs?: number;
  /** body 上限，超过即中断并抛 `PublicFetchBodyTooLargeError`。默认 32MiB。 */
  maxBytes?: number;
  /** 外部取消信号；与总预算取先到者。 */
  signal?: AbortSignal;
  /** 域名路径失败、即将走 IPv4 直连时回调一次（供调用方记日志）。 */
  onFallback?: (info: { url: string; reason: string }) => void;
}

export interface PublicFetchResult {
  status: number;
  ok: boolean;
  headers: Headers;
  /** 已完整读出的 body（HEAD / 204 / 304 时为空数组）。 */
  bytes: Uint8Array;
}

/**
 * 自己超时用独立类型：调用方才能把「我们主动放弃」和「连接被拒 / 证书错误」分开记日志。
 * 裸 `AbortError: The operation was aborted.` 看不出是谁 abort 的，排障时只能猜。
 */
export class PublicFetchTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`拉取超时 ${timeoutMs}ms: ${url}`);
    this.name = "PublicFetchTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export class PublicFetchBodyTooLargeError extends Error {
  constructor(
    readonly url: string,
    readonly maxBytes: number,
  ) {
    super(`响应体超过上限 ${maxBytes} 字节: ${url}`);
    this.name = "PublicFetchBodyTooLargeError";
  }
}

function remaining(deadline: number): number {
  return deadline - Date.now();
}

/** `URL.hostname` 对 IPv6 字面量会带方括号（`[::1]`）。 */
function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
}

/**
 * 带预算的 A 记录解析。
 * 用 Promise.race 而不是给 lookup 传 signal：Node/Bun 的 `dns.lookup` 不接受 signal。
 */
async function resolveIpv4(hostname: string, budgetMs: number): Promise<string[]> {
  if (budgetMs <= 0) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const entries = await Promise.race([
      lookup(hostname, { family: 4, all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS 解析超时")), budgetMs);
      }),
    ]);
    return entries.map((entry) => entry.address);
  } catch {
    // 解析失败 / 超时 → 空列表，按「没有可用 IPv4」处理。
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 测试注入点：真实实现走系统 resolver，单测里替换掉就不必联网。 */
let resolveIpv4Impl = resolveIpv4;

/** 仅供测试替换 DNS 解析；生产代码不要调用。 */
export function __setIpv4ResolverForTest(fn: typeof resolveIpv4 | null): void {
  resolveIpv4Impl = fn ?? resolveIpv4;
}

interface Attempt {
  signal: AbortSignal;
  /** 本次尝试是否因为预算耗尽被中止（区别于外部 signal 主动取消）。 */
  timedOut: () => boolean;
  /** 预算只覆盖到「拿到响应头」时，拿到头后延长到总预算再读 body。 */
  extend: (budgetMs: number) => void;
  dispose: () => void;
}

/** 把「外部取消」与「本次尝试的预算」合成一个 signal，并保证计时器一定被清理。 */
function withDeadline(parent: AbortSignal | undefined, budgetMs: number): Attempt {
  const ctl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, ms);
  };
  arm(budgetMs);
  const abortFromParent = () => ctl.abort();
  if (parent) {
    if (parent.aborted) ctl.abort();
    else parent.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    extend: (ms) => arm(Math.max(1, ms)),
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

/** 与既有 `readBodyCapped` 同一套语义：content-length 预筛 + 流式计数 + 超限即取消。 */
async function readBodyCapped(resp: Response, url: string, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (resp.body) await resp.body.cancel().catch(() => {});
    throw new PublicFetchBodyTooLargeError(url, maxBytes);
  }
  const reader = resp.body?.getReader();
  if (!reader) return new Uint8Array(await resp.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PublicFetchBodyTooLargeError(url, maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** 一次「发请求 + 读 body」的完整尝试；任何异常都返回 null，由调用方决定下一步。 */
async function attempt(
  url: string,
  init: BunFetchInit,
  budgetMs: number,
  deadline: number,
  maxBytes: number,
  opts: PublicFetchOptions,
): Promise<PublicFetchResult | null> {
  const a = withDeadline(opts.signal, budgetMs);
  try {
    const resp = await fetch(url, { ...init, signal: a.signal });
    // 响应头已到：把预算从「只覆盖连接」延长到总预算，慢网下读大 body 不会被误判。
    a.extend(remaining(deadline));
    const bytes = await readBodyCapped(resp, url, maxBytes);
    return { status: resp.status, ok: resp.ok, headers: resp.headers, bytes };
  } catch (e) {
    // 外部主动取消是调用方的决定，原样抛出去。
    if (opts.signal?.aborted) throw e;
    // body 超限是**确定性**结果：同一个 URL 换一条网络路径也一样超，重试只会白烧流量。
    // 这条必须放在「返回 null 让上层换地址」之前，否则一次超限会被放大成 N 次请求。
    if (e instanceof PublicFetchBodyTooLargeError) throw e;
    return null;
  } finally {
    a.dispose();
  }
}

/**
 * 拉一个内置公共数据源。
 *
 * 与 `fetch` 的差异只有两条：域名路径拿不到响应头时会回退到 IPv4 直连；返回值是
 * 「状态码 + 头 + 完整 body」，body 读取同样受总预算约束（`fetch` 返回 Response 后
 * 调用方自己读 body 的话，超时信号管不到那一段）。
 */
export async function fetchPublicUrl(
  url: string,
  opts: PublicFetchOptions = {},
): Promise<PublicFetchResult> {
  const parsed = new URL(url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const deadline = Date.now() + timeoutMs;
  const hostname = parsed.hostname;
  const init: BunFetchInit = {
    method: opts.method ?? "GET",
    headers: opts.headers,
  };

  // 第一跳：域名路径。正常网络走这里，行为与直接 fetch 一致。
  const viaHost = await attempt(
    parsed.toString(),
    init,
    Math.min(HOST_ATTEMPT_MS, remaining(deadline)),
    deadline,
    maxBytes,
    opts,
  );
  if (viaHost) return viaHost;

  // 调用方给的本来就是 IP，没有「换地址族」这回事。
  if (isIpLiteral(hostname)) throw new PublicFetchTimeoutError(url, timeoutMs);

  // 第二跳：IPv4 直连。SNI 与 Host 仍写域名，证书校验语义不变。
  const addresses = await resolveIpv4Impl(hostname, Math.min(DNS_TIMEOUT_MS, remaining(deadline)));
  opts.onFallback?.({
    url,
    reason: `域名路径 ${HOST_ATTEMPT_MS}ms 内未拿到响应头，改试 IPv4（${addresses.length} 个地址）`,
  });
  for (const address of addresses) {
    const budget = Math.min(PER_ADDRESS_MS, remaining(deadline));
    if (budget <= 0) break;
    const viaIp = new URL(parsed.toString());
    viaIp.hostname = address;
    const result = await attempt(
      viaIp.toString(),
      {
        ...init,
        // Host 必须显式写回域名：Cloudflare 一类 CDN 按 Host/SNI 分流，用 IP 当 Host 会被 403。
        headers: { ...(opts.headers ?? {}), host: hostname },
        // 不自动跟随：Location 很可能指回域名，跟过去又会踩进同一条 IPv6 黑洞。
        redirect: "manual",
        tls: { servername: hostname },
      },
      budget,
      deadline,
      maxBytes,
      opts,
    );
    if (!result) continue;
    if (FOLLOWABLE_REDIRECTS.has(result.status)) {
      // 不自己跟随：Location 很可能指回域名，跟过去又会踩进同一条 IPv6 黑洞。
      // 用剩余预算再走一次域名路径（此时是 Bun 自己的跟随逻辑）。
      const followed = await attempt(
        parsed.toString(),
        init,
        Math.max(1, remaining(deadline)),
        deadline,
        maxBytes,
        opts,
      );
      if (followed) return followed;
      break;
    }
    return result;
  }

  if (remaining(deadline) <= 0) throw new PublicFetchTimeoutError(url, timeoutMs);
  throw new Error(`拉取失败: ${url}（域名与 IPv4 直连都没拿到响应）`);
}
