/**
 * P5：等待期重复查询的会话级计数与两档升级（方案 §4.10，T-P5-*）。
 *
 * ## 为什么 P1 之外还要这一层
 *
 * P1 的判据是「结果没变才拦」。空转的主形态是「结果每轮都变一点」：`gh run list` 的行数 /
 * ELAPSED、`gh pr list --json` 的时间戳、`date` 打头的轮询。这些在 P1 下**一次都不会被拦**，
 * 于是在 Trigger 会话里模型连续 400+ 轮「看一眼再等」，而 goal 模式下轮次上限对后台等待
 * 已经让位 —— 整段会话烧在空转上。
 *
 * 两档都不看输出、只数次数：第 5 次给一句提示（不阻断），第 15 次起硬拦并给出路。
 * 硬拦必须排在 P1 的 120s 探测窗口**之前**，否则「状态一直在变」的查询永远走不到拦截分支。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  __resetStatusPollGuardForTest,
  checkStatusQueryPoll,
  createWaitPollEscalation,
  getWaitPollEscalation,
  recordStatusQueryResult,
  resetWaitPollEscalationForNewMessage,
  WAIT_POLL_BLOCK_AFTER,
  WAIT_POLL_ESCALATED_EVENT_NAME,
  WAIT_POLL_HINT_AFTER,
  type StatusPollContext,
  type WaitPollEscalation,
} from "@sid-code/core/task/status-poll-guard.ts";
import { setWaitTraceSink, type WaitSource } from "@sid-code/core/task/wait-registry.ts";

const T0 = 1_700_000_000_000;
const CMD = "gh pr checks 846";

function monitorWait(deadlineAt = T0 + 600_000): WaitSource {
  return {
    id: "m7k2",
    kind: "monitor",
    promise: { kind: "deadline", deadlineAt },
    description: "PR #846 CI",
    registeredAt: T0,
    subjects: ["gh:pr:846"],
    commandFamilies: ["gh_pr_checks"],
  };
}

function makeCtx(opts: {
  escalation?: WaitPollEscalation;
  hasWait?: boolean;
  waits?: WaitSource[];
}): StatusPollContext {
  return {
    hasDeclaredExternalWait: () => opts.hasWait ?? true,
    listWaits: () => opts.waits ?? [monitorWait()],
    memo: { entries: new Map() },
    ...(opts.escalation ? { escalation: opts.escalation } : {}),
    now: () => T0,
  };
}

/** 最小会话存储（等价于 SessionState 的 get/set 两个方法） */
function makeStore(): { get: (k: string) => unknown; set: (k: string, v: unknown) => void } {
  const map = new Map<string, unknown>();
  return { get: (k) => map.get(k), set: (k, v) => void map.set(k, v) };
}

beforeEach(() => {
  __resetStatusPollGuardForTest();
  setWaitTraceSink(null);
});

describe("P5 两档升级", () => {
  test("T-P5-1 连续 5 次不同结果 → 第 5 次有一次性提示，第 6 次不再有", () => {
    const escalation = createWaitPollEscalation();
    const ctx = makeCtx({ escalation });
    for (let i = 0; i < WAIT_POLL_HINT_AFTER + 1; i++) {
      const r = checkStatusQueryPoll("bash", { command: CMD }, ctx);
      expect(r.intercept).toBe(false);
      if (i === WAIT_POLL_HINT_AFTER - 1) {
        if (r.intercept) throw new Error("unreachable");
        expect(r.hint).toContain(`第 ${WAIT_POLL_HINT_AFTER} 次`);
        expect(r.hint).toContain("gh:pr:846");
        // 提示里写清上限，模型才知道还能查几次
        expect(r.hint).toContain(String(WAIT_POLL_BLOCK_AFTER));
      } else if (!r.intercept) {
        expect(r.hint).toBeUndefined();
      }
      // 每轮结果都不同 → P1 一次都不拦（这正是空转的真实形态）
      recordStatusQueryResult(CMD, `state-${i}`, ctx);
    }
    expect(escalation.count).toBe(WAIT_POLL_HINT_AFTER + 1);
    expect(escalation.hinted).toBe(true);
  });

  test("T-P5-2 第 15 次起不执行：前 14 次都执行，第 15 次拦截", () => {
    const escalation = createWaitPollEscalation();
    const ctx = makeCtx({ escalation });
    let executed = 0;
    for (let i = 0; i < WAIT_POLL_BLOCK_AFTER + 3; i++) {
      const r = checkStatusQueryPoll("bash", { command: CMD }, ctx);
      if (r.intercept) continue;
      executed += 1;
      recordStatusQueryResult(CMD, `state-${i}`, ctx); // 每轮都不同
    }
    expect(executed).toBe(WAIT_POLL_BLOCK_AFTER - 1);
    expect(escalation.count).toBe(WAIT_POLL_BLOCK_AFTER + 3);
  });

  test("T-P5-3 硬拦回执：task_stop 出口 + 上次摘要 + 事件 level 2", () => {
    const escalation = createWaitPollEscalation();
    const ctx = makeCtx({ escalation });
    // 先攒到 14 次（每轮结果都不同，P1 不拦）
    for (let i = 0; i < WAIT_POLL_BLOCK_AFTER - 1; i++) {
      checkStatusQueryPoll("bash", { command: CMD }, ctx);
      recordStatusQueryResult(
        CMD,
        i === 0 ? "test\tpending\t0\thttps://x/1\t" : `test\tpending\t0\thttps://x/${i}\t`,
        ctx,
      );
    }
    // 第 15 次：事件
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    setWaitTraceSink((name, payload) => {
      events.push({ name, payload: payload as Record<string, unknown> });
    });
    const r = checkStatusQueryPoll("bash", { command: CMD }, ctx);
    expect(r.intercept).toBe(true);
    if (!r.intercept) throw new Error("unreachable");
    expect(r.subject).toBe("gh:pr:846");
    // 出口：等待源还在时给 task_stop <id>
    expect(r.output).toContain("task_stop m7k2");
    expect(r.output).toContain("本次未执行");
    expect(r.output).toContain("超过上限");
    // 上次摘要（被拦不等于信息归零）
    expect(r.output).toContain("项 pending");
    // 事件：level 2 + 计数 + 对象
    const escalated = events.find(
      (e) => e.name === WAIT_POLL_ESCALATED_EVENT_NAME && e.payload.level === 2,
    );
    expect(escalated).toBeTruthy();
    expect(escalated!.payload.count).toBe(WAIT_POLL_BLOCK_AFTER);
    expect(escalated!.payload.subject).toBe("gh:pr:846");
    // 之后继续拦，但事件只落一次（避免每轮一条事件）
    const again = checkStatusQueryPoll("bash", { command: CMD }, ctx);
    expect(again.intercept).toBe(true);
    expect(
      events.filter((e) => e.name === WAIT_POLL_ESCALATED_EVENT_NAME && e.payload.level === 2),
    ).toHaveLength(1);
  });

  test("T-P5-4 等待源全部释放 → 计数清零；用户新消息 → 计数清零", () => {
    // 释放路径：hasDeclaredExternalWait 变 false 的那一次 check 顺手清零
    const escalation = createWaitPollEscalation();
    const ctx = makeCtx({ escalation });
    for (let i = 0; i < 3; i++) checkStatusQueryPoll("bash", { command: CMD }, ctx);
    expect(escalation.count).toBe(3);

    const released = { ...ctx, hasDeclaredExternalWait: () => false };
    expect(checkStatusQueryPoll("bash", { command: CMD }, released).intercept).toBe(false);
    expect(escalation.count).toBe(0);

    // 用户新消息路径：走会话存储
    const store = makeStore();
    const sessionState = getWaitPollEscalation(store);
    sessionState.count = 12;
    sessionState.hinted = true;
    resolveNewMessage(store);
    expect(getWaitPollEscalation(store).count).toBe(0);
    expect(getWaitPollEscalation(store).hinted).toBe(false);
  });

  test("T-P5-5 两个连续会话（同一进程）第二个会话从 0 起", () => {
    const first = makeStore();
    const e1 = getWaitPollEscalation(first);
    e1.count = 14;
    e1.hinted = true;
    // 第二个会话 = 新的 SessionState（新的 store），不该继承上一段的账
    const second = makeStore();
    const e2 = getWaitPollEscalation(second);
    expect(e2.count).toBe(0);
    expect(e2.hinted).toBe(false);
    // 老会话的对象没被影响（同一个对象仍然指向自己那份）
    expect(e1.count).toBe(14);
  });

  test("不传 escalation 时 P1 行为逐字节不变（P5 是叠加层，不是替换）", () => {
    const ctx = makeCtx({});
    for (let i = 0; i < 30; i++) {
      const r = checkStatusQueryPoll("bash", { command: CMD }, ctx);
      if (r.intercept) continue;
      recordStatusQueryResult(CMD, `state-${i}`, ctx);
    }
    // 没有计数对象 → 不会有 hint，也不会硬拦（第 30 次仍由 P1 判）
    const r = checkStatusQueryPoll("bash", { command: CMD }, ctx);
    if (!r.intercept) expect(r.hint).toBeUndefined();
  });

  test("跨多个签名共同计数（不同命令算在同一次等待里）", () => {
    const escalation = createWaitPollEscalation();
    const ctx = makeCtx({ escalation });
    const cmds = ["gh pr checks 846", "gh pr list --state open", "gh run list --limit 6"];
    let blocked = 0;
    for (let i = 0; i < WAIT_POLL_BLOCK_AFTER + 2; i++) {
      const cmd = cmds[i % cmds.length]!;
      const r = checkStatusQueryPoll("bash", { command: cmd }, ctx);
      if (r.intercept) blocked += 1;
      else recordStatusQueryResult(cmd, `out-${i}`, ctx);
    }
    expect(escalation.count).toBe(WAIT_POLL_BLOCK_AFTER + 2);
    // 循环 17 次 → 第 15、16、17 次都拦（超过上限后持续拦，不会只拦一次）
    expect(blocked).toBe(3);
  });
});

/** 测试里给 helper 一个名字，避免直接读两遍 store */
function resolveNewMessage(store: {
  get: (k: string) => unknown;
  set: (k: string, v: unknown) => void;
}): void {
  resetWaitPollEscalationForNewMessage(store);
}
