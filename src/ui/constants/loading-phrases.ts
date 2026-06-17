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

/** 连接 / 等待首字阶段（Connecting 态，本轮尚未产出任何 token）的固定文案 */
export const CONNECTING_PHRASE = "连接中…";

/**
 * 续作 / 步间空档文案（Connecting 态，但本轮已产出过 token）。
 * agentic 循环里工具执行完到下一次 LLM 首 token 之间会短暂落回 Connecting，
 * 此时模型并非「在连接」，而是在「接着干」——用中性「处理中…」避免误导用户
 * 以为又在重新连接。
 */
export const CONTINUATION_PHRASE = "处理中…";

/**
 * 慢响应提示阈值（秒）与对应文案。
 *
 * ⚠️ 这里的「秒数」是【静默时长】——距上次收到模型输出（文本/思考 token）的秒数，
 * 不是整轮累计耗时。只要 token 在流，静默时长一直归零，绝不触发提示；
 * 只有真正一段时间收不到任何输出（疑似卡顿）才逐级给出。
 *
 * 措辞遵守交互铁律 C「提示渐进衰减」+ D「活而不吵」：
 * 只陈述「还在等」这一客观事实，不武断断言「网络忙 / 模型卡住」——
 * 那些是推测而非事实，会误导用户误判误操作。给出口（esc）而非下结论。
 * 阈值取得比旧版更长（12/40s），因为有了静默信号，正常流式期间根本不会进这里，
 * 一旦进了就说明确实静默了较久，值得更慎重地提示。
 */
export const SLOW_RESPONSE_HINTS: ReadonlyArray<{ thresholdSec: number; hint: string }> = [
  { thresholdSec: 12, hint: "仍在等待响应…" },
  { thresholdSec: 40, hint: "等待较久，可按 esc 取消" },
];

/**
 * 根据【静默秒数】取慢提示（取命中的最大阈值）；未达首阈值返回 null。
 *
 * @param silenceSec 距上次收到模型输出的秒数（不是整轮累计耗时）
 * @returns 命中的慢提示文案，未达首阈值时为 null
 */
export function pickSlowHint(silenceSec: number): string | null {
  let hit: string | null = null;
  for (const { thresholdSec, hint } of SLOW_RESPONSE_HINTS) {
    if (silenceSec >= thresholdSec) hit = hint;
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

