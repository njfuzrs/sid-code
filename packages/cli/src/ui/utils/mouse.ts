/**
 * 鼠标协议解析（SGR + X11）
 *
 * 支持事件类型：按下/释放/移动/滚轮（上下左右）
 * 支持修饰键：Shift/Alt/Ctrl/Meta
 * 坐标：1-based（终端原始值）
 *
 * 参考 gemini-cli/packages/cli/src/ui/utils/mouse.ts
 */

import {
  SGR_MOUSE_REGEX,
  X11_MOUSE_REGEX,
  SGR_EVENT_PREFIX,
  X11_EVENT_PREFIX,
  couldBeMouseSequence as inputCouldBeMouseSequence,
} from "./input.ts";

export type MouseEventName =
  | "left-press"
  | "left-release"
  | "right-press"
  | "right-release"
  | "middle-press"
  | "middle-release"
  | "scroll-up"
  | "scroll-down"
  | "scroll-left"
  | "scroll-right"
  | "move"
  | "double-click";

export const DOUBLE_CLICK_THRESHOLD_MS = 400;
export const DOUBLE_CLICK_DISTANCE_TOLERANCE = 2;

export interface MouseEvent {
  name: MouseEventName;
  col: number;
  row: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  button: "left" | "middle" | "right" | "none";
}

export type MouseHandler = (event: MouseEvent) => void | boolean;

/** 根据按钮码和释放标志确定事件名称 */
export function getMouseEventName(buttonCode: number, isRelease: boolean): MouseEventName | null {
  const isMove = (buttonCode & 32) !== 0;

  if (buttonCode === 66) {
    return "scroll-left";
  } else if (buttonCode === 67) {
    return "scroll-right";
  } else if ((buttonCode & 64) === 64) {
    if ((buttonCode & 1) === 0) {
      return "scroll-up";
    } else {
      return "scroll-down";
    }
  } else if (isMove) {
    return "move";
  } else {
    const button = buttonCode & 3;
    const type = isRelease ? "release" : "press";
    switch (button) {
      case 0:
        return `left-${type}`;
      case 1:
        return `middle-${type}`;
      case 2:
        return `right-${type}`;
      default:
        return null;
    }
  }
}

function getButtonFromCode(code: number): MouseEvent["button"] {
  const button = code & 3;
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "none";
  }
}

/** 解析 SGR 编码鼠标事件（ESC [ < button ; col ; row M/m） */
export function parseSGRMouseEvent(buffer: string): { event: MouseEvent; length: number } | null {
  const match = buffer.match(SGR_MOUSE_REGEX);
  if (!match) return null;

  const buttonCode = parseInt(match[1], 10);
  const col = parseInt(match[2], 10);
  const row = parseInt(match[3], 10);
  const action = match[4];
  const isRelease = action === "m";

  const shift = (buttonCode & 4) !== 0;
  const meta = (buttonCode & 8) !== 0;
  const ctrl = (buttonCode & 16) !== 0;

  const name = getMouseEventName(buttonCode, isRelease);
  if (!name) return null;

  return {
    event: { name, ctrl, meta, shift, col, row, button: getButtonFromCode(buttonCode) },
    length: match[0].length,
  };
}

/** 解析 X11 编码鼠标事件（ESC [ M + 3 字节） */
export function parseX11MouseEvent(buffer: string): { event: MouseEvent; length: number } | null {
  const match = buffer.match(X11_MOUSE_REGEX);
  if (!match) return null;

  const b = match[1].charCodeAt(0) - 32;
  const col = match[1].charCodeAt(1) - 32;
  const row = match[1].charCodeAt(2) - 32;

  const shift = (b & 4) !== 0;
  const meta = (b & 8) !== 0;
  const ctrl = (b & 16) !== 0;
  const isMove = (b & 32) !== 0;
  const isWheel = (b & 64) !== 0;

  let name: MouseEventName | null = null;

  if (isWheel) {
    const button = b & 3;
    switch (button) {
      case 0:
        name = "scroll-up";
        break;
      case 1:
        name = "scroll-down";
        break;
    }
  } else if (isMove) {
    name = "move";
  } else {
    const button = b & 3;
    if (button === 3) {
      // X11 用 3 表示所有按钮释放，默认当作左键释放
      name = "left-release";
    } else {
      switch (button) {
        case 0:
          name = "left-press";
          break;
        case 1:
          name = "middle-press";
          break;
        case 2:
          name = "right-press";
          break;
      }
    }
  }

  if (!name) return null;

  let button = getButtonFromCode(b);
  if (name === "left-release" && button === "none") {
    button = "left";
  }

  return {
    event: { name, ctrl, meta, shift, col, row, button },
    length: match[0].length,
  };
}

/** 解析鼠标事件（自动检测 SGR 或 X11 编码） */
export function parseMouseEvent(buffer: string): { event: MouseEvent; length: number } | null {
  return parseSGRMouseEvent(buffer) || parseX11MouseEvent(buffer);
}

/** 检查 buffer 是否为不完整的鼠标序列（需要等待更多数据） */
export function isIncompleteMouseSequence(buffer: string): boolean {
  if (!inputCouldBeMouseSequence(buffer)) return false;
  if (parseMouseEvent(buffer)) return false;

  if (buffer.startsWith(X11_EVENT_PREFIX)) {
    return buffer.length < X11_EVENT_PREFIX.length + 3;
  }

  if (buffer.startsWith(SGR_EVENT_PREFIX)) {
    return !/[mM]/.test(buffer) && buffer.length < 50;
  }

  // 是前缀的前缀（如 "ESC" 或 "ESC ["）
  return true;
}
