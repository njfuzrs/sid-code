/**
 * 配置系统 P1/P2 回归（D4 / D9 / D11 / D12）。
 * 缺陷原文见 docs-research 仓 bugfixes/todo/20260927-配置系统-顺着sc-13-settings-config核出的缺陷.md。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  getSettingsForSource,
  patchSettingsFile,
  setFlagSettings,
} from "@sid-code/core/config/settings/settings.ts";
import { getCachedSource, resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";
import {
  SECURITY_SENSITIVE_FIELDS,
  filterProjectSettings,
} from "@sid-code/core/config/settings/security.ts";
import { SettingsSchema } from "@sid-code/core/config/settings/types.ts";
import { getSettingsBackupDir } from "@sid-code/core/config/settings/backup.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import { RuleLoader } from "@sid-code/core/permission/rule-loader.ts";

let tmpHome: string;
let ws: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sid-cfg-p1-home-"));
  ws = mkdtempSync(join(tmpdir(), "sid-cfg-p1-ws-"));
  mkdirSync(join(ws, ".sid-code"), { recursive: true });
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = tmpHome;
  resetSettingsCache();
});

afterEach(() => {
  setFlagSettings(null);
  resetSettingsCache();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe("D4：settings 文件变更后权限规则可重载", () => {
  test("reloadFileSources 读到新 deny，且保留运行期 session / command 规则", async () => {
    const userPath = sidPaths.settings();
    writeFileSync(userPath, JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } }));
    const loader = new RuleLoader(ws);
    await loader.loadAll();
    loader.addSessionRule("allow", "Read(*)");
    loader.addCommandRule("deny", "Bash(curl *)");

    writeFileSync(
      userPath,
      JSON.stringify({ permissions: { deny: ["Bash(rm *)", "Bash(git push *)"] } }),
    );
    // 修前：没有任何重载入口，规则停在启动时的快照
    expect(loader.toPermissionRule().deny).not.toContain("Bash(git push *)");

    await loader.reloadFileSources();
    const rules = loader.toPermissionRule();
    expect(rules.deny).toContain("Bash(git push *)");
    expect(rules.deny).toContain("Bash(curl *)");
    expect(rules.allow).toContain("Read(*)");
  });

  test("文件里删掉的规则重载后消失（不是只增不减）", async () => {
    const userPath = sidPaths.settings();
    writeFileSync(userPath, JSON.stringify({ permissions: { allow: ["Bash(npm *)"] } }));
    const loader = new RuleLoader(ws);
    await loader.loadAll();
    expect(loader.toPermissionRule().allow).toContain("Bash(npm *)");

    writeFileSync(userPath, JSON.stringify({}));
    await loader.reloadFileSources();
    expect(loader.toPermissionRule().allow ?? []).not.toContain("Bash(npm *)");
  });

  test("projectSettings 重载后仍过不可信剥离", async () => {
    const projPath = join(ws, ".sid-code", "settings.json");
    writeFileSync(projPath, JSON.stringify({}));
    const loader = new RuleLoader(ws);
    await loader.loadAll();
    writeFileSync(projPath, JSON.stringify({ permissions: { allow: ["Bash(*)"] } }));
    await loader.reloadFileSources();
    expect(loader.toPermissionRule().allow ?? []).not.toContain("Bash(*)");
  });
});

describe("D9：patchSettingsFile 原子写 + 写前备份 + 损坏留档", () => {
  test("写前留一份可解析的备份，且不留 tmp 残片", () => {
    const path = sidPaths.settings();
    writeFileSync(path, JSON.stringify({ model: "a", hooks: { x: 1 } }));
    patchSettingsFile("userSettings", "model", "b");

    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ model: "b", hooks: { x: 1 } });
    const backups = readdirSync(getSettingsBackupDir()).filter((f) => f.includes(".backup."));
    expect(backups.length).toBe(1);
    const restored = JSON.parse(readFileSync(join(getSettingsBackupDir(), backups[0]!), "utf-8"));
    expect(restored.model).toBe("a");
    expect(readdirSync(tmpHome).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  test("备份保留窗口封顶 5 份", () => {
    const path = sidPaths.settings();
    writeFileSync(path, JSON.stringify({ n: 0 }));
    for (let i = 1; i <= 8; i++) patchSettingsFile("userSettings", "n", i);
    const backups = readdirSync(getSettingsBackupDir()).filter((f) => f.includes(".backup."));
    expect(backups.length).toBeLessThanOrEqual(5);
  });

  test("文件损坏：拒写、原文件不动、留档并给出恢复路径", () => {
    const path = sidPaths.settings();
    writeFileSync(path, JSON.stringify({ model: "good" }));
    patchSettingsFile("userSettings", "model", "good2"); // 产生一份好备份
    writeFileSync(path, '{"model": "half');

    let msg = "";
    try {
      patchSettingsFile("userSettings", "model", "x");
    } catch (e: any) {
      msg = e.message;
    }
    expect(msg).toContain("解析失败");
    expect(msg).toContain("损坏文件已留档");
    expect(msg).toContain("最近一次可用备份");
    expect(readFileSync(path, "utf-8")).toBe('{"model": "half');
    const files = readdirSync(getSettingsBackupDir());
    expect(files.some((f) => f.includes(".corrupted."))).toBe(true);
    // 损坏内容不进写前备份窗口
    for (const f of files.filter((f) => f.includes(".backup."))) {
      expect(() =>
        JSON.parse(readFileSync(join(getSettingsBackupDir(), f), "utf-8")),
      ).not.toThrow();
    }
  });

  test("project 来源的备份不落在仓库 .sid-code/ 里", () => {
    const path = join(ws, ".sid-code", "settings.json");
    writeFileSync(path, JSON.stringify({ model: "a" }));
    patchSettingsFile("projectSettings", "model", "b", ws);
    expect(readdirSync(join(ws, ".sid-code"))).toEqual(["settings.json"]);
  });
});

describe("D11：filterProjectSettings 不共享嵌套引用，且清单与 schema 形状锁定", () => {
  test("返回值的嵌套对象与入参不共享引用", () => {
    const orig: any = { permissions: { allow: ["Read(*)"] }, permissionMode: "plan" };
    const filtered: any = filterProjectSettings(orig);
    expect(filtered.permissions).toEqual(orig.permissions);
    expect(filtered.permissions).not.toBe(orig.permissions);
    filtered.permissions.allow.push("Bash(*)");
    expect(orig.permissions.allow).toEqual(["Read(*)"]);
  });

  test("点分路径条目能删嵌套键", () => {
    SECURITY_SENSITIVE_FIELDS.add("webFetch.isolate");
    try {
      const filtered: any = filterProjectSettings({ webFetch: { isolate: false, keep: 1 } } as any);
      expect(filtered.webFetch).toEqual({ keep: 1 });
    } finally {
      SECURITY_SENSITIVE_FIELDS.delete("webFetch.isolate");
    }
  });

  test("清单每一条都能在 SettingsSchema 上解析到真实字段（字段挪位置会红）", () => {
    const unwrap = (s: any): any => {
      let cur = s;
      while (cur && !cur.shape && typeof cur.unwrap === "function") cur = cur.unwrap();
      return cur;
    };
    // schema 未声明、靠 .passthrough() 透传进来的顶层键（config.ts 仍按名消费它们）。
    // 豁免只认顶层：嵌套路径必须在 schema 上解析得到，否则就是 D11 那种静默失效。
    const PASSTHROUGH_ONLY = new Set(["skipPermissions", "yesMode"]);
    for (const field of SECURITY_SENSITIVE_FIELDS) {
      if (PASSTHROUGH_ONLY.has(field)) continue;
      let node: any = SettingsSchema();
      for (const seg of field.split(".")) {
        const obj = unwrap(node);
        expect(obj?.shape, `${field}：${seg} 的父节点不是对象`).toBeTruthy();
        node = obj.shape[seg];
        expect(node, `${field} 在 SettingsSchema 上不存在`).toBeDefined();
      }
    }
  });
});

describe("D12：flagSettings 不写 L2 死条目", () => {
  test("setFlagSettings 后 L2 无 flagSettings 条目，读取仍返回注入值", () => {
    setFlagSettings({ model: "flag-model" } as any);
    expect(getCachedSource("flagSettings")).toBeUndefined();
    expect(getSettingsForSource("flagSettings").settings?.model).toBe("flag-model");
  });
});
