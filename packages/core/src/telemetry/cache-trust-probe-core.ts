/**
 * cache-trust-probe-core.ts —— 渠道可信度判定逻辑（T2 / P0-4）
 *
 * 与 `scripts/cache-trust-probe.ts` 分开的理由：**判定必须能在没有网络的情况下测。**
 * 判据本身是纯函数（一组 usage 样本 → 判定），把它和"发请求"揉在一个脚本里，
 * 就只能靠真花钱打真渠道来验证判据对不对 —— 而判据写错的代价是给可信渠道扣上
 * "造数据"的帽子，或者反过来放过一个真在造数的渠道。
 *
 * 所以这里：`judgeSamples` 纯函数（单测覆盖），`runProbe` 只负责驱动请求并调它。
 */

import type { ChannelTrustVerdict } from "./channel-trust.ts";

/** 一次请求观测到的三段 usage */
export interface UsageSample {
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** 三段之和 —— 判据 C 的核心观测量 */
  sum: number;
  costUSD: number;
}

/** 带标签的样本（标签用于人类可读输出，也标明它属于哪个判据） */
export interface LabeledSample {
  label: string;
  /** 该样本服务于哪个判据：A/B 各一次，C/D 共用 repeat 组 */
  criterion: "A" | "B" | "repeat";
  usage: UsageSample;
}

export interface ProbeResult {
  verdict: ChannelTrustVerdict;
  samples: LabeledSample[];
  spentUSD: number;
  /** 非空表示提前中止（预算耗尽 / 请求失败），此时判定为 unknown */
  aborted?: string;
}

/**
 * 判据 C 的判定阈值：同一前缀连发多次，三段的**总和**变异系数低于此值
 * 而 cacheRead 的变异系数高于 {@link JUMPY_CV}，即"总数固定、内部随机三等分"。
 *
 * 取 0.01（1%）而非 0：真实网关的 sum 也可能因为 tokenizer 边界差 1~2 token，
 * 要求严格相等会把正常渠道判成异常。
 */
const STABLE_SUM_CV = 0.01;

/**
 * 判据 C/D 的"抖动"阈值：cacheRead 的变异系数超过此值算无规律跳动。
 *
 * 真实前缀缓存的命中值在同前缀连发时应当**稳定或单调递增**（后续请求命中更多），
 * 不应上下乱跳。取 0.05（5%）留出正常波动余量。
 */
const JUMPY_CV = 0.05;

/** 变异系数（标准差 / 均值）。均值为 0 时返回 0（无从谈变异）。 */
function cv(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean === 0) return 0;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / mean;
}

/** 是否单调不减（允许相等 —— 稳定命中是正常的） */
function isMonotonicNonDecreasing(xs: number[]): boolean {
  for (let i = 1; i < xs.length; i++) {
    if (xs[i]! < xs[i - 1]!) return false;
  }
  return true;
}

/**
 * 四重判据判定（纯函数）。
 *
 * @param host 端点 host
 * @param model 探测所用模型
 * @param samples 观测样本；缺哪个判据的样本就跳过该判据（不猜）
 * @param nowSeconds 判定时间，由调用方注入（便于测试固定时间）
 */
export function judgeSamples(
  host: string,
  model: string,
  samples: LabeledSample[],
  nowSeconds: number,
): ChannelTrustVerdict {
  const failed: string[] = [];
  const reasons: string[] = [];

  const a = samples.find((s) => s.criterion === "A");
  const b = samples.find((s) => s.criterion === "B");
  const repeats = samples.filter((s) => s.criterion === "repeat");

  // 判据 A —— 全新随机前缀，服务端必然从未见过。r1 报命中在逻辑上不可能。
  if (a && a.usage.cacheRead > 0) {
    failed.push("A");
    reasons.push(`全新前缀首次请求即报命中 ${a.usage.cacheRead} tokens（服务端从未见过该前缀）`);
  }

  /**
   * 判据 B —— 既没打 cache_control、前缀又是全新的，报命中不可能。
   *
   * ⚠ 关键前提（实跑对照抓出来的）：B 必须用**自己的全新前缀**，不能复用判据 A 的。
   * Anthropic 的 `cache_control` 只决定"写不写缓存"，**读是自动的** —— A 已经把前缀
   * 写进缓存后，B 复用同一前缀即便不打标记也会正常命中。第一版就是这么排的，
   * 结果把行为完全正确的自建网关（对照组：A 冷启动 create=1970、后续稳定 read=1970）
   * 判成了"不可信"。
   *
   * 换成独立前缀后，B 的语义才回到"逻辑上不可能"：服务端没见过它、也没被要求缓存它。
   *
   * 另注：OpenAI 族是**自动**前缀缓存，不打标记也会写也会命中 —— B 对它没有区分力，
   * 由驱动层跳过（见 isExplicitCacheProtocol），不在这里判。
   */
  if (b && b.usage.cacheRead > 0) {
    failed.push("B");
    reasons.push(`全新前缀 + 未打 cache_control 仍报命中 ${b.usage.cacheRead} tokens`);
  }

  if (repeats.length >= 3) {
    const sums = repeats.map((s) => s.usage.sum);
    const reads = repeats.map((s) => s.usage.cacheRead);
    const sumCv = cv(sums);
    const readCv = cv(reads);
    // **非单调是伪造的必要特征**（写判据时踩过的坑，测试抓出来的）：
    // 探针用固定前缀连发，真实缓存下 sum 本来就恒定（每次发一样的 prompt），
    // 而 cacheRead 会从 r1 的 0 跳到 r2 的满命中 —— 于是"sum 恒定 + read 变异大"
    // 这个组合**同时**描述了真实缓存与伪造数据，单靠它会把 100% 的可信渠道判成造数。
    // 真正区分二者的是：真实缓存的命中值稳定或单调递增，伪造的上下乱跳。
    const jumpy = readCv > JUMPY_CV && !isMonotonicNonDecreasing(reads);

    // 判据 C —— 命中值上下乱跳**且**总和恒定：固定总数随机三等分的典型特征。
    if (jumpy && sumCv <= STABLE_SUM_CV) {
      failed.push("C");
      reasons.push(
        `同前缀 ${repeats.length} 次：总和恒定（变异 ${(sumCv * 100).toFixed(2)}%）` +
          `但命中值上下乱跳（变异 ${(readCv * 100).toFixed(1)}%、非单调），疑为固定总数随机三等分`,
      );
    }

    // 判据 D —— 命中值上下乱跳但总和也在变。比 C 弱一档（不能断言"三等分"），
    // 但真实缓存不该出现这种抖动，仍然可疑。与 C 互斥记录，避免同一现象记两条。
    if (!failed.includes("C") && jumpy) {
      failed.push("D");
      reasons.push(
        `同前缀 ${repeats.length} 次命中值无规律抖动（变异 ${(readCv * 100).toFixed(1)}%、非单调）`,
      );
    }
  }

  // 样本不足以支撑任何判据时判 unknown，而不是"没抓到问题就算可信" ——
  // 后者会把一次失败的探测记成一张清白证明。
  const hasEvidence = Boolean(a) || Boolean(b) || repeats.length >= 3;
  if (!hasEvidence) {
    return { host, model, verdict: "unknown", probedAt: nowSeconds, reason: "样本不足，未能执行任何判据" };
  }

  /**
   * 全零样本不得判 trusted（实跑抓到的坑）。
   *
   * 第一次实跑 ppchat 时，因为把线上 snake_case usage 直接喂给了吃 camelCase 的
   * `normalizeCacheUsage`，三段全读成 0 —— 而"零命中"恰好让四条判据**全部通过**，
   * 探针于是给一个正在造数的渠道发了张清白证明。
   *
   * 这类失败模式是探针的根本风险：判据都在找"不该出现的命中"，所以**采集断裂**
   * （永远读到 0）会伪装成"完美可信"。必须显式拒绝：一次连 prompt token 都没观测到的
   * 探测，说明读数管线本身有问题，判 unknown 让人去查，而不是发证书。
   */
  const observedAnyTokens = samples.some((s) => s.usage.sum > 0);
  if (!observedAnyTokens) {
    return {
      host,
      model,
      verdict: "unknown",
      probedAt: nowSeconds,
      reason: `${samples.length} 个样本的 usage 三段全为 0，疑为读数管线断裂（字段名错配/网关未返回 usage），判据无从执行`,
    };
  }

  if (failed.length > 0) {
    return { host, model, verdict: "untrusted", failedCriteria: failed, reason: reasons.join("；"), probedAt: nowSeconds };
  }
  return { host, model, verdict: "trusted", probedAt: nowSeconds };
}

/** runProbe 的依赖注入面（便于测试时替换成假 provider） */
export interface ProbeDeps {
  config: any;
  modelConfig: { name: string; modelId?: string; apiKey?: string };
  provider: string;
  baseURL?: string;
  host: string;
  rounds: number;
  nonce: string;
  prefix: string;
  /**
   * 判据 B 专用的**另一个**全新前缀。
   *
   * 必须与 `prefix` 不同：Anthropic 的 cache_control 只控制"写"，读是自动的 ——
   * 判据 A 已经把 `prefix` 写进缓存，B 复用它就会读到那份缓存，于是行为完全正确的
   * 网关也会被判成造数（实跑自建网关对照组时踩过：A 冷启动 create=1970、
   * B 复用同前缀 read=1970 被误判 untrusted）。
   */
  prefixForB?: string;
  maxTokens: number;
  costCeilingUSD: number;
  log: (msg: string) => void;
  /**
   * 发一次请求并返回观测到的 usage。默认实现走真实 provider；
   * 测试注入假实现即可在无网络下验证驱动逻辑（判据逻辑已由 judgeSamples 单独覆盖）。
   */
  sendOnce?: (opts: { withCacheControl: boolean; prefix: string }) => Promise<UsageSample>;
  nowSeconds?: () => number;
}

/**
 * 驱动四重判据的请求序列，返回判定。
 *
 * 预算护栏在**每次请求前**检查：超了立刻停手并把已有样本交给 judgeSamples
 *（部分样本仍可能足以定罪，比如判据 A 已经命中）。
 */
export async function runProbe(deps: ProbeDeps): Promise<ProbeResult> {
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const send = deps.sendOnce ?? makeRealSender(deps);
  const samples: LabeledSample[] = [];
  let spent = 0;
  let aborted: string | undefined;

  /** 预算检查 + 发一次请求 + 记样本；返回 false 表示应当停止 */
  const step = async (
    label: string,
    criterion: LabeledSample["criterion"],
    withCacheControl: boolean,
    prefix: string = deps.prefix,
  ): Promise<boolean> => {
    if (spent >= deps.costCeilingUSD) {
      aborted = `预算耗尽（已花 $${spent.toFixed(4)} ≥ 上限 $${deps.costCeilingUSD}）`;
      return false;
    }
    try {
      const usage = await send({ withCacheControl, prefix });
      spent += usage.costUSD;
      samples.push({ label, criterion, usage });
      deps.log(`  ${label}: in=${usage.inputTokens} read=${usage.cacheRead} create=${usage.cacheWrite} sum=${usage.sum}`);
      return true;
    } catch (e) {
      // 请求失败不等于渠道造数 —— 记为中止并让判定落回 unknown/已有样本
      aborted = `请求失败：${(e as Error)?.message ?? String(e)}`;
      return false;
    }
  };

  deps.log(`探测 ${deps.host} / ${deps.modelConfig.name}（nonce=${deps.nonce}，轮数=${deps.rounds}）`);

  // 判据 A：全新前缀 + 打断点，r1 不应有命中
  let ok = await step("A·新前缀首发", "A", true);

  // 判据 B：仅 Anthropic 系有意义（OpenAI 族是自动缓存，不打标记也会命中，
  // 那时 cacheRead>0 是**正常**的，跑 B 会制造假阳性）。
  //
  // 必须用**独立的全新前缀**：cache_control 只控制"写"，读是自动的 ——
  // 复用判据 A 的前缀会读到 A 刚写进去的缓存，把正常网关判成造数（实跑踩过）。
  if (ok && isExplicitCacheProtocol(deps.provider)) {
    ok = await step("B·无断点", "B", false, deps.prefixForB ?? deps.prefix);
  } else if (ok) {
    deps.log(`  B·无断点: 跳过（${deps.provider} 为自动前缀缓存，该判据不适用）`);
  }

  // 判据 C/D：同一前缀连发
  for (let i = 0; ok && i < deps.rounds; i++) {
    ok = await step(`repeat#${i + 1}`, "repeat", true);
  }

  const verdict = judgeSamples(deps.host, deps.modelConfig.name, samples, now());
  // 中止且未定罪时不给"可信"背书：没跑完的探测不能当清白证明
  if (aborted && verdict.verdict === "trusted") {
    return { verdict: { ...verdict, verdict: "unknown", reason: `探测未跑完：${aborted}` }, samples, spentUSD: spent, aborted };
  }
  return { verdict, samples, spentUSD: spent, aborted };
}

/**
 * 该协议是否需要**显式** cache_control 才会缓存。
 *
 * Anthropic 需要（不打标记不缓存）→ 判据 B 有效。
 * OpenAI 族是自动前缀缓存（不打标记也命中）→ 判据 B 会制造假阳性，必须跳过。
 */
export function isExplicitCacheProtocol(provider: string): boolean {
  return provider === "anthropic";
}

/**
 * 默认发送器：**直接发裸 HTTP**，不走 provider 类。
 *
 * 为什么不复用 provider：判据 B 要求"完全不打 cache_control"，而生产 provider
 * 恒定会打（anthropic.ts:177 在最后一条 user 消息末块标记）。为探针在生产路径上
 * 加一个 `disableCacheControl` 开关是**错的取舍** —— 那等于为了测量往生产代码里
 * 塞一个只有测量用的分支，将来必然有人误用它关掉真实缓存。
 *
 * 探针本就该在协议层自己构造请求：它测的是"渠道上报的 usage 可不可信"，
 * 与 sid-code 的请求组装逻辑无关，绕过反而让判据更干净（不受本地策略变化影响）。
 */
function makeRealSender(deps: ProbeDeps): (opts: { withCacheControl: boolean; prefix: string }) => Promise<UsageSample> {
  return async ({ withCacheControl, prefix }) => {
    const { normalizeCacheUsage } = await import("../llm/types.ts");
    const wireModel = deps.modelConfig.modelId ?? deps.modelConfig.name;
    const apiKey = deps.modelConfig.apiKey
      ?? (deps.provider === "anthropic" ? deps.config.anthropicKey : deps.config.openaiKey);
    const base = (deps.baseURL ?? "").replace(/\/+$/, "");

    const raw = deps.provider === "anthropic"
      ? await sendAnthropicRaw(base, apiKey, wireModel, prefix, deps.maxTokens, withCacheControl)
      : await sendOpenAIRaw(base, apiKey, wireModel, prefix, deps.maxTokens);

    // 线上 usage 是 snake_case，normalizeCacheUsage 吃的是内部 camelCase `Usage` ——
    // 必须先映射。第一版直接把线上原始对象喂进去，三段全读成 0，探针却报"可信"：
    // 一个字段名错配就足以让探针给出**假的清白证明**，所以下面 judgeSamples 增加了
    // "全零样本不得判 trusted" 的兜底。
    const usage = toInternalUsage(raw, deps.provider);
    const n = normalizeCacheUsage(usage, deps.provider);
    return {
      inputTokens: n.uncachedInputTokens,
      cacheRead: n.cacheHitTokens,
      cacheWrite: n.cacheWriteTokens,
      sum: n.promptTotal,
      // 成本只用于预算护栏，不写进任何账本
      costUSD: estimateCost(n.promptTotal, n.outputTokens),
    };
  };
}

/**
 * 线上 snake_case usage → 内部 camelCase `Usage`。
 *
 * 两族键名不同，且 OpenAI 族的缓存命中键有四种形态（见
 * `src/llm/openai-usage.ts` 的兜底链），所以直接复用那边的提取器而不是再抄一遍。
 */
function toInternalUsage(raw: Record<string, unknown>, provider: string): any {
  if (provider === "anthropic") {
    return {
      inputTokens: (raw.input_tokens as number) ?? 0,
      outputTokens: (raw.output_tokens as number) ?? 0,
      cacheReadInputTokens: (raw.cache_read_input_tokens as number) ?? 0,
      cacheCreationInputTokens: (raw.cache_creation_input_tokens as number) ?? 0,
    };
  }
  return {
    inputTokens: (raw.prompt_tokens as number) ?? (raw.input_tokens as number) ?? 0,
    outputTokens: (raw.completion_tokens as number) ?? (raw.output_tokens as number) ?? 0,
    cacheReadInputTokens: extractCacheHitFromRaw(raw),
  };
}

/** 复用生产提取器的兜底链（同步 import 会成环，故在此做一次动态解析） */
function extractCacheHitFromRaw(raw: Record<string, unknown>): number {
  const details = raw.prompt_tokens_details as { cached_tokens?: number } | undefined;
  const inputDetails = raw.input_tokens_details as { cached_tokens?: number } | undefined;
  return (raw.prompt_cache_hit_tokens as number)
    ?? details?.cached_tokens
    ?? inputDetails?.cached_tokens
    ?? (raw.cached_tokens as number)
    ?? 0;
}

/**
 * Anthropic 裸请求。withCacheControl=false 时**完全不打**断点（判据 B 的关键）。
 *
 * URL 拼接遵循本仓库既有的 baseURL 规则（见记忆 gateway-baseurl-v1-path-rule）：
 * anthropic 族的 `base_url` 配的是**不带 /v1** 的裸域名，因为 SDK 会自动追加
 * `/v1/messages`。裸 fetch 没有 SDK 帮忙，必须自己补 `/v1` —— 否则打到
 * `POST /messages`，网关返回非 JSON 错误页，表现为 "Failed to parse JSON"
 *（第一次实跑就是这么失败的）。base 已带 /v1 时不重复追加，避免 `/v1/v1/messages` 404。
 */
async function sendAnthropicRaw(
  base: string,
  apiKey: string,
  model: string,
  prefix: string,
  maxTokens: number,
  withCacheControl: boolean,
): Promise<Record<string, unknown>> {
  const systemBlock: Record<string, unknown> = { type: "text", text: prefix };
  if (withCacheControl) systemBlock.cache_control = { type: "ephemeral" };

  const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [systemBlock],
      messages: [{ role: "user", content: [{ type: "text", text: "reply with: ok" }] }],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as any;
  return body.usage ?? {};
}

/** OpenAI 兼容裸请求（自动前缀缓存，无需也无法打断点） */
async function sendOpenAIRaw(
  base: string,
  apiKey: string,
  model: string,
  prefix: string,
  maxTokens: number,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: prefix },
        { role: "user", content: "reply with: ok" },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as any;
  return body.usage ?? {};
}

/**
 * 粗估单次探测成本（美元）——只用于预算护栏，不写进任何账本。
 *
 * 刻意取一个偏高的单价（$15/M 输入、$75/M 输出，接近最贵的 Opus 档）：
 * 护栏宁可高估提前停手，也不能低估把预算跑穿。
 */
function estimateCost(promptTotal: number, output: number): number {
  return (promptTotal / 1_000_000) * 15 + (output / 1_000_000) * 75;
}
