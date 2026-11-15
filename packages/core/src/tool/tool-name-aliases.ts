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
  Monitor: "monitor",
  SendMessage: "send_message",
  ToolSearch: "tool_search",
  LSP: "lsp",
};

/** CC 旧名，只用于「CC 名 → 内部名」方向（反向一律发现行名） */
const CC_LEGACY_NAMES: Readonly<Record<string, string>> = {
  Task: "sub_agent",
};

/**
 * 已退役的内部名 → 现行内部名（D5/T8：2026-11-15）。
 *
 * 为什么单独一张表而不是塞进 `CC_TO_INTERNAL_TOOL_NAME`：那张表的语义是「CC 有、sid 有对应」，
 * 长度与 CC 工具数对账（`tests/tool/tool-name-aliases.test.ts`）；退役内部名是 sid 自己的历史，
 * 混进去会让对账断言失去意义。
 *
 * 登记后 `toInternalToolName` 对旧名返回现行名，权限规则 / hook matcher / 子代理黑名单
 * 三处消费方自动归一；注册表另有 `Registry.aliases` 兜住「模型仍然直接调旧名」的查找。
 */
export const RETIRED_INTERNAL_TOOL_NAMES: Readonly<Record<string, string>> = {
  // D5（T8）：两个功能重叠的后台任务查询工具合并，bg_task_get 的独有字段已并入 task_output。
  bg_task_get: "task_output",
};

/** 小写 key → 内部名（大小写不敏感查找用；内部名自身也登记，`bash`/`BASH` 都归到 `bash`） */
const LOOKUP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [from, internal] of Object.entries({
    ...CC_TO_INTERNAL_TOOL_NAME,
    ...CC_LEGACY_NAMES,
    ...RETIRED_INTERNAL_TOOL_NAMES,
  })) {
    m.set(from.toLowerCase(), internal);
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

/**
 * 工具名黑名单是否命中（`disallowedTools` 的唯一比较口径）。
 *
 * 名单项可以是 CC 名（`Bash` / `WebFetch`）、内部名、任意大小写，或带括号的规则写法
 * （`Bash(curl *)` —— 黑名单是**工具级**的，括号部分不参与比较，按整个工具禁用）。
 *
 * 为什么必须有这一处：权限层 Step 3 曾是 `disallowedTools.includes(req.toolName)`
 * 精确比较，`["Bash"]` / `["WebFetch"]` 对不上 `bash` / `web_fetch` → 静默不生效
 * （2026-10-24 实测 always-allow 下直接放行）。CLI 入口的 registry.removeByNames 自带归一，
 * 掩盖了这个问题；会话中途从 CLAUDE.md 合并进来的黑名单只经过权限层，正好踩中。
 * 子代理 tool-filter 的 Layer 3 有同一个精确比较，一起收口到这里。
 */
export function isToolNameListed(list: readonly string[] | undefined, toolName: string): boolean {
  if (!list || list.length === 0) return false;
  const target = toInternalToolName(toolName).toLowerCase();
  return list.some((raw) => {
    if (typeof raw !== "string") return false;
    const paren = raw.indexOf("(");
    const base = (paren >= 0 ? raw.slice(0, paren) : raw).trim();
    return base !== "" && toInternalToolName(base).toLowerCase() === target;
  });
}
