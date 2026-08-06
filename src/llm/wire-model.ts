/**
 * wire-model —— 「本地别名」→「厂商真实模型 id」的单一解析入口。
 *
 * ## 为什么需要这一层
 *
 * `availableModels[].name` 一个字段原本干了两件事：既是本地查找键（`/model` 选择、
 * fallback、子代理、计价全按它 find-first 匹配），又被直接当作 HTTP 请求体的 `model`
 * 字段发给厂商。两个职责冲突在「同一个模型接两个渠道」时爆发：
 *
 *   - 两条都叫 `claude-sonnet-5` → 选择侧 find-first 只命中第一条，第二条的
 *     base_url / api_key 是死配置，任何 UI 都选不中它；
 *   - 改名成 `claude-sonnet-5-gateway` 让两条可达 → 请求体里 model 就变成这个别名，
 *     厂商不认识，400 / 404。
 *
 * 拆成 `name`（别名，本地唯一）+ `modelId`（真名，发给厂商）后两难消解。
 *
 * ## 谁用别名、谁用真名（判据：这个消费点在问什么问题）
 *
 * | 问题 | 用哪个 | 典型消费点 |
 * | --- | --- | --- |
 * | 「哪一条配置 / 哪个渠道」 | 别名 `name` | 模型选择、`/model` 显示、fallback、子代理、计价、审计 |
 * | 「这到底是什么模型」 | 真名 `modelId` | HTTP 请求体、能力判定（thinking/effort）、内置注册表兜底 |
 *
 * 计价刻意留在别名侧：`resolvePricing` 本就是 `(name, endpoint)` 复合键，网关价与官方价
 * 本来就该分开算，用真名反而会把两个渠道的差价抹平。
 *
 * 能力判定与注册表兜底必须吃真名：`lookupRegistry` / `resolveEffortCapability` 靠前缀与
 * 家族匹配，喂 `gw-claude-sonnet-5` 这类前缀式别名会**静默 miss** 退化到兜底值
 * （上下文窗口高估、thinking 能力丢失），不报错、比报错更难发现。
 */

/** 解析所需的最小结构（避免为一个字段反向依赖 config.ts，防 import 环） */
export interface WireModelEntry {
  name?: string;
  modelId?: string;
}

/**
 * 进程级别名表（alias → wire model），仅收录**真正配了 modelId 且与 name 不同**的条目。
 *
 * ## 为什么必须有这张表，而不是逐个调用点传 wireModel
 *
 * `provider.sendMessageStream()` 的调用点远不止主循环：side-call（标题生成 / recall /
 * bash 分类 / 摘要）、headless、forked-agent、auto-compact、context-collapse、
 * agentic-loop、stream-handler…… 逐个补 `wireModel` 有两个已知会犯的错：
 *
 *   1. 漏一个就是「那条路径静默发别名」→ 400，且只在用户真配了 modelId 时才现形，
 *      单测全绿放过（本仓库「手写字段列表漏字段」有多次前科，见 message-fidelity 记录）；
 *   2. 以后**新增**调用点的人不知道要补，缺陷会重新长出来。
 *
 * 兜底表把「必须记得做的事」变成「默认就成立」：`pickWireModel` 在 params 没带
 * `wireModel` 时查这张表。主循环仍显式传 `wireModel`（快路径、不依赖全局态），
 * 其余路径由表兜住。两条机制指向同一份数据，不会打架。
 *
 * 只收录 `modelId !== name` 的条目——空表是绝对多数用户的常态，此时所有查询
 * 立即短路返回，零开销、零行为变化。
 */
let _aliasMap: Map<string, string> | null = null;

/**
 * 注册别名表。config 加载完 / `/model` 切换后由 app 调用（幂等，可重复调）。
 *
 * 传 undefined 或空列表即清空——切到「没有任何 modelId 配置」的状态时必须真的清掉，
 * 否则旧映射会残留并把新配置的别名错翻成上一份配置的真名。
 */
export function setWireModelAliases(models?: readonly WireModelEntry[]): void {
  const map = new Map<string, string>();
  for (const m of models ?? []) {
    // 两侧都过 normalizeWire：name 与 modelId 同样可能是用户手写的脏值（数字/null），
    // 直接 .trim() 会抛 TypeError，而本函数在 loadConfig 链上 —— 抛出即启动失败。
    const alias = normalizeWire(m.name);
    const wire = normalizeWire(m.modelId);
    // alias === wire 时不入表：等价于没配，入表只是白占一次 Map 查询。
    if (alias && wire && alias !== wire) {
      // 同名多条时保留**第一条**，与选择侧 find-first 严格同语义。
      if (!map.has(alias)) map.set(alias, wire);
    }
  }
  _aliasMap = map.size > 0 ? map : null;
}

/** 读别名表里的真名（无表或未命中返回 undefined） */
export function lookupWireModelAlias(alias: string): string | undefined {
  return _aliasMap?.get(alias);
}

/**
 * 直接从模型列表构造「别名 → 真名」表，**不读也不写**进程级全局表。
 *
 * 与 exportWireModelAliases 的分工：后者导出当前全局表（依赖
 * resolveCurrentModelConfig 已跑过）；本函数从配置现算，不依赖任何调用时序，
 * 适合 registry 这类「可能在任何时机被调」的地方。两者口径一致（同一套过滤 + 容错）。
 *
 * 只收录 `modelId !== name` 的条目；空表返回 undefined，便于直接塞进可选协议字段。
 */
export function buildWireModelAliasMap(
  models?: readonly WireModelEntry[],
): Record<string, string> | undefined {
  if (!models?.length) return undefined;
  const out: Record<string, string> = {};
  for (const m of models) {
    // 与 setWireModelAliases 同一套容错：name/modelId 都可能是用户手写的脏值。
    const alias = normalizeWire(m?.name);
    const wire = normalizeWire(m?.modelId);
    // 同名多条保留第一条，与选择侧 find-first 严格同语义。
    if (alias && wire && alias !== wire && !(alias in out)) out[alias] = wire;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 导出整张别名表，用于**跨进程**播种（spawn 子代理）。
 *
 * 空表返回 undefined 而不是 `{}`：让调用方能直接把结果塞进可选协议字段，
 * 绝大多数用户（没配 model_id）此字段整个缺省，管道上零多余字节。
 *
 * 为什么子进程需要整张表而不是单条 wire_model：子进程里存在**换模型**的路径
 * （ModelFallback 降级时把 wireModel 置 undefined、靠别名表翻译新目标）。
 * 只播种主模型那一条的话，fallback 目标查不到 → 原样发别名 → 400，
 * 而降级恰恰是主模型已出问题时的最后一道防线。见 sub-agent-protocol.ts。
 */
export function exportWireModelAliases(): Record<string, string> | undefined {
  if (!_aliasMap || _aliasMap.size === 0) return undefined;
  return Object.fromEntries(_aliasMap);
}

/**
 * 用「别名 → 真名」的普通对象播种别名表（跨进程解码侧，与 exportWireModelAliases 对偶）。
 *
 * 单独开一个入口而不是让调用方自己拼 `WireModelEntry[]`：子进程收到的是 JSON
 * 反序列化的结果，键值都可能是脏的（老版本父进程、手工构造的 init 消息），
 * 统一在这里过 normalizeWire，与 setWireModelAliases 同一套容错口径。
 */
export function setWireModelAliasesFromMap(map?: Record<string, unknown>): void {
  if (!map || typeof map !== "object") {
    setWireModelAliases();
    return;
  }
  setWireModelAliases(
    Object.entries(map).map(([name, modelId]) => ({
      name,
      modelId: typeof modelId === "string" ? modelId : undefined,
    })),
  );
}

/** 仅供测试：清空别名表，避免跨用例串味 */
export function resetWireModelAliases(): void {
  _aliasMap = null;
}

/**
 * 把本地别名解析成发往厂商的真实模型 id。
 *
 * @param alias 本地别名（通常是 `config.model` / fallback 名 / 子代理模型名）
 * @param availableModels 用户配置的模型列表
 * @returns 命中且配了 `modelId` → 真名；否则原样返回 alias（**缺省即 name**，
 *          保证存量配置零改动、零行为变化）
 *
 * 刻意不做前缀剥离之类的推测：拿不到映射就原样返回，让请求以用户写的名字发出去。
 * 猜一个「看起来更像官方名」的值出去，会把配置错误变成难以归因的线上行为。
 */
export function resolveWireModel(
  alias: string,
  availableModels?: readonly WireModelEntry[],
): string {
  if (!alias || !availableModels?.length) return alias;
  // find-first 与选择侧（resolveCurrentModelConfig / `/model <name>`）严格同语义：
  // 同名多条时命中同一条，杜绝「选的是第一条、发的是第二条的真名」这种错配。
  const hit = availableModels.find(m => m.name === alias);
  return normalizeWire(hit?.modelId) ?? alias;
}

/**
 * 把 modelId 归一化成「可用的真名」或 undefined。
 *
 * 必须防非字符串：settings.json 是**用户手写**的，`"model_id": 123` 完全可能出现，
 * 而 Zod 的 `.passthrough()` 不校验 snake_case 原始键（归一化发生在它之后），
 * 于是脏值能一路到这里。直接 `.trim()` 会抛 TypeError —— 这条路径在 loadConfig 上，
 * 抛出即**整个进程起不来**（cli.ts 只 console.error + exit(1)），
 * 用户配错一个类型就完全无法启动，比「该字段不生效」严重得多。
 * 就地容错 + 由 config/schema.ts 出可读告警，是「永不因配置脏值卡死用户」的一贯口径。
 */
function normalizeWire(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * provider 侧：从 SendParams 里取出「这次请求该往线上发哪个模型名」。
 *
 * 优先级：
 *   1. `params.wireModel` —— 调用方已解析好的真名（主循环快路径，不依赖全局态）；
 *   2. 别名表翻译 `params.model` —— 兜住所有未显式传 wireModel 的调用点（side-call /
 *      headless / forked-agent / auto-compact 等，见 _aliasMap 注释）；
 *   3. `params.model` 原样 —— 没配 modelId 的绝大多数情况，零行为变化；
 *   4. `构造时固化值` —— 连 params.model 都没给的老调用点。
 *
 * 抽成函数而不是在各请求体里写 `||` 链：漏一处就是「某条路径静默发别名」，
 * 而这种错只在用户真配了 modelId 时才现形，单测容易全绿放过。
 */
export function pickWireModel(
  params: { wireModel?: string; model?: string },
  fallbackModel: string,
): string {
  if (params.wireModel) return params.wireModel;
  const alias = params.model;
  if (alias) return lookupWireModelAlias(alias) ?? alias;
  return lookupWireModelAlias(fallbackModel) ?? fallbackModel;
}
