/**
 * 插件系统核心类型
 *
 * 对标 Claude Code 第十章 Plugin System 的三层架构：
 * - Layer 1（意图层）：installed.json 声明式配置
 * - Layer 2（物化层）：~/.sid-code/plugins/{name}/ 磁盘目录
 * - Layer 3（活跃层）：运行时 Commands / Agents / Hooks / MCP
 *
 * 设计哲学：能力通过协议暴露（Markdown / JSON / MCP），而非代码注入。
 */

import type { MCPServerConfig, HooksConfig } from "@sid-code/core/config/config.ts";

/** 插件组件类型 */
export type PluginComponent = "commands" | "skills" | "agents" | "hooks" | "mcp-servers";

/**
 * 插件作用域，决定可见性和持久性
 * 第一阶段只实现 local / builtin / inline
 * managed / user / project 为未来预留
 */
export type PluginScope =
  | "managed" // 企业策略（MDM），用户不可修改（预留）
  | "user" // 用户级（~/.sid-code/plugins/）
  | "project" // 项目级（.sid-code/plugins/）（预留）
  | "local" // 本地安装（等同于当前的 user）
  | "builtin" // 内置
  | "inline"; // 会话级（--plugin-dir）

/** 用户配置字段定义 */
export interface UserConfigField {
  type: "string" | "number" | "boolean";
  description: string;
  default?: unknown;
  required?: boolean;
  /** 敏感字段存入密钥链（预留） */
  sensitive?: boolean;
}

/** 插件 Manifest（plugin.json 的解析结果） */
export interface PluginManifest {
  /** 插件名称（slug 格式，全局唯一） */
  name: string;
  /** 版本号（semver 格式） */
  version: string;
  /** 人类可读的描述 */
  description: string;
  /** 作者 */
  author?: string;
  /** 许可证 */
  license?: string;

  /** 组件声明（路径，相对插件根目录） */
  commands?: string | string[]; // 命令目录路径，默认 "commands/"
  skills?: string | string[]; // Skill 目录路径，默认 "skills/"
  agents?: string | string[]; // Agent 目录路径，默认 "agents/"
  hooks?: string; // Hook 配置文件路径，默认 "hooks.json"
  mcpServers?: Record<string, MCPServerConfig> | string; // MCP 服务器配置（内联或文件路径）

  /** 依赖声明（插件名列表） */
  dependencies?: string[];

  /** 用户可配置项 schema（预留） */
  userConfig?: Record<string, UserConfigField>;
}

/** 运行时加载的插件 */
export interface LoadedPlugin {
  /** 插件名称 */
  name: string;
  /** 插件 Manifest */
  manifest: PluginManifest;
  /** 插件在磁盘上的路径（内置插件为 "builtin" 哨兵值） */
  path: string;
  /** 插件标识符（如 "my-plugin@local"） */
  source: string;
  /** 是否启用 */
  enabled: boolean;
  /** 是否为内置插件 */
  isBuiltin: boolean;

  /** 组件路径（延迟加载入口，绝对路径） */
  commandsPaths: string[];
  skillsPaths: string[];
  agentsPaths: string[];

  /** 运行时组件（延迟填充的缓存槽） */
  hooksConfig?: HooksConfig;
  mcpServers?: Record<string, MCPServerConfig>;
}

/**
 * 插件错误（discriminated union）
 * 每种错误都携带 source 字段，可精确归因到具体插件。
 */
export type PluginError =
  | { type: "manifest-not-found"; source: string; path: string }
  | { type: "manifest-parse-error"; source: string; parseError: string }
  | { type: "manifest-validation-error"; source: string; errors: string[] }
  | { type: "component-load-failed"; source: string; component: PluginComponent; error: string }
  | { type: "hook-load-failed"; source: string; error: string }
  | { type: "mcp-server-config-invalid"; source: string; serverName: string; error: string }
  | {
      type: "dependency-unsatisfied";
      source: string;
      plugin: string;
      dependency: string;
      reason: "not-enabled" | "not-found";
    }
  | { type: "plugin-not-found"; source: string; pluginId: string }
  | { type: "path-not-found"; source: string; path: string; component: PluginComponent }
  | { type: "duplicate-name"; source: string; existingSource: string }
  | { type: "trust-rejected"; source: string; path: string }
  | { type: "generic-error"; source: string; error: string };

/** 插件加载结果 */
export interface PluginLoadResult {
  enabled: LoadedPlugin[];
  disabled: LoadedPlugin[];
  errors: PluginError[];
}

/** 已安装插件注册表条目 */
export interface InstalledPluginEntry {
  name: string;
  path: string;
  source: string;
  version: string;
  /** ISO 时间戳 */
  installedAt: string;
  enabled: boolean;
}

// ============================================================
// 企业策略与 Marketplace（预留接口，第一阶段不实现）
// ============================================================

/** Marketplace 来源配置（预留） */
export interface MarketplaceSource {
  source: "github" | "git" | "npm" | "url" | "directory";
  repo?: string; // github 简写
  url?: string; // git/url 完整地址
  package?: string; // npm 包名
  path?: string; // 本地目录
}

/** 企业策略配置（预留） */
export interface PluginPolicyConfig {
  /** Marketplace 白名单（只允许列表中的来源） */
  strictKnownMarketplaces?: MarketplaceSource[];
  /** Marketplace 黑名单（阻止列表中的来源） */
  blockedMarketplaces?: MarketplaceSource[];
  /** 强制启用/禁用的插件 */
  managedPlugins?: Record<string, boolean>;
  /** 锁定定制化来源（只允许插件提供） */
  strictPluginOnlyCustomization?: boolean | PluginComponent[];
}

/** 将 PluginError 渲染为人类可读字符串（供 /plugin info 等展示） */
export function formatPluginError(err: PluginError): string {
  switch (err.type) {
    case "manifest-not-found":
      return `[${err.source}] 未找到 plugin.json: ${err.path}`;
    case "manifest-parse-error":
      return `[${err.source}] plugin.json 解析失败: ${err.parseError}`;
    case "manifest-validation-error":
      return `[${err.source}] Manifest 验证失败: ${err.errors.join("; ")}`;
    case "component-load-failed":
      return `[${err.source}] 组件 ${err.component} 加载失败: ${err.error}`;
    case "hook-load-failed":
      return `[${err.source}] Hook 加载失败: ${err.error}`;
    case "mcp-server-config-invalid":
      return `[${err.source}] MCP 服务器 ${err.serverName} 配置无效: ${err.error}`;
    case "dependency-unsatisfied":
      return `[${err.source}] 插件 ${err.plugin} 依赖 ${err.dependency} 未满足（${err.reason}）`;
    case "plugin-not-found":
      return `[${err.source}] 未找到插件: ${err.pluginId}`;
    case "path-not-found":
      return `[${err.source}] 组件 ${err.component} 路径不存在: ${err.path}`;
    case "duplicate-name":
      return `[${err.source}] 插件名重复（已存在来源: ${err.existingSource}）`;
    case "trust-rejected":
      return `[${err.source}] 信任被拒绝: ${err.path}`;
    case "generic-error":
      return `[${err.source}] ${err.error}`;
  }
}
