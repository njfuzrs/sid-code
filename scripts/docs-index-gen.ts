#!/usr/bin/env bun
/**
 * docs-index-gen.ts — 治理 Batch 6:从 frontmatter 自动重建 docs/INDEX.md
 *
 * 防止 INDEX 自己变成"又一处漂移源"。扫描全部 .md 的 frontmatter,
 * 生成「现行入口置顶 + 体系导航 + 全量状态表」,纳入 CI。
 *
 * INDEX.md 用 <!-- AUTO-GEN:START --> / <!-- AUTO-GEN:END --> 标记自动区,
 * 标记外的人工置顶内容保留。
 *
 * 用法: bun run scripts/docs-index-gen.ts            # 写入
 *       bun run scripts/docs-index-gen.ts --check     # CI: 检查 INDEX 是否最新,不一致退出 1
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const DOCS = join(import.meta.dir, "..", "docs");
const INDEX = join(DOCS, "INDEX.md");
const CHECK = process.argv.includes("--check");
const START = "<!-- AUTO-GEN:START 由 scripts/docs-index-gen.ts 生成,勿手工编辑 -->";
const END = "<!-- AUTO-GEN:END -->";

/**
 * 从零重建 INDEX.md 时写在 AUTO-GEN 区之前的人工区。
 *
 * 必须带 frontmatter:INDEX.md 自己也在 docs-lint 的 R3 扫描范围内(它只在
 * R1「位置==状态」上被 isNav 豁免,frontmatter 该有还得有),少了就是自产自销一条 lint 错。
 * 内容保持极简且静态 —— 这块是「人工置顶区」,后续有人往里写东西会被原样保留。
 */
const HEADER = `---
status: active
era: timeless
last_verified: 2026-08-10
---

# docs 索引

本页的状态表由 \`scripts/docs-index-gen.ts\` 从各文档 frontmatter 生成,
本行以上属人工区,重新生成时保留。

`;

function parseFm(body: string): Record<string, string> | null {
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) return null;
  const end = body.indexOf("\n---", 4);
  if (end < 0) return null;
  const fm: Record<string, string> = {};
  for (const line of body.slice(4, end).split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.+)$/i);
    if (m) fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

/** 取正文首个 # 标题作为文档标题 */
function firstHeading(body: string, fallback: string): string {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

const STATUS_EMOJI: Record<string, string> = {
  active: "🟢 active", done: "✅ done", draft: "📝 draft",
  parked: "🅿️ parked", superseded: "⛔ superseded", archived: "📦 archived",
};

interface Row { path: string; title: string; era: string; status: string; }
const glob = new Glob("**/*.md");
const rows: Row[] = [];

for (const file of glob.scanSync(DOCS)) {
  const rel = file.replace(/\\/g, "/");
  if (rel === "INDEX.md") continue;
  const body = readFileSync(join(DOCS, file), "utf8");
  const fm = parseFm(body);
  rows.push({
    path: rel,
    title: firstHeading(body, rel.split("/").pop()!),
    era: fm?.era ?? "?",
    status: fm?.status ?? "?",
  });
}
rows.sort((a, b) => a.path.localeCompare(b.path));

// 按一级目录分组统计
const byDir = new Map<string, Row[]>();
for (const r of rows) {
  const top = r.path.includes("/") ? r.path.split("/")[0] : "(根)";
  if (!byDir.has(top)) byDir.set(top, []);
  byDir.get(top)!.push(r);
}

// 状态分布统计
const statusCount = new Map<string, number>();
for (const r of rows) statusCount.set(r.status, (statusCount.get(r.status) ?? 0) + 1);

let out = `${START}\n\n`;
out += `> 本区由 \`scripts/docs-index-gen.ts\` 从各文件 frontmatter 自动生成（共 ${rows.length} 个文档），随 CI 校验。勿手工编辑——下次生成会被覆盖。最近生成基准：2026-06-02。\n\n`;

// 状态分布
out += `## 状态分布\n\n`;
out += `| 状态 | 数量 |\n|---|---:|\n`;
for (const s of ["active", "done", "parked", "draft", "superseded", "archived"]) {
  if (statusCount.has(s)) out += `| ${STATUS_EMOJI[s] ?? s} | ${statusCount.get(s)} |\n`;
}
out += `| **合计** | **${rows.length}** |\n\n`;

// 全量状态表(按目录分组)
out += `## 全量状态表（按目录）\n\n`;
for (const [dir, drows] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  out += `### \`${dir}/\`（${drows.length}）\n\n`;
  out += `| 文件 | 标题 | era | 状态 |\n|---|---|---|---|\n`;
  for (const r of drows) {
    const name = r.path.startsWith(dir + "/") ? r.path.slice(dir.length + 1) : r.path;
    const title = r.title.replace(/\|/g, "\\|").slice(0, 50);
    out += `| [\`${name}\`](${r.path}) | ${title} | ${r.era} | ${STATUS_EMOJI[r.status] ?? r.status} |\n`;
  }
  out += `\n`;
}
out += `${END}\n`;

// 读现有 INDEX,替换 AUTO-GEN 区(保留人工置顶)
//
// ⚠️ 必须容忍文件不存在:INDEX.md 曾被 commit 0fc608df「清理过时文档」连带删除,
// 而这里原先无条件 readFileSync → ENOENT 直接崩栈,把 `docs:index-check` 门禁
// (以及串了它的 `docs:check` 与 docs-lint.yml)变成永久失败。下面那个「首次:追加自动区」
// 分支本就是为这种情况写的,只是读文件这一步先崩了,永远走不到。
const cur = existsSync(INDEX) ? readFileSync(INDEX, "utf8") : "";
let next: string;
const s = cur.indexOf(START);
const e = cur.indexOf(END);
if (s >= 0 && e >= 0) {
  next = cur.slice(0, s) + out + cur.slice(e + END.length);
} else if (cur.trim() === "") {
  // 文件不存在或为空:整份就是自动区,别在开头留一个孤立的 `---` 分隔符
  next = HEADER + out;
} else {
  // 首次:在文件末尾追加自动区
  next = cur.trimEnd() + "\n\n---\n\n" + out;
}
next = next.trimEnd() + "\n"; // 规范化尾部,保证幂等

if (CHECK) {
  if (next !== cur) {
    const why = existsSync(INDEX) ? "与 frontmatter 不一致" : "不存在";
    console.log(`✗ INDEX.md ${why},请运行: bun run scripts/docs-index-gen.ts`);
    process.exit(1);
  }
  console.log("✅ INDEX.md 是最新的");
  process.exit(0);
}

writeFileSync(INDEX, next, "utf8");
console.log(`✅ INDEX.md 已重建：${rows.length} 个文档，${byDir.size} 个目录分组`);
