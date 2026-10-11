/**
 * 引擎级场景 E1–E10（B9 / T3.2–T3.3，设计文档阶段 3 出口）。
 *
 * 用 S 场景同一套判定（compareToBaseline）对冻结的 legacy 基线 `baseline/E*.json` 比较：
 * 网格、scrollback、光标、模式逐项一致，full reset 次数与字节数不超过基线的 1.1 倍。
 * 卸载后那一步不比（生命周期归 X 组，单独有契约测试）。
 *
 * 基线是 T9.1 删除旧底座前用 legacy 现场生成后入库的（两次生成逐字节一致），旧底座已不在仓库，
 * 所以**不能重生成**：next 的行为若有意变化，改 JSON 并在 PR 里逐项说明。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareToBaseline, EXIT_LABEL, runScenario, summarize } from "./harness.ts";
import { ENGINE_SCENARIOS } from "./engine-scenarios.tsx";

const BASELINE_DIR = join(import.meta.dir, "baseline");

const run = async (name: string) => {
  const r = await runScenario(name);
  if (r.error) throw new Error(`${name}: ${r.error}`);
  const s = summarize(r);
  return { ...s, steps: s.steps.filter((st) => st.label !== EXIT_LABEL) };
};

describe("引擎级场景 E1–E10（对冻结 legacy 基线）", () => {
  for (const name of Object.keys(ENGINE_SCENARIOS)) {
    test(`${name} ${ENGINE_SCENARIOS[name]!.covers.join(" ")}`, async () => {
      const baseline = JSON.parse(readFileSync(join(BASELINE_DIR, `${name}.json`), "utf8"));
      expect(compareToBaseline(await run(name), baseline)).toEqual([]);
    }, 30_000);
  }

  test("E5：同一 tick 5 次提交合并成 2 帧；5 次 store 更新被 React 批成 1 帧（R2）", async () => {
    const r = await runScenario("E5");
    expect(r.notes).toEqual({ "store-burst-frames": "1", "commit-burst-frames": "2" });
  }, 30_000);
});
