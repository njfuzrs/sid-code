// B9 / T1.2 编译冒烟夹具：被 tests/compile-smoke.test.ts 用 `bun build --compile` 打成二进制再运行。
// 刻意走底座的真实入口（src/index.ts），并直接碰一次 yoga-layout，证明 WASM 布局被打进了产物。
import React from "react";
import Yoga from "yoga-layout";
import { Box, render, renderToString, Text } from "../../src/index.ts";

const App = () => (
  <Box borderStyle="round" padding={1} width={30}>
    <Text color="ansi:green">hello 你好</Text>
  </Box>
);

console.log(`YOGA:${typeof Yoga.Node.create}`);
console.log(renderToString(<App />, { columns: 40 }));
const inst = render(<App />, { patchConsole: false });
inst.unmount();
await inst.waitUntilExit();
console.log("SMOKE_OK");
