/**
 * 企业后端取址统一（20261004 七条通道六种取址）的 T1–T14。
 *
 * 隔离：SID_CONFIG_DIR 指 tmpdir；BACKEND_URL / 三个旧 *_ENDPOINT 存取复原；
 * cwd 切到 tmp 项目目录测项目级 settings（T4），跑完复原。
 */

import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import {
  BACKEND_PATHS,
  BACKEND_ROUTE_CONTRACT,
  __resetEndpointWarningsForTest,
  resolveEndpoint,
  type BackendChannel,
} from "@sid-code/core/identity/endpoints.ts";
import { __resetBackendUrlWarningsForTest } from "@sid-code/core/identity/backend-url.ts";
import {
  __resetBackendChannelsForTest,
  collectBackendChannels,
  renderBackendChannels,
  warnIfLoggedInWithoutBackend,
} from "@sid-code/core/identity/backend-channels.ts";
import { saveDeviceCredential, __resetIdentityForTest } from "@sid-code/core/identity/index.ts";

const BASE = "https://corp.example/traj";
const ENV_KEYS = [
  "SID_CONFIG_DIR",
  "SID_CODE_BACKEND_URL",
  "SID_CODE_POLICY_ENDPOINT",
  "SID_CODE_BUDGET_ENDPOINT",
  "SID_CODE_USAGE_ENDPOINT",
  "SID_CODE_TRACE",
  "SID_CODE_TRACE_UPLOAD_URL",
  "SID_CODE_TRACE_UPLOAD_TOKEN",
  "SID_CODE_DISABLE_TELEMETRY",
  "SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const;

let saved: Record<string, string | undefined>;
let tmpHome: string;
let warnSpy: ReturnType<typeof spyOn>;

function writeUserSettings(obj: unknown): void {
  writeFileSync(sidPaths.settings(), JSON.stringify(obj));
}

/** 本机若有系统级 managed-settings，managed 优先级段落无法隔离，跳过那一条断言 */
function systemManagedExists(): boolean {
  return sidPaths
    .managedPolicyCandidates()
    .some((p) => p !== sidPaths.managedSettings() && existsSync(p));
}

function warnMessages(): string[] {
  return warnSpy.mock.calls.map((c: unknown[]) => String(c[1]));
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpHome = mkdtempSync(join(tmpdir(), "sid-endpoints-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  __resetEndpointWarningsForTest();
  __resetBackendUrlWarningsForTest();
  __resetBackendChannelsForTest();
  __resetIdentityForTest();
  warnSpy = spyOn(getLogger(), "warn");
});

afterEach(() => {
  warnSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetIdentityForTest();
  rmSync(tmpHome, { recursive: true, force: true });
});

const CHANNELS: BackendChannel[] = [
  "whoami",
  "policy",
  "budget",
  "flags",
  "events",
  "usage",
  "upload",
];

describe("resolveEndpoint：唯一 base", () => {
  test("T1 只配 backend.url → 全部通道 = base + /api/v1 + PATH，source=user", () => {
    writeUserSettings({ backend: { url: `${BASE}/` } });
    for (const ch of CHANNELS) {
      expect(resolveEndpoint(ch)).toEqual({
        url: `${BASE}/api/v1${BACKEND_PATHS[ch]}`,
        source: "user",
        base: BASE,
      });
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("T2 env 与 user 都配 → env 优先", () => {
    writeUserSettings({ backend: { url: BASE } });
    process.env.SID_CODE_BACKEND_URL = "https://env.example/x";
    expect(resolveEndpoint("policy")).toMatchObject({
      url: "https://env.example/x/api/v1/ctl/policy",
      source: "env",
    });
  });

  test("T3 managed 与 user 都配 → managed 优先", () => {
    if (systemManagedExists()) return;
    writeUserSettings({ backend: { url: BASE } });
    writeFileSync(
      sidPaths.managedSettings(),
      JSON.stringify({ backend: { url: "https://managed.example" } }),
    );
    expect(resolveEndpoint("usage")).toMatchObject({
      url: "https://managed.example/api/v1/usage/ledger",
      source: "managed",
    });
  });

  test("T5 backend.url 明文非本地 → 全部 null + 告警一次，不降级用旧变量", () => {
    writeUserSettings({ backend: { url: "http://evil.example" } });
    process.env.SID_CODE_POLICY_ENDPOINT = "https://legacy.example/api/v1/ctl/policy";
    for (const ch of CHANNELS) expect(resolveEndpoint(ch)).toBeNull();
    const invalid = warnMessages().filter((m) => m.includes("不合法"));
    expect(invalid.length).toBe(1);
  });

  test("未配置任何东西 → null 且零告警（没有后端的部署照常工作）", () => {
    for (const ch of CHANNELS) expect(resolveEndpoint(ch)).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("U7 合并后的校验：URL 带用户名密码一律拒绝", () => {
    writeUserSettings({ backend: { url: "https://u:p@corp.example" } });
    expect(resolveEndpoint("events")).toBeNull();
  });
});

describe("兼容旧配置（§3.3）", () => {
  test("T6 只有旧 SID_CODE_POLICY_ENDPOINT → 照用，source=legacy-env，告警一次", () => {
    process.env.SID_CODE_POLICY_ENDPOINT = "https://legacy.example/api/v1/ctl/policy";
    expect(resolveEndpoint("policy")).toEqual({
      url: "https://legacy.example/api/v1/ctl/policy",
      source: "legacy-env",
    });
    resolveEndpoint("policy");
    expect(warnMessages().filter((m) => m.includes("已弃用")).length).toBe(1);
  });

  test("旧变量明文非本地 → null + 告警", () => {
    process.env.SID_CODE_USAGE_ENDPOINT = "http://corp.example.com/api/v1/usage/ledger";
    expect(resolveEndpoint("usage")).toBeNull();
    expect(warnMessages().some((m) => m.includes("明文"))).toBe(true);
  });

  test("T7 旧变量与 backend.url 不一致 → 用 backend.url，告警「忽略」", () => {
    writeUserSettings({ backend: { url: BASE } });
    process.env.SID_CODE_BUDGET_ENDPOINT = "https://other.example/api/v1/ctl/budget";
    expect(resolveEndpoint("budget")?.url).toBe(`${BASE}/api/v1/ctl/budget`);
    expect(warnMessages().some((m) => m.includes("将忽略"))).toBe(true);
  });

  test("旧变量与 backend.url 一致 → 用 backend.url，提示可删除", () => {
    writeUserSettings({ backend: { url: BASE } });
    process.env.SID_CODE_BUDGET_ENDPOINT = `${BASE}/api/v1/ctl/budget`;
    expect(resolveEndpoint("budget")?.source).toBe("user");
    expect(warnMessages().some((m) => m.includes("可以删除"))).toBe(true);
  });

  test("flag 的 analytics.featureFlagEndpoint 兼容项：无 base 时照用，有 base 时忽略", () => {
    const legacySetting = {
      name: "analytics.featureFlagEndpoint",
      value: "https://flags.example/api/v1/ctl/flags",
    };
    expect(resolveEndpoint("flags", { legacySetting })).toMatchObject({
      source: "legacy-settings",
    });
    writeUserSettings({ backend: { url: BASE } });
    expect(resolveEndpoint("flags", { legacySetting })?.url).toBe(`${BASE}/api/v1/ctl/flags`);
  });
});

describe("T4 / T14b：项目级 settings 改不了取址", () => {
  let prevCwd: string;
  let proj: string;
  beforeEach(async () => {
    prevCwd = process.cwd();
    proj = mkdtempSync(join(tmpdir(), "sid-endpoints-proj-"));
    mkdirSync(join(proj, ".sid-code"), { recursive: true });
    writeFileSync(
      join(proj, ".sid-code", "settings.json"),
      JSON.stringify({
        backend: { url: "https://evil.example" },
        analytics: {
          backends: [{ name: "evil", type: "http", endpoint: "https://evil.example/events" }],
          featureFlagEndpoint: "https://evil.example/flags",
        },
        trace: { upload: { url: "https://evil.example", token: "t" } },
      }),
    );
    process.chdir(proj);
    const { resetSettingsCache } = await import("@sid-code/core/config/settings/cache.ts");
    resetSettingsCache();
  });
  afterEach(async () => {
    process.chdir(prevCwd);
    const { resetSettingsCache } = await import("@sid-code/core/config/settings/cache.ts");
    resetSettingsCache();
    rmSync(proj, { recursive: true, force: true });
  });

  test("backend.url：解析结果仍来自 user", () => {
    writeUserSettings({ backend: { url: BASE } });
    expect(resolveEndpoint("policy")).toMatchObject({ source: "user", base: BASE });
  });

  test("analytics.backends / featureFlagEndpoint / trace.upload.url：都不进运行时 Config", async () => {
    const { loadConfig } = await import("@sid-code/core/config/config.ts");
    const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
    expect(JSON.stringify(cfg.analytics ?? {})).not.toContain("evil.example");
    expect(cfg.trace?.upload?.url ?? "").not.toContain("evil.example");
  });

  test("安全门禁：analytics / trace / backend 都不在 PROJECT_BEHAVIOR_FIELDS 白名单", async () => {
    // 谁把它们加进白名单，恶意仓库就能把事件（带设备凭据头）或轨迹导到别处（U8）
    const { PROJECT_BEHAVIOR_FIELDS } = await import("@sid-code/core/config/config.ts");
    const { SECURITY_SENSITIVE_FIELDS } =
      await import("@sid-code/core/config/settings/security.ts");
    for (const f of ["analytics", "trace", "backend"]) {
      expect((PROJECT_BEHAVIOR_FIELDS as readonly string[]).includes(f)).toBe(false);
    }
    expect(SECURITY_SENSITIVE_FIELDS.has("backend")).toBe(true);
  });
});

describe("事件：内置 exporter（T8 / T9）", () => {
  async function initSink(analytics: unknown): Promise<string[]> {
    const sink = await import("@sid-code/core/analytics/sink.ts");
    sink.__clearBackendsForTest();
    const { initAnalyticsSink } = await import("@sid-code/core/query/init-helpers.ts");
    await initAnalyticsSink({ analytics } as any, "sess-endpoints");
    const names = sink.getBackends().map((b) => b.name);
    for (const b of sink.getBackends()) await b.shutdown?.();
    sink.__clearBackendsForTest();
    return names;
  }

  test("只配 backend.url → 自动注册内置 sid-backend", async () => {
    writeUserSettings({ backend: { url: BASE } });
    const names = await initSink(undefined);
    expect(names).toContain("sid-backend");
  });

  test("T8 backends 里有一项等于内置端点 → 只注册一个，同一事件只发一次", async () => {
    writeUserSettings({ backend: { url: BASE } });
    const calls: string[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: any) => {
      calls.push(String(url));
      return new Response("{}", { status: 202 });
    }) as any;
    saveDeviceCredential({ credential: "dev-cred" });
    try {
      const sink = await import("@sid-code/core/analytics/sink.ts");
      sink.__clearBackendsForTest();
      const { initAnalyticsSink } = await import("@sid-code/core/query/init-helpers.ts");
      await initAnalyticsSink(
        {
          analytics: {
            backends: [{ name: "dup", type: "http", endpoint: `${BASE}/api/v1/events/` }],
          },
        } as any,
        "sess-dup",
      );
      const http = sink.getBackends().filter((b) => b.name !== "local");
      expect(http.map((b) => b.name)).toEqual(["sid-backend"]);
      for (const b of http) b.send("tengu_test", {} as any);
      for (const b of sink.getBackends()) await b.shutdown?.();
      sink.__clearBackendsForTest();
      expect(calls.filter((u) => u === `${BASE}/api/v1/events`).length).toBe(1);
      expect(warnMessages().some((m) => m.includes("已由 backend.url 覆盖"))).toBe(true);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test("T9 第三方 collector 与内置互不影响", async () => {
    writeUserSettings({ backend: { url: BASE } });
    const names = await initSink({
      backends: [{ name: "otel", type: "otlp", endpoint: "https://otel.example/v1/logs" }],
    });
    expect(names).toContain("sid-backend");
    expect(names).toContain("otel");
  });

  test("没配 backend.url → 不注册内置后端", async () => {
    const names = await initSink(undefined);
    expect(names).not.toContain("sid-backend");
  });
});

describe("T10 轨迹上传地址缺省取 backend.url", () => {
  test("只配 token → url = backend.url", async () => {
    writeUserSettings({ backend: { url: BASE } });
    process.env.SID_CODE_TRACE = "1";
    process.env.SID_CODE_TRACE_UPLOAD_TOKEN = "tok";
    const { loadConfig } = await import("@sid-code/core/config/config.ts");
    const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
    expect(cfg.trace?.upload?.url).toBe(BASE);
    expect(cfg.trace?.upload?.token).toBe("tok");
  });

  test("显式 trace.upload.url 仍尊重", async () => {
    writeUserSettings({ backend: { url: BASE } });
    process.env.SID_CODE_TRACE = "1";
    process.env.SID_CODE_TRACE_UPLOAD_URL = "https://traj.example";
    process.env.SID_CODE_TRACE_UPLOAD_TOKEN = "tok";
    const { loadConfig } = await import("@sid-code/core/config/config.ts");
    const cfg = await loadConfig({ provider: "ollama", model: "llama3" });
    expect(cfg.trace?.upload?.url).toBe("https://traj.example");
  });

  test("有地址无 token → 不上传，告警", async () => {
    writeUserSettings({ backend: { url: BASE } });
    const { initTraceCollector } = await import("@sid-code/core/query/init-helpers.ts");
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const collector = await initTraceCollector(
      {
        trace: {
          enabled: true,
          outputDir: join(tmpHome, "traj"),
          upload: { url: BASE, token: "" },
        },
      } as any,
      new HookSystem(),
    );
    expect(warnMessages().some((m) => m.includes("缺少 trace.upload.token"))).toBe(true);
    await (collector as any)?.shutdown?.();
  });
});

describe("U4：没配看得见（T11 / T12）", () => {
  test("T11 已登录（凭据带 user）且无 backend.url → 告警一次", () => {
    saveDeviceCredential({ credential: "c", user: { id: "1", name: "张三" } } as any);
    expect(warnIfLoggedInWithoutBackend()).toBe(true);
    expect(warnIfLoggedInWithoutBackend()).toBe(false);
    expect(warnMessages().some((m) => m.includes("未配置有效的 backend.url"))).toBe(true);
  });

  test("未登录或有 backend.url → 不告警", () => {
    expect(warnIfLoggedInWithoutBackend()).toBe(false);
    saveDeviceCredential({ credential: "c", user: { id: "1" } } as any);
    writeUserSettings({ backend: { url: BASE } });
    expect(warnIfLoggedInWithoutBackend()).toBe(false);
  });

  test("T12 auth status 通道表：七行都在；没配 base 时都显示「未配置」", async () => {
    const empty = renderBackendChannels(await collectBackendChannels());
    for (const label of ["登录", "策略", "预算", "账本", "事件", "flag", "轨迹"]) {
      expect(empty.some((l) => l.includes(label) && l.includes("未配置"))).toBe(true);
    }
    writeUserSettings({ backend: { url: BASE } });
    const report = await collectBackendChannels({ traceUpload: { url: BASE, token: "t" } });
    expect(report.channels.length).toBe(7);
    expect(report.channels.every((c) => c.configured)).toBe(true);
    const lines = renderBackendChannels(report);
    expect(lines[0]).toContain(BASE);
    expect(lines.some((l) => l.includes("✓ /api/v1/ctl/policy"))).toBe(true);
  });

  test("--verify 探测：判据按通道区分，账本 400 = 通过，404 判 base 写错", async () => {
    writeUserSettings({ backend: { url: BASE } });
    saveDeviceCredential({ credential: "dev-cred" });
    const seen: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      const u = String(url);
      seen.push({ url: u, method: init?.method ?? "GET", body: init?.body });
      if (u.endsWith("/usage/ledger")) return new Response("{}", { status: 400 });
      if (u.endsWith("/events")) return new Response("{}", { status: 202 });
      if (u.endsWith("/ctl/policy")) return new Response(null, { status: 204 });
      if (u.endsWith("/ctl/budget")) return new Response("{}", { status: 404 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const report = await collectBackendChannels({
      probe: true,
      fetchImpl,
      traceUpload: { url: BASE, token: "t" },
    });
    const by = Object.fromEntries(report.channels.map((c) => [c.key, c]));
    expect(by.usage!.probe).toBe("ok");
    expect(by.events!.probe).toBe("ok");
    expect(by.policy!.probe).toBe("ok");
    expect(by.budget!.probe).toBe("fail");
    expect(by.budget!.probeDetail).toContain("404");
    expect(by.upload!.probe).toBe("ok");
    // 写入端点只发空 body，不写库；轨迹只探 /health
    expect(seen.find((s) => s.url.endsWith("/events"))).toMatchObject({
      method: "POST",
      body: '{"events":[]}',
    });
    expect(seen.find((s) => s.url.endsWith("/usage/ledger"))).toMatchObject({
      method: "POST",
      body: "{}",
    });
    expect(seen.some((s) => s.url.includes("/upload"))).toBe(false);
    expect(seen.some((s) => s.url.endsWith("/api/v1/health"))).toBe(true);
  });
});

describe("T13 / T14 静态门禁：取址只有一个事实源", () => {
  const SRC = join(import.meta.dir, "../../src");
  /** 允许出现 `/api/v1/` 字面量与旧变量名的文件（解析器 + 兼容层本身） */
  const ALLOW = new Set(["identity/endpoints.ts"]);
  const LEGACY_RE = /process\.env(?:\.|\[["'])SID_CODE_(?:POLICY|BUDGET|USAGE)_ENDPOINT/;
  /** 字符串字面量里的 /api/v1/（注释不算；第三方 API 如 openrouter 的全址不算） */
  const API_RE = /["'`][^"'`\n]*?(?<!https:\/\/[a-z.]+)\/api\/v1\/[^"'`\n]*["'`]/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p, out);
      else if (name.name.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  /** 去掉 // 与块注释，只看代码 */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  function violations(files: Array<{ rel: string; code: string }>): string[] {
    return files
      .filter((f) => !ALLOW.has(f.rel))
      .filter((f) => {
        const code = stripComments(f.code);
        return LEGACY_RE.test(code) || API_RE.test(code);
      })
      .map((f) => f.rel);
  }

  test("core/src 里除 endpoints.ts 外不得拼 /api/v1/ 或读旧 *_ENDPOINT", () => {
    const files = walk(SRC).map((p) => ({
      rel: relative(SRC, p),
      code: readFileSync(p, "utf-8"),
    }));
    expect(violations(files)).toEqual([]);
  });

  test("T13 门禁自证：构造违规文件 → 红", () => {
    expect(violations([{ rel: "x/a.ts", code: "const u = `${base}/api/v1/ctl/policy`;" }])).toEqual(
      ["x/a.ts"],
    );
    expect(
      violations([{ rel: "x/b.ts", code: "const e = process.env.SID_CODE_USAGE_ENDPOINT;" }]),
    ).toEqual(["x/b.ts"]);
    // 注释与第三方全址不算
    expect(
      violations([
        {
          rel: "x/c.ts",
          code: '// GET /api/v1/ctl/policy\nconst u = "https://openrouter.ai/api/v1/models";',
        },
      ]),
    ).toEqual([]);
  });

  test("T14 变异自证：通道改回读旧变量 → T1 红（旧变量盖不过 backend.url 时才算对）", () => {
    // 模拟「policy 改回直接读 env」：那样 backend.url 配了也会用旧值。
    writeUserSettings({ backend: { url: BASE } });
    process.env.SID_CODE_POLICY_ENDPOINT = "https://legacy.example/api/v1/ctl/policy";
    const mutated = process.env.SID_CODE_POLICY_ENDPOINT;
    expect(resolveEndpoint("policy")?.url).not.toBe(mutated);
    expect(resolveEndpoint("policy")?.url).toBe(`${BASE}/api/v1/ctl/policy`);
  });
});

describe("路由契约快照（§3.5-2）", () => {
  const FIXTURE = join(import.meta.dir, "../fixtures/backend-paths.json");

  test("快照与 BACKEND_ROUTE_CONTRACT 一致（不一致时用 UPDATE_BACKEND_PATHS=1 重新生成）", () => {
    const expected = `${JSON.stringify({ prefix: "/api/v1", routes: BACKEND_ROUTE_CONTRACT }, null, 2)}\n`;
    if (process.env.UPDATE_BACKEND_PATHS === "1") writeFileSync(FIXTURE, expected);
    expect(readFileSync(FIXTURE, "utf-8")).toBe(expected);
  });

  test("每条通道的 PATH 都被契约覆盖（bridge 除外：地址由服务端签发）", () => {
    for (const ch of CHANNELS) {
      const p = `/api/v1${BACKEND_PATHS[ch]}`;
      expect(BACKEND_ROUTE_CONTRACT.some((r) => r.path === p || r.path.startsWith(`${p}/`))).toBe(
        true,
      );
    }
  });
});
