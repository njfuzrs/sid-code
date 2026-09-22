/**
 * 远程策略接线探针（M3 遗留 P6/P7）。
 *
 * 劝阻附件会让模型不发 bash，audit 零新增——「防线全在、调用全 0」。
 * 出口「规则进了 checker」不能再靠 LLM 撞墙，也不该拆附件刷分子。
 *
 * 本模块不经模型：对已经 initRules 的 checker 打一次
 * `bash curl https://example.com`，audit 标 `source=policy-probe`。
 * 触发率脚本把探针行和真实工具行分开计。
 */

import { getLogger } from "../debug/logger.ts";
import { isRemotePolicyApplied } from "../config/remote-policy-state.ts";
import type { PermissionChecker } from "./checker.ts";
import type { Decision } from "./types.ts";

export const POLICY_PROBE_COMMAND = "curl https://example.com";
export const POLICY_PROBE_SOURCE = "policy-probe";

export interface PolicyProbeResult {
  ran: boolean;
  decision?: Decision;
}

/**
 * 仅当远程策略已 applied 时跑一次。未配 endpoint / 204 / 超时无缓存 → 不打，
 * 避免无策略环境每天往 audit 灌一条无关 bash。
 */
export async function runRemotePolicyProbe(checker: PermissionChecker): Promise<PolicyProbeResult> {
  if (!isRemotePolicyApplied()) return { ran: false };
  const log = getLogger();
  try {
    const decision = await checker.check(
      { toolName: "bash", input: { command: POLICY_PROBE_COMMAND } },
      undefined,
      undefined,
      { auditSource: POLICY_PROBE_SOURCE },
    );
    const hit =
      !decision.allowed && !decision.needsConfirmation && decision.decisionReason?.type === "rule";
    log.info(
      "POLICY",
      `探针 bash(${POLICY_PROBE_COMMAND}) → ${hit ? "rule deny" : decision.allowed ? "allow" : (decision.decisionReason?.type ?? "other")} source=${POLICY_PROBE_SOURCE}`,
    );
    return { ran: true, decision };
  } catch (err: any) {
    log.warn("POLICY", `探针失败: ${err?.message ?? err}`);
    return { ran: false };
  }
}
