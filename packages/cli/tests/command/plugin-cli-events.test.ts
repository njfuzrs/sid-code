/**
 * `sid-code plugin install|update` 无头快速路径必须真的把 plugin_installed 送到后端。
 *
 * 回归背景：2026-10-13 生产 3 次市场下载、0 条 plugin_installed。快速路径不启动 App，
 * 没人绑 Analytics Sink，事件只进内存队列，进程一退就丢。进程内单测（market.test.ts）
 * 自己 attach 了假 Sink，所以一直是绿的——这条只能用**真子进程 + 真 HTTP** 证明。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pluginPackage } from "../plugin/tar-fixture.ts";

const BOOTSTRAP = resolve(import.meta.dir, "../../src/entrypoints/bootstrap.ts");

interface Posted {
  eventName: string;
  metadata: Record<string, unknown>;
}

let tmp: string;
let server: ReturnType<typeof Bun.serve>;
let posted: Posted[];
let eventAuth: Array<string | null>;
let version: string;
let pkg: Buffer;

function startFake(): void {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/api/v1/events") {
        eventAuth.push(req.headers.get("authorization"));
        const body = (await req.json()) as { events: Posted[] };
        posted.push(...body.events);
        return Response.json({ accepted: body.events.length }, { status: 202 });
      }
      if (url.pathname === "/api/v1/ctl/marketplace/index") {
        const sha256 = createHash("sha256").update(pkg).digest("hex");
        return Response.json({
          schema: 1,
          name: "company",
          plugins: [
            {
              name: "demo",
              kind: "plugin",
              description: "demo",
              version,
              sha256,
              size: pkg.length,
              artifact: `artifacts/demo/${version}`,
              components: { skills: ["hello"], hooks: [], mcpServers: [] },
              versions: [{ version, sha256, size: pkg.length }],
            },
          ],
        });
      }
      if (url.pathname === `/api/v1/ctl/marketplace/artifacts/demo/${version}`) {
        return new Response(new Uint8Array(pkg), {
          headers: { "content-type": "application/gzip" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

/** 必须异步 spawn：spawnSync 会阻塞本进程事件循环，同进程的假后端就接不了子进程的请求 */
async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const base = `http://127.0.0.1:${server.port}`;
  const proc = Bun.spawn([process.execPath, BOOTSTRAP, "plugin", ...args], {
    // 必须显式展开 process.env（见 tests/build/test-isolation-preload-wiring）
    env: {
      ...process.env,
      SID_CONFIG_DIR: tmp,
      SID_CODE_BACKEND_URL: base,
      SID_CODE_OFFICIAL_MARKET_URL: `${base}/plugins/index.json`,
      SID_CODE_DISABLE_TELEMETRY: "",
      SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const installedEvents = () => posted.filter((e) => e.eventName === "plugin_installed");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sid-plugin-cli-events-"));
  // 设备凭据：sid-backend 后端无凭据时稳定不发（http.ts no_auth）
  writeFileSync(join(tmp, "device-credential.json"), JSON.stringify({ credential: "dev-cred-1" }), {
    mode: 0o600,
  });
  posted = [];
  eventAuth = [];
  version = "1.0.0";
  pkg = pluginPackage("demo", version);
  startFake();
});

afterEach(() => {
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

describe("sid-code plugin 子命令上报 plugin_installed", () => {
  test("install：进程退出前 plugin_installed 已 POST 到 /events，带设备凭据", async () => {
    const r = await runCli(["install", "demo@company"]);
    expect(r.exitCode).toBe(0);
    const ev = installedEvents();
    expect(ev.length).toBe(1);
    expect(ev[0]!.metadata.plugin_name).toBe("demo");
    expect(ev[0]!.metadata.plugin_marketplace).toBe("company");
    expect(ev[0]!.metadata.plugin_version).toBe("1.0.0");
    expect(ev[0]!.metadata.install_action).toBe("install");
    expect(eventAuth).toContain("Bearer dev-cred-1");
  }, 90_000);

  test("update：升版本后上报 install_action=update", async () => {
    expect((await runCli(["install", "demo@company"])).exitCode).toBe(0);
    posted = [];
    version = "1.1.0";
    pkg = pluginPackage("demo", version);
    const r = await runCli(["update", "demo"]);
    expect(r.exitCode).toBe(0);
    const ev = installedEvents();
    expect(ev.length).toBe(1);
    expect(ev[0]!.metadata.install_action).toBe("update");
    expect(ev[0]!.metadata.plugin_version).toBe("1.1.0");
  }, 120_000);

  test("SID_CODE_DISABLE_TELEMETRY=1：照常安装，但不外发任何事件", async () => {
    const r = await runCli(["install", "demo@company"], { SID_CODE_DISABLE_TELEMETRY: "1" });
    expect(r.exitCode).toBe(0);
    expect(posted.length).toBe(0);
  }, 90_000);

  test("只读子命令（list）不初始化上报、不外发", async () => {
    const r = await runCli(["list"]);
    expect(r.exitCode).toBe(0);
    expect(posted.length).toBe(0);
  }, 60_000);
});
