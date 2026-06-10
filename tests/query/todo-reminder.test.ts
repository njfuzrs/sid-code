/**
 * Todo 回注与完成度校验单元测试（P0-2 / P0-3）
 *
 * 参考: docs/bugfixes/todo/长任务遗漏-Harness根因与完成率提升方案.md §P0-2 / §P0-3
 */

import { describe, it, expect } from "bun:test";
import {
  TODO_REMINDER_CONFIG,
  MAX_TODO_GATE_RETRIES,
  unfinishedTodos,
  countUnfinished,
  buildTodoReminder,
  buildTodoGateMessage,
  buildTodoGateExhaustedMessage,
} from "../../src/query/todo-reminder.ts";
import type { TodoItem } from "../../src/tool/todo-write.ts";

function todo(content: string, status: TodoItem["status"]): TodoItem {
  return { content, activeForm: `正在${content}`, status };
}

describe("todo-reminder — P0-2 回注", () => {
  const todos: TodoItem[] = [
    todo("任务一", "completed"),
    todo("任务二", "in_progress"),
    todo("任务三", "pending"),
  ];

  it("countUnfinished 统计 pending + in_progress", () => {
    expect(countUnfinished(todos)).toBe(2);
    expect(unfinishedTodos(todos).map((t) => t.content)).toEqual(["任务二", "任务三"]);
  });

  it("阈值配置合理（弱模型记忆短，≤ claude-code 的 10）", () => {
    expect(TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE).toBeLessThanOrEqual(10);
    expect(TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS).toBeGreaterThan(0);
  });

  it("buildTodoReminder 含完整清单 + 状态标签 + system-reminder 包裹", () => {
    const r = buildTodoReminder(todos);
    expect(r).toContain("<system-reminder>");
    expect(r).toContain("</system-reminder>");
    expect(r).toContain("[completed] 任务一");
    expect(r).toContain("[in_progress] 任务二");
    expect(r).toContain("[pending] 任务三");
    expect(r).toContain("2 项未完成");
  });
});

describe("todo-reminder — P0-3 完成度闸门", () => {
  const todos: TodoItem[] = [
    todo("做完的", "completed"),
    todo("没做的", "pending"),
  ];

  it("最大续命次数为正整数", () => {
    expect(MAX_TODO_GATE_RETRIES).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(MAX_TODO_GATE_RETRIES)).toBe(true);
  });

  it("buildTodoGateMessage 列出未完成项并阻止收尾", () => {
    const m = buildTodoGateMessage(todos);
    expect(m).toContain("仍有 1 项未完成");
    expect(m).toContain("没做的");
    expect(m).not.toContain("做完的"); // 只列未完成项
    expect(m).toContain("不要提前收尾");
  });

  it("buildTodoGateExhaustedMessage 如实列出未完成项（不假装完成）", () => {
    const m = buildTodoGateExhaustedMessage(todos);
    expect(m).toContain("1 项任务未完成");
    expect(m).toContain("没做的");
    expect(m).toContain(`${MAX_TODO_GATE_RETRIES}`);
  });
});
