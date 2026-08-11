import { cachedLexer, formatTokenToAnsi } from "@sid-code/cli/ui/markdown.ts";
const TW = 100;
function longText(blocks: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= blocks; i++) parts.push(`## 小节 ${i}\n\n第 ${i} 段解释文字，含 **重点** 与 \`code\`。\n`);
  return parts.join("\n");
}
// 模拟流式：每 4 字符重跑一次「全量 lex」和「全量 format」，分别计时
function simulate(fullText: string) {
  let lexMs = 0, fmtMs = 0, frames = 0;
  for (let pos = 0; pos < fullText.length; pos += 4) {
    const seg = fullText.slice(0, pos + 4);
    const t0 = performance.now();
    const toks = cachedLexer(seg) as any[];
    const t1 = performance.now();
    for (const tk of toks) formatTokenToAnsi(tk, TW);
    const t2 = performance.now();
    lexMs += t1 - t0; fmtMs += t2 - t1; frames++;
  }
  return { lexMs, fmtMs, frames };
}
console.log("块数  字符  lex累计ms  format累计ms  lex占比");
for (const b of [30, 60, 120]) {
  const txt = longText(b);
  const r = simulate(txt);
  console.log(`${String(b).padEnd(5)} ${String(txt.length).padEnd(6)} ${r.lexMs.toFixed(0).padEnd(10)} ${r.fmtMs.toFixed(0).padEnd(13)} ${(100*r.lexMs/(r.lexMs+r.fmtMs)).toFixed(0)}%`);
}
