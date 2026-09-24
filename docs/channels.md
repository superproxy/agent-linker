# 渠道总览：个人微信 + 企业微信

LinkAgent 把**渠道收发**与**对话/任务/鉴权**拆开：终端消息在渠道侧进出，业务一律回连主网关 **`POST /v1/chat/completions`（SSE）**。

个人微信与企业微信是**两套接入方案**（实现不同），推荐在 **`channel-gateway` 单进程**内按需同时启用，也可分开部署。

| 文档 | 内容 |
|------|------|
| 本文 | 总览、配置、后台、进程、迁移 |
| [`channel-gateway.md`](channel-gateway.md) | channel-gateway 进程细节、健康检查、开发命令 |
| [`channel-gateway-integration.md`](channel-gateway-integration.md) | 薄 adapter 契约、`ct_`、任务路由、调试 |
| [`feishu-channel-gateway.md`](feishu-channel-gateway.md) | 飞书官方长连接、yaml、与网关进程边界 |

---

## 进程拓扑

```
Chatbox / 企微用户 / 微信用户
        │
        ▼
┌─────────────────── channels（可选，8790 默认）───────────────────┐
│  weixin-bot × N（ilink）                                          │
│  企微 / 飞书：官方 SDK 长连接（不加载 OpenClaw 渠道插件）            │
└────────────────────────────▲───────────────────────────────────────┘
                             │ SSE /v1
┌────────────────────────────┴───────────────────────────────────────┐
│  gateway（8787）：/v1 · 任务 · ct_ · 节点 · /ui                      │
└────────────────────────────────────────────────────────────────────┘
```

| PM 目标 | 何时存在 | 说明 |
|---------|----------|------|
| `gateway` | 始终 | OpenAI API + 管理后台 |
| `channels` | `channelGateway.enabled` 或已有 `weixin.accounts` | **一个 OS 进程**托管微信 / 企微 / 飞书 |
| `node` | `node.enabled` | 节点连接器 |

CLI/API 仍接受 `weixin` / `weixin:<用户名>`，**一律 expand → `channels`**（兼容旧脚本，无独立微信进程）。

**推荐** `channelGateway.enabled: true`。有绑定账号但未写 `channels.yaml` 时，扫码路径会 `persistEnsureWeixinChannelGateway` 补齐启用。

---

## 两套方案对比

| | **方案 A · 个人微信** | **方案 B · 企业微信（推荐）** |
|---|------------------------|-------------------------------|
| 实现 | `backend/src/channels/weixin-bot.ts` | `@wecom/wecom-openclaw-plugin` + `PluginManager` |
| 传输 | ilink 长轮询 / 发消息 | **Bot 默认 WebSocket** 连 `wss://openws.work.weixin.qq.com`；或 HTTP 回调 / 自建应用 Agent |
| 网关字段 | `channel=weixin`，`userId`，`ownerUsername`，`ct_` | 插件内 `sessionKey` → `V1ChannelAgentDispatch` → `/v1` |
| 任务 `/task` | ✅ 白名单，网关 `decideTaskRouting` | ✅ 同微信：`channel=wecom` + `userId` → 激活 `taskId`（**不用** `model: agent:pi` 路由） |
| 配置主文件 | `weixin.yaml`（账号、model） | `channels.yaml` → `channelGateway.channels.wecom`、`plugins` |
| 进程内开关 | `channelGateway.weixin: true` | `channelGateway.wecom: true` |

**备选 B′**：独立 `wecom-bot.ts`（不经 OpenClaw），适合不装插件、`pnpm bot:wecom` 单独跑；与 channel-gateway **不要重复配置同一回调 URL**。

---

## 企微智能机器人 · WebSocket（方式3：应用内授权）

企微管理端创建 **API 模式智能机器人** 时，常见三种对接方式；LinkAgent 通过 OpenClaw 插件走其中的 **长连接（WebSocket）** 路径，对应帮助中心 [智能机器人 · 方式3：应用内授权](https://open.work.weixin.qq.com/help2/pc/21668#2.3.3%20%E6%96%B9%E5%BC%8F3%EF%BC%9A%E6%99%BA%E8%83%BD%E6%9C%BA%E5%99%A8%E4%BA%BA%E5%BA%94%E7%94%A8%E5%86%85%E6%8E%88%E6%9D%83) 与开发者文档 [智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)。

```
企微用户发消息
    → 企微云端
    → wss://openws.work.weixin.qq.com（长连接）
    → channels 进程内 @wecom/wecom-openclaw-plugin（出站连接，非浏览器 WS）
    → V1ChannelAgentDispatch → gateway:8787 /v1 SSE → agent
    → 插件经同一 WS 回推/stream
```

| 项 | 说明 |
|----|------|
| 配置 | `channels.yaml` → `channelGateway.channels.wecom`：`connectionMode: websocket`，`botId` + `secret`（管理后台创建机器人后获得） |
| 授权 | 在企微客户端/管理流程完成 **应用内授权**（方式3），无需在企微后台填公网「接收消息 URL」 |
| 出站网络 | 运行 `channels` 的机器需能访问 `wss://openws.work.weixin.qq.com` |
| HTTP | 默认 **不提供** `/healthz` 与任何监听端口；**`exposePluginRoutes: false`** 时不挂载 `/plugins/wecom/*` |
| 运行态 | **`pushStatusToGateway`**：channels → `POST /api/channels/channel-gateway/report`；**进程是否存活** 由 PM 看 **pid 文件**，不看 HTTP 检活 |
| 对话 | 仍由 channels **推送到 gateway** 的 `/v1`（SSE），与 HTTP 检活分离 |
| 后台 | **我的 · 企业微信** → 连接方式选 **WebSocket 长连接**；页面展示 `runtimeReport` |

若改用 `connectionMode: webhook` 或同时配置 **自建应用 Agent**（XML 回调），才需要在企微后台配置 URL，并用到 `/plugins/wecom/agent` 等路径（见插件 README）。

---

## 配置文件（split 四文件）

与 `gateway.yaml` **同目录**：

| 文件 | 内容 | 渠道相关 |
|------|------|----------|
| `gateway.yaml` | server、auth、agents、tasks | **不写**企微 OpenClaw 段（仅网关能力） |
| `weixin.yaml` | 微信 bot、账号列表、model | 方案 A |
| `channels.yaml` | `channelGateway` 段 | 进程开关、监听端口、**`channels.wecom`、`plugins`** |
| `node.yaml` | 节点连接器 | 与渠道无关 |

`channels.yaml` 示例（企微 + 微信同进程）：

```yaml
channelGateway:
  enabled: true
  server:
    host: 0.0.0.0
    port: 8790
  weixin: true
  wecom: true
  channels:
    wecom:
      enabled: true
      connectionMode: websocket
      dmPolicy: open
      botId: "<企微 Bot ID>"
      secret: "<Bot Secret>"
  plugins:
    - package: "@wecom/wecom-openclaw-plugin"
```

模板：`backend/config/channels.yaml.template`。

OpenClaw 插件（企微/飞书）已列入 `backend/package.json`，执行 **`pnpm setup:channels`** 即可完成 install 并校验包在磁盘上可加载（无需手动 `pnpm add`）。

运行时 overlay（`.runtime-state/gateway/`）仍负责：微信 `weixin.accounts` 绑定、子进程回连地址等，**不**替代 `channels.yaml` 里的企微静态配置。

---

## 端到端流程

### 个人微信（channel-gateway 模式）

1. 管理员在 `channels.yaml` 设 `channelGateway.enabled: true`，`weixin: true`。
2. `pnpm pm restart all` 或后台 **本机 · 进程** 启动 `channels`。
3. 用户在 **我的 · 微信** 扫码 → 写入 overlay `weixin.accounts` → **`pm restart channels`**（非 `weixin:<user>`）。
4. 消息：`weixin-bot` → `/v1` + `ct_` + `ownerUsername`（登录用户名）。

`weixin.accounts` 里未扫码绑定的用户会被 **跳过**（只打日志），不会导致整个 `channels` 进程退出；仅跑企微时可设 `channelGateway.weixin: false`。

### 企业微信（channel-gateway 模式）

1. 管理员 **我的 · 企业微信**：botId/secret，保存并重启 `channels`（写 `channels.yaml`）。
2. **WebSocket 模式**：完成应用内授权即可，无需公网回调。**Webhook/Agent 模式**：在企微后台配置页面展示的回调 URL。
3. 插件收消息 → `V1ChannelAgentDispatch` → 主网关 `/v1` SSE。

### 未启用 channel-gateway（legacy / deprecated）

| 渠道 | 说明 |
|------|------|
| 微信 | **不再**起 `weixin:<用户>`；有 `weixin.accounts` 时 PM 仍拉 **`channels`** |
| 企微 | gateway 内嵌 `PluginManager`（legacy `gateway.yaml` 的 channels/plugins）或 `pnpm bot:wecom` — **deprecated**，推荐迁到 `channels.yaml` |

---

## 管理后台

| 菜单 | 角色 | 作用 |
|------|------|------|
| 我的 · 微信 | 登录用户 | 扫码绑定（channel-gateway 下重启 channels） |
| 我的 · 企业微信 | 管理员 | 企微 OpenClaw 配置、启停/重启 `channels`、回调 URL |
| 我的 · 飞书 | 管理员 | 飞书 OpenClaw 配置（appId/secret、插件包）、启停 `channels` |
| 本机 · 进程 | 管理员 | `gateway` / `channels` / `node` 状态与日志 |

REST（管理员）：

- `GET/PUT /api/channels/wecom` — 读/写 `channels.yaml` 企微段，可选自动 restart `channels`
- `GET /api/pm/status`、`POST /api/pm/start|stop|restart` — `targets: ["channels"]`

---

## 迁移对照

| 原状 | 启用 `channelGateway.enabled` 后 |
|------|----------------------------------|
| gateway 内嵌 weixin-bot | 微信仅在 `channels` 进程 |
| gateway 内嵌 PluginManager | 企微插件仅在 `channels` 进程 |
| pm `weixin:<user>` 多个进程 | 合并为 **一个** `channels`（进程内多账号 bot） |
| 企微写在 `gateway.yaml` channels/plugins | 迁到 **`channels.yaml`**；gateway 内字段仅只读兼容 |

---

## 代码索引

| 模块 | 路径 |
|------|------|
| channel-gateway 入口 | `backend/src/channels/channel-gateway.ts` |
| /v1 派发（OpenClaw） | `backend/src/channels/v1-agent-dispatch.ts` |
| 微信薄 adapter | `backend/src/channels/weixin-bot.ts` |
| 企微 legacy bot | `backend/src/channels/wecom-bot.ts` |
| 企微后台 API | `backend/src/gateway/channels/wecom-config-api.ts` |
| 企微持久化 | `backend/src/config/persist-wecom.ts` |
| 进程编排 | `backend/src/supervisor/manager.ts` |
| 配置 schema | `shared/src/config.ts` → `channelGatewaySectionSchema` |
| 前端企微页 | `web/src/pages/Wecom.tsx` |

---

## 常用命令

```bash
pnpm dev                                    # 仅 gateway
pnpm --filter @linkagent/backend channel-gateway   # 单独渠道进程（开发）
pnpm pm start all                           # gateway → channels? → node
pnpm pm restart channels
```

测试：`backend/test/gateway/wecom-config.test.ts`、`backend/test/channels/v1-agent-dispatch.test.ts`。
