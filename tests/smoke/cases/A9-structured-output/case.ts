/**
 * A9 结构化输出：`--json-schema` 下 StructuredOutput 校验 + stdout 的 `structured_output`。
 *
 * 期望来源：核心功能触发清单 A9 的人工实测（2026-11-05，会话 20261105-191223-24ebcb0d），
 * schema 原样取自那次录制：`{scripts: string[]}` + `additionalProperties:false`。
 *
 * 夹具两轮，各守一条接线：
 * - 第 1 轮带 schema 没声明的普通字段 `extra` → 必须被拒（`is_error=true`）并回喂让模型重试；
 * - 第 2 轮合法载荷 + 模型伪造的 `_agentId` → `stripInternalFields`（tool-executor.ts）在校验前剥掉，
 *   所以被接受，且 stdout 的 `structured_output` 里不能出现 `_agentId`。#588 修的正是内部字段
 *   漏进 StructuredOutput 校验那一类失败。
 *
 * 2026-11-07 第一版夹具在第 1 轮放的是 `_agentId`，以为会被拒，实测被接受——它在校验前就被剥掉了。
 * 这说明代码是对的、期望写错了，所以改夹具而不是改断言。
 */
import { STRUCTURED_OUTPUT_TOOL_NAME } from "@sid-code/core/tool/structured-output-tool.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { SmokeCase } from "../../lib/types.ts";

const SCHEMA = {
  type: "object",
  properties: { scripts: { type: "array", items: { type: "string" } } },
  required: ["scripts"],
  additionalProperties: false,
};

const def: SmokeCase = {
  id: "A9-structured-output",
  ledger: "A9",
  feature: "结构化输出",
  kind: "guard",
  repo: { "package.json": JSON.stringify({ scripts: { build: "x", test: "y" } }) },
  argv: ["--json-schema", JSON.stringify(SCHEMA), "-p", "列出 package.json 的脚本名"],
  expect: {
    events: [
      {
        event: HookEventName.PostToolUse,
        where: { tool_name: STRUCTURED_OUTPUT_TOOL_NAME, is_error: true },
        count: 1,
      },
      {
        event: HookEventName.PostToolUse,
        where: { tool_name: STRUCTURED_OUTPUT_TOOL_NAME, is_error: false },
        count: 1,
      },
    ],
    output: ({ stdout }) => {
      const so = (stdout as any)?.structured_output;
      const want = JSON.stringify({ scripts: ["build", "test"] });
      return JSON.stringify(so) === want
        ? null
        : `structured_output 期望 ${want}，实际 ${JSON.stringify(so)}`;
    },
  },
  mutations: [
    {
      file: "packages/core/src/tool/structured-output-tool.ts",
      find: "if (!result.valid) {",
      replace: "if (false) {",
      why: "schema 校验失效，多余字段的载荷被当成合法结果",
    },
    {
      file: "packages/core/src/tool/internal-fields.ts",
      find: '  "_agentId",\n',
      replace: "",
      why: "内部字段剥离漏掉 _agentId，模型伪造的字段进入 schema 校验",
    },
  ],
};

export default def;
