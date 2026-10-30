// 输入框按键延迟随历史长度的基准：History 里放 N 条（每条 20 行），测每个按键触发的出帧耗时。
// 用法：NS=200,500,800 NODE_ENV=production bun scripts/perf-input-lag.tsx

import React, { useState, useEffect } from "react";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render, Box, Text, History } from "../packages/tui/src/index.ts";

let setT: (s: string) => void = () => {};
function Input() {
  const [t, s] = useState("");
  useEffect(() => {
    setT = s;
  }, []);
  return (
    <Box borderStyle="single">
      <Text>{"> " + t}</Text>
    </Box>
  );
}
const Item = React.memo(({ i }: { i: number }) => (
  <Box flexDirection="column">
    {Array.from({ length: 20 }, (_, k) => (
      <Text
        key={k}
      >{`第${i}条 行${k} 这是一段比较长的历史文本 lorem ipsum dolor sit amet ${"x".repeat(40)}`}</Text>
    ))}
  </Box>
));
const renderItem = (i: number) => <Item key={i} i={i} />;
function Root({ items }: { items: number[] }) {
  return (
    <Box flexDirection="column" width={120}>
      <History items={items}>{renderItem}</History>
      <Input />
    </Box>
  );
}
class Out extends EventEmitter {
  columns = 120;
  rows = 40;
  isTTY = true;
  bytes = 0;
  write = (d: any, ...r: any[]) => {
    this.bytes += String(d).length;
    r.find((x) => typeof x === "function")?.();
    return true;
  };
}
for (const n of (process.env.NS ?? "200,500,800,1500").split(",").map(Number)) {
  const out = new Out();
  const stdin = new PassThrough() as any;
  Object.assign(stdin, {
    isTTY: true,
    isRaw: false,
    setRawMode() {
      return stdin;
    },
    ref() {
      return stdin;
    },
    unref() {
      return stdin;
    },
  });
  const times: number[] = [];
  const inst = render(<Root items={Array.from({ length: n }, (_, i) => i)} />, {
    stdout: out as any,
    stdin,
    stderr: out as any,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
    onRender: (m: any) => times.push(m.renderTime),
  } as any);
  await new Promise((r) => setTimeout(r, 50));
  times.length = 0;
  let txt = "";
  const t0 = performance.now();
  for (let k = 0; k < 40; k++) {
    txt += "a";
    setT(txt);
    await new Promise((r) => setTimeout(r, 20));
  }
  const wall = performance.now() - t0 - 40 * 20;
  times.sort((a, b) => a - b);
  console.log(
    `items=${n} (${n * 20}行) frames=${times.length} render p50=${times[times.length >> 1]?.toFixed(2)}ms p95=${times[Math.floor(times.length * 0.95)]?.toFixed(2)}ms 额外墙钟/键=${(wall / 40).toFixed(2)}ms`,
  );
  inst.unmount();
}
process.exit(0);
