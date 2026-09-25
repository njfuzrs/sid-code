/**
 * PR-6.3：远程 bridgeEnabled 进 PolicySettings，并决定准入。
 *
 * 省略 = 不关。远程 false 必须赢过本机 settings 的 true。
 * 直接走 sanitizeRemotePolicy + applyLoadedPolicy，不打网络。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sanitizeRemotePolicy, applyLoadedPolicy } from "@sid-code/core/config/policy.ts";
import {
  isBridgePolicyEnabled,
  setLocalBridgeEnabled,
  __resetBridgePolicy,
} from "@sid-code/core/bridge/bridge-policy.ts";
import { checkBridgeAdmission } from "@sid-code/core/bridge/admission.ts";

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-bridge-policy-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = dir;
  __resetBridgePolicy();
});

afterEach(() => {
  __resetBridgePolicy();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("远程 bridgeEnabled", () => {
  test("false → 合法 wss 也 policy-disabled", async () => {
    const settings = sanitizeRemotePolicy({ source: "remote", bridgeEnabled: false });
    expect(settings?.bridgeEnabled).toBe(false);
    applyLoadedPolicy(settings);
    expect(isBridgePolicyEnabled()).toBe(false);
    const r = await checkBridgeAdmission({
      url: "wss://relay.example.com/bridge/ws",
      policyEnabled: isBridgePolicyEnabled(),
      confirm: async () => true,
    });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.reason).toBe("policy-disabled");
  });

  test("省略该字段 → 不关", async () => {
    const settings = sanitizeRemotePolicy({ source: "remote", disableAllHooks: false });
    expect(settings?.bridgeEnabled).toBeUndefined();
    applyLoadedPolicy(settings);
    expect(isBridgePolicyEnabled()).toBeUndefined();
    const r = await checkBridgeAdmission({
      url: "wss://relay.example.com/bridge/ws",
      policyEnabled: isBridgePolicyEnabled(),
      confirm: async () => true,
    });
    expect(r.allowed).toBe(true);
  });

  test("远程 false + 本机 settings true → 仍拒绝", async () => {
    setLocalBridgeEnabled(true);
    const settings = sanitizeRemotePolicy({ source: "remote", bridgeEnabled: false });
    applyLoadedPolicy(settings);
    expect(isBridgePolicyEnabled()).toBe(false);
    const r = await checkBridgeAdmission({
      url: "wss://relay.example.com/bridge/ws",
      policyEnabled: isBridgePolicyEnabled(),
      confirm: async () => true,
    });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.reason).toBe("policy-disabled");
  });

  test("非 boolean 被剥掉，未知键不把整份丢掉", () => {
    const settings = sanitizeRemotePolicy({
      source: "remote",
      bridgeEnabled: "false",
      notAField: 1,
    });
    expect(settings).not.toBeNull();
    expect(settings?.bridgeEnabled).toBeUndefined();
    expect(settings && "notAField" in settings).toBe(false);
  });

  test("下一次远程省略必须清掉上一次的 false", () => {
    applyLoadedPolicy(sanitizeRemotePolicy({ bridgeEnabled: false }));
    expect(isBridgePolicyEnabled()).toBe(false);
    applyLoadedPolicy(sanitizeRemotePolicy({ source: "remote" }));
    expect(isBridgePolicyEnabled()).toBeUndefined();
  });

  test("本机 true 只在远程没表态时生效", () => {
    setLocalBridgeEnabled(true);
    expect(isBridgePolicyEnabled()).toBe(true);
    applyLoadedPolicy(sanitizeRemotePolicy({ bridgeEnabled: false }));
    expect(isBridgePolicyEnabled()).toBe(false);
  });
});
