---
layout: home
title: sid-code
titleTemplate: 长在企业研发环境里的 coding agent

hero:
  name: sid-code
  text: 长在企业研发环境里的 coding agent
  tagline: 模型你选、harness 你改、内网它进得去、数据一行不外流。这四条，闭源 coding agent 结构上给不了。
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
    # 第三个按钮给博客而不是更新日志：首页访客的两类真实意图是「装上试试」
    # 和「先判断这东西靠不靠谱」，后者要看的是机制解析与实测数据，不是版本变更列表。
    # 更新日志是老用户的入口，顶栏有它自己的位置，不占首页这个稀缺的按钮位。
    - theme: alt
      text: 博客
      link: /blog/

features:
  # ⚠ 这四张卡对应 tagline 里那四条差异，一一对应，别单独增删一张。
  # 博客不进这里：卡片区在回答「它凭什么值得用」，博客是内容层不是能力项。
  # 它的曝光走顶栏独立 Tab + 下方「为什么这么设计」段落。
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
    linkText: 团队部署
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

## 为什么这么设计

<!--
  这一段是博客的首页入口。它刻意**不做成 features 卡片**：
  卡片区回答「它凭什么值得用」（能力面），博客是内容层，混进去会让四条差异被稀释。
  放在页尾也是有意的——先让读者知道这是什么、能不能装上，再邀请他往深里读。
-->

上面这些是结论。**结论怎么来的、实测数字是多少、哪里还没做完**，写在[博客](/blog/)里。

那里不放版本资讯（版本变更去[更新日志](/changelog)），只放把单个机制拆开讲透的长文：
实现指到源码位置、数据来自真实会话轨迹、能力边界照实写。
想先挑一篇：[JIT 上下文——让规则在正确的时刻进入上下文](/blog/jit-context)，
讲的是「你写的规则凭什么在这一轮进入上下文」，附 19 个会话的实测基线。
