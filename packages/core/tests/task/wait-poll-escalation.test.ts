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
  STATUS_POLL_PROBE_INTERVAL_MS,
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

  test("T-P5-6 两档事件的 payload 都带 wait_ids（与 GoalGateDecision 同口径）", () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    setWaitTraceSink((name, payload) => {
      events.push({ name, payload: payload as Record<string, unknown> });
    });
    const escalation = createWaitPollEscalation();
    // 两个等待源：验证 wait_ids 是「全部在盯的」，不是「第一个」
    const waits = [
      monitorWait(),
      { ...monitorWait(), id: "w9z1", kind: "wakeup" as const, subjects: ["gh:pr:847"] },
    ];
    const ctx = makeCtx({ escalation, waits });
    for (let i = 0; i < WAIT_POLL_BLOCK_AFTER; i++) {
      const r = checkStatusQueryPoll("bash", { command: CMD }, ctx);
      if (!r.intercept) recordStatusQueryResult(CMD, `state-${i}`, ctx); // 每轮不同 → P1 不拦
    }
    const level1 = events.find(
      (e) => e.name === WAIT_POLL_ESCALATED_EVENT_NAME && e.payload.level === 1,
    );
    const level2 = events.find(
      (e) => e.name === WAIT_POLL_ESCALATED_EVENT_NAME && e.payload.level === 2,
    );
    expect(level1).toBeTruthy();
    expect(level2).toBeTruthy();
    // 没有 wait_ids 时离线只能按 subject 聚合，看不出「升级那一刻有几个等待源在盯」
    expect(level1!.payload.wait_ids).toEqual(["m7k2", "w9z1"]);
    expect(level2!.payload.wait_ids).toEqual(["m7k2", "w9z1"]);
  });

  test("T-P5-7 第 5 次被 P1 拦下时提示不丢：hinted 延后到真正送达", () => {
    // `hinted` 是一次性标记，最容易被白烧的形态是「第 5 次恰好落在 P1 的拦截分支」：
    // 拦截时 `tool-executor` 只消费 `!intercept` 的 hint，若在那里置位，提示此后永不补发。
    //
    // 也不能像方案 §4.10 原文那样「在拦截回执前面加一句前缀」—— 拦截回执必须逐字节恒定，
    // `P1-intervened-true` 这个 G2 用例靠「连续相同返回值」计数（2026-11-17 实测：
    // 加前缀 → 该用例红；去掉 → 立刻绿）。所以改成「没送出去就不算送过」。
    const escalation = createWaitPollEscalation();
    // 等待源**不覆盖** `gh_pr_checks` → 探测窗口 120s 后能放行（covered 时会一直拦）
    const ctx = makeCtx({
      escalation,
      waits: [{ ...monitorWait(), commandFamilies: ["gh_run_list"] }],
    });
    // 先攒到 sameRun=2（第 1 次相同放行、第 2 次相同起拦），P1 就此生效
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(false);
    recordStatusQueryResult(CMD, "same-output", ctx);
    expect(checkStatusQueryPoll("bash", { command: CMD }, ctx).intercept).toBe(false);
    recordStatusQueryResult(CMD, "same-output", ctx);
    expect(escalation.count).toBe(2);

    // 把计数推到「下一次就是第 5 次」，构造第 5 次被 P1 拦下的形态
    escalation.count = WAIT_POLL_HINT_AFTER - 1;
    const r = checkStatusQueryPoll("bash", { command: CMD }, ctx);
    expect(r.intercept).toBe(true);
    if (!r.intercept) throw new Error("unreachable");
    // 拦截回执恒定：不含 P5 的任何文案（这条约束由 G2 用例 P1-intervened-true 反向锁着）
    expect(r.output).not.toContain("[等待期重复查询]");
    // 关键：这次没送出去，所以不算送过
    expect(escalation.hinted).toBe(false);

    // 探测窗口到期 → 下一次放行，提示此时才送达（计数用送达时的真实次数，比「第 5 次」更准）
    const later = { ...ctx, now: () => T0 + STATUS_POLL_PROBE_INTERVAL_MS + 1 };
    const delivered = checkStatusQueryPoll("bash", { command: CMD }, later);
    expect(delivered.intercept).toBe(false);
    if (delivered.intercept) throw new Error("unreachable");
    expect(delivered.hint).toContain(`第 ${WAIT_POLL_HINT_AFTER + 1} 次`);
    expect(delivered.hint).toContain(String(WAIT_POLL_BLOCK_AFTER));
    expect(escalation.hinted).toBe(true);

    // 再放行一次也不重复提示（一次性）
    const another = { ...ctx, now: () => T0 + 2 * STATUS_POLL_PROBE_INTERVAL_MS + 2 };
    const again = checkStatusQueryPoll("bash", { command: CMD }, another);
    expect(again.intercept).toBe(false);
    if (!again.intercept) expect(again.hint).toBeUndefined();
  });
});

/** 测试里给 helper 一个名字，避免直接读两遍 store */
function resolveNewMessage(store: {
  get: (k: string) => unknown;
  set: (k: string, v: unknown) => void;
}): void {
  resetWaitPollEscalationForNewMessage(store);
}
