/**
 * #928 系数单一真源门禁：`context/token.ts` 与 `llm/token-estimator.ts` 必须同系数。
 *
 * 事故形态（2026-11-18 复核发现）：E1 把 ASCII 系数从 0.20 调到 0.28 时只改了
 * `context/token.ts`，`llm/token-estimator.ts` 留在 0.20。后者经 app 层的
 * `estimator.estimateTools(defs)` → `ContextManager.setToolSchemaTokens` 注入面板，
 * 于是同一个会话里「消息/系统提示词按 0.28 估、工具定义按 0.20 估」，
 * 工具 schema 被系统性低估 28.6%（工具定义通常 10k+ token）。
 *
 * 两处常量无法互相 import：`llm/token-estimator.ts` 已依赖 `context/token.ts` 的
 * `estimateBlockTokens`，反向 import 会成环。所以用**行为级**门禁锁住同值——
 * 任一系数被单边修改，下面三条立刻红。
 */

import { describe, expect, test } from "bun:test";
import { estimateTextTokens } from "@sid-code/core/context/token.ts";
import { TokenEstimator } from "@sid-code/core/llm/token-estimator.ts";

describe("#928 系数单一真源：两个估算器对同一文本必须同值", () => {
  const estimator = new TokenEstimator();

  test("纯 ASCII：与 estimateTextTokens 同值", () => {
    const text = "const value = compute(1, 2); // plain ascii line\n".repeat(40);
    expect(estimator.estimateText(text)).toBe(estimateTextTokens(text));
  });

  test("纯中文：与 estimateTextTokens 同值", () => {
    const text = "中文内容估算必须同源".repeat(40);
    expect(estimator.estimateText(text)).toBe(estimateTextTokens(text));
  });

  test("混合（代码 + 中文注释）：与 estimateTextTokens 同值", () => {
    const text = "abc中文123".repeat(60);
    expect(estimator.estimateText(text)).toBe(estimateTextTokens(text));
  });

  test("工具定义（estimateTools 的输入形态）与同一文本的 estimateTextTokens 同源", () => {
    // estimateTools 内部逐段调 estimateText，这里直接验证它没有另起一套系数。
    const tool = {
      name: "read_file_with_a_very_long_tool_name_v2",
      description: "读取文件内容并返回，支持偏移与行数限制。".repeat(6),
      input_schema: {
        type: "object" as const,
        properties: { file_path: { type: "string" }, offset: { type: "number" } },
      },
    };
    const expected =
      estimateTextTokens(tool.name) +
      estimateTextTokens(tool.description) +
      estimateTextTokens(JSON.stringify(tool.input_schema));
    expect(estimator.estimateTools([tool])).toBe(expected);
  });
});
