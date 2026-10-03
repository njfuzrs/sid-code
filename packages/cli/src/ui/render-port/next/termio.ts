/** next 实现：终端控制序列工具（T2.3）。 */
import { notImplementedFn, notImplementedValue } from "./not-implemented.ts";

export const OSC = notImplementedValue("OSC", "T2.3");
export const osc = notImplementedFn("osc", "T2.3");
export const setClipboard = notImplementedFn("setClipboard", "T2.3");
export const wrapForMultiplexer = notImplementedFn("wrapForMultiplexer", "T2.3");
// 字符串常量没法「用时抛」。BEL 是 ECMA-48 的 C0 控制字符 0x07，直接给值。
export const BEL = "\x07";
export const supportsHyperlinks = notImplementedFn("supportsHyperlinks", "T2.3");
