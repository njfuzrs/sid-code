/**
 * S4：GitHub webhook 签名。
 *
 * 无 secret 必须 401（fail-closed）。长度不等不能抛。
 * 比较走 timingSafeEqual——这里断言的是结果，不是「源码里有这个函数名」：
 * 正确签名 202、错一位 401、长度不等 401。
 *
 * 正确签名会让 worker 异步去 clone。测试立刻 stop(true)，不等那个 promise。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDaemonServer } from "@sid-code/core/daemon/server.ts";

const SECRET = "test-webhook-secret";
const BODY = JSON.stringify({
  action: "opened",
  pull_request: {
    number: 1,
    diff_url: "https://example.invalid/diff",
    head: { ref: "feat", sha: "abc" },
    base: { ref: "main" },
  },
  repository: { name: "sid-code", owner: { login: "njfuzrs" } },
  sender: { login: "octocat" },
});

function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

let dir: string;
const servers: Array<{ stop: (close?: boolean) => void; port: number }> = [];

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers.length = 0;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function start(secret: string) {
  dir = mkdtempSync(join(tmpdir(), "sid-daemon-hmac-"));
  const server = createDaemonServer({
    port: 0,
    host: "127.0.0.1",
    max_concurrent: 1,
    webhook_secret: secret,
    workspace_base: join(dir, "ws"),
    storage_type: "file",
    storage_path: join(dir, "sessions"),
  });
  const port = server.port;
  servers.push(server);
  return port;
}

async function post(port: number, signature: string, body = BODY) {
  const res = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    },
    body,
  });
  return { status: res.status, json: await res.json() };
}

describe("webhook HMAC", () => {
  test("无 secret：正确形状的签名也 401，不接受", async () => {
    const port = start("");
    const { status, json } = await post(port, sign(BODY));
    expect(status).toBe(401);
    expect(json.error).toBe("invalid signature");
  });

  test("空签名 401", async () => {
    const port = start(SECRET);
    const { status } = await post(port, "");
    expect(status).toBe(401);
  });

  test("长度不等 401，不抛", async () => {
    const port = start(SECRET);
    const { status } = await post(port, "sha256=abcd");
    expect(status).toBe(401);
  });

  test("错一位 401", async () => {
    const port = start(SECRET);
    const good = sign(BODY);
    const flipped = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    const { status } = await post(port, flipped);
    expect(status).toBe(401);
  });

  test("正确签名 202", async () => {
    const port = start(SECRET);
    const { status, json } = await post(port, sign(BODY));
    expect(status).toBe(202);
    expect(json.status).toBe("accepted");
  });

  test("别的 secret 签出来的 401", async () => {
    const port = start(SECRET);
    const { status } = await post(port, sign(BODY, "other-secret"));
    expect(status).toBe(401);
  });
});
