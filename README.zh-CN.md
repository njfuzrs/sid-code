# sid-code

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/rushengzhou/sid-code/actions/workflows/ci.yml/badge.svg)](https://github.com/rushengzhou/sid-code/actions/workflows/ci.yml)
[![文档](https://img.shields.io/badge/%E6%96%87%E6%A1%A3-sid--code.cc-4c8bf5)](https://www.sid-code.cc/)
[![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-macOS%20%7C%20Linux-lightgrey)](#安装)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.0-000000?logo=bun&logoColor=white)](https://bun.sh)

**中文** · [English](./README.md)

**跑在终端的 coding agent。** 你用中文说要干什么，它读你的代码、改文件、跑命令，
然后用真实的编译和测试结果证明改对了没有。

TypeScript + Bun + Ink 自研，编译成单文件二进制分发——下载一个文件就能跑，
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

功能面对标 Claude Code（agentic loop、工具调用、权限门控、Hook、Skill、MCP 都有对应实现），
差别在下面四条 —— 它们不是"做得更好"，而是**闭源商业产品结构上给不了**：

| 能力 | 说明 |
| --- | --- |
| **多 provider 可插拔** | Anthropic / OpenAI / Ollama 三族协议。公司自建网关、Azure、本地离线模型都能接，换模型是改配置不是换工具 |
| **功能自主可定制** | 44 个内置工具、32 类 Hook 事件、Skill 与子代理全部可改可扩。发现问题当天能补，不用等官方排期 |
| **深度贴合企业环境** | 内部网关计费、内网 GitLab、MCP 接入、团队默认配置分发，按真实企业内网基建做的适配 |
| **数据全部自主** | 会话轨迹、评测结果、成本账本都留在自己的基础设施里。既是合规前提，也是持续优化的燃料 |

用过 Claude Code 的话迁移成本几乎为零，见[迁移指南](https://www.sid-code.cc/team/migrate)。

## 现状

| 项 | 现状 |
| --- | --- |
| 自研代码 | `packages/` 下 20 万行以上 TypeScript（不含 vendor 的 ink fork） |
| 工程闭环 | 600+ 测试文件、8000+ 单测用例；每次改代码跑全量，全绿才提交 |
| 能力面 | 44 个内置工具、32 类 Hook 事件、LSP 代码智能、权限门控、可观测轨迹 |
| 评测体系 | 30 个 eval case（含 holdout），发布前跑，防功能回退 |

<!--
  数字口径（发版前人工核对一次，写约数不写精确值）：
    ⚠️ P2-2 分包（2026-08-11）：源码从扁平 src/ 搬到 packages/{shared,tui-renderer,core,cli}/src/。
       下面的命令已跟着改。仍写 `find src` 不会报错、只会数出 0 —— 复核命令静默失效比数字过期更糟，
       因为下一个人会以为自己核对过了。ink fork 现在自成一包，用排包代替原先的 grep -v '/ink/'。
    代码行数    find packages/{shared,core,cli}/src -name '*.ts' -o -name '*.tsx' | xargs wc -l
                （2026-08-11 实测 203,533 行，不含 vendor 进来的 ink fork = packages/tui-renderer）
    测试文件    find tests packages/*/src -name '*.test.ts' -o -name '*.test.tsx' | wc -l（实测 642）
    单测用例    grep -rhoE '\b(it|test)\(' tests packages/*/src --include='*.test.ts' --include='*.test.tsx' | wc -l
                （实测 8,569）
    Hook 事件   packages/core/src/hook/types.ts 的 HookEventName 枚举成员数（实测 32）
    内置工具    sid-code --dump-tools 数组长度（实测 44，与脚本生成的 ref/tools.md 同源同值。
                ⚠️ 此处曾写"60+"，与运行时真值不符 —— website/index.md 早已改对而本文漏改，
                2026-08-10 补齐。写数字前先跑命令，别照抄旧值）
    eval case   bun run eval:list 的汇总行（实测 P0=10 holdout=5 P1=9 P2=6 = 30）
  与 website/index.md 的同一张表须一致，改一处要改两处；README.md（英文主入口）是第三处。
  （2026-08-12 P2-6 前，英文版在 README.en.md、中文是主 README；现在主 README 是英文，
   中文挪到本文 README.zh-CN.md。仍是三处，只是文件名换了。）
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

自研代码采用 **[MIT 许可证](./LICENSE)**。本项目非商业化，不出售、不用于营利。

仓库内的第三方代码各依其自身条款，MIT 无法授予我们本来就不持有的权利。其中一条值得
在这里直接说明：`packages/tui-renderer/`（终端渲染底座）**不是本项目原创** —— 它 fork 自
MIT 许可的 [`ink`](https://github.com/vadimdemedes/ink)，但引入途径是一份第三方快照，
其中携带的修改我们并未获得授权。这部分代码正在被重构掉，上文的代码行数口径已将其排除。

每一个第三方组件的来源、许可条款与我们所做的修改，完整记录在 **[NOTICE](./NOTICE)** ——
分发或再利用本仓代码前，请与 `LICENSE` 一并阅读。如果你是权利人、对本仓中的任何内容
有疑虑，提一个 issue，我们会回应。
