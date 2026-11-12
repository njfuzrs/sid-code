/**
 * 工具输入的 zod 运行时校验
 *
 * 在工具边界统一拦截畸形参数（模型给出类型不符的输入）。这是新版工具接口
 * `validateInput` 想做却从未接线的事——现由执行器在调用工具前用 `zodSchema.safeParse`
 * 完成，并把 ZodError 翻译成对模型友好的结构化错误消息，提升自我纠错成功率。
 *
 * 设计要点：
 * - 用 safeParse 而非 parse：返回结果对象而不抛异常，契合工具执行的错误返回风格。
 * - 错误消息按"字段路径 + 期望/实际"逐条列出，让模型精确定位要改哪个参数。
 * - 成功时返回校验后的 data（zod 会剥离/规整），供执行器替换原始 input。
 */

import type { LegacyTool } from "./types.ts";
import { getDef, normalizeStrictNulls, unwrap } from "./nullish-normalize.ts";
import { normalizeNumericStrings } from "./numeric-coerce.ts";
import { isIgnorableUnknownKey, normalizeInputAliases } from "./input-alias.ts";
import {
  emitToolInputAliasApplied,
  emitToolInputCoerced,
  emitToolInputUnknownKeys,
} from "../trace/stream-observer.ts";

/** 校验结果。`ignoredKeys` 是「模型传了、但 schema 没声明」的顶层键（已扣掉 hook 键与无影响键名单）。 */
export type ToolInputValidation =
  | { ok: true; data: unknown; ignoredKeys?: string[] }
  | { ok: false; message: string };

/** 校验选项 */
export interface ValidateToolInputOptions {
  /**
   * 模型**原始发出**的顶层键（hook 改参之前，即 `block.input` 的键）。
   *
   * 为什么需要：`validateToolInput` 收到的是 `effectiveInput`，也就是 hook 改参之后的参数。
   * hook 往参数里注入额外字段是合法用法，那些键不是模型传的；不区分的话模型会收到
   * 「`xxx` 不是本工具的参数」，而它根本没传过这个键。
   *
   * 传了本参数时：只有**交集**里的未知键会进 `ignoredKeys`（模型可见提示），
   * hook 注入的未知键只发事件（`source: "hook"`）。
   * 不传 = 全部视为模型传的（fork 子代理等没有 hook 改参链路的调用方）。
   */
  modelKeys?: ReadonlySet<string>;
}

/**
 * 「schema 未发送」补救提示（对标 claude-code buildSchemaNotSentHint）。
 *
 * 场景：延迟加载（ToolSearch）启用时，未激活的延迟工具其完整 schema **不在**首轮上下文里。
 * 模型只看到工具名（<available-deferred-tools> 列表），却凭记忆猜参数结构直接盲调——
 * 典型翻车是把带类型的参数（数组/数字/布尔）猜错结构或猜成字符串，触发 zod 校验失败。
 *
 * 此时裸 zod 错误（"questions 期望 array 实际 undefined"）会误导模型以为是自己参数写错、
 * 反复微调猜测，而**真正根因是它根本没看到 schema**。追加本提示把根因和自救路径讲清楚：
 * 先 tool_search 激活拿到 schema，再重试。
 *
 * 返回 null 表示无需补救（未启用延迟加载 / 工具非延迟池成员 / 已激活 → schema 已发送）。
 */
export function buildSchemaNotSentHint(
  tool: LegacyTool,
  opts: { toolSearchEnabled: boolean; isDeferred: boolean; isActivated: boolean },
): string | null {
  // 三重门控（对标 claude-code：门控失配只多花一轮往返，不会造成错误行为）：
  // 1. 延迟加载未启用 → 全量工具首轮直出，参数错是模型自己的锅，别误导它去 tool_search
  // 2. 工具不在延迟池 → schema 本就发了，与「未发送」无关
  // 3. 工具已激活 → schema 已随激活进入上下文，同样已发送
  if (!opts.toolSearchEnabled) return null;
  if (!opts.isDeferred) return null;
  if (opts.isActivated) return null;
  return (
    `\n\n⚠️ 本工具（${tool.name()}）的 schema 尚未发送给你——它是延迟加载工具，` +
    `当前只有工具名在 <available-deferred-tools> 列表里，完整参数结构不在你的上下文中。` +
    `没有 schema，你只能凭记忆猜参数，带类型的参数（数组/对象/数字）极易猜错结构。` +
    `请先调用 tool_search（参数 query: "select:${tool.name()}"）激活它拿到真实 schema，再重试本次调用。`
  );
}

/**
 * 用工具的 zodSchema 校验输入。
 *
 * 工具未提供 zodSchema 时返回 { ok: true, data: input } 原样放行（回退到工具内部
 * 的手工检查），保证迁移期间未升级的工具不受影响。
 */
export function validateToolInput(
  tool: LegacyTool,
  input: unknown,
  opts: ValidateToolInputOptions = {},
): ToolInputValidation {
  const schema = tool.zodSchema;
  if (!schema) {
    return { ok: true, data: input };
  }

  // strict 契约回填：OpenAI strict 模式要求 optional 字段进 required 并用 null 表达
  // "未提供"（见 openai-responses-request.ts toStrictJsonSchema），模型遵约传 null
  // 后会被原始 zod schema 的 `.optional()` 拒绝——sid-code 让模型传 null 又拒绝它。
  // 这里在校验前把这类 null 翻译回 zod 的"未提供"表示法。
  // 只处理「optional 且未显式 nullable」的字段，`.nullable()` 的业务 null 不受影响；
  // 同时拦下 `z.coerce.*` 把 null 静默转成 0 的污染（详见 nullish-normalize.ts）。
  //
  // 别名归一放在最前（S2，20261016）：模型写 `activeForm`、协议要 `active_form`。
  // 必须先改名再做 null 回填——否则 `activeForm: null` 不会被识别为 optional 字段上的
  // null。详见 input-alias.ts（为什么不用 zod preprocess、为什么只认登记的别名对）。
  const aliased = normalizeInputAliases(schema, input);
  for (const hit of aliased.hits) {
    emitToolInputAliasApplied({ tool: tool.name(), ...hit });
  }

  // 两个归一层都是**静默成功**的，事件是它们在轨迹上唯一的存在形式（剖析 5.3 ⑤）：
  // 不发就答不了「哪一层在替模型擦屁股、哪个字段最常被归一」。只记路径与次数，
  // 不记参数值——值已经在 messages 里，事件只放能聚合的量。
  const nullish = normalizeStrictNulls(schema, aliased.value);
  for (const hit of nullish.hits) {
    emitToolInputCoerced({ tool: tool.name(), layer: "nullish", ...hit });
  }

  // 数字形态字符串回填：模型逐 token 生成 JSON 时会偶发给 number 字段多打一对引号
  // （实测 read offset:"117, 130" / "1,1"，schema 明确写了 type:number 仍然发生）。
  // `"117"`→117 是无损无歧义的转换，判成硬失败等于白烧一轮往返；只接受能确定
  // 模型意图的形态，`""`/`null`/`true`/`[]` 一律放回让 zod 报错（详见 numeric-coerce.ts）。
  const numeric = normalizeNumericStrings(schema, nullish.value);
  for (const hit of numeric.hits) {
    emitToolInputCoerced({ tool: tool.name(), layer: "numeric", ...hit });
  }

  // T2（D1）：未声明的顶层键不再静默剥离。
  //
  // 放在三层归一**之后**：别名层可能已经把 CC 风格的键改成了协议字段（`-C` → `context`），
  // 在归一之前算会把「已经被接住的键」误报成未知键（T1 合入后这一条才真正生效）。
  // 归一失败时（返回值不是对象）由 findUnknownTopLevelKeys 自己早退。
  const ignoredKeys = reportUnknownKeys(tool.name(), schema, numeric.value, opts.modelKeys);

  const result = schema.safeParse(numeric.value);
  if (result.success) {
    return ignoredKeys.length > 0
      ? { ok: true, data: result.data, ignoredKeys }
      : { ok: true, data: result.data };
  }

  // 传入 numeric.value（而非原始 input）：它是真正交给 safeParse 的那份，
  // issue.path 与它一一对应；用原始 input 会在归一改过结构时错位。
  return { ok: false, message: formatZodError(tool.name(), result.error, numeric.value) };
}

/**
 * schema 顶层声明的参数名（给「本工具的参数：a、b、c」提示用）。
 * 非顶层 object（record / union / passthrough）返回空数组。
 */
export function declaredTopLevelKeys(schema: unknown): string[] {
  const shape = topLevelShape(schema);
  return shape ? Object.keys(shape) : [];
}

/**
 * 顶层的 `z.object` shape；不满足「未知键会被剥离」的前提时返回 undefined。
 *
 * 三种不报的情况：
 * - **`.passthrough()`**（`catchall` 是 `ZodUnknown`）：未知键会被**保留**进 safeParse 的
 *   data，报「已被忽略」是假信息；
 * - `z.record` / `z.union`：没有顶层 shape，未知键语义由子 schema 决定，
 *   一次性做全的风险大于收益（边界见 Agent Note）；
 * - `.strict()` 不会走到这里：它在 safeParse 阶段直接报 `unrecognized_keys`，
 *   模型已经能看到 zod 错误，不需要再来一条「已忽略」。
 */
function topLevelShape(schema: unknown): Record<string, unknown> | undefined {
  const { inner } = unwrap(schema);
  const def = getDef(inner) as { type?: string; shape?: unknown; catchall?: unknown } | undefined;
  if (!def || def.type !== "object" || !def.shape || typeof def.shape !== "object") {
    return undefined;
  }
  const catchallType = (getDef(def.catchall) as { type?: string } | undefined)?.type;
  if (catchallType === "unknown") return undefined;
  return def.shape as Record<string, unknown>;
}

/**
 * 找出模型传了、但 schema 没声明的**顶层**键。
 *
 * 为什么必须自己做：zod v4 的 `z.object()` 默认对未知键**静默剥离**
 * （`safeParse` 成功、data 里没有它、也不报 `unrecognized_keys`），于是「传了但丢了」
 * 与「根本没传」在结果上完全一样。同文件 `findNearMissKey` 处理的正是同一条机制的
 * 另一个后果（必填字段因为键名写错而报「缺失」）。
 *
 * 只看顶层：嵌套对象（`todos[]`、`questions[]`）的形态有数组、联合、record 多种，
 * 一次做全的风险大于收益；边界写在 Agent Note 里，等 `ToolInputUnknownKeys`
 * 的数据出来再决定。
 *
 * `_` 开头的内部字段不算：它们由 `stripInternalFields` 在执行前统一剥离，
 * 模型伪造它们有独立的防线（见 internal-fields.ts），不该混进「参数名写错」的提示。
 */
export function findUnknownTopLevelKeys(schema: unknown, input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const shape = topLevelShape(schema);
  if (!shape) return [];
  return Object.keys(input as Record<string, unknown>).filter(
    (key) => !Object.hasOwn(shape, key) && !key.startsWith("_"),
  );
}

/**
 * 未知键 → 事件 + 模型可见的提示键。
 *
 * 区分 model / hook（见 `ValidateToolInputOptions.modelKeys`）：hook 注入的未知键
 * 只发事件，不进返回值——否则模型会收到「`xxx` 不是参数」，而它根本没传过这个键。
 * 返回的是**扣除名单后**、需要提示模型的键。
 */
function reportUnknownKeys(
  toolName: string,
  schema: unknown,
  input: unknown,
  modelKeys: ReadonlySet<string> | undefined,
): string[] {
  const unknown = findUnknownTopLevelKeys(schema, input);
  if (unknown.length === 0) return [];

  const fromModel = modelKeys ? unknown.filter((k) => modelKeys.has(k)) : unknown;
  const fromHook = modelKeys ? unknown.filter((k) => !modelKeys.has(k)) : [];

  const reportable: string[] = [];
  if (fromModel.length > 0) {
    const silenced = fromModel.filter((k) => isIgnorableUnknownKey(toolName, k));
    reportable.push(...fromModel.filter((k) => !isIgnorableUnknownKey(toolName, k)));
    // 静默行为在轨迹上必须有存在形式：名单里的键也进事件，只是在 silenced 字段里。
    emitToolInputUnknownKeys({ tool: toolName, keys: fromModel, source: "model", silenced });
  }
  if (fromHook.length > 0) {
    const silenced = fromHook.filter((k) => isIgnorableUnknownKey(toolName, k));
    emitToolInputUnknownKeys({ tool: toolName, keys: fromHook, source: "hook", silenced });
  }
  return reportable;
}

/** 提示里最多列出几个参数名：长 schema（todo_write 等）全列出来会把结果开头撑成一段噪音 */
const MAX_LISTED_PARAMS = 10;

/**
 * 「参数不是本工具的」提示（模型可见，由执行器拼在 tool_result 正文开头）。
 *
 * 为什么只是提示、不报错：报错会让 `-n` 这类「丢了也不影响结果」的调用白花一轮往返
 * （30 天 105 次），而且会把 `is_error` 率抬成「实现写错了」的假信号。
 * 提示的写法要让模型**下一次**不再带这个键，而不是**这一次**重来。
 */
export function buildUnknownKeysNotice(
  toolName: string,
  unknownKeys: readonly string[],
  declaredKeys: readonly string[],
): string {
  if (unknownKeys.length === 0) return "";
  const keys = unknownKeys.map((k) => `\`${k}\``).join("、");
  const shown = declaredKeys.slice(0, MAX_LISTED_PARAMS);
  const more = declaredKeys.length > shown.length ? "、…" : "";
  const params = shown.length > 0 ? `\n${toolName} 的参数：${shown.join("、")}${more}` : "";
  return `⚠️ 参数 ${keys} 不是 ${toolName} 的参数，已被忽略（本次调用按其余参数执行）。${params}`;
}

/**
 * 把 ZodError 翻译成对模型友好的中文错误消息。
 *
 * 形如：
 *   参数校验失败（工具 read）:
 *   - file_path: 期望 string，实际收到 number
 *   - offset: 期望 number，实际收到 string
 */
function formatZodError(toolName: string, error: unknown, input?: unknown): string {
  const issues = (error as { issues?: ZodIssueLike[] })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return `参数校验失败（工具 ${toolName}）: ${String((error as { message?: string })?.message ?? error)}`;
  }

  const lines = issues.map((issue) => {
    const path = issue.path && issue.path.length > 0 ? issue.path.join(".") : "(根)";
    return `- ${path}: ${translateIssue(issue, input)}`;
  });

  return `参数校验失败（工具 ${toolName}）:\n${lines.join("\n")}`;
}

/**
 * 「字段缺失」时找出模型实际传的那个近似键名。
 *
 * 为什么必须自己找：**zod 对未识别键是静默剥离，不报 `unrecognized_keys`**
 * （实测 `z.object({a}).safeParse({a,bogus})` → success，data 里没有 bogus）。
 * 所以模型把 `active_form` 写成 `activeForm` 时，zod 只会说
 * 「active_form 期望 string，实际收到 undefined」——它**看起来像"你漏传了"，
 * 而真相是"你传了，只是名字写错了"**。这两句话指向完全不同的修法，
 * 模型照着前者会去补一个它以为漏掉的字段，而不是改名。
 *
 * 实测证据：`20260907-155904-69998cf1` 的 todo_write 连续 2 轮传 camelCase
 * `activeForm`（5 个 todo 项全中），每轮 5 条一模一样的「实际收到 undefined」。
 *
 * 判据：归一化后完全相等（去掉下划线/连字符、转小写）才算命中，即只认
 * **命名风格差异**（snake_case ↔ camelCase ↔ kebab-case），不做模糊距离匹配——
 * 模糊匹配会在 `offset`/`limit` 这类短名之间乱指，把一条准确的错误变成误导。
 */
function findNearMissKey(
  input: unknown,
  path: Array<string | number> | undefined,
  expectedKey: string | number | undefined,
): string | undefined {
  if (typeof expectedKey !== "string" || !path || path.length === 0) return undefined;

  // 沿 path 走到**父容器**（path 最后一段是缺失的字段名本身）
  let cursor: unknown = input;
  for (const seg of path.slice(0, -1)) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string | number, unknown>)[seg];
  }
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;

  const canon = (k: string) => k.replace(/[_-]/g, "").toLowerCase();
  const want = canon(expectedKey);
  for (const actual of Object.keys(cursor as Record<string, unknown>)) {
    if (actual !== expectedKey && canon(actual) === want) return actual;
  }
  return undefined;
}

/**
 * 从 zod message 里提取实际收到的类型。
 *
 * zod v4 的 invalid_type message 形如 `Invalid input: expected number, received string`，
 * 而 issue 对象本身**没有** `received` 字段（v3 有，v4 移除了）。这个提取是为了让
 * 「实际收到 X」这句话真的带信息——它是给模型看的自我纠错线索。
 *
 * 提不到（zod 换措辞、自定义 message、本地化）时返回 undefined，由调用方退回
 * "unknown"：这一层只做增强，绝不因为解析失败而让整条错误消息不可用。
 */
function extractReceivedFromMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const m = message.match(/received\s+([A-Za-z_$][\w$]*)/);
  return m ? m[1] : undefined;
}

/** zod issue 的结构（v4），只取本模块需要的字段 */
interface ZodIssueLike {
  code?: string;
  path?: Array<string | number>;
  message?: string;
  expected?: string;
  received?: string;
  keys?: string[];
  /** too_small / too_big 的边界与来源（zod v4 用 origin 区分 array/string/number） */
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  /** invalid_value（枚举）的合法取值 */
  values?: unknown[];
}

/** 单条 issue → 中文描述。优先用 expected/received，回退原始 message */
function translateIssue(issue: ZodIssueLike, input?: unknown): string {
  if (issue.code === "invalid_type" && issue.expected) {
    // ⚠️ zod v4 的 invalid_type issue **不含 `received` 字段**（实测 4.4.3/4.5.4：
    // issue 只有 expected/code/path/message），实际类型只出现在 message 文本里。
    // 原实现写 `issue.received ?? "unknown"`，于是所有工具的类型错误都渲染成
    // 「实际收到 unknown」——这句话对模型零信息量，还会误导它以为参数值本身是
    // undefined。这里改成从 message 里提取真实类型，提不到才退回 unknown。
    const received = issue.received ?? extractReceivedFromMessage(issue.message) ?? "unknown";
    // 附加 zod 原始 message 作为补充信息，帮助模型自我纠正
    const suffix = issue.message ? `（${issue.message}）` : "";

    // 「实际收到 undefined」时先查是不是命名风格写错了（zod 静默剥离未识别键，
    // 于是"传错名字"与"没传"产生完全相同的报错，见 findNearMissKey 注释）。
    // 命中时把修法直接写出来：模型不必再猜是漏传还是名字不对。
    if (received === "undefined") {
      const expectedKey = issue.path?.[issue.path.length - 1];
      const actual = findNearMissKey(input, issue.path, expectedKey);
      if (actual !== undefined) {
        return (
          `字段名写错了——你传的是 \`${actual}\`，本工具的参数名是 \`${String(expectedKey)}\`` +
          `（注意下划线/大小写）。把 \`${actual}\` 改成 \`${String(expectedKey)}\` 重试即可，` +
          `不要新增字段。`
        );
      }
    }

    return `期望 ${issue.expected}，实际收到 ${received}${suffix}`;
  }

  // ── 数量/长度/范围越界：zod 原文只说"太少了"，不说底线是几、也不说该怎么办 ──
  // 实测 ask_user_question 收到 `options: [1 项]` 时，模型看到的全部信息是
  // 「Too small: expected array to have >=2 items」——它不知道上限是 4，
  // 也不知道"不用自己加'其他'选项"（UI 会自动追加）。补出边界与修法。
  if ((issue.code === "too_small" || issue.code === "too_big") && issue.origin) {
    const isSmall = issue.code === "too_small";
    const bound = isSmall ? issue.minimum : issue.maximum;
    if (bound !== undefined) {
      const unit =
        issue.origin === "array"
          ? "个元素"
          : issue.origin === "string"
            ? "个字符"
            : issue.origin === "set"
              ? "个元素"
              : "";
      const what = issue.origin === "number" ? "数值" : "长度";
      const cmp = isSmall ? "至少" : "至多";
      const detail = unit
        ? `${cmp}需要 ${String(bound)} ${unit}`
        : `${what}${cmp}为 ${String(bound)}`;
      return `${isSmall ? "太少" : "太多"}：${detail}（实际不满足）。请调整该字段后重试${
        issue.message ? `（${issue.message}）` : ""
      }`;
    }
  }

  // ── 枚举取值非法：把合法取值列出来，省掉模型一轮猜 ──
  if (issue.code === "invalid_value" && Array.isArray(issue.values) && issue.values.length > 0) {
    return `取值非法，合法取值为: ${issue.values.map((v) => String(v)).join(" | ")}`;
  }
  if (issue.code === "unrecognized_keys" && issue.keys?.length) {
    return `存在未识别的字段: ${issue.keys.join(", ")}`;
  }
  // 其余类型（custom / invalid_format / 未带 origin 的 too_small 等）透传 zod 的 message。
  // 上面几个分支都做了「拿不到结构化字段就落到这里」的降级，所以这条是真兜底，
  // 不是遗漏——zod 换措辞或新增 code 时行为退化成"照抄原文"，不会变成空消息。
  return issue.message ?? "参数不合法";
}
