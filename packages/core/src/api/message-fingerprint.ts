/**
 * 单条消息的结构序列化（用于「这条消息变没变」的指纹比对）。
 *
 * 两处共用，**必须同源**：
 *   - `api/cache-detection.ts`：账单侧检测器比对消息前缀，判定能不能归给服务端波动
 *   - `trace/prefix-break-probe.ts`：字节侧 `prefix_break` 的 message 段
 *
 * 两边各写一份就会漂移，漂移后两套检测对同一请求给出不同结论，而这种分歧
 * 没有任何报错（打转检测的 `shapeKey` 就是这么漂的）。放在 api/ 而不是 trace/：
 * trace 已经依赖 api，反过来不行。
 *
 * 循环引用等异常降级为空串 —— 埋点绝不因序列化抛错。
 */
export function serializeMessageForFingerprint(m: unknown): string {
  try {
    return JSON.stringify(m) ?? "";
  } catch {
    return "";
  }
}
