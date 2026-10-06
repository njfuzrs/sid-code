/**
 * 命令系统批次 2：D12（第一步）· D1 · D2 · D8 · D3 · D13。
 *
 * 每组都按「修复前会红」的形态写：
 * - D1/D2：别名记成 canonical、未知命令 / 路径 / 被拒命令不记账，且 executeImmediate 同样记账；
 * - D8：fork 缺 providerRegistry 降级时，走 inline 那条唯一出口（上报 addInvokedSkill、不卸 hooks）；
 * - D13：local-jsx 的 call 返回空 jsx 且不调 onDone，必须 resolve 为 skip，不许挂死；
 * - D12：cost/stats/theme/allow/deny 的 loadBuiltinCommands 产物都带上了对应门控字段。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommandExecutor } from "@sid-code/cli/command/executor.ts";
import { _resetUsageCache, getUsageScore } from "@sid-code/cli/command/usage-tracking.ts";
import { loadBuiltinCommands } from "@sid-code/cli/command/loaders.ts";
import { canRunDuringStreaming } from "@sid-code/cli/command/streaming-gate.ts";
import { parseSlashCommand } from "@sid-code/cli/command/parser.ts";
import type { UnifiedCommand, CommandContext } from "@sid-code/cli/command/types.ts";

const CTX = {} as CommandContext;

function localCmd(over: Partial<UnifiedCommand> & { name: string }): UnifiedCommand {
  return {
    description: "测试命令",
    type: "local",
    load: async () => ({ call: async () => ({ type: "text", value: "已执行" }) }),
    ...over,
  } as UnifiedCommand;
}

// ── D1 / D2 ────────────────────────────────────────────────
describe("D1/D2 使用频率记账：只记查到且过闸的命令，记 canonical name", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-b2-"));
    prev = process.env.SID_CODE_USAGE_FILE;
    process.env.SID_CODE_USAGE_FILE = join(dir, "command-usage.json");
    _resetUsageCache();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SID_CODE_USAGE_FILE;
    else process.env.SID_CODE_USAGE_FILE = prev;
    _resetUsageCache();
    rmSync(dir, { recursive: true, force: true });
  });

  const stored = (): Record<string, unknown> => {
    const f = process.env.SID_CODE_USAGE_FILE!;
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf-8")) : {};
  };

  test("D1：/m 记到 model 名下，存储里不出现别名 key", async () => {
    const cmds = [localCmd({ name: "model", aliases: ["m"] })];
    const ex = new CommandExecutor(CTX);
    await ex.executeSlashCommand("/m", cmds);
    expect(getUsageScore("model")).toBeGreaterThan(0);
    expect(getUsageScore("m")).toBe(0);
    expect(Object.keys(stored())).toEqual(["model"]);
  });

  test("D2：未知命令 / 路径 passthrough / 被门控拒绝 → 一个 key 都不新增", async () => {
    const cmds = [
      localCmd({ name: "model", aliases: ["m"] }),
      localCmd({ name: "disabled-skill", isEnabled: () => false }),
      localCmd({ name: "internal", userInvocable: false }),
    ];
    const ex = new CommandExecutor(CTX);
    expect((await ex.executeSlashCommand("/xyzabc", cmds)).type).toBe("error");
    expect((await ex.executeSlashCommand("/tmp", cmds)).type).toBe("passthrough");
    expect((await ex.executeSlashCommand("/disabled-skill", cmds)).type).toBe("error");
    expect((await ex.executeSlashCommand("/internal", cmds)).type).toBe("error");
    expect(stored()).toEqual({});
    for (const k of ["xyzabc", "tmp", "disabled-skill", "internal"]) {
      expect(getUsageScore(k)).toBe(0);
    }
  });

  test("executeImmediate 同样记账（记账点在 dispatch 汇聚点，不只覆盖一条入口）", async () => {
    const cmd = localCmd({ name: "cost" });
    await new CommandExecutor(CTX).executeImmediate(cmd, "");
    expect(getUsageScore("cost")).toBeGreaterThan(0);
  });

  test("app.ts 不再在查找之前按原文记账（反漂移）", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/app.ts")).text();
    expect(src).not.toMatch(/recordUsage\s*\(/);
  });
});

// ── D8 ─────────────────────────────────────────────────────
describe("D8 fork 缺 providerRegistry 降级时走 inline 唯一出口", () => {
  function fakeHookSystem() {
    const hooks: unknown[] = [];
    const removed: string[] = [];
    return {
      removed,
      registered: hooks,
      sys: {
        getAllHooks: () => hooks,
        addNormalizedHooks: () => {
          hooks.push({});
          return [];
        },
        removeSkillHooks: (name: string) => {
          removed.push(name);
          return 1;
        },
        fireUserPromptExpansionEvent: async () => ({ finalOutput: undefined }),
      },
    };
  }

  function forkSkillCmd(): UnifiedCommand {
    const skill = {
      name: "demo-fork",
      description: "演示",
      prompt: "按步骤做",
      source: "project",
      filePath: "/test/demo.md",
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "true" }] }] },
    };
    return {
      type: "prompt",
      name: "demo-fork",
      description: "演示",
      source: "skills",
      context: "fork",
      skill,
      getPromptForCommand: async () => "按步骤做",
    } as unknown as UnifiedCommand;
  }

  test("上报 addInvokedSkill，且不卸载 hooks（prompt 已注入主对话）", async () => {
    const invoked: string[] = [];
    const { sys, removed, registered } = fakeHookSystem();
    const ctx = {
      hookSystem: sys,
      ctxMgr: { addInvokedSkill: (n: string) => invoked.push(n) },
      // 带 hooks 的 skill 属敏感能力，authorizeSkill 判 ask；这里同意以走到执行分支
      requestUserConfirmation: async () => true,
    } as unknown as CommandContext;

    const r = await new CommandExecutor(ctx).executeSlashCommand("/demo-fork", [forkSkillCmd()]);
    expect(r.type).toBe("submit_prompt");
    expect(invoked).toEqual(["demo-fork"]);
    expect(registered.length).toBe(1); // hooks 确实注册了，「没被卸载」才不是空断言
    expect(removed).toEqual([]);
  });
});

// ── D13 ────────────────────────────────────────────────────
describe("D13 local-jsx 每条出口都 resolve", () => {
  function jsxCmd(call: (onDone: any) => Promise<unknown>): UnifiedCommand {
    return {
      type: "local-jsx",
      name: "j",
      description: "jsx",
      load: async () => ({ call }),
    } as unknown as UnifiedCommand;
  }
  const race = (p: Promise<unknown>) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r("TIMEOUT"), 300))]);

  const cases: [string, (d: any) => Promise<unknown>, unknown][] = [
    [
      "A 返回 jsx 且随后 onDone",
      async (d) => {
        setTimeout(() => d("ok"), 20);
        return "JSX";
      },
      { type: "message", value: "ok", shouldQuery: false },
    ],
    [
      "B 同步 onDone 无 jsx",
      async (d) => {
        d("sync");
        return null;
      },
      { type: "message", value: "sync", shouldQuery: false },
    ],
    [
      "C 抛异常",
      async () => {
        throw new Error("x");
      },
      { type: "error", message: "命令执行失败: x" },
    ],
    ["D 返回 null 且不调 onDone", async () => null, { type: "skip" }],
  ];

  for (const [label, call, expected] of cases) {
    test(label, async () => {
      const r = await race(new CommandExecutor(CTX).executeSlashCommand("/j", [jsxCmd(call)]));
      expect(r).toEqual(expected);
    });
  }
});

// ── D3 ─────────────────────────────────────────────────────
describe("D3 闸门放行直送的输入，dispatchInput 必然按斜杠命令处理", () => {
  test("前导空白：闸门判定与分发入口的 trim 口径一致", async () => {
    const cmds = [{ name: "model", aliases: ["m"], immediate: true, type: "local" }];
    for (const raw of [" /model opus", "\t/model", "  /m"]) {
      expect(canRunDuringStreaming(raw, cmds)).toBe(true);
      // dispatchInput 入口先 trim，之后按 startsWith("/") 分支
      expect(raw.trim().startsWith("/")).toBe(true);
      expect(parseSlashCommand(raw)).not.toBeNull();
    }
    const src = await Bun.file(join(import.meta.dir, "../../src/ui/App.tsx")).text();
    const body = src.slice(src.indexOf("const dispatchInput = useCallback("));
    expect(body.slice(0, 600)).toMatch(/const text = raw\.trim\(\);/);
  });
});

// ── D12 ────────────────────────────────────────────────────
describe("D12 legacy 内置命令透传门控字段", () => {
  // 与 loaders.ts 的 LEGACY_BUILTIN_GATES 刻意各写一份：命令迁走后两边一起删
  const EXPECTED: Record<string, Record<string, unknown>> = {
    cost: { immediate: true },
    stats: { immediate: true },
    theme: { immediate: true },
    allow: { immediate: true, requiresArgs: true },
    deny: { immediate: true, requiresArgs: true },
  };

  test("这几条 legacy 命令都带上了门控字段", async () => {
    const all = await loadBuiltinCommands();
    for (const [name, gates] of Object.entries(EXPECTED)) {
      const cmd = all.find((c) => c.name === name);
      expect(cmd, `内置命令 /${name} 不存在（迁移后请从表里删掉这条）`).toBeDefined();
      for (const [k, v] of Object.entries(gates)) {
        expect((cmd as any)[k], `/${name}.${k}`).toBe(v);
      }
    }
  });

  test("/allow /deny 流式中可插队，补全回车不直接执行（requiresArgs）", async () => {
    const all = await loadBuiltinCommands();
    for (const n of ["allow", "deny"]) {
      const c = all.find((x) => x.name === n)!;
      expect(c.requiresArgs).toBe(true);
      expect(canRunDuringStreaming(`/${n} Bash(npm *)`, all)).toBe(true);
    }
  });

  test("/add-dir 不标 requiresArgs：无参是合法用法（列出白名单）", async () => {
    const all = await loadBuiltinCommands();
    expect(all.find((x) => x.name === "add-dir")?.requiresArgs).toBeUndefined();
  });
});
