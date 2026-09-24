# Channel Gateway 进程

独立 **channel-gateway** 进程：统一拉起个人微信（weixin-bot）、企业微信（OpenClaw 插件）、飞书（可选 OpenClaw 插件），对话后端一律 **HTTP SSE → 主网关 `/v1/chat/completions`**。

主 **gateway** 进程只保留 OpenAI API、任务、鉴权、节点、管理后台；不再内嵌微信 bot、不再挂载渠道插件。

## 架构

```
                    ┌─────────────────────────────────────┐
                    │  gateway（8787）                     │
                    │  /v1 SSE · 任务 · ct_ · 节点 · /ui   │
                    └──────────────────▲──────────────────┘
                                       │ POST /v1 stream
┌──────────────┐  ilink    ┌──────────┴──────────────────────────┐
│ 个人微信用户  │◀────────▶│  channel-gateway（8790 默认）          │
└──────────────┘          │  · weixin-bot × N（weixin.yaml 账号）  │
┌──────────────┐  插件回调 │  · PluginManager（wecom / feishu）    │
│ 企微 / 飞书   │◀─ WS ────▶│  · 无 HTTP（默认）· 推运行态→gateway   │
└──────────────┘          └───────────────────────────────────────┘
```

| 组件 | 职责 |
|------|------|
| gateway | 任务路由、`decideTaskRouting`、`ct_` 签发（管理 API）、ACP |
| channel-gateway | 渠道收发、OpenClaw 插件 HTTP 回调、映射 ctx → `/v1` |
| weixin-bot 模块 | 仍 `startWeixinBot()`，由 channel-gateway 按账号拉起 |
| PluginManager | 仅运行在 channel-gateway；`agentDispatch` = V1 SSE |

## 两套渠道方案 · 单进程托管

个人微信与企业微信是**两套接入方案**（实现路径不同），不是必须拆成两个 OS 进程。启用 `channelGateway` 时，由 **一个 `channels` 进程**按需同时挂载：

| 方案 | 典型实现 | 配置开关 | 回连网关 |
|------|----------|----------|----------|
| 个人微信 | 薄 adapter `weixin-bot`（ilink 轮询/收发） | `weixin.yaml` 账号 + `channelGateway.weixin: true` | 直打 `/v1`，带 `channel` / `userId` / `ct_` |
| 企业微信 | OpenClaw 插件（HTTP 回调 + `sessionKey`） | `channels.yaml` → `channelGateway.channels.wecom` + `plugins` | 插件 → `V1ChannelAgentDispatch` → `/v1` SSE |

也可只开其中一种（`channelGateway.weixin: false` 或 `wecom: false`）。个人微信与企微插件的**生产路径**均在 `channels`；CLI 的 `weixin` / `weixin:<id>` 会 expand 到 `channels`。独立 `wecom-bot` / 直接跑 `weixin-bot` 仅调试用。

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
