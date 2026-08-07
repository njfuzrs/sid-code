#!/usr/bin/env bun
/**
 * B1 探针 · 中文标点吞 `@import`
 *
 * 用途：改动前后各跑一次，diff 输出。**唯一验收口径是「失效数」**，
 * 不是任何来自 `~/.sid-code/` 的绝对值（那是滚动窗口，跨窗口不可比，
 * 见方案 §5.1）。
 *
 * 判定方式：造 fixture（真实存在的 `NOTE.md`），过**生产函数** `processImports`，
 * 检查正文有没有被展开（出现 `<!-- @import ... -->` 标记块 + NOTE 正文）。
 * 直接测 `extractImportsFromLine` 是不够的 —— 它不是导出函数，且证明不了端到端接线。
 *
 * 跑法：bun scripts/probe/jit-boundary-b1.ts
 */

import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { processImports } from "../../src/config/import-processor.ts";

const NOTE_BODY = "NOTE_BODY_SENTINEL_7f3a";

const root = mkdtempSync(join(tmpdir(), "jit-b1-"));
writeFileSync(join(root, "NOTE.md"), NOTE_BODY);
mkdirSync(join(root, "文档"), { recursive: true });
writeFileSync(join(root, "文档", "说明.md"), NOTE_BODY);
writeFileSync(join(root, "a.b.md"), NOTE_BODY);

/** [描述, 行文本, 是否期望展开] */
const CASES: Array<[string, string, boolean]> = [
  // ── 方案 §2.1 实测的 8 种形态 ──
  ["英文逗号+后续", "see @NOTE.md, then go", true],
  ["中文逗号句末", "详见 @NOTE.md，", true],
  ["中文逗号+后续", "见 @NOTE.md，然后继续", true],
  ["中文句号+后续", "见 @NOTE.md。然后继续", true],
  ["括号+句号+强调", "（已脱离 @NOTE.md）。**后续", true],
  ["中文顿号+后续", "见 @NOTE.md、以及别的", true],
  ["全角引号包裹", "见「@NOTE.md」后续", true],
  ["感叹号+后续", "见 @NOTE.md！后续", true],
  // ── 顺带修的两条 ──
  ["#fragment 剥离", "见 @NOTE.md#标题 后续", true],
  ["纯中文路径（不可照抄 CC 白名单的哨兵）", "见 @文档/说明.md，后续", true],
  ["路径含点（事后剥离不可过度贪婪的哨兵）", "见 @a.b.md，后续", true],
  // ── 回归：不得误抓 ──
  ["回归·邮箱不误抓", "a@NOTE.md 邮箱形态", false],
  ["回归·行内代码不误抓", "见 `@NOTE.md` 行内代码", false],
];

let failed = 0;
const lines: string[] = [];
for (const [desc, line, shouldExpand] of CASES) {
  const out = await processImports(line, join(root, "CLAUDE.md"), {
    allowedDirectories: [root],
    projectRoot: root,
  });
  const expanded = out.includes(NOTE_BODY);
  const ok = expanded === shouldExpand;
  if (!ok) failed++;
  lines.push(
    `${ok ? "✔" : "✘"}  ${desc.padEnd(38)} 期望${shouldExpand ? "展开" : "不展开"} 实际${expanded ? "展开" : "不展开"}   ${JSON.stringify(line)}`,
  );
}

console.log("=== B1 · 中文标点吞 @import ===");
console.log(lines.join("\n"));
console.log(`\n失效数：${failed} / ${CASES.length}`);
process.exit(failed === 0 ? 0 : 1);
