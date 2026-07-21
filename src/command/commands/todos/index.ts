import type { UnifiedCommand } from "../../types.ts";

/**
 * /todos 命令定义（轻量，启动时加载）。
 *
 * 列出当前会话的待办清单（TodoWriteTool 维护）。只读展示，不修改清单。
 * 对齐 claude-code /todos。实现在 ./todos.ts。
 */
const todos: UnifiedCommand = {
  type: "local",
  name: "todos",
  aliases: ["todo"],
  description: "列出当前会话的待办清单（TodoWrite 维护）",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./todos.ts").then((m) => m.default),
};

export default todos;
