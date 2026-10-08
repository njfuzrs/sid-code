// B9 / T7.1a：契约 E1 / E2（裸 stderr 护栏）的子进程夹具，由 stderr-guard.test.tsx 按 SID_TUI_RENDERER 运行。
//
// 必须是子进程：护栏换的是全局 `process.stderr.write`，`SID_CODE_DEBUG` 又在底座模块加载时读，
// 进程内测会互相污染。fd 1 / fd 2 都是管道，观测结果以 `<<key=value>>` 写进 fd 1（writeSync，不经被测的 write）。
// `console.error` 被换成记录器（模拟 CLI 的 console 护栏把它转进 logger）；第一个参数里的毫秒数归一成 N。
import { writeSync } from "node:fs";
import { PassThrough } from "node:stream";
import React, { useEffect, useState } from "react";
import { AlternateScreen, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { render } from "@sid-code/cli/ui/render-port/runtime.ts";

const out = process.stdout as unknown as Record<string, unknown>;
Object.defineProperty(out, "isTTY", { value: process.env.FIXTURE_TTY !== "0", configurable: true });
Object.defineProperty(out, "columns", { value: 40, configurable: true, writable: true });
Object.defineProperty(out, "rows", { value: 6, configurable: true, writable: true });

const note = (k: string, v: unknown) => writeSync(1, `<<${k}=${JSON.stringify(v)}>>`);
const mark = (label: string) => writeSync(1, `<<@${label}>>`);
const tick = () => new Promise((r) => setTimeout(r, 60));
const logged: unknown[][] = [];
const loopMode = process.env.FIXTURE_CE === "loop";
// 挂载之后才武装 loop / throw：旧底座 debug 时 render 里还会打一条「first ink render」日志，
// 那条不归护栏管（不是 E1 / E2），武装早了会让两边在挂载期就分叉
let armed = false;
console.error = (...args: unknown[]) => {
  logged.push(args.map((a) => (typeof a === "string" ? a.replace(/\d+ms/, "Nms") : a)));
  if (!armed) return;
  // 模拟 logger 又写回 stderr：护栏必须放行，不能无限递归（E2）
  if (loopMode) process.stderr.write(`inner:${logged.length}\n`);
  if (process.env.FIXTURE_CE === "throw") throw new Error("boom");
};
const takeLog = () => logged.splice(0);
const opts = { patchConsole: false, exitOnCtrlC: false } as const;
const fakeOut = () => {
  const s = new PassThrough() as unknown as Record<string, unknown> & NodeJS.WriteStream;
  Object.assign(s, { isTTY: true, columns: 40, rows: 6 });
  (s as unknown as PassThrough).on("data", () => {});
  return s;
};
const orig = process.stderr.write;

const name = process.argv[2]!;

if (name === "basic") {
  // 主屏 / alt；吞掉、返回值、回调同步无参、Buffer 解码、debug 日志、帧不重绘
  let set: (n: number) => void = () => {};
  function C() {
    const [n, s] = useState(0);
    set = s;
    const t = <Text>count {n}</Text>;
    return process.env.FIXTURE_ALT === "1" ? (
      <AlternateScreen mouseTracking={false}>{t}</AlternateScreen>
    ) : (
      t
    );
  }
  const inst = await render(<C />, opts);
  await tick();
  takeLog();
  note("patched", process.stderr.write !== orig);
  mark("write");
  const cb: string[] = [];
  const r1 = process.stderr.write("A\n", (...a: unknown[]) => cb.push(`cb1:${a.length}`));
  cb.push("after1");
  const r2 = process.stderr.write("B\n", "utf8", (...a: unknown[]) => cb.push(`cb2:${a.length}`));
  process.stderr.write("68690a", "hex");
  process.stderr.write(Buffer.from("中文\n"));
  process.stderr.write(new Uint8Array([0xe4, 0xb8, 0xad]));
  process.stderr.write("");
  await tick();
  mark("frame");
  set(1);
  await tick();
  mark("end-frame");
  note("ret", [r1, r2]);
  note("cb", cb);
  note("log", takeLog());
  for (const bad of [{ a: 1 }, null, undefined]) {
    const seen: string[] = [];
    try {
      (process.stderr.write as (...a: unknown[]) => boolean)(bad, () => seen.push("cb"));
      seen.push("ok");
    } catch (e) {
      seen.push(`threw:${(e as Error).constructor.name}`);
    }
    note(`bad:${bad === null ? "null" : typeof bad}`, seen);
  }
  inst.unmount();
  await tick();
  note("restored", process.stderr.write === orig);
  mark("after-unmount");
  process.stderr.write("AFTER\n");
  await tick();
  mark("done");
}

if (name === "reenter") {
  // FIXTURE_CE=loop：日志路径写回 stderr；FIXTURE_CE=throw：日志抛错，守卫要复位
  const inst = await render(<Text>a</Text>, opts);
  await tick();
  takeLog();
  armed = true;
  mark("write");
  const res: string[] = [];
  for (const s of ["R1\n", "R2\n"]) {
    try {
      res.push(String(process.stderr.write(s, () => res.push(`cb:${s.trim()}`))));
    } catch (e) {
      res.push(`threw:${(e as Error).message}`);
    }
  }
  await tick();
  mark("end");
  note("res", res);
  note("log", takeLog());
  inst.unmount();
  await tick();
  note("restored", process.stderr.write === orig);
}

if (name === "lifecycle") {
  // 与 TTY / stdout 无关；多实例按顺序还原；外部换掉后不覆盖；卸载期间 effect 清理的 stderr 落地；自定义 stderr 不拦
  const steps: string[] = [];
  const custom = new PassThrough() as unknown as NodeJS.WriteStream;
  const customGot: string[] = [];
  (custom as unknown as PassThrough).on("data", (d) => customGot.push(String(d)));
  const customOrig = custom.write;
  const a = await render(<Text>a</Text>, { ...opts, stdout: fakeOut(), stderr: custom });
  await tick();
  const pa = process.stderr.write;
  steps.push(`a:${pa !== orig}`, `custom-untouched:${custom.write === customOrig}`);
  custom.write("C\n");
  const b = await render(<Text>b</Text>, { ...opts, stdout: fakeOut() });
  await tick();
  const pb = process.stderr.write;
  steps.push(`b-new:${pb !== pa && pb !== orig}`);
  b.unmount();
  await tick();
  steps.push(`b-off->pa:${process.stderr.write === pa}`);
  a.unmount();
  await tick();
  steps.push(`a-off->orig:${process.stderr.write === orig}`);
  // 乱序：先卸 a 再卸 b，留下 a 的拦截器
  const a2 = await render(<Text>a2</Text>, { ...opts, stdout: fakeOut() });
  await tick();
  const b2 = await render(<Text>b2</Text>, { ...opts, stdout: fakeOut() });
  await tick();
  a2.unmount();
  await tick();
  steps.push(`a2-off-still-patched:${process.stderr.write !== orig}`);
  b2.unmount();
  await tick();
  steps.push(`b2-off-still-patched:${process.stderr.write !== orig}`);
  process.stderr.write = orig;
  // 外部替换
  const c = await render(<Text>c</Text>, { ...opts, stdout: fakeOut() });
  await tick();
  const foreign = ((...args: unknown[]) =>
    (orig as (...a: unknown[]) => boolean).apply(process.stderr, args)) as typeof orig;
  process.stderr.write = foreign;
  c.unmount();
  await tick();
  steps.push(`foreign-kept:${process.stderr.write === foreign}`);
  process.stderr.write = orig;
  // 卸载期间 effect 清理里写 stderr
  function D() {
    useEffect(() => () => void process.stderr.write("CLEANUP\n"), []);
    return <Text>d</Text>;
  }
  const d = await render(<D />, { ...opts, stdout: fakeOut() });
  await tick();
  takeLog();
  mark("cleanup");
  d.unmount();
  await tick();
  mark("end");
  note("steps", steps);
  note("custom", customGot);
  note("log", takeLog());
}

writeSync(1, "<<END>>");
process.exit(0);
