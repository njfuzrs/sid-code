/**
 * 插件发现与加载核心（只有一层完整加载）
 *
 * 每次加载都要读 installed.json、逐个读 plugin.json、校验目录，即「完整加载」。
 * 这里**不存在**零磁盘扫描的 cache-only 路径：
 * - 组件路径 / hooks / MCP / skills 全部来自 plugin.json，跳过磁盘就拿不到完整结果；
 * - 内置插件也可能是磁盘上没有的纯定义（builtin.ts），缓存键无法只靠名字判定新鲜度。
 *
 * 因此两个导出共用同一个 memoize 实例：
 * - loadAllPlugins：完整加载，REPL 挂载后后台执行；
 * - loadAllPluginsCacheOnly：同一实例的兼容别名，5 个组件 loader 与 hooks-cli 仍按旧名 import。
 * memoize 提供的是「进程内单次执行」保证（并发调用共享同一个 Promise），不是磁盘缓存。
 * 需要重新加载走 clearAllPluginCaches() → /reload-plugins。
 *
 * ⚠️ 曾经按「cache-only vs full」分成两层，但形参从未被读取，两层跑的是同一遍磁盘扫描，
 * 只在文件头写了不存在的承诺。故意收成一层（缺陷 23），不要再加回一个换汤不换药的形参。
 *
 * 加载来源优先级（高 → 低，同名时先放入者占名）：
 *   1. 会话级插件（@inline，--plugin-dir 指定）
 *   2. 已安装插件（@local，~/.sid-code/plugins/{name}/）
 *   3. 内置插件（@builtin，path = "builtin"）
 */

import { existsSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { memoize } from "@sid-code/shared/utils/memoize.ts";
import { registerPluginCache } from "./caches.ts";
import type { LoadedPlugin, PluginError, PluginLoadResult } from "./types.ts";
import { getPluginsDir, readInstalledPlugins } from "./installed.ts";
import { loadPluginFromDirectory } from "./manifest.ts";
import { getBuiltinPlugins } from "./builtin.ts";
import { verifyAndDemote } from "./dependency.ts";
import {
  evaluatePluginOrigin,
  isPluginOriginLocked,
  type PluginOrigin,
} from "@sid-code/core/config/plugin-only-policy.ts";
import { defaultMarketIndexUrl } from "./market.ts";
import { computeTreeHash } from "./tree-hash.ts";
import type { InstalledPluginEntry } from "./types.ts";
import { setMarketPlugins } from "@sid-code/core/analytics/plugin-attribution.ts";

/** 会话级插件目录（由 CLI --plugin-dir 设置，进程内全局） */
let inlinePluginDirs: string[] = [];

/** 设置会话级插件目录（在加载前由 cli.ts 调用） */
export function setInlinePluginDirs(dirs: string[]): void {
  inlinePluginDirs = dirs.map((d) => resolve(d));
}

/** 获取会话级插件目录 */
export function getInlinePluginDirs(): string[] {
  return [...inlinePluginDirs];
}

/**
 * 企业策略的插件来源门（P5，strictKnownMarketplaces / strictPluginOnlyCustomization）。
 * 未锁定时零开销直接放行；锁定时本地 / inline 一律拒，市场插件还要复核目录指纹 ——
 * installed.json 是本机文件，只看 `market` 段等于让手改一行 JSON 就能把本地目录洗成市场插件。
 */
async function checkPluginOrigin(
  origin: PluginOrigin,
  source: string,
  errors: PluginError[],
  entry?: InstalledPluginEntry,
): Promise<boolean> {
  if (!isPluginOriginLocked()) return true;
  const decision = evaluatePluginOrigin(origin, defaultMarketIndexUrl() ?? undefined);
  if (!decision.allowed) {
    errors.push({ type: "policy-blocked", source, reason: decision.reason });
    getLogger().warn("PLUGIN", `企业策略拒绝加载插件 ${source}: ${decision.reason}`);
    return false;
  }
  if (origin.kind === "market" && entry?.market) {
    let actual: string;
    try {
      actual = await computeTreeHash(entry.path);
    } catch (err: any) {
      actual = `error:${err?.message ?? err}`;
    }
    if (actual !== entry.market.treeHash) {
      const reason = "插件目录内容与市场安装时不一致（被修改过），请 /plugin update 或重新安装";
      errors.push({ type: "policy-blocked", source, reason });
      getLogger().warn("PLUGIN", `企业策略拒绝加载插件 ${source}: ${reason}`);
      return false;
    }
  }
  return true;
}

/**
 * 判断某个路径是否落在插件根目录之内。
 * 用 path.relative 而不是裸字符串前缀：`/a/plugins-evil` 以 `/a/plugins` 开头但不是它的子目录。
 * 空 rel（等于根目录本身）也算不在「之内」——插件必须有自己的目录。
 */
function isInsidePluginsDir(target: string, pluginsDir: string): boolean {
  const rel = relative(resolve(pluginsDir), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 加载已安装插件（从 installed.json + 磁盘目录）
 *
 * installed.json 是用户可编辑的 JSON 文件，路径与键名都不能无条件信任：
 * - path 必须是非空绝对路径字符串，且（除 --no-copy 的 external 条目外）落在插件目录内，
 *   否则手改一行 JSON 就能让加载器扫描任意目录；
 * - 键名必须与 plugin.json 的 name 一致：operations 按键名操作注册表，而 builtinOverrides /
 *   运行时按 manifest.name，两者不一致会让启用/禁用静默失效（缺陷 29）。
 */
async function loadInstalledPlugins(errors: PluginError[]): Promise<LoadedPlugin[]> {
  const registry = await readInstalledPlugins();
  const plugins: LoadedPlugin[] = [];
  const pluginsDir = getPluginsDir();

  for (const [key, entry] of Object.entries(registry.plugins)) {
    // 结构校验用 any 承接：installed.json 来自磁盘，字段可能缺、类型也可能不对
    const raw = entry as Partial<InstalledPluginEntry> | null;
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof raw.path !== "string" ||
      !isAbsolute(raw.path)
    ) {
      errors.push({
        type: "generic-error",
        source: key,
        error: "installed.json 条目无效：path 必须是绝对路径字符串",
      });
      continue;
    }
    // --no-copy 安装是显式原地引用（entry.external === true），允许在插件目录之外
    if (entry.external !== true && !isInsidePluginsDir(entry.path, pluginsDir)) {
      errors.push({
        type: "path-escape",
        source: entry.source ?? key,
        path: entry.path,
        component: "commands",
      });
      continue;
    }
    if (!existsSync(entry.path)) {
      errors.push({
        type: "path-not-found",
        source: entry.source,
        path: entry.path,
      });
      continue;
    }
    const origin: PluginOrigin = entry.market
      ? { kind: "market", indexUrl: entry.market.indexUrl }
      : { kind: "local" };
    if (!(await checkPluginOrigin(origin, entry.source, errors, entry))) continue;
    // 市场插件的标识符后缀用市场名（feishu-docs@company），本地仍是 @local
    const sourceKind = entry.market?.name ?? "local";
    const plugin = await loadPluginFromDirectory(entry.path, sourceKind, entry.enabled, errors);
    if (plugin) {
      // 键名与 manifest.name 不一致时 fail-closed：两处分别按键名/按 name 查表，
      // 加载进来只会得到「启用/禁用静默失效」的插件，不如直接跳过并报错
      if (key !== plugin.name) {
        errors.push({
          type: "generic-error",
          source: entry.source ?? key,
          error: `installed.json 键名 "${key}" 与 plugin.json 的 name "${plugin.name}" 不一致，已跳过`,
        });
        continue;
      }
      // installed.json 中的 enabled 状态优先
      plugin.enabled = entry.enabled;
      if (entry.market) plugin.marketplace = entry.market.name;
      plugins.push(plugin);
    }
  }

  return plugins;
}

/** 加载会话级插件（--plugin-dir） */
async function loadInlinePlugins(errors: PluginError[]): Promise<LoadedPlugin[]> {
  const plugins: LoadedPlugin[] = [];
  for (const dir of inlinePluginDirs) {
    if (!existsSync(dir)) {
      errors.push({
        type: "path-not-found",
        source: `${dir}@inline`,
        path: dir,
      });
      continue;
    }
    if (!(await checkPluginOrigin({ kind: "inline" }, `${dir}@inline`, errors))) continue;
    const plugin = await loadPluginFromDirectory(dir, "inline", true, errors);
    if (plugin) plugins.push(plugin);
  }
  return plugins;
}

/**
 * 合并所有插件来源，去重：inline > installed > builtin，先放入者占名。
 * inline 最高，便于 --plugin-dir 调试时覆盖同名内置 / 已安装插件；
 * 被同名插件顶掉的一方记为 duplicate-name 错误。
 * 形参顺序与真实优先级一致（缺陷 26：旧签名是 (builtin, installed, inline)，
 * 与函数体的展开顺序相反，照签名理解会得出反的结论）。
 */
function mergePluginSources(
  inline: LoadedPlugin[],
  installed: LoadedPlugin[],
  builtin: LoadedPlugin[],
  errors: PluginError[],
): LoadedPlugin[] {
  const byName = new Map<string, LoadedPlugin>();
  for (const plugin of [...inline, ...installed, ...builtin]) {
    const existing = byName.get(plugin.name);
    if (existing) {
      errors.push({
        type: "duplicate-name",
        source: plugin.source,
        existingSource: existing.source,
      });
      continue;
    }
    byName.set(plugin.name, plugin);
  }
  return [...byName.values()];
}

/** 按 enabled 字段分类 */
function applyEnabledState(plugins: LoadedPlugin[]): {
  enabled: LoadedPlugin[];
  disabled: LoadedPlugin[];
} {
  const enabled: LoadedPlugin[] = [];
  const disabled: LoadedPlugin[] = [];
  for (const p of plugins) {
    if (p.enabled) enabled.push(p);
    else disabled.push(p);
  }
  return { enabled, disabled };
}

/** 组装插件加载结果（核心流程，唯一的加载层） */
async function assemblePluginLoadResult(): Promise<PluginLoadResult> {
  const errors: PluginError[] = [];

  // 1. 读取已安装注册表（用于内置插件的启用覆盖）
  const registry = await readInstalledPlugins();
  const builtinOverrides: Record<string, boolean> = {};
  for (const [name, entry] of Object.entries(registry.plugins)) {
    if (entry.source.endsWith("@builtin")) {
      builtinOverrides[name] = entry.enabled;
    }
  }

  // 2. 各来源加载
  const installedPlugins = await loadInstalledPlugins(errors);
  const inlinePlugins = await loadInlinePlugins(errors);
  const builtinPlugins = getBuiltinPlugins(builtinOverrides);

  // 3. 合并去重（inline > installed > builtin）
  const merged = mergePluginSources(inlinePlugins, installedPlugins, builtinPlugins, errors);

  // 4. 启用/禁用分类
  const { enabled, disabled } = applyEnabledState(merged);

  // 5. 依赖验证（固定点降级）
  const demoted = verifyAndDemote(enabled, disabled);
  errors.push(...demoted.errors);

  // 6. tool_invoked 归因注册表：只放启用中的市场插件（整表替换，卸载 / 禁用后随之消失）。
  //    inline 能覆盖同名已装插件，被覆盖时 merge 已经把市场那份丢掉，这里自然不会误归因。
  setMarketPlugins(
    demoted.enabled
      .filter((p) => p.marketplace)
      .map((p) => ({ name: p.name, marketplace: p.marketplace! })),
  );

  return { enabled: demoted.enabled, disabled: demoted.disabled, errors };
}

/**
 * 完整加载：读 installed.json、逐个读 plugin.json 并校验目录。
 * memoize 保证进程内只执行一次（并发调用共享同一个 Promise），
 * 所以不再需要「完成后预热 cache-only slot」这类跨 slot 同步——两个名字就是同一个实例。
 */
export const loadAllPlugins = memoize(async (): Promise<PluginLoadResult> => {
  const result = await assemblePluginLoadResult();

  if (result.errors.length > 0) {
    const log = getLogger();
    log.warn(
      "PLUGIN",
      `插件加载完成，${result.enabled.length} 启用 / ${result.disabled.length} 禁用 / ${result.errors.length} 错误`,
    );
  }
  return result;
});

/**
 * 兼容别名：启动关键路径的组件 loader（loadPluginCommands/Skills/Agents/Mcp/Hooks、hooks-cli）
 * 仍按旧名 import。它**不是**零磁盘扫描路径，与 loadAllPlugins 是同一个 memoize 实例，
 * 因此 .cache / .clear 也共享，不存在两个 slot 不一致或 clear 后被旧结果写回的竞态。
 */
export const loadAllPluginsCacheOnly = loadAllPlugins;

// 注册缓存清除（供 clearAllPluginCaches）。两个导出是同一引用，只需也只会注册一次。
registerPluginCache(loadAllPlugins.clear);
