// B9 / T3.1：屏幕缓冲对拍的子进程探针。按 GROUP 取语料，用新底座渲染并序列化，输出 JSON。
// 子进程是必须的：bidi / OSC 终止符 / 颜色级别都在模块加载时按环境判定。
import React from "react";
import { CORPUS_ENVS, buildTree } from "./screen-corpus.ts";
import { Box, Text } from "../../src/index.ts";
import { renderToScreen } from "../../src/render-to-string.ts";
import { serializeScreen } from "../../src/screen/index.ts";

const out: Record<string, string> = {};
for (const c of CORPUS_ENVS[process.env.GROUP!]!.cases) {
  out[c.name] = serializeScreen(
    renderToScreen(buildTree(React, Box, Text, c.node), { columns: c.cols ?? 30 }),
  );
}
process.stdout.write(JSON.stringify(out));
