/**
 * §12 P1-3：合并多路压缩「额外指令」来源。
 *
 * 压缩摘要 prompt 的 customInstructions 可能同时来自：
 *   1. 用户 focus 指令（/compact focus on X）
 *   2. PreCompact hook 返回的 additionalContext（如「保留所有数据库 schema」）
 *   3. 配置中的固定压缩指令（预留）
 *
 * 对标 claude-code `mergeHookInstructions`（services/compact/compact.ts:420-421）：
 * 把多段指令按顺序拼成一段，供 getCompactPrompt / buildCompactUserPrompt 作为
 * customInstructions 注入摘要 prompt 末尾。
 *
 * @param parts 各来源指令（undefined / 空串 / 纯空白自动过滤）
 * @returns 合并后的单段指令（用双换行分隔，保持可读性）；全空时返回 undefined
 */
export function mergeInstructions(...parts: (string | undefined | null)[]): string | undefined {
  const xs = parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);
  return xs.length > 0 ? xs.join("\n\n") : undefined;
}
