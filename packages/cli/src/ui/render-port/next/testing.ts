/** next 实现：测试专用（L1 双跑要用，T3.2 起逐步补）。 */
import { render as upstreamRender } from "@sid-code/tui";
import { notImplementedFn } from "./not-implemented.ts";

// render/lastFrame 测试 shim 要按端口语义重写（非 TTY 整帧输出），T3.2 与出帧调度一起做
export const render = notImplementedFn("testing.render", "T3.2");
export const renderSync = upstreamRender;
export const forgetRenderInstance = notImplementedFn("forgetRenderInstance", "T3.2");
export const enableFrameThrottle = notImplementedFn("enableFrameThrottle", "T3.2");
