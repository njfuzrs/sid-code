#!/usr/bin/env bun
/**
 * B1 人工核对辅助 · 本仓库真实规则文件里的 `@` 提取结果
 *
 * 方案 §4.5 要求的那一步「只能人看」的事：测试能证明函数行为，
 * 不能证明「这个仓库的规则文件里没有被新规则误伤的写法」。
 * 这个脚本把「要人看的东西」列出来，人看的是**清单**而不是几千行文件。
 *
 * 输出分两栏：能解析到真实文件的（真导入）、解析不到的（prose 里的 `@`，会留一行告警）。
 * 判据：**「解析不到」不等于回归** —— 大部分 `@` 本来就是 prose（`@import` 字样、
 * `@Component` 装饰器、`@jrichman/ink` 包名）。要看的是有没有**该导入却没导入**的。
 *
 * 跑法：bun scripts/probe/jit-boundary-real-rules.ts
 */

import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { processImports } from "@sid-code/core/config/import-processor.ts";

const REPO = resolve(import.meta.dir, "../..");
const FILES = [
  "CLAUDE.md",
  "packages/cli/src/ui/CLAUDE.md",
  ...(await Array.fromAsync(new Bun.Glob("**/CLAUDE.md").scan({ cwd: REPO, onlyFiles: true }))),
];
const uniq = [...new Set(FILES)].filter(
  (f) => !f.includes("node_modules") && !f.includes(".claude/worktrees"),
);

let resolved = 0;
let unresolved = 0;

for (const rel of uniq) {
  const abs = resolve(REPO, rel);
  if (!existsSync(abs)) continue;
  const text = await Bun.file(abs).text();
  // 逐行过一遍生产入口，收集展开标记 —— 标记里写的就是提取出的 importPath
  const out = await processImports(text, abs, {
    allowedDirectories: [REPO],
    projectRoot: REPO,
    // 只看提取结果，不真的展开进内容（存在的文件仍会被读，可接受）
  });
  const marks = [...out.matchAll(/<!-- @import (.+?) -->/g)].map((m) => m[1]);

  // 再单独把「提取到但没展开」的捞出来：processImports 对不存在的路径只留日志，
  // 所以这里重跑一遍提取逻辑的可观测代理 —— 按行找 @token 再自己判存在性。
  const lines = text.split("\n");
  const suspects: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```+|~~~+)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*<!--/.test(line)) continue;
    const noCode = line.replace(/`[^`]*`/g, " ");
    for (const m of noCode.matchAll(/(?:^|[\s，。、；：！？（）【】「」『』〈〉《》〔〕“”‘’…—～·])@([^\s，。、；：！？（）【】「」『』〈〉《》〔〕“”‘’…—～·]+)/g)) {
      let p = m[1];
      const h = p.indexOf("#");
      if (h !== -1) p = p.slice(0, h);
      p = p.replace(/[.,;:)\]!?]+$/g, "");
      if (!p) continue;
      const target = resolve(dirname(abs), p);
      if (!existsSync(target) && !marks.includes(p)) suspects.push(p);
    }
  }

  if (marks.length === 0 && suspects.length === 0) continue;
  console.log(`\n── ${rel} ──`);
  for (const m of marks) {
    resolved++;
    console.log(`  ✔ 真导入（已展开）      ${m}`);
  }
  for (const s of [...new Set(suspects)]) {
    unresolved++;
    console.log(`  ·  prose/不存在（留告警） ${s}`);
  }
}

console.log(`\n合计：真导入 ${resolved} 处，prose/不存在 ${unresolved} 处`);
console.log(
  "判据：prose 那栏不是回归 —— 需人工确认的只有「该导入却出现在 prose 栏」的条目。",
);
