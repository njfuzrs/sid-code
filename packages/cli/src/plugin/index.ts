/**
 * 插件系统模块导出
 *
 * 三层架构（对标 Claude Code Plugin System）：
 *   Layer 1（意图）：installed.json
 *   Layer 2（物化）：~/.sid-code/plugins/{name}/
 *   Layer 3（活跃）：Commands / Agents / Hooks / MCP
 */

// 类型
export type {
  PluginManifest,
  LoadedPlugin,
  PluginError,
  PluginComponent,
  PluginLoadResult,
  PluginScope,
  InstalledPluginEntry,
  UserConfigField,
  MarketplaceSource,
  PluginPolicyConfig,
} from "./types.ts";
export { formatPluginError } from "./types.ts";

// 标识符
export { parsePluginId, buildPluginId } from "./identifier.ts";
export type { ParsedPluginId } from "./identifier.ts";

// 验证
export { validateManifest, parseAndValidateManifest } from "./validate.ts";
export type { ManifestValidationResult } from "./validate.ts";

// 注册表
export {
  readInstalledPlugins,
  writeInstalledPlugins,
  registerPlugin,
  unregisterPlugin,
  setPluginEnabled,
  getPluginsDir,
  getInstalledFilePath,
} from "./installed.ts";
export type { InstalledPluginsFile } from "./installed.ts";

// 加载器
export {
  loadAllPlugins,
  loadAllPluginsCacheOnly,
  setInlinePluginDirs,
  getInlinePluginDirs,
} from "./loader.ts";

// Manifest 加载
export { loadManifest, loadPluginFromDirectory } from "./manifest.ts";

// 内置插件
export {
  registerBuiltinPlugin,
  unregisterBuiltinPlugin,
  getBuiltinPlugins,
  getBuiltinPluginDefinition,
  listBuiltinPluginNames,
} from "./builtin.ts";
export type { BuiltinPluginDefinition } from "./builtin.ts";

// 依赖解析
export { resolveDependencyClosure, verifyAndDemote, findReverseDependents } from "./dependency.ts";
export type { ResolutionResult } from "./dependency.ts";

// 作用域
export { addPluginScopeToServers, isPluginScopedServer, PLUGIN_MCP_PREFIX } from "./scope.ts";

// 缓存
export { clearAllPluginCaches, registerPluginCache } from "./caches.ts";

// ── Phase 2：组件加载与合并 ──

// 命令加载
export { getPluginCommands, loadCommandsForPlugin } from "./loadPluginCommands.ts";

// Agent 加载
export { loadPluginAgents, loadAgentsForPlugin } from "./loadPluginAgents.ts";

// Hooks 加载
export { loadPluginHooks, collectPluginHooks } from "./loadPluginHooks.ts";

// MCP 加载
export { collectPluginMcpServers, loadPluginMcpServers } from "./loadPluginMcp.ts";

// 组件合并
export { mergePluginCommands } from "./merge.ts";

// ── Phase 3：生命周期与刷新 ──

// 生命周期操作
export { installPlugin, uninstallPlugin, enablePlugin, disablePlugin } from "./operations.ts";
export type { OperationResult } from "./operations.ts";

// 运行时刷新
export { refreshActivePlugins } from "./refresh.ts";
export type { RefreshContext, RefreshResult } from "./refresh.ts";
