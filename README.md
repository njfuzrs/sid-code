# sid-code

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/njfuzrs/sid-code/actions/workflows/ci.yml/badge.svg)](https://github.com/njfuzrs/sid-code/actions/workflows/ci.yml)
[![文档](https://img.shields.io/badge/%E6%96%87%E6%A1%A3-sid--code.cc-4c8bf5)](https://www.sid-code.cc/)
[![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-macOS%20%7C%20Linux-lightgrey)](#安装)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.0-000000?logo=bun&logoColor=white)](https://bun.sh)

**中文** · [English](./README.en.md)

**跑在终端的 coding agent。** 你用中文说要干什么，它读你的代码、改文件、跑命令，
然后用真实的编译和测试结果证明改对了没有。

TypeScript + Bun 编写，终端渲染底座以 MIT 的 ink 为起点重写（`packages/tui`，来源见 NOTICE），编译成单文件二进制分发——下载一个文件就能跑，
不需要装 Node、不需要 `npm install`。

- 📖 **官方文档：** https://www.sid-code.cc/
- 📄 **更新日志：** https://www.sid-code.cc/changelog
- 🤝 **参与贡献：** [CONTRIBUTING.md](./CONTRIBUTING.md) · 🔒 **安全上报：** [SECURITY.md](./SECURITY.md)

---

## 安装

```bash
curl -fsSL https://www.sid-code.cc/releases/sid-code/install.sh | bash
```

装完直接用：

```bash
sc                    # 启动（推荐）
sid-code --version    # 确认版本
sid-code update       # 以后升级到最新版
```

装不上或 PATH 没生效，见[安装文档](https://www.sid-code.cc/start/install)。

## 30 秒示例

启动后直接说人话，不需要记命令：

```text
$ sc

› 这个模块的超时配置不生效，查一下为什么

  搜索 timeout 相关实现…
  读取 packages/core/src/tool/bash.ts:55-80
  定位到：parseEnv 读了环境变量但没传给 spawn 的 timeout 参数
  修改 packages/core/src/tool/bash.ts
  运行 bun test tests/tool/bash.test.ts  → 12 pass 0 fail

  超时没生效的原因是 parseEnv 的返回值没接到 spawn 上。已修复并跑过单测。
```

每一步都在终端里可见，随时按 <kbd>Esc</kbd> 打断。

## 四条差异化能力

Claude Code 的主要能力面这里都有（agentic loop、工具调用、权限门控、Hook、Skill、MCP 都有对应实现），
差别在下面四条 —— 它们不是"做得更好"，而是**闭源商业产品受定位约束而结构性不同**：

| 能力 | 说明 |
| --- | --- |
| **深度贴合企业环境** | 内部网关计费、MCP 接入、团队默认配置分发，面向企业内网基建设计。装上就接得上你公司已有的那套东西 |
| **模型任你换，harness 整套可改** | 改一行配置换模型（Anthropic / OpenAI / Ollama 三族，OpenAI 族含 Chat Completions 与 Responses 两种；自动降级），写一个文件加扩展（Hook、Skill、子代理、MCP），提一个 PR 改内核（44 个内置工具、上下文工程、主循环全部开源） |
| **数据全部自主** | 会话轨迹、评测结果、成本账本都留在自己的基础设施里，sid-code 不向维护者回传任何会话内容。模型请求发往你选的 provider，它是否用于训练取决于该 provider 的政策。逐条出网见[隐私与数据流向](https://www.sid-code.cc/use/privacy) |
| **每一分钱、每一步决策都查得到** | 耗时、成本、决策全留轨迹，默认就开着；发布前跑评测防回退。它同时是我们按版本复算「更快 / 更省 / 更少返工 / 更安全」的唯一度量来源 |

用过 Claude Code 的话迁移成本几乎为零，见[迁移指南](https://www.sid-code.cc/team/migrate)。

**代码来源**：兼容的是 Claude Code 的接口（配置文件名、Hook 事件名、CLI 参数），实现是自己写的。
和 Claude Code 源码逐行比对：连续 6 行一致的代码占 0.04%（且大半是两边共同的上游 ink），
逐字一致的句子 7 条，改名残留 0。口径与说明见[和 Claude Code 的关系](https://www.sid-code.cc/start/#代码来源)，归属记录见 [NOTICE](./NOTICE)。

## 现状

| 项 | 现状 |
| --- | --- |
| 代码量 | 55.9 万行 TypeScript（含测试 23.4 万行；不含渲染底座里原样继承自上游 ink 的部分） |
| 工程闭环 | 15,911 个单测、Agent 引擎行覆盖率 88.0%；每个 PR 在 CI 上跑全量，全绿才合入 |
| 能力面 | 44 个内置工具、MCP Client / Server、LSP 代码智能、权限门控、可观测轨迹 |
| 评测体系 | 独立评测集 [agent-traj-bench](https://github.com/njfuzrs/agent-traj-bench)：从真实会话逆向构造的 39 道 SWE-bench 风格题 |

<!--
  数字口径（2026-09-30 换口径，与官网首页能力条、作者简历三处同源）：
    旧值「20 万行以上 / 600+ 测试文件 / 8000+ 单测 / 32 类 Hook / 30 个 eval case」是静态扫描口径，
    与简历对不上；且 30 个 eval case 已于 2026-09-18 随 evals/ 旧题集一并删除，继续挂着就是不实陈述。
    现在前两行的数字全部取自 docs-research 仓 scripts/resume-metrics.ts（`--coverage`）的同一次运行（2026-10-12，HEAD=cdb37f58）：
    代码行数    559,229 = 567,027（生产 + 测试 + 工程脚本）− 7,798（packages/tui/src 里 git blame 仍归上游 ink 导入提交 8fd9048d 的行）；测试 234,289
    单测用例    `bun test` 实际执行数 15,911（含动态生成用例，静态 grep 数不到）
    引擎覆盖率  packages/core/src 行覆盖 88.0%（83,564 / 94,973）；只报引擎层，别换成全仓口径
    内置工具    sid-code --dump-tools 数组长度（44，与脚本生成的 ref/tools.md 同源同值）
    Hook 事件数不再写进这张表：HookEventName 枚举 32 类里有一部分是预留、尚未接线，
    放在「现状」里会被读成 32 类都能用。完整清单见 website/ref/hooks.md。
  与 website/.vitepress/theme/HomeShowcase.vue 的能力条、README.en.md 须一致，改一处要改三处。
  （2026-08-12 P2-6 曾把英文放到 README.md、中文挪到 README.zh-CN.md，为了 GitHub 默认页给英语读者。
   2026-09-20 改回：本仓工作语言与兄弟仓库一致，GitHub 默认页展示中文；英文副本在 README.en.md。）
-->

## 本地开发

本地是**双版本并存**，两个不同的二进制名，不靠 PATH 优先级区分：

| 命令 | 指向 | 用途 |
| --- | --- | --- |
| `sc` / `sid-code` | `~/.local/bin/sid-code`（线上下载版） | 对照线上行为 |
| `sc-dev` / `sid-code-dev` | 仓库根构建产物 | **验证本地改动** |

```bash
git clone <仓库地址>
cd sid-code
bun install
make build            # 构建开发版二进制（版本号不变，日常就用这个）
sc-dev                # 启动开发版
bun test              # 全量单测
```

> ⚠️ 改了代码要验证，必须跑 `sc-dev`。`sc` 指向线上稳定版，跑它验证不到任何本地改动。
> 拿不准时先 `which sid-code-dev sid-code` 确认指向。

文档站（VitePress，产物纯静态）：

```bash
bun run website:dev      # 本地预览 http://localhost:5173
bun run website:build    # 构建（死链检测在此生效）
```

更多约定见 [CLAUDE.md](./CLAUDE.md)。

## 许可

本仓代码采用 **[MIT 许可证](./LICENSE)**。本项目非商业化，不出售、不用于营利。

仓库内随附的第三方资产（入库的 `ripgrep` 二进制、以 ink 为起点的渲染底座 `packages/tui`、npm 运行时依赖）各依其自身许可，
记录在 **[NOTICE](./NOTICE)**。
