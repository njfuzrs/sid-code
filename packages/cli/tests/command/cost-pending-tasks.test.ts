/**
 * /cost 的后台任务提示（D2，2026-11-10 成本口径核查）。
 *
 * ## 它防的是什么
 *
 * /cost 的输出进 `CommandOutputDialog` 后是静态文本，打开那一刻的数字不会再变。
 * 实测同一会话 /cost 显示 $0.1447、/debug 显示 $0.1501，差额全部来自两次打开之间
 * 入账的 5 次后台记忆 fork —— 但面板当时没告诉用户「还有后台调用在跑，数字还会变」，
 * 看上去就像两套计价口径（实际读的是同一个 `getEffectiveTotalCostUSD()`）。
 *
 * ## 为什么分两层测
 *
 * 纯函数层覆盖「进行中 / 排队 / 空闲」的措辞与省略规则；
 * 接线层覆盖「这一行真的被拼进了 /cost 输出，且位置在费用块之后」——
 * 只测纯函数时，把 cost.ts 里的调用整行删掉，测试仍然全绿（变异自证会失败）。
 *
 * 接线层**不碰真实闸门**：`background-task-gate.ts` 是进程级单例，`bun test` 同批多文件
 * 跑在同一进程里，去占用/重置它会和 `packages/core/tests/agent/background-task-gate.test.ts`
 * 互相干扰。所以 `CostCommand` 的读取函数可注入，这里传假状态。
 */
import { describe, test, expect } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import {
  CostCommand,
  formatPendingTasksNotice,
  type PendingTasksView,
} from "../../src/command/commands/cost/cost.ts";

const IDLE: PendingTasksView = { busy: false, busyLabel: null, pendingLabels: [] };

function view(partial: Partial<PendingTasksView>): PendingTasksView {
  return { ...IDLE, ...partial };
}

async function runCost(gate: PendingTasksView): Promise<string> {
  const ss = new SessionState("cost-pending-test");
  ss.updateUsage(
    "gpt-test",
    { inputTokens: 10_000, outputTokens: 100, cacheReadInputTokens: 6_500 },
    1,
    "openai",
  );
  ss.addSideCost(0.01);
  const ctx = { sessionState: ss, config: { provider: "openai" } } as any;
  const result = (await new CostCommand(() => gate).call("", ctx)) as { value: string };
  return result.value;
}

describe("/cost 后台任务提示（D2）：措辞与省略规则", () => {
  test("闸门空闲：不产生提示（正常路径不加噪音）", () => {
    expect(formatPendingTasksNotice(IDLE)).toBeNull();
  });

  test("有任务在跑：写出具体标签，并提示数字还会变", () => {
    const notice = formatPendingTasksNotice(view({ busy: true, busyLabel: "memory-extract" }));
    expect(notice).toContain("memory-extract 进行中");
    expect(notice).toContain("费用可能还会增加");
    expect(notice).toContain("重开 /cost");
  });

  test("有任务在跑且另有排队：两种状态都写出来", () => {
    const notice = formatPendingTasksNotice(
      view({ busy: true, busyLabel: "memory-extract", pendingLabels: ["session-memory-update"] }),
    );
    expect(notice).toContain("memory-extract 进行中");
    expect(notice).toContain("session-memory-update 排队中");
  });

  test("只有排队（在跑的那一笔刚结束的窗口）：仍然提示", () => {
    const notice = formatPendingTasksNotice(view({ pendingLabels: ["memory-extract"] }));
    expect(notice).toContain("memory-extract 排队中");
    expect(notice).not.toContain("进行中");
  });

  test("busy 但标签缺失：不渲染 null，用兜底文案", () => {
    const notice = formatPendingTasksNotice(view({ busy: true, busyLabel: null }));
    expect(notice).toContain("未知任务 进行中");
  });

  test("待补里出现与在跑相同的标签：不重复渲染", () => {
    const notice = formatPendingTasksNotice(
      view({ busy: true, busyLabel: "memory-extract", pendingLabels: ["memory-extract"] }),
    );
    expect(notice).not.toContain("排队中");
    expect(notice!.split("memory-extract").length - 1).toBe(1);
  });
});

describe("/cost 后台任务提示（D2）：接进真实命令输出", () => {
  test("空闲时输出里没有后台任务段落", async () => {
    const out = await runCost(IDLE);
    expect(out).not.toContain("后台任务");
    expect(out).not.toContain("费用可能还会增加");
  });

  test("busy 时提示出现在费用块之后、耗时块之前", async () => {
    const out = await runCost(view({ busy: true, busyLabel: "memory-extract" }));
    const lines = out.split("\n");
    // D15 版式：首行由「总费用:」改成「本次会话花费」，耗时段整体缩进两格——
    // 提示仍然紧跟费用块（首行之后）、早于耗时块，这条相对顺序是 D2 的契约。
    const costIdx = lines.findIndex((l) => l.startsWith("本次会话花费"));
    const noticeIdx = lines.findIndex((l) => l.includes("后台任务 memory-extract 进行中"));
    // D8：标签改成「API 耗时（主循环）」——数值只含主循环请求，不再叫「API 耗时」
    const apiIdx = lines.findIndex((l) => l.trimStart().startsWith("API 耗时（主循环）:"));
    expect(costIdx).toBeGreaterThanOrEqual(0);
    expect(noticeIdx).toBeGreaterThan(costIdx);
    expect(noticeIdx).toBeLessThan(apiIdx);
  });

  test("排队中的任务也会写进输出", async () => {
    const out = await runCost(
      view({ busy: true, busyLabel: "memory-extract", pendingLabels: ["session-memory-update"] }),
    );
    expect(out).toContain("session-memory-update 排队中");
  });
});
