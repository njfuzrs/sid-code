// 模拟真实流式：逐 token 增长 streamingText，每次都跑 StreamingMarkdown 的切分 + MarkdownAnsi 全量解析。
import { computeStreamSplit } from "@sid-code/cli/ui/components/StreamingMarkdown.tsx";
import { cachedLexer, formatTokenToAnsi } from "@sid-code/cli/ui/markdown.ts";
const TW = 100;

// 生成一段长回复文本
function longText(blocks: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= blocks; i++) {
    parts.push(
      `## 小节 ${i}\n\n这是第 ${i} 段解释文字，包含 **重点** 与 \`code\`，模拟真实段落。\n`,
    );
  }
  return parts.join("\n");
}

// 模拟逐 token 到达：每次追加一个 token，跑一次完整渲染管线
function simulate(fullText: string, tokenSize: number) {
  let committed = 0,
    prefixStr = "";
  let acc = "";
  let totalMs = 0,
    frames = 0,
    maxMs = 0;
  for (let pos = 0; pos < fullText.length; pos += tokenSize) {
    acc = fullText.slice(0, pos + tokenSize);
    const t0 = performance.now();
    // StreamingMarkdown 逻辑：非前缀则重置
    if (!acc.startsWith(prefixStr)) {
      committed = 0;
      prefixStr = "";
    }
    const split = computeStreamSplit(acc, committed);
    committed = split.boundary;
    prefixStr = split.stablePrefix;
    // MarkdownAnsi 对 stablePrefix + unstableSuffix 各跑一次全量 lex+format
    for (const seg of [split.stablePrefix, split.unstableSuffix]) {
      if (!seg) continue;
      const toks = cachedLexer(seg) as any[];
      for (const tk of toks) formatTokenToAnsi(tk, TW);
    }
    const ms = performance.now() - t0;
    totalMs += ms;
    frames++;
    if (ms > maxMs) maxMs = ms;
  }
  return { totalMs, frames, maxMs };
}

console.log("正文块数  字符数   token数  累计渲染ms  单token峰值ms  平均ms/token");
for (const b of [10, 30, 60, 120]) {
  const txt = longText(b);
  const r = simulate(txt, 4); // 每 4 字符一个 token（近似中文流式粒度）
  console.log(
    `${String(b).padEnd(9)} ${String(txt.length).padEnd(8)} ${String(r.frames).padEnd(8)} ${r.totalMs.toFixed(0).padEnd(11)} ${r.maxMs.toFixed(2).padEnd(14)} ${(r.totalMs / r.frames).toFixed(3)}`,
  );
}
