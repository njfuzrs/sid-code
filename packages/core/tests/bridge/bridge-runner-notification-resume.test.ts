/**
 * Bridge 空闲续跑：远程会话里主轮之后才完成的后台任务通知
 *
 * 与 TUI / headless 同一条断链（事故 20261016-124505-786b1586）：远程客户端发来一条
 * 消息，主代理派出后台子代理后 end_turn，通知晚到——旧实现里这条通知只能等远程客户端
 * 下一次发消息才被动注入，中间那段「跑完没人汇总」的空窗对远程用户就是任务停了。
 *
 * 不起 WebSocket：`core.send` 在未连接时是空操作，直接驱动 runner 的入队即可，
 * 断言的是 deps 回调的调用行为（跑了几轮、谁先谁后）。
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

/** 私有 enqueue 的访问：生产里由 BridgeCore.onUserMessage 调用 */
function send(runner: BridgeRunner, text: string) {
  (runner as unknown as { enqueue: (t: string) => void }).enqueue(text);
}

function makeRunner(deps: BridgeRunnerDeps) {
  return new BridgeRunner(deps, { url: "ws://127.0.0.1:1/never-connected" });
}

describe("BridgeRunner 后台通知续跑", () => {
  test("主轮结束后队列里有通知 → 自动续跑一轮", async () => {
    let pending = true;
    let resumed = 0;
    const order: string[] = [];
    const runner = makeRunner(
      makeDeps({
        submitMessage: async function* (t) {
          order.push(`submit:${t}`);
          yield { kind: "done", turns: 1 } as QueryEngineEvent;
        },
        hasPendingNotifications: () => pending,
        resumeWithNotifications: async function* () {
          resumed++;
          order.push("resume");
          pending = false; // 续跑消费了通知
          yield { kind: "done", turns: 1 } as QueryEngineEvent;
        },
      }),
    );

    send(runner, "派后台子代理");
    await tick(20);

    expect(resumed).toBe(1);
    expect(order).toEqual(["submit:派后台子代理", "resume"]); // 主轮先、续跑后
  });

  test("远程又发来新消息 → 让给远程输入，不先续跑通知（远程输入优先）", async () => {
    let pending = true;
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = makeRunner(
      makeDeps({
        submitMessage: async function* (t) {
          order.push(`submit:${t}`);
          if (t === "第一条") await gate; // 第一轮跑着时第二条到达
          yield { kind: "done", turns: 1 } as QueryEngineEvent;
        },
        hasPendingNotifications: () => pending,
        resumeWithNotifications: async function* () {
          order.push("resume");
          pending = false;
          yield { kind: "done", turns: 1 } as QueryEngineEvent;
        },
      }),
    );

    send(runner, "第一条");
    await tick(5);
    send(runner, "第二条"); // 排队（processing 中）
    release();
    await tick(30);

    // 第二条必须在通知续跑之前执行
    expect(order.indexOf("submit:第二条")).toBeLessThan(order.indexOf("resume"));
  });

  test("通知链自己无限续下去 → 有上限，远程会话能回到空闲", async () => {
    let resumed = 0;
    const runner = makeRunner(
      makeDeps({
        hasPendingNotifications: () => true, // 永远有新通知
        resumeWithNotifications: async function* () {
          resumed++;
          yield { kind: "done", turns: 1 } as QueryEngineEvent;
        },
      }),
    );

    send(runner, "x");
    await tick(50);

    // 8 是 MAX_BACKGROUND_TURNS_PER_IDLE：防死循环，不是限流
    expect(resumed).toBe(8);
  });

  test("deps 没提供续跑能力 → 行为与改动前相同（不抛、不续跑）", async () => {
    let submitted = 0;
    const runner = makeRunner(
      makeDeps({
        submitMessage: async function* () {
          submitted++;
          yield { kind: "done", turns: 1 } as QueryEngineEvent;
        },
      }),
    );
    send(runner, "x");
    await tick(20);
    expect(submitted).toBe(1);
  });

  test("续跑轮抛异常 → 被收口为 error 状态，runner 不崩、仍可处理后续消息", async () => {
    let calls = 0;
    const runner = makeRunner(
      makeDeps({
        submitMessage: async function* () {
          calls++;
          yield { kind: "done", turns: 1 } as QueryEngineEvent;
        },
        hasPendingNotifications: () => true,
        resumeWithNotifications: async function* () {
          throw new Error("续跑失败");
        },
      }),
    );

    send(runner, "第一条");
    await tick(20);
    send(runner, "第二条");
    await tick(20);

    expect(calls).toBe(2); // 第二条仍被处理：processing 标志在 finally 里复位
  });
});
