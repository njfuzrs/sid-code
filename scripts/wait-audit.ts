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
 * | `gh_queries` | 窗口内**命令含 `gh `** 的 bash 次数（§2.3 基线口径） | 同上 |
 * | `polls_per_min` | `gh_queries / 窗口分钟数` | 同上 |
 * | `window_requests` | 窗口内 `BilledRequest` 条数（含辅助调用） | events.jsonl |
 * | `window_input_tokens` | 窗口内 `BilledRequest.input_tokens` 之和 | events.jsonl |
 * | `zombie_wakeups` | `ScheduledInject{outcome:injected}` 晚于其前最后一次 `EndTurnShape` 的次数 | events.jsonl |
 * | `gate_retry_while_waiting` | 窗口内 `LoopTransition{type:todo_gate_retry}` 次数 | events.jsonl |
 * | `exit8_errors` | 窗口内 `gh pr checks` 退出码 8 且 `is_error=true` 的次数 | traj 的 observation |
 * | `monitor_events` | 窗口内 monitor 事件通知数（含 `<event>` 的 `<task-notification>`，按 task_id+事件去重） | raw.jsonl |
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
 * ## 用法
 *
 *   bun scripts/wait-audit.ts <session-dir|session-id>
 *   bun scripts/wait-audit.ts --all            # 扫本机全部会话，只列有等待窗口的
 *   bun scripts/wait-audit.ts <id> --json      # 机器可读
 *   bun scripts/wait-audit.ts <id> --window-start 2026-11-08T03:51:30.887Z \
 *                                --window-end   2026-11-08T04:04:53.267Z
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { matchStatusQuery } from "@sid-code/core/task/status-query-commands.ts";

/** 老会话窗口终点的收尾宽限（见文件头「窗口」第 2 条，从两条基线会话标定） */
const LEGACY_CLOSE_GRACE_MS = 120_000;

type Ev = { event?: string; timestamp?: string; data?: Record<string, unknown> };

type TrajRow = {
  message_type?: string;
  timestamp?: string;
  tool_name?: string;
  tool_input?: { command?: string };
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
  gh_queries: number;
  polls_per_min: number;
  window_requests: number;
  window_input_tokens: number;
  zombie_wakeups: number;
  gate_retry_while_waiting: number;
  exit8_errors: number;
  monitor_events: number;
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

/** 新会话窗口：首个 WaitRegistered → 该批等待源的最后一个 WaitReleased */
function inferRegistryWindow(events: Ev[]): { start: string; end: string } | null {
  const reg = events.find((e) => e.event === "WaitRegistered" && typeof e.timestamp === "string");
  if (!reg?.timestamp) return null;
  let end = reg.timestamp;
  for (const e of events) {
    if (e.event !== "WaitReleased" || typeof e.timestamp !== "string") continue;
    if (e.timestamp >= reg.timestamp && e.timestamp > end) end = e.timestamp;
  }
  return { start: reg.timestamp, end };
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

/** 窗口内 monitor 事件通知数：`<task-notification>` 且含 `<event>`，按 task_id + 事件正文去重 */
function countMonitorEvents(raw: string, start: string, end: string): number {
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
    if (typeof ts !== "string" || !inWindow(ts, start, end)) continue;
    const blocks = t.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? [];
    for (const b of blocks) {
      if (!b.includes("<event>")) continue;
      const id = /<task-id>([^<]*)<\/task-id>/.exec(b)?.[1] ?? "";
      const event = /<event>([\s\S]*?)<\/event>/.exec(b)?.[1] ?? b;
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
  let basis: WindowBasis = "none";
  if (input.windowStart && input.windowEnd) {
    window = { start: input.windowStart, end: input.windowEnd };
    basis = "explicit";
  } else if (events.length > 0 && events.some((e) => e.event === "WaitRegistered")) {
    window = inferRegistryWindow(events);
    basis = "wait-registry";
  } else {
    window = inferLegacyWindow(events, traj);
    basis = window ? "legacy-wakeup" : "none";
  }

  const start = window?.start ?? "";
  const end = window?.end ?? "";
  const active = window !== null && start <= end;

  // ── 前台状态查询：两个口径都算（见文件头「为什么是两个字段」） ──
  let fgPolls = 0;
  let ghQueries = 0;
  if (active) {
    for (const x of traj) {
      if (x.message_type !== "action" || x.tool_name !== "bash") continue;
      if (!inWindow(x.timestamp, start, end)) continue;
      const cmd = x.tool_input?.command ?? "";
      if (matchStatusQuery(cmd)) fgPolls++;
      if (cmd.includes("gh ")) ghQueries++;
    }
  }
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
    gh_queries: ghQueries,
    polls_per_min: pollsPerMin,
    window_requests: requests,
    window_input_tokens: inputTokens,
    zombie_wakeups: zombieWakeups,
    gate_retry_while_waiting: gateRetry,
    exit8_errors: exit8,
    monitor_events: input.raw && active ? countMonitorEvents(input.raw, start, end) : 0,
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
  // 分母：只统计真的存在等待窗口的会话——没有窗口的会话不该进平均值
  return audit.wait_windows > 0 ? audit : null;
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

  const sum = (k: keyof WaitAudit) => results.reduce((n, r) => n + (r[k] as number), 0);
  for (const r of results) {
    console.log(
      `${r.session}: windows=${r.wait_windows} basis=${r.window_basis} ` +
        `[${r.window_start ?? "-"} → ${r.window_end ?? "-"}] ` +
        `fg_polls=${r.fg_status_polls} gh=${r.gh_queries} polls/min=${r.polls_per_min} ` +
        `req=${r.window_requests} tok=${r.window_input_tokens} ` +
        `zombie=${r.zombie_wakeups} gate_retry=${r.gate_retry_while_waiting} ` +
        `exit8=${r.exit8_errors} monitor_ev=${r.monitor_events} ` +
        `violations=${r.promise_violations}(late_terminal=${r.late_while_terminal})`,
    );
  }
  if (results.length > 1) {
    console.log(
      `合计 ${results.length} 个会话: fg_polls=${sum("fg_status_polls")} gh=${sum("gh_queries")} ` +
        `req=${sum("window_requests")} tok=${sum("window_input_tokens")} ` +
        `zombie=${sum("zombie_wakeups")} gate_retry=${sum("gate_retry_while_waiting")} ` +
        `exit8=${sum("exit8_errors")} monitor_ev=${sum("monitor_events")} ` +
        `violations=${sum("promise_violations")}(late_terminal=${sum("late_while_terminal")})`,
    );
  }
}

if (import.meta.main) main();
