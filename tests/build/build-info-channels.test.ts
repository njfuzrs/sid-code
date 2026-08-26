/**
 * `--build-info` 两条读取通道的运行时契约（T1/T2/T5/T13）
 *
 * ## 为什么必须有**两条**通道，而且必须锁它们一致
 *
 * 通道 A（`sid-code --build-info`）在产物可执行时最方便；
 * 通道 B（字节嗅探 `grep -a`）不可替代，因为**最需要读身份的那个场景恰好执行不了产物**：
 * 宿主是 arm64 mac，评测产物是 `linux-x64-baseline`（给 qemu 容器用的）。
 * 实测在 arm64 上执行 x64 产物 → `exec format error`，通道 A 在那里根本不可用。
 *
 * 两条通道读同一份字节，**必须给出相同结果**。不锁这一条的话，
 * 将来有人改了 `--build-info` 的输出而没动嗅探正则（或反之），
 * 嗅探通道会静默继续读老格式 —— **两边都不报错**。
 *
 * ## 这里为什么编一个小 fixture 而不是编真的 bootstrap
 *
 * 真 bootstrap 要先跑 3 个生成脚本（embed-builtin-skills / gen-model-catalog-snapshot /
 * fetch-ripgrep）才编得动 —— 实测缺 `vendor/model-catalog-snapshot.json` 时
 * `bun build` 直接 `Could not resolve`。让单测依赖那套前置会让它在干净 checkout 上变红，
 * 而红的原因与被测的东西无关。
 *
 * fixture 走的是**同一个 shared 模块 + 同一个正则常量**，
 * 而"通道 A 与通道 B 是否一致"这个契约完全落在那两样东西上 ——
 * 所以用 fixture 测到的正是要锁的东西。
 * 真产物那一层由 A1/A2/A7 三条人工验收覆盖（见方案 §12），它们本就要在发布前跑。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILD_INFO_GREP_PATTERN,
  BUILD_INFO_SNIFF_REGEX,
  parseBuildInfoLine,
} from "@sid-code/shared/build-info.ts";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * 合成身份行。builder 刻意带 `@` 与 `+`、branch 刻意带 `/` slug 后的形态 ——
 * 值域字符类漏字符时的症状是**从截断点往后静默丢字段**，
 * 所以测试数据必须踩到那些字符，否则这条测试测不到 T15 那个事故。
 */
const FAKE_LINE =
  "SIDCODE_BUILD_V1|commit=1234567890abcdef1234567890abcdef12345678|branch=fix-some-branch|describe=v0.1.601-59-g4544c79c|dirty=false|built_at=2026-08-26T00:00:00Z|builder=272990952+someone@users.noreply.github.com|origin=local";

let TMP: string;
let FIXTURE_BIN: string;

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "sid-build-info-"));

  // fixture 用**真模块**的导出，不复制一份实现 —— 复制一份就测不到模块被改坏。
  const entry = join(TMP, "entry.ts");
  writeFileSync(
    entry,
    [
      `import { getBuildInfo, formatBuildInfoJson } from "${join(ROOT, "packages/shared/src/build-info.ts")}";`,
      `console.log(formatBuildInfoJson(getBuildInfo(), "0.0.0-fixture"));`,
    ].join("\n"),
  );

  FIXTURE_BIN = join(TMP, "fixture");
  const build = Bun.spawnSync({
    cmd: [
      "bun",
      "build",
      "--compile",
      "--define",
      `process.env.SID_CODE_BUILD_INFO="${FAKE_LINE}"`,
      "--outfile",
      FIXTURE_BIN,
      entry,
    ],
    cwd: ROOT,
  });
  if (build.exitCode !== 0) {
    throw new Error(`fixture 构建失败：${new TextDecoder().decode(build.stderr)}`);
  }
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

describe("两条通道的一致性（T5）", () => {
  test("通道 A（执行）与通道 B（嗅探）对同一份字节给出**全部字段**相同", () => {
    // 通道 A
    const run = Bun.spawnSync({ cmd: [FIXTURE_BIN] });
    expect(run.exitCode).toBe(0);
    const channelA = JSON.parse(new TextDecoder().decode(run.stdout));

    // 通道 B：不执行，只 grep 字节。用与生产同一条 grep 正则常量。
    const sniff = Bun.spawnSync({
      cmd: ["grep", "-a", "-m1", "-o", BUILD_INFO_GREP_PATTERN, FIXTURE_BIN],
      env: { ...process.env, LC_ALL: "C" },
    });
    expect(sniff.exitCode).toBe(0);
    const sniffedLine = new TextDecoder().decode(sniff.stdout).trim();
    const channelB = parseBuildInfoLine(sniffedLine);

    // ⚠️ 必须比**全部身份字段**而不是只比 commit。
    // 只比 commit 时，值域漏一个字符（如 `@`）的事故不会让这条红 ——
    // 因为 commit 恰好是第一个字段、截断从它**后面**开始。
    for (const k of [
      "schema",
      "commit",
      "branch",
      "describe",
      "dirty",
      "built_at",
      "builder",
      "origin",
      "identity_source",
    ] as const) {
      expect(channelB[k]).toEqual(channelA[k]);
    }

    // 嗅探取回的必须是完整那一行（不是被截断的一截）
    expect(sniffedLine).toBe(FAKE_LINE);
    expect(channelB.identity_source).toBe("embedded");

    // JS 正则常量与 grep 正则常量必须同源同锚点 —— 否则「通道 A/B 一致」
    // 会退化成「两个各自自洽但互不相同的读法」。
    expect(FAKE_LINE.match(BUILD_INFO_SNIFF_REGEX)?.[0]).toBe(FAKE_LINE);
  });

  test("嗅探正则锚在 commit= 上：裸前缀常量不会被当成身份（实测踩过）", () => {
    // 实测事实：`BUILD_INFO_PREFIX` 这个常量本身也是产物里的一个字符串，
    // 所以每个产物里**至少两处**命中前缀，而先后顺序是运气。
    // 只锚前缀时 `grep -m1` 可能取到那个空壳 → 解析出 commit=unknown →
    // 门禁把一个身份完好的产物判成"没有身份"，退化到 mtime 兜底，且不报错。
    //
    // 变异自证：把 BUILD_INFO_GREP_PATTERN 里的 `commit=` 去掉 → 红
    expect(BUILD_INFO_GREP_PATTERN).toContain("commit=");
    // 空壳（只有前缀）不该被匹配
    const shell = "SIDCODE_BUILD_V1|";
    expect(shell.match(BUILD_INFO_SNIFF_REGEX)).toBeNull();
  });

  test("嗅探取到的是真值而不是排在它前面的默认值（T4 的真产物形态）", () => {
    // §3.5 的实测事实：默认值那个字面量**会留在二进制里，而且排在真值前面**
    // （因为它存进了一个独立的 const，DCE 保不住它）。
    // 所以正确性不能依赖 `-m1`，只能依赖「默认值用不同前缀」。
    // 这条测试就是在真产物上验证那个前提。
    const offsets = (pattern: string): number => {
      const p = Bun.spawnSync({
        cmd: ["grep", "-a", "-b", "-o", pattern, FIXTURE_BIN],
        env: { ...process.env, LC_ALL: "C" },
      });
      const out = new TextDecoder().decode(p.stdout).trim();
      if (!out) return -1;
      return Number(out.split("\n")[0].split(":")[0]);
    };

    const noneAt = offsets("SIDCODE_BUILD_V0_NONE|");
    const realAt = offsets("SIDCODE_BUILD_V1|commit=1234567890");
    // 裸前缀常量本身也在二进制里（模块导出了它），且顺序是运气 ——
    // 这正是嗅探正则必须锚在 `commit=` 上的原因，见 build-info.ts 里
    // BUILD_INFO_GREP_PATTERN 的注释。
    const bareAt = offsets("SIDCODE_BUILD_V1|");
    expect(bareAt).toBeGreaterThanOrEqual(0);

    // 真值必须在（否则 define 没生效，这条测试就没在测东西）
    expect(realAt).toBeGreaterThanOrEqual(0);

    // 默认值**可能**在也可能被 DCE 掉（随 bun 版本变），两种情况都不影响正确性 ——
    // 因为嗅探正则只认 V1 前缀。这里断言的是：**不管默认值在不在、在哪**，
    // 嗅探结果都是真值。
    // 变异自证：把 BUILD_INFO_NONE_PREFIX 改成与真值同前缀 → 若默认值排在前面，这条红
    const sniff = Bun.spawnSync({
      cmd: ["grep", "-a", "-m1", "-o", BUILD_INFO_GREP_PATTERN, FIXTURE_BIN],
      env: { ...process.env, LC_ALL: "C" },
    });
    const line = new TextDecoder().decode(sniff.stdout).trim();
    expect(parseBuildInfoLine(line).commit).toBe("1234567890abcdef1234567890abcdef12345678");
    if (noneAt >= 0) {
      // 记录一下这个事实：默认值确实留在了产物里 —— 它无害只是因为前缀不同。
      expect(noneAt).not.toBe(realAt);
    }
  });

  test("运行时 env 无法伪造身份（T13）", () => {
    // `--define` 是编译期字面量替换，不是运行时读 env。正因如此这个字段可以当身份用 ——
    // 否则任何人 `SID_CODE_BUILD_INFO=<别的 commit> ./sid-code` 就能骗过所有门禁。
    // 变异自证：把模块里的 define 读法改成运行时 `process.env` 查表 → 红
    const run = Bun.spawnSync({
      cmd: [FIXTURE_BIN],
      env: {
        ...process.env,
        SID_CODE_BUILD_INFO:
          "SIDCODE_BUILD_V1|commit=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef|origin=release",
      },
    });
    const info = JSON.parse(new TextDecoder().decode(run.stdout));
    expect(info.commit).toBe("1234567890abcdef1234567890abcdef12345678");
    expect(info.origin).toBe("local");
  });
});

describe("--build-info 快速路径（T1/T2）", () => {
  /** 跑真 bootstrap 的源码入口。源码直跑没有 define，此时允许从真实 env 注入。 */
  function runBootstrap(
    args: string[],
    extraEnv: Record<string, string> = {},
  ): { stdout: string; stderr: string; exitCode: number | null; configDir: string } {
    // ⚠️ 必须把 SID_CONFIG_DIR 指到 tmpdir：本仓硬约定，否则测试会往用户真实的
    // ~/.sid-code/ 里灌数据，把线上遥测查询污染成查不到真记录（且测试全绿）。
    const configDir = mkdtempSync(join(tmpdir(), "sid-bi-cfg-"));
    const p = Bun.spawnSync({
      cmd: ["bun", "run", join(ROOT, "packages/cli/src/entrypoints/bootstrap.ts"), ...args],
      cwd: ROOT,
      env: { ...process.env, SID_CONFIG_DIR: configDir, ...extraEnv },
    });
    return {
      stdout: new TextDecoder().decode(p.stdout),
      stderr: new TextDecoder().decode(p.stderr),
      exitCode: p.exitCode,
      configDir,
    };
  }

  test("--build-info --json 输出可解析且含全部身份字段（T2）", () => {
    const r = runBootstrap(["--build-info", "--json"], { SID_CODE_BUILD_INFO: FAKE_LINE });
    rmSync(r.configDir, { recursive: true, force: true });
    expect(r.exitCode).toBe(0);

    const info = JSON.parse(r.stdout);
    // 变异自证：从 BuildInfo 里删掉任一字段（或忘了在 formatBuildInfoJson 里带上）→ 红
    for (const k of [
      "schema",
      "commit",
      "branch",
      "describe",
      "dirty",
      "built_at",
      "builder",
      "origin",
      "identity_source",
    ]) {
      expect(info).toHaveProperty(k);
    }
    expect(info.commit).toBe("1234567890abcdef1234567890abcdef12345678");
    // version 是**运行时补充字段**（来自 getRawVersion()），不是身份字段。
    // 编进字节的那一行不含它 —— 那样会制造两个可能不一致的源。门禁一律不读它。
    expect(info).toHaveProperty("version");
    expect(FAKE_LINE).not.toContain("version=");
  });

  test("--build-info 文本输出人可读，且无身份时明确点破（T12 的基础）", () => {
    const ok = runBootstrap(["--build-info"], { SID_CODE_BUILD_INFO: FAKE_LINE });
    rmSync(ok.configDir, { recursive: true, force: true });
    expect(ok.stdout).toContain("commit    1234567890abcdef1234567890abcdef12345678");
    expect(ok.stdout).toContain("origin    local");

    // 无身份时：不能只显示一个 unknown 了事。本仓实测教训
    // （metric-exists-but-value-is-junk）：字段在、有值、看起来正常，但值是废的。
    // 输出必须让人看出「这是没量到」而不是「这是没变」。
    // 变异自证：删掉 formatBuildInfoText 里那段警告 → 红
    const none = runBootstrap(["--build-info"], { SID_CODE_BUILD_INFO: "" });
    rmSync(none.configDir, { recursive: true, force: true });
    expect(none.stdout).toContain("commit    unknown");
    expect(none.stdout).toContain("不含构建身份");
    expect(none.stdout).toContain("没量到");
  });

  test("--build-info 在零导入快速路径里：完整 CLI 一次都没加载（T1）", () => {
    // 门禁要在**任何环境**下都能问身份 —— 配置缺失、~/.sid-code/ 不存在、
    // 网关不可达时都得能读出来。走完整 CLI 会读配置、注册工具、可能落盘，
    // 那时"读一下身份"就成了一个有副作用、且会因环境不全而失败的操作。
    //
    // ⚠️ 判据用 **profiler 的 `full_cli_entry` 打点**（只在 cli.ts 被 import 时打），
    // 不用「配置目录里有没有文件」。后者看着更直观，但**没有区分度**：
    // 实测把快速路径关掉后，完整 CLI 在 parseArgs 阶段就以「未知选项 --build-info」
    // 退出了，**一个文件都没写** —— 那条断言照样绿。
    // 这正是本仓「代理指标会奖励把浪费重新贴标签」那条教训的同一形态：
    // 断言看起来在测"没副作用"，实际测的是"那条路径恰好早退了"。
    //
    // 变异自证：把这个快速路径的条件改成 `false && ...`（退回完整 CLI）→
    // 输出里出现 full_cli_entry → 红。（已实测：绕过前 grep -c 得 1，绕过后得 0。）
    const r = runBootstrap(["--build-info"], {
      SID_CODE_BUILD_INFO: FAKE_LINE,
      SID_CODE_PROFILE_STARTUP: "1",
    });
    const left = readdirSync(r.configDir);
    rmSync(r.configDir, { recursive: true, force: true });

    // ⚠️ 断言顺序有讲究：**先断 full_cli_entry，再断 exitCode**。
    // 反过来写的话，变异（绕过快速路径）会先在 exitCode 上炸掉 ——
    // 测试确实变红了，但红的是另一条断言，于是"这条断言有没有区分度"根本没被验证。
    // profiler 报告走 stderr（见 bootstrap.ts 的 process.on("exit")）。
    const all = r.stdout + r.stderr;
    expect(all).toContain("bootstrap_route_resolved"); // 确认 profiler 真的开着（否则这条测试测不到东西）
    expect(all).not.toContain("full_cli_entry");
    expect(r.exitCode).toBe(0);
    // 顺带断言无落盘 —— 它区分度不够，但作为附加约束仍然有意义
    expect(left).toEqual([]);
  });

  test("--build-info 后面跟别的参数时不劫持（避免把真实调用吞掉）", () => {
    // 只认 `--build-info` 与 `--build-info --json` 两种形态。
    // 放宽成 `args.includes("--build-info")` 会让
    // `sid-code -p "帮我看看 --build-info 是什么"` 这类调用被快速路径吞掉。
    const r = runBootstrap(["--build-info", "--unexpected-extra"], {
      SID_CODE_BUILD_INFO: FAKE_LINE,
    });
    rmSync(r.configDir, { recursive: true, force: true });
    // 不该走身份快速路径 → stdout 里不会是那一行身份
    expect(r.stdout).not.toContain("1234567890abcdef1234567890abcdef12345678");
  });
});
