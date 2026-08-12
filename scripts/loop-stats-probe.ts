#!/usr/bin/env bun
/**
 * loop-stats-probe —— 循环检测利弊·真实轨迹量化脚本（一次性调研用）
 *
 * 背景：sid-code 有两个循环检测器（默认全局关闭，见 packages/core/src/agent/loop-detection.ts）：
 *   - ToolCallLoopDetector：只抓「完全相同」的连续重复调用（命令差一个字符就绕过）
 *   - ToolShapeLoopDetector：抓「同 shape」的反复探测；但对 bash 会退化——
 *     bash 的 command 值不进 shape key、又无 path/cwd 等 anchor 字段 → 所有 bash 调用
 *     的 shape key 全塌成同一串，检测器实际变成「滑动窗口内 bash 数 ≥ 阈值就误判」。
 *
 * 本脚本从本地真实会话轨迹提取证据，量化：
 *   1) 重复 bash 命令频率（exact 命中 vs command 不同但会被 shape 误命中）
 *   2) 重复 git 命令（只读 vs 有副作用）
 *   3) 模拟开启 shape 检测的会话命中率 + 误判率（连续多个不同 bash = 误判）
 *   4) 模拟开启 exact 检测的会话命中率 + 真循环 vs 正当重复
 *
 * 数据源：{root}/trajectories/sessions/{id}/session.traj 的 trajectory[] 数组
 *   （events.jsonl 只记 tool_name 不记 tool_input，无法拿到 command → 必须读 session.traj）
 *   trajectory[] 是「有序工具调用序列」——正是循环检测器 record() 回放看到的东西。
 *
 * 只读、不改任何 src/ 生产代码。
 *
 * 用法：
 *   bun scripts/loop-stats-probe.ts
 *   bun scripts/loop-stats-probe.ts --json
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths, listSessions } from "@sid-code/core/trace/digest.ts";
import {
  ToolShapeLoopDetector,
  ToolCallLoopDetector,
  DEFAULT_LOOP_CONFIG,
  EXEMPT_TOOLS,
} from "@sid-code/core/agent/loop-detection.ts";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";

// ─────────────────────────── 数据结构 ───────────────────────────

interface ToolStep {
  toolName: string;
  toolInput: Record<string, unknown>;
  command: string | null; // bash 的 command（非 bash 为 null）
}

interface SessionData {
  id: string;
  model: string | null;
  steps: ToolStep[];
}

/** 从 session.traj 读出有序工具调用序列。 */
function loadSession(dir: string, id: string): SessionData | null {
  const p = join(dir, "session.traj");
  if (!existsSync(p)) return null;
  let j: any;
  try {
    j = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  const traj: any[] = Array.isArray(j.trajectory) ? j.trajectory : [];
  const steps: ToolStep[] = [];
  for (const s of traj) {
    if (!s || typeof s !== "object") continue;
    const tn = s.tool_name;
    if (!tn || typeof tn !== "string") continue;
    const ti = s.tool_input && typeof s.tool_input === "object" ? s.tool_input : {};
    let command: string | null = null;
    if (tn === "bash" && typeof ti.command === "string") command = ti.command;
    steps.push({ toolName: tn, toolInput: ti, command });
  }
  if (steps.length === 0) return null;
  return { id, model: j?.metadata?.model ?? null, steps };
}

// ─────────────────────────── 工具函数 ───────────────────────────

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

/** 取 bash 命令的首个「主命令词」（跳过 cd/env 前缀，取管道/&& 里第一个实义命令）。
 *  仅用于 git 归类的粗判——精确只读性交给 isReadOnlyCommand。 */
function firstMeaningfulVerb(cmd: string): string {
  // 拆 && / ; / |，取第一个非 cd 段的首词
  const segs = cmd
    .split(/&&|\|\||\||;/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segs) {
    const tokens = seg.split(/\s+/);
    let i = 0;
    // 跳过 cd XXX 和 VAR=val 前缀
    while (
      i < tokens.length &&
      (tokens[i] === "cd" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))
    ) {
      if (tokens[i] === "cd") i += 2;
      else i += 1;
    }
    if (i < tokens.length && tokens[i]) return tokens[i];
  }
  const t = cmd.trim().split(/\s+/);
  return t[0] || "";
}

/** 是否 git 命令（含 cd X && git ...）。 */
function isGitCommand(cmd: string): boolean {
  return /(^|&&|\||;|\s)git\s/.test(cmd) || firstMeaningfulVerb(cmd) === "git";
}

// ─────────────────────────── 主逻辑 ───────────────────────────

interface Metrics {
  scanned: number;
  totalToolSteps: number;
  totalBashSteps: number;

  // 指标 1：重复 bash 命令
  sessionsWithExactBashRun: number; // 有 ≥1 段连续 ≥3 次完全相同 bash 的会话
  exactBashRunOccurrences: number; // 所有会话累计这样的段数
  sessionsWithDiffBashRun: number; // 有 ≥1 段连续 ≥3 次 bash 但命令不全相同的会话
  diffBashRunOccurrences: number;

  // 指标 2：重复 git
  sessionsWithGitRun: number; // 有 ≥1 段连续 ≥3 次 git 命令的会话
  gitRunReadOnly: number; // 这些段里，纯只读 git 段数
  gitRunSideEffect: number; // 含副作用 git 段数（commit/push/add...）

  // 指标 3：shape 检测模拟
  shapeHitSessions: number;
  shapeHitBashDominant: number; // 触发点前窗口以 bash 为主（可能误判）
  shapeSamples: ShapeSample[];

  // 指标 4：exact 检测模拟
  exactHitSessions: number;
  exactSamples: ExactSample[];
}

interface ShapeSample {
  id: string;
  model: string | null;
  window: string[]; // 触发时窗口内的工具调用摘要
  distinctBashCmds: number;
  bashCount: number;
  verdict: "误判(多个不同bash)" | "误判(多个不同工具)" | "疑似真循环(同参数反复)";
}

interface ExactSample {
  id: string;
  model: string | null;
  repeatedCall: string;
  count: number;
  verdict: "真循环(同工具同参数≥3)" | "正当重复(需人工判)";
}

function shortToolDesc(step: ToolStep): string {
  if (step.toolName === "bash" && step.command) {
    return `bash: ${step.command.replace(/\s+/g, " ").slice(0, 70)}`;
  }
  const keys = Object.keys(step.toolInput);
  const anchor = step.toolInput.path ?? step.toolInput.file_path ?? step.toolInput.pattern ?? "";
  return `${step.toolName}(${keys.slice(0, 3).join(",")})${anchor ? " " + String(anchor).slice(0, 40) : ""}`;
}

function analyze(sessions: SessionData[]): Metrics {
  const m: Metrics = {
    scanned: sessions.length,
    totalToolSteps: 0,
    totalBashSteps: 0,
    sessionsWithExactBashRun: 0,
    exactBashRunOccurrences: 0,
    sessionsWithDiffBashRun: 0,
    diffBashRunOccurrences: 0,
    sessionsWithGitRun: 0,
    gitRunReadOnly: 0,
    gitRunSideEffect: 0,
    shapeHitSessions: 0,
    shapeHitBashDominant: 0,
    shapeSamples: [],
    exactHitSessions: 0,
    exactSamples: [],
  };

  for (const sess of sessions) {
    m.totalToolSteps += sess.steps.length;
    m.totalBashSteps += sess.steps.filter((s) => s.toolName === "bash").length;

    // ---- 指标 1 & 2：扫描连续同类段（run） ----
    let sessHasExact = false;
    let sessHasDiff = false;
    let sessHasGit = false;

    let i = 0;
    while (i < sess.steps.length) {
      if (sess.steps[i].toolName !== "bash") {
        i++;
        continue;
      }
      // 收集连续 bash 段
      let j = i;
      while (j < sess.steps.length && sess.steps[j].toolName === "bash") j++;
      const run = sess.steps.slice(i, j); // 连续 bash
      if (run.length >= 3) {
        const cmds = run.map((s) => (s.command ?? "").trim());
        // exact：段内是否存在连续 ≥3 完全相同
        let maxSame = 1,
          cur = 1;
        for (let k = 1; k < cmds.length; k++) {
          if (cmds[k] === cmds[k - 1] && cmds[k] !== "") cur++;
          else cur = 1;
          if (cur > maxSame) maxSame = cur;
        }
        if (maxSame >= 3) {
          sessHasExact = true;
          m.exactBashRunOccurrences++;
        } else {
          // 连续 ≥3 bash 但不是完全相同 → 会被 exact 漏判，但 shape 会因退化命中
          sessHasDiff = true;
          m.diffBashRunOccurrences++;
        }
        // git 归类：段内若全部/大量是 git
        const gitCmds = cmds.filter((c) => isGitCommand(c));
        if (gitCmds.length >= 3) {
          sessHasGit = true;
          for (const gc of gitCmds) {
            if (isReadOnlyCommand(gc)) m.gitRunReadOnly++;
            else m.gitRunSideEffect++;
          }
        }
      }
      i = j;
    }
    if (sessHasExact) m.sessionsWithExactBashRun++;
    if (sessHasDiff) m.sessionsWithDiffBashRun++;
    if (sessHasGit) m.sessionsWithGitRun++;

    // ---- 指标 3：shape 检测回放 ----
    {
      const det = new ToolShapeLoopDetector(DEFAULT_LOOP_CONFIG);
      const recent: ToolStep[] = [];
      let hit = false;
      for (const step of sess.steps) {
        if (EXEMPT_TOOLS.has(step.toolName)) {
          // 与生产一致：豁免工具不进检测器
          recent.push(step);
          if (recent.length > DEFAULT_LOOP_CONFIG.toolShapeWindow) recent.shift();
          continue;
        }
        recent.push(step);
        if (recent.length > DEFAULT_LOOP_CONFIG.toolShapeWindow) recent.shift();
        if (det.record(step.toolName, step.toolInput)) {
          hit = true;
          // 分析触发窗口
          const win = recent.slice(-DEFAULT_LOOP_CONFIG.toolShapeWindow);
          const bashSteps = win.filter((s) => s.toolName === "bash");
          const distinctBash = new Set(bashSteps.map((s) => (s.command ?? "").trim())).size;
          let verdict: ShapeSample["verdict"];
          if (bashSteps.length >= DEFAULT_LOOP_CONFIG.toolShapeThreshold && distinctBash >= 3) {
            verdict = "误判(多个不同bash)";
          } else {
            // 非 bash 主导：看窗口内 distinct toolInput
            const nonBash = win.filter((s) => s.toolName !== "bash");
            const distinctInputs = new Set(win.map((s) => JSON.stringify(s.toolInput))).size;
            if (distinctInputs >= Math.ceil(win.length * 0.6)) {
              verdict =
                nonBash.length > bashSteps.length ? "误判(多个不同工具)" : "误判(多个不同bash)";
            } else {
              verdict = "疑似真循环(同参数反复)";
            }
          }
          if (verdict.startsWith("误判")) m.shapeHitBashDominant++;
          if (m.shapeSamples.length < 8) {
            m.shapeSamples.push({
              id: sess.id,
              model: sess.model,
              window: win.map(shortToolDesc),
              distinctBashCmds: distinctBash,
              bashCount: bashSteps.length,
              verdict,
            });
          }
          break; // 每会话记首次命中即可
        }
      }
      if (hit) m.shapeHitSessions++;
    }

    // ---- 指标 4：exact 检测回放 ----
    {
      const det = new ToolCallLoopDetector(DEFAULT_LOOP_CONFIG);
      let hit = false;
      // 追踪连续相同以还原命中内容
      let prevKey = "";
      let runLen = 1;
      let hitStep: ToolStep | null = null;
      for (const step of sess.steps) {
        if (EXEMPT_TOOLS.has(step.toolName)) {
          prevKey = "";
          runLen = 1;
          continue;
        }
        const key = step.toolName + "::" + JSON.stringify(step.toolInput);
        if (key === prevKey) runLen++;
        else {
          prevKey = key;
          runLen = 1;
        }
        if (det.record(step.toolName, step.toolInput)) {
          hit = true;
          hitStep = step;
          break;
        }
      }
      if (hit) {
        m.exactHitSessions++;
        if (m.exactSamples.length < 8 && hitStep) {
          const desc = shortToolDesc(hitStep);
          // exact 检测本质就是同工具同参数连续 ≥3 → 归为真循环（正当重复极少完全同参数）
          m.exactSamples.push({
            id: sess.id,
            model: sess.model,
            repeatedCall: desc,
            count: runLen,
            verdict: "真循环(同工具同参数≥3)",
          });
        }
      }
    }
  }

  return m;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");

  const paths = resolvePaths();
  const refs = listSessions(paths);
  const sessions: SessionData[] = [];
  let noTraj = 0;
  for (const ref of refs) {
    const s = loadSession(ref.dir, ref.id);
    if (s) sessions.push(s);
    else noTraj++;
  }

  const m = analyze(sessions);

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ ...m, sessionDirsTotal: refs.length, noTrajOrEmpty: noTraj }, null, 2) +
        "\n",
    );
    return;
  }

  const L: string[] = [];
  L.push("═══════════ 循环检测利弊·真实轨迹量化 ═══════════");
  L.push(
    `会话目录总数：${refs.length}   有可用 session.traj 且含工具调用：${m.scanned}   无轨迹/空：${noTraj}`,
  );
  L.push(
    `累计工具调用步数：${m.totalToolSteps}   其中 bash：${m.totalBashSteps} (${pct(m.totalBashSteps, m.totalToolSteps)})`,
  );
  L.push("");

  L.push("── 指标1：重复 bash 命令（连续 ≥3 次同为 bash 的段）──");
  L.push(
    `  段内存在「连续 ≥3 次完全相同 command」的会话：${m.sessionsWithExactBashRun} (${pct(m.sessionsWithExactBashRun, m.scanned)})，累计 ${m.exactBashRunOccurrences} 段  ← 会被 exact 检测器命中`,
  );
  L.push(
    `  「连续 ≥3 次 bash 但 command 不全相同」的会话：${m.sessionsWithDiffBashRun} (${pct(m.sessionsWithDiffBashRun, m.scanned)})，累计 ${m.diffBashRunOccurrences} 段  ← exact 漏判、但 shape 因退化会命中`,
  );
  L.push("");

  L.push("── 指标2：重复 git 命令（连续 bash 段里 ≥3 条 git）──");
  L.push(`  含此类段的会话：${m.sessionsWithGitRun} (${pct(m.sessionsWithGitRun, m.scanned)})`);
  const gitTotal = m.gitRunReadOnly + m.gitRunSideEffect;
  L.push(
    `  这些 git 命令：只读(status/log/diff/show...) ${m.gitRunReadOnly} 条 (${pct(m.gitRunReadOnly, gitTotal)})，有副作用(commit/push/add...) ${m.gitRunSideEffect} 条 (${pct(m.gitRunSideEffect, gitTotal)})`,
  );
  L.push("");

  L.push(
    "── 指标3：模拟开启 shape 检测（ToolShapeLoopDetector, DEFAULT_LOOP_CONFIG 窗口10/阈值7）──",
  );
  L.push(
    `  会触发 shape 循环告警的会话：${m.shapeHitSessions} (${pct(m.shapeHitSessions, m.scanned)})`,
  );
  L.push(
    `  其中触发窗口以「多个不同 bash / 多个不同工具」为主（≈误判）：${m.shapeHitBashDominant} (${pct(m.shapeHitBashDominant, m.shapeHitSessions)})`,
  );
  L.push(
    `  ⇒ 预估误判率 ≈ ${pct(m.shapeHitBashDominant, m.shapeHitSessions)}（误命中会话 / 总命中会话）`,
  );
  L.push("");
  L.push("  抽样（触发点前窗口）：");
  for (const s of m.shapeSamples.slice(0, 5)) {
    L.push(
      `    [${s.id}] ${s.model ?? "?"}  判定=${s.verdict}  bash数=${s.bashCount} 其中不同命令=${s.distinctBashCmds}`,
    );
    for (const w of s.window.slice(-DEFAULT_LOOP_CONFIG.toolShapeThreshold)) {
      L.push(`        · ${w}`);
    }
  }
  L.push("");

  L.push("── 指标4：模拟开启 exact 检测（ToolCallLoopDetector, 阈值3）──");
  L.push(`  会命中的会话：${m.exactHitSessions} (${pct(m.exactHitSessions, m.scanned)})`);
  L.push("  抽样命中：");
  for (const s of m.exactSamples.slice(0, 5)) {
    L.push(`    [${s.id}] ${s.model ?? "?"}  连续${s.count}次  判定=${s.verdict}`);
    L.push(`        · ${s.repeatedCall}`);
  }

  process.stdout.write(L.join("\n") + "\n");
}

main();
