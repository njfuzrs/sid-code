/**
 * T8.1c 夹具（契约 P4）：假 TTY 里只经端口渲染一段「长会话」，打印 `RSS {...}`（MB）。
 *
 * 场景：`RSS_ITEMS` 条历史（默认 500）分批进 Static，底部一个动态区每批改一次；
 * 历史项是带样式的多行文本（模拟 markdown 输出），每条约 6 行。
 * 采样点：挂载后（base）、灌完历史并 GC 后（peak），差值 `delta` 才是底座为长会话多占的内存。
 */
import React from "react";
import { Box, Static, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { mountTTY, tick, ttyStreams } from "../tty-streams.ts";

const ITEMS = Number(process.env.RSS_ITEMS ?? 500);
const BATCH = 25;
const mb = () => Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;
const gc = () => {
  Bun.gc(true);
  Bun.gc(true);
};

type Item = { id: number; lines: string[] };
const makeItem = (id: number): Item => ({
  id,
  lines: Array.from(
    { length: 6 },
    (_, j) => `item ${id} line ${j} ${"lorem ipsum dolor ".repeat(3)}中文`,
  ),
});

function App({ items, tail }: { items: Item[]; tail: number }) {
  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(it) => (
          <Box key={it.id} flexDirection="column">
            {it.lines.map((l, j) => (
              <Text key={j} color={j === 0 ? "green" : undefined} bold={j === 0}>
                {l}
              </Text>
            ))}
          </Box>
        )}
      </Static>
      <Text>streaming {tail}</Text>
    </Box>
  );
}

const s = ttyStreams({ columns: 100, rows: 30 });
const m = mountTTY(<App items={[]} tail={0} />, s);
await tick();
gc();
const base = mb();
const items: Item[] = [];
for (let i = 0; i < ITEMS; i += BATCH) {
  for (let k = i; k < Math.min(ITEMS, i + BATCH); k++) items.push(makeItem(k));
  m.inst.rerender(<App items={[...items]} tail={i} />);
  await tick(5);
  s.clear(); // 假 stdout 的累积缓冲不算底座的账
}
await tick(50);
gc();
const peak = mb();
const { heapUsed } = process.memoryUsage();
const jsc = (await import("bun:jsc")).heapStats();
console.log(
  `RSS ${JSON.stringify({ base, peak, delta: Math.round((peak - base) * 10) / 10, heapMB: Math.round(heapUsed / 104857.6) / 10, objects: jsc.objectCount })}`,
);
m.teardown();
process.exit(0);
