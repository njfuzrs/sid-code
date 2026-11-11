/**
 * N6 A 档：前台 `sleep N` 阻塞等待的形态识别与引导文案。
 *
 * 判据对齐 Claude Code 的 `detectBlockedSleepPattern`（方案 §N6 的「对照」一节）：
 * 只认第一段是 `sleep N`（整数、N ≥ 2），管道 / 子 shell / 脚本里的 sleep 不命中。
 * 这里钉住的是「哪些形态会追加引导」——追加条件（有声明的等待 / N ≥ 30）在
 * `bash-foreground-sleep.test.ts` 里通过真实工具入口验。
 */

import { describe, it, expect } from "bun:test";
import {
  buildForegroundSleepNotice,
  detectForegroundSleep,
  FOREGROUND_SLEEP_LONG_SECONDS,
  FOREGROUND_SLEEP_MIN_SECONDS,
} from "../../../src/tool/bash/foreground-sleep.ts";

describe("detectForegroundSleep 命中的形态", () => {
  it("fbb02831 的真实写法：sleep N && gh pr view", () => {
    const matched = detectForegroundSleep("sleep 150 && gh pr view 697 --json statusCheckRollup");
    expect(matched?.seconds).toBe(150);
    // rest 保留后续命令，供未来 B 档（拒绝执行）的回执引用
    expect(matched?.rest).toBe("gh pr view 697 --json statusCheckRollup");
  });

  it("带工作目录前缀的真实写法（fbb02831 的 7 次里多数带 cd）", () => {
    expect(
      detectForegroundSleep(
        "cd /Users/zhourusheng/Code/person/sid-code/.sid-code/worktrees/x && sleep 60 && gh pr checks 1",
      )?.seconds,
    ).toBe(60);
  });

  it("环境变量前缀同样剥掉", () => {
    expect(detectForegroundSleep("CI=1 sleep 45 && gh pr view 2")?.seconds).toBe(45);
  });

  it("分号分隔与多行分隔", () => {
    expect(detectForegroundSleep("sleep 30; gh pr checks 1")?.seconds).toBe(30);
    expect(detectForegroundSleep("sleep 30\ngh pr checks 1")?.seconds).toBe(30);
  });

  it("纯 sleep（后面没有命令）也算阻塞等待", () => {
    const matched = detectForegroundSleep("sleep 240");
    expect(matched?.seconds).toBe(240);
    expect(matched?.rest).toBe("");
  });

  it("阈值边界：恰好 2 秒命中（MIN 是闭区间）", () => {
    expect(detectForegroundSleep(`sleep ${FOREGROUND_SLEEP_MIN_SECONDS}`)?.seconds).toBe(
      FOREGROUND_SLEEP_MIN_SECONDS,
    );
  });
});

describe("detectForegroundSleep 不命中的形态", () => {
  it("1 秒与浮点秒是正常节奏，不拦", () => {
    expect(detectForegroundSleep("sleep 1 && curl localhost:3000/health")).toBeUndefined();
    expect(detectForegroundSleep("sleep 0.5 && curl localhost:3000/health")).toBeUndefined();
  });

  it("管道里的 sleep 是流式用法，不是阻塞等待", () => {
    expect(detectForegroundSleep("sleep 30 | cat")).toBeUndefined();
  });

  it("子 shell / 包装命令里的 sleep：第一段不是 sleep", () => {
    expect(detectForegroundSleep("(sleep 30; gh pr view 1)")).toBeUndefined();
    expect(detectForegroundSleep("timeout 60 sleep 30")).toBeUndefined();
  });

  it("sleep 只出现在参数里（不是执行的命令）", () => {
    expect(detectForegroundSleep("echo sleep 30")).toBeUndefined();
    expect(detectForegroundSleep("gh pr view 1 --jq '.title // \"sleep 30\"'")).toBeUndefined();
  });

  it("普通命令不命中", () => {
    expect(detectForegroundSleep("gh pr checks 701")).toBeUndefined();
    expect(detectForegroundSleep("")).toBeUndefined();
  });
});

describe("buildForegroundSleepNotice", () => {
  it("有声明的等待：点破「它在推迟你自己挂的那个等待」", () => {
    const text = buildForegroundSleepNotice({ seconds: 150, rest: "" }, "declared_wait");
    expect(text).toContain("你已经挂了等待源");
    expect(text).toContain("sleep 150");
    expect(text).toContain("排队");
    // 出口必须在：后台 bash + wait_until_seconds 或 monitor，然后结束本轮
    expect(text).toContain("wait_until_seconds");
    expect(text).toContain("monitor");
    expect(text).toContain("结束本轮");
  });

  it("没有声明的等待（N ≥ 阈值）：只说阻塞与出口，不说「你已经挂了等待源」", () => {
    const text = buildForegroundSleepNotice({ seconds: 45, rest: "" }, "long_sleep");
    expect(text).not.toContain("你已经挂了等待源");
    expect(text).toContain("阻塞了本轮");
    expect(text).toContain("送不进来");
    expect(text).toContain("wait_until_seconds");
    expect(text).toContain("结束本轮");
  });

  it("追加在结果末尾（以换行开头，不粘连上一次输出）", () => {
    expect(
      buildForegroundSleepNotice({ seconds: 30, rest: "" }, "long_sleep").startsWith("\n"),
    ).toBe(true);
  });

  it("引导阈值是 30 秒（超过它的长阻塞即使没有等待源也提示）", () => {
    expect(FOREGROUND_SLEEP_LONG_SECONDS).toBe(30);
  });
});
