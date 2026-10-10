#!/usr/bin/env bun
/**
 * 从旧底座生成帧间增量的测试向量（B9 / T3.2–T3.3，契约 R1 / R3–R8 / R10 / R12）。
 *
 * 语料在 packages/tui/tests/fixtures/frame-corpus.ts（纯数据），驱动在 frame-drive.tsx（不 import 底座）。
 * 这里把端口的 legacy 实现注入驱动，逐帧记下 TTY 路径写出的字节与 onFrame 的 full reset 原因。
 * 新底座的测试只读向量（设计文档 D-5）；T9 删旧底座后测试照样能跑。
 *
 * 用法：
 *   bun run tui:frame-vectors          # 重新生成 packages/tui/tests/fixtures/frame-vectors.json
 *   bun run tui:frame-vectors --check  # 只比对，不一致退 1
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "packages/tui/tests/fixtures/frame-vectors.json");

// 子进程：端口按 SID_TUI_RENDERER 在模块加载时选实现，测试环境同步出帧（R13）
const CHILD = `
import React from "react";
const { FRAME_CORPUS } = await import(${JSON.stringify(join(ROOT, "packages/tui/tests/fixtures/frame-corpus.ts"))});
const { driveFrames } = await import(${JSON.stringify(join(ROOT, "packages/tui/tests/fixtures/frame-drive.tsx"))});
const { Box, Text } = await import(${JSON.stringify(join(ROOT, "packages/cli/src/ui/render-port/components.ts"))});
const { renderSync } = await import(${JSON.stringify(join(ROOT, "packages/cli/src/ui/render-port/testing.ts"))});
const { getRenderInstance: instanceOf } = await import(${JSON.stringify(join(ROOT, "packages/cli/src/ui/render-port/runtime.ts"))});
const out = {};
for (const c of FRAME_CORPUS) out[c.name] = await driveFrames({ React, Box, Text, renderSync, instanceOf }, c);
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;

const r = Bun.spawnSync(["bun", "-e", CHILD], {
  cwd: ROOT,
  env: { ...process.env, SID_TUI_RENDERER: "legacy", NODE_ENV: "test" },
});
if (r.exitCode !== 0) {
  process.stderr.write(r.stderr.toString());
  process.exit(1);
}
const next = JSON.stringify(JSON.parse(r.stdout.toString()), null, 2) + "\n";

if (process.argv.includes("--check")) {
  // 比内容不比排版：入库文件经 oxfmt 格式化，与 JSON.stringify 的换行不同
  const current = JSON.stringify(JSON.parse(readFileSync(OUT, "utf8")));
  if (current !== JSON.stringify(JSON.parse(next))) {
    console.error("frame-vectors.json 已过期：运行 bun run tui:frame-vectors 重新生成");
    process.exit(1);
  }
  console.log("frame-vectors.json 与旧底座一致");
} else {
  writeFileSync(OUT, next);
  console.log(`写入 ${Object.keys(JSON.parse(next)).length} 条 → ${OUT}`);
}
