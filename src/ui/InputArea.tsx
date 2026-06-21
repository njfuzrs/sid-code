/**
 * 输入区域组件（InputPrompt）
 *
 * 集成：
 * - TextBuffer：多行编辑、visual 行映射、viewport 滚动
 * - useSlashCompletion：/ 命令补全
 * - useAtCompletion：@ 文件路径补全
 * - useReverseSearch：Ctrl+R 反向搜索历史
 * - useInputHistoryStore：输入历史持久化
 * - SuggestionsDisplay：补全列表 UI
 * - 输入语法高亮（/命令、@文件、!shell）
 *
 * 粘贴处理：
 * KeypressContext 的 bufferPaste 中间件已将 Bracketed Paste Mode 的
 * paste-start ... paste-end 序列合并为单个 name='paste' 事件，
 * InputArea 只需处理该事件即可。
 */

import React, { useCallback, useRef, useEffect, useState } from "react";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import useStdout from "../ink/_vendor/use-stdout.js";
import { getLogger } from "../debug/logger.ts";
import { theme } from "./semantic-colors.ts";
import { useKeypress, KeypressPriority } from "./contexts/KeypressContext.tsx";
import { useKeybindings } from "./contexts/KeybindingContext.tsx";
import { useUIState, useUIActions } from "./contexts/UIStateContext.tsx";
import { useExitConfirm } from "./hooks/useExitConfirm.ts";
import { useTextBuffer, getVisualLines, getCursorVisualPosition } from "./text-buffer.ts";
import { useSlashCompletion, type CommandInfo } from "./hooks/useSlashCompletion.ts";
import { useAtCompletion } from "./hooks/useAtCompletion.ts";
import { useReverseSearch } from "./hooks/useReverseSearch.ts";
import { useInputHistoryStore } from "./hooks/useInputHistoryStore.ts";
import { useShellCompletion } from "./hooks/useShellCompletion.ts";
import { consumePendingRestore } from "./pending-input.ts";
import {
  registerPaste,
  shouldPlaceholder,
  expandPastedRefs,
  clearPastes,
} from "./pasted-contents.ts";
import { SuggestionsDisplay, type Suggestion } from "./components/SuggestionsDisplay.tsx";
import { parseInputForHighlighting, renderHighlightedSegments } from "./utils/inputHighlight.tsx";
import { DEFAULT_TERM_WIDTH } from "./markdown.ts";
import { getAppConfig, shouldShowHint, markHintShown } from "../config/app-config.ts";
import { ARROW_PROMPT } from "./constants/figures.ts";

interface InputAreaProps {
  onSubmit: (text: string) => void;
  isLoading: boolean;
  commands: CommandInfo[];
  cwd: string;
  /** 流式中已排队待接续的输入条数（>0 时输入框上方提示） */
  queuedCount?: number;
  /** Shift+Tab 权限模式切换回调（可选） */
  onPermissionModeSwitch?: () => void;
  /** Ctrl+D（输入框为空时）请求退出的回调——由 App 传入 triggerQuit。 */
  onExitRequest?: () => void;
}

/**
 * 占位符渐进衰减：新用户显示完整引导（含 /help），用熟后（启动 ≥ 5 次）
 * 收敛为精简提示，不再重复打扰。对标 cc onboarding 提示衰减。
 */
function getPlaceholder(): string {
  const startups = getAppConfig().numStartups ?? 0;
  return startups < 5 ? "输入消息或 /help 查看命令…" : "输入消息…";
}
const PROMPT = "> ";
const SHELL_PROMPT = "! ";
/** InputArea 最大可见行数（超过时 viewport 滚动） */
const MAX_INPUT_LINES = 8;

/**
 * 清理粘贴文本：
 * - Tab → 2 空格
 * - 控制字符（\x00-\x1f 除 \t \r \n）→ 删除
 * - 保留换行（多行粘贴支持）
 */
const cleanPasteText = (raw: string): string =>
  raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

// ── 渲染辅助：带语法高亮的行内容 ──

/** 渲染第一行内容（带语法高亮，去掉 PROMPT 前缀后高亮） */
function renderFirstLineContent(lineText: string, promptLen: number): React.ReactNode {
  const content = lineText.slice(promptLen);
  if (!content) return null;
  const segments = parseInputForHighlighting(content);
  return <>{renderHighlightedSegments(segments)}</>;
}

// ── 组件 ──────────────────────────────────────────────────────────

export function InputArea({ onSubmit, isLoading, commands, cwd, queuedCount = 0, onPermissionModeSwitch, onExitRequest }: InputAreaProps) {
  const lastSubmittedRef = useRef<string>("");
  const log = getLogger();
  const prevLoadingRef = useRef(isLoading);
  const { stdout } = useStdout();
  const termWidth = stdout.columns || DEFAULT_TERM_WIDTH;
  const availableWidth = Math.max(10, termWidth - 4); // round 边框左右各 1 + paddingX=1 左右各 1

  // Shell 模式状态（! 前缀直接执行 shell 命令）
  const [shellModeActive, setShellModeActive] = useState(false);

  // 输入历史持久化
  const { history: persistedHistory, addEntry: addHistoryEntry } = useInputHistoryStore();

  // TextBuffer
  const tb = useTextBuffer({
    viewport: { height: MAX_INPUT_LINES, width: availableWidth - PROMPT.length },
  });

  // Ctrl+D 二次确认退出（仅输入框为空时;非空时 Ctrl+D 仍是删除光标后字符）。
  // 读 UIState 的 ctrlDPressedOnce 驱动 ExitWarning,onConfirm 调 App 传入的 triggerQuit。
  const { ctrlDPressedOnce } = useUIState();
  const { setCtrlDPressedOnce } = useUIActions();
  const { press: pressCtrlD, cancel: cancelCtrlDConfirm } = useExitConfirm({
    pressedOnce: ctrlDPressedOnce,
    setPressedOnce: setCtrlDPressedOnce,
    onConfirm: () => { onExitRequest?.(); },
  });

  // 挂载时消费早期输入缓冲（启动期间用户按键）
  const earlyInputConsumed = useRef(false);
  useEffect(() => {
    if (earlyInputConsumed.current) return;
    earlyInputConsumed.current = true;
    import("./early-input.ts").then(({ consumeEarlyInput }) => {
      const earlyText = consumeEarlyInput();
      if (earlyText) {
        tb.setText(earlyText);
      }
    }).catch(() => { /* 静默失败 */ });
  }, []);

  // 反向搜索
  const reverseSearch = useReverseSearch({ history: persistedHistory });

  // K5：和弦状态机（Ctrl+K → Ctrl+C 等两键序列）。单键仍走各 handler 内的 matchBinding，
  // 这里只处理多键和弦，避免双触发。
  // K1：matchBinding 让 InputArea 的可配置动作键（反搜 / 权限模式）走运行时键位表，
  // 用户在 keybindings.json 里改这些 action 即可生效，不再硬编码。
  const { chordMachine, matchBinding } = useKeybindings();
  const [chordPending, setChordPending] = useState(false);

  /** 执行一个和弦 action（示例:编辑器级操作,作用于当前输入框）。 */
  const runChordAction = useCallback((action: string): boolean => {
    const row = tb.state.cursorRow;
    const line = tb.state.lines[row] ?? "";
    switch (action) {
      case "editor:uppercase": {
        // 整行转大写,光标列保持
        const col = tb.state.cursorCol;
        tb.moveCursor("home");
        tb.killLine();
        tb.insert(line.toUpperCase());
        tb.moveCursor("home");
        for (let i = 0; i < col; i++) tb.moveCursor("right");
        return true;
      }
      case "editor:copyLine": {
        // 复制当前行到行尾(在输入框内即"重复一行"——无系统剪贴板时的可见行为)
        tb.moveCursor("end");
        tb.insert("\n" + line);
        return true;
      }
      default:
        return false;
    }
  }, [tb]);

  // K5：和弦前缀超时(1.5s 未按第二键则取消，丢弃前缀)。
  useEffect(() => {
    if (!chordPending) return;
    const timer = setTimeout(() => {
      chordMachine.expire();
      setChordPending(false);
    }, 1500);
    return () => clearTimeout(timer);
  }, [chordPending, chordMachine]);

  // 补全状态
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const completionModeRef = useRef<"none" | "slash" | "at" | "shell">("none");

  // 当前行文本和光标位置
  const currentLine = tb.state.lines[tb.state.cursorRow] ?? "";
  const firstLine = tb.state.lines[0] ?? "";

  // / 命令补全
  const setSlashSuggestions = useCallback((items: Suggestion[]) => {
    if (items.length > 0) {
      completionModeRef.current = "slash";
      setSuggestions(items);
      setActiveIndex(0);
    } else if (completionModeRef.current === "slash") {
      completionModeRef.current = "none";
      setSuggestions([]);
      setActiveIndex(0);
    }
  }, []);

  useSlashCompletion({
    text: firstLine,
    cursorCol: tb.state.cursorRow === 0 ? tb.state.cursorCol : firstLine.length,
    commands,
    setSuggestions: setSlashSuggestions,
  });

  // @ 文件补全
  const setAtSuggestions = useCallback((items: Suggestion[]) => {
    if (items.length > 0) {
      completionModeRef.current = "at";
      setSuggestions(items);
      setActiveIndex(0);
    } else if (completionModeRef.current === "at") {
      completionModeRef.current = "none";
      setSuggestions([]);
      setActiveIndex(0);
    }
  }, []);

  useAtCompletion({
    cursorCol: tb.state.cursorCol,
    currentLine,
    cwd,
    setSuggestions: setAtSuggestions,
  });

  // ! Shell 命令补全
  const setShellSuggestions = useCallback((items: Suggestion[]) => {
    if (items.length > 0) {
      completionModeRef.current = "shell";
      setSuggestions(items);
      setActiveIndex(0);
    } else if (completionModeRef.current === "shell") {
      completionModeRef.current = "none";
      setSuggestions([]);
      setActiveIndex(0);
    }
  }, []);

  useShellCompletion({
    text: firstLine,
    cursorCol: tb.state.cursorRow === 0 ? tb.state.cursorCol : firstLine.length,
    shellMode: shellModeActive,
    setSuggestions: setShellSuggestions,
  });

  const hasSuggestions = suggestions.length > 0;

  // 应用补全：替换触发文本为选中的补全值
  const applyCompletion = useCallback((suggestion: Suggestion) => {
    const mode = completionModeRef.current;
    if (mode === "slash" || mode === "shell") {
      // 替换整行为命令（shell 模式保留 ! 前缀）
      tb.moveCursor("home");
      tb.killLine();
      if (mode === "shell") {
        tb.insert("!" + suggestion.value);
      } else {
        tb.insert(suggestion.value);
      }
    } else if (mode === "at") {
      // 找到 @ 的位置，替换 @ 后的 pattern
      const line = tb.state.lines[tb.state.cursorRow];
      let atPos = -1;
      for (let i = tb.state.cursorCol - 1; i >= 0; i--) {
        if (line[i] === "@") { atPos = i; break; }
        if (line[i] === " ") break;
      }
      if (atPos >= 0) {
        // 删除 @ 后的 pattern
        const deleteCount = tb.state.cursorCol - atPos - 1;
        for (let i = 0; i < deleteCount; i++) tb.deleteBackward();
        tb.insert(suggestion.value);
      }
    }
    setSuggestions([]);
    setActiveIndex(0);
    completionModeRef.current = "none";
  }, [tb]);

  useEffect(() => {
    if (prevLoadingRef.current !== isLoading) {
      log.debug("UI:INPUT", `isLoading 变化: ${prevLoadingRef.current} → ${isLoading}`);
      const wasLoading = prevLoadingRef.current;
      prevLoadingRef.current = isLoading;
      // A4：loading→idle 边沿(本轮结束)消费"待回填输入"。
      // 仅当用户 ESC 取消且通过守卫时 app 层才会 markForRestore,故此处拿到非 null 即应回填。
      // 守卫 tb.isEmpty():不覆盖用户在 loading 期间已敲入的新内容（对标 cc 的 inputValueRef==='' 守卫）。
      if (wasLoading && !isLoading) {
        const restore = consumePendingRestore();
        if (restore && tb.isEmpty()) {
          tb.setText(restore.text);
          if (restore.shellMode) setShellModeActive(true);
          log.info("UI:INPUT", "已自动恢复被取消的输入");
        }
      }
    }
  }, [isLoading, tb]);

  const handleSubmit = useCallback(() => {
    const raw = tb.submit();
    if (!raw) return;

    // IN3：把粘贴占位引用 [粘贴 #N ...] 还原为真实内容后再提交，随后清空登记表。
    const text = expandPastedRefs(raw);
    clearPastes();

    if (text === lastSubmittedRef.current) {
      log.warn("UI:INPUT", `重复内容被拦截: "${text.slice(0, 50)}"`);
      return;
    }

    // 持久化历史（存还原后的真实内容）
    addHistoryEntry(text);

    // Shell 模式：! 前缀直接执行 shell 命令
    if (shellModeActive && text.startsWith("!")) {
      const shellCmd = text.slice(1).trim();
      if (shellCmd) {
        log.info("UI:INPUT", `Shell 模式执行: "${shellCmd}"`);
        onSubmit(`/bash ${shellCmd}`);
      }
      setShellModeActive(false);
      lastSubmittedRef.current = text;
      setTimeout(() => { lastSubmittedRef.current = ""; }, 1000);
      return;
    }

    log.info("UI:INPUT", `提交输入: "${text.slice(0, 100)}"${text.length > 100 ? "..." : ""}`);
    lastSubmittedRef.current = text;
    onSubmit(text);

    setTimeout(() => { lastSubmittedRef.current = ""; }, 1000);
  }, [tb, onSubmit, shellModeActive, addHistoryEntry]);

  // ── 核心键盘处理 ──────────────────────────────────────────────────
  useKeypress(KeypressPriority.Normal, (key) => {
    // 流式响应中仍允许编辑输入：提交走 onSubmit → App 层入队接续（多条输入排队）。
    // 中断键（esc）由 App 的 High 优先级处理器先行拦截，不会落到这里。

    // ── K5 和弦处理（优先于单键，含 Ctrl+K 前缀）──
    // 反向搜索激活时不走和弦（搜索框内 Ctrl+K 无意义）。
    if (!reverseSearch.state.active) {
      const chord = chordMachine.process(key);
      if (chord.type === "chord_started") {
        setChordPending(true);
        return true; // 吞掉前缀键，等待第二键
      }
      if (chord.type === "match") {
        setChordPending(false);
        return runChordAction(chord.action);
      }
      if (chord.type === "cancel") {
        // 第二键不匹配：取消和弦，让该键继续走正常分发（落到下方 handler）。
        setChordPending(false);
        // 不 return，继续往下处理 replayKey（即当前 key）
      }
    }

    // Ctrl+D 退出确认态下，任意「非 Ctrl+D」按键 → 取消退出意图（对标 ExitWarning「或继续输入以取消」）。
    // 放在主分发之前；只取消、不拦截，让该键继续走正常处理。
    if (ctrlDPressedOnce && !(key.ctrl && key.name === "d")) {
      cancelCtrlDConfirm();
    }

    // ── 反向搜索模式 ──
    if (reverseSearch.state.active) {
      if (key.name === "escape") {
        reverseSearch.deactivate();
        return true;
      }
      if (key.name === "enter") {
        // 选中当前匹配项
        const match = reverseSearch.getMatch();
        if (match) {
          tb.setText(match);
        }
        reverseSearch.deactivate();
        return true;
      }
      if (matchBinding(key)?.action === "input:reverseSearch") {
        // 再次按反搜键：继续搜索下一个（跟随用户配置的同一键）
        reverseSearch.searchNext();
        return true;
      }
      // ↑/↓ 在反搜模式下遍历匹配项（↑ 更早，↓ 更新），不插入换行
      if (key.name === "up") {
        reverseSearch.searchNext();
        return true;
      }
      if (key.name === "down") {
        reverseSearch.searchPrev();
        return true;
      }
      if (key.name === "backspace") {
        reverseSearch.deleteQuery();
        return true;
      }
      if (key.insertable && !key.ctrl && !key.alt) {
        reverseSearch.appendQuery(key.sequence);
        return true;
      }
      return false;
    }

    // 激活反向搜索（K1：键位查表，默认 Ctrl+R，用户可在 keybindings.json 改）
    if (matchBinding(key)?.action === "input:reverseSearch") {
      reverseSearch.activate();
      return true;
    }

    // Shell 模式切换：! 在行首时进入 Shell 模式
    if (key.insertable && key.sequence === "!" && tb.isEmpty()) {
      setShellModeActive(true);
      tb.insert("!");
      return true;
    }

    // 退出 Shell 模式：删除 ! 后退出
    if (shellModeActive && key.name === "backspace" && tb.state.lines[0] === "!") {
      tb.deleteBackward();
      setShellModeActive(false);
      return true;
    }

    // ── 粘贴事件 ──
    // 权限模式切换（K1：键位查表，默认 Shift+Tab，用户可在 keybindings.json 改）
    if (matchBinding(key)?.action === "input:permMode") {
      if (onPermissionModeSwitch) {
        onPermissionModeSwitch();
      }
      return true;
    }

    if (key.name === "paste") {
      const cleaned = cleanPasteText(key.sequence);
      if (cleaned.length > 0) {
        // IN3：大块粘贴登记元数据并插入精简占位引用，提交时还原；
        // 小块粘贴直接插入，保持顺手。
        if (shouldPlaceholder(cleaned)) {
          const ref = registerPaste(cleaned, "text");
          log.debug("UI:INPUT", `粘贴(占位): ${cleaned.length} 字符 → ${ref}`);
          tb.insert(ref);
        } else {
          log.debug("UI:INPUT", `粘贴: ${cleaned.length} 字符`);
          tb.insert(cleaned);
        }
      }
      return true;
    }

    // ── 补全列表交互 ──
    if (hasSuggestions) {
      if (key.name === "escape") {
        setSuggestions([]);
        setActiveIndex(0);
        completionModeRef.current = "none";
        return true;
      }
      if (key.name === "tab" || (key.name === "enter" && !key.shift)) {
        applyCompletion(suggestions[activeIndex]);
        return true;
      }
      if (key.name === "up" && !key.shift) {
        setActiveIndex(i => (i - 1 + suggestions.length) % suggestions.length);
        return true;
      }
      if (key.name === "down" && !key.shift) {
        setActiveIndex(i => (i + 1) % suggestions.length);
        return true;
      }
    }

    // ── 普通键盘输入 ──
    if (key.name === "enter" && !key.shift) { handleSubmit(); return true; }

    // 多行输入：Shift+Enter 插入真正的换行
    if (key.name === "enter" && key.shift) { tb.insert("\n"); return true; }

    // 历史记录：
    // - shell 模式(类 REPL):光标在首行↑ / 末行↓ 时翻历史,否则在多行命令内移光标
    // - 普通模式:仅单行时 ↑↓ 触发历史,多行时移光标
    if (key.name === "up" && !key.shift) {
      const atFirstLine = tb.state.cursorRow === 0;
      const wantHistory = shellModeActive ? atFirstLine : tb.state.lines.length === 1;
      if (wantHistory) {
        tb.historyUp();
      } else {
        tb.moveCursor("up");
      }
      return true;
    }
    if (key.name === "down" && !key.shift) {
      const atLastLine = tb.state.cursorRow === tb.state.lines.length - 1;
      const wantHistory = shellModeActive ? atLastLine : tb.state.lines.length === 1;
      if (wantHistory) {
        tb.historyDown();
      } else {
        tb.moveCursor("down");
      }
      return true;
    }

    if (key.name === "left" && !key.alt) { tb.moveCursor("left"); return true; }
    if (key.name === "right" && !key.alt) { tb.moveCursor("right"); return true; }
    if (key.name === "left" && key.alt) { tb.moveCursor("wordLeft"); return true; }
    if (key.name === "right" && key.alt) { tb.moveCursor("wordRight"); return true; }
    if (key.name === "backspace" || key.name === "delete") { tb.deleteBackward(); return true; }
    if (key.name === "home") { tb.moveCursor("home"); return true; }
    if (key.name === "end") { tb.moveCursor("end"); return true; }

    // Emacs 快捷键
    if (key.ctrl) {
      if (key.name === "a") { tb.moveCursor("home"); return true; }
      if (key.name === "e") { tb.moveCursor("end"); return true; }
      if (key.name === "k") { tb.killLine(); return true; }
      if (key.name === "u") { tb.killToStart(); return true; }
      if (key.name === "d") {
        // Ctrl+D：输入框为空 → 二次确认退出（终端 EOF 约定）；非空 → 删除光标后字符。
        if (tb.isEmpty()) {
          pressCtrlD();
        } else {
          tb.deleteForward();
        }
        return true;
      }
    }

    // 可插入字符
    if (key.insertable && !key.ctrl && !key.alt && !key.cmd) {
      tb.insert(key.sequence);
      return true;
    }

    return false;
  });

  // ── 渲染 ──────────────────────────────────────────────────────────

  // 反向搜索模式 UI
  if (reverseSearch.state.active) {
    const { query, match } = reverseSearch.state;
    return (
      <Box
        flexDirection="column"
        width={termWidth}
        borderStyle="round"
        borderColor={theme.status.warning}
        paddingX={1}
      >
        <Box>
          <Text color={theme.status.warning}>反向搜索: </Text>
          <Text>{query}</Text>
          <Text inverse> </Text>
        </Box>
        {match ? (
          <Box>
            <Text dimColor>匹配: </Text>
            <Text>{match.length > termWidth - 10 ? match.slice(0, termWidth - 13) + "..." : match}</Text>
          </Box>
        ) : query ? (
          <Box>
            <Text color={theme.status.error}>无匹配</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // 流式响应中不再阻塞输入：继续走下方可编辑渲染分支，
  // 用户此时提交的输入会被 App 层入队，当前轮结束后自动接续。

  const isEmpty = tb.isEmpty();

  // 队列提示渐进衰减（交互铁律 C）：流式中排队接续是固定行为，完整解释文案
  // （"将在当前响应结束后依次发送"）教过几次就该收敛，否则每次排队都唠叨。
  // 显示满 QUEUE_HINT_MAX_SHOWS 次后收敛为精简形态。计数在 0→>0 上升沿 +1（每次排队记一次，
  // 而非每帧），用 ref 防重复。对标 cc 的 *HintCount < N 衰减。
  const QUEUE_HINT_KEY = "queueContinuation";
  const QUEUE_HINT_MAX_SHOWS = 3;
  const queueHintFullRef = useRef(shouldShowHint(QUEUE_HINT_KEY, QUEUE_HINT_MAX_SHOWS));
  const prevQueuedCountRef = useRef(0);
  useEffect(() => {
    // 0 → >0 上升沿：本次排队出现，记一次显示次数并锁定本轮形态（避免计数过程中文案抖动）。
    if (prevQueuedCountRef.current === 0 && queuedCount > 0) {
      queueHintFullRef.current = shouldShowHint(QUEUE_HINT_KEY, QUEUE_HINT_MAX_SHOWS);
      if (queueHintFullRef.current) markHintShown(QUEUE_HINT_KEY);
    }
    prevQueuedCountRef.current = queuedCount;
  }, [queuedCount]);

  // 队列提示：流式中已排队 N 条输入待接续时，在输入框上方一行提示。
  const queueHint = queuedCount > 0 ? (
    <Box paddingLeft={1}>
      <Text color={theme.status.warning}>
        {queueHintFullRef.current
          ? `${ARROW_PROMPT} 已排队 ${queuedCount} 条输入，将在当前响应结束后依次发送`
          : `${ARROW_PROMPT} 已排队 ${queuedCount} 条`}
      </Text>
    </Box>
  ) : null;

  if (isEmpty) {
    const currentPrompt = shellModeActive ? SHELL_PROMPT : PROMPT;
    const currentPlaceholder = shellModeActive ? "输入 shell 命令…" : getPlaceholder();

    return (
      <Box flexDirection="column" width={termWidth}>
        {queueHint}
        <Box
          width={termWidth}
          borderStyle="round"
          borderColor={theme.ui.active}
          paddingX={1}
        >
          <Text>
            <Text color={theme.ui.active} bold>{currentPrompt}</Text>
            <Text inverse> </Text>
            <Text dimColor>{currentPlaceholder}</Text>
          </Text>
        </Box>
      </Box>
    );
  }

  // 构建带 PROMPT 前缀的显示行
  const currentPrompt = shellModeActive ? SHELL_PROMPT : PROMPT;
  const displayLines: string[] = tb.state.lines.map((line, i) =>
    i === 0 ? currentPrompt + line : "  " + line,
  );

  // 计算 visual 行
  const visualLines = getVisualLines(displayLines, availableWidth);

  // 光标在 display 坐标中的位置
  const displayCursorCol = tb.state.cursorRow === 0
    ? PROMPT.length + tb.state.cursorCol
    : 2 + tb.state.cursorCol;
  const cursorPos = getCursorVisualPosition(displayLines, tb.state.cursorRow, displayCursorCol, availableWidth);

  // Viewport 滚动
  const totalVisualLines = visualLines.length;
  let viewStart = 0;
  if (totalVisualLines > MAX_INPUT_LINES) {
    viewStart = Math.max(0, Math.min(
      cursorPos.visualRow - Math.floor(MAX_INPUT_LINES / 2),
      totalVisualLines - MAX_INPUT_LINES,
    ));
  }
  const viewEnd = Math.min(viewStart + MAX_INPUT_LINES, totalVisualLines);
  const visibleLines = visualLines.slice(viewStart, viewEnd);

  const renderedLines = visibleLines.map((vl, i) => {
    const visualIdx = viewStart + i;
    const lineText = vl.text;

    if (visualIdx !== cursorPos.visualRow) {
      // 非光标行
      if (vl.logicalRow === 0 && vl.start === 0) {
        return (
          <Text key={`vl-${visualIdx}`}>
            <Text color={theme.ui.active} bold>{currentPrompt}</Text>
            {renderFirstLineContent(lineText, currentPrompt.length)}
          </Text>
        );
      }
      return <Text key={`vl-${visualIdx}`}>{lineText}</Text>;
    }

    // 光标行：在 cursorCol 处插入 inverse 字符
    const colInLine = cursorPos.visualCol;
    const before = lineText.slice(0, colInLine);
    const cursorChar = lineText[colInLine] || " ";
    const after = colInLine < lineText.length ? lineText.slice(colInLine + 1) : "";

    if (vl.logicalRow === 0 && vl.start === 0) {
      // 第一行带语法高亮 + 光标
      const contentBefore = before.slice(currentPrompt.length);
      const contentAfter = after;
      const beforeSegments = parseInputForHighlighting(contentBefore);
      const afterSegments = parseInputForHighlighting(contentAfter);

      return (
        <Text key={`vl-${visualIdx}`}>
          <Text color={theme.ui.active} bold>{currentPrompt}</Text>
          {renderHighlightedSegments(beforeSegments)}
          <Text inverse>{cursorChar}</Text>
          {renderHighlightedSegments(afterSegments)}
        </Text>
      );
    }

    return (
      <Text key={`vl-${visualIdx}`}>
        {before}
        <Text inverse>{cursorChar}</Text>
        {after}
      </Text>
    );
  });

  return (
    <Box flexDirection="column">
      {queueHint}
      {hasSuggestions && (
        <SuggestionsDisplay
          suggestions={suggestions}
          activeIndex={activeIndex}
          width={termWidth}
        />
      )}
      <Box
        width={termWidth}
        borderStyle="round"
        borderColor={theme.ui.active}
        paddingX={1}
        flexDirection="column"
      >
        {renderedLines}
      </Box>
    </Box>
  );
}
