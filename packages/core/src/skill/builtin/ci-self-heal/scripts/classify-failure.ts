#!/usr/bin/env bun
/**
 * classify-failure.ts — ci-self-heal Skill 确定性脚本
 *
 * 输入: parse-ci-log.ts 的 JSON 输出(stdin 或 --file <path>)
 * 输出: 结构化分类 JSON to stdout
 *   {
 *     class: "test_failure" | "lint_failure" | "build_failure" | "type_error" |
 *            "dependency_missing" | "config_error" | "flaky" | "timeout" | "unknown",
 *     confidence: number,           // 0.0..1.0
 *     signals: string[],            // 命中的启发式信号清单
 *     candidate_alternatives: [...], // 排第二的可能分类(用于 LLM ambiguity 提示)
 *   }
 *
 * 用途: 让 Skill 在 LLM 分析前先做粗分类, 给 system prompt 提供 hint, 减少 LLM 误判.
 *
 * 由 RFC-002 §2.4 / SKILL.md §3.2 定义.
 *
 * 启发式规则参考: src/skill/builtin/ci-self-heal/references/ci-failure-patterns.md
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ParsedCILog } from "./parse-ci-log.ts";

export type FailureClass =
  | "test_failure"
  | "lint_failure"
  | "build_failure"
  | "type_error"
  | "dependency_missing"
  | "config_error"
  | "flaky"
  | "timeout"
  | "unknown";

export interface ClassifyResult {
  class: FailureClass;
  confidence: number;
  signals: string[];
  candidate_alternatives: Array<{ class: FailureClass; confidence: number; reason: string }>;
}

interface Score {
  cls: FailureClass;
  score: number;
  signals: string[];
}

/**
 * 启发式规则(顺序 + 加权).
 *
 * 设计原则:
 * - 强信号(如 runner 命中) +0.4
 * - 中等信号(如错误消息特征) +0.2
 * - 弱信号(如关键词匹配) +0.1
 * - 多信号叠加, 上限 0.95(留 0.05 给 LLM 修正)
 */
export function classifyFailure(parsed: ParsedCILog): ClassifyResult {
  const scores: Map<FailureClass, Score> = new Map();
  const ensure = (cls: FailureClass): Score => {
    let s = scores.get(cls);
    if (!s) {
      s = { cls, score: 0, signals: [] };
      scores.set(cls, s);
    }
    return s;
  };

  const allText =
    parsed.errorMessages.join(" \n ") +
    " \n " +
    parsed.failedAssertions.map((a) => a.message).join(" \n ");

  // ============== flaky(优先识别, 因为它会"借用"其他类的信号) ==============
  if (parsed.hasRetryMarkers) {
    const s = ensure("flaky");
    s.score += 0.4;
    s.signals.push("retry markers in log");
  }
  const flakyKeywords = [
    /timeout|setTimeout|timed out/i,
    /ECONNREFUSED|EADDRINUSE|fetch failed|socket hang up/i,
    /\bDate\.now\b|\bnow\(\)/,
    /race condition|deadlock/i,
    /eventually consistent/i,
  ];
  for (const k of flakyKeywords) {
    if (k.test(allText)) {
      const s = ensure("flaky");
      s.score += 0.15;
      s.signals.push(`flaky keyword: ${k.source.slice(0, 30)}`);
    }
  }

  // ============== type_error(TS/Flow/mypy 类) ==============
  if (parsed.runner === "tsc") {
    const s = ensure("type_error");
    s.score += 0.5;
    s.signals.push("runner=tsc");
  }
  if (/error TS\d{4}:|TypeError:|incompatible types|cannot assign/i.test(allText)) {
    const s = ensure("type_error");
    s.score += 0.25;
    s.signals.push("type error keyword");
  }

  // ============== lint_failure ==============
  if (parsed.runner === "eslint") {
    const s = ensure("lint_failure");
    s.score += 0.5;
    s.signals.push("runner=eslint");
  }
  if (/no-unused-vars|prefer-const|semi-colons|prettier|formatting/i.test(allText)) {
    const s = ensure("lint_failure");
    s.score += 0.2;
    s.signals.push("lint rule keyword");
  }

  // ============== build_failure ==============
  if (parsed.runner === "cargo" && /error\[E\d+\]/.test(allText)) {
    const s = ensure("build_failure");
    s.score += 0.4;
    s.signals.push("cargo error[E*]");
  }
  if (/(?:webpack|vite|esbuild|rollup|tsc).*?(?:failed|error)/i.test(allText)) {
    const s = ensure("build_failure");
    s.score += 0.3;
    s.signals.push("bundler error");
  }
  if (/Module not found|Cannot find module/i.test(allText)) {
    const s = ensure("dependency_missing");
    s.score += 0.4;
    s.signals.push("module not found");
  }

  // ============== dependency_missing ==============
  if (/npm ERR!|yarn error|pnpm.*?ENOENT|bun install.*?failed/i.test(allText)) {
    const s = ensure("dependency_missing");
    s.score += 0.35;
    s.signals.push("package manager error");
  }
  if (/peer dep|version conflict|ERESOLVE/i.test(allText)) {
    const s = ensure("dependency_missing");
    s.score += 0.25;
    s.signals.push("dependency conflict");
  }

  // ============== test_failure ==============
  if (
    parsed.runner === "jest" ||
    parsed.runner === "vitest" ||
    parsed.runner === "pytest" ||
    parsed.runner === "go-test" ||
    parsed.runner === "bun-test" ||
    parsed.runner === "mocha"
  ) {
    const s = ensure("test_failure");
    s.score += 0.35;
    s.signals.push(`runner=${parsed.runner}`);
  }
  if (parsed.failedAssertions.length > 0) {
    const s = ensure("test_failure");
    s.score += 0.25;
    s.signals.push(`${parsed.failedAssertions.length} failed assertion(s)`);
  }
  if (/expect\(.*?\)\.|assert\s+|Tests:\s+\d+ failed/i.test(allText)) {
    const s = ensure("test_failure");
    s.score += 0.15;
    s.signals.push("assertion keyword");
  }

  // ============== config_error ==============
  if (
    /\.github\/workflows|\.gitlab-ci\.yml|jest\.config|vitest\.config|tsconfig\.json|eslint\.config/i.test(
      allText,
    )
  ) {
    const s = ensure("config_error");
    s.score += 0.15;
    s.signals.push("config file mention");
  }
  if (/YAMLException|invalid config|cannot parse config/i.test(allText)) {
    const s = ensure("config_error");
    s.score += 0.4;
    s.signals.push("YAML/config parse error");
  }

  // ============== timeout ==============
  if (/timeout exceeded|exceeded the timeout|operation timed out/i.test(allText)) {
    const s = ensure("timeout");
    s.score += 0.4;
    s.signals.push("timeout exceeded");
  }
  if (/deadline exceeded|context deadline/i.test(allText)) {
    const s = ensure("timeout");
    s.score += 0.3;
    s.signals.push("deadline exceeded");
  }

  // ============== 排序 + 输出 ==============
  const ranked = Array.from(scores.values()).sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return {
      class: "unknown",
      confidence: 0.0,
      signals: ["no heuristic matched"],
      candidate_alternatives: [],
    };
  }

  const top = ranked[0];
  const topConfidence = Math.min(0.95, top.score);

  const alternatives = ranked.slice(1, 3).map((s) => ({
    class: s.cls,
    confidence: Math.min(0.95, s.score),
    reason: s.signals.slice(0, 2).join(" + "),
  }));

  return {
    class: top.cls,
    confidence: parseFloat(topConfidence.toFixed(2)),
    signals: top.signals,
    candidate_alternatives: alternatives,
  };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { file: { type: "string", short: "f" } },
    allowPositionals: false,
  });

  let jsonText: string;
  if (values.file) {
    jsonText = readFileSync(values.file, "utf-8");
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    jsonText = Buffer.concat(chunks).toString("utf-8");
  }

  const parsed: ParsedCILog = JSON.parse(jsonText);
  const result = classifyFailure(parsed);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
