/**
 * 子代理执行链的 hook 作用域（HC23 + SubagentStop 的 CC 字段）
 *
 * CC 规定子代理内的工具事件（Pre/PostToolUse 等）stdin 带 agent_id / agent_type，
 * 主循环不带。子代理与主循环共用同一个 hookSystem 实例，所以身份不能挂在 hookSystem 上，
 * 只能跟着「当前这条异步执行链」走。
 *
 * 为什么用 AsyncLocalStorage 而不是层层传参：子代理工具执行有三个入口——
 * 进程内经 runAgentLoop → executeTools（agentic-loop.ts），spawn 经
 * executeSpawnedInternal → executeToolForChild，自定义路径再各来一遍。
 * 传参要改 AgenticLoopConfig、buildBaseLoopConfig 与两条 spawn 签名，漏一处就是
 * 「一半路径带 agent_id」且零报错；ALS 在 execute()/executeCustom() 包一层即全覆盖，
 * 嵌套子代理各自包一层、内层覆盖外层，与 span-scope.ts / cwd-context.ts 同一模式。
 *
 * store 是**可写的盒子**：SubagentStop 要带 last_assistant_message / agent_transcript_path，
 * 而这两个值分别产生在三条执行路径的深处（onTurnEnd / spawn result / openSidechain）。
 * 让它们写进盒子、由 execute()/executeCustom() 的 finally 统一读出，
 * 比给三条路径的十几个 return 各补两个字段少一个数量级的漂移面。
 *
 * ⚠️ 低依赖：只 import 类型，避免把业务模块拖进 hook 层的依赖图。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { HookAgentRef } from "../hook/types.ts";

export interface SubAgentHookScope {
  /** 工具事件带的 agent_id / agent_type（与 SubagentStart/Stop 同一 id，hook 侧可配对） */
  readonly agent: HookAgentRef;
  /** 子代理最后一条 assistant 文本（SubagentStop.last_assistant_message） */
  lastAssistantMessage?: string;
  /** 子代理 sidechain jsonl 路径（SubagentStop.agent_transcript_path） */
  transcriptPath?: string;
}

const scopeStorage = new AsyncLocalStorage<SubAgentHookScope>();

/** 在子代理 hook 作用域里运行 fn；其中 fire 的工具事件带 agent_id / agent_type */
export function runWithHookAgent<T>(scope: SubAgentHookScope, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

/** 当前所在子代理的 hook 作用域；主循环返回 undefined */
export function currentHookAgentScope(): SubAgentHookScope | undefined {
  return scopeStorage.getStore();
}

/**
 * 工具事件 fire 方法的 options 片段。主循环返回 undefined——调用方原样透传，
 * 主循环的 fire 调用形态与改动前逐字节一致。
 */
export function hookAgentOptions(): { agent: HookAgentRef } | undefined {
  const s = scopeStorage.getStore();
  return s ? { agent: s.agent } : undefined;
}
