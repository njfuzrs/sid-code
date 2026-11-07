/**
 * BridgeRunner 的本地注入通道（T6）。
 *
 * 无头长驻形态下，cron / `/loop` / `schedule_wakeup` 到点触发的 prompt 需要一个
 * 「能被消费」的入口。Bridge 侧走 `injectLocalMessage`，语义要求与远端消息**同一条
 * 队列、串行执行**：另起一条消费链会和远端消息抢同一个会话（谁先谁后、错误怎么报
 * 都会分叉），所以这里断言的是「串行、不并发」。
 *
 * 不起 WebSocket：与 bridge-runner-notification-resume.test.ts 同款夹具，
 * `core.send` 未连接时是空操作，断言 deps 回调的调用顺序。
 */

import { describe, test, expect } from "bun:test";
import { BridgeRunner, type BridgeRunnerDeps } from "@sid-code/core/bridge/bridge-runner.ts";
import type { QueryEngineEvent } from "@sid-code/core/query/types.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function makeDeps(over: Partial<BridgeRunnerDeps> = {}): BridgeRunnerDeps {
  return {
    submitMessage: async function* () {
      yield { kind: "done", turns: 1 } as QueryEngineEvent;
    },
    setStreamTextCallback: () => {},
    abort: () => {},
    setPermissionDelegate: () => {},
    ...over,
  };
}

function makeRunner(deps: BridgeRunnerDeps) {
  return new BridgeRunner(deps, { url: "ws://127.0.0.1:1/never-connected" });
}

/** 模拟远端消息：生产里由 BridgeCore.onUserMessage 调私有 enqueue */
function send(runner: BridgeRunner, text: string) {
  (runner as unknown as { enqueue: (t: string) => void }).enqueue(text);
}

describe("BridgeRunner 本地注入（定时任务）", () => {
  test("injectLocalMessage 与远端消息同队列串行：不打断正在跑的一轮", async () => {
    const order: string[] = [];
    const runner = makeRunner(
      makeDeps({
        submitMessage: async function* (t) {
          order.push(`start:${t}`);
          await tick(10);
          order.push(`end:${t}`);
          yield { kind: "done", turns: 1 } as QueryEngineEvent;
        },
      }),
    );

    // 远端先发一条，跑起来之后定时任务才到点注入
    send(runner, "远端消息");
    await tick(1);
    runner.injectLocalMessage("定时任务");
    await tick(80);

    expect(order).toEqual(["start:远端消息", "end:远端消息", "start:定时任务", "end:定时任务"]);
  });

  test("空串注入与远端空消息同待遇：仍会入队一轮（不静默丢弃）", async () => {
    const seen: string[] = [];
    const runner = makeRunner(
      makeDeps({
        submitMessage: async function* (t) {
          seen.push(t);
          yield { kind: "done", turns: 1 } as QueryEngineEvent;
        },
      }),
    );
    runner.injectLocalMessage("");
    await tick(20);
    expect(seen).toEqual([""]);
  });
});
