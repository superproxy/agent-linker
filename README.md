# LinkAgent Gateway

OpenAI 兼容的本地 Agent 网关：让 **Chatbox / Open WebUI / 任意 OpenAI 客户端** 直接对话本机 agent（opencode / pi / workbuddy / trace-cli，以及 codex / claude / gemini / cursor 等全部 ACP 类型，见[支持的 agent](#支持的-agent)），并提供网页后台、内置控制台与**多渠道接入**（个人微信 / 企业微信）。

```
Chatbox / Open WebUI ─┐
内置控制台 (GET /)  ───┼──▶ /v1 (OpenAI 兼容) ──▶ ACP(acpx) ──▶ agent
web 后台 (pnpm web) ──┘                           (opencode acp / pi-acp /
个人微信 / 企业微信 ───▶ 渠道(插件运行时 or 独立 botAgent) ─┘   codebuddy --acp /
                                                    traecli acp serve)
```

## 快速开始

```bash
pnpm install

# 启动网关（监听 backend/config/config.yaml 的 host:port，缺省 0.0.0.0:8787）
pnpm dev          # 等价 pnpm --filter @linkagent/backend dev（tsx watch，改代码自动重启）
# 生产方式：pnpm start；后台启停：pnpm server:start / stop / status / log
```

启动后：

- **内置控制台**：浏览器打开 `http://127.0.0.1:8787/`（切换 Agent / 模型 / 启停 / 对话测试）
- **OpenAI 端点**：`http://127.0.0.1:8787/v1`（Chatbox / Open WebUI 填入 base_url 即可）
- **web 后台**（可选，React 管理页）：先 `pnpm build:web`，再打开 `http://127.0.0.1:8787/ui`（由网关同源提供，单端口；开发时 `pnpm web` 以 build --watch 自动重建，刷新即可）
- 健康检查：`GET http://127.0.0.1:8787/healthz`

依赖本机已安装 agent 运行命令：

| agent | 命令 | 说明 |
|---|---|---|
| opencode | `opencode acp --port 0` | 原生 ACP server，默认只读问答 |
| pi | `npx -y pi-acp` | pi-coding-agent 的第三方 ACP 桥接（内部 `pi --mode rpc`） |
| workbuddy | `codebuddy --acp` | 腾讯 CodeBuddy Code CLI 原生 ACP server |
| trace-cli | `traecli acp serve` | 字节 TraeCode CLI 2.0 原生 ACP server |
| cursor | `agent acp` | Cursor CLI 原生 ACP server |
| zcode | `zcode-acp-server` | 智谱 ZCode（先 `npm i -g zcode-acp-server`），经 ACP 桥接 |
| 更多（codex / claude / gemini / copilot / qwen / openclaw 等） | 见管理后台「支持 ACP 的 Agent 目录」 | 对应 CLI 本机安装后即可一键添加启用 |

## 配置

配置读取优先级：

1. 环境变量 `GATEWAY_CONFIG_PATH` 指向的 yaml（缺失则启动报错）
2. `backend/config/config.yaml`（缺省读取路径）
3. 内置默认值（127.0.0.1:8787，无鉴权，opencode / pi / workbuddy / trace-cli / cursor）

`backend/config/config.yaml` 示例：

```yaml
server:
  host: 0.0.0.0
  port: 8787
auth:
  enabled: false        # 开启后 /v1 与 /api/* 均要求 Authorization: Bearer <token>
  token: ""             # enabled=true 时必须填写

# agent 默认工作目录（= 默认工作空间 default）：未显式配 cwd 的 agent 在此运行
# defaultCwd: /path/to/works

# agents 省略时使用内置默认（opencode / pi / workbuddy / trace-cli / cursor）
agents:
  - id: opencode
    type: opencode              # 支持全部 ACP 类型：opencode | pi | workbuddy | trace-cli | cursor | codex | claude | gemini | ...
    displayName: OpenCode
    description: 本地 opencode
    # cwd: /path/to/workdir     # agent 进程工作目录
    # permissionMode: approve-reads   # approve-all | approve-reads | deny-all
    # command: ["opencode", "acp", "--port", "0"]
    # env: { KEY: value }
    # model: providerId/modelId # 会话默认模型（pi 必需，见下）

  - id: pi
    type: pi
    displayName: Pi
    model: volcengine/deepseek-v4-flash-ga-260731

  - id: workbuddy
    type: workbuddy
    displayName: WorkBuddy
    # 依赖本机已装 codebuddy（CodeBuddy Code CLI）；可用 env 传 CODEBUDDY_API_KEY / CODEBUDDY_INTERNET_ENVIRONMENT
    # env: { CODEBUDDY_API_KEY: "xxx", CODEBUDDY_INTERNET_ENVIRONMENT: "internal" }

  - id: trace-cli
    type: trace-cli
    displayName: TraeCode CLI
    # 依赖本机已装 traecli（TraeCode CLI 2.0）；全局参数（如 --profile / --permission-mode）可写在 command 里：
    # command: ["traecli", "--permission-mode", "auto", "acp", "serve"]

  - id: cursor
    type: cursor
    displayName: Cursor
    # 依赖本机已装 Cursor CLI；当前入口是 `agent acp`（不要用会找不到版本目录的 `cursor-agent acp`）
    # command: ["agent", "acp"]

# ── 渠道（可选）──────────────────────────────────────────
# 企业微信：channels.<id> 配 botId/secret 即启用（默认内置 @wecom/wecom-openclaw-plugin）
# 个人微信：配 plugins 后先扫码登录，见「多渠道」章节
plugins:
  - package: "@tencent-weixin/openclaw-weixin"   # package 以 @ 开头必须加引号
```

### 会话模型（model 字段）

- 建会话后经 ACP `set_config_option('model')` 下发给 agent；
- **pi 必需**：pi 自身默认 provider 可能没有可用凭据，需显式指到本机 `~/.pi/agent/models.json` 已注册的模型；
- opencode / workbuddy / trace-cli 配置了也会生效，未配置则沿用 agent 自身默认；
- 模型写法统一为 `providerId/modelId`（如 `volcengine/deepseek-v4-flash-ga-260731`）。

## OpenAI 兼容 API

模型对外 id 统一形如 `agent:<agentId>`：`agent:opencode`、`agent:pi`、`agent:workbuddy`、`agent:trace-cli`、`agent:cursor`；管理后台目录一键添加的类型同样暴露为 `agent:<type>`（如 `agent:codex`）。

### GET /v1/models

```bash
curl http://127.0.0.1:8787/v1/models
```

```json
{ "object": "list", "data": [ { "id": "agent:opencode", "object": "model", "owned_by": "linkagent" } ] }
```

### POST /v1/chat/completions

支持 stream / 非 stream。请求体为标准 OpenAI 格式（一期实现文本子集），并可叠加 linkagent 扩展字段（见下表）：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "agent:opencode",
    "messages": [{ "role": "user", "content": "你好" }],
    "stream": true
  }'
```

| 扩展字段 | 说明 |
|---|---|
| `taskKey` | 任务 key 单参数直连（见「任务 Key 直连」）；停用的 key 返回 `403 key_disabled` |
| `channel` / `userId` / `task` | 三元素路由（微信渠道可用，见下）；`userId` 缺省即 `default` 用户 |
| `agent` | 显式指定 agent，所有分支最高优先级；微信渠道（三元素）agent 仅由「任务绑定 + 此字段」决定 |
| `sessionKey` | 复用同一持久会话（渠道 adapter 使用） |

- 微信渠道（三元素）普通消息的 agent **不读 `model`**（weixin-bot 固定传 `weixin.model`，默认 `agent:pi`），由激活任务绑定决定；`taskKey` 直连分支 `model: agent:<id>` 仍可显式指定 agent。完整决策见「路由策略」。

- 非流式：返回 `chat.completion`，内容在 `choices[0].message.content`
- 流式：SSE 事件为标准 `chat.completion.chunk`，思考过程放在 `choices[0].delta.reasoning_content`，结束为 `data: [DONE]`
- 错误体为标准结构 `{ error: { message, type, param, code } }`，常见：`400` 请求体非法 / `401` 鉴权失败 / `403` key 已停用 / `404` 未知模型或任务不存在 / `500` agent 执行失败

### 会话语义（重要）

- **/v1 缺省为 oneshot**：网关把客户端全量多轮历史拼成一段完整上下文一次性下发，agent 无跨请求记忆 → 避免 agent 持久记忆跨用户/跨聊天串扰；
- 扩展字段 `sessionKey`（linkagent 扩展，非 OpenAI 标准）：同一 key 复用同一 agent 持久会话（有记忆），渠道 adapter 用它把渠道会话 id 映射到网关会话。

## 内置控制台（GET /）

打开 `http://127.0.0.1:8787/` 即得单页控制台，无需额外部署：

- **切换 Agent**：左侧卡片点击即选中，随后对话发往该 agent
- **切换模型**：每张卡片有模型下拉（候选来自本机真实配置，见下）+ 「应用模型」按钮
- **启停**：每张卡片「启用 / 停用」，停用后不出现在 `/v1/models`，chat 返回 `model_not_found`
- **对话**：流式渲染正文与思考过程，按钮兼作「停止」
- **鉴权**：网关开启 auth 时，右上角「API Key」填写 Bearer token（存 localStorage，key: `linkagent.gw.apikey`）

> 切换模型 / 启停均为**运行时内存热更新**，重启 gateway 后还原为 `backend/config/config.yaml` 的值。

## 控制 API（网关自定义，非 OpenAI 标准）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agents` | 全部 agent 运行态详情（id/type/displayName/description/model/enabled） |
| GET | `/api/agents/candidates` | 各 agent 的模型候选列表 `{ [agentId]: string[] }` |
| PATCH | `/api/agents/:id` | 热更新，body 可含 `{ model: string \| null }`（null=回配置默认）和/或 `{ enabled: boolean }` |

```bash
# 把 agent:pi 的会话模型切到另一模型
curl -X PATCH http://127.0.0.1:8787/api/agents/pi \
  -H 'Content-Type: application/json' \
  -d '{"model": "providerId/modelId"}'

# 停用 opencode
curl -X PATCH http://127.0.0.1:8787/api/agents/opencode \
  -H 'Content-Type: application/json' \
  -d '{"enabled": false}'
```

### 模型候选来源（仅用于控制台/后台下拉，不校验可用性）

- opencode：`~/.config/opencode/opencode.json`（或仓库根 `opencode.json`）中 `provider.<id>.models` 的键
- pi：`~/.pi/agent/models.json` 中 `providers.<id>.models[].id`
- workbuddy / trace-cli：本地模型配置路径暂无公开文档，暂不自动收集（UI 手动输入）

文件缺失 / 结构不符 / 解析失败一律静默降级为空列表（UI 仍可手动输入模型）。

## 接入 Chatbox / Open WebUI

| 配置项 | 值 |
|---|---|
| API 提供方 | OpenAI API 兼容 / Custom Provider |
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | 网关未开鉴权填任意非空即可；开了可填 `auth.token`，或登录后台在「我的 Token」获取本人的个人 token（`pat_` 前缀） |
| 模型 | `agent:opencode`、`agent:pi`、`agent:workbuddy`、`agent:trace-cli`、`agent:cursor`（也可先调 `/v1/models` 让客户端自动拉取） |

## web 后台（可选）

React 管理页（`web/`，Vite 构建为静态文件，由网关同源挂载到 `/ui`，不单独占用端口）：

```bash
pnpm build:web   # 一次性构建到 web/dist，打开 http://127.0.0.1:8787/ui
pnpm web         # 开发用：vite build --watch，改代码自动重建，刷新 /ui 即可
```

页面功能：Agent 管理（启停 / 设为默认）、微信机器人绑定、健康检查、模型列表、流式聊天测试台。页面内可修改网关地址（存 localStorage `linkagent.gw.base`）与可选 API Key（`linkagent.gw.token`）。

## 多渠道

两条接入路线，**互不冲突、可同时启用**：

| 路线 | 运行形态 | 适用 | 配置/命令 |
|---|---|---|---|
| **A. openclaw 插件运行时** | gateway 进程内加载插件 | 企业微信（webhook）/ 个人微信（长轮询） | `plugins[]` / `channels.<id>` |
| **B. 独立 botAgent** | 独立进程 | 轻量、不依赖插件运行时 | `pnpm bot:weixin` / `pnpm bot:wecom` |

两者最终都通过**同一网关会话**（`sessionKey → ACP 持久会话`）获得多轮记忆，且默认**每个用户独立会话、记忆不串人**。

### 路线 A：openclaw 插件运行时

在 `backend/config/config.yaml` 配置 `channels.<id>` 或 `plugins[]` 后，gateway 启动时由 `PluginManager` 动态加载插件包（默认 `@wecom/wecom-openclaw-plugin`），插件注册渠道 / HTTP 路由 / 工具，然后对每个账号调 `startAccount()`。插件缺失或加载失败**仅告警，不影响 /v1**。

```yaml
plugins:
  - package: "@tencent-weixin/openclaw-weixin"   # 个人微信

channels:
  wecom:                 # 企业微信（默认内置插件读取此配置）
    botId: "ww1234..."   # 自建应用 botId
    secret: "xxxx"
    # connectionMode: webhook
    # agentId: opencode                  # 该渠道默认 agent（缺省 opencode）
    # session: { dmScope: "per-account-channel-peer" }
    # markdown: { tables: "code" }       # outbound 表格渲染：code|bullets|off|block
    # allowFrom: [{ id: "userid1" }]     # 静态放行名单（免配对）
```

- **企业微信**：`channels.<id>` 配 `botId` + `secret` 即启用（webhook 模式，插件把 `/wecom/agent`、`/wecom/bot` 等 5 条 HTTP 路由挂到网关 8787）。
- **个人微信**：先扫码登录，再重启 gateway 自动收消息：

```bash
pnpm --filter @linkagent/backend weixin-login   # 终端扫码，登录态存 .runtime-state/plugins/openclaw-weixin/accounts/
```

#### 消息 → agent 路由（sessionKey 隔离）

对齐 openclaw 的 sessionKey 格式，**默认每个微信用户拥有独立 agent 会话**（`dmScope=per-account-channel-peer`，与 openclaw 默认共享 main 不同）：

```
DM（单聊）:  agent:<agentId>:<channel>:<accountId>:direct:<peerId>
群聊       :  agent:<agentId>:<channel>:group:<peerId>
兜底       :  agent:<agentId>:main
```

- 渠道级默认 agent 由 `channels.<channel>.agentId` 决定，缺省 `opencode`；
- 可配 `session.dmScope = per-channel-peer | per-peer | main` 收紧/放宽会话隔离。

#### 派发与呈现

- 入站文本（+附件，附件以 `file://`/url 引用拼进 prompt）→ `dispatchReplyFromConfig` → agent 流式输出；
- **思考块**以 `🤔` 前缀独立消息推送（不逐 token 刷屏），正文按 512 字符 / 24ms 分块流式 deliver；
- 出站 markdown 表格按 `markdown.tables` 模式转换（默认 code 代码块）；长文本由插件侧分块；
- 控制命令 `/new`、`/reset`、`/stop`、`/help`：**一期不执行会话重置**，命中即回复说明文案（避免静默吞掉）；
- `humanDelayMs` / typing 心跳可模拟真人打字节奏（`agents.<id>.humanDelayMs` 或 `agents.defaults.humanDelayMs`）。

### 路线 B：独立 botAgent（独立进程）

不依赖 openclaw 插件运行时，直接以 HTTP 客户端调本网关 `/v1/chat/completions`（SSE 流式），并各自对接渠道服务端。两 adapter 共享 `gateway-chat.ts` 的会话编排（思考先行、切块推送、失败重试一次、5 分钟单轮超时、失败推送 ⚠️ 摘要）。

#### 个人微信 bot

```
微信用户 ⇄ ilink 长轮询(getUpdates) ⇄ weixin-bot ⇄ POST /v1/chat/completions (SSE)
                                              ⇄ sendMessage 推回微信
```

```bash
pnpm bot:weixin
# 先扫码登录（复用 openclaw-weixin 登录态）：pnpm --filter @linkagent/backend weixin-login
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `LINKAGENT_GATEWAY_URL` | `http://127.0.0.1:8787` | 网关 base |
| `LINKAGENT_GATEWAY_MODEL` | `agent:pi` | 对话模型（weixin.model；仅作 OpenAI 字段透传，不参与任务路由） |
| `LINKAGENT_ACCOUNT_ID` | 取 accounts/ 第一个 | 微信登录态账号 |
| `LINKAGENT_STATE_DIR` | `<repo>/.runtime-state/plugins` | 登录态目录 |

会话 key：`weixin:<from_user_id>`（每个用户独立持久会话）；文本按 2000 字符分段（ilink 上限）。

#### 企业微信 bot

```
企微用户 ⇄ 企微服务器 POST 加密 XML 回调 ⇄ wecom-bot(HTTP :8798) ⇄ POST /v1/chat/completions (SSE)
                                             ⇄ qyapi message/send 主动推回
```

```bash
pnpm bot:wecom
```

必填环境变量（企业微信自建应用「接收消息」配置）：

| 环境变量 | 说明 |
|---|---|
| `WECOM_CORP_ID` | 企业 ID |
| `WECOM_AGENT_ID` | 自建应用 AgentId（数字） |
| `WECOM_SECRET` | 自建应用 Secret |
| `WECOM_TOKEN` | 接收消息服务器 Token |
| `WECOM_AES_KEY` | EncodingAESKey（43 位） |

可选：`WECOM_PORT`（默认 8798）、`WECOM_CALLBACK_PATH`（默认 `/wecom/callback`）、`LINKAGENT_GATEWAY_URL`、`LINKAGENT_GATEWAY_MODEL`。

企业微信后台配置：应用管理 → 自建应用 → 接收消息 → 设置 API 接收，`URL = http(s)://<公网>:8798/wecom/callback`，Token/EncodingAESKey 与上面一致。回调支持 URL 验证（echostr）、消息验签+AES 解密、MsgId 去重、5s 内回 `success` 防重试。

会话 key：单聊 `wecom:user:<userid>`，群聊 `wecom:chat:<chatid>`；消息走原 `model + sessionKey` 路径（无任务机制，任务路由白名单仅微信渠道）；text 按 2048 字节切块（UTF-8）。

> 提示：独立 botAgent 直连 `/v1`，若网关开了 `auth.enabled`，需要给 adapter 的 `/v1` 请求带 Bearer token（当前版本未内置该支持，请保持 auth 关闭或自行扩展）。

### 任务命令（多渠道共享，网关公共能力）

每个渠道用户拥有独立任务列表（`.runtime-state/tasks/`），每条任务绑定一个 agent、拥有独立持久会话：

| 命令 | 说明 |
|---|---|
| `/task new <名称> [agent]` | 新建任务并激活（agent: opencode / pi / workbuddy / trace-cli / cursor） |
| `/task list` | 查看全部任务（`← 激活` 标记当前） |
| `/task use <id>` | 切换到指定任务 |
| `/task del <id>` | 删除任务（默认任务不可删） |
| `/task rename <id> <新名>` | 重命名 |
| `/task help` | 用法说明 |

- 普通消息自动进入「激活任务」绑定的 agent 会话，各任务记忆互不串扰（会话 key `channel:userId:task:<id>`）；
- 首次使用自动创建「默认」任务（agent 由 `tasks.defaultAgentId` 配置，缺省 opencode）；
- web 后台可经 `/api/tasks` 点击管理，与微信命令等价；
- 普通 OpenAI 客户端（不传 `channel/userId`）走原 `model + sessionKey` 路径，不受影响。

### 路由策略：/v1 消息如何选择 agent

`POST /v1/chat/completions` 的 agent 选择统一由网关 `decideTaskRouting` 决策，按请求形态分四个分支：

| 请求形态 | 分支 | agent 选择 | 会话 |
|---|---|---|---|
| 带 `taskKey` | 任务 Key 直连 | 任务绑定 agent；`model: agent:<id>` / 扩展字段 `agent` 可显式覆盖 | 任务持久会话（与微信 `/task use` 互通） |
| `channel: weixin` + 普通消息 | 三元素路由 | 激活任务绑定 agent；`agent` 可覆盖，**`model` 不参与** | `weixin:<userId>:task:<taskId>` |
| `channel: weixin` + `/task 命令` | 命令分支 | 不走 agent，网关本地解析返回文本 | — |
| 无 `channel`（普通 OpenAI 客户端） | legacy | 原 `model`（`agent:<id>`） | 原 model + sessionKey 路径 |

核心原则：

- **微信渠道普通消息的 agent 只由任务决定**：进入「激活任务」绑定的 agent。`model` 参数（weixin-bot 写死的 `weixin.model`，默认 `agent:pi`）**不参与** agent 路由——避免它与默认任务绑定 `tasks.defaultAgentId`（缺省 `opencode`）配置不一致时，把 default 任务误路由到写死的 agent。
- **显式 `agent` 扩展字段优先级最高**：任意分支都可覆盖任务绑定。
- **`taskKey` 直连保留 `model` 显式指定**：与普通 OpenAI 客户端一致，便于通用客户端凭 key 直连并指定 agent。
- **`userId` 缺省视为 `default` 用户**（独立任务列表与会话，见「userId 缺省」）。
- **查询失败兜底**：weixin-bot 向网关查询 `/api/tasks` 失败（网关离线/异常）时，透传 `task: default` 且不指定 agent，由网关按默认任务绑定的 `tasks.defaultAgentId` 权威兜底，保证默认任务始终路由到配置的默认 agent。

### 任务 Key 直连与认证方式（/v1 扩展）

#### 鉴权开关（系统设置）

网关鉴权可在配置里整体启用/禁用（`backend/config/config.yaml`）：

```yaml
auth:
  enabled: true    # false=完全关闭（默认）；true=启用 Bearer 鉴权
  token: "..."     # enabled=true 时必须填写
```

- 关闭时 `/v1` 与 `/api/*` 全部免鉴权直通（默认行为）；
- 启用后所有请求要求 `Authorization: Bearer <token>`，无/错 token 返回 `401`；
- 网页控制台右上角「API Key」可填写 Bearer token 继续使用；
- 登录账号还可在后台「我的 Token」自助获取一枚长期个人 token（`pat_` 前缀），等同账号本人直连 `/v1`，支持幂等获取 / 轮换 / 吊销。

#### 1. 任务 Key 直接访问 API（`taskKey` 单参数直连）

任务创建后自动分配全局唯一 key（`k_` 前缀，可在控制台查看/复制）。任何调用方凭 key 即可直连该任务，**无需** channel/userId/task 三元素：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{
    "taskKey": "k_abc123",
    "model": "agent:opencode",
    "messages": [{ "role": "user", "content": "继续上次的话题" }]
  }'
```

- agent 用 **model 方式**指定（`model: agent:<agentId>`），与普通 OpenAI 客户端一致；也可用扩展字段 `agent` 覆盖，优先级高于 model；
- 会话自动落到 key 对应任务的持久会话（有记忆），与微信命令 `/task use` 切换出的会话**互通**；
- 任务 key 被停用后返回 `403`（`code: key_disabled`），任务本体（微信/三元素路由）不受影响；
- 默认工作空间为 `default`（agent 工作目录：`agents.<id>.cwd` → 配置 `defaultCwd` → 网关启动目录，见配置章节）。

#### 2. 微信渠道：三元素 或 Key 认证

微信渠道用户访问 `/v1` 有两种等价认证方式：

- **三元素**：`channel: "weixin"` + `userId` + 可选 `task`（活动任务）：
  ```bash
  -d '{
    "channel": "weixin", "userId": "wx_10001",
    "messages": [{ "role": "user", "content": "帮我写方案" }]
  }'
  ```
- **Key 认证**：只带 `taskKey`（单参数直连，见上），channel/userId 由 key 对应任务决定。

#### 3. userId 缺省 = default 用户

三元素路由时 `userId` 可以不写，网关视其为 `default` 用户（不写 user 就是 default）：

```bash
-d '{ "channel": "weixin", "messages": [{ "role": "user", "content": "你好" }] }'
# 等价于 channel=weixin, userId=default
```

- `default` 用户拥有独立任务列表与会话，不与其他用户串扰；
- `channel` 完全不写时走原 `model + sessionKey` 路径（oneshot，无任务机制）。

## 远程节点（多机执行 agent）

网关默认在本机（内建 `local` 节点）拉起 agent。也可以把 agent 跑在**其它机器**上：
节点进程主动 WebSocket 连入网关，自报可用 agent；任务可绑定到「节点 + agent」，
网关把对话轮次多路复用转发到对应节点，流式回传事件与结果。

```
执行机 A（node connector）──┐
执行机 B（node connector）──┼── WS(出站) ──> 网关 :8787 /api/nodes/ws
（节点无需开放入站端口）    ──┘                   ├── local 节点（网关本机 agent）
                                                  └── 任务按 (nodeId, agentId) 路由
```

### 启动一个节点

在安装了 agent CLI（opencode/pi/…）的机器上运行：

```bash
pnpm --filter @linkagent/backend node:connect \
  --gatewayUrl ws://<网关主机>:8787 --name my-mac
# 或用环境变量：
#   LINKAGENT_GATEWAY_URL   网关地址（默认 ws://127.0.0.1:8787，自动补 /api/nodes/ws）
#   LINKAGENT_GATEWAY_TOKEN 网关开启鉴权时必填（Bearer，等价 ?token=）
#   LINKAGENT_NODE_NAME     节点展示名（默认 node-<hostname>）
#   LINKAGENT_NODE_ID       节点 id（缺省首次由网关签发并持久化，重连复用）
#   LINKAGENT_NODE_AGENTS   逗号分隔的自报 agent（缺省 opencode/pi/workbuddy/trace-cli/cursor）
```

- 节点只发起**出站**连接，无需公网入站/端口映射；断线自动指数退避重连。
- `nodeId` 首次由网关签发（`n_xxxx`）并持久化在节点 `.runtime-state/node/node-id`，重连复用同一身份。
- 同一 `nodeId` 重连时旧连接被替换；节点离线后其**注册记录保留**（后台仍可见，可手动删除）。

后台启停 / 多实例 / 一键联调（推荐）：

```bash
pnpm node:start [name]      # 后台启动节点（可命名，支持本机多实例，独立 nodeId）
pnpm node:status [name]     # 不带 name 列出全部实例
pnpm node:log [name]        # 跟随日志
pnpm node:restart [name]
pnpm node:stop [name]
pnpm node:dev [name]        # 前台运行（Ctrl-C 退出）
pnpm dev:all [name]         # 一键联调：网关（已运行则复用）+ 节点同屏运行
```

- 令牌等配置可写入 `.runtime-state/node[-<name>].env`（`KEY=VALUE`），脚本自动加载；
- 命名实例自动使用独立状态目录 `.runtime-state/node-<name>/`，避免多实例共用 `node-id` 被互踢。
- 更多见 [`docs/design.md`](docs/design.md)（架构设计）与 [`docs/deployment.md`](docs/deployment.md)（部署运维）。

### 节点与偏好 API（复用网关鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/nodes` | 全部节点（内建 local 置顶，含离线节点及在线状态） |
| DELETE | `/api/nodes/:nodeId` | 删除离线节点注册记录（在线返回 409，local 不可删 400） |
| GET | `/api/node-agents` | local + 在线节点的扁平可路由 agent 列表（建任务下拉用） |
| GET | `/api/users/:channel/:userId/preferences` | 用户默认节点 + agent（仅预填，不参与鉴权） |
| PUT | 同上 | 保存默认偏好 `{ nodeId, agentId }`，校验组合当前可路由 |

### 任务绑定与离线行为

- 建/改任务时绑定 `(nodeId, agentId)`；仅当节点在线且已自报该 agent 才允许绑定。
- 消息路由到**离线节点**：非流式返回 `503`、OpenAI 错误 `code=node_offline`；
  流式则在 SSE 中下发 `error` 事件（`code=node_offline`）后结束。
- 节点在线但**未提供该 agent**：返回 `404`、`code=agent_unavailable`。
- 用户默认偏好（节点 + agent）只用于控制台新建任务时**预填**，不做任何访问鉴权。

## 开发 / 运维

```bash
pnpm dev                 # 开发模式（watch）
pnpm start               # 直接运行
pnpm probe               # 探测 agent 链路（AGENT=<任意支持类型>，如 pi/workbuddy/trace-cli/cursor；PI_MODEL=... 可覆盖 pi 模型）
pnpm typecheck           # 全仓类型检查
pnpm server:start        # 后台启动（scripts/server.sh，健康检查通过才报就绪）
pnpm server:stop / restart / status / log
pnpm node:start [name]   # 后台启动远程节点（scripts/node.sh，可多实例）
pnpm node:stop / restart / status / log [name]
pnpm dev:all [name]      # 一键联调网关 + 节点（scripts/dev-all.sh）
pnpm web                 # web 后台开发（vite build --watch，产物挂 8787/ui）
pnpm bot:weixin          # 独立个人微信 botAgent
pnpm bot:wecom           # 独立企业微信 botAgent
pnpm test                # backend 单测（任务路由、agent 管理、节点 WS/存储/路由，共 95 例）
pnpm --filter @linkagent/backend smoke-plugin   # 插件运行时冒烟测试（不连真实企微）
pnpm --filter @linkagent/backend weixin-login   # 微信扫码登录
```

## 构建与发布（GitHub Actions）

仓库内置两个 CI 工作流（`.github/workflows/`）：

| 工作流 | 触发 | 作用 |
|---|---|---|
| `ci.yml` | push main / PR | 质量门禁：typecheck → 单测 → `build:dist` 构建冒烟 |
| `release.yml` | 推 `v*` tag（如 `v0.1.0`） | 在 Linux / macOS / Windows 三平台构建 `dist/linkagent` 独立部署包，压缩为 `linkagent-<版本>-<平台>-<架构>.tar.gz` / `.zip`，发布为 GitHub Releases 资产 |

本地手动构建独立部署包：`pnpm build:dist`，产物在 `dist/linkagent/`。

## 目录结构

```
backend/                      # 网关包（@linkagent/backend）
  config/config.yaml         # 网关配置（默认读取路径）
  src/gateway/
    index.ts                  # HTTP 入口：/v1、/api/*、GET / 控制台、插件加载
    config.ts                 # 配置加载（GATEWAY_CONFIG_PATH / backend/config/config.yaml）
    agents/                   # AgentManager + ACP(acpx) 适配器 + 远程节点适配器(remoteWrapper)
    nodes/                    # 远程节点：WS 接入/心跳/turn 多路复用(manager)、注册落盘(store)、REST(api)
    prefs/                    # 用户默认节点+agent 偏好（KV JSON 落盘，仅预填不鉴权）
    store/                    # 通用 KV JSON 存储（原子写、损坏隔离、key 转义）
    plugins/                  # openclaw 插件运行时宿主 + 渠道运行时面
      runtime/                # core.channel.*：routing/session/reply/media/commands/pairing/text
    modelcandidates.ts        # 本机模型候选收集
  src/node/connector.ts       # 远程节点连接器（在执行机运行，出站 WS 连入网关跑本地 agent）
  src/channels/               # 独立 botAgent：weixin-bot / wecom-bot / gateway-chat / ilink-client
  src/dev/                    # console.html（内置控制台）、probe、smoke-plugin、weixin-login
shared/                       # 领域共享类型：OpenAI 兼容类型、agent 抽象、config schema（@linkagent/shared）
web/                          # 独立 React 后台管理页（@linkagent/web，Vite）
openclaw-shim/                # openclaw 包本地 shim（overrides workspace:*）
scripts/server.sh             # 网关后台启停脚本
scripts/node.sh               # 节点后台启停脚本（支持多实例）
scripts/dev-all.sh            # 网关 + 节点一键联调
docs/design.md                # 架构设计文档（Mermaid 架构图 / 时序 / 流程）
docs/deployment.md            # 部署运维文档（Mermaid 部署拓扑 / 上线流程）
.runtime-state/               # 运行时状态（acpx 会话、插件登录态、server/node pid/log，可清理）
```

## 已知限制

- 一期仅实现文本对话子集（`tools`、`response_format`、`usage` 统计等未实现）
- agent 进程冷启动延迟为已知代价（每请求首次需要拉起 ACP server）
- 切换模型 / 启停为内存态，重启还原配置文件
- 非交互环境写类工具权限默认拒绝（`approve-reads` + 非交互 `deny`），即默认只读问答
- 渠道控制命令（`/new`/`/reset`）一期不执行会话重置，仅提示
- 独立 botAgent 未内置网关鉴权 token 支持，开 auth 时需自行扩展
