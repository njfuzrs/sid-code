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
为起点改（下面把内网网关地址换成了占位值）：

```json
{
  "model": "deepseek-v4-pro",
  "fallbackModel": "deepseek-v4-flash",
  "fallbackSwitchMode": "ask",
  "availableModels": [
    {
      "name": "deepseek-v4-pro",
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
    "default": "deepseek-v4-flash",
    "task": "deepseek-v4-pro",
    "verify": "deepseek-v4-pro"
  },
  "quota": { "costLimit": 100 },
  "effortLevel": "max"
}
```

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

这个参数**只做上传，不打版本号、不构建二进制**（`scripts/release.sh:196-206` 上传完直接
`exit 0`）。所以随时能单独更新团队配置，不影响发版节奏。

## 两条分发路径

配置到用户机器上有两条路，语义完全不同，分清很重要：

| 场景 | 机制 | 语义 |
| --- | --- | --- |
| **首次安装** | 安装脚本 `curl` 拉取后整份 `cp` | 只在 `settings.json` **不存在**时写入 |
| **老用户升级** | 启动时跑一次数据迁移 | 只加**用户没有的**顶层键，绝不覆盖已有值 |

### 首次安装：纯拷贝，绝不覆盖

安装脚本的逻辑（`scripts/install-template.sh:302-313`）：

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

补这个断层的是启动时的一次数据迁移（`src/migrations/backfill-team-defaults.ts`）。
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
language, permissionMode, allowedTools, disallowedTools, hooks, mcpServers,
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

判定标准就一句：**顶层 key 是否 `in` 用户对象**（`src/config/settings/settings.ts:391-397`）。
由此推出几条不太直觉但很重要的行为：

- 写成 `"quota": {}`、`"allowedTools": []` 都算**已表态**，不会被补。
  想显式关掉某个团队默认值，就是这么关的。
- 判定**不做嵌套 diff**。已有 `availableModels` 的用户不会被逐模型比对后塞进新模型——
  整块视为已表态。这是刻意的：否则会把 `__YOUR_API_KEY__` 占位符塞进别人能用的配置里。
- 补全读的是**原始 JSON 文本**，不过 Zod round-trip、不展开 env 占位符。
  所以 `availableModels[].apiKey` 这类嵌套字段不会被 strip，`${MY_KEY}` 不会落盘成明文。

### 只补一次

幂等靠迁移水位线保证：`~/.sid-code/state/migrations.json` 里的 `migrationVersion`
（`src/migrations/runner.ts:38-46`）。实测水位线从 `0` 走到 `1` 后，再启动不会重复补。

推论：**用户补全后又主动删掉某个键，下次启动不会被加回来。**
这正是期望行为——删除是一种表态。

### 单一事实源

模板 `scripts/team-defaults.template.json` 被直接 `import` 进二进制
（`src/migrations/backfill-team-defaults.ts:20`，Bun `--compile` 会内联 JSON），
与安装脚本从服务器拉的那份同源。这样"首装拷贝的"和"升级补全的"不会漂移成两份。

::: warning 一个必须知道的推论
补全用的是**编译进二进制的模板**，不是服务器上那份。所以你用
`--upload-team-defaults` 更新服务器配置后：新装用户立刻拿到新版，
**老用户的补全仍按二进制里的旧模板走**——要让老用户也拿到新字段，需要改
`scripts/team-defaults.template.json` 并发一个新版本。
:::

## 常见问题

### 上传了但新人还是没拿到

按顺序查：

```bash
# 1. 服务器上文件真的在吗（这个 URL 就是安装脚本 curl 的那个）
curl -fsS http://121.196.144.227/releases/sid-code/team-defaults.json | head -5

# 2. 新人机器上是不是已经有 settings.json 了
ls -l ~/.sid-code/settings.json
```

最常见的原因是第 2 条：机器上已有配置，安装脚本就只打印
"检测到已有配置 …，保留不变"。这不是 bug，是设计——安装脚本无权覆盖别人的配置。
让 TA 备份后删掉重装，或者手工合并。

### 常规发版会不会把仓库里的占位模板推上去覆盖真实配置

不会。`team-defaults.json` 被刻意排除在常规发布流程外（`scripts/release.sh:55-56`），
只能通过 `--upload-team-defaults` 显式单独推送。理由正是防止把
`__YOUR_API_KEY__` 这样的占位模板覆盖掉服务器上的真实配置。

同理，服务器端的旧版本清理只删形如 `<path>/<x.y.z>/` 的版本目录，
`install.sh` / `latest.txt` / `team-defaults.json` 不受影响（`scripts/release.sh:460`）。

### 团队配置里能不能直接放真实 API key

技术上可以（安装脚本会 `chmod 600`），但更稳的做法是放环境变量占位符：

```json
{ "apiKey": "${TEAM_LLM_KEY}" }
```

补全逻辑不展开占位符、原样落盘，所以这样写是安全的。key 本身走你现有的
密钥分发渠道，不进这份会被全团队 `curl` 到的文件。

### 配置文件损坏了会怎样

补全逻辑读不动 JSON 时**直接抛错并跳过**，绝不覆盖（`settings.ts:386-389`）。
迁移 runner 记一条警告继续启动（`src/migrations/runner.ts:91-95`），不阻塞。
你会在日志里看到 `⚠️ 迁移 backfill-team-defaults (v1) 失败`。

## 相关

- [配置 LLM Provider](/start/configure) —— 单机怎么配，含 `/v1` 两族规则
- [配额与成本控制](/team/quota) —— 团队配置里的 `quota` 段怎么用
- [企业 policy 与安全边界](/team/policy) —— 团队默认是"默认值"，policy 才是"强制约束"
- [settings.json 字段参考](/ref/settings) —— 全部可用字段
