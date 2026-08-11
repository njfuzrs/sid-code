/**
 * Dynamic Workflows M0 — 脚本执行沙箱
 *
 * 职责:
 *  1. 把 LLM 生成的 workflow JS 脚本安全地跑起来,只暴露受控全局
 *     (agent/parallel/pipeline/phase/log/args/budget/workflow + 标准 JS 内置)。
 *  2. 真正的隔离边界 = `node:vm` 独立 context。脚本拿不到宿主的
 *     process/require/Bun/fetch/setTimeout/crypto/performance —— 它们在 context 里都是
 *     undefined。即便走 `[].constructor.constructor`(经典逃逸:Array.constructor 就是真
 *     Function)拿到 Function 构造器,它编译出的代码也只在**同一个隔离 context** 里跑,
 *     仍然碰不到宿主全局。脚本碰文件/网络只能通过 agent() 调有权限裁决的工具。
 *  3. 确定性守卫:在 context 里用影子 Date/Math 覆盖原生的——禁 Date.now()/无参 new Date()/
 *     Math.random()。破坏 resume 确定性的调用在**运行时**抛错,而非静态扫字符串(避开 cc
 *     的 #63759 误杀:连 prompt 里的 "Date.now" 都被拒)。
 *  4. 解析 + 校验 `export const meta = {...}`,要求它是可静态求值的纯字面量。meta 也在
 *     隔离 context 里求值,逃逸不出去。
 *  5. CPU 兜底:vm 的 `timeout` 选项掐掉死循环/同步阻塞(防 TUI 冻结)。
 *
 * 选型依据(实测):
 *  - 曾尝试 `new AsyncFunction` + 参数影子全局,被 `[].constructor.constructor('return process')()`
 *    一句话击穿(实测拿回真 process)。param-shadow 对付不了 prototype 链上的真 Function。
 *  - 改用 `node:vm`:实测 constructor 链在隔离 context 里只能拿到 context 自己的 Function,
 *    `process`/`require`/`globalThis.process` 全为 undefined;动态 import() 因无 callback 被拒;
 *    `timeout` 能掐死循环。这是真正的安全边界。
 */

import vm from "node:vm";
import type { MetaValidation, SandboxResult, WorkflowApi, WorkflowMeta } from "./types.ts";

/** 脚本同步执行段的超时(ms)。注:只掐**同步**阻塞(死循环);异步 await 期间不计时,
 *  agent() 自身的超时由 SubAgent 层(默认 120s)与调度器负责。可被环境变量覆盖。 */
function resolveSyncTimeoutMs(): number {
  const raw = process.env.SID_WORKFLOW_SYNC_TIMEOUT_MS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 30_000;
}

// ============================================================
// 确定性守卫:影子 Date / Math
// ============================================================

/** 影子 Date:禁 Date.now() 与无参 new Date();带参 new Date(ts) 放行(确定性) */
function makeShadowDate(): typeof Date {
  const RealDate = Date;
  const ShadowDate = function (this: unknown, ...args: unknown[]) {
    if (!(this instanceof ShadowDate)) {
      // 作为普通函数调用 Date() —— 返回当前时间字符串,非确定性,禁
      throw new Error(
        "[workflow] Date() 作为函数调用被禁(非确定性,破坏 resume)。需要时间戳请从 args 传入。",
      );
    }
    if (args.length === 0) {
      throw new Error(
        "[workflow] 无参 new Date() 被禁(非确定性,破坏 resume)。请从 args 传时间戳: new Date(args.ts)。",
      );
    }
    // @ts-expect-error 透传到真实 Date 构造
    return new RealDate(...args);
  } as unknown as typeof Date;

  ShadowDate.now = () => {
    throw new Error(
      "[workflow] Date.now() 被禁(非确定性,破坏 resume)。请从 args 传时间戳,或在 workflow 返回后再盖戳。",
    );
  };
  ShadowDate.parse = RealDate.parse;
  ShadowDate.UTC = RealDate.UTC;
  // 让 instanceof / 实例方法链正常工作(prototype 只读,用 defineProperty 赋值)
  Object.defineProperty(ShadowDate, "prototype", {
    value: RealDate.prototype,
    writable: false,
  });
  return ShadowDate;
}

/** 影子 Math:禁 Math.random(),其余方法/常量原样转发 */
function makeShadowMath(): Math {
  const shadow: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(Math)) {
    // Math 的方法不依赖 this,直接复制引用即可
    shadow[key] = (Math as unknown as Record<string, unknown>)[key];
  }
  shadow.random = () => {
    throw new Error(
      "[workflow] Math.random() 被禁(非确定性,破坏 resume)。需要变化请按下标改 agent 的 prompt/label。",
    );
  };
  return shadow as unknown as Math;
}

// ============================================================
// 字符串/注释剥离(供硬逃逸静态扫描)
// ============================================================

/**
 * 把源码里的字符串字面量、模板、注释内容替换为等长空白,保留代码结构。
 * 用途:在剥离后的源码上扫描 `import(`/`eval`/`require(` 这类**无法被形参影子**的硬逃逸,
 * 避免把 prompt 字符串里出现的同名子串误判(对齐 cc #63759 的教训)。
 *
 * 说明:正则字面量与除法的消歧很难做到 100%,这里采取实用策略——只精确处理三类字符串
 * 与两类注释;正则字面量内若恰好含 "import(" 之类(编排脚本中近乎不可能)属可接受残差。
 */
export function stripStringsAndComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // 行注释
    if (c === "/" && c2 === "/") {
      out += "  ";
      i += 2;
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    // 块注释
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    // 字符串 / 模板
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          // 转义:跳过下一个字符
          out += src[i] === "\n" ? "\n" : " ";
          out += src[i + 1] === "\n" ? "\n" : " ";
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          out += " ";
          i++;
          break;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 扫描无法被形参影子拦截的硬逃逸入口。命中即抛错。
 * 仅作用于已剥离字符串/注释的源码 —— 这是一个**很小、很精确**的名单
 * (动态 import / eval / require),不是脆弱的 Date.now 子串扫描。
 */
function scanForHardEscapes(strippedSrc: string): void {
  const checks: Array<{ re: RegExp; name: string }> = [
    { re: /\bimport\s*\(/, name: "动态 import()" },
    { re: /\brequire\s*\(/, name: "require()" },
    { re: /\beval\b/, name: "eval" },
  ];
  for (const { re, name } of checks) {
    if (re.test(strippedSrc)) {
      throw new Error(
        `[workflow] 脚本含被禁的逃逸构造:${name}。workflow 脚本是纯编排,一切副作用必须经 agent() 调有权限裁决的工具。`,
      );
    }
  }
}

// ============================================================
// meta 解析与校验
// ============================================================

/**
 * 从源码中提取 `meta` 声明的对象字面量源码片段(花括号配平,跳过字符串/注释)。
 * 要求脚本以 `export const meta = {...}` 形式声明(允许 const/let/var)。
 */
function extractMetaSource(src: string): string | null {
  // 在剥离字符串后的源码上定位 `meta` 声明,避免命中字符串里的 "const meta"
  const stripped = stripStringsAndComments(src);
  const decl = /\b(?:export\s+)?(?:const|let|var)\s+meta\s*=\s*\{/.exec(stripped);
  if (!decl) return null;
  // decl.index..end 对应原始 src 同位置(stripped 与 src 等长)
  const braceStart = stripped.indexOf("{", decl.index);
  if (braceStart < 0) return null;
  // 在剥离源上做花括号配平(字符串里的 { } 已被抹掉,不会干扰)
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  // 用原始 src 切片(保留字符串原文),范围由剥离源算得
  return src.slice(braceStart, end + 1);
}

/**
 * 在隔离 vm context 里求值 meta 对象字面量。
 * 纯字面量能正常求值;若引用了变量(context 里不存在)会抛 ReferenceError,被上层捕获判为
 * "非纯字面量"。即便构造 `[].constructor.constructor('return process')()` 也只在隔离
 * context 里跑,拿到 undefined,逃逸不出去。比脆弱的 token 扫描更稳健,无误判。
 */
function evalMetaLiteral(metaSrc: string): unknown {
  // 空 context:只有 vm 注入的内建(JSON/Array/...),没有 process/require/agent 等
  return vm.runInNewContext(`(${metaSrc})`, Object.create(null), {
    timeout: 1000,
  });
}

/** 校验 meta 的形状(name/description 必填非空字符串;phases 可选且每条有 title) */
function validateMetaShape(value: unknown): MetaValidation {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "meta 必须是对象字面量" };
  }
  const m = value as Record<string, unknown>;
  if (typeof m.name !== "string" || m.name.trim() === "") {
    return { ok: false, error: "meta.name 必填且为非空字符串(纯字面量,不能引用变量)" };
  }
  if (typeof m.description !== "string" || m.description.trim() === "") {
    return { ok: false, error: "meta.description 必填且为非空字符串" };
  }
  if (m.whenToUse !== undefined && typeof m.whenToUse !== "string") {
    return { ok: false, error: "meta.whenToUse 必须是字符串" };
  }
  if (m.phases !== undefined) {
    if (!Array.isArray(m.phases)) {
      return { ok: false, error: "meta.phases 必须是数组" };
    }
    for (let i = 0; i < m.phases.length; i++) {
      const p = m.phases[i] as Record<string, unknown>;
      if (typeof p !== "object" || p === null || typeof p.title !== "string") {
        return { ok: false, error: `meta.phases[${i}] 必须含字符串 title` };
      }
    }
  }
  return { ok: true, meta: m as unknown as WorkflowMeta };
}

/**
 * 解析并校验脚本的 meta(在不执行脚本体的前提下)。
 * 供权限弹窗在执行前展示 name/description 用。
 */
export function parseAndValidateMeta(src: string): MetaValidation {
  const metaSrc = extractMetaSource(src);
  if (metaSrc === null) {
    return {
      ok: false,
      error: "workflow 脚本必须以 `export const meta = { name, description, ... }` 开头(纯字面量)",
    };
  }
  let value: unknown;
  try {
    value = evalMetaLiteral(metaSrc);
  } catch (err) {
    return {
      ok: false,
      error: `meta 不是可静态求值的纯字面量(不能引用变量/调用函数/模板插值): ${(err as Error).message}`,
    };
  }
  return validateMetaShape(value);
}

// ============================================================
// 脚本改写 + 执行
// ============================================================

/** 剥离语句开头的 `export ` 关键字(vm 非 module 模式下不允许 module 语法) */
function stripExports(src: string): string {
  if (/\bexport\s+default\b/.test(stripStringsAndComments(src))) {
    throw new Error("[workflow] 脚本不支持 `export default`,只用 `export const meta = {...}`。");
  }
  // 仅替换出现在语句开头(行首或 ; 后)的 export,避免误伤字符串
  return src.replace(/(^|\n)(\s*)export\s+(const|let|var|function|class|async)\b/g, "$1$2$3");
}

/**
 * 在沙箱中执行 workflow 脚本。
 *
 * 隔离边界 = node:vm context。脚本体被包成 `(async () => { ... })()`,顶层 `return X`
 * 即 workflow 返回值。context 里只放 workflow API + 影子 Date/Math + 标准内建,
 * 宿主的 process/require/Bun/setTimeout/crypto 等一律不可见。
 *
 * @param src  原始脚本源码(纯 JS;含 TS 类型标注会在此抛 SyntaxError,对齐 cc 行为)
 * @param api  注入的 workflow 运行时实现(agent/parallel/pipeline/...)
 * @returns    { value: 脚本 return 值, meta: 校验后的 meta }
 */
export async function runInSandbox(src: string, api: WorkflowApi): Promise<SandboxResult> {
  // 1) 先校验 meta(执行前可拿到,供权限/展示)
  const metaResult = parseAndValidateMeta(src);
  if (!metaResult.ok) {
    throw new Error(metaResult.error);
  }

  // 2) 硬逃逸静态扫描(剥离字符串后)——defense-in-depth,主要给清晰报错;
  //    真正的隔离靠 vm context(动态 import 因无 callback 已被 vm 拒)。
  scanForHardEscapes(stripStringsAndComments(src));

  // 3) 改写:去掉 export 关键字
  const body = stripExports(src);

  // 4) 构造隔离 context,只注入受控全局。用 Object.create(null) 起底,杜绝原型链上的宿主属性。
  const sandboxGlobals: Record<string, unknown> = Object.create(null);
  sandboxGlobals.agent = api.agent;
  sandboxGlobals.parallel = api.parallel;
  sandboxGlobals.pipeline = api.pipeline;
  sandboxGlobals.phase = api.phase;
  sandboxGlobals.log = api.log;
  sandboxGlobals.args = api.args;
  sandboxGlobals.budget = api.budget;
  if (api.workflow) sandboxGlobals.workflow = api.workflow;
  // 确定性影子:覆盖 context 原生 Date/Math(vm context 默认给的是真的)
  sandboxGlobals.Date = makeShadowDate();
  sandboxGlobals.Math = makeShadowMath();

  const context = vm.createContext(sandboxGlobals);

  // 5) 包成 async IIFE;脚本顶层 `return X` 即 workflow 返回值。
  //    vm 编译同步段,timeout 掐死循环;await 期间不计时(由 SubAgent/调度器各自超时)。
  const wrapped = `(async () => {\n"use strict";\n${body}\n})()`;
  let promise: unknown;
  try {
    promise = vm.runInContext(wrapped, context, {
      timeout: resolveSyncTimeoutMs(),
      filename: `workflow:${metaResult.meta.name}`,
    });
  } catch (err) {
    throw new Error(
      `[workflow] 脚本语法错误或同步执行超时(注意:必须是纯 JavaScript,不能含 TypeScript 类型标注): ${(err as Error).message}`,
    );
  }

  const value = await promise;
  return { value, meta: metaResult.meta };
}
