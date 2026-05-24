/**
 * eval-judge 单测
 *
 * 覆盖几类 regression：
 * - gradeAnchorHit: 长锚点表不应惩罚命中任意一项的回答（case_007/028）
 * - gradeAnchorHit: echo 排除（case_022 锚点恰好是用户原话中的词）
 * - gradeAnchorHit: v3 单 hit = 0.5（v2 的 0.8 拉不开鉴别度）
 * - gradeToolCompliance: sideband metadata 缺失时给 score:null（不再兜底 1.0）
 * - gradeToolCompliance: any_of 模式下命中任一即满分（case_030 诚实兜底）
 * - aggregate: 跳过 score === null 的维度，按剩余权重归一化
 * - extractJsonObject: 各种边界（思考段含示例 JSON / markdown 代码块 / 末尾 JSON）
 */

import { describe, test, expect } from "bun:test";
import {
  gradeAnchorHit,
  gradeToolCompliance,
  gradeEfficiency,
  gradeCost,
  aggregate,
  extractJsonObject,
  type DimScore,
} from "./eval-judge.ts";

describe("gradeAnchorHit", () => {
  test("无锚点直接满分", () => {
    const r = gradeAnchorHit("anything", []);
    expect(r.score).toBe(1.0);
    expect(r.pass).toBe(true);
  });

  test("一个都没命中得 0", () => {
    const r = gradeAnchorHit("foo bar baz", ["xxx", "yyy"]);
    expect(r.score).toBe(0);
    expect(r.pass).toBe(false);
  });

  test("v3: 命中 1/2 得 0.5（基础合格分，从 v2 的 0.8 调下来恢复鉴别度）", () => {
    const r = gradeAnchorHit("foo", ["foo", "bar"]);
    expect(r.score).toBe(0.5);
    expect(r.pass).toBe(true);
  });

  test("命中 2/2 得满分", () => {
    const r = gradeAnchorHit("foo bar", ["foo", "bar"]);
    expect(r.score).toBe(1.0);
  });

  test("regression case_007: 长锚点表（10 个）命中 4 个不应被惩罚", () => {
    const anchors = [
      "src/llm/quota.ts", "QuotaManager", "QuotaCheckResult", "AlertLevel",
      "quota", "check(", "ratio", ">=", "exceeded", "1.0",
    ];
    const output = "边界条件：当 ratio >= 1.0 时返回 exceeded";
    const r = gradeAnchorHit(output, anchors);
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThan(0.6);
    expect(r.pass).toBe(true);
  });

  test("regression case_028: 5 个锚点命中 1 个仍合格 (v3 = 0.5)", () => {
    const anchors = ["src/cli.ts", "src/app.ts", "src/memory/store.ts", "MemoryStore", "import"];
    const output = "MemoryStore 在 cli.ts 和 app.ts 中被多处使用";
    const r = gradeAnchorHit(output, anchors);
    expect(r.pass).toBe(true);
    expect(r.score).toBe(0.5);
  });

  test("regression case_030: 12 个长 any_of 表 → 单 hit 给 0.5", () => {
    const anchors = [
      "不存在", "没有找到", "找不到", "does not exist", "not found",
      "没有这个文件", "未发现", "查无", "auto-retry.ts", "deny-this",
      "实际存在", "无法回答",
    ];
    const output = "auto-retry.ts 这个文件 there is none here.";
    const r = gradeAnchorHit(output, anchors);
    expect(r.score).toBe(0.5);
    expect(r.pass).toBe(true);
  });

  test("命中数达到满分阈值即给 1.0", () => {
    const anchors = ["a", "b", "c", "d"];
    const r = gradeAnchorHit("a b", anchors);
    expect(r.score).toBe(1.0);
  });

  test("锚点表只有 1 项，命中即得 0.5（与多 anchor 单 hit 一致）", () => {
    const r = gradeAnchorHit("foo", ["foo"]);
    expect(r.score).toBe(0.5);
    expect(r.pass).toBe(true);
  });

  describe("Echo 排除（v3 新增）", () => {
    test("锚点恰好是用户原话中的词 → 排除该锚点", () => {
      // case_022 真实场景：用户问"把那个权限模块改一下让它更好"，
      // 锚点含"更好"——agent 复读用户问题就 100% 命中
      const userQuery = "把那个权限模块改一下让它更好。";
      const anchors = ["更好", "PermissionChecker", "需要明确", "澄清"];
      // agent 输出 echo 用户问题，但没有真实回答
      const output = "你说让权限模块'更好'，能再具体一点吗？";
      const r = gradeAnchorHit(output, anchors, userQuery);
      // "更好" 被排除后，effective = ["PermissionChecker", "需要明确", "澄清"]
      // 输出未命中其中任何一个 → score = 0
      expect(r.score).toBe(0);
      expect(r.pass).toBe(false);
      expect(r.reason).toContain("echo 排除");
    });

    test("无 userQuery 时不做 echo 排除（向后兼容）", () => {
      const anchors = ["foo", "bar"];
      const output = "foo bar baz";
      const r = gradeAnchorHit(output, anchors);
      expect(r.score).toBe(1.0);
    });

    test("echo 排除后真实命中仍正常评分", () => {
      const userQuery = "把权限模块改一下让它更好";
      const anchors = ["更好", "PermissionChecker", "澄清"];
      const output = "需要先 PermissionChecker 的具体优化方向，建议澄清后再动";
      const r = gradeAnchorHit(output, anchors, userQuery);
      // "更好" 被 echo 排除，剩 ["PermissionChecker", "澄清"] 全命中 → 1.0
      expect(r.score).toBe(1.0);
    });

    test("所有锚点都被 echo 排除 → 给 1.0 + 提示", () => {
      const userQuery = "foo bar baz";
      const anchors = ["foo", "bar", "baz"];
      const output = "any output";
      const r = gradeAnchorHit(output, anchors, userQuery);
      expect(r.score).toBe(1.0);
      expect(r.reason).toContain("echo 排除");
    });

    test("regression case_015: 代码标识符/路径不被 echo 排除", () => {
      // 用户 query 提供路径作为指引，agent 引用应当算真实命中（不是复读）
      const userQuery = "给 src/llm/quota.ts 的 QuotaManager.check() 方法补测，先看 tests/llm/quota.test.ts 现有结构，给 it() 块";
      const anchors = ["tests/llm/quota.test.ts", "QuotaManager", "bun:test", "describe", "it("];
      // agent 输出引用 path 和类名（虽然 user query 里也有）
      const output = "看了 tests/llm/quota.test.ts，QuotaManager 的边界测试可以这样写：it('xxx', () => { ... })";
      const r = gradeAnchorHit(output, anchors, userQuery);
      // 路径 / QuotaManager / it( 都是代码标识符，不应被 echo 排除
      // 输出命中 3 个：tests/llm/quota.test.ts, QuotaManager, it(
      // total=5, fullScoreThreshold=max(2, ceil(5*0.3))=2，3 >= 2 → 1.0
      expect(r.score).toBe(1.0);
      expect(r.reason).not.toContain("echo 排除"); // 没有锚点被 echo 排除
    });

    test("混合：代码标识符不排除 + 自然语言短语排除", () => {
      const userQuery = "把那个 PermissionChecker 改得更好一点，需要明确思路吗？";
      const anchors = ["PermissionChecker", "更好", "需要明确", "澄清"];
      const output = "PermissionChecker 是 src/permission/checker.ts 的核心类...";
      const r = gradeAnchorHit(output, anchors, userQuery);
      // PermissionChecker 是代码标识符（驼峰），不排除 → 命中
      // "更好" / "需要明确" 是自然语言 + 出现在 query 中 → 排除
      // "澄清" 是自然语言但未出现在 query → 保留但未命中
      // 有效锚点: ["PermissionChecker", "澄清"]，命中 1 → 0.5
      expect(r.score).toBe(0.5);
      expect(r.reason).toContain("echo 排除 2 项");
    });
  });
});

describe("extractJsonObject", () => {
  test("整段就是合法 JSON", () => {
    const r = extractJsonObject('{"score": 0.8, "pass": true}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.json).score).toBe(0.8);
  });

  test("markdown 代码块包裹", () => {
    const r = extractJsonObject('```json\n{"score": 0.9, "pass": true}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.json).score).toBe(0.9);
  });

  test("不带 json 标识的代码块", () => {
    const r = extractJsonObject('```\n{"score": 0.7}\n```');
    expect(r.ok).toBe(true);
  });

  test("regression: 思考段含示例 JSON + 末尾真正答案", () => {
    // 旧实现 /\{[\s\S]*\}/ 贪婪匹配会从第一个 { 抓到最后一个 } —— 不是合法 JSON
    const text = `让我分析一下：用户期望的格式应该是 { "示例": "value" }。
基于以上分析，我的答案是：
{"score": 0.8, "pass": true, "reason": "ok"}`;
    const r = extractJsonObject(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const parsed = JSON.parse(r.json);
      expect(parsed.score).toBe(0.8);
      expect(parsed.pass).toBe(true);
    }
  });

  test("regression: 末尾真 JSON 含转义字符串", () => {
    const text = `分析：{"foo": "bar"} 是示例。
{"score": 0.6, "pass": false, "reason": "字符串里有 } 也要正确"}`;
    const r = extractJsonObject(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const parsed = JSON.parse(r.json);
      expect(parsed.score).toBe(0.6);
    }
  });

  test("空字符串返回 ok:false", () => {
    const r = extractJsonObject("");
    expect(r.ok).toBe(false);
  });

  test("纯文本无 JSON 返回 ok:false", () => {
    const r = extractJsonObject("我无法解析这个问题");
    expect(r.ok).toBe(false);
  });
});

describe("gradeToolCompliance", () => {
  const emptyMeta = { tools_used: [], files_edited: [], total_steps: 0, total_tokens: 0 };

  test("sideband metadata 缺失（全 0）→ score: null（不再兜底 1.0，避免污染均值）", () => {
    const r = gradeToolCompliance(emptyMeta, {
      mustCallTools: ["grep"],
      mustNotCallTools: ["bash"],
    });
    expect(r.score).toBeNull();
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("sideband metadata 缺失");
  });

  test("正常合规（all_of 默认）", () => {
    const meta = { tools_used: ["read", "grep"], files_edited: [], total_steps: 5, total_tokens: 1000 };
    const r = gradeToolCompliance(meta, { mustCallTools: ["read", "grep"] });
    expect(r.score).toBe(1.0);
  });

  test("all_of 模式下漏调一个工具按比例扣分", () => {
    const meta = { tools_used: ["read"], files_edited: [], total_steps: 5, total_tokens: 1000 };
    const r = gradeToolCompliance(meta, { mustCallTools: ["read", "grep"] });
    expect(r.score).toBe(0.8);
  });

  test("any_of 模式下命中任一即满分（修复 case_030 诚实兜底）", () => {
    const meta = { tools_used: ["glob"], files_edited: [], total_steps: 3, total_tokens: 500 };
    const r = gradeToolCompliance(meta, {
      mustCallTools: ["grep", "glob", "ls", "read"],
      mustCallMode: "any_of",
    });
    expect(r.score).toBe(1.0);
  });

  test("any_of 模式下一个都没命中扣 0.4", () => {
    const meta = { tools_used: ["bash"], files_edited: [], total_steps: 3, total_tokens: 500 };
    const r = gradeToolCompliance(meta, {
      mustCallTools: ["grep", "glob", "ls", "read"],
      mustCallMode: "any_of",
    });
    expect(r.score).toBe(0.6);
  });

  test("禁止的工具被使用扣 0.3", () => {
    const meta = { tools_used: ["read", "bash"], files_edited: [], total_steps: 5, total_tokens: 1000 };
    const r = gradeToolCompliance(meta, {
      mustCallTools: ["read"],
      mustNotCallTools: ["bash"],
    });
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeCloseTo(0.7, 5);
  });

  test("禁止修改的文件被改扣 0.5", () => {
    const meta = { tools_used: ["edit"], files_edited: ["src/llm/quota.ts"], total_steps: 5, total_tokens: 1000 };
    const r = gradeToolCompliance(meta, {
      mustNotModifyFiles: ["src/"],
    });
    expect(r.score).toBe(0.5);
  });

  test("regression Bug B: claude-code PascalCase 工具名 vs case yaml 小写 → 应大小写不敏感", () => {
    const meta = { tools_used: ["Read", "Grep", "Glob"], files_edited: [], total_steps: 5, total_tokens: 1000 };
    const r = gradeToolCompliance(meta, {
      mustCallTools: ["grep", "glob", "ls", "read"],
      mustCallMode: "any_of",
    });
    expect(r.score).toBe(1.0);
  });

  test("regression Bug B: 禁止的工具大小写不敏感", () => {
    const meta = { tools_used: ["Bash"], files_edited: [], total_steps: 3, total_tokens: 500 };
    const r = gradeToolCompliance(meta, {
      mustCallTools: ["read"],
      mustNotCallTools: ["bash"],
    });
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeCloseTo(0.3, 5);
  });
});

describe("gradeEfficiency", () => {
  test("无轨迹数据 → score: null（不再兜底 1.0）", () => {
    const r = gradeEfficiency({ tools_used: [], files_edited: [], total_steps: 0, total_tokens: 0 }, 15);
    expect(r.score).toBeNull();
    expect(r.pass).toBe(false);
  });

  test("步数在预期内得 1.0", () => {
    const r = gradeEfficiency({ tools_used: ["read"], files_edited: [], total_steps: 10, total_tokens: 1000 }, 15);
    expect(r.score).toBe(1.0);
  });
});

describe("gradeCost (v4 阈值)", () => {
  test("无 token 数据 → score: null（不再兜底 1.0）", () => {
    const r = gradeCost({ tools_used: [], files_edited: [], total_steps: 0, total_tokens: 0 });
    expect(r.score).toBeNull();
    expect(r.pass).toBe(false);
  });

  test("v4 低消耗（≤50k）满分", () => {
    const r = gradeCost({ tools_used: [], files_edited: [], total_steps: 5, total_tokens: 30_000 });
    expect(r.score).toBe(1.0);
  });

  test("v4 中等（50k~150k）= 0.7", () => {
    const r = gradeCost({ tools_used: [], files_edited: [], total_steps: 5, total_tokens: 100_000 });
    expect(r.score).toBe(0.7);
  });

  test("v4 偏高（150k~500k）= 0.4", () => {
    const r = gradeCost({ tools_used: [], files_edited: [], total_steps: 5, total_tokens: 300_000 });
    expect(r.score).toBe(0.4);
  });

  test("v4 严重超标（>500k）= 0.2", () => {
    const r = gradeCost({ tools_used: [], files_edited: [], total_steps: 5, total_tokens: 800_000 });
    expect(r.score).toBe(0.2);
  });
});

describe("aggregate - null 维度跳过", () => {
  test("error case：anchor=0 + 其它全 null → 总分 0（不再 ~2.5）", () => {
    const dims: Record<string, DimScore> = {
      anchor_hit: { pass: false, score: 0, reason: "0 命中" },
      rubric_score: { pass: false, score: null, reason: "judge 不可用" },
      tool_compliance: { pass: false, score: null, reason: "sideband 缺失" },
      efficiency: { pass: false, score: null, reason: "无轨迹" },
      cost: { pass: false, score: null, reason: "无 token" },
    };
    const { score, namedScores } = aggregate(dims);
    expect(score).toBe(0);
    expect(namedScores.rubric_score).toBeNull();
    expect(namedScores.tool_compliance).toBeNull();
    expect(namedScores.efficiency).toBeNull();
    expect(namedScores.cost).toBeNull();
  });

  test("全部 null → score: null（无法评分）", () => {
    const dims: Record<string, DimScore> = {
      anchor_hit: { pass: false, score: null, reason: "x" },
      rubric_score: { pass: false, score: null, reason: "x" },
    };
    const { score } = aggregate(dims);
    expect(score).toBeNull();
  });

  test("正常 5 维全有效 → 加权归一化到 5 分制", () => {
    const dims: Record<string, DimScore> = {
      anchor_hit: { pass: true, score: 1.0, reason: "" },
      rubric_score: { pass: true, score: 1.0, reason: "" },
      tool_compliance: { pass: true, score: 1.0, reason: "" },
      efficiency: { pass: true, score: 1.0, reason: "" },
      cost: { pass: true, score: 1.0, reason: "" },
    };
    const { score } = aggregate(dims);
    expect(score).toBe(5.0);
  });

  test("rubric=null（限流）但其它正常 → 不污染总分（与旧版兜底 1.0 不同）", () => {
    const dims: Record<string, DimScore> = {
      anchor_hit: { pass: true, score: 1.0, reason: "" },
      rubric_score: { pass: false, score: null, reason: "judge 不可用" },
      tool_compliance: { pass: true, score: 0.8, reason: "" },
      efficiency: { pass: true, score: 1.0, reason: "" },
      cost: { pass: true, score: 1.0, reason: "" },
    };
    const { score } = aggregate(dims);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(4.5);
    expect(score!).toBeLessThan(4.8);
  });
});
