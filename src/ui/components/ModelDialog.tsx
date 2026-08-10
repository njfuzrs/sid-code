/**
 * 模型选择对话框
 * 允许用户切换 LLM 模型
 *
 * 视觉对标 cc /model 面板：
 * - 当前模型用 ● + 品牌色标记（区别于光标指示的 ›）
 * - provider / 端点 标签对齐成列（dim 色）
 * - 按「模型族」分组（Claude / GPT / DeepSeek …），组标题独占一行
 *
 * 搜索框常驻（对标 resume 选择器 / /skills）：一进面板就能直接打字过滤
 * 模型名 / provider / 族名 / 端点，不必先按 / 唤起。因字母键都进搜索框，
 * 动作键全部落在非字母键上：
 *   输入    即时过滤
 *   ↑↓      移动选择（自动跳过分组标题）
 *   Enter   切换模型
 *   ←/→     调 effort（模型支持时）
 *   Esc     有查询先清空 → 关闭（渐进退出，不丢状态）
 *
 * 注：不复用 BaseSelectionList——它的导航不认"不可选的分组标题行"，
 * 且数字快捷键会吞掉搜索输入。这里自带一份跳过标题行的窗口滚动逻辑。
 */

import React, { useState, useMemo, useEffect } from 'react';
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import stringWidth from "string-width";
import { theme } from '../semantic-colors.ts';
import { TODO_COMPLETED, ARROW_PROMPT, EFFORT_GLYPHS, SEARCH_MARK, WARNING_MARK } from '../constants/figures.ts';
import { useKeypress, KeypressPriority, type Key } from '../contexts/KeypressContext.tsx';
import {
  cycleEffortForModel,
  getSelectableEfforts,
  isEffortGatedByThinking,
  type EffortLevel,
  type EffortSetting,
  type ThinkingSetting,
} from '../../llm/effort.ts';
import {
  buildModelRows,
  countModelRows,
  indexOfModel,
  nextSelectableIndex,
  firstSelectableIndex,
  type ModelOption,
  type ModelRow,
} from './model-grouping.ts';

interface EffortState {
  runtime: EffortSetting;
  applied: EffortLevel | undefined;
  isAuto: boolean;
  capability: import("../../llm/effort.ts").EffortCapability;
}

interface ModelDialogProps {
  onClose: () => void;
  currentModel: string;
  availableModels: ModelOption[];
  onModelSelect: (modelName: string) => void;
  /** 读取当前 effort 运行时态 + 能力（P2-1 左右键调 effort 用）。缺省则不显示 effort 行。 */
  getEffortState?: () => EffortState;
  /** effort setter（P2-1 左右键实时调整）。persist 语义同 /effort。 */
  setEffort?: (level: EffortSetting, persist?: boolean) => void;
  /**
   * 读取 thinking 运行时态。仅用于判断「思考已关 → 档位不生效」并提示（GLM/DeepSeek
   * 的 effort 下发被 thinking 门控）。缺省则不显示该提示，不影响其它功能。
   */
  getThinkingState?: () => { runtime: ThinkingSetting; applied: boolean };
}

/** 列表可视行数（含分组标题行，故比旧值放宽） */
const MAX_ROWS = 14;

/**
 * P2-1：从 effort 状态解析当前生效档位（auto 态取 applied 实际档位）。
 *
 * 注：档位循环本身已下沉到 effort.ts 的 {@link cycleEffortForModel}——它按模型可选档位集合
 * 走，替代了原先在本文件里按全量 5 档循环的 cycleEffort（会切到模型不支持的档）。
 */
export function resolveDisplayedEffort(state: EffortState | undefined): EffortLevel | undefined {
  if (!state) return undefined;
  return state.isAuto
    ? state.applied
    : ((state.runtime as EffortLevel | undefined) ?? state.applied);
}

/** 计算窗口起点，保证 activeIndex 在 [start, start+MAX_ROWS) 内（纯函数，便于单测） */
export function computeScrollStart(
  total: number,
  activeIndex: number,
  current: number,
  maxRows = MAX_ROWS,
): number {
  if (total <= maxRows) return 0;
  let start = current;
  if (activeIndex < start) start = activeIndex;
  else if (activeIndex >= start + maxRows) start = activeIndex - maxRows + 1;
  return Math.max(0, Math.min(start, total - maxRows));
}

export const ModelDialog: React.FC<ModelDialogProps> = ({
  onClose,
  currentModel,
  availableModels,
  onModelSelect,
  getEffortState,
  setEffort,
  getThinkingState,
}) => {
  // effort 状态自持一份 state，按键后主动重读 —— 这是 ←/→ 只能在两档间跳的根因修复。
  //
  // getEffortState 是**命令式回调**（读 App 的 runtimeEffort），不是 prop：effort 变了
  // 不会让本组件的 props 发生任何变化。而 effortDisplay 又只流到 Footer / 状态栏，没有
  // 经 props 进过对话框子树，于是面板挂载后就再也不重渲——每次按键都从挂载时读到的那个
  // 档位起算。基准冻结在 max 时，→ 环绕到 low、← 得到 xhigh，用户看到的就是「只有
  // low 和 xhigh 两档」。这里在 setEffort 之后立刻重读并写进本地 state 触发重渲，
  // 面板显示与真实运行时档位重新对齐。
  const [effortState, setEffortState] = useState<EffortState | undefined>(() => getEffortState?.());

  // 模型可能在面板打开期间被切换（Enter 选中后由外部关闭，但 currentModel 变更会先到），
  // 此时能力矩阵变了、可选档位集合也变了，必须重读，否则沿用上一个模型的档位表。
  useEffect(() => {
    setEffortState(getEffortState?.());
  }, [getEffortState, currentModel]);

  // 仅当模型支持档位切换且回调齐全时，才启用左右键调 effort。
  const effortEnabled = !!(effortState?.capability.supportsEffort && setEffort);
  // 该模型真实可选的档位（用于面板展示「3/5 档」这类提示，与循环逻辑同源）。
  const selectableEfforts = effortState ? getSelectableEfforts(effortState.capability) : [];

  // 「思考已关 → 档位不生效」提示：GLM/DeepSeek 的 effort 挂在 thinking 分支内，
  // /think off 之后 ←/→ 仍能切档但没有任何档位会发出去，面板等于空转。诚实告知而非静默。
  const effortInert = !!(
    effortState &&
    isEffortGatedByThinking(effortState.capability) &&
    getThinkingState &&
    getThinkingState().applied === false
  );

  const [query, setQuery] = useState("");
  // 分组后的扁平行序列（含分组标题），随查询实时重算
  const rows = useMemo(
    () => buildModelRows(availableModels, currentModel, query),
    [availableModels, currentModel, query],
  );
  const totalModels = useMemo(() => countModelRows(rows), [rows]);

  // 光标初始落在当前模型所在行（无查询时）；有查询时落到首个匹配项
  const [activeIndex, setActiveIndex] = useState(() =>
    indexOfModel(buildModelRows(availableModels, currentModel, ""), currentModel),
  );
  const [scrollStart, setScrollStart] = useState(0);

  // 过滤结果变化后把光标夹到合法的可选行上（避免停在标题行或越界）
  useEffect(() => {
    if (rows.length === 0) return;
    if (rows[activeIndex]?.kind !== "model") {
      setActiveIndex(firstSelectableIndex(rows));
    }
  }, [rows, activeIndex]);

  const safeIndex = rows[activeIndex]?.kind === "model"
    ? activeIndex
    : firstSelectableIndex(rows);

  const move = (dir: 1 | -1) => {
    const next = nextSelectableIndex(rows, safeIndex, dir);
    if (next >= 0) setActiveIndex(next);
  };

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    // Esc：有查询先清空，否则关闭（渐进退出，不丢状态）
    if (key.name === 'escape') {
      if (query) {
        setQuery("");
      } else {
        onClose();
      }
      return true;
    }

    if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
      move(-1);
      return true;
    }
    if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
      move(1);
      return true;
    }

    if (key.name === 'return' || key.name === 'enter') {
      const row = rows[safeIndex];
      if (row?.kind === "model") {
        onModelSelect(row.name);
        // 关闭由外部 onModelSelect 回调统一处理，不再重复调用 onClose
      }
      return true;
    }

    if (effortEnabled && (key.name === 'left' || key.name === 'right')) {
      // 以当前生效档位为基准（auto 态取 applied 实际档位），在**该模型可选档位**内循环。
      // 用 cycleEffortForModel 而非全量 5 档的 cycleEffort：后者会切到模型不支持的档
      // （如 o-series 的 xhigh/max），下发时被静默钳制成 high，面板显示与实发不一致。
      const current = resolveDisplayedEffort(effortState);
      const next = cycleEffortForModel(effortState!.capability, current, key.name === 'right' ? 1 : -1);
      if (next !== undefined) {
        setEffort?.(next);
        // 立即重读：getEffortState 是命令式回调，不重读则下一次按键仍以旧档位为基准。
        setEffortState(getEffortState?.());
      }
      return true;
    }

    // 搜索框输入：backspace 删字，可打印字符入队，即时过滤
    if (key.name === 'backspace' || key.name === 'delete') {
      setQuery(q => q.slice(0, -1));
      return true;
    }
    if (key.insertable && !key.ctrl && !key.alt && key.sequence) {
      setQuery(q => q + key.sequence);
      return true;
    }

    return false;
  });

  if (availableModels.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>选择模型</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>未配置可用模型</Text>
        </Box>
        <Text>在 ~/.sid-code/settings.json 的 availableModels 数组中添加模型</Text>
        <Box marginTop={1}>
          <Text italic>Esc 关闭</Text>
        </Box>
      </Box>
    );
  }

  // 名称 / provider 列宽（用 stringWidth 处理 CJK/全角），让右侧各列对齐成列（L2.3）。
  // 按全量模型算而非当前过滤结果——否则打字过滤时列宽会跟着跳动。
  const nameColWidth = availableModels.reduce(
    (w, m) => Math.max(w, stringWidth(m.name)),
    0,
  );
  const providerColWidth = availableModels.reduce(
    (w, m) => Math.max(w, stringWidth(m.provider)),
    0,
  );

  const currentOption = availableModels.find(m => m.name === currentModel);

  // effort 展示态：显示当前生效档位 + 字形；auto 态标注跟随默认。
  const effortDisplayLevel = resolveDisplayedEffort(effortState);

  // 窗口滚动（渲染期同步夹紧，与 BaseSelectionList 同套路）
  const effectiveStart = computeScrollStart(rows.length, safeIndex, scrollStart);
  if (effectiveStart !== scrollStart) setScrollStart(effectiveStart);
  const visible = rows.slice(effectiveStart, effectiveStart + MAX_ROWS);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.ui.active}
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text bold color={theme.ui.active}>选择模型</Text>
        <Text color={theme.text.secondary}>
          {" "}· {query ? `${totalModels}/${availableModels.length} 项匹配` : `${availableModels.length} 个可用`}
        </Text>
      </Box>
      {currentOption && (
        <Text color={theme.text.secondary}>
          当前: {currentOption.name} ({currentOption.provider})
        </Text>
      )}
      {effortEnabled && effortDisplayLevel && (
        <Text color={theme.text.secondary}>
          推理强度: <Text color={theme.ui.active}>{EFFORT_GLYPHS[effortDisplayLevel]} {effortDisplayLevel}</Text>
          {effortState?.isAuto ? " (auto)" : ""}
          {/* 把「本模型有哪几档」摆出来：用户能自己确认档位是否齐全，
              而不是看到 ←/→ 跳过某档时怀疑面板有 bug（本次问题的直接诱因）。 */}
          <Text> · {selectableEfforts.join("/")} · ←/→ 调整</Text>
        </Text>
      )}
      {effortInert && (
        <Text color={theme.status.warning}>
          {WARNING_MARK} 当前思考已关，本模型的档位不会下发（/think on 后生效）
        </Text>
      )}

      {/* 搜索框（常驻）：不套边框——外层面板已有一层 round 容器，内层再框就是
          盒子套盒子（src/ui/CLAUDE.md L2.2）。"能打字"靠 ⌕ 字形 + 闪烁光标 +
          上方一行留白表达，比画框更轻，也与标题/当前模型等行对齐成列（L2.3）。 */}
      <Box marginTop={1}>
        <Text color={theme.ui.symbol}>{SEARCH_MARK} </Text>
        {query ? (
          <Text color={theme.text.primary}>{query}</Text>
        ) : (
          <Text color={theme.text.secondary}>输入以搜索…</Text>
        )}
        <Text color={theme.ui.active}>▏</Text>
      </Box>

      {rows.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>无匹配的模型</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {visible.map((row, i) => (
            <ModelRowView
              key={row.key}
              row={row}
              isSelected={effectiveStart + i === safeIndex}
              nameColWidth={nameColWidth}
              providerColWidth={providerColWidth}
            />
          ))}
          {rows.length > MAX_ROWS && (
            <Text color={theme.text.secondary}>
              {"  "}… 共 {totalModels} 个模型，滚动查看更多
            </Text>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text italic>
          输入过滤 · ↑↓ 导航 · Enter 切换{effortEnabled ? " · ←/→ 调 effort" : ""} · Esc {query ? "清除" : "取消"}
        </Text>
      </Box>
    </Box>
  );
};

/**
 * 单行渲染：分组标题 vs 模型行。
 * 分组标题靠「缩进 + 粗体 + 次要色」区分，不画分隔线也不加边框（L2.2 留白优先）。
 */
const ModelRowView: React.FC<{
  row: ModelRow;
  isSelected: boolean;
  nameColWidth: number;
  providerColWidth: number;
}> = ({ row, isSelected, nameColWidth, providerColWidth }) => {
  if (row.kind === "header") {
    return (
      <Box>
        <Text bold color={theme.text.secondary}>{row.label}</Text>
        <Text color={theme.text.secondary}> · {row.count}</Text>
      </Box>
    );
  }

  // 名称列、provider 列各自 pad 到列宽，端点/描述才能对齐成列（L2.3）。
  // 「当前」徽章放到行尾——放在中间会把它右侧的列整体推移，各行对不齐。
  const namePad = " ".repeat(Math.max(1, nameColWidth - stringWidth(row.name) + 2));
  const providerPad = " ".repeat(Math.max(1, providerColWidth - stringWidth(row.provider) + 1));
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text color={theme.ui.focus}>{isSelected ? ARROW_PROMPT : " "}</Text>
      </Box>
      <Text color={isSelected ? theme.ui.focus : theme.text.primary} bold={isSelected}>
        {row.name}
      </Text>
      <Text color={theme.text.secondary}>{namePad}{row.provider}</Text>
      {row.endpoint && (
        <Text color={theme.text.secondary}>{providerPad}{row.endpoint}</Text>
      )}
      {row.note && (
        <Text color={theme.text.secondary}>{providerPad}— {row.note}</Text>
      )}
      {row.isCurrent && (
        <Text color={theme.ui.active}>  {TODO_COMPLETED} 当前</Text>
      )}
      {row.shadowed && (
        // 同名条目按名切换命中不到，诚实告知而不是让它看着能选（选了会静默切到第一条）
        <Text color={theme.status.warning}>  {WARNING_MARK} 同名被遮蔽</Text>
      )}
    </Box>
  );
};
