/**
 * 内置 LSP 服务器目录单测
 *
 * 覆盖：目录完整性（每条必备字段、扩展名格式）/ 扩展名反向索引正确性 /
 *       describeMissingServer 三种情形（内置支持未装 / 长尾语言 / 无扩展名）。
 * 这是"企业级开箱即用"的单一事实源，回归它防止路由与引导文案漂移。
 */

import { describe, test, expect } from "bun:test";
import {
  BUILTIN_LSP_SERVERS,
  EXTENSION_TO_BUILTIN,
  describeMissingServer,
} from "../../src/lsp/builtin-servers.ts";

describe("内置 LSP 服务器目录", () => {
  test("每条登记项字段完整且格式合法", () => {
    expect(BUILTIN_LSP_SERVERS.length).toBeGreaterThan(0);
    for (const s of BUILTIN_LSP_SERVERS) {
      expect(s.name).toBeTruthy();
      expect(s.command).toBeTruthy();
      expect(Array.isArray(s.args)).toBe(true);
      expect(s.installHint).toBeTruthy();
      const exts = Object.keys(s.extensionToLanguage);
      expect(exts.length).toBeGreaterThan(0);
      // 扩展名必须以点开头且为小写
      for (const ext of exts) {
        expect(ext.startsWith(".")).toBe(true);
        expect(ext).toBe(ext.toLowerCase());
      }
    }
  });

  test("服务器名唯一（避免路由/覆盖时撞名）", () => {
    const names = BUILTIN_LSP_SERVERS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("内置目录覆盖 Vue（本次报错的直接诱因）", () => {
    const vue = BUILTIN_LSP_SERVERS.find((s) => s.name === "vue");
    expect(vue).toBeDefined();
    expect(vue!.extensionToLanguage[".vue"]).toBe("vue");
    expect(EXTENSION_TO_BUILTIN.get(".vue")).toBe(vue!);
  });

  test("扩展名反向索引覆盖所有登记扩展名", () => {
    for (const s of BUILTIN_LSP_SERVERS) {
      for (const ext of Object.keys(s.extensionToLanguage)) {
        expect(EXTENSION_TO_BUILTIN.has(ext)).toBe(true);
      }
    }
  });
});

describe("describeMissingServer 引导文案", () => {
  const GLOBAL = "/home/u/.sid-code/lsp.json";

  test("内置支持但未安装：给出语言名 + 安装命令 + 自动生效提示", () => {
    const msg = describeMissingServer("/proj/src/App.vue", GLOBAL);
    expect(msg).toContain(".vue");
    expect(msg).toContain("vue"); // 服务器名
    expect(msg).toContain("@vue/language-server"); // 安装命令来自 installHint
    expect(msg).toContain("重启"); // 自动生效提示
  });

  test("Python 文件走内置引导（含 pyright 安装命令）", () => {
    const msg = describeMissingServer("/proj/main.py", GLOBAL);
    expect(msg).toContain(".py");
    expect(msg.toLowerCase()).toContain("pyright");
  });

  test("长尾语言：引导用户在 lsp.json 中自行配置", () => {
    const msg = describeMissingServer("/proj/main.zig", GLOBAL);
    expect(msg).toContain(".zig");
    expect(msg).toContain(GLOBAL); // 提示全局配置路径
    expect(msg).toContain("extensionToLanguage"); // 给出配置格式
  });

  test("无扩展名文件不崩溃且引导配置", () => {
    const msg = describeMissingServer("/proj/Makefile", GLOBAL);
    expect(msg).toContain("Makefile");
    expect(msg).toContain(GLOBAL);
  });

  test("扩展名大小写不敏感（.VUE 也识别为 Vue）", () => {
    const msg = describeMissingServer("/proj/App.VUE", GLOBAL);
    expect(msg).toContain("@vue/language-server");
  });
});
