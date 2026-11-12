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
import { GrepTool } from "@sid-code/core/tool/grep.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";
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

/**
 * D10（20261112 工具设计对齐方案 T1）：CC Grep 的协议参数名就是短参数
 * `-i` / `-C` / `-A` / `-B`，模型按 CC 习惯传过来时原先被 zod 静默剥离——
 * 30 天实测 47 次真正丢意图（`-C` 28、`-i` 10、`-A` 9），且 `is_error=false`，
 * 失败被藏在「成功」里。
 *
 * 用真实 GrepTool 的 zodSchema，不用手搓近似 schema（理由同文件头）。
 */
describe("grep：CC 风格短参数别名（D10）", () => {
  const grepTool = () => new GrepTool() as unknown as LegacyTool;

  test("事故形态 -C:3 → context:3，不再被剥离，并发一条别名事件", () => {
    const v = validateToolInput(grepTool(), { pattern: "x", "-C": 3, output_mode: "content" });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect((v.data as { context?: number }).context).toBe(3);
    expect("-C" in (v.data as object)).toBe(false);
    const alias = events.filter((e) => e.event === "ToolInputAliasApplied");
    expect(alias).toHaveLength(1);
    expect(alias[0]!.data).toMatchObject({
      tool: "grep",
      from: "-C",
      to: "context",
      count: 1,
      dropped: 0,
    });
  });

  test("-C:'3' 字符串数字：改名后仍被 numeric 归一层接住（alias → numeric 链路）", () => {
    // 轨迹里 -C 有 23 次传的是字符串。别名改名在数字归一之前，这里锁定两层的顺序契约。
    const v = validateToolInput(grepTool(), { pattern: "x", "-C": "3" });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect((v.data as { context?: number }).context).toBe(3);
    expect(events.some((e) => e.event === "ToolInputCoerced" && e.data.layer === "numeric")).toBe(
      true,
    );
  });

  test.each([
    ["-i", "case_insensitive", true],
    ["-A", "after_context", 2],
    ["-B", "before_context", 4],
  ])("%s → %s（含布尔与数字两种取值）", (from, to, value) => {
    const v = validateToolInput(grepTool(), { pattern: "x", [from]: value });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect((v.data as Record<string, unknown>)[to]).toBe(value);
    expect(events.find((e) => e.event === "ToolInputAliasApplied")?.data).toMatchObject({
      from,
      to,
    });
  });

  test("两键并存：保留 context、丢弃 -C，dropped 计数为 1（沿用现有语义）", () => {
    const v = validateToolInput(grepTool(), { pattern: "x", context: 2, "-C": 5 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect((v.data as { context?: number }).context).toBe(2);
    expect("-C" in (v.data as object)).toBe(false);
    expect(events.find((e) => e.event === "ToolInputAliasApplied")?.data).toMatchObject({
      count: 0,
      dropped: 1,
    });
  });

  test("-n 不登记成别名：sid 没有对应字段，保持原有形态（已知无影响键由 D1/T2 处理）", () => {
    const r = normalizeInputAliases(grepTool().zodSchema, { pattern: "x", "-n": true });
    expect(r.hits).toHaveLength(0);
  });

  test("不误伤其他工具：read 的 shape 没有 context，-C 不改名（交给 D1/T2 报未知键）", () => {
    const read = new ReadTool() as unknown as LegacyTool;
    const r = normalizeInputAliases(read.zodSchema, { file_path: "/a", "-C": 3 });
    expect(r.hits).toHaveLength(0);
    expect((r.value as Record<string, unknown>)["-C"]).toBe(3);
  });
});
