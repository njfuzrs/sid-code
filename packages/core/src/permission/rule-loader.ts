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
import { SECURITY_SENSITIVE_FIELDS } from "../config/settings/security.ts";
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
  /** 其余顶层字段（用于安全敏感字段检测） */
  [key: string]: unknown;
}

/**
 * 不信任项目级配置的设置项（即使用户已信任项目目录）。
 *
 * ⚠️ 单一权威来源（P0-3 §5.2.5）：直接复用 src/config/settings/security.ts 的
 * SECURITY_SENSITIVE_FIELDS，不再在本文件维护独立的 UNTRUSTED_PROJECT_SETTINGS——
 * 历史上两套清单内容不一致（仅 3 键重合），是安全隐患的根源。
 */
const UNTRUSTED_PROJECT_SETTINGS = SECURITY_SENSITIVE_FIELDS;

/**
 * 项目级配置中"危险的自我授权"权限规则模式（projectSettings 不可用 allow 放行这些）。
 *
 * 攻击场景：恶意仓库在 .sid-code/settings.json 里写 permissions.allow = ["Bash(*)"]，
 * 试图让任意命令免确认执行。这类宽泛/高危 allow 规则一旦来自不可信的 projectSettings，
 * 必须剔除（deny/ask 规则是收紧安全，允许保留）。
 */
const DANGEROUS_SELF_AUTHORIZATION_PATTERNS: RegExp[] = [
  /^Bash\(\s*\*\s*\)$/i, // Bash(*) 全放行
  /^Bash\(\s*\)$/i, // Bash() 空 = 全放行
  /^\*$/, // * 裸通配（所有工具全放行）
  /^Bash\([^)]*\brm\b[^)]*\)$/i, // Bash(rm ...) 放行删除
  /^Bash\([^)]*\bsudo\b[^)]*\)$/i, // Bash(sudo ...) 放行提权
  /^Bash\([^)]*\bcurl\b[^)]*\)$/i, // Bash(curl ...) 放行外联/下载
  /^Bash\([^)]*\|[^)]*\)$/, // Bash(... | ...) 放行管道（curl|bash 类）
  /^(Write|Edit)\(\s*\*\s*\)$/i, // Write/Edit(*) 全放行文件写入
];

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

    // 并行加载各文件来源。
    // P2-1：新增 policySettings（企业策略，最高优先级、可信源）。
    // 顺序不影响优先级（getAllRules 按 RULE_SOURCE_PRIORITY 统一排序），仅影响 I/O 并发。
    await Promise.all([
      this.loadPolicyFile(),
      this.loadSettingsFile("userSettings", sidPaths.settings()),
      this.loadSettingsFile(
        "projectSettings",
        join(this.workspacePath, ".sid-code", "settings.json"),
      ),
      this.loadSettingsFile(
        "localSettings",
        join(this.workspacePath, ".sid-code", "settings.local.json"),
      ),
    ]);

    this.invalidateCache();
    const total = this.getAllRules().length;
    log.info("RULE_LOADER", `加载完成，共 ${total} 条规则`);
  }

  /**
   * 加载企业策略文件（P2-1）。first-exists-wins 遍历候选路径，取第一个存在的。
   *
   * 与普通 settings 的关键差异：
   * - policySettings 是**可信源**，其 allow 规则**不走** DANGEROUS_SELF_AUTHORIZATION_PATTERNS 剥离
   *   （企业管理员有权自我授权，projectSettings 才是不可信源）。
   * - 优先级最高（RULE_SOURCE_PRIORITY.policySettings=7），且 checkRules 打分中 deny=1000 恒压 allow，
   *   故 policy 的 deny 不会被任何下层 allow 覆盖。
   * - 0o600 权限校验：非 600 仅告警不阻塞（对齐原 ManagedFileLoader 语义）。
   */
  private async loadPolicyFile(): Promise<void> {
    const log = getLogger();

    for (const filePath of sidPaths.managedPolicyCandidates()) {
      if (!existsSync(filePath)) continue;

      // 权限校验：企业策略文件应为 600（仅所有者可写），防篡改
      try {
        const { statSync } = await import("fs");
        const mode = statSync(filePath).mode & 0o777;
        if (mode !== 0o600) {
          log.warn(
            "RULE_LOADER",
            `企业策略文件 ${filePath} 权限不安全 (${mode.toString(8)})，建议设为 600`,
          );
        }
      } catch {
        /* 权限检查失败不阻塞加载 */
      }

      try {
        const content = await Bun.file(filePath).text();
        const settings: SettingsFile = JSON.parse(content);
        if (!settings.permissions) return; // 命中候选文件即停（first-exists-wins），即使无 permissions
        // 可信源：不做 filterUntrustedProjectRules 剥离
        const rules = this.parsePermissions(settings.permissions, "policySettings");
        this.sources.set("policySettings", rules);
        log.info(
          "RULE_LOADER",
          `policySettings: ${filePath} → ${rules.length} 条规则（企业策略，最高优先级）`,
        );
      } catch (err: any) {
        log.warn("RULE_LOADER", `读取企业策略文件 ${filePath} 失败: ${err.message}`);
      }
      return; // first-exists-wins：命中第一个存在的候选就停
    }
  }

  /**
   * 设置 SDK 内联规则（flagSettings，如 --settings CLI 内存来源）。P2-1 新增接线点。
   */
  setFlagRules(perms?: SettingsPermissions): void {
    if (!perms) return;
    const rules = this.parsePermissions(perms, "flagSettings");
    if (rules.length > 0) {
      this.sources.set("flagSettings", rules);
      this.invalidateCache();
    }
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

      // 安全边界（P0-3 §5.2.5）：projectSettings 是不可信来源。
      // ① 检测并告警注入的安全敏感顶层字段（settings 层面的过滤由 settings.ts
      //    filterProjectSettings 兜底，这里仅做审计告警，让攻击行为可见）。
      if (source === "projectSettings") {
        const injected = Object.keys(settings).filter((k) => UNTRUSTED_PROJECT_SETTINGS.has(k));
        if (injected.length > 0) {
          log.warn(
            "RULE_LOADER",
            `⚠️ 项目级配置 ${filePath} 试图注入不可信安全字段 [${injected.join(", ")}]，已忽略（不可信来源）`,
          );
        }
      }

      if (!settings.permissions) {
        return;
      }

      let rules = this.parsePermissions(settings.permissions, source);

      // ② projectSettings 不可自我授权：剔除危险的 allow 规则（deny/ask 收紧安全，保留）。
      if (source === "projectSettings") {
        rules = this.filterUntrustedProjectRules(rules, filePath);
      }

      this.sources.set(source, rules);
      log.info("RULE_LOADER", `${source}: ${filePath} → ${rules.length} 条规则`);
    } catch (err: any) {
      log.warn("RULE_LOADER", `读取 ${filePath} 失败: ${err.message}`);
    }
  }

  /**
   * 过滤项目级配置中"危险的自我授权" allow 规则（P0-3 §5.2.5）。
   *
   * - allow 规则：命中 DANGEROUS_SELF_AUTHORIZATION_PATTERNS 的剔除（防自我提权）。
   * - deny / ask 规则：一律保留（这些是收紧安全，不构成绕过风险）。
   */
  private filterUntrustedProjectRules(
    rules: SourcedPermissionRule[],
    filePath: string,
  ): SourcedPermissionRule[] {
    const log = getLogger();
    const kept: SourcedPermissionRule[] = [];
    const dropped: string[] = [];

    for (const rule of rules) {
      if (rule.behavior === "allow") {
        const dangerous = DANGEROUS_SELF_AUTHORIZATION_PATTERNS.some((p) =>
          p.test(rule.rawRule.trim()),
        );
        if (dangerous) {
          dropped.push(rule.rawRule);
          continue;
        }
      }
      kept.push(rule);
    }

    if (dropped.length > 0) {
      log.warn(
        "RULE_LOADER",
        `⚠️ 项目级配置 ${filePath} 含危险自我授权 allow 规则 [${dropped.join(", ")}]，已剔除（不可信来源不可自我提权）`,
      );
    }

    return kept;
  }

  /**
   * 解析权限配置为 SourcedPermissionRule 数组
   */
  private parsePermissions(
    perms: SettingsPermissions,
    source: PermissionRuleSource,
  ): SourcedPermissionRule[] {
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
  importFromPermissionRule(
    rules: PermissionRule,
    source: PermissionRuleSource = "projectSettings",
  ): void {
    let parsed = this.parsePermissions(rules, source);
    // CLAUDE.md 等项目级来源同样不可信，剔除危险自我授权 allow 规则
    if (source === "projectSettings") {
      parsed = this.filterUntrustedProjectRules(parsed, "CLAUDE.md/projectSettings");
    }
    if (parsed.length > 0) {
      const existing = this.sources.get(source) || [];
      existing.push(...parsed);
      this.sources.set(source, existing);
      this.invalidateCache();
    }
  }

  /**
   * 从另一个 RuleLoader 实例复制全部规则（用于子代理 checker 复用主 checker 的规则）。
   * 安全：直接复制已过滤的规则，不重新解析（来源信息保持不变）。
   */
  importFromRuleLoader(other: RuleLoader): void {
    for (const [source, rules] of other.sources.entries()) {
      const existing = this.sources.get(source) || [];
      existing.push(...rules);
      this.sources.set(source, existing);
    }
    this.invalidateCache();
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
        case "allow":
          result.allow!.push(rule.rawRule);
          break;
        case "deny":
          result.deny!.push(rule.rawRule);
          break;
        case "ask":
          result.ask!.push(rule.rawRule);
          break;
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
