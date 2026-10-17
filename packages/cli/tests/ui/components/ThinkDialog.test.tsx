/**
 * /think 面板整帧渲染：每个选项后的「→ xxx」必须与 Footer 显示的词一致，
 * 恒思考模型上 off 标「本模型无效」，auto 说明不再写成「跟随 effort」。
 */
import { test, expect, describe } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { TerminalProvider } from "@sid-code/cli/ui/contexts/TerminalContext.tsx";
import { ThinkDialog } from "@sid-code/cli/ui/components/ThinkDialog.tsx";
import type { ThinkingSetting } from "@sid-code/core/llm/effort.ts";

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

function frameOf(
  control: "toggle" | "locked-on",
  thinkingDefaultOn: boolean,
  runtime: ThinkingSetting,
): string {
  let output = "";
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 120;
  stdout.rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;
  stdout.on("data", (c: Buffer) => (output += c.toString()));
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const a = stdin as unknown as Record<string, unknown>;
  a.isTTY = true;
  a.setRawMode = () => stdin;
  a.setEncoding = () => stdin;
  a.ref = () => stdin;
  a.unref = () => stdin;

  const capability = {
    supportsThinkingToggle: true,
    thinkingControl: control,
    thinkingDefaultOn,
  } as never;
  const inst = renderSync(
    <TerminalProvider>
      <KeypressProvider>
        <ThinkDialog
          onClose={() => {}}
          getThinkingState={() => ({ runtime, applied: thinkingDefaultOn, capability })}
        />
      </KeypressProvider>
    </TerminalProvider>,
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );
  inst.unmount();
  return stripAnsi(output);
}

const line = (frame: string, label: string) =>
  frame.split("\n").find((l) => new RegExp(`\\b${label}\\s+(强制|跟随|关闭)`).test(l)) ?? "";

describe("ThinkDialog", () => {
  test("可开关 + 默认开 + auto：状态行与各选项预览同 Footer 词", () => {
    const f = frameOf("toggle", true, undefined);
    expect(f).toContain("当前: auto·on");
    expect(line(f, "on")).toContain("→ on");
    expect(line(f, "auto")).toContain("→ auto·on");
    expect(line(f, "off")).toContain("→ off");
    expect(f).toContain("跟随模型默认");
    expect(f).not.toContain("跟随 effort");
  });

  test("恒思考模型：所有预览都是 always，off 标本模型无效", () => {
    const f = frameOf("locked-on", true, "off");
    expect(f).toContain("当前: always");
    expect(line(f, "off")).toContain("→ always（本模型无效）");
    expect(line(f, "on")).not.toContain("本模型无效");
  });
});
