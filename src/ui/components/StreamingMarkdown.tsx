/**
 * StreamingMarkdown —— 流式 markdown 渲染（对标 cc StreamingMarkdown 的稳定前缀切分）。
 *
 * 设计（见 docs 改造方案 / plan cheerful-splashing-salamander）：
 * 流式正文**不做视口裁剪**（旧 tailToFitByBlocks 已废弃 —— 那是 stock ink 时代防闪烁
 * 的 workaround，导致流式中只见尾部）。本项目渲染底座已是 vendor 进 src/ink 的 cc ink fork，
 * 纯增长帧走 log-update 的 renderFrameSlice 增量追加、旧行自然滚入终端 scrollback，
 * 不触发 fullResetSequence_CAUSES_FLICKER。
 *
 * 防闪烁的关键不再是"裁掉超出视口的内容"，而是 cc 的 **stable-prefix / unstable-suffix 切分**：
 * - stablePrefix = 截至最后一个顶层块边界之前的全部内容（已完成块），冻结在 useRef 里、
 *   边界单调只增、永不回退 → 这些块对应的终端行逐帧逐字节稳定 → 即便偶发非增长帧
 *   重新 lex，也不会改动已滚入 scrollback 的早期行（否则命中 log-update 的
 *   "scrollback 行变化 → full-reset"触发条件而闪烁）。
 * - unstableSuffix = 正在增长的最后一块，随 delta 重 lex（成本限于该块 = O(unstable)）。
 *
 * 切分逻辑抽成纯函数 computeStreamSplit 供单测（见 tests/ui/streaming-markdown.test.ts）。
 */

import React from "react";
import Box from "../../ink/components/Box.js";
import { MarkdownAnsi } from "./MarkdownAnsi.tsx";
import { cachedLexer } from "../markdown.ts";

interface StreamingMarkdownProps {
  /** 累积的全部流式文本（不做视口裁剪） */
  text: string;
  /** 渲染宽度 */
  terminalWidth: number;
  /** 可用终端高度（仅 unstable 块的代码块流式截断用，主屏当前不传） */
  availableTerminalHeight?: number;
}

export interface StreamSplit {
  /** 已完成块（冻结、永不重解析） */
  stablePrefix: string;
  /** 正在增长的最后一块（随 delta 重 lex） */
  unstableSuffix: string;
  /** stablePrefix 的结束偏移（= unstableSuffix 的起始偏移） */
  boundary: number;
}

/**
 * 把流式文本切成「冻结前缀 + 增长后缀」。
 *
 * 算法对标 cc（Markdown.tsx StreamingMarkdown）：
 * - `committed`（上一帧已冻结前缀长度，来自 ref）作为本帧起点，**只 lex `text.slice(committed)`**
 *   —— 解析成本 O(unstable) 而非 O(full)，避免逐 delta 重 lex 全文的 N² 开销。
 * - 在增量 token 流里找**最后一个非 space token**（= 正在增长的块），它之前的块都已闭合、
 *   可冻结；advance = 这些已闭合块的 raw 长度之和。新边界 = committed + advance。
 * - 关键：最后一个 content 块**始终留在 unstable**（即便其后已出现 `\n\n` 空行）——
 *   因为后续 delta 可能把它重解释（如 `line\n===` → setext 标题、列表惰性续行）。
 *   只有当**新的** content 块出现、把它挤成"非最后块"时才冻结。这是不打碎块的正确性保证。
 *
 * 单调性：advance >= 0 且 base = 上一帧 boundary ⇒ 边界只增不减 ⇒ 冻结前缀恒为新文本真前缀。
 *
 * 退化：空串 → 全空；lex 异常 → advance 0（不前进，全进 unstable，仍渲染全文）；
 * 单段无 markdown 语法 → cachedLexer 返回单个 paragraph token，lastContentIdx=0、advance=0，
 * 整段留 unstable。
 */
export function computeStreamSplit(text: string, committed: number): StreamSplit {
  if (!text) return { stablePrefix: "", unstableSuffix: "", boundary: 0 };

  const base = Math.min(Math.max(0, committed), text.length);

  let advance = 0;
  try {
    // 只 lex 未冻结部分 → O(unstable)。base 仅在块闭合时推进，故 slice 不含已冻结块。
    const tokens = cachedLexer(text.slice(base)) as {
      raw?: string;
      type?: string;
    }[];
    // 最后一个非 space token 是正在增长的块；它之前的块都已闭合可冻结。
    let lastContentIdx = tokens.length - 1;
    while (lastContentIdx >= 0 && tokens[lastContentIdx].type === "space") {
      lastContentIdx--;
    }
    for (let i = 0; i < lastContentIdx; i++) {
      advance += (tokens[i].raw ?? "").length;
    }
  } catch {
    advance = 0; // lex 失败 → 不前进，全进 unstable，仍正确
  }

  const boundary = base + advance;
  return {
    stablePrefix: text.slice(0, boundary),
    unstableSuffix: text.slice(boundary),
    boundary,
  };
}

const StreamingMarkdownInternal: React.FC<StreamingMarkdownProps> = ({
  text,
  terminalWidth,
  availableTerminalHeight,
}) => {
  // 'use no memo'：本组件在 render 期间读写 ref（边界单调推进，幂等安全），
  // 但 react-compiler 无法证明这点。项目当前无 react-compiler（no-op），
  // 保留以对齐 cc、防未来启用编译器时被错误自动 memo。运行时 React.memo 包装单独保留。
  "use no memo";

  const ref = React.useRef<{ boundary: number; prefix: string }>({
    boundary: 0,
    prefix: "",
  });

  if (!text) {
    ref.current = { boundary: 0, prefix: "" };
    return null;
  }

  // 新消息（或文本不再以冻结前缀开头，如流式被替换）→ 重置边界，一次性重新切分。
  if (!text.startsWith(ref.current.prefix)) {
    ref.current = { boundary: 0, prefix: "" };
  }

  const { stablePrefix, unstableSuffix, boundary } = computeStreamSplit(
    text,
    ref.current.boundary,
  );
  ref.current = { boundary, prefix: stablePrefix };

  // 用 gap={1} 复现跨切分点的 1 行块间距（与单块渲染一致）；
  // 前缀为空时只渲一个子节点（null 子节点不产生 Ink 节点，无幽灵间距）。
  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix ? (
        <MarkdownAnsi
          text={stablePrefix}
          isPending={false}
          availableTerminalHeight={undefined}
          terminalWidth={terminalWidth}
          renderMarkdown={true}
        />
      ) : null}
      {unstableSuffix ? (
        <MarkdownAnsi
          text={unstableSuffix}
          isPending={true}
          availableTerminalHeight={availableTerminalHeight}
          terminalWidth={terminalWidth}
          renderMarkdown={true}
        />
      ) : null}
    </Box>
  );
};

export const StreamingMarkdown = React.memo(StreamingMarkdownInternal);
