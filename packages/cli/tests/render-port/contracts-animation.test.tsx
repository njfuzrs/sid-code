/**
 * 契约 P5（B9 / T3.4）：`useAnimationFrame` 的离屏暂停，只经端口驱动。
 *
 * 期望值全部是 legacy 实测（扫过 105 组「动画盒高度 h × 上方行数 y × 帧高 p」，视口 H = 10）：
 * - 帧不超过视口（p ≤ H）时一律在走；
 * - 帧超过视口时，视口里能看到的是帧的最后 H - 1 行；动画盒底边 y + h - 1 ≥ p - H + 1 才在走，否则暂停；
 * - 判定只在这个组件重渲时做，读上一次提交的布局：暂停后时钟不再触发重渲，要等父级重渲、
 *   且上一帧里它已经回到视口内才恢复；`React.memo` 包住、父级重渲也传不进来的，一直停着。
 * TTY 才有「视口」：非 TTY 的 stdout 同样按 rows 判（legacy 一致），这里只测 TTY。
 */
import { describe, expect, test } from "bun:test";
import React, { useSyncExternalStore } from "react";
import { Box, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useAnimationFrame } from "@sid-code/cli/ui/render-port/hooks.ts";
import { mountTTY, tick, ttyStreams } from "./tty-streams.ts";

const H = 10;

function store<T>(v: T) {
  const subs = new Set<() => void>();
  return {
    set(n: T) {
      v = n;
      for (const s of subs) s();
    },
    use: () =>
      useSyncExternalStore(
        (cb) => (subs.add(cb), () => subs.delete(cb)),
        () => v,
      ),
  };
}

/** 动画盒上方 `before` 行、自身 `h` 行、下方 `after` 行；返回「300ms 里动画重渲了几次」的探针 */
function setup(opts: { before: number; h: number; after: number; memo?: boolean }) {
  let renders = 0;
  function Spin() {
    const [ref, t] = useAnimationFrame(40);
    renders++;
    return (
      <Box ref={ref as never} flexDirection="column">
        {Array.from({ length: opts.h }, (_, i) => (
          <Text key={i}>
            s{i} {Math.floor(t / 40)}
          </Text>
        ))}
      </Box>
    );
  }
  const Spinner = opts.memo ? React.memo(Spin) : Spin;
  const layout = store({ before: opts.before, after: opts.after });
  function App() {
    const { before, after } = layout.use();
    return (
      <Box flexDirection="column">
        {Array.from({ length: before }, (_, i) => (
          <Text key={`b${i}`}>b{i}</Text>
        ))}
        <Spinner />
        {Array.from({ length: after }, (_, i) => (
          <Text key={`a${i}`}>a{i}</Text>
        ))}
      </Box>
    );
  }
  const s = ttyStreams({ columns: 40, rows: H });
  const m = mountTTY(<App />, s);
  return {
    /** 先等 80ms 让上一次变更落地，再数 300ms 内的重渲次数；> 2 视为在走 */
    async running() {
      await tick(80);
      const r0 = renders;
      await tick(300);
      return renders - r0 > 2;
    },
    relayout: (before: number, after: number) => layout.set({ before, after }),
    teardown: m.teardown,
  };
}

describe("P5 离屏暂停动画", () => {
  // [上方行数, 盒高, 帧高, 是否在走]
  const cases: Array<[number, number, number, boolean]> = [
    [0, 1, 9, true], // 帧比视口矮
    [0, 1, 10, true], // 恰好占满视口
    [0, 1, 11, false], // 多 1 行：可见段从第 2 行起（p - H + 1），第 0 行已看不到
    [1, 1, 11, false],
    [2, 1, 11, true], // 盒在第 2 行 = p - H + 1，刚好可见
    [2, 1, 12, false],
    [0, 3, 11, true], // 盒底边（第 2 行）可见就算可见
    [0, 3, 12, false],
    [3, 2, 13, true], // 底边第 4 行 = 13 - 10 + 1
    [3, 2, 14, false],
  ];
  for (const [before, h, p, expected] of cases) {
    test(`P5: 上方 ${before} 行、盒高 ${h}、帧高 ${p}（视口 ${H}）→ ${expected ? "在走" : "暂停"}`, async () => {
      const t = setup({ before, h, after: p - before - h });
      try {
        expect(await t.running()).toBe(expected);
      } finally {
        t.teardown();
      }
    });
  }

  test("P5: 收缩回视口内后，第一次父级重渲仍按旧布局判离屏，第二次才恢复", async () => {
    const t = setup({ before: 0, h: 1, after: 13 });
    try {
      expect(await t.running()).toBe(false);
      t.relayout(0, 8); // 帧 9 行：重渲时读的是上一帧（14 行）的布局 → 仍暂停
      expect(await t.running()).toBe(false);
      t.relayout(0, 7); // 再一次父级重渲：上一帧（9 行）里可见 → 恢复
      expect(await t.running()).toBe(true);
    } finally {
      t.teardown();
    }
  });

  test("P5: React.memo 包住的动画暂停后，父级重渲传不进来，回到视口也不恢复", async () => {
    const t = setup({ before: 0, h: 1, after: 13, memo: true });
    try {
      expect(await t.running()).toBe(false);
      t.relayout(0, 8);
      expect(await t.running()).toBe(false);
      t.relayout(0, 7);
      expect(await t.running()).toBe(false);
    } finally {
      t.teardown();
    }
  });

  test("P5: 可见时滚出视口立即暂停（判定在下一次时钟重渲时做）", async () => {
    const t = setup({ before: 0, h: 1, after: 5 });
    try {
      expect(await t.running()).toBe(true);
      t.relayout(0, 13);
      expect(await t.running()).toBe(false);
    } finally {
      t.teardown();
    }
  });
});
