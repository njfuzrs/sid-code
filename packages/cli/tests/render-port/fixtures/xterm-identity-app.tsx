/**
 * T8.1a 夹具：每个子进程跑一个用例。`XID_CASE` 是 JSON：`[[实例 1 的回复…], [实例 2 的回复…]]`，
 * 每个实例挂载 → 喂回复 → 进 alt-screen → 单击链接 → 等满连击窗口，打印 `XID [各实例打开次数]`。
 * 识别结果是进程级的（旧底座同样如此），所以必须一个用例一个进程。
 */
import React from "react";
import { Box, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { useInput } from "@sid-code/cli/ui/render-port/hooks.ts";
import { mountTTY, tick, ttyStreams } from "../tty-streams.ts";

const ESC = "\x1b";

function Link() {
  useInput(() => {});
  return (
    <Box>
      <Text>https://x.test/1</Text>
    </Box>
  );
}

async function instance(replies: string[]): Promise<number> {
  const s = ttyStreams({ columns: 30, rows: 5 });
  const m = mountTTY(<Link />, s);
  await tick();
  for (const r of replies) {
    if (r === "") await tick(100);
    else {
      s.stdin.write(r);
      await tick();
    }
  }
  m.ink.setAltScreenActive(true, true);
  m.inst.rerender(<Link />);
  await tick();
  let opened = 0;
  m.ink.onHyperlinkClick = () => opened++;
  s.stdin.write(`${ESC}[<0;5;1M`);
  await tick();
  s.stdin.write(`${ESC}[<0;5;1m`);
  await tick(600);
  m.teardown();
  return opened;
}

delete process.env.TERM_PROGRAM;
const cases = JSON.parse(process.env.XID_CASE ?? "[]") as string[][];
const result: number[] = [];
for (const replies of cases) result.push(await instance(replies));
console.log(`XID ${JSON.stringify(result)}`);
process.exit(0);
