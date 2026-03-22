/**
 * 工具输出截断增强测试
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Manager, type TruncationResult } from "../../src/context/manager.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("truncateToolOutput", () => {
  test("短内容不截断", () => {
    const content = "短内容";
    const result = Manager.truncateToolOutput(content);
    expect(result).toBe(content);
  });

  test("超长内容被截断", () => {
    const content = "a".repeat(50000);
    const result = Manager.truncateToolOutput(content, 30000);
    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain("省略");
  });

  test("代码块压缩", () => {
    // 生成足够大的代码块（每行 20 字符 × 3000 行 = 60000 字符）
    const code = Array.from({ length: 3000 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const content = `一些文本\n\`\`\`typescript\n${code}\n\`\`\`\n更多文本`;
    const result = Manager.truncateToolOutput(content, 30000);
    // 代码块应该被压缩，或者整体被截断
    expect(result).toContain("省略");
  });

  test("文件内容模式检测", () => {
    // 模拟带行号的文件内容
    const lines = Array.from({ length: 100 }, (_, i) => `  ${i + 1}→ const x = ${i};`);
    const content = lines.join("\n");
    const result = Manager.truncateToolOutput(content, 500);
    expect(result).toContain("省略");
    expect(result).toContain("行");
  });

  test("默认字符级截断保留头尾", () => {
    const content = "A".repeat(10000) + "B".repeat(10000) + "C".repeat(20000);
    const result = Manager.truncateToolOutput(content, 30000);
    expect(result).toContain("省略");
    // 头部应该包含 A
    expect(result.startsWith("A")).toBe(true);
    // 尾部应该包含 C
    expect(result.endsWith("C")).toBe(true);
  });
});

describe("truncateToolOutputWithSave", () => {
  let tempDir: string;

  afterEach(() => {
    // 清理临时目录
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("短内容不截断也不落盘", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sid-test-"));
    const result = Manager.truncateToolOutputWithSave("短内容", "read", tempDir);
    expect(result.truncated).toBe("短内容");
    expect(result.savedPath).toBeNull();
  });

  test("超长内容截断并落盘", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sid-test-"));
    const content = "x".repeat(50000);
    const result = Manager.truncateToolOutputWithSave(content, "bash", tempDir, 30000);

    expect(result.truncated).toContain("省略");
    expect(result.truncated).toContain("完整输出已保存到");
    expect(result.savedPath).not.toBeNull();

    // 验证文件存在且内容完整
    expect(fs.existsSync(result.savedPath!)).toBe(true);
    const saved = fs.readFileSync(result.savedPath!, "utf-8");
    expect(saved).toBe(content);
  });

  test("落盘文件名包含工具名", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sid-test-"));
    const content = "y".repeat(50000);
    const result = Manager.truncateToolOutputWithSave(content, "grep", tempDir);

    expect(result.savedPath).not.toBeNull();
    expect(path.basename(result.savedPath!)).toMatch(/^grep-\d+\.txt$/);
  });

  test("截断比例：前 20% + 后 80%", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sid-test-"));
    // 创建可辨识的内容：前半 A，后半 B
    const content = "A".repeat(25000) + "B".repeat(25000);
    const result = Manager.truncateToolOutputWithSave(content, "read", tempDir, 30000);

    // 前 20% = 6000 字符，应该全是 A
    // 后 80% = 24000 字符，应该全是 B
    const truncated = result.truncated;
    // 头部区域应该包含 A
    expect(truncated.indexOf("A")).toBeGreaterThanOrEqual(0);
    // 尾部区域应该包含 B
    expect(truncated.lastIndexOf("B")).toBeGreaterThan(0);
  });
});

describe("applyFunctionResponseBudget", () => {
  test("预算内不清理", () => {
    const mgr = new Manager({ maxTokens: 100000 });
    mgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "你好" }],
    });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "text", text: "你好！" }],
    });
    mgr.addMessage({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: "短输出",
      }],
    });

    mgr.applyFunctionResponseBudget(200000);
    const msgs = mgr.getMessages();
    const toolResult = msgs[2].content[0];
    expect(toolResult.type === "tool_result" && toolResult.content).toBe("短输出");
  });

  test("超出预算清理旧输出", () => {
    const mgr = new Manager({ maxTokens: 100000 });

    // 添加多个工具输出
    mgr.addMessage({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: "a".repeat(1000), // 旧的
      }],
    });
    mgr.addMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
    mgr.addMessage({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t2",
        content: "b".repeat(1000), // 新的
      }],
    });

    // 设置很小的预算，只够保留最新的
    mgr.applyFunctionResponseBudget(1500);

    const msgs = mgr.getMessages();
    // 旧的应该被清理
    const oldResult = msgs[0].content[0];
    expect(oldResult.type === "tool_result" && oldResult.content).toContain("已清理");
    // 新的应该保留
    const newResult = msgs[2].content[0];
    expect(newResult.type === "tool_result" && newResult.content).toBe("b".repeat(1000));
  });
});

describe("cleanupToolOutputs", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("清理过期文件", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sid-test-"));
    const outputDir = path.join(tempDir, "tool-outputs");
    fs.mkdirSync(outputDir, { recursive: true });

    // 创建一个"过期"文件
    const filePath = path.join(outputDir, "old-file.txt");
    fs.writeFileSync(filePath, "old content");

    // 等待一小段时间确保文件时间戳早于清理时间
    await new Promise(r => setTimeout(r, 10));

    // 用 0ms maxAge 清理（所有文件都过期）
    Manager.cleanupToolOutputs(tempDir, 0);

    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("不清理未过期文件", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sid-test-"));
    const outputDir = path.join(tempDir, "tool-outputs");
    fs.mkdirSync(outputDir, { recursive: true });

    const filePath = path.join(outputDir, "new-file.txt");
    fs.writeFileSync(filePath, "new content");

    // 用很大的 maxAge 清理
    Manager.cleanupToolOutputs(tempDir, 3600_000);

    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("目录不存在时不报错", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sid-test-"));
    // 不创建 tool-outputs 目录
    expect(() => Manager.cleanupToolOutputs(tempDir)).not.toThrow();
  });
});
