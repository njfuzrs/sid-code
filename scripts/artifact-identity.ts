#!/usr/bin/env bun
/**
 * 产物身份 CLI —— 给 bash 侧（`exec-swebench.sh` G1 / `release.sh` G2）用的桥。
 *
 * ## 为什么是一个 CLI 而不是三段 bash
 *
 * 判定逻辑必须只有一份（见 `scripts/lib/artifact-identity.ts` 文件头）。
 * 三份 bash 的后果不是"重复"这么轻 —— 而是三份各自漂移，
 * 且**漂移的形态是「门禁看起来在跑、实际全在放行」**。
 *
 * 用法：
 *   bun run scripts/artifact-identity.ts read   <artifact>          只读身份，输出 JSON
 *   bun run scripts/artifact-identity.ts gate   <artifact>          G1 判定（人读 + JSON 双份）
 *   bun run scripts/artifact-identity.ts release-gate <dir> <ver>   G2 上传前
 *   bun run scripts/artifact-identity.ts promote-gate <artifact> <ver>  G2 promote 前
 *
 * ⚠️ `gate` 的退出码是**跨语言契约**（见 lib 里的 EXIT_CODE 表），bash 按数字分流：
 *   0 放行（含"读不到身份，已退化到 mtime 兜底"—— 那不是通过，是没量到）
 *   2 stale   3 foreign   4 unknown-commit   5 sidecar-mismatch
 * 改这张表要同步改 exec-swebench.sh 的 case 分支。
 *
 * ⚠️ `gate` 的 JSON 走 **stdout**、人读文本走 **stderr**。
 * 混在一起的话 bash 侧 `$(...)` 取到的 JSON 里会掺进给人看的中文 —— 而
 * `python -c json.load` 报的错完全看不出成因是这个。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import {
  assessArtifact,
  artifactMtimeSec,
  judgePromote,
  judgeReleaseUpload,
  makeCmdRunner,
  makeGitProbe,
  sniffArtifactIdentity,
  verifySidecar,
  EXIT_CODE,
} from "./lib/artifact-identity.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

function usage(): never {
  console.error(
    [
      "用法：",
      "  artifact-identity.ts read <artifact>",
      "  artifact-identity.ts gate <artifact>",
      "  artifact-identity.ts release-gate <version-dir> <version>",
      "  artifact-identity.ts promote-gate <artifact> <version>",
    ].join("\n"),
  );
  process.exit(64);
}

function main(argv: string[]): number {
  const [sub, ...rest] = argv;
  if (!sub) usage();
  const runner = makeCmdRunner();

  if (sub === "read") {
    const artifact = rest[0];
    if (!artifact) usage();
    // ⚠️ 「文件不存在」必须与「文件在但没有身份」分开。
    // 不判这一条时，路径打错会得到 identity_source=none + exit 0 —— 和"老产物"
    // 一模一样，于是排查的人会去查"为什么没编进去"，而真相是路径错了。
    // （实测踩到过：验收时敲了一个不存在的 tarball 名，输出的 unknown 完全看不出成因。）
    // `gate` 早就有这道判断（exit 66），`read` 漏了 —— 两个子命令的语义要一致。
    if (!existsSync(artifact)) {
      console.error(`产物不存在: ${artifact}`);
      return 66;
    }
    const { line, info } = sniffArtifactIdentity(artifact, runner);
    console.log(JSON.stringify({ ...info, raw_line: line }, null, 2));
    return 0;
  }

  if (sub === "gate") {
    const artifact = rest[0];
    if (!artifact) usage();
    if (!existsSync(artifact)) {
      console.error(`产物不存在: ${artifact}`);
      return 66;
    }
    const { info } = sniffArtifactIdentity(artifact, runner);
    const probe = makeGitProbe(REPO_ROOT, runner);
    const a = assessArtifact({
      artifactPath: artifact,
      info,
      probe,
      artifactMtimeSec: artifactMtimeSec(artifact),
      sidecar: verifySidecar(artifact, info),
    });

    // 人读 → stderr（见文件头：与 JSON 分流）
    const icon = a.verdict === "ok" ? "✅" : a.verdict.startsWith("no-identity") ? "⚠️" : "❌";
    console.error(`  ${icon} 产物身份门禁（G1）：${a.verdict}  [${basename(artifact)}]`);
    if (a.identitySource === "embedded") {
      console.error(
        `     产物 commit ${a.info.commit.slice(0, 12)} (${a.info.branch}, ${a.info.describe})` +
          ` origin=${a.info.origin} built_at=${a.info.built_at}`,
      );
      console.error(
        `     宿主 HEAD    ${(a.hostHeadCommit ?? "unknown").slice(0, 12)}` +
          (a.commitMatchesHost === true
            ? " —— 一致"
            : a.commitMatchesHost === false
              ? " —— **不一致**（不一定是问题，见下）"
              : ""),
      );
    }
    for (const r of a.reasons) console.error(`     ${r}`);
    for (const w of a.warnings) console.error(`     ⚠️ ${w}`);

    // 机器读 → stdout
    console.log(
      JSON.stringify({
        verdict: a.verdict,
        identity_source: a.identitySource,
        artifact_commit: a.info.commit,
        artifact_branch: a.info.branch,
        artifact_describe: a.info.describe,
        artifact_dirty: a.info.dirty,
        artifact_built_at: a.info.built_at,
        artifact_builder: a.info.builder,
        artifact_origin: a.info.origin,
        host_head_commit: a.hostHeadCommit,
        host_dirty: a.hostDirty,
        commit_matches_host: a.commitMatchesHost,
        changed_input_commits: a.changedInputCommits.length,
      }),
    );
    return EXIT_CODE[a.verdict];
  }

  if (sub === "release-gate") {
    const [dir, version] = rest;
    if (!dir || !version) usage();
    if (!existsSync(dir)) {
      console.error(`版本目录不存在: ${dir}`);
      return 66;
    }
    const probe = makeGitProbe(REPO_ROOT, runner);
    // 构建发生在 bump **之后**、bump 提交创建**之前**，所以构建时的 HEAD 就是
    // 「tag 所指提交的父提交」。写成 tag 本身会 100% 误拦每次真实发版（见 lib 里那张表）。
    const expected = probe.revParse(`v${version}^`);
    if (expected === null) {
      console.error(`  ⚠️ 取不到 v${version}^ —— commit 一致性这一条无法校验（tag 还没打？）`);
    }

    const tarballs = readdirSync(dir).filter((f) => f.endsWith(".tar.gz"));
    if (tarballs.length === 0) {
      console.error(`  ❌ ${dir} 下没有 tar.gz 产物`);
      return 2;
    }
    let bad = 0;
    for (const name of tarballs.sort()) {
      const { info } = sniffArtifactIdentity(join(dir, name), runner);
      const r = judgeReleaseUpload({ info, expectedCommit: expected, artifactName: name });
      if (r.ok) {
        console.error(
          `  ✅ ${name}: origin=${info.origin} commit=${info.commit.slice(0, 12)}` +
            (r.reasons.length ? `（提示：${r.reasons.length} 条）` : ""),
        );
      } else {
        bad++;
        console.error(`  ❌ ${name}`);
      }
      for (const reason of r.reasons) console.error(`     ${reason}`);
    }
    if (bad > 0) {
      console.error(`  ⛔ ${bad}/${tarballs.length} 个产物未通过发布通道门禁（G2），拒绝上传。`);
      return 2;
    }
    console.error(`  ✅ 发布通道门禁通过（${tarballs.length} 个产物，origin=release）`);
    return 0;
  }

  if (sub === "promote-gate") {
    const [artifact, version] = rest;
    if (!artifact || !version) usage();
    if (!existsSync(artifact)) {
      console.error(`产物不存在: ${artifact}`);
      return 66;
    }
    const { info } = sniffArtifactIdentity(artifact, runner);
    const probe = makeGitProbe(REPO_ROOT, runner);
    // main 可能只在远端（发版机上通常两者都有）。两个都试，都取不到就传 null 并点破。
    const mainRef = probe.revParse("main") !== null ? "main" : "origin/main";
    const isAncestor =
      info.identity_source === "embedded" && probe.commitExists(info.commit)
        ? probe.revParse(mainRef) !== null
          ? probe.isAncestor(info.commit, mainRef)
          : null
        : null;
    const r = judgePromote({ info, isAncestorOfMain: isAncestor, version });
    for (const reason of r.reasons) console.error(`     ${reason}`);
    if (!r.ok) {
      console.error(`  ⛔ promote 门禁未通过（v${version}）`);
      return 2;
    }
    console.error(
      `  ✅ promote 门禁通过：v${version} 的产物 commit ` +
        `${info.commit.slice(0, 12)} 在 ${mainRef} 上`,
    );
    return 0;
  }

  usage();
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

export { main, readFileSync };
