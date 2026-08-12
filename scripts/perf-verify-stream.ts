// 验证修复：模拟真实流式，对比"每 token 全量重 lex"(旧) vs "增量渲染缓存"(新)
import { computeStreamSplit } from "@sid-code/cli/ui/components/StreamingMarkdown.tsx";
import { cachedLexer, formatTokenToAnsi } from "@sid-code/cli/ui/markdown.ts";
const TW = 100;
function longText(blocks: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= blocks; i++)
    parts.push(`## 小节 ${i}\n\n第 ${i} 段解释文字，含 **重点** 与 \`code\`。\n`);
  return parts.join("\n");
}
function render(seg: string) {
  const t = cachedLexer(seg) as any[];
  for (const tk of t) formatTokenToAnsi(tk, TW);
}

// 旧行为：每 token 对整个 stablePrefix 重跑 lex
function oldWay(full: string) {
  let committed = 0,
    prefix = "",
    total = 0;
  for (let pos = 0; pos < full.length; pos += 4) {
    const acc = full.slice(0, pos + 4);
    const t0 = performance.now();
    if (!acc.startsWith(prefix)) {
      committed = 0;
      prefix = "";
    }
    const s = computeStreamSplit(acc, committed);
    committed = s.boundary;
    prefix = s.stablePrefix;
    if (s.stablePrefix) render(s.stablePrefix); // ← 全量重 lex 整个前缀
    if (s.unstableSuffix) render(s.unstableSuffix);
    total += performance.now() - t0;
  }
  return total;
}
// 新行为：stablePrefix 增量渲染（只 lex 新冻结的增量），缓存命中 O(1)
function newWay(full: string) {
  let committed = 0,
    prefix = "",
    total = 0;
  for (let pos = 0; pos < full.length; pos += 4) {
    const acc = full.slice(0, pos + 4);
    const t0 = performance.now();
    if (!acc.startsWith(prefix)) {
      committed = 0;
      prefix = "";
    }
    const prev = committed;
    const s = computeStreamSplit(acc, committed);
    committed = s.boundary;
    prefix = s.stablePrefix;
    // 只渲染新冻结的增量部分（缓存已渲染节点，此处只算增量成本）
    if (s.boundary > prev && s.stablePrefix) {
      const inc = s.stablePrefix.slice(prev);
      if (inc) render(inc);
    }
    if (s.unstableSuffix) render(s.unstableSuffix);
    total += performance.now() - t0;
  }
  return total;
}
console.log("块数  字符  旧(全量重lex)ms  新(增量)ms  加速比");
for (const b of [30, 60, 120]) {
  const txt = longText(b);
  const o = oldWay(txt),
    n = newWay(txt);
  console.log(
    `${String(b).padEnd(5)} ${String(txt.length).padEnd(6)} ${o.toFixed(0).padEnd(15)} ${n.toFixed(0).padEnd(11)} ${(o / n).toFixed(1)}×`,
  );
}
