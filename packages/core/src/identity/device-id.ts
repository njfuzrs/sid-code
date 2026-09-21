/**
 * 本机持久 deviceId（M1 PR-1.1）。
 *
 * 首次启动写 UUIDv4，权限 0o600；损坏 / 为空则重新生成并告警，不静默。
 * 读盘结果缓存在进程内——同一进程多次取值必须稳定，否则四方落盘对不上。
 *
 * 路径走 sidPaths.deviceId()，尊重 SID_CONFIG_DIR。测试必须把配置根指到 tmpdir。
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";

/** 规范 UUID 形态（不强制 version nibble=4：存量只要形状合法就保留，避免无谓重建） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cached: string | null = null;

function isValidDeviceId(value: string): boolean {
  return UUID_RE.test(value);
}

function persist(id: string, path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, `${id}\n`, { mode: 0o600, encoding: "utf-8" });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* 部分平台 umask 已处理；chmod 失败不阻断启动 */
  }
}

/**
 * 返回本机 deviceId：已有且合法则沿用，否则生成新的 UUIDv4 并落盘。
 * 永不抛错——身份通道 fail-open，写盘失败时仍返回内存中的新 id，下次启动再试。
 */
export function getOrCreateDeviceId(): string {
  if (cached) return cached;

  const path = sidPaths.deviceId();
  const log = getLogger();

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8").trim();
      if (isValidDeviceId(raw)) {
        cached = raw;
        return cached;
      }
      log.warn("IDENTITY", `device-id 文件损坏或为空，已重新生成: ${path}`);
    } catch (err) {
      log.warn("IDENTITY", `读取 device-id 失败，已重新生成: ${(err as Error).message}`);
    }
  } else {
    // 验收：删文件后重建有告警。首次启动同样走这条——「新设备」对运维是有用信号，不是噪音。
    log.warn("IDENTITY", `device-id 不存在，已生成新 id: ${path}`);
  }

  const id = randomUUID();
  try {
    persist(id, path);
  } catch (err) {
    log.warn("IDENTITY", `写入 device-id 失败（本进程仍使用新 id）: ${(err as Error).message}`);
  }
  cached = id;
  return cached;
}

/** 仅测试：清进程内缓存，模拟「第二次启动」重读磁盘。 */
export function __resetDeviceIdCacheForTest(): void {
  cached = null;
}
