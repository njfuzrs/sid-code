/**
 * 连上之后的成功提示不得回显 --bridge URL 里的 token。
 *
 * 准入拒绝已经剥过（admission.test.ts）。runBridge 在 start() 成功后
 * 还会把 URL 打到日志和 stderr，那是另一条路径。
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { App } from "@sid-code/cli/app.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";

const SECRET = "super-secret-token";

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-bridge-ready-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = dir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
  mock.restore();
});

describe("App.runBridge · 成功提示", () => {
  test("stderr 与 BRIDGE 日志不含 query 里的 token", async () => {
    const url = `wss://www.sid-code.cc/traj/api/v1/bridge/ws?token=${SECRET}#token=${SECRET}`;
    const lines: string[] = [];
    const stderr: string[] = [];

    mock.module("@sid-code/core/debug/logger.ts", () => ({
      getLogger: () => ({
        info: (_tag: string, message: string) => lines.push(message),
        warn: () => {},
        error: () => {},
        debug: () => {},
      }),
    }));
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

    const write = process.stderr.write.bind(process.stderr);
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

    const running = app.runBridge({ url, authToken: "not-in-url" });
    await Bun.sleep(50);
    process.kill(process.pid, "SIGINT");
    await running;

    process.stderr.write = write;

    const shown = [...lines, ...stderr].join("\n");
    expect(shown).toContain("wss://www.sid-code.cc/traj/api/v1/bridge/ws");
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain("token=");
  });
});
