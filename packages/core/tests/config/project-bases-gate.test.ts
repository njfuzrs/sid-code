/**
 * 「项目基准目录」四种口径的门禁（20261009 方案 §3.4 最后一条）。
 *
 * 布局：
 *   <tmp>/outer/                 ← 仓库外上层（非 git）
 *     CLAUDE.md                  ← B4：仓库内深层启动也必须可见
 *     .sid-code/skills/outer-skill.md   ← B3 上界外：必须不可见
 *     repo/                      ← git root
 *       .sid-code/settings.json        ← B1：子目录启动必须不可见
 *       .sid-code/settings.local.json  ← B2：子目录启动必须可见
 *       .sid-code/{skills,commands,agents,output-styles}/  ← B3：必须可见
 *       .claude/rules/r.md, CLAUDE.local.md                ← B4：必须可见
 *       a/b/c/                   ← 启动目录
 *
 * .mcp.json 的向上查找由 MCP 侧测试覆盖（M1），这里不断言。
 * 每条都做过变异自证：把对应修复撤回（只扫一层 / 只读最深层 / 写 cwd），断言即红。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import {
  getAncestorChain,
  getExtensionScanDirs,
  getProjectIdentityRoot,
} from "@sid-code/core/config/project-bases.ts";
import { getSettingsForSource } from "@sid-code/core/config/settings/settings.ts";
import { resetSettingsCache } from "@sid-code/core/config/settings/cache.ts";
import { ExtensionLoader } from "@sid-code/core/extension/loader.ts";
import { loadAllCLAUDEmd } from "@sid-code/core/config/rules.ts";
import { RuleLoader } from "@sid-code/core/permission/rule-loader.ts";
import { persistRule } from "@sid-code/core/permission/rule-persistence.ts";
import { TrustManager } from "@sid-code/core/permission/trust.ts";

function git(cwd: string, ...args: string[]): void {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  }
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${r.stderr}`);
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

let tmp: string;
let outer: string;
let repo: string;
let deep: string;
let home: string;
let prevConfigDir: string | undefined;
let prevCwd: string;

beforeEach(() => {
  // realpath：macOS 的 /var → /private/var，git toplevel 返回的是后者
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "sid-bases-")));
  home = join(tmp, "sid-home");
  outer = join(tmp, "outer");
  repo = join(outer, "repo");
  deep = join(repo, "a", "b", "c");
  mkdirSync(deep, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(repo, "init", "-q", ".");
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = home;
  prevCwd = process.cwd();
  resetSettingsCache();
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  resetSettingsCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe("project-bases 四个命名函数", () => {
  test("B2 = git root；B3 止于 git root；B4 越过 git root 直到文件系统根", () => {
    expect(getProjectIdentityRoot(deep)).toBe(repo);
    expect(getExtensionScanDirs(undefined, deep)).toEqual([
      repo,
      join(repo, "a"),
      join(repo, "a", "b"),
      deep,
    ]);
    const chain = getAncestorChain(deep);
    expect(chain[chain.length - 1]).toBe(deep);
    expect(chain).toContain(outer);
    expect(chain).not.toContain("/"); // 文件系统根本身不含（对齐 CC）
  });
});

describe("门禁：子目录启动时各子系统按各自基准可见 / 不可见", () => {
  test("B1：仓库根的共享 settings.json 在子目录不可见；B2：settings.local.json 可见", () => {
    write(join(repo, ".sid-code", "settings.json"), JSON.stringify({ model: "shared-model" }));
    write(join(repo, ".sid-code", "settings.local.json"), JSON.stringify({ model: "local-model" }));
    expect(getSettingsForSource("projectSettings", deep).settings?.model).toBeUndefined();
    expect(getSettingsForSource("localSettings", deep).settings?.model).toBe("local-model");
  });

  test("B2 兼容：启动目录里旧 settings.local.json 仍读，同 key 以 git root 那份为准", () => {
    write(join(repo, ".sid-code", "settings.local.json"), JSON.stringify({ model: "root-model" }));
    write(
      join(deep, ".sid-code", "settings.local.json"),
      JSON.stringify({ model: "legacy-model", language: "en" }),
    );
    const s = getSettingsForSource("localSettings", deep).settings;
    expect(s?.model).toBe("root-model");
    expect((s as Record<string, unknown>)?.language).toBe("en");
  });

  test("B3：skills / commands / agents 读到仓库根，仓库外上层不可见；近者覆盖远者", async () => {
    for (const type of ["skills", "commands", "agents"]) {
      write(join(repo, ".sid-code", type, `root-${type}.md`), `---\ndescription: root\n---\nR`);
    }
    write(join(outer, ".sid-code", "skills", "outer-skill.md"), "---\ndescription: o\n---\nO");
    write(join(repo, ".sid-code", "skills", "dup.md"), "---\ndescription: far\n---\nFAR");
    write(join(deep, ".sid-code", "skills", "dup.md"), "---\ndescription: near\n---\nNEAR");

    const loader = new ExtensionLoader();
    const opts = { trustProjectExtensions: true };
    for (const type of ["skills", "commands", "agents"]) {
      const names = (await loader.scan(type, deep, opts)).map((f) => f.name);
      expect(names).toContain(`root-${type}`);
    }
    const skills = await loader.scan("skills", deep, opts);
    expect(skills.map((f) => f.name)).not.toContain("outer-skill");
    expect(skills.find((f) => f.name === "dup")?.filePath).toBe(
      join(deep, ".sid-code", "skills", "dup.md"),
    );
  });

  test("B3：output-styles 读到仓库根", async () => {
    write(join(repo, ".sid-code", "output-styles", "terse.md"), "---\nname: terse\n---\nT");
    process.chdir(deep);
    const { loadAllOutputStyles } = await import("@sid-code/core/config/output-styles.ts");
    expect(loadAllOutputStyles().map((s) => s.name)).toContain("terse");
  });

  test("B4：仓库外上层 CLAUDE.md、仓库根 rules 目录与 CLAUDE.local.md 全部可见", async () => {
    write(join(outer, "CLAUDE.md"), "# Instructions\nOUTERMARK");
    write(join(repo, ".claude", "rules", "r.md"), "# Custom Rules\n- RULEMARK");
    write(join(repo, "CLAUDE.local.md"), "# Instructions\nLOCALMARK");
    write(join(deep, "CLAUDE.md"), "# Instructions\nDEEPMARK");

    const merged = await loadAllCLAUDEmd(deep, { activeFiles: [] });
    const raw = merged?.rawContent ?? "";
    expect(raw).toContain("OUTERMARK");
    expect(raw).toContain("RULEMARK");
    expect(raw).toContain("LOCALMARK");
    expect(raw).toContain("DEEPMARK");
  });

  test("P11：父链无任何 CLAUDE 系文件时读 AGENTS.md；有 CLAUDE.md 时不读", async () => {
    write(join(repo, "AGENTS.md"), "# Instructions\nAGENTSMARK");
    const only = await loadAllCLAUDEmd(deep, { activeFiles: [] });
    expect(only?.rawContent ?? "").toContain("AGENTSMARK");

    write(join(repo, "CLAUDE.md"), "# Instructions\nCLAUDEMARK");
    const both = await loadAllCLAUDEmd(deep, { activeFiles: [] });
    expect(both?.rawContent ?? "").toContain("CLAUDEMARK");
    expect(both?.rawContent ?? "").not.toContain("AGENTSMARK");
  });
});

describe("P2：权限规则读写两端都走 git root 的 settings.local.json", () => {
  test("子目录写入的 local 规则落在 git root，另一个子目录读得到", async () => {
    await persistRule("local", "allow", "Bash(make build)", deep);
    const rootLocal = join(repo, ".sid-code", "settings.local.json");
    expect(existsSync(rootLocal)).toBe(true);
    expect(existsSync(join(deep, ".sid-code", "settings.local.json"))).toBe(false);
    expect(readFileSync(rootLocal, "utf-8")).toContain("Bash(make build)");

    const other = join(repo, "x");
    mkdirSync(other, { recursive: true });
    const loader = new RuleLoader(other);
    await loader.loadAll();
    expect(loader.getAllRules().some((r) => r.rawRule === "Bash(make build)")).toBe(true);
  });

  test("启动目录旧 local 文件里的规则仍被读取（兼容一版）", async () => {
    write(
      join(deep, ".sid-code", "settings.local.json"),
      JSON.stringify({ permissions: { deny: ["Bash(rm -rf /)"] } }),
    );
    write(
      join(repo, ".sid-code", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }),
    );
    const loader = new RuleLoader(deep);
    await loader.loadAll();
    const raws = loader.getAllRules().map((r) => r.rawRule);
    expect(raws).toContain("Bash(rm -rf /)");
    expect(raws).toContain("Bash(ls)");
  });
});

describe("P10：信任按 git root 存，检查时向上继承", () => {
  test("在仓库根信任后，子目录启动判为已信任", async () => {
    await new TrustManager(repo).trust();
    expect(await new TrustManager(deep).isTrusted()).toBe(true);
    expect(new TrustManager(deep).isTrustedSync()).toBe(true);
  });

  test("子目录信任写的是 git root 的键，换个子目录同样已信任", async () => {
    await new TrustManager(deep).trust();
    const other = join(repo, "y");
    mkdirSync(other, { recursive: true });
    expect(await new TrustManager(other).isTrusted()).toBe(true);
  });

  test("祖先目录已信任 → 其下仓库继承", async () => {
    // outer 不是 git 仓库：身份根就是它自己
    await new TrustManager(outer).trust();
    expect(await new TrustManager(deep).isTrusted()).toBe(true);
  });

  test("对照：无任何信任记录时仍是未信任（fail-closed 不变）", async () => {
    expect(await new TrustManager(deep).isTrusted()).toBe(false);
  });
});
