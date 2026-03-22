/**
 * Hook 系统导出
 */

export { HookSystem } from "./system.ts";
export { HookRegistry } from "./registry.ts";
export { HookPlanner } from "./planner.ts";
export { HookRunner } from "./runner.ts";
export { HookAggregator } from "./aggregator.ts";
export { HookEventHandler } from "./event-handler.ts";

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
  HookRegistryEntry,
  CommandHookConfig,
  UrlHookConfig,
  RuntimeHookConfig,
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
