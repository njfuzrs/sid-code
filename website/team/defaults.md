---
title: 团队默认配置分发
description: 用 team-defaults.json 给全团队统一 provider 与默认配置，新人装完即可用。
---

# 团队默认配置分发

新同事装完 sid-code，第一件事是配 provider——填 baseURL、填 key、挑模型，
还得知道 anthropic 族和 openai 族的 `/v1` 规则是相反的。这一步每个人都要走一遍，
每个人都可能配错。

团队默认配置把这一步消掉：你在服务器上放一份 `team-defaults.json`，
新人跑安装脚本时自动拿到，装完直接能用。

::: tip 这页解决的问题
- 新人零配置可用（不用手填 baseURL / key / 模型清单）
- 老用户升级后能拿到后来新增的默认字段，**且不会被覆盖掉自己的配置**
:::

## 快速上手

配置文件就是一份普通的 `settings.json`。以仓库里的模板 `scripts/team-defaults.template.json`
为起点改（网关地址已是占位符，换成你自己的）。下面是节选，模型清单只留了两族各一个：

```json
{
  "model": "ali-deepseek-v4-pro",
  "fallbackModel": "ali-deepseek-v4-flash",
  "fallbackSwitchMode": "ask",
  "autoUpdate": "auto",
  "availableModels": [
    {
      "name": "ali-deepseek-v4-pro",
      "provider": "openai",
      "baseURL": "https://your-gateway.example.com/v1",
      "apiKey": "__YOUR_API_KEY__"
    },
    {
      "name": "claude-sonnet-5",
      "provider": "anthropic",
      "baseURL": "https://your-gateway.example.com",
      "apiKey": "__YOUR_API_KEY__"
    }
  ],
  "language": "zh",
  "permissionMode": "default",
  "subAgentModels": {
    "default": "ali-deepseek-v4-flash",
    "task": "ali-deepseek-v4-pro",
    "verify": "ali-deepseek-v4-pro"
  },
  "quota": { "costLimit": 100 },
  "effortLevel": "max"
}
```

完整模板有 9 个模型，另外还有一段 `"trace": { "enabled": true }`——只开本地轨迹采集，
**不含任何上传配置**：按这份模板分发，轨迹只留在每个人自己的机器上。团队要集中收轨迹，
在 `trace.upload` 里填你们自己的地址与 token，见[轨迹采集与可观测](/team/observability)。

注意两条 `baseURL` 一个带 `/v1` 一个不带——这不是笔误，是[两族协议的相反规则](/start/configure)。
把它固化进团队配置，正是这套机制最直接的价值：这个坑每人只需要踩零次。

推上去：

```bash
./scripts/release.sh --upload-team-defaults /path/to/your/team-defaults.json
```

输出：

```text
>>> 上传团队默认配置 /path/to/your/team-defaults.json ...
✓ team-defaults.json 已更新
```

这个参数**只做上传，不打版本号、不构建二进制**（`scripts/release.sh` 上传完直接
`exit 0`）。所以随时能单独更新团队配置，不影响发版节奏。

## 两条分发路径

配置到用户机器上有两条路，语义完全不同，分清很重要：

| 场景 | 机制 | 语义 |
| --- | --- | --- |
| **首次安装** | 安装脚本 `curl` 拉取后整份 `cp` | 只在 `settings.json` **不存在**时写入 |
| **老用户升级** | 启动时跑一次数据迁移 | 只加**用户没有的**顶层键，绝不覆盖已有值 |

### 首次安装：纯拷贝，绝不覆盖

安装脚本的逻辑（`scripts/install-template.sh`）：

```bash
if [ -f "$SETTINGS_PATH" ]; then
    info "检测到已有配置 ${SETTINGS_PATH}，保留不变"
else
    # curl 拉取 → cp 到 ~/.sid-code/settings.json → chmod 600
fi
```

这里是 bash，**只有"文件不存在才整份拷贝"这一种语义**，做不了 JSON 层面的合并。所以：

- 已有 `settings.json` 的机器：一个字都不动，只打印"保留不变"
- 拉取失败（服务器上没放这个文件）：不报错，提示"首次运行会弹引导向导手动配置"
- 写入后 `chmod 600`，因为里面有 API key

### 老用户升级：只补缺失的顶层键

`sid-code update` 只替换二进制、不碰 `settings.json`。这意味着早期安装的用户
永远拿不到后来新增的团队默认字段（`subAgentModels` / `search` / `trace` / `quota` 这些）。

补这个断层的是启动时的一次数据迁移（`packages/core/src/migrations/backfill-team-defaults.ts`）。
真跑一次看效果——先造一份只有三个键的用户配置：

```json
{
  "model": "my-own-model",
  "availableModels": [
    { "name": "my-own-model", "provider": "openai",
      "baseURL": "https://example.com/v1", "apiKey": "${MY_KEY}" }
  ],
  "quota": {}
}
```

启动后的实际输出：

```text
已补全团队默认配置字段（未覆盖任何已有配置）: fallbackModel, fallbackSwitchMode,
autoUpdate, language, permissionMode, allowedTools, disallowedTools, hooks, mcpServers,
subAgentModels, costLimit, search, disabledSkills, trustProjectExtensions,
allowedDirectories, blockedDirectories, trace, effortLevel
```

补完后核对这份配置，三件事都符合预期：

| 检查项 | 结果 |
| --- | --- |
| `model` 还是 `my-own-model` | ✅ 没被团队默认的模型名覆盖 |
| `availableModels` 还是 1 条，`apiKey` 仍是 `${MY_KEY}` | ✅ **没被塞占位符 key，环境变量占位符也没被展开成明文** |
| `quota` 还是 `{}` | ✅ 空对象算"用户已表态"，不补 |

最后一条最容易误解，单独说。

## "缺失"的判定：只看顶层键是否存在

判定标准就一句：**顶层 key 是否 `in` 用户对象**（`packages/core/src/config/settings/settings.ts`）。
由此推出几条不太直觉但很重要的行为：

- 写成 `"quota": {}`、`"allowedTools": []` 都算**已表态**，不会被补。
  想显式关掉某个团队默认值，就是这么关的。
- 判定**不做嵌套 diff**。已有 `availableModels` 的用户不会被逐模型比对后塞进新模型——
  整块视为已表态。这是刻意的：否则会把 `__YOUR_API_KEY__` 占位符塞进别人能用的配置里。
- 补全读的是**原始 JSON 文本**，不过 Zod round-trip、不展开 env 占位符。
  所以 `availableModels[].apiKey` 这类嵌套字段不会被 strip，`${MY_KEY}` 不会落盘成明文。

### 模板加了新键：只补新加的那几个

补全分两段，记在 `~/.sid-code/state/migrations.json` 里：

- **首次升级**：迁移 v1 把模板里你缺的顶层键全部补上，同时记下当时模板的顶层键集合
  （`teamDefaults.keys`）和内容哈希。
- **之后每次启动**：模板哈希没变就什么都不做；变了，只补「这次模板的键 − 上次记录的键」
  里你缺的那几个，再更新记录。这一段不挂在全局迁移水位线 `migrationVersion` 上，
  所以水位线早就到顶的老用户也照样能拿到。

推论：**用户补全后又主动删掉某个键，下次启动不会被加回来**——它在上次记录的键集合里，
不算「新加的」。删除是一种表态。

一个边界：从没有这份记录的旧版本升级上来时，sid-code 分不清「模板后来才加的键」和
「你自己删掉的键」，所以第一次只把当前模板记为基线、不补任何键。在这之后模板新加的键才会补。

### 单一事实源

模板 `scripts/team-defaults.template.json` 被直接 `import` 进二进制
（`packages/core/src/migrations/backfill-team-defaults.ts`，Bun `--compile` 会内联 JSON），
与安装脚本从服务器拉的那份同源。这样"首装拷贝的"和"升级补全的"不会漂移成两份。

::: warning 一个必须知道的推论
补全用的是**编译进二进制的模板**，不是服务器上那份。所以你用
`--upload-team-defaults` 更新服务器配置后：新装用户立刻拿到新版，
**老用户的补全仍按二进制里的旧模板走**——要让老用户也拿到新字段，需要改
`scripts/team-defaults.template.json` 并发一个新版本。老用户升级后下次启动，
模板里**新加的顶层键**会补进去（只补他们没有的）；已有键的取值变了不会同步，
那种要统一约束的，走 [policy](/team/policy)。
:::

## 常见问题

### 上传了但新人还是没拿到

按顺序查：

```bash
# 1. 服务器上文件真的在吗（这个 URL 就是安装脚本 curl 的那个）
curl -fsS https://www.sid-code.cc/releases/sid-code/team-defaults.json | head -5

# 2. 新人机器上是不是已经有 settings.json 了
ls -l ~/.sid-code/settings.json
```

最常见的原因是第 2 条：机器上已有配置，安装脚本就只打印
"检测到已有配置 …，保留不变"。这不是 bug，是设计——安装脚本无权覆盖别人的配置。
让 TA 备份后删掉重装，或者手工合并。

### 常规发版会不会把仓库里的占位模板推上去覆盖真实配置

不会。`team-defaults.json` 被刻意排除在常规发布流程外（`scripts/release.sh`），
只能通过 `--upload-team-defaults` 显式单独推送。理由正是防止把
`__YOUR_API_KEY__` 这样的占位模板覆盖掉服务器上的真实配置。

同理，服务器端的旧版本清理只删形如 `<path>/<x.y.z>/` 的版本目录，
`install.sh` / `latest.txt` / `team-defaults.json` 不受影响（`scripts/release.sh`）。

### 团队配置里能不能直接放真实 API key

技术上可以（安装脚本会 `chmod 600`），但更稳的做法是放环境变量占位符：

```json
{ "apiKey": "${TEAM_LLM_KEY}" }
```

补全逻辑不展开占位符、原样落盘，所以这样写是安全的。key 本身走你现有的
密钥分发渠道，不进这份会被全团队 `curl` 到的文件。

### 怎么让全员接上企业后端

团队配置里放一行地址，员工各自登录一次：

```json
{ "backend": { "url": "https://<你的后端>/traj" } }
```

```bash
sid-code auth login
sid-code auth status --verify   # 七条通道逐条显示连通结果
```

只填 base，不填任何 `/api/v1/...` 路径。登录、策略、预算、账本、事件、flag、轨迹上传的地址
都由它推出，不需要再配 `SID_CODE_*_ENDPOINT` 或 `analytics.backends`。轨迹上传另需
`trace.upload.token`。这一行必须放在用户级或 managed 配置里，仓库里的
`.sid-code/settings.json` 写了也不生效（防止克隆一个仓库就把设备凭据导到别处）。

### 配置文件损坏了会怎样

补全逻辑读不动 JSON 时**直接抛错并跳过**，绝不覆盖，也不阻塞启动。
启动时会提示一次（TUI 启动横幅；`-p` 模式打在 stderr）：

```text
迁移 backfill-team-defaults (v1) 失败，已跳过、未改动配置：…
修好后下次启动会自动重试。
```

失败的那条迁移不会被记成「已完成」：迁移水位线停在它之前，修好文件后下次启动它会重跑，
补全照常生效。

## 相关

- [配置 LLM Provider](/start/configure) —— 单机怎么配，含 `/v1` 两族规则
- [配额与成本控制](/team/quota) —— 团队配置里的 `quota` 段怎么用
- [企业 policy 与安全边界](/team/policy) —— 团队默认是"默认值"，policy 才是"强制约束"
- [settings.json 字段参考](/ref/settings) —— 全部可用字段
