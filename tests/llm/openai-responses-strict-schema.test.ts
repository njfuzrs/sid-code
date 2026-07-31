/**
 * 回归测试：OpenAI Responses API strict 模式工具 schema 改造（2026-07-13 生产事故）
 *
 * 事故复盘：registry.ts 默认给内置工具打 `strict: true`（原为 Anthropic Constrained
 * Decoding 设计），buildResponsesRequest() 的 convertTools() 曾无条件透传该标记给
 * OpenAI Responses API。但 zod `.optional()` 字段转 JSON Schema 后不会出现在 required
 * 里，完全不满足 OpenAI strict 模式的硬性要求——strict 模式下所有字段都必须出现在
 * required 里，可选语义要改用 nullable 类型表达。结果任何带 optional 字段的工具一旦
 * 发给 GPT-5.x 系列模型就 400：
 *   `OpenAI Responses API HTTP 400: Invalid schema for function 'ask_user_question':
 *    In context=('properties','questions','items','properties','options','items'),
 *    'required' is required to be supplied`
 *
 * 修复：strict:true 时用 toStrictJsonSchema() 递归改造 parameters——
 *   1. 每个 object 节点 required 补全为 properties 全集
 *   2. 原 optional 字段（不在 required 里的）子 schema 转 nullable
 *   3. additionalProperties 兜底为 false
 *   4. 递归处理 properties / items / anyOf|oneOf|allOf，覆盖任意深度嵌套
 */
import { describe, test, expect } from "bun:test";
import { buildResponsesRequest } from "../../src/llm/openai-responses-request.ts";
import type { SendParams, ToolDefinition } from "../../src/llm/types.ts";

/** 递归断言：每个 object 节点的 required 等于 properties 全集，且 additionalProperties=false */
function collectStrictViolations(node: unknown, path: string): string[] {
  const errs: string[] = [];
  if (!node || typeof node !== "object") return errs;
  if (Array.isArray(node)) {
    node.forEach((n, i) => errs.push(...collectStrictViolations(n, `${path}[${i}]`)));
    return errs;
  }
  const obj = node as Record<string, unknown>;
  if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
    const propKeys = Object.keys(obj.properties as Record<string, unknown>).sort();
    const reqKeys = (Array.isArray(obj.required) ? (obj.required as string[]) : []).slice().sort();
    if (JSON.stringify(propKeys) !== JSON.stringify(reqKeys)) {
      errs.push(`${path}: required=[${reqKeys}] != properties=[${propKeys}]`);
    }
    if (obj.additionalProperties !== false) {
      errs.push(`${path}: additionalProperties=${JSON.stringify(obj.additionalProperties)} != false`);
    }
    for (const k of Object.keys(obj.properties as Record<string, unknown>)) {
      errs.push(...collectStrictViolations((obj.properties as Record<string, unknown>)[k], `${path}.${k}`));
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(obj[key])) {
      (obj[key] as unknown[]).forEach((n, i) => errs.push(...collectStrictViolations(n, `${path}.${key}[${i}]`)));
    }
  }
  if (obj.items !== undefined) errs.push(...collectStrictViolations(obj.items, `${path}.items`));
  return errs;
}

function baseParams(tools: ToolDefinition[]): SendParams {
  return {
    model: "gpt-5.4",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTokens: 1024,
    tools,
  };
}

describe("OpenAI Responses API strict 模式工具 schema 改造", () => {
  test("回归：ask_user_question 的两层嵌套 optional 字段（questions[].options[].preview）不再触发 400", () => {
    // 精简还原事故报错点的嵌套结构：questions[] -> options[] -> preview(optional)
    const askTool: ToolDefinition = {
      name: "ask_user_question",
      description: "ask the user",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                header: { type: "string" },
                multiSelect: { type: "boolean" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
                      preview: { type: "string" }, // ← 事故报错点：optional，不在 required 里
                    },
                    required: ["label", "description"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["question", "header", "options"], // multiSelect optional
              additionalProperties: false,
            },
          },
        },
        required: ["questions"],
        additionalProperties: false,
      },
    };

    const req = buildResponsesRequest(baseParams([askTool]), "gpt-5.4");
    expect(req.tools).toBeDefined();
    const toolDef = req.tools![0] as any;

    // strict 标记透传
    expect(toolDef.strict).toBe(true);

    // 事故报错点：options[] 的 required 现在应包含 preview（全集），preview 变 nullable
    const optionsItem = toolDef.parameters.properties.questions.items.properties.options.items;
    expect(optionsItem.required.slice().sort()).toEqual(["description", "label", "preview"]);
    expect(optionsItem.properties.preview.type).toEqual(["string", "null"]);

    // multiSelect 同样从 optional 转 nullable 并进 required
    const questionItem = toolDef.parameters.properties.questions.items;
    expect(questionItem.required).toContain("multiSelect");
    expect(questionItem.properties.multiSelect.type).toEqual(["boolean", "null"]);

    // 全树没有任何违反 strict 的节点
    const violations = collectStrictViolations(toolDef.parameters, "root");
    expect(violations).toEqual([]);
  });

  test("顶层 optional 字段（如 read 的 offset/limit）被补进 required 并转 nullable", () => {
    const readTool: ToolDefinition = {
      name: "read",
      description: "read a file",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["file_path"],
        additionalProperties: false,
      },
    };

    const req = buildResponsesRequest(baseParams([readTool]), "gpt-5.4");
    const params = (req.tools![0] as any).parameters;
    expect(params.required.slice().sort()).toEqual(["file_path", "limit", "offset"]);
    expect(params.properties.offset.type).toEqual(["number", "null"]);
    expect(params.properties.limit.type).toEqual(["number", "null"]);
    // 原 required 字段不受影响，保持非 null
    expect(params.properties.file_path.type).toBe("string");
    expect(collectStrictViolations(params, "root")).toEqual([]);
  });

  test("enum-only / 无简单 type 的 optional 字段整体包一层 anyOf 允许 null", () => {
    const tool: ToolDefinition = {
      name: "with_enum",
      description: "enum optional",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          required_field: { type: "string" },
          mode: { enum: ["fast", "slow"] }, // enum-only，无 type，optional
        },
        required: ["required_field"],
        additionalProperties: false,
      },
    };

    const req = buildResponsesRequest(baseParams([tool]), "gpt-5.4");
    const params = (req.tools![0] as any).parameters;
    expect(params.required.slice().sort()).toEqual(["mode", "required_field"]);
    // enum-only 走 anyOf 分支
    expect(params.properties.mode.anyOf).toBeDefined();
    expect(params.properties.mode.anyOf).toContainEqual({ type: "null" });
  });

  test("strict:false 时原样透传，不改造 schema（保持可选字段不进 required）", () => {
    const tool: ToolDefinition = {
      name: "loose_tool",
      description: "not strict",
      strict: false,
      input_schema: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "string" },
        },
        required: ["a"],
        additionalProperties: false,
      },
    };

    const req = buildResponsesRequest(baseParams([tool]), "gpt-5.4");
    const toolDef = req.tools![0] as any;
    expect(toolDef.strict).toBe(false);
    // strict:false → 不改造，required 保持原样（b 仍是 optional）
    expect(toolDef.parameters.required).toEqual(["a"]);
    expect(toolDef.parameters.properties.b.type).toBe("string");
  });

  test("未声明 strict 的工具（如 MCP）不透传 strict、不改造 schema", () => {
    const tool: ToolDefinition = {
      name: "mcp_tool",
      description: "mcp, no strict flag",
      input_schema: {
        type: "object",
        properties: { x: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
    };

    const req = buildResponsesRequest(baseParams([tool]), "gpt-5.4");
    const toolDef = req.tools![0] as any;
    expect(toolDef.strict).toBeUndefined();
    // 不改造：required 保持空
    expect(toolDef.parameters.required).toEqual([]);
  });

  test("已经是 [type,'null'] 数组的字段不重复追加 null", () => {
    const tool: ToolDefinition = {
      name: "already_nullable",
      description: "field already nullable",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          req: { type: "string" },
          opt: { type: ["string", "null"] }, // 已是可空数组，且 optional
        },
        required: ["req"],
        additionalProperties: false,
      },
    };

    const req = buildResponsesRequest(baseParams([tool]), "gpt-5.4");
    const params = (req.tools![0] as any).parameters;
    // 不应变成 ["string","null","null"]
    expect(params.properties.opt.type).toEqual(["string", "null"]);
    expect(params.required.slice().sort()).toEqual(["opt", "req"]);
  });

  // === strict 可行性自检：含「无约束任意值」字段的工具降级为非 strict（2026-07-14 复测发现）===
  describe("含 z.any()/z.unknown() 任意值字段的工具降级为非 strict", () => {
    test("回归：workflow 的 args（z.unknown → 空 schema {}）导致工具整体降级，不再触发 'must have a type key' 400", () => {
      // 事故复盘：修好 ask_user_question 的 optional 字段后，gpt-5.4 仍在 workflow 工具上 400——
      // 它的 args 字段是 z.unknown()（传给脚本的任意入参），zod 生成空 schema {}（无 type key）。
      // makeNullable 把它包成 anyOf:[{}, {type:"null"}]，那个 {} 分支仍无 type，被 OpenAI 拒：
      // `Invalid schema for function 'workflow': ... schema must have a 'type' key`。
      // 这类字段与 strict 模式互斥，正确做法是该工具整体降级为非 strict。
      const workflowTool: ToolDefinition = {
        name: "workflow",
        description: "run a workflow",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            script: { type: "string" },
            args: {}, // ← z.unknown() 生成的空 schema，无 type key
            budgetTotal: { type: "number" },
          },
          required: ["script"],
          additionalProperties: false,
        },
      };

      const req = buildResponsesRequest(baseParams([workflowTool]), "gpt-5.4");
      const toolDef = req.tools![0] as any;
      // 降级：strict 置 false
      expect(toolDef.strict).toBe(false);
      // 降级后发原始 schema（不改造，args 保持空对象、required 保持原样）
      expect(toolDef.parameters.properties.args).toEqual({});
      expect(toolDef.parameters.required).toEqual(["script"]);
    });

    test("嵌套在数组/对象深处的任意值字段同样触发整体降级", () => {
      const tool: ToolDefinition = {
        name: "nested_any",
        description: "any deep inside",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  payload: {}, // ← 深层任意值
                },
                required: ["name"],
                additionalProperties: false,
              },
            },
          },
          required: ["items"],
          additionalProperties: false,
        },
      };

      const req = buildResponsesRequest(baseParams([tool]), "gpt-5.4");
      expect((req.tools![0] as any).strict).toBe(false);
    });

    test("全字段都有确定 type 的工具不受影响，仍保持 strict 并被改造", () => {
      // 对照组：确保降级自检不误伤正常工具
      const tool: ToolDefinition = {
        name: "all_typed",
        description: "every field typed",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "number" }, // optional
          },
          required: ["a"],
          additionalProperties: false,
        },
      };

      const req = buildResponsesRequest(baseParams([tool]), "gpt-5.4");
      const toolDef = req.tools![0] as any;
      expect(toolDef.strict).toBe(true);
      expect(toolDef.parameters.required.slice().sort()).toEqual(["a", "b"]);
      expect(toolDef.parameters.properties.b.type).toEqual(["number", "null"]);
    });

    test("enum-only 字段（有 enum 约束，非无约束任意值）不触发降级", () => {
      // 边界：enum/const/$ref/组合器都算「有约束」，不是 z.any()，不应降级
      const tool: ToolDefinition = {
        name: "with_enum_optional",
        description: "enum optional field",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            required_field: { type: "string" },
            mode: { enum: ["fast", "slow"] }, // enum-only，有约束
          },
          required: ["required_field"],
          additionalProperties: false,
        },
      };

      const req = buildResponsesRequest(baseParams([tool]), "gpt-5.4");
      expect((req.tools![0] as any).strict).toBe(true);
    });
  });
});

/**
 * 回归：Responses API 的推理强度必须走**嵌套** `reasoning.effort`。
 *
 * Chat Completions 用顶层 `reasoning_effort`，Responses API 用嵌套 `reasoning.effort`——
 * 字段名与层级都不同。buildResponsesRequest 此前完全没有 reasoning 字段，导致 effort.ts
 * 即使解析出档位也发不出去（/effort 看着生效、线上其实静默丢弃）。
 *
 * [实测: uniapi 网关 /v1/responses — xhigh→reasoning_tokens=9、max→18、minimal→400]
 */
describe("Responses API 推理强度下发（reasoning.effort）", () => {
  function paramsWithEffort(effort: SendParams["reasoningEffort"]): SendParams {
    return {
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxTokens: 1024,
      reasoningEffort: effort,
    };
  }

  test("5 档全部原样进入 reasoning.effort（含 xhigh，不钳制）", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const req = buildResponsesRequest(paramsWithEffort(effort), "gpt-5.6-luna");
      expect(req.reasoning).toEqual({ effort });
    }
  });

  test("不下发顶层 reasoning_effort（那是 Chat Completions 的字段，此路径无效）", () => {
    const req = buildResponsesRequest(paramsWithEffort("high"), "gpt-5.6-luna");
    expect((req as unknown as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  test("auto（undefined）时不下发 reasoning，沿用服务端默认（实测 medium）", () => {
    const req = buildResponsesRequest(paramsWithEffort(undefined), "gpt-5.6-luna");
    expect(req.reasoning).toBeUndefined();
    expect("reasoning" in req).toBe(false);
  });
});
