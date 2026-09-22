/**
 * 远程策略接线探针：不经模型、audit 标 source=policy-probe。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PermissionChecker } from "../../src/permission/checker.ts";
import { defaultConfig } from "../../src/config/config.ts";
import {
  setRemotePolicyPermissions,
  __resetRemotePolicyPermissionsForTest,
} from "../../src/config/remote-policy-state.ts";
import { POLICY_PROBE_SOURCE, runRemotePolicyProbe } from "../../src/permission/policy-probe.ts";
import { sidPaths } from "../../src/config/paths.ts";
import { existsSync, readFileSync } from "node:fs";

let sidHome: string;
let prevSidConfigDir: string | undefined;
let cwd: string;

beforeEach(() => {
  sidHome = mkdtempSync(join(tmpdir(), "policy-probe-"));
  prevSidConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = sidHome;
  cwd = mkdtempSync(join(tmpdir(), "policy-probe-cwd-"));
  __resetRemotePolicyPermissionsForTest();
});

afterEach(() => {
  __resetRemotePolicyPermissionsForTest();
  if (prevSidConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidConfigDir;
  rmSync(sidHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("runRemotePolicyProbe", () => {
  test("未 applied 不打 checker、不写 audit", async () => {
    const checker = new PermissionChecker(defaultConfig(), undefined, cwd);
    await checker.initRules();
    const r = await runRemotePolicyProbe(checker);
    expect(r.ran).toBe(false);
    expect(existsSync(sidPaths.log("permissions-audit.log"))).toBe(false);
  });

  test("applied deny 时 checker rule deny，audit source=policy-probe", async () => {
    setRemotePolicyPermissions({ deny: ["Bash(curl *)"] }, true);
    const checker = new PermissionChecker(defaultConfig(), undefined, cwd);
    await checker.initRules();
    const r = await runRemotePolicyProbe(checker);
    expect(r.ran).toBe(true);
    expect(r.decision?.allowed).toBe(false);
    expect(r.decision?.decisionReason?.type).toBe("rule");
    const raw = readFileSync(sidPaths.log("permissions-audit.log"), "utf8");
    const row = JSON.parse(raw.trim().split("\n").at(-1)!);
    expect(row.source).toBe(POLICY_PROBE_SOURCE);
    expect(row.decision).toBe("deny");
    expect(row.decisionReason?.type).toBe("rule");
  });
});
