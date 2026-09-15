/**
 * 自动更新 — 状态文件读写
 *
 * 状态文件路径：`~/.sid-code/updates/state.json`
 * 原子写入：tmp + rename，避免写入中途崩溃留下半份 JSON
 *
 * 读取时 JSON.parse 失败回退到空 state（视为首次启动），同时记录 warn 到 debug log
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getSidHome } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";

const log = () => getLogger();

/**
 * 更新状态 schema
 */
export interface UpdateState {
  lastCheckAt?: string; // ISO timestamp，节流依据
  consecutiveFailures: number; // ≥3 时提示一次并归零
  lastAttempt?: {
    at: string;
    fromVersion: string;
    toVersion: string;
    status: "success" | "failed";
    reason?: string;
  };
  pendingNotice?: {
    type: "updated" | "available" | "failed";
    fromVersion?: string;
    toVersion?: string;
    createdAt: string;
  };
}

const EMPTY_STATE: UpdateState = {
  consecutiveFailures: 0,
};

/**
 * 获取状态文件路径
 */
function getStatePath(): string {
  return join(getSidHome(), "updates", "state.json");
}

/**
 * 确保目录存在
 */
function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 读取更新状态（失败回退到空 state）
 */
export function readUpdateState(): UpdateState {
  const path = getStatePath();
  if (!existsSync(path)) return { ...EMPTY_STATE };

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    // 基础校验：至少要有 consecutiveFailures 字段
    if (typeof parsed.consecutiveFailures !== "number") {
      parsed.consecutiveFailures = 0;
    }
    return parsed as UpdateState;
  } catch (err) {
    log().warn("AUTO_UPDATE", `读取 state.json 失败，回退到空状态: ${err}`);
    return { ...EMPTY_STATE };
  }
}

/**
 * 原子写入更新状态（tmp + rename）
 */
export function writeUpdateState(state: UpdateState): void {
  const path = getStatePath();
  ensureDir(path);

  const tmpPath = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmpPath, path);
  } catch (err) {
    log().error("AUTO_UPDATE", `写入 state.json 失败: ${err}`);
    throw err;
  }
}

/**
 * 原子 patch 状态（读取 → 合并 → 写入）
 */
export function patchUpdateState(patch: Partial<UpdateState>): UpdateState {
  const current = readUpdateState();
  const next = { ...current, ...patch };
  writeUpdateState(next);
  return next;
}
