/**
 * CC 工具名 ↔ sid 内部工具名 别名表（唯一事实源）
 *
 * 权限规则（permission/rules.ts）与 hook matcher（hook/planner.ts）共用这一张表。
 * 以前两处各管各的：`if:"Bash(...)"` 走权限规则能认 CC 名，同一条 hook 的 `matcher:"Bash"` 却不认（HC8）。
 *
 * 只收 CC 确实有、sid 有对应语义的工具；sid 独有工具（ls / read_many / save_memory / hypothesis_* /
 * team_* / workflow / agent__<name>）与 MCP 工具（mcp__<server>__<tool>）不在表里，只认内部名。
 * 内部名以各工具 `name()` 的实际返回为准（tests/tool/tool-name-aliases.test.ts 有对账断言）。
 */

/** CC 名 → sid 内部名 */
export const CC_TO_INTERNAL_TOOL_NAME: Readonly<Record<string, string>> = {
  Bash: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
  NotebookEdit: "notebook_edit",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  TodoWrite: "todo_write",
  Agent: "sub_agent",
  TaskCreate: "task_create",
  TaskUpdate: "task_update",
  TaskGet: "task_get",
  TaskList: "task_list",
  TaskOutput: "task_output",
  TaskStop: "task_stop",
  AskUserQuestion: "ask_user_question",
  EnterPlanMode: "enter_plan_mode",
  ExitPlanMode: "exit_plan_mode",
  EnterWorktree: "enter_worktree",
  ExitWorktree: "exit_worktree",
  CronCreate: "cron_create",
  CronDelete: "cron_delete",
  CronList: "cron_list",
  ScheduleWakeup: "schedule_wakeup",
  SendMessage: "send_message",
  ToolSearch: "tool_search",
  LSP: "lsp",
};

/** CC 旧名，只用于「CC 名 → 内部名」方向（反向一律发现行名） */
const CC_LEGACY_NAMES: Readonly<Record<string, string>> = {
  Task: "sub_agent",
};

/** 小写 key → 内部名（大小写不敏感查找用；内部名自身也登记，`bash`/`BASH` 都归到 `bash`） */
const LOOKUP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [cc, internal] of Object.entries({
    ...CC_TO_INTERNAL_TOOL_NAME,
    ...CC_LEGACY_NAMES,
  })) {
    m.set(cc.toLowerCase(), internal);
    m.set(internal.toLowerCase(), internal);
    // 去掉下划线的写法（`notebookedit` / `webfetch`）沿用 permission/rules.ts 旧别名的口径
    m.set(internal.replace(/_/g, ""), internal);
  }
  return m;
})();

/** 内部名 → CC 名 */
const INTERNAL_TO_CC: ReadonlyMap<string, string> = new Map(
  Object.entries(CC_TO_INTERNAL_TOOL_NAME).map(([cc, internal]) => [internal, cc]),
);

/**
 * 把任意写法（CC 名 / 内部名，大小写不敏感）归一到内部名。
 * 表外的名字**原样返回**（不改大小写）：MCP 工具名大小写有意义，归一与否交给调用方决定。
 */
export function toInternalToolName(name: string): string {
  return LOOKUP.get(name.toLowerCase()) ?? name;
}

/** 内部名 → CC 名；sid 独有工具与 MCP 工具没有 CC 名，返回 undefined */
export function toCcToolName(internalName: string): string | undefined {
  return INTERNAL_TO_CC.get(internalName);
}
