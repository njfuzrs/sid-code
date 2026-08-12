#!/usr/bin/env bun
/**
 * B2/B3 探针 · 子代理 JIT 开关穿线 + 默认值单一事实源
 *
 * B2 的判据取 `buildBaseLoopConfig().discoverJitContext` 是否为 undefined ——
 * 那是 `runAgentLoop` 侧「是否触发 JIT」的唯一开关，所以它等价于端到端行为。
 *
 * B3 顺带静态扫一遍 `src/`：裸比较数必须是 0。
 * 用 `Bun.file().text()` 而非 shell `grep` —— `src/app.ts` 含 NUL 字节，
 * grep 会把它当二进制**静默跳过**，恰好在最该守的文件上失效。
 *
 * 跑法：bun scripts/probe/jit-boundary-b2b3.ts
 */

import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { isJitContextEnabled, JIT_CONTEXT_DEFAULT } from "@sid-code/core/config/jit-context.ts";

const stubProvider = {
  name: () => "mock",
  defaultModel: () => "mock-model",
  async *sendMessageStream() {},
} as any;

function discovererOf(jitContext?: boolean, withRegistry = true): unknown {
  const config = {
    provider: "mock",
    model: "mock-model",
    ...(jitContext === undefined ? {} : { jitContext }),
  } as any;
  const agent = new SubAgent(stubProvider, "mock-model", new ToolRegistry());
  if (withRegistry) (agent as any).registry = new ProviderRegistry(config);
  const ctxMgr = new ContextManager({ maxTokens: 200_000 });
  return (agent as any).buildBaseLoopConfig(ctxMgr, Date.now(), 60_000).discoverJitContext;
}

const b2: Array<[string, unknown, "有" | "无"]> = [
  ["jitContext: false        → 子代理", discovererOf(false), "无"],
  ["jitContext 未设置（默认） → 子代理", discovererOf(undefined), "有"],
  ["jitContext: true         → 子代理", discovererOf(true), "有"],
  ["registry 缺失            → 子代理", discovererOf(undefined, false), "有"],
];

console.log("=== B2 · 子代理 JIT 开关穿线 ===");
let failed = 0;
for (const [desc, got, expect] of b2) {
  const actual = typeof got === "function" ? "有" : "无";
  const ok = actual === expect;
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✘"} ${desc} discoverer=${actual}（期望${expect}）`);
}

// 运行时切换：共享引用约束（不得改成构造时快照）
const shared = { provider: "mock", model: "mock-model" } as any;
const reg = new ProviderRegistry(shared);
const before = reg.getJitContextEnabled();
shared.jitContext = false;
const after = reg.getJitContextEnabled();
const liveOk = before === true && after === false;
if (!liveOk) failed++;
console.log(
  `${liveOk ? "✔" : "✘"} registry 读共享引用，运行时切换即时生效（${before} → ${after}）`,
);

console.log("\n=== B3 · jitContext 默认值单一事实源 ===");
console.log(`JIT_CONTEXT_DEFAULT = ${JIT_CONTEXT_DEFAULT}`);
for (const [label, input, want] of [
  ["未设置", {}, true],
  ["true", { jitContext: true }, true],
  ["false", { jitContext: false }, false],
] as Array<[string, { jitContext?: boolean }, boolean]>) {
  const got = isJitContextEnabled(input);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "✔" : "✘"} isJitContextEnabled(${label}) = ${got}（期望 ${want}）`);
}

const files = await Array.fromAsync(new Bun.Glob("src/**/*.{ts,tsx}").scan("."));
const violations: string[] = [];
for (const f of files) {
  // 用 split/join 而非 replaceAll —— scripts/ 的 tsconfig lib 低于 es2021
  const normalized = f.split("\\").join("/");
  if (normalized.endsWith("src/config/jit-context.ts")) continue;
  const src = await Bun.file(f).text();
  if (!src.includes("jitContext")) continue;
  src.split("\n").forEach((line, i) => {
    if (/\.jitContext\s*[!=]==/.test(line) || /if\s*\([^)]*\.jitContext\s*\)/.test(line)) {
      violations.push(`${normalized}:${i + 1}  ${line.trim()}`);
    }
  });
}
if (violations.length > 0) failed++;
console.log(
  `${violations.length === 0 ? "✔" : "✘"} src/ 裸比较数 = ${violations.length}（扫 ${files.length} 个文件）`,
);
for (const v of violations) console.log(`    ${v}`);

console.log(`\n未达期望：${failed}`);
process.exit(failed === 0 ? 0 : 1);
