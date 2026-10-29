/**
 * 并发冲突检测共享闸门（PR-6 提取）
 *
 * edit / write / notebook_edit 三个写路径工具在落盘前共用的冲突处理流程：
 *   block 阻止 → worktree 分支分叉自动放行（PR-4）→ 弹窗人工裁决 → 无头降级。
 *
 * ## 为什么提取
 *
 * 这段逻辑此前在 edit.ts 与 write.ts 各有一份完整拷贝，注释里写着「两处必须同步改」
 * ——靠人肉同步的契约迟早漂移。PR-6（B8）要给 notebook_edit 接同一套检测，第三份
 * 拷贝不可接受，故收敛为单一实现。三个工具的行为差异只剩传入的 tool 名（埋点口径）。
 *
 * ## 语义（与提取前逐行一致）
 *
 * - tracker 缺失 / conflictDetection=false / severity=off / 无 sessionId → 直接放行；
 * - block 模式判定在**最前**——显式配置说要拦就拦，哪怕只是分支分叉（显式配置 >
 *   自动决策，PR-4 验证用例咬住这条优先级）；
 * - isWorktreeBranchConflict=true → 不调 conflictHandler（不弹窗）直接放行，
 *   note 带回说明文案由调用方拼进成功输出；埋点 branch_auto_continue（A1 契约：
 *   与用户裁决的 continue 分开，保护误报率代理口径）；
 * - 其余冲突走 conflictHandler 弹窗（stop/skip 拒绝，continue 放行）；
 * - handler 未注入（无头模式 SDK/Bridge/--print）→ 降级放行，只记 warn 日志与埋点。
 *
 * conflict-detector / conflict-analytics 沿用调用方原本的动态 import——检测模块
 * 只在真的发现冲突时才加载，不占启动路径。
 */

import type { FileReadTracker } from "./file-read-tracker.ts";
import { getLogger } from "../debug/logger.ts";

/** 闸门结果：放行（note 拼进成功输出）或拒绝（output 即最终错误输出） */
export type ConflictGateOutcome =
  | { proceed: true; note: string }
  | { proceed: false; output: string };

/**
 * 冲突检测闸门。写路径工具在落盘前调用。
 *
 * @param filePath 目标文件绝对路径（已 normalize）
 * @param tool 触发工具名（埋点口径，见 conflict-analytics ConflictEvent.tool）
 * @param tracker 会话的 FileReadTracker（null/undefined 时整段跳过，兼容旧构造路径）
 */
export async function runConflictGate(
  filePath: string,
  tool: "edit" | "write" | "notebook_edit",
  tracker: FileReadTracker | null | undefined,
): Promise<ConflictGateOutcome> {
  const conflictEnabled = tracker?.conflictDetection ?? true;
  const conflictSeverity = tracker?.conflictSeverity ?? "warn";
  if (!conflictEnabled || conflictSeverity === "off" || !tracker?.sessionId) {
    return { proceed: true, note: "" };
  }

  const log = getLogger();
  const {
    checkConflict,
    formatConflictWarning,
    formatHeadlessConflictNote,
  } = await import("../session/conflict-detector.ts");
  const conflict = checkConflict(filePath, tracker.sessionId);
  if (!conflict) {
    return { proceed: true, note: "" };
  }

  log.warn("TOOL", formatConflictWarning(conflict));

  // P2-14：埋点——记录冲突事件
  const { recordConflict } = await import("../session/conflict-analytics.ts");
  const sessionCount = conflict.conflictingSessions.length;

  // Phase 2.4: block 模式直接阻止，不弹框。判定保持在自动放行之前——
  // 用户显式配置 conflictSeverity=block 时，哪怕只是分支分叉也照样拦。
  if (conflictSeverity === "block") {
    recordConflict(filePath, sessionCount, conflict.severity, "blocked", tool);
    return {
      proceed: false,
      output: `错误: 检测到并发冲突（config.conflictSeverity=block），文件 ${filePath} 正被其他会话访问，操作已阻止`,
    };
  }

  // PR-4（B-c）：全部冲突方都是 worktree 分支分叉 → 不弹窗直接放行。
  // 双方各自改自己 worktree 里的物理文件，不存在「互相覆盖」风险，合并回
  // 主仓时才真正撞车——弹窗让用户裁决一个无法当场处理的事，纯打断成本。
  // A1 契约：埋点记 branch_auto_continue（无人裁决的自动放行），必须与
  // 弹窗里用户裁决的 continue 分开，否则误报率代理（action=continue 占比）
  // 的分子掺进没问过的样本，指标自欺。
  if (conflict.isWorktreeBranchConflict) {
    recordConflict(filePath, sessionCount, conflict.severity, "branch_auto_continue", tool);
    log.info("TOOL", "worktree 分支分叉冲突：不弹窗自动放行（branch_auto_continue）");
    return {
      proceed: true,
      note: `（并发分支提示：${conflict.summary}；各方改的是自己 worktree 里的副本，不会互相覆盖，合并回主仓时再解决冲突即可）`,
    };
  }

  if (tracker.conflictHandler) {
    // Phase 2.1: warn 模式弹框让用户选择（同文件冲突才走到这里）
    const action = await tracker.conflictHandler(conflict);
    log.info("TOOL", `并发冲突用户选择: ${action}`);

    // P2-14：埋点——记录用户选择
    recordConflict(filePath, sessionCount, conflict.severity, action, tool);

    if (action === "stop") {
      return {
        proceed: false,
        output: `错误: 用户选择停止（检测到并发冲突，文件 ${filePath} 正被其他会话访问）`,
      };
    }
    if (action === "skip") {
      return {
        proceed: false,
        output: `跳过: 用户选择跳过冲突文件 ${filePath}`,
      };
    }
    // action === "continue" → 继续执行
    return { proceed: true, note: "" };
  }

  // P1-6：无头模式（SDK/Bridge/--print）下 conflictHandler 为 undefined，
  // 显式降级：冲突摘要进 warn 日志，让模型知道有冲突但继续执行。
  // 与 block 模式不同，不阻断操作（无头模式无法弹框等待用户决定）。
  const warningSummary = formatConflictWarning(conflict);
  log.warn(
    "TOOL",
    `无头模式：并发冲突降级处理，继续执行（${warningSummary.split("\n").slice(1, 4).join(" ")}）`,
  );
  // P2-14：埋点——记录无头模式降级
  recordConflict(filePath, sessionCount, conflict.severity, "headless_fallback", tool);
  return { proceed: true, note: formatHeadlessConflictNote(conflict) };
}
