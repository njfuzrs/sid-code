/**
 * D7 / D9：保护命令名在注册表汇聚点对所有非内置来源生效；动态来源合并时别名参与比较。
 *
 * D7 修复前：保护名单只在 CustomCommandLoader 里检查，优先级更高的 Skill 能用 `help`
 * 之类的名字把内置逃生通道整条顶掉，且无任何日志。
 * D9 修复前：插件 / MCP 在 getCommands 里另起一套合并、只比 name 不比别名，
 * 名叫 `q` 的动态命令会劫持 exit 的别名 `/q`。
 */

import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { UnifiedCommandRegistry } from "@sid-code/cli/command/unified-registry.ts";
import type { UnifiedCommand, CommandSource } from "@sid-code/cli/command/types.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { PROTECTED_COMMAND_NAMES } from "@sid-code/core/command-contract/protected-names.ts";

function cmd(name: string, source: CommandSource, aliases: string[] = []): UnifiedCommand {
  return {
    type: "local",
    name,
    description: `${source}:${name}`,
    aliases,
    source,
    load: async () => ({ call: async () => ({ type: "skip" as const }) }),
  } as UnifiedCommand;
}

/** 静态来源按「自定义 > Skills > 内置」顺序注入，与 loadAllCommands 的真实拼接一致 */
class FakeRegistry extends UnifiedCommandRegistry {
  constructor(
    private staticCmds: UnifiedCommand[],
    plugins: UnifiedCommand[] = [],
  ) {
    super();
    (this as any).pluginCommands = plugins;
  }
  async loadAllCommands(): Promise<UnifiedCommand[]> {
    return (this as any).dedupe(this.staticCmds);
  }
}

const builtins = () => [
  cmd("help", "builtin", ["h", "?"]),
  cmd("exit", "builtin", ["quit", "q"]),
  cmd("model", "builtin", ["m"]),
  cmd("config", "builtin"),
];

let warnSpy: ReturnType<typeof spyOn> | null = null;
afterEach(() => warnSpy?.mockRestore());
function captureWarns(): string[] {
  const msgs: string[] = [];
  warnSpy = spyOn(getLogger(), "warn").mockImplementation((_c: string, m: string) => {
    msgs.push(m);
  });
  return msgs;
}

describe("D7 保护名对 Skill 同样生效", () => {
  test("名叫 help 的 skill 不能顶掉内置 /help，且 warn 指认该 skill", async () => {
    const warns = captureWarns();
    const reg = new FakeRegistry([cmd("help", "skill"), ...builtins()]);
    const cmds = await reg.getCommands("/tmp");
    expect(reg.findCommand("help", cmds)?.source).toBe("builtin");
    expect(warns.some((w) => w.includes("保护命令名被忽略") && w.includes("skill"))).toBe(true);
  });

  test("自定义 / plugin / mcp 来源同样被拦（检查点在汇聚点，不在某个 loader）", async () => {
    const reg = new FakeRegistry(
      [cmd("config", "project"), ...builtins()],
      [cmd("clear", "plugin")],
    );
    const cmds = await reg.getCommands("/tmp", [cmd("model", "mcp")]);
    expect(reg.findCommand("config", cmds)?.source).toBe("builtin");
    expect(reg.findCommand("model", cmds)?.source).toBe("builtin");
    expect(cmds.find((c) => c.name === "clear")).toBeUndefined();
  });

  test("非内置命令的别名占保护名 → 只丢该别名，命令本身保留", async () => {
    const reg = new FakeRegistry([cmd("doctor2", "skill", ["q", "dq"]), ...builtins()]);
    const cmds = await reg.getCommands("/tmp");
    const d = cmds.find((c) => c.name === "doctor2")!;
    expect(d.aliases).toEqual(["dq"]);
    expect(reg.findCommand("q", cmds)?.name).toBe("exit");
  });

  test("内置命令不受保护名影响（回归）", async () => {
    const reg = new FakeRegistry(builtins());
    const cmds = await reg.getCommands("/tmp");
    expect(cmds.map((c) => c.name).sort()).toEqual(["config", "exit", "help", "model"]);
  });

  test("名单包含 exit 的别名 q 与 model 的别名 m（UI 层只前置拦截字面 exit/quit）", () => {
    for (const n of ["help", "exit", "quit", "q", "m", "config", "clear"]) {
      expect(PROTECTED_COMMAND_NAMES.has(n)).toBe(true);
    }
  });
});

describe("D9 动态来源合并时别名参与比较", () => {
  // 用非保护名的别名测，避免被 D7 先拦下而测不到 D9 本身
  const staticCmds = () => [cmd("review", "builtin", ["rv"]), ...builtins()];

  test("名叫 rv 的插件命令不能劫持 review 的别名，且有 warn", async () => {
    const warns = captureWarns();
    const reg = new FakeRegistry(staticCmds(), [cmd("rv", "plugin")]);
    const cmds = await reg.getCommands("/tmp");
    expect(reg.findCommand("rv", cmds)?.name).toBe("review");
    expect(warns.some((w) => w.includes("/rv"))).toBe(true);
  });

  test("名叫 q 的 MCP prompt 不能劫持 /q，/q 仍落到 exit", async () => {
    const reg = new FakeRegistry(staticCmds());
    const cmds = await reg.getCommands("/tmp", [cmd("q", "mcp")]);
    expect(reg.findCommand("q", cmds)?.name).toBe("exit");
  });

  test("两个动态来源之间的别名碰撞也被处理", async () => {
    const reg = new FakeRegistry(staticCmds(), [cmd("p:one", "plugin", ["po"])]);
    const cmds = await reg.getCommands("/tmp", [cmd("po", "mcp")]);
    expect(reg.findCommand("po", cmds)?.name).toBe("p:one");
  });

  test("重复 getCommands 不重复刷同一条 warn（补全热路径）", async () => {
    const warns = captureWarns();
    const reg = new FakeRegistry(staticCmds(), [cmd("rv", "plugin")]);
    await reg.getCommands("/tmp");
    await reg.getCommands("/tmp");
    expect(warns.filter((w) => w.includes("/rv")).length).toBe(1);
  });
});
