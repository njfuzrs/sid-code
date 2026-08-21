/**
 * 模型名归一化 —— 「写哪些键」与「查哪些键」的唯一事实源。
 *
 * ── 为什么要独立成模块 ──────────────────────────────────────────────
 *
 * 此前归一化规则散落在三处各自演化，直接产出了一个正在生效的漏采缺陷：
 * `parseOpenRouter` 写「全名 + 裸名」两个键，`parseLitellm` 只写全名键。而 litellm 是以
 * `provider/model` 为主键组织的（实测 3040 键里 2471 个带 `/`，占 81.3%；其中 1848 个的
 * 裸名在 litellm 里根本不存在，占带前缀键的 74.8%），企业网关暴露的却是裸名
 * （`deepseek-v3`、`qwen3.5-plus`）。于是 74.8% 的 litellm 数据被存成了**永远查不到的形态**，
 * 实测 17 个网关模型（8 个对话模型）因此漏采。
 *
 * 每个 parse 函数各自决定写什么键，是结构性隐患：新增一个数据源就多一个出错点，
 * 而且写键侧与查询侧的规则漂移**不会有任何报错**——数据看着采到了，查的时候是 null。
 * 与仓库里已记录的同类教训同形（手写字段列表 + 手写分派链 → 静默丢块）。
 *
 * 所以这里把两侧收成一对互为镜像的函数，并用单测锁住对称性不变式：
 *   **`expandKeys(x)` 产出的每个键，都必须出现在 `normalizeCandidates(x)` 的候选里。**
 * 违反它就意味着「存进去了但查不到」，正是上面那个缺陷的形态。
 *
 * ── 为什么「家族基名」也归这里（2026-08-21 补齐）──────────────────
 *
 * 上面那次收敛只覆盖了采集/查询两侧，漏了第三处：`model-registry.ts` 的家族匹配自己
 * 内联着 `/-\d{4,}.*$/`（4 位起、贪吃到结尾），与本模块 `DATE_SUFFIX_RE` 的
 * 「恰好 6 或 8 位、锚定结尾」**实质不同** —— 不是"没复用同一个常量"这种整洁度问题，
 * 是两条链路对同一个模型名的日期判断会**给出不同答案**：
 *   `gpt-5.4-turbo-2026`  registry 侧剥（4 位），采集侧不剥
 *   `xxx-250324-preview`  registry 侧贪吃剥成 `xxx`，采集侧因锚定 `$` 完全不剥
 * 而这种分叉**没有任何报错**，只会在某一条链路上静默借错一个窗口值。
 *
 * 所以 `familyBaseName` 挪进来，与 `stripDateSuffix` 共用同一条长度判据。
 * 它们的**语义**仍然不同（一个锚定结尾用于精确查，一个允许尾随变体后缀用于同家族借值），
 * 刻意保留为两个函数、并用单测锁住两者的长度判据一致，见各自注释。
 *
 * ⚠ 本模块**保持零 import**。`model-registry.ts` 曾被要求「零 import 的纯数据表」
 * （`telemetry/cache-bench-core.ts:15` 的不成环判断引用了这个性质），它现在 import 本模块 ——
 * 只要本模块自己不 import 任何东西，那个不成环结论就仍然成立。新增 import 前先想清这一条。
 */

/**
 * 渠道路由前缀（连字符式）。网关给同一底层模型加供应商前缀，这些前缀不影响模型固有能力。
 * 绝不盲目按 "-" 拆分——否则会误伤 `gpt-5.6-luna` / `claude-sonnet-5` 这类正规名。
 */
const ROUTE_PREFIX_RE = /^(ali|tx|volc|origin|hw|az)-/i;

/**
 * 日期/发布批次后缀：厂商用 `-YYMMDD` / `-YYYYMMDD` / `-YYYY-MM-DD` 标注同一模型的不同批次
 * （`doubao-seed-1-8-251228`、`deepseek-v3-250324`、`qwen3.6-plus-2026-04-02`）。
 * 同一模型的不同日期快照能力相同，剥离后可命中目录里的基础名。
 * 实测：三源全查后的 15 个真实缺口里，7 个只差这一条规则。
 *
 * ⚠ 必须锚定结尾且**限定纯数字段长度恰为 6 或 8**（或 YYYY-MM-DD 形态）。
 * 放宽长度就会把 `minimax-m2.5` 之类的版本号当日期剥掉——那是这条规则唯一的真风险。
 * `claude-3-5-haiku-20241022` 剥成 `claude-3-5-haiku` 是**期望行为**（后者确实在目录里）。
 */
const DATE_SUFFIX_RE = /-(?:\d{6}|\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * 家族基名的剥离规则 = `DATE_SUFFIX_RE` 的**同一条长度判据**，外加「日期后面可以再挂
 * `-` 起头的变体后缀」。见 `familyBaseName` 的注释解释为什么这两条必须并存却不能合并。
 *
 * ⚠ 长度判据必须与 `DATE_SUFFIX_RE` 逐字一致。这两个正则是本模块唯一一对必须同步改的
 * 常量 —— 有专门的单测断言「凡 `stripDateSuffix` 会剥的，`familyBaseName` 也必须剥到
 * 同一个结果」，把这条同步关系变成机械的，而不是靠下一个人记得。
 */
const FAMILY_BASE_RE = /-(?:\d{6}|\d{8}|\d{4}-\d{2}-\d{2})(?:-.*)?$/;

/** 剥掉结尾的日期/批次后缀。无此后缀时原样返回（调用方据「是否变短」判断是否命中）。 */
export function stripDateSuffix(model: string): string {
  return model.replace(DATE_SUFFIX_RE, "");
}

/**
 * 家族基名：剥掉「日期/批次后缀」**以及它后面挂的变体后缀**，用于「同家族借值」。
 *
 * 与 `stripDateSuffix` 的区别，是这两条规则唯一真正分歧的地方，别把它们合并：
 * - `stripDateSuffix` **锚定结尾**，服务的是「剥到基础名去做一次精确查」——
 *   `deepseek-v3-250324` → `deepseek-v3`，能查到就是查到，不涉及任何借用。
 * - 本函数允许日期段**后面还跟东西**，服务的是「两个名字算不算同一家族」——
 *   `claude-sonnet-4-20260101` 与表里 `claude-sonnet-4-20250514` 的家族基名都是
 *   `claude-sonnet-4`，于是前者能借后者的窗口。锚定结尾的规则算不出这种相等。
 *
 * ⚠ 日期段之后只允许 `-` 起头的变体后缀，且**长度判据与 `DATE_SUFFIX_RE` 完全一致**
 * （恰好 6 或 8 位纯数字，或 YYYY-MM-DD）。这一条是本次统一的全部意义：
 * 此前 `model-registry.ts` 用的是 `/-\d{4,}.*$/`（4 位起、贪吃到结尾），
 * 与查询侧的 6/8 位锚定规则**实质不同**，两条链路对同一个名字的判断会分叉，
 * 而分叉不会有任何报错 —— 只会在某一条链路上静默借错值。
 *
 * 实测这次收紧只改变 2 个注册表键的家族基名（`grok-4.20-0309-reasoning` /
 * `-non-reasoning`：旧规则算成 `grok-4.20`，新规则不剥、家族基名即全名）。
 * 那意味着 `grok-4.20-0310` 这类**未来批次**不再能借到它们 —— 这是**期望行为**：
 * `0309` 是 4 位批次号而非 6/8 位日期，把它当日期剥掉本就是旧正则放太宽的产物，
 * 而 `-reasoning` / `-non-reasoning` 是**能力变体**（两者行为不同），
 * 借用它们的值给一个只知道批次号的名字，属于「猜得没有约束」。
 * 收紧后这类名字落到 `resolveFallbackWindow` 或 400 自愈，与剩下 8 个变体后缀缺口同一处置。
 */
export function familyBaseName(model: string): string {
  return model.replace(FAMILY_BASE_RE, "");
}

/** 取最后一段路径（`azure/eu/gpt-5.1-chat` → `gpt-5.1-chat`）。无 "/" 时原样返回。 */
function tailSegment(id: string): string {
  return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

/**
 * 采集侧：一条外部目录记录应当登记的**全部**缓存键（小写，去重，顺序由精确到宽松）。
 *
 * 三个 parse 函数统一调用这一个函数，不再各自判断。
 *
 * ⚠ 调用方必须对返回的每个键都 **append 一条候选值**，不能「先到先得只写第一个」——
 * 同一裸名可能来自多个 provider（`azure_ai/deepseek-v3` 与 `deepinfra/.../DeepSeek-V3`
 * 是两个部署、两个真实值），在写键这一层收敛分布会直接废掉多源众数投票。
 */
export function expandKeys(rawId: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  };
  push(rawId);
  push(tailSegment(rawId));
  return out;
}

/**
 * 查询侧：一个模型名的归一化候选键（由精确到宽松，首个命中即采用）。
 *
 * 层级：原样 → 剥 vendor 路径前缀 → 剥渠道路由前缀 → 剥日期后缀（最宽松，放最后）。
 *
 * 日期剥离刻意排在最后：它是四条规则里唯一可能跨越「不同发布批次」的近似，
 * 前面任何一级命中都比它更可信。
 */
export function normalizeCandidates(model: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  };

  // ── 精确层：原样 / vendor 路径前缀 / 渠道路由前缀 ──
  const exact: string[] = [];
  const pushExact = (s: string) => {
    const v = s.trim().toLowerCase();
    if (v && !exact.includes(v)) exact.push(v);
  };
  pushExact(model);
  pushExact(tailSegment(model));
  const stripped = model.replace(ROUTE_PREFIX_RE, "");
  if (stripped !== model) {
    pushExact(stripped);
    pushExact(tailSegment(stripped));
  }
  for (const c of exact) push(c);

  // ── 最宽松层：上面每个候选再剥一次日期后缀 ──
  for (const c of exact) {
    const bare = stripDateSuffix(c);
    if (bare !== c) push(bare);
  }

  return out;
}
