---
title: 配置 LLM Provider
description: anthropic / openai / ollama 三族协议各一份可直接粘的 settings.json，含 base_url 的 /v1 两族相反规则。
---

# 配置 LLM Provider

sid-code 自己不带模型，你得告诉它去哪调、用什么 key。这页给三族协议各一份**可直接粘**的配置。

先读一句最省事的：**这里有一个 `base_url` 要不要带 `/v1` 的坑，两族协议的规则正好相反，
配错会 404**。它是新手最大的卡点，所以放在最前面讲。

## 快速上手

配置文件是 `~/.sid-code/settings.json`。没有就新建：

```bash
mkdir -p ~/.sid-code
$EDITOR ~/.sid-code/settings.json
```

粘这份（OpenAI 兼容端点，最常见的情况）：

```json
{
  "model": "gpt-5.4",
  "availableModels": [
    {
      "name": "gpt-5.4",
      "provider": "openai",
      "base_url": "https://your-gateway.example.com/v1",
      "api_key": "sk-你的key"
    }
  ]
}
```

存盘后立刻验一次——**别靠启动 sid-code 来验，用这个专门的诊断命令**：

```bash
sid-code auth status
```

配对了会输出（真实输出，地址与 key 已脱敏）：

```text
认证状态:

  Provider:     openai
  主模型:       glm-5.2
  API Key:      ✓ 已配置  sk-R…Ykle（长度 51）
  Key 来源:     模型级 (available_models[].apiKey)
  baseURL:      https://your-gateway.example.com/v1
  经由网关:     是

  available_models（共 11 个）:
    - gpt-5.4  provider=openai  key=✓
    - claude-sonnet-5  provider=anthropic  key=✓
```

看三行就够：`API Key` 是不是 `✓`、`baseURL` 对不对、`Provider` 对不对。

## ⚠️ base_url 的 `/v1`：两族规则相反

**这是团队真踩过的坑，也是新手第一大卡点。** 记一句话：

::: danger 一句话规则
**anthropic 族的 `base_url` 不带 `/v1`，openai 族的 `base_url` 带 `/v1`。**
:::

原因是两边的 SDK 自己会拼路径，拼的东西不一样：

| provider | 你写的 `base_url` | SDK 自己拼上 | 最终请求 |
| --- | --- | --- | --- |
| `anthropic` | `https://gw.example.com` | `/v1/messages` | `https://gw.example.com/v1/messages` ✅ |
| `openai` | `https://gw.example.com/v1` | `/chat/completions` | `https://gw.example.com/v1/chat/completions` ✅ |

所以同一个网关地址，配 anthropic 模型和配 openai 模型，`base_url` 写法就是不一样的——
**这不是笔误，是两族 SDK 的既定行为**。团队默认配置里两种写法并存，就是这个道理：

```json
{
  "availableModels": [
    { "name": "gpt-5.4",         "provider": "openai",    "base_url": "https://gw.example.com/v1" },
    { "name": "claude-sonnet-5", "provider": "anthropic", "base_url": "https://gw.example.com"    }
  ]
}
```

### 配错了长什么样

**anthropic 族多写了 `/v1`** → 路径被拼成 `/v1/v1/messages`：

```text
✗ Anthropic 请求异常 model=claude-sonnet-5 err=404
  {"error":{"message":"Invalid URL (POST /v1/v1/messages)","type":"invalid_request_error"}}
```

注意报错里那个显眼的 `/v1/v1/` —— 看到双 `v1` 就是这个问题，把 `base_url` 末尾的 `/v1` 删掉。

**openai 族漏写了 `/v1`** → 请求打到了网关的网页首页上，更阴：

```text
✗ OpenAI 响应 Content-Type=text/html; charset=utf-8（非 SSE，疑似网关错误页）
  model=glm-5.2 body=<!doctype html> <html lang="en"> ...
```

这个方向不报 404，而是拿回一个 **HTTP 200 的 HTML 页面**。
sid-code 会识别出"Content-Type 不是 event-stream，这是伪装成成功的错误页"并终止，
但如果不知道这条规则，看到一堆 `<!doctype html>` 是会懵的。解法：`base_url` 末尾补上 `/v1`。

::: warning 为什么不能靠"能启动"来判断配对了
两种配错都**不阻碍启动**——sid-code 照样进 TUI，输入框照样能打字，
问题要等你发第一条消息才炸，而且中间还夹着 11 次重试和 fallback 切换，报错会被冲得很远。
所以配完永远先跑一次 `sid-code auth status`，别等发消息。
:::

## 三族协议各一份完整配置

### openai 族（含各家 OpenAI 兼容网关）

覆盖面最广：OpenAI 官方、DeepSeek、通义千问、GLM、Kimi、公司自建网关、
以及任何声称"兼容 OpenAI 协议"的服务。

```json
{
  "model": "gpt-5.4",
  "fallbackModel": "deepseek-chat",
  "availableModels": [
    {
      "name": "gpt-5.4",
      "provider": "openai",
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-你的key"
    },
    {
      "name": "deepseek-chat",
      "provider": "openai",
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "sk-另一个key"
    }
  ]
}
```

`base_url` **带 `/v1`**。留空则默认 `https://api.openai.com/v1`。

### anthropic 族

```json
{
  "model": "claude-sonnet-5",
  "availableModels": [
    {
      "name": "claude-sonnet-5",
      "provider": "anthropic",
      "base_url": "https://api.anthropic.com",
      "api_key": "sk-ant-你的key"
    }
  ]
}
```

`base_url` **不带 `/v1`**。用官方端点时这行可以整个省掉，默认就是 `https://api.anthropic.com`。

### ollama（本地，不需要 key）

先确认 ollama 在跑：

```bash
ollama serve                 # 另开一个终端
ollama pull qwen2.5-coder    # 拉个模型
curl http://localhost:11434/v1/models   # 确认端口活着
```

```json
{
  "model": "qwen2.5-coder",
  "availableModels": [
    {
      "name": "qwen2.5-coder",
      "provider": "ollama",
      "base_url": "http://localhost:11434/v1"
    }
  ]
}
```

`api_key` 可以整个不写。`base_url` 留空默认就是 `http://localhost:11434/v1`
（ollama 走的是 OpenAI 兼容层，所以**带 `/v1`**）。

::: tip 本地小模型的实际体验
sid-code 的循环要求模型能稳定输出结构化 tool call。7B 级别的模型经常在这一步崩
（漏字段、格式跑偏、反复重试），表现会明显差于云端模型。
本地模型适合断网/涉密场景兜底，不建议当日常主力。
:::

## 详细说明

### 配置写在哪、谁盖谁

| 位置 | 作用范围 | 典型用途 |
| --- | --- | --- |
| `~/.sid-code/settings.json` | 你这台机器所有项目 | 放 API Key 和模型清单 |
| `<项目>/.sid-code/settings.json` | 单个项目，可提交进仓库 | 团队共享的项目级约定 |
| `<项目>/.sid-code/settings.local.json` | 单个项目，不提交 | 个人临时覆盖 |
| 环境变量 | 当前 shell | 临时试一下，见下 |
| 命令行参数 | 单次运行 | `--model` / `--provider` |

后面的盖前面的。**API Key 只放用户级那份**，别写进项目里跟着 git 提交出去。

### 用环境变量临时试

不想改文件，先试一把：

```bash
export OPENAI_API_KEY="sk-你的key"
export SID_CODE_LLM_BASE_URL="https://your-gateway.example.com/v1"
sid-code auth status
```

注意优先级：**模型条目里的 `base_url` 比环境变量优先**。
两边都配了且不一致时，sid-code 会打印一条告警告诉你哪个生效了——
看到"环境变量 baseURL 被模型 xxx 的 base_url 覆盖"就是这个。

### 字段名两种写法都收

`availableModels` 数组里的字段，snake_case 和 camelCase 都认：

| 推荐写法 | 也接受 |
| --- | --- |
| `base_url` | `baseURL` |
| `api_key` | `apiKey` |

本页统一用 snake_case，跟团队默认配置一致。

### 配多个模型的好处

`availableModels` 是清单，配了多个之后：

- `/model` 可以在会话里随时切，不用重启
- `fallbackModel` 在主模型挂掉/限流时自动接上
- 子代理可以按类型分不同档位的模型，省钱（见[子代理](/extend/subagents)）

### 手工编辑之外的路子

第一次启动时如果检测到没有任何模型配置，TUI 会弹出一个分步引导对话框
（选 provider → 填 base URL → 填模型名 → 填 key），完成后自动写进
`~/.sid-code/settings.json`。想手动改配置就用本页的做法，两条路等价。

## 常见问题

### 报"未设置 API Key"，但我明明配了

按这个顺序查：

```bash
# 1. JSON 格式对不对（多一个逗号就整份失效）
cat ~/.sid-code/settings.json | bun -e 'JSON.parse(await Bun.stdin.text()); console.log("JSON OK")'

# 2. sid-code 到底读到了什么
sid-code auth status
```

`auth status` 里的 `Key 来源` 那行会告诉你 key 是从模型条目、顶层字段还是环境变量来的。
不是你预期的来源，就是被优先级更高的地方盖掉了。

还有一种情况：配置里的 key 还是模板占位符（`__YOUR_API_KEY__` 这种）。
sid-code 会把它当"没配"处理并报错，不会拿占位符去发请求。

### 报 `model_not_found` / `Invalid model`

模型名的唯一权威是**你的 provider**，不是 sid-code。sid-code 原样把
`name` 字段发出去。所以先跟服务端要一份准确的模型名：

```bash
# openai 族通用
curl -s https://your-gateway.example.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY" | head -40
```

网关上的名字经常跟官方不一样（带前缀、带日期后缀），照抄网关返回的那个。

### 改了配置没生效

`~/.sid-code/settings.json` 在**启动时**读一次。改完重启 sid-code，
或者用 `/model` 在会话里热切。

### 一直在重试然后失败

日志里出现 `[FALLBACK] 连接阶段尝试 1/11` 这种，说明请求确实发出去了但被拒。
先用上面的 `/v1` 规则对一遍 `base_url`，再确认 key 和网络（网关在内网的话要连 VPN）。

## 相关

- [跑通第一个任务](/start/first-task) —— 配好了就去跑一个真实任务
- [settings.json 字段](/ref/settings) —— 全部字段的类型与默认值
- [环境变量](/ref/env) —— 全部环境变量
- [成本与用量](/use/cost) —— 配好之后怎么看花了多少钱
- [排障](/use/troubleshooting) —— 按症状索引的错误表
