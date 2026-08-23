/**
 * /model 面板的模型参数 / 价格**格式化**纯逻辑（与渲染解耦，便于单测）。
 *
 * 与 `model-grouping.ts` 的分工：那边管「哪些行、什么顺序」，这边管「一行里的数字怎么写」。
 * 两者都刻意不 import 任何渲染组件——`src/ui/CLAUDE.md` §5.2 的理由：fork 的 ink 拼不出
 * 组件预览环境，能抽成纯函数的一律抽出来用 `bun -e` / 单测验证。
 *
 * 三条格式化原则（都是为了让一屏能横向比较）：
 *
 * 1. **数量级压缩优先于精度**：窗口写 `200K` / `1M` 而不是 `200000`。列表是用来**比较**的，
 *    多两位数字换不来任何判断力，却会把行挤爆。精确值在详情行里给。
 * 2. **猜的数字必须带记号**：来源是 `fuzzy`/`fallback` 时加 `~` 前缀。把兜底常量 1M
 *    印成「上下文 1M」是拿猜测冒充事实，用户会据此判断「这个模型装得下」。
 * 3. **免费是 `免费` 不是 `$0.00`**：`$0.00` 读起来像「小到显示不出来」，而 0 是确定事实
 *    （订阅制 / 内部免费渠道确实存在）。这条与 StatsDialog 的 fmtPrice 保持一致。
 */

import type { ModelMetaSource } from "@sid-code/core/llm/token-estimator.ts";
import { isGuessedMetaSource } from "@sid-code/core/llm/token-estimator.ts";
import type { ModelProfile, PricingSource } from "@sid-code/core/llm/model-profile.ts";

/** 猜测值的前缀记号。`~` 是通行的「约等于」，不占列宽、不需要图例 */
const GUESS_MARK = "~";

/**
 * token 数压缩成 `1M` / `200K` / `64K` / `512`。
 *
 * ⚠ **换算基数按值本身的形态选，不是二选一定死**——这是唯一能同时对上所有厂商文档的规则：
 *
 * - 上下文窗口是**十进制**口径：`200000` 就是官方说的 `200K`、`1000000` 就是 `1M`。
 *   按 1024 算会把 200000 显示成 `195K`，一个没人认识、对不上任何文档的数。
 * - 输出上限往往是**2 的幂**：`65536` / `32768` / `8192`，而厂商一律称它 `64K` / `32K` / `8K`。
 *   按 1000 算会得到 `66K` / `33K` / `8.2K`，同样对不上文档。
 *
 * 所以判据是：**能被 1024 整除且商是 2 的幂时按 1024 算，否则按 1000 算**。
 * 这不是"两套口径打架"，而是这两类数字在现实中确实用两种基数命名，
 * 而它们的取值形态恰好可区分（十进制窗口值不会同时是 1024 的整数倍且商为 2 的幂）。
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return "—";
  // 2 的幂优先：65536 → 64K、1048576 → 1M（与十进制 1M 巧合一致，无歧义）
  if (isPowerOfTwo(n)) {
    if (n >= 1024 * 1024) return `${n / (1024 * 1024)}M`;
    if (n >= 1024) return `${n / 1024}K`;
    return String(n);
  }
  if (n >= 1_000_000) return `${trimZero(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimZero(n / 1_000)}K`;
  return String(n);
}

/** n 是否为 2 的正整数次幂（65536 / 32768 / 8192 …）。 */
function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** 去掉无意义的小数尾零：1.0 → "1"，1.5 → "1.5"，271.4 → "271" */
function trimZero(v: number): string {
  // 一位小数够了：窗口值的量级差异是数量级的，小数第二位不影响任何判断。
  // ≥10 时直接取整——`272K` 比 `271.4K` 更接近厂商口径的说法。
  if (v >= 10) return String(Math.round(v));
  const s = v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** token 数 + 猜测记号。来源是猜的时候前面加 `~` */
export function formatTokensSourced(v: { value: number; source: ModelMetaSource } | null): string {
  if (!v) return "—";
  return (isGuessedMetaSource(v.source) ? GUESS_MARK : "") + formatTokens(v.value);
}

/**
 * 每百万 token 单价：`$3.00` / `$0.014` / `免费`。
 *
 * 小数位随量级变：≥1 给 2 位（$3.00），≥0.01 给 3 位（$0.435），更小给 4 位（$0.0014）。
 * 固定 2 位会把 DeepSeek 那档便宜价全部显示成 `$0.00`——那不是"便宜"，是"看起来免费"。
 * 与 `StatsDialog.fmtPrice` 同一套口径（那边带 `/M` 后缀，这边由调用方决定要不要带，
 * 因为列表里每行都印 `/M` 是纯噪音）。
 */
export function formatPricePerM(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  if (v === 0) return "免费";
  const decimals = v >= 1 ? 2 : v >= 0.01 ? 3 : 4;
  return `$${v.toFixed(decimals)}`;
}

/**
 * 列表行里的紧凑价格列：`$3/$15`（输入/输出）。
 *
 * 刻意**只给 in/out 两个数、且省掉 `/M`**：列表是横向扫视用的，缓存价与单位在这里
 * 一律是噪音（缓存价恒为 input 的固定倍数，看一眼输入价就知道量级）。完整四项在详情行。
 * 按次计费模型走 `$X/次`——它没有 token 价，印 `in $0/out $0` 是错的（这个坑
 * `/model pricing` 踩过，见 model.ts 里 getGatewayPerCall 的注释）。
 */
export function formatPriceColumn(p: ModelProfile): string {
  if (p.perCallUSD !== undefined) return `${formatPricePerM(p.perCallUSD)}/次`;
  if (!p.pricing) return "—";
  const inp = compactPrice(p.pricing.input);
  const out = compactPrice(p.pricing.output);
  return `${inp}/${out}`;
}

/**
 * 列表列专用的更狠的压缩：整数就不带小数（`$3` 而不是 `$3.00`）。
 * 列表要的是量级，`$3` 与 `$3.00` 传递的信息完全相同，但省掉 3 列 × 20 行。
 */
function compactPrice(v: number): string {
  if (v === 0) return "免费";
  if (!Number.isFinite(v)) return "—";
  if (Number.isInteger(v)) return `$${v}`;
  return formatPricePerM(v);
}

/** 价格来源的中文标签。展示它是因为「这个数从哪来」直接决定用户信不信它 */
export function pricingSourceLabel(s: PricingSource): string {
  switch (s) {
    case "user":
      return "手写";
    case "gateway":
      return "网关实采";
    case "registry":
      return "注册表";
    case "unknown":
      return "未知·按 in $2/out $10 估";
  }
}

/** 能力值来源的中文标签。只在「猜的」时候需要说出来，精确命中不必解释 */
export function metaSourceLabel(s: ModelMetaSource): string | undefined {
  switch (s) {
    case "fuzzy":
      return "按同族模型推测";
    case "fallback":
      return "未采集到，用兜底值";
    default:
      return undefined;
  }
}

/**
 * 详情行第一段：`上下文 1M · 输出 64K · 档位 low/medium/high/max`。
 *
 * 不支持档位的模型整段省掉「档位」而不是写「档位 无」——没有的东西不占视觉位置。
 */
export function formatCapabilityLine(p: ModelProfile): string {
  const parts = [`上下文 ${formatTokensSourced(p.contextWindow)}`];
  if (p.maxOutputTokens) parts.push(`输出 ${formatTokensSourced(p.maxOutputTokens)}`);
  if (p.efforts.length > 0) parts.push(`档位 ${p.efforts.join("/")}`);
  if (p.wireModel !== p.name) parts.push(`真名 ${p.wireModel}`);
  return parts.join(" · ");
}

/**
 * 详情行第二段：完整单价（含缓存读写）+ 来源。
 *
 * cacheRead/cacheWrite 只在**确实有值**时展示。`resolvePricing` 的约定是不填由计价方
 * 按 input×0.1 / ×1.25 近似——把近似值印成事实会让用户以为这是厂商公布的价。
 */
export function formatPricingLine(p: ModelProfile): string {
  if (p.perCallUSD !== undefined) {
    return `按次计费 ${formatPricePerM(p.perCallUSD)}/次（${pricingSourceLabel(p.pricingSource)}）`;
  }
  if (!p.pricing) return `单价未知（${pricingSourceLabel(p.pricingSource)}）`;
  const parts = [
    `输入 ${formatPricePerM(p.pricing.input)}/M`,
    `输出 ${formatPricePerM(p.pricing.output)}/M`,
  ];
  if (typeof p.pricing.cacheRead === "number") {
    parts.push(`缓存读 ${formatPricePerM(p.pricing.cacheRead)}`);
  }
  // ⚠ cacheWrite 只在 **> 0** 时展示（与 StatsDialog.fmtPrice 那一段同口径），
  // 因为 `0` 在这里是**两种含义混在一起**、读侧分不开：
  //   - GLM / Kimi / Gemini：注册表里显式写的 0，含义是"缓存写入确实不额外计费"；
  //   - 网关采集：`create_cache_ratio` 缺失时被**默认填成** 0（见 gateway-pricing.ts
  //     convertRawEntry 尾部），含义其实是"网关没报这个字段"。
  // 把后者印成「写 免费」是拿缺省值冒充事实。0 一律省掉：真免费的模型少一行无损，
  // 而未知的不会被误说成免费。
  if (typeof p.pricing.cacheWrite === "number" && p.pricing.cacheWrite > 0) {
    parts.push(`写 ${formatPricePerM(p.pricing.cacheWrite)}`);
  }
  let suffix = pricingSourceLabel(p.pricingSource);
  // 人民币原价：折算用的是**固定汇率快照**不是实时汇率，不点破就等于宣称这是精确美元价。
  if (p.originalCurrency === "CNY") suffix += "·原价人民币";
  // 分时段模型：同一个模型此刻的价与几小时后不同，不标注会让用户以为这是唯一价。
  if (p.isPeakNow === true) suffix += "·当前高峰价";
  else if (p.isPeakNow === false) suffix += "·当前空闲价";
  return `${parts.join(" ")}（${suffix}）`;
}
