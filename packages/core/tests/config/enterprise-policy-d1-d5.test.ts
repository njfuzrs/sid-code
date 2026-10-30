/**
 * 企业 policy 五个代码缺陷（核查官网 website/team/policy.md 时发现，2026-10-22）的回归测试。
 *
 * D1：strictPluginOnlyCustomization 锁 hooks / mcp-servers 面时，用户级/项目级照常加载
 * D2：managed-settings.d/*.json 里的 permissions / 模式开关不生效
 * D3：managed 扩展目录写死 /etc，不跟平台策略目录
 * D4：用户可写的 ~/.sid-code/managed/ 后合并，覆盖系统级同名扩展
 * D5：managed 扩展层只接了 skills
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  sidPaths,
  managedSettingsSystemDir,
  LEGACY_MANAGED_EXTENSION_ROOT,
} from "@sid-code/core/config/paths.ts";
import { __setManagedSettingsDropInDirForTest } from "@sid-code/core/config/settings/constants.ts";
import { readManagedPolicyDocument } from "@sid-code/core/config/managed-policy-file.ts";
import { ManagedFileLoader } from "@sid-code/core/config/policy.ts";
import { RuleLoader } from "@sid-code/core/permission/rule-loader.ts";
import { ExtensionLoader } from "@sid-code/core/extension/loader.ts";
import { CustomAgentLoader } from "@sid-code/core/agent/custom.ts";
import { HookRegistry } from "@sid-code/core/hook/registry.ts";
import { HookEventName, ConfigSource } from "@sid-code/core/hook/types.ts";
import { MCPManager, BUILTIN_MCP_SERVER } from "@sid-code/core/mcp/manager.ts";
import {
  setPluginOnlyPolicy,
  __resetPluginOnlyPolicy,
} from "@sid-code/core/config/plugin-only-policy.ts";

let root: string;
let prevSidHome: string | undefined;
let prevClaudeHome: string | undefined;

// 系统级候选在本机存在时，用户级回退那份会被忽略，D2 的用例前提不成立
const systemPolicyExists = existsSync(join(managedSettingsSystemDir(), "managed-settings.json"));

beforeEach(() => {
  root = join(tmpdir(), `ent-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  prevSidHome = process.env.SID_CONFIG_DIR;
  prevClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = join(root, "home", ".sid-code");
  process.env.CLAUDE_CONFIG_DIR = join(root, "home", ".claude");
  mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
  __setManagedSettingsDropInDirForTest(join(root, "managed-settings.d"));
  __resetPluginOnlyPolicy();
});

afterEach(() => {
  if (prevSidHome === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidHome;
  if (prevClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeHome;
  __setManagedSettingsDropInDirForTest(undefined);
  __resetPluginOnlyPolicy();
  rmSync(root, { recursive: true, force: true });
});

function writeDropIn(name: string, body: unknown): void {
  const dir = join(root, "managed-settings.d");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  writeFileSync(f, JSON.stringify(body));
  chmodSync(f, 0o600);
}

describe.skipIf(systemPolicyExists)("D2 drop-in 进入执行企业约束的消费方", () => {
  test("只有 drop-in、没有主文件时，ManagedFileLoader 读到模式开关与限额", async () => {
    writeDropIn("10-team.json", {
      disableBypassPermissionsMode: "disable",
      disabledModes: ["plan"],
    });
    const policy = await new ManagedFileLoader().load();
    expect(policy).not.toBeNull();
    expect(policy!.disableBypassPermissionsMode).toBe("disable");
    expect(policy!.disabledModes).toEqual(["plan"]);
  });

  test("主文件 + drop-in：deny 拼接去重，标量以字母序靠后的 drop-in 为准", () => {
    const main = join(process.env.SID_CONFIG_DIR!, "managed-settings.json");
    writeFileSync(main, JSON.stringify({ permissions: { deny: ["Bash(rm *)"] }, a: 1 }));
    writeDropIn("20-b.json", { a: 3, permissions: { deny: ["Bash(curl *)"] } });
    writeDropIn("10-a.json", { a: 2, permissions: { deny: ["Bash(rm *)"] } });
    const doc = readManagedPolicyDocument()!;
    expect(doc.mainFile).toBe(main);
    expect(doc.settings.a).toBe(3);
    expect((doc.settings.permissions as { deny: string[] }).deny).toEqual([
      "Bash(rm *)",
      "Bash(curl *)",
    ]);
  });

  test("drop-in 里的 permissions.deny 进入 RuleLoader 的 policySettings 层", async () => {
    writeDropIn("10-deny.json", { permissions: { deny: ["Bash(curl *)"] } });
    const loader = new RuleLoader(join(root, "ws"));
    await loader.loadAll();
    const rules = loader.getRulesBySource("policySettings");
    expect(rules.some((r) => r.behavior === "deny" && JSON.stringify(r).includes("curl"))).toBe(
      true,
    );
  });

  test("主文件和 drop-in 都没有时不算部署了本地策略", async () => {
    expect(readManagedPolicyDocument()).toBeNull();
    expect(await new ManagedFileLoader().load()).toBeNull();
  });
});

describe("D3/D4 managed 扩展目录", () => {
  test("系统级目录跟策略文件同一平台目录，且排在最后（同名以系统级为准）", () => {
    const dirs = sidPaths.managedExtensionDirs("skills");
    expect(dirs[dirs.length - 1]).toBe(join(managedSettingsSystemDir(), "skills"));
    expect(dirs[0]).toBe(join(process.env.SID_CONFIG_DIR!, "managed", "skills"));
    if (process.platform === "darwin") {
      expect(dirs).toContain(join(LEGACY_MANAGED_EXTENSION_ROOT, "skills"));
    } else {
      expect(dirs.length).toBe(2);
    }
  });

  test("用户可写的 managed 目录不能覆盖系统级同名 skill", async () => {
    const userManaged = join(root, "user-managed");
    const systemManaged = join(root, "system-managed");
    for (const [dir, desc] of [
      [userManaged, "用户版"],
      [systemManaged, "企业版"],
    ] as const) {
      mkdirSync(join(dir, "shared"), { recursive: true });
      writeFileSync(
        join(dir, "shared", "SKILL.md"),
        `---\nname: shared\ndescription: ${desc}\n---\n内容`,
      );
    }
    // 按 managedExtensionDirs 的顺序传入：用户级在前、系统级在后
    const res = await new ExtensionLoader().scanWithResult("skills", undefined, {
      managedDirs: [userManaged, systemManaged],
    });
    const f = res.files.find((x) => x.name === "shared")!;
    expect(f.filePath.startsWith(systemManaged)).toBe(true);
  });
});

describe("D5 commands / agents 也有 managed 层", () => {
  test("agents 默认注入 managedExtensionDirs('agents')，锁定后仍加载 managed agent", async () => {
    const managedAgents = join(process.env.SID_CONFIG_DIR!, "managed", "agents");
    mkdirSync(managedAgents, { recursive: true });
    writeFileSync(
      join(managedAgents, "ent-agent.md"),
      "---\nname: ent-agent\ndescription: 企业下发\n---\n做事",
    );
    setPluginOnlyPolicy(["agents"]);
    const agents = await new CustomAgentLoader().loadAll(join(root, "ws"));
    const a = agents.find((x) => x.name === "ent-agent");
    expect(a).toBeDefined();
    expect(a!.source).toBe("managed");
  });
});

describe("D1 plugin-only 锁 hooks / mcp-servers 面", () => {
  function addHook(registry: HookRegistry, source: ConfigSource, name: string): void {
    registry.registerHook(
      { type: "command", name, command: `echo ${name}`, source },
      HookEventName.PreToolUse,
      { source },
    );
  }

  test("锁 hooks：只保留 managed / plugin / runtime，用户级与项目级被摘", () => {
    const registry = new HookRegistry();
    addHook(registry, ConfigSource.User, "user");
    addHook(registry, ConfigSource.Project, "project");
    addHook(registry, ConfigSource.Local, "local");
    addHook(registry, ConfigSource.Managed, "managed");
    addHook(registry, ConfigSource.Plugin, "plugin");
    addHook(registry, ConfigSource.Runtime, "runtime");
    expect(registry.getHooksForEvent(HookEventName.PreToolUse).length).toBe(6);

    setPluginOnlyPolicy(["hooks"]);
    const names = registry
      .getHooksForEvent(HookEventName.PreToolUse)
      .map((e) => (e.config as { name?: string }).name)
      .sort();
    expect(names).toEqual(["managed", "plugin", "runtime"]);
  });

  test("只锁 skills 不影响 hooks", () => {
    const registry = new HookRegistry();
    addHook(registry, ConfigSource.User, "user");
    setPluginOnlyPolicy(["skills"]);
    expect(registry.getHooksForEvent(HookEventName.PreToolUse).length).toBe(1);
  });

  test("锁 mcp-servers：settings 来源拒绝，插件作用域与内置 IDE 放行，scope 字段伪造无效", () => {
    const mgr = new MCPManager();
    const passes = (name: string, cfg: object) =>
      (mgr as unknown as { passesPolicy(n: string, c: object): boolean }).passesPolicy(name, cfg);
    const stdio = { transport: "stdio", command: "echo" };

    expect(passes("mine", stdio)).toBe(true);
    setPluginOnlyPolicy(["mcp-servers"]);
    expect(passes("mine", stdio)).toBe(false);
    expect(passes("mine", { ...stdio, scope: "dynamic" })).toBe(false);
    expect(passes("plugin:corp:db", stdio)).toBe(true);
    expect(passes("ide", { transport: "ws", url: "ws://x", [BUILTIN_MCP_SERVER]: true })).toBe(
      true,
    );
  });

  test("true = 锁全部，同样覆盖 hooks 与 mcp-servers", () => {
    setPluginOnlyPolicy(true);
    const registry = new HookRegistry();
    addHook(registry, ConfigSource.User, "user");
    expect(registry.getHooksForEvent(HookEventName.PreToolUse).length).toBe(0);
    const mgr = new MCPManager();
    expect(
      (mgr as unknown as { passesPolicy(n: string, c: object): boolean }).passesPolicy("mine", {
        transport: "stdio",
        command: "echo",
      }),
    ).toBe(false);
  });
});
