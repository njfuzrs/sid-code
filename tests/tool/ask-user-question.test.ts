/**
 * AskUserQuestionTool + Bridge 单测
 *
 * 验证：
 * 1. headless 模式（无 handler）返回 unavailable
 * 2. handler 注入后正确转发请求并格式化答案
 * 3. 用户取消（cancelled）的文案
 * 4. 反注册函数生效
 * 5. 参数校验
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  setAskUserQuestionHandler,
  askUserQuestion,
  hasAskUserQuestionHandler,
} from "../../src/tool/ask-user-question-bridge.ts";
import { AskUserQuestionTool } from "../../src/tool/ask-user-question.ts";

describe("ask-user-question-bridge", () => {
  beforeEach(() => {
    // 确保每个测试前清掉 handler
    setAskUserQuestionHandler(null);
  });

  test("无 handler 时返回 unavailable", async () => {
    expect(hasAskUserQuestionHandler()).toBe(false);
    const result = await askUserQuestion({
      questions: [{ question: "foo?", header: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(result.status).toBe("unavailable");
  });

  test("注入 handler 后正确转发请求", async () => {
    const captured: unknown[] = [];
    setAskUserQuestionHandler(async (req) => {
      captured.push(req);
      return { status: "answered", answers: { "foo?": "A" } };
    });
    expect(hasAskUserQuestionHandler()).toBe(true);

    const result = await askUserQuestion({
      questions: [{ question: "foo?", header: "Q", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(result.status).toBe("answered");
    if (result.status === "answered") {
      expect(result.answers["foo?"]).toBe("A");
    }
    expect(captured.length).toBe(1);
  });

  test("handler 抛错时降级为 unavailable", async () => {
    setAskUserQuestionHandler(async () => {
      throw new Error("boom");
    });
    const result = await askUserQuestion({
      questions: [{ question: "x?", header: "H", options: [{ label: "1" }, { label: "2" }] }],
    });
    expect(result.status).toBe("unavailable");
  });

  test("反注册函数生效", async () => {
    const unregister = setAskUserQuestionHandler(async () => {
      return { status: "answered", answers: {} };
    });
    expect(hasAskUserQuestionHandler()).toBe(true);
    unregister();
    expect(hasAskUserQuestionHandler()).toBe(false);
  });
});

describe("AskUserQuestionTool", () => {
  const tool = new AskUserQuestionTool();

  beforeEach(() => {
    setAskUserQuestionHandler(null);
  });

  test("name / readOnly / isConcurrencySafe", () => {
    expect(tool.name()).toBe("ask_user_question");
    expect(tool.readOnly()).toBe(true);
    expect(tool.isConcurrencySafe()).toBe(false);
  });

  test("无 handler 时返回友好提示（非 isError）", async () => {
    const result = await tool.execute({
      questions: [{ question: "用哪个?", header: "库", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("非交互模式");
  });

  test("用户作答后格式化为「问题 → 答案」", async () => {
    setAskUserQuestionHandler(async () => ({
      status: "answered",
      answers: { "用哪个数据库?": "PostgreSQL", "ORM 选型?": "Drizzle" },
    }));
    const result = await tool.execute({
      questions: [
        { question: "用哪个数据库?", header: "DB", options: [{ label: "PostgreSQL" }, { label: "MySQL" }] },
        { question: "ORM 选型?", header: "ORM", options: [{ label: "Drizzle" }, { label: "Prisma" }] },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("用哪个数据库? → PostgreSQL");
    expect(result.output).toContain("ORM 选型? → Drizzle");
  });

  test("用户取消返回友好提示", async () => {
    setAskUserQuestionHandler(async () => ({ status: "cancelled" }));
    const result = await tool.execute({
      questions: [{ question: "x?", header: "H", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("取消");
  });

  test("空 questions 数组返回 isError", async () => {
    const result = await tool.execute({ questions: [] });
    expect(result.isError).toBe(true);
  });

  test("缺少 questions 字段返回 isError", async () => {
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
  });
});
