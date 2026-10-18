/**
 * 2026-10-18 回归：带 ANSI 颜色的文本不能被判成二进制。
 *
 * 事故：后台任务 `bun install | tail -3` 在 FORCE_COLOR=3 下写进 `.output` 的 122 字节里
 * 有 17 个 ESC（13.9%），read 工具按「不可打印占比 > 10%」判成二进制拒读。
 * 下面的 SAMPLE_HEX 是同一条命令在本机复现出的 123 字节原样输出。
 *
 * 判据边界：只跳过结构完整的 CSI / OSC 序列；孤立 ESC、截断序列、NUL 照旧拒绝。
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectBinaryContent, scanControlChars } from "@sid-code/core/tool/binary-detect.ts";
import { isBinaryOutput } from "@sid-code/core/tool/bash.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";

const SAMPLE_HEX =
  "1b5b306d1b5b33326d2b1b5b306d201b5b316d7669746570726573731b5b306d1b5b326d40312e362e341b5b306d0a0a" +
  "1b5b33326d3132371b5b306d207061636b616765731b5b306d20696e7374616c6c6564201b5b306d1b5b326d5b1b5b316d" +
  "3130302e30306d731b5b306d1b5b326d5d1b5b306d1b5b306d0a";
const SAMPLE = Buffer.from(SAMPLE_HEX, "hex");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmpFile(content: Buffer | string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "binary-ansi-"));
  tmpDirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("detectBinaryContent — ANSI 转义序列", () => {
  test("事故样本：17 个 SGR 序列全部跳过，不判二进制", () => {
    // 前提自检：样本里 ESC 占比确实超过旧阈值，否则这条用例证明不了任何事
    const escCount = [...SAMPLE].filter((b) => b === 0x1b).length;
    expect(escCount / SAMPLE.length).toBeGreaterThan(0.1);

    const r = detectBinaryContent(SAMPLE);
    expect(r.isBinary).toBe(false);
    expect(r.nonPrintableCount).toBe(0);
    expect(r.ansiSequenceCount).toBe(escCount);
  });

  test("光标控制 / 擦行（进度条常用）与带中间字节的 CSI 也算合法序列", () => {
    const text = "\x1b[2K\x1b[1G50%\x1b[?25l\x1b[23D\x1b[0K done \x1b[1 q\x1b[?25h\n";
    expect(detectBinaryContent(Buffer.from(text)).isBinary).toBe(false);
  });

  test("OSC 8 超链接（BEL 与 ST 两种终止）不计数", () => {
    const text = "\x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\ and \x1b]0;title\x07";
    const r = detectBinaryContent(Buffer.from(text));
    expect(r.isBinary).toBe(false);
    expect(r.ansiSequenceCount).toBe(3);
  });

  test("孤立 ESC 仍按不可打印计数", () => {
    const buf = Buffer.from("\x1b".repeat(15) + "A".repeat(85));
    const r = detectBinaryContent(buf);
    expect(r.isBinary).toBe(true);
    expect(r.reason).toBe("ratio");
    expect(r.nonPrintableCount).toBe(15);
  });

  test("截断的 CSI（缺终止字节）不当成合法序列", () => {
    // 末尾补 \n 隔开：`ESC [ A` 本身就是合法的「光标上移」，不能直接接字母
    const r = detectBinaryContent(Buffer.from("\x1b[".repeat(15) + "\n" + "A".repeat(70)));
    expect(r.ansiSequenceCount).toBe(0);
    expect(r.nonPrintableCount).toBe(15);
    expect(r.isBinary).toBe(true);
  });

  test("未终止的 OSC 不吞掉后续控制字符", () => {
    const buf = Buffer.from("\x1b]" + "x".repeat(10) + "\x01".repeat(20) + "A".repeat(50));
    const r = detectBinaryContent(buf);
    expect(r.ansiSequenceCount).toBe(0);
    expect(r.isBinary).toBe(true);
  });

  test("其它 C0 控制字符不受影响", () => {
    const buf = Buffer.alloc(100, 0x41);
    for (let i = 0; i < 15; i++) buf[i] = 0x01;
    expect(detectBinaryContent(buf).isBinary).toBe(true);
  });

  test("NUL 一票否决不变（即便混在彩色文本里）", () => {
    const r = detectBinaryContent(Buffer.from("\x1b[31mred\x1b[0m\x00tail"));
    expect(r.isBinary).toBe(true);
    expect(r.reason).toBe("nul");
    expect(r.firstOffset).toBe(12);
  });

  test("scanControlChars 对字节与 UTF-16 码元给出同一计数", () => {
    const text = SAMPLE.toString("latin1");
    const asBytes = scanControlChars(SAMPLE.length, (i) => SAMPLE[i]!);
    const asChars = scanControlChars(text.length, (i) => text.charCodeAt(i));
    expect(asChars).toEqual(asBytes);
  });
});

describe("Read 工具 — 读带颜色的任务输出", () => {
  test("事故样本能直接读出，内容与磁盘一致（不剥 ANSI）", async () => {
    const p = tmpFile(SAMPLE, "sk-sample.output");
    const result = await new ReadTool().execute({ file_path: p });
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("\x1b[32m127\x1b[0m packages");
  });
});

describe("bash isBinaryOutput — 彩色输出不被替换成二进制提示", () => {
  test("ESC 密度超过 30% 的重绘输出仍是文本", () => {
    // spinner / 进度条每帧「光标上移 + 擦行」，ESC 占 2/6
    const dense = "\x1b[A\x1b[K".repeat(200);
    // 前提自检：旧算法下 ESC 占比确实 > 30%，否则这条用例证明不了任何事
    const sample = dense.slice(0, 1000);
    const escRatio = [...sample].filter((c) => c === "\x1b").length / sample.length;
    expect(escRatio).toBeGreaterThan(0.3);
    expect(isBinaryOutput(dense)).toBe(false);
  });

  test("孤立控制字符密集时仍判二进制", () => {
    expect(isBinaryOutput("\x01\x02\x03A".repeat(50))).toBe(true);
  });

  test("NUL 仍判二进制", () => {
    expect(isBinaryOutput("\x1b[1mok\x1b[0m\0")).toBe(true);
  });
});
