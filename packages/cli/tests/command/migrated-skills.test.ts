/**
 * 内置 Skill 下沉方案 P4：旧命令名的迁移提示
 *
 * 验收（方案 §9 P4）：升级后敲旧命令看到迁移提示，锁定和未锁定两种文案。
 * 走的是真实 CommandExecutor.executeSlashCommand（与 TUI 同一入口），不是只测纯函数——
 * 只测 getMigratedSkillHint 的话，executor 里忘了接线也照样全绿。
 *
 * 变异自证（2026-10-14 实测）：
 * - executor.ts 里 getMigratedSkillHint 换成 null → 5 红（含锁定 / 未锁定 / 删除项，全部退回「未知命令」）；
 * - 文案分支恒走「可装」→ 2 红（锁定无白名单、officialMarketplace:false 两格给出一条装不上的命令）。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../../src/command/executor.ts";
import { getMigratedSkillHint, isMigratedSkillInput } from "../../src/command/migrated-skills.ts";
import type { CommandContext, UnifiedCommand } from "../../src/command/types.ts";
import {
  __resetPluginOnlyPolicy,
  setKnownMarketplacesPolicy,
  setPluginOnlyPolicy,
} from "@sid-code/core/config/plugin-only-policy.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";

const BACKEND = "https://backend.example.com";
const OFFICIAL = "https://www.sid-code.cc/plugins/index.json";

let tmp: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["SID_CONFIG_DIR", "SID_CODE_BACKEND_URL", "SID_CODE_OFFICIAL_MARKET_URL"];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "sid-migrated-skills-"));
  process.env.SID_CONFIG_DIR = tmp;
  process.env.SID_CODE_BACKEND_URL = BACKEND;
  delete process.env.SID_CODE_OFFICIAL_MARKET_URL;
  resetSettingsCache();
  __resetPluginOnlyPolicy();
});

afterEach(() => {
  __resetPluginOnlyPolicy();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetSettingsCache();
  rmSync(tmp, { recursive: true, force: true });
});

async function run(input: string, commands: UnifiedCommand[] = []) {
  const executor = new CommandExecutor({} as CommandContext);
  return executor.executeSlashCommand(input, commands);
}

describe("旧命令迁移提示（真实 executor 入口）", () => {
  test("未锁定：给官方市场的安装命令与新调用名", async () => {
    const r = await run("/security-audit");
    expect(r.type).toBe("error");
    const msg = (r as { message: string }).message;
    expect(msg).toContain("/plugin install compliance@sid-code");
    expect(msg).toContain("/compliance:security-audit");
    expect(msg).not.toContain("未知命令");
  });

  test("锁定且无白名单：官方被拒 → 让管理员在企业市场上架", async () => {
    setPluginOnlyPolicy(true);
    const msg = ((await run("/ci-self-heal")) as { message: string }).message;
    expect(msg).toContain("联系管理员在企业市场上架 ops");
    expect(msg).toContain("/ops:ci-heal");
    expect(msg).not.toContain("/plugin install");
  });

  test("锁定但白名单列了官方：仍给官方安装命令", async () => {
    setKnownMarketplacesPolicy([
      { source: "url", url: `${BACKEND}/api/v1/ctl/marketplace/index` },
      { source: "url", url: OFFICIAL },
    ]);
    const msg = ((await run("/pr-comments")) as { message: string }).message;
    expect(msg).toContain("/plugin install github-pr@sid-code");
    expect(msg).toContain("/github-pr:comments");
  });

  test("officialMarketplace:false 关掉官方：按不可装处理", async () => {
    writeFileSync(join(tmp, "settings.json"), JSON.stringify({ officialMarketplace: false }));
    resetSettingsCache();
    const msg = ((await run("/code-governance")) as { message: string }).message;
    expect(msg).toContain("/compliance:governance");
    expect(msg).not.toContain("/plugin install");
  });

  test("删除项：说明替代做法", async () => {
    const a = ((await run("/commit-push-pr")) as { message: string }).message;
    expect(a).toContain("已移除");
    expect(a).toContain("/pr-workflow");
    const b = ((await run("/bug-fix")) as { message: string }).message;
    expect(b).toContain("已移除");
  });

  test("用户 / 项目自己定义了同名命令时，用他们的，不给迁移提示", async () => {
    const own = {
      type: "local",
      name: "security-audit",
      description: "自定义",
      userInvocable: true,
      load: async () => ({ call: async () => ({ type: "text", value: "mine" }) }),
    } as unknown as UnifiedCommand;
    const r = await run("/security-audit", [own]);
    expect(r.type).not.toBe("error");
  });

  test("isMigratedSkillInput：只认整条输入就是一个旧命令（TUI 补全回车不能替用户执行 /commit）", () => {
    expect(isMigratedSkillInput("/commit-push-pr")).toBe(true);
    expect(isMigratedSkillInput("  /security-audit ")).toBe(true);
    expect(isMigratedSkillInput("/commit")).toBe(false);
    expect(isMigratedSkillInput("/commit-push-pr 带参数")).toBe(false);
    expect(isMigratedSkillInput("commit-push-pr")).toBe(false);
    // 原型链键不能被当成表项
    expect(isMigratedSkillInput("/constructor")).toBe(false);
    expect(getMigratedSkillHint("constructor")).toBeNull();
  });

  test("不在表里的名字照常报未知命令", async () => {
    expect(getMigratedSkillHint("definitely-not-a-skill")).toBeNull();
    const msg = ((await run("/definitely-not-a-skill")) as { message: string }).message;
    expect(msg).toContain("未知命令");
  });

  test("迁移提示表到期提醒：过了期限就该删掉这张表", () => {
    // 到期后这条红是预期的：删 migrated-skills.ts 与 executor 里那段接线，再删本文件。
    // 期限写在源文件头注释里（只给测试用的导出会被 command-system-gate 判成死导出）。
    const src = readFileSync(
      join(import.meta.dir, "../../src/command/migrated-skills.ts"),
      "utf-8",
    );
    const deadline = /REMOVE_AFTER: (\d{4}-\d{2}-\d{2})/.exec(src)?.[1];
    expect(deadline).toBeDefined();
    expect(new Date().toISOString().slice(0, 10) <= deadline!).toBe(true);
  });
});
