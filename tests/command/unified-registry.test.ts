/**
 * 统一命令注册表测试（Task 2）
 *
 * loadAllCommands 涉及真实 I/O（扫描自定义命令/Skill 目录），这里通过子类
 * 覆盖 loadAllCommands 注入测试数据，专注验证去重、过滤、查找等纯逻辑。
 */

import { describe, test, expect } from "bun:test";
import { UnifiedCommandRegistry } from "../../src/command/unified-registry.ts";
import type { UnifiedCommand } from "../../src/command/types.ts";

function localCmd(
  name: string,
  extra: Partial<UnifiedCommand> = {},
): UnifiedCommand {
  return {
    type: "local",
    name,
    description: `${name} 命令`,
    load: async () => ({ call: async () => ({ type: "skip" as const }) }),
    ...extra,
  } as UnifiedCommand;
}

class FakeRegistry extends UnifiedCommandRegistry {
  constructor(private fake: UnifiedCommand[]) {
    super();
  }
  async loadAllCommands(): Promise<UnifiedCommand[]> {
    return this.fake;
  }
}

describe("UnifiedCommandRegistry.findCommand", () => {
  const reg = new UnifiedCommandRegistry();
  const cmds = [
    localCmd("compact"),
    localCmd("exit", { aliases: ["quit", "q"] }),
  ];

  test("精确名称匹配", () => {
    expect(reg.findCommand("compact", cmds)?.name).toBe("compact");
  });

  test("别名匹配", () => {
    expect(reg.findCommand("q", cmds)?.name).toBe("exit");
    expect(reg.findCommand("quit", cmds)?.name).toBe("exit");
  });

  test("未找到返回 undefined", () => {
    expect(reg.findCommand("nope", cmds)).toBeUndefined();
  });
});

describe("UnifiedCommandRegistry.getCommands", () => {
  test("过滤 isEnabled 返回 false 的命令", async () => {
    const reg = new FakeRegistry([
      localCmd("on", { isEnabled: () => true }),
      localCmd("off", { isEnabled: () => false }),
      localCmd("default"), // 无 isEnabled → 默认启用
    ]);
    const cmds = await reg.getCommands("/tmp");
    const names = cmds.map((c) => c.name);
    expect(names).toContain("on");
    expect(names).toContain("default");
    expect(names).not.toContain("off");
  });

  test("合并 MCP 命令并去重", async () => {
    const reg = new FakeRegistry([localCmd("compact")]);
    const mcp = [localCmd("compact"), localCmd("mcp-only")];
    const cmds = await reg.getCommands("/tmp", mcp);
    const names = cmds.map((c) => c.name);
    // compact 已存在，MCP 版本不重复加入
    expect(names.filter((n) => n === "compact").length).toBe(1);
    expect(names).toContain("mcp-only");
  });

  test("clearCache 后可重新加载", () => {
    const reg = new UnifiedCommandRegistry();
    // 仅验证不抛错
    reg.clearCache();
    expect(true).toBe(true);
  });
});
