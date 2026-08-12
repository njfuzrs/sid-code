/**
 * 终端输入常量与鼠标序列检测工具
 *
 * 提供 ESC 常量、SGR/X11 鼠标正则、前缀检测函数。
 * 被 KeypressContext 和 mouse.ts 共同依赖。
 *
 * 参考 gemini-cli/packages/cli/src/ui/utils/input.ts
 */

export const ESC = "\u001B";
export const SGR_EVENT_PREFIX = `${ESC}[<`;
export const X11_EVENT_PREFIX = `${ESC}[M`;

// SGR 鼠标事件：ESC [ < button ; col ; row (M|m)
// eslint-disable-next-line no-control-regex
export const SGR_MOUSE_REGEX = /^\x1b\[<(\d+);(\d+);(\d+)([mM])/;

// X11 鼠标事件：ESC [ M 后跟 3 字节
// eslint-disable-next-line no-control-regex
export const X11_MOUSE_REGEX = /^\x1b\[M([\s\S]{3})/;

/** 检查 buffer 是否可能是 SGR 鼠标序列的前缀 */
export function couldBeSGRMouseSequence(buffer: string): boolean {
  if (buffer.length === 0) return true;
  if (SGR_EVENT_PREFIX.startsWith(buffer)) return true;
  if (buffer.startsWith(SGR_EVENT_PREFIX)) return true;
  return false;
}

/** 检查 buffer 是否可能是任意鼠标序列的前缀 */
export function couldBeMouseSequence(buffer: string): boolean {
  if (buffer.length === 0) return true;
  if (SGR_EVENT_PREFIX.startsWith(buffer) || buffer.startsWith(SGR_EVENT_PREFIX)) return true;
  if (X11_EVENT_PREFIX.startsWith(buffer) || buffer.startsWith(X11_EVENT_PREFIX)) return true;
  return false;
}

/** 检查 buffer 开头是否为完整鼠标序列，返回序列长度（0 表示不匹配） */
export function getMouseSequenceLength(buffer: string): number {
  const sgrMatch = buffer.match(SGR_MOUSE_REGEX);
  if (sgrMatch) return sgrMatch[0].length;
  const x11Match = buffer.match(X11_MOUSE_REGEX);
  if (x11Match) return x11Match[0].length;
  return 0;
}
