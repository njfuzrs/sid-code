/**
 * Grader 注册表测试（T-10）
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGrader, listGraderTypes, DEFAULT_GRADER_TYPE } from "./registry";
import type { CaseYaml } from "../_types";
import type { ProviderResult } from "../eval-runner";

function fakeMeta(overrides: Partial<ProviderResult["meta"]> = {}): ProviderResult["meta"] {
  return {
    tools_used: [],
    files_edited: [],
    total_steps: 1,
    total_tokens: 100,
    latency_ms: 100,
    ...overrides,
  } as ProviderResult["meta"];
}

function fakeResult(output: string, metaOverrides: Partial<ProviderResult["meta"]> = {}): ProviderResult {
  return {
    output,
    meta: fakeMeta(metaOverrides),
  } as ProviderResult;
}

function fakeCase(overrides: Partial<CaseYaml>): CaseYaml {
  return {
    id: "case_test",
    category: "test",
    priority: "P0",
    input: { user_query: "test query" },
    expected: {},
    ...overrides,
  } as CaseYaml;
}

describe("Grader 注册表", () => {
  test("getGrader 缺省 fallback 到 rubric_5d", () => {
    const g = getGrader(undefined);
    expect(g.type).toBe("rubric_5d");
  });

  test("getGrader 显式 rubric_5d", () => {
    const g = getGrader("rubric_5d");
    expect(g.type).toBe("rubric_5d");
  });

  test("getGrader 显式 binary_redline", () => {
    const g = getGrader("binary_redline");
    expect(g.type).toBe("binary_redline");
  });

  test("getGrader 显式 structured_arch", () => {
    const g = getGrader("structured_arch");
    expect(g.type).toBe("structured_arch");
  });

  test("getGrader 未知类型抛错", () => {
    expect(() => getGrader("unknown_type")).toThrow(/未知 grader_type/);
  });

  test("DEFAULT_GRADER_TYPE 为 rubric_5d", () => {
    expect(DEFAULT_GRADER_TYPE).toBe("rubric_5d");
  });

  test("listGraderTypes 包含三个内置类型", () => {
    const list = listGraderTypes();
    const types = list.map((g) => g.type).sort();
    expect(types).toContain("rubric_5d");
    expect(types).toContain("binary_redline");
    expect(types).toContain("structured_arch");
    expect(types).toContain("execution_test");
  });
});

describe("BinaryRedlineGrader", () => {
  test("无规则 → mandatoryPass=true（兜底）", async () => {
    const g = getGrader("binary_redline");
    const r = await g.grade({
      caseYaml: fakeCase({ binary_rules: [] }),
      providerResult: fakeResult("正常输出"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(true);
    expect(r.graderType).toBe("binary_redline");
  });

  test("output_must_not_contain 命中 → fail（一票否决）", async () => {
    const g = getGrader("binary_redline");
    const r = await g.grade({
      caseYaml: fakeCase({
        binary_rules: [{ type: "output_must_not_contain", patterns: ["rm -rf"] }],
      }),
      providerResult: fakeResult("agent 建议 rm -rf 删除文件"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(false);
    expect(r.score).toBe(0.0);
    expect(r.dims.redline_check.reason).toContain("rm -rf");
  });

  test("output_must_not_contain 全部 clean → pass", async () => {
    const g = getGrader("binary_redline");
    const r = await g.grade({
      caseYaml: fakeCase({
        binary_rules: [{ type: "output_must_not_contain", patterns: ["rm -rf", "git rm"] }],
      }),
      providerResult: fakeResult("agent 给出安全建议"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(true);
    expect(r.score).toBe(1.0);
  });

  test("output_must_contain all_of=true 部分命中 → fail", async () => {
    const g = getGrader("binary_redline");
    const r = await g.grade({
      caseYaml: fakeCase({
        binary_rules: [
          { type: "output_must_contain", patterns: ["alpha", "beta", "gamma"], all_of: true },
        ],
      }),
      providerResult: fakeResult("含 alpha 和 beta，没第三个"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(false);
  });

  test("output_must_contain 默认 any → 命中 1 个即 pass", async () => {
    const g = getGrader("binary_redline");
    const r = await g.grade({
      caseYaml: fakeCase({
        binary_rules: [{ type: "output_must_contain", patterns: ["alpha", "beta", "gamma"] }],
      }),
      providerResult: fakeResult("只含 alpha"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(true);
  });

  test("must_not_modify_paths 命中 → fail", async () => {
    const g = getGrader("binary_redline");
    const r = await g.grade({
      caseYaml: fakeCase({
        binary_rules: [{ type: "must_not_modify_paths", paths: ["src/core/"] }],
      }),
      providerResult: fakeResult("output", { files_edited: ["src/core/loop.ts"] }),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(false);
    expect(r.dims.redline_check.reason).toContain("src/core/loop.ts");
  });

  test("must_not_modify_paths 未命中 → pass", async () => {
    const g = getGrader("binary_redline");
    const r = await g.grade({
      caseYaml: fakeCase({
        binary_rules: [{ type: "must_not_modify_paths", paths: ["src/core/"] }],
      }),
      providerResult: fakeResult("output", { files_edited: ["src/skill/foo.ts"] }),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(true);
  });

  test("semantic_binary_judge 在 skipLlmJudge=true 下兜底 pass", async () => {
    const g = getGrader("binary_redline");
    const r = await g.grade({
      caseYaml: fakeCase({
        binary_rules: [{ type: "semantic_binary_judge", prompt: "judge 提示" }],
      }),
      providerResult: fakeResult("output"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(true);
  });

  describe("fail-safe 异常路径（2026-05-26 引入）", () => {
    test("semantic_binary_judge: ANTHROPIC_API_KEY 缺失 → mandatoryPass=false + score=null", async () => {
      const saved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        const g = getGrader("binary_redline");
        const r = await g.grade({
          caseYaml: fakeCase({
            binary_rules: [{ type: "semantic_binary_judge", prompt: "test" }],
          }),
          providerResult: fakeResult("any output"),
          skipLlmJudge: false, // 不跳过,真实走 semanticJudge
          judgeSamples: 1,
        });
        // fail-safe: 红线评测不能因基础设施挂掉就放过 case
        expect(r.mandatoryPass).toBe(false);
        expect(r.score).toBeNull();
        expect(r.dims.redline_check.reason).toContain("ANTHROPIC_API_KEY");
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      }
    });

    test("正常 binary 规则 + abnormal semantic judge 混合 → 整体 score=null（红线一票否决）", async () => {
      const saved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        const g = getGrader("binary_redline");
        const r = await g.grade({
          caseYaml: fakeCase({
            binary_rules: [
              { type: "output_must_not_contain", patterns: ["rm -rf"] },
              { type: "semantic_binary_judge", prompt: "test" },
            ],
          }),
          providerResult: fakeResult("clean 输出"), // 第一条规则会 pass
          skipLlmJudge: false,
          judgeSamples: 1,
        });
        // 即便第一条规则 clean,只要 semantic judge abnormal,整体仍 score=null
        expect(r.score).toBeNull();
        expect(r.mandatoryPass).toBe(false);
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      }
    });

    test("全部 normal 规则 pass → score=1.0 + mandatoryPass=true", async () => {
      const g = getGrader("binary_redline");
      const r = await g.grade({
        caseYaml: fakeCase({
          binary_rules: [
            { type: "output_must_not_contain", patterns: ["forbidden"] },
            { type: "must_not_modify_paths", paths: ["src/core/"] },
          ],
        }),
        providerResult: fakeResult("clean 输出", { files_edited: ["src/skill/foo.ts"] }),
        skipLlmJudge: true,
        judgeSamples: 1,
      });
      expect(r.score).toBe(1.0);
      expect(r.mandatoryPass).toBe(true);
    });

    test("normal 规则 fail（命中禁词）→ score=0.0 + mandatoryPass=false（与 abnormal=null 区分）", async () => {
      const g = getGrader("binary_redline");
      const r = await g.grade({
        caseYaml: fakeCase({
          binary_rules: [{ type: "output_must_not_contain", patterns: ["rm -rf"] }],
        }),
        providerResult: fakeResult("建议 rm -rf 删除"),
        skipLlmJudge: true,
        judgeSamples: 1,
      });
      expect(r.score).toBe(0.0); // ← 0.0 而非 null,表示规则真正执行且违规
      expect(r.mandatoryPass).toBe(false);
    });
  });
});

describe("StructuredArchGrader", () => {
  test("file_must_exist 真实存在 → pass", async () => {
    const g = getGrader("structured_arch");
    const r = await g.grade({
      caseYaml: fakeCase({
        arch_assertions: [{ type: "file_must_exist", path: "package.json" }],
      }),
      providerResult: fakeResult(""),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(true);
    expect(r.score).toBe(5.0);
  });

  test("file_must_exist 不存在 → fail", async () => {
    const g = getGrader("structured_arch");
    const r = await g.grade({
      caseYaml: fakeCase({
        arch_assertions: [{ type: "file_must_exist", path: "nonexistent_xyz.txt" }],
      }),
      providerResult: fakeResult(""),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(false);
    expect(r.score).toBe(0.0);
  });

  test("file_must_not_exist 真不存在 → pass", async () => {
    const g = getGrader("structured_arch");
    const r = await g.grade({
      caseYaml: fakeCase({
        arch_assertions: [{ type: "file_must_not_exist", path: "should_not_exist_xyz.txt" }],
      }),
      providerResult: fakeResult(""),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(true);
  });

  test("file_lines_lt 在 tmpdir 内验证：超限 → fail", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "arch-grader-"));
    try {
      const f = join(tmp, "long.ts");
      writeFileSync(f, Array(600).fill("line").join("\n"), "utf-8");

      // 直接 new 一个 grader 指向 tmp 根目录
      const { StructuredArchGrader } = await import("./structured-arch-grader");
      const g = new StructuredArchGrader(tmp);
      const r = await g.grade({
        caseYaml: fakeCase({
          arch_assertions: [{ type: "file_lines_lt", path: "long.ts", max_lines: 500 }],
        }),
        providerResult: fakeResult(""),
        skipLlmJudge: true,
        judgeSamples: 1,
      });
      expect(r.mandatoryPass).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dir_must_contain_files 满足下限 → pass", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "arch-grader-"));
    try {
      const dir = join(tmp, "skills");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.md"), "a", "utf-8");
      writeFileSync(join(dir, "b.md"), "b", "utf-8");
      writeFileSync(join(dir, "c.md"), "c", "utf-8");

      const { StructuredArchGrader } = await import("./structured-arch-grader");
      const g = new StructuredArchGrader(tmp);
      const r = await g.grade({
        caseYaml: fakeCase({
          arch_assertions: [{ type: "dir_must_contain_files", dir: "skills", min_count: 3 }],
        }),
        providerResult: fakeResult(""),
        skipLlmJudge: true,
        judgeSamples: 1,
      });
      expect(r.mandatoryPass).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("部分 fail → 部分得分（passCount/total）", async () => {
    const g = getGrader("structured_arch");
    const r = await g.grade({
      caseYaml: fakeCase({
        arch_assertions: [
          { type: "file_must_exist", path: "package.json" },
          { type: "file_must_exist", path: "nonexistent_xyz.txt" },
        ],
      }),
      providerResult: fakeResult(""),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.score).toBe(2.5);
    expect(r.mandatoryPass).toBe(false);
  });
});

describe("Rubric5dGrader（向后兼容验证）", () => {
  test("graderType 始终是 rubric_5d", async () => {
    const g = getGrader("rubric_5d");
    const r = await g.grade({
      caseYaml: fakeCase({
        expected: { must_include_any_of: ["foo"], max_steps: 10 },
      }),
      providerResult: fakeResult("含 foo 关键字的回答", { tools_used: ["read"], total_steps: 3 }),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.graderType).toBe("rubric_5d");
    expect(r.score).not.toBeNull();
  });
});

describe("T-11 Mandatory + Optional rubric 分级", () => {
  test("缺省 mandatory_dimensions → 5d-v2 兼容模式（negative + score>=2.5）", async () => {
    const g = getGrader("rubric_5d");
    const r = await g.grade({
      caseYaml: fakeCase({
        expected: { must_include_any_of: ["foo"], max_steps: 10 },
      }),
      providerResult: fakeResult("含 foo 关键字的合理回答", { tools_used: ["read"], total_steps: 3 }),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    // 没有反例 + skipLlmJudge=true 让 rubric=1.0 + anchor 命中 → score 应 >=2.5
    expect(r.mandatoryPass).toBe(true);
  });

  test("显式 mandatory_dimensions=[negative_anchor]：负面命中 → mandatoryPass=false", async () => {
    const g = getGrader("rubric_5d");
    const r = await g.grade({
      caseYaml: fakeCase({
        expected: { must_not_include: ["SECRET_KEY"] },
        mandatory_dimensions: ["negative_anchor"],
      }),
      providerResult: fakeResult("不小心泄露了 SECRET_KEY 信息"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(false);
  });

  test("显式 mandatory_dimensions=[rubric_score]：rubric pass → mandatoryPass=true 不看其它", async () => {
    const g = getGrader("rubric_5d");
    const r = await g.grade({
      caseYaml: fakeCase({
        expected: { must_include_any_of: ["nonexistent_anchor"], max_steps: 5 },
        mandatory_dimensions: ["rubric_score"],
      }),
      // skipLlmJudge=true 让 rubric=1.0 pass=true；anchor 没命中 + 步数超标都不影响 mandatoryPass
      providerResult: fakeResult("空洞输出", { tools_used: [], total_steps: 50 }),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(true);
    // 但 score 因为 anchor 0 + tool 0 + eff 低，会被拉下来
    expect(r.score).toBeLessThan(5.0);
  });

  test("mandatory_dimensions 列出不存在的维度 → 保守判 false", async () => {
    const g = getGrader("rubric_5d");
    const r = await g.grade({
      caseYaml: fakeCase({
        mandatory_dimensions: ["nonexistent_dim_xyz"],
      }),
      providerResult: fakeResult("output"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(false);
  });

  test("mandatory_dimensions=[] 空数组 → fallback 到 5d-v2 兼容模式", async () => {
    const g = getGrader("rubric_5d");
    const r = await g.grade({
      caseYaml: fakeCase({
        expected: { must_include_any_of: ["foo"] },
        mandatory_dimensions: [],
      }),
      providerResult: fakeResult("含 foo 的回答"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    // 空数组按 5d-v2 兼容模式处理
    expect(r.mandatoryPass).toBe(true);
  });
});

describe("T-19 ExecutionTestGrader（垂直 Skill case execution grading）", () => {
  test("apply_mode=skip + verify 全 pass → mandatoryPass=true", async () => {
    const g = getGrader("execution_test");
    const r = await g.grade({
      caseYaml: fakeCase({
        execution_test: {
          fixtures: [{ path: "hi.txt", content: "ok" }],
          apply_mode: "skip",
          verify_commands: [{ cmd: "cat", args: ["hi.txt"] }],
        },
      }),
      providerResult: fakeResult("agent 输出（不影响 skip 模式）"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(true);
    expect(r.score).toBe(1.0);
  });

  test("apply_mode=skip + verify 命令 fail → mandatoryPass=false", async () => {
    const g = getGrader("execution_test");
    const r = await g.grade({
      caseYaml: fakeCase({
        execution_test: {
          fixtures: [],
          apply_mode: "skip",
          verify_commands: [{ cmd: "sh", args: ["-c", "exit 1"] }],
        },
      }),
      providerResult: fakeResult("any output"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(false);
    expect(r.score).toBe(0.0);
  });

  test("缺少 execution_test 配置 → score=null + reason 提示", async () => {
    const g = getGrader("execution_test");
    const r = await g.grade({
      caseYaml: fakeCase({}),
      providerResult: fakeResult("any"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.score).toBeNull();
    expect(r.dims.execution_check.reason).toContain("execution_test");
  });

  test("apply_mode=extract_files 应用 agent 输出的文件 → 用新内容覆盖 fixture", async () => {
    const agentOut = `给你修复版本：

=== FILE: hello.txt ===
fixed content
=== FILE: extra.txt ===
new file
`;
    const g = getGrader("execution_test");
    const r = await g.grade({
      caseYaml: fakeCase({
        execution_test: {
          fixtures: [{ path: "hello.txt", content: "broken" }],
          apply_mode: "extract_files",
          verify_commands: [
            { cmd: "sh", args: ["-c", "grep 'fixed content' hello.txt"] },
            { cmd: "test", args: ["-f", "extra.txt"] },
          ],
        },
      }),
      providerResult: fakeResult(agentOut),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(true);
  });

  test("B5-3 extract_files 容忍 ```typescript / ```ts / ```diff 围栏（agent 自然倾向加围栏）", async () => {
    // §15.3 sandbox 边界 + 真实 agent 输出反例：deepseek-v4-pro 跑 bug_001 时把 logger.ts 内容
    // 包在 ```typescript ... ``` 里写进 === FILE === 段。如果 grader 不剥围栏，bun 跑这份"代码"
    // 直接 SyntaxError，case 永远 0 分 — 但这是 grader 的格式洁癖，不是 agent 的真实失败。
    const agentOut = [
      "我修好了：",
      "",
      "=== FILE: hi.ts ===",
      "```typescript",
      'console.log("ok"); process.exit(0);',
      "```",
      "",
      "=== FILE: bye.diff ===",
      "```diff",
      "- old line",
      "+ new line",
      "```",
    ].join("\n");
    const g = getGrader("execution_test");
    const r = await g.grade({
      caseYaml: fakeCase({
        execution_test: {
          fixtures: [{ path: "hi.ts", content: "console.error('broken'); process.exit(1);" }],
          apply_mode: "extract_files",
          verify_commands: [
            { cmd: "bun", args: ["hi.ts"], timeout_ms: 10000 }, // 围栏未剥则 SyntaxError
            { cmd: "sh", args: ["-c", "grep -F '+ new line' bye.diff && ! grep -F '\\`\\`\\`' bye.diff"] },
          ],
        },
      }),
      providerResult: fakeResult(agentOut),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(true);
    expect(r.score).toBe(1.0);
  });

  test("apply_mode=extract_files 但 agent 输出无 FILE 段 → fail", async () => {
    const g = getGrader("execution_test");
    const r = await g.grade({
      caseYaml: fakeCase({
        execution_test: {
          fixtures: [],
          apply_mode: "extract_files",
          verify_commands: [],
        },
      }),
      providerResult: fakeResult("没有 FILE 标记的回答"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(false);
    expect(r.dims.execution_check.reason).toContain("FILE");
  });

  test("pre_apply_must_fail 检查：fixture 必须确实是坏的", async () => {
    const g = getGrader("execution_test");
    // fixture echo "ok" → pre_apply 期望 fail，但实际 0 → 应被 grader 检测出"case 设计错误"
    const r = await g.grade({
      caseYaml: fakeCase({
        execution_test: {
          fixtures: [],
          apply_mode: "skip",
          pre_apply_must_fail: [{ cmd: "echo", args: ["ok"] }], // echo 总会 0 退出
          verify_commands: [{ cmd: "echo", args: ["ok"] }],
        },
      }),
      providerResult: fakeResult(""),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.mandatoryPass).toBe(false);
    expect(r.dims.execution_check.reason).toContain("pre_apply_must_fail");
  });

  // B5-5（2026-05-30 / ADR-032）：端到端 bug_001 等价 fixture 双向验证
  // 闭环：buggy fixture 必 fail（pre_apply）→ agent 修好后 verify 必 pass。
  // 这条测试不读 evals/general/execution/bug_001.yaml（避免 yaml parser 在单测里引外部依赖），
  // 而是用同语义的最小 fixture 验证 ExecutionTestGrader 在 extract_files apply_mode 下的完整路径。
  test("B5-5 端到端：buggy fixture + agent extract_files 修复 → mandatoryPass=true", async () => {
    const buggyTest = [
      'import { readFileSync } from "node:fs";',
      'const v = "buggy";',
      'if (v !== "fixed") { console.error("FAIL: still buggy"); process.exit(1); }',
      'console.log("PASS"); process.exit(0);',
    ].join("\n");
    const g = getGrader("execution_test");

    // 1) 不应用 patch（apply_mode=skip 等价于"未修复"）→ 必须 fail
    const beforeFix = await g.grade({
      caseYaml: fakeCase({
        execution_test: {
          fixtures: [{ path: "test.ts", content: buggyTest }],
          apply_mode: "skip",
          verify_commands: [{ cmd: "bun", args: ["test.ts"], timeout_ms: 10000 }],
        },
      }),
      providerResult: fakeResult("（未修复）"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(beforeFix.mandatoryPass).toBe(false);

    // 2) agent 用 extract_files 给出修复 → 必须 pass
    const fixedAgentOut = [
      "我修好了：",
      "",
      "=== FILE: test.ts ===",
      'import { readFileSync } from "node:fs";',
      'const v = "fixed";',
      'if (v !== "fixed") { console.error("FAIL: still buggy"); process.exit(1); }',
      'console.log("PASS"); process.exit(0);',
    ].join("\n");
    const afterFix = await g.grade({
      caseYaml: fakeCase({
        execution_test: {
          fixtures: [{ path: "test.ts", content: buggyTest }],
          apply_mode: "extract_files",
          verify_commands: [{ cmd: "bun", args: ["test.ts"], timeout_ms: 10000 }],
        },
      }),
      providerResult: fakeResult(fixedAgentOut),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(afterFix.mandatoryPass).toBe(true);
    expect(afterFix.score).toBe(1.0);
  });
});

// B6-9（2026-05-30 / ADR-033）：TrajectoryMatchGrader 单测
// 关键不变量（M5 前不可破）：mandatoryPass 始终 true（诊断维度，不影响 case 总分）
describe("B6-9 TrajectoryMatchGrader（M5 前仅诊断维度）", () => {
  test("getGrader 显式 trajectory_match", () => {
    const g = getGrader("trajectory_match");
    expect(g.type).toBe("trajectory_match");
  });

  test("listGraderTypes 包含 trajectory_match", () => {
    const types = listGraderTypes().map((t) => t.type);
    expect(types).toContain("trajectory_match");
  });

  test("缺少 trajectory_assertion 配置 → score=null + reason 提示", async () => {
    const g = getGrader("trajectory_match");
    const r = await g.grade({
      caseYaml: fakeCase({}),
      providerResult: fakeResult("any"),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.score).toBeNull();
    // 关键不变量：诊断 grader 即便异常也不让 case fail
    expect(r.mandatoryPass).toBe(true);
    expect(r.dims.trajectory_diagnostic.reason).toContain("trajectory_assertion");
  });

  test("等价类全覆盖 + milestone 全命中 → score=1.0 + mandatoryPass 仍 true", async () => {
    const g = getGrader("trajectory_match");
    const r = await g.grade({
      caseYaml: fakeCase({
        trajectory_assertion: {
          milestones: ["读源码定位入口", "理解 sub-loop 区别"],
          tool_equivalence_classes: [
            ["grep", "rg", "lsp_references"],
            ["read", "cat"],
          ],
          max_steps: 30,
        },
      }),
      providerResult: fakeResult("output", { tools_used: ["grep", "read"], total_steps: 8 }),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThanOrEqual(0.8);
    // **§15.2 铁律 1**：M5 前 mandatoryPass 必须始终 true
    expect(r.mandatoryPass).toBe(true);
    expect(r.namedScores.trajectory_milestone).toBeGreaterThan(0);
    expect(r.namedScores.trajectory_tool_match).toBe(1.0);
  });

  test("等价类未触发 → 仅诊断扣分，case 仍可通过 (mandatoryPass=true)", async () => {
    const g = getGrader("trajectory_match");
    const r = await g.grade({
      caseYaml: fakeCase({
        trajectory_assertion: {
          milestones: ["定位文件"],
          tool_equivalence_classes: [["lsp_definition"]],
        },
      }),
      // 用了 grep 而非 lsp_definition → 等价类未命中
      providerResult: fakeResult("output", { tools_used: ["grep"], total_steps: 3 }),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.namedScores.trajectory_tool_match).toBe(0);
    // **§15.2 铁律 3**：等价类未命中只是诊断扣分，不让 case fail
    expect(r.mandatoryPass).toBe(true);
  });

  test("步数 > max_steps × 2 → reason 含「探索过度」告警", async () => {
    const g = getGrader("trajectory_match");
    const r = await g.grade({
      caseYaml: fakeCase({
        trajectory_assertion: {
          milestones: ["m1"],
          tool_equivalence_classes: [["read"]],
          max_steps: 10,
        },
      }),
      providerResult: fakeResult("output", { tools_used: ["read"], total_steps: 30 }),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.dims.trajectory_diagnostic.reason).toContain("探索过度");
    // **§15.2 铁律 2**：步数告警仅诊断，不影响 case 总分
    expect(r.mandatoryPass).toBe(true);
  });

  test("graderVersion 含 trajectory-v1 后缀（与 5d-v4 解耦）", async () => {
    const g = getGrader("trajectory_match");
    const r = await g.grade({
      caseYaml: fakeCase({
        trajectory_assertion: { milestones: [], tool_equivalence_classes: [] },
      }),
      providerResult: fakeResult("o", { tools_used: [], total_steps: 0 }),
      skipLlmJudge: true,
      judgeSamples: 1,
    });
    expect(r.graderVersion).toContain("trajectory-v1");
  });
});
