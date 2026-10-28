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

// Q2 / N6：只扫 sed 的脚本参数，不扫整条命令；独立 e/w/r 的锚点扩到地址之后与整段脚本
describe("detectDangerousSed：只扫脚本参数（Q2）", () => {
  test.each([
    // 路径 `s.t.a.b.i.l.i.t.y` 能凑出 s<c>…<c>…<c>e，修前被当成 s///e
    "sed -n 1p tests/tool/bash-stability.test.ts",
    // 跨段：第二个 sed 的路径命中正则
    "sed -n 3365,3390p src/query/loop.ts; echo ----; sed -n 3432,3530p packages/core/src/query/loop.ts",
    "sed '/foo/,/bar/d' f",
    "sed -n '$p' f",
    "sed '1a wrote' f",
    "sed -i.bak 's/a/b/' f",
    "sed -E 's/(a)/\\1/' f",
  ])("不误报：%s", (cmd) => {
    expect(detectDangerousSed(cmd).dangerous).toBe(false);
  });

  test.each([
    "sed '1e id' f",
    "sed -n '1e id' f",
    "sed '$e id' f",
    "sed '/x/{p;e}' f",
    "sed e f",
    "cat f | sed e",
    "sed --expression='1e id' f",
    "sed '1r /etc/passwd' f",
    "sed -n '1w /tmp/q2x' f",
    "sed -n '/re/W /tmp/x' f",
  ])("收紧（N6，修前放行）：%s", (cmd) => {
    expect(detectDangerousSed(cmd).dangerous).toBe(true);
  });

  test("-f 脚本来自文件 → 危险", () => {
    const r = detectDangerousSed("sed -f s.sed f");
    expect(r.dangerous).toBe(true);
    expect(r.reason).toContain("-f");
  });

  test("--file 同上", () => {
    expect(detectDangerousSed("sed --file=s.sed f").dangerous).toBe(true);
  });
});
