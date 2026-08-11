/**
 * 剪贴板图片 / 拖放路径识别测试（P2-6 / P2-7）
 *
 * detectDroppedImagePath 是纯逻辑（去引号/去 file:// /扩展名判断/存在性），可稳定单测。
 * readClipboardImageToFile 依赖系统工具与真实剪贴板，CI 不可控——只验证"无图/无工具时
 * 返回 null 不抛错"这一契约（不断言拿到图）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDroppedImagePath, readClipboardImageToFile, IMAGE_EXTS } from "@sid-code/cli/ui/utils/clipboard-image.ts";

const tmpDirs: string[] = [];
function makeTmpImage(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sid-clip-test-"));
  tmpDirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // 假 PNG 头，非空即可
  return p;
}

afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("detectDroppedImagePath（P2-7）", () => {
  test("真实存在的图片路径 → 返回该路径", () => {
    const p = makeTmpImage("shot.png");
    expect(detectDroppedImagePath(p)).toBe(p);
  });

  test("去掉成对引号", () => {
    const p = makeTmpImage("a.jpg");
    expect(detectDroppedImagePath(`"${p}"`)).toBe(p);
    expect(detectDroppedImagePath(`'${p}'`)).toBe(p);
  });

  test("file:// URI → 本地路径", () => {
    const p = makeTmpImage("b.webp");
    const uri = "file://" + p;
    expect(detectDroppedImagePath(uri)).toBe(p);
  });

  test("非图片扩展名 → null", () => {
    const dir = mkdtempSync(join(tmpdir(), "sid-clip-test-"));
    tmpDirs.push(dir);
    const p = join(dir, "notes.txt");
    writeFileSync(p, "hi");
    expect(detectDroppedImagePath(p)).toBeNull();
  });

  test("不存在的图片路径 → null", () => {
    expect(detectDroppedImagePath("/no/such/img.png")).toBeNull();
  });

  test("多行文本 → null（不是单文件拖放）", () => {
    const p = makeTmpImage("c.png");
    expect(detectDroppedImagePath(`${p}\nsome other line`)).toBeNull();
  });

  test("普通文本 → null", () => {
    expect(detectDroppedImagePath("just some pasted text")).toBeNull();
    expect(detectDroppedImagePath("")).toBeNull();
  });

  test("IMAGE_EXTS 覆盖 vision 四格式 + jpg 别名", () => {
    for (const e of [".png", ".jpg", ".jpeg", ".gif", ".webp"]) {
      expect(IMAGE_EXTS.has(e)).toBe(true);
    }
    expect(IMAGE_EXTS.has(".bmp")).toBe(false);
    expect(IMAGE_EXTS.has(".tiff")).toBe(false);
  });
});

describe("readClipboardImageToFile（P2-6 契约）", () => {
  test("无图/无工具时返回 null 且不抛错", () => {
    // CI 剪贴板通常无图片，或系统无 pngpaste/xclip/wl-paste。契约：返回 null，绝不抛。
    let result: string | null = null;
    expect(() => { result = readClipboardImageToFile(1234567890); }).not.toThrow();
    // 可能为 null（无图）或极少数环境真有图返回路径——只要不抛且类型正确即通过。
    expect(result === null || typeof result === "string").toBe(true);
  });
});
