/**
 * HTTP 事件导出器（spec 17 §4.2 + M4 PR-4.1 设备鉴权）。
 *
 * 隔离：SID_CONFIG_DIR → tmpdir（applyDeviceAuth 读 ~/.sid-code/device-credential.json），
 * 必须存/恢复原值，不能无条件 delete——bun test 同批多文件跑在同一进程里。
 * 每个用例前 __resetIdentityForTest()：凭据有进程内缓存，否则上一个用例的凭据会漏进来。
 *
 * ⚠ 原有 6 个用例里「真的要发出请求」的那些必须显式给 authHeader：
 * 接上设备鉴权后，无凭据且无 authHeader 是「稳定不发」，fetch 根本不会被调用。
 */
import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpExporter } from "@sid-code/core/analytics/exporters/http.ts";
import { EventDiskCache } from "@sid-code/core/analytics/disk-cache.ts";
import { __resetIdentityForTest, saveDeviceCredential } from "@sid-code/core/identity/index.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { assertIsolated } from "../helpers/assert-isolated.ts";

const realFetch = globalThis.fetch;
/** 静态回落头，用于「不测鉴权、只测批量/重试」的老用例 */
const STATIC_AUTH = "Bearer static-token";
/** 鉴权组的默认 endpoint。按它过滤 stub 记录，才不会把外来请求算进来。 */
const EVENTS_URL = "https://example.com/events";

describe("HTTP 事件导出器（spec 17 §4.2）", () => {
  let dir: string;
  let prevConfigDir: string | undefined;
  let warnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    dir = mkdtempSync(join(tmpdir(), "sid-http-"));
    process.env.SID_CONFIG_DIR = dir;
    assertIsolated();
    __resetIdentityForTest();
    warnSpy = spyOn(getLogger(), "warn");
  });
  afterEach(() => {
    warnSpy?.mockRestore();
    globalThis.fetch = realFetch;
    __resetIdentityForTest();
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("达到 batchSize 时立即发送", async () => {
    const sent: any[] = [];
    globalThis.fetch = (async (_url: any, opts: any) => {
      sent.push(JSON.parse(opts.body));
      return new Response("{}", { status: 200 });
    }) as any;

    const exporter = new HttpExporter({
      name: "test",
      endpoint: "https://example.com/events",
      authHeader: STATIC_AUTH,
      batchSize: 2,
    });
    exporter.send("e1", { a: 1 });
    expect(sent.length).toBe(0); // 还没满
    exporter.send("e2", { b: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.length).toBe(1);
    expect(sent[0].events.length).toBe(2);
  });

  test("白名单过滤事件", () => {
    const exporter = new HttpExporter({
      name: "test",
      endpoint: "https://example.com",
      allowedEvents: new Set(["allowed"]),
    });
    expect(exporter.accepts("allowed")).toBe(true);
    expect(exporter.accepts("denied")).toBe(false);
  });

  test("默认 stripProtected 为 true", () => {
    const exporter = new HttpExporter({ name: "t", endpoint: "https://x.com" });
    expect(exporter.stripProtected).toBe(true);
  });

  test("发送失败时写入磁盘缓存", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as any;

    const diskCache = new EventDiskCache({ cacheDir: dir, sessionId: "s1", maxRetries: 8 });
    const exporter = new HttpExporter({
      name: "test",
      endpoint: "https://example.com",
      authHeader: STATIC_AUTH,
      batchSize: 1,
      diskCache,
    });
    exporter.send("e1", { a: 1 });
    await new Promise((r) => setTimeout(r, 50));

    const files = readdirSync(dir).filter((f) => f.startsWith("failed_events"));
    expect(files.length).toBe(1);
    // 失败会 schedule 一次 QuadraticBackoff 重试，首次延迟约 0、第二次 500ms。
    // 收尾 shutdown 清掉它，不让 timer 活过本用例 —— 卫生，不是为了修 CI 那条偶发。
    //
    // ⚠ 更正（b87f472e 的判断有误）：那次以为「这个 timer 打进后面的用例，让
    // calls.length 偶发 +1」，补了两处 shutdown。补完 CI 仍然红在同一行。
    // 实测这个 timer 到期后走 retryFromDisk → retryPreviousBatches，而后者
    // **排除自己的 batchUUID**（disk-cache.ts:66），扫不到文件，一次 fetch 都不发。
    // 探针验证：shutdown 后换计数 stub 等 120ms，偷跑次数 = 0。
    // 真正的成因见下面鉴权组 stubFetch 的注释（断言口径太宽，数到了别的文件的请求）。
    await exporter.shutdown();
  });

  test("shutdown 刷新剩余事件", async () => {
    const sent: any[] = [];
    globalThis.fetch = (async (_url: any, opts: any) => {
      sent.push(JSON.parse(opts.body));
      return new Response("{}", { status: 200 });
    }) as any;

    const exporter = new HttpExporter({
      name: "test",
      endpoint: "https://example.com",
      authHeader: STATIC_AUTH,
      batchSize: 100, // 不会自动触发
    });
    exporter.send("e1", { a: 1 });
    await exporter.shutdown();
    expect(sent.length).toBe(1);
  });

  test("HTTP 非 2xx 视为失败", async () => {
    globalThis.fetch = (async () => new Response("err", { status: 500 })) as any;
    const diskCache = new EventDiskCache({ cacheDir: dir, sessionId: "s2", maxRetries: 8 });
    const exporter = new HttpExporter({
      name: "test",
      endpoint: "https://example.com",
      authHeader: STATIC_AUTH,
      batchSize: 1,
      diskCache,
    });
    exporter.send("e1", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(dir).filter((f) => f.startsWith("failed_events")).length).toBe(1);
    // 同上：清掉失败触发的退避重试 timer，避免泄漏到后续用例。
    await exporter.shutdown();
  });
});

describe("设备鉴权与稳定不发（M4 PR-4.1）", () => {
  let dir: string;
  let cacheDir: string;
  let prevConfigDir: string | undefined;
  let warnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    dir = mkdtempSync(join(tmpdir(), "sid-http-auth-"));
    cacheDir = join(dir, "telemetry");
    process.env.SID_CONFIG_DIR = dir;
    assertIsolated();
    __resetIdentityForTest();
    warnSpy = spyOn(getLogger(), "warn");
  });
  afterEach(() => {
    warnSpy?.mockRestore();
    globalThis.fetch = realFetch;
    __resetIdentityForTest();
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 记录每次 fetch 的 url + headers，返回给定状态码。
   *
   * ⚠ 精确条数一律用 `to(url)` 过滤后再断言，不要直接数 `calls.length`。
   *
   * `globalThis.fetch` 是**全局**的，而 bun test 同批多文件跑在同一个进程里：
   * 别的测试文件留下的定时器（心跳 / 退避重试 / 探针）会在本用例那 20ms 等待窗口里
   * 打到这个 stub 上，把「calls.length === 1」偶发顶成 4 / 7。
   *
   * 实测：CI ubuntu leg 连续两次红在同一行，数字还不一样（`Received: 4` 与
   * `Received: 7`），而本地全量 `bun test` 12557 pass 复现不了。数字会飘正是
   * 「外来流量」的指纹——若是本文件自己漏了 timer，次数会是稳定值。
   *
   * 所以这里不是「再补一次 shutdown」能修的（b87f472e 试过，仍然红）：
   * 根因是断言口径太宽，把别人的请求也算成了自己的。按 url 过滤之后，
   * 断言问的才是它本来要问的那件事——**这个 exporter 自己发了几次**。
   */
  function stubFetch(status = 200): {
    to(url: string): Array<Record<string, string>>;
  } {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url: any, opts: any) => {
      calls.push({ url: String(url), headers: opts.headers as Record<string, string> });
      return new Response("{}", { status });
    }) as any;
    return {
      to(url: string) {
        return calls.filter((c) => c.url === url).map((c) => c.headers);
      },
    };
  }

  test("有设备凭据时带 Bearer", async () => {
    saveDeviceCredential({ credential: "dev-cred-1" });
    const fetched = stubFetch();
    const exporter = new HttpExporter({
      name: "ev",
      endpoint: EVENTS_URL,
      batchSize: 1,
    });
    exporter.send("e1", {});
    await new Promise((r) => setTimeout(r, 20));
    const calls = fetched.to(EVENTS_URL);
    expect(calls.length).toBe(1);
    expect(calls[0].Authorization).toBe("Bearer dev-cred-1");
  });

  test("设备凭据优先于静态 authHeader", async () => {
    saveDeviceCredential({ credential: "dev-cred-2" });
    const fetched = stubFetch();
    const exporter = new HttpExporter({
      name: "ev",
      endpoint: EVENTS_URL,
      authHeader: STATIC_AUTH,
      batchSize: 1,
    });
    exporter.send("e1", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched.to(EVENTS_URL)[0].Authorization).toBe("Bearer dev-cred-2");
  });

  test("无凭据但配了 authHeader → 用 authHeader", async () => {
    const fetched = stubFetch();
    const exporter = new HttpExporter({
      name: "ev",
      endpoint: EVENTS_URL,
      authHeader: STATIC_AUTH,
      batchSize: 1,
    });
    exporter.send("e1", {});
    await new Promise((r) => setTimeout(r, 20));
    const calls = fetched.to(EVENTS_URL);
    expect(calls.length).toBe(1);
    expect(calls[0].Authorization).toBe(STATIC_AUTH);
  });

  test("过期凭据视为无凭据（fail-open，不发远程）", async () => {
    saveDeviceCredential({ credential: "old", expiresAt: "2020-01-01T00:00:00Z" });
    const fetched = stubFetch();
    const exporter = new HttpExporter({
      name: "ev",
      endpoint: EVENTS_URL,
      batchSize: 1,
    });
    exporter.send("e1", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched.to(EVENTS_URL).length).toBe(0);
  });

  test("无凭据且无 authHeader：不发 fetch、不写磁盘", async () => {
    const fetched = stubFetch();
    const diskCache = new EventDiskCache({ cacheDir, sessionId: "s1", maxRetries: 8 });
    const exporter = new HttpExporter({
      name: "ev",
      endpoint: EVENTS_URL,
      batchSize: 1,
      diskCache,
    });
    exporter.send("e1", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(fetched.to(EVENTS_URL).length).toBe(0);
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
  });

  test("明文非本地 endpoint：不发 fetch、不写磁盘", async () => {
    saveDeviceCredential({ credential: "dev-cred-3" });
    const plaintextUrl = "http://corp.example.com/events";
    const fetched = stubFetch();
    const diskCache = new EventDiskCache({ cacheDir, sessionId: "s2", maxRetries: 8 });
    const exporter = new HttpExporter({
      name: "ev",
      endpoint: plaintextUrl,
      batchSize: 1,
      diskCache,
    });
    exporter.send("e1", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(fetched.to(plaintextUrl).length).toBe(0);
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
  });

  test("http://127.0.0.1 放行", async () => {
    saveDeviceCredential({ credential: "dev-cred-4" });
    const loopbackUrl = "http://127.0.0.1:8900/api/v1/events";
    const fetched = stubFetch();
    const exporter = new HttpExporter({
      name: "ev",
      endpoint: loopbackUrl,
      batchSize: 1,
    });
    exporter.send("e1", {});
    await new Promise((r) => setTimeout(r, 20));
    const calls = fetched.to(loopbackUrl);
    expect(calls.length).toBe(1);
    expect(calls[0].Authorization).toBe("Bearer dev-cred-4");
  });

  test("响应 401：不写磁盘、不调度退避", async () => {
    saveDeviceCredential({ credential: "revoked" });
    const fetched = stubFetch(401);
    const diskCache = new EventDiskCache({ cacheDir, sessionId: "s3", maxRetries: 8 });
    const exporter = new HttpExporter({
      name: "ev",
      endpoint: EVENTS_URL,
      batchSize: 1,
      diskCache,
    });
    exporter.send("e1", {});
    await new Promise((r) => setTimeout(r, 80));
    expect(fetched.to(EVENTS_URL).length).toBe(1); // 退避没再打一次
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
  });

  test("401 连续 3 批只告警一次", async () => {
    saveDeviceCredential({ credential: "revoked" });
    stubFetch(401);
    const exporter = new HttpExporter({
      name: "ev",
      endpoint: EVENTS_URL,
      batchSize: 1,
    });
    exporter.send("e1", {});
    await new Promise((r) => setTimeout(r, 20));
    exporter.send("e2", {});
    await new Promise((r) => setTimeout(r, 20));
    exporter.send("e3", {});
    await new Promise((r) => setTimeout(r, 20));
    const telemetryWarns = (warnSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => c[0] === "TELEMETRY" && String(c[1]).includes("401"),
    );
    expect(telemetryWarns.length).toBe(1);
  });

  test("recoverFromDisk 无凭据时不删已有 failed_events（R1 核心回归）", async () => {
    const fetched = stubFetch();
    const leftover = join(cacheDir, "failed_events.old-session.deadbeef.jsonl");
    const diskCache = new EventDiskCache({ cacheDir, sessionId: "new", maxRetries: 8 });
    // 先让 ensureDir 建目录，再放遗留文件
    await diskCache.queueFailedEvents([
      { eventName: "warmup", metadata: {}, timestamp: Date.now(), attempts: 0 },
    ]);
    writeFileSync(
      leftover,
      JSON.stringify({ eventName: "e", metadata: {}, timestamp: Date.now(), attempts: 0 }) + "\n",
    );

    const exporter = new HttpExporter({
      name: "ev",
      endpoint: EVENTS_URL,
      batchSize: 1,
      diskCache,
    });
    await exporter.recoverFromDisk();
    expect(fetched.to(EVENTS_URL).length).toBe(0);
    expect(existsSync(leftover)).toBe(true);
  });

  test("recoverFromDisk 有凭据且 200 时删除文件（对照组）", async () => {
    saveDeviceCredential({ credential: "dev-cred-5" });
    const fetched = stubFetch();
    const leftover = join(cacheDir, "failed_events.old-session.cafebabe.jsonl");
    const diskCache = new EventDiskCache({ cacheDir, sessionId: "new", maxRetries: 8 });
    await diskCache.queueFailedEvents([
      { eventName: "warmup", metadata: {}, timestamp: Date.now(), attempts: 0 },
    ]);
    writeFileSync(
      leftover,
      JSON.stringify({ eventName: "e", metadata: {}, timestamp: Date.now(), attempts: 0 }) + "\n",
    );

    const exporter = new HttpExporter({
      name: "ev",
      endpoint: EVENTS_URL,
      batchSize: 1,
      diskCache,
    });
    await exporter.recoverFromDisk();
    expect(fetched.to(EVENTS_URL).length).toBe(1);
    expect(existsSync(leftover)).toBe(false);
  });
});
