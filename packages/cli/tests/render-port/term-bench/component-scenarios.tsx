/**
 * 组件级场景 C1–C2（B9 / T4.2，设计文档阶段 4 出口）。
 *
 * 引擎级场景（E*）只用 Box / Text；App 级场景（S*）要等阶段 5 的 stdin 就位才能在 next 上跑完整 App。
 * 这里介于两者之间：挂**真实的 CLI 历史项组件**（HistoryItemDisplay，含 tool_group / user / assistant），
 * 包在端口 `Static`（next 上是 History）里，按 MainScreenLayout 的结构排开：历史区 + 动态区。
 * 和 E* 一样不入基线，legacy 与 next 当场比较（component.test.ts）。
 */
import React, { useSyncExternalStore } from "react";
import { Box, Static, Text } from "../../../src/ui/render-port/components.ts";
import { render } from "../../../src/ui/render-port/runtime.ts";
import { SettingsProvider } from "../../../src/ui/contexts/SettingsContext.tsx";
import { UIStateProvider } from "../../../src/ui/contexts/UIStateContext.tsx";
import { HistoryItemDisplay } from "../../../src/ui/components/HistoryItemDisplay.tsx";
import { ToolCallStatus, type HistoryItem } from "../../../src/ui/types.ts";
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

const tool = (id: number, name: string, status: ToolCallStatus, out?: string): HistoryItem =>
  ({
    id,
    type: "tool_group",
    tools: [
      {
        callId: `c${id}`,
        name,
        description: `${name} 参数 ${id}`,
        input: {},
        status,
        ...(out ? { resultDisplay: out } : {}),
      },
    ],
  }) as HistoryItem;

const user = (id: number, text: string) => ({ id, type: "user", text }) as HistoryItem;
const assistant = (id: number, text: string) => ({ id, type: "assistant", text }) as HistoryItem;

/** MainScreenLayout 的骨架：历史区（端口 Static）+ 动态区 */
function Layout({ items, tail, width }: { items: HistoryItem[]; tail: string; width: number }) {
  return (
    <Box flexDirection="column" width={width}>
      <Static items={items}>
        {(item: HistoryItem, index: number) => (
          <HistoryItemDisplay
            key={`h-${item.id}`}
            item={item}
            prevItem={index > 0 ? items[index - 1] : undefined}
            terminalWidth={width}
            thinkCollapsed
            thinkExpandable={false}
          />
        )}
      </Static>
      <Box flexDirection="column" flexShrink={0} width={width} paddingBottom={1}>
        <Text>{tail}</Text>
      </Box>
    </Box>
  );
}

async function mount(
  ctx: ScenarioCtx,
  items: ReturnType<typeof store<HistoryItem[]>>,
  tail: ReturnType<typeof store<string>>,
) {
  function App() {
    return <Layout items={items.use()} tail={tail.use()} width={ctx.cols} />;
  }
  const inst = await render(
    // 真实 App 的历史项依赖这两层 Provider（ToolMessage 读 UIState 的展开级别），缺了画的是错误面板
    <SettingsProvider>
      <UIStateProvider>
        <App />
      </UIStateProvider>
    </SettingsProvider>,
    {
      stdout: process.stdout,
      stdin: ctx.stdin,
      stderr: process.stderr,
      patchConsole: false,
      exitOnCtrlC: false,
      onFrame: ctx.onFrame,
    },
  );
  await ctx.settle();
  return inst;
}

export const COMPONENT_SCENARIOS: Record<string, Scenario> = {
  C1: {
    covers: ["R11"],
    async run(ctx) {
      // 视口内：执行中的 tool_group 放在历史区里，完成时原地变成终态（D-3 定案 A）
      const items = store<HistoryItem[]>([user(1, "看一下 README")]);
      const tail = store("思考中…");
      const inst = await mount(ctx, items, tail);
      ctx.step("用户消息");
      items.set([...items.get(), tool(2, "read_file", ToolCallStatus.Executing)]);
      await ctx.settle();
      ctx.step("工具执行中");
      items.set([
        user(1, "看一下 README"),
        tool(2, "read_file", ToolCallStatus.Success, "共 42 行"),
      ]);
      tail.set("回答中…");
      await ctx.settle();
      ctx.step("工具完成（原地 reconcile）");
      items.set([...items.get(), assistant(3, "README 讲的是**安装**与`用法`。")]);
      tail.set("");
      await ctx.settle();
      ctx.step("回答进历史");
      inst.unmount();
    },
  },

  C2: {
    covers: ["R5", "R11"],
    async run(ctx) {
      // 执行中的工具项被后续历史挤进 scrollback 后才完成：变化落在屏外 → full reset 一次（R5）
      const items = store<HistoryItem[]>([
        user(1, "跑一下测试"),
        tool(2, "bash", ToolCallStatus.Executing),
      ]);
      const tail = store("执行中…");
      const inst = await mount(ctx, items, tail);
      ctx.step("bash 执行中");
      const fill = Array.from({ length: ctx.rows }, (_, i) =>
        tool(10 + i, "read_file", ToolCallStatus.Success, `第 ${i} 个`),
      );
      items.set([...items.get(), ...fill]);
      await ctx.settle();
      ctx.step("执行中项被挤进 scrollback");
      items.set(
        items
          .get()
          .map((it) => (it.id === 2 ? tool(2, "bash", ToolCallStatus.Success, "全部通过") : it)),
      );
      tail.set("完成");
      await ctx.settle();
      ctx.step("屏外项完成");
      inst.unmount();
    },
  },
};
