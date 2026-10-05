/**
 * 企业插件市场客户端端到端（P5）：真实 127.0.0.1 假后端 + 真实落盘（SID_CONFIG_DIR 隔离）。
 *
 * 覆盖：market 列表 / install 校验 sha256 / 包内名不符拒绝 / 401 不退回缓存 / 网络错退回缓存 /
 *       update 比对版本 / 锁定策略（本地拒、市场放、白名单外拒、被改过的市场插件拒）/
 *       plugin_installed 与 setMarketPlugins 接线。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAllPluginCaches } from "@sid-code/cli/plugin/caches.ts";
import { loadAllPlugins, setInlinePluginDirs } from "@sid-code/cli/plugin/loader.ts";
import { installPlugin } from "@sid-code/cli/plugin/operations.ts";
import {
  installFromMarket,
  isMarketSpec,
  listMarket,
  updateFromMarket,
} from "@sid-code/cli/plugin/market-operations.ts";
import { readInstalledPlugins } from "@sid-code/cli/plugin/installed.ts";
import {
  __resetPluginOnlyPolicy,
  setKnownMarketplacesPolicy,
  setPluginOnlyPolicy,
} from "@sid-code/core/config/plugin-only-policy.ts";
import {
  __resetMarketPluginsForTest,
  getPluginMarketplace,
} from "@sid-code/core/analytics/plugin-attribution.ts";
import { attachAnalyticsSink, __resetAnalyticsForTest } from "@sid-code/core/analytics/index.ts";
import type { EventMetadata } from "@sid-code/core/analytics/index.ts";
import { EVENT_NAMES } from "@sid-code/core/analytics/events.ts";
import { __resetIdentityForTest, saveDeviceCredential } from "@sid-code/core/identity/index.ts";
import { pluginPackage } from "./tar-fixture.ts";

interface FakePlugin {
  name: string;
  version: string;
  pkg: Buffer;
  /** 登记在 index 里的 sha256（默认 = pkg 的真实值；测篡改时故意写错） */
  sha256?: string;
}

interface Fake {
  base: string;
  plugins: FakePlugin[];
  indexStatus: number;
  requests: Array<{ path: string; auth: string | null }>;
  stop: () => void;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function startFake(): Fake {
  const fake: Fake = {
    base: "",
    plugins: [],
    indexStatus: 200,
    requests: [],
    stop: () => {},
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      fake.requests.push({ path: url.pathname, auth: req.headers.get("authorization") });
      if (url.pathname === "/api/v1/ctl/marketplace/index") {
        if (fake.indexStatus !== 200) return new Response("x", { status: fake.indexStatus });
        return Response.json({
          schema: 1,
          name: "company",
          plugins: fake.plugins.map((p) => ({
            name: p.name,
            kind: "plugin",
            description: `${p.name} 描述`,
            maintainer: "平台组",
            version: p.version,
            sha256: p.sha256 ?? sha(p.pkg),
            size: p.pkg.length,
            artifact: `artifacts/${p.name}/${p.version}`,
            components: { skills: ["hello"], hooks: ["PreToolUse"], mcpServers: [] },
            versions: [{ version: p.version, sha256: p.sha256 ?? sha(p.pkg), size: p.pkg.length }],
          })),
        });
      }
      const m = url.pathname.match(/^\/api\/v1\/ctl\/marketplace\/artifacts\/([^/]+)\/([^/]+)$/);
      if (m) {
        const p = fake.plugins.find((x) => x.name === m[1] && x.version === m[2]);
        if (!p) return new Response("not found", { status: 404 });
        return new Response(new Uint8Array(p.pkg), {
          headers: { "content-type": "application/gzip" },
        });
      }
      return new Response("?", { status: 404 });
    },
  });
  fake.base = `http://127.0.0.1:${server.port}`;
  fake.stop = () => server.stop(true);
  return fake;
}

let tmp: string;
let prevConfigDir: string | undefined;
let prevBackend: string | undefined;
let fake: Fake;
let events: Array<{ name: string; meta: EventMetadata }>;

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevBackend = process.env.SID_CODE_BACKEND_URL;
  tmp = mkdtempSync(join(tmpdir(), "sid-market-"));
  process.env.SID_CONFIG_DIR = tmp;
  fake = startFake();
  process.env.SID_CODE_BACKEND_URL = fake.base;
  __resetIdentityForTest();
  saveDeviceCredential({ credential: "dev-cred-123" });
  __resetPluginOnlyPolicy();
  __resetMarketPluginsForTest();
  __resetAnalyticsForTest();
  events = [];
  attachAnalyticsSink({ logEvent: (name, meta) => events.push({ name, meta }) });
  setInlinePluginDirs([]);
  clearAllPluginCaches();
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 0));
  fake.stop();
  __resetPluginOnlyPolicy();
  __resetMarketPluginsForTest();
  __resetAnalyticsForTest();
  __resetIdentityForTest();
  setInlinePluginDirs([]);
  clearAllPluginCaches();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (prevBackend === undefined) delete process.env.SID_CODE_BACKEND_URL;
  else process.env.SID_CODE_BACKEND_URL = prevBackend;
  rmSync(tmp, { recursive: true, force: true });
});

function addPlugin(name: string, version: string, opts?: Partial<FakePlugin>): FakePlugin {
  const p: FakePlugin = { name, version, pkg: pluginPackage(name, version), ...opts };
  fake.plugins = fake.plugins.filter((x) => x.name !== name);
  fake.plugins.push(p);
  return p;
}

function makeLocalPlugin(name: string): string {
  const dir = join(tmp, `src-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({ name, version: "1.0.0", description: "本地" }),
  );
  return dir;
}

const pluginDir = (name: string) => join(tmp, "plugins", name);

describe("/plugin market", () => {
  test("列出插件与组件清单，hooks 醒目标注，请求带设备凭据", async () => {
    addPlugin("feishu-docs", "1.0.0");
    const r = await listMarket();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message).toContain("feishu-docs@1.0.0");
    expect(r.message).toContain("⚠ Hooks（会在本机执行命令）：PreToolUse");
    expect(r.message).toContain("/plugin install <name>@company");
    expect(fake.requests[0]!.auth).toBe("Bearer dev-cred-123");
  });

  test("关键词过滤", async () => {
    addPlugin("feishu-docs", "1.0.0");
    addPlugin("jira-sync", "1.0.0");
    const r = await listMarket("jira");
    expect(r.ok && r.message.includes("jira-sync") && !r.message.includes("feishu-docs")).toBe(
      true,
    );
  });

  test("网络 / 5xx 时退回上次缓存（fail-static），401 不退回", async () => {
    addPlugin("feishu-docs", "1.0.0");
    expect((await listMarket()).ok).toBe(true);

    fake.indexStatus = 503;
    const stale = await listMarket();
    expect(stale.ok && stale.message.includes("上次缓存")).toBe(true);

    fake.indexStatus = 401;
    const denied = await listMarket();
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain("sid-code auth login");
  });

  test("未配置 backend.url 时给出可操作的提示", async () => {
    delete process.env.SID_CODE_BACKEND_URL;
    const r = await listMarket();
    expect(!r.ok && r.error.includes("backend.url")).toBe(true);
  });
});

describe("/plugin install <name>@company", () => {
  test("下载 → 校验 → 解包 → 写 installed.json（带 market 段）→ 上报 plugin_installed → 能被加载", async () => {
    addPlugin("feishu-docs", "1.2.0");
    const r = await installFromMarket("feishu-docs@company");
    expect(r.ok).toBe(true);

    expect(existsSync(join(pluginDir("feishu-docs"), "skills", "hello", "SKILL.md"))).toBe(true);
    const entry = (await readInstalledPlugins()).plugins["feishu-docs"]!;
    expect(entry.source).toBe("feishu-docs@company");
    expect(entry.version).toBe("1.2.0");
    expect(entry.market?.name).toBe("company");
    expect(entry.market?.indexUrl).toBe(`${fake.base}/api/v1/ctl/marketplace/index`);
    expect(entry.market?.treeHash).toMatch(/^[0-9a-f]{64}$/);

    const installed = events.filter((e) => e.name === EVENT_NAMES.PLUGIN_INSTALLED);
    expect(installed).toHaveLength(1);
    expect(installed[0]!.meta.plugin_name as unknown).toBe("feishu-docs");
    expect(installed[0]!.meta.install_action as unknown).toBe("install");
    expect(installed[0]!.meta.component_hooks as unknown).toBe(1);

    // 制品下载也带凭据（同源）
    const art = fake.requests.find((q) => q.path.includes("/artifacts/"));
    expect(art?.auth).toBe("Bearer dev-cred-123");

    clearAllPluginCaches();
    const loaded = await loadAllPlugins();
    const p = loaded.enabled.find((x) => x.name === "feishu-docs");
    expect(p?.source).toBe("feishu-docs@company");
    // tool_invoked 归因注册表随加载写入
    expect(getPluginMarketplace("feishu-docs")).toBe("company");
  });

  test("sha256 与 index 不一致：拒绝，插件目录与 installed.json 都没有残留", async () => {
    addPlugin("feishu-docs", "1.0.0", { sha256: "0".repeat(64) });
    const r = await installFromMarket("feishu-docs@company");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("完整性校验失败");
    expect(existsSync(pluginDir("feishu-docs"))).toBe(false);
    expect((await readInstalledPlugins()).plugins["feishu-docs"]).toBeUndefined();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(tmp, "plugins")).filter((n) => n.startsWith(".staging"))).toEqual([]);
  });

  test("包内 plugin.json 的名字与市场登记不符：拒绝", async () => {
    addPlugin("feishu-docs", "1.0.0", { pkg: pluginPackage("something-else", "1.0.0") });
    const r = await installFromMarket("feishu-docs@company");
    expect(!r.ok && r.error.includes("不一致")).toBe(true);
    expect(existsSync(pluginDir("feishu-docs"))).toBe(false);
  });

  test("包内含 .. 条目：拒绝（客户端解包测试）", async () => {
    addPlugin("feishu-docs", "1.0.0", {
      pkg: pluginPackage("feishu-docs", "1.0.0", [{ name: "../../escape", data: "x" }]),
    });
    const r = await installFromMarket("feishu-docs@company");
    expect(!r.ok && r.error.includes("插件包不合规")).toBe(true);
    expect(existsSync(join(tmp, "escape"))).toBe(false);
  });

  test("manifest 用绝对路径声明 hooks：拒绝", async () => {
    addPlugin("feishu-docs", "1.0.0", {
      pkg: pluginPackage("feishu-docs", "1.0.0", [], { hooks: "/etc/evil-hooks.json" }),
    });
    const r = await installFromMarket("feishu-docs@company");
    expect(!r.ok && r.error.includes("相对路径")).toBe(true);
  });

  test("未知市场名 / 市场里没有 / 已安装", async () => {
    addPlugin("feishu-docs", "1.0.0");
    expect((await installFromMarket("feishu-docs@other")).ok).toBe(false);
    expect((await installFromMarket("nope@company")).ok).toBe(false);
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);
    const again = await installFromMarket("feishu-docs@company");
    expect(!again.ok && again.error.includes("/plugin update")).toBe(true);
  });

  test("isMarketSpec 区分市场标识与本地路径", () => {
    expect(isMarketSpec("feishu-docs@company")).toBe(true);
    expect(isMarketSpec("./my-plugin")).toBe(false);
    expect(isMarketSpec("/abs/path@x")).toBe(false);
    expect(isMarketSpec("plain-name")).toBe(false);
    expect(isMarketSpec("x@local")).toBe(false);
  });
});

describe("/plugin update", () => {
  test("index 有新版本时更新；已最新时不动；上报 action=update", async () => {
    addPlugin("feishu-docs", "1.0.0");
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);

    const same = await updateFromMarket();
    expect(same.ok && same.message.includes("已是最新")).toBe(true);

    addPlugin("feishu-docs", "1.10.0");
    const up = await updateFromMarket("feishu-docs");
    expect(up.ok && up.message.includes("1.0.0 → 1.10.0")).toBe(true);
    expect((await readInstalledPlugins()).plugins["feishu-docs"]!.version).toBe("1.10.0");
    const kinds = events
      .filter((e) => e.name === EVENT_NAMES.PLUGIN_INSTALLED)
      .map((e) => e.meta.install_action as unknown);
    expect(kinds).toEqual(["install", "update"]);
  });

  test("新版本校验失败时保留旧版本可用", async () => {
    addPlugin("feishu-docs", "1.0.0");
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);
    addPlugin("feishu-docs", "2.0.0", { sha256: "f".repeat(64) });
    const r = await updateFromMarket("feishu-docs");
    expect(r.ok).toBe(false);
    expect((await readInstalledPlugins()).plugins["feishu-docs"]!.version).toBe("1.0.0");
    expect(existsSync(join(pluginDir("feishu-docs"), "plugin.json"))).toBe(true);
  });

  test("本地插件不能 update", async () => {
    expect((await installPlugin(makeLocalPlugin("mine"))).ok).toBe(true);
    const r = await updateFromMarket("mine");
    expect(!r.ok && r.error.includes("不是从市场安装")).toBe(true);
  });
});

describe("锁定后只认市场来源", () => {
  test("未锁定：本地插件照常安装与加载", async () => {
    expect((await installPlugin(makeLocalPlugin("mine"))).ok).toBe(true);
    clearAllPluginCaches();
    expect((await loadAllPlugins()).enabled.some((p) => p.name === "mine")).toBe(true);
  });

  test("strictPluginOnlyCustomization：本地目录安装被拒；已装的本地插件与 --plugin-dir 不加载；市场插件照常", async () => {
    // 先在未锁定时装好一个本地插件和一个市场插件（模拟「锁定前就有的」）
    expect((await installPlugin(makeLocalPlugin("mine"))).ok).toBe(true);
    addPlugin("feishu-docs", "1.0.0");
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);

    setPluginOnlyPolicy(true);
    const refused = await installPlugin(makeLocalPlugin("another"));
    expect(!refused.ok && refused.error.includes("只允许从企业插件市场安装")).toBe(true);

    setInlinePluginDirs([makeLocalPlugin("inline-one")]);
    clearAllPluginCaches();
    const r = await loadAllPlugins();
    const names = r.enabled.map((p) => p.name);
    expect(names).toContain("feishu-docs");
    expect(names).not.toContain("mine");
    expect(names).not.toContain("inline-one");
    const blocked = r.errors.filter((e) => e.type === "policy-blocked").map((e) => e.source);
    expect(blocked).toContain("mine@local");
    expect(blocked.some((s) => s.endsWith("@inline"))).toBe(true);
    // 被拒的不进归因表
    expect(getPluginMarketplace("mine")).toBeUndefined();
  });

  test("市场插件装好后被改了内容（往里塞 hooks.json）：锁定时拒绝加载", async () => {
    addPlugin("feishu-docs", "1.0.0");
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);
    writeFileSync(
      join(pluginDir("feishu-docs"), "hooks.json"),
      JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: "curl evil" }] }] }),
    );
    setPluginOnlyPolicy(true);
    clearAllPluginCaches();
    const r = await loadAllPlugins();
    expect(r.enabled.some((p) => p.name === "feishu-docs")).toBe(false);
    expect(
      r.errors.some((e) => e.type === "policy-blocked" && e.source === "feishu-docs@company"),
    ).toBe(true);
  });

  test("手改 installed.json 给本地目录挂 market 段：指纹对不上，拒绝", async () => {
    expect((await installPlugin(makeLocalPlugin("mine"))).ok).toBe(true);
    const file = join(tmp, "plugins", "installed.json");
    const reg = JSON.parse(readFileSync(file, "utf-8"));
    reg.plugins.mine.market = {
      name: "company",
      indexUrl: `${fake.base}/api/v1/ctl/marketplace/index`,
      sha256: "0".repeat(64),
      treeHash: "0".repeat(64),
    };
    writeFileSync(file, JSON.stringify(reg));
    setPluginOnlyPolicy(true);
    clearAllPluginCaches();
    const r = await loadAllPlugins();
    expect(r.enabled.some((p) => p.name === "mine")).toBe(false);
  });

  test("strictKnownMarketplaces 白名单：在内放行，不在内拒绝安装与加载；空数组禁一切非内置", async () => {
    addPlugin("feishu-docs", "1.0.0");
    const indexUrl = `${fake.base}/api/v1/ctl/marketplace/index`;

    setKnownMarketplacesPolicy([{ source: "url", url: `${indexUrl}/` }]);
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);
    clearAllPluginCaches();
    expect((await loadAllPlugins()).enabled.some((p) => p.name === "feishu-docs")).toBe(true);

    setKnownMarketplacesPolicy([{ source: "url", url: "https://other.example.com/index" }]);
    clearAllPluginCaches();
    expect((await loadAllPlugins()).enabled.some((p) => p.name === "feishu-docs")).toBe(false);
    const r = await installFromMarket("feishu-docs@company");
    expect(!r.ok && r.error.includes("白名单")).toBe(true);

    setKnownMarketplacesPolicy([]);
    clearAllPluginCaches();
    const empty = await loadAllPlugins();
    expect(empty.enabled.filter((p) => !p.isBuiltin)).toEqual([]);
  });

  test("锁定且无白名单：只信本机 backend.url 推出的市场", async () => {
    addPlugin("feishu-docs", "1.0.0");
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);
    setPluginOnlyPolicy(["skills"]);
    clearAllPluginCaches();
    expect((await loadAllPlugins()).enabled.some((p) => p.name === "feishu-docs")).toBe(true);

    // 换了 backend.url：原来那个市场装的插件不再被信任
    process.env.SID_CODE_BACKEND_URL = "https://another-company.example.com/traj";
    clearAllPluginCaches();
    expect((await loadAllPlugins()).enabled.some((p) => p.name === "feishu-docs")).toBe(false);
  });
});
