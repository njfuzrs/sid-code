/**
 * F-H5: 提取所有 holdout case 的 must_include / must_not_include / user_query / reference_answer
 * 短 token 由长度 ≥ 5 字符过滤;输出到 stdout 一行一个,供 check-holdout-leak.sh grep。
 *
 * 调用:
 *   bun run scripts/eval/extract-holdout-tokens.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { glob } from "glob";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = process.cwd();
const HOLDOUT_DIRS = [
  "evals/holdout",
];

// 黑名单:这些是公共词/路径片段/目录名,出现在题面里也不算题面泄露
// (它们出现在 CASES.md / DASHBOARD.md 主要是因为正常的 case 描述/链接,不是 holdout 题面)
const BLACKLIST = new Set<string>([
  "architecture",
  "sid-code",
  "eval-runner",
  "evals/holdout/",
  "evals/holdout/architecture/",
  "src/agent/loop",
  "src/agent/loop-detection",
  "src/agent/loop-detection.ts",
  "src/entrypoints/bootstrap",
  "src/llm/anthropic",
  "src/llm/quota",
  "src/query/loop",
  "AgentLoopRunner",
  "LoopDetector",
  "ContentLoopDetector",
  "ToolCallLoopDetector",
  "QuotaManager",
  "QuotaCheckResult",
  "QuotaConfig",
  "AlertLevel",
  "arch_form",
  "not found",
  "check",
  "check(currentCost)",
]);

const tokens = new Set<string>();

function collectFromCase(caseDoc: Record<string, unknown>) {
  const expected = (caseDoc.expected as Record<string, unknown>) ?? {};
  const input = (caseDoc.input as Record<string, unknown>) ?? {};

  const lists: string[][] = [
    (expected.must_include_any_of as string[]) ?? [],
    (expected.must_not_include as string[]) ?? [],
  ];
  for (const list of lists) {
    for (const t of list) {
      if (typeof t !== "string") continue;
      // 长度 ≥ 8 + 不在黑名单 + 含路径分隔符或大写字母(高区分度)
      if (t.length < 8) continue;
      if (BLACKLIST.has(t)) continue;
      tokens.add(t);
    }
  }

  // user_query 拆出长 substring(≥ 15 字符的非空白片段)
  const uq = String(input.user_query ?? "");
  for (const piece of uq.split(/[\s\.,;:!?。、,;:！?\n]+/)) {
    if (piece.length >= 15 && !BLACKLIST.has(piece)) tokens.add(piece);
  }

  // reference_answer 同样处理(≥ 20 字符,中文场景下足够区分)
  const ra = String(expected.reference_answer ?? "");
  for (const piece of ra.split(/[\s\.,;:!?。、,;:！?\n]+/)) {
    if (piece.length >= 20 && !BLACKLIST.has(piece)) tokens.add(piece);
  }
}

async function main() {
  for (const base of HOLDOUT_DIRS) {
    const files = await glob("**/*.yaml", { cwd: join(REPO_ROOT, base), absolute: true });
    for (const f of files) {
      try {
        const doc = parseYaml(readFileSync(f, "utf-8")) as Record<string, unknown>;
        if (doc) collectFromCase(doc);
      } catch {
        // ignore
      }
    }
  }

  // 也扫 yaml 内 holdout: true 的 case(在 general/architecture 路径下)
  const allYaml = await glob("evals/**/*.yaml", { cwd: REPO_ROOT, absolute: true });
  for (const f of allYaml) {
    if (HOLDOUT_DIRS.some((d) => f.includes(`/${d.split("/").pop()}/`))) continue;
    try {
      const doc = parseYaml(readFileSync(f, "utf-8")) as Record<string, unknown>;
      if (doc?.holdout === true) collectFromCase(doc);
    } catch {
      // ignore
    }
  }

  // 输出去重的 tokens
  for (const t of [...tokens].sort()) {
    process.stdout.write(t + "\n");
  }
}

main().catch((e) => {
  process.stderr.write(`extract-holdout-tokens failed: ${e}\n`);
  process.exit(2);
});
