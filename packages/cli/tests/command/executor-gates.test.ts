/**
 * CommandExecutor 门控一致性 + 路径 passthrough 测试（P2-2 / P1-1）。
 *
 * ## P2-2：两个入口的门控必须一致
 *
 * `executeSlashCommand` 在 dispatch 前查两道门（`userInvocable === false` → 拒绝、
 * `isEnabled()` 为假 → 拒绝），而 `executeImmediate` 修复前是**裸 dispatch**，两道全无。
 *
 * 在 `immediate` 未接线的年代那条路径不可达，所以不是活缺陷。但 P0-1 让 immediate
 * 真正生效后它立刻变成活的绕过口：一个被 `/skills` 禁用的 skill、或未触发的条件激活
 * skill，只要标了 immediate 就能按名直呼。`isEnabled` 对 skill 承载两件事
 * （禁用态 + 条件激活 gate），漏掉它就等于用一个缺陷换另一个。
 *
 * 下面刻意**对两个入口跑同一组断言**：门控一致性是这里要锁的不变量，
 * 只测其中一个入口的话，第三个入口出现时同样会漏。
 *
 * ## P1-1：`/tmp` 不该报「未知命令」
 */

import { describe, test, expect } from "bun:test";
import { CommandExecutor } from "@sid-code/cli/command/executor.ts";
import type { UnifiedCommand, CommandContext } from "@sid-code/cli/command/types.ts";

/** 最小 ctx：本文件的用例全部在 dispatch 之前就返回，用不到 ctx 的任何成员。 */
const CTX = {} as CommandContext;

function localCmd(over: Partial<UnifiedCommand> & { name: string }): UnifiedCommand {
  return {
    description: "测试命令",
    type: "local",
    load: async () => ({ call: async () => ({ type: "text", value: "已执行" }) }),
    ...over,
  } as UnifiedCommand;
}

describe("P2-2 门控一致性：两个入口必须给出同样的判定", () => {
  const cases = [
    {
      label: "userInvocable: false → 拒绝",
      cmd: localCmd({ name: "internal", userInvocable: false }),
      expectMessage: /只能由模型调用/,
    },
    {
      label: "isEnabled() 为假 → 拒绝（/skills 禁用态 或 未触发的条件 skill）",
      cmd: localCmd({ name: "gated", isEnabled: () => false }),
      expectMessage: /当前不可用/,
    },
  ];

  for (const c of cases) {
    test(`executeSlashCommand：${c.label}`, async () => {
      const ex = new CommandExecutor(CTX);
      const r = await ex.executeSlashCommand(`/${c.cmd.name}`, [c.cmd]);
      expect(r.type).toBe("error");
      expect((r as { message: string }).message).toMatch(c.expectMessage);
    });

    test(`executeImmediate：${c.label}`, async () => {
      const ex = new CommandExecutor(CTX);
      const r = await ex.executeImmediate(c.cmd, "");
      // 修复前这里会是 dispatch 的结果（命令被执行），而不是 error
      expect(r.type).toBe("error");
      expect((r as { message: string }).message).toMatch(c.expectMessage);
    });
  }

  test("放行的命令：两个入口都能正常执行（门控不误拦）", async () => {
    const cmd = localCmd({ name: "ok", immediate: true });
    const ex = new CommandExecutor(CTX);
    const viaSlash = await ex.executeSlashCommand("/ok", [cmd]);
    const viaImmediate = await ex.executeImmediate(cmd, "");
    expect(viaSlash.type).not.toBe("error");
    expect(viaImmediate.type).not.toBe("error");
  });

  test("isEnabled() 为真时放行（只拦为假的那一侧）", async () => {
    const cmd = localCmd({ name: "enabled", isEnabled: () => true });
    const ex = new CommandExecutor(CTX);
    expect((await ex.executeImmediate(cmd, "")).type).not.toBe("error");
  });
});

describe("P1-1 路径 passthrough：单段真实目录不再报未知命令", () => {
  test("/tmp → passthrough（修复前是「未知命令: /tmp」）", async () => {
    const ex = new CommandExecutor(CTX);
    const r = await ex.executeSlashCommand("/tmp", []);
    expect(r.type).toBe("passthrough");
  });

  test("/xyzabc-not-real → 仍报未知命令（不存在的路径不能放过）", async () => {
    const ex = new CommandExecutor(CTX);
    const r = await ex.executeSlashCommand("/xyzabc-not-real", []);
    expect(r.type).toBe("error");
    expect((r as { message: string }).message).toMatch(/未知命令/);
  });

  test("/var/log/... → passthrough（回归：含 / 的路径一直是对的）", async () => {
    const ex = new CommandExecutor(CTX);
    const r = await ex.executeSlashCommand("/var/log/syslog", []);
    expect(r.type).toBe("passthrough");
  });

  test("真实命令优先于路径判定（命中命令表就不做 stat）", async () => {
    // 假设有人把命令取名叫 tmp：命令查找在前，isFilePath 只在"查不到"时才跑。
    const cmd = localCmd({ name: "tmp" });
    const ex = new CommandExecutor(CTX);
    const r = await ex.executeSlashCommand("/tmp", [cmd]);
    expect(r.type).not.toBe("passthrough");
    expect(r.type).not.toBe("error");
  });
});
