# 飞书（Feishu/Lark）接入 channel-gateway

LinkAgent **不内置**飞书协议栈；与企微一样，在 **`channels` 进程**里托管 **OpenClaw 兼容插件**，入站消息经 **`V1AgentDispatch` → 主网关 `/v1`（SSE）** 做任务路由与 agent 执行。你侧主要工作是：**安装 npm 插件包 + 写 `channels.yaml` + 重启 channels**。

通用 adapter 契约见 [`channel-gateway-integration.md`](channel-gateway-integration.md)。

---

## 原理（边界与数据流）

```
飞书用户发消息
    → 飞书开放平台（Bot / 事件订阅）
    → OpenClaw 飞书插件（长连接 WebSocket 或 Webhook）
    → PluginRuntime.core.channel.reply.dispatch
    → V1AgentDispatch（解析 sessionKey → channel=feishu, userId=open_id）
    → POST gateway:8787 /v1  { channel, userId, model: linkagent-task-routed }
    → decideTaskRouting → 激活 taskId + agent + sessionKey
    → SSE 流式正文 → 插件回推飞书（卡片/文本）
```

| 层级 | 谁负责 | 说明 |
|------|--------|------|
| 飞书侧 | OpenClaw 插件 | App ID/Secret、事件订阅、WS/回调、收发消息格式 |
| 插件宿主 | `PluginManager`（`backend/src/plugins/manager.ts`） | `dynamic import` 插件包、`register(api)`、对每个渠道 `startAccount` |
| 对话/任务 | 主 **gateway** | `/task`、`ct_`、任务空间、`sessionKey` 派生 |
| 桥接 | `V1AgentDispatch`（`v1-agent-dispatch.ts`） | 不用插件里的 `agentId` 决定路由；任务渠道只传 `channel` + `userId` |

**状态目录**：`channels` 启动时设置 `OPENCLAW_STATE_DIR=<安装根>/.runtime-state/plugins`（见 `install/layout.ts` 的 `pluginsState`）。插件登录态、游标等落在此目录，与 `gateway.yaml` 分离。

**HTTP 默认关闭**：与企微相同，`channelGateway.http.exposePluginRoutes: false` 时不监听 8790；飞书 **WebSocket 模式**一般**不需要**公网回调 URL。若插件使用 **Webhook**，需 `exposePluginRoutes: true` 并挂载 `/plugins/...` 路由。

---

## 安装 OpenClaw 飞书插件

插件已写入 **`backend/package.json`**。克隆仓库后执行（与 `pnpm install` 等价并做可加载校验）：

```bash
pnpm setup:channels
```

独立部署包内：`npm run setup:channels`。

可选飞书官方包（与 `@openclaw/feishu` 二选一时再装）：

```bash
pnpm setup:channels -- --lark
```

**无需**改 LinkAgent 源码；channel-gateway 按 `channels.yaml` **动态 import** 插件包。

应用凭证、事件订阅、机器人能力等按插件 README / [OpenClaw Feishu 文档](https://docs.openclaw.ai/channels/feishu) 在飞书开放平台完成（常见：创建企业自建应用 → 启用机器人 → 订阅 `im.message.receive_v1` 等 → 发布版本）。

---

## 配置 `channels.yaml`

启用 channel-gateway，并声明 **OpenClaw 形态的 `channels.feishu` + `plugins`**（写在 **`channels.yaml` 的 `channelGateway` 段**，不要写进 `gateway.yaml`）。

**仅飞书、不开企微/个人微信** 示例：

```yaml
channelGateway:
  enabled: true
  weixin: false
  wecom: false
  feishu: true
  feishuPluginPackage: "@openclaw/feishu"
  http:
    exposePluginRoutes: false   # WebSocket 模式保持 false
    pushStatusToGateway: true
  channels:
    feishu:
      enabled: true
      # 字段名以所装插件为准，见 OpenClaw configuration reference：
      # https://docs.openclaw.ai/channels/feishu/configuration-reference
      # 常见：appId、appSecret、encryptKey、verificationToken、connectionMode 等
  plugins:
    - package: "@openclaw/feishu"
      enabled: true
```

**与企微同进程**（一个 `channels` 进程多插件）：

```yaml
channelGateway:
  enabled: true
  weixin: true
  wecom: true
  feishu: true
  feishuPluginPackage: "@openclaw/feishu"
  channels:
    wecom: { enabled: true, connectionMode: websocket, botId: "...", secret: "..." }
    feishu: { enabled: true, /* ... */ }
  plugins:
    - package: "@wecom/wecom-openclaw-plugin"
    - package: "@openclaw/feishu"
```

| 配置项 | 作用 |
|--------|------|
| `channelGateway.enabled` | supervisor 拉起 `channels` 进程 |
| `feishu: true` + `feishuPluginPackage` | 把该 npm 包加入待加载列表（与 `plugins[]` 二选一或同时写，见下节加载逻辑） |
| `channelGateway.channels.feishu` | 合并进传给插件的 `config.channels`（OpenClaw 标准段） |
| `channelGateway.plugins[]` | 显式插件包列表；**仅飞书**时可只写此项并配 `channels.feishu` |

模板见 `backend/config/channels.yaml.template`。

---

## 插件加载过程（代码路径）

1. **进程入口**：`pnpm pm restart channels` → `backend/src/channels/channel-gateway.ts`（`layout.entry('channels')`）。
2. **是否启动 PluginManager**：`cg.wecom || cg.feishu || channelGateway.channels` 非空时进入插件分支。
3. **组装 OpenClaw 配置**：
   - `channels` = `gateway.channels`（legacy 只读）与 `channelGateway.channels` **合并**；
   - `plugins` = 由下面「包名集合」生成 `{ package, enabled: true }[]`。
4. **解析要加载的 npm 包**（`channel-gateway.ts`）：
   - `wecom: true` → `plugins[]` 里 enabled 的包，若为空则默认 `@wecom/wecom-openclaw-plugin`；
   - `feishu: true` 且 `feishuPluginPackage` 非空 → 追加该包；
   - 若以上集合仍为空 → **回退** `channelGateway.plugins[]`（避免「只配飞书 plugins」时误加载企微默认包）。
5. **`PluginManager.start()`**（`backend/src/plugins/manager.ts`）：
   - 对每个包：`import(pkg)`，失败则 `import(pkg/dist/index.js)`；
   - 调用插件 `default.register(createPluginApi(...))`，收集 `channels` / `httpRoutes`；
   - 注入 **`agentDispatch`** = `createV1AgentDispatch(...)`（channel-gateway **不传** 网关内嵌 `AgentManager`，避免走 `agent:pi` spawn）；
   - 对每个注册的 `channelId`（飞书一般为 **`feishu`**）：`listAccountIds` → `isConfigured` → `gateway.startAccount()`（长驻 WS/监听）。
6. **HTTP 路由**：`exposePluginRoutes: true` 时把插件注册的 webhook 挂到 Fastify（8790）；否则仅打日志「跳过 N 条 HTTP 路由」。
7. **运行态**：可选 `pushStatusToGateway` → `POST /api/channels/channel-gateway/report`；进程存活以 PM **pid** 为准。

日志关键字：`[plugins] 加载插件包 @openclaw/feishu`、`feishu[default] startAccount 已发起`、`OpenClaw 插件运行时已启动（派发 → /v1 SSE）`。

---

## 使用（对话与任务）

1. 保存 `channels.yaml`，重启 **`channels`**（及确保 **gateway** 已启、`auth` 与 token 与现网一致）。
2. 在飞书客户端向机器人 **单聊** 发消息；群聊是否响应取决于插件 **@mention / allowFrom**（见 OpenClaw access-control）。
3. **任务路由**（与企微对齐）：
   - 网关白名单含 **`feishu`**；`V1AgentDispatch` 从 sessionKey 解析 `userId`（如 `ou_xxx`）；
   - 普通消息 → 该 `feishu` + `userId` 的激活任务；`/task list|new|use` 由网关本地处理；
   - **不要**依赖 `channels.yaml` 的 `model: agent:pi` 或插件默认 agent 做生产路由。
4. **鉴权**（`auth.mode` 非 open）：
   - 与企微相同：channel-gateway 按 `weixin.accounts` 注册 `HttpUserTokenProvider`，为每个飞书终端用户换 `ct_` 调 `/v1`；
   - 任务空间 owner 见 `channelGateway.wecomOwner` / 单账号 `weixin.accounts`（企微与飞书共用同一 owner 解析逻辑）。
5. 调试：飞书无回复时先看 `channels.log` 是否 `startAccount` 成功 → 再看 `gateway.log` 是否有 `/v1`；无 `/v1` 多为插件未 dispatch 或未通过 pairing/策略。

---

## 管理后台（与企微对齐）

管理员：**我的 · 飞书**（侧栏位于「企业微信」之后）

1. 填写 **插件包名**（默认 `@openclaw/feishu`）、**appId / appSecret**、连接方式（WebSocket / Webhook）。
2. **保存并重启 channels**：写入 `channels.yaml`（`channelGateway.channels.feishu.accounts.default` + `feishuPluginPackage` + `plugins[]`），并由 PM 重启 `channels`。
3. 页面展示 **channels 进程状态**、运行态推送、Webhook 模式下回调 URL（需 `exposePluginRoutes: true`）。

REST（管理员鉴权）：`GET/PUT /api/channels/feishu`（实现见 `gateway/channels/feishu-config-api.ts`、`config/persist-feishu.ts`）。

---

## 与企微接入的差异（简要）

| | 企微 | 飞书 |
|---|------|------|
| 默认 npm 包 | `@wecom/wecom-openclaw-plugin`（仓库已依赖） | 需自行 `pnpm add`（`@openclaw/feishu` 或 `@larksuite/openclaw-lark`） |
| 管理后台 | **我的 · 企业微信** | **我的 · 飞书** |
| 凭证字段 | `botId` + `secret` | `accounts.default.appId` + `appSecret`（OpenClaw 标准） |
| 传输 | WS（推荐）或 Webhook | 插件默认 **WebSocket**（OpenClaw 文档）；Webhook 需开 HTTP |
| gateway 任务白名单 | `wecom` | `feishu`（`lark` 前缀在 dispatch 层归一为 `feishu`） |

---

## 相关代码

| 模块 | 路径 |
|------|------|
| channels 进程入口 | `backend/src/channels/channel-gateway.ts` |
| 插件宿主 | `backend/src/plugins/manager.ts` |
| /v1 桥接 | `backend/src/channels/v1-agent-dispatch.ts` |
| 任务白名单 | `backend/src/gateway/tasks/api.ts` → `TASK_ROUTING_CHANNELS` |
| 插件状态目录 | `backend/src/install/layout.ts` → `pluginsState` |
| 配置 schema | `shared/src/config.ts` → `channelGateway.feishu` / `feishuPluginPackage` |
