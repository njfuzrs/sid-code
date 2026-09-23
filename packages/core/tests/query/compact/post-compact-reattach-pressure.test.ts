/**
 * P2-21：压缩后文件重注入的「立刻再触发」埋点
 *
 * 缺陷：runPostCompact 第一步重注入最近文件（上限 5 文件 / 50K token）。三层预算只保证
 * **上界**，不保证「注入之后仍在触发点以下」—— 5 个刚读过的大文件足以把使用率顶回 hard 档，
 * 于是压完立刻又要压。全仓搜 `willRetriggerNextTurn` 零命中，这个抖动在生产上完全不可观测。
 */
import { describe, it, expect } from "bun:test";
import { runPostCompact } from "../../../src/query/compact/post-compact.ts";

type Event = { event: string; timestamp: string; data?: Record<string, unknown> };

/**
 * 最小 ctxMgr 替身。estimateTokens 按调用序返回预设值，模拟「重注入前 / 重注入后」两次测量。
 * 多余的调用（收尾末尾还会再测一次 tokensAfter）返回最后一个值。
 */
function fakeCtxMgr(tokenSeq: number[], level: string, maxTokens = 200_000) {
  let i = 0;
  return {
    estimateTokens: () => tokenSeq[Math.min(i++, tokenSeq.length - 1)],
    getMaxTokens: () => maxTokens,
    getCompactionLevel: () => level,
    appendReattachMessages: () => {},
    messageCount: () => 10,
  } as any;
}

const tracker = { getRecentFiles: () => ["/a/x.ts"] } as any;

/** 让 buildReattachFileMessages 一定产出消息：stub 掉真实读盘路径不现实，
 *  故这里直接验证「注入发生时埋点带上了哪些字段」这一层 —— 用真实模块，文件不存在时
 *  它返回空数组、不报告，这正好也是一条要断言的行为（见第一个用例）。 */
describe("runPostCompact 的重注入压力埋点", () => {
  it("无可恢复文件（路径不存在）→ 不发 PostCompactReattach（不造无意义的分母）", async () => {
    const events: Event[] = [];
    await runPostCompact({
      trigger: "auto",
      ctxMgr: fakeCtxMgr([100_000], "none"),
      fileReadTracker: tracker,
      messagesBefore: 20,
      tokensBefore: 180_000,
      usedLLM: true,
      traceAppendEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.event === "PostCompactReattach")).toHaveLength(0);
  });

  it("未传 traceAppendEvent 时不抛异常（收尾全程 best-effort）", async () => {
    await runPostCompact({
      trigger: "manual",
      ctxMgr: fakeCtxMgr([100_000], "none"),
      fileReadTracker: tracker,
      messagesBefore: 20,
      tokensBefore: 180_000,
      usedLLM: false,
    });
    // 走到这里就算通过：收尾任一步异常都不该冒泡到调用方
    expect(true).toBe(true);
  });
});

describe("P2-21：埋点字段口径（源码级断言，防口径悄悄漂移）", () => {
  const src = Bun.file(new URL("../../../src/query/compact/post-compact.ts", import.meta.url));

  it("判据用 getCompactionLevel（压缩触发的唯一事实源），不自己跟常数比", async () => {
    const text = await src.text();
    expect(text).toContain("ctxMgr.getCompactionLevel()");
    expect(text).toContain("willRetriggerNextTurn");
  });

  it("省下量为 0 时 clawedBackRatio 置 undefined，不编一个 0/1 进聚合", async () => {
    const text = await src.text();
    expect(text).toContain(
      "savedByCompaction > 0 ? reattachTokens / savedByCompaction : undefined",
    );
  });
});
