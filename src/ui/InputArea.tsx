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
import { useUIState, useUIActions, TransientMessageType } from "./contexts/UIStateContext.tsx";
import { useExitConfirm } from "./hooks/useExitConfirm.ts";
import { useTextBuffer, getVisualLines, getCursorVisualPosition } from "./text-buffer.ts";
import { useSlashCompletion, type CommandInfo } from "./hooks/useSlashCompletion.ts";
import { useAtCompletion } from "./hooks/useAtCompletion.ts";
import { useSettings } from "./contexts/SettingsContext.tsx";
import { reduceVimEngine } from "./vim/transitions.ts";
import {
  INITIAL_ENGINE_STATE,
  type VimEngineState,
  type VimMode,
  type VimKey,
  type VimBuffer,
} from "./vim/types.ts";
import { useReverseSearch } from "./hooks/useReverseSearch.ts";
import { useInputHistoryStore } from "./hooks/useInputHistoryStore.ts";
import { useShellCompletion } from "./hooks/useShellCompletion.ts";
import { consumePendingRestore } from "./pending-input.ts";
import { editInExternalEditor } from "./utils/external-editor.ts";
import {
  registerPaste,
  shouldPlaceholder,
  expandPastedRefs,
  clearPastes,
} from "./pasted-contents.ts";
import { readClipboardImageToFile, detectDroppedImagePath } from "./utils/clipboard-image.ts";
import { SuggestionsDisplay, type Suggestion } from "./components/SuggestionsDisplay.tsx";
import { parseInputForHighlighting, renderHighlightedSegments } from "./utils/inputHighlight.tsx";
import { DEFAULT_TERM_WIDTH } from "./markdown.ts";
import { getAppConfig, shouldShowHint, markHintShown } from "../config/app-config.ts";
import { ARROW_PROMPT } from "./constants/figures.ts";
import { mixToContrast } from "./themes/color-utils.ts";

interface InputAreaProps {
  /**
   * 提交输入。P1-G6：第二参为排队优先级（对齐 CC now>next>later）——
   * 省略/`"next"` 为默认排队；`"now"` 插队最先发；`"later"` 排在所有 next 之后。
   * 空闲态（非流式）时优先级无意义，App 层直送不入队。
   */
  onSubmit: (text: string, priority?: "now" | "next" | "later") => void;
  /** 直接执行 Shell 命令，不经过斜杠命令路由。 */
  onShellCommand: (command: string) => void;
  isLoading: boolean;
  commands: CommandInfo[];
  cwd: string;
  /** 流式中已排队待接续的输入条数（>0 时输入框上方提示） */
  queuedCount?: number;
  /** P1-G6：按优先级分组的排队条数（提示分组展示用）。未传时退化为只用 queuedCount 总数。 */
  queuedByPriority?: { now: number; next: number; later: number };
  /** P2-G6：↑ 弹回编辑——空输入框按 ↑ 时取队尾排队输入回输入框继续编辑。返回 null 表示队列空。 */
  onPopQueuedForEdit?: () => string | null;
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
 * 输入框边框：只画上下两条细横线，不画左右竖线。
 *
 * 终端里的"框"就是文本。左右竖线和输入内容同处一行，用户拖选多行输入去复制时，
 * `│ 内容 │` 的竖线会被一起选中，粘出去满是无关线框（长文本换行越多越脏）。
 * 上下横线独占自己的行，横向拖选内容时选不到，复制干净。
 *
 * 字形用 `single` 的 `─`（细）而非 `bold` 的 `━`（粗）：横线通宽跑满终端，
 * 粗字形铺满一整行太抢眼，把视觉重心从输入内容上夺走了。
 * 颜色见 `inputBorderColor()`。
 */
const INPUT_BORDER_PROPS = {
  borderStyle: "single",
  borderLeft: false,
  borderRight: false,
} as const;

/**
 * 边框相对背景的目标对比度。装饰性通宽横线的取值窗口很窄：
 * - < ~2.0：糊进背景，框不住（实测 `border.default` 暗色下仅 1.80）；
 * - > ~3.5：开始与输入正文抢视觉重心（旧版 `text.primary` 高达 11.34，比它框住的
 *   内容和点睛的 `>` 都更亮，视觉层次整个反了——这正是"边框很显眼"的根因）。
 * 2.6 落在窗口中段：轮廓清晰可见，但明确退在正文之后。
 */
const BORDER_TARGET_CONTRAST = 2.6;

/**
 * 输入框边框色 = 品牌蓝（`>` 提示符同色相）混向背景，压到 {@link BORDER_TARGET_CONTRAST}。
 *
 * **和 `>` 统一的是色相，不是色值**：提示符 `ui.active` 满强度点睛（暗色下对比度 7.79），
 * 边框取同一色相的弱化档（~2.6）当结构线。同族递进（L1 元原则①：同一色相靠明度表达层次），
 * 底部两条横线与 `>` 读起来是一套东西，而边框不与内容争重心。
 *
 * 必须是函数而非模块级常量：`theme` 是 themeManager 的惰性代理（`semantic-colors.ts` 用
 * getter 转发），模块级 `const` 会在 import 时把值定死，`/theme` 切换暗亮后边框仍是旧色。
 * （`mixToContrast` 内部有缓存，每帧调用不重复求解。）
 */
const inputBorderColor = () =>
  mixToContrast(theme.ui.active, theme.background.primary, BORDER_TARGET_CONTRAST);

/**
 * 特殊模式（反向搜索 / shell）的边框色：同样弱化到结构层，但保留模式色相。
 *
 * 模式色承载语义（黄 = 搜索中、非常态），所以走 status.warning 而非品牌蓝；
 * 但它仍是边框，同样压到 {@link BORDER_TARGET_CONTRAST}——模式信号靠框内的
 * "反向搜索:" 文字满强度传达，不靠通宽横线嚷嚷。
 */
const modeBorderColor = (color: string) =>
  mixToContrast(color, theme.background.primary, BORDER_TARGET_CONTRAST);

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

export function InputArea({ onSubmit, onShellCommand, isLoading, commands, cwd, queuedCount = 0, queuedByPriority, onPopQueuedForEdit, onPermissionModeSwitch, onExitRequest }: InputAreaProps) {
  const lastSubmittedRef = useRef<string>("");
  const externalEditingRef = useRef(false); // Ctrl+G 外部编辑防重入
  const log = getLogger();
  const prevLoadingRef = useRef(isLoading);
  const { stdout } = useStdout();
  const termWidth = stdout.columns || DEFAULT_TERM_WIDTH;
  // 无左右边框（INPUT_BORDER_PROPS），可用宽度只扣 paddingX=1 左右各 1。
  const availableWidth = Math.max(10, termWidth - 2);

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
  const { setCtrlDPressedOnce, showTransientMessage } = useUIActions();
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

  // ── Vim 输入模式（P2-2 完整引擎）──
  // vimMode 来自 SettingsContext（/vim 命令热更新此值）；关闭时引擎完全旁路，保持原生输入行为。
  // vim 运行态（mode + pending + visualAnchor）用 ref 存：按键回调里需读最新值且不应触发额外重渲，
  // 只有 mode 变化需要重渲（光标样式/模式栏变化）才同步到 state。
  const { vimMode } = useSettings();
  const vimStateRef = useRef<VimEngineState>(INITIAL_ENGINE_STATE);
  const [vimModeLabel, setVimModeLabel] = useState<VimMode>("normal");

  /**
   * Vim 拦截器：vimMode 开启时最先处理按键。返回 true 表示已消费（阻断后续普通分发）。
   * 关闭时直接返回 false，零影响原有输入路径。
   *
   * 引擎在 {lines, cursor} 缓冲快照上求值，产出新缓冲后用 tb.vimSetBuffer 原子写回——
   * motion/operator/text-object/count 全部在纯函数引擎里完成，InputArea 只做快照进/出。
   * INSERT 模式引擎不消费普通字符（返回 consumed=false），键透传给原生 readline 编辑逻辑，
   * 故插入、退格、补全、历史等既有行为在 INSERT 下原样保留。
   */
  const handleVimKey = useCallback((key: VimKey): boolean => {
    if (!vimMode) return false;
    const prev = vimStateRef.current;
    const bufBefore: VimBuffer = {
      lines: tb.state.lines,
      cursorRow: tb.state.cursorRow,
      cursorCol: tb.state.cursorCol,
    };
    const r = reduceVimEngine(bufBefore, prev, key);
    vimStateRef.current = r.state;
    if (r.state.mode !== prev.mode) setVimModeLabel(r.state.mode);
    // 缓冲有变化才写回（避免纯移动/无操作触发多余 dispatch）。
    const changed =
      r.buffer.lines !== bufBefore.lines ||
      r.buffer.cursorRow !== bufBefore.cursorRow ||
      r.buffer.cursorCol !== bufBefore.cursorCol;
    if (changed) {
      tb.vimSetBuffer(r.buffer.lines, r.buffer.cursorRow, r.buffer.cursorCol);
    }
    return r.consumed;
  }, [vimMode, tb]);

  // vimMode 开启时从 normal 模式起步；关闭时复位内部态，避免下次开启残留 insert/待决前缀。
  useEffect(() => {
    vimStateRef.current = INITIAL_ENGINE_STATE;
    setVimModeLabel("normal");
  }, [vimMode]);

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

  // 补全状态（合并为单一对象，保证原子更新，防止快速连键时 suggestions/activeIndex/mode 不同步）
  type CompletionMode = "none" | "slash" | "at" | "shell";
  interface CompletionState {
    suggestions: Suggestion[];
    activeIndex: number;
    mode: CompletionMode;
  }
  const [completion, setCompletion] = useState<CompletionState>({
    suggestions: [], activeIndex: 0, mode: "none",
  });
  // 兼容层：解构出旧变量名供渲染和交互使用
  const { suggestions, activeIndex } = completion;
  const completionMode = completion.mode;

  // 当前行文本和光标位置
  const currentLine = tb.state.lines[tb.state.cursorRow] ?? "";
  const firstLine = tb.state.lines[0] ?? "";

  // / 命令补全
  const setSlashSuggestions = useCallback((items: Suggestion[]) => {
    setCompletion(prev => {
      if (items.length > 0) {
        return { suggestions: items, activeIndex: 0, mode: "slash" };
      } else if (prev.mode === "slash") {
        return { suggestions: [], activeIndex: 0, mode: "none" };
      }
      return prev;
    });
  }, []);

  useSlashCompletion({
    text: firstLine,
    cursorCol: tb.state.cursorRow === 0 ? tb.state.cursorCol : firstLine.length,
    commands,
    setSuggestions: setSlashSuggestions,
  });

  // @ 文件补全
  const setAtSuggestions = useCallback((items: Suggestion[]) => {
    setCompletion(prev => {
      if (items.length > 0) {
        return { suggestions: items, activeIndex: 0, mode: "at" };
      } else if (prev.mode === "at") {
        return { suggestions: [], activeIndex: 0, mode: "none" };
      }
      return prev;
    });
  }, []);

  useAtCompletion({
    cursorCol: tb.state.cursorCol,
    currentLine,
    cwd,
    setSuggestions: setAtSuggestions,
  });

  // ! Shell 命令补全
  const setShellSuggestions = useCallback((items: Suggestion[]) => {
    setCompletion(prev => {
      if (items.length > 0) {
        return { suggestions: items, activeIndex: 0, mode: "shell" };
      } else if (prev.mode === "shell") {
        return { suggestions: [], activeIndex: 0, mode: "none" };
      }
      return prev;
    });
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
    const mode = completionMode;
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
    setCompletion({ suggestions: [], activeIndex: 0, mode: "none" });
  }, [tb, completionMode]);

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

  // P2-6/P2-7 共用：把图片文件路径以 @<path> 引用插入输入框，走 Read 工具 vision 管道。
  // 路径含空格时用引号包裹，确保 @ 引用解析与 shell 补全不被空格截断。
  const insertImageRef = useCallback((imgPath: string) => {
    const ref = /\s/.test(imgPath) ? `@"${imgPath}" ` : `@${imgPath} `;
    tb.insert(ref);
  }, [tb]);

  // P2-6：尝试读剪贴板图片 → 临时文件 → 插入 @ 引用。成功给 hint，失败给 warning（剪贴板无图/无工具）。
  const tryInsertClipboardImage = useCallback((): boolean => {
    // 用真实时钟命名临时文件（本组件运行于 node/浏览器运行时，非 workflow 沙箱，Date.now 可用）。
    const imgPath = readClipboardImageToFile(Date.now());
    if (imgPath) {
      insertImageRef(imgPath);
      log.info("UI:INPUT", `剪贴板图片已插入: ${imgPath}`);
      showTransientMessage("已粘贴剪贴板图片", TransientMessageType.Hint);
      return true;
    }
    // 剪贴板无图片或系统无读取工具——给一次轻提示，不打断输入。
    showTransientMessage("剪贴板无图片（或缺 pngpaste/xclip/wl-paste）", TransientMessageType.Warning);
    return false;
  }, [insertImageRef, showTransientMessage]);

  /**
   * 提交当前输入。P1-G6：priority 透传给 App 层的排队器——
   * 裸 Enter 走默认（next），Alt+N → now（插队），Alt+L → later（延后）。
   * shell 模式（`!` 前缀）走直送 /bash，优先级对其无意义（不排队），忽略。
   */
  const handleSubmit = useCallback((priority?: "now" | "next" | "later") => {
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
        onShellCommand(shellCmd);
      }
      setShellModeActive(false);
      lastSubmittedRef.current = text;
      setTimeout(() => { lastSubmittedRef.current = ""; }, 1000);
      return;
    }

    log.info(
      "UI:INPUT",
      `提交输入${priority && priority !== "next" ? `（${priority}）` : ""}: `
        + `"${text.slice(0, 100)}"${text.length > 100 ? "..." : ""}`,
    );
    lastSubmittedRef.current = text;
    onSubmit(text, priority);

    setTimeout(() => { lastSubmittedRef.current = ""; }, 1000);
  }, [tb, onSubmit, onShellCommand, shellModeActive, addHistoryEntry]);

  // 从补全列表直接提交一条命令文本（无需经过 tb.submit()——避免"插入后同帧提交"读到
  // reducer 旧 state）。仅用于「无参命令回车直接执行」路径：清空输入框 + 走历史/去重 + 提交。
  const submitCommandText = useCallback((commandText: string) => {
    tb.setText("");
    setShellModeActive(false);
    if (commandText === lastSubmittedRef.current) {
      log.warn("UI:INPUT", `重复内容被拦截: "${commandText.slice(0, 50)}"`);
      return;
    }
    addHistoryEntry(commandText);
    log.info("UI:INPUT", `补全列表直接执行命令: "${commandText}"`);
    lastSubmittedRef.current = commandText;
    onSubmit(commandText);
    setTimeout(() => { lastSubmittedRef.current = ""; }, 1000);
  }, [tb, onSubmit, addHistoryEntry]);

  // ── 核心键盘处理 ──────────────────────────────────────────────────
  useKeypress(KeypressPriority.Normal, (key) => {
    // 流式响应中仍允许编辑输入：提交走 onSubmit → App 层入队接续（多条输入排队）。
    // 中断键（esc）由 App 的 High 优先级处理器先行拦截，不会落到这里。

    // ── Vim 拦截（vimMode 开启时最先处理）──
    // normal 模式下 hjkl/x/dd 等被状态机消费并阻断普通分发；insert 模式仅拦 Esc，其余放行。
    // 但补全菜单/反向搜索/和弦待决等"子模式"激活时不接管，交还原生流程避免打架。
    if (vimMode && !reverseSearch.state.active && completion.mode === "none" && !chordPending) {
      if (handleVimKey(key)) return true;
    }

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

    // Ctrl+G 外部编辑器编辑 prompt（对标 cc）：把当前输入交给 $VISUAL/$EDITOR，
    // 编辑保存退出后回填。异步 handoff（spawn 全屏编辑器），立即 return true 消费按键，
    // 用 ref 防止编辑期间重复触发。
    if (matchBinding(key)?.action === "input:externalEditor") {
      if (externalEditingRef.current) return true;
      externalEditingRef.current = true;
      const current = tb.getText();
      void editInExternalEditor(current)
        .then((result) => {
          if (result.ok) {
            tb.setText(result.text);
          } else if (result.error) {
            log.warn("UI:INPUT", `外部编辑器: ${result.error}`);
          }
        })
        .finally(() => { externalEditingRef.current = false; });
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

      // P2-6 剪贴板截图：空 paste 是终端对"剪贴板里是图片"的典型信号（parse-keypress 保留空 paste）。
      // 尝试把剪贴板图片落临时文件 → 插入 @<path> 引用，走 Read 工具的 vision 管道。
      if (cleaned.length === 0) {
        tryInsertClipboardImage();
        // 空文本无内容可插，无论有无图片都吞掉此 paste。
        return true;
      }

      // P2-7 拖放图片：粘贴内容是单个图片文件路径（终端拖文件常粘贴路径）→ 转 @<path> 引用。
      const dropped = detectDroppedImagePath(cleaned);
      if (dropped) {
        insertImageRef(dropped);
        log.debug("UI:INPUT", `拖放图片: ${dropped}`);
        return true;
      }

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
        setCompletion({ suggestions: [], activeIndex: 0, mode: "none" });
        return true;
      }
      // Tab：始终仅回填（想给命令补参数时的逃生口，也用于 @ / shell 补全）。
      if (key.name === "tab") {
        applyCompletion(suggestions[activeIndex]);
        return true;
      }
      if (key.name === "enter" && !key.shift) {
        const picked = suggestions[activeIndex];
        // 斜杠命令 + 不需要参数 → 单次回车直接执行（对齐 claude-code，省掉"回填再回车"）。
        // 用补全项的规范命令名（value 去掉尾随空格）提交，忽略用户输入的模糊查询。
        if (completionMode === "slash" && picked && !picked.requiresArgs) {
          setCompletion({ suggestions: [], activeIndex: 0, mode: "none" });
          submitCommandText(picked.value.trim());
          return true;
        }
        // 需要参数的命令（如 /btw）/ @ 文件 / shell 补全 → 回填，等待用户继续输入。
        applyCompletion(picked);
        return true;
      }
      if (key.name === "up" && !key.shift) {
        setCompletion(prev => ({ ...prev, activeIndex: (prev.activeIndex - 1 + prev.suggestions.length) % prev.suggestions.length }));
        return true;
      }
      if (key.name === "down" && !key.shift) {
        setCompletion(prev => ({ ...prev, activeIndex: (prev.activeIndex + 1) % prev.suggestions.length }));
        return true;
      }
    }

    // ── 普通键盘输入 ──
    // 换行：Shift+Enter / Option(Alt)+Enter 都插换行（macOS 用户惯用 Option+Enter，
    // 解析层已把 ESC+CR 识别为 alt+enter，此前误落提交分支）。
    if (key.name === "enter" && (key.shift || key.alt)) { tb.insert("\n"); return true; }
    // 提交：仅裸 Enter（无 shift/alt）→ 默认 next 级排队
    if (key.name === "enter" && !key.shift && !key.alt) { handleSubmit(); return true; }

    // P1-G6：带优先级提交（Alt+N=now 插队 / Alt+L=later 延后，对齐 CC now>next>later）。
    // 仅在**流式进行中**（isLoading）拦截——空闲时提交不入队，优先级无意义，此时放行让
    // Alt+N/Alt+L 走正常字符输入路径（macOS Option 组合键可能是用户想输入的字符）。
    // 输入框为空时同样放行（没内容可提交）。
    if (isLoading && !tb.isEmpty()) {
      const action = matchBinding(key)?.action;
      if (action === "input:submitNow") { handleSubmit("now"); return true; }
      if (action === "input:submitLater") { handleSubmit("later"); return true; }
    }

    // 历史记录：
    // - shell 模式(类 REPL):光标在首行↑ / 末行↓ 时翻历史,否则在多行命令内移光标
    // - 普通模式:仅单行时 ↑↓ 触发历史,多行时移光标
    if (key.name === "up" && !key.shift) {
      // P2-G6：空输入框 + 队列非空时，↑ 先弹回队尾排队输入编辑（优先于历史检索，对齐 CC）。
      // 队列弹回从"最近排的一条"取，符合"刚敲错想改"的直觉；取出即从队列移除。
      const inputEmpty = tb.state.lines.length === 1 && (tb.state.lines[0] ?? "") === "";
      if (inputEmpty && queuedCount > 0 && onPopQueuedForEdit) {
        const popped = onPopQueuedForEdit();
        if (popped != null) {
          tb.setText(popped);
          return true;
        }
        // 弹回返回 null（竞态：队列已被 drain 清空）→ 落回历史检索。
      }
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

    // ── Emacs 光标/编辑键（Alt 词移 + Ctrl 字符移/删词/kill ring）──
    // Alt+B / Alt+F：按词左右移（与 Alt+方向键等价的字母键，emacs 惯用）。
    if (key.alt && key.name === "b") { tb.moveCursor("wordLeft"); return true; }
    if (key.alt && key.name === "f") { tb.moveCursor("wordRight"); return true; }
    // Alt+Y：yank-pop（仅紧邻 yank 后有效，循环取 kill ring 更早条目）。
    if (key.alt && key.name === "y") { tb.yankPop(); return true; }

    // Emacs Ctrl 快捷键
    if (key.ctrl) {
      if (key.name === "a") { tb.moveCursor("home"); return true; }
      if (key.name === "e") { tb.moveCursor("end"); return true; }
      if (key.name === "f") { tb.moveCursor("right"); return true; }
      if (key.name === "b") { tb.moveCursor("left"); return true; }
      if (key.name === "k") { tb.killLine(); return true; }
      if (key.name === "u") { tb.killToStart(); return true; }
      if (key.name === "w") { tb.killWordBefore(); return true; }
      if (key.name === "y") { tb.yank(); return true; }
      // Ctrl+J：插入换行（通用换行键；解析层把裸 \n 归一为 name:'j',ctrl:true）。
      if (key.name === "j") { tb.insert("\n"); return true; }
      // Ctrl+H：部分终端把退格发为 ^H，显式归一为删除（对齐 cc）。
      if (key.name === "h") { tb.deleteBackward(); return true; }
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

    // 防静默吞键：未绑定的 Alt/Ctrl 字母组合（如 Alt+Z）不落到插入分支静默吞掉——
    // 直接 return false 交还上层，避免"按了没反应"的隐蔽坏体验。
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
        {...INPUT_BORDER_PROPS}
        borderColor={modeBorderColor(theme.status.warning)}
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

  // P1-G6：按优先级分组的计数文案。只在**存在非 next 级**时才分组展示——全是默认排队时
  // 写"3 条 next"是噪音（视觉规范 L2：排版表达状态，不为等价信息加词）。
  // 顺序固定 now → next → later，与实际发送顺序一致，用户读到的就是发送次序。
  const queueBreakdown = (() => {
    if (!queuedByPriority) return null;
    const { now, next, later } = queuedByPriority;
    if (now === 0 && later === 0) return null; // 全默认级 → 不分组
    return [
      now > 0 ? `插队 ${now}` : null,
      next > 0 ? `常规 ${next}` : null,
      later > 0 ? `延后 ${later}` : null,
    ].filter(Boolean).join(" · ");
  })();

  // 队列提示：流式中已排队 N 条输入待接续时，在输入框上方一行提示。
  // P2-G6：完整形态附带"↑ 编辑"提示，告知用户可把队尾输入弹回编辑（输入框空时按 ↑）。
  // P1-G6：有非默认优先级时追加分组明细（按发送顺序 插队 · 常规 · 延后）。
  const queueHint = queuedCount > 0 ? (
    <Box paddingLeft={1}>
      <Text color={theme.status.warning}>
        {queueHintFullRef.current
          ? `${ARROW_PROMPT} 已排队 ${queuedCount} 条输入`
            + `${queueBreakdown ? `（${queueBreakdown}）` : ""}`
            + `，将在当前响应结束后依次发送（空输入框按 ↑ 弹回编辑）`
          : `${ARROW_PROMPT} 已排队 ${queuedCount} 条${queueBreakdown ? `（${queueBreakdown}）` : ""}`}
      </Text>
    </Box>
  ) : null;

  // Shell 模式退出提示渐进衰减（交互铁律 C，G23）：首次进入 shell 模式的新用户需要知道
  // "怎么退出"（删掉行首 ! 即回普通模式），但老手每次进 shell 都被提醒就是唠叨。
  // 复用 app-config 通用 hint 计数：显示满 SHELL_HINT_MAX_SHOWS 次后不再显示。
  // 计数在 false→true 上升沿 +1（每次进入 shell 记一次），用 ref 锁定本次形态防抖动。
  const SHELL_HINT_KEY = "shellModeExit";
  const SHELL_HINT_MAX_SHOWS = 3;
  const shellHintRef = useRef(false);
  const prevShellModeRef = useRef(false);
  useEffect(() => {
    // false → true 上升沿：本次进入 shell 模式，判定是否仍应提示并记一次显示次数。
    if (!prevShellModeRef.current && shellModeActive) {
      shellHintRef.current = shouldShowHint(SHELL_HINT_KEY, SHELL_HINT_MAX_SHOWS);
      if (shellHintRef.current) markHintShown(SHELL_HINT_KEY);
    } else if (!shellModeActive) {
      shellHintRef.current = false;
    }
    prevShellModeRef.current = shellModeActive;
  }, [shellModeActive]);

  // Shell 模式提示：进入 shell 模式且未看够次数时，输入框上方一行引导退出方式。
  const shellHint = shellModeActive && shellHintRef.current ? (
    <Box paddingLeft={1}>
      <Text color={theme.text.secondary} dimColor>
        {`${ARROW_PROMPT} Shell 模式：命令将直接在终端执行，删除行首 ! 可退出`}
      </Text>
    </Box>
  ) : null;

  if (isEmpty) {
    const currentPrompt = shellModeActive ? SHELL_PROMPT : PROMPT;
    const currentPlaceholder = shellModeActive ? "输入 shell 命令…" : getPlaceholder();

    return (
      <Box flexDirection="column" width={termWidth}>
        {queueHint}
        {shellHint}
        <Box
          width={termWidth}
          {...INPUT_BORDER_PROPS}
          borderColor={inputBorderColor()}
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

    // 光标行：在 cursorCol 处插入光标字符
    const colInLine = cursorPos.visualCol;
    const before = lineText.slice(0, colInLine);
    const cursorChar = lineText[colInLine] || " ";
    const after = colInLine < lineText.length ? lineText.slice(colInLine + 1) : "";

    // vim 命令态(normal/visual)光标用品牌色块,与 insert(普通 inverse)区分——一眼可辨当前模式。
    const vimNormal = vimMode && vimModeLabel !== "insert";
    const cursorNode = vimNormal ? (
      <Text backgroundColor={theme.ui.active} color={theme.background.primary}>{cursorChar}</Text>
    ) : (
      <Text inverse>{cursorChar}</Text>
    );

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
          {cursorNode}
          {renderHighlightedSegments(afterSegments)}
        </Text>
      );
    }

    return (
      <Text key={`vl-${visualIdx}`}>
        {before}
        {cursorNode}
        {after}
      </Text>
    );
  });

  return (
    <Box flexDirection="column">
      {queueHint}
      {shellHint}
      {hasSuggestions && (
        <SuggestionsDisplay
          suggestions={suggestions}
          activeIndex={activeIndex}
          width={termWidth}
        />
      )}
      <Box
        width={termWidth}
        {...INPUT_BORDER_PROPS}
        borderColor={inputBorderColor()}
        paddingX={1}
        flexDirection="column"
      >
        {renderedLines}
      </Box>
      {/* P2-2：Vim 动态模式栏（对标 cc 的 -- NORMAL -- / -- INSERT --）。
          仅 vimMode 开启时显示；NORMAL/VISUAL 用品牌色，INSERT 用次要色，一眼可辨当前模式。 */}
      {vimMode && (
        <Box paddingX={1}>
          <Text
            color={vimModeLabel === "insert" ? theme.text.secondary : theme.ui.active}
            bold={vimModeLabel !== "insert"}
          >
            {vimModeLabel === "insert"
              ? "-- INSERT --"
              : vimModeLabel === "visual"
                ? "-- VISUAL --"
                : vimModeLabel === "visual-line"
                  ? "-- VISUAL LINE --"
                  : "-- NORMAL --"}
          </Text>
        </Box>
      )}
    </Box>
  );
}
