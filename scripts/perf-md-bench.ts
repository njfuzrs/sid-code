/**
 * 渲染路径微基准：模拟流式渲染循环，测量随响应增长的每帧解析成本。
 *
 * 验证假设：StreamingMarkdown 的 stablePrefix 每次块闭合时，
 * MarkdownAnsi 会用 cachedLexer(整个 prefix) 重新 lex + 对每个 token
 * formatTokenToAnsi + 每个代码块重新高亮 → 对 N 块响应是 O(N²)。
 */
import { cachedLexer, formatTokenToAnsi } from "../src/ui/markdown.ts";
import { computeStreamSplit } from "../src/ui/components/StreamingMarkdown.tsx";

const TERM_WIDTH = 100;

// 构造一个"典型技术回复"：多个章节 + 段落 + 代码块 + 列表。
function buildBlock(i: number): string {
  const kind = i % 4;
  if (kind === 0) return `\n## 章节 ${i}：核心概念\n`;
  if (kind === 1)
    return `\n这是第 ${i} 段说明文字，解释某个技术点的原理与权衡，包含 **加粗** 和 \`inline code\`，长度模拟真实段落输出，大约两三行。再补一句让它更长一些。\n`;
  if (kind === 2)
    return `\n\`\`\`typescript\nfunction demo${i}(x: number): number {\n  // 代码块会走语法高亮，成本较高\n  const y = x * ${i};\n  return y + Math.sqrt(y);\n}\n\`\`\`\n`;
  return `\n- 列表项 A of ${i}\n- 列表项 B of ${i}\n- 列表项 C of ${i}\n`;
}

// 模拟渲染一帧的 stablePrefix：lex 全文 + 每 token 转 ANSI（= MarkdownAnsi.blocks 的成本）。
function renderPrefixCost(prefix: string): number {
  const t0 = performance.now();
  const tokens = cachedLexer(prefix) as any[];
  for (const tok of tokens) {
    if (tok.type === "code") {
      // 代码块高亮成本用一次 formatTokenToAnsi 近似（真实走 colorizeCode 更贵）
      formatTokenToAnsi(tok, TERM_WIDTH);
    } else {
      formatTokenToAnsi(tok, TERM_WIDTH);
    }
  }
  return performance.now() - t0;
}

function runScenario(numBlocks: number): { totalMs: number; frames: number; maxFrameMs: number } {
  // 逐块增长，模拟"每次一个块闭合就重渲 stablePrefix"。
  const blocks: string[] = [];
  for (let i = 1; i <= numBlocks; i++) blocks.push(buildBlock(i));

  // 模拟流式：committed 边界随 computeStreamSplit 单调推进。
  let committed = 0;
  let accumulated = "";
  let totalMs = 0;
  let frames = 0;
  let maxFrameMs = 0;

  // 逐"块"喂入（真实是逐 token，但块闭合才触发 prefix 重渲，这里按块粒度足够）
  for (const b of blocks) {
    accumulated += b;
    const split = computeStreamSplit(accumulated, committed);
    committed = split.boundary;
    // 每次块闭合 → stablePrefix 变化 → MarkdownAnsi 重新 lex+render 整个 prefix
    if (split.stablePrefix) {
      const ms = renderPrefixCost(split.stablePrefix);
      totalMs += ms;
      frames++;
      if (ms > maxFrameMs) maxFrameMs = ms;
    }
  }
  return { totalMs, frames, maxFrameMs };
}

console.log("响应块数  重渲次数  累计解析ms  单帧峰值ms  平均每帧ms");
for (const n of [10, 20, 40, 80, 160]) {
  const r = runScenario(n);
  console.log(
    `${String(n).padEnd(9)} ${String(r.frames).padEnd(9)} ${r.totalMs.toFixed(1).padEnd(11)} ${r.maxFrameMs.toFixed(2).padEnd(11)} ${(r.totalMs / Math.max(1, r.frames)).toFixed(2)}`,
  );
}

// 对照：如果只 lex 最新块（理想增量），成本应是线性。
console.log("\n对照 - 理想增量（只 lex 每个新块）：");
console.log("响应块数  累计解析ms");
for (const n of [10, 20, 40, 80, 160]) {
  const blocks: string[] = [];
  for (let i = 1; i <= n; i++) blocks.push(buildBlock(i));
  let total = 0;
  for (const b of blocks) total += renderPrefixCost(b);
  console.log(`${String(n).padEnd(9)} ${total.toFixed(1)}`);
}
