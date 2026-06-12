import React, { useMemo } from 'react';
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import crypto from 'node:crypto';
import { colorizeCode, colorizeLine } from './CodeColorizer.js';
import { theme as semanticTheme } from '../semantic-colors.js';

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk' | 'other';
  oldLine?: number;
  newLine?: number;
  content: string;
}

/**
 * 解析 unified diff 格式并附加行号
 */
function parseDiffWithLineNumbers(diffContent: string): DiffLine[] {
  const lines = diffContent.split(/\r?\n/);
  const result: DiffLine[] = [];
  let currentOldLine = 0;
  let currentNewLine = 0;
  let inHunk = false;
  const hunkHeaderRegex = /^@@ -(\d+),?\d* \+(\d+),?\d* @@/;

  for (const line of lines) {
    const hunkMatch = line.match(hunkHeaderRegex);
    if (hunkMatch) {
      currentOldLine = parseInt(hunkMatch[1], 10);
      currentNewLine = parseInt(hunkMatch[2], 10);
      inHunk = true;
      result.push({ type: 'hunk', content: line });
      // 调整起始点，因为第一个行号适用于第一个实际行变化/上下文，
      // 但我们在推送该行之前递增。所以这里递减。
      currentOldLine--;
      currentNewLine--;
      continue;
    }
    if (!inHunk) {
      // 跳过标准 Git 头部行
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        continue;
      }
      // 如果不是 hunk 或头部，跳过（或根据需要处理为 'other'）
      continue;
    }
    if (line.startsWith('+')) {
      currentNewLine++; // 推送前递增
      result.push({
        type: 'add',
        newLine: currentNewLine,
        content: line.substring(1),
      });
    } else if (line.startsWith('-')) {
      currentOldLine++; // 推送前递增
      result.push({
        type: 'del',
        oldLine: currentOldLine,
        content: line.substring(1),
      });
    } else if (line.startsWith(' ')) {
      currentOldLine++; // 推送前递增
      currentNewLine++;
      result.push({
        type: 'context',
        oldLine: currentOldLine,
        newLine: currentNewLine,
        content: line.substring(1),
      });
    } else if (line.startsWith('\\')) {
      // 处理 "\ No newline at end of file"
      result.push({ type: 'other', content: line });
    }
  }
  return result;
}

interface DiffRendererProps {
  diffContent: string;
  filename?: string;
  tabWidth?: number;
  terminalWidth: number;
}

const DEFAULT_TAB_WIDTH = 4; // 每个制表符的空格数

/**
 * DiffRenderer 组件 - 彩色行级 diff 显示
 *
 * 功能：
 * - 解析 unified diff 格式
 * - 显示行号、+/- 标记
 * - 语法高亮（根据文件扩展名）
 * - 背景色区分添加/删除行
 * - 自动检测新文件（全部为添加行）
 * - 智能缩进处理（移除公共前导空格）
 * - 行间隔显示（超过 5 行上下文时显示分隔线）
 */
export const DiffRenderer: React.FC<DiffRendererProps> = ({
  diffContent,
  filename,
  tabWidth = DEFAULT_TAB_WIDTH,
  terminalWidth,
}) => {
  const parsedLines = useMemo(() => {
    if (!diffContent || typeof diffContent !== 'string') {
      return [];
    }
    return parseDiffWithLineNumbers(diffContent);
  }, [diffContent]);

  const isNewFile = useMemo(() => {
    if (parsedLines.length === 0) return false;
    return parsedLines.every(
      (line) =>
        line.type === 'add' ||
        line.type === 'hunk' ||
        line.type === 'other' ||
        line.content.startsWith('diff --git') ||
        line.content.startsWith('new file mode'),
    );
  }, [parsedLines]);

  const renderedOutput = useMemo(() => {
    if (!diffContent || typeof diffContent !== 'string') {
      return <Text color={semanticTheme.status.warning}>无 diff 内容。</Text>;
    }

    if (parsedLines.length === 0) {
      return (
        <Box
          borderStyle="round"
          borderColor={semanticTheme.border.default}
          paddingX={1}
        >
          <Text dimColor>未检测到变化。</Text>
        </Box>
      );
    }

    if (isNewFile) {
      // 提取仅添加行的内容
      const addedContent = parsedLines
        .filter((line) => line.type === 'add')
        .map((line) => line.content)
        .join('\n');
      // 从文件名推断语言，如果没有文件名则默认为纯文本
      const fileExtension = filename?.split('.').pop() || null;
      const language = fileExtension
        ? getLanguageFromExtension(fileExtension)
        : null;
      return colorizeCode({
        code: addedContent,
        language,
        maxWidth: terminalWidth,
        showLineNumbers: true,
      });
    } else {
      return renderDiffContent(
        parsedLines,
        filename,
        tabWidth,
        terminalWidth,
      );
    }
  }, [
    diffContent,
    parsedLines,
    isNewFile,
    filename,
    terminalWidth,
    tabWidth,
  ]);

  return renderedOutput;
};

const renderDiffContent = (
  parsedLines: DiffLine[],
  filename: string | undefined,
  tabWidth = DEFAULT_TAB_WIDTH,
  terminalWidth: number,
) => {
  // 1. 标准化空白（在进一步处理之前将制表符替换为空格）
  const normalizedLines = parsedLines.map((line) => ({
    ...line,
    content: line.content.replace(/\t/g, ' '.repeat(tabWidth)),
  }));

  // 过滤掉不可显示的行（hunks，可能是 'other'）
  const displayableLines = normalizedLines.filter(
    (l) => l.type !== 'hunk' && l.type !== 'other',
  );

  if (displayableLines.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor={semanticTheme.border.default}
        paddingX={1}
      >
        <Text dimColor>未检测到变化。</Text>
      </Box>
    );
  }

  const maxLineNumber = Math.max(
    0,
    ...displayableLines.map((l) => l.oldLine ?? 0),
    ...displayableLines.map((l) => l.newLine ?? 0),
  );
  const gutterWidth = Math.max(1, maxLineNumber.toString().length);

  const fileExtension = filename?.split('.').pop() || null;
  const language = fileExtension
    ? getLanguageFromExtension(fileExtension)
    : null;

  // 计算所有可显示行的最小缩进
  let baseIndentation = Infinity; // 从高开始以找到最小值
  for (const line of displayableLines) {
    // 仅考虑有实际内容的行进行缩进计算
    if (line.content.trim() === '') continue;

    const firstCharIndex = line.content.search(/\S/); // 查找第一个非空白字符的索引
    const currentIndent = firstCharIndex === -1 ? 0 : firstCharIndex; // 如果没有找到非空白则缩进为 0
    baseIndentation = Math.min(baseIndentation, currentIndent);
  }
  // 如果 baseIndentation 保持为 Infinity（例如，没有有内容的可显示行），默认为 0
  if (!isFinite(baseIndentation)) {
    baseIndentation = 0;
  }

  const key = filename
    ? `diff-box-${filename}`
    : `diff-box-${crypto.createHash('sha1').update(JSON.stringify(parsedLines)).digest('hex')}`;

  let lastLineNumber: number | null = null;
  const MAX_CONTEXT_LINES_WITHOUT_GAP = 5;

  const content = displayableLines.reduce<React.ReactNode[]>(
    (acc, line, index) => {
      // 根据类型确定用于间隔计算的相关行号
      let relevantLineNumberForGapCalc: number | null = null;
      if (line.type === 'add' || line.type === 'context') {
        relevantLineNumberForGapCalc = line.newLine ?? null;
      } else if (line.type === 'del') {
        // 对于删除，间隔通常与原始文件的行号有关
        relevantLineNumberForGapCalc = line.oldLine ?? null;
      }

      if (
        lastLineNumber !== null &&
        relevantLineNumberForGapCalc !== null &&
        relevantLineNumberForGapCalc >
          lastLineNumber + MAX_CONTEXT_LINES_WITHOUT_GAP + 1
      ) {
        acc.push(
          <Box key={`gap-${index}`}>
            <Box
              borderStyle="double"
              borderLeft={false}
              borderRight={false}
              borderBottom={false}
              width={terminalWidth}
              borderColor={semanticTheme.text.secondary}
            ></Box>
          </Box>,
        );
      }

      const lineKey = `diff-line-${index}`;
      let gutterNumStr = '';
      let prefixSymbol = ' ';

      switch (line.type) {
        case 'add':
          gutterNumStr = (line.newLine ?? '').toString();
          prefixSymbol = '+';
          lastLineNumber = line.newLine ?? null;
          break;
        case 'del':
          gutterNumStr = (line.oldLine ?? '').toString();
          prefixSymbol = '-';
          // 对于删除，如果 oldLine 在前进，则基于 oldLine 更新 lastLineNumber。
          // 这有助于在有多个连续删除或删除后跟原始文件中远处的上下文行时正确管理间隔。
          if (line.oldLine !== undefined) {
            lastLineNumber = line.oldLine;
          }
          break;
        case 'context':
          gutterNumStr = (line.newLine ?? '').toString();
          prefixSymbol = ' ';
          lastLineNumber = line.newLine ?? null;
          break;
        default:
          return acc;
      }

      const displayContent = line.content.substring(baseIndentation);

      const backgroundColor =
        line.type === 'add'
          ? semanticTheme.background.diff.added
          : line.type === 'del'
            ? semanticTheme.background.diff.removed
            : undefined;
      acc.push(
        <Box key={lineKey} flexDirection="row">
          <Box
            width={gutterWidth + 1}
            paddingRight={1}
            flexShrink={0}
            backgroundColor={backgroundColor}
            justifyContent="flex-end"
          >
            <Text color={semanticTheme.text.secondary}>{gutterNumStr}</Text>
          </Box>
          {line.type === 'context' ? (
            <>
              <Text>{prefixSymbol} </Text>
              <Text wrap="wrap">{colorizeLine(displayContent, language)}</Text>
            </>
          ) : (
            <Text
              backgroundColor={
                line.type === 'add'
                  ? semanticTheme.background.diff.added
                  : semanticTheme.background.diff.removed
              }
              wrap="wrap"
            >
              <Text
                color={
                  line.type === 'add'
                    ? semanticTheme.status.success
                    : semanticTheme.status.error
                }
              >
                {prefixSymbol}
              </Text>{' '}
              {colorizeLine(displayContent, language)}
            </Text>
          )}
        </Box>,
      );
      return acc;
    },
    [],
  );

  // SlicingMaxSizedBox 需要 text 参数，但我们这里是 ReactNode[]
  // 所以直接用 Box 包裹，如果需要高度限制可以后续优化
  return (
    <Box key={key} flexDirection="column" width={terminalWidth}>
      {content}
    </Box>
  );
};

const getLanguageFromExtension = (extension: string): string | null => {
  const languageMap: { [key: string]: string } = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    json: 'json',
    css: 'css',
    html: 'html',
    sh: 'bash',
    bash: 'bash',
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    txt: 'plaintext',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
  };
  return languageMap[extension] || null; // 如果未找到扩展名则返回 null
};
