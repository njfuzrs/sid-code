/**
 * 会话级标记 —— 供只能拿到 `TraceCollector` 的采集点读取「这个会话是怎么被启动的」
 *
 * ## 为什么不是 `SessionStartInput` 的字段
 *
 * `SessionStartInput` 是对外 hook 契约（用户 hook 脚本的 stdin），加字段要动参考页与
 * 用户侧脚本，而「被远程遥控」这件事只服务本地轨迹归因（触发清单 A12：
 * 「这个会话是不是被遥控的」一眼可见，不用扫事件）。
 *
 * ## 为什么是模块级而不是构造参数
 *
 * 有两处读取时机，都在 `TraceCollector` 内部：
 * - `SessionStart` 构造 metadata（`collector.ts` 的 `handleSessionStart`）；
 * - 远程会话里用户经 `submitHeadlessInput` 发 `/clear` 时，collector 会重建 metadata
 *   ——那时 `runBridge` 早已返回，构造参数传不进去。
 *
 * 进程级单值足以表达（一个进程只有一个桥接会话），写入方只有 `App.runBridge`。
 * 测试用 `setBridgeSessionFlag(false)` 复位。
 */

let _bridgeSession = false;

/** 标记/清除「本进程是 Bridge 远程接管会话」。由 `App.runBridge` 在 init 之前调用。 */
export function setBridgeSessionFlag(enabled: boolean): void {
  _bridgeSession = enabled;
}

/** 本进程是否是 Bridge 远程接管会话（缺省 false，老轨迹里没有该字段） */
export function isBridgeSession(): boolean {
  return _bridgeSession;
}
