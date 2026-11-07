#!/usr/bin/env bun
/**
 * wakeup-audit —— `schedule_wakeup` 的轨迹回放判据（方案 20261107 §5.4）
 *
 * ## 它回答什么
 *
 * 「一次会话里到底排了几次唤醒、醒了几次、其中几次是多余的」——纯读
 * `~/.sid-code/trajectories/sessions/<id>/events.jsonl`，一行 LLM 调用都没有。
 *
 * 为什么需要它：F1（单链替换）+ F2（注入前判过期）修复的正确性，只在单测里绿是不够的
 * ——那测的是「我实现的逻辑对不对」，不是「真实轨迹里的多余唤醒真的没了」。
 * 这个脚本给出可对账的数字，修复前后各跑一次就能比较。
 *
 * ## 判据（两套，都输出）
 *
 * **`stale_literal`（方案 §2.3 的字面判据）**：
 *   一次 fire 是多余的 ⇔ 它与上一次 fire（或会话开始）之间没有发生过 create。
 *   理由：正常单链是 `create → fire → create → fire` 严格交替，连续两次 fire 中间没有
 *   create 说明第二次来自一个早被取代、却没撤销的任务。
 *
 * **`stale`（实际采用的判据）：**
 *   一次 fire 是多余的 ⇔ 它对应的 create 不是「fire 时刻之前最近的那一次 create」。
 *   旧实现里每个 create 都对应一次 fire（各自独立、只触发一次），所以把 create 与 fire
 *   按时间顺序一一配对即可反推「这次 fire 建自第几次 create」。
 *
 *   两者在 20261107-095213-ff96d1f2 上**都得 3**（不是方案 §5.4 写的 4）。差异来源：
 *   方案 §2.1 的表格把 a825f8ab 也手工标成「多余 #1」，而按 §2.3 的判据它 fire 之前
 *   有 4 次 create、按配对口径它也不是「最近一次 create」——等等，后者它确实是 stale。
 *   手工标注的第 4 次多余是 dcd5 — 它是**最后一次** create 建的任务，两套判据都放它
 *   过关（它确实是最新那一个），但从人的角度看目标早在 02:38 就达成了，它仍是一次空跑。
 *
 *   **那个「目标达成时刻」事件里没有可机械判定的字段**，所以不能写进判据（写了就是
 *   靠猜）。因此本脚本采用可机械判定的口径，并在输出里同时给 `max_pending_wakeups`
 *   （=4，与方案 §5.4 一致）作为「积压严重度」的证据。
 *   验收时看的是：修复后 `max_pending_wakeups ≤ 1` 且 `stale = 0`——单链之后只可能剩
 *   「目标达成后最后一个 create」那一次，它按判据本就不算 stale，单独看 max_pending 即可。
 *
 * ⚠️ `stale` 的前提是「create 与 fire 一一对应」。若有 `cron_delete` 手动撤销，
 * 配对会错位、结论偏保守（少报），用 `wakeup_deleted` 可以看出来有没有这种情况。
 *
 * ## 用法
 *
 *   bun scripts/wakeup-audit.ts <session-dir|session-id>
 *   bun scripts/wakeup-audit.ts --all          # 扫本机全部会话，只列有 schedule_wakeup 的
 *   bun scripts/wakeup-audit.ts <id> --json    # 机器可读
 *
 * 分母写死：**以会话为单位**，只统计至少有 1 次 `schedule_wakeup` create 的会话。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WakeupAudit {
  session: string;
  /** `PostToolUse(tool_name=schedule_wakeup, is_error=false)` 条数 */
  wakeup_creates: number;
  /** `ScheduledFire(origin=schedule_wakeup, outcome=fired)` 条数 */
  wakeup_fires: number;
  /** 按「fire 对应的 create 不是最近一次 create」判出的多余 fire 数（实际采用） */
  wakeup_stale_fires: number;
  /** 按方案 §2.3 字面判据（两次 fire 之间无 create）判出的多余 fire 数 */
  wakeup_stale_fires_literal: number;
  /** `ScheduledReplace.replaced_count` 之和（修复后才有此事件） */
  wakeup_replaced: number;
  /** `ScheduledInject(outcome=dropped_superseded)` 条数（修复后才有） */
  wakeup_dropped: number;
  /** 同时待触发的唤醒数峰值（create +1 / fire −1 推演） */
  max_pending_wakeups: number;
  /** 手动撤销的唤醒数（cron_delete 且 prompt 里提到 schedule_wakeup 任务时的近似口径） */
  wakeup_deleted: number;
}

type Ev = { event?: string; data?: Record<string, unknown> };

/** 从 events.jsonl 的文本解析出审计结果（纯函数，供脚本与单测共用） */
export function auditEvents(session: string, events: Ev[]): WakeupAudit {
  // create 与 fire 各自按行序（= 时间序）收集：events.jsonl 是追加写的
  const creates: number[] = [];
  const fires: string[] = [];
  let replaced = 0;
  let dropped = 0;
  let deleted = 0;

  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.event === "PostToolUse") {
      if (d.tool_name === "schedule_wakeup" && d.is_error !== true) creates.push(1);
      // cron_delete 只按「确实删了东西」计数：is_error=false 才算
      if (d.tool_name === "cron_delete" && d.is_error !== true) deleted++;
    } else if (e.event === "ScheduledFire") {
      if (
        d.origin === "schedule_wakeup" &&
        d.outcome === "fired" &&
        typeof d.task_id === "string"
      ) {
        fires.push(d.task_id);
      }
    } else if (e.event === "ScheduledReplace") {
      if (typeof d.replaced_count === "number") replaced += d.replaced_count;
    } else if (e.event === "ScheduledInject") {
      if (d.outcome === "dropped_superseded") dropped++;
    }
  }

  // ── 字面判据：fire 之前（自上次 fire / 会话开始以来）有没有 create ──
  // 需要在遍历中同步推进，这里重放一遍，用「create 序号」当计数器。
  let staleLiteral = 0;
  {
    let createSeq = 0; // 已经过的 create 数
    let seenFire = 0; // 已经过的 fire 数
    let lastFireCreateSeq = -1; // 上一次 fire 时刻的 create 数
    for (const e of events) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      if (e.event === "PostToolUse" && d.tool_name === "schedule_wakeup" && d.is_error !== true) {
        createSeq++;
      } else if (
        e.event === "ScheduledFire" &&
        d.origin === "schedule_wakeup" &&
        d.outcome === "fired"
      ) {
        // 「与上一次 fire（或会话开始）之间没有 create」⇔ 两次 fire 之间的 create 数没变
        if (seenFire > 0 && createSeq === lastFireCreateSeq) staleLiteral++;
        lastFireCreateSeq = createSeq;
        seenFire++;
      }
    }
  }

  // ── 实际判据：fire 对应的 create 不是最近一次 create ──
  // create 与 fire 按时间序一一配对（旧实现每个 create 恰好 fire 一次）。
  let stale = 0;
  {
    let createSeq = 0;
    let fireIdx = 0;
    for (const e of events) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      if (e.event === "PostToolUse" && d.tool_name === "schedule_wakeup" && d.is_error !== true) {
        createSeq++;
      } else if (
        e.event === "ScheduledFire" &&
        d.origin === "schedule_wakeup" &&
        d.outcome === "fired"
      ) {
        // 这次 fire 建自第 fireIdx 次 create（0 基）；若此刻已有更晚的 create，就是被取代的
        if (fireIdx < createSeq - 1) stale++;
        fireIdx++;
      }
    }
  }

  // ── 峰值：create +1 / fire −1，同一时刻按行序（create 先于 fire 不会同刻）──
  let pending = 0;
  let maxPending = 0;
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.event === "PostToolUse" && d.tool_name === "schedule_wakeup" && d.is_error !== true) {
      pending++;
      if (pending > maxPending) maxPending = pending;
    } else if (
      e.event === "ScheduledFire" &&
      d.origin === "schedule_wakeup" &&
      d.outcome === "fired"
    ) {
      if (pending > 0) pending--;
    }
  }

  return {
    session,
    wakeup_creates: creates.length,
    wakeup_fires: fires.length,
    wakeup_stale_fires: stale,
    wakeup_stale_fires_literal: staleLiteral,
    wakeup_replaced: replaced,
    wakeup_dropped: dropped,
    max_pending_wakeups: maxPending,
    wakeup_deleted: deleted,
  };
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

function sessionsRoot(): string {
  return process.env.SID_CONFIG_DIR
    ? join(process.env.SID_CONFIG_DIR, "trajectories", "sessions")
    : join(homedir(), ".sid-code", "trajectories", "sessions");
}

function auditOne(dir: string): WakeupAudit | null {
  const file = join(dir, "events.jsonl");
  if (!existsSync(file)) return null;
  const audit = auditEvents(dir.split("/").pop() ?? dir, readEvents(file));
  // 分母：只统计至少 1 次 create 的会话——没有 create 的会话不该进平均值
  return audit.wakeup_creates > 0 ? audit : null;
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const all = args.includes("--all");
  const target = args.find((a) => !a.startsWith("--"));

  const root = sessionsRoot();
  let results: WakeupAudit[] = [];

  if (all) {
    if (!existsSync(root)) {
      process.stderr.write(`没有轨迹目录: ${root}\n`);
      process.exit(1);
    }
    for (const name of readdirSync(root)) {
      const a = auditOne(join(root, name));
      if (a) results.push(a);
    }
  } else if (target) {
    // 支持传完整目录或裸会话 id
    const dir = target.includes("/") ? target : join(root, target);
    const a = auditOne(dir);
    if (!a) {
      process.stderr.write(`会话 ${target} 没有 schedule_wakeup 记录（或轨迹不存在）\n`);
      process.exit(1);
    }
    results = [a];
  } else {
    process.stderr.write(
      "用法: bun scripts/wakeup-audit.ts <session-dir|session-id> [--json]\n" +
        "      bun scripts/wakeup-audit.ts --all [--json]\n",
    );
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    return;
  }

  const sum = (k: keyof WakeupAudit) => results.reduce((n, r) => n + (r[k] as number), 0);
  for (const r of results) {
    console.log(
      `${r.session}: create=${r.wakeup_creates} fire=${r.wakeup_fires} ` +
        `stale=${r.wakeup_stale_fires}(literal ${r.wakeup_stale_fires_literal}) ` +
        `replaced=${r.wakeup_replaced} dropped=${r.wakeup_dropped} ` +
        `max_pending=${r.max_pending_wakeups} deleted=${r.wakeup_deleted}`,
    );
  }
  if (results.length > 1) {
    console.log(
      `合计 ${results.length} 个会话: create=${sum("wakeup_creates")} fire=${sum("wakeup_fires")} ` +
        `stale=${sum("wakeup_stale_fires")}(literal ${sum("wakeup_stale_fires_literal")}) ` +
        `replaced=${sum("wakeup_replaced")} dropped=${sum("wakeup_dropped")}`,
    );
  }
}

if (import.meta.main) main();
