/**
 * strictKnownMarketplaces（P5）：远程策略解析 → applyLoadedPolicy 注入 → evaluatePluginOrigin 判定。
 * 与 agent-backend PolicySettingsIn.strictKnownMarketplaces 同形：[{source:"url", url}]。
 */

import { describe, expect, test, afterEach } from "bun:test";
import { applyLoadedPolicy, sanitizeRemotePolicy } from "@sid-code/core/config/policy.ts";
import {
  __resetPluginOnlyPolicy,
  evaluatePluginOrigin,
  getKnownMarketplaces,
  isPluginOriginLocked,
  normalizeMarketplaceUrl,
  setKnownMarketplacesPolicy,
  setPluginOnlyPolicy,
} from "@sid-code/core/config/plugin-only-policy.ts";

const IDX = "https://corp.example.com/traj/api/v1/ctl/marketplace/index";

afterEach(() => {
  __resetPluginOnlyPolicy();
  applyLoadedPolicy(null);
});

describe("sanitizeRemotePolicy", () => {
  test("合法形状原样保留；坏条目丢掉但白名单本身仍在", () => {
    const out = sanitizeRemotePolicy({
      strictKnownMarketplaces: [{ source: "url", url: IDX }, { source: "github", repo: "x" }, 42],
    });
    expect(out?.strictKnownMarketplaces).toEqual([{ source: "url", url: IDX }]);
  });

  test("空数组是有效约束（不是未下发）", () => {
    expect(sanitizeRemotePolicy({ strictKnownMarketplaces: [] })?.strictKnownMarketplaces).toEqual(
      [],
    );
  });

  test("非数组 = 未下发", () => {
    expect(
      sanitizeRemotePolicy({ strictKnownMarketplaces: "x" })?.strictKnownMarketplaces,
    ).toBeUndefined();
  });
});

describe("applyLoadedPolicy 注入与拨回", () => {
  test("下发后生效；下一次 null 必须拨回（不能留在进程里）", () => {
    applyLoadedPolicy({ source: "remote", strictKnownMarketplaces: [{ source: "url", url: IDX }] });
    expect(getKnownMarketplaces()).toEqual([IDX]);
    expect(isPluginOriginLocked()).toBe(true);
    applyLoadedPolicy(null);
    expect(getKnownMarketplaces()).toBeUndefined();
    expect(isPluginOriginLocked()).toBe(false);
  });
});

describe("normalizeMarketplaceUrl", () => {
  test("https 与 loopback http 通过，去尾斜杠 / query / hash", () => {
    expect(normalizeMarketplaceUrl(`${IDX}/?a=1#x`)).toBe(IDX);
    expect(normalizeMarketplaceUrl("http://127.0.0.1:8900/i")).toBe("http://127.0.0.1:8900/i");
  });
  test("明文非本地 / userinfo / 非 URL 拒绝", () => {
    expect(normalizeMarketplaceUrl("http://corp.example.com/i")).toBeNull();
    expect(normalizeMarketplaceUrl("https://u:p@corp.example.com/i")).toBeNull();
    expect(normalizeMarketplaceUrl("not a url")).toBeNull();
  });
});

describe("evaluatePluginOrigin 判定表", () => {
  const market = { kind: "market" as const, indexUrl: IDX };

  test("未锁定：全部放行", () => {
    for (const o of [{ kind: "local" as const }, { kind: "inline" as const }, market]) {
      expect(evaluatePluginOrigin(o).allowed).toBe(true);
    }
  });

  test("内置永远放行（即使空白名单）", () => {
    setKnownMarketplacesPolicy([]);
    expect(evaluatePluginOrigin({ kind: "builtin" }).allowed).toBe(true);
  });

  test("锁定无白名单：本地 / inline 拒；只信 backend.url 推出的市场", () => {
    setPluginOnlyPolicy(["hooks"]);
    expect(evaluatePluginOrigin({ kind: "local" }, IDX).allowed).toBe(false);
    expect(evaluatePluginOrigin({ kind: "inline" }, IDX).allowed).toBe(false);
    expect(evaluatePluginOrigin(market, IDX).allowed).toBe(true);
    expect(evaluatePluginOrigin(market, "https://other.example.com/i").allowed).toBe(false);
    expect(evaluatePluginOrigin(market, undefined).allowed).toBe(false);
  });

  test("白名单优先于 backend.url 推断", () => {
    setKnownMarketplacesPolicy([{ source: "url", url: "https://other.example.com/i" }]);
    expect(evaluatePluginOrigin(market, IDX).allowed).toBe(false);
    expect(
      evaluatePluginOrigin({ kind: "market", indexUrl: "https://other.example.com/i/" }, IDX)
        .allowed,
    ).toBe(true);
  });

  test("白名单里的坏地址被忽略，不让整份策略失效", () => {
    setKnownMarketplacesPolicy([
      { source: "url", url: "http://plain.example.com/i" },
      { source: "url", url: IDX },
    ]);
    expect(getKnownMarketplaces()).toEqual([IDX]);
  });
});
