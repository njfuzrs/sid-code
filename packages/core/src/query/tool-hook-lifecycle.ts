/**
 * 工具调用的 hook 收尾：PermissionDenied / PostToolUse / PostToolUseFailure 的唯一实现。
 *
 * 为什么单独成文件：这四个函数原先在主循环（`query/tool-executor.ts`，私有）和
 * 子代理（`agent/tool-executor.ts`，导出给 spawn 路径共用）各有一份，注释里写着
 * 「与主循环同名 helper 同源同语义」——同源靠人记，漂移没有任何检查会报。
 * 放进 `query/tool-executor.ts` 不行：那个文件两千多行，子代理只为这几个函数就得
 * 依赖整个主循环执行器；放进 agent/ 也不行：主循环反过来依赖子代理模块。
 * 所以抽成一个只依赖 hook / result-storage 的叶子模块，两边都 import 它。
 *
 * agent 归属字段统一走 `hookAgentOptions()`（读 ALS）：主循环不在子代理 scope 里，
 * 读到 undefined，载荷与原先主循环的版本逐字段相同；子代理里读到 agent_id / agent_type。
 */

import type { HookSystem } from "../hook/system.ts";
import type { AggregatedHookResult, ToolFailureKind } from "../hook/types.ts";
import { getLogger } from "../debug/logger.ts";
import { isAbortError, errorMessageOf } from "../llm/errors.ts";
import { processToolResult } from "../tool/result-storage.ts";
import { hookAgentOptions } from "../agent/hook-agent-context.ts";

/**
 * HC18：从 PostToolUse / PostToolUseFailure 的聚合结果里取要回灌模型的反馈。
 * exit 2 在 runner 里已变成 decision:"deny" + reason(stderr)；JSON decision:"block" 带 reason。
 * 两者都走 isBlockingDecision + getEffectiveReason，不另立判据。
 */
export function hookFeedbackText(result: AggregatedHookResult | undefined): string | undefined {
  const out = result?.finalOutput;
  if (!out?.isBlockingDecision()) return undefined;
  const reason = out.getEffectiveReason();
  return reason && reason.trim() ? reason : undefined;
}

/**
 * 「工具未执行成功」的收尾：补 fire PostToolUseFailure。
 *
 * PreToolUse 已 fire 之后的所有早退分支（hook 阻止 / 参数校验失败 / 中断 / 未启动）都必须
 * 补一次 Failure，否则 Pre/Post 不成对——依赖配对的用户 hook 永久悬空，且 `execute_tool`
 * span 是在 PostToolUse* 事件里创建的，这些失败在可观测性里完全不存在。
 *
 * @param durationMs 调度器视角的墙钟耗时（hook/权限/校验开销）。这些分支工具根本没执行，
 *   口径只能是「从进入调度到被拒的墙钟」；缺它则失败工具的 span 无耗时属性，
 *   无法区分「秒拒」与「等用户确认等了 30s 才拒」。
 * @param kind Q7：validation / hook_blocked 在 CC 里不触发 PostToolUseFailure，
 *   这里只送 runtime hook（execute_tool span 与轨迹收尾），用户 hook 收不到。
 *
 * fire-and-forget + 全程 catch：这一层是可观测性补齐，绝不能成为新的失败源。
 * hookSystem 用可选调用：子代理/旧测试可能传入残缺的 hookSystem，这条补丁不能因为
 * 自己 undefined 报错而掩盖真正的工具失败原因。
 */
export function firePostToolUseFailure(
  hookSystem: HookSystem | undefined,
  block: { name: string; id: string; input: unknown },
  reason: string,
  toolInput?: unknown,
  durationMs?: number,
  kind: ToolFailureKind = "exception",
): void {
  if (!hookSystem) return;
  const log = getLogger();
  try {
    const fired = hookSystem.firePostToolUseFailureEvent?.(
      block.name,
      (toolInput ?? block.input) as Record<string, unknown>,
      reason,
      block.id,
      {
        ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
        failure_kind: kind,
        ...hookAgentOptions(),
      },
    );
    // 不 await：hook 耗时不进工具关键路径。
    void fired?.catch?.((e: any) =>
      log.error("HOOK", `post_tool_use_failure hook 失败: ${e?.message ?? e}`),
    );
  } catch (e: any) {
    log.error("HOOK", `post_tool_use_failure 触发异常（忽略）: ${e?.message ?? e}`);
  }
}

/**
 * B33：fire PermissionDenied hook。不 await、异常吞掉 —— 通知类 hook 不能拖慢或打断
 * 拒绝结果回传模型。
 *
 * source：主循环四档都可能出现；子代理结构上没有弹窗通道，只有 "rule"（deny 规则命中）
 * 和 "auto"（ask 被降级、fail-closed 兜底）两档——两者处置相反，hook 侧要能分开。
 * toolUseId：Q7 后权限拒绝只 fire PermissionDenied，runtime 消费者靠它关闭 execute_tool span。
 */
export function firePermissionDenied(
  hookSystem: HookSystem | undefined,
  toolName: string,
  toolInput: unknown,
  reason: string,
  source: "user" | "rule" | "hook" | "auto",
  toolUseId?: string,
): void {
  if (!hookSystem) return;
  const log = getLogger();
  try {
    const fired = hookSystem.firePermissionDeniedEvent?.(
      toolName,
      (toolInput ?? {}) as Record<string, unknown>,
      reason,
      source,
      toolUseId,
      hookAgentOptions(),
    );
    void fired?.catch?.((e: any) =>
      log.error("HOOK", `permission_denied hook 失败: ${e?.message ?? e}`),
    );
  } catch (e: any) {
    log.error("HOOK", `permission_denied hook 触发异常: ${e?.message ?? e}`);
  }
}

/**
 * HC18：工具执行完后 **await** PostToolUse / PostToolUseFailure，把 hook 的
 * additionalContext 与 exit 2 / decision:"block" 的 reason 回灌进工具结果。
 *
 * 原先子代理这里 fire-and-forget：按 CC 写的 lint hook 在子代理里跑了、拦了，子代理模型
 * 却永远看不到——它改完文件就汇报「完成」，主代理据此转述给用户，错误被两层转述洗白。
 *
 * 主循环的成功路径另有 harness_context / progress_events 等遥测载荷，暂未并入（见
 * `run-tool-use.ts` 文件头）；判据与回灌前缀与这里同一口径。
 *
 * hook 自身失败只记日志、返回原输出：回灌是增强，不能把成功的工具结果变成异常。
 */
export async function runPostToolHooks(
  hookSystem: HookSystem | undefined,
  args: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string | undefined;
    output: string;
    isError: boolean;
    durationMs: number;
    /**
     * 工具执行中 signal 已被 abort、且工具自己收尾返回 isError（bash 等的常态）。
     * 归 aborted 而不是 tool_error，与主循环同口径。
     */
    interrupted?: boolean;
    /** 是否 MCP 工具：决定 updatedMCPToolOutput 是否生效 */
    isMcpTool?: boolean;
    /**
     * 工具的结构化执行元数据（`LegacyToolResult.meta`），透传进 `tool_response.meta`。
     *
     * 为什么子代理路径也要传：主循环的 `tool-executor.ts` 已经传了，这条路径原先没传，
     * 于是子代理里 bash 的 `sandboxed` 埋点在成功和失败两条通道上**全部丢失** ——
     * 而子代理复用主 registry 的 BashTool 实例，它确实跑在沙箱里。
     * 结果是「开了沙箱的会话里多少条 bash 真进了沙箱」在带子代理的会话里系统性偏低
     * （2026-11-05 review）。
     */
    toolMeta?: Record<string, unknown>;
    /** 替换输出的落盘参数（与原输出同一套 processToolResult 截断/落盘） */
    sessionId?: string;
    maxResultSizeChars?: number;
  },
): Promise<string> {
  if (!hookSystem) return args.output;
  const log = getLogger();
  try {
    const agent = hookAgentOptions();
    // Q7：工具返回 isError → 只 fire PostToolUseFailure（对齐 CC）；成功才 fire PostToolUse
    const post = args.isError
      ? await hookSystem.firePostToolUseFailureEvent(
          args.toolName,
          args.toolInput,
          args.output,
          args.toolUseId,
          {
            duration_ms: args.durationMs,
            failure_kind: args.interrupted ? "aborted" : "tool_error",
            is_interrupt: !!args.interrupted,
            tool_output: args.output,
            ...(args.toolMeta ? { tool_meta: args.toolMeta } : {}),
            ...agent,
          },
        )
      : await hookSystem.firePostToolUseEvent(
          args.toolName,
          args.toolInput,
          {
            output: args.output,
            isError: false,
            ...(args.toolMeta ? { meta: args.toolMeta } : {}),
          },
          false,
          args.toolUseId,
          { duration_ms: args.durationMs, ...agent },
        );
    let out = args.output;
    // updatedToolOutput / updatedMCPToolOutput：替换模型侧输出（只在成功路径）
    const replaced = args.isError
      ? undefined
      : post?.finalOutput?.getUpdatedToolOutput?.(!!args.isMcpTool);
    if (replaced !== undefined) {
      log.info("HOOK", `PostToolUse hook 替换了 ${args.toolName} 的模型侧输出`);
      out = processToolResult(
        args.toolName,
        args.toolUseId ?? "spawn",
        replaced,
        args.sessionId ?? "default",
        args.maxResultSizeChars,
      );
    }
    const ctx = post?.finalOutput?.getAdditionalContext?.();
    if (ctx) out = out + "\n\n[Hook 附加上下文]\n" + ctx;
    const feedback = hookFeedbackText(post);
    if (feedback) {
      log.info("HOOK", `PostToolUse hook 反馈回灌到 ${args.toolName} 结果`);
      out = out + "\n\n[Hook 反馈]\n" + feedback;
    }
    return out;
  } catch (e: any) {
    log.error("HOOK", `post_tool_use hook 失败: ${e?.message ?? e}`);
    return args.output;
  }
}

/**
 * 工具抛异常时 await PostToolUseFailure，返回要回灌的 hook 反馈（无则 undefined）。
 *
 * is_interrupt 按**真实中断**判：signal 已 abort，或异常本身是 abort 类。
 * 子代理的 abort 经 AbortSignal.any 合并而来，工具可能以普通 Error（如 "子进程被终止"）
 * 收尾，只看异常名会漏判。
 */
export async function runToolExceptionHook(
  hookSystem: HookSystem | undefined,
  args: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string | undefined;
    error: unknown;
    durationMs: number;
    signal?: AbortSignal;
  },
): Promise<string | undefined> {
  if (!hookSystem) return undefined;
  const log = getLogger();
  const message = errorMessageOf(args.error);
  const isInterrupt = args.signal?.aborted === true || isAbortError(args.error);
  try {
    const r = await hookSystem.firePostToolUseFailureEvent(
      args.toolName,
      args.toolInput,
      message,
      args.toolUseId,
      {
        // 中断与真异常分开：前者不是「工具不可靠」的证据（与主循环同口径）。
        failure_kind: isInterrupt ? "aborted" : "exception",
        // 纯执行耗时（与成功路径 duration_ms 同口径）：慢工具卡很久才抛，正是要看的那个数。
        duration_ms: args.durationMs,
        is_interrupt: isInterrupt,
        ...hookAgentOptions(),
      },
    );
    return hookFeedbackText(r);
  } catch (e: any) {
    log.error("HOOK", `post_tool_use_failure hook 失败: ${e?.message ?? e}`);
    return undefined;
  }
}
