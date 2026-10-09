/**
 * 补全建议列表 UI 组件
 *
 * 在 InputArea 上方渲染补全列表，支持：
 * - ↑↓ 选择高亮
 * - 最多显示 8 条
 * - 品牌蓝 + bold 双通道高亮选中项（不靠 inverse 铺背景，兼容多行换行）
 * - 固定三列：命令名列（可见项共用一个列宽）/ 描述列 / 行尾标签列，每项严格一行
 *
 * 为什么每项一行、超长截断而不是换行（2026-10-10 改回来的，别再改成 wrap）：
 * 旧实现让命令名列 flexShrink=0、描述列 wrap，结果三种错乱同时出现——
 * ① 各行描述起点随命令名长短漂移，列不齐；② 长描述（skill 的 description 动辄几百字）
 * 一项占 10 行，8 条可见项把列表撑成一整屏；③ 长 argumentHint（/mcp、/trace）把命令名列
 * 撑到接近整行，描述列只剩 1–2 列宽，被挤成「一字一行」的竖排。
 * 完整描述在 /help 与 /skills 里看；补全列表的职责是「快速认出是哪条命令」。
 */

import React from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { theme } from "../semantic-colors.ts";
import { stringWidth } from "../render-port/text.ts";

export interface Suggestion {
  /** 显示文本 */
  label: string;
  /** 插入值 */
  value: string;
  /** 描述（命令补全用） */
  description?: string;
  /** 分类图标（单字符，如 ›），显示在 label 前 */
  icon?: string;
  /** 分类标签（如「命令」「文件」「目录」），显示在行尾 dim 色 */
  tag?: string;
  /** 斜杠命令专用：该命令无参数就无法工作，补全列表回车仅回填等待输入而非直接执行 */
  requiresArgs?: boolean;
  /** 斜杠命令专用：参数提示（如 "<repo> [pr]"），显示在 label 后 dim 色 */
  argumentHint?: string;
}

interface SuggestionsDisplayProps {
  suggestions: Suggestion[];
  activeIndex: number;
  width: number;
}

const MAX_VISIBLE = 8;
/** 命令名列最多占行宽的比例：再宽描述就没地方了（长 argumentHint 截断而不是挤占描述） */
const LABEL_COL_MAX_RATIO = 0.45;
/** 列间距 */
const GAP = 2;

/** 按显示列宽截断（CJK 安全），超出时预留 1 列给省略号 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(text) <= maxWidth) return text;
  let w = 0;
  let out = "";
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (w + cw > maxWidth - 1) break;
    w += cw;
    out += ch;
  }
  return out + "…";
}

/** 描述只取第一行并压掉多余空白：skill description 常带换行，混进来会破坏「一项一行」 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function SuggestionsDisplay({ suggestions, activeIndex, width }: SuggestionsDisplayProps) {
  if (suggestions.length === 0) return null;

  // 计算可见窗口（当建议超过 MAX_VISIBLE 时滚动）
  const total = suggestions.length;
  let startIdx = 0;
  if (total > MAX_VISIBLE) {
    // 让选中项尽量在中间
    startIdx = Math.max(
      0,
      Math.min(activeIndex - Math.floor(MAX_VISIBLE / 2), total - MAX_VISIBLE),
    );
  }
  const endIdx = Math.min(startIdx + MAX_VISIBLE, total);
  const visible = suggestions.slice(startIdx, endIdx);

  // 可用行宽：外层 paddingX=1 左右各 1 + 行首 1 列空格
  const inner = Math.max(20, width - 3);
  const headOf = (item: Suggestion) => {
    const icon = item.icon ? `${item.icon} ` : "";
    const hint = item.argumentHint ? ` ${item.argumentHint}` : "";
    return { icon, hint, full: icon + item.label + hint };
  };
  // 命令名列宽：可见项里最宽的那个，但封顶，保证描述列有地方
  const labelCol = Math.min(
    Math.max(...visible.map((it) => stringWidth(headOf(it).full))),
    Math.max(12, Math.floor(inner * LABEL_COL_MAX_RATIO)),
  );
  const tagCol = Math.max(0, ...visible.map((it) => (it.tag ? stringWidth(`[${it.tag}]`) : 0)));
  const descCol = Math.max(0, inner - labelCol - GAP - (tagCol > 0 ? tagCol + GAP : 0));

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      {visible.map((item, i) => {
        const realIndex = startIdx + i;
        const isActive = realIndex === activeIndex;
        const { icon, hint } = headOf(item);
        // 命令名优先保全，剩余列宽才给参数提示
        const label = truncateToWidth(item.label, labelCol - stringWidth(icon));
        const hintText = truncateToWidth(hint, labelCol - stringWidth(icon) - stringWidth(label));
        const headPad = " ".repeat(
          Math.max(0, labelCol - stringWidth(icon) - stringWidth(label) - stringWidth(hintText)),
        );
        const desc = item.description ? truncateToWidth(oneLine(item.description), descCol) : "";
        const descPad = " ".repeat(Math.max(0, descCol - stringWidth(desc)));
        const tagText = item.tag ? `[${item.tag}]` : "";

        // 选中态：品牌蓝 + bold；非选中：正文色，描述与标签 dim
        const labelColor = isActive ? theme.ui.active : undefined;
        return (
          <Box key={`suggestion-${realIndex}`} flexDirection="row">
            <Text wrap="truncate">
              {/* 行首空格 1 列，保持与其它消息缩进对齐 */}{" "}
              {icon ? (
                <Text color={theme.ui.active} bold={isActive}>
                  {icon}
                </Text>
              ) : null}
              <Text color={labelColor} bold={isActive}>
                {label}
              </Text>
              {/* D10：参数提示与 tag 同样 dim 处理——「回填等你输入」的另一半是「告诉你输入什么」 */}
              {hintText ? <Text color={theme.text.secondary}>{hintText}</Text> : null}
              {headPad}
              {" ".repeat(GAP)}
              <Text color={isActive ? theme.ui.active : theme.text.secondary}>{desc}</Text>
              {tagText ? (
                <>
                  {descPad}
                  {" ".repeat(GAP)}
                  <Text color={theme.text.secondary}>{tagText}</Text>
                </>
              ) : null}
            </Text>
          </Box>
        );
      })}
      {total > MAX_VISIBLE && (
        <Box>
          <Text>
            {" "}
            ({total} 条结果，显示 {startIdx + 1}-{endIdx})
          </Text>
        </Box>
      )}
    </Box>
  );
}
