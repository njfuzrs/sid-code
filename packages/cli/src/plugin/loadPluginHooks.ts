/**
 * 插件 Hooks 加载：收集所有启用插件的 hooks，原子注册到 HookSystem
 *
 * 关键设计：原子交换（对标 Claude Code gh-29767 教训）
 * - 旧 hooks 一直有效，直到新 hooks 准备好替换
 * - 通过 HookSystem.replacePluginHooks() 一次性完成 清除旧 + 注册新
 *
 * 路径变量：**不做字符串替换**。原先这里把 command 里的 `${PLUGIN_ROOT}` 替换成插件磁盘路径，
 * 那是往 shell 串里拼路径（与 H14 同型：路径含 `$(...)` 会被 sh 执行）。现在每个插件把自己的根目录
 * 交给归一化层，runner 导出为环境变量 CLAUDE_PLUGIN_ROOT / PLUGIN_ROOT / CLAUDE_PLUGIN_DATA，
 * shell 形式由 sh 从环境展开，exec 形式（有 args）由 runner 做纯字符串替换。
 */

import { join } from "node:path";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import { getSidHome } from "@sid-code/core/config/paths.ts";
import type { HookSystem } from "@sid-code/core/hook/system.ts";
import type { HooksConfig } from "@sid-code/core/config/config.ts";
import type { HookDiagnostic } from "@sid-code/core/hook/config-normalize.ts";
import { registerPluginCache } from "./caches.ts";
import { loadAllPluginsCacheOnly } from "./loader.ts";
import type { LoadedPlugin } from "./types.ts";

/** 一个插件的 hooks 层（交给 HookSystem.replacePluginHooks） */
export interface PluginHookLayer {
  name: string;
  hooks: HooksConfig;
  /** 插件根目录；内置插件（path 为 "builtin" 哨兵）没有 */
  pluginRoot?: string;
  /** 插件持久数据目录（CC 的 CLAUDE_PLUGIN_DATA），~/.sid-code/plugins/data/<name> */
  pluginData?: string;
}

/** 插件持久数据目录（对齐 CC：跨插件更新保留）。只给路径，目录由插件脚本按需创建 */
export function pluginDataDir(pluginName: string): string {
  return join(getSidHome(), "plugins", "data", pluginName.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/** 收集单个插件的 hooks 层（原样形状，不做任何变量替换） */
export function collectPluginHooks(plugin: LoadedPlugin): PluginHookLayer | null {
  if (!plugin.hooksConfig) return null;
  return {
    name: plugin.name,
    hooks: plugin.hooksConfig,
    ...(plugin.isBuiltin ? {} : { pluginRoot: plugin.path }),
    pluginData: pluginDataDir(plugin.name),
  };
}

/**
 * 每个 HookSystem 实例一份「已加载」Promise（缺陷 36）。
 *
 * 旧实现用的是单 slot `memoize`：**第一次调用的 hookSystem 被用于执行，后续调用的
 * 参数全部被丢掉**。当时靠一句注释维持「同一进程内 hookSystem 固定」这个不变量，
 * 而它已经不是事实——`grep -rn 'new HookSystem' packages/` 能数出三个实例：
 * `app.ts`（主实例）、`agent/agent-hooks.ts`（隔离 agent 实例）、`command/hooks-cli.ts`
 * （临时实例）。后两个目前恰好不走这条路径，所以不是活缺陷；但哪天有人给隔离 agent
 * 接上插件 hook，第二个实例的 hook 会静默注册到主实例上，而 `loadPluginHooks` 返回成功。
 *
 * 改成按实例分槽后，违反前提不再需要断言兜底：每个 HookSystem 拿到的是自己的结果。
 * 用 WeakMap 而不是 Map：HookSystem 生命周期结束后槽位随之回收，不会钉住实例。
 */
let hookCache = new WeakMap<HookSystem, Promise<HookDiagnostic[]>>();

async function registerPluginHooks(hookSystem: HookSystem): Promise<HookDiagnostic[]> {
  const { enabled } = await loadAllPluginsCacheOnly();

  const layers: PluginHookLayer[] = [];
  for (const plugin of enabled) {
    const layer = collectPluginHooks(plugin);
    if (layer) layers.push(layer);
  }

  // 原子交换
  const diagnostics = hookSystem.replacePluginHooks(layers);
  for (const d of diagnostics) {
    getLogger().warn("PLUGIN", `插件 hook 已跳过 ${d.path}: ${d.message}`);
  }

  const total = hookSystem.getAllHooks().filter((h) => h.source === "plugin").length;
  if (total > 0) {
    getLogger().info("PLUGIN", `注册了 ${total} 个插件 hook`);
  }
  // 返回诊断给调用方：启动期由 app 送进启动横幅 / -p stderr（与项目层诊断同一出口），
  // 原先只进 logger.warn，TUI 接管终端后用户看不到，写错的插件 hook 静默不跑。
  return diagnostics;
}

/**
 * 加载所有插件的 Hooks 并原子注册到 HookSystem，返回归一化诊断。
 * 同一个 HookSystem 重复调用不会重复注册（返回同一个 Promise）；不同实例各注册各的。
 * 需要重新加载走 `clearAllPluginCaches()` → `/reload-plugins`（会调用下面的 clear）。
 */
export const loadPluginHooks = Object.assign(
  (hookSystem: HookSystem): Promise<HookDiagnostic[]> => {
    const cached = hookCache.get(hookSystem);
    if (cached) return cached;
    const promise = registerPluginHooks(hookSystem).catch((err: unknown) => {
      // 失败不缓存：一次磁盘抖动不该让整个会话永久返回同一个失败
      if (hookCache.get(hookSystem) === promise) hookCache.delete(hookSystem);
      throw err;
    });
    hookCache.set(hookSystem, promise);
    return promise;
  },
  {
    /** 清空全部实例的缓存（WeakMap 不可遍历，直接换一个新的） */
    clear: (): void => {
      hookCache = new WeakMap();
    },
  },
);

registerPluginCache(loadPluginHooks.clear);
