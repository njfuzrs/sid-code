/**
 * M1 身份：deviceId 持久化、identity 配置段、凭据 fail-open。
 *
 * 验收（规划 PR-1.1 / 1.4）：
 * - 第二次启动 device-id 不变
 * - 删文件 / 损坏后重建有告警
 * - 未配置 identity 时所有功能正常（getIdentity 仍返回 deviceId）
 * - 凭据过期不阻断，只告警 + 不带 Authorization
 *
 * 隔离：SID_CONFIG_DIR → tmpdir。必须存/恢复原值，不能无条件 delete。
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { ensureConfigGitignore } from "@sid-code/core/config/ensure-gitignore.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import {
  __resetIdentityForTest,
  applyDeviceAuth,
  clearDeviceCredential,
  coalesceIdentity,
  getDeviceCredential,
  getIdentity,
  getOrCreateDeviceId,
  getUsableCredentialToken,
  saveDeviceCredential,
  setIdentityConfig,
} from "@sid-code/core/identity/index.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let tmpDir: string;
let prevConfigDir: string | undefined;
let prevUser: string | undefined;
let prevOrg: string | undefined;
let prevTeam: string | undefined;
let warnSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  prevUser = process.env.SID_CODE_IDENTITY_USER_ID;
  prevOrg = process.env.SID_CODE_IDENTITY_ORG_ID;
  prevTeam = process.env.SID_CODE_IDENTITY_TEAM_ID;
  tmpDir = mkdtempSync(join(tmpdir(), "sid-identity-"));
  process.env.SID_CONFIG_DIR = tmpDir;
  delete process.env.SID_CODE_IDENTITY_USER_ID;
  delete process.env.SID_CODE_IDENTITY_ORG_ID;
  delete process.env.SID_CODE_IDENTITY_TEAM_ID;
  __resetIdentityForTest();
  warnSpy = spyOn(getLogger(), "warn");
});

afterEach(() => {
  warnSpy?.mockRestore();
  __resetIdentityForTest();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  if (prevUser === undefined) delete process.env.SID_CODE_IDENTITY_USER_ID;
  else process.env.SID_CODE_IDENTITY_USER_ID = prevUser;
  if (prevOrg === undefined) delete process.env.SID_CODE_IDENTITY_ORG_ID;
  else process.env.SID_CODE_IDENTITY_ORG_ID = prevOrg;
  if (prevTeam === undefined) delete process.env.SID_CODE_IDENTITY_TEAM_ID;
  else process.env.SID_CODE_IDENTITY_TEAM_ID = prevTeam;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("deviceId 持久化（PR-1.1）", () => {
  test("首次调用写入 UUIDv4，权限 0o600", () => {
    const id = getOrCreateDeviceId();
    expect(id).toMatch(UUID_RE);
    const path = sidPaths.deviceId();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8").trim()).toBe(id);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("第二次启动（清缓存后重读）device-id 不变", () => {
    const first = getOrCreateDeviceId();
    __resetIdentityForTest();
    const second = getOrCreateDeviceId();
    expect(second).toBe(first);
  });

  test("损坏或为空则重新生成并告警，不静默沿用", () => {
    const path = sidPaths.deviceId();
    writeFileSync(path, "not-a-uuid\n", { mode: 0o600 });
    const id = getOrCreateDeviceId();
    expect(id).toMatch(UUID_RE);
    expect(id).not.toBe("not-a-uuid");
    expect(readFileSync(path, "utf-8").trim()).toBe(id);
    expect(warnSpy!.mock.calls.some((c) => String(c[1]).includes("损坏"))).toBe(true);
  });

  test("删文件后重建有告警，并写出新 id", () => {
    const first = getOrCreateDeviceId();
    rmSync(sidPaths.deviceId());
    warnSpy!.mockClear();
    __resetIdentityForTest();
    const second = getOrCreateDeviceId();
    expect(second).toMatch(UUID_RE);
    expect(second).not.toBe(first);
    expect(warnSpy!.mock.calls.some((c: unknown[]) => String(c[1]).includes("不存在"))).toBe(true);
  });

  test("sidPaths.deviceId 落在 SID_CONFIG_DIR 下", () => {
    expect(sidPaths.deviceId()).toBe(join(tmpDir, "device-id"));
    expect(sidPaths.deviceCredential()).toBe(join(tmpDir, "device-credential.json"));
  });
});

describe("identity 配置段（PR-1.1）", () => {
  test("未配置时仍返回 deviceId，user/org/team 缺席", () => {
    const ident = getIdentity();
    expect(ident.deviceId).toMatch(UUID_RE);
    expect(ident.userId).toBeUndefined();
    expect(ident.orgId).toBeUndefined();
    expect(ident.teamId).toBeUndefined();
  });

  test("环境变量注入 user/org/team", () => {
    process.env.SID_CODE_IDENTITY_USER_ID = "zhangsan@corp.com";
    process.env.SID_CODE_IDENTITY_ORG_ID = "corp-shanghai";
    process.env.SID_CODE_IDENTITY_TEAM_ID = "infra-platform";
    const ident = getIdentity();
    expect(ident.userId).toBe("zhangsan@corp.com");
    expect(ident.orgId).toBe("corp-shanghai");
    expect(ident.teamId).toBe("infra-platform");
  });

  test("环境变量优先于 setIdentityConfig", () => {
    setIdentityConfig({ userId: "from-file", orgId: "file-org" });
    process.env.SID_CODE_IDENTITY_USER_ID = "from-env";
    const ident = getIdentity();
    expect(ident.userId).toBe("from-env");
    expect(ident.orgId).toBe("file-org");
  });

  test("coalesceIdentity 按字段后写覆盖，空串视为未设", () => {
    const merged = coalesceIdentity(
      { userId: "file-user", orgId: "file-org" },
      { userId: "env-user", teamId: "env-team" },
      { orgId: "   " },
    );
    expect(merged).toEqual({
      userId: "env-user",
      orgId: "file-org",
      teamId: "env-team",
    });
    expect(coalesceIdentity({}, { userId: "" })).toBeUndefined();
  });
});

describe("设备凭据 fail-open（PR-1.4）", () => {
  test("缺失时 getUsableCredentialToken 返回 undefined，不抛", () => {
    expect(getDeviceCredential()).toBeNull();
    expect(getUsableCredentialToken()).toBeUndefined();
    expect(applyDeviceAuth({ Accept: "application/json" })).toEqual({
      Accept: "application/json",
    });
  });

  test("save 后可读回，权限 0o600，applyDeviceAuth 带 Bearer", () => {
    saveDeviceCredential({
      credential: "secret-token-32bytes-minimum-ok",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      enrolledAt: new Date().toISOString(),
    });
    expect(statSync(sidPaths.deviceCredential()).mode & 0o777).toBe(0o600);
    expect(getUsableCredentialToken()).toBe("secret-token-32bytes-minimum-ok");
    expect(applyDeviceAuth({})).toEqual({
      Authorization: "Bearer secret-token-32bytes-minimum-ok",
    });
  });

  test("过期凭据告警且不带 Authorization（fail-open）", () => {
    saveDeviceCredential({
      credential: "expired-token",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(getUsableCredentialToken()).toBeUndefined();
    expect(applyDeviceAuth({ X: "1" })).toEqual({ X: "1" });
    expect(warnSpy!.mock.calls.some((c: unknown[]) => String(c[1]).includes("过期"))).toBe(true);
  });

  test("损坏文件告警并视为缺失，不阻断", () => {
    writeFileSync(sidPaths.deviceCredential(), "{not json", { mode: 0o600 });
    expect(getDeviceCredential()).toBeNull();
    expect(getUsableCredentialToken()).toBeUndefined();
    expect(warnSpy!.mock.calls.some((c) => String(c[1]).includes("损坏"))).toBe(true);
  });

  test("clearDeviceCredential 删除文件", () => {
    saveDeviceCredential({ credential: "tok" });
    clearDeviceCredential();
    expect(existsSync(sidPaths.deviceCredential())).toBe(false);
    expect(getDeviceCredential()).toBeNull();
  });
});

describe("loadConfig 接线", () => {
  test("settings.json identity 经 loadConfig 生效，env 按字段覆盖", async () => {
    writeFileSync(
      join(tmpDir, "settings.json"),
      JSON.stringify({
        identity: { user_id: "file-user", org_id: "file-org" },
        model: "x",
        availableModels: [{ name: "x", provider: "openai", apiKey: "k".repeat(40) }],
      }),
    );
    process.env.SID_CODE_IDENTITY_USER_ID = "env-user";
    const { loadConfig } = await import("@sid-code/core/config/config.ts");
    const cfg = await loadConfig({ model: "x" });
    expect(cfg.identity?.userId).toBe("env-user");
    expect(cfg.identity?.orgId).toBe("file-org");
    expect(getIdentity().userId).toBe("env-user");
    expect(getIdentity().orgId).toBe("file-org");
  });

  test("trace 未显式配 deviceId 时回落到本机 identity", async () => {
    writeFileSync(
      join(tmpDir, "settings.json"),
      JSON.stringify({
        identity: { userId: "alice@corp.com" },
        model: "x",
        availableModels: [{ name: "x", provider: "openai", apiKey: "k".repeat(40) }],
        trace: { enabled: true, upload: { url: "http://example/traj", token: "t" } },
      }),
    );
    const { loadConfig } = await import("@sid-code/core/config/config.ts");
    const cfg = await loadConfig({ model: "x" });
    expect(cfg.trace?.upload?.userId).toBe("alice@corp.com");
    expect(cfg.trace?.upload?.deviceId).toBe(getOrCreateDeviceId());
  });

  test("SID_CODE_TRACE_DEVICE_ID 仍优先于本机 deviceId（旧变量不删）", async () => {
    const prevTraceDev = process.env.SID_CODE_TRACE_DEVICE_ID;
    const prevTraceUser = process.env.SID_CODE_TRACE_USER_ID;
    const prevTrace = process.env.SID_CODE_TRACE;
    try {
      process.env.SID_CODE_TRACE = "1";
      process.env.SID_CODE_TRACE_UPLOAD_URL = "http://example/traj";
      process.env.SID_CODE_TRACE_UPLOAD_TOKEN = "tok";
      process.env.SID_CODE_TRACE_DEVICE_ID = "explicit-device";
      process.env.SID_CODE_TRACE_USER_ID = "explicit-user";
      const { loadConfig } = await import("@sid-code/core/config/config.ts");
      const cfg = await loadConfig({});
      expect(cfg.trace?.upload?.deviceId).toBe("explicit-device");
      expect(cfg.trace?.upload?.userId).toBe("explicit-user");
    } finally {
      if (prevTraceDev === undefined) delete process.env.SID_CODE_TRACE_DEVICE_ID;
      else process.env.SID_CODE_TRACE_DEVICE_ID = prevTraceDev;
      if (prevTraceUser === undefined) delete process.env.SID_CODE_TRACE_USER_ID;
      else process.env.SID_CODE_TRACE_USER_ID = prevTraceUser;
      if (prevTrace === undefined) delete process.env.SID_CODE_TRACE;
      else process.env.SID_CODE_TRACE = prevTrace;
      delete process.env.SID_CODE_TRACE_UPLOAD_URL;
      delete process.env.SID_CODE_TRACE_UPLOAD_TOKEN;
    }
  });
});

describe("managed-settings identity（PR-1.1）", () => {
  test("managed-settings.json 的 identity 经 loadConfig 生效，env 仍按字段覆盖", async () => {
    writeFileSync(
      join(tmpDir, "settings.json"),
      JSON.stringify({
        identity: { userId: "file-user", orgId: "file-org" },
        model: "x",
        availableModels: [{ name: "x", provider: "openai", apiKey: "k".repeat(40) }],
      }),
    );
    writeFileSync(
      join(tmpDir, "managed-settings.json"),
      JSON.stringify({ identity: { orgId: "managed-org", teamId: "managed-team" } }),
    );
    process.env.SID_CODE_IDENTITY_USER_ID = "env-user";
    const { loadConfig } = await import("@sid-code/core/config/config.ts");
    const cfg = await loadConfig({ model: "x" });
    expect(cfg.identity?.userId).toBe("env-user");
    expect(cfg.identity?.orgId).toBe("managed-org");
    expect(cfg.identity?.teamId).toBe("managed-team");
    expect(getIdentity().orgId).toBe("managed-org");
  });
});

describe("git 快照（PR-1.2 顺手字段）", () => {
  test("本仓内 git_head 是 40 位 hex，git_dirty 是 boolean", async () => {
    const { getGitSnapshot, __resetGitSnapshotForTest } =
      await import("@sid-code/core/identity/index.ts");
    __resetGitSnapshotForTest();
    const snap = getGitSnapshot();
    if (snap.head) {
      expect(snap.head).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof snap.dirty).toBe("boolean");
    } else {
      expect(snap.dirty).toBeNull();
    }
  });
});

describe("配置目录 .gitignore 排除身份文件", () => {
  test("首次生成的 .gitignore 含 device-id 与 device-credential.json", () => {
    ensureConfigGitignore();
    const text = readFileSync(sidPaths.gitignore(), "utf-8");
    expect(text).toContain("device-id");
    expect(text).toContain("device-credential.json");
    expect(text).toContain("policy-cache.json");
    expect(text).toContain("failed-usage-ledger.jsonl");
    expect(text).toContain("usage-ledger.jsonl");
  });
});

describe("四方落点 deviceId 一致（PR-1.2）", () => {
  test("getIdentity 与事件 metadata 的 device_id 是同一份", async () => {
    const ident = getIdentity();
    const { __resetMetadataForTest, getEventMetadataFields } =
      await import("@sid-code/core/analytics/metadata.ts");
    __resetMetadataForTest();
    const fields = getEventMetadataFields();
    expect(String(fields._PROTECTED_device_id)).toBe(ident.deviceId);
  });
});
