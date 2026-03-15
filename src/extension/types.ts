/**
 * 扩展系统共享类型
 * Commands/Skills/Agents 三层扩展共用的基础类型
 */

/** 扩展来源 */
export type ExtensionSource = "builtin" | "user" | "project";

/** 扫描到的扩展文件（未解析 frontmatter） */
export interface ExtensionFile {
  /** 文件名（不含 .md） */
  name: string;
  /** 绝对路径 */
  filePath: string;
  /** 来源 */
  source: ExtensionSource;
  /** 原始文件内容 */
  rawContent: string;
}

/** 解析后的扩展文件（含 frontmatter） */
export interface ParsedExtensionFile extends ExtensionFile {
  /** frontmatter 键值对 */
  frontmatter: Record<string, unknown>;
  /** frontmatter 之后的 markdown 正文 */
  body: string;
}
