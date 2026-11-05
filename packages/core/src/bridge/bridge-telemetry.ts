/**
 * Bridge 远程接管的轨迹埋点 —— 事件名与字段的单一事实源
 *
 * ## 为什么需要
 *
 * 远程接管此前只有 `debug.log` 的 `[BRIDGE]` info：连接、远程消息、abort、权限代理
 * 请求/应答、永久失败，全部不可结构化查询。触发清单 A12 的「证据」列因此只能写
 * 「无，看管理台」——「这个会话被谁遥控、收了几条消息、批过几次权限」在轨迹里
 * 一条记录都没有。
 *
 * ## 为什么走构造参数而不是模块级 sink
 *
 * hook / skill 那类模块级 sink 存在的原因是生产点拿不到 collector（散在纯函数里、
 * 一个进程多个实例）。Bridge 不是这个形态：`App.runBridge` 第一句就是 `await this.init()`，
 * 到 `new BridgeRunner(...)` 时 collector 已就绪，整条桥接链路只有
 * runner → core → proxy 一个实例链，构造参数透传即可。模块级单例反而会掩盖
 * 「隔离的 BridgeCore（测试 / 将来的第二个连接）该不该记进主会话轨迹」这个问题。
 *
 * ## 隐私约束（硬性）
 *
 * events.jsonl 会被 `trace/uploader.ts` 上传到企业后端，所以本模块的字段
 * **一律不含**：token、URL query（连接地址经 `stripTokenQuery` 剥过）、
 * 远程消息正文。入站消息只记 `kind` 与 `text_len`；权限只记工具名与耗时。
 */

/** 桥接会话生命周期事件名 —— 生产侧与消费侧共用，避免字面量漂移 */
export const BRIDGE_SESSION_EVENT_NAME = "BridgeSession";

/** 远程入站消息事件名 */
export const BRIDGE_INBOUND_EVENT_NAME = "BridgeInbound";

/** 远程权限请求结果事件名 */
export const BRIDGE_PERMISSION_EVENT_NAME = "BridgePermission";

/**
 * `BridgeSession.phase` 闭集。
 *
 * - `connected`：握手成功、权限代理已注入（`BridgeRunner.start()` 成功返回前）
 * - `start_failed`：启动阶段被拒（坏 token / 策略拒绝），进程即将非 0 退出
 * - `permanent_failure`：常驻期间被服务端永久关闭（4001/4003/1008）
 * - `stopped`：正常停止（SIGINT / 测试收尾），带会话内累计计数
 */
export type BridgeSessionPhase = "connected" | "start_failed" | "permanent_failure" | "stopped";

/**
 * `BridgeInbound.kind` 闭集。
 *
 * `control:ping` 刻意不在里面：心跳是每秒级的高频消息，记进 events.jsonl
 * 只会把一次远程会话写成几千条噪声，而它对「谁在遥控、做了什么」零信息量。
 */
export type BridgeInboundKind = "user_message" | "permission_response" | "control:abort";

/** `BridgePermission.decision` 闭集。超时与远程明确拒绝分开：前者是运维信号，后者是用户意图 */
export type BridgePermissionDecision = "allow" | "deny" | "timeout";

/**
 * 埋点写入通道（由 BridgeRunner 注入，最终指向 `TraceCollector.recordCustomEvent`）。
 * 第一个参数是事件名——与 `recordCustomEvent(event, data)` 的签名对齐，注入处无需再包一层。
 */
export type BridgeTelemetrySink = (name: string, data: Record<string, unknown>) => void;

/**
 * 写一条桥接事件。sink 未注入（测试 / 轨迹关闭）或写入抛错都静默 ——
 * 埋点绝不影响桥接主流程，这是与 `skill/telemetry.ts` 同一条原则。
 */
export function emitBridgeTelemetry(
  sink: BridgeTelemetrySink | undefined,
  name: string,
  data: Record<string, unknown>,
): void {
  try {
    sink?.(name, data);
  } catch {
    /* 埋点失败静默 */
  }
}
