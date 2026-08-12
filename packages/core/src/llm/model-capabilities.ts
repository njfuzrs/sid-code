/**
 * 模型能力动态解析 — 让「用户只配 name + endpoint + apiKey 就能用」成立。
 *
 * ── 为什么需要这个模块 ───────────────────────────────────────────────
 *
 * 此前能力字段（contextWindow / maxOutputTokens / effort 档位）只有两个来源：用户手写、
 * 内置注册表（model-registry.ts）。两者都 miss 时走硬编码兜底，于是每上一个新模型就得
 * 改一次代码或配置表——这既不可持续，也违反 `feedback-no-hardcoded-model-tier-rules`
 * （不按模型名硬编码分档）。本模块补上**动态采集 + 自愈**这一层。
 *
 * 与 gateway-pricing.ts 的职责切分（严格互补，勿混）：
 * - gateway-pricing.ts 采**价格**，按「模型名 + 端点」复合键（价格随渠道变，同名不同价）。
 * - 本模块采**能力**，按「模型名」单键（能力是模型固有属性，不因端点变化）。
 *   例外：`effortValues` 观测自具体端点，但记的是模型属性，跨端点复用是安全的近似。
 *
 * ── 三个数据来源（互补，全部可选、全部可失败） ──────────────────────
 *
 * 1. **外部目录同步**（syncExternalCatalogs）：litellm + OpenRouter 多源投票。
 *    实测覆盖公司网关 127 个模型中的 93 个（73%）：litellm 88、OpenRouter 61、并集 93。
 *    两源打架时取「更保守的窗口 + 更大的输出上限」，宁可低估窗口也不高估（高估直接 400）。
 *    ⚠ 国内可达性是选源的硬约束：litellm 官方 raw.githubusercontent.com 不可达，
 *    故走 jsdelivr CDN 镜像；OpenRouter 官方域直连可达。已实测排除的源见 CATALOG_SOURCES 注释。
 *
 * 2. **运行时探针**（probeEffortValues）：故意发一个非法 `reasoning_effort` 值，
 *    从 400 错误里抽取服务端自报的支持档位。不依赖任何外部源，也不含模型名判据。
 *    两种结果都有用：400 → 拿到档位列表；200 → 该字段不被校验（模型无此能力）。
 *    ⚠ 精度边界（实测）：网关有**两级校验**——字段级报的是网关并集，模型级才是真值；
 *    且连模型级列表也不完全可信（luna 自报不含 max，但 max 实测可用且真出 reasoning_tokens）。
 *    故探针结果是**高质量近似**，永远让位于用户配置与注册表。
 *
 * 3. **自愈学习**（learnFromError）：真实请求 400 时从错误里反推真值并写回缓存。
 *    这是「永不报错」的最后一道保障，也顺带根治 contextWindow 兜底猜错
 *    （见 docs/bugfixes/done/20260730-未知模型contextWindow兜底失真-根因与修复记录.md）：
 *    兜底猜大了会撞 400，撞一次就学到真实上限，不必等人工补表。
 *
 * 容错：第三方 HTTP 属**不可信数据**——严格数值校验，非法条目丢弃；任何失败都静默
 * 保留旧缓存并回退注册表，绝不阻塞启动、计费或对话。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";
import { resolveSideCallTimeouts } from "../config/network-profile.ts";
import { getLogger } from "../debug/logger.ts";
// 上下文超限判定的唯一事实源（见 learnFromError 第 3 段的委托说明）
import { isPromptTooLong } from "../api/errors.ts";

/**
 * ⚠ 每次调用时取 logger，不可模块级捕获——与 gateway-pricing.ts 同理：
 * 本模块在静态导入链上，求值时机早于 cli.ts 的 initLogger()，模块级捕获会把
 * enabled=false 的兜底实例冻进闭包，WARN 泄漏到用户终端污染 TUI。
 */
const log = () => getLogger();

// ─────────────────────────────────────────────────────────────
// 类型与常量
// ─────────────────────────────────────────────────────────────

/** 统一 effort 档位字面量（与 effort.ts 的 EFFORT_LEVELS 对齐，此处独立声明避免循环依赖）。 */
const KNOWN_EFFORT_WORDS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 一条模型能力记录。字段全可选——只记「确实采到的」，缺失即代表未知，由调用方兜底。 */
export interface ModelCapabilityEntry {
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 服务端自报的 reasoning effort 档位（探针/外部源采得）。空数组 = 明确不支持 effort。 */
  effortValues?: string[];
  /** 该模型是否支持 reasoning（外部源 supports_reasoning / reasoning 字段）。 */
  supportsReasoning?: boolean;
  /** 数据来源，便于 /model list 展示与排障。 */
  source?: "catalog" | "probe" | "healed";
  /** 采集时间戳（ms）。用于 TTL 与「哪条更新」判定。 */
  fetchedAt?: number;
}

interface CapabilityCacheFile {
  schema_version: number;
  /** 按模型名单键（能力是模型固有属性，不按端点分桶——与价格缓存的关键差异）。 */
  models: Record<string, ModelCapabilityEntry>;
  /** 外部目录上次同步时间（成功/失败都记，用于 TTL 与退避）。 */
  catalog_synced_at?: number;
  catalog_fail_count?: number;
}

const SCHEMA_VERSION = 1;

/**
 * 缓存条目数上限（安全护栏，非正常场景会触及）。
 * 正常增长有界：外部目录并集约 3000 条，探针/自愈按「用户实际试过的模型数」增长，
 * 天然很小。这个上限只防守「磁盘文件被篡改/损坏成异常大」时不至于在启动时卡住或
 * 撑爆内存——命中上限时丢弃多余条目并记 warn，而不是拒绝整个文件。
 */
const MAX_CACHE_ENTRIES = 20_000;

/**
 * 外部目录同步 TTL：默认 **1 天**，可经 `SID_MODEL_CATALOG_TTL_MS` 覆盖。
 *
 * 为什么是 1 天而不是 7 天（2026-08-01 从 7 天下调）：模型迭代节奏就是按天的——
 * 网关先上线一个新模型、我们的注册表还没有它，这个空窗期里能力全靠本模块采集。
 * 7 天 TTL 意味着最坏情况用户要拿着「1M 兜底」跑一周（对真实 272K 窗口的模型
 * 高估 3.8 倍，直接吃 400）。1 天把这个空窗压到可接受。
 *
 * 代价评估（结论：可接受）：
 * - 流量：两源合计约 2.7MB/天/机器（litellm 1.67MB + OpenRouter），fire-and-forget
 *   不在启动关键路径上，用户不可感知。
 * - 上游坏数据传播更快：由 sanitizeEntry（拦 Infinity/NaN/非正/非整）+ voteMerge
 *   （窗口取两源最小值）两道防线兜住，与拉取频率无关。
 * - 失败不会因变频而变吵：全源失败仍走指数退避（30min 起、封顶 24h）+ debug 级日志。
 */
const DEFAULT_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** 解析目录同步 TTL：env 覆盖（正有限数）> 默认 1 天。非法值静默回退默认。 */
function resolveCatalogTtlMs(): number {
  const raw = Number(process.env.SID_MODEL_CATALOG_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CATALOG_TTL_MS;
}

/** 同步失败退避基数（指数退避，封顶 24h）——对齐 gateway-pricing 的负缓存策略。 */
const FAIL_BACKOFF_BASE_MS = 30 * 60 * 1000;
const FAIL_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * 外部模型目录源。顺序即优先级（靠前者在投票平局时胜出）。
 *
 * ⚠ 这里出现的是**数据源域名**，不是模型名判据——不违反「不按模型名硬编码」原则。
 * 新增模型无需改这里；只有数据源本身失效才需要维护。
 *
 * 选源的硬约束是**国内可达性**，不是数据质量——曾有两个候选源因 DNS 不可解析 / 请求超时
 * 且无可用 CDN 镜像而实测排除（已从方案中彻底移除，不再列具体域名以免被误当候选重试）。
 * 新增源前先在国内网络实测直连与 jsdelivr 镜像两条路径，再谈字段覆盖率。
 */
const CATALOG_SOURCES = [
  {
    name: "litellm",
    // 官方 raw.githubusercontent.com 国内不可达，走 jsdelivr CDN 镜像（实测 200 / 1.67MB）。
    url: "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/litellm/model_prices_and_context_window_backup.json",
    parse: parseLitellm,
  },
  {
    name: "openrouter",
    url: "https://openrouter.ai/api/v1/models",
    parse: parseOpenRouter,
  },
] as const;

// ─────────────────────────────────────────────────────────────
// 内存缓存
// ─────────────────────────────────────────────────────────────

let memModels: Record<string, ModelCapabilityEntry> | null = null;
let memMeta: { syncedAt?: number; failCount?: number } = {};

/** 读缓存文件（含 schema 校验）。失败返回 null。 */
function readCacheFile(): CapabilityCacheFile | null {
  try {
    const path = sidPaths.modelCapabilities();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const file = raw as CapabilityCacheFile;
    if (file.schema_version !== SCHEMA_VERSION) return null; // 版本不匹配 → 视为空，重新采集
    if (!file.models || typeof file.models !== "object") return null;
    return file;
  } catch {
    return null;
  }
}

/** 载入缓存到内存（幂等）。 */
export function loadCapabilityCache(): void {
  if (memModels !== null) return;
  memModels = {};
  const file = readCacheFile();
  if (!file) return;

  // ⚠ 关键：磁盘数据一律视为不可信（可能被手工改坏、被旧版本写入、或被外部工具篡改），
  // 必须逐条过一遍与 mergeEntry 同源的校验，不能直接 `memModels = file.models`。
  // 事故复现：`{"contextWindow": 1e400}` JSON 解析后是 `Infinity`——它是 `typeof === "number"`
  // 且 `> 0`，token-estimator.ts 原先的 `dynamic > 0` 检查完全放它通过，会让上下文预算
  // 计算永远「还有空间」，auto-compact/上下文超限检测全部失效。
  const entries = Object.entries(file.models);
  const capped = entries.length > MAX_CACHE_ENTRIES ? entries.slice(0, MAX_CACHE_ENTRIES) : entries;
  if (entries.length > MAX_CACHE_ENTRIES) {
    log().warn(
      "MODEL-CAP",
      `能力缓存条目数 ${entries.length} 超过上限 ${MAX_CACHE_ENTRIES}，已截断（文件可能损坏或被篡改）`,
    );
  }

  const sanitized: Record<string, ModelCapabilityEntry> = {};
  let dropped = 0;
  for (const [key, raw] of capped) {
    const clean = sanitizeEntry(raw);
    if (clean) sanitized[key] = clean;
    else dropped++;
  }

  memModels = sanitized;
  memMeta = { syncedAt: file.catalog_synced_at, failCount: file.catalog_fail_count };
  log().debug(
    "MODEL-CAP",
    `载入模型能力缓存 ${Object.keys(sanitized).length} 条${dropped > 0 ? `（丢弃 ${dropped} 条非法数据）` : ""}`,
  );
}

/**
 * 测试隔离开关 —— 置位后所有写盘变为 no-op。
 *
 * ⚠ 存在原因（真实事故）：单测调 learnFromError / probeModelCapability 会触发 persist()，
 * 而 persist 写的是**用户真实缓存文件** `~/.sid-code/model-capabilities.json`。
 * 一次 `bun test` 就把开发机上已采集的 2919 条能力数据抹成了测试残留的 1 条
 * （测试用 __resetCapabilityCacheForTest 清空内存 → persist 把空表写回磁盘）。
 * 由 __resetCapabilityCacheForTest 自动置位，生产路径永不置位。
 */
let persistDisabled = false;

/** 落盘（失败静默——缓存是纯优化项）。 */
function persist(): void {
  if (persistDisabled) return; // 测试态：绝不碰用户真实文件
  try {
    const path = sidPaths.modelCapabilities();
    mkdirSync(dirname(path), { recursive: true });
    const file: CapabilityCacheFile = {
      schema_version: SCHEMA_VERSION,
      models: memModels ?? {},
      catalog_synced_at: memMeta.syncedAt,
      catalog_fail_count: memMeta.failCount,
    };
    // 原子写：先写临时文件再 rename，避免进程在 writeFileSync 中途被杀导致
    // 半截 JSON 落盘（下次启动 JSON.parse 失败 → 整份缓存作废、退回兜底）。
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
    renameSync(tmp, path);
  } catch {
    /* 落盘失败：内存仍生效，下次启动重新采集 */
  }
}

/**
 * 查询模型能力（**只读内存，绝不触网**——可安全用于热路径）。
 *
 * 归一化匹配：精确 → 剥离渠道前缀（ali-/tx-/volc-…）→ 剥离 vendor 路径前缀（kimi/xxx）。
 * 与 model-registry 的匹配策略同构，但**不做**模糊前缀匹配（避免把 gpt-5.4-mini 的
 * 400K 窗口糊给 gpt-5.4 那种跨档误配——缓存条目来自第三方，精度不如手工注册表）。
 */
export function lookupCapability(model: string): ModelCapabilityEntry | null {
  if (memModels === null) loadCapabilityCache();
  const models = memModels ?? {};
  for (const key of normalizeCandidates(model)) {
    const hit = models[key];
    if (hit) return hit;
  }
  return null;
}

/**
 * 生成模型名的归一化候选键（由精确到宽松）。
 *
 * 渠道前缀白名单与 model-registry 的 ROUTE_PREFIXES 同源语义：网关给模型名加连字符
 * 供应商前缀（ali- / tx- / volc- 等），这些前缀不影响模型固有能力，可安全剥离。
 * 绝不盲目按 "-" 拆分（否则误伤 gpt-5.6-luna / claude-sonnet-5 这类正规名）。
 */
function normalizeCandidates(model: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  };
  push(model);
  // vendor 路径前缀（OpenRouter 风格 "deepseek/deepseek-v4"、网关 "kimi/kimi-k2.6"）
  if (model.includes("/")) push(model.slice(model.lastIndexOf("/") + 1));
  // 渠道路由前缀
  const stripped = model.replace(/^(ali|tx|volc|origin|hw|az)-/i, "");
  if (stripped !== model) {
    push(stripped);
    if (stripped.includes("/")) push(stripped.slice(stripped.lastIndexOf("/") + 1));
  }
  return out;
}

/** 合并一条能力记录进缓存（逐字段合并——新数据不得把已知字段覆盖成 undefined）。 */
function mergeEntry(model: string, patch: ModelCapabilityEntry): void {
  if (memModels === null) loadCapabilityCache();
  const key = model.trim().toLowerCase();
  if (!key) return;
  const clean = sanitizeEntry(patch);
  if (!clean) return; // patch 全部字段都非法 → 无新信息，不动缓存
  const prev = (memModels ??= {})[key] ?? {};
  const next: ModelCapabilityEntry = { ...prev, ...clean };
  next.fetchedAt = clean.fetchedAt ?? Date.now();
  memModels[key] = next;
}

/** 严格数值校验：第三方数据不可信，非有限/非正/非整一律丢弃（含 Infinity/NaN）。 */
function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

/** ModelCapabilityEntry.source 的合法取值集合（用于磁盘/patch 双向校验）。 */
const KNOWN_SOURCES = new Set(["catalog", "probe", "healed"]);

/**
 * 校验/清洗任意来源（磁盘文件、mergeEntry 补丁）的一条能力记录。
 *
 * 是「永不报错」承诺的地基之一：这条记录会被 token-estimator.ts 直接当作 contextWindow
 * 使用，一旦放过非法值（Infinity/NaN/负数/非整数），后果不是报错而是**悄悄失效**——
 * auto-compact 永远算不出「超没超」，上下文预算形同虚设。逐字段独立取舍：一个字段非法
 * 不牵连其它字段（例如 contextWindow 是 Infinity 但 maxOutputTokens 合法时，仍保留后者）。
 *
 * ⚠ effortValues 的空数组语义特殊：`[]` 是探针/自愈写入的「已验证不支持 effort」的
 * 强信号（见 probeModelCapability 的 200 分支），必须原样保留，不能等同于「无数据」。
 * 只有数组内容**全部**不是合法档位词时才判定为损坏并丢弃整个字段——不能把「损坏」
 * 误读成「确认不支持」，那会让一个本来支持 effort 的模型被永久打上不支持的标签。
 *
 * @returns 全部字段都不合法时返回 null（这条记录没有任何可用信息，等同于没有）。
 */
function sanitizeEntry(raw: unknown): ModelCapabilityEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: ModelCapabilityEntry = {};

  if (isPositiveInt(r.contextWindow)) out.contextWindow = r.contextWindow;
  if (isPositiveInt(r.maxOutputTokens)) out.maxOutputTokens = r.maxOutputTokens;

  if (Array.isArray(r.effortValues)) {
    if (r.effortValues.length === 0) {
      out.effortValues = []; // 保留「已验证不支持」信号，不因过滤为空而丢弃
    } else {
      const words = (r.effortValues as unknown[]).filter(
        (w): w is string =>
          typeof w === "string" &&
          (KNOWN_EFFORT_WORDS as readonly string[]).includes(w.toLowerCase()),
      );
      // 过滤后非空才采信；全是垃圾内容 → 判定损坏，整字段丢弃（不当成「确认不支持」）。
      if (words.length > 0) {
        const set = new Set(words.map((w) => w.toLowerCase()));
        out.effortValues = KNOWN_EFFORT_WORDS.filter((w) => set.has(w));
      }
    }
  }

  if (typeof r.supportsReasoning === "boolean") out.supportsReasoning = r.supportsReasoning;
  if (typeof r.source === "string" && KNOWN_SOURCES.has(r.source)) {
    out.source = r.source as ModelCapabilityEntry["source"];
  }
  if (typeof r.fetchedAt === "number" && Number.isFinite(r.fetchedAt) && r.fetchedAt > 0) {
    out.fetchedAt = r.fetchedAt;
  }

  return Object.keys(out).length === 0 ? null : out;
}

// ─────────────────────────────────────────────────────────────
// 数据源 1：外部目录同步（多源投票）
// ─────────────────────────────────────────────────────────────

/** litellm 单条（仅声明消费字段）。 */
interface LitellmEntry {
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
  max_tokens?: unknown;
  supports_reasoning?: unknown;
  mode?: unknown;
}

/** 解析 litellm 目录：`{ "<model>": {...} }` 扁平字典。 */
function parseLitellm(raw: unknown): Record<string, ModelCapabilityEntry> {
  const out: Record<string, ModelCapabilityEntry> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as LitellmEntry;
    // 只收对话类模型（embedding/rerank/image 的窗口语义不同，混入会误导 compact 阈值）。
    if (e.mode !== undefined && e.mode !== "chat" && e.mode !== "responses") continue;
    const cw = pickInt(e.max_input_tokens) ?? pickInt(e.max_tokens);
    const out2 = pickInt(e.max_output_tokens);
    if (cw === undefined && out2 === undefined) continue;
    const entry: ModelCapabilityEntry = { source: "catalog" };
    if (cw !== undefined) entry.contextWindow = cw;
    if (out2 !== undefined) entry.maxOutputTokens = out2;
    if (typeof e.supports_reasoning === "boolean") entry.supportsReasoning = e.supports_reasoning;
    out[name.toLowerCase()] = entry;
  }
  return out;
}

/** OpenRouter 单条（仅声明消费字段）。 */
interface OpenRouterEntry {
  id?: unknown;
  context_length?: unknown;
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
  reasoning?: { supported_efforts?: unknown; default_effort?: unknown };
  supported_parameters?: unknown;
}

/** 解析 OpenRouter 目录：`{ data: [...] }`。它额外提供 effort 档位——外部源里唯一有此字段的。 */
function parseOpenRouter(raw: unknown): Record<string, ModelCapabilityEntry> {
  const out: Record<string, ModelCapabilityEntry> = {};
  const items = (raw as { data?: unknown })?.data;
  if (!Array.isArray(items)) return out;
  for (const it of items as OpenRouterEntry[]) {
    if (!it || typeof it !== "object" || typeof it.id !== "string") continue;
    const cw = pickInt(it.top_provider?.context_length) ?? pickInt(it.context_length);
    const mo = pickInt(it.top_provider?.max_completion_tokens);
    const efforts = sanitizeEffortWords(it.reasoning?.supported_efforts);
    if (cw === undefined && mo === undefined && !efforts) continue;
    const entry: ModelCapabilityEntry = { source: "catalog" };
    if (cw !== undefined) entry.contextWindow = cw;
    if (mo !== undefined) entry.maxOutputTokens = mo;
    if (efforts) entry.effortValues = efforts;
    if (Array.isArray(it.supported_parameters)) {
      entry.supportsReasoning = (it.supported_parameters as unknown[]).includes("reasoning");
    }
    // 同时登记全名与尾段（"deepseek/deepseek-v4" → 也按 "deepseek-v4" 可查）。
    const id = it.id.toLowerCase();
    out[id] = entry;
    const tail = id.slice(id.lastIndexOf("/") + 1);
    if (tail && !(tail in out)) out[tail] = entry;
  }
  return out;
}

function pickInt(v: unknown): number | undefined {
  return isPositiveInt(v) ? v : undefined;
}

/** 从任意值里过滤出合法 effort 档位词（顺序按标度归一）。非数组/无合法词 → undefined。 */
function sanitizeEffortWords(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const set = new Set<string>();
  for (const x of v) {
    if (
      typeof x === "string" &&
      (KNOWN_EFFORT_WORDS as readonly string[]).includes(x.toLowerCase())
    ) {
      set.add(x.toLowerCase());
    }
  }
  if (set.size === 0) return undefined;
  return KNOWN_EFFORT_WORDS.filter((w) => set.has(w));
}

/** 依据失败次数算退避间隔（指数，封顶 24h）。 */
export function computeCatalogBackoffMs(failCount: number): number {
  if (failCount <= 0) return 0;
  const ms = FAIL_BACKOFF_BASE_MS * 2 ** (failCount - 1);
  return Math.min(ms, FAIL_BACKOFF_MAX_MS);
}

/** 是否该同步外部目录（TTL 过期或从未同步；失败则按退避冷却）。 */
export function shouldSyncCatalogs(now = Date.now()): boolean {
  if (memModels === null) loadCapabilityCache();
  const syncedAt = memMeta.syncedAt;
  if (!syncedAt) return true;
  const fails = memMeta.failCount ?? 0;
  const wait = fails > 0 ? computeCatalogBackoffMs(fails) : resolveCatalogTtlMs();
  return now - syncedAt >= wait;
}

/**
 * 同步外部模型目录 → 合并进能力缓存。
 *
 * 多源投票：两源都有该模型时，取**更保守的 contextWindow**（min）与**更大的
 * maxOutputTokens**（max）。理由不对称——窗口高估会直接吃 400（实测 deepseek-v4-pro
 * 两源打架：litellm 1M vs OpenRouter 1.048M），输出上限低估只是白白限制生成长度。
 *
 * @returns 采集统计。任何源失败都不抛异常（记退避后返回）。
 */
export async function syncExternalCatalogs(opts?: {
  timeoutMs?: number;
  now?: number;
}): Promise<{ updated: number; sources: string[]; failed: string[] }> {
  if (memModels === null) loadCapabilityCache();
  const timeoutMs = opts?.timeoutMs ?? resolveSideCallTimeouts().gatewayPricingMs;
  const now = opts?.now ?? Date.now();

  const merged: Record<string, ModelCapabilityEntry> = {};
  const okSources: string[] = [];
  const failed: string[] = [];

  for (const src of CATALOG_SOURCES) {
    const parsed = await fetchCatalog(src.url, src.parse, timeoutMs);
    if (!parsed) {
      failed.push(src.name);
      continue;
    }
    okSources.push(src.name);
    for (const [name, entry] of Object.entries(parsed)) {
      const prev = merged[name];
      merged[name] = prev ? voteMerge(prev, entry) : entry;
    }
  }

  if (okSources.length === 0) {
    // 全部失败：记退避，保留旧缓存（能力查询继续用上次的数据）。
    memMeta.failCount = (memMeta.failCount ?? 0) + 1;
    memMeta.syncedAt = now;
    persist();
    log().debug(
      "MODEL-CAP",
      `外部目录同步全部失败，退避 ${computeCatalogBackoffMs(memMeta.failCount)}ms`,
    );
    return { updated: 0, sources: [], failed };
  }

  for (const [name, entry] of Object.entries(merged)) {
    mergeEntry(name, { ...entry, fetchedAt: now });
  }
  memMeta.failCount = 0;
  memMeta.syncedAt = now;
  persist();
  log().debug(
    "MODEL-CAP",
    `外部目录同步完成：${Object.keys(merged).length} 条 / 源 ${okSources.join("+")}`,
  );
  return { updated: Object.keys(merged).length, sources: okSources, failed };
}

/** 两源投票合并：窗口取小（保守），输出上限取大，effort 档位取已有的（OpenRouter 独有）。 */
function voteMerge(a: ModelCapabilityEntry, b: ModelCapabilityEntry): ModelCapabilityEntry {
  const out: ModelCapabilityEntry = { ...a };
  if (isPositiveInt(b.contextWindow)) {
    out.contextWindow = isPositiveInt(a.contextWindow)
      ? Math.min(a.contextWindow, b.contextWindow)
      : b.contextWindow;
  }
  if (isPositiveInt(b.maxOutputTokens)) {
    out.maxOutputTokens = isPositiveInt(a.maxOutputTokens)
      ? Math.max(a.maxOutputTokens, b.maxOutputTokens)
      : b.maxOutputTokens;
  }
  if (b.effortValues && !a.effortValues) out.effortValues = b.effortValues;
  if (typeof b.supportsReasoning === "boolean" && typeof a.supportsReasoning !== "boolean") {
    out.supportsReasoning = b.supportsReasoning;
  }
  return out;
}

/** 拉取并解析单个目录源。任何失败（网络/超时/非 JSON/schema 异常）返回 null。 */
async function fetchCatalog(
  url: string,
  parse: (raw: unknown) => Record<string, ModelCapabilityEntry>,
  timeoutMs: number,
): Promise<Record<string, ModelCapabilityEntry> | null> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ctl.signal,
    });
    if (!resp.ok) {
      log().debug("MODEL-CAP", `目录源 HTTP ${resp.status}`, { url });
      return null;
    }
    const parsedJson = (await resp.json()) as unknown;
    const out = parse(parsedJson);
    return Object.keys(out).length > 0 ? out : null;
  } catch (e) {
    // 与 gateway-pricing 同理：这是纯优化项，失败对用户不可行动 → debug 级，不惊扰终端。
    log().debug("MODEL-CAP", timedOut ? `目录源超时 ${timeoutMs}ms` : `目录源失败: ${String(e)}`, {
      url,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────
// 数据源 2：运行时探针（服务端自报）
// ─────────────────────────────────────────────────────────────

/**
 * 从错误文本里抽取服务端自报的 effort 档位。
 *
 * 不做任何模型名/供应商判断——纯文本解析，天然适配任意新模型与任意网关措辞。
 * 实测覆盖的措辞（同一网关下四种不同后端）：
 *   OpenAI  : "Invalid value: '__X__'. Supported values are: 'none', 'low', ..., and 'xhigh'."
 *   DeepSeek: "'reasoning_effort' must be one of: 'low', 'medium', 'high', 'xhigh', 'max'"
 *   GLM     : "reasoning_effort 参数值非法，可选值为：none、minimal、low、medium、high、xhigh、max"
 *   Qwen    : "'reasoning_effort' must be one of: 'none', 'minimal', 'low', ..."
 *
 * 为避免把错误文本里的无关词误当档位，只接受 KNOWN_EFFORT_WORDS 白名单内的词，
 * 且要求命中 ≥2 个（单个词极可能是把用户传入的非法值本身回显了）。
 */
export function extractEffortValuesFromError(message: string): string[] | null {
  if (!message) return null;
  const lower = message.toLowerCase();
  const found = new Set<string>();
  for (const w of KNOWN_EFFORT_WORDS) {
    // 词边界匹配：避免 "none" 命中 "nonexistent"、"max" 命中 "max_tokens"。
    if (new RegExp(`(?<![a-z_])${w}(?![a-z_])`).test(lower)) found.add(w);
  }
  if (found.size < 2) return null;
  return KNOWN_EFFORT_WORDS.filter((w) => found.has(w));
}

/**
 * 从错误文本里抽取 maxOutputTokens 上限。
 *
 * 实测措辞（廉价——只需一次 16-token 请求即可触发）：
 *   Qwen: "Range of max_tokens should be [1, 131072]"
 *   GLM : "max_tokens参数非法：限制数值范围[1,131072]"
 *
 * ⚠ 对照：contextWindow **无法**这样廉价拿到——实测 150k payload 三个模型全部 200，
 * 服务端不主动吐窗口上限，真超限时也只说 "input exceeds the context window" 不带数字。
 * 故窗口只能靠外部目录 + learnFromError 自愈，不做主动探测（二分成本与收益不成比例）。
 */
export function extractMaxTokensFromError(message: string): number | null {
  if (!message) return null;
  // 匹配 [1, 131072] / [1,131072] 形式的区间上界。
  const m = message.match(/\[\s*\d+\s*,\s*(\d{3,9})\s*\]/);
  if (!m) return null;
  const v = Number(m[1]);
  return isPositiveInt(v) ? v : null;
}

/**
 * 主动探针：发一个极小的非法-effort 请求，从响应里学习该模型的 effort 能力与输出上限。
 *
 * 设计要点：
 * - **两种结果都有用**：400 且能抽出档位 → 记录档位；200（服务端不校验该字段）→ 记录
 *   `effortValues: []`，即「明确不支持 effort」。都不是失败。
 * - 请求极小（max_tokens=16，一句 "hi"），成本可忽略；且用非法值保证不会真的产生长输出。
 * - 不认识的响应形态一律返回 null（不写缓存），留给自愈路径后续学习。
 *
 * @param send 由调用方注入的最小 HTTP 发送器（便于测试替换，也避免本模块依赖 provider）
 */
export async function probeModelCapability(opts: {
  model: string;
  send: (body: Record<string, unknown>) => Promise<{ ok: boolean; errorMessage?: string }>;
}): Promise<ModelCapabilityEntry | null> {
  const { model, send } = opts;
  const PROBE_SENTINEL = "__sid_code_probe__";
  let resp: { ok: boolean; errorMessage?: string };
  try {
    resp = await send({
      model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
      reasoning_effort: PROBE_SENTINEL,
    });
  } catch (e) {
    log().debug("MODEL-CAP", `探针请求失败: ${String(e)}`, { model });
    return null;
  }

  const patch: ModelCapabilityEntry = { source: "probe", fetchedAt: Date.now() };

  if (resp.ok) {
    // 200：服务端接受了非法值 → 它压根不校验 reasoning_effort → 该模型无 effort 能力。
    patch.effortValues = [];
    patch.supportsReasoning = false;
    mergeEntry(model, patch);
    persist();
    return patch;
  }

  const msg = resp.errorMessage ?? "";
  const efforts = extractEffortValuesFromError(msg);
  const maxOut = extractMaxTokensFromError(msg);
  if (!efforts && maxOut === null) return null; // 无法解读 → 不猜，交给自愈

  if (efforts) {
    patch.effortValues = efforts;
    patch.supportsReasoning = true;
  }
  if (maxOut !== null) patch.maxOutputTokens = maxOut;
  mergeEntry(model, patch);
  persist();
  return patch;
}

// ─────────────────────────────────────────────────────────────
// 数据源 3：自愈学习
// ─────────────────────────────────────────────────────────────

/**
 * 判断一条错误是否「值得剥掉 effort 字段重试」——**不看措辞，只看结构**。
 *
 * 为什么必须有这一层（2026-08-01）：`learnFromError` 靠文本特征识别 effort 相关错误，
 * 而我们现在会对未知协议族**主动多发** `reasoning_effort`（见 openai.ts 的
 * isUnknownFamily 分支）。两者相乘出一个新风险：措辞没匹配上 → 不自愈 → 用户看到一个
 * **修复前根本不存在**的 400。实测 11 种真实措辞里有 5 种匹配不上：
 *   - `Extra inputs are not permitted [type=extra_forbidden]`（vLLM / pydantic 兼容层）
 *   - `Invalid request body` / `One or more parameters are invalid`（不含字段名）
 *   - `400 Bad Request`（网关透传截断，正文全丢）
 *   - `参数错误：不支持的参数`（中文网关，不含字段名）
 * 「猜错了要能兜住」是这套乐观放行机制成立的前提，而靠穷举措辞永远兜不住——
 * 下一个网关的下一种文案又会漏。
 *
 * 结构判据：**HTTP 4xx（客户端错误，即"你发的东西不对"）+ 我们确实发了该字段**。
 * 剥掉一个纯优化字段重试一次的代价极低（一次额外请求），而漏判的代价是功能不可用。
 *
 * 刻意排除：
 * - 5xx / 无状态码（网络中断、超时）——不是"我们发的东西不对"，重试无意义且会掩盖真故障。
 * - 401/403/404/429——语义明确且与请求体无关（鉴权/限流/模型不存在），剥字段纯属浪费一次请求。
 * - 上下文超限（413 或文本命中 isPromptTooLong）——真因是历史太长，该走压缩而非剥字段。
 */
export function shouldRetryWithoutEffort(opts: {
  /** HTTP 状态码。取不到就传 undefined——此时只在文本明确提到 effort 字段时才自愈。 */
  statusCode?: number;
  /** 服务端错误文本（可能为空，如网关只透传了 "400 Bad Request"）。 */
  errorMessage?: string;
}): boolean {
  const msg = opts.errorMessage ?? "";

  // 文本明确提到 effort 字段 → 无论状态码都自愈（覆盖网关未透传状态码的情形）。
  if (/reasoning_effort|reasoning\.effort/i.test(msg)) return true;

  // 上下文超限走压缩，不是能力误判。
  if (isPromptTooLong(msg)) return false;

  const code = opts.statusCode;
  if (code === undefined) return false; // 无状态码 + 无字段名 → 证据不足，不猜
  if (code === 401 || code === 403 || code === 404 || code === 429 || code === 413) return false;
  return code >= 400 && code < 500;
}

/**
 * 记下「该模型不接受 `reasoning_effort`」—— 剥字段重试**成功之后**调用。
 *
 * 为什么必需：`shouldRetryWithoutEffort` 的结构兜底不看措辞，因此也**学不到任何东西**
 * （措辞里没有档位列表可抽）。若只重试不记账，就会退化成「每次对话都先撞一次 400 再重试」——
 * 永久 2 倍请求数、2 倍首字延迟。自愈的承诺是「首次可能多一跳，之后就准了」，
 * 记账是「之后就准了」这半句的全部实现。
 *
 * 写 `effortValues: []` 而非删条目：空数组是「服务端明确不校验/不接受该字段」的既有语义
 * （见 probeModelCapability 的 200 分支），`effort.ts::resolveFromCapabilityCache` 读到空数组
 * 就会走 unknown 档、不再下发字段——正是我们想要的下一次行为。
 *
 * ⚠ 只在重试**成功**后调用。若剥掉 effort 仍失败，说明真因不是这个字段，
 * 记账就会冤枉它：那个模型可能明明支持 effort，却被永久标记为不支持。
 */
export function recordEffortRejected(model: string): void {
  // 已有非空档位列表（来自用户配置/目录/探针的可信数据）→ 不覆盖。
  // 那种情况下的 400 更可能是「我们发的那一档不在列表里」，而非「完全不支持」，
  // 抹成 [] 会把一个支持 effort 的模型永久降级。
  const existing = lookupCapability(model);
  if (existing?.effortValues && existing.effortValues.length > 0) return;

  mergeEntry(model, {
    effortValues: [],
    supportsReasoning: false,
    source: "healed",
    fetchedAt: Date.now(),
  });
  persist();
  log().debug("MODEL-CAP", `自愈记账：${model} 不接受 reasoning_effort，后续不再下发`);
}

/** 自愈动作建议——调用方据此决定「剥掉哪个字段重试」。 */
export interface HealAdvice {
  /**
   * 是否应剥掉 effort 字段后重试（该模型不接受我们发的档位）。
   *
   * ⚠ 这是**基于措辞**的判定，只在错误文本明确提到 `reasoning_effort` 时为 true。
   * 执行层不要只依赖它——措辞匹配必然有漏网（详见 shouldRetryWithoutEffort），
   * 请把两者**或**起来用：`advice.dropEffort || shouldRetryWithoutEffort({...})`。
   */
  dropEffort?: boolean;
  /** 是否是上下文超限（调用方应压缩上下文而非重试原请求）。 */
  contextExceeded?: boolean;
  /** 学到的新能力（已写入缓存）。 */
  learned?: ModelCapabilityEntry;
}

/**
 * 从真实请求的错误里学习并给出自愈建议 —— 「永不报错」的最后一道保障。
 *
 * 三类可自愈错误（判据全为文本特征，无模型名硬编码）：
 * 1. effort 值不被接受 → 记录服务端自报档位（若有），建议剥掉字段重试。
 *    这覆盖「探针拿到的是网关并集、模型级更严」的两级校验差异（实测 luna：
 *    字段级含 minimal，模型级拒 minimal）。
 * 2. max_tokens 超限 → 记录真实上限。
 * 3. 上下文超限 → 标记 contextExceeded，让调用方走压缩而不是盲目重试。
 *
 * @param model 出错的模型名
 * @param errorMessage 服务端返回的错误文本
 */
export function learnFromError(model: string, errorMessage: string): HealAdvice {
  const advice: HealAdvice = {};
  if (!errorMessage) return advice;

  // ── 1. effort 相关（字段名出现即认定与 effort 有关，不看模型名） ──
  const mentionsEffort = /reasoning_effort|reasoning\.effort/i.test(errorMessage);
  if (mentionsEffort) {
    advice.dropEffort = true;
    const efforts = extractEffortValuesFromError(errorMessage);
    if (efforts) {
      const patch: ModelCapabilityEntry = {
        effortValues: efforts,
        supportsReasoning: true,
        source: "healed",
        fetchedAt: Date.now(),
      };
      mergeEntry(model, patch);
      persist();
      advice.learned = patch;
      log().debug("MODEL-CAP", `自愈：${model} effort 档位学习为 [${efforts.join(",")}]`);
    }
  }

  // ── 2. max_tokens 上限 ──
  const maxOut = extractMaxTokensFromError(errorMessage);
  if (maxOut !== null && /max_tokens|max_output_tokens|max_completion_tokens/i.test(errorMessage)) {
    const patch: ModelCapabilityEntry = {
      maxOutputTokens: maxOut,
      source: "healed",
      fetchedAt: Date.now(),
    };
    mergeEntry(model, patch);
    persist();
    advice.learned = { ...(advice.learned ?? {}), ...patch };
    log().debug("MODEL-CAP", `自愈：${model} maxOutputTokens 学习为 ${maxOut}`);
  }

  // ── 3. 上下文超限 ──
  // 委托到 api/errors.ts::isPromptTooLong（全仓唯一事实源），不在此重复维护 pattern 列表。
  // 措辞跨供应商差异极大且无稳定错误码，三份各自维护的列表必然漂移——已出过事故，详见该处注释。
  if (isPromptTooLong(errorMessage)) {
    advice.contextExceeded = true;
  }

  return advice;
}

// ─────────────────────────────────────────────────────────────
// 测试辅助
// ─────────────────────────────────────────────────────────────

/**
 * 重置内存态（仅测试用）。
 *
 * 同时**永久关闭本进程的写盘**——测试进程绝不允许改用户真实缓存文件。
 * 见 persistDisabled 的事故说明（曾把 2919 条真实数据抹成 1 条）。
 */
export function __resetCapabilityCacheForTest(seed?: Record<string, ModelCapabilityEntry>): void {
  persistDisabled = true;
  memModels = seed ? { ...seed } : {};
  memMeta = {};
}

/** 读当前内存态（仅测试/诊断用）。 */
export function __getCapabilityCacheForTest(): Record<string, ModelCapabilityEntry> {
  return { ...(memModels ?? {}) };
}

/**
 * 暴露 sanitizeEntry（仅测试用）。
 *
 * loadCapabilityCache 直接读取真实磁盘路径 `~/.sid-code/model-capabilities.json`，
 * 没有可注入的测试路径——这正是当初 Infinity 校验漏洞能潜伏的部分原因（不方便测，
 * 于是没测）。sanitizeEntry 是 loadCapabilityCache 与 mergeEntry 共用的校验核心，
 * 直接测这个纯函数即可覆盖两条路径，且不需要碰任何文件。
 */
export function __sanitizeEntryForTest(raw: unknown): ModelCapabilityEntry | null {
  return sanitizeEntry(raw);
}
