/**
 * Hook 配置快照
 * 会话启动时捕获，设置变更时更新，避免会话期间配置不一致
 */

import type { HookRegistry, HookRegistryEntry } from "./registry.ts";
import { HookEventName } from "./types.ts";

export class HookConfigSnapshot {
  private snapshot: Map<HookEventName, HookRegistryEntry[]> | null = null;

  capture(registry: HookRegistry): void {
    this.snapshot = new Map();
    for (const eventName of Object.values(HookEventName)) {
      const hooks = registry.getHooksForEvent(eventName);
      if (hooks.length > 0) {
        this.snapshot.set(eventName, [...hooks]);
      }
    }
  }

  update(registry: HookRegistry): void {
    this.capture(registry);
  }

  getHooksForEvent(eventName: HookEventName): HookRegistryEntry[] {
    if (!this.snapshot) return [];
    return this.snapshot.get(eventName) ?? [];
  }

  hasHookForEvent(eventName: HookEventName): boolean {
    if (!this.snapshot) return false;
    const hooks = this.snapshot.get(eventName);
    return hooks !== undefined && hooks.length > 0;
  }

  isActive(): boolean {
    return this.snapshot !== null;
  }
}
