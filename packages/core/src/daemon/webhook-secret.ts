/**
 * webhook secret 的来源解析。
 *
 * 为什么需要文件这条路：launchd / systemd user 拉起的服务进程**不继承**交互 shell 里
 * export 的变量，`daemon install --webhook` 装出来的服务拿不到 SID_CODE_WEBHOOK_SECRET，
 * webhook 静默不启动（只在 daemon.log 留一条 warn）。
 *
 * 为什么不把 secret 写进 plist / unit：`~/Library/LaunchAgents` 与 `~/.config/systemd/user`
 * 下的文件通常是 644，等于明文给本机所有用户看。所以 install 把 secret 写进
 * `state/daemon-webhook-secret`（0600），daemon 启动时环境变量缺省才读它。
 *
 * 优先级：环境变量 > secret 文件。环境变量显式设成空串也算「没有」，回落到文件。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";

export function webhookSecretFile(): string {
  return sidPaths.stateFile("daemon-webhook-secret");
}

/** 解析 daemon 进程可用的 webhook secret；都没有返回空串 */
export function resolveWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.SID_CODE_WEBHOOK_SECRET ?? "";
  if (fromEnv !== "") return fromEnv;
  const path = webhookSecretFile();
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

/** 以 0600 写入 secret 文件（install 用） */
export function writeWebhookSecretFile(secret: string): string {
  const path = webhookSecretFile();
  mkdirSync(dirname(path), { recursive: true });
  // mode 只在新建时生效；文件已存在（可能是 644）时再 chmod 一次收紧
  writeFileSync(path, secret + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
