/**
 * T2（D1）全工具门禁：每个内置工具的 schema 都必须能检出未声明的顶层键。
 *
 * 这条防的是**静默失明**：`findUnknownTopLevelKeys` 只对「顶层 `z.object` 且未知键会被
 * 剥离」的 schema 生效。如果某个工具换成 `.passthrough()`（未知键会被保留）、`z.record`
 * 或顶层 union，T2 对它就不再有任何信号——而且**不会有任何测试变红**，因为它只是
 * 「什么都没报」。恒绿的防线比没有防线更危险，所以这里从真实注册表逐个体检。
 *
 * 取数口径（与 T0 的 `--dump-tool-meta` 对账）：
 * - 用真实注册表拿到 42 个工具名（`builtinToolMeta()`），与这里的构造清单**双向对账**：
 *   注册表里有、测试里没构造 → 红；测试里构造了、注册表里没有 → 也红（名字漂移）。
 * - 实例从各工具模块直接构造，不依赖 cli 的注册路径（core 不能 import cli）。
 *   构造函数参数只在**执行时**才被用到，这里只取 `zodSchema`，传空对象即可。
 *
 * 豁免只有一条：`notebook_edit` 没有 `zodSchema`（`hasZodSchema === false`），
 * 它整条校验链都不走，由 T3 补——补完之后这条豁免必须删掉，否则本门禁会替它兜底。
 */

import { describe, expect, test } from "bun:test";
import { builtinToolMeta } from "../helpers/builtin-tool-meta.ts";
import { findUnknownTopLevelKeys } from "@sid-code/core/tool/input-validator.ts";
import type { LegacyTool } from "@sid-code/core/tool/types.ts";

// 工具类（按名字排序，与 dump 一致）
import { ListMcpResourcesTool, ReadMcpResourceTool } from "@sid-code/core/tool/mcp-resources.ts";
import { BundledSkillTool } from "@sid-code/core/skill/bundled/tool.ts";
import { AskUserQuestionTool } from "@sid-code/core/tool/ask-user-question.ts";
import { BashTool } from "@sid-code/core/tool/bash.ts";
import { TaskGetTool } from "@sid-code/core/tool/task-get.ts";
import { TaskListTool } from "@sid-code/core/tool/task-list.ts";
import { CronCreateTool } from "@sid-code/core/tool/cron-create.ts";
import { CronDeleteTool } from "@sid-code/core/tool/cron-delete.ts";
import { CronListTool } from "@sid-code/core/tool/cron-list.ts";
import { EditTool } from "@sid-code/core/tool/edit.ts";
import { EnterPlanModeTool } from "@sid-code/core/tool/enter-plan-mode.ts";
import { EnterWorktreeTool } from "@sid-code/core/tool/enter-worktree.ts";
import { ExitPlanModeTool } from "@sid-code/core/tool/exit-plan-mode.ts";
import { ExitWorktreeTool } from "@sid-code/core/tool/exit-worktree.ts";
import { GlobTool } from "@sid-code/core/tool/glob.ts";
import { GrepTool } from "@sid-code/core/tool/grep.ts";
import { LsTool } from "@sid-code/core/tool/ls.ts";
import { LSPTool } from "@sid-code/core/tool/lsp.ts";
import { MonitorTool } from "@sid-code/core/tool/monitor.ts";
import { NotebookEditTool } from "@sid-code/core/tool/notebook-edit.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";
import { ReadManyTool } from "@sid-code/core/tool/read-many.ts";
import { MemoryTool } from "@sid-code/core/tool/memory.ts";
import { ScheduleWakeupTool } from "@sid-code/core/tool/schedule-wakeup.ts";
import { SendMessageTool } from "@sid-code/core/tool/send-message.ts";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { TaskCreateTool } from "@sid-code/core/tool/structured-task-create.ts";
import { StructuredTaskGetTool } from "@sid-code/core/tool/structured-task-get.ts";
import { StructuredTaskListTool } from "@sid-code/core/tool/structured-task-list.ts";
import { TaskOutputTool } from "@sid-code/core/tool/task-output.ts";
import { TaskStopTool } from "@sid-code/core/tool/task-stop.ts";
import { TaskUpdateTool } from "@sid-code/core/tool/structured-task-update.ts";
import { TeamCreateTool } from "@sid-code/core/tool/team-create.ts";
import { TeamMessageTool } from "@sid-code/core/tool/team-message.ts";
import { thinkTool } from "@sid-code/core/tool/think.ts";
import { TodoWriteTool } from "@sid-code/core/tool/todo-write.ts";
import { ToolSearchTool } from "@sid-code/core/tool/tool-search.ts";
import { WebFetchTool } from "@sid-code/core/tool/web-fetch.ts";
import { WebSearchTool } from "@sid-code/core/tool/web-search.ts";
import { WorkflowTool } from "@sid-code/core/tool/workflow.ts";
import { WriteTool } from "@sid-code/core/tool/write.ts";

/** 只读用途的空依赖：这些参数不会在取 zodSchema 时被访问 */
const anyDep = () => ({}) as any;

/**
 * 工具名 → 实例工厂。**必须覆盖 `--dump-tool-meta` 的全部 42 个名字**，
 * 缺一个下面的对账会红（防「新加工具没人测」）。
 */
const FACTORIES: Record<string, () => LegacyTool> = {
  ListMcpResources: () => new ListMcpResourcesTool(anyDep()),
  ReadMcpResource: () => new ReadMcpResourceTool(anyDep()),
  Skill: () => new BundledSkillTool(anyDep(), anyDep(), anyDep()) as unknown as LegacyTool,
  ask_user_question: () => new AskUserQuestionTool() as unknown as LegacyTool,
  bash: () => new BashTool() as unknown as LegacyTool,
  bg_task_get: () => new TaskGetTool() as unknown as LegacyTool,
  bg_task_list: () => new TaskListTool() as unknown as LegacyTool,
  cron_create: () => new CronCreateTool() as unknown as LegacyTool,
  cron_delete: () => new CronDeleteTool() as unknown as LegacyTool,
  cron_list: () => new CronListTool() as unknown as LegacyTool,
  edit: () => new EditTool() as unknown as LegacyTool,
  enter_plan_mode: () => new EnterPlanModeTool(anyDep()) as unknown as LegacyTool,
  enter_worktree: () => new EnterWorktreeTool() as unknown as LegacyTool,
  exit_plan_mode: () => new ExitPlanModeTool(anyDep()) as unknown as LegacyTool,
  exit_worktree: () => new ExitWorktreeTool() as unknown as LegacyTool,
  glob: () => new GlobTool() as unknown as LegacyTool,
  grep: () => new GrepTool() as unknown as LegacyTool,
  ls: () => new LsTool() as unknown as LegacyTool,
  lsp: () => new LSPTool() as unknown as LegacyTool,
  monitor: () => new MonitorTool() as unknown as LegacyTool,
  notebook_edit: () => new NotebookEditTool() as unknown as LegacyTool,
  read: () => new ReadTool() as unknown as LegacyTool,
  read_many: () => new ReadManyTool() as unknown as LegacyTool,
  save_memory: () => new MemoryTool(anyDep()) as unknown as LegacyTool,
  schedule_wakeup: () => new ScheduleWakeupTool() as unknown as LegacyTool,
  send_message: () => new SendMessageTool() as unknown as LegacyTool,
  sub_agent: () => new SubAgentTool(anyDep(), anyDep()) as unknown as LegacyTool,
  task_create: () => new TaskCreateTool() as unknown as LegacyTool,
  task_get: () => new StructuredTaskGetTool() as unknown as LegacyTool,
  task_list: () => new StructuredTaskListTool() as unknown as LegacyTool,
  task_output: () => new TaskOutputTool() as unknown as LegacyTool,
  task_stop: () => new TaskStopTool() as unknown as LegacyTool,
  task_update: () => new TaskUpdateTool() as unknown as LegacyTool,
  team_create: () => new TeamCreateTool(anyDep(), anyDep()) as unknown as LegacyTool,
  team_message: () => new TeamMessageTool() as unknown as LegacyTool,
  think: () => thinkTool as unknown as LegacyTool,
  todo_write: () => new TodoWriteTool() as unknown as LegacyTool,
  tool_search: () => new ToolSearchTool(anyDep()) as unknown as LegacyTool,
  web_fetch: () => new WebFetchTool() as unknown as LegacyTool,
  web_search: () => new WebSearchTool(anyDep()) as unknown as LegacyTool,
  workflow: () => new WorkflowTool(anyDep(), anyDep()) as unknown as LegacyTool,
  write: () => new WriteTool() as unknown as LegacyTool,
};

/**
 * 豁免名单：**只允许「没有 zodSchema」的工具**（整条校验链都不走，T3 会补）。
 * 不允许用豁免掩盖 passthrough / record / union —— 那正是本门禁要拦的东西（见 T2「停下来」条件）。
 */
const EXEMPT_NO_ZOD_SCHEMA = new Set(["notebook_edit"]);

const meta = builtinToolMeta();
const metaNames = meta.map((t) => t.name);
const factoryNames = Object.keys(FACTORIES);

describe("全工具门禁：真实注册表与构造清单对账", () => {
  test("注册表里的每个工具都有构造工厂（新工具必须进这张表）", () => {
    const missing = metaNames.filter((n) => !(n in FACTORIES));
    expect(missing, `这些工具在 --dump-tool-meta 里但测试没构造：${missing.join(", ")}`).toEqual(
      [],
    );
  });

  test("构造清单里没有注册表之外的工具（名字漂移会同时骗过上面的检查）", () => {
    const extra = factoryNames.filter((n) => !metaNames.includes(n));
    expect(extra, `这些名字不在真实注册表里：${extra.join(", ")}`).toEqual([]);
  });

  test("hasZodSchema 与实例对得上（dump 说有的，实例上真的有）", () => {
    for (const t of meta) {
      const instance = FACTORIES[t.name]();
      const has = !!(instance as { zodSchema?: unknown }).zodSchema;
      expect(has, `${t.name} 的 hasZodSchema 与实例不一致`).toBe(t.hasZodSchema);
    }
  });
});

describe("全工具门禁：未知键在每一个工具上都能被检出", () => {
  const PROBE = "zz_unknown_probe";

  for (const t of meta) {
    if (EXEMPT_NO_ZOD_SCHEMA.has(t.name)) {
      test(`${t.name}：没有 zodSchema，明确豁免（T3 补完后删掉这条豁免）`, () => {
        const instance = FACTORIES[t.name]();
        expect((instance as { zodSchema?: unknown }).zodSchema).toBeUndefined();
      });
      continue;
    }

    test(`${t.name}：未知键 ${PROBE} 能被检出`, () => {
      const instance = FACTORIES[t.name]();
      const schema = (instance as { zodSchema?: unknown }).zodSchema;
      expect(schema, `${t.name} 应该有 zodSchema（dump 说 hasZodSchema=true）`).toBeDefined();
      const unknown = findUnknownTopLevelKeys(schema, { [PROBE]: 1 });
      expect(
        unknown,
        `${t.name} 的 schema 检不出未知键——查它是不是换成了 .passthrough() / z.record / 顶层 union。` +
          `如果是联合类型，必须在 T2 的 Agent Note 里写清理由再豁免，不要直接加进豁免名单。`,
      ).toContain(PROBE);
    });
  }

  test("豁免名单只允许「没有 zodSchema」的工具，不允许用来掩盖 schema 形态问题", () => {
    for (const name of EXEMPT_NO_ZOD_SCHEMA) {
      const t = meta.find((x) => x.name === name);
      expect(t, `豁免名单里的 ${name} 不在真实注册表里`).toBeDefined();
      expect(t?.hasZodSchema, `${name} 有 zodSchema，不该在豁免名单里`).toBe(false);
    }
  });
});
