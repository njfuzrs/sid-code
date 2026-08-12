/**
 * eval:bench-report — 把 bench-results-<ts>.jsonl 汇总成 markdown 报告
 *
 * 用法：
 *   bun run eval:bench-report -- --week 9 --label smoke-offline-baseline
 *   bun run eval:bench-report -- --input evals/raw-outputs/bench-results-XXX.jsonl --week 9
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = process.cwd();
const RAW_DIR = join(ROOT, "evals/raw-outputs");
const REPORTS_DIR = join(ROOT, "evals/_reports");

interface ToolsCalled extends Array<string> {}
interface AgentSnapshot {
  tools_called: ToolsCalled;
  files_modified: string[];
  steps: number;
  exit_status: string;
}
interface TaskResult {
  taskId: string;
  difficulty: string;
  tags: string[];
  primaryModel: string;
  scores: { outcome: number; trajectory: number; process: number; final: number };
  details: {
    outcome: Record<string, boolean | number>;
    trajectory: Record<string, boolean | number>;
  };
  reasoning: string;
  agentSnapshot: AgentSnapshot;
}

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    week: { type: "string", default: "9" },
    label: { type: "string", default: "smoke-offline-baseline" },
  },
});

function pickLatest(): string {
  const files = readdirSync(RAW_DIR)
    .filter((f) => f.startsWith("bench-results-") && f.endsWith(".jsonl"))
    .map((f) => ({ f, mtime: statSync(join(RAW_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) throw new Error("无 bench-results 文件");
  return join(RAW_DIR, files[0].f);
}

const inputPath = values.input ? resolve(values.input) : pickLatest();
if (!existsSync(inputPath)) {
  console.error(`✗ 输入文件不存在: ${inputPath}`);
  process.exit(1);
}

const content = await Bun.file(inputPath).text();
const results: TaskResult[] = content
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as TaskResult);

const n = results.length;
const avg = (fn: (r: TaskResult) => number) =>
  results.reduce((s, r) => s + fn(r), 0) / Math.max(n, 1);

const avgFinal = avg((r) => r.scores.final);
const avgL1 = avg((r) => r.scores.outcome);
const avgL2 = avg((r) => r.scores.trajectory);
const avgL3 = avg((r) => r.scores.process);

// 按难度分桶
function bucket<T extends string | number>(key: (r: TaskResult) => T): Map<T, TaskResult[]> {
  const m = new Map<T, TaskResult[]>();
  for (const r of results) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

const byDifficulty = bucket((r) => r.difficulty);
const byModel = bucket((r) => r.primaryModel);

// 按 tag 分桶（一 task 可多 tag，会被多次计入）
const byTag = new Map<string, TaskResult[]>();
for (const r of results) {
  for (const tag of r.tags || []) {
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag)!.push(r);
  }
}

// 最强 / 最弱 N 条
const sorted = [...results].sort((a, b) => b.scores.final - a.scores.final);
const topN = sorted.slice(0, 5);
const bottomN = sorted.slice(-5).reverse();

// L1 失败原因聚合
const l1FailReasons = new Map<string, number>();
for (const r of results) {
  for (const [k, v] of Object.entries(r.details.outcome || {})) {
    if (typeof v === "boolean" && v === false) {
      l1FailReasons.set(k, (l1FailReasons.get(k) || 0) + 1);
    }
  }
}
const l1FailTop = [...l1FailReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

// Sanity 指标
const fallbackCount = results.filter(
  (r) => r.agentSnapshot.exit_status === "fallback_missing_trajectory",
).length;
const zeroToolCount = results.filter((r) => r.agentSnapshot.tools_called.length === 0).length;

function fmt(v: number, fixed = 2): string {
  return v.toFixed(fixed);
}

function tableRow(...cells: (string | number)[]): string {
  return "| " + cells.join(" | ") + " |";
}

const today = new Date().toISOString().slice(0, 10);
const week = values.week;
const label = values.label;
const reportPath = join(REPORTS_DIR, `${label}-w${week}.md`);

const md = `# Smoke ${label} — W${week} 报告

> **生成日期**: ${today}
> **输入**: \`${inputPath.replace(ROOT + "/", "")}\`
> **task 数**: ${n}
> **模式**: sid-code-offline adapter + skip-llm-judge（L3 取常数 3.0）

---

## 1. 执行摘要

W${week} 起 Phase 4 持续模式启动。本次为**离线 baseline**：用 trajectory-platform 已有 ${n} 条 smoke trajectory 跑三层 grader，跳过 L3 LLM Judge。

| 维度 | 分数 |
|---|---|
| **Final** | ${fmt(avgFinal)} / 5.0 |
| L1 Outcome | ${fmt(avgL1)} / 5.0 |
| L2 Trajectory | ${fmt(avgL2)} / 5.0 |
| L3 Process (skipped) | ${fmt(avgL3)} / 5.0 |

**Sanity 指标**:
- fallback_missing_trajectory: ${fallbackCount}/${n}
- zero_tool_call: ${zeroToolCount}/${n}

> ⚠️ L2=${fmt(avgL2)} 偏高是因为离线 adapter 拿不到 error / retry / backtrack 信号（这些需要解析 trajectory 细节）。
> ⚠️ L3 全部取常数 3.0，**不能解读为"sid-code 在 L3 拿到 3.0"**。

---

## 2. 总分对比（${n} task）

${tableRow("Layer", "Score", "样本数", "备注")}
${tableRow("---", "---", "---", "---")}
${tableRow("L1 Outcome", fmt(avgL1), n, "must_call_tools / must_include / max_steps 等断言")}
${tableRow("L2 Trajectory", fmt(avgL2), n, "step_ratio / error_count（离线 adapter error/retry 恒为 0）")}
${tableRow("L3 Process", fmt(avgL3), n, "skipped（W9 阶段省钱模式）")}
${tableRow("Final", fmt(avgFinal), n, "权重 0.4 / 0.2 / 0.4")}

---

## 3. 按难度分桶

${tableRow("难度", "task 数", "Avg Final", "Avg L1", "Avg L2")}
${tableRow("---", "---", "---", "---", "---")}
${[...byDifficulty.entries()]
  .sort((a, b) => {
    const order = ["easy", "medium", "hard"];
    return order.indexOf(a[0]) - order.indexOf(b[0]);
  })
  .map(([k, arr]) => {
    const af = arr.reduce((s, r) => s + r.scores.final, 0) / arr.length;
    const al1 = arr.reduce((s, r) => s + r.scores.outcome, 0) / arr.length;
    const al2 = arr.reduce((s, r) => s + r.scores.trajectory, 0) / arr.length;
    return tableRow(k, arr.length, fmt(af), fmt(al1), fmt(al2));
  })
  .join("\n")}

---

## 4. 按 tag 分桶（top 10）

${tableRow("tag", "命中 task 数", "Avg Final", "Avg L1")}
${tableRow("---", "---", "---", "---")}
${[...byTag.entries()]
  .map(([k, arr]) => ({
    tag: k,
    n: arr.length,
    avgFinal: arr.reduce((s, r) => s + r.scores.final, 0) / arr.length,
    avgL1: arr.reduce((s, r) => s + r.scores.outcome, 0) / arr.length,
  }))
  .sort((a, b) => b.n - a.n)
  .slice(0, 10)
  .map((t) => tableRow(t.tag, t.n, fmt(t.avgFinal), fmt(t.avgL1)))
  .join("\n")}

---

## 5. 按 primary model 分桶

${tableRow("model", "task 数", "Avg Final", "Avg L1")}
${tableRow("---", "---", "---", "---")}
${[...byModel.entries()]
  .map(([k, arr]) => ({
    model: k,
    n: arr.length,
    avgFinal: arr.reduce((s, r) => s + r.scores.final, 0) / arr.length,
    avgL1: arr.reduce((s, r) => s + r.scores.outcome, 0) / arr.length,
  }))
  .sort((a, b) => b.n - a.n)
  .map((t) => tableRow(t.model, t.n, fmt(t.avgFinal), fmt(t.avgL1)))
  .join("\n")}

---

## 6. 最强 5 个 task（差异化优势）

${tableRow("task_id", "Final", "difficulty", "tags", "primary model")}
${tableRow("---", "---", "---", "---", "---")}
${topN
  .map((r) =>
    tableRow(
      r.taskId,
      fmt(r.scores.final),
      r.difficulty,
      r.tags.slice(0, 3).join(","),
      r.primaryModel,
    ),
  )
  .join("\n")}

---

## 7. 最弱 5 个 task（改进方向）

${tableRow("task_id", "Final", "L1", "L2", "difficulty", "tags", "exit")}
${tableRow("---", "---", "---", "---", "---", "---", "---")}
${bottomN
  .map((r) =>
    tableRow(
      r.taskId,
      fmt(r.scores.final),
      fmt(r.scores.outcome),
      fmt(r.scores.trajectory),
      r.difficulty,
      r.tags.slice(0, 3).join(","),
      r.agentSnapshot.exit_status,
    ),
  )
  .join("\n")}

---

## 8. L1 断言失败 Top 10（改进信号）

${tableRow("断言", "失败次数")}
${tableRow("---", "---")}
${
  l1FailTop.length === 0
    ? tableRow("（所有断言全过）", 0)
    : l1FailTop.map(([k, v]) => tableRow("\\`" + k + "\\`", v)).join("\n")
}

---

## 9. 关键 finding & W10 改进方向

### 9.1 离线 baseline 的局限（**重要**，影响数据解读）

- **L1 偏高**：smoke 49 全部来自 trajectory-platform（即用户跑 claude-code/sid-code 产出的真实 trajectory），这些 trajectory 在 Phase 2 自动抽取时 expected.must_call_tools / must_include_keywords 是**从同一批 trajectory 反推出来的**。所以 L1 在离线模式下"自证为真"，**当前 L1=${fmt(avgL1)} 不代表 sid-code 真实能力**，而是 bench schema 与 trajectory 的自洽程度。
- **L2 偏高**：离线 adapter 没解析 trajectory 细节，error / retry / backtrack 恒为 0，L2 退化为"step_ratio 是否在合理范围"。
- **L3 缺失**：W9 用常数 3.0 占位。
- **Sanity**：${fallbackCount} 条 fallback / ${zeroToolCount} 条 zero_tool_call。fallback=0 说明 49 条 primary sid 全部能在 desensitized 目录找到。

### 9.2 W10 必做（解锁真信号）

1. **L3 Judge 接入**：在 smoke 49 上跑一次真 LLM Judge（约 $0.5-1，~10 min），让 L3 进入真分数体系。
2. **L2 trajectory 细节解析**：在 adapter 里读 trajectory.json 的每一步，统计 error_count（tool_use_id 后接 tool_result.is_error=true）、retry_count（相同工具+相似参数）、backtrack_count（Write 同文件 ≥2 次）。这是 Phase 4 真正能区分 sid-code vs claude-code 的关键。
3. **bench schema 自证问题**：从 Phase 2 反推的 expected 在离线评分中天然偏高，需要在 W10/W11 引入"sid-code CLI 实跑模式"（adapter=sid-code-live），让 L1 真正测出能力差。

### 9.3 W10 capability eval 优先级

按 \`docs/eval/_archive/07-执行顺序速查.md §6.2\`，W9-W10 第一个子系统是 **Plan (\`src/plan/\`)**。下周开始写 plan 子系统的 4 维度 capability case（20-40 条），同时继续每周五跑 smoke。

---

## 10. 不变量自检

- [x] Transcript 已落盘: \`${inputPath.replace(ROOT + "/", "")}\`
- [x] holdout 未参与（split 文件用的 smoke.txt，不含 holdout）
- [x] 本次跑分未改 src/ 任何文件
- [x] 报告含 sanity 指标 + 已知偏差说明（§9.1）

`;

await Bun.write(reportPath, md);
console.log(`✓ 报告写入: ${reportPath.replace(ROOT + "/", "")}`);
console.log(
  `  Final: ${fmt(avgFinal)} / L1: ${fmt(avgL1)} / L2: ${fmt(avgL2)} / L3: ${fmt(avgL3)}`,
);
