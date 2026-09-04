/**
 * 发布通道（beta / stable）与回滚的行为测试 —— 2026-08-24，对应方案 §5.1 的 A2 / A3。
 *
 * ## 为什么这里既有契约断言又有真跑
 *
 * 契约断言（"release.sh 里不许再出现上传 latest.txt 那一行"）能拦住结构退化，但它拦不住
 * **写对了却不生效**：install.sh 的通道解析是一段 shell，正则匹配再严也证明不了
 * `SID_CODE_CHANNEL=beta` 真的会去读 beta.txt。所以通道解析这部分用 `file://` 真跑 ——
 * install-template.sh 头部就写明 curl 原生支持 file://，这是它自带的本地验证路径，
 * 不需要网络、不需要服务器、不需要真装二进制（在下载那一步之前就能读到判据）。
 *
 * ## 落盘隔离
 *
 * 全部落在 mkdtemp 里，且**刻意只跑到"解析版本"这一步之后就失败退出**（假 tarball
 * 下载不到 → install.sh 在下载步 fail）。这是有意的：真装会写 $HOME/.local/bin 与
 * ~/.sid-code/，而本测试要断言的判据（"解析到哪个版本 / 用了哪个通道"）在那之前就已打印。
 * 为双保险仍把 HOME 与 SID_CONFIG_DIR 一起重定向到 tmpdir（见 runInstaller）。
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RELEASE_SH = readFileSync(join(ROOT, "scripts/release.sh"), "utf8");
const INSTALL_SH = readFileSync(join(ROOT, "scripts/install-template.sh"), "utf8");
const ROLLBACK_SH = readFileSync(join(ROOT, "scripts/rollback.sh"), "utf8");

/**
 * 造一个最小的假发布目录（镜像服务器结构：顶层两个指针 + 版本目录）。
 * 不放真 tarball —— 本测试只验通道解析，下载步失败是预期的。
 */
function makeFakeReleaseDir(opts: { latest?: string; beta?: string; versions: string[] }): string {
  const dir = mkdtempSync(join(tmpdir(), "sid-channel-"));
  for (const v of opts.versions) mkdirSync(join(dir, v), { recursive: true });
  if (opts.latest !== undefined) writeFileSync(join(dir, "latest.txt"), `${opts.latest}\n`);
  if (opts.beta !== undefined) writeFileSync(join(dir, "beta.txt"), `${opts.beta}\n`);
  return dir;
}

function runInstaller(
  releaseDir: string,
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number | null } {
  // HOME/SID_CONFIG_DIR 一并指进 tmpdir：即便将来有人把测试跑到下载步之后，
  // 也不会碰到真实的 ~/.local/bin 与 ~/.sid-code（见 CLAUDE.md「测试约定」）。
  const fakeHome = mkdtempSync(join(tmpdir(), "sid-channel-home-"));
  try {
    const r = spawnSync("bash", [join(ROOT, "scripts/install-template.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fakeHome,
        SID_CONFIG_DIR: join(fakeHome, ".sid-code"),
        RELEASE_BASE: `file://${releaseDir}`,
        ...env,
      },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

describe("A2 install.sh：通道解析（真跑，file:// 本地验证路径）", () => {
  // 判据是方案 §8.3 A2 那条的可离线部分：两个通道解析到**不同**版本。
  // 干净容器里的完整安装验证需要真服务器，那部分留给发布时人工做；
  // 这里锁住的是"通道这一层选对了指针文件"，它才是代码里能坏掉的部分。
  test("不带 SID_CODE_CHANNEL → 读 latest.txt", () => {
    const dir = makeFakeReleaseDir({ latest: "0.1.699", beta: "0.1.700", versions: [] });
    try {
      const { stdout } = runInstaller(dir);
      expect(stdout).toContain("0.1.699");
      expect(stdout).toContain("通道: stable");
      expect(stdout).not.toContain("0.1.700");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SID_CODE_CHANNEL=beta → 读 beta.txt（解析到与 stable 不同的版本）", () => {
    const dir = makeFakeReleaseDir({ latest: "0.1.699", beta: "0.1.700", versions: [] });
    try {
      const { stdout } = runInstaller(dir, { SID_CODE_CHANNEL: "beta" });
      expect(stdout).toContain("0.1.700");
      expect(stdout).toContain("通道: beta");
      expect(stdout).not.toContain("0.1.699");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 变异自证：把通道值写错一个大小写，必须**报错**而不是静默按 stable 装。
  // 静默回落的失效形态是"用户以为自己在跑 beta"，而这个误解只会在
  // 「beta 期没发现任何回归」时暴露 —— 那时归因已经做不了了。
  test("未知通道值硬失败，不静默回落 stable", () => {
    const dir = makeFakeReleaseDir({ latest: "0.1.699", beta: "0.1.700", versions: [] });
    try {
      const { stdout, stderr, status } = runInstaller(dir, { SID_CODE_CHANNEL: "Beta" });
      expect(status).not.toBe(0);
      expect(stderr).toContain("未知通道");
      // 关键：没有解析出任何版本号就退出了
      expect(stdout).not.toContain("0.1.699");
      expect(stdout).not.toContain("0.1.700");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // beta.txt 不存在（还没发过 beta）时的报错必须给出可执行的下一步，
  // 否则用户分不清是网络问题还是通道压根没开。
  test("beta 通道指针缺失时，报错点明「该通道可能还没发过版」", () => {
    const dir = makeFakeReleaseDir({ latest: "0.1.699", versions: [] });
    try {
      const { stderr, status } = runInstaller(dir, { SID_CODE_CHANNEL: "beta" });
      expect(status).not.toBe(0);
      expect(stderr).toContain("beta.txt");
      expect(stderr).toMatch(/还没发过版|去掉 SID_CODE_CHANNEL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SID_CODE_VERSION 显式锁版本时不读任何指针（通道被绕过是预期行为）", () => {
    // 指针全都指向别的版本，但显式锁定必须赢 —— 这是既有行为，A2 不能把它改坏。
    const dir = makeFakeReleaseDir({ latest: "0.1.699", beta: "0.1.700", versions: [] });
    try {
      const { stdout } = runInstaller(dir, { SID_CODE_VERSION: "0.1.500" });
      expect(stdout).toContain("0.1.500");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("A2 release.sh：--upload 只写 beta，promote 才动 stable", () => {
  // 这一条是整个 A2 的承重墙。它退化的形态是**静默的**：
  // 顺手加回一行上传 latest.txt，一次 --upload 立刻全量放量，泡制期归零，
  // 而发布日志看起来与从前一模一样（版本号一致、上传成功、冒烟通过）。
  test("上传段不再上传 latest.txt", () => {
    const uploadSeg = RELEASE_SH.slice(RELEASE_SH.indexOf('if [ "$DO_UPLOAD" = true ]; then'));
    expect(uploadSeg).not.toMatch(/run_scp\s+"\$RELEASE_DIR\/latest\.txt"/);
  });

  test("上传段上传 beta.txt", () => {
    const uploadSeg = RELEASE_SH.slice(RELEASE_SH.indexOf('if [ "$DO_UPLOAD" = true ]; then'));
    expect(uploadSeg).toMatch(/run_scp\s+"\$RELEASE_DIR\/beta\.txt"/);
  });

  test("--promote 参数存在且需要版本号（不给就报错，不静默用当前版本）", () => {
    expect(RELEASE_SH).toContain("--promote)");
    expect(RELEASE_SH).toMatch(/--promote 需要传入版本号/);
  });

  test("promote 前校验版本目录存在与产物齐全（半成品目录也是「存在」的）", () => {
    const seg = RELEASE_SH.slice(RELEASE_SH.indexOf('if [ "$DO_PROMOTE" = true ]; then'));
    expect(seg).toContain("__NO_DIR__");
    expect(seg).toContain("__MISSING__");
    // sha256 复核也要有：上传时校验过不代表此刻还好（磁盘/传输/人为改动）
    expect(seg).toContain("__SHA_OK__");
  });

  test("promote 不重新构建、不重新上传产物（纯指针操作）", () => {
    const start = RELEASE_SH.indexOf('if [ "$DO_PROMOTE" = true ]; then');
    const seg = RELEASE_SH.slice(start, RELEASE_SH.indexOf("单独上传团队默认配置", start));
    // 它只 scp 一个临时文件（指针内容），不碰 $VERSION_DIR 里的任何产物
    expect(seg).not.toContain("bun build");
    expect(seg).not.toContain("$VERSION_DIR");
    expect(seg).toMatch(/run_scp "\$_promote_tmp"/);
  });

  test("promote 是独立模式：走完就 exit，不落进构建流程", () => {
    const start = RELEASE_SH.indexOf('if [ "$DO_PROMOTE" = true ]; then');
    const seg = RELEASE_SH.slice(start, RELEASE_SH.indexOf("单独上传团队默认配置", start));
    expect(seg).toContain("exit 0");
    // RELEASE_OK 必须置 true，否则 EXIT trap 会把它当"发布中断"去回滚本地文件
    expect(seg).toContain("RELEASE_OK=true");
  });

  // ── G2 问哪个 ref（2026-09-04 实测踩到的静默漏洞）────────────────────────
  //
  // release.sh 自己把 `bump vX.Y.Z` 提交到**本地** main，该提交要走 PR 才进远端 main。
  // 所以「upload 完、PR 未合」那段窗口里，产物 commit 在本地 main = YES、
  // 在 origin/main = NO。判据问本地 main 就会放行一个尚未进主线的版本，
  // 而输出是一句 ✅ —— 没有任何报错。实测 v0.1.603 该窗口长 9 分钟。
  //
  // 字节判据那条在 pickMainRef 的单测里锁住（tests/eval/artifact-identity.test.ts），
  // 这里锁的是 release.sh **退化路径**（本地没产物时的 tag 判据）那一段 shell。
  test("promote 的 tag 退化判据问 origin/main，不是本地 main", () => {
    const start = RELEASE_SH.indexOf('if [ "$DO_PROMOTE" = true ]; then');
    const seg = RELEASE_SH.slice(start, RELEASE_SH.indexOf("单独上传团队默认配置", start));
    // 变异自证：把 _promote_main_ref 的初值改成 "main" → 这条红
    expect(seg).toMatch(/_promote_main_ref="origin\/main"/);
    // is-ancestor 必须用那个变量，而不是硬写 main —— 硬写就绕过了整个选择逻辑
    expect(seg).toMatch(/merge-base --is-ancestor "v\$\{PROMOTE_VERSION\}" "\$_promote_main_ref"/);
    // 退化到本地 main 时必须自报是弱判据，不能静默
    expect(seg).toMatch(/退化到\*\*本地 main\*\*/);
  });

  test("promote 前先 fetch 远端主线（陈旧 origin/main 会让门禁误拒且难归因）", () => {
    const start = RELEASE_SH.indexOf('if [ "$DO_PROMOTE" = true ]; then');
    const seg = RELEASE_SH.slice(start, RELEASE_SH.indexOf("单独上传团队默认配置", start));
    expect(seg).toMatch(/git fetch origin main/);
    // fetch 失败不能阻断：离线发版机是合法场景，退化路径会自报弱判据
    expect(seg).not.toMatch(/git fetch origin main[^\n]*\|\|\s*fail/);
  });
});

describe("A2 旧版本清理必须豁免通道指向的版本", () => {
  // 这是 A2 引入的**新**失效模式，单通道时代不可能发生：
  // beta 泡制期连发几版 → stable 指向的版本被挤出「最近 N 个」窗口 → 被删 →
  // latest.txt 还指着它 → 全部稳定版用户 404，且服务器端什么都不报错。
  test("清理命令读两个指针内容并跳过它们", () => {
    const seg = RELEASE_SH.slice(RELEASE_SH.indexOf("CLEANUP_CMD="));
    expect(seg).toContain("cat latest.txt");
    expect(seg).toContain("cat beta.txt");
    expect(seg).toMatch(/通道指针指向它/);
  });

  // 行为级自证：把清理逻辑那段远程脚本抠出来，在本地真造一个
  // 「stable 指向的版本已被挤出保留窗口」的目录树，跑一遍，断言它没被删。
  // 只读 CLEANUP_CMD 的正则匹配证明不了这段 shell 真的能跑对（引号层数很多）。
  test("真跑：stable 指向的旧版本在保留窗口之外也不会被删", () => {
    const dir = mkdtempSync(join(tmpdir(), "sid-cleanup-"));
    try {
      // 6 个版本目录，保留窗口 = 2，stable 指向最旧的那个
      const versions = ["0.1.701", "0.1.702", "0.1.703", "0.1.704", "0.1.705", "0.1.706"];
      for (const v of versions) mkdirSync(join(dir, v), { recursive: true });
      writeFileSync(join(dir, "latest.txt"), "0.1.701\n");
      writeFileSync(join(dir, "beta.txt"), "0.1.706\n");
      // 非版本号目录与顶层文件都不该被碰
      mkdirSync(join(dir, "not-a-version"), { recursive: true });
      writeFileSync(join(dir, "install.sh"), "#!/bin/bash\n");

      // mtime 决定 ls -1dt 的顺序：显式设成 701 最旧、706 最新。
      // ⚠️ 用 utimesSync 而不是 `touch -d`：`-d` 是 GNU 语法，BSD/macOS 的 touch 不认
      // （它要 `-t YYYYMMDDhhmm`）。实测在 macOS 上 `touch -d` 静默不改 mtime，
      // 于是 6 个目录 mtime 全部相同 → ls -1dt 顺序变成字典序的偶然结果，
      // 这条测试就会**在错的前提下报红或假绿**。Node API 跨平台，没有这个问题。
      const base = Date.parse("2026-08-01T00:00:00Z");
      for (let i = 0; i < versions.length; i++) {
        const t = new Date(base + i * 86_400_000);
        utimesSync(join(dir, versions[i]), t, t);
      }
      // 把非版本号目录设成**最旧**，让它落进删除候选区 —— 这样它同时验证了
      // 版本号形态守卫（`*[0-9].*[0-9].*[0-9]`）真的在拦，而不是靠"恰好在保留窗口内"
      // 侥幸活下来。⚠️ 顺带记一条既有行为：`ls -1dt */` 数的是**目录**而不是版本目录，
      // 所以非版本目录会占用 RELEASE_KEEP_VERSIONS 的名额。服务器顶层目前只有版本目录
      // （install.sh / 两个指针 / team-defaults.json 都是文件），所以线上不受影响；
      // 哪天顶层多出一个非版本子目录，保留窗口就会少一格。
      const oldest = new Date(base - 86_400_000);
      utimesSync(join(dir, "not-a-version"), oldest, oldest);

      // 复刻 release.sh 的清理逻辑（保留 2 个 + 指针豁免）。
      // 这里刻意手抄一份而不是 source release.sh：那个脚本一跑就会 bump 版本号、
      // 跑 bun test、要 SSH 凭据 —— 单测里不能碰。手抄的漂移风险由上面那条
      // 「清理命令读两个指针内容」的契约断言兜着。
      const script = `cd '${dir}' 2>/dev/null || exit 0
_pinned="$(cat latest.txt 2>/dev/null | tr -d '[:space:]') $(cat beta.txt 2>/dev/null | tr -d '[:space:]')"
ls -1dt */ 2>/dev/null | tail -n +3 | while IFS= read -r d; do
    d="\${d%/}"
    case "$d" in
        *[0-9].*[0-9].*[0-9]) ;;
        *) continue ;;
    esac
    case " $_pinned " in
        *" $d "*) echo "  保留 \${d}（通道指针指向它）"; continue ;;
    esac
    rm -rf -- "$d" && echo "  已删除旧版本 $d"
done`;
      const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
      expect(r.status).toBe(0);

      // stable 指向的最旧版本：必须还在（这就是这条豁免的全部意义）
      expect(existsSync(join(dir, "0.1.701"))).toBe(true);
      // beta 指向的最新版本：在保留窗口内，本来就该在
      expect(existsSync(join(dir, "0.1.706"))).toBe(true);
      expect(existsSync(join(dir, "0.1.705"))).toBe(true);
      // 窗口外且无指针指向的：应当被删（否则这条测试就成了"什么都没删"的假绿）
      expect(existsSync(join(dir, "0.1.702"))).toBe(false);
      expect(existsSync(join(dir, "0.1.703"))).toBe(false);
      expect(existsSync(join(dir, "0.1.704"))).toBe(false);
      // 非版本号目录与顶层文件不受影响
      expect(existsSync(join(dir, "not-a-version"))).toBe(true);
      expect(existsSync(join(dir, "install.sh"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("A3 rollback.sh：出事时能照着跑，且不做多余的事", () => {
  test("语法可解析（含 macOS 自带 bash 3.2）", () => {
    const r = spawnSync("/bin/bash", ["-n", join(ROOT, "scripts/rollback.sh")], {
      encoding: "utf8",
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test("两个通道都能回滚（--channel），未知值硬失败", () => {
    expect(ROLLBACK_SH).toContain("--channel");
    expect(ROLLBACK_SH).toMatch(/stable\)\s*POINTER="latest\.txt"/);
    expect(ROLLBACK_SH).toMatch(/beta\)\s*POINTER="beta\.txt"/);
    expect(ROLLBACK_SH).toMatch(/未知通道/);
  });

  test("回滚前校验目标版本产物齐全（不然是从一个坏版本换到另一个装不上的版本）", () => {
    expect(ROLLBACK_SH).toContain("__NO_DIR__");
    expect(ROLLBACK_SH).toContain("__MISSING__");
  });

  test("写完指针要回读自证（scp 成功不等于内容对）", () => {
    expect(ROLLBACK_SH).toContain("_readback");
    expect(ROLLBACK_SH).toMatch(/回读校验失败/);
  });

  test("不碰 git、不删任何东西、不重新构建", () => {
    // 回滚的是"用户拿到哪一版"，不是"仓库停在哪一版"。混在一起会让一次
    // 秒级的止血操作变成一次需要 review 的提交。
    expect(ROLLBACK_SH).not.toMatch(/\bgit (checkout|reset|revert|tag|commit|push)\b/);
    expect(ROLLBACK_SH).not.toMatch(/\brm -rf\b/);
    expect(ROLLBACK_SH).not.toContain("bun build");
  });

  test("默认要交互确认，--yes 才跳过（stable 回滚影响全部用户）", () => {
    expect(ROLLBACK_SH).toMatch(/ASSUME_YES/);
    expect(ROLLBACK_SH).toMatch(/确认回滚/);
  });

  test("明确告知已装坏版本的用户不会自动降级", () => {
    // 这是这个脚本能力边界里最容易被误解的一条：它只挡住"还没更新的人"。
    expect(ROLLBACK_SH).toMatch(/不会自动降级/);
  });

  test("凭据与 release.sh 同源（deploy.env），不新造一套", () => {
    expect(ROLLBACK_SH).toContain("deploy.env");
    expect(ROLLBACK_SH).toContain("DEPLOY_SSH_HOST");
  });
});

describe("A2/A3 文档与脚本自洽（改了一处不许漏另一处）", () => {
  test("install.sh --help 列出了 SID_CODE_CHANNEL", () => {
    expect(INSTALL_SH).toMatch(/SID_CODE_CHANNEL\s+发布通道/);
  });

  test("release.sh 用法段写明 --promote", () => {
    const usage = RELEASE_SH.slice(0, RELEASE_SH.indexOf("发布通道（2026-08-24"));
    expect(usage).toContain("--promote");
  });

  test("CLAUDE.md 的发布流程写明了通道与回滚（出事时人先看它）", () => {
    const md = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    expect(md).toContain("SID_CODE_CHANNEL");
    expect(md).toContain("--promote");
    expect(md).toContain("rollback.sh");
  });
});
