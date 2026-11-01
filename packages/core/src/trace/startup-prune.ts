/**
 * 轨迹目录的启动期清理（T1 / T2）：体积兜底淘汰 + 历史空壳清理。
 *
 * ⚠️ 2026-11-01 从 `TraceCollector` 构造函数搬出来。原先每次 new TraceCollector 都同步跑这两遍
 * 全量扫描（readdirSync 579 个目录 + 每个目录读 marker / 递归 dirBytes，本机实测约 290ms），
 * 耗时随轨迹目录数线性增长，且发生在 TUI 首帧之前。现在只由**维护子进程**
 * （`maintenance/runner.ts`）调用，TUI 进程的构造函数里一行都不留——
 * 不变量见 `.agents/notes/implemented/bug-fix/2026-11-01-启动维护任务迁入子进程.md`。
 *
 * 判据本身逐字未改（只是 this.x → 参数），删除保守性的论证仍在各函数注释里。
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../debug/logger.ts";
import { listActiveSessions } from "../session/concurrent.ts";
import { hasFinalUploadMarker } from "./upload-marker.ts";
import { selectTraceDirsToPrune, type TraceDirEntry } from "./retention.ts";
import type { StaleBlankPruneResult } from "./collector.ts";
import {
  DEFAULT_SESSION_MAX_TOTAL_SIZE,
  DEFAULT_SESSION_MIN_RETENTION,
  parseRetentionPeriod,
  parseRetentionSize,
  type SessionRetentionSettings,
} from "../session/retention.ts";

export interface TracePruneOptions {
  /** 轨迹根目录（`.../trajectories`） */
  outputDir: string;
  /** 数量上限，undefined = 不限 */
  maxSessionsRetained?: number;
  /** 体积上限（字节），undefined = 不按体积删 */
  maxTotalBytes?: number;
  /** 更新时间在此窗口内的目录不删（毫秒） */
  minRetentionMs: number;
}

/**
 * 由会话保留策略得到轨迹淘汰参数（原 `query/init-helpers.ts` 构造 collector 时的那段解析）。
 *
 * 轨迹与会话共用一个体积上限 / 最小保留窗口（session/retention.ts 是单一事实源）；
 * 关闭自动清理时轨迹也不按体积删。解析失败一律退回默认值，不让写错的配置变成「全删」。
 */
export function resolveTracePruneOptions(
  outputDir: string,
  retention: SessionRetentionSettings,
  maxSessionsRetained?: number,
): TracePruneOptions {
  let maxTotalBytes: number | undefined = parseRetentionSize(DEFAULT_SESSION_MAX_TOTAL_SIZE);
  let minRetentionMs = parseRetentionPeriod(DEFAULT_SESSION_MIN_RETENTION);
  if (!retention.enabled) {
    maxTotalBytes = undefined;
  } else {
    try {
      const v = parseRetentionSize(retention.maxTotalSize!);
      maxTotalBytes = v > 0 ? v : undefined;
    } catch {
      getLogger().warn("TRACE", `sessionRetention.maxTotalSize 格式无效，轨迹按默认上限清理`);
    }
    try {
      minRetentionMs = parseRetentionPeriod(retention.minRetention!);
    } catch {
      /* 用默认 */
    }
  }
  return { outputDir, maxSessionsRetained, maxTotalBytes, minRetentionMs };
}

/**
 * 本地轨迹淘汰：默认**不限数量**，只在总体积超过 `maxTotalBytes`（默认 10GB）时删。
 * 优先删已上传的（含 .uploaded 标记）——它们的数据已安全落到远端；
 * 未上传的目录（重试队列待传）即使较旧也尽量保留。活着的进程正在写的会话、
 * `minRetention` 窗口内更新过的目录永不删。选择逻辑在 `trace/retention.ts`（纯函数）。
 * 失败静默：清理不是关键路径，不能阻塞采集。
 *
 * ⚠ 2026-10-10 推翻了此前「默认 100 个、不要调大」的定案：那条论证的前提是
 * 「原始轨迹 ≈45MB/会话」，实测开发者本机 100 个目录合计 37MB（p95 1.3MB）。
 * 一天几十个会话时 100 个只够两三周，调试要的 raw.jsonl / events.jsonl 早被删了。
 * 防盘满改由体积上限承担，与会话保留（PR #218）同口径。
 *
 * 指标的长期留存仍由 `trace/session-index.ts` 承担（P0-2）——本函数删掉目录时
 * `session-summary.json` 一起消失，曲线不能依赖原始轨迹活着。
 */
export function pruneOldTraceSessions(opts: TracePruneOptions): void {
  try {
    const sessionsDir = join(opts.outputDir, "sessions");
    if (!existsSync(sessionsDir)) return;
    if (opts.maxSessionsRetained === undefined && opts.maxTotalBytes === undefined) return;

    const needBytes = opts.maxTotalBytes !== undefined;
    const entries: TraceDirEntry[] = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dir = join(sessionsDir, e.name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(dir).mtimeMs;
        } catch {
          /* 忽略 */
        }
        return {
          id: e.name,
          dir,
          mtimeMs,
          // S11：中途快照（final:false）不算已上传，否则淘汰会优先删掉终态还没上云的会话
          uploaded: hasFinalUploadMarker(dir),
          bytes: needBytes ? dirBytes(dir) : undefined,
        };
      });

    // 跨进程保护：隔壁 sid-code 正在写的会话（resume 时目录名是被恢复的旧 id）
    const protectedIds = new Set<string>();
    try {
      for (const a of listActiveSessions()) {
        protectedIds.add(a.sessionId);
        if (a.logicalSessionId) protectedIds.add(a.logicalSessionId);
      }
    } catch {
      /* 读不到活跃表时只靠 minRetention 窗口保护 */
    }

    const deletable = selectTraceDirsToPrune(entries, {
      maxCount: opts.maxSessionsRetained,
      maxTotalBytes: opts.maxTotalBytes,
      protectAfterMs: Date.now() - opts.minRetentionMs,
      protectedIds,
    });

    let removed = 0;
    for (const e of deletable) {
      try {
        rmSync(e.dir, { recursive: true, force: true });
        removed++;
      } catch {
        /* 单个删除失败不影响其余 */
      }
    }
    if (removed > 0) {
      getLogger().info(
        "TRACE",
        `轨迹清理：本地 ${entries.length} 个会话目录，已删除最旧 ${removed} 个` +
          `（上限：数量 ${opts.maxSessionsRetained ?? "不限"}，体积 ${opts.maxTotalBytes ?? "不限"} 字节）`,
      );
    }
  } catch (err) {
    getLogger().warn("TRACE", `轨迹清理失败（不影响采集）: ${err}`);
  }
}

/**
 * 启动时清理「历史遗留空壳会话」——打开即退、从未发生任何 LLM 调用的空目录。
 *
 * 为什么需要它（2026-08-07 实测）：空壳本该在 SessionEnd 由 `cleanupIfBlankSession()`
 * 删掉，但实测 `SessionStart` 75 次 : `SessionEnd` 9 次 —— **绝大多数进程根本走不到
 * SessionEnd**（Ctrl-C / kill / 终端直接关掉都不会触发）。于是清理逻辑虽然正确，
 * 却几乎从不执行，盘上堆了 42 个只含 SessionStart 的空目录。
 *
 * 这些空壳造成的真实伤害不是占磁盘，而是**污染度量口径**：按目录数算
 * 「session.traj 覆盖率」得到 33%，看起来像个 P0 采集缺陷；按「有真实 LLM 调用的
 * 会话」算则是 100%。分母被空壳灌水，一个健康指标就长得像故障。
 *
 * ⚠ 删除判据必须极度保守——删错等于毁掉用户的排查现场。四个条件全部满足才删：
 *   1. 有 events.jsonl（否则可能是正在初始化的新会话，交给 LRU 管）
 *   2. events.jsonl 里**只有** SessionStart / GatewayPricingSync 这类"未开工"事件；
 *      出现任何一条工作类事件（BeforeModel / PreToolUse / UserPromptSubmit …）即保留
 *   3. 目录里没有任何数据文件（session.traj / raw.jsonl / messages.json / crash.json …）
 *   4. 目录 mtime 超过 STALE_BLANK_AGE_MS（默认 1 小时）——避免误删**当前正在运行**
 *      的其它 sid-code 进程刚建的目录（多开终端是常态）
 *
 * 条件 2 用**白名单**而非黑名单：新增事件类型时，未知事件默认被当作"有活动"从而
 * 保留目录。判据宁可漏删，绝不能误删。
 *
 * ── P2-11：另有一条**独立**判据分支（2026-08-14 实测）──
 *
 * 上面四个条件有个缝：条件 1 要求「有 events.jsonl」，而实测 82 个目录里有 24 个
 * **完全为空**（`ls -A` 无任何内容），连 events.jsonl 都没有 → 被条件 1 直接排除；
 * LRU 那道机制也没删（82 < 100 未触发上限）。它们正好掉在两道清理机制之间。
 *
 * 修法是**新增一条独立分支**，而不是放宽条件 1 —— 条件 1 保护的是"正在初始化的
 * 新会话"（目录已建、events.jsonl 还没写第一行），放宽它会误删并发 sid-code 进程
 * 刚建的目录，而多开终端是常态。独立分支 + 更长的静置阈值（24h vs 1h）风险最小：
 * 一个已经空了整天的目录不可能还是"正在初始化"。
 */
export function pruneStaleBlankTraceSessions(outputDir: string): StaleBlankPruneResult {
  /** "未开工"事件白名单：只出现这些 = 会话从未真正开始工作 */
  const IDLE_ONLY_EVENTS = new Set(["SessionStart", "SessionEnd", "GatewayPricingSync"]);
  /** 除 events.jsonl / warn.log / heartbeat.txt 外，任何文件存在即视为有数据，保留 */
  const IGNORABLE_FILES = new Set(["events.jsonl", "warn.log", "heartbeat.txt"]);
  /** 目录至少静置这么久才考虑删除（防误删其它进程正在用的目录） */
  const STALE_BLANK_AGE_MS = 60 * 60 * 1000;
  /** P2-11 独立分支：完全为空的目录需要静置更久才删（阈值刻意比上面长一个量级） */
  const EMPTY_DIR_AGE_MS = 24 * 60 * 60 * 1000;

  let removed = 0;
  let removedEmpty = 0;
  try {
    const sessionsDir = join(outputDir, "sessions");
    if (!existsSync(sessionsDir)) return { removedBlank: 0, removedEmpty: 0, remaining: 0 };

    const now = Date.now();

    for (const e of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const dir = join(sessionsDir, e.name);
      try {
        // 目录静置时长——两条分支共用这一次 statSync。
        // ⚠ mtimeMs 是浮点数，对刚建的目录 now - mtimeMs 可能算出**负数**
        // （见 MEMORY mtime-float-breaks-maxage-zero）。用 `<` 比较天然把负数
        // 判成"太新，不动"，方向是安全的；但阈值两侧都必须有测试锁死。
        const ageMs = now - statSync(dir).mtimeMs;

        const files = readdirSync(dir, { withFileTypes: true });

        // ── P2-11 独立分支：目录完全为空（ls -A 无内容）且静置 > 24h → 删 ──
        // 放在条件 1 之前，因为条件 1（必须有 events.jsonl）恰好会把这类目录排除掉。
        if (files.length === 0) {
          if (ageMs >= EMPTY_DIR_AGE_MS) {
            rmSync(dir, { recursive: true, force: true });
            removedEmpty++;
          }
          continue;
        }

        // 条件 4：太新的目录不动（可能是别的进程正在跑）
        if (ageMs < STALE_BLANK_AGE_MS) continue;

        // 条件 3：除 events/warn/heartbeat 外有任何文件 → 有数据，保留
        if (files.some((f) => !IGNORABLE_FILES.has(f.name))) continue;

        // 条件 1：必须有 events.jsonl
        const eventsPath = join(dir, "events.jsonl");
        if (!existsSync(eventsPath)) continue;

        // 条件 2：只含"未开工"事件（白名单外的任何事件 → 保留）
        const raw = readFileSync(eventsPath, "utf-8");
        let hasWork = false;
        let hasAny = false;
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          hasAny = true;
          let name: unknown;
          try {
            name = (JSON.parse(line) as { event?: unknown }).event;
          } catch {
            // 坏行无法判定 → 按"有活动"处理，保留目录
            hasWork = true;
            break;
          }
          if (typeof name !== "string" || !IDLE_ONLY_EVENTS.has(name)) {
            hasWork = true;
            break;
          }
        }
        if (hasWork || !hasAny) continue;

        rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch {
        /* 单个目录失败不影响其余 */
      }
    }

    if (removed > 0 || removedEmpty > 0) {
      getLogger().info(
        "TRACE",
        `清理历史空壳会话 ${removed} 个（只含 SessionStart、无任何 LLM 调用）` +
          `+ 完全空目录 ${removedEmpty} 个——` +
          `它们会把"traj 覆盖率"这类指标的分母灌水`,
      );
    }
    return {
      removedBlank: removed,
      removedEmpty,
      remaining: countSessionDirs(outputDir),
    };
  } catch (err) {
    getLogger().warn("TRACE", `空壳会话清理失败（不影响采集）: ${err}`);
    return { removedBlank: removed, removedEmpty, remaining: countSessionDirs(outputDir) };
  }
}

/**
 * 数一下 sessions/ 下还剩多少目录（不含隐藏项）。
 *
 * 只用于清理结果的 `remaining` 字段——它是「盘上目录数」这个**分母口径**的取数源。
 * P2-11 要求指标输出同时报两个分母（有效会话数 / 盘上目录数），避免只给一个数字
 * 然后被质疑口径。消费端（session-index.jsonl + northstar-snapshot，属 PR-2/PR-5）
 * 尚未合并，本函数先把数据备好。
 */
function countSessionDirs(outputDir: string): number {
  try {
    const sessionsDir = join(outputDir, "sessions");
    if (!existsSync(sessionsDir)) return 0;
    return readdirSync(sessionsDir, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && !e.name.startsWith("."),
    ).length;
  } catch {
    return 0;
  }
}

/** 目录递归字节数（单项失败忽略） */
function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      try {
        total += e.isDirectory() ? dirBytes(full) : statSync(full).size;
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 目录不可读 */
  }
  return total;
}
