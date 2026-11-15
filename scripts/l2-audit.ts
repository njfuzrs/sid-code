#!/usr/bin/env bun
/**
 * l2-audit —— 停滞 L2 命中点抽检
 *
 * 背景（docs-research/.../20261030-AgenticLoop防线治理-横向剖析第四节落地总体方案.md T7）：
 * L2 判据在 2026-10-30（#490，排除等后台任务的轮次）与 2026-11-06（#627，排除交付/验证轮）
 * 改过两次。判断「这条 L2 该不该触发」不能只看次数，要看命中点前后的工具轮在做什么
 * —— 改判据之前那次抽检（18 条样本、误伤 5 → 1）用的是 `/tmp` 里的临时脚本，
 * 脚本没入库，`/tmp` 清理后无法复算。本脚本把那次抽检的口径固化下来。
 *
 * 对每个 `StallEscalation{level:2}` 导出：
 *   - 命中时的 `toolTurns` 与影子字段 `bgWaitTurns` / `deliveryTurns`
 *     （影子字段 2026-10-30 起才有，更早的命中点显示 `-`，不能当 0 读）
 *   - 命中点之前 N 个工具轮的命令首行 / 文件
 *   - 命中点之后 M 个工具轮里有没有「成功写入」（edit / write 类且未报错）
 *
 * 输出是**待判读的原始证据**，不给「该不该触发」的结论 —— 判读需要人看前后文。
 * 明确的提示只有两条：影子字段非零（判据已把它排除，还触发说明另有信号）、
 * 命中后 M 轮内有成功写入（可能是误伤）。
 *
 * 用法：
 *   bun scripts/l2-audit.ts                          # 全部会话
 *   bun scripts/l2-audit.ts --since 2026-10-30       # 只看某日之后
 *   bun scripts/l2-audit.ts --before 6 --after 12
 *   bun scripts/l2-audit.ts --json
 */

import { resolvePaths } from "@sid-code/core/trace/digest.ts";
import { iterSessionEvents, type TraceEvent } from "./defense-trigger-report.ts";

/** 算「写入」的工具名。编辑类成功 = 有进展，是 L2 误伤的主要形态 */
const WRITE_TOOLS = new Set(["edit", "write", "multi_edit", "notebook_edit"]);

export interface ToolRound {
  tool: string;
  /** bash 取命令首行，其它取文件路径；都没有则空串 */
  detail: string;
  /** 配对的 PostToolUse / PostToolUseFailure 是否报错；找不到配对时为 null */
  isError: boolean | null;
}

export interface L2Hit {
  session: string;
  timestamp: string;
  turn: number | null;
  toolTurns: number | null;
  /** 影子字段：null = 该版本还没有这个字段（2026-10-30 之前），不是 0 */
  bgWaitTurns: number | null;
  deliveryTurns: number | null;
  signals: {
    oscillations: number | null;
    unchangedReports: number | null;
    rollbacks: number | null;
    greenRegressions: number | null;
    l2Count: number | null;
  };
  before: ToolRound[];
  after: ToolRound[];
  /** 命中后 M 轮内的成功写入次数 */
  successfulWritesAfter: number;
}

export interface L2AuditReport {
  window: { since: string | null; first: string | null; last: string | null };
  denominators: { sessions: number };
  hits: L2Hit[];
}

export interface AuditOptions {
  since?: string | null;
  before?: number;
  after?: number;
}

function detailOf(e: TraceEvent): string {
  const s = e.data?.input_summary ?? {};
  if (typeof s.command === "string") return s.command.split("\n", 1)[0] ?? "";
  if (typeof s.file_path === "string") return s.file_path;
  // 其它工具（web_search / task 等）没有统一的「一行摘要」，列出首个可读字段
  for (const v of Object.values(s)) if (typeof v === "string") return v.slice(0, 120);
  return "";
}

/** 把 PreToolUse 与配对的 PostToolUse / Failure 合成工具轮 */
function collectRounds(events: TraceEvent[]): { idx: number; round: ToolRound }[] {
  const errorOf = new Map<string, boolean>();
  for (const e of events) {
    const id = e.data?.tool_use_id;
    if (!id) continue;
    if (e.event === "PostToolUse" || e.event === "PostToolUseFailure") {
      errorOf.set(String(id), e.event === "PostToolUseFailure" || e.data?.is_error === true);
    }
  }
  const out: { idx: number; round: ToolRound }[] = [];
  events.forEach((e, idx) => {
    if (e.event !== "PreToolUse") return;
    const id = e.data?.tool_use_id;
    out.push({
      idx,
      round: {
        tool: String(e.data?.tool_name ?? "unknown"),
        detail: detailOf(e),
        isError: id ? (errorOf.get(String(id)) ?? null) : null,
      },
    });
  });
  return out;
}

/** 纯函数：把多会话事件流聚合成 L2 命中点清单（测试直接喂事件，不走磁盘） */
export function auditL2(sessions: Iterable<TraceEvent[]>, opts: AuditOptions = {}): L2AuditReport {
  const since = opts.since ?? null;
  const before = Math.max(0, opts.before ?? 4);
  const after = Math.max(0, opts.after ?? 8);
  const hits: L2Hit[] = [];
  let sessionsCount = 0;
  let first: string | null = null;
  let last: string | null = null;

  for (const events of sessions) {
    const start = events.find((e) => e.event === "SessionStart");
    const sid = String(start?.data?.session_id ?? events[0]?.session_id ?? "unknown");
    let counted = false;
    const rounds = collectRounds(events);

    events.forEach((e, idx) => {
      const ts = e.timestamp;
      if (ts) {
        if (!first || ts < first) first = ts;
        if (!last || ts > last) last = ts;
      }
      if (e.event !== "StallEscalation" || Number(e.data?.level) !== 2) return;
      if (since && ts && ts.slice(0, 10) < since) return;
      if (!counted) {
        sessionsCount++;
        counted = true;
      }
      const d = e.data ?? {};
      const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
      const prior = rounds
        .filter((r) => r.idx < idx)
        .slice(-before)
        .map((r) => r.round);
      const later = rounds
        .filter((r) => r.idx > idx)
        .slice(0, after)
        .map((r) => r.round);
      hits.push({
        session: sid,
        timestamp: String(ts ?? ""),
        turn: num(d.turn),
        toolTurns: num(d.toolTurns),
        bgWaitTurns: num(d.bgWaitTurns),
        deliveryTurns: num(d.deliveryTurns),
        signals: {
          oscillations: num(d.oscillations),
          unchangedReports: num(d.unchangedReports),
          rollbacks: num(d.rollbacks),
          greenRegressions: num(d.greenRegressions),
          l2Count: num(d.l2Count),
        },
        before: prior,
        after: later,
        successfulWritesAfter: later.filter((r) => WRITE_TOOLS.has(r.tool) && r.isError === false)
          .length,
      });
    });
  }

  hits.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { window: { since, first, last }, denominators: { sessions: sessionsCount }, hits };
}

// ─────────────────────────── 渲染 ───────────────────────────

const nz = (v: number | null): string => (v === null ? "-" : String(v));

export function renderAudit(r: L2AuditReport): string {
  const L: string[] = [];
  L.push("# 停滞 L2 命中点抽检");
  L.push(
    `窗口: ${r.window.since ? `since ${r.window.since}` : "全部"}（实际 ${r.window.first?.slice(0, 10) ?? "-"} ~ ${r.window.last?.slice(0, 10) ?? "-"}）`,
  );
  L.push(`会话 ${r.denominators.sessions} · L2 命中 ${r.hits.length} 次`);
  if (r.hits.length === 0) L.push("\n（窗口内 0 次）");
  r.hits.forEach((h, i) => {
    L.push("");
    L.push(`## ${i + 1}. ${h.session} @ ${h.timestamp}`);
    L.push(
      `  turn=${nz(h.turn)} toolTurns=${nz(h.toolTurns)} · 影子 bgWaitTurns=${nz(h.bgWaitTurns)} deliveryTurns=${nz(h.deliveryTurns)}`,
    );
    L.push(
      `  信号 osc=${nz(h.signals.oscillations)} unchanged=${nz(h.signals.unchangedReports)} rollback=${nz(h.signals.rollbacks)} greenReg=${nz(h.signals.greenRegressions)} l2Count=${nz(h.signals.l2Count)}`,
    );
    const hint: string[] = [];
    if (h.bgWaitTurns === null) hint.push("影子字段缺失（该版本早于 2026-10-30），不能按 0 读");
    else if (h.bgWaitTurns > 0) hint.push("命中时已扣掉等待轮仍触发 → 看后面的信号来源");
    if (h.deliveryTurns !== null && h.deliveryTurns > 0)
      hint.push("命中时已扣掉交付轮仍触发 → 看后面的信号来源");
    if (h.successfulWritesAfter > 0)
      hint.push(`命中后 ${h.after.length} 轮内有 ${h.successfulWritesAfter} 次成功写入 → 疑似误伤`);
    if (hint.length) L.push(`  ⚠ ${hint.join("；")}`);
    L.push(`  前 ${h.before.length} 轮:`);
    for (const b of h.before) L.push(`    [${b.tool}] ${b.detail}`);
    L.push(`  后 ${h.after.length} 轮（成功写入 ${h.successfulWritesAfter}）:`);
    for (const a of h.after) {
      const mark = a.isError === null ? "?" : a.isError ? "✗" : "✓";
      L.push(`    ${mark} [${a.tool}] ${a.detail}`);
    }
  });
  return L.join("\n");
}

// ─────────────────────────── CLI ───────────────────────────

export function parseAuditArgs(argv: string[]): {
  json: boolean;
  since: string | null;
  before: number;
  after: number;
} {
  let json = false;
  let since: string | null = null;
  let before = 4;
  let after = 8;
  const readInt = (v: string | undefined, name: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} 需要非负整数，收到: ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--since") {
      since = argv[++i] ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since))
        throw new Error(`--since 需要 YYYY-MM-DD，收到: ${since}`);
    } else if (a === "--before") before = readInt(argv[++i], "--before");
    else if (a === "--after") after = readInt(argv[++i], "--after");
    else throw new Error(`未知参数: ${a}（可用: --json --since --before --after）`);
  }
  return { json, since, before, after };
}

function main(): void {
  let args: ReturnType<typeof parseAuditArgs>;
  try {
    args = parseAuditArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String((err as Error).message));
    process.exit(2);
  }
  const paths = resolvePaths();
  const report = auditL2(iterSessionEvents(paths.sessionsDir), args);
  console.log(args.json ? JSON.stringify(report, null, 2) : renderAudit(report));
}

if (import.meta.main) {
  main();
}
