/**
 * Dynamic Workflows M2 — 轻量 JSON Schema 校验器
 *
 * 为什么自研而非 Ajv:
 *  - 项目约定不引 Ajv;且 Ajv 未安装。
 *  - workflow 脚本跑在 vm 沙箱里(无 import),作者只能传**纯 JSON Schema 对象**(POJO)给
 *    agent({schema})。我们要拿这个 POJO 去校验子代理的结构化输出——方向是
 *    "用 schema 验数据",不是 zod 的 "schema→JSON Schema"。
 *  - workflow schema 用到的子集很窄(object/array/string/number/integer/boolean/enum/
 *    required/嵌套/$ref→$defs/const/nullable/allOf/anyOf/oneOf/not/if-then-else),
 *    自己写一个精确、可测、零依赖的就够。
 *
 * 对标 cc 的 Ajv 错误风格:返回 `instancePath: message` 列表,回喂给子代理让它重试。
 *
 * 不实现的**约束类**关键字(patternProperties/uniqueItems/…)由 checkSchemaShape **明确拒绝**,
 * 不再「安静忽略」:schema 的用途是逼子代理举证,写了约束却静默放行 = 伪阳性照样进结果集,
 * 而作者无从得知。拒绝发生在 shape 阶段,走 StructuredOutput 的「作者的错,不可重试」分支。
 * 注解类关键字(title/description/format/…)本来就不约束数据,继续放行。
 *
 * 校验器本身**不许抛异常**:循环 $ref 报校验错误、pattern 在 vm 里限时跑。
 * 三个调用方(StructuredOutput 工具 / SDK 文本提取 / 子代理文本兜底)都假设它只返回结果。
 */

import vm from "node:vm";

/** 单条校验错误 */
export interface SchemaError {
  /** JSON Pointer 风格路径,如 `/bugs/0/severity`;根为 `root` */
  path: string;
  /** 人类可读的错误信息 */
  message: string;
}

export type ValidateResult = { valid: true } | { valid: false; errors: SchemaError[] };

type Schema = Record<string, unknown>;

/** 取 JSON 类型名(对齐 JSON Schema 的 type 取值) */
function jsonTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // string | number | boolean | object | undefined | function | symbol | bigint
}

/** 解析 $ref(仅支持 `#/$defs/Name` 与 `#/definitions/Name` 本地引用) */
function resolveRef(ref: string, root: Schema): Schema | null {
  if (!ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let cur: unknown = root;
  for (const p of parts) {
    // JSON Pointer 转义还原
    const key = p.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof cur !== "object" || cur === null) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "object" && cur !== null ? (cur as Schema) : null;
}

/** 拼接子路径 */
function joinPath(base: string, key: string | number): string {
  if (base === "root") return `/${key}`;
  return `${base}/${key}`;
}

/** 无数据下降时的展开深度兜底(正常 schema 远到不了;只防 refStack 覆盖不到的病态结构) */
const MAX_SAME_VALUE_DEPTH = 64;

/** pattern 单次执行上限。Bun 单线程,灾难性回溯会把整个进程同步卡死 */
const PATTERN_TIMEOUT_MS = 100;

/** 复用一个空 context:每次 createContext 的开销比 test 本身大两个数量级 */
let patternContext: vm.Context | null = null;

/**
 * 限时跑 `new RegExp(pattern).test(str)`。
 * 为什么不在宿主直接 test:schema 与被测字符串都由 LLM 写,`^(a+)+$` 配 30 个 a 即 248ms、
 * 每多一个字符翻倍;workflow 沙箱的 vm timeout 只掐脚本同步段,管不到跑在宿主的校验器。
 * @returns true/false = 匹配结果;"timeout" = 超时;"invalid" = 非法正则
 */
function testPattern(pattern: string, str: string): boolean | "timeout" | "invalid" {
  try {
    new RegExp(pattern);
  } catch {
    return "invalid";
  }
  patternContext ??= vm.createContext(Object.create(null));
  patternContext.__p = pattern;
  patternContext.__s = str;
  try {
    return vm.runInContext("new RegExp(__p).test(__s)", patternContext, {
      timeout: PATTERN_TIMEOUT_MS,
    }) as boolean;
  } catch {
    return "timeout";
  } finally {
    patternContext.__p = undefined;
    patternContext.__s = undefined;
  }
}

/** 用独立错误列表校验子 schema(组合关键字要先判「过没过」再决定报什么) */
function collect(
  schema: Schema,
  value: unknown,
  path: string,
  root: Schema,
  refStack: string[],
): SchemaError[] {
  const errs: SchemaError[] = [];
  validateNode(schema, value, path, root, errs, refStack);
  return errs;
}

/**
 * 递归校验。把错误累加进 errors。
 * @param schema   当前层 schema
 * @param value    当前层数据
 * @param path     当前路径(用于错误信息)
 * @param root     根 schema(解析 $ref 用)
 * @param refStack 自上次「下降到子数据」以来展开过的 $ref。
 *                 $ref 与组合关键字都不消耗数据层级,`A→B→A` 会在同一个 value 上无限递归;
 *                 下降到 properties/items 时清空,所以 `Node.child → Node` 这种合法递归不受影响。
 */
function validateNode(
  schema: Schema,
  value: unknown,
  path: string,
  root: Schema,
  errors: SchemaError[],
  refStack: string[] = [],
): void {
  if (typeof schema !== "object" || schema === null) return;
  if (refStack.length > MAX_SAME_VALUE_DEPTH) {
    errors.push({ path, message: `schema 展开过深(疑似循环引用)` });
    return;
  }

  // $ref 解引用(先处理,展开后继续)
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (refStack.includes(ref)) {
      errors.push({
        path,
        message: `schema 存在循环 $ref: ${[...refStack, ref].join(" → ")}`,
      });
      return;
    }
    const resolved = resolveRef(ref, root);
    if (resolved) {
      validateNode(resolved, value, path, root, errors, [...refStack, ref]);
      return;
    }
    // 解不出的 ref:checkSchemaShape 会在 shape 阶段拒绝;直调校验器时保持宽松
    return;
  }

  // 组合关键字:都作用在同一个 value 上,沿用 refStack
  // 组合分支内部的 $ref 需要单独计数,用一个哨兵占位防止 allOf 自指的纯组合环
  const same = [...refStack, "<combinator>"];
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as Schema[]) {
      validateNode(sub, value, path, root, errors, same);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = (schema.anyOf as Schema[]).map((sub) => collect(sub, value, path, root, same));
    if (!branches.some((e) => e.length === 0)) {
      errors.push({ path, message: `不满足 anyOf 的任一分支(${summarize(branches)})` });
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = (schema.oneOf as Schema[]).map((sub) => collect(sub, value, path, root, same));
    const passed = branches.filter((e) => e.length === 0).length;
    if (passed === 0) {
      errors.push({ path, message: `不满足 oneOf 的任一分支(${summarize(branches)})` });
    } else if (passed > 1) {
      errors.push({ path, message: `同时满足 oneOf 的 ${passed} 个分支,应恰好满足 1 个` });
    }
  }
  if (typeof schema.not === "object" && schema.not !== null) {
    if (collect(schema.not as Schema, value, path, root, same).length === 0) {
      errors.push({ path, message: `不应满足 not 子 schema` });
    }
  }
  if (typeof schema.if === "object" && schema.if !== null) {
    const ifPassed = collect(schema.if as Schema, value, path, root, same).length === 0;
    const branch = ifPassed ? schema.then : schema.else;
    if (typeof branch === "object" && branch !== null) {
      validateNode(branch as Schema, value, path, root, errors, same);
    }
  }

  // const
  if ("const" in schema) {
    if (!deepEqual(value, schema.const)) {
      errors.push({ path, message: `应等于常量 ${JSON.stringify(schema.const)}` });
    }
  }

  // enum
  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some((e) => deepEqual(e, value));
    if (!ok) {
      errors.push({
        path,
        message: `应为枚举值之一: ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`,
      });
    }
  }

  // type(支持单个或数组;支持 nullable 习惯:type 含 "null")
  const declaredType = schema.type;
  if (declaredType !== undefined) {
    const allowed = Array.isArray(declaredType) ? declaredType : [declaredType];
    const actual = jsonTypeOf(value);
    // JSON Schema:integer 是 number 的子集
    const matches = allowed.some((t) => {
      if (t === "integer") return actual === "number" && Number.isInteger(value as number);
      if (t === "number") return actual === "number";
      return t === actual;
    });
    if (!matches) {
      errors.push({
        path,
        message: `类型应为 ${allowed.join("|")},实际为 ${actual}`,
      });
      // 类型不符时不再深入子约束(避免误报一堆)
      return;
    }
  }

  const actualType = jsonTypeOf(value);

  // object 约束
  if (actualType === "object") {
    const obj = value as Record<string, unknown>;
    // required
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) {
          errors.push({ path: joinPath(path, key), message: `缺少必填字段 ${key}` });
        }
      }
    }
    // properties
    const props = schema.properties as Record<string, Schema> | undefined;
    if (props) {
      for (const [key, subSchema] of Object.entries(props)) {
        if (key in obj) {
          validateNode(subSchema, obj[key], joinPath(path, key), root, errors);
        }
      }
    }
    // additionalProperties === false:多出来的键报错。
    // 没写 properties 时语义是「必须是空对象」,不能因为 props 缺失就整条跳过
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!props || !(key in props)) {
          errors.push({ path: joinPath(path, key), message: `不允许的额外字段 ${key}` });
        }
      }
    }
    // additionalProperties 为子 schema:校验所有非 props 的值
    if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
      const addSchema = schema.additionalProperties as Schema;
      for (const [key, v] of Object.entries(obj)) {
        if (!props || !(key in props)) {
          validateNode(addSchema, v, joinPath(path, key), root, errors);
        }
      }
    }
  }

  // array 约束
  if (actualType === "array") {
    const arr = value as unknown[];
    if (typeof schema.minItems === "number" && arr.length < schema.minItems) {
      errors.push({ path, message: `数组至少 ${schema.minItems} 项,实际 ${arr.length}` });
    }
    if (typeof schema.maxItems === "number" && arr.length > schema.maxItems) {
      errors.push({ path, message: `数组至多 ${schema.maxItems} 项,实际 ${arr.length}` });
    }
    // items 为单个 schema:逐项校验
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      const itemSchema = schema.items as Schema;
      arr.forEach((item, i) => {
        validateNode(itemSchema, item, joinPath(path, i), root, errors);
      });
    }
  }

  // string 约束
  if (actualType === "string") {
    const str = value as string;
    if (typeof schema.minLength === "number" && str.length < schema.minLength) {
      errors.push({ path, message: `字符串至少 ${schema.minLength} 字符` });
    }
    if (typeof schema.maxLength === "number" && str.length > schema.maxLength) {
      errors.push({ path, message: `字符串至多 ${schema.maxLength} 字符` });
    }
    if (typeof schema.pattern === "string") {
      const r = testPattern(schema.pattern, str);
      if (r === false) {
        errors.push({ path, message: `不匹配正则 ${schema.pattern}` });
      } else if (r === "timeout") {
        errors.push({
          path,
          message: `正则 ${schema.pattern} 执行超过 ${PATTERN_TIMEOUT_MS}ms(疑似灾难性回溯)`,
        });
      }
      // "invalid":checkSchemaShape 会在 shape 阶段拒绝;直调校验器时保持宽松
    }
  }

  // number 约束
  if (actualType === "number") {
    const num = value as number;
    if (typeof schema.minimum === "number" && num < schema.minimum) {
      errors.push({ path, message: `应 ≥ ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && num > schema.maximum) {
      errors.push({ path, message: `应 ≤ ${schema.maximum}` });
    }
    if (typeof schema.exclusiveMinimum === "number" && num <= schema.exclusiveMinimum) {
      errors.push({ path, message: `应 > ${schema.exclusiveMinimum}` });
    }
    if (typeof schema.exclusiveMaximum === "number" && num >= schema.exclusiveMaximum) {
      errors.push({ path, message: `应 < ${schema.exclusiveMaximum}` });
    }
  }
}

/** 组合分支失败原因摘要:每个分支只取第一条,避免错误串爆长 */
function summarize(branches: SchemaError[][]): string {
  return branches
    .map((e, i) => `#${i}: ${e[0] ? `${e[0].path} ${e[0].message}` : "通过"}`)
    .join("; ");
}

/** 深相等(用于 enum/const 比较) */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/**
 * 用 JSON Schema 校验数据。
 * @returns { valid: true } 或 { valid: false, errors }
 */
export function validateAgainstSchema(schema: Schema, value: unknown): ValidateResult {
  const errors: SchemaError[] = [];
  validateNode(schema, value, "root", schema, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/** 把错误列表格式化成回喂给子代理的提示串(对标 cc 的 errorsText) */
export function formatSchemaErrors(errors: SchemaError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join("; ");
}

/**
 * 根层「可识别」的 JSON Schema 关键字(draft 2020-12 核心 + 校验 + 注解词表)。
 * 不要求本校验器都实现——只用来判断「这个对象到底是不是在写 JSON Schema」。
 */
const KNOWN_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "$anchor",
  "$comment",
  "definitions",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
  "items",
  "prefixItems",
  "contains",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  "unevaluatedItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "nullable",
]);

/**
 * 本校验器**不实现**的约束类关键字。写了它们 = 写了约束却不生效,shape 阶段直接拒绝。
 * 与 KNOWN_SCHEMA_KEYWORDS 的差集是「认识且实现」或「纯注解」。
 */
const UNSUPPORTED_KEYWORDS: Record<string, string> = {
  patternProperties: "改用 properties 列出字段,或 additionalProperties: {子 schema}",
  propertyNames: "改用 properties + additionalProperties: false",
  minProperties: "改用 required 列出必填字段",
  maxProperties: "改用 properties + additionalProperties: false",
  dependentRequired: "改用 if/then: { if: {required:[A]}, then: {required:[B]} }",
  dependentSchemas: "改用 if/then",
  unevaluatedProperties: "改用 additionalProperties: false",
  prefixItems: "改用 items: {子 schema}",
  contains: "改用 items 约束每一项",
  minContains: "改用 items 约束每一项",
  maxContains: "改用 items 约束每一项",
  unevaluatedItems: "改用 items",
  uniqueItems: "去掉该约束,或在 workflow 脚本里自行去重",
  multipleOf: "改用 minimum/maximum 或 enum",
};

const VALID_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/** 子 schema 所在位置:key → 取值形态 */
const SINGLE_SUBSCHEMA_KEYS = ["items", "additionalProperties", "not", "if", "then", "else"];
const ARRAY_SUBSCHEMA_KEYS = ["allOf", "anyOf", "oneOf"];
const MAP_SUBSCHEMA_KEYS = ["properties", "$defs", "definitions"];
/** 不消耗数据层级的子 schema 位置(ref 环检测只沿这些边走) */
const SAME_VALUE_KEYS = new Set(["not", "if", "then", "else", ...ARRAY_SUBSCHEMA_KEYS]);

/**
 * 轻量校验 schema 本身是否像个合法 JSON Schema(对标 cc 的 ajv.validateSchema)。
 * **递归**走 properties/items/additionalProperties/$defs/组合关键字,检查:
 *  - 必须是对象;type 取值合法;根层非空时至少含一个可识别关键字(B19)
 *  - 不含本校验器不实现的约束关键字(否则约束静默失效)
 *  - $ref 能解析;不存在不消耗数据的 $ref 环(否则校验期无限展开)
 *  - pattern 能编译(灾难性回溯不在这里静态判:形态识别必误伤 `(\d+\.)+` 这类合法写法,
 *    由校验期的 vm 限时兜底)
 * 这些都是「作者的错」:返回错误串,调用方走不可重试分支。合法返回 null。
 */
export function checkSchemaShape(schema: unknown): string | null {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return "schema 必须是 JSON Schema 对象";
  }
  const root = schema as Schema;
  // B19:`{ dirs: { type: "array" } }` 这种漏写根层 type/properties 的对象,
  // validateNode 一个关键字都不认识 → 对任何值都返回 valid:true,结构化输出零报错地失效。
  // 只拦「有键但全不认识」;空对象 `{}` 是 JSON Schema 里显式的「接受任意值」,放行。
  const keys = Object.keys(root);
  if (keys.length > 0 && !keys.some((k) => KNOWN_SCHEMA_KEYWORDS.has(k))) {
    return (
      `schema 没有可识别的 JSON Schema 关键字(收到的键: ${keys.slice(0, 5).join(", ")}),` +
      `是不是漏了根层的 type: "object" / properties?`
    );
  }
  return checkNodeShape(root, "#", root, new Set());
}

function checkNodeShape(s: Schema, at: string, root: Schema, visited: Set<object>): string | null {
  if (visited.has(s)) return null;
  visited.add(s);
  const where = at === "#" ? "" : `(位于 ${at})`;

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    for (const t of types) {
      if (typeof t !== "string" || !VALID_TYPES.has(t)) {
        return `非法 type: ${JSON.stringify(t)}${where}`;
      }
    }
  }
  for (const k of Object.keys(s)) {
    const hint = UNSUPPORTED_KEYWORDS[k];
    if (hint) return `本校验器不支持关键字 ${k}${where},写了也不会生效;${hint}`;
  }
  if (s.$ref !== undefined) {
    if (typeof s.$ref !== "string" || !resolveRef(s.$ref, root)) {
      return `$ref 无法解析: ${JSON.stringify(s.$ref)}${where}(只支持 #/$defs/… 本地引用)`;
    }
    const cycle = findSameValueCycle(s, root, []);
    if (cycle) return `schema 存在循环 $ref: ${cycle.join(" → ")}${where}`;
  }
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== "string") return `pattern 必须是字符串${where}`;
    try {
      new RegExp(s.pattern);
    } catch (e) {
      return `pattern 不是合法正则${where}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const children: Array<[string, unknown]> = [];
  for (const k of SINGLE_SUBSCHEMA_KEYS) {
    if (s[k] !== undefined && typeof s[k] !== "boolean") children.push([`${at}/${k}`, s[k]]);
  }
  for (const k of ARRAY_SUBSCHEMA_KEYS) {
    if (s[k] === undefined) continue;
    if (!Array.isArray(s[k])) return `${k} 必须是 schema 数组${where}`;
    (s[k] as unknown[]).forEach((sub, i) => children.push([`${at}/${k}/${i}`, sub]));
  }
  for (const k of MAP_SUBSCHEMA_KEYS) {
    const m = s[k];
    if (m === undefined) continue;
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      return `${k} 必须是对象${where}`;
    }
    for (const [name, sub] of Object.entries(m)) children.push([`${at}/${k}/${name}`, sub]);
  }
  for (const [childAt, sub] of children) {
    if (typeof sub !== "object" || sub === null || Array.isArray(sub)) {
      return `子 schema 必须是对象(位于 ${childAt})`;
    }
    const err = checkNodeShape(sub as Schema, childAt, root, visited);
    if (err) return err;
  }
  return null;
}

/**
 * 从 s 出发只沿「不消耗数据」的边($ref、组合关键字)走,能回到已走过的 ref 即为环。
 * `Node.properties.child → Node` 消耗了一层数据,不算环。
 */
function findSameValueCycle(s: Schema, root: Schema, stack: string[]): string[] | null {
  if (typeof s.$ref === "string") {
    const ref = s.$ref;
    if (stack.includes(ref)) return [...stack, ref];
    const target = resolveRef(ref, root);
    return target ? findSameValueCycle(target, root, [...stack, ref]) : null;
  }
  for (const k of SAME_VALUE_KEYS) {
    const v = s[k];
    const subs = Array.isArray(v) ? v : v !== undefined ? [v] : [];
    for (const sub of subs) {
      if (typeof sub !== "object" || sub === null) continue;
      const c = findSameValueCycle(sub as Schema, root, stack);
      if (c) return c;
    }
  }
  return null;
}
