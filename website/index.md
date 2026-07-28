---
layout: home
title: sid-code
titleTemplate: 长在企业研发环境里的 coding agent

hero:
  name: sid-code
  text: 长在企业研发环境里的 coding agent
  tagline: 终端里说人话，它读代码、改文件、跑命令，用真实的编译与测试结果证明改对了。而模型你选、harness 你改、内网它进得去、数据一行不外流——这四条，闭源产品结构上给不了。
  image:
    src: /favicon.svg
    alt: sid-code
  actions:
    - theme: brand
      text: 快速开始
      link: /start/
    - theme: alt
      text: 安装
      link: /start/install
    - theme: alt
      text: 更新日志
      link: /changelog

features:
  - title: 多 provider 可插拔
    details: Anthropic / OpenAI / Ollama 三族协议同时在线。公司自建网关、Azure、本地离线模型都能接，主模型跑不动还能自动降级到备用模型。换模型是改一行配置，不是换一个工具。
    link: /start/configure
    linkText: 配置 provider
  - title: 功能自主可定制
    details: 44 个内置工具、32 类 Hook 事件、Skill 与子代理，全部开源可改可扩。你的团队有什么怪规矩，就往里写什么规矩——今天发现的问题今天补上。
    link: /extend/
    linkText: 扩展方式总览
  - title: 深度贴合企业开发环境
    details: 内部网关计费、内网 GitLab、MCP 接入、团队默认配置一键分发。这些是按真实企业内网基建一条条适配出来的，不是拿通用能力硬凑。
    link: /team/defaults
    linkText: 企业与团队
  - title: 数据全部自主
    details: 会话轨迹、评测结果、成本账本全部落在你自己的基础设施里。既是过合规的前提，也是持续优化的燃料——数据在自己手上，才谈得上迭代。
    link: /team/observability
    linkText: 轨迹与可观测
---

## 一分钟装上

```bash
curl -fsSL http://121.196.144.227/releases/sid-code/install.sh | bash
```

装完直接启动：

```bash
sc                    # 启动（推荐）
sid-code --version    # 确认版本
```

装不上或 PATH 没生效，[安装页](/start/install)列了三类最常见失败的原样报错与处理。

## 它现在做到了什么程度

<!--
  数字口径（§4.7 决策：不做自动生成，发版前人工核对一次，写约数不写精确值）：
    自研代码行数  find src -name '*.ts' -o -name '*.tsx' | grep -v '/ink/' | xargs wc -l
                  （2026-07-27 实测 176,887 行，不含 vendor 进来的 ink fork）
    单测          grep -rhoE '\b(it|test)\(' tests src --include='*.test.ts' --include='*.test.tsx' | wc -l
                  （实测 6,583 个用例 / 520 个测试文件）
    Hook 事件数   src/hook/types.ts 的 HookEventName 枚举成员数（实测 32）
    内置工具数    sid-code --dump-tools | bun -e '...' 数组长度（2026-07-27 实测 44，与
                  脚本生成的 ref/tools.md 同源同值。此前写"60+"与运行时真值不符，已改）
    eval case     bun run eval:list 的汇总行（2026-07-27 实测 P0=10 holdout=5 P1=9 P2=6 = 30）
  改这组数字前先跑上面的命令，不要凭记忆改。
-->

| 项 | 现状 |
| --- | --- |
| 自研代码 | `src/` 下 17 万行以上 TypeScript（不含 vendor 的 ink fork） |
| 工程闭环 | 500+ 测试文件、6000+ 单测用例；每次改代码跑全量，全绿才提交 |
| 能力面 | 44 个内置工具、32 类 Hook 事件、LSP 代码智能、权限门控、可观测轨迹 |
| 评测体系 | 30 个 eval case（含 holdout），发布前跑，防功能回退 |

这些数字不是为了好看——它们是"这东西真在跑、有人天天用"的证据。能力边界与还没做完的部分，
文档里会直接写明，不含糊。

## 和 Claude Code 的关系

功能面对标 Claude Code：agentic loop、工具调用、权限门控、Hook、Skill、MCP 都有对应实现，
用过 cc 的人几乎零迁移成本（见[迁移指南](/team/migrate)）。

差别在上面那四条——它们不是"做得更好"，而是**闭源商业产品结构上给不了**：
模型绑死一家、harness 改不了、进不了企业内网、数据不在你手里。
自研是同时拿到这四样的唯一路径。
