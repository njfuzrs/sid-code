/**
 * 对话框管理器
 *
 * 权限确认对话框注册 Critical 优先级键盘处理器。
 * 支持：权限确认对话框、Shell 命令确认对话框、设置对话框、模型对话框、主题对话框。
 */

import React, { useRef, useState } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { useKeypress, KeypressPriority } from "../contexts/KeypressContext.tsx";
import type { PermissionRequestInfo, ShellConfirmRequestInfo, PlanApprovalRequestInfo, AskUserQuestionRequestInfo } from "../App.tsx";
import { getToolDetailFull } from "../ui-utils.ts";
import { theme } from "../semantic-colors.ts";
import { BULLET, PLAN_REVIEW, WARNING_MARK, ARROW_PROMPT, TODO_PENDING, TODO_COMPLETED, CURSOR } from "../constants/figures.ts";
import { inspectToolCall, inspectCommand } from "../utils/danger-detect.ts";

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
    if (lower === "y") { resolvedRef.current = true; request.resolve("yes"); return true; }
    if (lower === "n") { resolvedRef.current = true; request.resolve("no"); return true; }
    if (lower === "a") { resolvedRef.current = true; request.resolve("always"); return true; }
    return false;
  });

  // 危险时整体切到 error 红，标题加警告标记；普通时维持 warning 黄。
  const accentColor = danger.isDangerous ? theme.status.error : theme.status.warning;
  const title = danger.isDangerous
    ? `${WARNING_MARK} 危险操作确认`
    : `${BULLET} 权限请求`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accentColor} paddingX={1}>
      <Text color={accentColor} bold>{title}</Text>
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
            <Text color={theme.ui.active} wrap="wrap">{detail}</Text>
          </Box>
        </Box>
        {danger.isDangerous && (
          <Box>
            <Text color={theme.status.error} bold>{WARNING_MARK} 此操作不可逆：{danger.label}</Text>
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
                <Text color={s.severity === "blocked" ? theme.status.warning : theme.text.secondary}>
                  {s.rule}
                </Text>
                <Text color={theme.text.secondary} dimColor>
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
          <Text color={theme.status.error} bold> (n)</Text><Text>拒绝（推荐） </Text>
          <Text color={theme.status.success} bold> (y)</Text><Text>确认执行 </Text>
          <Text color={theme.status.warning} bold> (a)</Text><Text>始终允许</Text>
        </Box>
      ) : (
        <Box marginTop={0}>
          <Text color={theme.status.success} bold> (y)</Text><Text>允许 </Text>
          <Text color={theme.status.error} bold> (n)</Text><Text>拒绝 </Text>
          <Text color={theme.status.warning} bold> (a)</Text><Text>始终允许</Text>
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
    if (lower === "y") { resolvedRef.current = true; request.resolve(true); return true; }
    if (lower === "n") { resolvedRef.current = true; request.resolve(false); return true; }
    return false;
  });

  const accentColor = isDangerous ? theme.status.error : theme.text.accent;
  const title = isDangerous
    ? `${WARNING_MARK} 危险 Shell 命令确认`
    : `${BULLET} Shell 命令确认`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accentColor} paddingX={1}>
      <Text color={accentColor} bold>{title}</Text>
      <Text dimColor>自定义命令将执行以下 Shell 命令：</Text>
      {request.commands.map((cmd, i) => (
        <Box key={i} marginLeft={2}>
          <Text color={verdicts[i].isDangerous ? theme.status.error : theme.ui.active}>$ </Text>
          <Text color={verdicts[i].isDangerous ? theme.status.error : undefined}>{cmd}</Text>
        </Box>
      ))}
      {isDangerous && (
        <Box>
          <Text color={theme.status.error} bold>{WARNING_MARK} 此操作不可逆：{verdicts[dangerIndex].label}</Text>
        </Box>
      )}
      {isDangerous ? (
        <Box marginTop={0}>
          <Text color={theme.status.error} bold> (n)</Text><Text>取消（推荐） </Text>
          <Text color={theme.status.success} bold> (y)</Text><Text>确认执行</Text>
        </Box>
      ) : (
        <Box marginTop={0}>
          <Text color={theme.status.success} bold> (y)</Text><Text>确认执行 </Text>
          <Text color={theme.status.error} bold> (n)</Text><Text>取消</Text>
        </Box>
      )}
    </Box>
  );
}

/** Plan Mode 审批对话框（轻量版：计划内容已在上方消息区域渲染，底部只显示操作栏） */
function PlanApprovalDialog({ request }: { request: PlanApprovalRequestInfo }) {
  const resolvedRef = useRef(false);

  useKeypress(KeypressPriority.Critical, (key) => {
    if (resolvedRef.current) return false;
    if (!key.insertable) return false;
    const lower = key.name;
    if (lower === "y") { resolvedRef.current = true; request.resolve("approve"); return true; }
    if (lower === "n") { resolvedRef.current = true; request.resolve("reject"); return true; }
    return false;
  });

  const lineCount = request.planContent.split("\n").length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.text.accent} paddingX={1}>
      <Text color={theme.text.accent} bold>{PLAN_REVIEW} 计划审批</Text>
      <Text dimColor>文件: {request.planFilePath} ({lineCount} 行)</Text>
      <Text dimColor>计划内容已显示在上方消息区域，可滚动查看</Text>
      <Box marginTop={0}>
        <Text color={theme.status.success} bold> (y)</Text><Text>批准并执行 </Text>
        <Text color={theme.status.error} bold> (n)</Text><Text>拒绝并修改</Text>
      </Box>
    </Box>
  );
}

/**
 * AskUserQuestion 交互对话框（对标 cc AskUserQuestionPermissionRequest）。
 *
 * 模型用 ask_user_question 工具发起 1-4 道结构化选择题，本组件逐题收集答案：
 * - 单选：↑↓ 选择 + Enter 确认，立即进入下一题（最后一题确认即提交）。
 * - 多选：↑↓ 移动 + Space 勾选 / 取消，Enter 确认本题（至少选一项）。
 * - 每题末尾自动追加"其他…"项：选中后进入文本输入，键入自定义答案，Enter 确认。
 * - ESC 取消整个问卷（回灌 cancelled，模型据此走默认方案，不会卡住）。
 *
 * 视觉遵循 src/ui/CLAUDE.md：单 round 容器、品牌蓝点睛、字形从 figures.ts 取、
 * 多选用 ○/● 填充度双通道表达勾选态（非仅靠颜色）。
 */
function AskUserQuestionDialog({ request }: { request: AskUserQuestionRequestInfo }) {
  const resolvedRef = useRef(false);
  const questions = request.questions;

  // 当前题目索引
  const [qIndex, setQIndex] = useState(0);
  // 已收集答案：问题文本 → 答案串（多选以 ", " 连接）
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // 当前题的高亮项索引（含末尾"其他"项）
  const [cursor, setCursor] = useState(0);
  // 多选模式下当前题已勾选的选项 label 集合
  const [checked, setChecked] = useState<Set<number>>(new Set());
  // 是否处于"其他"自定义文本输入态
  const [editingOther, setEditingOther] = useState(false);
  const [otherText, setOtherText] = useState("");

  const current = questions[qIndex];
  // 末尾追加"其他"项：索引 = options.length
  const otherIndex = current.options.length;
  const totalRows = current.options.length + 1;
  const isMulti = !!current.multiSelect;

  const finish = (finalAnswers: Record<string, string>) => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    request.resolve({ decision: "answered", answers: finalAnswers });
  };

  // 记录一题答案并推进到下一题（或在最后一题时提交）
  const commitAnswer = (answer: string) => {
    const next = { ...answers, [current.question]: answer };
    setAnswers(next);
    if (qIndex < questions.length - 1) {
      setQIndex(qIndex + 1);
      setCursor(0);
      setChecked(new Set());
      setEditingOther(false);
      setOtherText("");
    } else {
      finish(next);
    }
  };

  useKeypress(KeypressPriority.Critical, (key) => {
    if (resolvedRef.current) return false;

    // ESC：整卷取消（文本输入态下先退出输入态，再次 ESC 才取消整卷）
    if (key.name === "escape") {
      if (editingOther) {
        setEditingOther(false);
        setOtherText("");
        return true;
      }
      resolvedRef.current = true;
      request.resolve({ decision: "cancelled" });
      return true;
    }

    // ── 文本输入态（选了"其他"）──
    if (editingOther) {
      if (key.name === "return" || key.name === "enter") {
        const text = otherText.trim();
        if (text.length === 0) return true; // 空输入不提交
        commitAnswer(text);
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
      return true; // 输入态吞掉其它按键
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

    // 多选：空格勾选 / 取消（"其他"项不参与勾选，须用 Enter 进入输入）
    if (isMulti && key.name === "space" && cursor < otherIndex) {
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
      return true;
    }

    if (key.name === "return" || key.name === "enter") {
      // 选中"其他" → 进入文本输入
      if (cursor === otherIndex) {
        setEditingOther(true);
        return true;
      }
      if (isMulti) {
        // 多选：Enter 确认本题已勾选项（若光标停在某项且未勾选，视为顺带勾选它）
        const sel = new Set(checked);
        if (sel.size === 0) sel.add(cursor);
        const labels = current.options
          .filter((_, i) => sel.has(i))
          .map((o) => o.label);
        if (labels.length === 0) return true;
        commitAnswer(labels.join(", "));
      } else {
        // 单选：直接提交当前项
        commitAnswer(current.options[cursor].label);
      }
      return true;
    }

    return false;
  });

  const accent = theme.ui.active;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      {/* 标题行：chip 标签 + 进度 */}
      <Box>
        <Text color={accent} bold>{BULLET} {current.header}</Text>
        {questions.length > 1 && (
          <Text color={theme.text.secondary}>  ({qIndex + 1}/{questions.length})</Text>
        )}
      </Box>
      <Box paddingLeft={2} marginTop={0}>
        <Text>{current.question}</Text>
      </Box>

      {/* 选项列表 */}
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        {current.options.map((opt, i) => {
          const isCursor = cursor === i && !editingOther;
          const isChecked = isMulti && checked.has(i);
          // 多选用填充度字形双通道表达勾选（○ 未选 / ● 已选）；单选用光标 BULLET
          const marker = isMulti
            ? (isChecked ? TODO_COMPLETED : TODO_PENDING)
            : (isCursor ? BULLET : " ");
          const markerColor = isChecked
            ? theme.status.success
            : isCursor
              ? accent
              : theme.text.secondary;
          const labelColor = isCursor ? accent : theme.text.primary;
          return (
            <Box key={i} flexDirection="column">
              <Box>
                <Box width={2} flexShrink={0}>
                  <Text color={markerColor}>{marker}</Text>
                </Box>
                <Text color={labelColor} bold={isCursor}>{opt.label}</Text>
              </Box>
              {isCursor && opt.description && (
                <Box paddingLeft={2}>
                  <Text color={theme.text.secondary}>{opt.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}

        {/* "其他"自定义输入项 */}
        <Box flexDirection="column">
          <Box>
            <Box width={2} flexShrink={0}>
              <Text color={cursor === otherIndex ? accent : theme.text.secondary}>
                {cursor === otherIndex && !editingOther ? BULLET : " "}
              </Text>
            </Box>
            <Text color={cursor === otherIndex ? accent : theme.text.secondary} bold={cursor === otherIndex}>
              其他…
            </Text>
          </Box>
          {editingOther && (
            <Box paddingLeft={2}>
              <Text color={accent}>{ARROW_PROMPT} </Text>
              <Text>{otherText}</Text>
              <Text color={accent}>{CURSOR}</Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* 操作提示行：随模式切换 */}
      <Box marginTop={1}>
        {editingOther ? (
          <Text color={theme.text.secondary}>输入自定义答案，Enter 确认，Esc 返回</Text>
        ) : isMulti ? (
          <Text color={theme.text.secondary}>↑↓ 移动 · Space 勾选 · Enter 确认本题 · Esc 取消</Text>
        ) : (
          <Text color={theme.text.secondary}>↑↓ 选择 · Enter 确认 · Esc 取消</Text>
        )}
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
