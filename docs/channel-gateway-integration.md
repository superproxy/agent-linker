# 渠道 Bot 对接 LinkAgent Gateway

本文描述**薄 adapter** 如何对接本仓库网关：消息收发在渠道进程，**任务路由、`/task` 命令、会话 key** 一律在网关 `/v1/chat/completions` 内完成。个人微信（`weixin-bot`）、企业微信 OpenClaw 插件（`V1ChannelAgentDispatch`）与独立 `wecom-bot` 均遵循同一 `/v1` 契约，便于新增渠道。

## 架构边界

```
终端用户 ──▶ 渠道 adapter（ilink / 企微回调）
                │  提取文本、切块回推、ct_ 鉴权
                ▼
         POST /v1/chat/completions (stream=true)
                │  decideTaskRouting：/task → 文本回复；普通消息 → agent + sessionKey
                ▼
            ACP / agent
```

| 职责 | 网关 | 渠道 adapter |
|------|------|----------------|
| `/task list|new|use|…` | ✅ 本地解析，SSE/JSON 返回说明文本 | ❌ 不识别、不查 `/api/tasks` |
| 激活任务 → agent / cwd | ✅ | ❌ 不传 `agent`/`task`（除非调试显式覆盖） |
| 多轮记忆 sessionKey | ✅ 派生 `{owner?}:{channel}:{userId}:task:{taskId}` | ❌ 一般不设 `sessionKey`（任务渠道） |
| 终端用户鉴权 | ✅ 校验 `ct_` 作用域 | ✅ 每用户持一枚 `ct_` 调 `/v1` |

**任务白名单渠道**（走 `channel` + `userId` + 可选 `ownerUsername`，由网关读**激活任务**决定 agent / `taskId` / `sessionKey`）：`weixin`、`wecom`、`feishu`、`web`。

不在白名单、或未传 `channel`/`userId` 的渠道走 **legacy**：按 body 的 `model`（如 `agent:pi`）+ 可选 `sessionKey` 选 agent，**无**任务状态机。

> **不要用 `model: agent:pi`（或 OpenClaw 插件里的 `agentId`）给企微做路由。** 白名单渠道下网关 `decideTaskRouting` **忽略** body.model；adapter 只需传 `channel` + `userId`（及可选 `ownerUsername` / `taskKey`）。OpenClaw 插件桥接时使用占位 model `linkagent-task-routed`（见 `v1-agent-dispatch.ts`）。

## `/v1/chat/completions` 扩展字段

在 OpenAI 兼容 body 上增加 LinkAgent 字段（见 `backend/src/gateway/index.ts`、`shared` 类型）：

| 字段 | 含义 |
|------|------|
| `channel` | 渠道 id，如 `weixin`、`wecom` |
| `userId` | 渠道内终端用户 id（微信 `from_user_id`、企微 `FromUserName`） |
| `ownerUsername` | 登录用户任务空间（微信多账号：账号槽 = web 用户名） |
| `agent` / `task` | 可选显式覆盖；adapter 正常不应预查任务再填写 |
| `taskKey` | 任务直连 key（`k_`），与 `ct_` 互斥场景见鉴权节 |
| `sessionKey` | legacy 渠道多轮 key；**任务白名单渠道**由网关按激活任务派生，adapter **不要**自设 OpenClaw `agent:…:direct:…` 当最终 session（插件侧 key 仅用于解析 userId） |

`messages` 仍为标准多轮数组；bot 通常只发**当前一条** user 消息。`/task` 识别使用**最后一条 user 消息的原文**（无前缀拼接）。

### 流式响应

- `stream: true`：SSE，`choices[].delta.content` 为正文，`reasoning_content` 为思考（adapter 可先推 🤔 块）。
- `/task` 命令：网关返回 assistant 文本，不走 agent。

## 鉴权与用户级 key（`ct_`）

网关 `auth.mode !== open` 时，adapter 应为**每个终端用户**使用渠道用户 token（前缀 `ct_`），而非长期用全局静态 token 代表所有人。

| 场景 | 获取 `ct_` |
|------|------------|
| 网关内嵌 bot（**deprecated**） | 历史路径；现已迁到 `channels` |
| `channels` 进程内 weixin-bot / 插件 | 进程持静态 token，`POST /api/bot/channel-token` `{ channel, userId, ownerUsername }` → `{ token }`，本地缓存 |
| 独立调试（直接跑 `weixin-bot`） | 同上 HTTP 引导 |

`ct_` 记录含 `channel`、`userId`、可选 `ownerUsername`（微信绑定登录用户）。网关鉴权后：

- 强制 `channel`/`userId` 与凭据一致（body 伪造他人 → 403）。
- `ownerUsername` 优先取自 **凭据记录**，再取 body，再取登录会话用户（任务落在 `web/<owner>` / `ensureLoginSpace`）。

管理接口：`GET/POST /api/channel-tokens*`（管理员）；bot 引导：`POST /api/bot/channel-token`。

## 个人微信（weixin）要点

- 进程：`backend/src/channels/channel-gateway.ts` 内挂载 `weixin-bot.ts`（或 `weixinPlugin`）；PM 目标为 **`channels`**（`weixin` / `weixin:<登录名>` CLI 别名会 expand 到此）。
- 每条消息：`channel=weixin`，`userId=<from_user_id>`，`ownerUsername=<登录名>`，`Authorization: Bearer <ct_>`。
- 任务列表与控制台共用**登录用户**任务空间（非 ilink id）。
- 实现参考：`docs` 与 `AGENTS.md` 微信多用户绑定章节。

## 飞书（feishu）接入 channel-gateway

飞书**不**在 LinkAgent 仓库内实现协议；与企微相同，在 **`channels` 进程**安装并加载 **OpenClaw 飞书插件**即可。安装、`channels.yaml`、PluginManager 加载顺序、WebSocket/Webhook 与任务路由说明见 **[`feishu-channel-gateway.md`](feishu-channel-gateway.md)**。

要点：

- `pnpm setup:channels`（插件已在 backend 依赖中，脚本会 install + 校验）；
- `channelGateway.feishu: true` + `feishuPluginPackage` + `channels.feishu` + `plugins[]`；
- 入站 → `V1AgentDispatch` → `/v1` 带 `channel=feishu`、`userId`（open_id），`model=linkagent-task-routed`；
- 管理后台 **我的 · 飞书**（与企微页同构：`GET/PUT /api/channels/feishu`）。

## 企业微信（wecom）接入指南

**推荐（channel-gateway + OpenClaw 插件）**：`channels.yaml` 启用 `channelGateway`，配置 `@wecom/wecom-openclaw-plugin` 与 `channels.wecom`（WebSocket 或 Webhook）。`channels` 进程内插件收消息 → `V1ChannelAgentDispatch` → 主网关 `/v1`。后台 **我的 · 企业微信** 或 `GET/PUT /api/channels/wecom`。进程与 WebSocket 说明见 [`channels.md`](channels.md)。

**备选（legacy HTTP）**：`backend/src/channels/wecom-bot.ts`，`pnpm bot:wecom`；与插件 **勿重复** 同一回调 URL。

### 路由规则（与微信对齐，必读）

```
企微用户 userid ──▶ POST /v1 { channel: "wecom", userId: "<userid>", model: "linkagent-task-routed", messages: [...] }
                              │
                              ▼
                    decideTaskRouting（tasks/api.ts）
                              │
         /task 命令 ──────────┼──▶ 文本回复（不走 agent）
         普通消息 ─────────────┘──▶ 激活任务 taskId + 绑定 agentId
                                   sessionKey = wecom:<userId>:task:<taskId>
                                   （有 ownerUsername 时前缀 owner:）
```

| 维度 | 谁决定 | 说明 |
|------|--------|------|
| **终端用户** | `userId` | 企微成员 UserId；OpenClaw 插件从 `sessionKey`（如 `agent:pi:wecom:default:direct:<userid>`）解析出 channel/userId，**不要求** key 里的 `agent:pi` 与真实路由一致 |
| **当前任务** | 激活 `taskId` | 每 `wecom` + `userId` 独立任务空间；`/task new|use|list` 与 web 控制台同一套（该渠道下） |
| **跑哪个 agent** | 任务绑定 | 默认任务 → `tasks.defaultAgentId`；**不是** `channels.yaml` 的 `model` / 插件 `channels.wecom.agentId` |
| **多轮记忆** | 网关派生 `sessionKey` | 形如 `wecom:zhangsan:task:default`；adapter **不要**再传 legacy `sessionKey` 覆盖 |

**taskKey 直连**（可选）：body 带 `taskKey`（`k_…`）可跳过三元素，全局反查到任务后路由（与微信一致）。

**群聊**：仍建议 legacy（只传 `sessionKey`，不传 `channel`/`userId` 任务路由），避免多人共用一个激活任务。

### channel-gateway（OpenClaw 插件）配置要点

`channels.yaml` 示例（WebSocket，**无需** `model: agent:pi` 做路由）：

```yaml
channelGateway:
  enabled: true
  wecom: true
  channels:
    wecom:
      enabled: true
      connectionMode: websocket
      dmPolicy: open          # 或 pairing + allowFrom
      botId: "<BotId>"
      secret: "<Secret>"
  plugins:
    - package: "@wecom/wecom-openclaw-plugin"
```

- 对话回连：`gateway` 的 `8787` `/v1`（`resolveChildRuntime` 读 token 文件）。
- 默认 **不监听** 8790 HTTP；WebSocket 模式不需企微后台填回调 URL。
- 插件 HTTP 路由仅 `exposePluginRoutes: true` 时挂载（Webhook 模式）。

### 独立 wecom-bot（HTTP 回调）

1. 企微后台：接收消息 URL、Token、EncodingAESKey。
2. 解密后 `streamChat` / `runChatSession`：
   - **单聊（推荐）**：`channel=wecom`，`userId=<FromUserName>`，`model=linkagent-task-routed`（或任意占位；任务路由下忽略），**不设** `sessionKey`。
   - **群聊**：`sessionKey=wecom:chat:<chatId>`，不传任务字段。
3. 鉴权：静态 gateway token 或每用户 `ct_`（见下节）。

### 鉴权与任务空间（`ct_`，与微信对齐）

**channel-gateway 进程**（`channels.yaml` → `channelGateway.wecom: true`）在启动时按 **`weixin.accounts`（overlay 登录用户列表）** 为每个 owner 注册 `HttpUserTokenProvider`，与 personal 微信 bot 同一套引导接口；企微仍为 **单 OpenClaw WS**，但每条单聊消息会：

1. 解析 `sessionKey` → `channel=wecom`、`userId=<企微成员 UserId>`；
2. 用当前 **owner** 的 provider 调 `POST /api/bot/channel-token` `{ channel, userId, ownerUsername }` 换取 `ct_`（本地缓存）；
3. `POST /v1` 带 `Bearer ct_…` + body 的 `ownerUsername`（任务落在 `tasks/<owner>/…`，与 web 控制台同一登录用户空间）。

**owner 选取**（任务空间归属，与微信账号槽 username 一致）：

| 优先级 | 来源 |
|--------|------|
| 1 | 环境变量 `LINKAGENT_ACCOUNT_ID` |
| 2 | `channelGateway.wecomOwner` |
| 3 | 仅一个 `weixin.accounts` 项 → 该项 |
| 4 | 多个账号 → 第一项并打 warn，建议显式写 `wecomOwner` |

未配置 `weixin.accounts` 或未配 gateway 静态 token 时，回退为 **静态 gateway token** 调 `/v1`（无 per-user `ct_`）。

401：与 `weixin-bot` 相同，`V1AgentDispatch` 强制刷新 `ct_` 后重试一次。

手动签发（调试 / legacy `wecom-bot`）：`POST /api/bot/channel-token` 或 `POST /api/channel-tokens/ensure`（`channel=wecom`，`userId=成员 UserId`，`ownerUsername` 可选）。

adapter **不要**本地解析 `/task` 或查 `/api/tasks` 做路由。

### 切块与超时

- 企微 text 上限 **2048 UTF-8 字节**（`wecom-bot` 的 `splitByBytes`）。
- 微信 text 约 **2000 字符**（`weixin-bot`）。
- 共用 `gateway-chat.runChatSession`：思考块、失败重试、401 刷新 token。

## 调试清单

1. `GET /healthz` 网关存活。
2. 带 `ct_`（或 gateway 静态 token）调 `/v1`，body 含 `channel=wecom`/`userId`（或微信三元素）。
3. 发 `/task list` 应返回任务列表文本，且**不**启动 agent。
4. 控制台或 `/task use` 切换激活任务后，下一条普通消息 sessionKey 应变为 `…:task:<新 taskId>`（看 gateway 日志 `route: task`）。
5. 401：轮换 `ct_`；若出现 `spawn … ENOENT`，说明走了 legacy `model` 而非任务路由——检查是否缺少 `channel`/`userId` 或 `wecom` 未在白名单。
6. `channels.log` 无入站、但 WS 已认证：查企微侧是否完成应用内授权、是否单聊；`gateway.log` 无 `/v1` 则问题在插件入站前。
7. **远程日志**：管理后台 **我的 · 企业微信 / 飞书** 页底「channels 远程日志」（`GET /api/channels/channel-gateway/logs`）。channels 进程将最近约 200 行内存日志随 `pushStatusToGateway` 推到 gateway；本地同机也可读 `.runtime-state/pm/logs/channels.log`（来源「本地文件」）。

## 相关代码

| 模块 | 路径 |
|------|------|
| 任务路由决策 | `backend/src/gateway/tasks/api.ts` → `decideTaskRouting` |
| `/v1` handler | `backend/src/gateway/index.ts` |
| 共享 SSE 客户端 | `backend/src/channels/gateway-chat.ts` |
| 用户级凭据 | `backend/src/gateway/users/channel-token-store.ts` |
| 微信 / 企微 bot | `weixin-bot.ts`、`wecom-bot.ts` |
| channel-gateway / V1 派发 | `channel-gateway.ts`、`v1-agent-dispatch.ts` |
| 企微后台配置 API | `gateway/channels/wecom-config-api.ts` |
