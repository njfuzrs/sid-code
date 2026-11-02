/**
 * 命令体系收口回归：app 注入的 CommandContext 字段必须原样到达命令实现。
 *
 * 收口前旧命令经 adapter 往返（AppContext → toCommandContext → toAppContext），
 * CommandContext 上没有的 6 个字段在中途被静默丢弃：
 *   - getAutoMemoryState / setAutoMemory → /memory auto 恒报「运行环境未接线」
 *   - getExternalImportsState / setExternalImportsApproved → /memory external 同上
 *   - checkpointSessionId → /undo /restore /checkpoints 在 `-c` 恢复后够不到旧检查点
 *   - skillManager → /reload-plugins 不刷新插件 skill
 * 现在只有一份 CommandContext，没有往返；这里走真实执行路径（CommandExecutor +
 * 真实内置命令表）锁住「注入 = 可见」。在旧 main 上本文件的用例会红。
 */

import { describe, test, expect } from "bun:test";
import { CommandExecutor } from "@sid-code/cli/command/executor.ts";
import { loadBuiltinCommands } from "@sid-code/cli/command/loaders.ts";
import type { CommandContext } from "@sid-code/cli/command/types.ts";

async function run(input: string, ctx: Partial<CommandContext>) {
  const cmds = await loadBuiltinCommands();
  return new CommandExecutor(ctx as CommandContext).executeSlashCommand(input, cmds);
}

const text = (r: unknown) => JSON.stringify(r);

describe("app 注入的字段到达命令实现（无 adapter 往返）", () => {
  test("/memory auto status 读到 getAutoMemoryState", async () => {
    const r = await run("/memory auto status", {
      getAutoMemoryState: () => ({ enabled: true, source: "settings" }),
    });
    expect(text(r)).toContain("已启用");
    expect(text(r)).not.toContain("未接线");
  });

  test("/memory auto off 调到 setAutoMemory", async () => {
    const calls: [boolean, boolean | undefined][] = [];
    await run("/memory auto off", { setAutoMemory: (e, p) => void calls.push([e, p]) });
    expect(calls).toEqual([[false, false]]);
  });

  test("/memory external status 读到 getExternalImportsState", async () => {
    const r = await run("/memory external status", {
      getExternalImportsState: () => ({ approved: false }),
    });
    expect(text(r)).toContain("已禁用");
    expect(text(r)).not.toContain("未接线");
  });

  test("/memory external allow 调到 setExternalImportsApproved", async () => {
    const calls: boolean[] = [];
    await run("/memory external allow", {
      setExternalImportsApproved: (a) => void calls.push(a),
    });
    expect(calls).toEqual([true]);
  });
});
