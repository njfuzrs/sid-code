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
 * 1. **外部目录同步**（syncExternalCatalogs）：models.dev 双镜像 + litellm + OpenRouter，
 *    多源**众数**投票（见 voteTokenLimit —— 曾经取 min，方向是反的，2026-08-18 实测推翻）。
 *
 *    覆盖率（2026-08-20 实测，**复现见 `bun run scripts/catalog-coverage.ts`**）：
 *    分母 = `~/.sid-code/gateway-pricing.json` 跨端点桶去重的网关模型数 135（对话模型 113）。
 *      litellm 89 / OpenRouter 67 / 两者并集 94（83.2%）/ 三源并集 105（**92.9%**，对话模型口径）。
 *      三源 + 归一化后仍查不到的真实缺口只剩 8 个，全是厂商变体后缀（-maxthink / -wot /
 *      -thinking / -lite / -turbo / -preview / -non-thinking），能力可能真的不同，
 *      刻意不靠剥后缀去借基础名的窗口（会高估），交给 400 自愈。
 *    ⚠ 声称实测的数字必须带日期与复现方式：上一版注释写死的「127 个中 93 个（73%）」在网关
 *    新上模型后分母失真，却让「选源没问题」这个判断多躺了很久没被复查 —— 一行让人放心的
 *    过期注释比没有注释更糟。
 *
 *    ⚠ 国内可达性是选源的硬约束，但**它只保证「能拿到数据」，不保证「数据里有你要的模型」**——
 *    选源必须同时考「对国内厂商的收录率」。litellm/OpenRouter 对智谱/字节/阿里系统性偏弱
 *    （glm-5.3 与 5 个 doubao 只有 models.dev 有），而企业网关恰好大量代理国内模型。
 *    详见 CATALOG_SOURCES 各源注释。
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
// 「写哪些键」与「查哪些键」的唯一事实源（互为镜像，对称性由单测锁住）
import { expandKeys, normalizeCandidates } from "./model-name-normalize.ts";
import { IS_DEV_MODE } from "../bootstrap/resolve-executable.ts";

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
  /**
   * 窗口投票分布：`"<窗口值>" → 该值被报了几次`。**只为可复算而存在**（北极星「可观测」）。
   *
   * 没有它就看不出一个窗口是怎么投出来的——而众数投票恰恰是本模块最容易被「以保守为直觉」
   * 改错的地方（曾经取 min，系统性低估，最坏 30.5 倍，潜伏很久没人发现）。排障时有这张分布，
   * 「这个值是众数还是无众数取的 max」一眼可判。
   *
   * 刻意存「值 → 次数」而不是「源 → 该源报的每个值」：后者对 glm-5.2 这类模型要存 68 个数字，
   * 乘上数千条目会让缓存文件膨胀数倍；而次数分布已经是投票函数的**全部输入**，足够复算。
   * 参与投票的源名另记在 voteSources。
   */
  contextWindowVotes?: Record<string, number>;
  /** 本条窗口投票的参与源名（去重，按 CATALOG_SOURCES 顺序）。与 contextWindowVotes 配对使用。 */
  voteSources?: string[];
}

interface CapabilityCacheFile {
  schema_version: number;
  /** 按模型名单键（能力是模型固有属性，不按端点分桶——与价格缓存的关键差异）。 */
  models: Record<string, ModelCapabilityEntry>;
  /** 外部目录上次同步时间（成功/失败都记，用于 TTL 与退避）。 */
  catalog_synced_at?: number;
  catalog_fail_count?: number;
  /**
   * 各源上次成功响应的 HTTP validator（`{ [源名]: { etag?, lastModified? } }`），用于条件请求。
   *
   * ⚠ 只有**本地确实存有该源解析出来的正文**时才允许下发 validator。304 意味着「你手上那份
   * 还有效」——若我们手上其实没有正文（缓存被删、schema bump 作废、或换了源名），
   * 下发 validator 换回一个 304 就等于把覆盖层变成空的，而且没有任何报错。
   * 判据落在 `catalog_body_present` 上，与本字段配对使用，缺一不可。
   */
  catalog_validators?: Record<string, { etag?: string; lastModified?: string }>;
  /** 上一轮同步中「确实解析出过非空正文」的源名集合。condition 请求的放行判据，见上。 */
  catalog_body_present?: string[];
}

/**
 * 缓存 schema 版本。**不匹配即视为空并重新采集**（见 readCacheFile）。
 *
 * 1 → 2（2026-08-18）：窗口投票规则从 min 改成众数，且条目新增 contextWindowVotes /
 * voteSources。bump 它是**必须的**，不只是为了新字段：磁盘上存量的窗口值全是 min 投出来的
 * 错值（实测 79 个有真值的模型上 min 只对 41.8%，错的 46 个全是低估），不作废就得靠人记得
 * 手删缓存文件才能生效。让版本号把「换了投票规则必须重采」变成机械行为。
 */
const SCHEMA_VERSION = 2;

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
 * - 上游坏数据传播更快：由 sanitizeEntry（拦 Infinity/NaN/非正/非整）+ 多源众数投票
 *   （voteTokenLimit —— 少数源的离群值构不成众数）两道防线兜住，与拉取频率无关。
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

/** 单个目录源的形态。`decompress` 缺省即裸 JSON。 */
interface CatalogSource {
  name: string;
  url: string;
  parse: (raw: unknown) => Record<string, ModelCapabilityEntry[]>;
  decompress?: "zstd";
}

/**
 * 外部模型目录源。顺序即优先级（靠前者在**平局无法用数值决出**时先被记入分布）。
 *
 * ⚠ 这里出现的是**数据源域名**，不是模型名判据——不违反「不按模型名硬编码」原则。
 * 新增模型无需改这里；只有数据源本身失效才需要维护。
 *
 * 选源的两个维度（缺一不可，只看第一个会重复本次的错误）：
 * 1. **国内可达性**：曾有两个候选源因 DNS 不可解析 / 请求超时且无可用 CDN 镜像而实测排除
 *    （不再列具体域名以免被误当候选重试）。新增源前先在国内网络实测直连与镜像两条路径。
 * 2. **对国内厂商的收录率**：可达只保证「能拿到数据」，不保证「数据里有你要的模型」。
 *    实测 litellm/OpenRouter 对智谱/字节/阿里系统性偏弱，漏 glm-5.3 与 5 个 doubao；
 *    国内模型最集中的那个网关端点桶覆盖率只有 61.3%，是全部桶里最低的。
 */
const CATALOG_SOURCES: readonly CatalogSource[] = [
  {
    // models.dev 镜像（主）。
    // ⚠ models.dev **官方域国内不可达**（实测 curl 12s 超时、http=000），但它有两个可达的
    // 第三方出口 —— 当初选源时把整个 models.dev 排除掉，就是因为只测了官方域。
    // 本源是 opencode 自建镜像（裸 JSON，2026-08-20 实测 200 / 4.0MB / 0.69s）。
    //
    // 收录质量显著优于 litellm/OpenRouter：单源覆盖网关模型 75.0%，高于那两者的并集 69.1%，
    // 且对国内厂商收录完整（glm-5.3 与 5 个 doubao 只有这里有）。
    // 还额外提供两个此前采不到的字段：reasoning_options.values（effort 档位 —— 之前只能靠
    // probeEffortValues 发一个非法请求去换）与 interleaved.field（协议层字段名，暂未消费）。
    name: "models-dev-opencode",
    url: "https://models.opencode.ai/api.json",
    parse: parseModelsDev,
  },
  {
    // models.dev 镜像（备）。oh-my-pi 用的出口，zstd 压缩（2026-08-20 实测 140KB vs 4.0MB，
    // 省 28 倍带宽），用 Bun.zstdDecompressSync 解压（Bun 1.3.14 已内置，无需额外依赖）。
    //
    // 与主源实测**逐对完全相等**（192 providers / 6834 models，(provider,model) 对集合相同），
    // 所以它纯粹是故障转移：正常情况下主源成功，这一份的数据只会与主源重复。
    // ⚠ 重复本身无害（同值只会加固众数），但两个源都算进 voteSources 会让「几个源报了这个值」
    // 看起来比实际独立源数多一个 —— 排障读 voteSources 时要知道这两个是同一份上游。
    name: "models-dev-stencil",
    url: "https://catalog.stencil.so/models.json.zstd",
    parse: parseModelsDev,
    decompress: "zstd",
  },
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
];

// ─────────────────────────────────────────────────────────────
// 内存缓存
// ─────────────────────────────────────────────────────────────

let memModels: Record<string, ModelCapabilityEntry> | null = null;
let memMeta: {
  syncedAt?: number;
  failCount?: number;
  validators?: Record<string, { etag?: string; lastModified?: string }>;
  bodyPresent?: string[];
} = {};

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
  if (!file) {
    // 磁盘缓存不存在（首次安装/被清空）：用编译期快照兜底，跳过磁盘那一层的时间戳比较——
    // 没有磁盘数据可比，快照就是当前唯一的数据源。
    applyBuildTimeSnapshot(undefined);
    return;
  }

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
  memMeta = {
    syncedAt: file.catalog_synced_at,
    failCount: file.catalog_fail_count,
    validators: sanitizeValidators(file.catalog_validators),
    bodyPresent: sanitizeSourceNames(file.catalog_body_present),
  };
  log().debug(
    "MODEL-CAP",
    `载入模型能力缓存 ${Object.keys(sanitized).length} 条${dropped > 0 ? `（丢弃 ${dropped} 条非法数据）` : ""}`,
  );

  // 磁盘缓存存在，但快照可能比它更新（用户很久没启动过，或磁盘缓存是旧版本采的）。
  // 传入 catalog_synced_at 供时间戳比较，见 applyBuildTimeSnapshot 头部注释。
  applyBuildTimeSnapshot(file.catalog_synced_at);
}

/**
 * 加载顺序第三层：编译期快照（D4 §5.3）。只填补 `memModels` 里**缺失**的键，
 * 从不覆盖已有条目——这一步发生在磁盘缓存已经载入之后，磁盘数据永远更权威
 * （用户本机真实同步过，比编译时打进二进制的那份更新）。
 *
 * ⚠ 时间戳判定（§5.3 配套事 2，对标 pi 的 localGeneratedAt）：**只有磁盘从未同步过
 * 或快照比磁盘更新时才使用快照**。理由：一个装了很久没升级的二进制，其快照可能
 * 早于用户本机已经采集到的数据；反过来判定（无条件优先快照）会用旧数据覆盖新数据，
 * 这正是 opencode 那套 `loadFromDisk` 无条件优先的弱点，§5.3 明确指出不要照抄。
 *
 * `diskSyncedAt` 为 `undefined` 表示磁盘缓存本身不存在/从未同步过外部目录 ——
 * 此时快照必然「更新」（没有基线可比），直接全量填补。
 */
function applyBuildTimeSnapshot(diskSyncedAt: number | undefined): void {
  if (IS_DEV_MODE) return; // dev 模式没有嵌入的快照，见 model-catalog-snapshot-embedded.ts
  let snapshot: { generatedAt: number; models: Record<string, unknown> } | null = null;
  try {
    // 动态 require：避免 dev 模式静态解析 vendor/model-catalog-snapshot.json（守卫已在
    // 上方拦住 dev）。与 ensure-ripgrep.ts 对 rg-embedded.ts 的引用方式同构。
    const { snapshotPath } = require("./model-catalog-snapshot-embedded.ts") as {
      snapshotPath: string;
    };
    const text = readFileSync(snapshotPath, "utf8");
    if (text.length > 0) snapshot = JSON.parse(text);
  } catch {
    return; // 嵌入缺失/为空/损坏：静默跳过，不影响磁盘缓存 + 联网同步这两层
  }
  mergeSnapshotIntoMemory(snapshot, diskSyncedAt);
}

/**
 * 快照 → 内存的合并逻辑，从 `applyBuildTimeSnapshot` 拆出来是为了**可测**：
 * `IS_DEV_MODE` 在 `bun test` 下恒为 true（跑的是源码，不是编译产物），
 * 意味着 `applyBuildTimeSnapshot` 整个函数体在单测里永远短路 —— 与 rg-embedded 那条
 * 「光跑测试测不出来」的注释是同一个成因。把「判定 + 合并」这个纯逻辑单独拆出来，
 * 单测才能绕开 IS_DEV_MODE 直接喂一份构造的快照验证边界条件（不覆盖磁盘 / 时间戳判定）。
 */
function mergeSnapshotIntoMemory(
  snapshot: { generatedAt: number; models: Record<string, unknown> } | null,
  diskSyncedAt: number | undefined,
): void {
  if (!snapshot || typeof snapshot.generatedAt !== "number" || !snapshot.models) return;
  if (diskSyncedAt !== undefined && snapshot.generatedAt <= diskSyncedAt) return; // 快照不比磁盘新

  const models = memModels ?? (memModels = {});
  let filled = 0;
  for (const [key, raw] of Object.entries(snapshot.models)) {
    if (models[key]) continue; // 磁盘已有这个模型的数据，不覆盖（磁盘更权威）
    const clean = sanitizeEntry({ ...(raw as object), source: "catalog" });
    if (clean) {
      models[key] = clean;
      filled++;
    }
  }
  if (filled > 0) {
    log().debug("MODEL-CAP", `编译期快照补齐 ${filled} 条（磁盘缓存未覆盖的模型）`);
  }
}

/** 仅测试用：绕开 IS_DEV_MODE + require 嵌入文件，直接对内存态应用一份构造的快照。 */
export function __applySnapshotForTest(
  snapshot: { generatedAt: number; models: Record<string, unknown> } | null,
  diskSyncedAt: number | undefined,
): void {
  if (memModels === null) loadCapabilityCache();
  mergeSnapshotIntoMemory(snapshot, diskSyncedAt);
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

/**
 * 落盘（失败静默——缓存是纯优化项）。
 *
 * ⚠ 写盘前**重读一次磁盘并与内存态合并**，因为原子写与丢更新是两件不同的事：
 * 下面的 `tmp → rename` 防的是「半截文件」，**完全不防「丢更新」**。两个 sid-code
 * 进程并存时（用户开两个终端、`sc-dev` 与 `sc` 并存、子代理并发），后写的那个会把
 * 前一个刚采到的条目整份覆盖掉——而轨迹上看两边采集都成功了，于是「明明采到了却
 * 没生效」变成一个查不出来的问题（方案 §6.2 / D7）。
 *
 * 刻意不引 flock / proper-lockfile（opencode 的 models-dev.ts 走的是跨进程锁这条路）：
 * 能力缓存是纯优化项，为它加一个跨进程锁依赖，代价大于乐观合并残留的那点风险。
 * 乐观合并的残余窗口只有「重读 → rename」之间（微秒级），且真撞上的后果仅是
 * 下次 TTL 到期重采一遍，不会产生错数字。
 */
function persist(): void {
  if (persistDisabled) return; // 测试态：绝不碰用户真实文件
  try {
    const path = sidPaths.modelCapabilities();
    mkdirSync(dirname(path), { recursive: true });

    // ── per-model 合并：以磁盘为底，本进程内存态覆盖上去 ──
    // 方向的理由：内存态 = 「启动时读到的磁盘内容」∪「本进程新采到的」，所以对同一个
    // 键它不可能比磁盘旧；而磁盘上多出来的键只能是别的进程在我们载入之后采的，本进程
    // 对它一无所知，直接采纳。反方向（磁盘盖内存）会把本次刚采到的结果原地扔掉。
    const disk = readCacheFile(); // schema 不匹配时返回 null → 退化成整份覆盖，符合预期
    const models: Record<string, ModelCapabilityEntry> = {};
    const memKeys = new Set(Object.keys(memModels ?? {}));
    // 条目数护栏：不设上限的话，一个被篡改成异常大的磁盘文件会被我们合并后又写回去、
    // 从此自我延续（原来的整份覆盖反而能「治好」它）。只砍磁盘独有键，本进程确实采到
    // 的键一个不丢。
    let diskBudget = Math.max(0, MAX_CACHE_ENTRIES - memKeys.size);
    for (const [key, raw] of Object.entries(disk?.models ?? {})) {
      const isNewKey = !memKeys.has(key);
      if (isNewKey && diskBudget <= 0) continue;
      // 磁盘一律视为不可信（可能被手工改坏、被旧版本写入、被外部工具篡改），走与
      // loadCapabilityCache 同源的校验——不校验就等于把 Infinity 这类毒数据原样再写回一遍。
      const clean = sanitizeEntry(raw);
      if (!clean) continue;
      if (isNewKey) diskBudget--;
      models[key] = clean;
    }
    for (const [key, mine] of Object.entries(memModels ?? {})) {
      // 逐字段覆盖而非整条替换：磁盘那条可能带着本进程没采到的字段（别的进程探针/自愈
      // 学到的），保留它不会丢失任何本进程已知的信息。
      // 显式 undefined 必须跳过——`{...disk, ...mem}` 会让 mem 里一个显式 undefined
      // 击穿磁盘上的真实值（把「未知」当成了「已知为空」）。
      const merged: Record<string, unknown> = { ...(models[key] ?? {}) };
      // ⚠ 投票诊断字段是逐字段合并的一个例外：它描述「这一次同步的投票现场」，与同一条里的
      // contextWindow 是**一体的**。若磁盘上留着别的进程上一轮的分布、而本进程这轮投出了新窗口，
      // 逐字段合并会拼出一份分布与窗口对不上的记录 —— 排障的人对着它做判断会得出错结论。
      // 本进程有窗口时，分布只以本进程的为准（没有就抹掉，不留旧的）。
      if (mine.contextWindow !== undefined) {
        delete merged.contextWindowVotes;
        delete merged.voteSources;
      }
      for (const [field, value] of Object.entries(mine)) {
        if (value !== undefined) merged[field] = value;
      }
      models[key] = merged as ModelCapabilityEntry;
    }

    // ── 元数据字段不能逐字段合并 ──
    // catalog_synced_at / catalog_fail_count 不是 per-model 的，两者共同描述**同一个
    // 事件**：「上一次外部目录同步发生在何时、结果如何」。各自取 max/min 会拼出一个
    // 从未发生过的事件——拿我们的失败时刻配上磁盘的 failCount=0，就成了「T 时刻同步
    // 成功」，于是退避被取消、TTL 又从 T 重新起算，最坏把采集抑制整整一天。
    // 故按 catalog_synced_at 谁新取谁**整对**（平局或磁盘无值时用内存态）。这个方向的
    // 失败模式也更安全：多退避一次的代价只是 30min 后多发一次 fire-and-forget 请求。
    const diskAt = disk?.catalog_synced_at;
    const useDiskMeta =
      typeof diskAt === "number" &&
      Number.isFinite(diskAt) &&
      (memMeta.syncedAt === undefined || diskAt > memMeta.syncedAt);

    // validator 与 bodyPresent 跟着 catalog_synced_at 那一对整体走，理由同上：它们描述的也是
    // 「上一次同步这个事件」。把我们的 validator 配上别人的 syncedAt，会让下一轮拿一个过期
    // validator 去请求，换回 304 之后以为「还有效」——而本地那份正文其实来自另一次同步。
    const file: CapabilityCacheFile = {
      schema_version: SCHEMA_VERSION,
      models,
      catalog_synced_at: useDiskMeta ? diskAt : memMeta.syncedAt,
      catalog_fail_count: useDiskMeta ? disk?.catalog_fail_count : memMeta.failCount,
      catalog_validators: useDiskMeta ? disk?.catalog_validators : memMeta.validators,
      catalog_body_present: useDiskMeta ? disk?.catalog_body_present : memMeta.bodyPresent,
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
 * 归一化匹配委托给 model-name-normalize.ts 的 `normalizeCandidates`（与采集侧的
 * `expandKeys` 互为镜像，对称性由单测锁住）：
 *   精确 → 剥 vendor 路径前缀（kimi/xxx）→ 剥渠道前缀（ali-/tx-/volc-…）→ 剥日期后缀。
 *
 * 与 model-registry 的匹配策略同构，但**不做**模糊前缀匹配（避免把 gpt-5.4-mini 的
 * 400K 窗口糊给 gpt-5.4 那种跨档误配——缓存条目来自第三方，精度不如手工注册表）。
 * 日期后缀剥离不属于模糊前缀匹配：`deepseek-v3-250324` 与 `deepseek-v3` 是同一模型的
 * 两个发布批次，不是两个档位的不同模型。
 */
export function lookupCapability(model: string): ModelCapabilityEntry | null {
  if (memModels === null) loadCapabilityCache();
  const models = memModels ?? {};
  for (const key of normalizeCandidates(model)) {
    const hit = models[key];
    if (hit) return hit;
  }
  // miss：异步补一次目录同步（异步 + 防抖 + 尊重失败退避，见 maybeTriggerMissRefresh）。
  // 本次查询仍走调用方的兜底，不因这次 miss 而阻塞或改变返回值。
  maybeTriggerMissRefresh(Date.now());
  return null;
}

/** 合并一条能力记录进缓存（逐字段合并——新数据不得把已知字段覆盖成 undefined）。 */
function mergeEntry(model: string, patch: ModelCapabilityEntry): void {
  if (memModels === null) loadCapabilityCache();
  const key = model.trim().toLowerCase();
  if (!key) return;
  const clean = sanitizeEntry(patch);
  if (!clean) return; // patch 全部字段都非法 → 无新信息，不动缓存
  const prev = (memModels ??= {})[key] ?? {};
  // 投票诊断字段是「上一次目录同步的投票现场」，一次采集一整份，不能逐字段沉淀 ——
  // 否则上游改了数据、这轮只投出一个值时，旧的分布会留在条目里，排障的人看到的是一份
  // 与当前 contextWindow 对不上的分布。所以 catalog 来源的 patch 先清掉旧的诊断字段。
  const base: ModelCapabilityEntry = { ...prev };
  if (clean.source === "catalog") {
    delete base.contextWindowVotes;
    delete base.voteSources;
  }
  const next: ModelCapabilityEntry = { ...base, ...clean };
  next.fetchedAt = clean.fetchedAt ?? Date.now();
  memModels[key] = next;
}

/**
 * 校验磁盘上的 validator 表。
 *
 * validator 会被原样塞进出网请求头，所以它是**磁盘 → 请求头**的一条数据通路，必须当不可信
 * 输入处理：长度封顶、剔掉含 CR/LF 的值（否则一个被手工改坏的缓存文件能做请求头注入）。
 */
function sanitizeValidators(
  raw: unknown,
): Record<string, { etag?: string; lastModified?: string }> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, { etag?: string; lastModified?: string }> = {};
  const okHeader = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\r\n]/.test(v);
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!name || name.length > 64 || !v || typeof v !== "object") continue;
    const r = v as { etag?: unknown; lastModified?: unknown };
    const one: { etag?: string; lastModified?: string } = {};
    if (okHeader(r.etag)) one.etag = r.etag;
    if (okHeader(r.lastModified)) one.lastModified = r.lastModified;
    if (one.etag || one.lastModified) out[name] = one;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 校验源名列表（磁盘不可信；只做长度与类型约束）。 */
function sanitizeSourceNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names = (raw as unknown[]).filter(
    (s): s is string => typeof s === "string" && s.length > 0 && s.length <= 64,
  );
  return names.length > 0 ? [...new Set(names)] : undefined;
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

  // 投票分布是纯诊断字段，但仍走同样的严格校验：它会被渲染给人看，一个 NaN 键或负计数
  // 会让排障的人对着一份自相矛盾的分布做判断，比没有分布更糟。
  if (r.contextWindowVotes && typeof r.contextWindowVotes === "object") {
    const votes: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.contextWindowVotes as Record<string, unknown>)) {
      if (isPositiveInt(Number(k)) && isPositiveInt(v)) votes[k] = v;
    }
    if (Object.keys(votes).length > 0) out.contextWindowVotes = votes;
  }
  if (Array.isArray(r.voteSources)) {
    const names = (r.voteSources as unknown[]).filter(
      (s): s is string => typeof s === "string" && s.length > 0 && s.length <= 64,
    );
    if (names.length > 0) out.voteSources = [...new Set(names)];
  }

  // ⚠ 判「是否还有内容」时必须**排除新增的两个诊断字段**，不能沿用「out 非空即采信」——
  // 否则一条只剩投票分布的记录会被当成有效条目留下，lookupCapability 返回一个非 null
  // 但能力字段全 undefined 的对象，调用方据「非 null」判定「已知」就跳过了兜底。
  const substantive = Object.keys(out).filter(
    (k) => k !== "contextWindowVotes" && k !== "voteSources",
  );
  return substantive.length === 0 ? null : out;
}

// ─────────────────────────────────────────────────────────────
// 数据源 1：外部目录同步（多源投票）
// ─────────────────────────────────────────────────────────────

/**
 * 把一条解析结果登记到**全部**归一化键上（append，不是覆盖也不是先到先得）。
 *
 * ⚠ 必须 append 的理由（这是三个 parse 里最容易做错的一处）：同一个裸名可能来自多个
 * provider —— `azure_ai/deepseek-v3` 与 `deepinfra/deepseek-ai/DeepSeek-V3` 是**两个部署**、
 * 两个真实窗口值。用「先到先得」（`if (!(key in out))`）等于在 parse 内部就把分布收敛成
 * 一个任选值，多源众数投票拿不到分布也就无从投票 —— 那正是本模块历史上系统性低估的形态。
 *
 * 写哪些键由 expandKeys 统一决定（与查询侧 normalizeCandidates 互为镜像）。
 */
function appendUnderKeys(
  out: Record<string, ModelCapabilityEntry[]>,
  rawId: string,
  entry: ModelCapabilityEntry,
): void {
  for (const key of expandKeys(rawId)) {
    (out[key] ??= []).push(entry);
  }
}

/** litellm 单条（仅声明消费字段）。 */
interface LitellmEntry {
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
  max_tokens?: unknown;
  supports_reasoning?: unknown;
  mode?: unknown;
}

/**
 * 解析 litellm 目录：`{ "<model>": {...} }` 扁平字典。
 *
 * ⚠ litellm 以 `provider/model` 为主键组织（实测 3040 键里 2471 个带 `/`，占 81.3%；其中
 * 1848 个的裸名在 litellm 里根本不存在，占带前缀键的 74.8%），而企业网关暴露的是裸名。
 * 早先这里只写全名键（`out[name.toLowerCase()] = entry`），等于把 74.8% 的 litellm 数据存成
 * 永远查不到的形态 —— 实测 17 个网关模型（8 个对话模型）纯因此漏采，`deepseek-v3` 明明有
 * `azure_ai/deepseek-v3` 的数据却查出 null。现由 appendUnderKeys/expandKeys 统一写键。
 */
function parseLitellm(raw: unknown): Record<string, ModelCapabilityEntry[]> {
  const out: Record<string, ModelCapabilityEntry[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as LitellmEntry;
    // 只收对话类模型（embedding/rerank/image 的窗口语义不同，混入会误导 compact 阈值，
    // 也会污染众数投票 —— 同名的对话/非对话条目混在一起投出来的是个语义混杂的值）。
    if (e.mode !== undefined && e.mode !== "chat" && e.mode !== "responses") continue;
    const cw = pickInt(e.max_input_tokens) ?? pickInt(e.max_tokens);
    const out2 = pickInt(e.max_output_tokens);
    if (cw === undefined && out2 === undefined) continue;
    const entry: ModelCapabilityEntry = { source: "catalog" };
    if (cw !== undefined) entry.contextWindow = cw;
    if (out2 !== undefined) entry.maxOutputTokens = out2;
    if (typeof e.supports_reasoning === "boolean") entry.supportsReasoning = e.supports_reasoning;
    appendUnderKeys(out, name, entry);
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
  architecture?: { output_modalities?: unknown };
}

/**
 * 解析 OpenRouter 目录：`{ data: [...] }`。它额外提供 effort 档位——外部源里唯一有此字段的。
 *
 * 非对话模型过滤：与 models.dev 同判据（`architecture.output_modalities` 不含 `"text"`），
 * 补齐三个源里唯一缺过滤器的一个。litellm 看 `mode`、models.dev 看 `modalities.output`、
 * 本源看 `architecture.output_modalities` —— 字段名各不相同，语义一致。
 *
 * ⚠ **实测它今天命中 0 条**（2026-08-21，417 条全部 output 含 "text"，复现见下方脚本）。
 * 落它的理由是**对称性**而非当下的错数字：三个源里两个有过滤器、一个没有，
 * 下一个加源的人照着 parseOpenRouter 抄就会漏掉过滤，而 OpenRouter 上游随时可能
 * 开始铺 embedding/rerank 条目（models.dev 镜像里就有约 140 条，且**确实带 context 值**，
 * 混进来会污染同名对话模型的众数投票）。不要把这个函数的注释写成「修掉了 N 条污染」。
 *
 * ```bash
 * curl -s https://openrouter.ai/api/v1/models | python3 -c '
 * import json,sys; d=json.load(sys.stdin)["data"]
 * bad=[m["id"] for m in d if isinstance((m.get("architecture") or {}).get("output_modalities"),list)
 *      and "text" not in m["architecture"]["output_modalities"]]
 * print(len(d), "条，其中 output 不含 text 的：", len(bad))'
 * ```
 *
 * ⚠⚠ 判据**必须是黑名单形态**（数组存在且不含 `"text"` 才拒），不能写成
 * 「output 必须恰好等于 `["text"]`」—— 后者会误杀 15 个**合法对话模型**：
 * `openai/gpt-audio`（`["text","audio"]`，ctx 128K）、`google/gemini-3-pro-image`
 * （`["image","text"]`，ctx 131K）这类多模态**输出**的模型是对话模型，窗口值是对的。
 * 「输出里有别的模态」与「不是对话模型」是两件事，前者不构成排除理由。
 */
function parseOpenRouter(raw: unknown): Record<string, ModelCapabilityEntry[]> {
  const out: Record<string, ModelCapabilityEntry[]> = {};
  const items = (raw as { data?: unknown })?.data;
  if (!Array.isArray(items)) return out;
  for (const it of items as OpenRouterEntry[]) {
    if (!it || typeof it !== "object" || typeof it.id !== "string") continue;
    // 非对话模型过滤：output 模态明确存在且不含 text → 不是对话模型。
    // 缺字段时**放行**（未知不等于非对话），与 parseModelsDev 同口径。
    const outputModalities = it.architecture?.output_modalities;
    if (Array.isArray(outputModalities) && !outputModalities.includes("text")) continue;
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
    appendUnderKeys(out, it.id, entry);
  }
  return out;
}

/** models.dev 单条（仅声明消费字段）。 */
interface ModelsDevEntry {
  limit?: { context?: unknown; output?: unknown };
  reasoning?: unknown;
  reasoning_options?: unknown;
  modalities?: { input?: unknown; output?: unknown };
}

/**
 * 解析 models.dev（镜像）目录：`{ [providerId]: { models: { [modelId]: {...} } } }`。
 *
 * ⚠ 与 litellm/OpenRouter 的**关键结构差异**：同一个模型在多个 provider 下各有一条
 * （实测 192 providers / 6834 条，其中 734 个模型出现在 ≥2 个 provider 上）。
 * 这些条目**不是重复数据，是不同部署** —— 第三方托管常阉割上下文：实测
 * `digitalocean/glm-5.2`=262144、`scaleway/glm-5.2`=256000、`routing-run/glm-5.2`=200000，
 * 而第一方 `zai/glm-5.2`=1000000（分歧 5.2 倍）。统计口径上，多 provider 模型里
 * 26.0% 的窗口分歧 ≥2 倍，这是数据的常态而非异常。
 *
 * 所以本函数必须把同名模型的**所有值都交给投票函数**，绝不在这里先 min/first 收敛 ——
 * 否则众数拿不到分布，投票就退化成「任选一个部署的值」。
 *
 * 非对话模型过滤：镜像没有 litellm 的 `mode` 字段，改用 `modalities.output` 不含 `"text"`
 * 判定（`["audio"]` / `["image"]` 之类）。实测约 140 条非对话条目**确实带 context 值**
 * （如 `nvidia/llama-nemotron-rerank-vl-1b-v2` ctx=128000），混进来会污染同名对话模型的投票。
 * 加源必须同时加它的过滤器 —— 分两次做就是「已知会污染投票还先合」。
 * 三个源现在都有过滤器（litellm 看 `mode`、本源看 `modalities.output`、
 * OpenRouter 看 `architecture.output_modalities`），字段名不同但语义与「缺字段放行」一致。
 */
function parseModelsDev(raw: unknown): Record<string, ModelCapabilityEntry[]> {
  const out: Record<string, ModelCapabilityEntry[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const provider of Object.values(raw as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as { models?: unknown }).models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, v] of Object.entries(models as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const e = v as ModelsDevEntry;

      // 非对话模型过滤：output 模态明确存在且不含 text → 不是对话模型。
      // 缺字段时**放行**（未知不等于非对话，宁可多收一条也不要漏掉正常模型）。
      const outputModalities = e.modalities?.output;
      if (Array.isArray(outputModalities) && !outputModalities.includes("text")) continue;

      const cw = pickInt(e.limit?.context);
      const mo = pickInt(e.limit?.output);
      const efforts = extractModelsDevEfforts(e.reasoning_options);
      if (cw === undefined && mo === undefined && !efforts) continue;

      const entry: ModelCapabilityEntry = { source: "catalog" };
      if (cw !== undefined) entry.contextWindow = cw;
      if (mo !== undefined) entry.maxOutputTokens = mo;
      if (efforts) entry.effortValues = efforts;
      if (typeof e.reasoning === "boolean") entry.supportsReasoning = e.reasoning;
      appendUnderKeys(out, modelId, entry);
    }
  }
  return out;
}

/**
 * 从 models.dev 的 `reasoning_options` 抽 effort 档位。
 *
 * 形态：`[{ type: "effort", values: ["low","high","max"] }]`。只认 `type === "effort"` 的那项 ——
 * 该数组将来可能新增别的 reasoning 选项类型（如 token 预算档），按位置取会取错。
 * 这个字段是 litellm/OpenRouter 都没有的：拿到它就等于**不必再发一个非法请求去探档位**。
 */
function extractModelsDevEfforts(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  for (const opt of v) {
    if (!opt || typeof opt !== "object") continue;
    const o = opt as { type?: unknown; values?: unknown };
    if (o.type !== "effort") continue;
    const words = sanitizeEffortWords(o.values);
    if (words) return words;
  }
  return undefined;
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
 * miss 触发刷新的最小间隔（防抖）。**这个值没有实测依据，是按「不至于让一个错模型名把我们
 * 打成 DDoS 客户端」的直觉定的，不是测的**——诚实标注，不要把它当成经过压测的结论。
 * 不经 env 开放覆盖：这是内部节流参数，不是用户需要调的旋钮，开放了只会多一个「新增
 * SID_* 就要同步 help.ts + docs:gen-reference」的负担，收益却很小。
 */
const MISS_REFRESH_DEBOUNCE_MS = 10 * 60 * 1000;

/** 上一次因 miss 触发刷新的时间（进程内状态，不落盘——重启即重置，可接受）。 */
let lastMissTriggerAt: number | undefined;
/** 当前是否有一次 miss 触发的刷新正在飞行（避免同一进程内并发发起多个刷新请求）。 */
let missRefreshInFlight = false;

/**
 * miss 触发刷新：查询未命中时，异步 + 防抖地补一次外部目录同步，把「新模型上线 → 我们知道」
 * 的窗口从最坏 1 天（TTL）压到 ~10 分钟。
 *
 * 三条约束缺一不可，否则一个不存在的模型名会让我们每轮都触发全量拉取，被当成 DDoS 客户端：
 * 1. **异步**：fire-and-forget，不阻塞调用方（本次查询仍走兜底）；
 * 2. **防抖**：同一进程 10 分钟内最多触发一次，不因反复查同一个/不同的未知模型名而叠加；
 * 3. **尊重现有失败退避**：`computeCatalogBackoffMs`——连续失败时防抖间隔之外还要再等退避期。
 *
 * 命中 TTL 正常同步周期时不重复触发（`shouldSyncCatalogs` 已经会同步，本函数只覆盖
 * TTL 还没到但用户查了一个我们没有的模型这种情况）。
 */
function maybeTriggerMissRefresh(now: number): void {
  // 测试态（persistDisabled）绝不触网：lookupCapability 在单测里被大量喂未知模型名，
  // 若不挡住，每个查 miss 的用例都会在后台发起一次真实 HTTP 请求 —— 慢、不确定、
  // 且会把网络故障伪装成测试 flake。生产路径从不置位 persistDisabled，不受影响。
  if (persistDisabled) return;
  if (missRefreshInFlight) return;
  if (lastMissTriggerAt !== undefined && now - lastMissTriggerAt < MISS_REFRESH_DEBOUNCE_MS) return;
  const fails = memMeta.failCount ?? 0;
  if (fails > 0 && now - (memMeta.syncedAt ?? 0) < computeCatalogBackoffMs(fails)) return;
  lastMissTriggerAt = now;
  missRefreshInFlight = true;
  void syncExternalCatalogs({ now })
    .catch(() => {
      /* 失败已在 syncExternalCatalogs 内部记退避，这里无需重复处理 */
    })
    .finally(() => {
      missRefreshInFlight = false;
    });
}

/** 仅测试用：重置 miss 触发刷新的防抖状态。 */
export function __resetMissRefreshStateForTest(): void {
  lastMissTriggerAt = undefined;
  missRefreshInFlight = false;
}

/**
 * 同步外部模型目录 → 合并进能力缓存。
 *
 * ⚠ 累加器是「一个键 → 一组候选」（`Record<string, {entry, source}[]>`），**不是**逐条两两折叠。
 * 这个形态是**众数投票强制要求的**：min/max 可结合（`min(min(a,b),c) === min(a,b,c)`），
 * 所以两两折叠算得对；**众数不可结合** —— `mode(mode(a,b),c)` 无意义，它必须看到完整分布。
 * 谁把这里改回折叠，投票就会静默退化，而测试与类型都不会报错。
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

  const candidates: Record<string, CandidateEntry[]> = {};
  const okSources: string[] = [];
  const notModifiedSources: string[] = [];
  const failed: string[] = [];
  const nextValidators: Record<string, { etag?: string; lastModified?: string }> = {
    ...memMeta.validators,
  };
  const bodyPresent = new Set(memMeta.bodyPresent ?? []);

  for (const src of CATALOG_SOURCES) {
    // 条件请求：只有「上一轮这个源确实解析出过正文」时才带 validator ——
    // 否则本地其实没有那份数据，304 会让覆盖层变空（见 fetchCatalog 头部注释）。
    const { parsed, notModified, validator } = await fetchCatalog(src, timeoutMs, {
      allowConditional: bodyPresent.has(src.name),
      validator: memMeta.validators?.[src.name],
    });
    if (validator) nextValidators[src.name] = validator;

    if (notModified) {
      // 304：本地这份仍有效，既不是失败也不产出新候选，但要保留在 bodyPresent 里
      // （下一轮还可以继续带 validator），且不牵连整体判定为失败。
      notModifiedSources.push(src.name);
      continue;
    }
    if (!parsed) {
      failed.push(src.name);
      bodyPresent.delete(src.name); // 这轮没拿到正文，下一轮不能再假装有 validator 可用
      continue;
    }
    okSources.push(src.name);
    bodyPresent.add(src.name);
    for (const [name, entries] of Object.entries(parsed)) {
      const bucket = (candidates[name] ??= []);
      for (const entry of entries) bucket.push({ entry, source: src.name });
    }
  }

  const merged: Record<string, ModelCapabilityEntry> = {};
  for (const [name, bucket] of Object.entries(candidates)) {
    const voted = voteEntries(bucket);
    if (voted) merged[name] = voted;
  }

  memMeta.validators = Object.keys(nextValidators).length > 0 ? nextValidators : undefined;
  memMeta.bodyPresent = bodyPresent.size > 0 ? [...bodyPresent] : undefined;

  // 「有效」= 拿到新数据的源 + 确认未变更的源。两者都说明这个源本身是健康的，
  // 只统计 okSources.length === 0 会把「全员 304」误判成「全部失败」并触发退避。
  if (okSources.length === 0 && notModifiedSources.length === 0) {
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
    `外部目录同步完成：${Object.keys(merged).length} 条 / 源 ${okSources.join("+")}` +
      (notModifiedSources.length > 0 ? ` / 未变更 ${notModifiedSources.join("+")}` : ""),
  );
  return { updated: Object.keys(merged).length, sources: okSources, failed };
}

/** 一个候选值及其来源（来源只为诊断，不参与选值）。 */
interface CandidateEntry {
  entry: ModelCapabilityEntry;
  source: string;
}

/**
 * 多源 token 上限选值（contextWindow 与 maxOutputTokens 共用）：取**众数**，而不是最小值。
 *
 * 两个字段共用一个函数是刻意的：它们的数据形态相同（按 provider 分条的同一模型多条），
 * 失败模式也相同（少数源报离群值 —— 窗口那边是阉割部署，输出那边是把 context 填进了 output）。
 * 让它们分叉只会得到两套各自演化、各自出错的规则。
 *
 * ── 为什么不是 min（2026-08-18 实测推翻了原设计）────────────────────
 *
 * 原设计取 min 的理由是「窗口高估会吃 400，保守更安全」，它隐含一个前提：
 * **源之间的分歧是测量噪声**（如 1M vs 1.048M，差 4.8%）。这个前提不成立。
 *
 * 源数据是**按 provider 分条**的，同一模型在不同 provider 上是不同部署，第三方托管常阉割
 * 上下文（实测 glm-5.2：digitalocean 262144 / scaleway 256000 / routing-run 200000，
 * 而第一方 zai 是 1000000 —— 差 5.2 倍）。分歧是真实的部署差异，量级是数量级的，不是噪声。
 *
 * min 于是**系统性地选中最阉割的那个部署**。2026-08-20 实测（复现见
 * `bun run scripts/catalog-coverage.ts`，真值 = 内置注册表，5% 容差，
 * 分母 = 77 个「有真值且有 ≥2 个候选值」的模型）：
 *
 *     min   42.9% 正确 —— 错的 44 个**全部方向是低估**，高估 0
 *     众数  92.2% 正确 —— 低估 4 / 高估 2
 *
 * 最坏案例 `deepseek-v4-flash`：69 个候选值，min 给出 32768，众数给出 1000000（**30.5 倍**）。
 *
 * 众数为什么对：第一方与多数正规托管会报同一个真值，形成尖峰；阉割部署各家数值分散，
 * 构不成众数。
 *
 * ── 平局取大 / 无众数取 max：宁可高估（这个不对称是刻意的）──────────
 *
 * 高估 → 吃一次 400 → learnFromError 学到真值 → 自愈，**一次性代价且有信号**；
 * 低估 → 零报错零信号，过早触发 auto-compact，每一轮都多烧 token，**永久性代价**。
 *
 * ⚠ 不要以「保守 = 安全」的直觉把它改回 min。上一版就是那个直觉的产物，
 * 而它**没有任何报错**，所以在几十个模型上产生错值却潜伏了很久没被发现。
 */
export function voteTokenLimit(values: number[]): number | undefined {
  const valid = values.filter(isPositiveInt);
  if (valid.length === 0) return undefined; // 空集不得产出 0/NaN —— 未知就该是未知
  const cnt = new Map<number, number>();
  for (const v of valid) cnt.set(v, (cnt.get(v) ?? 0) + 1);
  let best = 0;
  for (const c of cnt.values()) best = Math.max(best, c);
  if (best >= 2) {
    // 有众数：同票时取大（同上，宁可高估）
    let pick = 0;
    for (const [v, c] of cnt) if (c === best) pick = Math.max(pick, v);
    return pick;
  }
  return Math.max(...valid); // 全不相同 → 无众数 → 取大，交给 400 自愈
}

/**
 * 把一个键上的全部候选投成一条记录。
 *
 * - `contextWindow`：众数（见 voteTokenLimit）。
 * - `maxOutputTokens`：**同样走众数**，再钳制到不超过投出来的 contextWindow。
 *
 *   ⚠ 这里原本是取 max，加了第三个源之后**它成了一个净退步**，必须一并改。
 *   2026-08-20 实测（同一个脚本 `bun run scripts/catalog-coverage.ts` 的 maxOutputTokens 段，
 *   已含下面那道钳制，真值 = 内置注册表，5% 容差）：
 *
 *     旧两源 max  64.3% 正确（13 高估）   →   三源 max   31.1% 正确（**47 高估**）
 *     旧两源 众数 73.2% 正确              →   三源 众数  74.3% 正确（7 高估）
 *
 *   原因是**有些源把 output 字段填成了 context 值**（gpt-4.1 真值 128K，某些源报 1047576；
 *   gpt-4o 真值 16384，某些源报 128000）。两个源时这种条目是少数，取 max 只偶尔踩到；
 *   加到 30+ provider 后，**取 max 几乎必然捞到那条错的**。众数不受少数离群值影响。
 *
 *   这是一个「加源」连带出来的回归：如果只按方案改窗口投票、把 output 留在 max 上，
 *   本 PR 会一边修好窗口一边把输出上限打坏 —— 而输出上限打高的症状同样是 400。
 *
 *   钳制仍然保留（众数也可能选中一个 output==context 的值）：大于窗口的输出上限一定是错的，
 *   输出装不进窗口，下发出去就是一次必然的 400。
 * - `effortValues` / `supportsReasoning`：取第一个报了该字段的源（顺序即 CATALOG_SOURCES
 *   优先级）。刻意不对它们投票：effort 档位是**集合**不是标量，各源观测口径不同
 *   （网关字段级并集 vs 模型级真值），投票会拼出一个没有任何源真正声明过的档位集合。
 */
function voteEntries(candidates: CandidateEntry[]): ModelCapabilityEntry | null {
  if (candidates.length === 0) return null;

  const windows: number[] = [];
  const voteCount = new Map<number, number>();
  const voteSources = new Set<string>();
  for (const { entry, source } of candidates) {
    if (isPositiveInt(entry.contextWindow)) {
      windows.push(entry.contextWindow);
      voteCount.set(entry.contextWindow, (voteCount.get(entry.contextWindow) ?? 0) + 1);
      voteSources.add(source);
    }
  }

  const out: ModelCapabilityEntry = { source: "catalog" };
  const votedWindow = voteTokenLimit(windows);
  if (votedWindow !== undefined) {
    out.contextWindow = votedWindow;
    // 诊断字段：只在确实有多个不同候选值时才存 —— 单一值的分布是 `{"1000000":7}`，
    // 复算价值为零，却要在数千条目上各占一份，白白让缓存文件变大。
    if (voteCount.size > 1) {
      out.contextWindowVotes = Object.fromEntries(
        [...voteCount].sort((a, b) => b[1] - a[1] || b[0] - a[0]).map(([v, c]) => [String(v), c]),
      );
      out.voteSources = [...voteSources];
    }
  }

  const outputs: number[] = [];
  for (const { entry } of candidates) {
    if (isPositiveInt(entry.maxOutputTokens)) outputs.push(entry.maxOutputTokens);
  }
  // 与窗口共用同一个投票函数：规则相同（众数 → 平局取大 → 无众数取 max），
  // 失败模式也相同（少数源把 output 填成了 context 值），没有理由让两者分叉。
  const maxOut = voteTokenLimit(outputs);
  if (maxOut !== undefined) {
    out.maxOutputTokens = votedWindow !== undefined ? Math.min(maxOut, votedWindow) : maxOut;
  }

  for (const { entry } of candidates) {
    if (out.effortValues === undefined && entry.effortValues !== undefined) {
      out.effortValues = entry.effortValues;
    }
    if (out.supportsReasoning === undefined && typeof entry.supportsReasoning === "boolean") {
      out.supportsReasoning = entry.supportsReasoning;
    }
  }

  // 一条都没投出可用能力字段（例如全部候选的窗口都非法）→ 不写入，交给兜底。
  return out.contextWindow === undefined &&
    out.maxOutputTokens === undefined &&
    out.effortValues === undefined &&
    out.supportsReasoning === undefined
    ? null
    : out;
}

/**
 * 单个目录源响应体的字节上限。
 *
 * 为什么需要（不是理论风险）：本模块此前直接 `await resp.json()`，一个畸形的超大响应
 * （或被中间人替换的响应）会让运行时在解析前就把整份 payload 缓冲进内存。模块头部与
 * CLAUDE.md 都写了「第三方 HTTP 属不可信数据」，但此前的不可信处理只做到**字段级校验**
 * （isPositiveInt 那一层），没有**体积级**防护。加 models.dev 镜像后最大响应从 1.7MB 抬到
 * 4.0MB，体积敏感度上升，顺手补齐成本最低。
 *
 * ⚠ 32MiB 是**按余量推的，不是压测出来的**：镜像实测 4.0MB / litellm 1.7MB /
 * OpenRouter 0.68MB，留 8 倍余量（够上游翻三轮），同时远低于会打爆 Bun 默认堆的量级。
 * 对标 openclaw 同类端点用 16MiB，我们取 2 倍是因为 models.dev 镜像本身就比 OpenRouter 大 5.9 倍。
 */
const CATALOG_BODY_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 读响应体并强制字节上限。超限即抛（由 fetchCatalog 统一按「该源失败」处理）。
 *
 * 必须流式读 + 边读边计数：先 `arrayBuffer()` 再看长度等于已经把超大 payload 收进内存了，
 * 上限也就白设。`content-length` 也不能单独作为判据 —— 它由对端提供，可以撒谎或缺失。
 */
async function readBodyCapped(resp: Response): Promise<Uint8Array> {
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CATALOG_BODY_MAX_BYTES) {
    throw new Error(`响应体声明 ${declared} 字节，超过上限 ${CATALOG_BODY_MAX_BYTES}`);
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
    if (total > CATALOG_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`响应体超过上限 ${CATALOG_BODY_MAX_BYTES} 字节，已中断`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** 单源拉取结果。`notModified` 与 `parsed === null` 是两件事，调用方必须区分。 */
interface FetchCatalogResult {
  /** 解析出的多值条目表。304 或失败时为 null。 */
  parsed: Record<string, ModelCapabilityEntry[]> | null;
  /** 服务端返回 304：本地那份仍然有效，不是失败（不计退避、不清 validator）。 */
  notModified: boolean;
  /** 本次响应带回的 validator，供下一轮条件请求使用。 */
  validator?: { etag?: string; lastModified?: string };
}

/**
 * 拉取并解析单个目录源。任何失败（网络/超时/超限/解压失败/非 JSON/schema 异常）→
 * `{ parsed: null, notModified: false }`。
 *
 * ── 条件请求（If-None-Match / If-Modified-Since）─────────────────────
 *
 * 只在 `allowConditional` 为真时下发 validator。调用方据「本地是否确实存有该源解析出来的
 * 正文」来决定 —— 这条判据不能省：304 的语义是「你手上那份还有效」，而如果我们手上其实
 * 没有正文（缓存文件被删、schema bump 作废、源名改过），下发 validator 换回 304 就等于
 * 把覆盖层变成空的，**且没有任何报错**。对标 pi 的同名注释。
 */
async function fetchCatalog(
  src: CatalogSource,
  timeoutMs: number,
  opts?: { allowConditional?: boolean; validator?: { etag?: string; lastModified?: string } },
): Promise<FetchCatalogResult> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  try {
    // zstd 源返回的是 application/octet-stream 一类，别声明只接受 JSON。
    const headers: Record<string, string> = {
      accept: src.decompress ? "*/*" : "application/json",
    };
    if (opts?.allowConditional && opts.validator) {
      if (opts.validator.etag) headers["if-none-match"] = opts.validator.etag;
      else if (opts.validator.lastModified) {
        headers["if-modified-since"] = opts.validator.lastModified;
      }
    }
    const resp = await fetch(src.url, { method: "GET", headers, signal: ctl.signal });
    const validator = readValidator(resp);
    if (resp.status === 304) {
      // 本地那份仍有效。不读正文、不解析，也**不算失败** —— 计进退避会让「数据没变」
      // 被当成「源挂了」，几轮之后把 TTL 拖到 24h 封顶。
      log().debug("MODEL-CAP", `目录源 304 未变更，沿用本地数据`, { url: src.url });
      return { parsed: null, notModified: true, validator };
    }
    if (!resp.ok) {
      log().debug("MODEL-CAP", `目录源 HTTP ${resp.status}`, { url: src.url });
      return { parsed: null, notModified: false };
    }
    const body = await readBodyCapped(resp);
    // 解压后的体积不再设第二道上限：zstd 源实测 140KB → 4.0MB（约 29 倍），而压缩包本身
    // 已经过 32MiB 门。真要防 zip bomb 需要解压时流式限额，Bun.zstdDecompressSync 做不到；
    // 该源是已知镜像、非用户可控输入，这个残余风险按可接受处理。
    const text = new TextDecoder().decode(
      src.decompress === "zstd" ? Bun.zstdDecompressSync(body) : body,
    );
    const out = src.parse(JSON.parse(text) as unknown);
    return {
      parsed: Object.keys(out).length > 0 ? out : null,
      notModified: false,
      // 解析为空时不留 validator：留了下一轮就会拿它换一个 304，把「解析不出东西」
      // 固化成「本地那份还有效」，而本地并没有那份东西。
      validator: Object.keys(out).length > 0 ? validator : undefined,
    };
  } catch (e) {
    // 与 gateway-pricing 同理：这是纯优化项，失败对用户不可行动 → debug 级，不惊扰终端。
    log().debug("MODEL-CAP", timedOut ? `目录源超时 ${timeoutMs}ms` : `目录源失败: ${String(e)}`, {
      url: src.url,
    });
    return { parsed: null, notModified: false };
  } finally {
    clearTimeout(timer);
  }
}

/** 从响应头读 validator（两者都缺则 undefined，代表该源不支持条件请求）。 */
function readValidator(resp: Response): { etag?: string; lastModified?: string } | undefined {
  const etag = resp.headers.get("etag") ?? undefined;
  const lastModified = resp.headers.get("last-modified") ?? undefined;
  if (!etag && !lastModified) return undefined;
  const out: { etag?: string; lastModified?: string } = {};
  // 与磁盘侧同一套约束（长度 + 无 CR/LF）：这个值会被写盘、下一轮再塞进请求头。
  if (etag && etag.length <= 256 && !/[\r\n]/.test(etag)) out.etag = etag;
  if (lastModified && lastModified.length <= 256 && !/[\r\n]/.test(lastModified)) {
    out.lastModified = lastModified;
  }
  return out.etag || out.lastModified ? out : undefined;
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
 * 重新打开写盘并（可选）注入目录同步元数据 —— **仅测试用**。
 *
 * ⚠⚠ 调用它之前**必须**先把 `SID_CONFIG_DIR` 指到临时目录。
 * `persistDisabled` 是单向开关（`__resetCapabilityCacheForTest` 只会置位、永不复位），
 * 那是为了兜住「曾把 2919 条真实数据抹成 1 条」那次事故。但正因为单向，persist() 的
 * 写盘合并语义在测试里根本走不到——D7 并发写合并没有它就无法验证。
 * 用完在 afterEach 调 `__resetCapabilityCacheForTest()` 即可复位（它会重新置位）。
 */
export function __enablePersistForTest(meta?: { syncedAt?: number; failCount?: number }): void {
  persistDisabled = false;
  if (meta) memMeta = { ...meta };
}

/**
 * 直接触发一次落盘 —— **仅测试用**，且必须先调 `__enablePersistForTest`。
 *
 * 为什么不借生产入口（recordEffortRejected / syncExternalCatalogs）触发：前者会顺手把
 * `effortValues` 改成 `[]`，后者要触网。两者都会把「合并语义」这个被测对象搅进无关变量里。
 */
export function __persistForTest(): void {
  persist();
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

/**
 * 直接走 mergeEntry 写一条记录（仅测试用）。
 *
 * 用它测「一条采集结果落进已有缓存」的合并语义（尤其是投票诊断字段与窗口的一体性），
 * 不必为此触网跑一整轮 syncExternalCatalogs。
 */
export function __applyCatalogEntryForTest(model: string, patch: ModelCapabilityEntry): void {
  mergeEntry(model, patch);
}

/**
 * 当前缓存 schema 版本（仅测试用）。
 *
 * 测试构造磁盘 fixture 时**必须**用它，不要硬编码字面量：schema 每 bump 一次，硬编码的
 * fixture 就会被 readCacheFile 当成过期版本整份丢弃，于是一批与版本毫无关系的用例
 * （并发写合并、字段保留）集体报红。那种红是 fixture 陈旧，不是被测行为坏了 ——
 * 排查它纯属浪费，而且容易被误判成「合并逻辑回归了」。
 */
export const __SCHEMA_VERSION_FOR_TEST = SCHEMA_VERSION;

/**
 * 暴露三个 parse 函数（仅测试用）。
 *
 * 为什么必须直接测它们而不是只测 syncExternalCatalogs：后者要触网。写键形态（一条记录登记
 * 到哪些键上）曾因为「只有走网络才能观察」而长期漏采 74.8% 的 litellm 数据 —— 不方便测，
 * 于是没测。parse 是纯函数，用 fixture 直接锁住写键与多值形态是最短的验证路径。
 */
export const __parsersForTest = {
  litellm: parseLitellm,
  openrouter: parseOpenRouter,
  modelsDev: parseModelsDev,
} as const;

/**
 * 暴露 voteEntries（仅测试用）—— 「一组候选 → 一条记录」的投票现场。
 *
 * `voteTokenLimit` 已经是导出的纯函数，但它只覆盖窗口选值这一步；
 * maxOutputTokens 的钳制、诊断字段的写入条件、effort 的「取第一个报了的源」都在这一层。
 */
export function __voteEntriesForTest(
  candidates: Array<{ entry: ModelCapabilityEntry; source: string }>,
): ModelCapabilityEntry | null {
  return voteEntries(candidates);
}
