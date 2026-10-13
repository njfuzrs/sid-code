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
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";
import { resolveMarkets, isMarketAutoUpdate } from "@sid-code/cli/plugin/market.ts";
import { runPluginAutoUpdate } from "@sid-code/cli/plugin/auto-update.ts";
import { evaluatePluginOrigin } from "@sid-code/core/config/plugin-only-policy.ts";

interface FakePlugin {
  name: string;
  version: string;
  pkg: Buffer;
  /** 登记在 index 里的 sha256（默认 = pkg 的真实值；测篡改时故意写错） */
  sha256?: string;
  /** index 里登记的组件清单（默认 skills:hello + hooks:PreToolUse） */
  components?: Record<string, unknown> | null;
}

interface Fake {
  base: string;
  plugins: FakePlugin[];
  indexStatus: number;
  /** 官方静态市场（/plugins/index.json，制品带 .tar.gz），P2 多市场用 */
  official: FakePlugin[];
  officialStatus: number;
  requests: Array<{ path: string; auth: string | null }>;
  stop: () => void;
}

const DEFAULT_COMPONENTS = { skills: ["hello"], hooks: ["PreToolUse"], mcpServers: [] };

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function startFake(): Fake {
  const fake: Fake = {
    base: "",
    plugins: [],
    indexStatus: 200,
    official: [],
    officialStatus: 200,
    requests: [],
    stop: () => {},
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      fake.requests.push({ path: url.pathname, auth: req.headers.get("authorization") });
      if (url.pathname === "/plugins/index.json") {
        if (fake.officialStatus !== 200) return new Response("x", { status: fake.officialStatus });
        return Response.json({
          schema: 1,
          name: "sid-code",
          plugins: fake.official.map((p) => ({
            name: p.name,
            kind: "skill",
            description: `${p.name} 官方`,
            version: p.version,
            sha256: p.sha256 ?? sha(p.pkg),
            size: p.pkg.length,
            artifact: `artifacts/${p.name}/${p.version}.tar.gz`,
            ...(p.components === null ? {} : { components: p.components ?? { skills: ["hello"] } }),
            versions: [{ version: p.version, sha256: p.sha256 ?? sha(p.pkg), size: p.pkg.length }],
          })),
        });
      }
      const om = url.pathname.match(/^\/plugins\/artifacts\/([^/]+)\/([^/]+)\.tar\.gz$/);
      if (om) {
        const p = fake.official.find((x) => x.name === om[1] && x.version === om[2]);
        if (!p) return new Response("not found", { status: 404 });
        return new Response(new Uint8Array(p.pkg), {
          headers: { "content-type": "application/gzip" },
        });
      }
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
            ...(p.components === null ? {} : { components: p.components ?? DEFAULT_COMPONENTS }),
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
let prevOfficial: string | undefined;
let fake: Fake;
let events: Array<{ name: string; meta: EventMetadata }>;

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevBackend = process.env.SID_CODE_BACKEND_URL;
  tmp = mkdtempSync(join(tmpdir(), "sid-market-"));
  process.env.SID_CONFIG_DIR = tmp;
  fake = startFake();
  process.env.SID_CODE_BACKEND_URL = fake.base;
  // 官方市场指向同一个假后端的 /plugins/（P2 默认注册官方市场；不覆盖就会真的去连 sid-code.cc）
  prevOfficial = process.env.SID_CODE_OFFICIAL_MARKET_URL;
  process.env.SID_CODE_OFFICIAL_MARKET_URL = `${fake.base}/plugins/index.json`;
  resetSettingsCache();
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
  if (prevOfficial === undefined) delete process.env.SID_CODE_OFFICIAL_MARKET_URL;
  else process.env.SID_CODE_OFFICIAL_MARKET_URL = prevOfficial;
  resetSettingsCache();
  rmSync(tmp, { recursive: true, force: true });
});

/** 写用户级 settings.json（SID_CONFIG_DIR 已隔离）并清缓存 */
function writeUserSettings(s: Record<string, unknown>): void {
  writeFileSync(join(tmp, "settings.json"), JSON.stringify(s));
  resetSettingsCache();
}

function addOfficial(name: string, version: string, opts?: Partial<FakePlugin>): FakePlugin {
  const p: FakePlugin = { name, version, pkg: pluginPackage(name, version), ...opts };
  fake.official = fake.official.filter((x) => x.name !== name);
  fake.official.push(p);
  return p;
}

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

  // P2 起默认同时注册官方市场：单市场语义（401 → ok:false）改为用 --market 显式指定
  test("网络 / 5xx 时退回上次缓存（fail-static），401 不退回", async () => {
    addPlugin("feishu-docs", "1.0.0");
    const company = { market: "company" };
    expect((await listMarket(undefined, company)).ok).toBe(true);

    fake.indexStatus = 503;
    const stale = await listMarket(undefined, company);
    expect(stale.ok && stale.message.includes("上次缓存")).toBe(true);

    fake.indexStatus = 401;
    const denied = await listMarket(undefined, company);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain("sid-code auth login");

    // 多市场时一个市场 401 不拖垮整个列表：官方市场照常展示，企业段落标 ✗
    const all = await listMarket();
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.message).toContain("官方插件市场 sid-code");
      expect(all.message).toContain("✗");
    }
  });

  test("未配置 backend.url：官方市场仍可用；连官方也关掉时给出可操作的提示", async () => {
    delete process.env.SID_CODE_BACKEND_URL;
    addOfficial("compliance", "1.0.0");
    const r = await listMarket();
    expect(r.ok && r.message.includes("compliance@1.0.0")).toBe(true);

    writeUserSettings({ officialMarketplace: false });
    const none = await listMarket();
    expect(!none.ok && none.error.includes("backend.url")).toBe(true);
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

// ─── 内置 Skill 下沉方案 P2：多市场 ─────────────────────────────────────

describe("P2 多市场：注册与命名", () => {
  test("默认注册企业 + 官方两个市场，顺序固定；officialMarketplace:false 可关", () => {
    expect(resolveMarkets().map((m) => [m.name, m.kind])).toEqual([
      ["company", "company"],
      ["sid-code", "official"],
    ]);
    writeUserSettings({ officialMarketplace: false });
    expect(resolveMarkets().map((m) => m.name)).toEqual(["company"]);
  });

  test("extraKnownMarketplaces：保留名 / 非 url 源 / 明文地址 / 与已有市场同地址 一律丢弃", () => {
    writeUserSettings({
      extraKnownMarketplaces: {
        team: { source: { source: "url", url: "https://team.example.com/plugins/index.json" } },
        "sid-code": { source: { source: "url", url: "https://evil.example.com/i.json" } },
        company: { source: { source: "url", url: "https://evil.example.com/j.json" } },
        gh: { source: { source: "github", repo: "x/y" } },
        plain: { source: { source: "url", url: "http://plain.example.com/i.json" } },
        dup: { source: { source: "url", url: `${fake.base}/plugins/index.json/` } },
      },
    });
    const ms = resolveMarkets();
    expect(ms.map((m) => m.name)).toEqual(["company", "sid-code", "team"]);
    // 保留名没有被冒充：官方市场地址仍是官方的
    expect(ms.find((m) => m.name === "sid-code")!.indexUrl).toBe(`${fake.base}/plugins/index.json`);
  });

  test("项目级 settings 不能加市场、不能开自动更新（SECURITY_SENSITIVE_FIELDS）", async () => {
    const { filterProjectSettings } = await import("@sid-code/core/config/settings/security.ts");
    const out = filterProjectSettings({
      extraKnownMarketplaces: { x: { source: { source: "url", url: "https://x.example.com/i" } } },
      officialMarketplace: false,
      pluginMarketplaceAutoUpdate: { company: true },
      model: "m",
    } as never) as Record<string, unknown>;
    expect(out.extraKnownMarketplaces).toBeUndefined();
    expect(out.officialMarketplace).toBeUndefined();
    expect(out.pluginMarketplaceAutoUpdate).toBeUndefined();
    expect(out.model).toBe("m");
  });

  test("多个市场时 install 必须写 @市场名；未知市场名列出已注册市场", async () => {
    const r = await installFromMarket("feishu-docs@nowhere");
    expect(!r.ok && r.error.includes("company / sid-code")).toBe(true);
  });
});

describe("P2 多市场：官方市场安装", () => {
  test("compliance@sid-code：静态 .tar.gz 制品，官方市场请求永不带设备凭据", async () => {
    addOfficial("compliance", "1.0.0");
    const r = await installFromMarket("compliance@sid-code");
    expect(r.ok).toBe(true);
    const entry = (await readInstalledPlugins()).plugins.compliance!;
    expect(entry.source).toBe("compliance@sid-code");
    expect(entry.market?.name).toBe("sid-code");
    expect(entry.market?.indexUrl).toBe(`${fake.base}/plugins/index.json`);
    const official = fake.requests.filter((q) => q.path.startsWith("/plugins/"));
    expect(official.length).toBeGreaterThanOrEqual(2);
    // 官方市场与企业后端同源（测试里都在 127.0.0.1），凭据也不能跟过去
    expect(official.every((q) => q.auth === null)).toBe(true);

    clearAllPluginCaches();
    const loaded = await loadAllPlugins();
    expect(loaded.enabled.find((p) => p.name === "compliance")?.source).toBe("compliance@sid-code");
  });

  test("指定历史版本：用 versions[i].artifact，缺省时由当前地址替换版本段（保留 .tar.gz）", async () => {
    const { pickVersion } = await import("@sid-code/cli/plugin/market-operations.ts");
    const base = {
      name: "ops",
      version: "1.2.0",
      sha256: "a".repeat(64),
      size: 1,
      artifact: "artifacts/ops/1.2.0.tar.gz",
      versions: [
        { version: "1.2.0", sha256: "a".repeat(64), size: 1 },
        { version: "1.1.0", sha256: "b".repeat(64), size: 1 },
        { version: "1.0.0", sha256: "c".repeat(64), size: 1, artifact: "artifacts/ops/old.tgz" },
      ],
    };
    expect(pickVersion(base, "1.1.0")!.artifact).toBe("artifacts/ops/1.1.0.tar.gz");
    expect(pickVersion(base, "1.0.0")!.artifact).toBe("artifacts/ops/old.tgz");
    expect(pickVersion(base, "9.9.9")).toBeNull();
  });
});

describe("P2 多市场：同名插件不互相覆盖", () => {
  test("已从企业市场装了 feishu-docs，再从官方装同名：拒绝，企业那份原样保留", async () => {
    addPlugin("feishu-docs", "1.0.0");
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);
    const before = (await readInstalledPlugins()).plugins["feishu-docs"]!;

    addOfficial("feishu-docs", "9.0.0");
    const r = await installFromMarket("feishu-docs@sid-code");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("已从市场 company 安装了同名插件");
      expect(r.error).toContain("/plugin uninstall feishu-docs");
    }
    const after = (await readInstalledPlugins()).plugins["feishu-docs"]!;
    expect(after).toEqual(before);
    // 拒绝发生在下载之前：官方制品一次都没被请求
    expect(fake.requests.some((q) => q.path.startsWith("/plugins/artifacts/"))).toBe(false);
  });

  test("market 列表里标注同名插件来自另一个市场", async () => {
    addPlugin("feishu-docs", "1.0.0");
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);
    addOfficial("feishu-docs", "9.0.0");
    const r = await listMarket(undefined, { market: "sid-code" });
    expect(r.ok && r.message.includes("[同名插件已从 company 安装]")).toBe(true);
  });

  test("update 回各自的安装来源：官方有更高版本的同名插件，也不会把企业那份换掉", async () => {
    addPlugin("feishu-docs", "1.0.0");
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);
    addOfficial("feishu-docs", "9.0.0");
    const r = await updateFromMarket("feishu-docs");
    expect(r.ok && r.message.includes("已是最新")).toBe(true);
    expect((await readInstalledPlugins()).plugins["feishu-docs"]!.market?.name).toBe("company");
  });
});

describe("P2 多市场：按市场隔离缓存", () => {
  test("两个市场交替拉 index 后，各自的缓存仍命中（fail-static 对两个市场都成立）", async () => {
    addPlugin("feishu-docs", "1.0.0");
    addOfficial("compliance", "1.0.0");
    // 交替拉三轮：共用一个缓存文件时，每次都会被另一个市场的 indexUrl 校验作废
    for (let i = 0; i < 3; i++) {
      expect((await listMarket(undefined, { market: "company" })).ok).toBe(true);
      expect((await listMarket(undefined, { market: "sid-code" })).ok).toBe(true);
    }
    const cacheDir = join(tmp, "plugins", ".market-cache");
    expect(existsSync(join(cacheDir, "company.json"))).toBe(true);
    expect(existsSync(join(cacheDir, "sid-code.json"))).toBe(true);

    fake.indexStatus = 503;
    fake.officialStatus = 503;
    const c = await listMarket(undefined, { market: "company" });
    const o = await listMarket(undefined, { market: "sid-code" });
    expect(c.ok && c.message.includes("上次缓存") && c.message.includes("feishu-docs")).toBe(true);
    expect(o.ok && o.message.includes("上次缓存") && o.message.includes("compliance")).toBe(true);
  });

  test("市场名取本机配置而不是 index 自报：官方 index 自称 company 也写进 sid-code 的缓存", async () => {
    addOfficial("compliance", "1.0.0");
    expect((await listMarket(undefined, { market: "sid-code" })).ok).toBe(true);
    const cached = JSON.parse(
      readFileSync(join(tmp, "plugins", ".market-cache", "sid-code.json"), "utf-8"),
    );
    expect(cached.indexUrl).toBe(`${fake.base}/plugins/index.json`);
    expect(existsSync(join(tmp, "plugins", ".market-cache", "company.json"))).toBe(false);
  });
});

/**
 * 两个市场 × 锁定判定表（方案 §6.3）。
 *
 * 变异自证（P2 PR 里实测过，见 Agent Note）：
 * - 格 A「锁定无白名单 → 官方被拒」：把 plugin-only-policy.ts evaluatePluginOrigin 末尾的
 *   `fallback === url` 改成 `true`（= 锁定时放行任意市场）→ 本表 A 格与下面的 A 端到端用例变红。
 * - 格 B「白名单只写官方 → 企业被拒」：把 `knownMarketplaces.includes(url)` 改成
 *   `knownMarketplaces.includes(url) || url === fallback`（= 白名单外回退到 backend.url 市场）
 *   → 本表 B 格与 B 端到端用例变红。
 */
describe("P2 多市场 × 锁定判定表", () => {
  const COMPANY = () => `${fake.base}/api/v1/ctl/marketplace/index`;
  const OFFICIAL = () => `${fake.base}/plugins/index.json`;
  const decide = (url: string) =>
    evaluatePluginOrigin({ kind: "market", indexUrl: url }, COMPANY()).allowed;

  type Row = { label: string; setup: () => void; company: boolean; official: boolean };
  const rows: Row[] = [
    { label: "未锁定", setup: () => {}, company: true, official: true },
    {
      label: "A 锁定无白名单 → 只信企业，官方被拒",
      setup: () => setPluginOnlyPolicy(["skills"]),
      company: true,
      official: false,
    },
    {
      label: "B 白名单只写官方 → 企业被拒（不回退 backend.url）",
      setup: () => setKnownMarketplacesPolicy([{ source: "url", url: OFFICIAL() }]),
      company: false,
      official: true,
    },
    {
      label: "白名单只写企业 → 官方被拒",
      setup: () => setKnownMarketplacesPolicy([{ source: "url", url: COMPANY() }]),
      company: true,
      official: false,
    },
    {
      label: "白名单同时写两个 → 都放行",
      setup: () =>
        setKnownMarketplacesPolicy([
          { source: "url", url: COMPANY() },
          { source: "url", url: OFFICIAL() },
        ]),
      company: true,
      official: true,
    },
    {
      label: "空白名单 → 都拒",
      setup: () => setKnownMarketplacesPolicy([]),
      company: false,
      official: false,
    },
  ];
  for (const row of rows) {
    test(row.label, () => {
      row.setup();
      expect({ company: decide(COMPANY()), official: decide(OFFICIAL()) }).toEqual({
        company: row.company,
        official: row.official,
      });
    });
  }

  test("A 端到端：锁定无白名单时 compliance@sid-code 安装被拒，已装的官方插件不加载", async () => {
    addOfficial("compliance", "1.0.0");
    expect((await installFromMarket("compliance@sid-code")).ok).toBe(true);
    setPluginOnlyPolicy(true);
    const r = await installFromMarket("ops@sid-code");
    expect(!r.ok && r.error.includes("不是本机 backend.url 对应的企业市场")).toBe(true);
    clearAllPluginCaches();
    const loaded = await loadAllPlugins();
    expect(loaded.enabled.some((p) => p.name === "compliance")).toBe(false);
    expect(
      loaded.errors.some((e) => e.type === "policy-blocked" && e.source === "compliance@sid-code"),
    ).toBe(true);
  });

  test("B 端到端：白名单只写官方时企业市场安装被拒、已装企业插件不加载，官方照常", async () => {
    addPlugin("feishu-docs", "1.0.0");
    addOfficial("compliance", "1.0.0");
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);
    setKnownMarketplacesPolicy([{ source: "url", url: OFFICIAL() }]);
    expect((await installFromMarket("compliance@sid-code")).ok).toBe(true);
    addPlugin("jira-sync", "1.0.0");
    const r = await installFromMarket("jira-sync@company");
    expect(!r.ok && r.error.includes("白名单")).toBe(true);
    clearAllPluginCaches();
    const names = (await loadAllPlugins()).enabled.map((p) => p.name);
    expect(names).toContain("compliance");
    expect(names).not.toContain("feishu-docs");
  });
});

describe("P2 按市场自动更新", () => {
  test("默认值：官方开、企业关；pluginMarketplaceAutoUpdate 按名覆盖", () => {
    expect(isMarketAutoUpdate({ name: "sid-code", kind: "official" })).toBe(true);
    expect(isMarketAutoUpdate({ name: "company", kind: "company" })).toBe(false);
    writeUserSettings({ pluginMarketplaceAutoUpdate: { company: true, "sid-code": false } });
    expect(isMarketAutoUpdate({ name: "sid-code", kind: "official" })).toBe(false);
    expect(isMarketAutoUpdate({ name: "company", kind: "company" })).toBe(true);
  });

  test("官方市场：已装插件静默升级；没装的新插件从不安装", async () => {
    addOfficial("compliance", "1.0.0");
    expect((await installFromMarket("compliance@sid-code")).ok).toBe(true);
    addOfficial("compliance", "1.1.0");
    addOfficial("ops", "1.0.0");
    const r = await runPluginAutoUpdate();
    expect(r.updated).toEqual([
      { name: "compliance", from: "1.0.0", to: "1.1.0", market: "sid-code" },
    ]);
    expect(r.pending).toEqual([]);
    const reg = (await readInstalledPlugins()).plugins;
    expect(reg.compliance!.version).toBe("1.1.0");
    expect(reg.ops).toBeUndefined();
  });

  test("企业市场默认只提示不升级", async () => {
    addPlugin("feishu-docs", "1.0.0");
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);
    addPlugin("feishu-docs", "1.1.0");
    const r = await runPluginAutoUpdate();
    expect(r.updated).toEqual([]);
    expect(r.pending[0]?.reason).toContain("未开启自动更新");
    expect((await readInstalledPlugins()).plugins["feishu-docs"]!.version).toBe("1.0.0");
  });

  test("管理员打开企业市场自动更新：hooks 不变时升级，hooks 变了只提示", async () => {
    writeUserSettings({ pluginMarketplaceAutoUpdate: { company: true } });
    addPlugin("feishu-docs", "1.0.0");
    expect((await installFromMarket("feishu-docs@company")).ok).toBe(true);

    addPlugin("feishu-docs", "1.1.0"); // 默认组件：hooks PreToolUse，与已装一致
    const same = await runPluginAutoUpdate();
    expect(same.updated.map((u) => u.to)).toEqual(["1.1.0"]);

    addPlugin("feishu-docs", "1.2.0", {
      components: { skills: ["hello"], hooks: ["PreToolUse", "PostToolUse"], mcpServers: [] },
    });
    const changed = await runPluginAutoUpdate();
    expect(changed.updated).toEqual([]);
    expect(changed.pending[0]?.reason).toContain("hooks / MCP 有变化");
    expect((await readInstalledPlugins()).plugins["feishu-docs"]!.version).toBe("1.1.0");
  });

  test("新版本新增 MCP 或市场没给组件清单：都不静默升级", async () => {
    addOfficial("compliance", "1.0.0");
    expect((await installFromMarket("compliance@sid-code")).ok).toBe(true);

    addOfficial("compliance", "1.1.0", {
      components: {
        skills: ["hello"],
        mcpServers: [{ name: "x", type: "http", url: "https://x" }],
      },
    });
    expect((await runPluginAutoUpdate()).pending[0]?.reason).toContain("hooks / MCP 有变化");

    addOfficial("compliance", "1.2.0", { components: null });
    expect((await runPluginAutoUpdate()).pending[0]?.reason).toContain("无法确认");
    expect((await readInstalledPlugins()).plugins.compliance!.version).toBe("1.0.0");
  });

  test("拉不到最新目录（只有缓存）时不动；没装市场插件时不联网", async () => {
    const before = fake.requests.length;
    expect(await runPluginAutoUpdate()).toEqual({ updated: [], pending: [] });
    expect(fake.requests.length).toBe(before);

    addOfficial("compliance", "1.0.0");
    expect((await installFromMarket("compliance@sid-code")).ok).toBe(true);
    addOfficial("compliance", "1.1.0");
    fake.officialStatus = 503;
    expect(await runPluginAutoUpdate()).toEqual({ updated: [], pending: [] });
  });
});
