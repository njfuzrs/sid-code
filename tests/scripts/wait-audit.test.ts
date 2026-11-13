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
 * D) **N7 度量盲区**（本文件末尾那一组）：宽口径 `fg_status_polls_any` 不随匹配实现变、
 *    无等待源的轮询必须绕开 `active` 短路被数出来、`probe_spin_requests` 跟着生产白名单走。
 *    这一组的断言刻意写成「按当时实现」的形式（`matchStatusQuery(...) ? 1 : 0`），
 *    因为 N3/N5 合入后生产函数的匹配面会变大 —— 写死 0 会在那天变成假红。
 *
 * ⚠️ 夹具是**裁剪版**：`events.jsonl` 只留审计字段，`session.traj` 只留
 * `message_type/timestamp/tool_name/tool_input.command/is_error/tool_use_id`，
 * observation 的 content 只保留「退出码 N」（判断 exit8 的唯一依据）。原会话的对话正文
 * 不进仓库（数据主权）。裁剪不改变任何被断言字段的取数结果 —— 夹具回归用例就是这条的证明。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditEvents, includedInAll, type AuditInput } from "../../scripts/wait-audit.ts";
import { matchStatusQuery } from "@sid-code/core/task/status-query-commands.ts";
import { isReadonlyProbeCommand } from "@sid-code/core/query/repeated-readonly-guard.ts";

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
        // ⚠️ 这个例子原来是 `gh pr view 662 && echo done`。R4 之后「末尾无害段可跳过」
        // 成了明确契约（`; echo done` / `; date` 是两次事故会话的主力写法），那条命令
        // 已经算命中，守住这条判据要换成真正的写操作。
        bashPoll("2026-01-01T00:00:30.000Z", "gh pr merge 662 --auto"),
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

  test("monitor_events_raw（交叉校验口径）：窗口内、按 task_id + 事件正文去重", () => {
    // 真实 raw.jsonl 每行都是一个 JSON（请求快照），task-notification 嵌在消息正文里。
    // 这里照这个形态造数据：把 XML 塞进 JSON 字符串，而不是让 XML 单独成行。
    const notif = (ts: string, xml: string) =>
      JSON.stringify({
        timestamp: ts,
        request: { new_messages: [{ role: "user", content: xml }] },
      });
    const raw = [
      // 真实渲染带 untrusted 属性（packages/core/src/task/notification.ts）。
      // 原夹具手写成无属性的 <event>，与真实格式漂移，导致线上恒 0 而单测全绿（D2）。
      notif(
        "2026-01-01T00:00:10.000Z",
        '<task-notification><task-id>m1</task-id><event untrusted="true">check1: pass</event></task-notification>',
      ),
      notif(
        "2026-01-01T00:00:20.000Z",
        '<task-notification><task-id>m1</task-id><event untrusted="true">check1: pass</event></task-notification>',
      ),
      notif(
        "2026-01-01T00:00:20.000Z",
        '<task-notification><task-id>m1</task-id><event untrusted="true">check2: fail</event></task-notification>',
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
    expect(a.monitor_events_raw).toBe(2);
  });

  test('D2：<event untrusted="true"> 与无属性 <event> 两种形式都计数', () => {
    const notif = (ts: string, xml: string) =>
      JSON.stringify({
        timestamp: ts,
        request: { new_messages: [{ role: "user", content: xml }] },
      });
    const raw = [
      notif(
        "2026-01-01T00:00:10.000Z",
        '<task-notification><task-id>m1</task-id><event untrusted="true">a</event></task-notification>',
      ),
      notif(
        "2026-01-01T00:00:11.000Z",
        "<task-notification><task-id>m1</task-id><event>b</event></task-notification>",
      ),
      // <events> 不是 <event>：前缀相同的别的标签不能被误认
      notif(
        "2026-01-01T00:00:12.000Z",
        "<task-notification><task-id>m1</task-id><events>c</events></task-notification>",
      ),
    ].join("\n");
    expect(auditEvents({ ...base, raw }).monitor_events_raw).toBe(2);
  });

  test("D2：用真实渲染函数产出的通知必须被计数（防夹具再次与生产格式漂移）", async () => {
    const { formatNotification } = await import("../../packages/core/src/task/notification.ts");
    const xml = formatNotification({
      taskId: "m1",
      outputFile: "/tmp/m1.log",
      status: "running",
      summary: "s",
      event: "tick-1",
    });
    const raw = JSON.stringify({
      timestamp: "2026-01-01T00:00:10.000Z",
      request: { new_messages: [{ role: "user", content: xml }] },
    });
    expect(auditEvents({ ...base, raw }).monitor_events_raw).toBe(1);
  });

  test("没读 raw 时 monitor_events_raw 为 null；主口径 monitor_events 不依赖 raw（D5）", () => {
    expect(auditEvents(base).monitor_events_raw).toBeNull();
    expect(auditEvents({ ...base, raw: "" }).monitor_events_raw).toBe(0);
    // D5：主口径永远有值（老轨迹恒 0，靠 raw 交叉校验分辨）
    expect(auditEvents(base).monitor_events).toBe(0);
  });
});

describe("D3：monitor 收尾事件晚于 WaitReleased 落盘", () => {
  // 形态照抄 20261109-223949-b177b927：WaitReleased 后 3s 才 delivered，
  // 收尾那条 tick-5 的 raw 落盘还要再晚 2ms（它是「带着通知发出的下一轮请求」的快照）。
  const notif = (ts: string, id: string, ev: string) =>
    JSON.stringify({
      timestamp: ts,
      request: {
        new_messages: [
          {
            role: "user",
            content: `<task-notification><task-id>${id}</task-id><event untrusted="true">${ev}</event></task-notification>`,
          },
        ],
      },
    });
  const events: Ev[] = [
    {
      event: "WaitRegistered",
      timestamp: "2026-01-01T00:00:00.000Z",
      data: { id: "m1", kind: "monitor" },
    },
    {
      event: "WaitReleased",
      timestamp: "2026-01-01T00:00:05.000Z",
      data: { id: "m1", kind: "monitor", reason: "terminal" },
    },
    {
      event: "TaskLifecycle",
      timestamp: "2026-01-01T00:00:08.000Z",
      data: { task_id: "m1", task_type: "local_monitor", phase: "delivered" },
    },
    // 窗口外的另一个 monitor：它的投递时刻不能把窗口拉长（必须按 task_id 关联）
    {
      event: "TaskLifecycle",
      timestamp: "2026-01-01T01:00:00.000Z",
      data: { task_id: "other", task_type: "local_monitor", phase: "delivered" },
    },
  ];
  const raw = [
    notif("2026-01-01T00:00:03.000Z", "m1", "tick-1"),
    notif("2026-01-01T00:00:08.002Z", "m1", "tick-5"),
    notif("2026-01-01T01:00:00.002Z", "other", "unrelated"),
  ].join("\n");

  test("窗口终点延到该 monitor 的 delivered，收尾事件计入", () => {
    const a = auditEvents({ session: "s", events, raw });
    expect(a.window_end).toBe("2026-01-01T00:00:08.000Z");
    expect(a.monitor_events_raw).toBe(2);
  });

  test("D5 主口径：MonitorEvent 按 task_id 归属窗口内注册的 monitor，只卡起点不卡终点", () => {
    // 同一份 events 加上 MonitorEvent：tick-1 窗口内、tick-5 在 WaitReleased 之后
    // （delivered 时刻 00:00:08 之后 2ms）——task_id 归属下两条都计
    const withMonitorEvents: Ev[] = [
      ...events,
      {
        event: "MonitorEvent",
        timestamp: "2026-01-01T00:00:03.000Z",
        data: { task_id: "m1", seq: 1, chars: 6, lines: 1, dropped: 0 },
      },
      {
        event: "MonitorEvent",
        timestamp: "2026-01-01T00:00:08.002Z",
        data: { task_id: "m1", seq: 2, chars: 6, lines: 1, dropped: 0 },
      },
      // 窗口外另一个 monitor 的 MonitorEvent 不计（按 task_id 归属）
      {
        event: "MonitorEvent",
        timestamp: "2026-01-01T01:00:00.002Z",
        data: { task_id: "other", seq: 1, chars: 9, lines: 1, dropped: 0 },
      },
    ];
    const a = auditEvents({ session: "s", events: withMonitorEvents, raw });
    expect(a.monitor_events).toBe(2);
  });

  test("D5 主口径：老轨迹（无 MonitorEvent）恒 0，靠 raw 交叉校验分辨", () => {
    const a = auditEvents({ session: "s", events, raw });
    expect(a.monitor_events).toBe(0);
    expect(a.monitor_events_raw).toBe(2);
  });

  test("不相干 monitor 的 delivered 不延伸窗口、其事件不计入", () => {
    const a = auditEvents({ session: "s", events, raw });
    expect(a.window_end).not.toBe("2026-01-01T01:00:00.000Z");
  });

  test("没有 monitor 的窗口（只有 shell 等待源）终点语义不变", () => {
    const a = auditEvents({
      session: "s",
      events: [
        {
          event: "WaitRegistered",
          timestamp: "2026-01-01T00:00:00.000Z",
          data: { id: "b1", kind: "shell" },
        },
        {
          event: "WaitReleased",
          timestamp: "2026-01-01T00:00:05.000Z",
          data: { id: "b1", reason: "terminal" },
        },
        {
          event: "TaskLifecycle",
          timestamp: "2026-01-01T00:00:08.000Z",
          data: { task_id: "b1", task_type: "local_bash", phase: "delivered" },
        },
      ],
    });
    expect(a.window_end).toBe("2026-01-01T00:00:05.000Z");
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

describe("N7：宽口径与未等待统计（度量盲区）", () => {
  /** for 循环形态：N3 修之前 matchStatusQuery 认不出（2026-11-10 实测），修之后自动跟随 */
  const LOOP_CMD =
    'cd /x && for pr in 694 696 697; do echo "=== PR $pr ==="; gh pr view $pr --json statusCheckRollup; done';

  /** 一次 bash 调用（可选后台）；后台标记在真实 traj 的 tool_input 里 */
  function bashAction(ts: string, command: string, background = false): TrajRow {
    return {
      message_type: "action",
      timestamp: ts,
      tool_name: "bash",
      tool_input: background ? { command, run_in_background: true } : { command },
      tool_use_id: `t-${ts}`,
    };
  }

  test("for 循环形态：fg_status_polls_any 计入，fg_status_polls 按当时实现计（不许比实现快）", () => {
    const a = auditEvents({
      session: "s",
      traj: [bashPoll("2026-01-01T00:00:10.000Z", LOOP_CMD)],
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-01T00:01:00.000Z",
    });
    // 宽口径只认命令族：循环、管道、gh api 形态都算 —— 它才是能比修复前后的分母
    expect(a.fg_status_polls_any).toBe(1);
    // 窄口径必须跟着生产函数走：N3 修完它会变 1，这里写死 0 会在那天变成假红
    expect(a.fg_status_polls).toBe(matchStatusQuery(LOOP_CMD) ? 1 : 0);
  });

  test("无等待源的连续查询：绕开 active 短路计入 unwaited_*（N8 的分母）", () => {
    const ts = ["00:02:00", "00:02:08", "00:02:16", "00:02:24", "00:02:32", "00:02:40"];
    const a = auditEvents({
      session: "s",
      events: [billed("2026-01-01T00:02:00.000Z", 100), billed("2026-01-01T00:02:24.000Z", 200)],
      traj: ts.map((t) => bashPoll(`2026-01-01T${t}.000Z`, "gh pr checks 701 2>&1 | head -10")),
    });
    // 这个会话什么都没挂：老实现 active=false → 前台查询全部记 0，N8 的空转在审计里永远看不见
    expect(a.wait_windows).toBe(0);
    expect(a.window_basis).toBe("none");
    expect(a.unwaited_status_polls).toBe(6);
    expect(a.unwaited_longest_run).toBe(6);
    expect(a.unwaited_longest_run_start).toBe("2026-01-01T00:02:00.000Z");
    expect(a.unwaited_longest_run_end).toBe("2026-01-01T00:02:40.000Z");
    // 段内请求数单独算：这 6 次查询落在 2 条 BilledRequest 的时间范围内
    expect(a.unwaited_longest_run_requests).toBe(2);
  });

  test("连续段在间隔 ≥ 60s 处断开（恰好 60s 也算断开）", () => {
    const a = auditEvents({
      session: "s",
      traj: [
        bashPoll("2026-01-01T00:00:00.000Z"),
        bashPoll("2026-01-01T00:00:08.000Z"),
        bashPoll("2026-01-01T00:00:16.000Z"),
        // 距上一条正好 60s：阈值是「< 60s 才同段」，所以这里另起一段
        bashPoll("2026-01-01T00:01:16.000Z"),
        bashPoll("2026-01-01T00:01:24.000Z"),
      ],
    });
    expect(a.unwaited_status_polls).toBe(5);
    expect(a.unwaited_longest_run).toBe(3);
    expect(a.unwaited_longest_run_start).toBe("2026-01-01T00:00:00.000Z");
    expect(a.unwaited_longest_run_end).toBe("2026-01-01T00:00:16.000Z");
  });

  test("有窗口的会话：窗口内算 fg_status_polls_any，窗口外的算 unwaited_*", () => {
    const a = auditEvents({
      session: "s",
      events: [
        {
          event: "WaitRegistered",
          timestamp: "2026-01-01T00:00:00.000Z",
          data: { id: "m1", kind: "monitor" },
        },
        {
          event: "WaitReleased",
          timestamp: "2026-01-01T00:01:00.000Z",
          data: { id: "m1", reason: "terminal" },
        },
      ],
      traj: [
        bashPoll("2026-01-01T00:00:10.000Z", "gh pr checks 701"),
        bashPoll("2026-01-01T00:02:00.000Z", "gh pr view 701 --json state"),
        bashPoll("2026-01-01T00:02:10.000Z", "gh pr view 701 --json state"),
      ],
    });
    expect(a.fg_status_polls_any).toBe(1);
    expect(a.unwaited_status_polls).toBe(2);
    expect(a.unwaited_longest_run).toBe(2);
  });

  test("后台 bash 不计入新字段（「前台」语义）；旧字段口径保持原样", () => {
    const inWindow = auditEvents({
      session: "s",
      traj: [bashAction("2026-01-01T00:00:10.000Z", "gh pr checks 701 --watch", true)],
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-01T00:01:00.000Z",
    });
    expect(inWindow.fg_status_polls_any).toBe(0);
    // 旧字段是两条基线会话的历史对账口径，不参与前后台判定（改了会让 96/106 整体平移）
    expect(inWindow.gh_queries).toBe(1);

    // 无窗口的后台轮询同样不算「未等待期的前台空转」——它正是 harness 想引导的方向
    const noWindow = auditEvents({
      session: "s",
      traj: [bashAction("2026-01-01T00:00:10.000Z", "gh pr checks 701 --watch", true)],
    });
    expect(noWindow.unwaited_status_polls).toBe(0);
    expect(noWindow.unwaited_longest_run).toBe(0);
  });

  test("宽口径覆盖 glab / kubectl / curl 与 gh 三个子命令，不把 gh auth / git 算进来", () => {
    const hits = [
      "glab ci status",
      "kubectl get pods -n prod",
      "curl -s https://ci.example.com/status",
      "gh run view 123",
      "gh api repos/o/r/commits/abc/check-runs",
    ];
    const misses = ["git status --short", "ls -la", "gh auth status", "npm run build"];
    const a = auditEvents({
      session: "s",
      traj: [
        ...hits.map((c, i) => bashPoll(`2026-01-01T00:00:0${i}.000Z`, c)),
        ...misses.map((c, i) => bashPoll(`2026-01-01T00:00:1${i}.000Z`, c)),
      ],
    });
    expect(a.unwaited_status_polls).toBe(hits.length);
    // 5 条命中都在 0–4 秒内，构成一段；misses 不进段（宽口径是「命令族」不是「有状态」）
    expect(a.unwaited_longest_run).toBe(hits.length);
  });

  test("probe_spin_requests：工具调用全是只读探查的请求才计入", () => {
    const req = (blocks: Array<Record<string, unknown>>) =>
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        usage: { input_tokens: 1 },
        response: {
          content: blocks.map((b, i) => ({ type: "tool_use", id: `u${i}`, ...b })),
        },
      });
    const raw = [
      // 单条只读 bash → 计
      req([{ name: "bash", input: { command: "git status --short" } }]),
      // read 家族是纯只读检查 → 计
      req([{ name: "read", input: { file_path: "/a" } }]),
      // 同请求里还有写工具 → 这个请求有产出，不计
      req([
        { name: "bash", input: { command: "git status --short" } },
        { name: "edit", input: { file_path: "/a" } },
      ]),
      // think 不探查任何外部状态，不算只读探查（刻意的保守口径）
      req([{ name: "think", input: {} }]),
      // 纯文本请求（没有工具调用）不是「只读探查请求」
      JSON.stringify({
        timestamp: "2026-01-01T00:00:04.000Z",
        response: { content: [{ type: "text", text: "hi" }] },
      }),
    ].join("\n");
    expect(auditEvents({ session: "s", traj: [], raw }).probe_spin_requests).toBe(2);
  });

  test("probe_spin_requests 的只读探查口径复用生产函数（N5 修完自动覆盖 rev-parse）", () => {
    const REV = "git rev-parse --abbrev-ref HEAD";
    const raw = JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      response: {
        content: [{ type: "tool_use", id: "u1", name: "bash", input: { command: REV } }],
      },
    });
    // 断言写成「与生产白名单一致」而不是写死 0：N5 把 rev-parse 纳入后这里自动变 1，
    // 写死就会在那天变成假红（口径本来就是要跟着生产函数走）
    const expected = isReadonlyProbeCommand(REV) ? 1 : 0;
    expect(auditEvents({ session: "s", traj: [], raw }).probe_spin_requests).toBe(expected);
  });

  test("probe_spin_requests 未读 raw 时为 null（--with-raw 才算）", () => {
    expect(auditEvents({ session: "s", traj: [] }).probe_spin_requests).toBeNull();
  });

  test("--all 收录判据：无窗口但有未等待查询的会话必须被收录（否则 N8 的分子看不见）", () => {
    const spinning = auditEvents({
      session: "s",
      traj: [bashPoll("2026-01-01T00:00:10.000Z")],
    });
    expect(spinning.wait_windows).toBe(0);
    expect(includedInAll(spinning)).toBe(true);

    // 既没窗口、也没查过外部状态：不进结果，否则会把等待窗口的平均值拉低
    const quiet = auditEvents({
      session: "s",
      traj: [bashPoll("2026-01-01T00:00:10.000Z", "git status --short")],
    });
    expect(includedInAll(quiet)).toBe(false);
  });
});
