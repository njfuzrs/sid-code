/**
 * 产物身份门禁的判定单测（G1 评测前置 / G2 发布通道）
 *
 * 被测：`scripts/lib/artifact-identity.ts` + `preflight.ts` 的 ⑥ + `grade.ts` 的身份字段
 *
 * ## 这份测试自己的判据
 *
 * 本仓的教训是「新增门禁必做变异自证」—— **一个恒绿的门禁比没有门禁更坏**，
 * 因为它看起来是在保护你。所以下面每条断言都配了「变异自证」注释：
 * 把实现改成那样时它必须变红。写的时候真改过一遍再跑。
 *
 * ## 最要紧的三对断言（每对都必须成对存在）
 *
 * 1. **T8 拦真 stale × T9 不拦 docs-only**。只有 T8 时，把判据写成
 *    「全仓 `git log C..HEAD` 非空」也能过（更严嘛）；只有 T9 时，
 *    「永远放行」也能过。**只有成对存在才锁住那个精度**，
 *    而那个精度就是这道门禁能不能长期活下去的全部 —— 误报会训练人绕过门禁。
 * 2. **T10 `cp` 后仍能识破 × T11 不看 mtime**。上一轮的 mtime 判据在这两条上
 *    一条都过不了（实测：`cp` 把 mtime 重置成"现在"，内容一字未改，门禁放行）。
 * 3. **T12 「没量到」不冒充「量到了」**。preflight 的 `skip`→INCOMPLETE 那条语义
 *    在这里复用：把 `no-identity` 记成 pass 就造出一个绿灯，
 *    而绿灯背后是一次没做的检查。
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parseBuildInfoLine } from "@sid-code/shared/build-info.ts";
import {
  BUILD_INPUT_PATHS,
  EXIT_CODE,
  assessArtifact,
  judgePromote,
  judgeReleaseUpload,
  sniffArtifactIdentity,
  verifySidecar,
  type GitProbe,
} from "../../scripts/lib/artifact-identity.ts";
import { assessArtifactIdentityCheck } from "../../evals/external-benchmarks/swe-bench/preflight.ts";
import {
  buildAcceptance,
  renderIdentityLines,
  renderReport,
} from "../../evals/external-benchmarks/swe-bench/grade.ts";

const ROOT = join(import.meta.dir, "..", "..");
const C_ART = "1111111111111111111111111111111111111111";
const C_HEAD = "2222222222222222222222222222222222222222";

/** 一行合法身份。默认 origin=local、dirty=false，各用例按需覆盖。 */
function line(over: Record<string, string> = {}): string {
  const kv: Record<string, string> = {
    commit: C_ART,
    branch: "main",
    describe: "v0.1.601-59-gabc",
    dirty: "false",
    built_at: "2026-08-26T00:00:00Z",
    builder: "bot@example.com",
    origin: "local",
    ...over,
  };
  return (
    "SIDCODE_BUILD_V1|" +
    Object.entries(kv)
      .map(([k, v]) => `${k}=${v}`)
      .join("|")
  );
}

/**
 * 表驱动的假 GitProbe，**并记录每个方法被调用了几次**。
 *
 * 记调用次数不是装饰：有一条断言（T14）要求「commit 形态非法时一条 git 命令都不发」。
 * 消费方是 bash，一个含 `;` 或 `$(...)` 的 commit 值注入面是真实的 ——
 * 而只断言"返回值对"测不出"它其实先把那个值拼进了一条 git 命令"。
 */
function fakeProbe(over: Partial<GitProbe> = {}): GitProbe & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const count = <T>(name: string, v: T): T => {
    calls[name] = (calls[name] ?? 0) + 1;
    return v;
  };
  const base: GitProbe = {
    commitExists: () => count("commitExists", true),
    isAncestor: () => count("isAncestor", true),
    buildInputCommitsSince: () => count("buildInputCommitsSince", []),
    describe: () => count("describe", "v0.1.601-59-gabc"),
    revParse: () => count("revParse", C_HEAD),
    isDirty: () => count("isDirty", false),
    commitTime: () => count("commitTime", 1_756_000_000),
  };
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    // 覆盖时也要计数，否则 T14 那条数不到被覆盖的方法
    merged[k] = (...args: unknown[]) => count(k, (v as (...a: unknown[]) => unknown)(...args));
  }
  return Object.assign(merged as unknown as GitProbe, { calls });
}

function assess(
  info = parseBuildInfoLine(line()),
  probe = fakeProbe(),
  mtime: number | null = 1_756_000_000,
) {
  return assessArtifact({ artifactPath: "/tmp/x/sid-code", info, probe, artifactMtimeSec: mtime });
}

// ─────────────────────────────────────────────────────────────────────────────
// G1 判据的精度：T8 / T9 必须成对
// ─────────────────────────────────────────────────────────────────────────────

describe("G1：产物 commit ∈ 当前历史 且此后没改过编译输入", () => {
  test("T8 产物之后改过编译输入 → stale（这是本方案要消灭的那个形态）", () => {
    // 变异自证：把 assessArtifact 里 `changed.length > 0` 改成 `> 1` → 红
    const a = assess(
      parseBuildInfoLine(line()),
      fakeProbe({ buildInputCommitsSince: () => ["abc1234 fix: 429 retry"] }),
    );
    expect(a.verdict).toBe("stale");
    expect(a.changedInputCommits).toHaveLength(1);
    // 理由里必须点破「分数会看起来完全正常」—— 这是这道门禁存在的全部理由，
    // 只写「产物旧了」的话读的人不会理解为什么要停。
    expect(a.reasons.join(" ")).toContain("分数会看起来完全正常");
  });

  test("T9 只改了 docs（编译输入没动）→ ok，不拦", () => {
    // ⚠️ 这条与 T8 必须**成对存在**：
    //   只有 T8 时，把判据写成全仓 `git log C..HEAD` 非空也能过（更严嘛）；
    //   只有 T9 时，「永远放行」也能过。
    // 成对之后锁住的是**精度**，而精度决定这道门禁能不能长期活下去 ——
    // 误报会训练人「先加 SWE_ALLOW_STALE_ARTIFACT=1 再说」，
    // 于是它真正该拦的那次也被放过去了。
    //
    // 变异自证：把 buildInputCommitsSince 的 `-- <BUILD_INPUT_PATHS>` 去掉
    //（退化成全仓 git log）→ docs 提交会让它返非空 → 红
    const a = assess(parseBuildInfoLine(line()), fakeProbe({ buildInputCommitsSince: () => [] }));
    expect(a.verdict).toBe("ok");
    expect(a.reasons).toHaveLength(0);
  });

  test("T9b 判据真的把路径限定在编译输入上（不是靠 fake 装出来的）", () => {
    // 上面 T9 用的是假 probe，所以它测不到「真实现是否带了 `-- <paths>`」。
    // 这条从**清单本身**下手：website/ 与 .agents/ 不许出现在编译输入里，
    // 否则一次 docs 提交就会把好产物判成 stale。
    // 变异自证：往 BUILD_INPUT_PATHS 里加 "website/" → 红
    const paths = BUILD_INPUT_PATHS.join(" ");
    expect(paths).not.toContain("website/");
    expect(paths).not.toContain(".agents/");
    expect(paths).not.toContain("evals/");
    // 反向：源码必须在里面，否则改了代码也不算 stale = 门禁形同虚设
    expect(BUILD_INPUT_PATHS).toContain("packages/");
  });

  test("T3 编译输入清单覆盖 Makefile build 目标真正用到的每个脚本", () => {
    // 这份清单会漂移，且**漂移不报错**：漏一条 = 该条改动之后产物不算 stale。
    // 所以从构建命令反向核对（本仓已有的模式：node-env-define.test.ts 也是扫构建命令）。
    // 变异自证：从 BUILD_INPUT_PATHS 删掉 scripts/embed-builtin-skills.ts → 红
    const mk = readFileSync(join(ROOT, "Makefile"), "utf8");
    const buildBlock = mk.slice(mk.indexOf("\nbuild:"), mk.indexOf("\nrebuild:"));
    const scripts = [...buildBlock.matchAll(/scripts\/[A-Za-z0-9._-]+/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) {
      expect(BUILD_INPUT_PATHS.some((p) => p === s || s.startsWith(p))).toBe(true);
    }
    // 身份行脚本自己也必须在清单里 —— 它的输出直接进字节
    expect(BUILD_INPUT_PATHS).toContain("scripts/build-info-line.sh");
    // Makefile 自己也算（BUILD_DEFINES 在里面）
    expect(BUILD_INPUT_PATHS).toContain("Makefile");
  });

  test("T11 判据完全不看 mtime（产物 mtime 比 HEAD 早也照样 ok）", () => {
    // 变异自证：在 assessArtifact 的 embedded 分支里加一条 mtime 比较 → 红
    const a = assess(parseBuildInfoLine(line()), fakeProbe(), 1);
    expect(a.verdict).toBe("ok");
    expect(a.identitySource).toBe("embedded");
  });

  test("跨分支的产物 → foreign（与 stale 是两个 verdict，不合成一个）", () => {
    // 两个逃生舱语义不同：想做对照实验的人不该顺手把「别的分支」也放过去。
    // 变异自证：把 foreign 归并进 stale → 红
    const a = assess(parseBuildInfoLine(line()), fakeProbe({ isAncestor: () => false }));
    expect(a.verdict).toBe("foreign");
    expect(EXIT_CODE.foreign).not.toBe(EXIT_CODE.stale);
  });

  test("commit 不在本地对象库 → unknown-commit，且**没有逃生舱**", () => {
    const a = assess(parseBuildInfoLine(line()), fakeProbe({ commitExists: () => false }));
    expect(a.verdict).toBe("unknown-commit");
    // 退出码 4 在 exec-swebench.sh 的 case 里落到「没有逃生舱」那一支：
    // 取不到那个 commit 时，给逃生舱等于允许在不知道跑的是什么的情况下出一个分数。
    expect(EXIT_CODE["unknown-commit"]).toBe(4);
  });

  test("T14 commit 形态非法时**一条 git 命令都不发**（bash 侧注入面是真实的）", () => {
    // 消费方是 bash。一个含 `;` 或 `$(...)` 的值被拼进 git 命令会被 shell 展开。
    // 变异自证：把 assessArtifact 里的 isUsableCommit 检查删掉 → commitExists 会被调用 → 红
    const probe = fakeProbe();
    const a = assessArtifact({
      artifactPath: "/tmp/x",
      info: parseBuildInfoLine("SIDCODE_BUILD_V1|commit=abc;rm -rf /|branch=main"),
      probe,
      artifactMtimeSec: 1_756_000_000,
    });
    expect(a.verdict).toMatch(/^no-identity/);
    expect(probe.calls.commitExists ?? 0).toBe(0);
    expect(probe.calls.isAncestor ?? 0).toBe(0);
    expect(probe.calls.buildInputCommitsSince ?? 0).toBe(0);
  });

  test("T6 旁路 build-info.json 与字节不一致 → sidecar-mismatch（字节才是事实源）", () => {
    const a = assessArtifact({
      artifactPath: "/tmp/x",
      info: parseBuildInfoLine(line()),
      probe: fakeProbe(),
      artifactMtimeSec: 1_756_000_000,
      sidecar: { ok: false, reason: "旁路说 A，字节里是 B" },
    });
    expect(a.verdict).toBe("sidecar-mismatch");
  });

  test("T6b verifySidecar 真的比对 commit（不是只看文件存在）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-sidecar-"));
    try {
      const art = join(dir, "sid-code");
      writeFileSync(art, "x");
      // 没有旁路文件 → null（不算问题）
      expect(verifySidecar(art, parseBuildInfoLine(line()))).toBeNull();
      // 一致 → ok
      writeFileSync(join(dir, "build-info.json"), JSON.stringify({ commit: C_ART }));
      expect(verifySidecar(art, parseBuildInfoLine(line()))?.ok).toBe(true);
      // 不一致 → 必须报出来。变异自证：把那个 !== 比较删掉 → 红
      writeFileSync(join(dir, "build-info.json"), JSON.stringify({ commit: C_HEAD }));
      expect(verifySidecar(art, parseBuildInfoLine(line()))?.ok).toBe(false);
      // 坏 json 也不能当"没有旁路文件"—— 那是把「读不了」当「不存在」
      writeFileSync(join(dir, "build-info.json"), "{ not json");
      expect(verifySidecar(art, parseBuildInfoLine(line()))?.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("产物 dirty 是 warning 不是 fail，但必须点破", () => {
    // 只能报警不能解决（改动内容确实无记录），但**不能假装 commit 描述了全部**。
    // 变异自证：把那条 warnings.push 删掉 → 红
    const a = assess(parseBuildInfoLine(line({ dirty: "true", origin: "release" })));
    expect(a.verdict).toBe("ok");
    expect(a.warnings.join(" ")).toContain("只可自比");
  });

  test("dirty 读不到时也要点破（三态不塌成 false）", () => {
    const info = parseBuildInfoLine("SIDCODE_BUILD_V1|commit=" + C_ART + "|branch=main");
    expect(info.dirty).toBe("unknown");
    expect(assess(info).warnings.join(" ")).toContain("不能替它断言");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T12：「没量到」不许冒充「量到了且没变」
// ─────────────────────────────────────────────────────────────────────────────

describe("T12 身份读不到 = 没量到（不是通过）", () => {
  test("no-identity 放行但明说退化到 mtime 兜底", () => {
    // 放行是刻意的：老产物是既有事实，硬拦只会逼人绕过整道门禁。
    // 但**退化路径必须写出来** —— 否则一个走兜底的 run 与量到了的 run 看起来一样。
    // 变异自证：把 identitySource 恒设为 "embedded" → 红
    const a = assess(parseBuildInfoLine(""), fakeProbe());
    expect(a.identitySource).toBe("mtime-fallback");
    expect(EXIT_CODE[a.verdict]).toBe(0);
    expect(a.reasons.join(" ")).toContain("mtime 兜底");
    // commit 绝不能被回填成宿主 HEAD —— 那正是本方案起因那个事故的形态
    expect(a.info.commit).toBe("unknown");
    expect(a.commitMatchesHost).toBeNull();
  });

  test("preflight ⑥：no-identity → skip（→ INCOMPLETE），不是 pass", () => {
    // 变异自证：把这一支改成 status: "pass" → 红
    const r = assessArtifactIdentityCheck({
      verdict: "no-identity",
      identitySource: "mtime-fallback",
      artifactCommit: "unknown",
      hostHeadCommit: C_HEAD,
      changedInputCommits: 0,
    });
    expect(r.status).toBe("skip");
    expect(r.reason).toContain("没量到");
  });

  test("preflight ⑥：stale → fail；ok → pass；未知 verdict → skip（不是 pass）", () => {
    expect(
      assessArtifactIdentityCheck({
        verdict: "stale",
        identitySource: "embedded",
        artifactCommit: C_ART,
        hostHeadCommit: C_HEAD,
        changedInputCommits: 4,
      }).status,
    ).toBe("fail");
    expect(
      assessArtifactIdentityCheck({
        verdict: "ok",
        identitySource: "embedded",
        artifactCommit: C_ART,
        hostHeadCommit: C_HEAD,
        changedInputCommits: 0,
      }).status,
    ).toBe("pass");
    // 判定表将来加了新档而这里忘了同步时，落到 pass 就是静默放行。
    // 变异自证：把 default 分支改成 pass → 红
    expect(
      assessArtifactIdentityCheck({
        verdict: "some-future-verdict",
        identitySource: "embedded",
        artifactCommit: C_ART,
        hostHeadCommit: C_HEAD,
        changedInputCommits: 0,
      }).status,
    ).toBe("skip");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T10：cp 之后仍能识破（mtime 判据在这条上必挂）
// ─────────────────────────────────────────────────────────────────────────────

describe("T10 身份跟着字节走（cp 改不了它）", () => {
  test("嗅探裸文件与它的 cp 副本得到同一行身份", () => {
    // 上一轮的 mtime 判据在这条上必挂：`cp` 把 mtime 重置成"现在"，
    // 内容一字未改，门禁放行 —— 而这正是它本该抓的场景。
    // 变异自证：把嗅探改成读旁路文件 → cp 单个文件时旁路会丢 → 红
    const dir = mkdtempSync(join(tmpdir(), "sc-cp-"));
    try {
      const a = join(dir, "art");
      // 不必真编译：嗅探读的就是字节里那一行。真产物那一层由
      // tests/build/build-info-channels.test.ts 的 fixture 覆盖。
      writeFileSync(a, `\0\0junk ${line({ origin: "release" })} more\0`);
      const b = join(dir, "copied");
      Bun.spawnSync({ cmd: ["cp", a, b] });
      const r1 = sniffArtifactIdentity(a, { run: () => ({ code: 127, out: "" }) });
      void r1;
      // 用真 runner 走 grep（与生产同一条正则常量）
      const runner = {
        run: (cmd: string[]) => {
          const p = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
          return { code: p.exitCode ?? 1, out: p.stdout?.toString() ?? "" };
        },
      };
      const A = sniffArtifactIdentity(a, runner);
      const B = sniffArtifactIdentity(b, runner);
      expect(A.info.commit).toBe(C_ART);
      expect(B.info.commit).toBe(C_ART);
      expect(B.line).toBe(A.line);
      expect(B.info.origin).toBe("release");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tar.gz 走流式嗅探（不解包落盘），与裸文件同结果", () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-tar-"));
    try {
      mkdirSync(join(dir, "stage", "sid-code"), { recursive: true });
      writeFileSync(join(dir, "stage", "sid-code", "sid-code"), `# ${line()}\n`);
      const pkg = join(dir, "p.tar.gz");
      Bun.spawnSync({ cmd: ["tar", "-czf", pkg, "-C", join(dir, "stage"), "sid-code"] });
      const runner = {
        run: (cmd: string[]) => {
          const p = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
          return { code: p.exitCode ?? 1, out: p.stdout?.toString() ?? "" };
        },
      };
      // 变异自证：把 sniffArtifactIdentity 的 tarball 分支删掉 → 读不到 → 红
      expect(sniffArtifactIdentity(pkg, runner).info.commit).toBe(C_ART);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G2：发布通道
// ─────────────────────────────────────────────────────────────────────────────

describe("G2 发布通道门禁", () => {
  const NAME = "sid-code-0.1.602-linux-x64.tar.gz";

  test("按 release.sh 真实执行顺序的产物 → 通过（dirty=true 且只脏 package.json）", () => {
    // ⚠️ 这条是整个 G2 里最容易写错的一格。真实顺序是
    // 洁净门禁 → bump（package.json 变脏）→ 构建 → 提交 → 打 tag，
    // 所以构建那一刻 dirty **必为 true**、HEAD 是 bump 提交的**父**提交。
    // 写成 `dirty == false` 会 100% 误拦每一次真实发版，然后被人加 flag 绕过。
    //
    // 变异自证：把 judgeReleaseUpload 里 dirty 那一支改成「dirty 即拒」→ 红
    const r = judgeReleaseUpload({
      info: parseBuildInfoLine(
        line({ origin: "release", dirty: "true", dirty_files: "package.json" }),
      ),
      expectedCommit: C_ART,
      artifactName: NAME,
    });
    expect(r.ok).toBe(true);
  });

  test("origin=local 的手工包 → 拒（这是 G2 存在的首要理由）", () => {
    // 在这之前 release.sh 对产物只检查「文件存在」，所以手工 bun build 的二进制
    // 被塞进 dist/release/<ver>/ 再 --upload 是完全可行且无声的。
    // 变异自证：把 origin 判据删掉 → 红
    const r = judgeReleaseUpload({
      info: parseBuildInfoLine(line({ origin: "local", dirty: "false" })),
      expectedCommit: C_ART,
      artifactName: NAME,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toContain("origin=local");
  });

  test("真的带着未提交代码发版（脏文件不止 package.json）→ 拒", () => {
    // 这个形态只有**解析 dirty_files** 才抓得到 —— 只看布尔位的话只能二选一：
    // 恒拦（误拦每次发版）或不检查（漏掉这个形态）。
    // 变异自证：把 unexpected 那段过滤删掉 → 红
    const r = judgeReleaseUpload({
      info: parseBuildInfoLine(
        line({
          origin: "release",
          dirty: "true",
          dirty_files: "package.json+packages/core/src/x.ts",
        }),
      ),
      expectedCommit: C_ART,
      artifactName: NAME,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toContain("packages/core/src/x.ts");
  });

  test("dirty=true 但没记 dirty_files → 拒（区分不了两种脏）", () => {
    const r = judgeReleaseUpload({
      info: parseBuildInfoLine(line({ origin: "release", dirty: "true" })),
      expectedCommit: C_ART,
      artifactName: NAME,
    });
    expect(r.ok).toBe(false);
  });

  test("产物 commit ≠ v<ver>^ → 拒", () => {
    const r = judgeReleaseUpload({
      info: parseBuildInfoLine(
        line({ origin: "release", dirty: "true", dirty_files: "package.json" }),
      ),
      expectedCommit: C_HEAD,
      artifactName: NAME,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toContain("对不上");
  });

  test("取不到 v<ver>^ → 提示但不拦（tag 还没打是合法中间态）", () => {
    // 拦的话 --no-commit / 首发场景全过不去，而那不是它要防的东西。
    const r = judgeReleaseUpload({
      info: parseBuildInfoLine(
        line({ origin: "release", dirty: "true", dirty_files: "package.json" }),
      ),
      expectedCommit: null,
      artifactName: NAME,
    });
    expect(r.ok).toBe(true);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  test("发布产物没有身份 → 拒（与评测路径刻意不同）", () => {
    // 评测要容忍老产物（既有事实），而发布产物是这一刻刚编出来的 ——
    // 没有身份只能说明构建循环漏了 define。
    // 变异自证：把这一支改成 ok: true → 红
    const r = judgeReleaseUpload({
      info: parseBuildInfoLine(""),
      expectedCommit: C_ART,
      artifactName: NAME,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toContain("漏带");
  });

  test("promote：产物不是 main 的祖先 → 拒（拦分支包上稳定通道）", () => {
    // 变异自证：把 isAncestorOfMain 判据删掉 → 红
    const r = judgePromote({
      info: parseBuildInfoLine(line({ branch: "feat-x", origin: "release" })),
      isAncestorOfMain: false,
      version: "0.1.602",
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toContain("分支包");
  });

  test("promote：在 main 上 → 放行；祖先关系测不出来 → 放行但明说没验证", () => {
    expect(
      judgePromote({
        info: parseBuildInfoLine(line({ origin: "release" })),
        isAncestorOfMain: true,
        version: "0.1.602",
      }).ok,
    ).toBe(true);
    // null = 取不到 main 或那个 commit 不在本地。放行（发版机之外的环境是常态），
    // 但**必须留一句"没验证"** —— 否则一个没跑的检查会显示成绿灯。
    const r = judgePromote({
      info: parseBuildInfoLine(line({ origin: "release" })),
      isAncestorOfMain: null,
      version: "0.1.602",
    });
    expect(r.ok).toBe(true);
    expect(r.reasons.join(" ")).toContain("未验证");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6：评测报告里的身份字段
// ─────────────────────────────────────────────────────────────────────────────

describe("run-meta / 报告：artifact_commit 与 host_head_commit 分开（F3）", () => {
  const baseInput = {
    runId: "smoke-x",
    promptVersion: "prompt-v1",
    report: null,
    submitted: ["a__b-1"],
    patchBytesById: { "a__b-1": 100 },
    touchesTestsIds: [],
    goldOk: true,
    wallMs: 1000,
    expectedTotal: 1,
    model: "m",
    gatewayHost: "h",
    effortLevel: "max",
  };

  test("两者不一致时报告要标出来（合成一行是旧写法的 bug）", () => {
    // F3 的形态：`git_commit` 记的是宿主 HEAD，产物却是 5 天前编的，
    // 而**读报告的人会当它们相等**。
    // 变异自证：把 renderIdentityLines 改回只印一个 commit → 红
    const a = buildAcceptance({
      ...baseInput,
      artifactCommit: C_ART,
      artifactIdentitySource: "embedded",
      artifactOrigin: "local",
      artifactBranch: "fix/x",
      hostHeadCommit: C_HEAD,
      gitCommit: C_HEAD,
      artifactGateVerdict: "ok",
    });
    expect(a.artifact_commit).toBe(C_ART);
    expect(a.host_head_commit).toBe(C_HEAD);
    const md = renderIdentityLines(a).join("\n");
    expect(md).toContain(C_ART);
    expect(md).toContain(C_HEAD);
    expect(md).toContain("与产物 commit 不一致");
    // 事实源标记必须在产物那一行上，不在宿主那一行上
    expect(md.split("\n")[0]).toContain("事实源");
  });

  test("mtime-fallback 时报告正文必须出现「没量到」（不是显示一个绿灯）", () => {
    // 只在类型注释里写不够 —— 读报告的人看不到注释。
    // 变异自证：把 renderIdentityLines 的 noIdentity 分支删掉 → 红
    const a = buildAcceptance({
      ...baseInput,
      artifactIdentitySource: "mtime-fallback",
      hostHeadCommit: C_HEAD,
      gitCommit: C_HEAD,
    });
    const md = renderReport(a);
    expect(md).toContain("没量到");
    expect(a.unaccounted ?? "").toContain("mtime-fallback");
  });

  test("逃生舱被用过 → unaccounted 与报告都要点破", () => {
    // 逃生舱本身不是问题，**用了却不留痕**才是：一个用了
    // SWE_ALLOW_STALE_ARTIFACT 的 run 与正常 run 在分数上完全看不出区别。
    // 变异自证：把 gate_bypassed 那段渲染删掉 → 红
    const a = buildAcceptance({
      ...baseInput,
      artifactCommit: C_ART,
      artifactIdentitySource: "embedded",
      artifactGateVerdict: "stale",
      gateBypassed: ["stale"],
      hostHeadCommit: C_HEAD,
      gitCommit: C_HEAD,
    });
    expect(a.gate_bypassed).toEqual(["stale"]);
    expect(a.unaccounted ?? "").toContain("gate_bypassed");
    expect(a.unaccounted ?? "").toContain("测的不是当前代码");
    expect(renderReport(a)).toContain("门禁被绕过");
  });

  test("产物脏与宿主脏是两件事（旧写法把它们混成一件）", () => {
    // 一个从干净 commit 编出的好产物，不该因为宿主此刻有未提交改动
    // 而被打上"只可自比"的标签。
    // 变异自证：把 artifactDirty 判据换回 gitDirty → 第一条红
    const clean = buildAcceptance({
      ...baseInput,
      artifactCommit: C_ART,
      artifactIdentitySource: "embedded",
      artifactDirty: false,
      gitDirty: true,
      hostHeadCommit: C_HEAD,
      gitCommit: C_HEAD,
    });
    expect(clean.unaccounted ?? "").not.toContain("产物编自脏工作区");

    const dirtyArtifact = buildAcceptance({
      ...baseInput,
      artifactCommit: C_ART,
      artifactIdentitySource: "embedded",
      artifactDirty: true,
      gitDirty: false,
      hostHeadCommit: C_HEAD,
      gitCommit: C_HEAD,
    });
    expect(dirtyArtifact.unaccounted ?? "").toContain("产物编自脏工作区");
  });

  test("旧 run（只有 git_commit，没有 artifact_commit）→ 点破但不当成有身份", () => {
    // 兼容路径必须**明说自己是兼容路径**。写成"有 commit 就算记了"
    // 会让一个不知道跑了什么产物的旧 run 看起来和新 run 一样可靠。
    const a = buildAcceptance({ ...baseInput, gitCommit: C_HEAD });
    expect(a.artifact_commit).toBeNull();
    expect(a.unaccounted ?? "").toContain("artifact_commit");
    expect(a.unaccounted ?? "").toContain("宿主的 HEAD");
  });

  test("本轮新增的身份字段没有破「不许出现百分比」那条", () => {
    // 本仓的硬约束：n=10 时 SE=14.5pp，六成与七成统计上无法区分。
    // 新增字段时顺手加个 percent / rate 是很自然的手滑，所以这条在这里也守一次。
    //
    // ⚠️ 只扫**本轮新增的那几行**（renderIdentityLines），不扫整份 renderReport ——
    // 整份的口径由 swe-bench-runner.test.ts 那条门禁负责，且它在 report 存在时才成立
    // （report=null 那条 unaccounted 文案里本来就带着「那个假 0%」这个词）。
    // 两处各扫自己那部分，避免这条测试因为别处的既有文案而变红。
    const a = buildAcceptance({
      ...baseInput,
      artifactCommit: C_ART,
      artifactIdentitySource: "embedded",
      artifactDirty: true,
      gateBypassed: ["stale"],
      hostHeadCommit: C_HEAD,
    });
    for (const k of Object.keys(a)) {
      expect(k).not.toMatch(/percent|pct|rate|ratio/i);
    }
    expect(renderIdentityLines(a).join("\n")).not.toMatch(/\d+(\.\d+)?%/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 门禁接线（漏接的形态是"门禁在但没人调"）
// ─────────────────────────────────────────────────────────────────────────────

describe("接线哨兵：门禁必须真的被调用", () => {
  test("exec-swebench.sh 调 check_artifact_identity，且不再用 mtime 判据", () => {
    // 本仓有实测教训：一道防线「build 过 + 单测过」却从未被真实调用过 ——
    // 防线自己成了它当初要消灭的死功能。
    // 变异自证：把 cmd_run 里那行 check_artifact_identity 删掉 → 红
    const sh = readFileSync(
      join(ROOT, "evals/external-benchmarks/swe-bench/exec-swebench.sh"),
      "utf8",
    );
    const nonComment = sh
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(nonComment).toContain("artifact-identity.ts");

    // ⚠️ 只断言「文件里出现 check_artifact_identity」是**不够的** ——
    // 实测：把 cmd_run 里那行调用删掉，函数定义还在，那条断言照样绿。
    // 一个只认得出"定义存在"的接线哨兵，正是它自己要防的那种 false gate。
    // 所以判据必须是「**cmd_run 的函数体里**调了它」。
    //
    // 变异自证：把 cmd_run 里那行 `check_artifact_identity "$artifact" || exit 1`
    // 换成 `true` → 红（已实测：不做这个改法时上面那条旧断言不会红）
    const cmdRunStart = nonComment.indexOf("cmd_run() {");
    expect(cmdRunStart).toBeGreaterThan(0);
    const cmdRunBody = nonComment.slice(cmdRunStart, nonComment.indexOf("\n}", cmdRunStart) + 2);
    expect(cmdRunBody).toContain("check_artifact_identity");
    // 且必须是"失败即停"，不是记个日志继续跑
    expect(cmdRunBody).toMatch(/check_artifact_identity[^\n]*\|\|\s*exit 1/);
    // 旧的 mtime 判据函数必须彻底移除（留着会有人以为它还在生效）
    expect(nonComment).not.toContain("warn_if_stale_artifact");
    // 两个逃生舱都要接上，且**分开**接
    expect(nonComment).toContain("SWE_ALLOW_STALE_ARTIFACT");
    expect(nonComment).toContain("SWE_ALLOW_FOREIGN_ARTIFACT");
    // 逃生舱必须留痕
    expect(nonComment).toContain("GATE_BYPASSED");
  });

  test("release.sh 在**上传之前**跑 release-gate，promote 前跑 promote-gate", () => {
    // 放上传之后就只是"事后告知"，坏产物已经在服务器上了。
    // 变异自证：把 release-gate 那行挪到上传循环之后 → 红
    const sh = readFileSync(join(ROOT, "scripts/release.sh"), "utf8");
    const gatePos = sh.indexOf('artifact-identity.ts" release-gate');
    const uploadPos = sh.indexOf("上传 $(basename");
    expect(gatePos).toBeGreaterThan(0);
    expect(uploadPos).toBeGreaterThan(0);
    expect(gatePos).toBeLessThan(uploadPos);

    // promote 门禁必须在写 latest.txt **之前**
    const promotePos = sh.indexOf('artifact-identity.ts" promote-gate');
    const writeLatestPos = sh.indexOf('DEPLOY_PATH}/latest.txt" \\');
    expect(promotePos).toBeGreaterThan(0);
    expect(promotePos).toBeLessThan(writeLatestPos > 0 ? writeLatestPos : sh.length);
  });

  test("artifact_for 的四条查找路径 + ARTIFACT_SOURCE 真的能到父 shell（实机跑）", () => {
    // ## 这条测的是一个已实测踩到的 bug，不是假想
    //
    // 第一版写成「echo 路径 + 顺手设 ARTIFACT_SOURCE=...」。调用方是
    // `artifact="$(artifact_for "$arch")"` —— **命令替换起子 shell**，
    // 里面的赋值不会回到父 shell。于是 run-meta 里 `artifact_source` 恒为 `unknown`。
    //
    // ⚠️ 这个形态是本仓的老熟人（metric-exists-but-value-is-junk）：
    // 字段在、有值、看起来正常，但值是废的。而**只读源码的断言抓不到它** ——
    // `printf`/`echo` 两种写法在文本层看不出区别。所以这条必须真的跑 bash。
    //
    // 变异自证：把 artifact_for 里的 `printf 'X\t%s\n'` 改回
    // 「ARTIFACT_SOURCE=X; echo $path」→ source 变空 → 红
    const probe = `
set -uo pipefail
SH="${join(ROOT, "evals/external-benchmarks/swe-bench/exec-swebench.sh")}"
REPO_ROOT="${ROOT}"
bad() { :; }
eval "$(sed -n '/^artifact_source_of()/,/^}$/p' "$SH")"
eval "$(sed -n '/^artifact_path_of()/,/^}$/p' "$SH")"
eval "$(sed -n '/^artifact_for()/,/^}$/p' "$SH")"
pick="$(SWE_ARTIFACT=/tmp/explicit-pkg.tar.gz artifact_for amd64)"
echo "src=$(artifact_source_of "$pick") path=$(artifact_path_of "$pick")"
pick2="$(artifact_for amd64)"
echo "src2=$(artifact_source_of "$pick2")"
if SWE_BUILD_REF=definitely-no-such-ref artifact_for amd64 >/dev/null 2>&1; then
  echo "missing-ref=FELL-BACK"
else
  echo "missing-ref=REFUSED"
fi
`;
    const r = Bun.spawnSync({ cmd: ["bash", "-c", probe], stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString();

    // ① 显式指定：source 与 path 都要对（这一条就是那个 bug 的直接哨兵）
    expect(out).toContain("src=SWE_ARTIFACT");
    expect(out).toContain("path=/tmp/explicit-pkg.tar.gz");

    // ③/④ 默认路径：必须落在 branch-builds 或 dist/release 之一，**不能是空**。
    // 空就意味着 source 又回到了那条子 shell 赋值的老路。
    expect(out).toMatch(/src2=(branch-builds\/current-commit|dist\/release)/);

    // ② 点名了却找不到 → 拒绝，不静默回落。
    // 回落最坑：人以为跑的是他点名的那个包，而实际跑的是别的。
    expect(out).toContain("missing-ref=REFUSED");
  });

  test("preflight 的 ⑥ 真的进了 runPreflight 的编排", () => {
    // 变异自证：从 runPreflight 的返回数组里删掉 check6ArtifactIdentity → 红
    const src = readFileSync(
      join(ROOT, "evals/external-benchmarks/swe-bench/preflight.ts"),
      "utf8",
    );
    const orchestration = src.slice(src.indexOf("export function runPreflight"));
    expect(orchestration).toContain("check6ArtifactIdentity");
  });

  test("CLI：「文件不存在」与「文件在但没身份」是两个出口，不许合成一个", () => {
    // ## 这条是验收时实测踩到的
    //
    // 敲了一个不存在的 tarball 名，`read` 返回 `identity_source: none` + **exit 0** ——
    // 与"老产物没有身份"的输出**一模一样**。于是排查方向被带到"为什么 define 没编进去"，
    // 而真相是路径打错了。`gate` 早就有这道判断（exit 66），`read` 漏了。
    //
    // 这正是本方案反复强调的那件事的一个实例（`metric-exists-but-value-is-junk`）：
    // 字段在、有值、看起来正常，但值是废的 —— 而这次是**成因**被抹掉了。
    //
    // 变异自证：删掉 read 分支里的 existsSync 判断 → exit 变 0、文案消失 → 红
    const cli = join(ROOT, "scripts/artifact-identity.ts");
    const missing = join(tmpdir(), "definitely-no-such-artifact-xyz.tar.gz");
    for (const sub of ["read", "gate"]) {
      const p = Bun.spawnSync({
        cmd: ["bun", "run", cli, sub, missing],
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = p.stdout.toString() + p.stderr.toString();
      expect(p.exitCode).toBe(66); // 两个子命令同一个出口码
      expect(out).toContain("产物不存在");
      // 且**不能**顺手输出一份 unknown 身份 —— 那份 JSON 会被下游当成"读到了"
      expect(out).not.toContain('"identity_source": "none"');
    }
  });

  test("build-branch-artifact.sh 带齐两个 define + baseline target + 自证", () => {
    // 这个脚本存在的全部理由就是「手抄那条长命令会漏东西」，
    // 所以它自己漏了就更糟 —— 那是把三种静默失败包装成一个"官方"入口。
    // 变异自证：删掉任一个 --define → 对应那条红
    const sh = readFileSync(join(ROOT, "scripts/build-branch-artifact.sh"), "utf8");
    expect(sh).toContain("process.env.NODE_ENV");
    expect(sh).toContain("process.env.SID_CODE_BUILD_INFO");
    expect(sh).toContain("bun-linux-x64-baseline");
    // 三个生成脚本
    expect(sh).toContain("embed-builtin-skills");
    expect(sh).toContain("fetch-ripgrep");
    expect(sh).toContain("gen-model-catalog-snapshot");
    // 自证：编完必须能读回身份，否则漏带 define 时构建照样 exit 0
    expect(sh).toContain("identity_source");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.4 清理：dist/branch-builds 会长（一个包 143MB）
// ─────────────────────────────────────────────────────────────────────────────

describe("prune-branch-builds：默认 dry-run，判据不看 mtime", () => {
  const SCRIPT = join(ROOT, "scripts/prune-branch-builds.sh");

  /**
   * 造一个合成的 branch-builds 目录，对着**真脚本**跑。
   *
   * ⚠️ 刻意不在测试里重写一遍判据：重写的那份和跑的那份会各自漂移，
   * 而漂移的形态是「测试全绿、真脚本删错东西」。所以走 `BRANCH_BUILDS_DIR`
   * 注入点，被测的就是用户真正会跑的那些行。
   */
  function synth(): { dir: string; head12: string; oldCommits: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "prune-bb-"));
    const git = (args: string[]) =>
      Bun.spawnSync({ cmd: ["git", "-C", ROOT, ...args], stdout: "pipe", stderr: "ignore" })
        .stdout.toString()
        .trim();
    const head12 = git(["rev-parse", "HEAD"]).slice(0, 12);
    // 取一批真实历史 commit（不是 HEAD，所以不受 protected 保护）
    const oldCommits = git(["log", "--format=%H", "-n", "40"])
      .split("\n")
      .map((s) => s.trim().slice(0, 12))
      .filter((s) => s.length === 12 && s !== head12)
      .slice(0, 6);
    const mk = (name: string) => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "sid-code"), "x");
    };
    mk(`cur-${head12}`); // → protected（当前 HEAD）
    oldCommits.forEach((c, i) => mk(`old-branch-${i}-${c}`));
    mk("garbage-name"); // → unknown（解不出 commit12）
    mk("foreign-deadbeef1234"); // → unknown（12 位十六进制但不在对象库）
    return { dir, head12, oldCommits };
  }

  function run(dir: string, args: string[]) {
    const p = Bun.spawnSync({
      cmd: ["bash", SCRIPT, ...args],
      cwd: ROOT,
      env: { ...process.env, BRANCH_BUILDS_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: p.exitCode,
      out: p.stdout.toString() + p.stderr.toString(),
      left: require("node:fs").readdirSync(dir).sort() as string[],
    };
  }

  test("不加 --apply 时一个目录都不删（默认 dry-run）", () => {
    // 这是整个脚本最要紧的一条：本仓 §0 铁律（多任务并行，dist/ 里可能有别人在用的包）。
    // 变异自证：把 APPLY 的默认值改成 true → 红
    const { dir } = synth();
    try {
      const before = require("node:fs").readdirSync(dir).length;
      const r = run(dir, ["--keep", "1"]);
      expect(r.code).toBe(0);
      expect(r.left.length).toBe(before);
      // 而且必须明说「什么都没删」+ 给出下一步命令，否则人会以为它删过了
      expect(r.out).toContain("dry-run");
      expect(r.out).toContain("--apply");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("三档全部打印出来，不只打要删的那几个", () => {
    // 只打 prune 的话，人无法核对「该保的有没有被误判成 prune」——
    // 而误删一个目录是不可逆的。
    // 变异自证：把 show protected / show unknown 那两行删掉 → 红
    const { dir } = synth();
    try {
      const r = run(dir, ["--keep", "2"]);
      expect(r.out).toContain("protected");
      expect(r.out).toContain("keep");
      expect(r.out).toContain("unknown");
      expect(r.out).toContain("prune");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--apply 删掉窗口外的，但 protected / unknown 一个不动", () => {
    // 变异自证之一：让 unknown 也进 PRUNES → 剩余目录里没有 garbage-name → 红
    // 变异自证之二：去掉 is_protected 那道判断 → cur-<HEAD> 被删 → 红
    const { dir, head12 } = synth();
    try {
      const r = run(dir, ["--apply", "--keep", "2"]);
      expect(r.code).toBe(0);
      // 当前 HEAD 的包：永不删
      expect(r.left).toContain(`cur-${head12}`);
      // 判不出来的两个：保留并点破（"留着一个多余目录的代价是几十 MB"）
      expect(r.left).toContain("garbage-name");
      expect(r.left).toContain("foreign-deadbeef1234");
      // 真的删掉了东西 —— 否则这条测试等价于上面那条 dry-run
      expect(r.out).toContain("已删除");
      expect(r.left.filter((n) => n.startsWith("old-branch-")).length).toBeLessThan(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mtime 完全不参与判据（把 mtime 排成与 commit 时间相反也不改结果）", () => {
    // 这是与上一版 mtime 判据的**唯一可观测差异**，也是整个构建溯源方案的起因：
    // `cp` 会把 mtime 重置成"现在"，所以 mtime 既不描述"多老"也不描述"还有没有用"。
    //
    // ⚠️ 构造方式很关键：**把 mtime 排成与 commit 时间恰好相反**，不是"全打成同一个旧时间"。
    // 全打成同一个值时 `sort -rn` 的键全部相等、结果由不稳定排序决定，
    // 于是"换成 mtime 排序"这个变异**可能照样过** —— 实测过这个假绿。
    // 反序才能让两种判据给出确定不同的答案。
    //
    // 变异自证：把排序键换成 `stat -f %m`（文件 mtime）→ 红（已实测）
    const { dir } = synth();
    try {
      const kept = (out: string) =>
        out
          .split("\n")
          .filter((l) => l.includes("keep "))
          .map((l) => l.match(/old-branch-\d+-[0-9a-f]{12}/)?.[0])
          .filter(Boolean)
          .sort();

      const keptBefore = kept(run(dir, ["--keep", "2"]).out);
      expect(keptBefore.length).toBe(2); // 断言本身要有内容可比

      // synth() 里 old-branch-0 是最新的 commit、序号越大越旧。
      // 把 mtime 反着打：序号越大 mtime 越新。
      const olds = (require("node:fs").readdirSync(dir) as string[])
        .filter((n) => n.startsWith("old-branch-"))
        .sort();
      olds.forEach((n, i) => {
        const stamp = `2020010100${String(10 + i).padStart(2, "0")}`;
        Bun.spawnSync({ cmd: ["touch", "-t", stamp, join(dir, n)] });
      });

      const keptAfter = kept(run(dir, ["--keep", "2"]).out);
      expect(keptAfter).toEqual(keptBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--keep 收非数字时**在动手之前**就拒绝，且报清楚而不是抛 shell 错", () => {
    // ## 这条断言的第一版是个 false gate，记下来免得有人"简化"回去
    //
    // 第一版断言的是「退出码非 0 且目录还在」。实测：把校验整段删掉，
    // 这两条**照样成立** —— `[ "$i" -le abc ]` 在 `set -e` 下当场把脚本打死，
    // 也没删东西。于是那条测试测的是 bash 的行为，不是我加的校验。
    // （本仓同型教训：`s2-cooldown-clear-test-is-false-gate` —— 删掉被测函数仍恒绿。）
    //
    // 校验真正买到的是**失败的形态**：一条人能看懂的话，且发生在分档/删除**之前**。
    // 而不带校验时它死在循环中段（第 135 行），并吐 `[: abc: 需要整数` ——
    // 那种错误如果哪天出现在几次 `rm -rf` 之后，人根本无法判断删到哪一步了。
    //
    // 变异自证：删掉那段 `case "$KEEP" in` 校验 → 友好文案消失 + 冒出 shell 报错 → 红（已实测）
    const { dir } = synth();
    try {
      const r = run(dir, ["--apply", "--keep", "abc"]);
      expect(r.code).not.toBe(0);
      expect(r.left.length).toBeGreaterThan(0);
      expect(r.out).toContain("--keep 必须是非负整数");
      // 不许把裸 shell 错误当报错用
      expect(r.out).not.toContain("需要整数\n");
      expect(r.out).not.toMatch(/第 \d+ 行/);
      // 且必须早于任何分档输出（那行标题是分档开始的标志）
      expect(r.out).not.toContain("清理计划");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
