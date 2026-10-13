/**
 * 市场插件的启动期自动更新（内置 Skill 下沉方案 P2 §6.2 第 5 条，对齐 CC 默认值）。
 *
 * 策略（按市场）：
 * - 官方市场 sid-code 默认**自动升级**：内容走仓库 PR review，信任点前移到了 ruleset；
 * - 企业 / 额外市场默认**只提示**：管理员用 managed settings 的
 *   `pluginMarketplaceAutoUpdate: { "company": true }` 打开；
 * - 两条与市场无关的硬边界：
 *   1. **只升级已装的插件，从不新装**（与 rejected「发布即自动推送安装」是两回事）；
 *   2. 新版本的 hooks / MCP 与已装版本不同（含「市场没给清单、无法判断」）时**不静默升级**，
 *      改为提示用户手动 `/plugin update` —— hooks 会在本机执行命令，自动升级这一步
 *      不能比首次安装还宽松。
 *
 * 成本：只有装了市场插件时才联网；每个市场一次 index 请求，带 ETag，未变时是 304。
 * 失败一律静默（记日志）：启动路径上的后台任务不该打扰用户。
 */

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { getPluginsDir, readInstalledPlugins } from "./installed.ts";
import {
  compareVersions,
  EMPTY_EXEC_SIGNATURE,
  execSignature,
  fetchMarketIndex,
  findMarket,
  isMarketAutoUpdate,
} from "./market.ts";
import { installResolved, originDecision } from "./market-operations.ts";
import type { InstalledPluginEntry } from "./types.ts";

export interface PluginAutoUpdateResult {
  /** 已静默升级的：name from → to */
  updated: Array<{ name: string; from: string; to: string; market: string }>;
  /** 有新版本但没自动升级的（市场未开自动更新 / hooks 或 MCP 变了 / 升级失败） */
  pending: Array<{ name: string; from: string; to: string; market: string; reason: string }>;
}

/** 锁超过这个时长视为上一个进程崩了留下的残骸 */
const LOCK_STALE_MS = 10 * 60_000;

function acquireLock(): (() => void) | null {
  const dir = join(getPluginsDir(), ".auto-update.lock");
  try {
    mkdirSync(getPluginsDir(), { recursive: true });
    if (existsSync(dir) && Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) {
      rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(dir);
  } catch {
    return null; // 另一个实例正在更新
  }
  return () => rmSync(dir, { recursive: true, force: true });
}

/**
 * 判断能否静默升级。返回 null = 可以；否则返回不能的原因。
 * 新版本什么都不执行（指纹 = 空）时总是可以：没有 hooks / MCP 就谈不上「执行面变宽」。
 */
export function silentUpgradeBlocker(
  entry: InstalledPluginEntry,
  newSig: string | undefined,
): string | null {
  if (newSig === undefined) return "市场未提供新版本的组件清单，无法确认 hooks / MCP 是否变化";
  if (newSig === EMPTY_EXEC_SIGNATURE) return null;
  const oldSig = entry.market?.execSignature;
  if (oldSig === undefined) return "已装版本没有 hooks / MCP 记录，无法确认是否变化";
  return oldSig === newSig ? null : "新版本的 hooks / MCP 有变化，需要你确认";
}

export async function runPluginAutoUpdate(): Promise<PluginAutoUpdateResult> {
  const result: PluginAutoUpdateResult = { updated: [], pending: [] };
  const log = getLogger();
  const registry = await readInstalledPlugins();
  const entries = Object.values(registry.plugins).filter((e) => e.market && e.enabled);
  if (entries.length === 0) return result;

  const release = acquireLock();
  if (!release) {
    log.info("PLUGIN", "插件自动更新：另一个实例正在运行，跳过");
    return result;
  }
  try {
    const byMarket = new Map<string, InstalledPluginEntry[]>();
    for (const e of entries) {
      const list = byMarket.get(e.market!.name) ?? [];
      list.push(e);
      byMarket.set(e.market!.name, list);
    }

    for (const [marketName, list] of byMarket) {
      const market = findMarket(marketName);
      // 来源市场已从配置里移除 / 地址变了：不去别的地方找同名插件
      if (!market) continue;
      if (!originDecision(market).allowed) continue;
      const auto = isMarketAutoUpdate(market);
      const r = await fetchMarketIndex(market);
      if (!r.ok || r.staleReason) continue; // 拉不到最新目录就不动，缓存里的「新版本」不可信

      for (const entry of list) {
        if (entry.market!.indexUrl !== market.indexUrl) continue;
        const listed = r.index.plugins.find((p) => p.name === entry.name);
        if (!listed || compareVersions(listed.version, entry.version) <= 0) continue;
        const base = {
          name: entry.name,
          from: entry.version,
          to: listed.version,
          market: marketName,
        };
        if (!auto) {
          result.pending.push({ ...base, reason: `市场 ${marketName} 未开启自动更新` });
          continue;
        }
        const blocker = silentUpgradeBlocker(entry, execSignature(listed.components));
        if (blocker) {
          result.pending.push({ ...base, reason: blocker });
          continue;
        }
        const res = await installResolved(market, listed, "update");
        if (res.ok) result.updated.push(base);
        else result.pending.push({ ...base, reason: `自动升级失败：${res.error}` });
      }
    }
  } catch (err) {
    log.warn("PLUGIN", `插件自动更新异常（已忽略）: ${err}`);
  } finally {
    release();
  }
  if (result.updated.length || result.pending.length) {
    log.info(
      "PLUGIN",
      `插件自动更新：升级 ${result.updated.length} 个，待确认 ${result.pending.length} 个`,
    );
  }
  return result;
}

/** 给状态栏 / 瞬时提示用的一行文案；没有可说的返回 null */
export function formatAutoUpdateNotice(r: PluginAutoUpdateResult): string | null {
  const parts: string[] = [];
  if (r.updated.length > 0) {
    parts.push(
      `已自动更新插件 ${r.updated.map((u) => `${u.name} ${u.from}→${u.to}`).join("、")}（/reload-plugins 生效）`,
    );
  }
  if (r.pending.length > 0) {
    parts.push(
      `插件有新版本：${r.pending.map((p) => `${p.name}@${p.to}`).join("、")}，运行 /plugin update 查看`,
    );
  }
  return parts.length ? parts.join("；") : null;
}
