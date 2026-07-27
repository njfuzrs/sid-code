/**
 * CJK bigram 分词器 —— 站内本地搜索（minisearch）的索引期与查询期共用。
 *
 * ┌─ 为什么不用 minisearch 默认分词 ────────────────────────────────────┐
 * │ 默认按空白/标点切词。中文句子内部无空格，"支持多 provider 可插拔与  │
 * │ 权限门控" 会被切成极少数超长 token，搜「权限」「插拔」命中数为 0。  │
 * │ 这是 VitePress 的已知问题（vuejs/vitepress#4049）。                 │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 为什么不用 Intl.Segmenter ────────────────────────────────────────┐
 * │ ① 切分质量不稳：Bun 下「编程」「插拔」「门控」都被拆成单字。        │
 * │ ② 致命：索引在 Bun（构建期）建，查询在浏览器（运行期）做，两者     │
 * │    ICU 版本不同 → 同一句话可能切出不同 token → 索引与查询错位，    │
 * │    表现为「某些词偶尔搜不到」，极难排查。                          │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 采用 1-gram + 2-gram：不依赖 ICU、不依赖词典，构建期与运行期逐字符确定一致。
 *
 * ══════════ 两条硬性编码约束（改动前务必读完）══════════
 *
 * 【约束一】函数体必须自包含，不得引用任何模块外标识符。
 *   VitePress 构建期用 serializeFunctions() 把函数体转成字符串，注入
 *   window.__VP_SITE_DATA__，运行期用 new Function() 还原。还原时模块级的
 *   import / 常量 / 正则在浏览器里根本不存在，会静默抛错 → 搜索整个失效
 *   （不报错，只是搜不到）。所以正则、常量一律定义在函数体内部。
 *   → 这条单测发现不了（单测里 import 是正常的），只能靠真实浏览器验证。
 *
 * 【约束二】config.ts 里必须 options.tokenize 与 searchOptions.tokenize 两处都传。
 *   minisearch 的索引期分词与查询期分词是两个独立参数。只传前者 → 索引用
 *   bigram、查询用默认分词 → 全站搜不到。
 */

/**
 * 把一段文本切成 token 数组。
 *
 * - 非 CJK 段：按 `[^\p{L}\p{N}_]+` 切分并小写化（英文/代码词行为与默认一致）。
 * - CJK 连续段：产出全部单字（1-gram）+ 全部相邻二字组合（2-gram）。
 *
 * @example
 * tokenizeCJK("支持多 provider 可插拔")
 * // ["支","持","多","支持","持多","provider","可","插","拔","可插","插拔"]
 */
export function tokenizeCJK(text: string): string[] {
  /* 约束一：以下正则/常量必须留在函数体内，不得提到模块级 */
  const CJK =
    /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/u;
  const NON_WORD = /[^\p{L}\p{N}_]+/u;

  if (!text) return [];

  const out: string[] = [];
  let buf = "";

  /* 冲刷非 CJK 缓冲：按非词字符切分 + 小写化 */
  const flushLatin = () => {
    if (!buf) return;
    for (const piece of buf.split(NON_WORD)) {
      if (piece) out.push(piece.toLowerCase());
    }
    buf = "";
  };

  /* 冲刷 CJK 缓冲：1-gram 全出，2-gram 全出 */
  const flushCJK = (seg: string) => {
    const n = seg.length;
    for (let i = 0; i < n; i++) out.push(seg[i]!);
    for (let i = 0; i + 1 < n; i++) out.push(seg.slice(i, i + 2));
  };

  let cjkBuf = "";
  for (const ch of text) {
    if (CJK.test(ch)) {
      flushLatin();
      cjkBuf += ch;
    } else {
      if (cjkBuf) {
        flushCJK(cjkBuf);
        cjkBuf = "";
      }
      buf += ch;
    }
  }
  if (cjkBuf) flushCJK(cjkBuf);
  flushLatin();

  return out;
}
