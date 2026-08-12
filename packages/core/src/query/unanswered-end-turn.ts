/**
 * 「未答复的 end_turn」识别（方案①/②，deepseek-reasoning-leak-as-text-任务中断.md）
 *
 * 从 stream-processor 抽出的纯函数——判据独立、无副作用依赖，便于单测覆盖各形态。
 * 当前主循环全程走 sendMessageStream，故唯一调用方是 processStream；非流式路径仅用于
 * 后台标题生成等 side call，不进主循环，不受本 bug 影响，暂不接入（保持判据集中一处）。
 *
 * 三例（例① 英文单发 / 例② 中文连环 / 例③ 重试无反应）同一根因的下游表皮：
 * 模型以 end_turn 收尾，却没有产出面向用户的有效答复。两种形态：
 *
 *   形态 A「思考漂移进 content」：思考文本走了普通 content 通道 → 落成 text 块，
 *     无 tool_use、usage 原始为 0、text 极长（数万字符独白）。三例第 9/12/6 轮。
 *   形态 B「只思考不答复」：整轮只产出 thinking 块（走 reasoning_content），
 *     content 通道一字未发。例② 第 56 轮（970 字思考单块，被旧 500 上限放行）。
 *
 * 判据把轴从"思考块长度"换成"是否真答复"：end_turn/stop + 无 tool_use + 无有效正文。
 * 命中则原地转型为折叠思考块并置 _unansweredEndTurn，交 loop.ts 驱动重试。
 */

import type { AccumulatedResponse, ContentBlock } from "../llm/types.ts";
import { getLogger } from "../debug/index.ts";

/** content 通道思考漂移判定的字符下限（低于此长度视作正常短答复，不疑为思考泄漏） */
export const DRIFT_MIN_LEN = 2000;

/** 极短思考直接转正文的字符上限（这类通常是被误塞进思考通道的一句直答） */
export const SHORT_ANSWER_LEN = 500;

/**
 * 就地检测并处置「未答复的 end_turn」。直接修改传入的 response（转型内容块、置标记）。
 *
 * @param response 累积响应（会被就地修改）
 * @param rawOutputTokensZero provider 原始 output usage 是否为 0（估算兜底前的事实）——
 *        形态 A 的主判据之一。流式路径由 message_delta._rawOutputTokensZero 透传。
 */
export function detectUnansweredEndTurn(
  response: AccumulatedResponse,
  rawOutputTokensZero: boolean,
): void {
  const log = getLogger();

  const isEndTurnLike = response.stopReason === "end_turn" || response.stopReason === "stop";
  if (!isEndTurnLike) return;

  const totalTextLen = response.content
    .filter((b) => b.type === "text")
    .reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0);
  const thinkingCount = response.content.filter((b) => b.type === "thinking").length;
  const toolCallCount = response.content.filter((b) => b.type === "tool_use").length;
  if (toolCallCount > 0) return; // 有工具调用 → 正常推进，不算未答复

  // ── 形态 A：思考漂移进 content 通道（text 块），当正文渲染 ──
  // 主判据（全用结构信号）：usage 原始 output 为 0 + 存在超长 text 块 + 无 thinking 块。
  // usage.outputTokens===0 是三例最硬的共同信号（比特征词可靠）；rawOutputTokensZero
  // 是它"估算兜底前"的独立事实。特征词不参与判定，避免中/英文差异导致漏判。
  if (rawOutputTokensZero && totalTextLen >= DRIFT_MIN_LEN && thinkingCount === 0) {
    let converted = 0;
    for (let i = 0; i < response.content.length; i++) {
      const b = response.content[i];
      if (b.type === "text" && b.text.trim().length > 0) {
        response.content[i] = { type: "thinking", thinking: b.text };
        converted++;
      }
    }
    if (converted > 0) {
      response._unansweredEndTurn = true;
      log.warn(
        "STREAM",
        `检测到思考漂移进 content 通道（end_turn + 无tool_use + 原始usage=0 + text ${totalTextLen}字符），` +
          `已将 ${converted} 个 text 块转为折叠思考块，标记 _unansweredEndTurn 交由主循环驱动重试`,
      );
    }
    return;
  }

  // ── 形态 B：只思考不答复（唯一 thinking 块，content 通道空） ──
  // 判据从旧防线 A 的"长度≤500 才转正文"改为"是否真答复"：
  // end_turn + 无 text + 无 tool_use → 无论思考块多长都算未答复。
  if (totalTextLen === 0 && thinkingCount === 1) {
    const idx = response.content.findIndex((b) => b.type === "thinking");
    const block = idx >= 0 ? response.content[idx] : undefined;
    const thinkingText = block && block.type === "thinking" ? block.thinking.trim() : "";
    if (thinkingText && thinkingText.length <= SHORT_ANSWER_LEN) {
      // 极短思考：多半是被误塞进思考通道的一句直答，转正文让用户看到
      response.content[idx] = { type: "text", text: thinkingText } as ContentBlock;
      log.info(
        "STREAM",
        `仅思考无正文(stop=${response.stopReason}, ${thinkingText.length}字符≤${SHORT_ANSWER_LEN})，已将思考块原地转型为正文`,
      );
    } else if (thinkingText) {
      // 长思考：保持折叠，判为"未答复"驱动重试（不再像旧版直接放行）
      response._unansweredEndTurn = true;
      log.warn(
        "STREAM",
        `仅思考无正文(stop=${response.stopReason}, ${thinkingText.length}字符)，判定为未答复，` +
          `保持思考块折叠并标记 _unansweredEndTurn 交由主循环驱动重试`,
      );
    }
  }
}
