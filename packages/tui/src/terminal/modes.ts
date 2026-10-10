/**
 * alt-screen 与鼠标跟踪的私有模式序列（B9 / T6.1a，契约 M1）。字节与顺序来自黑盒对拍旧底座。
 * `<AlternateScreen>`、SIGCONT 恢复、stdin 静默自愈、alt 下 resize 共用这一份，避免各写一遍漂移。
 */

/** 进 alt-screen：切缓冲区、擦屏、回原点 */
export const enterAltScreen = '\u001B[?1049h\u001B[2J\u001B[H';
export const exitAltScreen = '\u001B[?1049l';

/** 鼠标跟踪全套（按下 / 拖动 / 任意移动 / SGR 编码 / alt-screen 滚轮转方向键） */
export const enableMouseTracking =
	'\u001B[?1000h\u001B[?1002h\u001B[?1003h\u001B[?1006h\u001B[?1007h';
/** 关鼠标跟踪：与打开的顺序正好相反 */
export const disableMouseTracking =
	'\u001B[?1007l\u001B[?1006l\u001B[?1003l\u001B[?1002l\u001B[?1000l';
