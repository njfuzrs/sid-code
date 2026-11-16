/**
 * dream 宿主侧损失校验（漂移与维护方案 T4-3，2026-11-15）。
 *
 * ## 它拦什么
 *
 * dream 是模型驱动的：prune 阶段的指令是「把文件写成空内容」，模型有自由裁量权。
 * 而 `user` 类记忆是**用户画像**（偏好、身份、长期约束），误删一次就永久消失
 * ——归档区能捞回，但用户不会知道要去捞。
 *
 * prompt 里已经写了「保守优先」，但「只靠 prompt 约束一个会误判的模型」这件事
 * 本身不可靠（本仓已踩过：prompt 写了规则仍被违反，见 rejected/ 下同类论证）。
 * 所以在宿主侧加一道**硬闸**：一次 dream 归档的 user 记忆 > 1 条，
 * 整次巩固作废、文件按快照回滚。允许 1 条是因为「用户明确说过某条已过时」
 * 这类合法删除确实存在，全禁会让 dream 无法收敛。
 *
 * ## 为什么按「正文变空」判定，而不是按工具调用
 *
 * dream 通过通用 `write` 工具落盘，宿主看不到「这是 prune 还是精炼」的意图。
 * 唯一可靠的信号是结果：**正文从非空变成空**（`parseMemoryFile` 的 `emptyBody`，
 * 归档判据同源）。精炼不会把正文写空，所以不会误伤。
 */

export interface DreamEntrySnapshot {
  /** 原始完整文本（含 frontmatter），回滚时按它写回 */
  text: string;
  /** 原 frontmatter 里的 type；缺失时为空串 */
  type: string;
}

/** 一次 dream 允许归档的 user 记忆上限（超过即整次拒绝） */
export const MAX_USER_PRUNES_PER_DREAM = 1;

export interface DreamPruneVerdict {
  /** 被清空正文的文件名（含被直接删除的） */
  pruned: Array<{ filename: string; type: string }>;
  /** 其中 type === "user" 的条数 */
  userPruned: number;
  /** 是否整次拒绝（user 归档超过上限） */
  rejected: boolean;
}

/**
 * 判定这次 dream 的剪枝是否越界。
 *
 * @param snapshot dream 开始前的快照（只含当时存在的 .md）
 * @param current  dream 结束后「文件名 → 当前完整文本」；文件被删则不在表里
 */
export function evaluateDreamPrunes(
  snapshot: ReadonlyMap<string, DreamEntrySnapshot>,
  current: ReadonlyMap<string, string>,
  strip: (text: string) => string,
  maxUserPrunes: number = MAX_USER_PRUNES_PER_DREAM,
): DreamPruneVerdict {
  const pruned: Array<{ filename: string; type: string }> = [];
  for (const [filename, before] of snapshot) {
    const after = current.get(filename);
    // 文件被删掉，或正文被写成空 —— 两种都是「这条记忆没了」
    const gone = after === undefined || strip(after).trim() === "";
    if (gone) pruned.push({ filename, type: before.type });
  }
  const userPruned = pruned.filter((p) => p.type === "user").length;
  return { pruned, userPruned, rejected: userPruned > maxUserPrunes };
}
