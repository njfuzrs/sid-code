/**
 * 子代理专用 PermissionChecker 工厂
 *
 * 为子代理创建 dontAsk 语义的 PermissionChecker（可选继承全放行档位，见 inheritBypassMode）：
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
/** 主会话处于这些模式时，子代理继承之（P4，对齐 CC：fork 子代理继承主会话 toolPermissionContext.mode） */
const INHERITABLE_BYPASS_MODES = new Set(["always-allow", "dangerously-skip-permissions"]);

export interface SubAgentCheckerOptions {
  /**
   * 继承主会话的「全放行」类模式（always-allow / dangerously-skip-permissions），其余仍降为 dontAsk。
   *
   * 用户显式选了 always-allow（修复前子代理被强制改成 dontAsk，allow 规则外的写操作一律被拒）
   * 或 skip 档位时，子代理跟随主会话放行面。deny 规则、危险命令、safetyCheck 都排在
   * Step 8 bypass 早退之前，继承后照常生效（这是「继承」而非「裸奔」的判据）。
   *
   * 由 App.wireToolPermissionChecker 统一开启（喂给所有子代理类工具：SubAgentTool /
   * WorkflowTool / SendMessageTool / skill 元工具），forked-command 也用同一入口。
   */
  inheritBypassMode?: boolean;
}

export function createSubAgentChecker(
  mainChecker: PermissionChecker,
  workspacePath?: string,
  options: SubAgentCheckerOptions = {},
): PermissionChecker {
  // 构造 config 副本：默认强制 permissionMode = "dontAsk"（ask 场景自动 deny）；
  // inheritBypassMode 时继承全放行类档位。
  const mainConfig = mainChecker.getConfig();
  const inherit =
    options.inheritBypassMode === true && INHERITABLE_BYPASS_MODES.has(mainConfig.permissionMode);
  let mode = inherit ? mainConfig.permissionMode : "dontAsk";
  // 收紧（本 PR）：子代理 checker 不复制主会话的 skipPermissions 布尔。
  // 它的消费点在 checker.check() 的最顶端早退（排在危险命令/safetyCheck 之前），
  // 复制过去等于让子代理连危险命令都不拦——主会话选 skip 档授权的是「主循环完全跳过」，
  // 不是「派生出去的每个子代理也裸奔」。清除后 skip 档的放行语义改由下面归一到
  // always-allow 承接：内层 pipeline 没有 dangerously-skip-permissions 的消费分支
  // （Step 8 只认 always-allow），保留原字符串会让写操作落到 Step 14 ask 再被
  // dontAsk 后处理 deny，继承路径退化成「读放行写全拒」。
  if (mode === "dangerously-skip-permissions") mode = "always-allow";
  const config: Config = {
    ...mainConfig,
    permissionMode: mode,
    skipPermissions: false,
  } as Config;

  const checker = new PermissionChecker(config, undefined, workspacePath);
  checker.setParentChecker(mainChecker);

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
