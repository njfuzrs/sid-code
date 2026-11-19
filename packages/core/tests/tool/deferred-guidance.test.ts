/**
 * D6 / FIX-5：延迟工具的 guidance 覆盖率门禁 + <deferred-tools-guidance> 段行为。
 *
 * 背景（方案 20261109 §D6）：延迟加载的契约原先只覆盖「名字可见」，不覆盖「知道何时用」
 * ——有引导的 schedule_wakeup 自然调用 18 次、无引导的 monitor 0 次。本门禁保证每个
 * 内置 shouldDefer 工具都声明 guidance（何时该用，一句话），新增延迟工具漏写时 CI 红。
 *
 * 口径（与方案一致）：
 * - 只覆盖**内置** shouldDefer 工具（源码对账见 scanShouldDeferFiles）；
 * - MCP 工具（mcp__ 前缀）按前缀规则延迟、由 server 动态注册，没有 guidance 落点，
 *   **不进门禁**；
 * - 遍历走公开入口 getEnabledDeferredTools()（isCurrentlyEnabled / isToolDeferred 都是
 *   private，复制判定逻辑必然漂移）。
 *
 * 落盘隔离：monitor 的 isEnabled 读 settings，按约定把 SID_CONFIG_DIR 指向 tmpdir（存/恢复原值）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Registry } from "../../src/tool/registry.ts";
import { buildSystemPrompt, clearPromptCache } from "../../src/config/system-prompt.ts";
import { resetSettingsCache } from "../../src/config/settings/cache.ts";
import { managedSettingsSystemDir } from "../../src/config/paths.ts";
import { MonitorTool } from "../../src/tool/monitor.ts";
import { TaskListTool } from "../../src/tool/task-list.ts";
import { TaskOutputTool } from "../../src/tool/task-output.ts";
import { TaskStopTool } from "../../src/tool/task-stop.ts";
import { TaskCreateTool } from "../../src/tool/structured-task-create.ts";
import { StructuredTaskGetTool } from "../../src/tool/structured-task-get.ts";
import { StructuredTaskListTool } from "../../src/tool/structured-task-list.ts";
import { TaskUpdateTool } from "../../src/tool/structured-task-update.ts";
import { ScheduleWakeupTool } from "../../src/tool/schedule-wakeup.ts";
import { CronCreateTool } from "../../src/tool/cron-create.ts";
import { CronDeleteTool } from "../../src/tool/cron-delete.ts";
import { CronListTool } from "../../src/tool/cron-list.ts";
import { SendMessageTool } from "../../src/tool/send-message.ts";
import { TeamCreateTool } from "../../src/tool/team-create.ts";
import { TeamMessageTool } from "../../src/tool/team-message.ts";
import { NotebookEditTool } from "../../src/tool/notebook-edit.ts";
import { WorkflowTool } from "../../src/tool/workflow.ts";
import { ToolSearchTool } from "../../src/tool/tool-search.ts";
// 旧名（别名）清单：D-04 门禁要放行它，L-5 用例锁住 registry.get 确实能解析它。
// 用 RETIRED_INTERNAL_TOOL_NAMES 的键而不是抄一份字面量：别名表加了新条目时这里自动跟上。
import { RETIRED_INTERNAL_TOOL_NAMES } from "../../src/tool/tool-name-aliases.ts";

// 系统级 managed-settings.json 会盖掉 SID_CONFIG_DIR 下那份；存在时跳过而不是假绿
// （与 waiting-capability-policy.test.ts 同一处理）。
const systemPolicyExists = existsSync(join(managedSettingsSystemDir(), "managed-settings.json"));

const TOOL_DIR = join(import.meta.dir, "../../src/tool");

/**
 * 声明 shouldDefer=true 的工具文件清单（期望集）。
 *
 * 双向对账：scanShouldDeferFiles() 扫源码得出的实际集 == 本清单。
 * 新增 shouldDefer 工具文件时对账先红，把它加进来时必须同时构造它并写 guidance
 * ——这就是「新增延迟工具必须同时注册意图映射」的机制化（方案 §D6 根因的修法）。
 */
const EXPECTED_DEFERRED_FILES = [
  "cron-create.ts",
  "cron-delete.ts",
  "cron-list.ts",
  "monitor.ts",
  "notebook-edit.ts",
  "schedule-wakeup.ts",
  "send-message.ts",
  "structured-task-create.ts",
  "structured-task-get.ts",
  "structured-task-list.ts",
  "structured-task-update.ts",
  "task-list.ts",
  "task-output.ts",
  "task-stop.ts",
  "team-create.ts",
  "team-message.ts",
  "workflow.ts",
] as const;

/** 扫描 tool/ 下真实声明 shouldDefer=true 的文件（排除注释行与基础设施文件） */
function scanShouldDeferFiles(): string[] {
  const out: string[] = [];
  // 基础设施文件：types.ts 声明接口、bridge.ts 转发字段、registry.ts 消费字段——都不是工具声明
  const infra = new Set(["types.ts", "bridge.ts", "registry.ts", "tool-search.ts"]);
  for (const f of readdirSync(TOOL_DIR)) {
    if (!f.endsWith(".ts") || infra.has(f)) continue;
    const text = readFileSync(join(TOOL_DIR, f), "utf8");
    const hit = text.split("\n").some(
      (line) =>
        // 真实声明行（notebook-edit.ts 没有 readonly 前缀，pattern 要覆盖两种写法）
        /^\s*(?:readonly\s+)?shouldDefer\s*=\s*true/.test(line) &&
        // 排除注释（enter-plan-mode.ts / workflow.ts 的注释里有 shouldDefer=true 字样）
        !/^\s*(?:\*|\/\/)/.test(line),
    );
    if (hit) out.push(f);
  }
  return out.sort();
}

/** 注册全部 17 个内置 shouldDefer 工具（真实实例，不是手搓形状） */
function registerAllBuiltinDeferred(registry: Registry): void {
  registry.register(new TaskListTool());
  registry.register(new TaskOutputTool());
  registry.register(new TaskStopTool());
  registry.register(new TaskCreateTool());
  registry.register(new StructuredTaskGetTool());
  registry.register(new StructuredTaskListTool());
  registry.register(new TaskUpdateTool());
  registry.register(new ScheduleWakeupTool());
  registry.register(new CronCreateTool());
  registry.register(new CronDeleteTool());
  registry.register(new CronListTool());
  registry.register(new SendMessageTool());
  registry.register(new TeamCreateTool({} as never, {} as never));
  registry.register(new TeamMessageTool());
  registry.register(new NotebookEditTool());
  registry.register(new WorkflowTool({} as never, {} as never));
  registry.register(new MonitorTool());
}

/**
 * D-04：guidance 里提到的工具名必须真实存在（跨工具对账）。
 *
 * 为什么需要：只验证「guidance 非空」时，`bg_task_get`（已并入 task_output）和
 * `teamMessage`（内部变量名）这种过期名字能无限次复发且 CI 恒绿。危害不是笔误——
 * 模型「知道名字却从没见过 schema」时，生成阶段会坍缩成前缀相近的真实工具
 * （deferred-tool-view.ts 文件头记的事故：enter_worktree → enter_plan_mode）。
 *
 * 判定口径（两条并行，覆盖两种形态）：
 *   1. snake_case 标识符：正则抽出来，必须在「可解析名集合」里；
 *   2. 驼峰变体：工具名去掉下划线后全小写归一，guidance 里任何词归一后撞上某个工具名
 *      （但字面不是那个工具名）就报错。`teamMessage` 这种驼峰正则抓不到，只能靠这条。
 *
 * 可解析名集合 = 内置延迟工具名 ∪ aliases 键 ∪ REGISTRY_EXTERNAL_VALID_NAMES。
 * **别名必须放行**：bg_task_get 是合法的历史兼容（registry.get 会回退解析），
 * 拦掉它等于逼人下次直接把门禁删了。别名回退本身由下文 L-5 用例锁住——
 * 否则哪天回退被重构掉，这里的放行就变成了错放。
 */
describe.skipIf(systemPolicyExists)("D-04 — guidance 提到的工具名必须真实存在", () => {
  /**
   * 注册表外的合法工具名白名单。
   *
   * 这些工具在真实 CLI 启动时由 cli.ts 注册（guidance 里提到它们是合理的），
   * 但 registerAllBuiltinDeferred 只构造 17 个延迟工具，注册表里查不到。
   * 只收「导航型」工具——guidance 里出现它是为了指路；不收任何参数名 / 状态词，
   * 参数名走后面的非工具词白名单。
   */
  const REGISTRY_EXTERNAL_VALID_NAMES: ReadonlyArray<string> = [
    "sub_agent",
    "todo_write",
    "tool_search",
  ];

  /**
   * 非工具词白名单（形如 snake_case 但不是工具名）。
   *
   * 每条都要写清「为什么不是工具」——否则下一个人会看不懂为什么它能豁免，
   * 然后往里塞真正该报错的名字。命中项加进这个名单之前，先确认它不会长成一个工具。
   */
  const NON_TOOL_WORDS: ReadonlySet<string> = new Set([
    "in_progress", // 任务状态值（todo 的三态之一），不是工具
    "to_json", // 泛指「转成 JSON」的动作描述，不是工具
    "task_id", // task_get / task_output 的入参名，不是工具
    "skill", // 驼峰检查的归一目标：Skill 工具的 skill 参数名，不是工具名
  ]);

  /** guidance 文本 → snake_case 标识符（取捕获组，不靠 lookbehind，兼容性更稳） */
  function extractSnakeIdents(text: string): string[] {
    const re = /(^|[^A-Za-z0-9_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;
    return [...text.matchAll(re)].map((m) => m[0].slice(m[1].length));
  }

  /** guidance 文本 → 归一后撞上工具名的驼峰/大小写变体（返回 "写法 → 真实名"） */
  function findCamelVariants(
    text: string,
    normalizedToolNames: ReadonlyMap<string, string>,
  ): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9]*/g)) {
      const word = m[0];
      const real = normalizedToolNames.get(word.replace(/_/g, "").toLowerCase());
      if (real && real !== word) out.push(`${word}（应为 ${real}）`);
    }
    return out;
  }

  test("guidance 里不存在「不存在的工具名」或「工具名的驼峰变体」", () => {
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);

    const existing = new Set<string>(registry.all().map((t) => t.name()));
    const resolvable = new Set<string>([
      ...existing,
      ...Object.keys(RETIRED_INTERNAL_TOOL_NAMES),
      ...REGISTRY_EXTERNAL_VALID_NAMES,
    ]);
    // 归一表只从「真实存在的工具名」建：别名不该建表，否则会把旧名当成正确写法
    const normalized = new Map<string, string>();
    for (const n of existing) normalized.set(n.replace(/_/g, "").toLowerCase(), n);

    const problems: string[] = [];
    for (const t of registry.all()) {
      const g = t.guidance;
      if (typeof g !== "string" || g.trim() === "") continue;
      for (const ident of extractSnakeIdents(g)) {
        if (NON_TOOL_WORDS.has(ident)) continue;
        if (!resolvable.has(ident)) {
          problems.push(`${t.name()} 的 guidance 提到了不存在的工具名 "${ident}"`);
        }
      }
      for (const variant of findCamelVariants(g, normalized)) {
        problems.push(`${t.name()} 的 guidance 用了工具名的驼峰变体 "${variant}"`);
      }
    }

    expect(
      problems,
      "guidance 里的工具名必须是现行名：旧名要么走 aliases 登记（合法兼容），要么改掉。\n" +
        "驼峰写法（如 teamMessage）没有别名兜底，tool_search 精确匹配必然落空。",
    ).toEqual([]);
  });

  test("门禁自身有效：驼峰检测能抓到 teamMessage，snake 检测能抓到不存在的名字", () => {
    // 防「恒绿门禁」：断言上面那两个提取器真的会命中错误形态，
    // 否则哪天正则写歪了，主用例照样全绿但什么都没查。
    expect(extractSnakeIdents("后台任务用 task_output，不是这个")).toEqual(["task_output"]);
    expect(extractSnakeIdents("teamMessage 是发给团队成员的")).toEqual([]);
    // 键必须已归一（去下划线全小写）——建表口径见主用例，写成 ["team_message", ...] 会让它恒绿
    const normalized = new Map([["teammessage", "team_message"]]);
    expect(findCamelVariants("teamMessage 是发给团队成员的", normalized)).toEqual([
      "teamMessage（应为 team_message）",
    ]);
    expect(findCamelVariants("用 team_message 发", normalized)).toEqual([]);
  });
});

/*
 * L-5：锁住「别名回退」这条行为，否则 D-04 对 bg_task_get 的放行就是错放。
 *
 * 口径：selectTools（tool-search.ts:169）走 registry.get()，registry.get()（registry.ts:339）
 * 精确未命中时回退查 aliases（bg_task_get → task_output）。这条链断掉时不会有任何东西报错——
 * 只有模型按 guidance 教的旧名调 tool_search(select:bg_task_get) 时静默落空，
 * 而 D-04 门禁仍认为 bg_task_get「可解析」，放它过去。所以必须单独锁住。
 */
describe.skipIf(systemPolicyExists)("L-5 — 旧工具名经别名回退仍可解析（select: 路径）", () => {
  function buildRegistry(): Registry {
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);
    return registry;
  }

  test("registry.get('bg_task_get') 解析到 task_output 实例（精确未命中 → 查 aliases）", () => {
    const registry = buildRegistry();
    const output = registry.get("task_output");
    expect(output).toBeDefined();
    expect(registry.get("bg_task_get")).toBe(output);
  });

  test("别名表里每个旧名都能被 get() 解析到已 registered 的现行名", () => {
    const registry = buildRegistry();
    for (const [oldName, currentName] of Object.entries(RETIRED_INTERNAL_TOOL_NAMES)) {
      const current = registry.get(currentName);
      if (!current) continue; // 该现行工具不在本用例的 17 个延迟工具集里，跳过
      expect(registry.get(oldName), `别名 ${oldName} → ${currentName} 回退失效`).toBe(current);
    }
  });

  // 曾经的缺陷：selectTools 的 enabled 判据用**用户原始名**比 enabledNames（收的是 name()），
  // 于是 select:bg_task_get 能解析到实例、却落进 disabled 分支，模型看到「已被策略禁用」。
  // 已在 tool-search.ts 归一为解析后的 name()；本用例从 test.skip 转为真通过，锁住这条链
  // （别名在 select 路径上必须真的可用，而不只是 registry.get 能查到）。
  test("tool_search(select:bg_task_get) 能激活真实工具（L-5 端到端）", async () => {
    const registry = buildRegistry();
    const search = new ToolSearchTool(registry);
    const result = await search.execute({ query: "select:bg_task_get" });
    expect(result.isError).toBe(false);
    expect(result.output).not.toContain("未找到");
    // 曾被 enabled 判据用「用户原始名」比对而误判成「已被策略禁用」，
    // 模型于是拿不到一个其实好好活着的工具。判据已改用解析后的现行名。
    expect(result.output).not.toContain("已被策略禁用");
    expect(result.output).toContain("bg_task_get");
    // 激活集合存现行名，所以旧名与新名查出来都是「已激活」——它们是同一个实例
    expect(registry.isActivated("bg_task_get")).toBe(true);
    expect(registry.isActivated("task_output")).toBe(true);
    // 真正该延迟的工具没被顺带激活（别名回退不能变成通配）
    expect(registry.isActivated("monitor")).toBe(false);
  });

  test("registry.activateTool('bg_task_get') 认别名，且激活态按现行名记录", () => {
    const registry = buildRegistry();
    // activateTool 经 get() 解析，旧名能拿到 task_output 实例并判为延迟 → 返回 true。
    // 激活集合按**现行名**记录，所以随后 isToolDeferred(task_output) 必须转 false
    // ——存旧名会让「激活了却仍然不可见」，那正是 L-5 端到端失效的根因。
    expect(registry.activateTool("bg_task_get")).toBe(true);
    expect(registry.isActivated("task_output")).toBe(true);
    expect(registry.isDeferred("task_output")).toBe(false);
  });

  test("真正不存在的名字不会被别名兜住（别名表不能变成通配）", () => {
    const registry = buildRegistry();
    expect(registry.get("foo_bar_baz")).toBeUndefined();
  });
});

/** 提取 <deferred-tools-guidance> 段（不存在返回空串，调用方断言非空） */
function guidanceSection(prompt: string): string {
  const i = prompt.indexOf("<deferred-tools-guidance>");
  const j = prompt.indexOf("</deferred-tools-guidance>");
  return i === -1 || j === -1 ? "" : prompt.slice(i, j);
}

describe.skipIf(systemPolicyExists)("D6 — 延迟工具 guidance 覆盖率门禁", () => {
  let originalConfigDir: string | undefined;
  let tmpHome = "";

  beforeEach(() => {
    originalConfigDir = process.env.SID_CONFIG_DIR;
    tmpHome = mkdtempSync(join(tmpdir(), "sid-deferred-guid-"));
    process.env.SID_CONFIG_DIR = tmpHome;
    resetSettingsCache();
    clearPromptCache();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = originalConfigDir;
    resetSettingsCache();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("源码对账：声明 shouldDefer=true 的工具文件 == 期望清单（新增延迟工具必须进清单）", () => {
    expect(scanShouldDeferFiles()).toEqual([...EXPECTED_DEFERRED_FILES]);
  });

  test("每个内置 shouldDefer 且启用的工具都有非空 guidance（覆盖率 100%）", () => {
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);
    const deferred = registry.getEnabledDeferredTools();
    // 内置静态声明口径：mcp__ 前缀动态工具不进门禁（无 guidance 落点，见方案 §D6 修复段 ⚠️）
    const builtin = deferred.filter((t) => !t.name().startsWith("mcp__"));
    expect(builtin.length).toBe(EXPECTED_DEFERRED_FILES.length);
    for (const t of builtin) {
      if (!t.shouldDefer) continue;
      expect(
        typeof t.guidance === "string" && t.guidance.trim().length > 0,
        `${t.name()} 缺 guidance：内置 shouldDefer 工具必须声明「何时该用」（见 tool/types.ts guidance 字段注释）`,
      ).toBe(true);
    }
  });

  test("MCP 工具（mcp__ 前缀）不进门禁：无 guidance 也不红", () => {
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);
    registry.register({
      name: () => "mcp__x__y",
      description: () => "server 动态注册的 MCP 工具",
      inputSchema: () => ({ type: "object", properties: {} }),
      execute: async () => ({ output: "" }),
      // 无 shouldDefer（按 mcp__ 前缀延迟）、无 guidance
    } as never);
    const builtin = registry.getEnabledDeferredTools().filter((t) => !t.name().startsWith("mcp__"));
    // 门禁只对内置静态声明收口：MCP 工具在返回集里（它是延迟工具）但跳过 guidance 检查
    expect(registry.getEnabledDeferredTools().map((t) => t.name())).toContain("mcp__x__y");
    for (const t of builtin) {
      if (!t.shouldDefer) continue;
      expect(typeof t.guidance === "string" && t.guidance.trim().length > 0).toBe(true);
    }
  });

  test("getEnabledDeferredTools 口径：非延迟 / alwaysLoad / keepLoaded 不在返回集", () => {
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);
    const names = registry.getEnabledDeferredTools().map((t) => t.name());
    // 17 个内置延迟工具全在（bg_task_get 已于 D5/T8 并入 task_output）
    expect(names).toContain("monitor");
    expect(names).toContain("workflow");
    // alwaysLoad 豁免：不返回
    registry.register({
      name: () => "always_tool",
      description: () => "x",
      inputSchema: () => ({}),
      execute: async () => ({ output: "" }),
      shouldDefer: true,
      alwaysLoad: true,
    } as never);
    expect(registry.getEnabledDeferredTools().map((t) => t.name())).not.toContain("always_tool");
  });
});

describe.skipIf(systemPolicyExists)("<deferred-tools-guidance> 段 — 系统提示注入", () => {
  let originalConfigDir: string | undefined;
  let tmpHome = "";

  beforeEach(() => {
    originalConfigDir = process.env.SID_CONFIG_DIR;
    tmpHome = mkdtempSync(join(tmpdir(), "sid-deferred-guid-"));
    process.env.SID_CONFIG_DIR = tmpHome;
    resetSettingsCache();
    clearPromptCache();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = originalConfigDir;
    resetSettingsCache();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function buildPrompt(): string {
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);
    return buildSystemPrompt({ tools: registry.enabled() as never });
  }

  /**
   * 速查段里**应当出现**的工具：排除 isGuidanceVisible 返回 false 的（D-20）。
   *
   * 为什么要在这里收口而不是把 team_* 从 EXPECTED_DEFERRED_FILES 删掉：上游门禁
   * （guidance 覆盖率）按「全部内置 shouldDefer 工具」收口，team_* 仍必须有 guidance——
   * 开关打开时要能立刻进速查段。本文件的这两个用例断言的是「速查段行数 == 可见延迟工具数」，
   * 不可见的那些本来就不该有行，用同一个钩子算期望集才不会把正确行为判成漏渲染。
   */
  function visibleDeferredTools(registry: Registry) {
    return registry.getEnabledDeferredTools().filter((t) => t.isGuidanceVisible?.() ?? true);
  }

  test("真实入口：段落出现，行数 == 内置延迟工具数", () => {
    const prompt = buildPrompt();
    const sec = guidanceSection(prompt);
    expect(sec).not.toBe("");
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);
    const rows = sec.match(/^- `/gm) ?? [];
    expect(rows.length).toBe(visibleDeferredTools(registry).length);
  });

  test("段落里每个内置延迟工具名都出现（真实构造，非手搓清单）", () => {
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);
    const prompt = buildSystemPrompt({ tools: registry.enabled() as never });
    const sec = guidanceSection(prompt);
    expect(sec).not.toBe("");
    for (const t of visibleDeferredTools(registry)) {
      expect(sec).toContain(`- \`${t.name()}\`:`);
    }
  });

  test("与 <waiting-capability> 不重复：monitor 在速查段只出现一行，且不含 D4 专属细节", () => {
    const prompt = buildPrompt();
    expect(prompt).toContain("<waiting-capability>"); // 前提：D4 段存在
    const sec = guidanceSection(prompt);
    // monitor 只出现一行（工具行），不重复 D4 段的选择边界细节
    expect(sec.match(/- `monitor`:/g) ?? []).toHaveLength(1);
    // 这些是 <waiting-capability> 的专属内容，速查段不得复述（方案 §D6 验收）
    expect(sec).not.toContain("run_in_background");
    expect(sec).not.toContain("轮询间隔");
    expect(sec).not.toContain("沉默不等于成功");
  });

  test("toolSearch=false（恒关延迟加载）时不出现该段——那时全量工具真的可调用", () => {
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);
    const prompt = buildSystemPrompt({
      tools: registry.enabled() as never,
      toolSearchDisabled: true,
    });
    expect(prompt).not.toContain("<deferred-tools-guidance>");
  });

  test("keepLoaded 豁免的工具不进速查段（它强制首轮可见，不再是延迟工具）", () => {
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);
    const prompt = buildSystemPrompt({
      tools: registry.enabled() as never,
      toolSearchKeepLoaded: ["workflow"],
    });
    const sec = guidanceSection(prompt);
    expect(sec).not.toContain("- `workflow`:");
    expect(sec).toContain("- `monitor`:");
  });

  test("en 档：段落出现且框架措辞为英文", () => {
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);
    const prompt = buildSystemPrompt({
      tools: registry.enabled() as never,
      preferredLanguage: "en",
    });
    const sec = guidanceSection(prompt);
    expect(sec).toContain("Deferred tools at a glance");
    expect(sec).toContain("select:<tool_name>");
  });
});
