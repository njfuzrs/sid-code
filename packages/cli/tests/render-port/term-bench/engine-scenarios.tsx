/**
 * 引擎级场景 E1–E10（B9 / T3.2 起，设计文档阶段 3 出口；E8–E10 是 T3.3 的 R7 / R8 / R10）。
 *
 * 和 S1–S14 同一个测试台、同一套 xterm 判定，区别是**只用 Box / Text**，不挂 CLI 组件：
 * 阶段 3 时新底座还没有 Static / Ansi / alt-screen，S 场景跑不起来（见设计文档阶段 3 的 review 修正）。
 * 不入基线文件：每个场景在 legacy 与 next 上各跑一遍，当场比较（engine.test.ts）。
 */
import React, { useSyncExternalStore } from "react";
import { Box, Text } from "../../../src/ui/render-port/components.ts";
import { getRenderInstance, render } from "../../../src/ui/render-port/runtime.ts";
import { enableFrameThrottle } from "../../../src/ui/render-port/testing.ts";
import type { Scenario, ScenarioCtx } from "./scenarios.tsx";

function store<T>(initial: T) {
  let v = initial;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(next: T) {
      v = next;
      for (const s of subs) s();
    },
    use: () =>
      useSyncExternalStore(
        (cb) => {
          subs.add(cb);
          return () => subs.delete(cb);
        },
        () => v,
      ),
  };
}

async function mount(ctx: ScenarioCtx, node: React.ReactNode) {
  const inst = await render(node, {
    stdout: process.stdout,
    stdin: ctx.stdin,
    stderr: process.stderr,
    patchConsole: false,
    exitOnCtrlC: false,
    onFrame: ctx.onFrame,
  });
  await ctx.settle();
  return inst;
}

/** 一列行；`lines` 每项是一行的内容 */
function Lines({ lines }: { lines: string[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
    </Box>
  );
}

const L = (n: number, f: (i: number) => string = (i) => `行 ${i}`) =>
  Array.from({ length: n }, (_, i) => f(i));

export const ENGINE_SCENARIOS: Record<string, Scenario> = {
  E1: {
    covers: ["R1", "R4"],
    async run(ctx) {
      // 流式增长越过视口：旧行自然进 scrollback，不 full reset
      const lines = store<string[]>([]);
      function App() {
        return <Lines lines={lines.use()} />;
      }
      const inst = await mount(ctx, <App />);
      ctx.step("空");
      for (let i = 1; i <= ctx.rows * 2; i++) {
        lines.set(L(i, (k) => `流式 ${k} ${"内容".repeat((k % 4) + 1)}`));
        await ctx.settle(20);
        if (i % ctx.rows === 0) ctx.step(`追加到 ${i} 行`);
      }
      inst.unmount();
    },
  },

  E2: {
    covers: ["R3"],
    async run(ctx) {
      // 视口内原地改：只改一个单元 / 改样式 / 宽字符替换 / 行尾变短
      const rows = store(
        L(6, (i) => (i === 2 ? "中文 ABC 一二三" : i === 4 ? "colored" : `第 ${i} 行 不变`)),
      );
      const color = store<"ansi:red" | "ansi:green">("ansi:red");
      function App() {
        const ls = rows.use();
        const c = color.use();
        return (
          <Box flexDirection="column">
            {ls.map((l, i) =>
              i === 4 ? (
                <Text key={i} color={c} bold>
                  {l}
                </Text>
              ) : (
                <Text key={i}>{l}</Text>
              ),
            )}
          </Box>
        );
      }
      const inst = await mount(ctx, <App />);
      ctx.step("初始");
      rows.set(rows.get().map((l, i) => (i === 1 ? "第 1 行 改了" : l)));
      await ctx.settle();
      ctx.step("改一行");
      color.set("ansi:green");
      await ctx.settle();
      ctx.step("只改颜色");
      rows.set(rows.get().map((l, i) => (i === 2 ? "中文 XBC 一二三" : i === 5 ? "短" : l)));
      await ctx.settle();
      ctx.step("宽字符行改窄字符 + 行尾变短");
      inst.unmount();
    },
  },

  E3: {
    covers: ["R5"],
    async run(ctx) {
      // 变化落在已进 scrollback 的行上 → full reset
      const top = store("顶部 执行中");
      function App() {
        return <Lines lines={[top.use(), ...L(ctx.rows + 4)]} />;
      }
      const inst = await mount(ctx, <App />);
      ctx.step("顶行已滚出视口");
      top.set("顶部 完成");
      await ctx.settle();
      ctx.step("屏外行变化");
      inst.unmount();
    },
  },

  E4: {
    covers: ["R6"],
    async run(ctx) {
      const n = store(3);
      function App() {
        return <Lines lines={L(n.use())} />;
      }
      const inst = await mount(ctx, <App />);
      ctx.step("3 行");
      n.set(ctx.rows - 2);
      await ctx.settle();
      ctx.step("视口内增长");
      n.set(ctx.rows - 4);
      await ctx.settle();
      ctx.step("视口内收缩");
      n.set(ctx.rows + 6);
      await ctx.settle();
      ctx.step("超出视口");
      n.set(ctx.rows + 3);
      await ctx.settle();
      ctx.step("溢出态内收缩");
      n.set(4);
      await ctx.settle();
      ctx.step("收缩回 4 行");
      inst.unmount();
    },
  },

  E5: {
    covers: ["R2"],
    async run(ctx) {
      // 真实调度：同一 tick 内 5 次提交合并成 2 帧（leading + trailing）
      const restore = enableFrameThrottle();
      try {
        const v = store(0);
        let frames = 0;
        function App() {
          return <Text>计数 {v.use()}</Text>;
        }
        const inst = await render(<App />, {
          stdout: process.stdout,
          stdin: ctx.stdin,
          stderr: process.stderr,
          patchConsole: false,
          exitOnCtrlC: false,
          onFrame: () => frames++,
        });
        await ctx.settle();
        ctx.step("初始");
        // 外部 store 同 tick 连 set：React 自己把它们批成一次提交 → 1 帧
        let base = frames;
        for (let i = 1; i <= 5; i++) v.set(i);
        await ctx.settle();
        ctx.note("store-burst-frames", String(frames - base));
        ctx.step("同 tick 5 次 store 更新");
        // 5 次 rerender = 5 次提交：调度器合并成 leading + trailing 2 帧
        base = frames;
        for (let i = 6; i <= 10; i++) inst.rerender(<Text>计数 {i}</Text>);
        await ctx.settle();
        ctx.note("commit-burst-frames", String(frames - base));
        ctx.step("同 tick 5 次提交");
        inst.unmount();
      } finally {
        restore();
      }
    },
  },

  E6: {
    covers: ["R3", "R9"],
    async run(ctx) {
      // 宽度补偿字符、超链接在增量帧里的写法
      const a = store("x");
      function App() {
        const v = a.use();
        return (
          <Lines
            lines={[
              `前 ❤️ 后 ${v}`,
              `\x1b]8;;https://example.com/${v}\x07链接 ${v}\x1b]8;;\x07 尾`,
              "不变行",
            ]}
          />
        );
      }
      const inst = await mount(ctx, <App />);
      ctx.step("初始");
      a.set("y");
      await ctx.settle();
      ctx.step("补偿字符后 + 链接目标变化");
      inst.unmount();
    },
  },

  E7: {
    covers: ["R7"],
    async run(ctx) {
      // 单次宽度变化 → full reset 重排（连续 resize 合并、变矮归 T3.3）
      function App() {
        return (
          <Box flexDirection="column" width="100%">
            <Box justifyContent="space-between">
              <Text>左</Text>
              <Text>右</Text>
            </Box>
            <Text>{"长行".repeat(30)}</Text>
          </Box>
        );
      }
      const inst = await mount(ctx, <App />);
      ctx.step(`宽 ${ctx.cols}`);
      ctx.resize(40, ctx.rows);
      await ctx.settle();
      ctx.step("窄 40");
      inst.unmount();
    },
  },
  E8: {
    covers: ["R7"],
    async run(ctx) {
      // resize 合并 + 视口变矮 / 变高：同 tick 连发 resize 只出 leading + trailing；变矮 full reset，变高照常 diff
      const lines = store(L(4));
      function App() {
        return (
          <Box flexDirection="column" width="100%">
            <Box justifyContent="space-between">
              <Text>左</Text>
              <Text>右</Text>
            </Box>
            <Lines lines={lines.use()} />
          </Box>
        );
      }
      const inst = await mount(ctx, <App />);
      ctx.step("初始");
      ctx.resize(50, ctx.rows);
      ctx.resize(60, ctx.rows);
      ctx.resize(70, ctx.rows);
      await ctx.settle();
      ctx.step("同 tick 三次变宽");
      ctx.resize(70, ctx.rows);
      await ctx.settle();
      ctx.step("尺寸不变的 resize");
      ctx.resize(70, ctx.rows - 6);
      await ctx.settle();
      ctx.step("变矮");
      ctx.resize(70, ctx.rows + 4);
      await ctx.settle();
      ctx.step("变高");
      lines.set(L(4, (i) => (i === 3 ? "改了" : `行 ${i}`)));
      await ctx.settle();
      ctx.step("变高后改行");
      lines.set(L(ctx.rows + 8));
      await ctx.settle();
      ctx.resize(70, ctx.rows - 4);
      await ctx.settle();
      ctx.step("溢出态变矮");
      inst.unmount();
    },
  },

  E9: {
    covers: ["R8"],
    async run(ctx) {
      // 主屏 forceRedraw：外部写入污染后擦可视区重画；之后的提交照常增量
      const v = store("需要重绘的内容");
      function App() {
        return <Lines lines={[v.use(), "第二行"]} />;
      }
      const inst = await mount(ctx, <App />);
      ctx.step("初始");
      process.stdout.write("\x1b[1;1H污染");
      ctx.step("被外部写入污染");
      getRenderInstance()?.forceRedraw();
      await ctx.settle();
      ctx.step("forceRedraw 后");
      v.set("重绘后改了");
      await ctx.settle();
      ctx.step("之后照常增量");
      ctx.resize(60, ctx.rows);
      getRenderInstance()?.forceRedraw();
      await ctx.settle();
      ctx.step("resize 与 forceRedraw 同 tick");
      inst.unmount();
    },
  },

  E10: {
    covers: ["R10"],
    async run(ctx) {
      // 主屏 SIGCONT：不写字节，下一帧从光标处接着按首帧口径写（前面没变的行省成换行）
      const v = store(L(4));
      function App() {
        return <Lines lines={v.use()} />;
      }
      const inst = await mount(ctx, <App />);
      ctx.step("初始");
      process.emit("SIGCONT" as NodeJS.Signals);
      await ctx.settle();
      ctx.step("SIGCONT 后不写");
      v.set(L(5, (i) => (i === 2 ? "改了" : `行 ${i}`)));
      await ctx.settle();
      ctx.step("SIGCONT 后第一帧");
      v.set(L(5, (i) => (i === 4 ? "再改" : i === 2 ? "改了" : `行 ${i}`)));
      await ctx.settle();
      ctx.step("之后照常增量");
      inst.unmount();
    },
  },
};
