/**
 * 构建身份 define 防漂移哨兵（T7）+ 格式约束（T4/T15）
 *
 * 与 `tests/build/node-env-define.test.ts` **完全同形态**，理由也一字不差：
 * 修复只是在每个构建命令里加一个 flag，**新增构建入口时极易漏带**，
 * 漏了就静默退回「产物没有身份」。而下游门禁读不到身份时会退化到 mtime 兜底 ——
 * 形态是「门禁看起来在跑、实际全在走兜底路径」，构建成功、单测全绿、没有任何一处报错。
 * 这类沉默的回归必须靠门禁挡，不能靠人记。
 *
 * ⚠️ 本文件里的每条断言都配了「变异自证」注释：把实现改成那样时它必须变红。
 * 写测试时先真的改一遍跑过（本仓约定，见 CLAUDE.md）——
 * 一条永远绿的门禁不含任何信息。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILD_INFO_PREFIX,
  BUILD_INFO_NONE_PREFIX,
  BUILD_INFO_VALUE_CLASS,
  BUILD_INFO_SNIFF_REGEX,
  parseBuildInfoLine,
  isUsableCommit,
} from "@sid-code/shared/build-info.ts";

const ROOT = join(import.meta.dir, "..", "..");

/** 期望出现在每个 --compile 命令里的 define（容忍引号/变量引用形态差异，按语义匹配）。 */
const DEFINE_PATTERN = /--define\s+process\.env\.SID_CODE_BUILD_INFO=/;

describe("构建身份 define（T7 哨兵）", () => {
  test("Makefile 的 build 目标带 SID_CODE_BUILD_INFO define", () => {
    const mk = readFileSync(join(ROOT, "Makefile"), "utf8");

    const compileLines = mk
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .filter((l) => l.includes("build --compile"));
    expect(compileLines.length).toBeGreaterThan(0);

    // BUILD_DEFINES 变量本身必须带这个 define
    const defineVar = mk.match(/^BUILD_DEFINES\s*=\s*(.+)$/m);
    expect(defineVar).not.toBeNull();
    // 变异自证：把 BUILD_DEFINES 里的 SID_CODE_BUILD_INFO 那段删掉 → 红
    expect(DEFINE_PATTERN.test(defineVar![1])).toBe(true);

    // 每条 --compile 行要么直接写 define，要么引用 $(BUILD_DEFINES)
    for (const line of compileLines) {
      expect(DEFINE_PATTERN.test(line) || line.includes("$(BUILD_DEFINES)")).toBe(true);
    }

    // 身份行必须**立即展开**（`:=`）。用递归展开 `=` 时每次引用都重跑一遍脚本，
    // 同一次构建里 built_at 会取到不同的值。
    // 变异自证：把 `BUILD_INFO_LINE:=` 改成 `BUILD_INFO_LINE=` → 红
    expect(mk).toMatch(/^BUILD_INFO_LINE\s*:=/m);
  });

  test("release.sh 的多平台构建带 SID_CODE_BUILD_INFO define，且 origin=release", () => {
    const sh = readFileSync(join(ROOT, "scripts", "release.sh"), "utf8");

    expect(sh).toContain("build --compile");
    // 变异自证：从 release.sh 的构建循环里删掉那个 define → 红
    expect(DEFINE_PATTERN.test(sh)).toBe(true);

    // origin 必须是 release —— 它是发布通道门禁（PR-C）唯一能用来拦
    // 「手工编的包被塞进 dist/release/ 再上传」的判据。
    // 变异自证：改成 build-info-line.sh local → 红
    expect(sh).toMatch(/build-info-line\.sh["']?\s+release/);

    // 身份必须在**循环外**取一次数：否则 4 个平台产物的 built_at 各不相同，
    // 「这几个包是同一次发布的吗」就退化成人肉比时间戳。
    // 变异自证：把 BUILD_INFO_LINE= 那行挪进 for 循环体 → 红
    const linePos = sh.indexOf('BUILD_INFO_LINE="$(');
    const loopPos = sh.indexOf('for entry in "${TARGETS[@]}"');
    expect(linePos).toBeGreaterThan(0);
    expect(loopPos).toBeGreaterThan(0);
    expect(linePos).toBeLessThan(loopPos);
  });

  test("scripts/build-branch-artifact.sh（第三个构建入口）带齐两个 define", () => {
    // ## 为什么这个入口在这里单独守一次
    //
    // 它存在的**全部理由**就是「手抄那条长命令会漏东西」—— 实测漏过三种，全是静默的：
    // 漏 baseline target（qemu 里 SIGILL，core dump 被 git add 收进 patch）、
    // 漏 fetch-ripgrep（产物不含内嵌 rg）、漏这个 define（产物没有身份）。
    // 所以它自己漏了就更糟：那是把三种静默失败包装成一个"官方"入口。
    //
    // 变异自证：删掉任一个 --define → 对应那条红
    const sh = readFileSync(join(ROOT, "scripts", "build-branch-artifact.sh"), "utf8");
    const nonComment = sh.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    const body = nonComment.join("\n");

    // 每条真的 --compile 命令都要带两个 define
    const compileLines = nonComment.filter((l) => l.includes("bun build --compile"));
    expect(compileLines.length).toBeGreaterThan(0);
    expect(body).toContain("process.env.SID_CODE_BUILD_INFO");
    expect(body).toContain("process.env.NODE_ENV");

    // 身份行必须真的从那个脚本取（不是内联一段 shell —— 内联三份等于给
    // slug 化那个坑留三个入口，见 build-info-line.sh 文件头）
    expect(body).toMatch(/build-info-line\.sh["']?\s+local/);

    // 自证：编完必须读回身份才算交付。漏带 define 时**构建照样 exit 0**，
    // 没有这一步的话要等几天后门禁把产物读成"没有身份"才会发现。
    // 变异自证：把 identity_source 那段 case 检查删掉 → 红
    expect(body).toContain("identity_source");
  });

  test("exec-swebench.sh 不再打印给人抄的裸构建命令（改为指向脚本）", () => {
    // 上一轮这里守的是「提示语里那条可抄的长命令也要带 define」。
    // 现在那条提示语被换成了「bash scripts/build-branch-artifact.sh」——
    // **不留可抄的裸命令**比「守住每条可抄命令都带 define」更强：
    // 前者从根上消灭了漏带的可能，后者只是让漏带变红。
    //
    // 变异自证：往 exec-swebench.sh 的提示语里塞回一条裸 `bun build --compile
    // --outfile ...` → 红（逼人改成指向脚本，而不是再抄一遍参数）
    const sh = readFileSync(
      join(ROOT, "evals", "external-benchmarks", "swe-bench", "exec-swebench.sh"),
      "utf8",
    );
    const nonComment = sh.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    const copyable = nonComment.filter(
      (l) => l.includes("bun build --compile") || l.includes("--outfile"),
    );
    expect(copyable).toEqual([]);
    // 且必须真的指向那个脚本，否则这条断言用「把提示语整段删掉」也能满足
    expect(nonComment.join("\n")).toContain("scripts/build-branch-artifact.sh");
  });

  test("build-info-line.sh 的 origin 是闭集，越界必须拒绝而不是静默接受", async () => {
    // 变异自证：把 case 里的 `*)` 分支删掉 → origin=bogus 被静默编进产物 → 红
    const proc = Bun.spawnSync({
      cmd: ["bash", join(ROOT, "scripts", "build-info-line.sh"), "bogus"],
      cwd: ROOT,
    });
    expect(proc.exitCode).not.toBe(0);
  });

  test("build-info-line.sh 输出的每一行都能被嗅探正则完整取回（含 @ 与 / 的实机取数）", () => {
    for (const origin of ["local", "ci", "release"] as const) {
      const proc = Bun.spawnSync({
        cmd: ["bash", join(ROOT, "scripts", "build-info-line.sh"), origin],
        cwd: ROOT,
      });
      expect(proc.exitCode).toBe(0);
      const line = new TextDecoder().decode(proc.stdout);

      const matched = line.match(BUILD_INFO_SNIFF_REGEX);
      expect(matched).not.toBeNull();
      // 关键：取回的必须是**整行**，不是被截断的一截。
      // 变异自证：从 BUILD_INFO_VALUE_CLASS 里删掉 `@` → builder 含 email 时
      // 这里取回的比整行短 → 红（这正是 T15）
      expect(matched![0]).toBe(line);

      const info = parseBuildInfoLine(line);
      expect(info.identity_source).toBe("embedded");
      expect(info.origin).toBe(origin);
      // commit 必须是可用作判据的 40 位 hex（在 git 仓库里跑，理应总能取到）
      expect(isUsableCommit(info.commit)).toBe(true);
    }
  });
});

describe("构建身份格式约束（T4/T15）", () => {
  test("默认值前缀与真值前缀必须不同（T4：否则嗅探会读到 unknown）", () => {
    // 这是整套设计里最容易被「顺手统一一下前缀常量」破坏的一处，
    // 而破坏之后门禁看起来还在跑：它会把每个产物都读成 commit=unknown，
    // 然后一律退化到 mtime 兜底。
    //
    // 变异自证：把 BUILD_INFO_NONE_PREFIX 改成与 BUILD_INFO_PREFIX 相同 → 红
    expect(BUILD_INFO_NONE_PREFIX).not.toBe(BUILD_INFO_PREFIX);
    // 更强的约束：默认值前缀**不能以真值前缀开头**，否则 startsWith 判定会误命中
    expect(BUILD_INFO_NONE_PREFIX.startsWith(BUILD_INFO_PREFIX)).toBe(false);
    // 反向也要：嗅探正则不能匹配到默认值那一行
    expect(BUILD_INFO_SNIFF_REGEX.test(BUILD_INFO_NONE_PREFIX + "commit=unknown")).toBe(false);
  });

  test("值域字符类含 @ / . _ + 这几个实际会出现的字符（T15）", () => {
    // 每一个都有具体来源，删任何一个都会从截断点往后丢字段：
    //   @ → builder（email 或 user@host）⚠️ 实测漏了它 builder=a@b.com 被截成 builder=a
    //   / → 分支名 fix/xxx
    //   . → 版本号、email 域名
    //   - → describe（v0.1.601-59-g454cf79c）
    //   + → dirty_files 的分隔符、email 的 plus-addressing
    // 变异自证：从 BUILD_INFO_VALUE_CLASS 删掉任一字符 → 对应那条红
    for (const ch of ["@", "/", ".", "_", "+", "-", "="]) {
      expect(BUILD_INFO_VALUE_CLASS).toContain(ch);
    }
  });

  test("截断的身份行不会被当成有效身份（commit 形态校验）", () => {
    // 门禁在拿 commit 拼 git 命令前必须先过 isUsableCommit —— 它来自产物字节，
    // 可能被截断、可能是任意内容。不校验的话一个含 `;` 或 `$(...)` 的畸形值
    // 会被 shell 展开（评测脚本是 bash，注入面是真实的）。
    expect(isUsableCommit("abc;echo pwned")).toBe(false);
    expect(isUsableCommit("454cf79c")).toBe(false); // short 不够
    expect(isUsableCommit("454cf79c90c5b83655effdcd032cb3630364c9a6")).toBe(true);
    expect(isUsableCommit("454CF79C90C5B83655EFFDCD032CB3630364C9A6")).toBe(false); // 大写不收
    expect(isUsableCommit("unknown")).toBe(false);
  });

  test("无身份的产物解析出 identity_source=none，且不编造 commit（T12 的基础）", () => {
    // 本仓有实测教训（metric-exists-but-value-is-junk）：字段在、有值、看起来正常，
    // 但值是废的。消费方必须能看出「这是没量到」而不是「这是没变」。
    // 变异自证：让 parseBuildInfoLine 在读不到时回填一个真 commit → 红
    const info = parseBuildInfoLine(
      BUILD_INFO_NONE_PREFIX + "commit=unknown|branch=unknown|origin=source",
    );
    expect(info.identity_source).toBe("none");
    expect(info.commit).toBe("unknown");
    expect(info.schema).toBe(0);
    expect(info.origin).toBe("source");
    // origin=source（源码直跑）与 origin=local（编了个包但不是发布流程编的）
    // 必须分开：前者是开发常态不该被拦，后者在发布通道里该拦。
    expect(info.origin).not.toBe("local");
  });

  test("未知 key 忽略、缺失 key 落 unknown（格式演进时老代码读新产物不崩）", () => {
    const info = parseBuildInfoLine(
      BUILD_INFO_PREFIX +
        "commit=454cf79c90c5b83655effdcd032cb3630364c9a6|future_field=whatever|branch=main",
    );
    expect(info.commit).toBe("454cf79c90c5b83655effdcd032cb3630364c9a6");
    expect(info.branch).toBe("main");
    expect(info.describe).toBe("unknown");
    expect(info.dirty).toBe("unknown"); // 三态：读不到 ≠ false
    expect(info.identity_source).toBe("embedded");
  });

  test("dirty 是三态：读不到时不能塌成 false", () => {
    // 塌成 false 的后果是发布通道门禁把「不知道脏不脏」当成「干净」放过去。
    expect(parseBuildInfoLine(BUILD_INFO_PREFIX + "commit=x|dirty=true").dirty).toBe(true);
    expect(parseBuildInfoLine(BUILD_INFO_PREFIX + "commit=x|dirty=false").dirty).toBe(false);
    expect(parseBuildInfoLine(BUILD_INFO_PREFIX + "commit=x").dirty).toBe("unknown");
  });
});
