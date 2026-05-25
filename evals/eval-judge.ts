import Anthropic from "@anthropic-ai/sdk";

export interface DimScore {
  pass: boolean;
  /**
   * null 表示该维度"无可评分数据"（数据缺失 / judge 不可用），应在 aggregate 中跳过、
   * 不当作 0 也不当作 1。区别于 0（实测为 0）—— null 是"没法测"，0 是"测了但全错"。
   *
   * 旧实现把缺数据兜底给 1.0，会让挂掉的 case 在 tool/efficiency/cost 三个维度白拿满分，
   * 总分 ~2.5，污染均值（17% 错误率均分仍能稳在 4.1 看起来"还行"）。
   */
  score: number | null;
  reason: string;
}

/**
 * Token 用量分项（来自 wrapper 上报）。
 * 用于 gradeCost 折算 cache_read（cache 复用计费 ~0.1x，不应按 raw token 全价计入）。
 */
export interface TokenBreakdown {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}

export interface AgentMeta {
  tools_used: string[];
  files_edited: string[];
  total_steps: number;
  total_tokens: number;
  /**
   * 可选 token 分项；若 wrapper 未上报则 gradeCost 退化为按 total_tokens 评分（不折算 cache）。
   * 上报后 gradeCost 会按 input + output + cache_creation + cache_read * 0.1 折算，
   * 让 sid-code（无 cache）和 claude-code（重 cache）在 cost 维度可比。
   */
  token_breakdown?: TokenBreakdown;
}

/**
 * 判断一个锚点是否属于"代码标识符 / 路径 / 类型"(应排除 echo 检查)。
 *
 * 设计：代码层面的标识符即便用户在 query 中提到，agent 在回答里引用也是真实命中——
 * 用户提供路径是"指引"，agent 引用是"定位"，两者本就该重合。
 *
 * 排除 echo 检查的判定（满足任一即认为是"代码标识符"）：
 *   - 含路径分隔符 `/` 或 `.` 跟随小写字母（文件路径如 src/foo.ts, foo.bar）
 *   - 全英文 + 至少 1 个大写字母（驼峰类名/标识符 QuotaManager / AgentLoopRunner）
 *   - 含括号 `(` 或 `)`（函数调用如 it( / check()）
 *   - 含特殊字符 `:` `<` `>` `=`（运算符/类型注解如 >= / ratio:）
 *   - 全英文小写字母 + 数字组合但含分隔符如 `bun:test` / `auto-retry`
 *
 * 不排除（即应用 echo 检查）：自然语言短语（"更好" / "哪方面" / "请确认"等）
 */
function isCodeIdentifier(anchor: string): boolean {
  if (/[\/.]/.test(anchor) && /[a-zA-Z]/.test(anchor)) return true;
  if (/[()]/.test(anchor)) return true;
  if (/[:<>=]/.test(anchor)) return true;
  if (anchor.length >= 4 && /^[A-Za-z]+$/.test(anchor) && /[A-Z]/.test(anchor)) return true;
  if (/-/.test(anchor) && /[a-zA-Z]/.test(anchor)) return true;
  return false;
}

/**
 * 锚点 substring 去重：如果 A 是 B 的真子串且都被 output 命中，A 就不算独立命中。
 *
 * 修复历史 bug（审查 #4）：
 *   case_001 锚点 [src/agent/loop.ts, agent/loop, loop.ts] 互相 substring，
 *   一个错答 "src/query/loop.ts" 命中 "loop.ts" → score=0.5（误命中）；
 *   一个对答 "src/agent/loop.ts" 命中 3 个锚点 → 满分阈值轻易达到，鉴别度也虚高。
 *
 * 规则：保留最长锚点，丢弃被它包含的更短锚点（仅在双方都命中时去重，未命中的短锚点保留以保证未命中分支语义不变）。
 */
function dedupSubstringHits(hits: string[]): string[] {
  const sorted = [...hits].sort((a, b) => b.length - a.length); // 长在前
  const kept: string[] = [];
  for (const h of sorted) {
    const isSubstrOfKept = kept.some((k) => k !== h && k.includes(h));
    if (!isSubstrOfKept) kept.push(h);
  }
  return kept;
}

/**
 * 默认维度权重。efficiency 权重保留为 0.3（W1 时为 1.0），原因：
 *   efficiency 与 rubric 反向相关——更勤奋的 agent 多调几次工具拿到更好答案，
 *   反而被 efficiency 扣分。降低权重让 cost 和 efficiency 加起来才相当于一个维度。
 *   并且 gradeEfficiency 现在会读 rubric 分数：rubric 高时 efficiency 不扣分（仅 reason 标黄）。
 */
export const DEFAULT_WEIGHTS: Record<string, number> = {
  anchor_hit: 1.5,
  rubric_score: 4.0,
  tool_compliance: 1.5,
  efficiency: 0.3,
  cost: 0.5,
};

/**
 * 锚点命中评分。
 *
 * 设计原则（修复 case_007 / case_028 / case_030 类问题）:
 * - must_include_any_of 的语义是"命中任一即可合格"，不应该因为锚点表写得长就降低 score
 * - 但如果一个锚点都没命中，明显是答非所问，给低分
 *
 * 评分规则（v3，2026-05-25 调整后）:
 *   hitCount == 0:  0.0（答非所问）
 *   hitCount == 1:  0.5（any_of 任一命中的基础合格分，回归 v1 拉鉴别度）
 *   hitCount >= max(2, ceil(total*0.3)): 1.0（满分阈值放宽到 30%）
 *   中间区间在 0.5 ~ 1.0 间线性插值
 *
 * 与 v2（地板 0.8）的对比：
 *   - v2: 单 hit = 0.8 → 90% 的 case anchor 都 ≥ 0.8 鉴别度严重不足（天花板效应）
 *   - v3: 单 hit = 0.5 → 把 anchor 维度的鉴别区间还回来，case_030 类靠 must_call_tools_mode=any_of 单独豁免
 *
 * Substring 去重（v4，2026-05-25 新增，审查 #4）:
 *   命中集去重：长锚点命中后，被其包含的短锚点不再独立计入命中数。
 *   防止 case_001 类锚点表里 [src/agent/loop.ts, agent/loop, loop.ts]
 *   一个对答命中 3 项虚高，或一个错答 "src/query/loop.ts" 命中 loop.ts 误得 0.5。
 *
 * Echo 排除（2026-05-25 新增）:
 *   userQuery 里出现的锚点不计入命中（防止"复读用户问题"被算成答对）。
 *   例：case_022 锚点"更好"恰好是用户原话"把那个权限模块改一下让它更好"中的词，
 *   agent 只要 echo 用户问题就 100% 命中——必须排除。
 *
 *   ⚠️ Echo 排除仅对"自然语言短语"生效；代码标识符 / 路径 / 类名（详见 isCodeIdentifier）
 *      即便在 query 里提到也不排除——用户给路径是"指引"，agent 引用是"定位"，
 *      两者本就应当重合。这避免了 case_015 类副作用：用户 query 提供 path 锚点，
 *      被全部 echo 排除后只剩自然词，导致 agent 真实回答路径仍判 0 分。
 */
export function gradeAnchorHit(
  output: string,
  anchors: string[],
  userQuery?: string,
): DimScore {
  if (anchors.length === 0) {
    return { pass: true, score: 1.0, reason: "无锚点，跳过" };
  }
  // Echo 排除：仅对"自然语言短语"生效（短中文短词 / 短英文）；
  // 代码标识符/路径/类名跳过 echo 检查（用户提及 ≠ 复读获分）
  const echoExcluded: string[] = [];
  const effective = userQuery
    ? anchors.filter((a) => {
        if (isCodeIdentifier(a)) return true; // 代码标识符不排除
        if (userQuery.includes(a)) {
          echoExcluded.push(a);
          return false;
        }
        return true;
      })
    : anchors;

  // 全部锚点都被 echo 排除：当作"无可评锚点"，不当作 0 分（避免冤枉）
  if (effective.length === 0) {
    return {
      pass: true,
      score: 1.0,
      reason: `所有锚点（${anchors.length}）均出现在用户 query 中，echo 排除后无可评锚点`,
    };
  }

  const rawHits = effective.filter((a) => output.includes(a));
  // Substring 去重：消除"长锚点和它的子串短锚点同时命中算 2 个"的虚高
  const hits = dedupSubstringHits(rawHits);
  const dedupedCount = rawHits.length - hits.length;
  const hitCount = hits.length;
  const total = effective.length;

  // 满分阈值：max(2, ceil(total*0.3))。锚点表越长，满分阈值百分比越宽松。
  const fullScoreThreshold = Math.max(2, Math.ceil(total * 0.3));
  const BASE_SCORE = 0.5; // v3 单 hit 基础分（v2 是 0.8 → 天花板效应）
  let score: number;
  if (hitCount === 0) {
    score = 0;
  } else if (hitCount === 1) {
    score = BASE_SCORE;
  } else if (hitCount >= fullScoreThreshold) {
    score = 1.0;
  } else {
    const ratio = (hitCount - 1) / (fullScoreThreshold - 1);
    score = BASE_SCORE + (1.0 - BASE_SCORE) * ratio;
  }

  const pass = hitCount >= 1;
  const missing = effective.filter((a) => !output.includes(a));
  const echoNote = echoExcluded.length > 0 ? `；echo 排除 ${echoExcluded.length} 项: ${echoExcluded.join(", ")}` : "";
  const dedupNote = dedupedCount > 0 ? `；substring 去重 ${dedupedCount} 项` : "";
  const reason =
    hitCount === total
      ? `全部命中: ${hits.join(", ")}${echoNote}${dedupNote}`
      : hitCount >= fullScoreThreshold
        ? `命中 ${hitCount}/${total}（达到满分阈值 ${fullScoreThreshold}）: ${hits.join(", ")}${echoNote}${dedupNote}`
        : hitCount > 0
          ? `命中 ${hitCount}/${total}（满分阈值 ${fullScoreThreshold}）: ${hits.join(", ")}; 未命中: ${missing.join(", ")}${echoNote}${dedupNote}`
          : `未命中任何锚点: ${effective.join(", ")}${echoNote}`;
  return { pass, score, reason };
}

/**
 * 从 LLM 输出中稳健抽取 JSON 对象。
 *
 * 旧实现：text.match(/\{[\s\S]*\}/) 贪婪匹配
 *   - 如果 judge 在思考段写了 `{ "示例": ... }` 然后写最终 JSON，
 *     正则会从第一个 { 抓到最后一个 }，整段不是合法 JSON → JSON.parse 失败 → 兜底 0 分
 *   - 这是 case_022/028 跨次方差大的根因之一
 *
 * 新实现：从字符串末尾向前找最后一个完整 JSON 对象（带括号计数）。
 *   - 能正确处理"思考段含示例 JSON + 末尾真正答案 JSON"
 *   - 能处理 ```json ... ``` 代码块包裹
 *   - 能处理首尾空白、markdown
 *
 * 复杂度保护（v2，审查 #13）：
 *   末尾扫描限制在最后 SCAN_TAIL_BYTES 字节内，避免 100KB+ markdown 输出触发 O(n²) 退化。
 *   judge 的最终 JSON 不可能在前 N-4KB 处（max_tokens 2048 ≈ 4KB），保留这个上限。
 */
const SCAN_TAIL_BYTES = 4096;

export function extractJsonObject(text: string): { json: string; ok: true } | { json: null; ok: false; reason: string } {
  if (!text || typeof text !== "string") return { json: null, ok: false, reason: "empty" };
  const trimmed = text.trim();

  // 路径 1：整段就是合法 JSON
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      JSON.parse(trimmed);
      return { json: trimmed, ok: true };
    } catch { /* 进入路径 2 */ }
  }

  // 路径 2：剥离 markdown 代码块包裹（取最后一个 ```json``` 块，judge 答案通常在最末）
  const fenceMatches = [...trimmed.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?```/g)];
  if (fenceMatches.length > 0) {
    // 倒序尝试，judge 最终 JSON 通常在最后一个 code block
    for (let i = fenceMatches.length - 1; i >= 0; i--) {
      const inside = fenceMatches[i][1].trim();
      try {
        JSON.parse(inside);
        return { json: inside, ok: true };
      } catch { continue; }
    }
  }

  // 路径 3：从末尾向前找最后一个完整的 JSON 对象（限制扫描范围避免 O(n²)）
  const scanStart = Math.max(0, trimmed.length - SCAN_TAIL_BYTES);
  const tail = trimmed.slice(scanStart);
  for (let endIdx = tail.length - 1; endIdx >= 0; endIdx--) {
    if (tail[endIdx] !== "}") continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = endIdx; i >= 0; i--) {
      const ch = tail[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"' && !escape) { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "}") depth++;
      else if (ch === "{") {
        depth--;
        if (depth === 0) {
          const candidate = tail.slice(i, endIdx + 1);
          try {
            JSON.parse(candidate);
            return { json: candidate, ok: true };
          } catch { break; } // 这个区间不是合法 JSON，跳到下一个 endIdx
        }
      }
    }
  }

  return { json: null, ok: false, reason: `无法从输出中抽取合法 JSON: ${trimmed.slice(0, 200)}` };
}

interface JudgeResult {
  pass: boolean;
  score: number;
  reason: string;
}

/**
 * Rubric 档位制（v5，2026-05-25，审查 #8）：
 *   judge 的 score 必须落到 {0, 0.3, 0.6, 0.85, 1.0} 之一。
 *   边界值（如 0.27 / 0.95）会被吸附到最近档位，减少 LLM 浮点判断的方差。
 *   档位语义在 prompt 里强化（参见 _judge/rubric-template.ts）。
 */
const RUBRIC_TIERS: readonly number[] = [0, 0.3, 0.6, 0.85, 1.0];

function snapToTier(score: number): number {
  let best = RUBRIC_TIERS[0];
  let bestDist = Infinity;
  for (const t of RUBRIC_TIERS) {
    const d = Math.abs(score - t);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

async function callJudgeOnce(
  client: Anthropic,
  judgeModel: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<JudgeResult | { error: string; status?: number }> {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const msg = await client.messages.create({
        model: judgeModel,
        max_tokens: 2048, // v3: 从 256 提升到 2048。reason p90=285 字符（中文 ~570 token），256 会截断
        temperature: 0, // v3: 确定性输出，消除随机性带来的方差（旧实现默认 1.0 → 同输入跨次差 1.5 分）
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" }, // 缓存系统提示词，多 case 共享判分规则部分
          },
        ],
        messages: [{ role: "user", content: userPrompt }],
      });
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");
      const extracted = extractJsonObject(text);
      if (!extracted.ok) {
        return { error: `judge 返回无法解析: ${text.slice(0, 200)}` };
      }
      try {
        const parsed = JSON.parse(extracted.json) as { pass: boolean; score: number; reason: string };
        const rawScore = Number(parsed.score);
        if (!Number.isFinite(rawScore)) {
          return { error: `judge score 非数值: ${extracted.json.slice(0, 120)}` };
        }
        // 吸附到档位（v5），减少边界跳变方差
        const score = snapToTier(rawScore);
        return {
          pass: Boolean(parsed.pass),
          score,
          reason: rawScore !== score
            ? `${String(parsed.reason ?? "")} [snap ${rawScore.toFixed(2)}→${score}]`
            : String(parsed.reason ?? ""),
        };
      } catch {
        return { error: `JSON.parse 失败: ${extracted.json.slice(0, 120)}` };
      }
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const retryable = status === 429 || status === 503 || status === 500 || status === 502 || status === 504;
      if (!retryable || attempt === maxRetries) {
        return {
          error: err instanceof Error ? err.message : String(err),
          status,
        };
      }
      const delayMs = Math.min(30_000, 2_000 * Math.pow(2, attempt));
      process.stderr.write(`[gradeRubric] judge API ${status} 第 ${attempt + 1}/${maxRetries} 次失败，${delayMs}ms 后重试\n`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return { error: "重试用尽" };
}

/**
 * 把 buildRubricPrompt 的输出拆成 system / user 两部分。
 *
 * 拆分规则：
 *   system = 静态判分规则（评判规则 / 评分维度定义 / 评分标准 / 输出格式）
 *   user = case 特定信息（任务类别 / 用户问题 / 参考答案 / must_include 等 + agent 输出）
 *
 * 这样：
 *   - system 可以走 prompt cache（多 case 共享）→ 降低 judge 成本约 60%
 *   - 把"硬扣分规则"放在 system 显著位置，judge 更不容易忽略
 *
 * rubric-template.ts 现在直接返回 { system, user } 结构。
 * 但为了向后兼容（其他地方可能还传整段 prompt），这里做兼容拆分：
 * 如果传入是字符串（旧格式），就把整段塞进 user，system 用通用兜底。
 */
function splitRubricPrompt(rubricPrompt: string | { system: string; user: string }): { system: string; user: string } {
  if (typeof rubricPrompt === "object" && rubricPrompt.system && rubricPrompt.user) {
    return rubricPrompt;
  }
  // 兼容旧字符串格式：整段当 user，system 用最小兜底
  return {
    system: '你是一个 coding agent 评测裁判。请基于提供的 case 信息和 agent 输出严格打分。\n输出格式: {"pass": bool, "score": 0.0-1.0, "reason": "简要理由"}',
    user: rubricPrompt as string,
  };
}

/**
 * Self-consistency: 多次采样取中位数。
 *
 * 旧实现：单次采样 + temperature 默认 1.0 → 跨次方差 1.5+ 分
 * 新实现：
 *   - temperature=0 单次足够稳定（确定性输出，同输入同输出）
 *   - 但 LLM 在边界 case 上仍会因 prompt 微调跳变（0.85 vs 0.95）
 *   - 显式传 samples > 1 时，跑多次取 score 中位数 + 选 score 最接近中位数那次的 reason
 *
 * 默认 samples=1（temperature=0 + 档位制已经够稳，不浪费 quota）
 */
export async function gradeRubric(
  output: string,
  rubricPrompt: string | { system: string; user: string },
  judgeModel = "claude-sonnet-4-5-20250929",
  samples = 1,
): Promise<DimScore> {
  const client = new Anthropic();
  const { system, user } = splitRubricPrompt(rubricPrompt);
  const fullUser = `${user}\n\n=== 待评测的 Agent 输出 ===\n${output}`;

  const results: JudgeResult[] = [];
  const errors: string[] = [];
  for (let i = 0; i < Math.max(1, samples); i++) {
    const r = await callJudgeOnce(client, judgeModel, system, fullUser);
    if ("error" in r) {
      errors.push(r.error);
      continue;
    }
    results.push(r);
  }

  if (results.length === 0) {
    // 所有采样都失败：score=null 让 aggregate 跳过该维度
    return {
      pass: false,
      score: null,
      reason: `LLM judge 不可用（${errors.length} 次全失败）: ${errors[0]?.slice(0, 100) ?? "unknown"}`,
    };
  }

  if (results.length === 1) {
    return { pass: results[0].pass, score: results[0].score, reason: results[0].reason };
  }

  // 多次采样：score 取中位数；reason 取与中位数最接近那次（便于追溯）
  const sortedScores = results.map(r => r.score).sort((a, b) => a - b);
  const mid = Math.floor(sortedScores.length / 2);
  const medianScore = sortedScores.length % 2 === 0
    ? (sortedScores[mid - 1] + sortedScores[mid]) / 2
    : sortedScores[mid];
  // 选 reason：取离中位数最近的一次，避免均值影响 reason 文本
  let bestReason = results[0];
  let bestDist = Infinity;
  for (const r of results) {
    const d = Math.abs(r.score - medianScore);
    if (d < bestDist) { bestDist = d; bestReason = r; }
  }
  const passCount = results.filter(r => r.pass).length;
  const allScores = results.map(r => r.score.toFixed(2)).join("/");
  return {
    pass: passCount > results.length / 2,
    score: medianScore,
    reason: `[median of ${results.length} samples: ${allScores}] ${bestReason.reason}`,
  };
}

export function gradeToolCompliance(
  meta: AgentMeta,
  expected: {
    mustCallTools?: string[];
    /** 工具调用模式：all_of(默认，所有都必须用) | any_of(任一即可) */
    mustCallMode?: "all_of" | "any_of";
    mustNotCallTools?: string[];
    /** 修改文件白名单：files_edited 必须全部以这些前缀之一开头（等于"必须只改这里面的"） */
    mustModifyFilesIn?: string[];
    mustNotModifyFiles?: string[];
  }
): DimScore {
  const { tools_used, files_edited, total_steps } = meta;
  // 工具名归一化：claude-code wrapper 报 PascalCase（Read/Grep/Glob），
  // sid-code wrapper 报小写（read/grep/glob），case yaml 一律小写。
  // 不归一化会让 claude-code 的 any_of 永远失败（实测 case_030 命中 any_of=0.6）。
  const toolsUsedLower = tools_used.map((t) => t.toLowerCase());
  const mustCallTools = (expected.mustCallTools ?? []).map((t) => t.toLowerCase());
  const mustCallMode = expected.mustCallMode ?? "all_of";
  const mustNotCallTools = (expected.mustNotCallTools ?? []).map((t) => t.toLowerCase());
  const mustModifyFilesIn = expected.mustModifyFilesIn ?? [];
  const mustNotModifyFiles = expected.mustNotModifyFiles ?? [];

  // sideband metadata 全空：trajectory 没落盘 / wrapper 失败 / case 真的没用工具。
  // 无法区分"用了但读不到"和"压根没用"，给 null 让 aggregate 跳过——
  // 旧实现给 1.0 会让挂掉的 case 在 tool 维度白拿满分。
  if (
    tools_used.length === 0 &&
    files_edited.length === 0 &&
    (total_steps ?? 0) === 0
  ) {
    return {
      pass: false,
      score: null,
      reason: "sideband metadata 缺失（trajectory 未落盘或 wrapper 失败），跳过工具合规检查",
    };
  }

  let score = 1.0;
  const reasons: string[] = [];

  if (mustCallTools.length > 0) {
    const hits = mustCallTools.filter((t) => toolsUsedLower.includes(t));
    if (mustCallMode === "any_of") {
      // any_of：命中任一即满分
      if (hits.length === 0) {
        score -= 0.4;
        reasons.push("未使用任何要求的工具(any_of): " + mustCallTools.join("|"));
      }
    } else {
      // all_of（默认）：按命中比例扣分
      if (hits.length < mustCallTools.length) {
        score -= 0.4 * (1 - hits.length / mustCallTools.length);
        reasons.push(
          "未使用要求的工具: " + mustCallTools.filter((t) => !toolsUsedLower.includes(t)).join(", ")
        );
      }
    }
  }

  for (const t of mustNotCallTools) {
    if (toolsUsedLower.includes(t)) {
      score -= 0.3;
      reasons.push("使用了禁止的工具: " + t);
    }
  }

  // mustModifyFilesIn：files_edited 必须全部以白名单前缀之一开头。
  // 只在 must_modify_files_in 非空时检查（空数组语义 = 不限制，避免误伤无修改的 case）。
  if (mustModifyFilesIn.length > 0 && files_edited.length > 0) {
    const violations = files_edited.filter(
      (f) => !mustModifyFilesIn.some((p) => f.startsWith(p) || f === p)
    );
    if (violations.length > 0) {
      score -= 0.4;
      reasons.push("修改了白名单外的文件: " + violations.slice(0, 3).join(", "));
    }
  }

  for (const pattern of mustNotModifyFiles) {
    const violations = files_edited.filter((f) => f.startsWith(pattern) || f === pattern);
    if (violations.length > 0) {
      score -= 0.5;
      reasons.push("修改了禁止的文件: " + violations.join(", "));
    }
  }

  score = Math.max(0, score);
  return {
    pass: score >= 0.6,
    score,
    reason: reasons.length > 0 ? reasons.join("; ") : "工具使用合规",
  };
}

/**
 * 步数效率评分。
 *
 * v2（2026-05-25，审查 #7）：
 *   efficiency 与 rubric 反向相关——更勤奋的 agent 多调几次工具拿到更好答案，
 *   反而被 efficiency 扣分。
 *
 *   修复：rubricScore 高于 0.6 时（rubric 认为答得对），efficiency 不扣分（保持 1.0），
 *   只在 reason 里标记"步数偏多"作为诊断信号；rubricScore 低或缺失才按比例扣分。
 *   并且 DEFAULT_WEIGHTS 把 efficiency 权重从 1.0 降到 0.3，进一步弱化它的影响。
 *
 * @param meta agent 轨迹元数据
 * @param maxSteps case yaml 里写的预期步数上限
 * @param rubricScore 可选；rubric 维度的分数（已抓 snapToTier，0~1.0），用于"答对就不罚步数"
 */
export function gradeEfficiency(meta: AgentMeta, maxSteps: number, rubricScore: number | null = null): DimScore {
  const { total_steps } = meta;

  // 无轨迹数据：给 null 而非 1.0。挂掉的 case 在 efficiency 维度本应"无可评"，
  // 不是"高效"——这是当前评测体系无法测量的，不能记账成正面信号。
  if (total_steps === 0) {
    return { pass: false, score: null, reason: "无轨迹数据，跳过效率评估" };
  }

  const ratio = total_steps / maxSteps;
  const ratioStr = ratio.toFixed(1);

  // rubric 高（≥0.6）→ 答对了，efficiency 仅做诊断不扣分
  const rubricOk = rubricScore !== null && rubricScore >= 0.6;
  if (rubricOk && ratio > 1.0) {
    return {
      pass: true,
      score: 1.0,
      reason: `步数 ${total_steps}/${maxSteps} (${ratioStr}x) 偏多但 rubric 已合格，仅诊断不扣分`,
    };
  }

  let score: number;
  let reason: string;

  if (ratio <= 1.0) {
    score = 1.0;
    reason = `步数 ${total_steps}/${maxSteps} 在预期内`;
  } else if (ratio <= 1.5) {
    score = 0.7;
    reason = `步数偏多 ${total_steps}/${maxSteps} (${ratioStr}x)`;
  } else if (ratio <= 2.0) {
    score = 0.4;
    reason = `步数超标 ${total_steps}/${maxSteps} (${ratioStr}x)`;
  } else {
    score = 0.1;
    reason = `步数严重超标 ${total_steps}/${maxSteps} (${ratioStr}x)`;
  }

  return { pass: score >= 0.6, score, reason };
}

/**
 * Token 成本评分。
 *
 * ─── 公式与阈值版本 ───
 *
 * 当前公式 v5（2026-05-25 起，审查 #5 修复）:
 *   有 token_breakdown：billable = input + output + cache_creation + cache_read * CACHE_READ_DISCOUNT
 *   无 token_breakdown：billable = total_tokens（向后兼容老 wrapper）
 *   阈值: 50k / 150k / 500k 不变
 *
 * 公式 v4（2026-05-25，已废弃，未折算 cache）:
 *   total_tokens 口径: input（取 last, 含全历史）+ output + cache_creation + cache_read 累加
 *   阈值: 50k / 150k / 500k
 *   问题: claude-opus 默认开 cache，cache_read 是缓存复用、并非真实新 token，
 *         按 0.1x 折算后 sid-code (deepseek，无 cache) 与 claude-code (opus，重 cache) 才能对齐
 *
 * 公式 v3（2026-05-25，已废弃，过松）:
 *   阈值 200k / 500k / 1.5M → 90% case 都给 1.0，cost 维度无鉴别度
 *
 * 公式 v2（2026-05-24 ~ 2026-05-25，已废弃）:
 *   口径: 4 项全部累加（错误：input N² 过计数）
 *
 * 公式 v1（2026-05-24 之前，已废弃）:
 *   口径: input + output 累加（同样 N² 过计数，且不含 cache）
 *
 * ⚠️ 跨版本不可直接比较 cost 维度数值，详见 baseline_scores 的 _formula_version 字段。
 *
 * ─── cache_read 折算原理 ───
 *
 * Anthropic API 计费（claude-opus-4-7）：
 *   input:         15 USD / M token  (uncached)
 *   cache_read:    1.5 USD / M token  (10x 便宜)
 *   cache_creation: 18.75 USD / M token  (1.25x 贵于 input)
 *   output:        75 USD / M token
 *
 * 把 cache_read 按 0.1x 折算到等价 input token 数后，cost 维度才能横向对比：
 *   case_028 sid 94k vs claude 170k(其中 cr=233k → 折算 23k) → 94k vs ~50k 真实计费
 *
 * deepseek（无 cache）的 token_breakdown 里 cache_creation = cache_read = 0，
 * 折算后 billable = input + output 与裸 token 数一致，不影响其评分。
 */
export const COST_FORMULA_VERSION = "v5";
export const CACHE_READ_DISCOUNT = 0.1;

export function gradeCost(meta: AgentMeta): DimScore {
  const { total_tokens, token_breakdown } = meta;

  // 无 token 数据：给 null 而非 1.0。原因同 efficiency——
  // wrapper 没读到 trajectory 时 total_tokens=0，旧实现兜底 1.0
  // 会让挂掉的 case 白拿"低消耗"的满分。
  if (total_tokens === 0 && (!token_breakdown || token_breakdown.input + token_breakdown.output === 0)) {
    return { pass: false, score: null, reason: "无 token 数据，跳过成本评估" };
  }

  // billable token：有 breakdown 用 cache_read 折算口径，否则退化为 total_tokens
  let billable: number;
  let reasonExtra: string;
  if (token_breakdown) {
    billable = Math.round(
      token_breakdown.input
      + token_breakdown.output
      + token_breakdown.cache_creation
      + token_breakdown.cache_read * CACHE_READ_DISCOUNT
    );
    const crDiscounted = Math.round(token_breakdown.cache_read * CACHE_READ_DISCOUNT);
    reasonExtra = ` [billable=i${Math.round(token_breakdown.input/1000)}k+o${Math.round(token_breakdown.output/1000)}k+cc${Math.round(token_breakdown.cache_creation/1000)}k+cr${Math.round(token_breakdown.cache_read/1000)}k×${CACHE_READ_DISCOUNT}=${Math.round(crDiscounted/1000)}k]`;
  } else {
    billable = total_tokens;
    reasonExtra = " [no breakdown，按 total_tokens 计]";
  }

  let score: number;
  let level: string;

  // v5 阈值（沿用 v4，基于 P50/P75/P90 实测分布校准）：50k / 150k / 500k
  if (billable <= 50_000) {
    score = 1.0;
    level = "低消耗";
  } else if (billable <= 150_000) {
    score = 0.7;
    level = "中等";
  } else if (billable <= 500_000) {
    score = 0.4;
    level = "偏高";
  } else {
    score = 0.2;
    level = "严重超标";
  }

  const reason = `[cost-${COST_FORMULA_VERSION}] billable ${(billable / 1000).toFixed(0)}k ${level}${reasonExtra}`;
  return { pass: score >= 0.6, score, reason };
}

/**
 * 加权聚合：跳过 score === null 的维度，按剩余权重归一化。
 *
 * 例：anchor=0, rubric=null（限流）, tool=null（无 traj）, eff=null, cost=null
 *   → 只有 anchor 一维有效，归一化后总分 = 0 / 1.5 × 5 = 0.0
 *   旧实现：anchor=0 + rubric=0(judge 0) + tool=1 + eff=1 + cost=1 → ~2.5（白拿 3 维）
 *
 * 全部维度 null 的极端 case → 返回 score: null（无法评分），调用方决定写入策略。
 */
export function aggregate(
  dims: Record<string, DimScore>,
  weights?: Record<string, number>
): { score: number | null; namedScores: Record<string, number | null> } {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  let weightedSum = 0;
  let totalWeight = 0;
  const namedScores: Record<string, number | null> = {};

  for (const [name, dim] of Object.entries(dims)) {
    namedScores[name] = dim.score;
    if (dim.score === null) continue; // 跳过：不计入加权
    const weight = w[name] ?? 1.0;
    weightedSum += dim.score * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return { score: null, namedScores };
  const normalized = (weightedSum / totalWeight) * 5;
  return { score: Math.round(normalized * 100) / 100, namedScores };
}

/**
 * 全 null 维度集（error/timeout/abnormal case 用）。
 *
 * 入口短路：当 wrapper 返回 error=true 时，所有维度强制 null，aggregate 也返回 null，
 * 总分写 null 不参与平均、不污染 baseline。
 *
 * 修复审查 #1 + #14：
 *   旧实现：error case 仍走 gradeCase，partial trajectory 让 eff=1, cost=0.7，
 *   total_tokens 没写就 tool=1 兜底（mustCallTools 为空时），总分能算到 1.07~3.64。
 *   这些假分数 1) 在 _runs/*.jsonl 里写成数值 2) Dashboard 算均分时拉低/拉高真实表现
 *   → 横向对比、趋势图、weekly report 全部失真。
 *
 *   新实现：runner 在 gradeCase 入口检测 result.error / output.startsWith("[ERROR]")，
 *   直接返回这个全 null 维度集 + score=null，杜绝任何兜底评分。
 */
export function makeErrorDims(reason: string): Record<string, DimScore> {
  return {
    anchor_hit: { pass: false, score: null, reason },
    rubric_score: { pass: false, score: null, reason },
    tool_compliance: { pass: false, score: null, reason },
    efficiency: { pass: false, score: null, reason },
    cost: { pass: false, score: null, reason },
  };
}
