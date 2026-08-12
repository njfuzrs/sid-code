/**
 * 连续编辑失败计数提醒（借鉴 ceaksan/edit-guard 的"连续失败计数"理念，用我们已有的
 * PostToolUse 回注通道落地，不引入 edit-guard 的重型 hook 基建 / backup-restore）。
 *
 * 解决的问题：弱模型（本项目多 provider，模型能力参差）比 Claude 更容易对同一文件
 * 反复失败编辑——old_string 老是找不到 / 不唯一 / 缩进对不上，然后原样再试、再失败，
 * 陷入低效兜圈。CC 的 Write/Edit 靠"先读后写守卫"兜底，但对"读过了仍反复编辑失败"
 * 这一弱模型高频场景没有专门提醒。
 *
 * 为什么是确定性防线（对弱模型是纯增益，不像概率性检测是双刃剑）：
 * - 计数与阈值判断完全在 harness 侧，不依赖模型听懂任何提示。
 * - 提醒只是**追加**到 tool_result 尾部，不阻断、不回滚、不改文件——最坏情况是模型忽略它，
 *   没有"误报把弱模型带沟里"的风险（这正是我们否决行数骤降/lost-in-middle 这类概率检测的理由）。
 *
 * 比 CC edit-guard 参考实现更好的三点（均零额外成本）：
 * 1. 按失败**类型**分型给可执行建议（CC 只发一条通用警告）。
 * 2. **升级式**提醒：达阈值先温和提示，持续失败再升级为"换策略/step back"。
 * 3. **重读自愈**：模型若照建议重新 read 了该文件，计数清零 → 给它干净重来的机会，
 *    而不是让旧计数一直累积导致提醒过早升级。
 */

import { getLogger } from "../debug/logger.ts";

/** 参与"连续失败计数"的编辑类工具（write/edit）。read 不计数，但成功 read 会清零对应文件的计数。 */
const EDIT_TOOLS = new Set(["edit", "write"]);

/** sessionData 中存放"文件路径 → 连续失败次数"的键。 */
const STREAK_KEY = "__editFailureStreak__";

/** 达到该连续失败次数后开始追加提醒。默认 3（对齐 edit-guard），可经环境变量覆盖。 */
function getThreshold(): number {
  const raw = process.env.SID_EDIT_FAILURE_REMINDER_THRESHOLD;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return 3;
}

/** 是否关闭该提醒（默认开启；弱模型场景下建议保持开启）。 */
function isDisabled(): boolean {
  const v = process.env.SID_DISABLE_EDIT_FAILURE_REMINDER;
  return v === "1" || v === "true";
}

/** 最小 session 存储接口（SessionState 满足；测试可传轻量 mock）。 */
export interface EditFailureStore {
  get(key: string): any;
  set(key: string, value: any): void;
}

function getStreakMap(store: EditFailureStore): Map<string, number> {
  let m = store.get(STREAK_KEY) as Map<string, number> | undefined;
  if (!(m instanceof Map)) {
    m = new Map<string, number>();
    store.set(STREAK_KEY, m);
  }
  return m;
}

/**
 * 从 edit/write 的错误文案分型，给出针对性的下一步建议。
 * 文案关键词对齐 src/tool/edit.ts / write.ts 的实际返回，保持同源。
 */
function classifyAdvice(errorText: string): string {
  const t = errorText || "";
  // 找不到匹配（4 级策略全落空）：与磁盘内容差异较大，最可能是 old_string 已过时。
  if (t.includes("未找到要替换的字符串") || t.includes("未匹配")) {
    return "多次都没找到匹配串，说明你手里的 old_string 与文件当前内容已对不上。请先用 read 重新读取该文件的最新内容，再用你**从 read 结果里原样复制**的片段作为 old_string，注意保留精确缩进与空白。";
  }
  // 歧义 / 不唯一：old_string 太短或有重复。
  if (
    t.includes("模糊匹配歧义") ||
    t.includes("多个位置") ||
    t.includes("处匹配") ||
    t.includes("replace_all")
  ) {
    return "多次都是匹配不唯一或歧义。请把 old_string 加长——多带上下几行紧邻的、能唯一定位的上下文；若你本就想改所有同名处，则显式设置 replace_all=true。";
  }
  // 被外部修改 / 未读：先读后写守卫拦下。
  if (
    t.includes("被外部修改") ||
    t.includes("已被修改") ||
    t.includes("先完整 read") ||
    t.includes("没有读取") ||
    t.includes("先 read")
  ) {
    return "文件在你读取后发生了变化，或尚未完整读取。请先重新 read 整个文件拿到最新内容，再基于最新内容编辑。";
  }
  // 截断 / 超大文件：换分段或流式工具。
  if (t.includes("截断") || t.includes("过大") || t.includes("输出长度上限")) {
    return "内容疑似过大或被输出上限截断。请改用分段策略：先 write/edit 写入一部分，再用 edit 或 bash 的 cat >>、sed 逐段补齐；超大文件优先用 bash 的 sed 等流式工具处理。";
  }
  // 兜底通用建议。
  return "请先 read 该文件确认最新内容，再重试；若文件很大或改动很多，考虑用 bash 的 sed/patch 等命令直接修改，避免反复整块替换。";
}

/**
 * 记录一次 edit/write/read 的结果，返回需要追加到 tool_result 尾部的提醒（或 undefined）。
 *
 * 语义：
 * - edit/write 成功 → 清零该文件计数，无提醒。
 * - edit/write 失败 → 该文件计数 +1；达阈值后返回分型提醒；持续超阈值则升级为"换策略"。
 * - read 成功 → 清零该文件计数（模型照建议重读了，给它干净重来的机会），无提醒。
 * - 其它工具 / 无 file_path / 已关闭 → 不处理。
 *
 * @param store       会话级状态存储（SessionState）
 * @param toolName    工具名
 * @param filePath    工具输入里的 file_path（原样，用于按文件计数）
 * @param isError     本次是否失败
 * @param errorText   失败时的错误文案（用于分型建议）
 */
export function recordEditOutcome(
  store: EditFailureStore,
  toolName: string,
  filePath: string | undefined,
  isError: boolean,
  errorText: string,
): string | undefined {
  if (isDisabled()) return undefined;
  if (!filePath || typeof filePath !== "string") return undefined;

  // 成功 read：视作模型照"重读"建议行动，清零该文件计数（自愈）。
  if (toolName === "read") {
    if (!isError) {
      const m = getStreakMap(store);
      if (m.has(filePath)) m.delete(filePath);
    }
    return undefined;
  }

  if (!EDIT_TOOLS.has(toolName)) return undefined;

  const m = getStreakMap(store);

  if (!isError) {
    // 成功编辑 → 连击清零。
    if (m.has(filePath)) m.delete(filePath);
    return undefined;
  }

  // 失败 → 累加。
  const threshold = getThreshold();
  const count = (m.get(filePath) ?? 0) + 1;
  m.set(filePath, count);

  if (count < threshold) return undefined;

  const advice = classifyAdvice(errorText);
  getLogger().warn(
    "TOOL",
    `连续编辑失败提醒：${filePath} 已连续失败 ${count} 次（阈值 ${threshold}）`,
  );

  // 升级式：达阈值后再连续失败 2 次（含），升级为"停下来换策略"（对齐系统提示的
  // failure-loop 认知——同一路子失败多次应诊断根因、换根本不同的做法，而非继续微调）。
  const escalated = count >= threshold + 2;
  if (escalated) {
    return (
      `<system-reminder>\n` +
      `你已对 ${filePath} 连续 ${count} 次编辑失败。不要再用同样的方式重试。请停下来换一条根本不同的路子：\n` +
      `1. 用 read 完整读取该文件当前内容（不要凭记忆）；\n` +
      `2. ${advice}\n` +
      `3. 若仍不行，考虑用 bash 的 sed/patch 直接改，或先说明卡在哪、再决定下一步。\n` +
      `</system-reminder>`
    );
  }

  return (
    `<system-reminder>\n` +
    `你已对 ${filePath} 连续 ${count} 次编辑失败。${advice}\n` +
    `</system-reminder>`
  );
}
