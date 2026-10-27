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
 *
 * ## 形态必须分开报（2026-10-27）
 *
 * 命中时同时置 `_unansweredShape`，loop.ts 据此选文案 / 回注提示 / trace 字段。
 * 此前所有形态共用一句「疑似思考泄漏到正文」+ 一条「先 todo_write 拆步骤」的提示，
 * 两次实测（20261026-153949-44168811 #70、20261026-155110-ef2ddda8 #44，deepseek-v4-1-flash）
 * 都是**工具调用被吞进思考**：模型写完长文档前半段，下一轮要用 edit 追加约 6k tokens，
 * 整段 edit 参数落进了 reasoning 通道，思考末尾留着残缺的原生调用闭合标签
 * `</｜｜DSML｜｜ parameter>`，服务端没解析出 tool_calls。正文一字未发——和"泄漏到正文"
 * 正好相反；而 todo_write 提示让模型多花了一整轮去更新清单（#72 / #46）。
 *
 * `unparsed_tool_call` 只做识别、不做抢救：两次实测里起始的 `invoke name=` 都已不在，
 * 工具名与参数边界无从还原；即使完整，从思考文本里解析出来直接执行也等于让一个
 * 非提交通道产生副作用（理由见 .agents/notes 对应 Note 的「放弃了什么」）。
 */

import type { AccumulatedResponse, ContentBlock, UnansweredShape } from "../llm/types.ts";
import { getLogger } from "../debug/index.ts";
import { isEndTurnLikeStopReason } from "../agent/message-invariants.ts";

/** content 通道思考漂移判定的字符下限（低于此长度视作正常短答复，不疑为思考泄漏） */
export const DRIFT_MIN_LEN = 2000;

/** 极短思考直接转正文的字符上限（这类通常是被误塞进思考通道的一句直答） */
export const SHORT_ANSWER_LEN = 500;

/**
 * 模型原生工具调用标记（未被服务端解析的残片）。
 *
 * DeepSeek V4 的工具调用协议是 DSML：`<｜DSML｜tool_calls><｜DSML｜invoke name="…">
 * <｜DSML｜parameter name="…" string="true">…</｜DSML｜parameter>…`，由服务端解析成 tool_calls
 * （见 huggingface.co/deepseek-ai/DeepSeek-V4-Pro encoding/README.md）。
 * 解析失败时残片会原样留在 reasoning / content 里，且常常**已经写坏**：
 *   - 实测 `</｜｜DSML｜｜ parameter>`（竖线重复 + 多一个空格）；
 *   - 社区报告 `<||DSML||tool_calls>`（ASCII 竖线）、`<｜DSML｜toolcalls>`（少下划线）、
 *     `<｜DSML｜tool>`（截短）——vllm#51914、DeepSeek-V4-Pro discussions/209。
 * 所以竖线允许全角/半角、重复，标签名与 DSML 之间允许空白；后面必须紧跟协议标签名
 * 才算命中，单独出现「DSML」这个词不算。
 */
const RAW_TOOL_CALL_MARKUP = /[｜|]+\s*DSML\s*[｜|]+\s*(?:tool(?:_?calls?)?|invoke|parameter)\b/i;

/** 围栏代码块与行内代码：讲解协议格式时示例都在这里，不是泄漏 */
const CODE_SPANS = /```[\s\S]*?```|`[^`\n]*`/g;

/**
 * 文本里是否带着未被解析的原生工具调用标记。
 * 先剔除代码块 / 行内代码再匹配——用户问「DSML 长什么样」时，答复里贴的示例
 * 都在代码格式里，不能把这类正常答复判成"工具调用没执行"。
 */
export function hasUnparsedToolCallMarkup(text: string): boolean {
  if (!text || !/DSML/i.test(text)) return false;
  return RAW_TOOL_CALL_MARKUP.test(text.replace(CODE_SPANS, ""));
}

/** 在剔除代码格式后的文本里定位首个标记；返回原文中的下标（-1 = 无）。 */
function firstUnparsedToolCallIndex(text: string): number {
  // 用等长空格替换代码片段，保持下标与原文对齐
  const masked = text.replace(CODE_SPANS, (m) => " ".repeat(m.length));
  const m = RAW_TOOL_CALL_MARKUP.exec(masked);
  if (!m) return -1;
  // 回退到标记前的 `<` / `</`，让切分点落在标签开头
  let i = m.index;
  while (i > 0 && (masked[i - 1] === "<" || masked[i - 1] === "/")) i--;
  return i;
}

function markUnanswered(response: AccumulatedResponse, shape: UnansweredShape): void {
  response._unansweredEndTurn = true;
  response._unansweredShape = shape;
}

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

  // P2-1：判据与 loop.ts 的收尾闸门**共用同一个函数**，不再各抄一份。
  // 此前这里是就地的 `=== "end_turn" || === "stop"`，漏了 `stop_sequence`——
  // 而 loop.ts 的白名单含它（isEndTurnLikeStopReason）。后果是 `stop_sequence` +
  // 空答复会走完整收尾链，`_unansweredEndTurn` 却永不置位：闸门在、检测不到。
  if (!isEndTurnLikeStopReason(response.stopReason)) return;

  const totalTextLen = response.content
    .filter((b) => b.type === "text")
    .reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0);
  const thinkingCount = response.content.filter((b) => b.type === "thinking").length;
  const toolCallCount = response.content.filter((b) => b.type === "tool_use").length;
  if (toolCallCount > 0) return; // 有工具调用 → 正常推进，不算未答复

  // ── 形态 C：原生工具调用标记没被解析（先于 A/B 判，它是两者的特例） ──
  // 模型把调用写进了 reasoning / content 通道，服务端没解析成 tool_calls：模型以为工具
  // 已经执行，实际一次都没跑。按 A/B 报会给出完全相反的归因与对策（见文件头）。
  //   - text 里有残片：无论长短都算——这一轮唯一的"动作"没发生，正文长度不改变这一点。
  //     残片之前的散文保留为正文（往往是「我先读一下文件」这类前言），残片及之后转折叠思考，
  //     不把裸协议标记渲染进 TUI 正文。
  //   - thinking 里有残片：只在**没有实质正文**（≤ SHORT_ANSWER_LEN）时算。已经写出完整答复的
  //     轮次，思考里出现标记更可能是在推演协议本身，不能把一个真答复判成未答复。
  const textHasMarkup = response.content.some(
    (b) => b.type === "text" && hasUnparsedToolCallMarkup(b.text),
  );
  const thinkingHasMarkup =
    totalTextLen <= SHORT_ANSWER_LEN &&
    response.content.some((b) => b.type === "thinking" && hasUnparsedToolCallMarkup(b.thinking));
  if (textHasMarkup || thinkingHasMarkup) {
    for (let i = response.content.length - 1; i >= 0; i--) {
      const b = response.content[i];
      if (b?.type !== "text") continue;
      const at = firstUnparsedToolCallIndex(b.text);
      if (at < 0) continue;
      const before = b.text.slice(0, at).trimEnd();
      const replaced: ContentBlock[] = [];
      if (before) replaced.push({ type: "text", text: before });
      replaced.push({ type: "thinking", thinking: b.text.slice(at) });
      response.content.splice(i, 1, ...replaced);
    }
    markUnanswered(response, "unparsed_tool_call");
    log.warn(
      "STREAM",
      `检测到未被解析的原生工具调用标记(stop=${response.stopReason}, 位于${textHasMarkup ? "正文" : "思考"}, ` +
        `text ${totalTextLen}字符、${thinkingCount} 个 thinking、0 个 tool_use)：工具调用落进了非调用通道、未执行，` +
        `标记 _unansweredEndTurn 交由主循环驱动重新发起`,
    );
    return;
  }

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
      markUnanswered(response, "text_drift");
      log.warn(
        "STREAM",
        `检测到思考漂移进 content 通道（end_turn + 无tool_use + 原始usage=0 + text ${totalTextLen}字符），` +
          `已将 ${converted} 个 text 块转为折叠思考块，标记 _unansweredEndTurn 交由主循环驱动重试`,
      );
    }
    return;
  }

  // ── 形态 B：只思考不答复（content 通道一字未发） ──
  // 判据从旧防线 A 的"长度≤500 才转正文"改为"是否真答复"：
  // end_turn + 无 text + 无 tool_use → 无论思考块多长都算未答复。
  //
  // P2-1：条件从 `thinkingCount === 1` 放宽到「无 text、无 tool_use」，thinking 段数不限。
  // 旧硬条件漏掉两类同样"空手 end_turn"的形态，而它们与单块形态对用户完全等价：
  //   - thinkingCount >= 2（模型分多段思考后直接收尾）→ 旧条件不等于 1，整条不进；
  //   - thinkingCount === 0 且无 text 无 tool（空 content / 只有 redacted_thinking）
  //     → 形态 A 要求 totalTextLen >= DRIFT_MIN_LEN 也进不去，两形态同时漏。
  // 「极短 thinking ≤500 转正文」是刻意保留的设计（见 SHORT_ANSWER_LEN），但只在
  // **唯一一个** thinking 块时才谈得上"把这一句直答转出来"——多块时转哪一块都是猜，
  // 故多块一律判未答复走重试。
  if (totalTextLen === 0) {
    const idx = response.content.findIndex((b) => b.type === "thinking");
    const block = idx >= 0 ? response.content[idx] : undefined;
    const thinkingText = block && block.type === "thinking" ? block.thinking.trim() : "";
    if (thinkingCount === 0) {
      // 空 content / 只有 redacted_thinking：模型什么都没交付，且没有任何可转正文的东西。
      markUnanswered(response, "empty");
      log.warn(
        "STREAM",
        `无任何有效产出(stop=${response.stopReason}, ${response.content.length} 个内容块、` +
          `0 个 thinking、0 个 text、0 个 tool_use)，判定为未答复，标记 _unansweredEndTurn 交由主循环驱动重试`,
      );
      return;
    }
    if (thinkingCount > 1) {
      // 多段思考后空手收尾：整轮没有面向用户的字。转正文无从下手（转哪一段都是猜），直接判未答复。
      markUnanswered(response, "thinking_only");
      log.warn(
        "STREAM",
        `仅思考无正文(stop=${response.stopReason}, ${thinkingCount} 个 thinking 块)，判定为未答复，` +
          `保持思考块折叠并标记 _unansweredEndTurn 交由主循环驱动重试`,
      );
      return;
    }
    if (thinkingText && thinkingText.length <= SHORT_ANSWER_LEN) {
      // 极短思考：多半是被误塞进思考通道的一句直答，转正文让用户看到
      // （带调用标记的短思考已在形态 C 拦下，不会把裸协议标记转成正文）
      response.content[idx] = { type: "text", text: thinkingText } as ContentBlock;
      log.info(
        "STREAM",
        `仅思考无正文(stop=${response.stopReason}, ${thinkingText.length}字符≤${SHORT_ANSWER_LEN})，已将思考块原地转型为正文`,
      );
    } else if (thinkingText) {
      // 长思考：保持折叠，判为"未答复"驱动重试（不再像旧版直接放行）
      markUnanswered(response, "thinking_only");
      log.warn(
        "STREAM",
        `仅思考无正文(stop=${response.stopReason}, ${thinkingText.length}字符)，判定为未答复，` +
          `保持思考块折叠并标记 _unansweredEndTurn 交由主循环驱动重试`,
      );
    }
  }
}

/**
 * 各形态面向用户的警告文案（TUI system warning）。按形态分开的理由见文件头：
 * 不同形态的成因与对策相反，混用一句会误导排查。
 * shape 缺省（老调用方 / 测试只置了 `_unansweredEndTurn`）用中性措辞，不猜形态。
 */
export function describeUnansweredRetry(shape: UnansweredShape | undefined): string {
  switch (shape) {
    case "unparsed_tool_call":
      return "上一轮的工具调用被模型写进了思考/正文、未被解析执行，自动引导重新发起";
    case "text_drift":
      return "上一轮思考漂移进正文、未产出有效答复，自动引导重新推进";
    case "thinking_only":
      return "上一轮只有思考、既未答复也未调用工具，自动引导重新推进";
    case "empty":
      return "上一轮模型返回为空，自动引导重新推进";
    default:
      return "上一轮未产出有效答复，自动引导重新推进";
  }
}

/** 续命耗尽后的收尾文案。建议必须对得上形态：工具调用没被解析时「换个提问方式」无济于事。 */
export function describeUnansweredExhausted(
  shape: UnansweredShape | undefined,
  maxRetries: number,
): string {
  if (shape === "unparsed_tool_call") {
    return (
      `模型连续 ${maxRetries} 次把工具调用写进了思考/正文而未正式发起，相关操作没有执行。` +
      `建议让它把大段写入拆成多次小改动，或切换模型重试。`
    );
  }
  return `模型连续 ${maxRetries} 次未产出有效答复（可能陷入思考发散）。建议换个更具体的提问方式，或切换模型重试。`;
}
