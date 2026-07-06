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

  return checker;
}
