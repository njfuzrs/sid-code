/**
 * 两阶段启动架构 — Stage 1: Bootstrap
 * 零导入快速路径分发，让 --version / --help 等轻量命令极速完成
 * 所有依赖通过 await import() 动态加载
 */

import { profileCheckpoint, profileReport, isProfilingEnabled } from "../utils/startup-profiler.ts";
profileCheckpoint("bootstrap_entry");

// 启动性能剖析：进程退出时输出报告
if (isProfilingEnabled()) {
  process.on("exit", () => {
    const report = profileReport();
    if (report) console.error(report);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 快速路径 1: --version — 从 package.json 读取版本号
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    profileCheckpoint("bootstrap_route_resolved");
    const { getVersion } = await import("../version.ts");
    console.log(getVersion());
    return;
  }

  // 快速路径 2: --help — 只加载帮助文本
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    profileCheckpoint("bootstrap_route_resolved");
    const { printHelp } = await import("../help.ts");
    printHelp();
    return;
  }

  // 快速路径 3: --list-sessions — 只加载会话模块
  if (args.includes("--list-sessions")) {
    profileCheckpoint("bootstrap_route_resolved");
    const { handleListSessions } = await import("../session/commands.ts");
    await handleListSessions();
    return;
  }

  // 快速路径 4: --delete-session — 只加载会话模块
  const deleteIdx = args.indexOf("--delete-session");
  if (deleteIdx !== -1 && args[deleteIdx + 1]) {
    profileCheckpoint("bootstrap_route_resolved");
    const { handleDeleteSession } = await import("../session/commands.ts");
    await handleDeleteSession(args[deleteIdx + 1]);
    return;
  }

  // 快速路径 5: review 子命令 — 从 stdin / --diff 读 unified diff，调用 code-review Skill
  if (args[0] === "review") {
    profileCheckpoint("bootstrap_route_resolved");
    const { handleReviewCommand } = await import("../command/review.ts");
    await handleReviewCommand(args.slice(1));
    return;
  }

  // 快速路径 6: daemon 子命令（缺口 C1）— 本地调度守护进程（start/status/stop/restart/logs/install/uninstall）
  if (args[0] === "daemon") {
    profileCheckpoint("bootstrap_route_resolved");
    const { handleDaemonCommand } = await import("../command/daemon.ts");
    await handleDaemonCommand(args.slice(1));
    return;
  }

  // 所有快速路径未命中 → 启动早期输入捕获 → 加载完整 CLI
  profileCheckpoint("bootstrap_route_resolved");

  // 在加载完整 CLI 之前启动早期输入捕获(缓冲用户按键)
  const { startCapturingEarlyInput } = await import("../ui/early-input.ts");
  startCapturingEarlyInput();

  const { main: cliMain } = await import("../cli.ts");
  await cliMain();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
