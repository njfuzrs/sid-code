/**
 * Responses 推理链回放的开关与网关能力位（2026-10-21，发现 1 / #385）。
 *
 * 回放 = 把上一轮下发的 `reasoning` item（含 `encrypted_content`）原样放回下一轮 `input`。
 * 官方要求带工具的多轮对话这么做，否则每一轮模型都看不到自己上一轮的推理。
 *
 * 两道闸：
 * 1. **用户开关** `SID_CODE_RESPONSES_REASONING_REPLAY=0`：关掉回放（A/B 实验与紧急回滚用）。
 *    默认开——前置探针已证实内部网关能下发、能回放（评估报告 §6.1 前置 1）。
 * 2. **网关能力位**：某个 (endpoint, model) 回放时 400 且错误体指向 reasoning item，
 *    就记成「不支持」，本进程内不再回放，并**一次性告警**——不静默降级。
 *
 * 能力位只存进程内存，不落盘：代价是每个新进程最多再吃一次 400（漏斗会重试，重试时已不带回放）。
 * 落盘要动 provider 能力缓存的 schema，而目前只有一个网关、且探针证实它支持，不值得。
 */

const unsupported = new Set<string>();

/** 用户开关：未设或任何非 "0" 值都视为开启 */
export function reasoningReplayEnabled(): boolean {
  return process.env.SID_CODE_RESPONSES_REASONING_REPLAY !== "0";
}

function key(endpoint: string, model: string): string {
  return `${endpoint}\u0000${model}`;
}

/** 本次请求是否回放：开关开 且 该 (endpoint, model) 没被标成不支持 */
export function shouldReplayReasoning(endpoint: string, model: string): boolean {
  return reasoningReplayEnabled() && !unsupported.has(key(endpoint, model));
}

/** 标记不支持；首次标记返回 true（调用方据此只告警一次） */
export function markReasoningReplayUnsupported(endpoint: string, model: string): boolean {
  const k = key(endpoint, model);
  if (unsupported.has(k)) return false;
  unsupported.add(k);
  return true;
}

/** /status 展示用：被标成不支持的 `endpoint 上的 model` 列表 */
export function listReasoningReplayUnsupported(): string[] {
  return [...unsupported].map((k) => {
    const [endpoint, model] = k.split("\u0000");
    return `${model}@${endpoint || "默认端点"}`;
  });
}

/**
 * 400 是否是「网关不认回放的 reasoning item」。
 *
 * 判据刻意收窄到错误体提到 reasoning / encrypted_content / item not found：
 * 400 还有上下文溢出、参数非法等无关成因，一律当成「不支持回放」会把一次偶发错误
 * 变成整个进程永久关掉推理链。宁可漏判（多吃一次 400），不误判。
 */
export function looksLikeReasoningReplayRejection(status: number, body: string): boolean {
  if (status !== 400) return false;
  return /reasoning|encrypted_content|item\b.*\bnot found/i.test(body);
}

/** 仅供测试 */
export function resetReasoningReplayForTest(): void {
  unsupported.clear();
}
