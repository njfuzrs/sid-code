/**
 * 行 → 字形簇缓存的容量回归（输入框打字 / 粘贴卡顿）。
 *
 * 主屏 History 每帧把全部历史重写进屏幕缓冲。旧实现是定长 1 万 + 满了整表 clear：
 * 历史一过 1 万行，每帧都在填满 → 清空之间循环，命中率归零，单帧 ~8ms → ~135ms。
 * 这里不测耗时（慢 runner 会抖），直接数 tokenize 次数。
 */
import { expect, test } from "bun:test";
import { beginRunCacheFrame, runCacheStats, Screen } from "../src/screen/screen.ts";

const LINES = Array.from({ length: 15_000 }, (_, i) => `历史行 ${i} \x1b[32mok\x1b[39m`);

function frame(lines: readonly string[]) {
  beginRunCacheFrame();
  const screen = new Screen(40, lines.length);
  lines.forEach((line, y) => screen.writeLine(0, y, line));
}

test("一帧写入超过 1 万行时，下一帧同样的行全部命中缓存", () => {
  frame(LINES);
  const before = runCacheStats().misses;
  frame(LINES);
  frame(LINES);
  expect(runCacheStats().misses - before).toBe(0);
});

test("连续两帧没再写的行被释放，缓存不随历史无限增长", () => {
  frame(LINES);
  const small = LINES.slice(0, 10);
  frame(small);
  frame(small);
  // 两代各持一份被提升的引用，上界是 2× 本帧行数；关键是那 1.5 万行已经放掉
  expect(runCacheStats().size).toBeLessThanOrEqual(2 * small.length);
});
