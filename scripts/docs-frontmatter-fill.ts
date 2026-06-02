#!/usr/bin/env bun
/**
 * docs-frontmatter-fill.ts — 治理 Batch 6：批量补 frontmatter
 *
 * 策略(保守)：只给「完全没有 frontmatter」的 .md 加 4 字段头；已有头的文件一律不动。
 * 字段推断规则见下方 inferStatus / inferEra。核心治理对象由 OVERRIDES 人工锚定。
 *
 * 用法：
 *   bun run scripts/docs-frontmatter-fill.ts          # 写入
 *   bun run scripts/docs-frontmatter-fill.ts --dry     # 只打印不写
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const DOCS = join(import.meta.dir, "..", "docs");
const DRY = process.argv.includes("--dry");
const LAST_VERIFIED = "2026-06-02";

// 核心治理对象人工锚定(相对 docs/ 路径 → {status, era})——优先级高于自动推断
const OVERRIDES: Record<string, { status: string; era: string; superseded_by?: string }> = {
  "INDEX.md": { status: "active", era: "timeless" },
  "README.md": { status: "active", era: "timeless" },
};

/** 推断 era */
function inferEra(rel: string, body: string): string {
  const base = rel.split("/").pop()!.toLowerCase();
  if (base === "index.md" || base === "readme.md" || base === "_template.md") return "timeless";
  // go-era 信号：路径或正文头部出现 Go/Cobra/Bubble Tea 技术栈
  const head = body.slice(0, 600).toLowerCase();
  const goSignals = /\bgo\b.*\bcobra\b|bubble\s*tea|cobra.*bubbletea|go\s*\+\s*cobra/;
  if (goSignals.test(head) || /001-go-architecture/.test(rel)) return "go";
  return "ts";
}

/** 计算从某 docs 相对路径文件到 docs/ 根下某锚点的深度正确相对路径 */
function relTo(rel: string, target: string): string {
  const dirDepth = rel.split("/").length - 1; // 减去文件名
  return "../".repeat(dirDepth) + target;
}

/** 推断 status —— 物理位置优先(满足 lint「位置==状态」) */
function inferStatus(rel: string, body: string): { status: string; superseded_by?: string } {
  const inArchive = rel.includes("_archive/") || rel.includes("/_archive");
  const base = rel.split("/").pop()!.toLowerCase();

  // _archive 区：status ∈ {archived, parked, done}
  if (inArchive) {
    if (rel.includes("_archive/optimization/")) return { status: "parked" };
    if (rel.includes("_archive/done/")) return { status: "done" };
    if (rel.includes("_archive/hotfix/")) return { status: "done" };
    if (rel.includes("adr/_archive/")) return { status: "archived", superseded_by: relTo(rel, "adr/README.md") };
    // 其余 _archive(eval/_archive phase 方案、research)→ archived
    return { status: "archived", superseded_by: relTo(rel, "INDEX.md") };
  }

  // history 区:历史档案
  if (rel.startsWith("history/")) {
    if (base === "readme.md") return { status: "active" };
    return { status: "archived", superseded_by: relTo(rel, "INDEX.md") };
  }

  // ADR 正文 **Status**: Accepted/Proposed/Superseded
  const m = body.match(/\*\*Status\*\*:\s*(\w+)/i);
  if (m) {
    const s = m[1].toLowerCase();
    if (s === "superseded") return { status: "superseded", superseded_by: relTo(rel, "adr/README.md") };
    if (s === "proposed" || s === "draft") return { status: "draft" };
    return { status: "active" }; // Accepted → active(append-only 账本仍有效)
  }

  // 正文旧 schema status 行(SPEC 类) status: Done/Active
  const sm = body.match(/^\s*status:\s*(\w+)/im);
  if (sm) {
    const s = sm[1].toLowerCase();
    if (["done", "completed", "complete"].includes(s)) return { status: "done" };
    if (s === "active") return { status: "active" };
    if (s === "superseded") return { status: "superseded", superseded_by: relTo(rel, "INDEX.md") };
  }

  // 周报 / gate / changelog / examples / testing → done(已交付且有效)
  if (rel.startsWith("weekly-eval-report/")) return { status: "done" };
  if (rel.startsWith("gates/")) return { status: base === "readme.md" ? "active" : "done" };
  if (rel.startsWith("changelog/")) return { status: "done" };
  if (rel.startsWith("bugfixes/")) return { status: "done" };

  // 默认现行有效
  return { status: "active" };
}

function buildFrontmatter(status: string, era: string, superseded_by?: string): string {
  const lines = ["---", `status: ${status}`, `era: ${era}`];
  if ((status === "superseded" || status === "archived") && superseded_by) {
    lines.push(`superseded_by: ${superseded_by}`);
  }
  lines.push(`last_verified: ${LAST_VERIFIED}`, "---", "");
  return lines.join("\n");
}

const glob = new Glob("**/*.md");
let added = 0, skipped = 0;
const report: string[] = [];

for (const file of glob.scanSync(DOCS)) {
  const abs = join(DOCS, file);
  const rel = file.replace(/\\/g, "/");
  const body = readFileSync(abs, "utf8");

  if (body.startsWith("---\n") || body.startsWith("---\r\n")) {
    skipped++;
    continue;
  }

  const ov = OVERRIDES[rel];
  const era = ov?.era ?? inferEra(rel, body);
  const st = ov ? { status: ov.status, superseded_by: ov.superseded_by } : inferStatus(rel, body);
  const fm = buildFrontmatter(st.status, era, st.superseded_by);

  report.push(`+ ${rel}  [${st.status}/${era}${st.superseded_by ? " →" + st.superseded_by : ""}]`);
  if (!DRY) writeFileSync(abs, fm + body, "utf8");
  added++;
}

console.log(report.join("\n"));
console.log(`\n${DRY ? "[DRY] " : ""}补 frontmatter: ${added} 个，跳过(已有): ${skipped} 个`);
