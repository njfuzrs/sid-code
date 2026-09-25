/**
 * /ide 在一个 lockfile 都没有时的提示。
 *
 * 两条文案的下一步完全不同：IDE 开着但扩展没装，该指向 /ide install；
 * 什么都没检测到，只能说「未发现」。抽成纯函数测，是为了不让这个区分
 * 依赖进程检测 —— 检测失败返回空列表，必须走通用文案，不能点名一个不存在的 IDE。
 */

import { describe, test, expect } from "bun:test";
import { noLockfileMessage } from "@sid-code/cli/command/ide.ts";

describe("/ide 没有 lockfile 时的提示", () => {
  test("IDE 开着但扩展没装：点名，并指向 /ide install", () => {
    const message = noLockfileMessage(["cursor", "windsurf"]);
    expect(message).toContain("cursor、windsurf");
    expect(message).toContain("正在运行");
    expect(message).toContain("/ide install");
  });

  test("什么都没检测到：退回通用文案，不点名", () => {
    const message = noLockfileMessage([]);
    expect(message).toContain("未发现可用 IDE");
    expect(message).not.toContain("正在运行");
  });
});
