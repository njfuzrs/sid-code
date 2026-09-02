/**
 * E1（verifier uv 本地镜像）对称性门禁
 *
 * ## 这份测试为什么必须存在
 *
 * `runs/modelswitch-base` 里 **5/10 题的 reward=0 是假 0** —— verifier 根本没判分，
 * 死因是下 uv tarball 时 curl 打不通 github.com。E1 把那次外网下载换成宿主本地镜像。
 *
 * 但 E1 有一个**不报错的失效形态**：只给一侧接上。
 * verifier 是**两侧共用**的一层，坏掉的样本与"没解出来"**逐字节相同**（都是 reward=0）
 * ⇒ 一侧判分可靠、另一侧靠运气，而两边的分数会被并排放进同一张表。
 * 本轮 cc 侧 10/10 判成了是**运气**（同一批题在 sid 那晚 5 题栽在同一个下载上），
 * 不是结构性差异。
 *
 * ⚠️ 这正是本仓「必控变量一破，分母就装不同东西」那一类：
 * `0.100 → 0.750` 那个假数就是这么来的。
 *
 * ## 为什么只有 L1（纯静态）
 *
 * 本门禁**只读脚本文本**，不起容器、不跑 harbor、不联网 —— 所以在 CI 上**真的在跑**。
 * 「探测依赖失败就 skip」在 CI 上等于门禁不存在，本仓踩过两次。
 * 真实生效验证靠 `lib/uv-mirror.sh start` 自己的容器可达性闸 + 跑前 E1 那行输出。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const HARBOR = join(import.meta.dir, "../../evals/external-benchmarks/harbor");
const LIB = join(import.meta.dir, "../../evals/external-benchmarks/lib");

const SID_RUNNER = join(HARBOR, "run-model-switch.sh");
const CC_RUNNER = join(HARBOR, "run-claude-code-contrast.sh");
const PERM_RUNNER = join(HARBOR, "run-permission-switch.sh");
const MIRROR = join(LIB, "uv-mirror.sh");

/** 两条链路的 runner —— 任何一条接了 E1 而另一条没接，就是不可比。 */
const RUNNERS = [
  { name: "sid（run-model-switch.sh）", path: SID_RUNNER },
  { name: "cc（run-claude-code-contrast.sh）", path: CC_RUNNER },
  { name: "perm（run-permission-switch.sh）", path: PERM_RUNNER },
];

// ⚠️ 刻意不含 gate-claude-code-install.sh：它用 `--install-only`，**不跑 verifier**
// ⇒ E1 对它无意义。把它列进来只会逼出一个"为了让门禁绿"的空注入。

const read = (p: string) => readFileSync(p, "utf8");

/**
 * ⚠️ 断言必须只看**代码**，不能看注释 —— 这是本门禁自己踩到的坑（2026-09-02）。
 *
 * 初版直接在全文上断 `toContain("--ve")`。而接入 E1 时我在两个 runner 里都写了
 * 解释性注释，注释里恰好含 `--ve` 与 `UV_INSTALLER_GITHUB_BASE_URL`
 * ⇒ **把真正的注入行整个摘掉，门禁照样 12 pass 全绿**（变异自证抓到的）。
 *
 * 形态与本仓 §4.4 那条完全同源：那次是「把源码里"不要用它"的警告注释判成了违规」，
 * 这次是「把注释里的关键词当成了代码在生效」—— 一个假红、一个假绿，同一个根因：
 * **判据读了不该读的文本**。
 */
const codeOf = (p: string) =>
  read(p)
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

describe("E1 uv 镜像：脚本存在且可执行", () => {
  test("lib/uv-mirror.sh 存在", () => {
    expect(existsSync(MIRROR)).toBe(true);
  });

  test("镜像目录按 github release 结构落盘（这样换 base URL 就能直接命中）", () => {
    // 题目实测在用两个 uv 版本（10 题 0.7.13 + hello-world 0.9.7）。
    // 用 UV_INSTALLER_GITHUB_BASE_URL 而非 INSTALLER_DOWNLOAD_URL 的前提是：
    // 落盘路径必须复刻 github 的 /astral-sh/uv/releases/download/<版本>/ 结构。
    expect(codeOf(MIRROR)).toContain("astral-sh/uv/releases/download");
  });

  test("宿主地址是 colima host-gateway，不是容器里不解析的 host.docker.internal", () => {
    const s = codeOf(MIRROR);
    expect(s).toContain("192.168.5.2");
    // ⚠️ 实测：任务镜像里 host.docker.internal 无法解析（curl: (6)）。
    // 它只允许出现在解释性注释里，不能是真正的默认取值。
    expect(s).not.toMatch(/^\s*HOST_ADDR="\$\{SID_UV_MIRROR_HOST:-host\.docker\.internal\}"/m);
  });

  test("容器侧可达性是独立一闸：宿主取到 ≠ 容器取到", () => {
    const s = codeOf(MIRROR);
    // host.docker.internal 就是栽在这一步：宿主 200、容器解析不了。
    expect(s).toMatch(/docker run[\s\S]*?http_code/);
  });
});

describe("E1 对称性：两条链路必须同时接入（这是必控变量）", () => {
  for (const r of RUNNERS) {
    test(`${r.name} 注入了 --ve UV_INSTALLER_GITHUB_BASE_URL`, () => {
      // ⚠️ 必须用 codeOf：注释里也有这两个词，读全文会绿着失效（见 codeOf 头注释）。
      const code = codeOf(r.path);
      // 判的是**注入形态**（--ve 与变量名在同一处），不是两个词各自出现过。
      expect(code).toMatch(/--ve\s+"UV_INSTALLER_GITHUB_BASE_URL=/);
    });

    test(`${r.name} 调用 lib/uv-mirror.sh 而不是自己另写一份`, () => {
      // 两侧各写一份必然漂移，而漂移的形态是"两边镜像不同"——照样不可比。
      expect(codeOf(r.path)).toMatch(/uv-mirror\.sh\s+start/);
    });

    test(`${r.name} 的跳过开关同名（SID_HARBOR_SKIP_UV_MIRROR）`, () => {
      // 开关不同名 ⇒ 想两边一起关时只关掉了一边，而这是最需要对称的时刻。
      expect(codeOf(r.path)).toContain("SID_HARBOR_SKIP_UV_MIRROR");
    });

    test(`${r.name} 镜像起不来时不静默退化`, () => {
      // 这条刻意读**全文**：它要的就是那句给人看的提示文案（echo 里的中文）。
      const s = read(r.path);
      // 失败允许继续（退回直连 = 本轮之前的行为，不更坏），但必须打出来。
      // 静默退化是本仓最贵的那类错：形态与"一切正常"完全一样。
      expect(s).toMatch(/uv 镜像未起成|退回直连/);
    });
  }
});
