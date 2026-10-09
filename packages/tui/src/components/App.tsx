import {EventEmitter} from 'node:events';
import process from 'node:process';
import React, {
	type ReactNode,
	useState,
	useRef,
	useCallback,
	useMemo,
	useEffect,
	useInsertionEffect,
} from 'react';
import cliCursor from 'cli-cursor';
import {type CursorPosition} from '../log-update.js';
import {createInputParser} from '../input-parser.js';
import decodeKeypress, {rawInput} from '../parse-keypress.js';
import {InputEvent} from '../input-event.js';
import {scheduleTerminalProbe} from '../terminal-probe.js';
import {
	disableInputModesSequences,
	enableExtendedKeysSequences,
	enableInputModesSequences,
	supportsExtendedKeys,
} from '../terminal/extended-keys.js';
import AppContext, {type SuspendTerminal} from './AppContext.js';
import StdinContext from './StdinContext.js';
import StdoutContext from './StdoutContext.js';
import StderrContext from './StderrContext.js';
import FocusContext from './FocusContext.js';
import AnimationContext from './AnimationContext.js';
import CursorContext from './CursorContext.js';
import ErrorBoundary from './ErrorBoundary.js';
import {keepsNativeCursor} from '../cursor-helpers.js';

const tab = '\t';
const shiftTab = '\u001B[Z';
const escape = '\u001B';

type AnimationSubscriber = {
	readonly callback: (currentTime: number) => void;
	readonly interval: number;
	readonly startTime: number;
	nextDueTime: number;
};

type Props = {
	readonly children: ReactNode;
	readonly stdin: NodeJS.ReadStream;
	readonly stdout: NodeJS.WriteStream;
	readonly stderr: NodeJS.WriteStream;
	readonly writeToStdout: (data: string) => void;
	readonly writeToStderr: (data: string) => void;
	readonly exitOnCtrlC: boolean;
	readonly onExit: (errorOrResult?: unknown) => void;
	readonly onWaitUntilRenderFlush: () => Promise<void>;
	readonly onSuspendTerminal: SuspendTerminal;
	readonly onRegisterInputControl: (
		pauseInput: () => void,
		resumeInput: () => void,
		pauseForHandoff?: () => void,
		resumeFromHandoff?: () => void,
	) => void;
	/** stdin 静默超过阈值后的第一块输入（I1c）：由 Ink 决定要重申哪些终端模式 */
	readonly onStdinResume?: () => void;
	/** SGR 鼠标序列（`ESC [ <`）原样交给 Ink：选区与超链接点击在那里处理（B9 / T6.2b，M2–M5） */
	readonly onMouseSequence?: (sequence: string) => void;
	readonly setCursorPosition: (position: CursorPosition | undefined) => void;
	readonly interactive: boolean;
	readonly renderThrottleMs: number;
};

type Focusable = {
	readonly id: string;
	readonly isActive: boolean;
};

// Root component for all Ink apps
// It renders stdin and stdout contexts, so that children can access them if needed
// It also handles Ctrl+C exiting and cursor visibility
function App({
	children,
	stdin,
	stdout,
	stderr,
	writeToStdout,
	writeToStderr,
	exitOnCtrlC,
	onExit,
	onWaitUntilRenderFlush,
	onSuspendTerminal,
	onRegisterInputControl,
	onStdinResume,
	onMouseSequence,
	setCursorPosition,
	interactive,
	renderThrottleMs,
}: Props): React.ReactNode {
	const [isFocusEnabled, setIsFocusEnabled] = useState(true);
	const [activeFocusId, setActiveFocusId] = useState<string | undefined>(
		undefined,
	);
	// Focusables array is managed internally via setFocusables callback pattern
	// eslint-disable-next-line react/hook-use-state
	const [, setFocusables] = useState<Focusable[]>([]);
	// Track focusables count for tab navigation check (avoids stale closure)
	const focusablesCountRef = useRef(0);
	const animationSubscribersRef = useRef(
		new Map<(currentTime: number) => void, AnimationSubscriber>(),
	);
	const animationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	// Count how many components enabled raw mode to avoid disabling
	// raw mode until all components don't need it anymore
	// sid-code（B9 / T5.1c，契约 I9）：计数是普通整数，多余的 `setRawMode(false)` 会把它压成负数，
	// 之后要补回同样多次 `true` 才会真正打开（与旧底座一致）
	const rawModeEnabledCount = useRef(0);
	// Count how many components enabled bracketed paste mode
	const bracketedPasteModeEnabledCount = useRef(0);
	// eslint-disable-next-line @typescript-eslint/naming-convention
	const internal_eventEmitter = useRef(new EventEmitter());
	// Each useInput hook adds a listener, so the count can legitimately exceed the default limit of 10.
	internal_eventEmitter.current.setMaxListeners(Infinity);
	// Store the currently attached readable listener to avoid stale closure issues
	const readableListenerRef = useRef<(() => void) | undefined>(undefined);
	const attachReadableListenerRef = useRef<(() => void) | undefined>(undefined);
	const inputParserRef = useRef(createInputParser());
	const pendingInputFlushRef = useRef<NodeJS.Timeout | undefined>(undefined);
	// Small delay to let chunked escape sequences complete before flushing as literal input.
	// sid-code（T5.1b，I8）：上游 20ms；旧底座在 40ms 与 60ms 之间冲刷，取 50ms
	const pendingInputFlushDelayMilliseconds = 50;
	// sid-code（B9 / T5.1d，契约 I1c）：stdin 静默多久之后的第一块输入要先重申终端模式
	// （期间可能有外部程序改过）。旧底座实测：严格大于 5000ms；起点是挂载时刻而不是打开 raw mode 的时刻；
	// 读到的每一块都刷新时间戳，包括重新启用时被丢弃的那块
	const stdinResumeThresholdMilliseconds = 5000;
	const lastStdinChunkAtRef = useRef(Date.now());

	const clearPendingInputFlush = useCallback((): void => {
		if (!pendingInputFlushRef.current) {
			return;
		}

		clearTimeout(pendingInputFlushRef.current);
		pendingInputFlushRef.current = undefined;
	}, []);

	const clearAnimationTimer = useCallback((): void => {
		if (!animationTimerRef.current) {
			return;
		}

		clearTimeout(animationTimerRef.current);
		animationTimerRef.current = undefined;
	}, []);

	const scheduleAnimationTick = useCallback((): void => {
		clearAnimationTimer();

		if (animationSubscribersRef.current.size === 0) {
			return;
		}

		let nextDueTime = Number.POSITIVE_INFINITY;

		for (const subscriber of animationSubscribersRef.current.values()) {
			// One shared timer is enough as long as it wakes at the earliest
			// subscriber deadline and lets slower animations skip that tick.
			nextDueTime = Math.min(nextDueTime, subscriber.nextDueTime);
		}

		const delay = Math.max(0, nextDueTime - performance.now());
		animationTimerRef.current = setTimeout(() => {
			animationTimerRef.current = undefined;
			const currentTime = performance.now();

			for (const subscriber of animationSubscribersRef.current.values()) {
				if (currentTime < subscriber.nextDueTime) {
					continue;
				}

				subscriber.callback(currentTime);
				const elapsedTime = currentTime - subscriber.startTime;
				const elapsedFrames = Math.floor(elapsedTime / subscriber.interval) + 1;
				// Advance from elapsed time rather than callback count so delayed
				// ticks catch up instead of stretching the animation timeline.
				subscriber.nextDueTime =
					subscriber.startTime + elapsedFrames * subscriber.interval;
			}

			scheduleAnimationTick();
		}, delay);
		// Keep the timer ref'd while animations are active so `useAnimation()`
		// can drive process lifetime in both interactive and non-interactive apps.
	}, [clearAnimationTimer]);

	const animationSubscribe = useCallback(
		(
			callback: (currentTime: number) => void,
			interval: number,
		): {readonly startTime: number; readonly unsubscribe: () => void} => {
			const startTime = performance.now();
			// The scheduler owns the start timestamp so hooks can derive frames from
			// the exact same origin that determines each subscriber's due time.
			animationSubscribersRef.current.set(callback, {
				callback,
				interval,
				startTime,
				nextDueTime: startTime + interval,
			});
			scheduleAnimationTick();

			return {
				startTime,
				unsubscribe() {
					animationSubscribersRef.current.delete(callback);

					if (animationSubscribersRef.current.size === 0) {
						clearAnimationTimer();
						return;
					}

					scheduleAnimationTick();
				},
			};
		},
		[clearAnimationTimer, scheduleAnimationTick],
	);

	useEffect(() => {
		return () => {
			clearAnimationTimer();
		};
	}, [clearAnimationTimer]);

	// Determines if TTY is supported on the provided stdin
	const isRawModeSupported = stdin.isTTY;

	const detachReadableListener = useCallback((): void => {
		if (!readableListenerRef.current) {
			return;
		}

		stdin.removeListener('readable', readableListenerRef.current);
		readableListenerRef.current = undefined;
	}, [stdin]);

	const clearInputState = useCallback((): void => {
		inputParserRef.current.reset();
		clearPendingInputFlush();
		detachReadableListener();
	}, [clearPendingInputFlush, detachReadableListener]);

	// sid-code（B9 / T5.3a，契约 I4）：输入相关的终端模式跟着 raw mode 计数开关，每段一次独立写入。
	// 旧底座实测：stdout 非 TTY 也写；开在 `ref` + `setRawMode(true)` 之后，关在 `setRawMode(false)` 之前
	const writeModeSequences = useCallback(
		(sequences: readonly string[]): void => {
			for (const sequence of sequences) {
				try {
					stdout.write(sequence);
				} catch {}
			}
		},
		[stdout],
	);

	const enableInputModes = useCallback((): void => {
		writeModeSequences(enableInputModesSequences);
		if (supportsExtendedKeys()) {
			writeModeSequences(enableExtendedKeysSequences);
		}
	}, [writeModeSequences]);

	// sid-code（T5.1c，I10）：计数归零时只关 raw mode、摘 readable，不清解析器状态也不取消待冲刷的 ESC ——
	// 同一次提交里换了一个 `useInput` 组件时，切换前缓冲的半截转义仍会冲刷给新组件（旧底座如此）。
	// I4：先关模式（扩展键开没开都关）再关 raw mode
	const releaseRawMode = useCallback((): void => {
		writeModeSequences(disableInputModesSequences);
		stdin.setRawMode(false);
		stdin.unref();
		detachReadableListener();
	}, [stdin, detachReadableListener, writeModeSequences]);

	// 退出 / 卸载：彻底放手，连解析器状态一起清掉
	const disableRawMode = useCallback((): void => {
		releaseRawMode();
		rawModeEnabledCount.current = 0;
		clearInputState();
	}, [releaseRawMode, clearInputState]);

	const handleExit = useCallback(
		(errorOrResult?: unknown): void => {
			if (isRawModeSupported && rawModeEnabledCount.current > 0) {
				disableRawMode();
			}

			onExit(errorOrResult);
		},
		[isRawModeSupported, disableRawMode, onExit],
	);

	const handleInput = useCallback(
		(input: string): void => {
			// Exit on Ctrl+C
			// eslint-disable-next-line unicorn/no-hex-escape
			if (input === '\x03' && exitOnCtrlC) {
				handleExit();
				return;
			}

			// Reset focus when there's an active focused component on Esc
			if (input === escape && isFocusEnabled) {
				setActiveFocusId(undefined);
			}
		},
		[exitOnCtrlC, handleExit, isFocusEnabled],
	);

	// sid-code（B9 / T5.1c，契约 I11）：解码在这里做一次，`input` 事件发的是 `InputEvent` 对象。
	// `raw` 为真时不做按键解码、原样交出（多字符文本、粘贴内容，T5.1b / I8）。
	// 逐个调监听者而不是 `emit`：某个监听者 `stopImmediatePropagation()` 后，后面的都不再收到
	// Tab 焦点导航直接调，不挂在 emitter 上：旧底座的 emitter 上只有使用方自己挂的监听（I11 数过 listenerCount）
	const tabNavigationRef = useRef<((event: InputEvent) => void) | undefined>(undefined);

	// sid-code（B9 / T5.1e，契约 I7）：Ctrl+Z 挂起 / SIGCONT 恢复。规则全部来自旧底座黑盒探针（D-5）：
	// - 只认解码后 `ctrl && input === 'z'` 的按键（`\x1a`、kitty / modifyOtherKeys 的 Ctrl+Z，叠加 shift / meta /
	//   super 也算；release / repeat 事件、文本块、粘贴里的 `\x1a` 都不算），这个按键不交给任何监听者，同块其余事件照常；
	// - 挂起：先写关模式序列（stdout 非 TTY 也写这 4 段），再关 raw mode、`unref`、摘 readable，TTY 再补光标与鼠标跟踪，
	//   挂一次性 SIGCONT 监听后给自己发 SIGSTOP；计数不动（组件仍"持有" raw mode）；
	// - 恢复：先 `ref` + 开 raw mode + 挂 readable（挂起期间缓冲的字节此时交出），再写重开序列；
	// - 挂起期间卸载：不再碰 stdin，那条一次性监听留着、触发时什么都不做（旧底座 SIGCONT 监听数只 -1）。
	// 终端探查（`>0q` / DA1）在恢复路径上也会再发一次（I2，见 terminal-probe.ts）。
	const isSuspendedRef = useRef(false);
	const isAppUnmountedRef = useRef(false);
	// sid-code（B9 / T6.1b，契约 X5）：外部编辑器占着终端。期间不读 stdin（字节留在流里，交还后再交出）
	const isHandoffRef = useRef(false);
	const handoffPausedRawRef = useRef(false);
	const writeStdout = useCallback(
		(data: string): void => {
			try {
				stdout.write(data);
			} catch {}
		},
		[stdout],
	);

	const resumeFromSuspend = useCallback((): void => {
		if (isAppUnmountedRef.current || !isSuspendedRef.current) {
			return;
		}

		isSuspendedRef.current = false;
		// I4：输入模式只在计数仍 > 0 时重开（与 0 → 1 同一套，含扩展键）；挂起期间计数降到 0 的不写
		if (rawModeEnabledCount.current > 0) {
			stdin.setEncoding('utf8');
			stdin.ref();
			stdin.setRawMode(true);
			attachReadableListenerRef.current?.();
			enableInputModes();
		}

		if (stdout.isTTY) {
			// O5：无障碍模式下恢复时也不隐藏光标（focus reporting 照开）
			writeModeSequences(
				keepsNativeCursor()
					? ['\u001B[?1004h']
					: ['\u001B[?25l', '\u001B[?1004h'],
			);
		}

		// I2：恢复时计数仍 > 0 才重新探查（计数为 0 时旧底座不发）
		if (rawModeEnabledCount.current > 0) {
			scheduleTerminalProbe(stdout);
		}
	}, [stdin, stdout, enableInputModes, writeModeSequences]);

	const suspendProcess = useCallback((): void => {
		writeModeSequences(disableInputModesSequences);
		stdin.setRawMode(false);
		stdin.unref();
		detachReadableListener();
		if (stdout.isTTY) {
			writeStdout(
				'\u001B[?25h\u001B[?1004l\u001B[?1007l\u001B[?1006l\u001B[?1003l\u001B[?1002l\u001B[?1000l',
			);
		}

		isSuspendedRef.current = true;
		// 必须在 SIGSTOP 之前挂：进程恢复时第一件事就是派发 SIGCONT
		process.once('SIGCONT', resumeFromSuspend);
		process.kill(process.pid, 'SIGSTOP');
	}, [
		stdin,
		stdout,
		writeStdout,
		writeModeSequences,
		detachReadableListener,
		resumeFromSuspend,
	]);

	const emitInput = useCallback(
		(input: string, raw = false, isPasted = false): void => {
			handleInput(input);
			if (!raw && input.startsWith('\u001B[<')) onMouseSequence?.(input);
			const decoded = raw ? rawInput(input) : decodeKeypress(input);
			if (!decoded) return;
			if (!raw && decoded.key.ctrl && decoded.input === 'z') {
				suspendProcess();
				return;
			}

			const event = new InputEvent(input, decoded.input, decoded.key, isPasted);
			tabNavigationRef.current?.(event);
			for (const listener of internal_eventEmitter.current.listeners('input')) {
				if (event._didStopImmediatePropagation) break;
				(listener as (event: InputEvent) => void)(event);
			}
		},
		[handleInput, suspendProcess, onMouseSequence],
	);

	const schedulePendingInputFlush = useCallback((): void => {
		clearPendingInputFlush();
		pendingInputFlushRef.current = setTimeout(() => {
			pendingInputFlushRef.current = undefined;
			const pendingEscape = inputParserRef.current.flushPendingEscape();
			if (!pendingEscape) {
				return;
			}

			try {
				if (typeof pendingEscape === 'string') {
					emitInput(pendingEscape);
				} else if ('text' in pendingEscape) {
					emitInput(pendingEscape.text, true);
				}
			} catch (error) {
				console.error('[ink:error]', error);
			}
		}, pendingInputFlushDelayMilliseconds);
	}, [clearPendingInputFlush, emitInput]);

	const noteStdinChunk = useCallback((): void => {
		const now = Date.now();
		if (now - lastStdinChunkAtRef.current > stdinResumeThresholdMilliseconds) {
			onStdinResume?.();
		}

		lastStdinChunkAtRef.current = now;
	}, [onStdinResume]);

	const handleReadable = useCallback((): void => {
		clearPendingInputFlush();
		// sid-code（T5.1c，I1b / I8）：`useInput` 回调抛错会冒出 emit，同一块里剩下的事件（以及后面的监听者）
		// 全部作废，只打 `[ink:error]`，不退出（旧底座实测：`x\x1b[Ab` 里 x 抛错，只有 x 被收到）
		try {
			let chunk;
			let isFirstChunk = true;
			// eslint-disable-next-line @typescript-eslint/no-restricted-types
			while (
				!isSuspendedRef.current &&
				!isHandoffRef.current &&
				(chunk = stdin.read() as string | null) !== null
			) {
				if (isFirstChunk) {
					isFirstChunk = false;
					noteStdinChunk();
				}

				const inputEvents = inputParserRef.current.push(chunk);
				for (const event of inputEvents) {
					if (typeof event === 'string') {
						emitInput(event);
					} else if ('text' in event) {
						emitInput(event.text, true);
					} else {
						// Keep paste on a separate channel from `useInput` so key handlers
						// don't need to branch on mixed key-vs-paste event shapes.
						if (internal_eventEmitter.current.listenerCount('paste') === 0) {
							emitInput(event.paste, true, true);
							continue;
						}

						internal_eventEmitter.current.emit('paste', event.paste);
					}
				}
			}
		} catch (error) {
			console.error('[ink:error]', error);
			// Bun 下回调抛错后监听可能被摘掉，流从此卡死：还该挂着就重新挂上
			const listener = readableListenerRef.current;
			if (listener && !stdin.listeners('readable').includes(listener)) {
				stdin.addListener('readable', listener);
			}
		}

		if (inputParserRef.current.hasPendingEscape()) {
			schedulePendingInputFlush();
		}
	}, [stdin, emitInput, clearPendingInputFlush, schedulePendingInputFlush, noteStdinChunk]);

	const attachReadableListener = useCallback((): void => {
		if (readableListenerRef.current) {
			return;
		}

		// Store the listener reference to avoid stale closure when removing
		readableListenerRef.current = handleReadable;
		stdin.addListener('readable', handleReadable);
	}, [stdin, handleReadable]);
	// 恢复路径（I7）比 handleReadable 定义得早，经 ref 拿最新的挂接函数
	attachReadableListenerRef.current = attachReadableListener;

	const handleSetRawMode = useCallback(
		(isEnabled: boolean): void => {
			if (!isRawModeSupported) {
				if (stdin === process.stdin) {
					throw new Error(
						'Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported',
					);
				} else {
					throw new Error(
						'Raw mode is not supported on the stdin provided to Ink.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported',
					);
				}
			}

			stdin.setEncoding('utf8');

			// I7：挂起期间只记账不碰 stdin（旧底座实测：挂起时卸载，`setRawMode` / `unref` 一次都不调）；
			// 恢复时按计数决定要不要重开
			if (isSuspendedRef.current) {
				rawModeEnabledCount.current += isEnabled ? 1 : -1;
				return;
			}

			if (isEnabled) {
				if (++rawModeEnabledCount.current === 1) {
					stdin.ref();
					stdin.setRawMode(true);
					attachReadableListener();
					// I4：bracketed paste / focus（扩展键按 supportsExtendedKeys），写在探查之前
					enableInputModes();
					// I2：每次 0 → 1 都探查一次（不只首次挂载）
					scheduleTerminalProbe(stdout);
				}

				return;
			}

			// 同步关（旧底座实测：调用返回时 raw mode 已关；同一提交换组件会出现一次关→开）
			if (--rawModeEnabledCount.current === 0) {
				releaseRawMode();
			}
		},
		[
			isRawModeSupported,
			stdin,
			stdout,
			attachReadableListener,
			releaseRawMode,
			enableInputModes,
		],
	);

	const handleSetBracketedPasteMode = useCallback(
		(isEnabled: boolean): void => {
			if (!stdout.isTTY) {
				return;
			}

			if (isEnabled) {
				if (bracketedPasteModeEnabledCount.current === 0) {
					stdout.write('\u001B[?2004h');
				}

				bracketedPasteModeEnabledCount.current++;
				return;
			}

			if (bracketedPasteModeEnabledCount.current === 0) {
				return;
			}

			if (--bracketedPasteModeEnabledCount.current === 0) {
				stdout.write('\u001B[?2004l');
			}
		},
		[stdout],
	);

	// Remembers which input modes were active so resumeInput can reinstate exactly
	// those after a terminal suspension, without touching the ref counts (the React
	// components still "own" raw mode/bracketed paste across the suspension).
	const suspendedInputStateRef = useRef({
		rawMode: false,
		bracketedPaste: false,
	});

	const pauseInput = useCallback((): void => {
		const wasRawMode = isRawModeSupported && rawModeEnabledCount.current > 0;
		const wasBracketedPaste = bracketedPasteModeEnabledCount.current > 0;
		suspendedInputStateRef.current = {
			rawMode: wasRawMode,
			bracketedPaste: wasBracketedPaste,
		};

		if (wasBracketedPaste && stdout.isTTY) {
			try {
				stdout.write('\u001B[?2004l');
			} catch {}
		}

		if (wasRawMode) {
			stdin.setRawMode(false);
			stdin.unref();
			clearInputState();
		}
	}, [isRawModeSupported, stdin, stdout, clearInputState]);

	const resumeInput = useCallback((): void => {
		const {rawMode, bracketedPaste} = suspendedInputStateRef.current;

		if (rawMode) {
			stdin.setEncoding('utf8');
			stdin.ref();
			stdin.setRawMode(true);
			attachReadableListener();
		}

		if (bracketedPaste && stdout.isTTY) {
			try {
				stdout.write('\u001B[?2004h');
			} catch {}
		}
	}, [stdin, stdout, attachReadableListener]);

	// Register input pause/resume in an insertion effect: it runs before every
	// passive effect (parent and child), so a child that calls suspendTerminal()
	// from its own effect always finds the input control already registered. A
	// normal effect would run too late (child effects fire before the parent's).
	// sid-code（B9 / T6.1b，契约 X5）：外部编辑器 handoff 的输入让渡。与 pauseInput 不同（旧底座黑盒探针，D-5）：
	// 只关 raw mode，不 `unref`、不摘 readable、不清解析器、不写 bracketed paste；期间到达的输入不丢，交还后再交出。
	// 计数为 0（没人要 raw mode）时什么都不做。重复让渡只关一次
	const pauseForHandoff = useCallback((): void => {
		isHandoffRef.current = true;
		if (
			!isRawModeSupported ||
			handoffPausedRawRef.current ||
			rawModeEnabledCount.current <= 0
		) {
			return;
		}

		handoffPausedRawRef.current = true;
		stdin.setRawMode(false);
	}, [isRawModeSupported, stdin]);

	const resumeFromHandoff = useCallback((): void => {
		isHandoffRef.current = false;
		const resumed = handoffPausedRawRef.current;
		handoffPausedRawRef.current = false;
		if (resumed && !isAppUnmountedRef.current) {
			stdin.setRawMode(true);
		}

		// 让渡期间缓冲的输入：异步交出（旧底座在 exitAlternateScreen 返回之后才送到 useInput）
		setImmediate(() => {
			if (!isAppUnmountedRef.current && readableListenerRef.current) {
				readableListenerRef.current();
			}
		});
	}, [stdin]);

	useInsertionEffect(() => {
		onRegisterInputControl(
			pauseInput,
			resumeInput,
			pauseForHandoff,
			resumeFromHandoff,
		);
	}, [
		onRegisterInputControl,
		pauseInput,
		resumeInput,
		pauseForHandoff,
		resumeFromHandoff,
	]);

	// Focus navigation helpers
	const findNextFocusable = useCallback(
		(
			currentFocusables: Focusable[],
			currentActiveFocusId: string | undefined,
		): string | undefined => {
			const activeIndex = currentFocusables.findIndex(focusable => {
				return focusable.id === currentActiveFocusId;
			});

			for (
				let index = activeIndex + 1;
				index < currentFocusables.length;
				index++
			) {
				const focusable = currentFocusables[index];

				if (focusable?.isActive) {
					return focusable.id;
				}
			}

			return undefined;
		},
		[],
	);

	const findPreviousFocusable = useCallback(
		(
			currentFocusables: Focusable[],
			currentActiveFocusId: string | undefined,
		): string | undefined => {
			const activeIndex = currentFocusables.findIndex(focusable => {
				return focusable.id === currentActiveFocusId;
			});

			for (let index = activeIndex - 1; index >= 0; index--) {
				const focusable = currentFocusables[index];

				if (focusable?.isActive) {
					return focusable.id;
				}
			}

			return undefined;
		},
		[],
	);

	const focusNext = useCallback((): void => {
		setFocusables(currentFocusables => {
			setActiveFocusId(currentActiveFocusId => {
				const firstFocusableId = currentFocusables.find(
					focusable => focusable.isActive,
				)?.id;
				const nextFocusableId = findNextFocusable(
					currentFocusables,
					currentActiveFocusId,
				);

				return nextFocusableId ?? firstFocusableId;
			});
			return currentFocusables;
		});
	}, [findNextFocusable]);

	const focusPrevious = useCallback((): void => {
		setFocusables(currentFocusables => {
			setActiveFocusId(currentActiveFocusId => {
				const lastFocusableId = currentFocusables.findLast(
					focusable => focusable.isActive,
				)?.id;
				const previousFocusableId = findPreviousFocusable(
					currentFocusables,
					currentActiveFocusId,
				);

				return previousFocusableId ?? lastFocusableId;
			});
			return currentFocusables;
		});
	}, [findPreviousFocusable]);

	// Handle tab navigation via effect that subscribes to input events
	useEffect(() => {
		const handleTabNavigation = ({keypress}: InputEvent): void => {
			const input = keypress.sequence;
			if (!isFocusEnabled || focusablesCountRef.current === 0) return;

			if (input === tab) {
				focusNext();
			}

			if (input === shiftTab) {
				focusPrevious();
			}
		};

		tabNavigationRef.current = handleTabNavigation;

		return () => {
			if (tabNavigationRef.current === handleTabNavigation) {
				tabNavigationRef.current = undefined;
			}
		};
	}, [isFocusEnabled, focusNext, focusPrevious]);

	const enableFocus = useCallback((): void => {
		setIsFocusEnabled(true);
	}, []);

	const disableFocus = useCallback((): void => {
		setIsFocusEnabled(false);
	}, []);

	const focus = useCallback((id: string): void => {
		setFocusables(currentFocusables => {
			const hasFocusableId = currentFocusables.some(
				focusable => focusable?.id === id,
			);

			if (hasFocusableId) {
				setActiveFocusId(id);
			}

			return currentFocusables;
		});
	}, []);

	const addFocusable = useCallback(
		(id: string, {autoFocus}: {autoFocus: boolean}): void => {
			setFocusables(currentFocusables => {
				focusablesCountRef.current = currentFocusables.length + 1;

				return [
					...currentFocusables,
					{
						id,
						isActive: true,
					},
				];
			});

			if (autoFocus) {
				setActiveFocusId(currentActiveFocusId => {
					if (!currentActiveFocusId) {
						return id;
					}

					return currentActiveFocusId;
				});
			}
		},
		[],
	);

	const removeFocusable = useCallback((id: string): void => {
		setActiveFocusId(currentActiveFocusId => {
			if (currentActiveFocusId === id) {
				return undefined;
			}

			return currentActiveFocusId;
		});

		setFocusables(currentFocusables => {
			const filtered = currentFocusables.filter(focusable => {
				return focusable.id !== id;
			});
			focusablesCountRef.current = filtered.length;

			return filtered;
		});
	}, []);

	const activateFocusable = useCallback((id: string): void => {
		setFocusables(currentFocusables =>
			currentFocusables.map(focusable => {
				if (focusable.id !== id) {
					return focusable;
				}

				return {
					id,
					isActive: true,
				};
			}),
		);
	}, []);

	const deactivateFocusable = useCallback((id: string): void => {
		setActiveFocusId(currentActiveFocusId => {
			if (currentActiveFocusId === id) {
				return undefined;
			}

			return currentActiveFocusId;
		});

		setFocusables(currentFocusables =>
			currentFocusables.map(focusable => {
				if (focusable.id !== id) {
					return focusable;
				}

				return {
					id,
					isActive: false,
				};
			}),
		);
	}, []);

	// Handle cursor visibility, raw mode, and bracketed paste mode cleanup on unmount
	useEffect(() => {
		return () => {
			const canWriteToStdout = !stdout.destroyed && !stdout.writableEnded;

			if (interactive && canWriteToStdout) {
				cliCursor.show(stdout);
			}

			isAppUnmountedRef.current = true;
			if (isSuspendedRef.current) {
				// I7：挂起时 raw mode 已关、已 unref，旧底座卸载时不再碰 stdin
				rawModeEnabledCount.current = 0;
				clearInputState();
			} else if (isRawModeSupported && rawModeEnabledCount.current > 0) {
				disableRawMode();
			} else {
				clearInputState();
			}

			if (bracketedPasteModeEnabledCount.current > 0) {
				if (stdout.isTTY && canWriteToStdout) {
					stdout.write('\u001B[?2004l');
				}

				bracketedPasteModeEnabledCount.current = 0;
			}
		};
	}, [stdout, isRawModeSupported, disableRawMode, clearInputState, interactive]);

	// Memoize context values to prevent unnecessary re-renders
	const appContextValue = useMemo(
		() => ({
			exit: handleExit,
			waitUntilRenderFlush: onWaitUntilRenderFlush,
			suspendTerminal: onSuspendTerminal,
		}),
		[handleExit, onWaitUntilRenderFlush, onSuspendTerminal],
	);

	const stdinContextValue = useMemo(
		() => ({
			stdin,
			setRawMode: handleSetRawMode,
			setBracketedPasteMode: handleSetBracketedPasteMode,
			isRawModeSupported,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			internal_exitOnCtrlC: exitOnCtrlC,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			internal_eventEmitter: internal_eventEmitter.current,
		}),
		[
			stdin,
			handleSetRawMode,
			handleSetBracketedPasteMode,
			isRawModeSupported,
			exitOnCtrlC,
		],
	);

	const stdoutContextValue = useMemo(
		() => ({
			stdout,
			write: writeToStdout,
		}),
		[stdout, writeToStdout],
	);

	const stderrContextValue = useMemo(
		() => ({
			stderr,
			write: writeToStderr,
		}),
		[stderr, writeToStderr],
	);

	const cursorContextValue = useMemo(
		() => ({
			setCursorPosition,
		}),
		[setCursorPosition],
	);

	const focusContextValue = useMemo(
		() => ({
			activeId: activeFocusId,
			add: addFocusable,
			remove: removeFocusable,
			activate: activateFocusable,
			deactivate: deactivateFocusable,
			enableFocus,
			disableFocus,
			focusNext,
			focusPrevious,
			focus,
		}),
		[
			activeFocusId,
			addFocusable,
			removeFocusable,
			activateFocusable,
			deactivateFocusable,
			enableFocus,
			disableFocus,
			focusNext,
			focusPrevious,
			focus,
		],
	);

	const animationContextValue = useMemo(
		() => ({
			renderThrottleMs,
			subscribe: animationSubscribe,
		}),
		[animationSubscribe, renderThrottleMs],
	);

	return (
		<AppContext.Provider value={appContextValue}>
			<StdinContext.Provider value={stdinContextValue}>
				<StdoutContext.Provider value={stdoutContextValue}>
					<StderrContext.Provider value={stderrContextValue}>
						<FocusContext.Provider value={focusContextValue}>
							<AnimationContext.Provider value={animationContextValue}>
								<CursorContext.Provider value={cursorContextValue}>
									<ErrorBoundary onError={handleExit}>{children}</ErrorBoundary>
								</CursorContext.Provider>
							</AnimationContext.Provider>
						</FocusContext.Provider>
					</StderrContext.Provider>
				</StdoutContext.Provider>
			</StdinContext.Provider>
		</AppContext.Provider>
	);
}

App.displayName = 'InternalApp';

export default App;
