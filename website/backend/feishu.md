---
title: 飞书文档授权
description: 让员工的 Agent 以员工本人的飞书权限只读访问飞书云文档：开启条件、怎么分发给员工、三个工具、授权状态与调用审计。
---

# 飞书文档授权

这页写给**部署和运维企业后端的管理员**：怎么让员工在 sid-code 里贴一个飞书文档链接，Agent 就能读到正文。

读文档用的是**员工本人的飞书权限**。员工自己打不开的文档，Agent 也打不开。不需要给机器人开文档权限，也不需要把文档共享给应用。

不用飞书、或者不打算让 Agent 读飞书文档的，这页可以跳过。

## 原理

```text
员工 sid-code login ──飞书授权──▶ 企业后端：加密保存这个人的 user_access_token
                                        │
Agent 调工具 ──设备凭据──▶ 企业后端远程 MCP ──这个人自己的 token──▶ 飞书 OpenAPI
     ▲                                  │
     └────────── 文档正文（只读）───────┘
```

- 员工 `sid-code login` 时，服务端把他的飞书 token 用 `TOKEN_ENC_KEY` 加密存库。
- Agent 调远程 MCP 时带设备凭据。服务端按凭据找到这个人，取他自己的 token 调飞书。
- **token 不离开服务端**，员工机器上没有飞书 token。
- **不使用机器人身份，也不会降级到机器人身份**。任何一步拿不到本人权限，都直接拒绝。
- 注册码设备不绑人，没有「本人权限」，调用一律被拒。

出处：`agent-backend: backend/app/modules/feishu/router/mcp.py`、`service/tools.py`、`service/tokens.py`。

## 联动：配了之后员工那边会怎样

| 你在管理台做了什么 | sid-code 什么时候知道 | 拉取失败时 | 员工看到什么 |
| --- | --- | --- | --- |
| 配好开启条件，发布带飞书 MCP 的插件 | 员工安装插件后，下次启动时连接这个 MCP | 连接被拒（origin 不一致、没登录）时 `/mcp` 里显示原因；服务端没开委托授权返回 503 | Agent 多出三个 `feishu_*` 工具 |
| 员工调用工具 | 每次调用实时取 token，access 快过期时服务端自动刷新 | 拿不到本人权限时返回工具级错误，不是传输错误 | 工具返回的中文提示，见下文「调用结果（outcome）」 |
| 改了 `FEISHU_LOGIN_SCOPE` | 员工下次 `sid-code login` 才带上新 scope | 没重新登录的员工，调用缺 scope 的接口返回「缺授权 scope」 | 「需要补充飞书授权：执行 `sid-code login` 重新授权。…」 |
| 吊销用户 | 立即。设备凭据连带吊销，飞书 token 同时删除 | 下一次调用 401 | MCP 连接失败，提示重新登录 |

## 开启条件

三项都要满足：

| 条件 | 怎么配 | 少了会怎样 |
| --- | --- | --- |
| 飞书登录可用 | 见[部署与配置 · 飞书登录](/backend/deploy#飞书登录) | 远程 MCP 返回 **503** |
| `TOKEN_ENC_KEY` | 见[部署与配置 · 委托授权](/backend/deploy#委托授权) | 登录时 token 用完即弃不落库，远程 MCP 返回 **503**。「飞书授权」页顶部显示「委托授权未启用」 |
| `FEISHU_LOGIN_SCOPE` | 空格分隔，带上 `offline_access` 和文档类 scope | 没有 `offline_access`：飞书不返回 refresh_token，access 过期后只能重新登录（「需重新登录」）。缺文档类 scope：对应工具返回「缺授权 scope」 |

文档类 scope 的确切名字在飞书开发者后台现查：文档读取、知识库读取、文档搜索各一类。另外要在开发者后台打开「刷新 user_access_token」，并**创建版本并发布**，见[部署与配置 · 飞书开发者后台](/backend/deploy#飞书开发者后台)。

::: warning 改了 scope，员工要重新登录
scope 是员工授权那一刻定下的。服务端改了 `FEISHU_LOGIN_SCOPE` 之后，每个员工都要重新 `sid-code login` 一次，新授权才带上新 scope。网页登录管理台也会刷新授权，以最近一次为准。
:::

## 分发给员工

客户端**不会自动连接**这个 MCP。要通过[插件市场](/backend/marketplace)发布一个插件，插件的 `plugin.json` 里写：

```json
"mcpServers": {
  "feishu": {
    "transport": "http",
    "url": "https://agent.example.com/traj/api/v1/ctl/feishu/mcp",
    "auth": "sid-backend"
  }
}
```

- **`url`** 是员工的 `backend.url` 加 `/api/v1/ctl/feishu/mcp`。
- **`transport` 必须写**。只写 `type` 时，管理台组件清单仍显示 `http`，但客户端连不上。
- **`auth: "sid-backend"`** 让客户端把设备凭据注入请求头，每次请求现取，不写进配置。配置里自己写的 `Authorization` 头会被忽略。

::: warning 地址必须和 backend.url 同源
只有 `url` 的 origin（协议 + 主机 + 端口）和员工 `backend.url` **完全一致**，客户端才注入设备凭据。不一致时**直接拒绝连接**，不会「不带凭据照连」，`/mcp` 里显示：

「MCP 服务器 … 声明了 auth:"sid-backend"，但 url 的 origin（…）与 backend.url（…）不一致，拒绝连接以免设备凭据外泄」

所以插件里写死的域名要和员工配置的一样。`http://` 和 `https://`、带不带端口，都算不同 origin。
:::

传输方式：

| transport | 能不能用 |
| --- | --- |
| `http` | 可以，推荐 |
| `http-json` | 可以 |
| `sse` | 客户端允许 `sid-backend` 用它，但这个服务端只做单请求单响应、不开 SSE 流，**不要用** |
| `stdio` / `ws` | 不支持 `sid-backend`，配置时直接报错 |

`auth: "sid-backend"` 的客户端细节见[MCP · 公司后端提供的远程 server](/extend/mcp)。

### 模板插件

后端仓库自带一个模板插件 `feishu-docs`（`plugins/feishu-docs/`），包含上面这段 MCP 配置和一个技能 `read-doc`：员工贴飞书链接时，技能引导 Agent 调 `feishu_doc_read` 读正文，输出标题、目录和要点。

用它上架的步骤：

1. 把 `plugin.json` 里的 `url` 改成你的地址，`version` 按需升级；
2. 在「市场」页登记名称 `feishu-docs`，可见组织选你的组织；
3. 打包上传，见[插件市场 · 打包](/backend/marketplace#打包)；
4. 在版本的组件清单里核对 MCP 一行，应该是 `feishu · http · https://agent.example.com/traj/api/v1/ctl/feishu/mcp · auth=sid-backend`；
5. 写理由发布。

员工执行 `/plugin install feishu-docs@company`，重启后生效。

## 三个工具

全部只读。

| 工具 | 参数 | 返回 | 限制 |
| --- | --- | --- | --- |
| `feishu_doc_read` | `url`：文档链接或 token（必填） | 文档纯文本，外面包一层来源标注 | 只支持新版文档 docx，和知识库里类型为 docx 的页面。超过 `FEISHU_DOC_MAX_CHARS`（默认 60000，最小按 1000 算）的部分截断，并注明全文多少字符 |
| `feishu_doc_search` | `query`：关键词（必填，≤200 字符）；`count`：1–50，默认 10 | 标题、类型、token，不含正文 | **需要开通文档搜索 scope**。只返回员工本人有权限的文档 |
| `feishu_wiki_node` | `url`：知识库链接或节点 token（必填） | 标题、实际文档类型、obj_token、有没有子节点 | 只认 `/wiki/` 链接或节点 token |

链接只认飞书和 Lark 的域名（`feishu.cn`、`larksuite.com`、`larkoffice.com` 及其子域）。裸 token 在 `feishu_doc_read` 里按 docx 处理，在 `feishu_wiki_node` 里按 wiki 节点处理。

旧版文档（`/docs/`）、表格、多维表格、思维笔记、文件都不支持读取，返回「不支持」。

### Agent 里的工具名

插件带的 MCP server 名会加上插件作用域，所以 Agent 里看到的工具名形如：

```text
mcp__plugin_feishu-docs_feishu__feishu_doc_read
mcp__plugin_feishu-docs_feishu__feishu_doc_search
mcp__plugin_feishu-docs_feishu__feishu_wiki_node
```

写权限规则（例如 `permissions.deny`）时用这个全名。插件名或 server 名不同，中间一段跟着变。

## 在管理台里操作

页面在左侧菜单「**飞书授权**」。这页只读，没有要配置的东西，用来看谁授权了、调用结果怎样。

### 授权状态

卡片「**飞书委托授权**」，每个授权过的员工一行：

| 列 | 含义 |
| --- | --- |
| 用户 | 授权的人 |
| 授权 scope | 飞书实际授予的 scope，每个一个标签。缺了文档类 scope 在这里能看出来 |
| 授权时间 | 授权那一刻。快满 365 天时旁边出现红色「快到期」 |
| access 过期 | access token 过期时间。过期后服务端用 refresh token 自动刷新 |
| refresh 过期 | refresh token 过期时间。为空说明授权时没带 `offline_access` |
| 最近刷新 | 最近一次刷新的时间 |
| 刷新次数 | 刷新过几次 |

页面只展示状态，不含任何 token 内容。

::: warning 满 365 天必须重新授权
飞书规定授权从授权时间起满 365 天失效，自动刷新续不了。提前 7 天显示「快到期」，鼠标悬停提示「飞书授权满 365 天必须重新授权，请本人重新 sid-code login」。只有员工本人重新登录才能续，管理员替不了。
:::

刷新失败（refresh token 过期、被轮换、满 365 天、员工离职）时，服务端删掉这个人的授权记录，他在列表里消失，之后调用提示重新登录。

### 调用审计

卡片「**调用审计**」，每次远程 MCP 调用一行：时间 / 用户 / 设备 / 工具 / 文档 token / 结果 / 耗时。

- 可按用户、结果、设备 ID、时间范围（近 1 天 / 近 7 天 / 近 30 天 / 全部）筛选；点设备那一列也会按设备筛选。
- 工具显示为「读文档」「搜文档」「知识库节点」。
- 结果标签后面会跟飞书返回的错误码（如果有）。
- 最多显示最近 500 条。

**只记文档 token，不记文档内容和搜索词。** 搜索调用的「文档 token」一列为空。

### 调用结果（outcome）

员工端看到的提示原文来自服务端，Agent 会照着转述。

| outcome | 页面标签 | 原因 | 员工端提示 | 处理 |
| --- | --- | --- | --- | --- |
| `ok` | 成功 | —— | 文档内容或搜索结果 | —— |
| `forbidden` | 无权限 | 员工本人对这篇文档没有权限 | 「你没有该文档的访问权限（以你本人的飞书权限访问被拒绝）。不要重试。」 | 让文档所有者给他开权限。这是设计，不是故障 |
| `not_found` | 不存在 | 文档不存在或已删除 | 「文档不存在或已被删除。」 | 核对链接 |
| `scope_missing` | 缺授权 scope | 这个人的授权里没有对应 scope | 「需要补充飞书授权：执行 `sid-code login` 重新授权。缺少的权限：…」 | 先确认 `FEISHU_LOGIN_SCOPE` 带了这个 scope、开发者后台已发布，再让员工重新登录 |
| `reauth_required` | 需重新登录 | 还没授权过；token 失效且刷新失败；没有 refresh token；满 365 天；解密失败 | 「飞书授权已失效，请重新执行 `sid-code login`。」或「还没有飞书文档授权，请执行 `sid-code login` 完成飞书授权。」 | 员工重新登录。全员都出现时检查 `TOKEN_ENC_KEY` 是否被换掉（轮换时旧密钥要保留在列表里） |
| `not_logged_in` | 设备未登录 | 设备没绑人，例如注册码设备 | 「这台设备还没有用飞书身份登录，请先执行 `sid-code login`。」 | 在这台机器上用飞书登录。注册码设备用不了飞书工具 |
| `unavailable` | 飞书不可用 | 飞书接口暂时出错，或刷新 token 时遇到临时错误 | 「飞书暂时不可用，请稍后再试。」或「飞书授权服务暂时不可用，请稍后再试。」 | 稍后重试；持续出现看服务日志 |
| `bad_request` | 参数错误 | 链接认不出、搜索词为空或超长，或飞书拒绝了请求 | 例如「无法识别的飞书文档地址。…」「query 不能为空，且不超过 200 字符。」「飞书拒绝了这次请求（错误码 …）。」 | 核对参数；带错误码的去飞书开放平台查 |
| `unsupported` | 不支持 | 不是 docx，例如旧版文档、表格，或知识库节点不是 docx | 例如「暂不支持读取 … 类型（只支持新版文档 docx 与知识库里的 docx）。」 | 目前没有办法，见能力边界 |

这些都是**工具级错误**：HTTP 返回 200，结果里标记失败，Agent 能读到这句话。HTTP 层的错误只有两种：设备凭据无效返回 **401**，委托授权没开启返回 **503**。

### 员工离职

吊销用户时，服务端同时删除他的飞书 token，设备凭据一并吊销，下一次调用 401。见[用户与登录 · 吊销用户](/backend/users#吊销用户-员工离职时)。只吊销设备不会删 token，但这台设备也调不通了。

## 能力边界（如实说）

**1. 只读。** 三个工具都不能创建、修改、评论文档。

**2. 文档内容会进入模型上下文，有提示注入风险。** 文档里可能写着「忽略之前的指令」之类的话。服务端给每次返回的正文包上来源标注，告诉模型这是外部数据不是指令；模板插件的技能里也写了同样的要求。这能降低风险，不能消除。读一篇不熟悉来源的文档后，Agent 再要执行命令时，权限确认仍然要员工自己看。

**3. 只支持 docx。** 旧版文档、表格、多维表格、思维笔记、文件都读不了。

**4. 搜索需要单独开通 scope。** 没开通时 `feishu_doc_search` 返回「缺授权 scope」，读文档不受影响。

**5. 飞书项目（Meego）不支持。** 这里只覆盖云文档和知识库。

**6. 每年要重新授权一次。** 满 365 天的限制来自飞书，服务端续不了。

## 常见问题

### 员工的 `/mcp` 里显示 origin 不一致

插件里写的地址和员工的 `backend.url` 不同源。常见于插件写 `https://agent.example.com`，员工配了带端口或 `http://` 的地址。改插件地址并发布新版本，或者统一员工的 `backend.url`。

### 员工说 Agent 读不到一篇他自己能打开的文档

看「调用审计」里那次调用的结果：

- 「缺授权 scope」：他授权时 scope 不全，重新登录；
- 「不支持」：文档不是新版 docx；
- 「无权限」：用的是他本人权限，再确认一下他用的是不是同一个飞书账号。

### 列表里某人的「refresh 过期」是空的

他授权时 `FEISHU_LOGIN_SCOPE` 里还没有 `offline_access`。access 过期后他每次都要重新登录。确认配置后让他重新 `sid-code login`。

### 能不能用机器人身份读全公司的文档

不能，这是有意的设计。机器人身份会让 Agent 读到员工本人看不到的文档，权限边界就没了。

## 相关

- [插件市场](/backend/marketplace) —— 发布带飞书 MCP 的插件
- [MCP · 公司后端提供的远程 server](/extend/mcp) —— `auth: "sid-backend"` 的客户端细节
- [部署与配置 · 委托授权](/backend/deploy#委托授权) —— `TOKEN_ENC_KEY`、`FEISHU_DOC_MAX_CHARS`
- [用户与登录](/backend/users) —— 吊销用户会同时删除飞书 token
