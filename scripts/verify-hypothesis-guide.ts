#!/usr/bin/env bun
/**
 * verify-hypothesis-guide —— 假设纪律首轮引导的「离线词表验证」脚本
 *
 * 用最终版三层 detectInvestigationContext（packages/core/src/query/hypothesis-guide.ts）重跑本地
 * 历史会话的「首条用户原始输入」（metadata.user_prompts[0]），回答三个问题：
 *   1. 命中率：四象限分布 + 触发占比（对照文档第八章预估 ~17-18%）
 *   2. 漏判：高复杂度（traj 步数大）但未触发的会话 → 抽查是否真核查任务
 *   3. 误判：触发了但低复杂度（步数小）的会话 → 抽查是否误伤
 * 另关联 hypothesis_register 实际调用（从 trajectory[].action 提取），看「采纳率」。
 *
 * 关键设计：复用 src 里导出的 diagnoseInvestigationContext，绝不复制词表——
 * 否则脚本与生产逻辑漂移，验证结论失真。
 *
 * 数据源：~/.sid-code/trajectories/sessions/{id}/session.traj
 *   - metadata.user_prompts[0]：首条用户原始输入（= 检测函数 turnCount===1 时的输入）
 *   - trajectory[].action：字符串 "toolName({...})"，正则提工具名
 *   - trajectory.length：步数（复杂度代理指标）
 *
 * 用法：
 *   bun scripts/verify-hypothesis-guide.ts            # 人类可读报告
 *   bun scripts/verify-hypothesis-guide.ts --json     # 机器可读
 *   bun scripts/verify-hypothesis-guide.ts --samples N # 每类抽查样本数（默认 8）
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { diagnoseInvestigationContext } from "@sid-code/core/query/hypothesis-guide.ts";

interface SessionRow {
  id: string;
  firstPrompt: string;
  steps: number;
  quadrant: "TRIGGER" | "PATH_ONLY" | "INV_ONLY" | "NEITHER";
  triggered: boolean;
  highSignal: boolean;
  jsonTitleHit: boolean;
  hypothesisRegisterCalls: number;
  hypothesisChallengeCalls: number;
}

function resolveSessionsDir(): string {
  const root = process.env.SID_CODE_HOME || join(homedir(), ".sid-code");
  return join(root, "trajectories", "sessions");
}

/** 从 trajectory[].action（"toolName({...})" 字符串）统计指定工具调用次数 */
function countToolCalls(traj: any[], toolName: string): number {
  let n = 0;
  for (const t of traj) {
    if (typeof t?.action === "string") {
      const m = t.action.match(/^([a-zA-Z_]+)\(/);
      if (m && m[1] === toolName) n++;
    }
  }
  return n;
}

function loadSessions(dir: string): SessionRow[] {
  const rows: SessionRow[] = [];
  if (!existsSync(dir)) {
    process.stderr.write(`会话目录不存在：${dir}\n`);
    return rows;
  }
  for (const id of readdirSync(dir)) {
    const p = join(dir, id, "session.traj");
    if (!existsSync(p)) continue;
    let j: any;
    try {
      j = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue; // 损坏文件跳过
    }
    const up = j?.metadata?.user_prompts;
    // 只取有「首条原始用户输入」的会话——这才是检测函数真实的输入源。
    // trajectory[0].content 常被工具结果污染（read/git 输出），不可用作首条输入。
    if (!Array.isArray(up) || up.length === 0) continue;
    const firstPrompt = typeof up[0] === "string" ? up[0] : JSON.stringify(up[0]);
    if (!firstPrompt.trim()) continue;

    const traj = Array.isArray(j.trajectory) ? j.trajectory : [];
    const diag = diagnoseInvestigationContext(firstPrompt);
    rows.push({
      id,
      firstPrompt,
      steps: traj.length,
      quadrant: diag.quadrant,
      triggered: diag.triggered,
      highSignal: diag.highSignal,
      jsonTitleHit: diag.jsonTitleHit,
      hypothesisRegisterCalls: countToolCalls(traj, "hypothesis_register"),
      hypothesisChallengeCalls: countToolCalls(traj, "hypothesis_challenge"),
    });
  }
  return rows;
}

function pct(n: number, total: number): string {
  return total === 0 ? "0%" : ((n / total) * 100).toFixed(1) + "%";
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const sampleN = (() => {
    const i = args.indexOf("--samples");
    return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : 8;
  })();

  const dir = resolveSessionsDir();
  const rows = loadSessions(dir);
  const total = rows.length;

  // 四象限分布
  const byQuad: Record<string, SessionRow[]> = {
    TRIGGER: [],
    PATH_ONLY: [],
    INV_ONLY: [],
    NEITHER: [],
  };
  for (const r of rows) byQuad[r.quadrant].push(r);

  const triggered = rows.filter((r) => r.triggered);
  const triggeredByLayer = {
    highSignal: triggered.filter((r) => r.highSignal).length,
    jsonTitle: triggered.filter((r) => r.jsonTitleHit).length,
    andOnly: triggered.filter((r) => !r.highSignal && !r.jsonTitleHit).length,
  };

  // 漏判候选：未触发 + 高复杂度（步数 > 20）
  const missCandidates = rows
    .filter((r) => !r.triggered && r.steps > 20)
    .sort((a, b) => b.steps - a.steps);
  // 误判候选：触发了 + 低复杂度（步数 < 5）
  const falsePositiveCandidates = rows
    .filter((r) => r.triggered && r.steps < 5)
    .sort((a, b) => a.steps - b.steps);

  // 采纳关联：触发的会话里，实际调了 hypothesis_register 的占比
  const triggeredAndAdopted = triggered.filter((r) => r.hypothesisRegisterCalls > 0);
  const anyAdopted = rows.filter((r) => r.hypothesisRegisterCalls > 0);

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          total,
          sessionsDir: dir,
          quadrants: Object.fromEntries(
            Object.entries(byQuad).map(([k, v]) => [
              k,
              {
                count: v.length,
                pct: pct(v.length, total),
                avgSteps: v.length ? Math.round(v.reduce((s, r) => s + r.steps, 0) / v.length) : 0,
              },
            ]),
          ),
          triggered: {
            count: triggered.length,
            pct: pct(triggered.length, total),
            byLayer: triggeredByLayer,
          },
          missCandidates: missCandidates.map((r) => ({
            id: r.id,
            steps: r.steps,
            quadrant: r.quadrant,
            firstPrompt: r.firstPrompt.slice(0, 200),
          })),
          falsePositiveCandidates: falsePositiveCandidates.map((r) => ({
            id: r.id,
            steps: r.steps,
            firstPrompt: r.firstPrompt.slice(0, 200),
          })),
          adoption: {
            anyAdoptedCount: anyAdopted.length,
            triggeredAndAdoptedCount: triggeredAndAdopted.length,
            triggeredAdoptionRate: pct(triggeredAndAdopted.length, triggered.length),
          },
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  // ─── 人类可读报告 ───
  const L: string[] = [];
  L.push(`# 假设纪律首轮引导 · 离线词表验证报告`);
  L.push(``);
  L.push(`数据源：${dir}`);
  L.push(`有效会话（含首条用户原始输入）：${total}`);
  L.push(``);
  L.push(`## 一、四象限分布（基于 Layer 1 路径×动词）`);
  L.push(``);
  L.push(`| 象限 | 数量 | 占比 | avg步数 | 说明 |`);
  L.push(`|------|------|------|---------|------|`);
  const quadDesc: Record<string, string> = {
    TRIGGER: "路径+动词，AND 主线命中",
    PATH_ONLY: "仅路径，多为编码任务（正确排除）",
    INV_ONLY: "仅动词无路径，AND 盲区→靠 Layer 2/3 挽回",
    NEITHER: "都无，多为非调查任务",
  };
  for (const q of ["TRIGGER", "PATH_ONLY", "INV_ONLY", "NEITHER"]) {
    const v = byQuad[q];
    const avg = v.length ? Math.round(v.reduce((s, r) => s + r.steps, 0) / v.length) : 0;
    L.push(`| ${q} | ${v.length} | ${pct(v.length, total)} | ${avg} | ${quadDesc[q]} |`);
  }
  L.push(``);
  L.push(`## 二、最终触发率（三层判定后）`);
  L.push(``);
  L.push(
    `触发总数：${triggered.length} / ${total} = **${pct(triggered.length, total)}**（文档预估 ~17-18%）`,
  );
  L.push(`命中层拆解：`);
  L.push(`  - Layer 2 高信号短语命中：${triggeredByLayer.highSignal}`);
  L.push(`  - Layer 3 JSON title 才命中：${triggeredByLayer.jsonTitle}`);
  L.push(`  - 仅 Layer 1 AND 命中：${triggeredByLayer.andOnly}`);
  L.push(``);
  L.push(`## 三、漏判候选（未触发 + 步数>20，需人工抽查是否真核查任务）`);
  L.push(``);
  L.push(
    `共 ${missCandidates.length} 条，展示步数最高的前 ${Math.min(sampleN, missCandidates.length)} 条：`,
  );
  for (const r of missCandidates.slice(0, sampleN)) {
    L.push(`  [${r.id}] steps=${r.steps} quad=${r.quadrant}`);
    L.push(`    «${r.firstPrompt.slice(0, 160).replace(/\n/g, " ")}»`);
  }
  L.push(``);
  L.push(`## 四、误判候选（触发了 + 步数<5，需人工抽查是否误伤）`);
  L.push(``);
  L.push(`共 ${falsePositiveCandidates.length} 条，全部展示：`);
  for (const r of falsePositiveCandidates.slice(0, sampleN)) {
    L.push(`  [${r.id}] steps=${r.steps} highSignal=${r.highSignal} jsonTitle=${r.jsonTitleHit}`);
    L.push(`    «${r.firstPrompt.slice(0, 160).replace(/\n/g, " ")}»`);
  }
  L.push(``);
  L.push(`## 五、采纳关联（触发 → 模型实际调 hypothesis_register）`);
  L.push(``);
  L.push(
    `触发的会话中实际调用 hypothesis_register：${triggeredAndAdopted.length} / ${triggered.length} = ${pct(triggeredAndAdopted.length, triggered.length)}`,
  );
  L.push(`全量会话中任意调用 hypothesis_register：${anyAdopted.length}`);
  L.push(``);
  L.push(`> 注：本地历史会话多数早于本次改动落地，采纳数据预期偏低/为 0；`);
  L.push(`> 真实采纳率需用层次 2（实跑模型）+ 新增的 HypothesisToolUsed trace 事件统计。`);

  process.stdout.write(L.join("\n") + "\n");
}

main();
