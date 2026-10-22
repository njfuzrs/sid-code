/**
 * 运行期 hook 归一化诊断的用户可见出口（§三.9 残留）。
 *
 * skill / agent 的 hooks 在**调用时**才注册，这时启动横幅早已渲染完、`recordStartupWarning`
 * 那条路走不通；原先诊断只进 logger.warn，用户写错一个事件名永远不知道为什么 hook 不跑。
 *
 * 为什么是模块级 sink 而不是挂在 HookSystem 上：声明了 hooks 的 agent 用的是
 * buildAgentHookSystem 新建的**隔离实例**，主 HookSystem 上的监听根本看不到它的诊断。
 * core 不知道有没有 TUI，由 cli 层 setRuntimeHookDiagnosticSink 决定怎么显示
 * （TUI 状态行 / -p 打 stderr）；没注册 sink（测试、SDK）就只剩 logger，与原先一致。
 *
 * 本文件刻意零 import（除类型）：skill / agent 层引它，不该顺带拖入别的子系统。
 */

import type { HookDiagnostic } from "./config-normalize.ts";

export type RuntimeHookDiagnosticSink = (line: string) => void;

let sink: RuntimeHookDiagnosticSink | undefined;
/**
 * 已报告过的行：skill 每调用一次就重新注册一遍 hooks，同一条错会每次都报一遍，
 * 状态行被同一句话刷屏比不报更烦。进程内只报一次，logger 里仍每次都有。
 */
const reported = new Set<string>();

/** cli 层注册显示出口；传 undefined 解除。返回旧 sink 便于测试恢复 */
export function setRuntimeHookDiagnosticSink(
  next: RuntimeHookDiagnosticSink | undefined,
): RuntimeHookDiagnosticSink | undefined {
  const prev = sink;
  sink = next;
  return prev;
}

/**
 * 把一批运行期诊断送到用户可见出口。
 * @param origin 来源描述，如 `Skill foo` / `Agent bar`（进文案，让用户知道该去改哪个文件）
 */
export function reportRuntimeHookDiagnostics(origin: string, diagnostics: HookDiagnostic[]): void {
  if (!sink || diagnostics.length === 0) return;
  for (const d of diagnostics) {
    const line = `${origin} 的 hook 已跳过 ${d.path}: ${d.message}`;
    if (reported.has(line)) continue;
    reported.add(line);
    try {
      sink(line);
    } catch {
      /* 显示失败不影响 hook 注册 */
    }
  }
}

/** 测试用：清空去重表 */
export function resetRuntimeHookDiagnosticsForTest(): void {
  reported.clear();
}

// ============================================================
// B1：hook 的 systemMessage 用户可见出口
// ============================================================
//
// runner 把「exit 1/3/… 的 stderr」「JSON 的 systemMessage」都收进 HookOutput.systemMessage，
// aggregator 也合并好了，但此前 cli 层没有任何一处读它——官网承诺的「非阻塞告警展示给用户」
// 是一条断头路。与上面的诊断 sink 同一个理由用模块级出口：agent 的隔离 HookSystem 也要能报。
//
// 与诊断不同，这里**不去重**：同一个 lint hook 每次失败都该告诉用户，去重会让第二次失败静默。

export type HookSystemMessageSink = (eventName: string, text: string) => void;

let messageSink: HookSystemMessageSink | undefined;
/**
 * sink 注册前产生的消息先缓存（SessionStart 在 TUI 注册出口之前就跑完了），注册时一次性冲出。
 * 有上限：测试 / SDK 永远不注册 sink，不能无限攒。
 */
const pendingMessages: Array<[string, string]> = [];
const MAX_PENDING_MESSAGES = 20;

/** cli 层注册 systemMessage 显示出口；传 undefined 解除。返回旧 sink 便于测试恢复 */
export function setHookSystemMessageSink(
  next: HookSystemMessageSink | undefined,
): HookSystemMessageSink | undefined {
  const prev = messageSink;
  messageSink = next;
  if (next) {
    for (const [ev, text] of pendingMessages.splice(0)) deliver(next, ev, text);
  }
  return prev;
}

function deliver(s: HookSystemMessageSink, eventName: string, text: string): void {
  try {
    s(eventName, text);
  } catch {
    /* 显示失败不影响 hook 结论 */
  }
}

/** 把一条聚合后的 systemMessage 送到用户可见出口（无 sink 时暂存） */
export function reportHookSystemMessage(eventName: string, text: string): void {
  const t = text.trim();
  if (!t) return;
  if (messageSink) {
    deliver(messageSink, eventName, t);
    return;
  }
  if (pendingMessages.length < MAX_PENDING_MESSAGES) pendingMessages.push([eventName, t]);
}

/** 测试用：清空暂存 */
export function resetHookSystemMessagesForTest(): void {
  pendingMessages.length = 0;
}
