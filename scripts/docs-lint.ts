#!/usr/bin/env bun
/**
 * docs-lint.ts — 治理 Batch 6：文档守门 lint(纳入 CI,违反即非零退出)
 *
 * 校验规则(防 §8 断链 + 状态漂移复发):
 *   R1 位置==状态   : _archive/ 下 status∈{archived,superseded,parked,done};非 _archive 下 status∈{active,done,draft,superseded}
 *   R2 后继存在     : status∈{superseded,archived} 必须有 superseded_by 且目标文件存在
 *   R3 frontmatter  : 所有 .md 必须有 4 字段头(status/era/last_verified 必填)
 *   R4 CLAUDE.md 路径: CLAUDE.md 内出现的 docs/ 路径必须真实存在
 *   R5 全仓断链     : .md 内相对链接 [..](x.md) 目标必须存在(剥代码块,跳锚点/外链)
 *
 * 用法: bun run scripts/docs-lint.ts            # CI 模式,有错退出 1
 *       bun run scripts/docs-lint.ts --warn     # 只告警不退出
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const DOCS = join(ROOT, "docs");
const WARN_ONLY = process.argv.includes("--warn");

const VALID_STATUS = ["active", "done", "draft", "parked", "superseded", "archived"];
const VALID_ERA = ["ts", "go", "timeless"];
const ARCHIVE_OK = ["archived", "superseded", "parked", "done"];
const NON_ARCHIVE_OK = ["active", "done", "draft", "superseded"];

const errors: string[] = [];
const err = (f: string, msg: string) => errors.push(`${f}: ${msg}`);

/** 解析 frontmatter(简单 YAML，仅取我们用的字段) */
function parseFm(body: string): Record<string, string> | null {
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) return null;
  const end = body.indexOf("\n---", 4);
  if (end < 0) return null;
  const fm: Record<string, string> = {};
  for (const line of body.slice(4, end).split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.+)$/i);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

/** 剥离代码块(``` 围栏)后返回正文,避免误判代码里的路径 */
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
}

const glob = new Glob("**/*.md");
const allMd: string[] = [...glob.scanSync(DOCS)].map((f) => f.replace(/\\/g, "/"));

// ---- R1/R2/R3：逐文件 frontmatter 校验 ----
for (const rel of allMd) {
  const abs = join(DOCS, rel);
  const body = readFileSync(abs, "utf8");
  const fm = parseFm(body);

  if (!fm) { err(rel, "R3 缺 frontmatter 头"); continue; }
  if (!fm.status) err(rel, "R3 缺 status 字段");
  else if (!VALID_STATUS.includes(fm.status)) err(rel, `R3 非法 status=${fm.status}`);
  if (!fm.era) err(rel, "R3 缺 era 字段");
  else if (!VALID_ERA.includes(fm.era)) err(rel, `R3 非法 era=${fm.era}`);
  if (!fm.last_verified) err(rel, "R3 缺 last_verified 字段");

  const inArchive = rel.includes("_archive/") || rel.startsWith("history/");
  const isNav = /(^|\/)(README|INDEX)\.md$/i.test(rel); // 导航门面豁免位置==状态
  if (fm.status && !isNav) {
    if (inArchive && !ARCHIVE_OK.includes(fm.status))
      err(rel, `R1 位置==状态冲突: 归档区不应 status=${fm.status}`);
    if (!inArchive && !NON_ARCHIVE_OK.includes(fm.status))
      err(rel, `R1 位置==状态冲突: 非归档区不应 status=${fm.status}`);
  }

  if (fm.status === "superseded" || fm.status === "archived") {
    if (!fm.superseded_by) err(rel, `R2 status=${fm.status} 缺 superseded_by`);
    else {
      const target = resolve(dirname(abs), fm.superseded_by);
      if (!existsSync(target)) err(rel, `R2 superseded_by 目标不存在: ${fm.superseded_by}`);
    }
  }
}

// ---- R4：CLAUDE.md 内 docs/ 路径存在性 ----
const claudeMd = join(ROOT, "CLAUDE.md");
if (existsSync(claudeMd)) {
  const text = stripCode(readFileSync(claudeMd, "utf8"));
  const pathRe = /`(docs\/[^\s`)]+\.md)`/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(text))) {
    if (!existsSync(join(ROOT, m[1]))) err("CLAUDE.md", `R4 引用不存在路径: ${m[1]}`);
  }
}

// ---- R5：全仓 .md 相对链接断链 ----
for (const rel of allMd) {
  const abs = join(DOCS, rel);
  const text = stripCode(readFileSync(abs, "utf8"));
  const linkRe = /\]\(([^)]+\.md)(#[^)]*)?\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(text))) {
    let link = m[1].trim();
    if (link.startsWith("http") || link.startsWith("/")) continue; // 外链/绝对跳过
    const target = resolve(dirname(abs), link);
    if (!existsSync(target)) err(rel, `R5 断链: ${link}`);
  }
}

// ---- 输出 ----
if (errors.length === 0) {
  console.log(`✅ docs-lint 通过(${allMd.length} 个 md 文件,5 类规则)`);
  process.exit(0);
}
console.log(`✗ docs-lint 发现 ${errors.length} 个问题:\n`);
console.log(errors.map((e) => "  " + e).join("\n"));
process.exit(WARN_ONLY ? 0 : 1);
