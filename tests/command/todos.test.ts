/**
 * /todos 命令测试（P1-2）
 *
 * 覆盖：空清单友好提示 / 工具未加载降级 / 分组渲染（进行中/待开始/已完成）+ 进度汇总 /
 * 单色字形（无彩色 emoji，遵守 src/ui/CLAUDE.md L1.1）。
 */
import { describe, test, expect } from "bun:test";
import todosCmd from "@sid-code/cli/command/commands/todos/index.ts";
import type { CommandContext, LocalCommand } from "@sid-code/cli/command/types.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";
import { TODO_PENDING, TODO_IN_PROGRESS, TODO_COMPLETED } from "@sid-code/cli/ui/constants/figures.ts";

const loadTodos = () => (todosCmd as LocalCommand).load();

/** 构造最小 ctx，toolRegistry.get("todo_write") 返回带 getTodos 的桩。 */
function makeCtx(todos: TodoItem[] | null) {
  const tool = todos === null ? undefined : { getTodos: () => todos };
  return {
    toolRegistry: { get: (name: string) => (name === "todo_write" ? tool : undefined) },
  } as unknown as CommandContext;
}

function todo(content: string, status: TodoItem["status"], activeForm?: string): TodoItem {
  return { content, status, activeForm: activeForm ?? content } as TodoItem;
}

describe("/todos 命令", () => {
  test("工具未加载 → 降级提示（非错误）", async () => {
    const mod = await loadTodos();
    const r = await mod.call("", makeCtx(null));
    expect(r).toEqual({ type: "text", value: expect.stringContaining("TodoWrite 工具未加载") });
  });

  test("空清单 → 友好提示，不是错误", async () => {
    const mod = await loadTodos();
    const r = await mod.call("", makeCtx([]));
    expect(r.type).toBe("text");
    expect((r as { value: string }).value).toContain("没有待办事项");
  });

  test("分组渲染 + 进度汇总", async () => {
    const mod = await loadTodos();
    const items = [
      todo("完成 A", "completed"),
      todo("做 B", "in_progress", "正在做 B"),
      todo("待办 C", "pending"),
    ];
    const r = await mod.call("", makeCtx(items));
    const value = (r as { value: string }).value;
    // 分组标题齐全
    expect(value).toContain("进行中:");
    expect(value).toContain("待开始:");
    expect(value).toContain("已完成:");
    // 进行中用 activeForm
    expect(value).toContain("正在做 B");
    // 进度汇总
    expect(value).toContain("1/3 已完成");
    expect(value).toContain("1 进行中");
    expect(value).toContain("1 待开始");
  });

  test("字形是单色几何字形，无彩色 emoji（L1.1 铁律）", async () => {
    const mod = await loadTodos();
    const items = [
      todo("完成 A", "completed"),
      todo("做 B", "in_progress"),
      todo("待办 C", "pending"),
    ];
    const r = await mod.call("", makeCtx(items));
    const value = (r as { value: string }).value;
    // 用 figures.ts 单色字形
    expect(value).toContain(TODO_COMPLETED);
    expect(value).toContain(TODO_IN_PROGRESS);
    expect(value).toContain(TODO_PENDING);
    // 禁彩色 emoji
    expect(value).not.toContain("✅");
    expect(value).not.toContain("🔄");
    expect(value).not.toContain("⬜");
  });
});
