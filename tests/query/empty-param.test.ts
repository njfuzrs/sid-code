/**
 * F1：空参数 tool_use 退化检测与修复 — 单元测试
 *
 * 覆盖纯函数：isEmptyToolInput / detectEmptyParamToolUses /
 * replaceEmptyParamToolUses / buildEmptyParamRetryMessage。
 *
 * 控制流场景（end_turn+空参 → 重试、end_turn+非空 → 执行、重试耗尽 → 放行）
 * 由这些纯函数 + loop.ts 的编排共同保证；纯函数层在此锁定行为契约。
 */

import { describe, it, expect } from "bun:test";
import {
  MAX_EMPTY_PARAM_RETRIES,
  isEmptyToolInput,
  toolHasRequiredParams,
  detectEmptyParamToolUses,
  replaceEmptyParamToolUses,
  buildEmptyParamRetryMessage,
} from "../../src/query/empty-param.ts";
import type { ContentBlock } from "../../src/llm/types.ts";

describe("empty-param — isEmptyToolInput", () => {
  it("空对象 {} → 空（DeepSeek 退化精确特征）", () => {
    expect(isEmptyToolInput({})).toBe(true);
  });

  it("null / undefined → 空", () => {
    expect(isEmptyToolInput(null)).toBe(true);
    expect(isEmptyToolInput(undefined)).toBe(true);
  });

  it("空数组 → 空", () => {
    expect(isEmptyToolInput([])).toBe(true);
  });

  it("含字段的对象 → 非空", () => {
    expect(isEmptyToolInput({ file_path: "a.ts", content: "x" })).toBe(false);
  });

  it("非对象（字符串/数字）→ 非空（不在兜底范围，交工具校验）", () => {
    expect(isEmptyToolInput("foo")).toBe(false);
    expect(isEmptyToolInput(123)).toBe(false);
  });
});

describe("empty-param — detectEmptyParamToolUses", () => {
  it("识别空参数 tool_use，返回 id/name/index", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "开始写文档" },
      { type: "tool_use", id: "t1", name: "write", input: {} },
    ];
    const hits = detectEmptyParamToolUses(content);
    expect(hits.length).toBe(1);
    expect(hits[0]).toEqual({ id: "t1", name: "write", index: 1 });
  });

  it("非空参数 tool_use 不命中", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "read", input: { file_path: "a.ts" } },
    ];
    expect(detectEmptyParamToolUses(content)).toEqual([]);
  });

  it("混合场景：只命中空参数那一个", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "grep", input: { pattern: "x" } },
      { type: "tool_use", id: "t2", name: "write", input: {} },
    ];
    const hits = detectEmptyParamToolUses(content);
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe("t2");
  });

  it("纯文本（正常结束）→ 无命中", () => {
    const content: ContentBlock[] = [{ type: "text", text: "任务完成" }];
    expect(detectEmptyParamToolUses(content)).toEqual([]);
  });
});

describe("empty-param — replaceEmptyParamToolUses", () => {
  it("空参数 tool_use 替换为 text（消除孤儿）", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "write", input: {} },
    ];
    const out = replaceEmptyParamToolUses(content);
    expect(out[0].type).toBe("text");
    expect(out[0].type === "text" && out[0].text).toContain("write");
    expect(out[0].type === "text" && out[0].text).toContain("参数为空");
    // 替换后不含任何 tool_use → 不需要 tool_result 配对
    expect(out.some((b) => b.type === "tool_use")).toBe(false);
  });

  it("混合场景：非空 tool_use 原样保留，仅替换空参数", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "grep", input: { pattern: "x" } },
      { type: "tool_use", id: "t2", name: "write", input: {} },
    ];
    const out = replaceEmptyParamToolUses(content);
    // 非空 grep 保留
    expect(out[0].type).toBe("tool_use");
    expect(out[0].type === "tool_use" && out[0].id).toBe("t1");
    // 空参 write 被替换
    expect(out[1].type).toBe("text");
  });

  it("不修改入参（返回新数组）", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "write", input: {} },
    ];
    replaceEmptyParamToolUses(content);
    expect(content[0].type).toBe("tool_use");
  });

  it("text/thinking 块原样保留", () => {
    const content: ContentBlock[] = [
      { type: "thinking", thinking: "规划文档结构" },
      { type: "text", text: "开始写" },
      { type: "tool_use", id: "t1", name: "write", input: {} },
    ];
    const out = replaceEmptyParamToolUses(content);
    expect(out[0].type).toBe("thinking");
    expect(out[1].type).toBe("text");
    expect(out[1].type === "text" && out[1].text).toBe("开始写");
    expect(out[2].type).toBe("text");
  });
});

describe("empty-param — buildEmptyParamRetryMessage", () => {
  const hits = [{ id: "t1", name: "write", index: 1 }];

  it("含工具名 + 重试计数 + 完整参数要求 + system-reminder 包裹 + 未落地回执", () => {
    const msg = buildEmptyParamRetryMessage(hits, 1, MAX_EMPTY_PARAM_RETRIES, false);
    expect(msg).toContain("<system-reminder>");
    expect(msg).toContain("</system-reminder>");
    expect(msg).toContain("write");
    expect(msg).toContain(`1/${MAX_EMPTY_PARAM_RETRIES}`);
    expect(msg).toContain("file_path");
    // ★第二层·预防 根治死循环导火索:任何未执行的 tool_use 都必须明确回执"未落地",
    // 消除模型"以为已做/就差最后一步"的幻觉(历史死循环的直接导火索)。
    expect(msg).toContain("未执行");
    expect(msg).toContain("没有落地");
  });

  it("已压缩时包含精简上下文措辞", () => {
    const msg = buildEmptyParamRetryMessage(hits, 2, MAX_EMPTY_PARAM_RETRIES, true);
    expect(msg).toContain("精简");
  });

  it("未压缩时不含精简措辞", () => {
    const msg = buildEmptyParamRetryMessage(hits, 1, MAX_EMPTY_PARAM_RETRIES, false);
    expect(msg).not.toContain("精简");
  });

  it("stop_reason=max_tokens → 截断措辞 + 分段写入建议（区分退化）", () => {
    const msg = buildEmptyParamRetryMessage(hits, 1, MAX_EMPTY_PARAM_RETRIES, false, "max_tokens");
    expect(msg).toContain("<system-reminder>");
    expect(msg).toContain("截断");
    expect(msg).toContain("max_tokens");
    expect(msg).toContain("分段");
    // 关键：不能再给出"重新发起完整调用"的退化提示（否则模型原样重发超大调用死循环）
    expect(msg).not.toContain("大上下文下的模型退化");
  });

  it("stop_reason=length → 同样走截断分支（OpenAI 映射）", () => {
    const msg = buildEmptyParamRetryMessage(hits, 1, MAX_EMPTY_PARAM_RETRIES, false, "length");
    expect(msg).toContain("截断");
    expect(msg).toContain("分段");
  });

  it("stop_reason=end_turn（非截断）→ 走非截断分支：未落地回执 + 覆盖中断 + 分段建议，不臆造根因", () => {
    const msg = buildEmptyParamRetryMessage(hits, 1, MAX_EMPTY_PARAM_RETRIES, false, "end_turn");
    // 归因脱节修复：不再无条件断言"大上下文退化"这一未经证实的根因
    expect(msg).not.toContain("大上下文下的模型退化");
    expect(msg).not.toContain("大上下文");
    // ★第二层·预防：非截断分支现在也必须给"未落地"明确回执 + 覆盖 abort/中断成因。
    expect(msg).toContain("未执行");
    expect(msg).toContain("没有落地");
    expect(msg).toContain("中断");
    // 重发建议仍在（措辞已并入"重新发出这次调用"）。
    expect(msg).toContain("重新发出这次调用");
    // 对大内容也给分段建议，降低再次被中断的概率（覆盖 §3.2 abort 缺口）。
    expect(msg).toContain("分段");
  });

  it("不传 stop_reason → 同样走非截断分支：未落地回执 + 不臆造根因（向后兼容）", () => {
    const msg = buildEmptyParamRetryMessage(hits, 1, MAX_EMPTY_PARAM_RETRIES, false);
    expect(msg).not.toContain("大上下文");
    expect(msg).toContain("未执行");
    expect(msg).toContain("没有落地");
    expect(msg).toContain("重新发出这次调用");
  });
});

describe("empty-param — toolHasRequiredParams（误杀防护核心判据）", () => {
  it("required 非空数组 → 有必填参数", () => {
    expect(toolHasRequiredParams({ type: "object", required: ["file_path"] })).toBe(true);
    expect(toolHasRequiredParams({ required: ["a", "b"] })).toBe(true);
  });

  it("无 required（无参数工具如 enter_plan_mode）→ 无必填参数", () => {
    expect(toolHasRequiredParams({ type: "object", properties: {} })).toBe(false);
    expect(toolHasRequiredParams({})).toBe(false);
  });

  it("required 是空数组 → 无必填参数", () => {
    expect(toolHasRequiredParams({ type: "object", required: [] })).toBe(false);
  });

  it("拿不到 schema（undefined/null/非对象）→ 保守返回 true（维持旧兜底）", () => {
    expect(toolHasRequiredParams(undefined)).toBe(true);
    expect(toolHasRequiredParams(null)).toBe(true);
    expect(toolHasRequiredParams("schema")).toBe(true);
  });
});

describe("empty-param — detectEmptyParamToolUses + getSchema（区分真退化 vs 合法空参）", () => {
  // 模拟 loop.ts 注入的 schema 查询：enter_plan_mode 无必填参数，write 有
  const getSchema = (name: string): unknown => {
    if (name === "enter_plan_mode") return { type: "object", properties: {} };
    if (name === "write") return { type: "object", required: ["file_path", "content"] };
    return undefined;
  };

  it("enter_plan_mode 合法 input={} → 不命中（修复 b168a817 死循环根因）", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "enter_plan_mode", input: {} },
    ];
    expect(detectEmptyParamToolUses(content, getSchema)).toEqual([]);
  });

  it("write 有必填参数却 input={} → 命中（真退化）", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "write", input: {} },
    ];
    const hits = detectEmptyParamToolUses(content, getSchema);
    expect(hits.length).toBe(1);
    expect(hits[0].name).toBe("write");
  });

  it("混合：write 空参命中、enter_plan_mode 空参放行", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "enter_plan_mode", input: {} },
      { type: "tool_use", id: "t2", name: "write", input: {} },
    ];
    const hits = detectEmptyParamToolUses(content, getSchema);
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe("t2");
  });

  it("不传 getSchema → 旧行为不变（任何空参数都命中）", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "enter_plan_mode", input: {} },
    ];
    // 向后兼容：无 schema 查询时，enter_plan_mode 的空参数仍按旧逻辑命中
    expect(detectEmptyParamToolUses(content).length).toBe(1);
  });
});

describe("empty-param — replaceEmptyParamToolUses + getSchema", () => {
  const getSchema = (name: string): unknown => {
    if (name === "enter_plan_mode") return { type: "object", properties: {} };
    if (name === "write") return { type: "object", required: ["file_path", "content"] };
    return undefined;
  };

  it("无必填参数工具的合法空 tool_use 原样保留（不被改成 text 作废）", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "enter_plan_mode", input: {} },
    ];
    const out = replaceEmptyParamToolUses(content, getSchema);
    expect(out[0].type).toBe("tool_use");
    expect(out[0].type === "tool_use" && out[0].name).toBe("enter_plan_mode");
  });

  it("真退化工具的空 tool_use 替换为 text", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "write", input: {} },
    ];
    const out = replaceEmptyParamToolUses(content, getSchema);
    expect(out[0].type).toBe("text");
  });

  it("混合：enter_plan_mode 保留、write 替换", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "enter_plan_mode", input: {} },
      { type: "tool_use", id: "t2", name: "write", input: {} },
    ];
    const out = replaceEmptyParamToolUses(content, getSchema);
    expect(out[0].type).toBe("tool_use");
    expect(out[1].type).toBe("text");
  });
});

describe("empty-param — 常量", () => {
  it("MAX_EMPTY_PARAM_RETRIES = 3（防无限循环）", () => {
    expect(MAX_EMPTY_PARAM_RETRIES).toBe(3);
  });
});
