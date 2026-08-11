import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpExporter } from "@sid-code/core/analytics/exporters/http.ts";
import { EventDiskCache } from "@sid-code/core/analytics/disk-cache.ts";

const realFetch = globalThis.fetch;

describe("HTTP 事件导出器（spec 17 §4.2）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-http-"));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
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
      batchSize: 1,
      diskCache,
    });
    exporter.send("e1", { a: 1 });
    await new Promise((r) => setTimeout(r, 50));

    const files = readdirSync(dir).filter((f) => f.startsWith("failed_events"));
    expect(files.length).toBe(1);
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
      batchSize: 1,
      diskCache,
    });
    exporter.send("e1", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(dir).filter((f) => f.startsWith("failed_events")).length).toBe(1);
  });
});
