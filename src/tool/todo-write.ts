/**
 * TodoWrite 工具
 * 执行阶段轻量级进度追踪，对标 Claude Code TodoWriteTool
 * 解决 Plan Mode 套娃问题：执行阶段缺少进度管理 → agent 被迫重新 enter_plan_mode
 *
 * fix_type: new_module（§0.3 L≥3 流程）
 * 参考: docs/bugfixes/todo/PlanMode-套娃根因与TodoWrite方案.md
 * 对标: Claude Code src/tools/TodoWriteTool/TodoWriteTool.ts
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";

export interface TodoItem {
  /** 任务描述（祈使形式），如 "新增 crash-marker.ts" */
  content: string;
  /** 进行时形式，如 "正在新增 crash-marker.ts" */
  activeForm: string;
  /** 任务状态 */
  status: "pending" | "in_progress" | "completed";
}

function formatTodoItem(t: TodoItem, idx: number): string {
  const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜";
  return `  ${icon} ${idx + 1}. ${t.content}`;
}

function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return "  (空)";
  return todos.map((t, i) => formatTodoItem(t, i)).join("\n");
}

function formatTodoDiff(oldTodos: TodoItem[], newTodos: TodoItem[]): string {
  const lines: string[] = [];
  lines.push("任务清单已更新:\n");
  lines.push("更新后:");
  lines.push(formatTodoList(newTodos));

  // 检测状态变更
  for (let i = 0; i < newTodos.length; i++) {
    const n = newTodos[i];
    const o = oldTodos[i];
    if (!o) continue;
    if (o.status !== n.status && n.status === "completed") {
      lines.push(`\n✅ 已完成: ${n.content}`);
    }
  }

  // 统计
  const completed = newTodos.filter(t => t.status === "completed").length;
  const inProgress = newTodos.filter(t => t.status === "in_progress").length;
  const pending = newTodos.filter(t => t.status === "pending").length;
  lines.push(`\n进度: ${completed}/${newTodos.length} 已完成` +
    (inProgress > 0 ? `, ${inProgress} 进行中` : "") +
    (pending > 0 ? `, ${pending} 待开始` : ""));

  return lines.join("\n");
}

const VALID_STATUSES = new Set(["pending", "in_progress", "completed"]);

export class TodoWriteTool implements Tool {
  private currentTodos: TodoItem[] = [];

  name(): string {
    return "todo_write";
  }

  description(): string {
    return `使用此工具创建和管理当前编码会话的结构化任务清单。帮助你追踪进度、组织复杂任务、向用户展示完整性。

## 何时使用
1. 复杂多步骤任务 — 需要 3 个或更多独立步骤
2. 非平凡复杂任务 — 需要仔细规划或多个操作
3. 用户明确要求 todo 列表
4. 用户提供多个任务（编号或逗号分隔）
5. 收到新指令后 — 立即将用户需求捕捉为 todo 项
6. ExitPlanMode 批准后 — 将批准的 plan 拆解为 todo 项，逐条执行
7. 开始一个任务前 — 先标记为 in_progress 再开始工作
8. 完成任务后 — 立即标记为 completed（不要批量完成）

## 何时不使用
1. 只有一个简单任务
2. 任务太简单，追踪没有组织价值
3. 任务可以在 3 个以下简单步骤内完成
4. 任务是纯对话或信息查询

## 任务状态
- pending: 尚未开始
- in_progress: 正在进行（**恰好一个，不多不少** — 任何时候都必须有且仅有一个 in_progress）
- completed: 已完成

## 任务管理规则
- 实时更新状态
- 完成后立即标记（不要攒到最后一起标记）
- **恰好一个 in_progress** — 任何时候都必须有且仅有一个 in_progress 任务
- 完成当前任务再开始新任务
- 删除不再相关的任务

## 任务完成要求
- 只有完全完成才能标记 completed
- 遇到错误、阻塞或无法完成 → 保持 in_progress
- 被阻塞时 → 创建新任务描述需要解决的问题
- 绝对不能在没有完全完成时标记 completed：测试失败、实现不完整、遇到未解决错误、找不到需要的文件或依赖

如有疑问，使用此工具。主动管理任务展示你的细致度，确保完成所有需求。`;
  }

  inputSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "完整的 todo 列表（全量替换）",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "任务描述（祈使形式），如 '新增 crash-marker.ts'",
              },
              activeForm: {
                type: "string",
                description: "进行时形式，如 '正在新增 crash-marker.ts'",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "任务状态",
              },
            },
            required: ["content", "activeForm", "status"],
          },
        },
      },
      required: ["todos"],
    };
  }

  readOnly(): boolean {
    return false;
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  /** 获取当前 todo 列表的深拷贝（供 TUI 面板读取，防止外部修改污染内部状态） */
  getTodos(): TodoItem[] {
    return this.currentTodos.map(t => ({ ...t }));
  }

  async execute(input: unknown, _signal?: AbortSignal): Promise<ToolResult> {
    const params = input as { todos?: unknown };

    // 校验 todos 是数组
    if (!Array.isArray(params?.todos)) {
      return {
        output: "todos 必须是数组。格式: { todos: [{ content, activeForm, status }] }",
        isError: true,
      };
    }

    const todos = params.todos as TodoItem[];

    // 校验每个 todo 项
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i];
      if (!t || typeof t.content !== "string" || !t.content.trim()) {
        return {
          output: `第 ${i + 1} 个 todo 项缺少有效的 content 字段`,
          isError: true,
        };
      }
      if (typeof t.activeForm !== "string" || !t.activeForm.trim()) {
        return {
          output: `第 ${i + 1} 个 todo 项缺少有效的 activeForm 字段`,
          isError: true,
        };
      }
      if (!VALID_STATUSES.has(t.status)) {
        return {
          output: `第 ${i + 1} 个 todo 项的 status 无效: "${t.status}"。有效值: pending, in_progress, completed`,
          isError: true,
        };
      }
    }

    // 检查全部完成（必须在 in_progress 校验之前，否则 [{completed}, {completed}] 会被误杀）
    const allDone = todos.length > 0 && todos.every(t => t.status === "completed");

    // 检查 in_progress 数量：恰好一个（对齐 Claude Code 约束）
    // 放行：全 pending（首次创建）和 全 completed（清空列表）
    // 拦截：多个 in_progress / 存在 completed 但无 in_progress
    if (!allDone) {
      const inProgressCount = todos.filter(t => t.status === "in_progress").length;
      const hasNonPending = todos.some(t => t.status !== "pending");
      if (inProgressCount > 1) {
        return {
          output: `不能有多个 in_progress 任务（当前 ${inProgressCount} 个）。请只保留一个 in_progress，其余设为 pending。`,
          isError: true,
        };
      }
      if (hasNonPending && inProgressCount === 0) {
        return {
          output: `当前没有 in_progress 任务。请将一个任务标记为 in_progress 再提交。任何时候都必须有恰好一个 in_progress。`,
          isError: true,
        };
      }
    }

    // 保存旧状态
    const oldTodos = [...this.currentTodos];

    // 更新为新状态（全量替换）
    this.currentTodos = allDone ? [] : todos;

    // 空列表检测
    if (this.currentTodos.length === 0 && oldTodos.length > 0) {
      return {
        output: "所有任务已完成。请汇总执行结果并告知用户。\n\n旧任务列表:\n" + formatTodoList(oldTodos),
      };
    }

    // 返回 diff
    return {
      output: formatTodoDiff(oldTodos, this.currentTodos),
    };
  }
}
