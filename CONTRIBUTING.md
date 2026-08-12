# 贡献指南

感谢你愿意花时间改进 sid-code。本文只写**这个仓库真实生效的规则**，
不写通用套话——凡是下面提到的门禁，都能在本地跑出来验证。

面向 AI agent 的仓库约定在 [CLAUDE.md](./CLAUDE.md)，
两份文件受众不同但规则一致：agent 与人遵守同一套门禁。

---

## ⚠️ 先读这一条：本项目当前的许可状态

本仓库的 [LICENSE](./LICENSE) 是 **MIT**，你的贡献将按同一许可分发。
没有 CLA，提 PR 即视为同意按该许可授权。

但**本项目自身的许可不等于整个仓库都干净**，有一条必须在你动手前知道：

> 第三方代码的来源与许可记录在 [NOTICE](./NOTICE)。其中终端渲染底座（现 `packages/tui-renderer/src/`）
> **含有我们未获授权的第三方增量修改**，正在被重构掉。
> **改动 `packages/tui-renderer/src/` 之前请先读 NOTICE 第 1 节**与
> [`packages/tui-renderer/src/README.md`](./packages/tui-renderer/src/README.md)。
> （分包前它在 `src/ink/`。）

我们宁愿在这里如实说明现状，也不想让你在不知情的前提下贡献代码。
如果你发现 NOTICE 里的描述与事实不符（低估了外部来源比例、漏记来源），
请指出来，我们会更正。

---

## 环境准备

只需要 Bun，不需要 Node（发行产物是单文件二进制）：

```bash
curl -fsSL https://bun.sh/install | bash    # 已装可跳过
bun --version                                # 开发用 1.3.x，CI 用 latest
```

```bash
git clone <仓库地址>
cd sid-code
bun install
make build            # 构建开发版二进制（不改版本号）
```

### `eval-framework` 是仓内 workspace 包，不是外部依赖

评测框架在 `packages/eval-framework/`，通过 bun workspace 接入
（根 `package.json` 的 `"workspaces": ["packages/*"]` + `"eval-framework": "workspace:*"`）。
`bun install` 会把 `node_modules/eval-framework` 建成指向它的 **symlink**，
所以直接改 `packages/eval-framework/` 下的源码**立即生效，不需要重新 install**。

它曾经是 `file:../eval-framework`（指向仓库外一个未入库项目），导致外部贡献者
`bun install` 装不上、22 个引用文件类型全断。这条已在 P1-5 修掉，
**不要再把它改回仓库外路径**。

框架自己的 4 个测试文件（159 个用例）会被根 `bun test` 一并跑到，这是预期的。

---

## 双版本并存：验证改动必须跑 `sc-dev`

本地是两个不同的二进制名，不靠 PATH 优先级区分：

| 命令 | 指向 | 用途 |
| --- | --- | --- |
| `sc` / `sid-code` | 线上下载版 | 对照线上行为 |
| `sc-dev` / `sid-code-dev` | 仓库根构建产物 | **验证你的改动** |

> ⚠️ 改了代码跑 `sc` 验证不到任何本地改动——它是线上稳定版。
> 拿不准时先 `which sid-code-dev sid-code` 确认指向。

版本号是**编译期内联**进二进制的（`bun build --compile` 把 `package.json` 打进产物），
所以 `git pull` 拿到新源码后**必须重新 `make build`**，否则跑的还是旧代码。

---

## 提 PR 之前必须跑的两条命令

```bash
bun test        # 全量单测，必须 0 fail
make build      # 构建 + 产物自检，必须成功
```

这两条就是 CI 门禁的内容（见 `.github/workflows/ci.yml`），
在 PR 与 push 到 `master` 时都会跑。本地跑绿了 CI 基本不会红。

几个容易踩的点：

- **`make build` 不改版本号**，日常就用它。带 `-bump` 后缀的目标（`make build-bump`）会把版本号 +1，
  贡献者不需要用，**版本号只在发布流程里变**。
- **不要跑 `./scripts/release.sh`**，那是维护者的发布脚本。
- CI **刻意不含** `tsc --noEmit`：仓库有存量类型错误（P1-3），暂不纳入门禁。
  但请不要新增类型错误。
- `bun run lint` 跑 oxlint（P1-4，2026-08-10 接入），CI 与 pre-commit 都会拦。
  规则集只开 correctness 档（真错误），不管风格。规则口径与豁免理由见仓库根
  `.oxlintrc.json` 的注释；提交前可以本地先跑一遍 `bun run lint`。
  （`bun run lint:fix` 也在，但当前唯一开启的规则 `no-unused-vars` oxlint 不做自动修复，
  跑了也是空操作——留着是为了将来规则集扩展后不用再补这个脚本。）
- `bun run format` 跑 oxfmt（P2-1，2026-08-12 接入），CI 与 pre-commit 也都会拦
  （拦的是 `bun run format:check`）。**排版不用再靠"照着周边写"**，交给它就行。
  两个门禁都刻意只**报错**、不自动改你的文件：hook 里偷偷改工作区，会让你提交的内容
  与你 review 过的内容不一致。红了就跑 `bun run format` 再 `git add`。

### 改了这些目录，还要重新生成官网参考页

`website/ref/` 下 6 个页面是**从源码生成**的。动过
`src/help.ts`、`src/cli.ts`、`src/tool/`、`src/command/`、`src/config/`、`src/hook/`
之后跑：

```bash
bun run docs:gen-reference
```

并把 `website/ref/` 与 `website/public/llms.txt` 的改动一并提交。
pre-commit hook 有 `--check` 门禁会拦住这种漂移（未装 hook 先跑 `bun run install-hooks`）。

源码改了不重新生成就是文档骗人——用户照着文档写一个不存在的参数，比没有文档更糟。

---

## 代码风格

排版交给 **oxfmt**（`bun run format`，配置见仓库根 `.oxfmtrc.json`，每个取值都写了理由）。
`oxlint` 管的是正确性（未用变量这类真问题），两者分工不重叠。所以**排版不必手调**，
写完跑一次 format 就行。

`.oxfmtrc.json` 有两处刻意的范围限制，改之前先读那里的注释：**yaml 与 markdown 不在
格式化范围内**（yaml 是评测 case 数据、含 `evals/holdout/` 永封集；markdown 会被重排
表格并动到 `CLAUDE.md` 这类约定事实源），生成物与 `packages/tui-renderer/src/_vendor/`
也排除在外。

风格约定本身（formatter 覆盖不到的部分）：

- **TypeScript，2 空格缩进**（`src/` 下零 tab 缩进文件），LF 换行，文件末尾留一个换行。
  这四项与 `.editorconfig` 和 `.oxfmtrc.json` 三处一致，改一处要同步改三处。
- **注释用中文**，且注释解释**为什么**这么写，不解释代码在做什么。
  仓库里大量注释记录了「这里踩过什么坑、为什么不能改回去」——
  这类注释是资产，遇到时请读，不要因为「看着啰嗦」删掉。
- 新代码跟着**改动周边的既有风格**走，不要引入新的库或新的模式来解决已有解法的问题。

## 测试约定

新功能与 bug 修复都要带测试。有一条容易违反且**测试全绿时也发现不了**的硬约定：

> **只要一个函数除返回值外还会写 `~/.sid-code/`，调它的测试就必须把落盘目标重定向到 tmpdir。**

隔离手段：设 `SID_CONFIG_DIR` 指向临时目录，或用组件自己的专用重定向变量
（如 `SID_CODE_CACHE_BREAKS`）。`bunfig.toml` 的 `[test].preload` 里有一道兜底
（`tests/preload-isolate-sid-home.ts`），但**兜底不替代显式隔离**：
要断言落盘内容的测试仍应自己设专用变量。

四个实测踩到的坑：

1. **必须存/恢复原值，不要无条件 `delete`**——`bun test` 同批多文件跑在同一进程里，
   直接删会把 preload 的兜底一起抹掉。
2. 落盘走 `import().then()` 的，恢复 env 前先让微任务跑干
   （`await new Promise(r => setTimeout(r, 0))`）。
3. **不要硬编码 `join(homedir(), ".sid-code", ...)` 算期望路径**，用 `getSidHome()` 派生。
4. **spawn 子进程的 e2e 测试要显式传 `SID_CONFIG_DIR`**，子进程不继承进程内的 env 改动。

为什么这条约定要写进贡献指南：违反它的测试**会全绿**，同时往用户真实的
`~/.sid-code/` 里灌假数据，把线上遥测查询污染成查不到真记录。
防复发门禁在 `tests/telemetry/no-real-path-writes.test.ts`（静态扫描 `tests/` 下的落盘调用方）。

---

## 提交与 PR

**提交信息用 Conventional Commits**，因为 `CHANGELOG.md` 是从 git 历史机械生成的
（`scripts/generate-changelog.ts` 按 type 分组），格式不对就会被归到「其他」组：

```
feat(cache): 新增 XXX
fix(tool): 修复 YYY 在 ZZZ 下不生效
docs: 更新 AAA
```

识别的 type：`feat` / `fix` / `refactor` / `perf` / `docs` / `style` / `test` / `build` / `ci` / `chore`
（后 5 个归入「其他」组）。scope 可选。**描述用中文**。

PR 要求：

- **一个 PR 一件事**。混合改动 review 成本高，且出问题不好回滚。
- 标题同样用 Conventional Commits 格式，控制在 70 字符内。
- 正文说清三件事：改了什么、为什么这么改、怎么验证的（贴 `bun test` 与 `make build` 结果）。
- 用 [PR 模板](./.github/pull_request_template.md)，它就是这三件事的清单。

### ⛔ 一条铁律：不要动与你的改动无关的文件

这个仓库随时有多个任务并行（人在写文档、agent 在改代码、测试在跑）。
所以 `git status` 里的「意外文件」**默认属于别人的在途工作**。

禁止的操作：

- `rm` 任何不是你亲手创建的文件
- `git checkout -- <dir>` / `git restore` / `git reset --hard` / `git clean`
  ——这些会**静默且不可逆地**丢弃未提交改动，没有回收站、没有 reflog 可救
- 以「清理测试产物」「回到干净状态」为由批量还原目录

**工作区不干净不影响你交付改动。** 留着一个多余文件的代价是零；
删错一个文件的代价是别人几小时的工作凭空消失（2026-07-28 真实发生过一次，
2 个未 add 的新页面 + 约 300 行已追踪改动永久丢失）。

---

## 报告问题

- **bug / 功能请求**：用 [issue 模板](./.github/ISSUE_TEMPLATE/)，
  带上 `sid-code --version`、操作系统、可复现步骤。
- **安全漏洞**：**不要开公开 issue**，按 [SECURITY.md](./SECURITY.md) 私下上报。
- **版权 / 归属问题**（尤其涉及 `packages/tui-renderer/src/`，分包前的 `src/ink/`）：见 [NOTICE](./NOTICE) 第 1 节，
  或直接联系维护者。如果你发现 NOTICE 里的描述与事实不符（低估了外部来源比例、
  漏记来源、修改描述不准），**请指出来，我们会更正**——
  我们宁愿披露过度，也不要披露不足。

参与本项目需遵守 [行为准则](./CODE_OF_CONDUCT.md)。
