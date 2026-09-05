/**
 * Bridge 准入检查（D14 —— 十六条里唯一一条安全性质的）
 *
 * ⚠️ **这组用例的存在本身就是被要求的量化动作之一**：
 * 安全是"坏事没发生"，负面事件天然稀疏、分母恒 0、曲线恒平，
 * **分不清「防线起作用」和「运气好」**。本仓 `scripts/defense-trigger-rate.ts`
 * 实测出过 0% 触发（防线全在、调用全 0，防线自己成了死功能）。
 * 所以「加了防线」和「防线被触发过」必须当两个事实分别验证 ——
 * 下面每一条拒绝路径都被显式触发过一次，就是后者的最小证据。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  checkBridgeAdmission,
  normalizeBridgeUrl,
  isBridgeUrlTrusted,
  revokeBridgeUrl,
  buildConfirmPrompt,
} from "@sid-code/core/bridge/admission.ts";

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  // 隔离：信任文件落到 tmpdir，绝不碰真实的 ~/.sid-code/
  dir = mkdtempSync(join(tmpdir(), "sid-bridge-admission-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = dir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("normalizeBridgeUrl", () => {
  test("剥掉 query —— 认证 token 常挂在那里，不能落盘", () => {
    const key = normalizeBridgeUrl("wss://relay.example.com/ws?token=SECRET123");
    expect(key).not.toContain("SECRET123");
    expect(key).toBe("wss://relay.example.com/ws");
  });

  test("尾斜杠与大小写归一（同一端点不该被问两次）", () => {
    expect(normalizeBridgeUrl("wss://Relay.Example.com/")).toBe(
      normalizeBridgeUrl("wss://relay.example.com"),
    );
  });

  test("非 ws/wss 协议一律不合法", () => {
    for (const bad of ["https://a.com", "http://a.com", "file:///etc/passwd", "不是url"]) {
      expect(normalizeBridgeUrl(bad)).toBeNull();
    }
  });
});

describe("checkBridgeAdmission · 拒绝路径（逐条触发一次）", () => {
  test("企业 policy 显式 false → 直接拒绝，且不问人", async () => {
    let asked = false;
    const r = await checkBridgeAdmission({
      url: "wss://relay.example.com",
      policyEnabled: false,
      confirm: async () => {
        asked = true;
        return true;
      },
    });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.reason).toBe("policy-disabled");
    // 顺序判据：policy 拒掉的 URL 不该让用户白确认一次
    expect(asked).toBe(false);
  });

  test("policy 未配置（undefined）不拦 —— 否则现存用户升级即被拦", async () => {
    const r = await checkBridgeAdmission({
      url: "wss://relay.example.com",
      policyEnabled: undefined,
      confirm: async () => true,
    });
    expect(r.allowed).toBe(true);
  });

  test("明文 ws:// 未显式允许 → 拒绝", async () => {
    const r = await checkBridgeAdmission({
      url: "ws://relay.example.com",
      confirm: async () => true,
    });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.reason).toBe("insecure-scheme");
  });

  test("明文 ws:// + allowInsecure → 放行（显式 opt-in）", async () => {
    const r = await checkBridgeAdmission({
      url: "ws://relay.example.com",
      allowInsecure: true,
      confirm: async () => true,
    });
    expect(r.allowed).toBe(true);
  });

  test("非法 URL → 拒绝", async () => {
    const r = await checkBridgeAdmission({ url: "https://a.com", confirm: async () => true });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.reason).toBe("invalid-url");
  });

  test("用户当面拒绝 → 拒绝，且不写信任记录", async () => {
    const r = await checkBridgeAdmission({
      url: "wss://relay.example.com",
      confirm: async () => false,
    });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.reason).toBe("user-declined");
    expect(await isBridgeUrlTrusted("wss://relay.example.com")).toBe(false);
  });

  test("无法交互（confirm 缺失）→ fail-closed 拒绝，绝不默认放行", async () => {
    const r = await checkBridgeAdmission({ url: "wss://relay.example.com" });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.reason).toBe("non-interactive");
  });
});

describe("checkBridgeAdmission · 信任记忆", () => {
  test("首次确认后记住，第二次不再问", async () => {
    let askCount = 0;
    const confirm = async () => {
      askCount++;
      return true;
    };

    const first = await checkBridgeAdmission({ url: "wss://relay.example.com", confirm });
    expect(first.allowed && first.reason).toBe("user-confirmed");
    expect(askCount).toBe(1);

    const second = await checkBridgeAdmission({ url: "wss://relay.example.com", confirm });
    expect(second.allowed && second.reason).toBe("already-trusted");
    expect(askCount).toBe(1); // 没有再问
  });

  test("换一个 URL 要重新确认（信任的是端点，不是「用过 bridge」这件事）", async () => {
    let askCount = 0;
    const confirm = async () => {
      askCount++;
      return true;
    };
    await checkBridgeAdmission({ url: "wss://a.example.com", confirm });
    await checkBridgeAdmission({ url: "wss://b.example.com", confirm });
    expect(askCount).toBe(2);
  });

  test("同一端点带不同 token 只问一次（token 不进信任键）", async () => {
    let askCount = 0;
    const confirm = async () => {
      askCount++;
      return true;
    };
    await checkBridgeAdmission({ url: "wss://relay.example.com/ws?token=AAA", confirm });
    await checkBridgeAdmission({ url: "wss://relay.example.com/ws?token=BBB", confirm });
    expect(askCount).toBe(1);
  });

  test("落盘的信任文件里不含 token", async () => {
    await checkBridgeAdmission({
      url: "wss://relay.example.com/ws?token=SUPERSECRET",
      confirm: async () => true,
    });
    const { sidPaths } = await import("@sid-code/core/config/paths.ts");
    const file = sidPaths.trustedBridgeUrls();
    expect(existsSync(file)).toBe(true);
    const raw = await Bun.file(file).text();
    expect(raw).not.toContain("SUPERSECRET");
  });

  test("revoke 后重新询问", async () => {
    let askCount = 0;
    const confirm = async () => {
      askCount++;
      return true;
    };
    await checkBridgeAdmission({ url: "wss://relay.example.com", confirm });
    expect(await revokeBridgeUrl("wss://relay.example.com")).toBe(true);
    await checkBridgeAdmission({ url: "wss://relay.example.com", confirm });
    expect(askCount).toBe(2);
  });

  test("skipPersist 时不落盘（测试与一次性场景用）", async () => {
    await checkBridgeAdmission({
      url: "wss://relay.example.com",
      confirm: async () => true,
      skipPersist: true,
    });
    expect(await isBridgeUrlTrusted("wss://relay.example.com")).toBe(false);
  });
});

describe("确认文案", () => {
  test("说清能力与「批准者就是远端」这件事，而不只是问要不要连", async () => {
    const prompt = buildConfirmPrompt("wss://relay.example.com");
    expect(prompt).toContain("wss://relay.example.com");
    expect(prompt).toContain("shell");
    // 用户必须被告知权限体系在这条路径上是自证的，否则会以为还有下一道门
    expect(prompt).toContain("批准者就是它自己");
  });
});
