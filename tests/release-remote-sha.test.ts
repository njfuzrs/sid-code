/**
 * 远端 sha256 校验的共享实现（X3-05）—— **行为测试**，不是文本断言。
 *
 * 缺陷形态：`--upload` 落地前校验 与 `--promote` 前复核 各写一份远端脚本，且两处都在
 * 「服务器上没有 sha256sum/shasum」时 `warn` 后继续 —— **跳过校验被当成通过**。
 * 日志与真正校验通过只差一行 ⚠️，而校验存在的唯一价值（拦传输/磁盘的静默损坏）归零。
 *
 * 这份测试真跑那段远端脚本（PATH 里没有 sha 工具 / 有工具且内容匹配 / 内容损坏），
 * 并真跑本地判定分支（默认 fail 退出 vs `--skip-remote-sha` 显式放行）。
 *
 * 变异自证（写的时候真改过一遍再跑）：
 *   · 把 `*__NO_SHA_TOOL__*` 分支改回 `warn` 后 `return 0` → 「缺工具必须 fail」变红
 *   · 把 `remote_sha_verify_script` 里的 `sha256sum -c` 改成 `true` → 「内容损坏」变红
 *   · 把 `judge_remote_sha_output` 的 `*__SHA_OK__*` 分支删掉 → 「校验通过」变红
 *   · 把失败清理钩子那行删掉 → 「失败时清理远端半成品」变红
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LIB = join(ROOT, "scripts/lib/remote-sha.sh");

/**
 * 在 `/bin/bash` 里 source 共享库后跑一段脚本。
 *
 * 刻意**不用** `bash` 这个名字 + 自定义 PATH：`--no-sha-tool` 那条用例需要把 PATH
 * 清成空目录，那样连 `bash` 自己都 spawn 不出来（`Bun.spawnSync` 也是按 PATH 找的）。
 */
function runBash(script: string, env: Record<string, string> = {}) {
  const p = Bun.spawnSync({
    cmd: ["/bin/bash", "-c", `. "${LIB}"\n${script}`],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return {
    code: p.exitCode,
    out: (p.stdout?.toString() ?? "").trim(),
    err: (p.stderr?.toString() ?? "").trim(),
  };
}

/** release.sh 里那四个日志函数的最小 stub —— lib 只依赖它们。 */
const STUB = `
ok()   { echo "OK:$*"; }
warn() { echo "WARN:$*" >&2; }
fail() { echo "FAIL:$*" >&2; exit 1; }
`;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 造一个临时「版本目录」：一个 tar.gz + 它的 .sha256（格式与 release.sh 产出一致）。 */
function makeDirWithArtifact(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "remote-sha-"));
  writeFileSync(join(dir, "sid-code.tar.gz"), content);
  writeFileSync(join(dir, "sid-code.tar.gz.sha256"), `${sha256(content)}  sid-code.tar.gz\n`);
  return dir;
}

function hasShaTool(): boolean {
  return (
    Bun.spawnSync({
      cmd: ["/bin/sh", "-c", "command -v sha256sum || command -v shasum"],
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  );
}

describe("remote_sha_verify_script：远端到底跑什么", () => {
  test("服务器没有 sha 工具 → 输出 __NO_SHA_TOOL__（不是静默成功）", () => {
    // 变异自证：把 else 分支的 echo 删掉 → 这条红
    const dir = makeDirWithArtifact("hello");
    try {
      const r = runBash(`remote_sha_verify_script "${dir}" | /bin/sh`, { PATH: "/nonexistent" });
      expect(r.out).toContain("__NO_SHA_TOOL__");
      expect(r.out).not.toContain("__SHA_OK__");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!hasShaTool())("内容与 .sha256 一致 → __SHA_OK__", () => {
    const dir = makeDirWithArtifact("hello");
    try {
      const r = runBash(`remote_sha_verify_script "${dir}" | /bin/sh`);
      expect(r.out).toContain("__SHA_OK__");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!hasShaTool())("内容被改过 → 报「校验失败」且非 0（这才是校验的价值）", () => {
    const dir = makeDirWithArtifact("hello");
    try {
      // 传输损坏的模拟：字节变了，.sha256 还是旧的
      writeFileSync(join(dir, "sid-code.tar.gz"), "hello-tampered");
      const r = runBash(`remote_sha_verify_script "${dir}" | /bin/sh`);
      expect(r.out).toContain("校验失败");
      expect(r.out).not.toContain("__SHA_OK__");
      expect(r.code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("目录里没有 .sha256 → __SHA_OK__（没有可校验的对象，与「缺工具」是两件事）", () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-sha-empty-"));
    try {
      const r = runBash(`remote_sha_verify_script "${dir}" | /bin/sh`, { PATH: "/nonexistent" });
      expect(r.out).toContain("__SHA_OK__");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("judge_remote_sha_output：没量到 ≠ 通过", () => {
  test("缺工具且没加 --skip-remote-sha → fail 退出，提示装 coreutils", () => {
    // 这是 X3-05 的核心断言。变异自证：改回 `warn` + `return 0` → 这条红。
    const r = runBash(`${STUB}
judge_remote_sha_output "__NO_SHA_TOOL__" "复核"`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FAIL");
    expect(r.err).toContain("coreutils");
    expect(r.err).toContain("--skip-remote-sha");
    expect(r.out).not.toContain("OK:");
  });

  test("缺工具但显式 --skip-remote-sha → 放行，且日志明说「显式跳过」+「没有校验」", () => {
    // 放弃一条门禁必须是命令行上可见的决定，不能只留一行与通过无异的 ⚠️。
    const r = runBash(`${STUB}
export SKIP_REMOTE_SHA=true
judge_remote_sha_output "__NO_SHA_TOOL__" "复核"`);
    expect(r.code).toBe(0);
    expect(r.err).toContain("显式跳过");
    expect(r.err).toContain("没有校验");
  });

  test("校验通过 → ok（不是 warn）", () => {
    const r = runBash(`${STUB}
judge_remote_sha_output "__SHA_OK__" "复核"`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK:");
    expect(r.out).toContain("复核");
  });

  test("输出异常 → fail", () => {
    const r = runBash(`${STUB}
judge_remote_sha_output "something broke" "复核"`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("FAIL");
    expect(r.err).toContain("输出异常");
  });

  test("失败时先跑清理钩子（否则远端半成品目录会留下）", () => {
    // upload 侧传的第三个参数是 _cleanup_remote_staging。
    const r = runBash(`${STUB}
cleanup() { echo "CLEANED"; }
judge_remote_sha_output "__NO_SHA_TOOL__" "落地前校验" cleanup`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("CLEANED");
  });

  test("成功路径**不该**跑清理钩子（清理会删掉刚上传的产物）", () => {
    const r = runBash(`${STUB}
cleanup() { echo "CLEANED"; }
judge_remote_sha_output "__SHA_OK__" "落地前校验" cleanup`);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("CLEANED");
  });
});

describe("release.sh 接线：两处都走共享实现", () => {
  const RELEASE_SH = readFileSync(join(ROOT, "scripts/release.sh"), "utf8");

  test("--upload 与 --promote 都调用 remote_sha_verify_script（仍然各留一份自写脚本 = 缺陷复发）", () => {
    // 变异自证：把其中一处改回内联脚本 → 这条红
    const hits = RELEASE_SH.match(/remote_sha_verify_script/g) ?? [];
    expect(hits.length).toBe(2);
  });

  test("两处判定都走 judge_remote_sha_output", () => {
    const hits = RELEASE_SH.match(/judge_remote_sha_output/g) ?? [];
    expect(hits.length).toBe(2);
  });

  test("--skip-remote-sha 是显式 flag，不是默认开", () => {
    expect(RELEASE_SH).toMatch(/--skip-remote-sha\)\s*SKIP_REMOTE_SHA=true/);
    expect(RELEASE_SH).toMatch(/^SKIP_REMOTE_SHA=false$/m);
  });
});
