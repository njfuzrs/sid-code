#!/usr/bin/env bun
/**
 * 记忆写入质量报告：存量（磁盘）+ 增量（遥测）两个口径（§3 拒绝器的读数出口）
 *
 * ## 为什么需要它
 *
 * 2026-10-24 前「写进去的记忆质量如何」没有任何信号：类型分布、Why 缺失、reference
 * 无 URL、快照形态，全靠手写一次性脚本回读磁盘与 raw.jsonl。本脚本把那次审计固化下来，
 * 判据与写入侧**同一份实现**（`assessMemoryWrite`），不另立口径。
 *
 * ## 为什么只报告不改
 *
 * 与 `memory-dup-report.ts` 同理：一条无 URL 的 reference 该改成 feedback 还是 project、
 * 一条快照里哪一句是洞察，是语义判断，而记忆是用户数据。存量修正交给 autoDream
 * （其提示词已要求合并时把无 URL 的 reference 改成正确类型）或人工。
 *
 * 用法：
 *   bun run scripts/memory-quality-report.ts                 # 全部项目记忆 + 本机遥测
 *   bun run scripts/memory-quality-report.ts <memory目录>     # 只看一个目录
 *   bun run scripts/memory-quality-report.ts --json          # 机读输出
 *
 * 主口径（分母写死）：
 * - 存量：分母 = 磁盘上非 archive 的记忆文件数；`missing_why` 的分母 = feedback + project 条数
 * - 增量：分母 = `memory_write` 事件数；`scope_type_confusion` / `scope_denied` 是绝对次数
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { assessMemoryWrite } from "../packages/core/src/tool/memory.ts";
import { readFrontmatterFields } from "../packages/core/src/memory/scan.ts";
import { sidPaths } from "../packages/core/src/config/paths.ts";

export interface StockReport {
  files: number;
  byType: Record<string, number>;
  needsWhy: number;
  missingWhy: number;
  missingHow: number;
  referenceNoUrl: number;
  looksSnapshot: number;
  relativeDate: number;
}

export interface FlowReport {
  writes: number;
  byType: Record<string, number>;
  byVia: Record<string, number>;
  missingWhy: number;
  referenceNoUrl: number;
  looksSnapshot: number;
  relativeDate: number;
  hinted: number;
  guard: Record<string, number>;
}

/** 与 store / scan 同一枚举口径：跳过 archive 等子目录与 MEMORY.md 索引本身 */
function listMemoryFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (ent.name === "archive" || ent.name === "logs" || ent.name.startsWith(".")) continue;
      out.push(...listMemoryFiles(join(dir, ent.name)));
    } else if (ent.name.endsWith(".md") && ent.name !== "MEMORY.md") {
      out.push(join(dir, ent.name));
    }
  }
  return out;
}

export function stockReport(dirs: string[]): StockReport {
  const r: StockReport = {
    files: 0,
    byType: {},
    needsWhy: 0,
    missingWhy: 0,
    missingHow: 0,
    referenceNoUrl: 0,
    looksSnapshot: 0,
    relativeDate: 0,
  };
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of listMemoryFiles(dir)) {
      const text = readFileSync(file, "utf8");
      const m = text.match(/^---\s*\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (!m) continue;
      const fm = readFrontmatterFields(m[1]!);
      const type = fm.type ?? "unknown";
      const q = assessMemoryWrite(fm.name ?? "", m[2]!);
      r.files++;
      r.byType[type] = (r.byType[type] ?? 0) + 1;
      if (type === "feedback" || type === "project") {
        r.needsWhy++;
        if (!q.hasWhy) r.missingWhy++;
        if (!q.hasHow) r.missingHow++;
      }
      if (type === "reference" && !q.hasUrl) r.referenceNoUrl++;
      if (q.looksSnapshot) r.looksSnapshot++;
      if (q.relativeDate) r.relativeDate++;
    }
  }
  return r;
}

export function flowReport(eventFiles: string[]): FlowReport {
  const r: FlowReport = {
    writes: 0,
    byType: {},
    byVia: {},
    missingWhy: 0,
    referenceNoUrl: 0,
    looksSnapshot: 0,
    relativeDate: 0,
    hinted: 0,
    guard: {},
  };
  for (const f of eventFiles) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      // 先做廉价子串过滤：遥测文件动辄几十 MB，逐行 JSON.parse 全量太慢
      if (!line.includes('"memory_write"') && !line.includes('"memory_guard"')) continue;
      let e: { eventName?: string; metadata?: Record<string, unknown> };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const m = e.metadata ?? {};
      if (e.eventName === "memory_write") {
        r.writes++;
        const t = String(m.memory_type ?? "unknown");
        const via = String(m.write_via ?? "unknown");
        r.byType[t] = (r.byType[t] ?? 0) + 1;
        r.byVia[via] = (r.byVia[via] ?? 0) + 1;
        if (m.missing_why === true) r.missingWhy++;
        if (m.reference_no_url === true) r.referenceNoUrl++;
        if (m.looks_snapshot === true) r.looksSnapshot++;
        if (m.relative_date === true) r.relativeDate++;
        if (typeof m.hint_count === "number" && m.hint_count > 0) r.hinted++;
      } else if (e.eventName === "memory_guard") {
        const k = String(m.guard_kind ?? "unknown");
        if (k === "scope_denied" || k === "scope_type_confusion" || k === "secret_rejected") {
          r.guard[k] = (r.guard[k] ?? 0) + 1;
        }
      }
    }
  }
  return r;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%（${n}/${d}）`;
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const explicit = args.find((a) => !a.startsWith("--"));

  const dirs = explicit
    ? [explicit]
    : existsSync(sidPaths.projects())
      ? readdirSync(sidPaths.projects())
          .map((p) => join(sidPaths.projects(), p, "memory"))
          .filter((d) => existsSync(d) && statSync(d).isDirectory())
      : [];
  const telemetry = sidPaths.telemetry();
  const eventFiles = existsSync(telemetry)
    ? readdirSync(telemetry)
        .filter((f) => /^events(\.\d+)?\.jsonl$/.test(f))
        .map((f) => join(telemetry, f))
    : [];

  const stock = stockReport(dirs);
  const flow = flowReport(eventFiles);

  if (json) {
    console.log(JSON.stringify({ stock, flow }, null, 2));
    return;
  }
  console.log(`## 存量（${dirs.length} 个记忆目录，${stock.files} 条）`);
  console.log(`类型分布: ${JSON.stringify(stock.byType)}`);
  console.log(`reference 无 URL: ${pct(stock.referenceNoUrl, stock.byType.reference ?? 0)}`);
  console.log(`feedback/project 缺 Why 标签: ${pct(stock.missingWhy, stock.needsWhy)}`);
  console.log(`feedback/project 缺 How to apply: ${pct(stock.missingHow, stock.needsWhy)}`);
  console.log(`快照形态: ${pct(stock.looksSnapshot, stock.files)}`);
  console.log(`含相对日期: ${pct(stock.relativeDate, stock.files)}`);
  console.log("");
  console.log(`## 增量（memory_write 事件 ${flow.writes} 条）`);
  if (flow.writes === 0) {
    console.log("（暂无 memory_write 事件：该埋点 2026-10-24 起才有，需用新版本跑过会话）");
  } else {
    console.log(`类型分布: ${JSON.stringify(flow.byType)}  来源: ${JSON.stringify(flow.byVia)}`);
    console.log(`缺 Why（占全部写入）: ${pct(flow.missingWhy, flow.writes)}`);
    console.log(`reference 无 URL: ${pct(flow.referenceNoUrl, flow.byType.reference ?? 0)}`);
    console.log(`快照形态: ${pct(flow.looksSnapshot, flow.writes)}`);
    console.log(`收到写入提示: ${pct(flow.hinted, flow.writes)}`);
  }
  console.log(`防线计数: ${JSON.stringify(flow.guard)}`);
}

if (import.meta.main) main();
