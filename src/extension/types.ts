/**
 * 扩展系统共享类型
 * Commands/Skills/Agents 三层扩展共用的基础类型
 */

import type { TrustManager } from "./trust.ts";

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

/** 扫描错误条目 */
export interface ExtensionLoadError {
  filePath: string;
  message: string;
}

/** 同名扩展文件的覆盖记录 */
export interface ExtensionOverride {
  name: string;
  overriddenPath: string;
  overriddenSource: ExtensionSource;
  overridingPath: string;
  overridingSource: ExtensionSource;
}

/** 扫描结果（含文件、错误、覆盖记录） */
export interface ScanResult {
  files: ParsedExtensionFile[];
  errors: ExtensionLoadError[];
  overrides: ExtensionOverride[];
}

/**
 * 扫描选项
 *
 * builtinDir：sid-code 自带 builtin 扩展所在目录(如 src/skill/builtin/)。
 *   ExtensionLoader 会扫描该目录下的子目录(`<name>/SKILL.md`)作为 builtin 来源。
 *   注意:不要把 builtinDir 当作 projectDir 传入——projectDir 期望的路径是 `{projectDir}/.sid-code/{type}/`,
 *   而 builtinDir 直接就是放置 SKILL.md 子目录的根。
 */
export interface ScanOptions {
  builtinDir?: string;
  /** 跳过项目级扩展信任检查（CI 等场景） */
  trustProjectExtensions?: boolean;
  /** 信任管理器实例 */
  trustManager?: TrustManager;
  /** 未信任文件回调（返回用户确认后的文件列表） */
  onUntrusted?: (files: ParsedExtensionFile[]) => Promise<ParsedExtensionFile[]>;
}
