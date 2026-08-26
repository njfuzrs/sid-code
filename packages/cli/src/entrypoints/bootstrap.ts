/**
 * 两阶段启动架构 — Stage 1: Bootstrap
 * 零导入快速路径分发，让 --version / --help 等轻量命令极速完成
 * 所有依赖通过 await import() 动态加载
 */

import {
  profileCheckpoint,
  profileReport,
  isProfilingEnabled,
} from "@sid-code/shared/utils/startup-profiler.ts";
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
    const { getVersion } = await import("@sid-code/shared/version.ts");
    console.log(getVersion());
    return;
  }

  // 快速路径 1.5: --build-info — 输出编进字节的构建身份（commit/branch/dirty/...）
  //
  // 为什么必须在这个零导入快速路径里（和 --version / --self-check 同层）：
  // 门禁要在**任何环境**下都能问它 —— 配置缺失、~/.sid-code/ 不存在、网关不可达时
  // 都得能读出身份。走完整 CLI 会读配置、可能落盘，那时"读一下身份"就成了有副作用的操作。
  //
  // 与 --version 的分工：--version 是给人看的版本号，身份是另一件事，刻意不混。
  // 把 commit 拼进 getVersion() 会误触发网关定价的全端点强制刷新
  // （app.ts 用版本号做刷新水位线），且没人会想到是这里。
  if (
    args[0] === "--build-info" &&
    (args.length === 1 || (args.length === 2 && args[1] === "--json"))
  ) {
    profileCheckpoint("bootstrap_route_resolved");
    const [{ getBuildInfo, formatBuildInfoText, formatBuildInfoJson }, { getRawVersion }] =
      await Promise.all([
        import("@sid-code/shared/build-info.ts"),
        import("@sid-code/shared/version.ts"),
      ]);
    const info = getBuildInfo();
    const version = getRawVersion();
    console.log(
      args[1] === "--json"
        ? formatBuildInfoJson(info, version)
        : formatBuildInfoText(info, version),
    );
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
    const { handleListSessions } = await import("@sid-code/core/session/commands.ts");
    await handleListSessions();
    return;
  }

  // 快速路径 4: --delete-session — 只加载会话模块
  const deleteIdx = args.indexOf("--delete-session");
  if (deleteIdx !== -1 && args[deleteIdx + 1]) {
    profileCheckpoint("bootstrap_route_resolved");
    const { handleDeleteSession } = await import("@sid-code/core/session/commands.ts");
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

  // 快速路径 7: update 子命令 — 复用 install.sh 下载并替换二进制，不碰 ~/.sid-code/ 数据
  if (args[0] === "update") {
    profileCheckpoint("bootstrap_route_resolved");
    const { handleUpdateCommand } = await import("../command/update.ts");
    await handleUpdateCommand(args.slice(1));
    return;
  }

  // 快速路径 8: agents 子命令（缺口 A-2）— 无头列举所有子代理（内置/自定义/插件），不启动 App
  if (args[0] === "agents") {
    profileCheckpoint("bootstrap_route_resolved");
    const { handleAgentsCommand } = await import("../command/agents.ts");
    await handleAgentsCommand(args.slice(1));
    return;
  }

  // 快速路径 9: mcp 子命令（缺口 A-3）— 无头管理 MCP 服务器配置（list/get/add/remove），不启动 App
  if (args[0] === "mcp") {
    profileCheckpoint("bootstrap_route_resolved");
    const { handleMcpCommand } = await import("../command/mcp-cli.ts");
    await handleMcpCommand(args.slice(1));
    return;
  }

  // 快速路径 10: auth 子命令（缺口 A-1 可行子集）— 认证配置诊断（status），login/logout 不适用
  if (args[0] === "auth") {
    profileCheckpoint("bootstrap_route_resolved");
    const { handleAuthCommand } = await import("../command/auth.ts");
    await handleAuthCommand(args.slice(1));
    return;
  }

  // 快速路径 7.5: --self-check — 校验编译产物内联的关键修复是否生效（方向 0）。
  // 背景（根因分析-commit任务git状态快照冻结死循环.md 第 2 环）：`bun build --compile`
  // 在**编译时**把源码内联进二进制。git pull/commit 更新了源码，但磁盘上的二进制不会变，
  // 若忘了 make build，跑的还是旧逻辑——那次死循环的直接触发因素正是"源码修了但二进制没跟上"。
  // 本命令让**二进制自己**跑一遍关键代码路径，断言修复已内联；make build 末尾调用它，
  // 编译出的产物一旦缺失锚点就当场失败，堵住"源码有修复但二进制没重编"的发布陷阱。
  if (args.length === 1 && args[0] === "--self-check") {
    profileCheckpoint("bootstrap_route_resolved");
    const { runSelfCheck } = await import("../command/self-check.ts");
    const ok = await runSelfCheck();
    process.exit(ok ? 0 : 1);
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
