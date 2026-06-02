#!/usr/bin/env bun
/**
 * docs-frontmatter-normalize.ts — 治理 Batch 6:规范化旧 schema frontmatter
 *
 * 针对「已有 frontmatter 但不符新 schema」的文件(旧 SPEC 用 id/title/status:Done 大写头):
 *   - 注入缺失的 era / last_verified 字段(保留 id/title/priority 等旧字段)
 *   - status 大写值规范化为小写新枚举(物理位置优先:_archive/done/ → done)
 * 已符合新 schema 的文件不动。
 *
 * 用法: bun run scripts/docs-frontmatter-normalize.ts [--dry]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const DOCS = join(import.meta.dir, "..", "docs");
const DRY = process.argv.includes("--dry");
const LAST_VERIFIED = "2026-06-02";
const VALID_STATUS = ["active", "done", "draft", "parked", "superseded", "archived"];

/** 旧 status 值 → 新枚举(结合物理位置) */
function normStatus(raw: string, rel: string): string {
  const s = raw.toLowerCase().replace(/['"]/g, "");
  if (VALID_STATUS.includes(s)) {
    // 已是合法值,但位置==状态校正:_archive/done/ 下的 backlog/active 一律 done
    if (rel.includes("_archive/done/") || rel.includes("_archive/done/")) return "done";
    return s;
  }
  // 大写/旧词映射
  if (["done", "completed", "complete", "backlog", "accepted"].includes(s)) {
    // 在 _archive 区一律视为已归档完成
    if (rel.includes("_archive/")) return "done";
    return "done";
  }
  if (s === "active" || s === "in_progress" || s === "wip") return rel.includes("_archive/") ? "done" : "active";
  if (s === "draft" || s === "proposed") return "draft";
  if (s === "superseded") return "superseded";
  return rel.includes("_archive/") ? "done" : "active";
}

function inferEra(rel: string, body: string): string {
  const base = rel.split("/").pop()!.toLowerCase();
  if (base === "index.md" || base === "readme.md" || base.endsWith("-template.md") || base === "_template.md") return "timeless";
  const head = body.slice(0, 800).toLowerCase();
  if (/\bcobra\b|bubble\s*tea|go\s*\+\s*cobra/.test(head)) return "go";
  return "ts";
}

const glob = new Glob("**/*.md");
let fixed = 0;
const report: string[] = [];

for (const file of glob.scanSync(DOCS)) {
  const rel = file.replace(/\\/g, "/");
  const abs = join(DOCS, file);
  const body = readFileSync(abs, "utf8");

  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) continue; // 无 fm 交给 fill 脚本
  const end = body.indexOf("\n---", 4);
  if (end < 0) continue;

  const fmBlock = body.slice(4, end);
  const rest = body.slice(end + 4); // 含开头换行
  const fmLines = fmBlock.split("\n");
  const keys = new Map<string, number>();
  fmLines.forEach((l, i) => {
    const m = l.match(/^([a-z_]+):/i);
    if (m) keys.set(m[1].toLowerCase(), i);
  });

  const hasEra = keys.has("era");
  const hasLastVerified = keys.has("last_verified");
  const statusIdx = keys.get("status");
  let changed = false;

  // 规范化 status 大写值
  if (statusIdx !== undefined) {
    const cur = fmLines[statusIdx].replace(/^status:\s*/i, "").trim();
    const norm = normStatus(cur, rel);
    if (norm !== cur) { fmLines[statusIdx] = `status: ${norm}`; changed = true; }
  }

  // 注入缺失字段
  const inject: string[] = [];
  if (!hasEra) inject.push(`era: ${inferEra(rel, body)}`);
  if (!hasLastVerified) inject.push(`last_verified: ${LAST_VERIFIED}`);
  if (inject.length) { fmLines.push(...inject); changed = true; }

  if (changed) {
    report.push(`~ ${rel}  [+${inject.join(",+") || "status规范化"}]`);
    if (!DRY) writeFileSync(abs, `---\n${fmLines.join("\n")}\n---${rest}`, "utf8");
    fixed++;
  }
}

console.log(report.join("\n"));
console.log(`\n${DRY ? "[DRY] " : ""}规范化: ${fixed} 个文件`);
