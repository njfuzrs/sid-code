/**
 * `/cost` 的耗时口径（D8，2026-11-10 成本口径核查）。
 *
 * ## 它防的是什么
 *
 * 修复前 `/cost` 只写「API 耗时: 2m52s」，用户会把它当成**全部** API 时间。
 * 实际这个数只来自 `SessionState.totalAPIDuration` —— 只在主循环的
 * `updateUsage` 里累加（`query/loop.ts`），辅助调用（记忆 fork / 标题生成 /
 * 记忆召回）另外花了 20 秒以上，面板上**一个字都没有**。
 *
 * 修法两条：
 * 1. 标签写清范围：「API 耗时（主循环）」；
 * 2. 辅助调用耗时单独一行，数据来自 `getSideStats()`（计费事件带出的
 *    `BilledRequest.elapsedMs` → `recordSideCall.durationMs`）。
 *
 * ## 为什么「未采集」要写「—」
 *
 * `recordSideCall` 的 `durationMs` 是可选的：修复前 14 个调用点里 13 个写死 0。
 * 若汇总把「没采集」折成 0，面板会显示「辅助调用耗时 0s」，用户以为后台调用
 * 不花时间 —— 那是把未知伪装成已知。所以没采集到就写「—」，并写明次数。
 *
 * ## 为什么这里 reset 真实 sink 而不是注入假数据
 *
 * `side-call-sink` 是进程级单例，`/cost` 直接调 `getSideStats()`。
 * 测试要覆盖「真实命令读到真实汇总」这条接线，所以用 `recordSideCall` 造数据、
 * `resetSideCallStats()` 隔离（`bun test` 同批多文件跑在同一进程）。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import { recordSideCall, resetSideCallStats } from "@sid-code/core/trace/side-call-sink.ts";
import { CostCommand, type PendingTasksView } from "../../src/command/commands/cost/cost.ts";

const IDLE: PendingTasksView = { busy: false, busyLabel: null, pendingLabels: [] };

/** 造一次辅助调用记录。`durationMs` 不传 = 未采集（与生产语义一致）。 */
function sideCall(label: string, durationMs?: number) {
  return {
    label,
    model: "test-model",
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...(durationMs !== undefined && { durationMs }),
  };
}

/** 跑一次 /cost。主循环给一点用量，让费用/耗时不全是 0。 */
async function runCost(): Promise<string> {
  const ss = new SessionState("cost-api-duration-test");
  ss.updateUsage(
    "gpt-test",
    { inputTokens: 10_000, outputTokens: 100, cacheReadInputTokens: 6_500 },
    172_315,
    "openai",
  );
  ss.addSideCost(0.0645);
  ss.addToolDuration(71_488);
  const ctx = { sessionState: ss, config: { provider: "openai" } } as any;
  const result = (await new CostCommand(() => IDLE).call("", ctx)) as { value: string };
  return result.value;
}

beforeEach(() => {
  resetSideCallStats();
});

describe("/cost 耗时口径（D8）", () => {
  test("API 耗时标签写明「主循环」，不再是一个无范围的「API 耗时」", async () => {
    const out = await runCost();
    expect(out).toContain("API 耗时（主循环）: 2m52s");
    // 旧的裸标签必须消失，否则两个含义不同的「API 耗时」会并存
    expect(out).not.toMatch(/^API 耗时:/m);
  });

  test("写明三条耗时的关系：会话时长是墙钟，API 只算主循环", async () => {
    const out = await runCost();
    expect(out).toContain("会话时长是墙钟");
    expect(out).toContain("API 耗时只算主循环请求");
  });

  test("有辅助调用且采集到耗时：显示总耗时与调用次数", async () => {
    recordSideCall(sideCall("fork:session-memory-update", 1200));
    recordSideCall(sideCall("fork:memory-extract", 800));

    const out = await runCost();
    // 2s = 1200 + 800；formatDuration 对 2000ms 给 "2s"
    expect(out).toContain("辅助调用耗时: 2s（本次启动后 2 次调用）");
  });

  test("部分调用未采集耗时：写明采集覆盖，不让下界冒充总数", async () => {
    recordSideCall(sideCall("fork:memory-extract", 1200));
    recordSideCall(sideCall("recall")); // 未采集
    recordSideCall(sideCall("bash-classifier")); // 未采集

    const out = await runCost();
    expect(out).toContain("辅助调用耗时: 1s（本次启动后 1/3 次采集到耗时，其余未采集）");
  });

  test("一次都没采集到：写「—」而不是 0（不把未知伪装成没花时间）", async () => {
    recordSideCall(sideCall("recall"));
    recordSideCall(sideCall("bash-classifier"));

    const out = await runCost();
    expect(out).toContain("辅助调用耗时: —（本次启动后 2 次调用均未采集耗时）");
    expect(out).not.toContain("辅助调用耗时: 0");
  });

  test("没有辅助调用：整行省略（正常路径不加噪音）", async () => {
    const out = await runCost();
    expect(out).not.toContain("辅助调用耗时");
  });

  test("辅助调用耗时排在主循环 API 耗时之后、工具耗时之前", async () => {
    recordSideCall(sideCall("fork:memory-extract", 1200));

    const lines = (await runCost()).split("\n");
    const apiIdx = lines.findIndex((l) => l.startsWith("API 耗时（主循环）:"));
    const sideIdx = lines.findIndex((l) => l.startsWith("辅助调用耗时:"));
    const toolIdx = lines.findIndex((l) => l.startsWith("工具耗时:"));
    expect(apiIdx).toBeGreaterThanOrEqual(0);
    expect(sideIdx).toBeGreaterThan(apiIdx);
    expect(toolIdx).toBeGreaterThan(sideIdx);
  });
});
