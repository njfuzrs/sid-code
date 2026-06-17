/**
 * 加载/等待阶段的文案常量（集中管理，避免散落硬编码）
 *
 * 与 spinnerVerbs.ts 的区别：
 * - spinnerVerbs：Responding 流式生成阶段循环抽取的「思考动词」池。
 * - 本文件：Connecting 首字延迟阶段的固定文案 + 慢响应渐进提示阈值。
 *
 * 设计原则（遵守 src/ui/CLAUDE.md 交互铁律 C「提示渐进衰减」）：
 * 慢提示是渐进升级的——温和告知 → 给出路 → 建议排查，不一上来就报警，
 * 避免每次正常的十几秒等待都吓用户。
 */

/** 连接 / 等待首字阶段（Connecting 态）的固定文案 */
export const CONNECTING_PHRASE = "连接中…";

/**
 * 慢响应提示阈值（秒）与对应文案。按 elapsedTime 命中最大阈值。
 * 阈值递增，文案从「温和告知」升级到「给出路」再到「建议排查」。
 */
export const SLOW_RESPONSE_HINTS: ReadonlyArray<{ thresholdSec: number; hint: string }> = [
  { thresholdSec: 10, hint: "响应较慢，仍在等待…" },
  { thresholdSec: 30, hint: "网络或模型较忙，可按 esc 取消重试" },
  { thresholdSec: 60, hint: "已等待较久，建议 esc 取消后检查网络 / 模型配置" },
];

/**
 * 根据已等待秒数取慢提示（取命中的最大阈值）；未达首个阈值返回 null。
 *
 * @param elapsedSec 已等待秒数
 * @returns 命中的慢提示文案，未达首阈值时为 null
 */
export function pickSlowHint(elapsedSec: number): string | null {
  let hit: string | null = null;
  for (const { thresholdSec, hint } of SLOW_RESPONSE_HINTS) {
    if (elapsedSec >= thresholdSec) hit = hint;
  }
  return hit;
}

/**
 * L3 方向 1：工具级计时显示阈值（秒）。
 * 工具执行超过该阈值才在工具行追加「已执行 Xs」——短工具（瞬间完成）不打扰，
 * 只有长任务（git clone / 测试套件 / sub-agent）才显示自身耗时，
 * 与整轮计时区分开（整轮计时可能因前面的文本流式已经很大）。
 */
export const TOOL_TIMER_THRESHOLD_SEC = 5;

/** 工具级耗时文案前缀（在工具行追加显示，如「已执行 8s」）。 */
export function formatToolElapsed(elapsedSec: number): string {
  if (elapsedSec < 60) return `已执行 ${elapsedSec}s`;
  const m = Math.floor(elapsedSec / 60);
  const s = elapsedSec % 60;
  return `已执行 ${m}m${s}s`;
}

