/**
 * 敏感数据检测与遮盖
 *
 * 规则本体在 `permission/secret-rules.ts`（B15 统一），本文件只负责 **wide 档**的呈现：
 *
 *   - 保形遮盖（`AKIA****1234`）—— 读者是排查的人，保留头尾能看出「这一步用了哪个 key」；
 *   - 结构化 JSON 词法扫描（`maskSensitiveJson`）—— 落盘路径专用，绝不触碰 number。
 *
 * 为什么不把规则写在这里：同一形态此前在三处各写一条正则，`github_pat_` 在 R1 是 `{22,}`、
 * 在 R2 缺失、在 R3 是 `{82}` —— 私有记忆可以写进 fine-grained PAT 就是这么漏的。
 * 档位划分与「为什么 fixture 守护不在这里」见 `secret-rules.ts` 的文件头。
 *
 * strict 档（记忆闸门、团队同步）的呈现是占位替换，在 `llm/hooks/secret-redact.ts`；
 * R3 的 label-only 在 `memory/team/secret-scanner.ts`。同一命中三种输出，读者不同，都对。
 */

import { SECRET_RULES, compileSecretRule, maskValue } from "./secret-rules.ts";

/** 敏感数据匹配结果 */
export interface SensitiveMatch {
  type: string;
  value: string;
  index: number;
}

/** 内部使用的已编译规则（呈现参数从规则表来，正则复制一份带 g 的实例） */
interface CompiledWidePattern {
  type: string;
  pattern: RegExp;
  keepHead: number;
  keepTail: number;
  validate?: (value: string, index: number, text: string) => boolean;
  mask?: (m: RegExpExecArray) => string;
}

let compiled: CompiledWidePattern[] | null = null;

/**
 * wide 档规则的编译结果（模块级缓存）。
 *
 * 每次调用不重新编译：`maskSensitiveData` 会被落盘路径高频调用，而 `new RegExp`
 * 在大文件上是实打实的开销。缓存的 RegExp 实例由本模块独享 —— R2 会另建一份自己的缓存，
 * 两边不共享 `lastIndex`（它是可变状态，共享会让 exec 循环互相干扰）。
 */
function widePatterns(): CompiledWidePattern[] {
  if (compiled === null) {
    compiled = SECRET_RULES.filter((r) => r.tiers.includes("wide")).map((r) => ({
      type: r.label,
      pattern: compileSecretRule(r),
      keepHead: r.keepHead ?? 0,
      keepTail: r.keepTail ?? 0,
      validate: r.validate,
      mask: r.mask,
    }));
  }
  return compiled;
}

/**
 * 检测文本中的敏感数据
 */
export function detectSensitiveData(text: string): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];

  for (const sp of widePatterns()) {
    // 重置 lastIndex（全局正则需要）
    sp.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = sp.pattern.exec(text)) !== null) {
      if (sp.validate && !sp.validate(match[0], match.index, text)) continue;
      matches.push({
        type: sp.type,
        value: match[0],
        index: match.index,
      });
    }
  }

  return matches;
}

/**
 * 遮盖文本中的敏感数据
 * 保留头尾各 N 个字符，中间用 * 填充
 */
export function maskSensitiveData(text: string): string {
  let result = text;

  // 按匹配位置从后往前替换，避免偏移问题
  const allMatches: { index: number; length: number; masked: string }[] = [];

  for (const sp of widePatterns()) {
    sp.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = sp.pattern.exec(text)) !== null) {
      const value = match[0];
      if (value.length === 0) {
        sp.pattern.lastIndex++; // 防零宽匹配死循环
        continue;
      }
      if (sp.validate && !sp.validate(value, match.index, text)) continue;
      const masked = sp.mask ? sp.mask(match) : maskValue(value, sp.keepHead, sp.keepTail);
      allMatches.push({ index: match.index, length: value.length, masked });
    }
  }

  // 去重：重叠区间只保留一个——起点更早者优先，同起点取更长者。
  //
  // 旧实现按起点倒序、只判断「新区间的起点是否落在已选区间内」，漏了「新区间从前面
  // 跨进已选区间」这一种重叠：两段都会被替换，而后一次替换用的是原文下标，结果是乱码。
  // PEM 整块（几 KB）里的 base64 正文随机撞上 `AKIA…` 之类的短规则，正好就是这种形态。
  allMatches.sort((a, b) => a.index - b.index || b.length - a.length);
  const deduped: typeof allMatches = [];
  let coveredUntil = -1;
  for (const m of allMatches) {
    if (m.index < coveredUntil) continue;
    deduped.push(m);
    coveredUntil = m.index + m.length;
  }

  // 从后往前替换，避免偏移
  deduped.reverse();
  for (const m of deduped) {
    result = result.slice(0, m.index) + m.masked + result.slice(m.index + m.length);
  }

  return result;
}

/**
 * 结构化脱敏：对 JSON 文本**只脱敏字符串字面量内部**，绝不触碰 number / bool / null。
 *
 * 为什么需要独立一层（而不是只靠 validate 兜）：
 *   `maskSensitiveData` 是纯文本替换，对「这个位置是 JSON 数字还是字符串」一无所知。
 *   信用卡号那条已用 Luhn + isolatedNumber 修掉，但任何**未来新增**的数字类规则
 *   （手机号、身份证、订单号…）都会重新踩同一个坑，而症状是「轨迹文件静默损坏」
 *   —— 这类故障极难归因。所以落盘路径改走本函数：从类型上消灭这一整类 bug，
 *   而不是逐条规则打补丁。
 *
 * 实现方式是**词法扫描而非 parse→stringify**：逐字符走一遍，只在字符串字面量的
 * 区间内做替换，其余字节原样保留。这样做的原因有两个，都很实际：
 *   1. **保持原格式**。parse→stringify 会重排缩进/键序，让「写入的文本」与
 *      「调用方序列化出来的文本」不再逐字节相等——测试和 diff 都会莫名其妙地变。
 *   2. **不改变数值表示**。JSON.parse 走 IEEE754，`1e999`→`Infinity`、超长整数
 *      丢精度；数字压根不碰才是最稳的。
 *
 * 非 JSON 输入（或扫描中发现结构不合法）自动回退到纯文本 maskSensitiveData。
 *
 * @param text 待脱敏文本（通常是 JSON.stringify 的产物）
 * @param _indent 兼容保留：词法扫描天然保持原缩进，本参数已无作用
 */
export function maskSensitiveJson(
  text: string,
  _indent = 0,
  onFieldError?: (err: unknown) => void,
  /** 字段级脱敏函数，缺省 maskSensitiveData；仅测试注入用于触发 fail-closed 路径 */
  masker: (s: string) => string = maskSensitiveData,
): string {
  // 先确认是合法 JSON——非 JSON（日志行、纯文本）必须走纯文本脱敏，否则
  // 「没有引号包裹的凭证」会被整条漏掉。
  try {
    JSON.parse(text);
  } catch {
    return maskSensitiveData(text);
  }

  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;
    if (ch !== '"') {
      // 字符串字面量之外的一切（数字、字面量、空白、标点）原样保留
      out += ch;
      i++;
      continue;
    }

    // 找到字符串字面量的结束引号（正确处理 \\ 与 \" 转义）
    let j = i + 1;
    let closed = false;
    while (j < n) {
      const c = text[j]!;
      if (c === "\\") {
        j += 2; // 跳过被转义的那个字符
        continue;
      }
      if (c === '"') {
        closed = true;
        break;
      }
      j++;
    }
    if (!closed) {
      // 结构异常（理论上 JSON.parse 已经拦住）→ 保守起见整体退回纯文本脱敏
      return maskSensitiveData(text);
    }

    const rawLiteral = text.slice(i, j + 1); // 含两侧引号
    let decoded: string;
    try {
      decoded = JSON.parse(rawLiteral) as string;
    } catch {
      out += rawLiteral;
      i = j + 1;
      continue;
    }
    let masked: string;
    try {
      masked = masker(decoded);
    } catch (err) {
      // fail-closed，粒度是**单个字符串字段**：只把出错的这一个值换成占位，
      // 其余字段（usage / 步骤 / 工具序列）照常落盘。整文件回落原文会泄露凭证，
      // 整文件占位又会让这条会话对评测整条作废——两头都不能接受。
      if (!onFieldError) throw err;
      onFieldError(err);
      out += JSON.stringify(REDACTION_FAILED_PLACEHOLDER);
      i = j + 1;
      continue;
    }
    // 未命中任何规则时原样回填，避免转义形态被规范化（如 中 → 中）
    out += masked === decoded ? rawLiteral : JSON.stringify(masked);
    i = j + 1;
  }

  return out;
}

/** 脱敏出错时替换该字符串字段的占位。固定文本，便于在轨迹里 grep 统计。 */
export const REDACTION_FAILED_PLACEHOLDER = "[REDACTION_FAILED]";

/**
 * 结构化逐字段脱敏（maskSensitiveJson 失效时的兜底）：parse → 逐个字符串值脱敏 → stringify。
 *
 * 代价是格式会按 indent 重排、超大整数可能丢精度，所以只在词法路径失败时才走这里；
 * 换来的是「无论脱敏函数出什么错，产物都是合法 JSON 且不含未脱敏原文」。
 * 输入本身不是 JSON 时抛出，由调用方决定整条占位。
 */
export function maskJsonByWalk(
  text: string,
  indent: number,
  onFieldError: (err: unknown) => void,
  masker: (s: string) => string = maskSensitiveData,
): string {
  const maskOne = (s: string): string => {
    try {
      return masker(s);
    } catch (err) {
      onFieldError(err);
      return REDACTION_FAILED_PLACEHOLDER;
    }
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return maskOne(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[maskOne(k)] = walk(val);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(JSON.parse(text)), null, indent || undefined);
}
