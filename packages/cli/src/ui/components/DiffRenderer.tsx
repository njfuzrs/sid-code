import React, { useMemo } from 'react';
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { RawAnsi } from "@sid-code/tui-renderer/components/RawAnsi.tsx";
import crypto from 'node:crypto';
import { diffWordsWithSpace, type StructuredPatchHunk } from 'diff';
import { colorizeCode, colorizeLine } from './CodeColorizer.js';
import { theme as semanticTheme } from '../semantic-colors.js';
import { buildDiffAnsiLines, type DiffAnsiColors } from './diffAnsiLines.js';
import { ELLIPSIS, formatCollapsedSummary } from '../constants/collapse.ts';
import type { Color } from '@sid-code/tui-renderer/styles.ts';

/**
 * DF3:超过此行数的 diff 走 RawAnsi 单 Yoga leaf 路径(预渲染 ANSI 字符串),
 * 绕过「每行一棵 React 子树」的 Yoga/squash/重序列化回环。小 diff 仍走 React 路径
 * (保留可选中文本/无障碍语义)。
 */
const RAW_ANSI_LINE_THRESHOLD = 80;

export interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk' | 'other';
  oldLine?: number;
  newLine?: number;
  content: string;
}

/**
 * 对配对的 del/add 行做词级 diff，返回强调了「变化词」的 React 片段。
 *
 * - which='del'：渲染删除行，强调「本行独有（被删掉）」的词段。
 * - which='add'：渲染新增行，强调「本行独有（新加入）」的词段。
 * 公共词段用常规前景色，变化词段加粗 + 反色底，色盲用户也能靠
 * 「加粗 + 行首 +/- 符号」区分，不只依赖颜色。
 */
function renderWordDiff(
  oldContent: string,
  newContent: string,
  which: 'del' | 'add',
): React.ReactNode {
  const parts = diffWordsWithSpace(oldContent, newContent);
  const nodes: React.ReactNode[] = [];
  let k = 0;
  for (const part of parts) {
    // del 行只渲染「公共 + 删除」段，add 行只渲染「公共 + 新增」段。
    if (which === 'del' && part.added) continue;
    if (which === 'add' && part.removed) continue;
    const changed = which === 'del' ? part.removed : part.added;
    if (changed) {
      nodes.push(
        <Text
          key={`wd-${k++}`}
          bold
          color={
            which === 'del'
              ? semanticTheme.status.error
              : semanticTheme.status.success
          }
          backgroundColor={
            which === 'del'
              ? semanticTheme.background.diff.removedEmphasis
              : semanticTheme.background.diff.addedEmphasis
          }
        >
          {part.value}
        </Text>,
      );
    } else {
      nodes.push(<Text key={`wd-${k++}`}>{part.value}</Text>);
    }
  }
  return <>{nodes}</>;
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

/**
 * 把结构化 diff hunks 转成 DiffLine[](结构化直传路径)。
 *
 * 产出与 parseDiffWithLineNumbers 完全等价的结构(含每个 hunk 的 'hunk' 行 +
 * 按前缀映射的 add/del/context/other),使 DiffRenderer 后续的折叠/词级/新文件
 * 检测/RawAnsi 逻辑零改动复用。hunk.lines 已带 ` `/`+`/`-`/`\` 前缀。
 */
export function hunksToDiffLines(hunks: StructuredPatchHunk[]): DiffLine[] {
  const result: DiffLine[] = [];
  for (const hunk of hunks) {
    // 重建 @@ 头,供折叠逻辑识别 hunk 边界(与文本路径一致)
    result.push({
      type: 'hunk',
      content: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });
    let oldLine = hunk.oldStart - 1;
    let newLine = hunk.newStart - 1;
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        newLine++;
        result.push({ type: 'add', newLine, content: line.substring(1) });
      } else if (line.startsWith('-')) {
        oldLine++;
        result.push({ type: 'del', oldLine, content: line.substring(1) });
      } else if (line.startsWith(' ')) {
        oldLine++;
        newLine++;
        result.push({ type: 'context', oldLine, newLine, content: line.substring(1) });
      } else if (line.startsWith('\\')) {
        result.push({ type: 'other', content: line });
      }
    }
  }
  return result;
}

/**
 * 词级 diff 配对：把连续的 del 块与紧随其后的 add 块按行序一一配对。
 * 返回 index → 对侧行原始内容（未做 baseIndentation 裁剪）的映射。
 * 仅一一对应的位置配对；多出的行无对侧，调用方应回退整行高亮。
 * 抽成纯函数便于单测。
 */
export function computeWordDiffPairs(
  lines: { type: DiffLine['type']; content: string }[],
): Map<number, string> {
  const pairMap = new Map<number, string>();
  for (let i = 0; i < lines.length; ) {
    if (lines[i].type !== 'del') {
      i++;
      continue;
    }
    let delEnd = i;
    while (delEnd < lines.length && lines[delEnd].type === 'del') delEnd++;
    let addEnd = delEnd;
    while (addEnd < lines.length && lines[addEnd].type === 'add') addEnd++;
    const pairCount = Math.min(delEnd - i, addEnd - delEnd);
    for (let p = 0; p < pairCount; p++) {
      pairMap.set(i + p, lines[delEnd + p].content);
      pairMap.set(delEnd + p, lines[i + p].content);
    }
    i = addEnd > i ? addEnd : i + 1;
  }
  return pairMap;
}

/** 连续未变更上下文超过此行数则折叠 */
const CONTEXT_COLLAPSE_THRESHOLD = 10;
/** 折叠时首尾各保留的上下文行数 */
const CONTEXT_KEEP_LINES = 3;

/** diff 渲染计划项:正常行 或 折叠占位 */
export interface DiffRenderPlanItem {
  kind: 'line' | 'collapsed';
  /** kind==='line' 时的原始行 */
  line?: { type: DiffLine['type']; content: string };
  /** kind==='line' 时该行在 displayableLines 中的原始下标(供 pairMap 查询) */
  origIndex?: number;
  /** kind==='collapsed' 时被折叠隐藏的行数 */
  hiddenCount?: number;
}

/**
 * 折叠档裁剪:按 maxLines **同步**保留前 N 个计划项(保留头部),统计被裁掉的实际行数。
 *
 * - line 项计 1 行,collapsed 项计其 hiddenCount 行(与展示语义一致)。
 * - maxLines===undefined 或计划本就不超限 → 原样返回,foldedLineCount=0。
 * - 头部优先:diff / 新建文件最有用的是开头,与工具结果 <Static> 打印方向一致。
 *
 * 抽成纯函数便于单测(渲染路径依赖 lowlight/主题,难在测试里跑)。
 */
export function foldRenderPlan(
  plan: DiffRenderPlanItem[],
  maxLines?: number,
): { plan: DiffRenderPlanItem[]; foldedLineCount: number } {
  if (maxLines === undefined || plan.length <= maxLines) {
    return { plan, foldedLineCount: 0 };
  }
  let foldedLineCount = 0;
  for (let i = maxLines; i < plan.length; i++) {
    const it = plan[i];
    foldedLineCount += it.kind === 'collapsed' ? (it.hiddenCount ?? 0) : 1;
  }
  return { plan: plan.slice(0, maxLines), foldedLineCount };
}

/**
 * DF2 大 diff 上下文折叠:把连续的未变更上下文(context)块中超长的部分折叠。
 * 连续 context run 长度 > threshold 时,保留首尾各 keep 行,中间替换为一个
 * collapsed 占位(隐藏 run-2*keep 行)。add/del/其它行原样保留。
 * 抽成纯函数便于单测。
 */
export function planDiffWithContextCollapse(
  lines: { type: DiffLine['type']; content: string }[],
  threshold = CONTEXT_COLLAPSE_THRESHOLD,
  keep = CONTEXT_KEEP_LINES,
): DiffRenderPlanItem[] {
  const plan: DiffRenderPlanItem[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'context') {
      plan.push({ kind: 'line', line: lines[i], origIndex: i });
      i++;
      continue;
    }
    // 收集连续的 context run
    let runEnd = i;
    while (runEnd < lines.length && lines[runEnd].type === 'context') runEnd++;
    const runLen = runEnd - i;
    if (runLen > threshold && runLen - keep * 2 >= 1) {
      for (let p = 0; p < keep; p++) {
        plan.push({ kind: 'line', line: lines[i + p], origIndex: i + p });
      }
      plan.push({ kind: 'collapsed', hiddenCount: runLen - keep * 2 });
      for (let p = runLen - keep; p < runLen; p++) {
        plan.push({ kind: 'line', line: lines[i + p], origIndex: i + p });
      }
    } else {
      for (let p = 0; p < runLen; p++) {
        plan.push({ kind: 'line', line: lines[i + p], origIndex: i + p });
      }
    }
    i = runEnd;
  }
  return plan;
}

interface DiffRendererProps {
  /** unified diff 文本(降级路径)。与 structuredPatch 二选一,后者优先。 */
  diffContent?: string;
  /** 结构化 diff hunks(优先路径,绕过文本正则解析) */
  structuredPatch?: StructuredPatchHunk[];
  filename?: string;
  tabWidth?: number;
  terminalWidth: number;
  /**
   * 折叠档：最多展示的可显示行数（新建文件的代码行 / diff 的增删+上下文行）。
   *
   * 超出则**同步**裁剪、只保留前 maxLines 行，末尾追加统一的
   * `… N 行已折叠 · ctrl+o 展开` footer。传 undefined = 全展开档（不折叠）。
   *
   * 为何在此同步裁剪而非上层包 MaxSizedBox：工具结果一完成即被 <Static> 一次性打印进
   * 终端 scrollback，此后无法重渲。异步测高的 MaxSizedBox 首帧会先把整份内容落进 scrollback
   * 再折叠 → 大文件污染回滚区且擦不掉。同步裁剪一次成型，Static 安全。
   */
  maxLines?: number;
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
  structuredPatch,
  filename,
  tabWidth = DEFAULT_TAB_WIDTH,
  terminalWidth,
  maxLines,
}) => {
  const hasPatch = !!structuredPatch?.length;
  const parsedLines = useMemo(() => {
    // 结构化优先:直接由 hunks 产 DiffLine[],绕过文本正则解析
    if (hasPatch) {
      return hunksToDiffLines(structuredPatch!);
    }
    if (!diffContent || typeof diffContent !== 'string') {
      return [];
    }
    return parseDiffWithLineNumbers(diffContent);
  }, [hasPatch, structuredPatch, diffContent]);

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
    // 结构化路径下 diffContent 可为空,只要 parsedLines 非空即可渲染
    if (!hasPatch && (!diffContent || typeof diffContent !== 'string')) {
      return <Text color={semanticTheme.status.warning}>无 diff 内容。</Text>;
    }

    if (parsedLines.length === 0) {
      return (
        <Box
          borderStyle="round"
          borderColor={semanticTheme.border.default}
          paddingX={1}
        >
          <Text>未检测到变化。</Text>
        </Box>
      );
    }

    if (isNewFile) {
      // 提取仅添加行的内容
      const addedLines = parsedLines
        .filter((line) => line.type === 'add')
        .map((line) => line.content);
      // 从文件名推断语言，如果没有文件名则默认为纯文本
      const fileExtension = filename?.split('.').pop() || null;
      const language = fileExtension
        ? getLanguageFromExtension(fileExtension)
        : null;

      // 折叠：新建文件全是 add 行、零上下文，planDiffWithContextCollapse 折不掉，
      // 必须在此按 maxLines **同步**保留头部（看文件开头最有用）、末尾追加统一折叠 footer。
      // 不用 colorizeCode 的 availableHeight——那是保留尾部（top overflow），方向相反。
      const hiddenCount =
        maxLines !== undefined && addedLines.length > maxLines
          ? addedLines.length - maxLines
          : 0;
      const shownContent = (
        hiddenCount > 0 ? addedLines.slice(0, maxLines) : addedLines
      ).join('\n');

      const colorized = colorizeCode({
        code: shownContent,
        language,
        maxWidth: terminalWidth,
        showLineNumbers: true,
      });

      if (hiddenCount > 0) {
        return (
          <Box flexDirection="column" width={terminalWidth}>
            {colorized}
            <Text color={semanticTheme.text.secondary}>
              {formatCollapsedSummary(hiddenCount, { hint: 'ctrl+o' })}
            </Text>
          </Box>
        );
      }
      return colorized;
    } else {
      return renderDiffContent(
        parsedLines,
        filename,
        tabWidth,
        terminalWidth,
        maxLines,
      );
    }
  }, [
    hasPatch,
    diffContent,
    parsedLines,
    isNewFile,
    filename,
    terminalWidth,
    tabWidth,
    maxLines,
  ]);

  return renderedOutput;
};

const renderDiffContent = (
  parsedLines: DiffLine[],
  filename: string | undefined,
  tabWidth = DEFAULT_TAB_WIDTH,
  terminalWidth: number,
  maxLines?: number,
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
        <Text>未检测到变化。</Text>
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

  // 词级 diff 配对：用裁剪后的内容计算，pairMap 的对侧内容已是裁剪后的，
  // 可直接传给 renderWordDiff。
  const pairMap = computeWordDiffPairs(
    displayableLines.map((l) => ({
      type: l.type,
      content: l.content.substring(baseIndentation),
    })),
  );

  // DF2:对超长未变更上下文做折叠。plan 保留每行的原始下标(origIndex)以查 pairMap。
  const fullPlan = planDiffWithContextCollapse(
    displayableLines.map((l) => ({ type: l.type, content: l.content })),
  );

  // 折叠档裁剪：按 maxLines **同步**保留前 N 个计划项（保留头部），统计被裁掉的实际行数
  // 供末尾折叠 footer。全展开档（maxLines===undefined）不裁剪。Static 安全：一次成型、
  // 不依赖异步测高。逻辑抽到 foldRenderPlan 纯函数便于单测。
  const { plan: renderPlan, foldedLineCount } = foldRenderPlan(fullPlan, maxLines);
  const foldFooter =
    foldedLineCount > 0 ? (
      <Text color={semanticTheme.text.secondary}>
        {formatCollapsedSummary(foldedLineCount, { hint: 'ctrl+o' })}
      </Text>
    ) : null;

  // DF3:大 diff 走 RawAnsi 单 leaf 路径。折叠后的计划行数超阈值时,预渲染 ANSI 字符串,
  // 绕过 per-line React 子树的 Yoga/squash/重序列化回环。小 diff 仍走下方 React 路径。
  // 注:折叠档裁剪后 renderPlan 通常远小于阈值 → 走 React 路径;仅全展开的大 diff 命中这里。
  if (renderPlan.length > RAW_ANSI_LINE_THRESHOLD) {
    const bg = semanticTheme.background.diff;
    const colors: DiffAnsiColors = {
      secondary: semanticTheme.text.secondary as Color,
      addFg: semanticTheme.status.success as Color,
      delFg: semanticTheme.status.error as Color,
      addBg: bg.added as Color,
      delBg: bg.removed as Color,
      addEmphasisBg: bg.addedEmphasis as Color,
      delEmphasisBg: bg.removedEmphasis as Color,
    };
    const ansiLines = buildDiffAnsiLines({
      plan: renderPlan,
      displayableLines,
      pairMap,
      baseIndentation,
      gutterWidth,
      terminalWidth,
      colors,
    });
    return (
      <Box key={key} flexDirection="column" width={terminalWidth}>
        <RawAnsi lines={ansiLines} width={terminalWidth} />
        {foldFooter}
      </Box>
    );
  }

  const content = renderPlan.reduce<React.ReactNode[]>(
    (acc, item, planIdx) => {
      // 折叠占位行:展示被隐藏的上下文行数
      if (item.kind === 'collapsed') {
        acc.push(
          <Box key={`collapse-${planIdx}`} paddingLeft={gutterWidth + 2}>
            <Text color={semanticTheme.text.secondary}>
              {`${ELLIPSIS} ${item.hiddenCount} 行未变更上下文已折叠`}
            </Text>
          </Box>,
        );
        // 折叠会中断行号连续性,复位 lastLineNumber 避免误插 gap 分隔线
        lastLineNumber = null;
        return acc;
      }

      const index = item.origIndex!;
      // 根据类型确定用于间隔计算的相关行号
      let relevantLineNumberForGapCalc: number | null = null;
      const srcLine = displayableLines[index];
      if (srcLine.type === 'add' || srcLine.type === 'context') {
        relevantLineNumberForGapCalc = srcLine.newLine ?? null;
      } else if (srcLine.type === 'del') {
        // 对于删除，间隔通常与原始文件的行号有关
        relevantLineNumberForGapCalc = srcLine.oldLine ?? null;
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
              borderStyle="single"
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

      switch (srcLine.type) {
        case 'add':
          gutterNumStr = (srcLine.newLine ?? '').toString();
          prefixSymbol = '+';
          lastLineNumber = srcLine.newLine ?? null;
          break;
        case 'del':
          gutterNumStr = (srcLine.oldLine ?? '').toString();
          prefixSymbol = '-';
          // 对于删除，如果 oldLine 在前进，则基于 oldLine 更新 lastLineNumber。
          // 这有助于在有多个连续删除或删除后跟原始文件中远处的上下文行时正确管理间隔。
          if (srcLine.oldLine !== undefined) {
            lastLineNumber = srcLine.oldLine;
          }
          break;
        case 'context':
          gutterNumStr = (srcLine.newLine ?? '').toString();
          prefixSymbol = ' ';
          lastLineNumber = srcLine.newLine ?? null;
          break;
        default:
          return acc;
      }

      const displayContent = srcLine.content.substring(baseIndentation);

      const backgroundColor =
        srcLine.type === 'add'
          ? semanticTheme.background.diff.added
          : srcLine.type === 'del'
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
          {srcLine.type === 'context' ? (
            <>
              <Text>{prefixSymbol} </Text>
              <Text wrap="wrap">{colorizeLine(displayContent, language)}</Text>
            </>
          ) : (
            <Text
              backgroundColor={
                srcLine.type === 'add'
                  ? semanticTheme.background.diff.added
                  : semanticTheme.background.diff.removed
              }
              wrap="wrap"
            >
              <Text
                bold
                color={
                  srcLine.type === 'add'
                    ? semanticTheme.status.success
                    : semanticTheme.status.error
                }
              >
                {prefixSymbol}
              </Text>{' '}
              {pairMap.has(index)
                ? renderWordDiff(
                    srcLine.type === 'del' ? displayContent : pairMap.get(index)!,
                    srcLine.type === 'del' ? pairMap.get(index)! : displayContent,
                    srcLine.type as 'del' | 'add',
                  )
                : colorizeLine(displayContent, language)}
            </Text>
          )}
        </Box>,
      );
      return acc;
    },
    [],
  );

  // 超长未变更上下文已由 planDiffWithContextCollapse 折叠;折叠档再按 maxLines 同步裁剪头部,
  // 末尾追加统一折叠 footer(foldFooter)。全展开档 foldFooter 为 null,与旧行为一致。
  return (
    <Box key={key} flexDirection="column" width={terminalWidth}>
      {content}
      {foldFooter}
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
