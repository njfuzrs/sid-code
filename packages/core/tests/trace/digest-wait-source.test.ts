/**
 * digest：等待源口径（R9）
 *
 * 补的缺陷：「重复等待」在 R2 上线后变成不可观测 —— 判成 duplicate 的入口调用
 * 根本不登记，轨迹里什么都不剩。本组用例锁住三件事：
 *
 * 1. **真实轨迹的期望值**：夹具取自 20261112-180157-b0aa0f1e 的原始轨迹，
 *    `max_concurrent_waits_per_subject = 4` / `stale_notification_claims = 4`
 *    是方案 §7.3 用独立参考实现（读 raw.jsonl）算出、并人工逐条核过的值，
 *    **不是从本实现反推的**（反推会让测试只证明「实现自洽」）。
 * 2. **四个反例**：少一个反例，口径就可能靠「宁可多算」通过验收 ——
 *    那是把误报换成漏报，指标看起来更好而实际问题没变。
 * 3. **三态**：无 history / 无等待事件时是 undefined / null，不能落 0
 *    （0 会被读成「一次都没误读」，而真相是「算不出来」）。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateWaitSourceStats } from "../../src/trace/digest.ts";

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/wait-source/b0aa0f1e");

function loadFixtureEvents(): Array<{
  event?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}> {
  return readFileSync(join(FIXTURE_DIR, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function loadFixtureHistory(): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, "history.json"), "utf8"));
}

/** 起了一次后台等待的 tool_result（文案与 bash 的后台回执逐字一致） */
function launchReceipt(): Record<string, unknown> {
  return {
    type: "tool_result",
    tool_use_id: "t1",
    content: JSON.stringify({
      task_id: "abc12345",
      status: "running",
      message:
        "命令已作为后台任务启动 (task_id: abc12345)。完成后会以 <task-notification> 自动通知你。",
    }),
  };
}

function assistantThinking(text: string): Record<string, unknown> {
  return { role: "assistant", content: [{ type: "thinking", thinking: text }] };
}

/** 起了一次 monitor 的 tool_result（文案与 monitor.ts 的启动回执逐字一致，id 形如 m+8 位） */
function monitorLaunchReceipt(): Record<string, unknown> {
  return {
    type: "tool_result",
    tool_use_id: "t2",
    content: JSON.stringify({
      task_id: "mabcd1234",
      status: "running",
      message:
        "已启动监控 mabcd1234（等 PR 780 的 CI），最晚 12:30:00 结束（30 分钟期限）。\n" +
        "每条输出会作为通知送达，期间不需要查询状态，也不需要 sleep。",
    }),
  };
}

/** R2 判成 duplicate 时的 tool_result（文案与 formatDuplicateWaitReceipt 一致，不是启动回执） */
function duplicateWaitReceipt(): Record<string, unknown> {
  return {
    type: "tool_result",
    tool_use_id: "t3",
    content: JSON.stringify({
      status: "duplicate",
      message:
        "已有等待在盯同一个对象，本次未重复启动：\n- 后台任务 a1（bash wait-779.sh），对象 gh:pr:779，最晚 12:00:00 回报",
    }),
  };
}

const EVENT_REGISTERED = "WaitRegistered";
const EVENT_RELEASED = "WaitReleased";
const EVENT_ADMISSION = "WaitAdmission";

function registered(id: string, description: string, subjects?: string[]) {
  return {
    event: EVENT_REGISTERED,
    timestamp: "2026-11-12T10:00:00.000Z",
    data: {
      id,
      kind: "shell",
      promise_kind: "deadline",
      description,
      ...(subjects ? { subjects } : {}),
    },
  };
}

function released(id: string) {
  return {
    event: EVENT_RELEASED,
    timestamp: "2026-11-12T10:01:00.000Z",
    data: { id, kind: "shell", reason: "terminal" },
  };
}

describe("R9 验收 1：b0aa0f1e 真实轨迹", () => {
  test("同一对象最大并存 4（同脚本连挂 4 份）、误读 4（6 次启动回执里 4 次当轮就声称被杀）", () => {
    const stats = aggregateWaitSourceStats(loadFixtureEvents(), loadFixtureHistory());
    expect(stats).not.toBeNull();
    // 6 条登记：10:25:04 一条 + 10:55:31/10:55:52/10:56:04/10:56:17 四条重挂 + 11:01:37 一条
    expect(stats!.registered).toBe(6);
    // 10:56:17–10:59:54 之间那 4 条同脚本等待同时活着。
    // 夹具是 R1 之前的轨迹（WaitRegistered 没有 subjects），走的是 description 回退口径 ——
    // 这条断言同时证明回退口径在真实数据上算得对。
    expect(stats!.maxConcurrentWaitsPerSubject).toBe(4);
    // 6 次启动回执 → 4 次的下一个 thinking 前 300 字就声称「又被杀 / 等待期限到」。
    // 期望值与方案 §7.3 的 raw.jsonl 参考实现（4 / 2 / 1 三会话）逐一对齐。
    expect(stats!.staleNotificationClaims).toBe(4);
    // R2 之前没有准入事件，不能凭空记出 duplicate/replace
    expect(stats!.admissions).toBe(0);
    expect(stats!.waitDuplicatesBlocked).toBe(0);
  });
});

describe("R9 反例：误读判据不能靠「宁可多算」通过", () => {
  test("反例 1：起了等待，但下一个 thinking 没声称被杀 → 不计", () => {
    const history = [
      { role: "user", content: [launchReceipt()] },
      assistantThinking("后台等待任务已启动，先结束本轮，等通知。"),
    ];
    const stats = aggregateWaitSourceStats([registered("a1", "bash wait.sh")], history);
    expect(stats!.staleNotificationClaims).toBe(0);
  });

  test("反例 2：起了等待后真实通知送达，thinking 说「又超时」也不算误读（拿到了事实）", () => {
    const history = [
      { role: "user", content: [launchReceipt()] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[系统通知 —— 非用户输入]\n<task-notification>\n  <task-id>abc12345</task-id>\n  <status>failed</status>",
          },
        ],
      },
      assistantThinking("后台任务 abc12345 又超时了（等待期限到），需要查状态。"),
    ];
    const stats = aggregateWaitSourceStats([registered("a1", "bash wait.sh")], history);
    expect(stats!.staleNotificationClaims).toBe(0);
  });

  test("反例 3：没起等待的 thinking 提「又超时」→ 不计（不是等待态误读）", () => {
    const history = [assistantThinking("这个接口又超时了，重试一次。")];
    const stats = aggregateWaitSourceStats([registered("a1", "bash wait.sh")], history);
    expect(stats!.staleNotificationClaims).toBe(0);
  });

  test("反例 4：命中措辞但不在 thinking 前 300 字 → 不计（口径是「当轮就断言」）", () => {
    const history = [
      { role: "user", content: [launchReceipt()] },
      assistantThinking("先看日志。" + "长".repeat(320) + "后台任务又被杀了"),
    ];
    const stats = aggregateWaitSourceStats([registered("a1", "bash wait.sh")], history);
    expect(stats!.staleNotificationClaims).toBe(0);
  });
});

describe("R9 并存口径：按对象精确聚合，不是按事件条数", () => {
  test("不同 subject 的两条等待不算并存（并行的无关等待不该被算成重复）", () => {
    const events = [
      registered("a1", "bash wait-779.sh", ["gh:pr:779"]),
      registered("a2", "bash wait-741.sh", ["gh:pr:741"]),
    ];
    expect(aggregateWaitSourceStats(events, [])!.maxConcurrentWaitsPerSubject).toBe(1);
  });

  test("同一 subject 的两条等待算并存 2", () => {
    const events = [
      registered("a1", "bash wait-779.sh", ["gh:pr:779"]),
      registered("a2", "bash wait-779-v2.sh", ["gh:pr:779"]),
    ];
    expect(aggregateWaitSourceStats(events, [])!.maxConcurrentWaitsPerSubject).toBe(2);
  });

  test("WaitReleased 之后不再计入并存", () => {
    const events = [
      registered("a1", "bash wait-779.sh", ["gh:pr:779"]),
      released("a1"),
      registered("a2", "bash wait-779.sh", ["gh:pr:779"]),
    ];
    expect(aggregateWaitSourceStats(events, [])!.maxConcurrentWaitsPerSubject).toBe(1);
  });

  test("老轨迹（无 subjects）回退按 description 归并：同脚本再挂一份算并存", () => {
    const events = [registered("a1", "bash /tmp/wait.sh"), registered("a2", "bash /tmp/wait.sh")];
    expect(aggregateWaitSourceStats(events, [])!.maxConcurrentWaitsPerSubject).toBe(2);
  });
});

describe("R9 准入计数：WaitAdmission 是判定事实，与 WaitRegistered 分开", () => {
  test("duplicate / replace 分别计数，分母 admissions 是全部判定", () => {
    const events = [
      { event: EVENT_ADMISSION, data: { action: "start", kind: "shell" } },
      {
        event: EVENT_ADMISSION,
        data: { action: "duplicate", kind: "shell", existing_ids: ["a1"] },
      },
      {
        event: EVENT_ADMISSION,
        data: { action: "duplicate", kind: "monitor", existing_ids: ["a2"] },
      },
      { event: EVENT_ADMISSION, data: { action: "replace", kind: "wakeup", existing_ids: ["w1"] } },
    ];
    const stats = aggregateWaitSourceStats(events, [])!;
    expect(stats.admissions).toBe(4);
    expect(stats.waitDuplicatesBlocked).toBe(2);
    expect(stats.waitReplacements).toBe(1);
    // 判成 duplicate 的那两次没有登记 —— 这正是「只看 WaitRegistered 会数成 0」的缺口
    expect(stats.registered).toBe(0);
  });
});

describe("R9 三态：算不出来 ≠ 0", () => {
  test("没有 history → staleNotificationClaims 是 undefined（不是 0）", () => {
    const stats = aggregateWaitSourceStats([registered("a1", "bash wait.sh")], undefined)!;
    expect(stats.staleNotificationClaims).toBeUndefined();
  });

  test("两类事件全无 → 整节为 null（老会话 / 该版本没接线）", () => {
    expect(aggregateWaitSourceStats([], [])).toBeNull();
  });
});

describe("R9 修法 3 补齐：monitor 启动的等待同样是「等待启动」", () => {
  const monitorRegistered = {
    event: EVENT_REGISTERED,
    timestamp: "2026-11-12T10:00:00.000Z",
    data: {
      id: "mabcd1234",
      kind: "monitor",
      promise_kind: "exit_or_quiescent",
      description: "monitor wait-pr-780.sh",
      subjects: ["gh:pr:780"],
    },
  };

  test("monitor 启动后当轮声称「又被杀」→ 计入（此前漏在判据外）", () => {
    const history = [
      { role: "user", content: [monitorLaunchReceipt()] },
      assistantThinking("监控 mabcd1234 又被杀了，还没拿到结果，再查一次状态。"),
    ];
    const stats = aggregateWaitSourceStats([monitorRegistered], history)!;
    expect(stats.staleNotificationClaims).toBe(1);
  });

  test("monitor 启动后正常等通知 → 不计（判据仍然只认误读措辞）", () => {
    const history = [
      { role: "user", content: [monitorLaunchReceipt()] },
      assistantThinking("监控已启动，先结束本轮，等通知。"),
    ];
    expect(aggregateWaitSourceStats([monitorRegistered], history)!.staleNotificationClaims).toBe(0);
  });
});

describe("R9 验收 2：R2 生效后的轨迹形态（合成轨迹，非真实采样）", () => {
  test("同一对象 4 次调用 = 1 次 start + 3 次 duplicate → 并存峰值 1、误读 0", () => {
    // 为什么是合成数据：验收 2 要求「修复后新轨迹上并存 ≤ 1」，但它需要真实出现
    // 「同一对象连挂多次」的场景。该场景本身是被 R2 消灭的坏行为 —— 修复生效后
    // 日常使用可能永远不再产生，等真实采样等于等一个不该再发生的事件。
    // 所以这里按 R2 的**确定性判定**构造期望轨迹（第 1 次 start 登记、后 3 次 duplicate
    // 不登记），期望值来自判定规则，不是从 digest 实现反推。
    // 修复前的真实轨迹（b0aa0f1e，4 条同对象并存）见上方验收 1，两组对照即验收 2 的判据。
    const events = [
      registered("a1", "bash wait-779.sh", ["gh:pr:779"]),
      { event: EVENT_ADMISSION, data: { action: "start", kind: "shell" } },
      {
        event: EVENT_ADMISSION,
        data: { action: "duplicate", kind: "shell", existing_ids: ["a1"] },
      },
      {
        event: EVENT_ADMISSION,
        data: { action: "duplicate", kind: "shell", existing_ids: ["a1"] },
      },
      {
        event: EVENT_ADMISSION,
        data: { action: "duplicate", kind: "shell", existing_ids: ["a1"] },
      },
    ];
    const history = [
      { role: "user", content: [launchReceipt()] },
      assistantThinking("等待 #779 的 CI，已结束本轮。"),
      { role: "user", content: [duplicateWaitReceipt()] },
      assistantThinking("同一个对象已在等，本轮不重复启动。"),
      { role: "user", content: [duplicateWaitReceipt()] },
      assistantThinking("确认已有等待，继续等通知。"),
      { role: "user", content: [duplicateWaitReceipt()] },
      assistantThinking("不再重挂，等通知。"),
    ];
    const stats = aggregateWaitSourceStats(events, history)!;
    // 验收 2 的主判据：并存峰值 ≤ 1（修复前真实轨迹是 4）
    expect(stats.maxConcurrentWaitsPerSubject).toBe(1);
    // duplicate 回执不是「启动回执」，不能被误算成一次新的等待启动
    expect(stats.registered).toBe(1);
    expect(stats.admissions).toBe(4);
    expect(stats.waitDuplicatesBlocked).toBe(3);
    expect(stats.staleNotificationClaims).toBe(0);
  });
});
