/**
 * command-contract/protected-names 最小行为保护。
 *
 * 这个目录之前没有测试，改它时 affected-tests 会回退整包。
 * 补上这几个用例后，改 command-contract/ 时选测能精确命中本目录。
 */
import { describe, expect, test } from "bun:test";
import {
  PROTECTED_COMMAND_NAMES,
  isProtectedCommandName,
} from "../../src/command-contract/protected-names.ts";

describe("command-contract/protected-names", () => {
  test("名单里的名字被判为保护（help / exit）", () => {
    expect(isProtectedCommandName("help")).toBe(true);
    expect(isProtectedCommandName("exit")).toBe(true);
  });

  test("别名也在名单里（q 是 exit 的别名）", () => {
    expect(isProtectedCommandName("q")).toBe(true);
    expect(isProtectedCommandName("h")).toBe(true);
    expect(isProtectedCommandName("m")).toBe(true);
    expect(isProtectedCommandName("mem")).toBe(true);
  });

  test("不在名单里的名字不判为保护", () => {
    expect(isProtectedCommandName("my-custom-command")).toBe(false);
    expect(isProtectedCommandName("deploy")).toBe(false);
  });

  test("函数不做大小写归一化或前导 / 去除（与注册表层一致）", () => {
    // isProtectedCommandName 是字面比对，不做归一化；
    // 归一化是调用方（UnifiedCommandRegistry.dedupe）的职责，这里只守名单本身。
    expect(isProtectedCommandName("HELP")).toBe(false);
    expect(isProtectedCommandName("/help")).toBe(false);
  });

  test("PROTECTED_COMMAND_NAMES 是只读集合，包含核心逃生通道", () => {
    // 这些名字是「出了问题时的逃生通道」，任何一个被非内置来源占用都是事故。
    expect(PROTECTED_COMMAND_NAMES.has("config")).toBe(true);
    expect(PROTECTED_COMMAND_NAMES.has("clear")).toBe(true);
    expect(PROTECTED_COMMAND_NAMES.has("mcp")).toBe(true);
  });
});
