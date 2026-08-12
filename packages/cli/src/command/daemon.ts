/**
 * sid-code daemon — 守护进程运维子命令（缺口 C1-1 / C1-5）
 *
 * 用法：
 *   sid-code daemon              前台启动守护进程（调度源 + 可选 webhook）
 *   sid-code daemon start        同上（显式）
 *   sid-code daemon status       查看守护进程状态（pid / 启动时间 / 版本）
 *   sid-code daemon stop         停止运行中的守护进程（向其 pid 发 SIGTERM）
 *   sid-code daemon restart      stop 后重新前台启动
 *   sid-code daemon logs         打印守护进程日志（~/.sid-code/logs/daemon.log）
 *   sid-code daemon install      安装系统服务（macOS launchd / Linux systemd user unit）
 *   sid-code daemon uninstall    卸载系统服务
 *
 * 选项：
 *   --webhook            启用 webhook 源（默认仅当有 SID_CODE_WEBHOOK_SECRET 时开）
 *   --interval <ms>      调度检查间隔（默认 60000）
 *   --max-concurrent <n> 最大并发 headless job（默认 3）
 *   --allowed-tools <a,b> 全局兜底工具白名单（缺省默认只读）
 *   -h, --help           显示帮助
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { sidPaths } from "@sid-code/core/config/paths.ts";

interface DaemonCliOptions {
  webhook: boolean;
  interval?: number;
  maxConcurrent?: number;
  allowedTools?: string[];
  help: boolean;
}

function printHelp(): void {
  console.log(`sid-code daemon — 本地调度守护进程

用法:
  sid-code daemon [start]      前台启动守护进程
  sid-code daemon status       查看守护进程状态
  sid-code daemon stop         停止运行中的守护进程
  sid-code daemon restart      重启守护进程
  sid-code daemon logs         打印守护进程日志
  sid-code daemon install      安装系统服务 (launchd / systemd)
  sid-code daemon uninstall    卸载系统服务

选项:
  --webhook                启用 webhook 源 (默认仅当配置了 SID_CODE_WEBHOOK_SECRET)
  --interval <ms>          调度检查间隔 (默认 60000，每分钟)
  --max-concurrent <n>     最大并发 headless job (默认 3)
  --allowed-tools <a,b,c>  全局兜底工具白名单 (缺省默认只读)
  -h, --help               显示帮助

说明:
  守护进程无人值守，默认安全：未声明白名单的任务以只读 (plan) 模式运行，
  绝不 auto-commit/push (红线 G-13)。每个 job 结果落 trajectories/daemon-jobs。`);
}

function parseDaemonArgs(args: string[]): { sub: string; opts: DaemonCliOptions } {
  // 提取子命令（第一个不以 - 开头且属于已知子命令的）
  let sub = "start";
  const subIdx = args.findIndex((a) => !a.startsWith("-"));
  if (subIdx !== -1 && KNOWN_SUBS.has(args[subIdx])) {
    sub = args[subIdx];
  }

  try {
    const { values } = parseArgs({
      args: args.filter((a) => a !== sub),
      options: {
        webhook: { type: "boolean" },
        interval: { type: "string" },
        "max-concurrent": { type: "string" },
        "allowed-tools": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
    return {
      sub,
      opts: {
        webhook: !!values.webhook,
        interval: values.interval ? parseInt(values.interval, 10) : undefined,
        maxConcurrent: values["max-concurrent"]
          ? parseInt(values["max-concurrent"], 10)
          : undefined,
        allowedTools: values["allowed-tools"]
          ? String(values["allowed-tools"])
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
        help: !!values.help,
      },
    };
  } catch (err: any) {
    console.error(`错误: ${err.message}\n使用 sid-code daemon --help 查看用法`);
    process.exit(1);
  }
}

const KNOWN_SUBS = new Set(["start", "status", "stop", "restart", "logs", "install", "uninstall"]);

/** 守护进程日志文件路径 */
function daemonLogFile(): string {
  return sidPaths.log("daemon.log");
}

/** 初始化 daemon 专用 logger：console + 文件追加 */
async function initDaemonLogger(): Promise<void> {
  const { initLogger, LogLevel } = await import("@sid-code/core/debug/index.ts");
  initLogger({
    enabled: true,
    level: LogLevel.INFO,
    console: true,
    fileOnly: false,
    logFile: daemonLogFile(),
    append: true,
  });
}

/** 前台启动守护进程 */
async function runStart(opts: DaemonCliOptions): Promise<void> {
  await initDaemonLogger();
  const { Daemon } = await import("@sid-code/core/daemon/daemon.ts");
  const daemon = new Daemon({
    webhookEnabled: opts.webhook,
    scheduleCheckIntervalMs: opts.interval,
    maxConcurrent: opts.maxConcurrent,
    allowedTools: opts.allowedTools,
  });

  const ok = daemon.start();
  if (!ok) {
    console.error("错误: 已有守护进程在运行（见 sid-code daemon status）");
    process.exit(1);
  }
  console.error("[sid-code daemon] 已启动（前台）。Ctrl+C 停止。日志: " + daemonLogFile());
  await daemon.waitForever();
}

/** 查看状态 */
async function runStatus(): Promise<void> {
  const { readDaemonLock, isDaemonRunning } = await import("@sid-code/core/daemon/lock.ts");
  const lock = readDaemonLock();
  if (!lock) {
    console.log("守护进程: 未运行（无锁文件）");
    return;
  }
  const alive = isDaemonRunning();
  console.log(`守护进程: ${alive ? "运行中" : "未运行（stale 锁已回收）"}`);
  if (alive) {
    console.log(`  PID:      ${lock.pid}`);
    console.log(`  启动时间: ${new Date(lock.startedAt).toLocaleString()}`);
    console.log(`  版本:     ${lock.version}`);
  }
}

/** 停止运行中的守护进程 */
async function runStop(): Promise<void> {
  const { readDaemonLock, isDaemonRunning, releaseDaemonLock } =
    await import("@sid-code/core/daemon/lock.ts");
  const lock = readDaemonLock();
  if (!lock || !isDaemonRunning()) {
    console.log("守护进程未运行，无需停止");
    return;
  }
  try {
    process.kill(lock.pid, "SIGTERM");
    console.log(`已向守护进程 (pid=${lock.pid}) 发送 SIGTERM`);
  } catch (err: any) {
    console.error(`停止失败: ${err?.message ?? err}`);
    // 进程可能已死，回收锁
    releaseDaemonLock();
    process.exit(1);
  }
}

/** 打印日志 */
function runLogs(): void {
  const path = daemonLogFile();
  if (!existsSync(path)) {
    console.log(`暂无日志文件: ${path}`);
    return;
  }
  process.stdout.write(readFileSync(path, "utf-8"));
}

/** 主入口 */
export async function handleDaemonCommand(args: string[]): Promise<void> {
  const { sub, opts } = parseDaemonArgs(args);

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  switch (sub) {
    case "start":
      await runStart(opts);
      break;
    case "status":
      await runStatus();
      break;
    case "stop":
      await runStop();
      break;
    case "restart": {
      await runStop();
      // 等待旧进程退出
      await new Promise((r) => setTimeout(r, 1000));
      await runStart(opts);
      break;
    }
    case "logs":
      runLogs();
      break;
    case "install":
    case "uninstall": {
      const { handleServiceCommand } = await import("@sid-code/core/daemon/service.ts");
      await handleServiceCommand(sub, opts);
      break;
    }
    default:
      console.error(`未知子命令: ${sub}`);
      printHelp();
      process.exit(1);
  }
}
