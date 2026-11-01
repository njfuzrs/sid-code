/**
 * 启动维护子进程的发起端（TUI 进程侧）。
 *
 * 只做 O(1) 的事：读水位线判断哪些任务到期 → 全都没到期就连子进程都不拉起 →
 * 否则 detached + stdio ignore 拉起并立刻 unref。不等结果、不持有它的内存，
 * 子进程可以活过 TUI 退出。
 */

import { spawn } from "node:child_process";
import { resolveExecutable } from "../bootstrap/resolve-executable.ts";
import { getLogger } from "../debug/logger.ts";
import { getSidHome } from "../config/paths.ts";
import { isTaskDue, type MaintenanceTask } from "./state.ts";
import type { MaintenancePayload } from "./runner.ts";

/** bootstrap.ts 识别的内部子命令名（不出现在 --help） */
export const MAINTENANCE_SUBCOMMAND = "__maintenance";

/** 判断本次启动有哪些任务到期（只 stat/读几个小文件） */
export async function dueMaintenanceTasks(
  opts: { sessionCleanup: boolean },
  now: number = Date.now(),
): Promise<MaintenanceTask[]> {
  const tasks: MaintenanceTask[] = [];
  if (opts.sessionCleanup && isTaskDue("session-cleanup", now)) tasks.push("session-cleanup");
  if (isTaskDue("trace-prune", now)) tasks.push("trace-prune");
  const { shouldRunCleanup } = await import("../config/startup-housekeeping.ts");
  if (shouldRunCleanup(now)) tasks.push("housekeeping");
  return tasks;
}

/**
 * 拉起维护子进程。payload.tasks 为空时直接返回 false（不 fork）。
 *
 * ⚠️ 调用前提：本会话已 registerSession()（活跃表里能查到）。子进程靠同一张活跃表
 * 保护「其它活着的进程正在用的会话」，本会话没注册就会退化回
 * 「resume 30 天前的旧会话时它的 checkpoint 被删」（startup-housekeeping.ts 注释）。
 */
export function launchMaintenance(payload: MaintenancePayload): boolean {
  if (payload.tasks.length === 0) return false;
  try {
    const { cmd, baseArgs } = resolveExecutable();
    const child = spawn(cmd, [...baseArgs, MAINTENANCE_SUBCOMMAND, JSON.stringify(payload)], {
      detached: true,
      stdio: "ignore",
      // 显式透传配置根：测试隔离约定要求子进程拿到它（进程内对 env 的改动不会自动继承到
      // 已有的 env 快照之外，这里用当前 process.env 并钉死解析后的值）
      env: { ...process.env, SID_CONFIG_DIR: getSidHome() },
    });
    child.on("error", (err) => {
      getLogger().warn("MAINTENANCE", `维护子进程启动失败: ${err.message}`);
    });
    child.unref();
    getLogger().info(
      "MAINTENANCE",
      `已拉起维护子进程 pid=${child.pid}，任务 ${payload.tasks.join(",")}`,
    );
    return true;
  } catch (err) {
    getLogger().warn("MAINTENANCE", `维护子进程启动失败: ${err}`);
    return false;
  }
}
