/**
 * 自动更新 — 配置解析单元测试
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { resolveAutoUpdateMode } from "@sid-code/core/update/config.ts";

describe("resolveAutoUpdateMode", () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.SID_CODE_AUTO_UPDATE;
    delete process.env.SID_CODE_AUTO_UPDATE;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SID_CODE_AUTO_UPDATE;
    else process.env.SID_CODE_AUTO_UPDATE = prevEnv;
  });

  test("默认值 auto", () => {
    expect(resolveAutoUpdateMode()).toBe("auto");
    expect(resolveAutoUpdateMode(undefined)).toBe("auto");
  });

  test("settings 值生效", () => {
    expect(resolveAutoUpdateMode("off")).toBe("off");
    expect(resolveAutoUpdateMode("notify")).toBe("notify");
    expect(resolveAutoUpdateMode("auto")).toBe("auto");
  });

  test("settings 大小写不敏感", () => {
    expect(resolveAutoUpdateMode("OFF")).toBe("off");
    expect(resolveAutoUpdateMode("Notify")).toBe("notify");
    expect(resolveAutoUpdateMode("AUTO")).toBe("auto");
  });

  test("env 优先于 settings", () => {
    process.env.SID_CODE_AUTO_UPDATE = "off";
    expect(resolveAutoUpdateMode("auto")).toBe("off");
    expect(resolveAutoUpdateMode("notify")).toBe("off");
  });

  test("env 大小写不敏感", () => {
    process.env.SID_CODE_AUTO_UPDATE = "OFF";
    expect(resolveAutoUpdateMode()).toBe("off");
  });

  test("非法 settings 值回退默认", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveAutoUpdateMode("invalid")).toBe("auto");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("非法 env 值回退 settings", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    process.env.SID_CODE_AUTO_UPDATE = "invalid";
    expect(resolveAutoUpdateMode("off")).toBe("off");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("非法 env 值回退默认（settings 也未设）", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    process.env.SID_CODE_AUTO_UPDATE = "invalid";
    expect(resolveAutoUpdateMode()).toBe("auto");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
