/**
 * G16 / G26 架构评估决策记录
 *
 * 生成时间：2026-07
 * 决策：有意延期（Accepted Deferral）
 *
 * ## G16 — mid-stream 工具执行
 *
 * ### 差距描述
 * claude-code 在流式响应中每收到一个完整 tool_use block 就立即入队执行（streaming 与
 * 执行重叠）。sid-code 等整段流式响应结束后才批量执行所有 tool_use block。
 *
 * ### 影响
 * 长响应（如模型一次派 5+ 个工具调用）的端到端延迟更高：sid 多等一段"剩余流式输出时间"。
 * 典型场景：模型先输出文字解释再给出工具调用 → sid 多等文字输出完的时间。
 *
 * ### 不实现的理由
 * 1. **架构侵入性高**：需要重构整个 processStream → response 处理 → 工具执行管线。
 *    当前 loop.ts 的流式处理（Promise.race + 看门狗 + turn-level abort + 心跳超时）
 *    假设"response 是一个完整单元"。mid-stream 执行打破这个假设，需要重新设计：
 *    - 流式累积器（识别完整 tool_use block 边界）
 *    - 并行执行协调（流式还在产出新工具 vs 已提交的工具在执行）
 *    - abort 语义变复杂（abort 流还是 abort 工具还是两者）
 *    - 错误回滚（半流的 tool_use 如何与已执行的 tool_result 配对）
 * 2. **ROI 不足**：绝大多数响应 <3s（Sonnet 速度下），工具执行本身是主要延迟来源。
 *    mid-stream 优化的收益仅在"长文字 + 多工具"的稀有场景显著。
 * 3. **测试/稳定性风险**：当前"整段完成后批量执行"模式已有 5000+ 测试覆盖且生产稳定。
 *    mid-stream 重构几乎无法在不引入新 flake 的情况下完成。
 *
 * ### 缓解措施
 * - 已有 G20 sibling-abort：即使批量执行，用户中断时能立即停止所有在跑兄弟工具。
 * - 流式输出已通过 onStreamText 实时展示给用户，体感上不是"卡住"。
 *
 * ### 重新评估条件
 * - 如果未来支持超长响应（>10s 文字 + 5+ 工具）成为常态场景
 * - 或用户反馈明确指向"工具执行延迟"而非"LLM 生成延迟"
 *
 * ---
 *
 * ## G26 — by-round 消息分组
 *
 * ### 差距描述
 * claude-code `grouping.ts` 按 API 轮次分组消息，避免压缩时切碎 tool_use/tool_result 对。
 * sid-code 按消息条数切边界。
 *
 * ### 不实现的理由
 * sid 已有等效防线（事后修复哲学）：
 * 1. `checkMessageHistoryIntegrity()`：每次发送前校验 tool_use/tool_result 配对完整性
 * 2. `backfillOrphanToolResults()`：检测到孤儿 tool_use 时自动补齐占位 tool_result
 * 3. G22 `partialCompact` 新实现的 `findSafeCompactBoundary()` 已按轮次边界切割
 *
 * 两种路线（前置分组 vs 后置修复）功能等价，sid 选择后置修复以保持压缩路径简单。
 *
 * ### 重新评估条件
 * - 如果 backfill 兜底频繁触发（说明切碎很常见）→ 值得前移到分组
 * - 可通过 grep 日志 "backfillOrphanToolResults" 监控频率
 */
export {};
