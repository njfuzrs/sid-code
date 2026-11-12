/**
 * runToolUse —— 子代理单次工具执行的唯一实现（对齐 CC `services/tools/toolExecution.ts` 的 runToolUse）。
 *
 * abort 预检 → PreToolUse → 权限（或 fail-closed）→ zod 校验 → 执行 → side events / LSP →
 * processToolResult → PostToolUse/Failure 回灌 → 漏斗埋点
 *
 * ## 为什么要收口
 *
 * 子代理有两条执行路径：进程内（`agent/tool-executor.ts` executeTools）和 spawn
 * （`agent/sub-agent.ts` executeToolForChild，子进程经 `tool_use` 消息回传父进程执行）。
 * 两条路径原先各写一份编排，`git log` 里「把子代理补成和主循环一致」的提交至少 7 次，
 * 每次都要在两处同步，漏一处没有任何检查会报。收口前核出 spawn 路径相对进程内路径漏了 4 处：
 *   1. 不做 abort 预检：父级中断后子进程仍发来的 tool_use 照样执行（write/edit 自己不看 signal）
 *   2. 未配权限检查器时不 fail-closed：写类工具直接执行（进程内有 B0 分级 fail-closed）
 *   3. 不剥离内部字段：模型伪造的 `_agentId` / `_parentToolUseId` 原样进工具
 *   4. hook 改参后不给模型前置告知
 * 现在两条路径都只做调度 / 形态转换，单次执行只有这一个函数，上面 4 处随之对齐。
 *
 * ## 范围边界（刻意不做的）
 *
 * - 主循环 `query/tool-executor.ts` executeSingleTool 尚未并入：它多出三路竞争权限（UI 确认 /
 *   分类器并行 / hook）、PreToolUse fire-once 缓存、执行前快照、HITL 记录、遥测载荷
 *   harness_context 等，硬并进来要在 mode 里开多个大开关。本次只让它与这里共用
 *   `tool-hook-lifecycle.ts` 的 hook 收尾实现，事件序列一致性由契约测试
 *   `tests/query/run-tool-use-contract.test.ts` 锁住。
 * - forked（`agent/forked-agent.ts`）是显式例外：刻意不触发用户 hook，权限走调用方注入的
 *   canUseTool 回调。
 * - 不放进 `query/tool-executor.ts`：那个文件已两千多行，也会让子代理依赖整个主循环执行器。
 */

import type { ContentBlock, ToolUseBlock } from "../llm/types.ts";
import type { LegacyTool as Tool, ToolProgressData } from "../tool/types.ts";
import type { HookSystem } from "../hook/system.ts";
import type { Checker, PermissionRequest } from "../permission/types.ts";
import { getLogger } from "../debug/logger.ts";
import { isAbortError, errorMessageOf } from "../llm/errors.ts";
import {
  validateToolInput,
  buildUnknownKeysNotice,
  declaredTopLevelKeys,
} from "../tool/input-validator.ts";
import { processToolResult } from "../tool/result-storage.ts";
import { resolveContentProvenance, wrapExternalContent } from "../tool/content-provenance.ts";
import { stripInternalFields } from "../tool/internal-fields.ts";
import { resolveResultDisplayMode } from "../tool/result-display-mode.ts";
import { getCwd } from "../bootstrap/state.ts";
import { hookAgentOptions } from "../agent/hook-agent-context.ts";
import { judgeConcurrencySafe } from "./tool-orchestration.ts";
import { fireToolSideEvents } from "./tool-side-events.ts";
import {
  buildHookModifiedNotice,
  buildObservableInput,
  interpretPreToolUse,
} from "./tool-executor.ts";
import {
  firePermissionDenied,
  firePostToolUseFailure,
  runPostToolHooks,
  runToolExceptionHook,
} from "./tool-hook-lifecycle.ts";
// 漏斗 2 · 权限：走门面而非直调 logEvent —— 门面强制脱敏工具名（MCP 工具名含用户私有服务名）。
import {
  logPermissionAllow,
  logPermissionDeny,
  logToolCall,
  logToolSuccess,
  logToolFailure,
} from "../analytics/events.ts";
import { guardOf } from "../permission/decision-telemetry.ts";

/** 中断后未执行工具的占位结果文案（N 进 N 出；未 fire PreToolUse，故不补 Failure） */
export const SUBAGENT_ABORTED_TOOL_RESULT = "工具未执行：子代理已被中断";

/**
 * 两条子代理路径的差异只在这里声明，不拆分执行逻辑。
 *
 * 子代理结构上没有 UI 通道，`ask` 一律降级为拒绝（dontAsk 语义），这一点两条路径相同，
 * 不需要开关；主循环的 interactive / speculativeClassifier 差异不在本函数范围内（见文件头）。
 */
export interface RunToolUseMode {
  /** 超阈值结果落盘目录用（trajectories/sessions/{id}/tool-outputs/）。 */
  sessionId: string;
  /** S10：子代理身份，写进权限埋点的 agentId。显式传参而非读 ALS：工具执行在流的 next() 之外。 */
  agentId?: string;
  /** LSP 诊断归属者：edit/write 成功后 syncFileToLSP 记在谁名下。 */
  diagnosticOwner: string;
  /** GAP-07：长跑工具中间进度上报。spawn 路径没有（进度经子进程 progress 消息回传）。 */
  onProgress?: (toolName: string, toolUseId: string, event: ToolProgressData) => void;
}

export interface RunToolUseDeps {
  hookSystem?: HookSystem;
  /** 缺省时分级 fail-closed：只读工具放行，写类工具拒绝（B0）。 */
  permissionChecker?: Checker | null;
  signal?: AbortSignal;
}

type ToolResultBlock = ContentBlock & { type: "tool_result" };

const errorResult = (id: string, content: string): ToolResultBlock => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  is_error: true,
});

/** 子代理单次工具执行。永不抛出（异常转成 is_error 结果），返回值是协议形态的 tool_result。 */
export async function runToolUse(
  block: ToolUseBlock,
  tool: Tool | undefined,
  deps: RunToolUseDeps,
  mode: RunToolUseMode,
): Promise<ToolResultBlock> {
  const log = getLogger();
  const { hookSystem, signal } = deps;

  if (!tool) return errorResult(block.id, `工具 "${block.name}" 未找到`);

  // abort 预检：中断后不再启动——write/edit 自己不看 signal，放过去就会在用户 ESC 之后照样落盘。
  // 进程内路径的调度器在启动前也查一次（并发信号量需要它决定是否取下一个任务），这里是兜底，
  // 也是 spawn 路径唯一的一道（子进程收到中断前可能已经发出了下一条 tool_use）。
  if (signal?.aborted) return errorResult(block.id, SUBAGENT_ABORTED_TOOL_RESULT);

  // 调度器视角墙钟锚点：覆盖 hook/权限/校验这些早退分支（与主循环 toolStartedAt 同口径）。
  const toolStartedAt = Date.now();
  const rawInput = (block.input ?? {}) as Record<string, unknown>;

  // ── PreToolUse ── 尊重 blocking 决策与输入修改；hook 失败不阻断执行。
  let effectiveInput: Record<string, unknown> = rawInput;
  let hookModifiedNotice = "";
  let hookPermissionDecision: "allow" | "ask" | undefined;
  if (hookSystem) {
    try {
      const pre = await hookSystem.firePreToolUseEvent(
        block.name,
        rawInput,
        block.id,
        hookAgentOptions(),
      );
      const interp = interpretPreToolUse(pre, rawInput);
      if (interp.blocked) {
        const reason = `Hook 阻止执行: ${interp.blockReason ?? "无原因"}`;
        log.info("SUBAGENT:HOOK", `工具 ${block.name} 被 hook 阻止: ${interp.blockReason}`);
        // Pre/Post 配对：hook_blocked 只送 runtime hook，但 execute_tool span 靠它关闭。
        firePostToolUseFailure(
          hookSystem,
          block,
          reason,
          rawInput,
          Date.now() - toolStartedAt,
          "hook_blocked",
        );
        // 漏斗 1：hook 阻止是一次真实调度失败，call + failure 成对记。权限拒绝走漏斗 2。
        const fp = filePathOf(rawInput);
        logToolCall(block.name, fp);
        logToolFailure(block.name, {
          kind: "hook_blocked",
          durationMs: Date.now() - toolStartedAt,
          filePath: fp,
        });
        return errorResult(block.id, reason);
      }
      hookPermissionDecision = interp.permissionDecision;
      if (interp.modifiedInput !== undefined) {
        effectiveInput = interp.modifiedInput;
        // 仅当参数真的变了才告知模型（hook 原样透传 tool_input 时不误报）。
        if (interp.inputChanged) {
          log.info("SUBAGENT:HOOK", `工具 ${block.name} 输入被 hook 修改`);
          hookModifiedNotice = buildHookModifiedNotice(block.name);
        }
      }
    } catch (err: any) {
      log.error("SUBAGENT:HOOK", `pre_tool_use hook 失败: ${err?.message ?? err}`);
    }
  }

  // ── 权限 ──
  const denied = await checkPermission(block, tool, effectiveInput, deps, mode, {
    hookPermissionDecision,
    toolStartedAt,
  });
  if (denied) return denied;

  // 漏斗 1：权限通过之后才记 call（拒绝走漏斗 2，两类语义相反，不混进同一个成功率分母）。
  const efFilePath = filePathOf(effectiveInput);
  logToolCall(block.name, efFilePath);

  // ── zod 校验 ── 用注入 _agentId 之前的参数校验：严格 schema 会把 _agentId 当非法字段拒绝。
  // T2（D1）：同主循环——传模型原始键，区分「模型传错参数名」与「hook 注入字段」。
  const modelKeys =
    block.input !== null && typeof block.input === "object" && !Array.isArray(block.input)
      ? new Set(Object.keys(block.input as Record<string, unknown>))
      : undefined;
  const validation = validateToolInput(tool, effectiveInput, { modelKeys });
  if (!validation.ok) {
    log.info("SUBAGENT:TOOL", `工具 ${block.name} 参数校验失败: ${validation.message}`);
    // Pre/Post 配对：模型漏 required 字段是最高频的真实失败，不补 fire 它在 trace 里完全不存在。
    firePostToolUseFailure(
      hookSystem,
      block,
      validation.message,
      effectiveInput,
      Date.now() - toolStartedAt,
      "validation",
    );
    logToolFailure(block.name, {
      kind: "invalid_input",
      durationMs: Date.now() - toolStartedAt,
      filePath: efFilePath,
    });
    return errorResult(block.id, validation.message);
  }

  // T2（D1）：模型传了 schema 没声明的顶层键 → 不报错，结果开头给一条提示（同主循环）。
  const unknownKeysNotice =
    validation.ignoredKeys && validation.ignoredKeys.length > 0
      ? buildUnknownKeysNotice(
          block.name,
          validation.ignoredKeys,
          declaredTopLevelKeys(tool.zodSchema),
        )
      : "";

  // ── 执行 ──
  const startTime = Date.now();
  try {
    // GAP-08：先剥离模型可能伪造的内部字段，再注入受控的 _agentId 防套娃。顺序不能反。
    const cleanedInput = stripInternalFields(validation.data) as Record<string, unknown>;
    const progressCallback = mode.onProgress
      ? (event: ToolProgressData) => mode.onProgress!(block.name, block.id, event)
      : undefined;
    const cwdBefore = getCwd();
    // 按需注入（契约见 tool/types.ts 的 consumesAgentId）：只有声明了「我会读 _agentId」的
    // 工具才拿得到内部字段。无差别注入会让 StructuredOutput 的严格 schema 校验失败、
    // 让宽松 schema 捕获脏字段、并把 _agentId 当参数发给 MCP server。
    const internalFields: Record<string, unknown> = {};
    if (tool.consumesAgentId) {
      internalFields._agentId = "sub-agent";
      // E1：嵌套子代理带上派发它的 tool_use_id（与主循环同口径）
      if (block.name === "sub_agent") internalFields._parentToolUseId = block.id;
    }
    const result = await tool.execute(
      { ...cleanedInput, ...internalFields },
      signal,
      progressCallback,
    );
    const elapsed = Date.now() - startTime;
    // 中断分型：只看结构化信号（signal.aborted），与主循环同口径
    const interrupted = !!result.isError && signal?.aborted === true;

    // HC24：CwdChanged / TaskCreated / TaskCompleted。cwd 读 getCwd()：带 task.cwd 的子代理跑在
    // withAgentCwd 里，读到的是它自己的 ALS cwd；spawn 路径工具在父进程执行，读到的是会话级 cwd。
    fireToolSideEvents(
      hookSystem,
      block.name,
      cleanedInput,
      result,
      cwdBefore,
      getCwd(),
      hookAgentOptions()?.agent,
    );

    // LSP：edit/write 成功后同步最新内容（fire-and-forget）。诊断记在子代理名下，
    // 进程内经 agentic-loop 每轮注入，spawn 路径结束时转给主循环。
    if (!result.isError && (block.name === "write" || block.name === "edit")) {
      const editedPath = (effectiveInput?.file_path ?? effectiveInput?.path) as string | undefined;
      if (editedPath) {
        void import("../lsp/manager.ts")
          .then(({ syncFileToLSP }) => syncFileToLSP(editedPath, mode.diagnosticOwner))
          .catch(() => {
            /* best-effort，失败不影响子代理执行 */
          });
      }
    }

    // D9：超阈值把完整输出落盘，模型侧留头尾摘要 + 路径；只截断会让子代理再调一次同样的工具。
    const truncated = processToolResult(
      block.name,
      block.id,
      result.output,
      mode.sessionId,
      tool.maxResultSizeChars,
    );
    const displayMode = resolveResultDisplayMode(tool, effectiveInput);

    const withHookFeedback = await runPostToolHooks(hookSystem, {
      toolName: block.name,
      toolInput: effectiveInput,
      toolUseId: block.id,
      output: truncated,
      isError: !!result.isError,
      durationMs: elapsed,
      interrupted,
      isMcpTool: block.name.startsWith("mcp__"),
      // 结构化元数据继续往上传（bash 的 `sandboxed` 靠它落进轨迹）。子代理两条执行
      // 路径都收口到这个函数，这里漏传等于子代理的沙箱埋点全瞎。
      toolMeta: result.meta,
      sessionId: mode.sessionId,
      maxResultSizeChars: tool.maxResultSizeChars,
    });

    if (result.isError) {
      logToolFailure(block.name, {
        kind: interrupted ? "aborted" : "tool_error",
        durationMs: elapsed,
        filePath: efFilePath,
      });
    } else {
      logToolSuccess(block.name, {
        durationMs: elapsed,
        outputSize: result.output?.length ?? 0,
        filePath: efFilePath,
      });
    }

    // B14（HB-13a）：外部来源结果的不可信包裹。**排在 hook 收尾之后** ——
    // runPostToolHooks 可能整段替换输出，标签写在它之前会被冲掉且不会有测试变红。
    // 空内容不包（工具无输出且 hook 也没追加）：包一对空标签只会给模型一个错误的来源暗示。
    //
    // T2（D1）：未声明的顶层键提示与主循环同位置 —— 拼在包裹**外面**。
    // 子代理跑的是同一个模型，「参数被静默丢弃」在这里同样会让它以为参数生效了；
    // 提示若进包裹会被标成 untrusted，模型会当成不可信内容忽略。
    const notices = [unknownKeysNotice, hookModifiedNotice]
      .filter((n) => n.length > 0)
      .join("\n\n");
    const provenance =
      withHookFeedback.trim().length === 0
        ? undefined
        : resolveContentProvenance(
            block.name,
            effectiveInput,
            // 与主循环同口径：拿不到 checker 时保守视为工作区内（不包）。
            (p) =>
              deps.permissionChecker?.getPathValidator?.()?.isWithinWorkingDirectories(p) ?? true,
          );
    const rendered = provenance
      ? wrapExternalContent(withHookFeedback, provenance)
      : withHookFeedback;

    return {
      type: "tool_result",
      tool_use_id: block.id,
      // 附言前置（与主循环同序：先看到「参数被改过 / 被忽略」，再读结果与 hook 反馈）
      content: notices.length > 0 ? notices + "\n\n" + rendered : rendered,
      is_error: result.isError,
      ...(result.structuredPatch?.length ? { structuredPatch: result.structuredPatch } : {}),
      // TUI 呈现档位：错误结果不带（错误照常显示，见 tool/types.ts 的硬约束 ②）。
      ...(!result.isError && displayMode ? { resultDisplayMode: displayMode } : {}),
    };
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    log.error("SUBAGENT:TOOL", `工具执行异常: ${block.name}`, { error: errorMessageOf(err) });
    const failureFeedback = await runToolExceptionHook(hookSystem, {
      toolName: block.name,
      toolInput: effectiveInput,
      toolUseId: block.id,
      error: err,
      durationMs: elapsed,
      signal,
    });
    // 取消单独分型：它不是「工具不可靠」的证据，混进 exception 会污染失败率。
    logToolFailure(block.name, {
      kind: signal?.aborted === true || isAbortError(err) ? "aborted" : "exception",
      durationMs: elapsed,
      filePath: efFilePath,
    });
    return errorResult(
      block.id,
      `工具执行异常: ${errorMessageOf(err)}` +
        (failureFeedback ? `\n\n[Hook 反馈]\n${failureFeedback}` : ""),
    );
  }
}

/**
 * 权限门：通过返回 null，拒绝返回 error tool_result。
 *
 * 有检查器：dontAsk 语义，危险命令/safetyCheck 拦截，needsConfirmation 也直接 deny（无 UI 通道）。
 * 无检查器：B0 分级 fail-closed——只读工具放行，写类工具拒绝。不是「缺省即全拒」：纯只读子代理
 * （explore/summarize）与旧测试本就不需要检查器；真正的缺口是「没配检查器却放过了写操作」，
 * 自定义子代理路径曾因漏传检查器让 edit/bash 绕过权限层（P0）。判定走 judgeConcurrencySafe：
 * 自定义/插件工具的 isConcurrencySafe 抛错时按 unsafe 处理，不会把 fail-closed 炸穿。
 */
async function checkPermission(
  block: ToolUseBlock,
  tool: Tool,
  effectiveInput: Record<string, unknown>,
  deps: RunToolUseDeps,
  mode: RunToolUseMode,
  ctx: { hookPermissionDecision?: "allow" | "ask"; toolStartedAt: number },
): Promise<ToolResultBlock | null> {
  const log = getLogger();
  const { hookSystem, permissionChecker } = deps;
  // context:"subagent" 每个调用点字面写出（不经展开）：不分路径则子代理的拒绝与主循环的混在一桶里，
  // 埋点哨兵 analytics/instrumentation-sentinel.test.ts 按源码字面量核 allow/deny 覆盖同一组路径。
  // needsPrompt:false：子代理结构上没有弹窗通道。
  const common = {
    needsPrompt: false,
    ...(mode.agentId ? { agentId: mode.agentId } : {}),
    // B19：与权限审计行同一个 tool_use_id，两边按它 join
    toolUseId: block.id,
  };

  if (permissionChecker) {
    // G14：与主循环同一入口展开观测路径（`~`、相对路径 → 绝对路径），hook 改写后的参数同样展开。
    const observableInput = buildObservableInput(tool, effectiveInput);
    const permReq: PermissionRequest = {
      toolName: block.name,
      input: observableInput,
      description: `${block.name}: ${JSON.stringify(observableInput).slice(0, 120)}`,
      toolUseId: block.id,
    };
    const decision = await permissionChecker.check(permReq, tool, undefined, {
      hookPermissionDecision: ctx.hookPermissionDecision,
    });
    const reasonFields = {
      reasonType: decision.decisionReason?.type,
      step: decision.step,
      mode: decision.mode,
      guard: guardOf(decision),
    };
    if (!decision.allowed) {
      const reason = decision.reason || "子代理不允许此操作";
      log.info("SUBAGENT:PERM", `权限拒绝 ${block.name}: ${reason}`);
      logPermissionDeny(block.name, {
        source: "rule",
        durationMs: Date.now() - ctx.toolStartedAt,
        context: "subagent",
        ...common,
        ...reasonFields,
      });
      // Q7：权限拒绝只 fire PermissionDenied（对齐 CC），span 由 runtime 消费者按它关闭。
      firePermissionDenied(
        hookSystem,
        block.name,
        effectiveInput,
        reason,
        decision.decisionReason?.type === "rule" ? "rule" : "auto",
        block.id,
      );
      return errorResult(block.id, `权限拒绝: ${reason}`);
    }
    // 缺陷 5：allow 与 deny 必须覆盖同一组路径，否则拒绝率 = deny/(0+deny) 恒 100%。
    logPermissionAllow(block.name, {
      source: "rule",
      durationMs: Date.now() - ctx.toolStartedAt,
      context: "subagent",
      ...common,
      ...reasonFields,
    });
    return null;
  }

  // source:"other" 而非 "rule"：这里没有规则参与，是缺依赖时的兜底档——填 "rule" 会伪装成配置生效。
  if (!judgeConcurrencySafe(tool, effectiveInput)) {
    const reason = "未配置权限检查器，写类操作默认拒绝（fail-closed）";
    log.info("SUBAGENT:PERM", `权限拒绝 ${block.name}: ${reason}`);
    // fail-closed 拒绝必须记：它是「调用方漏传 permissionChecker」的唯一可观测信号。
    logPermissionDeny(block.name, {
      source: "other",
      durationMs: Date.now() - ctx.toolStartedAt,
      context: "subagent",
      ...common,
      reasonType: "other",
    });
    firePermissionDenied(hookSystem, block.name, effectiveInput, reason, "auto", block.id);
    return errorResult(block.id, `权限拒绝: ${reason}`);
  }
  logPermissionAllow(block.name, {
    source: "other",
    durationMs: Date.now() - ctx.toolStartedAt,
    context: "subagent",
    ...common,
    reasonType: "other",
  });
  return null;
}

function filePathOf(input: Record<string, unknown> | undefined): string | undefined {
  return typeof input?.file_path === "string" ? input.file_path : undefined;
}
