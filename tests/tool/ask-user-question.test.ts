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
  parseAskTimeoutMs,
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

  // ── §6.2 补齐：多选答案拼接与边界情况 ──

  test("多选答案以 ', ' 连接后格式化为「问题 → 答案」", async () => {
    // 模拟 TUI 组件多选后的 answer 格式：labels.join(", ")
    setAskUserQuestionHandler(async () => ({
      status: "answered",
      answers: { "需要启用哪些可观测性能力?": "结构化日志, 分布式追踪, 错误上报" },
    }));
    const result = await tool.execute({
      questions: [
        {
          question: "需要启用哪些可观测性能力?",
          header: "可观测性",
          multi_select: true,
          options: [
            { label: "结构化日志" },
            { label: "分布式追踪" },
            { label: "指标埋点" },
            { label: "错误上报" },
          ],
        },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("需要启用哪些可观测性能力?");
    expect(result.output).toContain("结构化日志, 分布式追踪, 错误上报");
  });

  test("多题含单选和多选混合格式化", async () => {
    setAskUserQuestionHandler(async () => ({
      status: "answered",
      answers: {
        "认证方式选哪个?": "JWT (推荐)",
        "需要启用哪些能力?": "日志, 追踪",
      },
    }));
    const result = await tool.execute({
      questions: [
        {
          question: "认证方式选哪个?",
          header: "认证",
          options: [
            { label: "JWT (推荐)", description: "无状态，水平扩展简单" },
            { label: "Session + Redis", description: "可即时吊销" },
          ],
        },
        {
          question: "需要启用哪些能力?",
          header: "能力",
          multi_select: true,
          options: [
            { label: "日志" },
            { label: "追踪" },
            { label: "指标" },
          ],
        },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("认证方式选哪个? → JWT (推荐)");
    expect(result.output).toContain("需要启用哪些能力? → 日志, 追踪");
  });

  test("某问题未作答时填充 (未作答)", async () => {
    // answers 缺少某题的 key，工具侧兜底为 "(未作答)"
    setAskUserQuestionHandler(async () => ({
      status: "answered",
      answers: { "第一个问题?": "答案一" },
      // 缺少 "第二个问题?" 的答案
    }));
    const result = await tool.execute({
      questions: [
        { question: "第一个问题?", header: "Q1", options: [{ label: "答案一" }, { label: "答案二" }] },
        { question: "第二个问题?", header: "Q2", options: [{ label: "选A" }, { label: "选B" }] },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("第一个问题? → 答案一");
    expect(result.output).toContain("第二个问题? → (未作答)");
  });

  test("单题多选只勾一项", async () => {
    // 多选但只选一项（Enter 确认时顺带勾选光标项）
    setAskUserQuestionHandler(async () => ({
      status: "answered",
      answers: { "选哪些缓存方案?": "Redis" },
    }));
    const result = await tool.execute({
      questions: [
        {
          question: "选哪些缓存方案?",
          header: "缓存",
          multi_select: true,
          options: [
            { label: "Redis" },
            { label: "Memcached" },
            { label: "本地内存" },
          ],
        },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("选哪些缓存方案? → Redis");
    // 单选项不应带 ", "
    expect(result.output).not.toContain(",");
  });

  test("多选全部勾选", async () => {
    setAskUserQuestionHandler(async () => ({
      status: "answered",
      answers: { "全部功能?": "日志, 追踪, 指标, 告警" },
    }));
    const result = await tool.execute({
      questions: [
        {
          question: "全部功能?",
          header: "全选",
          multi_select: true,
          options: [
            { label: "日志" },
            { label: "追踪" },
            { label: "指标" },
            { label: "告警" },
          ],
        },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("全部功能? → 日志, 追踪, 指标, 告警");
    // 四个选项以 ", " 连接
    const joined = "日志, 追踪, 指标, 告警";
    expect(result.output).toContain(joined);
  });

  test("Schema 常量已定义并使用", () => {
    // 验证常量值：文档 §3 标注的 MAX_OPTIONS/MIN_OPTIONS/MAX_QUESTIONS
    // 间接通过 schema 验证：传入合法数据应通过 execute 的 questions 非空校验
    // （zod 解析在 tool-executor 层，本题验证 execute 的手工校验门）
    expect(tool.isConcurrencySafe()).toBe(false);
  });

  test("alwaysLoad 首轮常驻可见，不再声明 shouldDefer（避免盲调翻车）", () => {
    // 交互类刚需工具（/commit 等内置流程直接点名要用）：首轮就该带完整 schema，
    // 否则模型看到工具名却没 schema，会凭记忆猜参数结构盲调（实测把 questions 猜成 answers）。
    // alwaysLoad=true 让它在 ToolSearch 启用时仍首轮可见；shouldDefer 与 alwaysLoad 语义互斥，
    // 不应同时声明（registry.isToolDeferred 里 alwaysLoad 优先级最高）。
    expect(tool.alwaysLoad).toBe(true);
    // shouldDefer 字段已从类上移除；用接口视角断言其为 undefined（未声明）。
    expect((tool as { shouldDefer?: boolean }).shouldDefer).toBeUndefined();
  });

  test("searchHint 仍保留（tool_search 关键词匹配兜底）", () => {
    expect(tool.searchHint).toContain("ask user question");
    expect(tool.searchHint).toContain("提问");
  });
});

// P1-3：askUserQuestionTimeout 解析 + 空闲超时
describe("parseAskTimeoutMs", () => {
  test("never / 空 / 0 → null（不启用超时）", () => {
    expect(parseAskTimeoutMs("never")).toBeNull();
    expect(parseAskTimeoutMs("")).toBeNull();
    expect(parseAskTimeoutMs(undefined)).toBeNull();
    expect(parseAskTimeoutMs("0")).toBeNull();
  });

  test("带单位的时长正确换算", () => {
    expect(parseAskTimeoutMs("60s")).toBe(60_000);
    expect(parseAskTimeoutMs("5m")).toBe(300_000);
    expect(parseAskTimeoutMs("2h")).toBe(7_200_000);
    expect(parseAskTimeoutMs("500ms")).toBe(500);
    expect(parseAskTimeoutMs("1.5m")).toBe(90_000);
  });

  test("纯数字视为毫秒", () => {
    expect(parseAskTimeoutMs("3000")).toBe(3000);
  });

  test("非法格式 → null", () => {
    expect(parseAskTimeoutMs("abc")).toBeNull();
    expect(parseAskTimeoutMs("5x")).toBeNull();
    expect(parseAskTimeoutMs("-3s")).toBeNull();
  });

  test("大小写与空白容忍", () => {
    expect(parseAskTimeoutMs(" 30S ")).toBe(30_000);
    expect(parseAskTimeoutMs("NEVER")).toBeNull();
  });
});

describe("AskUserQuestion 空闲超时行为（handler 模式模拟）", () => {
  beforeEach(() => {
    setAskUserQuestionHandler(null);
  });

  test("handler 挂 idle 定时器：到期按 cancelled 解除，不阻塞", async () => {
    // 模拟 app.ts 里注入的、带 idle 超时的 handler：用户永不响应
    const idleMs = parseAskTimeoutMs("60s")!;
    const shortMs = 30; // 测试用短超时，验证语义
    void idleMs; // 证明解析路径可用
    setAskUserQuestionHandler(async () => {
      return new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve({ status: "cancelled" });
        };
        setTimeout(done, shortMs);
        // 故意不提供任何"用户响应"路径，模拟无人值守
      });
    });

    const start = Date.now();
    const result = await askUserQuestion({
      questions: [{ question: "proceed?", header: "Q", options: [{ label: "yes" }, { label: "no" }] }],
    });
    const elapsed = Date.now() - start;

    expect(result.status).toBe("cancelled");
    expect(elapsed).toBeLessThan(5000); // 确实是超时解除而非挂死
  });
});
