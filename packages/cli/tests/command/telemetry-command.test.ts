/**
 * /telemetry 总览口径（可观测性缺陷 8 / 9 / 10）
 *
 * 走真实命令入口 + 真实 TelemetryBus（无导出器，不落盘），不 mock 渲染函数：
 * 缺陷 8 的形态正是「渲染函数读的字段与生产者写的字段不是同一个」，
 * 绕开任何一端都测不出来。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { initTelemetry } from "@sid-code/core/telemetry/index.ts";
import { ATTR } from "@sid-code/core/telemetry/types.ts";
import { TelemetryCommand } from "../../src/command/builtins.ts";

function chat(
  bus: ReturnType<typeof initTelemetry>,
  model: string,
  input: number,
  output: number,
  ttft?: number,
) {
  const span = bus.startSpan("chat", `chat ${model}`, { [ATTR.REQUEST_MODEL]: model });
  span.setAttributes({ [ATTR.INPUT_TOKENS]: input, [ATTR.OUTPUT_TOKENS]: output });
  if (ttft !== undefined) span.setAttribute(ATTR.TTFT_MS, ttft);
  span.end();
}

async function run(): Promise<string> {
  const r = await new TelemetryCommand().execute("", {} as never);
  return (r as { message: string }).message;
}

let bus: ReturnType<typeof initTelemetry> | undefined;
afterEach(async () => {
  await bus?.shutdown();
  bus = undefined;
});

describe("/telemetry 总览", () => {
  test("缺陷 10：输入 token 取末轮（stock），不逐 span 累加", async () => {
    bus = initTelemetry({ enabled: true, exporters: [] });
    // 三轮，每轮 prompt 含全部历史：1000 → 2000 → 3000
    chat(bus, "m", 1000, 10);
    chat(bus, "m", 2000, 20);
    chat(bus, "m", 3000, 30);
    const out = await run();
    expect(out).toContain("当前上下文 3,000");
    expect(out).toContain("累计输出 60");
    // 旧算法的 N² 累加值
    expect(out).not.toContain("6,000");
  });

  test("缺陷 8/9：TTFT 能显示，按 model 分组报 P50/P95 + n", async () => {
    bus = initTelemetry({ enabled: true, exporters: [] });
    chat(bus, "a", 1, 1, 100);
    chat(bus, "a", 1, 1, 300);
    chat(bus, "b", 1, 1, 5000);
    const out = await run();
    expect(out).toContain("a: P50 100ms / P95 300ms (n=2)");
    expect(out).toContain("b: P50 5000ms / P95 5000ms (n=1)");
    expect(out).not.toContain("平均");
  });

  test("缺陷 8：无 TTFT 样本时明说，不静默省掉整行", async () => {
    bus = initTelemetry({ enabled: true, exporters: [] });
    chat(bus, "a", 1, 1);
    expect(await run()).toContain("首内容延迟 (TTFT): 无样本");
  });
});

describe("/telemetry 调用时间线（缺陷 17 / 18 / 19）", () => {
  test("缺陷 17：会话进行中根 span 未 end，也能画成树而非平铺孤立根", async () => {
    bus = initTelemetry({ enabled: true, exporters: [] });
    const root = bus.startSpan("invoke_agent", "invoke_agent sid-code");
    chat(bus, "m", 1, 1);
    chat(bus, "m", 2, 2);
    const out = await run();
    expect(out).toContain("#1 Agent");
    expect(out).toContain("⋯进行中");
    // 两个 chat 挂在根下，不是 #2 / #3 根
    expect(out).not.toContain("#2 ");
    expect(out).not.toContain("孤儿");
    root.end();
  });

  test("缺陷 18：父不在本批的孤儿与真根区分，并汇总计数", async () => {
    bus = initTelemetry({ enabled: true, exporters: [] });
    const root = bus.startSpan("invoke_agent", "agent");
    chat(bus, "m", 1, 1);
    root.end();
    // 父 span 不在本批（模拟被截断 / 跨进程）
    bus.startSpan("chat", "chat lost", {}, { parentSpanId: "gone", detached: true }).end();
    const out = await run();
    expect(out).toContain("#1 Agent");
    expect(out).toMatch(/#2 LLM 调用.*⊘孤儿/);
    expect(out).toContain("1 个孤儿节点");
  });

  test("缺陷 19：history 截断后明说截断条数", async () => {
    bus = initTelemetry({ enabled: true, exporters: [], maxQueueSize: 10_000 });
    for (let i = 0; i < 505; i++) chat(bus, "m", 1, 1);
    const out = await run();
    expect(out).toContain("历史已截断 5 条");
  });
});
