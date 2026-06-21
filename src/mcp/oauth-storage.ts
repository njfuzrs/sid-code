/**
 * MCP OAuth 凭据存储
 *
 * 持久化远程 MCP 服务器的 OAuth 凭据：access/refresh token、动态注册得到的
 * client_id/client_secret、以及 discovery 状态（授权服务器 URL / 资源元数据 URL）。
 * 对标 Claude Code SecureStorageData.mcpOAuth，但 sid-code 无 keychain 依赖，
 * 落盘到 ~/.sid-code/mcp-oauth.json（文件权限 0600，仅当前用户可读写）。
 *
 * Server Key 设计（对标 CC getServerKey）：用 serverName + 配置哈希做键，
 * 防止「同名但不同 URL/headers」的服务器复用彼此凭据。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { MCPServerConfig } from "../config/config.ts";
import { sidPaths } from "../config/paths.ts";
import { getLogger } from "../debug/logger.ts";

/** 单个 MCP 服务器的 OAuth 凭据条目 */
export interface MCPOAuthEntry {
  serverName: string;
  serverUrl: string;
  /** access token（可能为空字符串，表示已注册 client 但尚未拿到 token） */
  accessToken: string;
  /** refresh token（授权服务器可能不下发） */
  refreshToken?: string;
  /** access token 过期的绝对时间戳（ms）。0 表示无 token */
  expiresAt: number;
  /** 已授予的 scope（空格分隔） */
  scope?: string;
  /** 动态注册（RFC 7591）得到的 client_id，或预配置 client_id */
  clientId?: string;
  /** 机密客户端的 client_secret */
  clientSecret?: string;
  /** discovery 状态：缓存授权服务器 URL，避免每次刷新都重新 RFC 9728/8414 发现 */
  discoveryState?: {
    /** 授权服务器 issuer URL（token/authorize 端点的来源） */
    authorizationServerUrl: string;
    /** RFC 9728 受保护资源元数据 URL（401 WWW-Authenticate 带出的） */
    resourceMetadataUrl?: string;
  };
}

/** 存储文件结构 */
interface OAuthStorageData {
  /** serverKey → 凭据条目 */
  mcpOAuth: Record<string, MCPOAuthEntry>;
}

/**
 * 为服务器生成稳定的存储键：serverName | sha256(type+url+headers)[:16]。
 * 配置变化（换 URL / 换 header）会产生新键，强制重新授权，避免凭据错配。
 * 对标 CC getServerKey。
 */
export function getServerKey(serverName: string, config: MCPServerConfig): string {
  const configJson = JSON.stringify({
    transport: config.transport,
    url: config.url ?? "",
    headers: config.headers ?? {},
  });
  const hash = createHash("sha256").update(configJson).digest("hex").substring(0, 16);
  return `${serverName}|${hash}`;
}

/** 读取整个存储文件（不存在或损坏时返回空结构） */
function readStorage(): OAuthStorageData {
  const path = sidPaths.mcpOAuth();
  if (!existsSync(path)) {
    return { mcpOAuth: {} };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<OAuthStorageData>;
    return { mcpOAuth: parsed.mcpOAuth ?? {} };
  } catch (err) {
    getLogger().warn("MCP", `OAuth 存储文件解析失败，已忽略: ${(err as Error).message}`);
    return { mcpOAuth: {} };
  }
}

/** 原子写入存储文件，权限收紧到 0600 */
function writeStorage(data: OAuthStorageData): void {
  const path = sidPaths.mcpOAuth();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // 先写临时文件再 rename，避免并发写出现半截文件
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  // Bun/Node 的 renameSync 在同目录下是原子的
  try {
    // 同分区原子替换
    renameSync(tmpPath, path);
  } catch {
    // 回退：直接覆盖写
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { unlinkSync(tmpPath); } catch {}
  }
  // 双保险：确保权限位正确（部分平台 writeFile 的 mode 受 umask 影响）
  try { chmodSync(path, 0o600); } catch {}
}

/** 读取指定服务器的 OAuth 凭据条目 */
export function getOAuthEntry(serverName: string, config: MCPServerConfig): MCPOAuthEntry | undefined {
  const key = getServerKey(serverName, config);
  return readStorage().mcpOAuth[key];
}

/**
 * 合并更新指定服务器的 OAuth 凭据条目（浅合并到现有条目）。
 * 始终补齐 serverName / serverUrl / accessToken / expiresAt 必填字段。
 */
export function updateOAuthEntry(
  serverName: string,
  config: MCPServerConfig,
  patch: Partial<MCPOAuthEntry>,
): void {
  const key = getServerKey(serverName, config);
  const data = readStorage();
  const existing = data.mcpOAuth[key];
  data.mcpOAuth[key] = {
    ...existing,
    ...patch,
    // 必填字段兜底：优先用 patch，其次现有值，最后默认值
    serverName,
    serverUrl: config.url ?? existing?.serverUrl ?? "",
    accessToken: patch.accessToken ?? existing?.accessToken ?? "",
    expiresAt: patch.expiresAt ?? existing?.expiresAt ?? 0,
  };
  writeStorage(data);
}

/** 保存 token（来自授权码交换或刷新） */
export function saveTokens(
  serverName: string,
  config: MCPServerConfig,
  tokens: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string },
): void {
  updateOAuthEntry(serverName, config, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    // expires_in 缺省按 1 小时算（OAuth 2.1 推荐但非强制下发）
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    scope: tokens.scope,
  });
}

/** 保存动态注册得到的 client 信息 */
export function saveClientInformation(
  serverName: string,
  config: MCPServerConfig,
  client: { client_id: string; client_secret?: string },
): void {
  updateOAuthEntry(serverName, config, {
    clientId: client.client_id,
    clientSecret: client.client_secret,
  });
}

/** 保存 discovery 状态（授权服务器 URL 等） */
export function saveDiscoveryState(
  serverName: string,
  config: MCPServerConfig,
  state: { authorizationServerUrl: string; resourceMetadataUrl?: string },
): void {
  updateOAuthEntry(serverName, config, { discoveryState: state });
}

/**
 * 清除指定服务器的凭据。
 * - scope='tokens'：仅清 token（保留 client 注册信息与 discovery，下次免重新注册）
 * - scope='all'：删除整个条目
 */
export function clearOAuthEntry(
  serverName: string,
  config: MCPServerConfig,
  scope: "all" | "tokens" = "all",
): void {
  const key = getServerKey(serverName, config);
  const data = readStorage();
  const entry = data.mcpOAuth[key];
  if (!entry) return;

  if (scope === "all") {
    delete data.mcpOAuth[key];
  } else {
    entry.accessToken = "";
    entry.refreshToken = undefined;
    entry.expiresAt = 0;
  }
  writeStorage(data);
}

/**
 * 判断「已探测过 OAuth 但当前无任何可用凭据」的状态。
 * 这种状态下连接必定 401，唯一出路是用户重新走授权流程。
 * 对标 CC hasMcpDiscoveryButNoToken。
 */
export function hasDiscoveryButNoToken(serverName: string, config: MCPServerConfig): boolean {
  const entry = getOAuthEntry(serverName, config);
  return entry !== undefined && !entry.accessToken && !entry.refreshToken;
}
