/**
 * R2：4001 必须从传输层传到 BridgeRunner.start()，不能停在「重连已停、进程还在」。
 *
 * 只测 runner，不拉 App：App.runBridge 还要 init() 整条内核。
 * 断言的是 start() 抛出的人话，以及 types.ts 闭集里没有 "auth"
 * —— 加上就会有人从 BridgeCore.send 再发一次握手帧。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { BridgeRunner } from "@sid-code/core/bridge/bridge-runner.ts";
import { readFileSync } from "fs";

function startRejectingServer(code: number) {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.close(code, "no");
      },
      message() {},
    },
  });
  return server;
}

const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers.length = 0;
});

function runnerFor(url: string): BridgeRunner {
  return new BridgeRunner(
    {
      submitMessage: async function* () {},
      setStreamTextCallback: () => {},
      abort: () => {},
      setPermissionDelegate: () => {},
    },
    { url, authToken: "bad-token" },
  );
}

describe("BridgeRunner 永久失败", () => {
  test("4001 → start() 拒绝，文案是认证失败而不是「已启动」", async () => {
    const server = startRejectingServer(4001);
    servers.push(server);
    const runner = runnerFor(`ws://127.0.0.1:${server.port}/bridge/ws`);
    await expect(runner.start()).rejects.toThrow(/认证失败/);
    await runner.stop();
  });

  test("1008 → start() 同样拒绝（策略拒绝不是可重试断线）", async () => {
    const server = startRejectingServer(1008);
    servers.push(server);
    const runner = runnerFor(`ws://127.0.0.1:${server.port}/bridge/ws`);
    await expect(runner.start()).rejects.toThrow(/违反服务端策略/);
    await runner.stop();
  });

  test("auth 不在业务闭集里", () => {
    const src = readFileSync(new URL("../../src/bridge/types.ts", import.meta.url), "utf-8");
    const out = src.match(/export interface BridgeOutMessage \{[\s\S]*?type: ([^;]+);/);
    const inn = src.match(/export interface BridgeInMessage \{[\s\S]*?type: ([^;]+);/);
    expect(out?.[1]).toBeDefined();
    expect(inn?.[1]).toBeDefined();
    expect(out![1]).not.toContain('"auth"');
    expect(inn![1]).not.toContain('"auth"');
    expect(out![1]).not.toContain('"auth_ok"');
  });
});
