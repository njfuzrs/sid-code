/**
 * 契约 L1 / L3 / L4 / T1 / T2 / T5 / O4（B9 / T0.5，L3 与 L4 的细则 T4.3 补）：布局、裁剪与滚动、测量、文本宽度与截断、ANSI 组件、超链接判定。
 *
 * 期望值全部是 2026-10-03 在 legacy 上实测的输出。走 testing shim（非 TTY 整帧），
 * 比的是可视文本，不比字节 —— 新底座换了光标策略也不该让这里红。
 */
import { describe, expect, test } from "bun:test";
import React, { useEffect, useRef, useState } from "react";
import stripAnsi from "strip-ansi";
import { Ansi, Box, RawAnsi, Text } from "@sid-code/cli/ui/render-port/components.ts";
import {
  getBoundingBox,
  measureElement,
  ResizeObserver,
} from "@sid-code/cli/ui/render-port/measure.ts";
import { supportsHyperlinks } from "@sid-code/cli/ui/render-port/termio.ts";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { stringWidth } from "@sid-code/cli/ui/render-port/text.ts";
import { tick } from "./tty-streams.ts";

async function lines(el: React.ReactElement, columns = 20): Promise<string[]> {
  const r = render(el, { columns, rows: 10 });
  await tick(10);
  const out = stripAnsi(r.lastFrame() ?? "").split("\n");
  r.unmount();
  return out;
}

// SURFACE.md §2 里 CLI 实际用到的 Box props，每个至少出现在一行用例里
const LAYOUT_CASES: [string, React.ReactElement, string[]][] = [
  [
    "flexDirection row",
    <Box flexDirection="row">
      <Text>a</Text>
      <Text>b</Text>
    </Box>,
    ["ab"],
  ],
  [
    "column + gap",
    <Box flexDirection="column" gap={1}>
      <Text>a</Text>
      <Text>b</Text>
    </Box>,
    ["a", "", "b"],
  ],
  [
    "row + gap",
    <Box gap={1}>
      <Text>a</Text>
      <Text>b</Text>
    </Box>,
    ["a b"],
  ],
  [
    "paddingX / paddingY",
    <Box paddingX={2} paddingY={1}>
      <Text>x</Text>
    </Box>,
    ["", "  x", ""],
  ],
  [
    "padding",
    <Box padding={1}>
      <Text>x</Text>
    </Box>,
    ["", " x", ""],
  ],
  [
    "paddingLeft/Right/Top/Bottom",
    <Box paddingLeft={1} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <Text>x</Text>
    </Box>,
    ["", " x", ""],
  ],
  [
    "margin 各方向",
    <Box flexDirection="column">
      <Text>a</Text>
      <Box marginTop={1} marginLeft={2}>
        <Text>b</Text>
      </Box>
      <Box marginBottom={1} marginY={1} marginRight={1}>
        <Text>c</Text>
      </Box>
      <Text>d</Text>
    </Box>,
    ["a", "", "  b", "", "c", "", "d"],
  ],
  [
    "borderStyle round + width",
    <Box borderStyle="round" width={6}>
      <Text>ab</Text>
    </Box>,
    ["╭────╮", "│ab  │", "╰────╯"],
  ],
  [
    "borderLeft/Right=false",
    <Box borderStyle="single" borderLeft={false} borderRight={false}>
      <Text>ab</Text>
    </Box>,
    ["─".repeat(20), "ab", "─".repeat(20)],
  ],
  [
    "只留 borderTop",
    <Box
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      width={4}
    >
      <Text>ab</Text>
    </Box>,
    ["────", "ab"],
  ],
  [
    "justifyContent flex-end",
    <Box width={6} justifyContent="flex-end">
      <Text>ab</Text>
    </Box>,
    ["    ab"],
  ],
  [
    "justifyContent center",
    <Box width={6} justifyContent="center">
      <Text>ab</Text>
    </Box>,
    ["  ab"],
  ],
  [
    "justifyContent space-between",
    <Box width={6} justifyContent="space-between">
      <Text>a</Text>
      <Text>b</Text>
    </Box>,
    ["a    b"],
  ],
  [
    "justifyContent flex-start",
    <Box width={6} justifyContent="flex-start">
      <Text>a</Text>
    </Box>,
    ["a"],
  ],
  [
    "alignItems center",
    <Box height={3} alignItems="center">
      <Text>a</Text>
    </Box>,
    ["", "a", ""],
  ],
  [
    "alignItems stretch",
    <Box flexDirection="column" alignItems="stretch" width={4}>
      <Box borderStyle="single">
        <Text>a</Text>
      </Box>
    </Box>,
    ["┌──┐", "│a │", "└──┘"],
  ],
  [
    "alignItems flex-start",
    <Box flexDirection="column" width={6} alignItems="flex-start">
      <Box borderStyle="single">
        <Text>a</Text>
      </Box>
    </Box>,
    ["┌─┐", "│a│", "└─┘"],
  ],
  [
    "alignSelf 覆盖 alignItems",
    <Box flexDirection="column" width={6} alignItems="center">
      <Box alignSelf="flex-start">
        <Text>a</Text>
      </Box>
    </Box>,
    ["a"],
  ],
  [
    "flexGrow",
    <Box width={8}>
      <Box flexGrow={1}>
        <Text>a</Text>
      </Box>
      <Text>|</Text>
    </Box>,
    ["a      |"],
  ],
  [
    "flexShrink 0 / 1（被压窄的一侧逐字换行）",
    <Box width={6}>
      <Box flexShrink={0} width={5}>
        <Text>aaaaa</Text>
      </Box>
      <Box flexShrink={1}>
        <Text>bbbb</Text>
      </Box>
    </Box>,
    ["aaaaab", "     b", "     b", "     b"],
  ],
  [
    "width 百分比",
    <Box width={10}>
      <Box width="50%">
        <Text>a</Text>
      </Box>
      <Text>|</Text>
    </Box>,
    ["a    |"],
  ],
  [
    "height 固定",
    <Box flexDirection="column">
      <Box height={2}>
        <Text>a</Text>
      </Box>
      <Text>b</Text>
    </Box>,
    ["a", "", "b"],
  ],
  [
    "minHeight",
    <Box flexDirection="column">
      <Box minHeight={2}>
        <Text>a</Text>
      </Box>
      <Text>b</Text>
    </Box>,
    ["a", "", "b"],
  ],
  [
    "minWidth",
    <Box>
      <Box minWidth={4}>
        <Text>a</Text>
      </Box>
      <Text>|</Text>
    </Box>,
    ["a   |"],
  ],
  [
    "overflow hidden（宽度裁剪：子项不收缩时文本仍按容器宽换行）",
    <Box width={3} overflow="hidden">
      <Box flexShrink={0}>
        <Text>abcdef</Text>
      </Box>
    </Box>,
    ["abc", "def"],
  ],
  [
    "overflowX hidden",
    <Box width={3} overflowX="hidden">
      <Box flexShrink={0}>
        <Text>abcdef</Text>
      </Box>
    </Box>,
    ["abc", "def"],
  ],
  [
    "flexWrap wrap",
    <Box width={4} flexWrap="wrap">
      <Text>ab</Text>
      <Text>cd</Text>
      <Text>ef</Text>
    </Box>,
    ["abcd", "ef"],
  ],
  [
    "flexWrap nowrap（溢出不换行）",
    <Box width={4} flexWrap="nowrap">
      <Box flexShrink={0}>
        <Text>ab</Text>
      </Box>
      <Box flexShrink={0}>
        <Text>cd</Text>
      </Box>
      <Box flexShrink={0}>
        <Text>ef</Text>
      </Box>
    </Box>,
    ["abcdef"],
  ],
];

describe("L1 Flexbox 语义", () => {
  for (const [name, el, want] of LAYOUT_CASES) {
    test(`L1: ${name}`, async () => {
      expect(await lines(el)).toEqual(want);
    });
  }
});

describe("L4 ResizeObserver / measureElement", () => {
  test("L4: measureElement 返回最近一次布局的宽高；observe 首次上报一次，之后只在尺寸变化时回调", async () => {
    const log: string[] = [];
    let setN: (n: number) => void = () => {};
    function C() {
      const ref = useRef<Parameters<typeof measureElement>[0]>(null);
      const [n, set] = useState(1);
      setN = set;
      useEffect(() => {
        const m = measureElement(ref.current!);
        log.push(`m:${m.width}x${m.height}`);
        const ro = new ResizeObserver((entries) => {
          for (const e of entries) log.push(`ro:${e.contentRect.width}x${e.contentRect.height}`);
        });
        ro.observe(ref.current!);
        return () => ro.disconnect();
      }, []);
      return (
        <Box ref={ref} flexDirection="column" width={5}>
          {Array.from({ length: n }, (_, i) => (
            <Text key={i}>{i}</Text>
          ))}
        </Box>
      );
    }
    const r = render(<C />);
    await tick(60);
    setN(3);
    await tick(80);
    log.push("--");
    await tick(60); // 尺寸不变的轮询不回调
    r.unmount();
    expect(log).toEqual(["m:5x1", "ro:5x1", "ro:5x3", "--"]);
  });
});

// —— L3：overflowY="scroll"（T4.3，期望值 2026-10-06 在 legacy 上实测）——
// 只画第一个子节点（内容盒）的子项；内容盒不是 Box 就什么都不画；内容盒自己的背景 / 边框 / 裁剪不画；
// 子项按「在内容盒里的位置」与视口 [0, 内框高) 求交，有交集就整项画，不看内容盒的偏移（滚动位置恒按 0 剔除）
const rowsOf = (n: number, p = "r") =>
  Array.from({ length: n }, (_, i) => (
    <Text key={i}>
      {p}
      {i}
    </Text>
  ));
const content = (props: Record<string, unknown>, ...kids: React.ReactNode[]) => (
  <Box key="c" flexShrink={0} flexDirection="column" {...props}>
    {kids}
  </Box>
);
const scroll = (props: Record<string, unknown>, ...kids: React.ReactNode[]) => (
  <Box flexDirection="column">
    <Text>H</Text>
    <Box overflowY="scroll" flexDirection="column" height={3} {...props}>
      {kids}
    </Box>
    <Text>F</Text>
  </Box>
);
const SCROLL_CASES: [string, React.ReactElement, string[]][] = [
  ["内容盒内的项按视口裁剪", scroll({}, content({}, rowsOf(6))), ["H", "r0", "r1", "r2", "F"]],
  [
    "只画第一个子节点",
    scroll({}, content({}, rowsOf(2, "a")), content({}, rowsOf(2, "b"))),
    ["H", "a0", "a1", "", "F"],
  ],
  ["第一个子节点是 Text：什么都不画", scroll({}, <Text key="t">TT</Text>), ["H", "", "", "", "F"]],
  [
    "负 marginTop：滚上去的行被裁掉，底部留空",
    scroll({}, content({ marginTop: -1 }, rowsOf(5))),
    ["H", "r1", "r2", "", "F"],
  ],
  [
    "负 marginTop 超过视口：全部剔除",
    scroll({}, content({ marginTop: -3 }, rowsOf(6))),
    ["H", "", "", "", "F"],
  ],
  ["正 marginTop", scroll({}, content({ marginTop: 1 }, rowsOf(4))), ["H", "", "r0", "r1", "F"]],
  [
    "VirtualizedList 形状：上 spacer + 项 + 下 spacer",
    scroll(
      { height: 5 },
      content(
        {},
        <Box key="s" height={2} flexShrink={0} />,
        rowsOf(3),
        <Box key="e" height={4} flexShrink={0} />,
      ),
    ),
    ["H", "", "", "r0", "r1", "r2", "F"],
  ],
  [
    "跨越视口底边的项整项画、再被裁剪",
    scroll(
      {},
      content({}, <Box key="s" height={2} flexShrink={0} />, content({ key: "g" }, rowsOf(3, "g"))),
    ),
    ["H", "", "", "g0", "F"],
  ],
  [
    "项不递归剔除（孙辈超出视口照画，交给裁剪）",
    scroll({ height: 4, paddingBottom: 1 }, content({}, content({ key: "g" }, rowsOf(4, "g")))),
    ["H", "g0", "g1", "g2", "g3", "F"],
  ],
  [
    "视口扣掉 padding",
    scroll({ height: 4, paddingBottom: 1 }, content({}, rowsOf(6))),
    ["H", "r0", "r1", "r2", "", "F"],
  ],
  [
    "内容盒的边框不画、只占位",
    scroll({ height: 4 }, content({ borderStyle: "single", width: 5 }, rowsOf(4))),
    ["H", "", " r0", " r1", " r2", "F"],
  ],
  [
    "内容盒的 overflowX hidden 不生效",
    scroll(
      { width: 8 },
      content(
        { width: 3, overflowX: "hidden" },
        <Box key="w" flexShrink={0} width={6}>
          <Text>abcdef</Text>
        </Box>,
      ),
    ),
    ["H", "abcdef", "", "", "F"],
  ],
  [
    "滚动盒的 overflowX hidden 照常裁剪",
    scroll(
      { width: 3, overflowX: "hidden" },
      content(
        {},
        <Box key="w" flexShrink={0} width={6}>
          <Text>abcdef</Text>
        </Box>,
      ),
    ),
    ["H", "abc", "", "", "F"],
  ],
  [
    "滚动盒自己的边框照画",
    scroll({ height: 5, borderStyle: "single", width: 6 }, content({ marginTop: -1 }, rowsOf(6))),
    ["H", "┌────┐", "│r1  │", "│r2  │", "│    │", "└────┘", "F"],
  ],
];

describe("L3 overflow 裁剪与 overflowY scroll", () => {
  for (const [name, el, want] of SCROLL_CASES) {
    test(`L3: ${name}`, async () => {
      expect(await lines(el)).toEqual(want);
    });
  }

  test("L3: 单轴取值优先于 overflow；scroll 在本轴上等于 hidden", async () => {
    const wide = (props: Record<string, unknown>) => (
      <Box flexDirection="column">
        <Box width={3} height={2} flexDirection="column" {...props}>
          <Box flexShrink={0} width={6} flexDirection="column">
            <Text>abcdef</Text>
            <Text>ghijkl</Text>
            <Text>mnopqr</Text>
          </Box>
        </Box>
        <Text>F</Text>
      </Box>
    );
    expect(await lines(wide({ overflow: "scroll" }))).toEqual(["abc", "ghi", "F"]);
    expect(await lines(wide({ overflowY: "scroll" }))).toEqual(["abcdef", "ghijkl", "F"]);
    expect(await lines(wide({ overflowX: "scroll" }))).toEqual(["abc", "ghi", "Fno"]);
    expect(await lines(wide({ overflow: "hidden", overflowY: "visible" }))).toEqual([
      "abc",
      "ghi",
      "Fno",
    ]);
  });
});

describe("L4 getBoundingBox / ResizeObserver 细则", () => {
  test("L4: getBoundingBox 是布局树绝对坐标（累加父链 left/top，含负 margin 与 absolute），空参数与已移除节点得 null", async () => {
    const refs: Record<string, Parameters<typeof getBoundingBox>[0]> = {};
    const at = (k: string) => (x: Parameters<typeof getBoundingBox>[0]) => {
      if (x) refs[k] = x;
    };
    let hide: (v: boolean) => void = () => {};
    function C() {
      const [shown, set] = useState(true);
      hide = (v) => set(!v);
      return (
        <Box flexDirection="column" paddingLeft={1}>
          <Text>head</Text>
          <Box
            ref={at("scroll")}
            overflowY="scroll"
            height={3}
            flexDirection="column"
            borderStyle="single"
            width={10}
          >
            <Box ref={at("content")} flexShrink={0} flexDirection="column" marginTop={-2}>
              <Box ref={at("row1")}>
                <Text>r</Text>
              </Box>
            </Box>
          </Box>
          <Box ref={at("abs")} position="absolute" marginLeft={7} marginTop={1}>
            <Text>A</Text>
          </Box>
          {shown && (
            <Box ref={at("pct")} width="50%">
              <Text>P</Text>
            </Box>
          )}
        </Box>
      );
    }
    const r = render(<C />, { columns: 20, rows: 10 });
    await tick(20);
    const got = Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, getBoundingBox(v)]));
    expect(got).toEqual({
      scroll: { x: 1, y: 1, width: 10, height: 3 },
      content: { x: 2, y: 0, width: 8, height: 1 },
      row1: { x: 2, y: 0, width: 8, height: 1 },
      abs: { x: 8, y: 1, width: 1, height: 1 },
      pct: { x: 1, y: 4, width: 10, height: 1 },
    });
    expect(getBoundingBox(null as never)).toBeNull();
    const pct = refs.pct!;
    hide(true);
    await tick(20);
    expect(getBoundingBox(pct)).toBeNull();
    expect(measureElement(pct)).toEqual({ width: 0, height: 0 });
    r.unmount();
  });

  test("L4: ResizeObserver 时序：observe 后微任务里报一次；之后只比宽高；同一轮变化合成一次回调；移除报 0×0", async () => {
    const log: string[] = [];
    let setN: (n: number) => void = () => {};
    let setMove: (n: number) => void = () => {};
    let setShowB: (v: boolean) => void = () => {};
    const refs: Record<string, Parameters<typeof measureElement>[0]> = {};
    function C() {
      const [n, sn] = useState(1);
      const [move, sm] = useState(0);
      const [showB, sb] = useState(true);
      setN = sn;
      setMove = sm;
      setShowB = sb;
      return (
        <Box flexDirection="column">
          <Box height={move} />
          <Box ref={(x) => void (x && (refs.a = x))} flexDirection="column" marginLeft={move}>
            {Array.from({ length: n }, (_, i) => (
              <Text key={i}>{i}</Text>
            ))}
          </Box>
          {showB && (
            <Box ref={(x) => void (x && (refs.b = x))} flexDirection="column" width={4}>
              {Array.from({ length: n }, (_, i) => (
                <Text key={i}>{i}</Text>
              ))}
            </Box>
          )}
        </Box>
      );
    }
    const r = render(<C />, { columns: 10, rows: 10 });
    await tick(20);
    const name = (t: unknown) => (t === refs.a ? "a" : t === refs.b ? "b" : "?");
    const ro = new ResizeObserver((es) => {
      log.push(
        es.map((e) => `${name(e.target)}:${e.contentRect.width}x${e.contentRect.height}`).join(","),
      );
    });
    ro.observe(refs.a!);
    ro.observe(refs.b!);
    ro.observe(refs.a!); // 重复 observe 不再报
    queueMicrotask(() => log.push("micro"));
    await tick(40);
    log.push("--n=2");
    setN(2);
    await tick(60);
    log.push("--move");
    setMove(2); // a 宽 10 → 8，高不变；只挪位置的部分不回调
    await tick(60);
    log.push("--hide b");
    const b = refs.b!;
    setShowB(false);
    await tick(60);
    expect(name(b)).toBe("b");
    ro.disconnect();
    log.push("--disconnect");
    setN(3);
    await tick(60);
    r.unmount();
    expect(log).toEqual([
      "a:10x1",
      "b:4x1",
      "micro",
      "--n=2",
      "a:10x2,b:4x2",
      "--move",
      "a:8x2",
      "--hide b",
      "b:0x0",
      "--disconnect",
    ]);
  });

  test("L4: 同一 tick 里 observe 又 unobserve：不报；参数为空时 observe 抛 TypeError", async () => {
    const log: string[] = [];
    let node: Parameters<typeof measureElement>[0] | undefined;
    const r = render(
      <Box ref={(x) => void (x && (node = x))}>
        <Text>a</Text>
      </Box>,
      { columns: 10, rows: 5 },
    );
    await tick(20);
    const ro = new ResizeObserver(() => log.push("cb"));
    ro.observe(node!);
    ro.unobserve(node!);
    await tick(40);
    expect(log).toEqual([]);
    expect(() => ro.observe(null as never)).toThrow(TypeError);
    ro.disconnect();
    r.unmount();
  });
});

describe("T1 stringWidth", () => {
  const cases: [string, string, number][] = [
    ["ASCII", "a", 1],
    ["CJK 宽 2", "中", 2],
    ["emoji 宽 2", "😀", 2],
    ["ZWJ 序列按一个宽字符", "👨‍👩‍👧", 2],
    ["组合字符宽 0（é = e + U+0301）", "é", 1],
    ["变体选择符 VS16 让 ❤ 变宽", "❤️", 2],
    ["先去 ANSI", "\x1b[31mab\x1b[0m", 2],
    ["混排", "中文ab", 6],
  ];
  for (const [name, s, w] of cases) {
    test(`T1: ${name}`, () => {
      expect(stringWidth(s)).toBe(w);
    });
  }
});

describe("T2 wrap / truncate", () => {
  const txt = "你好世界abcdef一二三四五";
  const cases: [string, string[]][] = [
    ["wrap", ["你好世界a", "bcdef一二", "三四五"]],
    ["truncate", ["你好世界…"]],
    ["truncate-end", ["你好世界…"]],
    ["truncate-middle", ["你好…四五"]],
  ];
  for (const [wrap, want] of cases) {
    test(`T2: ${wrap} 在宽 9 的盒子里（CJK 不劈半）`, async () => {
      const got = await lines(
        <Box width={9}>
          <Text wrap={wrap as "wrap"}>{txt}</Text>
        </Box>,
      );
      expect(got).toEqual(want);
      for (const l of got) expect(stringWidth(l)).toBeLessThanOrEqual(9);
    });
  }
});

describe("T5 Ansi / RawAnsi", () => {
  test("T5: Ansi 解析 ANSI 为带样式文本，RawAnsi 的终端就绪行原样进帧", async () => {
    const r = render(
      <Box flexDirection="column">
        <Ansi>{"\x1b[31mred\x1b[0m plain"}</Ansi>
        <RawAnsi lines={["\x1b[32mgreen\x1b[0m", "x"]} width={5} />
      </Box>,
    );
    await tick();
    const frame = r.lastFrame() ?? "";
    r.unmount();
    expect(stripAnsi(frame).split("\n")).toEqual(["red plain", "green", "x"]);
    // RawAnsi 的样式保留（经屏幕缓冲重新编码，关闭码从 0m 变成 39m）
    expect(frame).toContain("\x1b[32mgreen");
  });

  test("T5: RawAnsi 空 lines 不占行", async () => {
    expect(
      await lines(
        <Box flexDirection="column">
          <Text>a</Text>
          <RawAnsi lines={[]} width={5} />
          <Text>b</Text>
        </Box>,
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("O4 supportsHyperlinks", () => {
  const cases: [string, Parameters<typeof supportsHyperlinks>[0], boolean][] = [
    ["库判定支持即支持", { stdoutSupported: true, env: {} }, true],
    ["都不认识则不支持", { stdoutSupported: false, env: {} }, false],
    [
      "TERM_PROGRAM 白名单（iTerm.app）",
      { stdoutSupported: false, env: { TERM_PROGRAM: "iTerm.app" } },
      true,
    ],
    [
      "TERM_PROGRAM 白名单（ghostty）",
      { stdoutSupported: false, env: { TERM_PROGRAM: "ghostty" } },
      true,
    ],
    [
      "tmux 里看 LC_TERMINAL",
      { stdoutSupported: false, env: { TERM_PROGRAM: "tmux", LC_TERMINAL: "iTerm2" } },
      true,
    ],
    ["TERM 含 kitty", { stdoutSupported: false, env: { TERM: "xterm-kitty" } }, true],
    [
      "Apple Terminal 不支持",
      { stdoutSupported: false, env: { TERM_PROGRAM: "Apple_Terminal" } },
      false,
    ],
  ];
  for (const [name, opts, want] of cases) {
    test(`O4: ${name}`, () => {
      expect(supportsHyperlinks(opts)).toBe(want);
    });
  }
});
