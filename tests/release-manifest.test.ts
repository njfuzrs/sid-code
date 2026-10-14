/**
 * B46 P5 / P6：版本清单 versions.json 与 I1 审计。
 *
 * 三层断言：
 *   · 行为级：真跑 scripts/manifest-ops.sh（dump / publish），ossutil 换成 tests/fixtures/fake-ossutil.sh；
 *     再把 dump 原样喂给 scripts/lib/release-manifest.ts 生成清单、做 I1 审计。
 *   · 安装脚本：真跑 scripts/install-template.sh（file:// 假发布目录），看 404 与旧版本提示。
 *   · 契约级：release.sh 里清单 / 审计的位置与失败语义。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditArchive,
  buildManifest,
  oldestArchived,
  parseDump,
} from "../scripts/lib/release-manifest.ts";
import { serializeManifest } from "../scripts/release-manifest.ts";
import { parseManifest } from "@sid-code/core/update/manifest.ts";

const ROOT = join(import.meta.dir, "..");
const OPS_SH = join(ROOT, "scripts/manifest-ops.sh");
const FAKE_OSS = join(ROOT, "tests/fixtures/fake-ossutil.sh");
const INSTALL_SH = join(ROOT, "scripts/install-template.sh");
const RELEASE_SH = readFileSync(join(ROOT, "scripts/release.sh"), "utf8");
const PREFIX = "oss://b/sid-code";
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-x64-baseline", "linux-arm64"];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let dir: string;
let oss: string;

/** 在假 OSS 里放一个已归档版本（与 archive-version.sh 产出的布局相同） */
function putVersion(ver: string, opts: { skip?: string[]; prov?: object } = {}) {
  const d = join(oss, "sid-code", ver);
  mkdirSync(d, { recursive: true });
  for (const p of PLATFORMS) {
    const t = `sid-code-${ver}-${p}.tar.gz`;
    if (opts.skip?.includes(p)) continue;
    const body = `tar ${ver} ${p}`;
    writeFileSync(join(d, t), body);
    writeFileSync(join(d, `${t}.sha256`), `${sha(body)}  ${t}\n`);
  }
  writeFileSync(
    join(d, "provenance.json"),
    JSON.stringify({
      schema: 1,
      version: ver,
      provenance: "original",
      commit: "c".repeat(40),
      built_at: "2026-10-01T00:00:00Z",
      ...opts.prov,
    }),
  );
}

function ops(...args: string[]) {
  return spawnSync("bash", [OPS_SH, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_OSS_ROOT: oss,
      ARCHIVE_OSSUTIL: FAKE_OSS,
      ARCHIVE_PREFIX: PREFIX,
      MANIFEST_PREFIX: "oss://b/manifest",
    },
  });
}

function dumpAndBuild(tags: string[]) {
  const r = ops("dump");
  expect(r.status).toBe(0);
  return buildManifest(parseDump(r.stdout), PREFIX, tags, new Date("2026-10-14T00:00:00Z"));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-manifest-"));
  oss = join(dir, "oss");
  mkdirSync(oss);
  chmodSync(FAKE_OSS, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("manifest-ops.sh dump → buildManifest", () => {
  test("归档里的版本按版本号倒序进清单，平台 sha256 / 大小取自归档", () => {
    putVersion("0.1.602");
    putVersion("0.1.610");
    putVersion("0.1.603");
    const { manifest, skipped } = dumpAndBuild(["0.1.602", "0.1.603", "0.1.610"]);
    expect(skipped).toEqual([]);
    expect(manifest.versions.map((v) => v.version)).toEqual(["0.1.610", "0.1.603", "0.1.602"]);
    const lx = manifest.versions[0]!.platforms["linux-x64"]!;
    expect(lx.sha256).toBe(sha("tar 0.1.610 linux-x64"));
    expect(lx.size).toBe("tar 0.1.610 linux-x64".length);
    expect(manifest.versions[0]!.commit).toBe("c".repeat(40));
  });

  test("探针等版本目录之外的对象不进清单", () => {
    putVersion("0.1.602");
    mkdirSync(join(oss, "sid-code", "_probe"), { recursive: true });
    writeFileSync(join(oss, "sid-code", "_probe", "probe.txt.sha256"), "x");
    const { manifest } = dumpAndBuild(["0.1.602"]);
    expect(manifest.versions.map((v) => v.version)).toEqual(["0.1.602"]);
  });

  test("缺安装平台 / 缺 provenance / provenance 版本号不符 → 不进清单并给出原因", () => {
    putVersion("0.1.602");
    putVersion("0.1.603", { skip: ["darwin-arm64"] });
    putVersion("0.1.604", { prov: { version: "0.1.999" } });
    putVersion("0.1.605");
    rmSync(join(oss, "sid-code", "0.1.605", "provenance.json"));
    const { manifest, skipped } = dumpAndBuild([]);
    expect(manifest.versions.map((v) => v.version)).toEqual(["0.1.602"]);
    const reasons = Object.fromEntries(skipped.map((s) => [s.version, s.reason]));
    expect(reasons["0.1.603"]).toContain("darwin-arm64");
    expect(reasons["0.1.604"]).toContain("0.1.999");
    expect(reasons["0.1.605"]).toContain("provenance.json");
  });

  test("baseline 平台缺失不影响入清单（install.sh 不会拼 baseline）", () => {
    putVersion("0.1.602", { skip: ["linux-x64-baseline"] });
    expect(dumpAndBuild([]).manifest.versions).toHaveLength(1);
  });

  test("归档上线前的 tag 进 lost，之后的缺口不会被自动登记成 lost", () => {
    putVersion("0.1.602");
    const { manifest } = dumpAndBuild(["0.1.590", "0.1.601", "0.1.602", "0.1.611"]);
    expect(manifest.lost.map((l) => l.version)).toEqual(["0.1.590", "0.1.601"]);
    expect(manifest.archive_since).toBe("0.1.602");
  });

  test("rebuilt + 区间内版本自动带 self-update-broken", () => {
    putVersion("0.1.590", { prov: { provenance: "rebuilt" } });
    const v = dumpAndBuild([]).manifest.versions[0]!;
    expect(v.provenance).toBe("rebuilt");
    expect(v.known_issues).toEqual(["self-update-broken"]);
  });

  test("dump 没跑完（缺 __DUMP_OK__）→ parseDump 拒绝，不会生成少版本的清单", () => {
    putVersion("0.1.602");
    const out = ops("dump").stdout.replace("__DUMP_OK__", "");
    expect(() => parseDump(out)).toThrow("__DUMP_OK__");
  });

  test("ossutil 整体失败 → dump 非 0 退出且没有成功标记", () => {
    const r = spawnSync("bash", [OPS_SH, "dump"], {
      encoding: "utf8",
      env: { ...process.env, ARCHIVE_OSSUTIL: "false", ARCHIVE_PREFIX: PREFIX },
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("__DUMP_OK__");
  });
});

describe("I1 审计（auditArchive）", () => {
  test("tag ⊆ 归档 ∪ lost → 通过", () => {
    putVersion("0.1.602");
    putVersion("0.1.603");
    const tags = ["0.1.590", "0.1.602", "0.1.603"];
    expect(auditArchive(dumpAndBuild(tags).manifest, tags).ok).toBe(true);
  });

  test("归档上线后漏归档一个版本 → 红，并指出是哪个", () => {
    putVersion("0.1.602");
    const tags = ["0.1.602", "0.1.603"];
    const a = auditArchive(dumpAndBuild(tags).manifest, tags);
    expect(a.ok).toBe(false);
    expect(a.gaps).toEqual(["0.1.603"]);
  });

  test("有人把归档上线后的版本塞进 lost → 红（不允许用 lost 掩盖新缺口）", () => {
    putVersion("0.1.602");
    const { manifest } = dumpAndBuild([]);
    manifest.lost.push({ version: "0.1.605", reason: "x" });
    const a = auditArchive(manifest, ["0.1.602", "0.1.605"]);
    expect(a.ok).toBe(false);
    expect(a.illegalLost).toEqual(["0.1.605"]);
  });

  test("回源冒烟目标是最老的已归档版本", () => {
    putVersion("0.1.605");
    putVersion("0.1.602");
    expect(oldestArchived(dumpAndBuild([]).manifest)).toBe("0.1.602");
  });

  test("CLI audit：仓库 tag 在归档里有缺口 → exit 1 并报 I1 违规", () => {
    putVersion("0.1.602");
    const dump = join(dir, "dump.txt");
    writeFileSync(dump, ops("dump").stdout);
    const cli = (tagsDir: string) =>
      spawnSync("bun", ["run", join(ROOT, "scripts/release-manifest.ts"), "audit", dump], {
        encoding: "utf8",
        cwd: tagsDir,
        env: { ...process.env, ARCHIVE_PREFIX: PREFIX },
      });
    // CLI 读的是仓库自己的 git tag：仓库里 0.1.602 之后的 tag 在假归档里都没有 → 必红
    const r = cli(ROOT);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("I1 违规");
  });
});

describe("serializeManifest：一个版本一行", () => {
  test("仍是合法 JSON，能被客户端解析器读回", () => {
    putVersion("0.1.602");
    putVersion("0.1.590", { prov: { provenance: "rebuilt" } });
    const { manifest } = dumpAndBuild(["0.1.580"]);
    const text = serializeManifest(manifest);
    const back = parseManifest(JSON.parse(text));
    expect(back?.versions.map((v) => v.version)).toEqual(["0.1.602", "0.1.590"]);
    expect(back?.lost.map((l) => l.version)).toEqual(["0.1.580"]);
  });

  test("每个版本条目独占一行（install.sh 靠 grep 这一行读 known_issues）", () => {
    putVersion("0.1.590", { prov: { provenance: "rebuilt" } });
    const text = serializeManifest(dumpAndBuild([]).manifest);
    const line = text.split("\n").find((l) => l.includes('"version":"0.1.590"'))!;
    expect(line).toContain('"rebuilt"');
    expect(line).toContain('"self-update-broken"');
  });
});

describe("manifest-ops.sh publish", () => {
  test("原子写 versions.json + OSS 存一份审计副本", () => {
    const src = join(dir, "v.json");
    writeFileSync(src, '{"schema":1,"versions":[\n],"lost":[\n]}\n');
    const root = join(dir, "srv");
    mkdirSync(root);
    const r = ops("publish", src, root);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").at(-1)).toBe("__PUBLISH_OK__");
    expect(readFileSync(join(root, "versions.json"), "utf8")).toBe(readFileSync(src, "utf8"));
    expect(readdirSync(root).filter((n) => n.startsWith(".versions"))).toEqual([]);
    const copies = readdirSync(join(oss, "manifest"));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^versions-\d{8}T\d{6}Z\.json$/);
  });

  test("形态不对的文件 → 拒绝发布，原清单不动", () => {
    const root = join(dir, "srv");
    mkdirSync(root);
    writeFileSync(join(root, "versions.json"), "OLD");
    const src = join(dir, "bad.json");
    writeFileSync(src, "<html>502</html>");
    const r = ops("publish", src, root);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(root, "versions.json"), "utf8")).toBe("OLD");
  });
});

describe("install-template.sh 的 P5 提示", () => {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os = process.platform === "darwin" ? "darwin" : "linux";

  function fakeRelease(versions: string[], latest: string, manifest?: string) {
    const rel = join(dir, "rel");
    mkdirSync(rel, { recursive: true });
    for (const v of versions) {
      const vd = join(rel, v);
      mkdirSync(join(dir, "payload", v, "sid-code"), { recursive: true });
      writeFileSync(
        join(dir, "payload", v, "sid-code", "sid-code"),
        `#!/bin/bash\necho "sid-code v${v}"\n`,
        { mode: 0o755 },
      );
      mkdirSync(vd, { recursive: true });
      const t = join(vd, `sid-code-${v}-${os}-${arch}.tar.gz`);
      expect(spawnSync("tar", ["-czf", t, "-C", join(dir, "payload", v), "sid-code"]).status).toBe(
        0,
      );
      const h = createHash("sha256").update(readFileSync(t)).digest("hex");
      writeFileSync(`${t}.sha256`, `${h}  x\n`);
    }
    writeFileSync(join(rel, "latest.txt"), `${latest}\n`);
    if (manifest) writeFileSync(join(rel, "versions.json"), manifest);
    return rel;
  }

  function install(rel: string, version?: string) {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      SHELL: "/bin/bash",
      SID_CONFIG_DIR: join(home, ".sid-code"),
      RELEASE_BASE: `file://${rel}`,
    };
    if (version) env.SID_CODE_VERSION = version;
    else delete env.SID_CODE_VERSION;
    return spawnSync("bash", [INSTALL_SH], { encoding: "utf8", env });
  }

  test("指定版本 404 → 提示 sid-code update --list", () => {
    const r = install(fakeRelease(["0.1.608"], "0.1.608"), "9.9.9");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("sid-code update --list");
  });

  test("不指定版本时的下载失败不提 --list（不是版本不存在的问题）", () => {
    const rel = fakeRelease([], "0.1.608");
    const r = install(rel);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain("--list");
  });

  test("装了低于 latest 的版本 → 提示关闭自动更新，并打印 known_issues", () => {
    const manifest =
      '{"schema":1,"generated_at":"x","archive_since":"0.1.602",\n"versions": [\n' +
      '  {"version":"0.1.608","provenance":"original","platforms":{}},\n' +
      '  {"version":"0.1.590","provenance":"rebuilt","platforms":{},"known_issues":["self-update-broken"]}\n' +
      '],\n"lost": [\n\n]}\n';
    const r = install(fakeRelease(["0.1.590", "0.1.608"], "0.1.608", manifest), "0.1.590");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"autoUpdate": "off"');
    expect(r.stdout).toContain("SID_CODE_AUTO_UPDATE=off");
    expect(r.stdout).toContain("self-update-broken");
    expect(r.stdout).toContain("rebuilt");
  });

  test("装的就是 latest / 不指定版本 → 不出停留提示", () => {
    const rel = fakeRelease(["0.1.608"], "0.1.608");
    expect(install(rel, "0.1.608").stdout).not.toContain("autoUpdate");
    rmSync(join(dir, "home"), { recursive: true, force: true });
    expect(install(rel).stdout).not.toContain("autoUpdate");
  });
});

describe("release.sh 契约", () => {
  const pos = (s: string) => {
    const i = RELEASE_SH.indexOf(s);
    expect(i).toBeGreaterThan(0);
    return i;
  };
  // upload 段里的位置（跳过函数定义处的同名字符串）
  const uploadStart = () => pos('archive_remote "$VERSION" original \\');

  test("--upload 顺序：归档 → 清单 → 审计 → beta.txt", () => {
    const start = uploadStart();
    const after = (s: string) => RELEASE_SH.indexOf(s, start);
    const manifest = after("publish_manifest &&");
    const audit = after("audit_archive smoke");
    const beta = after('run_scp "$RELEASE_DIR/beta.txt"');
    expect(manifest).toBeGreaterThan(start);
    expect(audit).toBeGreaterThan(manifest);
    expect(beta).toBeGreaterThan(audit);
  });

  test("审计不过即 fail（门禁），清单发布失败只 warn（派生物不挡发布）", () => {
    expect(RELEASE_SH).toMatch(/audit_archive smoke \\\n\s+\|\| fail /);
    expect(RELEASE_SH).toMatch(/publish_manifest && ok [^\n]*\\\n\s+\|\| warn /);
  });

  test("清单原料判据只认 __DUMP_OK__ / __PUBLISH_OK__ 整行", () => {
    expect(RELEASE_SH).toContain('grep -qx "__DUMP_OK__"');
    expect(RELEASE_SH).toContain('grep -qx "__PUBLISH_OK__"');
  });

  test("审计从本次 dump 现生成，不读服务器上的 versions.json", () => {
    const fn = RELEASE_SH.slice(pos("audit_archive() {"), pos("audit_archive() {") + 800);
    expect(fn).toContain("manifest_dump");
    expect(fn).not.toContain("versions.json");
  });

  test("新增的脚本都不出现删除 OSS 对象的命令", () => {
    for (const f of ["scripts/manifest-ops.sh", "scripts/release.sh"]) {
      expect(readFileSync(join(ROOT, f), "utf8")).not.toMatch(/\boss rm\b|ossutil\S*\s+rm\b/);
    }
  });

  test("单独入口 --publish-manifest / --audit-archive 存在", () => {
    expect(RELEASE_SH).toContain("--publish-manifest) DO_PUBLISH_MANIFEST=true");
    expect(RELEASE_SH).toContain("--audit-archive) DO_AUDIT_ARCHIVE=true");
    expect(existsSync(OPS_SH)).toBe(true);
  });
});
