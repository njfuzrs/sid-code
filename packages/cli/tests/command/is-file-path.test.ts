/**
 * `isFilePath` 接线测试（P1-1）。
 *
 * 缺陷形态：`isFilePath` 定义在 `parser.ts:57`，**全仓零调用、连测试都没有**。
 * 实际生效的只有 `looksLikeCommand` 那道正则 `/^[a-zA-Z0-9:\-_]+$/`。
 *
 * 后果只打单段路径：
 *   `/var/log/syslog` → 含 "/"，正则不过 → passthrough ✅（一直是对的）
 *   `/tmp`            → 只有字母，正则过  → 「未知命令: /tmp」 ❌
 * `/usr` `/etc` `/opt` `/home` `/root` `/bin` 同理。用户想让模型看 `/tmp` 下的东西，
 * 得到的是一句「未知命令」。
 *
 * 这份文件同时补上该函数**此前完全没有**的单测。
 */

import { describe, test, expect } from "bun:test";
import { isFilePath, looksLikeCommand } from "@sid-code/cli/command/parser.ts";

describe("isFilePath", () => {
  test("真实存在的一级目录判为路径", async () => {
    // /tmp 在 darwin / linux 都存在，是这条缺陷最典型的受害者
    expect(await isFilePath("tmp")).toBe(true);
  });

  test("不存在的名字不判为路径", async () => {
    expect(await isFilePath("xyzabc-definitely-not-a-real-path")).toBe(false);
  });

  test("空串不判为路径", async () => {
    // `/` 本身存在，但空命令名不该被当成路径放过——parseSlashCommand 已先拦掉空名，
    // 这里锁住即使传进来也不会误判为路径。
    expect(await isFilePath("")).toBe(false);
  });
});

describe("两道判定的分工（P1-1 的根因）", () => {
  test("正则单独拦不住单段真实目录——这就是缺陷本身", () => {
    // 正则认为 "tmp" 像命令名 → 修复前直接报「未知命令」
    expect(looksLikeCommand("tmp")).toBe(true);
  });

  test("含 / 的路径正则本就不过（回归：这条一直是对的）", () => {
    expect(looksLikeCommand("var/log/syslog")).toBe(false);
  });

  test("两道合起来才能区分「真实目录」与「拼错的命令」", async () => {
    // 真目录：正则过、isFilePath 也过 → 应 passthrough
    expect(looksLikeCommand("tmp") && !(await isFilePath("tmp"))).toBe(false);
    // 拼错的命令：正则过、isFilePath 不过 → 应报未知命令
    expect(looksLikeCommand("xyzabc") && !(await isFilePath("xyzabc"))).toBe(true);
  });
});
