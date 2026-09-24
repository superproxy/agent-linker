# Channel Gateway 进程

独立 **channel-gateway** 进程：统一拉起个人微信（weixin-bot）、企业微信智能机器人（官方 SDK 长连接）、飞书（官方 SDK 长连接）。对话后端一律 **HTTP SSE → 主网关 `/v1/chat/completions`**。

主 **gateway** 进程只保留 OpenAI API、任务、鉴权、节点、管理后台。网关进程不加载任何渠道插件。

## 架构

```
                    ┌─────────────────────────────────────┐
                    │  gateway（8787）                     │
                    │  /v1 SSE · 任务 · ct_ · 节点 · /ui   │
                    └──────────────────▲──────────────────┘
                                       │ POST /v1 stream
┌──────────────┐  ilink    ┌──────────┴──────────────────────────┐
│ 个人微信用户  │◀────────▶│  channel-gateway                     │
└──────────────┘          │  · weixin-bot × N                      │
┌──────────────┐  官方长连接 │  · 企微 WSClient（botId + secret）   │
│ 企微 / 飞书   │◀─────────▶│  · 飞书 WSClient（appId + appSecret） │
└──────────────┘          │  · 无插件 HTTP · 推运行态→gateway       │
                          └───────────────────────────────────────┘
```

| 组件 | 职责 |
|------|------|
| gateway | 任务路由、`decideTaskRouting`、`ct_` 签发（管理 API）、ACP |
| channel-gateway | 渠道收发，映射到 `/v1`。不加载 OpenClaw 渠道插件 |
| weixin-bot | `startWeixinBot()`，按微信账号拉起 |
| wecom-aibot | `@wecom/aibot-node-sdk` 的 `WSClient`，读 `channels.wecom.botId/secret` |
| feishu-bot | `@larksuiteoapi/node-sdk` 的 `WSClient`，读 `channels.feishu` 的 appId/appSecret |

## 两套渠道方案 · 单进程托管

个人微信与企业微信是**两套接入方案**（实现路径不同），不是必须拆成两个 OS 进程。启用 `channelGateway` 时，由 **一个 `channels` 进程**按需同时挂载：

| 方案 | 典型实现 | 配置开关 | 回连网关 |
|------|----------|----------|----------|
| 个人微信 | 薄 adapter `weixin-bot`（ilink 轮询/收发） | `weixin.yaml` 账号 + `channelGateway.weixin: true` | 直打 `/v1`，带 `channel` / `userId` / `ct_` |
| 企业微信 | 官方 SDK 长连接 `wecom-aibot` | `channels.yaml` → `channelGateway.wecom` + `channels.wecom.botId/secret` | 直打 `/v1`，`channel=wecom` |
| 飞书 | 官方 SDK 长连接 `feishu-bot` | `channels.yaml` → `channelGateway.feishu` + `channels.feishu` appId/appSecret | 直打 `/v1`，`channel=feishu` |

也可只开其中一种（`channelGateway.weixin: false`、`wecom: false` 或 `feishu: false`）。三条生产路径都在 `channels`。CLI 的 `weixin` / `weixin:<id>` 会 expand 到 `channels`。`wecom-bot.ts` 仍是自建应用 HTTP 回调，只给 `bot:wecom` 调试，和生产用的智能机器人长连接不是同一套凭证。

对接契约见 [`channel-gateway-integration.md`](channel-gateway-integration.md)。

## 配置

四文件 split（与 gateway/weixin/node 同目录）：

| 文件 | 段 |
|------|-----|
| `gateway.yaml` | `gateway`（**不再**在此进程加载 plugins 渠道） |
| `weixin.yaml` | `weixin`（账号列表、model；`mode` 在 channel-gateway 模式下视为 external） |
| `channels.yaml` | `channelGateway` |
| `node.yaml` | `node` |

完整示例见 [`channels.md`](channels.md)；最小片段：

```yaml
channelGateway:
  enabled: true
  server: { host: 0.0.0.0, port: 8790 }
  weixin: true
  wecom: true
  channels:
    wecom:
      enabled: true
      connectionMode: webhook
      botId: ""
      secret: ""
  plugins:
    - package: "@wecom/wecom-openclaw-plugin"
```

OpenClaw 形态的 **`channels.wecom` / `plugins` 写在 `channels.yaml` 的 `channelGateway` 段**，不在 `gateway.yaml`（网关只保留 `/v1`、任务、鉴权等）。旧版若仍在 `gateway.yaml` 留有渠道字段，channel-gateway 会只读兼容，新配置请迁移到 `channels.yaml`。

## 管理后台配置企微

管理员打开 **我的 · 企业微信**（`/ui` 侧栏，「微信」下方）：

1. 填写 OpenClaw 形态的 `botId` / `secret`，开启「启用 channel-gateway」与「启用企微渠道」。
2. **保存并重启 channels**：写入 `channels.yaml`（`channelGateway.enabled`、`channelGateway.channels.wecom`、`plugins` 等），并由进程管理器 `start/restart channels`。
3. 页面展示 **回调 URL**（如 `http://<host>:8790/plugins/wecom/agent`），在企微后台配置 webhook。

REST（需管理员鉴权）：`GET/PUT /api/channels/wecom`。

## 管理后台配置飞书

管理员打开 **我的 · 飞书**（「企业微信」下方）：

1. 安装 npm 插件（如 `@openclaw/feishu`）后，填写 **插件包名**、**appId / appSecret**、连接方式。
2. **保存并重启 channels**：写入 `channels.yaml`（OpenClaw `channels.feishu.accounts.default` 等），并由 PM 重启 `channels`。
3. Webhook 模式需额外配置 `verificationToken` / `encryptKey`，并开启 `exposePluginRoutes`；页面会提示回调 URL。

REST：`GET/PUT /api/channels/feishu`。细节见 [`feishu-channel-gateway.md`](feishu-channel-gateway.md)。

## 进程管理

`channelGateway.enabled: true` 时：

- `pnpm pm start all` → `gateway` → **`channels`** → `node`（不再单独起 `weixin:*`）
- 微信绑定后 `pm restart channels`（或后台触发的 restart channels）

开发：

```bash
pnpm --filter @linkagent/backend dev          # 仅 gateway
pnpm --filter @linkagent/backend channel-gateway  # 单独渠道进程
```

## 插件接入（OpenClaw 兼容）

1. 在 **`channels.yaml`** 的 `channelGateway` 下配置 `plugins` + `channels.wecom`（与 OpenClaw 文档字段一致；**不要**写进 `gateway.yaml`）。
2. channel-gateway 启动时 `PluginManager.start(fastify)`，挂载 `/plugins/wecom/...` 等路由。
3. 插件入站 → `core.channel.reply` → **`V1ChannelAgentDispatch`**：
   - 从 OpenClaw `sessionKey` 解析 `channel` / `userId`（key 内 `agent:*` 段**不参与**网关路由）
   - `POST /v1` 带 `channel` + `userId`，`model=linkagent-task-routed`（占位）；网关按 **激活 taskId** 选 agent（详见 [`channel-gateway-integration.md`](channel-gateway-integration.md)）
   - Bearer：静态 gateway token 或每用户 `ct_`；微信 `weixin-bot` 另带 `ownerUsername`（不经插件）

**飞书**：安装 npm 插件（如 `@openclaw/feishu`）→ `feishu: true` + `feishuPluginPackage` + `channels.feishu` + `plugins[]` → 重启 `channels`。加载原理、仅飞书部署、与企微同进程示例见 **[`feishu-channel-gateway.md`](feishu-channel-gateway.md)**。

## HTTP（默认关闭）

默认 **不监听任何 HTTP 端口**（无 `/healthz`、无插件回调）。`channels` 是否运行由 **进程管理器 pid 文件** 判断；渠道状态由 **推送到 gateway** 的 `runtimeReport` 展示。

仅当 `channelGateway.http.exposePluginRoutes: true` 时，按 `server.host/port` 挂载 `/plugins/wecom/...`（Webhook/Agent）。

运行态：`POST /api/channels/channel-gateway/report`（Bearer gateway token）→ 主 gateway；对话仍走 **`/v1` SSE**。

主业务 API 仅在 gateway `8787`（`/v1`、`/api/*`）。

## 迁移

| 原状 | 启用 channel-gateway 后 |
|------|-------------------------|
| gateway 内嵌 weixin-bot | 关闭；微信仅在 channels 进程 |
| gateway PluginManager | 关闭；插件仅在 channels 进程 |
| pm `weixin:<user>` | 合并为单个 `channels` 进程内多 bot |

默认 `channelGateway.enabled: false`，行为与旧版一致。
