/**
 * Todo 回注与完成度校验单元测试（P0-2 / P0-3）
 *
 * 参考: docs/bugfixes/todo/长任务遗漏-Harness根因与完成率提升方案.md §P0-2 / §P0-3
 */

import { describe, it, expect } from "bun:test";
import {
  TODO_REMINDER_CONFIG,
  MAX_TODO_GATE_RETRIES,
  TODO_GATE_FORGOT_MARK_THRESHOLD,
  TODO_GATE_PRODUCTIVE_TEXT_MIN,
  unfinishedTodos,
  countUnfinished,
  buildTodoReminder,
  buildTodoGateMessage,
  buildTodoGateExhaustedMessage,
  buildTodoGateForgotMarkMessage,
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

describe("todo-reminder — P0-3 误判自愈（忘标记 vs 真没做完）", () => {
  it("忘标记阈值取满续命次数（最保守：每次都有产出却不翻状态位才判忘标记）", () => {
    expect(TODO_GATE_FORGOT_MARK_THRESHOLD).toBe(MAX_TODO_GATE_RETRIES);
  });

  it("实质产出阈值远高于一句寒暄（≥200 字符）", () => {
    expect(TODO_GATE_PRODUCTIVE_TEXT_MIN).toBeGreaterThanOrEqual(200);
  });

  it("buildTodoGateForgotMarkMessage 中性收尾：不抛'未完成'红字、不断言'已完成'", () => {
    const m = buildTodoGateForgotMarkMessage();
    // 不得出现制造假警报的"仍有 N 项未完成"字样
    expect(m).not.toContain("未完成");
    expect(m).not.toContain("⚠️");
    // 也不得武断宣称已完成（门禁读不到模型的心）
    expect(m).not.toContain("已全部完成");
    // 应给出"可核对"的温和出口
    expect(m).toContain("核对");
  });

  it("忘标记文案与如实警报文案是两条不同路径（措辞可区分）", () => {
    const forgot = buildTodoGateForgotMarkMessage();
    const honest = buildTodoGateExhaustedMessage([
      todo("做完的", "completed"),
      todo("没做的", "pending"),
    ]);
    expect(forgot).not.toBe(honest);
    // 如实警报保留"未完成"语义，忘标记路径不含
    expect(honest).toContain("未完成");
    expect(forgot).not.toContain("未完成");
  });
});
