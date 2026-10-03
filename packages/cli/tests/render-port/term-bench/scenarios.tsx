/**
 * 差分测试台场景 S1–S14（B9 / T0.4，设计文档 §3 L3 首批清单）。
 *
 * 规则：
 * - 只经 render-port 与真实 CLI 组件驱动，不碰底座内部（端口换实现后同一份场景直接复用）；
 * - 状态从组件外推进（外部 store），每个关键点 `ctx.step()` 拍一张快照；
 * - 最后一步之后的卸载 / 退出字节归到最后一张快照的指标里，
 *   所以「退出后终端模式恢复」看的是最后一步的 `modes` 之外，还要看 `total`。
 */
import React, { useSyncExternalStore } from "react";
import { AlternateScreen, Box, Static, Text } from "../../../src/ui/render-port/components.ts";
import { useTabStatus, useTerminalTitle } from "../../../src/ui/render-port/hooks.ts";
import { inkInstances, render } from "../../../src/ui/render-port/runtime.ts";
import { MarkdownAnsi } from "../../../src/ui/components/MarkdownAnsi.tsx";
import { SettingsProvider } from "../../../src/ui/contexts/SettingsContext.tsx";
import { TableRenderer } from "../../../src/ui/components/TableRenderer.tsx";
import {
  KeypressProvider,
  useKeypress,
  KeypressPriority,
} from "../../../src/ui/contexts/KeypressContext.tsx";
import { enableMouseEvents, disableMouseEvents } from "../../../src/ui/contexts/MouseContext.tsx";
import { installTUIConsoleGuard } from "../../../src/ui/console-guard.ts";

export interface ScenarioCtx {
  stdin: NodeJS.ReadStream;
  cols: number;
  rows: number;
  /** 结算上一步并开始下一步（快照在下一个 step 或结束时拍） */
  step: (label: string) => void;
  /** 记一条场景侧观测（如 waitUntilExit 的结果），进 BenchResult.notes */
  note: (key: string, value: string) => void;
  settle: (ms?: number) => Promise<void>;
  /** 往 stdin 写字节（真实 write，走 readable 与 data 两条路径，见契约 I1） */
  type: (s: string) => void;
  resize: (cols: number, rows: number) => void;
  /** 交给 render 的 onFrame，只用于帧耗时基线（不进快照：耗时不确定） */
  onFrame: (e: { durationMs: number }) => void;
}

export interface Scenario {
  /** 覆盖的契约 ID，供 verify-tui-spec 的 `⏳ T0.4 S<n>` 对账 */
  covers: string[];
  run: (ctx: ScenarioCtx) => Promise<void>;
}

/** 极简外部 store：场景从外部推状态，组件 useSyncExternalStore 订阅。 */
function store<T>(initial: T) {
  let v = initial;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set: (next: T) => {
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

/**
 * 所有场景都包一层 SettingsProvider：真实 CLI 组件（MarkdownAnsi / TableRenderer …）依赖它，
 * 缺了会渲染底座的错误面板而不是内容 —— 快照照样能拍，场景却在测错误面板（T0.4 实测踩到）。
 */
async function mountWith(ctx: ScenarioCtx, node: React.ReactNode) {
  const inst = await render(<SettingsProvider>{node}</SettingsProvider>, {
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

const STREAM_TEXT = [
  "# 标题",
  "",
  "这是一段**流式**输出的 markdown，用来检查增量追加与 scrollback。",
  "",
  ...Array.from({ length: 40 }, (_, i) => `- 第 ${i + 1} 项：${"内容".repeat((i % 5) + 1)}`),
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

export const SCENARIOS: Record<string, Scenario> = {
  S1: {
    covers: ["R1", "R3", "R4", "P2"],
    async run(ctx) {
      const text = store("");
      function App() {
        return (
          <Box flexDirection="column">
            <MarkdownAnsi text={text.use()} terminalWidth={ctx.cols} />
          </Box>
        );
      }
      const inst = await mountWith(ctx, <App />);
      ctx.step("空");
      // 逐块追加，总长超过 3 屏
      // 每块之间让出 >1 帧（16ms 节流），否则同一 tick 内的 set 被合并成一帧，等于没流式
      const chunks = STREAM_TEXT.match(/[\s\S]{1,24}/g)!;
      for (let i = 0; i < chunks.length; i++) {
        text.set(chunks.slice(0, i + 1).join(""));
        await ctx.settle(25);
        if ((i + 1) % 10 === 0) ctx.step(`追加 ${i + 1}/${chunks.length}`);
      }
      ctx.step("流式完成");
      await ctx.settle();
      inst.unmount();
    },
  },

  S2: {
    covers: ["R6"],
    async run(ctx) {
      const n = store(3);
      function App() {
        const k = n.use();
        return (
          <Box flexDirection="column">
            {Array.from({ length: k }, (_, i) => (
              <Text key={i}>动态行 {i}</Text>
            ))}
          </Box>
        );
      }
      const inst = await mountWith(ctx, <App />);
      ctx.step("3 行");
      n.set(ctx.rows + 6);
      await ctx.settle();
      ctx.step(`超出视口（${ctx.rows + 6} 行）`);
      n.set(4);
      await ctx.settle();
      ctx.step("收缩回 4 行");
      inst.unmount();
    },
  },

  S3: {
    covers: ["R5", "R11"],
    async run(ctx) {
      type Item = { id: string; status: "executing" | "done" };
      const items = store<Item[]>([{ id: "read", status: "done" }]);
      const tail = store("思考中…");
      function App() {
        return (
          <Box flexDirection="column">
            <Static items={items.use()}>
              {(it) => (
                <Text key={it.id} color={it.status === "done" ? "ansi:green" : "ansi:yellow"}>
                  {it.status === "done" ? "●" : "○"} {it.id}{" "}
                  {it.status === "done" ? "完成" : "执行中"}
                </Text>
              )}
            </Static>
            <Text>{tail.use()}</Text>
          </Box>
        );
      }
      const inst = await mountWith(ctx, <App />);
      ctx.step("一项完成");
      items.set([...items.get(), { id: "bash", status: "executing" }]);
      await ctx.settle();
      ctx.step("bash 执行中");
      items.set(items.get().map((i) => (i.id === "bash" ? { ...i, status: "done" } : i)));
      tail.set("回答完成");
      await ctx.settle();
      ctx.step("bash 完成（原地 reconcile）");
      // 把执行中项推进 scrollback 之后再完成 → 变化落在屏外（R5）
      items.set([
        ...items.get(),
        { id: "long", status: "executing" },
        ...Array.from({ length: ctx.rows + 2 }, (_, i) => ({
          id: `fill${i}`,
          status: "done" as const,
        })),
      ]);
      await ctx.settle();
      ctx.step("执行中项被挤进 scrollback");
      items.set(items.get().map((i) => (i.id === "long" ? { ...i, status: "done" } : i)));
      await ctx.settle();
      ctx.step("屏外项完成");
      inst.unmount();
    },
  },

  S4: {
    covers: ["R9", "T3", "T4"],
    async run(ctx) {
      const lines = [
        "中文混排 ABC 一二三",
        "emoji 👍 与 ZWJ 👨‍👩‍👧 家庭",
        "组合字符 é（e + U+0301）",
        "RTL: שלום עולם mixed",
      ];
      const narrow = store(ctx.cols);
      function App() {
        const w = narrow.use();
        return (
          <Box flexDirection="column" width={w}>
            {lines.map((l) => (
              <Text key={l}>{l}</Text>
            ))}
            <Box width={12}>
              <Text wrap="truncate-middle">很长的中文路径/目录/文件名.ts</Text>
            </Box>
            <Box width={5}>
              <Text wrap="truncate-end">中文中文中文</Text>
            </Box>
          </Box>
        );
      }
      const inst = await mountWith(ctx, <App />);
      ctx.step("混排");
      narrow.set(9);
      await ctx.settle();
      ctx.step("挤到 9 列（宽字符被截）");
      inst.unmount();
    },
  },

  S5: {
    covers: ["T6"],
    async run(ctx) {
      const headers = ["名称", "类型", "说明"];
      const rows = [
        ["Box", "组件", "Flexbox 容器"],
        ["Text", "组件", "文本，支持 **粗体** 与 `代码`"],
        ["stringWidth", "函数", "CJK 宽 2、emoji 宽 2"],
      ];
      const width = store(80);
      function App() {
        return <TableRenderer headers={headers} rows={rows} terminalWidth={width.use()} />;
      }
      const inst = await mountWith(ctx, <App />);
      for (const w of [80, 40, 120]) {
        width.set(w);
        await ctx.settle();
        ctx.step(`表格 ${w} 列`);
      }
      inst.unmount();
    },
  },

  S6: {
    covers: ["R7"],
    async run(ctx) {
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
      const inst = await mountWith(ctx, <App />);
      ctx.step(`宽 ${ctx.cols}`);
      ctx.resize(40, ctx.rows);
      await ctx.settle();
      ctx.step("窄 40");
      ctx.resize(60, ctx.rows);
      ctx.resize(ctx.cols, ctx.rows);
      await ctx.settle();
      ctx.step(`连续两次 resize 回 ${ctx.cols}`);
      inst.unmount();
    },
  },

  S7: {
    covers: ["L3", "M1"],
    async run(ctx) {
      const offset = store(0);
      const copyMode = store(false);
      const total = 60;
      function App() {
        const top = offset.use();
        copyMode.use();
        return (
          <AlternateScreen mouseTracking>
            <Box flexDirection="column" height={ctx.rows}>
              <Box flexDirection="column" flexGrow={1} overflowY="hidden">
                <Box flexDirection="column" flexShrink={0} marginTop={-top}>
                  {Array.from({ length: total }, (_, i) => (
                    <Text key={i}>第 {i} 行</Text>
                  ))}
                </Box>
              </Box>
              <Text inverse> 状态栏 </Text>
            </Box>
          </AlternateScreen>
        );
      }
      const inst = await mountWith(ctx, <App />);
      ctx.step("进入 alt-screen");
      offset.set(20);
      await ctx.settle();
      ctx.step("滚动到第 20 行");
      // Copy Mode：CLI 命令式关鼠标（MouseContext 直写，契约 I4 表）
      disableMouseEvents();
      copyMode.set(true);
      await ctx.settle();
      ctx.step("Copy Mode 开（鼠标关）");
      enableMouseEvents();
      copyMode.set(false);
      await ctx.settle();
      ctx.step("Copy Mode 关（鼠标开）");
      inst.unmount();
      await ctx.settle();
      ctx.step("卸载后（回主屏）");
    },
  },

  S8: {
    covers: ["I4", "X5"],
    async run(ctx) {
      function App() {
        useKeypress(KeypressPriority.Normal, () => {});
        return <Text>主界面</Text>;
      }
      const inst = await mountWith(
        ctx,
        <KeypressProvider>
          <App />
        </KeypressProvider>,
      );
      ctx.step("主界面（raw mode 已开）");
      const ink = inkInstances.get(process.stdout);
      ink?.enterAlternateScreen();
      process.stdout.write("编辑器画面");
      await ctx.settle();
      ctx.step("外部编辑器中");
      ink?.exitAlternateScreen();
      await ctx.settle();
      ctx.step("编辑器退出后");
      inst.unmount();
    },
  },

  S9: {
    covers: ["R8"],
    async run(ctx) {
      const inst = await mountWith(ctx, <Text>需要重绘的内容</Text>);
      ctx.step("主屏");
      process.stdout.write("\x1b[1;1H污染");
      ctx.step("被外部写入污染");
      inkInstances.get(process.stdout)?.forceRedraw();
      await ctx.settle();
      ctx.step("主屏 forceRedraw 后");
      inst.unmount();
      const alt = await mountWith(
        ctx,
        <AlternateScreen mouseTracking={false}>
          <Text>alt 内容</Text>
        </AlternateScreen>,
      );
      ctx.step("alt-screen");
      process.stdout.write("\x1b[2;1H污染");
      inkInstances.get(process.stdout)?.forceRedraw();
      await ctx.settle();
      ctx.step("alt forceRedraw 后");
      alt.unmount();
    },
  },

  S10: {
    covers: ["E1", "E2"],
    async run(ctx) {
      // 与生产入口 fullscreen.ts 一致：render 之前装 console 护栏。
      // patchStderr 只拦裸 stderr.write，拦不到 console.error（两条信道，见 console-guard.ts 头注释）
      const uninstallGuard = installTUIConsoleGuard();
      const inst = await mountWith(
        ctx,
        <AlternateScreen mouseTracking={false}>
          <Text>alt 内容不应被 stderr 砸乱</Text>
        </AlternateScreen>,
      );
      ctx.step("alt 初始");
      process.stderr.write("裸 stderr 写入\n");
      await ctx.settle();
      ctx.step("裸 stderr 之后");
      console.error("console.error 写入");
      await ctx.settle();
      ctx.step("console.error 之后");
      inst.unmount();
      uninstallGuard();
    },
  },

  S11: {
    covers: ["I2", "X6"],
    async run(ctx) {
      // 短命实例（会话选择器）→ 主 TUI 交接；期间到达分片的 DA1 回复
      const picker = await mountWith(ctx, <Text>选择会话</Text>);
      ctx.step("选择器");
      ctx.note("picker-registered", String(inkInstances.get(process.stdout) !== undefined));
      picker.unmount();
      await ctx.settle();
      ctx.note("after-picker-unmount", String(inkInstances.get(process.stdout) !== undefined));
      const typed = store("");
      function Main() {
        useKeypress(KeypressPriority.Normal, (k) => {
          typed.set(typed.get() + (k.sequence ?? ""));
        });
        return <Text>输入框：{typed.use()}</Text>;
      }
      const main = await mountWith(
        ctx,
        <KeypressProvider>
          <Main />
        </KeypressProvider>,
      );
      ctx.step("主 TUI");
      ctx.type("\x1b[?1;2");
      await ctx.settle(30);
      ctx.type("c");
      ctx.type("hi");
      await ctx.settle();
      ctx.step("分片 DA1 回复 + 输入 hi");
      main.unmount();
    },
  },

  S12: {
    covers: ["X1", "X2", "X3"],
    async run(ctx) {
      const inst = await mountWith(
        ctx,
        <KeypressProvider>
          <Text>即将异常退出</Text>
        </KeypressProvider>,
      );
      ctx.step("运行中");
      const exit = inst.waitUntilExit().then(
        () => "resolved",
        (e: Error) => `rejected:${e.message}`,
      );
      inst.unmount(new Error("boom"));
      ctx.note("waitUntilExit", await exit);
      await ctx.settle();
      ctx.step("卸载后");
    },
  },

  S13: {
    covers: ["M2", "M3"],
    async run(ctx) {
      // 必须有 raw mode 使用者（这里是 KeypressProvider）：底座只在 raw mode 打开时才挂
      // readable 读者（契约 I1），否则鼠标字节根本不进选区引擎 —— T0.4 首跑时选区恒为空就是这个原因
      const inst = await mountWith(
        ctx,
        <KeypressProvider>
          <AlternateScreen mouseTracking>
            <Box flexDirection="column">
              <Text>第一行 可以被选中的文本</Text>
              <Text>第二行 another line</Text>
              <Text>第三行</Text>
            </Box>
          </AlternateScreen>
        </KeypressProvider>,
      );
      ctx.step("alt 初始");
      // SGR 鼠标：在第 1 行第 1 列按下，拖到第 2 行第 10 列，释放
      ctx.type("\x1b[<0;1;1M");
      await ctx.settle(30);
      ctx.type("\x1b[<32;10;2M");
      await ctx.settle(30);
      ctx.type("\x1b[<0;10;2m");
      await ctx.settle();
      ctx.step("拖选");
      const ink = inkInstances.get(process.stdout);
      ctx.note("selected", ink?.copySelectionNoClear() ?? "(无实例)");
      // 双击选词
      ink?.clearTextSelection();
      for (let i = 0; i < 2; i++) {
        ctx.type("\x1b[<0;10;2M");
        ctx.type("\x1b[<0;10;2m");
      }
      await ctx.settle();
      ctx.step("双击");
      ctx.note("double-click", ink?.copySelectionNoClear() ?? "(无实例)");
      inst.unmount();
    },
  },

  S14: {
    covers: ["O1", "O2", "O3"],
    async run(ctx) {
      const title = store<string | null>("sid-code · 任务");
      const tab = store<"busy" | "idle" | null>("busy");
      function App() {
        useTerminalTitle(title.use());
        useTabStatus(tab.use());
        return <Text>OSC 场景</Text>;
      }
      const inst = await mountWith(ctx, <App />);
      ctx.step("标题 + tab 忙");
      title.set("\x1b[31m带颜色的\x1b[0m标题");
      tab.set("idle");
      await ctx.settle();
      ctx.step("标题去 ANSI + tab 空闲");
      inst.unmount();
    },
  },
};
