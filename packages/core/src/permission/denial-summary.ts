/**
 * 把 denial tracking 的内部状态摊平成「这次会话被拒了哪些操作」的清单（D1）。
 *
 * 非交互模式下 `ask` 会被自动拒绝，这避免了停在无人应答的批准提示上，
 * 但被拒的工具只进审计日志和模型能看到的 tool_result——跑完的人在 stdout
 * 上看不到。这里只做**只读汇总**，不改拒绝决策本身：
 *
 *   - 签名形如 `工具名\x00资源`（denial-tracking.ts 的 denialSignature），
 *     资源可能为空（无参工具）。
 *   - 只列**当前仍被拒绝**的签名。recordSuccess 会把已放行的签名删掉，
 *     所以出现在 bySignature 里的都是到会话结束还没被放行的。
 *   - 按拒绝次数降序，次数相同按工具名，输出稳定可测。
 */

import type { DenialTrackingState } from "./denial-tracking.ts";

/** 一条被拒操作。字段名对齐 CC result 的 permission_denials 语义，只带我们真有的信息。 */
export interface PermissionDenial {
  tool_name: string;
  /** 资源（文件路径 / 命令）。无资源的工具为空串。 */
  resource: string;
  /** 该操作被连续拒绝的次数。 */
  count: number;
  /** 最近一次拒绝的原因（checker 记下的原文）。 */
  reason: string;
}

const SIGNATURE_SEPARATOR = "\x00";

/** 汇总当前仍被拒绝的操作。空状态返回空数组，调用方据此决定要不要输出。 */
export function summarizeDenials(state: DenialTrackingState | undefined): PermissionDenial[] {
  if (!state) return [];
  const out: PermissionDenial[] = [];
  for (const [signature, entry] of Object.entries(state.bySignature)) {
    if (!entry || entry.consecutive <= 0) continue;
    const sep = signature.indexOf(SIGNATURE_SEPARATOR);
    const tool = sep < 0 ? signature : signature.slice(0, sep);
    const resource = sep < 0 ? "" : signature.slice(sep + 1);
    out.push({
      tool_name: tool,
      resource,
      count: entry.consecutive,
      reason: entry.reason,
    });
  }
  out.sort((a, b) => b.count - a.count || a.tool_name.localeCompare(b.tool_name));
  return out;
}

/**
 * stderr 上的一行汇总。空清单返回空串（调用方不打印）。
 *
 * 不在这里建议具体的 flag 组合：该用 `--allowed-tools` 还是 `--permission-mode`
 * 取决于被拒的原因，硬编码一句建议会在「危险命令被拒」这种不该放行的场景里误导人。
 * 只把「被拒了、以及被拒的是什么」说清楚。
 */
export function formatDenialSummary(denials: readonly PermissionDenial[]): string {
  if (denials.length === 0) return "";
  const lines = denials.map((d) => {
    const where = d.resource ? `(${truncate(d.resource, 80)})` : "";
    const times = d.count > 1 ? ` ×${d.count}` : "";
    return `  - ${d.tool_name}${where}${times}: ${d.reason}`;
  });
  return (
    `以下 ${denials.length} 个操作在非交互模式下被拒绝（无 TUI 可确认，重试相同输入不会改变结果）：\n` +
    lines.join("\n") +
    `\n如需放行，用 --allowed-tools / --allow-tool 预授权，或 --permission-mode 调整权限模式。\n`
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
