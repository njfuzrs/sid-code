import process from 'node:process';
import React, {type ReactNode} from 'react';
import ansiEscapes from 'ansi-escapes';
import autoBind from 'auto-bind';
import signalExit from 'signal-exit';
import patchConsole from 'patch-console';
import {LegacyRoot, ConcurrentRoot} from 'react-reconciler/constants.js';
import {type FiberRoot} from 'react-reconciler';
import Yoga from 'yoga-layout';
import wrapAnsi from 'wrap-ansi';
import {getWindowSize} from './utils.js';
import reconciler from './reconciler.js';
import render from './renderer.js';
import * as dom from './dom.js';
import {hideCursorEscape, showCursorEscape} from './cursor-helpers.js';
import {type CursorPosition} from './log-update.js';
import {bsu, esu, shouldSynchronize} from './write-synchronized.js';
import instances from './instances.js';
import {
	diffMainScreen,
	eraseMainScreen,
	redrawAfterSuspend,
	resetMainScreen,
	type FrameDiff,
	type FrameFlicker,
} from './frame/main-screen.js';
import {FrameScheduler} from './frame/scheduler.js';
import {FRAME_INTERVAL_MS} from './frame/schedule.js';
import {ClockContext, createClock, type Clock} from './clock.js';
import TerminalWriteContext from './components/TerminalWriteContext.js';
import {OSC} from './terminal/osc.js';
import {isTabStatusDisabled, tabStatusSequence} from './hooks/use-tab-status.js';
import {type Screen} from './screen/screen.js';
import {serializeScreen} from './screen/serialize.js';
import {clipToViewport, diffAltScreen} from './frame/alt-screen.js';
import {enableMouseTracking} from './terminal/modes.js';
import {supportsSynchronizedOutput} from './terminal/sync-output.js';
import App from './components/App.js';
import drainStdin from './drain-stdin.js';
import {
	disableInputModesSequences,
	reassertExtendedKeysSequence,
	supportsExtendedKeys,
} from './terminal/extended-keys.js';
import {type TerminalSuspension} from './components/AppContext.js';
import {accessibilityContext as AccessibilityContext} from './components/AccessibilityContext.js';
import {
	type KittyKeyboardOptions,
	type KittyFlagName,
	resolveFlags,
} from './kitty-keyboard.js';

const noop = () => {};
// OSC 9;4;0 清除进度条。旧底座这条固定 BEL 终止（kitty 下也不换 ST），对拍保持一致
const clearProgressSequence = `\u001B]${OSC.ITERM2};4;0;\u0007`;
const textEncoder = new TextEncoder();

const yieldImmediate = async () =>
	new Promise<void>(resolve => {
		setImmediate(resolve);
	});

const kittyQueryEscapeByte = 0x1b;
const kittyQueryOpenBracketByte = 0x5b;
const kittyQueryQuestionMarkByte = 0x3f;
const kittyQueryLetterByte = 0x75;
const zeroByte = 0x30;
const nineByte = 0x39;

type KittyQueryResponseMatch =
	{state: 'complete'; endIndex: number} | {state: 'partial'};

const isDigitByte = (byte: number): boolean =>
	byte >= zeroByte && byte <= nineByte;

const matchKittyQueryResponse = (
	buffer: number[],
	startIndex: number,
): KittyQueryResponseMatch | undefined => {
	if (
		buffer[startIndex] !== kittyQueryEscapeByte ||
		buffer[startIndex + 1] !== kittyQueryOpenBracketByte ||
		buffer[startIndex + 2] !== kittyQueryQuestionMarkByte
	) {
		return undefined;
	}

	let index = startIndex + 3;
	const digitsStartIndex = index;
	while (index < buffer.length && isDigitByte(buffer[index]!)) {
		index++;
	}

	if (index === digitsStartIndex) {
		return undefined;
	}

	if (index === buffer.length) {
		return {state: 'partial'};
	}

	if (buffer[index] === kittyQueryLetterByte) {
		return {state: 'complete', endIndex: index};
	}

	return undefined;
};

const hasCompleteKittyQueryResponse = (buffer: number[]): boolean => {
	for (let index = 0; index < buffer.length; index++) {
		const match = matchKittyQueryResponse(buffer, index);
		if (match?.state === 'complete') {
			return true;
		}
	}

	return false;
};

const stripKittyQueryResponsesAndTrailingPartial = (
	buffer: number[],
): number[] => {
	const keptBytes: number[] = [];
	let index = 0;
	while (index < buffer.length) {
		const match = matchKittyQueryResponse(buffer, index);
		if (match?.state === 'complete') {
			index = match.endIndex + 1;
			continue;
		}

		if (match?.state === 'partial') {
			break;
		}

		keptBytes.push(buffer[index]!);
		index++;
	}

	return keptBytes;
};

const isErrorInput = (value: unknown): value is Error => {
	return (
		value instanceof Error ||
		Object.prototype.toString.call(value) === '[object Error]'
	);
};

type MaybeWritableStream = NodeJS.WriteStream & {
	writable?: boolean;
	writableEnded?: boolean;
	destroyed?: boolean;
	writableLength?: number;
	_writableState?: unknown;
};

const getWritableStreamState = (stdout: MaybeWritableStream) => {
	const canWriteToStdout =
		!stdout.destroyed && !stdout.writableEnded && (stdout.writable ?? true);
	const hasWritableState =
		stdout._writableState !== undefined || stdout.writableLength !== undefined;

	return {
		canWriteToStdout,
		hasWritableState,
	};
};

/** 擦可视区并回原点（不清 scrollback）：forceRedraw 与 SIGCONT 重进 alt-screen 用 */
const eraseScreenHome = '\u001B[2J\u001B[H';
/** alt-screen 帧要不要包同步输出：模块加载时判定一次（R14） */
const altScreenSync = supportsSynchronizedOutput();

const settleThrottle = (
	throttled: unknown,
	canWriteToStdout: boolean,
): void => {
	if (
		!throttled ||
		typeof (throttled as {flush?: unknown}).flush !== 'function'
	) {
		return;
	}

	const throttledValue = throttled as {
		flush: () => void;
		cancel?: () => void;
	};

	if (canWriteToStdout) {
		throttledValue.flush();
	} else if (typeof throttledValue.cancel === 'function') {
		throttledValue.cancel();
	}
};

/**
Performance metrics for a render operation.
*/
/** sid-code（B9 / T3.2）：一次出帧的观测。`flickers` 非空 = 这一帧做了 full reset（R5 / R6 / R7）。 */
export type FrameEvent = {
	durationMs: number;
	flickers: FrameFlicker[];
};

export type RenderMetrics = {
	/**
	Time spent rendering in milliseconds.
	*/
	renderTime: number;
};

export type Options = {
	stdout: NodeJS.WriteStream;
	stdin: NodeJS.ReadStream;
	stderr: NodeJS.WriteStream;
	debug: boolean;
	exitOnCtrlC: boolean;
	patchConsole: boolean;
	onRender?: (metrics: RenderMetrics) => void;
	/** sid-code（B9 / T3.2）：每次真正出帧后回调（端口 `onFrame`），含 full reset 记录 */
	onFrame?: (event: FrameEvent) => void;
	isScreenReaderEnabled?: boolean;
	waitUntilExit?: () => Promise<unknown>;
	maxFps?: number;
	incrementalRendering?: boolean;

	/**
	Enable React Concurrent Rendering mode.

	When enabled:
	- Suspense boundaries work correctly with async data
	- `useTransition` and `useDeferredValue` are fully functional
	- Updates can be interrupted for higher priority work

	Note: Concurrent mode changes the timing of renders. Some tests may need to use `act()` to properly await updates. Reusing the same stdout across multiple `render()` calls without unmounting is unsupported. Call `unmount()` first if you need to change the rendering mode or create a fresh instance.

	@default false
	@experimental
	*/
	concurrent?: boolean;
	kittyKeyboard?: KittyKeyboardOptions;

	/**
	Override automatic interactive mode detection.

	By default, Ink detects whether the environment is interactive based on CI detection (via [`is-in-ci`](https://github.com/sindresorhus/is-in-ci)) and `stdout.isTTY`. Most users should not need to set this.

	When non-interactive, Ink disables ANSI erase sequences, cursor manipulation, synchronized output, resize handling, and kitty keyboard auto-detection, writing only the final frame at unmount.

	Set to `false` to force non-interactive mode or `true` to force interactive mode when the automatic detection doesn't suit your use case.

	Note: Reusing the same stdout across multiple `render()` calls without unmounting is unsupported. Call `unmount()` first if you need to change this option or create a fresh instance.

	@default true (false if in CI or `stdout.isTTY` is falsy)

	@see {@link RenderOptions.interactive}
	*/
	interactive?: boolean;

	/**
	Render the app in the terminal's alternate screen buffer. When enabled, the app renders on a separate screen, and the original terminal content is restored when the app exits. This is the same mechanism used by programs like vim, htop, and less.

	Note: The terminal's scrollback buffer is not available while in the alternate screen. This is standard terminal behavior; programs like vim use the alternate screen specifically to avoid polluting the user's scrollback history.

	Note: Ink intentionally treats alternate-screen teardown output as disposable. It does not preserve or replay teardown-time frames, hook writes, or `console.*` output after restoring the primary screen.

	Only works in interactive mode. Ignored when `interactive` is `false` or in a non-interactive environment (CI, piped stdout).

	Note: Reusing the same stdout across multiple `render()` calls without unmounting is unsupported. Call `unmount()` first if you need to change this option or create a fresh instance.

	@default false

	@see {@link RenderOptions.alternateScreen}
	*/
	alternateScreen?: boolean;
};

export default class Ink {
	/**
	Whether this instance is using concurrent rendering mode.
	*/
	readonly isConcurrent: boolean;

	private readonly options: Options;
	private cursorPosition: CursorPosition | undefined;
	/** sid-code（B9 / T3.2）：上一帧的屏幕缓冲，帧 diff 的基准；undefined = 下一帧按首帧整帧画 */
	private previousScreen: Screen | undefined;
	private cursorHidden = false;
	private readonly clock: Clock;

	private readonly isScreenReaderEnabled: boolean;
	private readonly interactive: boolean;
	private readonly renderThrottleMs: number;
	private alternateScreen: boolean;

	// Ignore last render after unmounting a tree to prevent empty output before exit
	private isUnmounted: boolean;
	private isUnmounting: boolean;
	private lastOutput: string;
	private lastOutputToRender: string;
	private lastOutputHeight: number;
	private lastTerminalWidth: number;
	private readonly container: FiberRoot;
	private readonly rootNode: dom.DOMElement;
	// This variable is used only in debug mode to store full static output
	// so that it's rerendered every time, not just new static parts, like in non-debug mode
	private fullStaticOutput: string;
	private readonly exitPromise!: Promise<unknown>;
	private exitResult: unknown;
	private beforeExitHandler?: () => void;
	private restoreConsole?: () => void;
	private readonly unsubscribeResize?: () => void;
	private readonly scheduler?: FrameScheduler;
	/**
	 * sid-code（B9 / T3.3，契约 R7）：resize 事件单独一条调度，测试环境也不同步出帧（见 FrameScheduler 的 alwaysThrottle）。
	 * 同一 tick 连来多次 resize → leading + trailing 两帧；尺寸与上一次 resize 事件相同的事件直接丢掉。
	 */
	private readonly resizeScheduler: FrameScheduler;
	private lastResizeSize: {columns: number; rows: number};
	/** 上一帧出帧时的视口：R7 的「宽度变了 / 变矮了 → full reset」比的是它，不是上一帧的屏幕 */
	private frameViewport: {columns: number; rows: number} | undefined;
	/** 下一帧强制 full reset 的原因（离开 alt-screen 之后，主屏的旧帧已经不可信） */
	private pendingResetReason: FrameFlicker['reason'] | undefined;
	/** `<AlternateScreen>` 挂载状态（端口 setAltScreenActive，R10）；为真时出帧走 renderAltScreenFrame（R14） */
	/** SIGCONT 作废的那一帧：下一帧按 `redrawAfterSuspend` 写（R10）；resize / forceRedraw 帧不走它 */
	private suspendedScreen: Screen | undefined;
	private altScreenActive = false;
	private altScreenMouseTracking = false;
	/** alt-screen 的上一帧（已裁到视口）与它出帧时的视口；缺省 = 屏幕已是空白（R14） */
	private altPreviousScreen: Screen | undefined;
	private altViewport: {columns: number; rows: number} | undefined;
	private readonly unsubscribeSigcont?: () => void;
	private kittyProtocolEnabled = false;
	private kittyFlags: KittyFlagName[] | undefined;
	private cancelKittyDetection?: () => void;
	private nextRenderCommit?: {promise: Promise<void>; resolve: () => void};
	// Set while suspendTerminal() has handed the terminal to a child process.
	private isSuspended = false;
	// Input pause/resume hooks registered by the App component, which owns raw
	// mode and bracketed paste state.
	private pauseInput?: () => void;
	private resumeInput?: () => void;

	constructor(options: Options) {
		autoBind(this);

		this.options = options;
		this.rootNode = dom.createNode('ink-root');
		this.rootNode.onComputeLayout = this.calculateLayout;

		this.isScreenReaderEnabled =
			options.isScreenReaderEnabled ??
			process.env['INK_SCREEN_READER'] === 'true';

		// CI detection takes precedence: even a TTY stdout in CI defaults to non-interactive.
		// Using Boolean(isTTY) (rather than an 'in' guard) correctly handles piped streams
		// where the property is absent (e.g. `node app.js | cat`).
		this.interactive = this.resolveInteractiveOption(options.interactive);

		this.alternateScreen = false;

		// sid-code（B9 / T3.2，契约 R2 / R13）：出帧调度换成 FrameScheduler（microtask 合并 + 16ms 窗口；
		// 测试环境同步出帧）。上游的 maxFps / lodash throttle 两级节流不再使用。
		const unthrottled = options.debug || this.isScreenReaderEnabled;
		this.renderThrottleMs = unthrottled ? 0 : FRAME_INTERVAL_MS;

		if (unthrottled) {
			this.rootNode.onRender = this.onRender;
		} else {
			const scheduler = new FrameScheduler(this.onRender);
			this.rootNode.onRender = () => {
				scheduler.request();
			};

			this.scheduler = scheduler;
		}

		this.rootNode.onImmediateRender = this.onRender;
		this.rootNode.onStaticChange = this.handleStaticChange;
		this.cursorPosition = undefined;
		this.previousScreen = undefined;
		this.clock = createClock();

		// Ignore last render after unmounting a tree to prevent empty output before exit
		this.isUnmounted = false;
		this.isUnmounting = false;

		// Store concurrent mode setting
		this.isConcurrent = options.concurrent ?? false;

		// Store last output to only rerender when needed
		this.lastOutput = '';
		this.lastOutputToRender = '';
		this.lastOutputHeight = 0;
		this.lastTerminalWidth = getWindowSize(this.options.stdout).columns;
		this.lastResizeSize = getWindowSize(this.options.stdout);
		this.frameViewport = undefined;
		this.pendingResetReason = undefined;
		this.resizeScheduler = new FrameScheduler(this.renderAfterResize, true);

		// This variable is used only in debug mode to store full static output
		// so that it's rerendered every time, not just new static parts, like in non-debug mode
		this.fullStaticOutput = '';

		// Use ConcurrentRoot for concurrent mode, LegacyRoot for legacy mode
		const rootTag = options.concurrent ? ConcurrentRoot : LegacyRoot;

		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		this.container = reconciler.createContainer(
			this.rootNode,
			rootTag,
			null,
			false,
			null,
			'id',
			() => {},
			() => {},
			() => {},
			() => {},
		);

		// Unmount when process exits
		this.unsubscribeExit = signalExit(this.unmount, {alwaysLast: false});

		this.setAlternateScreen(Boolean(options.alternateScreen));

		if (process.env['DEV'] === 'true') {
			// @ts-expect-error outdated types
			reconciler.injectIntoDevTools();
		}

		if (options.patchConsole) {
			this.patchConsole();
		}

		if (this.interactive) {
			options.stdout.on('resize', this.resized);

			this.unsubscribeResize = () => {
				options.stdout.off('resize', this.resized);
			};

			// sid-code（B9 / T3.3，契约 R10）：只在交互模式挂（非 TTY 不挂，L5）
			process.on('SIGCONT', this.handleSigcont);
			this.unsubscribeSigcont = () => {
				process.off('SIGCONT', this.handleSigcont);
			};
		}

		this.initKittyKeyboard();

		this.exitPromise = new Promise((resolve, reject) => {
			this.resolveExitPromise = resolve;
			this.rejectExitPromise = reject;
		});
		// Prevent global unhandled-rejection crashes when app code exits with an
		// error but consumers never call waitUntilExit().

		void this.exitPromise.catch(noop);
	}

	/**
	 * sid-code（B9 / T3.3，契约 R7）：resize 事件不当场出帧，交给 resizeScheduler 合并。
	 * 尺寸和上一次 resize 事件一样就忽略（不出帧）；要不要 full reset 在出帧时比视口决定（renderInteractiveFrame）。
	 */
	resized = () => {
		const size = getWindowSize(this.options.stdout);
		if (
			size.columns === this.lastResizeSize.columns &&
			size.rows === this.lastResizeSize.rows
		) {
			return;
		}

		this.lastResizeSize = size;
		// alt-screen 下 resize 当场重开鼠标跟踪（有的终端 resize 会复位鼠标模式）；出帧仍走调度（R14）
		if (this.interactive && this.altScreenActive && this.altScreenMouseTracking) {
			this.writeBestEffort(this.options.stdout, enableMouseTracking);
		}

		// 布局当场按新宽度重算，出帧延后：同 tick 里先到的提交 / forceRedraw 帧就已经是新宽度，
		// resize 帧随后 diff 为空、不再写第二次 full reset（与旧底座一致）
		this.calculateLayout();
		this.resizeScheduler.request();
	};

	private readonly renderAfterResize = (): void => {
		if (this.isUnmounted || this.isUnmounting || this.isSuspended) {
			return;
		}

		this.suspendedScreen = undefined;
		this.calculateLayout();
		dom.emitLayoutListeners(this.rootNode);
		this.onRender();
		this.lastTerminalWidth = getWindowSize(this.options.stdout).columns;
	};

	/**
	 * sid-code（B9 / T3.3，契约 R8）：擦可视区（`2J H`，不清 scrollback、不进同步输出包裹）后当场按首帧画一遍。
	 * 前一帧作废，但「上一帧出帧时的视口」不作废：视口同时变了，这一帧照样按 R7 full reset。
	 * 已排队的帧照常出（diff 为空，不写字节）。非 TTY 什么都不做。
	 */
	forceRedraw(): void {
		if (
			!this.interactive ||
			this.options.debug ||
			this.isUnmounted ||
			this.isUnmounting ||
			this.isSuspended
		) {
			return;
		}

		this.options.stdout.write(eraseScreenHome);
		this.previousScreen = undefined;
		this.suspendedScreen = undefined;
		this.onRender();
	}

	/**
	 * 端口 RenderInstance.setAltScreenActive：`<AlternateScreen>` 挂载 / 卸载时调用，本身不写字节。
	 * 离开 alt-screen 后主屏的旧帧不可信，下一帧 full reset（原因 resize，与旧底座一致）。
	 */
	setAltScreenActive(active: boolean, mouseTracking = false): void {
		if (this.altScreenActive && !active) {
			this.pendingResetReason = 'resize';
		}

		// 刚进 alt：组件已经擦过屏，下一帧对空白整帧画；已在 alt 时再置一次不作废上一帧（与旧底座一致）
		if (!this.altScreenActive && active) {
			this.pendingResetReason = undefined;
			this.altPreviousScreen = undefined;
			this.altViewport = getWindowSize(this.options.stdout);
		}

		this.altScreenActive = active;
		this.altScreenMouseTracking = active && mouseTracking;
	}

	/**
	 * sid-code（B9 / T3.3，契约 R10）：进程被 SIGSTOP / Ctrl+Z 挂起后恢复。期间别的程序可能动过屏幕，前一帧作废，
	 * 但**不当场出帧**（主屏一个字节都不写），等下一次提交按首帧画。
	 * alt-screen 下终端多半已经回到主屏：重进 alt、擦屏，开过鼠标跟踪的重新打开。
	 */
	private readonly handleSigcont = (): void => {
		if (this.isUnmounted || this.isUnmounting) {
			return;
		}

		// alt-screen 下一帧对空白整帧画（R14，altPreviousScreen 作废）；只有主屏才按 redrawAfterSuspend 接着写
		if (!this.altScreenActive) {
			this.suspendedScreen ??= this.previousScreen;
		}

		this.previousScreen = undefined;
		this.altPreviousScreen = undefined;
		if (this.altScreenActive) {
			this.writeBestEffort(
				this.options.stdout,
				ansiEscapes.enterAlternativeScreen +
					eraseScreenHome +
					(this.altScreenMouseTracking ? enableMouseTracking : ''),
			);
		}
	};

	/**
	 * sid-code（B9 / T5.1d，契约 X4）：信号退出路径（进程马上要退）。标记已卸载、取消排队的帧，
	 * 把 stdin 缓冲读掉、退出 raw mode；不经 React 卸载，**不写任何终端序列**。
	 *
	 * 旧底座黑盒探针得来的边界（D-5）：先 drain 后关 raw mode；不 `unref`、不摘 `readable` 监听
	 * （之后的输入照样送到 `useInput`）、不摘 SIGCONT / resize、不结算 exit promise；之后的提交不出帧，
	 * `unmount()` 早退。所以这里刻意不走 App 的 `disableRawMode`（它会摘 readable、清计数）。
	 */
	detachForShutdown(): void {
		this.isUnmounted = true;
		this.scheduler?.cancel();
		this.resizeScheduler.cancel();
		const {stdin} = this.options;
		drainStdin(stdin);
		if (stdin.isTTY && stdin.isRaw) {
			try {
				stdin.setRawMode(false);
			} catch {}
		}
	}

	/**
	 * sid-code（B9 / T5.1d，契约 I1c）：stdin 静默 > 5s 后的第一块输入。外部程序（tmux 切窗、锁屏恢复）可能
	 * 关掉了鼠标跟踪，这里重新打开；**不擦屏、不重进 alt**（静默不是 alt-screen 丢失的强信号，那是 SIGCONT 的事）。
	 * 旧底座实测：鼠标跟踪只在 alt-screen 且开了跟踪时重写；扩展键开着时主屏也重申 kitty / modifyOtherKeys（I4）；
	 * 非 TTY 什么都不写。
	 */
	private readonly handleStdinResume = (): void => {
		if (!this.interactive || this.isUnmounted || this.isUnmounting) {
			return;
		}

		// sid-code（B9 / T5.3a，契约 I4）：扩展键开着时先整段重申（主屏 / alt 都写，一次写入），再按上面重开鼠标
		if (supportsExtendedKeys()) {
			this.writeBestEffort(this.options.stdout, reassertExtendedKeysSequence);
		}

		if (!this.altScreenActive || !this.altScreenMouseTracking) {
			return;
		}

		this.writeBestEffort(this.options.stdout, enableMouseTracking);
	};

	resolveExitPromise: (result?: unknown) => void = () => {};
	rejectExitPromise: (reason?: Error) => void = () => {};
	unsubscribeExit: () => void = () => {};

	handleAppExit = (errorOrResult?: unknown): void => {
		if (this.isUnmounted || this.isUnmounting) {
			return;
		}

		if (isErrorInput(errorOrResult)) {
			this.unmount(errorOrResult);
			return;
		}

		this.exitResult = errorOrResult;
		this.unmount();
	};

	// sid-code（B9 / T3.2）：上游 useCursor 的光标定位随 log-update 一起退出帧输出路径。
	// CLI 不用 useCursor（SURFACE.md 无此符号），这里只记下位置；真要接入时在 frame/ 里补，别回到 log-update。
	setCursorPosition = (position: CursorPosition | undefined): void => {
		this.cursorPosition = position;
	};

	/** 外部写入之后按首帧口径重画当前帧（光标停在帧底下一行）。 */
	restoreLastOutput = (): void => {
		if (!this.interactive || !this.previousScreen) {
			return;
		}

		this.options.stdout.write(serializeScreen(this.previousScreen));
	};

	calculateLayout = () => {
		const terminalWidth = getWindowSize(this.options.stdout).columns;

		this.rootNode.yogaNode!.setWidth(terminalWidth);

		this.rootNode.yogaNode!.calculateLayout(
			undefined,
			undefined,
			Yoga.DIRECTION_LTR,
		);
	};

	// Resets `fullStaticOutput` when the <Static> identity changes so stale items from a previous instance are not replayed on future rewrites.
	handleStaticChange = (): void => {
		this.fullStaticOutput = '';
	};

	onRender: () => void = () => {
		if (this.isUnmounted) {
			return;
		}

		// While suspended, the terminal belongs to a child process. Discard queued
		// renders; resume() forces a full redraw once Ink reclaims the terminal.
		// Resolve any awaited render commit so callers don't hang during suspension.
		if (this.isSuspended) {
			if (this.nextRenderCommit) {
				this.nextRenderCommit.resolve();
				this.nextRenderCommit = undefined;
			}

			return;
		}

		if (this.nextRenderCommit) {
			this.nextRenderCommit.resolve();
			this.nextRenderCommit = undefined;
		}

		const startTime = performance.now();
		// sid-code（B9 / T3.4，契约 P3）：TTY 交互帧只比屏幕缓冲，纯文本只有 debug / 非 TTY / 读屏路径要
		const needsText =
			this.options.debug || !this.interactive || this.isScreenReaderEnabled;
		const {output, outputHeight, staticOutput, screen} = render(
			this.rootNode,
			this.isScreenReaderEnabled,
			needsText,
		);

		this.options.onRender?.({renderTime: performance.now() - startTime});

		// If <Static> output isn't empty, it means new children have been added to it
		const hasStaticOutput = staticOutput && staticOutput !== '\n';

		if (this.options.debug) {
			if (hasStaticOutput) {
				this.fullStaticOutput += staticOutput;
			}

			this.lastOutput = output;
			this.lastOutputToRender = output;
			this.lastOutputHeight = outputHeight;
			this.options.stdout.write(this.fullStaticOutput + output);
			return;
		}

		if (!this.interactive) {
			if (hasStaticOutput) {
				this.options.stdout.write(staticOutput);
			}

			// sid-code（B9 / T3.2，契约 R12）：非 TTY 每帧写整帧（同步输出包裹，无增量），空帧不写。
			// 上游是攒到卸载时才写最后一帧；测试 shim 的 lastFrame / frames 依赖逐帧写。
			if (output !== '') {
				this.options.stdout.write(bsu + output + esu);
			}

			this.lastOutput = output;
			this.lastOutputToRender = output + '\n';
			this.lastOutputHeight = outputHeight;
			this.options.onFrame?.({
				durationMs: performance.now() - startTime,
				flickers: [],
			});
			return;
		}

		if (this.isScreenReaderEnabled) {
			const sync = this.shouldSync();
			if (sync) {
				this.options.stdout.write(bsu);
			}

			if (hasStaticOutput) {
				// We need to erase the main output before writing new static output
				const erase =
					this.lastOutputHeight > 0
						? ansiEscapes.eraseLines(this.lastOutputHeight)
						: '';
				this.options.stdout.write(erase + staticOutput);
				// After erasing, the last output is gone, so we should reset its height
				this.lastOutputHeight = 0;
			}

			if (output === this.lastOutput && !hasStaticOutput) {
				if (sync) {
					this.options.stdout.write(esu);
				}

				return;
			}

			const terminalWidth = getWindowSize(this.options.stdout).columns;

			const wrappedOutput = wrapAnsi(output, terminalWidth, {
				trim: false,
				hard: true,
			});

			// If we haven't erased yet, do it now.
			if (hasStaticOutput) {
				this.options.stdout.write(wrappedOutput);
			} else {
				const erase =
					this.lastOutputHeight > 0
						? ansiEscapes.eraseLines(this.lastOutputHeight)
						: '';
				this.options.stdout.write(erase + wrappedOutput);
			}

			this.lastOutput = output;
			this.lastOutputToRender = wrappedOutput;
			this.lastOutputHeight =
				wrappedOutput === '' ? 0 : wrappedOutput.split('\n').length;

			if (sync) {
				this.options.stdout.write(esu);
			}

			return;
		}

		if (hasStaticOutput) {
			this.fullStaticOutput += staticOutput;
		}

		this.renderInteractiveFrame(
			screen,
			output,
			outputHeight,
			hasStaticOutput ? staticOutput : '',
			startTime,
		);
	};

	render(node: ReactNode): void {
		const tree = (
			<AccessibilityContext.Provider
				value={{isScreenReaderEnabled: this.isScreenReaderEnabled}}
			>
				<ClockContext.Provider value={this.clock}>
				<App
					stdin={this.options.stdin}
					stdout={this.options.stdout}
					stderr={this.options.stderr}
					exitOnCtrlC={this.options.exitOnCtrlC}
					interactive={this.interactive}
					renderThrottleMs={this.renderThrottleMs}
					writeToStdout={this.writeToStdout}
					writeToStderr={this.writeToStderr}
					setCursorPosition={this.setCursorPosition}
					onExit={this.handleAppExit}
					onWaitUntilRenderFlush={this.waitUntilRenderFlush}
					onSuspendTerminal={this.suspendTerminal}
					onRegisterInputControl={this.registerInputControl}
					onStdinResume={this.handleStdinResume}
				>
					<TerminalWriteContext.Provider value={this.writeRaw}>
						{node}
					</TerminalWriteContext.Provider>
				</App>
				</ClockContext.Provider>
			</AccessibilityContext.Provider>
		);

		if (this.options.concurrent) {
			// Concurrent mode: use updateContainer (async scheduling)
			reconciler.updateContainer(tree, this.container, null, noop);
		} else {
			// Legacy mode: use updateContainerSync + flushSyncWork (sync)
			reconciler.updateContainerSync(tree, this.container, null, noop);
			reconciler.flushSyncWork();
		}
	}

	writeToStdout(data: string): void {
		if (this.isUnmounted) {
			return;
		}

		// While suspended, the terminal belongs to a child process. Don't erase or
		// repaint Ink's frame around console output; the forced redraw on resume
		// restores the screen.
		if (this.isSuspended) {
			return;
		}

		if (this.options.debug) {
			this.options.stdout.write(data + this.fullStaticOutput + this.lastOutput);
			return;
		}

		if (!this.interactive) {
			this.options.stdout.write(data);
			return;
		}

		const sync = this.shouldSync();
		if (sync) {
			this.options.stdout.write(bsu);
		}

		this.options.stdout.write(eraseMainScreen(this.previousScreen));
		this.options.stdout.write(data);
		this.restoreLastOutput();

		if (sync) {
			this.options.stdout.write(esu);
		}
	}

	writeToStderr(data: string): void {
		if (this.isUnmounted) {
			return;
		}

		// See writeToStdout: stay off the terminal while suspended.
		if (this.isSuspended) {
			return;
		}

		if (this.options.debug) {
			this.options.stderr.write(data);
			this.options.stdout.write(this.fullStaticOutput + this.lastOutput);
			return;
		}

		if (!this.interactive) {
			this.options.stderr.write(data);
			return;
		}

		const sync = this.shouldSync();
		if (sync) {
			this.options.stdout.write(bsu);
		}

		this.options.stdout.write(eraseMainScreen(this.previousScreen));
		this.options.stderr.write(data);
		this.restoreLastOutput();

		if (sync) {
			this.options.stdout.write(esu);
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-restricted-types
	unmount(error?: Error | number | null): void {
		if (this.isUnmounted || this.isUnmounting) {
			return;
		}

		this.isUnmounting = true;

		if (this.beforeExitHandler) {
			process.off('beforeExit', this.beforeExitHandler);
			this.beforeExitHandler = undefined;
		}

		const stdout = this.options.stdout as MaybeWritableStream;
		const {canWriteToStdout, hasWritableState} = getWritableStreamState(stdout);

		// Clear any pending throttled render timer on unmount. When stdout is writable,
		// flush so the final frame is emitted; otherwise cancel to avoid delayed callbacks.
		const hadPendingFrame = this.scheduler?.pending ?? false;
		settleThrottle(this.scheduler, canWriteToStdout);
		// resize 帧不补：最后一帧下面马上画（shouldRenderFinalFrame），排队的 resize 帧只会多出一次 full reset
		this.resizeScheduler.cancel();

		if (canWriteToStdout) {
			// If throttling is enabled and there is already a pending render, flushing above
			// is sufficient. Also avoid calling onRender() again when static output already
			// exists, as that can duplicate <Static> children output on exit (see issue #397).
			const shouldRenderFinalFrame =
				!this.scheduler ||
				(!hadPendingFrame && this.fullStaticOutput === '');

			if (shouldRenderFinalFrame) {
				this.calculateLayout();
				this.onRender();
			}
		}

		// Mark as unmounted after the final render but before stdout writes
		// that could re-enter exit() via synchronous write callbacks.
		this.isUnmounted = true;

		this.unsubscribeExit();

		this.clock.stop();
		if (typeof this.restoreConsole === 'function') {
			// Once unmount starts, Ink stops trying to manage teardown-time
			// console output. Restoring the native console before React cleanup keeps
			// unmount behavior simple and avoids special-case handling for custom
			// streams, fullscreen frames, and alternate-screen teardown.
			this.restoreConsole();
		}

		const finishUnmount = (): void => {
			if (typeof this.unsubscribeResize === 'function') {
				this.unsubscribeResize();
			}

			this.unsubscribeSigcont?.();

			// Cancel any in-progress auto-detection before checking protocol state
			if (this.cancelKittyDetection) {
				this.cancelKittyDetection();
			}

			if (canWriteToStdout) {
				if (this.kittyProtocolEnabled) {
					this.writeBestEffort(this.options.stdout, '\u001B[<u');
				}

				// Alternate-screen content is disposable by design. We intentionally
				// leave it active until React cleanup finishes, then restore the
				// primary buffer without replaying prior frames, hook writes, or
				// diagnostics onto it. Trying to preserve teardown output across the
				// buffer switch adds fragile lifecycle-specific behavior, so Ink keeps
				// alternate-screen teardown intentionally simple and best-effort.
				if (this.alternateScreen) {
					this.writeBestEffort(
						this.options.stdout,
						ansiEscapes.exitAlternativeScreen,
					);
					this.writeBestEffort(this.options.stdout, showCursorEscape);
					this.alternateScreen = false;
				}

				// sid-code（B9 / T3.2）：非 TTY 每帧已经写过整帧（R12），卸载只补一个换行；
				// TTY 卸载时恢复光标（同步输出包裹，与旧底座同字节）
				if (!this.interactive) {
					this.options.stdout.write(this.options.debug ? '\n' : bsu + '\n' + esu);
				} else if (!this.options.debug) {
					// sid-code（B9 / T5.3a，契约 I4）：TTY 卸载时把输入模式再关一次（一次写入），与 raw mode 用没用过无关。
					// 旧底座实测在非 TTY 下不写；它与光标 / 鼠标 / 进度清除的相对顺序归 X3（T7.1b）
					this.writeBestEffort(
						this.options.stdout,
						disableInputModesSequences.join(''),
					);
					this.options.stdout.write(bsu + showCursorEscape + esu);
					this.cursorHidden = false;
					this.previousScreen = undefined;
					// sid-code（B9 / T7.2b，契约 O3 / O2）：退出时清进度条与 tab 状态点，免得残留在 tab 上。
					// 对拍旧底座：只在 TTY 下写；进度清除固定用 BEL 终止、不包裹（kitty 下也是），
					// tab 清除照常随终端终止并按 tmux / screen 包裹，`SID_DISABLE_TAB_STATUS` 非空时不写；
					// 两条都与之前写没写过无关。与其余模式恢复的相对顺序归 X3（T7.1b）。
					this.writeBestEffort(this.options.stdout, clearProgressSequence);
					if (!isTabStatusDisabled()) {
						this.writeBestEffort(this.options.stdout, tabStatusSequence(null));
					}
				}
			}

			this.kittyProtocolEnabled = false;

			instances.delete(this.options.stdout);

			// Ensure all queued writes have been processed before resolving the
			// exit promise. For real writable streams, queue an empty write as a
			// barrier — its callback fires only after all prior writes complete.
			// For non-stream objects (e.g. test spies), resolve on next tick.
			//
			// When called from signal-exit during process shutdown (error is a
			// number or null rather than undefined/Error), resolve synchronously
			// because the event loop is draining and async callbacks won't fire.
			const {exitResult} = this;

			const resolveOrReject = () => {
				if (isErrorInput(error)) {
					this.rejectExitPromise(error);
				} else {
					this.resolveExitPromise(exitResult);
				}
			};

			const isProcessExiting = error !== undefined && !isErrorInput(error);

			if (isProcessExiting) {
				resolveOrReject();
			} else if (canWriteToStdout && hasWritableState) {
				this.options.stdout.write('', resolveOrReject);
			} else {
				setImmediate(resolveOrReject);
			}
		};

		const concurrentReconciler = reconciler as {
			flushPassiveEffects?: () => boolean;
		};

		if (this.options.concurrent) {
			reconciler.updateContainerSync(null, this.container, null, noop);
			reconciler.flushSyncWork();
			concurrentReconciler.flushPassiveEffects?.();
			finishUnmount();
		} else {
			// Legacy mode: use updateContainerSync + flushSyncWork (sync)
			reconciler.updateContainerSync(null, this.container, null, noop);
			reconciler.flushSyncWork();
			finishUnmount();
		}
	}

	async waitUntilExit(): Promise<unknown> {
		if (!this.beforeExitHandler) {
			this.beforeExitHandler = () => {
				this.unmount();
			};

			process.once('beforeExit', this.beforeExitHandler);
		}

		return this.exitPromise;
	}

	async waitUntilRenderFlush(): Promise<void> {
		if (this.isUnmounted || this.isUnmounting) {
			await this.awaitExit();
			return;
		}

		// Yield to the macrotask queue so that React's scheduler has a chance to
		// fire passive effects and process any work they enqueued.
		await yieldImmediate();

		if (this.isUnmounted || this.isUnmounting) {
			await this.awaitExit();
			return;
		}

		// In concurrent mode, React's scheduler may still be mid-render after
		// the yield. Wait for the next render commit instead of polling.
		if (this.isConcurrent && this.hasPendingConcurrentWork()) {
			await Promise.race([this.awaitNextRender(), this.awaitExit()]);

			if (this.isUnmounted || this.isUnmounting) {
				this.nextRenderCommit = undefined;
				await this.awaitExit();
				return;
			}
		}

		reconciler.flushSyncWork();

		const stdout = this.options.stdout as MaybeWritableStream;
		const {canWriteToStdout, hasWritableState} = getWritableStreamState(stdout);

		// Flush pending throttled render/log timers so their output is included in this wait.
		settleThrottle(this.scheduler, canWriteToStdout);

		if (canWriteToStdout && hasWritableState) {
			await new Promise<void>(resolve => {
				this.options.stdout.write('', () => {
					resolve();
				});
			});
			return;
		}

		await yieldImmediate();
	}

	clear(): void {
		// sid-code（B9 / T3.2）：擦掉当前帧；下一帧按首帧整帧画
		if (this.interactive && !this.options.debug) {
			this.options.stdout.write(eraseMainScreen(this.previousScreen));
			this.previousScreen = undefined;
		}
	}

	patchConsole(): void {
		if (this.options.debug) {
			return;
		}

		this.restoreConsole = patchConsole((stream, data) => {
			if (stream === 'stdout') {
				this.writeToStdout(data);
			}

			if (stream === 'stderr') {
				const isReactMessage = data.startsWith('The above error occurred');

				if (!isReactMessage) {
					this.writeToStderr(data);
				}
			}
		});
	}

	registerInputControl(pauseInput: () => void, resumeInput: () => void): void {
		this.pauseInput = pauseInput;
		this.resumeInput = resumeInput;
	}

	async suspendTerminal(callback: () => void | Promise<void>): Promise<void>;
	async suspendTerminal(): Promise<TerminalSuspension>;
	async suspendTerminal(
		callback?: () => void | Promise<void>,
	): Promise<void | TerminalSuspension> {
		this.beginSuspend();

		if (callback) {
			try {
				await callback();
			} finally {
				await this.endSuspend();
			}

			return undefined;
		}

		const resume = async (): Promise<void> => {
			await this.endSuspend();
		};

		return {resume, [Symbol.asyncDispose]: resume};
	}

	private setAlternateScreen(enabled: boolean): void {
		this.alternateScreen = this.resolveAlternateScreenOption(
			enabled,
			this.interactive,
		);

		if (this.alternateScreen) {
			this.writeBestEffort(
				this.options.stdout,
				ansiEscapes.enterAlternativeScreen,
			);
			this.writeBestEffort(this.options.stdout, hideCursorEscape);
		}
	}

	private resolveInteractiveOption(interactive: boolean | undefined): boolean {
		// sid-code（B9 / T3.2，契约 L5）：只看 stdout.isTTY，不看 CI 环境变量
		return interactive ?? Boolean(this.options.stdout.isTTY);
	}

	private resolveAlternateScreenOption(
		alternateScreen: boolean | undefined,
		interactive: boolean,
	): boolean {
		return (
			Boolean(alternateScreen) &&
			interactive &&
			Boolean(this.options.stdout.isTTY)
		);
	}

	private shouldSync(): boolean {
		return shouldSynchronize(this.options.stdout, this.interactive);
	}

	// sid-code（B9 / T7.2b）：TerminalWriteContext 的值。autoBind 绑定后身份在实例生命周期内不变
	private writeRaw(data: string): void {
		this.options.stdout.write(data);
	}

	// Best-effort write: streams may already be destroyed during shutdown.
	private writeBestEffort(stream: NodeJS.WriteStream, data: string): void {
		try {
			stream.write(data);
		} catch {}
	}

	// Waits for the exit promise to settle, suppressing any rejection.
	// Errors are surfaced via waitUntilExit() instead.
	private async awaitExit(): Promise<void> {
		try {
			await this.exitPromise;
		} catch {}
	}

	private hasPendingConcurrentWork(): boolean {
		const concurrentContainer = this.container as {
			pendingLanes?: number;
			callbackNode?: unknown;
		};
		return (
			(concurrentContainer.pendingLanes ?? 0) !== 0 &&
			concurrentContainer.callbackNode !== undefined &&
			concurrentContainer.callbackNode !== null
		);
	}

	private async awaitNextRender(): Promise<void> {
		if (!this.nextRenderCommit) {
			let resolveRender!: () => void;
			const promise = new Promise<void>(resolve => {
				resolveRender = resolve;
			});
			this.nextRenderCommit = {promise, resolve: resolveRender};
		}

		return this.nextRenderCommit.promise;
	}

	/**
	 * sid-code（B9 / T3.2，契约 R1 / R3–R6）：TTY 帧输出走 cell 级帧 diff（frame/main-screen.ts），
	 * 取代上游 log-update 的整行字符串比较与 `shouldClearTerminalForFrame`。
	 * 每帧一次 write，包在 DEC 2026 同步输出里；没有变化的帧一个字节都不写。
	 * 首帧之后单独写一次隐藏光标（与旧底座同字节）。
	 */
	private renderInteractiveFrame(
		screen: Screen | undefined,
		output: string,
		outputHeight: number,
		staticOutput: string,
		startTime: number,
	): void {
		if (!screen) {
			return;
		}

		if (this.altScreenActive) {
			this.renderAltScreenFrame(screen, output, outputHeight, startTime);
			return;
		}

		let bytes: string;
		const flickers: FrameFlicker[] = [];

		if (staticOutput === '') {
			const diff = this.diffFrame(screen);
			bytes = diff.bytes;
			if (diff.flicker) {
				flickers.push(diff.flicker);
			}
		} else {
			// 上游 <Static> 的新增项：擦掉动态区、写静态输出、整帧重画动态区（端口的 Static 是 T4.2，不走这里）
			bytes =
				eraseMainScreen(this.previousScreen) +
				staticOutput +
				serializeScreen(screen);
		}

		this.previousScreen = screen;
		this.frameViewport = getWindowSize(this.options.stdout);
		this.lastOutput = output;
		this.lastOutputToRender = output + '\n';
		this.lastOutputHeight = outputHeight;

		if (bytes !== '') {
			this.options.stdout.write(bsu + bytes + esu);
		}

		if (!this.cursorHidden) {
			this.options.stdout.write(hideCursorEscape);
			this.cursorHidden = true;
		}

		// 没有变化的帧也回调（与旧底座一致：onFrame 计的是提交后的出帧次数，不是写入次数）
		this.options.onFrame?.({
			durationMs: performance.now() - startTime,
			flickers,
		});
	}

	/**
	 * sid-code（B9 / T6.1a，契约 R14）：alt-screen 出帧。绝对定位、只画视口内的行、视口变了先 `2J`；
	 * 同步输出包裹看终端能力（`altScreenSync`），不像主屏那样一律包。从不记 full reset（onFrame 的 flickers 恒空）。
	 */
	private renderAltScreenFrame(
		screen: Screen,
		output: string,
		outputHeight: number,
		startTime: number,
	): void {
		const viewport = getWindowSize(this.options.stdout);
		const next = clipToViewport(screen, viewport.rows);
		const previous = this.altViewport;
		const erase =
			previous !== undefined &&
			(previous.columns !== viewport.columns || previous.rows !== viewport.rows);
		const bytes = diffAltScreen(
			erase ? undefined : this.altPreviousScreen,
			next,
			viewport.rows,
			erase,
		);
		this.altPreviousScreen = next;
		this.altViewport = viewport;
		// 主屏的帧记录在 alt 期间作废：离开 alt 后按 full reset 画（setAltScreenActive）
		this.previousScreen = undefined;
		this.frameViewport = viewport;
		this.lastOutput = output;
		this.lastOutputToRender = output + '\n';
		this.lastOutputHeight = outputHeight;

		if (bytes !== '') {
			this.options.stdout.write(altScreenSync ? bsu + bytes + esu : bytes);
		}

		if (!this.cursorHidden) {
			this.options.stdout.write(hideCursorEscape);
			this.cursorHidden = true;
		}

		this.options.onFrame?.({
			durationMs: performance.now() - startTime,
			flickers: [],
		});
	}

	/**
	 * sid-code（B9 / T3.3，契约 R7）：视口相对上一帧出帧时**变窄 / 变宽 / 变矮** → full reset（原因 resize），
	 * 不论前一帧是否存在、是否为空；只变高不 reset，照常 diff。其余交给帧 diff（R3–R6）。
	 */
	private diffFrame(screen: Screen): FrameDiff {
		const viewport = getWindowSize(this.options.stdout);
		const previous = this.frameViewport;
		const forced = this.pendingResetReason;
		this.pendingResetReason = undefined;
		if (
			forced ||
			(previous &&
				(viewport.columns !== previous.columns || viewport.rows < previous.rows))
		) {
			return resetMainScreen(screen, viewport.rows, forced ?? 'resize');
		}

		const suspended = this.suspendedScreen;
		this.suspendedScreen = undefined;
		if (suspended && !this.previousScreen) {
			const bytes = redrawAfterSuspend(suspended, screen);
			if (bytes !== undefined) {
				return {bytes};
			}
		}

		return diffMainScreen(this.previousScreen, screen, viewport.rows);
	}

	private initKittyKeyboard(): void {
		// Protocol is opt-in: if kittyKeyboard is not specified, do nothing
		if (!this.options.kittyKeyboard) {
			return;
		}

		const opts = this.options.kittyKeyboard;
		const mode = opts.mode ?? 'auto';

		if (mode === 'disabled') {
			return;
		}

		const flags: KittyFlagName[] = opts.flags ?? ['disambiguateEscapeCodes'];

		// 'enabled' force-enables the protocol as long as both streams are TTYs,
		// regardless of the interactive setting (e.g. even in CI).
		if (mode === 'enabled') {
			if (this.options.stdin.isTTY && this.options.stdout.isTTY) {
				this.enableKittyProtocol(flags);
			}

			return;
		}

		// Auto mode: require interactive + TTY
		if (
			!this.interactive ||
			!this.options.stdin.isTTY ||
			!this.options.stdout.isTTY
		) {
			return;
		}

		// Auto mode: query the terminal for kitty keyboard protocol support.
		// The CSI ? u query is safe to send to any terminal — unsupporting
		// terminals simply won't respond, and the 200ms timeout handles that.
		// This avoids maintaining a hardcoded whitelist of terminal names.
		this.confirmKittySupport(flags);
	}

	private confirmKittySupport(flags: KittyFlagName[]): void {
		const {stdin, stdout} = this.options;

		let responseBuffer: number[] = [];

		const cleanup = (): void => {
			this.cancelKittyDetection = undefined;
			clearTimeout(timer);
			stdin.removeListener('data', onData);

			// Re-emit any buffered data that wasn't the protocol response,
			// so it isn't lost from Ink's normal input pipeline.
			// Clear responseBuffer afterwards to make cleanup idempotent.
			const remaining =
				stripKittyQueryResponsesAndTrailingPartial(responseBuffer);
			responseBuffer = [];
			if (remaining.length > 0) {
				stdin.unshift(Uint8Array.from(remaining));
			}
		};

		const onData = (data: Uint8Array | string): void => {
			const chunk = typeof data === 'string' ? textEncoder.encode(data) : data;
			for (const byte of chunk) {
				responseBuffer.push(byte);
			}

			if (hasCompleteKittyQueryResponse(responseBuffer)) {
				cleanup();
				if (!this.isUnmounted) {
					this.enableKittyProtocol(flags);
				}
			}
		};

		// Attach listener before writing the query so that synchronous
		// or immediate responses are not missed.
		stdin.on('data', onData);
		const timer = setTimeout(cleanup, 200);
		this.cancelKittyDetection = cleanup;

		stdout.write('\u001B[?u');
	}

	private enableKittyProtocol(flags: KittyFlagName[]): void {
		this.options.stdout.write(`\u001B[>${resolveFlags(flags)}u`);
		this.kittyProtocolEnabled = true;
		// Remember the flags so suspendTerminal() can re-enable the same protocol
		// after a child process has had the terminal.
		this.kittyFlags = flags;
	}

	private beginSuspend(): void {
		if (this.isSuspended) {
			throw new Error(
				'The terminal is already suspended. Resume the current suspension before suspending again.',
			);
		}

		this.isSuspended = true;

		if (!this.interactive || this.isUnmounted || this.isUnmounting) {
			return;
		}

		try {
			const stdout = this.options.stdout as MaybeWritableStream;
			const {canWriteToStdout} = getWritableStreamState(stdout);

			// Flush any pending render/log so the child starts from a settled screen.
			settleThrottle(this.scheduler, canWriteToStdout);

			if (canWriteToStdout) {
				// Erase Ink's current frame, then show the cursor and re-arm the hide.
				// The forced redraw on resume hides the cursor again.
				this.options.stdout.write(
					eraseMainScreen(this.previousScreen) + showCursorEscape,
				);
				this.previousScreen = undefined;
				this.cursorHidden = false;

				if (this.kittyProtocolEnabled) {
					this.writeBestEffort(this.options.stdout, '\u001B[<u');
				}

				if (this.alternateScreen) {
					this.writeBestEffort(
						this.options.stdout,
						ansiEscapes.exitAlternativeScreen,
					);
				}
			}

			// Hand input back to the terminal (raw mode off, bracketed paste off).
			this.pauseInput?.();
		} catch (error) {
			// If handing over the terminal fails partway, don't strand the app in a
			// suspended state with no way back. Best-effort reclaim input, clear the
			// flag, and rethrow so the caller sees the failure.
			this.isSuspended = false;

			try {
				this.resumeInput?.();
			} catch {}

			throw error;
		}
	}

	private async endSuspend(): Promise<void> {
		if (!this.isSuspended) {
			return;
		}

		this.isSuspended = false;

		// Reclaim input even mid-unmount: pauseInput already ran in beginSuspend, so
		// restoring it is symmetric regardless of any state change during suspension.
		this.resumeInput?.();

		if (!this.interactive || this.isUnmounted || this.isUnmounting) {
			return;
		}

		const stdout = this.options.stdout as MaybeWritableStream;
		const {canWriteToStdout} = getWritableStreamState(stdout);

		if (canWriteToStdout) {
			if (this.alternateScreen) {
				this.writeBestEffort(
					this.options.stdout,
					ansiEscapes.enterAlternativeScreen,
				);
			}

			if (this.kittyProtocolEnabled && this.kittyFlags) {
				this.writeBestEffort(
					this.options.stdout,
					`\u001B[>${resolveFlags(this.kittyFlags)}u`,
				);
			}
		}

		// Force a full redraw instead of diffing against the stale pre-suspension
		// frame, which the child process may have overwritten. A redraw failure here
		// is best-effort: it must not mask a callback error propagating through the
		// caller's finally block.
		this.lastOutput = '';
		this.lastOutputToRender = '';
		this.lastOutputHeight = 0;
		this.previousScreen = undefined;

		try {
			this.calculateLayout();
			this.onRender();
			await this.waitUntilRenderFlush();
		} catch {}
	}
}
