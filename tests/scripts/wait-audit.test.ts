/**
 * `scripts/wait-audit.ts` —— 等待窗口轨迹回放判据
 *
 * ## 这个文件在防什么
 *
 * 这个脚本是方案 20261108 §9.5 的验收工具：等待态四个 PR 到底有没有把
 * 「前台空转、僵尸唤醒、误报违约」压下去，靠它给出的数字判断。它算错了没人会发现，
 * 只会有人照着结论说「修复无效」或「修复有效」。
 *
 * 三类断言：
 *
 * A) **口径正确性**：窗口起点必须回到「产生首个 schedule_wakeup 的那一轮请求」
 *    （`BilledRequest` 比 action 早 10–20ms，直接用 action 时刻会漏掉这一轮的请求与 token）；
 *    窗口终点必须是「最后一次等待活动 + 宽限内的收尾」，模型改去做别的事再收尾不算。
 * B) **分母**：没有等待窗口的会话必须 `wait_windows = 0`（不进平均值），
 *    这是北极星铁律 3「分母比分子重要」在脚本里的落点。
 * C) **夹具回归**：两条基线会话（7dd98bf5 / 9e3a681d）必须复现方案 §2.3 的数字 ——
 *    这是 L2 的验收第一关，改了脚本口径而这里没红，说明断言写漏了。
 *
 * ⚠️ 夹具是**裁剪版**：`events.jsonl` 只留审计字段，`session.traj` 只留
 * `message_type/timestamp/tool_name/tool_input.command/is_error/tool_use_id`，
 * observation 的 content 只保留「退出码 N」（判断 exit8 的唯一依据）。原会话的对话正文
 * 不进仓库（数据主权）。裁剪不改变任何被断言字段的取数结果 —— 夹具回归用例就是这条的证明。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditEvents, type AuditInput } from "../../scripts/wait-audit.ts";

type Ev = { event?: string; timestamp?: string; data?: Record<string, unknown> };
type TrajRow = NonNullable<AuditInput["traj"]>[number];

const FIXTURES = join(import.meta.dir, "../../packages/core/tests/fixtures/wait-audit");

function readEvents(session: string): Ev[] {
  return readFileSync(join(FIXTURES, session, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Ev);
}

function readTraj(session: string): TrajRow[] {
  const d = JSON.parse(readFileSync(join(FIXTURES, session, "session.traj"), "utf8")) as {
    trajectory?: TrajRow[];
  };
  return d.trajectory ?? [];
}

/** 一次前台状态查询（命中 §5.5.2 命令表） */
function bashPoll(ts: string, command = "gh pr checks 662"): TrajRow {
  return {
    message_type: "action",
    timestamp: ts,
    tool_name: "bash",
    tool_input: { command },
    tool_use_id: `t-${ts}`,
  };
}

/** 该次查询成功的 observation */
function bashOk(ts: string): TrajRow {
  return { message_type: "observation", tool_use_id: `t-${ts}`, is_error: false };
}

/** 该次查询失败（退出码 8） */
function bashExit8(ts: string): TrajRow {
  return {
    message_type: "observation",
    tool_use_id: `t-${ts}`,
    is_error: true,
    content: "退出码 8",
  };
}

function billed(ts: string, inputTokens: number): Ev {
  return { event: "BilledRequest", timestamp: ts, data: { input_tokens: inputTokens } };
}

describe("窗口推断 · 老会话回退（无 WaitRegistered）", () => {
  test("起点回到产生首个 schedule_wakeup 的那一轮请求（BilledRequest 比 action 早）", () => {
    const a = auditEvents({
      session: "s",
      events: [billed("2026-01-01T00:00:00.000Z", 100)],
      traj: [
        {
          message_type: "action",
          timestamp: "2026-01-01T00:00:00.015Z",
          tool_name: "schedule_wakeup",
          tool_input: {},
        },
        bashPoll("2026-01-01T00:00:10.000Z"),
        bashOk("2026-01-01T00:00:10.000Z"),
      ],
    });
    // 起点必须是 BilledRequest 的 00:00:00.000，不是 action 的 00:00:00.015
    expect(a.window_start).toBe("2026-01-01T00:00:00.000Z");
    expect(a.window_basis).toBe("legacy-wakeup");
    expect(a.window_requests).toBe(1); // 那一轮请求没有被漏掉
    expect(a.window_input_tokens).toBe(100);
  });

  test("窗口止于最后一次查询后的收尾（宽限内）；模型改做别的事再收尾则止于查询", () => {
    // 场景 A：查完 40s 就收尾 → 窗口到收尾
    const close = auditEvents({
      session: "s",
      events: [
        { event: "EndTurnShape", timestamp: "2026-01-01T00:01:00.000Z" },
        // 注入发生在窗口之后，用来确认它不会截断窗口
        {
          event: "ScheduledInject",
          timestamp: "2026-01-01T00:10:00.000Z",
          data: { outcome: "injected" },
        },
      ],
      traj: [
        {
          message_type: "action",
          timestamp: "2026-01-01T00:00:00.000Z",
          tool_name: "schedule_wakeup",
        },
        bashPoll("2026-01-01T00:00:20.000Z"),
        bashOk("2026-01-01T00:00:20.000Z"),
      ],
    });
    expect(close.window_end).toBe("2026-01-01T00:01:00.000Z");

    // 场景 B：查完 3 分钟才收尾（中间在改文档）→ 窗口止于查询，不吞进那 3 分钟
    const longGap = auditEvents({
      session: "s",
      events: [{ event: "EndTurnShape", timestamp: "2026-01-01T00:03:20.000Z" }],
      traj: [
        {
          message_type: "action",
          timestamp: "2026-01-01T00:00:00.000Z",
          tool_name: "schedule_wakeup",
        },
        bashPoll("2026-01-01T00:00:20.000Z"),
        bashOk("2026-01-01T00:00:20.000Z"),
      ],
    });
    expect(longGap.window_end).toBe("2026-01-01T00:00:20.000Z");
  });

  test("窗口内没有可识别的状态查询 → wait_windows=0（不进分母）", () => {
    const a = auditEvents({
      session: "s",
      events: [billed("2026-01-01T00:00:00.000Z", 100)],
      traj: [
        {
          message_type: "action",
          timestamp: "2026-01-01T00:00:00.015Z",
          tool_name: "schedule_wakeup",
        },
      ],
    });
    // 没有查询活动时窗口退化成唤醒那一刻，分母为 0，指标全 0
    expect(a.wait_windows).toBe(0);
    expect(a.gh_queries).toBe(0);
    expect(a.window_requests).toBe(0);
  });

  test("完全没有等待登记的会话 → basis=none、全 0", () => {
    const a = auditEvents({
      session: "s",
      events: [billed("2026-01-01T00:00:00.000Z", 100)],
      traj: [bashPoll("2026-01-01T00:00:10.000Z"), bashOk("2026-01-01T00:00:10.000Z")],
    });
    expect(a.wait_windows).toBe(0);
    expect(a.window_basis).toBe("none");
    expect(a.window_start).toBeNull();
  });
});

describe("窗口推断 · 新会话（WaitRegistry 事件）", () => {
  test("窗口 = 首个 WaitRegistered → 最后一个 WaitReleased", () => {
    const a = auditEvents({
      session: "s",
      events: [
        {
          event: "WaitRegistered",
          timestamp: "2026-01-01T00:00:00.000Z",
          data: { id: "m1", kind: "monitor" },
        },
        billed("2026-01-01T00:00:05.000Z", 50),
        {
          event: "WaitReleased",
          timestamp: "2026-01-01T00:00:30.000Z",
          data: { id: "m1", reason: "terminal" },
        },
        {
          event: "WaitReleased",
          timestamp: "2026-01-01T00:00:40.000Z",
          data: { id: "m2", reason: "terminal" },
        },
      ],
      traj: [bashPoll("2026-01-01T00:00:10.000Z"), bashOk("2026-01-01T00:00:10.000Z")],
    });
    expect(a.window_basis).toBe("wait-registry");
    expect(a.window_start).toBe("2026-01-01T00:00:00.000Z");
    expect(a.window_end).toBe("2026-01-01T00:00:40.000Z"); // 最后一个释放
    expect(a.window_requests).toBe(1);
  });

  test("显式窗口优先于两套推断", () => {
    const a = auditEvents({
      session: "s",
      events: [
        {
          event: "WaitRegistered",
          timestamp: "2026-01-01T00:00:00.000Z",
          data: { id: "m1", kind: "monitor" },
        },
        billed("2026-01-01T00:00:05.000Z", 50),
      ],
      traj: [bashPoll("2026-01-01T00:00:10.000Z"), bashOk("2026-01-01T00:00:10.000Z")],
      windowStart: "2026-01-01T00:00:06.000Z",
      windowEnd: "2026-01-01T00:00:20.000Z",
    });
    expect(a.window_basis).toBe("explicit");
    expect(a.window_start).toBe("2026-01-01T00:00:06.000Z");
    expect(a.window_requests).toBe(0); // 00:00:05 那条在显式窗口之外
  });
});

describe("指标口径", () => {
  const base: AuditInput = {
    session: "s",
    events: [billed("2026-01-01T00:00:05.000Z", 100)],
    traj: [
      {
        message_type: "action",
        timestamp: "2026-01-01T00:00:00.000Z",
        tool_name: "schedule_wakeup",
      },
      bashPoll("2026-01-01T00:00:10.000Z", "gh pr checks 662"),
      bashOk("2026-01-01T00:00:10.000Z"),
    ],
    windowStart: "2026-01-01T00:00:00.000Z",
    windowEnd: "2026-01-01T00:01:00.000Z",
  };

  test("fg_status_polls 只数命中命令表的；gh_queries 数命令含 gh 的", () => {
    const a = auditEvents({
      ...base,
      traj: [
        ...(base.traj ?? []),
        // 非状态查询但含 gh：两个口径都不算
        bashPoll("2026-01-01T00:00:20.000Z", "git log --oneline"),
        bashOk("2026-01-01T00:00:20.000Z"),
        // 含 gh 但不是纯只读命令表形态：gh_queries 算，fg_status_polls 不算
        bashPoll("2026-01-01T00:00:30.000Z", "gh pr view 662 && echo done"),
        bashOk("2026-01-01T00:00:30.000Z"),
      ],
    });
    expect(a.fg_status_polls).toBe(1);
    expect(a.gh_queries).toBe(2);
    expect(a.polls_per_min).toBe(2); // 2 次 / 1 分钟
  });

  test("late:true 计入 promise_violations；任务已终态才计入 late_while_terminal", () => {
    const a = auditEvents({
      ...base,
      events: [
        ...(base.events ?? []),
        {
          event: "TaskLifecycle",
          timestamp: "2026-01-01T00:00:20.000Z",
          data: { task_id: "b1", phase: "completed" },
        },
        // b1 在 00:00:20 已 completed，00:00:30 才判违约 → late_while_terminal
        {
          event: "WaitReleased",
          timestamp: "2026-01-01T00:00:30.000Z",
          data: { id: "b1", reason: "expired", late: true },
        },
        // b2 没有终态记录 → 只计 violations
        {
          event: "WaitReleased",
          timestamp: "2026-01-01T00:00:40.000Z",
          data: { id: "b2", reason: "expired", late: true },
        },
        // 正常释放不算违约
        {
          event: "WaitReleased",
          timestamp: "2026-01-01T00:00:50.000Z",
          data: { id: "b3", reason: "terminal" },
        },
      ],
    });
    expect(a.promise_violations).toBe(2);
    expect(a.late_while_terminal).toBe(1);
  });

  test("late 事件在终态之前：只计违约，不计 late_while_terminal（反向边界）", () => {
    const a = auditEvents({
      ...base,
      events: [
        {
          event: "WaitReleased",
          timestamp: "2026-01-01T00:00:10.000Z",
          data: { id: "b1", reason: "expired", late: true },
        },
        {
          event: "TaskLifecycle",
          timestamp: "2026-01-01T00:00:20.000Z",
          data: { task_id: "b1", phase: "completed" },
        },
      ],
    });
    expect(a.promise_violations).toBe(1);
    expect(a.late_while_terminal).toBe(0);
  });

  test("zombie_wakeups：注入晚于其前最后一次收尾才算", () => {
    const a = auditEvents({
      ...base,
      events: [
        { event: "EndTurnShape", timestamp: "2026-01-01T00:00:10.000Z" },
        {
          event: "ScheduledInject",
          timestamp: "2026-01-01T00:00:20.000Z",
          data: { outcome: "injected" },
        },
        // 被丢弃的注入不算
        {
          event: "ScheduledInject",
          timestamp: "2026-01-01T00:00:25.000Z",
          data: { outcome: "dropped_superseded" },
        },
      ],
    });
    expect(a.zombie_wakeups).toBe(1);
  });

  test("gate_retry_while_waiting 只数窗口内的 todo_gate_retry", () => {
    const a = auditEvents({
      ...base,
      events: [
        {
          event: "LoopTransition",
          timestamp: "2026-01-01T00:00:30.000Z",
          data: { type: "todo_gate_retry" },
        },
        {
          event: "LoopTransition",
          timestamp: "2026-01-01T00:05:00.000Z",
          data: { type: "todo_gate_retry" },
        },
        { event: "LoopTransition", timestamp: "2026-01-01T00:00:40.000Z", data: { type: "other" } },
      ],
    });
    expect(a.gate_retry_while_waiting).toBe(1);
  });

  test("exit8_errors：窗口内失败且退出码 8", () => {
    const a = auditEvents({
      ...base,
      traj: [
        ...(base.traj ?? []),
        bashPoll("2026-01-01T00:00:30.000Z"),
        bashExit8("2026-01-01T00:00:30.000Z"),
        // 窗口外的退出码 8 不算
        bashPoll("2026-01-01T00:02:00.000Z"),
        bashExit8("2026-01-01T00:02:00.000Z"),
      ],
    });
    expect(a.exit8_errors).toBe(1);
  });

  test("monitor_events：窗口内、按 task_id + 事件正文去重", () => {
    // 真实 raw.jsonl 每行都是一个 JSON（请求快照），task-notification 嵌在消息正文里。
    // 这里照这个形态造数据：把 XML 塞进 JSON 字符串，而不是让 XML 单独成行。
    const notif = (ts: string, xml: string) =>
      JSON.stringify({
        timestamp: ts,
        request: { new_messages: [{ role: "user", content: xml }] },
      });
    const raw = [
      notif(
        "2026-01-01T00:00:10.000Z",
        "<task-notification><task-id>m1</task-id><event>check1: pass</event></task-notification>",
      ),
      notif(
        "2026-01-01T00:00:20.000Z",
        "<task-notification><task-id>m1</task-id><event>check1: pass</event></task-notification>",
      ),
      notif(
        "2026-01-01T00:00:20.000Z",
        "<task-notification><task-id>m1</task-id><event>check2: fail</event></task-notification>",
      ),
      // 无 <event> 的终态通知不计数
      notif(
        "2026-01-01T00:00:20.000Z",
        "<task-notification><task-id>m1</task-id></task-notification>",
      ),
      // 窗口外的通知不计数
      notif(
        "2026-01-01T00:05:00.000Z",
        "<task-notification><task-id>m1</task-id><event>late</event></task-notification>",
      ),
    ].join("\n");
    const a = auditEvents({ ...base, raw });
    // check1 重复两次只算一次；check2 算一次；无 <event> 的不算；窗口外的 late 不算
    expect(a.monitor_events).toBe(2);
  });
});

describe("夹具回归：两条基线会话必须复现方案 §2.3", () => {
  // 这两个数字是 L2 的验收第一关。任何一处对不上，说明脚本口径漂了。
  test("7dd98bf5：96 次 gh 查询 / 106 请求 / 26,405,804 token / 1 僵尸唤醒 / 1 次闸门强推", () => {
    const a = auditEvents({
      session: "20261108-112620-7dd98bf5",
      events: readEvents("20261108-112620-7dd98bf5"),
      traj: readTraj("20261108-112620-7dd98bf5"),
    });
    expect(a.window_basis).toBe("legacy-wakeup");
    expect(a.wait_windows).toBe(1);
    expect(a.gh_queries).toBe(96);
    expect(a.window_requests).toBe(106);
    expect(a.window_input_tokens).toBe(26_405_804);
    expect(a.zombie_wakeups).toBe(1);
    expect(a.gate_retry_while_waiting).toBe(1);
    // 方案 §2.3 写 45，实测 44（窗口内失败全部是退出码 8；第 45 条候选是 03:51:04 的
    // 退出码 1，在窗口起点之前 26 秒）。脚本按源字段如实输出 44，不迁就文档数字。
    expect(a.exit8_errors).toBe(44);
    expect(a.promise_violations).toBe(0);
  });

  test("9e3a681d：106 次 gh 查询 / 130 请求 / 40,539,922 token / 1 僵尸唤醒 / 0 次闸门强推", () => {
    const a = auditEvents({
      session: "20261108-112039-9e3a681d",
      events: readEvents("20261108-112039-9e3a681d"),
      traj: readTraj("20261108-112039-9e3a681d"),
    });
    expect(a.window_basis).toBe("legacy-wakeup");
    expect(a.gh_queries).toBe(106);
    expect(a.window_requests).toBe(130);
    expect(a.window_input_tokens).toBe(40_539_922);
    expect(a.zombie_wakeups).toBe(1);
    expect(a.gate_retry_while_waiting).toBe(0);
    expect(a.exit8_errors).toBe(0);
  });
});
