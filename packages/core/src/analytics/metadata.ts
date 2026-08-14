// src/analytics/metadata.ts
// 事件元数据富化——收集环境上下文
//
// 对应 spec 17 §5.3。
// 首次调用时收集并缓存。可变字段(model/provider/mcp_server_count)可刷新。
// 输出以 _ctx_ 前缀注入到每个事件,值类型对齐 EventMetadataValue(boolean|number|string-branded)。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { EventMetadata, VerifiedNotCodeOrFilepaths } from "./index.ts";
import { asVerified } from "./types.ts";
import { getUserBucket } from "./user-bucket.ts";
import { getRawVersion } from "@sid-code/shared/version.ts";

interface EventMetadataContext {
  session_id: string;
  platform: string; // darwin / linux / win32
  arch: string; // x64 / arm64
  node_version: string; // Bun/Node 版本
  terminal: string | null;
  is_ci: boolean;
  version: string;
  model: string;
  provider: string;
  vcs_type: string | null;
  repo_hash: string | null;
  is_interactive: boolean;
  mcp_server_count: number;
}

let cachedContext: EventMetadataContext | null = null;

/**
 * 标记字符串为已确认安全(内部辅助)。
 *
 * 委托给 types.ts 的 asVerified,不再手写 cast——见 events.ts 同名函数的说明。
 */
function v(s: string): VerifiedNotCodeOrFilepaths {
  return asVerified(s);
}

/**
 * 预置可变字段(session/model/provider 等),通常在初始化时调用。
 * 触发首次上下文收集。
 */
export function primeMetadata(updates: {
  sessionId?: string;
  model?: string;
  provider?: string;
  mcpServerCount?: number;
}): void {
  const ctx = getEventMetadata();
  if (updates.sessionId) ctx.session_id = updates.sessionId;
  if (updates.model) ctx.model = updates.model;
  if (updates.provider) ctx.provider = updates.provider;
  if (updates.mcpServerCount !== undefined) ctx.mcp_server_count = updates.mcpServerCount;
}

/**
 * 获取事件元数据上下文。首次调用时收集,后续返回缓存值。
 */
export function getEventMetadata(): EventMetadataContext {
  if (cachedContext) return cachedContext;
  cachedContext = collectMetadata();
  return cachedContext;
}

/** 刷新可变字段(如 model 切换后调用) */
export function refreshMetadata(
  updates: Partial<Pick<EventMetadataContext, "model" | "provider" | "mcp_server_count">>,
): void {
  if (cachedContext) {
    Object.assign(cachedContext, updates);
  }
}

/**
 * 返回要合并进每个事件的 _ctx_ 字段(EventMetadata 形态)。
 * 供 sink.setMetadataHook 使用。
 */
export function getEventMetadataFields(): EventMetadata {
  const ctx = getEventMetadata();
  const fields: EventMetadata = {
    _ctx_session_id: v(ctx.session_id),
    _ctx_platform: v(ctx.platform),
    _ctx_arch: v(ctx.arch),
    _ctx_node_version: v(ctx.node_version),
    _ctx_version: v(ctx.version),
    _ctx_is_ci: ctx.is_ci,
    _ctx_is_interactive: ctx.is_interactive,
    _ctx_model: v(ctx.model),
    _ctx_provider: v(ctx.provider),
    _ctx_mcp_server_count: ctx.mcp_server_count,
    _ctx_user_bucket: getUserBucket(ctx.session_id),
  };
  if (ctx.terminal) fields._ctx_terminal = v(ctx.terminal);
  if (ctx.vcs_type) fields._ctx_vcs_type = v(ctx.vcs_type);
  if (ctx.repo_hash) fields._ctx_repo_hash = v(ctx.repo_hash);
  return fields;
}

/** 重置缓存(仅测试用) */
export function __resetMetadataForTest(): void {
  cachedContext = null;
}

// --- 内部实现 ---

function collectMetadata(): EventMetadataContext {
  return {
    session_id: "unknown",
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    terminal: detectTerminal(),
    is_ci: detectCI(),
    version: getVersion(),
    model: "unknown",
    provider: "unknown",
    is_interactive: process.stdin?.isTTY ?? false,
    vcs_type: detectVCS(),
    repo_hash: computeRepoHash(),
    mcp_server_count: 0,
  };
}

function detectTerminal(): string | null {
  return process.env.TERM_PROGRAM ?? process.env.TERMINAL_EMULATOR ?? null;
}

function detectCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.JENKINS_URL ||
    process.env.CIRCLECI
  );
}

function detectVCS(): string | null {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return "git";
  } catch {
    return null;
  }
}

/**
 * 计算仓库远程 URL 的哈希。
 * 只取前 16 字符——足以关联同一仓库的事件,但无法反推 URL。
 */
function computeRepoHash(): string | null {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!remote) return null;
    return createHash("sha256").update(remote).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * 事件的版本维度。
 *
 * ⚠️ 这里曾是 `process.env.SID_CODE_VERSION ?? "dev"` —— 一个**遮蔽**了
 * `@sid-code/shared/version.ts` 的同名局部函数。而 `SID_CODE_VERSION` 全仓只有
 * 安装脚本在读（用于锁定下载版本），运行时无人设置，于是**每个发布版本的每条事件
 * 都标成 `dev`**（实测本机 3658 条事件的 `_ctx_version` 全部为 `"dev"`）。
 *
 * 后果不是"少一个字段"，而是**四大方向全部退化成一次性快照**：版本维度是
 * release-over-release 趋势的唯一分组键，值恒定即无法分组。而故障完全静默——
 * 字段在、管道在、非空、类型正确，只有值是废的，任何断言都不会红。
 *
 * 取 `getRawVersion()`（裸 `x.y.z`）而非 `getVersion()`：后者返回
 * `"sid-code v0.1.6xx (TypeScript)"`，带前后缀的字符串当分组键要下游反复剥壳。
 * env 覆盖保留在最前，便于灰度/回放时手动打标。
 */
function getVersion(): string {
  return process.env.SID_CODE_VERSION ?? getRawVersion();
}
