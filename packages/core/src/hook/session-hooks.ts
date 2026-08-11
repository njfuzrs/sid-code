/**
 * Session Hook 管理器
 * Map-based 会话隔离，支持 Agent frontmatter Hook、Skill Hook、once 语义
 */

import type { HookConfig, HookEventName } from "./types.ts";
import type { HookRegistryEntry } from "./registry.ts";

export interface SessionHookEntry {
  config: HookConfig;
  once?: boolean;
}

interface SessionStore {
  hooks: Partial<Record<HookEventName, SessionHookEntry[]>>;
}

export class SessionHookManager {
  private sessions = new Map<string, SessionStore>();

  addSessionHook(
    sessionId: string,
    eventName: HookEventName,
    entry: SessionHookEntry,
  ): void {
    let store = this.sessions.get(sessionId);
    if (!store) {
      store = { hooks: {} };
      this.sessions.set(sessionId, store);
    }
    if (!store.hooks[eventName]) {
      store.hooks[eventName] = [];
    }
    store.hooks[eventName]!.push(entry);
  }

  getSessionHooks(
    sessionId: string,
    eventName: HookEventName,
  ): SessionHookEntry[] {
    return this.sessions.get(sessionId)?.hooks[eventName] ?? [];
  }

  removeSessionHook(
    sessionId: string,
    eventName: HookEventName,
    config: HookConfig,
  ): void {
    const store = this.sessions.get(sessionId);
    if (!store?.hooks[eventName]) return;
    store.hooks[eventName] = store.hooks[eventName]!.filter(
      e => e.config !== config,
    );
  }

  clearSessionHooks(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  hasSessionHooks(sessionId: string, eventName: HookEventName): boolean {
    const hooks = this.sessions.get(sessionId)?.hooks[eventName];
    return hooks !== undefined && hooks.length > 0;
  }

  getAllHooksForEvent(
    eventName: HookEventName,
    sessionId: string,
    registryHooks: HookRegistryEntry[],
  ): HookConfig[] {
    const sessionHooks = this.getSessionHooks(sessionId, eventName);
    return [
      ...registryHooks.map(e => e.config),
      ...sessionHooks.map(e => e.config),
    ];
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
