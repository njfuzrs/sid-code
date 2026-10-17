/**
 * S2（20261016 静默停住方案）：工具入参 `activeForm` → `active_form` 别名归一
 *
 * 判据不是「报错文案点名了正确字段」（那已经有了，`findNearMissKey`），而是
 * **首次调用就成功、且内部字段真的被填上**——事故会话读到精确报错仍零重试，
 * 清单从未建成；`structured-task-*` 那边更糟，`activeForm` 被 zod 静默剥离。
 *
 * 这里用**真实工具的 zodSchema**（不是手搓的近似 schema）：近似 schema 绿了
 * 证明不了生产 schema 也绿（lazySchema / optional 包装层都可能让内省下不去）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { validateToolInput } from "@sid-code/core/tool/input-validator.ts";
import { normalizeInputAliases } from "@sid-code/core/tool/input-alias.ts";
import { TodoWriteTool } from "@sid-code/core/tool/todo-write.ts";
import { TaskCreateTool } from "@sid-code/core/tool/structured-task-create.ts";
import { TaskUpdateTool } from "@sid-code/core/tool/structured-task-update.ts";
import {
  __clearStructuredTasks,
  getStructuredTask,
} from "@sid-code/core/task/structured-task-store.ts";
import { initStreamObserver, resetStreamObserver } from "@sid-code/core/trace/stream-observer.ts";
import type { LegacyTool } from "@sid-code/core/tool/types.ts";

/** 校验 → 用校验后的 data 执行，与 query/tool-executor.ts 的生产顺序一致 */
async function validateThenExecute(tool: LegacyTool, input: unknown) {
  const v = validateToolInput(tool, input);
  if (!v.ok) return { validation: v, result: undefined };
  const result = await tool.execute(v.data as Record<string, unknown>);
  return { validation: v, result };
}

let events: Array<{ event: string; data: Record<string, unknown> }> = [];
beforeEach(() => {
  __clearStructuredTasks();
  events = [];
  initStreamObserver("test-session", "/tmp", (e) => events.push(e));
});
afterEach(() => {
  resetStreamObserver();
});

describe("todo_write：camelCase activeForm 首次调用即成功", () => {
  test("事故形态：todos[] 每项都写 activeForm → 校验通过且内部 activeForm 被填充", async () => {
    const tool = new TodoWriteTool() as unknown as LegacyTool;
    const { validation, result } = await validateThenExecute(tool, {
      todos: [
        { content: "读取安装输出", activeForm: "正在读取安装输出", status: "in_progress" },
        { content: "逐处修改", activeForm: "正在逐处修改", status: "pending" },
      ],
    });
    expect(validation.ok).toBe(true);
    expect(result?.isError).toBeFalsy();
    const todos = (tool as unknown as TodoWriteTool).getTodos();
    expect(todos.map((t) => t.activeForm)).toEqual(["正在读取安装输出", "正在逐处修改"]);

    // 度量：一次调用一条事件，count = 命中项数
    const alias = events.filter((e) => e.event === "ToolInputAliasApplied");
    expect(alias).toHaveLength(1);
    expect(alias[0]!.data).toMatchObject({
      tool: "todo_write",
      from: "activeForm",
      to: "active_form",
      count: 2,
      dropped: 0,
    });
  });

  test("两键同时出现：保留 active_form、丢弃 activeForm，并记 dropped", () => {
    const tool = new TodoWriteTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, {
      todos: [{ content: "c", active_form: "协议值", activeForm: "别名值", status: "pending" }],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const item = (v.data as { todos: Array<Record<string, unknown>> }).todos[0]!;
    expect(item.active_form).toBe("协议值");
    expect("activeForm" in item).toBe(false);
    const alias = events.find((e) => e.event === "ToolInputAliasApplied");
    expect(alias?.data).toMatchObject({ count: 0, dropped: 1 });
  });

  test("规范输入不产生度量事件（只在真的改名时发）", () => {
    const tool = new TodoWriteTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, {
      todos: [{ content: "c", active_form: "a", status: "pending" }],
    });
    expect(v.ok).toBe(true);
    expect(events.filter((e) => e.event === "ToolInputAliasApplied")).toHaveLength(0);
  });

  test("真的漏传（无任何近似键）仍被打回——归一不能把缺字段变成放行", () => {
    const tool = new TodoWriteTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, { todos: [{ content: "c", status: "pending" }] });
    expect(v.ok).toBe(false);
  });
});

describe("structured-task-create/update：activeForm 不再被静默剥离", () => {
  test("task_create 传 activeForm → 任务的 activeForm 被正确填充", async () => {
    const tool = new TaskCreateTool() as unknown as LegacyTool;
    const { validation, result } = await validateThenExecute(tool, {
      subject: "s",
      description: "d",
      activeForm: "正在做 s",
    });
    expect(validation.ok).toBe(true);
    expect(result?.isError).toBeFalsy();
    expect(getStructuredTask("1")?.activeForm).toBe("正在做 s");
  });

  test("task_update 传 activeForm → 更新落到任务上", async () => {
    const create = new TaskCreateTool() as unknown as LegacyTool;
    await validateThenExecute(create, { subject: "s", description: "d" });
    const update = new TaskUpdateTool() as unknown as LegacyTool;
    const { validation, result } = await validateThenExecute(update, {
      task_id: "1",
      status: "in_progress",
      activeForm: "正在更新",
    });
    expect(validation.ok).toBe(true);
    expect(result?.isError).toBeFalsy();
    expect(getStructuredTask("1")?.activeForm).toBe("正在更新");
  });
});

describe("strict null 回填回归：归一层不能破坏 nullish-normalize 的拆包", () => {
  test("task_create 的 active_form:null 仍被剥成缺省且校验通过", () => {
    const tool = new TaskCreateTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, { subject: "s", description: "d", active_form: null });
    expect(v.ok).toBe(true);
    if (v.ok) expect("active_form" in (v.data as object)).toBe(false);
  });

  test("activeForm:null 先改名再回填 → 同样剥成缺省（顺序：别名 → null 回填）", () => {
    const tool = new TaskCreateTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, { subject: "s", description: "d", activeForm: null });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect("active_form" in (v.data as object)).toBe(false);
      expect("activeForm" in (v.data as object)).toBe(false);
    }
  });
});

describe("normalizeInputAliases 边界", () => {
  test("无改动时返回同一引用（纯函数，不复制）", () => {
    const tool = new TodoWriteTool() as unknown as LegacyTool;
    const input = { todos: [{ content: "c", active_form: "a", status: "pending" }] };
    expect(normalizeInputAliases(tool.zodSchema, input).value).toBe(input);
  });

  test("不修改传入的 input", () => {
    const tool = new TodoWriteTool() as unknown as LegacyTool;
    const input = { todos: [{ content: "c", activeForm: "a", status: "pending" }] };
    normalizeInputAliases(tool.zodSchema, input);
    expect(input.todos[0]).toEqual({ content: "c", activeForm: "a", status: "pending" });
  });
});
