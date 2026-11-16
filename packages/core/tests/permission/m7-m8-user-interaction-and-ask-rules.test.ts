/**
 * M7 + M8（方案 20261112 / PR-4）：权限模式的终局性。
 *
 * 两条缺陷的共同形态：**用户/系统写下的意图被另一个放行口静默改写**。
 *
 * - M7：`dontAsk` 承诺「绝不弹窗」，但 `ask_user_question` 的执行语义是「阻塞等人回答」。
 *   权限层此前无从知道这一点，于是 Step 8 的 allow 规则（用户级 settings 里从 Claude Code
 *   迁过来的 `AskUserQuestion` 很常见）会把它放过去，在「一切需确认的都拒」的模式里弹问卷。
 * - M8：用户写下的 `ask` 规则在 `skipPermissions` 与 `-y` 下被吞掉，而同一份规则在
 *   default 档会弹确认 —— 同一条配置在不同模式下的含义被悄悄改写。
 *
 * 修法共用一条原则：**ask 规则是用户明确表达的意图，任何自动批准通道都不该吞掉它**
 * （与 M1b 让 auto 分类器不得放行 ask 规则同源）。
 *
 * ⚠️ 落盘隔离：PermissionChecker 构造 AuditLogger，必须把 SID_CONFIG_DIR 重定向到 tmpdir，
 * 且恢复时存/恢复原值（同批测试跑在同一进程里，无条件 delete 会抹掉 preload 兜底）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "../../src/permission/checker.ts";
import { createSubAgentChecker } from "../../src/permission/sub-agent-checker.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { Registry } from "../../src/tool/registry.ts";
import { AskUserQuestionTool } from "../../src/tool/ask-user-question.ts";
import { TodoWriteTool } from "../../src/tool/todo-write.ts";
import type { PermissionRule } from "../../src/permission/types.ts";
import type { Tool } from "../../src/tool/types.ts";

/**
 * `check()` 的形参是新版 `Tool`，registry 内部存 `LegacyTool`（bridge 归一后）。
 * 生产链路（`agent/tool-executor.ts`）传的就是 registry 里那份，测试照同一条路径断言。
 */
type ToolInstance = Tool<unknown, string>;

let configRoot: string;
let workspace: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-m78-cfg-"));
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "sid-m78-ws-")));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/** 与 CLI 同一条注册链路：工具实例 → registry.register() → registry.get()。 */
let cachedRegistry: Registry | undefined;

function registryWithBuiltins(): Registry {
  if (cachedRegistry) return cachedRegistry;
  const registry = new Registry();
  registry.register(new AskUserQuestionTool());
  registry.register(new TodoWriteTool());
  cachedRegistry = registry;
  return registry;
}

function toolByName(name: string): ToolInstance {
  const tool = registryWithBuiltins().get(name);
  if (!tool) throw new Error(`测试准备失败：registry 里没有 ${name}`);
  return tool as unknown as ToolInstance;
}

function buildChecker(
  over: Record<string, unknown> = {},
  rules?: Partial<PermissionRule>,
): PermissionChecker {
  return new PermissionChecker(
    { ...defaultConfig(), ...over } as never,
    { allow: [], deny: [], ask: [], ...rules } as PermissionRule,
    workspace,
  );
}

const ASK_REQ = {
  toolName: "ask_user_question",
  input: {
    questions: [
      { question: "选哪个？", header: "选型", options: [{ label: "A" }, { label: "B" }] },
    ],
  },
};
const PUSH_REQ = { toolName: "bash", input: { command: "git push origin main" } };

describe("M7：Tool.requiresUserInteraction 自报", () => {
  test("ask_user_question 声明 requiresUserInteraction", () => {
    // 用方法而不是工具名清单：名单会在「新增交互工具」时漂掉，而改名单的人
    // 不一定知道权限层有这个判据。
    const tool = new AskUserQuestionTool();
    expect(tool.requiresUserInteraction?.()).toBe(true);
  });

  test("ask_user_question 不声明 requiresPermission（免权限 ≠ 需要交互）", () => {
    // 若误声明成免权限，dontAsk 下会被 Step 13.6 直接放行——正是 M7 要防的反面。
    const tool = new AskUserQuestionTool() as unknown as { requiresPermission?: () => boolean };
    expect(tool.requiresPermission).toBeUndefined();
  });

  test("declare 了 requiresUserInteraction 的工具由 registry 原样带出", () => {
    // 声明要经 bridge 才留得下来：只测裸实例会让「转发缺失」静默通过。
    expect(toolByName("ask_user_question").requiresUserInteraction?.()).toBe(true);
  });
});

describe("M7：dontAsk 拒绝交互类工具（含各类放行口）", () => {
  test("dontAsk + 无规则 → DENY（既有行为不变）", async () => {
    const d = await buildChecker({ permissionMode: "dontAsk" }).check(
      ASK_REQ,
      toolByName("ask_user_question"),
    );
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBeFalsy();
  });

  test('dontAsk + allow ["AskUserQuestion"] → DENY（step=mode-gate）', async () => {
    // 修前：allowed=true step=8-rule —— 用户级 settings 里从 CC 迁来的这条规则
    // 足以在「绝不弹窗」的模式里弹出问卷。
    const d = await buildChecker(
      { permissionMode: "dontAsk" },
      { allow: ["AskUserQuestion"] },
    ).check(ASK_REQ, toolByName("ask_user_question"));
    expect(d.allowed).toBe(false);
    expect(d.step).toBe("mode-gate");
  });

  test('dontAsk + allow ["ask_user_question"]（sid 原名）→ DENY', async () => {
    // 规则名两种写法都要拦：CC 名靠别名表匹配到同一条 allow，漏拦哪一边都是洞。
    const d = await buildChecker(
      { permissionMode: "dontAsk" },
      { allow: ["ask_user_question"] },
    ).check(ASK_REQ, toolByName("ask_user_question"));
    expect(d.allowed).toBe(false);
    expect(d.step).toBe("mode-gate");
  });

  test("dontAsk + 会话记忆「总是允许」→ DENY", async () => {
    // 记忆快速路径排在阶段二之前，只靠阶段二的 dontAsk 判断拦不住它。
    // ask_user_question 无 resource（extractMemoryResource 返空）→ 正常路径写不进记忆，
    // 这里直接注入记忆项模拟「该工具在某个版本曾可记忆」的历史状态，验证总闸兜底。
    const checker = buildChecker({ permissionMode: "dontAsk" });
    (checker as unknown as { sessionMemory: Map<string, boolean> }).sessionMemory.set(
      "ask_user_question:whatever",
      true,
    );
    const d = await checker.check(
      { toolName: "ask_user_question", input: { command: "whatever" } },
      toolByName("ask_user_question"),
    );
    expect(d.allowed).toBe(false);
    expect(d.step).toBe("mode-gate");
  });

  test("dontAsk + hook allow → DENY", async () => {
    const d = await buildChecker({ permissionMode: "dontAsk" }).check(
      ASK_REQ,
      toolByName("ask_user_question"),
      undefined,
      { hookPermissionDecision: "allow" } as never,
    );
    expect(d.allowed).toBe(false);
    expect(d.step).toBe("mode-gate");
  });

  test("dontAsk + 非交互工具（todo_write）→ ALLOW（不误伤）", async () => {
    // 对照：总闸只认 requiresUserInteraction，不是把 dontAsk 整体收紧。
    const d = await buildChecker({ permissionMode: "dontAsk" }).check(
      { toolName: "todo_write", input: { todos: [] } },
      toolByName("todo_write"),
    );
    expect(d.allowed).toBe(true);
  });

  for (const mode of ["default", "acceptEdits"] as const) {
    test(`${mode} + allow ["AskUserQuestion"] → ALLOW（allow 规则本身没被废掉）`, async () => {
      const d = await buildChecker({ permissionMode: mode }, { allow: ["AskUserQuestion"] }).check(
        ASK_REQ,
        toolByName("ask_user_question"),
      );
      expect(d.allowed).toBe(true);
      expect(d.step).toBe("8-rule");
    });
  }
});

describe("M8：skip 档不再吞掉用户 ask 规则", () => {
  test("skip + 无规则 → ALLOW（skip 语义不变）", async () => {
    const d = await buildChecker({ skipPermissions: true }).check(PUSH_REQ);
    expect(d.allowed).toBe(true);
    expect(d.step).toBe("skip");
  });

  test('skip + ask ["Bash(git push*)"] → 需确认（step=skip-ask-rule）', async () => {
    // 修前：allowed=true step=skip —— 用户写的「推送前问我」被静默执行。
    const d = await buildChecker({ skipPermissions: true }, { ask: ["Bash(git push*)"] }).check(
      PUSH_REQ,
    );
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBe(true);
    expect(d.step).toBe("skip-ask-rule");
  });

  test("skip + ask 规则命中复合命令后段 → 仍需确认（some 语义）", async () => {
    // 整条匹配时 `ls && git push` 匹配不到 `Bash(git push*)`，与 deny 同口径逐变体匹配。
    const d = await buildChecker({ skipPermissions: true }, { ask: ["Bash(git push*)"] }).check({
      toolName: "bash",
      input: { command: "ls && git push origin main" },
    });
    expect(d.needsConfirmation).toBe(true);
    expect(d.step).toBe("skip-ask-rule");
  });

  test("skip + 不相关的 ask 规则 → 仍 ALLOW（不误伤）", async () => {
    const d = await buildChecker({ skipPermissions: true }, { ask: ["Bash(git push*)"] }).check({
      toolName: "bash",
      input: { command: "ls -la" },
    });
    expect(d.allowed).toBe(true);
    expect(d.step).toBe("skip");
  });

  test("skip + deny 规则 → 仍 DENY（M8 没动既有语义）", async () => {
    const d = await buildChecker({ skipPermissions: true }, { deny: ["Bash(git push*)"] }).check(
      PUSH_REQ,
    );
    expect(d.allowed).toBe(false);
    expect(d.step).toBe("skip-deny-rule");
  });
});

describe("M8：-y（yesMode）不再吞掉用户 ask 规则", () => {
  test('yesMode + ask ["Bash(git push*)"] → 需确认，不自动批准', async () => {
    // 修前：allowed=true step=yes。`-y` 的语义是「自动批准需确认操作」，
    // 而 ask 规则是用户点名要问的那一类——自动批准盖上去等于静默改写用户配置。
    const d = await buildChecker({ yesMode: true }, { ask: ["Bash(git push*)"] }).check(PUSH_REQ);
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBe(true);
    expect(d.step).not.toBe("yes");
  });

  test("yesMode + 无 ask 规则 → 仍自动批准（既有行为不变）", async () => {
    const d = await buildChecker({ yesMode: true }).check(PUSH_REQ);
    expect(d.allowed).toBe(true);
    expect(d.step).toBe("yes");
  });

  test("yesMode + 危险命令 → 仍不放行（既有护栏不变）", async () => {
    // 用 `sudo apt update`：它是 isSafetyConfirmation 覆盖的「需确认的危险命令」，
    // 正好落在 yesMode 的分支上。`rm -rf /` 是 critical 级直接拒绝（Step 2 不走确认），
    // 拿它当样本测不到这道护栏。
    const d = await buildChecker({ yesMode: true }).check({
      toolName: "bash",
      input: { command: "sudo apt update" },
    });
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBe(true);
  });

  test("always-allow（无 -y）+ ask 规则 → 需确认（对照不变）", async () => {
    const d = await buildChecker(
      { permissionMode: "always-allow" },
      { ask: ["Bash(git push*)"] },
    ).check(PUSH_REQ);
    expect(d.needsConfirmation).toBe(true);
  });
});

describe("M8：无头与子代理（skip 的两条传播路径）", () => {
  test("skip + ask + 无头 → DENY，reason 含规则原文（不挂起等人）", async () => {
    // skip 早退排在阶段二 headless 分支之前，走不到那个统一落点，所以在
    // checkUserAskUnderSkip 里自己落一次 deny；文案必须带规则原文，
    // 否则模型不知道是哪条配置拦的（同 headless Note 的教训：不解释边界就会盲试）。
    const checker = buildChecker(
      { skipPermissions: true, print: true },
      { ask: ["Bash(git push*)"] },
    );
    const d = await checker.check(PUSH_REQ);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("Bash(git push*)");
    expect(d.step).toBe("skip-ask-rule");
  });

  test("子代理继承 skip（归一成 always-allow）+ ask 规则 → 仍需确认", async () => {
    // skip 档派生的子代理不再复制 skipPermissions 布尔（它在 check() 最顶端早退会绕过
    // 危险命令拦截），而是归一成 always-allow 走 Step 8。ask 规则由 Step 5 生效，
    // 所以子代理侧与主会话同口径——这里锁定「传播后 ask 规则没被 always-allow 吃掉」。
    const main = new PermissionChecker(
      {
        ...defaultConfig(),
        skipPermissions: true,
        permissionMode: "dangerously-skip-permissions",
      } as never,
      { allow: [], deny: [], ask: ["Bash(git push*)"] } as PermissionRule,
      workspace,
    );
    const sub = createSubAgentChecker(main, workspace, { inheritBypassMode: true });
    expect(sub.getConfig().skipPermissions).toBe(false);
    const d = await sub.check(PUSH_REQ);
    expect(d.allowed).toBe(false);
    expect(d.needsConfirmation).toBe(true);
  });
});
