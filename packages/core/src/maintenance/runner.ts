/**
 * 启动维护子进程的执行体（`sid-code __maintenance <payload-json>`）。
 *
 * ## 不变量（PR-B 立住，e2e 门禁锁住）
 *
 * TUI 进程在首帧前和交互期间，主线程不做任何耗时随 `~/.sid-code/` 数据量增长的工作。
 * 扫目录、读整个文件、批量删除这类启动期维护任务，一律在这里跑——TUI 只负责发起，
 * 不等结果，也不持有它的内存。
 *
 * ## 为什么子进程不 loadConfig
 *
 * 父进程已经解析好了生效值（保留策略、轨迹目录、受保护会话 id），通过 argv 传进来。
 * 子进程再 loadConfig 会重复一遍 settings/MCP/企业配置的读取，并可能有落盘副作用；
 * 更重要的是父子两边对「保留期」的口径必须是**同一个值**（startup-housekeeping.ts
 * 头注释记过会话 30d / 轨迹 365d 的事故）。传值比各读各的可靠。
 */

import type { SessionRetentionSettings } from "../session/retention.ts";
import type { Config } from "../config/config.ts";
import { getLogger, initLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";
import {
  markTaskDone,
  releaseMaintenanceLock,
  tryAcquireMaintenanceLock,
  writeMaintenanceResult,
  type MaintenanceResult,
  type MaintenanceTask,
} from "./state.ts";

/** 父进程 → 子进程的参数（argv[1] 的 JSON） */
export interface MaintenancePayload {
  tasks: MaintenanceTask[];
  retention: SessionRetentionSettings;
  /** 发起维护的 TUI 进程会话 id（已 registerSession） */
  selfSessionId?: string;
  /** D3：被恢复的旧会话 id（resumedSessionIdForCleanup），列入受保护名单 */
  protectedSessionIds?: string[];
  /** 轨迹根目录（config.trace.outputDir ?? sidPaths.trajectories()） */
  traceOutputDir: string;
  /** config.trace.maxSessionsRetained */
  maxSessionsRetained?: number;
  /** 测试用：忽略 housekeeping 自身的 24h 水位线 */
  forceHousekeeping?: boolean;
}

export function parseMaintenancePayload(raw: string | undefined): MaintenancePayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as MaintenancePayload;
    if (!p || !Array.isArray(p.tasks) || !p.retention || typeof p.traceOutputDir !== "string") {
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

/** 降调度优先级，避免和 TUI 抢 CPU（失败忽略：Windows / 无权限时不影响功能） */
function lowerPriority(): void {
  try {
    const os = require("node:os") as typeof import("node:os");
    os.setPriority(process.pid, 10);
  } catch {
    /* 忽略 */
  }
}

/**
 * 跑一轮维护。返回结果对象（同时落盘）；抢不到锁时返回 null（已有维护进程在跑）。
 * 导出给测试直接调用——不经过子进程也能验证每个任务的接线。
 */
export async function runMaintenance(
  payload: MaintenancePayload,
): Promise<MaintenanceResult | null> {
  if (!tryAcquireMaintenanceLock()) {
    getLogger().info("MAINTENANCE", "已有维护进程在运行，本轮跳过");
    return null;
  }
  const result: MaintenanceResult = {
    pid: process.pid,
    startedAt: Date.now(),
    finishedAt: 0,
    tasks: {},
  };
  const run = async (task: MaintenanceTask, fn: () => Promise<void> | void) => {
    if (!payload.tasks.includes(task)) return;
    const t0 = performance.now();
    try {
      await fn();
      markTaskDone(task);
      result.tasks[task] = { ok: true, durationMs: Math.round(performance.now() - t0) };
    } catch (err) {
      // 单个任务失败不影响其余任务；水位线不刷新 → 下次启动重试
      result.tasks[task] = {
        ok: false,
        durationMs: Math.round(performance.now() - t0),
        error: String(err),
      };
      getLogger().warn("MAINTENANCE", `${task} 失败: ${err}`);
    }
  };

  try {
    // 会话清理（C1/C2）：轻量扫描器，判据与全量扫描器同源
    await run("session-cleanup", async () => {
      if (!payload.retention.enabled) return;
      const { cleanupExpiredSessions } = await import("../session/cleanup.ts");
      // cleanupExpiredSessions 只读 config.trace.outputDir（定位同 id 轨迹目录）
      const config = { trace: { outputDir: payload.traceOutputDir } } as unknown as Config;
      const r = await cleanupExpiredSessions(
        config,
        payload.retention,
        payload.selfSessionId,
        payload.protectedSessionIds,
        { scanner: "light" },
      );
      result.sessionCleanup = { deleted: r.deleted, maxAge: payload.retention.maxAge };
      if (r.deleted > 0) {
        getLogger().info("MAINTENANCE", `会话清理：扫描 ${r.scanned}，删除 ${r.deleted}`);
      }
    });

    // 轨迹目录体积兜底 + 历史空壳（T1/T2），原在 TraceCollector 构造函数里
    await run("trace-prune", async () => {
      const { pruneOldTraceSessions, pruneStaleBlankTraceSessions, resolveTracePruneOptions } =
        await import("../trace/startup-prune.ts");
      pruneOldTraceSessions(
        resolveTracePruneOptions(
          payload.traceOutputDir,
          payload.retention,
          payload.maxSessionsRetained,
        ),
      );
      pruneStaleBlankTraceSessions(payload.traceOutputDir);
    });

    // H1：管家里随数据量增长的清理（自带 .last-cleanup 24h 水位线）
    await run("housekeeping", async () => {
      const { runHousekeepingCleanup } = await import("../config/startup-housekeeping.ts");
      runHousekeepingCleanup(Date.now(), {
        selfSessionId: payload.selfSessionId,
        retention: payload.retention,
        force: payload.forceHousekeeping,
      });
    });
  } finally {
    result.finishedAt = Date.now();
    try {
      // process.resourceUsage().maxRSS 在所有平台都是 KB（Node 已做归一，不同于裸 getrusage 在
      // macOS 上给字节）。第一版按平台分支，编译产物实测写出 61008「字节」——61KB 的 RSS 不可能，才发现。
      result.peakRssBytes = process.resourceUsage().maxRSS * 1024;
    } catch {
      /* 诊断字段，取不到就不填 */
    }
    writeMaintenanceResult(result);
    releaseMaintenanceLock();
  }
  return result;
}

/** 子进程入口（bootstrap.ts 路由到这里） */
export async function runMaintenanceMain(args: string[]): Promise<void> {
  lowerPriority();
  // 维护日志单独一个文件、追加写：它没有终端，排查只能靠这个
  initLogger({
    enabled: true,
    console: false,
    fileOnly: true,
    append: true,
    logFile: sidPaths.log("maintenance.log"),
  });
  const payload = parseMaintenancePayload(args[0]);
  if (!payload) {
    getLogger().error("MAINTENANCE", `参数无效，退出: ${String(args[0]).slice(0, 200)}`);
    return;
  }
  const r = await runMaintenance(payload);
  if (r) {
    getLogger().info(
      "MAINTENANCE",
      `完成 ${JSON.stringify(r.tasks)}，耗时 ${r.finishedAt - r.startedAt}ms，峰值 RSS ${r.peakRssBytes ?? "?"}`,
    );
  }
}
