---
title: 部署与配置
description: 企业后端怎么装：本地试用的逐条命令、生产部署的步骤骨架、环境变量全表、飞书开发者后台清单和首个管理员引导。
---

# 部署与配置

这页写给**装企业后端的运维**。管理员用管理台的部分从[快速上手](/backend/quickstart)开始读，不用看这页。

分两种详略：

- **本地试用**：逐条命令，可以直接复制。目的是先在自己电脑上看到管理台，读懂其他页；
- **生产部署**：只写形态、步骤和必改的配置项。具体脚本以 agent-backend 仓库的 `deploy/` 目录和 README 为准，这里不重复一份会过期的命令。

真正容易出错的是配置项，不是装机命令。生产部署请重点读[环境变量](#环境变量)和[飞书开发者后台](#飞书开发者后台)两节。

## 部署形态

| 组件 | 生产 | 试用 |
| --- | --- | --- |
| 后端 | FastAPI + uvicorn，systemd 托管，监听 `127.0.0.1:8900` | 同左，前台运行 |
| 数据库 | PostgreSQL | SQLite（默认，零配置） |
| 轨迹文件 | 对象存储（OSS） | 本地目录 |
| 管理台 | 前端构建产物，由 Nginx 托管在 `/traj/` | Vite 开发服务器 `http://localhost:5173/traj/` |
| 反向代理 | Nginx，把 `/traj/api/` 转给后端 | 不需要 |
| 遥控中继 | 独立进程，监听 `127.0.0.1:8901`，**只能 1 个 worker** | 不用遥控就不起 |

`/traj` 是路径前缀，部署时决定。员工端的 `backend.url` 要带上它，例如 `https://agent.example.com/traj`。

## 本地试用

需要 Python 3.10 及以上、Node.js 和 pnpm。

```bash
git clone https://github.com/njfuzrs/agent-backend.git
cd agent-backend
cp .env.example backend/.env
```

编辑 `backend/.env`，填两个必填项（缺任意一个，进程启动时直接退出，这是故意的）：

```ini
AUTH_PASSWORD=换成一串随机字符
UPLOAD_TOKEN=换成另一串随机字符
# 想在本地试注册码，再加一行：
CTL_ENROLL_ENABLED=true
```

随机字符可以这样生成：`python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`。

起后端：

```bash
mkdir -p data                       # SQLite 文件放在仓库根的 data/ 下，目录要先存在
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.lock    # 锁定版本；requirements.txt 只有版本范围
alembic upgrade head                # 建表。启动时不会自动迁移
uvicorn app.main:app --port 8900
```

另开一个终端起管理台：

```bash
cd agent-backend/frontend
pnpm install && pnpm dev
```

验证：

```bash
curl http://127.0.0.1:8900/api/v1/health
# {"status":"ok","version":"1.0.0"}
```

浏览器打开 `http://localhost:5173/traj/`，在「应急：管理员口令」下用 `admin` 和你填的 `AUTH_PASSWORD` 登录。口令登录的会话视为 admin。

接一台本地客户端：在 `~/.sid-code/settings.json` 写 `{ "backend": { "url": "http://127.0.0.1:8900" } }`。本地没配飞书，`sid-code login` 用不了，改用注册码：

1. 管理台「组织与团队」新建组织 `acme`；
2. 「设备」页点「签发注册码」，「组织 ID」填 `acme`，「备注」必填，复制显示出的码（只显示这一次）；
3. 本机执行：

```bash
sid-code auth enroll --code <注册码> --org acme
# ✓ 注册成功：acme
sid-code auth status --verify
```

`auth status --verify` 里登录、策略、预算、账本、事件、flag 几条通道都是 ✓，就说明接通了。接下来可以按[快速上手](/backend/quickstart)把策略、预算走一遍。

本地 SQLite 实例上 `http://127.0.0.1:8900/docs` 能看到全部接口参数（FastAPI 自带）；PostgreSQL 实例默认关闭，见 `API_DOCS_ENABLED`。

## 生产部署

步骤骨架，每步写「做什么、怎么确认」。命令以仓库 `deploy/` 下的脚本和 README 为准。

| 步骤 | 做什么 | 怎么确认 |
| --- | --- | --- |
| 1. 准备依赖 | PostgreSQL、对象存储 bucket、域名和 TLS 证书 | 能用 `psql` 连上；bucket 可写 |
| 2. 写 `.env` | 从 `.env.example` 复制，按[环境变量](#环境变量)逐项填，权限设为 `600` | `ls -l` 看到 `-rw-------` |
| 3. 装代码和依赖 | 代码放到服务器，`pip install -r requirements.lock`，前端 `pnpm install --frozen-lockfile && pnpm run build` | `frontend/dist/index.html` 存在 |
| 4. 建表 | `alembic upgrade head`。已有数据的库升级前先备份，仓库提供 `deploy/migrate.sh` | 命令输出到最新版本号，无报错 |
| 5. systemd | 用仓库的 unit 模板起后端（`--workers 2`）；用遥控再单独起 bridge unit（`--workers 1`） | `curl http://127.0.0.1:8900/api/v1/health` 返回 ok |
| 6. Nginx | 托管前端静态文件，反代 `/traj/api/`，见下 | `curl https://agent.example.com/traj/api/v1/health` 返回 ok |
| 7. 冒烟 | 浏览器打开管理台，飞书登录；员工端 `sid-code login` 后跑 `sid-code auth status --verify` | 七条通道都是 ✓ |

Nginx 的 API 反代片段（取自仓库 `deploy/nginx.conf`，域名已替换）：

```nginx
location /traj/api/ {
    proxy_pass http://127.0.0.1:8900/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    client_max_body_size 100M;   # 轨迹上传
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}

# 就绪检查只给本机用，不对外
location = /traj/api/v1/ready {
    return 404;
}
```

用遥控时，另加一段 WebSocket 反代到 `127.0.0.1:8901/api/v1/bridge/ws`（`Upgrade` / `Connection` 头、长超时、关缓冲），完整片段见同一文件。

发版、回滚、备份、对账等运维脚本也在仓库 `deploy/` 下，这里不展开。

## 环境变量

后端从 `backend/.env` 读取（systemd 部署时由 unit 的 `EnvironmentFile` 指定）。完整注释见仓库 `.env.example`，定义在 `agent-backend: backend/app/core/config.py`。

### 必填

| 变量 | 默认值 | 作用 | 什么时候必须改 |
| --- | --- | --- | --- |
| `AUTH_PASSWORD` | 无 | 管理员应急口令；也是数据面 Basic 鉴权的口令 | 必填，缺了不启动 |
| `UPLOAD_TOKEN` | 无 | 轨迹上传口令（`X-Upload-Token`），员工端 `trace.upload.token` 填它 | 必填，缺了不启动 |
| `AUTH_USERNAME` | `admin` | 应急口令登录的用户名 | 可选 |

### 会话

| 变量 | 默认值 | 作用 | 什么时候必须改 |
| --- | --- | --- | --- |
| `SESSION_SECRET` | 空（由 `AUTH_PASSWORD` 推出） | 管理台会话签名密钥 | **上飞书前必须单独配**。不配的话，改应急口令会把所有人（包括飞书登录的）踢下线 |
| `SESSION_COOKIE_SECURE` | `false` | 会话 cookie 是否只走 HTTPS | **上了 TLS 必须设为 `true`** |

管理台会话有效期固定 8 小时。

### 飞书登录

`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`PUBLIC_BASE_URL` 三项都填了，飞书登录才启用；少一项，飞书登录相关接口返回 503，口令登录照常可用。

| 变量 | 默认值 | 作用 | 什么时候必须改 |
| --- | --- | --- | --- |
| `PUBLIC_BASE_URL` | 空 | 对外地址，**含路径前缀**，例如 `https://agent.example.com/traj`。飞书回调地址和本企业市场的地址都由它推出 | 必须和飞书后台登记的回调地址**逐字一致**（协议、域名、有无 www、前缀） |
| `ADMIN_UI_BASE_URL` | 空（同 `PUBLIC_BASE_URL`） | 登录完成后浏览器跳回的管理台地址 | 管理台和 API 不在同一地址时 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 空 | 飞书企业自建应用的凭据 | 接飞书时 |
| `FEISHU_TENANT_KEY` | 空（不校验租户） | 只允许这个飞书租户的人登录；其他租户返回 `tenant_mismatch` | **生产必须回填**，方法见[首个管理员](#首个管理员) |
| `FEISHU_LOGIN_SCOPE` | 空 | 登录时申请的用户身份 scope，空格分隔 | 要用[飞书文档授权](#委托授权)时，必须带 `offline_access` 和文档类 scope |
| `ADMIN_BOOTSTRAP_UNION_IDS` | 空 | 这些飞书 union_id 每次登录都会被设为 admin，逗号分隔 | 首个管理员，见下文 |
| `AUTH_PASSWORD_LOGIN_ENABLED` | **`true`** | 是否允许口令应急登录 | **生产建议设为 `false`**。默认是开的，飞书登录跑通后请手工关掉 |

`AUTH_PASSWORD_LOGIN_ENABLED=false` 时，口令登录接口返回 404，已有的口令会话下一次请求就失效。脚本用的 HTTP Basic（只覆盖轨迹类数据面接口）不受影响。

### 委托授权

| 变量 | 默认值 | 作用 | 什么时候必须改 |
| --- | --- | --- | --- |
| `TOKEN_ENC_KEY` | 空 | 加密保存员工飞书 token 的 Fernet 密钥；多把用逗号分隔，第一把加密、全部可解密，用于轮换 | 要用飞书文档工具时。不配则 token 不落库，飞书 MCP 返回 503 |
| `FEISHU_DOC_MAX_CHARS` | `60000` | 读飞书文档时的截断长度 | 按需 |

生成密钥：

```bash
python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

### 控制面

| 变量 | 默认值 | 作用 | 什么时候必须改 |
| --- | --- | --- | --- |
| `CTL_ENROLL_ENABLED` | `false` | 是否开放注册码兑换（`POST /ctl/enroll`）。关闭时管理台的「签发注册码」按钮置灰 | 要给 CI、无浏览器的机器发凭据时 |
| `CTL_CREDENTIAL_TTL_DAYS` | `90` | 设备凭据有效期，每次访问控制面滑动续期 | 按需 |
| `CTL_ENROLL_CODE_TTL_HOURS` | `24` | 注册码默认有效期 | 按需 |
| `CTL_LOGIN_ORG_ID` | `default` | 飞书登录的新设备落在哪个组织（不存在会自动创建） | 想让新设备直接进你的组织时，例如 `acme` |
| `BRIDGE_WS_PUBLIC_URL` | 空 | 遥控中继的对外 WebSocket 地址，例如 `wss://agent.example.com/traj/api/v1/bridge/ws` | 生产用遥控时**必须配**，且必须是 `wss://`；不配时签发遥控会话返回 500 |

### 数据库与存储

| 变量 | 默认值 | 作用 | 什么时候必须改 |
| --- | --- | --- | --- |
| `DATABASE_URL` | 仓库根 `data/trajectories.db`（SQLite） | 数据库连接串 | 生产改为 `postgresql+asyncpg://user:pass@host:5432/db` |
| `STORAGE_BACKEND` | `local` | 轨迹文件存哪：`local` / `oss` | 生产用对象存储时 |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` / `OSS_ENDPOINT` / `OSS_BUCKET_NAME` | 空 | 对象存储凭据 | `STORAGE_BACKEND=oss` 时 |
| `OSS_CACHE_DIR` / `OSS_CACHE_MAX_SIZE_MB` | `/tmp/traj-cache` / `1024` | 本地读缓存 | 按需 |
| `CORS_ORIGINS` | `["http://localhost:5173"]` | 允许跨域的管理台来源，JSON 列表 | 管理台和 API 不同源时 |
| `API_DOCS_ENABLED` | 空（SQLite 开，其他关） | 是否开放 `/docs`、`/redoc`、`/openapi.json` | 一般不用改。**不要在生产打开** |

`.env.example` 里那行注释掉的 SQLite 示例是相对路径，会随工作目录变化。要改 SQLite 位置请写绝对路径。

### 日志

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | 无法识别的取值会让进程拒绝启动 |
| `LOG_FORMAT` | SQLite 下 `text`，其他 `json` | 只能是 `text` 或 `json` |

::: warning 这两项不从 `backend/.env` 读
`LOG_LEVEL`、`LOG_FORMAT` 读的是进程环境变量。systemd 的 `EnvironmentFile` 会把 `.env` 注入进程环境，所以生产写在 `.env` 里有效；本地前台运行时要在 shell 里 `export`。
:::

## 飞书开发者后台

1. 在飞书开放平台建一个**企业自建应用**。
2. 「安全设置」的重定向 URL 填：`<PUBLIC_BASE_URL>/api/v1/auth/feishu/callback`，例如 `https://agent.example.com/traj/api/v1/auth/feishu/callback`。员工端 `sid-code login` 复用同一个回调，不用另外登记。
3. 「权限管理」开通**用户身份**权限。登录本身只需要基础的用户信息；要用飞书文档工具时再加 `offline_access`、文档只读、知识库只读，需要搜索时加搜索。**具体名字以后台显示为准**，再原样写进 `FEISHU_LOGIN_SCOPE`。
4. 打开「刷新 user_access_token」开关（委托授权需要）。
5. 设置应用的**可用范围**：谁能看到并登录这个应用。
6. **创建版本并发布**。不发布，上面的配置都不生效。

改了 scope 之后，员工要重新 `sid-code login` 一次，新的授权才带上新 scope。

## 首个管理员

新用户第一次用飞书登录默认是 member，进管理台会看到「没有管理台权限」。第一个管理员这样引导：

1. `ADMIN_BOOTSTRAP_UNION_IDS` 先留空，`AUTH_PASSWORD_LOGIN_ENABLED` 先保持 `true`。
2. 自己用飞书登录管理台一次，会看到 403 页。这一步是为了让后端记下你的用户行。
3. 退出，在登录页「应急：管理员口令」下用口令登录。
4. 打开「用户」页找到自己。两种做法任选：
   - 直接在「角色」下拉里改成 `admin`；
   - 或者拿到自己的 union_id 填进 `ADMIN_BOOTSTRAP_UNION_IDS`，重启后端，再用飞书登录。这种做法的好处是每次登录都会自动恢复 admin，适合「防止被误降级」。
5. 同一时机回填 `FEISHU_TENANT_KEY`：用户行里记录了租户（也可以直接查库 `users.tenant_key`），填进去重启。
6. 确认飞书登录可用后，把 `AUTH_PASSWORD_LOGIN_ENABLED` 改成 `false` 重启。

`GET /api/v1/users` 只认管理台会话，HTTP Basic 调不通，所以第 4 步要先口令登录，或者直接查库。

## 升级

只有一条路：拉新代码 → 装依赖 → `alembic upgrade head` → 重启。升级前先备份数据库。后端启动时只检查 schema 版本并在不一致时打告警，**不会自动迁移**。不要用 `alembic downgrade` 回滚，回滚方法见仓库 `deploy/` 的说明。

## 上线检查清单

- [ ] 全站 HTTPS，`SESSION_COOKIE_SECURE=true`
- [ ] `SESSION_SECRET` 单独配置，没有依赖 `AUTH_PASSWORD` 推导
- [ ] `PUBLIC_BASE_URL` 和飞书后台的回调地址逐字一致
- [ ] `FEISHU_TENANT_KEY` 已回填
- [ ] 至少有两个 admin，避免唯一管理员离职后无人能管
- [ ] `AUTH_PASSWORD_LOGIN_ENABLED=false`
- [ ] `.env` 权限 `600`，不进版本库
- [ ] Nginx 配了 HSTS，`/traj/api/v1/ready` 不对外
- [ ] 数据库有定时备份
- [ ] `API_DOCS_ENABLED` 没有在生产打开（在服务器上 `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8900/docs` 应为 404）

## 能力边界（如实说）

**1. 一套后端对应一个飞书租户。** 不支持多租户隔离。组织和团队是同一租户内的划分，不是租户边界。

**2. 身份源只有飞书。** 不支持通用 OIDC、LDAP 或其他 IdP；没有飞书的机器只能用注册码拿到不绑人的设备凭据。

**3. 系统不会阻止你漏配安全项。** 启动时只检查两个必填项和日志取值；`SESSION_SECRET`、`SESSION_COOKIE_SECURE`、口令登录开关都不会因为「在生产」而被强制。上面的检查清单要人工过一遍。

**4. 遥控中继只能单进程。** 它不能横向扩展，也不能开多 worker。

## 相关

- [快速上手](/backend/quickstart) —— 装好之后管理员的第一条路径
- [用户与登录](/backend/users) —— 角色、吊销、登录失败排查
- [企业后端概览](/backend/) —— 全部通道
- [企业登录](/team/login) —— 员工端怎么登录
