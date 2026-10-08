import process from 'node:process';
import ansiEscapes from 'ansi-escapes';

export type CursorPosition = {
	x: number;
	y: number;
};

const showCursorEscape = '\u001B[?25h';
const hideCursorEscape = '\u001B[?25l';

export {showCursorEscape, hideCursorEscape};

/**
 * sid-code（B9 / T7.2c，契约 O5）：无障碍模式下保留终端原生光标（屏幕放大器要跟踪它），底座不隐藏。
 *
 * 规则来自黑盒对拍旧底座（D-5）：取值按「非空、且不是 `0` / `false` / `no`（不分大小写）」判真，`abc`、空格也算开；
 * **每次要隐藏时读**。只管两处：首帧后的隐藏、Ctrl+Z 挂起后 SIGCONT 恢复时的隐藏；外部编辑器交还终端
 * （`exitAlternateScreen`）照旧隐藏，旧底座如此。
 *
 * 变量名按 D125 改成 `SID_CODE_ACCESSIBILITY`；旧名 `CLAUDE_CODE_ACCESSIBILITY` 仍然认，新名设置了（含空串）就以新名为准，
 * 与 `colorize.ts` 的 `SID_CODE_TMUX_TRUECOLOR` 同一口径。T9 删除旧底座时去掉旧名。
 * 注意它和 CLI 的 `SID_ACCESSIBILITY`（`ui/accessibility/detect.ts`，关动画）是两个开关，旧底座也不认后者。
 */
export function keepsNativeCursor(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const value =
		env['SID_CODE_ACCESSIBILITY'] ?? env['CLAUDE_CODE_ACCESSIBILITY'];
	if (!value) return false;
	const v = value.toLowerCase();
	return v !== '0' && v !== 'false' && v !== 'no';
}

/**
Compare two cursor positions. Returns true if they differ.
*/
export const cursorPositionChanged = (
	a: CursorPosition | undefined,
	b: CursorPosition | undefined,
): boolean => a?.x !== b?.x || a?.y !== b?.y;

/**
Build escape sequence to move cursor from bottom of output to the target position and show it.
Assumes cursor is at (col 0, line visibleLineCount) — i.e. just after the last output line.
*/
export const buildCursorSuffix = (
	visibleLineCount: number,
	cursorPosition: CursorPosition | undefined,
): string => {
	if (!cursorPosition) {
		return '';
	}

	const moveUp = visibleLineCount - cursorPosition.y;
	return (
		(moveUp > 0 ? ansiEscapes.cursorUp(moveUp) : '') +
		ansiEscapes.cursorTo(cursorPosition.x) +
		showCursorEscape
	);
};

/**
Build escape sequence to move cursor from previousCursorPosition back to the bottom of output.
This must be done before eraseLines or any operation that assumes cursor is at the bottom.
*/
export const buildReturnToBottom = (
	previousLineCount: number,
	previousCursorPosition: CursorPosition | undefined,
): string => {
	if (!previousCursorPosition) {
		return '';
	}

	// PreviousLineCount includes trailing newline, so visible lines = previousLineCount - 1
	// cursor is at previousCursorPosition.y, need to go to line (previousLineCount - 1)
	const down = previousLineCount - 1 - previousCursorPosition.y;
	return (
		(down > 0 ? ansiEscapes.cursorDown(down) : '') + ansiEscapes.cursorTo(0)
	);
};

export type CursorOnlyInput = {
	cursorWasShown: boolean;
	previousLineCount: number;
	previousCursorPosition: CursorPosition | undefined;
	visibleLineCount: number;
	cursorPosition: CursorPosition | undefined;
};

/**
Build the escape sequence for cursor-only updates (output unchanged, cursor moved).
Hides cursor if it was previously shown, returns to bottom, then repositions.
*/
export const buildCursorOnlySequence = (input: CursorOnlyInput): string => {
	const hidePrefix = input.cursorWasShown ? hideCursorEscape : '';
	const returnToBottom = buildReturnToBottom(
		input.previousLineCount,
		input.previousCursorPosition,
	);
	const cursorSuffix = buildCursorSuffix(
		input.visibleLineCount,
		input.cursorPosition,
	);
	return hidePrefix + returnToBottom + cursorSuffix;
};

/**
Build the prefix that hides cursor and returns to bottom before erasing or rewriting.
Returns empty string if cursor was not shown.
*/
export const buildReturnToBottomPrefix = (
	cursorWasShown: boolean,
	previousLineCount: number,
	previousCursorPosition: CursorPosition | undefined,
): string => {
	if (!cursorWasShown) {
		return '';
	}

	return (
		hideCursorEscape +
		buildReturnToBottom(previousLineCount, previousCursorPosition)
	);
};
