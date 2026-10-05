/**
 * 企业插件市场客户端（P5）：`MarketplaceSource{source:"url"}` 的实现。
 *
 * 服务端契约（agent-backend `marketplace/router/serve.py`，两个端点都挂 require_device）：
 * - `GET <base>/api/v1/ctl/marketplace/index` → `{schema:1, name:"company", plugins:[...]}`，带 ETag
 * - `GET <base>/api/v1/ctl/marketplace/artifacts/<name>/<version>` → application/gzip；
 *   看不见 / 不存在 / draft 一律 404，已下架 410
 *
 * 市场地址只从 `backend.url` 推出（项目级 settings 改不了它，见 backend-url.ts），
 * 所以「公司的市场」只有一个，名字取 index 里的 `name`（缺省 "company"）。
 *
 * 失败语义（方案 §6.2，同一系统里两类通道方向相反）：
 * - index 拉取：**fail-static**。拉不到就用上次缓存展示，已装插件照常加载 —— 分发通道
 *   不应因为后端挂了让所有人的工具消失。
 * - 制品下载：**fail-closed**。sha256 与 index 不一致、解包规则不过、manifest 对不上，
 *   一律拒绝且不落盘到插件目录。
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { resolveBackendUrl } from "@sid-code/core/identity/backend-url.ts";
import { backendUrl } from "@sid-code/core/identity/endpoints.ts";
import { getUsableCredentialToken, RELOGIN_HINT } from "@sid-code/core/identity/credential.ts";
import { ARCHIVE_LIMITS, ArchiveError, parseTarGz, writeEntries } from "./archive.ts";
import { getPluginsDir } from "./installed.ts";
import { validateManifest } from "./validate.ts";
import type { MarketplaceSource, PluginManifest } from "./types.ts";

/** index 里缺 name 时的市场名 */
export const DEFAULT_MARKET_NAME = "company";

const INDEX_TIMEOUT_MS = 10_000;
const ARTIFACT_TIMEOUT_MS = 60_000;

/** index 里一个插件的组件清单（服务端上传时算好，安装前原样展示） */
export interface MarketComponents {
  skills?: string[];
  commands?: string[];
  agents?: string[];
  hooks?: string[];
  mcpServers?: Array<{
    name: string;
    type?: string;
    url?: string;
    command?: string;
    auth?: string;
  }>;
}

export interface MarketPluginVersion {
  version: string;
  sha256: string;
  size: number;
  published_at?: string;
}

export interface MarketPlugin {
  name: string;
  kind?: string;
  description?: string;
  maintainer?: string;
  version: string;
  sha256: string;
  size: number;
  /** 相对 index 的路径，如 `artifacts/<name>/<version>` */
  artifact: string;
  components?: MarketComponents;
  versions?: MarketPluginVersion[];
}

export interface MarketIndex {
  schema: number;
  name: string;
  plugins: MarketPlugin[];
}

/** 一个已解析的市场：名字 + index 地址 */
export interface ResolvedMarket {
  name: string;
  indexUrl: string;
  /** 只有 index 与 backend.url 同源时才带设备凭据 */
  backendOrigin?: string;
}

export type IndexFetchResult =
  | { ok: true; index: MarketIndex; fromCache: boolean; staleReason?: string }
  | { ok: false; error: string };

export class MarketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketError";
  }
}

/** 本机 backend.url 推出的市场 index 地址。未配置 / 不合法返回 null。 */
export function defaultMarketIndexUrl(): string | null {
  const backend = resolveBackendUrl();
  return backend ? backendUrl(backend.url, "marketplace", "/index") : null;
}

/**
 * 解析市场来源。目前只实现 `source:"url"`；不传则取 backend.url 推出的企业市场。
 * 其余 source（github / git / npm / directory）仍是预留，明确报错而不是静默忽略。
 */
export function resolveMarket(source?: MarketplaceSource): ResolvedMarket | null {
  const backend = resolveBackendUrl();
  if (!source) {
    if (!backend) return null;
    return {
      name: DEFAULT_MARKET_NAME,
      indexUrl: backendUrl(backend.url, "marketplace", "/index"),
      backendOrigin: backend.origin,
    };
  }
  if (source.source !== "url" || !source.url) {
    throw new MarketError(`暂不支持的市场来源类型: ${source.source}（目前只支持 url）`);
  }
  return {
    name: DEFAULT_MARKET_NAME,
    indexUrl: source.url,
    backendOrigin: backend?.origin,
  };
}

/** 同源才带凭据：index / 制品地址一旦指向别的 origin，凭据不能跟着走 */
function authHeaders(market: ResolvedMarket, url: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return headers;
  }
  if (market.backendOrigin && origin === market.backendOrigin) {
    const token = getUsableCredentialToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function describeHttpError(status: number, what: string): string {
  if (status === 401) return `${what}被拒绝（401，设备凭据无效或已吊销）。${RELOGIN_HINT}`;
  if (status === 403) return `${what}被拒绝（403）`;
  return `${what}失败（HTTP ${status}）`;
}

// ─── index 缓存（fail-static）───

interface IndexCacheFile {
  indexUrl: string;
  etag?: string;
  index: MarketIndex;
}

function cachePath(market: ResolvedMarket): string {
  return join(getPluginsDir(), ".market-cache", `${market.name}.json`);
}

async function readIndexCache(market: ResolvedMarket): Promise<IndexCacheFile | null> {
  const p = cachePath(market);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(await readFile(p, "utf-8")) as IndexCacheFile;
    // 换了 backend.url 之后旧缓存不能冒充新市场的目录
    if (parsed?.indexUrl !== market.indexUrl) return null;
    const index = parseIndex(parsed.index);
    return { ...parsed, index };
  } catch {
    return null;
  }
}

async function writeIndexCache(market: ResolvedMarket, file: IndexCacheFile): Promise<void> {
  const p = cachePath(market);
  await mkdir(join(getPluginsDir(), ".market-cache"), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), "utf-8");
  await rename(tmp, p);
}

const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** 校验 index 形状。坏条目丢掉（不让一个坏插件挡住整个目录），整体不是对象才算失败。 */
export function parseIndex(raw: unknown): MarketIndex {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MarketError("市场 index 不是 JSON 对象");
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.plugins)) throw new MarketError("市场 index 缺少 plugins 数组");
  const name = typeof r.name === "string" && NAME_RE.test(r.name) ? r.name : DEFAULT_MARKET_NAME;
  const plugins: MarketPlugin[] = [];
  for (const p of r.plugins) {
    if (!p || typeof p !== "object") continue;
    const e = p as Record<string, unknown>;
    if (
      typeof e.name !== "string" ||
      !NAME_RE.test(e.name) ||
      typeof e.version !== "string" ||
      typeof e.sha256 !== "string" ||
      !SHA256_RE.test(e.sha256.toLowerCase()) ||
      typeof e.artifact !== "string"
    ) {
      getLogger().warn("PLUGIN", `市场 index 里有一条格式不对的插件，已跳过`);
      continue;
    }
    plugins.push({
      name: e.name,
      kind: typeof e.kind === "string" ? e.kind : undefined,
      description: typeof e.description === "string" ? e.description : undefined,
      maintainer: typeof e.maintainer === "string" ? e.maintainer : undefined,
      version: e.version,
      sha256: e.sha256.toLowerCase(),
      size: typeof e.size === "number" ? e.size : 0,
      artifact: e.artifact,
      components:
        e.components && typeof e.components === "object"
          ? (e.components as MarketComponents)
          : undefined,
      versions: Array.isArray(e.versions) ? (e.versions as MarketPluginVersion[]) : undefined,
    });
  }
  return { schema: typeof r.schema === "number" ? r.schema : 1, name, plugins };
}

/**
 * 拉 index。成功写缓存；网络错 / 5xx / 坏 JSON 时退回缓存（fromCache + staleReason）。
 * 401 / 403 **不**退回缓存：凭据被吊销后还能照旧看目录、照旧装，等于吊销没生效。
 */
export async function fetchMarketIndex(market: ResolvedMarket): Promise<IndexFetchResult> {
  const cache = await readIndexCache(market);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeaders(market, market.indexUrl),
  };
  if (cache?.etag) headers["If-None-Match"] = cache.etag;

  let res: Response;
  try {
    res = await fetch(market.indexUrl, {
      headers,
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    });
  } catch (err: any) {
    const reason = `连接市场失败: ${err?.message ?? err}`;
    return cache
      ? { ok: true, index: cache.index, fromCache: true, staleReason: reason }
      : { ok: false, error: reason };
  }

  if (res.status === 304 && cache) {
    return { ok: true, index: cache.index, fromCache: true };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: describeHttpError(res.status, "读取市场目录") };
  }
  if (!res.ok) {
    const reason = describeHttpError(res.status, "读取市场目录");
    return cache
      ? { ok: true, index: cache.index, fromCache: true, staleReason: reason }
      : { ok: false, error: reason };
  }

  try {
    const index = parseIndex(await res.json());
    const etag = res.headers.get("etag") ?? undefined;
    await writeIndexCache(market, { indexUrl: market.indexUrl, etag, index }).catch((e) =>
      getLogger().debug("PLUGIN", `写市场缓存失败: ${e}`),
    );
    return { ok: true, index, fromCache: false };
  } catch (err: any) {
    const reason = `市场目录格式不对: ${err?.message ?? err}`;
    return cache
      ? { ok: true, index: cache.index, fromCache: true, staleReason: reason }
      : { ok: false, error: reason };
  }
}

/** 制品地址 = index 地址上解析相对路径。解析后必须与 index 同源。 */
export function resolveArtifactUrl(market: ResolvedMarket, plugin: MarketPlugin): string {
  const index = new URL(market.indexUrl);
  const url = new URL(plugin.artifact, index);
  if (url.origin !== index.origin) {
    throw new MarketError(`制品地址与市场不同源，拒绝下载: ${url.href}`);
  }
  return url.href;
}

export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 下载制品并校验 sha256（与 **index 里**的值比，不信 `X-Content-SHA256` 头）。
 * 边读边计大小，超过 20 MiB 立刻中止，不先把整个响应读进内存。
 */
export async function downloadArtifact(
  market: ResolvedMarket,
  plugin: MarketPlugin,
): Promise<Buffer> {
  const url = resolveArtifactUrl(market, plugin);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: authHeaders(market, url),
      signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err: any) {
    throw new MarketError(`下载插件包失败: ${err?.message ?? err}`);
  }
  if (res.status === 404)
    throw new MarketError(`插件 ${plugin.name}@${plugin.version} 不存在或无权访问`);
  if (res.status === 410) {
    throw new MarketError(`插件 ${plugin.name}@${plugin.version} 已下架，请刷新目录后安装最新版本`);
  }
  if (!res.ok) throw new MarketError(describeHttpError(res.status, "下载插件包"));

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > ARCHIVE_LIMITS.maxCompressedBytes) {
    throw new MarketError(`插件包超过 ${ARCHIVE_LIMITS.maxCompressedBytes} 字节上限`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > ARCHIVE_LIMITS.maxCompressedBytes) {
        await reader.cancel().catch(() => {});
        throw new MarketError(`插件包超过 ${ARCHIVE_LIMITS.maxCompressedBytes} 字节上限`);
      }
      chunks.push(value);
    }
  }
  const buf = Buffer.concat(chunks);
  const actual = sha256Hex(buf);
  if (actual !== plugin.sha256) {
    throw new MarketError(
      `插件包完整性校验失败：sha256 ${actual} 与市场登记的 ${plugin.sha256} 不一致，已拒绝安装`,
    );
  }
  return buf;
}

/**
 * 市场插件的 manifest 额外约束：组件路径必须是包内相对路径（客户端 manifest.ts 对本地插件
 * 允许绝对路径，市场插件不行 —— 绝对路径等于让一个审核过的包去加载机器上任意位置的 hooks）。
 * 与服务端 package.py 的 normalize_declared_path 同口径。
 */
export function validateMarketManifestPaths(m: PluginManifest): string[] {
  const errors: string[] = [];
  const check = (field: string, p: unknown) => {
    if (typeof p !== "string") return;
    if (isAbsolute(p) || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\")) {
      errors.push(`${field} 必须是包内相对路径: ${p}`);
    } else if (p.split("/").includes("..")) {
      errors.push(`${field} 不能含 ..: ${p}`);
    }
  };
  for (const key of ["commands", "skills", "agents"] as const) {
    const v = m[key];
    for (const p of Array.isArray(v) ? v : v ? [v] : []) check(key, p);
  }
  check("hooks", m.hooks);
  if (typeof m.mcpServers === "string") check("mcpServers", m.mcpServers);
  return errors;
}

/**
 * 下载 → 校验 → 解包到插件目录下的临时目录（`.staging-*`）→ 核 manifest。
 * 成功返回暂存目录与 manifest，由调用方 rename 到正式位置；失败时暂存目录已清理。
 */
export async function stageMarketPlugin(
  market: ResolvedMarket,
  plugin: MarketPlugin,
): Promise<{ stagingDir: string; manifest: PluginManifest }> {
  const archive = await downloadArtifact(market, plugin);

  const pluginsDir = getPluginsDir();
  await mkdir(pluginsDir, { recursive: true });
  const stagingDir = join(pluginsDir, `.staging-${plugin.name}-${randomBytes(6).toString("hex")}`);
  await mkdir(stagingDir);

  try {
    let entries;
    try {
      entries = parseTarGz(archive);
    } catch (err) {
      if (err instanceof ArchiveError) throw new MarketError(`插件包不合规: ${err.message}`);
      throw err;
    }
    await writeEntries(entries, stagingDir);

    const manifestPath = join(stagingDir, "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new MarketError("插件包根目录没有 plugin.json");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(manifestPath, "utf-8"));
    } catch (err: any) {
      throw new MarketError(`plugin.json 解析失败: ${err?.message ?? err}`);
    }
    const v = validateManifest(parsed);
    if (!v.valid) throw new MarketError(`plugin.json 校验失败: ${v.errors.join("; ")}`);
    const manifest = parsed as PluginManifest;
    const pathErrors = validateMarketManifestPaths(manifest);
    if (pathErrors.length > 0)
      throw new MarketError(`plugin.json 校验失败: ${pathErrors.join("; ")}`);
    // 包里的身份必须与目录登记的一致：否则市场上「feishu-docs」装下来可能是别的东西
    if (manifest.name !== plugin.name) {
      throw new MarketError(`包内插件名 ${manifest.name} 与市场登记的 ${plugin.name} 不一致`);
    }
    if (manifest.version !== plugin.version) {
      throw new MarketError(`包内版本 ${manifest.version} 与市场登记的 ${plugin.version} 不一致`);
    }
    return { stagingDir, manifest };
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** 组件清单的人类可读渲染（安装前展示；hooks 单独醒目，因为它会在本机执行命令） */
export function formatComponents(c: MarketComponents | undefined): string[] {
  if (!c) return ["  组件：（市场未提供清单）"];
  const lines: string[] = [];
  const list = (label: string, xs?: string[]) => {
    if (xs && xs.length > 0) lines.push(`  ${label}：${xs.join(", ")}`);
  };
  list("Skills", c.skills);
  list("命令", c.commands);
  list("Agents", c.agents);
  if (c.hooks && c.hooks.length > 0) {
    lines.push(`  ⚠ Hooks（会在本机执行命令）：${c.hooks.join(", ")}`);
  }
  for (const s of c.mcpServers ?? []) {
    const where = s.url ?? s.command ?? "";
    lines.push(
      `  MCP：${s.name}${s.type ? ` [${s.type}]` : ""}${where ? ` → ${where}` : ""}${s.auth ? `（auth: ${s.auth}）` : ""}`,
    );
  }
  if (lines.length === 0) lines.push("  组件：（无）");
  return lines;
}

/** 组件计数，给 plugin_installed 事件用 */
export function countComponents(c: MarketComponents | undefined): {
  skills: number;
  commands: number;
  agents: number;
  hooks: number;
  mcpServers: number;
} {
  return {
    skills: c?.skills?.length ?? 0,
    commands: c?.commands?.length ?? 0,
    agents: c?.agents?.length ?? 0,
    hooks: c?.hooks?.length ?? 0,
    mcpServers: c?.mcpServers?.length ?? 0,
  };
}

/** semver 比较：a > b 返回正数。非 semver 时退化成字符串比较（只用于展示「可更新」）。 */
export function compareVersions(a: string, b: string): number {
  try {
    return Bun.semver.order(a, b);
  } catch {
    return a === b ? 0 : a > b ? 1 : -1;
  }
}
