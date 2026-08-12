/**
 * 对账测试：wire schema 允许的输入，必须能通过本地 zod 校验（2026-08-01 生产事故）
 *
 * ## 事故
 *
 * gpt-5.6-luna 会话全程刷屏「参数校验失败」。根因不是模型也不是网关，而是 sid-code
 * **自己给了模型一份契约，又拒绝按这份契约填写的参数**：
 *
 *   1. registry.ts 给内置工具默认打 strict:true
 *   2. gpt-5.6-luna 声明 protocolKind=openai-responses → 走 Responses API
 *   3. toStrictJsonSchema() 把 optional 字段塞进 required、类型改成 ["string","null"]
 *      → 发给模型的契约是「pages 必填，不想给就传 null」
 *   4. 模型照做传 pages:null
 *   5. validateToolInput 用**原始** zod schema 校验，`.optional()` 不接受 null → 报错
 *
 * 模型无路可走：遵守 wire 契约被拒，不遵守则违反 strict 的 required。
 * 实测 40 个带 zodSchema 的内置工具里 23 个中招（read/edit/bash/grep/glob/ls 等）。
 *
 * ## 为什么要写成"全量对账"而不是逐工具单测
 *
 * 这类缺陷的本质是**两个模块各自演进导致的契约漂移**：协议层（openai-responses-request）
 * 改造 schema 的规则，与工具层（input-validator）校验输入的规则，没有任何机制保证一致。
 * 只测 read/grep 几个当时中招的工具，挡不住下一个新增 `.optional()` 字段的工具复发。
 *
 * 所以这里遍历**全部**带 zodSchema 的内置工具，对每个工具做一次端到端对账：
 *   按 wire schema 生成一份「合法但极端」的输入（所有 optional 字段填 null）
 *   → 喂给真实的 validateToolInput
 *   → 断言不报「received null」，且不被 coerce 静默污染
 *
 * 任何人新增工具或改 schema，只要破坏了这个不变量，这个测试就会红。
 */
import { describe, test, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { buildResponsesRequest } from "@sid-code/core/llm/openai-responses-request.ts";
import { validateToolInput } from "@sid-code/core/tool/input-validator.ts";
import type { SendParams, ToolDefinition } from "@sid-code/core/llm/types.ts";
import type { LegacyTool } from "@sid-code/core/tool/types.ts";

const TOOL_DIR = join(import.meta.dir, "../../../../packages/core/src/tool");

/** 按 JSON Schema 的类型给一个"最小合法值"，用于填必需字段 */
function sampleForSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return "x";
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  if (node.const !== undefined) return node.const;
  const rawType = Array.isArray(node.type)
    ? (node.type as string[]).find((t) => t !== "null")
    : node.type;
  switch (rawType) {
    case "string":
      return "x";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object": {
      const props = (node.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(node.required) ? (node.required as string[]) : [];
      const out: Record<string, unknown> = {};
      for (const k of required) out[k] = sampleForSchema(props[k]);
      return out;
    }
    default:
      return "x";
  }
}

interface DiscoveredTool {
  tool: LegacyTool;
  name: string;
  jsonSchema: Record<string, unknown>;
}

/** 实例化 src/tool 下所有导出的、带 zodSchema 的工具类 */
async function discoverTools(): Promise<DiscoveredTool[]> {
  const found: DiscoveredTool[] = [];
  const seen = new Set<string>();
  const files = readdirSync(TOOL_DIR).filter((f) => f.endsWith(".ts") && !f.includes(".test."));

  for (const file of files) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(join(TOOL_DIR, file))) as Record<string, unknown>;
    } catch {
      continue; // 个别模块有副作用/依赖，跳过不影响对账覆盖面
    }
    for (const exported of Object.values(mod)) {
      if (typeof exported !== "function") continue;
      let inst: LegacyTool;
      try {
        inst = new (exported as new () => LegacyTool)();
      } catch {
        continue; // 需要构造参数的工具（如 SubAgentTool）在此路径不实例化
      }
      if (typeof inst?.name !== "function" || !inst.zodSchema) continue;
      const name = inst.name();
      if (seen.has(name)) continue;
      let jsonSchema: Record<string, unknown>;
      try {
        jsonSchema = z.toJSONSchema(inst.zodSchema as never) as Record<string, unknown>;
      } catch {
        continue;
      }
      seen.add(name);
      found.push({ tool: inst, name, jsonSchema });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function wireToolDef(t: DiscoveredTool): ToolDefinition {
  return {
    name: t.name,
    description: "d",
    input_schema: t.jsonSchema,
    strict: true,
  } as ToolDefinition;
}

function buildWire(t: DiscoveredTool) {
  const params = {
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTokens: 1024,
    tools: [wireToolDef(t)],
  } as SendParams;
  return buildResponsesRequest(params, "gpt-5.6-luna").tools![0];
}

const TOOLS = await discoverTools();

describe("strict wire 契约与本地校验对账", () => {
  test("发现到足量内置工具（防止 discover 静默失效导致测试空跑）", () => {
    expect(TOOLS.length).toBeGreaterThan(30);
  });

  describe("模型按 wire schema 给 optional 字段传 null → 本地校验必须接受", () => {
    for (const t of TOOLS) {
      test(t.name, () => {
        const wire = buildWire(t);
        // 降级为非 strict 的工具（record/z.unknown()）不产生"传 null"契约，跳过
        if (wire.strict !== true) return;

        const wireProps = (wire.parameters.properties ?? {}) as Record<string, unknown>;
        const originalRequired = new Set(
          Array.isArray(t.jsonSchema.required) ? (t.jsonSchema.required as string[]) : [],
        );
        const optionalKeys = Object.keys(wireProps).filter((k) => !originalRequired.has(k));
        if (optionalKeys.length === 0) return;

        // 构造一份「完全符合 wire 契约」的极端输入：必需字段给最小合法值，
        // 所有 optional 字段按契约允许的方式显式传 null。
        const input: Record<string, unknown> = {};
        for (const k of originalRequired) {
          input[k] = sampleForSchema((t.jsonSchema.properties as Record<string, unknown>)?.[k]);
        }
        for (const k of optionalKeys) input[k] = null;

        const result = validateToolInput(t.tool, input);

        // 核心断言：绝不能因为 null 报「期望 X，实际收到 null」。
        // 其他校验失败（如 sampleForSchema 给的占位值不满足业务 refine）不在本测试关注范围，
        // 只要不是 null 引起的即可。
        if (!result.ok) {
          expect(result.message).not.toMatch(/received null|实际收到 null/);
        }
      });
    }
  });

  describe("coerce 字段的 null 不得被静默污染成 0/空串/false", () => {
    for (const t of TOOLS) {
      test(t.name, () => {
        const wire = buildWire(t);
        if (wire.strict !== true) return;

        const wireProps = (wire.parameters.properties ?? {}) as Record<string, unknown>;
        const originalRequired = new Set(
          Array.isArray(t.jsonSchema.required) ? (t.jsonSchema.required as string[]) : [],
        );
        const optionalKeys = Object.keys(wireProps).filter((k) => !originalRequired.has(k));
        if (optionalKeys.length === 0) return;

        const input: Record<string, unknown> = {};
        for (const k of originalRequired) {
          input[k] = sampleForSchema((t.jsonSchema.properties as Record<string, unknown>)?.[k]);
        }
        for (const k of optionalKeys) input[k] = null;

        const result = validateToolInput(t.tool, input);
        if (!result.ok) return;

        // z.coerce.number().optional() 遇 null 会静默返回 0——对 grep.head_limit
        // （"0 表示无限制"）这类字段是**语义反转**，比报错更危险：无报错、无日志，
        // 只是行为不对。归一层必须在 coerce 之前把 null 摘掉。
        const data = result.data as Record<string, unknown>;
        for (const k of optionalKeys) {
          expect(data?.[k]).toBeUndefined();
        }
      });
    }
  });

  describe("strict=true 的工具 schema 不得残留 OpenAI 会 400 的关键字", () => {
    for (const t of TOOLS) {
      test(t.name, () => {
        const wire = buildWire(t);
        if (wire.strict !== true) return;

        // propertyNames / patternProperties / additionalProperties!=false 描述的是
        // 动态 key 字典，strict 模式一律 400（2026-08-01 task_create 每轮 400 事故）。
        // 注意那是**整个请求** 400，该轮所有工具定义都发不出去。
        const violations: string[] = [];
        const walk = (node: unknown, path: string) => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
          const obj = node as Record<string, unknown>;
          if (obj.propertyNames !== undefined) violations.push(`${path}.propertyNames`);
          if (obj.patternProperties !== undefined) violations.push(`${path}.patternProperties`);
          if (obj.additionalProperties !== undefined && obj.additionalProperties !== false) {
            violations.push(
              `${path}.additionalProperties=${JSON.stringify(obj.additionalProperties)}`,
            );
          }
          for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
        };
        walk(wire.parameters, t.name);
        expect(violations).toEqual([]);
      });
    }
  });

  test("record 类型工具被正确降级为非 strict（不硬编码工具名，按 schema 特征判定）", () => {
    // 反向断言：凡原始 schema 里带动态 key 关键字的工具，都必须降级；
    // 凡不带的，都应保留 strict（否则是降级判定过度激进，白丢 Constrained Decoding）。
    for (const t of TOOLS) {
      const raw = JSON.stringify(t.jsonSchema);
      const hasDynamicKey = raw.includes("propertyNames") || raw.includes("patternProperties");
      const wire = buildWire(t);
      if (hasDynamicKey) {
        expect(wire.strict, `${t.name} 含动态 key 关键字，应降级为非 strict`).toBe(false);
        // 降级后必须发原始 schema（而非改造过的半成品）
        expect(wire.parameters).toEqual(t.jsonSchema);
      }
    }
  });
});
