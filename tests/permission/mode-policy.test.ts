/**
 * 权限模式企业策略管控测试（P2-2：disableBypassPermissionsMode + disabledModes）
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  setModePolicy,
  isModeDisabledByPolicy,
  isBypassDisabledByPolicy,
  __resetModePolicy,
} from "../../src/permission/mode-policy.ts";

afterEach(() => __resetModePolicy());

describe("mode-policy - disableBypassPermissionsMode", () => {
  test("disable 时 bypass 类模式被禁用", () => {
    setModePolicy(undefined, "disable");
    expect(isBypassDisabledByPolicy()).toBe(true);
    expect(isModeDisabledByPolicy("always-allow")).toBe(true);
    expect(isModeDisabledByPolicy("dangerously-skip-permissions")).toBe(true);
    // 非 bypass 模式不受影响
    expect(isModeDisabledByPolicy("acceptEdits")).toBe(false);
    expect(isModeDisabledByPolicy("default")).toBe(false);
  });

  test("allow / 缺省时 bypass 可用", () => {
    setModePolicy(undefined, "allow");
    expect(isBypassDisabledByPolicy()).toBe(false);
    expect(isModeDisabledByPolicy("always-allow")).toBe(false);
  });

  test("未设置策略时默认不禁用任何模式", () => {
    expect(isBypassDisabledByPolicy()).toBe(false);
    expect(isModeDisabledByPolicy("always-allow")).toBe(false);
    expect(isModeDisabledByPolicy("acceptEdits")).toBe(false);
  });
});

describe("mode-policy - disabledModes（通用）", () => {
  test("禁用任意模式", () => {
    setModePolicy(["acceptEdits", "auto"], undefined);
    expect(isModeDisabledByPolicy("acceptEdits")).toBe(true);
    expect(isModeDisabledByPolicy("auto")).toBe(true);
    expect(isModeDisabledByPolicy("default")).toBe(false);
  });

  test("disabledModes 与 bypass killswitch 叠加生效", () => {
    setModePolicy(["auto"], "disable");
    expect(isModeDisabledByPolicy("auto")).toBe(true);
    expect(isModeDisabledByPolicy("always-allow")).toBe(true);
    expect(isModeDisabledByPolicy("acceptEdits")).toBe(false);
  });
});
