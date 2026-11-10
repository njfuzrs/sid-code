/**
 * exit-signal-kills-monitor.test.ts 的子进程：构造真实 App、注册真实信号处理器、
 * 用真实 MonitorTool 挂一个长跑 monitor，然后
 *   - mode=signal：保持存活，等父进程发 SIGTERM / SIGHUP；
 *   - mode=exit：直接 process.exit(0)（模拟无头正常结束 / 预算硬停等不经过信号的退出）。
 *
 * 为什么放进子进程：信号处理器是进程级的（`process.on`），在测试进程里注册会留到同批
 * 其他测试文件；而且这里要验证的就是「真实信号到达 → 进程退出」这条路，只有独立进程能给。
 *
 * 事件流写到 argv[4] 指定的文件（一行一个 JSON），父进程据此断言顺序。
 * stdout 打 `READY` 表示 monitor 已挂上。
 */
import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import { App } from "@sid-code/cli/app.ts";
import { UnifiedCommandRegistry } from "@sid-code/cli/command/unified-registry.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { MonitorTool } from "@sid-code/core/tool/monitor.ts";
import { setTaskLifecycleSink } from "@sid-code/core/task/lifecycle.ts";
import { setWaitTraceSink } from "@sid-code/core/task/wait-registry.ts";

const [mode, token, eventsFile] = process.argv.slice(2) as [string, string, string];

// 空 SID_CONFIG_DIR ⇒ App 构造时 fire-and-forget 拉外部模型目录（见 bridge-ready-url-child.ts）。
// 这里只验退出清理，不需要外网。
const realCaps = await import("@sid-code/core/llm/model-capabilities.ts");
mock.module("@sid-code/core/llm/model-capabilities.ts", () => ({
  ...realCaps,
  shouldSyncCatalogs: () => false,
}));

const record = (event: string, data: Record<string, unknown>) =>
  appendFileSync(eventsFile, JSON.stringify({ event, data }) + "\n");

setTaskLifecycleSink((data) => record("TaskLifecycle", data));
setWaitTraceSink((event, data) => record(event, data));

const config = {
  ...defaultConfig(),
  model: "mock-model",
  provider: "mock",
  availableModels: [],
} as unknown as Config;
const app = new App({
  unifiedRegistry: new UnifiedCommandRegistry(),
  config,
  provider: {} as never,
  mcpManager: {} as never,
});
(app as any).hookSystem.fireSessionEndEvent = async () => record("SessionEnd", {});
(app as any).registerSignalHandlers();

const r = await new MonitorTool().call({
  description: "信号退出清理验收",
  command: `while true; do sleep 1; done # ${token}`,
  timeout_ms: 120_000,
});
if (r.isError) {
  process.stderr.write(`monitor 启动失败: ${String(r.data)}\n`);
  process.exit(2);
}
process.stdout.write("READY\n");

if (mode === "exit") {
  process.exit(0);
} else {
  // 保持存活等信号
  setInterval(() => {}, 1_000);
}
