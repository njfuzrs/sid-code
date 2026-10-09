/**
 * 组件级场景 C1–C2 双底座差分（B9 / T4.2，设计文档阶段 4 出口：历史区 + MainScreenLayout 骨架，S3 的组件版）。
 *
 * 判定与引擎级场景相同（compareToBaseline，以 legacy 为基线）：网格、scrollback、光标、模式逐项一致，
 * full reset 次数与字节数不超过 legacy 的 1.1 倍。卸载后那一步不比（生命周期归 T7.x）。
 */
import { describe, expect, test } from "bun:test";
import { compareToBaseline, EXIT_LABEL, runScenario, summarize } from "./harness.ts";
import { COMPONENT_SCENARIOS } from "./component-scenarios.tsx";

const run = async (name: string, renderer: "legacy" | "next") => {
  const r = await runScenario(name, { env: { SID_TUI_RENDERER: renderer } });
  if (r.error) throw new Error(`${renderer} ${name}: ${r.error}`);
  const s = summarize(r);
  return { ...s, steps: s.steps.filter((st) => st.label !== EXIT_LABEL) };
};

describe("组件级场景 C1–C2（legacy ↔ next）", () => {
  for (const name of Object.keys(COMPONENT_SCENARIOS)) {
    test(`${name} ${COMPONENT_SCENARIOS[name]!.covers.join(" ")}`, async () => {
      const [legacy, next] = await Promise.all([run(name, "legacy"), run(name, "next")]);
      expect(compareToBaseline(next, legacy)).toEqual([]);
    }, 30_000);
  }

  test("C2：屏外项完成恰好触发一次 full reset（不多闪，也不因少闪留下残影）", async () => {
    const next = await run("C2", "next");
    const last = next.steps.find((s) => s.label === "屏外项完成")!;
    expect(last.metrics.eraseScreen).toBe(1);
  }, 30_000);
});
