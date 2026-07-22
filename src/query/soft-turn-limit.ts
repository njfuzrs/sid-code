/**
 * 【第四层·兜底】交互模式软轮次阈值提醒（可选，默认关闭）
 *
 * 背景（根治「git 快照冻结死循环」§5 第四层）：
 *   历史死锁的最后一道口子——交互模式 `maxTurns=Infinity`、无 costLimit，关掉循环检测后
 *   只剩用户 ESC。这与 claude-code 一致（CC 交互模式也无硬上限），故**默认保持不变**，
 *   尊重用户"不打断长任务"的偏好。
 *
 *   但对接入弱模型（deepseek 等易陷入空转）的场景，提供一个**可选**的软阈值：单条用户消息
 *   处理超过 N 轮时，注入一次性软提醒"已 N 轮，若已完成请收尾"。这是**软提示、不强杀**——
 *   只提醒模型自省，绝不 yield done 掐断（那是止损阀 terminate 的职责，且仅限被实证的
 *   git-status 死锁族）。
 *
 * 设计纪律：
 *   - 默认关闭：未设 SID_MAX_TURNS 时本模块完全不介入，行为与改造前一致。
 *   - env 门控：SID_MAX_TURNS=<正整数> 显式开启；非法值（<=0 / 非数字）视为未开启。
 *   - 一次性：整条用户消息（同一个 LoopState）内只在首次达阈值时提醒一次，不每轮刷屏。
 *   - 纯函数：阈值解析与判定做成纯函数，副作用（注入 reminderParts）留在 loop.ts。
 */

/**
 * 解析 SID_MAX_TURNS 环境变量为软阈值轮次。
 *
 * @param raw 环境变量原值（通常是 process.env.SID_MAX_TURNS）
 * @returns 正整数阈值；未设置/非法（空、非数字、<=0）返回 undefined（表示不启用）
 */
export function parseSoftTurnLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * 判断当前轮次是否应注入软阈值提醒（一次性）。
 *
 * @param turnCount 当前轮次（1-based）
 * @param softLimit 软阈值（parseSoftTurnLimit 的返回；undefined=未启用）
 * @param alreadyReminded 本条用户消息内是否已提醒过
 * @returns true=本轮应注入且需置位 alreadyReminded
 */
export function shouldRemindSoftTurnLimit(
  turnCount: number,
  softLimit: number | undefined,
  alreadyReminded: boolean,
): boolean {
  if (softLimit === undefined) return false;
  if (alreadyReminded) return false;
  return turnCount >= softLimit;
}

/**
 * 构建软阈值提醒文案（经 reminderParts 注入 user 消息，缓存友好、不落历史）。
 *
 * 措辞刻意"软"：只请模型自省是否已完成、若完成则收尾，不下达强制指令、不暗示必须停止。
 */
export function buildSoftTurnLimitReminder(turnCount: number, softLimit: number): string {
  return (
    "<system-reminder>\n" +
    `处理当前这条消息已经进行了 ${turnCount} 轮（软提醒阈值 ${softLimit} 轮）。` +
    "如果任务实际上已经完成，请停止继续调用工具，直接总结已完成的工作并结束；" +
    "如果确实还有必要的后续步骤，请明确下一步的具体动作再继续。" +
    "这只是一次性的自省提醒，不强制中断——你可以按需继续。\n" +
    "</system-reminder>"
  );
}
