/**
 * 路径规则匹配测试（P0-2：四种 gitignore 风格前缀）
 */

import { describe, test, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import {
  resolvePathRulePattern,
  matchPathRule,
  type PathRuleContext,
} from "@sid-code/core/permission/path-rule-matching.ts";

const WS = "/Users/tester/project";
const HOME = "/Users/tester";
const CWD = "/Users/tester/project/src";
const ctx: PathRuleContext = { workspaceRoot: WS, homeDir: HOME, cwd: CWD };

describe("resolvePathRulePattern - 四种前缀", () => {
  test("// → 文件系统绝对路径（去一个 /）", () => {
    expect(resolvePathRulePattern("//etc/passwd", ctx)).toBe("/etc/passwd");
    expect(resolvePathRulePattern("//Users/alice/**", ctx)).toBe("/Users/alice/**");
  });

  test("~/ → 主目录相对", () => {
    expect(resolvePathRulePattern("~/Documents/*.pdf", ctx)).toBe(`${HOME}/Documents/*.pdf`);
  });

  test("/ → 项目根相对（单前导斜杠）", () => {
    expect(resolvePathRulePattern("/src/index.ts", ctx)).toBe(`${WS}/src/index.ts`);
  });

  test("./ → 当前目录相对", () => {
    expect(resolvePathRulePattern("./.env", ctx)).toBe(`${CWD}/.env`);
  });

  test("裸 path → 当前目录相对", () => {
    expect(resolvePathRulePattern("foo.txt", ctx)).toBe(`${CWD}/foo.txt`);
  });

  test("** 通配符不被吞", () => {
    expect(resolvePathRulePattern("/src/**/*.ts", ctx)).toBe(`${WS}/src/**/*.ts`);
  });
});

describe("matchPathRule - 验收标准", () => {
  test("Read(./.env) 匹配 cwd 下 .env 的绝对路径", () => {
    expect(matchPathRule("./.env", `${CWD}/.env`, ctx)).toBe(true);
  });

  test("Read(*.env) 裸模式匹配 cwd 下 .env", () => {
    expect(matchPathRule("*.env", `${CWD}/.env`, ctx)).toBe(true);
  });

  test("Read(~/Documents/*.pdf) 匹配 home 下 pdf", () => {
    expect(matchPathRule("~/Documents/*.pdf", `${HOME}/Documents/report.pdf`, ctx)).toBe(true);
    expect(matchPathRule("~/Documents/*.pdf", `${HOME}/Documents/report.txt`, ctx)).toBe(false);
  });

  test("Edit(/src/**/*.ts) 匹配项目根 src 下任意深度 ts", () => {
    expect(matchPathRule("/src/**/*.ts", `${WS}/src/a/b/c.ts`, ctx)).toBe(true);
    expect(matchPathRule("/src/**/*.ts", `${WS}/src/index.ts`, ctx)).toBe(true);
    expect(matchPathRule("/src/**/*.ts", `${WS}/lib/x.ts`, ctx)).toBe(false);
  });

  test("Read(//etc/**) 匹配 /etc/passwd", () => {
    expect(matchPathRule("//etc/**", "/etc/passwd", ctx)).toBe(true);
  });

  test("* 单层不跨 /；** 递归", () => {
    expect(matchPathRule("/src/*.ts", `${WS}/src/index.ts`, ctx)).toBe(true);
    expect(matchPathRule("/src/*.ts", `${WS}/src/a/b.ts`, ctx)).toBe(false);
    expect(matchPathRule("/src/**", `${WS}/src/a/b.ts`, ctx)).toBe(true);
  });

  test("dot:true 使隐藏文件可匹配", () => {
    expect(matchPathRule("/**", `${WS}/.env`, ctx)).toBe(true);
  });

  test("deny 侧：Read(//Users/*/.ssh/**) 拦截读 ~/.ssh/id_rsa", () => {
    expect(matchPathRule("//Users/*/.ssh/**", "/Users/tester/.ssh/id_rsa", ctx)).toBe(true);
  });

  test("目录前缀匹配：无通配符模式指向目录时匹配其下文件", () => {
    expect(matchPathRule("/src", `${WS}/src/deep/file.ts`, ctx)).toBe(true);
    expect(matchPathRule("/src", `${WS}/lib/file.ts`, ctx)).toBe(false);
  });

  test("相对 file_path 按 cwd 归一", () => {
    expect(matchPathRule("./.env", ".env", ctx)).toBe(true);
  });

  test("空 file_path 不匹配", () => {
    expect(matchPathRule("*.env", "", ctx)).toBe(false);
  });
});

describe("matchPathRule - 默认上下文（不传 home/cwd）", () => {
  test("退化到 os.homedir / process.cwd", () => {
    const realCtx: PathRuleContext = { workspaceRoot: process.cwd() };
    const abs = path.join(process.cwd(), ".env");
    expect(matchPathRule("./.env", abs, realCtx)).toBe(true);
    // 确认 home 默认可用
    expect(resolvePathRulePattern("~/x", realCtx)).toBe(`${os.homedir()}/x`);
  });
});
