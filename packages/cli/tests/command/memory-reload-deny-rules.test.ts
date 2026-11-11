/**
 * /memory reload 必须补传 denyRulesSummary（M4，CG-3）
 *
 * 修复前的行为：`/memory reload` 走的是与启动路径**不同的**一条
 * `buildSystemPrompt` 调用（`memory.ts` 的 reload 分支），它传了 projectRules /
 * memorySystemPrompt / 延迟工具开关，唯独漏了 `denyRulesSummary`。
 * 于是「刷新记忆」这个动作会顺手把「哪些操作必被拒绝」的 `<permission-constraints>`
 * 约束块从系统提示词里抹掉——模型的约束认知回退到「只能靠撞墙发现」，
 * 而 deny 规则本身仍在权限层生效，属于静默退化。
 *
 * 这里断言的是**重建后的提示词里仍有约束块**，而不是「代码里写了这一行」：
 * 后者改了参数名/字段名就会假绿。
 *
 * 落盘隔离：reload 会真实读写记忆目录，SID_CONFIG_DIR 必须指向 tmpdir
 * （getSidHome 每次调用重读 env，无缓存）。存/恢复原值而非 delete——
 * bunfig preload 的兜底会被无条件 delete 一起抹掉。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCommand } from "../../src/command/commands/memory/memory.ts";
import type { CommandContext } from "../../src/command/types.ts";
import { clearPromptCache } from "@sid-code/core/config/system-prompt.ts";

let isolatedHome: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  isolatedHome = mkdtempSync(join(tmpdir(), "mem-reload-deny-"));
  savedConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = isolatedHome;
  // buildSystemPrompt 有 5min 缓存；不清的话同批次前面的用例会把它喂绿。
  clearPromptCache();
});

afterEach(() => {
  if (savedConfigDir === undefined) {
    delete process.env.SID_CONFIG_DIR;
  } else {
    process.env.SID_CONFIG_DIR = savedConfigDir;
  }
  rmSync(isolatedHome, { recursive: true, force: true });
  clearPromptCache();
});

/** 构造 reload 需要的最小 ctx：只提供 reload 分支实际读取的字段。 */
function makeCtx(denyRulesSummary: string | undefined | null) {
  let capturedPrompt = "";
  const ctx = {
    config: {
      permissionMode: "default",
      language: "zh",
      model: "claude-sonnet-4-6",
      availableModels: [],
      teamMemory: undefined,
      toolSearchKeepLoaded: false,
      toolSearch: true,
    },
    toolRegistry: { all: () => [] },
    permissionChecker:
      denyRulesSummary === null
        ? null
        : // 模拟 PermissionChecker 的可选能力（Checker 接口未声明 describeDenyRules，
          // 生产代码同样用 typeof 探测后再调）。
          { describeDenyRules: () => denyRulesSummary ?? "" },
    ctxMgr: {
      recordSendMutationCause: () => {},
      setSystemPrompt: (p: string) => {
        capturedPrompt = p;
      },
    },
  } as unknown as CommandContext;
  return { ctx, getPrompt: () => capturedPrompt };
}

/** 写一条记忆，保证 reload 不会走「记忆为空，无需刷新」提前返回。 */
async function seedMemory(): Promise<void> {
  const { MemoryStore } = await import("@sid-code/core/memory/store.ts");
  const store = new MemoryStore(process.cwd());
  await store.load();
  await store.set("cg3_reload_probe", "让记忆索引非空", "project");
}

describe("/memory reload 补传 denyRulesSummary（M4）", () => {
  test("checker 有 deny 规则时，重建后的系统提示词仍含 <permission-constraints>", async () => {
    await seedMemory();
    const { ctx, getPrompt } = makeCtx("- 禁用工具（调用必被拒绝）：bash");

    const result = await new MemoryCommand().call("reload", ctx);
    const value = (result as { type: string; value: string }).value;

    // 前置：确实走了重建路径，而不是提前返回
    expect(value).toContain("系统提示词已刷新");

    const prompt = getPrompt();
    expect(prompt).toContain("<permission-constraints>");
    expect(prompt).toContain("禁用工具（调用必被拒绝）：bash");
  });

  test("checker 无 deny 规则时不注入空约束块（也不应崩溃）", async () => {
    await seedMemory();
    const { ctx, getPrompt } = makeCtx("");

    const result = await new MemoryCommand().call("reload", ctx);
    expect((result as { value: string }).value).toContain("系统提示词已刷新");
    expect(getPrompt()).not.toContain("<permission-constraints>");
  });

  test("ctx 没有 permissionChecker（headless/测试）时 reload 照常完成", async () => {
    await seedMemory();
    const { ctx, getPrompt } = makeCtx(null);

    const result = await new MemoryCommand().call("reload", ctx);
    expect((result as { value: string }).value).toContain("系统提示词已刷新");
    expect(getPrompt().length).toBeGreaterThan(0);
    expect(getPrompt()).not.toContain("<permission-constraints>");
  });
});
