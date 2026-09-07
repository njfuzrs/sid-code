/**
 * 参数校验错误消息的「可自救性」测试
 *
 * 判据不是「有没有报错」，而是**模型读完这条消息知不知道下一步该改什么**。
 * 三组缺陷都来自 `20260907-155904-69998cf1` 实测：
 *
 * 1. `todo_write` 传 camelCase `activeForm` → zod 静默剥离未识别键，报的是
 *    「active_form 实际收到 undefined」，看起来像"你漏传了"而真相是"名字写错了"。
 *    两句话指向完全不同的修法。
 * 2. `ask_user_question` 传 1 个 option → 只说「Too small: >=2 items」，
 *    不说上限是几、也不说该怎么办。
 * 3. 枚举传错值 → zod 原文虽含合法取值但埋在英文里，中文消息未提取。
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod/v4";
import { validateToolInput } from "@sid-code/core/tool/input-validator.ts";
import type { LegacyTool } from "@sid-code/core/tool/types.ts";

function fakeTool(name: string, schema: z.ZodTypeAny): LegacyTool {
  return {
    name: () => name,
    description: () => "",
    inputSchema: () => ({}),
    zodSchema: schema,
    execute: async () => ({ success: true, output: "" }),
  } as unknown as LegacyTool;
}

/** todo_write 的真实 schema 形状 */
const todoWriteLike = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      active_form: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
    }),
  ),
});

/** ask_user_question 的真实 schema 形状（options 2-4、questions 1-4） */
const askLike = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string(),
        options: z
          .array(z.object({ label: z.string() }))
          .min(2)
          .max(4),
      }),
    )
    .min(1)
    .max(4),
});

describe("命名风格写错 → 消息必须说「改名」而不是「你漏传了」", () => {
  const tool = fakeTool("todo_write", todoWriteLike);

  test("实测样本：todo_write 传 camelCase activeForm（5 项全中）", () => {
    // 取自 20260907-155904-69998cf1 toolu_bdrk_01Bu1b5yfCdPu19Nkvw8MTPj
    const r = validateToolInput(tool, {
      todos: [
        { content: "在 apis/index.ts 新增 API 封装", activeForm: "正在新增", status: "completed" },
        { content: "新建弹窗组件", activeForm: "正在新建", status: "in_progress" },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // 必须点名「传的是 activeForm、要的是 active_form」
    expect(r.message).toContain("activeForm");
    expect(r.message).toContain("active_form");
    expect(r.message).toContain("字段名写错了");
    // 且必须明确"不要新增字段"——否则模型可能两个键都塞
    expect(r.message).toContain("不要新增字段");
    // 反例：不能再是那句会误导的「实际收到 undefined」
    expect(r.message).not.toContain("实际收到 undefined");
  });

  test.each([
    ["kebab-case", "active-form"],
    ["全大写下划线", "ACTIVE_FORM"],
    ["首字母大写", "ActiveForm"],
  ])("%s（%s）同样识别为改名", (_n, wrongKey) => {
    const r = validateToolInput(tool, {
      todos: [{ content: "c", [wrongKey]: "a", status: "completed" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain(wrongKey);
      expect(r.message).toContain("字段名写错了");
    }
  });

  test("真的漏传（没有任何近似键）→ 仍报「实际收到 undefined」，不能瞎猜成改名", () => {
    const r = validateToolInput(tool, {
      todos: [{ content: "c", status: "completed" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("实际收到 undefined");
      expect(r.message).not.toContain("字段名写错了");
    }
  });

  test("不做模糊距离匹配：offset/limit 这类短名不互指", () => {
    // 只认「归一化后完全相等」的命名风格差异。模糊匹配会把 offset 指成 limit，
    // 把一条准确的错误变成误导——这条钉住那个边界。
    const t = fakeTool("read", z.object({ file_path: z.string(), offset: z.number() }));
    const r = validateToolInput(t, { file_path: "/a", limit: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toContain("字段名写错了");
      expect(r.message).toContain("offset");
    }
  });

  test("顶层字段（非嵌套）也生效", () => {
    const t = fakeTool("bash", z.object({ run_in_background: z.boolean() }));
    const r = validateToolInput(t, { runInBackground: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("字段名写错了");
  });
});

describe("数量/长度越界 → 消息必须带边界数字和修法", () => {
  const tool = fakeTool("ask_user_question", askLike);

  test("实测样本：ask_user_question 第 1 题只给 1 个 option", () => {
    // 取自 20260907-155904-69998cf1 toolu_bdrk_01EsjySCE828Pc3EEXLAW9VA
    // （实际入参 options_per_q=[1, 2, 2]，只有第 0 题违规）
    const r = validateToolInput(tool, {
      questions: [
        { question: "字段口径？", header: "字段口径", options: [{ label: "使用 id" }] },
        {
          question: "依赖处理？",
          header: "依赖处理",
          options: [{ label: "自动补齐" }, { label: "仅提示" }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("questions.0.options");
    // 关键：要能读出「至少 2」这个数字，而不是只有英文 Too small
    expect(r.message).toContain("至少");
    expect(r.message).toContain("2");
    expect(r.message).toContain("太少");
  });

  test("超上限（5 个 option）→ 说「至多 4」", () => {
    const r = validateToolInput(tool, {
      questions: [
        {
          question: "q?",
          header: "h",
          options: [1, 2, 3, 4, 5].map((i) => ({ label: `o${i}` })),
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("太多");
      expect(r.message).toContain("至多");
      expect(r.message).toContain("4");
    }
  });

  test("空数组（questions: []）→ 说「至少 1」", () => {
    const r = validateToolInput(tool, { questions: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("至少");
  });

  test("字符串长度与数值范围各自用对量词", () => {
    const t = fakeTool("x", z.object({ name: z.string().min(3), n: z.number().min(1) }));
    const rs = validateToolInput(t, { name: "a", n: 5 });
    expect(rs.ok).toBe(false);
    if (!rs.ok) expect(rs.message).toContain("个字符");

    const rn = validateToolInput(t, { name: "abc", n: 0 });
    expect(rn.ok).toBe(false);
    if (!rn.ok) expect(rn.message).toContain("数值");
  });
});

describe("枚举取值非法 → 直接列出合法取值", () => {
  test("status 传 done → 列出 pending|in_progress|completed", () => {
    const tool = fakeTool("todo_write", todoWriteLike);
    const r = validateToolInput(tool, {
      todos: [{ content: "c", active_form: "a", status: "done" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("合法取值");
      expect(r.message).toContain("pending");
      expect(r.message).toContain("in_progress");
      expect(r.message).toContain("completed");
    }
  });
});

describe("不回归：合法输入与既有行为", () => {
  test("完全合法的 todo_write 通过", () => {
    const tool = fakeTool("todo_write", todoWriteLike);
    const r = validateToolInput(tool, {
      todos: [{ content: "c", active_form: "a", status: "completed" }],
    });
    expect(r.ok).toBe(true);
  });

  test("完全合法的 ask_user_question 通过", () => {
    const tool = fakeTool("ask_user_question", askLike);
    const r = validateToolInput(tool, {
      questions: [{ question: "q?", header: "h", options: [{ label: "a" }, { label: "b" }] }],
    });
    expect(r.ok).toBe(true);
  });

  test("类型不符（非 undefined）仍报期望/实际，且实际类型不是 unknown", () => {
    const tool = fakeTool("read", z.object({ file_path: z.string() }));
    const r = validateToolInput(tool, { file_path: 123 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("期望 string");
      expect(r.message).toContain("实际收到 number");
    }
  });

  test("多字段同时出错仍逐条列出", () => {
    const tool = fakeTool("todo_write", todoWriteLike);
    const r = validateToolInput(tool, {
      todos: [{ content: "c", activeForm: "a", status: "done" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message.split("\n").length).toBeGreaterThanOrEqual(3);
    }
  });

  test("无 zodSchema 的工具仍原样放行", () => {
    const bare = { name: () => "x", zodSchema: undefined } as unknown as LegacyTool;
    const input = { anything: 1 };
    const r = validateToolInput(bare, input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe(input);
  });
});
