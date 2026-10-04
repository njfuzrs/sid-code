#!/usr/bin/env bun
/**
 * 从旧底座生成屏幕缓冲的测试向量（B9 / T3.1，契约 R3 / R9 / T3 / T4）。
 *
 * 语料在 packages/tui/tests/fixtures/screen-corpus.ts（纯数据，不 import 底座）。
 * 每条语料在旧底座的 TTY 路径上挂载一次，记下**首帧**写出的字节（去掉同步输出与隐藏光标）——
 * 首帧前一帧为空，旧底座此时把整屏逐行画出来，正好是屏幕缓冲序列化的口径。
 * 新底座的测试只读向量，不 import 旧底座（设计文档 D-5）；T9 删旧底座后测试照样能跑。
 *
 * 用法：
 *   bun run tui:screen-vectors          # 重新生成 packages/tui/tests/fixtures/screen-vectors.json
 *   bun run tui:screen-vectors --check  # 只比对，不一致退 1
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CORPUS_ENVS, cleanEnv } from "../packages/tui/tests/fixtures/screen-corpus.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "packages/tui/tests/fixtures/screen-vectors.json");
const COLS = 30;

// 子进程：环境相关的判定（bidi、OSC 终止符、颜色级别）都在模块加载时做，每组环境一个进程
const CHILD = `
import React from "react";
import { PassThrough } from "node:stream";
const { CORPUS_ENVS, buildTree } = await import(${JSON.stringify(join(ROOT, "packages/tui/tests/fixtures/screen-corpus.ts"))});
const { Box, Text } = await import(${JSON.stringify(join(ROOT, "packages/cli/src/ui/render-port/components.ts"))});
const { renderSync } = await import(${JSON.stringify(join(ROOT, "packages/cli/src/ui/render-port/testing.ts"))});
const out = {};
for (const c of CORPUS_ENVS[process.env.GROUP].cases) {
  const stdout = new PassThrough();
  Object.assign(stdout, { columns: c.cols ?? ${COLS}, rows: 40, isTTY: true });
  let buf = "";
  stdout.on("data", (d) => { buf += d.toString(); });
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, isRaw: false, setRawMode() { return stdin; }, ref: () => stdin, unref: () => stdin });
  const inst = renderSync(buildTree(React, Box, Text, c.node), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await new Promise((r) => setTimeout(r, 40));
  // 首帧：第一个同步输出块的内容
  const m = /\\x1b\\[\\?2026h([\\s\\S]*?)\\x1b\\[\\?2026l/.exec(buf);
  out[c.name] = m ? m[1].replace(/\\x1b\\[\\?25[lh]/g, "") : "";
  stdout.isTTY = false; // 卸载时不 writeSync(1) 写进本进程 stdout（契约 X3）
  inst.unmount();
}
process.stdout.write("\\n@@" + JSON.stringify(out));
process.exit(0);
`;

function generate() {
  const childPath = join(ROOT, "scripts/.tui-screen-vectors.child.tmp.ts");
  writeFileSync(childPath, CHILD);
  try {
    const groups: Record<
      string,
      { env: Record<string, string>; cols: number; frames: Record<string, string> }
    > = {};
    for (const [group, { env }] of Object.entries(CORPUS_ENVS)) {
      const r = Bun.spawnSync([process.execPath, childPath], {
        cwd: ROOT,
        env: { ...cleanEnv(env), GROUP: group, SID_TUI_RENDERER: "legacy" },
      });
      const s = r.stdout.toString();
      const at = s.lastIndexOf("\n@@");
      if (r.exitCode !== 0 || at < 0)
        throw new Error(`旧底座子进程失败（${group}）：${r.stderr.toString().slice(-2000)}`);
      groups[group] = { env, cols: COLS, frames: JSON.parse(s.slice(at + 3)) };
    }
    return { generatedBy: "scripts/tui-screen-vectors.ts", groups };
  } finally {
    Bun.spawnSync(["rm", "-f", childPath]);
  }
}

const vectors = JSON.stringify(generate(), null, 2) + "\n";
if (process.argv.includes("--check")) {
  const old = readFileSync(OUT, "utf8");
  if (old !== vectors) {
    console.error("screen-vectors.json 与旧底座当前输出不一致：语料改了没重生成，或旧底座行为变了");
    process.exit(1);
  }
  console.log("screen-vectors.json 一致");
} else {
  writeFileSync(OUT, vectors);
  const n = Object.values(JSON.parse(vectors).groups as Record<string, { frames: object }>).reduce(
    (a, g) => a + Object.keys(g.frames).length,
    0,
  );
  console.log(`写入 ${OUT}（${n} 条）`);
}
