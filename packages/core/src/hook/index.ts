/**
 * Hook 系统导出
 */

export { HookSystem } from "./system.ts";
export { HookRegistry } from "./registry.ts";
export { HookPlanner } from "./planner.ts";
export { HookRunner, LazyJsonInput } from "./runner.ts";
export { HookAggregator } from "./aggregator.ts";
export { HookEventHandler } from "./event-handler.ts";
export { StopHookOrchestrator, createStopHookErrorMessage } from "./stop-hook-orchestrator.ts";
export { AsyncHookRegistry } from "./async-registry.ts";
export { isBlockedAddress, sanitizeHeaders, ssrfGuardedFetch } from "./ssrf-guard.ts";
export { SessionHookManager } from "./session-hooks.ts";
export { EnterprisePolicyGate } from "./enterprise-policy.ts";

export type {
  HookEventName,
  HookConfig,
  HookDefinition,
  NewHooksConfig,
  ConfigSource,
  HookInput,
  HookOutput,
  HookExecutionResult,
  HookExecutionPlan,
  AggregatedHookResult,
  CommandHookConfig,
  UrlHookConfig,
  RuntimeHookConfig,
  PromptHookConfig,
  AgentHookConfig,
  PreToolUseInput,
  PostToolUseInput,
  UserPromptSubmitInput,
  AfterAgentInput,
  BeforeModelInput,
  AfterModelInput,
  SessionStartInput,
  SessionEndInput,
  PreCompactInput,
  NotificationInput,
  StopInput,
} from "./types.ts";

export {
  DefaultHookOutput,
  PreToolUseHookOutput,
  AfterAgentHookOutput,
  BeforeModelHookOutput,
  AfterModelHookOutput,
  createHookOutput,
  HookEventName as HookEventNameEnum,
  ConfigSource as ConfigSourceEnum,
  HookType,
  LEGACY_EVENT_MAP,
  getHookKey,
} from "./types.ts";

export type { HookEventContext } from "./planner.ts";
export type { HookRegistryEntry } from "./registry.ts";
