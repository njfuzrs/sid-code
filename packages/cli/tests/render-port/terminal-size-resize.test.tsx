/**
 * R7 补充（T8.1d 人工矩阵发现）：resize 后 React 侧要拿到新宽度并重渲。
 *
 * 真实症状：next 上拖窄窗口文字被截断、拖宽不跟——CLI 的 `TerminalContext` 读
 * `TerminalSizeContext`，13 个组件读 `useStdout().stdout.columns`，再用 `width={termWidth}`
 * 定死根 Box。底座不提供 Context / useStdout 不订阅尺寸时，resize 没有任何 React 值变化，
 * 根 Box 永远停在启动宽度。S6 场景用 `width="100%"` 跟着 yoga 走，所以一直没测到。
 */
import { describe, expect, test } from "bun:test";
import React, { useContext } from "react";
import { Box, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { TerminalSizeContext, useStdout } from "@sid-code/cli/ui/render-port/hooks.ts";
import { mountTTY, tick, ttyStreams } from "./tty-streams.ts";

function resize(s: ReturnType<typeof ttyStreams>, columns: number) {
  (s.stdout as unknown as { columns: number }).columns = columns;
  s.stdout.emit("resize");
}

describe("R7: resize 推到 React 侧", () => {
  test("TerminalSizeContext 有值且随 resize 更新", async () => {
    const seen: (number | null)[] = [];
    function App() {
      const size = useContext(TerminalSizeContext);
      seen.push(size?.columns ?? null);
      return <Text>{`w=${size?.columns ?? "null"}`}</Text>;
    }
    const s = ttyStreams({ columns: 60 });
    const m = mountTTY(<App />, s);
    await tick();
    resize(s, 30);
    await tick();
    resize(s, 90);
    await tick();
    m.teardown();
    expect(seen[0]).toBe(60);
    expect(seen.at(-1)).toBe(90);
    expect(seen).toContain(30);
  });

  test("useStdout().stdout.columns 随 resize 更新并触发重渲", async () => {
    const seen: number[] = [];
    function App() {
      const { stdout } = useStdout();
      seen.push(stdout.columns);
      return <Text>x</Text>;
    }
    const s = ttyStreams({ columns: 60 });
    const m = mountTTY(<App />, s);
    await tick();
    resize(s, 30);
    await tick();
    m.teardown();
    expect(seen[0]).toBe(60);
    expect(seen.at(-1)).toBe(30);
  });

  test("按 termWidth 定死根 Box 宽度的布局：拖窄后长行按新宽度折行、不被截断", async () => {
    function App() {
      const { stdout } = useStdout();
      return (
        <Box width={stdout.columns} flexDirection="column">
          <Text>{"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"}</Text>
        </Box>
      );
    }
    const s = ttyStreams({ columns: 60, rows: 20 });
    const m = mountTTY(<App />, s);
    await tick();
    s.clear();
    resize(s, 20);
    await tick(60);
    const out = s.out();
    m.teardown();
    // 36 个字符：根 Box 停在旧宽度 60 时整行写进 20 列屏幕，第 21 个字符起被裁掉；
    // 跟上新宽度则折成两行，尾段 "KLMNOPQRSTUVWXYZ" 完整出现
    expect(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")).toContain("UVWXYZ");
  });
});
