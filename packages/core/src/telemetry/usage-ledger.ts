/**
 * 用量账本（usage-ledger）——缓存命中长期统计的自包含底座（方案模块 C1）。
 *
 * 设计契约（与 OTel 导出管道分流，"同源双汇"）：
 * - **append-only**：每会话 SessionEnd 落**一行**汇总，体积可控（1 万会话 ≈ 几 MB）。
 * - **默认开、不轮转、人类可读**：与 metrics.jsonl（默认关 + 50MB 轮转 + 不可读回）互补；
 *   也不受 trajectories LRU（默认留 100 会话）影响——专供跨会话聚合。
 * - **只存聚合数字（token 数 / 成本），绝不存任何消息内容**——隐私安全。
 *
 * 存储位置：~/.sid-code/usage-ledger.jsonl（可经 SID_CODE_USAGE_LEDGER 环境变量重定向，测试隔离用）。
 *
 * 读写均容错：文件不存在 / 损坏行直接跳过，不抛错——绝不阻断 SessionEnd 退出热路径。
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";

/** 单会话用量账本行（每会话一行汇总） */
export interface UsageLedgerEntry {
  /** 会话结束时间戳（秒，Unix epoch） */
  ts: number;
  sessionId: string;
  model: string;
  provider: string;
  /** 完整输入 = hit + write + uncached（归一化三段总和） */
  promptTotal: number;
  /** 命中（读缓存）token 数 */
  cacheHit: number;
  /** 写入缓存 token 数（DeepSeek 恒 0） */
  cacheWrite: number;
  /** 未命中（全价）输入 token 数 */
  uncachedInput: number;
  /** 输出 token 数 */
  output: number;
  /** 本会话总成本（美元） */
  costUSD: number;
  /** 本会话缓存节省（美元） */
  savingsUSD: number;
  /** 会话时长（毫秒） */
  durationMs: number;

  /**
   * P2-1：影子调用（标题生成 / 子代理 / 分类器等辅助 LLM 调用）的用量。旧数据无这三个字段。
   *
   * 为什么必须单独记：`costUSD` 走 `getEffectiveTotalCostUSD()` =
   * totalCostUSD + sideCostUSD，**含**影子调用；而上面 promptTotal/cacheHit 等 token
   * 只遍历 modelUsage（主循环），**不含**影子调用。同一行里成本与 token 口径不同，
   * 于是"平均每 token 成本"算不出来，"省了多少"在含影子调用的会话上永远测不准。
   *
   * 影子调用的 token **早已在采集**（src/trace/side-call-sink.ts），只是没进账本 ——
   * 所以这是接线而非新建埋点。三个字段都记下来，消费侧就能自由选口径：
   * 主循环口径（promptTotal）、整体口径（promptTotal + sideInputTokens）、
   * 以及"成本 ÷ token"这类必须同源的派生量。
   */
  sideInputTokens?: number;
  sideOutputTokens?: number;
  sideCostUSD?: number;

  /**
   * P0-4：主模型末次请求的端点 host（如 `api.uniapi.io`）。旧数据无此字段。
   *
   * 存在的理由：同一模型名经不同网关，usage 的**可信度完全不同**。实测某月卡网关的
   * Anthropic usage 是编造的（三段随机跳动而总和恒定、全新前缀 r1 就报大量命中、
   * 不打 cache_control 也报命中），把它的"命中"混进总命中率会直接抬高整体数字。
   * provider 字段分不开（都是 "anthropic"），必须记到 host 粒度。
   *
   * 消费侧据此对不可信渠道打 ⚠ 且排除出总计 —— 见 src/trace/cache-report.ts。
   * 只落 host 不落完整 URL：path/query 可能含敏感串，归因只需要 host。
   */
  endpointHost?: string;

  /**
   * P0-1：写这一行的 sid-code 版本号（裸 `x.y.z`）。**旧数据无此字段。**
   *
   * 两个用途，第二个比第一个更急：
   *
   * 1. **飞轮维度**：北极星四方向的第 3 级都是 release-over-release 曲线，
   *    版本是那条曲线唯一的分组键。此前账本 12~16 个字段一个都不是版本，
   *    于是「这个 release 比上个更省了吗」根本问不出来。
   * 2. **区分「用哪个版本的采集代码写的」**（P2-9）：实测同一模型同一渠道，
   *    `gpt-5.6-luna` 在 2026-08-02 记 3.2% 命中、08-09 记 81.1% —— 差异**全部**来自
   *    采集代码的修复时点（`e6642094` 修 Responses API 缓存双漏采、`ed26bfeb` 修
   *    savings 兜底，均 2026-08-08），不是渠道变化。没有版本标记时这些脏数据会
   *    混进总命中率把它拉低（实测总计 66.2%，而主力渠道都在 79~82%）。
   *
   * **刻意不回填存量的 377 行**：只能靠 mtime 猜写入版本，猜错比留空更糟 ——
   * 会做出错误的 release 对比结论。消费侧把 `undefined` 归入「无版本标记」桶
   * 并显式报告排除了多少行，与上面 `endpointHost` 缺失的既有做法完全一致。
   */
  appVersion?: string;

  /**
   * D1 / 方案 §5.5：本会话请求落在**高峰时段**的比例（0–1）。**旧数据无此字段。**
   *
   * ## 为什么必须落，而不是读侧按 `ts` 反推
   *
   * 分时段计价一旦生效，成本就**不再可复现**：`ts` 是会话**结束**时间，而一个跨了
   * 时段边界的会话，前半段与后半段单价差 2 倍（实测 DeepSeek 空闲价恰为高峰价一半）。
   * 用单一时间戳反推整会话的时段，跨边界的会话必然算错，而错的方向不确定 ——
   * 既可能高估也可能低估，于是「这个 release 更省了吗」这条曲线上会多一层噪声。
   *
   * 反推还有第二个问题：它依赖读侧重新实现一份时段判定（时区库版本、
   * 厂商政策窗口变更都会让两份实现漂移）。判据只该有一份，在
   * `api/cost-tracker.ts` 的 `priceTierAt`。
   *
   * ## 顺带回答一个真实的省钱问题
   *
   * 有了它，「把长任务挪到空闲时段能省多少」从推测变成可算的数 ——
   * 这是「更省」方向少见的、不牺牲任何其它方向的纯收益项。
   *
   * 缺失语义：`undefined` = 该会话所有模型都无分时段政策，**或**这行是加字段前写的。
   * 两者读侧不可区分，与 `endpointHost` / `appVersion` 既有做法一致
   * （刻意不回填存量：只能靠 mtime 猜，猜错比留空更糟）。
   */
  peakRatio?: number;
}

/**
 * 应用 `SID_CODE_USAGE_LEDGER` 重定向 —— 账本路径解析的**单一事实源**（P3-3）。
 *
 * 为什么要独立出来：读侧（`src/trace/digest.ts` 的 `resolvePaths`）此前自己写了
 * 第二份 `process.env.SID_CODE_USAGE_LEDGER || join(root, "usage-ledger.jsonl")`。
 * 两份实现语义并不完全一致 —— 这边把空串/纯空白视为未设置（避免误重定向到空路径），
 * 那边不做 trim 判断，于是 `SID_CODE_USAGE_LEDGER=""` 时写侧回落默认路径、读侧读空串，
 * 表现为"明明写进去了却读不到"。
 *
 * 读侧要保留自己的 root 注入能力（digest 支持传 root 分析任意目录），所以这里
 * 收口的是**覆盖语义**而非整个路径推导：调用方给出默认值，本函数决定是否被环境变量取代。
 */
export function applyLedgerPathOverride(defaultPath: string): string {
  const override = process.env.SID_CODE_USAGE_LEDGER;
  if (override && override.trim() !== "") return override;
  return defaultPath;
}

/** 账本文件路径（测试可经环境变量重定向） */
export function ledgerPath(): string {
  return applyLedgerPathOverride(sidPaths.usageLedger());
}

/**
 * 追加一行会话汇总到账本（append-only）。
 * 失败静默忽略（不阻断 SessionEnd 退出）。
 *
 * @deprecated 生产写侧已全部改走 {@link upsertUsageLedger}（`app.ts` 落账本的唯一入口）。
 * **新代码不要调用它**：裸 append 会让一个 30 轮会话写 30 行，而 `aggregateEntries`
 * 对每行 costUSD 累加、sessions += 1 —— 成本与会话数直接翻 30 倍（详见 upsert 的注释）。
 * 保留它仅因 `readUsageLedger` / `dedupeBySession` 的测试需要构造"append 时代的多行历史"
 * 来验证读侧去重防御，删掉就没法再测那条兼容路径。
 */
export function appendUsageLedger(entry: UsageLedgerEntry): void {
  try {
    const path = ledgerPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // 写盘失败静默忽略
  }
}

/**
 * upsert 一行会话汇总（按 sessionId 去重，latest-wins）——支持**每轮增量落盘**。
 *
 * 背景（缺陷修复）：账本此前只在 SessionEnd（退出路径）落一行。但交互式会话做完一轮仍停在 REPL
 * 不退出 → SessionEnd 不触发 → 该会话在跨会话聚合（/cache）里长期计 $0，直到用户手动退出。
 * 解法：每轮 done 后就把「本会话累计用量」写进账本。
 *
 * 为什么必须 upsert 而非 append：aggregateEntries 对每行 costUSD 累加、sessions += 1。若每轮裸
 * append，一个 30 轮的会话会写 30 行 → 成本翻 30 倍、会话数翻 30 倍。upsert 保证「每会话恒一行」
 * （costUSD 是会话累计值，最新一次写入最完整），既支持增量可见、又不破坏聚合口径。
 *
 * 实现：读全量（跳过损坏行）→ 剔除同 sessionId 旧行 → 追加新行 → 整体重写。ledger 体积可控
 * （prune 保证），重写为 best-effort、off-hot-path、失败静默忽略。
 */
export function upsertUsageLedger(entry: UsageLedgerEntry): void {
  try {
    const path = ledgerPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existing = readUsageLedger().filter((e) => e.sessionId !== entry.sessionId);
    existing.push(entry);
    writeFileSync(path, existing.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  } catch {
    // 写盘失败静默忽略（绝不阻断主流程）
  }
}

/**
 * 按 sessionId 去重，保留每个会话**最后出现**的那一行（latest-wins），保持原有顺序。
 *
 * 防御用途：upsertUsageLedger 已保证新写入每会话恒一行，但历史账本里可能残留 append 时代的
 * 多行（同一会话被增量 append 过），或 upsert 前的旧数据。聚合器读侧先过这道去重，杜绝
 * 「同一会话被累加多次」导致成本/会话数虚高。无重复时是恒等变换，零副作用。
 */
export function dedupeBySession(entries: UsageLedgerEntry[]): UsageLedgerEntry[] {
  const lastIdx = new Map<string, number>();
  entries.forEach((e, i) => lastIdx.set(e.sessionId, i));
  return entries.filter((e, i) => lastIdx.get(e.sessionId) === i);
}

/**
 * 读取账本全部行（损坏行跳过）。
 * @param maxEntries 可选：只返回最近 N 行（从尾部取，避免大文件全量解析）
 */
export function readUsageLedger(maxEntries?: number): UsageLedgerEntry[] {
  try {
    const path = ledgerPath();
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf-8");
    let lines = raw.split("\n").filter((l) => l.trim() !== "");
    if (maxEntries !== undefined && lines.length > maxEntries) {
      lines = lines.slice(lines.length - maxEntries);
    }
    const result: UsageLedgerEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && typeof parsed.ts === "number") {
          result.push(parsed as UsageLedgerEntry);
        }
      } catch {
        // 跳过损坏行
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 裁剪账本：只保留最近 maxSessions 行（滚动裁剪，控制体积）。
 * 返回裁剪后剩余行数；失败返回 -1。
 */
export function pruneUsageLedger(maxSessions: number): number {
  try {
    const entries = readUsageLedger();
    if (entries.length <= maxSessions) return entries.length;
    const kept = entries.slice(entries.length - maxSessions);
    const path = ledgerPath();
    writeFileSync(path, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    return kept.length;
  } catch {
    return -1;
  }
}
