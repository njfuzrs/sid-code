#!/usr/bin/env bun
/**
 * verify-doc-claims —— 跨仓校验：docs-research 文档里引用的代码常量是否与源码一致。
 *
 * ## 为什么必须跨仓
 *
 * 漂移的文档在 docs-research，事实在 sid-code。《AgenticLoop 从零到一》§2 一次核出 9 条
 * 漂移，全是「文档手写代码事实」的必然产物；只在一侧加的门禁拦不住另一侧。
 *
 * ## 校验什么（只校验能机械判定的）
 *
 * 1. 文档里形如 `MAX_EMPTY_PARAM_RETRIES = 3` / `MAX_CTX_WINDOW_RECOVERIES=2` 的常量声明，
 *    与源码 `(export) const NAME = <数字>` 比对。源码里找不到的名字（如引用 CC 的常量）跳过；
 *    同名常量在源码里有多个不同值时视为歧义，也跳过——不猜。
 * 2. 文档里 `grep -c 'kind: "done"' ...loop.ts` 之后的 `# → N`：N 不得低于 20。
 *    不做等值：出口数会正常演进（22 → 28），等值只会逼人改数字（见 doc-claim-consistency.test.ts）。
 *
 * ## 用法
 *
 *   bun run scripts/verify-doc-claims.ts <文档路径>...
 *   DOCS_RESEARCH_ROOT=~/Code/person/docs-research bun run scripts/verify-doc-claims.ts   # 默认清单
 *   加 --json 输出机器可读结果
 *
 * exit 0 = 无漂移；exit 1 = 有漂移（逐条打印）；exit 2 = 用法错误 / 文档不存在。
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** 未传路径时校验的默认清单（相对 DOCS_RESEARCH_ROOT） */
export const DEFAULT_DOCS = [
  "sid-code/summary/01-AgenticLoop/10-AgenticLoop从零到一-小白到深入.md",
];

/** done 出口数下限：文档写「20+」的那个事实 */
export const DONE_EXIT_FLOOR = 20;

export interface Drift {
  doc: string;
  line: number;
  kind: "constant" | "done_exit_count";
  claim: string;
  actual: string;
}

function walkTs(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTs(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
}

/** 源码里所有 `(export) const MAX_/MIN_xxx = <数字>;`。同名多值 → null（歧义） */
export function collectSourceConstants(root = REPO_ROOT): Map<string, number | null> {
  const files: string[] = [];
  const pkgs = join(root, "packages");
  for (const pkg of readdirSync(pkgs)) {
    const src = join(pkgs, pkg, "src");
    if (existsSync(src)) walkTs(src, files);
  }
  const out = new Map<string, number | null>();
  const re =
    /^(?:export\s+)?const\s+((?:MAX|MIN)_[A-Z0-9_]+)\s*(?::\s*number\s*)?=\s*([\d_]+)\s*;/gm;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(re)) {
      const v = Number(m[2]!.replace(/_/g, ""));
      const prev = out.get(m[1]!);
      out.set(m[1]!, prev === undefined || prev === v ? v : null);
    }
  }
  return out;
}

export function countDoneExits(root = REPO_ROOT): number {
  const src = readFileSync(join(root, "packages/core/src/query/loop.ts"), "utf8");
  return (src.match(/kind: "done"/g) ?? []).length;
}

export function checkDoc(
  docPath: string,
  text: string,
  constants: Map<string, number | null>,
): Drift[] {
  const drifts: Drift[] = [];
  const lines = text.split("\n");
  const constRe = /\b((?:MAX|MIN)_[A-Z0-9_]+)\s*=\s*([\d_]+)\b/g;
  let afterDoneGrep = false;
  lines.forEach((line, i) => {
    for (const m of line.matchAll(constRe)) {
      const actual = constants.get(m[1]!);
      if (actual === undefined || actual === null) continue;
      const claimed = Number(m[2]!.replace(/_/g, ""));
      if (claimed !== actual) {
        drifts.push({
          doc: docPath,
          line: i + 1,
          kind: "constant",
          claim: `${m[1]} = ${m[2]}`,
          actual: `${m[1]} = ${actual}`,
        });
      }
    }
    if (/grep -c 'kind: "done"'/.test(line)) {
      afterDoneGrep = true;
      return;
    }
    if (afterDoneGrep) {
      const n = /#\s*→\s*(\d+)/.exec(line);
      if (n) {
        afterDoneGrep = false;
        if (Number(n[1]) < DONE_EXIT_FLOOR) {
          drifts.push({
            doc: docPath,
            line: i + 1,
            kind: "done_exit_count",
            claim: `→ ${n[1]}`,
            actual: `应 ≥ ${DONE_EXIT_FLOOR}（当前 ${countDoneExits()}）`,
          });
        }
      } else if (line.trim() === "```") {
        afterDoneGrep = false;
      }
    }
  });
  return drifts;
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  let docs = argv.filter((a) => !a.startsWith("--"));
  if (docs.length === 0) {
    const root = process.env.DOCS_RESEARCH_ROOT;
    if (!root) {
      console.error("用法：verify-doc-claims.ts <文档>...，或设置 DOCS_RESEARCH_ROOT 校验默认清单");
      return 2;
    }
    docs = DEFAULT_DOCS.map((d) => join(root, d));
  }
  const constants = collectSourceConstants();
  const drifts: Drift[] = [];
  for (const d of docs) {
    if (!existsSync(d)) {
      console.error(`文档不存在：${d}`);
      return 2;
    }
    drifts.push(...checkDoc(d, readFileSync(d, "utf8"), constants));
  }
  if (json) {
    console.log(JSON.stringify({ docs, drifts }, null, 2));
  } else if (drifts.length === 0) {
    console.log(`✓ ${docs.length} 份文档的代码常量引用与源码一致`);
  } else {
    console.log(`✗ ${drifts.length} 处漂移：`);
    for (const d of drifts)
      console.log(`  ${d.doc}:${d.line}  文档「${d.claim}」 ≠ 源码「${d.actual}」`);
  }
  return drifts.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
