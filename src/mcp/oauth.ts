/**
 * MCP OAuth 2.1 全链路实现
 *
 * 对标 Claude Code services/mcp/auth.ts，但 CC 把重活委托给
 * @modelcontextprotocol/sdk；sid-code 自研传输层、不依赖该 SDK，因此本模块
 * 从零实现 OAuth 标准流程：
 *
 *   RFC 9728  受保护资源元数据发现（/.well-known/oauth-protected-resource）
 *   RFC 8414  授权服务器元数据发现（/.well-known/oauth-authorization-server）
 *   RFC 7591  动态客户端注册（无预配置 client_id 时自动注册）
 *   RFC 7636  PKCE（S256 code_challenge）
 *   OAuth 2.1 授权码流程 + refresh_token 刷新 + RFC 7009 token 撤销
 *
 * 公共客户端（token_endpoint_auth_method=none）+ PKCE 是默认姿态；
 * 若配置/注册带回 client_secret 则走机密客户端。
 */

import { createHash, randomBytes } from "node:crypto";
import type { MCPServerConfig } from "../config/config.ts";
import { getLogger } from "../debug/logger.ts";
import {
  getOAuthEntry,
  saveTokens,
  saveClientInformation,
  saveDiscoveryState,
  clearOAuthEntry,
  type MCPOAuthEntry,
} from "./oauth-storage.ts";
import { startCallbackServer } from "./oauth-callback-server.ts";
import { withRefreshLock } from "./oauth-lock.ts";

/** OAuth 请求超时（ms），对标 CC AUTH_REQUEST_TIMEOUT_MS */
const AUTH_REQUEST_TIMEOUT_MS = 30_000;
/** 授权流程整体超时（ms）：等待用户在浏览器完成授权 */
const AUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;
/** token 过期提前刷新阈值（秒）：剩余不足此值即主动刷新 */
const PROACTIVE_REFRESH_THRESHOLD_S = 300;

/** 授权服务器元数据（RFC 8414 子集，仅取我们需要的字段） */
export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  grant_types_supported?: string[];
}

/** 受保护资源元数据（RFC 9728 子集） */
interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
}

/** token 端点返回的 token 集 */
export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** 授权流程取消错误（用户 ESC / abort） */
export class AuthenticationCancelledError extends Error {
  constructor() {
    super("OAuth 授权已取消");
    this.name = "AuthenticationCancelledError";
  }
}

/** 需要交互式授权的信号（无有效 token 且无法静默刷新） */
export class NeedsAuthorizationError extends Error {
  constructor(public readonly serverName: string) {
    super(`MCP 服务器 ${serverName} 需要 OAuth 授权`);
    this.name = "NeedsAuthorizationError";
  }
}

// ─── 带超时的 fetch ───

/** 在外部 signal 基础上叠加请求超时；POST 失败时规范化 OAuth 错误体 */
async function authFetch(url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS);
  const signals: AbortSignal[] = [timeoutSignal];
  if (init?.signal) signals.push(init.signal);
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  return fetch(url, { ...init, signal });
}

// ─── PKCE ───

/** 生成 PKCE code_verifier（43-128 字符的 base64url 随机串，RFC 7636 §4.1） */
function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** 由 verifier 派生 S256 code_challenge（RFC 7636 §4.2） */
function deriveCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** 生成 CSRF state（防授权码注入） */
function generateState(): string {
  return randomBytes(32).toString("base64url");
}

// ─── Discovery ───

/** 拼接 .well-known 路径，保留服务器原始 path（兼容把元数据托管在子路径的服务器） */
function wellKnownUrl(base: URL, wellKnown: string): string {
  const path = base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "");
  return `${base.origin}/.well-known/${wellKnown}${path}`;
}

/** 判断主机是否为 loopback（本地回环，允许 http） */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * 校验 URL 安全性，防 SSRF。OAuth 端点（除 loopback 外）必须 https。
 * 用于校验来自远程响应的 URL（如 RFC 9728 返回的 authorization_servers），
 * 这些是 SSRF 的主要入口——授权服务器若被攻破可诱导客户端访问内网地址。
 * @throws URL 非 http(s) 协议、或非 loopback 的 http
 */
function assertSafeOAuthUrl(rawUrl: string, context: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${context}：无效的 URL "${rawUrl}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${context}：URL 必须使用 http(s) 协议（当前 ${url.protocol}）`);
  }
  // 非 loopback 的 http 拒绝（明文传输 token 风险 + SSRF）
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error(`${context}：非本地地址必须使用 https://（当前 ${rawUrl}）`);
  }
  return url;
}

/**
 * 发现授权服务器元数据。
 * 顺序对标 CC fetchAuthServerMetadata：
 * 1. 配置直指 metadata URL → 直接拉取（强制 https）
 * 2. RFC 9728：探测受保护资源元数据，取 authorization_servers[0]，再 RFC 8414
 * 3. 回退：直接对 MCP 服务器 URL 做 RFC 8414（path-aware + root 两种探测）
 */
export async function discoverAuthServerMetadata(
  serverName: string,
  serverUrl: string,
  config: MCPServerConfig,
  signal?: AbortSignal,
  resourceMetadataUrl?: string,
): Promise<AuthServerMetadata | undefined> {
  const log = getLogger();
  const configuredUrl = config.oauth?.authServerMetadataUrl;

  // 1. 配置直指
  if (configuredUrl) {
    if (!configuredUrl.startsWith("https://")) {
      throw new Error(`authServerMetadataUrl 必须使用 https://（当前: ${configuredUrl}）`);
    }
    const resp = await authFetch(configuredUrl, { headers: { Accept: "application/json" }, signal });
    if (resp.ok) {
      const meta = (await resp.json()) as AuthServerMetadata;
      // SSRF 防护：即便 metadata URL 是配置的，返回的端点仍来自远程响应，需校验
      if (meta.authorization_endpoint) assertSafeOAuthUrl(meta.authorization_endpoint, "authorization_endpoint");
      if (meta.token_endpoint) assertSafeOAuthUrl(meta.token_endpoint, "token_endpoint");
      if (meta.registration_endpoint) assertSafeOAuthUrl(meta.registration_endpoint, "registration_endpoint");
      return meta;
    }
    throw new Error(`拉取配置的授权服务器元数据失败 HTTP ${resp.status}`);
  }

  // 2. RFC 9728 受保护资源元数据 → authorization_servers[0]
  try {
    const prmUrl = resourceMetadataUrl ?? wellKnownUrl(new URL(serverUrl), "oauth-protected-resource");
    const prmResp = await authFetch(prmUrl, { headers: { Accept: "application/json" }, signal });
    if (prmResp.ok) {
      const prm = (await prmResp.json()) as ProtectedResourceMetadata;
      const asUrl = prm.authorization_servers?.[0];
      if (asUrl) {
        // SSRF 防护：authorization_servers 来自远程响应，校验后才用
        assertSafeOAuthUrl(asUrl, "RFC 9728 authorization_servers");
        log.debug("MCP", `${serverName} RFC 9728 发现授权服务器: ${asUrl}`);
        const meta = await fetchAS8414(asUrl, signal);
        if (meta) return meta;
      }
    }
  } catch (err) {
    log.debug("MCP", `${serverName} RFC 9728 发现失败，回退: ${(err as Error).message}`);
  }

  // 3. 回退：直接对 MCP 服务器 URL 做 RFC 8414
  const meta = await fetchAS8414(serverUrl, signal);
  if (meta) return meta;

  log.warn("MCP", `${serverName} 无法发现 OAuth 授权服务器元数据`);
  return undefined;
}

/** 对给定 URL 做 RFC 8414 授权服务器元数据探测（先 path-aware 再 root） */
async function fetchAS8414(asUrl: string, signal?: AbortSignal): Promise<AuthServerMetadata | undefined> {
  const base = new URL(asUrl);
  const candidates = new Set<string>([
    wellKnownUrl(base, "oauth-authorization-server"),
    `${base.origin}/.well-known/oauth-authorization-server`,
    // OIDC 回退（部分授权服务器只暴露 OIDC discovery）
    wellKnownUrl(base, "openid-configuration"),
    `${base.origin}/.well-known/openid-configuration`,
  ]);

  for (const url of candidates) {
    try {
      const resp = await authFetch(url, { headers: { Accept: "application/json" }, signal });
      if (resp.ok) {
        const meta = (await resp.json()) as AuthServerMetadata;
        if (meta.authorization_endpoint && meta.token_endpoint) {
          // SSRF 防护：metadata 的端点来自远程响应，逐个校验协议安全
          assertSafeOAuthUrl(meta.authorization_endpoint, "authorization_endpoint");
          assertSafeOAuthUrl(meta.token_endpoint, "token_endpoint");
          if (meta.registration_endpoint) {
            assertSafeOAuthUrl(meta.registration_endpoint, "registration_endpoint");
          }
          return meta;
        }
      }
    } catch {
      // 试下一个候选
    }
  }
  return undefined;
}

// ─── RFC 7591 动态客户端注册 ───

/**
 * 动态注册公共客户端（RFC 7591）。返回 client_id（及可能的 client_secret）。
 * 授权服务器无 registration_endpoint 时抛错——调用方需引导用户预配置 client_id。
 */
async function registerClient(
  serverName: string,
  metadata: AuthServerMetadata,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<{ client_id: string; client_secret?: string }> {
  const log = getLogger();
  if (!metadata.registration_endpoint) {
    throw new Error(
      `授权服务器不支持动态注册（无 registration_endpoint）。请在配置中预设 oauth.clientId。`,
    );
  }

  const body = {
    client_name: `sid-code (${serverName})`,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none", // 公共客户端
    ...(metadata.scopes_supported ? { scope: metadata.scopes_supported.join(" ") } : {}),
  };

  const resp = await authFetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`动态客户端注册失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const registered = (await resp.json()) as { client_id: string; client_secret?: string };
  if (!registered.client_id) {
    throw new Error("动态注册响应缺少 client_id");
  }
  log.debug("MCP", `${serverName} 动态注册成功，client_id=${registered.client_id.slice(0, 8)}…`);
  return registered;
}

// ─── token 端点交互 ───

/** 用授权码换取 token（PKCE 校验） */
async function exchangeCodeForTokens(
  metadata: AuthServerMetadata,
  params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    clientId: string;
    clientSecret?: string;
    resource: string;
  },
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    client_id: params.clientId,
    // RFC 8707 资源指示器：把 token 受众绑定到本 MCP 服务器
    resource: params.resource,
  });
  if (params.clientSecret) {
    body.set("client_secret", params.clientSecret);
  }

  const resp = await authFetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`授权码换 token 失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as OAuthTokens;
}

/** 用 refresh_token 刷新 access_token */
async function refreshTokens(
  metadata: AuthServerMetadata,
  params: { refreshToken: string; clientId: string; clientSecret?: string; resource: string; scope?: string },
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    resource: params.resource,
  });
  if (params.clientSecret) body.set("client_secret", params.clientSecret);
  if (params.scope) body.set("scope", params.scope);

  const resp = await authFetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    // invalid_grant 表示 refresh_token 已失效/撤销，调用方应清 token 并重新授权
    if (resp.status === 400 && text.includes("invalid_grant")) {
      const err = new Error("refresh_token 已失效");
      err.name = "InvalidGrantError";
      throw err;
    }
    throw new Error(`刷新 token 失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as OAuthTokens;
}

// ─── 公开 API ───

/**
 * 完整的交互式 OAuth 授权流程：
 *   发现元数据 → (动态注册) → 启本地回调服务器 → 打开授权 URL →
 *   等待回调拿授权码 → PKCE 换 token → 持久化。
 *
 * @param onAuthorizationUrl 拿到授权 URL 时回调（供 UI 展示 / 打开浏览器）
 * @returns 成功换取的 token
 */
export async function performOAuthFlow(
  serverName: string,
  config: MCPServerConfig,
  onAuthorizationUrl: (url: string) => void,
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  const log = getLogger();
  if (!config.url) {
    throw new Error(`MCP 服务器 ${serverName} 缺少 url，无法进行 OAuth`);
  }
  const serverUrl = config.url;

  // 注意：不在流程开头清旧 token。若用户取消/流程失败，旧 token 应保留（仍可能可用）。
  // 仅在成功换取新 token 后由 saveTokens 覆盖。

  // 1. 发现授权服务器元数据
  const metadata = await discoverAuthServerMetadata(serverName, serverUrl, config, signal);
  if (!metadata) {
    throw new Error(
      `无法发现 ${serverName} 的 OAuth 授权服务器。该服务器可能不支持 OAuth，或需在配置中指定 oauth.authServerMetadataUrl。`,
    );
  }
  // 持久化 discovery 状态，后续刷新免重新发现
  saveDiscoveryState(serverName, config, { authorizationServerUrl: metadata.issuer });

  // 2. 拿到 client_id：优先配置 / 已注册，否则动态注册
  const { clientId, clientSecret, redirectUri, callback } = await prepareClient(
    serverName,
    config,
    metadata,
    signal,
  );

  try {
    // 3. 构造 PKCE + state，拼授权 URL
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);
    const state = generateState();
    const scope = config.oauth?.scope ?? metadata.scopes_supported?.join(" ");

    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("resource", serverUrl); // RFC 8707
    if (scope) authUrl.searchParams.set("scope", scope);

    log.info("MCP", `${serverName} 等待用户在浏览器完成 OAuth 授权…`);
    onAuthorizationUrl(authUrl.toString());

    // 4. 等待回调拿授权码（带 CSRF state 校验 + 超时 + abort）
    const code = await callback.waitForCode(state, AUTH_FLOW_TIMEOUT_MS, signal);

    // 5. PKCE 换 token
    const tokens = await exchangeCodeForTokens(
      metadata,
      { code, redirectUri, codeVerifier, clientId, clientSecret, resource: serverUrl },
      signal,
    );

    // 6. 持久化
    saveTokens(serverName, config, tokens);
    log.info("MCP", `${serverName} OAuth 授权成功`);
    return tokens;
  } finally {
    callback.close();
  }
}

/**
 * 准备 client：决定 client_id 来源并启动回调服务器（回调服务器先于授权 URL 启动，
 * 因为 redirect_uri 的端口要写进授权 URL）。
 */
async function prepareClient(
  serverName: string,
  config: MCPServerConfig,
  metadata: AuthServerMetadata,
  signal?: AbortSignal,
): Promise<{
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  callback: Awaited<ReturnType<typeof startCallbackServer>>;
}> {
  // 启动本地回调服务器（固定端口或随机空闲端口）
  const callback = await startCallbackServer(config.oauth?.callbackPort);
  const redirectUri = callback.redirectUri;

  try {
    // a. 配置预设 client_id
    if (config.oauth?.clientId) {
      return { clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, redirectUri, callback };
    }
    // b. 已动态注册过（存储里有 client_id）
    const existing = getOAuthEntry(serverName, config);
    if (existing?.clientId) {
      return { clientId: existing.clientId, clientSecret: existing.clientSecret, redirectUri, callback };
    }
    // c. 动态注册（注册时要带本次的 redirect_uri）
    const registered = await registerClient(serverName, metadata, redirectUri, signal);
    saveClientInformation(serverName, config, registered);
    return { clientId: registered.client_id, clientSecret: registered.client_secret, redirectUri, callback };
  } catch (err) {
    callback.close();
    throw err;
  }
}

/**
 * 取得用于请求的有效 access token。逻辑对标 CC ClaudeAuthProvider.tokens()：
 *   - 无凭据 → 抛 NeedsAuthorizationError
 *   - 未过期 → 直接返回
 *   - 即将过期/已过期且有 refresh_token → 跨进程加锁后刷新
 *   - 已过期且无 refresh_token → 抛 NeedsAuthorizationError
 *
 * 不触发交互式流程（那需要 UI/浏览器）；交互由 performOAuthFlow 负责。
 */
export async function getValidAccessToken(
  serverName: string,
  config: MCPServerConfig,
  signal?: AbortSignal,
): Promise<string> {
  const log = getLogger();
  const entry = getOAuthEntry(serverName, config);

  if (!entry || (!entry.accessToken && !entry.refreshToken)) {
    throw new NeedsAuthorizationError(serverName);
  }

  const expiresInS = (entry.expiresAt - Date.now()) / 1000;

  // 未过期且不在提前刷新窗口内 → 直接用
  if (entry.accessToken && expiresInS > PROACTIVE_REFRESH_THRESHOLD_S) {
    return entry.accessToken;
  }

  // 需要刷新但无 refresh_token
  if (!entry.refreshToken) {
    if (entry.accessToken && expiresInS > 0) {
      // 还没过期，凑合用（无法刷新，等真正 401 再说）
      return entry.accessToken;
    }
    throw new NeedsAuthorizationError(serverName);
  }

  // 跨进程加锁刷新（避免多实例并发刷新互相作废 refresh_token）
  const refreshed = await withRefreshLock(serverName, config, async () => {
    // 拿到锁后重读，可能别的进程已刷新
    const fresh = getOAuthEntry(serverName, config);
    if (fresh && fresh.accessToken && (fresh.expiresAt - Date.now()) / 1000 > PROACTIVE_REFRESH_THRESHOLD_S) {
      log.debug("MCP", `${serverName} token 已被其它进程刷新，复用`);
      return fresh.accessToken;
    }
    const refreshToken = fresh?.refreshToken ?? entry.refreshToken!;
    return await doRefresh(serverName, config, refreshToken, signal);
  });

  return refreshed;
}

/** 执行一次刷新：发现/复用 metadata → 调 token 端点 → 持久化新 token */
async function doRefresh(
  serverName: string,
  config: MCPServerConfig,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<string> {
  const log = getLogger();
  const entry = getOAuthEntry(serverName, config);

  // 复用 discovery 状态拿 metadata（免每次刷新都重新发现）
  const asUrl = entry?.discoveryState?.authorizationServerUrl ?? config.url!;
  const metadata = await fetchAS8414(asUrl, signal)
    ?? await discoverAuthServerMetadata(serverName, config.url!, config, signal);
  if (!metadata) {
    throw new Error(`刷新 token 时无法发现授权服务器元数据`);
  }

  const clientId = config.oauth?.clientId ?? entry?.clientId;
  if (!clientId) {
    throw new NeedsAuthorizationError(serverName);
  }
  const clientSecret = config.oauth?.clientSecret ?? entry?.clientSecret;

  try {
    const tokens = await refreshTokens(
      metadata,
      { refreshToken, clientId, clientSecret, resource: config.url!, scope: entry?.scope },
      signal,
    );
    // RFC 6749 §6：刷新返回的 scope 必须是原始授予 scope 的子集（narrow-or-equal）。
    // 防止恶意/配置错误的授权服务器在刷新时悄悄扩权，超出用户最初的授权范围。
    if (entry?.scope && tokens.scope) {
      const original = new Set(entry.scope.trim().split(/\s+/).filter(Boolean));
      const returned = tokens.scope.trim().split(/\s+/).filter(Boolean);
      const escalated = returned.filter((s) => !original.has(s));
      if (escalated.length > 0) {
        throw new Error(
          `刷新 token 时检测到 scope 越权（RFC 6749 §6）：授权服务器返回了未授予的 scope [${escalated.join(", ")}]`,
        );
      }
    }
    // 部分授权服务器刷新时不回 refresh_token —— 保留旧的
    if (!tokens.refresh_token) tokens.refresh_token = refreshToken;
    saveTokens(serverName, config, tokens);
    log.info("MCP", `${serverName} token 刷新成功`);
    return tokens.access_token;
  } catch (err) {
    if ((err as Error).name === "InvalidGrantError") {
      // refresh_token 失效，清 token，需重新授权
      log.warn("MCP", `${serverName} refresh_token 失效，需重新授权`);
      clearOAuthEntry(serverName, config, "tokens");
      throw new NeedsAuthorizationError(serverName);
    }
    throw err;
  }
}

/** 该服务器是否配置了 OAuth（oauth 字段存在即视为启用） */
export function isOAuthEnabled(config: MCPServerConfig): boolean {
  return config.oauth !== undefined;
}

export type { MCPOAuthEntry };
