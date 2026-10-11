/**
 * 组件级场景 C1–C3（B9 / T4.2，设计文档阶段 4 出口：历史区 + MainScreenLayout 骨架，S3 的组件版）。
 *
 * 判定与引擎级场景相同（compareToBaseline），对冻结的 legacy 基线 `baseline/C*.json`：
 * 网格、scrollback、光标、模式逐项一致，full reset 次数与字节数不超过基线的 1.1 倍。卸载后那一步不比。
 * 基线来源与「不能重生成」的约束见 engine.test.ts 文件头。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareToBaseline, EXIT_LABEL, runScenario, summarize } from "./harness.ts";
import { COMPONENT_SCENARIOS } from "./component-scenarios.tsx";

const BASELINE_DIR = join(import.meta.dir, "baseline");

/** C 场景的冻结基线是在 darwin 上采的（行首 bullet 是 ⏺），跨平台跑要钉住 */
const FROZEN_PLATFORM = "darwin";

const run = async (name: string) => {
  const r = await runScenario(name, { env: { BENCH_PLATFORM: FROZEN_PLATFORM } });
  if (r.error) throw new Error(`${name}: ${r.error}`);
  const s = summarize(r);
  return { ...s, steps: s.steps.filter((st) => st.label !== EXIT_LABEL) };
};

describe("组件级场景 C1–C3（对冻结 legacy 基线）", () => {
  for (const name of Object.keys(COMPONENT_SCENARIOS)) {
    test(`${name} ${COMPONENT_SCENARIOS[name]!.covers.join(" ")}`, async () => {
      const baseline = JSON.parse(readFileSync(join(BASELINE_DIR, `${name}.json`), "utf8"));
      expect(compareToBaseline(await run(name), baseline)).toEqual([]);
    }, 30_000);
  }

  test("C2：屏外项完成恰好触发一次 full reset（不多闪，也不因少闪留下残影）", async () => {
    const next = await run("C2");
    const last = next.steps.find((s) => s.label === "屏外项完成")!;
    expect(last.metrics.eraseScreen).toBe(1);
  }, 30_000);
});
