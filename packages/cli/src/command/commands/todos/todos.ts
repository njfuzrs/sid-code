import type { LocalCommandModule } from "../../types.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";
import { TODO_PENDING, TODO_IN_PROGRESS, TODO_COMPLETED } from "../../../ui/constants/figures.ts";

/**
 * /todos 命令实现（按需加载）
 *
 * 从 TodoWriteTool（工具名 "todo_write"）读取当前会话的待办清单，只读展示。
 * 按状态分组渲染：进行中 / 待开始 / 已完成，并给出进度汇总。
 * 空清单时给友好提示（不是错误）。
 */
const mod: LocalCommandModule = {
  async call(_args, ctx) {
    const tool = ctx.toolRegistry.get("todo_write") as
      | { getTodos?: () => TodoItem[] }
      | undefined;

    if (!tool?.getTodos) {
      return { type: "text", value: "当前没有可用的待办清单（TodoWrite 工具未加载）" };
    }

    const todos = tool.getTodos();
    if (todos.length === 0) {
      return {
        type: "text",
        value: "当前没有待办事项。\n执行复杂任务时，我会自动用 TodoWrite 建立并追踪清单。",
      };
    }

    return { type: "text", value: renderTodos(todos) };
  },
};

/**
 * 状态字形：靠「填充度」表达递进（○ 待办 → ◐ 进行中 → ● 完成），单色几何字形。
 * 从 figures.ts 取，遵守 src/ui/CLAUDE.md L1.1「禁彩色 emoji」——此前用 ✅🔄⬜ 违反该铁律。
 */
function icon(status: TodoItem["status"]): string {
  return status === "completed"
    ? TODO_COMPLETED
    : status === "in_progress"
      ? TODO_IN_PROGRESS
      : TODO_PENDING;
}

/** 按状态分组渲染：进行中 → 待开始 → 已完成，末尾附进度汇总 */
function renderTodos(todos: TodoItem[]): string {
  const inProgress = todos.filter((t) => t.status === "in_progress");
  const pending = todos.filter((t) => t.status === "pending");
  const completed = todos.filter((t) => t.status === "completed");

  const lines: string[] = ["待办清单:"];

  const section = (title: string, items: TodoItem[]) => {
    if (items.length === 0) return;
    lines.push("", title);
    for (const t of items) {
      // 进行中的用 activeForm（进行时形式）更贴近当前状态
      const label = t.status === "in_progress" ? t.activeForm : t.content;
      lines.push(`  ${icon(t.status)} ${label}`);
    }
  };

  section("进行中:", inProgress);
  section("待开始:", pending);
  section("已完成:", completed);

  lines.push(
    "",
    `进度: ${completed.length}/${todos.length} 已完成` +
      (inProgress.length > 0 ? `, ${inProgress.length} 进行中` : "") +
      (pending.length > 0 ? `, ${pending.length} 待开始` : ""),
  );

  return lines.join("\n");
}

export default mod;
