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

/**
 * 字符级「浪费是否显著」的阈值（0~1），**两套缓存断裂检测共用这一个常量**。
 *
 * - `trace/prefix-break-probe.ts`：`judgeDisagreement` 的段级 vs 字符级分歧判据
 * - `api/cache-detection.ts`：消息前缀改写是否值得归因为 `message_history`
 *
 * 为什么必须同源：两套检测回答的是同一件事的两面（字节侧「断在哪」、账单侧「掉了多少」），
 * 阈值只要不一致，就会出现「字节侧说显著、账单侧说不显著」的分歧，而这种分歧**没有任何报错**。
 * 与 `serializeMessageForFingerprint` 同理：复制一份就会漂移。
 *
 * 取 1%：低于此的作废量在 128-token 粒度的服务端缓存扩展面前是噪声
 * （实测服务端按 128 token 整数倍渐进扩展前缀，见 cache-bench 报告 §2）。
 */
export const CHAR_WASTE_SIGNIFICANT = 0.01;
