/**
 * allowed-tools 语义对齐 CC：fork 判定 / 统一入口 / 工具集（bugfixes 20261013，T2-T5/T11/T12）。
 *
 * 事故（轨迹 20261013-100055-7eeb1160）：自定义命令只写了 allowed-tools 就被 fork；
 * fork 路径不注入 checker；子代理按大小写敏感的白名单查表，只挂上两个 MCP 工具。
 */

import { describe, test, expect } from "bun:test";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { runForkedCommand } from "@sid-code/core/agent/forked-command.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import { CommandExecutor } from "@sid-code/cli/command/executor.ts";
import { CustomCommand, parseCustomCommandOptions } from "@sid-code/cli/command/custom.ts";
import { SkillCommand } from "@sid-code/cli/command/skill-command.ts";
import { resolveSkillExecutionContext } from "@sid-code/core/skill/executor.ts";
import { getBundledSkills } from "@sid-code/core/skill/bundled/registry.ts";
import { resolveAgent } from "@sid-code/core/agent/agent-definition.ts";
import { parseFrontmatter } from "@sid-code/core/extension/frontmatter.ts";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { UnifiedCommand } from "@sid-code/cli/command/types.ts";

const FAKE_CHECKER = { check: async () => ({ allowed: true }) };

type Captured = { task?: any; checker?: unknown; built: number };

/** 把 SubAgent.fromRegistry 换成桩，记下 task 与注入的 checker */
async function withCapture<T>(fn: (cap: Captured) => Promise<T>): Promise<T> {
  const cap: Captured = { built: 0 };
  const orig = SubAgent.fromRegistry;
  (SubAgent as any).fromRegistry = () => {
    cap.built++;
    return {
      setPermissionChecker: (c: unknown) => {
        cap.checker = c;
      },
      executeCustom: async (task: unknown) => {
        cap.task = task;
        return { success: true, output: "ok", usage: {}, turns: 1, toolUseCount: 0 };
      },
    };
  };
  try {
    return await fn(cap);
  } finally {
    (SubAgent as any).fromRegistry = orig;
  }
}

describe("T3 自定义命令只写 allowed-tools → inline，不建 SubAgent", () => {
  test("返回 submit_prompt 并携带本轮 allow 规则", async () => {
    const opts = parseCustomCommandOptions({ "allowed-tools": "Read, Bash(git -C*, x)" });
    const cmd = new CustomCommand("project-qa", "盘点", "盘点 $ARGUMENTS", opts);
    await withCapture(async (cap) => {
      const r = await cmd.execute("讲稿", {
        providerRegistry: {},
        registry: {},
        permissionChecker: FAKE_CHECKER,
      } as any);
      expect(cap.built).toBe(0);
      expect(r).toMatchObject({
        kind: "submit_prompt",
        allowedTools: ["Read", "Bash(git -C*, x)"],
        allowedToolsTrusted: false,
      });
    });
  });

  test("context 字段解析：fork / inline / 非法值忽略", () => {
    expect(parseCustomCommandOptions({ context: "fork" }).context).toBe("fork");
    expect(parseCustomCommandOptions({ context: "inline" }).context).toBe("inline");
    expect(parseCustomCommandOptions({ context: "xx" }).context).toBeUndefined();
  });
});

describe("T4 自定义命令 context: fork → fork，子代理拿到 checker", () => {
  test("checker 非空、工具集来自 agent 类型、allowed-tools 不作白名单", async () => {
    const cmd = new CustomCommand("qa", "", "x", {
      context: "fork",
      allowedTools: ["Read", "Glob"],
    });
    await withCapture(async (cap) => {
      const r = await cmd.execute("", {
        providerRegistry: {},
        registry: {},
        permissionChecker: FAKE_CHECKER,
      } as any);
      expect(r).toMatchObject({ kind: "message", conversational: true });
      expect(cap.checker).toBeDefined();
      expect(cap.task.allowedTools).toEqual([]);
      expect(cap.task.toolsFromAgentType).toBe("general-purpose");
    });
  });
});

describe("T5 fork 统一入口：主 checker 缺失时明确报错", () => {
  test("runForkedCommand(permissionChecker: null) 不建子代理，返回可行动的失败", async () => {
    await withCapture(async (cap) => {
      const r = await runForkedCommand({
        providerRegistry: {} as any,
        toolRegistry: new Registry(),
        permissionChecker: null,
        name: "qa",
        prompt: "x",
        trusted: true,
      });
      expect(cap.built).toBe(0);
      expect(r.success).toBe(false);
      expect(r.output).toContain("无权限检查器");
    });
  });

  test("CommandExecutor 的 fork prompt 命令同样经统一入口（无 checker → 错误回给用户）", async () => {
    const cmd = {
      name: "interview",
      description: "",
      type: "prompt",
      context: "fork",
      source: "skill",
      getPromptForCommand: async () => "p",
    } as UnifiedCommand;
    await withCapture(async (cap) => {
      const r = await new CommandExecutor({ providerRegistry: {} } as any).executeSlashCommand(
        "/interview",
        [cmd],
      );
      expect(cap.built).toBe(0);
      expect(JSON.stringify(r)).toContain("无权限检查器");
    });
  });

  test("SkillCommand fork 同样经统一入口", async () => {
    const skill = { name: "s", description: "", prompt: "# s", source: "user", context: "fork" };
    await withCapture(async (cap) => {
      await new SkillCommand(skill as any).execute("", {
        providerRegistry: {},
        registry: {},
        permissionChecker: FAKE_CHECKER,
      } as any);
      expect(cap.checker).toBeDefined();
      expect(cap.task.toolsFromAgentType).toBe("general-purpose");
    });
  });
});

describe("T2 自定义子代理白名单（agent tools:）名字归一", () => {
  test("`Read, Glob` → 实际拿到 read、glob；查不到的名字被忽略", () => {
    const tools = new Registry();
    const mk = (n: string) =>
      ({
        name: () => n,
        description: () => n,
        inputSchema: () => ({ type: "object", properties: {} }),
        readOnly: () => true,
        execute: async () => ({ output: "", isError: false }),
      }) as any;
    tools.register(mk("read"));
    tools.register(mk("glob"));
    tools.register(mk("bash"));
    const sub = new SubAgent({} as any, "m", tools);
    const got = (sub as any)
      .resolveCustomTools({ allowedTools: ["Read", "Glob", "Bash(ls*)", "NoSuch"] })
      .map((t: any) => t.name());
    expect(got).toEqual(["read", "glob", "bash"]);
  });
});

describe("T11 skill 缺省执行上下文", () => {
  test("无 context / mode → inline；mode: delegate → fork", () => {
    expect(resolveSkillExecutionContext({})).toBe("inline");
    expect(resolveSkillExecutionContext({ mode: "delegate" })).toBe("fork");
    expect(resolveSkillExecutionContext({ mode: "activate" })).toBe("inline");
  });

  test("bundled skill 全部显式声明 context（缺省改动不影响它们）", async () => {
    await import("@sid-code/core/skill/bundled/index.ts").then((m: any) =>
      m.registerBundledSkills?.(),
    );
    for (const s of getBundledSkills()) {
      if (s.type !== "prompt") continue;
      expect(s.context === "inline" || s.context === "fork").toBe(true);
    }
  });

  test("builtin SKILL.md 全部显式声明 mode 或 context", () => {
    const dir = join(import.meta.dir, "../../../core/src/skill/builtin");
    for (const name of readdirSync(dir)) {
      const p = join(dir, name, "SKILL.md");
      if (!existsSync(p)) continue;
      const { frontmatter } = parseFrontmatter(readFileSync(p, "utf-8"));
      expect(frontmatter.mode ?? frontmatter.context).toBeDefined();
    }
  });
});

describe("T12 内置只读 skill 护栏迁到 agent 类型", () => {
  const READ_ONLY = [
    "code-review",
    "security-audit",
    "ci-self-heal",
    "code-governance",
    "incident-rca",
  ];

  test("builtin 只读 skill 都声明 agent: verify，且 verify 工具集不含 edit/write", () => {
    const verify = resolveAgent("verify")!;
    expect(verify.readOnly).toBe(true);
    expect(verify.tools).not.toContain("edit");
    expect(verify.tools).not.toContain("write");
    const dir = join(import.meta.dir, "../../../core/src/skill/builtin");
    for (const name of READ_ONLY) {
      const { frontmatter } = parseFrontmatter(readFileSync(join(dir, name, "SKILL.md"), "utf-8"));
      expect(frontmatter.agent).toBe("verify");
    }
  });

  test("bundled review 声明 agent: verify", async () => {
    await import("@sid-code/core/skill/bundled/index.ts").then((m: any) =>
      m.registerBundledSkills?.(),
    );
    const review = getBundledSkills().find((s) => s.name === "review") as any;
    expect(review?.agent).toBe("verify");
  });
});
