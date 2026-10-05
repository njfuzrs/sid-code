/**
 * 引擎级场景 E1–E7 双底座差分（B9 / T3.2，设计文档阶段 3 出口）。
 *
 * 每个场景在 legacy 与 next 上各跑一遍，用 S 场景同一套判定（compareToBaseline）以 legacy 为基线比较：
 * 网格、scrollback、光标、模式逐项一致，full reset 次数与字节数不超过 legacy 的 1.1 倍。
 * 卸载后那一步不比：卸载时恢复终端模式、清进度 / tab 状态属于生命周期（X 组，T7.x），新底座还没做。
 */
import { describe, expect, test } from "bun:test";
import { compareToBaseline, EXIT_LABEL, runScenario, summarize } from "./harness.ts";
import { ENGINE_SCENARIOS } from "./engine-scenarios.tsx";

const run = async (name: string, renderer: "legacy" | "next") => {
  const r = await runScenario(name, { env: { SID_TUI_RENDERER: renderer } });
  if (r.error) throw new Error(`${renderer} ${name}: ${r.error}`);
  const s = summarize(r);
  return { ...s, steps: s.steps.filter((st) => st.label !== EXIT_LABEL) };
};

describe("引擎级场景 E1–E7（legacy ↔ next）", () => {
  for (const name of Object.keys(ENGINE_SCENARIOS)) {
    test(`${name} ${ENGINE_SCENARIOS[name]!.covers.join(" ")}`, async () => {
      const [legacy, next] = await Promise.all([run(name, "legacy"), run(name, "next")]);
      expect(compareToBaseline(next, legacy)).toEqual([]);
    }, 30_000);
  }

  test("E5：同一 tick 5 次提交合并成 2 帧；5 次 store 更新被 React 批成 1 帧（R2）", async () => {
    const r = await runScenario("E5", { env: { SID_TUI_RENDERER: "next" } });
    expect(r.notes).toEqual({ "store-burst-frames": "1", "commit-burst-frames": "2" });
  }, 30_000);
});
