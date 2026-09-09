# LinkAgent Gateway

OpenAI 兼容的本地 Agent 网关：让 **Chatbox / Open WebUI / 任意 OpenAI 客户端** 直接对话本机 agent（opencode / pi），并提供网页后台、内置控制台与**多渠道接入**（个人微信 / 企业微信）。

```
Chatbox / Open WebUI ─┐
内置控制台 (GET /)  ───┼──▶ /v1 (OpenAI 兼容) ──▶ ACP(acpx) ──▶ agent
web 后台 (pnpm web) ──┘                           (opencode acp / pi-acp)
个人微信 / 企业微信 ───▶ 渠道(插件运行时 or 独立 botAgent) ─┘
```

## 快速开始

```bash
pnpm install

# 启动网关（监听 backend/config/gateway.yaml 的 host:port，缺省 0.0.0.0:8787）
pnpm dev          # 等价 pnpm --filter @linkagent/backend dev（tsx watch，改代码自动重启）
# 生产方式：pnpm start；后台启停：pnpm server:start / stop / status / log
```

启动后：

- **内置控制台**：浏览器打开 `http://127.0.0.1:8787/`（切换 Agent / 模型 / 启停 / 对话测试）
- **OpenAI 端点**：`http://127.0.0.1:8787/v1`（Chatbox / Open WebUI 填入 base_url 即可）
- **web 后台**（可选，React 管理页）：`pnpm web` 后打开 `http://127.0.0.1:5173`（默认连 `http://127.0.0.1:8787`，可在页面改地址）
- 健康检查：`GET http://127.0.0.1:8787/healthz`

依赖本机已安装 agent 运行命令：

| agent | 命令 | 说明 |
|---|---|---|
| opencode | `opencode acp --port 0` | 原生 ACP server，默认只读问答 |
| pi | `npx -y pi-acp` | pi-coding-agent 的第三方 ACP 桥接（内部 `pi --mode rpc`） |

## 配置

配置读取优先级：

1. 环境变量 `GATEWAY_CONFIG_PATH` 指向的 yaml（缺失则启动报错）
2. `backend/config/gateway.yaml`（缺省读取路径）
3. 内置默认值（127.0.0.1:8787，无鉴权，opencode + pi 两个 agent）

`backend/config/gateway.yaml` 示例：

```yaml
server:
  host: 0.0.0.0
  port: 8787
auth:
  enabled: false        # 开启后 /v1 与 /api/* 均要求 Authorization: Bearer <token>
  token: ""             # enabled=true 时必须填写

# agents 省略时使用内置默认（opencode + pi）
agents:
  - id: opencode
    type: opencode              # opencode | pi
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

# ── 渠道（可选）──────────────────────────────────────────
# 企业微信：channels.<id> 配 botId/secret 即启用（默认内置 @wecom/wecom-openclaw-plugin）
# 个人微信：配 plugins 后先扫码登录，见「多渠道」章节
plugins:
  - package: "@tencent-weixin/openclaw-weixin"   # package 以 @ 开头必须加引号
```

### 会话模型（model 字段）

- 建会话后经 ACP `set_config_option('model')` 下发给 agent；
- **pi 必需**：pi 自身默认 provider 可能没有可用凭据，需显式指到本机 `~/.pi/agent/models.json` 已注册的模型；
- opencode 配置了也会生效，未配置则沿用 agent 自身默认；
- 模型写法统一为 `providerId/modelId`（如 `volcengine/deepseek-v4-flash-ga-260731`）。

## OpenAI 兼容 API

模型对外 id 统一形如 `agent:<agentId>`：`agent:opencode`、`agent:pi`。

### GET /v1/models

```bash
curl http://127.0.0.1:8787/v1/models
```

```json
{ "object": "list", "data": [ { "id": "agent:opencode", "object": "model", "owned_by": "linkagent" } ] }
```

### POST /v1/chat/completions

支持 stream / 非 stream。请求体为标准 OpenAI 格式（一期实现文本子集）：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "agent:opencode",
    "messages": [{ "role": "user", "content": "你好" }],
    "stream": true
  }'
```

- 非流式：返回 `chat.completion`，内容在 `choices[0].message.content`
- 流式：SSE 事件为标准 `chat.completion.chunk`，思考过程放在 `choices[0].delta.reasoning_content`，结束为 `data: [DONE]`
- 错误体为标准结构 `{ error: { message, type, param, code } }`，常见：`400` 请求体非法 / `401` 鉴权失败 / `404` 未知模型 / `500` agent 执行失败

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

> 切换模型 / 启停均为**运行时内存热更新**，重启 gateway 后还原为 `backend/config/gateway.yaml` 的值。

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

文件缺失 / 结构不符 / 解析失败一律静默降级为空列表（UI 仍可手动输入模型）。

## 接入 Chatbox / Open WebUI

| 配置项 | 值 |
|---|---|
| API 提供方 | OpenAI API 兼容 / Custom Provider |
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | 网关未开鉴权填任意非空即可；开了则填 `auth.token` |
| 模型 | `agent:opencode`、`agent:pi`（也可先调 `/v1/models` 让客户端自动拉取） |

## web 后台（可选）

独立 React 管理页（`web/`，Vite 构建，独立于网关进程）：

```bash
pnpm web     # vite dev，默认 http://127.0.0.1:5173
```

页面功能：健康检查、模型列表、流式聊天测试台（默认模型 `agent:pi`，可切换）。页面内可修改网关地址（存 localStorage `linkagent.gw.base`）。

## 多渠道

两条接入路线，**互不冲突、可同时启用**：

| 路线 | 运行形态 | 适用 | 配置/命令 |
|---|---|---|---|
| **A. openclaw 插件运行时** | gateway 进程内加载插件 | 企业微信（webhook）/ 个人微信（长轮询） | `plugins[]` / `channels.<id>` |
| **B. 独立 botAgent** | 独立进程 | 轻量、不依赖插件运行时 | `pnpm bot:weixin` / `pnpm bot:wecom` |

两者最终都通过**同一网关会话**（`sessionKey → ACP 持久会话`）获得多轮记忆，且默认**每个用户独立会话、记忆不串人**。

### 路线 A：openclaw 插件运行时

在 `backend/config/gateway.yaml` 配置 `channels.<id>` 或 `plugins[]` 后，gateway 启动时由 `PluginManager` 动态加载插件包（默认 `@wecom/wecom-openclaw-plugin`），插件注册渠道 / HTTP 路由 / 工具，然后对每个账号调 `startAccount()`。插件缺失或加载失败**仅告警，不影响 /v1**。

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
| `LINKAGENT_GATEWAY_MODEL` | `agent:opencode` | 模型 |
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

会话 key：单聊 `wecom:user:<userid>`，群聊 `wecom:chat:<chatid>`；text 按 2048 字节切块（UTF-8）。

> 提示：独立 botAgent 直连 `/v1`，若网关开了 `auth.enabled`，需要给 adapter 的 `/v1` 请求带 Bearer token（当前版本未内置该支持，请保持 auth 关闭或自行扩展）。

## 开发 / 运维

```bash
pnpm dev                 # 开发模式（watch）
pnpm start               # 直接运行
pnpm probe               # 探测 agent 链路（AGENT=pi 或 PI_MODEL=... 可切换/覆盖）
pnpm typecheck           # 全仓类型检查
pnpm server:start        # 后台启动（scripts/server.sh，健康检查通过才报就绪）
pnpm server:stop / restart / status / log
pnpm web                 # web 后台（vite dev）
pnpm bot:weixin          # 独立个人微信 botAgent
pnpm bot:wecom           # 独立企业微信 botAgent
pnpm --filter @linkagent/backend smoke-plugin   # 插件运行时冒烟测试（不连真实企微）
pnpm --filter @linkagent/backend weixin-login   # 微信扫码登录
```

## 目录结构

```
backend/                      # 网关包（@linkagent/backend）
  config/gateway.yaml         # 网关配置（默认读取路径）
  src/gateway/
    index.ts                  # HTTP 入口：/v1、/api/*、GET / 控制台、插件加载
    config.ts                 # 配置加载（GATEWAY_CONFIG_PATH / backend/config/gateway.yaml）
    agents/                   # AgentManager + ACP(acpx) 适配器
    plugins/                  # openclaw 插件运行时宿主 + 渠道运行时面
      runtime/                # core.channel.*：routing/session/reply/media/commands/pairing/text
    modelcandidates.ts        # 本机模型候选收集
  src/channels/               # 独立 botAgent：weixin-bot / wecom-bot / gateway-chat / ilink-client
  src/dev/                    # console.html（内置控制台）、probe、smoke-plugin、weixin-login
shared/                       # 领域共享类型：OpenAI 兼容类型、agent 抽象、config schema（@linkagent/shared）
web/                          # 独立 React 后台管理页（@linkagent/web，Vite）
openclaw-shim/                # openclaw 包本地 shim（overrides workspace:*）
scripts/server.sh             # 后台启停脚本
.runtime-state/               # 运行时状态（acpx 会话、插件登录态、server.pid/log，可清理）
```

## 已知限制

- 一期仅实现文本对话子集（`tools`、`response_format`、`usage` 统计等未实现）
- agent 进程冷启动延迟为已知代价（每请求首次需要拉起 ACP server）
- 切换模型 / 启停为内存态，重启还原配置文件
- 非交互环境写类工具权限默认拒绝（`approve-reads` + 非交互 `deny`），即默认只读问答
- 渠道控制命令（`/new`/`/reset`）一期不执行会话重置，仅提示
- 独立 botAgent 未内置网关鉴权 token 支持，开 auth 时需自行扩展
