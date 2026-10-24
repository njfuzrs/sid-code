/**
 * S1：纯文本短 end_turn（「说了要做却没做」）—— 形态判定 + 续跑决策 + 主循环集成
 *
 * 方案文档 §3 S1 / §6 PR-1。单测必含：
 *  ① 同一 prompt 内「承诺 → nudge → tool_use → 再承诺」第二次不再 nudge（计数器工具执行不清零）；
 *  ② unanswered_retry 与 promise_nudge 配额互不影响；
 *  ③ 有 pending 通知 / 运行中后台任务时不触发。
 *  ④（B1）承诺 → nudge → 直接再承诺：L1 提示照出、形态计入短文本收尾、不二次 nudge。
 *  ⑤（M6）空闲唤醒续跑继承本 prompt 的 nudge 配额，新 prompt 才重置。
 * 另含回放样本：9 条结构候选里词表命中恰为事故段。
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import {
  classifyEndTurnShape,
  classifyPromiseText,
  decidePromiseNudge,
  PROMISE_NUDGE_MESSAGE,
  PLAIN_TEXT_END_TURN_NOTICE,
  PROMISE_NUDGE_DISABLE_ENV,
  reasoningShare,
  initialS1Carry,
  S1_PROMPT_CARRY_KEY,
} from "@sid-code/core/query/promise-nudge.ts";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import {
  enqueuePendingNotification,
  dequeuePendingNotifications,
} from "@sid-code/core/task/notification.ts";
import { clearAllTasks } from "@sid-code/core/task/registry.ts";
import { clearQueue } from "@sid-code/core/query/message-queue-manager.ts";
import { hasInternalOrigin } from "@sid-code/core/context/internal-message.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type {
  AccumulatedResponse,
  ContentBlock,
  Message,
  StreamEvent,
} from "@sid-code/core/llm/types.ts";

// ─── 回放样本（全库 text_len ≤ 80 的结构候选，2026-10-17 回放）───
const INCIDENT = "继续。先读取 website 安装的输出，确认安装成功，然后开始逐处修改。";
const REPLAY_NEGATIVES = [
  "已保留 22 条，丢弃 10 条。",
  "两个子代理还在跑，等它们返回结果后我汇总给你。",
  "清单已全部完成，报告已在上一轮完整交付，无补充。",
  "子代理已在后台运行中，等它完成后我会告诉你最终数字。",
  "两个子代理还在跑，等它们返回结果后我会汇总所有发现，给你一份完整的核验报告。",
  "子代理已派出（task_id: `ai8tk9wgc`），正在后台统计，完成后我会告诉你结果。",
  "sudo 仍需密码，这三步我确实无法代你执行。请在终端粘贴上一条消息里的命令，执行后把输出贴回来即可。",
  "好，01-AgenticLoop 首练。卡片有示范稿，没有欠账，直接开考。\n\n第一题——\n\n你跟我说说，你们那个 agent 的主循环，为什么一定得是个循环？",
];

describe("词表：回放命中恰为事故段", () => {
  test("事故段命中", () => {
    expect(classifyPromiseText(INCIDENT)).toEqual({ lang: "zh", isPromise: true });
  });
  test.each(REPLAY_NEGATIVES)("负样本不命中：%s", (t) => {
    expect(classifyPromiseText(t).isPromise).toBe(false);
  });
  test("完成陈述 / 向用户请求的补充负例", () => {
    for (const t of [
      "已修复，接下来你可以运行测试确认。",
      "下一步需要你确认是否合并？",
      "请告诉我仓库路径，我接着处理。",
      "全部完成。",
    ]) {
      expect(classifyPromiseText(t).isPromise).toBe(false);
    }
  });
  test("英文：识别语言与承诺形态", () => {
    expect(classifyPromiseText("I'll continue with the next file now.")).toEqual({
      lang: "en",
      isPromise: true,
    });
    expect(classifyPromiseText("Done. Let me know if you need anything else.").isPromise).toBe(
      false,
    );
  });
});

describe("形态判定（L1）", () => {
  test("事故形态 = promise_after_tools", () => {
    const s = classifyEndTurnShape({ text: INCIDENT, hasToolUse: false, prevTurnHadToolUse: true });
    expect(s.kind).toBe("promise_after_tools");
    expect(s.textLen).toBe([...INCIDENT].length);
  });
  test("上一轮没调工具（纯问答）= answered", () => {
    expect(
      classifyEndTurnShape({ text: INCIDENT, hasToolUse: false, prevTurnHadToolUse: false }).kind,
    ).toBe("answered");
  });
  test("B1：nudge 之后的再承诺，即使上一次响应没调工具也是 promise_after_tools", () => {
    expect(
      classifyEndTurnShape({
        text: INCIDENT,
        hasToolUse: false,
        prevTurnHadToolUse: false,
        afterPromiseNudge: true,
      }).kind,
    ).toBe("promise_after_tools");
  });

  test("超过阈值的长文本 = answered；空文本 = empty；短完成陈述 = short_after_tools", () => {
    expect(
      classifyEndTurnShape({ text: "继续".repeat(50), hasToolUse: false, prevTurnHadToolUse: true })
        .kind,
    ).toBe("answered");
    expect(
      classifyEndTurnShape({ text: "  ", hasToolUse: false, prevTurnHadToolUse: true }).kind,
    ).toBe("empty");
    expect(
      classifyEndTurnShape({ text: "全部完成。", hasToolUse: false, prevTurnHadToolUse: true })
        .kind,
    ).toBe("short_after_tools");
  });
  test("reasoningShare：分母 0 返回 0，reasoning 不超过 output", () => {
    expect(reasoningShare(10, 0)).toBe(0);
    expect(reasoningShare(96, 100)).toBe(0.96);
    expect(reasoningShare(200, 100)).toBe(1);
  });
});

describe("续跑决策（L2）", () => {
  const promise = classifyEndTurnShape({
    text: INCIDENT,
    hasToolUse: false,
    prevTurnHadToolUse: true,
  });
  const base = {
    nudgeCount: 0,
    runningBackgroundTasks: false,
    pendingNotifications: false,
    disabled: false,
  };
  test("全部条件满足 → fire", () => {
    expect(decidePromiseNudge(promise, base)).toEqual({ fire: true, lang: "zh" });
  });
  test("非承诺形态 → null（不是候选）", () => {
    const s = classifyEndTurnShape({
      text: "全部完成。",
      hasToolUse: false,
      prevTurnHadToolUse: true,
    });
    expect(decidePromiseNudge(s, base)).toBeNull();
  });
  test("封顶 / 后台任务 / 待投递通知 / env 关闭 / 英文 各自给出原因", () => {
    expect(decidePromiseNudge(promise, { ...base, nudgeCount: 1 })).toMatchObject({
      reason: "capped",
    });
    expect(decidePromiseNudge(promise, { ...base, runningBackgroundTasks: true })).toMatchObject({
      reason: "background_running",
    });
    expect(decidePromiseNudge(promise, { ...base, pendingNotifications: true })).toMatchObject({
      reason: "pending_notifications",
    });
    expect(decidePromiseNudge(promise, { ...base, disabled: true })).toMatchObject({
      reason: "disabled",
    });
    const en = classifyEndTurnShape({
      text: "I'll continue with the next file now.",
      hasToolUse: false,
      prevTurnHadToolUse: true,
    });
    expect(decidePromiseNudge(en, base)).toMatchObject({ fire: false, reason: "en_measure_only" });
  });
});

// ─── 主循环集成 ───

function makeConfig(): Config {
  return {
    model: "claude-opus-4-8",
    provider: "anthropic",
    maxTurns: 20,
    maxTokens: 128000,
  } as unknown as Config;
}
async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock */
}
let toolSeq = 0;
function toolResp(): AccumulatedResponse {
  toolSeq++;
  return {
    role: "assistant",
    content: [
      { type: "tool_use", id: `call-${toolSeq}`, name: "read", input: { file_path: "/tmp/a.ts" } },
    ],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 30 },
  } as AccumulatedResponse;
}
function textResp(text: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}
function unansweredResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "思考发散 ".repeat(60) }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 0 },
    _unansweredEndTurn: true,
  } as AccumulatedResponse;
}

function setup(responses: AccumulatedResponse[], onCall?: (n: number) => void) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const persisted: Message[] = [];
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "修正问题然后提 PR" }] });
  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      onCall?.(call);
      return responses[call++] ?? textResp("全部完成，已经提交。");
    },
    executeTools: async (content) => ({
      results: content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" })),
    }),
    autoCompact: async () => {},
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
    traceAppendEvent: (ev) => {
      events.push({ event: ev.event, data: (ev.data ?? {}) as Record<string, unknown> });
    },
    sessionStore: {
      appendMessage: (m: Message) => persisted.push(m),
    } as unknown as QueryDeps["sessionStore"],
  };
  const loopConfig: QueryLoopConfig = {
    config: makeConfig(),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-promise-nudge"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, events, ctxMgr, persisted, calls: () => call };
}

async function drain(loopConfig: QueryLoopConfig) {
  const yields: Array<{ kind: string; text?: string; persistent?: boolean }> = [];
  for await (const ev of queryLoop(loopConfig)) yields.push(ev as any);
  return yields;
}

const transitions = (
  events: Array<{ event: string; data: Record<string, unknown> }>,
  type: string,
) => events.filter((e) => e.event === "LoopTransition" && e.data.type === type).length;

// L2 的结构排除项读全局 task registry / 通知队列：同进程里先跑的测试（cli 全量）
// 可能留下运行中的后台任务或未投递通知，导致「应触发」用例被误判为排除。每条用例前清干净。
beforeEach(() => {
  clearAllTasks();
  dequeuePendingNotifications();
  clearQueue();
});

afterEach(() => {
  clearQueue();
  delete process.env[PROMISE_NUDGE_DISABLE_ENV];
});

describe("主循环集成", () => {
  test("事故形态：续跑一次，nudge 落盘且对 TUI 隐藏，outcome=tool_use", async () => {
    const { loopConfig, events, ctxMgr, persisted } = setup([
      toolResp(),
      textResp(INCIDENT),
      toolResp(),
    ]);
    const yields = await drain(loopConfig);
    expect(transitions(events, "promise_nudge")).toBe(1);
    const nudge = ctxMgr
      .getMessages()
      .find((m) => m.content.some((b) => b.type === "text" && b.text === PROMISE_NUDGE_MESSAGE));
    expect(nudge && hasInternalOrigin(nudge)).toBe(true);
    // 显式落盘：-c 恢复后 nudge 仍在
    expect(persisted.some((m) => m._meta?.origin === "promise-nudge")).toBe(true);
    const pn = events.filter((e) => e.event === "PromiseNudge");
    expect(pn).toHaveLength(1);
    expect(pn[0].data).toMatchObject({ fired: true, outcome: "tool_use", lang: "zh" });
    // 最终答复是长完成陈述 → 不再出常驻提示
    expect(yields.some((y) => y.persistent)).toBe(false);
    const shapes = events.filter((e) => e.event === "EndTurnShape").map((e) => e.data.kind);
    expect(shapes).toEqual(["promise_after_tools", "short_after_tools"]);
  });

  test("① 承诺 → nudge → tool_use → 再承诺：第二次不再 nudge，并常驻提示", async () => {
    const { loopConfig, events } = setup([
      toolResp(),
      textResp(INCIDENT),
      toolResp(),
      textResp(INCIDENT),
    ]);
    const yields = await drain(loopConfig);
    expect(transitions(events, "promise_nudge")).toBe(1);
    const skipped = events.filter((e) => e.event === "PromiseNudge" && e.data.fired === false);
    expect(skipped.map((e) => e.data.skip_reason)).toEqual(["capped"]);
    const notice = yields.filter((y) => y.kind === "system" && y.persistent);
    expect(notice.map((y) => y.text)).toEqual([PLAIN_TEXT_END_TURN_NOTICE]);
    // 提示必须在 done 之前 yield（TUI 按序消费，done 之后才清 transient）
    const kinds = yields.map((y) => (y.persistent ? "notice" : y.kind));
    expect(kinds.indexOf("notice")).toBe(kinds.length - 2);
    expect(kinds[kinds.length - 1]).toBe("done");
  });

  test("② unanswered_retry 与 promise_nudge 配额互不影响", async () => {
    const { loopConfig, events } = setup([
      toolResp(),
      unansweredResp(),
      unansweredResp(),
      toolResp(),
      textResp(INCIDENT),
      toolResp(),
    ]);
    await drain(loopConfig);
    expect(transitions(events, "unanswered_retry")).toBe(2);
    expect(transitions(events, "promise_nudge")).toBe(1);
  });

  test("③ 有待投递通知时不触发", async () => {
    // 循环入口会先 drain 一次待投递通知，所以要在「承诺」那一轮响应时才入队（任务刚完成、尚未投递）
    const { loopConfig, events } = setup([toolResp(), textResp(INCIDENT)], (n) => {
      if (n === 1) enqueuePendingNotification("<task-notification>done</task-notification>");
    });
    const yields = await drain(loopConfig);
    expect(transitions(events, "promise_nudge")).toBe(0);
    const pn = events.find((e) => e.event === "PromiseNudge");
    expect(pn?.data).toMatchObject({ fired: false, skip_reason: "pending_notifications" });
    expect(yields.some((y) => y.persistent)).toBe(true);
  });

  test("env 止血口：只关 L2，L1 提示照常", async () => {
    process.env[PROMISE_NUDGE_DISABLE_ENV] = "1";
    const { loopConfig, events } = setup([toolResp(), textResp(INCIDENT)]);
    const yields = await drain(loopConfig);
    expect(transitions(events, "promise_nudge")).toBe(0);
    expect(yields.some((y) => y.persistent)).toBe(true);
  });

  test("纯问答（上一轮没调工具）：零行为、无提示", async () => {
    const { loopConfig, events } = setup([textResp("继续说一下这个函数做什么。")]);
    const yields = await drain(loopConfig);
    expect(transitions(events, "promise_nudge")).toBe(0);
    expect(yields.some((y) => y.persistent)).toBe(false);
    expect(events.find((e) => e.event === "EndTurnShape")?.data).toMatchObject({
      kind: "answered",
      prev_turn_had_tool_use: false,
    });
  });

  test("S4 事实：写入 / 只读计数与推理占比进 EndTurnShape", async () => {
    const { loopConfig, events } = setup([toolResp(), toolResp(), textResp("全部完成。")]);
    await drain(loopConfig);
    const d = events.find((e) => e.event === "EndTurnShape")!.data;
    expect(d).toMatchObject({
      prompt_readonly_count: 2,
      prompt_edit_write_count: 0,
      reasoning_share: 0,
    });
    expect(d.prompt_output_tokens).toBe(80);
  });
});

describe("S1 收尾链：L2 失败路径与跨唤醒配额（复审 B1 / M6）", () => {
  test("④ 承诺 → nudge → 直接再承诺（不调工具）：常驻提示 + 计入短文本 + 不二次 nudge", async () => {
    const { loopConfig, events } = setup([toolResp(), textResp(INCIDENT), textResp(INCIDENT)]);
    const yields = await drain(loopConfig);
    expect(transitions(events, "promise_nudge")).toBe(1);
    // 第二次 end_turn 必须仍是承诺形 —— 修复前这里是 "answered"
    const shapes = events.filter((e) => e.event === "EndTurnShape").map((e) => e.data.kind);
    expect(shapes).toEqual(["promise_after_tools", "promise_after_tools"]);
    const pn = events.filter((e) => e.event === "PromiseNudge").map((e) => e.data);
    expect(pn).toEqual([
      expect.objectContaining({ fired: true, outcome: "text" }),
      expect.objectContaining({ fired: false, skip_reason: "capped" }),
    ]);
    const notice = yields.filter((y) => y.kind === "system" && y.persistent);
    expect(notice.map((y) => y.text)).toEqual([PLAIN_TEXT_END_TURN_NOTICE]);
    expect(yields[yields.length - 1].kind).toBe("done");
  });

  test("⑤ 续跑（continuation）继承配额：同一 prompt 第二次承诺不再 nudge", async () => {
    const first = setup([toolResp(), textResp(INCIDENT), toolResp()]);
    await drain(first.loopConfig);
    expect(transitions(first.events, "promise_nudge")).toBe(1);

    // 空闲唤醒：同一 SessionState、同一 ctxMgr，再跑一次 queryLoop
    const resumed = setup([toolResp(), textResp(INCIDENT)]);
    resumed.loopConfig.sessionState = first.loopConfig.sessionState;
    resumed.loopConfig.continuation = true;
    const yields = await drain(resumed.loopConfig);
    expect(transitions(resumed.events, "promise_nudge")).toBe(0);
    const pn = resumed.events.find((e) => e.event === "PromiseNudge");
    expect(pn?.data).toMatchObject({ fired: false, skip_reason: "capped" });
    expect(yields.some((y) => y.persistent)).toBe(true);
  });

  test("⑤ 新的用户 prompt（缺省 continuation）重置配额", async () => {
    const first = setup([toolResp(), textResp(INCIDENT), toolResp()]);
    await drain(first.loopConfig);
    const next = setup([toolResp(), textResp(INCIDENT), toolResp()]);
    next.loopConfig.sessionState = first.loopConfig.sessionState;
    await drain(next.loopConfig);
    expect(transitions(next.events, "promise_nudge")).toBe(1);
  });

  test("⑤ 续跑继承「上一次含 tool_use」：唤醒后首轮承诺仍按工具后判定", async () => {
    // 首个 queryLoop 停在一次工具调用之后（maxTurns 耗尽），续跑首轮就是承诺
    const first = setup([toolResp()]);
    first.loopConfig.config = { ...makeConfig(), maxTurns: 1 } as unknown as Config;
    await drain(first.loopConfig);
    const resumed = setup([textResp(INCIDENT), toolResp()]);
    resumed.loopConfig.sessionState = first.loopConfig.sessionState;
    resumed.loopConfig.continuation = true;
    await drain(resumed.loopConfig);
    const shapes = resumed.events.filter((e) => e.event === "EndTurnShape").map((e) => e.data.kind);
    expect(shapes[0]).toBe("promise_after_tools");
  });

  test("initialS1Carry：续跑继承、新 prompt 归零、脏值兜底", () => {
    const prev = { promiseNudgeCount: 1, prevResponseHadToolUse: true };
    expect(initialS1Carry(true, prev)).toEqual(prev);
    expect(initialS1Carry(false, prev)).toEqual({
      promiseNudgeCount: 0,
      prevResponseHadToolUse: false,
    });
    expect(initialS1Carry(true, undefined)).toEqual({
      promiseNudgeCount: 0,
      prevResponseHadToolUse: false,
    });
    expect(initialS1Carry(true, { promiseNudgeCount: "x" })).toEqual({
      promiseNudgeCount: 0,
      prevResponseHadToolUse: false,
    });
    expect(S1_PROMPT_CARRY_KEY).toBe("s1PromptCarry");
  });
});

describe("M6 接线：engine 的空闲唤醒续跑必须声明 continuation", () => {
  // engine 层没有可单测的 QueryEngine 脚手架；这里锁住唯一的续跑入口确实把 continuation 传下去。
  // 漏了它，上面「续跑继承配额」的用例全绿，而生产里每次唤醒仍会重置配额。
  test("resumeWithNotifications → runLoop(…, { continuation: true })；submitMessage 不带", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dir, "../../src/query/engine.ts"), "utf8").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    const resumeAt = src.indexOf("async *resumeWithNotifications()");
    const runLoopAt = src.indexOf("private async *runLoop(");
    expect(resumeAt).toBeGreaterThan(0);
    expect(runLoopAt).toBeGreaterThan(resumeAt);
    expect(src.slice(resumeAt, runLoopAt)).toContain("{ continuation: true }");
    const submitAt = src.indexOf("async *submitMessage(");
    expect(src.slice(submitAt, resumeAt)).not.toContain("continuation");
    expect(src.slice(runLoopAt)).toContain("continuation: opts.continuation === true");
  });
});
