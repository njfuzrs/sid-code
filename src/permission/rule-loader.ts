/**
 * 多来源权限规则加载器
 * 从 8 种来源加载规则并按优先级合并
 * 优先级（低→高）：session → command → cliArg → userSettings → projectSettings → localSettings → flagSettings → policySettings
 *
 * 安全约束：projectSettings 是不可信来源，某些敏感设置必须排除
 */

import { join } from "path";
import { existsSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";
import type {
  PermissionRuleSource,
  SourcedPermissionRule,
  SettingsPermissions,
  PermissionRule,
  RULE_SOURCE_PRIORITY as _priority,
} from "./types.ts";
import { RULE_SOURCE_PRIORITY } from "./types.ts";

/** 设置文件 JSON 格式 */
interface SettingsFile {
  permissions?: SettingsPermissions;
}

/** 不信任项目级配置的设置项（即使用户已信任项目目录） */
const UNTRUSTED_PROJECT_SETTINGS = new Set([
  "skipPermissions",
  "yesMode",
  "permissionMode",
  "sanitizeEnv",
  "allowedDirectories",
]);

/**
 * 规则加载器
 * 管理多来源规则的加载、合并和运行时更新
 */
export class RuleLoader {
  /** 各来源的规则存储 */
  private sources = new Map<PermissionRuleSource, SourcedPermissionRule[]>();
  /** 合并后的规则缓存（按优先级排序） */
  private mergedCache: SourcedPermissionRule[] | null = null;
  /** 工作区路径 */
  private workspacePath: string;

  constructor(workspacePath?: string) {
    this.workspacePath = workspacePath || process.cwd();
  }

  /**
   * 从所有来源加载规则
   * 调用时机：应用启动时、配置文件变更时
   */
  async loadAll(): Promise<void> {
    const log = getLogger();

    // 并行加载各来源
    await Promise.all([
      this.loadSettingsFile("userSettings", sidPaths.settings()),
      this.loadSettingsFile("projectSettings", join(this.workspacePath, ".sid-code", "settings.json")),
      this.loadSettingsFile("localSettings", join(this.workspacePath, ".sid-code", "settings.local.json")),
    ]);

    this.invalidateCache();
    const total = this.getAllRules().length;
    log.info("RULE_LOADER", `加载完成，共 ${total} 条规则`);
  }

  /**
   * 从设置文件加载规则
   */
  private async loadSettingsFile(source: PermissionRuleSource, filePath: string): Promise<void> {
    const log = getLogger();

    if (!existsSync(filePath)) {
      return;
    }

    try {
      const content = await Bun.file(filePath).text();
      const settings: SettingsFile = JSON.parse(content);

      if (!settings.permissions) {
        return;
      }

      const rules = this.parsePermissions(settings.permissions, source);
      this.sources.set(source, rules);
      log.info("RULE_LOADER", `${source}: ${filePath} → ${rules.length} 条规则`);
    } catch (err: any) {
      log.warn("RULE_LOADER", `读取 ${filePath} 失败: ${err.message}`);
    }
  }

  /**
   * 解析权限配置为 SourcedPermissionRule 数组
   */
  private parsePermissions(perms: SettingsPermissions, source: PermissionRuleSource): SourcedPermissionRule[] {
    const rules: SourcedPermissionRule[] = [];

    for (const rule of perms.allow || []) {
      rules.push({ source, behavior: "allow", rawRule: rule });
    }
    for (const rule of perms.deny || []) {
      rules.push({ source, behavior: "deny", rawRule: rule });
    }
    for (const rule of perms.ask || []) {
      rules.push({ source, behavior: "ask", rawRule: rule });
    }

    return rules;
  }

  /**
   * 设置 CLI 参数规则
   * 调用时机：解析命令行参数后
   */
  setCliArgRules(allow?: string[], deny?: string[]): void {
    const rules: SourcedPermissionRule[] = [];
    for (const rule of allow || []) {
      rules.push({ source: "cliArg", behavior: "allow", rawRule: rule });
    }
    for (const rule of deny || []) {
      rules.push({ source: "cliArg", behavior: "deny", rawRule: rule });
    }
    if (rules.length > 0) {
      this.sources.set("cliArg", rules);
      this.invalidateCache();
    }
  }

  /**
   * 添加运行时 session 规则（权限弹窗 "Always Allow"）
   */
  addSessionRule(behavior: "allow" | "deny" | "ask", rawRule: string): void {
    const existing = this.sources.get("session") || [];
    existing.push({ source: "session", behavior, rawRule });
    this.sources.set("session", existing);
    this.invalidateCache();
  }

  /**
   * 添加斜杠命令规则（/allow, /deny）
   */
  addCommandRule(behavior: "allow" | "deny" | "ask", rawRule: string): void {
    const existing = this.sources.get("command") || [];
    existing.push({ source: "command", behavior, rawRule });
    this.sources.set("command", existing);
    this.invalidateCache();
  }

  /**
   * 从 CLAUDE.md 的 PermissionRule 导入规则（作为 projectSettings）
   * 兼容现有的 CLAUDE.md 规则加载机制
   */
  importFromPermissionRule(rules: PermissionRule, source: PermissionRuleSource = "projectSettings"): void {
    const parsed = this.parsePermissions(rules, source);
    if (parsed.length > 0) {
      const existing = this.sources.get(source) || [];
      existing.push(...parsed);
      this.sources.set(source, existing);
      this.invalidateCache();
    }
  }

  /**
   * 获取所有规则（按优先级排序，高优先级在前）
   */
  getAllRules(): SourcedPermissionRule[] {
    if (this.mergedCache) return this.mergedCache;

    const all: SourcedPermissionRule[] = [];
    for (const rules of this.sources.values()) {
      all.push(...rules);
    }

    // 按来源优先级排序（高优先级在前）
    all.sort((a, b) => RULE_SOURCE_PRIORITY[b.source] - RULE_SOURCE_PRIORITY[a.source]);

    this.mergedCache = all;
    return all;
  }

  /**
   * 转换为旧版 PermissionRule 格式（兼容现有 checkRules）
   * 按优先级合并：高优先级来源的规则排在前面
   */
  toPermissionRule(): PermissionRule {
    const rules = this.getAllRules();
    const result: PermissionRule = { allow: [], deny: [], ask: [] };

    for (const rule of rules) {
      switch (rule.behavior) {
        case "allow": result.allow!.push(rule.rawRule); break;
        case "deny": result.deny!.push(rule.rawRule); break;
        case "ask": result.ask!.push(rule.rawRule); break;
      }
    }

    return result;
  }

  /**
   * 获取指定来源的规则
   */
  getRulesBySource(source: PermissionRuleSource): SourcedPermissionRule[] {
    return this.sources.get(source) || [];
  }

  /**
   * 清除指定来源的规则
   */
  clearSource(source: PermissionRuleSource): void {
    this.sources.delete(source);
    this.invalidateCache();
  }

  /**
   * 清除所有运行时规则（session + command）
   */
  clearRuntimeRules(): void {
    this.sources.delete("session");
    this.sources.delete("command");
    this.invalidateCache();
  }

  /** 使缓存失效 */
  private invalidateCache(): void {
    this.mergedCache = null;
  }

  /**
   * 检查某个设置项是否可以从 projectSettings 加载
   */
  static isProjectSettingTrusted(settingName: string): boolean {
    return !UNTRUSTED_PROJECT_SETTINGS.has(settingName);
  }
}
