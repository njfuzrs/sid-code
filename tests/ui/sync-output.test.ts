import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  isSynchronizedOutputSupported,
  type SyncOutputEnv,
} from "../../src/ui/utils/sync-output.ts";

describe("compareVersions", () => {
  test("基本大小比较", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.1.0", "1.2.0")).toBeLessThan(0);
    expect(compareVersions("3.6.6", "3.6.6")).toBe(0);
  });

  test("段数不等按 0 补齐", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
  });

  test("undefined 视为 0/空", () => {
    expect(compareVersions(undefined, "0.0.0")).toBe(0);
    expect(compareVersions("1.0.0", undefined)).toBeGreaterThan(0);
  });

  test("非数字段宽松解析为 0,不抛错", () => {
    expect(() => compareVersions("1.x.3", "1.0.3")).not.toThrow();
    expect(compareVersions("1.x.3", "1.0.3")).toBe(0);
  });
});

describe("isSynchronizedOutputSupported", () => {
  test("Ghostty 1.2+ 支持,1.1 不支持", () => {
    const yes: SyncOutputEnv = {
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "1.2.0",
    };
    const no: SyncOutputEnv = {
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "1.1.9",
    };
    expect(isSynchronizedOutputSupported(yes)).toBe(true);
    expect(isSynchronizedOutputSupported(no)).toBe(false);
  });

  test("iTerm2 3.6.6+ 支持,3.6.5 不支持", () => {
    expect(
      isSynchronizedOutputSupported({
        TERM_PROGRAM: "iTerm.app",
        TERM_PROGRAM_VERSION: "3.6.6",
      }),
    ).toBe(true);
    expect(
      isSynchronizedOutputSupported({
        TERM_PROGRAM: "iTerm.app",
        TERM_PROGRAM_VERSION: "3.6.5",
      }),
    ).toBe(false);
  });

  test("ConEmu 总是支持", () => {
    expect(isSynchronizedOutputSupported({ ConEmuPID: "1234" })).toBe(true);
  });

  test("WezTerm 支持", () => {
    expect(
      isSynchronizedOutputSupported({ TERM_PROGRAM: "WezTerm" }),
    ).toBe(true);
  });

  test("foot / kitty 通过 TERM 识别", () => {
    expect(isSynchronizedOutputSupported({ TERM: "foot" })).toBe(true);
    expect(isSynchronizedOutputSupported({ TERM: "xterm-kitty" })).toBe(true);
  });

  test("未知终端返回 false", () => {
    expect(
      isSynchronizedOutputSupported({
        TERM_PROGRAM: "Apple_Terminal",
        TERM: "xterm-256color",
      }),
    ).toBe(false);
    expect(isSynchronizedOutputSupported({})).toBe(false);
  });

  test("大小写不敏感", () => {
    expect(
      isSynchronizedOutputSupported({
        TERM_PROGRAM: "Ghostty",
        TERM_PROGRAM_VERSION: "1.3.0",
      }),
    ).toBe(true);
  });
});
