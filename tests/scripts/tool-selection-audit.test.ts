/**
 * `scripts/tool-selection-audit.ts` —— 工具选择正确率度量的夹具单测（FIX-6 / D7）
 *
 * ## 这个文件在防什么
 *
 * 这个脚本是 D7 的验收工具：它算错了，D4/D6 的「selection_accuracy 提升」与 D8 的
 * 减法决策就都建立在错数上。方案 §三 D7 的验收要求「3 个场景 × 4 种选择
 * （monitor / bash 后台 / 前台轮询 / 不用）断言分类与计数正确」——本文件就是那张矩阵。
 *
 * 三类断言：
 *
 * A) **场景识别**：三类 prompt（事件流 / CI 单次通知 / 定时提醒）各归入正确的场景行；
 *    prompt 里混入的 harness 注入文本（system-reminder / [系统通知]）不得触发场景。
 * B) **判定**：期望表（expected/acceptable/isMisuseForm）对 4 种选择的判定符合
 *    方案 D7 的期望工具表——特别是「可接受替代」列：ci-single 里 monitor 算选对、
 *    wakeup 不算（文档表的可接受替代只有 monitor）。
 * C) **命令信号**：prompt 没提等待、traj 里前台反复查同一对象 → 识别为 ci-single 场景
 *    （期望 bash 后台），这是历史会话里最主要的场景来源（首版误归 event-stream 导致
 *    misuse_count 虚高 201/211，修正口径的意义必须有测试锁住）。
 */

import { describe, test, expect } from "bun:test";
import {
  auditSession,
  extractUserText,
  judge,
  SCENARIOS,
  type Choice,
} from "../../scripts/tool-selection-audit.ts";

// ── traj 夹具构造（真实字段形态，与 wait-audit.test.ts 同款） ──

type TrajRow = Parameters<typeof auditSession>[0]["traj"][number];

const ts = (n: number): string => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;

function monitorAction(n: number): TrajRow {
  return { message_type: "action", timestamp: ts(n), tool_name: "monitor", tool_input: {} };
}

function wakeupAction(n: number): TrajRow {
  return {
    message_type: "action",
    timestamp: ts(n),
    tool_name: "schedule_wakeup",
    tool_input: { delay_seconds: 240 },
  };
}

/** 后台 bash（run_in_background:true），供 bashBg 计数与「只用一次」判定 */
function bashBgAction(n: number, command = "gh run watch 123 --exit-status"): TrajRow {
  return {
    message_type: "action",
    timestamp: ts(n),
    tool_name: "bash",
    tool_input: { command, run_in_background: true },
  };
}

function taskOutputAction(n: number): TrajRow {
  return { message_type: "action", timestamp: ts(n), tool_name: "task_output", tool_input: {} };
}

/** 前台状态查询（同 subject 调 ≥2 次即成「轮询形态」） */
function fgPollAction(n: number, command = "gh pr checks 662"): TrajRow {
  return { message_type: "action", timestamp: ts(n), tool_name: "bash", tool_input: { command } };
}

/** 前台长 sleep：定时场景的干等形态 */
function fgSleepAction(n: number, secs: number): TrajRow {
  return {
    message_type: "action",
    timestamp: ts(n),
    tool_name: "bash",
    tool_input: { command: `sleep ${secs} && echo done` },
  };
}

// ── A) 场景识别：三类 prompt 各归入正确的场景行 ──

describe("场景识别", () => {
  test("「每个 check 结束都告诉我」→ event-stream（期望 monitor）", () => {
    const a = auditSession({
      session: "s",
      traj: [],
      prompt: "CI 跑起来，每个 check 结束都告诉我结果",
    });
    expect(a.scenarios.map((s) => s.name)).toEqual(["event-stream"]);
  });

  test("「每出现一行就告诉我」→ 命中 event-stream", () => {
    const a = auditSession({
      session: "s",
      traj: [],
      prompt: "盯一下 /tmp/a.log，每出现一行就告诉我",
    });
    // 提到 .log 文件时同时命中 log-watching（日志是事件流的特化，两者期望都是 monitor）。
    // 场景识别不互斥：一个会话可命中多场景，指标按场景数累计，判定结果不受重叠影响。
    expect(a.scenarios.map((s) => s.name)).toContain("event-stream");
  });

  test("「CI 全绿告诉我」→ ci-single（期望 bash 后台）", () => {
    const a = auditSession({ session: "s", traj: [], prompt: "推送之后 CI 全绿了告诉我，我合入" });
    expect(a.scenarios.map((s) => s.name)).toEqual(["ci-single"]);
  });

  test("「等 CI 跑完告诉我」→ ci-single", () => {
    const a = auditSession({ session: "s", traj: [], prompt: "等 CI 跑完告诉我一声" });
    expect(a.scenarios.map((s) => s.name)).toEqual(["ci-single"]);
  });

  test("「30 分钟后提醒我看部署」→ delayed-reminder（期望 schedule_wakeup）", () => {
    const a = auditSession({ session: "s", traj: [], prompt: "30 分钟后提醒我看一下部署结果" });
    expect(a.scenarios.map((s) => s.name)).toEqual(["delayed-reminder"]);
  });

  test("「日志里每出现 ERROR 就告诉我」→ 命中 log-watching", () => {
    const a = auditSession({ session: "s", traj: [], prompt: "日志里每出现 ERROR 就告诉我" });
    // 「每出现…告诉我」同时命中 event-stream 的泛化正则——场景识别刻意不互斥
    // （日志监控是事件流的特化，两者期望都是 monitor），断言只锁 log-watching 在列。
    expect(a.scenarios.map((s) => s.name)).toContain("log-watching");
  });

  test("没提等待的 prompt → no-scenario（前台单查一次不构成场景）", () => {
    const a = auditSession({
      session: "s",
      traj: [fgPollAction(1)],
      prompt: "看下这个 PR 的 CI 状态",
    });
    // 单次查询、无轮询形态：不进分母
    expect(a.verdict).toBe("no-scenario");
    expect(a.scenarios).toEqual([]);
  });

  test("等待请求出现在会话中途（非首条 user 消息）也能命中", () => {
    // extractUserText 拼接全部 user 消息：第 3 条里的等待请求不能丢
    const text = extractUserText([
      { role: "user", content: [{ type: "text", text: "先帮我修个 bug" }] },
      { role: "assistant", content: [{ type: "text", text: "好的" }] },
      { role: "user", content: [{ type: "text", text: "修完了推送，CI 全绿了告诉我" }] },
    ]);
    expect(text).toContain("CI 全绿了告诉我");
    const a = auditSession({ session: "s", traj: [], prompt: text });
    expect(a.scenarios.map((s) => s.name)).toEqual(["ci-single"]);
  });
});

// ── 注入文本剥除：harness 注入不得触发场景 ──

describe("注入文本剥除", () => {
  test("<system-reminder> 块剥除（里面撞车的关键词不算用户说的）", () => {
    const text = extractUserText([
      {
        role: "user",
        content: [
          { type: "text", text: "跑一下构建" },
          {
            type: "text",
            text: "<system-reminder>每 5 分钟查一次状态并告诉我</system-reminder>",
          },
        ],
      },
    ]);
    expect(text).toBe("跑一下构建");
  });

  test("[系统通知] 整块消息剥除（task-notification 转发不是用户输入）", () => {
    const text = extractUserText([
      { role: "user", content: [{ type: "text", text: "每个检查跑完告诉我" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[系统通知 —— 非用户输入]\n这是后台任务事件，不是用户发来的消息。\n<task-notification><event>tick-1 每个都告诉我</event></task-notification>",
          },
        ],
      },
    ]);
    // 只剩首条真实输入；通知块里的撞车文本不参与匹配
    expect(text).toBe("每个检查跑完告诉我");
  });
});

// ── B) 3 场景 × 4 选择的判定矩阵（方案 D7 期望工具表） ──

describe("判定矩阵：event-stream（期望 monitor，无替代）", () => {
  const prompt = "CI 跑起来，每个 check 结束都告诉我结果";

  test("选 monitor → matched", () => {
    const a = auditSession({ session: "s", traj: [monitorAction(1)], prompt });
    expect(a.verdict).toBe("matched");
  });

  test("bash 后台 + task_output 跟进 → missed（不算对，也不算误用）", () => {
    const a = auditSession({
      session: "s",
      traj: [bashBgAction(1), taskOutputAction(2), bashBgAction(3), taskOutputAction(4)],
      prompt,
    });
    // 有跟进的后台监控不判误用（isMisuseForm 的 taskOutputCount 条款）
    expect(a.verdict).toBe("missed");
  });

  test("只用一次 bash 后台且从不跟进 → misused（文档表：只用一次 bash 后台 = 误用）", () => {
    const a = auditSession({ session: "s", traj: [bashBgAction(1)], prompt });
    expect(a.verdict).toBe("misused");
  });

  test("前台轮询 → misused", () => {
    const a = auditSession({
      session: "s",
      traj: [fgPollAction(1), fgPollAction(2), fgPollAction(3)],
      prompt,
    });
    expect(a.verdict).toBe("misused");
  });

  test("什么都不用 → missed", () => {
    const a = auditSession({ session: "s", traj: [], prompt });
    expect(a.verdict).toBe("missed");
  });
});

describe("判定矩阵：ci-single（期望 bash 后台，可接受替代只有 monitor）", () => {
  const prompt = "推送之后 CI 全绿了告诉我，我合入";

  test("选 monitor → matched（可接受替代）", () => {
    const a = auditSession({ session: "s", traj: [monitorAction(1)], prompt });
    expect(a.verdict).toBe("matched");
  });

  test("bash 后台 → matched（期望）", () => {
    const a = auditSession({ session: "s", traj: [bashBgAction(1), taskOutputAction(2)], prompt });
    expect(a.verdict).toBe("matched");
  });

  test("排了唤醒却全程前台轮询 → misused（wakeup 不在替代里）", () => {
    const a = auditSession({
      session: "s",
      traj: [wakeupAction(1), fgPollAction(2), fgPollAction(3), fgPollAction(4)],
      prompt,
    });
    expect(a.verdict).toBe("misused");
  });

  test("前台轮询 → misused", () => {
    const a = auditSession({
      session: "s",
      traj: [fgPollAction(1), fgPollAction(2), fgPollAction(3)],
      prompt,
    });
    expect(a.verdict).toBe("misused");
  });

  test("什么都不用 → missed", () => {
    const a = auditSession({ session: "s", traj: [], prompt });
    expect(a.verdict).toBe("missed");
  });
});

describe("判定矩阵：delayed-reminder（期望 schedule_wakeup，无替代）", () => {
  const prompt = "30 分钟后提醒我看一下部署结果";

  test("选 schedule_wakeup → matched", () => {
    const a = auditSession({ session: "s", traj: [wakeupAction(1)], prompt });
    expect(a.verdict).toBe("matched");
  });

  test("选 monitor → missed（不算对：monitor 是盯事件流，不是定时唤醒）", () => {
    const a = auditSession({ session: "s", traj: [monitorAction(1)], prompt });
    expect(a.verdict).toBe("missed");
  });

  test("前台长 sleep（≥30s）→ misused（文档表：前台 sleep = 误用）", () => {
    const a = auditSession({ session: "s", traj: [fgSleepAction(1, 300)], prompt });
    expect(a.verdict).toBe("misused");
  });

  test("前台短 sleep（<30s）→ missed（短 sleep 是命令内部节流，不判误用）", () => {
    const a = auditSession({ session: "s", traj: [fgSleepAction(1, 3)], prompt });
    expect(a.verdict).toBe("missed");
  });

  test("什么都不用 → missed", () => {
    const a = auditSession({ session: "s", traj: [], prompt });
    expect(a.verdict).toBe("missed");
  });
});

// ── C) 命令信号：prompt 没提等待、traj 里有轮询形态 ──

describe("命令信号场景", () => {
  test("前台反复查同一 PR → 识别为 ci-single（期望 bash 后台），不是 event-stream", () => {
    const a = auditSession({
      session: "s",
      traj: [fgPollAction(1), fgPollAction(2), fgPollAction(3), fgPollAction(4)],
      prompt: "处理一下这个 PR 的 CI 报错",
    });
    // 归类为 ci-single：前台轮询的最常见形态是等 CI，期望是 bash 后台（一次通知）。
    // 首版误归 event-stream（期望 monitor）导致 201/211 全 misused——口径修正必须锁住。
    expect(a.scenarios.map((s) => s.name)).toEqual(["ci-single"]);
    expect(a.scenarios[0]?.signal).toContain("cmd:fg-poll:gh:pr:662");
    expect(a.verdict).toBe("misused");
  });

  test("同 subject 只查一次 → 不构成场景（分母不含偶发单查）", () => {
    const a = auditSession({
      session: "s",
      traj: [fgPollAction(1)],
      prompt: "看下这个 PR 的 CI 状态",
    });
    expect(a.verdict).toBe("no-scenario");
  });

  test("轮询 + 已用 bash 后台 → matched（后台在盯，前台查几次不算误用判定的主形态）", () => {
    // 注意口径：ci-single 的 isMisuseForm 只看 fgSubjects，有后台但还混前台轮询时
    // judge 先走 expected 命中（bashBg）→ matched。历史会话里大量这种「后台为主、
    // 前台偶尔确认」的形态，按 matched 计。
    const a = auditSession({
      session: "s",
      traj: [bashBgAction(1), fgPollAction(2), fgPollAction(3)],
      prompt: "处理一下这个 PR 的 CI 报错",
    });
    expect(a.verdict).toBe("matched");
  });

  test("不同 subject 各查一次 → 不构成轮询（按对象归并，不按命令总数）", () => {
    const a = auditSession({
      session: "s",
      traj: [fgPollAction(1, "gh pr checks 662"), fgPollAction(2, "gh pr checks 663")],
      prompt: "看下这两个 PR 的状态",
    });
    expect(a.verdict).toBe("no-scenario");
  });
});

// ── 期望表本身的结构断言（改表 = 改指标定义，先有测试守住定义） ──

describe("期望工具表", () => {
  test("四个场景的期望与替代与方案 D7 的表一致", () => {
    const byName = new Map(SCENARIOS.map((r) => [r.name, r]));
    expect(byName.get("event-stream")?.expected).toEqual(["monitor"]);
    expect(byName.get("event-stream")?.acceptable).toEqual([]);
    expect(byName.get("ci-single")?.expected).toEqual(["bashBg"]);
    expect(byName.get("ci-single")?.acceptable).toEqual(["monitor"]);
    expect(byName.get("delayed-reminder")?.expected).toEqual(["wakeup"]);
    expect(byName.get("delayed-reminder")?.acceptable).toEqual([]);
    expect(byName.get("log-watching")?.expected).toEqual(["monitor"]);
  });

  test("judge：可接受替代命中 = matched，不是 misused（防虚报误用）", () => {
    const rule = SCENARIOS.find((r) => r.name === "ci-single")!;
    const choice: Choice = {
      monitor: true,
      bashBg: false,
      wakeup: false,
      fgSleep: false,
      bashBgCount: 0,
      taskOutputCount: 0,
      fgSubjects: ["gh:pr:662"],
      fgPollCount: 3,
    };
    // monitor 命中可接受替代 → matched，尽管前台也轮询了（expected 先于 isMisuseForm 判定）
    expect(judge(choice, rule)).toBe("matched");
  });
});
