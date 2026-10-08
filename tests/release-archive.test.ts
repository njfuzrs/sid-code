/**
 * B46 P1：发布产物归档到 OSS。
 *
 * 两层断言：
 *   · 行为级：真跑 scripts/archive-version.sh，ossutil 换成 tests/fixtures/fake-ossutil.sh
 *     （复刻真 ossutil「cp 已存在 skip 且返回 0」「ls 前缀匹配」两处实测行为）。
 *   · 契约级：release.sh 里归档在写指针之前、失败即 fail、成功判据是 __ARCHIVE_OK__ 行。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
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
import { createHash } from "node:crypto";

const ROOT = join(import.meta.dir, "..");
const ARCHIVE_SH = join(ROOT, "scripts/archive-version.sh");
const FAKE_OSS = join(ROOT, "tests/fixtures/fake-ossutil.sh");
const RELEASE_SH = readFileSync(join(ROOT, "scripts/release.sh"), "utf8");

const VER = "0.1.900";
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-x64-baseline", "linux-arm64"];
const COMMIT = "a".repeat(40);

let dir: string;
let srv: string;
let oss: string;

/** 造一个与服务器同构的版本目录：每个平台一个 tarball（内含带构建身份行的假二进制）+ .sha256 */
function makeVersionDir() {
  srv = join(dir, "srv", VER);
  mkdirSync(srv, { recursive: true });
  for (const p of PLATFORMS) {
    const stage = join(dir, "stage", p, "sid-code");
    mkdirSync(stage, { recursive: true });
    writeFileSync(
      join(stage, "sid-code"),
      `xx var B="SIDCODE_BUILD_V1|commit=${COMMIT}|branch=main|dirty=true|built_at=2026-10-01T00:00:00Z|origin=release|dirty_files=package.json";var y=1;\0yy Bun v1.4.2 zz`,
    );
    const tar = `sid-code-${VER}-${p}.tar.gz`;
    const r = spawnSync("tar", ["-czf", join(srv, tar), "-C", join(dir, "stage", p), "sid-code"]);
    expect(r.status).toBe(0);
    const sha = createHash("sha256")
      .update(readFileSync(join(srv, tar)))
      .digest("hex");
    writeFileSync(join(srv, `${tar}.sha256`), `${sha}  ${tar}\n`);
  }
}

function runArchive(env: Record<string, string> = {}, prov = "original") {
  return spawnSync("bash", [ARCHIVE_SH, srv, VER, prov], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_OSS_ROOT: oss,
      ARCHIVE_OSSUTIL: FAKE_OSS,
      ARCHIVE_PREFIX: "oss://b/sid-code",
      ARCHIVE_PLATFORMS: PLATFORMS.join(" "),
      ...env,
    },
  });
}

const archived = () => join(oss, "sid-code", VER);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-archive-"));
  oss = join(dir, "oss");
  mkdirSync(oss);
  chmodSync(FAKE_OSS, 0o755);
  makeVersionDir();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("archive-version.sh 正向", () => {
  test("全部对象 + provenance.json 进归档，最后一行是成功标记", () => {
    const r = runArchive();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").at(-1)).toBe(`__ARCHIVE_OK__ ${VER}`);
    expect(readdirSync(archived()).length).toBe(PLATFORMS.length * 2 + 1);
    const prov = JSON.parse(readFileSync(join(archived(), "provenance.json"), "utf8"));
    // 身份取自产物字节，不是环境
    expect(prov).toMatchObject({
      schema: 1,
      version: VER,
      git_tag: `v${VER}`,
      commit: COMMIT,
      provenance: "original",
      built_at: "2026-10-01T00:00:00Z",
      bun_version: "1.4.2",
    });
    // 真实产物里身份行是 JS 字符串字面量：收尾的 `";` 不能被吞进最后一个字段
    expect(prov.build_info).toBe(
      `SIDCODE_BUILD_V1|commit=${COMMIT}|branch=main|dirty=true|built_at=2026-10-01T00:00:00Z|origin=release|dirty_files=package.json`,
    );
    expect(prov.note).toMatch(/dirty_files=package\.json$/);
  });

  test("重跑幂等：全部跳过，不覆盖，仍然回读校验通过", () => {
    expect(runArchive().status).toBe(0);
    const before = readFileSync(join(archived(), "provenance.json"), "utf8");
    const r = runArchive();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`上传 0 个对象，跳过已存在 ${PLATFORMS.length * 2 + 1} 个`);
    expect(readFileSync(join(archived(), "provenance.json"), "utf8")).toBe(before);
  });
});

describe("archive-version.sh 反向：每条都必须失败且不打印成功标记", () => {
  function expectFail(r: ReturnType<typeof runArchive>, msg: string) {
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("__ARCHIVE_OK__");
    expect(r.stderr).toContain(msg);
  }

  test("回读字节损坏 → 失败（「已归档」的唯一判据是回读校验）", () => {
    expectFail(
      runArchive({ FAKE_OSS_CORRUPT: `sid-code-${VER}-linux-x64.tar.gz` }),
      "回读 sha256 校验失败",
    );
  });

  test("cp 返回 0 但没写进去 → 失败（不信 cp 返回码）", () => {
    expectFail(
      runArchive({ FAKE_OSS_DROP: `sid-code-${VER}-linux-arm64.tar.gz` }),
      "上传后对象仍不存在",
    );
  });

  test("归档里已有同名但内容不同的对象 → 不覆盖，且失败", () => {
    const t = `sid-code-${VER}-darwin-x64.tar.gz`;
    mkdirSync(archived(), { recursive: true });
    writeFileSync(join(archived(), t), "bad");
    expectFail(runArchive(), "回读 sha256 校验失败");
    expect(readFileSync(join(archived(), t), "utf8")).toBe("bad");
  });

  test("ls 前缀匹配陷阱：归档里只有 .sha256 时 tarball 仍会被补传", () => {
    const t = `sid-code-${VER}-darwin-x64.tar.gz`;
    mkdirSync(archived(), { recursive: true });
    copyFileSync(join(srv, `${t}.sha256`), join(archived(), `${t}.sha256`));
    const r = runArchive();
    expect(r.status).toBe(0);
    expect(existsSync(join(archived(), t))).toBe(true);
  });

  test("归档的 .sha256 与服务器不一致 → 失败（tarball 与 .sha256 被一起换掉也能拦）", () => {
    const t = `sid-code-${VER}-linux-x64.tar.gz`;
    mkdirSync(archived(), { recursive: true });
    writeFileSync(join(archived(), t), "evil");
    const evilSha = createHash("sha256").update("evil").digest("hex");
    writeFileSync(join(archived(), `${t}.sha256`), `${evilSha}  ${t}\n`);
    expectFail(runArchive(), `归档的 ${t}.sha256 与服务器不一致`);
  });

  test("缺平台 → 上传前就失败，归档里什么都没写", () => {
    rmSync(join(srv, `sid-code-${VER}-linux-arm64.tar.gz`));
    expectFail(runArchive(), "缺平台产物");
    expect(existsSync(archived())).toBe(false);
  });

  test("服务器本地 sha256 不符 → 上传前就失败", () => {
    appendFileSync(join(srv, `sid-code-${VER}-darwin-arm64.tar.gz`), "x");
    expectFail(runArchive(), "服务器本地 sha256 复核失败");
    expect(existsSync(archived())).toBe(false);
  });

  test("产物里没有构建身份行 → 失败（不是发布流程编的产物不归档）", () => {
    const p = "linux-x64";
    const stage = join(dir, "stage2", "sid-code");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "sid-code"), "no identity");
    const tar = `sid-code-${VER}-${p}.tar.gz`;
    spawnSync("tar", ["-czf", join(srv, tar), "-C", join(dir, "stage2"), "sid-code"]);
    const sha = createHash("sha256")
      .update(readFileSync(join(srv, tar)))
      .digest("hex");
    writeFileSync(join(srv, `${tar}.sha256`), `${sha}  ${tar}\n`);
    expectFail(runArchive(), "取不到 SIDCODE_BUILD_V1");
  });

  test("provenance 只能是 original/rebuilt", () => {
    expectFail(runArchive({}, "fake"), "provenance 只能是 original 或 rebuilt");
  });
});

describe("release.sh 接线契约", () => {
  const upload = RELEASE_SH.slice(
    RELEASE_SH.indexOf('if [ "$DO_UPLOAD" = true ]; then\n    require_ssh_user'),
  );

  test("--upload：归档在原子切换之后、install.sh 与 beta.txt 之前，失败即 fail", () => {
    const iSwap = upload.indexOf('ok "v${VERSION} 目录已完整就位"');
    const iArch = upload.indexOf('archive_remote "$VERSION" original');
    const iInstall = upload.indexOf('run_scp "$RELEASE_DIR/install.sh"');
    const iBeta = upload.indexOf('run_scp "$RELEASE_DIR/beta.txt"');
    expect(iSwap).toBeGreaterThan(-1);
    expect(iArch).toBeGreaterThan(iSwap);
    expect(iInstall).toBeGreaterThan(iArch);
    expect(iBeta).toBeGreaterThan(iArch);
    // 变异自证：把 `|| fail` 改成 `|| warn` → 这条红（归档失败也照发 = 没有门禁）
    expect(upload.slice(iArch, iArch + 200)).toMatch(
      /archive_remote "\$VERSION" original \\\n\s+\|\| fail /,
    );
  });

  test("成功判据是 __ARCHIVE_OK__ 行，不是 ssh 返回码", () => {
    const fn = RELEASE_SH.slice(RELEASE_SH.indexOf("archive_remote() {"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/grep -qx "__ARCHIVE_OK__ \$\{ver\}" <<<"\$out" \|\| return 1/);
    // 归档脚本要的平台必须来自 TARGETS（唯一事实源），不能另写一份
    expect(RELEASE_SH).toMatch(/ARCHIVE_PLATFORMS="\$\(for t in "\$\{TARGETS\[@\]\}"/);
  });

  test("--archive-existing 一律标 original，并在构建之前退出", () => {
    const i = RELEASE_SH.indexOf('if [ "$DO_ARCHIVE_EXISTING" = true ]; then');
    const j = RELEASE_SH.indexOf('echo "=== sid-code 发布构建 ==="');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    const seg = RELEASE_SH.slice(i, j);
    expect(seg).toContain('archive_remote "$_v" original');
    expect(seg).toContain("exit 0");
  });

  test("归档链路不用 `… | grep -q`（pipefail 下 SIGPIPE 偶发误判「对象不存在」）", () => {
    // ECS 实测：旧写法 `printf … | grep -Fxq` 3000 次失败 69 次，here-string 0 次。
    // 行为测试在本机几乎测不出这个竞态，只能静态拦。
    const archive = readFileSync(ARCHIVE_SH, "utf8");
    const fn = RELEASE_SH.slice(RELEASE_SH.indexOf("archive_remote() {"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    for (const src of [archive, body]) {
      const code = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n");
      expect(code).not.toMatch(/\|\s*grep\s+-[A-Za-z]*q/);
    }
  });

  test("release.sh 不对归档 bucket 执行删除", () => {
    expect(RELEASE_SH).not.toMatch(/ossutil\S*\s+rm\b/);
    expect(readFileSync(ARCHIVE_SH, "utf8")).not.toMatch(/\boss rm\b|ossutil\S*\s+rm\b/);
  });

  test("bun 版本门禁：读 .bun-version，不一致就 fail，在单测门禁之前", () => {
    const i = RELEASE_SH.indexOf('_want_bun="$(tr -d');
    const j = RELEASE_SH.indexOf(">>> 发布前门禁：bun test");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(RELEASE_SH.slice(i, j)).toMatch(/\[ "\$_have_bun" = "\$_want_bun" \] \\\n\s+\|\| fail/);
  });
});
