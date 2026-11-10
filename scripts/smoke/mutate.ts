#!/usr/bin/env bun
/**
 * 变异复跑：对每个用例的每条 mutation 配方，改坏源码 → 用源码入口跑该用例 → 断言变红 → 还原。
 *
 * 结果三种：
 *   killed   用例变红，门禁有效
 *   survived 改坏了用例还是绿，门禁已经空心 → 退出码 1
 *   stale    find 在 file 里不是恰好出现一次，配方随源码漂移了 → 退出码 1
 *
 * 为什么用源码入口：每条变异都 make build 一次太慢（单次约 1 分钟）。源码入口与构建产物
 * 跑的是同一份代码，用例本身的「测装好的东西」由 run.ts 负责。
 *
 * ⚠ 会临时改写工作区里的源码文件。还原用的是**改写前读到的原文**，不是 git checkout
 * （CLAUDE.md：不许用 git 还原做基线，会吞掉并行任务的在途改动）。进程被杀时 finally
 * 可能来不及执行，所以开跑前先检查目标文件没有未提交改动，避免还原错版本。
 *
 * 用法：
 *   bun run scripts/smoke/mutate.ts                  # 全部用例
 *   bun run scripts/smoke/mutate.ts A2-post-tool-use # 指定用例
 *   bun run scripts/smoke/mutate.ts --json out.json  # 另写一份结构化结果（每周复跑报告用，scripts/smoke/weekly.ts）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT, loadCases, runCase } from "../../tests/smoke/lib/runner.ts";

export type Outcome = "killed" | "survived" | "stale";

/** `--json` 写出的一行。skip 的用例（平台不符 / 仅本机却在 CI）也记一行，报告里要看得见 */
export interface MutationRow {
  id: string;
  file: string;
  why: string;
  outcome: Outcome | "skipped";
  detail: string;
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length))
    n++;
  return n;
}

function isDirty(rel: string): boolean {
  const r = Bun.spawnSync(["git", "status", "--porcelain", "--", rel], { cwd: REPO_ROOT });
  return r.stdout.toString().trim() !== "";
}

const { values: opts, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { json: { type: "string" } },
  allowPositionals: true,
});
const cases = await loadCases(positionals);
const rows: MutationRow[] = [];

for (const c of cases) {
  // 先确认未变异时是绿的：基线不绿，变红就证明不了任何事
  const baseline = await runCase(c, { kind: "source" });
  if (baseline.status === "skip") {
    console.log(`[SKIP] ${c.def.id}：${baseline.reason}`);
    rows.push({
      id: c.def.id,
      file: "",
      why: "",
      outcome: "skipped",
      detail: baseline.reason ?? "",
    });
    continue;
  }
  if (baseline.status !== "pass") {
    console.error(
      `[ABORT] ${c.def.id} 未变异时就不通过，先修用例：\n  ${baseline.failures.join("\n  ")}`,
    );
    if (opts.json) writeFileSync(opts.json, JSON.stringify({ aborted: c.def.id, rows }, null, 2));
    process.exit(2);
  }

  for (const m of c.def.mutations) {
    const abs = join(REPO_ROOT, m.file);
    const original = readFileSync(abs, "utf8");
    const n = countOccurrences(original, m.find);
    if (n !== 1) {
      rows.push({
        id: c.def.id,
        file: m.file,
        why: m.why,
        outcome: "stale",
        detail: `find 出现 ${n} 次（应为 1）`,
      });
      continue;
    }
    if (isDirty(m.file)) {
      console.error(
        `[ABORT] ${m.file} 有未提交改动，变异后无法确定还原到哪个版本。提交或换个干净的工作区再跑`,
      );
      if (opts.json) writeFileSync(opts.json, JSON.stringify({ aborted: c.def.id, rows }, null, 2));
      process.exit(2);
    }
    writeFileSync(abs, original.replace(m.find, m.replace));
    try {
      const r = await runCase(c, { kind: "source" }, { keepOnFail: false });
      const outcome: Outcome = r.status === "fail" ? "killed" : "survived";
      rows.push({
        id: c.def.id,
        file: m.file,
        why: m.why,
        outcome,
        detail: r.failures[0]?.split("\n")[0] ?? "",
      });
    } finally {
      writeFileSync(abs, original);
    }
  }
}

for (const r of rows) {
  if (r.outcome === "skipped") continue;
  const tag = { killed: "KILLED  ", survived: "SURVIVED", stale: "STALE   " }[r.outcome];
  console.log(`[${tag}] ${r.id} · ${r.file}\n    变异：${r.why}\n    ${r.detail}`);
}
const ran = rows.filter((r) => r.outcome !== "skipped");
const bad = ran.filter((r) => r.outcome !== "killed").length;
console.log(`\n${ran.length} 条变异：${ran.length - bad} killed，${bad} 未杀死或已陈旧`);
if (opts.json) writeFileSync(opts.json, JSON.stringify({ aborted: null, rows }, null, 2));
process.exit(bad > 0 ? 1 : 0);
