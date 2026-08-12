#!/usr/bin/env bun
/**
 * jit-context-stats —— JIT 上下文度量的**跨会话**基线脚本（第 5 批）
 *
 * ## 为什么单会话的 `trace-digest` 不够
 *
 * `bun scripts/trace-digest.ts` 已能答出「**这一个**会话 JIT 命中率多少」，
 * 但立基线要的是分布：单会话的命中率可能因为「这次刚好只碰了没规则的目录」
 * 而低到 0，据此调优就是在噪声上做决策。本脚本把多会话汇总，给出
 * 「跨会话命中率 / 累积字节分布 / 浪费率」——第 6 批的成本治理策略要靠这条曲线。
 *
 * ## 与 CLAUDE.md 北极星的关系
 *
 * 「更省」这一项目前唯一有硬数据的是 prompt cache。JIT 注入是**单调增长且每轮
 * 全量携带**的，是 cost 的另一半（§10.2/§10.3）。这个脚本就是把这一半从
 * 「感觉还行」变成「量得出来」。
 *
 * 用法：
 *   bun scripts/jit-context-stats.ts                  # 扫最近 200 个会话
 *   bun scripts/jit-context-stats.ts --limit 1000     # 扫最近 N 个
 *   bun scripts/jit-context-stats.ts --all            # 扫全部
 *   bun scripts/jit-context-stats.ts --json           # 机器可读（写回文档用）
 *   bun scripts/jit-context-stats.ts --by-file        # 附「哪些规则文件最吃上下文」排行
 *   bun scripts/jit-context-stats.ts --list           # 列出各会话明细（抽查用）
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  resolvePaths,
  listSessions,
  aggregateJitStats,
  percentile,
} from "@sid-code/core/trace/digest.ts";

interface SessionJit {
  id: string;
  /** 该会话的 JIT 聚合（null = 无 jit_context 事件） */
  stats: NonNullable<ReturnType<typeof aggregateJitStats>> | null;
  /** 该会话是否有文件类工具调用 —— 用于区分「JIT 该触发但没触发」与「本来就没碰文件」 */
  hasFileTool: boolean;
  /** 主循环 / 子代理两条通道各自的事件数（验证 P2-1 那条通道真的在打点） */
  bySource: Record<string, number>;
  /** 会话开始时间（ms epoch，从 id 前缀解析）—— 用于剔除埋点上线前的会话 */
  startedAtMs: number;
}

/**
 * 埋点上线时间（`97336b84` 提交时刻，2026-07-31 11:11 +0800）。
 *
 * 早于此刻的会话**必然**没有 `jit_context` 事件 —— 把它们算进「有文件工具却零
 * JIT 事件」的告警里会产生刺眼的假阳性（首次跑本脚本时 22/34 全是这种）。
 * 假阳性的代价不是烦人而是致命：下次真出现「埋点失效」时，读者会因为
 * 「这个告警一直都在」而忽略它。所以这里显式分流，而不是留给读者去推理。
 */
const TELEMETRY_LANDED_MS = new Date("2026-07-31T11:11:27+08:00").getTime();

/** 从会话 id 前缀 `YYYYMMDD-HHMMSS-xxxx` 解析开始时间；解析不出返回 0（按「未知」处理，不进告警） */
function parseSessionStartMs(id: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 会触发 JIT 的文件类工具（与 `jitAffectedPaths` 自报机制大致对应，此处仅用于统计口径） */
const FILE_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "multi_edit",
  "notebook_edit",
  "read_many_files",
  "grep",
  "glob",
  "ls",
  "lsp",
]);

function scanSession(dir: string, id: string): SessionJit | null {
  const p = join(dir, "events.jsonl");
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return null;
  }

  const events: Array<{ event?: string; data?: Record<string, unknown> }> = [];
  let hasFileTool = false;
  const bySource: Record<string, number> = {};

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(ev);
    if (ev.event === "PreToolUse" && ev.data?.tool_name && FILE_TOOLS.has(ev.data.tool_name)) {
      hasFileTool = true;
    }
    if (ev.event === "jit_context") {
      // source 是第 5 批新加的字段，老事件没有 → 归到 legacy，避免统计里凭空多一类 undefined
      const src = typeof ev.data?.source === "string" ? ev.data.source : "legacy";
      bySource[src] = (bySource[src] ?? 0) + 1;
    }
  }

  return {
    id,
    stats: aggregateJitStats(events),
    hasFileTool,
    bySource,
    startedAtMs: parseSessionStartMs(id),
  };
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function fmtBytes(n: number): string {
  if (!n || n <= 0) return "0B";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const all = args.includes("--all");
  const byFile = args.includes("--by-file");
  const list = args.includes("--list");
  const limIdx = args.indexOf("--limit");
  const limit = all ? Infinity : limIdx >= 0 ? Number(args[limIdx + 1]) || 200 : 200;

  const paths = resolvePaths();
  const refs = listSessions(paths);
  if (refs.length === 0) {
    process.stderr.write(`未找到任何会话轨迹（${paths.sessionsDir}）。\n`);
    process.exit(1);
  }

  const picked = refs.slice(0, limit === Infinity ? refs.length : limit);
  const sessions: SessionJit[] = [];
  for (const ref of picked) {
    const s = scanSession(ref.dir, ref.id);
    if (s) sessions.push(s);
  }

  const withJit = sessions.filter((s) => s.stats !== null);
  /** 埋点上线后产生的会话 —— 只有这些的「零 JIT 事件」才是有意义的信号 */
  const postTelemetry = sessions.filter((s) => s.startedAtMs >= TELEMETRY_LANDED_MS);
  /** 埋点上线前的会话数（它们必然零事件，单独报数以免读者误判） */
  const preTelemetryCount = sessions.length - postTelemetry.length;
  // 关键对照组：碰了文件类工具但**一条 JIT 事件都没有** —— 这是「埋点没接上」
  // 或「JIT 整条静默失效」的信号（P1-4 那类 bug 的复发探针），不是正常现象。
  // 必须限定在埋点上线后的会话，否则老会话会刷出一片假阳性，把真信号淹掉。
  const fileToolNoJit = postTelemetry.filter((s) => s.hasFileTool && s.stats === null);

  const totals = {
    injections: 0,
    hits: 0,
    loadedCount: 0,
    injectedBytes: 0,
    scopeSkipped: 0,
    oversized: 0,
    failures: 0,
  };
  const cumulatives: number[] = [];
  const elapsedP95s: number[] = [];
  const reasonCounts: Record<string, number> = {};
  const failureCodes: Record<string, number> = {};
  const bySourceTotal: Record<string, number> = {};
  /** 文件 → 该文件在各会话中的最大字节（跨会话取最大，不累加：同一份规则不该按出现次数放大） */
  const fileBytes = new Map<string, number>();

  for (const s of withJit) {
    const st = s.stats!;
    totals.injections += st.injections;
    totals.hits += st.hits;
    totals.loadedCount += st.loadedCount;
    totals.injectedBytes += st.injectedBytes;
    totals.scopeSkipped += st.scopeSkipped;
    totals.oversized += st.oversized;
    totals.failures += st.failures;
    if (st.cumulativeBytes > 0) cumulatives.push(st.cumulativeBytes);
    if (st.elapsedP95 != null) elapsedP95s.push(st.elapsedP95);
    for (const [k, v] of Object.entries(st.reasonCounts))
      reasonCounts[k] = (reasonCounts[k] ?? 0) + v;
    for (const [k, v] of Object.entries(st.failureCodes))
      failureCodes[k] = (failureCodes[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.bySource)) bySourceTotal[k] = (bySourceTotal[k] ?? 0) + v;
    for (const f of st.topFiles) {
      fileBytes.set(f.path, Math.max(fileBytes.get(f.path) ?? 0, f.bytes));
    }
  }

  const sortedCum = cumulatives.slice().sort((a, b) => a - b);
  const sortedP95 = elapsedP95s.slice().sort((a, b) => a - b);
  const scanned = totals.loadedCount + totals.scopeSkipped;

  const summary = {
    scannedSessions: sessions.length,
    /** 埋点上线前的会话（必然零事件，不构成信号） */
    sessionsPreTelemetry: preTelemetryCount,
    sessionsWithJit: withJit.length,
    sessionsFileToolButNoJit: fileToolNoJit.length,
    injections: totals.injections,
    hits: totals.hits,
    hitRate: pct(totals.hits, totals.injections),
    loadedCount: totals.loadedCount,
    scopeSkipped: totals.scopeSkipped,
    wasteRate: pct(totals.scopeSkipped, scanned),
    injectedBytesTotal: totals.injectedBytes,
    avgInjectedBytesPerInjection:
      totals.injections > 0 ? Math.round(totals.injectedBytes / totals.injections) : 0,
    cumulativeBytes: {
      p50: percentile(sortedCum, 0.5) ?? 0,
      p95: percentile(sortedCum, 0.95) ?? 0,
      max: sortedCum.length > 0 ? sortedCum[sortedCum.length - 1] : 0,
    },
    elapsedMsP95AcrossSessions: {
      p50: percentile(sortedP95, 0.5) ?? 0,
      max: sortedP95.length > 0 ? sortedP95[sortedP95.length - 1] : 0,
    },
    oversized: totals.oversized,
    failures: totals.failures,
    failureCodes,
    reasonCounts,
    bySource: bySourceTotal,
  };

  if (json) {
    const out: any = { summary };
    if (byFile) {
      out.topFiles = [...fileBytes.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([path, bytes]) => ({ path, bytes }));
    }
    if (list) {
      out.sessions = withJit.map((s) => ({ id: s.id, ...s.stats }));
      out.fileToolButNoJit = fileToolNoJit.map((s) => s.id);
    }
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  const L: string[] = [];
  L.push("═══ JIT 上下文度量基线（跨会话）═══");
  L.push(
    `扫描会话：${summary.scannedSessions}   有 JIT 数据：${summary.sessionsWithJit}` +
      (preTelemetryCount > 0 ? `   埋点上线前（必然零事件）：${preTelemetryCount}` : ""),
  );
  L.push("");

  if (withJit.length === 0) {
    L.push("没有任何会话带 jit_context 事件。可能原因：");
    if (postTelemetry.length === 0) {
      L.push(
        `  ▸ 本次样本 ${sessions.length} 个会话**全部早于埋点上线时刻**（2026-07-31 11:11）——`,
      );
      L.push("    这是预期结果，不是缺陷。跑几个新任务后再来立基线。");
    } else {
      L.push("  ① trace 上传后本地文件被清理（见 §12 验证方法注解）");
      L.push("  ② config.jitContext = false 或 SID_CODE_DISABLE_PROJECT_RULES=1");
      L.push("  ③ 会话全程没碰文件类工具（JIT 本就不该触发）");
    }
    if (fileToolNoJit.length > 0) {
      L.push("");
      L.push(`⚠ ${fileToolNoJit.length} 个**埋点上线后**的会话调用过文件类工具却零 JIT 事件 ——`);
      L.push("  这是 JIT 或埋点整条失效的信号（P1-4 那类 bug 的复发探针），值得排查。");
    }
    process.stdout.write(L.join("\n") + "\n");
    return;
  }

  L.push("核心三问（第 5 批的验收标准）：");
  L.push(`  命中率 ....... ${summary.hitRate}  (${summary.hits}/${summary.injections} 次触发命中)`);
  L.push(
    `  均次注入 ..... ${fmtBytes(summary.avgInjectedBytesPerInjection)}  (合计 ${fmtBytes(summary.injectedBytesTotal)})`,
  );
  L.push(
    `  浪费率 ....... ${summary.wasteRate}  (作用域跳过 ${summary.scopeSkipped} / 扫到 ${scanned} 份)`,
  );
  L.push("");
  L.push("累积字节（§10.3 —— 每轮全量携带的真实成本，治理重点）：");
  L.push(
    `  P50=${fmtBytes(summary.cumulativeBytes.p50)}  P95=${fmtBytes(summary.cumulativeBytes.p95)}  ` +
      `MAX=${fmtBytes(summary.cumulativeBytes.max)}`,
  );
  L.push("");
  L.push("耗时（各会话 P95 的分布 —— P2-3 已 fire-and-forget，不进 TTFT，此处看队列拖尾）：");
  L.push(
    `  P50=${summary.elapsedMsP95AcrossSessions.p50}ms  MAX=${summary.elapsedMsP95AcrossSessions.max}ms`,
  );
  L.push("");
  const reasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) L.push("归因分布：" + reasons.map(([r, n]) => `${r}×${n}`).join("  "));
  const srcs = Object.entries(bySourceTotal).sort((a, b) => b[1] - a[1]);
  if (srcs.length > 0) {
    L.push("通道分布：" + srcs.map(([s, n]) => `${s}×${n}`).join("  "));
    if (!bySourceTotal.subagent) {
      L.push("  注：子代理通道 0 条。若样本里确实用过子代理，说明 sub-agent 侧埋点未生效。");
    }
  }
  if (summary.oversized > 0) L.push(`⚡ 超大小告警阈值：${summary.oversized} 份（内容未截断）`);
  if (summary.failures > 0) {
    L.push(
      `✗ 读取失败：${summary.failures} 次  ` +
        Object.entries(failureCodes)
          .map(([k, n]) => `${k}×${n}`)
          .join(" "),
    );
  }
  if (fileToolNoJit.length > 0) {
    L.push("");
    L.push(
      `⚠ ${fileToolNoJit.length} 个**埋点上线后**的会话调用过文件类工具但零 JIT 事件（抽查：--list）`,
    );
  }

  // 判读：给出下一步该做什么，而不是只丢一堆数字
  L.push("");
  const hitRateNum = totals.injections > 0 ? totals.hits / totals.injections : 0;
  const wasteNum = scanned > 0 ? totals.scopeSkipped / scanned : 0;
  const cumP95 = summary.cumulativeBytes.p95;
  if (cumP95 > 40_000) {
    L.push("判读：累积字节 P95 已超 40KB —— 第 6 批的淘汰机制有实据支撑，可以动手了。");
  } else if (cumP95 > 0) {
    L.push(`判读：累积字节 P95 = ${fmtBytes(cumP95)}，尚未构成成本压力 —— 第 6 批的淘汰机制`);
    L.push("      **先不要做**（§10.3 明确：无数据不动手，别先写代码再找数据证明它合理）。");
  }
  if (wasteNum > 0.5) {
    L.push(
      `      浪费率 ${pct(totals.scopeSkipped, scanned)} 偏高：大量规则被扫到却因 paths: 未命中而白读，值得看 glob 基准（第 7 批）。`,
    );
  }
  if (hitRateNum < 0.2 && totals.injections >= 20) {
    L.push(
      `      命中率 ${summary.hitRate} 偏低：多数触发落在无规则目录（可能正常），但值得抽查是否有边界判定问题。`,
    );
  }

  if (list) {
    L.push("");
    L.push("各会话明细：");
    for (const s of withJit.slice(0, 30)) {
      const st = s.stats!;
      L.push(
        `  ${s.id}  触发${st.injections} 命中${st.hits} ` +
          `累积${fmtBytes(st.cumulativeBytes)} 跳过${st.scopeSkipped} P95=${st.elapsedP95 ?? "?"}ms`,
      );
    }
    if (withJit.length > 30) L.push(`  … 还有 ${withJit.length - 30} 个`);
    if (fileToolNoJit.length > 0) {
      L.push("");
      L.push("埋点上线后·有文件类工具但零 JIT 事件的会话：");
      for (const s of fileToolNoJit.slice(0, 20)) L.push(`  ${s.id}`);
    }
  }

  if (byFile) {
    L.push("");
    L.push("最吃上下文的规则文件（跨会话取各自最大字节，非累加）：");
    for (const [path, bytes] of [...fileBytes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      L.push(`  ${fmtBytes(bytes).padStart(8)}  ${path}`);
    }
  }

  process.stdout.write(L.join("\n") + "\n");
}

main();
