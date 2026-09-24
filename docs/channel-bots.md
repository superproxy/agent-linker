# 渠道收发：网关不加载插件

网关进程不 `import`、不启动任何渠道插件。微信、企微、飞书的收发只在 `channels` 进程里，用各自的官方通道连出去，对话统一 `POST` 主网关 `/v1`。

## 进程边界

```text
飞书 / 企微 / 微信客户端
        │  出站长连接或长轮询（本机不需要公网回调）
        ▼
channels 进程
  ├── weixin-bot          ilink
  ├── wecom-aibot         @wecom/aibot-node-sdk（botId + secret）
  └── feishu-bot          @larksuiteoapi/node-sdk WSClient（appId + appSecret）
        │  SSE
        ▼
gateway 进程
  └── /v1 任务路由 + ACP
```

网关只保留渠道配置接口（写入 `channels.yaml`）和 `pm.restart(['channels'])`。`gateway/index.ts` 里的 `PluginManager.start` 已删除，`pluginManager` 恒为 `null`。

`channels` 进程不再加载 `@openclaw/feishu`、`@wecom/wecom-openclaw-plugin`、`@tencent-weixin/openclaw-weixin`。`weixinPlugin: true` 和 `exposePluginRoutes: true` 会被忽略。

## 三条收发

| 渠道 | 模块 | 凭证（`channels.yaml`） | 入站 | 回推 |
|---|---|---|---|---|
| 个人微信 | `backend/src/channels/weixin-bot.ts` | 扫码登录态 | ilink `getUpdates` | `sendMessage` |
| 企微智能机器人 | `backend/src/channels/wecom-aibot.ts` | `channels.wecom.botId` + `secret`，`connectionMode: websocket` | SDK `message.text` | `replyStream` |
| 飞书 | `backend/src/channels/feishu-bot.ts` | `channels.feishu.accounts.default.appId` + `appSecret`，长连接 | `im.message.receive_v1` 单聊文本 | `im.message.reply` |

企微自建应用的 HTTP 回调仍是独立入口 `wecom-bot.ts`（`bot:wecom`），凭证是 corpId / agentId / Token / AESKey，不由 `channels` 进程启动。飞书 webhook 同样不在本进程启动。

飞书开放平台把事件订阅设为**长连接**，订阅 `im.message.receive_v1`。本机只要能访问公网即可，不必做内网穿透。

## 本地怎么验收

1. `channels.yaml` 里 `channelGateway.enabled: true`，飞书填 appId / appSecret，`feishu: true`，`connectionMode` 不要写成 `webhook`。
2. 重启 channels，不要重启成「在 gateway 里加载插件」。
3. 日志应出现 `飞书长连接已启动`，不应再出现 `加载插件包 @openclaw/feishu` 或 `resolveAmbientNodeProxyAgent`。
4. 飞书单聊给机器人发文本，网关 `/v1` 收到 `channel=feishu`。

企微同理：日志是 `企微智能机器人已启动`，连接地址仍是企业微信自己的 `wss://openws.work.weixin.qq.com`，不再经过 OpenClaw 插件。
