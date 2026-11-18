/**
 * PR12（D5）：只读子代理的 bash 机械门禁
 *
 * 覆盖三层：
 * 1. 判定口径 `judgeReadOnlyBash`——放行只读、拒绝写入、判不准按非只读；
 * 2. 包装器 `wrapBashWithReadOnlyGuard`——拒绝时内层 execute 一次都不跑，
 *    判定异常时按拒绝处理（门禁失效不能变成放行）；
 * 3. 接线——explore 的工具表里真有 bash，且只读 agent 的 bash 注册的是门禁视图，
 *    非只读 agent（task）拿到的 bash 不受影响。
 *
 * 为什么不用「提示词里有只读要求」当断言：那是本次要修掉的旧形态。
 * 只读约束必须由工具层机械判定兜住，提示词只是让模型少走弯路的说明书。
 */

import { describe, test, expect } from "bun:test";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { BUILTIN_AGENTS } from "@sid-code/core/agent/agent-definition.ts";
import { filterToolsForAgent } from "@sid-code/core/agent/tool-filter.ts";
import { resolveOwnCommonDir } from "@sid-code/core/permission/git-repo-trust.ts";
import {
  formatReadOnlyBashRejection,
  judgeReadOnlyBash,
  wrapBashWithReadOnlyGuard,
  type ReadOnlyBashJudgeContext,
} from "@sid-code/core/agent/read-only-bash-guard.ts";
import type { LegacyTool as Tool } from "@sid-code/core/tool/types.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";

// 复合判定（cd + 只读主体）要求工作区真是 git 仓库，否则一律拒绝——用测试进程的
// cwd（仓库根）而不是 tmpdir，才能覆盖「放行」那一侧；tmpdir 无法验证该路径。
const WORKSPACE = process.cwd();
const OWN_COMMON_DIR = resolveOwnCommonDir(WORKSPACE);

/** 只读判定上下文：工作区边界固定为 WORKSPACE，路径判定用前缀模拟 PathValidator */
function ctx(overrides: Partial<ReadOnlyBashJudgeContext> = {}): ReadOnlyBashJudgeContext {
  return {
    startCwd: WORKSPACE,
    ownCommonDir: OWN_COMMON_DIR,
    isWithinWorkingDirectories: (p) => p === WORKSPACE || p.startsWith(`${WORKSPACE}/`),
    ...overrides,
  };
}

// ─── 1. 判定口径 ───

describe("judgeReadOnlyBash：只读命令放行", () => {
  const readOnlyCommands = [
    "git log -S foo",
    "git blame -L 1,5 packages/core/src/a.ts",
    "git show HEAD:packages/core/src/a.ts",
    "git status",
    "git diff HEAD~1",
    "wc -l packages/core/src/a.ts",
    "ls -la",
    "rg foo packages/core/src",
  ];

  for (const command of readOnlyCommands) {
    test(`放行：${command}`, () => {
      expect(judgeReadOnlyBash(command, ctx()).allowed).toBe(true);
    });
  }

  test("放行：工作区内 cd + 只读主体（复用 plan 模式的复合判定）", () => {
    const verdict = judgeReadOnlyBash(`cd ${WORKSPACE}/packages/core && git log -5`, ctx());
    expect(verdict.allowed).toBe(true);
  });
});

describe("judgeReadOnlyBash：写命令被拒且原因可读", () => {
  const writeCommands = [
    "git checkout .",
    "rm packages/core/src/a.ts",
    "echo x > packages/core/src/a.ts",
    "git commit -m wip",
    "git reset --hard HEAD~1",
  ];

  for (const command of writeCommands) {
    test(`拒绝：${command}`, () => {
      const verdict = judgeReadOnlyBash(command, ctx());
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed) return;
      expect(verdict.reason.length).toBeGreaterThan(0);
    });
  }

  test("判不准的复合命令按非只读处理（缺 PathValidator 时 cd 复合一律拒）", () => {
    const verdict = judgeReadOnlyBash(`cd ${WORKSPACE} && git log -5`, {
      ...ctx(),
      isWithinWorkingDirectories: () => false,
    });
    expect(verdict.allowed).toBe(false);
  });
});

// ─── 2. 包装器行为 ───

function fakeBashTool(calls: string[] = []): Tool {
  return {
    name: () => "bash",
    description: () => "fake bash",
    inputSchema: () => ({ type: "object", properties: { command: { type: "string" } } }),
    readOnly: () => false,
    execute: async (input) => {
      calls.push(String((input as { command?: unknown }).command));
      return { output: "inner-ran" };
    },
  };
}

describe("wrapBashWithReadOnlyGuard：门禁在 execute 之前", () => {
  test("写命令被拒：内层 execute 一次都不跑，错误可读且带下一步", async () => {
    const calls: string[] = [];
    const guarded = wrapBashWithReadOnlyGuard(fakeBashTool(calls), {
      workspaceDir: WORKSPACE,
      pathValidator: {
        isWithinWorkingDirectories: (p) => p === WORKSPACE || p.startsWith(`${WORKSPACE}/`),
        resolveRealPath: (p) => p,
      },
    });

    const result = await guarded.execute({ command: "rm -rf packages/core" });
    expect(calls).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("只读代理的 bash 门禁拒绝了这条命令");
    expect(result.output).toContain("只读命令直接可用");
  });

  test("只读命令放行：原样交给内层执行", async () => {
    const calls: string[] = [];
    const guarded = wrapBashWithReadOnlyGuard(fakeBashTool(calls), {
      workspaceDir: WORKSPACE,
      pathValidator: null,
    });

    const result = await guarded.execute({ command: "git log -S foo" });
    expect(calls).toEqual(["git log -S foo"]);
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("inner-ran");
  });

  test("判定抛错时按拒绝处理（监控失效 ≠ 放行）", async () => {
    const calls: string[] = [];
    const guarded = wrapBashWithReadOnlyGuard(fakeBashTool(calls), {
      workspaceDir: WORKSPACE,
      pathValidator: {
        isWithinWorkingDirectories: () => {
          throw new Error("boom");
        },
        resolveRealPath: (p) => p,
      },
    });

    const result = await guarded.execute({ command: `cd ${WORKSPACE} && rm x` });
    expect(calls).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("只读判定异常");
  });

  test("命令缺失/非字符串交给内层（参数校验是 bash 自己的职责）", async () => {
    const calls: string[] = [];
    const guarded = wrapBashWithReadOnlyGuard(fakeBashTool(calls), {
      workspaceDir: WORKSPACE,
      pathValidator: null,
    });

    await guarded.execute({});
    expect(calls).toEqual(["undefined"]);
  });

  test("拒绝文案包含命令原文，便于轨迹里归因", () => {
    const text = formatReadOnlyBashRejection("git checkout .", "不是已知的只读命令");
    expect(text).toContain("git checkout .");
    expect(text).toContain("不是已知的只读命令");
  });
});

// ─── 3. 接线：explore 有 bash，且只读 agent 的 bash 被门禁包住 ───

/** 极简假工具，仅需 name() 供过滤/注册判断 */
function fakeTool(name: string): Tool {
  return {
    name: () => name,
    description: () => `fake ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
  };
}

/** 只为构造 SubAgent：不跑循环，只借它的隔离注册表装配 */
const stubProvider = {} as Provider;

describe("explore 接线", () => {
  test("内置定义：explore 的工具表包含 bash（不再是纯 read/grep）", () => {
    const explore = BUILTIN_AGENTS.explore;
    expect(explore).toBeDefined();
    expect(explore?.tools).toContain("bash");
  });

  test("工具过滤：explore 白名单放行 bash，task 也放行（Layer 2 不误伤）", () => {
    const all = ["read", "grep", "glob", "ls", "read_many", "bash", "write"].map(fakeTool);
    const exploreTools = filterToolsForAgent(all, {
      isBuiltIn: true,
      builtInType: "explore",
      isAsync: false,
    });
    expect(exploreTools.map((t) => t.name())).toContain("bash");
    expect(exploreTools.map((t) => t.name())).not.toContain("write");

    const taskTools = filterToolsForAgent(all, {
      isBuiltIn: true,
      builtInType: "task",
      isAsync: false,
    });
    expect(taskTools.map((t) => t.name())).toContain("bash");
  });

  test("隔离注册表：只读 agent 的 bash 是门禁视图，写命令被拒", async () => {
    const agent = new SubAgent(stubProvider, "m", new Registry());
    const tools = (
      agent as unknown as {
        buildIsolatedToolRegistry(
          tools: Tool[],
          agentType?: string,
          agentId?: string,
          options?: { readOnlyAgent?: boolean },
        ): Registry;
      }
    ).buildIsolatedToolRegistry([fakeBashTool()], "explore", "agent-1", {
      readOnlyAgent: true,
    });

    const bash = tools.get("bash");
    expect(bash).toBeDefined();
    const result = await bash!.execute({ command: "git commit -m x" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("只读代理的 bash 门禁拒绝");
  });

  test("隔离注册表：非只读 agent（task）的 bash 不受门禁影响", async () => {
    const agent = new SubAgent(stubProvider, "m", new Registry());
    const tools = (
      agent as unknown as {
        buildIsolatedToolRegistry(
          tools: Tool[],
          agentType?: string,
          agentId?: string,
          options?: { readOnlyAgent?: boolean },
        ): Registry;
      }
    ).buildIsolatedToolRegistry([fakeBashTool()], "task", "agent-2", {
      readOnlyAgent: false,
    });

    const bash = tools.get("bash");
    const result = await bash!.execute({ command: "git commit -m x" });
    expect(result.isError).toBeUndefined();
  });
});
