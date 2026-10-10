/**
 * M1 / M2 / M4 回归：.mcp.json 向上查找、禁用当场生效且持久化到私有存储、子目录只审批一次。
 *
 * 变异自证（逐条撤掉修复，对应组必须变红）：
 * - loadProjectMcpServers 改回只读 `join(cwd, ".mcp.json")` → 「M1 向上查找」组红；
 * - disableServer 去掉 `onToolsRefresh`（即改用 disconnect）→ 「M2 禁用」的注册表断言红；
 *   去掉 `disabledConfigs.set` → getStatus 断言红；
 * - loadConfig 审批 key 改回 `process.cwd()` → 「M4 子目录只审批一次」红。
 *
 * 落盘隔离：SID_CONFIG_DIR 指向 tmpdir，测试前后存 / 恢复原值与 cwd。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { MCPManager } from "@sid-code/core/mcp/manager.ts";
import { MCPConnectionStatus } from "@sid-code/core/mcp/types.ts";
import {
  loadProjectMcpServers,
  getDisabledMcpServers,
  toggleMcpServer,
} from "@sid-code/core/mcp/project-files.ts";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";

let ROOT: string;
let prevConfigDir: string | undefined;
let prevCwd: string;

beforeEach(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), "sid-mcp-pf-")));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevCwd = process.cwd();
  process.env.SID_CONFIG_DIR = join(ROOT, "cfg");
  mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(ROOT, { recursive: true, force: true });
});

const writeMcp = (dir: string, servers: Record<string, unknown>) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
};

describe("M1 .mcp.json 从 cwd 向上查找到文件系统根", () => {
  test("深层子目录读到祖先的 server；同名近者覆盖；上界不是 git root", () => {
    const a = join(ROOT, "a");
    const repo = join(a, "repo");
    const deep = join(repo, "b", "c");
    mkdirSync(deep, { recursive: true });
    // repo 是 git root，a 在 git root 之外——CC 仍然会读 a/.mcp.json
    execSync("git init -q", { cwd: repo });
    writeMcp(a, {
      far: { transport: "stdio", command: "far" },
      dup: { transport: "stdio", command: "from-a" },
    });
    writeMcp(repo, { dup: { transport: "stdio", command: "from-repo" } });

    const { servers, sources, files } = loadProjectMcpServers(deep);
    expect(Object.keys(servers).sort()).toEqual(["dup", "far"]);
    expect((servers.dup as MCPServerConfig).command).toBe("from-repo");
    expect(sources.far).toBe(join(a, ".mcp.json"));
    expect(sources.dup).toBe(join(repo, ".mcp.json"));
    // 根 → cwd 顺序
    expect(files.indexOf(join(a, ".mcp.json"))).toBeLessThan(
      files.indexOf(join(repo, ".mcp.json")),
    );
  });

  test("某一层文件损坏只跳过那一层", () => {
    const a = join(ROOT, "x");
    const b = join(a, "y");
    writeMcp(a, { ok: { transport: "stdio", command: "ok" } });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, ".mcp.json"), "{ not json");
    const warns: string[] = [];
    const { servers } = loadProjectMcpServers(b, (m) => warns.push(m));
    expect(Object.keys(servers)).toEqual(["ok"]);
    expect(warns.length).toBe(1);
  });
});

/** 不建真实连接的 manager：connectWithTimeout 直接回一个工具 */
function fakeManager(): { mgr: MCPManager; registry: Map<string, string[]> } {
  const mgr = new MCPManager();
  const registry = new Map<string, string[]>();
  (mgr as any).connectWithTimeout = async (name: string) => [
    { name: `mcp__${name}__echo`, definition: () => ({}) },
  ];
  mgr.onToolsRefresh = (name, tools) => {
    registry.set(
      name,
      tools.map((t: any) => t.name),
    );
  };
  return { mgr, registry };
}

describe("M2 禁用：当场断连 + 注销工具 + 持久化到私有存储（不改 .mcp.json）", () => {
  test("disable → getStatus 为 disabled、工具注销；enable → 恢复", async () => {
    const { mgr, registry } = fakeManager();
    await mgr.addServer("pw", { transport: "stdio", command: "x" } as MCPServerConfig);
    expect(registry.get("pw")).toEqual(["mcp__pw__echo"]);

    expect(await mgr.disableServer("pw")).toBe(true);
    expect(mgr.getStatus().find((s) => s.name === "pw")?.status).toBe(MCPConnectionStatus.DISABLED);
    expect(registry.get("pw")).toEqual([]);
    expect(mgr.isConnected("pw")).toBe(false);

    expect(await mgr.enableServer("pw")).not.toBeNull();
    expect(mgr.getStatus().find((s) => s.name === "pw")?.status).toBe(
      MCPConnectionStatus.CONNECTED,
    );
    expect(registry.get("pw")).toEqual(["mcp__pw__echo"]);
    mgr.closeAll();
  });

  test("toggleMcpServer 写 git-root 键的私有存储；子目录读到同一份；.mcp.json 不变", async () => {
    const repo = join(ROOT, "repo");
    const sub = join(repo, "pkg", "deep");
    mkdirSync(sub, { recursive: true });
    execSync("git init -q", { cwd: repo });
    writeMcp(repo, { pw: { transport: "stdio", command: "x" } });
    const before = readFileSync(join(repo, ".mcp.json"), "utf-8");

    const { mgr } = fakeManager();
    await mgr.addServer("pw", { transport: "stdio", command: "x" } as MCPServerConfig);
    const { statePath, applied } = await toggleMcpServer("pw", true, mgr, sub);
    expect(applied).toBe(true);
    expect(statePath.startsWith(join(ROOT, "cfg"))).toBe(true);
    expect(readFileSync(join(repo, ".mcp.json"), "utf-8")).toBe(before);
    // 仓库根启动读到同一份禁用状态
    expect(await getDisabledMcpServers(repo)).toEqual(["pw"]);

    await toggleMcpServer("pw", false, mgr, repo);
    expect(await getDisabledMcpServers(sub)).toEqual([]);
    mgr.closeAll();
  });

  test("重新加载配置后禁用的 server 进 disabledConfigs（新 manager 仍是 disabled）", async () => {
    const repo = join(ROOT, "repo2");
    mkdirSync(repo, { recursive: true });
    execSync("git init -q", { cwd: repo });
    writeFileSync(
      join(process.env.SID_CONFIG_DIR!, "settings.json"),
      JSON.stringify({ mcpServers: { usr: { transport: "stdio", command: "u" } } }),
    );
    process.chdir(repo);
    await toggleMcpServer("usr", true, undefined, repo);

    const { loadConfig } = await import("@sid-code/core/config/config.ts");
    const cfg = await loadConfig({});
    expect((cfg.mcpServers?.usr as MCPServerConfig | undefined)?.enabled).toBe(false);

    const { mgr } = fakeManager();
    await mgr.connectAll(cfg.mcpServers as Record<string, MCPServerConfig>);
    expect(mgr.getStatus().find((s) => s.name === "usr")?.status).toBe(
      MCPConnectionStatus.DISABLED,
    );
    mgr.closeAll();
  });
});

describe("M4 审批 key 按 git root：子目录审批一次，同仓库其它子目录不再 pending", () => {
  test("在 a/ 批准后，在 b/ 启动不再出现 pending；旧 cwd key 兼容读取", async () => {
    const repo = join(ROOT, "repo3");
    const subA = join(repo, "a");
    const subB = join(repo, "b");
    mkdirSync(subA, { recursive: true });
    mkdirSync(subB, { recursive: true });
    execSync("git init -q", { cwd: repo });
    writeMcp(repo, {
      s1: { transport: "stdio", command: "one" },
      s2: { transport: "stdio", command: "two" },
    });

    const { loadConfig } = await import("@sid-code/core/config/config.ts");
    const approval = await import("@sid-code/core/mcp/approval.ts");

    process.chdir(subA);
    approval.__resetPendingApproval();
    await loadConfig({});
    expect(approval.getPendingApprovalServers().names.sort()).toEqual(["s1", "s2"]);
    expect(approval.approvePendingServer("s1")).toBe(true);

    process.chdir(subB);
    approval.__resetPendingApproval();
    const cfg = await loadConfig({});
    expect(approval.getPendingApprovalServers().names).toEqual(["s2"]);
    expect(cfg.mcpServers?.s1).toBeDefined();

    // 旧版按 cwd 记的 key：升级后仍视为已批准，不重复询问
    approval.approveProjectServer("s2", subB);
    approval.__resetPendingApproval();
    await loadConfig({});
    expect(approval.getPendingApprovalServers().names).toEqual([]);
    // 写入时迁移：对 s2 重新批准后旧 key 被清掉
    approval.approveProjectServer("s2", realpathSync(repo), subB);
    const store = JSON.parse(
      readFileSync(join(process.env.SID_CONFIG_DIR!, "state", "mcp-approvals.json"), "utf-8"),
    );
    expect(store.approved).not.toContain(`${subB}:s2`);
    expect(store.approved).toContain(`${realpathSync(repo)}:s2`);
  });
});
