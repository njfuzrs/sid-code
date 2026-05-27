/**
 * capability-shared 单元测试
 *
 * 覆盖 evals/a.md 诊断的两个 P0 infra_bug 修复：
 *   1) aggregateCapabilityScore：skip-llm-judge 模式下 weight 不蒸发
 *   2) runSharedCheck：final_response_must_include_any_of_hit / must_not_include_zero_hit echo 排除
 */

import { describe, expect, test } from "bun:test";
import {
  aggregateCapabilityScore,
  classifyEchoKeywords,
  excludeEchoKeywords,
  isCodeIdentifier,
  medianSuccessScore,
  pickRunStatus,
  runSharedCheck,
  type GraderRule,
  type SharedGraderInput,
} from "../../evals/bench-runner/capability-shared.ts";

// ============================================================
// isCodeIdentifier
// ============================================================

describe("isCodeIdentifier — 代码标识符 / 路径豁免规则", () => {
  test("snake_case → true", () => {
    expect(isCodeIdentifier("user_id")).toBe(true);
    expect(isCodeIdentifier("MAX_RETRY_COUNT")).toBe(true);
  });

  test("含 . / / → true（路径 / 文件名）", () => {
    expect(isCodeIdentifier("package.json")).toBe(true);
    expect(isCodeIdentifier("src/llm/")).toBe(true);
    expect(isCodeIdentifier("registry.ts")).toBe(true);
  });

  test("camelCase / PascalCase → true", () => {
    expect(isCodeIdentifier("createProvider")).toBe(true);
    expect(isCodeIdentifier("UserService")).toBe(true);
    expect(isCodeIdentifier("AnthropicProvider")).toBe(true);
  });

  test("含大写的产品名 → true", () => {
    expect(isCodeIdentifier("TypeScript")).toBe(true);
    expect(isCodeIdentifier("PostgreSQL")).toBe(true);
    expect(isCodeIdentifier("Vue 3")).toBe(true);
  });

  test("全大写缩写 ≥ 2 → true", () => {
    expect(isCodeIdentifier("JWT")).toBe(true);
    expect(isCodeIdentifier("SDK")).toBe(true);
  });

  test("反引号 → true", () => {
    expect(isCodeIdentifier("`code`")).toBe(true);
  });

  test("纯小写自然语言 → false（应被 echo 排除）", () => {
    expect(isCodeIdentifier("postgres")).toBe(false);
    expect(isCodeIdentifier("anthropic")).toBe(false);
    expect(isCodeIdentifier("hello world")).toBe(false);
  });

  test("中文短语 → false", () => {
    expect(isCodeIdentifier("数")).toBe(false);
    expect(isCodeIdentifier("总数")).toBe(false);
  });
});

// ============================================================
// excludeEchoKeywords
// ============================================================

describe("excludeEchoKeywords — 题面 echo 排除", () => {
  test("无 userQuery → 全部保留", () => {
    const r = excludeEchoKeywords(["a", "b"], undefined);
    expect(r.filtered).toEqual(["a", "b"]);
    expect(r.echoed).toEqual([]);
  });

  test("自然语言锚点已在题面 → 排除", () => {
    const r = excludeEchoKeywords(
      ["postgres", "anthropic", "未在题中"],
      "我用 postgres,anthropic 服务",
    );
    expect(r.echoed).toContain("postgres");
    expect(r.echoed).toContain("anthropic");
    expect(r.filtered).toEqual(["未在题中"]);
  });

  test("代码标识符已在题面 → 仍保留（豁免）", () => {
    const r = excludeEchoKeywords(
      ["createProvider", "UserService", "package.json"],
      "请读 createProvider,看 UserService 在 package.json 里如何引用",
    );
    expect(r.echoed).toEqual([]);
    expect(r.filtered).toEqual(["createProvider", "UserService", "package.json"]);
  });

  test("混合：自然语言被排除,代码标识保留", () => {
    const r = excludeEchoKeywords(
      ["postgres", "createProvider", "Vue 3"],
      "我用 postgres,需要看 createProvider 跑在 Vue 3 上",
    );
    expect(r.echoed).toEqual(["postgres"]);
    expect(r.filtered).toEqual(["createProvider", "Vue 3"]);
  });
});

// ============================================================
// runSharedCheck — final_response_must_include_any_of_hit echo 排除
// ============================================================

function buildInput(over: Partial<SharedGraderInput> = {}): SharedGraderInput {
  return {
    expected: {},
    toolsCalled: [],
    steps: 0,
    finalResponse: "",
    ...over,
  };
}

describe("runSharedCheck — final_response_must_include_any_of_hit", () => {
  const rule: GraderRule = {
    type: "assert",
    check: "final_response_must_include_any_of_hit",
    weight: 0.4,
  };

  test("自然语言关键词命中 + 题面无 echo → PASS", () => {
    const r = runSharedCheck(
      rule,
      buildInput({
        expected: { final_response_must_include_any_of: ["数", "总"] },
        finalResponse: "总数大约 5000 个",
        userQuery: "请告诉我 package.json 的版本",
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.passed).toBe(true);
  });

  test("题面已含全部自然语言关键词 → all-echoed → FAIL（题面露答案）", () => {
    const r = runSharedCheck(
      rule,
      buildInput({
        expected: { final_response_must_include_any_of: ["postgres", "vue 3", "redis"] },
        finalResponse: "推荐使用 postgres + vue 3 + redis",
        userQuery: "项目用 postgres,vue 3,redis",
      }),
    );
    expect(r!.passed).toBe(false);
    expect(r!.reason).toContain("echo");
  });

  test("代码标识在题面字面已出现 + final_response 仅命中题面已含代码标识 → onlyCodeEcho → FAIL（复读嫌疑）", () => {
    // a.md 问题 3 残留:rtr_005 旧版题面已含 createProvider/AnthropicProvider 等,
    // agent 复读题面 token 即可命中——新规则升级为"复读嫌疑"FAIL。
    const r = runSharedCheck(
      rule,
      buildInput({
        expected: { final_response_must_include_any_of: ["createProvider", "UserService"] },
        finalResponse: "createProvider 函数路由到 UserService",
        userQuery: "请读 src/llm/registry.ts 解释 createProvider / UserService 如何路由",
      }),
    );
    expect(r!.passed).toBe(false);
    expect(r!.reason).toContain("复读嫌疑");
  });

  test("代码标识在题面已含但 final_response 同时命中题面未含的代码标识 → safe 命中 → PASS", () => {
    // 增加未在题面的代码标识 registry,只要 safe 命中即真信号
    const r = runSharedCheck(
      rule,
      buildInput({
        expected: { final_response_must_include_any_of: ["createProvider", "registry"] },
        finalResponse: "createProvider 在 registry 工厂中路由",
        userQuery: "请读 src/llm/ 解释 createProvider 如何路由",
      }),
    );
    expect(r!.passed).toBe(true);
    expect(r!.reason).toContain("safe 命中");
  });

  test("自然语言被排除后剩余关键词都未命中 → FAIL", () => {
    const r = runSharedCheck(
      rule,
      buildInput({
        expected: { final_response_must_include_any_of: ["postgres", "新关键词"] },
        finalResponse: "随便回答",
        userQuery: "项目用 postgres",
      }),
    );
    expect(r!.passed).toBe(false);
    expect(r!.reason).toContain("echo 排除");
  });
});

describe("runSharedCheck — final_response_must_not_include_zero_hit", () => {
  const rule: GraderRule = {
    type: "assert",
    check: "final_response_must_not_include_zero_hit",
    weight: 0.3,
  };

  test("无违禁词 → PASS", () => {
    const r = runSharedCheck(
      rule,
      buildInput({
        expected: { final_response_must_not_include: ["mysql", "vuex"] },
        finalResponse: "干净的回复",
        userQuery: "题面无关",
      }),
    );
    expect(r!.passed).toBe(true);
  });

  test("自然语言违禁词在题面（agent 复读题面） → 豁免 → PASS", () => {
    const r = runSharedCheck(
      rule,
      buildInput({
        expected: { final_response_must_not_include: ["user_name"] },
        finalResponse: "命名规范禁止使用 user_name",
        userQuery: "我们公司规范禁止用 user_name 这种 snake_case",
      }),
    );
    // user_name 含 _ → isCodeIdentifier=true → 不豁免
    // 因此仍判违规（提醒：代码标识违禁词在 final_response 中出现就是真违规）
    expect(r!.passed).toBe(false);
  });

  test("自然语言违禁词在题面但 final_response 复读 → FAIL（must_not 不做 echo 豁免）", () => {
    // 设计动机:case_mem_006 真信号 — 题面含 API key, agent 复读 = 真泄露,不应豁免。
    // 即使 sk-xxx 这类自然语言串在题面出现,agent 在 final_response 写出来仍算违规。
    const r = runSharedCheck(
      rule,
      buildInput({
        expected: { final_response_must_not_include: ["mysql"] },
        finalResponse: "我们以前用 mysql,后来换了",
        userQuery: "项目曾经用 mysql 后迁移到 postgres",
      }),
    );
    expect(r!.passed).toBe(false);
    expect(r!.reason).toContain("命中违禁词");
  });

  test("代码标识违禁词出现在 final_response → FAIL（即使题面也有,代码标识不豁免）", () => {
    const r = runSharedCheck(
      rule,
      buildInput({
        expected: { final_response_must_not_include: ["user_name"] },
        finalResponse: "示例代码 const user_name = ...",
        userQuery: "禁止用 user_name",
      }),
    );
    expect(r!.passed).toBe(false);
  });
});

// ============================================================
// aggregateCapabilityScore — weight 不蒸发
// ============================================================

describe("aggregateCapabilityScore — skip-llm-judge weight 不蒸发", () => {
  test("yaml 设计 llm_judge=0.1 + assert 全过 + skip 模式 → 4.5（非虚高 5.0）", () => {
    const r = aggregateCapabilityScore({
      assertResults: [{ check: "a", passed: true, weight: 0.9, reason: "" }],
      llmJudgeScore: undefined,
      llmJudgeWeight: 0.1,
    });
    // assertScore = 5,但 llm 0.1 算入分母 → 5 * 0.9 / 1.0 = 4.5
    expect(r.score).toBe(4.5);
    expect(r.assertScore).toBe(5);
    expect(r.llmScore).toBeNull();
    expect(r.details.llm_judge_skipped).toBe(true);
  });

  test("yaml 设计 llm_judge=0.2 + assert 全过 + skip → 4.0", () => {
    const r = aggregateCapabilityScore({
      assertResults: [{ check: "a", passed: true, weight: 0.8, reason: "" }],
      llmJudgeScore: undefined,
      llmJudgeWeight: 0.2,
    });
    // 5 * 0.8 / 1.0 = 4.0
    expect(r.score).toBe(4);
  });

  test("yaml 设计 llm_judge=0.1 + assert 半过 + skip → 2.25(2.3)", () => {
    const r = aggregateCapabilityScore({
      assertResults: [
        { check: "a", passed: true, weight: 0.45, reason: "" },
        { check: "b", passed: false, weight: 0.45, reason: "" },
      ],
      llmJudgeScore: undefined,
      llmJudgeWeight: 0.1,
    });
    // assertScore = 5 * (0.45/0.9) = 2.5
    // finalScore = 2.5 * 0.9 / 1.0 = 2.25 → 四舍五入 2.3
    expect(r.score).toBeCloseTo(2.3, 1);
  });

  test("无 llm_judge 设计 + assert 全过 → 5.0（不变）", () => {
    const r = aggregateCapabilityScore({
      assertResults: [
        { check: "a", passed: true, weight: 0.5, reason: "" },
        { check: "b", passed: true, weight: 0.5, reason: "" },
      ],
    });
    expect(r.score).toBe(5);
    expect(r.details.llm_judge_skipped).toBeUndefined();
  });

  test("execute 模式：assert + judge 都有分 → 正常加权", () => {
    const r = aggregateCapabilityScore({
      assertResults: [{ check: "a", passed: true, weight: 0.7, reason: "" }],
      llmJudgeScore: 3,
      llmJudgeWeight: 0.3,
    });
    // (5*0.7 + 3*0.3) / 1.0 = 4.4
    expect(r.score).toBeCloseTo(4.4, 1);
    expect(r.llmScore).toBe(3);
  });

  test("score 上限 5", () => {
    const r = aggregateCapabilityScore({
      assertResults: [{ check: "a", passed: true, weight: 1, reason: "" }],
      llmJudgeScore: 5,
      llmJudgeWeight: 1,
    });
    expect(r.score).toBeLessThanOrEqual(5);
  });
});

// ============================================================
// medianSuccessScore / pickRunStatus / classifyEchoKeywords
// ============================================================

describe("medianSuccessScore — multi-sample 中位数", () => {
  test("3 个 success sample → 取下中位", () => {
    expect(
      medianSuccessScore([
        { score: 4.0, runStatus: "success" },
        { score: 4.5, runStatus: "success" },
        { score: 5.0, runStatus: "success" },
      ]),
    ).toBe(4.5);
  });

  test("2 success + 1 error → 在 success 内取下中位", () => {
    expect(
      medianSuccessScore([
        { score: 5.0, runStatus: "success" },
        { score: null, runStatus: "error" },
        { score: 4.0, runStatus: "success" },
      ]),
    ).toBe(4.0);
  });

  test("无 success sample → null", () => {
    expect(
      medianSuccessScore([
        { score: null, runStatus: "error" },
        { score: null, runStatus: "timeout" },
      ]),
    ).toBeNull();
  });

  test("偶数个 success → 取下中位(避免小数尾)", () => {
    expect(
      medianSuccessScore([
        { score: 3.0, runStatus: "success" },
        { score: 4.0, runStatus: "success" },
        { score: 5.0, runStatus: "success" },
        { score: 4.5, runStatus: "success" },
      ]),
    ).toBe(4.0);
  });
});

describe("pickRunStatus — multi-sample 状态选举", () => {
  test("任一 success → success", () => {
    expect(pickRunStatus([{ runStatus: "success" }, { runStatus: "error" }])).toBe("success");
  });
  test("全 timeout → timeout", () => {
    expect(pickRunStatus([{ runStatus: "timeout" }, { runStatus: "timeout" }])).toBe("timeout");
  });
  test("混合 error/timeout → error", () => {
    expect(pickRunStatus([{ runStatus: "error" }, { runStatus: "timeout" }])).toBe("error");
  });
  test("空数组 → error", () => {
    expect(pickRunStatus([])).toBe("error");
  });
});

describe("classifyEchoKeywords — 三分类 echo", () => {
  test("safe / echoedCode / echoedNatural 三分类正确", () => {
    const r = classifyEchoKeywords(
      ["未在题中", "createProvider", "postgres"],
      "我用 postgres,需要看 createProvider 跑",
    );
    expect(r.safe).toEqual(["未在题中"]);
    expect(r.echoedCode).toEqual(["createProvider"]);
    expect(r.echoedNatural).toEqual(["postgres"]);
  });

  test("题面已含全部代码标识 → safe 空 / echoedCode 全部", () => {
    const r = classifyEchoKeywords(
      ["createProvider", "UserService"],
      "请读 createProvider 与 UserService",
    );
    expect(r.safe).toEqual([]);
    expect(r.echoedCode).toEqual(["createProvider", "UserService"]);
    expect(r.echoedNatural).toEqual([]);
  });

  test("无 userQuery → 全部 safe", () => {
    const r = classifyEchoKeywords(["a", "b"], undefined);
    expect(r.safe).toEqual(["a", "b"]);
    expect(r.echoedCode).toEqual([]);
    expect(r.echoedNatural).toEqual([]);
  });
});
