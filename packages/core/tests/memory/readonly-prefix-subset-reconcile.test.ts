/**
 * 第二套只读白名单与主表的对账（D3）。
 *
 * `memory/extract/permissions.ts` 的 `READONLY_BASH_PREFIXES` 是**独立的一整套判定**，
 * 不是主表 `read-only-validation.ts` 的 `READ_ONLY_COMMANDS` 换了个数据源。
 *
 * 差异本身是刻意的设计：后台记忆提取代理是无人监督的 fork，能力面只收不放，
 * 所以第二套只有 9 条、`>` 一律拒（含 `>/dev/null`）。**问题只在于差异没有任何机器校验**：
 * - 主表删一条命令，没人发现第二套还在用它；
 * - 第二套自己造一条主表没有的命令，也没人发现（那意味着它在维护第三套规则）。
 *
 * ## 判据是「子集」，不是「相等」
 *
 * 相等会逼人把第二套同步扩成主表的镜像——方向反了，那是安全退步。
 * 这里只要求：**第二套的每一条都能在主表里找到落点**——
 * 要么在 `READ_ONLY_COMMANDS` 里，要么由主表的 `CONDITIONAL_COMMANDS` 或
 * git 子命令分支接管判定。
 *
 * ## 为什么解析源码而不是 import 数据
 *
 * 主表、`CONDITIONAL_COMMANDS`、`READ_ONLY_GIT_SUBCOMMANDS` 都是模块私有常量，没有导出。
 * 为了一个对账测试把它们全导出，等于把内部结构固化成对外契约。所以从源码里解析——
 * 用 TypeScript 编译器 API（与 `bun run typecheck:gate` 同一个解析器，不是手写正则）。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { READONLY_BASH_PREFIXES } from "@sid-code/core/memory/extract/permissions.ts";

// 本文件在 packages/core/tests/memory/ → 上溯三层到 packages/core/src/
const MAIN_TABLE_PATH = join(import.meta.dir, "../../src/tool/bash/read-only-validation.ts");

/** 从源码里解析出主表各集合的**字符串字面量成员**（展开式、变量引用一律跳过并报错） */
function parseMainTable(): {
  readOnly: string[];
  conditional: string[];
  gitSubcommands: string[];
} {
  const src = readFileSync(MAIN_TABLE_PATH, "utf8");
  const file = ts.createSourceFile(MAIN_TABLE_PATH, src, ts.ScriptTarget.Latest, true);

  /** 取 `const <name> = new Set([...])` 或 `const <name> = [...]` 的字符串元素 */
  const collect = (name: string): string[] => {
    let found: string[] | null = null;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        let init = node.initializer;
        if (!init) throw new Error(`${name}: 没有初始化表达式`);
        if (
          ts.isNewExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === "Set"
        ) {
          init = init.arguments?.[0];
          if (!init) throw new Error(`${name}: new Set() 没有参数`);
        }
        if (!ts.isArrayLiteralExpression(init)) {
          throw new Error(`${name}: 初始化表达式不是数组字面量，解析器需跟着源码更新`);
        }
        const values: string[] = [];
        for (const el of init.elements) {
          if (ts.isStringLiteral(el)) values.push(el.text);
          else
            throw new Error(
              `${name}: 元素不是字符串字面量（${el.getText()}），解析器需跟着源码更新`,
            );
        }
        found = values;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!found) throw new Error(`未在 ${MAIN_TABLE_PATH} 找到 ${name}，解析器需跟着源码更新`);
    return found;
  };

  /** 取对象字面量的**键名**（`CONDITIONAL_COMMANDS` 是一张 Record） */
  const collectObjectKeys = (name: string): string[] => {
    let found: string[] | null = null;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        const init = node.initializer;
        if (!init || !ts.isObjectLiteralExpression(init)) {
          throw new Error(`${name}: 不是对象字面量，解析器需跟着源码更新`);
        }
        found = init.properties.map((p) => {
          if (
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
          ) {
            return p.name.text;
          }
          throw new Error(`${name}: 键不是标识符（${p.getText()}），解析器需跟着源码更新`);
        });
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!found) throw new Error(`未在 ${MAIN_TABLE_PATH} 找到 ${name}，解析器需跟着源码更新`);
    return found;
  };

  return {
    readOnly: collect("READ_ONLY_COMMANDS"),
    conditional: collectObjectKeys("CONDITIONAL_COMMANDS"),
    gitSubcommands: collect("READ_ONLY_GIT_SUBCOMMANDS"),
  };
}

const main = parseMainTable();
const delegated = new Set([...main.conditional, ...main.gitSubcommands]);
const known = new Set([...main.readOnly, ...delegated]);

describe("D3 对账：第二套白名单是主表的真子集", () => {
  test("每一条都能在主表 / CONDITIONAL_COMMANDS / git 分支里找到落点", () => {
    // 判据是子集关系。第二套里有、主表里没有的命令 = 它自己造了规则，
    // 这正是这条门禁要拦的（主表删了某条命令、第二套没跟着删，也会在这里红）。
    //
    // ⚠️ 变异自证时要挑一个**三张表里都没有**的名字（如 "nc"）。
    // `curl` / `wget` 看着像「主表没有」，实际是 `CONDITIONAL_COMMANDS` 的成员
    // （恒判非只读），塞进第二套仍会绿——那不说明门禁坏了，说明变异选错了对象。
    const orphans = READONLY_BASH_PREFIXES.filter((c) => !known.has(c));
    expect(orphans).toEqual([]);
  });

  test("PARSE 自检：主表解析结果非空，防止解析器静默返回空集让对账恒绿", () => {
    // 变异自证的另一半：如果哪天源码改写成解析器认不出的形态，
    // 上面的 orphans 会变成「全量」而不是「空」，这条先把它挑明。
    expect(main.readOnly.length).toBeGreaterThan(40);
    expect(main.conditional.length).toBeGreaterThan(5);
    expect(main.gitSubcommands.length).toBeGreaterThan(5);
    expect(READONLY_BASH_PREFIXES.length).toBeGreaterThan(0);
  });

  test("第二套确实比主表窄（子集是真子集，不是被误扩成了镜像）", () => {
    // 这条守的是「不许把它同步扩成主表的镜像」——D3 的修法明确不合并两套。
    // 如果哪天第二套涨到与主表同宽，这个测试会红，提醒回头读 extract/permissions.ts
    // 的注释：后台代理是无人监督的 fork，能力面只收不放。
    const mainOnly = main.readOnly.filter((c) => !READONLY_BASH_PREFIXES.includes(c));
    expect(mainOnly.length).toBeGreaterThan(0);
  });
});
