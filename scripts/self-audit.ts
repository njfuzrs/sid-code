#!/usr/bin/env bun
/**
 * self-audit —— 架构文档一致性检查（防"吃狗粮"优势退化）
 *
 * 背景（评估报告 §8.7 P3）：sid-code 分析自身代码时的竞争优势，来自 system-prompt /
 * CLAUDE.md 里内置的架构知识（五层洋葱、核心模块路径、工具执行器并发分区策略）——
 * 这让模型有"并发可能被降级成串行"这类怀疑方向。但这个优势是"隐式"的：它散落在文档和
 * 提示词里，没有任何机制保证它随代码演进被持续维护。一旦重构改了目录结构 / 改了并发分区
 * 逻辑而文档没跟上，模型拿到的就是过时地图，优势退化。
 *
 * 本脚本把这份"地图"变成可执行断言，定期核对三件事：
 *   1. 结构锚点：CLAUDE.md / 本脚本清单里提到的核心模块文件是否仍然存在
 *   2. 行为不变量：并发分区、成败观测、子代理 digest 这条故障链的关键代码是否还在
 *      （评估报告整条根因链的落地点——退化即等于事故防线失效）
 *   3. 提示词对齐:system-prompt 里对 sub_agent 只读并行的表述是否还与代码一致
 *
 * 纯静态检查：只读文件 + 正则断言，不跑构建、不联网、不改任何文件。
 *
 * 用法：
 *   bun scripts/self-audit.ts            # 人类可读报告，全通过 exit 0，有 FAIL exit 1
 *   bun scripts/self-audit.ts --json     # 机器可读（供 CI 消费）
 *
 * 集成建议：挂到 make build / CI 作为"架构文档一致性门禁"。exit 1 即代码与文档漂移，
 * 需要同步更新 CLAUDE.md / system-prompt 或修回行为不变量。
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根：本脚本在 <root>/scripts/ 下
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface CheckResult {
  id: string;
  category: "structure" | "invariant" | "prompt-alignment";
  ok: boolean;
  detail: string;
  /** 失败时给出的修复指引 */
  remedy?: string;
}

const results: CheckResult[] = [];

function record(r: CheckResult): void {
  results.push(r);
}

/** 读取仓库内文件（相对 REPO_ROOT）。不存在返回 null。 */
function readRepoFile(rel: string): string | null {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// ─────────────────────── 1. 结构锚点：核心模块必须存在 ───────────────────────

/**
 * 核心模块清单——五层洋葱架构里"吃狗粮"优势直接依赖的关键节点。
 * 这些路径出现在 system-prompt / CLAUDE.md / 评估报告根因链里，是模型定位问题的地图坐标。
 * 任一缺失（被重构挪走而文档未同步）都会让自诊断走空。
 */
const CORE_MODULES: Array<{ path: string; role: string }> = [
  { path: "packages/core/src/query/tool-executor.ts", role: "工具执行器：并发分区策略（isConcurrencySafe → 并行/串行）" },
  { path: "packages/core/src/agent/sub-agent.ts", role: "子代理执行引擎：超时/spawn/进程内三条路径" },
  { path: "packages/core/src/agent/tool.ts", role: "SubAgentTool：并发安全声明 + runSync/runAsync" },
  { path: "packages/core/src/agent/agent-definition.ts", role: "内置 agent 注册表：readOnly / timeout 按类型" },
  { path: "packages/core/src/trace/collector.ts", role: "可观测性采集：SubagentStart/Stop 事件落盘" },
  { path: "packages/core/src/trace/digest.ts", role: "轨迹嚼碎：子代理 section（串/并行 + 成败判定）" },
  { path: "packages/core/src/config/system-prompt.ts", role: "系统提示词：架构知识 + sub_agent 工具描述" },
  { path: "packages/core/src/query/loop.ts", role: "主循环 queryLoop：reminder 注入 + 压缩恢复" },
  { path: "packages/core/src/query/hypothesis-guide.ts", role: "假设纪律引导：调查性上下文检测" },
  { path: "CLAUDE.md", role: "最高指令：战略定位 + 五层架构 + 三组不变量" },
];

for (const m of CORE_MODULES) {
  const exists = existsSync(join(REPO_ROOT, m.path));
  record({
    id: `structure:${m.path}`,
    category: "structure",
    ok: exists,
    detail: exists ? `${m.path}（${m.role}）` : `核心模块缺失: ${m.path}`,
    remedy: exists
      ? undefined
      : `该文件被移动/删除。若是有意重构，请同步更新本脚本 CORE_MODULES、CLAUDE.md 与 system-prompt 里对该路径的引用。`,
  });
}

// ─────────────── 2. 行为不变量：评估报告根因链的关键代码还在吗 ───────────────

/**
 * 每条不变量 = 一个 (文件, 正则, 语义) 三元组。正则命中即认为该行为仍落地。
 * 这些正是评估报告 §8 整条故障链的修复落地点，退化任意一条都等于对应事故防线失效。
 */
const INVARIANTS: Array<{
  id: string;
  file: string;
  pattern: RegExp;
  semantic: string;
  remedy: string;
}> = [
  {
    id: "concurrency-partition",
    file: "packages/core/src/query/tool-executor.ts",
    pattern: /isConcurrencySafe/,
    semantic: "工具执行器仍按 isConcurrencySafe(input) 做并发分区（P0：修复子代理假并行真串行）",
    remedy: "并发分区逻辑被改动，只读子代理可能重新被串行执行。核对 tool-executor.ts 的 partition 段。",
  },
  {
    id: "subagent-concurrency-safe",
    file: "packages/core/src/agent/tool.ts",
    pattern: /isConcurrencySafe\s*\(\s*input/,
    semantic: "SubAgentTool 仍声明 isConcurrencySafe(input)，按类型 readOnly 决定可否并行",
    remedy: "SubAgentTool 不再声明 isConcurrencySafe → 回退到类级 readOnly()=false → 全部串行。补回该方法。",
  },
  {
    id: "runsync-iserror",
    file: "packages/core/src/agent/tool.ts",
    pattern: /isError:\s*!result\.success/,
    semantic: "runSync 成功路径按 result.success 设 isError（P0：TUI 区分子代理成败）",
    remedy: "runSync 正常路径不再设 isError，TUI 无法区分子代理成功/失败。补回 `isError: !result.success`。",
  },
  {
    id: "collector-stop-status",
    file: "packages/core/src/trace/collector.ts",
    pattern: /status:\s*stopInput\.success\s*===\s*true/,
    semantic: "SubagentStop 事件按 success 写 status（P0：消灭'全部 SUCCESS'误判的物理根因）",
    remedy: "SubagentStop 不再从 success 派生 status，events.jsonl 又变得无成败可读。补回 status 字段。",
  },
  {
    id: "digest-subagent-section",
    file: "packages/core/src/trace/digest.ts",
    pattern: /buildSubAgentSummary/,
    semantic: "trace-digest 仍构建子代理 section（P2 最高价值：自诊断数据无歧义）",
    remedy: "digest 不再产出子代理汇总，消费方需回 raw.jsonl 交叉验证。补回 buildSubAgentSummary。",
  },
  {
    id: "reactive-compact-anchor",
    file: "packages/core/src/query/reactive-compact.ts",
    pattern: /extractTaskContext|原始任务/,
    semantic: "响应式压缩仍保留原始任务锚点（P1：防压缩后模型丢失目标）",
    remedy: "reactive-compact 不再提取原始任务语义，压缩后可能目标跑偏。补回 extractTaskContext。",
  },
  {
    id: "explore-timeout-by-type",
    file: "packages/core/src/agent/agent-definition.ts",
    pattern: /readOnly:\s*true/,
    semantic: "内置 agent 仍按类型声明 readOnly（explore/plan/verify 只读可并行）",
    remedy: "只读 agent 不再声明 readOnly:true → isConcurrencySafe 判不出只读 → 被串行。核对 BUILTIN_AGENTS。",
  },
];

for (const inv of INVARIANTS) {
  const content = readRepoFile(inv.file);
  if (content === null) {
    record({
      id: `invariant:${inv.id}`,
      category: "invariant",
      ok: false,
      detail: `无法读取 ${inv.file}（不变量 ${inv.id} 无法核验）`,
      remedy: inv.remedy,
    });
    continue;
  }
  const ok = inv.pattern.test(content);
  record({
    id: `invariant:${inv.id}`,
    category: "invariant",
    ok,
    detail: ok ? inv.semantic : `不变量退化: ${inv.semantic}`,
    remedy: ok ? undefined : inv.remedy,
  });
}

// ─────────────── 3. 提示词对齐：system-prompt 的 sub_agent 表述 ───────────────

/**
 * system-prompt 里必须仍向模型说明"只读探查派 explore、要改文件派 task、验证派 verify"——
 * 这是模型正确选择子代理类型（进而命中并发分区只读路径）的前提。表述丢失 → 模型可能
 * 一律派 task（可写→串行），假并行真串行的老问题会以另一种形式回归。
 */
const promptContent = readRepoFile("packages/core/src/config/system-prompt.ts");
if (promptContent === null) {
  record({
    id: "prompt-alignment:sub-agent-desc",
    category: "prompt-alignment",
    ok: false,
    detail: "无法读取 packages/core/src/config/system-prompt.ts，提示词对齐无法核验",
    remedy: "确认 system-prompt.ts 是否被移动。",
  });
} else {
  const mentionsExplore = /explore/.test(promptContent) && /sub_agent/.test(promptContent);
  const mentionsTypeChoice = /只读.*explore|explore.*只读|type:\s*verify|派\s*explore/.test(promptContent);
  const ok = mentionsExplore && mentionsTypeChoice;
  record({
    id: "prompt-alignment:sub-agent-desc",
    category: "prompt-alignment",
    ok,
    detail: ok
      ? "system-prompt 仍说明子代理类型选择（只读派 explore / 改文件派 task / 验证派 verify）"
      : "system-prompt 里 sub_agent 类型选择表述缺失或弱化",
    remedy: ok
      ? undefined
      : "补回'只读探查派 explore、要改文件派 task、验证派 verify'的表述，否则模型可能一律派可写类型 → 串行。",
  });
}

// ─────────────────────────── 输出 ───────────────────────────

const failed = results.filter((r) => !r.ok);
const jsonMode = process.argv.includes("--json");

if (jsonMode) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: failed.length === 0,
        total: results.length,
        failed: failed.length,
        results,
      },
      null,
      2,
    ) + "\n",
  );
} else {
  const L: string[] = [];
  L.push("# self-audit —— 架构文档一致性检查");
  L.push("");
  const byCat: Record<CheckResult["category"], CheckResult[]> = {
    structure: [],
    invariant: [],
    "prompt-alignment": [],
  };
  for (const r of results) byCat[r.category].push(r);

  const catTitle: Record<CheckResult["category"], string> = {
    structure: "一、结构锚点（核心模块存在性）",
    invariant: "二、行为不变量（评估报告根因链落地点）",
    "prompt-alignment": "三、提示词对齐（sub_agent 类型选择表述）",
  };

  for (const cat of ["structure", "invariant", "prompt-alignment"] as const) {
    L.push(`## ${catTitle[cat]}`);
    L.push("");
    for (const r of byCat[cat]) {
      L.push(`  ${r.ok ? "✓" : "✗ FAIL"}  ${r.detail}`);
      if (!r.ok && r.remedy) L.push(`         ↳ 修复: ${r.remedy}`);
    }
    L.push("");
  }

  L.push("─".repeat(50));
  if (failed.length === 0) {
    L.push(`全部 ${results.length} 项通过：代码与架构文档一致，"吃狗粮"地图未漂移。`);
  } else {
    L.push(`${failed.length}/${results.length} 项失败：代码与架构文档已漂移，请按上述修复指引同步。`);
  }
  process.stdout.write(L.join("\n") + "\n");
}

process.exit(failed.length === 0 ? 0 : 1);
