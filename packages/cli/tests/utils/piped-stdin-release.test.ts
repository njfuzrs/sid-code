/**
 * T1（20261018 复审）：readPipedStdin 超时后必须释放 stdin 句柄，进程才能自然退出。
 *
 * 为什么另写一条而不靠 print-stdin-held-open-exit：那三条 e2e 里 text / json 靠
 * runHeadless 末尾 `process.exit` 退，stream-json 靠 app.ts 的 `Readable.from([])`，
 * 删掉 piped-stdin.ts 里的 `pause()` 三条照样绿（该文件注释自己写明了）。
 * 这里子进程不调 `process.exit`，唯一能让它退的就是 `pause()`。
 *
 * 不写 ~/.sid-code，无需落盘隔离。
 */
import { test, expect } from "bun:test";
import { resolve } from "node:path";

const CHILD = resolve(import.meta.dir, "fixtures/piped-stdin-child.ts");

test("上游 stdin 保持打开：读超时后子进程自然退出（不靠 process.exit）", async () => {
  const proc = Bun.spawn([process.execPath, CHILD], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Bun 子进程不继承运行时 process.env，显式传入以保留 preload 设的隔离 SID_CONFIG_DIR
    env: { ...process.env },
  });
  proc.stdin.write("partial");
  proc.stdin.flush();
  // 写端刻意不 end()。超时 300ms，留足余量；未修时会一直挂到下面的 kill。
  const exited = await Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 4000)),
  ]);
  if (!exited) proc.kill();
  const out = await new Response(proc.stdout).text();
  expect(exited).toBe(true);
  expect(JSON.parse(out.trim())).toEqual({ timedOut: true, len: 7 });
}, 10_000);
