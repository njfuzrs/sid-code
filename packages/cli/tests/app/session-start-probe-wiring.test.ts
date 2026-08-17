/**
 * 门禁 · SessionStart 消费者必须在 fireSessionStartEvent 之前注册完
 *
 * 缺陷形态：`initTelemetrySystem`（内部 `probe.registerHooks`）排在
 * `fireSessionStartEvent` **之后** → SessionStart 是一次性事件，注册晚一步就永远收不到 →
 * `TelemetryHookProbe.handleSessionStart` 从不被调用 → `agentSpan` 恒 undefined →
 * **会话根 `invoke_agent` span 恒不落盘**，整棵 trace 树没有栈底，
 * chat / execute_tool 全变孤儿根（实测 952 孤儿根 vs 34 traceId）。
 *
 * 这是「探针注册晚于事件首次 fire」的第三次复现，所以门禁分两层：
 *
 * 1. **行为层**（不锁计数，锁语义）——用真实 HookSystem + 真实 probe 跑两种注册顺序，
 *    断言「注册在 fire 之前」才产出根 span，且该 span 的 `name` / `kind` /
 *    `parentSpanId === undefined` 三项同时成立。
 *    ⚠️ 刻意不写 `invoke_agent 数 > 0` 这类判据：子代理 span 的 kind 也是 `invoke_agent`
 *    （`handleSubagentStart`），只数个数会被子代理 span 伪装成 PASS —— 这个坑真实发生过，
 *    18 个 invoke_agent 全是子代理，会话根实产 0 个而判据显示"已修"。
 *
 * 2. **静态层**——直接在 `app.ts` 源码上断言两个调用点的先后位置。
 *    行为层测的是 probe 自己的契约，拦不住「有人把 app.ts 里这两行顺序又换回去」，
 *    而那正是缺陷本体。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelemetryBus } from "@sid-code/core/telemetry/bus.ts";
import { TelemetryHookProbe } from "@sid-code/core/telemetry/hook-probe.ts";
import { TokenMeter } from "@sid-code/core/telemetry/metrics/token-meter.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import type { SpanData, TelemetryExporter } from "@sid-code/core/telemetry/types.ts";

const MODEL = "claude-sonnet-4";

/**
 * 落盘隔离（§三 P0-2 起必需）：`handleSessionStart` 会同步写「根 span 欠一次 end」
 * 的标记到 `~/.sid-code/telemetry/pending-root-spans/`。本文件 fire 真实 SessionStart。
 */
const prevConfigDir = process.env.SID_CONFIG_DIR;
let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "sid-probe-wiring-home-"));
  process.env.SID_CONFIG_DIR = testHome;
});

afterEach(() => {
  // 恢复原值而非 delete：同进程多文件跑，delete 会抹掉 preload 的隔离兜底
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(testHome, { recursive: true, force: true });
});

/** 启用的 bus + 收集 span 的 mock 导出器（flushIntervalMs 拉大，避免定时器干扰） */
function createProbe() {
  const spans: SpanData[] = [];
  const exporter: TelemetryExporter = {
    name: "mock",
    exportSpans: async (batch) => {
      spans.push(...batch);
    },
    shutdown: async () => {},
  };
  const bus = new TelemetryBus({ enabled: true, batchSize: 100, flushIntervalMs: 999_999 });
  bus.addExporter(exporter);
  const probe = new TelemetryHookProbe(bus, new TokenMeter(null, () => 0), {
    model: MODEL,
    provider: "anthropic",
    sessionId: "wiring-test-session",
  });
  return { bus, spans, probe, hookSystem: new HookSystem() };
}

/**
 * 会话根 span 的判据：kind + name 形如 `invoke_agent <model>` + 没有父。
 * 子代理 span 的 name 是 `invoke_agent explore` / `invoke_agent task`（agent 类型名），
 * 所以只有连 name 一起锁住才分得开「会话根」与「子代理」。
 */
function findSessionRootSpans(spans: SpanData[]): SpanData[] {
  return spans.filter(
    (s) => s.kind === "invoke_agent" && s.name === `invoke_agent ${MODEL}` && !s.parentSpanId,
  );
}

describe("SessionStart 探针接线顺序（会话根 span 恒不落盘）", () => {
  test("注册在 fire 之前 → 会话根 span 落盘，且 parentSpanId 为空", async () => {
    const { bus, spans, probe, hookSystem } = createProbe();

    // 正确顺序：先注册，后 fire
    probe.registerHooks(hookSystem);
    await hookSystem.fireSessionStartEvent("startup", { model: MODEL });
    await hookSystem.fireSessionEndEvent("exit", {
      total_cost_usd: 0,
      total_tokens_sent: 0,
      total_tokens_received: 0,
    });
    await bus.flush();

    const roots = findSessionRootSpans(spans);
    expect(roots.length).toBe(1);
    // 锁语义而非计数：这三项任一不成立，下游 APM 都重建不出会话树
    expect(roots[0]!.kind).toBe("invoke_agent");
    expect(roots[0]!.name).toBe(`invoke_agent ${MODEL}`);
    expect(roots[0]!.parentSpanId).toBeUndefined();
  });

  test("注册在 fire 之后 → 根 span 丢失（这就是被修掉的缺陷形态）", async () => {
    const { bus, spans, probe, hookSystem } = createProbe();

    // 缺陷顺序：先 fire，后注册（复刻修复前的 app.ts）
    await hookSystem.fireSessionStartEvent("startup", { model: MODEL });
    probe.registerHooks(hookSystem);
    await hookSystem.fireSessionEndEvent("exit", {
      total_cost_usd: 0,
      total_tokens_sent: 0,
      total_tokens_received: 0,
    });
    await bus.flush();

    // 这条断言是**变异自证**：它证明上一个 test 不是恒真的绿灯 ——
    // 顺序确实是那个变量，SessionStart 一次性事件漏掉就再也补不上。
    expect(findSessionRootSpans(spans).length).toBe(0);
  });

  test("树成形：chat 挂在会话根下，全批 span 恰好一个根", async () => {
    const { bus, spans, probe, hookSystem } = createProbe();

    probe.registerHooks(hookSystem);
    await hookSystem.fireSessionStartEvent("startup", { model: MODEL });
    // 完整一轮模型调用：BeforeModel 建 chat span，AfterModel 才 end 它并入队。
    // ⚠️ AfterModel 必须带 usage —— handleAfterModel 有 `if (!usage) return` 守卫，
    // 不带就走不到 llmSpan.end()，chat 永不落盘，本测试会退化成空转绿灯。
    const llmRequest = { model: MODEL, messages: [], system: "" } as any;
    await hookSystem.fireBeforeModelEvent(llmRequest);
    await hookSystem.fireAfterModelEvent(llmRequest, {
      text: "ok",
      usage: { inputTokens: 10, outputTokens: 5 },
    } as any);
    await hookSystem.fireSessionEndEvent("exit", {
      total_cost_usd: 0,
      total_tokens_sent: 0,
      total_tokens_received: 0,
    });
    await bus.flush();

    const root = findSessionRootSpans(spans)[0];
    expect(root).toBeDefined();

    // 无条件断言：chat 必须落盘且必须挂在根下（不许写成 `if (chat)`——
    // 条件式断言正是「聚合掉结构性缺陷」的同类，缺陷在时它会显示 PASS）
    const chat = spans.find((s) => s.kind === "chat");
    expect(chat).toBeDefined();
    expect(chat!.parentSpanId).toBe(root!.spanId);
    expect(chat!.traceId).toBe(root!.traceId);

    // 判据②在单测层的等价物：根 span 总数 == traceId 数（不去重根！
    // `sort -u` 式去重会把「28 个根」压成「1 个根」，让完全没修的状态显示 PASS）
    const rootCount = spans.filter((s) => !s.parentSpanId).length;
    const traceIdCount = new Set(spans.map((s) => s.traceId)).size;
    expect(rootCount).toBe(traceIdCount);
    expect(rootCount).toBe(1);

    // 判据③：无悬空父 —— 每个 parentSpanId 都能在同批数据里解析到
    const ids = new Set(spans.map((s) => s.spanId));
    const dangling = spans.filter((s) => s.parentSpanId && !ids.has(s.parentSpanId));
    expect(dangling.length).toBe(0);
  });
});

describe("静态门禁 · app.ts 里 initTelemetrySystem 必须早于 fireSessionStartEvent", () => {
  /**
   * ⚠️ 用 readFileSync 而非 shell grep：app.ts 曾含 NUL 字节，grep 会把它判成 binary
   * 并**静默跳过**（记忆「app.ts 含 NUL 字节致 grep 静默漏报」）。当前该文件已无 NUL，
   * 但门禁不该依赖这一点保持为真。
   */
  const appSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "app.ts"), "utf-8");

  test("扫描面非空（防止路径漂移让门禁退化成绿灯）", () => {
    expect(appSrc.length).toBeGreaterThan(10_000);
  });

  test("fireSessionStartEvent 只有一个调用点", () => {
    // 多个 fire 点意味着这条顺序不变量要在多处各自成立，届时本门禁需要升级。
    const hits = appSrc.split("fireSessionStartEvent(").length - 1;
    expect(hits).toBe(1);
  });

  test("initTelemetrySystem( 的调用位置早于 fireSessionStartEvent(", () => {
    // 注意排除 import/解构那一处：用 `await initTelemetrySystem(` 锁真实调用点
    const initAt = appSrc.indexOf("await initTelemetrySystem(");
    const fireAt = appSrc.indexOf("fireSessionStartEvent(");
    expect(initAt).toBeGreaterThan(-1);
    expect(fireAt).toBeGreaterThan(-1);
    expect(initAt).toBeLessThan(fireAt);
  });

  test("initTraceCollector( 的调用位置也早于 fireSessionStartEvent(", () => {
    // 修复只挪了 telemetry 一侧，必须同时证明另一个既有消费者没被挪坏
    // （collector.ts:547 明写「必须在 SessionStart 之前调用」）。
    const collectorAt = appSrc.indexOf("await initTraceCollector(");
    const fireAt = appSrc.indexOf("fireSessionStartEvent(");
    expect(collectorAt).toBeGreaterThan(-1);
    expect(collectorAt).toBeLessThan(fireAt);
  });
});
