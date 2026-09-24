# 飞书接入 channel-gateway

飞书收发在 **`channels` 进程**里，用飞书官方 SDK 的长连接。网关进程不加载 `@openclaw/feishu`，也不加载其它渠道插件。

对话仍回连主网关 `POST /v1/chat/completions`（SSE），任务路由用 `channel=feishu` 和发送者 `open_id`。

---

## 数据流

```text
飞书用户
  → 飞书开放平台（事件订阅，长连接）
  → channels 进程 feishu-bot（@larksuiteoapi/node-sdk WSClient）
  → POST gateway /v1  { channel: feishu, userId: open_id }
  → 任务路由 + ACP
  → im.message.reply 文本回飞书
```

| 层级 | 谁负责 |
|------|--------|
| 收发 | `backend/src/channels/feishu-bot.ts` |
| 拉起 | `backend/src/channels/channel-gateway.ts`（`channelGateway.feishu: true`） |
| 凭证 | `channels.yaml` 的 `channelGateway.channels.feishu` |
| 对话 | 主 gateway `/v1` |

本地不需要公网回调 URL。连接方式只支持 `websocket`。`webhook` 会记一条错误并跳过。

---

## 配置

后台 **我的 · 飞书** 保存 appId / appSecret，或直接写 `channels.yaml`：

```yaml
channelGateway:
  enabled: true
  feishu: true
  channels:
    feishu:
      enabled: true
      connectionMode: websocket
      accounts:
        default:
          appId: cli_xxx
          appSecret: xxx
```

飞书开放平台：企业自建应用，启用机器人，事件订阅选择**长连接**，订阅 `im.message.receive_v1`，发布版本。

保存后重启 channels：`pnpm pm restart channels`。

---

## 行为

- 只处理单聊（`p2p` / `private`）文本。群消息跳过。
- 同一 `message_id` 去重。
- 回复按约 1500 字分段，`msg_type=text`。
- 任务空间 owner 沿用 `channelGateway.wecomOwner`（与企微相同）。`auth.mode=local` 时用 gateway token，owner 为 `local`。

日志关键字：`[feishu] 长连接已发起`、`[feishu] inbound`。失败时运行态里 `feishu:default` 的 `lastError` 非空，channels 进程仍保留其它渠道。

---

## 和旧插件路径的差别

以前 `channels` 动态加载 `@openclaw/feishu`，依赖仓库里的 `openclaw-shim`。插件升级后缺导出（例如 `resolveAmbientNodeProxyAgent`、`feishuDedupeState.guard.warmup`），长连接在取 token 时失败。现在这条路径不再启动。
