/**
 * B7-6 distill-skill-rules.ts 护栏 1 单测
 *
 * 锁死 4 类不变量：
 *   - working_directory 强信号优先
 *   - 路径线索分类（sid-code 路径 / 外部 /project / docs-research）
 *   - 子系统名混合（src/agent/ + src/debug/ ≥ 2 个 sid-code 子系统名 → sid-code）
 *   - 比例计算：unknown 不计入分母（避免被刷分母绕过 30%）
 */
import { describe, test, expect } from "bun:test";
import { classifyTaskSourceRepo, checkExternalRatio } from "../../evals/scripts/distill-skill-rules";

describe("B7-6 classifyTaskSourceRepo", () => {
  test("working_directory 含 sid-code → sid-code", () => {
    const r = classifyTaskSourceRepo({
      task_id: "T0001",
      instruction: { working_directory: "/Users/x/Code/person/sid-code" },
    });
    expect(r.source).toBe("sid-code");
  });

  test("working_directory 指向其他项目 → external", () => {
    const r = classifyTaskSourceRepo({
      task_id: "T0002",
      instruction: { working_directory: "/Users/x/Code/person/docs-research" },
    });
    expect(r.source).toBe("external");
  });

  test("text 含绝对路径 sid-code → sid-code", () => {
    const r = classifyTaskSourceRepo({
      task_id: "T0049",
      instruction: { working_directory: "", text: "在 /Users/x/Code/person/sid-code 项目中..." },
    });
    expect(r.source).toBe("sid-code");
  });

  test("text 含 /project/ 外部路径 → external", () => {
    const r = classifyTaskSourceRepo({
      task_id: "T0002",
      instruction: { working_directory: "", text: "/project/docs-research/foo.md 请阅读" },
    });
    expect(r.source).toBe("external");
  });

  test("text 含 /Users/.../prd/ → external（用户私人 prd 项目）", () => {
    const r = classifyTaskSourceRepo({
      task_id: "T0107",
      instruction: { working_directory: "", text: "'/Users/x/Code/prd/季度汇报.md' 缺一点内容" },
    });
    expect(r.source).toBe("external");
  });

  test("text 同时含 ≥ 2 个 sid-code 子系统名 → sid-code", () => {
    const r = classifyTaskSourceRepo({
      task_id: "T0226",
      instruction: { working_directory: "", text: "梳理 src/debug/、src/trace/、src/telemetry/ 的采集点" },
    });
    expect(r.source).toBe("sid-code");
  });

  test("text 仅含 1 个子系统名 → 不命中子系统规则（仅 1 个不够强）", () => {
    const r = classifyTaskSourceRepo({
      task_id: "T0xx1",
      instruction: { working_directory: "", text: "在 src/agent/ 加一个新 hook" },
    });
    // 仅 src/agent/ 一个，未触发 ≥2 子系统规则；也无字面 sid-code → unknown
    expect(r.source).toBe("unknown");
  });

  test("text 字面 sid-code 关键词 → sid-code", () => {
    const r = classifyTaskSourceRepo({
      task_id: "T0xx2",
      instruction: { working_directory: "", text: "请帮 sid-code 项目加一个工具" },
    });
    expect(r.source).toBe("sid-code");
  });

  test("无任何信号 → unknown", () => {
    const r = classifyTaskSourceRepo({
      task_id: "T0xx3",
      instruction: { working_directory: "", text: "帮我同步一下 master 最新代码到当前分支" },
    });
    expect(r.source).toBe("unknown");
  });

  test("github.com 显式外部仓库（不带 sid-code） → external", () => {
    const r = classifyTaskSourceRepo({
      task_id: "T0xx4",
      instruction: { working_directory: "", text: "github.com/facebook/react 这个 repo 有个 bug" },
    });
    expect(r.source).toBe("external");
  });
});

describe("B7-6 checkExternalRatio", () => {
  const mk = (id: string, source: "sid-code" | "external" | "unknown") => ({
    taskId: id,
    source,
    evidence: "test",
  });

  test("external/total 严格 ≥ 30% → pass", () => {
    // 3 external + 7 sid-code → external/(3+7) = 30% (=阈值边界, 等于 = pass)
    const r = checkExternalRatio([
      mk("T1", "external"), mk("T2", "external"), mk("T3", "external"),
      mk("T4", "sid-code"), mk("T5", "sid-code"), mk("T6", "sid-code"),
      mk("T7", "sid-code"), mk("T8", "sid-code"), mk("T9", "sid-code"),
      mk("T10", "sid-code"),
    ]);
    expect(r.passed).toBe(true);
    expect(r.externalCount).toBe(3);
    expect(r.sidCount).toBe(7);
    expect(r.externalRatio).toBeCloseTo(0.30, 5);
  });

  test("external_ratio < 30% → reject + 给出原因", () => {
    const r = checkExternalRatio([
      mk("T1", "external"),
      mk("T2", "sid-code"), mk("T3", "sid-code"), mk("T4", "sid-code"),
    ]);
    expect(r.passed).toBe(false);
    expect(r.externalRatio).toBeCloseTo(0.25, 5);
    expect(r.rejectReasons?.[0]).toContain("external_ratio");
  });

  test("unknown 不计入分母（防被刷比例）", () => {
    // 3 external + 0 sid-code + 100 unknown → ratio=100% (不是 3/103 = 2.9%)
    const r = checkExternalRatio([
      mk("T1", "external"), mk("T2", "external"), mk("T3", "external"),
      ...Array.from({ length: 100 }, (_, i) => mk(`U${i}`, "unknown" as const)),
    ]);
    expect(r.passed).toBe(true);
    expect(r.externalRatio).toBe(1.0);
    expect(r.sidCount).toBe(0);
    expect(r.externalCount).toBe(3);
    expect(r.unknownCount).toBe(100);
  });

  test("全 unknown → reject（分母 0 无法判定）", () => {
    const r = checkExternalRatio([
      mk("T1", "unknown"), mk("T2", "unknown"),
    ]);
    expect(r.passed).toBe(false);
    expect(r.rejectReasons?.[0]).toContain("0");
  });

  test("空输入 → reject", () => {
    const r = checkExternalRatio([]);
    expect(r.passed).toBe(false);
    expect(r.total).toBe(0);
  });

  test("阈值参数可调（threshold=0.5 时 30% 不够过）", () => {
    const r = checkExternalRatio(
      [mk("T1", "external"), mk("T2", "sid-code"), mk("T3", "sid-code")],
      0.5,
    );
    expect(r.passed).toBe(false);
    expect(r.externalRatio).toBeCloseTo(0.333, 2);
  });
});
