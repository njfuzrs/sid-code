#!/usr/bin/env bun
/**
 * 探针辅助 · 从一份 events.jsonl 里摘出 `jit_context` 事件
 *
 * 用于端到端验收（方案 §5.3/§5.4）：受控 fixture 证明函数对了，
 * 这个证明**接线**对了 —— 真二进制跑完，埋点里到底有没有事件、source 是哪条通道。
 *
 * 跑法：bun scripts/probe/jit-events-dump.ts <events.jsonl 路径>
 */

export {}; // 使本文件成为 module（顶层 await 的前提）

const file = Bun.argv[2];
if (!file) {
  console.error("用法：bun scripts/probe/jit-events-dump.ts <events.jsonl>");
  process.exit(2);
}

const lines = (await Bun.file(file).text()).trim().split("\n");
const events = lines
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean) as Array<{ event: string; data?: Record<string, any> }>;

const jit = events.filter((e) => e.event === "jit_context");
const bySource = jit.reduce<Record<string, number>>((a, e) => {
  const s = String(e.data?.source ?? "unknown");
  a[s] = (a[s] || 0) + 1;
  return a;
}, {});

console.log(`总事件 ${events.length} 条，jit_context ${jit.length} 条`);
console.log(`通道分布：${JSON.stringify(bySource)}`);
for (const e of jit) {
  const d = e.data ?? {};
  // 事件里的字段名是 `path`（已相对化），不是 JitDiscovery 内部的 `relPath` ——
  // 落地时先写错过一次，打出一列 null。埋点字段名以 events.jsonl 实物为准。
  const loaded = (d.loaded ?? []).map((x: any) => x.path ?? x.relPath);
  console.log(
    `  source=${d.source} hit=${d.hit} path=${d.accessed_path} loaded=${JSON.stringify(loaded)}`,
  );
}

// 顺带列出工具调用名，便于确认模型真的跑了预期的那条命令
const toolNames = events
  .filter((e) => e.event === "tool_call" || e.event === "tool_result")
  .map((e) => e.data?.tool ?? e.data?.name)
  .filter(Boolean);
if (toolNames.length) {
  console.log(`工具调用：${JSON.stringify([...new Set(toolNames)])}`);
}
