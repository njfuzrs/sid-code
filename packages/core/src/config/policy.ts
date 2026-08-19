/**
 * 策略层抽象
 * 支持本地文件策略（managed-settings.json）和未来的远程策略
 * first-source-wins：只取最高优先级的来源，不合并
 */

import { existsSync, statSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "./paths.ts";

/** 策略来源（优先级从高到低，first-source-wins） */
export type PolicySource = "remote" | "mdm" | "managed_file";

/** 策略设置 */
export interface PolicySettings {
  source: PolicySource;
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  /**
   * 功能级开关。
   *
   * `reason` 是管理员可填的禁用理由，会由 `policy-limits.ts` 的
   * `getPolicyDenialReason()` 原样展示给用户（"为什么这个功能没了"）。
   *
   * 补这个字段是**类型对齐，不是修 bug**：`policy-limits.ts` 侧一直声明了
   * `reason?: string`，而这边漏了。运行时的值本来就能流通
   *（`PolicyManager.load()` 走 `JSON.parse` + 展开，不做 schema 剥离），
   * 所以补之前管理员写的 reason 也能生效 —— 只是这里的类型在说谎，
   * 任何按它写代码的人都会以为没有这个字段。
   */
  policyLimits?: Record<string, { allowed: boolean; reason?: string }>;
  /** 是否只允许企业策略中的规则 */
  allowManagedPermissionRulesOnly?: boolean;
  /** G13：禁用所有 Hook（企业管控最强档，任何来源的 hook 都不执行） */
  disableAllHooks?: boolean;
  /** G13：只允许企业管理的 Hook（Runtime/Project 来源），屏蔽 User/Plugin/Global 来源的 hook */
  allowManagedHooksOnly?: boolean;
  /** 禁用的权限模式（通用：禁用任意模式，接进 cyclePermissionMode 与 CLI 校验） */
  disabledModes?: string[];
  /**
   * 禁用 bypass（always-allow / dangerously-skip-permissions）模式（P2-2，对齐 CC
   * utils/settings/types.ts:67 disableBypassPermissionsMode）。
   * - "disable"：强制禁用 bypass，即使 CLI 传了 --dangerously-skip-permissions 也报错退出/降级；
   * - "allow"（默认/缺省）：不限制。
   */
  disableBypassPermissionsMode?: "disable" | "allow";
  /**
   * 锁定定制化来源为「仅管理员可信来源」（对齐 CC strictPluginOnlyCustomization）。
   * true=锁全部面；数组=只锁列出的面（commands/skills/agents/hooks/mcp-servers）。
   * 锁定后用户级（~/.sid-code/*）与项目级（.sid-code/*）自带内容不再加载，
   * managed / plugin / builtin 来源不受影响。详见 config/plugin-only-policy.ts。
   */
  strictPluginOnlyCustomization?:
    | boolean
    | import("./plugin-only-policy.ts").CustomizationSurface[];
}

/** 策略加载器接口（可扩展） */
export interface PolicyLoader {
  load(): Promise<PolicySettings | null>;
  /** 是否支持后台轮询 */
  supportsPolling: boolean;
  /** 轮询间隔（毫秒） */
  pollingInterval?: number;
}

/** 本地文件策略加载器 */
export class ManagedFileLoader implements PolicyLoader {
  supportsPolling = false;

  async load(): Promise<PolicySettings | null> {
    const log = getLogger();
    const filePath = sidPaths.managedSettings();

    if (!existsSync(filePath)) return null;

    // 安全检查：文件权限应为 600（只有所有者可读写）
    try {
      const stats = statSync(filePath);
      const mode = stats.mode & 0o777;
      if (mode !== 0o600) {
        log.warn("POLICY", `managed-settings.json 权限不安全 (${mode.toString(8)})，建议设为 600`);
      }
    } catch {
      // 权限检查失败不阻塞加载
    }

    try {
      const content = await Bun.file(filePath).text();
      const parsed = JSON.parse(content);
      log.info("POLICY", `加载本地策略: ${filePath}`);
      return { source: "managed_file", ...parsed };
    } catch (err: any) {
      log.warn("POLICY", `读取策略文件失败: ${err.message}`);
      return null;
    }
  }
}

/** 远程策略加载器（预留接口，未来实现） */
export class RemotePolicyLoader implements PolicyLoader {
  supportsPolling = true;
  pollingInterval = 60 * 60 * 1000; // 1 小时

  async load(): Promise<PolicySettings | null> {
    // 未来实现：从配置的 API 端点获取
    // 支持 ETag / If-None-Match 缓存
    // 网络不可用时使用过期缓存（fail-open）
    return null;
  }
}

/**
 * 策略管理器
 * 按优先级尝试多个加载器，first-source-wins
 */
export class PolicyManager {
  private loaders: PolicyLoader[];
  private cachedSettings: PolicySettings | null = null;

  constructor(loaders?: PolicyLoader[]) {
    this.loaders = loaders || [new ManagedFileLoader()];
  }

  /** 加载策略（first-source-wins） */
  async load(): Promise<PolicySettings | null> {
    for (const loader of this.loaders) {
      const settings = await loader.load();
      if (settings) {
        this.cachedSettings = settings;
        return settings;
      }
    }
    this.cachedSettings = null;
    return null;
  }

  /** 获取缓存的策略 */
  getCached(): PolicySettings | null {
    return this.cachedSettings;
  }

  /** 检查功能是否被策略允许 */
  isPolicyAllowed(feature: string): boolean {
    if (!this.cachedSettings?.policyLimits) return true;
    const limit = this.cachedSettings.policyLimits[feature];
    if (!limit) return true;
    return limit.allowed;
  }

  /** 检查权限模式是否被策略禁用 */
  isModeDisabled(mode: string): boolean {
    if (!this.cachedSettings?.disabledModes) return false;
    return this.cachedSettings.disabledModes.includes(mode);
  }
}
