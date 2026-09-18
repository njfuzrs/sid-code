/**
 * 自动更新 — 版本号比较与校验单元测试
 */

import { describe, test, expect } from "bun:test";
import {
  isValidVersion,
  compareVersions,
  isPrereleaseVersion,
} from "@sid-code/core/update/versions.ts";

describe("versions", () => {
  describe("isValidVersion", () => {
    test("合法版本号", () => {
      expect(isValidVersion("0.1.603")).toBe(true);
      expect(isValidVersion("1.0.0")).toBe(true);
      expect(isValidVersion("10.20.30")).toBe(true);
      expect(isValidVersion("0.0.1")).toBe(true);
    });

    test("非法版本号", () => {
      expect(isValidVersion("")).toBe(false);
      expect(isValidVersion("0.1")).toBe(false);
      expect(isValidVersion("0.1.2.3")).toBe(false);
      expect(isValidVersion("v0.1.603")).toBe(false); // 带前缀
      expect(isValidVersion("0.1.603-beta.1")).toBe(false); // prerelease
      expect(isValidVersion("abc")).toBe(false);
      expect(isValidVersion("0.1.x")).toBe(false);
    });
  });

  describe("isPrereleaseVersion", () => {
    test("prerelease 版本", () => {
      expect(isPrereleaseVersion("0.2.0-beta.1")).toBe(true);
      expect(isPrereleaseVersion("1.0.0-alpha")).toBe(true);
      expect(isPrereleaseVersion("2.3.4-rc.2")).toBe(true);
    });

    test("稳定版本", () => {
      expect(isPrereleaseVersion("0.1.603")).toBe(false);
      expect(isPrereleaseVersion("1.0.0")).toBe(false);
    });
  });

  describe("compareVersions", () => {
    test("相等", () => {
      expect(compareVersions("0.1.603", "0.1.603")).toBe(0);
      expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    });

    test("major 比较", () => {
      expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
      expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
    });

    test("minor 比较", () => {
      expect(compareVersions("1.2.0", "1.1.0")).toBe(1);
      expect(compareVersions("1.1.0", "1.2.0")).toBe(-1);
    });

    test("patch 比较", () => {
      expect(compareVersions("1.0.2", "1.0.1")).toBe(1);
      expect(compareVersions("1.0.1", "1.0.2")).toBe(-1);
    });

    test("复合比较", () => {
      expect(compareVersions("1.2.3", "1.2.2")).toBe(1);
      expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
      expect(compareVersions("0.1.603", "0.1.602")).toBe(1);
    });

    test("非法版本号抛错", () => {
      expect(() => compareVersions("invalid", "1.0.0")).toThrow();
      expect(() => compareVersions("1.0.0", "v1.0.0")).toThrow();
    });
  });
});
