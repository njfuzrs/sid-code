/**
 * 错误消息组件
 *
 * 视觉语言：左侧一条红色竖线引导（呼应 ThinkingMessage 的竖线语言），
 * 行首 ✘ 统一字形 + "错误" 标签，正文柔和不刺眼。
 *
 * 正文默认折叠到 3 行（对标 cc MAX_LINES_TO_SHOW），ctrl+o 阶梯展开。
 * 折叠时保留顶部（overflowDirection=bottom）：错误首行通常是核心报错信息，
 * 深层堆栈才是可折叠的细节，不能把报错头截掉。
 */

import React from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { theme } from "../../semantic-colors.ts";
import { ERROR_MARK } from "../../constants/figures.ts";
import { SlicingMaxSizedBox } from "../SlicingMaxSizedBox.tsx";
import { useExpandedMaxLines } from "../../contexts/UIStateContext.tsx";

interface ErrorMessageProps {
  text: string;
  width: number;
}

/** 正文区扣除竖线引导（marginLeft 1 + paddingLeft 1）后留给文本的安全边距。 */
const BODY_WIDTH_PADDING = 2;

export const ErrorMessage: React.FC<ErrorMessageProps> = ({ text, width }) => {
  // 正文折叠：复用全局 expandLevel → maxLines 映射，与工具结果区共享 ctrl+o 阶梯展开。
  const maxLines = useExpandedMaxLines(3);
  const bodyWidth = Math.max(1, width - 1);
  // 宽度感知换行：扣除竖线引导占位，兜住单条超长堆栈行（无 \n 也能折叠）。
  const maxColumnWidth = Math.max(width - BODY_WIDTH_PADDING, 20);

  return (
    <Box width={width} flexDirection="column">
      {/* 标题行：统一 ✘ 字形 + 标签，与 ⏺ bullet 同列对齐 */}
      <Box marginBottom={1}>
        <Text color={theme.status.error} bold>{`${ERROR_MARK} `}</Text>
        <Text color={theme.status.error}>错误</Text>
      </Box>

      {/* 正文：左侧红色竖线引导，错误文本用柔和的主文本色而非刺眼纯红，超长折叠 */}
      <Box
        marginLeft={1}
        paddingLeft={1}
        borderStyle="single"
        borderLeft={true}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor={theme.status.error}
        flexDirection="column"
        width={bodyWidth}
      >
        <SlicingMaxSizedBox
          text={text}
          maxLines={maxLines}
          overflowDirection="bottom"
          maxColumnWidth={maxColumnWidth}
          color={theme.text.primary}
        />
      </Box>
    </Box>
  );
};
