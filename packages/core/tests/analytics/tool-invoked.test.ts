/**
 * 漏斗 10 · tool_invoked / plugin_installed：按企业市场插件计调用次数。
 *
 * 覆盖：
 *  - 注册表命中才发；本地插件 / 用户自配 MCP / 内置工具 / 非插件 skill 不发
 *  - MCP 与 skill 两条路径
 *  - 字段闭集（不带参数内容），且不走 `_PROTECTED_` 通道
 *  - 主循环、子代理两条执行器路径都计到，且同一次调用只发一条
 *  - MCP 归因用的是原始 serverName（`plugin:<plugin>:<server>`），不从规范化名反推
 *
 * 隔离：内存 Sink + SID_CONFIG_DIR 指向 tmpdir（CONTRIBUTING「测试约定」），
 * MCP 走真实 MCPManager + stdio 子进程 mock server（真实入口，不是手搓适配器）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_NAMES, logPluginInstalled } from "@sid-code/core/analytics/events.ts";
import {
  attachAnalyticsSink,
  __resetAnalyticsForTest,
  type EventMetadata,
} from "@sid-code/core/analytics/index.ts";
import { PROTECTED_PREFIX } from "@sid-code/core/analytics/privacy.ts";
import {
  setMarketPlugins,
  __resetMarketPluginsForTest,
  mcpPluginOrigin,
  skillPluginOrigin,
} from "@sid-code/core/analytics/plugin-attribution.ts";
import { MCPManager } from "@sid-code/core/mcp/manager.ts";
import { SkillMetaTool, SKILL_TOOL_NAME } from "@sid-code/core/skill/meta-tool.ts";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";
import { executeTools as executeMainLoopTools } from "@sid-code/core/query/tool-executor.ts";
import { executeTools as executeSubAgentTools } from "@sid-code/core/agent/tool-executor.ts";
import type { ContentBlock, ToolUseBlock } from "@sid-code/core/llm/types.ts";

const TOOL_INVOKED_FIELDS = [
  "plugin_name",
  "plugin_marketplace",
  "plugin_component",
  "plugin_tool",
  "tool_name",
].sort();

type Seen = Array<{ name: string; meta: EventMetadata }>;

function capture(): Seen {
  const seen: Seen = [];
  attachAnalyticsSink({ logEvent: (name, meta) => seen.push({ name, meta }) });
  return seen;
}

const invoked = (seen: Seen) => seen.filter((e) => e.name === EVENT_NAMES.TOOL_INVOKED);

let tmpDir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-tool-invoked-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  __resetAnalyticsForTest();
  __resetMarketPluginsForTest();
});

afterEach(async () => {
  // 先让 import().then() 类的落盘微任务跑干，再恢复 env（CONTRIBUTING 坑 2）
  await new Promise((r) => setTimeout(r, 0));
  __resetAnalyticsForTest();
  __resetMarketPluginsForTest();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// 纯函数：来源解析
// ─────────────────────────────────────────────────────────────

describe("来源解析", () => {
  test("MCP：从原始 serverName 精确解析插件名，插件名里的 _ / - 不产生歧义", () => {
    expect(mcpPluginOrigin("plugin:my_tool-kit:srv_a", "do_thing")).toEqual({
      pluginName: "my_tool-kit",
      component: "mcp",
      pluginTool: "do_thing",
    });
    // 服务器名里再有 `:` 也只切第一个（插件名不含 `:`）
    expect(mcpPluginOrigin("plugin:acme:a:b", "t")?.pluginName).toBe("acme");
  });

  test("MCP：非插件作用域 / 形态残缺一律返回 undefined", () => {
    expect(mcpPluginOrigin("my-private-server", "t")).toBeUndefined();
    expect(mcpPluginOrigin("plugin:", "t")).toBeUndefined();
    expect(mcpPluginOrigin("plugin:acme", "t")).toBeUndefined();
    expect(mcpPluginOrigin("plugin:acme:", "t")).toBeUndefined();
    expect(mcpPluginOrigin("plugin::srv", "t")).toBeUndefined();
  });

  test("skill：只认 loadedFrom=plugin，名字取定义上的 `<plugin>:<skill>`", () => {
    expect(skillPluginOrigin({ name: "acme:review", loadedFrom: "plugin" })).toEqual({
      pluginName: "acme",
      component: "skill",
      pluginTool: "review",
    });
    // 用户自己写了个带冒号的 skill：不是插件来源，不归因
    expect(skillPluginOrigin({ name: "acme:review", loadedFrom: "skills" })).toBeUndefined();
    expect(skillPluginOrigin({ name: "acme:review" })).toBeUndefined();
    expect(skillPluginOrigin({ name: "noprefix", loadedFrom: "plugin" })).toBeUndefined();
  });

  test("setMarketPlugins 是整表替换：重载后被移除的插件不再归因", async () => {
    const seen = capture();
    const mgr = managerWith([pluginSkill("acme:review")]);
    const tool = new SkillMetaTool(mgr, {} as any, {} as any);

    setMarketPlugins([{ name: "acme", marketplace: "company" }]);
    await tool.execute({ skill: "acme:review" });
    setMarketPlugins([]); // 模拟 /reload-plugins 后插件被卸
    await tool.execute({ skill: "acme:review" });

    expect(invoked(seen)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// Skill 路径
// ─────────────────────────────────────────────────────────────

function pluginSkill(name: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name,
    description: "插件 skill",
    prompt: "执行插件工作流",
    source: "project",
    loadedFrom: "plugin",
    mode: "activate",
    filePath: "/plugins/x/skills/s/SKILL.md",
    ...overrides,
  };
}

function managerWith(skills: SkillDefinition[]): SkillManager {
  const m = new SkillManager();
  // @ts-expect-error 测试直接注入内部 skills，避免磁盘 discover
  m.skills = skills;
  return m;
}

describe("Skill 路径", () => {
  test("市场插件 skill：发一条，字段齐全、无参数内容、不走 _PROTECTED_", async () => {
    setMarketPlugins([{ name: "acme", marketplace: "company" }]);
    const seen = capture();
    const tool = new SkillMetaTool(managerWith([pluginSkill("acme:review")]), {} as any, {} as any);

    const res = await tool.execute({ skill: "acme:review", args: "SECRET-ARG-请勿上报" });
    expect(res.isError).toBe(false);

    const evs = invoked(seen);
    expect(evs).toHaveLength(1);
    const meta = evs[0]!.meta;
    expect(Object.keys(meta).sort()).toEqual(TOOL_INVOKED_FIELDS);
    expect(meta).toEqual({
      plugin_name: "acme",
      plugin_marketplace: "company",
      plugin_component: "skill",
      plugin_tool: "review",
      tool_name: SKILL_TOOL_NAME,
    } as any);
    const json = JSON.stringify(meta);
    expect(json).not.toContain("SECRET-ARG");
    expect(json).not.toContain(PROTECTED_PREFIX);
  });

  test("模型输入大小写与登记名不同，归因仍用登记名", async () => {
    setMarketPlugins([{ name: "acme", marketplace: "company" }]);
    const seen = capture();
    const tool = new SkillMetaTool(managerWith([pluginSkill("acme:review")]), {} as any, {} as any);
    await tool.execute({ skill: "ACME:Review" });
    expect(invoked(seen)[0]!.meta.plugin_tool).toBe("review");
  });

  test("本地安装的插件（同形但不在市场注册表）：不发", async () => {
    setMarketPlugins([{ name: "acme", marketplace: "company" }]);
    const seen = capture();
    const tool = new SkillMetaTool(
      managerWith([pluginSkill("local-kit:review")]),
      {} as any,
      {} as any,
    );
    const res = await tool.execute({ skill: "local-kit:review" });
    expect(res.isError).toBe(false); // 调用本身成功，只是不归因
    expect(invoked(seen)).toHaveLength(0);
  });

  test("非插件来源的 skill（哪怕名字前缀撞上市场插件名）：不发", async () => {
    setMarketPlugins([{ name: "acme", marketplace: "company" }]);
    const seen = capture();
    const tool = new SkillMetaTool(
      managerWith([pluginSkill("acme:review", { loadedFrom: "skills" })]),
      {} as any,
      {} as any,
    );
    await tool.execute({ skill: "acme:review" });
    expect(invoked(seen)).toHaveLength(0);
  });

  test("权限拒绝的调用不计（没用上）", async () => {
    setMarketPlugins([{ name: "acme", marketplace: "company" }]);
    const seen = capture();
    const tool = new SkillMetaTool(managerWith([pluginSkill("acme:review")]), {} as any, {} as any);
    tool.setPermissionRules({ deny: ["Skill(acme:review)"], allow: [], ask: [] });
    const res = await tool.execute({ skill: "acme:review" });
    expect(res.isError).toBe(true);
    expect(invoked(seen)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// MCP 路径（真实 MCPManager + stdio mock server）
// ─────────────────────────────────────────────────────────────

/** 最小 MCP server：echo 正常返回，boom 返回 isError（验证失败调用也计数） */
function writeMockServer(dir: string): string {
  const script = `
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\\n");
  buf = lines.pop() || "";
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let msg;
    try { msg = JSON.parse(t); } catch { continue; }
    if (!("id" in msg)) continue;
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2024-11-05", capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "0.0.1" } }});
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "echo", description: "echo", annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: { text: { type: "string" } } } },
        { name: "boom", description: "fails", annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} } },
      ]}});
    } else if (msg.method === "tools/call") {
      if (msg.params?.name === "boom") {
        send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "boom" }] }});
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + (msg.params?.arguments?.text ?? "") }] }});
      }
    } else if (msg.method === "ping") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } });
    }
  }
});
`;
  const file = join(dir, "mock-mcp-server.mjs");
  writeFileSync(file, script);
  return file;
}

describe("MCP 路径", () => {
  let mgr: MCPManager | undefined;

  afterEach(() => {
    try {
      mgr?.closeAll();
    } catch {}
    mgr = undefined;
  });

  async function connect(serverName: string) {
    mgr = new MCPManager();
    const tools = await mgr.addServer(serverName, {
      transport: "stdio",
      command: process.execPath,
      args: [writeMockServer(tmpDir)],
      timeout: 10000,
    });
    const byName = new Map(tools.map((t) => [t.name(), t]));
    const find = (raw: string) => tools.find((t) => t.name().endsWith(`__${raw}`))!;
    return { tools, byName, find };
  }

  test("市场插件 MCP 工具：成功与失败调用各发一条，字段齐全、无参数", async () => {
    setMarketPlugins([{ name: "acme_kit-2", marketplace: "company" }]);
    const { find } = await connect("plugin:acme_kit-2:files");
    const seen = capture();

    const ok = await find("echo").execute({ text: "SECRET-ARG-请勿上报" });
    expect(ok.isError).toBeFalsy();
    const bad = await find("boom").execute({});
    expect(bad.isError).toBe(true);

    const evs = invoked(seen);
    expect(evs).toHaveLength(2);
    for (const e of evs) {
      expect(Object.keys(e.meta).sort()).toEqual(TOOL_INVOKED_FIELDS);
      expect(e.meta.plugin_name).toBe("acme_kit-2");
      expect(e.meta.plugin_marketplace).toBe("company");
      expect(e.meta.plugin_component).toBe("mcp");
      expect(e.meta.tool_name).toBe("mcp_tool");
      expect(JSON.stringify(e.meta)).not.toContain("SECRET-ARG");
      expect(JSON.stringify(e.meta)).not.toContain(PROTECTED_PREFIX);
    }
    // plugin_tool 是服务器内原始工具名，不是 mcp__... 规范化名
    expect(evs.map((e) => e.meta.plugin_tool)).toEqual(["echo", "boom"]);
  });

  test("用户自配 MCP（非 plugin: 作用域）：不发", async () => {
    setMarketPlugins([{ name: "acme", marketplace: "company" }]);
    const { find } = await connect("acme");
    const seen = capture();
    await find("echo").execute({ text: "x" });
    expect(invoked(seen)).toHaveLength(0);
  });

  test("本地插件 MCP（plugin: 作用域但不在市场注册表）：不发", async () => {
    setMarketPlugins([{ name: "acme", marketplace: "company" }]);
    const { find } = await connect("plugin:local-kit:files");
    const seen = capture();
    await find("echo").execute({ text: "x" });
    expect(invoked(seen)).toHaveLength(0);
  });

  test("主循环执行器：同一次调用只发一条 tool_invoked（与 tool_call 一比一）", async () => {
    setMarketPlugins([{ name: "acme", marketplace: "company" }]);
    const { byName, find } = await connect("plugin:acme:files");
    const echoName = find("echo").name();
    const seen = capture();

    const block: ToolUseBlock = {
      type: "tool_use",
      id: "m1",
      name: echoName,
      input: { text: "x" },
    };
    const mainRes = await executeMainLoopTools([block], {
      config: { checkpoint: { enabled: false } } as any,
      toolRegistry: {
        get: (n: string) => byName.get(n) ?? null,
        isDeferred: () => false,
        isActivated: () => true,
        isToolSearchEnabled: () => false,
      } as any,
      sessionState: {
        sessionId: "test-session",
        addToolDuration: () => {},
        recordToolResult: () => {},
      } as any,
      hookSystem: {
        firePreToolUseEvent: async () => ({ finalOutput: undefined }),
        firePostToolUseEvent: async () => ({ finalOutput: undefined }),
        firePostToolUseFailureEvent: async () => ({ finalOutput: undefined }),
      } as any,
      permissionChecker: null,
      preToolUseCache: new Map(),
      getAbortSignal: () => undefined,
      requestUserConfirmation: async () => false,
    } as any);
    expect((mainRes as any).results[0].is_error).toBeFalsy();

    expect(invoked(seen)).toHaveLength(1);
    expect(seen.filter((e) => e.name === EVENT_NAMES.TOOL_CALL)).toHaveLength(1);
  });

  test("子代理执行器：调用也计到，且同一次调用只发一条", async () => {
    setMarketPlugins([{ name: "acme", marketplace: "company" }]);
    const { byName, find } = await connect("plugin:acme:files");
    const echoName = find("echo").name();
    const seen = capture();

    const block = {
      type: "tool_use",
      id: "s1",
      name: echoName,
      input: { text: "x" },
    } as ContentBlock;
    await executeSubAgentTools(
      [block],
      { get: (n: string) => byName.get(n) ?? null } as any,
      undefined,
      undefined,
      { check: async () => ({ allowed: true }) } as any,
    );

    expect(invoked(seen)).toHaveLength(1);
    expect(seen.filter((e) => e.name === EVENT_NAMES.TOOL_CALL)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// plugin_installed
// ─────────────────────────────────────────────────────────────

describe("plugin_installed", () => {
  test("字段闭集，数字字段是 number，不走 _PROTECTED_", () => {
    const seen = capture();
    logPluginInstalled({
      pluginName: "acme",
      marketplace: "company",
      version: "1.2.3",
      action: "update",
      components: { skills: 2, commands: 1, agents: 0, hooks: 3, mcpServers: 1 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe(EVENT_NAMES.PLUGIN_INSTALLED);
    expect(seen[0]!.meta).toEqual({
      plugin_name: "acme",
      plugin_marketplace: "company",
      plugin_version: "1.2.3",
      install_action: "update",
      component_skills: 2,
      component_commands: 1,
      component_agents: 0,
      component_hooks: 3,
      component_mcp_servers: 1,
    } as any);
    expect(JSON.stringify(seen[0]!.meta)).not.toContain(PROTECTED_PREFIX);
  });
});
