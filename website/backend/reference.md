---
title: 接口、鉴权与枚举
description: 企业后端的四种鉴权方式、员工端会请求的全部路由、管理接口的模块前缀、状态码总表、枚举和硬编码上限。
---

# 接口、鉴权与枚举

这页写给**部署运维和写脚本对接后端的人**，是查表用的，不按顺序读。管理员日常用管理台，不需要这页。

需要某个接口的完整参数时，在你自己部署的本地或内网实例上打开 `http://127.0.0.1:8900/docs`（FastAPI 自带，SQLite 实例默认开启，PostgreSQL 实例由 `API_DOCS_ENABLED` 控制，见[部署与配置](/backend/deploy#数据库与存储)）。本页不链接任何线上 OpenAPI。

## 四种鉴权方式

| 方式 | 怎么带 | 谁用 | 能访问 |
| --- | --- | --- | --- |
| 管理台会话 | HttpOnly cookie，飞书登录或口令应急登录后签发，8 小时有效 | 浏览器里的管理台 | 全部管理接口。member 一律 403 |
| HTTP Basic | `Authorization: Basic`，用户名 `AUTH_USERNAME`、口令 `AUTH_PASSWORD` | 运维脚本、curl | **只有**轨迹、统计、导出这几类数据面读接口。用户、设备、策略等管理接口不认 Basic |
| 上传口令 | `X-Upload-Token: <UPLOAD_TOKEN>` | 员工端轨迹上传 | 只有 `/upload/*` |
| 设备凭据 | `Authorization: Bearer <设备凭据>` | 员工的 sid-code | `/ctl/*`、`/events`、`/usage/ledger`、`/auth/cli/logout` |

两个例外：

- `POST /ctl/enroll` 不带凭据，凭**注册码**换设备凭据；服务端没开 `CTL_ENROLL_ENABLED` 时返回 403。
- `GET /ctl/flags` **不鉴权**，任何人都能读。所以 Flag 里不能放敏感内容，也不能用来放宽限制，见 [Feature Flag](/backend/flags)。

**为什么控制面和数据面不共用凭据**：上传口令是全员共享的一串字符，泄露的代价只是「有人能往后端塞轨迹」；设备凭据一机一份、绑人、能单独吊销，所以用来鉴权下发策略、预算、插件这些会改变员工机器行为的接口。两条链互不引用：拿上传口令访问不了 `/ctl/*`，拿设备凭据也传不了轨迹。

## 员工端会请求的路由

此表与 sid-code 的契约快照 `packages/core/tests/fixtures/backend-paths.json` 同步，两边任何一处改了路由，测试都会失败。全部挂在 `backend.url` + `/api/v1` 下。

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| GET | `/auth/feishu/cli/start` | 无（PKCE） | `sid-code login` 打开的飞书授权入口 |
| POST | `/auth/cli/exchange` | 一次性登录码 + PKCE | 换设备凭据 |
| POST | `/auth/cli/logout` | 设备凭据 | `sid-code logout`，解绑设备 |
| POST | `/ctl/enroll` | 注册码 | `sid-code auth enroll` |
| GET | `/ctl/whoami` | 设备凭据 | 校验凭据、同步过期时间 |
| GET | `/ctl/policy` | 设备凭据 | 拉策略 |
| GET | `/ctl/budget` | 设备凭据 | 拉预算 |
| GET | `/ctl/flags` | 无 | 拉 Flag |
| POST | `/events` | 设备凭据 | 事件批量上报 |
| POST | `/usage/ledger` | 设备凭据 | 用量账本 |
| POST | `/upload/session-file` | 上传口令 | 轨迹上传 |
| GET | `/health` | 无 | 健康检查 |
| GET | `/ctl/marketplace/index` | 设备凭据 | 企业插件市场索引 |
| GET | `/ctl/marketplace/artifacts/{name}/{version}` | 设备凭据 | 下载插件包 |

另外两条不在快照里、由插件或启动参数决定是否使用：

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| POST | `/ctl/feishu/mcp` | 设备凭据 | 飞书文档远程 MCP，见[飞书文档授权](/backend/feishu) |
| POST | `/ctl/bridge/sessions` | 设备凭据 | 遥控会话配对，见[遥控](/backend/bridge) |

## 管理接口

全部要求管理台会话（admin），按模块列前缀，不逐条列参数。

| 前缀 | 模块 | 用途 |
| --- | --- | --- |
| `/auth/*` | 登录 | 飞书登录、口令登录、登出、`/auth/options`（前端用来决定显示哪些登录方式） |
| `/users` | 用户 | 列表、改角色、吊销 / 恢复、登录审计 |
| `/identity` | 设备、组织与团队 | 组织、团队、设备列表、调整归属、吊销设备、注册码、变更审计 |
| `/policies` | 策略 | 增删改、启停、`evaluate`（预览命中）、`upper`（上层配置）、审计 |
| `/budgets` | 预算 | 同上 |
| `/usage/ledger` | 成本 | 按人、按设备、会话明细 |
| `/flags` | Feature Flag | 增删改、启停、审计 |
| `/events` | 审计 | 事件统计与明细 |
| `/trajectories`、`/stats`、`/export` | 轨迹 | 列表、详情、标注、仪表盘、导出。这三类也接受 HTTP Basic |
| `/marketplace` | 插件市场 | 条目、版本、上传、发布、下架、CI 上传凭据 |
| `/feishu` | 飞书授权 | 授权状态、调用审计 |
| `/bridge/sessions` | 遥控 | 在线会话、审批、发消息、断开 |

`GET /api/v1/ready` 是给本机做就绪检查的，生产 Nginx 应对外屏蔽，见[部署与配置](/backend/deploy#生产部署)。

## 状态码总表

| 状态码 | 在本系统里的含义 |
| --- | --- |
| 200 / 201 | 成功；201 是新建 |
| 202 | 事件批次已接收（`/events`） |
| 204 | 没有配置。`/ctl/policy`、`/ctl/budget` 返回 204 表示三层都没有生效配置，客户端按「没有远程配置」处理 |
| 304 | 内容没变（带 ETag 的拉取） |
| 400 | 请求体不是合法 JSON，或员工端登录码无效 |
| 401 | 没有凭据、凭据错误、凭据过期或已吊销、会话过期、注册码无效（不区分原因） |
| 403 | 管理台：当前用户是 member。员工端：注册端点未开启；CI 上传凭据调了上传以外的接口 |
| 404 | 对象不存在；引用的组织 / 团队 / 设备不存在；插件条目对这台设备不可见或仍是草稿（两者不区分）；口令登录已关闭 |
| 409 | 冲突：ID 已存在、同层同周期已有生效配置、插件版本已存在、设备已绑给另一个人、不能降级或吊销自己 |
| 410 | 插件版本已下架 |
| 413 | 请求体超过上限（账本 16 KiB、事件 2 MiB、插件包 20 MiB） |
| 422 | 字段校验失败：格式、取值、必填理由为空、Flag 出现禁用词 |
| 500 | 服务端异常；遥控未配 `BRIDGE_WS_PUBLIC_URL` |
| 503 | 依赖未配置：飞书登录三项不齐、`TOKEN_ENC_KEY` 未配（飞书 MCP） |

## 硬编码上限

| 项 | 值 | 能否配置 |
| --- | --- | --- |
| 管理台会话 | 8 小时 | 否 |
| 飞书 OAuth state | 10 分钟 | 否 |
| CLI 一次性登录码 | 60 秒 | 否 |
| 员工端等待浏览器授权 | 5 分钟 | 否 |
| 设备凭据 | 90 天，滑动续期 | `CTL_CREDENTIAL_TTL_DAYS` |
| 注册码 | 24 小时，一次有效 | `CTL_ENROLL_CODE_TTL_HOURS` |
| 事件：每批条数 | 500 | 否 |
| 事件：每批大小 | 2 MiB | 否 |
| 事件：metadata 键数 | 64 | 否 |
| 事件：单个字符串值 | 1024 字符，超出**截断**并打标记，不拒绝 | 否 |
| 账本：单条 | 16 KiB | 否 |
| 插件包：压缩后 | 20 MiB | 否 |
| 插件包：解压后 | 100 MiB | 否 |
| 插件包：条目数 | 2000 | 否 |
| 插件包：`plugin.json` 等单个配置文件 | 1 MiB | 否 |
| 插件名 | 最长 64 | 否 |
| 遥控：每组织在线会话 | 50 | 否 |
| 遥控：会话有效期 | 8 小时 | 否 |
| 飞书文档读取截断 | 60000 字符 | `FEISHU_DOC_MAX_CHARS` |

## 枚举

按模块列出接口和管理台里出现的取值。界面上显示的是括号外的中文，接口和数据库里存的是代码值。

### 身份

| 枚举 | 取值 |
| --- | --- |
| 用户角色 | `admin` / `member` |
| 用户状态 | `active`（正常）/ `revoked`（已吊销） |
| 登录审计事件 | 见[用户与登录](/backend/users#登录审计) |
| 设备与组织变更（`identity_audit`） | `org_create`（新建组织）、`org_rename`、`team_create`（新建团队）、`team_rename`、`device_move`（调整归属）、`enroll_code_issue`（签发注册码）、`device_revoke`（吊销设备） |

### 策略、预算、Flag

| 枚举 | 取值 |
| --- | --- |
| 层（策略、预算） | `org` / `team` / `device` |
| 预算周期 | `session`（单会话）/ `daily`（自然日，UTC）/ `weekly`（ISO 周）/ `monthly`（自然月，UTC） |
| 超限动作 | `alert`（告警放行，默认）/ `block`（硬拦，结束会话） |
| 变更审计动作 | `create` / `update` / `enable` / `disable` / `delete` |

### 插件市场

| 枚举 | 取值 |
| --- | --- |
| 条目类型 | `plugin`（插件）/ `skill`（技能）/ `mcp`（MCP） |
| 版本状态 | `draft`（草稿）→ `published`（已发布）→ `yanked`（已下架），只能单向走 |
| CI 上传凭据状态 | `active` / `revoked` / `expired` |
| 变更审计动作 | `create`、`update`、`upload`、`publish`、`yank`、`issue`（签发凭据）、`revoke`（吊销凭据）、`denied`（CI 凭据越权被拒） |

### 轨迹

| 枚举 | 取值 |
| --- | --- |
| 退出状态 `exit_status` | `end_turn`（正常完成）、`tool_use`（停在工具调用）、`user_interrupt`（用户中断）、`max_turns`（轮次用尽）、`budget_exceeded`（预算停止）、`abort`（强制终止）、`error`（运行错误）、`clear`（/clear 清空）、`terminal_closed`（未提问即关闭）、`incomplete`（未收尾）、`unknown` |
| 结束方式 `end_source` | `exit`（正常退出）、`abort`（中断退出）、`terminal_closed`（关闭终端）、`error`（异常退出）、`clear`（/clear）、`other`（其他）。旧版客户端不上报，为空 |
| 质量状态 | `unreviewed`（未评审）/ `approved`（通过）/ `rejected`（拒绝） |
| 任务类型 | `bug_fix` / `feature` / `refactor` / `explain` / `other`，可以为空 |

成功率只看 `exit_status`。`end_source` 表示会话怎么结束，和结果是两个维度。

### 事件

| 拒绝原因 | 含义 |
| --- | --- |
| `unknown_event_name` | 事件名不在服务端白名单里。正常情况下不应出现，出现说明两端版本不一致 |
| `bad_shape` | 单条事件结构不对，例如缺字段、类型错 |
| `metadata_not_dict` | `metadata` 不是对象 |
| `metadata_too_many_keys` | `metadata` 超过 64 个键 |
| `metadata_nested_value` | `metadata` 的值里有嵌套对象或数组 |
| `bad_plugin_fields` | `tool_invoked` 的插件名或组件类型不合规 |

被拒的事件不入库，只在审计页「被拒事件名」里计数。见[审计](/backend/audit)。

### 飞书文档工具

调用结果 `outcome`：`ok`、`forbidden`、`not_found`、`scope_missing`、`reauth_required`、`not_logged_in`、`unavailable`、`bad_request`、`unsupported`。每个值的含义、员工端提示和处理办法见[飞书文档授权](/backend/feishu)。

## 相关

- [部署与配置](/backend/deploy) —— 环境变量全表
- [企业后端概览](/backend/) —— 七条通道的时机与失败行为
- [排障与常见问题](/backend/troubleshooting)
