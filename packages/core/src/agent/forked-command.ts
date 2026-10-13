/**
 * fork 型斜杠命令 / skill 的唯一执行入口（P3）。
 *
 * 修复前 6 个调用方各自手写「建 SubAgent → 注入 checker → 解析工具 → executeCustom」，
 * 自定义命令那一处漏了注入 checker，子代理落到 tool-executor 的 B0 兜底分支：只读放行、
 * 其余 fail-closed（轨迹 20261013-100055-7eeb1160：`source=other, context=subagent` 的 deny）。
 * 收成一个函数后「漏注入」在结构上不再可能：`permissionChecker` 是必填字段，缺失直接报错返回。
 *
 * 语义对齐 CC（`utils/forkedAgent.ts`）：
 * - 工具集 = `agentType ?? "general-purpose"` 的完整工具集，**不**用 `allowed-tools` 裁剪；
 * - 权限 = 主会话的 checker（always-allow / skip-permissions 继承，其余 dontAsk），
 *   再叠加 `allowed-tools` 作为**派生实例**上的 commandScoped allow 规则（不污染主 checker）。
 */

import type { ProviderRegistry } from "../llm/registry.ts";
import type { Registry as ToolRegistry } from "../tool/registry.ts";
import type { HookSystem } from "../hook/system.ts";
import type { Checker } from "../permission/types.ts";
import type { SubAgentResult } from "./sub-agent.ts";
import type { AllowedToolsSpec } from "../tool/allowed-tools-spec.ts";
import { getLogger } from "../debug/logger.ts";

export interface ForkedCommandOptions {
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  hookSystem?: HookSystem;
  /** 必填（可为 null）：类型层逼调用方表态。null → 直接返回失败，而不是让子代理 fail-closed */
  permissionChecker: Checker | null;
  /** 命令名（日志 / 告警用） */
  name: string;
  prompt: string;
  systemPrompt?: string;
  /** `allowed-tools`：只作为本次 fork 的免确认 allow 规则 */
  allowedRules?: AllowedToolsSpec;
  /** 来源是否可信：false（项目级命令 / skill、MCP skill）时剥离危险自我授权规则 */
  trusted: boolean;
  /** 工具集来源的 agent 类型（skill 的 `agent:`）；缺省 general-purpose */
  agentType?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns?: number;
  timeout?: number;
  /** 子代理类型标签（记忆目录 / 轨迹归属）；缺省同 agentType */
  type?: string;
  signal?: AbortSignal;
}

/** 无 checker 时返回给调用方的文案（入口保证有 checker，走到这里说明是接线缺陷） */
export const FORK_WITHOUT_CHECKER_MESSAGE = "无权限检查器，fork 命令无法执行（接线缺陷，请反馈）";

type DerivableChecker = Checker & {
  getRootChecker?: () => Checker;
  getConfig?: () => unknown;
  getRuleLoader?: () => unknown;
};

/**
 * 从主会话 checker 派生本次 fork 专用的 checker。
 *
 * 传进来的可能是主 checker，也可能是 app 下发给工具的子代理 checker（快照、已是 dontAsk）——
 * 两者都回到根上重新派生，模式取主会话**当前**值（用户中途 Shift+Tab 切模式也跟得上）。
 * 非 PermissionChecker 实现（测试替身 / 外部 Checker）原样使用，只是拿不到 commandScoped 规则。
 */
async function deriveForkChecker(
  base: Checker,
  allowedRules: AllowedToolsSpec | undefined,
  trusted: boolean,
  name: string,
): Promise<{ checker: Checker; dropped: string[] }> {
  const { PermissionChecker } = await import("../permission/checker.ts");
  const root = (base as DerivableChecker).getRootChecker?.() ?? base;
  if (!(root instanceof PermissionChecker)) {
    return { checker: base, dropped: [] };
  }
  const { createSubAgentChecker } = await import("../permission/sub-agent-checker.ts");
  const derived = createSubAgentChecker(root, undefined, { inheritBypassMode: true });
  const dropped =
    allowedRules && allowedRules.rules.length > 0
      ? derived.setCommandScopedRules(allowedRules.rules, trusted, `/${name} allowed-tools`)
      : [];
  return { checker: derived, dropped };
}

export async function runForkedCommand(opts: ForkedCommandOptions): Promise<SubAgentResult> {
  const log = getLogger();
  if (!opts.permissionChecker) {
    log.error("FORK_CMD", `/${opts.name}: ${FORK_WITHOUT_CHECKER_MESSAGE}`);
    return {
      success: false,
      output: FORK_WITHOUT_CHECKER_MESSAGE,
      usage: { inputTokens: 0, outputTokens: 0 },
      turns: 0,
      toolUseCount: 0,
    };
  }

  const { checker, dropped } = await deriveForkChecker(
    opts.permissionChecker,
    opts.allowedRules,
    opts.trusted,
    opts.name,
  );
  const agentType = opts.agentType ?? "general-purpose";
  log.info("FORK_CMD", `/${opts.name} fork 执行`, {
    agentType,
    allowRules: opts.allowedRules?.rules ?? [],
    dropped,
  });

  const { SubAgent } = await import("./sub-agent.ts");
  const subAgent = SubAgent.fromRegistry(
    opts.providerRegistry,
    opts.toolRegistry,
    opts.hookSystem,
    opts.model,
  );
  subAgent.setPermissionChecker(checker);

  return subAgent.executeCustom(
    {
      systemPrompt: opts.systemPrompt ?? "你是一个专注的助手，请完成以下任务。",
      userPrompt: opts.prompt,
      allowedTools: [],
      toolsFromAgentType: agentType,
      maxTurns: opts.maxTurns ?? 30,
      timeout: opts.timeout,
      effort: opts.effort,
      type: opts.type ?? agentType,
    },
    opts.signal,
  );
}
