/**
 * Dynamic Workflows M2 — 轻量 JSON Schema 校验器
 *
 * 为什么自研而非 Ajv:
 *  - 项目约定不引 Ajv;且 Ajv 未安装。
 *  - workflow 脚本跑在 vm 沙箱里(无 import),作者只能传**纯 JSON Schema 对象**(POJO)给
 *    agent({schema})。我们要拿这个 POJO 去校验子代理的结构化输出——方向是
 *    "用 schema 验数据",不是 zod 的 "schema→JSON Schema"。
 *  - workflow schema 用到的子集很窄(object/array/string/number/integer/boolean/enum/
 *    required/嵌套/$ref→$defs/const/nullable),自己写一个精确、可测、零依赖的就够。
 *
 * 对标 cc 的 Ajv 错误风格:返回 `instancePath: message` 列表,回喂给子代理让它重试。
 * 不支持的关键字(如 allOf/oneOf/patternProperties)被**安静忽略**(只做它认识的约束),
 * 避免误判;真正不认识的复杂 schema 退化为"宽松通过",不阻断 workflow。
 */

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

/**
 * 递归校验。把错误累加进 errors。
 * @param schema 当前层 schema
 * @param value  当前层数据
 * @param path   当前路径(用于错误信息)
 * @param root   根 schema(解析 $ref 用)
 */
function validateNode(
  schema: Schema,
  value: unknown,
  path: string,
  root: Schema,
  errors: SchemaError[],
): void {
  // $ref 解引用(先处理,展开后继续)
  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, root);
    if (resolved) {
      validateNode(resolved, value, path, root, errors);
      return;
    }
    // 解不出的 ref:安静跳过(宽松)
    return;
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
    // additionalProperties === false:多出来的键报错
    if (schema.additionalProperties === false && props) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          errors.push({ path: joinPath(path, key), message: `不允许的额外字段 ${key}` });
        }
      }
    }
    // additionalProperties 为子 schema:校验所有非 props 的值
    if (
      typeof schema.additionalProperties === "object" &&
      schema.additionalProperties !== null
    ) {
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
      try {
        if (!new RegExp(schema.pattern).test(str)) {
          errors.push({ path, message: `不匹配正则 ${schema.pattern}` });
        }
      } catch {
        /* 非法正则:忽略该约束 */
      }
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
 * 轻量校验 schema 本身是否像个合法 JSON Schema(对标 cc 的 ajv.validateSchema)。
 * 只做基本结构检查:必须是对象,type(若有)取值合法。不合法返回错误串。
 */
export function checkSchemaShape(schema: unknown): string | null {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return "schema 必须是 JSON Schema 对象";
  }
  const s = schema as Schema;
  const VALID_TYPES = new Set([
    "object",
    "array",
    "string",
    "number",
    "integer",
    "boolean",
    "null",
  ]);
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    for (const t of types) {
      if (typeof t !== "string" || !VALID_TYPES.has(t)) {
        return `非法 type: ${JSON.stringify(t)}`;
      }
    }
  }
  return null;
}
