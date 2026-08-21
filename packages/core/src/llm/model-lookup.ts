/**
 * 模型元数据的**分层查询**组合层 —— 把「registry 精确 → 采集精确 → registry 模糊」
 * 这条三段阶梯收成一个函数，供不持有 `availableModels` 的调用点复用。
 *
 * ── 为什么要单独一个模块 ────────────────────────────────────────────────
 *
 * `model-registry.ts` 是**零 import 的纯数据表**（`telemetry/cache-bench-core.ts:15`
 * 那条注释就依赖这个性质来判定静态引入不成环），所以不能把「查采集缓存」塞进它；
 * 而 `model-capabilities.ts` 是采集侧的数据源，让它反向依赖 registry 也是层级倒置。
 * 组合两个数据源的逻辑既不属于其中任何一个，就应该在它们之上单独放一层。
 *
 * ── 三段顺序不是随意排的 ────────────────────────────────────────────────
 *
 * 判据一句话：**所有精确匹配排在所有模糊匹配之前，无论数据来自哪一层**。
 * 原先各调用点写的是一次 `lookupRegistry(x)`（内含六级模糊瀑布）——于是一个 90 条、
 * 带前缀/家族猜测的手写表压在数千条精确采集数据上面：`glm-5.3` 靠前缀命中 `glm-5`
 * 就直接 return，采集到的真值永远看不到。详见 `model-registry.ts::lookupRegistryExact`
 * 头部那段实测记录。
 *
 * 两条理由同时成立且不矛盾：精确的手写表比第三方采集准（第 1 段在第 2 段前）；
 * 第三方**精确命中**比手写表**猜的**准（第 2 段在第 3 段前）。
 *
 * ── 与另外两个同构实现的关系（刻意不合并）──────────────────────────────
 *
 * `token-estimator.getMaxOutputTokens` 与 `config.resolveMaxOutputTokensForModel`
 * 走的是同一条三段阶梯，但它们**多一个更高优先级的层**：用户在 `availableModels[]`
 * 里的显式声明。那一层必须按**别名**查（同一真名的两个端点上限确实可能不同，网关常比
 * 官方更紧），与本函数按**真名**查的口径不同，合并会把两种键搞混。
 * 所以本函数只服务「已经拿到真名、且用户声明层已在上游处理过」的调用点。
 */

import { lookupRegistryExact, lookupRegistryFuzzy } from "./model-registry.ts";
import { lookupCapability } from "./model-capabilities.ts";

/** 数值必须是有限正数才算「拿到了上限」。
 *
 *  用 `Number.isFinite` 而非仅 `> 0` 是刻意的防御性重复：`Infinity > 0` 为 true，
 *  只查 `> 0` 会让一个 `{"maxOutputTokens":1e400}`（JSON.parse 后变 Infinity）的
 *  毒数据被当成合法上限，于是「钳制」永远不触发——不报错，比报错更难发现。
 *  上游 `sanitizeEntry` 已经拦了一道，这里是第二道。 */
function usable(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * 按真名解析模型的 `maxOutputTokens`，走「registry 精确 → 采集精确 → registry 模糊」三段。
 *
 * 三段全 miss 返回 `undefined` —— **不臆测一个数字**。调用方拿到 undefined 时的正确行为是
 * 「不钳制」或「用自己的默认预留」，而不是在这里编一个值：编出来的值会被下游当成
 * 「已知事实」参与阈值计算，比明确的 undefined 更危险。
 *
 * @param wireModel **厂商真名**（不是本地别名）。喂别名会三段全 miss →
 *   不钳制 → 把过大的 maxTokens 原样发出去吃 400。调用方须先过 `resolveWireModel`
 *   或 `lookupWireModelAlias`。
 */
export function resolveRegistryMaxOutputTokens(wireModel: string): number | undefined {
  const exact = lookupRegistryExact(wireModel)?.maxOutputTokens;
  if (usable(exact)) return exact;
  const dynamic = lookupCapability(wireModel)?.maxOutputTokens;
  if (usable(dynamic)) return dynamic;
  const fuzzy = lookupRegistryFuzzy(wireModel)?.maxOutputTokens;
  if (usable(fuzzy)) return fuzzy;
  return undefined;
}
