// src/analytics/plugin-attribution.ts
// 工具调用 → 企业市场插件的归因（服务 tool_invoked 事件）
//
// 为什么要单独一张注册表，而不是在事件里直接带 MCP 真名：
// 现有 tool_call 把 MCP 工具名脱敏成 "mcp_tool"，真名只在 `_PROTECTED_mcp_*`，
// HTTP 后端默认 stripProtected=true 会剥掉 —— 按插件聚合调用次数取不到数据。
// 放开 stripProtected 会把**用户自己配的** MCP 服务名一起放出去，那才是真 PII。
// 所以只对「从企业市场安装的插件」单独发一条只含插件名 / 工具名的事件，
// 而「是不是市场插件」必须有一个精确的判据 —— 就是这张表。
//
// 注册表由 cli 在插件加载完成后、`/reload-plugins` 后整表写入（setMarketPlugins）。
// 本地目录安装、`--plugin-dir`、内置插件不进表 ⇒ 查不到 ⇒ 不发。

/** 插件 MCP 服务器在配置里的作用域前缀。
 *
 * 与 `packages/cli/src/plugin/scope.ts` 的 PLUGIN_MCP_PREFIX 同值。core 不能反向依赖 cli
 * （lint:boundary），只能在这里复写一份；两边一致性由 cli 侧测试
 * `tests/plugin/plugin-attribution-prefix.test.ts` 断言，改一边忘了改另一边会红。
 */
export const PLUGIN_MCP_SERVER_PREFIX = "plugin:";

/** 一次工具调用解析出的插件来源（尚未经过市场注册表过滤） */
export interface PluginToolOrigin {
  /** 插件名 slug */
  pluginName: string;
  /** 插件里的哪类组件 */
  component: "mcp" | "skill";
  /** MCP 服务器内的原始工具名，或 skill 名去掉 `插件名:` 前缀后的部分 */
  pluginTool: string;
}

/** 插件名 → 市场名。进程内单例，整表替换。 */
let marketPlugins = new Map<string, string>();

/**
 * 写入「从企业市场安装的插件」清单（整表替换，不是增量合并）。
 *
 * 整表替换是刻意的：`/reload-plugins` 后被卸载的插件必须从表里消失，
 * 增量语义会让卸掉的插件继续被归因。
 */
export function setMarketPlugins(
  entries: ReadonlyArray<{ name: string; marketplace: string }>,
): void {
  const next = new Map<string, string>();
  for (const e of entries) {
    if (
      typeof e?.name === "string" &&
      e.name &&
      typeof e.marketplace === "string" &&
      e.marketplace
    ) {
      next.set(e.name, e.marketplace);
    }
  }
  marketPlugins = next;
}

/** 查插件来自哪个市场；不是市场插件返回 undefined。 */
export function getPluginMarketplace(pluginName: string): string | undefined {
  return marketPlugins.get(pluginName);
}

/** 测试专用：清空注册表 */
export function __resetMarketPluginsForTest(): void {
  marketPlugins = new Map();
}

/**
 * 从 MCP 原始 serverName + 原始 toolName 解析插件来源。
 *
 * ⚠️ 入参必须是**原始** serverName（配置 key，形如 `plugin:<plugin>:<server>`），
 * 不能是 `mcp__...` 规范化后的工具名：buildMcpToolName 会把 `:` 换成 `_` 并按长度预算截断，
 * 而 `_` / `-` 本身也是合法插件名字符，从规范化名反推插件名有歧义。
 *
 * 插件名受 `^[a-z0-9][a-z0-9-_]*$` 约束（cli/plugin/validate.ts），不含 `:`，
 * 所以前缀后的第一个 `:` 就是插件名与服务器名的分界，没有歧义。
 */
export function mcpPluginOrigin(
  serverName: string,
  rawToolName: string,
): PluginToolOrigin | undefined {
  if (!serverName.startsWith(PLUGIN_MCP_SERVER_PREFIX)) return undefined;
  const rest = serverName.slice(PLUGIN_MCP_SERVER_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return undefined;
  if (!rawToolName) return undefined;
  return { pluginName: rest.slice(0, sep), component: "mcp", pluginTool: rawToolName };
}

/**
 * 从 skill 定义解析插件来源。
 *
 * 只认 `loadedFrom === "plugin"` 的 skill：用户自己在 skills 目录里写一个叫
 * `foo:bar` 的 skill 不应被归因到插件 foo。名字取**定义上的**名字
 * （loadPluginSkills 施加的 `<plugin>:<skill>`），不取模型输入（getSkill 不区分大小写）。
 */
export function skillPluginOrigin(skill: {
  name: string;
  loadedFrom?: string;
}): PluginToolOrigin | undefined {
  if (skill.loadedFrom !== "plugin") return undefined;
  const sep = skill.name.indexOf(":");
  if (sep <= 0 || sep === skill.name.length - 1) return undefined;
  return {
    pluginName: skill.name.slice(0, sep),
    component: "skill",
    pluginTool: skill.name.slice(sep + 1),
  };
}
