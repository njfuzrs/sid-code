// B9 / T6.1a：alt-screen 契约（M1 / R14）的子进程驱动，由 alt-screen.test.tsx 按 SID_TUI_RENDERER 运行。
//
// 为什么是子进程、渲染到 process.stdout：旧底座的 <AlternateScreen> 只通知 process.stdout 上的实例，
// 渲染到 PassThrough 时出帧仍走主屏 diff，测不到真实路径（T6.1a 探针实测）。
// fd 1 由父进程重定向到文件；步骤边界用 OSC 7777 标记写进同一字节流（同 term-bench/runner.tsx）。
import { writeSync } from "node:fs";
import { PassThrough } from "node:stream";
import React from "react";
import { AlternateScreen, Box, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { render } from "@sid-code/cli/ui/render-port/runtime.ts";

const out = process.stdout as unknown as Record<string, unknown>;
Object.defineProperty(out, "isTTY", { value: true, configurable: true });
Object.defineProperty(out, "columns", { value: 20, configurable: true, writable: true });
Object.defineProperty(out, "rows", { value: 6, configurable: true, writable: true });

const mark = (label: string) => writeSync(1, `\x1b]7777;${label}\x07`);
const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isRaw: boolean };
Object.assign(stdin, {
  isTTY: true,
  isRaw: false,
  setRawMode(v: boolean) {
    stdin.isRaw = v;
    return stdin;
  },
  ref: () => stdin,
  unref: () => stdin,
});
const settle = () => new Promise((r) => setTimeout(r, 80));
const lines = (n: number, mark = -1) =>
  Array.from({ length: n }, (_, i) => (
    <Text key={i}>
      L{i}
      {i === mark ? "x" : ""}
    </Text>
  ));
const resize = (columns: number, rows: number) => {
  out.columns = columns;
  out.rows = rows;
  process.stdout.emit("resize");
};

type Inst = Awaited<ReturnType<typeof render>>;
const CASES: Record<string, (r: (n: React.ReactNode) => Promise<Inst>) => Promise<Inst>> = {
  async enterExit(r) {
    const inst = await r(<Text>pre</Text>);
    await settle();
    mark("pre");
    inst.rerender(
      <AlternateScreen mouseTracking>
        <Text>hi</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    inst.rerender(
      <AlternateScreen mouseTracking>
        <Text>hi</Text>
        <Text>v2</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("update");
    inst.rerender(<Text>post</Text>);
    await settle();
    mark("exit");
    inst.rerender(<Text>post2</Text>);
    await settle();
    mark("afterExit");
    return inst;
  },
  async noMouse(r) {
    const inst = await r(
      <AlternateScreen mouseTracking={false}>
        <Text>hi</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    inst.rerender(<Text>post</Text>);
    await settle();
    mark("exit");
    return inst;
  },
  async defaultProps(r) {
    const inst = await r(
      <AlternateScreen>
        <Text>hi</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    return inst;
  },
  async tall(r) {
    const inst = await r(
      <AlternateScreen>
        <Box flexDirection="column">{lines(30)}</Box>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    inst.rerender(
      <AlternateScreen>
        <Box flexDirection="column">{lines(30, 3)}</Box>
      </AlternateScreen>,
    );
    await settle();
    mark("update");
    return inst;
  },
  async tallNoShrink(r) {
    const inst = await r(
      <AlternateScreen>
        <Box flexDirection="column">
          {lines(30).map((e, i) => (
            <Box key={i} flexShrink={0}>
              {e}
            </Box>
          ))}
        </Box>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    return inst;
  },
  async scroll(r) {
    const inst = await r(
      <AlternateScreen>
        <Box flexDirection="column" height={6}>
          <Box flexDirection="column" flexGrow={1} overflowY="scroll">
            {lines(20)}
          </Box>
          <Text>bar</Text>
        </Box>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    return inst;
  },
  async growShrink(r) {
    const inst = await r(
      <AlternateScreen>
        <Text>a</Text>
        <Text>b</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    inst.rerender(
      <AlternateScreen>
        <Text>a</Text>
        <Text>bc</Text>
        <Text>d</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("grow");
    inst.rerender(
      <AlternateScreen>
        <Text>a</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("shrink");
    inst.rerender(
      <AlternateScreen>
        <Text>a</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("same");
    return inst;
  },
  async styled(r) {
    const inst = await r(
      <AlternateScreen>
        <Text bold>a b</Text>
        <Text inverse>{"c  d"}</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    inst.rerender(
      <AlternateScreen>
        {/* 连续空格写成字符串表达式：JSX 文本里的会被格式化压成一个 */}
        <Text bold>{"a   b"}</Text>
        <Text inverse>{"c  e"}</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("update");
    return inst;
  },
  async wide(r) {
    const inst = await r(
      <AlternateScreen>
        <Text>中文ab</Text>
        <Text>x y</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    inst.rerender(
      <AlternateScreen>
        <Text>中文cd</Text>
        <Text>{"x  y"}</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("update");
    return inst;
  },
  async empty(r) {
    const inst = await r(
      <AlternateScreen>
        <Text></Text>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    inst.rerender(
      <AlternateScreen>
        <Text>z</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("update");
    return inst;
  },
  async nested(r) {
    const inst = await r(
      <AlternateScreen mouseTracking>
        <AlternateScreen mouseTracking={false}>
          <Text>n</Text>
        </AlternateScreen>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    inst.rerender(
      <AlternateScreen mouseTracking>
        <Text>n</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("inner");
    inst.rerender(<Text>x</Text>);
    await settle();
    mark("outer");
    return inst;
  },
  async siblings(r) {
    const inst = await r(
      <>
        <AlternateScreen>
          <Text>a</Text>
        </AlternateScreen>
        <AlternateScreen>
          <Text>b</Text>
        </AlternateScreen>
      </>,
    );
    await settle();
    mark("enter");
    return inst;
  },
  async toggleMouse(r) {
    const inst = await r(
      <AlternateScreen mouseTracking>
        <Text>t</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    inst.rerender(
      <AlternateScreen mouseTracking={false}>
        <Text>t</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("off");
    inst.rerender(
      <AlternateScreen mouseTracking>
        <Text>t</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("on");
    return inst;
  },
  async resize(r) {
    const inst = await r(
      <AlternateScreen mouseTracking>
        <Text>r</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    resize(30, 8);
    await settle();
    mark("resized");
    resize(30, 8);
    await settle();
    mark("sameSize");
    resize(30, 9);
    await settle();
    mark("taller");
    return inst;
  },
  async sigcont(r) {
    const inst = await r(
      <AlternateScreen mouseTracking={false}>
        <Text>s1</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("enter");
    process.emit("SIGCONT" as NodeJS.Signals);
    await settle();
    mark("sigcont");
    inst.rerender(
      <AlternateScreen mouseTracking={false}>
        <Text>s2</Text>
      </AlternateScreen>,
    );
    await settle();
    mark("frame");
    return inst;
  },
};

const name = process.argv[2]!;
const inst = await CASES[name]!((node) =>
  render(node, {
    stdout: process.stdout,
    stdin,
    stderr: process.stderr,
    patchConsole: false,
    exitOnCtrlC: false,
  }),
);
mark("unmount");
inst.unmount();
await settle();
process.exit(0);
