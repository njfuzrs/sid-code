/**
 * bridge-ready-url.test.ts 的子进程。
 *
 * mock.module 在 bun 里是进程级的，mock.restore() 也不还原被替换的模块
 * （实测：同进程里排在后面的用例拿到的仍是 mock）。这里替换的是
 * bridge-runner 整个模块，留在父进程会让「永久失败」那组真测试拿到一个
 * start() 什么都不做的假类，4001 / 1008 的断言全部放空。所以整段放进子进程。
 *
 * 退出码：0 通过，1 断言失败，2 运行出错。失败原因写到 stderr。
 */
import { mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { App } from "@sid-code/cli/app.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";

const SECRET = "super-secret-token";
const dir = mkdtempSync(join(tmpdir(), "sid-bridge-ready-"));
process.env.SID_CONFIG_DIR = dir;

const url = `wss://www.sid-code.cc/traj/api/v1/bridge/ws?token=${SECRET}#token=${SECRET}`;
const lines: string[] = [];
const stderr: string[] = [];

mock.module("@sid-code/core/bridge/bridge-runner.ts", () => ({
  BridgeRunner: class {
    async start() {}
    async stop() {}
    waitForPermanentFailure() {
      return new Promise(() => {});
    }
  },
}));
mock.module("@sid-code/shared/utils/graceful-shutdown.ts", () => ({
  runShutdownSequence: async () => {},
}));

const log = getLogger();
log.info = ((tag: string, message: string) => {
  if (tag === "BRIDGE") lines.push(message);
}) as typeof log.info;
log.warn = (() => {}) as typeof log.warn;
log.error = (() => {}) as typeof log.error;
log.debug = (() => {}) as typeof log.debug;

process.stderr.write = ((chunk: string | Uint8Array) => {
  stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
  return true;
}) as typeof process.stderr.write;

const config = {
  ...defaultConfig(),
  model: "mock-model",
  provider: "mock",
  availableModels: [],
} as unknown as Config;
const checker = new PermissionChecker(config, undefined, dir);
const app = new App({
  config,
  provider: {} as never,
  mcpManager: { closeAll() {} } as never,
  permissionChecker: checker,
});
(app as unknown as { init: () => Promise<void> }).init = async () => {};

try {
  const running = app.runBridge({ url, authToken: "not-in-url" });
  await Bun.sleep(50);
  process.kill(process.pid, "SIGINT");
  await running;

  const shown = [...lines, ...stderr].join("\n");
  const problems: string[] = [];
  if (!shown.includes("wss://www.sid-code.cc/traj/api/v1/bridge/ws")) {
    problems.push("成功提示里没有脱敏后的地址");
  }
  if (shown.includes(SECRET)) problems.push("成功提示回显了 token");
  if (shown.includes("token=")) problems.push("成功提示留了 token= 参数");
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(2);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
