/**
 * bash 命令的形状分类（B12 / B13）。
 *
 * ## 为什么由 checker 在决策时算好、写进事件
 *
 * `trace-digest` 只能看到 `events.jsonl`，而那里存的命令文本是**截断过的**
 * （本会话 51 条普通确认里有 25 条超过 200 字符）。从截断文本重新分类，
 * 「工作区内 `cd` + 只读」这种长命令会被整段误判成「非只读其他」——
 * 于是「修完之后有多少确认变少了」这个读数本身就是错的，而且它看起来像数据。
 *
 * 所以分类放在做决策的那一刻：checker 手里有完整命令、有工作区路径、也有最终决策，
 * 一次算好、以固定枚举落盘，digest 只做计数。
 *
 * ## 判据与附录 A.3 的脚本保持一致
 *
 * 顺序：危险确认 → 无 `cd` 前缀 → `cd` 到工作区外 → 工作区内 `cd` + 只读 / 非只读。
 *
 * ⚠️ 这是**上界估计**：它只看「命令以 `cd <目标>` 开头 + 剥掉前缀后主体是否只读」，
 * 不看 B4 的 git 仓库身份（换仓后的 `cd` 会被 PR-2 收紧）。所以「工作区内 cd + 只读」
 * 这个桶在 PR-2 合入前包含一些实际仍需确认的项，读数时要带着这个前提。
 * 与 A.3 一致是有意的：基线数字（§1.4）出自那份脚本，判据不同就无法对拍。
 */

import { isReadOnlyCommand } from "../tool/bash/read-only-validation.ts";
import { stripLeadingCdAndEnv } from "../query/repeated-readonly-guard.ts";

/**
 * bash 命令的形状桶。固定枚举，只进本地轨迹。
 *
 * 桶名与 `trace-digest` 的「确认成因」分桶一一对应（B13），改这里要同步改那边。
 */
export type BashShape =
  /** 危险命令确认（细分成因看 `PermissionDecision.danger_pattern`） */
  | "dangerous"
  /** 无 `cd` 前缀：命令形状与 cd 无关 */
  | "no_cd_prefix"
  /** `cd` 到工作区外（目标不以工作区路径开头） */
  | "cd_outside_workspace"
  /** 工作区内 `cd` + 只读主体 —— 可免确认的候选（PR-2 才真正免） */
  | "cd_workspace_readonly"
  /** 工作区内 `cd` + 非只读主体 */
  | "cd_workspace_nonreadonly";

/** `cd <目标> && ...` 的首段（与附录 A.3 同一条正则） */
const LEADING_CD = /^cd\s+(\S+)\s*&&/;

/**
 * 给一条 bash 命令分类。
 *
 * @param command 完整命令原文（不是截断后的）
 * @param workspacePath 工作区根路径（`PathValidator.getWorkspacePath()`）
 * @param dangerous 决策是否已按危险命令处理（`decisionReason.type === "dangerousCommand"`）
 * @returns 分类；命令为空或不是字符串时返回 undefined（调用方据此不落字段）
 */
export function classifyBashShape(input: {
  command: string;
  workspacePath: string;
  dangerous: boolean;
}): BashShape | undefined {
  if (!input.command.trim()) return undefined;
  // 危险优先：与 A.3 的 `reason_type === "dangerousCommand"` 同序
  if (input.dangerous) return "dangerous";
  const m = LEADING_CD.exec(input.command);
  if (!m) return "no_cd_prefix";
  if (!m[1].startsWith(input.workspacePath)) return "cd_outside_workspace";
  return isReadOnlyCommand(stripLeadingCdAndEnv(input.command))
    ? "cd_workspace_readonly"
    : "cd_workspace_nonreadonly";
}
