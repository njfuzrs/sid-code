/**
 * 差分测试台（B9 / T0.4）：S1–S14 在当前端口实现上跑，对 `baseline/*.json` 判定。
 *
 * T0.4 时端口只有 legacy，基线就是 legacy 自己 —— 这一步的价值是把旧底座的终端行为
 * （网格、scrollback、模式、full reset 次数、字节数、OSC）冻成可比对的事实。
 * T1.x 起同一份场景在 next 上跑，判定口径不变（`compareToBaseline`）。
 *
 * 更新基线（只在确认行为变化是有意的之后）：`UPDATE_TERM_BENCH=1 bun test ./packages/cli/tests/render-port/term-bench/`
 * 帧耗时不进基线（机器负载会让它抖），基线报告见 `bun run tui:bench`。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareToBaseline, runScenario, summarize } from "./harness.ts";
import { SCENARIOS } from "./scenarios.tsx";
import { parseSpec, SPEC_PATH } from "../../../../../scripts/verify-tui-spec.ts";

const BASELINE_DIR = join(import.meta.dir, "baseline");
const UPDATE = process.env.UPDATE_TERM_BENCH === "1";

describe("差分测试台 S1–S14（legacy 基线）", () => {
  test("场景清单与设计文档首批一致：S1–S14 一个不少", () => {
    expect(Object.keys(SCENARIOS)).toEqual(Array.from({ length: 14 }, (_, i) => `S${i + 1}`));
  });

  test("场景 covers 与 SPEC.md 测试列双向一致", () => {
    // SPEC 里写「由 S3 覆盖」的契约，S3.covers 必须含它；反之亦然。
    // 否则场景改了覆盖面、SPEC 没跟（或反过来），契约就会无声地失去保护。
    const fromSpec = new Map<string, string>();
    for (const c of parseSpec(readFileSync(SPEC_PATH, "utf8"))) {
      const m = /term-bench\/scenarios\.tsx` (S\d+): \{$/.exec(c.test);
      if (m) fromSpec.set(c.id, m[1]!);
    }
    const specIds = new Set(parseSpec(readFileSync(SPEC_PATH, "utf8")).map((c) => c.id));
    const problems: string[] = [];
    // SPEC → 场景：写了「由 Sn 覆盖」，Sn.covers 必须含它
    for (const [id, sc] of fromSpec) {
      if (!SCENARIOS[sc]?.covers.includes(id))
        problems.push(`SPEC 说 ${id} 由 ${sc} 覆盖，但 ${sc}.covers 没有它`);
    }
    // 场景 → SPEC：covers 里的 ID 必须存在；若 SPEC 指向某个场景，必须是同一个。
    // 主测试在别处的契约（如 R11 的主测试是 static-reconcile.test.tsx）可以被场景额外覆盖。
    for (const [name, sc] of Object.entries(SCENARIOS)) {
      for (const id of sc.covers) {
        if (!specIds.has(id)) problems.push(`${name}.covers 里的 ${id} 不在 SPEC.md`);
        else if (fromSpec.has(id) && fromSpec.get(id) !== name) {
          problems.push(`${name}.covers 有 ${id}，但 SPEC 指向 ${fromSpec.get(id)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  for (const [name, sc] of Object.entries(SCENARIOS)) {
    test(`${name}（${sc.covers.join(" ")}）与基线一致`, async () => {
      const r = await runScenario(name);
      expect(r.error, r.error).toBeUndefined();
      const actual = summarize(r);
      const file = join(BASELINE_DIR, `${name}.json`);
      if (UPDATE || !existsSync(file)) {
        writeFileSync(file, JSON.stringify(actual, null, 2) + "\n");
        if (!UPDATE) throw new Error(`${name} 没有基线，已生成 ${file}；确认内容后重跑`);
        return;
      }
      const diffs = compareToBaseline(actual, JSON.parse(readFileSync(file, "utf8")));
      expect(diffs, `${name} 与基线不一致：\n${diffs.join("\n")}`).toEqual([]);
    }, 30_000);
  }
});
