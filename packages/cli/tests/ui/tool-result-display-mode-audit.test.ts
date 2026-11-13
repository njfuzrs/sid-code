/**
 * 工具结果呈现档位（resultDisplayMode）对账审计 + 行为回归
 *
 * ## 治的是什么缺陷
 *
 * 本仓库的 `LegacyToolResult.output` 同时承担**模型侧 tool_result 正文**与**用户侧展示内容**
 * 两个职责——`history-adapter.ts` 把它原样塞进 `resultDisplay.content` 交给 `⎿` 树枝区渲染。
 * 于是凡「输出专门写给模型读」的工具，提示词就直接泄漏到用户屏幕：
 *
 *     ⏺ todo_write
 *       ⎿ 所有任务已完成，清单已清空。
 *         若执行结果**尚未**告知用户，请汇总后告知；若你在本轮/上一轮**已经完整输出过**
 *         结论（这次只是回头补标记），则**不要重复输出**，一句话收尾即可。
 *
 * 实测轨迹 `20260805-134415-685f911e`（一次 /commit）：5 次 todo_write 共泄漏 1053 字符纯
 * 提示词到 TUI。修复方案见 `src/tool/types.ts` 的 `resultDisplayMode` 注释。
 *
 * ## 为什么需要这份审计
 *
 * 与 `exemptFromLoopDetection` 同一教训：呈现档位若靠 UI 层一份手写工具名名单，就与真实
 * 注册的工具之间没有对账机制，新增工具时必然忘记评估，而**失效方式是静默的**——屏幕上多
 * 几行提示词没人会当成 bug 报上来。故把双向一致性 codify 成可执行测试。
 *
 * 事实源有两个，必须互相印证：
 *   A) 声明事实源：每个工具在自身定义处自报的 `resultDisplayMode` 字段；
 *   B) 期望名单：本文件的 EXPECTED_*，任何增删都会让断言失败并强制 review。
 *
 * 除对账外还锁三条**行为**（光对账挡不住"字段声明了但 UI 没接线"）：
 *   - hidden/summary 档的 `⎿` 正文确实被丢弃；
 *   - **错误结果照常显示**（硬约束 ②，隐藏错误比啰嗦严重得多）；
 *   - **模型侧 content 零改动**（硬约束 ①，否则 todo_write 的前向推进指令会失效）。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveResultDisplayMode } from "@sid-code/core/tool/result-display-mode.ts";
import { buildCompletedToolCall } from "@sid-code/cli/ui/history-adapter.ts";
import { getToolSummary } from "@sid-code/cli/ui/ui-utils.ts";

import { TodoWriteTool } from "@sid-code/core/tool/todo-write.ts";
import { ToolSearchTool } from "@sid-code/core/tool/tool-search.ts";
import { TaskCreateTool } from "@sid-code/core/tool/structured-task-create.ts";
import { TaskUpdateTool } from "@sid-code/core/tool/structured-task-update.ts";
import { EnterPlanModeTool } from "@sid-code/core/tool/enter-plan-mode.ts";
import { ExitPlanModeTool } from "@sid-code/core/tool/exit-plan-mode.ts";
import { MonitorTool } from "@sid-code/core/tool/monitor.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";
import { GrepTool } from "@sid-code/core/tool/grep.ts";
import { GlobTool } from "@sid-code/core/tool/glob.ts";
import { LsTool } from "@sid-code/core/tool/ls.ts";
import { ReadManyTool } from "@sid-code/core/tool/read-many.ts";
import { WebFetchTool } from "@sid-code/core/tool/web-fetch.ts";
import { WebSearchTool } from "@sid-code/core/tool/web-search.ts";
import { LSPTool } from "@sid-code/core/tool/lsp.ts";
import type { SearchBackend } from "@sid-code/core/tool/search-backends/types.ts";
import { bashResultDisplayMode } from "@sid-code/core/tool/bash.ts";
import { toLegacyTool } from "@sid-code/core/tool/bridge.ts";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
/**
 * 工具源码目录（与 loop-detection 审计同口径，另加 skill——Skill 元工具在那里）。
 * 三者都归 core 包（P2-2 分包）。
 */
const TOOL_SRC_DIRS = [
  join(REPO_ROOT, "packages", "core", "src", "tool"),
  join(REPO_ROOT, "packages", "core", "src", "agent"),
  join(REPO_ROOT, "packages", "core", "src", "skill"),
];

/**
 * 期望为 `"hidden"`（整条卡片不渲染）的工具。
 *
 * 判据见 `tool/types.ts`：① 输出对用户零信息量，**且** ②a 效果另有权威呈现
 * 或 ②b 从用户视角没有发生任何事。
 */
const EXPECTED_HIDDEN = [
  "todo_write", // ②a 清单的权威呈现是 TodoPanel
  "tool_search", // ②b 效果在下游那次（可见的）工具调用上显形
].sort();

/**
 * 期望为 `"summary"`（保留卡片、丢弃 ⎿ 正文）的工具。
 *
 * 注意 `task_create` / `task_update` 在 cc 里是 hidden，在本仓库只能是 summary——
 * cc 有 TaskListV2 面板读 appState.tasks，我们的 structured-task-store 在 src/ui/ 与
 * app.ts 里零消费者（见 structured-task-create.ts 的字段注释）。这条差异是本审计
 * 最容易被"照抄对标"改错的地方，故在此显式记录。
 */
const EXPECTED_SUMMARY = [
  "enter_plan_mode", // output 是整份 183 行计划模式引导
  "exit_plan_mode", // output 把整份计划正文又带一遍（权威呈现是 PlanReviewMessage）
  "task_create", // output 是裸 JSON；本仓库无常驻面板呈现结构化清单 → 不能 hidden
  "task_update",
  // monitor：output 是给模型的收尾指令（「不需要查询状态」「结束本轮」），
  // 原样展示会把提示词漏到屏幕上。用户侧信息由 header 摘要
  // （「监控 · PR #662 CI」）+ 后续事件行承担（§5.7.4）。
  "monitor",
].sort();

/**
 * 期望为 `"compact"`（保留正文、默认折成零行、ctrl+o 可展开）的工具。
 *
 * 判据见 `tool/types.ts`：正文是**真实工作内容**（用户按 ctrl+o 时真要读它），
 * 只是一次输出太占行，默认铺满屏幕会把主屏历史的可用行数吃掉。
 * 与 `summary` 的分界是「正文对用户是否有价值」——summary 的正文是给模型读的提示词，
 * compact 的正文是文件内容 / 搜索结果 / 命令输出。
 */
const EXPECTED_COMPACT = [
  "read", // 正文是文件内容，一次常几百行
  "grep", // 正文是搜索结果列表
  "glob", // 正文是文件路径列表
  // 2026-11-13 补：与上面三个同属「一次输出远大于一屏」的检索型工具，此前漏声明 →
  // ls 实测 85 行、web_fetch 上限 100000 字符全部原样铺满主屏。
  "ls", // 正文是目录条目列表（实测 packages/core/src/tool 85 行 / 2185 字符）
  "read_many", // 正文是多个文件的完整内容（总上限 100000 字符）
  "web_fetch", // 正文是网页正文 / 提炼结果（上限 100000 字符）
  "web_search", // 正文是搜索结果列表（每条 4 行，一次 5~10 条）
  "lsp", // 正文是引用 / 符号列表（最多 50 条）
].sort();

/**
 * 期望**不声明** `resultDisplayMode` 的工具清单（显式白名单，双向对账）。
 *
 * ## 为什么需要这份清单
 *
 * 上面三个 `EXPECTED_*` 做的是「已声明的必须对上」，对「新工具压根没声明」是**静默通过**的。
 * 这正是本仓漏掉 `ls` / `read_many` / `web_fetch` / `web_search` / `lsp` 的机制原因——
 * 它们的输出规模早就远超一屏（`ls` 实测 85 行、`web_fetch` 上限 100000 字符），
 * 却因为审计里没有它们的位置，一直没人评估「该不该折」。
 *
 * 把「未声明」也变成需要显式表态的事：新增工具若不声明档位，本条断言会挂。
 * 加进这里**不等于**判定它永远不该折叠——真觉得该折，就去工具自身声明档位，
 * 再从本清单删掉（而不是在这里留个"待办"）。
 *
 * ## 当前不折的判据（逐个记，避免下一个人重新论证）
 *
 * - 短回执 / 交互卡片：`edit` `write` `notebook_edit`（走 diff 专用渲染，有
 *   `DIFF_COLLAPSE_MAX_LINES`）、`ask_user_question`、`save_memory`、`send_message`、
 *   `schedule_wakeup`、`task_stop`、`cron_*`、`team_*`、`enter_worktree` / `exit_worktree`、
 *   `hypothesis_*`（默认关闭的实验工具）。
 * - 已由专用渲染 / header 摘要承担：`task_output`（`extractTaskOutputDisplay`）、
 *   `bg_task_list`（`extractTaskListDisplay`）、`bg_task_get`、`task_get`、`task_list`。
 * - **待评估**（输出确实可能很长，但当前有专属摘要或结果形态尚未核）：`sub_agent`、
 *   `workflow`、`ListMcpResources`、`ReadMcpResource`、`StructuredOutput`。
 */
const EXPECTED_UNDECLARED = [
  "ListMcpResources",
  "ReadMcpResource",
  "StructuredOutput",
  "ask_user_question",
  "bg_task_get",
  "bg_task_list",
  "cron_create",
  "cron_delete",
  "cron_list",
  "edit",
  "enter_worktree",
  "exit_worktree",
  "hypothesis_challenge",
  "hypothesis_register",
  "notebook_edit",
  "save_memory",
  "schedule_wakeup",
  "send_message",
  "sub_agent",
  "task_get",
  "task_list",
  "task_output",
  "task_stop",
  "team_create",
  "team_message",
  "workflow",
  "write",
].sort();

/**
 * 函数形态的工具（档位依赖入参 / 执行结果，静态常量表达不了）。
 *
 * - `Skill`：按 `activate` / `delegate` 的 mode 分档（只看入参）；
 * - `bash`：按 `meta.exitCode` 分档（要看执行结果）——成功才折叠，非零退出必须原样展示。
 *
 * 注意工具名是 `"Skill"`（大写 S，`SKILL_TOOL_NAME`，对齐 cc）而非 `"skill"`——
 * 本审计首次运行时就是拿小写写错了、被「无多余」断言挂出来的。
 */
const FUNCTION_FORM_TOOLS = ["Skill", "bash"];

/** WebSearchTool 的档位是常量字段（与 backend 无关），构造只要求一个实例；给最小桩避免真连后端。 */
const stubSearchBackend: SearchBackend = {
  name: "stub",
  isAvailable: () => true,
  search: async () => ({ results: [], durationMs: 0, backend: "stub" }),
};

function makeInstances() {
  const planManager = new PlanModeManager();
  const toolRegistry = new ToolRegistry();
  return [
    new TodoWriteTool(),
    new ToolSearchTool(toolRegistry),
    new TaskCreateTool(),
    new TaskUpdateTool(),
    new EnterPlanModeTool(planManager),
    new ExitPlanModeTool(planManager),
    // monitor 是新版 Tool 接口（应写新接口）；本审计消费 LegacyTool 形态，
    // 经 bridge 归一——与 registry.register 的真实路径一致。
    toLegacyTool(new MonitorTool()),
    // compact 档（2026-11-13）：读写搜索类工具，正文是真实工作内容、只是太占行。
    // BashTool 刻意不在这里 new——构造期会 spawn 一次登录 shell 抓快照（~2s），
    // 它的档位判据是模块级纯函数 `bashResultDisplayMode`，单独测更省也更准。
    new ReadTool(),
    new GrepTool(),
    new GlobTool(),
    // 2026-11-13 补：与上面三个同属「输出远大于一屏」的检索型工具。
    // 此前漏声明 → ls 实测 85 行、web_fetch 上限 100000 字符全部原样铺满主屏。
    new LsTool(),
    new ReadManyTool(),
    new WebFetchTool(),
    new LSPTool(),
    // WebSearchTool 的档位是常量字段（与 backend 无关），构造只需要一个实例桩。
    // 它是旧版工具形态（`name()` 方法），与 read/grep/glob 一样直接进列表，不经 bridge。
    new WebSearchTool(stubSearchBackend),
  ];
}

/**
 * 静态扫描源码里自报 `resultDisplayMode` 的工具名。
 *
 * 与实例对账互补：防"新工具声明了字段，但本测试忘了 import 进实例列表"的二次漂移。
 * 同时容纳三种写法：
 *   - 类字段常量：`readonly resultDisplayMode = "hidden" as const`
 *   - 属性/字面量常量：`resultDisplayMode: "compact"`（对象字面量与带类型标注的类字段）
 *   - 函数形态：`resultDisplayMode(input): ... {` / `resultDisplayMode = (input, result) => ...`
 *
 * ⚠️ 匹配字符集必须含 `:`。漏掉它的后果不是报错，是**静默漏扫**：写成
 * `resultDisplayMode: "compact"` 的工具不会被收进 `found`，「无遗漏」断言于是认为
 * 没有多余项——正好是本审计最该防的那种失效（文件头与下方回退逻辑各强调过一遍）。
 * 可选标记 `resultDisplayMode?: T` 不会误命中（`?` 挡住了 `:`）。
 */
function scanSourceForDisplayModeTools(): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of TOOL_SRC_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(dir, file), "utf8");
      // 常量形态：resultDisplayMode = "hidden" / resultDisplayMode: "compact"
      const constMatch = src.match(/resultDisplayMode\s*[:=]\s*["'](hidden|summary|compact)["']/);
      // 函数形态：resultDisplayMode(input...) { }  或  resultDisplayMode = (input, result) => ...
      const fnMatch = /resultDisplayMode\s*[:=(]/.test(src);
      if (!constMatch && !fnMatch) continue;
      const mode = constMatch ? constMatch[1] : "function";
      const nameRegex = /name\s*\(\s*\)\s*:?\s*(?:string\s*)?\{\s*return\s*["'`]([^"'`]+)["'`]/g;
      // 新版 Tool 接口：name 是**字符串属性**（`readonly name = "monitor"` / `name: "x"`），
      // 上面的旧式方法正则抓不到。漏掉的后果是「新工具声明了档位、审计却认为没人声明」
      // ——正是本审计要防的静默失效，所以两种形态都扫。
      const propNameRegex = /(?<![A-Za-z0-9_$])name\s*=\s*["'`]([^"'`]+)["'`]/g;
      let m: RegExpExecArray | null;
      let matched = false;
      while ((m = nameRegex.exec(src)) !== null) {
        found.set(m[1], mode);
        matched = true;
      }
      while ((m = propNameRegex.exec(src)) !== null) {
        found.set(m[1], mode);
        matched = true;
      }
      // `name()` 返回**常量引用**而非字面量的工具（如 skill 的 `return SKILL_TOOL_NAME`）
      // 上面的正则抓不到。回退：解析同文件里那个常量的定义。
      //
      // 这个回退不是可选的润色——没有它，扫描会静默漏掉这类工具，
      // 而"漏掉"在本审计里表现为**假绿**（无遗漏断言认为没有多余项），
      // 恰好是审计最该防的那种失效。首次跑就是被 skill 挂出来的。
      if (!matched) {
        const refMatch = src.match(
          /name\s*\(\s*\)\s*:?\s*(?:string\s*)?\{\s*return\s+([A-Z_][A-Z0-9_]*)\s*;?\s*\}/,
        );
        if (refMatch) {
          const constRegex = new RegExp(`${refMatch[1]}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`);
          const valMatch = src.match(constRegex);
          if (valMatch) found.set(valMatch[1], mode);
        }
      }
    }
  }
  return found;
}

/**
 * 扫描源码里**全部**工具名（不筛是否声明档位）。
 *
 * 与 `scanSourceForDisplayModeTools` 的分工：那个回答「谁声明了档位」，这个回答
 * 「一共有哪些工具」——两者相减就是「没声明的工具」，供 `EXPECTED_UNDECLARED` 对账。
 *
 * 只认 `implements Tool` / `implements LegacyTool` 的文件：同目录下还有错误类
 * （`RipgrepTimeoutError`）和 skill loader，它们的 `name` 不是工具名，扫进来只会制造噪音。
 * 模板字符串形式的动态名（`agent__${this.def.name}`）同样跳过——它不是可枚举的静态工具。
 */
function scanAllToolNames(): Set<string> {
  const found = new Set<string>();
  for (const dir of TOOL_SRC_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(dir, file), "utf8");
      if (!/implements\s+(?:Legacy)?Tool\b/.test(src)) continue;
      const nameRegex = /name\s*\(\s*\)\s*:?\s*(?:string\s*)?\{\s*return\s*["'`]([^"'`]+)["'`]/g;
      const propNameRegex = /(?<![A-Za-z0-9_$])name\s*=\s*["'`]([^"'`]+)["'`]/g;
      let m: RegExpExecArray | null;
      let matched = false;
      while ((m = nameRegex.exec(src)) !== null) {
        // 动态拼接的名字不是静态可枚举的工具，跳过（否则白名单里会出现 `${...}`）
        if (!m[1].includes("${")) {
          found.add(m[1]);
          matched = true;
        }
      }
      while ((m = propNameRegex.exec(src)) !== null) {
        if (!m[1].includes("${")) {
          found.add(m[1]);
          matched = true;
        }
      }
      if (!matched) {
        const refMatch = src.match(
          /name\s*\(\s*\)\s*:?\s*(?:string\s*)?\{\s*return\s+([A-Z_][A-Z0-9_]*)\s*;?\s*\}/,
        );
        if (refMatch) {
          const constRegex = new RegExp(`${refMatch[1]}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`);
          const valMatch = src.match(constRegex);
          if (valMatch) found.add(valMatch[1]);
        }
      }
    }
  }
  return found;
}

/** 构造一个完成态 tool_result block（默认成功）。 */
function resultBlock(
  toolUseId: string,
  content: string,
  opts: { isError?: boolean; mode?: "hidden" | "summary" | "compact" } = {},
) {
  return {
    type: "tool_result" as const,
    tool_use_id: toolUseId,
    content,
    ...(opts.isError ? { is_error: true } : {}),
    ...(opts.mode ? { resultDisplayMode: opts.mode } : {}),
  };
}

describe("工具结果呈现档位对账审计", () => {
  test("【实例对账】hidden 档工具集合 === EXPECTED_HIDDEN（双向相等）", () => {
    const actual = makeInstances()
      .filter((t) => (t as any).resultDisplayMode === "hidden")
      .map((t) => t.name())
      .sort();
    expect(actual).toEqual(EXPECTED_HIDDEN);
  });

  test("【实例对账】summary 档工具集合 === EXPECTED_SUMMARY（双向相等）", () => {
    const actual = makeInstances()
      .filter((t) => (t as any).resultDisplayMode === "summary")
      .map((t) => t.name())
      .sort();
    expect(actual).toEqual(EXPECTED_SUMMARY);
  });

  test("【实例对账】compact 档工具集合 === EXPECTED_COMPACT（双向相等）", () => {
    const actual = makeInstances()
      .filter((t) => (t as any).resultDisplayMode === "compact")
      .map((t) => t.name())
      .sort();
    expect(actual).toEqual(EXPECTED_COMPACT);
  });

  test("【源码扫描·无遗漏】自报 resultDisplayMode 的工具都在期望名单里", () => {
    const scanned = scanSourceForDisplayModeTools();
    // 防正则漂移扫空后假绿
    expect(scanned.size).toBeGreaterThanOrEqual(
      EXPECTED_HIDDEN.length + EXPECTED_SUMMARY.length + EXPECTED_COMPACT.length,
    );
    const known = new Set([
      ...EXPECTED_HIDDEN,
      ...EXPECTED_SUMMARY,
      ...EXPECTED_COMPACT,
      ...FUNCTION_FORM_TOOLS,
    ]);
    const unexpected = [...scanned.keys()].filter((n) => !known.has(n));
    expect(
      unexpected,
      `以下工具源码自报了 resultDisplayMode，但没进本测试的期望名单——` +
        `请先确认该档位判据成立（见 tool/types.ts），再把它加进 EXPECTED_*：${unexpected.join(", ")}`,
    ).toEqual([]);
  });

  test("【源码扫描·无多余】期望名单里的每个名字都有工具真的自报该字段", () => {
    const scanned = scanSourceForDisplayModeTools();
    const orphan = [
      ...EXPECTED_HIDDEN,
      ...EXPECTED_SUMMARY,
      ...EXPECTED_COMPACT,
      ...FUNCTION_FORM_TOOLS,
    ].filter((n) => !scanned.has(n));
    expect(
      orphan,
      `以下名字在期望名单里、但没有任何工具源码自报 resultDisplayMode（拼错/工具已删？）：${orphan.join(", ")}`,
    ).toEqual([]);
  });

  test("【源码扫描·未声明清单】未声明档位的工具集合 === EXPECTED_UNDECLARED（双向相等）", () => {
    const allNames = scanAllToolNames();
    // 防正则/目录漂移扫空后假绿：真实工具数远大于 40，扫空或扫残都会在这里挂
    expect(allNames.size).toBeGreaterThanOrEqual(40);

    const declared = new Set([...scanSourceForDisplayModeTools().keys(), ...FUNCTION_FORM_TOOLS]);
    const actual = [...allNames].filter((n) => !declared.has(n)).sort();
    expect(
      actual,
      `工具清单变了：新增工具若不声明 resultDisplayMode，请先评估「它的输出该不该折叠」——` +
        `该折就在工具自身声明 compact（并加进 EXPECTED_COMPACT），不该折再加进 EXPECTED_UNDECLARED。` +
        `\n未在 EXPECTED_UNDECLARED 里的新工具：${actual.filter((n) => !EXPECTED_UNDECLARED.includes(n)).join(", ")}` +
        `\n已从清单消失的工具：${EXPECTED_UNDECLARED.filter((n) => !actual.includes(n)).join(", ")}`,
    ).toEqual(EXPECTED_UNDECLARED);
  });

  test("summary 档工具都有 header 摘要（否则卡片只剩光秃秃一个工具名）", () => {
    // 这是本文件同一病灶第四次发作的防线：ui-utils.ts 的 getToolSummary 曾三次
    // 因为漏登记分支而让 header 恒为 `⏺ <工具名>`（sub_agent / think / lsp）。
    // summary 档丢弃了 ⎿ 正文，header 是唯一的信息出口，必须非空。
    const samples: Record<string, unknown> = {
      enter_plan_mode: {},
      exit_plan_mode: { summary: "先加字段再接线" },
      task_create: { subject: "补齐 header 摘要" },
      task_update: { task_id: "1", status: "completed" },
      monitor: { description: "PR #662 CI", command: "gh pr checks 662", timeout_ms: 600_000 },
    };
    for (const name of EXPECTED_SUMMARY) {
      const summary = getToolSummary(name, samples[name] ?? {});
      expect(summary.trim(), `工具 ${name} 缺少 header 摘要`).not.toBe("");
    }
  });
});

describe("函数形态：skill 按 mode 分档", () => {
  // 直接喂桩对象，不构造整个 SkillMetaTool（它需要 manager/registry/hookSystem 等一串依赖，
  // 而这里要验的只是 resolveResultDisplayMode 对函数形态的解析语义）。
  const activateSkillTool = {
    resultDisplayMode: (input: unknown) =>
      (input as any)?.skill === "act" ? ("summary" as const) : undefined,
  };

  test("activate 模式 → summary（提示词不泄漏）", () => {
    expect(resolveResultDisplayMode(activateSkillTool, { skill: "act" })).toBe("summary");
  });

  test("delegate 模式 → undefined（子代理的真实交付内容必须原样展示）", () => {
    expect(resolveResultDisplayMode(activateSkillTool, { skill: "del" })).toBeUndefined();
  });

  test("函数抛异常 → undefined（判定失败不该让结果消失）", () => {
    const throwing = {
      resultDisplayMode: () => {
        throw new Error("boom");
      },
    };
    expect(resolveResultDisplayMode(throwing, {})).toBeUndefined();
  });

  test("工具缺失 / 未声明 → undefined", () => {
    expect(resolveResultDisplayMode(undefined, {})).toBeUndefined();
    expect(resolveResultDisplayMode({}, {})).toBeUndefined();
  });
});

describe("函数形态：bash 按退出码分档", () => {
  test("exitCode === 0 → compact（成功命令的正文是工作内容，折起来不丢信息）", () => {
    expect(bashResultDisplayMode({}, { output: "file1.ts\nfile2.ts", meta: { exitCode: 0 } })).toBe(
      "compact",
    );
  });

  test("非零退出 → undefined（失败输出是排查第一现场，必须原样可见）", () => {
    // `grep` 退出码 1（无匹配）/ `gh pr checks` 退出码 8（有 pending）都是非零但不算错误，
    // 正文仍是用户要看的内容——原样展示是唯一不丢信息的选项。
    for (const exitCode of [1, 2, 8, 127, 130]) {
      expect(
        bashResultDisplayMode({}, { output: "some output", meta: { exitCode } }),
        `exitCode=${exitCode} 不该折叠`,
      ).toBeUndefined();
    }
  });

  test("无 meta / 无 exitCode（早退路径、转后台）→ undefined", () => {
    // 早退路径（缺参数、cwd 不存在、转后台）没有退出码，判定依据不全就不做展示优化。
    expect(bashResultDisplayMode({}, { output: "x" })).toBeUndefined();
    expect(bashResultDisplayMode({}, { output: "x", meta: {} })).toBeUndefined();
    expect(bashResultDisplayMode({}, undefined)).toBeUndefined();
  });

  test("透传语义：resolveResultDisplayMode 会把 result 交给函数形态", () => {
    // 锁"第二个参数真的穿下去了"这件事：函数形态只看 input 时永远拿不到 exitCode，
    // 接线若漏了（三个调用点只传两个参数），bash 会静默退化成"永不折叠"。
    const tool = { resultDisplayMode: bashResultDisplayMode };
    expect(resolveResultDisplayMode(tool, {}, { meta: { exitCode: 0 } })).toBe("compact");
    expect(resolveResultDisplayMode(tool, {}, { meta: { exitCode: 1 } })).toBeUndefined();
  });
});

describe("行为回归：compact 档保留正文 / 少量行降级", () => {
  // 6 行：超过 COMPACT_MAX_INLINE_LINES(5)，是「真该折叠」的最小样本。
  const BODY = [
    "src/a.ts:1:1",
    "src/b.ts:2:2",
    "src/c.ts:3:3",
    "src/d.ts:4:4",
    "src/e.ts:5:5",
    "src/f.ts:6:6",
  ].join("\n");

  test("硬约束①：compact 档正文**不置空**（与 summary 的分界就在这一条）", () => {
    // 这是全套改动里最容易写错、且错了之后无法补救的一条：一旦 compact 也走 suppressBody，
    // 正文在数据层就丢了，渲染层再想支持 ctrl+o 展开也无从恢复。
    const card = buildCompletedToolCall(resultBlock("c1", BODY, { mode: "compact" }), "grep");
    expect(card.resultDisplay?.content).toBe(BODY);
    expect(card.resultDisplay?.displayMode).toBe("compact");
  });

  test("compact 档保留结果规模摘要（折叠态标题行唯一的结果信息）", () => {
    const card = buildCompletedToolCall(resultBlock("c2", BODY, { mode: "compact" }), "grep");
    // 折叠后正文不上屏，标题行的「N 行 / N 个结果」是读者唯一能判断规模的信息，必须非空。
    expect((card.resultSummary ?? "").trim()).not.toBe("");
  });

  test("空正文降级：正文为空时去掉 compact 档（折叠零行与不折叠等价，留着只是噪音）", () => {
    const card = buildCompletedToolCall(resultBlock("c3", "   \n\n", { mode: "compact" }), "read");
    expect(card.resultDisplay?.displayMode).toBeUndefined();
  });

  test("单行降级：一句话结论不被折成「1 行输出」", () => {
    // grep / glob 无匹配时就是一句 "未找到匹配的内容"：折叠后标题行「1 行输出」比正文还长，
    // 还逼用户按 ctrl+o 才看得到那句结论——折叠是负收益，故降级为原样展示。
    for (const body of ["未找到匹配的内容", "未找到匹配的文件\n", "  单行  \n"]) {
      const card = buildCompletedToolCall(resultBlock("c4", body, { mode: "compact" }), "grep");
      expect(card.resultDisplay?.displayMode, `正文 "${body.trim()}" 不该折叠`).toBeUndefined();
      expect(card.resultDisplay?.content).toBe(body);
    }
  });

  test("≤5 行降级：一眼看完的少量结果不该被折起来", () => {
    // `glob` 匹配 3 个文件、`grep` 命中 2 条、`git log --oneline` 5 条——这类结果一眼看完、
    // 几乎不占地方，折成「5 行输出」反而把用户要的文件名/命中行藏起来，还得按 ctrl+o。
    // ctrl+o 是全局档位，一按会把整屏所有 compact 卡片一起展开，代价比省下的几行大得多。
    for (const lineCount of [2, 3, 5]) {
      const body = Array.from({ length: lineCount }, (_, i) => `第 ${i + 1} 行结果`).join("\n");
      const card = buildCompletedToolCall(resultBlock("c5", body, { mode: "compact" }), "grep");
      expect(card.resultDisplay?.displayMode, `${lineCount} 行不该折叠`).toBeUndefined();
      expect(card.resultDisplay?.content).toBe(body);
    }
  });

  test("6 行才折叠（越过「一眼看完」的分界）", () => {
    const sixLines = Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 行结果`).join("\n");
    const card = buildCompletedToolCall(resultBlock("c7", sixLines, { mode: "compact" }), "grep");
    expect(card.resultDisplay?.displayMode).toBe("compact");
    expect(card.resultDisplay?.content).toBe(sixLines);
  });

  test("单行超长正文照样折叠：逻辑行 1 ≠ 视觉行 1（真实 grep JSON 形态）", () => {
    // 这次漏掉的**直接原因**：grep 的 output 是 `JSON.stringify` 出来的**一行紧凑 JSON**
    // （`core/tool/grep.ts` 的 `formatStructuredOutput`）。实测命中 23 个文件时 3081 字符 /
    // 逻辑行 1 —— 按逻辑行判 `<= 5` 恒成立，于是 grep **永不折叠**，而它在终端里会 wrap 成几十行。
    // 判据改用视觉行数（countVisualLines）后必须折叠。
    const realGrepShape = JSON.stringify({
      mode: "files_with_matches",
      numFiles: 23,
      filenames: Array.from({ length: 23 }, (_, i) => `packages/core/src/tool/tool-${i}.ts`),
    });
    const card = buildCompletedToolCall(
      resultBlock("c-json", realGrepShape, { mode: "compact" }),
      "grep",
    );
    expect(card.resultDisplay?.displayMode).toBe("compact");
    // 正文不丢：折叠只是渲染层默认收起，ctrl+o 仍能拿回原文（硬约束①）
    expect(card.resultDisplay?.content).toBe(realGrepShape);
    // 折叠态标题行是唯一信息出口，不能是按逻辑行算出的假指标「1 个结果」
    expect(card.resultSummary).toBe("23 个文件");
  });

  test("单行短结论仍降级：视觉行口径没有矫枉过正", () => {
    const shortSingleLine = '{"mode":"files_with_matches","numFiles":0}';
    const card = buildCompletedToolCall(
      resultBlock("c-short", shortSingleLine, { mode: "compact" }),
      "grep",
    );
    expect(card.resultDisplay?.displayMode).toBeUndefined();
  });

  test("read 单行大文件：视觉行口径同样生效（minified 文件不再是漏网）", () => {
    const oneLineFile = `{"k":"${"x".repeat(2000)}"}`;
    const card = buildCompletedToolCall(
      resultBlock("c-oneline", oneLineFile, { mode: "compact" }),
      "read",
    );
    expect(card.resultDisplay?.displayMode).toBe("compact");
  });

  test("bash 单行超长输出：超出 1 个视觉行就折叠", () => {
    const longSingleLine = "x".repeat(300);
    const card = buildCompletedToolCall(
      resultBlock("c-bash-long", longSingleLine, { mode: "compact" }),
      "bash",
    );
    expect(card.resultDisplay?.displayMode).toBe("compact");
  });

  test("shell 类工具用更严的阈值：2 行起就折叠", () => {
    // PR #808 合入后实测到的不统一：正文 4 / 3 行的 bash 因 ≤5 行降级而不折叠，占 5~6 行；
    // 正文 86 行的 bash 折成 1 行。输出少的反而比输出多的更占屏 —— 因为 bash 不折叠还要
    // 多出命令行区（`$ 命令` + 截断提示）。故 shell 类只在正文 ≤1 行时降级。
    for (const lineCount of [2, 3, 4, 5]) {
      const body = Array.from({ length: lineCount }, (_, i) => `第 ${i + 1} 行结果`).join("\n");
      const card = buildCompletedToolCall(resultBlock("c8", body, { mode: "compact" }), "bash");
      expect(card.resultDisplay?.displayMode, `${lineCount} 行的 bash 该折叠`).toBe("compact");
      expect(card.resultDisplay?.content).toBe(body);
    }
  });

  test("shell 类工具：一句话结论仍不折叠（1 行）", () => {
    // `git status` 干净、`grep` 无匹配就是一行结论：折成「1 行输出」比正文还长，
    // 且逼用户按 ctrl+o 才看得到那句话。shell 的阈值是 1 而不是 0，就是为这类结果留的。
    for (const body of [
      "未找到匹配的内容",
      "nothing to commit, working tree clean\n",
      "  单行  \n",
    ]) {
      const card = buildCompletedToolCall(resultBlock("c9", body, { mode: "compact" }), "bash");
      expect(card.resultDisplay?.displayMode, `正文 "${body.trim()}" 不该折叠`).toBeUndefined();
      expect(card.resultDisplay?.content).toBe(body);
    }
  });

  test("非 shell 工具不受 shell 阈值影响（grep 5 行仍降级）", () => {
    // 反向锁：阈值分流按工具类型判，不能把 5 行宽松档一并收紧——read/grep/glob 的卡片
    // 没有命令行区，5 行不折叠只多占正文，与 bash 的成本结构完全不同。
    const fiveLines = Array.from({ length: 5 }, (_, i) => `src/x${i}.ts`).join("\n");
    const card = buildCompletedToolCall(resultBlock("c10", fiveLines, { mode: "compact" }), "grep");
    expect(card.resultDisplay?.displayMode).toBeUndefined();
    const bashCard = buildCompletedToolCall(
      resultBlock("c11", fiveLines, { mode: "compact" }),
      "bash",
    );
    expect(bashCard.resultDisplay?.displayMode).toBe("compact");
  });

  test("行数口径：尾部换行不该多算一行（否则 5 行被判成 6 行而误折）", () => {
    // countEffectiveLines 是 `⎿` 文案与降级判据的共同口径。若降级判据退回朴素 split，
    // 一条 5 行且带尾部换行的 grep 结果会被算成 6 行、越过阈值被折叠。
    const fiveWithTrailingNewline =
      Array.from({ length: 5 }, (_, i) => `src/x${i}.ts`).join("\n") + "\n";
    const card = buildCompletedToolCall(
      resultBlock("c12", fiveWithTrailingNewline, { mode: "compact" }),
      "grep",
    );
    expect(card.resultDisplay?.displayMode).toBeUndefined();
  });

  test("硬约束②：错误结果即使带 compact 也照常展示、不折叠", () => {
    const card = buildCompletedToolCall(
      resultBlock("c6", "fatal: not a git repository\nline2", { isError: true, mode: "compact" }),
      "bash",
    );
    expect(card.resultDisplay?.displayMode).toBeUndefined();
    expect(card.resultDisplay?.content).toBe("fatal: not a git repository\nline2");
  });
});

describe("行为回归：正文丢弃 / 错误可见 / 模型侧不变", () => {
  // 取自真实轨迹 20260805-134415-685f911e 的泄漏样本（todo_write 的第 5 次调用）
  const LEAKED_PROMPT =
    "所有任务已完成，清单已清空。\n" +
    "若执行结果**尚未**告知用户，请汇总后告知；若你在本轮/上一轮**已经完整输出过**结论" +
    "（这次只是回头补标记），则**不要重复输出**，一句话收尾即可。";

  test("hidden 档：⎿ 正文被丢弃，且卡片带 displayMode 供渲染层整条过滤", () => {
    const card = buildCompletedToolCall(
      resultBlock("t1", LEAKED_PROMPT, { mode: "hidden" }),
      "todo_write",
    );
    expect(card.resultDisplay?.content).toBe("");
    expect(card.resultDisplay?.displayMode).toBe("hidden");
  });

  test("summary 档：⎿ 正文被丢弃", () => {
    const card = buildCompletedToolCall(
      resultBlock("t2", "## 计划模式已激活\n（此处省略 183 行引导）", { mode: "summary" }),
      "enter_plan_mode",
    );
    expect(card.resultDisplay?.content).toBe("");
    expect(card.resultDisplay?.displayMode).toBe("summary");
  });

  test("假指标防线：正文丢弃后不再给出 `N 字符` 结果摘要", () => {
    // 修复前 todo_write 会报"258 字符"——量的是提示词本身的长度，与任务进度无关。
    const card = buildCompletedToolCall(
      resultBlock("t3", LEAKED_PROMPT, { mode: "hidden" }),
      "todo_write",
    );
    expect(card.resultSummary).toBe("");
    expect(card.resultSummary).not.toContain("字符");
  });

  test("硬约束②：错误结果照常显示（即使 block 上误带了 displayMode）", () => {
    // 执行器不会给错误 block 打标记；这里手工构造一个"误带标记的错误块"，
    // 断言 buildCompletedToolCall 的第二道防线把它守住——错误绝不能被静默隐藏。
    const card = buildCompletedToolCall(
      resultBlock("t4", "todos 必须是非空数组", { isError: true, mode: "hidden" }),
      "todo_write",
    );
    expect(card.resultDisplay?.content).toBe("todos 必须是非空数组");
    expect(card.resultDisplay?.isError).toBe(true);
    expect(card.resultDisplay?.displayMode).toBeUndefined();
  });

  test("summary 档正文置空后是纯空串（渲染层据此退化为「只有 header」）", () => {
    // 这条锁的是 ToolMessage 的 `hasResultBody` 契约：正文必须 trim 后为空，
    // 否则那边会判成"有结果"、画出一条 `⎿ ` 后面什么都没有的空树枝，
    // 同时把 header 的 resultSummary 吃掉 —— 正文与摘要同时消失，卡片彻底失语。
    // （code review 时实测发现的真实缺陷，修复见 ToolMessage.tsx 的 hasResultBody。）
    for (const mode of ["hidden", "summary"] as const) {
      const card = buildCompletedToolCall(
        resultBlock(`t-${mode}`, "给模型读的提示词\n\n还有第二段", { mode }),
        "enter_plan_mode",
      );
      expect(card.resultDisplay?.content.trim(), `${mode} 档正文未被清空`).toBe("");
    }
  });

  test("未声明档位的工具不受影响（绝大多数工具的默认行为）", () => {
    const card = buildCompletedToolCall(resultBlock("t5", "hello world"), "bash");
    expect(card.resultDisplay?.content).toBe("hello world");
    expect(card.resultDisplay?.displayMode).toBeUndefined();
  });

  test("硬约束①：模型侧 content 零改动（提示词仍完整回传给 LLM）", () => {
    // 这是全套改动里最不能破的一条：todo_write 的前向推进指令是实时化的主力通道
    // （必达、零边际成本），若哪天有人图省事在执行器里"hidden 就不回传"，它当场失效。
    // 断言 block 本身（= 进 ctxMgr / provider 序列化的那份）未被任何展示逻辑改写。
    const block = resultBlock("t6", LEAKED_PROMPT, { mode: "hidden" });
    buildCompletedToolCall(block, "todo_write");
    expect(block.content).toBe(LEAKED_PROMPT);
  });
});
