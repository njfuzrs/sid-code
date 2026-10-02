/**
 * B19：把 `website/extend/workflows.md` 里的完整脚本示例当测试夹具真跑一遍。
 *
 * 为什么要这个测试：手写页没有门禁，但**示例脚本是可执行的**，能被机械验证。
 * 十三次审阅实测过两类「照抄就坏」的示例，且都没有任何东西在跑它：
 *   - D56：`meta.phases` 写成字符串数组 → `parseAndValidateMeta` 直接拒绝，脚本一步都跑不了
 *   - D58：示例 schema 漏了根层 `type/properties` → 校验器对任何值都 `valid:true`，零报错
 *
 * 这里锁住三件事（每件都对应一种已发生的失败形态）：
 *   ① 每个 javascript 代码块都能过 meta 校验，并在 stub 运行时下跑完不抛错
 *   ② 示例里出现的每个 schema 都过 `checkSchemaShape`
 *   ③ 每个 schema 真的在约束东西：一个明显不对的值（字符串 "hello"）必须被拒
 *
 * stub 不调模型：agent() 带 schema 时按 schema 合成一个最小合规值返回，
 * 不带 schema 时返回一个空对象，足以让示例里的后续步骤（`.dirs`、`.issues?.length`）跑通。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAndValidateMeta, runInSandbox } from "@sid-code/core/workflow/sandbox.ts";
import {
  checkSchemaShape,
  validateAgainstSchema,
} from "@sid-code/core/workflow/json-schema-validator.ts";
import type { AgentOpts, WorkflowApi } from "@sid-code/core/workflow/types.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const DOC = resolve(ROOT, "website/extend/workflows.md");

/** 抽出文档里所有 ```javascript / ```js 代码块 */
function extractJsBlocks(md: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:javascript|js)\n([\s\S]*?)```/g;
  for (const m of md.matchAll(re)) blocks.push(m[1]!);
  return blocks;
}

/** 按 schema 合成一个最小合规值（只覆盖示例会用到的形态） */
function synthesize(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, synthesize(v)]));
    }
    case "array":
      return schema.items ? [synthesize(schema.items as Record<string, unknown>)] : [];
    case "string":
      return "stub";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return {};
  }
}

/** stub 运行时：记录 agent 收到的 schema，pipeline/parallel 按真实语义执行 */
function makeStubApi(): { api: WorkflowApi; schemas: Record<string, unknown>[] } {
  const schemas: Record<string, unknown>[] = [];
  const api: WorkflowApi = {
    agent: async (_prompt: string, opts?: AgentOpts) => {
      const schema = opts?.schema as Record<string, unknown> | undefined;
      if (schema) {
        schemas.push(schema);
        return synthesize(schema);
      }
      return {};
    },
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    pipeline: async (items, ...stages) =>
      Promise.all(
        items.map(async (item, i) => {
          let acc: unknown = item;
          for (const stage of stages) acc = await stage(acc, item, i);
          return acc;
        }),
      ),
    phase: () => {},
    log: () => {},
    args: undefined,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
  };
  return { api, schemas };
}

const blocks = extractJsBlocks(readFileSync(DOC, "utf8"));

describe("B19 · workflows.md 示例脚本可执行", () => {
  test("文档里至少有一个完整脚本示例（抽取本身没失效）", () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  blocks.forEach((src, i) => {
    test(`代码块 #${i + 1}：meta 校验通过（防 D56）`, () => {
      expect(parseAndValidateMeta(src)).toMatchObject({ ok: true });
    });

    test(`代码块 #${i + 1}：stub 运行时下跑完，schema 合法且真的在约束（防 D58）`, async () => {
      const { api, schemas } = makeStubApi();
      await runInSandbox(src, api);
      for (const schema of schemas) {
        expect(checkSchemaShape(schema)).toBe(null);
        // 一个对象 schema 不该接受裸字符串；接受了就说明它什么都没约束
        expect(validateAgainstSchema(schema, "hello").valid).toBe(false);
      }
    });
  });
});
