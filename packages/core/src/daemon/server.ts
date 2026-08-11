/**
 * Daemon HTTP Server — Bun.serve webhook 接入
 * ADR-030 / RFC-006 / S8-T08
 *
 * MVP 范围：
 * - POST /webhook/github → 解析 PR event → 调用 code-review Skill
 * - GET /health → 健康检查
 *
 * 启动方式：bun run src/daemon/server.ts
 */

import { createHmac } from "node:crypto";
import type { DaemonConfig, GitHubPREvent } from "./types.ts";
import { DaemonWorker } from "./worker.ts";

const DEFAULT_CONFIG: DaemonConfig = {
  port: 3847,
  host: "127.0.0.1",
  max_concurrent: 3,
  webhook_secret: process.env.SID_CODE_WEBHOOK_SECRET ?? "",
  workspace_base: "/tmp/sid-code-daemon/workspaces",
  storage_type: "file",
  storage_path: "/tmp/sid-code-daemon/sessions",
};

function verifySignature(payload: string, signature: string, secret: string): boolean {
  if (!secret) return true; // 开发模式无 secret 时跳过验证
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  return expected === signature;
}

function parseGitHubPREvent(body: Record<string, unknown>): GitHubPREvent | null {
  if (body.action !== "opened" && body.action !== "synchronize" && body.action !== "reopened") {
    return null;
  }
  const pr = body.pull_request as Record<string, unknown> | undefined;
  const repo = body.repository as Record<string, unknown> | undefined;
  if (!pr || !repo) return null;

  const head = pr.head as Record<string, unknown>;
  const base = pr.base as Record<string, unknown>;

  return {
    action: body.action as GitHubPREvent["action"],
    number: pr.number as number,
    repo: (repo.name as string) ?? "",
    owner: ((repo.owner as Record<string, unknown>)?.login as string) ?? "",
    branch: (head?.ref as string) ?? "",
    base_branch: (base?.ref as string) ?? "main",
    commit_sha: (head?.sha as string) ?? "",
    diff_url: (pr.diff_url as string) ?? "",
    sender: ((body.sender as Record<string, unknown>)?.login as string) ?? "",
  };
}

export function createDaemonServer(config: DaemonConfig = DEFAULT_CONFIG) {
  const worker = new DaemonWorker(config);

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // 健康检查
      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ status: "ok", version: "daemon-mvp-0.1.0" });
      }

      // GitHub webhook
      if (req.method === "POST" && url.pathname === "/webhook/github") {
        const rawBody = await req.text();

        // 验证签名
        const sig = req.headers.get("x-hub-signature-256") ?? "";
        if (!verifySignature(rawBody, sig, config.webhook_secret)) {
          return Response.json({ error: "invalid signature" }, { status: 401 });
        }

        const body = JSON.parse(rawBody) as Record<string, unknown>;
        const event = req.headers.get("x-github-event");

        if (event !== "pull_request") {
          return Response.json({ status: "ignored", reason: `event=${event}` });
        }

        const prEvent = parseGitHubPREvent(body);
        if (!prEvent) {
          return Response.json({ status: "ignored", reason: "action not supported" });
        }

        if (!worker.canAccept()) {
          return Response.json({ error: "too many concurrent requests" }, { status: 429 });
        }

        // 异步处理（不阻塞 webhook 响应）
        const resultPromise = worker.handlePR(prEvent);
        resultPromise.catch((err) => {
          console.error(`[daemon] worker error: ${err}`);
        });

        return Response.json({
          status: "accepted",
          pr: `${prEvent.owner}/${prEvent.repo}#${prEvent.number}`,
        }, { status: 202 });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  console.log(`[sid-code daemon] listening on http://${config.host}:${config.port}`);
  return server;
}

if (import.meta.main) {
  createDaemonServer();
}
