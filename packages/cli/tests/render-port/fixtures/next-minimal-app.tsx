// B9 / T1.3：只经端口渲染一个最小 App。由 next-switch.test.ts 在子进程里按不同 SID_TUI_RENDERER 运行。
import React from "react";
import { Box, Text } from "@sid-code/cli/ui/render-port/components.ts";
import { render } from "@sid-code/cli/ui/render-port/runtime.ts";
import { RENDERER } from "@sid-code/cli/ui/render-port/select.ts";

const inst = await render(
  <Box borderStyle="round" paddingX={1}>
    <Text color="green">renderer={RENDERER}</Text>
  </Box>,
  { patchConsole: false, exitOnCtrlC: false },
);
// 先拿 exit promise 再卸载（与 fullscreen.ts 同序）。legacy 在 unmount 之后才调 waitUntilExit
// 会永远挂起：promise 在 resolve 发生之后才创建（实测，见 Agent Note T1.3）。
const exited = inst.waitUntilExit();
inst.unmount();
await exited;
process.stdout.write(`\nMINIMAL_APP_OK ${RENDERER}\n`);
