/**
 * Hook 对齐 CC · 批 1：加载与格式（HC1 / HC2 / HC3 / HC4 / HC5 / HC6）
 *
 * 判据：
 *   - CC 嵌套形状与 sid 平铺形状产出完全相同的注册结果（不变量，§六 判据 2）
 *   - 混写、未知事件、内部事件、mcp_tool、坏条目都有点名诊断，不让整个文件失效
 *   - 项目级 / 本地 hooks 按真实来源加载、按事件追加；信任门只摘不可信层
 *   - skill / agent / plugin 走同一个归一化层，字段不再丢
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { normalizeHooksConfig } from "@sid-code/core/hook/config-normalize.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { ConfigSource, HookEventName } from "@sid-code/core/hook/types.ts";
import { USER_HOOK_HANDLER_TYPES } from "@sid-code/core/hook/handler-types.ts";
import { validateConfig } from "@sid-code/core/config/schema.ts";
import { collectHookLayers } from "@sid-code/core/config/hook-layers.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";
import { registerAgentHooks } from "@sid-code/core/agent/agent-hooks.ts";

const strip = (entries: ReturnType<typeof normalizeHooksConfig>["entries"]) =>
  entries.map((e) => ({ ...e }));

describe("批 1 · 归一化层：两种形状等价", () => {
  test("CC 嵌套与 sid 平铺产出相同的注册项", () => {
    const nested = normalizeHooksConfig(
      {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "x.sh", timeout: 5, env: { A: "1" } }],
          },
        ],
      },
      ConfigSource.User,
    );
    const flat = normalizeHooksConfig(
      {
        PreToolUse: [
          { type: "command", matcher: "Bash", command: "x.sh", timeout: 5, env: { A: "1" } },
        ],
      },
      ConfigSource.User,
    );
    expect(nested.diagnostics).toEqual([]);
    expect(flat.diagnostics).toEqual([]);
    expect(strip(nested.entries)).toEqual(strip(flat.entries));
    expect(nested.entries[0]!.matcher).toBe("Bash");
  });

  test("同一事件数组里混写两种形状都注册", () => {
    const r = normalizeHooksConfig(
      {
        PostToolUse: [
          { matcher: "Edit|Write", hooks: [{ command: "a" }, { command: "b" }] },
          { command: "c", matcher: "read" },
        ],
      },
      ConfigSource.User,
    );
    expect(r.entries.map((e) => (e.config as { command: string }).command)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("if 写在 handler 上（CC）或条目上（sid）都下沉到注册项", () => {
    const r = normalizeHooksConfig(
      {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "a", if: "Bash(git *)" }] },
          { matcher: "Bash", if: "Bash(rm *)", command: "b" },
        ],
      },
      ConfigSource.User,
    );
    expect(r.entries.map((e) => e.if)).toEqual(["Bash(git *)", "Bash(rm *)"]);
  });

  test("sequential / async / args / statusMessage 透传", () => {
    const r = normalizeHooksConfig(
      {
        Stop: [
          {
            sequential: true,
            hooks: [
              {
                command: "node",
                args: ["x.js"],
                async: true,
                asyncRewake: true,
                statusMessage: "跑测试",
              },
            ],
          },
        ],
      },
      ConfigSource.User,
    );
    const e = r.entries[0]!;
    expect(e.sequential).toBe(true);
    expect(e.config).toMatchObject({
      type: "command",
      command: "node",
      args: ["x.js"],
      async: true,
      asyncRewake: true,
      statusMessage: "跑测试",
    });
  });

  test("http 落成 url；mcp_tool 识别但 warn 跳过，不影响同文件其它 hook", () => {
    const r = normalizeHooksConfig(
      {
        PreToolUse: [
          {
            hooks: [
              { type: "http", url: "http://127.0.0.1:1/h" },
              { type: "mcp_tool", server: "s", tool: "t" },
              { type: "command", command: "ok" },
            ],
          },
        ],
      },
      ConfigSource.User,
    );
    expect(r.entries.map((e) => e.config.type)).toEqual(["url", "command"]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]!.level).toBe("warn");
    expect(r.diagnostics[0]!.path).toBe("hooks.PreToolUse[0].hooks[1].type");
  });

  test("handler 类型名单包含 http / mcp_tool（HC5）", () => {
    expect(USER_HOOK_HANDLER_TYPES).toContain("http");
    expect(USER_HOOK_HANDLER_TYPES).toContain("mcp_tool");
  });

  test("未知事件 / 内部事件 / 无法识别的条目各有点名诊断", () => {
    const r = normalizeHooksConfig(
      {
        Nope: [{ command: "a" }],
        BeforeHookExecution: [{ command: "b" }],
        PreToolUse: [{ matcher: "Bash" }],
      },
      ConfigSource.Project,
    );
    expect(r.entries).toEqual([]);
    const byPath = Object.fromEntries(r.diagnostics.map((d) => [d.path, d]));
    expect(byPath["hooks.Nope"]!.level).toBe("warn");
    expect(byPath["hooks.BeforeHookExecution"]!.message).toContain("内部事件");
    expect(byPath["hooks.PreToolUse[0]"]!.level).toBe("error");
    expect(r.diagnostics.every((d) => d.source === ConfigSource.Project)).toBe(true);
  });

  test("validateConfig 不再对 CC 嵌套形状误报「必须指定 command」", () => {
    const r = validateConfig({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] },
    } as never);
    expect(r.errors.filter((e) => e.path.startsWith("hooks"))).toEqual([]);
  });
});

describe("批 1 · 注册：所有来源走同一层", () => {
  test("settings 嵌套形状注册成功、带真实 source", () => {
    const sys = new HookSystem();
    sys.initializeFromSources([
      {
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "u" }] }] },
        source: ConfigSource.User,
      },
      {
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "p" }] }] },
        source: ConfigSource.Project,
      },
      { hooks: { PreToolUse: [{ command: "l" }] }, source: ConfigSource.Local },
    ]);
    const all = sys.getAllHooks();
    expect(all.map((h) => h.source).sort()).toEqual([
      ConfigSource.Local,
      ConfigSource.Project,
      ConfigSource.User,
    ]);
  });

  test("重新初始化保留插件与 runtime 来源", () => {
    const sys = new HookSystem();
    sys.replacePluginHooks([
      { name: "p", hooks: { Stop: [{ hooks: [{ command: "plug" }] }] }, pluginRoot: "/p" },
    ]);
    sys.initializeFromSources([{ hooks: { Stop: [{ command: "u" }] }, source: ConfigSource.User }]);
    sys.initializeFromSources([]);
    expect(sys.getAllHooks().map((h) => h.source)).toEqual([ConfigSource.Plugin]);
  });

  test("插件 hook 不再往命令串里替换路径，路径变量带在 pathVars 上", () => {
    const sys = new HookSystem();
    sys.replacePluginHooks([
      {
        name: "demo",
        hooks: {
          PostToolUse: [{ matcher: "Write", hooks: [{ command: "${CLAUDE_PLUGIN_ROOT}/x.sh" }] }],
        },
        pluginRoot: "/opt/demo",
        pluginData: "/data/demo",
      },
    ]);
    const cfg = sys.getAllHooks()[0]!.config;
    expect(cfg.type).toBe("command");
    if (cfg.type !== "command") return;
    expect(cfg.command).toBe("${CLAUDE_PLUGIN_ROOT}/x.sh");
    expect(cfg.pathVars).toMatchObject({
      CLAUDE_PLUGIN_ROOT: "/opt/demo",
      PLUGIN_ROOT: "/opt/demo",
      CLAUDE_PLUGIN_DATA: "/data/demo",
    });
  });

  test("agent frontmatter 不再丢 if / env / url", () => {
    const sys = new HookSystem();
    const n = registerAgentHooks(sys, "rev", {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ command: "a", if: "Bash(git *)", env: { K: "v" } }] },
        { hooks: [{ type: "http", url: "http://127.0.0.1:1/h" }] },
      ],
    });
    expect(n).toBe(2);
    const [a, b] = sys.getAllHooks();
    expect(a!.if).toBe("Bash(git *)");
    expect(a!.config).toMatchObject({ type: "command", env: { K: "v" }, name: "agent:rev" });
    expect(b!.config.type).toBe("url");
    expect(sys.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(2);
  });
});

describe("批 1 · 按来源收集 hooks 层（HC1）", () => {
  let home: string;
  let ws: string;
  const prev = process.env.SID_CONFIG_DIR;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sid-hc1-home-"));
    ws = mkdtempSync(join(tmpdir(), "sid-hc1-ws-"));
    process.env.SID_CONFIG_DIR = home;
    resetSettingsCache();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prev;
    resetSettingsCache();
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  test("用户 / 项目 / 本地三层都收集，项目层标不可信，${VAR} 不在 sid 进程里展开", () => {
    const cmd = "${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh";
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ command: "u" }] } }),
    );
    mkdirSync(join(ws, ".sid-code"));
    writeFileSync(
      join(ws, ".sid-code", "settings.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }] },
      }),
    );
    writeFileSync(
      join(ws, ".sid-code", "settings.local.json"),
      JSON.stringify({ hooks: { Stop: [{ command: "l" }] } }),
    );
    const prevEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = "/outer-cc-session";
    try {
      const layers = collectHookLayers(ws);
      const bySource = Object.fromEntries(layers.map((l) => [l.source, l]));
      expect(Object.keys(bySource).sort()).toEqual(["local", "project", "user"]);
      expect(bySource.project!.untrusted).toBe(true);
      // ws 不是 git 仓库 → local 未被追踪 → 可信
      expect(bySource.local!.untrusted).toBe(false);
      expect(bySource.user!.untrusted).toBe(false);
      const raw = JSON.stringify(bySource.project!.hooks);
      expect(raw).toContain("${CLAUDE_PROJECT_DIR}");
      expect(raw).not.toContain("/outer-cc-session");
    } finally {
      if (prevEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prevEnv;
    }
  });

  test("信任门只摘不可信层：用户级照常注册（HC2）", () => {
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ command: "u" }] } }),
    );
    mkdirSync(join(ws, ".sid-code"));
    writeFileSync(
      join(ws, ".sid-code", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ command: "p" }] } }),
    );
    const layers = collectHookLayers(ws);
    // 模拟 cli.ts 信任门：只给 untrusted 层打标
    for (const l of layers) if (l.untrusted) l.skippedByTrust = true;
    const sys = new HookSystem();
    sys.initializeFromSources(
      layers
        .filter((l) => !l.skippedByTrust)
        .map((l) => ({ hooks: l.hooks, source: l.source as ConfigSource })),
    );
    expect(sys.getAllHooks().map((h) => (h.config as { command: string }).command)).toEqual(["u"]);
  });
});
