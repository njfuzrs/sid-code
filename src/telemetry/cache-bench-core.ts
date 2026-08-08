/**
 * cache-bench-core.ts —— 受控缓存实测的驱动与聚合（P1-1 / T3）
 *
 * 与 `scripts/cache-bench.ts` 分开的理由与探针同源（见 `cache-trust-probe-core.ts` 头注）：
 * **聚合口径必须能在没有网络的情况下测。** "稳态命中率"怎么算是这套数字的全部意义所在，
 * 把它和"发请求"揉进一个脚本，就只能靠真花钱打真渠道来验证除法有没有写错。
 *
 * 所以这里同样两层：`summarizeRounds` 纯函数（单测覆盖），`benchModel` 只驱动请求并调它。
 *
 * ⚠️ 与探针的关键差异：探针问"这个渠道的 usage 能不能信"，用**每次都全新**的前缀；
 * 本脚本问"缓存生效后能到多少"，用**跨轮固定**的前缀 + 尾部追加增量。
 * 两者的前缀策略正好相反，不能互相复用发送器。
 */

// model-registry 是**零 import 的纯数据表**，静态引入不成环（探针那边因为要用
// llm/types.ts 才被迫动态 import，这里没这个约束）。
import { lookupRegistry } from "../llm/model-registry.ts";

/** 单轮观测结果 */
export interface RoundResult {
  round: number;
  /** 完整输入 = 命中 + 写入 + 未命中（取 normalizeCacheUsage 的 promptTotal） */
  promptTotal: number;
  cacheHit: number;
  /**
   * 写入缓存 token 数。
   *
   * **必须单独记，不能只记命中**（实跑踩到的）：命中恒 0 有两种完全不同的成因 ——
   * ①什么都没缓存（断点没生效 / 前缀太短）；②每轮都在**重新写入**（缓存键把变化的
   * 尾部也算进去了，于是永远写、永远读不到）。只看 hit=0 两者无法区分，
   * 而它们的修法相反。Anthropic 族有此字段，OpenAI 族恒 0。
   */
  cacheWrite: number;
  /** 本轮命中率 = cacheHit / promptTotal；promptTotal 为 0 时记 0 而非 NaN */
  hitRate: number;
  costUSD: number;
}

export interface ModelBench {
  model: string;
  provider: string;
  host?: string;
  rounds: RoundResult[];
  /**
   * 稳态命中率：**排除 r1** 后的加权命中率 —— 这才是"缓存生效后能到多少"。
   *
   * 轮数不足 2 时为 null（没有可算稳态的样本），不是 0。
   */
  steadyStateHitRate: number | null;
  /** 全轮加权命中率（含 r1，与账本口径一致，便于对照） */
  overallHitRate: number | null;
  spentUSD: number;
  /** 非空表示提前中止（预算耗尽 / 请求失败） */
  aborted?: string;
}

/**
 * 把逐轮观测聚合成两个口径的命中率（纯函数）。
 *
 * **两个口径都要给，是这个函数存在的理由。** 只给稳态会掩盖冷启动的真实成本，
 * 只给全轮会系统性低估缓存能力 —— r1 必然 0 命中（服务端从未见过该前缀），
 * 轮数越少它对均值的拖累越大：8 轮里 r1 占 1/8，把一个 95% 的实现记成 83%。
 * 账本 66.9% 与"单请求上限 95%+"的差距里，就有一部分是这种口径差而非实现差。
 *
 * 加权而非算术平均：按 token 量加权才等于"这些请求总共省了几成输入"，
 * 而对逐轮百分比取算术平均会让 token 量小的轮次获得与大轮次相同的话语权。
 */
export function summarizeRounds(rounds: RoundResult[]): {
  steadyStateHitRate: number | null;
  overallHitRate: number | null;
} {
  const weighted = (xs: RoundResult[]): number | null => {
    if (xs.length === 0) return null;
    const total = xs.reduce((a, r) => a + r.promptTotal, 0);
    if (total === 0) return null;
    return xs.reduce((a, r) => a + r.cacheHit, 0) / total;
  };
  return {
    steadyStateHitRate: weighted(rounds.slice(1)),
    overallHitRate: weighted(rounds),
  };
}

/** 单轮命中率（promptTotal 为 0 时记 0，避免 NaN 传进聚合） */
export function roundHitRate(cacheHit: number, promptTotal: number): number {
  return promptTotal > 0 ? cacheHit / promptTotal : 0;
}

/** benchModel 的依赖注入面（便于测试时替换掉真实请求） */
export interface BenchDeps {
  config: any;
  modelConfig: { name: string; modelId?: string; apiKey?: string; baseURL?: string };
  provider: string;
  baseURL?: string;
  rounds: number;
  /** 跨轮**完全不变**的静态前缀（模拟 system prompt 的可缓存部分） */
  prefix: string;
  /** 第 n 轮的消息序列（只在尾部追加，不动前缀） */
  turnMessages: (round: number) => Array<{ role: string; content: string }>;
  maxTokens: number;
  costCeilingUSD: number;
  log: (msg: string) => void;
  /**
   * 发一次请求并返回观测到的 usage。默认实现走裸 HTTP；
   * 测试注入假实现即可在无网络下验证驱动与聚合逻辑。
   */
  sendOnce?: (opts: {
    prefix: string;
    messages: Array<{ role: string; content: string }>;
  }) => Promise<{ promptTotal: number; cacheHit: number; cacheWrite: number; costUSD: number }>;
}

/**
 * 跑 N 轮受控实测，返回逐轮曲线 + 两个口径的汇总。
 *
 * 预算护栏在**每轮请求前**检查：超了立刻停手，已跑的轮次照常聚合并返回
 *（半条曲线仍有诊断价值，比丢掉全部数据好）。
 */
export async function benchModel(deps: BenchDeps): Promise<ModelBench> {
  const send = deps.sendOnce ?? makeRealSender(deps);
  const host = hostOf(deps.baseURL);
  const rounds: RoundResult[] = [];
  let spent = 0;
  let aborted: string | undefined;

  deps.log(`实测 ${deps.modelConfig.name} @ ${host ?? "(默认端点)"}（${deps.rounds} 轮）`);

  for (let i = 1; i <= deps.rounds; i++) {
    if (spent >= deps.costCeilingUSD) {
      aborted = `预算耗尽（已花 $${spent.toFixed(4)} ≥ 上限 $${deps.costCeilingUSD.toFixed(4)}）`;
      break;
    }
    try {
      const r = await send({ prefix: deps.prefix, messages: deps.turnMessages(i) });
      spent += r.costUSD;
      const hitRate = roundHitRate(r.cacheHit, r.promptTotal);
      rounds.push({
        round: i,
        promptTotal: r.promptTotal,
        cacheHit: r.cacheHit,
        cacheWrite: r.cacheWrite,
        hitRate,
        costUSD: r.costUSD,
      });
      deps.log(
        `  r${i}: in=${r.promptTotal} hit=${r.cacheHit} write=${r.cacheWrite} (${(hitRate * 100).toFixed(1)}%)`,
      );
    } catch (e) {
      // 请求失败不等于"缓存不生效"——记为中止，不要把它掺进命中率
      aborted = `第 ${i} 轮请求失败：${(e as Error)?.message ?? String(e)}`;
      break;
    }
  }

  const { steadyStateHitRate, overallHitRate } = summarizeRounds(rounds);
  return {
    model: deps.modelConfig.name,
    provider: deps.provider,
    host,
    rounds,
    steadyStateHitRate,
    overallHitRate,
    spentUSD: spent,
    aborted,
  };
}

function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 默认发送器：裸 HTTP，按协议族分派。
 *
 * 与探针同理不走 provider 类：本脚本要**精确控制**前缀跨轮不变，而生产 provider 会注入
 * reminder / JIT / todo 等动态内容 —— 那些恰恰是 P1-2 要量的"打断源"，掺进来就测不出
 * "理想形态下缓存能到多少"这个上限了。
 *
 * 三族分派（缺一族就会静默测错口径，这正是 P0-1 的病根）：
 *   anthropic          → POST /v1/messages，命中在 cache_read_input_tokens
 *   openai-responses   → POST /responses，命中在 input_tokens_details.cached_tokens
 *   其余 openai 兼容   → POST /chat/completions，命中在 prompt_tokens_details.cached_tokens
 */
function makeRealSender(deps: BenchDeps): NonNullable<BenchDeps["sendOnce"]> {
  return async ({ prefix, messages }) => {
    const { normalizeCacheUsage } = await import("../llm/types.ts");
    const wireModel = deps.modelConfig.modelId ?? deps.modelConfig.name;
    const apiKey =
      deps.modelConfig.apiKey ??
      (deps.provider === "anthropic" ? deps.config.anthropicKey : deps.config.openaiKey);
    const base = (deps.baseURL ?? "").replace(/\/+$/, "");

    const raw =
      deps.provider === "anthropic"
        ? await sendAnthropic(base, apiKey, wireModel, prefix, messages, deps.maxTokens)
        : usesResponsesAPI(wireModel)
          ? await sendResponses(base, apiKey, wireModel, prefix, messages, deps.maxTokens)
          : await sendChat(base, apiKey, wireModel, prefix, messages, deps.maxTokens);

    const n = normalizeCacheUsage(toInternalUsage(raw, deps.provider), deps.provider);
    return {
      promptTotal: n.promptTotal,
      cacheHit: n.cacheHitTokens,
      cacheWrite: n.cacheWriteTokens,
      // 成本只用于预算护栏，不写进任何账本
      costUSD: estimateCost(n.promptTotal, n.outputTokens),
    };
  };
}

/**
 * 该模型是否走 Responses API。
 *
 * 判据取自 registry 的 `protocolKind`（与生产 `shouldUseResponsesAPI` 的**优先级 2** 同源），
 * 不复制它的模型名正则 —— 那会立刻漂移。registry 查不到时按 Chat 线处理：
 * 猜错协议比不猜更糟（P0-5 的教训）。
 */
export function usesResponsesAPI(model: string): boolean {
  return lookupRegistry(model)?.protocolKind === "openai-responses";
}

/** Anthropic：system 打 cache_control 断点（不打则不缓存，命中率恒 0） */
async function sendAnthropic(
  base: string,
  apiKey: string,
  model: string,
  prefix: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Promise<Record<string, unknown>> {
  // baseURL 规则见记忆 gateway-baseurl-v1-path-rule：anthropic 族配的是不带 /v1 的裸域名
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
      system: [{ type: "text", text: prefix, cache_control: { type: "ephemeral" } }],
      messages,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return ((await res.json()) as any).usage ?? {};
}

/** OpenAI Chat Completions：自动前缀缓存，无需打断点 */
async function sendChat(
  base: string,
  apiKey: string,
  model: string,
  prefix: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: prefix }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return ((await res.json()) as any).usage ?? {};
}

/**
 * OpenAI Responses API：`instructions` + `input`，非流式。
 *
 * 这一族的命中在 `input_tokens_details.cached_tokens`，与 Chat 线的
 * `prompt_tokens_details.cached_tokens` 是**不同的键** —— 正是 P0-1 漏采的那个坑。
 * 探针不覆盖这条路径（它只需要判 usage 真假），所以这里必须自己发。
 */
async function sendResponses(
  base: string,
  apiKey: string,
  model: string,
  prefix: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_output_tokens: Math.max(16, maxTokens),
      instructions: prefix,
      input: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return ((await res.json()) as any).usage ?? {};
}

/**
 * 线上 snake_case usage → 内部 camelCase `Usage`。
 *
 * OpenAI 族的命中键有多种形态，兜底链与生产 `extractOpenAICacheHit` 同序
 * （`prompt_cache_hit_tokens` → `prompt_tokens_details` → `input_tokens_details` → 裸 `cached_tokens`）。
 * 少一环就会把真实命中读成 0，而"零命中"在这里不会报错、只会静默拉低结论。
 */
export function toInternalUsage(raw: Record<string, unknown>, provider: string): any {
  if (provider === "anthropic") {
    return {
      inputTokens: (raw.input_tokens as number) ?? 0,
      outputTokens: (raw.output_tokens as number) ?? 0,
      cacheReadInputTokens: (raw.cache_read_input_tokens as number) ?? 0,
      cacheCreationInputTokens: (raw.cache_creation_input_tokens as number) ?? 0,
    };
  }
  const details = raw.prompt_tokens_details as { cached_tokens?: number } | undefined;
  const inputDetails = raw.input_tokens_details as { cached_tokens?: number } | undefined;
  return {
    // Responses API 用 input_tokens/output_tokens，Chat 用 prompt_tokens/completion_tokens
    inputTokens: (raw.prompt_tokens as number) ?? (raw.input_tokens as number) ?? 0,
    outputTokens: (raw.completion_tokens as number) ?? (raw.output_tokens as number) ?? 0,
    cacheReadInputTokens:
      (raw.prompt_cache_hit_tokens as number) ??
      details?.cached_tokens ??
      inputDetails?.cached_tokens ??
      (raw.cached_tokens as number) ??
      0,
  };
}

/**
 * 粗估单轮成本（美元）——只用于预算护栏，不写进任何账本。
 *
 * 与探针同口径：刻意取偏高单价（$15/M 输入、$75/M 输出，接近最贵的 Opus 档），
 * 护栏宁可高估提前停手，也不能低估把预算跑穿。
 */
function estimateCost(promptTotal: number, output: number): number {
  return (promptTotal / 1_000_000) * 15 + (output / 1_000_000) * 75;
}
