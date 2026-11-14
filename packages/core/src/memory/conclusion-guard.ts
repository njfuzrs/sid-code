/**
 * P1-1（MD3）：索引已满时，同 key 更新必须留下「结论级替换」的痕迹。
 *
 * ## 缺陷背景
 *
 * 后台提取代理把新事实写进**同一个 key**，旧条目的主题陈述被静默替换：磁盘上
 * 那条记忆的标题还是旧的，正文讲的已经是另一件事（MD3「同 key 静默追加导致主题混杂」）。
 * 索引已截断（`index_full`）时这个问题被放大 —— 新建 key 大多直接成为「磁盘上有、
 * 模型看不见」的孤儿，写入压力全压到既有 key 上，于是「同 key 覆盖」成了常态。
 *
 * ## 判据是结构性的，不是语义的
 *
 * 不做中文语义比较（「这两句话是不是同一个意思」无法用字符串判定）。只问一件事：
 *
 * > 旧条目正文的**首行结论**（`Why:` 之前那句主题陈述）还在不在新 value 里？
 *
 * - 还在 → 这是细节级更新（补充事实、修措辞、加例子），放行；
 * - 不在 → 这是结论级替换，要求新 value 里出现 `推翻：` / `纠正：` 标签，否则拒绝。
 *
 * ## 「更新：」刻意不进标记表
 *
 * 它和「追加」是同一个意思。放进来等于所有普通更新都能通过这道闸门，
 * 这条闸门就白加了 —— 与 `NEGATION_ACK_MARKERS` 排除「更正：/修改：」是同一个理由。
 *
 * ## 覆盖边界（诚实说明）
 *
 * - **拦**：旧主题陈述消失的结论级替换（这是 MD3 的主要形态）。
 * - **不拦**：旧结论还在、后面又跟了一大段新主题的「混杂式追加」。它同样让一条记忆
 *   承载两件事，但首行结论没丢 —— 结构判据分不出来，那部分靠 P1-2 的核实轮次与人工 review。
 * - **不拦**：拿不到可判定的主题陈述（为空、归一化后短于 `MIN_CONCLUSION_CHARS`）。
 *   一个 5 个字的「主题」在任何新内容里都能被包含，拿它当判据只会让闸门恒开，
 *   还会让人误以为防住了。
 */

/**
 * 结论级替换的放行标记。
 *
 * 只要求「写出来」，不判断「这次推翻是否成立」—— 与 P0-4 的 `NEGATION_ACK_MARKERS`
 * 同一类设计：写出来之后，人和下一次 review 才有据可查；不写就默认它是静默替换。
 *
 * 标签后允许先跟一个 key 或旧结论（`推翻 no-move-doc：…`），这是 P0-4 已经教给模型的写法，
 * 不能因为格式差异把合法声明判成不合格（漏放行 = 合法的纠正写入被拒）。
 */
export const CONCLUSION_OVERTURN_MARKERS = ["推翻", "纠正"] as const;

/** 首行结论归一化后短于这个长度就不做判定（见文件头的「覆盖边界」） */
export const MIN_CONCLUSION_CHARS = 8;

/** 标签前面必须是行首或句读（与 `referencesNegation` 同一口径，避免行文里的自然用词） */
const LABEL_LEAD_RE = /(?:^|\n)[ \t>*\-]*$/;

/** `Why:` 的几种真实写法：`Why:` / `Why：` / `**Why:**` */
const WHY_LABEL_RE = /\*{0,2}Why\*{0,2}\s*[:：]/;

/**
 * 归一化：去掉空白与中英文标点，只留文字与数字。
 *
 * 判据问的是「主题陈述还在不在」，不该因为换行、缩进、英式句号与中文句号的差异
 * 判出两个结果 —— 那种失败形态是「同一句话换个排版就被拦」，比漏拦更容易被人卸掉闸门。
 */
function normalizeForCompare(s: string): string {
  return s
    .replace(
      /[\s\u3000，。；：、！？「」『』“”‘’（）《》【】〔〕—…·,.!?;:'"()[\]{}<>/\\|`~@#$%^&*+=_-]/g,
      "",
    )
    .toLowerCase();
}

/**
 * 取一条记忆正文的**首行结论**：第一个非空行里、`Why:` 之前那句主题陈述。
 *
 * 为什么只用首行：`Why:` 之后是理由、`How to apply:` 之后是操作细则，它们本来就会随
 * 场景改写；真正决定「这条记忆讲的是哪件事」的，是开头那句陈述。用整段 value 比较会让
 * 所有细节级更新都被判成结论级替换（误拦率过高，闸门会被绕过）。
 *
 * 返回空串 = 这条记忆没有可判定的主题陈述（例如正文开头就是 `Why:`）。
 */
export function leadingConclusion(value: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  const m = firstLine.match(WHY_LABEL_RE);
  const head = m && m.index !== undefined ? firstLine.slice(0, m.index) : firstLine;
  return head.trim().replace(/[。；;，,\s]+$/, "");
}

/**
 * 新 value 是否声明了「这是结论级替换」。
 *
 * 两种合规写法（任一成立即放行），都要求标签在行首（或句读后）且冒号后有实际内容：
 * 1. `推翻：<旧结论不成立的理由>`
 * 2. `纠正：<新结论>`
 *
 * 遍历**全部**出现位置，不能只看第一个：正文里先出现一句自然用词（「这不是推翻：而是……」）、
 * 后面才是真正的行首声明时，只看首次出现会漏放行。
 */
export function hasOverturnMarker(value: string): boolean {
  return CONCLUSION_OVERTURN_MARKERS.some((marker) => {
    let idx = value.indexOf(marker);
    while (idx >= 0) {
      const atLineStart = LABEL_LEAD_RE.test(value.slice(0, idx));
      if (atLineStart) {
        // 标签后允许先跟 key / 旧结论（最多 80 字，避免把整段正文都当标签前缀），
        // 但冒号之后必须有实际内容 —— 空标签等于没说明理由。
        const rest = value.slice(idx + marker.length);
        const colon = rest.match(/^[^：:\n]{0,80}[：:]/);
        if (colon) {
          const afterColon = rest.slice(colon[0].length).trim();
          if (afterColon.length > 0) return true;
        }
      }
      idx = value.indexOf(marker, idx + marker.length);
    }
    return false;
  });
}

export interface ConclusionConflict {
  /** 旧条目的首行结论（回告里原样展示给模型，方便它抄进「推翻：」） */
  oldConclusion: string;
}

/**
 * 判据主函数：这次同 key 更新是不是「结论级替换却没留痕」。
 *
 * 返回 `null` = 放行；返回对象 = 拒绝，`oldConclusion` 用于回告。
 *
 * ⚠️ 调用方必须在**索引已满**时才调它（见 `readIndexCapacity().truncated`）。索引没满时
 * 新建 key 是可行的，不该把「同 key 覆盖」也一并收紧 —— 那会让正常迭代记忆的成本上升，
 * 而这个闸门要解决的只是「索引满 → 写入压力全压到老 key → 老 key 被静默换主题」。
 */
export function findConclusionReplacement(
  oldValue: string,
  newValue: string,
): ConclusionConflict | null {
  const oldConclusion = leadingConclusion(oldValue);
  const normalizedOld = normalizeForCompare(oldConclusion);
  if (normalizedOld.length < MIN_CONCLUSION_CHARS) return null;
  if (hasOverturnMarker(newValue)) return null;
  if (normalizeForCompare(newValue).includes(normalizedOld)) return null;
  return { oldConclusion };
}
