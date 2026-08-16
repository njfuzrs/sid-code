/**
 * 从 events.jsonl 重算会话 cost —— §6.2（僵尸会话补写）与 §6.4（远端对账校正）的共享底座。
 *
 * 背景：session.traj 的 total_cost_usd 依赖 SessionEnd 干净触发（用 SessionState 权威值覆盖）。
 * 但以下场景 SessionEnd 不触发或触发前 cost 已丢：
 *   - kill -9 / SIGKILL / OOM killer：进程被内核直接终止，SessionEnd 无机会运行（§6.2）
 *   - 修复前的历史会话：cost 恒 0 落盘，远端数据库也是 0（§6.4）
 *
 * events.jsonl 里的 AfterModelRaw 事件是「最接近 provider 返回的原始 usage」——processStream
 * 返回即落盘（collector.ts handleAfterModel），即使后续 pair 完成 / traj 重建崩溃也已写出。
 * 本模块解析这些事件、配合 model-registry 定价表重算 cost，作为 SessionEnd 缺失时的补偿。
 *
 * **口径说明**：AfterModelRaw.usage 含 { input_tokens, output_tokens, cache_read, cache_creation }。
 * cache_creation（写入）自 2026-07 起补落（此前缺失导致「有大量 cache 写入」的会话 cost 偏低）。
 * 对补落之前的历史会话，events 里没有 cache_creation 字段，重算仍会略偏低——但这是 best-effort
 * 补偿（总比 cost=0 准）。重算值会标注 source="events-recompute" 以便消费者区分于权威值。
 */

import { existsSync, readFileSync } from "node:fs";
import { calculateUSDCost, type PricingModelEntry } from "../api/cost-tracker.ts";
import type { Usage } from "../llm/types.ts";
import { getLogger } from "../debug/logger.ts";

/** 单条 AfterModelRaw 重算结果 */
export interface RecomputedCall {
  index: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
}

/** 整个会话的重算汇总 */
export interface RecomputedCost {
  /** 重算出的累计 cost（flow 口径，逐次累加） */
  totalCostUSD: number;
  /** 配对成功的 AfterModelRaw 调用数 */
  apiCalls: number;
  /** 末次请求的 input token（stock 口径） */
  lastInputTokens: number;
  /** 累计 input token（flow 口径，与 cost 可比） */
  cumulativeInputTokens: number;
  /** 累计 output token */
  totalOutputTokens: number;
  /** 累计 cache_read token */
  totalCacheReadTokens: number;
  /** 累计 cache_creation（写入）token */
  totalCacheCreationTokens: number;
  /** 主导模型名（出现次数最多） */
  model: string;
  /** 逐次明细 */
  calls: RecomputedCall[];
  /** 来源标记，写入 traj 时标注，便于与权威值区分 */
  source: "events-recompute";
}

/**
 * 解析一个会话目录的 events.jsonl，从 AfterModelRaw 事件重算 cost。
 *
 * @param sessionDir 会话目录（含 events.jsonl）
 * @param availableModels 用户配置的模型列表（携带权威 pricing/provider），可选
 * @returns 重算结果；events.jsonl 不存在 / 无 AfterModelRaw 时返回 null
 */
export function recomputeCostFromEvents(
  sessionDir: string,
  availableModels?: PricingModelEntry[],
): RecomputedCost | null {
  const eventsPath = `${sessionDir}/events.jsonl`;
  if (!existsSync(eventsPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(eventsPath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  const calls: RecomputedCall[] = [];
  const modelCounts = new Map<string, number>();
  let totalCostUSD = 0;
  let cumulativeInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let lastInputTokens = 0;

  for (const line of lines) {
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // 损坏行跳过
    }
    if (!evt || evt.event !== "AfterModelRaw") continue;

    const data = evt.data ?? {};
    const u = data.usage ?? {};
    const model = data.model ?? "";
    const inputTokens = Number(u.input_tokens ?? 0) || 0;
    const outputTokens = Number(u.output_tokens ?? 0) || 0;
    // cache_read / cache_creation：兼容两种键名（AfterModelRaw 用短名，历史/raw 用长名）。
    // cache_creation 自 2026-07 补落；补落前的历史会话该字段缺失 → 取 0（重算仍偏低，best-effort）。
    const cacheReadTokens = Number(u.cache_read ?? u.cache_read_input_tokens ?? 0) || 0;
    const cacheCreationTokens = Number(u.cache_creation ?? u.cache_creation_input_tokens ?? 0) || 0;
    // provider / base_url：AfterModelRaw 已落盘（provider 自 T12.4、base_url 自本次改造）。
    // provider 影响 normalizeCacheUsage 三段拆分；base_url 使 (model, endpoint) 复合键精确匹配
    // （修正同名不同渠道重算错价）。历史会话缺这两字段 → undefined，退回 model-only（best-effort）。
    const provider = typeof data.provider === "string" ? data.provider : undefined;
    const baseURL = typeof data.base_url === "string" ? data.base_url : undefined;

    // 重算单次 cost：用 cost-tracker 的独立函数（不依赖 SessionState 实例），
    // 与主循环 / SessionState.calculateCost 同口径（都走 normalizeCacheUsage + resolvePricing）。
    const usage: Usage = {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: cacheReadTokens,
      cacheCreationInputTokens: cacheCreationTokens,
    };
    const costUSD = calculateUSDCost(model, usage, availableModels, provider, baseURL);

    calls.push({
      index: Number(data.index ?? calls.length + 1),
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      costUSD,
    });
    totalCostUSD += costUSD;
    cumulativeInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalCacheReadTokens += cacheReadTokens;
    totalCacheCreationTokens += cacheCreationTokens;
    lastInputTokens = inputTokens; // 末次覆盖（stock）
    if (model) modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
  }

  if (calls.length === 0) return null;

  // 主导模型 = 出现次数最多者
  let model = "";
  let maxCount = 0;
  for (const [m, c] of modelCounts) {
    if (c > maxCount) {
      maxCount = c;
      model = m;
    }
  }

  return {
    totalCostUSD,
    apiCalls: calls.length,
    lastInputTokens,
    cumulativeInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    model,
    calls,
    source: "events-recompute",
  };
}

/**
 * 读取一个会话的 session.traj 的 total_cost_usd（不存在 / 解析失败返回 null）。
 * 用于 §6.4 交叉校验：比较 traj 记录值与 events 重算值。
 */
export function readTrajCost(sessionDir: string): number | null {
  const trajPath = `${sessionDir}/session.traj`;
  if (!existsSync(trajPath)) return null;
  try {
    const obj = JSON.parse(readFileSync(trajPath, "utf-8"));
    const v = obj?.metadata?.total_cost_usd;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** backfillTrajCost 的结果 */
export interface BackfillResult {
  /** 是否实际写回了 traj */
  backfilled: boolean;
  /** 原因 / 状态描述 */
  reason: string;
  /** traj 原有 cost（写回前） */
  oldCost?: number;
  /** events 重算 cost */
  recomputedCost?: number;
  /**
   * 本次扫描对 `session.traj` 的**损坏判定结论**，供调用方补认领 session-index 的
   * `traj_corrupt`（P2-14 的度量盲区）。
   *
   * - `true`：traj 存在但 `JSON.parse` 失败（情形 A'，下面会备份 + 重建）。
   * - `false`：traj 存在且解析成功 —— 已检测、未损坏。
   * - `undefined`：**没检测**（traj 文件不存在，或 events 里没有可重算事件而提前返回）。
   *   不能兜底成 `false`：那会把「没检测」谎报成「已检测且未损坏」。
   *
   * 为什么这个结论必须**返回出去**而不是就地用完扔掉：本函数是崩溃会话
   * （`kill -9` / OOM，SessionEnd 从未运行）**唯一**还会去读它 traj 的地方，
   * 而它读完就把损坏文件重建了 —— 证据当场消失。不返回的话，这类会话的损坏状态
   * 永久无人认领，而它们恰恰是最可能损坏的那批。
   *
   * ⚠ 这里报的是**修复前**的状态。重建成功后 traj 已经是好的，事后再去 parse
   * 一律得到「未损坏」—— 所以损坏率只能在这一刻记账，过了就再也测不到。
   */
  trajCorrupt?: boolean;
}

/**
 * §6.2 / §6.4：从 events.jsonl 重算 cost，并在 traj 缺失或 cost 明显偏低时补写回 session.traj。
 *
 * 触发条件（满足任一即补写）：
 *   - session.traj 不存在（中断/僵尸会话连 traj 都没写出）
 *   - traj 的 total_cost_usd 为 0 / 缺失，但 events 重算出非零 cost（修复前的历史会话）
 *   - traj cost 与 events 重算 cost 偏差超过阈值（默认 1%），且 events 值更大（traj 少采）
 *
 * **幂等**：补写后在 metadata 标记 `cost_recomputed_from_events=true`，再次扫描到时跳过。
 * **安全**：只补写「明显缺失/偏低」的情形，不覆盖已有的合理权威值（traj cost ≥ events cost 时不动，
 * 因为 traj 经 SessionState 覆盖的值含 cache_creation，比 events 重算更全）。
 *
 * @param sessionDir 会话目录
 * @param availableModels 用户配置模型列表（携带权威 pricing）
 * @param opts.deviationThreshold 偏差阈值（0-1），默认 0.01（1%）
 * @returns 补写结果
 */
export function backfillTrajCost(
  sessionDir: string,
  availableModels?: PricingModelEntry[],
  opts?: { deviationThreshold?: number },
): BackfillResult {
  const log = getLogger();
  const threshold = opts?.deviationThreshold ?? 0.01;
  const trajPath = `${sessionDir}/session.traj`;

  const recomputed = recomputeCostFromEvents(sessionDir, availableModels);
  if (!recomputed) {
    // 没有可重算事件就没往下走，也就**没读过 traj** → 不给损坏结论（不是 false）
    return { backfilled: false, reason: "events.jsonl 无可重算的 AfterModelRaw 事件" };
  }

  // ── 情形 A：session.traj 不存在 → 直接据 events 构造一份最小 traj ──
  // 文件不存在**不算损坏**，也不算「已检测未损坏」：没有文件就没有可判的对象，
  // 所以 trajCorrupt 留 undefined。把它算成 false 会把「连 traj 都没写出来」
  // 混进损坏率的分母，那是另一个缺口（该由索引会话数 vs 轨迹会话数的断言去管）。
  if (!existsSync(trajPath)) {
    try {
      const minimalTraj = buildMinimalTrajFromRecompute(sessionDir, recomputed);
      Bun.write(trajPath, JSON.stringify(minimalTraj, null, 2));
      log.info(
        "TRACE",
        `§6.2 僵尸会话补写 traj: ${sessionDir} cost=$${recomputed.totalCostUSD.toFixed(4)} (${recomputed.apiCalls} calls)`,
      );
      return {
        backfilled: true,
        reason: "traj 缺失，据 events 重算补写",
        recomputedCost: recomputed.totalCostUSD,
      };
    } catch (err) {
      return { backfilled: false, reason: `补写 traj 失败: ${err}` };
    }
  }

  // ── 情形 B/C：traj 存在，检查 cost 是否缺失/偏低 ──
  let obj: any;
  try {
    obj = JSON.parse(readFileSync(trajPath, "utf-8"));
  } catch (err) {
    // ★ 情形 A'：traj 存在但**已损坏**（2026-08-07 事故：落盘脱敏把 JSON 小数改写成
    // `0.4428********0257`，整份文件不可解析）。此前这里直接放弃，于是损坏的 traj
    // 永久损坏——而 events.jsonl 是 append 语义、并未受损，cost 完全可以重算。
    // 损坏文件没有任何可保留的权威值，等价于「不存在」，按情形 A 重建。
    // 原文件另存为 .corrupt 备份：万一里面有 events 无法复原的内容（history 等），
    // 用户仍可手工抢救——删掉用户数据的代价远高于留一个备份文件。
    try {
      const backupPath = `${trajPath}.corrupt`;
      if (!existsSync(backupPath)) {
        Bun.write(backupPath, readFileSync(trajPath));
      }
      const minimalTraj = buildMinimalTrajFromRecompute(sessionDir, recomputed);
      Bun.write(trajPath, JSON.stringify(minimalTraj, null, 2));
      log.warn(
        "TRACE",
        `session.traj 损坏（${err}），已据 events.jsonl 重建；` +
          `原文件备份至 ${backupPath}，cost=$${recomputed.totalCostUSD.toFixed(4)}`,
      );
      return {
        backfilled: true,
        reason: "traj 损坏（不可解析），据 events 重算重建（原文件已备份 .corrupt）",
        recomputedCost: recomputed.totalCostUSD,
        // ★ 损坏率的唯一记账时机：下一行代码起 traj 已被重建成好文件，
        // 事后任何 parse 都只会得到「未损坏」。
        trajCorrupt: true,
      };
    } catch (err2) {
      // 重建失败**不改变**「它确实是损坏的」这个事实 —— 损坏结论与修复成败无关，
      // 混在一起会让「修不好的损坏」从损坏率里消失（越坏的越测不到）。
      return { backfilled: false, reason: `traj 损坏且重建失败: ${err2}`, trajCorrupt: true };
    }
  }

  // 走到这里说明 `JSON.parse` 成功了 —— 这是一次**真实的、结论为「未损坏」的检测**，
  // 与增量行那种「没检测」有本质区别，所以下面每条返回都带 trajCorrupt: false。
  // 别把它省掉：漏一条就等于在损坏率的分母上少一个健康样本，比值被抬高。
  const md = obj?.metadata;
  if (!md) return { backfilled: false, reason: "traj 无 metadata", trajCorrupt: false };

  // 幂等：已补写过则跳过。
  // 注意 cost 补写幂等**不影响**损坏结论：cost 只需补一次，而「这次扫描时它是好的」
  // 每次都是一个当场成立的观测，照常返回。
  if (md.cost_recomputed_from_events === true) {
    return { backfilled: false, reason: "已补写过（幂等跳过）", trajCorrupt: false };
  }

  const oldCost = typeof md.total_cost_usd === "number" ? md.total_cost_usd : 0;
  const newCost = recomputed.totalCostUSD;

  // 只在「traj cost 缺失/为 0」或「traj 明显低于 events 重算」时补写。
  // traj cost ≥ events cost 时不动：SessionState 权威值始终不劣于 events 重算
  //（新会话两边都含 cache_creation；补落前的历史会话 events 缺该字段反而偏低）。
  const isMissing = oldCost === 0;
  const isUndercount = newCost > 0 && oldCost > 0 && (newCost - oldCost) / newCost > threshold;

  if (!isMissing && !isUndercount) {
    return {
      backfilled: false,
      reason: "traj cost 合理（≥ events 重算值），不覆盖",
      oldCost,
      recomputedCost: newCost,
      trajCorrupt: false,
    };
  }
  if (newCost <= 0) {
    return {
      backfilled: false,
      reason: "events 重算 cost 为 0，无需补写",
      oldCost,
      recomputedCost: newCost,
      trajCorrupt: false,
    };
  }

  // 写回：更新 cost + 标记来源，保留其余字段
  try {
    md.total_cost_usd = newCost;
    md.cost_recomputed_from_events = true;
    // 同步补写 cache token 明细（此前僵尸会话补写只更新 cost，cache 内訳保持旧值/0）
    if (typeof md.total_cache_read_tokens === "number") {
      md.total_cache_read_tokens = recomputed.totalCacheReadTokens;
    }
    if (typeof md.total_cache_creation_tokens === "number") {
      md.total_cache_creation_tokens = recomputed.totalCacheCreationTokens;
    }
    md.cost_recompute_detail = {
      old_cost_usd: oldCost,
      recomputed_cost_usd: newCost,
      recomputed_api_calls: recomputed.apiCalls,
      source: recomputed.source,
      note: "events.jsonl AfterModelRaw 重算（含 cache_creation；补落前的历史会话缺该字段时略偏低）",
    };
    if (obj.info?.model_stats) {
      obj.info.model_stats.total_cost_usd = newCost;
    }
    Bun.write(trajPath, JSON.stringify(obj, null, 2));
    log.info(
      "TRACE",
      `§6.4 traj cost 校正: ${sessionDir} $${oldCost.toFixed(4)} → $${newCost.toFixed(4)}`,
    );
    return {
      backfilled: true,
      reason: isMissing ? "traj cost 缺失，据 events 补写" : "traj cost 偏低，据 events 校正",
      oldCost,
      recomputedCost: newCost,
      trajCorrupt: false,
    };
  } catch (err) {
    return {
      backfilled: false,
      reason: `写回 traj 失败: ${err}`,
      oldCost,
      recomputedCost: newCost,
      trajCorrupt: false,
    };
  }
}

/**
 * 据 events 重算结果构造一份最小 traj（仅当原 traj 完全缺失时用，§6.2）。
 * 字段尽量对齐 builder.ts 的 TrajectoryMetaOutput，但只填重算能提供的部分，
 * 其余标注为 recompute 来源，避免与正常 traj 混淆。
 */
function buildMinimalTrajFromRecompute(sessionDir: string, r: RecomputedCost): object {
  const sessionId = sessionDir.split("/").filter(Boolean).pop() ?? "";
  return {
    trajectory: [],
    history: [],
    info: {
      model_stats: {
        tokens_sent: r.lastInputTokens,
        tokens_received: r.totalOutputTokens,
        cache_read_tokens: r.totalCacheReadTokens,
        cache_creation_tokens: r.totalCacheCreationTokens,
        api_calls: r.apiCalls,
        total_cost_usd: r.totalCostUSD,
      },
      exit_status: "interrupted",
      has_thinking: false,
    },
    metadata: {
      session_id: sessionId,
      model: r.model,
      total_api_calls: r.apiCalls,
      total_tokens_sent: r.lastInputTokens,
      total_tokens_received: r.totalOutputTokens,
      total_cumulative_prompt_tokens: r.cumulativeInputTokens,
      total_cache_read_tokens: r.totalCacheReadTokens,
      total_cache_creation_tokens: r.totalCacheCreationTokens,
      total_tokens: r.lastInputTokens + r.totalOutputTokens,
      total_cost_usd: r.totalCostUSD,
      exit_status: "interrupted",
      tool_source: "sid-code",
      // 标记：本 traj 由 events 重算补写，非 SessionEnd 正常落盘
      cost_recomputed_from_events: true,
      cost_recompute_detail: {
        recomputed_cost_usd: r.totalCostUSD,
        recomputed_api_calls: r.apiCalls,
        source: r.source,
        note: "session.traj 缺失（僵尸/中断会话），据 events.jsonl AfterModelRaw 重算补写",
      },
    },
  };
}
