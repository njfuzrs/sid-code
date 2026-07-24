/**
 * 命令来源加载器测试
 *
 * 重点回归：loadSkillCommands 里 bundled Skill 也必须 honor disabledSkills。
 * 历史 bug——bundled Skill（/simplify /verify /commit /pr* 等）无条件合并，
 * 从不参与 disabledSkills 过滤，导致「禁用 bundled skill」是空操作。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillCommands } from "../../src/command/loaders.ts";

// 空临时目录作 cwd：无磁盘 Skill 干扰，只看 bundled 合并/过滤行为。
function emptyCwd(): string {
  return mkdtempSync(join(tmpdir(), "sid-loaders-"));
}

describe("loadSkillCommands — bundled 遵守 disabledSkills", () => {
  test("未禁用时 bundled skill（simplify）在列表中", async () => {
    const cmds = await loadSkillCommands(emptyCwd());
    const names = cmds.map((c) => c.name);
    expect(names).toContain("simplify");
  });

  test("禁用后 bundled skill 被过滤掉（大小写不敏感）", async () => {
    const cmds = await loadSkillCommands(emptyCwd(), undefined, ["Simplify"]);
    const names = cmds.map((c) => c.name);
    expect(names).not.toContain("simplify");
    // 其余 bundled skill 不受影响
    expect(names).toContain("verify");
  });
});
