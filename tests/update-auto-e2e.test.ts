/**
 * 自动更新 — latest.txt → install.sh → 安装 → 状态通知离线链路
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const INSTALL_TEMPLATE = join(ROOT, "scripts/install-template.sh");
const originalEnv = { ...process.env };

interface FakeRelease {
  releaseDir: string;
  home: string;
  oldBinary: string;
  newBinary: string;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function makeRelease(): FakeRelease {
  const root = mkdtempSync(join(tmpdir(), "sid-update-e2e-"));
  const releaseDir = join(root, "release");
  const home = join(root, "home");
  const oldBinary = join(root, "old-sid-code");
  const newBinary = join(root, "new-sid-code");
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(home, { recursive: true });

  writeFileSync(oldBinary, "#!/bin/bash\necho old\n", { mode: 0o700 });
  writeFileSync(newBinary, "#!/bin/bash\necho new\n", { mode: 0o700 });
  const version = "0.1.604";
  const versionDir = join(releaseDir, version);
  mkdirSync(versionDir, { recursive: true });
  const tarRoot = join(root, "payload", "sid-code");
  mkdirSync(tarRoot, { recursive: true });
  writeFileSync(join(tarRoot, "sid-code"), "#!/bin/bash\necho new\n", {
    mode: 0o700,
  });
  const tarball = join(
    versionDir,
    `sid-code-${version}-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`,
  );
  const archive = spawnSync("tar", ["-czf", tarball, "-C", join(root, "payload"), "sid-code"], {
    encoding: "utf8",
  });
  if (archive.status !== 0) throw new Error(archive.stderr);
  writeFileSync(`${tarball}.sha256`, `${sha256(tarball)}  ${tarball}\n`);
  writeFileSync(join(releaseDir, "latest.txt"), `${version}\n`);
  writeFileSync(join(releaseDir, "beta.txt"), `${version}\n`);

  return { releaseDir, home, oldBinary, newBinary };
}

function runInstall(releaseDir: string, home: string, extraEnv: Record<string, string> = {}) {
  const configDir = join(home, ".sid-code");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const oldPath = join(home, ".local", "bin", "sid-code");
  writeFileSync(oldPath, "#!/bin/bash\necho old\n", { mode: 0o700 });
  const result = spawnSync("bash", [INSTALL_TEMPLATE], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      SHELL: "/bin/bash",
      SID_CONFIG_DIR: configDir,
      RELEASE_BASE: `file://${releaseDir}`,
      ...extraEnv,
    },
  });
  return { result, oldPath };
}

function runLockWorker(
  lockModule: string,
  configDir: string,
  acquireDelayMs: number,
  holdMs: number,
): Promise<{ status: number | null; output: string }> {
  const script = `
    await new Promise((resolve) => setTimeout(resolve, ${acquireDelayMs}));
    const { acquireLock } = await import(${JSON.stringify(lockModule)});
    const lock = acquireLock();
    if (!lock) {
      console.log("busy");
      process.exit(0);
    }
    console.log("acquired");
    setTimeout(() => lock.release(), ${holdMs});
  `;
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["-e", script], {
      env: { ...process.env, SID_CONFIG_DIR: configDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`锁 worker 超时: ${output}`));
    }, 5000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("自动更新离线安装链路", () => {
  test("stable latest.txt 安装成功并切换入口，失败前的旧入口不会被破坏", () => {
    const fixture = makeRelease();
    try {
      const { result, oldPath } = runInstall(fixture.releaseDir, fixture.home);
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      expect(result.status).toBe(0);
      expect(readFileSync(oldPath, "utf8")).toContain("new");
      expect(result.stdout).toContain("目标版本: v0.1.604（通道: stable）");
      expect(result.stdout).toContain("安装完成！v0.1.604");
    } finally {
      rmSync(join(fixture.releaseDir, "0.1.604"), {
        recursive: true,
        force: true,
      });
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  test("beta 通道读取 beta.txt，显式版本优先于 stable 指针", () => {
    const fixture = makeRelease();
    try {
      writeFileSync(join(fixture.releaseDir, "latest.txt"), "0.1.603\n");
      writeFileSync(join(fixture.releaseDir, "beta.txt"), "0.1.604\n");
      const { result } = runInstall(fixture.releaseDir, fixture.home, {
        SID_CODE_CHANNEL: "beta",
      });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("通道: beta");
      expect(result.stdout).toContain("目标版本: v0.1.604");
      // 通道标记：二进制据此在 --version / TUI 显示「beta 预发布版」
      const marker = join(fixture.home, ".local/share/sid-code/versions/0.1.604/.channel");
      expect(readFileSync(marker, "utf8").trim()).toBe("beta");
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
      rmSync(fixture.releaseDir, { recursive: true, force: true });
    }
  });

  // promote 场景：同一版本目录先以 beta 装、再以 stable 装（目录被复用），标记必须翻回 stable，
  // 否则 promote 后的稳定版用户会一直看到 beta 标。
  test("同一版本先 beta 后 stable 安装，通道标记被覆盖为 stable", () => {
    const fixture = makeRelease();
    try {
      const marker = join(fixture.home, ".local/share/sid-code/versions/0.1.604/.channel");
      const beta = runInstall(fixture.releaseDir, fixture.home, {
        SID_CODE_CHANNEL: "beta",
      });
      if (beta.result.status !== 0) throw new Error(beta.result.stderr || beta.result.stdout);
      expect(readFileSync(marker, "utf8").trim()).toBe("beta");

      const stable = runInstall(fixture.releaseDir, fixture.home);
      if (stable.result.status !== 0) throw new Error(stable.result.stderr || stable.result.stdout);
      expect(stable.result.stdout).toContain("直接复用");
      expect(readFileSync(marker, "utf8").trim()).toBe("stable");
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
      rmSync(fixture.releaseDir, { recursive: true, force: true });
    }
  });

  // T4 端到端：已装 beta（.channel=beta）→ 通道判定为 beta → **真实的** spawnBackgroundInstall
  // 带这个通道去跑 install.sh → install.sh 读 beta.txt 装上新号，且 .channel 仍是 beta。
  // latest.txt 故意指向一个不存在的版本：若 installer 退回写死 stable，安装必然失败，这条测试变红
  // （变异自证见下一条）。
  async function autoUpdateWith(channel: "stable" | "beta") {
    const fixture = makeRelease();
    writeFileSync(join(fixture.releaseDir, "latest.txt"), "0.1.599\n"); // 服务器上没有这个目录
    writeFileSync(join(fixture.releaseDir, "beta.txt"), "0.1.604\n");
    const configDir = join(fixture.home, ".sid-code");
    const lockDir = join(configDir, "updates", "lock");
    mkdirSync(lockDir, { recursive: true });
    const installerModule = join(ROOT, "packages/core/src/update/installer.ts");
    const runner = `
      const { spawnBackgroundInstall } = await import(${JSON.stringify(installerModule)});
      spawnBackgroundInstall("0.1.604", "0.1.603", ${JSON.stringify(lockDir)}, ${JSON.stringify(channel)});
    `;
    const r = spawnSync("bun", ["--eval", runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fixture.home,
        SHELL: "/bin/bash",
        SID_CONFIG_DIR: configDir,
        SID_CODE_INSTALL_URL: `file://${INSTALL_TEMPLATE}`,
        RELEASE_BASE: `file://${fixture.releaseDir}`,
        SID_CODE_CHANNEL: "stable", // 继承值故意相反：必须被调用方传入的通道覆盖
      },
    });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    const statePath = join(configDir, "updates", "state.json");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const st = JSON.parse(readFileSync(statePath, "utf8"));
        if (st.lastAttempt?.status) return { fixture, state: st };
      } catch {
        /* 还没写完 */
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error("自动更新子进程超时未写 state.json");
  }

  test("beta 安装的自动更新读 beta.txt 装上新号，.channel 仍为 beta", async () => {
    const { resolveReleaseChannel } = await import(
      join(ROOT, "packages/shared/src/release-channel.ts")
    );
    // 已装的 beta：版本目录旁 .channel=beta → 判定为 beta（自动更新据此选通道）
    const installed = mkdtempSync(join(tmpdir(), "sid-installed-beta-"));
    writeFileSync(join(installed, ".channel"), "beta\n");
    const channel = resolveReleaseChannel("release", installed);
    rmSync(installed, { recursive: true, force: true });
    expect(channel).toBe("beta");

    const { fixture, state } = await autoUpdateWith(channel);
    try {
      expect(state.lastAttempt.status).toBe("success");
      const marker = join(fixture.home, ".local/share/sid-code/versions/0.1.604/.channel");
      expect(readFileSync(marker, "utf8").trim()).toBe("beta");
    } finally {
      rmSync(join(fixture.home, ".."), { recursive: true, force: true });
    }
  });

  test("变异自证：通道若写死 stable，同一场景必然安装失败", async () => {
    const { fixture, state } = await autoUpdateWith("stable");
    try {
      expect(state.lastAttempt.status).toBe("failed");
    } finally {
      rmSync(join(fixture.home, ".."), { recursive: true, force: true });
    }
  });

  test("下载失败时保持旧入口不变", () => {
    const fixture = makeRelease();
    try {
      rmSync(join(fixture.releaseDir, "0.1.604"), {
        recursive: true,
        force: true,
      });
      const { result, oldPath } = runInstall(fixture.releaseDir, fixture.home);
      expect(result.status).not.toBe(0);
      expect(readFileSync(oldPath, "utf8")).toContain("old");
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
      rmSync(fixture.releaseDir, { recursive: true, force: true });
    }
  });

  test("并发抢锁时只有一个进程获得锁", async () => {
    const root = mkdtempSync(join(tmpdir(), "sid-update-lock-e2e-"));
    const configDir = join(root, "config");
    const lockModule = join(ROOT, "packages/core/src/update/lock.ts");
    try {
      const workers = await Promise.all([
        runLockWorker(lockModule, configDir, 0, 500),
        runLockWorker(lockModule, configDir, 100, 50),
      ]);
      expect(workers.filter(({ output }) => output.includes("acquired"))).toHaveLength(1);
      expect(workers.filter(({ output }) => output.includes("busy"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** 与 install-template.sh 的 detect_shell_rc 对齐：SHELL=/bin/bash 时 macOS 写 ~/.bash_profile、Linux 写 ~/.bashrc。 */
function bashRcPath(home: string): string {
  return process.platform === "darwin" ? join(home, ".bash_profile") : join(home, ".bashrc");
}

/**
 * 背景（2026-10-16 修复）：rc 块是"追加到文件末尾"的，zsh/bash 对同名 alias 都是
 * 后定义生效 —— 修复前首装分支不检查已有 sc，用户自己的 sc（如截图工具）会被块尾
 * 的 sid-code sc 静默盖掉，与脚本注释声明的安全原则 5「尊重用户配置不覆盖」相悖。
 * 这里端到端钉住三件事：已有 sc 不覆盖（且只补 PATH）、无 sc 照常写、重复安装幂等。
 */
describe("注册命令：不覆盖用户已有的 sc 别名", () => {
  test("rc 里已有用户自己的 sc 时，首装与重装都不写入 sid-code 的 sc（只补 PATH）", () => {
    const fixture = makeRelease();
    try {
      const rc = bashRcPath(fixture.home);
      writeFileSync(rc, "alias sc='echo mine'\n");
      const first = runInstall(fixture.releaseDir, fixture.home);
      if (first.result.status !== 0) throw new Error(first.result.stderr || first.result.stdout);
      // 第二次走「已有块」分支：也不能因为块里缺 sc 行就补一个盖掉用户
      const second = runInstall(fixture.releaseDir, fixture.home);
      if (second.result.status !== 0) throw new Error(second.result.stderr || second.result.stdout);

      const content = readFileSync(rc, "utf8");
      expect(content).toContain("alias sc='echo mine'"); // 用户行原样保留
      expect(content).not.toContain("sid-code --dangerously-skip-permissions");
      expect(content).toContain(".local/bin"); // PATH 照写，sid-code 命令本身可用
      expect(first.result.stdout).toContain("检测到已有 sc 别名，保留不变");
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
      rmSync(fixture.releaseDir, { recursive: true, force: true });
    }
  });

  test("rc 里没有 sc 时照常写入（对照组，防修复收窄成「永远不写」）", () => {
    const fixture = makeRelease();
    try {
      const rc = bashRcPath(fixture.home);
      writeFileSync(rc, "# 已有 rc 内容\n");
      const { result } = runInstall(fixture.releaseDir, fixture.home);
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      const content = readFileSync(rc, "utf8");
      expect(content).toContain("alias sc='sid-code --dangerously-skip-permissions'");
      expect(result.stdout).toContain("已写入 PATH + sc");
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
      rmSync(fixture.releaseDir, { recursive: true, force: true });
    }
  });

  test("重复安装幂等：块与 sc 都只有一份", () => {
    const fixture = makeRelease();
    try {
      const rc = bashRcPath(fixture.home);
      writeFileSync(rc, "# 已有 rc 内容\n");
      const first = runInstall(fixture.releaseDir, fixture.home);
      if (first.result.status !== 0) throw new Error(first.result.stderr || first.result.stdout);
      const second = runInstall(fixture.releaseDir, fixture.home);
      if (second.result.status !== 0) throw new Error(second.result.stderr || second.result.stdout);
      const content = readFileSync(rc, "utf8");
      expect((content.match(/>>> sid-code >>>/g) ?? []).length).toBe(1);
      expect((content.match(/alias sc=/g) ?? []).length).toBe(1);
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
      rmSync(fixture.releaseDir, { recursive: true, force: true });
    }
  });

  // .bashrc 同步分支只在 macOS + bash 触发（脚本内 `uname -s` 门控）；
  // Linux 上不注册这条，避免出现"永远通过"的假绿。
  if (process.platform === "darwin") {
    test("macOS：.bashrc 已有用户 sc → 同步块只写 PATH，不写 sc", () => {
      const fixture = makeRelease();
      try {
        const bashrc = join(fixture.home, ".bashrc");
        writeFileSync(join(fixture.home, ".bash_profile"), "# bp\n");
        writeFileSync(bashrc, "alias sc='echo mine-bash'\n");
        const { result } = runInstall(fixture.releaseDir, fixture.home);
        if (result.status !== 0) throw new Error(result.stderr || result.stdout);
        const content = readFileSync(bashrc, "utf8");
        expect(content).toContain("alias sc='echo mine-bash'");
        expect(content).not.toContain("sid-code --dangerously-skip-permissions");
        expect(content).toContain(".local/bin");
        expect(result.stdout).toContain(".bashrc 已有 sc 别名，保留不变");
      } finally {
        rmSync(fixture.home, { recursive: true, force: true });
        rmSync(fixture.releaseDir, { recursive: true, force: true });
      }
    });
  }
});
