/**
 * 命令输出面板（通用）
 *
 * /doctor /status /trace /mcp list 这类「多行报告、与对话上下文无关」的命令，结果不再灌进
 * 消息流，而是在这里展示：Esc 关闭，↑↓ / PgUp PgDn / Home End 滚动。哪些命令进面板由命令
 * 自己声明（UnifiedCommand.outputPanel），见 command/executor.ts 的 resolvePanel。
 *
 * 一个组件服务所有命令，是这次改动的核心：之前想要弹窗只能为每个命令手写一个 Dialog
 * 并登记进 DialogType + DialogSwitch，成本高到大部分命令都选择了直接输出文本。
 *
 * 视觉：命令输出是用户会复制的内容（诊断报告贴进 issue、diff 贴进评审），按 ui/CLAUDE.md L2.2
 * **只画上下横线、不画左右竖线**——竖线和内容同处一行，拖选复制会把 `│` 一起带走。
 * 横线与输入框同一套：single 字形 + 品牌色弱化到 ~2.6 对比度（错误时换 error 色相）。
 * 视口按终端高度截断，长输出不会把面板顶出屏幕。
 */

import React, { useMemo, useState } from "react";
import { Box } from "../render-port/components.ts";
import { Text } from "../render-port/components.ts";
import { Ansi } from "../render-port/components.ts";
import { theme } from "../semantic-colors.ts";
import { mixToContrast } from "../themes/color-utils.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { useTerminalDimensions } from "../contexts/TerminalContext.tsx";
import { ARROW_PROMPT, ERROR_MARK } from "../constants/figures.ts";
import {
  PANEL_HORIZONTAL_CHROME,
  clampPanelOffset,
  panelScrollLabel,
  panelViewportRows,
  wrapPanelContent,
} from "./command-panel-layout.ts";

/** 横线相对背景的目标对比度：与输入框边框同档（InputArea.tsx BORDER_TARGET_CONTRAST） */
const PANEL_BORDER_CONTRAST = 2.6;

/** 面板要展示的命令输出（TUIState.commandPanel） */
export interface CommandPanelInfo {
  /** 面板标题（缺省 = 命令输入原文，如 `/doctor --disk`） */
  title: string;
  /** 命令输出全文（可能含 ANSI 颜色） */
  content: string;
  /** 输出是否为错误 */
  isError?: boolean;
}

interface CommandOutputDialogProps {
  panel: CommandPanelInfo;
  onClose: () => void;
}

export const CommandOutputDialog: React.FC<CommandOutputDialogProps> = ({ panel, onClose }) => {
  const { width: termWidth, height: termHeight } = useTerminalDimensions();
  const contentWidth = Math.max(termWidth - PANEL_HORIZONTAL_CHROME, 10);

  const lines = useMemo(
    () => wrapPanelContent(panel.content, contentWidth),
    [panel.content, contentWidth],
  );
  const viewportRows = panelViewportRows(termHeight, lines.length);
  const [rawOffset, setOffset] = useState(0);
  // 终端缩放后内容行数 / 视口都会变，渲染时夹一次，state 里的旧值越界也不会出错。
  const offset = clampPanelOffset(rawOffset, lines.length, viewportRows);

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    const scrollBy = (delta: number) =>
      setOffset((o) => clampPanelOffset(o + delta, lines.length, viewportRows));
    switch (key.name) {
      case "escape":
      case "q":
        // q：分页器习惯（less / git log）。面板里没有输入框，不会和打字冲突。
        onClose();
        return true;
      case "up":
      case "k":
        scrollBy(-1);
        return true;
      case "down":
      case "j":
        scrollBy(1);
        return true;
      case "pageup":
        scrollBy(-Math.max(viewportRows - 1, 1));
        return true;
      case "pagedown":
      case "space":
        scrollBy(Math.max(viewportRows - 1, 1));
        return true;
      case "home":
      case "g":
        setOffset(0);
        return true;
      case "end":
        setOffset(lines.length);
        return true;
      default:
        // 面板打开期间吞掉其余按键：否则按键会穿透到被替换掉的 Composer 之下的全局处理器。
        // Ctrl+C 例外，交还给退出流程。
        return !(key.ctrl && key.name === "c");
    }
  });

  const visible = lines.slice(offset, offset + viewportRows);
  const scrollLabel = panelScrollLabel(offset, viewportRows, lines.length);
  const accent = panel.isError ? theme.status.error : theme.ui.active;
  const titleMark = panel.isError ? ERROR_MARK : ARROW_PROMPT;
  const borderColor = mixToContrast(accent, theme.background.primary, PANEL_BORDER_CONTRAST);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor={borderColor}
      paddingX={1}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={accent}>
          {titleMark} {panel.title}
        </Text>
        {scrollLabel ? <Text color={theme.text.secondary}>{scrollLabel}</Text> : null}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {visible.length === 0 ? (
          <Text color={theme.text.secondary}>（无输出）</Text>
        ) : (
          visible.map((line, i) => (
            // 行内容可能含 ANSI 颜色（self-check 等），走 Ansi 解析而不是 Text 原样输出转义码。
            // 空行补一个空格：空 Text 在部分渲染器上高度为 0，会让视口行数与计算不一致。
            <Box key={offset + i}>
              {panel.isError ? (
                <Text color={theme.status.error}>{line || " "}</Text>
              ) : (
                <Ansi>{line || " "}</Ansi>
              )}
            </Box>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {scrollLabel ? "↑↓ 滚动 · PgUp/PgDn 翻页 · " : ""}Esc 关闭
        </Text>
      </Box>
    </Box>
  );
};
