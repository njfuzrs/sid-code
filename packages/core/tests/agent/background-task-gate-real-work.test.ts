/**
 * CP-7 / C1：闸门等到的必须是**真实工作**，不是几个微任务就 settle 的壳
 *
 * `background-task-gate.test.ts` 测的是闸门本身，那里传进去的 task 是手写的、
 * 真的会 await 的 promise，所以闸门当然有效。事故恰恰出在**生产 wrapper** 那一层：
 * `updateSessionMemory` / `executeExtract` 原先都是 `async` + 内部 fire-and-forget，
 * 返回的 promise 在第一个微任务就完成 —— 闸门等了个空，
 * 于是串行、退出排空（pre-flush drain）、`/cost` 的「后台任务进行中」提示
 * 三件事全部失效，而 `admitted` / `deferred` 统计看上去完全正常。
 *
 * 所以这条测试用**真实工厂**（`initSessionMemory` / `initExtractMemories`）配一个
 * 会挂 100ms 的假 fork，按 `query/loop.ts` 的唯一调用形态从 `runBackgroundTask`
 * 提交两条，断言「第二个 fork 在第一个结束后才开始」。
 *
 * 为什么不用 `mock.module` 换 `runForkedAgent`：那两个工厂本来就留了 `runFork`
 * 注入点（extractor 早有、session-memory 本次补上），模块级 mock 会跨文件污染
 * 同进程跑的其他用例。
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ForkedAgentContext, runForkedAgent } from "../../src/agent/forked-agent.ts";
import {
  runBackgroundTask,
  resetBackgroundTaskGate,
  getBackgroundGateStats,
  drainBackgroundTasks,
} from "../../src/agent/background-task-gate.ts";
import { initSessionMemory } from "../../src/session-memory/session-memory.ts";
import { initExtractMemories } from "../../src/memory/extract/extractor.ts";
import { SessionState } from "../../src/session/state.ts";
// core 测试引用 cli 是既有的「层间一致性守卫」形态（见 scripts/pkg-boundary-scan.ts 注释）：
// C3 要断言的就是「真实闸门 → CostCommand → 屏幕输出」这最后一跳。
import { CostCommand } from "@sid-code/cli/command/commands/cost/cost.ts";

/** 轮询等到条件成立 —— 比固定 sleep 更能反映「什么时候真的结束」 */
async function waitUntil(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitUntil 超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("CP-7：真实 wrapper 交给闸门的是真工作", () => {
  /** 假 fork 的耗时。必须明显长于几个微任务，否则区分不出 fire-and-forget */
  const FORK_MS = 100;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-bg-gate-real-"));
    // extractor 会扫描/读取记忆目录，先建出来避免依赖 ENOENT 容错
    mkdirSync(join(dir, "memory"), { recursive: true });
    resetBackgroundTaskGate();
  });

  afterEach(async () => {
    await drainBackgroundTasks(500);
    resetBackgroundTaskGate();
    rmSync(dir, { recursive: true, force: true });
  });

  test("C1：session-memory 跑完之前，memory-extract 不得开始", async () => {
    const events: string[] = [];
    let inFork = 0;
    let peakConcurrentFork = 0;

    const fakeFork = (async (_ctx: ForkedAgentContext) => {
      inFork += 1;
      peakConcurrentFork = Math.max(peakConcurrentFork, inFork);
      events.push("fork:start");
      await new Promise((r) => setTimeout(r, FORK_MS));
      inFork -= 1;
      events.push("fork:end");
      return { messages: [] };
    }) as unknown as typeof runForkedAgent;

    const sm = initSessionMemory({
      getMainContext: () => ({
        systemPrompt: "",
        messages: [],
        // 假 fork 从不真正发请求，provider / registry 只为满足 ForkedAgentContext 形状
        // （与 tests/memory/dream.test.ts 同一做法）
        provider: {} as any,
        toolRegistry: {} as any,
        model: "test",
      }),
      canUseTool: () => ({ behavior: "allow" as const }),
      filePath: join(dir, ".session_memory.md"),
      // 零阈值：让真实工厂每一轮都真跑 fork（双阈值本身另有单测覆盖）
      config: {
        minimumMessageTokensToInit: 0,
        minimumTokensBetweenUpdate: 0,
        toolCallsBetweenUpdates: 0,
      },
      runFork: fakeFork,
    });
    const extract = initExtractMemories({
      getMainContext: () => ({
        systemPrompt: "",
        messages: [],
        // 假 fork 从不真正发请求，provider / registry 只为满足 ForkedAgentContext 形状
        // （与 tests/memory/dream.test.ts 同一做法）
        provider: {} as any,
        toolRegistry: {} as any,
        model: "test",
      }),
      memoryDir: join(dir, "memory"),
      canUseTool: () => ({ behavior: "allow" as const }),
      runFork: fakeFork,
    });

    // 复现 `query/loop.ts` 的唯一调用形态：两条同步语句紧挨着提交
    const admittedFirst = runBackgroundTask("session-memory-update", () =>
      sm.updateSessionMemory(),
    );
    const admittedSecond = runBackgroundTask("memory-extract", () => extract.executeExtract());

    expect(admittedFirst).toBe(true);
    expect(admittedSecond).toBe(false);
    expect(getBackgroundGateStats().pendingLabels).toEqual(["memory-extract"]);

    // 核心断言：闸门此刻必须真的「忙」。修复前（wrapper fire-and-forget）这里
    // 读到的是 false —— 闸门以为任务已经完成，`inFlight` 已被清空。
    expect(getBackgroundGateStats().busy).toBe(true);
    expect(getBackgroundGateStats().busyLabel).toBe("session-memory-update");

    // 再等 20ms 复核一次：不是瞬时忙，而是整段 fork 期间都忙
    await new Promise((r) => setTimeout(r, 20));
    expect(getBackgroundGateStats().busy).toBe(true);
    expect(events).toEqual(["fork:start"]); // 只有第一条的 fork 在跑

    await waitUntil(
      () => getBackgroundGateStats().admitted === 2 && !getBackgroundGateStats().busy,
      "两条后台任务都跑完",
    );

    // 两个 fork 从未重叠，且严格串行（修复前是 start/start/end/end）
    expect(peakConcurrentFork).toBe(1);
    expect(events).toEqual(["fork:start", "fork:end", "fork:start", "fork:end"]);
    expect(getBackgroundGateStats().deferred).toBe(1);
  });

  test("C1 反面：wrapper 内部跳过时不得把上一轮那条链冒充成本轮工作", async () => {
    // 真实工厂的「上一轮未完成 → 直接跳过」分支：本轮没有真实工作，
    // 返回的 promise 必须已经完成，否则闸门会被一条空壳占住 FORK_MS 那么久。
    let releaseFirst!: () => void;
    const firstForkGate = new Promise<void>((r) => (releaseFirst = r));
    const forkCalls: string[] = [];

    const fakeFork = (async () => {
      forkCalls.push("fork");
      await firstForkGate;
      return { messages: [] };
    }) as unknown as typeof runForkedAgent;

    const sm = initSessionMemory({
      getMainContext: () => ({
        systemPrompt: "",
        messages: [],
        // 假 fork 从不真正发请求，provider / registry 只为满足 ForkedAgentContext 形状
        // （与 tests/memory/dream.test.ts 同一做法）
        provider: {} as any,
        toolRegistry: {} as any,
        model: "test",
      }),
      canUseTool: () => ({ behavior: "allow" as const }),
      filePath: join(dir, ".session_memory.md"),
      config: {
        minimumMessageTokensToInit: 0,
        minimumTokensBetweenUpdate: 0,
        toolCallsBetweenUpdates: 0,
      },
      runFork: fakeFork,
    });

    const first = sm.updateSessionMemory(); // 第一次：真跑，挂在 firstForkGate 上
    await waitUntil(() => forkCalls.length === 1, "第一次 fork 已启动");

    // 第二次：panding 非空 → 跳过。它必须立即完成，不能复用第一次的 promise
    // （复用会让闸门把「上一次还得跑多久」误算成本次任务的时长）。
    let secondSettled = false;
    await sm.updateSessionMemory().then(() => (secondSettled = true));
    expect(secondSettled).toBe(true);
    expect(forkCalls).toEqual(["fork"]); // 没有起第二个 fork

    releaseFirst();
    await first;
    expect(forkCalls).toEqual(["fork"]);
  });

  test("C3：闸门真忙时 /cost 会提示「后台任务 … 进行中」", async () => {
    // 纯函数与接线层已由 packages/cli/tests/command/cost-pending-tasks.test.ts 覆盖
    // （那边注入假状态）。这里补最后一跳：闸门**真的**忙时，走生产默认值
    // （不注入 readGateStats）的 CostCommand 会把它渲染进输出。
    // CP-7 修复前闸门永远"空闲"，这条提示在实际会话里从未出现过（CP-6）。
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const fakeFork = (async () => {
      await hold;
      return { messages: [] };
    }) as unknown as typeof runForkedAgent;

    const sm = initSessionMemory({
      getMainContext: () => ({
        systemPrompt: "",
        messages: [],
        provider: {} as any,
        toolRegistry: {} as any,
        model: "test",
      }),
      canUseTool: () => ({ behavior: "allow" as const }),
      filePath: join(dir, ".session_memory.md"),
      config: {
        minimumMessageTokensToInit: 0,
        minimumTokensBetweenUpdate: 0,
        toolCallsBetweenUpdates: 0,
      },
      runFork: fakeFork,
    });

    expect(runBackgroundTask("session-memory-update", () => sm.updateSessionMemory())).toBe(true);
    expect(getBackgroundGateStats().busy).toBe(true);

    const ss = new SessionState("cost-real-gate");
    ss.updateUsage("gpt-test", { inputTokens: 1_000, outputTokens: 10 }, 1, "openai");
    const out = (await new CostCommand().call("", { sessionState: ss, config: {} } as any)) as {
      value: string;
    };
    expect(out.value).toContain("后台任务 session-memory-update 进行中");
    expect(out.value).toContain("费用可能还会增加");

    release();
    await waitUntil(() => !getBackgroundGateStats().busy, "闸门释放");
  });

  test("C5：退出收尾会等真实工作跑完，不在 fork 中途放行退出", async () => {
    // `drainBackgroundTasks` 是 pre-flush 关闭钩子的实体。它等的是 `inFlight`
    // 那条 promise —— wrapper 若 fire-and-forget，这里会在 fork 还在跑时立即返回，
    // 进程退出就把十万 token 级的请求掐断，什么也没写进去。
    const events: string[] = [];
    const fakeFork = (async () => {
      events.push("fork:start");
      await new Promise((r) => setTimeout(r, 100));
      events.push("fork:end");
      return { messages: [] };
    }) as unknown as typeof runForkedAgent;

    const sm = initSessionMemory({
      getMainContext: () => ({
        systemPrompt: "",
        messages: [],
        provider: {} as any,
        toolRegistry: {} as any,
        model: "test",
      }),
      canUseTool: () => ({ behavior: "allow" as const }),
      filePath: join(dir, ".session_memory.md"),
      config: {
        minimumMessageTokensToInit: 0,
        minimumTokensBetweenUpdate: 0,
        toolCallsBetweenUpdates: 0,
      },
      runFork: fakeFork,
    });

    runBackgroundTask("session-memory-update", () => sm.updateSessionMemory());
    await waitUntil(() => events.includes("fork:start"), "fork 已启动");

    await drainBackgroundTasks(2_000);
    expect(events).toEqual(["fork:start", "fork:end"]); // drain 返回时工作已真正结束
  });
});
