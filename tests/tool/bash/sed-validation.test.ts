/**
 * sed 权限门校验测试（G4）
 */

import { describe, test, expect } from "bun:test";
import { detectSedWrite, detectDangerousSed } from "@sid-code/core/tool/bash/sed-validation.ts";

describe("detectSedWrite", () => {
  test("识别 sed -i 就地编辑并提取目标文件", () => {
    const r = detectSedWrite("sed -i 's/old/new/g' config.txt");
    expect(r.isSedWrite).toBe(true);
    expect(r.targetFile).toBe("config.txt");
  });

  test("识别 sed --in-place", () => {
    const r = detectSedWrite("sed --in-place 's/a/b/' file.js");
    expect(r.isSedWrite).toBe(true);
  });

  test("非 -i 的 sed 不算写操作", () => {
    const r = detectSedWrite("sed 's/old/new/g' config.txt");
    expect(r.isSedWrite).toBe(false);
  });
});

describe("detectDangerousSed", () => {
  test("s///e 执行 shell 命令 → 危险", () => {
    const r = detectDangerousSed("sed 's/.*/whoami/e' file.txt");
    expect(r.dangerous).toBe(true);
    expect(r.reason).toContain("shell");
  });

  test("s///w 写任意文件 → 危险", () => {
    const r = detectDangerousSed("sed 's/foo/bar/w /etc/passwd' input.txt");
    expect(r.dangerous).toBe(true);
  });

  test("sed w 命令写文件 → 危险", () => {
    const r = detectDangerousSed("sed -e 'w /tmp/leak.txt' secrets.env");
    expect(r.dangerous).toBe(true);
  });

  test("普通替换不危险", () => {
    const r = detectDangerousSed("sed 's/old/new/g' file.txt");
    expect(r.dangerous).toBe(false);
  });

  test("sed -i 普通替换不危险", () => {
    const r = detectDangerousSed("sed -i 's/old/new/g' file.txt");
    expect(r.dangerous).toBe(false);
  });

  test("无 sed 命令不危险", () => {
    const r = detectDangerousSed("echo hello world");
    expect(r.dangerous).toBe(false);
  });

  // 误报边界：替换内容含 e/w 字母、以 e/w 开头的词、其他分隔符——都不应误判为危险
  test.each([
    "sed 's/exit/quit/g' file.txt",
    "sed 's/error/warning/g' log.txt",
    "sed -i 's/enable/disable/g' cfg",
    "sed 's/world/web/g' f",
    "sed -n '1,5p' file.txt",
    "sed 's|old|new|g' file",
    "echo 'sed test' && ls",
    "grep sed file.txt",
  ])("普通/含 e·w 字母的 sed 不误报: %s", (cmd) => {
    expect(detectDangerousSed(cmd).dangerous).toBe(false);
  });

  test("s///ge 组合标志仍识别为危险", () => {
    expect(detectDangerousSed("sed 's/a/b/ge' f").dangerous).toBe(true);
  });
});
