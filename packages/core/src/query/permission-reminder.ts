/**
 * 权限模式每轮可见（缺口 C）
 *
 * 对应《Harness-LLM 可见性缺口》缺口 C：permission mode 只进被 5 分钟缓存冻结的
 * system prompt，运行时切换（acceptEdits / readonly / dontAsk 等）不刷新。
 *
 * 根因：mode 行为指南原先只经 system prompt 附件注入，而 system prompt 有缓存
 * （system-prompt.ts CACHE_TTL），且仅在 init / CLAUDE.md 变更时重建，主循环每轮不重建。
 * 用户中途切 mode 后，模型上下文里仍是会话启动时的旧值。
 * plan mode 另有 getPlanModeReminder 每轮注入兜住了"切入 plan"，但其它 mode 之间的切换
 * 没有任何每轮通道。
 *
 * 解决思路（对标 claude-code command_permissions / hook_permission_decision delta 通道）：
 * 把 mode 指南从"只在 system prompt"改为"走每轮 reminder 通道"。
 * 复用 attachments.ts 的 PERMISSION_MODE_DESCRIPTIONS，避免文案重复维护。
 *
 * ⚠️ 现状（2026-07-30 重复注入根因修复 P0）：本通道已是**唯一**通道。
 * 那条 system 附件通道（generatePermissionModeAttachment）当时与本通道并存，
 * 导致同一份文案同轮在 system role 与 user role 各出现一次，已删除。
 * 因此不要因为"system prompt 里反正也有一份"而弱化这里的注入判定——那份已经没有了。
 * plan mode 例外：它被本通道排除（loop.ts `mode !== "plan"`），约束由
 * plan/prompt.ts 的 buildPlanModeReminder 承载，见那里的门控注释。
 *
 * 设计原则：纯函数（入 mode，出字符串 | null），便于单测。
 */

import { PERMISSION_MODE_DESCRIPTIONS } from "../config/attachments.ts";

/**
 * 非 default permission mode 持续时的低频重述间隔（轮）。
 * 与 todo 回注节流（8 轮）对齐：mode 变化的那一轮强注入（防时机缺失），
 * 之后每隔 N 轮低频重述一次（防长任务里遗忘当前受何约束）。
 */
export const PERMISSION_MODE_REMINDER_INTERVAL = 8;

/**
 * 是否算「运行时真实切换」。
 *
 * 负收益防线审计 发现 4（2026-07-30）：`lastSeen === undefined` 是**会话首轮的基线初始化**，
 * 不是切换。旧判据 `lastSeen !== mode` 把它算成 changed，导致每个以非 default mode 启动的
 * 会话首轮都强注入一条"权限模式已切换为…"——实测 24 个会话全程 mode 从未变过，
 * 三个会话 turn#1 的注入逐字节完全相同，共 37 次零新信息注入。
 *
 * 为什么首轮不该注入：首轮的 system prompt 正是本会话第一次构造（尚未被 5 分钟缓存冻结），
 * 里面已含同一份 mode 行为指南。缺口 C 要修的是「运行时切 mode 后 system prompt 不刷新」，
 * 首轮压根没有这个缺口。
 */
export function isRuntimeModeSwitch(lastSeen: string | undefined, mode: string): boolean {
  if (lastSeen === undefined) return false; // 基线初始化，非切换
  return lastSeen !== mode;
}

/**
 * 构造 permission mode system-reminder。
 *
 * @param mode 当前权限模式（调用方已保证非 default、非 plan）
 * @param justChanged 本轮是否刚发生 mode 切换（true 时文案强调"已切换"）
 * @returns system-reminder 文本；mode 无对应描述时返回 null
 */
export function buildPermissionModeReminder(mode: string, justChanged: boolean): string | null {
  const description = PERMISSION_MODE_DESCRIPTIONS[mode];
  // 未知 mode（无对应描述）不注入，避免喂给模型空洞约束
  if (!description) return null;

  const header = justChanged
    ? `权限模式已切换为「${mode}」，从现在起遵守以下约束：`
    : `当前权限模式为「${mode}」，请持续遵守以下约束：`;

  return `<system-reminder>
${header}

${description}

（请勿向用户提及或复述本提醒）
</system-reminder>`;
}
