/**
 * 市场插件的浏览 / 安装 / 更新（P5 企业市场 → 内置 Skill 下沉方案 P2 多市场）。
 *
 * 安装：选市场 → 策略判定 → 拉 index → 下载并校验 sha256 → 解包到暂存目录 → 核 manifest →
 *       rename 到 ~/.sid-code/plugins/<name>/ → 写 installed.json（带 market 段）→ 上报 plugin_installed。
 * 更新：每个插件回**它自己安装时的那个市场**比对版本；有新版本时走同样的暂存流程再原子换目录。
 *
 * 多市场下的两条硬约束（方案 §6.2）：
 * - 市场名由本机配置决定（企业 company / 官方 sid-code / extraKnownMarketplaces 的键），
 *   不取 index 自报的 name —— 否则两个市场能自称同名，缓存与安装标识互相冒充。
 * - 同名插件只能装一份。插件运行时命名空间是 `/插件名:skill名`，两个同名插件不可能共存；
 *   所以跨市场同名一律**拒绝并提示**，而不是后装的静默覆盖先装的（P1 前就是后者）。
 *
 * 安装前展示组件清单（skills / MCP / hooks），不再弹信任确认：上架审核是管理员 / 仓库 PR 的职责。
 */

import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { evaluatePluginOrigin } from "@sid-code/core/config/plugin-only-policy.ts";
import { logPluginInstalled } from "@sid-code/core/analytics/events.ts";
import { clearAllPluginCaches } from "./caches.ts";
import { buildPluginId, parsePluginId } from "./identifier.ts";
import { getPluginsDir, readInstalledPlugins, registerPlugin } from "./installed.ts";
import {
  compareVersions,
  countComponents,
  defaultMarketIndexUrl,
  execSignature,
  fetchMarketIndex,
  findMarket,
  formatComponents,
  MarketError,
  resolveMarkets,
  stageMarketPlugin,
  type MarketIndex,
  type MarketPlugin,
  type ResolvedMarket,
} from "./market.ts";
import { computeTreeHash } from "./tree-hash.ts";
import type { InstalledPluginEntry } from "./types.ts";
import type { OperationResult } from "./operations.ts";

const NO_MARKET =
  "没有可用的插件市场：官方市场 sid-code 已被 officialMarketplace:false 关闭，且未配置企业后端（backend.url）或 extraKnownMarketplaces";

export function originDecision(market: ResolvedMarket) {
  return evaluatePluginOrigin(
    { kind: "market", indexUrl: market.indexUrl },
    defaultMarketIndexUrl() ?? undefined,
  );
}

function marketNames(): string {
  return resolveMarkets()
    .map((m) => m.name)
    .join(" / ");
}

/** 按名字选市场；不传名字时：只有一个市场就用它，多个则要求显式指定 */
function pickMarket(
  name?: string,
): { ok: true; market: ResolvedMarket } | { ok: false; error: string } {
  const markets = resolveMarkets();
  if (markets.length === 0) return { ok: false, error: NO_MARKET };
  if (name) {
    const m = markets.find((x) => x.name === name);
    return m
      ? { ok: true, market: m }
      : { ok: false, error: `未知市场 "${name}"，已注册的市场：${marketNames()}` };
  }
  if (markets.length === 1) return { ok: true, market: markets[0]! };
  return {
    ok: false,
    error: `已注册多个市场（${marketNames()}），请写成 <插件名>@<市场名>`,
  };
}

/** 拉目录。失败时返回 OperationResult 形式的错误，成功附带「用的是缓存」提示 */
async function loadIndex(
  market: ResolvedMarket,
): Promise<{ ok: true; index: MarketIndex; note?: string } | { ok: false; error: string }> {
  const r = await fetchMarketIndex(market);
  if (!r.ok) return r;
  const note = r.staleReason ? `⚠ ${r.staleReason}，以下为上次缓存的目录` : undefined;
  return { ok: true, index: r.index, note };
}

/**
 * 从 index 里挑出要装的那个版本（默认最新）。
 * 历史版本的制品地址：versions[i].artifact 优先；否则把当前版本地址里的版本段换掉 ——
 * 原先硬编码 `artifacts/<name>/<version>`，对后端成立、对静态市场（带 .tar.gz）不成立。
 */
export function pickVersion(plugin: MarketPlugin, version?: string): MarketPlugin | null {
  if (!version || version === plugin.version) return plugin;
  const v = plugin.versions?.find((x) => x.version === version);
  if (!v) return null;
  const derived = plugin.artifact.includes(`/${plugin.version}`)
    ? plugin.artifact.replace(`/${plugin.version}`, `/${v.version}`)
    : `artifacts/${plugin.name}/${v.version}`;
  return {
    ...plugin,
    version: v.version,
    sha256: v.sha256.toLowerCase(),
    size: v.size,
    artifact: v.artifact ?? derived,
    // 历史版本的组件清单 index 里没给，展示时如实说明
    components: undefined,
  };
}

const KIND_LABEL: Record<string, string> = { skill: "skill 包", plugin: "插件", mcp: "MCP 包" };

// ─── /plugin market [--market <name>] [关键词] ───

async function listOneMarket(
  market: ResolvedMarket,
  q: string | undefined,
  registry: Awaited<ReturnType<typeof readInstalledPlugins>>,
): Promise<string[]> {
  const kindTitle =
    market.kind === "official"
      ? "官方插件市场"
      : market.kind === "company"
        ? "企业插件市场"
        : "插件市场";
  const lines: string[] = [`${kindTitle} ${market.name}（${market.indexUrl}）`];
  const decision = originDecision(market);
  const r = await loadIndex(market);
  if (!r.ok) {
    lines.push(`  ✗ ${r.error}`);
    return lines;
  }
  if (r.note) lines.push(`  ${r.note}`);
  if (!decision.allowed) lines.push(`  ⚠ ${decision.reason}，只能浏览，不能安装`);
  const plugins = r.index.plugins.filter(
    (p) =>
      !q || p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q),
  );
  if (plugins.length === 0) {
    lines.push(q ? `  没有匹配「${q}」的插件` : "  （市场里还没有已发布的插件）");
  }
  for (const p of plugins) {
    const installed = registry.plugins[p.name];
    let mark = "";
    if (installed?.market?.name === market.name) {
      mark =
        compareVersions(p.version, installed.version) > 0
          ? ` [已装 ${installed.version}，可更新]`
          : " [已安装]";
    } else if (installed?.market) {
      mark = ` [同名插件已从 ${installed.market.name} 安装]`;
    } else if (installed) {
      mark = " [同名本地插件已安装]";
    }
    const kind = p.kind && KIND_LABEL[p.kind] ? `〔${KIND_LABEL[p.kind]}〕` : "";
    lines.push(`  • ${p.name}@${p.version}${kind}${mark} — ${p.description ?? ""}`);
    if (p.maintainer) lines.push(`    维护人：${p.maintainer}`);
    for (const l of formatComponents(p.components)) lines.push(`  ${l}`);
  }
  lines.push(`  安装：/plugin install <name>@${market.name}`);
  return lines;
}

export async function listMarket(
  query?: string,
  opts?: { market?: string },
): Promise<OperationResult> {
  const all = resolveMarkets();
  if (all.length === 0) return { ok: false, error: NO_MARKET };
  let markets = all;
  if (opts?.market) {
    const m = all.find((x) => x.name === opts.market);
    if (!m)
      return { ok: false, error: `未知市场 "${opts.market}"，已注册的市场：${marketNames()}` };
    markets = [m];
  }
  const registry = await readInstalledPlugins();
  const q = query?.trim().toLowerCase() || undefined;
  const sections: string[][] = [];
  for (const m of markets) sections.push(await listOneMarket(m, q, registry));
  // 每个市场都拉不到才算整体失败（单市场时即 P5 语义：401 等错误要让调用方看到 ok:false）；
  // 只要有一个市场可用就照常展示，失败的那个在自己的段落里标 ✗。
  const failures = sections.map((s) => s.find((l) => l.startsWith("  ✗ ")));
  if (failures.every(Boolean)) {
    return {
      ok: false,
      error:
        markets.length === 1
          ? failures[0]!.slice(4)
          : markets.map((m, i) => `${m.name}: ${failures[i]!.slice(4)}`).join("\n"),
    };
  }
  return { ok: true, message: sections.map((s) => s.join("\n")).join("\n\n") };
}

// ─── /plugin marketplaces ───

export function listMarketplaces(): OperationResult {
  const markets = resolveMarkets();
  if (markets.length === 0) return { ok: false, error: NO_MARKET };
  const lines = ["已注册的插件市场："];
  for (const m of markets) {
    const d = originDecision(m);
    const label = m.kind === "official" ? "官方" : m.kind === "company" ? "企业" : "额外";
    lines.push(`  • ${m.name}〔${label}〕 ${m.indexUrl}${d.allowed ? "" : `  ⚠ ${d.reason}`}`);
  }
  return { ok: true, message: lines.join("\n") };
}

// ─── /plugin install <name>@<market> ───

/** 判断 `/plugin install` 的参数是不是市场插件标识（`name@market`，且不像路径） */
export function isMarketSpec(arg: string): boolean {
  if (arg.includes("/") || arg.includes("\\") || arg.startsWith(".") || arg.startsWith("~")) {
    return false;
  }
  const { source } = parsePluginId(arg);
  return !!source && source !== "local" && source !== "builtin" && source !== "inline";
}

/** 把暂存目录换到正式位置；目标已有目录时先挪开，失败时挪回 */
async function swapIntoPlace(stagingDir: string, target: string): Promise<void> {
  let backup: string | undefined;
  if (existsSync(target)) {
    backup = join(getPluginsDir(), `.old-${randomBytes(6).toString("hex")}`);
    await rename(target, backup);
  }
  try {
    await rename(stagingDir, target);
  } catch (err) {
    if (backup) await rename(backup, target).catch(() => {});
    throw err;
  }
  if (backup) await rm(backup, { recursive: true, force: true }).catch(() => {});
}

export async function installResolved(
  market: ResolvedMarket,
  plugin: MarketPlugin,
  action: "install" | "update",
): Promise<OperationResult> {
  const log = getLogger();
  const marketName = market.name;
  let stagingDir: string | undefined;
  try {
    const staged = await stageMarketPlugin(market, plugin);
    stagingDir = staged.stagingDir;
    const treeHash = await computeTreeHash(stagingDir);
    const target = join(getPluginsDir(), plugin.name);
    await swapIntoPlace(stagingDir, target);
    stagingDir = undefined;

    const sig = execSignature(plugin.components);
    const entry: InstalledPluginEntry = {
      name: plugin.name,
      path: target,
      source: buildPluginId(plugin.name, marketName),
      version: plugin.version,
      installedAt: new Date().toISOString(),
      enabled: true,
      market: {
        name: marketName,
        indexUrl: market.indexUrl,
        sha256: plugin.sha256,
        treeHash,
        ...(sig ? { execSignature: sig } : {}),
      },
    };
    await registerPlugin(entry);
    clearAllPluginCaches();

    try {
      logPluginInstalled({
        pluginName: plugin.name,
        marketplace: marketName,
        version: plugin.version,
        action,
        components: countComponents(plugin.components),
      });
    } catch (e) {
      log.debug("PLUGIN", `plugin_installed 上报失败: ${e}`);
    }
    log.info(
      "PLUGIN",
      `已从市场${action === "update" ? "更新" : "安装"} ${entry.source}@${plugin.version}`,
    );

    const lines = [
      `${action === "update" ? "已更新" : "已安装"} ${plugin.name}@${plugin.version}（来源 ${marketName}，sha256 已校验）`,
      ...formatComponents(plugin.components),
    ];
    return { ok: true, message: lines.join("\n") };
  } catch (err: any) {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    const msg = err instanceof MarketError ? err.message : `安装失败: ${err?.message ?? err}`;
    return { ok: false, error: msg };
  }
}

export async function installFromMarket(
  spec: string,
  opts?: { version?: string },
): Promise<OperationResult> {
  const { name, source } = parsePluginId(spec);
  const picked = pickMarket(source);
  if (!picked.ok) return picked;
  const market = picked.market;

  const decision = originDecision(market);
  if (!decision.allowed) return { ok: false, error: decision.reason };

  // 同名检查放在拉 index 之前：已装的那份来自哪里与目录内容无关，不必为它联网
  const registry = await readInstalledPlugins();
  const existing = registry.plugins[name];
  if (existing) {
    if (existing.market?.name === market.name) {
      return {
        ok: false,
        error: `插件 "${name}" 已从市场 ${market.name} 安装（${existing.version}），更新请用 /plugin update ${name}`,
      };
    }
    if (existing.market) {
      return {
        ok: false,
        error: `已从市场 ${existing.market.name} 安装了同名插件 "${name}"（${existing.source}）。同名插件只能装一份：先 /plugin uninstall ${name} --delete，再装 ${name}@${market.name}`,
      };
    }
    return {
      ok: false,
      error: `已有同名本地插件 "${name}"，请先 /plugin uninstall ${name} --delete`,
    };
  }
  if (existsSync(join(getPluginsDir(), name))) {
    return { ok: false, error: `目标目录已存在: ${join(getPluginsDir(), name)}` };
  }

  const r = await loadIndex(market);
  if (!r.ok) return { ok: false, error: r.error };
  const listed = r.index.plugins.find((p) => p.name === name);
  if (!listed)
    return { ok: false, error: `市场 ${market.name} 里没有插件 "${name}"（或你无权访问）` };
  const plugin = pickVersion(listed, opts?.version);
  if (!plugin) return { ok: false, error: `插件 ${name} 没有已发布的版本 ${opts?.version}` };
  return installResolved(market, plugin, "install");
}

// ─── /plugin update [name] ───

export async function updateFromMarket(name?: string): Promise<OperationResult> {
  const registry = await readInstalledPlugins();
  const targets = Object.values(registry.plugins).filter(
    (e) => e.market && (!name || e.name === parsePluginId(name).name),
  );
  if (name && targets.length === 0) {
    const e = registry.plugins[parsePluginId(name).name];
    return {
      ok: false,
      error: e ? `插件 "${e.name}" 不是从市场安装的，无法更新` : `插件 "${name}" 未安装`,
    };
  }
  if (targets.length === 0) return { ok: true, message: "没有从插件市场安装的插件" };

  const lines: string[] = [];
  let failed = 0;
  // 同一市场的 index 只拉一次
  const indexCache = new Map<string, Awaited<ReturnType<typeof loadIndex>>>();
  for (const entry of targets) {
    const market = findMarket(entry.market!.name);
    if (!market || market.indexUrl !== entry.market!.indexUrl) {
      lines.push(
        `  ✗ ${entry.name}：安装来源市场 ${entry.market!.name}（${entry.market!.indexUrl}）已不在本机配置里，跳过`,
      );
      failed++;
      continue;
    }
    const decision = originDecision(market);
    if (!decision.allowed) {
      lines.push(`  ✗ ${entry.name}：${decision.reason}`);
      failed++;
      continue;
    }
    let r = indexCache.get(market.name);
    if (!r) {
      r = await loadIndex(market);
      indexCache.set(market.name, r);
      if (r.ok && r.note) lines.push(`  ${market.name}: ${r.note}`);
    }
    if (!r.ok) {
      lines.push(`  ✗ ${entry.name}：${r.error}`);
      failed++;
      continue;
    }
    const listed = r.index.plugins.find((p) => p.name === entry.name);
    if (!listed) {
      lines.push(
        `  ⚠ ${entry.name}：市场 ${market.name} 里已没有这个插件（可能已下架），保留本地 ${entry.version}`,
      );
      continue;
    }
    if (compareVersions(listed.version, entry.version) <= 0) {
      lines.push(`  ✓ ${entry.name}@${entry.version} 已是最新`);
      continue;
    }
    const res = await installResolved(market, listed, "update");
    if (res.ok) {
      lines.push(`  ↑ ${entry.name}: ${entry.version} → ${listed.version}（${market.name}）`);
      lines.push(...formatComponents(listed.components).map((l) => `  ${l}`));
    } else {
      failed++;
      lines.push(`  ✗ ${entry.name}：${res.error}（保留本地 ${entry.version}）`);
    }
  }
  const message = lines.join("\n");
  return failed > 0 && failed === targets.length
    ? { ok: false, error: message }
    : { ok: true, message };
}
