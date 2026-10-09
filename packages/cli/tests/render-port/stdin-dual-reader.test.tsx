/**
 * 契约 I1：stdin 有两个读者（B9 / T0.3）。
 *
 * 底座 App 在 raw mode 打开时挂 'readable' 并循环 read()（驱动 useInput）；
 * CLI 的 KeypressContext 同时挂 'data'。设计文档 review 时把「两者共存的确切行为」
 * 列为最大未知项，这里只经端口 API 驱动，把它钉成测试。
 *
 * 2026-10-03 探针结论（Bun 1.4.2 与 Node 行为一致，PassThrough 与真实 PTY stdin 一致）：
 * 两个读者**都**拿到每一块字节，顺序是 data 先、readable 后；
 * 流处于 paused（readableFlowing=false）—— 'readable' 监听会把流从 flowing 拉回 paused，
 * 但 Node 仍会在 read() 时把同一块 emit 给 'data'。
 *
 * 新底座只要改成「只挂 data」或「先 read() 再分发」，CLI 侧就可能少收或重复收键，
 * 而布局测试全绿。所以这条契约必须在 legacy 与 next 上都跑。
 */
import { describe, expect, test } from "bun:test";
import React, { useEffect } from "react";
import { PassThrough } from "node:stream";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useInput, useStdin } from "@sid-code/cli/ui/render-port/hooks.ts";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function makeStreams() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { columns: 80, rows: 24, isTTY: false });
  stdout.on("data", () => {});
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  return { stdout, stdin };
}

/** 同时使用两条读路径：底座 useInput（readable+read）与 CLI 式的裸 'data' 监听。 */
function DualReader({ log }: { log: string[] }) {
  const { stdin } = useStdin();
  useInput((input) => {
    log.push(`U:${input}`);
  });
  useEffect(() => {
    const onData = (c: Buffer | string) => log.push(`D:${String(c)}`);
    stdin.on("data", onData);
    return () => {
      stdin.removeListener("data", onData);
    };
  }, [stdin, log]);
  return <Text>x</Text>;
}

async function mount() {
  const log: string[] = [];
  const { stdout, stdin } = makeStreams();
  const inst = renderSync(<DualReader log={log} />, {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await tick();
  return { log, stdin, inst };
}

describe("I1 stdin 双读者", () => {
  test("I1: 真实写入流的每块字节，底座 useInput 与裸 data 监听都收到", async () => {
    const { log, stdin, inst } = await mount();
    (stdin as unknown as PassThrough).write("a");
    await tick();
    (stdin as unknown as PassThrough).write("b");
    await tick();
    inst.unmount();
    expect(log.filter((l) => l.startsWith("U:"))).toEqual(["U:a", "U:b"]);
    expect(log.filter((l) => l.startsWith("D:"))).toEqual(["D:a", "D:b"]);
  });

  test("I1: 同一块字节 data 读者先于底座 readable 读者", async () => {
    const { log, stdin, inst } = await mount();
    (stdin as unknown as PassThrough).write("z");
    await tick();
    inst.unmount();
    expect(log).toEqual(["D:z", "U:z"]);
  });

  test("I1: 挂了 readable 后流处于 paused（readableFlowing=false），不是 flowing", async () => {
    const { stdin, inst } = await mount();
    expect((stdin as unknown as PassThrough).readableFlowing).toBe(false);
    inst.unmount();
  });

  test("I1: 直接 emit('data') 只到达 data 读者，底座 useInput 收不到（测试 shim 的盲区）", async () => {
    // render-port/testing.ts 的 render().stdin.write 就是 emit('data')。
    // 所以用它写的输入只走 CLI 的 KeypressContext，走不到底座 useInput ——
    // 用 shim 测 useInput 组件会「什么都没发生」，这是测试设施的已知限制，不是组件 bug。
    const { log, stdin, inst } = await mount();
    stdin.emit("data", Buffer.from("q"));
    await tick();
    inst.unmount();
    expect(log).toEqual(["D:q"]);
  });

  test("I1: 卸载后底座摘掉 readable，剩下的 data 读者把流切回 flowing 并继续收字节", async () => {
    const log: string[] = [];
    const { stdout, stdin } = makeStreams();
    const inst = renderSync(<DualReader log={[]} />, {
      stdout,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await tick();
    // 底座之外的长寿读者（对应会话选择器卸载后仍在的读者）
    stdin.on("data", (c) => log.push(`D:${String(c)}`));
    inst.unmount();
    await tick();
    (stdin as unknown as PassThrough).write("k");
    await tick();
    expect(log).toEqual(["D:k"]);
    expect(stdin.listenerCount("readable")).toBe(0);
  });
});
