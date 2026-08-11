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

/** 解析 "name@source" 格式的标识符 */
export function parsePluginId(id: string): ParsedPluginId {
  const at = id.indexOf("@");
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
