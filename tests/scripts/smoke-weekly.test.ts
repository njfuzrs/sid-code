/**
 * G2/G4 每周变异复跑（scripts/smoke/weekly.ts + mutate.ts --json）。
 *
 * 这是「门禁的门禁」：判定写宽了，survived / stale 会被报成通过，台账「已变异自证」就成了
 * 一个自己定义、自己达标的数字；报告丢了跳过行，仅本机用例在 CI 环境变量下被静默跳过也看不出来。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MutationRow } from "../../scripts/smoke/mutate.ts";
import { judgeWeekly, renderPlist, renderWeeklyReport } from "../../scripts/smoke/weekly.ts";

const ROOT = join(import.meta.dir, "../..");
const row = (outcome: MutationRow["outcome"], id = "A2-x"): MutationRow => ({
  id,
  file: "packages/core/src/a.ts",
  why: "接线断了",
  outcome,
  detail: outcome === "skipped" ? "仅本机运行：慢" : "某断言",
});
const meta = { date: "2026-11-10", commit: "abcd1234", durationMs: 120_000, aborted: null };

describe("judgeWeekly", () => {
  test("全部 killed（含跳过行）→ 通过", () => {
    expect(judgeWeekly([row("killed"), row("killed"), row("skipped", "Z")], null).ok).toBe(true);
  });
  test("有 survived 或 stale → 不通过", () => {
    expect(judgeWeekly([row("killed"), row("survived")], null).ok).toBe(false);
    expect(judgeWeekly([row("killed"), row("stale")], null).ok).toBe(false);
  });
  test("中止 → 不通过（后面的用例没跑）", () => {
    expect(judgeWeekly([row("killed")], "A6-compact").ok).toBe(false);
  });
  test("一条都没跑（只有跳过或空）→ 不通过，恒绿比红更危险", () => {
    expect(judgeWeekly([], null).ok).toBe(false);
    expect(judgeWeekly([row("skipped")], null).ok).toBe(false);
  });
});

describe("renderWeeklyReport", () => {
  test("通过时标题写全部 killed，带 commit 与各用例 killed 数", () => {
    const md = renderWeeklyReport(
      [row("killed", "A1"), row("killed", "A1"), row("killed", "A2")],
      meta,
    );
    expect(md).toContain("✅ 全部 killed");
    expect(md).toContain("`abcd1234`");
    expect(md).toContain("- A1：2");
    expect(md).toContain("- A2：1");
  });
  test("survived / stale 逐条进表，跳过的用例带原因列出", () => {
    const md = renderWeeklyReport(
      [row("killed"), row("survived", "A9"), row("skipped", "A4-loop-tui")],
      meta,
    );
    expect(md).toContain("❌");
    expect(md).toContain("| A9 | survived |");
    expect(md).toContain("- A4-loop-tui：仅本机运行：慢");
  });
  test("中止时写明中止在哪个用例", () => {
    expect(renderWeeklyReport([], { ...meta, aborted: "A6-compact" })).toContain(
      "中止于 `A6-compact`",
    );
  });
});

describe("接线", () => {
  const src = readFileSync(join(ROOT, "scripts/smoke/weekly.ts"), "utf8");
  test("launchd 配置是每周一次（Weekday 存在），只打印不安装", () => {
    const plist = renderPlist("/bin/bun", "/x/weekly.ts", "/tmp/r");
    expect(plist).toContain("<key>Weekday</key><integer>1</integer>");
    expect(plist).toContain("<string>/x/weekly.ts</string>");
    expect(src).not.toContain("launchctl load");
  });
  test("跑 mutate 时清掉 CI 变量（否则仅本机用例被判 skip，保鲜静默失效）", () => {
    expect(src).toContain('env: { ...process.env, CI: "" }');
  });
  test("mutate.ts 支持 --json，且中止路径也写结果", () => {
    const m = readFileSync(join(ROOT, "scripts/smoke/mutate.ts"), "utf8");
    expect(m).toContain('json: { type: "string" }');
    expect(m.match(/writeFileSync\(opts\.json/g)?.length).toBe(3);
  });
  test("package.json 有 smoke:weekly", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["smoke:weekly"]).toBe("bun run scripts/smoke/weekly.ts");
  });
});
