#!/usr/bin/env bun
/**
 * verify-agent-note —— 校验 Agent Note 的**形态**，不校验内容。
 *
 * ## 这道门禁存在的理由
 *
 * 防方向漂移的载体必须能进 review、能随 PR 走。CLAUDE.md 与 Claude 的记忆目录都不满足：
 * 前者不随改动走，后者只有一个 harness、一台机器读得到。所以决策记录进 `.agents/notes/`。
 *
 * 但一个只靠约定的目录会在两三个月内退化成垃圾场：lifecycle 拼错、class 自由发明、
 * 三段结构缺一段、Status 头与所在目录互相矛盾（`rejected/` 里躺着 `Status: implemented`）。
 * 到那时它既不能被机器统计，也不值得人读。这个脚本只做一件事：**让这类退化进不了仓库**。
 *
 * ## 为什么只校验形态
 *
 * 内容只有人能审。校验器拦不住「把内部重构写成用户特性」，也拦不住「漏掉真实的破坏性
 * 变更」——这与本仓 changelog curated 的哲学完全一致（"必须人工过目才提交"，见 CLAUDE.md）。
 * 所以这里**刻意不做**：不查字数、不查论证是否充分、不查证据是否真实。
 * 试图用正则审内容只会得到一个自己定义、自己达标的数字。
 *
 * ## 用法
 *
 *   bun run scripts/verify-agent-note.ts            # 校验仓库里已追踪的全部 Note（门禁路径）
 *   bun run scripts/verify-agent-note.ts --dir <d>  # 校验任意目录（测试夹具用，不走 git）
 *   bun run scripts/verify-agent-note.ts --json     # 机器可读输出
 *
 * exit 0 = 全部合规；exit 1 = 有违规（逐条打印）。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

/** lifecycle 闭集：提案 → 已落地 / 已否决。三格缺一不可，`rejected/` 是最有价值的一格。 */
export const LIFECYCLES = ["proposed", "implemented", "rejected"] as const;

/**
 * class 闭集（抄 DSH 的六类，实测足够覆盖本仓的决策类型）。
 *
 * ⚠️ 刻意是**闭集**而不是自由文本：一旦允许自由发明目录名，同一类决策会散成
 * `perf/` `performance/` `optimization/` 三个目录，此后既没法统计也没法检索。
 * 真要加一类，改这里 + 在 PR 里说明为什么现有六类装不下。
 */
export const CLASSES = [
  "feature",
  "architecture",
  "bug-fix",
  "simplification",
  "process",
  "testing",
] as const;

/**
 * 必需的三个二级标题，且**每段都必须非空**。
 *
 * 第三段对应 CLAUDE.md 收尾自检第 2 问，是这份格式里最重要的一段：
 * 「目标指标改善 + 测试全绿 + 机理讲得通」三者同时成立时结论仍可能是错的，
 * 所以必须写「跑了什么命令、看到什么输出」，而不是「机理上讲得通」。
 */
export const REQUIRED_SECTIONS = [
  "## 决定了什么",
  "## 放弃了什么",
  "## 拿什么证明它生效了",
] as const;

/** 路径形态：`.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-标题.md` */
const PATH_RE = /(?:^|\/)notes\/([^/]+)\/([^/]+)\/(\d{4}-\d{2}-\d{2})-([^/]+)\.md$/;

export interface Violation {
  file: string;
  reason: string;
}

/** 日期是否真实存在（拦 2026-02-31 这类形态合法但不存在的日期）。 */
function isRealDate(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 取某个二级标题下的正文（到下一个 `## ` 或文件末尾），用于判「非空」。
 *
 * 只校验形态那一节说过不查内容质量，但**空段落是形态问题不是内容问题**：
 * 一个只有三个标题、下面全空的 Note 满足"三段都在"却什么都没记录，
 * 正是这道门禁要拦的退化形态。
 */
function sectionBody(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const after = text.slice(start + heading.length);
  const next = after.search(/^## /m);
  const body = next < 0 ? after : after.slice(0, next);
  // 去掉纯注释行（`（…）`形式的格式提示不算内容）后判空。
  return body.replace(/^\s*[（(].*[)）]\s*$/gm, "").trim();
}

/** 校验单份 Note，返回它的违规列表（空数组 = 合规）。 */
export function checkNote(displayPath: string, text: string): Violation[] {
  const out: Violation[] = [];
  const push = (reason: string) => out.push({ file: displayPath, reason });

  const m = PATH_RE.exec(displayPath);
  if (!m) {
    push("路径必须是 {lifecycle}/{class}/yyyy-mm-dd-标题.md");
    return out; // 路径都不对，后面的 lifecycle 一致性校验无从谈起
  }
  const [, lifecycle, cls, date] = m;

  if (!(LIFECYCLES as readonly string[]).includes(lifecycle)) {
    push(`未知 lifecycle "${lifecycle}"（闭集：${LIFECYCLES.join("/")}）`);
  }
  if (!(CLASSES as readonly string[]).includes(cls)) {
    push(`未知 class "${cls}"（闭集：${CLASSES.join("/")}）`);
  }
  if (!isRealDate(date)) {
    push(`文件名日期 "${date}" 不是真实日期`);
  }

  // ---- frontmatter：Status + Date ----
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) {
    push("缺 frontmatter（首行必须是 `---`，块内含 Status 与 Date）");
  } else {
    const status = /^Status: *(\S+) *$/m.exec(fm[1])?.[1];
    const fmDate = /^Date: *(\S+) *$/m.exec(fm[1])?.[1];

    if (!status) {
      push("frontmatter 缺 `Status:`");
    } else if (!(LIFECYCLES as readonly string[]).includes(status)) {
      push(`Status "${status}" 不在枚举内（${LIFECYCLES.join("/")}）`);
    } else if (status !== lifecycle) {
      // 这一条是对 C-6 原型的补强：目录与 Status 不一致时，两个都可能是对的，
      // 但读者会得到相反结论 —— 一份声称 implemented 却躺在 rejected/ 的 Note
      // 比没有 Note 更坏，因为它会让人以为某个方案已落地。
      push(`Status "${status}" 与所在 lifecycle 目录 "${lifecycle}" 不一致`);
    }

    if (!fmDate) {
      push("frontmatter 缺 `Date:`");
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(fmDate) || !isRealDate(fmDate)) {
      push(`Date "${fmDate}" 不是合法的 yyyy-mm-dd`);
    } else if (fmDate !== date) {
      push(`Date "${fmDate}" 与文件名日期 "${date}" 不一致`);
    }
  }

  // ---- 标题 ----
  if (!/^# \S/m.test(text)) push("缺一级标题（`# <标题>`）");

  // ---- 三段结构，且每段非空 ----
  for (const s of REQUIRED_SECTIONS) {
    if (!text.includes(s)) {
      push(`缺章节 "${s}"`);
    } else if (sectionBody(text, s) === "") {
      push(`章节 "${s}" 是空的`);
    }
  }

  return out;
}

/** 递归收集目录下的 .md（`--dir` 模式；不走 git，供测试夹具用）。 */
function walkMarkdown(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkMarkdown(p, acc);
    else if (e.endsWith(".md")) acc.push(p);
  }
  return acc;
}

/** 门禁路径：只看**已追踪**的文件 —— 未 add 的草稿不该拦住别人的提交。 */
function trackedNotes(root: string): string[] {
  const r = spawnSync("git", ["ls-files", ".agents/notes/"], { cwd: root, encoding: "utf8" });
  return (r.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((f) => f.endsWith(".md"));
}

/** README / 模板不是 Note 本体，不参与形态校验。 */
function isNotANote(displayPath: string): boolean {
  const base = displayPath.split("/").pop() ?? "";
  return base === "README.md" || base.startsWith("_");
}

function main(): void {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const dirIdx = argv.indexOf("--dir");
  const root = new URL("..", import.meta.url).pathname;

  let files: string[];
  let toDisplay: (f: string) => string;

  if (dirIdx >= 0) {
    const dir = argv[dirIdx + 1];
    if (!dir) {
      console.error("--dir 需要一个目录参数");
      process.exit(2);
    }
    files = walkMarkdown(dir);
    // 夹具目录里也用 notes/ 相对路径展示，让 PATH_RE 的锚点一致。
    toDisplay = (f) => relative(dir, f);
  } else {
    files = trackedNotes(root);
    toDisplay = (f) => f;
  }

  const violations: Violation[] = [];
  let checked = 0;
  for (const f of files) {
    const display = toDisplay(f);
    if (isNotANote(display)) continue;
    checked += 1;
    const abs = dirIdx >= 0 ? f : join(root, f);
    violations.push(...checkNote(display, readFileSync(abs, "utf8")));
  }

  if (asJson) {
    console.log(JSON.stringify({ checked, violations }, null, 2));
  }

  if (violations.length > 0) {
    if (!asJson) {
      console.error("verify-agent-note 失败：\n");
      for (const v of violations) console.error(`  ${v.file}: ${v.reason}`);
      console.error("\n格式见 .agents/notes/README.md。这道门禁只查形态 —— 内容仍须人工过目。");
    }
    process.exit(1);
  }

  if (!asJson) console.log(`verify-agent-note: ${checked} 份 Agent Note 形态合规。`);
}

// 直接执行时才跑主流程；被测试 import 时只取纯函数。
if (import.meta.main) main();
