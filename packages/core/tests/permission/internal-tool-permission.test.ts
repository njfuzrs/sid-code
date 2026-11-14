/**
 * B14（PR-6）：工具自报「我不需要权限」，权限链据此放行。
 *
 * ## 修的是什么
 *
 * 进程内记账/只读类工具（`think` / `todo_write` / `task_*` / `bg_task_*` / `cron_list` /
 * `enter_plan_mode` / `sub_agent`）既不改工作区也不跑外部命令，但权限主链只认三张
 * 手写名单（`READ_ONLY_TOOLS` / `HEADLESS_LOCAL_LEDGER_TOOLS` / `PLAN_MODE_EXTRA_TOOLS`），
 * 于是它们在交互 default 下每次都要确认、在无头与子代理里直接被拒。实测代价：
 * `todo_write` 2/2 次、`bg_task_get` 1/1 次全部弹窗；无头会话里 `sub_agent` 被
 * `step=headless:14` 拒绝。
 *
 * ## 为什么测试必须走 `ToolRegistry.register()`
 *
 * 两件事都要在这条路径上才成立：
 *
 * 1. **来源标记**：`requiresPermission()` 只对内置工具生效，而「内置」这个事实是
 *    registry 在注册那一刻打上去的 Symbol（`TOOL_REGISTRATION_SOURCE`）。
 *    直接把 `new TodoWriteTool()` 塞给 checker 等于绕过注册，来源是 undefined，
 *    声明必然被忽略——那不是测试该模拟的真实链路。
 * 2. **bridge 转发**：`think` 是新接口工具，声明要经 `toLegacyTool` 的
 *    `FORWARDED_KEYS` 才留得下来。只测旧接口实例会让这条转发缺失静默通过。
 *
 * ⚠️ 落盘隔离：`todo_write` / `task_create` 会写 `~/.sid-code/` 下的账本，
 * 这里把 `SID_CONFIG_DIR` 重定向到 tmpdir（存/恢复原值，不无条件 delete）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "../../src/permission/checker.ts";
import { Registry } from "../../src/tool/registry.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { PlanModeManager } from "../../src/plan/state.ts";
import type { PermissionRule } from "../../src/permission/types.ts";
import type { Tool } from "../../src/tool/types.ts";
/**
 * `check()` 的形参类型是新版 `Tool`，而 registry 内部存的是 `LegacyTool`（bridge 归一后）。
 * 生产链路（`agent/tool-executor.ts`）传的就是 registry 里那份，两侧本来就有这道类型擦除；
 * 测试照同一条路径断言，不加这层断言反而测不到真相。
 */
type ToolInstance = Tool<unknown, string>;
import { thinkTool } from "../../src/tool/think.ts";
import { TodoWriteTool } from "../../src/tool/todo-write.ts";
import { TaskCreateTool } from "../../src/tool/structured-task-create.ts";
import { TaskUpdateTool } from "../../src/tool/structured-task-update.ts";
import { StructuredTaskGetTool } from "../../src/tool/structured-task-get.ts";
import { StructuredTaskListTool } from "../../src/tool/structured-task-list.ts";
import { TaskGetTool } from "../../src/tool/task-get.ts";
import { TaskListTool } from "../../src/tool/task-list.ts";
import { TaskOutputTool } from "../../src/tool/task-output.ts";
import { TaskStopTool } from "../../src/tool/task-stop.ts";
import { CronListTool } from "../../src/tool/cron-list.ts";
import { CronCreateTool } from "../../src/tool/cron-create.ts";
import { EnterPlanModeTool } from "../../src/tool/enter-plan-mode.ts";
import { ExitPlanModeTool } from "../../src/tool/exit-plan-mode.ts";
import { AskUserQuestionTool } from "../../src/tool/ask-user-question.ts";
import { SubAgentTool } from "../../src/agent/tool.ts";

let configRoot: string;
let prevConfigDir: string | undefined;
let workspace: string;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-b14-cfg-"));
  workspace = mkdtempSync(join(tmpdir(), "sid-b14-ws-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

type Mode = "default" | "acceptEdits" | "plan" | "deny-write" | "dontAsk" | "headless";

/**
 * 与 CLI 同一条注册链路：工具实例 → `registry.register()` → `registry.get(name)`。
 * 权限链拿到的正是 `get()` 返回的那份（`tool-executor` 也是这么取的）。
 */
let cachedRegistry: Registry | undefined;

function registryWithBuiltins(): Registry {
  if (cachedRegistry) return cachedRegistry;
  const planManager = new PlanModeManager();
  const registry = new Registry();
  registry.register(thinkTool);
  registry.register(new TodoWriteTool());
  registry.register(new TaskCreateTool());
  registry.register(new TaskUpdateTool());
  registry.register(new StructuredTaskGetTool());
  registry.register(new StructuredTaskListTool());
  registry.register(new TaskOutputTool());
  registry.register(new TaskGetTool());
  registry.register(new TaskListTool());
  registry.register(new CronListTool());
  registry.register(new EnterPlanModeTool(planManager));
  // 「必须不变」组的对照组：这些工具本次刻意没有声明
  registry.register(new TaskStopTool());
  registry.register(new CronCreateTool());
  registry.register(new ExitPlanModeTool(planManager));
  registry.register(new AskUserQuestionTool());
  // J9 的例外：sub_agent 随首批放行（无头下被拒是真实功能缺陷），worktree 隔离仍确认
  registry.register(new SubAgentTool({} as never, new Registry()));
  cachedRegistry = registry;
  return registry;
}

function toolByName(name: string): ToolInstance {
  const tool = registryWithBuiltins().get(name);
  if (!tool) throw new Error(`测试准备失败：registry 里没有 ${name}`);
  return tool as unknown as ToolInstance;
}

function buildChecker(mode: Mode, rules?: Partial<PermissionRule>): PermissionChecker {
  const config = { ...defaultConfig() };
  if (mode === "headless") {
    // 无头 = print 模式；权限档位保持 default
    config.permissionMode = "default";
    config.print = true;
  } else {
    config.permissionMode = mode;
  }
  const checker = new PermissionChecker(
    config,
    { allow: [], deny: [], ask: [], ...rules } as PermissionRule,
    workspace,
  );
  checker.setPlanManager(new PlanModeManager());
  return checker;
}

/** 首批声明了免权限的工具（含 J9 的 `sub_agent` 例外，见下方单独一组） */
const FIRST_BATCH = [
  "think",
  "todo_write",
  "task_create",
  "task_update",
  "task_get",
  "task_list",
  "task_output",
  "bg_task_get",
  "bg_task_list",
  "cron_list",
  "enter_plan_mode",
] as const;

describe("B14 变放行：交互 default / acceptEdits 下首批工具不再询问", () => {
  for (const mode of ["default", "acceptEdits"] as const) {
    test(`${mode}：首批 ${FIRST_BATCH.length} 个工具全部 ALLOW`, async () => {
      const checker = buildChecker(mode);
      for (const name of FIRST_BATCH) {
        const d = await checker.check({ toolName: name, input: {} }, toolByName(name));
        expect({ name, allowed: d.allowed }).toEqual({ name, allowed: true });
        expect(d.needsConfirmation).toBeUndefined();
      }
    });
  }
});

describe("B14 变放行：无头 default 下不再直接拒绝", () => {
  // 修前这些工具落在 `step=headless:14`：阶段二把 ask 转成 deny，
  // 模型拿到的是一句没有可行动信息的「权限拒绝」，会被当成工具失败。
  for (const name of ["think", "task_get", "task_output", "bg_task_get", "enter_plan_mode"]) {
    test(`无头 default：${name} → ALLOW`, async () => {
      const checker = buildChecker("headless");
      const d = await checker.check({ toolName: name, input: {} }, toolByName(name));
      expect(d.allowed).toBe(true);
    });
  }
});

describe("B14 变放行：plan 模式放行无副作用工具", () => {
  // 修前 `step=9` 拒绝：plan 只认 READ_ONLY_TOOLS + PLAN_MODE_EXTRA_TOOLS 两张名单，
  // 规划阶段连「记一条 todo」都做不了。
  for (const name of ["think", "todo_write", "task_get"]) {
    test(`plan：${name} → ALLOW`, async () => {
      const checker = buildChecker("plan");
      const d = await checker.check({ toolName: name, input: {} }, toolByName(name));
      expect(d.allowed).toBe(true);
    });
  }

  /**
   * plan 模式下 `sub_agent` 属于两套判据的交集：既在 `PLAN_MODE_EXTRA_TOOLS` 里
   * （只许 explore），也在声明的放行面上。严的那套必须先生效——否则
   * `sub_agent(type: "general-purpose")` 会借免权限声明把 plan 的「只读」打穿。
   */
  test("plan：sub_agent(type=general-purpose) 仍被拒（explore 限制不被声明绕过）", async () => {
    const checker = buildChecker("plan");
    const d = await checker.check(
      { toolName: "sub_agent", input: { type: "general-purpose" } },
      toolByName("sub_agent"),
    );
    expect(d.allowed).toBe(false);
  });

  /**
   * `ask_user_question` 本次**刻意不声明**（20261112 方案 M7 未合入）：
   * 它的语义是「我需要用户输入」，不是「我不需要权限」。若在这里声明免权限，
   * `dontAsk` 下会被 Step 13.6 直接放行——等于在「一切需确认的都拒」的模式里弹问卷。
   * M7 合入后应改为声明 `requiresUserInteraction`，而不是加进本清单。
   */
  test("plan：ask_user_question 仍被拒（未声明，等 M7）", async () => {
    const checker = buildChecker("plan");
    const d = await checker.check(
      { toolName: "ask_user_question", input: {} },
      toolByName("ask_user_question"),
    );
    expect(d.allowed).toBe(false);
  });
});

describe("B14 变放行：deny-write 只放行「声明免权限 + 真的只读」", () => {
  for (const name of ["think", "task_get", "bg_task_get"]) {
    test(`deny-write：${name}（readOnly=true）→ ALLOW`, async () => {
      const checker = buildChecker("deny-write");
      const d = await checker.check({ toolName: name, input: {} }, toolByName(name));
      expect(d.allowed).toBe(true);
    });
  }

  /**
   * J10 / §6.1「必须不变」：这三个会写 `~/.sid-code/` 下的账本文件，
   * `readOnly()` 为 false，deny-write 下继续拒。
   *
   * 这一组是 deny-write 分支**必须同时看两个条件**的证据：只看声明会把它们放进来。
   */
  for (const name of ["todo_write", "task_create", "task_update"]) {
    test(`deny-write：${name}（会写账本）→ 仍 DENY`, async () => {
      const checker = buildChecker("deny-write");
      const d = await checker.check({ toolName: name, input: {} }, toolByName(name));
      expect(d.allowed).toBe(false);
      expect(d.step).toBe("13");
    });
  }
});

describe("B14 必须不变：没声明免权限的工具照旧确认", () => {
  for (const name of ["exit_plan_mode", "task_stop", "cron_create"]) {
    test(`交互 default：${name} → ASK`, async () => {
      const checker = buildChecker("default");
      const d = await checker.check({ toolName: name, input: {} }, toolByName(name));
      expect(d.allowed).toBe(false);
      expect(d.needsConfirmation).toBe(true);
    });
  }

  /** dontAsk 下 `ask_user_question` 仍然被拒（M7 之前靠 Step 14 → dontAsk 落 deny） */
  test("dontAsk：ask_user_question → DENY", async () => {
    const checker = buildChecker("dontAsk");
    const d = await checker.check(
      { toolName: "ask_user_question", input: {} },
      toolByName("ask_user_question"),
    );
    expect(d.allowed).toBe(false);
  });

  /**
   * dontAsk 下首批工具**会**放行——这是有意的语义变化，对齐 CC
   * （CC 的 dontAsk 只拒「需要权限」的调用）。PR 正文里必须点明。
   */
  test("dontAsk：todo_write → ALLOW（有意的语义变化）", async () => {
    const checker = buildChecker("dontAsk");
    const d = await checker.check({ toolName: "todo_write", input: {} }, toolByName("todo_write"));
    expect(d.allowed).toBe(true);
  });
});

describe("B14 规则优先：用户显式规则先于免权限声明", () => {
  test("deny 规则 TodoWrite → DENY（规则在 Step 1，新 Step 在其后）", async () => {
    const checker = buildChecker("default", { deny: ["TodoWrite"] });
    const d = await checker.check({ toolName: "todo_write", input: {} }, toolByName("todo_write"));
    expect(d.allowed).toBe(false);
  });

  test("ask 规则 Think → ASK（Step 5 先于新 Step）", async () => {
    const checker = buildChecker("default", { ask: ["Think"] });
    const d = await checker.check({ toolName: "think", input: {} }, toolByName("think"));
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBe(true);
  });
});

describe("B14 桥接工具：非内置来源的声明一律忽略", () => {
  /**
   * MCP / 自定义代理工具即便实现了 `requiresPermission() { return false }` 也必须照旧确认。
   * 这是信任边界：声明是「我写的代码我担保」，外部代码不享受这个担保。
   *
   * 用 `registry.register(tool, "mcp")` 构造一个行为与内置工具完全相同的对象，
   * 唯一的差别就是来源——这样断言失败时能确定是来源判据出了问题，
   * 而不是工具本身没声明。
   */
  test("来源为 mcp 的工具声明免权限 → 仍 ASK", async () => {
    const registry = new Registry();
    const impostor = new TodoWriteTool();
    registry.register(impostor, "mcp");
    const tool = registry.get("todo_write");
    expect(tool).toBeDefined();

    const checker = buildChecker("default");
    const d = await checker.check(
      { toolName: "todo_write", input: {} },
      tool as unknown as ToolInstance,
    );
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBe(true);
  });

  /**
   * 同一个工具用默认来源（builtin）注册 → 放行。
   * 与上一条对照，说明差别只来自来源标记，不来自工具或其它因素。
   */
  test("同一工具以 builtin 来源注册 → ALLOW（对照组）", async () => {
    const registry = new Registry();
    registry.register(new TodoWriteTool());
    const tool = registry.get("todo_write") as unknown as ToolInstance;

    const checker = buildChecker("default");
    const d = await checker.check({ toolName: "todo_write", input: {} }, tool);
    expect(d.allowed).toBe(true);
  });
});

describe("B14 子代理：J9 例外——随首批放行，但 worktree 隔离仍要确认", () => {
  const subAgent = () => toolByName("sub_agent");

  test("交互 default：sub_agent（无 isolation）→ ALLOW", async () => {
    const checker = buildChecker("default");
    const d = await checker.check(
      { toolName: "sub_agent", input: { type: "explore", prompt: "看看" } },
      subAgent(),
    );
    expect(d.allowed).toBe(true);
  });

  test("交互 default：sub_agent(isolation=worktree) → ASK", async () => {
    const checker = buildChecker("default");
    const d = await checker.check(
      { toolName: "sub_agent", input: { type: "task", prompt: "改", isolation: "worktree" } },
      subAgent(),
    );
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBe(true);
  });
});

/**
 * 防漂移哨兵：源码里「无条件声明免权限」的工具集合必须等于本文件写死的清单。
 *
 * 为什么需要它：`requiresPermission()` 是一条**放宽**权限的声明，写错方向的代价是
 * 「本该确认的工具被静默放行」。而这类漂移在别处看不出来——新工具的作者不会知道
 * 这里有一份清单，review 也很难从 diff 里看出「这个声明等于免确认」。
 *
 * 两个方向都盯：
 * - 源码多声明了一个（尤其危险：新工具顺手抄了一份 `requiresPermission`）→ 红；
 * - 源码少声明了一个（清单里的工具被人删掉声明，静默退回每次弹窗）→ 红。
 *
 * **不要为了让本哨兵变绿去改清单**——清单的每一次变化都意味着权限面变了，
 * 需要同时更新 `website/use/permissions.md` 的「不需要权限的工具」表并说明理由。
 *
 * `sub_agent` 是**条件式**声明（`isolation: "worktree"` 时仍需确认），不进本清单，
 * 由文件末尾那条单独的哨兵盯。
 */
describe("防漂移哨兵：声明免权限的工具集合", () => {
  /** 本次（B14）确认放行的全部无条件免权限工具 */
  const EXPECTED_UNCONDITIONAL = [
    "bg_task_get",
    "bg_task_list",
    "cron_list",
    "enter_plan_mode",
    "task_create",
    "task_get",
    "task_list",
    "task_output",
    "task_update",
    "think",
    "todo_write",
  ];

  function scanUnconditionalClaims(): string[] {
    const toolDir = join(import.meta.dir, "../../src/tool");
    const found: string[] = [];
    for (const file of readdirSync(toolDir).sort()) {
      if (!file.endsWith(".ts")) continue;
      // 这三个不是工具定义：类型、bridge 转发键表、注册表本体
      if (file === "types.ts" || file === "bridge.ts" || file === "registry.ts") continue;
      const src = readFileSync(join(toolDir, file), "utf8");
      // 「无条件」= 方法体第一句就是 return false（条件式声明不会被这条正则命中）
      if (!/requiresPermission(?:\([^)]*\))?\s*(?::\s*boolean)?\s*\{\s*return false;/.test(src)) {
        continue;
      }
      const named =
        src.match(/\bname\(\)\s*:\s*string\s*\{\s*return\s+"([a-z_]+)"/) ??
        src.match(/\bname:\s*"([a-z_]+)"/);
      found.push(named ? named[1] : `<无法解析工具名: ${file}>`);
    }
    return found.sort();
  }

  test("源码声明集合 === 写死清单", () => {
    expect(scanUnconditionalClaims()).toEqual(EXPECTED_UNCONDITIONAL.slice().sort());
  });

  test("清单里每个工具都真的声明了（防删声明后退回弹窗）", () => {
    for (const name of EXPECTED_UNCONDITIONAL) {
      const tool = registryWithBuiltins().get(name) as unknown as {
        requiresPermission?: () => boolean;
      };
      expect({ name, declared: typeof tool?.requiresPermission }).toEqual({
        name,
        declared: "function",
      });
      expect({ name, returns: tool.requiresPermission?.() }).toEqual({ name, returns: false });
    }
  });

  /**
   * `sub_agent` 的条件式声明：两个方向都要钉住。
   *
   * 漏了「worktree 仍确认」这一半，会让 `isolation: "worktree"` 静默免确认——
   * 而它真的会 `git worktree add` 建目录、复制配置，是这几条声明里唯一有磁盘副作用的。
   */
  test("sub_agent：非 worktree 免权限、worktree 仍需确认", () => {
    const sub = registryWithBuiltins().get("sub_agent") as unknown as {
      requiresPermission(input?: unknown): boolean;
    };
    expect(sub.requiresPermission({ type: "explore" })).toBe(false);
    expect(sub.requiresPermission({ type: "task", isolation: "worktree" })).toBe(true);
  });
});
