/**
 * §8 D 组：静态门禁（I3 单一决策点防回退）。
 *
 * 按仓库教训读**代码**不读注释：先剥掉注释与字符串再匹配，否则「曾经有 markTerminal」
 * 这类历史注释会让门禁误报，而把调用藏进注释旁的真代码又会被注释掩护。
 *
 * 实现说明：设计稿把唯一执行点叫 `applyRecoveryAction`；落地时动作分派留在流式 catch
 * 内（handoff / degrade / give_up / retry 四个分支），**状态写入**收敛到放弃出口
 * `recordGiveUp`。门禁钉的是后者：拉黑类写入全文件只此一处。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const LLM = join(ROOT, "core/src/llm");

/** 剥注释与字符串字面量（够用的近似：不处理正则字面量里的引号） */
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/\/\/[^\n]*/g, " ");
}

/** 取 `private <name>(` 方法体（按花括号配平） */
function methodBody(code: string, name: string): string {
  // 只认方法**定义**（`private name(`），不认调用点 `this.name(`
  const start = code.search(new RegExp(`\\bprivate\\s+(async\\s+)?\\*?\\s*${name}\\s*\\(`));
  expect(start).toBeGreaterThanOrEqual(0);
  const open = code.indexOf("{", code.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === "node_modules" || f === "tests" || f === "vendor") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const fallbackCode = stripCommentsAndStrings(readFileSync(join(LLM, "fallback.ts"), "utf8"));
const policyCode = stripCommentsAndStrings(readFileSync(join(LLM, "recovery-policy.ts"), "utf8"));

describe("D：单一决策点静态门禁", () => {
  test("自证：剥注释后的匹配能抓到真调用、放过注释", () => {
    const sample = stripCommentsAndStrings(
      "// this.availability.markSuspect(x)\n/* markTerminal( */\nthis.availability.markSuspect(m, f, e);",
    );
    expect(count(sample, /\bmarkSuspect\s*\(/g)).toBe(1);
    expect(count(sample, /\bmarkTerminal\s*\(/g)).toBe(0);
  });

  test("fallback.ts：markSuspect 只出现在 recordGiveUp 体内（白名单一处），markTerminal 零命中", () => {
    const total = count(fallbackCode, /\.markSuspect\s*\(/g);
    const inExit = count(methodBody(fallbackCode, "recordGiveUp"), /\.markSuspect\s*\(/g);
    expect(total).toBe(1);
    expect(inExit).toBe(1);
    expect(count(fallbackCode, /\bmarkTerminal\b/g)).toBe(0);
  });

  test("fallback.ts：recordGiveUp 只有一个调用点，且紧跟在 decideRecovery 的 give_up 分支里", () => {
    expect(count(fallbackCode, /this\.recordGiveUp\s*\(/g)).toBe(1);
    expect(count(fallbackCode, /\bdecideRecovery\s*\(/g)).toBe(1);
  });

  test("recovery-policy.ts 是纯函数：零状态写入、零 availability 引用、零 sleep", () => {
    expect(count(policyCode, /\bmark(Suspect|Terminal|Healthy|RateLimited)\b/g)).toBe(0);
    expect(count(policyCode, /\bavailability\b/gi)).toBe(0);
    expect(count(policyCode, /\b(setTimeout|sleep)\s*\(/g)).toBe(0);
  });

  test("流内 error 事件分支只做归一化 + throw：不出现 tryFallback / 决策 / 计数", () => {
    const idx = fallbackCode.indexOf('if (event.type === "") {');
    // 剥字符串后 "error" 变成 ""；首个这样的分支就是主流式循环里的事件分支
    expect(idx).toBeGreaterThan(0);
    const branch = methodBodyFrom(fallbackCode, idx);
    expect(branch).not.toMatch(/tryFallback\s*\(/);
    expect(branch).not.toMatch(/decideRecovery|recordGiveUp|consecutive529|markSuspect/);
    expect(branch).toMatch(/throw new NormalizedErrorCarrier\s*\(/);
  });

  test("旧分类器 / 闸门全仓 src 零命中（换词复查）", () => {
    const banned = [
      /\bclassifyStreamError\b/,
      /\bclassifyError\b/,
      /\bisGatewayPlaceholderAuthError\b/,
      /\bneedsAuthRefresh\b/,
      /\bgatewayPlaceholderAuthRetries\b/,
      /\bTerminalError\b/,
      /\bStreamLevelError\b/,
      /\bmarkRetryOnce\b/,
    ];
    const hits: string[] = [];
    for (const f of [...walk(join(ROOT, "core/src")), ...walk(join(ROOT, "cli/src"))]) {
      const code = stripCommentsAndStrings(readFileSync(f, "utf8"));
      for (const re of banned) if (re.test(code)) hits.push(`${f.slice(ROOT.length)} ${re}`);
    }
    expect(hits).toEqual([]);
  });

  test("engine.ts 主线程调用显式声明 querySource（I4 不依赖 config 缺省值）", () => {
    const engine = readFileSync(join(ROOT, "core/src/query/engine.ts"), "utf8");
    expect(engine).toMatch(/executeWithFallback\([^)]*\{[\s\S]{0,400}querySource:\s*"main_thread"/);
    expect(stripCommentsAndStrings(engine)).not.toMatch(/\bresetTurn\s*\(/);
  });
});

/** 从给定 `if (...) {` 位置取配平的块 */
function methodBodyFrom(code: string, at: number): string {
  const open = code.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(open, i + 1);
  }
  throw new Error("unbalanced");
}
