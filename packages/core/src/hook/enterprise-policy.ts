/**
 * 企业策略门控
 * 支持 allowManagedHooksOnly（只允许企业管理的 Hook）和 disableAllHooks（禁用所有 Hook）
 */

import type { HookConfig } from "./types.ts";
import { ConfigSource } from "./types.ts";

export interface EnterprisePolicy {
  disableAllHooks?: boolean;
  allowManagedHooksOnly?: boolean;
  allowedHookSources?: ConfigSource[];
  blockedCommands?: string[];
  blockedUrls?: string[];
  maxHookTimeout?: number;
}

export class EnterprisePolicyGate {
  private policy: EnterprisePolicy;

  constructor(policy: EnterprisePolicy = {}) {
    this.policy = policy;
  }

  updatePolicy(policy: Partial<EnterprisePolicy>): void {
    this.policy = { ...this.policy, ...policy };
  }

  isHookAllowed(config: HookConfig): boolean {
    if (this.policy.disableAllHooks) return false;

    if (this.policy.allowManagedHooksOnly) {
      if (config.source !== ConfigSource.Runtime && config.source !== ConfigSource.Project) {
        return false;
      }
    }

    if (this.policy.allowedHookSources && config.source) {
      if (!this.policy.allowedHookSources.includes(config.source)) {
        return false;
      }
    }

    if (config.type === "command" && this.policy.blockedCommands) {
      for (const blocked of this.policy.blockedCommands) {
        if (config.command.includes(blocked)) return false;
      }
    }

    if (config.type === "url" && this.policy.blockedUrls) {
      for (const blocked of this.policy.blockedUrls) {
        if (config.url.includes(blocked)) return false;
      }
    }

    if (this.policy.maxHookTimeout && config.timeout) {
      if (config.timeout > this.policy.maxHookTimeout) return false;
    }

    return true;
  }

  get isDisabled(): boolean {
    return this.policy.disableAllHooks === true;
  }

  get isManagedOnly(): boolean {
    return this.policy.allowManagedHooksOnly === true;
  }
}
