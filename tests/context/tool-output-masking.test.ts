/**
 * 工具输出遮罩服务测试
 */

import { describe, test, expect } from "bun:test";
import { ToolOutputMaskingService } from "../../src/context/tool-output-masking.ts";
import type { Message } from "../../src/llm/types.ts";

function makeToolPair(toolName: string, toolId: string, output: string): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: toolId, name: toolName, input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolId, content: output }],
    },
  ];
}

describe("ToolOutputMaskingService", () => {
  test("保护窗口内的输出不被遮罩", () => {
    const svc = new ToolOutputMaskingService("test-protect");
    // 创建少量小输出（远低于 50K token 保护窗口）
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      ...makeToolPair("read", "t1", "small output"),
    ];

    const result = svc.mask(messages);
    // 应该原样返回（不遮罩）
    expect(result).toBe(messages);
  });

  test("可修剪量不足时不触发遮罩", () => {
    const svc = new ToolOutputMaskingService("test-threshold");
    // 创建一些输出但总量不足 30K token
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      ...makeToolPair("read", "t1", "x".repeat(1000)),
      ...makeToolPair("read", "t2", "y".repeat(1000)),
    ];

    const result = svc.mask(messages);
    expect(result).toBe(messages);
  });

  test("超过保护窗口的旧输出被遮罩", () => {
    const svc = new ToolOutputMaskingService("test-mask");
    // 创建大量工具输出，超过保护窗口
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "start" }] },
    ];

    // 添加多个大输出（每个约 50K 字符 ≈ 12.5K token ASCII）
    for (let i = 0; i < 10; i++) {
      messages.push(...makeToolPair("read", `t${i}`, "a".repeat(50000)));
    }

    const result = svc.mask(messages);
    // 结果不应是原始引用（说明发生了遮罩）
    expect(result).not.toBe(messages);

    // 检查旧输出被遮罩
    let maskedCount = 0;
    for (const msg of result) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.content.includes("[tool_output_masked]")) {
          maskedCount++;
        }
      }
    }
    expect(maskedCount).toBeGreaterThan(0);
  });

  test("豁免工具不被遮罩", () => {
    const svc = new ToolOutputMaskingService("test-exempt");
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "start" }] },
    ];

    // 添加大量 memory 工具输出（豁免工具）
    for (let i = 0; i < 10; i++) {
      messages.push(...makeToolPair("memory", `m${i}`, "a".repeat(50000)));
    }
    // 再添加一些普通工具输出
    for (let i = 0; i < 5; i++) {
      messages.push(...makeToolPair("read", `r${i}`, "b".repeat(50000)));
    }

    const result = svc.mask(messages);

    // memory 工具的输出不应被遮罩
    for (const msg of result) {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          // 找到对应的 tool_use
          const toolUseId = block.tool_use_id;
          if (toolUseId.startsWith("m")) {
            expect(block.content).not.toContain("[tool_output_masked]");
          }
        }
      }
    }
  });

  test("bash 工具生成结构化预览", () => {
    const svc = new ToolOutputMaskingService("test-bash-preview");
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "start" }] },
    ];

    // 先添加大量旧输出填满保护窗口
    for (let i = 0; i < 8; i++) {
      messages.push(...makeToolPair("read", `old${i}`, "x".repeat(50000)));
    }
    // 在最前面插入一个 bash 输出（会被遮罩）
    const bashOutput = "line1\nline2\nline3\nline4\nexit code: 0\n" + "data\n".repeat(10000);
    const bashPair = makeToolPair("bash", "bash1", bashOutput);
    messages.splice(1, 0, ...bashPair);

    const result = svc.mask(messages);

    // 找到被遮罩的 bash 输出
    for (const msg of result) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id === "bash1" && block.content.includes("[tool_output_masked]")) {
          expect(block.content).toContain("Output (前 3 行)");
          expect(block.content).toContain("总行数");
        }
      }
    }
  });
});
