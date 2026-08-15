/**
 * 会话指标索引（session-index）—— 让轨迹类指标不随 LRU 清理消失（P0-2）。
 *
 * ## 为什么需要它
 *
 * `trace/collector.ts` 的 `pruneOldSessions()` 在会话数超过 `maxSessionsRetained`
 *（默认 100）时 `rmSync` 整个会话目录，`session-summary.json` 与 `events.jsonl`
 * 一起消失。后果不是"少了些历史文件"，而是**所有基于轨迹的指标不可复现**：
 *
 * 实测同一台机器上 TTFT p50 从文档记录的 4.7s（1032 样本）变成 3.3s（1399 样本）。
 * 这**不是 1.4s 的性能改善** —— 是 LRU 把当年那批会话删了，两次测的不是同一批样本。
 * 一个不可复现的指标证明不了任何改进，这比"指标不准"更严重：不准至少方向一致，
 * 不可复现连方向都没有。而四个北极星方向的第 3 级全部是「release-over-release 曲线」。
 *
 * ## 为什么不是"把 LRU 上限从 100 改成 1000"
 *
 * 1. **只是推迟**：跑够 1000 个会话后同样问题重现，届时数据量 ×10。
 * 2. **本地磁盘不该无限涨**：LRU 的设计意图（优先删已上传的）本身是对的。
 * 3. **真正需要长留的不是原始轨迹，是每会话的指标摘要** —— 摘要 ≈500B，
 *    原始轨迹 45MB，差两个数量级。删原始轨迹、留摘要，两个目标都能满足。
 *
 * 所以 `pruneOldSessions()` **不改**，只是它不再是唯一的数据留存路径。
 *
 * ## 设计契约
 *
 * - **路径与 `trajectories/` 同级**（`~/.sid-code/session-index.jsonl`），不在其下 ——
 *   否则将来任何对 `trajectories/` 的清理都会连带删掉它，白做。
 * - **upsert 语义**（按 sessionId，latest-wins），与 `telemetry/usage-ledger.ts`
 *   的 `upsertUsageLedger` 一致：长驻会话每轮 flush 不会让行数翻倍。
 * - **字段复用 digest 的结论，不另算一套**。collector 一套、digest 一套必然漂移出
 *   两套结论 —— 这与 `persistSessionSummary()` 的设计契约是同一条。
 * - **只存聚合数字，绝不存消息内容 / prompt 全文**（隐私），与账本同一条红线。
 * - **写失败静默**：采集永不阻塞主循环。
 *
 * 存储位置可经 `SID_CODE_SESSION_INDEX` 环境变量重定向（测试隔离用）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";

/**
 * 单会话指标索引行。
 *
 * 字段选择原则：**够回答「这个 release 比上个更快/更省/更少返工吗」即止**。
 * 不做成第二份 digest —— 需要细节回原始轨迹（若还在）或 digest 拿。
 */
export interface SessionIndexEntry {
  /** 会话 id（upsert 主键） */
  session_id: string;
  /** 写入时刻（秒，Unix epoch）。用它做时间窗过滤，不依赖文件 mtime */
  ts: number;

  /**
   * P0-1 的产物：写这行的 sid-code 版本号（裸 x.y.z）。
   * **这是飞轮维度的唯一分组键** —— 没有它整份索引只是一堆无法分组的样本。
   */
  app_version?: string;

  model: string;
  exit_status: string;
  /** 会话时长（毫秒） */
  duration_ms: number;
  /** API 调用轮数。会话长度是成本最大杠杆（2× 轮数 ≈ 3~4× 成本） */
  turns: number;
  total_steps: number;
  cost_usd: number;
  tokens_sent: number;
  tokens_received: number;

  /**
   * 本会话内的 TTFT 分位数（毫秒）。样本不足时为 undefined —— **不是 0**：
   * 落 0 会被读成"首字节 0 毫秒"，而真相是"这个会话没有可用样本"。
   */
  ttft_p50?: number;
  ttft_p95?: number;
  /**
   * 本会话 TTFT 样本数，**恒落（无样本为 0）**。
   *
   * 与上面分位数相反的处理：分位数缺失表示"无样本"，而 n 恒落是为了让
   * "该版本没接埋点"（n 键不存在，只可能出现在历史行）与"接了但这次没样本"
   * （n=0）分得开。不标 n 还会让人误以为单会话分位数与全量同等置信。
   */
  ttft_n: number;

  /**
   * 端到端耗时分位数（毫秒）—— PR-4（P1-4）的产物，此前无埋点。
   * 字段先占位，让索引字段集从第一天稳定，PR-4 落地后不必迁移历史行。
   */
  e2e_p50?: number;
  e2e_p95?: number;
  /** 端到端样本数，恒落。理由同 `ttft_n` */
  e2e_n: number;

  /** 真错误数（digest 的 real_errors 口径，不含 L1 假设与已知假阳性） */
  real_errors: number;
  /** high+medium 异常总数（含假阳性，供参考） */
  anomalies_count: number;
  /** 过程病态项列表（如 retry_wasted_tokens / observation_entropy） */
  pathological: string[];
  /** 上下文压缩次数：压缩丢信息 → 重读文件 → 重复付费 */
  compactions: number;

  /**
   * 本会话是否触发过四环防线（hypothesis_register / hypothesis_challenge /
   * verify 子代理）。
   *
   * 存 bool 而非计数：防线触发率的分母是**会话数**（见
   * `scripts/defense-trigger-rate.ts`），存计数会诱使消费侧拿调用次数当分子，
   * 那是另一个口径。
   */
  defense_triggered: boolean;

  /**
   * P2-14：本会话的 `session.traj` 是否损坏。
   *
   * 实测 1/56 = 1.8% 的损坏率 —— collector 有损坏检测与降级保存（好事），
   * 但**没有任何指标统计"多少会话的轨迹坏了"**。如果它涨到 20% 也不会有人知道。
   * 采集器自身的健康度是所有度量可信度的前提，所以它进「底座」方向的辅助指标。
   */
  traj_corrupt: boolean;
}

/** 应用 `SID_CODE_SESSION_INDEX` 重定向。语义与 `applyLedgerPathOverride` 一致 */
export function applySessionIndexPathOverride(defaultPath: string): string {
  const override = process.env.SID_CODE_SESSION_INDEX;
  // 空串/纯空白视为未设置：否则 `SID_CODE_SESSION_INDEX=""` 会让写侧落到空路径，
  // 表现为"明明写了却读不到"（账本踩过这个坑，见 applyLedgerPathOverride 注释）
  if (override && override.trim() !== "") return override;
  return defaultPath;
}

/** 索引文件路径（测试可经环境变量重定向） */
export function sessionIndexPath(): string {
  return applySessionIndexPathOverride(sidPaths.sessionIndex());
}

/**
 * upsert 一行会话指标（按 session_id 去重，latest-wins）。
 *
 * 必须 upsert 而非 append 的理由与账本完全相同：消费侧按行累加/计数，
 * 一个 30 轮会话若每轮 append 就会让"会话数"翻 30 倍。
 *
 * 失败静默 —— 索引写不进去绝不能影响会话本身。
 */
export function upsertSessionIndex(entry: SessionIndexEntry): void {
  try {
    const path = sessionIndexPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existing = readSessionIndex().filter((e) => e.session_id !== entry.session_id);
    existing.push(entry);
    writeFileSync(path, existing.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  } catch {
    // 写盘失败静默忽略（不变量：采集永不阻塞主流程）
  }
}

/** 读取索引全部行（损坏行跳过，绝不抛错） */
export function readSessionIndex(): SessionIndexEntry[] {
  try {
    const path = sessionIndexPath();
    if (!existsSync(path)) return [];
    const result: SessionIndexEntry[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line);
        // 只认有 session_id 的行：它是 upsert 主键，缺了这行无法参与任何聚合
        if (parsed && typeof parsed === "object" && typeof parsed.session_id === "string") {
          result.push(parsed as SessionIndexEntry);
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
 * 裁剪索引：只保留最近 maxSessions 行。返回剩余行数，失败返回 -1。
 *
 * **不自动调用** —— 索引的量级（10 万会话 ≈ 50MB）不需要自动清理，
 * 而自动清理正是 P0-2 要治的病。仅供 `/trace --prune-index N` 手动使用，
 * 对齐账本的 `/cache --prune`。
 */
export function pruneSessionIndex(maxSessions: number): number {
  try {
    const path = sessionIndexPath();
    if (!existsSync(path)) return 0;
    const all = readSessionIndex();
    const kept = all.length > maxSessions ? all.slice(all.length - maxSessions) : all;
    writeFileSync(path, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    return kept.length;
  } catch {
    return -1;
  }
}

/**
 * 从一份 `session-summary.json` 形态的对象 + 补充信号构造索引行。
 *
 * 独立成纯函数的理由：collector 里那段是副作用路径（读文件、跑 digest、写盘），
 * 而"字段怎么映射"是纯逻辑。分开后字段映射可以被单测直接覆盖，
 * 不必先造一个完整会话。
 */
export function buildSessionIndexEntry(
  summary: Record<string, unknown>,
  extra: {
    ts: number;
    app_version?: string;
    ttft?: { p50?: number; p95?: number; n?: number };
    e2e?: { p50?: number; p95?: number; n?: number };
    defense_triggered?: boolean;
    traj_corrupt?: boolean;
    compactions?: number;
  },
): SessionIndexEntry {
  const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
  return {
    session_id: String(summary.session_id ?? ""),
    ts: extra.ts,
    ...(extra.app_version ? { app_version: extra.app_version } : {}),
    model: String(summary.model ?? ""),
    exit_status: String(summary.exit_status ?? ""),
    duration_ms: num(summary.duration_ms),
    turns: num(summary.turns),
    total_steps: num(summary.total_steps),
    cost_usd: num(summary.cost_usd),
    tokens_sent: num(summary.tokens_sent),
    tokens_received: num(summary.tokens_received),
    // 分位数用「有值才写」：落 0 会被读成"0 毫秒"，而缺失才准确表达"无样本"。
    ...(extra.ttft?.p50 !== undefined ? { ttft_p50: extra.ttft.p50 } : {}),
    ...(extra.ttft?.p95 !== undefined ? { ttft_p95: extra.ttft.p95 } : {}),
    ...(extra.e2e?.p50 !== undefined ? { e2e_p50: extra.e2e.p50 } : {}),
    ...(extra.e2e?.p95 !== undefined ? { e2e_p95: extra.e2e.p95 } : {}),
    // 但**样本数 n 恒落**（缺省 0），与分位数相反：
    // - 分位数缺失 = "没有样本"，落 0 会被误读成 0 毫秒
    // - n 缺失 = "该版本还没接这个埋点"，与 n=0（"接了但这次没样本"）是两件事
    // 两者都塌缩成缺失的话，PR-4 上线后就分不清"埋点没生效"与"这次真没样本"。
    ttft_n: extra.ttft?.n ?? 0,
    e2e_n: extra.e2e?.n ?? 0,
    real_errors: num(summary.real_errors),
    anomalies_count: num(summary.anomalies_count),
    pathological: Array.isArray(summary.pathological) ? (summary.pathological as string[]) : [],
    compactions: num(extra.compactions),
    defense_triggered: extra.defense_triggered === true,
    traj_corrupt: extra.traj_corrupt === true,
  };
}
