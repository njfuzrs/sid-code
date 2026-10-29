/**
 * 核查官网 scheduled 页时发现的 daemon 缺陷（D1/D3/D5）。
 *
 * D1：服务进程不继承 shell 环境，install --webhook 装出的服务拿不到 secret，webhook 静默不起。
 * D3：webhook 与调度源各一份并发计数，实际子进程上限 2×max-concurrent。
 * D5：/health 版本写死 "daemon-mvp-0.1.0"，与二进制版本无关。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { Daemon } from "@sid-code/core/daemon/daemon.ts";
import { createDaemonServer } from "@sid-code/core/daemon/server.ts";
import { resolveWebhookSecret, webhookSecretFile } from "@sid-code/core/daemon/webhook-secret.ts";
import {
  buildPlist,
  buildSystemdUnit,
  prepareWebhookSecretForInstall,
} from "@sid-code/core/daemon/service.ts";
import { getVersion } from "@sid-code/shared/version.ts";
import type { CronTask } from "@sid-code/core/cron/types.ts";

let home: string;
let prevHome: string | undefined;
let prevSecret: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sid-daemon-def-"));
  prevHome = process.env.SID_CONFIG_DIR;
  prevSecret = process.env.SID_CODE_WEBHOOK_SECRET;
  process.env.SID_CONFIG_DIR = home;
  delete process.env.SID_CODE_WEBHOOK_SECRET;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevHome;
  if (prevSecret === undefined) delete process.env.SID_CODE_WEBHOOK_SECRET;
  else process.env.SID_CODE_WEBHOOK_SECRET = prevSecret;
  rmSync(home, { recursive: true, force: true });
});

describe("D1：webhook secret 能带进服务进程", () => {
  it("环境变量缺省时读 0600 secret 文件", () => {
    expect(resolveWebhookSecret()).toBe("");
    mkdirSync(dirname(webhookSecretFile()), { recursive: true });
    writeFileSync(webhookSecretFile(), "from-file\n");
    expect(resolveWebhookSecret()).toBe("from-file");
    // 环境变量优先
    expect(resolveWebhookSecret({ SID_CODE_WEBHOOK_SECRET: "from-env" })).toBe("from-env");
  });

  it("install 时把当前环境的 secret 写进 0600 文件，服务文件里不出现 secret", () => {
    process.env.SID_CODE_WEBHOOK_SECRET = "s3cret-value";
    const log = console.log;
    console.log = () => {};
    try {
      expect(prepareWebhookSecretForInstall({ webhook: true })).toBe(true);
    } finally {
      console.log = log;
    }
    const path = webhookSecretFile();
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // 服务进程（无环境变量）能读到
    expect(resolveWebhookSecret({})).toBe("s3cret-value");
    expect(buildPlist({ webhook: true })).not.toContain("s3cret-value");
    expect(buildSystemdUnit({ webhook: true })).not.toContain("s3cret-value");
  });

  it("--webhook 但既无环境变量也无文件 → 拒绝安装", () => {
    const err = console.error;
    console.error = () => {};
    try {
      expect(prepareWebhookSecretForInstall({ webhook: true })).toBe(false);
    } finally {
      console.error = err;
    }
    // 不带 --webhook 不拦
    expect(prepareWebhookSecretForInstall({})).toBe(true);
  });

  it("服务文件带上安装时的 SID_CONFIG_DIR，服务进程与安装时看同一个配置根", () => {
    const plist = buildPlist({});
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain(`<key>SID_CONFIG_DIR</key>\n    <string>${home}</string>`);
    expect(buildSystemdUnit({})).toContain(`Environment="SID_CONFIG_DIR=${home}"`);
  });
});

describe("D3：webhook 与调度源共用并发计数", () => {
  const task = (id: string): CronTask => ({
    id,
    cron: "* * * * *",
    prompt: `p-${id}`,
    createdAt: Date.now(),
    recurring: true,
    durable: true,
  });

  it("webhook 占满名额时调度任务排队，webhook 结束后补跑", () => {
    const d = new Daemon({ maxConcurrent: 1 }) as any;
    const started: string[] = [];
    d.executor = {
      run: (job: { prompt: string }) => {
        started.push(job.prompt);
        return new Promise(() => {});
      },
    };
    // 模拟一个 webhook job 在跑
    expect(d.canAccept()).toBe(true);
    d.acquire();
    d.enqueueTask(task("a"));
    expect(started).toEqual([]);
    expect(d.queue).toHaveLength(1);
    // webhook job 结束 → 名额让给排队的调度任务
    d.release();
    expect(started).toEqual(["p-a"]);
    // 调度任务在跑时 webhook 不能再接
    expect(d.canAccept()).toBe(false);
  });

  it("daemon 起的 webhook server 用 daemon 自己的计数：调度占满时 webhook 429", async () => {
    process.env.SID_CODE_WEBHOOK_SECRET = "s";
    const d = new Daemon({ maxConcurrent: 1, webhookPort: 0 }) as any;
    d.maybeStartWebhook();
    const server = d.webhookServer as { port: number; stop: (f?: boolean) => void };
    expect(server).toBeTruthy();
    try {
      d.acquire(); // 模拟一个调度 job 占着唯一名额
      const { createHmac } = await import("node:crypto");
      const body = JSON.stringify({
        action: "opened",
        pull_request: { number: 1, head: { ref: "f", sha: "x" }, base: { ref: "main" } },
        repository: { name: "r", owner: { login: "o" } },
      });
      const sig = "sha256=" + createHmac("sha256", "s").update(body).digest("hex");
      const res = await fetch(`http://127.0.0.1:${server.port}/webhook/github`, {
        method: "POST",
        headers: { "x-github-event": "pull_request", "x-hub-signature-256": sig },
        body,
      });
      expect(res.status).toBe(429);
    } finally {
      server.stop(true);
    }
  });

  it("server 用传入的闸门判 429", async () => {
    const gate = { canAccept: () => false, acquire: () => {}, release: () => {} };
    const { createHmac } = await import("node:crypto");
    const server = createDaemonServer(
      {
        port: 0,
        host: "127.0.0.1",
        max_concurrent: 99,
        webhook_secret: "s",
        workspace_base: join(home, "ws"),
        storage_type: "file",
        storage_path: join(home, "st"),
      },
      gate,
    );
    try {
      const body = JSON.stringify({
        action: "opened",
        pull_request: { number: 1, head: { ref: "f", sha: "x" }, base: { ref: "main" } },
        repository: { name: "r", owner: { login: "o" } },
      });
      const sig = "sha256=" + createHmac("sha256", "s").update(body).digest("hex");
      const res = await fetch(`http://127.0.0.1:${server.port}/webhook/github`, {
        method: "POST",
        headers: { "x-github-event": "pull_request", "x-hub-signature-256": sig },
        body,
      });
      expect(res.status).toBe(429);
    } finally {
      server.stop(true);
    }
  });
});

describe("D5：/health 返回真实版本", () => {
  it("version 与 getVersion() 一致", async () => {
    const server = createDaemonServer({
      port: 0,
      host: "127.0.0.1",
      max_concurrent: 1,
      webhook_secret: "s",
      workspace_base: join(home, "ws"),
      storage_type: "file",
      storage_path: join(home, "st"),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      const json = (await res.json()) as { version: string };
      expect(json.version).toBe(getVersion());
    } finally {
      server.stop(true);
    }
  });
});
