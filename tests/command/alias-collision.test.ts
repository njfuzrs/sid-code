/**
 * P0-3：别名冲突自检 —— 防回归
 *
 * 加载全部内置命令（走真实 loadBuiltinCommands 路径），断言顶层命令的
 * 名称 + 别名两两不碰撞。以后谁加了重复顶层别名，这条测试红。
 *
 * 说明：子命令别名（如 /mcp list 的 "ls"、/ide status 的 "ls"）是父命令作用域
 * 隔离的，不进顶层命名空间，因此不参与顶层碰撞检测——这里只查顶层。
 */

import { describe, test, expect } from "bun:test";
import { loadBuiltinCommands } from "../../src/command/loaders.ts";
import { UnifiedCommandRegistry } from "../../src/command/unified-registry.ts";
import type { UnifiedCommand } from "../../src/command/types.ts";

describe("P0-3 别名冲突自检", () => {
  test("内置顶层命令名 + 别名无碰撞", async () => {
    const commands = await loadBuiltinCommands();
    const owner = new Map<string, string>(); // token → 首个占用者
    const collisions: string[] = [];

    for (const cmd of commands) {
      // 命令名
      if (owner.has(cmd.name)) {
        collisions.push(`命令名 /${cmd.name} 与 "${owner.get(cmd.name)}" 冲突`);
      } else {
        owner.set(cmd.name, cmd.name);
      }
      // 别名
      for (const alias of cmd.aliases ?? []) {
        const existing = owner.get(alias);
        if (existing && existing !== cmd.name) {
          collisions.push(`别名 /${alias}（来自 "${cmd.name}"）与 "${existing}" 冲突`);
        } else if (!existing) {
          owner.set(alias, cmd.name);
        }
      }
    }

    expect(collisions).toEqual([]);
  });

  test("dedupe 遇重复别名保留先注册者", () => {
    const reg = new UnifiedCommandRegistry();
    const mk = (name: string, aliases: string[]): UnifiedCommand =>
      ({
        type: "local",
        name,
        description: name,
        aliases,
        load: async () => ({ call: async () => ({ type: "skip" as const }) }),
      }) as UnifiedCommand;

    // first 先注册 "x"，second 也想要 "x" → 应被忽略，find("x") 落到 first
    const deduped = (reg as any).dedupe([mk("first", ["x"]), mk("second", ["x"])]);
    expect(reg.findCommand("x", deduped)?.name).toBe("first");
    // 两个命令都保留（只是 second 丢了别名 x）
    expect(deduped.map((c: UnifiedCommand) => c.name).sort()).toEqual(["first", "second"]);
  });
});
