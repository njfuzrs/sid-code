/**
 * 正文末尾的「工具调用标记残片」检测与剥离（OpenAI 兼容路径）
 *
 * 背景（2026-10-20 会话 20261020-130145-4898833d，glm-5.3-uniapi）：最终文本末尾多了一个孤立的
 * `</arg_value>`，原样进了 `-p --output-format json` 的 `content`，再被 bug2mr 写进 MR 描述。
 * raw.jsonl 里上游响应本身就带着它 —— 是上游吐的 GLM XML 工具调用格式残片
 * （`<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>`），不是我们拼的。
 *
 * 处置口径（2026-10-30 拍板）：**记录 + 剥掉末尾孤立标签**。
 *   - 记录是主线：上游吐了半个工具调用协议，说明适配层可能漏解析，不能静默吞掉 ——
 *     调用方必须落 protocol-violation + SseAnomaly，否则这条防线触发过没有永远回答不了。
 *   - 剥离范围刻意收窄到「末尾、孤立、闭合标签」三个条件同时成立：
 *       末尾 —— 正文中间出现的同名字面量多半是模型在讲解这个格式，动它就是改写正文；
 *       孤立 —— 正文里有对应开标签说明是成对出现的 XML 片段，也属于正文；
 *       闭合 —— 开标签残片在末尾时后面跟的是被吞掉的参数，删一个标签修不好。
 *   - 只在「本次响应没有结构化 tool_calls」时生效（由调用方判断）：有 tool_calls 时
 *     文本只是前言，残片语义不同，先不碰，留给观测数据再定。
 */

/** 闭集：GLM XML 工具调用格式的闭合标签。新增前先有真实轨迹证据，别凭想象扩。 */
export const TOOL_MARKUP_RESIDUE_TAGS = ["</arg_value>", "</arg_key>", "</tool_call>"] as const;

export type ToolMarkupResidueTag = (typeof TOOL_MARKUP_RESIDUE_TAGS)[number];

/** `</arg_value>` → `<arg_value`（不带 `>`，兼容带属性的开标签写法） */
function openingOf(tag: ToolMarkupResidueTag): string {
  return "<" + tag.slice(2, -1);
}

/**
 * 判定文本末尾是否以孤立的残片闭合标签结束（允许其后只跟空白）。
 *
 * @returns 命中时返回去掉标签及其后空白的文本与命中的标签；未命中返回 null
 */
export function stripTrailingToolMarkupResidue(
  text: string,
): { text: string; tag: ToolMarkupResidueTag } | null {
  const trimmed = text.trimEnd();
  for (const tag of TOOL_MARKUP_RESIDUE_TAGS) {
    if (!trimmed.endsWith(tag)) continue;
    const body = trimmed.slice(0, -tag.length);
    // 有对应开标签 → 成对出现，属于正文（例如模型在解释这个格式），不动
    if (body.includes(openingOf(tag))) return null;
    return { text: body.trimEnd(), tag };
  }
  return null;
}

/**
 * 流式暂扣：把一段待发文本切成「现在可以发的」和「必须先扣住的尾巴」。
 *
 * 为什么要扣：流式文本一旦 yield 就进了 UI 和累加器，收尾时才发现末尾是残片就撤不回了。
 * 所以凡是**可能**发展成残片闭合标签的尾巴（`<`、`</arg_v`、`</arg_value>\n` …）先扣住，
 * 下一片到达后不再像残片就连同新片一起放行；流结束时仍扣着的尾巴交给
 * {@link stripTrailingToolMarkupResidue} 做最终判定。
 *
 * 代价：一个以 `<` 结尾的分片会晚一个分片才显示，量级是几个字符，用户无感。
 */
export function splitToolMarkupHoldback(text: string): { emit: string; hold: string } {
  // 只看最后一个 `<`：更早的 `<` 后面已经跟了别的内容，不可能是「末尾」残片
  const idx = text.lastIndexOf("<");
  if (idx < 0) return { emit: text, hold: "" };
  const tail = text.slice(idx);
  const core = tail.trimEnd();
  const couldBeResidue = TOOL_MARKUP_RESIDUE_TAGS.some((tag) =>
    // 已经写完、后面只跟空白；或还没写完（是标签前缀，且后面没有空白 —— 有空白就断了）
    core === tag ? true : core === tail && tag.startsWith(core),
  );
  return couldBeResidue ? { emit: text.slice(0, idx), hold: tail } : { emit: text, hold: "" };
}
