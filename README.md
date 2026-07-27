# sid-code

**跑在终端的 coding agent。** 你用中文说要干什么，它读你的代码、改文件、跑命令，
然后用真实的编译和测试结果证明改对了没有。

TypeScript + Bun + Ink 自研，编译成单文件二进制分发——下载一个文件就能跑，
不需要装 Node、不需要 `npm install`。

📖 **官方文档：** http://121.196.144.227/
📄 **更新日志：** http://121.196.144.227/releases/sid-code/CHANGELOG.html

---

## 安装

```bash
curl -fsSL http://121.196.144.227/releases/sid-code/install.sh | bash
```

装完直接用：

```bash
sc                    # 启动（推荐）
sid-code --version    # 确认版本
sid-code update       # 以后升级到最新版
```

装不上或 PATH 没生效，见[安装文档](http://121.196.144.227/start/install)。

## 30 秒示例

启动后直接说人话，不需要记命令：

```text
$ sc

› 这个模块的超时配置不生效，查一下为什么

  搜索 timeout 相关实现…
  读取 src/tool/bash.ts:55-80
  定位到：parseEnv 读了环境变量但没传给 spawn 的 timeout 参数
  修改 src/tool/bash.ts
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
| **功能自主可定制** | 60+ 内置工具、32 类 Hook 事件、Skill 与子代理全部可改可扩。发现问题当天能补，不用等官方排期 |
| **深度贴合企业环境** | 内部网关计费、内网 GitLab、MCP 接入、团队默认配置分发，按真实企业内网基建做的适配 |
| **数据全部自主** | 会话轨迹、评测结果、成本账本都留在自己的基础设施里。既是合规前提，也是持续优化的燃料 |

用过 Claude Code 的话迁移成本几乎为零，见[迁移指南](http://121.196.144.227/team/migrate)。

## 现状

| 项 | 现状 |
| --- | --- |
| 自研代码 | `src/` 下 17 万行以上 TypeScript（不含 vendor 的 ink fork） |
| 工程闭环 | 500+ 测试文件、6000+ 单测用例；每次改代码跑全量，全绿才提交 |
| 能力面 | 60+ 内置工具、32 类 Hook 事件、LSP 代码智能、权限门控、可观测轨迹 |
| 评测体系 | 30 个 eval case（含 holdout），发布前跑，防功能回退 |

<!--
  数字口径（发版前人工核对一次，写约数不写精确值）：
    代码行数  find src -name '*.ts' -o -name '*.tsx' | grep -v '/ink/' | xargs wc -l
    单测      grep -rhoE '\b(it|test)\(' tests src --include='*.test.ts' --include='*.test.tsx' | wc -l
    Hook 事件 src/hook/types.ts 的 HookEventName 枚举成员数
    eval case bun run eval:list 的汇总行
  与 website/index.md 的同一张表须一致，改一处要改两处。
-->

## 本地开发

本地是**双版本并存**，两个不同的二进制名，不靠 PATH 优先级区分：

| 命令 | 指向 | 用途 |
| --- | --- | --- |
| `sc` / `sid-code` | `~/.local/bin/sid-code`（线上下载版） | 对照线上行为 |
| `sc-dev` / `sid-code-dev` | 仓库根构建产物 | **验证本地改动** |

```bash
git clone http://gitlab.example.com/zhourusheng/sid-code.git
cd sid-code
bun install
make rebuild          # 重建开发版二进制（版本号不变）
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

内部项目，暂未选定开源许可证。当前仅供团队内部使用。
