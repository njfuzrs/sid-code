/**
 * isRecommendedLabel / assembleAnswer 纯函数单测
 *
 * AskUserQuestion 选项 label 若带「推荐」后缀，UI 给该项加品牌蓝强调。
 * 识别规则：结尾处的 (推荐) / （推荐） / (Recommended)（大小写不敏感，容忍首尾空白、全半角括号）。
 *
 * assembleAnswer 是"选择态 → 回灌答案串"的组装逻辑，覆盖单选/多选/其他文本/空选择四类分支
 * ——空选择返回 ""，是"确认提交"行禁用判定（hasSelection）的依据，务必单测覆盖。
 */

import { test, expect, describe } from "bun:test";
import { isRecommendedLabel, assembleAnswer } from "@sid-code/cli/ui/components/DialogManager.tsx";

describe("isRecommendedLabel — 推荐后缀识别", () => {
  test("半角括号 (推荐)", () => {
    expect(isRecommendedLabel("方案A (推荐)")).toBe(true);
  });

  test("全角括号（推荐）", () => {
    expect(isRecommendedLabel("用 JWT（推荐）")).toBe(true);
  });

  test("英文 (Recommended) 大小写不敏感", () => {
    expect(isRecommendedLabel("Option B (Recommended)")).toBe(true);
    expect(isRecommendedLabel("(RECOMMENDED)")).toBe(true);
    expect(isRecommendedLabel("x (recommended)")).toBe(true);
  });

  test("尾部有空白仍识别", () => {
    expect(isRecommendedLabel("方案A (推荐)   ")).toBe(true);
  });

  test("无后缀 → false", () => {
    expect(isRecommendedLabel("选项C")).toBe(false);
    expect(isRecommendedLabel("recommended")).toBe(false); // 无括号不算
    expect(isRecommendedLabel("推荐使用这个")).toBe(false); // 不在结尾括号里
  });

  test("推荐后缀不在结尾（后面还有字）→ false", () => {
    expect(isRecommendedLabel("(推荐) 但有风险")).toBe(false);
  });
});

describe("assembleAnswer — 组装回灌答案串", () => {
  const opts = [{ label: "日志" }, { label: "鉴权" }, { label: "限流" }, { label: "压缩" }];

  test("单选：取 selected 里唯一项的 label", () => {
    expect(assembleAnswer(opts, new Set([1]), "", false)).toBe("鉴权");
  });

  test("单选：无选择、无其他文本 → 空串（确认行应禁用）", () => {
    expect(assembleAnswer(opts, new Set(), "", false)).toBe("");
  });

  test("单选：其他文本优先于已选项", () => {
    expect(assembleAnswer(opts, new Set([1]), "自定义X", false)).toBe("自定义X");
  });

  test("单选：仅有其他文本、无选项选中", () => {
    expect(assembleAnswer(opts, new Set(), "纯自定义", false)).toBe("纯自定义");
  });

  test("多选：多项按序以 \", \" 连接", () => {
    expect(assembleAnswer(opts, new Set([0, 1]), "", true)).toBe("日志, 鉴权");
  });

  test("多选：勾选项 + 其他文本一起追加", () => {
    expect(assembleAnswer(opts, new Set([0, 2]), "GraphQL", true)).toBe("日志, 限流, GraphQL");
  });

  test("多选：无勾选、无其他文本 → 空串（确认行应禁用）", () => {
    expect(assembleAnswer(opts, new Set(), "", true)).toBe("");
  });

  test("多选：仅其他文本、无勾选项", () => {
    expect(assembleAnswer(opts, new Set(), "只要这个", true)).toBe("只要这个");
  });

  test("其他文本首尾空白会被 trim", () => {
    expect(assembleAnswer(opts, new Set(), "  带空格  ", false)).toBe("带空格");
    expect(assembleAnswer(opts, new Set([0]), "   ", true)).toBe("日志"); // 空白其他文本视为未填
  });
});
