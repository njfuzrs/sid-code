/**
 * 企业市场插件的安装 / 更新（P5）。
 *
 * 安装：拉 index → 策略判定 → 下载并校验 sha256 → 解包到暂存目录 → 核 manifest →
 *       rename 到 ~/.sid-code/plugins/<name>/ → 写 installed.json（带 market 段）→ 上报 plugin_installed。
 * 更新：比对 index 里的版本号；有新版本时走同样的暂存流程，再原子换目录（旧目录先挪开，
 *       换失败就挪回来），已装版本在新包校验通过前一直可用。
 *
 * 安装前展示组件清单（skills / MCP / hooks），不再弹信任确认：上架审核是管理员的职责
 *（方案 §5.5），客户端重复确认只会训练用户闭眼点「是」。
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
  fetchMarketIndex,
  formatComponents,
  MarketError,
  resolveMarket,
  stageMarketPlugin,
  type MarketIndex,
  type MarketPlugin,
  type ResolvedMarket,
} from "./market.ts";
import { computeTreeHash } from "./tree-hash.ts";
import type { InstalledPluginEntry } from "./types.ts";
import type { OperationResult } from "./operations.ts";

const NOT_CONFIGURED =
  "未配置企业后端（backend.url），无法访问插件市场。请在 ~/.sid-code/settings.json 配置 backend.url 并执行 sid-code auth login";

function originDecision(market: ResolvedMarket) {
  return evaluatePluginOrigin(
    { kind: "market", indexUrl: market.indexUrl },
    defaultMarketIndexUrl() ?? undefined,
  );
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

/** 从 index 里挑出要装的那个版本（默认最新） */
function pickVersion(plugin: MarketPlugin, version?: string): MarketPlugin | null {
  if (!version || version === plugin.version) return plugin;
  const v = plugin.versions?.find((x) => x.version === version);
  if (!v) return null;
  return {
    ...plugin,
    version: v.version,
    sha256: v.sha256.toLowerCase(),
    size: v.size,
    artifact: `artifacts/${plugin.name}/${v.version}`,
    // 历史版本的组件清单 index 里没给，展示时如实说明
    components: undefined,
  };
}

// ─── /plugin market ───

export async function listMarket(query?: string): Promise<OperationResult> {
  const market = resolveMarket();
  if (!market) return { ok: false, error: NOT_CONFIGURED };

  const decision = originDecision(market);
  const r = await loadIndex(market);
  if (!r.ok) return { ok: false, error: r.error };

  const registry = await readInstalledPlugins();
  const q = query?.trim().toLowerCase();
  const plugins = r.index.plugins.filter(
    (p) =>
      !q || p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q),
  );

  const lines: string[] = [`企业插件市场 ${r.index.name}（${market.indexUrl}）`];
  if (r.note) lines.push(r.note);
  if (!decision.allowed) lines.push(`⚠ ${decision.reason}，只能浏览，不能安装`);
  if (plugins.length === 0) {
    lines.push(q ? `  没有匹配「${query}」的插件` : "  （市场里还没有已发布的插件）");
  }
  for (const p of plugins) {
    const installed = registry.plugins[p.name];
    let mark = "";
    if (installed?.market) {
      mark =
        compareVersions(p.version, installed.version) > 0
          ? ` [已装 ${installed.version}，可更新]`
          : " [已安装]";
    } else if (installed) {
      mark = " [同名本地插件已安装]";
    }
    lines.push(`  • ${p.name}@${p.version}${mark} — ${p.description ?? ""}`);
    if (p.maintainer) lines.push(`    维护人：${p.maintainer}`);
    for (const l of formatComponents(p.components)) lines.push(`  ${l}`);
  }
  lines.push("", `安装：/plugin install <name>@${r.index.name}`);
  return { ok: true, message: lines.join("\n") };
}

// ─── /plugin install <name>@company ───

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

async function installResolved(
  market: ResolvedMarket,
  marketName: string,
  plugin: MarketPlugin,
  action: "install" | "update",
): Promise<OperationResult> {
  const log = getLogger();
  let stagingDir: string | undefined;
  try {
    const staged = await stageMarketPlugin(market, plugin);
    stagingDir = staged.stagingDir;
    const treeHash = await computeTreeHash(stagingDir);
    const target = join(getPluginsDir(), plugin.name);
    await swapIntoPlace(stagingDir, target);
    stagingDir = undefined;

    const entry: InstalledPluginEntry = {
      name: plugin.name,
      path: target,
      source: buildPluginId(plugin.name, marketName),
      version: plugin.version,
      installedAt: new Date().toISOString(),
      enabled: true,
      market: { name: marketName, indexUrl: market.indexUrl, sha256: plugin.sha256, treeHash },
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
  const market = resolveMarket();
  if (!market) return { ok: false, error: NOT_CONFIGURED };

  const decision = originDecision(market);
  if (!decision.allowed) return { ok: false, error: decision.reason };

  const r = await loadIndex(market);
  if (!r.ok) return { ok: false, error: r.error };
  const marketName = r.index.name;
  if (source && source !== marketName) {
    return { ok: false, error: `未知市场 "${source}"，当前企业市场名为 "${marketName}"` };
  }

  const listed = r.index.plugins.find((p) => p.name === name);
  if (!listed)
    return { ok: false, error: `市场 ${marketName} 里没有插件 "${name}"（或你无权访问）` };
  const plugin = pickVersion(listed, opts?.version);
  if (!plugin) return { ok: false, error: `插件 ${name} 没有已发布的版本 ${opts?.version}` };

  const registry = await readInstalledPlugins();
  const existing = registry.plugins[name];
  if (existing) {
    return existing.market
      ? {
          ok: false,
          error: `插件 "${name}" 已从市场安装（${existing.version}），更新请用 /plugin update ${name}`,
        }
      : { ok: false, error: `已有同名本地插件 "${name}"，请先 /plugin uninstall ${name} --delete` };
  }
  if (existsSync(join(getPluginsDir(), name))) {
    return { ok: false, error: `目标目录已存在: ${join(getPluginsDir(), name)}` };
  }
  return installResolved(market, marketName, plugin, "install");
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
  if (targets.length === 0) return { ok: true, message: "没有从企业市场安装的插件" };

  const market = resolveMarket();
  if (!market) return { ok: false, error: NOT_CONFIGURED };
  const decision = originDecision(market);
  if (!decision.allowed) return { ok: false, error: decision.reason };

  const r = await loadIndex(market);
  if (!r.ok) return { ok: false, error: r.error };

  const lines: string[] = [];
  if (r.note) lines.push(r.note);
  let failed = 0;
  for (const entry of targets) {
    if (entry.market!.indexUrl !== market.indexUrl) {
      lines.push(`  ✗ ${entry.name}：来自另一个市场（${entry.market!.indexUrl}），跳过`);
      failed++;
      continue;
    }
    const listed = r.index.plugins.find((p) => p.name === entry.name);
    if (!listed) {
      lines.push(
        `  ⚠ ${entry.name}：市场里已没有这个插件（可能已下架），保留本地 ${entry.version}`,
      );
      continue;
    }
    if (compareVersions(listed.version, entry.version) <= 0) {
      lines.push(`  ✓ ${entry.name}@${entry.version} 已是最新`);
      continue;
    }
    const res = await installResolved(market, r.index.name, listed, "update");
    if (res.ok) {
      lines.push(`  ↑ ${entry.name}: ${entry.version} → ${listed.version}`);
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
