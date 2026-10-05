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
import {diffMainScreen, eraseMainScreen, type FrameFlicker} from './frame/main-screen.js';
import {FrameScheduler} from './frame/scheduler.js';
import {FRAME_INTERVAL_MS} from './frame/schedule.js';
import {ClockContext, createClock, type Clock} from './clock.js';
import {type Screen} from './screen/screen.js';
import {serializeScreen} from './screen/serialize.js';
import App from './components/App.js';
import {type TerminalSuspension} from './components/AppContext.js';
import {accessibilityContext as AccessibilityContext} from './components/AccessibilityContext.js';
import {
	type KittyKeyboardOptions,
	type KittyFlagName,
	resolveFlags,
} from './kitty-keyboard.js';

const noop = () => {};
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

	resized = () => {
		const currentWidth = getWindowSize(this.options.stdout).columns;

		// sid-code（B9 / T3.2）：宽度变化由帧 diff 判 full reset（原因 resize），这里不再先擦屏。
		// 连续 resize 合并、视口变矮等归 T3.3。
		this.calculateLayout();
		dom.emitLayoutListeners(this.rootNode);
		this.onRender();

		this.lastTerminalWidth = currentWidth;
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
		const {output, outputHeight, staticOutput, screen} = render(
			this.rootNode,
			this.isScreenReaderEnabled,
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
				>
					{node}
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
					this.options.stdout.write(bsu + showCursorEscape + esu);
					this.cursorHidden = false;
					this.previousScreen = undefined;
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

		const viewportRows = getWindowSize(this.options.stdout).rows;
		let bytes: string;
		const flickers: FrameFlicker[] = [];

		if (staticOutput === '') {
			const diff = diffMainScreen(this.previousScreen, screen, viewportRows);
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
