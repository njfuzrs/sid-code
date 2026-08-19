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

/** 剥掉结尾的日期/批次后缀。无此后缀时原样返回（调用方据「是否变短」判断是否命中）。 */
export function stripDateSuffix(model: string): string {
  return model.replace(DATE_SUFFIX_RE, "");
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
