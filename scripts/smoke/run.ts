#!/usr/bin/env bun
/**
 * G2 无头回放冒烟：跑 tests/smoke/cases/ 下的用例。
 *
 * 用法：
 *   bun run scripts/smoke/run.ts                     # 跑全部，用仓库根的构建产物 ./sid-code
 *   bun run scripts/smoke/run.ts A2-post-tool-use    # 只跑指定用例
 *   bun run scripts/smoke/run.ts --source            # 用源码入口（免 make build，开发期用）
 *   bun run scripts/smoke/run.ts --binary <path>     # 指定二进制
 *   bun run scripts/smoke/run.ts --keep              # 通过的用例也保留工作目录
 *
 * 退出码：有 fail 即 1。skip 不算失败，但会出现在汇总表里。
 * 设了 GITHUB_STEP_SUMMARY 时把汇总表追加进去。
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  REPO_ROOT,
  loadCases,
  renderSummary,
  runCase,
  type CaseResult,
  type Launcher,
} from "../../tests/smoke/lib/runner.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    source: { type: "boolean", default: false },
    binary: { type: "string" },
    keep: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

let launcher: Launcher;
if (values.source) {
  launcher = { kind: "source" };
} else {
  const path = values.binary ?? join(REPO_ROOT, "sid-code");
  if (!existsSync(path)) {
    console.error(`找不到二进制 ${path}。先 make build，或用 --source 跑源码入口`);
    process.exit(2);
  }
  launcher = { kind: "binary", path };
}

const cases = await loadCases(positionals);
if (cases.length === 0) {
  console.error(
    positionals.length
      ? `没有匹配的用例：${positionals.join(", ")}`
      : "tests/smoke/cases/ 下没有用例",
  );
  process.exit(2);
}

const results: CaseResult[] = [];
for (const c of cases) {
  const r = await runCase(c, launcher, { keep: values.keep });
  results.push(r);
  const tag = r.status === "pass" ? "PASS" : r.status === "skip" ? "SKIP" : "FAIL";
  console.log(
    `[${tag}] ${r.id} (${(r.durationMs / 1000).toFixed(1)}s)${r.reason ? ` — ${r.reason}` : ""}`,
  );
  for (const f of r.failures) console.log(`    ✗ ${f}`);
  if (r.workDir) console.log(`    工作目录（含轨迹）：${r.workDir}`);
}

const fail = results.filter((r) => r.status === "fail").length;
const skip = results.filter((r) => r.status === "skip").length;
console.log(
  `\n${results.length} 例：${results.length - fail - skip} 通过，${fail} 失败，${skip} 跳过（${launcher.kind}）`,
);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    renderSummary(results, `G2 无头回放冒烟（${process.platform}）`) + "\n",
  );
}
process.exit(fail > 0 ? 1 : 0);
