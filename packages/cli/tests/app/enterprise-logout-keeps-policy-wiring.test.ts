/**
 * 门禁 · TUI 内 /logout 不得重载企业策略（企业登录缺陷 D1，2026-10-22 核查）
 *
 * 缺陷形态：app.ts 订阅 onCredentialChanged（登录登出不分），登出也调
 * refreshEnterpriseStateAfterLogin → reloadEnterprisePolicy。此时远程 loader 没凭据只能用缓存，
 * 缓存超过 POLICY_CACHE_STALE_MS（10 分钟）就不采信，而交互会话轮询间隔是 30 分钟——
 * 远程 deny / bridge 开关被清掉，与 /logout 回执「企业策略不会因登出解除」相反。
 *
 * 行为层（onCredentialAcquired 登出不触发）在 core 的 login-status.test.ts；
 * 这里锁的是接线：有人把订阅改回 onCredentialChanged，行为层测试照样绿。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = readFileSync(join(import.meta.dir, "../../src/app.ts"), "utf-8");

function methodBody(name: string): string {
  const start = APP.indexOf(`private ${name}(): void {`);
  expect(start).toBeGreaterThan(-1);
  // 到下一个 private 方法为止
  const end = APP.indexOf("\n  private ", start + 1);
  return APP.slice(start, end);
}

describe("企业登录刷新接线（D1）", () => {
  test("企业状态刷新只挂在 onCredentialAcquired 上", () => {
    const body = methodBody("wireEnterpriseLoginRefresh");
    expect(body).toMatch(
      /onCredentialAcquired\(\s*\(\)\s*=>\s*\{\s*void this\.refreshEnterpriseStateAfterLogin\(/,
    );
    expect(body).not.toContain("onCredentialChanged(");
  });

  test("refreshEnterpriseStateAfterLogin 只有一个调用点", () => {
    const calls = APP.match(/this\.refreshEnterpriseStateAfterLogin\(/g) ?? [];
    expect(calls.length).toBe(1);
  });
});
