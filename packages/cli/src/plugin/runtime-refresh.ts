/**
 * 插件运行时刷新注册器（缺陷 34）
 *
 * 为什么是注册表而不是让 operations 直接 import refresh.ts：
 * - operations 是纯生命周期逻辑（install/uninstall/enable/disable），不知道
 *   hookSystem / skillManager / mcpManager / UnifiedRegistry 这些运行时句柄在哪个进程里存在；
 * - 调用方有两类：斜杠命令（CommandContext 里有句柄）与 TUI 面板（拿不到 ctx），
 *   让每个调用方各自接线必然漏一处；
 * - 未注册的进程（headless / CLI 子命令 / 测试）本来就只有"下次加载生效"，
 *   退化成只清缓存即可，与旧行为一致。
 *
 * app 在启动序列末尾注册一次闭包，四个生命周期操作完成后统一调 refreshPluginRuntime()。
 */

import { getLogger } from "@sid-code/core/debug/logger.ts";

/** 运行时刷新器：由 app 层提供，内部调 refreshActivePlugins */
export type PluginRuntimeRefresher = () => Promise<void> | void;

let refresher: PluginRuntimeRefresher | undefined;

/** 注册运行时刷新器；返回注销函数（app dispose 用） */
export function registerPluginRuntimeRefresher(fn: PluginRuntimeRefresher): () => void {
  refresher = fn;
  return () => {
    if (refresher === fn) refresher = undefined;
  };
}

/** 是否已注册刷新器。命令层据此决定提示「已生效」还是「需要 /reload-plugins」 */
export function hasPluginRuntimeRefresher(): boolean {
  return refresher !== undefined;
}

/**
 * 操作完成后立刻刷新运行时；未注册时是空操作。
 *
 * 失败只记日志、返回 false，不把生命周期操作判失败 —— 文件已经落盘，
 * 下一次启动 / 手动 /reload-plugins 仍会正确加载。返回 false 让调用方
 * 保留「运行 /reload-plugins 使其生效」的提示。
 */
export async function refreshPluginRuntime(): Promise<boolean> {
  if (!refresher) return false;
  try {
    await refresher();
    return true;
  } catch (err: any) {
    getLogger().warn("PLUGIN", `插件运行时刷新失败: ${err?.message ?? err}`);
    return false;
  }
}
