#!/usr/bin/env bun
/**
 * 参考页生成器 —— 从源码生成 website/ref/ 下 6 页 + public/llms.txt。
 *
 * ⚠ 当前是占位实现（阶段 1 只建脚手架，生成逻辑排期在阶段 3）。
 * 完整设计见 docs/reference/官网与文档站设计方案.md §4.5，对应 TODO：
 *
 *   T-3.2   给 CLI 加隐藏出口 --dump-tools（运行时真值，与发给 LLM 的定义同源）
 *   T-3.3   本脚本主体：6 页 + llms.txt，用 <!-- AUTO-GEN:START/END --> 包裹
 *   T-3.4   ref/settings 走 SettingsSchema().shape + Config 接口补 passthrough 漏项
 *   T-3.4b  ref/cli 走 cli.ts parseArgs × help.ts 双源交叉对账
 *   T-3.5   --check 对账模式（干净退 0、漂移退 1），供 pre-commit 门禁调用
 *
 * 刻意留成显式占位而非不存在的文件：package.json 的 docs:gen-reference 已接线，
 * 缺文件会报 "Module not found" —— 那看起来像故障，而这里是"还没做"。
 */

const args = new Set(process.argv.slice(2));

console.log("docs-gen-reference: 尚未实现（阶段 3 · T-3.3）。");
console.log(
  "  website/ref/ 下 6 页当前是带 AUTO-GEN 标记的骨架，标记内为占位文本。",
);
if (args.has("--check")) {
  console.log("  --check 对账模式同样待实现（T-3.5），此处不做任何判定。");
}
console.log("  设计与验收标准：docs/reference/官网与文档站设计方案.md §4.5 / §9.2");
