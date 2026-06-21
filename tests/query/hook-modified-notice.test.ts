/**
 * Hook 改参告知（可见性缺口修复）单测
 *
 * 背景：PreToolUse hook 可改写模型发出的工具参数（hookSpecificOutput.tool_input）。
 * 改写后若 tool_result 不含任何说明，模型会按自己原始（已被改掉）的参数理解结果 → 误判。
 * 修复：主循环 query/tool-executor.ts 与子代理 agent/tool-executor.ts 共用
 * buildHookModifiedNotice()，在 tool_result 前置一条 system-reminder 告知。
 *
 * 这里验证该函数的行为契约：携带工具名、含 system-reminder 包裹、不渲染具体参数值
 * （避免 hook 注入的敏感值回灌 LLM 上下文）。
 */

import { describe, expect, test } from "bun:test";
import { buildHookModifiedNotice } from "../../src/query/tool-executor.ts";

describe("buildHookModifiedNotice — hook 改参告知", () => {
  test("包含被改工具的名字", () => {
    const notice = buildHookModifiedNotice("bash");
    expect(notice).toContain("bash");
  });

  test("用 system-reminder 包裹（随消息流、与其它注入边一致）", () => {
    const notice = buildHookModifiedNotice("edit");
    expect(notice).toContain("<system-reminder>");
    expect(notice).toContain("</system-reminder>");
  });

  test("明确告知模型以执行结果为准，别按原参数理解", () => {
    const notice = buildHookModifiedNotice("write");
    expect(notice).toContain("hook 修改");
    expect(notice).toMatch(/以.*结果为准/);
  });

  test("只给事实、不渲染具体参数值（防 hook 注入敏感值回灌上下文）", () => {
    // 函数签名只接受工具名，结构上无从拼接参数值 —— 这是设计保证而非偶然。
    const notice = buildHookModifiedNotice("read");
    // 不应出现任何键值对样式的参数渲染
    expect(notice).not.toContain("file_path");
    expect(notice).not.toContain("=");
  });

  test("不同工具名生成对应告知（前置可拼接到任意 tool_result）", () => {
    const a = buildHookModifiedNotice("grep");
    const b = buildHookModifiedNotice("glob");
    expect(a).toContain("grep");
    expect(b).toContain("glob");
    expect(a).not.toEqual(b);
  });
});
