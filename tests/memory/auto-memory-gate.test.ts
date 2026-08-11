/**
 * M2：auto-memory 开关门控测试
 * 验证 isAutoMemoryEnabled 的优先级：env > settings > 默认 true。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { isAutoMemoryEnabled } from "@sid-code/core/memory/paths.ts";

const ENV_KEY = "SID_CODE_AUTO_MEMORY";

describe("isAutoMemoryEnabled（M2 开关门控）", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  test("默认（无 env、无 settings）→ 启用", () => {
    delete process.env[ENV_KEY];
    expect(isAutoMemoryEnabled(undefined)).toBe(true);
  });

  test("settings=true → 启用", () => {
    delete process.env[ENV_KEY];
    expect(isAutoMemoryEnabled(true)).toBe(true);
  });

  test("settings=false → 禁用", () => {
    delete process.env[ENV_KEY];
    expect(isAutoMemoryEnabled(false)).toBe(false);
  });

  test("env=0 覆盖 settings=true → 禁用", () => {
    process.env[ENV_KEY] = "0";
    expect(isAutoMemoryEnabled(true)).toBe(false);
  });

  test("env=1 覆盖 settings=false → 启用", () => {
    process.env[ENV_KEY] = "1";
    expect(isAutoMemoryEnabled(false)).toBe(true);
  });

  test("env 支持 false/off/no（不区分大小写）→ 禁用", () => {
    for (const v of ["false", "FALSE", "off", "No"]) {
      process.env[ENV_KEY] = v;
      expect(isAutoMemoryEnabled(true)).toBe(false);
    }
  });

  test("env 支持 true/on/yes（不区分大小写）→ 启用", () => {
    for (const v of ["true", "ON", "yes"]) {
      process.env[ENV_KEY] = v;
      expect(isAutoMemoryEnabled(false)).toBe(true);
    }
  });

  test("env 空串 → 回退 settings", () => {
    process.env[ENV_KEY] = "";
    expect(isAutoMemoryEnabled(false)).toBe(false);
    expect(isAutoMemoryEnabled(true)).toBe(true);
  });

  test("env 无法解析（乱值）→ 回退 settings", () => {
    process.env[ENV_KEY] = "maybe";
    expect(isAutoMemoryEnabled(false)).toBe(false);
    expect(isAutoMemoryEnabled(undefined)).toBe(true);
  });
});
