/**
 * 插件标识符体系
 *
 * 格式："name@source"，支持多来源插件共存。
 * 特殊 source 值：
 *   - builtin：内置插件（随 CLI 分发）
 *   - local：本地安装的插件（~/.sid-code/plugins/）
 *   - inline：会话级插件（--plugin-dir 指定，不持久化）
 */

/** 解析后的插件标识符 */
export interface ParsedPluginId {
  name: string;
  /** "local" | "builtin" | "inline" | marketplace 名称 */
  source?: string;
}

/**
 * 解析 "name@source" 格式的标识符
 *
 * 分隔符取**最后一个** `@`，不是第一个：`name` 可能是文件路径（`loadPluginFromDirectory` 传的
 * `${pluginPath}@${sourceKind}`），macOS / Linux 路径完全可以含 `@`（如 `/Users/me/proj@v2/plugins/foo`），
 * 而 `source` 是 kind / 市场名（`local` / `inline` / `builtin` / 市场名），不含路径分隔语义。
 * 用首个 `@` 切会把路径切成 `{name: "/Users/me/proj", source: "v2/plugins/foo@inline"}`。
 *
 * 因此本函数与 buildPluginId 必须互逆：`parsePluginId(buildPluginId(name, source))`
 * 还原出的 `name` / `source` 与输入一致（含 name 自身带 `@` 的情况）。
 * 代价是 source 里含 `@`（npm scope 风格市场名 `@myorg/plugins`）会被切到 name 一侧——
 * 但 name 侧是路径，而路径含 `@` 是真实存在的，两个方向只能保一边，取真实发生的那边。
 */
export function parsePluginId(id: string): ParsedPluginId {
  const at = id.lastIndexOf("@");
  if (at >= 0) {
    const name = id.slice(0, at);
    const source = id.slice(at + 1);
    return { name, source: source || undefined };
  }
  return { name: id };
}

/** 构建标识符 */
export function buildPluginId(name: string, source?: string): string {
  return source ? `${name}@${source}` : name;
}
