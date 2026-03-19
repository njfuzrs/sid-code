/**
 * Rasterizer — Yoga DOM 树 → ScreenBuffer 光栅化
 *
 * 替换 Ink 的 renderNodeToOutput() + Output 类，
 * 直接从 Yoga DOM 树光栅化到 ScreenBuffer。
 *
 * Static 区域仍用 Ink 的 Output 生成字符串（它写入终端滚动缓冲区）。
 */

import { tokenize, styledCharsFromTokens } from "@alcalzone/ansi-tokenize";
import stringWidth from "string-width";
import Yoga from "yoga-layout";
import cliBoxes from "cli-boxes";
import indentString from "indent-string";
import widestLine from "widest-line";

// @ts-ignore — ink 未在 exports 中暴露这些内部文件
import squashTextNodes from "../../../node_modules/ink/build/squash-text-nodes.js";
// @ts-ignore
import wrapText from "../../../node_modules/ink/build/wrap-text.js";
// @ts-ignore
import getMaxWidth from "../../../node_modules/ink/build/get-max-width.js";
// @ts-ignore
import InkOutput from "../../../node_modules/ink/build/output.js";
// @ts-ignore
import renderNodeToOutput from "../../../node_modules/ink/build/render-node-to-output.js";

import { resolveInkColor, writeStyledChars, parseCellStyle } from "./ansi-style-parser.ts";
import { COLOR_DEFAULT, MOD_DIM } from "./constants.ts";
import type { ScreenBuffer } from "./screen-buffer.ts";

/** 裁剪区域 */
interface ClipRect {
  x1?: number;
  x2?: number;
  y1?: number;
  y2?: number;
}

/**
 * 对文本应用 padding 偏移（复制自 Ink 的 render-node-to-output.js）
 */
function applyPaddingToText(node: any, text: string): string {
  const yogaNode = node.childNodes[0]?.yogaNode;
  if (yogaNode) {
    const offsetX = yogaNode.getComputedLeft();
    const offsetY = yogaNode.getComputedTop();
    text = "\n".repeat(offsetY) + indentString(text, offsetX);
  }
  return text;
}

/** 计算多个裁剪区域的交集 */
function intersectClips(clips: ClipRect[]): ClipRect | undefined {
  if (clips.length === 0) return undefined;
  const result: ClipRect = {};
  for (const c of clips) {
    if (c.x1 !== undefined) result.x1 = Math.max(result.x1 ?? -Infinity, c.x1);
    if (c.x2 !== undefined) result.x2 = Math.min(result.x2 ?? Infinity, c.x2);
    if (c.y1 !== undefined) result.y1 = Math.max(result.y1 ?? -Infinity, c.y1);
    if (c.y2 !== undefined) result.y2 = Math.min(result.y2 ?? Infinity, c.y2);
  }
  return result;
}

export class Rasterizer {
  /**
   * 将 Yoga DOM 树光栅化到 ScreenBuffer
   * @param rootNode Ink 的根节点
   * @param buffer 目标 ScreenBuffer
   * @param options.skipStaticElements 是否跳过 Static 节点
   */
  rasterize(
    rootNode: any,
    buffer: ScreenBuffer,
    options: { skipStaticElements: boolean } = { skipStaticElements: true },
  ): void {
    if (!rootNode?.yogaNode) return;
    this.renderNode(rootNode, 0, 0, buffer, [], [], options.skipStaticElements);
  }

  /**
   * Static 区域仍用 Ink 的 Output 生成字符串
   */
  rasterizeStaticToString(staticNode: any): string {
    if (!staticNode?.yogaNode) return "";

    const output = new InkOutput({
      width: staticNode.yogaNode.getComputedWidth(),
      height: staticNode.yogaNode.getComputedHeight(),
    });
    renderNodeToOutput(staticNode, output, {
      skipStaticElements: false,
    });
    return output.get().output;
  }

  /**
   * 递归渲染节点到 ScreenBuffer
   */
  private renderNode(
    node: any,
    offsetX: number,
    offsetY: number,
    buffer: ScreenBuffer,
    transformers: Array<(text: string, index: number) => string>,
    clips: ClipRect[],
    skipStaticElements: boolean,
  ): void {
    // 跳过 Static 节点
    if (skipStaticElements && node.internal_static) return;

    const { yogaNode } = node;
    if (!yogaNode) return;

    // 跳过 display:none
    if (yogaNode.getDisplay() === Yoga.DISPLAY_NONE) return;

    // 计算绝对坐标（Yoga 坐标相对于父节点）
    const x = offsetX + yogaNode.getComputedLeft();
    const y = offsetY + yogaNode.getComputedTop();

    // 收集 transformers 链
    let newTransformers = transformers;
    if (typeof node.internal_transform === "function") {
      newTransformers = [node.internal_transform, ...transformers];
    }

    // 文本节点
    if (node.nodeName === "ink-text") {
      this.renderTextNode(node, x, y, buffer, newTransformers, clips);
      return;
    }

    // Box / Root 节点
    if (node.nodeName === "ink-box" || node.nodeName === "ink-root") {
      // 渲染背景
      this.renderBackground(x, y, node, buffer, clips);

      // 渲染边框
      this.renderBorder(x, y, node, buffer, clips);

      // 处理 overflow clip
      let newClips = clips;
      const clipH =
        node.style.overflowX === "hidden" || node.style.overflow === "hidden";
      const clipV =
        node.style.overflowY === "hidden" || node.style.overflow === "hidden";

      if (clipH || clipV) {
        const clip: ClipRect = {};
        if (clipH) {
          clip.x1 = x + yogaNode.getComputedBorder(Yoga.EDGE_LEFT);
          clip.x2 =
            x +
            yogaNode.getComputedWidth() -
            yogaNode.getComputedBorder(Yoga.EDGE_RIGHT);
        }
        if (clipV) {
          clip.y1 = y + yogaNode.getComputedBorder(Yoga.EDGE_TOP);
          clip.y2 =
            y +
            yogaNode.getComputedHeight() -
            yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM);
        }
        newClips = [...clips, clip];
      }

      // 递归子节点
      for (const childNode of node.childNodes) {
        this.renderNode(
          childNode,
          x,
          y,
          buffer,
          newTransformers,
          newClips,
          skipStaticElements,
        );
      }
    }
  }

  /**
   * 渲染文本节点到 ScreenBuffer
   *
   * 复用 Ink 的 squashTextNodes + wrapText + applyPaddingToText，
   * 然后用 ansi-tokenize 解析为 StyledChar 写入 buffer。
   */
  private renderTextNode(
    node: any,
    x: number,
    y: number,
    buffer: ScreenBuffer,
    transformers: Array<(text: string, index: number) => string>,
    clips: ClipRect[],
  ): void {
    let text = squashTextNodes(node);
    if (text.length === 0) return;

    const { yogaNode } = node;
    const currentWidth = widestLine(text);
    const maxWidth = getMaxWidth(yogaNode);

    if (currentWidth > maxWidth) {
      const textWrap = node.style.textWrap ?? "wrap";
      text = wrapText(text, maxWidth, textWrap);
    }

    text = applyPaddingToText(node, text);

    // 当前活跃的裁剪区域（取所有嵌套 clip 的交集）
    const clip = intersectClips(clips);

    // 按行处理
    const lines = text.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      let line = lines[lineIdx];
      if (line.length === 0) continue;

      // 应用 transformers 链（与 Ink Output.get() 中的逻辑一致）
      for (const transformer of transformers) {
        line = transformer(line, lineIdx);
      }

      // tokenize → StyledChar[]
      const tokens = tokenize(line);
      const chars = styledCharsFromTokens(tokens);

      // 写入 buffer
      writeStyledChars(buffer, x, y + lineIdx, chars, clip);
    }
  }

  /**
   * 渲染背景色（替换 Ink 的 render-background.js）
   */
  private renderBackground(
    x: number,
    y: number,
    node: any,
    buffer: ScreenBuffer,
    clips: ClipRect[],
  ): void {
    if (!node.style.backgroundColor) return;

    const { yogaNode } = node;
    const width = yogaNode.getComputedWidth();
    const height = yogaNode.getComputedHeight();

    // 计算内容区域（排除边框，使用 Yoga computed border 保持一致）
    const leftBorder = yogaNode.getComputedBorder(Yoga.EDGE_LEFT);
    const rightBorder = yogaNode.getComputedBorder(Yoga.EDGE_RIGHT);
    const topBorder = yogaNode.getComputedBorder(Yoga.EDGE_TOP);
    const bottomBorder = yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM);

    const contentWidth = width - leftBorder - rightBorder;
    const contentHeight = height - topBorder - bottomBorder;

    if (contentWidth <= 0 || contentHeight <= 0) return;

    const bg = resolveInkColor(node.style.backgroundColor);
    if (bg === COLOR_DEFAULT) return;

    buffer.fillRect(
      x + leftBorder,
      y + topBorder,
      contentWidth,
      contentHeight,
      " ",
      COLOR_DEFAULT,
      bg,
      0,
    );
  }

  /**
   * 渲染边框（替换 Ink 的 render-border.js）
   */
  private renderBorder(
    x: number,
    y: number,
    node: any,
    buffer: ScreenBuffer,
    clips: ClipRect[],
  ): void {
    if (!node.style.borderStyle) return;

    const { yogaNode } = node;
    const width = yogaNode.getComputedWidth();
    const height = yogaNode.getComputedHeight();

    const box =
      typeof node.style.borderStyle === "string"
        ? cliBoxes[node.style.borderStyle as keyof typeof cliBoxes]
        : node.style.borderStyle;

    if (!box) return;

    const showTop = node.style.borderTop !== false;
    const showBottom = node.style.borderBottom !== false;
    const showLeft = node.style.borderLeft !== false;
    const showRight = node.style.borderRight !== false;

    // 边框颜色
    const topColor = resolveInkColor(
      node.style.borderTopColor ?? node.style.borderColor,
    );
    const bottomColor = resolveInkColor(
      node.style.borderBottomColor ?? node.style.borderColor,
    );
    const leftColor = resolveInkColor(
      node.style.borderLeftColor ?? node.style.borderColor,
    );
    const rightColor = resolveInkColor(
      node.style.borderRightColor ?? node.style.borderColor,
    );

    // dim 标志
    const dimTop =
      node.style.borderTopDimColor ?? node.style.borderDimColor ?? false;
    const dimBottom =
      node.style.borderBottomDimColor ?? node.style.borderDimColor ?? false;
    const dimLeft =
      node.style.borderLeftDimColor ?? node.style.borderDimColor ?? false;
    const dimRight =
      node.style.borderRightDimColor ?? node.style.borderDimColor ?? false;

    const contentWidth = width - (showLeft ? 1 : 0) - (showRight ? 1 : 0);

    // 上边框
    if (showTop) {
      const topMods = dimTop ? MOD_DIM : 0;
      if (showLeft) {
        buffer.setCell(x, y, box.topLeft, topColor, COLOR_DEFAULT, topMods, 1);
      }
      for (let i = 0; i < contentWidth; i++) {
        buffer.setCell(
          x + (showLeft ? 1 : 0) + i,
          y,
          box.top,
          topColor,
          COLOR_DEFAULT,
          topMods,
          1,
        );
      }
      if (showRight) {
        buffer.setCell(
          x + width - 1,
          y,
          box.topRight,
          topColor,
          COLOR_DEFAULT,
          topMods,
          1,
        );
      }
    }

    // 下边框
    if (showBottom) {
      const bottomMods = dimBottom ? MOD_DIM : 0;
      if (showLeft) {
        buffer.setCell(
          x,
          y + height - 1,
          box.bottomLeft,
          bottomColor,
          COLOR_DEFAULT,
          bottomMods,
          1,
        );
      }
      for (let i = 0; i < contentWidth; i++) {
        buffer.setCell(
          x + (showLeft ? 1 : 0) + i,
          y + height - 1,
          box.bottom,
          bottomColor,
          COLOR_DEFAULT,
          bottomMods,
          1,
        );
      }
      if (showRight) {
        buffer.setCell(
          x + width - 1,
          y + height - 1,
          box.bottomRight,
          bottomColor,
          COLOR_DEFAULT,
          bottomMods,
          1,
        );
      }
    }

    // 左边框
    if (showLeft) {
      const leftMods = dimLeft ? MOD_DIM : 0;
      const startY = y + (showTop ? 1 : 0);
      const endY = y + height - (showBottom ? 1 : 0);
      for (let row = startY; row < endY; row++) {
        buffer.setCell(x, row, box.left, leftColor, COLOR_DEFAULT, leftMods, 1);
      }
    }

    // 右边框
    if (showRight) {
      const rightMods = dimRight ? MOD_DIM : 0;
      const startY = y + (showTop ? 1 : 0);
      const endY = y + height - (showBottom ? 1 : 0);
      for (let row = startY; row < endY; row++) {
        buffer.setCell(
          x + width - 1,
          row,
          box.right,
          rightColor,
          COLOR_DEFAULT,
          rightMods,
          1,
        );
      }
    }
  }
}
