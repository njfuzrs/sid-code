#!/usr/bin/env bun
/**
 * B5 探针 · 子目录规则改盘后的 mtime 兜底（**回归哨兵，不是待修项**）
 *
 * B5 在方案里被裁定为「不是缺口，是设计取舍」：`watchCLAUDEmd` 只监听项目根 / 全局 /
 * 企业三个文件 + `.claude/rules/` 目录，会话中途改**子目录** `CLAUDE.md` 不会即时重建；
 * 但 mtime 兜底让「下次触达时读到新内容」成立，所以用户可感知的症状并不存在。
 * （对标：CC 根本不监听 CLAUDE.md，靠 `getMemoryFiles` 的 memoize + 9 处显式清缓存。）
 *
 * 它仍留在验收清单里当**回归哨兵** —— 它是 B1/B4 改动的下游，
 * 如果 mtime 兜底被意外破坏，这条会抓到。
 *
 * 两处协同是这条成立的原因，改它们之前先看这里：
 *   - `jit-context.ts` 的 `hasStaleOnChain` —— 目录级短路**让位于**新鲜度校验
 *   - `loadOne` 的 mtime+size 比对 —— 变了就重读并**替换**旧快照（不是叠加）
 *
 * 跑法：bun scripts/probe/jit-boundary-b5.ts
 */

import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JitContextManager } from "@sid-code/core/config/jit-context.ts";

const V1 = "RULE_VERSION_ONE_a11c";
const V2 = "RULE_VERSION_TWO_b22d";

const root = mkdtempSync(join(tmpdir(), "jit-b5-"));
mkdirSync(join(root, "src", "ui"), { recursive: true });
writeFileSync(join(root, "CLAUDE.md"), "# 根规则\n");
const subRule = join(root, "src", "ui", "CLAUDE.md");
writeFileSync(subRule, `# 子目录规则\n${V1}\n`);
const target = join(root, "src", "ui", "Footer.tsx");
writeFileSync(target, "export const Footer = () => null;\n");

const mgr = new JitContextManager();

const first = await mgr.discoverDetailed(target, root);
const firstBlocks = mgr.getLoadedBlocks().join("\n");
console.log("=== B5 · mtime 兜底回归哨兵 ===");
console.log(
  `① 首次读 Footer.tsx      hit=${first.text !== null}  loaded=${first.loaded.length}  含V1=${firstBlocks.includes(V1)}  含V2=${firstBlocks.includes(V2)}`,
);

// 改盘：V1 → V2。显式把 mtime 推后 2s —— 同秒内改写在低精度 FS 上可能测不出差异，
// 那会让这个哨兵变成假绿（它要验的是「变了能发现」，不是「碰巧发现了」）。
writeFileSync(subRule, `# 子目录规则\n${V2}\n`);
const future = new Date(Date.now() + 2000);
utimesSync(subRule, future, future);

const second = await mgr.discoverDetailed(target, root);
const secondBlocks = mgr.getLoadedBlocks().join("\n");
console.log(
  `② 改规则后再读同一文件    hit=${second.text !== null}  loaded=${second.loaded.length}  含V1=${secondBlocks.includes(V1)}  含V2=${secondBlocks.includes(V2)}`,
);

const ok =
  first.text !== null &&
  firstBlocks.includes(V1) &&
  second.text !== null &&
  secondBlocks.includes(V2) &&
  !secondBlocks.includes(V1); // 必须是**替换**而非叠加

console.log(`\n${ok ? "✔ mtime 兜底生效（新内容替换旧快照）" : "✘ mtime 兜底失效 —— 这是回归"}`);
process.exit(ok ? 0 : 1);
