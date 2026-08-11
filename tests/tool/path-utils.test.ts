/**
 * path-utils 单元测试
 * 覆盖 normalizeToolPath / levenshteinDistance / formatPathNotFoundError
 */
import { describe, it, expect } from "bun:test";
import { homedir } from "os";
import { resolve, normalize } from "path";
import {
  normalizeToolPath,
  levenshteinDistance,
  formatPathNotFoundError,
} from "@sid-code/core/tool/path-utils.ts";

// ============================================================
// normalizeToolPath
// ============================================================

describe("normalizeToolPath", () => {
  it("~ 展开为 home 目录", () => {
    const result = normalizeToolPath("~");
    expect(result).toBe(homedir());
  });

  it("~/path 展开并 resolve", () => {
    const result = normalizeToolPath("~/Documents");
    expect(result).toBe(resolve(homedir(), "Documents"));
  });

  it("相对路径 resolve 为绝对路径", () => {
    const result = normalizeToolPath("src/tool/read.ts", "/home/user/project");
    expect(result).toBe(resolve("/home/user/project", "src/tool/read.ts"));
  });

  it("冗余 .. 规范化", () => {
    const result = normalizeToolPath("/a/b/../c", "/tmp");
    expect(result).toBe(resolve("/a/c"));
  });

  it("null byte 被拦截并抛错", () => {
    expect(() => normalizeToolPath("/etc/passwd\x00.jpg")).toThrow("null byte");
  });

  it("NFC 归一化：NFD 输入转为 NFC", () => {
    // é 的 NFD 形式：e + combining acute accent (U+0065 U+0301)
    const nfd = "cafe\u0301.txt"; // café in NFD
    const result = normalizeToolPath(nfd, "/tmp");
    // NFC 形式：é (U+00E9)
    const nfc = normalize("caf\u00E9.txt").normalize("NFC");
    expect(result).toBe(resolve("/tmp", nfc));
  });

  it("首尾空格被 trim", () => {
    const result = normalizeToolPath("  /usr/bin  ");
    expect(result).toBe("/usr/bin");
  });

  it("路径中包含 // 被规范化", () => {
    const result = normalizeToolPath("/usr//local/bin");
    expect(result).toBe("/usr/local/bin");
  });
});

// ============================================================
// levenshteinDistance
// ============================================================

describe("levenshteinDistance", () => {
  it("两个相同字符串距离为 0", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  it("单字符替换距离为 1", () => {
    expect(levenshteinDistance("kitten", "sitten")).toBe(1);
  });

  it("单字符插入距离为 1", () => {
    expect(levenshteinDistance("cat", "cats")).toBe(1);
  });

  it("单字符删除距离为 1", () => {
    expect(levenshteinDistance("cats", "cat")).toBe(1);
  });

  it("空字符串距离等于另一字符串长度", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });

  it("综合示例", () => {
    // kitten → sitting: 替换 k→s, 插入 g → 距离 2
    // 实际：k→s, e→i, (无), t→t, (无), e→n, n→g → 3
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
  });
});

// ============================================================
// formatPathNotFoundError
// ============================================================

describe("formatPathNotFoundError", () => {
  it("文件不存在 + 父目录存在 → 含 CWD", () => {
    const msg = formatPathNotFoundError("/tmp/nonexistent-file-12345.txt", "/home/user");
    expect(msg).toContain("错误: 文件不存在");
    expect(msg).toContain("/tmp/nonexistent-file-12345.txt");
    expect(msg).toContain("当前工作目录: /home/user");
  });

  it("文件不存在 + 父目录不存在 → 含父目录提示", () => {
    const msg = formatPathNotFoundError("/nonexistent-dir-12345/file.txt", "/home/user");
    expect(msg).toContain("父目录");
    expect(msg).toContain("也不存在");
    expect(msg).toContain("当前工作目录: /home/user");
  });

  it("相似文件建议：父目录存在相似文件时给出提示", () => {
    // 使用实际存在的目录测试（系统 /tmp 可能有很多临时文件，不用它）
    // 用 tests 目录，它肯定有一些 .test.ts 文件
    const cwd = process.cwd();
    const msg = formatPathNotFoundError(
      resolve(cwd, "tests/tool/nonexistent-test.ts"),
      cwd,
      3,
    );
    // 应该提示父目录信息（tests/tool/ 存在）
    expect(msg).toContain("错误: 文件不存在");
    expect(msg).toContain("当前工作目录");
  });

  it("文件名拼错（父目录存在）→ 给出相似文件名", () => {
    const cwd = process.cwd();
    // path-util.ts 少一个 s，真实文件是 path-utils.ts。
    // 这条用例的前提是「父目录**真的存在**」（才能列目录找相似文件），
    // 所以目录部分必须跟着 P2-2 分包走到 packages/core/src/tool/；
    // 而文件名 path-util.ts 是故意拼错的输入，保持不变。
    const msg = formatPathNotFoundError(
      resolve(cwd, "packages/core/src/tool/path-util.ts"),
      cwd,
      3,
    );
    expect(msg).toContain("目录中存在相似文件");
    expect(msg).toContain("path-utils.ts");
  });

  it("目录段拼错（父目录不存在）→ 向上回溯并给出正确目录段候选", () => {
    const cwd = process.cwd();
    // src 写成 srcc（多一个 c），后续段全都不存在 → 父目录不存在分支
    const msg = formatPathNotFoundError(
      resolve(cwd, "srcc/tool/path-utils.ts"),
      cwd,
      3,
    );
    expect(msg).toContain("也不存在");
    expect(msg).toContain('路径段 "srcc" 疑似应为 "src"');
    // 给出可尝试的完整路径（把正确段拼回去）。
    // 注意这里**故意**是 `src/tool/...` 而非分包后的 packages/core/src/...：
    // 被测函数只做「段级拼写纠错」（srcc → src），它纠正的是输入里那一段，
    // 不会替你补出包路径。断言必须跟被测行为一致，不能跟着分包改。
    expect(msg).toContain("可尝试完整路径");
    expect(msg).toContain(resolve(cwd, "src/tool/path-utils.ts"));
  });

  it("目录段被吞掉分隔符（& 被终端吞掉的症状）→ 归一后精确命中", () => {
    // 构造一个真实存在的祖先 + 一个"去掉 & 后"的错误段。
    // 用 tests 目录建一个临时子目录名带 &，再用去掉 & 的名字查询。
    const { mkdtempSync, mkdirSync, rmSync } = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    const base = mkdtempSync(resolve(os.tmpdir(), "pathfix-"));
    try {
      // 真实目录名带 &
      mkdirSync(resolve(base, "本体&管道&数据 (2)(2)"));
      // 查询时 & 被吞掉
      const msg = formatPathNotFoundError(
        resolve(base, "本体管道数据 (2)(2)/a.tsx"),
        base,
        3,
      );
      expect(msg).toContain("也不存在");
      expect(msg).toContain('疑似应为 "本体&管道&数据 (2)(2)"');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("完全乱写、无任何相似段 → 回退到通用提示，不误报候选", () => {
    const msg = formatPathNotFoundError(
      "/zzz-nonexistent-qqq-9876/xxx/yyy.ts",
      "/home/user",
    );
    expect(msg).toContain("路径可能整体有误");
    expect(msg).not.toContain("疑似应为");
  });

  it("极深路径：存在的祖先超出回溯上限（8 层）→ 放弃建议，退回通用提示", () => {
    const { mkdtempSync, rmSync } = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    // base 存在，但在它下面接 >8 层全不存在的段，最深处的文件报错时
    // 向上回溯到 base 需要超过 8 层 → 应放弃建议
    const base = mkdtempSync(resolve(os.tmpdir(), "pathfix-deep-"));
    try {
      // base/a1/a2/.../a10/file.ts —— base 之上有 10 层不存在的段
      const deep = resolve(base, Array.from({ length: 10 }, (_, i) => `a${i + 1}`).join("/"), "file.ts");
      const msg = formatPathNotFoundError(deep, base, 3);
      expect(msg).toContain("也不存在");
      // 回溯上限内探不到 base（唯一存在的祖先），故不应给出"疑似应为"
      expect(msg).toContain("路径可能整体有误");
      expect(msg).not.toContain("疑似应为");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
