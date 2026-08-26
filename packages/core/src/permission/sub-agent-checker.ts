/**
 * 子代理专用 PermissionChecker 工厂
 *
 * 为子代理创建 dontAsk 语义的 PermissionChecker：
 * - 危险命令拦截 + safetyCheck 照常生效
 * - ask 场景自动 deny（子代理不弹窗）
 * - 每个子代理实例独立的 denialTracking（隔离互不影响）
 * - 复用主 checker 的规则和分类器配置（共享实例，无状态，安全）
 */

import { PermissionChecker } from "./checker.ts";
import type { Config } from "../config/config.ts";

/**
 * 从主 checker 派生子代理专用 checker。
 *
 * @param mainChecker 主循环的 PermissionChecker（提供规则/分类器/配置）
 * @param workspacePath 工作区路径（子代理可能在 worktree 中，路径不同于主代理）
 */
export function createSubAgentChecker(
  mainChecker: PermissionChecker,
  workspacePath?: string,
): PermissionChecker {
  // 构造 config 副本，强制 permissionMode = "dontAsk"
  // dontAsk 语义：checker 返回 ask 时，上层（非交互模式后处理）自动 deny
  const mainConfig = mainChecker.getConfig();
  const config: Config = {
    ...mainConfig,
    permissionMode: "dontAsk",
  } as Config;

  const checker = new PermissionChecker(config, undefined, workspacePath);

  // 复用主 checker 的分类器（BashClassifier 无内部状态，共享安全）
  const classifier = mainChecker.getBashClassifier();
  if (classifier) {
    checker.setBashClassifier(classifier);
  }

  // 复用主 checker 的规则（已经过安全过滤，直接复制）
  checker.getRuleLoader().importFromRuleLoader(mainChecker.getRuleLoader());

  // 必须紧跟一次 refresh：RuleLoader 与 checker 的 `this.rules` 是**两份状态**，
  // importFromRuleLoader 只灌前者。而阶段一（hasPermissionsInner）的所有规则分支
  // ——Step 1 checkDenyRules、Step 4 敏感文件逃生舱的 checkAllowRules、Step 5 ask 规则、
  // Step 8 checkAllowRules——以及 isPathHidden()，一律以 `if (this.rules)` 为前置门，
  // 只读后者。上面用 `new PermissionChecker(config, undefined, ...)` 构造，
  // 该字段初值是 null，不 refresh 则这些分支在子代理上**整段短路**：
  // allow 规则失效（子代理被 dontAsk 兜底拒掉，白撞墙多花轮次）、
  // 非凭证类 deny 规则直接放行（`Read(internal/**)` 这种不被 SENSITIVE_FILES 正则
  // 碰巧命中的路径，子代理读得到）、isPathHidden 恒 false（glob/ls 的 deny 过滤失效）。
  // 尤其阴的是 deny 场景结论仍是"拒绝"（被 dontAsk 兜底掩盖，只有 decisionReason
  // 从 rule 变成 mode），所以这个 bug 长期没暴露——反漂移测试因此断言到 decisionReason。
  checker.refreshRulesFromLoader();

  return checker;
}
