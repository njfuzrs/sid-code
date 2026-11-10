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
import { TaskGetTool } from "../../src/tool/task-get.ts";
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
  "task-get.ts",
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

/** 注册全部 18 个内置 shouldDefer 工具（真实实例，不是手搓形状） */
function registerAllBuiltinDeferred(registry: Registry): void {
  registry.register(new TaskGetTool());
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
    // 18 个内置延迟工具全在
    expect(names).toContain("monitor");
    expect(names).toContain("workflow");
    expect(names).toContain("bg_task_get");
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

  test("真实入口：段落出现，行数 == 内置延迟工具数", () => {
    const prompt = buildPrompt();
    const sec = guidanceSection(prompt);
    expect(sec).not.toBe("");
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);
    const rows = sec.match(/^- `/gm) ?? [];
    expect(rows.length).toBe(registry.getEnabledDeferredTools().length);
  });

  test("段落里每个内置延迟工具名都出现（真实构造，非手搓清单）", () => {
    const registry = new Registry();
    registerAllBuiltinDeferred(registry);
    const prompt = buildSystemPrompt({ tools: registry.enabled() as never });
    const sec = guidanceSection(prompt);
    expect(sec).not.toBe("");
    for (const t of registry.getEnabledDeferredTools()) {
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
