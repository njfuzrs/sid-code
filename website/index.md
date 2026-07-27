---
layout: home
title: sid-code
titleTemplate: 跑在终端的 coding agent

hero:
  name: sid-code
  text: 跑在终端的 coding agent
  tagline: 你在终端里说人话，它读你的代码、改文件、跑命令，并用真实的测试结果证明改对了。
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
    details: Anthropic / OpenAI / Ollama 三族协议，公司自建网关、Azure、本地离线模型都能接。换模型是改配置，不是换工具。
    link: /start/configure
    linkText: 配置 provider
  - title: 功能自主可定制
    details: 60+ 内置工具、32 类 Hook 事件、Skill 与子代理全部可改可扩。发现问题当天就能补，不必等官方排期。
    link: /extend/
    linkText: 扩展方式总览
  - title: 深度贴合企业开发环境
    details: 内部网关计费、内网 GitLab、MCP 接入、团队默认配置分发——都是按真实企业内网基建做的适配，不是通用能力凑合。
    link: /team/defaults
    linkText: 企业与团队
  - title: 数据全部自主
    details: 会话轨迹、评测结果、成本账本都留在自己的基础设施里。这既是合规前提，也是持续优化的燃料。
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
    内置工具数    以 sid-code --dump-tools 为准（T-3.2 就绪后改用运行时真值）
    eval case     bun run eval:list 的汇总行
  改这组数字前先跑上面的命令，不要凭记忆改。
-->

| 项 | 现状 |
| --- | --- |
| 自研代码 | `src/` 下 17 万行以上 TypeScript（不含 vendor 的 ink fork） |
| 工程闭环 | 500+ 测试文件、6000+ 单测用例；每次改代码跑全量，全绿才提交 |
| 能力面 | 60+ 内置工具、32 类 Hook 事件、LSP 代码智能、权限门控、可观测轨迹 |
| 评测体系 | 30 个 eval case（含 holdout），发布前跑，防功能回退 |

这些数字不是为了好看——它们是"这东西真在跑、有人天天用"的证据。能力边界与还没做完的部分，
文档里会直接写明，不含糊。

## 和 Claude Code 的关系

功能面对标 Claude Code：agentic loop、工具调用、权限门控、Hook、Skill、MCP 都有对应实现，
用过 cc 的人几乎零迁移成本（见[迁移指南](/team/migrate)）。

差别在上面那四条——它们不是"做得更好"，而是**闭源商业产品结构上给不了**：
模型绑死一家、harness 改不了、进不了企业内网、数据不在你手里。
自研是同时拿到这四样的唯一路径。
