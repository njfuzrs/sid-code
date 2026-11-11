#!/usr/bin/env bun
/**
 * wait-audit —— 等待态的轨迹回放判据（方案 20261108 §9.5 / §十四第 2、3 条）
 *
 * ## 它回答什么
 *
 * 「一次会话的等待窗口里，模型在前台查了多少次外部状态、烧了多少请求与 token、
 * 有没有被闸门强推、有没有僵尸唤醒、有没有被误报的承诺违背」——纯读
 * `~/.sid-code/trajectories/sessions/<id>/` 下的 events.jsonl / session.traj /
 * raw.jsonl，一行 LLM 调用都没有。
 *
 * 为什么需要它：等待态四个 PR（#674/#677/#683/#684）的正确性，单测绿不够 ——
 * 那测的是「我实现的逻辑对不对」，不是「真实轨迹里的浪费与误报真的没了」。
 * 这个脚本给出可对账的数字，修复前后各跑一次就能比较。方案 §2.3 的基线数字
 * 是本脚本的第一道验收关：**脚本必须复现它，复现不了先修脚本口径**。
 *
 * ## 窗口（本脚本的「分母」）
 *
 * 北极星铁律 3：分母比分子重要。本脚本把分母写死成**等待窗口**：
 *
 * 1. **新会话**（有 `WaitRegistered`）：窗口 = 首个 `WaitRegistered` 到同批等待源
 *    的最后一个 `WaitReleased`。这是真实事件，没有启发式。
 * 2. **老会话**（改动前、无 `WaitRegistered`）：回退到方案 §9.5 的口径 ——
 *    起点 = 首个 `schedule_wakeup` 的**那一次请求**（取它之前最近一条
 *    `BilledRequest` 的时间戳：模型是在那一轮里决定排唤醒的，那一轮的 token 属于窗口）；
 *    终点 = 首个 `ScheduledInject`（唤醒触发）之前的最后一次「等待期活动」
 *    （命中状态查询命令表的 bash）。若该活动之后 `LEGACY_CLOSE_GRACE_MS` 内
 *    有 `EndTurnShape`，取它 —— 模型查完就收尾的那一轮仍算等待期；
 *    若模型改去做别的事（两条基线里是改文档）再收尾，窗口就止于最后一次查询。
 *
 *    ⚠️ `LEGACY_CLOSE_GRACE_MS = 120s` 是**从两条基线会话标定出来的**，不是普适常量：
 *    7dd98bf5 最后查询 04:04:53 → 收尾 04:08:02（间隔 189s，中间在改文档，不算收尾）；
 *    9e3a681d 最后查询 03:58:03 → 收尾 03:58:43（间隔 40s，中间只有 todo_write）。
 *    120s 落在两者之间。这是老会话的**回退启发式**，新会话不用它；
 *    要精确复现历史基线可用 `--window-start/--window-end` 显式覆盖。
 * 3. **显式窗口**：`--window-start <ISO> --window-end <ISO>` 覆盖上面两套推断，
 *    用于复现人工标注的历史窗口（如方案 §2.3 的 7dd98bf5 窗口止于 PR 合入时刻）。
 *
 * ## 字段口径（每个都指到源字段 —— 北极星铁律 2）
 *
 * | 字段 | 定义 | 取数源 |
 * | --- | --- | --- |
 * | `wait_windows` | 窗口数 | events.jsonl（WaitRegistered / schedule_wakeup） |
 * | `fg_status_polls` | 窗口内**命中 §5.5.2 命令表**的前台 bash 次数 | traj 的 `tool_input.command` |
 * | `fg_status_polls_any` | 窗口内**宽口径**（含 `gh (pr\|run\|api)` / `glab` / `kubectl` / `curl`）的**前台** bash 次数。不随匹配实现变化，用来比修复前后 | 同上 |
 * | `gh_queries` | 窗口内**命令含 `gh `** 的 bash 次数（§2.3 基线口径） | 同上 |
 * | `polls_per_min` | `gh_queries / 窗口分钟数` | 同上 |
 * | `unwaited_status_polls` | 会话内**不在任何等待窗口里**的宽口径前台 bash 次数（N8 的分母：无窗口会话算全部，有窗口会话算窗口外） | 同上 |
 * | `unwaited_longest_run` | `unwaited_status_polls` 里最长连续段的次数（相邻间隔 < 60s 同段）；`_start` / `_end` 给出该段起止 | 同上 |
 * | `unwaited_longest_run_requests` | 最长连续段内的 `BilledRequest` 条数 | events.jsonl |
 * | `probe_spin_requests` | 会话内**工具调用全是只读探查**的请求数（只读探查口径复用生产函数，随 N5 一起变）。`null` = 没读 raw | raw.jsonl 的 `response.content` |
 * | `window_requests` | 窗口内 `BilledRequest` 条数（含辅助调用） | events.jsonl |
 * | `window_input_tokens` | 窗口内 `BilledRequest.input_tokens` 之和 | events.jsonl |
 * | `zombie_wakeups` | `ScheduledInject{outcome:injected}` 晚于其前最后一次 `EndTurnShape` 的次数 | events.jsonl |
 * | `gate_retry_while_waiting` | 窗口内 `LoopTransition{type:todo_gate_retry}` 次数 | events.jsonl |
 * | `exit8_errors` | 窗口内 `gh pr checks` 退出码 8 且 `is_error=true` 的次数 | traj 的 observation |
 * | `monitor_events` | 窗口内 monitor 投递的事件数。**D5 起主口径读 events.jsonl**（`MonitorEvent` 条数，按 task_id 归属窗口内注册的 monitor，只卡起点不卡终点，与 raw 口径同规则） | events.jsonl；`--with-raw` 时另跑 raw 解析做交叉校验（`monitor_events_raw`），两者不一致打印 ⚠ 警告 |
 * | `promise_violations` | `WaitReleased{late:true}` 次数（方案 §9.8「非 0 即 bug」） | events.jsonl |
 * | `late_while_terminal` | 判定违约时任务**已处终态**的次数（D4 的直接观测量，§5.4 选口径 ②） | `TaskLifecycle{phase:completed}` × `WaitReleased{late:true}` 按 id 关联 |
 *
 * ### 为什么 `fg_status_polls` 与 `gh_queries` 是两个字段
 *
 * §9.5 的字段定义是「命中 §5.5.2 命令表的前台 bash 次数」，而 §2.3 的基线数字
 * （96 / 106）取数源写的是「`tool_name=bash` 且命令含 `gh `」。两者不等价：
 * `matchStatusQuery` 要求整条命令**是**一次状态查询，而这两条会话里的命令常写成
 * `gh pr view … && echo … && gh pr checks … 2>&1 | tail -10`，命令表认不出（实测
 * 7dd98bf5 只有 56 条命中、9e3a681d 95 条）。两个都输出，**验收 §2.3 看 `gh_queries`**，
 * 评估 P1 拦截的真实覆盖看 `fg_status_polls`，不要把两个数字混着用。
 *
 * ### 为什么再加一个宽口径 `fg_status_polls_any`
 *
 * `fg_status_polls` 直接调 `matchStatusQuery`，**匹配面一扩，数字就整体变大**（N3 修完
 * fbb02831 从 0 变成 13+）。拿它比修复前后，结论一定是「修完轮询变多了」——这是
 * 北极星铁律 3 说的「分母口径一变曲线就整体平移」。`fg_status_polls_any` 只认命令族
 * （`gh (pr|run|api)` / `glab` / `kubectl` / `curl`），不含任何匹配逻辑，是**稳定的分母**。
 * 两个都输出：比修复前后看 `_any`，评估拦截覆盖看 `fg_status_polls`。
 *
 * ### 为什么 `unwaited_*` 要绕开 `active` 短路
 *
 * 老实现里「没有窗口 → 所有前台查询记 0」。但 N8 的分子恰恰是「**什么都没挂**就前台
 * 轮询」——用 `active` 短路会把这一整类会话系统性记成 0，指标看起来永远干净。
 * 所以 `unwaited_*` 对无窗口会话统计**全部**宽口径前台查询，对有窗口会话统计**窗口外**
 * 的部分（962011a6 的第二段 68 次连查就在窗口外）。相应地 `--all` 不再只列有窗口的会话，
 * 否则最该被看见的那一类根本不会出现。
 *
 * ## 用法
 *
 *   bun scripts/wait-audit.ts <session-dir|session-id>
 *   bun scripts/wait-audit.ts --all            # 扫本机全部会话，列有等待窗口**或**有未等待期前台查询的
 *   bun scripts/wait-audit.ts <id> --json      # 机器可读
 *   bun scripts/wait-audit.ts <id> --window-start 2026-11-08T03:51:30.887Z \
 *                                --window-end   2026-11-08T04:04:53.267Z
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { matchStatusQuery } from "@sid-code/core/task/status-query-commands.ts";
import { MONITOR_EVENT_NAME } from "@sid-code/core/task/monitor-task.ts";
import {
  isReadFamilyTool,
  isReadonlyProbeCommand,
} from "@sid-code/core/query/repeated-readonly-guard.ts";

/** 老会话窗口终点的收尾宽限（见文件头「窗口」第 2 条，从两条基线会话标定） */
const LEGACY_CLOSE_GRACE_MS = 120_000;

/**
 * 宽口径状态查询：只认命令族，不认任何匹配逻辑。
 *
 * 为什么不用 `matchStatusQuery`：那个函数是**拦截判据**，它的匹配面会随修复变大
 * （N3 修完 fbb02831 从 0 变成 13+），拿它当分母比修复前后，结论必然是「修完轮询变多」。
 * 这个正则不含实现细节，修复前后可比（北极星铁律 3）。
 */
const STATUS_QUERY_ANY_RE = /\b(?:gh\s+(?:pr|run|api)\b|glab\b|kubectl\b|curl\b)/;

/** 「连续空转段」的相邻间隔阈值：两条查询间隔 ≥ 它就算另起一段（文档 N8 的口径） */
const UNWAITED_RUN_GAP_MS = 60_000;

type Ev = { event?: string; timestamp?: string; data?: Record<string, unknown> };

type TrajRow = {
  message_type?: string;
  timestamp?: string;
  tool_name?: string;
  /**
   * 真实轨迹里是完整工具入参：`run_in_background`（后台调用）、`wait_until_seconds`
   * （声明等待）都在（2026-11-10 用 962011a6 实测）。夹具按需裁剪。
   */
  tool_input?: { command?: string; run_in_background?: boolean };
  tool_use_id?: string;
  is_error?: boolean;
  /** 只有 observation 带；夹具的裁剪版只保留「退出码 N」，原始数据是完整正文 */
  content?: string;
};

/** 窗口的判定来源，输出里带上，读数字的人才知道分母是怎么来的 */
export type WindowBasis = "wait-registry" | "legacy-wakeup" | "explicit" | "none";

export interface WaitAudit {
  session: string;
  wait_windows: number;
  fg_status_polls: number;
  /**
   * 窗口内**宽口径**前台状态查询：命令含 `gh (pr|run|api)` / `glab` / `kubectl` / `curl`
   * 的前台 bash 次数。不随 `matchStatusQuery` 的实现变化，用来比修复前后（见文件头）。
   */
  fg_status_polls_any: number;
  gh_queries: number;
  polls_per_min: number;
  window_requests: number;
  window_input_tokens: number;
  zombie_wakeups: number;
  gate_retry_while_waiting: number;
  exit8_errors: number;
  /**
   * 会话内**不在任何等待窗口里**的宽口径前台查询次数（N8 的分母）。
   * 无窗口会话统计全部，有窗口会话统计窗口外的部分 —— 不能用 `active` 短路（见文件头）。
   */
  unwaited_status_polls: number;
  /** `unwaited_status_polls` 里最长连续段的调用次数（相邻间隔 < 60s 同段） */
  unwaited_longest_run: number;
  /** 最长连续段的起止（ISO，便于人工复核是哪一段空转）；无段时为 null */
  unwaited_longest_run_start: string | null;
  unwaited_longest_run_end: string | null;
  /** 最长连续段内的 `BilledRequest` 条数（按请求计的浪费，与调用次数分开看） */
  unwaited_longest_run_requests: number;
  /**
   * 会话内**工具调用全是只读探查**的请求数。只读探查口径复用生产函数
   * `isReadonlyProbeCommand`，因此会随 N5（rev-parse 纳入白名单）一起变 ——
   * 拿它比 N5 前后会看到口径平移，稳定分母用 `unwaited_status_polls`。
   * `null` = 没读 raw（`--with-raw` 才算）。
   */
  probe_spin_requests: number | null;
  /**
   * 窗口内 monitor 投递的事件数（D5 起主口径）：events.jsonl 里 `MonitorEvent` 条数。
   * 老版本轨迹（D5 合入前）没有该事件，恒为 0 —— 交叉校验会给出 ⚠，以 raw 口径为准。
   */
  monitor_events: number;
  /**
   * raw.jsonl 解析口径的 monitor 事件数（交叉校验用）。`null` = 没读 raw。
   * 与主口径不一致时输出 ⚠（老轨迹 / 埋点丢事件两种成因，靠它分辨）。
   */
  monitor_events_raw: number | null;
  promise_violations: number;
  late_while_terminal: number;
  /** 窗口起止（ISO）。`none` 时为 null —— 输出里保留，便于人工复核分母 */
  window_start: string | null;
  window_end: string | null;
  window_basis: WindowBasis;
}

/** 一次审计的上下文：三类轨迹文件都是可选的，缺哪个就跳过依赖它的字段 */
export interface AuditInput {
  session: string;
  events?: Ev[];
  traj?: TrajRow[];
  raw?: string;
  windowStart?: string;
  windowEnd?: string;
}

/** 取窗口内满足条件的事件（events.jsonl 是追加写的，按行序即时间序） */
function inWindow(ts: string | undefined, start: string, end: string): boolean {
  return typeof ts === "string" && ts >= start && ts <= end;
}

/**
 * 从 `schedule_wakeup` 的 action 时刻回溯「产生它的那次请求」。
 *
 * 为什么要回溯：模型在某一轮 LLM 请求里决定排唤醒，那一轮的 `BilledRequest`
 * 时间戳比工具 action 早 10–20ms。若窗口起点直接用 action 时刻，这一轮的
 * 请求数与 token 就被漏掉了 —— 实测 7dd98bf5 会少 1 条请求 / 214,934 token，
 * 9e3a681d 少 1 条 / 259,546 token，正好是方案 §2.3 与实测的差额。
 */
function backfillRequestStart(events: Ev[], wakeupTs: string): string {
  let start = wakeupTs;
  for (const e of events) {
    if (e.event !== "BilledRequest") continue;
    if (typeof e.timestamp !== "string") continue;
    if (e.timestamp <= wakeupTs) start = e.timestamp;
  }
  return start;
}

/** 老会话窗口：首个 schedule_wakeup → 首个 ScheduledInject 之前的最后等待活动（+收尾宽限） */
function inferLegacyWindow(events: Ev[], traj: TrajRow[]): { start: string; end: string } | null {
  const wakeup = traj.find(
    (x) => x.message_type === "action" && x.tool_name === "schedule_wakeup" && x.timestamp,
  );
  if (!wakeup?.timestamp) return null;
  const start = backfillRequestStart(events, wakeup.timestamp);

  // 唤醒触发之前的活动才算等待期：注入之后模型是在处理唤醒，不是原窗口的延续
  const firstInject = events.find(
    (e) => e.event === "ScheduledInject" && typeof e.timestamp === "string",
  );
  const hardStop = firstInject?.timestamp ?? "9999-12-31T23:59:59.999Z";

  // 最后一次「等待期活动」= 窗口内命中状态查询命令表的 bash
  let lastActivity: string | null = null;
  for (const x of traj) {
    if (x.message_type !== "action" || x.tool_name !== "bash") continue;
    const ts = x.timestamp;
    if (!ts || ts < start || ts >= hardStop) continue;
    const cmd = x.tool_input?.command ?? "";
    if (matchStatusQuery(cmd)) lastActivity = ts;
  }

  // 没有可识别的等待活动 → 这不是一个等待窗口。
  // 方案 §9.8 把分母写死成「窗口内存在至少一次外部状态查询或 monitor」的窗口，
  // 不含纯本地后台任务的等待：一辆从没查过外部状态的会话不该进平均值，
  // 否则「排了唤醒但一直在干别的」会把每窗口查询数拉低，看起来像改善。
  if (!lastActivity) return null;

  // 查完就收尾的那一轮仍算等待期；超过宽限说明模型已经转去做别的事
  const closeTurn = events.find(
    (e) =>
      e.event === "EndTurnShape" &&
      typeof e.timestamp === "string" &&
      e.timestamp >= lastActivity! &&
      e.timestamp < hardStop &&
      Date.parse(e.timestamp) - Date.parse(lastActivity!) <= LEGACY_CLOSE_GRACE_MS,
  );
  return { start, end: closeTurn?.timestamp ?? lastActivity };
}

/**
 * 新会话窗口：首个 WaitRegistered → 该批等待源的最后一个 WaitReleased；
 * 窗口内有 monitor 时，终点再延到**这些 monitor 自己**的最后一次 `delivered`。
 *
 * 为什么要延（D3）：monitor 终态时 WaitReleased **立即**发出，但收尾那一批事件通知
 * 要等**下一轮**才投递给模型（实测 20261109-223949-b177b927：WaitReleased 14:40:01.468，
 * delivered 14:40:04.447，tick-5 落盘 14:40:04.449）。卡在 WaitReleased 会把收尾事件
 * （含 `ALL_DONE` 这类结论行）结构性地排除在窗口外。
 *
 * ⚠️ 必须按 task_id 关联：不带 id 取「最后一个 local_monitor delivered」会把窗口外
 * 别的 monitor 的投递时刻拉进来。只认窗口内注册的 monitor（返回的 monitorIds）。
 */
function inferRegistryWindow(
  events: Ev[],
): { start: string; end: string; monitorIds: Set<string> } | null {
  const reg = events.find((e) => e.event === "WaitRegistered" && typeof e.timestamp === "string");
  if (!reg?.timestamp) return null;
  let released = reg.timestamp;
  for (const e of events) {
    if (e.event !== "WaitReleased" || typeof e.timestamp !== "string") continue;
    if (e.timestamp >= reg.timestamp && e.timestamp > released) released = e.timestamp;
  }
  const monitorIds = new Set<string>();
  for (const e of events) {
    if (e.event !== "WaitRegistered" || e.data?.kind !== "monitor") continue;
    if (!inWindow(e.timestamp, reg.timestamp, released)) continue;
    if (typeof e.data?.id === "string") monitorIds.add(e.data.id);
  }
  let end = released;
  for (const e of events) {
    if (e.event !== "TaskLifecycle" || typeof e.timestamp !== "string") continue;
    if (e.data?.phase !== "delivered" || e.data?.task_type !== "local_monitor") continue;
    if (typeof e.data?.task_id !== "string" || !monitorIds.has(e.data.task_id)) continue;
    if (e.timestamp > end) end = e.timestamp;
  }
  return { start: reg.timestamp, end, monitorIds };
}

/** 按 tool_use_id 把 action 与 observation 配对（traj 里两者是相邻条目，不保证顺序） */
function pairObservations(traj: TrajRow[]): Map<string, TrajRow> {
  const out = new Map<string, TrajRow>();
  for (const x of traj) {
    if (x.message_type !== "observation" || !x.tool_use_id) continue;
    out.set(x.tool_use_id, x);
  }
  return out;
}

/**
 * 从一组时间戳里找最长连续段：相邻两条间隔 < `UNWAITED_RUN_GAP_MS` 视为同一段。
 *
 * 为什么不直接用「查询次数」：一次会话里散落 60 次查询（每次间隔 5 分钟）和
 * 连查 60 次（间隔 8 秒）是完全不同的空转形态，前者多半是正常节奏。这个函数把
 * 「连续」这一维度单独量出来，N8 的验收口径就是它。
 */
function longestUnwaitedRun(tsList: string[]): {
  count: number;
  start: string | null;
  end: string | null;
} {
  if (tsList.length === 0) return { count: 0, start: null, end: null };
  const sorted = [...tsList].sort();
  let bestCount = 1;
  let bestStart = sorted[0]!;
  let bestEnd = sorted[0]!;
  let curCount = 1;
  let curStart = sorted[0]!;
  let prev = Date.parse(sorted[0]!);
  for (let i = 1; i < sorted.length; i++) {
    const ts = sorted[i]!;
    const t = Date.parse(ts);
    // NaN（时间戳解析失败）走 else：宁可另起一段，也不要把坏数据并进连续段
    if (t - prev < UNWAITED_RUN_GAP_MS) {
      curCount++;
    } else {
      curCount = 1;
      curStart = ts;
    }
    prev = t;
    if (curCount > bestCount) {
      bestCount = curCount;
      bestStart = curStart;
      bestEnd = ts;
    }
  }
  return { count: bestCount, start: bestStart, end: bestEnd };
}

/** 一段时间内的 `BilledRequest` 条数（最长连续段的「按请求计的浪费」） */
function countBilledRequests(events: Ev[], start: string, end: string): number {
  let n = 0;
  for (const e of events) {
    if (e.event !== "BilledRequest" || !inWindow(e.timestamp, start, end)) continue;
    n++;
  }
  return n;
}

/** raw.jsonl 里一次请求的最小形态：只要 `response.content` 里的 tool_use 块 */
type RawRequestRow = {
  response?: {
    content?: Array<{ type?: string; name?: string; input?: { command?: string } }>;
  };
};

/**
 * 会话内「工具调用**全是**只读探查」的请求数（`probe_spin_requests`）。
 *
 * 为什么按请求数而不是调用数：模型的浪费是按请求计的 —— 每一轮都要重发整段上下文，
 * 一次只读探查调用就是一个请求的全部产出。N5 的证据里「这类请求占输入 token 的 48.9%」
 * 也是按请求归类的。
 *
 * ⚠️ 口径复用生产函数 `isReadonlyProbeCommand` + `isReadFamilyTool`，**不要在这里
 * 复制一份白名单**：N5 把 `git rev-parse` 纳入白名单后，这个指标会自动跟着覆盖它。
 * 代价是它跨 N5 前后不可比 —— 稳定分母用 `unwaited_status_polls`（北极星铁律 3）。
 *
 * `think` 这类工具**不算**只读探查（它不探查任何外部状态），所以「git status + think」
 * 的请求不计入。这是刻意的保守口径：先观察，不和 N5 的证据口径混着用。
 */
function countProbeSpinRequests(raw: string): number {
  let n = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let row: RawRequestRow;
    try {
      row = JSON.parse(t) as RawRequestRow;
    } catch {
      continue; // raw.jsonl 可能因进程被杀留下半行
    }
    const content = row.response?.content;
    if (!Array.isArray(content)) continue;
    const tools = content.filter((b) => b && b.type === "tool_use");
    if (tools.length === 0) continue;
    const allReadonlyProbe = tools.every(
      (b) =>
        isReadFamilyTool(b.name ?? "") ||
        (b.name === "bash" &&
          typeof b.input?.command === "string" &&
          isReadonlyProbeCommand(b.input.command)),
    );
    if (allReadonlyProbe) n++;
  }
  return n;
}

// 真实渲染带 untrusted 属性（packages/core/src/task/notification.ts：`<event untrusted="true">`）。
// D2：原先写死 `b.includes("<event>")`，与真实格式不符，monitor_events 在所有真实轨迹上恒为 0
// 而手写夹具（无属性形式）全绿。两种形式都认，属性内容不限。
const EVENT_OPEN_RE = /<event(?:\s[^>]*)?>/;
const EVENT_BODY_RE = /<event(?:\s[^>]*)?>([\s\S]*?)<\/event>/;

/**
 * 窗口内 monitor 投递的事件数（D5 主口径）：events.jsonl 里 `MonitorEvent` 的条数。
 *
 * 归属规则与 raw 口径一致：`monitorIds` 非空时（wait-registry 窗口）按 task_id 归属
 * 窗口内注册的 monitor，**只卡起点不卡终点**（收尾那一批的落盘晚于 delivered，
 * 卡终点会漏最后一条，D3）；monitorIds 为空（老会话回退 / 显式窗口）时按时间窗卡。
 *
 * 老版本轨迹（D5 合入前）没有 MonitorEvent 事件，返回 0——交叉校验（`--with-raw`）
 * 会把它与 raw 口径对出来，分辨「老轨迹」与「埋点丢事件」。
 */
function countMonitorEventsFromEvents(
  events: Ev[],
  start: string,
  end: string,
  monitorIds: Set<string> = new Set(),
): number {
  let n = 0;
  for (const e of events) {
    if (e.event !== MONITOR_EVENT_NAME || typeof e.timestamp !== "string") continue;
    if (e.timestamp < start) continue;
    const id = e.data?.task_id;
    if (typeof id !== "string") continue;
    if (monitorIds.size > 0) {
      if (monitorIds.has(id)) n++;
    } else if (inWindow(e.timestamp, start, end)) {
      n++;
    }
  }
  return n;
}

/**
 * 窗口内 monitor 事件通知数：`<task-notification>` 且含 `<event …>`，按 task_id + 事件正文去重。
 *
 * D5 起降级为**交叉校验口径**（主口径读 events.jsonl 的 MonitorEvent，见
 * countMonitorEventsFromEvents）：文本解析会漂（D2 的 `monitor_ev` 恒为 0 就是这么来的），
 * 保留它是为了在 raw 与 events 两个口径间对账。
 *
 * `monitorIds` 非空时（wait-registry 窗口），属于这些 monitor 的通知**只卡起点不卡终点**：
 * 收尾那一批的 raw 落盘晚于 `delivered` 事件本身（实测晚 2ms，raw 是「带着通知发出的
 * 下一轮请求」的快照），按时刻卡终点仍会漏掉最后一条（D3）。task_id 本身就把归属限定
 * 在这几个 monitor 的生命周期内；之后的请求重放历史里的同一条通知，由去重兜住。
 */
function countMonitorEvents(
  raw: string,
  start: string,
  end: string,
  monitorIds: Set<string> = new Set(),
): number {
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ts: string | undefined;
    try {
      ts = (JSON.parse(t) as { timestamp?: string }).timestamp;
    } catch {
      continue;
    }
    if (typeof ts !== "string" || ts < start) continue;
    const blocks = t.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? [];
    for (const b of blocks) {
      if (!EVENT_OPEN_RE.test(b)) continue;
      const id = /<task-id>([^<]*)<\/task-id>/.exec(b)?.[1] ?? "";
      if (!monitorIds.has(id) && !inWindow(ts, start, end)) continue;
      const event = EVENT_BODY_RE.exec(b)?.[1] ?? b;
      seen.add(`${id}\u0000${event}`);
    }
  }
  return seen.size;
}

/** 从轨迹数据算出审计结果（纯函数，供脚本与单测共用） */
export function auditEvents(input: AuditInput): WaitAudit {
  const events = input.events ?? [];
  const traj = input.traj ?? [];

  // ── 窗口：显式 > WaitRegistry > 老会话回退 ──
  let window: { start: string; end: string } | null = null;
  let monitorIds = new Set<string>();
  let basis: WindowBasis = "none";
  if (input.windowStart && input.windowEnd) {
    window = { start: input.windowStart, end: input.windowEnd };
    basis = "explicit";
  } else if (events.length > 0 && events.some((e) => e.event === "WaitRegistered")) {
    const reg = inferRegistryWindow(events);
    window = reg;
    if (reg) monitorIds = reg.monitorIds;
    basis = "wait-registry";
  } else {
    window = inferLegacyWindow(events, traj);
    basis = window ? "legacy-wakeup" : "none";
  }

  const start = window?.start ?? "";
  const end = window?.end ?? "";
  const active = window !== null && start <= end;

  // ── 前台状态查询：三个口径都算（见文件头「为什么是三个字段」） ──
  //
  // ⚠️ 旧字段 `fg_status_polls`（命中命令表）与 `gh_queries`（含 `gh `）**保持原口径
  // 不排除后台调用**：它们是两条基线会话的历史对账数字（96 / 106），口径一动
  // tests/scripts/wait-audit.test.ts 的夹具回归就整体平移。只想给新字段一个
  // 「前台」语义，就在新字段上做。
  let fgPolls = 0;
  let fgPollsAny = 0;
  let ghQueries = 0;
  const unwaitedTs: string[] = [];
  for (const x of traj) {
    if (x.message_type !== "action" || x.tool_name !== "bash") continue;
    const cmd = x.tool_input?.command ?? "";
    const background = x.tool_input?.run_in_background === true;
    if (active && inWindow(x.timestamp, start, end)) {
      if (matchStatusQuery(cmd)) fgPolls++;
      if (cmd.includes("gh ")) ghQueries++;
      if (!background && STATUS_QUERY_ANY_RE.test(cmd)) fgPollsAny++;
    } else if (!background && typeof x.timestamp === "string") {
      // ⚠️ 故意不套 `active`：无窗口会话（basis=none）是 N8 分子的主体，
      // 用 `active` 短路会把它们整体记 0 —— 那正是修 N7 之前的老行为。
      if (STATUS_QUERY_ANY_RE.test(cmd)) unwaitedTs.push(x.timestamp);
    }
  }
  const unwaitedRun = longestUnwaitedRun(unwaitedTs);
  const minutes = active ? (Date.parse(end) - Date.parse(start)) / 60_000 : 0;
  const pollsPerMin = minutes > 0 ? Math.round((ghQueries / minutes) * 100) / 100 : 0;

  // ── 请求与 token：含辅助调用（§2.3 的取数源就是全部 BilledRequest） ──
  let requests = 0;
  let inputTokens = 0;
  if (active) {
    for (const e of events) {
      if (e.event !== "BilledRequest" || !inWindow(e.timestamp, start, end)) continue;
      requests++;
      const n = e.data?.input_tokens;
      if (typeof n === "number" && Number.isFinite(n)) inputTokens += n;
    }
  }

  // ── 僵尸唤醒：注入晚于它之前最后一次收尾（模型已 end_turn 才被叫醒） ──
  //
  // ⚠️ 不按窗口过滤：僵尸唤醒的典型形态就是「窗口已结束（PR 合入 / 模型收尾）之后
  // 才被唤醒注入」，按窗口一过滤恰好把要统计的那个漏掉。方案 §9.8 把它定义为
  // 全会话总数（目标 0），与 promise_violations 同一口径。
  let zombieWakeups = 0;
  for (const e of events) {
    if (e.event !== "ScheduledInject" || e.data?.outcome !== "injected") continue;
    if (typeof e.timestamp !== "string") continue;
    let lastEndTurn: string | null = null;
    for (const t of events) {
      if (t.event !== "EndTurnShape" || typeof t.timestamp !== "string") continue;
      if (t.timestamp <= e.timestamp && (!lastEndTurn || t.timestamp > lastEndTurn)) {
        lastEndTurn = t.timestamp;
      }
    }
    if (lastEndTurn) zombieWakeups++;
  }

  // ── 闸门强推：窗口内的 todo_gate_retry ──
  let gateRetry = 0;
  if (active) {
    for (const e of events) {
      if (e.event !== "LoopTransition" || e.data?.type !== "todo_gate_retry") continue;
      if (inWindow(e.timestamp, start, end)) gateRetry++;
    }
  }

  // ── 退出码 8：窗口内 bash 失败且错误信息是「退出码 8」 ──
  let exit8 = 0;
  if (active) {
    const obs = pairObservations(traj);
    for (const x of traj) {
      if (x.message_type !== "action" || x.tool_name !== "bash") continue;
      if (!inWindow(x.timestamp, start, end)) continue;
      const o = x.tool_use_id ? obs.get(x.tool_use_id) : undefined;
      if (!o?.is_error) continue;
      // traj 只在 observation 里带 content；夹具的裁剪版保留了「退出码 N」，原始数据更全
      if (String(o.content ?? "").includes("退出码 8")) exit8++;
    }
  }

  // ── 违约与「违约时任务已终态」：D4 的直接观测量（§5.4 选口径 ②） ──
  const completedAt = new Map<string, string>();
  for (const e of events) {
    if (e.event !== "TaskLifecycle" || e.data?.phase !== "completed") continue;
    const id = e.data?.task_id;
    if (typeof id === "string" && typeof e.timestamp === "string") completedAt.set(id, e.timestamp);
  }
  let promiseViolations = 0;
  let lateWhileTerminal = 0;
  for (const e of events) {
    if (e.event !== "WaitReleased" || e.data?.late !== true) continue;
    promiseViolations++;
    const id = e.data?.id;
    const done = typeof id === "string" ? completedAt.get(id) : undefined;
    if (done && typeof e.timestamp === "string" && done < e.timestamp) lateWhileTerminal++;
  }

  return {
    session: input.session,
    wait_windows: active ? 1 : 0,
    fg_status_polls: fgPolls,
    fg_status_polls_any: fgPollsAny,
    gh_queries: ghQueries,
    polls_per_min: pollsPerMin,
    window_requests: requests,
    window_input_tokens: inputTokens,
    zombie_wakeups: zombieWakeups,
    gate_retry_while_waiting: gateRetry,
    exit8_errors: exit8,
    unwaited_status_polls: unwaitedTs.length,
    unwaited_longest_run: unwaitedRun.count,
    unwaited_longest_run_start: unwaitedRun.start,
    unwaited_longest_run_end: unwaitedRun.end,
    unwaited_longest_run_requests:
      unwaitedRun.start && unwaitedRun.end
        ? countBilledRequests(events, unwaitedRun.start, unwaitedRun.end)
        : 0,
    probe_spin_requests: input.raw === undefined ? null : countProbeSpinRequests(input.raw),
    monitor_events: active ? countMonitorEventsFromEvents(events, start, end, monitorIds) : 0,
    monitor_events_raw:
      input.raw === undefined
        ? null
        : active
          ? countMonitorEvents(input.raw, start, end, monitorIds)
          : 0,
    promise_violations: promiseViolations,
    late_while_terminal: lateWhileTerminal,
    window_start: window?.start ?? null,
    window_end: window?.end ?? null,
    window_basis: basis,
  } satisfies WaitAudit;
}

function readEvents(file: string): Ev[] {
  const out: Ev[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Ev);
    } catch {
      // events.jsonl 可能因进程被杀留下半行：跳过，不让一行坏数据废掉整份审计
    }
  }
  return out;
}

function readTraj(file: string): TrajRow[] {
  if (!existsSync(file)) return [];
  const d = JSON.parse(readFileSync(file, "utf8")) as { trajectory?: TrajRow[] };
  return d.trajectory ?? [];
}

function sessionsRoot(): string {
  return process.env.SID_CONFIG_DIR
    ? join(process.env.SID_CONFIG_DIR, "trajectories", "sessions")
    : join(homedir(), ".sid-code", "trajectories", "sessions");
}

interface AuditOptions {
  windowStart?: string;
  windowEnd?: string;
  /** 读 raw.jsonl 才能数 monitor_events；--all 时它体积大，默认不读 */
  withRaw: boolean;
}

/**
 * `--all` 的收录判据（导出供单测钉住）：
 *  - 有等待窗口 → 进等待窗口的平均值；
 *  - 没有窗口但有未等待期的前台查询 → 进 N8 的分母；
 *  - 两者都没有（纯本地后台任务、没查过外部状态）→ 不进结果，否则会把平均值拉低。
 *
 * 第二类是修 N7 之前的盲区：老实现只按 `wait_windows > 0` 过滤，
 * 「什么都没挂就前台轮询」的会话一条都不会出现在 `--all` 里。
 */
export function includedInAll(a: WaitAudit): boolean {
  return a.wait_windows > 0 || a.unwaited_status_polls > 0;
}

function auditOne(dir: string, opts: AuditOptions): WaitAudit | null {
  const eventsFile = join(dir, "events.jsonl");
  if (!existsSync(eventsFile)) return null;
  const events = readEvents(eventsFile);
  const traj = readTraj(join(dir, "session.traj"));
  const rawFile = join(dir, "raw.jsonl");
  const raw = opts.withRaw && existsSync(rawFile) ? readFileSync(rawFile, "utf8") : undefined;
  const audit = auditEvents({
    session: dir.split("/").pop() ?? dir,
    events,
    traj,
    raw,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
  });
  // 收录判据见 includedInAll 的注释：不能用 `wait_windows > 0` 一刀切
  return includedInAll(audit) ? audit : null;
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const all = args.includes("--all");
  const withRaw = args.includes("--with-raw");
  const flagValue = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const windowStart = flagValue("--window-start");
  const windowEnd = flagValue("--window-end");
  const target = args.find((a) => !a.startsWith("--") && a !== windowStart && a !== windowEnd);

  const root = sessionsRoot();
  const opts: AuditOptions = { windowStart, windowEnd, withRaw };
  let results: WaitAudit[] = [];

  if (all) {
    if (!existsSync(root)) {
      process.stderr.write(`没有轨迹目录: ${root}\n`);
      process.exit(1);
    }
    for (const name of readdirSync(root)) {
      const a = auditOne(join(root, name), opts);
      if (a) results.push(a);
    }
  } else if (target) {
    const dir = target.includes("/") ? target : join(root, target);
    const a = auditOne(dir, opts);
    if (!a) {
      process.stderr.write(`会话 ${target} 没有等待窗口（或轨迹不存在）\n`);
      process.exit(1);
    }
    results = [a];
  } else {
    process.stderr.write(
      "用法: bun scripts/wait-audit.ts <session-dir|session-id> [--json] [--with-raw]\n" +
        "      bun scripts/wait-audit.ts --all [--json] [--with-raw]\n" +
        "      bun scripts/wait-audit.ts <id> --window-start <ISO> --window-end <ISO>\n",
    );
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    return;
  }

  const sum = (k: keyof WaitAudit) =>
    results.reduce((n, r) => n + ((r[k] as number | null) ?? 0), 0);
  // D5 起 monitor_ev 读 events.jsonl（永远有值，不再依赖 --with-raw）；raw 口径只在
  // --with-raw 时显示做交叉校验，两者不一致加 ⚠：老轨迹（D5 前无 MonitorEvent 事件）
  // 与埋点丢事件两种成因靠它分辨
  const fmtRaw = (r: WaitAudit) =>
    r.monitor_events_raw === null ? "" : ` raw=${r.monitor_events_raw}`;
  const mismatch = (r: WaitAudit) =>
    r.monitor_events_raw !== null && r.monitor_events_raw !== r.monitor_events ? " ⚠" : "";
  // probe_spin 要读 raw（体积大），没读就整段不打印，避免把 null 打成 0
  const fmtProbeSpin = (r: WaitAudit) =>
    r.probe_spin_requests === null ? "" : ` probe_spin=${r.probe_spin_requests}`;
  for (const r of results) {
    console.log(
      `${r.session}: windows=${r.wait_windows} basis=${r.window_basis} ` +
        `[${r.window_start ?? "-"} → ${r.window_end ?? "-"}] ` +
        `fg_polls=${r.fg_status_polls} fg_any=${r.fg_status_polls_any} ` +
        `gh=${r.gh_queries} polls/min=${r.polls_per_min} ` +
        `req=${r.window_requests} tok=${r.window_input_tokens} ` +
        `zombie=${r.zombie_wakeups} gate_retry=${r.gate_retry_while_waiting} ` +
        `exit8=${r.exit8_errors} monitor_ev=${r.monitor_events}${fmtRaw(r)}${mismatch(r)} ` +
        `violations=${r.promise_violations}(late_terminal=${r.late_while_terminal}) ` +
        `unwaited=${r.unwaited_status_polls} ` +
        `longest_run=${r.unwaited_longest_run}(req=${r.unwaited_longest_run_requests})` +
        fmtProbeSpin(r),
    );
  }
  if (results.length > 1) {
    const rawTotal = results.some((r) => r.monitor_events_raw !== null)
      ? String(sum("monitor_events_raw"))
      : "n/a";
    // 两个分母分开报：等待窗口平均值只来自有窗口的会话，unwaited_* 还含「什么都没挂」的会话
    const withWindows = results.filter((r) => r.wait_windows > 0).length;
    console.log(
      `合计 ${results.length} 个会话（有等待窗口 ${withWindows}）: ` +
        `fg_polls=${sum("fg_status_polls")} fg_any=${sum("fg_status_polls_any")} ` +
        `gh=${sum("gh_queries")} ` +
        `req=${sum("window_requests")} tok=${sum("window_input_tokens")} ` +
        `zombie=${sum("zombie_wakeups")} gate_retry=${sum("gate_retry_while_waiting")} ` +
        `exit8=${sum("exit8_errors")} monitor_ev=${sum("monitor_events")} raw=${rawTotal} ` +
        `violations=${sum("promise_violations")}(late_terminal=${sum("late_while_terminal")}) ` +
        `unwaited=${sum("unwaited_status_polls")} longest_run=${sum("unwaited_longest_run")}`,
    );
  }
}

if (import.meta.main) main();
