/**
 * 权限决策解释器（G15，对标 claude-code permissionExplainer.ts）
 *
 * 把 checker.ts 广泛构造的结构化 `PermissionDecisionReason`（判别式联合类型）
 * 翻译成一句人类可读的中文解释：命中哪条规则 / 哪个模式 / 哪个路径校验 / 来自哪个来源，
 * 供权限拒绝/确认提示、debug 日志、审计输出复用。
 *
 * 纯函数、无副作用。switch 穷尽所有 type 变体，default 分支用 `never` 兜底——
 * 未来在 types.ts 给 PermissionDecisionReason 新增变体却漏改这里时，TS 会在编译期报错，
 * 防止解释逻辑与类型定义漂移。
 */

import type { Decision, PermissionDecisionReason, PermissionRuleSource } from "./types.ts";

/** 权限模式的中文名（与 permission/mode.ts 展示口径一致，缺省回退原值） */
const MODE_LABELS: Record<string, string> = {
  "always-allow": "全部允许（always-allow）",
  "acceptEdits": "自动接受编辑（acceptEdits）",
  "deny-write": "拒绝写入（deny-write）",
  "yesMode": "自动批准（--yes）",
  "auto": "自动分类（auto）",
  "dontAsk": "从不询问（dontAsk）",
  "plan": "计划模式（plan）",
  "plan+plan-file": "计划模式·计划文件放行",
  "plan+bypass": "计划模式·继承 bypass 放行",
};

/** 规则来源的中文名（对标 types.ts PermissionRuleSource 八来源） */
const SOURCE_LABELS: Record<PermissionRuleSource, string> = {
  session: "运行时会话（弹窗 Always Allow / 命令临时）",
  command: "斜杠命令（/allow、/deny）",
  cliArg: "CLI 参数（--allow-tool / --deny-tool）",
  userSettings: "用户设置（~/.sid-code/settings.json）",
  projectSettings: "项目设置（.sid-code/settings.json，不可信来源）",
  localSettings: "本地设置（.sid-code/settings.local.json）",
  flagSettings: "SDK 内联设置",
  policySettings: "企业策略（最高优先级）",
};

/** 把权限模式字符串翻译成中文名 */
function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

/**
 * 解释单个决策原因（判别式联合）。穷尽所有 type，default 用 never 兜底防漂移。
 *
 * @param reason 结构化决策原因
 * @returns 一句中文解释
 */
export function explainDecisionReason(reason: PermissionDecisionReason): string {
  switch (reason.type) {
    case "rule": {
      const behaviorLabel =
        reason.behavior === "allow" ? "允许" : reason.behavior === "deny" ? "拒绝" : "需确认";
      // rule 字段是命中的规则文本（如 "Bash(npm *)"）或 "allow" 占位
      const ruleText = reason.rule && reason.rule !== "allow" ? `：${reason.rule}` : "";
      return `命中权限规则（${behaviorLabel}）${ruleText}`;
    }

    case "mode":
      return `由权限模式决定：${modeLabel(reason.mode)}`;

    case "safetyCheck": {
      const approvable = reason.classifierApprovable
        ? "（分类器可在上下文中审批）"
        : "（绝对禁止自动审批，必须人工确认）";
      return `安全检查拦截：${reason.reason}${approvable}`;
    }

    case "dangerousCommand":
      return `危险命令检测命中（严重级 ${reason.severity}）：${reason.pattern}`;

    case "pathValidation":
      return `路径校验拦截：${reason.reason}`;

    case "sessionMemory":
      return "沿用本会话已记住的权限决策";

    case "denialTracking":
      return `连续拒绝熔断：连续 ${reason.consecutiveDenials} 次、累计 ${reason.totalDenials} 次被拒绝，回退人工确认`;

    case "other":
      return reason.reason;

    default: {
      // 穷尽性检查：新增 PermissionDecisionReason 变体却漏改本 switch 时，此处编译报错。
      const _exhaustive: never = reason;
      return String((_exhaustive as { type?: string })?.type ?? "未知原因");
    }
  }
}

/**
 * 解释完整决策：把 allowed/needsConfirmation 结论与 decisionReason 组合成一句话。
 *
 * 无 decisionReason 时回退到 decision.reason 文本；两者都缺时给通用兜底。
 *
 * @param decision 权限决策
 * @returns 面向用户/日志的中文解释
 */
export function explainDecision(decision: Decision): string {
  const verdict = decision.allowed
    ? "允许"
    : decision.needsConfirmation
      ? "需要确认"
      : "拒绝";

  let detail: string;
  if (decision.decisionReason) {
    detail = explainDecisionReason(decision.decisionReason);
  } else if (decision.reason) {
    detail = decision.reason;
  } else {
    detail = "无附加原因";
  }

  return `${verdict} — ${detail}`;
}
