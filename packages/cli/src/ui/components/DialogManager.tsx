/**
 * 对话框管理器
 *
 * 权限确认对话框注册 Critical 优先级键盘处理器。
 * 支持：权限确认对话框、Shell 命令确认对话框、设置对话框、模型对话框、主题对话框。
 */

import React, { useRef, useState } from "react";
import Box from "@sid-code/tui-renderer/components/Box.tsx";
import Text from "@sid-code/tui-renderer/components/Text.tsx";
import { Ansi } from "@sid-code/tui-renderer/Ansi.tsx";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import type { Color } from "@sid-code/tui-renderer/styles.ts";
import { useTerminalDimensions } from "../contexts/TerminalContext.tsx";
import type {
  PermissionRequestInfo,
  ShellConfirmRequestInfo,
  PlanApprovalRequestInfo,
  AskUserQuestionRequestInfo,
} from "../App.tsx";
import { getToolDetailFull } from "../ui-utils.ts";
import { theme } from "../semantic-colors.ts";
import {
  BULLET,
  PLAN_REVIEW,
  WARNING_MARK,
  ARROW_PROMPT,
  CURSOR,
  POINTER,
  RADIO_EMPTY,
  RADIO_SELECTED,
  CHECKBOX_EMPTY,
  CHECKBOX_CHECKED,
  SUCCESS_MARK,
} from "../constants/figures.ts";
import { renderMarkdown } from "../markdown.ts";
import { inspectToolCall, inspectCommand } from "../utils/danger-detect.ts";

/**
 * 识别选项 label 是否带「推荐」后缀（(推荐) / (Recommended)，大小写不敏感、容忍首尾空白）。
 * 抽成纯函数便于单测。返回 true 表示该项应加视觉强调（对标 cc 的 (Recommended) 约定）。
 */
export function isRecommendedLabel(label: string): boolean {
  return /[（(]\s*(推荐|recommended)\s*[)）]\s*$/i.test(label.trim());
}

/** 权限确认对话框 */
function PermissionDialog({ request }: { request: PermissionRequestInfo }) {
  // 权限框是授权决策入口，必须让用户看清完整命令/路径，不截断（长则换行）。
  const detail = getToolDetailFull(request.toolName, request.toolInput);
  const resolvedRef = useRef(false);
  // 危险操作差异化：破坏性命令标红 + 警告行 + 仪式感文案（对标 cc destructiveCommandWarning）
  const danger = inspectToolCall(request.toolName, request.toolInput);

  useKeypress(KeypressPriority.Critical, (key) => {
    if (resolvedRef.current) return false;
    if (!key.insertable) return false;
    const lower = key.name;
    if (lower === "y") {
      resolvedRef.current = true;
      request.resolve("yes");
      return true;
    }
    if (lower === "n") {
      resolvedRef.current = true;
      request.resolve("no");
      return true;
    }
    if (lower === "a") {
      resolvedRef.current = true;
      request.resolve("always");
      return true;
    }
    return false;
  });

  // 危险时整体切到 error 红，标题加警告标记；普通时维持 warning 黄。
  const accentColor = danger.isDangerous ? theme.status.error : theme.status.warning;
  const title = danger.isDangerous ? `${WARNING_MARK} 危险操作确认` : `${BULLET} 权限请求`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accentColor} paddingX={1}>
      <Text color={accentColor} bold>
        {title}
      </Text>
      <Box marginTop={0} paddingLeft={2} flexDirection="column">
        <Box>
          <Text color={theme.text.secondary}>工具: </Text>
          <Text bold>{request.toolName}</Text>
        </Box>
        <Box flexDirection="row">
          <Box flexShrink={0}>
            <Text color={theme.text.secondary}>详情: </Text>
          </Box>
          <Box flexGrow={1}>
            <Text color={theme.ui.active} wrap="wrap">
              {detail}
            </Text>
          </Box>
        </Box>
        {danger.isDangerous && (
          <Box>
            <Text color={theme.status.error} bold>
              {WARNING_MARK} 此操作不可逆：{danger.label}
            </Text>
          </Box>
        )}
        {/* 不可达规则提示（对标 cc Unreachable Rules）：当前工具有被高优先级规则遮蔽的规则时展示 */}
        {request.shadowedRules && request.shadowedRules.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.status.warning}>
              {WARNING_MARK} 不可达规则 ({request.shadowedRules.length})
            </Text>
            {request.shadowedRules.map((s, i) => (
              <Box key={i} flexDirection="column" paddingLeft={2}>
                <Text
                  color={s.severity === "blocked" ? theme.status.warning : theme.text.secondary}
                >
                  {s.rule}
                </Text>
                <Text color={theme.text.secondary}>
                  {`被 ${s.bySource} 的 ${s.byBehavior} 规则`}
                  {s.severity === "blocked" ? "完全拦截" : "遮蔽（仍会弹窗）"}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
      {/* 安全默认：危险操作把「拒绝」放在最前并标红强调，避免手滑误允许 */}
      {danger.isDangerous ? (
        <Box marginTop={0}>
          <Text color={theme.status.error} bold>
            {" "}
            (n)
          </Text>
          <Text>拒绝（推荐） </Text>
          <Text color={theme.status.success} bold>
            {" "}
            (y)
          </Text>
          <Text>确认执行 </Text>
          <Text color={theme.status.warning} bold>
            {" "}
            (a)
          </Text>
          <Text>始终允许</Text>
        </Box>
      ) : (
        <Box marginTop={0}>
          <Text color={theme.status.success} bold>
            {" "}
            (y)
          </Text>
          <Text>允许 </Text>
          <Text color={theme.status.error} bold>
            {" "}
            (n)
          </Text>
          <Text>拒绝 </Text>
          <Text color={theme.status.warning} bold>
            {" "}
            (a)
          </Text>
          <Text>始终允许</Text>
        </Box>
      )}
    </Box>
  );
}

/** Shell 命令确认对话框 */
function ShellConfirmDialog({ request }: { request: ShellConfirmRequestInfo }) {
  const resolvedRef = useRef(false);
  // 逐条检测命令危险性，任一命中即整体进入危险态
  const verdicts = request.commands.map((cmd) => inspectCommand(cmd));
  const dangerIndex = verdicts.findIndex((v) => v.isDangerous);
  const isDangerous = dangerIndex >= 0;

  useKeypress(KeypressPriority.Critical, (key) => {
    if (resolvedRef.current) return false;
    if (!key.insertable) return false;
    const lower = key.name;
    if (lower === "y") {
      resolvedRef.current = true;
      request.resolve(true);
      return true;
    }
    if (lower === "n") {
      resolvedRef.current = true;
      request.resolve(false);
      return true;
    }
    return false;
  });

  const accentColor = isDangerous ? theme.status.error : theme.text.accent;
  const title = isDangerous ? `${WARNING_MARK} 危险 Shell 命令确认` : `${BULLET} Shell 命令确认`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accentColor} paddingX={1}>
      <Text color={accentColor} bold>
        {title}
      </Text>
      <Text>自定义命令将执行以下 Shell 命令：</Text>
      {request.commands.map((cmd, i) => (
        <Box key={i} marginLeft={2}>
          <Text color={verdicts[i].isDangerous ? theme.status.error : theme.ui.active}>$ </Text>
          <Text color={verdicts[i].isDangerous ? theme.status.error : undefined}>{cmd}</Text>
        </Box>
      ))}
      {isDangerous && (
        <Box>
          <Text color={theme.status.error} bold>
            {WARNING_MARK} 此操作不可逆：{verdicts[dangerIndex].label}
          </Text>
        </Box>
      )}
      {isDangerous ? (
        <Box marginTop={0}>
          <Text color={theme.status.error} bold>
            {" "}
            (n)
          </Text>
          <Text>取消（推荐） </Text>
          <Text color={theme.status.success} bold>
            {" "}
            (y)
          </Text>
          <Text>确认执行</Text>
        </Box>
      ) : (
        <Box marginTop={0}>
          <Text color={theme.status.success} bold>
            {" "}
            (y)
          </Text>
          <Text>确认执行 </Text>
          <Text color={theme.status.error} bold>
            {" "}
            (n)
          </Text>
          <Text>取消</Text>
        </Box>
      )}
    </Box>
  );
}

/** Plan Mode 审批对话框（选择列表版：批准/拒绝附意见/取消/自由输入） */
function PlanApprovalDialog({ request }: { request: PlanApprovalRequestInfo }) {
  const resolvedRef = useRef(false);
  const [cursor, setCursor] = useState(0);
  // "拒绝，附修改意见"输入态
  const [editingFeedback, setEditingFeedback] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  // "其他…"自由输入态
  const [editingOther, setEditingOther] = useState(false);
  const [otherText, setOtherText] = useState("");

  const options = [
    { label: "批准并执行", action: "approve" },
    { label: "拒绝，附修改意见", action: "reject-feedback" },
    { label: "取消（退出计划模式）", action: "cancel" },
  ];
  const otherIndex = options.length; // "其他…"行
  const totalRows = options.length + 1;

  const accent = theme.ui.active;

  const finish = (decision: string) => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    request.resolve(decision);
  };

  useKeypress(KeypressPriority.Critical, (key) => {
    if (resolvedRef.current) return false;

    const isEnter = key.name === "return" || key.name === "enter";

    // 文本输入态：拦截所有按键
    if (editingFeedback) {
      if (isEnter) {
        // 提交反馈
        const text = feedbackText.trim();
        finish(text ? `reject:${text}` : "reject");
        return true;
      }
      if (key.name === "escape") {
        setEditingFeedback(false);
        setFeedbackText("");
        return true;
      }
      if (key.name === "backspace") {
        setFeedbackText((t) => t.slice(0, -1));
        return true;
      }
      if (key.insertable && key.name) {
        setFeedbackText((t) => t + key.name);
        return true;
      }
      return true; // 吃掉所有按键
    }
    if (editingOther) {
      if (isEnter) {
        const text = otherText.trim();
        if (text) finish(`reject:${text}`);
        return true;
      }
      if (key.name === "escape") {
        setEditingOther(false);
        setOtherText("");
        return true;
      }
      if (key.name === "backspace") {
        setOtherText((t) => t.slice(0, -1));
        return true;
      }
      if (key.insertable && key.name) {
        setOtherText((t) => t + key.name);
        return true;
      }
      return true;
    }

    // 列表导航态
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setCursor((c) => (c <= 0 ? totalRows - 1 : c - 1));
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setCursor((c) => (c >= totalRows - 1 ? 0 : c + 1));
      return true;
    }
    if (key.name === "escape") {
      finish("cancel");
      return true;
    }
    if (isEnter) {
      if (cursor < options.length) {
        const opt = options[cursor];
        if (opt.action === "approve") {
          finish("approve");
          return true;
        }
        if (opt.action === "cancel") {
          finish("cancel");
          return true;
        }
        if (opt.action === "reject-feedback") {
          setEditingFeedback(true);
          return true;
        }
      } else {
        // "其他…"
        setEditingOther(true);
        return true;
      }
    }
    // 快捷键（不在编辑态时）
    if (key.insertable) {
      if (key.name === "y") {
        finish("approve");
        return true;
      }
      if (key.name === "n") {
        setEditingFeedback(true);
        setCursor(1);
        return true;
      }
    }
    return false;
  });

  const lineCount = request.planContent.split("\n").length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      <Text color={accent} bold>
        {PLAN_REVIEW} 计划审批
      </Text>
      <Text>
        文件: {request.planFilePath} ({lineCount} 行)
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => {
          const focused = cursor === i && !editingFeedback && !editingOther;
          return (
            <Box key={opt.action}>
              <Box width={5} flexShrink={0}>
                <Text color={focused ? accent : theme.text.secondary}>
                  {focused ? POINTER : " "} {focused ? RADIO_SELECTED : RADIO_EMPTY}
                </Text>
              </Box>
              <Text color={focused ? accent : undefined} bold={focused}>
                {opt.label}
              </Text>
            </Box>
          );
        })}
        {/* "其他…"行 */}
        <Box>
          <Box width={5} flexShrink={0}>
            <Text
              color={
                cursor === otherIndex && !editingFeedback && !editingOther
                  ? accent
                  : theme.text.secondary
              }
            >
              {cursor === otherIndex && !editingFeedback && !editingOther ? POINTER : " "}{" "}
              {cursor === otherIndex && !editingFeedback && !editingOther
                ? RADIO_SELECTED
                : RADIO_EMPTY}
            </Text>
          </Box>
          <Text
            color={
              cursor === otherIndex && !editingFeedback && !editingOther
                ? accent
                : theme.text.secondary
            }
            bold={cursor === otherIndex && !editingFeedback && !editingOther}
          >
            其他…
          </Text>
        </Box>
      </Box>
      {/* 反馈文本输入区 */}
      {editingFeedback && (
        <Box paddingLeft={2} marginTop={0}>
          <Text color={accent}>{ARROW_PROMPT} 修改意见: </Text>
          <Text>{feedbackText}</Text>
          <Text color={accent}>{CURSOR}</Text>
        </Box>
      )}
      {editingOther && (
        <Box paddingLeft={2} marginTop={0}>
          <Text color={accent}>{ARROW_PROMPT} </Text>
          <Text>{otherText}</Text>
          <Text color={accent}>{CURSOR}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          {editingFeedback || editingOther
            ? "Enter 提交 · Esc 返回"
            : "↑↓ 移动 · Enter 选择 · y 批准 · n 拒绝 · Esc 取消"}
        </Text>
      </Box>
    </Box>
  );
}

/** "其他…"行（选中后进入自定义文本输入）。preview 视图与列表视图共用。 */
function OtherRow({
  focused,
  editing,
  text,
  accent,
  showConfirmHint,
}: {
  focused: boolean;
  editing: boolean;
  text: string;
  accent: Color;
  showConfirmHint?: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2} flexShrink={0}>
          <Text color={focused ? accent : theme.text.secondary}>
            {focused && !editing ? POINTER : " "}
          </Text>
        </Box>
        <Text color={focused ? accent : theme.text.secondary} bold={focused}>
          其他…
        </Text>
        {showConfirmHint && !editing && text.trim() && (
          <Text color={theme.text.secondary}> ({text}) (再按 Enter 确认)</Text>
        )}
      </Box>
      {editing && (
        <Box paddingLeft={2}>
          <Text color={accent}>{ARROW_PROMPT} </Text>
          <Text>{text}</Text>
          <Text color={accent}>{CURSOR}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * "确认提交"行——提交是与选择分离的独立第二步（防手滑）。
 * enabled=false（无任何选择）时置灰，该行 Enter 不生效。
 */
function ConfirmRow({
  focused,
  enabled,
  summary,
  isMulti,
  selectedCount,
  accent,
}: {
  focused: boolean;
  enabled: boolean;
  summary: string;
  isMulti: boolean;
  selectedCount: number;
  accent: Color;
}) {
  const label = "确认提交";
  const suffix = !enabled
    ? "（请先选择）"
    : isMulti
      ? `（已选 ${selectedCount} 项）`
      : `（${summary}）`;
  const color = !enabled ? theme.text.secondary : focused ? accent : theme.status.success;
  return (
    <Box marginTop={1}>
      <Box width={2} flexShrink={0}>
        <Text color={focused && enabled ? accent : theme.text.secondary}>
          {focused ? POINTER : " "}
        </Text>
      </Box>
      {/* 置灰不用 ANSI dim：dim 与 bold 在终端互斥（见 src/ui/CLAUDE.md L1.3），
          且上面的 `color` 在 !enabled 时已是 theme.text.secondary，灰色 token 已把
          禁用态表达完整。原先多传的 dimColor 既不是 Text 的 prop（fork 里叫 dim）
          也是冗余的。 */}
      <Text color={color} bold={focused && enabled}>
        {SUCCESS_MARK} {label} {suffix}
      </Text>
    </Box>
  );
}

/** 操作提示行文案：随输入态 / 单多选切换。 */
function hintText(editingOther: boolean, editingNotes: boolean, isMulti: boolean): string {
  if (editingOther) return "输入自定义答案，Enter 确认，Esc 返回";
  if (editingNotes) return "输入备注，Enter 确认，Esc 返回";
  if (isMulti) return '↑↓ 移动 · Enter/Space 勾选 · 到"确认提交"按 Enter · Esc 取消';
  return "↑↓ 移动 · Enter 选择/确认 · n 备注 · Esc 取消";
}

/**
 * 组装回灌答案串。抽成纯函数便于单测。
 * - 单选：取 selected 里唯一项的 label；若有 otherText 则用它（"其他"优先，因为它是显式输入）。
 * - 多选：selected 各项 label 按序 + otherText，以 ", " 连接。
 * - 空选择（无 selected 且无 otherText）返回 ""，调用方据此禁用"确认提交"。
 */
export function assembleAnswer(
  options: Array<{ label: string }>,
  selected: Set<number>,
  otherText: string,
  isMulti: boolean,
): string {
  const other = otherText.trim();
  const labels = options.filter((_, i) => selected.has(i)).map((o) => o.label);
  if (isMulti) {
    const all = other ? [...labels, other] : labels;
    return all.join(", ");
  }
  // 单选：其他文本优先，否则取唯一选中项
  if (other) return other;
  return labels[0] ?? "";
}

/**
 * AskUserQuestion 交互对话框（对标 cc AskUserQuestionPermissionRequest）。
 *
 * 模型用 ask_user_question 工具发起 1-4 道结构化选择题，本组件逐题收集答案：
 * - 单选：radio ○/●，↑↓ 移动 + Enter 选中某项，已选中状态再按 Enter 直接提交（双击确认）。
 * - 多选：checkbox □/■，↑↓ 移动 + Enter/Space 勾选/取消（不提交）。
 *   多选提交是独立第二步：光标移到末尾"确认提交"行按 Enter 才真正提交（防手滑）。
 * - 每题末尾"其他…"项：选中后进入文本输入，键入自定义答案。
 * - ESC 取消整个问卷（回灌 cancelled，模型据此走默认方案，不会卡住）。
 * - preview：单选题选项带 preview 时切换为左右分栏（左选项 + 右预览框）。
 * - notes：单选题按 n 可给选择附加自由备注，与答案一起回灌模型。
 * - Recommended：label 后缀 (推荐)/(Recommended) 的选项加品牌蓝强调。
 *
 * 视觉遵循 src/ui/CLAUDE.md：单 round 容器、品牌蓝点睛、字形从 figures.ts 取、
 * 单选圆圈 / 多选方框（形状区分语义）+ 填充度（○/● □/■）双通道表达选中态。
 */
function AskUserQuestionDialog({ request }: { request: AskUserQuestionRequestInfo }) {
  const resolvedRef = useRef(false);
  const questions = request.questions;
  const { width: termWidth } = useTerminalDimensions();

  // 当前题目索引
  const [qIndex, setQIndex] = useState(0);
  // 已收集答案：问题文本 → 答案串（多选以 ", " 连接）
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // 所有题的备注：问题文本 → 备注
  const [notes, setNotes] = useState<Record<string, string>>({});
  // 当前题的高亮项索引（含"其他"项、"确认提交"项）
  const [cursor, setCursor] = useState(0);
  // 当前题已选中的选项索引集合（单选恒 ≤1 项，多选可多项）
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // 是否处于"其他"自定义文本输入态
  const [editingOther, setEditingOther] = useState(false);
  const [otherText, setOtherText] = useState("");
  // notes 输入态
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesText, setNotesText] = useState("");

  const current = questions[qIndex];
  const isMulti = !!current.multiSelect;
  // 行索引布局：0..n-1 选项 → otherIndex "其他" → (多选才有) confirmIndex "确认提交"
  const otherIndex = current.options.length;
  const confirmIndex = isMulti ? current.options.length + 1 : -1; // 单选无确认行
  const totalRows = current.options.length + 1 + (isMulti ? 1 : 0); // 单选少一行
  // 是否为 preview 分栏模式：单选 + 任一选项带 preview
  const hasPreview = !isMulti && current.options.some((o) => !!o.preview);

  // 当前题已组装的答案（驱动"确认提交"行的可用态与摘要）
  const currentAnswer = assembleAnswer(current.options, selected, otherText, isMulti);
  const hasSelection = currentAnswer.length > 0;

  const finish = (finalAnswers: Record<string, string>, finalNotes: Record<string, string>) => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    // 只传非空 notes
    const filteredNotes = Object.fromEntries(
      Object.entries(finalNotes).filter(([, v]) => v.trim().length > 0),
    );
    request.resolve({
      decision: "answered",
      answers: finalAnswers,
      ...(Object.keys(filteredNotes).length > 0 && { notes: filteredNotes }),
    });
  };

  // 提交当前题答案并推进到下一题（或在最后一题时提交整卷）。仅由"确认提交"行触发。
  const submitCurrent = () => {
    const answer = assembleAnswer(current.options, selected, otherText, isMulti);
    if (answer.length === 0) return; // 无选择：确认行不生效
    const nextAnswers = { ...answers, [current.question]: answer };
    const nextNotes = notesText.trim() ? { ...notes, [current.question]: notesText.trim() } : notes;
    setAnswers(nextAnswers);
    setNotes(nextNotes);
    if (qIndex < questions.length - 1) {
      setQIndex(qIndex + 1);
      setCursor(0);
      setSelected(new Set());
      setEditingOther(false);
      setOtherText("");
      setEditingNotes(false);
      setNotesText("");
    } else {
      finish(nextAnswers, nextNotes);
    }
  };

  // 切换某选项的选中态：单选=设为唯一项（并清 otherText），多选=勾选/取消
  const toggleOption = (idx: number) => {
    setSelected((prev) => {
      if (!isMulti) {
        // 单选：点已选项则维持（radio 不可空选），否则设为唯一项
        setOtherText("");
        return new Set([idx]);
      }
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  useKeypress(KeypressPriority.Critical, (key) => {
    if (resolvedRef.current) return false;

    // ESC：分层退出——notes 输入态先退 → "其他"输入态再退 → 最后取消整卷
    if (key.name === "escape") {
      if (editingNotes) {
        setEditingNotes(false);
        return true;
      }
      if (editingOther) {
        setEditingOther(false);
        return true;
      }
      resolvedRef.current = true;
      request.resolve({ decision: "cancelled" });
      return true;
    }

    // ── notes 文本输入态 ──
    if (editingNotes) {
      if (key.name === "return" || key.name === "enter") {
        // Enter 退出 notes 输入（保留内容，提交时会随答案一起走）
        setEditingNotes(false);
        return true;
      }
      if (key.name === "backspace" || key.name === "delete") {
        setNotesText((t) => t.slice(0, -1));
        return true;
      }
      if (key.insertable && key.sequence) {
        setNotesText((t) => t + key.sequence);
        return true;
      }
      return true; // 吞掉其它按键
    }

    // ── "其他"文本输入态 ──
    if (editingOther) {
      if (key.name === "return" || key.name === "enter") {
        const text = otherText.trim();
        if (text.length === 0) {
          // 空输入：退出输入态，不作为答案
          setEditingOther(false);
          return true;
        }
        // 确认自定义文本：单选清掉其它选中项（其他文本即答案），多选保留勾选项 + 追加
        if (!isMulti) setSelected(new Set());
        setEditingOther(false);
        return true;
      }
      if (key.name === "backspace" || key.name === "delete") {
        setOtherText((t) => t.slice(0, -1));
        return true;
      }
      if (key.insertable && key.sequence) {
        setOtherText((t) => t + key.sequence);
        return true;
      }
      return true;
    }

    // ── 列表选择态 ──
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setCursor((c) => (c - 1 + totalRows) % totalRows);
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setCursor((c) => (c + 1) % totalRows);
      return true;
    }

    // 多选：空格勾选 / 取消（仅在选项行；"其他"/"确认"行不参与）
    if (isMulti && key.name === "space" && cursor < otherIndex) {
      toggleOption(cursor);
      return true;
    }

    // n 键：单选题进入 notes 输入态（选项行才有意义）
    if (key.name === "n" && !isMulti && cursor < otherIndex) {
      setEditingNotes(true);
      return true;
    }

    if (key.name === "return" || key.name === "enter") {
      // 多选模式：保持原逻辑（确认提交行 + 勾选）
      if (isMulti) {
        if (cursor === confirmIndex) {
          submitCurrent();
          return true;
        }
        if (cursor === otherIndex) {
          setEditingOther(true);
          return true;
        }
        toggleOption(cursor);
        return true;
      }
      // 单选模式：双击 Enter 确认（已选中再按 Enter → 直接提交）
      if (cursor === otherIndex) {
        // "其他"行：有文本时直接提交（等同"已选中再按 Enter"），无文本时进入输入
        if (otherText.trim()) {
          submitCurrent();
        } else {
          setEditingOther(true);
        }
        return true;
      }
      if (selected.has(cursor)) {
        // 已选中 → 直接提交
        submitCurrent();
      } else {
        // 未选中 → 选中它
        toggleOption(cursor);
      }
      return true;
    }

    return false;
  });

  const accent = theme.ui.active;

  // ── preview 分栏视图 ──
  if (hasPreview) {
    const leftWidth = Math.min(32, Math.floor(termWidth * 0.35));
    const previewWidth = Math.max(20, termWidth - leftWidth - 6); // 6 = border + gap + padding
    const focusedOption = current.options[cursor < otherIndex ? cursor : 0];
    const previewContent = focusedOption?.preview
      ? renderMarkdown(focusedOption.preview, previewWidth - 4) // 4 for inner padding
      : "";
    // tail 截断超高 preview
    const previewLines = previewContent.split("\n");
    const maxPreviewLines = 12;
    const isTruncated = previewLines.length > maxPreviewLines;
    const displayPreview = isTruncated
      ? [
          ...previewLines.slice(0, maxPreviewLines),
          `\x1b[2m… +${previewLines.length - maxPreviewLines} 行已折叠\x1b[0m`,
        ].join("\n")
      : previewContent;

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
        {/* 标题行 */}
        <Box>
          <Text color={accent} bold>
            {BULLET} {current.header}
          </Text>
          {questions.length > 1 && (
            <Text color={theme.text.secondary}>
              {" "}
              ({qIndex + 1}/{questions.length})
            </Text>
          )}
        </Box>
        <Box paddingLeft={2} marginTop={0}>
          <Text>{current.question}</Text>
        </Box>

        {/* 左右分栏 */}
        <Box flexDirection="row" marginTop={1} gap={1}>
          {/* 左栏：选项列表（radio 单选） */}
          <Box flexDirection="column" width={leftWidth} flexShrink={0}>
            {current.options.map((opt, i) => {
              const isCursor = cursor === i;
              const isSel = selected.has(i);
              const recommended = isRecommendedLabel(opt.label);
              const glyph = isSel ? RADIO_SELECTED : RADIO_EMPTY;
              const labelColor = isCursor ? accent : recommended ? accent : theme.text.primary;
              return (
                <Box key={i} flexDirection="column">
                  <Box>
                    <Box width={2} flexShrink={0}>
                      <Text color={isCursor ? accent : theme.text.secondary}>
                        {isCursor ? POINTER : " "}
                      </Text>
                    </Box>
                    <Box width={2} flexShrink={0}>
                      <Text color={isSel ? theme.status.success : theme.text.secondary}>
                        {glyph}
                      </Text>
                    </Box>
                    <Text color={labelColor} bold={isCursor || recommended}>
                      {opt.label}
                    </Text>
                    {isSel && <Text color={theme.text.secondary}> (再按 Enter 确认)</Text>}
                  </Box>
                </Box>
              );
            })}
            {/* "其他"项 */}
            <OtherRow
              focused={cursor === otherIndex}
              editing={editingOther}
              text={otherText}
              accent={accent}
              showConfirmHint={true}
            />
          </Box>

          {/* 右栏：预览框 */}
          <Box
            flexDirection="column"
            flexGrow={1}
            borderStyle="round"
            borderColor={theme.border.default}
            paddingX={1}
          >
            {displayPreview ? (
              <Ansi>{displayPreview}</Ansi>
            ) : (
              <Text color={theme.text.secondary}>无预览</Text>
            )}
          </Box>
        </Box>

        {/* notes 区 */}
        {editingNotes ? (
          <Box paddingLeft={2} marginTop={0}>
            <Text color={accent}>备注: {ARROW_PROMPT} </Text>
            <Text>{notesText}</Text>
            <Text color={accent}>{CURSOR}</Text>
          </Box>
        ) : notesText.trim() ? (
          <Box paddingLeft={2} marginTop={0}>
            <Text color={theme.text.secondary}>备注: {notesText}</Text>
          </Box>
        ) : null}

        {/* 操作提示 */}
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>{hintText(editingOther, editingNotes, isMulti)}</Text>
        </Box>
      </Box>
    );
  }

  // ── 列表视图（标准路径：单选 / 多选） ──
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      {/* 标题行：chip 标签 + 进度 */}
      <Box>
        <Text color={accent} bold>
          {BULLET} {current.header}
        </Text>
        {questions.length > 1 && (
          <Text color={theme.text.secondary}>
            {" "}
            ({qIndex + 1}/{questions.length})
          </Text>
        )}
      </Box>
      <Box paddingLeft={2} marginTop={0}>
        <Text>{current.question}</Text>
      </Box>

      {/* 选项列表：单选 radio ○/● · 多选 checkbox □/■ */}
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        {current.options.map((opt, i) => {
          const isCursor = cursor === i && !editingOther && !editingNotes;
          const isSel = selected.has(i);
          const recommended = isRecommendedLabel(opt.label);
          // 形状区分语义：单选圆圈 / 多选方框；填充度表达选中态
          const glyph = isMulti
            ? isSel
              ? CHECKBOX_CHECKED
              : CHECKBOX_EMPTY
            : isSel
              ? RADIO_SELECTED
              : RADIO_EMPTY;
          const glyphColor = isSel ? theme.status.success : theme.text.secondary;
          const labelColor = isCursor ? accent : recommended ? accent : theme.text.primary;
          return (
            <Box key={i} flexDirection="column">
              <Box>
                <Box width={2} flexShrink={0}>
                  <Text color={isCursor ? accent : theme.text.secondary}>
                    {isCursor ? POINTER : " "}
                  </Text>
                </Box>
                <Box width={2} flexShrink={0}>
                  <Text color={glyphColor}>{glyph}</Text>
                </Box>
                <Text color={labelColor} bold={isCursor || recommended}>
                  {opt.label}
                </Text>
                {isSel && !isMulti && <Text color={theme.text.secondary}> (再按 Enter 确认)</Text>}
              </Box>
              {isCursor && opt.description && (
                <Box paddingLeft={4}>
                  <Text color={theme.text.secondary}>{opt.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}

        {/* "其他"自定义输入项 */}
        <OtherRow
          focused={cursor === otherIndex && !editingNotes}
          editing={editingOther}
          text={otherText}
          accent={accent}
          showConfirmHint={!isMulti}
        />

        {/* 确认提交行：仅多选模式显示 */}
        {isMulti && (
          <ConfirmRow
            focused={cursor === confirmIndex && !editingOther && !editingNotes}
            enabled={hasSelection}
            summary={currentAnswer}
            isMulti={isMulti}
            selectedCount={selected.size + (otherText.trim() ? 1 : 0)}
            accent={accent}
          />
        )}
      </Box>

      {/* notes 区（仅单选题可用） */}
      {!isMulti &&
        (editingNotes ? (
          <Box paddingLeft={2} marginTop={0}>
            <Text color={accent}>备注: {ARROW_PROMPT} </Text>
            <Text>{notesText}</Text>
            <Text color={accent}>{CURSOR}</Text>
          </Box>
        ) : notesText.trim() ? (
          <Box paddingLeft={2} marginTop={0}>
            <Text color={theme.text.secondary}>备注: {notesText}</Text>
          </Box>
        ) : null)}

      {/* 操作提示行：随模式切换 */}
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>{hintText(editingOther, editingNotes, isMulti)}</Text>
      </Box>
    </Box>
  );
}

/** 对话框渲染器：渲染权限确认、Shell 确认、Plan 审批或 AskUserQuestion 对话框 */
export function DialogRenderer({
  permissionRequest,
  shellConfirmRequest,
  planApprovalRequest,
  askUserQuestionRequest,
}: {
  permissionRequest: PermissionRequestInfo | null;
  shellConfirmRequest: ShellConfirmRequestInfo | null;
  planApprovalRequest: PlanApprovalRequestInfo | null;
  askUserQuestionRequest?: AskUserQuestionRequestInfo | null;
}) {
  if (permissionRequest) {
    return <PermissionDialog request={permissionRequest} />;
  }
  if (shellConfirmRequest) {
    return <ShellConfirmDialog request={shellConfirmRequest} />;
  }
  if (planApprovalRequest) {
    return <PlanApprovalDialog request={planApprovalRequest} />;
  }
  if (askUserQuestionRequest) {
    return <AskUserQuestionDialog request={askUserQuestionRequest} />;
  }
  return null;
}
