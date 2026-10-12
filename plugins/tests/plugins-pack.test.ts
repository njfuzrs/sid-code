/**
 * scripts/plugins-pack.ts 的产物契约：打出来的东西客户端真的能装。
 *
 * 断言都走客户端的真实函数（parseIndex / parseTarGz / validateManifest /
 * validateMarketManifestPaths / sha256Hex），而不是比对快照 —— 契约在 market.ts 一侧变了，
 * 这里会红在「装不上」上，而不是红在「快照不一致」上。
 *
 * 服务端 inspect_package 的校验在 agent-backend 仓（Python），本仓 CI 跑不到；
 * P1 已在本地对 3 个包手工跑过一次（见 Agent Note）。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTarGz } from "@sid-code/cli/plugin/archive.ts";
import {
  parseIndex,
  resolveArtifactUrl,
  sha256Hex,
  validateMarketManifestPaths,
} from "@sid-code/cli/plugin/market.ts";
import { validateManifest } from "@sid-code/cli/plugin/validate.ts";
import {
  buildIndex,
  OFFICIAL_MARKET_NAME,
  PackError,
  packAll,
  packPlugin,
} from "../../scripts/plugins-pack.ts";

const packed = packAll();

describe("plugins-pack：仓内三个插件", () => {
  test("恰好打出 github-pr / ops / compliance", () => {
    expect(packed.map((p) => p.name)).toEqual(["compliance", "github-pr", "ops"]);
  });

  test("组件清单与方案 §5 的调用名一致", () => {
    const by = Object.fromEntries(packed.map((p) => [p.name, p.components.skills]));
    expect(by["github-pr"]).toEqual(["comments"]);
    expect(by.ops).toEqual(["ci-heal", "incident-rca"]);
    expect(by.compliance).toEqual(["governance", "security-audit"]);
  });

  test("产物字节级确定：同一份源码打两次 sha256 相同（版本不可覆盖的前提）", () => {
    const again = packAll();
    expect(again.map((p) => p.sha256)).toEqual(packed.map((p) => p.sha256));
  });
});

describe("plugins-pack：客户端能解析", () => {
  const index = buildIndex(packed);

  test("index 能被 parseIndex 解析，且一个条目都没被当坏条目丢掉", () => {
    const parsed = parseIndex(JSON.parse(JSON.stringify(index)));
    expect(parsed.name).toBe(OFFICIAL_MARKET_NAME);
    expect(parsed.plugins.map((p) => p.name)).toEqual(packed.map((p) => p.name));
    for (const p of parsed.plugins) {
      expect(p.kind).toBe("skill");
      expect(p.components?.skills?.length).toBeGreaterThan(0);
    }
  });

  test("artifact 相对 index 解析后同源（静态目录可直接挂）", () => {
    const parsed = parseIndex(index);
    const market = { name: "sid-code", indexUrl: "https://www.sid-code.cc/plugins/index.json" };
    for (const p of parsed.plugins) {
      expect(resolveArtifactUrl(market, p)).toBe(
        `https://www.sid-code.cc/plugins/artifacts/${p.name}/${p.version}.tar.gz`,
      );
    }
  });

  for (const p of packed) {
    test(`${p.name}：sha256 与 index 一致，客户端解包规则通过，manifest 合规`, () => {
      expect(sha256Hex(p.archive)).toBe(p.sha256);
      const entries = parseTarGz(p.archive);
      const files = entries
        .filter((e) => e.type === "file")
        .map((e) => e.path)
        .sort();
      expect(files).toEqual(p.files);
      const manifestEntry = entries.find((e) => e.path === "plugin.json");
      expect(manifestEntry).toBeDefined();
      const manifest = JSON.parse(manifestEntry!.data!.toString("utf-8"));
      expect(validateManifest(manifest).valid).toBe(true);
      expect(validateMarketManifestPaths(manifest)).toEqual([]);
      expect(manifest.name).toBe(p.name);
      expect(manifest.version).toBe(p.version);
    });
  }

  test("包里不含测试目录与 .DS_Store", () => {
    for (const p of packed) {
      expect(p.files.some((f) => f.startsWith("tests/") || f.endsWith(".DS_Store"))).toBe(false);
    }
  });
});

describe("plugins-pack：拒绝不合规的插件（能在打包时拦就别留到上传）", () => {
  function withPlugin(files: Record<string, string>, fn: (dir: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "plugins-pack-"));
    const dir = join(root, "demo");
    try {
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(dir, rel, ".."), { recursive: true });
        writeFileSync(join(dir, rel), content);
      }
      fn(dir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const okManifest = JSON.stringify({ name: "demo", version: "1.0.0", description: "d" });
  const okSkill = "---\nname: hi\ndescription: d\n---\nbody\n";

  test("符号链接（ci-self-heal 原来就带一个，客户端与服务端都会整包拒绝）", () => {
    withPlugin({ "plugin.json": okManifest, "skills/hi/SKILL.md": okSkill }, (dir) => {
      symlinkSync("SKILL.md", join(dir, "skills", "hi", "link.md"));
      expect(() => packPlugin(dir)).toThrow(PackError);
    });
  });

  test("version 不是 semver", () => {
    const m = JSON.stringify({ name: "demo", version: "v1", description: "d" });
    withPlugin({ "plugin.json": m, "skills/hi/SKILL.md": okSkill }, (dir) => {
      expect(() => packPlugin(dir)).toThrow(/semver/);
    });
  });

  test("name 与目录名不一致", () => {
    const m = JSON.stringify({ name: "other", version: "1.0.0", description: "d" });
    withPlugin({ "plugin.json": m, "skills/hi/SKILL.md": okSkill }, (dir) => {
      expect(() => packPlugin(dir)).toThrow(/目录名/);
    });
  });

  test("带 hooks（官方插件本期只允许 skill）", () => {
    withPlugin(
      { "plugin.json": okManifest, "skills/hi/SKILL.md": okSkill, "hooks.json": "{}" },
      (dir) => {
        expect(() => packPlugin(dir)).toThrow(/hooks/);
      },
    );
  });

  test("一个 skill 都没有", () => {
    withPlugin({ "plugin.json": okManifest, "README.md": "x" }, (dir) => {
      expect(() => packPlugin(dir)).toThrow(/SKILL\.md/);
    });
  });
});
